/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/spec.md (错误码体系)
 *   - 补充: docs/architecture.md §3.2 (全局异常过滤器)
 *
 * [踩坑索引] P2-#4(4xx 带 stack 记 error 泄露用户输入)
 *
 * [铁律关联] #9(代理层透传) #11(注释)
 *
 * [详细踩坑]（最多 5 条）
 *   P2-#4: 所有 4xx/5xx 均 logger.error(stack)，QueryFailedError.stack 含
 *          driverError.detail（回显用户输入值），生产日志累积输入回显。
 *          修复：status >= 500 才记 stack（error），4xx 仅记摘要（warn 无 stack）。
 *          见 memory/2026-08-02.md §批次 A4。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
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
import { QueryFailedError, EntityNotFoundError } from 'typeorm';

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
    } else if (exception instanceof QueryFailedError) {
      // PostgreSQL/TypeORM 底层错误映射为 4xx，避免暴露 500
      const pgMessage = exception.message || '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = (exception as any).driverError?.detail || '';
      const fullMessage = `${pgMessage} ${detail}`.toLowerCase();
      if (pgMessage.includes('invalid input syntax for type uuid')) {
        status = HttpStatus.BAD_REQUEST;
        code = ErrorCode.VALIDATION_ERROR;
        message = 'Invalid UUID format';
      } else if (pgMessage.includes('violates foreign key constraint')) {
        // 外键失败通常是引用了不存在的资源；若提示包含 not present 视为 404，否则 400
        status = fullMessage.includes('is not present in table')
          ? HttpStatus.NOT_FOUND
          : HttpStatus.BAD_REQUEST;
        code = status === HttpStatus.NOT_FOUND ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_ERROR;
        message =
          status === HttpStatus.NOT_FOUND ? 'Referenced resource not found' : 'Invalid reference';
      } else if (pgMessage.includes('violates unique constraint')) {
        status = HttpStatus.CONFLICT;
        code = ErrorCode.RESOURCE_CONFLICT;
        message = 'Resource conflict';
      }
    }

    // 日志降噪：5xx 为服务端错误，error 级 + stack 便于排查；
    // 4xx 为客户端错误（含 QueryFailedError 映射的 4xx），warn 级且不带 stack，
    // 避免 driverError.detail 回显用户输入污染生产日志。
    const logMessage = `${request.method} ${request.url} ${status} - ${message}`;
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
