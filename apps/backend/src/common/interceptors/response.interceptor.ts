import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request, Response } from 'express';
import { ErrorCode } from '@agent-chamber/shared';
import { SKIP_TRANSFORM_KEY } from '../decorators/skip-transform.decorator';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, unknown> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const requestId = request['requestId'] || 'unknown';

    const skipTransform = this.reflector.getAllAndOverride<boolean>(SKIP_TRANSFORM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipTransform) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        // 响应已被 controller 手动终结（@Res({ passthrough: true }) 端点如 skill
        // format=raw 裸文本，res.send 后 writableEnded=true）→ 跳过包装返回
        // undefined：Nest 对 undefined 走 response.send()（Node end() 静默忽略），
        // 避免二次写响应抛 ERR_HTTP_HEADERS_SENT（review-0831 任务 bbd175dc 子项 3）。
        // ⚠️ 判定必须用 writableEnded 而非 headersSent（主 Agent 复核修正）：
        // SSE 流式端点（@Sse /events/stream）订阅时即 writeHead（headersSent=true）
        // 但流未终结（writableEnded=false），事件帧仍需照常流经本 map——生产帧
        // 形状 data:{"data":"..."} 依赖 Nest writeMessage 取信封 .data 序列化，
        // 按 headersSent 返回 undefined 会让 writeMessage 读 undefined.data 抛
        // TypeError 打断 SSE 流（生产 curl 实证帧形状）。
        if (response.writableEnded) return undefined;
        return {
          code: ErrorCode.SUCCESS,
          message: 'success',
          data,
          timestamp: new Date().toISOString(),
          requestId,
        };
      }),
    );
  }
}
