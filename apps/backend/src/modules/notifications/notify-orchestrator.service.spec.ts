/**
 * NotifyOrchestrator 单测（事件映射 / 自回声 / topic 参与 / L1 / L2 / 渲染 / 投递 / listener 纪律）。
 *
 * 设计意图：本文件覆盖 plan §9 的"orchestrator（映射 / 跃迁判据 / 自回声 / topic active 过滤 /
 * L1 / L2 摘要文案 / 摘要不占额度）"与"listener 真断言（注册参数 `{async:true}` +
 * fire-and-forget 路径观测不到 unhandledRejection）"。
 *
 * ⚠️ **不写"create 不受影响"这类空测试**——那在 `{async:true}` 下恒绿，是假断言（plan §9）。
 * 真正要钉住的是"回调内启动的 promise 的 rejection 不会变成未捕获 rejection"（Node 22 默认崩进程）。
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import {
  EventType,
  MessageType,
  ParticipantStatus,
  ResourceType,
  TaskStatus,
} from '@agent-chamber/shared';
import {
  NOTIFICATIONS_CONFIG_FALLBACK,
  NOTIFY_CATEGORIES,
  NOTIFY_CATEGORY,
  type NotificationsConfig,
} from '../../config/notifications.config';
import { DIGEST_DELIVERY_CATEGORY } from '../../database/entities/notification-delivery.entity';
import type { Event } from '../../database/entities/event.entity';
import { deliveryEligibleWhere } from './notification-channel-eligibility';
import type { NotifyProvider } from './notify-provider.interface';
import {
  CONSECUTIVE_FAILURE_WARN_THRESHOLD,
  L2_SWEEP_INTERVAL_MS,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_SUMMARY_MAX_LENGTH,
  NotifyOrchestrator,
  TtlMap,
  isCompletionTransition,
  resolveNotificationCategory,
} from './notify-orchestrator.service';

// ───────────────────────────── 纯函数：类别映射 ─────────────────────────────

describe('resolveNotificationCategory（§5 类别 → 事件映射）', () => {
  const event = (eventType: EventType, payload: Record<string, unknown> = {}) =>
    ({ eventType, payload }) as Pick<Event, 'eventType' | 'payload'>;

  it('TASK_UPDATE：完工跃迁 → task_done；创建 → task_created；其余 → task_updated', () => {
    expect(
      resolveNotificationCategory(
        event(EventType.TASK_UPDATE, { toStatus: 'done', fromStatus: 'in_progress' }),
      ),
    ).toBe('task_done');
    expect(
      resolveNotificationCategory(
        event(EventType.TASK_UPDATE, { toStatus: 'blocked', fromStatus: 'todo' }),
      ),
    ).toBe('task_done');
    expect(resolveNotificationCategory(event(EventType.TASK_UPDATE, { action: 'created' }))).toBe(
      'task_created',
    );
    expect(
      resolveNotificationCategory(
        event(EventType.TASK_UPDATE, { action: 'updated', status: 'in_progress' }),
      ),
    ).toBe('task_updated');
  });

  it('跃迁判据：**改一个已完成任务的描述不推完工**（载荷无跃迁字段 ⇒ 判据为假）', () => {
    // patchDescription 路径的真实载荷形状：{taskId, action:'updated', fieldName:'description'}
    expect(
      resolveNotificationCategory(
        event(EventType.TASK_UPDATE, { action: 'updated', fieldName: 'description' }),
      ),
    ).toBe('task_updated');
    // 同状态重放（fromStatus === toStatus）同样不算跃迁
    expect(
      resolveNotificationCategory(
        event(EventType.TASK_UPDATE, { toStatus: 'done', fromStatus: 'done' }),
      ),
    ).toBe('task_updated');
  });

  it('TASK_ASSIGNED → task_assigned（assign() 与 PATCH 改派两路径同形）', () => {
    expect(resolveNotificationCategory(event(EventType.TASK_ASSIGNED, { assigneeId: 'a' }))).toBe(
      'task_assigned',
    );
  });

  it('NEW_MESSAGE：普通消息 → topic；**system 消息不算"有人说话"**', () => {
    expect(
      resolveNotificationCategory(event(EventType.NEW_MESSAGE, { type: MessageType.CHAT })),
    ).toBe('topic');
    expect(
      resolveNotificationCategory(event(EventType.NEW_MESSAGE, { type: MessageType.SYSTEM })),
    ).toBeNull();
  });

  it('文档四类：DOC_CREATED/DELETED/MOVED 直通；DOC_UPDATED 纯重切短路', () => {
    expect(resolveNotificationCategory(event(EventType.DOC_CREATED))).toBe('doc_created');
    expect(resolveNotificationCategory(event(EventType.DOC_DELETED))).toBe('doc_deleted');
    expect(resolveNotificationCategory(event(EventType.DOC_MOVED))).toBe('doc_moved');
    expect(resolveNotificationCategory(event(EventType.DOC_UPDATED, { rechunked: false }))).toBe(
      'doc_updated',
    );
    // 纯重切（rechunked === true）⇒ 内容没变，通知它只是噪音
    expect(
      resolveNotificationCategory(event(EventType.DOC_UPDATED, { rechunked: true })),
    ).toBeNull();
  });

  it('映射值域 ⊂ NOTIFY_CATEGORIES（新增 token 必须同步本表与 config 值域）', () => {
    const produced = new Set<string>();
    for (const eventType of Object.values(EventType)) {
      const category = resolveNotificationCategory(event(eventType as EventType));
      if (category) produced.add(category);
    }
    for (const category of produced) expect(NOTIFY_CATEGORIES).toContain(category);
  });
});

describe('isCompletionTransition（完工跃迁判据）', () => {
  it('只有 toStatus ∈ {done, blocked} 且 fromStatus !== toStatus 才算', () => {
    expect(isCompletionTransition({ toStatus: 'done', fromStatus: 'todo' })).toBe(true);
    expect(isCompletionTransition({ toStatus: 'blocked', fromStatus: 'done' })).toBe(true);
    expect(isCompletionTransition({ toStatus: 'done', fromStatus: 'done' })).toBe(false);
    expect(isCompletionTransition({ toStatus: 'in_progress', fromStatus: 'todo' })).toBe(false);
    // 缺字段：两值都是 undefined ⇒ 假（"旧路径一律不判完工"的机制）
    expect(isCompletionTransition({})).toBe(false);
    expect(isCompletionTransition({ status: 'done' })).toBe(false);
    // 只给 toStatus（无 fromStatus）⇒ true（undefined !== 'done'）——这是 move() 的 autoStatus 形态
    expect(isCompletionTransition({ toStatus: 'done' })).toBe(true);
  });
});

describe('TtlMap（L1 / topic 缓存共用实现）', () => {
  it('TTL 到期即惰性失效（不靠定时器）', () => {
    const map = new TtlMap<true>(10);
    map.set('k', true, 1000, 0);
    expect(map.get('k', 999)).toBe(true);
    expect(map.get('k', 1000)).toBeUndefined();
    expect(map.size).toBe(0); // 过期即被读时回收
  });

  it('容量满 ⇒ 插前删最旧（Map 迭代序 = 插入序）', () => {
    const map = new TtlMap<true>(2);
    map.set('a', true, 1000, 0);
    map.set('b', true, 1000, 0);
    map.set('c', true, 1000, 0);
    expect(map.size).toBe(2);
    expect(map.get('a', 1)).toBeUndefined(); // 最旧的 a 被淘汰
    expect(map.get('b', 1)).toBe(true);
    expect(map.get('c', 1)).toBe(true);
  });

  it('重复写同一键不增长容量', () => {
    const map = new TtlMap<true>(2);
    map.set('a', true, 1000, 0);
    map.set('a', true, 1000, 0);
    expect(map.size).toBe(1);
  });
});

// ───────────────────────────── 编排器（管线） ─────────────────────────────

/** 成功终态（provider 假实现复用） */
const SUCCESS_OUTCOME = {
  status: 'success' as const,
  attempts: 1,
  responseStatus: 200,
  lastError: null,
  deliveredAt: new Date('2026-10-13T00:00:00.000Z'),
};

/** 失败终态 */
const FAILED_OUTCOME = {
  status: 'failed' as const,
  attempts: 1,
  responseStatus: 500,
  lastError: 'boom',
  deliveredAt: null,
};

describe('NotifyOrchestrator 事件管线', () => {
  /** 测试用配置：默认全类别 + 已配收件人与深链基址（否则管线会在 no_recipient 处丢弃） */
  function makeSettings(overrides: Partial<NotificationsConfig> = {}): NotificationsConfig {
    return {
      ...NOTIFICATIONS_CONFIG_FALLBACK,
      enabled: true,
      categories: [...NOTIFY_CATEGORIES],
      providers: ['feishu'],
      feishuRecipientOpenId: 'ou_test_recipient',
      webBaseUrl: 'https://platform.example.com',
      // 缺省把 L2 窗口放大，避免无关用例被"超额合并"干扰（要测 L2 的用例自己覆盖）
      globalRateLimit: 500,
      ...overrides,
    };
  }

  /** 事件行工厂（缺省 = 一次普通任务更新） */
  function makeEvent(overrides: Partial<Event> = {}): Event {
    return {
      id: 'evt-1',
      eventType: EventType.TASK_UPDATE,
      resourceType: ResourceType.TASK,
      resourceId: 'task-1',
      topicId: null,
      boardId: 'board-1',
      actorId: 'actor-trigger',
      payload: { taskId: 'task-1', action: 'updated' },
      ...overrides,
    } as unknown as Event;
  }

  interface Harness {
    orchestrator: NotifyOrchestrator;
    provider: NotifyProvider & { send: jest.Mock };
    deliveryRepo: { record: jest.Mock };
    taskRepo: { findOne: jest.Mock };
    messageRepo: { findOne: jest.Mock };
    topicRepo: { findOne: jest.Mock };
    docRepo: { findOne: jest.Mock };
    boardRepo: { findOne: jest.Mock };
    docSpaceRepo: { findOne: jest.Mock };
    actorProfiles: { resolveProfiles: jest.Mock };
    topicParticipantRepo: { count: jest.Mock; find: jest.Mock };
    userRepo: { createQueryBuilder: jest.Mock; find: jest.Mock; findOne: jest.Mock };
    channelRepo: {
      count: jest.Mock;
      createQueryBuilder: jest.Mock;
      find: jest.Mock;
      findOne: jest.Mock;
      save: jest.Mock;
    };
    agentRepo: { find: jest.Mock };
    accessQuery: { resolveBoardAccess: jest.Mock; resolveSpaceAccess: jest.Mock };
    logSpy: jest.SpyInstance;
    warnSpy: jest.SpyInstance;
    errorSpy: jest.SpyInstance;
  }

  /**
   * 路由夹具（Notifications 二期批 2）：候选用户 / 我的 agent / 类别偏好 / 两类资源剖面。
   *
   * 缺省值刻意"让存量渲染与节流用例照旧走通"：一个候选（地址 = `ou_test_recipient`，与
   * `makeSettings().feishuRecipientOpenId` 同值 ⇒ L2 窗口键与直发用例一致）、全类别偏好打开、
   * 看板/空间剖面里该候选是**成员且可读**。
   */
  interface RoutingFixture {
    /** 有 deliveryEligible 绑定的候选用户 id（缺省 `['user-1']`；空数组 = 部署里还没人绑渠道） */
    candidates?: string[];
    /** userId → 投递地址（缺省全部 = `ou_test_recipient`） */
    addresses?: Record<string, string>;
    /** userId → 该用户名下的 agent id（owner-proxy 语义；缺省全空） */
    agentIds?: Record<string, string[]>;
    /** userId → 类别偏好**稀疏覆盖**（缺省 = 不覆盖 ⇒ 全类别开；测试要"关掉某类"时写 `{[c]: false}`） */
    prefs?: Record<string, Record<string, boolean>>;
    /** `resolveBoardAccess` 返回值（缺省见 `defaultProfile()`） */
    boardProfile?: unknown;
    /** `resolveSpaceAccess` 返回值（缺省见 `defaultProfile()`） */
    spaceProfile?: unknown;
    /** 绑定行的 provider token（缺省 `feishu`；MINOR-3 的"绑了部署没启用的渠道"档用它） */
    channelProvider?: string;
  }

  /**
   * 装配被测编排器（仓储/provider/落库全为内存替身）。
   *
   * @param settings 配置（缺省见 makeSettings）
   * @param ownerRows `resolveOwners` 的查询返回（username → actorId 的解析结果）。
   *   **非空时自动把 username 填进 `settings.ownerUsernames`**——`resolveOwners` 在名单为空时
   *   直接早退，两个入参写拧会让"owner 类"用例静默走成"owner 未配置"分支。
   * @param routing 路由夹具（候选 / 偏好 / 我的 agent / 资源剖面；缺省见 RoutingFixture）
   */
  function makeHarness(
    settings: NotificationsConfig = makeSettings(),
    ownerRows: Array<{ id: string; username: string }> = [],
    routing: RoutingFixture = {},
    /** 额外出口（MINOR-3 的"多 provider 部署"档：断言投递只走收件人绑定的那一个） */
    extraProviders: NotifyProvider[] = [],
  ): Harness {
    const effectiveSettings: NotificationsConfig =
      ownerRows.length > 0 && settings.ownerUsernames.length === 0
        ? { ...settings, ownerUsernames: ownerRows.map((row) => row.username) }
        : settings;

    // ── 路由夹具（Notifications 二期批 2）────────────────────────────────────
    const candidateIds = routing.candidates ?? ['user-1'];
    const addressOf = (userId: string): string =>
      routing.addresses?.[userId] ?? settings.feishuRecipientOpenId ?? 'ou_test_recipient';
    const agentIdsOf = (userId: string): string[] => routing.agentIds?.[userId] ?? [];
    const prefsOf = (userId: string): Record<string, boolean> => {
      const overrides = routing.prefs?.[userId] ?? {};
      const merged: Record<string, boolean> = {};
      for (const category of NOTIFY_CATEGORIES) merged[category] = overrides[category] ?? true;
      return merged;
    };
    /** 缺省剖面：候选**可读且是成员**（让存量渲染/节流用例的"该投"前提成立） */
    const defaultProfile = () => ({
      visibility: 'open',
      creatorActorId: 'agent-creator',
      memberUserIds: new Set(candidateIds),
      readableUserIds: new Set(candidateIds),
    });
    const accessQuery = {
      resolveBoardAccess: jest.fn(async () => routing.boardProfile ?? defaultProfile()),
      resolveSpaceAccess: jest.fn(async () => routing.spaceProfile ?? defaultProfile()),
    };

    const provider = {
      key: 'feishu',
      send: jest.fn().mockResolvedValue(SUCCESS_OUTCOME),
    } as unknown as NotifyProvider & { send: jest.Mock };

    const taskRepo = {
      // `list` 关系：路由要用它取 boardId（**不信 `event.boardId`**——task.service.ts 明写它是可选键）
      findOne: jest.fn().mockResolvedValue({
        id: 'task-1',
        title: '任务标题',
        assigneeId: null,
        list: { boardId: 'board-1' },
      }),
    };
    const messageRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'msg-1', content: '消息正文' }),
    };
    const topicRepo = { findOne: jest.fn().mockResolvedValue({ id: 'topic-1', title: '话题名' }) };
    const docRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'doc-1',
        path: 'docs/a.md',
        title: '文档标题',
        spaceId: 'space-1',
      }),
    };
    // ── v2 归属 stub ──────────────────────────────────────────────────────
    // 看板名 / 空间名各一个固定行；actor 名走 ActorProfileService 替身（名字由 id 派生，
    // 让断言能一眼看出"是哪一次解析的产物"）。**真身的名字回退链由该服务自己的套件守护**。
    const boardRepo = { findOne: jest.fn().mockResolvedValue({ id: 'board-1', name: '合成看板' }) };
    const docSpaceRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'space-1', name: '合成空间' }),
    };
    const actorProfiles = {
      resolveProfiles: jest.fn(async (ids: string[]) => {
        return new Map(ids.filter(Boolean).map((id) => [id, { name: `name-${id}` }]));
      }),
    };
    // 二期：topic 参与读的是 **active 参与者集合**（一条查询喂饱全部候选），缺省 = 候选都在场
    const topicParticipantRepo = {
      count: jest.fn().mockResolvedValue(1),
      find: jest.fn(async () => candidateIds.map((participantId) => ({ participantId }))),
    };

    const rawBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(ownerRows),
    };
    const userRepo = {
      createQueryBuilder: jest.fn(() => rawBuilder),
      // 二期：direct 无绑定预警要按 user id 取显示名（名单截断）
      find: jest.fn().mockResolvedValue([]),
      // 二期批 2：快照要读 `users.preferences.notificationCategories`（缺省 = 全类别开）
      findOne: jest.fn(async (options: { where?: { id?: string } }) => ({
        id: options?.where?.id ?? 'user-1',
        preferences: { notificationCategories: prefsOf(options?.where?.id ?? 'user-1') },
      })),
    };

    // Notifications 二期：渠道绑定仓储（D4 播种 / 零绑定锚点 / direct 预警 / **候选查询**）与
    // agent 仓储。count=1 表示"存在一条投递资格绑定"，避免启动诊断打出与实际无关的零绑定 ERROR。
    // ⚠️ `find` 是**三用**的，按入参形状分派（避免用例各自 mockImplementation 打翻别处）：
    //   ① 候选查询（`where.user` 存在）→ 全部候选行；
    //   ② direct 无绑定预警（`where.userId` 是 `In(...)`）→ 按 owner 过滤（缺省全无绑定）；
    //   ③ 快照的渠道读取（`where.userId` 是字符串）→ 该用户的 eligible 行。
    const candidateRow = (userId: string) => ({
      userId,
      provider: routing.channelProvider ?? 'feishu',
      recipientAddress: addressOf(userId),
      enabled: true,
      unboundAt: null,
      lastTestStatus: 'ok',
      createdAt: new Date(0),
    });
    // 候选查询走 **QueryBuilder**（INNER JOIN + 谓词单源；见 orchestrator 的
    // `loadCandidateUserIds` —— `find` 的关系 where 会把软删过滤折进 LEFT JOIN 的 ON 子句而失效）
    const candidateQb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(async () => candidateIds.map((userId) => ({ userId }))),
    };
    const channelRepo = {
      count: jest.fn().mockResolvedValue(1),
      createQueryBuilder: jest.fn(() => candidateQb),
      find: jest.fn(async (options: { where?: Record<string, unknown> }) => {
        const where = options?.where ?? {};
        const userId = where.userId;
        if (typeof userId === 'string') {
          return candidateIds.includes(userId) ? [candidateRow(userId)] : [];
        }
        return [];
      }),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
      manager: { transaction: jest.fn() },
    };
    // agentRepo.find **两用**：① direct 无绑定预警（无 where，取全部 ownerId）；
    // ② 快照的"我的 agent"（`where.ownerId`）；③ `getOwnedAgentIdsByOwners`（`where.ownerId = In(...)`）
    const agentRepo = {
      find: jest.fn(async (options?: { where?: { ownerId?: unknown } }) => {
        const ownerId = options?.where?.ownerId;
        if (typeof ownerId === 'string') {
          return agentIdsOf(ownerId).map((id) => ({ id, ownerId }));
        }
        if (ownerId !== undefined) {
          const owners = ((ownerId as { value?: string[] })?.value ?? []) as string[];
          return owners.flatMap((owner) => agentIdsOf(owner).map((id) => ({ id, ownerId: owner })));
        }
        return [];
      }),
    };

    const deliveryRepo = { record: jest.fn().mockResolvedValue(undefined) };

    // Logger 归属层在服务内部；单测直接观测它打了什么（"可 grep 的 INFO 锚点"是契约的一部分）
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const orchestrator = new NotifyOrchestrator(
      { get: () => effectiveSettings } as never,
      userRepo as never,
      taskRepo as never,
      messageRepo as never,
      topicRepo as never,
      docRepo as never,
      topicParticipantRepo as never,
      boardRepo as never,
      docSpaceRepo as never,
      channelRepo as never,
      agentRepo as never,
      [provider, ...extraProviders],
      deliveryRepo as never,
      actorProfiles as never,
      accessQuery as never,
    );

    return {
      orchestrator,
      provider,
      deliveryRepo,
      taskRepo,
      messageRepo,
      topicRepo,
      docRepo,
      boardRepo,
      docSpaceRepo,
      actorProfiles,
      topicParticipantRepo,
      userRepo,
      channelRepo,
      agentRepo,
      accessQuery,
      logSpy,
      warnSpy,
      errorSpy,
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── listener 纪律（plan §9 的"真断言"）─────────────────────────────────

  it('@OnEvent 注册参数 = { event: "event.created", options: { async: true } }', () => {
    const metadata = Reflect.getMetadata(
      'EVENT_LISTENER_METADATA',
      NotifyOrchestrator.prototype.onEventCreated,
    );
    expect(metadata).toEqual([{ event: 'event.created', options: { async: true } }]);
  });

  // ── 总开关 / 类别 / 自回声 ─────────────────────────────────────────────

  it('NOTIFY_ENABLED=false ⇒ 一切静默（不查库、不投递、不落库）', async () => {
    const h = makeHarness(makeSettings({ enabled: false }));
    await h.orchestrator.onEventCreated(makeEvent());
    expect(h.taskRepo.findOne).not.toHaveBeenCalled();
    expect(h.provider.send).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
  });

  it('类别未开启 ⇒ 不投递（细粒度开关生效）', async () => {
    const h = makeHarness(makeSettings({ categories: ['direct'] }));
    await h.orchestrator.onEventCreated(makeEvent());
    expect(h.taskRepo.findOne).not.toHaveBeenCalled();
    expect(h.provider.send).not.toHaveBeenCalled();
  });

  it('per-candidate 自回声：actor === 候选本人 ⇒ 跳过；actor 是我的 agent ⇒ 跳过；他人不跳', async () => {
    // 二期批 2：自回声判据从"全局 owner 名单"改成"按收件人逐个判"（见 `isSelfEcho`），
    // 且判据不再依赖 `resolveOwners()`（那条路只剩播种与直发在用）。
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      agentIds: { 'user-1': ['agent-of-user-1'] },
    });

    // ① 自己触发 ⇒ 跳过（无投递、无日志噪音；路由层静默过滤，不再逐条打 self_echo INFO）
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-1', actorId: 'user-1' }));
    expect(h.provider.send).not.toHaveBeenCalled();

    // ② 我的 agent 触发 ⇒ 跳过（owner-proxy 语义：它是我在平台上做事的身份）
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-2', actorId: 'agent-of-user-1' }));
    expect(h.provider.send).not.toHaveBeenCalled();

    // ③ 他人触发 ⇒ 正常投递（**自回声是 per-candidate 的，不是全局的**）
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-3', actorId: 'someone-else' }));
    expect(h.provider.send).toHaveBeenCalledTimes(1);
  });

  it('owner 解析：命中的 username 记 INFO n/N；未命中的逐个 warning', async () => {
    // 名单两个、查询只解析出一个 ⇒ 另一个必须逐个 warn，且 INFO 报 n/N
    const h = makeHarness(makeSettings({ ownerUsernames: ['owner', 'typo-name'] }), [
      { id: 'owner-actor', username: 'owner' },
    ]);
    await h.orchestrator.resolveOwners();
    expect(h.logSpy).toHaveBeenCalledWith('owner actors resolved 1/2');
    expect(h.warnSpy).toHaveBeenCalledWith(expect.stringContaining('typo-name'));
  });

  it('owner 解析查询带"未软删"条件（actors.deleted_at IS NULL）', async () => {
    const h = makeHarness(makeSettings(), [{ id: 'owner-actor', username: 'owner' }]);
    await h.orchestrator.resolveOwners();
    const builder = h.userRepo.createQueryBuilder.mock.results[0].value;
    expect(builder.andWhere).toHaveBeenCalledWith('actor.deleted_at IS NULL');
  });

  it('owner 解析：查询抛错 ⇒ 自吞 + error 日志（不阻断启动）', async () => {
    const h = makeHarness(makeSettings(), [{ id: 'owner-actor', username: 'owner' }]);
    h.userRepo.createQueryBuilder.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(h.orchestrator.resolveOwners()).resolves.toBeUndefined();
    expect(h.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to resolve NOTIFY_OWNER_USERNAMES'),
    );
  });

  // ── topic 类别 ────────────────────────────────────────────────────────

  it('topic：候选必须是 active 参与者才投；不在参与集合里不投（安全层 = 参与集合）', async () => {
    const topicEvent = (id: string, msgId: string, topicId: string) =>
      makeEvent({
        id,
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: msgId,
        topicId,
        actorId: 'someone-else',
        payload: { messageId: msgId, type: MessageType.CHAT },
      });

    // ① 参与集合只有"别人" ⇒ 候选不在其中 ⇒ 不投
    const out = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    out.topicParticipantRepo.find.mockResolvedValue([{ participantId: 'someone-else' }]);
    await out.orchestrator.onEventCreated(topicEvent('evt-1', 'msg-1', 'topic-1'));
    expect(out.provider.send).not.toHaveBeenCalled();
    // 口径 = status = 'active'（对齐 roundtable 座位过滤）
    expect(out.topicParticipantRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: ParticipantStatus.ACTIVE }),
      }),
    );

    // ② 候选在参与集合里 ⇒ 投（**另一个 topicId**：上一条的"不参与"结论已被 60s 缓存记住）
    const inside = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    inside.topicParticipantRepo.find.mockResolvedValue([{ participantId: 'user-1' }]);
    await inside.orchestrator.onEventCreated(topicEvent('evt-2', 'msg-2', 'topic-2'));
    expect(inside.provider.send).toHaveBeenCalledTimes(1);
  });

  it('topic：参与集合有 60s 缓存（连续两条消息只查一次库）', async () => {
    const h = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    const topicEvent = (id: string, msgId: string) =>
      makeEvent({
        id,
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: msgId,
        topicId: 'topic-1',
        actorId: 'someone-else',
        payload: { messageId: msgId, type: MessageType.CHAT },
      });
    await h.orchestrator.onEventCreated(topicEvent('evt-1', 'msg-1'));
    await h.orchestrator.onEventCreated(topicEvent('evt-2', 'msg-2'));
    expect(h.topicParticipantRepo.find).toHaveBeenCalledTimes(1);
  });

  it('topic 参与缓存的写时失效：AGENT_JOINED / AGENT_LEFT ⇒ 下一次事件重新查库（**不看 actorType**）', async () => {
    const h = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    const topicEvent = (id: string, msgId: string) =>
      makeEvent({
        id,
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: msgId,
        topicId: 'topic-1',
        actorId: 'someone-else',
        payload: { messageId: msgId, type: MessageType.CHAT },
      });
    await h.orchestrator.onEventCreated(topicEvent('evt-1', 'msg-1'));
    expect(h.topicParticipantRepo.find).toHaveBeenCalledTimes(1);

    // 人类的加入/退出发的是**同一对事件**（topic.service.ts 三处 emit 共用）⇒ 不得按 actorType 过滤
    await h.orchestrator.onEventCreated(
      makeEvent({
        id: 'evt-join',
        eventType: EventType.AGENT_JOINED,
        resourceType: ResourceType.TOPIC,
        resourceId: 'topic-1',
        actorType: 'human' as never,
        topicId: 'topic-1',
        payload: { participantId: 'user-2' },
      }),
    );
    await h.orchestrator.onEventCreated(topicEvent('evt-2', 'msg-2'));
    expect(h.topicParticipantRepo.find).toHaveBeenCalledTimes(2); // 缓存被清 ⇒ 重新查

    // 反向守卫：**与缓存无关的事件不得清缓存**（board 成员事件刻意不接——无缓存可失效）
    await h.orchestrator.onEventCreated(
      makeEvent({
        id: 'evt-board',
        eventType: EventType.AGENT_JOINED,
        resourceType: ResourceType.BOARD,
        resourceId: 'board-1',
      }),
    );
    await h.orchestrator.onEventCreated(topicEvent('evt-3', 'msg-3'));
    expect(h.topicParticipantRepo.find).toHaveBeenCalledTimes(2); // 仍是缓存命中
  });

  it('零候选 ⇒ 每类别只打一行 INFO（与"路由坏了"可分辨；不再有「owner 未解析」跳过整类）', async () => {
    // 无候选 = 部署里还没人绑渠道（合法第一天状态）
    const h = makeHarness(makeSettings(), [], { candidates: [] });
    const topicEvent = makeEvent({
      eventType: EventType.NEW_MESSAGE,
      resourceType: ResourceType.MESSAGE,
      resourceId: 'msg-1',
      topicId: 'topic-1',
      actorId: 'someone-else',
      payload: { type: MessageType.CHAT },
    });
    await h.orchestrator.onEventCreated(topicEvent);
    await h.orchestrator.onEventCreated({ ...topicEvent, id: 'evt-2' } as Event);
    expect(h.provider.send).not.toHaveBeenCalled();
    // 一条查询就到"没有人该收"：连 topic 参与集合都不必查（零候选在人的维度上就砍光了）
    expect(h.topicParticipantRepo.find).not.toHaveBeenCalled();
    expect(
      h.logSpy.mock.calls.filter((call) => String(call[0]).includes('zero_candidates')),
    ).toHaveLength(1); // 只报一次，不刷屏
  });

  // ── 路由：Notifications 二期批 2 双层判据（安全层 ∧ 注意力层）──────────────

  /** 剖面工厂（只写要覆盖的分量，其余取"最小权限"缺省——避免默认值把用例测成假绿） */
  const profile = (
    overrides: Partial<{
      visibility: string;
      creatorActorId: string;
      memberUserIds: Set<string>;
      readableUserIds: Set<string>;
    }> = {},
  ) => ({
    visibility: 'open',
    creatorActorId: 'someone-else',
    memberUserIds: new Set<string>(),
    readableUserIds: new Set<string>(),
    ...overrides,
  });

  it('task：安全层未过（PRIVATE 看板、非成员非 creator 且不可读）⇒ 零推送', async () => {
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      boardProfile: profile({ visibility: 'private' }),
    });
    await h.orchestrator.onEventCreated(makeEvent());
    expect(h.provider.send).not.toHaveBeenCalled();
    // 安全层判据来自 AccessQueryService（**单源**）——本文件不得自建近似推断
    expect(h.accessQuery.resolveBoardAccess).toHaveBeenCalledWith('board-1', ['user-1']);
  });

  it('task：安全层过了但注意力层不过（open 看板 + 非成员/非 creator/非 assignee）⇒ 不投（防噪音）', async () => {
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      // open ⇒ readable 放行；但"全网可见"不等于"跟我有关"
      boardProfile: profile({ readableUserIds: new Set(['user-1']) }),
    });
    await h.orchestrator.onEventCreated(makeEvent());
    expect(h.provider.send).not.toHaveBeenCalled();
  });

  it('task：注意力层命中不豁免安全层（成员看得到、被移出后不可读 ⇒ 不投）', async () => {
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      // 曾在成员表里（memberUserIds 命中）但 read 判据已不成立 ⇒ 安全层拦下
      boardProfile: profile({ memberUserIds: new Set(['user-1']) }),
    });
    const taskWithAssignee = {
      id: 'task-1',
      title: '任务标题',
      assigneeId: 'user-1',
      list: { boardId: 'board-1' },
    };
    h.taskRepo.findOne.mockResolvedValue(taskWithAssignee);
    await h.orchestrator.onEventCreated(makeEvent());
    expect(h.provider.send).not.toHaveBeenCalled();

    // 反证：同一份夹具只把"可读"补上 ⇒ 立刻投递（证明上一条挡在安全层而不是别处）
    const ok = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      boardProfile: profile({ readableUserIds: new Set(['user-1']) }),
    });
    ok.taskRepo.findOne.mockResolvedValue(taskWithAssignee);
    await ok.orchestrator.onEventCreated(makeEvent());
    expect(ok.provider.send).toHaveBeenCalledTimes(1);
  });

  it('task：owner-proxy——agent 建的 PRIVATE 看板，其人类 owner 应收（creator 源含"我的 agent"）', async () => {
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      agentIds: { 'user-1': ['agent-of-user-1'] },
      boardProfile: profile({
        visibility: 'private',
        creatorActorId: 'agent-of-user-1',
        readableUserIds: new Set(['user-1']),
      }),
    });
    await h.orchestrator.onEventCreated(makeEvent());
    expect(h.provider.send).toHaveBeenCalledTimes(1);
  });

  it('task：orphan（无看板）按 public 免安全层，但注意力层只剩 assignee', async () => {
    // 无 assignee ⇒ 无人该收（"public" 免的是**安全层**，不是注意力层）
    const orphan = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    orphan.taskRepo.findOne.mockResolvedValue({
      id: 'task-1',
      title: 't',
      assigneeId: null,
      list: null,
    });
    await orphan.orchestrator.onEventCreated(makeEvent());
    expect(orphan.provider.send).not.toHaveBeenCalled();
    expect(orphan.accessQuery.resolveBoardAccess).not.toHaveBeenCalled();

    // 被指派给候选（或其 agent）⇒ 投
    const assigned = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      agentIds: { 'user-1': ['agent-of-user-1'] },
    });
    assigned.taskRepo.findOne.mockResolvedValue({
      id: 'task-1',
      title: 't',
      assigneeId: 'agent-of-user-1',
      list: null,
    });
    await assigned.orchestrator.onEventCreated(makeEvent());
    expect(assigned.provider.send).toHaveBeenCalledTimes(1);
  });

  it('doc：安全层走 resolveSpaceAccess；doc_deleted 用 withDeleted 变体，其余用存活行', async () => {
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      spaceProfile: profile({
        memberUserIds: new Set(['user-1']),
        readableUserIds: new Set(['user-1']),
      }),
    });
    await h.orchestrator.onEventCreated(
      makeEvent({ id: 'e1', eventType: EventType.DOC_UPDATED, resourceId: 'doc-1', payload: {} }),
    );
    expect(h.accessQuery.resolveSpaceAccess).toHaveBeenCalledWith('space-1', ['user-1'], {
      withDeleted: false,
    });
    await h.orchestrator.onEventCreated(
      makeEvent({ id: 'e2', eventType: EventType.DOC_DELETED, resourceId: 'doc-2', payload: {} }),
    );
    expect(h.accessQuery.resolveSpaceAccess).toHaveBeenCalledWith('space-1', ['user-1'], {
      withDeleted: true,
    });
  });

  it('doc：空间可读但候选既非空间成员/creator 也非该文档创建者 ⇒ 不投（注意力层）', async () => {
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      spaceProfile: profile({ readableUserIds: new Set(['user-1']) }),
    });
    h.docRepo.findOne.mockResolvedValue({
      id: 'doc-1',
      path: 'docs/a.md',
      title: '文档标题',
      spaceId: 'space-1',
      createdBy: 'someone-else',
    });
    await h.orchestrator.onEventCreated(
      makeEvent({ eventType: EventType.DOC_UPDATED, resourceId: 'doc-1', payload: {} }),
    );
    expect(h.provider.send).not.toHaveBeenCalled();

    // 反证：把文档创建者换成"我的 agent" ⇒ 立刻投（owner-proxy 的 doc 分量）
    const owned = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      agentIds: { 'user-1': ['agent-of-user-1'] },
      spaceProfile: profile({ readableUserIds: new Set(['user-1']) }),
    });
    owned.docRepo.findOne.mockResolvedValue({
      id: 'doc-1',
      path: 'docs/a.md',
      title: '文档标题',
      spaceId: 'space-1',
      createdBy: 'agent-of-user-1',
    });
    await owned.orchestrator.onEventCreated(
      makeEvent({ eventType: EventType.DOC_UPDATED, resourceId: 'doc-1', payload: {} }),
    );
    expect(owned.provider.send).toHaveBeenCalledTimes(1);
  });

  it('三方拦截根因（回归门）：topic 参与者 ≠ board 读 / assignee ≠ board 读 / topic 参与者 ≠ space 读', async () => {
    // ① topic 参与者 ≠ board 读：候选在话题里活跃，但对那张看板没有 read
    const byTopic = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      boardProfile: profile({ visibility: 'private' }),
    });
    byTopic.topicParticipantRepo.find.mockResolvedValue([{ participantId: 'user-1' }]);
    await byTopic.orchestrator.onEventCreated(makeEvent({ id: 't1' }));
    expect(byTopic.provider.send).not.toHaveBeenCalled();

    // ② assignee ≠ board 读：被指派者一旦无权读该看板，同样不该收（注意力层不豁免安全层）
    const byAssignee = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      boardProfile: profile({ visibility: 'private' }),
    });
    byAssignee.taskRepo.findOne.mockResolvedValue({
      id: 'task-1',
      title: 't',
      assigneeId: 'user-1',
      list: { boardId: 'board-1' },
    });
    await byAssignee.orchestrator.onEventCreated(makeEvent({ id: 't2' }));
    expect(byAssignee.provider.send).not.toHaveBeenCalled();

    // ③ topic 参与者 ≠ space 读：话题活跃度与文档空间可见性是两件不相干的事
    const bySpace = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      spaceProfile: profile({ visibility: 'private' }),
    });
    bySpace.topicParticipantRepo.find.mockResolvedValue([{ participantId: 'user-1' }]);
    await bySpace.orchestrator.onEventCreated(
      makeEvent({ id: 't3', eventType: EventType.DOC_CREATED, resourceId: 'doc-1', payload: {} }),
    );
    expect(bySpace.provider.send).not.toHaveBeenCalled();
  });

  it('admin 降权即时生效：权限判据每个事件定向查询，**不进快照**', async () => {
    const h = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    // 第一次事件：admin/可读 ⇒ 投
    h.accessQuery.resolveBoardAccess.mockResolvedValueOnce(
      profile({ memberUserIds: new Set(['user-1']), readableUserIds: new Set(['user-1']) }),
    );
    await h.orchestrator.onEventCreated(makeEvent({ id: 'e1', resourceId: 'task-1' }));
    expect(h.provider.send).toHaveBeenCalledTimes(1);

    // 降权（role 变化 / 成员被移出）：**下一个事件立刻**按新剖面判——若权限进了 60s 快照，
    // 这里会继续投递（越权旁路）
    h.accessQuery.resolveBoardAccess.mockResolvedValueOnce(profile({ visibility: 'private' }));
    await h.orchestrator.onEventCreated(makeEvent({ id: 'e2', resourceId: 'task-2' }));
    expect(h.provider.send).toHaveBeenCalledTimes(1); // 仍是 1（第二条被拦）
    expect(h.accessQuery.resolveBoardAccess).toHaveBeenCalledTimes(2);
    // 快照只建了一次（权限不在快照里 ⇒ 它的变化不需要重建快照）
    expect(h.userRepo.findOne).toHaveBeenCalledTimes(1);
  });

  it('候选集合查询：INNER JOIN 到 actors + `actor.deleted_at IS NULL`（**不能用 find 的关系 where**）', async () => {
    const h = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    await h.orchestrator.resolveRecipients(makeEvent(), 'task_updated');
    const qb = h.channelRepo.createQueryBuilder.mock.results[0].value as {
      innerJoin: jest.Mock;
      where: jest.Mock;
      andWhere: jest.Mock;
      select: jest.Mock;
    };
    // ① **INNER** JOIN：实测 `find` 的关系 where 会把条件折进 LEFT JOIN 的 ON 子句，而
    //    `WHERE a.deleted_at IS NULL` 在"关系未命中"时同样成立（a.* 全 NULL）⇒ 软删用户照样
    //    是候选。INNER JOIN 让 ON 子句的过滤排他。
    expect(qb.innerJoin).toHaveBeenCalledWith('channel.user', 'user');
    expect(qb.innerJoin).toHaveBeenCalledWith('user.actor', 'actor');
    // ② 软删过滤显式写在 WHERE（不依赖 ORM 对 join 的软删默认行为）
    expect(qb.andWhere).toHaveBeenCalledWith('actor.deleted_at IS NULL');
    // ③ 谓词**单源**：直接展开 `deliveryEligibleWhere()`（与 `find` 内部用的是同一个对象），
    //    不在本文件手写第二份三元组
    expect(qb.where).toHaveBeenCalledWith(deliveryEligibleWhere());
  });

  it('类别偏好：用户关掉的类别不推（缺省基座 task_done+direct，显式覆盖按覆盖走）', async () => {
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      prefs: { 'user-1': { task_updated: false } },
    });
    // ① task_updated 被用户关掉 ⇒ 零推送
    await h.orchestrator.onEventCreated(makeEvent({ id: 'e1', resourceId: 'task-1' }));
    expect(h.provider.send).not.toHaveBeenCalled();
    // ② task_done 未被关 ⇒ 照推（证明上一条挡在偏好层，不是别的判据）
    await h.orchestrator.onEventCreated(
      makeEvent({
        id: 'e2',
        resourceId: 'task-2',
        payload: { toStatus: TaskStatus.DONE, fromStatus: TaskStatus.TODO },
      }),
    );
    expect(h.provider.send).toHaveBeenCalledTimes(1);
  });

  it('查询计数：路由查询数与候选人数**无关**（5 个候选仍是"候选 1 次 + 剖面 1 次"）', async () => {
    const candidateIds = ['u1', 'u2', 'u3', 'u4', 'u5'];
    const h = makeHarness(makeSettings(), [], { candidates: candidateIds });
    await h.orchestrator.resolveRecipients(makeEvent(), 'task_updated');

    // 候选集合 = **一条**查询（5 个候选不放大）
    expect(h.channelRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    // 资源剖面 = **一次**调用（内部 3 条固定查询；此处钉调用次数与入参形状）
    expect(h.accessQuery.resolveBoardAccess).toHaveBeenCalledTimes(1);
    expect(h.accessQuery.resolveBoardAccess).toHaveBeenCalledWith('board-1', candidateIds);
    // 冷路径的快照重建 = **每用户 4 条**（渠道 1 / 用户偏好 2——`User.actor` 是 eager 关系 /
    // agent 1，见 buildUserSnapshot 注释），与"事件数"无关；此处以 user 查询的**次数**做锚点
    expect(h.userRepo.findOne).toHaveBeenCalledTimes(5);
    // task 类别**不碰** topic 参与表与 space 剖面
    expect(h.topicParticipantRepo.find).not.toHaveBeenCalled();
    expect(h.accessQuery.resolveSpaceAccess).not.toHaveBeenCalled();
  });

  it('查询计数：topic 类别缓存命中 0 条、未命中 1 条（与候选人数无关）', async () => {
    const h = makeHarness(makeSettings(), [], { candidates: ['u1', 'u2', 'u3'] });
    const topicEvent = (id: string, msgId: string) =>
      makeEvent({
        id,
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: msgId,
        topicId: 'topic-1',
        actorId: 'someone-else',
        payload: { messageId: msgId, type: MessageType.CHAT },
      });
    await h.orchestrator.resolveRecipients(topicEvent('e1', 'm1'), 'topic');
    expect(h.topicParticipantRepo.find).toHaveBeenCalledTimes(1); // 未命中 1 条
    await h.orchestrator.resolveRecipients(topicEvent('e2', 'm2'), 'topic');
    expect(h.topicParticipantRepo.find).toHaveBeenCalledTimes(1); // 命中 0 条（不随候选数增长）
    // topic 路由**不**碰看板/空间剖面
    expect(h.accessQuery.resolveBoardAccess).not.toHaveBeenCalled();
    expect(h.accessQuery.resolveSpaceAccess).not.toHaveBeenCalled();
  });

  it('single-flight：冷缓存并发解析共享**同一次**重建（10 并发 ⇒ 每用户只建一次）', async () => {
    const h = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        h.orchestrator.resolveRecipients(
          makeEvent({ id: `e${index}`, resourceId: `task-${index}` }),
          'task_updated',
        ),
      ),
    );
    // 快照的三条查询各只发生一次（10 个并发事件共享同一个在途 promise）
    expect(h.userRepo.findOne).toHaveBeenCalledTimes(1);
    expect(h.agentRepo.find).toHaveBeenCalledTimes(1);
    // 快照的渠道读取（`find({where:{...predicate, userId}})`）只发生一次
    expect(
      h.channelRepo.find.mock.calls.filter(
        (call) => typeof (call[0] as { where?: { userId?: unknown } })?.where?.userId === 'string',
      ),
    ).toHaveLength(1);
  });

  it('single-flight：重建失败 ⇒ 该候选本事件跳过（WARN），**下一事件重新尝试**（finally 清位）', async () => {
    const h = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    h.userRepo.findOne.mockRejectedValueOnce(new Error('db down'));
    const first = await h.orchestrator.resolveRecipients(makeEvent({ id: 'e1' }), 'task_updated');
    expect(first).toEqual([]); // 该候选被跳过（不是"整条事件崩掉"）
    expect(h.warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to build the notification snapshot'),
    );

    // 下一次事件重新尝试：若在途表没在 finally 清位，这里会**继续**拿到那条失败结果（永久静默）
    const second = await h.orchestrator.resolveRecipients(makeEvent({ id: 'e2' }), 'task_updated');
    expect(second.map((recipient) => recipient.userId)).toEqual(['user-1']);
  });

  it('invalidateUser：绑定/偏好写路径的失效钩子生效（清快照 ⇒ 下一事件重建）', async () => {
    const h = makeHarness(makeSettings(), [], { candidates: ['user-1'] });
    await h.orchestrator.resolveRecipients(makeEvent({ id: 'e1' }), 'task_updated');
    expect(h.userRepo.findOne).toHaveBeenCalledTimes(1);
    h.orchestrator.invalidateUser('user-1');
    await h.orchestrator.resolveRecipients(makeEvent({ id: 'e2' }), 'task_updated');
    expect(h.userRepo.findOne).toHaveBeenCalledTimes(2);
  });

  it('MAJOR-1：**在途重建期间 invalidateUser ⇒ 落地不写缓存**（旧值不留 60-70s）', async () => {
    const h = makeHarness(makeSettings(), [], { candidates: ['user-1'] });

    // 门控：把**快照那一次**渠道查询卡住（`where.userId` 是字符串；候选查询走 QueryBuilder，
    // 不受影响），让第一次重建停在"在途"状态。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realFind = h.channelRepo.find.getMockImplementation() as (options: {
      where?: Record<string, unknown>;
    }) => Promise<unknown>;
    h.channelRepo.find.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
      if (typeof (options?.where ?? {}).userId === 'string') await gate;
      return realFind(options);
    });

    const first = h.orchestrator.resolveRecipients(makeEvent({ id: 'e1' }), 'task_updated');
    // 让第一次重建真的进入在途（`buildUserSnapshot` 的三条查询在 Promise.all 里同步发起；
    // resolveRecipients 前面还有一个 await ⇒ 走一个宏任务确保已经到那一步）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.userRepo.findOne).toHaveBeenCalledTimes(1);

    // 写路径此刻解绑 / 改偏好：缓存里**还没有**这个键（重建在途）⇒ 只删缓存键是 no-op，
    // 必须靠"在途摘牌 + 落地守卫"才拦得住这次陈旧写入（这就是 MAJOR-1 的时序）。
    h.orchestrator.invalidateUser('user-1');

    release();
    await first; // 那一份重建落地（读的是**写前**的事实，等待者仍拿到它——single-flight 语义）

    // 关键断言：它**没有**进缓存 ⇒ 下一次解析必须重新重建（再打一次 user 查询）。
    // 若落地守卫缺失，这里会**停在 1**（缓存命中，陈旧绑定事实被沿用 60-70s）。
    await h.orchestrator.resolveRecipients(makeEvent({ id: 'e2' }), 'task_updated');
    expect(h.userRepo.findOne).toHaveBeenCalledTimes(2);

    // 在途表也要回到空位（否则这一份会一直被复用；`finally` 的"是不是我这一份"判据同样生效）
    await h.orchestrator.resolveRecipients(makeEvent({ id: 'e3' }), 'task_updated');
    expect(h.userRepo.findOne).toHaveBeenCalledTimes(2);
  });

  it('返回形状（棒 B 接口）：收件人携带 userId + deliveryEligible channels + 我的 agentIds', async () => {
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1'],
      addresses: { 'user-1': 'ou_bound_address' },
      agentIds: { 'user-1': ['agent-of-user-1'] },
    });
    const recipients = await h.orchestrator.resolveRecipients(makeEvent(), 'task_updated');
    expect(recipients).toEqual([
      {
        userId: 'user-1',
        channels: [{ provider: 'feishu', recipientAddress: 'ou_bound_address' }],
        agentIds: new Set(['agent-of-user-1']),
      },
    ]);
  });

  // ── L1 节流 ────────────────────────────────────────────────────────────

  it('L1 命中：同任务第二条事件被跳过（打 INFO），不落库', async () => {
    const h = makeHarness();
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-1' }));
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-2' }));
    expect(h.provider.send).toHaveBeenCalledTimes(1);
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('suppressed [l1_throttle]'));
  });

  it('L1 键按资源分组（**不含类别**）：同任务的不同类别共享一个窗口', async () => {
    const h = makeHarness();
    // 同任务、不同类别（task_updated 与 task_assigned）**共用一个窗口**——plan §5 的字面语义是
    // "per-task 300s"。若按类别分段，`PATCH {assigneeId}` 这类同时产生两条事实的请求会双发。
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-1' }));
    await h.orchestrator.onEventCreated(
      makeEvent({
        id: 'evt-2',
        eventType: EventType.TASK_ASSIGNED,
        payload: { assigneeName: '甲' },
      }),
    );
    expect(h.provider.send).toHaveBeenCalledTimes(1); // 第二条被同一窗口压制
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('suppressed [l1_throttle]'));

    // 不同任务互不影响
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-3', resourceId: 'task-2' }));
    expect(h.provider.send).toHaveBeenCalledTimes(2);
  });

  it('L1 **检查前置、标记后置**：渲染失败（资源缺失）不占窗口', async () => {
    const h = makeHarness();
    h.taskRepo.findOne.mockResolvedValueOnce(null); // 幻影事件（资源已删）
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-1' }));
    expect(h.provider.send).not.toHaveBeenCalled();

    // 资源存在后同一任务的下一事件照常投递（证明上一条没占窗口）
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-2' }));
    expect(h.provider.send).toHaveBeenCalledTimes(1);
  });

  it('L1 键：topic 用 **topicId** 而非 messageId（resourceId 是消息 id，用它会永不命中）', async () => {
    const h = makeHarness(makeSettings(), [{ id: 'owner-actor', username: 'owner' }]);
    await h.orchestrator.resolveOwners();
    const msg = (id: string, msgId: string) =>
      makeEvent({
        id,
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: msgId,
        topicId: 'topic-1',
        actorId: 'someone-else',
        payload: { messageId: msgId, type: MessageType.CHAT },
      });

    // 同一话题的两条**不同消息**（resourceId 每次都是新 messageId）⇒ 只投一条
    await h.orchestrator.onEventCreated(msg('evt-1', 'msg-1'));
    await h.orchestrator.onEventCreated(msg('evt-2', 'msg-2'));
    expect(h.provider.send).toHaveBeenCalledTimes(1);
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('suppressed [l1_throttle]'));

    // 另一个话题不受影响（键里带的是 topicId）
    await h.orchestrator.onEventCreated({ ...msg('evt-3', 'msg-3'), topicId: 'topic-2' } as Event);
    expect(h.provider.send).toHaveBeenCalledTimes(2);
  });

  // ── L2 全局窗口 ───────────────────────────────────────────────────────

  it('L2 超额合并为一条摘要（含类别分布），**窗口内 ≤1 条**且**不占额度**', async () => {
    const h = makeHarness(makeSettings({ globalRateLimit: 2 }));
    const taskEvent = (index: number) =>
      makeEvent({
        id: `evt-${index}`,
        resourceId: `task-${index}`,
        payload: { taskId: `task-${index}` },
      });

    // ⚠️ 用 `mockImplementation`（**按 id 派生**）而不是 `mockResolvedValueOnce` 队列：
    //    二期批 2 起**路由与渲染都读同一张 task 表**（路由要靠 `list.boardId` 找看板），
    //    一次性队列会被路由那一次吃掉、把行错位给下一个事件（假绿/假红源）。`list` 必须给。
    h.taskRepo.findOne.mockImplementation(async (options: { where?: { id?: string } }) => ({
      id: options?.where?.id ?? 'task-1',
      title: '任务',
      assigneeId: null,
      list: { boardId: 'board-1' },
    }));
    for (let index = 1; index <= 4; index += 1) {
      await h.orchestrator.onEventCreated(taskEvent(index));
    }

    // 2 条直发 + 1 条摘要（第 3 条超额时**事件触发**立即发出）= 3 次投递；
    // 第 4 条只记账（本窗口摘要已发过 ⇒ 不再发，由窗口结束的定时兜底带走）
    expect(h.provider.send).toHaveBeenCalledTimes(3);
    const digest = h.provider.send.mock.calls[2][0];
    expect(digest.category).toBe(DIGEST_DELIVERY_CATEGORY);
    expect(digest.body).toContain('另有 1 条通知');
    expect(digest.body).toContain('task_updated×1');
    // 根链接（摘要聚合多个资源，指向 web 基址本身）
    expect(digest.link).toBe('https://platform.example.com');
    // 摘要不占额度：额度用满后仍有直发（窗口内 delivered 计数不被摘要改写）
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(3);
  });

  it('L2 摘要正文受 100 字符上限约束（出境面宽度契约）', async () => {
    const h = makeHarness(makeSettings({ globalRateLimit: 1 }));
    // 5 个不同类别各超额一条（**DOC_DELETED 不回库**，故它的载荷自带 path/title）
    const rows: Array<[EventType, Record<string, unknown>, string]> = [
      [EventType.TASK_UPDATE, { action: 'updated' }, 'task-1'],
      [EventType.TASK_ASSIGNED, { assigneeName: '甲' }, 'task-2'],
      [EventType.DOC_CREATED, {}, 'doc-1'],
      [EventType.DOC_DELETED, { path: 'docs/gone.md', title: 'gone' }, 'doc-2'],
      [EventType.DOC_MOVED, {}, 'doc-3'],
    ];
    // 同上一用例：按 id 派生（路由与渲染共用同一张表），不做一次性队列
    h.taskRepo.findOne.mockImplementation(async (options: { where?: { id?: string } }) => ({
      id: options?.where?.id ?? 'task-1',
      title: 't',
      assigneeId: null,
      list: { boardId: 'board-1' },
    }));
    h.docRepo.findOne.mockImplementation(async (options: { where?: { id?: string } }) => ({
      id: options?.where?.id ?? 'doc-1',
      path: 'docs/x.md',
      title: 'd',
      spaceId: 'space-1',
      createdBy: 'agent-creator',
    }));
    for (const [eventType, payload, resourceId] of rows) {
      await h.orchestrator.onEventCreated(
        makeEvent({ id: `evt-${resourceId}`, eventType, resourceId, payload }),
      );
    }
    const digests = h.provider.send.mock.calls
      .map((call) => call[0])
      .filter((sent) => sent.category === DIGEST_DELIVERY_CATEGORY);
    expect(digests.length).toBeGreaterThan(0);
    for (const digest of digests) {
      expect(digest.body.length).toBeLessThanOrEqual(100);
      expect(digest.title).toBe('[通知汇总]');
    }
  });

  it('L2 定时兜底：窗口结束时把剩余记账强制 flush 成摘要', async () => {
    jest.useFakeTimers();
    try {
      // 本用例只测定时兜底：owner 名单给一个（播种判据命中 already_seeded ⇒ 不抛、不写库），
      // 收件人保持配置态（事件链路要靠它投递）
      const h = makeHarness(makeSettings({ globalRateLimit: 2, globalRateWindowSeconds: 60 }), [
        { id: 'owner-actor', username: 'owner' },
      ]);
      await h.orchestrator.onModuleInit();
      h.taskRepo.findOne.mockImplementation(async (options: { where?: { id?: string } }) => ({
        id: options?.where?.id ?? 'task-1',
        title: '任务',
        assigneeId: null,
        list: { boardId: 'board-1' },
      }));
      for (let index = 1; index <= 4; index += 1) {
        await h.orchestrator.onEventCreated(
          makeEvent({
            id: `evt-${index}`,
            resourceId: `task-${index}`,
            payload: { taskId: `task-${index}` },
          }),
        );
      }
      expect(h.provider.send).toHaveBeenCalledTimes(3); // 2 直发 + 1 即时摘要

      // 越过窗口 ⇒ 定时兜底把第 4 条的记账 flush 出去
      await jest.advanceTimersByTimeAsync(L2_SWEEP_INTERVAL_MS + 1_000);
      expect(h.provider.send).toHaveBeenCalledTimes(4);
      const deferred = h.provider.send.mock.calls[3][0];
      expect(deferred.category).toBe(DIGEST_DELIVERY_CATEGORY);
      expect(deferred.body).toContain('另有 1 条通知');

      // 兜底之后再越过一个窗口：无剩余记账 ⇒ 不再发（不重复打扰）
      await jest.advanceTimersByTimeAsync(L2_SWEEP_INTERVAL_MS * 2);
      expect(h.provider.send).toHaveBeenCalledTimes(4);
      h.orchestrator.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('总开关关闭 ⇒ onModuleInit **不起定时器**、不读库（句柄不留、进程可退出）', async () => {
    jest.useFakeTimers();
    try {
      const h = makeHarness(makeSettings({ enabled: false }));
      await h.orchestrator.onModuleInit();
      expect(h.userRepo.createQueryBuilder).not.toHaveBeenCalled();
      // 强断言（不是"没看见副作用"）：定时器计数必须真的是 0
      expect(jest.getTimerCount()).toBe(0);

      // 对照组：开启时会起**恰好一个**兜底扫描定时器（证明上一条不是恒真）。
      // feishuRecipientOpenId 置空 = 跳过 D4 播种（本用例不测播种，播种另需唯一 owner）
      const on = makeHarness(
        makeSettings({ globalRateWindowSeconds: 60, feishuRecipientOpenId: null }),
      );
      await on.orchestrator.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);
      on.orchestrator.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // ── S4 直发链路的复用面（收件人解析 / L2 占额 / provider 兜底） ──

  it('reserveL2ForDirect：额度内占额放行；耗尽只回剩余秒数', () => {
    const h = makeHarness(makeSettings({ globalRateLimit: 2, globalRateWindowSeconds: 600 }));

    // 窗口维度 = **收件人用户 id**（批 2 棒 B；不再是投递地址）
    expect(h.orchestrator.reserveL2ForDirect('user-1')).toEqual({ allowed: true });
    expect(h.orchestrator.reserveL2ForDirect('user-1')).toEqual({ allowed: true });
    // 第 3 次：未占额，回窗口剩余（刚开窗 ⇒ 整整 600s）
    expect(h.orchestrator.reserveL2ForDirect('user-1')).toEqual({
      allowed: false,
      retryAfterSeconds: 600,
    });
  });

  it('reserveL2ForDirect：换一个人就是**另一个窗口**（键 = userId，不是地址）', () => {
    const h = makeHarness(makeSettings({ globalRateLimit: 1, globalRateWindowSeconds: 600 }));

    expect(h.orchestrator.reserveL2ForDirect('user-1')).toEqual({ allowed: true });
    // user-2 的额度不受 user-1 影响
    expect(h.orchestrator.reserveL2ForDirect('user-2')).toEqual({ allowed: true });
    expect(h.orchestrator.reserveL2ForDirect('user-1').allowed).toBe(false);
  });

  it('reserveL2ForDirect：与事件链路**共用同一份窗口账**（直发占满 ⇒ 事件被压成摘要）', async () => {
    const h = makeHarness(makeSettings({ globalRateLimit: 1 }));

    h.orchestrator.reserveL2ForDirect('user-1'); // 直发吃掉唯一位额（键 = 事件链路的收件人 userId）
    await h.orchestrator.onEventCreated(makeEvent());

    // 事件没有直投（provider 只被摘要调用一次）——两条链路的放行数相加不得超过上限
    expect(h.provider.send).toHaveBeenCalledTimes(1);
    expect(h.provider.send.mock.calls[0][0].category).toBe(DIGEST_DELIVERY_CATEGORY);
  });

  it('reserveL2ForDirect 耗尽时**不产生摘要计数**（直发永不被合并改写）', async () => {
    const h = makeHarness(makeSettings({ globalRateLimit: 1 }));

    h.orchestrator.reserveL2ForDirect('user-1'); // 占满
    h.orchestrator.reserveL2ForDirect('user-1'); // 耗尽：**不入摘要**
    await h.orchestrator.onEventCreated(makeEvent()); // 只有这条事件该进摘要

    const digest = h.provider.send.mock.calls[0][0];
    expect(digest.body).toContain('task_updated×1');
    // 若直发那次耗尽被记成"被压制"，摘要里会出现 direct×1——调用方拿到 200 却没人收到那条消息
    expect(digest.body).not.toContain('direct');
  });

  it('resolveDirectTarget：有 deliveryEligible 绑定 ⇒ 回主投递渠道（地址与 L2 同源）', async () => {
    const h = makeHarness(makeSettings(), [], { addresses: { 'user-1': 'ou_direct_target' } });

    expect(await h.orchestrator.resolveDirectTarget('user-1')).toEqual({
      provider: 'feishu',
      recipientAddress: 'ou_direct_target',
    });
  });

  it('resolveDirectTarget：该用户**没有任何 deliveryEligible 绑定** ⇒ null（直发落 `recipient_not_bound`）', async () => {
    // 候选集合里没有这个 userId ⇒ 快照重建时渠道查询为空 ⇒ 抛 NotifyNoEligibleChannelError
    const h = makeHarness(makeSettings(), [], { candidates: ['someone-else'] });

    expect(await h.orchestrator.resolveDirectTarget('user-1')).toBeNull();
  });

  it('resolveDirectTarget：**库故障必须冒泡**（不能被说成"没绑渠道"）', async () => {
    const h = makeHarness();
    // 非"无绑定"的失败（连接池耗尽 / 库抖动）——把这类降级成 recipient_not_bound 会把一次
    // 运维故障伪装成用户的持久状态（最难排的一类假象），故必须原样抛出
    h.channelRepo.find.mockRejectedValue(new Error('connection pool exhausted'));

    await expect(h.orchestrator.resolveDirectTarget('user-1')).rejects.toThrow(
      'connection pool exhausted',
    );
  });

  // ── 批 2 棒 B：泛化（L1 逐用户 / 总闸接线 / flush 前重判） ──────────────

  it('L1 逐用户窗口：**同一资源、两个收件人各有独立窗口**（共享键会把后到的人整体压掉）', async () => {
    const h = makeHarness(makeSettings(), [], {
      candidates: ['user-1', 'user-2'],
      addresses: { 'user-1': 'ou_a', 'user-2': 'ou_b' },
    });

    // 第一条事件：两个人都该收到（棒 A 之前的实现里，第二个人的窗口会被第一个人吃掉）
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-1' }));
    expect(h.provider.send).toHaveBeenCalledTimes(2);
    expect(h.provider.send.mock.calls.map((call) => call[0].recipient).sort()).toEqual([
      'ou_a',
      'ou_b',
    ]);

    // 同资源再来一条：**两个人的窗口都已占** ⇒ 一人一条命中日志（键里带 userId）
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-2' }));
    expect(h.provider.send).toHaveBeenCalledTimes(2);
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('recipient=user-1'));
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('recipient=user-2'));
  });

  it('投递归属：编排器 deliver 落 `recipientUserId`（四路径之一；摘要落窗口的用户）', async () => {
    const h = makeHarness(makeSettings({ globalRateLimit: 1 }));
    h.taskRepo.findOne.mockImplementation(async (options: { where?: { id?: string } }) => ({
      id: options?.where?.id ?? 'task-1',
      title: '任务',
      assigneeId: null,
      list: { boardId: 'board-1' },
    }));

    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-1', resourceId: 'task-1' }));
    expect(h.deliveryRepo.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipientUserId: 'user-1' }),
    );

    // 第 2 条超额 ⇒ 摘要（flush 是 fire-and-forget ⇒ 等一拍再读落库调用）。
    // 摘要那条也必须带归属（否则 admin 按人过滤会漏掉"汇总"这一类行）。
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-2', resourceId: 'task-2' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const digestCall = h.deliveryRepo.record.mock.calls
      .map((call) => call[0] as { category: string; recipientUserId: string | null })
      .find((row) => row.category === DIGEST_DELIVERY_CATEGORY);
    expect(digestCall).toMatchObject({
      category: DIGEST_DELIVERY_CATEGORY,
      recipientUserId: 'user-1',
    });
  });

  it('总闸接线：超额候选丢弃 ⇒ **计入该用户 suppressed**（摘要可见）+ INFO 带 eventId；摘要自身豁免总闸', async () => {
    jest.useFakeTimers();
    try {
      // 总闸只放 1 条；L2 放大（本用例的主语是总闸，不是 L2 合并）
      const h = makeHarness(
        makeSettings({
          platformRateLimit: 1,
          platformRateWindowSeconds: 600,
          globalRateLimit: 10,
          globalRateWindowSeconds: 60,
          feishuRecipientOpenId: null,
        }),
      );
      await h.orchestrator.onModuleInit();
      h.taskRepo.findOne.mockImplementation(async (options: { where?: { id?: string } }) => ({
        id: options?.where?.id ?? 'task-1',
        title: '任务',
        assigneeId: null,
        list: { boardId: 'board-1' },
      }));

      await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-1', resourceId: 'task-1' }));
      await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-2', resourceId: 'task-2' }));

      // 第 2 条没投出去（总闸只放了一条），且**不是静默丢弃**：
      expect(h.provider.send).toHaveBeenCalledTimes(1);
      expect(h.logSpy).toHaveBeenCalledWith(
        expect.stringContaining('dropped [platform_gate] category=task_updated eventId=evt-2'),
      );

      // 丢弃计入了该用户的 suppressed ⇒ 窗口结束时以摘要的形式补偿给他（**摘要豁免总闸**：
      // 它是总闸丢弃的补偿信号，若也过闸就永远报不出来）
      await jest.advanceTimersByTimeAsync(L2_SWEEP_INTERVAL_MS + 1_000);
      expect(h.provider.send).toHaveBeenCalledTimes(2);
      const digest = h.provider.send.mock.calls[1][0];
      expect(digest.category).toBe(DIGEST_DELIVERY_CATEGORY);
      expect(digest.body).toContain('另有 1 条通知');
      expect(digest.body).toContain('task_updated×1');

      h.orchestrator.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('总闸丢弃的 WARN **按窗口限频**（一个刷屏窗口只报一行，避免日志被冲垮）', async () => {
    const h = makeHarness(
      makeSettings({ platformRateLimit: 1, platformRateWindowSeconds: 600, globalRateLimit: 500 }),
    );
    h.taskRepo.findOne.mockImplementation(async (options: { where?: { id?: string } }) => ({
      id: options?.where?.id ?? 'task-1',
      title: '任务',
      assigneeId: null,
      list: { boardId: 'board-1' },
    }));

    for (let index = 1; index <= 4; index += 1) {
      await h.orchestrator.onEventCreated(
        makeEvent({ id: `evt-${index}`, resourceId: `task-${index}` }),
      );
    }

    // 1 条放行 + 3 条被总闸丢弃，但 WARN **只有一行**（逐条证据由 INFO 承担）
    expect(h.provider.send).toHaveBeenCalledTimes(1);
    const gateWarns = h.warnSpy.mock.calls.filter(([message]) =>
      String(message).includes('egress gate is DROPPING'),
    );
    expect(gateWarns).toHaveLength(1);
    expect(String(gateWarns[0][0])).toContain('1 candidate(s)');
    expect(
      h.logSpy.mock.calls.filter(([message]) =>
        String(message).includes('dropped [platform_gate]'),
      ),
    ).toHaveLength(3);
  });

  it('flush 前重判 deliveryEligible：缓冲期间**解绑** ⇒ 摘要丢弃 + INFO（"解绑 = 通知立即停止"）', async () => {
    jest.useFakeTimers();
    try {
      const h = makeHarness(
        makeSettings({
          globalRateLimit: 1,
          globalRateWindowSeconds: 60,
          feishuRecipientOpenId: null,
        }),
      );
      await h.orchestrator.onModuleInit();
      h.taskRepo.findOne.mockImplementation(async (options: { where?: { id?: string } }) => ({
        id: options?.where?.id ?? 'task-1',
        title: '任务',
        assigneeId: null,
        list: { boardId: 'board-1' },
      }));

      // ① 第 1 条直投（占满额度）；② 第 2 条超额 ⇒ 即时摘要（此后 summarySent=true 不再即时 flush）；
      // ③ 第 3 条只记账，等窗口结束的定时兜底
      await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-1', resourceId: 'task-1' }));
      await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-2', resourceId: 'task-2' }));
      await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-3', resourceId: 'task-3' }));
      expect(h.provider.send).toHaveBeenCalledTimes(2);

      // 缓冲与 flush 之间用户解绑：**走生产同款的两步**——① 渠道行的查询对这个人返回空
      // （快照重建时会抛"无合格绑定"）；② 写路径的 `invalidateUser`（`deleteChannel` 就是
      // 这么做的）把已经缓存的快照清掉。少了 ② 的话 flush 会命中 60s 内的旧快照——
      // 那是**已知且显式接受的 TTL 残留**，不是这条用例要测的东西。
      h.channelRepo.find.mockImplementation(
        async (options: { where?: Record<string, unknown> }) => {
          const userId = (options?.where ?? {}).userId;
          return typeof userId === 'string' ? [] : [];
        },
      );
      h.orchestrator.invalidateUser('user-1');

      await jest.advanceTimersByTimeAsync(L2_SWEEP_INTERVAL_MS + 1_000);

      // 摘要**没有**投出去（这正是 V6：不重判就会给"解绑立即停止"留一条时间缝）
      expect(h.provider.send).toHaveBeenCalledTimes(2);
      expect(h.logSpy).toHaveBeenCalledWith(
        expect.stringContaining('digest dropped [recipient_unbound]'),
      );

      h.orchestrator.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('sendThroughProvider：预算参数透传给叶子（直发 ≤2 次 / ≤10s 的落地点）', async () => {
    const h = makeHarness();

    await h.orchestrator.sendThroughProvider(
      h.provider,
      { category: 'direct', eventId: null, title: 't', body: 'b', link: null, recipient: 'ou' },
      { maxAttempts: 2, budgetMs: 10_000 },
    );

    expect(h.provider.send).toHaveBeenCalledWith(expect.objectContaining({ category: 'direct' }), {
      maxAttempts: 2,
      budgetMs: 10_000,
    });
  });

  it('二期：direct 开 ∧ agent creator 无 deliveryEligible 绑定 ⇒ 启动打一行 warn（数量+名单截断）', async () => {
    // recipient 置空 = 跳过 D4 播种（本用例只测启动预警；播种另有自己的用例）
    const h = makeHarness(
      makeSettings({ categories: [NOTIFY_CATEGORY.DIRECT], feishuRecipientOpenId: null }),
    );
    h.agentRepo.find.mockResolvedValue([
      { ownerId: 'owner-a' },
      { ownerId: 'owner-b' },
      { ownerId: null },
    ]);
    h.channelRepo.find.mockResolvedValue([]); // 无任何 deliveryEligible 绑定
    h.userRepo.find.mockResolvedValue([
      { id: 'owner-a', username: 'alice', displayName: 'Alice' },
      { id: 'owner-b', username: 'bob', displayName: null },
    ] as never);

    await h.orchestrator.onModuleInit();
    h.orchestrator.onModuleDestroy();

    const warned = h.warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    // 数量（2 个 creator，null ownerId 被过滤）+ 名单（displayName 优先、退 username）
    expect(warned).toContain('2 agent creator(s) have no delivery-eligible channel binding');
    expect(warned).toContain('Alice, bob');
  });

  it('二期：direct 关着 / 全部 creator 都有绑定 ⇒ 不打这条 warn（锚点不该常态刷屏）', async () => {
    const off = makeHarness(makeSettings({ categories: [NOTIFY_CATEGORY.TASK_DONE] }));
    await off.orchestrator.onModuleInit();
    off.orchestrator.onModuleDestroy();
    expect(off.warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('have no delivery-eligible channel binding'),
    );

    const withBinding = makeHarness(
      makeSettings({ categories: [NOTIFY_CATEGORY.DIRECT], feishuRecipientOpenId: null }),
    );
    withBinding.agentRepo.find.mockResolvedValue([{ ownerId: 'owner-a' }]);
    withBinding.channelRepo.find.mockResolvedValue([{ userId: 'owner-a' }] as never);
    await withBinding.orchestrator.onModuleInit();
    withBinding.orchestrator.onModuleDestroy();
    expect(withBinding.warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('have no delivery-eligible channel binding'),
    );
  });

  // ── 渲染 / 投递（v2：出境面含归属信息）────────────────────────────────────

  it('渲染：标题带类别前缀、深链 = 基址 + 资源路径、eventId/recipient 透传', async () => {
    const h = makeHarness();
    await h.orchestrator.onEventCreated(
      makeEvent({
        eventType: EventType.TASK_UPDATE,
        payload: { toStatus: 'done', fromStatus: 'in_progress' },
      }),
    );
    const sent = h.provider.send.mock.calls[0][0];
    expect(sent.category).toBe('task_done');
    expect(sent.title).toBe('[完工] 任务标题');
    expect(sent.link).toBe('https://platform.example.com/tasks/task-1');
    expect(sent.eventId).toBe('evt-1');
    expect(sent.recipient).toBe('ou_test_recipient');
  });

  it('渲染 v2：task 四类别正文 = 「看板「<看板名>」 · <操作者>」（title 前缀逻辑不变）', async () => {
    const h = makeHarness();
    // [事件类型, 载荷, 期望类别, 期望 title, 期望 body]
    const cases: Array<[EventType, Record<string, unknown>, string, string, string]> = [
      [
        EventType.TASK_UPDATE,
        { toStatus: 'done', fromStatus: 'in_progress' },
        NOTIFY_CATEGORY.TASK_DONE,
        '[完工] 任务标题',
        '看板「合成看板」 · name-actor-trigger',
      ],
      [
        EventType.TASK_UPDATE,
        { action: 'created' },
        NOTIFY_CATEGORY.TASK_CREATED,
        '[新任务] 任务标题',
        '看板「合成看板」 · name-actor-trigger',
      ],
      [
        EventType.TASK_UPDATE,
        { action: 'updated' },
        NOTIFY_CATEGORY.TASK_UPDATED,
        '[任务更新] 任务标题',
        '看板「合成看板」 · name-actor-trigger',
      ],
      [
        EventType.TASK_ASSIGNED,
        { assigneeName: '甲' },
        NOTIFY_CATEGORY.TASK_ASSIGNED,
        '[指派] 任务标题',
        '看板「合成看板」 · name-actor-trigger → 指派给 甲',
      ],
    ];

    for (const [index, [eventType, payload, category, title, body]] of cases.entries()) {
      await h.orchestrator.onEventCreated(
        makeEvent({ id: `evt-${index}`, resourceId: `task-${index}`, eventType, payload }),
      );
      const sent = h.provider.send.mock.calls[index][0];
      expect(sent.category).toBe(category);
      expect(sent.title).toBe(title);
      expect(sent.body).toBe(body);
    }
    expect(h.provider.send).toHaveBeenCalledTimes(4);
  });

  it('渲染 v2 兜底：boardId 缺键 / board 行缺失 ⇒ 看板「?」，**通知照发不丢**', async () => {
    const h = makeHarness();

    // ① boardId 是可省键（task.service 拿不到就省）⇒ null 是常态，且**不该白跑一次查询**
    await h.orchestrator.onEventCreated(
      makeEvent({ id: 'evt-no-board', resourceId: 'task-no-board', boardId: null }),
    );
    expect(h.provider.send.mock.calls[0][0].body).toBe('看板「?」 · name-actor-trigger');
    expect(h.boardRepo.findOne).not.toHaveBeenCalled();

    // ② board 行缺失（软删 / 幻影 id）⇒ 同样降级，**不丢弃**
    h.boardRepo.findOne.mockResolvedValue(null);
    await h.orchestrator.onEventCreated(
      makeEvent({ id: 'evt-missing-board', resourceId: 'task-missing-board' }),
    );
    expect(h.provider.send.mock.calls[1][0].body).toBe('看板「?」 · name-actor-trigger');
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(2);
  });

  it('渲染 v2 兜底：actorId 缺失 / 真孤儿（actors 表无行）⇒ 名字 `?`，通知照发', async () => {
    const h = makeHarness();

    // ① 事件行没有 actor（Event.actorId 可空）
    await h.orchestrator.onEventCreated(
      makeEvent({ id: 'evt-no-actor', resourceId: 'task-no-actor', actorId: null }),
    );
    expect(h.provider.send.mock.calls[0][0].body).toBe('看板「合成看板」 · ?');

    // ② 真孤儿：ActorProfileService R12 不写进 Map ⇒ 消费方兜底（**不发明 'Unknown' 名**）
    h.actorProfiles.resolveProfiles.mockResolvedValue(new Map());
    await h.orchestrator.onEventCreated(
      makeEvent({ id: 'evt-orphan', resourceId: 'task-orphan', actorId: 'ghost' }),
    );
    expect(h.provider.send.mock.calls[1][0].body).toBe('看板「合成看板」 · ?');
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(2);
  });

  it('渲染 v2：task_assigned 载荷缺 assigneeName ⇒ 后缀退化为统一兜底 `?`（不崩）', async () => {
    const h = makeHarness();
    await h.orchestrator.onEventCreated(
      makeEvent({ eventType: EventType.TASK_ASSIGNED, payload: {} }),
    );
    expect(h.provider.send.mock.calls[0][0].body).toBe(
      '看板「合成看板」 · name-actor-trigger → 指派给 ?',
    );
  });

  it('渲染 v2 宽度分层：task/doc 正文上限 200（归属完整优先），超长才截断', async () => {
    const h = makeHarness();

    // ① 200 以内 ⇒ 归属信息**整段完整**（100 时代这里必被截掉尾巴）
    h.boardRepo.findOne.mockResolvedValue({ id: 'board-1', name: 'B'.repeat(60) });
    await h.orchestrator.onEventCreated(
      makeEvent({
        id: 'evt-assign-full',
        resourceId: 'task-assign-full',
        eventType: EventType.TASK_ASSIGNED,
        payload: { assigneeName: 'A'.repeat(40) },
      }),
    );
    const full = h.provider.send.mock.calls[0][0].body;
    // 40 字被指派人名在 50 字的载荷截断线以内 ⇒ 整串逐字完整（无任何截断）
    expect(full).toBe(`看板「${'B'.repeat(60)}」 · name-actor-trigger → 指派给 ${'A'.repeat(40)}`);
    expect(full.length).toBeGreaterThan(NOTIFICATION_SUMMARY_MAX_LENGTH); // 已超过 topic 的 100
    expect(full.length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX_LENGTH);

    // ② 超过 200 ⇒ 仍截断到 200（上限拦得住超长看板名）
    h.boardRepo.findOne.mockResolvedValue({ id: 'board-1', name: 'B'.repeat(300) });
    await h.orchestrator.onEventCreated(
      makeEvent({
        id: 'evt-assign-cut',
        resourceId: 'task-assign-cut',
        eventType: EventType.TASK_ASSIGNED,
        payload: { assigneeName: 'A'.repeat(40) },
      }),
    );
    const cut = h.provider.send.mock.calls[1][0].body;
    expect(cut).toHaveLength(NOTIFICATION_BODY_MAX_LENGTH);
    // 截断确实发生（不是名字被换短）：200 = `看板「`(3) + 197 个 B
    expect(cut).toBe(`看板「${'B'.repeat(197)}`);
    expect(cut).not.toContain('指派给');

    // ③ doc 家族同用 200：空间名 + 150 字标题仍完整（超过 100 但未到 200）
    h.docRepo.findOne.mockResolvedValue({
      id: 'doc-long',
      path: 'docs/long.md',
      title: 'T'.repeat(150),
      spaceId: 'space-1',
    });
    await h.orchestrator.onEventCreated(
      makeEvent({ id: 'evt-doc-long', eventType: EventType.DOC_UPDATED, resourceId: 'doc-long' }),
    );
    const docBody = h.provider.send.mock.calls[2][0].body;
    expect(docBody).toBe(`空间「合成空间」 · ${'T'.repeat(150)}`);
    expect(docBody.length).toBeGreaterThan(NOTIFICATION_SUMMARY_MAX_LENGTH);

    // ④ topic 仍守 100（**预览**语义刻意保持短）——见上方「渲染 v2：话题正文」用例
    expect(NOTIFICATION_SUMMARY_MAX_LENGTH).toBe(100);
    expect(NOTIFICATION_BODY_MAX_LENGTH).toBe(200);
  });

  it('渲染 v2：话题正文 = 「<发言人>：<摘要>」且 100 字符上限作用于**整条正文**', async () => {
    const h = makeHarness(makeSettings({ categories: ['topic'] }), [
      { id: 'owner-actor', username: 'owner' },
    ]);
    await h.orchestrator.resolveOwners();
    h.messageRepo.findOne.mockResolvedValue({
      id: 'msg-1',
      content: 'x'.repeat(300),
      senderId: 'sender-1',
    });
    await h.orchestrator.onEventCreated(
      makeEvent({
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: 'msg-1',
        topicId: 'topic-1',
        actorId: 'someone-else',
        payload: { type: MessageType.CHAT },
      }),
    );
    const sent = h.provider.send.mock.calls[0][0];
    expect(sent.title).toBe('[话题] 话题名');
    expect(sent.body).toHaveLength(100); // topic = 预览层：含发言人前缀在内仍是 100（task/doc 走 200）
    expect(sent.body.startsWith('name-sender-1：')).toBe(true);
    expect(sent.link).toBe('https://platform.example.com/topics/topic-1');
  });

  it('渲染 v2 兜底：发言人解析不到（senderId 缺失 / 真孤儿）⇒ `<?>：<摘要>`，通知照发', async () => {
    const h = makeHarness(makeSettings({ categories: ['topic'] }), [
      { id: 'owner-actor', username: 'owner' },
    ]);
    await h.orchestrator.resolveOwners();

    const topicEvent = (id: string, msgId: string) =>
      makeEvent({
        id,
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: msgId,
        topicId: 'topic-1',
        actorId: 'someone-else',
        payload: { type: MessageType.CHAT },
      });

    // ⚠️ 同一 topicId ⇒ L1 会压掉第二条，故用两个话题（键里带的是 topicId）
    h.messageRepo.findOne.mockResolvedValue({ id: 'msg-1', content: '正文', senderId: null });
    await h.orchestrator.onEventCreated(topicEvent('evt-t1', 'msg-1'));
    expect(h.provider.send.mock.calls[0][0].body).toBe('?：正文');

    h.messageRepo.findOne.mockResolvedValue({ id: 'msg-2', content: '正文', senderId: 'ghost' });
    h.actorProfiles.resolveProfiles.mockResolvedValue(new Map());
    await h.orchestrator.onEventCreated({
      ...topicEvent('evt-t2', 'msg-2'),
      topicId: 'topic-2',
    } as Event);
    expect(h.provider.send.mock.calls[1][0].body).toBe('?：正文');
  });

  it('渲染：未配深链基址 ⇒ link 为 null（不伪造相对链接）', async () => {
    const h = makeHarness(makeSettings({ webBaseUrl: null }));
    await h.orchestrator.onEventCreated(makeEvent());
    expect(h.provider.send.mock.calls[0][0].link).toBeNull();
  });

  it('DOC_UPDATED 纯重切（rechunked=true）⇒ 连查库都不查', async () => {
    const h = makeHarness();
    await h.orchestrator.onEventCreated(
      makeEvent({ eventType: EventType.DOC_UPDATED, payload: { rechunked: true } }),
    );
    expect(h.docRepo.findOne).not.toHaveBeenCalled();
    expect(h.provider.send).not.toHaveBeenCalled();
  });

  it('渲染 v2：doc 正文 = 「空间「<空间名>」 · <标题>」（spaceId 取自 doc 行）', async () => {
    const h = makeHarness();
    await h.orchestrator.onEventCreated(
      makeEvent({ eventType: EventType.DOC_UPDATED, resourceId: 'doc-1', payload: {} }),
    );
    const sent = h.provider.send.mock.calls[0][0];
    expect(sent.title).toBe('[文档更新] docs/a.md');
    expect(sent.body).toBe('空间「合成空间」 · 文档标题');
    // ⚠️ `withDeleted: true` 是**契约的一部分**（不是实现细节）：整空间删除时 space 行已被
    //    软删，不带它 `findOne` 恒 null ⇒ 空间名全数退化成 `?`（先例 A1）。
    expect(h.docSpaceRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'space-1' },
      withDeleted: true,
    });
  });

  it('渲染 v2 兜底：DocSpace 行缺失 ⇒ 空间「?」，doc 通知照发', async () => {
    const h = makeHarness();
    h.docSpaceRepo.findOne.mockResolvedValue(null);
    await h.orchestrator.onEventCreated(
      makeEvent({ eventType: EventType.DOC_CREATED, resourceId: 'doc-1', payload: {} }),
    );
    const sent = h.provider.send.mock.calls[0][0];
    expect(sent.title).toBe('[新文档] docs/a.md');
    expect(sent.body).toBe('空间「?」 · 文档标题');
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
  });

  it('DOC_DELETED **不回库**：doc 行已软删（findOne 恒 null）仍必须投递，正文来自事件载荷', async () => {
    const h = makeHarness();
    // 复刻真实时序：doc.service 先软删、后发事件。**二期批 2 起路由确实会读一次 doc 行**
    // （`withDeleted: true` —— 软删行仍在，取它的 `spaceId` / `createdBy` 做权限与归属判据）；
    // 渲染层**依然不回库**（这正是本用例守的 P0 死路：渲染若回库、又没带 withDeleted，恒 null
    // ⇒ 整条通知静默丢弃）。故这里模拟"只有带 withDeleted 的查询才能拿到行"。
    h.docRepo.findOne.mockImplementation((options: { withDeleted?: boolean }) =>
      Promise.resolve(
        options?.withDeleted === true
          ? { id: 'doc-1', spaceId: 'space-1', createdBy: 'agent-creator', path: 'docs/gone.md' }
          : null,
      ),
    );
    await h.orchestrator.onEventCreated(
      makeEvent({
        eventType: EventType.DOC_DELETED,
        resourceId: 'doc-1',
        payload: {
          spaceId: 'space-1',
          docId: 'doc-1',
          path: 'docs/gone.md',
          title: '即将消失的文档',
        },
      }),
    );
    // 关键断言：**全程只查一次、且必带 withDeleted** —— 那一次是路由的权限判据；
    // 渲染层若自己再查一次（不带 withDeleted ⇒ 恒 null ⇒ 静默丢弃），本断言立刻红。
    expect(h.docRepo.findOne).toHaveBeenCalledTimes(1);
    expect(h.docRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'doc-1' }, withDeleted: true }),
    );
    const sent = h.provider.send.mock.calls[0][0];
    expect(sent.category).toBe('doc_deleted');
    expect(sent.title).toBe('[文档删除] docs/gone.md');
    // v2：空间名从**载荷**里的 spaceId 查；**必须带 `withDeleted`**——整空间删除链路
    // （docspace.service.ts 同事务先软删 doc 再软删 space）下 space 行同样已软删（A1）。
    // ⚠️ 覆盖缺口：stub 层模拟不出 `@DeleteDateColumn` 的软删过滤（mock 只会返回我们给的
    //    值），故这里钉的是"调用参数含 withDeleted"这个**机制**；真行为由 e2e 的真 PG 覆盖
    //    （见 notifications-pipeline.e2e-spec.ts 的整空间删除用例）。
    expect(h.docSpaceRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'space-1' },
      withDeleted: true,
    });
    expect(sent.body).toBe('空间「合成空间」 · 即将消失的文档');
    expect(sent.link).toBe('https://platform.example.com/docs/doc-1');
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
  });

  it('DOC_DELETED 整空间删除（space 行也已软删）⇒ 空间名仍取到，不退化成 `?`（A1 回归守卫）', async () => {
    const h = makeHarness();
    // 复刻 docspace.service.remove() 的时序：同事务内 space 的所有 doc 先软删、随后 space 自己
    // 被软删，之后才逐条 emit DOC_DELETED。对渲染层而言可观测的差别只有一个：
    // 查询**必须**绕过软删过滤，否则恒 null。
    h.docRepo.findOne.mockImplementation((options: { withDeleted?: boolean }) =>
      Promise.resolve(
        options?.withDeleted === true
          ? { id: 'doc-1', spaceId: 'space-1', createdBy: 'agent-creator', path: 'docs/gone.md' }
          : null,
      ),
    );
    h.docSpaceRepo.findOne.mockImplementation((options: { withDeleted?: boolean }) =>
      // 模拟"行已软删"：只有带 withDeleted 的查询能拿到它
      Promise.resolve(options.withDeleted === true ? { id: 'space-1', name: '被删空间' } : null),
    );

    await h.orchestrator.onEventCreated(
      makeEvent({
        eventType: EventType.DOC_DELETED,
        resourceId: 'doc-1',
        payload: {
          spaceId: 'space-1',
          docId: 'doc-1',
          path: 'docs/gone.md',
          title: '同批删掉的文档',
        },
      }),
    );

    const sent = h.provider.send.mock.calls[0][0];
    expect(sent.body).toBe('空间「被删空间」 · 同批删掉的文档');
    // 反证：若实现退回不带 withDeleted 的查询，本用例立刻红（拿到 null ⇒ `空间「?」`）
    expect(h.docSpaceRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'space-1' },
      withDeleted: true,
    });
  });

  it('DOC_DELETED 载荷残缺 ⇒ 标题退化为前缀、空间名兜底 `?`（不崩、不静默丢弃）', async () => {
    const h = makeHarness();
    await h.orchestrator.onEventCreated(
      makeEvent({ eventType: EventType.DOC_DELETED, resourceId: 'doc-9', payload: {} }),
    );
    const sent = h.provider.send.mock.calls[0][0];
    expect(sent.title).toBe('[文档删除] ');
    expect(sent.body).toBe('空间「?」 · ');
    // spaceId 畸形/缺失 ⇒ 不把不可信载荷值透传给 TypeORM（铁律 #21）
    expect(h.docSpaceRepo.findOne).not.toHaveBeenCalled();
  });

  it('DOC_DELETED 载荷 spaceId 非字符串 ⇒ 同样兜底 `?`（不对畸形值查库）', async () => {
    const h = makeHarness();
    await h.orchestrator.onEventCreated(
      makeEvent({
        eventType: EventType.DOC_DELETED,
        resourceId: 'doc-9',
        payload: { spaceId: { evil: true }, path: 'docs/x.md', title: 't' },
      }),
    );
    const sent = h.provider.send.mock.calls[0][0];
    expect(sent.body).toBe('空间「?」 · t');
    expect(h.docSpaceRepo.findOne).not.toHaveBeenCalled();
  });

  it('DOC_DELETED 载荷 title 非字符串 ⇒ 视同缺失（与 spaceId 同纪律：不可信载荷不透传）', async () => {
    const h = makeHarness();
    await h.orchestrator.onEventCreated(
      makeEvent({
        eventType: EventType.DOC_DELETED,
        resourceId: 'doc-9',
        payload: { spaceId: 'space-1', path: 'docs/x.md', title: { evil: true } },
      }),
    );
    const sent = h.provider.send.mock.calls[0][0];
    expect(sent.title).toBe('[文档删除] docs/x.md');
    expect(sent.body).toBe('空间「合成空间」 · ');
  });

  it('渲染 v2：发言人显示名超 30 字符 ⇒ 名字先截断，摘要预算不被吃光', async () => {
    const h = makeHarness(makeSettings({ categories: ['topic'] }), [
      { id: 'owner-actor', username: 'owner' },
    ]);
    await h.orchestrator.resolveOwners();
    h.actorProfiles.resolveProfiles.mockResolvedValue(
      new Map([['sender-1', { name: 'N'.repeat(120) }]]),
    );
    h.messageRepo.findOne.mockResolvedValue({
      id: 'msg-1',
      content: 'x'.repeat(300),
      senderId: 'sender-1',
    });

    await h.orchestrator.onEventCreated(
      makeEvent({
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: 'msg-1',
        topicId: 'topic-1',
        actorId: 'someone-else',
        payload: { type: MessageType.CHAT },
      }),
    );

    const sent = h.provider.send.mock.calls[0][0];
    // 名字被截到 30（不是 120）：否则这条通知里一个摘要字符都看不到
    expect(sent.body.startsWith(`${'N'.repeat(30)}：`)).toBe(true);
    expect(sent.body).not.toContain('N'.repeat(31));
    // 100 字预算里仍有 69 个字留给摘要（30 + 全角冒号 1 = 31）
    expect(sent.body).toHaveLength(100);
    expect(sent.body.slice(31)).toBe('x'.repeat(69));
  });

  it('投递：发送前打 INFO 对账锚点（category + eventId + channel），终态落库', async () => {
    const h = makeHarness();
    await h.orchestrator.onEventCreated(makeEvent());
    expect(h.logSpy).toHaveBeenCalledWith(
      expect.stringContaining('sending category=task_updated eventId=evt-1 channel=feishu'),
    );
    expect(h.deliveryRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'feishu',
        recipient: 'ou_test_recipient',
        category: 'task_updated',
        eventId: 'evt-1',
        outcome: expect.objectContaining({ status: 'success' }),
      }),
    );
  });

  it('投递只走收件人**绑定的那个渠道**（多 provider 部署下不遍历全部出口，MINOR-3）', async () => {
    // 第二个出口：投递地址（飞书 open_id）不属于它 ⇒ 它**一次都不该被调用**
    // （否则会得到一次必然失败、且把失败记在无关渠道账上的投递）
    const other = {
      key: 'dingtalk',
      send: jest.fn().mockResolvedValue(SUCCESS_OUTCOME),
    } as unknown as NotifyProvider & { send: jest.Mock };
    const h = makeHarness(makeSettings(), [], {}, [other]);

    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-multiprovider' }));

    expect(h.provider.send).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalled();
    // 台账行只属于那个真发出去的渠道
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
    expect(h.deliveryRepo.record.mock.calls[0][0].channel).toBe('feishu');
  });

  it('收件人绑的渠道**不在本部署出口列表里** ⇒ 丢弃 + `dropped [no_provider]`，**不落表**', async () => {
    // 理论分支：用户绑了一个部署没启用的 token。与"部署根本没配出口"打同一行日志
    // （对运维的动作相同：去把出口配好），且**不新增 reason 值**（事件链路没有信封）。
    const h = makeHarness(makeSettings(), [], { channelProvider: 'dingtalk' });

    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-wrong-provider' }));

    expect(h.logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'dropped [no_provider] category=task_updated eventId=evt-wrong-provider',
      ),
    );
    expect(h.provider.send).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
  });

  it('零 provider ⇒ 丢弃 + INFO，**不落表**（没有 provider 就没有投递尝试）', async () => {
    const h = makeHarness();
    const orchestrator = new NotifyOrchestrator(
      { get: () => makeSettings() } as never,
      h.userRepo as never,
      h.taskRepo as never,
      h.messageRepo as never,
      h.topicRepo as never,
      h.docRepo as never,
      h.topicParticipantRepo as never,
      h.boardRepo as never,
      h.docSpaceRepo as never,
      h.channelRepo as never,
      h.agentRepo as never,
      [] as NotifyProvider[],
      h.deliveryRepo as never,
      h.actorProfiles as never,
      h.accessQuery as never,
    );
    await orchestrator.onEventCreated(makeEvent({ id: 'evt-none' }));
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('dropped [no_provider]'));
    expect(h.provider.send).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
  });

  it('事件管线不再依赖部署级单收件人：FEISHU_RECIPIENT_OPEN_ID 为空时仍按绑定投递', async () => {
    // 一期的 `dropped [no_recipient]` 分支随单 Owner 模型退役——收件地址现来自 per-user 绑定，
    // 部署级 env 只服务 D4 播种与（棒 B 之前的）直发。故这里**必须仍然投递**。
    const h = makeHarness(makeSettings({ feishuRecipientOpenId: null }), [], {
      candidates: ['user-1'],
      addresses: { 'user-1': 'ou_from_binding' },
    });
    await h.orchestrator.onEventCreated(makeEvent());
    expect(h.provider.send).toHaveBeenCalledTimes(1);
    expect(h.deliveryRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'ou_from_binding' }),
    );
  });

  it(`连续 ${CONSECUTIVE_FAILURE_WARN_THRESHOLD} 条 failed ⇒ 一行周期 warn，然后重新计数`, async () => {
    const h = makeHarness();
    h.provider.send.mockResolvedValue(FAILED_OUTCOME);
    for (let index = 1; index <= CONSECUTIVE_FAILURE_WARN_THRESHOLD; index += 1) {
      await h.orchestrator.onEventCreated(
        makeEvent({ id: `evt-${index}`, resourceId: `task-${index}` }),
      );
    }
    expect(h.warnSpy).toHaveBeenCalledWith(expect.stringContaining('consecutive notification'));
    // 失败行照常落库（fail-open：观测面靠表 + 周期 warn）
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(CONSECUTIVE_FAILURE_WARN_THRESHOLD);
    h.warnSpy.mockClear();
    // 重新计数：第 6 条不再告警
    await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-next', resourceId: 'task-next' }));
    expect(h.warnSpy).not.toHaveBeenCalled();
  });

  it('成功投递把失败计数清零（单次成功即复位）', async () => {
    const h = makeHarness();
    // 序列：失败 / 失败 / 成功 / 成功×4 —— 任何时刻都凑不满"连续 5 条失败"
    h.provider.send
      .mockResolvedValueOnce(FAILED_OUTCOME)
      .mockResolvedValueOnce(FAILED_OUTCOME)
      .mockResolvedValueOnce(SUCCESS_OUTCOME);

    for (let index = 1; index <= 7; index += 1) {
      await h.orchestrator.onEventCreated(
        makeEvent({ id: `evt-${index}`, resourceId: `task-${index}` }),
      );
    }
    // 若计数没被成功复位（只有"失败累加"），第 5 条就会告警——这里必须一次都没有
    expect(h.warnSpy).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(7);
  });

  it('provider 违约抛出 ⇒ **合成 failed 终态**（never-throw 是签名表达不了的运行时约束）', async () => {
    const h = makeHarness();
    h.provider.send.mockRejectedValue(new Error('provider exploded'));
    await expect(h.orchestrator.onEventCreated(makeEvent())).resolves.toBeUndefined();
    // 关键：仍然落一行**终态**投递记录，而不是把异常留给上游
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
    expect(h.deliveryRepo.record.mock.calls[0][0].outcome).toEqual(
      expect.objectContaining({ status: 'failed', attempts: 1, responseStatus: null }),
    );
    expect(h.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('threw despite the never-throw contract'),
    );
  });

  // ── fire-and-forget 致命面 ────────────────────────────────────────────

  it('fire-and-forget 路径的 rejection 被 .catch 吞掉（**观测不到 unhandledRejection**）', async () => {
    const h = makeHarness(makeSettings({ globalRateLimit: 1 }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // 第 1 条直发成功；第 2 条超额 ⇒ 摘要经 **fireAndForget** 派发，而落库在这一发上抛错。
      // ⚠️ 用落库而不是 provider 来制造 rejection：provider 的抛出已被 `sendThroughProvider`
      //    合成 failed 终态（P2 修复），**不再**能让 fire-and-forget 链 reject；而真实
      //    repository 内部也自吞——这里强制它抛，正是为了证明**编排器自己的 `.catch`**
      //    在场，不把纪律寄托在"被调方一定会吞"上。
      h.deliveryRepo.record
        .mockResolvedValueOnce(undefined) // evt-1 的落库
        .mockRejectedValueOnce(new Error('ledger boom')); // 摘要那一发的落库

      await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-1', resourceId: 'task-1' }));
      // `list` 不能省：路由靠它找看板，缺了这条事件会在路由层就被判成"零候选"，
      // 于是**根本走不到摘要那一发**（用例会静默变成"断言了一个没发生的场景"）
      h.taskRepo.findOne.mockResolvedValueOnce({
        id: 'task-2',
        title: '任务2',
        assigneeId: null,
        list: { boardId: 'board-1' },
      });
      await h.orchestrator.onEventCreated(makeEvent({ id: 'evt-2', resourceId: 'task-2' }));

      // 让派发出去的 promise 链（微任务 + unhandledRejection 的下一 tick）跑完
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toHaveLength(0);
      // 反证：错误确实发生过，只是被吞了并记了日志（不是"根本没走到那一步"）
      expect(h.errorSpy).toHaveBeenCalledWith(expect.stringContaining('l2 digest flush failed'));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('handler 内部异常全包自吞：仓储抛错也不冒泡到 emit 调用方', async () => {
    const h = makeHarness();
    h.taskRepo.findOne.mockRejectedValue(new Error('db down'));
    await expect(h.orchestrator.onEventCreated(makeEvent())).resolves.toBeUndefined();
    expect(h.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('onEventCreated failed (swallowed)'),
    );
  });

  // ── 系统告警端口（sendSystemAlert / 启动自检 / 量控分桶）───────────────

  /** admin 行夹具（`actor` 字段用来模拟 eager 关系的两种真实形态） */
  const adminRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'admin-user',
    username: 'admin',
    role: 'admin',
    actor: { status: 'active' },
    ...overrides,
  });

  /** 渠道行夹具（缺省 = deliveryEligible） */
  const channelRow = (overrides: Record<string, unknown> = {}) => ({
    userId: 'admin-user',
    provider: 'feishu',
    recipientAddress: 'ou_admin',
    enabled: true,
    unboundAt: null,
    lastTestStatus: 'ok',
    createdAt: new Date(0),
    ...overrides,
  });

  /** 生产方 tracker 的入参形态：title = 首行，body = 余下多行（含处置/恢复指引） */
  function alertInput(overrides: Record<string, unknown> = {}) {
    return {
      source: 'memory-engine' as const,
      kind: 'alert' as const,
      arm: 'auth' as const,
      title: '[engine alert] arm=auth consecutive=3',
      body: 'workspace=demo\nengineCode=quota_exceeded\n处置：检查引擎凭据与配额',
      occurredAt: '2026-10-23T00:00:00.000Z',
      ...overrides,
    };
  }

  /** 把 admin / 渠道替身拨到"可投递"档（其余仓储沿用 makeHarness 的路由夹具） */
  function makeAlertHarness(settings: NotificationsConfig = makeSettings()) {
    const h = makeHarness(settings);
    h.userRepo.findOne.mockImplementation(
      async (options?: { where?: { role?: string; id?: string } }) => {
        if (options?.where?.role === 'admin') return adminRow();
        return { id: options?.where?.id ?? 'user-1', preferences: { notificationCategories: {} } };
      },
    );
    h.channelRepo.findOne.mockResolvedValue(channelRow());
    return h;
  }

  it('delivered：落一行 system_alert 终态（eventId=null、link=/memory、正文多行保留）', async () => {
    const h = makeAlertHarness();

    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('delivered');

    expect(h.provider.send).toHaveBeenCalledTimes(1);
    const rendered = h.provider.send.mock.calls[0][0];
    expect(rendered).toMatchObject({
      category: 'system_alert',
      eventId: null,
      recipient: 'ou_admin',
      link: 'https://platform.example.com/memory',
    });
    expect(rendered.title).toBe('[engine alert] arm=auth consecutive=3');
    expect(rendered.body).toContain('\n');
    // 终态落库：归属列 = admin 的 user id（admin 列表按人过滤的唯一依据）
    expect(h.deliveryRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'system_alert',
        eventId: null,
        recipientUserId: 'admin-user',
      }),
    );
  });

  it('failed：provider 失败 ⇒ 单次 outcome（**不做应用层重投**）', async () => {
    const h = makeAlertHarness();
    h.provider.send.mockResolvedValue(FAILED_OUTCOME);

    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('failed');

    // 只有一次发送：v3 的 30s 重投已删除（at-least-once，见 plan D6-6）
    expect(h.provider.send).toHaveBeenCalledTimes(1);
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
  });

  it('disabled：总开关关 ⇒ 不读库、不投递、不落表（也不吃额度）', async () => {
    const h = makeAlertHarness(makeSettings({ enabled: false }));

    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('disabled');

    expect(h.userRepo.findOne).not.toHaveBeenCalled();
    expect(h.provider.send).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
    expect(h.logSpy).toHaveBeenCalledWith(
      expect.stringContaining('system_alert skipped [disabled]'),
    );
  });

  it('no_admin：库里没有 admin 账号', async () => {
    const h = makeAlertHarness();
    h.userRepo.findOne.mockResolvedValue(null);

    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('no_admin');
    expect(h.provider.send).not.toHaveBeenCalled();
  });

  it('admin_soft_deleted：actor 被软删（TypeORM 置 null）/ status 非 active 两形态都可达', async () => {
    // ① 软删 actor 的真实形态：eager 关系被 DeleteDateColumn 过滤成 null
    const softDeleted = makeAlertHarness();
    softDeleted.userRepo.findOne.mockResolvedValue(adminRow({ actor: null }));
    await expect(softDeleted.orchestrator.sendSystemAlert(alertInput())).resolves.toBe(
      'admin_soft_deleted',
    );

    // ② status 非 active（禁用态）——同样属于"账号还在、身份不可用"
    const disabled = makeAlertHarness();
    disabled.userRepo.findOne.mockResolvedValue(adminRow({ actor: { status: 'disabled' } }));
    await expect(disabled.orchestrator.sendSystemAlert(alertInput())).resolves.toBe(
      'admin_soft_deleted',
    );
  });

  it('no_channel：admin 从没绑过渠道（count=0）', async () => {
    const h = makeAlertHarness();
    h.channelRepo.findOne.mockResolvedValue(null);
    h.channelRepo.count.mockResolvedValue(0);

    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('no_channel');
  });

  it('channel_ineligible：有绑定但不可投递；count 只数非墓碑行（unboundAt IS NULL）', async () => {
    const h = makeAlertHarness();
    h.channelRepo.findOne.mockResolvedValue(null);
    h.channelRepo.count.mockResolvedValue(2);

    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('channel_ineligible');

    // 墓碑行（解绑过）若被计入，"解绑过"的人会被误指引去点测试（PM N3）
    expect(h.channelRepo.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 'admin-user',
        unboundAt: expect.objectContaining({ type: 'isNull' }),
      }),
    });
  });

  it('no_provider：渠道存在但本部署没装配该 provider', async () => {
    const h = makeAlertHarness();
    h.channelRepo.findOne.mockResolvedValue(channelRow({ provider: 'slack' }));

    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('no_provider');
    expect(h.provider.send).not.toHaveBeenCalled();
  });

  it('rate_limited：auth 桶打满后 alert 被丢弃，且只打一条窗口聚合 WARN', async () => {
    const h = makeAlertHarness(makeSettings({ systemAlertMaxPerHour: 1 }));

    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('delivered');
    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('rate_limited');

    expect(h.provider.send).toHaveBeenCalledTimes(1);
    // 窗口聚合 WARN：一个窗口只一行（带累计条数），不随每次丢弃刷屏
    expect(h.warnSpy).toHaveBeenCalledTimes(1);
    expect(h.warnSpy).toHaveBeenCalledWith(expect.stringContaining('system_alert rate limit hit'));
  });

  it('量控上限**缺键**的配置对象 ⇒ 逐键兜底 12/h，不把全部告警误判成 rate_limited（review N2）', async () => {
    // 复刻"命名空间存在但缺新键"的形态（旧版 e2e 内联配置 / 外部 override）：
    // `resolveNotificationsConfig` 只在**整个命名空间缺失**时才回落 FALLBACK。
    const settings = makeSettings();
    delete (settings as { systemAlertMaxPerHour?: number }).systemAlertMaxPerHour;
    const h = makeAlertHarness(settings as NotificationsConfig);

    // 12 条以内全部放行（若 `used < undefined` 生效，第一条就会是 rate_limited）
    for (let index = 0; index < 12; index += 1) {
      await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('delivered');
    }
    // 第 13 条才被限：证明兜底值确实是 12，不是"不限"也不是 0
    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('rate_limited');
    expect(h.provider.send).toHaveBeenCalledTimes(12);
  });

  it('outcome 日志带 occurredAt（生产方对账锚点；review N4）', async () => {
    const h = makeAlertHarness();
    await h.orchestrator.sendSystemAlert(alertInput());

    expect(h.logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/system_alert delivered .* at=2026-10-23T00:00:00\.000Z/),
    );
  });

  // ── 量控分桶四条（security #1 终态：auth recovery 也计额）──────────────

  it('分桶①：auth 打满后 **auth recovery 也 rate_limited**（否则 recovery 免额架空反刷屏）', async () => {
    const h = makeAlertHarness(makeSettings({ systemAlertMaxPerHour: 1 }));
    await h.orchestrator.sendSystemAlert(alertInput({ kind: 'alert' }));

    await expect(
      h.orchestrator.sendSystemAlert(alertInput({ kind: 'recovery', title: '[engine recovered]' })),
    ).resolves.toBe('rate_limited');
    expect(h.provider.send).toHaveBeenCalledTimes(1);
  });

  it('分桶②：auth 打满后 **availability 告警仍 delivered**（两桶互不影响）', async () => {
    const h = makeAlertHarness(makeSettings({ systemAlertMaxPerHour: 1 }));
    await h.orchestrator.sendSystemAlert(alertInput({ arm: 'auth' }));

    await expect(h.orchestrator.sendSystemAlert(alertInput({ arm: 'availability' }))).resolves.toBe(
      'delivered',
    );
    expect(h.provider.send).toHaveBeenCalledTimes(2);
  });

  it('分桶③：availability recovery **恒 delivered**（A 臂恢复有探针迟滞，天然有界）', async () => {
    const h = makeAlertHarness(makeSettings({ systemAlertMaxPerHour: 1 }));
    await h.orchestrator.sendSystemAlert(alertInput({ arm: 'availability', kind: 'alert' }));
    await expect(
      h.orchestrator.sendSystemAlert(alertInput({ arm: 'availability', kind: 'alert' })),
    ).resolves.toBe('rate_limited');

    await expect(
      h.orchestrator.sendSystemAlert(alertInput({ arm: 'availability', kind: 'recovery' })),
    ).resolves.toBe('delivered');
    expect(h.provider.send).toHaveBeenCalledTimes(2);
  });

  it('分桶④：heartbeat **不计额**（上限 1 也能连发）', async () => {
    const h = makeAlertHarness(makeSettings({ systemAlertMaxPerHour: 1 }));
    for (let index = 0; index < 3; index += 1) {
      await expect(h.orchestrator.sendSystemAlert(alertInput({ kind: 'heartbeat' }))).resolves.toBe(
        'delivered',
      );
    }
    expect(h.provider.send).toHaveBeenCalledTimes(3);
  });

  it('never-throw：DB 抛错 ⇒ 折成 failed（不外抛）', async () => {
    const h = makeAlertHarness();
    h.userRepo.findOne.mockRejectedValue(new Error('db down'));

    await expect(h.orchestrator.sendSystemAlert(alertInput())).resolves.toBe('failed');
    expect(h.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('system_alert dispatch failed (swallowed): Error'),
    );
  });

  // ── 渲染边界（PM N1 的长度回归钉 + 控制字符卫生）───────────────────

  it('正文上限 1000：保住「处置：」与「恢复：」两行（复用 200 会切掉）', async () => {
    const h = makeAlertHarness();
    const title = '[engine recovered] arm=availability consecutive=0';
    // 前 300 字符填满 ⇒ 若按 200 截断，两个指引行全部丢失
    const body = [
      `workspace=demo\n${'x'.repeat(300)}`,
      '处置：确认 5xx 已消失并重跑探针',
      '恢复：本通知为恢复确认，无需处置。',
    ].join('\n');

    await h.orchestrator.sendSystemAlert(alertInput({ kind: 'recovery', title, body }));

    const rendered = h.provider.send.mock.calls[0][0];
    expect(rendered.title).toBe(title);
    expect(rendered.body).toContain('处置：');
    expect(rendered.body).toContain('恢复：');
    expect(rendered.body.length).toBeLessThanOrEqual(1000);
  });

  it('渲染卫生：剥 \\r 与控制字符、保留 \\n；基址缺失 ⇒ link=null（不拼 "null/memory"）', async () => {
    const h = makeAlertHarness(makeSettings({ webBaseUrl: null }));
    await h.orchestrator.sendSystemAlert(
      alertInput({ title: '[engine alert]\r', body: 'line1\r\nline2\u0007\tend' }),
    );

    const rendered = h.provider.send.mock.calls[0][0];
    expect(rendered.title).toBe('[engine alert]');
    expect(rendered.body).toBe('line1\nline2end'); // \r / \u0007 / \t 剥掉，\n 保留
    expect(rendered.link).toBeNull();
  });

  // ── 启动自检（S2 六态 + 启动不炸）────────────────────────────────────

  it('启动自检：disabled / ok / no_admin(降级 log) / admin_soft_deleted / no_channel / channel_ineligible / no_provider', async () => {
    // disabled：正常缺省态 ⇒ log
    const disabled = makeHarness(makeSettings({ enabled: false }));
    await disabled.orchestrator.onApplicationBootstrap();
    expect(disabled.logSpy).toHaveBeenCalledWith(
      'system_alert target: disabled (NOTIFY_ENABLED=false)',
    );

    // ok：admin username + provider token（**不含地址全值**）
    const ok = makeAlertHarness();
    await ok.orchestrator.onApplicationBootstrap();
    expect(ok.logSpy).toHaveBeenCalledWith(
      expect.stringContaining('system_alert target: ok admin=admin channel=feishu'),
    );

    // no_admin：启动期**降级为 log**（bootstrap 顺序保险，architect B3）
    const noAdmin = makeHarness();
    noAdmin.userRepo.findOne.mockResolvedValue(null);
    await noAdmin.orchestrator.onApplicationBootstrap();
    expect(noAdmin.logSpy).toHaveBeenCalledWith(
      expect.stringContaining('admin account not found at boot'),
    );
    expect(noAdmin.warnSpy).not.toHaveBeenCalled();

    // admin_soft_deleted：warn + 修复指引
    const softDeleted = makeAlertHarness();
    softDeleted.userRepo.findOne.mockResolvedValue(adminRow({ actor: null }));
    await softDeleted.orchestrator.onApplicationBootstrap();
    expect(softDeleted.warnSpy).toHaveBeenCalledWith(expect.stringContaining('soft-deleted'));

    // no_channel：warn + 绑渠道指引
    const noChannel = makeAlertHarness();
    noChannel.channelRepo.findOne.mockResolvedValue(null);
    noChannel.channelRepo.count.mockResolvedValue(0);
    await noChannel.orchestrator.onApplicationBootstrap();
    expect(noChannel.warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no notification channel bound'),
    );

    // channel_ineligible：warn + 去点测试指引
    const ineligible = makeAlertHarness();
    ineligible.channelRepo.findOne.mockResolvedValue(null);
    ineligible.channelRepo.count.mockResolvedValue(1);
    await ineligible.orchestrator.onApplicationBootstrap();
    expect(ineligible.warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('NOT delivery-eligible'),
    );

    // no_provider：warn + 出口配置指引
    const noProvider = makeAlertHarness();
    noProvider.channelRepo.findOne.mockResolvedValue(channelRow({ provider: 'slack' }));
    await noProvider.orchestrator.onApplicationBootstrap();
    expect(noProvider.warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('provider is not assembled'),
    );
  });

  it('启动自检：DB 抛错 ⇒ 不中止启动（error 日志 + resolve）', async () => {
    const h = makeHarness();
    h.userRepo.findOne.mockRejectedValue(new Error('db down'));

    await expect(h.orchestrator.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(h.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('system_alert target self-check failed (ignored)'),
    );
  });
});
