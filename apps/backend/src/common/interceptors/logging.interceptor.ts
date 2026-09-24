/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 全局请求日志（每个 HTTP 请求的成功/失败摘要行）
 *
 * [代码职责]
 *   - 在响应后打一行 `[requestId] METHOD url status +Nms`；错误路径附 stack
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 — 全局拦截器链
 *
 * [关键不变量]
 *   - 打 URL **必须**经 `redactUrl()`：签名 URL 的 `?token=` 是能力凭证，
 *     明文进日志等于把凭证写盘（读日志权限即可取用）
 *   - 4xx 也记 stack（与 all-exceptions.filter 的"4xx 不记 stack"纪律不一致）：
 *     已知不一致，登记为后续跟进项，本批不改行为
 *
 * [关联代码]
 *   - common/utils/redact-url.ts — 脱敏单一事实来源（另被 all-exceptions.filter 消费）
 *   - common/filters/all-exceptions.filter.ts — 异常路径日志（同款脱敏）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import { redactUrl } from '../utils/redact-url';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method;
    // 脱敏在捕获点完成（不是打印点）：url 变量后续只用于日志，先洗后存避免漏改分支
    const url = redactUrl(request.url);
    const requestId = request['requestId'] || 'unknown';
    const now = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const statusCode = context.switchToHttp().getResponse().statusCode;
          this.logger.log(`[${requestId}] ${method} ${url} ${statusCode} +${Date.now() - now}ms`);
        },
        error: (err) => {
          const statusCode = err.status || 500;
          this.logger.error(
            `[${requestId}] ${method} ${url} ${statusCode} +${Date.now() - now}ms`,
            err.stack,
          );
        },
      }),
    );
  }
}
