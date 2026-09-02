/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - GET /boards?mine=true 与 GET /topics?mine=true 的"我的"语义底座
 *     （creator + member/participant，排除仅因 open 可见的项）
 *
 * [代码职责]
 *   - 直接实例化 AccessQueryService + 真实 TypeORM repo，打真实 PG 验证
 *     getMyBoardIds/getMyTopicIds 的 SQL 路径：jsonb settings->>'visibility'、
 *     topic_participants.status IN (invited, active)、board_members 行、owner-proxy
 *     creator 白名单、admin 不短路。mock 单测测不出 ORM SQL 生成（铁律 #23）。
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §boards/§topics（mine 参数行由主脑同步）
 *   - 补充: docs/architecture.md §7.2（统一权限模型）
 *
 * [关键不变量]
 *   - 存在 open 项但 actor 非成员 → mine=true 不返回该项，缺省（mine=false）仍返回。
 *   - admin 求 mine 不返回 null 白名单：收缩为 creator+member/participant。
 *   - mine 缓存键带 mine: 前缀，与默认白名单同请求互不串缓存。
 *
 * [关联代码]
 *   - apps/backend/src/common/services/access-query.service.ts — mine 变体实现
 *   - apps/backend/src/modules/board/board.service.ts findAll / topic.service.ts findAll — 分支
 *
 * [持久踩坑]
 *   - ORM（jsonb 路径、status IN、member/participant 行命中）必须打真实 PG 验证；
 *     mock 测试只验证拼接逻辑，测不出 SQL 生成（RT-SEAT-1 教训）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */

/**
 * mine 查询语义 —— 真实 PG 集成套件（v1.70 插件绑定推断底座）
 *
 * DB 目标 = 本地开发库 agent_chamber（docker-compose 默认参数，env 可覆盖）。
 * PG 不可达时整套降级跳过（warn 提示，各用例前置守卫 return）——保持 test:e2e
 * 在无库环境仍可全绿。
 * 测试数据用 randomUUID 隔离，afterAll 按 id 硬删兜底清理（board/topic/member/participant）。
 */
import { DataSource, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import {
  ActorType,
  UserRole,
  Visibility,
  ParticipantStatus,
  TopicStatus,
} from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { Board } from '../src/database/entities/board.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { AccessQueryService, AccessQueryStore } from '../src/common/services/access-query.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import type { UnifiedActor } from '../src/common/types/actor.types';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 固定测试 actor（creator_id 无 FK，可安全用哨兵 uuid；前缀不与业务 uuid 冲突） */
const TEST_PREFIX = '00000000-0000-4000-8000-';
const actorId = `${TEST_PREFIX}a0000000a001`;
const otherId = `${TEST_PREFIX}a0000000a002`;
const adminId = `${TEST_PREFIX}a0000000a003`;
const ownedAgentId = `${TEST_PREFIX}a0000000a004`;

const actor: UnifiedActor = { id: actorId, type: ActorType.HUMAN };
const admin: UnifiedActor = { id: adminId, type: ActorType.HUMAN, role: UserRole.ADMIN };

describe('mine 查询语义 — 真实 PG 集成（v1.70）', () => {
  let ds: DataSource;
  let service: AccessQueryService;
  let store: AsyncLocalStorage<Map<string, Promise<string[] | null>>>;
  let ownerProxyStub: { getOwnedAgentIds: jest.Mock; isOwnerProxy: jest.Mock };
  let dbAvailable = false;

  // 播种的 board/topic id（randomUUID 隔离，afterAll 按 id 清理）
  const boardIds: string[] = [];
  const topicIds: string[] = [];

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
      console.warn(`[mine-query e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    const boardRepo = ds.getRepository(Board);
    const topicRepo = ds.getRepository(Topic);
    const memberRepo = ds.getRepository(BoardMember);
    const participantRepo = ds.getRepository(TopicParticipant);

    // ── Board 播种 ──
    const mkBoard = async (label: string, creatorId: string, visibility: Visibility) => {
      const b = await boardRepo.save(
        boardRepo.create({
          name: `${label}-${randomUUID()}`,
          topicId: null,
          creatorId,
          color: '#6366f1',
          settings: { visibility },
        }),
      );
      boardIds.push(b.id);
      return b.id as string;
    };
    // 顺序约定（boardIds 下标）：0 open/非成员 → 1 actor 创建 → 2 actor 成员 →
    // 3 open+成员 → 4 owned agent 创建 → 5 admin 创建
    await mkBoard('open-other', otherId, Visibility.OPEN);
    await mkBoard('mine-creator', actorId, Visibility.PRIVATE);
    const bMineMember = await mkBoard('mine-member', otherId, Visibility.PRIVATE);
    const bOpenMember = await mkBoard('open-member', otherId, Visibility.OPEN);
    await mkBoard('agent-created', ownedAgentId, Visibility.PRIVATE);
    await mkBoard('admin-created', adminId, Visibility.PRIVATE);
    await memberRepo.save(
      memberRepo.create({ boardId: bMineMember, actorId, role: 'member', invitedBy: otherId }),
    );
    await memberRepo.save(
      memberRepo.create({ boardId: bOpenMember, actorId, role: 'member', invitedBy: otherId }),
    );

    // ── Topic 播种 ──
    const mkTopic = async (label: string, creatorId: string, visibility: Visibility) => {
      const t = await topicRepo.save(
        topicRepo.create({
          title: `${label}-${randomUUID()}`,
          creatorId,
          settings: { visibility },
          status: TopicStatus.ACTIVE,
        }),
      );
      topicIds.push(t.id);
      return t.id as string;
    };
    // 顺序约定（topicIds 下标）：0 open/非成员 → 1 actor 创建 → 2 active 参与者 →
    // 3 invited 参与者 → 4 left 参与者 → 5 owned agent 创建 → 6 admin 创建
    await mkTopic('open-other', otherId, Visibility.OPEN);
    await mkTopic('mine-creator', actorId, Visibility.PRIVATE);
    const tMineActive = await mkTopic('mine-active', otherId, Visibility.PRIVATE);
    const tMineInvited = await mkTopic('mine-invited', otherId, Visibility.PRIVATE);
    const tLeft = await mkTopic('left', otherId, Visibility.PRIVATE);
    await mkTopic('agent-created', ownedAgentId, Visibility.PRIVATE);
    await mkTopic('admin-created', adminId, Visibility.PRIVATE);
    await participantRepo.save([
      participantRepo.create({
        topicId: tMineActive,
        participantId: actorId,
        status: ParticipantStatus.ACTIVE,
        joinedAt: new Date(),
      }),
      participantRepo.create({
        topicId: tMineInvited,
        participantId: actorId,
        status: ParticipantStatus.INVITED,
        joinedAt: null,
      }),
      participantRepo.create({
        topicId: tLeft,
        participantId: actorId,
        status: ParticipantStatus.LEFT,
        joinedAt: new Date(),
        leftAt: new Date(),
      }),
    ]);

    // ── AccessQueryService 直连真实 repo（OwnerProxy 打桩：默认无 owned agents）──
    store = new AsyncLocalStorage<Map<string, Promise<string[] | null>>>();
    ownerProxyStub = {
      getOwnedAgentIds: jest.fn().mockResolvedValue([]),
      isOwnerProxy: jest.fn().mockResolvedValue(false),
    };

    service = new AccessQueryService(
      ds.getRepository(Topic),
      ds.getRepository(Board),
      ds.getRepository(DocSpace),
      ds.getRepository(TopicParticipant),
      ds.getRepository(BoardMember),
      ds.getRepository(DocSpaceMember),
      store as AccessQueryStore,
      ownerProxyStub as unknown as OwnerProxyService,
    );
  });

  afterAll(async () => {
    if (!ds) return;
    try {
      await ds.getRepository(BoardMember).delete({ boardId: In(boardIds) });
      await ds.getRepository(TopicParticipant).delete({ topicId: In(topicIds) });
      await ds.getRepository(Topic).delete(topicIds);
      await ds.getRepository(Board).delete(boardIds);
    } finally {
      await ds.destroy();
    }
  });

  it('boards: open 板存在但 actor 非成员 → mine=true 不返回、缺省仍返回（真实 PG）', async () => {
    if (!dbAvailable) return;

    const accessible = await service.getAccessibleBoardIds(actor);
    const mine = await service.getMyBoardIds(actor);

    // 缺省（open+creator+member 可见口径）含 open 板
    expect(accessible).toContain(boardIds[0]);
    // mine 收缩：open-only 板被排除
    expect(mine).not.toContain(boardIds[0]);
    expect(mine).toContain(boardIds[1]); // actor 创建
    expect(mine).toContain(boardIds[2]); // actor 成员
    expect(mine).toContain(boardIds[3]); // open + 成员（member 路径保留）
    expect(mine).not.toContain(boardIds[4]); // owned agent 创建（默认无 owner-proxy）
    expect(mine).not.toContain(boardIds[5]); // admin 创建
  });

  it('boards: owner-proxy 名下 agent 创建的板在 mine 的 creator 路径命中（真实 PG）', async () => {
    if (!dbAvailable) return;

    ownerProxyStub.getOwnedAgentIds.mockResolvedValue([ownedAgentId]);
    try {
      const mine = await service.getMyBoardIds(actor);
      expect(mine).toContain(boardIds[4]);
    } finally {
      ownerProxyStub.getOwnedAgentIds.mockResolvedValue([]);
    }
  });

  it('boards: admin 求 mine 收缩为 creator+member，不返回 null 白名单（真实 PG）', async () => {
    if (!dbAvailable) return;

    // 缺省 admin = null（全放行，行为不变）
    expect(await service.getAccessibleBoardIds(admin)).toBeNull();
    // mine: admin 也只是 creator/member 身份 → open-only 板不在其中
    const mine = await service.getMyBoardIds(admin);
    expect(mine).not.toBeNull();
    expect(mine).toEqual(expect.arrayContaining([boardIds[5]])); // admin 创建的板
    expect(mine).not.toContain(boardIds[0]); // open 板（admin 非 creator/member）
  });

  it('topics: open 题存在但 actor 非参与者 → mine=true 不返回、缺省仍返回（真实 PG）', async () => {
    if (!dbAvailable) return;

    const accessible = await service.getAccessibleTopicIds(actor);
    const mine = await service.getMyTopicIds(actor);

    expect(accessible).toContain(topicIds[0]); // open 题缺省可见
    expect(mine).not.toContain(topicIds[0]); // 仅 open 可见 → mine 排除
    expect(mine).toContain(topicIds[1]); // actor 创建
    expect(mine).toContain(topicIds[2]); // active 参与者
    expect(mine).toContain(topicIds[3]); // invited 参与者
    expect(mine).not.toContain(topicIds[4]); // left 参与者排除（status 口径）
    expect(mine).not.toContain(topicIds[5]); // owned agent 创建（默认无 owner-proxy）
    expect(mine).not.toContain(topicIds[6]); // admin 创建
  });

  it('topics: owner-proxy 名下 agent 创建的题在 mine 的 creator 路径命中（真实 PG）', async () => {
    if (!dbAvailable) return;

    ownerProxyStub.getOwnedAgentIds.mockResolvedValue([ownedAgentId]);
    try {
      const mine = await service.getMyTopicIds(actor);
      expect(mine).toContain(topicIds[5]);
    } finally {
      ownerProxyStub.getOwnedAgentIds.mockResolvedValue([]);
    }
  });

  it('topics: admin 求 mine 收缩为 creator+participant，不返回 null 白名单（真实 PG）', async () => {
    if (!dbAvailable) return;

    expect(await service.getAccessibleTopicIds(admin)).toBeNull();
    const mine = await service.getMyTopicIds(admin);
    expect(mine).not.toBeNull();
    expect(mine).toEqual(expect.arrayContaining([topicIds[6]])); // admin 创建的题
    expect(mine).not.toContain(topicIds[0]); // open 题（admin 非 creator/participant）
  });

  it('缓存隔离：同一请求 ctx 内 default 与 mine 不串键（mine 仍排除 open-only，真实 PG）', async () => {
    if (!dbAvailable) return;

    await store.run(new Map(), async () => {
      const accessible = await service.getAccessibleBoardIds(actor);
      const mine = await service.getMyBoardIds(actor);
      // 若缓存键碰撞（缺 mine: 前缀），mine 会拿到默认集合 → 该断言失败（隔离证明）
      expect(accessible).toContain(boardIds[0]);
      expect(mine).not.toContain(boardIds[0]);
    });
  });
});
