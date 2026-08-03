import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method;
    const url = request.url;
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
