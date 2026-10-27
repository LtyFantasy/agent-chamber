/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 二期 **D4 播种**（升级日平滑迁移）与**启动诊断**的单测矩阵：outcome 枚举、
 *     throw 判据（补救是否在进程之外）、单调事实判据（tombstone 不复活 / 换人拒绝）、
 *     台账回填门控（仅真插入才回填）、部署级出境总闸原语。
 *
 * [代码职责]
 *   - 用内存替身钉死播种的**分支与副作用边界**（真库面由 schema e2e 覆盖）
 *
 * [权威文档]
 *   - 主文档: 线上 `docs/spec.md` §3.2.33（播种判据/tombstone/部分唯一）/ skill
 *     `notifications/feishu-setup.md` §4-§5（播种语义、启动锚点、出境总闸）
 *
 * [关键不变量]（改动断言前先想清楚在防什么）
 *   - **throw 的唯一判据 = 补救动作在进程之外**：`skipped_no_source`（改 env）与 `failed` 抛；
 *     `ambiguous` / `address_taken` / `already_seeded` 一律 ERROR/INFO **不阻断启动**。
 *   - **解绑不复活**：判据用**单调事实**"该 user 无任意 feishu 行（含 tombstone）"——
 *     任何依赖会被业务动作覆写的 `source` 的判据都是错的。
 *   - **换人拒绝**：全表已有该 `recipient_address` 行 ⇒ 拒给另一个用户播种（地址是归属证明）。
 *   - **台账回填门控**：只有 `INSERT ... RETURNING` 真返回一行才回填 `recipient_user_id`。
 *   - **总闸超限不占额**：耗尽时返回剩余秒数且不推进窗口。
 *
 * [关联代码]
 *   - src/modules/notifications/notify-orchestrator.service.ts — `seedFromEnv` / `runStartupDiagnostics`
 *     / `consumePlatformGate`
 *   - test/user-notification-channels-schema.e2e-spec.ts — 真库面（部分唯一 / FK / 逐列）
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查)
 * =============================================================================
 */
import { Logger } from '@nestjs/common';
import { ActorType, UserRole } from '@agent-chamber/shared';
import { NotifyOrchestrator } from './notify-orchestrator.service';
import { NOTIFICATIONS_CONFIG_FALLBACK } from '../../config/notifications.config';

describe('NotifyOrchestrator 播种 / 启动诊断 / 出境总闸', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * 装配被测编排器（只为本套件用到的路径提供替身）。
   *
   * @param opts.settings 配置覆盖（缺省 = ENABLED + feishu 凭据齐 + 有地址 + 单 owner）
   * @param opts.ownerRows `resolveOwners` 的查询结果（username → actorId）
   * @param opts.channelCounts `channelRepo.count` 的顺序返回值（① 该 user 的行数 ② 全表地址行数）
   * @param opts.insertedId `INSERT ... RETURNING` 的返回（null = ON CONFLICT no-op）
   * @param opts.backfilled 台账回填返回的行数
   */
  function makeHarness(
    opts: {
      settings?: Record<string, unknown>;
      ownerRows?: Array<{ id: string; username: string }>;
      channelCounts?: number[];
      insertedId?: string | null;
      backfilled?: number;
    } = {},
  ) {
    const settings = {
      ...NOTIFICATIONS_CONFIG_FALLBACK,
      enabled: true,
      providers: ['feishu'],
      categories: ['task_done'],
      feishuAppId: 'cli_x',
      feishuAppSecret: 'secret',
      feishuRecipientOpenId: 'ou_alice',
      ownerUsernames: ['alice'],
      ...(opts.settings ?? {}),
    };

    // resolveOwners 的查询链
    const ownerBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(opts.ownerRows ?? [{ id: 'u-1', username: 'alice' }]),
    };
    const userRepo = { createQueryBuilder: jest.fn(() => ownerBuilder), find: jest.fn() };

    const counts = [...(opts.channelCounts ?? [0, 0])];
    const channelRepo = {
      count: jest.fn(async () => counts.shift() ?? 0),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
    };
    const manager = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (String(sql).includes('pg_advisory_xact_lock')) return [];
        if (String(sql).includes('INSERT INTO user_notification_channels')) {
          return opts.insertedId === null ? [] : [{ id: opts.insertedId ?? 'ch-1' }];
        }
        if (String(sql).includes('UPDATE notification_deliveries')) {
          // 台账回填：按要求的条数返回 id 行（调用方按 rows.length 计数）
          return Array.from({ length: opts.backfilled ?? 0 }, (_, index) => ({ id: `d${index}` }));
        }
        return [];
      }),
    };
    (channelRepo as unknown as { manager: unknown }).manager = {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    };

    // direct 无绑定预警走 `find({select})`（去重在 JS 侧；不依赖 mock 的 distinct）
    const agentRepo = { find: jest.fn().mockResolvedValue([]) };

    const service = new NotifyOrchestrator(
      { get: () => settings } as never,
      userRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      channelRepo as never,
      agentRepo as never,
      [] as never,
      { record: jest.fn() } as never,
      { resolveProfiles: jest.fn() } as never,
      {} as never,
    );

    return {
      service,
      settings,
      channelRepo,
      manager,
      userRepo,
      agentRepo,
      logSpy,
      warnSpy,
      errorSpy,
    };
  }

  // ─────────────────────────── D4 播种 ───────────────────────────

  it('播种前提不齐（未启用 / 无凭据 / 无地址）⇒ 返回 null 且不查库（"没配"不是"配错"）', async () => {
    const disabled = makeHarness({ settings: { enabled: false } });
    expect(await disabled.service.seedFromEnv()).toBeNull();

    const noCreds = makeHarness({ settings: { feishuAppSecret: null } });
    expect(await noCreds.service.seedFromEnv()).toBeNull();

    const noAddress = makeHarness({ settings: { feishuRecipientOpenId: null } });
    expect(await noAddress.service.seedFromEnv()).toBeNull();

    for (const h of [disabled, noCreds, noAddress]) {
      expect(h.channelRepo.count).not.toHaveBeenCalled();
    }
  });

  it('多用户名（>1）⇒ skipped_ambiguous：ERROR 但**不 throw**（补救在应用内）', async () => {
    const h = makeHarness({ settings: { ownerUsernames: ['alice', 'bob'] } });
    await expect(h.service.seedFromEnv()).resolves.toBe('skipped_ambiguous');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringContaining('skipped_ambiguous'));
    expect(h.channelRepo.count).not.toHaveBeenCalled();
  });

  it('有地址但 owner 名单为空 ⇒ **throw**（skipped_no_source：补救 = 改 env，在进程之外）', async () => {
    const h = makeHarness({ settings: { ownerUsernames: [] } });
    await expect(h.service.seedFromEnv()).rejects.toThrow(/skipped_no_source/);
  });

  it('名单有 1 个但解析不到活 actor ⇒ 同样 throw（skipped_no_source）', async () => {
    const h = makeHarness({ ownerRows: [] });
    await expect(h.service.seedFromEnv()).rejects.toThrow(/skipped_no_source/);
  });

  it('该 user 已有 feishu 行（**含 tombstone**）⇒ already_seeded，不写库（解绑后重启不复活）', async () => {
    const h = makeHarness({ channelCounts: [1, 0] });
    await h.service.resolveOwners(); // 播种读 resolveOwners 解析出的 ownerActorIds
    await expect(h.service.seedFromEnv()).resolves.toBe('already_seeded');
    // 判据只查"该 user 的 feishu 行数"（不过滤 tombstone）——这正是"解绑不复活"的实现方式
    expect(h.channelRepo.count).toHaveBeenCalledWith({
      where: { userId: 'u-1', provider: 'feishu' },
    });
    expect(h.manager.query).not.toHaveBeenCalled();
  });

  it('地址已被**别人**占用 ⇒ skipped_address_taken：ERROR 但**不 throw**（换人拒绝）', async () => {
    const h = makeHarness({ channelCounts: [0, 1] });
    await h.service.resolveOwners();
    await expect(h.service.seedFromEnv()).resolves.toBe('skipped_address_taken');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringContaining('skipped_address_taken'));
    expect(h.manager.query).not.toHaveBeenCalled();
  });

  it('正常播种：advisory lock + 事务 + INSERT（seeded/env_seed/enabled=true/last_test_address 回填）+ 台账回填 N', async () => {
    const h = makeHarness({ channelCounts: [0, 0], insertedId: 'ch-1', backfilled: 2 });
    await h.service.resolveOwners();
    await expect(h.service.seedFromEnv()).resolves.toBe('seeded');

    const sqls = h.manager.query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    const insertCall = h.manager.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO user_notification_channels'),
    );
    expect(insertCall).toBeDefined();
    expect(String(insertCall![0])).toContain('ON CONFLICT DO NOTHING');
    expect(String(insertCall![0])).toContain('RETURNING id');
    // 播种行必须满足验证不变量（last_test_address = 地址）+ 投递资格（enabled true / seeded）
    expect(String(insertCall![0])).toContain("'seeded'");
    expect(String(insertCall![0])).toContain("'env_seed'");
    expect(insertCall![1]).toEqual(['u-1', 'ou_alice']);

    // 台账回填只补 NULL，且带 user id + 地址
    const backfillCall = h.manager.query.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE notification_deliveries'),
    );
    expect(String(backfillCall![0])).toContain('recipient_user_id IS NULL');
    expect(backfillCall![1]).toEqual(['u-1', 'ou_alice']);

    expect(h.logSpy).toHaveBeenCalledWith(
      expect.stringContaining('seeded 1 binding + backfilled 2 deliveries'),
    );
  });

  it('ON CONFLICT no-op（并发窗口已插过）⇒ already_seeded + INFO，**不回填台账**', async () => {
    const h = makeHarness({ channelCounts: [0, 0], insertedId: null });
    await h.service.resolveOwners();
    await expect(h.service.seedFromEnv()).resolves.toBe('already_seeded');
    const sqls = h.manager.query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((sql) => sql.includes('UPDATE notification_deliveries'))).toBe(false);
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('no-op'));
  });

  // ─────────────────── 启动诊断 / 零绑定锚点 ───────────────────

  it('零绑定锚点：ENABLED + providers + categories 齐但 deliveryEligible 绑定数 0 ⇒ ERROR 不阻断', async () => {
    const h = makeHarness({ channelCounts: [0] });
    await h.service.onModuleInit();
    h.service.onModuleDestroy();
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringContaining('bound channels: 0'));
  });

  it('总闸自洽 WARN：platformLimit < perUserL2 × 绑定数 ⇒ WARN（关系声明可 grep）', async () => {
    const h = makeHarness({
      settings: { platformRateLimit: 3, globalRateLimit: 5, feishuRecipientOpenId: null },
      channelCounts: [4],
    });
    await h.service.onModuleInit();
    h.service.onModuleDestroy();
    expect(h.warnSpy).toHaveBeenCalledWith(expect.stringContaining('NOTIFY_PLATFORM_RATE_LIMIT'));
  });

  it('总开关关闭 ⇒ onModuleInit 完全静默（播种/诊断/定时器全不跑）', async () => {
    const h = makeHarness({ settings: { enabled: false } });
    await h.service.onModuleInit();
    expect(h.channelRepo.count).not.toHaveBeenCalled();
  });

  // ───────────────────── 部署级出境总闸原语 ─────────────────────

  it('consumePlatformGate：额度内放行；耗尽只回剩余秒数且**不推进窗口**', () => {
    const h = makeHarness({
      settings: { platformRateLimit: 2, platformRateWindowSeconds: 600, enabled: false },
    });

    expect(h.service.consumePlatformGate()).toEqual({ allowed: true });
    expect(h.service.consumePlatformGate()).toEqual({ allowed: true });

    const denied = h.service.consumePlatformGate();
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // 连续被拒不会把窗口越推越远（重试仍是同一窗口）
    expect(h.service.consumePlatformGate()).toEqual(denied);
  });
});
