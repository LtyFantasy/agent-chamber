/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - AppModule `ConfigModule.load` 清单的**接线守卫**：防"namespace 已 registerAs 但漏挂
 *     load"这一类静默配置失效（消费方落兜底 + warn 与 env 原值矛盾，仅真启动可见）。
 *
 * [代码职责]
 *   - 断言 `APP_CONFIG_LOADS`（load 清单单源）按引用包含每个必备 config 工厂
 *   - 断言 `APP_INTERCEPTOR_CHAIN`（全局拦截器链序单源）满足**信封契约**次序：
 *     `HintInterceptor` 必须排在 `ResponseInterceptor` 之后（否则拿到的是已包装的信封，
 *     挂不上业务载荷上的 `hints`）
 *   - 断言 `HINT_FACT_PROVIDER_CHAIN`（hint 求值器装配单源）的**内容与顺序**：成员变化
 *     = 生产 hint 行为变化（谁先求值 / 有没有 provider），必须与链清单同 commit
 *   - **不 boot 应用、不 import AppModule**（全仓库 e2e 刻意不走 AppModule：WS gateway /
 *     schedule 启动面；import 全模块图 = 慢且引入 Nest 元数据内部约定依赖——首版元数据
 *     断言已因此废弃，改为对单源常量直接断言）——三份清单都是**普通常量**，直接断言即可
 *
 * [权威文档]
 *   - app.module.ts 文件头 D6 踩坑（2026-10-07 memory PoC 冒烟实证：
 *     `MEMORY_ENGINE=hument` 因 memoryConfig 漏挂 load 被判 none，单测/e2e 全部内联
 *     ConfigModule 无一拦下）；config/app-config-loads.ts / app-interceptor-chain.ts /
 *     app-hint-provider-chain.ts 三份清单的文件头不变量
 *
 * [关键不变量]
 *   - **启用 Memory 时断言必须含 `memoryConfig`**，发行关闭时必须缺席；新增 namespace ⇒
 *     `EXPECTED` 顺手 +1（漏补 = 本守卫对新 namespace 失明）。
 *   - 断言用**引用相等**（`toContain` 同一家工厂对象），不比名字字符串——
 *     名字能对、工厂挂错（比如挂成同名 stub）也是 bug。
 *   - **hint provider 链的断言同样用引用相等**：链里成员被替换成同名异类（stub / mock）
 *     时，按名字断言会假绿——而生产里那意味着"提示永不产出"。
 *
 * [关联代码]
 *   - ./config/app-config-loads.ts — 被守卫的单源清单（config namespace）
 *   - ./config/app-interceptor-chain.ts — 被守卫的单源清单（全局拦截器链序）
 *   - ./config/app-hint-provider-chain.ts — 被守卫的单源清单（hint 求值器装配）
 *   - ./modules/memory/memory-nomination-hint.provider.ts — 链当前唯一成员
 *   - ./app.module.ts — 三份清单的唯一消费方
 *
 * [修改检查]
 *   □ 新增 config namespace ⇒ app-config-loads.ts +1 **且** 本文件 EXPECTED +1
 *   □ 调整拦截器链序 / hint provider 链 ⇒ 本文件断言同步（顺序即契约，不是风格）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { MEMORY_FEATURE_ENABLED } from '@agent-chamber/shared';
import { APP_CONFIG_LOADS } from './config/app-config-loads';
import { APP_INTERCEPTOR_CHAIN } from './config/app-interceptor-chain';
import {
  HINT_FACT_PROVIDER_CHAIN,
  resolveHintProviderChain,
} from './config/app-hint-provider-chain';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HintInterceptor } from './modules/hints/hint.interceptor';
import { MemoryNominationHintProvider } from './modules/memory/memory-nomination-hint.provider';
import { TaskHygieneHintProvider } from './modules/task/task-hygiene-hint.provider';
import { SecurityHintProvider } from './modules/hints/security-hint.provider';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import minioConfig from './config/minio.config';
import attachmentUrlConfig from './config/attachment-url.config';
import judgmentConfig from './config/judgment.config';
import memoryConfig from './config/memory.config';
import notificationsConfig from './config/notifications.config';

/** 必须在 load 清单里的 config 工厂（新增 namespace 顺手 +1，见文件头不变量） */
const EXPECTED = [
  ['database', databaseConfig],
  ['jwt', jwtConfig],
  ['minio', minioConfig],
  ['attachmentUrl', attachmentUrlConfig],
  ['judgment', judgmentConfig],
  ...(MEMORY_FEATURE_ENABLED ? ([['memory', memoryConfig]] as const) : []),
  ['notifications', notificationsConfig],
] as const;

describe('AppModule ConfigModule.load 接线（D6 回归守卫）', () => {
  it('Memory 工厂只在对应发行能力启用时装配', () => {
    expect(APP_CONFIG_LOADS.includes(memoryConfig)).toBe(MEMORY_FEATURE_ENABLED);
  });
  it.each(EXPECTED)('APP_CONFIG_LOADS 包含 namespace=%s 的工厂', (_name, factory) => {
    expect(APP_CONFIG_LOADS).toContain(factory);
  });
});

describe('AppModule 全局拦截器链序（信封契约守卫）', () => {
  const indexOf = (target: unknown): number => APP_INTERCEPTOR_CHAIN.indexOf(target as never);

  it('ResponseInterceptor 在最外层（第 0 位）——它是信封的唯一包装点', () => {
    expect(indexOf(ResponseInterceptor)).toBe(0);
  });

  it('HintInterceptor 排在 ResponseInterceptor **之后**（读业务载荷挂 hints，不是读信封）', () => {
    const hintIndex = indexOf(HintInterceptor);
    expect(hintIndex).toBeGreaterThan(indexOf(ResponseInterceptor));
    // 自检：两个类都在清单里（indexOf 失败会返回 -1，漏注册时上一条断言会假绿）
    expect(hintIndex).toBeGreaterThanOrEqual(0);
  });

  it('链序无重复注册（同一拦截器出现两次 = 信封被套两层）', () => {
    expect(new Set(APP_INTERCEPTOR_CHAIN).size).toBe(APP_INTERCEPTOR_CHAIN.length);
  });
});

describe('AppModule hint 事实求值器链（装配单源守卫）', () => {
  it('链内容 = [SecurityHintProvider, TaskHygieneHintProvider, MemoryNominationHintProvider]（引用相等——换成同名 stub 会假绿）', () => {
    expect(HINT_FACT_PROVIDER_CHAIN).toEqual([
      SecurityHintProvider,
      TaskHygieneHintProvider,
      ...(MEMORY_FEATURE_ENABLED ? [MemoryNominationHintProvider] : []),
    ]);
  });

  it('**security_scan 置首位**（链序决定无 priority 声明时的候选传入序；见链清单注释）', () => {
    expect(HINT_FACT_PROVIDER_CHAIN[0]).toBe(SecurityHintProvider);
  });

  it('链无重复注册（同一 provider 出现两次 = 同响应被求值两次）', () => {
    expect(new Set(HINT_FACT_PROVIDER_CHAIN).size).toBe(HINT_FACT_PROVIDER_CHAIN.length);
  });

  it('kill switch 的键空间与链一一对应（env 值不是类名，键漂移 = 线上开关静默失效）', () => {
    // `resolveHintProviderChain` 关掉一个键 ⇒ 恰好少一个 provider，且剩下的是另外两个
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
    expect(resolveHintProviderChain('security_scan,task_hygiene,memory_nomination')).toEqual([]);
  });
});
