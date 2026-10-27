/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 二期设置面（六端点服务侧）的单元矩阵：认证判空（B1）/ 验证不变量 /
 *     tombstone / 写路径的条件 UPDATE 守卫（M3）/ 23505 按约束名分流（M4）/ 归一分流（B2）/
 *     test 端点的限流、写态纪律（M6）与总闸。
 *
 * [代码职责]
 *   - 用内存替身钉死**服务端不变量、判定顺序与写入形态**（真库行为由 e2e 覆盖）
 *
 * [权威文档]
 *   - 主文档: 线上 `docs/api-definition.md` §20.3（六端点全契约）
 *
 * [关键不变量]（改动断言前先想清楚在防什么）
 *   - **B1：拿不到 `userId` 一律 401**——`JwtAuthGuard` 的 `X-API-Key` 分支只挂 `request.agent`，
 *     `@CurrentUser('userId')` 为 undefined，而 `findOne({id: undefined})` 会丢 WHERE 命中
 *     `users` 首行（认证绕过）。六端点全部以 `requireUser` 为首句。
 *   - **B2：读取归一以缺省集为基座**（`task_done + direct`），显式布尔才覆盖。
 *   - **M3：三处写路径都是条件 UPDATE**（不是"读内存再 save()"）：换地址用**旧地址**做守卫、
 *     同地址只清 tombstone、解绑与写验证态带 `unbound_at IS NULL`；`affected=0` ⇒ 丢弃本次写态。
 *   - **M4：23505 文案按约束名分流**（地址占用 vs 自己已有绑定）。
 *   - **M6：只有 `failureKind === 'address'` 的失败才写 `last_test_status='failed'`**
 *     （transport / provider / 未分类都不写——一次上游 5xx 不该把已验证的地址打成失败）。
 *
 * [关联代码]
 *   - src/modules/notifications/notification-settings.service.ts — 被测实现
 *   - test/user-notification-channels-schema.e2e-spec.ts — 真库面（部分唯一 / FK / 逐列）
 *   - test/notification-settings.e2e-spec.ts — HTTP 面（六端点 + agent key 401 回归门）
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查)
 * =============================================================================
 */
import { Logger } from '@nestjs/common';
import { ActorType, UserRole } from '@agent-chamber/shared';
import {
  NotificationSettingsService,
  uniqueViolationConstraint,
} from './notification-settings.service';
import { NOTIFICATIONS_CONFIG_FALLBACK } from '../../config/notifications.config';
import type { DeliveryOutcome } from './notify-provider.interface';

/** 成功的投递终态（test 端点主路径） */
function successOutcome(): DeliveryOutcome {
  return {
    status: 'success',
    attempts: 1,
    responseStatus: 200,
    lastError: null,
    deliveredAt: new Date('2026-10-13T00:00:00Z'),
  };
}

/**
 * 指定归因的失败终态（M6 分类断言用）。
 *
 * @param failureKind 归因（`address` = 消息端点拒绝该地址；`provider`/`transport`/undefined = 不写验证态）
 */
function failedOutcome(failureKind?: DeliveryOutcome['failureKind']): DeliveryOutcome {
  return {
    status: 'failed',
    attempts: 1,
    responseStatus: failureKind === 'transport' ? null : 502,
    lastError: failureKind === 'address' ? 'invalid receive_id' : 'upstream 502',
    deliveredAt: null,
    failureKind,
  };
}

/** 造一个渠道行实体 */
function channelRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ch-1',
    userId: 'u-1',
    provider: 'feishu',
    recipientAddress: 'ou_alice',
    enabled: false,
    lastTestAt: null,
    lastTestStatus: null,
    lastTestAddress: null,
    source: 'user',
    unboundAt: null,
    createdAt: new Date('2026-10-13T00:00:00Z'),
    ...overrides,
  };
}

/** 一次条件 UPDATE 的捕获（`set` 补丁 + 全部 where 谓词） */
interface CapturedUpdate {
  patch: Record<string, unknown>;
  wheres: string[];
  params: Record<string, unknown>;
}

describe('NotificationSettingsService（六端点服务侧矩阵）', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeHarness(
    opts: {
      settings?: Record<string, unknown>;
      channel?: ReturnType<typeof channelRow> | null;
      freshChannel?: ReturnType<typeof channelRow> | null;
      user?: Record<string, unknown> | null;
      /** 条件 UPDATE 的 affected 序列（缺省恒 1） */
      affected?: number[];
      /** 条件 UPDATE 直接抛错（23505 分流用） */
      updateThrows?: unknown;
      /** INSERT（save）直接抛错（23505 分流用） */
      saveThrows?: unknown;
      providerSend?: jest.Mock;
      gate?: { allowed: boolean; retryAfterSeconds?: number };
    } = {},
  ) {
    const settings = {
      ...NOTIFICATIONS_CONFIG_FALLBACK,
      enabled: true,
      providers: ['feishu'],
      categories: ['task_done', 'direct'],
      feishuAppId: 'cli_x',
      feishuAppSecret: 'secret',
      feishuRecipientOpenId: 'ou_alice',
      webBaseUrl: 'https://platform.example.com',
      ...(opts.settings ?? {}),
    };

    const user =
      opts.user === null
        ? null
        : {
            id: 'u-1',
            role: UserRole.EDITOR,
            preferences: {},
            actor: { deletedAt: null },
            ...(opts.user ?? {}),
          };

    const affectedQueue = [...(opts.affected ?? [])];
    const updates: CapturedUpdate[] = [];

    /** 一条"条件 UPDATE"链（捕获 set/where，execute 返回受控 affected） */
    const makeUpdateBuilder = () => {
      const captured: CapturedUpdate = { patch: {}, wheres: [], params: {} };
      const builder: Record<string, unknown> = {
        update: jest.fn(() => builder),
        set: jest.fn((patch: Record<string, unknown>) => {
          captured.patch = patch;
          return builder;
        }),
        where: jest.fn((sql: string, params?: Record<string, unknown>) => {
          captured.wheres.push(sql);
          Object.assign(captured.params, params);
          return builder;
        }),
        andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
          captured.wheres.push(sql);
          Object.assign(captured.params, params);
          return builder;
        }),
        execute: jest.fn(async () => {
          updates.push(captured);
          if (opts.updateThrows) throw opts.updateThrows;
          return { affected: affectedQueue.length > 0 ? affectedQueue.shift() : 1 };
        }),
      };
      return builder;
    };

    const channelRepo = {
      find: jest.fn().mockResolvedValue(opts.channel ? [opts.channel] : []),
      // 第一次 = "是否存在"读；后续 = upsert 末尾的 fresh 读
      findOne: jest
        .fn()
        .mockResolvedValueOnce(opts.channel ?? null)
        .mockResolvedValue(
          opts.freshChannel !== undefined ? opts.freshChannel : (opts.channel ?? null),
        ),
      create: jest.fn((row: unknown) => row),
      save: jest.fn(async (row: unknown) => {
        if (opts.saveThrows) throw opts.saveThrows;
        return row;
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => makeUpdateBuilder()),
    };

    const providerSend = opts.providerSend ?? jest.fn().mockResolvedValue(successOutcome());
    const providers = settings.providers.includes('feishu')
      ? [{ key: 'feishu', send: providerSend }]
      : [];

    const orchestrator = {
      sendThroughProvider: jest.fn(async (provider: { send: jest.Mock }) => provider.send()),
      consumePlatformGate: jest
        .fn()
        .mockReturnValue(
          opts.gate?.allowed === false
            ? { allowed: false, retryAfterSeconds: opts.gate.retryAfterSeconds ?? 42 }
            : { allowed: true },
        ),
      // Notifications 二期批 2：写时失效（绑定/偏好/验证态写完后调用）。本套件只断言"被调用了
      // 几次"，失效本身的语义由 notify-orchestrator 的用例覆盖。
      invalidateUser: jest.fn(),
    };

    const deliveryRepo = { record: jest.fn().mockResolvedValue(undefined) };
    const accessQuery = {
      getMyTopicIds: jest.fn().mockResolvedValue(['t1', 't2']),
      getMyBoardIds: jest.fn().mockResolvedValue(['b1']),
      getMyDocSpaceIds: jest.fn().mockResolvedValue(['s1', 's2', 's3']),
    };

    // 偏好写入的**内存仿真**：`updatePrefs`/`deletePrefs` 走原子 SQL，再读一次 users 行——
    // 故 query 必须把补丁真的落到内存，findOne 才能回读到新值（否则测不出合并结果）。
    const prefsStore: Record<string, unknown> = {
      ...((user?.preferences as Record<string, unknown>) ?? {}),
    };
    const userRepo = {
      findOne: jest.fn(async () => (user ? { ...user, preferences: { ...prefsStore } } : null)),
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (String(sql).includes('jsonb_set')) {
          const patch = JSON.parse(String(params[1])) as Record<string, unknown>;
          const current = (prefsStore.notificationCategories ?? {}) as Record<string, unknown>;
          prefsStore.notificationCategories = { ...current, ...patch };
        } else if (String(sql).includes("preferences - 'notificationCategories'")) {
          delete prefsStore.notificationCategories;
        }
        return [];
      }),
    };

    const service = new NotificationSettingsService(
      userRepo as never,
      channelRepo as never,
      { get: () => settings } as never,
      providers as never,
      orchestrator as never,
      deliveryRepo as never,
      accessQuery as never,
    );

    return {
      service,
      settings,
      channelRepo,
      userRepo,
      updates,
      providerSend,
      orchestrator,
      deliveryRepo,
      accessQuery,
      logSpy,
      errorSpy,
    };
  }

  /**
   * 断言一个 409 的**文案**（Nest 的 `HttpException` 把对象响应的 message 放在 `getResponse()`）。
   *
   * @param promise 待断言的服务调用
   * @param substring 期望出现的文案片段
   */
  async function expectConflict(promise: Promise<unknown>, substring: string): Promise<void> {
    await expect(promise).rejects.toMatchObject({ status: 409 });
    try {
      await promise;
    } catch (err) {
      const response = (err as { getResponse: () => unknown }).getResponse() as { message: string };
      expect(response.message).toContain(substring);
    }
  }

  // ────────────────────────── B1：认证判空 ──────────────────────────

  it('B1：没有 human 身份（userId=undefined）⇒ 六个端点全部 401，且**不碰仓储**', async () => {
    const h = makeHarness({ channel: channelRow() });
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['getMe', () => h.service.getMe(undefined as never)],
      ['upsertChannel', () => h.service.upsertChannel(undefined as never, 'feishu', {})],
      ['deleteChannel', () => h.service.deleteChannel(undefined as never, 'feishu')],
      ['testChannel', () => h.service.testChannel(undefined as never, 'feishu')],
      [
        'updatePrefs',
        () => h.service.updatePrefs(undefined as never, { notificationCategories: {} }),
      ],
      ['deletePrefs', () => h.service.deletePrefs(undefined as never)],
    ];

    for (const [name, call] of calls) {
      await expect(call()).rejects.toMatchObject({ status: 401 });
      expect({ name, wrote: h.channelRepo.save.mock.calls.length }).toEqual({ name, wrote: 0 });
    }
  });

  it('B1：用户不存在 / actor 已软删 ⇒ 404（不是 401——身份有效但资源没了）', async () => {
    const missing = makeHarness({ user: null });
    await expect(missing.service.getMe('u-1')).rejects.toMatchObject({ status: 404 });

    const softDeleted = makeHarness({ user: { actor: { deletedAt: new Date() } } });
    await expect(softDeleted.service.getMe('u-1')).rejects.toMatchObject({ status: 404 });
  });

  // ────────────────────────── GET /me ──────────────────────────

  it('GET /me：渠道过滤 tombstone（查询带 unboundAt IS NULL）+ 触发面直算 + configured 只回布尔', async () => {
    const h = makeHarness({ channel: channelRow() });
    const view = await h.service.getMe('u-1');

    const where = (h.channelRepo.find.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.userId).toBe('u-1');
    expect(where.unboundAt).toBeDefined(); // IsNull()

    expect(view.channels).toHaveLength(1);
    expect(view.channels[0]).toMatchObject({
      provider: 'feishu',
      recipientAddress: 'ou_alice',
      enabled: false,
      lastTestStatus: null,
      source: 'user',
    });
    expect(view.prefs.relevantScopes).toEqual({ topics: 2, boards: 1, spaces: 3 });
    expect(view.prefs.defaults).toEqual(['task_done', 'direct']);
    expect(view.platform.providers).toEqual([{ key: 'feishu', configured: true }]);
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('B2：偏好读取归一以**缺省集为基座**（task_done/direct 缺省开），严格布尔才覆盖', async () => {
    const h = makeHarness({
      user: {
        preferences: {
          notificationCategories: { topic: true, task_done: false, bogus: true, direct: 'true' },
        },
      },
    });
    const view = await h.service.getMe('u-1');
    expect(view.prefs.categories.topic).toBe(true); // 显式开
    expect(view.prefs.categories.task_done).toBe(false); // 显式关（覆盖缺省 true）
    expect(view.prefs.categories.direct).toBe(true); // 字符串 'true' 不算 ⇒ 落缺省 true
    expect(view.prefs.categories.doc_created).toBe(false); // 未提及 + 非缺省 ⇒ false
    expect(Object.keys(view.prefs.categories)).not.toContain('bogus');
  });

  it('B2：无偏好键（null / 非对象）⇒ 纯缺省集（与 DELETE /me/prefs 自洽）', async () => {
    for (const raw of [null, undefined, 'nope', [1, 2]]) {
      const h = makeHarness({ user: { preferences: { notificationCategories: raw } } });
      const view = await h.service.getMe('u-1');
      expect(view.prefs.categories.task_done).toBe(true);
      expect(view.prefs.categories.direct).toBe(true);
      expect(view.prefs.categories.topic).toBe(false);
    }
  });

  // ──────────────── PUT /me/channels/:provider ────────────────

  it('PUT：首次绑定缺地址 ⇒ 400', async () => {
    const h = makeHarness({ channel: null });
    await expect(h.service.upsertChannel('u-1', 'feishu', {})).rejects.toMatchObject({
      status: 400,
    });
  });

  it('PUT：未验证地址置 enabled=true ⇒ 400（条件更新 affected=0，不满足服务端不变量）', async () => {
    // 第一次 UPDATE（换址/复活）affected=1，第二次（置启用）affected=0
    const h = makeHarness({ channel: channelRow(), affected: [1, 0] });
    await expect(
      h.service.upsertChannel('u-1', 'feishu', { recipientOpenId: 'ou_alice', enabled: true }),
    ).rejects.toMatchObject({ status: 400 });

    const enableGuards = h.updates[1].wheres.join(' | ');
    expect(enableGuards).toContain('last_test_address = recipient_address');
    expect(enableGuards).toContain('last_test_status IN');
    expect(enableGuards).toContain('unbound_at IS NULL');
  });

  it('M3：地址变化 ⇒ 条件 UPDATE（旧地址做守卫 + 清验证态 + 复活），不是 save()', async () => {
    const h = makeHarness({
      channel: channelRow({
        lastTestStatus: 'ok',
        lastTestAddress: 'ou_alice',
        unboundAt: new Date(),
      }),
      freshChannel: channelRow({ recipientAddress: 'ou_bob' }),
    });
    await h.service.upsertChannel('u-1', 'feishu', { recipientOpenId: 'ou_bob' });

    // save() 只用于 INSERT（首绑）；本路径必须走条件 UPDATE
    expect(h.channelRepo.save).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].patch).toMatchObject({
      recipientAddress: 'ou_bob',
      enabled: false,
      lastTestStatus: null,
      lastTestAddress: null,
      lastTestAt: null,
      source: 'user',
      unboundAt: null,
    });
    // 乐观守卫 = 旧地址（并发改址 ⇒ affected=0 ⇒ 丢弃本次写态）
    expect(h.updates[0].wheres.join(' | ')).toContain('recipient_address = :recipientAddress');
    expect(h.updates[0].params.recipientAddress).toBe('ou_alice');
  });

  it('M3：地址不变 ⇒ 只清 tombstone（保留验证态），守卫仍是地址', async () => {
    const h = makeHarness({
      channel: channelRow({
        lastTestStatus: 'ok',
        lastTestAddress: 'ou_alice',
        source: 'env_seed',
      }),
      freshChannel: channelRow({
        lastTestStatus: 'ok',
        lastTestAddress: 'ou_alice',
        source: 'env_seed',
      }),
    });
    await h.service.upsertChannel('u-1', 'feishu', { recipientOpenId: 'ou_alice' });

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].patch).toEqual({ unboundAt: null }); // 只复活，不碰验证态/enabled
    expect(h.updates[0].params.recipientAddress).toBe('ou_alice');
  });

  it('M3：并发改址导致守卫未命中（affected=0）⇒ 丢弃本次写态、不抛', async () => {
    const h = makeHarness({
      channel: channelRow({ recipientAddress: 'ou_alice' }),
      freshChannel: channelRow({ recipientAddress: 'ou_other' }),
      affected: [0],
    });
    const view = await h.service.upsertChannel('u-1', 'feishu', { recipientOpenId: 'ou_bob' });
    // 返回的是并发后的现状（fresh 读），而不是本次意图
    expect(view.recipientAddress).toBe('ou_other');
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('channel write discarded'));
  });

  it('M4：撞"地址已被其他账户占用"约束 ⇒ 409 地址文案', async () => {
    const h = makeHarness({
      channel: channelRow(),
      updateThrows: Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_user_notification_channels_verified_address',
      }),
    });
    await expectConflict(
      h.service.upsertChannel('u-1', 'feishu', { recipientOpenId: 'ou_bob' }),
      'already bound to another platform account',
    );
  });

  it('M4：撞"同 user 同 provider 已存在"约束 ⇒ 409 通用文案（不是"别人占了你"）', async () => {
    const h = makeHarness({
      channel: null,
      saveThrows: Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_user_notification_channels_user_provider',
      }),
    });
    await expectConflict(
      h.service.upsertChannel('u-1', 'feishu', { recipientOpenId: 'ou_bob' }),
      'already has a binding',
    );
  });

  it('M4：uniqueViolationConstraint 只认 23505，且从 driverError 兜底取约束名', () => {
    expect(uniqueViolationConstraint({ code: '23505', constraint: 'x' })).toBe('x');
    expect(uniqueViolationConstraint({ driverError: { code: '23505', constraint: 'y' } })).toBe(
      'y',
    );
    expect(uniqueViolationConstraint({ code: '23503', constraint: 'x' })).toBeNull();
    expect(uniqueViolationConstraint(new Error('boom'))).toBeNull();
    expect(uniqueViolationConstraint(null)).toBeNull();
  });

  // ────────────── DELETE /me/channels/:provider ──────────────

  it('M3：DELETE = 条件 UPDATE（WHERE unbound_at IS NULL）；affected=0 ⇒ 404', async () => {
    const gone = makeHarness({ channel: channelRow(), affected: [0] });
    await expect(gone.service.deleteChannel('u-1', 'feishu')).rejects.toMatchObject({
      status: 404,
    });

    const h = makeHarness({ channel: channelRow({ enabled: true }), affected: [1] });
    await h.service.deleteChannel('u-1', 'feishu');
    expect(h.updates[0].patch.enabled).toBe(false);
    expect(h.updates[0].patch.unboundAt).toBeInstanceOf(Date);
    expect(h.updates[0].wheres.join(' | ')).toContain('unbound_at IS NULL');
    // 不再"读到内存再 save()"
    expect(h.channelRepo.save).not.toHaveBeenCalled();
  });

  // ──────────── POST /me/channels/:provider/test ────────────

  it('test：无活绑定 ⇒ 404（无信封）；总开关关闭 / 无出口 ⇒ 短路降级且**不写验证态**', async () => {
    await expect(
      makeHarness({ channel: null }).service.testChannel('u-1', 'feishu'),
    ).rejects.toMatchObject({
      status: 404,
    });

    const disabled = makeHarness({ channel: channelRow(), settings: { enabled: false } });
    expect(await disabled.service.testChannel('u-1', 'feishu')).toEqual({
      delivered: 0,
      channels: [],
      reason: 'notify_disabled',
    });
    expect(disabled.updates).toHaveLength(0);
    expect(disabled.deliveryRepo.record).not.toHaveBeenCalled();

    const noProvider = makeHarness({ channel: channelRow(), settings: { providers: [] } });
    expect(await noProvider.service.testChannel('u-1', 'feishu')).toEqual({
      delivered: 0,
      channels: [],
      reason: 'no_provider',
    });
    expect(noProvider.updates).toHaveLength(0);
  });

  it('test：成功 ⇒ ok + last_test_address 回填 + 自动 enabled=true + 台账带 recipientUserId/direct_test', async () => {
    const h = makeHarness({
      channel: channelRow(),
      freshChannel: channelRow({
        enabled: true,
        lastTestStatus: 'ok',
        lastTestAddress: 'ou_alice',
      }),
    });
    const envelope = await h.service.testChannel('u-1', 'feishu');

    expect(envelope).toEqual({ delivered: 1, channels: ['feishu'] });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].patch).toMatchObject({
      lastTestStatus: 'ok',
      lastTestAddress: 'ou_alice',
      enabled: true,
    });
    expect(h.updates[0].patch.lastTestAt).toBeInstanceOf(Date);
    // M3 守卫：id + 地址 + 未解绑
    const guards = h.updates[0].wheres.join(' | ');
    expect(guards).toContain('id = :id');
    expect(guards).toContain('recipient_address = :recipientAddress');
    expect(guards).toContain('unbound_at IS NULL');

    const record = h.deliveryRepo.record.mock.calls[0][0] as Record<string, unknown>;
    expect(record).toMatchObject({
      channel: 'feishu',
      recipient: 'ou_alice',
      category: 'direct_test',
      eventId: null,
      recipientUserId: 'u-1',
    });
    expect(record.title).toContain('[测试]');
  });

  it('M6：地址可归因失败（failureKind=address）⇒ 写 failed；**不改 enabled**', async () => {
    const h = makeHarness({
      channel: channelRow({ enabled: false }),
      providerSend: jest.fn().mockResolvedValue(failedOutcome('address')),
    });
    expect(await h.service.testChannel('u-1', 'feishu')).toEqual({
      delivered: 0,
      channels: [],
      reason: 'delivery_failed',
    });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].patch).toMatchObject({ lastTestStatus: 'failed' });
    expect(h.updates[0].patch).not.toHaveProperty('enabled');
  });

  it('M6：transport / provider / 未分类失败 ⇒ **完全不写验证态**（一次上游抖动不打翻已验证的地址）', async () => {
    for (const outcome of [
      failedOutcome('transport'),
      failedOutcome('provider'),
      failedOutcome(),
    ]) {
      const h = makeHarness({
        channel: channelRow({ lastTestStatus: 'ok', lastTestAddress: 'ou_alice' }),
        providerSend: jest.fn().mockResolvedValue(outcome),
      });
      expect(await h.service.testChannel('u-1', 'feishu')).toEqual({
        delivered: 0,
        channels: [],
        reason: 'delivery_failed',
      });
      expect({ kind: outcome.failureKind, writes: h.updates.length }).toEqual({
        kind: outcome.failureKind,
        writes: 0,
      });
      // 仍落台账（"发过这一条"是事实），只是不动验证态
      expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
    }
  });

  it('test：per-user 3/60s 入口闸 ⇒ 第 4 次 429，且不投递、不写台账/验证态', async () => {
    const h = makeHarness({ channel: channelRow() });
    for (let index = 0; index < 3; index += 1) {
      await h.service.testChannel('u-1', 'feishu');
    }
    const sendsBefore = h.providerSend.mock.calls.length;
    const writesBefore = h.updates.length;
    await expect(h.service.testChannel('u-1', 'feishu')).rejects.toMatchObject({ status: 429 });
    expect(h.providerSend.mock.calls.length).toBe(sendsBefore);
    expect(h.updates.length).toBe(writesBefore);
  });

  it('test：部署级出境总闸耗尽 ⇒ 429，且**完全不动验证态**（不是地址的判决）', async () => {
    const h = makeHarness({
      channel: channelRow(),
      gate: { allowed: false, retryAfterSeconds: 77 },
    });
    await expect(h.service.testChannel('u-1', 'feishu')).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 77,
    });
    expect(h.updates).toHaveLength(0);
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
  });

  it('M4：成功但地址已被他人验证（23505）⇒ 409', async () => {
    const h = makeHarness({
      channel: channelRow(),
      providerSend: jest.fn().mockResolvedValue(successOutcome()),
      updateThrows: Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_user_notification_channels_verified_address',
      }),
    });
    await expect(h.service.testChannel('u-1', 'feishu')).rejects.toMatchObject({ status: 409 });
  });

  it('m8：test 窗口 Map 在超阈值时回收窗口外键（键数不单调增长）', async () => {
    const h = makeHarness({ channel: channelRow() });
    const hits = (h.service as unknown as { testHits: Map<string, number[]> }).testHits;
    // 造 70 个"窗口外"的陈旧键（时间戳远早于窗口）
    for (let index = 0; index < 70; index += 1) hits.set(`stale-${index}`, [1]);
    expect(hits.size).toBe(70);
    await h.service.testChannel('u-1', 'feishu');
    // 触发一次清扫：陈旧键被 **delete**（不是 set 空数组）
    expect(hits.size).toBe(1);
    expect(hits.has('u-1')).toBe(true);
  });

  // ────────────────────── PUT/DELETE /me/prefs ──────────────────────

  it('PUT prefs：单条原子 jsonb_set 合并；返回归一后的完整映射（基座 = 缺省集）', async () => {
    const h = makeHarness();
    const result = await h.service.updatePrefs('u-1', {
      notificationCategories: { task_done: false },
    });

    expect(Object.keys(result).length).toBe(10);
    expect(result.task_done).toBe(false); // 显式关
    expect(result.topic).toBe(false); // 未提及 + 非缺省
  });

  it('PUT prefs：发出的 SQL 必须是 coalesce|| 的原子键级合并（防丢更新的关键形状）', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new NotificationSettingsService(
      {
        findOne: jest.fn(async () => ({
          id: 'u-1',
          role: UserRole.EDITOR,
          preferences: {},
          actor: { deletedAt: null },
        })),
        query,
      } as never,
      {} as never,
      { get: () => ({ ...NOTIFICATIONS_CONFIG_FALLBACK, enabled: true }) } as never,
      [] as never,
      {
        sendThroughProvider: jest.fn(),
        consumePlatformGate: jest.fn(),
        invalidateUser: jest.fn(),
      } as never,
      { record: jest.fn() } as never,
      { getMyTopicIds: jest.fn(), getMyBoardIds: jest.fn(), getMyDocSpaceIds: jest.fn() } as never,
    );
    await service.updatePrefs('u-1', { notificationCategories: { topic: false } });

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('jsonb_set');
    expect(sql).toContain('|| $2::jsonb');
    expect(sql).toContain("coalesce(preferences -> 'notificationCategories', '{}'::jsonb)");
  });

  it('DELETE prefs：键级删除（`preferences - notificationCategories`），返回缺省集', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new NotificationSettingsService(
      {
        findOne: jest.fn(async () => ({
          id: 'u-1',
          role: UserRole.EDITOR,
          preferences: {},
          actor: { deletedAt: null },
        })),
        query,
      } as never,
      {} as never,
      { get: () => ({ ...NOTIFICATIONS_CONFIG_FALLBACK, enabled: true }) } as never,
      [] as never,
      {
        sendThroughProvider: jest.fn(),
        consumePlatformGate: jest.fn(),
        invalidateUser: jest.fn(),
      } as never,
      { record: jest.fn() } as never,
      { getMyTopicIds: jest.fn(), getMyBoardIds: jest.fn(), getMyDocSpaceIds: jest.fn() } as never,
    );
    const result = await service.deletePrefs('u-1');
    expect(String(query.mock.calls[0][0])).toContain("preferences - 'notificationCategories'");
    expect(result.task_done).toBe(true); // 缺省集
    expect(result.topic).toBe(false);
  });

  it('写时失效（二期批 2）：渠道/偏好/验证态五处写路径都调用 orchestrator.invalidateUser', async () => {
    // 为什么这条必须有：per-user 快照缓存（60s）里装着"这个用户能不能投、投到哪、收哪些类别"。
    // 任何写路径漏掉失效 ⇒ 用户改了绑定/偏好却**在 TTL 窗口内不生效**（"我刚开好的通知没反应"）。
    const h = makeHarness({ channel: channelRow(), freshChannel: channelRow() });
    const invalidate = h.orchestrator.invalidateUser as jest.Mock;
    invalidate.mockClear();

    // ① PUT 渠道（新建/更新绑定）
    await h.service.upsertChannel('u-1', 'feishu', { recipientOpenId: 'ou_new' });
    expect(invalidate).toHaveBeenCalledWith('u-1');

    // ② DELETE 渠道（tombstone 解绑）
    invalidate.mockClear();
    await h.service.deleteChannel('u-1', 'feishu');
    expect(invalidate).toHaveBeenCalledWith('u-1');

    // ③ POST test（验证态可能从"不可投"翻成"可投"）
    invalidate.mockClear();
    await h.service.testChannel('u-1', 'feishu');
    expect(invalidate).toHaveBeenCalledWith('u-1');

    // ④ PUT prefs（用户关掉/打开某类）
    invalidate.mockClear();
    await h.service.updatePrefs('u-1', { notificationCategories: { topic: false } });
    expect(invalidate).toHaveBeenCalledWith('u-1');

    // ⑤ DELETE prefs（恢复缺省集）
    invalidate.mockClear();
    await h.service.deletePrefs('u-1');
    expect(invalidate).toHaveBeenCalledWith('u-1');
  });

  it('触发面查询使用合成的 human actor（role 来自 user 行，调用方不自报身份）', async () => {
    const h = makeHarness();
    await h.service.getMe('u-1');
    expect(h.accessQuery.getMyTopicIds).toHaveBeenCalledWith({
      id: 'u-1',
      type: ActorType.HUMAN,
      role: UserRole.EDITOR,
    });
    expect(h.errorSpy).not.toHaveBeenCalled();
  });
});
