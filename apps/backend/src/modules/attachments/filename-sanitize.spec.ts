/**
 * filename-sanitize 单测（plan §3.6 钉死规则）
 *
 * 威胁回归点：CRLF 响应头注入 / 路径分隔符 / UTF-8 字节截断不砍多字节中间 /
 * filename* percent-encoding 补编码 '()*（encodeURIComponent 漏网四字符）。
 */
import { encodeFilenameStar, sanitizeOriginalName } from './filename-sanitize';

describe('sanitizeOriginalName', () => {
  it('剥离控制字符（\\r \\n \\0 \\x07 \\x7F）——CRLF 注入回归', () => {
    expect(sanitizeOriginalName('ev\r\nil\x00\x07\x7Fname.png')).toBe('evilname.png');
  });

  it('路径分隔符 / 与 \\ 替换为 _', () => {
    expect(sanitizeOriginalName('../../etc/passwd.png')).toBe('.._.._etc_passwd.png');
    expect(sanitizeOriginalName('C:\\fakepath\\a.png')).toBe('C:_fakepath_a.png');
  });

  it('trim 后为空回退 attachment（纯控制字符/空白名）', () => {
    expect(sanitizeOriginalName('\r\n\0')).toBe('attachment');
    expect(sanitizeOriginalName('   ')).toBe('attachment');
  });

  it('常规名原样通过', () => {
    expect(sanitizeOriginalName('截图 2026-09-09.png')).toBe('截图 2026-09-09.png');
  });

  it('UTF-8 字节截断 ≤255 且不砍多字节字符中间', () => {
    // 100 个 3 字节字符（300B）→ 截到 85 个（255B）即停
    const name = '汉'.repeat(100);
    const out = sanitizeOriginalName(name);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(255);
    expect(out).toBe('汉'.repeat(85));
  });

  it('混合多字节 + ASCII：逐字节累积到 ≤255 停刀', () => {
    // 84 个"汉"（252B）+ "abcd"（4B）→ 容下 abc（255B），d 停刀
    const name = '汉'.repeat(84) + 'abcd';
    const out = sanitizeOriginalName(name);
    expect(out).toBe('汉'.repeat(84) + 'abc');
    expect(Buffer.byteLength(out, 'utf8')).toBe(255);
  });

  it('busboy latin1 mojibake 还原：UTF-8 中文名恢复', () => {
    const mojibake = Buffer.from('截图 2026.png', 'utf8').toString('latin1');
    expect(sanitizeOriginalName(mojibake)).toBe('截图 2026.png');
  });

  it('真 latin1 名不误还原（非法 UTF-8 序列按原样保留）', () => {
    // é = latin1 0xE9（非法 UTF-8 起始字节）→ 不还原
    expect(sanitizeOriginalName('café.png')).toBe('café.png');
  });

  it('纯 ASCII 名不受 mojibake 还原影响（恒等）', () => {
    expect(sanitizeOriginalName('plain-name_01.png')).toBe('plain-name_01.png');
  });
});

describe('encodeFilenameStar（RFC 6266 ext-value）', () => {
  it('空格与非 ASCII 全编码', () => {
    expect(encodeFilenameStar('截图 1.png')).toBe(
      `%E6%88%AA%E5%9B%BE%201.png`,
    );
  });

  it("补编码 encodeURIComponent 漏网的 ' ( ) * 四字符", () => {
    expect(encodeFilenameStar("a'b(c)d*e.png")).toBe('a%27b%28c%29d%2Ae.png');
  });

  it('attr-char 白名单字符保留不编码（! # $ & + - . ^ _ ` | ~）', () => {
    expect(encodeFilenameStar('a!b#c$d&e+f-g.h^i_j`k|l~m.png')).toBe(
      'a!b#c$d&e+f-g.h^i_j`k|l~m.png',
    );
  });
});
