/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 请求 id 的**唯一写入点**：为每个请求确定 id，并保证它在四个面上完全一致
 *
 * [代码职责]
 *   - 采信调用方 `x-request-id`（**白名单归一化后**）或生成新 id → 写 `req.requestId`
 *   - 回写响应头 `X-Request-Id`（排障时把浏览器/CLI 的失败请求与后端日志对上）
 *
 * [权威文档]
 *   - 线上 DocSpace `docs/architecture.md` — 请求链路（`X-Request-Id` 贯穿）
 *   - 线上 DocSpace `docs/api-definition.md` — 文档搜索章（traceId 仅作线索）
 *
 * [关键不变量]
 *   - **采信前必须归一化**：`x-request-id` 是**调用方可控输入**，原样采信等于让外部往
 *     应用日志与 `experience_judgments.request.traceId` 里注入任意串（可伪造日志行、可超长、
 *     可含换行）。白名单 = `/^[A-Za-z0-9_.:-]{1,64}$/`（只允许 id 常见字符、限长 64），
 *     **不匹配即改生成**（不拒绝请求——id 是观测设施，不该成为拒绝面）。
 *   - **四者同源**：`req.requestId` / 响应头 `X-Request-Id` / 应用日志 / DB 侧 `traceId`
 *     必须是**同一个值**——任一处另生成一份，"用 id 联查日志与 DB"当场断链。
 *   - **数组形态的 header 取第一个**（node 在重复头时给 `string[]`）：不取第一个会得到
 *     `"[object Object]"`/`"a,b"` 之类经归一化后被丢弃的假值，行为退化成"总是重新生成"。
 *
 * [关联代码]
 *   - common/utils/request-id.util.ts — 生成器（`req_<16 hex>`；与归一化后的合法形态同域）
 *   - common/decorators/request-id.decorator.ts — 消费点（`@RequestId()`）
 *   - modules/docspace/doc-search.service.ts — 把 traceId 写进重排日志行（标量集之一）
 *   - app.module.ts — 中间件的注册点（`forRoutes('*')`）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 放宽白名单前先想清楚"日志/DB 都是长期保留、会被翻查的"
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { generateRequestId } from '../utils/request-id.util';

/**
 * 可采信的请求 id 形态（白名单）。
 *
 * rationale：调用方提供的 id 会进应用日志与 DB —— 只放行 id 生态里真实存在的字符
 * （字母数字 + `_ . : -`，覆盖 uuid / `req_xxx` / 网关的 `trace:span` 形态），长度 1~64。
 * 任何其它字符（空白、换行、百分号、中文……）一律**不采信**（改生成新 id），
 * 从而不可能凭 header 伪造日志行或写入未预期的串。
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers['x-request-id'];
    // 重复头会被 node 合并成数组：取第一个（见文件头不变量）
    const raw = Array.isArray(header) ? header[0] : header;
    const candidate = typeof raw === 'string' ? raw.trim() : '';
    // 白名单归一化：不匹配 ⇒ 生成（**不是**拒绝请求）
    const requestId = REQUEST_ID_PATTERN.test(candidate) ? candidate : generateRequestId();
    req['requestId'] = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
