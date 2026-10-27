/**
 * error-message.test.ts — 错误 → 文案的**通道分级判定矩阵**（卡 240c74d6）。
 *
 * 为什么值得单独一份 spec：这里是「什么错误能原样上屏」的唯一裁决点，判错的两个方向
 * 都是事故——放宽（把 5xx/断网也透传）⇒ axios 英文原文与服务器内部措辞进用户界面；
 * 收紧（把 4xx 业务原因也吞掉）⇒ 用户看不到"为什么失败"（如 409 的修复指引）。
 *
 * 判定矩阵覆盖：4xx±业务码 / 5xx / 无 response（断网）/ 非 Error 抛出物 / message 形态
 * （非字符串、空、多行、超长）/ axios 自有字符串 code 的假阳性（'ERR_NETWORK'）。
 */

import { errorMessageOf, httpStatusOf, businessErrorCode, loginErrorKeyOf } from './error-message';

const FALLBACK = 'fallback copy';

/**
 * 造一个 axios 风格错误。
 * `status === null` = 无 response（断网/超时/取消），此时只有 axios 自己的 `message`。
 */
function axiosError(options: {
  status?: number | null;
  body?: unknown;
  message?: string;
  code?: unknown;
}): unknown {
  const { status = 400, body, message = 'Request failed with status code 400', code } = options;
  const error: Record<string, unknown> = { message };
  if (code !== undefined) error.code = code;
  if (status !== null) error.response = { status, data: body };
  return error;
}

describe('httpStatusOf / businessErrorCode（读数，不产文案）', () => {
  it('读得到 status 与数字业务码', () => {
    const err = axiosError({ status: 409, body: { code: 9001, message: 'conflict' } });
    expect(httpStatusOf(err)).toBe(409);
    expect(businessErrorCode(err)).toBe(9001);
  });

  it('无 response（断网）→ status null；axios 自有字符串 code 不算业务码', () => {
    const err = axiosError({ status: null, message: 'Network Error', code: 'ERR_NETWORK' });
    expect(httpStatusOf(err)).toBeNull();
    // 关键假阳性闸：'ERR_NETWORK' 是字符串，绝不能被当成"服务端答了业务错"
    expect(businessErrorCode(err)).toBeNull();
  });

  it('非对象抛出物（null / undefined / string）一律收敛为 null，不抛异常', () => {
    for (const thrown of [null, undefined, 'boom', 42]) {
      expect(httpStatusOf(thrown)).toBeNull();
      expect(businessErrorCode(thrown)).toBeNull();
    }
  });
});

describe('errorMessageOf 通道分级', () => {
  it('4xx + 数字业务码 ⇒ 透传服务端 message（用户需要知道"为什么失败"）', () => {
    const err = axiosError({ status: 409, body: { code: 9002, message: 'slug already taken' } });
    expect(errorMessageOf(err, FALLBACK)).toBe('slug already taken');
  });

  it('4xx 但响应体无业务码 ⇒ 兜底（无法区分业务原因与网关/代理措辞）', () => {
    const err = axiosError({ status: 400, body: { message: 'Bad Request' } });
    expect(errorMessageOf(err, FALLBACK)).toBe(FALLBACK);
  });

  it('4xx 但 code 不是数字 ⇒ 兜底', () => {
    const err = axiosError({ status: 403, body: { code: 'FORBIDDEN', message: 'nope' } });
    expect(errorMessageOf(err, FALLBACK)).toBe(FALLBACK);
  });

  it('5xx ⇒ 兜底，**即使**带业务码与服务端 message（服务器内部措辞不上屏）', () => {
    const err = axiosError({
      status: 500,
      body: { code: 500, message: 'QueryFailedError: relation "x" does not exist' },
    });
    expect(errorMessageOf(err, FALLBACK)).toBe(FALLBACK);
  });

  it('无 response（断网/超时）⇒ 兜底，不透传 axios 英文原文', () => {
    const err = axiosError({ status: null, message: 'Network Error', code: 'ERR_NETWORK' });
    const out = errorMessageOf(err, FALLBACK);
    expect(out).toBe(FALLBACK);
    expect(out).not.toContain('Network Error');
  });

  it('plain Error（无 response）⇒ 兜底', () => {
    expect(errorMessageOf(new Error('something blew up'), FALLBACK)).toBe(FALLBACK);
  });

  it('非 Error 抛出物 ⇒ 兜底', () => {
    for (const thrown of [null, undefined, 'boom', { foo: 1 }]) {
      expect(errorMessageOf(thrown, FALLBACK)).toBe(FALLBACK);
    }
  });

  it('message 非字符串 / 空串 / 纯空白 ⇒ 兜底（不给用户看 undefined）', () => {
    for (const message of [{ nested: true }, 42, null, '', '   \n  ']) {
      const err = axiosError({ status: 404, body: { code: 10001, message } });
      expect(errorMessageOf(err, FALLBACK)).toBe(FALLBACK);
    }
  });

  it('多行 message ⇒ 折叠成单行（toast/AlertDialog 是单行布局）', () => {
    const err = axiosError({
      status: 422,
      body: { code: 10010, message: 'line one\n\n\tline two   spaced' },
    });
    expect(errorMessageOf(err, FALLBACK)).toBe('line one line two spaced');
  });

  it('超长 message ⇒ 截断到 300 字符', () => {
    const err = axiosError({ status: 422, body: { code: 10010, message: 'x'.repeat(500) } });
    const out = errorMessageOf(err, FALLBACK);
    expect(out).toHaveLength(300);
  });
});

describe('loginErrorKeyOf 登录失败映射（code → i18n key 单源）', () => {
  it('401 + 1008（TOKEN_INVALID）⇒ 邮箱或密码错误', () => {
    // 1008 是线值（auth.service.ts 抛 ErrorCode.TOKEN_INVALID）；用字面量而非枚举，
    // 是为了让"改动共享枚举"这件事必须同时改到这里——否则本用例会静默跟着漂。
    const err = axiosError({ status: 401, body: { code: 1008, message: 'Invalid credentials' } });
    expect(loginErrorKeyOf(err)).toBe('loginErrorInvalidCredentials');
  });

  it('401 + 1001（AGENT_DISABLED）⇒ 账号已停用', () => {
    const err = axiosError({ status: 401, body: { code: 1001, message: 'Account is disabled' } });
    expect(loginErrorKeyOf(err)).toBe('loginErrorAccountDisabled');
  });

  it('429（限流）⇒ 过于频繁；带不带业务码都认', () => {
    expect(loginErrorKeyOf(axiosError({ status: 429, body: { code: 429 } }))).toBe(
      'loginErrorRateLimited',
    );
    // 代理层自造的 429（没有本仓信封）同样要能落进"限流"文案，而不是通用失败
    expect(
      loginErrorKeyOf(axiosError({ status: 429, body: { message: 'Too Many Requests' } })),
    ).toBe('loginErrorRateLimited');
  });

  it('其余情形（500 / 断网 / 401 无码 / plain Error）⇒ 通用失败文案', () => {
    expect(loginErrorKeyOf(axiosError({ status: 500, body: { code: 500 } }))).toBe('loginFailed');
    expect(loginErrorKeyOf(axiosError({ status: null, message: 'Network Error' }))).toBe(
      'loginFailed',
    );
    expect(loginErrorKeyOf(axiosError({ status: 401, body: {} }))).toBe('loginFailed');
    expect(loginErrorKeyOf(new Error('Invalid credentials'))).toBe('loginFailed');
  });
});
