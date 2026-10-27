/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/spec.md (错误码体系)
 *   - 补充: docs/architecture.md §3.2 (全局异常过滤器)
 *
 * [踩坑索引] P2-#4(4xx 带 stack 记 error 泄露用户输入) SQLSTATE-MAP(PG 映射单源已迁 pg-error.util.ts)
 *
 * [铁律关联] #9(代理层透传) #11(注释)
 *
 * [详细踩坑]（最多 5 条）
 *   P2-#4: 所有 4xx/5xx 均 logger.error(stack)，QueryFailedError.stack 含
 *          driverError.detail（回显用户输入值），生产日志累积输入回显。
 *          修复：status >= 500 才记 stack（error），4xx 仅记摘要（warn 无 stack）。
 *          见 memory/2026-08-02.md §批次 A4。
 *   SQLSTATE-MAP: QueryFailedError 只按**显式码表**映射（{22021,42601,54001}→400）；
 *          22012/22023/22P02 明文不映射（500 留 stack——22P02 是 9082464c 家族、
 *          22023 是 GUC 配置面，映成 400 = 把服务端 bug 伪装成用户错误）。
 *          **2026-10-17（F4 项5）起码表与 message 子串分支迁到 common/utils/pg-error.util.ts**
 *          （describePgError），本文件只委托——DocSpace 批量 per-item 消毒共用同一映射，
 *          两处各写一份必然漂移。码表头注（含「明文不映射」清单）随迁移过去。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 打 URL 必须经 redactUrl()（签名 URL 的 ?token= 是能力凭证，P2 批 2）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCode } from '@agent-chamber/shared';
import { EntityNotFoundError } from 'typeorm';
import { redactUrl } from '../utils/redact-url';
import { describePgError } from '../utils/pg-error.util';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = ErrorCode.INTERNAL_ERROR;
    let message = 'Internal server error';
    let data: Record<string, unknown> | null = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        if (typeof resObj.message === 'string') {
          message = resObj.message;
        } else if (Array.isArray(resObj.message)) {
          // DTO 校验失败常有多条违规（class-validator 每约束一条）：聚合到顶层 message，
          // Agent 一次看全所有违规字段；完整数组仍保留在 data.errors
          message = resObj.message.map(String).join('; ');
          data = { errors: resObj.message };
        }
        // 业务自定义 data 透传（v1.55 起）：异常响应显式携带 data 对象时原样透出到
        // 统一信封 data 槽（如 headingQuery 多命中的 candidates）。仅在 message 数组
        // 分支未占用 data 时生效（errors 优先，避免两种语义互相覆盖）。
        if (
          data === null &&
          typeof resObj.data === 'object' &&
          resObj.data !== null &&
          !Array.isArray(resObj.data)
        ) {
          data = resObj.data as Record<string, unknown>;
        }
        // 优先使用异常响应中自带的业务错误码
        if (typeof resObj.code === 'number') {
          code = resObj.code;
        }
      }

      // 当异常响应未提供自定义 code 时，fallback 到 HTTP status 映射
      const hasCustomCode =
        typeof res === 'object' &&
        res !== null &&
        (res as Record<string, unknown>).code !== undefined;
      if (!hasCustomCode) {
        switch (status) {
          case HttpStatus.BAD_REQUEST:
            code = ErrorCode.BAD_REQUEST;
            break;
          case HttpStatus.UNAUTHORIZED:
            code = ErrorCode.UNAUTHORIZED;
            break;
          case HttpStatus.FORBIDDEN:
            code = ErrorCode.FORBIDDEN;
            break;
          case HttpStatus.NOT_FOUND:
            code = ErrorCode.NOT_FOUND;
            break;
          case HttpStatus.TOO_MANY_REQUESTS:
            code = ErrorCode.RATE_LIMITED;
            break;
          case HttpStatus.CONFLICT:
            code = ErrorCode.RESOURCE_CONFLICT;
            break;
        }
      }
    } else if (exception instanceof EntityNotFoundError) {
      // TypeORM 实体未找到（如 findOneOrFail）
      status = HttpStatus.NOT_FOUND;
      code = ErrorCode.NOT_FOUND;
      message = 'Resource not found';
    } else {
      // PostgreSQL/TypeORM 底层错误 → 4xx 映射，避免暴露 500。
      // 判定与文案的**唯一单源**是 common/utils/pg-error.util.ts.describePgError
      // （返回 null = 不是可映射的 PG 错误 → 保持 500 INTERNAL_ERROR + 'Internal server
      // error' + stack 的服务端缺陷语义，与抽取前逐字一致）。
      const pg = describePgError(exception);
      if (pg) {
        status = pg.status;
        code = pg.code;
        message = pg.message;
      }
    }

    // 日志降噪：5xx 为服务端错误，error 级 + stack 便于排查；
    // 4xx 为客户端错误（含 QueryFailedError 映射的 4xx），warn 级且不带 stack，
    // 避免 driverError.detail 回显用户输入污染生产日志。
    // URL 经 redactUrl 脱敏（P2 批 2）：签名 URL 的 ?token= 是能力凭证，明文进日志 = 凭证落盘。
    const logMessage = `${request.method} ${redactUrl(request.url)} ${status} - ${message}`;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(logMessage, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(logMessage);
    }

    response.status(status).json({
      code,
      message,
      data,
      timestamp: new Date().toISOString(),
      requestId: request['requestId'] || 'unknown',
    });
  }
}
