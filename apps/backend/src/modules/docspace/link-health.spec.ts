/**
 * link-health.ts 单元测试
 *
 * 纯函数测试，不依赖 NestJS / DB。
 * 覆盖 extractDocLinks（各类 href 形态）和 computeLinkHealth（L1 两类规则）。
 */

import { extractDocLinks, computeLinkHealth } from './link-health';

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
  });

  // ─── computeLinkHealth ─────────────────────────────────────

  describe('computeLinkHealth', () => {
    const candidates = {
      paths: new Set(['docs/architecture.md', 'PROJECT.md', 'guides/setup.md']),
      docIds: new Set([
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        '11111111-2222-3333-4444-555555555555',
      ]),
    };

    it('returns total=0, broken=[] for content with no links', () => {
      const result = computeLinkHealth('# No links here', candidates);
      expect(result.total).toBe(0);
      expect(result.broken).toEqual([]);
      expect(result.checkedAt).toBeDefined();
    });

    // ── L1-① Platform doc links ──────────────────────────

    it('marks /docs/<spaceId>?doc=<validId> as not broken', () => {
      const content = 'See [doc](/docs/space-1?doc=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('marks /docs/<spaceId>?doc=<invalidId> as broken', () => {
      const content = 'See [doc](/docs/space-1?doc=00000000-0000-0000-0000-000000000000)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual(['/docs/space-1?doc=00000000-0000-0000-0000-000000000000']);
    });

    it('matches /docs/...?doc=... case-insensitively for the path pattern', () => {
      // Doc link regex is case-insensitive for the /docs/ prefix
      const content = 'See [doc](/DOCS/space-1?doc=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    // ── L1-② Relative .md path references ─────────────────

    it('marks valid .md path as not broken', () => {
      const content = 'See [arch](docs/architecture.md)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('marks missing .md path as broken', () => {
      const content = 'See [missing](docs/nonexistent.md)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual(['docs/nonexistent.md']);
    });

    it('strips #anchor before matching .md path', () => {
      const content = 'See [arch](docs/architecture.md#section-3)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('normalizes ./ prefix in .md paths', () => {
      const content = 'See [arch](./docs/architecture.md)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('normalizes ../ prefix in .md paths', () => {
      // From guides/ dir, ../PROJECT.md → PROJECT.md
      const content = 'See [project](../PROJECT.md)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('normalizes multiple ../ prefixes', () => {
      // ../../PROJECT.md → PROJECT.md
      const content = 'See [project](../../PROJECT.md)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(1);
      expect(result.broken).toEqual([]);
    });

    it('skips non-.md relative paths (v1 no-op)', () => {
      const content = 'See [image](assets/diagram.png)';
      const result = computeLinkHealth(content, candidates);
      // Non-.md paths are not checked in v1 — they don't count toward total or broken
      expect(result.total).toBe(0);
      expect(result.broken).toEqual([]);
    });

    // ── Dedup + mixed ────────────────────────────────────

    it('deduplicates broken hrefs (keeps first occurrence order)', () => {
      const content =
        'See [A](/docs/space-1?doc=00000000-0000-0000-0000-000000000000) and [A](/docs/space-1?doc=00000000-0000-0000-0000-000000000000)';
      const result = computeLinkHealth(content, candidates);
      // total 与 broken 均按唯一链接计（重复 href 只判定一次）
      expect(result.total).toBe(1);
      expect(result.broken).toEqual(['/docs/space-1?doc=00000000-0000-0000-0000-000000000000']);
    });

    it('handles mix of valid, broken, and skipped links', () => {
      const content = [
        'See [valid-doc](/docs/space-1?doc=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)',
        'See [broken-doc](/docs/space-1?doc=00000000-0000-0000-0000-000000000000)',
        'See [valid-md](docs/architecture.md)',
        'See [broken-md](docs/oops.md)',
        'See [external](https://example.com)',
        'See [mail](mailto:a@b.com)',
      ].join('\n');

      const result = computeLinkHealth(content, candidates);
      // Only 4 links counted (external + mailto skipped)
      expect(result.total).toBe(4);
      expect(result.broken).toEqual([
        '/docs/space-1?doc=00000000-0000-0000-0000-000000000000',
        'docs/oops.md',
      ]);
    });

    it('always sets checkedAt to an ISO date string', () => {
      const result = computeLinkHealth('no links', candidates);
      expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('returns empty broken array when all links are valid', () => {
      const content = '[A](docs/architecture.md) and [B](/docs/space-1?doc=11111111-2222-3333-4444-555555555555)';
      const result = computeLinkHealth(content, candidates);
      expect(result.total).toBe(2);
      expect(result.broken).toEqual([]);
    });
  });
});
