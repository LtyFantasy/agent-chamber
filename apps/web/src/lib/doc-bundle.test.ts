import {
  BUNDLE_BODY_MAX_BYTES,
  BUNDLE_ERROR_MESSAGE_KEYS,
  FILE_READ_GUARD_BYTES,
  bundleDownloadName,
  countMediaEntries,
  countOverwrite,
  isOverReadGuard,
  isSkippedMediaEntry,
  parseBundlePreview,
  serializedBodySize,
} from './doc-bundle';
import type { BundleErrorKey } from './doc-bundle';
import type { DocSpaceExportBundle } from '@/types';
import zhCN from '@/i18n/messages/zh-CN.json';
import en from '@/i18n/messages/en.json';

/** 构造一个体积恰为 size 字节的合法 bundle（pad 补齐；用于体积边界判定） */
function bundleOfExactSize(size: number): DocSpaceExportBundle {
  const bundle: DocSpaceExportBundle & { pad: string } = {
    formatVersion: 2,
    space: { name: 'S' },
    docs: [],
    pad: '',
  };
  bundle.pad = 'a'.repeat(size - serializedBodySize(bundle));
  return bundle;
}

describe('doc-bundle 常量与体积口径', () => {
  it('BUNDLE_BODY_MAX_BYTES = 10MiB（与后端 DOC_BUNDLE_MAX_BYTES 同口径，不二次扣 64KiB 余量）', () => {
    expect(BUNDLE_BODY_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('serializedBodySize = 紧凑 JSON 的 UTF-8 字节数（无缩进）', () => {
    // axios 发的是紧凑 JSON：同一对象 pretty 打印后体积更大，不得作为判据
    expect(serializedBodySize({ a: 1 })).toBe(new Blob([JSON.stringify({ a: 1 })]).size);
    expect(serializedBodySize({ a: 1 })).toBeLessThan(
      new Blob([JSON.stringify({ a: 1 }, null, 2)]).size,
    );
  });

  it('读取守卫：恰好 32MB 放行，超 1B 拒绝', () => {
    expect(isOverReadGuard(FILE_READ_GUARD_BYTES)).toBe(false);
    expect(isOverReadGuard(FILE_READ_GUARD_BYTES + 1)).toBe(true);
  });
});

describe('parseBundlePreview 预检', () => {
  it('合法 v1 包：通过且 media 计数全 0（v1 无媒体段）', () => {
    const result = parseBundlePreview(
      JSON.stringify({ formatVersion: 1, space: { name: 'S' }, docs: [{ path: 'a.md' }] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual({
      categories: 0,
      routes: 0,
      docs: 1,
      media: 0,
      mediaSkipped: 0,
      mediaOmitted: 0,
    });
  });

  it('合法 v2 包：五段计数正确，media 拆「完整项 / skipped 标记」', () => {
    const result = parseBundlePreview(
      JSON.stringify({
        formatVersion: 2,
        space: { name: 'S' },
        categories: [{ name: 'c1' }, { name: 'c2' }],
        routes: [{ intent: 'r1' }],
        docs: [{ path: 'a.md' }, { path: 'b.md' }],
        media: [
          { docPath: 'a.md', originalName: 'i.png', contentBase64: 'AA==' },
          { skipped: 'too_large', docPath: 'b.md', originalName: 'big.png' },
          { skipped: 'budget_exceeded', docPath: 'b.md', originalName: 'b2.png' },
        ],
        mediaOmitted: [{ docPath: 'a.md', attachmentId: 'x', reason: 'topic_bound' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual({
      categories: 2,
      routes: 1,
      docs: 2,
      media: 1,
      mediaSkipped: 2,
      mediaOmitted: 1,
    });
  });

  it('docs 缺席 = 合法的 0 篇包（服务端 DTO 可选，不得判非法）', () => {
    const result = parseBundlePreview(JSON.stringify({ formatVersion: 2, space: { name: 'S' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts.docs).toBe(0);
    expect(result.bundle.docs).toBeUndefined();
  });

  it('非 JSON → invalidJson', () => {
    expect(parseBundlePreview('not json {')).toEqual({ ok: false, errorKey: 'invalidJson' });
  });

  it('顶层非对象（数组/标量）→ missingSpace（既非 bundle 也谈不上缺字段）', () => {
    expect(parseBundlePreview('[]')).toEqual({ ok: false, errorKey: 'missingSpace' });
    expect(parseBundlePreview('"abc"')).toEqual({ ok: false, errorKey: 'missingSpace' });
  });

  it('formatVersion=3 → unsupportedVersion；缺席同样不在值域', () => {
    expect(parseBundlePreview(JSON.stringify({ formatVersion: 3, space: { name: 'S' } }))).toEqual({
      ok: false,
      errorKey: 'unsupportedVersion',
    });
    expect(parseBundlePreview(JSON.stringify({ space: { name: 'S' } }))).toEqual({
      ok: false,
      errorKey: 'unsupportedVersion',
    });
  });

  it('缺 space.name（空串 / 非字符串 / 整个 space 缺席）→ missingSpace', () => {
    const cases = [
      { formatVersion: 2, space: {} },
      { formatVersion: 2, space: { name: '   ' } },
      { formatVersion: 2, space: { name: 123 } },
      { formatVersion: 2 },
    ];
    for (const c of cases) {
      expect(parseBundlePreview(JSON.stringify(c))).toEqual({
        ok: false,
        errorKey: 'missingSpace',
      });
    }
  });

  it('docs 存在但非数组 → docsNotArray', () => {
    expect(
      parseBundlePreview(JSON.stringify({ formatVersion: 2, space: { name: 'S' }, docs: {} })),
    ).toEqual({ ok: false, errorKey: 'docsNotArray' });
  });

  it('docs 含非法条项（null / 标量 / 缺 path / 空 path）→ docsNotArray，不抛异常', () => {
    const cases = [
      [null],
      [123],
      ['x'],
      [{}],
      [{ path: 123 }],
      [{ path: '' }],
      [{}, { path: 'a.md' }],
    ];
    for (const docs of cases) {
      expect(
        parseBundlePreview(JSON.stringify({ formatVersion: 2, space: { name: 'S' }, docs })),
      ).toEqual({ ok: false, errorKey: 'docsNotArray' });
    }
  });

  it('media 含非对象条项 → 不抛异常，且不计入 items / skipped 任一枚举桶', () => {
    const result = parseBundlePreview(
      JSON.stringify({
        formatVersion: 2,
        space: { name: 'S' },
        docs: [{ path: 'a.md' }],
        media: [null, 123, 'x', [], { docPath: 'a.md' }, { skipped: 'too_large' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 仅「对象且无 skipped」计完整项、「有 skipped」计跳过项；null/标量/数组一律不计
    expect(result.counts.media).toBe(1);
    expect(result.counts.mediaSkipped).toBe(1);
  });

  it('全函数契约：任意文本输入都不抛异常', () => {
    const inputs = [
      '',
      'null',
      '0',
      '"x"',
      '[]',
      '[null]',
      '{"formatVersion":2,"space":{"name":"S"},"docs":[null],"media":[null]}',
      '{"formatVersion":2,"space":{"name":"S"},"media":{"a":1}}',
      '{"formatVersion":2,"space":{"name":"S"},"categories":[null],"routes":[null]}',
      '{"formatVersion":1,"space":{"name":"S"},"mediaOmitted":[null]}',
    ];
    for (const input of inputs) {
      expect(() => parseBundlePreview(input)).not.toThrow();
    }
  });

  it('体积边界：恰好 10MiB 放行，超 1B → tooLarge（紧凑 JSON 口径）', () => {
    const exact = bundleOfExactSize(BUNDLE_BODY_MAX_BYTES);
    expect(serializedBodySize(exact)).toBe(BUNDLE_BODY_MAX_BYTES);
    const okResult = parseBundlePreview(JSON.stringify(exact));
    expect(okResult.ok).toBe(true);

    const over = bundleOfExactSize(BUNDLE_BODY_MAX_BYTES + 1);
    expect(parseBundlePreview(JSON.stringify(over))).toEqual({ ok: false, errorKey: 'tooLarge' });
  });
});

describe('errorKey 六键与文案表一一对应', () => {
  const EXPECTED: BundleErrorKey[] = [
    'fileTooLargeToRead',
    'tooLarge',
    'invalidJson',
    'missingSpace',
    'unsupportedVersion',
    'docsNotArray',
  ];

  const zhErrors = (zhCN as { docs: { bundle: { errors: Record<string, string> } } }).docs.bundle
    .errors;
  const enErrors = (en as { docs: { bundle: { errors: Record<string, string> } } }).docs.bundle
    .errors;

  it('三个来源（errorKey 值域 / 文案表 / 双语 JSON）键集完全一致', () => {
    expect(Object.keys(BUNDLE_ERROR_MESSAGE_KEYS).sort()).toEqual([...EXPECTED].sort());
    expect(Object.keys(zhErrors).sort()).toEqual([...EXPECTED].sort());
    expect(Object.keys(enErrors).sort()).toEqual([...EXPECTED].sort());
  });

  it('每个 errorKey 有非空双语文案，且表内 key = errors.{errorKey}', () => {
    for (const key of EXPECTED) {
      expect(BUNDLE_ERROR_MESSAGE_KEYS[key]).toBe(`errors.${key}`);
      expect(zhErrors[key]).toBeTruthy();
      expect(enErrors[key]).toBeTruthy();
    }
  });

  it('超限文案不指向回导端点（那条路同样 413）', () => {
    expect(zhErrors.tooLarge).not.toContain('import-bundle');
    expect(enErrors.tooLarge).not.toContain('import-bundle');
    expect(zhErrors.tooLarge).toContain('10MiB');
  });
});

describe('bundleDownloadName', () => {
  const date = new Date('2026-09-15T12:34:56Z');

  it('英文名折叠为 kebab-case slug', () => {
    expect(bundleDownloadName('My Space!!', 'abcd1234-0000-0000-0000-000000000000', date)).toBe(
      'docspace-my-space-2026-09-15.json',
    );
  });

  it('纯中文名 slug 退化为空 → 回退 spaceId 前 8 位', () => {
    expect(bundleDownloadName('中文空间', 'abcd1234-0000-0000-0000-000000000000', date)).toBe(
      'docspace-abcd1234-2026-09-15.json',
    );
  });

  it('首尾符号折叠后不留连字符', () => {
    expect(bundleDownloadName('--Hello--', 'abcdefgh', date)).toBe(
      'docspace-hello-2026-09-15.json',
    );
  });
});

describe('countOverwrite', () => {
  it('交集计数（仅统计 bundle path 命中已有 path 的条数）', () => {
    const docs = [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }];
    expect(countOverwrite(docs, ['b.md', 'c.md', 'zz.md'])).toBe(2);
  });

  it('docs 缺席 / 空数组 → 0', () => {
    expect(countOverwrite(undefined, ['a.md'])).toBe(0);
    expect(countOverwrite([], ['a.md'])).toBe(0);
  });

  it('条项形状非法（null / 缺 path）→ 不抛异常，跳过该条', () => {
    // 渲染期调用，不能依赖「预检已拦」这一前提
    const docs = [null, { path: 'a.md' }] as unknown as { path: string }[];
    expect(countOverwrite(docs, ['a.md'])).toBe(1);
    expect(countOverwrite([{}] as { path: string }[], ['a.md'])).toBe(0);
  });
});

describe('isSkippedMediaEntry / countMediaEntries', () => {
  it('非对象输入一律 false（裸 in 运算符会抛 TypeError）', () => {
    for (const value of [null, undefined, 123, 'x', true, [], Symbol('s')]) {
      expect(isSkippedMediaEntry(value)).toBe(false);
    }
    expect(isSkippedMediaEntry({ skipped: 'too_large' })).toBe(true);
  });

  it('countMediaEntries：非数组 → 全 0；混合数组按对象且有无 skipped 分桶', () => {
    expect(countMediaEntries(undefined)).toEqual({ items: 0, skipped: 0 });
    expect(countMediaEntries({ a: 1 })).toEqual({ items: 0, skipped: 0 });
    expect(
      countMediaEntries([null, 'x', [], { docPath: 'a' }, { skipped: 'budget_exceeded' }]),
    ).toEqual({
      items: 1,
      skipped: 1,
    });
  });
});
