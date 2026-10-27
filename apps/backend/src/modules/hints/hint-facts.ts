/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 hint 的**请求级事实袋**（ALS，阶段一）：service 用领域语言写一行
 *     `emitFact('doc.created', { docId })` 就交出了「本次请求发生了什么」，
 *     **完全不需要知道 hint 层的存在**；hint 层（拦截器侧 provider）在响应封装前
 *     取出事实袋自行决定要不要产出 hint。
 *
 * [代码职责]
 *   - 模块单例 `AsyncLocalStorage<HintFactBag>`：**并发隔离是契约**——每个请求
 *     （或每段协作上下文）一个袋，跨请求/跨并发互不可见。
 *   - `runWithHintFacts(fn, bag?)`：建立上下文（缺省新建袋）；可在 map 回调里用显式
 *     句柄取用（`map` 回调不在 ALS 上下文内——见该函数注释）。
 *   - `emitFact(name, payload?)`：领域侧唯一写入口（无上下文 → no-op，fail-open）。
 *   - `drainFacts(bag?)` / `peekFacts(bag?)`：取走 / 只读当前袋。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」小节
 *     （hints 只在 2xx 响应出现、≤3 条、空则键不出现）
 *
 * [关键不变量]
 *   - **单实例**：ALS 靠模块单例工作。若被复制成两份（一份 src 一份 dist、或某入口
 *     自带副本），provider 读到的袋恒为空 ⇒ 新挂面的 hint 静默消失、无报错无日志。
 *     守卫 = hint.interceptor 与 provider 都从本模块 import（禁止各自 new 一份）。
 *   - **永不抛**：`emitFact` 对任意输入全定义（非字符串名 / 非 plain object 载荷 →
 *     丢弃，不抛）——领域侧在业务事务里调用它，抛 = 把成功写入打成 500。
 *   - **无上下文 = no-op**：非 HTTP 场景（定时任务、脚本）调 emitFact 不报错，
 *     「没有袋」是正常态。
 *   - **袋有硬上限**（`HINT_FACT_MAX_PER_CONTEXT`）：超限静默丢弃（fail-open），
 *     防御 emit 在循环里失控——hint 是 advisory，宁可少发不可拖垮请求。
 *   - **事实是原始事实，不是 hint**：袋里不出现 code / message / 优先级——决策一律
 *     留在 hint 层（provider + 注册表）。
 *
 * [关联代码]
 *   - modules/hints/hint.interceptor.ts — 唯一建立点（每请求建袋 + 响应前取用）
 *   - modules/hints/hint-registry.ts — code 元数据目录（provider 侧求值依据）
 *   - modules/hints/hints.module.ts — 模块装配（@Global）
 *   - packages/automcp/src/server/tool-context.ts — 同款 ALS 单例先例
 *   - hint-facts.spec.ts — 并发隔离 / 无上下文 no-op / 取走即清 / 上限
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（是否有第二份实例）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { AsyncLocalStorage } from 'async_hooks';

/**
 * 单请求事实袋容量上限（超限静默丢弃）。
 *
 * rationale：袋是 hint 的输入，而 hint 是 advisory——上限存在的意义是「emit 在循环里
 * 失控」时不让内存随请求放大；正常挂面一次请求 emit 个位数条事实，64 条留足冗余。
 */
export const HINT_FACT_MAX_PER_CONTEXT = 64;

/**
 * 一条原始事实（**领域语言**，不是 hint）。
 *
 * `name` 用点分域名词（如 `doc.created` / `doc.moved` / `memory.nomination.submitted`），
 * 由 provider 按名匹配；`payload` 只放标量/ID，**禁用户正文**（会经日志与响应外流），
 * 且约定为**扁平对象**——落袋做浅拷贝（见 `HintFactBag.push`），嵌套对象仍是共享引用。
 *
 * **多值一律用「逗号拼接的单字符串」**（先例 = `security.credential_suspected` 的
 * `matchedPatterns`）：数组落袋虽是浅拷贝但元素对象仍共享引用，且消费方要自己判空数组；
 * 逗号串是标量、判空只需 `length > 0`。代价是**元素词表禁含逗号**（否则 join/split 不可逆）
 * ——该约束由产出方的守卫 spec 钉（如 `sensitive-patterns.spec.ts` 的 patternId 断言）。
 */
export interface HintFact {
  /** 事实名（点分域名词） */
  name: string;
  /** 事实载荷（扁平、标量优先；空对象不落键） */
  payload?: Record<string, unknown>;
}

/**
 * 一个请求（或一段协作上下文）的事实袋。
 *
 * 做成类而非裸数组：`drain()` 的「取走即清」语义需要封装，且袋句柄要能在 `map`
 * 回调里安全传递（见 `runWithHintFacts`）。
 */
export class HintFactBag {
  private readonly facts: HintFact[] = [];

  /**
   * 追加一条事实（超上限 / 非字符串名 / 非 plain object 载荷 → 静默丢弃）。
   *
   * @returns true = 已记录；false = 被丢弃（fail-open，调用方无需处理）
   */
  push(name: string, payload?: Record<string, unknown>): boolean {
    if (typeof name !== 'string' || name.length === 0) return false;
    if (this.facts.length >= HINT_FACT_MAX_PER_CONTEXT) return false;
    this.facts.push({
      name,
      // **载荷落袋即浅拷贝**：领域侧常在 emit 之后继续用同一个对象（如把它交给
      // repository 或就地改字段），按引用入袋会让 provider 读到「事实发生之后」才被改写
      // 的值——响应里的 hint 与实际发生的事实脱钩，且极难复现。浅拷贝是这一层的成本上限；
      // 嵌套对象仍是共享引用，故 payload 约定为扁平对象（见 HintFact 注释）。
      ...(payload && Object.keys(payload).length > 0 ? { payload: { ...payload } } : {}),
    });
    return true;
  }

  /** 取走全部事实并清空（响应前唯一取用口） */
  drain(): HintFact[] {
    const drained = this.facts.splice(0, this.facts.length);
    return drained;
  }

  /** 只读快照（拦截器快路径的「袋是否为空」判定） */
  peek(): readonly HintFact[] {
    return this.facts;
  }

  /** 当前条数 */
  get size(): number {
    return this.facts.length;
  }
}

/** 进程级单例：同一次请求内所有 emitFact / provider 求值共享同一个袋 */
const hintFactStorage = new AsyncLocalStorage<HintFactBag>();

/**
 * 新建事实袋（显式句柄：拦截器在 `map` 回调里取用——那个回调**不在** ALS 上下文内，
 * 因为 Observable 的订阅发生在 `run` 之外）。
 */
export function createHintFactBag(): HintFactBag {
  return new HintFactBag();
}

/**
 * 在指定事实袋上下文中执行 fn（同步建立、异步继续可见）。
 *
 * @param fn 需要事实袋覆盖的执行体（通常 = handler 的 Observable 链建立）
 * @param bag 显式袋句柄（缺省 = 新建；调用方要持有句柄时必须显式传）
 * @returns fn 的返回值（原样透传，不改语义）
 */
export function runWithHintFacts<T>(fn: () => T, bag: HintFactBag = createHintFactBag()): T {
  return hintFactStorage.run(bag, fn);
}

/**
 * 记录一条事实（领域侧唯一写入口；**无上下文 → no-op**，永不抛）。
 *
 * @param name 事实名（点分域名词）
 * @param payload 结构化载荷（标量优先；空对象不落键）
 * @returns true = 已记录；false = 无上下文 / 被丢弃（调用方无需处理）
 */
export function emitFact(name: string, payload?: Record<string, unknown>): boolean {
  const bag = hintFactStorage.getStore();
  if (!bag) return false;
  return bag.push(name, payload);
}

/**
 * 取走当前上下文的事实并清空（缺省读 ALS；也可传显式句柄）。
 *
 * @param bag 显式袋句柄（拦截器在 map 回调里用）
 * @returns 事实数组（无上下文 → 空数组合，**不是 null**）
 */
export function drainFacts(bag?: HintFactBag): HintFact[] {
  const target = bag ?? hintFactStorage.getStore();
  return target ? target.drain() : [];
}

/**
 * 只读查看当前上下文的事实（缺省读 ALS；也可传显式句柄）。
 *
 * @returns 事实的只读快照（无上下文 → 空数组）
 */
export function peekFacts(bag?: HintFactBag): readonly HintFact[] {
  const target = bag ?? hintFactStorage.getStore();
  return target ? target.peek() : [];
}
