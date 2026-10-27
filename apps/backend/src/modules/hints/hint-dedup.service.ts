/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 **hint 去重窗口**（v1.92.0-dev 2 期抽核，阶段一）：同一
 *     (actor, code, resourceKey) 在 TTL 窗口内只送达一次，压制 hint 疲劳
 *     （收敛帖最大风险项）。
 *
 * [代码职责]
 *   - 内存 TTL Map（`key → { markedAt, expiresAt }`）：`isSuppressed` 判定 + 过期即清；
 *     `mark` 写入（容量满则**插前删最旧**——Map 迭代序即插入序）。
 *   - **per-code TTL 覆盖**：`mark` / `isSuppressed` 接受可选 `ttlMs`（缺省 6h）——
 *     阶段二的新 code 用 24h 窗口时**不需要**新的窗口实现。
 *   - 生产单实例（deploy.sh 宿主机直跑前后端），内存方案成立；未来多实例的唯一后果
 *     是同一 hint 重复送达（advisory 无害），不是正确性问题。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」小节
 *     （去重窗口与幂等交互）
 *   - 补充: 线上 docs/spec.md §4.1a「hints 信封类型」（DocHint 类型契约）
 *
 * [关键不变量]
 *   - **key 形态固定** `${actorId}:${code}:${resourceKey}`——resourceKey 语义：
 *     写侧 = docId / routeId / categoryId；读侧 = spaceId+筛选签名（suggest_relaxing）
 *     或解析到的 path（query_looks_like_path）。
 *   - **normalized 态不去重**：`tags_normalized` 是「归一已发生」的每次请求事实回显，
 *     调用方必须在传入前就跳过本服务（见 hint-core.finalizeHints 的 status 分支）。
 *   - **幂等 replay 不消耗窗口**：replay 在业务计算**之前**早退（返回首次快照），
 *     根本到不了本服务——同 key 重放不会压制后续真实请求。
 *   - **只在送达时标记**：调用方先 `isSuppressed` 过滤、截断后再 `mark` 存活项
 *     （先 dedup 过滤再按优先级截尾，未送达的不占用窗口）。
 *   - **ttlMs 语义 = 缩短立即生效、放宽不追溯**：生效窗口 = `min(标记时的窗口,
 *     markedAt + 本次声明的 ttlMs)`。默认两端同值 ⇒ 与旧实现逐字等价；
 *     把某 code 的 TTL 从 6h 放宽到 24h 不会追溯延长旧窗口（安全方向）。
 *   - 内存方案**不持久**：进程重启窗口清零（advisory 语义，接受）。
 *
 * [关联代码]
 *   - modules/hints/hint-core.ts — finalizeHints（过滤 → 截尾 → 标记的唯一编排点）
 *   - modules/hints/hint-emit.ts — 接线层（本服务的唯一生产调用方）
 *   - modules/hints/hint-registry.ts — code 元数据目录（`ttlMs` 声明的来源，
 *     **阶段一零消费**，阶段二由 provider 用它装配 mark/isSuppressed 的覆盖值）
 *   - modules/docspace/doc.service.ts / doc-move.service.ts / doc-search.service.ts /
 *     doc-route.service.ts / docspace.service.ts — 五面消费方（Nest provider 注入）
 *   - hint-dedup.service.spec.ts — TTL / 容量淘汰 / reset / per-code TTL 覆盖单测
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';

/** 去重窗口 TTL（6 小时）——同一 (actor, code, resource) 在该窗口内只送达一次 */
export const HINT_DEDUP_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 去重表容量上限（1 万条）。rationale：单条 entry ≈ 百字节，1 万条约 MB 级内存；
 * 满则**插前删最旧**（Map 迭代序 = 插入序，首个键即最旧）——不引入 LRU 复杂度，
 * 淘汰语义对 advisory 提示足够。
 */
export const HINT_DEDUP_MAX_ENTRIES = 10_000;

/** 窗口条目（标记时刻 + 到期时刻；`markedAt` 只服务 per-code TTL 覆盖的窗口重算） */
interface HintWindowEntry {
  /** 标记时刻（epoch ms） */
  markedAt: number;
  /** 到期时刻（epoch ms）= markedAt + 标记时声明的 ttlMs */
  expiresAt: number;
}

/**
 * hint 去重窗口（Nest `@Injectable()` provider，非模块级单例——测试隔离与 mock 需要）。
 *
 * 生命周期 = 进程；无持久化（生产单实例，见文件头）。
 */
@Injectable()
export class HintDedupService {
  /** key → 窗口条目；Map 迭代序 = 插入序（容量淘汰依赖此性质） */
  private readonly seen = new Map<string, HintWindowEntry>();

  /**
   * 判定该 (actor, code, resourceKey) 是否仍在窗口内（= 应被压制）。
   *
   * 过期条目**读时即清**（惰性回收，避免独立的清理定时器）。
   *
   * @param actorId 触发者 actor ID
   * @param code hint 机器码（平台级开放：code 语义由注册表/领域侧定义）
   * @param resourceKey 去重资源键
   * @param ttlMs 本次声明的窗口长度（缺省 = {@link HINT_DEDUP_TTL_MS}）。
   *   **生效窗口 = min(标记时的窗口, markedAt + ttlMs)** —— 缩短立即生效、
   *   放宽不追溯（见文件头不变量）；缺省值 = 标记值 ⇒ 与旧行为逐字等价。
   * @returns true = 窗口内已送达过 → 本次压制；false = 可送达
   */
  isSuppressed(
    actorId: string,
    code: string,
    resourceKey: string,
    ttlMs: number = HINT_DEDUP_TTL_MS,
  ): boolean {
    const key = this.buildKey(actorId, code, resourceKey);
    const entry = this.seen.get(key);
    if (entry === undefined) return false;

    const effectiveExpiry = Math.min(entry.expiresAt, entry.markedAt + ttlMs);
    if (effectiveExpiry <= Date.now()) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 标记该 (actor, code, resourceKey) 已送达（开启窗口）。
   *
   * 容量守卫：已达上限且是新键时先删最旧（Map 首个键），再写入。
   *
   * @param ttlMs 本 code 的窗口长度（缺省 = {@link HINT_DEDUP_TTL_MS}；阶段二的
   *   24h code 由 provider 从注册表 `ttlMs` 取值传入）
   */
  mark(
    actorId: string,
    code: string,
    resourceKey: string,
    ttlMs: number = HINT_DEDUP_TTL_MS,
  ): void {
    const key = this.buildKey(actorId, code, resourceKey);
    if (!this.seen.has(key) && this.seen.size >= HINT_DEDUP_MAX_ENTRIES) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    const now = Date.now();
    this.seen.set(key, { markedAt: now, expiresAt: now + ttlMs });
  }

  /** 清空全部窗口记录（测试用；生产无调用点）。 */
  reset(): void {
    this.seen.clear();
  }

  /** 当前窗口记录数（测试用——容量淘汰断言的可观测面）。 */
  get size(): number {
    return this.seen.size;
  }

  /** key 形态单源（`${actorId}:${code}:${resourceKey}`） */
  private buildKey(actorId: string, code: string, resourceKey: string): string {
    return `${actorId}:${code}:${resourceKey}`;
  }
}
