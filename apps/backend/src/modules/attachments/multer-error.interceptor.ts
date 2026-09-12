/**
 * multer limits 错误 → 业务错误码映射（attachments 上传端点专用）
 *
 * 背景：@nestjs/platform-express transformException 把 multer LIMIT_FILE_SIZE
 * 转成 PayloadTooLargeException(413)，但 AllExceptionsFilter 的 HTTP status→code
 * 映射表没有 413 case——裸抛会落为 code=500 INTERNAL_ERROR（错误码说谎：
 * "你的文件太大"被伪报成"服务器挂了"，调用方重试风暴随之而来）。
 *
 * 本拦截器挂 FileInterceptor 外层（@UseInterceptors 声明序 = 执行序），
 * 把 413 统一改写为 12001 ATTACHMENT_TOO_LARGE；其余错误（LIMIT_FILE_COUNT/
 * LIMIT_PART_COUNT 等 400 系）原样透传——filter 的 400 映射（BAD_REQUEST）已正确。
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { ErrorCode } from '@agent-chamber/shared';
import { ATTACHMENT_MAX_BYTES } from './attachment.constants';

@Injectable()
export class MulterLimitErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (err instanceof PayloadTooLargeException) {
          return throwError(
            () =>
              new PayloadTooLargeException({
                message: `File exceeds max size of ${ATTACHMENT_MAX_BYTES} bytes`,
                code: ErrorCode.ATTACHMENT_TOO_LARGE,
              }),
          );
        }
        return throwError(() => err);
      }),
    );
  }
}
