/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md（统一响应信封契约）
 *   - 补充: review-0831 任务 bbd175dc 子项 3（skill.controller 手工信封收敛 +
 *     headersSent 跳过包装分支）
 *
 * [踩坑索引]
 *   - writableEnded-skip-v1.57：@Res({ passthrough: true }) 端点（skill format=raw
 *     裸文本等）手动 res.send 后，拦截器若仍包装返回值，Nest 会二次写响应抛
 *     ERR_HTTP_HEADERS_SENT——拦截器对 writableEnded 请求返回 undefined（Nest 走
 *     response.send()，Node end() 静默忽略）。
 *   - 判定必须用 writableEnded 而非 headersSent：SSE 流式端点（@Sse）订阅时即
 *     writeHead（headersSent=true）但流未终结，事件帧仍需流经 map 包装（生产帧
 *     data:{"data":"..."} 依赖 writeMessage 取信封 .data）；按 headersSent 跳过
 *     会让 writeMessage 读 undefined.data 抛 TypeError 打断 SSE 流。
 *
 * [铁律关联] #17(测试契约) #11(注释强制)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';
import { SKIP_TRANSFORM_KEY } from '../decorators/skip-transform.decorator';

describe('ResponseInterceptor', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  } as any;

  const makeContext = (
    requestId: string | undefined,
    writableEnded: boolean,
    headersSent = false,
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ requestId }),
        getResponse: () => ({ writableEnded, headersSent }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  const makeNext = (data: unknown): CallHandler => ({
    handle: () => of(data),
  });

  beforeEach(() => {
    reflector.getAllAndOverride.mockReturnValue(false);
  });

  it('正常路径：包装为统一信封 { code, message, data, timestamp, requestId }', async () => {
    const interceptor = new ResponseInterceptor(reflector);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext('req-1', false), makeNext({ hello: 'world' })),
    );

    expect(result).toEqual({
      code: 200,
      message: 'success',
      data: { hello: 'world' },
      timestamp: expect.any(String),
      requestId: 'req-1',
    });
  });

  it('requestId 缺失 → 兜底 unknown（与手工信封旧行为一致）', async () => {
    const interceptor = new ResponseInterceptor(reflector);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext(undefined, false), makeNext({})),
    );

    expect(result).toMatchObject({ requestId: 'unknown' });
  });

  it('writableEnded=true（@Res({ passthrough: true }) 端点已手动终结响应）→ 跳过包装返回 undefined', async () => {
    const interceptor = new ResponseInterceptor(reflector);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext('req-1', true, true), makeNext({ hello: 'world' })),
    );

    expect(result).toBeUndefined();
  });

  it('SSE 帧路径：headersSent=true 但 writableEnded=false（流未终结）→ 仍照常包装（防 SSE 流回归）', async () => {
    const interceptor = new ResponseInterceptor(reflector);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext('req-1', false, true), makeNext({ hello: 'world' })),
    );

    expect(result).toMatchObject({ code: 200, data: { hello: 'world' } });
  });

  it('@SkipTransform 标记 → 原样透传不包装', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const interceptor = new ResponseInterceptor(reflector);
    const result = await lastValueFrom(
      interceptor.intercept(makeContext('req-1', false), makeNext({ raw: true })),
    );

    expect(result).toEqual({ raw: true });
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(SKIP_TRANSFORM_KEY, [
      expect.anything(),
      expect.anything(),
    ]);
  });
});
