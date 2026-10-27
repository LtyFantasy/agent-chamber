/**
 * Usage 的**传输层出口**单测：
 * ① `Cache-Control: no-store` 中间件（所有出口的最外层，必须在管道之前写头）；
 * ② controller 把 `MemoryUsageRateLimitedException.retryAfterSeconds` 落到 `Retry-After` 头。
 */
import { MemoryUsageNoStoreMiddleware } from './memory-usage-no-store.middleware';
import { MemoryController } from './memory.controller';
import { MemoryUsageRateLimitedException } from './memory.constants';

describe('MemoryUsageNoStoreMiddleware', () => {
  it('在 next() 之前写 Cache-Control: no-store（guard/DTO/限流/引擎错误都能带上）', () => {
    const middleware = new MemoryUsageNoStoreMiddleware();
    const setHeader = jest.fn();
    const next = jest.fn();

    middleware.use({} as never, { setHeader } as never, next);

    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalledTimes(1);
    // 顺序：先写头再放行（若反过来，异常过滤器可能已经 flush）
    expect(setHeader.mock.invocationCallOrder[0]).toBeLessThan(
      next.mock.invocationCallOrder[0],
    );
  });
});

describe('MemoryController usage Retry-After', () => {
  function buildController(usageService: unknown): MemoryController {
    return new MemoryController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      usageService as never,
    );
  }

  it('429 异常 ⇒ 响应头 Retry-After = 异常携带的秒数（然后继续抛给全局过滤器）', async () => {
    const error = new MemoryUsageRateLimitedException(7, 'engine');
    const controller = buildController({
      getTrace: jest.fn().mockRejectedValue(error),
    });
    const res = { setHeader: jest.fn() };

    await expect(
      controller.getUsageTrace(
        '44444444-4444-4444-8444-444444444444',
        {} as never,
        { id: 'actor', type: 'agent' } as never,
        res as never,
      ),
    ).rejects.toBe(error);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '7');
  });

  it('非限流异常不写 Retry-After（不污染其它错误面）', async () => {
    const error = new Error('boom');
    const controller = buildController({
      getSummary: jest.fn().mockRejectedValue(error),
    });
    const res = { setHeader: jest.fn() };

    await expect(
      controller.getUsageSummary(
        '44444444-4444-4444-8444-444444444444',
        {} as never,
        { id: 'actor', type: 'agent' } as never,
        res as never,
      ),
    ).rejects.toBe(error);

    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('成功路径不写 Retry-After，原样返回 service 结果', async () => {
    const value = { engine: {}, target: {}, usageCaveat: 'x' };
    const controller = buildController({
      getSummary: jest.fn().mockResolvedValue(value),
    });
    const res = { setHeader: jest.fn() };

    await expect(
      controller.getUsageSummary(
        '44444444-4444-4444-8444-444444444444',
        {} as never,
        { id: 'actor', type: 'agent' } as never,
        res as never,
      ),
    ).resolves.toBe(value);
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
