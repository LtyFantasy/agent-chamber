/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory Usage 读面的**进程内全局并发闸**：同一时刻最多 N（=2）个 engine 调用在飞，
 *     超出直接 429 + `Retry-After`，**不排队**
 *
 * [代码职责]
 *   - `run<T>(fn)`：占槽 → 执行 → **finally 释放**；占不到槽立即抛
 *     `MemoryUsageRateLimitedException(1, 'concurrency')`
 *   - `inFlight`：当前占槽数（只读；单测/排障用）
 *
 * [权威文档]
 *   - 计划 `constantine-pantha-lockjaw.md` §2.1（usage 会扫描大量 ledger，limit 只限返回不限扫描）
 *     与 §3.2.6（进程内并发闸初始全局 2，所有出口释放）
 *
 * [关键不变量]
 *   - **不排队**：排队会把一次突发变成"全部请求都等到超时"；429 让调用方显式退避
 *     （与上游 429 同一套 `Retry-After` 语义）。
 *   - **必须 `finally` 释放**：引擎 never-throw 只是"不抛异常"，但服务层的权限/映射仍可能抛
 *     ——任何一条抛出路径漏了 release 都会永久吃掉一个槽（两次异常后端点全 429）。
 *   - **只包 engine 调用**：权限/共享扫描/默认窗口物化在**占槽之前**完成——被拒绝的请求
 *     不该消耗容量，否则 403/409 的洪峰能把合法请求挡在槽外。
 *   - **进程内而非分布式**：多实例部署下每个实例各有 N 个槽。这是保守初值，不是全局配额；
 *     容量实测后再决定是否要跨实例闸（本批不做，避免新增依赖）。
 *
 * [关联代码]
 *   - ../memory-usage.service.ts — 唯一消费方（只包 engine 调用）
 *   - ../memory.constants.ts — `MEMORY_USAGE_CONCURRENCY_LIMIT` 单源
 *   - ../memory.constants.ts 的 `MemoryUsageRateLimitedException` — 429 的形状
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import {
  MEMORY_USAGE_CONCURRENCY_LIMIT,
  MemoryUsageRateLimitedException,
} from './memory.constants';

/** Usage engine 调用的进程内并发闸（见文件头）。 */
@Injectable()
export class MemoryUsageConcurrencyGate {
  /** 当前占槽数（进程内；`finally` 保证归零） */
  private active = 0;

  /**
   * 在并发闸内执行一次 engine 调用。
   *
   * @param fn engine 调用（只允许包这一层；权限/扫描必须在调用本方法**之前**完成）
   * @throws MemoryUsageRateLimitedException 429（已占满；`Retry-After: 1`）
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MEMORY_USAGE_CONCURRENCY_LIMIT) {
      throw new MemoryUsageRateLimitedException(1, 'concurrency');
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      // ⚠️ 任何出口（成功 / 引擎失败 / 映射抛错）都在这里释放；漏了 = 槽位永久泄漏
      this.active -= 1;
    }
  }

  /** 当前占槽数（只读；单测断言"拒绝后确实释放"用） */
  get inFlight(): number {
    return this.active;
  }
}
