/**
 * keycap-tokens 契约单测（G3 `1️⃣` 真回归修复的查询侧单源）。
 *
 * 覆盖：三种键帽字面（数字/`#`/`*`）/ 变体选择符缺省两态 / 非 keycap emoji 反例 /
 * LIKE 元字符强制转义（护栏可测）/ 多 keycap 的 LIKE ALL 语义（顺序 + 去重）/
 * 空结果调用契约（调用方不得挂 LIKE ALL）。
 *
 * 纪律：本套件不访问网络与数据库（纯字符串函数）。
 */
import {
  KEYCAP_TOKEN_REGEX,
  escapeLikeMeta,
  extractKeycapTokens,
} from './keycap-tokens';

/** 键帽字面构造（源码里写 1️⃣ 会与 `\uFE0F` 可选组混淆，故显式拼码点） */
const keycap = (base: string, withVs16 = true): string =>
  withVs16 ? `${base}\uFE0F\u20E3` : `${base}\u20E3`;

describe('extractKeycapTokens', () => {
  it('三种键帽字面都识别，模式串为两端 % 包裹的字面序列', () => {
    expect(extractKeycapTokens(keycap('1'))).toEqual([`%${keycap('1')}%`]);
    expect(extractKeycapTokens(keycap('2'))).toEqual([`%${keycap('2')}%`]);
    expect(extractKeycapTokens(keycap('#'))).toEqual([`%${keycap('#')}%`]);
    expect(extractKeycapTokens(keycap('*'))).toEqual([`%${keycap('*')}%`]);
  });

  it('变体选择符 U+FE0F 缺省/在场两态都命中（真实语料两种形态并存）', () => {
    expect(extractKeycapTokens(keycap('1', false))).toEqual([`%${keycap('1', false)}%`]);
    expect(extractKeycapTokens(keycap('1', true))).toEqual([`%${keycap('1', true)}%`]);
    // 两态是**不同**模式串（不做形态归一）——后果：查询与语料形态不一致时不命中
    //（真库实测：带 FE0F 模式 19 行 / 无 FE0F 模式 0 行；双侧规约修复已登记 Board 后续）
    expect(extractKeycapTokens(keycap('1', false))).not.toEqual(
      extractKeycapTokens(keycap('1', true)),
    );
  });

  it('非 keycap emoji 与裸数字不产生模式（反例：剥离表外的组合符不是 keycap）', () => {
    expect(extractKeycapTokens('⌨️')).toEqual([]); // ⌨ U+FE0F（键盘，仅变体选择符无键帽包围）
    expect(extractKeycapTokens('🔊')).toEqual([]);
    expect(extractKeycapTokens('🌸')).toEqual([]);
    expect(extractKeycapTokens('2026-09-26')).toEqual([]);
    expect(extractKeycapTokens('1')).toEqual([]);
    expect(extractKeycapTokens('')).toEqual([]);
  });

  it('多 keycap：按出现序去重（LIKE ALL 语义 ⇒ 顺序无关、重复折叠）', () => {
    expect(extractKeycapTokens(`${keycap('1')} ${keycap('2')}`)).toEqual([
      `%${keycap('1')}%`,
      `%${keycap('2')}%`,
    ]);
    expect(extractKeycapTokens(`${keycap('2')} ${keycap('1')}`)).toEqual([
      `%${keycap('2')}%`,
      `%${keycap('1')}%`,
    ]);
    // 重复出现折叠为一条（LIKE ALL 与单次等价；顺序 = 首次出现序）
    expect(extractKeycapTokens(`${keycap('1')} ${keycap('1')}`)).toEqual([`%${keycap('1')}%`]);
  });

  it('返回值不含裸 LIKE 元字符（外层 % 包裹除外）——转义护栏的可观测形态', () => {
    for (const base of ['1', '2', '#', '*']) {
      const [pattern] = extractKeycapTokens(keycap(base));
      const inner = pattern.slice(1, -1);
      expect(inner).not.toContain('%');
      expect(inner).not.toContain('_');
      expect(inner).not.toContain('\\'); // 当前正则产不出元字符 ⇒ 不产生任何转义反斜杠
      expect(pattern.startsWith('%')).toBe(true);
      expect(pattern.endsWith('%')).toBe(true);
    }
  });

  it('escapeLikeMeta：\\ 先转义（顺序承重），% / _ 逐个转义；普通文本恒等', () => {
    expect(escapeLikeMeta('a%b')).toBe('a\\%b');
    expect(escapeLikeMeta('a_b')).toBe('a\\_b');
    // 顺序反了会得到 `\\%`（= 字面反斜杠 + 通配符 ⇒ 模式语义反转）
    expect(escapeLikeMeta('a\\%b')).toBe('a\\\\\\%b');
    expect(escapeLikeMeta('1\uFE0F\u20E3')).toBe('1\uFE0F\u20E3');
    expect(escapeLikeMeta('')).toBe('');
  });

  it('模块级正则带 g 标志：经 String#match 连续调用无 lastIndex 残留（跨调用稳定）', () => {
    expect(KEYCAP_TOKEN_REGEX.global).toBe(true);
    const first = extractKeycapTokens(keycap('1'));
    const second = extractKeycapTokens(keycap('1'));
    expect(second).toEqual(first);
    expect(KEYCAP_TOKEN_REGEX.lastIndex).toBe(0);
  });

  it('原始串调用契约：归一化后的串（U+20E3 已剥）恒返回空（防调用点错位）', () => {
    // 归一化把 `1️⃣` 变成 `1`——在编译产物/归一化查询上调用必然静默失效
    expect(extractKeycapTokens('1')).toEqual([]);
  });
});
