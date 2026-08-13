/**
 * mention-utils.test.ts — 圆桌输入 @ 补全/高亮纯函数契约测试（M2 web 批次）
 *
 * 对齐后端 apps/backend/src/modules/roundtable/mention.ts 语义（token 边界/剥噪镜像），
 * 覆盖：
 * ① detectMentionQuery 边界矩阵（行首@/空格后@/x@不触发/query 含空格关闭/
 *    caret 脱离 token 关闭/空 query/空文本）
 * ② filterMentionTargets（大小写不敏感前缀过滤/空 query 全量/无匹配）
 * ③ buildHighlightSegments（@all 与 @label 高亮/token 超集与大小写不敏感不高亮/
 *    代码块/inline code/引用内不高亮/label 正则特殊字符转义）
 */

import {
  detectMentionQuery,
  filterMentionTargets,
  buildHighlightSegments,
  hasAllMention,
} from './mention-utils';

describe('detectMentionQuery 边界矩阵', () => {
  it('行首 @ + caret 在 token 尾部 → 命中', () => {
    expect(detectMentionQuery('@kimi', 5)).toEqual({ start: 0, query: 'kimi' });
  });

  it('刚输入 @（空 query）→ 命中空查询（picker 显示全量候选）', () => {
    expect(detectMentionQuery('hello @', 7)).toEqual({ start: 6, query: '' });
  });

  it('空格后 @：`见 @kimi-1` → 命中（@ 前一字符是空格 = 合法边界）', () => {
    expect(detectMentionQuery('见 @kimi-1', 9)).toEqual({ start: 2, query: 'kimi-1' });
  });

  it('x@ 不触发：@ 前一字符是边界字符（[A-Za-z0-9_-]）', () => {
    expect(detectMentionQuery('x@kimi', 6)).toBeNull();
  });

  it('query 含空格关闭：`@ki mi` caret 在 mi 后 → null', () => {
    expect(detectMentionQuery('@ki mi', 6)).toBeNull();
  });

  it('caret 脱离 token 尾部关闭：`@kimi x` caret 在 x 后 → null', () => {
    expect(detectMentionQuery('@kimi x', 7)).toBeNull();
  });

  it('caret 在 token 中间：`@kimi` caret 在 k 后 → query=k', () => {
    expect(detectMentionQuery('@kimi', 2)).toEqual({ start: 0, query: 'k' });
  });

  it('空文本 / caret 为 0 → null', () => {
    expect(detectMentionQuery('', 0)).toBeNull();
    expect(detectMentionQuery('@kimi', 0)).toBeNull();
  });
});

describe('filterMentionTargets', () => {
  it('大小写不敏感前缀过滤，保持原顺序', () => {
    expect(filterMentionTargets('kimi', ['kimi-1', 'codex-1', 'kimi-2'])).toEqual([
      'kimi-1',
      'kimi-2',
    ]);
  });

  it('大写查询命中小写 label', () => {
    expect(filterMentionTargets('KIMI', ['kimi-1', 'codex-1'])).toEqual(['kimi-1']);
  });

  it('空 query 返回全部（副本，不引用原数组）', () => {
    const labels = ['b', 'a'];
    const out = filterMentionTargets('', labels);
    expect(out).toEqual(['b', 'a']);
    expect(out).not.toBe(labels);
  });

  it('无匹配 → 空数组', () => {
    expect(filterMentionTargets('zzz', ['kimi-1'])).toEqual([]);
  });
});

describe('buildHighlightSegments 命中规则', () => {
  it('@all 高亮（固定广播令牌）', () => {
    expect(buildHighlightSegments('请 @all 参会', ['kimi-1'])).toEqual([
      { text: '请 ', highlight: false },
      { text: '@all', highlight: true },
      { text: ' 参会', highlight: false },
    ]);
  });

  it('@kimi-1 高亮', () => {
    expect(buildHighlightSegments('@kimi-1 你好', ['kimi-1'])).toEqual([
      { text: '@kimi-1', highlight: true },
      { text: ' 你好', highlight: false },
    ]);
  });

  it('@kimi-1x 不高亮（token 超集，边界 lookahead 拦截）', () => {
    const segs = buildHighlightSegments('@kimi-1x 你好', ['kimi-1']);
    expect(segs.every((s) => !s.highlight)).toBe(true);
  });

  it('@Kimi-1 不高亮（大小写敏感）', () => {
    const segs = buildHighlightSegments('@Kimi-1 你好', ['kimi-1']);
    expect(segs.every((s) => !s.highlight)).toBe(true);
  });

  it('fenced code block 内不高亮，正文正常高亮', () => {
    const segs = buildHighlightSegments('```\n@kimi-1\n```\n正文 @kimi-1', ['kimi-1']);
    expect(segs.filter((s) => s.highlight)).toEqual([{ text: '@kimi-1', highlight: true }]);
  });

  it('inline code 内不高亮，正文正常高亮', () => {
    const segs = buildHighlightSegments('用 `@kimi-1` 试试，再 @kimi-1', ['kimi-1']);
    expect(segs.filter((s) => s.highlight)).toEqual([{ text: '@kimi-1', highlight: true }]);
  });

  it('blockquote 行内不高亮，正文正常高亮', () => {
    const segs = buildHighlightSegments('> @kimi-1\n正文 @all', ['kimi-1']);
    expect(segs.filter((s) => s.highlight)).toEqual([{ text: '@all', highlight: true }]);
  });

  it('label 含正则特殊字符（+）转义精确寻址', () => {
    expect(buildHighlightSegments('找 @c++ 看板', ['c++'])).toEqual([
      { text: '找 ', highlight: false },
      { text: '@c++', highlight: true },
      { text: ' 看板', highlight: false },
    ]);
  });

  it('重叠命中合并：@all 固定候选与名为 all 的座位只产生一段', () => {
    const segs = buildHighlightSegments('@all', ['all']);
    expect(segs).toEqual([{ text: '@all', highlight: true }]);
  });
});

describe('hasAllMention（M3 阶段 3 @all 闸门确认框口径镜像）', () => {
  it('正文含独立 @all token → true（与后端 hasAllMention 同口径）', () => {
    expect(hasAllMention('@all 全体注意')).toBe(true);
    expect(hasAllMention('大家看 @all，开会了')).toBe(true);
    expect(hasAllMention('行首@all')).toBe(true);
  });

  it('超集/大小写不敏感不命中：@All / @allx / x@all / @all。 尾标点命中', () => {
    expect(hasAllMention('@All 你好')).toBe(false); // 大小写敏感
    expect(hasAllMention('@allx 你好')).toBe(false); // 后缀边界
    expect(hasAllMention('x@all 你好')).toBe(false); // 前缀边界
    expect(hasAllMention('@all。')).toBe(true); // CJK 标点是合法边界（后端同规）
  });

  it('代码块/inline code/引用行内的 @all 不算提及（剥噪口径镜像，不弹确认框）', () => {
    expect(hasAllMention('```\n@all 在代码里\n```')).toBe(false);
    expect(hasAllMention('文档里写 `@all` 不生效')).toBe(false);
    expect(hasAllMention('> @all 引用不算\n正文 @all')).toBe(true); // 正文仍命中
  });

  it('空文本/无 @all → false', () => {
    expect(hasAllMention('')).toBe(false);
    expect(hasAllMention('普通消息')).toBe(false);
    expect(hasAllMention('@kimi-1 定向')).toBe(false);
  });
});
