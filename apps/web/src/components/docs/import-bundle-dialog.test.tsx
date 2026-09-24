import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportBundleDialog } from './import-bundle-dialog';
import type { ImportBundleDialogProps } from './import-bundle-dialog';
import { Api } from '@/lib/api';
import { confirm } from '@/lib/notify';
import { useNotificationStore } from '@/stores/notification.store';
import { Visibility } from '@/types';
import { FILE_READ_GUARD_BYTES } from '@/lib/doc-bundle';

/** docs.bundle 命名空间的英语文案快照（同 en.json；{k} 占位符按 values 替换） */
const messages: Record<string, string> = {
  'docs.bundle.cancel': 'Cancel',
  'docs.bundle.done': 'Done',
  'docs.bundle.backToSelect': 'Select another file',
  'docs.bundle.retry': 'Retry',
  'docs.bundle.dialog.title': 'Import a space bundle',
  'docs.bundle.dialog.description': 'A bundle is the platform full JSON export',
  'docs.bundle.dialog.selectFile': 'Choose bundle file',
  'docs.bundle.dialog.noFileHint': 'No file selected (.json)',
  'docs.bundle.dialog.importing': 'Importing... large spaces can take 1-2 minutes',
  'docs.bundle.dialog.importingHint': 'Do not close while importing',
  'docs.bundle.dialog.importingProgress': 'Importing...',
  'docs.bundle.errors.fileTooLargeToRead':
    'This file exceeds the 32 MB read limit and was not read',
  'docs.bundle.errors.tooLarge': 'This bundle exceeds the 10MiB request-body limit',
  'docs.bundle.errors.invalidJson': 'This file is not valid JSON and could not be parsed',
  'docs.bundle.errors.missingSpace': 'This file has no space information — not a valid bundle',
  'docs.bundle.errors.unsupportedVersion': 'Unsupported bundle version (only formatVersion 1 or 2)',
  'docs.bundle.errors.docsNotArray': 'This file is not a platform export bundle',
  'docs.bundle.visibility.open': 'Public',
  'docs.bundle.visibility.private': 'Private',
  'docs.bundle.preview.sourceMismatch':
    'Source space "{source}" differs from the current space "{target}"',
  'docs.bundle.preview.notDeleting': 'Import never deletes existing documents',
  'docs.bundle.preview.mediaBroken': '{count} media files were not packed',
  'docs.bundle.preview.emptyBundle': 'This bundle contains no documents',
  'docs.bundle.preview.coverageLoading': 'Checking what will be overwritten...',
  'docs.bundle.preview.coverageUnknown':
    'Could not verify the overwrite scope — use "Select another file" to try again',
  'docs.bundle.preview.coverageExact':
    '{total} documents will be written, {overwrite} of them overwriting existing content',
  'docs.bundle.preview.coverageAtLeast':
    '{total} documents will be written, overwriting at least {overwrite} (space has {spaceTotal} documents; only the first {checked} were checked)',
  'docs.bundle.preview.counts':
    'Categories {categories} · Routes {routes} · Docs {docs} · Media {media} (skipped {mediaSkipped}) · Unpacked attachments {mediaOmitted}',
  'docs.bundle.preview.source': 'Source space: {name}',
  'docs.bundle.preview.exportedAt': 'Exported at: {time}',
  'docs.bundle.preview.formatVersion': 'Format version: v{version}',
  'docs.bundle.preview.concurrency': 'If someone is editing the same document, their save wins',
  'docs.bundle.overwrite.label': 'Also overwrite space metadata',
  'docs.bundle.overwrite.scopeTitle': 'What will actually be written:',
  'docs.bundle.overwrite.scopeName': 'Name and legend (replaced wholesale)',
  'docs.bundle.overwrite.scopeSettings': 'settings replaced as a whole object',
  'docs.bundle.overwrite.scopeVisibility': "Visibility may be changed to the bundle's value",
  'docs.bundle.overwrite.visibilityChange': 'Visibility: currently {from} → after import {to}',
  'docs.bundle.overwrite.visibilityConfirmTitle': 'Space visibility will change',
  'docs.bundle.overwrite.visibilityConfirmDesc': 'Currently {from} → after import {to}. Continue?',
  'docs.bundle.overwrite.confirm': 'Confirm import',
  'docs.bundle.overwrite.confirmDanger': 'Confirm import (overwrite {overwrite})',
  'docs.bundle.overwrite.confirmDangerAtLeast': 'Confirm import (overwrite ≥{overwrite})',
  'docs.bundle.result.title': 'Import result',
  'docs.bundle.result.emptyDocs': 'This bundle contains no documents',
  'docs.bundle.result.docsSection': 'Documents',
  'docs.bundle.result.categoriesSection': 'Categories',
  'docs.bundle.result.routesSection': 'Routes',
  'docs.bundle.result.mediaSection': 'Media',
  'docs.bundle.result.spaceMetaSection': 'Space metadata',
  'docs.bundle.result.created': 'Created',
  'docs.bundle.result.updated': 'Updated',
  'docs.bundle.result.unchanged': 'Unchanged',
  'docs.bundle.result.failed': 'Failed',
  'docs.bundle.result.reused': 'Reused',
  'docs.bundle.result.skipped': 'Skipped',
  'docs.bundle.result.spaceMetaUpdated': 'Overwritten',
  'docs.bundle.result.spaceMetaSkipped': 'Not modified',
  'docs.bundle.result.failuresTitle': 'Failed items ({count})',
  'docs.bundle.result.failuresHint': 'Failed items appear as broken links',
  'docs.bundle.error.partialWarning':
    'The failure may have happened after some content was written',
  'docs.bundle.error.fallback': 'Import request failed',
};

jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    let text = messages[fullKey] ?? fullKey;
    if (values) {
      for (const [k, v] of Object.entries(values)) text = text.split(`{${k}}`).join(String(v));
    }
    return text;
  },
}));

jest.mock('@/lib/api', () => ({
  Api: {
    docs: {
      listDocs: jest.fn(),
      importSpaceBundle: jest.fn(),
    },
  },
}));

jest.mock('@/lib/notify', () => ({
  confirm: jest.fn(),
}));

const mockListDocs = Api.docs.listDocs as jest.Mock;
const mockImport = Api.docs.importSpaceBundle as jest.Mock;
const mockConfirm = confirm as jest.Mock;

/**
 * jsdom 的 File 未实现 text()（真实浏览器标准能力，产品代码用它读 bundle 文本）。
 * 测试环境按 Blob 语义补桩（FileReader 实现），使预检走真实读取路径而非降级分支。
 */
if (typeof File.prototype.text !== 'function') {
  Object.defineProperty(File.prototype, 'text', {
    configurable: true,
    value: function text(this: File): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    },
  });
}

/** listDocs 分页响应（预览态取已有 path 用） */
const paginated = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 100,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
  ...extra,
});
/** 合法 v2 bundle fixture（space.name 与 prop 同名，避免异名警示干扰） */
const bundleFixture = {
  formatVersion: 2,
  exportedAt: '2026-09-14T00:00:00Z',
  space: { name: 'Test Space', visibility: 'open' },
  categories: [{ name: 'c1' }],
  routes: [{ intent: 'r1' }],
  docs: [{ path: 'a.md' }, { path: 'b.md' }],
  media: [],
  mediaOmitted: [],
};

/** 回导结果 fixture（字段名逐一对照 doc-bundle.service.ts:226-283；数字取多位数避免断言歧义） */
const doneResult = {
  formatVersion: 2,
  importedAt: '2026-09-15T00:00:00Z',
  docs: {
    results: [{ path: 'a.md', status: 'failed', error: { message: 'doc boom' } }],
    summary: { total: 3, created: 13, updated: 14, unchanged: 15, failed: 1 },
  },
  categories: {
    results: [{ name: 'c1', status: 'created' }],
    summary: { total: 1, created: 23, updated: 0, failed: 0 },
  },
  routes: {
    results: [{ intent: 'r1', primaryDocPath: 'a.md', status: 'updated' }],
    summary: { total: 1, created: 33, updated: 0, failed: 0 },
  },
  media: {
    created: 43,
    reused: 44,
    skipped: 0,
    failed: [
      { docPath: 'x.md', originalName: null, reason: 'sha mismatch' },
      { docPath: 'y.md', originalName: 'photo.png', reason: 'quota exceeded' },
    ],
  },
  spaceMeta: { applied: false, status: 'skipped' },
};

function renderDialog(overrides: Partial<ImportBundleDialogProps> = {}) {
  const onOpenChange = jest.fn();
  const onImported = jest.fn();
  const view = render(
    <ImportBundleDialog
      spaceId="space-1"
      spaceName="Test Space"
      spaceVisibility={Visibility.OPEN}
      spaceDocCount={1}
      open
      onOpenChange={onOpenChange}
      onImported={onImported}
      {...overrides}
    />,
  );
  return { ...view, onOpenChange, onImported };
}

/** 选择 bundle 文件并等待预览态就绪（次级信息区的格式版本行） */
async function pickBundle(container: HTMLElement, bundle: unknown, name = 'bundle.json') {
  const file = new File([JSON.stringify(bundle)], name, { type: 'application/json' });
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files: [file] },
  });
  await screen.findByText(/Format version: v2/);
}

/** 选择原始文本文件（非法预检分支用） */
async function pickRawFile(container: HTMLElement, raw: string) {
  const file = new File([raw], 'bad.json', { type: 'application/json' });
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files: [file] },
  });
}

describe('ImportBundleDialog 预检拦截（零网络请求）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('读取守卫：>32MB 的文件不进入 file.text()，不发任何请求', async () => {
    const { container } = renderDialog();
    const file = new File(['{}'], 'huge.json', { type: 'application/json' });
    Object.defineProperty(file, 'size', { value: FILE_READ_GUARD_BYTES + 1 });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(
      await screen.findByText('This file exceeds the 32 MB read limit and was not read'),
    ).toBeInTheDocument();
    expect(mockListDocs).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
  });

  it.each([
    ['invalidJson', 'not json {', 'This file is not valid JSON and could not be parsed'],
    [
      'missingSpace',
      JSON.stringify({ formatVersion: 2 }),
      'This file has no space information — not a valid bundle',
    ],
    [
      'unsupportedVersion',
      JSON.stringify({ formatVersion: 9, space: { name: 'S' } }),
      'Unsupported bundle version (only formatVersion 1 or 2)',
    ],
    [
      'docsNotArray',
      JSON.stringify({ formatVersion: 2, space: { name: 'S' }, docs: {} }),
      'This file is not a platform export bundle',
    ],
  ])('%s：选择文件即拦截，文案命中且零请求', async (_key, raw, expected) => {
    const { container } = renderDialog();
    await pickRawFile(container, raw as string);

    expect(await screen.findByText(expected as string)).toBeInTheDocument();
    expect(mockListDocs).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('docs:[null] → 预检判非法并落可见错误态（不静默无响应）', async () => {
    const { container } = renderDialog();
    await pickRawFile(
      container,
      JSON.stringify({ formatVersion: 2, space: { name: 'S' }, docs: [null] }),
    );

    expect(
      await screen.findByText('This file is not a platform export bundle'),
    ).toBeInTheDocument();
    expect(mockListDocs).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('media:[null] → 不抛异常，仍进入预览态（非法项不计入计数）', async () => {
    mockListDocs.mockResolvedValue(paginated([{ path: 'a.md' }]));
    const { container } = renderDialog({ spaceDocCount: 1 });
    await pickBundle(container, {
      formatVersion: 2,
      space: { name: 'Test Space' },
      docs: [{ path: 'a.md' }],
      media: [null, { skipped: 'too_large' }],
    });

    // 仅 skipped 项计入断链警示；null 条项被忽略而非崩溃
    expect(await screen.findByText('1 media files were not packed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm import' })).toBeEnabled();
  });
});

describe('ImportBundleDialog 预览态影响面', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDocs.mockResolvedValue(paginated([{ path: 'a.md' }]));
  });

  it('精确覆盖篇数（docCount ≤ 已取数）：确认导入发紧凑 JSON 且不传 overwriteSpaceMeta', async () => {
    mockImport.mockResolvedValue(doneResult);
    const { container, onImported } = renderDialog({ spaceDocCount: 1 });
    await pickBundle(container, bundleFixture);

    expect(
      await screen.findByText(
        '2 documents will be written, 1 of them overwriting existing content',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));
    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));

    const [spaceId, body, overwrite] = mockImport.mock.calls[0];
    expect(spaceId).toBe('space-1');
    // 原样回传解析结果（不包装、不重新序列化）；axios 实际发出的即紧凑 JSON
    expect(body).toEqual(bundleFixture);
    expect(JSON.stringify(body)).not.toContain('\n');
    expect(overwrite).toBe(false);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('docCount > 已取数 → 覆盖篇数降级为下界（不报精确数）', async () => {
    const { container } = renderDialog({ spaceDocCount: 3 });
    await pickBundle(container, bundleFixture);

    expect(
      await screen.findByText(
        '2 documents will be written, overwriting at least 1 (space has 3 documents; only the first 1 were checked)',
      ),
    ).toBeInTheDocument();
  });

  it('已有 path 拉取失败 → 定性文案且确认按钮禁用（CTA 不携带未核实数字）', async () => {
    mockListDocs.mockRejectedValue(new Error('boom'));
    const { container } = renderDialog({ spaceDocCount: 1 });
    await pickBundle(container, bundleFixture);

    expect(
      await screen.findByText(
        'Could not verify the overwrite scope — use "Select another file" to try again',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
  });

  it('拉取失败 + 勾选 overwriteSpaceMeta → CTA 仍为无数字文案（不得把未知渲染成 0）', async () => {
    mockListDocs.mockRejectedValue(new Error('boom'));
    const { container } = renderDialog({ spaceDocCount: 1 });
    await pickBundle(container, bundleFixture);
    await screen.findByText(/Could not verify the overwrite scope/);

    fireEvent.click(screen.getByRole('checkbox'));

    const confirmButton = screen.getByRole('button', { name: 'Confirm import' });
    expect(confirmButton).toBeDisabled();
    // 危险变体仍在，但不出现任何计数
    expect(confirmButton).toHaveClass('bg-destructive');
    expect(screen.queryByText(/Confirm import \(overwrite/)).not.toBeInTheDocument();
  });

  it('来源空间异名 → amber 警示；media 未打包项 → 断链警示', async () => {
    const { container } = renderDialog();
    await pickBundle(container, {
      ...bundleFixture,
      space: { name: 'Other Space', visibility: 'open' },
      media: [{ skipped: 'too_large' }],
      mediaOmitted: [{ docPath: 'a.md', attachmentId: 'x', reason: 'topic_bound' }],
    });

    expect(
      await screen.findByText(
        'Source space "Other Space" differs from the current space "Test Space"',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('2 media files were not packed')).toBeInTheDocument();
  });

  it('空包（docs 缺席）→ 独立提示且不报覆盖数字，仍可确认导入', async () => {
    const { container } = renderDialog();
    await pickBundle(container, { formatVersion: 2, space: { name: 'Test Space' } });

    expect(await screen.findByText('This bundle contains no documents')).toBeInTheDocument();
    expect(screen.queryByText(/overwriting existing content/)).not.toBeInTheDocument();
    // 0 篇无可核对的覆盖数字 → 不因「未核实」禁用（空包可承载分类/路由，服务端 docs 可选）
    expect(screen.getByRole('button', { name: 'Confirm import' })).toBeEnabled();
  });
});

describe('ImportBundleDialog 危险区', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDocs.mockResolvedValue(paginated([{ path: 'a.md' }]));
  });

  it('勾选 overwriteSpaceMeta → 确认按钮切 danger 变体且文案带计数', async () => {
    const { container } = renderDialog({ spaceDocCount: 1 });
    await pickBundle(container, bundleFixture);

    fireEvent.click(screen.getByRole('checkbox'));

    const confirmButton = await screen.findByRole('button', {
      name: 'Confirm import (overwrite 1)',
    });
    expect(confirmButton).toHaveClass('bg-destructive');
    // 真实写范围逐条列出
    expect(screen.getByText('settings replaced as a whole object')).toBeInTheDocument();
    expect(screen.getByText("Visibility may be changed to the bundle's value")).toBeInTheDocument();
  });

  it('可见性变化 → confirm() 二次确认；取消则不发请求', async () => {
    mockConfirm.mockResolvedValue(false);
    const { container } = renderDialog({ spaceDocCount: 1, spaceVisibility: Visibility.OPEN });
    await pickBundle(container, {
      ...bundleFixture,
      space: { name: 'Test Space', visibility: 'private' },
    });

    fireEvent.click(screen.getByRole('checkbox'));
    expect(
      await screen.findByText('Visibility: currently Public → after import Private'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm import (overwrite 1)' }));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('可见性变化且确认 → 导入携带 overwriteSpaceMeta=true', async () => {
    mockConfirm.mockResolvedValue(true);
    mockImport.mockResolvedValue(doneResult);
    const { container } = renderDialog({ spaceDocCount: 1, spaceVisibility: Visibility.OPEN });
    await pickBundle(container, {
      ...bundleFixture,
      space: { name: 'Test Space', visibility: 'private' },
    });

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import (overwrite 1)' }));

    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    expect(mockImport.mock.calls[0][2]).toBe(true);
  });

  it('可见性不变时不起 confirm（防确认疲劳）', async () => {
    mockImport.mockResolvedValue(doneResult);
    const { container } = renderDialog({ spaceDocCount: 1, spaceVisibility: Visibility.OPEN });
    await pickBundle(container, bundleFixture);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import (overwrite 1)' }));

    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockImport.mock.calls[0][2]).toBe(true);
  });
});

describe('ImportBundleDialog 结果面板（真实字段）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDocs.mockResolvedValue(paginated([{ path: 'a.md' }]));
    mockImport.mockResolvedValue(doneResult);
  });

  async function importAndSettle() {
    const view = renderDialog({ spaceDocCount: 1 });
    await pickBundle(view.container, bundleFixture);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));
    await screen.findByText('Import result');
    return view;
  }

  it('五段按 API 字段渲染；categories/routes 无 unchanged 桶', async () => {
    await importAndSettle();

    // docs 四态
    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    // categories / routes 三态（created 值各自独立）
    expect(screen.getByText('23')).toBeInTheDocument();
    expect(screen.getByText('33')).toBeInTheDocument();
    // media = created / reused / skipped
    expect(screen.getByText('43')).toBeInTheDocument();
    expect(screen.getByText('44')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    // unchanged 只在 docs 段出现一次（categories/routes 不造该桶）
    expect(screen.getAllByText('Unchanged')).toHaveLength(1);
    // spaceMeta 默认 skipped
    expect(screen.getByText('Not modified')).toBeInTheDocument();
  });

  it('失败并集：docs=path、media=originalName ?? docPath，附重试按钮', async () => {
    await importAndSettle();

    expect(screen.getByText('Failed items (3)')).toBeInTheDocument();
    expect(screen.getByText('a.md')).toBeInTheDocument();
    expect(screen.getByText('— doc boom')).toBeInTheDocument();
    // originalName 为 null → 回退 docPath；有名字的用文件名
    expect(screen.getByText('x.md')).toBeInTheDocument();
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    expect(screen.getByText('— sha mismatch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('docs 段 0 篇 → 独立提示替代全 0 面板', async () => {
    mockImport.mockResolvedValue({
      ...doneResult,
      docs: {
        results: [],
        summary: { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 },
      },
    });
    await importAndSettle();

    expect(screen.getByText('This bundle contains no documents')).toBeInTheDocument();
    expect(screen.queryByText('Unchanged')).not.toBeInTheDocument();
  });

  it('spaceMeta 段防御性渲染 error（mock 形状非真实契约：服务端当前无产出路径）', async () => {
    mockImport.mockResolvedValue({
      ...doneResult,
      spaceMeta: { applied: true, status: 'updated', error: { message: 'meta boom' } },
    });
    await importAndSettle();

    expect(screen.getByText('Overwritten')).toBeInTheDocument();
    expect(screen.getByText('meta boom')).toBeInTheDocument();
    // spaceMeta.error 也进入失败并集
    expect(screen.getByText('Failed items (4)')).toBeInTheDocument();
  });
});

describe('ImportBundleDialog 请求失败与关闭守卫', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDocs.mockResolvedValue(paginated([{ path: 'a.md' }]));
  });

  it('请求失败 → error 态保留 bundle 与勾选状态，重试重发同一 bundle', async () => {
    mockImport.mockRejectedValueOnce({ response: { data: { message: 'server boom' } } });
    const { container } = renderDialog({ spaceDocCount: 1 });
    await pickBundle(container, bundleFixture);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

    expect(await screen.findByText('server boom')).toBeInTheDocument();
    expect(
      screen.getByText('The failure may have happened after some content was written'),
    ).toBeInTheDocument();

    mockImport.mockResolvedValueOnce(doneResult);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(2));
    // 同一 bundle 重导（幂等契约）：无需重选文件
    expect(mockImport.mock.calls[1][1]).toEqual(bundleFixture);
    expect(await screen.findByText('Import result')).toBeInTheDocument();
  });

  it('importing 阶段禁关闭：Esc 走同一守卫不改 open', async () => {
    mockImport.mockReturnValue(new Promise(() => {}));
    const { container, onOpenChange } = renderDialog({ spaceDocCount: 1 });
    await pickBundle(container, bundleFixture);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

    await screen.findByText('Importing... large spaces can take 1-2 minutes');
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onOpenChange).not.toHaveBeenCalled();
    // 进度语境仍在（对话框未关闭）
    expect(screen.getByText('Importing... large spaces can take 1-2 minutes')).toBeInTheDocument();
  });

  it('非 importing 阶段 Esc 正常关闭（同一守卫生效）', async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Esc 已被更早注册的监听消费（defaultPrevented）→ 不再级联关闭', async () => {
    // 消费方必须在对话框挂载**之前**注册才能先执行（同 target 同阶段按注册序）；
    // 模拟应用级早注册的 Esc 处理者（全局快捷键 / 文档捕获层）
    const consume = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault();
    };
    window.addEventListener('keydown', consume);
    try {
      const { onOpenChange } = renderDialog();
      fireEvent.keyDown(window, { key: 'Escape' });

      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', consume);
    }
  });

  it('二次确认框开着时 Esc 归确认框，不级联关闭父对话框；确认框收起后 Esc 恢复', async () => {
    const { onOpenChange } = renderDialog();
    // 确认框队列非空 = NotificationHost 正展示一个确认框（alert-dialog 的 Esc 归它）
    useNotificationStore.setState({
      alerts: [{ title: 'Confirm', confirmText: 'OK', cancelText: 'Cancel' }],
    });
    try {
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      useNotificationStore.setState({ alerts: [] });
    }

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
