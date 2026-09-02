import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DocsPage from './page';
import { Api } from '@/lib/api';

/** 本测试用到的文案快照（同 en.json；未命中 key 回退为完整 key 路径，不影响断言） */
const messages: Record<string, string> = {
  'docs.create': 'New Space',
  'docs.delete.confirmTitle': 'Confirm deletion',
  'docs.delete.confirmDesc': 'Delete space and its {count} docs and {linkedCount} linked tasks?',
  'common.delete': 'Delete',
  'common.cancel': 'Cancel',
};

jest.mock('next-intl', () => ({
  // 组件新增 useLocale 依赖（formatRelativeTime/formatDate locale 下传），mock 固定 en
  useLocale: () => 'en',
  // 支持 {param} 简单插值（测试文案用简版占位，与 en.json 的 ICU 语法无关）
  useTranslations: (ns?: string) => (key: string, params?: Record<string, string | number>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    let text = messages[fullKey] ?? fullKey;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.split(`{${k}}`).join(String(v));
      }
    }
    return text;
  },
}));

jest.mock('next/link', () => {
  return function MockLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});

jest.mock('@/lib/api', () => ({
  Api: {
    docs: {
      listSpaces: jest.fn(),
      getSpace: jest.fn(),
      deleteSpace: jest.fn(),
    },
    topics: { list: jest.fn() },
    boards: { list: jest.fn() },
  },
}));

const mockApi = Api.docs as unknown as {
  listSpaces: jest.Mock;
  getSpace: jest.Mock;
  deleteSpace: jest.Mock;
};

function renderPage() {
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DocsPage />
    </QueryClientProvider>,
  );
}

describe('DocsPage 删除空间确认框（B2 linkedTaskCount）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.listSpaces.mockResolvedValue({
      items: [{ id: 's1', name: 'Space 1', visibility: 'open', docCount: 3 }],
      total: 1,
    });
    mockApi.getSpace.mockResolvedValue({
      id: 's1',
      name: 'Space 1',
      docCount: 3,
      linkedTaskCount: 5,
    });
  });

  it('点击删除打开确认框，按 spaceId 拉详情并展示 docCount + linkedTaskCount', async () => {
    const { container } = renderPage();
    await screen.findByText('Space 1');

    // 卡片右上角删除按钮（无文字，仅 Trash2 图标，按 icon class 定位）
    const trashBtn = container.querySelector('button svg.text-destructive')?.closest('button');
    expect(trashBtn).not.toBeNull();
    fireEvent.click(trashBtn!);

    // Dialog 打开后触发详情查询（拿 linkedTaskCount）
    await waitFor(() => {
      expect(mockApi.getSpace).toHaveBeenCalledWith('s1');
    });
    expect(
      await screen.findByText('Delete space and its 3 docs and 5 linked tasks?'),
    ).toBeInTheDocument();
  });

  it('详情尚未返回时展示加载态文案', async () => {
    // getSpace 挂起 → 确认框停留在 loadingDetail 文案
    mockApi.getSpace.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    await screen.findByText('Space 1');

    const trashBtn = container.querySelector('button svg.text-destructive')?.closest('button');
    fireEvent.click(trashBtn!);

    expect(await screen.findByText('docs.delete.loadingDetail')).toBeInTheDocument();
  });
});
