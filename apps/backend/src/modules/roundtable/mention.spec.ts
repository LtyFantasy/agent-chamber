/**
 * mention 解析纯函数测试（M2 阶段 3，R5 token 级精确匹配矩阵；铁律 #17 测试契约）
 *
 * 覆盖：精确命中 / @labelX 不命中 / 前后边界 / 代码块剥离 / inline code 剥离 /
 * 引用行剥离 / 多 @ 混合 / @all 与 @allx / 中文标点边界 / label 正则特殊字符 /
 * 大小写敏感 / 空文本。
 */
import {
  stripMentionNoise,
  findMentionedLabels,
  hasAllMention,
} from './mention';

/** 断言命中集合（按 label 排序比较，避免 Set 遍历顺序干扰） */
function expectLabels(text: string, labels: string[], expected: string[]): void {
  const hit = [...findMentionedLabels(text, labels)].sort();
  expect(hit).toEqual([...expected].sort());
}

describe('mention 解析（M2 阶段 3，R5 token 级精确）', () => {
  describe('findMentionedLabels', () => {
    it('精确命中：@kimi-1 命中 label kimi-1', () => {
      expectLabels('你好 @kimi-1 请回复', ['kimi-1'], ['kimi-1']);
    });

    it('字符串末尾的 @label 也命中（结尾视为合法边界）', () => {
      expectLabels('请 @kimi-1', ['kimi-1'], ['kimi-1']);
    });

    it('@labelX 不命中：@kimi-1x 不命中 kimi-1（token 后缀边界）', () => {
      expectLabels('@kimi-1x 你好', ['kimi-1'], []);
    });

    it('前缀边界：字母紧跟 @ 前不命中（email 风格 foo@kimi-1）', () => {
      expectLabels('foo@kimi-1 你好', ['kimi-1'], []);
    });

    it('中文标点边界：@kimi-1。与 @kimi-1，均命中', () => {
      expectLabels('@kimi-1。你好', ['kimi-1'], ['kimi-1']);
      expectLabels('@kimi-1，你好', ['kimi-1'], ['kimi-1']);
    });

    it('英文标点/括号边界命中', () => {
      expectLabels('(@kimi-1) 你好', ['kimi-1'], ['kimi-1']);
      expectLabels('@kimi-1, please', ['kimi-1'], ['kimi-1']);
    });

    it('多 @ 混合：@kimi-1 与 @kimi-2 各自命中', () => {
      expectLabels('@kimi-1 和 @kimi-2 都来', ['kimi-1', 'kimi-2'], ['kimi-1', 'kimi-2']);
    });

    it('未提及的 label 不命中', () => {
      expectLabels('@kimi-1 你好', ['kimi-1', 'kimi-2'], ['kimi-1']);
    });

    it('大小写敏感：@Kimi-1 不命中 kimi-1', () => {
      expectLabels('@Kimi-1 你好', ['kimi-1'], []);
    });

    it('label 含正则特殊字符：转义后仍可精确寻址', () => {
      // . + ( ) [ ] 等都是正则特殊字符，label 原样含有时必须转义匹配
      expectLabels('@a+b.c(d) 你好', ['a+b.c(d)'], ['a+b.c(d)']);
      expectLabels('@a1b2c3 你好', ['a+b.c(d)'], []); // 未转义会误命中的反例必须不命中
    });

    it('空文本 / 空 label 列表 → 空集合', () => {
      expectLabels('', ['kimi-1'], []);
      expectLabels('@kimi-1', [], []);
    });

    it('label 之间互不干扰（kimi-1 与 kimi-1x 并存时按各自边界独立判定）', () => {
      expectLabels('@kimi-1x 和 @kimi-1', ['kimi-1', 'kimi-1x'], ['kimi-1', 'kimi-1x']);
      expectLabels('@kimi-1', ['kimi-1', 'kimi-1x'], ['kimi-1']);
    });
  });

  describe('hasAllMention（@all 保留令牌）', () => {
    it('@all 命中（独立 token）', () => {
      expect(hasAllMention('@all 请全体回复')).toBe(true);
    });

    it('@allx 不命中（后缀边界）', () => {
      expect(hasAllMention('@allx 你好')).toBe(false);
    });

    it('前缀边界：foo@all 不命中', () => {
      expect(hasAllMention('foo@all')).toBe(false);
    });

    it('大小写敏感：@All / @ALL 不命中', () => {
      expect(hasAllMention('@All 你好')).toBe(false);
      expect(hasAllMention('@ALL 你好')).toBe(false);
    });

    it('中文标点边界命中', () => {
      expect(hasAllMention('@all。')).toBe(true);
      expect(hasAllMention('@all，')).toBe(true);
    });

    it('空文本不命中', () => {
      expect(hasAllMention('')).toBe(false);
    });
  });

  describe('stripMentionNoise（代码块/inline code/引用行剥离）', () => {
    it('fenced code block 内 @ 剥离，块外保留', () => {
      const text = '```\n@kimi-1 这是代码\n```\n@kimi-1 这是正文';
      const stripped = stripMentionNoise(text);
      expectLabels(stripped, ['kimi-1'], ['kimi-1']);
      expect(stripped).not.toContain('这是代码');
    });

    it('带语言标注的围栏（```js）同样剥离', () => {
      const text = '```js\nconst x = "@kimi-1";\n```\n请 @kimi-1';
      expectLabels(stripMentionNoise(text), ['kimi-1'], ['kimi-1']);
    });

    it('~~~ 围栏同样剥离，且与 ``` 不互相闭合', () => {
      const text = '~~~\n@kimi-1\n~~~\n@kimi-1 正文';
      expectLabels(stripMentionNoise(text), ['kimi-1'], ['kimi-1']);
    });

    it('inline code 内 @ 剥离，块外保留', () => {
      const text = '跑一下 `@kimi-1` 试试，@kimi-1 请看';
      expectLabels(stripMentionNoise(text), ['kimi-1'], ['kimi-1']);
    });

    it('inline code 中嵌 @all 不触发广播', () => {
      expect(hasAllMention(stripMentionNoise('见文档 \`@all\` 说明'))).toBe(false);
    });

    it('blockquote 行剥离（行首 >，允许前导空白），正文保留', () => {
      const text = '> @kimi-1 这是引用\n\n@kimi-1 这是正文';
      expectLabels(stripMentionNoise(text), ['kimi-1'], ['kimi-1']);
    });

    it('多行混合：代码块 + 引用 + 正文的 @ 各自按规则判定', () => {
      const text = [
        '> @kimi-1 引用',
        '```',
        '@all 代码里的广播不算',
        '```',
        '@kimi-2 和 @all 正文',
      ].join('\n');
      const stripped = stripMentionNoise(text);
      expectLabels(stripped, ['kimi-1', 'kimi-2'], ['kimi-2']);
      expect(hasAllMention(stripped)).toBe(true);
    });

    it('普通正文原样保留（无剥离副作用）', () => {
      const text = '普通文本 @kimi-1 保持不变';
      expect(stripMentionNoise(text)).toBe(text);
    });

    it('空文本剥离后仍为空', () => {
      expect(stripMentionNoise('')).toBe('');
    });
  });

  describe('组合场景（剥噪 → 匹配全链路）', () => {
    it('代码块里 @ 不唤醒、正文 @ 唤醒（同 label 并存）', () => {
      const text = '报错信息：\n```\n@kimi-1 处理一下\n```\n实际是 @kimi-1 的问题';
      expectLabels(stripMentionNoise(text), ['kimi-1'], ['kimi-1']);
    });

    it('代码块内 @all 不触发广播，正文 @all 触发', () => {
      const text = '```\n@all\n```\n@all 全体注意';
      expect(hasAllMention(stripMentionNoise(text))).toBe(true);
    });
  });
});
