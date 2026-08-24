/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.5 (SSE Module — 实时推送模块)
 *   - 补充: docs/api-definition.md §8.2 (GET /events/stream)
 *
 * [踩坑索引] B-51(SSE 推送越权)
 *
 * [铁律关联] #17(测试契约) #23(jsonb/ORM 集成覆盖) #8(测试绑定)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   B-51: SSE 全量广播无 actor 过滤，私密 topic/board 事件泄露给任意已认证连接。
 *          mock 单测测不出 AccessQueryService 真实白名单 SQL（settings->>'visibility'
 *          jsonb 提取、topic_participants.status 过滤），故本套件打真实 PG 做集成回归。
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * SSE 按 actor 过滤 —— 真实 PG 集成套件（B-51 / 任务 a2cec738）
 *
 * 与 sse.service.spec.ts（mock AccessQueryService）的分工：本套件打真实 PostgreSQL，
 * 用真 AccessQueryService（真 SQL：OPEN visibility jsonb 提取 + creator + participant
 * invited/active 过滤）驱动 SseService 连接过滤——验证「私密 topic 事件外人连接收不到、
 * 参与者/admin/本人收到」的端到端授权语义（铁律 #23：mock 测不出 ORM SQL 生成）。
 *
 * DB 目标 = 本地开发库 chamber-postgres（docker-compose 默认参数，env 可覆盖）。
 * PG 不可达时整套降级跳过（warn 提示）——保持 test:e2e 在无库环境仍可全绿。
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { AsyncLocalStorage } from 'async_hooks';
import { ActorType, EventType, TopicStatus, UserRole, Visibility } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { SseService } from '../src/modules/sse/sse.service';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { UnifiedActor } from '../src/common/types/actor.types';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实数据互相污染 */
const RUN = `sse-e2e-${Date.now()}`;

/** 固定测试 actor ID（uuid 列要求合法 uuid） */
const ALICE_ID = '00000000-0000-4000-8000-0000000000a1'; // 私密 topic 参与者
const BOB_ID = '00000000-0000-4000-8000-0000000000b1'; // 外人（无任何成员关系）
const CAROL_ID = '00000000-0000-4000-8000-0000000000c1'; // 私密 topic creator
const ADMIN_ID = '00000000-0000-4000-8000-0000000000ad';

const alice: UnifiedActor = { id: ALICE_ID, type: ActorType.HUMAN, role: UserRole.EDITOR };
const bob: UnifiedActor = { id: BOB_ID, type: ActorType.HUMAN, role: UserRole.EDITOR };
const admin: UnifiedActor = { id: ADMIN_ID, type: ActorType.HUMAN, role: UserRole.ADMIN };

describe('SseService 按 actor 过滤 — 真实 PG 集成（B-51）', () => {
  let ds: DataSource;
  let service: SseService;
  let dbAvailable = false;

  let privateTopicId: string; // visibility=private，alice 是 active 参与者，carol 是 creator
  let openTopicId: string; // visibility=open，所有人可见

  /**
   * 等待当前所有连接的白名单快照加载完成（真实 PG 查询需若干事件循环轮次，
   * 单次 setImmediate 不足以覆盖 DB I/O 往返）。2s 超时防挂死。
   */
  async function waitForWhitelists(): Promise<void> {
    const deadline = Date.now() + 2000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conns: Map<number, any> = (service as any).connections;
    while (Date.now() < deadline) {
      const allLoaded = [...conns.values()].every(
        (c) => c.whitelistLoadedAt > 0 || c.whitelist === null,
      );
      if (allLoaded) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('whitelist load timeout (2s)');
  }

  function collect(actor: UnifiedActor) {
    const received: Record<string, unknown>[] = [];
    const sub = service
      .subscribe(actor)
      .subscribe((e) => received.push(JSON.parse(e.data as string)));
    return { received, close: () => sub.unsubscribe() };
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      // PG 不可达 → 整套降级跳过（本套件是环境依赖型集成测试）
      console.warn(`[sse e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // 真 AccessQueryService（真实白名单 SQL：OPEN visibility jsonb + creator + participant）
    // OwnerProxyService 打桩：本地开发库存在 migration 漂移（agents.rate_limit 缺列，
    // 债务 94502fef 在册），agents 表全列查询会炸；owner 代理解析不是本套件断言目标
    // （creator 白名单 seed 直接用 creator_id，不依赖 owner 代理路径）。
    const ownerProxyStub = { getOwnedAgentIds: jest.fn().mockResolvedValue([]) };
    const accessQuery = new AccessQueryService(
      ds.getRepository(Topic),
      ds.getRepository(Board),
      ds.getRepository(DocSpace),
      ds.getRepository(TopicParticipant),
      ds.getRepository(BoardMember),
      ds.getRepository(DocSpaceMember),
      new AsyncLocalStorage() as never,
      ownerProxyStub as unknown as OwnerProxyService,
    );
    service = new SseService(accessQuery);

    // ── 种子数据：一个私密 topic（alice 参与 / carol 创建）+ 一个开放 topic ──
    const topicRepo = ds.getRepository(Topic);
    const participantRepo = ds.getRepository(TopicParticipant);

    const privateTopic = await topicRepo.save(
      topicRepo.create({
        title: `SSE E2E Private ${RUN}`,
        status: TopicStatus.ACTIVE,
        settings: { visibility: Visibility.PRIVATE },
        creatorId: CAROL_ID,
        creatorType: ActorType.HUMAN,
      }),
    );
    privateTopicId = privateTopic.id;

    const openTopic = await topicRepo.save(
      topicRepo.create({
        title: `SSE E2E Open ${RUN}`,
        status: TopicStatus.ACTIVE,
        settings: { visibility: Visibility.OPEN },
        creatorId: CAROL_ID,
        creatorType: ActorType.HUMAN,
      }),
    );
    openTopicId = openTopic.id;

    await participantRepo.save(
      participantRepo.create({
        topicId: privateTopicId,
        participantId: ALICE_ID,
        participantType: ActorType.HUMAN,
        role: 'member',
        status: 'active',
        joinedAt: new Date(),
      }),
    );
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // 硬删兜底清理（按 RUN 种子 id 精确删除）
    await ds.getRepository(TopicParticipant).delete({ topicId: privateTopicId });
    await ds.getRepository(Topic).delete([privateTopicId, openTopicId]);
    await ds.destroy();
  });

  it('私密 topic 事件：参与者 alice 收到，外人 bob 收不到（核心安全回归）', async () => {
    if (!dbAvailable) return;
    const cAlice = collect(alice);
    const cBob = collect(bob);
    await waitForWhitelists(); // 等待两连接白名单后台加载完成

    service.emit({
      type: EventType.NEW_MESSAGE,
      resourceType: 'message',
      resourceId: '00000000-0000-4000-8000-0000000000e1',
      topicId: privateTopicId,
      boardId: null,
      actorId: CAROL_ID,
      payload: { messageId: 'm1', type: 'chat' },
      cursor: '1',
      createdAt: new Date().toISOString(),
    });

    expect(cAlice.received).toHaveLength(1);
    expect(cAlice.received[0].topicId).toBe(privateTopicId);
    expect(cBob.received).toHaveLength(0);
    cAlice.close();
    cBob.close();
  });

  it('开放 topic 事件：alice/bob 均收到（OPEN visibility 白名单 SQL 真实命中）', async () => {
    if (!dbAvailable) return;
    const cAlice = collect(alice);
    const cBob = collect(bob);
    await waitForWhitelists();

    service.emit({
      type: EventType.NEW_MESSAGE,
      topicId: openTopicId,
      actorId: CAROL_ID,
      payload: {},
      cursor: '2',
    });

    expect(cAlice.received).toHaveLength(1);
    expect(cBob.received).toHaveLength(1);
    cAlice.close();
    cBob.close();
  });

  it('私密 topic 事件：admin 全通 + 事件触发者本人（carol）回显', async () => {
    if (!dbAvailable) return;
    const carol: UnifiedActor = { id: CAROL_ID, type: ActorType.HUMAN, role: UserRole.EDITOR };
    const cAdmin = collect(admin);
    const cCarol = collect(carol);
    await waitForWhitelists();

    service.emit({
      type: EventType.NEW_MESSAGE,
      topicId: privateTopicId,
      actorId: CAROL_ID,
      payload: {},
      cursor: '3',
    });

    expect(cAdmin.received).toHaveLength(1);
    expect(cCarol.received).toHaveLength(1);
    cAdmin.close();
    cCarol.close();
  });
});
