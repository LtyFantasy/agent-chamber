/**
 * api-usage-no-store.middleware.spec.ts — 平台统计 no-store 中间件的**顺序契约**。
 *
 * 真实 HTTP 出口（200/400/401/403）在 `test/usage-stats.e2e-spec.ts` 验证；
 * 本文件只钉住「先写头，再 next()」——这是覆盖 guard/DTO/throttle 的前提：
 * 任何在 next() 之后才发生的拒绝/错误，头都已经在 response 上。
 */
import { ApiUsageNoStoreMiddleware } from './api-usage-no-store.middleware';

describe('ApiUsageNoStoreMiddleware', () => {
  it('在 next() 之前写 Cache-Control: no-store，且只写这一个头', () => {
    const middleware = new ApiUsageNoStoreMiddleware();
    const setHeader = jest.fn();
    const next = jest.fn();
    const res = { setHeader } as unknown as Parameters<typeof middleware.use>[1];

    middleware.use({} as Parameters<typeof middleware.use>[0], res, next);

    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    // 顺序：写头发生在 next 之前（否则 guard/管道错误不会带该头）
    expect(setHeader.mock.invocationCallOrder[0]).toBeLessThan(next.mock.invocationCallOrder[0]);
  });

  it('下游抛错时头仍已写入', () => {
    const middleware = new ApiUsageNoStoreMiddleware();
    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Parameters<typeof middleware.use>[1];
    expect(() =>
      middleware.use({} as Parameters<typeof middleware.use>[0], res, () => {
        throw new Error('downstream rejected');
      }),
    ).toThrow('downstream rejected');
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
