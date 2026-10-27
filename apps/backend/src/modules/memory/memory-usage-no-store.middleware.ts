/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Usage 两路由的**全出口 `Cache-Control: no-store`** 中间件
 *
 * [代码职责]
 *   - 在请求进入 Nest 管道**之前**设置 `Cache-Control: no-store`——因此 guard（401）、
 *     ValidationPipe（400）、throttler（429）、service（403/404/409/502/503）与成功 200
 *     的响应都带该头；异常过滤器只改 body/status，不会清掉已设置的响应头
 *
 * [权威文档]
 *   - 计划 `constantine-pantha-lockjaw.md` §2.2（所有 usage 响应含 guard/DTO/限流/引擎错误
 *     no-store）
 *
 * [关键不变量]
 *   - **必须是 middleware 而不是 interceptor/filter**：interceptor 在 guard 之后执行
 *     （401 不会经过它），exception filter 只在错误时执行（200 不经过它）。只有 middleware
 *     在**所有出口之前**跑一次。
 *   - **路径级挂载在 MemoryModule.configure**（两条 GET 路由）；不要类级挂到整个
 *     `MemoryController`——那会把 no-store 扩散到所有 memory 端点（不是本批的契约变更）。
 *   - **不读写 body、不做业务判断**：这里只加一个头。
 *
 * [关联代码]
 *   - ../memory.module.ts — `configure()` 的挂载点
 *   - ../memory.controller.ts — 两条 usage 路由
 * =============================================================================
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Usage 路由的 no-store 中间件（见文件头）。 */
@Injectable()
export class MemoryUsageNoStoreMiddleware implements NestMiddleware {
  /**
   * @param _req 请求（不使用；保留 NestMiddleware 签名）
   * @param res 响应（在管道之前写头，覆盖所有出口）
   * @param next 继续管道
   */
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'no-store');
    next();
  }
}
