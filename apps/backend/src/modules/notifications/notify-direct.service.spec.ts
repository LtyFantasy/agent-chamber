/**
 * NotifyDirectService 单测（直发端点的服务侧契约）。
 *
 * 设计意图：本文件覆盖 plan §9 的"直发（幂等重放 / 409 冲突 / 毒化防护 / 429 header+body /
 * link 白名单 / reason 值域覆盖（七值 + 批 2 棒 B 的 `recipient_not_bound` = 八值）/ 同步预算）"
 * 里**服务侧**的那一半（`Retry-After` 头属 controller，
 * 见 notifications.controller.spec.ts）。
 *
 * 三条最贵的断言（改测试前先想清楚它们在防什么）：
 * ① **仅 200 结果进幂等缓存**：先被 429 挡回的调用**不得**污染幂等键——否则同键重放永远拿到
 *    "限流"旧信封（plan §11 的"幂等毒化"）。
 * ② **命中幂等不耗额度**：重放路径必须在节流**之前**返回（`reserveL2ForDirect` 不再被调用）。
 * ③ **L2 占额但永不合并**：耗尽时抛 429 并带上窗口剩余秒数，**绝不**把直发改写成摘要。
 */
import 'reflect-metadata';
import { ConflictException, Logger } from '@nestjs/common';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import {
  NOTIFICATIONS_CONFIG_FALLBACK,
  NOTIFY_CATEGORIES,
  type NotificationsConfig,
} from '../../config/notifications.config';
import type { UnifiedActor } from '../../common/types/actor.types';
import type {
  DeliveryOutcome,
  NotifyProvider,
  RenderedNotification,
} from './notify-provider.interface';
import {
  NOTIFY_DIRECT_CACHEABLE_REASONS,
  NOTIFY_DIRECT_REASONS,
  type NotifyDirectReason,
} from './notifications.constants';
import {
  NotifyDirectService,
  NotifyRateLimitedException,
  displayNameOf,
  fingerprintOf,
  renderDirectNotification,
  shouldCacheDirectEnvelope,
  type NotifyDirectEnvelope,
} from './notify-direct.service';

/** 成功终态 */
const SUCCESS_OUTCOME: DeliveryOutcome = {
  status: 'success',
  attempts: 1,
  responseStatus: 200,
  lastError: null,
  deliveredAt: new Date('2026-10-13T00:00:00.000Z'),
};

/** 失败终态（网络层失败：没有响应码） */
const FAILED_OUTCOME: DeliveryOutcome = {
  status: 'failed',
  attempts: 2,
  responseStatus: null,
  lastError: 'network: connection refused',
  deliveredAt: null,
};

const ACTOR: UnifiedActor = {
  id: 'actor-agent-1',
  type: ActorType.AGENT,
  name: 'nightcrawler',
  // Notifications 二期批 2：直发的收件人 = 调用 agent 的 `ownerId`（见 notify-direct.service.ts）
  ownerId: 'creator-user-1',
};

/** 人类调用者（直发给自己 ⇒ `self_echo`；`ownerId` 刻意不填——见 actor.types.ts 踩坑 O1） */
const HUMAN_ACTOR: UnifiedActor = {
  id: 'human-owner-1',
  type: ActorType.HUMAN,
  name: 'Owner',
};

/** 测试用配置（缺省 = 全部可用：开启 + direct 类别开 + 有出口 + 有收件人 + 有基址） */
function makeSettings(overrides: Partial<NotificationsConfig> = {}): NotificationsConfig {
  return {
    ...NOTIFICATIONS_CONFIG_FALLBACK,
    enabled: true,
    categories: [...NOTIFY_CATEGORIES],
    providers: ['feishu'],
    feishuRecipientOpenId: 'ou_owner',
    webBaseUrl: 'https://platform.example.com',
    directRateLimitPerWindow: 6,
    directRateWindowSeconds: 600,
    globalRateLimit: 5,
    globalRateWindowSeconds: 600,
    ...overrides,
  };
}

interface Harness {
  service: NotifyDirectService;
  /** 编排器替身：三个复用入口（真实实现由 notify-orchestrator.service.spec.ts 覆盖） */
  orchestrator: {
    resolveDirectTarget: jest.Mock;
    reserveL2ForDirect: jest.Mock;
    sendThroughProvider: jest.Mock;
    noteDeliveryOutcome: jest.Mock;
  };
  provider: NotifyProvider & { send: jest.Mock };
  deliveryRepo: { record: jest.Mock };
  /** `sendThroughProvider` 收到的成品通知（出境面断言用） */
  sent: RenderedNotification[];
  logSpy: jest.SpyInstance;
}

/**
 * 装配被测服务（编排器 / provider / 落库全为内存替身）。
 *
 * ⚠️ `sendThroughProvider` 被替换成"记录 + 返回给定终态"：真实兜底（违约 provider 的
 * 异常合成）由编排器自己的 spec 覆盖，本文件只关心直发链路的编排顺序与信封形状。
 *
 * @param settings 配置
 * @param outcome provider 终态（缺省成功）
 */
function makeHarness(
  settings: NotificationsConfig = makeSettings(),
  outcome: DeliveryOutcome = SUCCESS_OUTCOME,
): Harness {
  const sent: RenderedNotification[] = [];
  const provider = {
    key: 'feishu',
    send: jest.fn().mockResolvedValue(outcome),
  } as unknown as NotifyProvider & { send: jest.Mock };

  const orchestrator = {
    // 直发收件人解析：缺省 = "creator 有一个 deliveryEligible 绑定，主渠道是 feishu / 配置里的地址"
    resolveDirectTarget: jest.fn(async () =>
      settings.feishuRecipientOpenId === null
        ? null
        : { provider: 'feishu', recipientAddress: settings.feishuRecipientOpenId },
    ),
    reserveL2ForDirect: jest.fn().mockReturnValue({ allowed: true }),
    sendThroughProvider: jest.fn(
      async (_provider: NotifyProvider, rendered: RenderedNotification) => {
        sent.push(rendered);
        return outcome;
      },
    ),
    // S4 起直发落库后也走这个共用计数（连续 failed ⇒ 一行周期 warn），替身必须同步
    noteDeliveryOutcome: jest.fn(),
  };

  const deliveryRepo = { record: jest.fn().mockResolvedValue(undefined) };

  const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

  const service = new NotifyDirectService(
    { get: () => settings } as never,
    settings.providers.length > 0 ? [provider] : [],
    orchestrator as never,
    deliveryRepo as never,
  );

  return { service, orchestrator, provider, deliveryRepo, sent, logSpy };
}

describe('NotifyDirectService 直发管线', () => {
  /** 可控时钟（节流窗口与幂等 TTL 都以 `Date.now()` 为基准） */
  let now = new Date('2026-10-13T10:00:00.000Z').getTime();
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    now = new Date('2026-10-13T10:00:00.000Z').getTime();
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    jest.restoreAllMocks();
  });

  // ───────────────────────── 成功路径与出境面 ─────────────────────────

  it('成功直发：delivered=1 + channels=[出口]，落库一行 category=direct / eventId=null', async () => {
    const h = makeHarness();

    const envelope = await h.service.send(ACTOR, { text: '需要你拍板一件事' });

    expect(envelope).toEqual({ delivered: 1, channels: ['feishu'] });
    expect(h.orchestrator.reserveL2ForDirect).toHaveBeenCalledWith('creator-user-1');
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
    const row = h.deliveryRepo.record.mock.calls[0][0];
    expect(row.category).toBe('direct');
    // 直发没有事件源（plan §7.1）：NULL 让"事件触发的通知"在数据面可分辨
    expect(row.eventId).toBeNull();
    expect(row.channel).toBe('feishu');
    expect(row.recipient).toBe('ou_owner');
    // 归属列（批 2 棒 B 的四路径之一）：直发的收件人 = 调用 agent 的 owner
    expect(row.recipientUserId).toBe('creator-user-1');
    expect(row.outcome).toBe(SUCCESS_OUTCOME);
  });

  it('出境面：title=[<agent 名>] / body=agent 正文 / link=基址+相对路径（服务端拼）', async () => {
    const h = makeHarness();

    await h.service.send(ACTOR, { text: '正文', link: '/tasks/abc' });

    const rendered = h.sent[0];
    expect(rendered.title).toBe('[nightcrawler]');
    expect(rendered.body).toBe('正文');
    expect(rendered.link).toBe('https://platform.example.com/tasks/abc');
    expect(rendered.category).toBe('direct');
    expect(rendered.eventId).toBeNull();
  });

  it('同步预算：调用 provider 时固定传 ≤2 次尝试 / ≤10s（agent 客户端超时保护）', async () => {
    const h = makeHarness();

    await h.service.send(ACTOR, { text: 'x' });

    // 预算是**调用点**的责任（叶子的缺省档是事件链路：3 次、无总预算）
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(1);
    expect(h.orchestrator.sendThroughProvider.mock.calls[0][2]).toEqual({
      maxAttempts: 2,
      budgetMs: 10_000,
    });
  });

  it('投递全失败：delivered=0 + channels=[] + reason=delivery_failed，仍落库终态 + 进共用告警计数', async () => {
    const h = makeHarness(makeSettings(), FAILED_OUTCOME);

    const envelope = await h.service.send(ACTOR, { text: 'x' });

    expect(envelope).toEqual({ delivered: 0, channels: [], reason: 'delivery_failed' });
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
    expect(h.deliveryRepo.record.mock.calls[0][0].outcome.status).toBe('failed');
    // P2-5：直发的失败**必须**进编排器那个共用计数（连续 N 条 failed ⇒ 一行周期 warn）。
    // 各记各的计数会让"连续 5 条"永远凑不满（两条链路互相稀释）——直发的失败就再也没有运维信号。
    expect(h.orchestrator.noteDeliveryOutcome).toHaveBeenCalledWith('failed', 'direct');
  });

  // ───────────────────────── 降级信封（reason 可达性） ─────────────────────────

  it('notify_disabled：总开关关闭 ⇒ 一切静默（不占额度、不落库、不调 provider）', async () => {
    const h = makeHarness(makeSettings({ enabled: false }));

    const envelope = await h.service.send(ACTOR, { text: 'x' });

    expect(envelope).toEqual({ delivered: 0, channels: [], reason: 'notify_disabled' });
    expect(h.orchestrator.reserveL2ForDirect).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
    expect(h.orchestrator.sendThroughProvider).not.toHaveBeenCalled();
  });

  it('category_disabled：运维把 direct 类别关了 ⇒ 200 降级（不占额度、不落库）', async () => {
    const h = makeHarness(makeSettings({ categories: ['task_done'] }));

    const envelope = await h.service.send(ACTOR, { text: 'x' });

    expect(envelope).toEqual({ delivered: 0, channels: [], reason: 'category_disabled' });
    expect(h.orchestrator.reserveL2ForDirect).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
  });

  it('self_echo：**人类**调用者给自己发（人不需要通知自己）', async () => {
    const h = makeHarness();

    const envelope = await h.service.send(HUMAN_ACTOR, { text: 'x' });

    expect(envelope).toEqual({ delivered: 0, channels: [], reason: 'self_echo' });
    expect(h.orchestrator.resolveDirectTarget).not.toHaveBeenCalled();
    expect(h.orchestrator.reserveL2ForDirect).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
  });

  it('**agent 永不被自回声吞掉**（即便它就在收件人名下）：它给 creator 发的消息必须真发出去', async () => {
    const h = makeHarness();

    // 这条用例是 `direct 不适用"我的 agent"泛化` 的单测守卫：事件链路的自回声判据
    // （`actor.id ∈ 收件人的 agents`）在这里**恒成立**（收件人就是它的 owner），照搬就会把
    // 每一条 agent 直发都吞掉——症状是调用方拿到 delivered=1 而人什么都没收到。
    expect(ACTOR.ownerId).toBe('creator-user-1');
    const envelope = await h.service.send(ACTOR, { text: 'x' });

    expect(envelope).toEqual({ delivered: 1, channels: ['feishu'] });
    expect(h.orchestrator.resolveDirectTarget).toHaveBeenCalledWith('creator-user-1');
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(1);
  });

  it('no_provider：开着通知却没配出口 ⇒ 200 降级，且**不占 L2 额度**', async () => {
    const h = makeHarness(makeSettings({ providers: [] }));

    const envelope = await h.service.send(ACTOR, { text: 'x' });

    expect(envelope).toEqual({ delivered: 0, channels: [], reason: 'no_provider' });
    // 为一次"可证明发不出去"的投递先占人类额度 = 用运维失误挤掉他该收的通知
    expect(h.orchestrator.reserveL2ForDirect).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
  });

  it('recipient_not_bound：creator **没有任何 deliveryEligible 绑定** ⇒ 200 降级 + 不占 L2 额度', async () => {
    const h = makeHarness();
    h.orchestrator.resolveDirectTarget.mockResolvedValue(null);

    const envelope = await h.service.send(ACTOR, { text: 'x' });

    expect(envelope).toEqual({ delivered: 0, channels: [], reason: 'recipient_not_bound' });
    expect(h.orchestrator.reserveL2ForDirect).not.toHaveBeenCalled();
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
  });

  it('recipient_not_bound：**不进幂等缓存** ⇒ creator 绑好之后同键重放能真发', async () => {
    const h = makeHarness();
    const key = `k-${Math.random()}`;
    h.orchestrator.resolveDirectTarget.mockResolvedValue(null);

    const first = await h.service.send(ACTOR, { text: 'x', clientRequestId: key });
    expect(first.reason).toBe('recipient_not_bound');

    // creator 把渠道绑上了（用户自己的动作，10 分钟内完全可能发生）
    h.orchestrator.resolveDirectTarget.mockResolvedValue({
      provider: 'feishu',
      recipientAddress: 'ou_owner',
    });
    const second = await h.service.send(ACTOR, { text: 'x', clientRequestId: key });

    expect(second).toEqual({ delivered: 1, channels: ['feishu'] });
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(1);
  });

  it('no_recipient：**身份投影里没有可解析的 creator**（畸形 agent 身份）⇒ 200 降级', async () => {
    const h = makeHarness();

    const envelope = await h.service.send({ ...ACTOR, ownerId: undefined }, { text: 'x' });

    // 与 `recipient_not_bound` 刻意分开："认不出你的 creator" 与 "你的 creator 还没绑渠道"
    // 是两件事（前者的补救在运维侧，后者的补救在用户自己手里）
    expect(envelope).toEqual({ delivered: 0, channels: [], reason: 'no_recipient' });
    expect(h.orchestrator.resolveDirectTarget).not.toHaveBeenCalled();
    expect(h.orchestrator.reserveL2ForDirect).not.toHaveBeenCalled();
  });

  it('降级信封**两分支同形**：delivered/channels 恒在、reason 只在降级时出现', async () => {
    const degraded: NotifyDirectEnvelope[] = [];
    for (const settings of [
      makeSettings({ enabled: false }),
      makeSettings({ categories: [] }),
      makeSettings({ providers: [] }),
      makeSettings({ feishuRecipientOpenId: null }),
    ]) {
      const h = makeHarness(settings);
      degraded.push(await h.service.send(ACTOR, { text: 'x' }));
    }
    degraded.push(await makeHarness().service.send(HUMAN_ACTOR, { text: 'x' }));
    const failed = await makeHarness(makeSettings(), FAILED_OUTCOME).service.send(ACTOR, {
      text: 'x',
    });
    degraded.push(failed);

    for (const envelope of degraded) {
      expect(Object.keys(envelope).sort()).toEqual(['channels', 'delivered', 'reason']);
      expect(Array.isArray(envelope.channels)).toBe(true);
      expect(envelope.channels).toEqual([]);
      expect(envelope.delivered).toBe(0);
      expect(NOTIFY_DIRECT_REASONS).toContain(envelope.reason);
    }

    // 成功分支：**没有 reason 字段**（不是 reason: null）
    const ok = await makeHarness().service.send(ACTOR, { text: 'x' });
    expect(Object.keys(ok).sort()).toEqual(['channels', 'delivered']);
  });

  it('reason 值域是封闭八值（含预留的 rate_limited——正常 429 走 HTTP 码）', () => {
    expect([...NOTIFY_DIRECT_REASONS].sort()).toEqual([
      'category_disabled',
      'delivery_failed',
      'no_provider',
      'no_recipient',
      'notify_disabled',
      'rate_limited',
      'recipient_not_bound',
      'self_echo',
    ]);
  });

  it('可达的七条降级路径逐条命中（rate_limited 不产 200 信封，它是 429 的占位值）', async () => {
    const reachable = new Map<NotifyDirectReason, boolean>();
    const cases: Array<{
      reason: NotifyDirectReason;
      settings: NotificationsConfig;
      actor: UnifiedActor;
      creatorUnbound?: boolean;
    }> = [
      { reason: 'notify_disabled', settings: makeSettings({ enabled: false }), actor: ACTOR },
      { reason: 'category_disabled', settings: makeSettings({ categories: [] }), actor: ACTOR },
      { reason: 'self_echo', settings: makeSettings(), actor: HUMAN_ACTOR },
      { reason: 'no_provider', settings: makeSettings({ providers: [] }), actor: ACTOR },
      // 身份投影缺 creator（畸形请求）
      { reason: 'no_recipient', settings: makeSettings(), actor: { ...ACTOR, ownerId: undefined } },
      // creator 存在但没绑渠道
      {
        reason: 'recipient_not_bound',
        settings: makeSettings(),
        actor: ACTOR,
        creatorUnbound: true,
      },
    ];
    for (const c of cases) {
      const h = makeHarness(c.settings);
      if (c.creatorUnbound) h.orchestrator.resolveDirectTarget.mockResolvedValue(null);
      const envelope = await h.service.send(c.actor, { text: 'x' });
      reachable.set(envelope.reason as NotifyDirectReason, true);
    }
    const failed = await makeHarness(makeSettings(), FAILED_OUTCOME).service.send(ACTOR, {
      text: 'x',
    });
    reachable.set(failed.reason as NotifyDirectReason, true);

    expect([...reachable.keys()].sort()).toEqual([
      'category_disabled',
      'delivery_failed',
      'no_provider',
      'no_recipient',
      'notify_disabled',
      'recipient_not_bound',
      'self_echo',
    ]);
  });

  // ───────────────────────── 429（入口闸 / L2 耗尽） ─────────────────────────

  it('入口节流超限：抛 429 + code 429 + data.retryAfterSeconds（头由 controller 设）', async () => {
    const h = makeHarness(makeSettings({ directRateLimitPerWindow: 1 }));

    await h.service.send(ACTOR, { text: 'first' });
    let caught: unknown;
    try {
      await h.service.send(ACTOR, { text: 'second' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NotifyRateLimitedException);
    const err = caught as NotifyRateLimitedException;
    expect(err.getStatus()).toBe(429);
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    const body = err.getResponse() as {
      code: number;
      message: string;
      data: { retryAfterSeconds: number };
    };
    expect(body.code).toBe(ErrorCode.RATE_LIMITED);
    expect(body.data.retryAfterSeconds).toBe(err.retryAfterSeconds);
    // 文案必须自带"下一步"（Do NOT retry immediately）与"同键重放安全"两条指引
    expect(body.message).toContain('Do NOT retry immediately');
    expect(body.message).toContain('NOT recorded against your clientRequestId');
    // 被挡下的这次**没有投递、没有落库**
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
  });

  it('入口节流：被挡下的调用**不记账**（窗口滚过后立刻恢复，而不是被自己越锁越久）', async () => {
    const h = makeHarness(
      makeSettings({ directRateLimitPerWindow: 1, directRateWindowSeconds: 10 }),
    );

    await h.service.send(ACTOR, { text: 'a' }); // t0：占掉唯一位额
    now += 5_000;
    const throttled = await h.service.send(ACTOR, { text: 'b' }).catch((e) => e);

    expect(throttled).toBeInstanceOf(NotifyRateLimitedException);
    // 剩余 = 10s 窗口 − 已过 5s
    expect((throttled as NotifyRateLimitedException).retryAfterSeconds).toBe(5);

    now += 5_500; // t0+10.5s：窗口已滚过
    const envelope = await h.service.send(ACTOR, { text: 'c' });

    // 若"被挡下的那次"记了账，t0+5s 的那条记录会留在新窗口里 ⇒ 这里仍是 429
    expect(envelope).toEqual({ delivered: 1, channels: ['feishu'] });
  });

  it('L2 耗尽：抛 429，retryAfterSeconds = 窗口剩余秒数，且**不入摘要**（不落 digest 行）', async () => {
    const h = makeHarness();
    h.orchestrator.reserveL2ForDirect.mockReturnValue({ allowed: false, retryAfterSeconds: 321 });

    const caught = await h.service.send(ACTOR, { text: 'x' }).catch((e) => e);

    expect(caught).toBeInstanceOf(NotifyRateLimitedException);
    const err = caught as NotifyRateLimitedException;
    expect(err.retryAfterSeconds).toBe(321);
    expect(
      (err.getResponse() as { data: { retryAfterSeconds: number } }).data.retryAfterSeconds,
    ).toBe(321);
    // 直发被 L2 挡住时**什么都不发**：不改写成"另有 N 条"摘要，也不落任何投递行
    expect(h.deliveryRepo.record).not.toHaveBeenCalled();
    expect(h.orchestrator.sendThroughProvider).not.toHaveBeenCalled();
  });

  // ───────────────────────── 幂等 ─────────────────────────

  it('幂等命中：同键同载荷重放返回**首次信封**，且不重复投递、不再占额度', async () => {
    const h = makeHarness();

    const first = await h.service.send(ACTOR, { text: '同一条', clientRequestId: 'k1' });
    const second = await h.service.send(ACTOR, { text: '同一条', clientRequestId: 'k1' });

    expect(second).toEqual(first);
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(1);
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
    // 命中路径在节流**之前**返回 ⇒ 重放不耗额度
    expect(h.orchestrator.reserveL2ForDirect).toHaveBeenCalledTimes(1);
  });

  it('幂等命中：**失败的首次结果同样被重放**（delivery_failed 是终态，要换新键才真重跑）', async () => {
    const h = makeHarness(makeSettings(), FAILED_OUTCOME);

    const first = await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k1' });
    const second = await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k1' });

    expect(first).toEqual({ delivered: 0, channels: [], reason: 'delivery_failed' });
    expect(second).toEqual(first);
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(1);
  });

  it('同键异载荷：409 / 9002（拒绝重放一个描述着"另一条消息"的信封）', async () => {
    const h = makeHarness();
    await h.service.send(ACTOR, { text: '第一条', clientRequestId: 'k1' });

    const caught = await h.service
      .send(ACTOR, { text: '第二条', clientRequestId: 'k1' })
      .catch((e) => e);

    expect(caught).toBeInstanceOf(ConflictException);
    const res = (caught as ConflictException).getResponse() as { code: number; message: string };
    expect((caught as ConflictException).getStatus()).toBe(409);
    expect(res.code).toBe(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);
    // 409 文案给出两条可行路径；不回显正文
    expect(res.message).toContain('NEW clientRequestId');
    expect(res.message).not.toContain('第二条');
    // 且**没有**第二次投递
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(1);
  });

  it('同键但 link 不同 → 同样 409（指纹 = text + link）', async () => {
    const h = makeHarness();
    await h.service.send(ACTOR, { text: 'x', link: '/tasks/a', clientRequestId: 'k1' });

    const caught = await h.service
      .send(ACTOR, { text: 'x', link: '/tasks/b', clientRequestId: 'k1' })
      .catch((e) => e);

    expect(caught).toBeInstanceOf(ConflictException);
  });

  it('不同键：各自真发（互不影响）', async () => {
    const h = makeHarness();

    await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k1' });
    await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k2' });

    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(2);
  });

  it('幂等键是 **per-actor** 的：另一个 actor 用同一个键不受影响', async () => {
    const h = makeHarness();
    await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k1' });

    // ⚠️ 另一个 actor 也必须有 `ownerId`（批 2 起收件人 = 调用 agent 的 owner，缺它就降级成
    // `no_recipient`，这条用例会变成在测另一件事）
    const other = {
      id: 'actor-agent-2',
      type: ActorType.AGENT,
      name: 'other',
      ownerId: 'creator-user-2',
    };
    const envelope = await h.service.send(other, { text: 'y', clientRequestId: 'k1' });

    expect(envelope.delivered).toBe(1);
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(2);
  });

  it('不传 clientRequestId ⇒ 不做幂等（每次都真发）', async () => {
    const h = makeHarness();

    await h.service.send(ACTOR, { text: 'x' });
    await h.service.send(ACTOR, { text: 'x' });

    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(2);
  });

  it('**毒化防护**：被 429 挡下的调用不写幂等缓存 ⇒ 窗口过后同键重放是真发', async () => {
    const h = makeHarness(
      makeSettings({ directRateLimitPerWindow: 1, directRateWindowSeconds: 2 }),
    );

    await h.service.send(ACTOR, { text: 'other' }); // 占掉唯一位额
    const throttled = await h.service
      .send(ACTOR, { text: 'x', clientRequestId: 'k1' })
      .catch((e) => e);
    expect(throttled).toBeInstanceOf(NotifyRateLimitedException);

    now += 3000; // 窗口滚动

    const envelope = await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k1' });

    // 若 429 写进了缓存，这里会拿到"限流"旧信封（agent 永远等不到真实结果）
    expect(envelope).toEqual({ delivered: 1, channels: ['feishu'] });
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(2);
  });

  it('幂等 TTL 10 分钟后失效（同键变成一次新的发送）', async () => {
    const h = makeHarness();
    await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k1' });

    now += 10 * 60 * 1000 + 1;

    await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k1' });

    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(2);
  });

  it('**配置类降级不进幂等缓存**：同一实例内把配置修好，同键第二次必须真发', async () => {
    // 必须用**同一个实例**改配置（`makeHarness` 把 settings 对象引用交给服务 ⇒ 改它就等于
    // "运维修好了"）：两个实例各测一次证明不了缓存判据——每个实例的缓存本来就是空的。
    const settings = makeSettings({ categories: ['task_done'] }); // direct 类别关着
    const h = makeHarness(settings);

    const degraded = await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k1' });
    expect(degraded).toEqual({ delivered: 0, channels: [], reason: 'category_disabled' });
    expect(h.orchestrator.sendThroughProvider).not.toHaveBeenCalled();

    settings.categories = [...NOTIFY_CATEGORIES]; // 运维把 direct 打开

    const envelope = await h.service.send(ACTOR, { text: 'x', clientRequestId: 'k1' });

    // 若降级信封进了缓存，这里会拿到那句"类别被关了"的旧结论 —— 调用方被骗满 10 分钟
    expect(envelope).toEqual({ delivered: 1, channels: ['feishu'] });
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(1);
  });

  it('缓存判据：成功 / delivery_failed / self_echo 进缓存；配置类与 rate_limited 不进', () => {
    // 成功分支**没有 reason 字段**
    expect(shouldCacheDirectEnvelope({ delivered: 1, channels: ['feishu'] })).toBe(true);
    expect(
      shouldCacheDirectEnvelope({ delivered: 0, channels: [], reason: 'delivery_failed' }),
    ).toBe(true);
    expect(shouldCacheDirectEnvelope({ delivered: 0, channels: [], reason: 'self_echo' })).toBe(
      true,
    );
    // per-user 状态（creator 随时可能把渠道绑上）⇒ **绝不能**缓存住这条结论
    expect(
      shouldCacheDirectEnvelope({ delivered: 0, channels: [], reason: 'recipient_not_bound' }),
    ).toBe(false);
    // rate_limited 是 429 的占位值，不产 200 信封 ⇒ 不进（防御性：万一将来内嵌进 200）
    expect(shouldCacheDirectEnvelope({ delivered: 0, channels: [], reason: 'rate_limited' })).toBe(
      false,
    );
    // 值域闭合：每个 reason 都有明确判据（新增 reason 必须同时更新判据与值域，否则这里会红）
    for (const reason of NOTIFY_DIRECT_REASONS) {
      const cached = shouldCacheDirectEnvelope({ delivered: 0, channels: [], reason });
      expect(typeof cached).toBe('boolean');
    }
    expect(NOTIFY_DIRECT_CACHEABLE_REASONS).toEqual(['delivery_failed', 'self_echo']);
  });

  // ⚠️ `delivery_failed` 的**缓存语义**（进缓存 ⇒ 同键重放拿到同一条失败结论、要真重跑必须换新键）
  // 已由上面的「幂等命中：**失败的首次结果同样被重放**」用例锁定，此处不再重复一份。

  it('**并发同键只真发一次**（in-flight 占位；读缓存挡不住"还没写进缓存的并发"）', async () => {
    const h = makeHarness();
    // 门控：把第一次投递卡住，等两个请求都进入管线后再放行（没有门控的话先到的那个会先 settle）
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.orchestrator.sendThroughProvider.mockImplementation(
      async (_provider: NotifyProvider, rendered: RenderedNotification) => {
        h.sent.push(rendered);
        await gate;
        return SUCCESS_OUTCOME;
      },
    );

    const first = h.service.send(ACTOR, { text: '并发同一条', clientRequestId: 'k1' });
    const second = h.service.send(ACTOR, { text: '并发同一条', clientRequestId: 'k1' });
    // 两个请求都已在飞（第一个 await 门控，第二个共享同一个 promise）
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(1);
    expect(h.deliveryRepo.record).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ delivered: 1, channels: ['feishu'] });
    // 同一个信封对象（共享同一次投递的结果，不是两次各自的结论）
    expect(b).toBe(a);
    expect(h.logSpy).toHaveBeenCalledWith(expect.stringContaining('joined [in_flight]'));
  });

  it('**并发同键异载荷仍 409**（指纹校验在共享之前，不能因为"刚好在飞"就放行）', async () => {
    const h = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.orchestrator.sendThroughProvider.mockImplementation(async () => {
      await gate;
      return SUCCESS_OUTCOME;
    });

    const first = h.service.send(ACTOR, { text: '第一条', clientRequestId: 'k1' });
    const second = await h.service
      .send(ACTOR, { text: '第二条', clientRequestId: 'k1' })
      .catch((err) => err);
    release();
    await first;

    expect(second).toBeInstanceOf(ConflictException);
    expect((second as ConflictException).getStatus()).toBe(409);
    expect(h.orchestrator.sendThroughProvider).toHaveBeenCalledTimes(1);
  });

  // ⚠️「在飞请求 settle 后摘牌」由上面的「**毒化防护**」用例顺带守着：429 那次既不进缓存，
  // 又必须把 in-flight 占位摘掉——否则窗口滚动后的同键重放会 await 到那个已 reject 的旧 promise，
  // 永远拿不到真实结果（那条用例断言"窗口过后同键重放**必须真发**"，正是这条不变量的探针）。
});

describe('直发渲染纯函数', () => {
  it('fingerprintOf：text 与 link 都必须参与（分隔符是 NUL，正文不可能带）', () => {
    expect(fingerprintOf({ text: 'a', link: '/tasks/1' })).not.toBe(
      fingerprintOf({ text: 'a', link: '/tasks/2' }),
    );
    expect(fingerprintOf({ text: 'a' })).toBe(fingerprintOf({ text: 'a', link: undefined }));
    // 边界：把分隔符写进正文也不会与 "text=a, link=b" 撞成同一指纹
    expect(fingerprintOf({ text: 'a\u0000/tasks/1' })).not.toBe(
      fingerprintOf({ text: 'a', link: '/tasks/1' }),
    );
  });

  it('displayNameOf：有名字用名字，没名字回落 actor id（不伪造 "unknown agent"）', () => {
    expect(displayNameOf(ACTOR)).toBe('nightcrawler');
    expect(displayNameOf({ id: 'a-1', type: ActorType.AGENT, name: '  ' })).toBe('a-1');
    expect(displayNameOf({ id: 'a-1', type: ActorType.AGENT })).toBe('a-1');
  });

  it('renderDirectNotification：未配 web 基址 ⇒ link 归 null（不伪造相对链接）', () => {
    const rendered = renderDirectNotification('n', { text: 'x', link: '/tasks/1' }, 'ou', null);
    expect(rendered.link).toBeNull();
  });

  it('renderDirectNotification：link 缺席 ⇒ link null', () => {
    const rendered = renderDirectNotification('n', { text: 'x' }, 'ou', 'https://a');
    expect(rendered.link).toBeNull();
  });

  it('renderDirectNotification：超长 actor 名被截到列宽 200 以内', () => {
    const rendered = renderDirectNotification('n'.repeat(500), { text: 'x' }, 'ou', null);
    expect(rendered.title.length).toBeLessThanOrEqual(200);
  });
});
