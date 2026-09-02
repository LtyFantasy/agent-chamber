/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: 线上 docs/api-definition.md §5 Agents（GET /agents/me/briefing 小节）
 *   - 补充: plan captain-atom-crimson-avenger-rocket-dc.md §2.5（e2e 配置钉死项：
 *     真实 PG 套件 + 造数双源 = agent-unread 的 topic 系 + task-list-projection 的
 *     board/task 系 + accessQuery admin mock）
 *
 * [踩坑索引]
 *   - ME-12V8: me 的「12 字段」是对象级契约（controller spec 对 mock 全量 14 字段
 *     断言 14-2=12 键）；HTTP 层 JSON 序列化丢 undefined（findOne 路径不产
 *     ownerName/descriptionSnippet/topicCount/messageCount）→ 实际 8 字段。
 *     与旧 MCP 编排（GET /agents/me 减 avatarUrl/apiKeyPrefix）逐字段一致，
 *     本套件按 HTTP 层真实契约断言（8 字段全集 + 无敏感字段），不按 12 断言
 *   - GUARD-FIRST: Nest 生命周期 guard 先于 pipe——statuses 空值 400 用例也必须
 *     带合法 API Key（否则先 401），故 400 用例同样要造 agent + key
 *   - PG-NOW: 消息 created_at 同事务同值（agent-unread 同款），本套件不依赖
 *     消息全序（按 id 定位断言），无需显式 UPDATE 时间戳
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
 * GET /agents/me/briefing —— 真实 PG 集成套件（plan captain-atom-crimson-avenger-rocket-dc §2.5）
 *
 * 覆盖：
 * ① happy path 全链路（HTTP 层 + 真实 API Key 认证）：响应信封与顶层形状、
 *    me 白名单投影（无 avatarUrl/apiKeyPrefix/敏感字段）、activeTasks 12 字段
 *    投影 + statusPriority 排序 + done 排除 + hasBlockers 补查、unreadCounts、
 *    recentActivities content 截断（>300 → 300 + contentTruncated）；
 * ② statuses 空值 / 含 'all' → 400（DTO 错误路径，全局 ValidationPipe 拦截，
 *    service 单测测不到——DX #1 落点），消息列合法枚举 + 正确示例；
 * ③ statuses=todo 单值收缩 → activeTasks 只含 todo。
 *
 * 环境约定（与 agent-unread / task-list-projection 同款）：本地开发库
 * chamber-postgres（localhost:8744），PG 不可达整套降级跳过；RUN 后缀隔离
 * 测试数据，afterAll 按 FK 依赖逆序硬删兜底清理。
 *
 * 为什么 HTTP 层 + 最小 Nest 模块（而非 service 直调）：briefing 的 me 白名单
 * 裁剪在 controller 层（AGENT-FIELD-WHITELIST 教训），statuses 400 由全局
 * ValidationPipe 拦截——两者都必须走真实 HTTP 管线才能验证；JwtOrApiKeyGuard
 * 用真实实现（API Key → sha256 → api_keys 表 → agent 状态校验，真 PG 认证路径）。
 */
import request = require('supertest');
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import {
  ActorType,
  AgentStatus,
  ErrorCode,
  MessageType,
  Priority,
  TaskDependencyType,
  TaskStatus,
  TopicStatus,
  UserRole,
  API_PREFIX,
} from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { AgentController } from '../src/modules/agent/agent.controller';
import { AgentService } from '../src/modules/agent/agent.service';
import { TaskService } from '../src/modules/task/task.service';
import { TaskDependencyService } from '../src/modules/task/task-dependency.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { ResourceValidator } from '../src/common/resource-validator';
import { DocSpacePolicy } from '../src/common/policies/doc-space.policy';
import { EventService } from '../src/modules/event/event.service';
import { PermissionService } from '../src/common/services/permission.service';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { Agent } from '../src/database/entities/agent.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { RoundtableSeat } from '../src/database/entities/roundtable-seat.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { Task } from '../src/database/entities/task.entity';
import { TaskComment } from '../src/database/entities/task-comment.entity';
import { TaskActivity } from '../src/database/entities/task-activity.entity';
import { TaskDependency } from '../src/database/entities/task-dependency.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Milestone } from '../src/database/entities/milestone.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Message } from '../src/database/entities/message.entity';
import * as crypto from 'crypto';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 每次生成唯一后缀：隔离测试数据（同进程多用例串行，模块级常量会跨用例复用导致唯一冲突） */
const runSuffix = (): string => `brf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** me 的 12 字段白名单（14 白名单 - avatarUrl - apiKeyPrefix；对象级契约，见 ME-12V8） */
const ME_WHITELIST_12 = [
  'id',
  'name',
  'status',
  'ownerId',
  'ownerName',
  'description',
  'descriptionSnippet',
  'capabilities',
  'createdAt',
  'lastActiveAt',
  'topicCount',
  'messageCount',
];

/** activeTasks 12 字段投影（与 service ACTIVE_TASK_KEPT_FIELDS + hasBlockers 一致） */
const ACTIVE_TASK_FIELDS_12 = [
  'id',
  'title',
  'status',
  'priority',
  'labels',
  'boardId',
  'boardName',
  'listId',
  'listName',
  'dueDate',
  'updatedAt',
  'hasBlockers',
];

describe('GET /agents/me/briefing — 真实 PG 集成（HTTP 层 + API Key）', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let moduleRef: TestingModule;
  let app: INestApplication;

  /** 本次运行创建的实体 id（afterAll 按 FK 依赖逆序清理） */
  const created: {
    messageIds: string[];
    participantRows: Array<{ topicId: string; participantId: string }>;
    topicIds: string[];
    depIds: string[];
    taskIds: string[];
    listIds: string[];
    boardIds: string[];
    keyIds: string[];
    agentIds: string[];
    actorIds: string[];
    ownerIds: string[];
    ownerActorIds: string[];
  } = {
    messageIds: [],
    participantRows: [],
    topicIds: [],
    depIds: [],
    taskIds: [],
    listIds: [],
    boardIds: [],
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
      console.warn(`[agent-briefing e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // 与生产同构直连：真实 repo + 真实 service（TaskService 的 accessQuery 用
    // admin mock——getAccessibleBoardIds 返回 null = 不过滤 board，task-list-projection
    // 同款；其余未触达依赖空 mock）
    const actorProfileService = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    const ownerProxyService = new OwnerProxyService(ds.getRepository(Agent));
    const auditService = new AuditService(
      ds.getRepository(AuditLog),
      ownerProxyService,
      actorProfileService,
    );

    // 最小 Nest 模块：AgentController + 真实服务链 + 真实 JwtOrApiKeyGuard +
    // 生产同款全局管线（ValidationPipe / ResponseInterceptor / AllExceptionsFilter /
    // /api/v1 前缀）。不走 AppModule：避免 runner WS gateway 等无关启动面。
    moduleRef = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        AgentService,
        TaskService,
        TaskDependencyService,
        AuditService,
        ApiKeyAuthService,
        ActorProfileService,
        OwnerProxyService,
        JwtOrApiKeyGuard,
        // guard 的 Bearer 分支依赖（本套件只走 API Key 分支，mock 即可）
        { provide: JwtService, useValue: new JwtService({ secret: 'test-secret' }) },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test-secret') } },
        // briefing 不触达权限检查，mock 即可
        {
          provide: PermissionService,
          useValue: { ensureCan: jest.fn().mockResolvedValue(undefined) },
        },
        // admin 语义：getAccessibleBoardIds → null = 不过滤 board（task-list-projection 同款）
        { provide: AccessQueryService, useValue: { getAccessibleBoardIds: async () => null } },
        { provide: ResourceValidator, useValue: new ResourceValidator() },
        { provide: DataSource, useValue: ds },
        { provide: DocSpacePolicy, useValue: { can: jest.fn().mockResolvedValue(true) } },
        { provide: EventService, useValue: { create: jest.fn().mockResolvedValue({}) } },
        // 生产同款响应信封 + 异常形状（main.ts / app.module.ts 对齐）
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        // 真实 repo（真 ORM SQL）
        { provide: getRepositoryToken(Task), useValue: ds.getRepository(Task) },
        { provide: getRepositoryToken(TaskComment), useValue: ds.getRepository(TaskComment) },
        { provide: getRepositoryToken(TaskActivity), useValue: ds.getRepository(TaskActivity) },
        { provide: getRepositoryToken(BoardList), useValue: ds.getRepository(BoardList) },
        { provide: getRepositoryToken(Board), useValue: ds.getRepository(Board) },
        { provide: getRepositoryToken(Milestone), useValue: ds.getRepository(Milestone) },
        { provide: getRepositoryToken(TaskDependency), useValue: ds.getRepository(TaskDependency) },
        { provide: getRepositoryToken(TaskDocLink), useValue: ds.getRepository(TaskDocLink) },
        { provide: getRepositoryToken(Doc), useValue: ds.getRepository(Doc) },
        { provide: getRepositoryToken(DocSpace), useValue: ds.getRepository(DocSpace) },
        { provide: getRepositoryToken(Agent), useValue: ds.getRepository(Agent) },
        { provide: getRepositoryToken(ApiKey), useValue: ds.getRepository(ApiKey) },
        { provide: getRepositoryToken(Actor), useValue: ds.getRepository(Actor) },
        { provide: getRepositoryToken(User), useValue: ds.getRepository(User) },
        { provide: getRepositoryToken(RoundtableSeat), useValue: ds.getRepository(RoundtableSeat) },
        { provide: getRepositoryToken(AuditLog), useValue: ds.getRepository(AuditLog) },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // 与 main.ts 对齐：全局校验管线 + /api/v1 前缀（单源 = shared API_PREFIX）
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）
    for (const id of created.messageIds) await ds.getRepository(Message).delete({ id });
    for (const row of created.participantRows) {
      await ds.getRepository(TopicParticipant).delete({
        topicId: row.topicId,
        participantId: row.participantId,
      });
    }
    for (const id of created.topicIds) await ds.getRepository(Topic).delete({ id });
    for (const id of created.depIds) await ds.getRepository(TaskDependency).delete({ id });
    for (const id of created.taskIds) await ds.getRepository(Task).delete({ id });
    for (const id of created.listIds) await ds.getRepository(BoardList).delete({ id });
    for (const id of created.boardIds) await ds.getRepository(Board).delete({ id });
    for (const id of created.keyIds) await ds.getRepository(ApiKey).delete({ id });
    for (const id of created.agentIds) await ds.getRepository(Agent).delete({ id });
    for (const id of created.actorIds) await ds.getRepository(Actor).delete({ id });
    for (const id of created.ownerIds) await ds.getRepository(User).delete({ id });
    for (const id of created.ownerActorIds) await ds.getRepository(Actor).delete({ id });
    await app.close();
    await moduleRef.close();
    await ds.destroy();
  }, 30000);

  /** 建 owner user + agent（actor + agents + api_key 行，keyHash = sha256(rawKey)），返回 agent + 明文 key */
  async function createOwnerAndAgent(): Promise<{ agent: Agent; rawKey: string }> {
    // 函数内单次取后缀：同一 it 的所有名字共享，保证断言可引用 agent.name
    const s = runSuffix();
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `B Owner ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.ownerActorIds.push(ownerActor.id);
    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: ownerActor.id,
        actor: ownerActor,
        username: `bowner${s}`.slice(0, 50),
        email: `bowner-${s}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.ownerIds.push(owner.id);

    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `B Agent ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `B Agent ${s}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    // 真实 sha256 哈希：JwtOrApiKeyGuard → ApiKeyAuthService 按 keyHash 查表认证
    const rawKey = `ask_${crypto.randomBytes(24).toString('base64url')}`;
    const apiKey = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner.id,
      }),
    );
    created.keyIds.push(apiKey.id);
    return { agent, rawKey };
  }

  /** 建 board + list（task 前置） */
  async function createBoardWithList(): Promise<{ boardId: string; listId: string }> {
    const s = runSuffix();
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `B Board ${s}`,
        topicId: null,
        creatorId: created.ownerIds[0],
        settings: {},
      }),
    );
    created.boardIds.push(board.id);
    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: `B List ${s}`,
        position: 0,
        mappedStatus: null,
      }),
    );
    created.listIds.push(list.id);
    return { boardId: board.id, listId: list.id };
  }

  /**
   * 建 5 个任务（assignee = agent）：status 覆盖 in_progress/todo/blocked/backlog/done，
   * 均带 priority/labels/dueDate（投影断言用）。返回 status → Task 映射。
   */
  async function createTasks(listId: string, agentId: string): Promise<Record<string, Task>> {
    const s = runSuffix();
    const tasks: Record<string, Task> = {};
    const statuses: TaskStatus[] = [
      TaskStatus.IN_PROGRESS,
      TaskStatus.TODO,
      TaskStatus.BLOCKED,
      TaskStatus.BACKLOG,
      TaskStatus.DONE,
    ];
    for (const status of statuses) {
      const task = await ds.getRepository(Task).save(
        ds.getRepository(Task).create({
          listId,
          title: `B Task ${status} ${s}`,
          status,
          assigneeId: agentId,
          priority: Priority.P2,
          labels: [`label-${status}`],
          dueDate: new Date('2026-12-31T00:00:00.000Z'),
        }),
      );
      created.taskIds.push(task.id);
      tasks[status] = task;
    }
    return tasks;
  }

  /** 建 topic + agent 参与行（active）+ 2 条消息（1 短 1 超长 >300 字符），返回 id 与原文 */
  async function createTopicWithMessages(agentId: string): Promise<{
    topicId: string;
    topicName: string;
    shortMsgId: string;
    shortContent: string;
    longMsgId: string;
    longContent: string;
  }> {
    const s = runSuffix();
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `B Topic ${s}`,
        creatorId: agentId,
        status: TopicStatus.ACTIVE,
        settings: {},
      }),
    );
    created.topicIds.push(topic.id);
    const participant = await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId: topic.id,
        participantId: agentId,
        role: 'member',
        status: 'active',
        joinedAt: new Date(),
        notificationSettings: { mute: false, mentions_only: false },
        lastReadMessageId: null,
      }),
    );
    created.participantRows.push({ topicId: topic.id, participantId: participant.participantId });

    const shortContent = `B short message ${s}`;
    const shortMsg = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId: topic.id,
        senderId: agentId,
        type: MessageType.CHAT,
        content: shortContent,
      }),
    );
    created.messageIds.push(shortMsg.id);

    // 超长 content（>300 字符）：验证 recentActivities 截断 + contentTruncated 标记
    const longContent = `B long message ${s} ` + 'x'.repeat(500);
    const longMsg = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId: topic.id,
        senderId: agentId,
        type: MessageType.CHAT,
        content: longContent,
      }),
    );
    created.messageIds.push(longMsg.id);

    return {
      topicId: topic.id,
      topicName: topic.title,
      shortMsgId: shortMsg.id,
      shortContent,
      longMsgId: longMsg.id,
      longContent,
    };
  }

  it('happy path 全链路：HTTP + API Key → 信封/me 白名单/activeTasks 投影排序/unread/截断', async () => {
    if (!dbAvailable) return;

    const { agent, rawKey } = await createOwnerAndAgent();
    const { boardId, listId } = await createBoardWithList();
    const tasks = await createTasks(listId, agent.id);
    // in_progress 任务挂一个 blocks 依赖（被依赖 = blocked 任务，未完成）→ hasBlockers=true
    const dep = await ds.getRepository(TaskDependency).save(
      ds.getRepository(TaskDependency).create({
        taskId: tasks[TaskStatus.IN_PROGRESS].id,
        dependsOnTaskId: tasks[TaskStatus.BLOCKED].id,
        type: TaskDependencyType.BLOCKS,
      }),
    );
    created.depIds.push(dep.id);
    const { topicId, topicName, shortMsgId, shortContent, longMsgId, longContent } =
      await createTopicWithMessages(agent.id);

    const res = await request(app.getHttpServer())
      .get('/api/v1/agents/me/briefing')
      .set('X-API-Key', rawKey)
      .expect(200);

    // ── 响应信封 + 顶层形状 ──
    expect(res.body.code).toBe(ErrorCode.SUCCESS);
    const data = res.body.data;
    expect(Object.keys(data).sort()).toEqual([
      'activeTasks',
      'me',
      'recentActivities',
      'unreadCounts',
    ]);

    // ── me：白名单投影（ME-12V8：HTTP 层 JSON 丢 undefined → 8 字段全集；
    //    无 avatarUrl/apiKeyPrefix/敏感字段）──
    const me = data.me;
    expect(Object.keys(me).sort()).toEqual([
      'capabilities',
      'createdAt',
      'description',
      'id',
      'lastActiveAt',
      'name',
      'ownerId',
      'status',
    ]);
    // 12 字段白名单子集（对象级契约的 HTTP 层投影）
    for (const key of Object.keys(me)) {
      expect(ME_WHITELIST_12).toContain(key);
    }
    expect(me.id).toBe(agent.id);
    expect(me.name).toBe(agent.name);
    expect(me.status).toBe(AgentStatus.ACTIVE);
    expect(me.ownerId).toBe(agent.ownerId);
    // 认证元数据 + 敏感字段剥离（AGENT-FIELD-WHITELIST 最后一道裁剪）
    expect(me.avatarUrl).toBeUndefined();
    expect(me.apiKeyPrefix).toBeUndefined();
    expect(me.webhookSecret).toBeUndefined();
    expect(me.systemPrompt).toBeUndefined();
    expect(me.modelConfig).toBeUndefined();
    expect(me.rateLimit).toBeUndefined();
    expect(me.webhookUrl).toBeUndefined();
    expect(me.webhookEvents).toBeUndefined();
    expect(me.webhookTimeoutMs).toBeUndefined();
    expect(me.webhookRetryMax).toBeUndefined();

    // ── activeTasks：12 字段投影 + statusPriority 排序 + done 排除 + hasBlockers ──
    expect(data.activeTasks.total).toBe(4);
    expect(data.activeTasks.items).toHaveLength(4);
    const statuses = data.activeTasks.items.map((i: Record<string, unknown>) => i.status);
    expect(statuses).toEqual([
      TaskStatus.IN_PROGRESS,
      TaskStatus.TODO,
      TaskStatus.BLOCKED,
      TaskStatus.BACKLOG,
    ]);
    for (const item of data.activeTasks.items) {
      expect(Object.keys(item).sort()).toEqual([...ACTIVE_TASK_FIELDS_12].sort());
      expect(item.boardId).toBe(boardId);
      expect(item.listId).toBe(listId);
      expect(item.boardName).toBeTruthy();
      expect(item.listName).toBeTruthy();
      expect(item.priority).toBe(Priority.P2);
      expect(item.labels).toEqual(expect.any(Array));
      expect(item.dueDate).toBeTruthy();
    }
    // hasBlockers：in_progress 有未完成 blocks 依赖 → true；其余 false
    expect(data.activeTasks.items[0].hasBlockers).toBe(true);
    expect(data.activeTasks.items[1].hasBlockers).toBe(false);
    expect(data.activeTasks.items[2].hasBlockers).toBe(false);
    expect(data.activeTasks.items[3].hasBlockers).toBe(false);

    // ── unreadCounts：2 条消息无游标 → 2 ──
    expect(data.unreadCounts).toEqual([{ topicId, topicName, unreadCount: 2 }]);

    // ── recentActivities：message 条目 content 截断（>300 → 300 + contentTruncated）──
    const msgActivities = data.recentActivities.filter(
      (a: Record<string, unknown>) => a.type === 'message',
    );
    expect(msgActivities).toHaveLength(2);
    const longAct = msgActivities.find(
      (a: Record<string, unknown>) => a.id === longMsgId,
    ) as Record<string, unknown>;
    expect(longAct.content).toBe(longContent.slice(0, 300));
    expect(longAct.content).toHaveLength(300);
    expect(longAct.contentTruncated).toBe(true);
    const shortAct = msgActivities.find(
      (a: Record<string, unknown>) => a.id === shortMsgId,
    ) as Record<string, unknown>;
    expect(shortAct.content).toBe(shortContent);
    expect(shortAct.contentTruncated).toBeUndefined();
  }, 30000);

  it('statuses 空值 / 含 all → 400，消息列合法枚举 + 正确示例（DX #1 落点）', async () => {
    if (!dbAvailable) return;

    // GUARD-FIRST：guard 先于 pipe，400 用例也必须带合法 API Key（否则先 401）
    const { rawKey } = await createOwnerAndAgent();

    // 空值：Transform 后为空数组 → IsBriefingStatuses 拒绝（不得静默退化为全量查询）
    const empty = await request(app.getHttpServer())
      .get('/api/v1/agents/me/briefing?statuses=')
      .set('X-API-Key', rawKey)
      .expect(400);
    expect(empty.body.code).toBe(ErrorCode.BAD_REQUEST);
    expect(empty.body.message).toContain(
      'TaskStatus values (backlog, todo, in_progress, review, done, blocked, archived)',
    );
    expect(empty.body.message).toContain("'all' is not supported");
    expect(empty.body.message).toContain('Example: statuses=todo,in_progress');

    // 'all' 不在 TaskStatus 枚举内 → 自动拒绝（briefing 的 active 语义不支持全量）
    const all = await request(app.getHttpServer())
      .get('/api/v1/agents/me/briefing?statuses=all')
      .set('X-API-Key', rawKey)
      .expect(400);
    expect(all.body.code).toBe(ErrorCode.BAD_REQUEST);
    expect(all.body.message).toContain('Example: statuses=todo,in_progress');
    expect(all.body.message).toContain("'all' is not supported");
  }, 30000);

  it('statuses=todo 单值收缩 → activeTasks 只含 todo（替换而非追加）', async () => {
    if (!dbAvailable) return;

    const { agent, rawKey } = await createOwnerAndAgent();
    const { listId } = await createBoardWithList();
    await createTasks(listId, agent.id);

    const res = await request(app.getHttpServer())
      .get('/api/v1/agents/me/briefing?statuses=todo')
      .set('X-API-Key', rawKey)
      .expect(200);

    const data = res.body.data;
    expect(data.activeTasks.total).toBe(1);
    expect(data.activeTasks.items).toHaveLength(1);
    expect(data.activeTasks.items[0].status).toBe(TaskStatus.TODO);
  }, 30000);
});
