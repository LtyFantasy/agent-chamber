/**
 * login-redirect.test.ts — 登录回跳 helper 契约测试
 *
 * 覆盖两块：
 * ① `resolveSafeNext` 的**同源白名单边界矩阵**（合法路径 / 空 / 缺失 / 协议相对 /
 *    反斜杠变体 / 控制字符变体 / 绝对与伪协议 URL / 编码形态）——这是安全边界；
 * ② `buildLoginRedirect` 的组装与「已在登录页不自指」规则，含与 resolveSafeNext 的
 *    往返一致性（发送侧编码 → 消费侧解析必须回到原地址）。
 */

import { buildLoginRedirect, resolveSafeNext, LOGIN_PATH } from './login-redirect';

describe('resolveSafeNext（同源白名单）', () => {
  describe('放行：站点相对路径原值返回（深链逐字不变）', () => {
    it.each([
      ['/', '/'],
      [
        '/tasks/0b7c1f2e-0000-4000-8000-000000000001',
        '/tasks/0b7c1f2e-0000-4000-8000-000000000001',
      ],
      ['/tasks/abc?tab=desc&page=2', '/tasks/abc?tab=desc&page=2'],
      ['/topics/xyz#msg-42', '/topics/xyz#msg-42'],
      ['/docs/spaces/1?doc=2', '/docs/spaces/1?doc=2'],
      // 百分号编码的 `//`（%2f%2f）不是协议相对——解析器不会把路径里的 %2f 解码成 /
      ['/%2f%2fevil.com', '/%2f%2fevil.com'],
      ['/路径/中文?q=值', '/路径/中文?q=值'],
    ])('%p → %p', (input, expected) => {
      expect(resolveSafeNext(input)).toBe(expected);
    });
  });

  describe('回退：空值 / 缺失 → 首页', () => {
    it.each([
      ['null', null],
      ['空串', ''],
    ])('%s → /', (_label, input) => {
      expect(resolveSafeNext(input)).toBe('/');
    });
  });

  describe('回退：协议相对与绝对 URL → 首页（开放重定向防线）', () => {
    it.each([
      ['//evil.com'],
      ['///evil.com'],
      ['//evil.com/tasks/1'],
      ['https://evil.com'],
      ['http://evil.com/tasks/1'],
      ['javascript:alert(1)'],
      ['data:text/html,<script>alert(1)</script>'],
      ['mailto:a@b.com'],
      ['\\/evil.com'],
    ])('%p → /', (input) => {
      expect(resolveSafeNext(input)).toBe('/');
    });
  });

  // 这一组是 plan §8 S5 原始正则 `/^\/(?!\/)/` 的**漏网实测反例**：URL 解析器对
  // special scheme 会把反斜杠归一化成 `/`，并在解析前剥离 TAB/LF/CR——二者都能通过
  // 那条正则，却被浏览器解析成 https://evil.com/。同源断言（第二层）必须拦住它们。
  describe('回退：正则漏网的反斜杠 / 控制字符变体 → 首页', () => {
    it.each([
      ['单个反斜杠', '/\\evil.com'], // 字面反斜杠：/\evil.com
      ['反斜杠 + 斜杠', '/\\/evil.com'], // 字面：/\/evil.com
      ['反斜杠 t（非转义）', '/\\t/evil.com'], // 字面：/\t/evil.com
      ['反斜杠 u0009（非转义）', '/\\u0009/evil.com'], // 字面：/\u0009/evil.com
      ['真实 TAB', '/\t/evil.com'],
      ['真实 LF', '/\n/evil.com'],
      ['真实 CRLF', '/\r\n/evil.com'],
    ])('%s → /', (_label, input) => {
      expect(resolveSafeNext(input)).toBe('/');
    });
  });

  it('证明单靠 plan 正则会被放行（正是同源断言这一层存在的理由）', () => {
    const PLAN_PATTERN = /^\/(?!\/)/;
    for (const input of ['/\\evil.com', '/\t/evil.com', '/\n/evil.com', '/\r\n/evil.com']) {
      // ① plan 正则放行
      expect(PLAN_PATTERN.test(input)).toBe(true);
      // ② 浏览器/解析器却算到别的 origin 上
      expect(new URL(input, 'https://platform.example.com').origin).not.toBe(
        'https://platform.example.com',
      );
      // ③ 本 helper 拦住
      expect(resolveSafeNext(input)).toBe('/');
    }
  });

  it('前导空白不再被当作合法路径（解析器会 trim，这里保守拒绝）', () => {
    expect(resolveSafeNext(' /tasks/1')).toBe('/');
  });

  describe('回退：自指（登录页本身）→ 首页', () => {
    it('next 恰为 /login：回退 /（登录成功后不绕回登录表单）', () => {
      expect(resolveSafeNext(LOGIN_PATH)).toBe('/');
    });

    it('按精确等于判定：/login?x=1 不在自指判定内（刻意收窄的范围，见函数 JSDoc）', () => {
      expect(resolveSafeNext('/login?x=1')).toBe('/login?x=1');
    });
  });
});

describe('buildLoginRedirect（发送侧组装）', () => {
  it('pathname + search 编码进 next（search 的前导 ? 一并编码）', () => {
    expect(buildLoginRedirect('/tasks/abc', '?tab=desc&page=2')).toBe(
      `${LOGIN_PATH}?next=${encodeURIComponent('/tasks/abc?tab=desc&page=2')}`,
    );
  });

  it('无 query 时只编码 pathname', () => {
    expect(buildLoginRedirect('/topics/xyz')).toBe(`${LOGIN_PATH}?next=%2Ftopics%2Fxyz`);
  });

  it('根路径生成 next=%2F（登录后回首页，与缺省一致）', () => {
    expect(buildLoginRedirect('/', '')).toBe(`${LOGIN_PATH}?next=%2F`);
  });

  it('hash 一并编码（与消费侧放行的 #anchor 对称，往返不漂）', () => {
    expect(buildLoginRedirect('/tasks/abc', '?tab=desc', '#comment-2')).toBe(
      `${LOGIN_PATH}?next=${encodeURIComponent('/tasks/abc?tab=desc#comment-2')}`,
    );
    expect(buildLoginRedirect('/topics/xyz', '', '#msg-42')).toBe(
      `${LOGIN_PATH}?next=${encodeURIComponent('/topics/xyz#msg-42')}`,
    );
  });

  it('已在登录页：不填 next（发送侧自指防护：AuthGuard 一类在 /login 上仍触发跳转的兜底；401 链路由 api.ts 更上层短路）', () => {
    expect(buildLoginRedirect('/login', '?a=1', '#x')).toBe(LOGIN_PATH);
  });

  it('pathname 缺失：退化为 /login', () => {
    expect(buildLoginRedirect('')).toBe(LOGIN_PATH);
  });
});

describe('发送侧 / 消费侧往返一致（编码 → 解析回到原地址）', () => {
  it.each([
    ['/tasks/abc', '?tab=desc&page=2', '/tasks/abc?tab=desc&page=2'],
    ['/topics/xyz', '', '/topics/xyz'],
    ['/docs/spaces/1', '?doc=2&q=%E4%B8%AD%E6%96%87', '/docs/spaces/1?doc=2&q=%E4%B8%AD%E6%96%87'],
    ['/', '', '/'],
  ])('往返不变：%s%s', (pathname, search, expected) => {
    const url = buildLoginRedirect(pathname, search);
    // 真实链路：URLSearchParams 会 percent-decode 后交给登录页（此处模拟消费侧取值）
    const next = new URLSearchParams(url.split('?')[1]).get('next');
    expect(resolveSafeNext(next)).toBe(expected);
  });

  it.each([
    ['/tasks/abc', '?tab=desc', '#comment-2', '/tasks/abc?tab=desc#comment-2'],
    ['/topics/xyz', '', '#msg-42', '/topics/xyz#msg-42'],
  ])('往返不变（含锚点）：%s%s%s', (pathname, search, hash, expected) => {
    const url = buildLoginRedirect(pathname, search, hash);
    const next = new URLSearchParams(url.split('?')[1]).get('next');
    expect(resolveSafeNext(next)).toBe(expected);
  });
});
