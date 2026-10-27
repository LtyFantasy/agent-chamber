/**
 * notifications-provider.factory 单测（装配矩阵 + 诊断归属层）。
 *
 * 设计意图：provider 工厂是 **Logger 归属层**（config 工厂保持纯函数）——故这里的断言对象是
 * "启动日志说了什么"。四条硬边：
 * ① 零 provider **不是启动错误**（fail-open：通知是可选出口，配错出口不该让平台起不来），
 *    但必须响亮 warn（"开着通知却没有出口"是最容易配错的组合）；
 * ② config 的 warnings 只做**透传打印**（不得在其上再拼 env 原值）；
 * ③ 启用时必须打一行 INFO，它的出境字段清单与 `.env.example` / 生产 fail-fast 文案同源；
 * ④ **config 的键必须真的喂进叶子**（S3）：叶子不读 env，漏传只可能发生在本层——用"没配凭据
 *    ⇒ 零 HTTP 请求 / 配了凭据 ⇒ 真的发起请求"两个方向各钉一次（叶子内部的退避与分派由
 *    `feishu.notify-provider.spec.ts` 覆盖，本文件不重复）。
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  NOTIFICATIONS_CONFIG_FALLBACK,
  NOTIFY_CATEGORIES,
  NOTIFY_EGRESS_DECLARATION,
  type NotificationsConfig,
} from '../../config/notifications.config';
import type { RenderedNotification } from './notify-provider.interface';
import {
  createNotifyProviderList,
  createNotifyProviders,
  resolveNotificationsConfig,
} from './notifications-provider.factory';

describe('notifications-provider.factory', () => {
  function makeSettings(overrides: Partial<NotificationsConfig> = {}): NotificationsConfig {
    return {
      ...NOTIFICATIONS_CONFIG_FALLBACK,
      enabled: true,
      categories: [...NOTIFY_CATEGORIES],
      ...overrides,
    };
  }

  const asConfigService = (settings: NotificationsConfig | undefined): ConfigService =>
    ({ get: () => settings }) as unknown as ConfigService;

  /** 最小成品通知（出境面形状；装配用例只关心"有没有走到 HTTP"，不关心内容） */
  const renderedNotification = (): RenderedNotification => ({
    category: 'task_done',
    eventId: '3f8a1c2e-0000-4000-8000-000000000001',
    title: '[完工] 合成任务',
    body: '看板「合成看板」 · 合成操作者',
    link: 'https://web.test/tasks/3f8a1c2e-0000-4000-8000-000000000001',
    recipient: 'ou_synthetic_open_id',
  });

  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('按 NOTIFY_PROVIDERS 装配 provider（一期只有 feishu）', () => {
    const providers = createNotifyProviders(makeSettings({ providers: ['feishu'] }));
    expect(providers.map((provider) => provider.key)).toEqual(['feishu']);
  });

  it('空白名单 ⇒ 空数组（无出口；不是错误）', () => {
    expect(createNotifyProviders(makeSettings({ providers: [] }))).toEqual([]);
  });

  it('配置缺省兜底：`config.get` 返回 undefined ⇒ 回落 fallback（关闭 + 空出口）', () => {
    const settings = resolveNotificationsConfig(asConfigService(undefined));
    expect(settings.enabled).toBe(false);
    expect(settings.providers).toEqual([]);
  });

  it('总开关关闭 ⇒ 不打扰（无 INFO、无"零出口"warn）', () => {
    createNotifyProviderList(asConfigService(makeSettings({ enabled: false })));
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('config 的 warnings 逐条透传打印（本层不追加 env 原值）', () => {
    const warnings = ['NOTIFY_GLOBAL_RATE_LIMIT is not a positive integer — falling back to 5.'];
    createNotifyProviderList(asConfigService(makeSettings({ warnings })));
    expect(warnSpy).toHaveBeenCalledWith(warnings[0]);
  });

  it('启用 INFO 含 provider 列表、类别列表与**出境字段声明**（三处同源的第三处）', () => {
    createNotifyProviderList(asConfigService(makeSettings({ providers: ['feishu'] })));
    const info = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('notifications ENABLED'));
    expect(info).toBeDefined();
    // `.env.example` 的生效自检按行首这一串筛
    expect(info).toContain('notifications ENABLED');
    expect(info).toContain('providers=[feishu]');
    expect(info).toContain('task_done');
    // 出境声明的字面片段（同源：config 的 NOTIFY_EGRESS_DECLARATION）
    expect(info).toContain(NOTIFY_EGRESS_DECLARATION);
  });

  it('启用但零 provider ⇒ 一行 warn（fail-open：不抛，但必须响亮）', () => {
    const providers = createNotifyProviderList(asConfigService(makeSettings({ providers: [] })));
    expect(providers).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NOTIFY_PROVIDERS is empty'));
  });

  it('装了 feishu **不再**打"占位 / 未实现"字样（S3 真身：假提示会把排障引向错方向）', () => {
    createNotifyProviderList(asConfigService(makeSettings({ providers: ['feishu'] })));
    const lines = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => /placeholder|not implemented/i.test(line))).toHaveLength(0);
  });

  it('零 provider 的 warn 与启用 INFO 各自独立（不互相吞并）', () => {
    createNotifyProviderList(asConfigService(makeSettings({ providers: [] })));
    const lines = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('NOTIFY_PROVIDERS is empty'))).toHaveLength(1);
    const infoLines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(infoLines.filter((line) => line.includes('notifications ENABLED'))).toHaveLength(1);
  });

  // ─────────────── 装配正确性：config 的键真的喂进了叶子 ───────────────
  // 叶子（feishu.notify-provider.ts）刻意不读 env——所以"凭据没进叶子"这类错误只可能发生在
  // 本层。用两个方向各钉一次：没配 ⇒ 短路且**零 HTTP 请求**；配了 ⇒ 真的发起请求。

  it('未配凭据 ⇒ 首次投递短路 failed，且**不发任何 HTTP 请求**', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const [provider] = createNotifyProviders(
      makeSettings({ providers: ['feishu'], feishuAppId: null, feishuAppSecret: null }),
    );

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastError).toContain('credentials are not configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('已配凭据 ⇒ 真的发起请求（证明凭据是从 config 喂进来的）', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    const [provider] = createNotifyProviders(
      makeSettings({
        providers: ['feishu'],
        feishuAppId: 'cli_synthetic_app_id',
        feishuAppSecret: 'synthetic_secret',
        httpTimeoutMs: 50,
      }),
    );

    // maxAttempts=1：本用例只验"装配"，退避重试由叶子自己的 spec 覆盖（免 1s 真实等待）
    const outcome = await provider.send(renderedNotification(), { maxAttempts: 1 });

    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).toContain('timed out');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
