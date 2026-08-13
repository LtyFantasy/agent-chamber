/**
 * platform-url.test.ts — getRunnerPlatformUrl 契约测试
 *
 * 覆盖：① dev 绝对路径（NEXT_PUBLIC_API_URL=http://localhost:8743/api/v1）→
 * http://localhost:8743（剥 /api/v1 后缀，不是 web 8742）；② prod 相对路径
 * （/api/v1）→ window.location.origin；③ 未配置 env → 缺省 /api/v1 → origin；
 * ④ 尾斜杠鲁棒性（绝对/相对形态带尾斜杠都剥干净）。
 */

import { getRunnerPlatformUrl } from './platform-url';

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  // 恢复环境变量，避免用例间串扰
  if (ORIGINAL_ENV === undefined) {
    delete process.env.NEXT_PUBLIC_API_URL;
  } else {
    process.env.NEXT_PUBLIC_API_URL = ORIGINAL_ENV;
  }
});

describe('getRunnerPlatformUrl', () => {
  it('dev 绝对路径：剥 /api/v1 后缀返回 backend 根 URL（不是 web 8742）', () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:8743/api/v1';
    expect(getRunnerPlatformUrl()).toBe('http://localhost:8743');
  });

  it('dev 绝对路径带尾斜杠：同样剥干净', () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:8743/api/v1/';
    expect(getRunnerPlatformUrl()).toBe('http://localhost:8743');
  });

  it('prod 相对路径：返回当前 origin（web 与 API 同源拓扑）', () => {
    process.env.NEXT_PUBLIC_API_URL = '/api/v1';
    expect(getRunnerPlatformUrl()).toBe(window.location.origin);
  });

  it('未配置 env：缺省 /api/v1 → 返回当前 origin', () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getRunnerPlatformUrl()).toBe(window.location.origin);
  });

  it('绝对路径但无 /api/v1 后缀（异常形态）：剥尾斜杠后原样返回，不误伤', () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://example.com:9999/custom';
    expect(getRunnerPlatformUrl()).toBe('http://example.com:9999/custom');
  });
});
