import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Inject } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ACCESS_QUERY_STORE, AccessQueryStore } from '../services/access-query.service';

/**
 * AccessQueryService 请求级缓存拦截器
 *
 * 在每个 HTTP 请求开始时创建独立的 AsyncLocalStorage store，使同一次请求内
 * AccessQueryService 对同一 Actor 的白名单查询只执行一次 DB 访问。
 */
@Injectable()
export class AccessQueryInterceptor implements NestInterceptor {
  constructor(@Inject(ACCESS_QUERY_STORE) private readonly store: AccessQueryStore) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // AsyncLocalStorage.run 创建的异步上下文会延续到 Observable 链中
    return this.store.run(new Map<string, Promise<string[] | null>>(), () => next.handle());
  }
}
