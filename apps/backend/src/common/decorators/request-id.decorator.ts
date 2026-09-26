/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 把**已归一化**的请求 id（`RequestIdMiddleware` 写入 `req.requestId`）暴露成控制器参数
 *
 * [代码职责]
 *   - `@RequestId()`：取当前请求的 id（缺失时 `null`），供业务把"本次请求"写进日志/审计
 *
 * [权威文档]
 *   - 线上 DocSpace `docs/api-definition.md` — 文档搜索章（traceId 仅作线索，不保证唯一）
 *   - 线上 DocSpace `docs/architecture.md` — 请求链路（四者同源的 request id）
 *
 * [关键不变量]
 *   - **必须是 middleware 已归一化的那个值**（不直接读 header）：`x-request-id` 是**调用方可控
 *     输入**，原样采信可伪造日志行/在 DB 里塞任意串。middleware 已在采信前做白名单归一化，
 *     故 `req.requestId` 是唯一的可信来源（`req.requestId` / 响应头 / 应用日志 / DB traceId
 *     四者同源，见 `request-id.middleware.ts`）。
 *   - **缺失即 `null`，不生成新值**：在本层再生成一份会让"四者同源"当场破功（响应头/日志用了
 *     另一个 id，联查断链）。生成是 middleware 的职责。
 *   - **它不是业务主键**：只作日志线索（不保证唯一——调用方可以复用同一个 id），抽检以
 *     `sqlRanks` / `finalOrderKeys` 等**自产标量**为准。
 *
 * [关联代码]
 *   - common/interceptors/request-id.middleware.ts — 唯一写入点（含白名单归一化）
 *   - common/utils/request-id.util.ts — 生成器（`req_<16 hex>`）
 *   - modules/docspace/doc.controller.ts / modules/search/search.controller.ts — 消费点
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 不要在本文件里加"缺失就生成"的兜底（会破坏四者同源，见 [关键不变量]）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/** 承载归一化请求 id 的请求属性名（与 middleware 的单源约定） */
export const REQUEST_ID_PROPERTY = 'requestId';

/**
 * 取当前请求的归一化请求 id（**导出以便单测直击**；装饰器只是它的一层参数绑定）。
 *
 * @param request 请求对象（Express `req`）
 * @returns 归一化后的请求 id；middleware 未执行（如单测直调 controller）时为 `null`
 */
export function readRequestId(request: unknown): string | null {
  const value = (request as Record<string, unknown> | null | undefined)?.[REQUEST_ID_PROPERTY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `@RequestId()` 参数装饰器（见文件头不变量：**缺失即 null，不生成**）。
 *
 * @param _data 未使用（参数装饰器签名要求）
 * @param ctx 执行上下文
 * @returns 归一化后的请求 id，或 `null`
 */
export const RequestId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    readRequestId(ctx.switchToHttp().getRequest()),
);
