/**
 * request-id（middleware + `@RequestId()`）单测。
 *
 * 设计意图：`x-request-id` 是**调用方可控输入**，而它会被写进应用日志、响应头与
 * `experience_judgments.request.traceId`。故这里钉死两件事：
 * ① 采信前必须过白名单（换行/超长/怪字符一律不采信 ⇒ 改生成）——否则外部可伪造日志行；
 * ② 四者同源（req.requestId / 响应头 / 装饰器读的是**同一个值**，不在别处再生成一份）。
 */
import { RequestIdMiddleware, REQUEST_ID_PATTERN } from './request-id.middleware';
import { RequestId, readRequestId } from '../decorators/request-id.decorator';

/** 造最小 req/res 桩 */
function run(header: string | string[] | undefined): { reqId: string; headerSent: unknown } {
  const req = { headers: header === undefined ? {} : { 'x-request-id': header } } as never;
  const res = { setHeader: jest.fn() } as never;
  new RequestIdMiddleware().use(req, res, () => undefined);
  return {
    reqId: (req as { requestId: string }).requestId,
    headerSent: (res as unknown as { setHeader: jest.Mock }).setHeader.mock.calls[0],
  };
}

describe('RequestIdMiddleware（采信前归一化）', () => {
  it('合法 id 原样采信，且**响应头与 req 同值**（四者同源）', () => {
    const { reqId, headerSent } = run('req_abcdef0123456789');
    expect(reqId).toBe('req_abcdef0123456789');
    expect(headerSent).toEqual(['X-Request-Id', 'req_abcdef0123456789']);
  });

  it('uuid / 网关 `trace:span` 形态放行（白名单覆盖真实 id 生态）', () => {
    for (const value of ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'trace:span-7', 'a.b_c:d-e']) {
      expect(run(value).reqId).toBe(value);
    }
  });

  it('**换行 / 空白 / 怪字符 / 超长一律不采信**（改生成 `req_` 前缀 id）——防伪造日志行', () => {
    const hostile = [
      'abc\nfatal injected line', // 换行：可伪造第二条日志行
      'has space',
      '中文-id',
      'id;rm -rf',
      'a'.repeat(65), // 超长
      '',
      '   ',
    ];
    for (const value of hostile) {
      const { reqId } = run(value);
      expect(reqId).not.toBe(value);
      expect(reqId).toMatch(/^req_[0-9a-f]{16}$/);
      expect(REQUEST_ID_PATTERN.test(reqId)).toBe(true);
    }
  });

  it('重复头（数组）取第一个；其非法时改生成', () => {
    expect(run(['req_first', 'req_second']).reqId).toBe('req_first');
    expect(run(['bad id', 'req_second']).reqId).toMatch(/^req_[0-9a-f]{16}$/);
  });

  it('缺头 ⇒ 生成 id（不拒绝请求：id 是观测设施，不该成为拒绝面）', () => {
    expect(run(undefined).reqId).toMatch(/^req_[0-9a-f]{16}$/);
  });
});

describe('@RequestId() / readRequestId', () => {
  it('读 middleware 写入的值；缺失/非字符串 ⇒ null（**不生成**：否则四者同源破功）', () => {
    expect(readRequestId({ requestId: 'req_x' })).toBe('req_x');
    expect(readRequestId({})).toBeNull();
    expect(readRequestId({ requestId: '' })).toBeNull();
    expect(readRequestId({ requestId: 42 })).toBeNull();
    expect(readRequestId(null)).toBeNull();
    expect(readRequestId(undefined)).toBeNull();
  });

  it('装饰器已定义（参数装饰器工厂返回函数，供控制器参数位置使用）', () => {
    expect(typeof RequestId).toBe('function');
  });
});
