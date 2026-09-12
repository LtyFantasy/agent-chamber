/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Agent 遥测（plan plastic-man-wonder-man-raven.md）：GET /agents/:id/stats
 *     真聚合 + POST /agents/:id/heartbeat 全列快照 upsert
 *
 * [设计文档]
 *   - 主文档: docs/api-definition.md §5.8（stats）/ §5.14（heartbeat）
 *   - 补充: plan plastic-man-wonder-man-raven.md §1（契约逐字）/ §4（本套件落点）
 *
 * [踩坑索引]
 *   - 铁律 #23：stats/heartbeat 的 raw SQL 与 upsert SQL 生成必须打真实 PG 验证
 *     （mock 单测测不出 SQL 生成）——本套件是 stats 真值 + 快照语义唯一覆盖点
 *   - 三个手工 new AgentService(...) 真 PG 套件依赖 7 参构造函数：
 *     本文件与 agent-deletion-impact / agent-unread / deleted-actor-projection 同构，
 *     构造签名变更会同时炸四个套件
 *   - 并行 e2e 下 created_at 显式 UPDATE 控制时间（activity-logs 先例 08-29 修复）
 *
 * [铁律关联] #17(测试契约) #23(jsonb/SQL 生成集成覆盖) #8(测试绑定)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * Agent 遥测（stats 真聚合 + heartbeat 全列快照 upsert）—— 真实 PG 集成套件
 * （plan plastic-man-wonder-man-raven.md §4，2026-09-03）
 *
 * 覆盖：
 * ① stats 三计数真值（message/topic/task，软删消息不计数、topic 带 deleted_at join）
 *   + dailyActivity UTC 分桶形状（日期 DESC、行无 tokenUsage 键）；
 * ② heartbeat ×2 快照语义：每 agent 恒一行；第二次省略的字段被有意清空
 *   （第一次独有字段消失）；status 省略回退 agent 当前 status；meta 折叠
 *   load/version；lastActiveAt 随事务前进；
 * ③ stats 窗口语义：from=abc / from>to / 跨度>90d → 400 VALIDATION_ERROR；
 *   date-only to 含当日（< to+1d UTC 半开）。
 *
 * 与 agent-deletion-impact.e2e-spec.ts 同款环境约定：本地开发库 chamber-postgres
 * （8744），PG 不可达整套降级跳过；RUN 后缀隔离测试数据，afterAll 按 FK 依赖
 * 逆序硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import {
  ActorType,
  AgentStatus,
  TaskStatus,
  MessageType,
  TopicStatus,
  UserRole,
  ErrorCode,
  ParticipantStatus,
} from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { AgentService } from '../src/modules/agent/agent.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { Agent } from '../src/database/entities/agent.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Message } from '../src/database/entities/message.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { Task } from '../src/database/entities/task.entity';
import { RoundtableSeat } from '../src/database/entities/roundtable-seat.entity';
import { User } from '../src/database/entities/user.entity';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据（清理范围） */
const RUN = `telemetry-${Date.now()}`;

/** 本套件内建 agent 序号（同一 RUN 下多测试各自建 owner/agent，username 需唯一） */
let createSeq = 0;

describe('Agent 遥测：stats 真聚合 + heartbeat 全列快照 upsert — 真实 PG 集成', () => {
  let ds: DataSource;
  let service: AgentService;
  let dbAvailable = false;

  /** 本次运行创建的实体 id（afterAll 按 FK 依赖逆序清理；多测试累积，全部硬删） */
  const created: {
    taskIds: string[];
    listIds: string[];
    boardIds: string[];
    messageIds: string[];
    topicIds: string[];
    keyIds: string[];
    agentIds: string[];
    actorIds: string[];
    ownerIds: string[];
    ownerActorIds: string[];
  } = {
    taskIds: [],
    listIds: [],
    boardIds: [],
    messageIds: [],
    topicIds: [],
    keyIds: [],
    agentIds: [],
    actorIds: [],
    ownerIds: [],
    ownerActorIds: [],
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      // 与生产 AppModule 同款命名策略：未显式 name 的列走 snake_case
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(
        `[agent-telemetry e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // 与生产同构直连：AgentService 七参构造（R3——三个既有真 PG 套件同构，
    // 构造签名变更会同时炸四个套件，必须零改动）
    service = new AgentService(
      ds.getRepository(Agent),
      ds.getRepository(ApiKey),
      ds.getRepository(RoundtableSeat),
      // 活动日志插桩（Phase 2）：本套件只读路径不触发，真实例防误触
      new AuditService(
        ds.getRepository(AuditLog),
        new OwnerProxyService(ds.getRepository(Agent)),
        new ActorProfileService(
          ds.getRepository(Actor),
          ds.getRepository(Agent),
          ds.getRepository(User),
        ),
      ),
      {} as never, // taskService（未触达）
      {} as never, // taskDependencyService（未触达）
    );
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）
    for (const id of created.taskIds) await ds.getRepository(Task).delete({ id });
    for (const id of created.listIds) await ds.getRepository(BoardList).delete({ id });
    for (const id of created.boardIds) await ds.getRepository(Board).delete({ id });
    for (const id of created.messageIds) await ds.getRepository(Message).delete({ id });
    for (const topicId of created.topicIds) {
      await ds.getRepository(TopicParticipant).delete({ topicId });
      await ds.getRepository(Topic).delete({ id: topicId });
    }
    for (const agentId of created.agentIds) {
      // agent_heartbeats 行（FK agents CASCADE，但显式删除优先，便于观察快照行清理）
      await ds.query(`DELETE FROM agent_heartbeats WHERE agent_id = $1`, [agentId]);
      await ds.getRepository(Agent).delete({ id: agentId });
    }
    for (const keyId of created.keyIds) await ds.getRepository(ApiKey).delete({ id: keyId });
    for (const actorId of created.actorIds) await ds.getRepository(Actor).delete({ id: actorId });
    for (const ownerId of created.ownerIds) await ds.getRepository(User).delete({ id: ownerId });
    for (const ownerActorId of created.ownerActorIds) {
      await ds.getRepository(Actor).delete({ id: ownerActorId });
    }
    await ds.destroy();
  }, 30000);

  /** 建 owner user + agent（actor + agents 行 + api_key 行），返回 agent id */
  async function createAgent(): Promise<string> {
    const seq = ++createSeq; // 同一 RUN 下多测试各自建 owner，username 需唯一
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Telemetry Owner ${RUN} #${seq}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.ownerActorIds.push(ownerActor.id);
    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: ownerActor.id,
        actor: ownerActor,
        username: `telemetryowner${RUN}${seq}`.slice(0, 50),
        email: `telemetry-owner-${RUN}-${seq}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.ownerIds.push(owner.id);
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `Telemetry Agent ${RUN} #${seq}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `Telemetry Agent ${RUN} #${seq}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    const apiKey = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: `hash-${RUN}-${seq}`,
        keyPrefix: 'ask_xxxx',
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner.id,
      }),
    );
    created.keyIds.push(apiKey.id);
    return agent.id;
  }

  it('stats 三计数真值 + dailyActivity UTC 分桶（软删消息不计数、topic join、行无 tokenUsage 键）', async () => {
    if (!dbAvailable) return;
    const agentId = await createAgent();

    // ── 造 topic + participant（status active）+ 4 条消息（含 1 条软删）——
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `Telemetry Topic ${RUN} #${createSeq}`,
        creatorId: agentId,
        status: TopicStatus.ACTIVE,
        settings: {},
      }),
    );
    created.topicIds.push(topic.id);
    await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId: topic.id,
        participantId: agentId,
        role: 'member',
        status: ParticipantStatus.ACTIVE,
        joinedAt: new Date(),
        notificationSettings: { mute: false, mentions_only: false },
      }),
    );

    // 相对 now 的控制时间点（QA  flake 修复：不得锚定固定钟点——锚"今天 10:00 UTC"
    // 在 UTC 00:00-10:00（北京白天）会落在未来，默认窗口 to=now 漏收 → 每日定时炸弹）：
    // msgA = now-25h、msgB = now-26h（将软删）、msgC = now-1h——两两精确差 24h/1h，
    // 恒为两个不同 UTC 日且恒 < now；msgD = 明天 01:00 UTC（恒在未来，天然出窗）
    const HOUR_MS = 60 * 60 * 1000;
    const nowMs = Date.now();
    const tA = new Date(nowMs - 25 * HOUR_MS); // 昨天（窗口内）
    const tB = new Date(nowMs - 26 * HOUR_MS); // 昨天（窗口内，将软删）
    const tC = new Date(nowMs - 1 * HOUR_MS); // 今天（窗口内）
    const tTomorrowEarly = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) +
        25 * HOUR_MS,
    ); // 明天 01:00 UTC（恒 > now，窗口外）

    const msgA = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId: topic.id,
        senderId: agentId,
        type: MessageType.CHAT,
        content: `telemetry msgA ${RUN}`,
      }),
    );
    created.messageIds.push(msgA.id);
    const msgB = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId: topic.id,
        senderId: agentId,
        type: MessageType.CHAT,
        content: `telemetry msgB ${RUN}`,
      }),
    );
    created.messageIds.push(msgB.id);
    const msgC = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId: topic.id,
        senderId: agentId,
        type: MessageType.CHAT,
        content: `telemetry msgC ${RUN}`,
      }),
    );
    created.messageIds.push(msgC.id);
    const msgD = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId: topic.id,
        senderId: agentId,
        type: MessageType.CHAT,
        content: `telemetry msgD(tomorrow, out-of-window) ${RUN}`,
      }),
    );
    created.messageIds.push(msgD.id);
    // created_at 显式控制（activity-logs 先例：CreateDateColumn 由 ORM 自动填充，
    // 需 UPDATE 覆盖；并行 e2e 下按 sender_id 隔离，无跨套件污染）
    await ds.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [tA, msgA.id]);
    await ds.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [tB, msgB.id]);
    await ds.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [tC, msgC.id]);
    await ds.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [tTomorrowEarly, msgD.id]);
    // 软删 msgB（昨天中段）——messageCount 与 dailyActivity 均不得计入
    await ds.query(`UPDATE messages SET deleted_at = now() WHERE id = $1`, [msgB.id]);

    // ── 造 board + list + 2 任务（todo + done——stats taskCount 是 all-time assignee 口径，
    //    与 deletion-impact 的 openTaskCount 不同，done 也计入）──
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        topicId: topic.id,
        name: `Telemetry Board ${RUN} #${createSeq}`,
        creatorId: agentId,
        settings: {},
      }),
    );
    created.boardIds.push(board.id);
    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: 'To Do',
        position: 0,
        mappedStatus: null,
        color: '#e5e7eb',
      }),
    );
    created.listIds.push(list.id);
    const todoTask = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: `Telemetry todo task ${RUN}`,
        assigneeId: agentId,
        status: TaskStatus.TODO,
      }),
    );
    created.taskIds.push(todoTask.id);
    const doneTask = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: `Telemetry done task ${RUN}`,
        assigneeId: agentId,
        status: TaskStatus.DONE,
      }),
    );
    created.taskIds.push(doneTask.id);

    // ── 调 stats（默认窗口 now-30d ~ now）断言真值 ──
    const stats = await service.stats(agentId, {});

    expect(stats.messageCount).toBe(3); // 4 条 − 1 条软删（msgB 不计）
    expect(stats.topicCount).toBe(1); // participant active 且 topic 未软删
    expect(stats.taskCount).toBe(2); // all-time assignee（含 done）

    // dailyActivity：窗口内（msgA = now-25h / msgC = now-1h，精确差 24h 恒为两个
    // 相邻 UTC 日；msgD 明天恒 > now 天然出窗），日期 DESC，UTC 日界；软删的 msgB 不计入
    const dayBucket = (d: Date) => d.toISOString().slice(0, 10); // UTC 日界，与 SQL 分桶同口径
    expect(stats.dailyActivity.length).toBe(2);
    // tC 比 tA 晚 24h → tC 桶必为 DESC 第一行
    expect(stats.dailyActivity[0]).toEqual({ date: dayBucket(tC), messageCount: 1 });
    expect(stats.dailyActivity[1]).toEqual({ date: dayBucket(tA), messageCount: 1 });
    // 行结构无 tokenUsage 键（R6：shared 类型 optional，行不再返回该键）
    expect(Object.prototype.hasOwnProperty.call(stats.dailyActivity[0], 'tokenUsage')).toBe(false);
    // period 回显默认窗口（ISO 字符串）
    expect(new Date(stats.period.from).getTime()).toBeLessThan(new Date(stats.period.to).getTime());
    // 恒 0 保留字段
    expect(stats.avgResponseTime).toBe(0);
    expect(stats.tokenUsage).toBe(0);

    // ── 负向（QA 补漏）：软删 topic/task 不计入——行为级证明而非仅 SQL 文本守卫 ──
    await ds.query(`UPDATE topics SET deleted_at = now() WHERE id = $1`, [topic.id]);
    await ds.query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [doneTask.id]);
    const statsAfter = await service.stats(agentId, {});
    expect(statsAfter.topicCount).toBe(0); // topic 软删后退出统计（topics join 生效）
    expect(statsAfter.taskCount).toBe(1); // doneTask 软删 → 只剩 todoTask
    expect(statsAfter.messageCount).toBe(3); // 消息不随 topic 软删级联（无级联契约）
  }, 30000);

  it('heartbeat ×2 快照语义：每 agent 恒一行、第二次清空第一次独有字段、meta 折叠、lastActiveAt 前进', async () => {
    if (!dbAvailable) return;
    const agentId = await createAgent();

    // ── 第一拍：全量 payload ──
    await service.heartbeat(agentId, {
      status: AgentStatus.DISABLED,
      latencyMs: 12,
      memoryMb: 256,
      cpuPercent: 3.5,
      activeTasks: 1,
      queueDepth: 2,
      processedEvents: 10,
      errorCount: 1,
      lastError: 'upstream timeout',
      load: 0.8,
      version: '1.2.3',
      meta: { region: 'cn' },
      timestamp: '2026-09-02T01:00:00.000Z',
    });

    const rows1 = (await ds.query(
      `SELECT status, latency_ms, memory_mb, cpu_percent, active_tasks, queue_depth,
                processed_events, error_count, last_error, last_error_at, meta, timestamp
           FROM agent_heartbeats WHERE agent_id = $1`,
      [agentId],
    )) as Array<Record<string, unknown>>;
    expect(rows1).toHaveLength(1); // 每 agent 恒一行
    const r1 = rows1[0];
    expect(r1.status).toBe(AgentStatus.DISABLED);
    expect(r1.latency_ms).toBe(12);
    expect(r1.memory_mb).toBe(256);
    expect(Number(r1.cpu_percent)).toBeCloseTo(3.5, 2); // DECIMAL(5,2) 经 pg 返回 string
    expect(r1.active_tasks).toBe(1);
    expect(r1.queue_depth).toBe(2);
    expect(r1.processed_events).toBe(10);
    expect(r1.error_count).toBe(1);
    expect(r1.last_error).toBe('upstream timeout');
    // lastError 非空 → lastErrorAt = timestamp（R8）
    expect(new Date(r1.last_error_at as string).toISOString()).toBe('2026-09-02T01:00:00.000Z');
    // load/version 折叠进 meta（与显式 meta 共存）
    expect(r1.meta).toEqual({ region: 'cn', load: 0.8, version: '1.2.3' });
    expect(new Date(r1.timestamp as string).toISOString()).toBe('2026-09-02T01:00:00.000Z');

    // lastActiveAt = 服务端到达时间 now()（不采用自报 timestamp，防时钟漂移回退）：
    // 第一拍 payload timestamp '2026-09-02T01:00Z' 在过去，lastActiveAt 必须 ≈ now
    // 而非被拉回 payload 时刻
    const agentRow1 = (await ds.query(`SELECT last_active_at FROM agents WHERE id = $1`, [
      agentId,
    ])) as Array<{
      last_active_at: Date;
    }>;
    expect(agentRow1[0].last_active_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(agentRow1[0].last_active_at.toISOString()).not.toBe('2026-09-02T01:00:00.000Z');

    // ── 第二拍：部分 payload（仅 latencyMs）——快照语义：省略字段被有意清空 ──
    const t2Before = Date.now();
    await service.heartbeat(agentId, { latencyMs: 5 });
    const t2After = Date.now();

    const rows2 = (await ds.query(
      `SELECT status, latency_ms, memory_mb, cpu_percent, active_tasks, queue_depth,
                processed_events, error_count, last_error, last_error_at, meta, timestamp
           FROM agent_heartbeats WHERE agent_id = $1`,
      [agentId],
    )) as Array<Record<string, unknown>>;
    expect(rows2).toHaveLength(1); // 仍是一行（upsert 语义，非追加）
    const r2 = rows2[0];
    // 第二次字段在
    expect(r2.latency_ms).toBe(5);
    // 第一次独有字段已被清空（全列覆盖而非合并，R1）
    expect(r2.memory_mb).toBeNull();
    expect(r2.cpu_percent).toBeNull();
    expect(r2.active_tasks).toBe(0);
    expect(r2.queue_depth).toBe(0);
    expect(r2.processed_events).toBe(0);
    expect(r2.error_count).toBe(0);
    expect(r2.last_error).toBeNull();
    expect(r2.last_error_at).toBeNull();
    expect(r2.meta).toEqual({}); // load/version 未提供 → 键消失
    // status 省略 → 回退 agent 当前 status（agent 创建为 active；第一拍 DISABLED
    // 只落心跳行，不影响 agents.status）——证明不回退上一拍心跳值
    expect(r2.status).toBe(AgentStatus.ACTIVE);
    // timestamp 省略 → now()
    const ts2 = new Date(r2.timestamp as string).getTime();
    expect(ts2).toBeGreaterThanOrEqual(t2Before - 1000);
    expect(ts2).toBeLessThanOrEqual(t2After + 1000);

    // lastActiveAt 前进（事务双写；第二拍 timestamp = now > 第一拍 2026-09-02T01:00Z）
    const agentRow2 = (await ds.query(`SELECT last_active_at FROM agents WHERE id = $1`, [
      agentId,
    ])) as Array<{
      last_active_at: Date;
    }>;
    expect(agentRow2[0].last_active_at.getTime()).toBeGreaterThan(
      new Date('2026-09-02T01:00:00.000Z').getTime(),
    );
  }, 30000);

  it('stats 窗口语义：非法 ISO / from>to / 跨度>90d → 400；date-only to 含当日', async () => {
    if (!dbAvailable) return;
    const agentId = await createAgent();

    // 非法 ISO → 400 VALIDATION_ERROR（service 层窗口解析，R7：文案即下一步指令）
    await expect(service.stats(agentId, { from: 'abc' })).rejects.toMatchObject({
      response: { code: ErrorCode.VALIDATION_ERROR },
    });
    // 无 offset datetime 有本地时区歧义 → 拒绝
    await expect(service.stats(agentId, { to: '2026-09-03T12:00:00' })).rejects.toMatchObject({
      response: { code: ErrorCode.VALIDATION_ERROR },
    });
    // from > to → 400
    await expect(
      service.stats(agentId, { from: '2026-09-03', to: '2026-09-01' }),
    ).rejects.toMatchObject({ response: { code: ErrorCode.VALIDATION_ERROR } });
    // 跨度 > 90 天 → 400
    await expect(
      service.stats(agentId, { from: '2026-01-01', to: '2026-06-01' }),
    ).rejects.toMatchObject({ response: { code: ErrorCode.VALIDATION_ERROR } });

    // ── date-only to 含当日：造 3 条消息（昨天 23:00 / 今天 10:00 / 明天 01:00 UTC）──
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `Telemetry Window Topic ${RUN} #${createSeq}`,
        creatorId: agentId,
        status: TopicStatus.ACTIVE,
        settings: {},
      }),
    );
    created.topicIds.push(topic.id);
    const base = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
    );
    const yesterdayLate = new Date(base.getTime() - 1 * 60 * 60 * 1000);
    const todayNoon = new Date(base.getTime() + 10 * 60 * 60 * 1000);
    const tomorrowEarly = new Date(base.getTime() + 25 * 60 * 60 * 1000);
    const todayDateOnly = base.toISOString().slice(0, 10);
    const yesterdayDateOnly = new Date(base.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const tomorrowDateOnly = new Date(base.getTime() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    for (const [label, t] of [
      ['yesterday', yesterdayLate],
      ['today', todayNoon],
      ['tomorrow', tomorrowEarly],
    ] as const) {
      const msg = await ds.getRepository(Message).save(
        ds.getRepository(Message).create({
          topicId: topic.id,
          senderId: agentId,
          type: MessageType.CHAT,
          content: `telemetry window ${label} ${RUN}`,
        }),
      );
      created.messageIds.push(msg.id);
      await ds.query(`UPDATE messages SET created_at = $1 WHERE id = $2`, [t, msg.id]);
    }

    // to = 今天（date-only）→ 上限 = 明天 00:00 UTC：今天 ✓、昨天 ✓（from 默认 30d 覆盖）、
    // 明天 01:00 ✗（超出半开上限）——R7「date-only to 含当日」
    const stats = await service.stats(agentId, { to: todayDateOnly });

    expect(new Date(stats.period.to).toISOString()).toBe(
      new Date(base.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    ); // to+1d UTC
    const dates = stats.dailyActivity.map((d) => d.date);
    expect(dates).toEqual([todayDateOnly, yesterdayDateOnly]); // DESC；明天不含
    expect(dates).not.toContain(tomorrowDateOnly);
    // 今天行含当日消息（msg 今天 10:00 计入，证明 to=date-only 含当日）
    expect(stats.dailyActivity[0]).toEqual({ date: todayDateOnly, messageCount: 1 });
  }, 30000);
});
