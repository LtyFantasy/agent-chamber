/**
 * judgment-quota.service 单测（三级成本闸 + skip 行有界记账）。
 *
 * 设计意图：闸是"花钱的开关"，它静默失效的两种形态最难发现——① **桶被钉死**（单 actor 连续刷
 * 就把共享额度顶满，所有人等满一个窗口）；② **行无界**（skip 占位行正比请求数，日志表被刷爆）。
 * 故这里逐条钉死：执行序（先严后宽）、共享桶只计放行 / actor 桶连被拒一起计、桶键含能力
 * （跨能力不互相饿死）、skip 行的**派生上界**（禁手写常量）。
 */
import type { JudgmentConfig } from '../../config/judgment.config';
import { JUDGMENT_CAPABILITY_REGISTRY } from './judgment.capabilities';
import {
  JUDGMENT_LIMIT_LEVELS,
  JUDGMENT_SKIP_SLOTS,
  JudgmentQuotaService,
  NON_QUOTA_SKIP_SLOT,
  judgmentSkipRowBound,
} from './judgment-quota.service';

/** 配置基线（宽裕；用例只收紧被考察的那一级） */
function configOf(overrides: Partial<JudgmentConfig> = {}): JudgmentConfig {
  return {
    provider: 'typesafe',
    baseUrl: 'https://api.typesafe.ai',
    apiKey: 'k',
    typesafeModel: 'jev-latest',
    timeoutMs: 8000,
    rateLimitPerHour: 1000,
    globalRateLimitPerHour: 1000,
    capabilityRateLimitPerHour: 1000,
    capabilities: ['rerank'],
    warnings: [],
    ...overrides,
  };
}

const ACTOR = 'agent:aaa';
const OTHER_ACTOR = 'agent:bbb';

describe('judgmentSkipRowBound（派生上界，禁手写常量）', () => {
  it('上界 = (级别数 + 1) × 能力数，且槽位表确实多出那一个非额度槽', () => {
    expect(JUDGMENT_SKIP_SLOTS.length).toBe(JUDGMENT_LIMIT_LEVELS.length + 1);
    expect(JUDGMENT_SKIP_SLOTS[JUDGMENT_SKIP_SLOTS.length - 1]).toBe(NON_QUOTA_SKIP_SLOT);
    for (let capabilityCount = 1; capabilityCount <= 5; capabilityCount += 1) {
      expect(judgmentSkipRowBound(capabilityCount)).toBe(
        (JUDGMENT_LIMIT_LEVELS.length + 1) * capabilityCount,
      );
    }
    // 真值锚定（终审 MAJOR-4）：平台当前 2 个能力 ⇒ 单 actor 单窗口上界 = (3+1)×2 = 8
    expect(JUDGMENT_CAPABILITY_REGISTRY).toHaveLength(2);
    expect(judgmentSkipRowBound(JUDGMENT_CAPABILITY_REGISTRY.length)).toBe(8);
  });

  it('单 actor 单窗口实际可写的 skip 行数 ≤ 派生上界（覆盖全部槽位 × 全部能力）', () => {
    const quota = new JudgmentQuotaService(configOf());
    // 能力数**单源 = 注册表**（终审 MAJOR-4：手写列表会让"禁手写常量"的纪律在测试里破功，
    // 且新增能力后派生上界真值静默失真）
    const capabilities = JUDGMENT_CAPABILITY_REGISTRY.map((capability) => capability.name);
    expect(capabilities.length).toBeGreaterThanOrEqual(2); // record_check + rerank
    let written = 0;
    for (const capability of capabilities) {
      for (const slot of JUDGMENT_SKIP_SLOTS) {
        if (quota.allowSkipRow(slot, capability, ACTOR)) written += 1;
      }
    }
    expect(written).toBe(judgmentSkipRowBound(capabilities.length));
    // 第二圈：全部组合都在本窗口记过 ⇒ 一行也不许再写
    for (const capability of capabilities) {
      for (const slot of JUDGMENT_SKIP_SLOTS) {
        expect(quota.allowSkipRow(slot, capability, ACTOR)).toBe(false);
      }
    }
  });

  it('releaseSkipRow 交还配额（"先记账后写库"失败的补偿）', () => {
    const quota = new JudgmentQuotaService(configOf());
    expect(quota.allowSkipRow('actor', 'record_check', ACTOR)).toBe(true);
    expect(quota.allowSkipRow('actor', 'record_check', ACTOR)).toBe(false);
    quota.releaseSkipRow('actor', 'record_check', ACTOR);
    expect(quota.allowSkipRow('actor', 'record_check', ACTOR)).toBe(true);
  });
});

describe('JudgmentQuotaService.consume（三级闸）', () => {
  it('执行序 = 全局 → 能力 → actor（先严后宽）：全局超限时不吃更内侧的额度', () => {
    const quota = new JudgmentQuotaService(
      configOf({ globalRateLimitPerHour: 1, capabilityRateLimitPerHour: 5, rateLimitPerHour: 5 }),
    );
    expect(quota.consume('record_check', ACTOR)).toBeNull();
    expect(quota.consume('record_check', ACTOR)?.level).toBe('global');

    // 桶内只留"放行"那一次（被拒尝试不入账）⇒ 全局恢复后 actor 额度仍完好
    const view = quota as unknown as { actorQuota: Map<string, number[]> };
    expect(view.actorQuota.get(`record_check:${ACTOR}`)).toHaveLength(1);
  });

  it('能力子额度超限 → level=capability + reason=capability_rate_limit（不吃 actor 额度）', () => {
    const quota = new JudgmentQuotaService(configOf({ capabilityRateLimitPerHour: 1 }));
    expect(quota.consume('record_check', ACTOR)).toBeNull();
    const blocked = quota.consume('record_check', ACTOR);
    expect(blocked).toEqual({ level: 'capability', reason: 'capability_rate_limit' });
    const view = quota as unknown as { actorQuota: Map<string, number[]> };
    expect(view.actorQuota.get(`record_check:${ACTOR}`)).toHaveLength(1);
  });

  it('actor 额度超限 → level=actor + reason=judgment_rate_limited（历史值字面不变）', () => {
    const quota = new JudgmentQuotaService(configOf({ rateLimitPerHour: 1 }));
    expect(quota.consume('record_check', ACTOR)).toBeNull();
    expect(quota.consume('record_check', ACTOR)).toEqual({
      level: 'actor',
      reason: 'judgment_rate_limited',
    });
  });

  it('actor 桶**连被拒尝试一起计**（不许当免费通道），共享桶只计放行', () => {
    const quota = new JudgmentQuotaService(
      configOf({ capabilityRateLimitPerHour: 1, rateLimitPerHour: 100 }),
    );
    quota.consume('record_check', ACTOR);
    quota.consume('record_check', ACTOR); // 被 capability 拒
    quota.consume('record_check', ACTOR); // 被 capability 拒
    const view = quota as unknown as { capabilityQuota: Map<string, number[]> };
    // 共享桶只计放行 ⇒ 恒 1（旧语义下是 3：桶被刷满、谁都用不了）
    expect(view.capabilityQuota.get('record_check')).toHaveLength(1);
  });

  it('actor 桶按 **actor** 独立（同能力下 A 打满不影响 B）', () => {
    const quota = new JudgmentQuotaService(configOf({ rateLimitPerHour: 1 }));
    expect(quota.consume('record_check', ACTOR)).toBeNull();
    expect(quota.consume('record_check', ACTOR)?.level).toBe('actor');
    expect(quota.consume('record_check', OTHER_ACTOR)).toBeNull();
  });

  it('**跨能力不互相饿死**：rerank 打满能力子额度不影响 record_check（额度键含能力）', () => {
    const quota = new JudgmentQuotaService(configOf({ capabilityRateLimitPerHour: 1 }));
    expect(quota.consume('rerank', ACTOR)).toBeNull();
    expect(quota.consume('rerank', ACTOR)?.level).toBe('capability');
    // 同 actor、同窗口：另一能力仍可用（且用的另一份 actor 额度）
    expect(quota.consume('record_check', ACTOR)).toBeNull();
    // 全局桶**跨能力**统一计数（它是实例级总闸）：每次"通过全局闸"的请求都入账
    // （rerank 两次 + record_check 一次 = 3；能力闸挡下的那次也已过全局闸）
    const view = quota as unknown as { globalQuota: Map<string, number[]> };
    expect(view.globalQuota.get('global')).toHaveLength(3);
  });

  it('actor 桶键 = `能力:actorKey`（改名即红：额度键 (level, capability, actorKey) 的落点）', () => {
    const quota = new JudgmentQuotaService(configOf());
    quota.consume('rerank', ACTOR);
    const view = quota as unknown as { actorQuota: Map<string, number[]> };
    expect(view.actorQuota.get(`rerank:${ACTOR}`)).toHaveLength(1);
    expect(view.actorQuota.get(ACTOR)).toBeUndefined();
  });
});
