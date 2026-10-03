/**
 * sql-like.ts 契约单测：字面前缀的 LIKE 转义集与纯函数语义。
 *
 * 消费方的 SQL 形态矩阵（ESCAPE 子句 + `%` 拼接位置）在 doc.service.spec 的
 * pathPrefix/findTree 转义矩阵里断言，本文件只钉住转义集本身。
 */
import { escapeLikePrefix } from './sql-like';

describe('escapeLikePrefix', () => {
  it('三个 LIKE 元字符逐字符转义（\\ % _）', () => {
    expect(escapeLikePrefix('a%b')).toBe('a\\%b');
    expect(escapeLikePrefix('a_b')).toBe('a\\_b');
    expect(escapeLikePrefix('a\\b')).toBe('a\\\\b');
  });

  it('混合与连续元字符：逐个前置反斜杠（不漏不并）', () => {
    expect(escapeLikePrefix('%_\\')).toBe('\\%\\_\\\\');
    expect(escapeLikePrefix('tmp/100%_done\\/')).toBe('tmp/100\\%\\_done\\\\/');
  });

  it('普通路径前缀原样保留（目录语义的尾 / 与普通字符不参与转义）', () => {
    expect(escapeLikePrefix('memory/')).toBe('memory/');
    expect(escapeLikePrefix('docs/2026-09-30/')).toBe('docs/2026-09-30/');
  });

  it('空串是恒等（全定义：调用方不必先判空）', () => {
    expect(escapeLikePrefix('')).toBe('');
  });

  it('幂等性边界：转义产物再转义会继续加反斜杠（本函数不承诺幂等，调用方不得二次调用）', () => {
    // 说明性断言：防有人在调用点"保险起见再转一次"——结果会是 a\\\%b 这类双重转义
    expect(escapeLikePrefix(escapeLikePrefix('a%b'))).toBe('a\\\\\\%b');
  });
});
