/**
 * search/page.test.tsx — 全局搜索页消息卡片渲染契约测试（统一批 B）。
 *
 * 覆盖：
 * ① senderDeletedAt 非空 → 消息卡片 senderName 灰化 + 「已删除」badge（独立结果列表
 *    密度低，常驻 badge 可接受——R16 分级）
 * ② 未删除发送者：无 badge、不灰化
 *
 * 隔离策略：mock next/navigation（useSearchParams 带初始 query 触发 300ms debounce
 * 搜索）+ mock Api.search.query 返回固定结果；文案用 en.json 快照。
 */

import { render, screen, waitFor } from '@testing-library/react';
import SearchPage from './page';
import { Api } from '@/lib/api';
import type { SearchResult } from '@/types';

/** search 命名空间 + 组件用到的全键文案快照（同 en.json） */
const messages: Record<string, string> = {
  'search.title': 'Global Search',
  'search.description': 'Search messages, tasks, docs...',
  'search.placeholder': 'Search messages, tasks, docs...',
  'search.tab.all': 'All',
  'search.tab.messages': 'Messages',
  'search.tab.tasks': 'Tasks',
  'search.tab.docs': 'Docs',
  'search.sectionMessages': 'Messages ({count})',
  'search.sender.agent': 'Agent',
  'search.sender.human': 'User',
  'common.deleted': 'Deleted',
  'common.loading': 'Loading...',
};

jest.mock('next-intl', () => ({
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

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('q=ghost'),
  useRouter: () => ({ replace: jest.fn() }),
}));

jest.mock('@/lib/api', () => ({
  Api: {
    search: {
      query: jest.fn(),
    },
  },
}));

const mockSearchQuery = Api.search.query as jest.Mock;

/** 消息搜索结果 fixture（PaginatedResponse<MessageSearchResult> 全字段） */
function messageResult(overrides: Partial<SearchResult['messages']> = {}): SearchResult {
  return {
    messages: {
      items: [
        {
          id: 'm1',
          topicId: 't1',
          senderId: 'a1',
          senderName: 'Ghost Agent',
          senderType: 'agent',
          senderDeletedAt: '2026-08-01T00:00:00Z',
          type: 'chat',
          contentSnippet: 'hello from the past',
          highlight: null,
          createdAt: '2026-08-01T00:00:00Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
      ...overrides,
    },
    tasks: null,
    docs: null,
  };
}

describe('SearchPage 消息卡片（统一批 B 已删除降级）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('senderDeletedAt 非空 → 发送者灰化 + 「已删除」badge', async () => {
    mockSearchQuery.mockResolvedValue(messageResult());

    render(<SearchPage />);

    // debounce 300ms + 异步查询后渲染消息卡片
    const name = await screen.findByText('Ghost Agent');
    expect(name.className).toContain('opacity-60');
    // 独立结果列表密度低 → 常驻 badge（R16 分级）
    expect(screen.getByText('Deleted')).toBeInTheDocument();
  });

  it('未删除发送者：不灰化、无 badge', async () => {
    mockSearchQuery.mockResolvedValue(
      messageResult({
        items: [
          {
            id: 'm2',
            topicId: 't1',
            senderId: 'a2',
            senderName: 'Alive Agent',
            senderType: 'agent',
            senderDeletedAt: null,
            type: 'chat',
            contentSnippet: 'still here',
            highlight: null,
            createdAt: '2026-08-01T00:00:00Z',
          },
        ],
      }),
    );

    render(<SearchPage />);

    const name = await screen.findByText('Alive Agent');
    expect(name.className).not.toContain('opacity-60');
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });
});
