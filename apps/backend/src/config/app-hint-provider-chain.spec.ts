/**
 * `resolveHintProviderChain` 单测（阶段三观察期 kill switch，决策 11）
 *
 * 覆盖：缺省全链 / 单键关停 / 多键关停 / 空串与全空白与多余逗号（**fail-open 到全链**，
 * 不因拼错而清空）/ 未知键忽略（不把链清空）/ 返回的是**引用同一批类**
 * （`useFactory` 按构造器比较，换名字字符串会静默失配）。
 *
 * 为什么单独一个 spec 而不是并进 `app.module.spec.ts`：那个文件是**接线守卫**
 * （断清单内容，不 boot 应用）；本文件断**纯函数语义**——两者失败时的定位价值不同。
 *
 * v1.94.0-dev：链首新增 `security_scan`（链序决定无 priority 声明时的候选传入序，
 * 见 `app-hint-provider-chain.ts` 注释），故本文件的每条预期都多了一位。
 */
import { MEMORY_FEATURE_ENABLED } from '@agent-chamber/shared';
import {
  applyHintProviderKillSwitch,
  HINT_FACT_PROVIDER_CHAIN,
  resolveHintProviderChain,
} from './app-hint-provider-chain';
import { MemoryNominationHintProvider } from '../modules/memory/memory-nomination-hint.provider';
import { TaskHygieneHintProvider } from '../modules/task/task-hygiene-hint.provider';
import { SecurityHintProvider } from '../modules/hints/security-hint.provider';

describe('resolveHintProviderChain（kill switch 纯函数）', () => {
  it('缺省（undefined）⇒ 全链，且**引用同一批类**（不是新建数组里的复制品）', () => {
    const chain = resolveHintProviderChain();
    expect(chain).toEqual([
      SecurityHintProvider,
      TaskHygieneHintProvider,
      ...(MEMORY_FEATURE_ENABLED ? [MemoryNominationHintProvider] : []),
    ]);
    expect(chain).toBe(HINT_FACT_PROVIDER_CHAIN);
  });

  it('单键关停：只剔掉该键对应的 provider，其余保持链序', () => {
    expect(resolveHintProviderChain('task_hygiene')).toEqual([
      SecurityHintProvider,
      ...(MEMORY_FEATURE_ENABLED ? [MemoryNominationHintProvider] : []),
    ]);
    expect(resolveHintProviderChain('memory_nomination')).toEqual([
      SecurityHintProvider,
      TaskHygieneHintProvider,
    ]);
    expect(resolveHintProviderChain('security_scan')).toEqual([
      TaskHygieneHintProvider,
      ...(MEMORY_FEATURE_ENABLED ? [MemoryNominationHintProvider] : []),
    ]);
  });

  it('多键 / 含空白 / 尾随逗号：正常解析（trim + 忽略空 token）', () => {
    expect(resolveHintProviderChain('task_hygiene,memory_nomination')).toEqual([
      SecurityHintProvider,
    ]);
    expect(resolveHintProviderChain(' task_hygiene , memory_nomination ,')).toEqual([
      SecurityHintProvider,
    ]);
    expect(resolveHintProviderChain('security_scan,task_hygiene,memory_nomination')).toEqual([]);
    expect(resolveHintProviderChain('memory_nomination,')).toEqual([
      SecurityHintProvider,
      TaskHygieneHintProvider,
    ]);
  });

  it('空串 / 全空白 ⇒ 全链（**fail-open**：空 env 不等于「全关」，否则一次误写就静默关停）', () => {
    expect(resolveHintProviderChain('')).toBe(HINT_FACT_PROVIDER_CHAIN);
    expect(resolveHintProviderChain('   ')).toBe(HINT_FACT_PROVIDER_CHAIN);
    expect(resolveHintProviderChain(',,')).toBe(HINT_FACT_PROVIDER_CHAIN);
  });

  it('未知键忽略 ⇒ 成员不变（拼错一个词不该把提示整体清空）', () => {
    expect(resolveHintProviderChain('nope_not_a_provider')).toEqual([
      SecurityHintProvider,
      TaskHygieneHintProvider,
      ...(MEMORY_FEATURE_ENABLED ? [MemoryNominationHintProvider] : []),
    ]);
    expect(resolveHintProviderChain('task_hygiene,nope')).toEqual([
      SecurityHintProvider,
      ...(MEMORY_FEATURE_ENABLED ? [MemoryNominationHintProvider] : []),
    ]);
  });

  // ─── useFactory 胶水（P2-4 ②）：app.module 的注入全集 → 过滤后的实例集 ──────────

  describe('applyHintProviderKillSwitch（app.module useFactory 的胶水，实例级）', () => {
    /**
     * 造「实例」：只需 `constructor` 正确（胶水按构造器比较），故 `Object.create` 足够——
     * 避免为三个 provider 的 1/5/7 个构造参数各搭一套 mock。
     */
    const instances = [
      Object.create(SecurityHintProvider.prototype) as SecurityHintProvider,
      Object.create(TaskHygieneHintProvider.prototype) as TaskHygieneHintProvider,
      ...(MEMORY_FEATURE_ENABLED
        ? [Object.create(MemoryNominationHintProvider.prototype) as MemoryNominationHintProvider]
        : []),
    ];

    it('缺省 ⇒ 全集原样（含顺序）', () => {
      expect(applyHintProviderKillSwitch(instances)).toEqual(instances);
    });

    it('关停一个族 ⇒ **实例集真的少一个**（不是只改了类清单）', () => {
      const kept = applyHintProviderKillSwitch(instances, 'task_hygiene');
      expect(kept).toHaveLength(MEMORY_FEATURE_ENABLED ? 2 : 1);
      expect(kept.map((instance) => (instance as object).constructor)).toEqual([
        SecurityHintProvider,
        ...(MEMORY_FEATURE_ENABLED ? [MemoryNominationHintProvider] : []),
      ]);

      const only = applyHintProviderKillSwitch(instances, 'memory_nomination');
      expect((only[0] as object).constructor).toBe(SecurityHintProvider);
      expect((only[1] as object).constructor).toBe(TaskHygieneHintProvider);
    });

    it('全关 ⇒ 空数组（拦截器随后走「无 provider」快路径②，零开销直通）', () => {
      expect(
        applyHintProviderKillSwitch(instances, 'security_scan,task_hygiene,memory_nomination'),
      ).toEqual([]);
    });

    it('未知键 / 空 env ⇒ 全集（fail-open）', () => {
      expect(applyHintProviderKillSwitch(instances, 'nope')).toEqual(instances);
      expect(applyHintProviderKillSwitch(instances, '  ')).toEqual(instances);
    });
  });
});
