/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan shadowcat-sunspot-catwoman.md Phase 2（audit 全覆盖插桩）
 *   - 补充: docs/spec.md §3.1 audit_logs（entity_id UUID NOT NULL、actor_id 无 FK）
 *
 * [踩坑索引]
 *   - FAIL-OPEN: AuditService.log 内部 try/catch，审计写失败不阻断业务——
 *     本套件直接断言 audit_logs 落库（真 PG），mock 测不出 ORM 写
 *   - REPLAY: sendMessage 幂等 replay 只在真实写路径记审计（决策 2）——
 *     同 clientRequestId 重放必须仍只有 1 行 audit
 *
 * [铁律关联] #17(测试契约) #23(jsonb查询集成覆盖) #8(测试绑定)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * 活动日志插桩（Phase 2）—— 真实 PG 集成套件（2026-08-28）
 *
 * 覆盖（plan shadowcat-sunspot-catwoman.md Phase 2 + 决策 2/6/8/9）：
 * ① sendMessage 真实写路径 → audit 行 entityType=message/action=create，
 *   newData 含 {messageId, topicId, topicTitle} 且**不含 content**（黑名单）
 * ② 幂等 replay（同 clientRequestId 重放）→ audit 仍只 1 行（决策 2）
 * ③ login → LOGIN 行（entityType=user，newData {userId, username}）
 * ④ topic join → topic_participant CREATE 行（service 层插桩）
 * ⑤ 圆桌经路冒烟：SYSTEM actor 经 TopicService.sendMessage 落消息 → audit 行
 *   actorId=SYSTEM（service 层插桩覆盖非 controller 调用——决策 2 的意义）
 *
 * 与 activity-logs.e2e-spec.ts 同款环境约定：本地开发库 chamber-postgres
 * （localhost:8744），PG 不可达整套降级跳过；RUN 后缀隔离测试数据，afterAll 按
 * FK 依赖逆序硬删兜底清理。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import {
  ActorType,
  AgentStatus,
  AuditAction,
  MessageType,
  UserRole,
  Visibility,
} from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { TopicService } from '../src/modules/topic/topic.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { ResourceValidator } from '../src/common/resource-validator';
import { EventService } from '../src/modules/event/event.service';
import { Actor } from '../src/database/entities/actor.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { User } from '../src/database/entities/user.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { Message } from '../src/database/entities/message.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { RefreshToken } from '../src/database/entities/refresh-token.entity';
import { Board } from '../src/database/entities/board.entity';
import { Task } from '../src/database/entities/task.entity';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import * as bcrypt from 'bcrypt';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 每次生成唯一后缀：隔离测试数据（同进程多用例串行，模块级常量会跨用例复用导致唯一冲突） */
const runSuffix = (): string => `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 系统哨兵 actor（roundtable 公告通道，roundtable.service 同源常量） */
const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000000';

describe('活动日志插桩（Phase 2）— 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let moduleRef: TestingModule;
  let topicService: TopicService;
  let authService: AuthService;

  /** 本次运行创建的实体 id（afterAll 按 FK 依赖逆序清理） */
  const created: {
    auditIds: string[];
    topicIds: string[];
    messageIds: string[];
    participantIds: Array<{ topicId: string; participantId: string }>;
    userId?: string;
    userActorId?: string;
    agentIds: string[];
  } = { auditIds: [], topicIds: [], messageIds: [], participantIds: [], agentIds: [] };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(
        `[audit-instrumentation e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    const s = runSuffix();

    // ── 测试数据：human 用户（owner）──
    const userActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `AI Owner ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.userActorId = userActor.id;
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: userActor.id,
        actor: userActor,
        username: `aiowner${s}`.slice(0, 50),
        email: `ai-owner-${s}@example.com`,
        passwordHash: await bcrypt.hash('password123', 4),
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.userId = user.id;

    // 与生产同构直连：AuditService 依赖 OwnerProxyService + ActorProfileService
    const ownerProxy = new OwnerProxyService(ds.getRepository(Agent));
    const actorProfile = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    const auditService = new AuditService(ds.getRepository(AuditLog), ownerProxy, actorProfile);

    // 最小 Nest 模块：TopicService/AuthService 走**真 repo**（真 ORM SQL），
    // 辅助依赖（Event/AccessQuery）mock——插桩断言只关心 audit_logs 落库
    moduleRef = await Test.createTestingModule({
      providers: [
        TopicService,
        AuthService,
        { provide: AuditService, useValue: auditService },
        { provide: getRepositoryToken(Topic), useValue: ds.getRepository(Topic) },
        {
          provide: getRepositoryToken(TopicParticipant),
          useValue: ds.getRepository(TopicParticipant),
        },
        { provide: getRepositoryToken(Message), useValue: ds.getRepository(Message) },
        { provide: getRepositoryToken(User), useValue: ds.getRepository(User) },
        { provide: getRepositoryToken(Agent), useValue: ds.getRepository(Agent) },
        { provide: getRepositoryToken(Actor), useValue: ds.getRepository(Actor) },
        { provide: getRepositoryToken(Board), useValue: ds.getRepository(Board) },
        { provide: getRepositoryToken(Task), useValue: ds.getRepository(Task) },
        {
          provide: getRepositoryToken(IdempotencyRecord),
          useValue: ds.getRepository(IdempotencyRecord),
        },
        { provide: EventService, useValue: { create: jest.fn().mockResolvedValue({}) } },
        // sendMessage/join/create 路径不消费 AccessQueryService —— 空 mock 即可
        { provide: AccessQueryService, useValue: {} },
        { provide: OwnerProxyService, useValue: ownerProxy },
        { provide: ResourceValidator, useValue: new ResourceValidator() },
        { provide: DataSource, useValue: ds },
        { provide: ActorProfileService, useValue: actorProfile },
        { provide: getRepositoryToken(RefreshToken), useValue: ds.getRepository(RefreshToken) },
        { provide: JwtService, useValue: new JwtService({ secret: 'test-secret' }) },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ 'jwt.secret': 'test-secret', 'jwt.refreshSecret': 'test-refresh' })[key],
          },
        },
      ],
    }).compile();

    topicService = moduleRef.get(TopicService);
    authService = moduleRef.get(AuthService);
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）：
    // audit_logs.actor_id 无 FK → 先删审计行；participants/messages 挂 topic；
    // agent 行挂 owner user；actors 最后删
    if (created.auditIds.length > 0) {
      await ds.getRepository(AuditLog).delete({ id: In(created.auditIds) });
    }
    // 补漏：service 自动写的 audit 行（topic create / topic_participant create）——
    // 断言只收集了部分行，按本套件实体 id 全量清理（08-29 全量跑实测残留 4 行，
    // 挤占 activity-logs 套件 admin 全量查询的 20 条窗口）
    if (created.topicIds.length > 0) {
      await ds
        .getRepository(AuditLog)
        .createQueryBuilder()
        .delete()
        .where('entity_id = ANY(:ids)', { ids: created.topicIds })
        .execute();
      // topic_participant 行 entity_id 是 participant（非 topic），按 new_data->>'topicId' 匹配
      await ds.query(
        `DELETE FROM audit_logs WHERE entity_type = 'topic_participant' AND new_data->>'topicId' = ANY($1)`,
        [created.topicIds],
      );
    }
    for (const pid of created.participantIds) {
      await ds
        .getRepository(TopicParticipant)
        .delete({ topicId: pid.topicId, participantId: pid.participantId });
    }
    if (created.messageIds.length > 0) {
      await ds.getRepository(Message).delete({ id: In(created.messageIds) });
    }
    for (const tid of created.topicIds) {
      await ds.getRepository(Topic).delete({ id: tid });
    }
    for (const aid of created.agentIds) {
      await ds.getRepository(Agent).delete({ id: aid });
    }
    if (created.userId) await ds.getRepository(User).delete({ id: created.userId });
    if (created.userActorId) await ds.getRepository(Actor).delete({ id: created.userActorId });
    await moduleRef.close();
    await ds.destroy();
  }, 30000);

  /** 查询某实体的 audit 行（按 entityType + entityId 精确过滤，本套件 UUID 天然隔离） */
  async function findAuditRows(entityType: string, entityId: string): Promise<AuditLog[]> {
    return ds.getRepository(AuditLog).find({
      where: { entityType, entityId },
      order: { createdAt: 'ASC' },
    });
  }

  it('sendMessage → audit 行 entityType=message/action=create，newData 含 topicId 不含 content', async () => {
    const topic = await topicService.create(created.userId!, ActorType.HUMAN, {
      title: `AI Topic ${runSuffix()}`,
      visibility: Visibility.OPEN,
    });
    created.topicIds.push(topic.id);

    const msg = await topicService.sendMessage(topic.id, created.userId!, ActorType.HUMAN, {
      content: 'secret message body',
      type: MessageType.CHAT,
    });
    created.messageIds.push(msg.id);

    const rows = await findAuditRows('message', msg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.CREATE);
    expect(rows[0].actorId).toBe(created.userId);
    expect(rows[0].newData).toMatchObject({
      messageId: msg.id,
      topicId: topic.id,
      topicTitle: topic.title, // 标题快照
    });
    // 黑名单（决策 6）：content 永不入 newData
    expect(rows[0].newData).not.toHaveProperty('content');
    expect(JSON.stringify(rows[0].newData)).not.toContain('secret message body');
    created.auditIds.push(rows[0].id);

    // 顺带验证 create topic 自身也落 audit（CREATE + topic）
    const topicRows = await findAuditRows('topic', topic.id);
    expect(topicRows).toHaveLength(1);
    expect(topicRows[0].action).toBe(AuditAction.CREATE);
    expect(topicRows[0].newData).toMatchObject({ topicId: topic.id, title: topic.title });
    created.auditIds.push(topicRows[0].id);
  });

  it('幂等 replay：同 clientRequestId 重放 → audit 仍只 1 行（决策 2）', async () => {
    const topic = await topicService.create(created.userId!, ActorType.HUMAN, {
      title: `AI Idem Topic ${runSuffix()}`,
    });
    created.topicIds.push(topic.id);

    const clientRequestId = `ai-${runSuffix()}`;
    const first = await topicService.sendMessage(topic.id, created.userId!, ActorType.HUMAN, {
      content: 'idempotent body',
      clientRequestId,
    });
    created.messageIds.push(first.id);

    // 同 key 重放 → 返回既有消息（idempotentReplay），不再写 audit
    const replay = await topicService.sendMessage(topic.id, created.userId!, ActorType.HUMAN, {
      content: 'idempotent body',
      clientRequestId,
    });
    expect(replay.id).toBe(first.id);

    const rows = await findAuditRows('message', first.id);
    expect(rows).toHaveLength(1);
    created.auditIds.push(rows[0].id);
  });

  it('login → LOGIN 行（entityType=user，newData {userId, username}）', async () => {
    // 用真实邮箱登录（bcrypt 真校验）
    const userRow = await ds.getRepository(User).findOne({ where: { id: created.userId } });
    const result = await authService.login({
      email: userRow!.email,
      password: 'password123',
    });
    expect(result.user.id).toBe(created.userId);

    const rows = await findAuditRows('user', created.userId!);
    // 只断言最新一条为 LOGIN（本地库可能因历史登录已有行——本套件 user 是新建的，
    // 但为稳妥按 action=login 过滤）
    const loginRows = rows.filter((r) => r.action === AuditAction.LOGIN);
    expect(loginRows.length).toBeGreaterThanOrEqual(1);
    const lastLogin = loginRows[loginRows.length - 1];
    expect(lastLogin.actorId).toBe(created.userId);
    expect(lastLogin.newData).toMatchObject({ userId: created.userId });
    // 黑名单：password/passwordHash 不入
    expect(JSON.stringify(lastLogin.newData)).not.toContain('password');
    for (const r of loginRows) created.auditIds.push(r.id);
  });

  it('topic join → topic_participant CREATE 行（service 层插桩）', async () => {
    const topic = await topicService.create(created.userId!, ActorType.HUMAN, {
      title: `AI Join Topic ${runSuffix()}`,
    });
    created.topicIds.push(topic.id);

    // 建一个 agent 参与者（join 主体）
    const agentActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `AI Agent ${runSuffix()}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.agentIds.push(agentActor.id);
    await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: agentActor.id,
        actor: agentActor,
        ownerId: created.userId!,
        name: `ai-agent-${runSuffix()}`.slice(0, 50),
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );

    await topicService.join(topic.id, agentActor.id, ActorType.AGENT);

    const rows = await findAuditRows('topic_participant', agentActor.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.CREATE);
    expect(rows[0].actorId).toBe(agentActor.id); // 自己 join → actor=participant
    expect(rows[0].newData).toMatchObject({ topicId: topic.id, participantId: agentActor.id });
    created.auditIds.push(rows[0].id);
  });

  it('圆桌经路冒烟：SYSTEM actor 经 sendMessage 落消息 → audit 行 actorId=SYSTEM（service 层插桩的意义）', async () => {
    const topic = await topicService.create(created.userId!, ActorType.HUMAN, {
      title: `AI RT Topic ${runSuffix()}`,
    });
    created.topicIds.push(topic.id);

    // 复刻 roundtable.sendSystemMessage 通道（roundtable.service.ts:1706-1715）：
    // 系统 actor 经 TopicService.sendMessage 落 type=system 消息——controller 层
    // 插桩会漏掉此路径，service 层插桩必须覆盖
    await topicService.join(topic.id, SYSTEM_ACTOR_ID, ActorType.SYSTEM);
    const msg = await topicService.sendMessage(topic.id, SYSTEM_ACTOR_ID, ActorType.SYSTEM, {
      content: 'seat 已入座公告',
      type: MessageType.SYSTEM,
      metadata: {},
    });
    created.messageIds.push(msg.id);

    const rows = await findAuditRows('message', msg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(SYSTEM_ACTOR_ID); // 系统行（actorId=null 仅 admin 可见的契约之外的哨兵 actor）
    expect(rows[0].newData).toMatchObject({ messageId: msg.id, topicId: topic.id });
    created.auditIds.push(rows[0].id);
  });
});
