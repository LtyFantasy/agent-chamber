/**
 * LoggingInterceptor 单测（P2 批 2 / plan §②.7）。
 *
 * 要证明的事：日志行的 URL 经过 redactUrl 脱敏——签名 URL 的 `?token=` 是能力凭证，
 * 明文进日志等于把凭证写进可被运维/第三方读到的日志面（且公开端点每次抓取一行）。
 * 成功与错误两条 tap 分支都必须用脱敏后的 URL（漏一条就等于没做）。
 */
import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

describe('LoggingInterceptor', () => {
  const makeContext = (url: string, statusCode = 200): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url, requestId: 'req-1' }),
        getResponse: () => ({ statusCode }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  const makeNext = (data: unknown): CallHandler => ({ handle: () => of(data) });

  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('成功路径：日志行 URL 的 token 值被脱敏', async () => {
    const interceptor = new LoggingInterceptor();
    await lastValueFrom(
      interceptor.intercept(
        makeContext('/api/v1/public/attachments/abc/content?token=eyJhbGciOi.abc.def'),
        makeNext({}),
      ),
    );

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain('GET /api/v1/public/attachments/abc/content?token=[redacted] 200 +');
    expect(line).not.toContain('eyJhbGciOi');
  });

  it('错误路径：error 日志同样脱敏（含数组形态 ?token=a&token=b）', async () => {
    const interceptor = new LoggingInterceptor();
    await expect(
      lastValueFrom(
        interceptor.intercept(
          makeContext('/api/v1/public/attachments/abc/content?token=a&token=b', 401),
          { handle: () => throwError(() => Object.assign(new Error('nope'), { status: 401 })) },
        ),
      ),
    ).rejects.toThrow('nope');

    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain(
      'GET /api/v1/public/attachments/abc/content?token=[redacted]&token=[redacted] 401 +',
    );
    expect(line).not.toContain('token=a');
  });

  it('无敏感 query 的请求：URL 原样（脱敏不改变常规日志可读性）', async () => {
    const interceptor = new LoggingInterceptor();
    await lastValueFrom(
      interceptor.intercept(makeContext('/api/v1/attachments/mine?page=1'), makeNext({})),
    );

    expect(logSpy.mock.calls[0][0]).toContain('GET /api/v1/attachments/mine?page=1 200');
  });
});
