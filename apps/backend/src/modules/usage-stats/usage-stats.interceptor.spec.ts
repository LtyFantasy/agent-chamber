/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口调用频率统计的 REST 采集侧（拦截器）行为契约
 *
 * [代码职责]
 *   - 钉死 plan §4 批 1.6 清单：模板提取 / WS 跳过 / 头截断与词表化 /
 *     actor 三态推导 / fail-open / exactly-once（SSE 多帧 + 异常路径）/ 状态来源
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 统计口径专章
 *   - 依据: plan rocket-batwoman-booster-gold §2 D1/D2/D5/D6 与 §6 测试契约
 *
 * [关键不变量]
 *   - 一次请求恰好 1 行（SSE 多帧不得一帧一行）
 *   - 任何采集异常都不得让请求变 500（fail-open 必须可测）
 *   - 非法/超长 surface 不得产生新聚合键（词表化是基数护栏）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改动拦截器口径时同步改本文件的断言（测试即文档）
 * =============================================================================
 */
import { CallHandler, ExecutionContext, Logger, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { of, Subject, throwError } from 'rxjs';
import { UsageStatsBufferService, UsageStatsHttpCall } from './usage-stats-buffer.service';
import { UsageStatsInterceptor, USAGE_UNKNOWN_ROUTE } from './usage-stats.interceptor';
import { SkipUsageStats } from './skip-usage-stats.decorator';
import { USAGE_TOOL_NAME_MAX_LENGTH } from './usage-stats.constants';

/** 测试用请求形状（只含拦截器真正读取的字段） */
interface FakeRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  agent?: { id: string } | null;
  user?: { userId: string } | null;
}

const baseRequest = (overrides: Partial<FakeRequest> = {}): FakeRequest => ({
  method: 'GET',
  headers: {},
  route: { path: '/api/v1/topics/:id' },
  ...overrides,
});

/**
 * 造 ExecutionContext：`statusCode` 用于验证"状态取自 res.statusCode"
 * （Nest 在拦截器链之前已 setStatus，见 router-execution-context.js:43）。
 */
const makeContext = (
  request: unknown,
  options: {
    type?: string;
    handler?: (...args: never[]) => unknown;
    controller?: new (...args: never[]) => unknown;
    statusCode?: number;
  } = {},
): ExecutionContext => {
  const response = { statusCode: options.statusCode ?? 200 };
  return {
    getType: () => options.type ?? 'http',
    getHandler: () => options.handler ?? ((): void => undefined),
    getClass: () => options.controller ?? class {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
};

/** 造 CallHandler：默认单值 observable（普通 JSON 端点形态） */
const makeNext = (observable: unknown = of('payload')): CallHandler =>
  ({ handle: () => observable }) as unknown as CallHandler;

/** 被 @SkipUsageStats 标记的控制器（真实装饰器 + 真实 Reflector，非 mock 元数据） */
class SkippedController {
  @SkipUsageStats()
  handle(): void {
    /* 仅用于提供带元数据的 handler */
  }
}

describe('UsageStatsInterceptor', () => {
  let recordHttpCall: jest.Mock;
  let buffer: UsageStatsBufferService;
  let interceptor: UsageStatsInterceptor;

  beforeEach(() => {
    recordHttpCall = jest.fn();
    buffer = { recordHttpCall } as unknown as UsageStatsBufferService;
    interceptor = new UsageStatsInterceptor(new Reflector(), buffer);
    // Logger 噪音抑制（本文件含 fail-open 路径的真实 buffer 实例）
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 订阅并等待完成（Nest 由框架订阅；单测需自己驱动 observable） */
  const run = async (
    context: ExecutionContext,
    next: CallHandler = makeNext(),
  ): Promise<{ value?: unknown; error?: unknown }> => {
    return new Promise((resolve) => {
      let value: unknown;
      interceptor.intercept(context, next).subscribe({
        next: (v) => {
          value = v;
        },
        error: (error: unknown) => resolve({ error }),
        complete: () => resolve({ value }),
      });
    });
  };

  const recordedCall = (index = 0): UsageStatsHttpCall =>
    recordHttpCall.mock.calls[index][0] as UsageStatsHttpCall;

  describe('维度采集', () => {
    it('route 取 req.route.path 路由模板（含 /api/v1 前缀与 :param）', async () => {
      await run(makeContext(baseRequest({ route: { path: '/api/v1/tasks/:id/comments' } })));
      expect(recordedCall().route).toBe('/api/v1/tasks/:id/comments');
      expect(recordedCall().channel).toBe('rest');
      expect(recordedCall().method).toBe('GET');
    });

    it('route 缺失时归 unknown（兜底，禁止落真实 path）', async () => {
      await run(makeContext(baseRequest({ route: undefined })));
      expect(recordedCall().route).toBe(USAGE_UNKNOWN_ROUTE);
    });

    it('bucket_start 归 UTC 整点（分秒毫秒归零）', async () => {
      await run(makeContext(baseRequest()));
      const bucket = recordedCall().bucketStart;
      expect(bucket.getUTCMinutes()).toBe(0);
      expect(bucket.getUTCSeconds()).toBe(0);
      expect(bucket.getUTCMilliseconds()).toBe(0);
    });

    it('状态取 res.statusCode（Nest 已在拦截器链前 setStatus）', async () => {
      await run(makeContext(baseRequest(), { statusCode: 302 }));
      expect(recordedCall().statusClass).toBe('3xx');
    });

    it('latency 为非负数值（handler 阶段耗时）', async () => {
      await run(makeContext(baseRequest()));
      expect(recordedCall().latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('actor 三态推导（D7，禁止 agent.type）', () => {
    it('request.agent 存在 → agent（agent 对象无 type 字段也能正确推导）', async () => {
      await run(makeContext(baseRequest({ agent: { id: 'agent-1' } })));
      expect(recordedCall().actorId).toBe('agent-1');
      expect(recordedCall().actorType).toBe('agent');
    });

    it('request.user 存在 → human 且 id 取 userId（不是 id）', async () => {
      await run(makeContext(baseRequest({ user: { userId: 'user-1' } })));
      expect(recordedCall().actorId).toBe('user-1');
      expect(recordedCall().actorType).toBe('human');
    });

    it('两者都没有 → anonymous / actorId null（公开路由上通过认证链的空身份）', async () => {
      await run(makeContext(baseRequest()));
      expect(recordedCall().actorId).toBeNull();
      expect(recordedCall().actorType).toBe('anonymous');
    });

    it('两者都有时 agent 优先（guard 双身份语义）', async () => {
      await run(makeContext(baseRequest({ agent: { id: 'agent-1' }, user: { userId: 'user-1' } })));
      expect(recordedCall().actorId).toBe('agent-1');
      expect(recordedCall().actorType).toBe('agent');
    });
  });

  describe('MCP 头解析（D5：截断 + 封闭词表）', () => {
    it('头缺失 → tool_name ""、mcp_surface ""（非 MCP 流量，注意不是 unknown）', async () => {
      await run(makeContext(baseRequest()));
      expect(recordedCall().toolName).toBe('');
      expect(recordedCall().mcpSurface).toBe('');
    });

    it('合法头原样采用', async () => {
      await run(
        makeContext(
          baseRequest({
            headers: { 'x-mcp-tool': 'topic.create', 'x-mcp-surface': 'mcp-full' },
          }),
        ),
      );
      expect(recordedCall().toolName).toBe('topic.create');
      expect(recordedCall().mcpSurface).toBe('mcp-full');
    });

    it('超长 tool_name 截断到 128', async () => {
      await run(makeContext(baseRequest({ headers: { 'x-mcp-tool': 'a'.repeat(300) } })));
      expect(recordedCall().toolName).toHaveLength(USAGE_TOOL_NAME_MAX_LENGTH);
    });

    it('非法/超长 surface 归 unknown', async () => {
      await run(makeContext(baseRequest({ headers: { 'x-mcp-surface': 'Platform Full' } })));
      expect(recordedCall().mcpSurface).toBe('unknown');

      recordHttpCall.mockClear();
      await run(makeContext(baseRequest({ headers: { 'x-mcp-surface': 'x'.repeat(64) } })));
      expect(recordedCall().mcpSurface).toBe('unknown');
    });

    it('同名头重复出现（Node 合成数组）取首个', async () => {
      await run(
        makeContext(baseRequest({ headers: { 'x-mcp-tool': ['first.tool', 'second.tool'] } })),
      );
      expect(recordedCall().toolName).toBe('first.tool');
    });
  });

  describe('exactly-once', () => {
    it('单值响应：next + finalize 各触发一次，只记 1 行', async () => {
      await run(makeContext(baseRequest()));
      expect(recordHttpCall).toHaveBeenCalledTimes(1);
    });

    it('SSE 多帧：每帧 next、只 1 次 finalize → 恰好 1 行', async () => {
      const stream = new Subject<string>();
      const finished = new Promise<void>((resolve) => {
        interceptor.intercept(makeContext(baseRequest()), makeNext(stream)).subscribe({
          complete: () => resolve(),
        });
      });

      stream.next('frame-1');
      stream.next('frame-2');
      stream.next('frame-3');
      expect(recordHttpCall).toHaveBeenCalledTimes(0); // 帧不入库（否则一帧一行）

      stream.complete();
      await finished;
      expect(recordHttpCall).toHaveBeenCalledTimes(1);
      expect(recordedCall().statusClass).toBe('2xx');
    });

    it('流异常终止：多帧 next 后 error → 仍恰好 1 行（error 与 finalize 双触发不重复）', async () => {
      const stream = new Subject<string>();
      const finished = new Promise<void>((resolve) => {
        interceptor
          .intercept(makeContext(baseRequest()), makeNext(stream))
          .subscribe({ error: () => resolve() });
      });

      stream.next('frame-1');
      stream.error(new NotFoundException('stream broke'));
      await finished;

      expect(recordHttpCall).toHaveBeenCalledTimes(1);
      expect(recordedCall().statusClass).toBe('4xx');
    });
  });

  describe('error 分支状态来源（err.status || 500）', () => {
    it('HttpException → 其 status 对应的类', async () => {
      await run(
        makeContext(baseRequest()),
        makeNext(throwError(() => new NotFoundException('nope'))),
      );
      expect(recordHttpCall).toHaveBeenCalledTimes(1);
      expect(recordedCall().statusClass).toBe('4xx');
    });

    it('普通 Error（无 status）→ 5xx', async () => {
      await run(makeContext(baseRequest()), makeNext(throwError(() => new Error('boom'))));
      expect(recordedCall().statusClass).toBe('5xx');
    });

    it('status 为 5xx 时按 5xx 记（DTO 400 由 pipes 在链内侧抛出，同样走此分支）', async () => {
      const error = Object.assign(new Error('bad gateway'), { status: 503 });
      await run(makeContext(baseRequest()), makeNext(throwError(() => error)));
      expect(recordedCall().statusClass).toBe('5xx');
    });

    it('异常时 res.statusCode 仍是默认 200——证明状态必须取自 err 而非 response', async () => {
      await run(
        makeContext(baseRequest(), { statusCode: 200 }),
        makeNext(throwError(() => new NotFoundException('nope'))),
      );
      expect(recordedCall().statusClass).toBe('4xx');
    });
  });

  describe('跳过与 fail-open', () => {
    it('WS context 直接放行且不计数', async () => {
      const result = await run(makeContext(baseRequest(), { type: 'ws' }));
      expect(result.value).toBe('payload');
      expect(recordHttpCall).not.toHaveBeenCalled();
    });

    it('@SkipUsageStats 标记的 handler 跳过自统计', async () => {
      await run(
        makeContext(baseRequest(), {
          handler: SkippedController.prototype.handle,
        }),
      );
      expect(recordHttpCall).not.toHaveBeenCalled();
    });

    it('@SkipUsageStats 标记在类级同样生效（getAllAndOverride）', async () => {
      class SkippedClassController {
        handle(): void {
          /* 类级标记 */
        }
      }
      SkipUsageStats()(SkippedClassController);
      await run(
        makeContext(baseRequest(), {
          handler: SkippedClassController.prototype.handle,
          controller: SkippedClassController,
        }),
      );
      expect(recordHttpCall).not.toHaveBeenCalled();
    });

    it('维度推导抛异常（headers 取值器爆炸）→ 请求照常返回，不计数、不抛', async () => {
      const exploding = {
        method: 'GET',
        get headers(): Record<string, string> {
          throw new Error('headers exploded');
        },
        route: { path: '/api/v1/topics/:id' },
      };
      const result = await run(makeContext(exploding));
      expect(result.error).toBeUndefined();
      expect(result.value).toBe('payload');
      expect(recordHttpCall).not.toHaveBeenCalled();
    });

    it('入库回调抛异常 → 请求照常返回（统计是旁路，不得反噬业务）', async () => {
      recordHttpCall.mockImplementation(() => {
        throw new Error('buffer exploded');
      });
      const result = await run(makeContext(baseRequest()));
      expect(result.error).toBeUndefined();
      expect(result.value).toBe('payload');
      expect(recordHttpCall).toHaveBeenCalledTimes(1);
    });

    it('handler 抛出的异常原样透传（拦截器不吞业务异常）', async () => {
      const result = await run(
        makeContext(baseRequest()),
        makeNext(throwError(() => new NotFoundException('route missing'))),
      );
      expect(result.error).toBeInstanceOf(NotFoundException);
    });
  });

  describe('词表化护栏（非法 surface 不产生新聚合键）', () => {
    let realBuffer: UsageStatsBufferService;

    beforeEach(() => {
      const dataSource = { query: jest.fn().mockResolvedValue([]) } as unknown as DataSource;
      realBuffer = new UsageStatsBufferService(dataSource);
    });

    afterEach(() => {
      realBuffer.onModuleDestroy();
    });

    it('两种不同非法 surface 归并到同一个聚合键（否则基数会被伪造头撑爆）', async () => {
      const real = new UsageStatsInterceptor(new Reflector(), realBuffer);
      const drive = (surface: string): Promise<void> =>
        new Promise((resolve) => {
          real
            .intercept(
              makeContext(baseRequest({ headers: { 'x-mcp-surface': surface } })),
              makeNext(),
            )
            .subscribe({ complete: () => resolve() });
        });

      await drive('Platform Full');
      await drive('x'.repeat(200));
      expect(realBuffer.bufferedKeyCount).toBe(1);
    });

    it('两个不同超长 tool_name 截断到同一键', async () => {
      const real = new UsageStatsInterceptor(new Reflector(), realBuffer);
      const long = (suffix: string): string => `${'a'.repeat(200)}${suffix}`;
      const drive = (tool: string): Promise<void> =>
        new Promise((resolve) => {
          real
            .intercept(makeContext(baseRequest({ headers: { 'x-mcp-tool': tool } })), makeNext())
            .subscribe({ complete: () => resolve() });
        });

      await drive(long('1'));
      await drive(long('2'));
      expect(realBuffer.bufferedKeyCount).toBe(1);
    });
  });
});
