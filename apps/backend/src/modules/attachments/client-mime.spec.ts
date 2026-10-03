/**
 * client-mime.spec.ts — 客户端声明 mime 的 sanitize 单测（附件 TTL 批 §1.2 M1）。
 *
 * 契约：client_mime_type 是**纯展示信息**（卡片图标参考），不参与任何服务决策；
 * 非法/缺失 → NULL。本套件钉死 sanitize 的每一条规则（剥控制字符 / 取分号前段 /
 * 形状校验 / 截断），因为"非法回退 NULL"是本列唯一的正确性保证。
 */
import { CLIENT_MIME_MAX_LENGTH, sanitizeClientMimeType } from './client-mime';

describe('sanitizeClientMimeType', () => {
  it('正常 mime 原样通过（含 + 与 - 等 token 字符）', () => {
    expect(sanitizeClientMimeType('image/png')).toBe('image/png');
    expect(sanitizeClientMimeType('application/vnd.openxmlformats-officedocument')).toBe(
      'application/vnd.openxmlformats-officedocument',
    );
    expect(sanitizeClientMimeType('text/x-shellscript')).toBe('text/x-shellscript');
  });

  it('剥控制字符（CRLF/NUL/DEL）——防响应头/日志注入面', () => {
    expect(sanitizeClientMimeType('image/\r\npng')).toBe('image/png');
    expect(sanitizeClientMimeType('image/\u0000png')).toBe('image/png');
    expect(sanitizeClientMimeType('text/pla\u007fin')).toBe('text/plain');
  });

  it('取第一个分号前的 media type（charset 等参数不属于 mime 标识）', () => {
    expect(sanitizeClientMimeType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(sanitizeClientMimeType('  image/jpeg ; q=0.9')).toBe('image/jpeg');
  });

  it('形状不合法 → NULL（含空格/多斜杠/无子类型/通配字符集外）', () => {
    expect(sanitizeClientMimeType('not a mime')).toBeNull();
    expect(sanitizeClientMimeType('application/')).toBeNull();
    expect(sanitizeClientMimeType('/json')).toBeNull();
    expect(sanitizeClientMimeType('a/b/c')).toBeNull();
    expect(sanitizeClientMimeType('image/pn g')).toBeNull();
    expect(sanitizeClientMimeType('')).toBeNull();
    expect(sanitizeClientMimeType('   ')).toBeNull();
  });

  it('非字符串 / null / undefined → NULL（外部输入类型不可信）', () => {
    expect(sanitizeClientMimeType(undefined)).toBeNull();
    expect(sanitizeClientMimeType(null)).toBeNull();
    expect(sanitizeClientMimeType(123)).toBeNull();
    expect(sanitizeClientMimeType({ toString: () => 'image/png' })).toBeNull();
    expect(sanitizeClientMimeType(['image/png'])).toBeNull();
  });

  it('超长**且形状合法**的值截断 ≤ CLIENT_MIME_MAX_LENGTH（列宽 varchar(100) 对齐）', () => {
    const long = `image/${'a'.repeat(200)}`;
    const out = sanitizeClientMimeType(long);
    expect(out).not.toBeNull();
    expect((out as string).length).toBe(CLIENT_MIME_MAX_LENGTH);
    // 截断后仍是合法形状（token 字符集对截断封闭）——与"非法 → NULL"契约不冲突
    expect(out).toMatch(/^image\/a+$/);
  });

  it('先形状校验后截断（m1）：越界位置的非法字符不得被截断洗白 → NULL', () => {
    // 空格落在第 100 字符之外：若先截断再校验，前缀形状合法 → 非法值被洗白落地
    expect(sanitizeClientMimeType(`image/png${'x'.repeat(200)} space`)).toBeNull();
    expect(sanitizeClientMimeType(`image/png${'x'.repeat(200)}/`)).toBeNull();
    // 对照：同长度但整串合法 → 截断返回
    expect(sanitizeClientMimeType(`image/png${'x'.repeat(200)}`)).not.toBeNull();
  });

  it('超长且多段斜杠（三斜杠形态）→ NULL，不因截断变成合法', () => {
    expect(sanitizeClientMimeType(`${'a'.repeat(50)}/b/c`)).toBeNull();
    expect(sanitizeClientMimeType(`${'a'.repeat(200)}/b/c`)).toBeNull();
    expect(sanitizeClientMimeType(`${'a'.repeat(200)}/b`)).not.toBeNull();
  });

  it('注入形态（HTML/JS）→ NULL（形状闸挡下，绝不落库）', () => {
    expect(sanitizeClientMimeType('<script>alert(1)</script>')).toBeNull();
    expect(sanitizeClientMimeType('text/html><img src=x onerror=1')).toBeNull();
  });
});
