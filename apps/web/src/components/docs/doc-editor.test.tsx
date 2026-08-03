import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DocEditor } from './doc-editor';
import { Api } from '@/lib/api';

/** docs.editor 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  editTab: 'Edit',
  preview: 'Preview',
  insertLink: 'Insert link',
  path: 'Path',
  pathPlaceholder: 'Enter doc path, e.g. guides/my-doc.md',
  pathHint: 'Path must be unique within the space; existing paths will be overwritten',
  contentPlaceholder: 'Write Markdown content here...',
  titleAutoHint: 'Title is derived from the first # heading — no separate title field',
  save: 'Save',
  cancel: 'Cancel',
  discardConfirm: 'You have unsaved changes. Discard them?',
  pathConflict: 'Path already exists, choose another',
  pathCheckFailed: 'Could not verify path uniqueness, please try again',
};

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => messages[key] ?? key,
}));

jest.mock('@/lib/api', () => ({
  Api: {
    docs: {
      listDocs: jest.fn(),
    },
  },
}));

// DocPicker 依赖弹层/搜索链路，与本测试无关，stub 掉保持测试轻量
jest.mock('@/components/docs/doc-picker', () => ({
  DocPicker: () => null,
}));

// react-markdown / remark-gfm 为纯 ESM，Jest 不转换 node_modules，stub 之
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => undefined,
}));

const mockListDocs = Api.docs.listDocs as jest.Mock;

/** 渲染 create 模式编辑器的默认 props（测试内按需覆盖） */
function renderCreateEditor(overrides: Partial<Parameters<typeof DocEditor>[0]> = {}) {
  const onSave = jest.fn();
  const onCancel = jest.fn();
  render(
    <DocEditor
      mode="create"
      spaceId="space-1"
      initialContent=""
      existingPaths={[]}
      saving={false}
      onSave={onSave}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onSave, onCancel };
}

/** 在路径输入框输入并点击保存 */
function typePathAndSave(path: string) {
  fireEvent.change(screen.getByPlaceholderText('Enter doc path, e.g. guides/my-doc.md'), {
    target: { value: path },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('DocEditor 新建文档路径冲突预检', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('精确校验命中已存在路径时拦截保存并提示', async () => {
    // existingPaths 本地列表未覆盖（模拟 >100 篇空间截断盲区），精确校验命中
    mockListDocs.mockResolvedValue({ items: [{ id: 'd1', path: 'guides/dup.md' }], total: 1 });
    const { onSave } = renderCreateEditor();

    typePathAndSave('guides/dup.md');

    await waitFor(() => {
      expect(screen.getByText('Path already exists, choose another')).toBeInTheDocument();
    });
    expect(mockListDocs).toHaveBeenCalledWith('space-1', { path: 'guides/dup.md' });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('本地 existingPaths 命中时快速拦截（不发精确校验请求）', async () => {
    const { onSave } = renderCreateEditor({ existingPaths: ['guides/dup.md'] });

    typePathAndSave('guides/dup.md');

    await waitFor(() => {
      expect(screen.getByText('Path already exists, choose another')).toBeInTheDocument();
    });
    expect(mockListDocs).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('路径未冲突时放行保存', async () => {
    mockListDocs.mockResolvedValue({ items: [], total: 0 });
    const { onSave } = renderCreateEditor();

    typePathAndSave('guides/new.md');

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({ path: 'guides/new.md', content: '' });
    });
  });

  it('精确校验请求失败时阻塞保存并提示重试（宁可误拦，不可静默覆盖）', async () => {
    mockListDocs.mockRejectedValue(new Error('network down'));
    const { onSave } = renderCreateEditor();

    typePathAndSave('guides/new.md');

    await waitFor(() => {
      expect(
        screen.getByText('Could not verify path uniqueness, please try again'),
      ).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });
});
