/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 **hint 触发器拦截器**（v1.92.0-dev 阶段一基建 / 阶段二首个生产 provider）：
 *     把「service 在业务里用领域语言写下的原始事实」在**响应封装之前**翻译成信封里的
 *     `hints[]`——service 因此完全不需要知道 hint 层的存在（事实 vs 决策的核心切分）。
 *
 * [代码职责]
 *   - 全局拦截器（AppModule 注册的 APP_INTERCEPTOR；**注册位次由
 *     `config/app-interceptor-chain.ts` 单源给出**——必须排在 `ResponseInterceptor`
 *     之后，才看得到 handler 的原始业务载荷，而不是已包装的信封。
 *     ⚠️ 「排在数组末尾」≠「全链最内层」：被 AppModule **import 的模块**注册的全局
 *     拦截器（如 UsageStatsModule 的 UsageStatsInterceptor）会排在本数组之后、更靠内层）。
 *   - 每请求建立一个**事实袋**（`hint-facts` 的 ALS），交给 handler 链；响应前取袋 →
 *     交给**全部** provider 按链序**异步**求值（`build` 返回 Promise）→ 候选并集**单次**
 *     `emitHints` 接线 → `...(hints ? { hints } : {})` 挂进载荷。
 *   - **七条快路径**（编号是稳定标识，改守卫时按号对齐——本注释与 `intercept` /
 *     `attachHints` 内注释同号）：
 *     ①非 http 上下文（WS / 微服务消息）②无 provider（未装配任何 provider）
 *     ③`@SkipTransform()` ④`@Sse()` 流式端点
 *     —— 四者都在 `intercept()` 内、**建立事实袋之前**返回 `next.handle()`（连袋都不建）；
 *     ⑤`response.writableEnded`（controller 已手动终结响应）
 *     ⑥事实袋为空（本次请求无人 emitFact）
 *     —— 两者在 `attachHints()` 的**第一次 `await` 之前**，即任何求值/IO 之前。
 *     **⑦ 不再是快路径**（阶段三，决策 5）：`payload.hints` 已是数组（域侧已挂）时，
 *     本层转为 **merge**——域侧条目**原样保留并占用槽位**，provider 候选只拿
 *     `3 − 域侧条数` 的剩余预算（预算为 0 时仍求值，只为落「槽位挤占」埋点）。
 *     rationale：域侧与 provider 是**同一个信封的两种来源**，此前「域侧已挂即整链直通」
 *     会让 provider 在同一响应里彻底失声；而「改写域侧条目」又会破坏服务层事务内
 *     组装的语义——占槽 + 剩余预算是不打架的唯一解。
 *   - **域侧条目绝不回流 `emitHints`**：它们不参与去重窗口、不落 emitted 行（域侧在
 *     service 内已各自完成观测），本层只做「原样保留 + 占位计数」。
 *   - **多 provider 合并求值**（阶段三，决策 6）：「首个产出候选者胜出」已退役——全部
 *     provider 按链序求值，候选**并集**单次 finalize（单一优先级序 / 单一 ≤N 预算 /
 *     存活项才占窗口）。埋点 `surface` 逐候选解析（`surfaceOf`），否则多条候选会被记成
 *     同一个面。
 *   - **fail-open 是双层且 await-aware**：阶段二 provider 变异步后，两层都必须重建——
 *     外层 `try { return await this.attachHints(...) } catch` ⇒ 原样返回 payload；
 *     内层 per-provider `try { candidates = await provider.build(...) } catch` ⇒ warn 后试下一个
 *     provider。两层职责不同：外层兜「hint 装配层自身」的意外，内层兜「某个 provider 挂了」
 *     并保留其余 provider 的机会。**rejection 绝不允许冒泡进 subscriber**——那会把一次成功
 *     写入的 200 打成 500（hint 是 advisory，无权否决主响应）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」— hints 只在
 *     2xx 出现、空则键不出现、单响应 ≤3 条
 *
 * [关键不变量]
 *   - **只有成功响应**：rxjs `mergeMap`（async 回调）天然免疫异常路径（抛出的请求根本不进本
 *     操作符）——4xx/5xx 绝无 hints。
 *   - **禁空数组**：provider 无候选 / 全被去重压制 → 原样返回 payload（不挂 `hints`）。
 *   - **不覆盖域侧已挂的 hints**：`payload.hints` 已是数组时**原样保留**（docspace 五个
 *     消费方自己就往结果 DTO 上挂 `hints`，写侧挂点仍在 service 内事务内组装）；本层是
 *     **合并者**——域侧占槽位，provider 拿剩余预算。**域侧条目本身不经 emitHints**（不参与
 *     去重、不落 emitted 行），本层也不改它们的字段。
 *   - **槽位预算（决策 5）**：`budget = max(0, HINT_MAX_PER_RESPONSE − 域侧条数)`。
 *     **预算为 0 仍求值**——那是观测「域侧挤占」的唯一途径（成本 = 每个命中 provider
 *     一次求值，provider 侧已按事实折叠 + 记忆化收敛）。未获槽位的候选落
 *     `DOC_HINT_SUPPRESSED`（`reason=slot_truncated`），不占去重窗口。
 *   - **零开销快路径**：无 provider，或事实袋为空 → 直接返回原 payload，不做任何求值
 *     （「阶段一零 provider」只是其中一种形态，快路径不依赖它）。
 *   - **一次响应单信封**：全部 provider 的候选**并集**走**单次** `emitHints`（单一优先级序
 *     + 单一 ≤N 预算 + 存活项才占窗口）；**禁止**逐 provider 各拼一个信封（叠信封会破坏
 *     「只有存活项被标记」不变量，同 code 也会被重复算窗口）。
 *   - **SSE / 流式端点整链直通**：`@Sse()` 路由一律跳过（帧对象不是响应载荷，见
 *     `intercept` 内注释）；由此也保证**逐帧 Observable 不会被逐帧重复求值**。
 *   - **依赖方向**：本文件只 import 同模块 + `common/`；领域（docspace / memory）的
 *     语义一律经 provider 注入——出现 `modules/docspace/**` / `modules/memory/**`
 *     import 即越界（循环依赖征兆）。
 *   - **事实袋单例**：袋必须经 `hint-facts` 建立（禁止本地 new 一份 ALS）——见该文件
 *     的「单实例」不变量。
 *
 * [关联代码]
 *   - modules/hints/hint-facts.ts — 事实袋（ALS 单例；本文件是唯一建立点）
 *   - modules/hints/hint-emit.ts — 信封接线（排序 / 去重 / ≤3 截尾 / 埋点）
 *   - modules/hints/hint-registry.ts — code 元数据目录（阶段二 provider 的装配依据）
 *   - modules/hints/hints.module.ts — 模块装配（@Global；provider token 由根注入器解析）
 *   - config/app-interceptor-chain.ts — 链序单源（本文件必须排在 ResponseInterceptor 之后）
 *   - common/utils/actor.ts — 请求 → 统一身份（埋点 actor 维度的形状单源）
 *   - common/interceptors/response.interceptor.ts — 信封包装（本文件改的是**信封内的
 *     data 载荷**，writableEnded / SkipTransform 判定与它同源照抄）
 *   - hint.interceptor.spec.ts — 挂载 / 跳过规则 / fail-open / 禁空数组 / 真实 Nest 装配
 *
 * [持久踩坑]
 *   HINT-INT-1(DI 元数据): 注入类必须**值导入**——`import type` 会被 TS 擦除，
 *     `emitDecoratorMetadata` 退化成 Object，启动期报
 *     "can't resolve dependencies ... Function at index [N]"；直接 `new` 拦截器的单测
 *     覆盖不到这条，只有 e2e 会红。
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（链序 / 信封不变量 / 跳过规则）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增跳过规则时同步补 spec 用例；新增挂面时确认它不在 SkipTransform / SSE 名单里
 * =============================================================================
 */
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { Request, Response } from 'express';
// @Sse() 写在方法上的元数据键（= '__sse__'）：SSE 路由必须整链直通，理由见 intercept() 内注释
import { SSE_METADATA } from '@nestjs/common/constants';
import { SKIP_TRANSFORM_KEY } from '../../common/decorators/skip-transform.decorator';
import { resolveRequestActor } from '../../common/utils/actor';
import type { UnifiedActor } from '../../common/types/actor.types';
import { HINT_MAX_PER_RESPONSE, type HintCandidate, type HintEnvelopeItem } from './hint-core';
import { emitHints, type HintEmitProfile } from './hint-emit';
// ⚠️ **必须是值导入**（不是 `import type`）：本类是**被 DI 注入的构造器参数**，
// `emitDecoratorMetadata` 需要运行期类引用才能生成 design:paramtypes——
// 类型导入被 TS 擦除后，元数据退化成 Object，Nest 报
// 「can't resolve dependencies ... argument Function at index [1]」（e2e 实证）
import { HintDedupService } from './hint-dedup.service';
import {
  createHintFactBag,
  peekFacts,
  runWithHintFacts,
  type HintFact,
  type HintFactBag,
} from './hint-facts';

/**
 * 事实袋 provider 注入 token。
 *
 * 阶段一：`HintsModule` 以 `useValue: []` 注册（standalone / 测试缺省）。
 * 阶段二：`AppModule` 的 providers **覆盖**本 token，值 = `config/app-hint-provider-chain.ts`
 * 单源清单经 `useFactory(...providers)` 聚合（Nest 语义：模块自有 provider 优先于被 import
 * 模块的同名 token，故 HintsModule 的缺省值在生产被遮蔽、在 standalone 测试模块里仍生效）。
 */
export const HINT_FACT_PROVIDERS = Symbol('HINT_FACT_PROVIDERS');

/**
 * provider 求值上下文（阶段三，决策 7）：**请求身份**。
 *
 * `actor` 的两种形态都是有意义的：`UnifiedActor` = 已认证（provider 可做权限判定）；
 * `null` = 匿名（fail-closed：**缺 ctx 与 actor=null 同款处理**——provider 必须视作
 * 「不能写这个资源」）。
 */
export interface HintProviderContext {
  /** 触发者统一身份（未认证 / 无身份 ⇒ `null`；provider 一律 fail-closed） */
  actor: UnifiedActor | null;
}

/**
 * **事实 → 候选求值器**（阶段二起为生产实现；阶段一只有 spec fixture）。
 *
 * 实现纪律：
 * - `build` 是 **async 且永不抛**（本拦截器虽兜了 try/catch，但那只是兜底——抛异常等于该
 *   挂面永久静默，且会白白牺牲同响应里后续 provider 的机会）；异步是为了让 provider 能
 *   查库判定（如「本资源是否被活跃记忆项目绑定」），**不是**为了并发求值——每个 provider
 *   仍按 chain 顺序**串行**求值（全部求值后候选并集单次 finalize，见文件头）。
 * - `build` 的第三个参数 `ctx` 是**可选**的：缺省 = 匿名 ⇒ 需要权限判定的 provider 必须
 *   fail-closed（不产出）。**这不是「向后兼容的空壳」**——正确性修正刻意不可被静默绕过。
 * - `resolveMessage` 的文案必须取自单源常量，禁写字面量。
 *
 * @typeParam TCode code 联合（provider 自己的词表）
 */
export interface HintFactProvider<TCode extends string = string> {
  /** 本 provider 关注的事实名（`HintFact.name`；空数组 = 永不产出） */
  readonly factNames: readonly string[];
  /** 产出面标识（进埋点 `surface`；取值见 hint-log 的开放词表） */
  readonly surface: string;
  /** 参与排序的优先级序（缺省 = 保持候选传入序） */
  readonly priority?: readonly TCode[];
  /** 候选 → 文案（单源解析） */
  resolveMessage(candidate: HintCandidate<TCode>): string;
  /** code → 日志族归属（缺省 = null） */
  familyOf?(code: TCode): string | null;
  /**
   * code → **去重窗口长度**（ms）——去重窗口长度的**单源 = 注册表**
   * （`hint-registry` 的 `HintDefinition.ttlMs`），provider 通常只做委托
   * （`HintRegistry.ttlOf`）；缺省 / 返回 `undefined` ⇒ dedup 走缺省 6h。
   * ⚠️ 缺省**不是**豁免去重（见 `hint-emit.ts` 的口径订正）。
   */
  ttlOf?(code: TCode): number | undefined;
  /**
   * 事实 + 响应载荷 → 候选（返回空数组 = 本次不产出；**禁返回空数组当占位**）。
   *
   * @param ctx 请求身份（可选；**缺省 = 匿名**，需要权限判定的 provider 必须 fail-closed）
   */
  build(
    facts: readonly HintFact[],
    payload: unknown,
    ctx?: HintProviderContext,
  ): Promise<readonly HintCandidate<TCode>[]>;
}

/**
 * 合并求值时埋点 `surface` 的**兜底值**（见 `attachHints` 的 emitHints 调用）。
 *
 * 正常路径由 `surfaceOf` 逐候选解析出**产出它的 provider** 的 `surface`；本常量只出现在
 * 「owner 查找不可达」这一防御分支（候选必来自某个 provider ⇒ 不应发生）。
 */
const HINT_PROVIDER_SURFACE_FALLBACK = 'hint_provider';

/**
 * 非对象载荷守卫（数组 / Buffer / Date / 流 / 标量一律不挂 hints）。
 *
 * ⚠️ **本守卫拦不住 `@Sse()` 端点**：SSE 的帧对象在 Nest 侧被包成
 * `{ data: <handler 返回值>, id?, type?, retry? }` 这种**普通对象**（`Observable` 的
 * `_transform` 只把 `message.data` 序列化进帧），挂上去的 `hints` 既不会被写出、又白付一次
 * 求值——故 SSE 由 `intercept()` 的 `SSE_METADATA` 判定**显式直通**，不依赖本守卫。
 */
function isPlainObjectPayload(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date || Buffer.isBuffer(value)) return false;
  // 流式载荷（下载流等）：挂了 hints 也不会被序列化，直接跳过
  if (typeof (value as { pipe?: unknown }).pipe === 'function') return false;
  return true;
}

/**
 * 空间归属（埋点维度）：写侧结果 DTO 的公共字段 `spaceId`；取不到 → null
 * （null = 无单一空间归属，与 doc-search 的全局检索面同款语义）。
 */
function resolveSpaceId(payload: Record<string, unknown>): string | null {
  return typeof payload.spaceId === 'string' ? payload.spaceId : null;
}

/**
 * hint 触发器拦截器（见文件头不变量）。
 */
@Injectable()
export class HintInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HintInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly dedup: HintDedupService,
    // 阶段一恒为空数组 → 全局零开销直通；@Optional 保证未注册 token 的测试模块也能构造
    @Optional() @Inject(HINT_FACT_PROVIDERS) private readonly providers: HintFactProvider[] = [],
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // 快路径①②：非 http 上下文（WS / 微服务消息）与无 provider（**零装配态**：standalone /
    // 测试模块未覆盖 token 的形态）→ 直通，连事实袋都不建
    if (context.getType() !== 'http') return next.handle();
    if (this.providers.length === 0) return next.handle();

    // 快路径③：显式要求裸数据的端点（健康检查 / 文件下载 / skill raw）→ 直通
    const skipTransform = this.reflector.getAllAndOverride<boolean>(SKIP_TRANSFORM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipTransform) return next.handle();

    // 快路径④：SSE 端点整链直通。**不能指望载荷形态守卫**：`@Sse` 的帧对象在 Nest 侧
    // 是普通对象（`{ data, id?, type?, retry? }`，见 sse.controller / Nest 的
    // `_transform`），`isPlainObjectPayload` 判不出来；而 SSE 是**逐帧** Observable，
    // 若放进来会被逐帧求值并逐帧挂 hints（帧里的 hints 根本写不出去）。
    // 副作用（正向）：直通 ⇒ 逐帧 Observable 只可能有一次求值语义，不存在跨帧污染。
    const isSse = this.reflector.getAllAndOverride<boolean>(SSE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isSse) return next.handle();

    // 事实袋由本拦截器建立（唯一建立点）；句柄经闭包带进 mergeMap 回调——回调是否落在
    // ALS 上下文内取决于框架的订阅时机，显式持有句柄就不需要这个前提。
    const bag = createHintFactBag();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // 为什么在 run 内**完成订阅**（而不是只包住 `next.handle()` 的调用）：
    // 事实层面，Nest 10 的拦截器链是
    // `handle: () => defer(AsyncResource.bind(() => nextFn(i + 1))).pipe(mergeAll())`
    // （@nestjs/core@10.4.22 interceptors-consumer.js:21）——`AsyncResource.bind` 在
    // `handle()` 被调用时就把当时的 async 上下文捕获进绑定函数，所以「run 只包
    // next.handle()」同样能让 handler 读到 ALS store（同构探针 + 真实 Nest 装配实测：
    // 两种形态都读到，无 run 的对照组为空）。
    // 既然如此仍取本形态，理由只有一条：**不依赖框架内部实现细节**——显式边界少一个
    // 隐式前提（将来换了绑定方式/换了 rxjs 版本也照样成立），代价只是一个包装 Observable。
    const carried = new Observable<unknown>((subscriber) => {
      const subscription = runWithHintFacts(() => next.handle().subscribe(subscriber), bag);
      return () => subscription.unsubscribe();
    });

    return carried.pipe(
      // mergeMap（不是 map）：阶段二起 `attachHints` 是 async（provider 要查库判定），
      // map 会把 Promise 原样交给 subscriber —— 响应体变成 `{}`（Promise 无自有键）。
      // ⚠️ **fail-open 必须 await-aware**：`await this.attachHints(...)` 必须**在本回调的
      // try/catch 内**——rejection 冒泡进 subscriber 会把一次成功写入的 200 打成 500。
      mergeMap(async (payload) => {
        try {
          return await this.attachHints(payload, bag, request, response);
        } catch (error) {
          // fail-open：hint 任何环节失败都不得影响主响应；日志只落错误摘要（禁 payload 原文）
          this.logger.warn(
            `[HINT_INTERCEPTOR_FAILED] hint 求值异常，已原样返回主响应: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return payload;
        }
      }),
    );
  }

  /**
   * 响应载荷 → 挂 hints 的载荷（**async**；异常由调用方兜）。
   *
   * 快路径⑤⑥（writableEnded / 袋空 / 载荷形态）**全部在第一次 `await` 之前返回**——
   * 它们的意义是「零求值开销」，挪到 await 之后就失去意义。原「⑦域侧已挂即直通」在
   * 阶段三变成 **merge**（域侧占槽 + provider 拿剩余预算），故不再是快路径。
   *
   * @param payload handler 原始返回值
   * @param bag 本请求事实袋句柄
   * @param request 用于解析触发者统一身份（provider 的权限判定输入）
   * @param response 用于 writableEnded 判定
   * @returns 原 payload 或 `{ ...payload, hints }`（**无 provider 存活项时逐字原样**）
   */
  private async attachHints(
    payload: unknown,
    bag: HintFactBag,
    request: Request,
    response: Response,
  ): Promise<unknown> {
    // 快路径⑤：controller 已手动终结响应（res.send 后 writableEnded）→ 二次写会抛
    if (response.writableEnded) return payload;
    // 快路径⑥：本次请求没有任何事实 → 零求值开销
    const facts = peekFacts(bag);
    if (facts.length === 0) return payload;
    if (!isPlainObjectPayload(payload)) return payload;

    // ⑦ merge（阶段三决策 5；不再是快路径）：域侧已自行挂了 hints（docspace 五个消费方
    // 在 service 内挂）⇒ 域侧条目**原样保留并占槽位**，provider 候选只拿剩余预算。
    // 域侧条目**绝不回流 emitHints**（不去重、不落 emitted 行——域侧已各自观测过）。
    const domainHints: HintEnvelopeItem[] = Array.isArray(payload.hints)
      ? (payload.hints as HintEnvelopeItem[])
      : [];
    // 预算 = 3 − 域侧条数；**为 0 仍求值**（观测「域侧挤占」的唯一途径，见文件头不变量）
    const budget = Math.max(0, HINT_MAX_PER_RESPONSE - domainHints.length);

    // 请求身份（形状单源 = common/utils/actor.ts）：未认证 ⇒ null ⇒ provider fail-closed
    const actor = resolveRequestActor(request);

    // 多 provider **合并求值**（阶段三决策 6）：「首个产出者胜出」退役——全部 provider 按
    // 链序求值，候选并集**单次** finalize。候选连同产出它的 provider 一起收着：合并 profile
    // 需要按 code 找回原 provider 的文案 / 族 / 窗口 / 产出面（本文件不认识任何 code）。
    const collected: Array<{ candidate: HintCandidate; provider: HintFactProvider }> = [];
    for (const provider of this.providers) {
      if (!facts.some((fact) => provider.factNames.includes(fact.name))) continue;

      let candidates: readonly HintCandidate[];
      try {
        candidates = await provider.build(facts, payload, { actor });
      } catch (error) {
        // per-provider fail-open（**内层**，见文件头「fail-open 是双层」）：单个 provider
        // 挂掉不拖累同响应里后续 provider 的机会；日志只落 surface + 摘要（禁 payload 原文）
        this.logger.warn(
          `[HINT_INTERCEPTOR_PROVIDER_FAILED] surface=${provider.surface}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      for (const candidate of candidates) collected.push({ candidate, provider });
    }
    // 禁空数组：无任何候选 → 原样返回（域侧有挂时**逐字保留**，provider 不参与）
    if (collected.length === 0) return payload;

    /** code → 产出它的 provider（合并 profile 的按码分派表；同 code 多 provider 时链序首个胜） */
    const ownerOf = new Map<string, HintFactProvider>();
    for (const { candidate, provider } of collected) {
      if (!ownerOf.has(candidate.code)) ownerOf.set(candidate.code, provider);
    }

    // 合并优先级序 = 链序拼接各 provider 的声明序（同 code 去重，先见者胜）；
    // 全部 provider 都未声明 priority ⇒ 不挂该键（内核落「保持候选传入序」）
    const mergedPriority: string[] = [];
    const seenPriority = new Set<string>();
    for (const provider of this.providers) {
      for (const code of provider.priority ?? []) {
        if (seenPriority.has(code)) continue;
        seenPriority.add(code);
        mergedPriority.push(code);
      }
    }

    const profile: HintEmitProfile = {
      ...(mergedPriority.length > 0 ? { priority: mergedPriority } : {}),
      // 按码分派回原 provider（provider 的 resolveMessage 是文案单源；候选自带的 message
      // 覆盖由内核优先消费，不到这里）。`?? candidate.code` 是不可达兜底（owner 必在）
      resolveMessage: (candidate) =>
        ownerOf.get(candidate.code)?.resolveMessage(candidate) ?? candidate.code,
      familyOf: (code) => ownerOf.get(code)?.familyOf?.(code) ?? null,
      // 去重窗口长度单源 = 注册表：provider 委托 `HintRegistry.ttlOf`；返回 undefined ⇒ 6h 缺省
      ttlOf: (code) => ownerOf.get(code)?.ttlOf?.(code),
    };

    const hints: HintEnvelopeItem[] | undefined = emitHints(
      this.logger,
      this.dedup,
      collected.map((entry) => entry.candidate),
      {
        // 单一 surface = **兜底值**（逐候选 `surfaceOf` 覆盖它）；本层所有候选都来自某个
        // provider ⇒ 只在「owner 查找不可达」这一防御分支才会被用到
        surface: HINT_PROVIDER_SURFACE_FALLBACK,
        // **逐候选**产出面（合并求值的关键）：多条候选可能来自不同 provider，
        // 记成单一 surface 会让埋点失去「谁产出的」这一维
        surfaceOf: (candidate) =>
          ownerOf.get(candidate.code)?.surface ?? HINT_PROVIDER_SURFACE_FALLBACK,
        // 空间归属 = 响应载荷的 spaceId：本层全部候选共享同一响应语境。
        // （跨空间/逐候选归属的场景用 `HintEmitContext.spaceIdOf` 钩子，本层用不到）
        spaceId: resolveSpaceId(payload),
        // 身份形状单源 = common/utils/actor.ts；未认证请求归 'system'（与 docspace 写侧同款）
        actorId: actor?.id ?? 'system',
      },
      { profile, maxHints: budget },
    );

    // 禁空数组：provider 侧无存活项（全被压制 / 截空）→ 逐字保留原 payload
    // （域侧已挂的条目因此不受任何影响——本层不改写它们）
    if (!hints) return payload;
    // 域侧在前、provider 在后：域侧本来占的就是「先到的槽位」，顺序即预算的可见形态
    return { ...payload, hints: [...domainHints, ...hints] };
  }
}
