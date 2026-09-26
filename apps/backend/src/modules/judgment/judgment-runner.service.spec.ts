/**
 * judgment-runner.service 单测（通用编排：闸门 → 调用 → 独立日志行）。
 *
 * 设计意图：通用 runner 是"搜索重排"这类**非事务调用点**的唯一入口，它的四种结局各对应一种
 * 可观测行为，混错就会污染指标口径：
 * - `disabled`（provider=none / 能力未启用） = **短路**：不调用、不写行、不占额度；
 * - `skipped`（额度 / 出境 / 可见性闸） = 写**标量**行（`{skipped:true, reason}`）、计额度；
 * - `ok` / `error` / `timeout` = 写行（含 latency、错误分类）。
 * 另外钉死两条安全线：**日志载荷必过 redaction + 体积硬顶**（标 `logRedacted`）、
 * **通用行的 experienceId 恒 null 且不落原文**。
 */
import { Logger } from '@nestjs/common';
import type { UnifiedActor } from '../../common/types/actor.types';
import type { JudgmentConfig } from '../../config/judgment.config';
import type { ExperienceJudgmentRecord } from '../../database/entities/experience-judgment-record.entity';
import type {
  JudgmentCapability,
  JudgmentOutcome,
  JudgmentProvider,
} from './judgment-capability.interface';
import { JudgmentQuotaService } from './judgment-quota.service';
import { JUDGMENT_PROVIDER } from './judgment-capability.interface';
import { JUDGMENT_CONFIG } from './judgment-provider.factory';
import { JudgmentRunnerService } from './judgment-runner.service';

const ACTOR: UnifiedActor = { id: 'aaaaaaaa-1111-4111-8111-111111111111', type: 'agent' } as never;

function configOf(overrides: Partial<JudgmentConfig> = {}): JudgmentConfig {
  return {
    provider: 'typesafe',
    baseUrl: 'https://api.typesafe.ai',
    apiKey: 'k',
    typesafeModel: 'jev-latest',
    timeoutMs: 5000,
    rateLimitPerHour: 1000,
    globalRateLimitPerHour: 1000,
    capabilityRateLimitPerHour: 1000,
    capabilities: ['rerank'],
    warnings: [],
    ...overrides,
  };
}

/** 测试能力（形状最小化：只需要走通"发问/归一化/日志载荷/出境闸"四条缝） */
function capabilityOf(
  overrides: Partial<JudgmentCapability<{ q: string }, { tier: number }>> = {},
): JudgmentCapability<{ q: string }, { tier: number }> {
  return {
    name: 'rerank',
    rubricVersion: 'v1',
    buildQuestions: () => ({ c0: { type: 'score', instructions: 'x', criteria: ['a'] } }),
    buildState: (input) => ({ query: input.q }),
    normalize: (raw) => raw as { tier: number },
    redactionPatterns: [],
    egressAllow: () => true,
    toLogPayload: (input, outcome) => ({
      query: input.q,
      status: outcome.status,
      keys: ['c0'],
      modelScores: [2],
    }),
    ...overrides,
  };
}

const INPUT = { q: 'how to configure' };

describe('JudgmentRunnerService', () => {
  let logRepo: { save: jest.Mock };
  let provider: { name: string; enabled: boolean; run: jest.Mock };
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    logRepo = { save: jest.fn().mockResolvedValue(undefined) };
    provider = { name: 'typesafe', enabled: true, run: jest.fn() };
  });

  afterEach(() => jest.clearAllMocks());

  /** 构造 runner（quota 每次新建 = 窗口起点确定） */
  function runnerOf(overrides: Partial<JudgmentConfig> = {}): {
    runner: JudgmentRunnerService;
    quota: JudgmentQuotaService;
  } {
    const quota = new JudgmentQuotaService(configOf(overrides));
    const runner = new JudgmentRunnerService(
      quota,
      provider as unknown as JudgmentProvider,
      configOf(overrides),
      logRepo as unknown as never,
    );
    return { runner, quota };
  }

  /** 取最近一次写入的日志行 */
  const savedRow = (): Record<string, unknown> =>
    logRepo.save.mock.calls[logRepo.save.mock.calls.length - 1][0] as Record<string, unknown>;

  it('provider=none → disabled：不调用、不写行、不占额度（与 skipped 严格分开）', async () => {
    provider.enabled = false;
    const { runner } = runnerOf();
    expect(await runner.run(capabilityOf(), INPUT, ACTOR)).toEqual({ status: 'disabled' });
    expect(provider.run).not.toHaveBeenCalled();
    expect(logRepo.save).not.toHaveBeenCalled();
    expect(runner.isEnabled('rerank')).toBe(false);
  });

  it('能力不在白名单 → disabled（缺省关；只有显式开启才出境）', async () => {
    const { runner } = runnerOf({ capabilities: [] });
    expect(runner.isEnabled('rerank')).toBe(false);
    expect(await runner.run(capabilityOf(), INPUT, ACTOR)).toEqual({ status: 'disabled' });
    expect(logRepo.save).not.toHaveBeenCalled();
  });

  it('record_check 恒不受白名单管辖（isEnabled 不看 capabilities）', async () => {
    const { runner } = runnerOf({ capabilities: [] });
    expect(runner.isEnabled('record_check')).toBe(true);
  });

  it('额度超限 → skipped + 标量行（不带输入原文）', async () => {
    const { runner } = runnerOf({ capabilityRateLimitPerHour: 1 });
    provider.run.mockResolvedValue({
      status: 'ok',
      value: { tier: 2 },
      meta: { provider: 'typesafe', model: 'm', judgedAt: 'now', rubricVersion: 'v1' },
      request: {},
      response: {},
      latencyMs: 1,
    });
    expect((await runner.run(capabilityOf(), INPUT, ACTOR)).status).toBe('ok');

    const skipped = await runner.run(capabilityOf(), INPUT, ACTOR);
    expect(skipped).toEqual({ status: 'skipped', reason: 'capability_rate_limit' });
    const row = savedRow();
    expect(row.status).toBe('skipped');
    expect(row.request).toEqual({ skipped: true, reason: 'capability_rate_limit' });
    expect(row.response).toBeNull();
    expect(row.latencyMs).toBeNull();
    // 标量行**不带输入原文**（否则闸门日志本身就是出境/泄漏面）
    expect(JSON.stringify(row.request)).not.toContain(INPUT.q);
  });

  it('出境闸命中 → skipped + `egress_blocked` 标量行（不调用 provider）', async () => {
    const { runner } = runnerOf();
    const capability = capabilityOf({ egressAllow: () => false });
    expect(await runner.run(capability, INPUT, ACTOR)).toEqual({
      status: 'skipped',
      reason: 'egress_blocked',
    });
    expect(provider.run).not.toHaveBeenCalled();
    expect(savedRow()).toMatchObject({
      status: 'skipped',
      request: { skipped: true, reason: 'egress_blocked' },
    });
  });

  it('ok：写行（operation = 能力名、experienceId 恒 null、logRedacted 命中标记、体积硬顶）', async () => {
    const { runner } = runnerOf();
    provider.run.mockResolvedValue({
      status: 'ok',
      value: { tier: 3 },
      meta: { provider: 'typesafe', model: 'jev-1.13.0', judgedAt: 'now', rubricVersion: 'v1' },
      request: {},
      response: { raw: { ok: true } },
      latencyMs: 42,
    } satisfies JudgmentOutcome<{ tier: number }>);

    const result = await runner.run(capabilityOf(), INPUT, ACTOR);
    expect(result.status).toBe('ok');
    const row = savedRow();
    expect(row.experienceId).toBeNull(); // 通用行没有条目归属
    expect(row.operation).toBe('rerank');
    expect(row.model).toBe('jev-1.13.0');
    expect(row.latencyMs).toBe(42);
    expect(row.actorType).toBe('agent');
    // 普通载荷不标 logRedacted（无命中不造假标记）
    expect(row.request).not.toHaveProperty('logRedacted');
  });

  it('日志载荷命中密钥 → 掩码 + `logRedacted` 标记（通用路径的标记名，不是 stateRedacted）', async () => {
    const { runner } = runnerOf();
    provider.run.mockResolvedValue({
      status: 'error',
      request: {},
      response: { error: 'x' },
      latencyMs: 7,
    } satisfies JudgmentOutcome<{ tier: number }>);

    await runner.run(capabilityOf({ toLogPayload: (input) => ({ query: input.q }) }), {
      q: 'ask_deadbeef',
    }, ACTOR);

    const row = savedRow();
    expect(row.request).toMatchObject({ logRedacted: true });
    expect(JSON.stringify(row.request)).not.toContain('eadbeef');
  });

  it('error / timeout 透传 status（写行但**不返回模型产物**）', async () => {
    const { runner } = runnerOf();
    provider.run.mockResolvedValue({
      status: 'timeout',
      request: {},
      response: { error: 'judgment provider timed out after 5000ms' },
      latencyMs: 5000,
    } satisfies JudgmentOutcome<{ tier: number }>);

    expect(await runner.run(capabilityOf(), INPUT, ACTOR)).toEqual({ status: 'timeout' });
    expect(savedRow()).toMatchObject({ status: 'timeout', model: null });
  });

  it('NIT-3：DI token **字面值**锚定（改名 = e2e 静默换回真实现 ⇒ 必须显式钉死）', () => {
    // 这两个 token 是 e2e/单测的 override 替换点：字符串值一改，`overrideProvider` 就静默失效
    // （fake 不生效、真实现被装配 ⇒ 真的联网打计费 API，而测试全绿）。故字面量必须被断言。
    expect(JUDGMENT_PROVIDER).toBe('JUDGMENT_PROVIDER');
    expect(JUDGMENT_CONFIG).toBe('JUDGMENT_CONFIG');
  });

  it('MAJOR-5：出境闸拒绝**不吃任何额度**（全局/能力/actor 桶长度均为 0），且不饿死其它能力', async () => {
    const { runner, quota } = runnerOf({ globalRateLimitPerHour: 1 });
    // 单 actor 连发"密钥形态"请求（零成本、零出境）
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const skipped = await runner.run(capabilityOf({ egressAllow: () => false }), INPUT, ACTOR);
      expect(skipped).toEqual({ status: 'skipped', reason: 'egress_blocked' });
    }
    const view = quota as unknown as {
      globalQuota: Map<string, number[]>;
      capabilityQuota: Map<string, number[]>;
      actorQuota: Map<string, number[]>;
    };
    // 从未打算出境的请求不入账 ⇒ 全局闸不会被刷满（旧顺序下这里是 5 ⇒ 全平台判定被饿死一整个窗口）
    expect(view.globalQuota.get('global') ?? []).toHaveLength(0);
    expect(view.capabilityQuota.get('rerank') ?? []).toHaveLength(0);
    expect(view.actorQuota.get('rerank:agent:' + (ACTOR as { id: string }).id) ?? []).toHaveLength(0);

    // 另一能力（record_check）仍可正常调用（全局额度完好）
    provider.run.mockResolvedValue({
      status: 'ok',
      value: { tier: 3 },
      meta: { provider: 'typesafe', model: 'm', judgedAt: 'now', rubricVersion: 'v1' },
      request: {},
      response: {},
      latencyMs: 1,
    });
    const recordCheck = capabilityOf({ name: 'record_check' });
    expect((await runner.run(recordCheck, INPUT, ACTOR)).status).toBe('ok');
  });

  it('NIT-4：日志行写失败**不吞掉成功判定**——结果照常返回 + warn + 计数', async () => {
    const { runner } = runnerOf();
    provider.run.mockResolvedValue({
      status: 'ok',
      value: { tier: 2 },
      meta: { provider: 'typesafe', model: 'm', judgedAt: 'now', rubricVersion: 'v1' },
      request: {},
      response: {},
      latencyMs: 3,
    });
    logRepo.save.mockRejectedValueOnce(new Error('pool exhausted'));

    const result = await runner.run(capabilityOf(), INPUT, ACTOR);

    // 判定结果优先：模型产物照常返回（不因语料写失败被丢弃）
    expect(result).toMatchObject({ status: 'ok', value: { tier: 2 } });
    expect(runner.logWriteFailureCount).toBe(1);
    const text = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(text).toContain('failed to write judgment log row');
    expect(text).not.toContain('pool exhausted'); // 不带异常 message（纪律）
  });

  it('provider 抛错（实现漂移）→ fail-open 成 error，不冒泡（warn 不带 message）', async () => {
    const { runner } = runnerOf();
    provider.run.mockRejectedValue(new Error('boom with secret=abc'));
    expect(await runner.run(capabilityOf(), INPUT, ACTOR)).toEqual({ status: 'error' });
    expect(warnSpy).toHaveBeenCalled();
    const text = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(text).not.toContain('boom with secret');
    expect(text).toContain('Error');
  });

  it('落库失败 → fail-open + **交还** skip 配额（否则本窗口再也写不出记账凭证）', async () => {
    const { runner, quota } = runnerOf();
    const capability = capabilityOf({ egressAllow: () => false });
    logRepo.save.mockRejectedValueOnce(new Error('pool exhausted'));

    expect(await runner.run(capability, INPUT, ACTOR)).toEqual({
      status: 'skipped',
      reason: 'egress_blocked',
    });
    // 交还后允许再写一行（同一槽位、同一能力、同一 actor）
    expect(quota.allowSkipRow('gate', 'rerank', 'agent:aaaaaaaa-1111-4111-8111-111111111111')).toBe(
      true,
    );
  });

  it('recordSkip（外部闸门，如可见性闸）→ 标量行 + 未启用时短路不落行', async () => {
    const { runner } = runnerOf();
    expect(await runner.recordSkip('rerank', ACTOR, 'visibility_blocked')).toBe(true);
    expect(savedRow()).toMatchObject({
      operation: 'rerank',
      status: 'skipped',
      request: { skipped: true, reason: 'visibility_blocked' },
    });

    logRepo.save.mockClear();
    const { runner: disabled } = runnerOf({ capabilities: [] });
    expect(await disabled.recordSkip('rerank', ACTOR, 'visibility_blocked')).toBe(false);
    expect(logRepo.save).not.toHaveBeenCalled();
    // 未启用 ⇒ 也不许打日志噪音之外的东西（不写行即满足"没开的能力不落行"）
    expect(logSpy).not.toHaveBeenCalled();
  });
});
