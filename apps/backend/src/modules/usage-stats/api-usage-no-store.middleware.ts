/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台调用统计 `GET /system/api-usage` 的**全出口 `Cache-Control: no-store`**
 *
 * [代码职责]
 *   - 在请求进入 Nest 管道**之前**写头——guard（401/403）、ValidationPipe（400）、
 *     throttler（429）、service（200）的响应都带该头
 *
 * [权威文档]
 *   - 计划 `constantine-pantha-lockjaw.md` §2.4 / §3.3（平台响应同样 no-store）
 *   - 先例: `../memory/memory-usage-no-store.middleware.ts`（同款中间件 + 同款理由）
 *
 * [关键不变量]
 *   - **必须是 middleware，不是 @Header/interceptor/filter**：`@Header` 只覆盖进入 handler
 *     后的成功响应；guard 与管道错误不经过它。interceptor 在 guard 之后；exception filter
 *     只在错误时执行。只有 middleware 在所有出口之前跑一次。
 *   - **只挂 `system/api-usage` 这一条 GET**：不要类级扩散到 usage-stats 的其它端点
 *     （上报面不是本批的缓存契约变更）。
 *
 * [关联代码]
 *   - usage-stats.module.ts — `configure()` 的路径级挂载
 *   - api-usage.controller.ts — 被保护的单条路由
 * =============================================================================
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** `/system/api-usage` 的 no-store 中间件（见文件头）。 */
@Injectable()
export class ApiUsageNoStoreMiddleware implements NestMiddleware {
  /**
   * @param _req 请求（不使用；保留签名）
   * @param res 响应（在管道之前写头）
   * @param next 继续管道
   */
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'no-store');
    next();
  }
}
