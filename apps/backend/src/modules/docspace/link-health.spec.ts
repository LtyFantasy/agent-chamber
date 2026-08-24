/**
 * link-health.ts 单元测试
 *
 * 纯函数测试，不依赖 NestJS / DB。
 * 覆盖 extractDocLinks（各类 href 形态）和 computeLinkHealth（L1 两类规则），
 * 以及 resolveHrefToDocPath（v1.61.0 严格 POSIX 源目录解析矩阵）。
 */

import { extractDocLinks, computeLinkHealth, resolveHrefToDocPath } from './link-health';

describe('link-health', () => {
  // ─── extractDocLinks ───────────────────────────────────────

  describe('extractDocLinks', () => {
    it('returns empty array for empty content', () => {
      expect(extractDocLinks('')).toEqual([]);
    });

    it('returns empty array when no links present', () => {
      expect(extractDocLinks('# Hello\n\nJust text, no links.')).toEqual([]);
    });

    it('extracts a single markdown link href', () => {
      const content = 'See [the guide](docs/guide.md) for details.';
      expect(extractDocLinks(content)).toEqual(['docs/guide.md']);
    });

    it('extracts multiple links in order of appearance', () => {
      const content = '[A](a.md) and [B](b.md) and [C](c.md)';
      expect(extractDocLinks(content)).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('skips http:// URLs', () => {
      const content = '[external](http://example.com) and [internal](docs/x.md)';
      expect(extractDocLinks(content)).toEqual(['docs/x.md']);
    });

    it('skips https:// URLs', () => {
      const content = '[secure](https://example.com) and [internal](docs/x.md)';
      expect(extractDocLinks(content)).toEqual(['docs/x.md']);
    });

    it('skips mailto: links', () => {
      const content = '[email](mailto:a@b.com) and [internal](docs/x.md)';
      expect(extractDocLinks(content)).toEqual(['docs/x.md']);
    });

    it('skips pure anchor-only hrefs (#section)', () => {
      const content = '[jump](#section) and [internal](docs/x.md)';
      expect(extractDocLinks(content)).toEqual(['docs/x.md']);
    });

    it('retains raw href strings without normalization', () => {
      const content = '[link](./docs/../guide.md#anchor)';
      expect(extractDocLinks(content)).toEqual(['./docs/../guide.md#anchor']);
    });

    it('does not match autolink syntax <url>', () => {
      const content = 'See <docs/guide.md> for info.';
      expect(extractDocLinks(content)).toEqual([]);
    });

    it('handles hrefs with special characters', () => {
      const content = '[link](docs/guide%20v2.md)';
      expect(extractDocLinks(content)).toEqual(['docs/guide%20v2.md']);
    });

    it('skips links with empty href', () => {
      const content = '[empty]() and [valid](docs/x.md)';
      expect(extractDocLinks(content)).toEqual(['docs/x.md']);
    });

    describe('CommonMark code regions', () => {
      it('ignores links inside a single-backtick code span', () => {
        expect(extractDocLinks('`[code](inside.md)` [real](outside.md)')).toEqual(['outside.md']);
      });

      it('ignores links inside a double-backtick span containing a single backtick', () => {
        const content = '``[code](inside.md) with `tick` `` [real](outside.md)';
        expect(extractDocLinks(content)).toEqual(['outside.md']);
      });

      it('ignores links inside a code span that crosses a line break', () => {
        const content = '`[code](inside.md)\ncontinued` [real](outside.md)';
        expect(extractDocLinks(content)).toEqual(['outside.md']);
      });

      it('ignores links inside backtick fenced blocks with and without info strings', () => {
        const content = [
          '```ts',
          '[with-info](with-info.md)',
          '```',
          '[real-a](real-a.md)',
          '```',
          '[without-info](without-info.md)',
          '```',
          '[real-b](real-b.md)',
        ].join('\n');
        expect(extractDocLinks(content)).toEqual(['real-a.md', 'real-b.md']);
      });

      it('ignores links inside tilde fenced blocks', () => {
        const content = '~~~markdown\n[code](inside.md)\n~~~\n[real](outside.md)';
        expect(extractDocLinks(content)).toEqual(['outside.md']);
      });

      it('masks an unclosed fenced block through the end of content', () => {
        expect(extractDocLinks('```\n[code](inside.md)\n[also-code](also.md)')).toEqual([]);
      });

      it('still extracts a link after an unmatched backtick run', () => {
        expect(extractDocLinks('Unmatched `` text [real](outside.md)')).toEqual(['outside.md']);
      });

      it('extracts links before and after a code region', () => {
        const content = '[before](before.md) ` [code](inside.md) ` [after](after.md)';
        expect(extractDocLinks(content)).toEqual(['before.md', 'after.md']);
      });
    });
  });

  // ─── resolveHrefToDocPath（v1.61.0 严格 POSIX 源目录解析矩阵）────────────────

  describe('resolveHrefToDocPath', () => {
    it('根绝对（/ 前缀）：去前导 / 后 normalize', () => {
      expect(resolveHrefToDocPath('/docs/architecture.md', 'docs/vision/README.md')).toBe(
        'docs/architecture.md',
      );
      expect(resolveHrefToDocPath('/README.md#section', 'docs/vision/README.md')).toBe('README.md');
      // 根绝对不依赖源目录
      expect(resolveHrefToDocPath('/guides/setup.md', 'a/b/c.md')).toBe('guides/setup.md');
    });

    it('同目录相对 ./：join(dirname(sourcePath), href) 严格解析', () => {
      // docs/vision/README.md 内 ./world.md → docs/vision/world.md
      expect(resolveHrefToDocPath('./world.md', 'docs/vision/README.md')).toBe(
        'docs/vision/world.md',
      );
      // 回归（plan §1.8）：docs/roadmap/README.md 内 ./product-stages.md
      expect(resolveHrefToDocPath('./product-stages.md', 'docs/roadmap/README.md')).toBe(
        'docs/roadmap/product-stages.md',
      );
    });

    it('嵌套目录上溯 ../：逐级精确解析', () => {
      // docs/vision/README.md 内 ../spec.md → docs/spec.md
      expect(resolveHrefToDocPath('../spec.md', 'docs/vision/README.md')).toBe('docs/spec.md');
      // 两层上溯（sub → vision → docs 根）
      expect(resolveHrefToDocPath('../../guides/setup.md', 'docs/vision/sub/README.md')).toBe(
        'docs/guides/setup.md',
      );
      // 上溯后再下探（docs/vision 的上一级是 docs 根）
      expect(resolveHrefToDocPath('../docspace/notes.md', 'docs/vision/README.md')).toBe(
        'docs/docspace/notes.md',
      );
    });

    it('裸 href 严格源相对：按源目录拼接（不再补 docs/ 前缀）', () => {
      // docs/spec.md 内写 roadmap/README.md → docs/roadmap/README.md（v1.61.0 行为变更：
      // 旧启发式会剥前缀后补 docs/ 命中文档；现在按源目录精确解析）
      expect(resolveHrefToDocPath('roadmap/README.md', 'docs/spec.md')).toBe(
        'docs/roadmap/README.md',
      );
      // 顶层文档内裸文件名 → 顶层
      expect(resolveHrefToDocPath('README.md', 'spec.md')).toBe('README.md');
      // 旧启发式的 docs/ 补全不再生效：docs/vision/README.md 内 docs/spec.md → docs/vision/docs/spec.md
      expect(resolveHrefToDocPath('docs/spec.md', 'docs/vision/README.md')).toBe(
        'docs/vision/docs/spec.md',
      );
    });

    it('越出空间根（join 后 normalize 结果以 .. 开头）→ 不可达路径（永不命中 → 判 broken）', () => {
      // 词法语义：../ 段数 > 源文档目录深度才产生 .. 前缀（join 先消根内可消段）
      // 深度 2（docs/vision）恰好 2 层 → 到根（x.md），不算越界
      expect(resolveHrefToDocPath('../../x.md', 'docs/vision/README.md')).toBe('x.md');
      // 3 层 → 越界 1 层
      expect(resolveHrefToDocPath('../../../x.md', 'docs/vision/README.md')).toBe('../x.md');
      // 4 层 → 越界 2 层（前缀 .. 保留，后续路径原样）
      expect(resolveHrefToDocPath('../../../../a/b.md', 'docs/vision/README.md')).toBe('../../a/b.md');
      // 深度 3（docs/vision/sub）：3 层上溯恰好到根（不越界）；4 层才越界——
      // 规律：../ 段数 = dirname 段数 N 时到根（x.md），N+1 及以上才产生 .. 前缀
      expect(resolveHrefToDocPath('../../../../x.md', 'docs/vision/sub/README.md')).toBe('../x.md');
      // 一层上溯 + 相对下探恰好回到根内不越界
      expect(resolveHrefToDocPath('../a.md', 'docs/vision/README.md')).toBe('docs/a.md');
    });

    it('剥离 # 锚点（含 ./ ../ 组合）', () => {
      expect(resolveHrefToDocPath('./world.md#section-2', 'docs/vision/README.md')).toBe(
        'docs/vision/world.md',
      );
      expect(resolveHrefToDocPath('/docs/spec.md#error-codes', 'x/y.md')).toBe('docs/spec.md');
    });

    it('自引用：链自身 path（同目录裸文件名 / ./ 前缀）解析回自身', () => {
      expect(resolveHrefToDocPath('./README.md', 'docs/vision/README.md')).toBe(
        'docs/vision/README.md',
      );
      expect(resolveHrefToDocPath('README.md', 'docs/vision/README.md')).toBe(
        'docs/vision/README.md',
      );
    });

    it('不参与判定的 href → null（非 .md / 纯锚点 / 空 / 外部协议）', () => {
      expect(resolveHrefToDocPath('assets/diagram.png', 'docs/vision/README.md')).toBeNull();
      expect(resolveHrefToDocPath('#section', 'docs/vision/README.md')).toBeNull();
      expect(resolveHrefToDocPath('', 'docs/vision/README.md')).toBeNull();
      expect(resolveHrefToDocPath('.', 'docs/vision/README.md')).toBeNull();
      // 外部协议以 .md 结尾也不判定（extractDocLinks 入口已跳过，本函数兜底同口径）
      expect(resolveHrefToDocPath('https://example.com/x.md', 'docs/vision/README.md')).toBeNull();
    });
  });

  // ─── computeLinkHealth ─────────────────────────────────────

  describe('computeLinkHealth', () => {
    const candidates = {
      paths: new Set([
        'docs/architecture.md',
        'docs/roadmap/product-stages.md',
        'docs/vision/world.md',
        'PROJECT.md',
        'guides/setup.md',
      ]),
      docIds: new Set([
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        '11111111-2222-3333-4444-555555555555',
      ]),
    };

    it('returns total=0, broken=[] for content with no links', () => {
      const result = computeLinkHealth('# No links here', 'docs/vision/README.md', candidates);
      expect(result.total).toBe(0);
      expect(result.broken).toEqual([]);
      expect(result.checkedAt).toBeDefined();
    });

    // ── L1-① Platform doc links ──────────────────────────

    it('marks /docs/<spaceId>?doc=<validId> as not broken', () => {
      const content = 'See [doc](/docs/space-1?doc=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('marks /docs/<spaceId>?doc=<invalidId> as broken', () => {
      const content = 'See [doc](/docs/space-1?doc=00000000-0000-0000-0000-000000000000)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual(['/docs/space-1?doc=00000000-0000-0000-0000-000000000000']);
    });

    it('matches /docs/...?doc=... case-insensitively for the path pattern', () => {
      // Doc link regex is case-insensitive for the /docs/ prefix
      const content = 'See [doc](/DOCS/space-1?doc=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    // ── L1-② Relative .md path references（严格源目录解析）─────────────────

    it('marks valid source-relative .md path as not broken', () => {
      // docs/vision/README.md 内 ./world.md → docs/vision/world.md ∈ paths
      const content = 'See [world](./world.md)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('marks root-absolute .md path as not broken', () => {
      // /docs/architecture.md → docs/architecture.md ∈ paths
      const content = 'See [arch](/docs/architecture.md)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('regression（plan §1.8）：docs/roadmap/README.md 内 ./product-stages.md 健康', () => {
      const content = 'See [stages](./product-stages.md)';
      // docs/roadmap/README.md 内 ./product-stages.md → docs/roadmap/product-stages.md ∈ paths
      const result = computeLinkHealth(content, 'docs/roadmap/README.md', candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('marks missing .md path as broken（原始 href 进 broken 数组）', () => {
      const content = 'See [missing](docs/nonexistent.md)';
      const result = computeLinkHealth(content, 'docs/test.md', candidates);
      // 严格解析：docs/test.md 内 docs/nonexistent.md → docs/docs/nonexistent.md 不命中
      expect(result.total).toBe(1);
      expect(result.broken).toEqual(['docs/nonexistent.md']);
    });

    it('strips #anchor before matching .md path', () => {
      const content = 'See [arch](/docs/architecture.md#section-3)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('越出空间根 = 断链（../ 越界写法）', () => {
      // docs/vision/README.md（深度 2）内 ../../../PROJECT.md → ../PROJECT.md（越界不可达）
      const content = 'See [project](../../../PROJECT.md)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual(['../../../PROJECT.md']);
      // 恰好到根的 ../../PROJECT.md → PROJECT.md ∈ paths → 健康（严格词法解析正确归位）
      const atRoot = computeLinkHealth(
        'See [project](../../PROJECT.md)',
        'docs/vision/README.md',
        candidates,
      );
      expect(atRoot.broken).toEqual([]);
    });

    it('嵌套目录上溯命中：docs/vision/README.md 内 ../spec.md 需空间内存在 docs/spec.md', () => {
      const withSpec = {
        paths: new Set([...candidates.paths, 'docs/spec.md']),
        docIds: candidates.docIds,
      };
      const content = 'See [spec](../spec.md)';
      const ok = computeLinkHealth(content, 'docs/vision/README.md', withSpec);
      expect(ok.total).toBe(1);
      expect(ok.broken).toEqual([]);
      // 无 docs/spec.md 时判 broken（同 href 从同目录文档写出不命中根级缺失）
      const broken = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      expect(broken.broken).toEqual(['../spec.md']);
    });

    it('自引用健康：docs/vision/README.md 内 ./README.md 命中自身 path', () => {
      const withSelf = {
        paths: new Set([...candidates.paths, 'docs/vision/README.md']),
        docIds: candidates.docIds,
      };
      const content = 'See [self](./README.md)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', withSelf);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('旧启发式 docs/ 前缀补全不再生效 → docs/vision/README.md 内 docs/spec.md 判 broken', () => {
      const content = 'See [spec](docs/spec.md)';
      const withSpec = {
        paths: new Set([...candidates.paths, 'docs/spec.md']),
        docIds: candidates.docIds,
      };
      const result = computeLinkHealth(content, 'docs/vision/README.md', withSpec);
      // 严格解析 = docs/vision/docs/spec.md 不命中（v1.61.0 行为变更的显式钉死）
      expect(result.total).toBe(1);
      expect(result.broken).toEqual(['docs/spec.md']);
    });

    it('skips non-.md relative paths (not checked)', () => {
      const content = 'See [image](assets/diagram.png)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      // Non-.md paths are not checked — they don't count toward total or broken
      expect(result.total).toBe(0);
      expect(result.broken).toEqual([]);
    });

    // ── Dedup + mixed ────────────────────────────────────

    it('deduplicates broken hrefs (keeps first occurrence order)', () => {
      const content =
        'See [A](/docs/space-1?doc=00000000-0000-0000-0000-000000000000) and [A](/docs/space-1?doc=00000000-0000-0000-0000-000000000000)';
      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      // total 与 broken 均按唯一链接计（重复 href 只判定一次）
      expect(result.total).toBe(1);
      expect(result.broken).toEqual(['/docs/space-1?doc=00000000-0000-0000-0000-000000000000']);
    });

    it('handles mix of valid, broken, and skipped links', () => {
      const content = [
        'See [valid-doc](/docs/space-1?doc=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)',
        'See [broken-doc](/docs/space-1?doc=00000000-0000-0000-0000-000000000000)',
        'See [valid-md](./world.md)',
        'See [broken-md](ghost.md)',
        'See [external](https://example.com)',
        'See [mail](mailto:a@b.com)',
      ].join('\n');

      const result = computeLinkHealth(content, 'docs/vision/README.md', candidates);
      // Only 4 links counted (external + mailto skipped)
      expect(result.total).toBe(4);
      expect(result.broken).toEqual([
        '/docs/space-1?doc=00000000-0000-0000-0000-000000000000',
        'ghost.md',
      ]);
    });

    it('always sets checkedAt to an ISO date string', () => {
      const result = computeLinkHealth('no links', 'docs/vision/README.md', candidates);
      expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('sourcePath 决定解析：同 href 从不同源目录判健康/断链', () => {
      const assets = {
        paths: new Set([
          'docs/vision/world.md',
          'docs/vision/sub/guide.md',
        ]),
        docIds: new Set([]),
      };
      // ../guide.md 从 docs/vision/world.md → docs/guide.md 不存在 → broken
      const fromVision = computeLinkHealth('See [g](../guide.md)', 'docs/vision/world.md', assets);
      expect(fromVision.broken).toEqual(['../guide.md']);
      // ../guide.md 从 docs/vision/sub/guide.md 的邻居 world2.md → 命中 sub 同级……不，
      // 从 docs/vision/sub/xxx.md 上溯 → docs/vision/guide.md 仍不命中；用 ./guide.md 同目录命中
      const fromSub = computeLinkHealth('See [g](./guide.md)', 'docs/vision/sub/guide.md', assets);
      expect(fromSub.broken).toEqual([]);
    });
  });
});
