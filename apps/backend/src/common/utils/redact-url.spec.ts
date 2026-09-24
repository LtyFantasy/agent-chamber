/**
 * redact-url 单测（P2 批 2 / plan §②.7）：日志脱敏的边界矩阵。
 *
 * 为什么单测而非只靠集成断言：脱敏是"漏一个键就等于没做"的安全面，
 * 键大小写、重复键（数组形态）、无值形态、fragment、编码值都要有确定行为，
 * 而这些在 HTTP 集成测试里只能覆盖其中一两条。
 */
import { redactUrl, REDACTED_QUERY_KEYS } from './redact-url';

describe('redactUrl', () => {
  it('单个敏感键 → 值替换为 [redacted]（路径与非敏感键原样）', () => {
    expect(redactUrl('/api/v1/public/attachments/abc/content?token=eyJhbGciOi.J9&v=2')).toBe(
      '/api/v1/public/attachments/abc/content?token=[redacted]&v=2',
    );
  });

  it('数组形态 ?token=a&token=b → 每个重复段各自替换（Express 多值 query 场景）', () => {
    expect(redactUrl('/x?token=a&token=b')).toBe('/x?token=[redacted]&token=[redacted]');
  });

  it('全部敏感键都覆盖（前向防御键含 refresh_token/sig/signature/password）', () => {
    for (const key of REDACTED_QUERY_KEYS) {
      expect(redactUrl(`/x?${key}=secret-value`)).toBe(`/x?${key}=[redacted]`);
    }
  });

  it('键名大小写不敏感（?Token= 不得绕过）', () => {
    expect(redactUrl('/x?Token=abc&API_KEY=def')).toBe('/x?Token=[redacted]&API_KEY=[redacted]');
  });

  it('无值形态 ?token（无 = ）→ 仍视为敏感并补写 [redacted]', () => {
    expect(redactUrl('/x?token&v=2')).toBe('/x?token=[redacted]&v=2');
  });

  it('无敏感键 → 逐字符原样（不重编码、保持顺序与形态）', () => {
    const url = '/api/v1/attachments?page=2&pageSize=20&q=%E4%B8%AD%E6%96%87+a';
    expect(redactUrl(url)).toBe(url);
  });

  it('空值敏感键 ?token= → 替换为 [redacted]（不暴露"空"这一信息）', () => {
    expect(redactUrl('/x?token=&v=1')).toBe('/x?token=[redacted]&v=1');
  });

  it('无 query / 空串 / undefined → 原样返回（无 query 返回原串，空值返回空串）', () => {
    expect(redactUrl('/api/v1/health')).toBe('/api/v1/health');
    expect(redactUrl('/api/v1/health?')).toBe('/api/v1/health?');
    expect(redactUrl('')).toBe('');
    expect(redactUrl(undefined)).toBe('');
    expect(redactUrl(null)).toBe('');
  });

  it('fragment 原样保留（其内部不做 query 解析，也不吞掉它）', () => {
    expect(redactUrl('/x?token=abc#frag=1')).toBe('/x?token=[redacted]#frag=1');
  });

  it('敏感值含编码字符时整段被替换（不残留原值任何片段/长度线索）', () => {
    const out = redactUrl('/x?token=eyJhbGciOiJI%2B%2F%3D.abc.def&other=1');
    expect(out).toBe('/x?token=[redacted]&other=1');
    expect(out).not.toContain('eyJhbGciOiJI');
  });

  it('非敏感键的子串/前缀不得误伤（key 敏感但 apikey 前缀场景按精确键匹配）', () => {
    // `api_keys` 不是 `api_key`：刻意保持原值（精确键匹配，不做模糊包含）
    expect(redactUrl('/x?apikeys=1&keychain=2')).toBe('/x?apikeys=1&keychain=2');
  });
});
