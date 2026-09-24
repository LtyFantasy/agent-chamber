import {
  INVALID_PATH_DIR,
  buildHumanExportEntries,
  humanExportDownloadName,
  sanitizeDocPath,
  sanitizeFileName,
  zipRootName,
} from './doc-human-export';
import type { HumanExportReadmeTexts } from './doc-human-export';
import { bundleDownloadName } from './doc-bundle';
import type { DocSpaceExportBundle } from '@/types';
import zhCN from '@/i18n/messages/zh-CN.json';
import en from '@/i18n/messages/en.json';

/** 日期夹具（UTC，与 JSON 侧命名测试同日） */
const DATE = new Date('2026-09-15T12:34:56Z');

/**
 * 取某语言的 README 文案（真实 i18n JSON 而非测试内硬编码文案——
 * 断言覆盖的是**线上实际会渲染**的字符串，键名漂移会被本文件立刻发现）。
 */
function readmeTextsOf(messages: unknown): HumanExportReadmeTexts {
  return (messages as { docs: { bundle: { export: { readme: HumanExportReadmeTexts } } } }).docs
    .bundle.export.readme;
}

const zhTexts = readmeTextsOf(zhCN);
const enTexts = readmeTextsOf(en);

/** 附件原文件字节夹具（PNG magic + 尾巴，覆盖 base64 往返与高位字节） */
const ATT_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 200, 255]);
const ATT_BASE64 = Buffer.from(ATT_BYTES).toString('base64');

/** media 完整项夹具（形状权威 = backend doc-bundle.service.ts:188-204） */
function mediaItem(overrides: Record<string, unknown> = {}) {
  return {
    sourceAttachmentId: 'att-1',
    docPath: 'docs/a.md',
    originalName: 'photo.png',
    mimeType: 'image/png',
    sizeBytes: ATT_BYTES.length,
    sha256: 'a'.repeat(64),
    contentBase64: ATT_BASE64,
    ...overrides,
  };
}

/**
 * 夹具文档条项：web 契约类型只声明 `path`（D7 刻意不收窄——回导侧原样透传），
 * 而导出侧实际还带 `docId` / `content`（ZIP 装配要读），故夹具在此补全真实形状。
 */
type FixtureDoc = { path: string; docId?: string; content?: string };

/** 夹具 overrides（docs 用 FixtureDoc，其余沿用公开类型） */
type FixtureOverrides = Omit<Partial<DocSpaceExportBundle>, 'docs'> & { docs?: FixtureDoc[] };

/** bundle 夹具（docs[].content 用上传后插入正文的真实形态：`![alt](/api/v1/attachments/<id>/content)`） */
function bundleFixture(overrides: FixtureOverrides = {}): DocSpaceExportBundle {
  return {
    formatVersion: 2,
    exportedAt: '2026-09-15T00:00:00Z',
    space: { name: 'Test Space', visibility: 'open' },
    docs: [],
    media: [],
    mediaOmitted: [],
    ...overrides,
  } as DocSpaceExportBundle;
}

/** 装配快捷入口（默认 zh 文案 + DATE） */
function build(bundle: DocSpaceExportBundle, date: Date = DATE) {
  return buildHumanExportEntries(bundle, { texts: zhTexts, spaceId: 'space-1', date });
}

/** 取 ZIP 条目文本（手写 UTF-8 的解码用 Buffer 反查，保证与 Node 口径逐字节可比） */
function textOf(files: Record<string, Uint8Array>, key: string): string {
  const bytes = files[key];
  expect(bytes).toBeDefined();
  return Buffer.from(bytes).toString('utf8');
}

const ROOT = 'docspace-test-space-2026-09-15';

describe('sanitizeFileName', () => {
  it('去路径分隔符与控制字符（防解压建目录 / 目录穿越）', () => {
    expect(sanitizeFileName('../../etc/passwd.png')).toBe('....etcpasswd.png');
    expect(sanitizeFileName('a\\b/c.png')).toBe('abc.png');
    expect(sanitizeFileName('bad\u0000name\u001f.png')).toBe('badname.png');
  });

  it('空名 / 全分隔符 → 占位名（不产出空文件名段）', () => {
    expect(sanitizeFileName('')).toBe('attachment');
    expect(sanitizeFileName('///')).toBe('attachment');
    expect(sanitizeFileName('   ')).toBe('attachment');
  });

  it('保留中文与空格（不编码，链接侧才做最少转义）', () => {
    expect(sanitizeFileName('架构 图.png')).toBe('架构 图.png');
  });
});

describe('sanitizeDocPath', () => {
  it('合法 path 原样保留（仅去开头 `/`），目录树形态不变', () => {
    expect(sanitizeDocPath('docs/sub/a.md')).toEqual({ path: 'docs/sub/a.md', invalid: false });
    expect(sanitizeDocPath('/DEPLOY.md')).toEqual({ path: 'DEPLOY.md', invalid: false });
  });

  it('`..` 段判非法 → __invalid-path__/<docId前8>-<basename>', () => {
    expect(sanitizeDocPath('docs/../../etc/passwd', 'abcdefgh-1234')).toEqual({
      path: `${INVALID_PATH_DIR}/abcdefgh-passwd`,
      invalid: true,
    });
  });

  it('空段（`//` / 尾斜杠 / 空 path）判非法', () => {
    expect(sanitizeDocPath('docs//a.md', 'doc-1').invalid).toBe(true);
    expect(sanitizeDocPath('docs/a.md/', 'doc-1').invalid).toBe(true);
    expect(sanitizeDocPath('', 'doc-1')).toEqual({
      path: `${INVALID_PATH_DIR}/doc-1-attachment`,
      invalid: true,
    });
  });

  it('反斜杠与单段 `.` 判非法（`.`` 会变成 ZIP 目录条目，不是文件）', () => {
    expect(sanitizeDocPath('docs\\a.md', 'doc-1').invalid).toBe(true);
    expect(sanitizeDocPath('.', 'doc-1').invalid).toBe(true);
  });

  it('docId 缺席时仍产出可读文件名（不加空前缀）', () => {
    const result = sanitizeDocPath('../a.md');
    expect(result.path).toBe(`${INVALID_PATH_DIR}/a.md`);
    expect(result.invalid).toBe(true);
  });
});

describe('zipRootName / humanExportDownloadName', () => {
  it('slug 与 JSON 侧同法（同一 stem，仅扩展名不同）', () => {
    const jsonName = bundleDownloadName('My Space!!', 'space-1', DATE);
    expect(jsonName).toBe('docspace-my-space-2026-09-15.json');
    expect(humanExportDownloadName('My Space!!', 'space-1', DATE)).toBe(
      'docspace-my-space-2026-09-15.zip',
    );
    expect(zipRootName('My Space!!', 'space-1', DATE)).toBe(jsonName.replace(/\.json$/, ''));
  });

  it('纯中文空间名 slug 退化为空 → 回退 spaceId 前 8 位', () => {
    expect(humanExportDownloadName('中文空间', 'abcd1234-0000', DATE)).toBe(
      'docspace-abcd1234-2026-09-15.zip',
    );
  });
});

describe('buildHumanExportEntries 目录树与字节', () => {
  it('docs path 原样落在根目录下；附件进 attachments/（shortId8 前缀防重名）', () => {
    const { files, stats, rootName } = build(
      bundleFixture({
        docs: [{ path: 'DEPLOY.md' }, { path: 'docs/a.md' }, { path: 'memory/2026-09-15.md' }],
        media: [mediaItem()],
      }),
    );

    expect(rootName).toBe(ROOT);
    expect(Object.keys(files).sort()).toEqual([
      `${ROOT}/DEPLOY.md`,
      `${ROOT}/README.md`,
      `${ROOT}/attachments/att-1-photo.png`,
      `${ROOT}/docs/a.md`,
      `${ROOT}/memory/2026-09-15.md`,
    ]);
    expect(stats).toMatchObject({ docs: 3, attachments: 1, skipped: 0, omitted: 0 });
  });

  it('ZIP 内所有键都在同一根目录前缀下（防解压散落）', () => {
    const { files } = build(bundleFixture({ docs: [{ path: 'docs/a.md' }], media: [mediaItem()] }));
    for (const key of Object.keys(files)) expect(key.startsWith(`${ROOT}/`)).toBe(true);
  });

  it('base64 → 字节逐字节还原（含高位字节）', () => {
    const { files } = build(bundleFixture({ media: [mediaItem()] }));
    expect(Array.from(files[`${ROOT}/attachments/att-1-photo.png`])).toEqual(Array.from(ATT_BYTES));
  });

  it('正文文本按 UTF-8 编码（与 Node 口径逐字节一致，jsdom 无 TextEncoder）', () => {
    const content = '# 标题\n\n中文正文 with émoji 🚀\n';
    const { files } = build(bundleFixture({ docs: [{ path: 'docs/a.md', content }] }));
    expect(files[`${ROOT}/docs/a.md`]).toEqual(new Uint8Array(Buffer.from(content, 'utf8')));
  });

  it('R5 零值：0 文档 → 仅 README；0 附件 → 不建 attachments/ 目录', () => {
    const empty = build(bundleFixture());
    expect(Object.keys(empty.files)).toEqual([`${ROOT}/README.md`]);
    expect(empty.stats).toMatchObject({ docs: 0, attachments: 0, rewrittenUrls: 0 });

    const docsOnly = build(bundleFixture({ docs: [{ path: 'a.md', content: 'x' }] }));
    expect(Object.keys(docsOnly.files).sort()).toEqual([`${ROOT}/README.md`, `${ROOT}/a.md`]);
    expect(Object.keys(docsOnly.files).some((key) => key.includes('attachments/'))).toBe(false);
  });

  it('缩略图不解出（B5：只处理 /content 引用与原文件）', () => {
    const { files } = build(
      bundleFixture({
        media: [
          mediaItem({
            thumbnail: {
              width: 1,
              height: 1,
              sizeBytes: 2,
              sha256: 'b'.repeat(64),
              contentBase64: 'AAA=',
            },
          }),
        ],
      }),
    );
    expect(Object.keys(files).some((key) => key.includes('thumbnail'))).toBe(false);
    expect(files[`${ROOT}/attachments/att-1-thumb.png`]).toBeUndefined();
  });
});

describe('buildHumanExportEntries 路径消毒与去重', () => {
  it('非法 path 改名收容，并逐条记录可对照的原路径', () => {
    const { files, stats } = build(
      bundleFixture({
        docs: [
          { path: '../escape.md', docId: 'abcdefgh-9999', content: '# x' },
          { path: 'docs/ok.md', docId: 'okokokok', content: '# ok' },
        ],
      }),
    );
    expect(stats.invalidPaths).toBe(1);
    expect(files[`${ROOT}/${INVALID_PATH_DIR}/abcdefgh-escape.md`]).toBeDefined();
    expect(files[`${ROOT}/docs/ok.md`]).toBeDefined();

    const readme = textOf(files, `${ROOT}/README.md`);
    expect(readme).toContain('../escape.md');
    expect(readme).toContain(`${INVALID_PATH_DIR}/abcdefgh-escape.md`);
  });

  it('消毒后重名（同 path 两篇）→ 追加 docId 前 8 位去重，内容不互相覆盖', () => {
    const { files, stats } = build(
      bundleFixture({
        docs: [
          { path: 'docs/a.md', docId: 'aaaaaaaa-1', content: 'first' },
          { path: 'docs/a.md', docId: 'bbbbbbbb-2', content: 'second' },
        ],
      }),
    );
    expect(stats.deduped).toBe(1);
    expect(textOf(files, `${ROOT}/docs/a.md`)).toBe('first');
    expect(textOf(files, `${ROOT}/docs/a-bbbbbbbb.md`)).toBe('second');
  });

  it('文档 path 恰为根 README.md → 改名让位，导出说明不被覆盖', () => {
    const { files, stats } = build(
      bundleFixture({ docs: [{ path: 'README.md', docId: 'cccccccc-3', content: '# 空间自述' }] }),
    );
    expect(stats.deduped).toBe(1);
    expect(textOf(files, `${ROOT}/README-cccccccc.md`)).toBe('# 空间自述');
    expect(textOf(files, `${ROOT}/README.md`)).toContain('回导请使用');
  });
});

describe('buildHumanExportEntries 正文附件 URL 相对化', () => {
  /** 三种 URL 形态（R1）：带 API 前缀的相对 / 裸 /attachments/ / 绝对 URL（均可带 query） */
  const urlForms = [
    (id: string) => `/api/v1/attachments/${id}/content`,
    (id: string) => `/attachments/${id}/content`,
    (id: string) => `https://platform.example.com/api/v1/attachments/${id}/content`,
    (id: string) => `/api/v1/attachments/${id}/content?token=abc&v=2`,
  ];

  /**
   * 三种目录深度（R2）：根目录文档 → `attachments/...`；
   * 一级 `docs/a.md` → `../attachments/...`；二级 `docs/sub/a.md` → `../../attachments/...`。
   */
  const depths = [
    { docPath: 'DEPLOY.md', expected: 'attachments/att-1-photo.png' },
    { docPath: 'docs/a.md', expected: '../attachments/att-1-photo.png' },
    { docPath: 'docs/sub/a.md', expected: '../../attachments/att-1-photo.png' },
  ];

  for (const form of urlForms) {
    for (const depth of depths) {
      it(`重写 ${form('att-1')}（文档位于 ${depth.docPath}）`, () => {
        const content = `![photo.png](${form('att-1')})`;
        const { files, stats } = build(
          bundleFixture({
            docs: [{ path: depth.docPath, content }],
            media: [mediaItem()],
          }),
        );
        expect(textOf(files, `${ROOT}/${depth.docPath}`)).toBe(`![photo.png](${depth.expected})`);
        expect(stats.rewrittenUrls).toBe(1);
      });
    }
  }

  it('URL 未在配对表内（未打包）→ 保留原样，不制造死链', () => {
    const content = '![x](/api/v1/attachments/att-other/content)';
    const { files, stats } = build(
      bundleFixture({ docs: [{ path: 'docs/a.md', content }], media: [mediaItem()] }),
    );
    expect(textOf(files, `${ROOT}/docs/a.md`)).toBe(content);
    expect(stats.rewrittenUrls).toBe(0);
  });

  it('skipped / mediaOmitted 项保留原 URL（R3）', () => {
    const content =
      '![skip](/api/v1/attachments/att-skip/content)\n![omitted](/api/v1/attachments/att-omit/content)';
    const { files, stats } = build(
      bundleFixture({
        docs: [{ path: 'docs/a.md', content }],
        media: [
          mediaItem(),
          {
            skipped: 'too_large',
            sourceAttachmentId: 'att-skip',
            docPath: 'docs/a.md',
            originalName: 'big.zip',
            sizeBytes: 123456,
          },
        ],
        mediaOmitted: [{ docPath: 'docs/a.md', attachmentId: 'att-omit', reason: 'topic_bound' }],
      }),
    );
    expect(textOf(files, `${ROOT}/docs/a.md`)).toBe(content);
    expect(stats).toMatchObject({ skipped: 1, omitted: 1, rewrittenUrls: 0, attachments: 1 });
  });

  it('`/public/attachments/...` 签名 URL 与 `/thumbnail` 引用一律不重写（R3）', () => {
    const content = [
      '![signed](/public/attachments/att-1/content?token=expired)',
      '![thumb](/api/v1/attachments/att-1/thumbnail)',
      '![api-thumb](/attachments/att-1/thumbnail)',
    ].join('\n');
    const { files, stats } = build(
      bundleFixture({ docs: [{ path: 'docs/a.md', content }], media: [mediaItem()] }),
    );
    expect(textOf(files, `${ROOT}/docs/a.md`)).toBe(content);
    expect(stats.rewrittenUrls).toBe(0);
  });

  it('正文里的纯文本提及（非图片语法）同样按 URL 重写（配对表内 id）', () => {
    const { files } = build(
      bundleFixture({
        docs: [
          { path: 'docs/a.md', content: '见 https://host/api/v1/attachments/att-1/content 。' },
        ],
        media: [mediaItem()],
      }),
    );
    expect(textOf(files, `${ROOT}/docs/a.md`)).toBe('见 ../attachments/att-1-photo.png 。');
  });

  it('正文以 URL 开头（行首形态，无前置字符）也能重写', () => {
    const { files, stats } = build(
      bundleFixture({
        docs: [{ path: 'a.md', content: '/api/v1/attachments/att-1/content' }],
        media: [mediaItem()],
      }),
    );
    expect(textOf(files, `${ROOT}/a.md`)).toBe('attachments/att-1-photo.png');
    expect(stats.rewrittenUrls).toBe(1);
  });

  it('同一 URL 多次出现 → 全部重写并计数', () => {
    const content = '![a](/api/v1/attachments/att-1/content) ![b](/attachments/att-1/content)';
    const { files, stats } = build(
      bundleFixture({ docs: [{ path: 'docs/a.md', content }], media: [mediaItem()] }),
    );
    expect(textOf(files, `${ROOT}/docs/a.md`)).toBe(
      '![a](../attachments/att-1-photo.png) ![b](../attachments/att-1-photo.png)',
    );
    expect(stats.rewrittenUrls).toBe(2);
  });

  it('附件名含空格 / 圆括号 → 链接内最少转义（ZIP 内文件名保持原样）', () => {
    const { files } = build(
      bundleFixture({
        docs: [{ path: 'docs/a.md', content: '![p](/api/v1/attachments/att-1/content)' }],
        media: [mediaItem({ originalName: 'my photo(1).png' })],
      }),
    );
    expect(files[`${ROOT}/attachments/att-1-my photo(1).png`]).toBeDefined();
    expect(textOf(files, `${ROOT}/docs/a.md`)).toBe(
      '![p](../attachments/att-1-my%20photo%281%29.png)',
    );
  });

  it('附件 originalName 含路径分隔符 → 文件名消毒（不产出子目录 / 穿越）', () => {
    const { files } = build(
      bundleFixture({
        docs: [{ path: 'a.md' }],
        media: [mediaItem({ originalName: '../evil.png' })],
      }),
    );
    expect(files[`${ROOT}/attachments/att-1-..evil.png`]).toBeDefined();
  });
});

describe('buildHumanExportEntries 媒体条项容错（全函数）', () => {
  it('形状可疑 / base64 非法的条项跳过并计数，不抛异常', () => {
    expect(() =>
      build(
        bundleFixture({
          docs: [{ path: 'docs/a.md' }],
          media: [
            null,
            'not-an-object',
            { sourceAttachmentId: 'att-2' },
            mediaItem({ sourceAttachmentId: 'att-3', contentBase64: '@@@not-base64@@@' }),
          ] as never,
        }),
      ),
    ).not.toThrow();

    const { stats, files } = build(
      bundleFixture({
        docs: [{ path: 'docs/a.md' }],
        media: [
          null,
          { sourceAttachmentId: 'att-2' },
          mediaItem({ sourceAttachmentId: 'att-3', contentBase64: '@@@not-base64@@@' }),
        ] as never,
      }),
    );
    expect(stats).toMatchObject({ attachments: 0, invalidMedia: 3, skipped: 0 });
    expect(Object.keys(files).some((key) => key.includes('attachments/'))).toBe(false);
  });

  it('文档条项缺 path / 非对象 → 跳过（不产出无名条目）', () => {
    const { files, stats } = build(bundleFixture({ docs: [{ path: '' }, null, 'x'] as never }));
    expect(stats.docs).toBe(0);
    expect(Object.keys(files)).toEqual([`${ROOT}/README.md`]);
  });

  it('媒体 id 前 8 位 + 同名 → 去重不覆盖字节', () => {
    const other = new Uint8Array([1, 2, 3]);
    const { files, stats } = build(
      bundleFixture({
        media: [
          mediaItem({ sourceAttachmentId: 'dupid123-aaaa' }),
          mediaItem({
            sourceAttachmentId: 'dupid123-bbbb',
            contentBase64: Buffer.from(other).toString('base64'),
          }),
        ],
      }),
    );
    expect(stats.deduped).toBe(1);
    expect(Array.from(files[`${ROOT}/attachments/dupid123-photo.png`])).toEqual(
      Array.from(ATT_BYTES),
    );
    expect(Object.values(files).some((bytes) => bytes.length === other.length)).toBe(true);
  });
});

describe('README', () => {
  it('含空间名 / 导出时间 ISO / 计数 / 回导指引（明示本 ZIP 不可回导）', () => {
    const readme = textOf(
      build(
        bundleFixture({
          docs: [{ path: 'docs/a.md', content: 'x' }],
          media: [mediaItem()],
        }),
      ).files,
      `${ROOT}/README.md`,
    );

    expect(readme).toContain('Test Space');
    expect(readme).toContain(DATE.toISOString());
    expect(readme).toContain('文档：1 篇');
    expect(readme).toContain('附件原文件：1 个');
    expect(readme).toContain('不可回导');
    expect(readme).toContain('导出 bundle（JSON）');
  });

  it('零值形态：0 篇 0 附件也给出计数行，且不出未打包 / 链接说明行（R5）', () => {
    const readme = textOf(build(bundleFixture()).files, `${ROOT}/README.md`);
    expect(readme).toContain('文档：0 篇');
    expect(readme).toContain('附件原文件：0 个');
    expect(readme).not.toContain('未打包的附件');
    expect(readme).not.toContain('改写为相对路径');
    expect(readme).not.toContain('路径异常');
  });

  it('skipped + mediaOmitted + 非法媒体合计一行提示（联网仍可访问）', () => {
    const readme = textOf(
      build(
        bundleFixture({
          docs: [{ path: 'docs/a.md', content: 'x' }],
          media: [
            {
              skipped: 'budget_exceeded',
              sourceAttachmentId: 'att-skip',
              docPath: 'docs/a.md',
              originalName: 'big.zip',
              sizeBytes: 1,
            },
            { sourceAttachmentId: 'att-broken' } as never,
          ],
          mediaOmitted: [{ docPath: 'docs/a.md', attachmentId: 'att-omit', reason: 'topic_bound' }],
        }),
      ).files,
      `${ROOT}/README.md`,
    );
    expect(readme).toContain('未打包的附件：3 个');
    expect(readme).toContain('联网仍可访问');
  });

  it('英语 locale 注入 → 整份 README 英文（lib 不依赖 next-intl）', () => {
    const result = buildHumanExportEntries(
      bundleFixture({ docs: [{ path: 'docs/a.md', content: 'x' }] }),
      { texts: enTexts, spaceId: 'space-1', date: DATE },
    );
    const readme = textOf(result.files, `${ROOT}/README.md`);
    expect(readme).toContain('Documents: 1');
    expect(readme).toContain('cannot be imported back');
    expect(readme).toContain('Export bundle (JSON)');
  });
});

describe('i18n 文案表（zh-CN / en 键集一致）', () => {
  const MENU_KEYS = ['trigger', 'jsonLabel', 'jsonDesc', 'zipLabel', 'zipDesc'];
  const README_KEYS = [
    'title',
    'exportedAt',
    'docs',
    'attachments',
    'unpacked',
    'linksRewritten',
    'invalidTitle',
    'invalidHint',
    'invalidItem',
    'restoreHint',
  ];

  type ExportNamespace = {
    zipFailed: string;
    menu: Record<string, string>;
    readme: Record<string, string>;
  };
  const zhExport = (zhCN as unknown as { docs: { bundle: { export: ExportNamespace } } }).docs
    .bundle.export;
  const enExport = (en as unknown as { docs: { bundle: { export: ExportNamespace } } }).docs.bundle
    .export;

  it('menu 段键集两侧一致且非空', () => {
    for (const locale of [zhExport, enExport]) {
      expect(Object.keys(locale.menu).sort()).toEqual([...MENU_KEYS].sort());
      for (const key of MENU_KEYS) expect(locale.menu[key]).toBeTruthy();
      expect(locale.zipFailed).toBeTruthy();
    }
  });

  it('readme 段键集两侧一致且非空（含 README 模板占位符）', () => {
    for (const locale of [zhExport, enExport]) {
      expect(Object.keys(locale.readme).sort()).toEqual([...README_KEYS].sort());
      for (const key of README_KEYS) expect(locale.readme[key]).toBeTruthy();
    }
    expect(zhExport.readme.title).toContain('%space%');
    expect(zhExport.readme.exportedAt).toContain('%time%');
    expect(zhExport.readme.docs).toContain('%count%');
    expect(zhExport.readme.unpacked).toContain('%count%');
    expect(zhExport.readme.invalidItem).toContain('%from%');
    expect(enExport.readme.title).toContain('%space%');
    expect(enExport.readme.invalidItem).toContain('%from%');
  });

  it('菜单文案直白化（R6）：JSON 项说明含"完整快照/回导"，ZIP 项不含"回导"暗示（R7）', () => {
    expect(zhExport.menu.jsonDesc).toContain('完整快照');
    expect(zhExport.menu.jsonDesc).toContain('回导');
    expect(zhExport.menu.zipDesc).not.toContain('回导');
    expect(enExport.menu.jsonDesc).toContain('Full snapshot');
    expect(enExport.menu.jsonDesc).toContain('restorable');
    expect(enExport.menu.zipDesc).not.toContain('restor');
    // README 回导指引必须明示"本 ZIP 不可回导"，且指向 JSON 导出
    expect(zhExport.readme.restoreHint).toContain('不可回导');
    expect(zhExport.readme.restoreHint).toContain('JSON');
    expect(enExport.readme.restoreHint).toContain('cannot be imported back');
    expect(enExport.readme.restoreHint).toContain('JSON');
  });

  /**
   * HUMAN-ZIP-4 静态守卫（2026-09-15 Playwright 实证抓出）：README 文案先经 next-intl
   * （ICU MessageFormat）渲染——`{key}` 占位符会被 ICU 当参数，t() 不传 values 时
   * next-intl 返回**原始键名**（ZIP README 曾出现 `# docs.bundle.export.readme.title`
   * 字面量）。故 readme 文案**禁止花括号占位**，占位符一律 `%key%`。
   * 说明：jest 无法 import ESM 版 next-intl（既有组件测试一律 mock 它），真实链路
   * （t() → 注入 → 装配）归 Playwright 覆盖；此处守"防复发"的静态规则。
   */
  it('readme 文案禁止 ICU 花括号占位（HUMAN-ZIP-4）：占位符必须是 %key% 形态', () => {
    for (const locale of [zhExport, enExport]) {
      for (const value of Object.values(locale.readme)) {
        expect(value).not.toMatch(/\{\w+\}/);
      }
    }
    // 真实文案经真实 format() 装配后占位符必须替换干净（space/time/count 全触发）
    for (const texts of [zhTexts, enTexts]) {
      const result = buildHumanExportEntries(
        bundleFixture({ docs: [{ path: 'docs/a.md', content: 'x' }] }),
        { texts, spaceId: 'space-1', date: DATE },
      );
      const readme = textOf(result.files, `${ROOT}/README.md`);
      expect(readme).toContain('Test Space');
      expect(readme).not.toContain('docs.bundle');
      expect(readme).not.toMatch(/%\w+%/);
    }
  });
});
