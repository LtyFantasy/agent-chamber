'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRelativeTime } from '@/lib/utils';
import { Search, MessageSquare, ClipboardList, FileText, User } from 'lucide-react';
import Link from 'next/link';
import type {
  MessageSearchResult,
  TaskSearchResult,
  SearchType,
  PaginatedResponse,
  DocSearchHitWithSpace,
} from '@/types';

const taskStatusMap: Record<
  string,
  {
    labelKey: string;
    variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
  }
> = {
  backlog: { labelKey: 'tasks.status.backlog', variant: 'secondary' },
  todo: { labelKey: 'tasks.status.todo', variant: 'default' },
  in_progress: { labelKey: 'tasks.status.in_progress', variant: 'warning' },
  review: { labelKey: 'tasks.status.review', variant: 'outline' },
  done: { labelKey: 'tasks.status.done', variant: 'success' },
  blocked: { labelKey: 'tasks.status.blocked', variant: 'destructive' },
  archived: { labelKey: 'tasks.status.archived', variant: 'secondary' },
};

// 优先级徽章：半透明语义色（对齐 ui-design-system §2.2 与看板任务卡同款配色）
const taskPriorityMap: Record<string, { label: string; color: string }> = {
  p0: { label: 'P0', color: 'bg-red-500/15 text-red-300' },
  p1: { label: 'P1', color: 'bg-orange-500/15 text-orange-300' },
  p2: { label: 'P2', color: 'bg-blue-500/15 text-blue-300' },
  p3: { label: 'P3', color: 'bg-muted/50 text-muted-foreground' },
};

/** 将 <<<...>>> 标记替换为高亮 HTML */
function renderHighlight(highlight: string | null): JSX.Element | string {
  if (!highlight) return '';
  const parts = highlight.split(/(<<<.*?>>>)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('<<<') && part.endsWith('>>>')) {
          const text = part.slice(3, -3);
          return (
            <mark key={i} className="rounded bg-yellow-500/25 px-0.5 font-semibold text-yellow-200">
              {text}
            </mark>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

type SearchResults = {
  messages: PaginatedResponse<MessageSearchResult> | null;
  tasks: PaginatedResponse<TaskSearchResult> | null;
  docs: DocSearchHitWithSpace[] | null;
};

const TAB_TO_TYPE: Record<string, SearchType> = {
  all: 'all',
  messages: 'messages',
  tasks: 'tasks',
  docs: 'docs',
};

export default function SearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('search');
  const tGlobal = useTranslations();

  const urlQ = searchParams.get('q') || '';
  const urlType = (searchParams.get('type') as SearchType) || 'all';

  const [query, setQuery] = useState(urlQ);
  const [activeTab, setActiveTab] = useState(urlType === 'all' ? 'all' : urlType);
  const [results, setResults] = useState<SearchResults>({
    messages: null,
    tasks: null,
    docs: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(!!urlQ);

  // 各 tab 的独立页码（用于"加载更多"）
  const [messagePage, setMessagePage] = useState(1);
  const [taskPage, setTaskPage] = useState(1);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 同步 URL query 参数 */
  const updateUrl = useCallback(
    (q: string, tab: string) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (tab !== 'all') params.set('type', tab);
      const url = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
      router.replace(url, { scroll: false });
    },
    [router],
  );

  /** 执行搜索 */
  const performSearch = useCallback(
    async (q: string, type: SearchType, page: number, append: boolean) => {
      if (!q.trim()) {
        setResults({ messages: null, tasks: null, docs: null });
        setHasSearched(false);
        return;
      }

      setIsLoading(true);
      setHasSearched(true);

      try {
        const data = await Api.search.query({
          q: q.trim(),
          type,
          page,
          pageSize: 20,
        });

        if (append) {
          // 追加模式：合并已有数据和新数据（docs 无分页加载更多，保持旧值）
          setResults((prev) => ({
            messages:
              data.messages && prev.messages
                ? {
                    ...data.messages,
                    items: [...prev.messages.items, ...data.messages.items],
                  }
                : (data.messages ?? prev.messages),
            tasks:
              data.tasks && prev.tasks
                ? {
                    ...data.tasks,
                    items: [...prev.tasks.items, ...data.tasks.items],
                  }
                : (data.tasks ?? prev.tasks),
            docs: data.docs ?? prev.docs,
          }));
        } else {
          setResults(data);
        }
      } catch (error) {
        console.error('搜索失败:', error);
        if (!append) {
          setResults({ messages: null, tasks: null, docs: null });
        }
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  /** 首次搜索或关键词变化 */
  useEffect(() => {
    if (!query.trim()) {
      setHasSearched(false);
      setResults({ messages: null, tasks: null, docs: null });
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setMessagePage(1);
      setTaskPage(1);
      void performSearch(query, TAB_TO_TYPE[activeTab], 1, false);
      updateUrl(query, activeTab);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, activeTab, performSearch, updateUrl]);

  /** Tab 切换 */
  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    updateUrl(query, tab);
    // 如果切换到单类型 tab 且没有数据，自动搜索
    const type = TAB_TO_TYPE[tab];
    if (type !== 'all') {
      const hasData =
        type === 'messages'
          ? !!results.messages
          : type === 'tasks'
            ? !!results.tasks
            : !!results.docs;
      if (!hasData && query.trim()) {
        void performSearch(query, type, 1, false);
      }
    }
  };

  /** 加载更多 */
  const handleLoadMore = (type: 'messages' | 'tasks') => {
    const current = type === 'messages' ? results.messages : results.tasks;
    if (!current || !current.hasNext || isLoading) return;

    const nextPage = type === 'messages' ? messagePage + 1 : taskPage + 1;
    if (type === 'messages') setMessagePage(nextPage);
    else setTaskPage(nextPage);

    void performSearch(query, type, nextPage, true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setMessagePage(1);
      setTaskPage(1);
      void performSearch(query, TAB_TO_TYPE[activeTab], 1, false);
      updateUrl(query, activeTab);
    }
  };

  const messageCount = results.messages?.items.length ?? 0;
  const taskCount = results.tasks?.items.length ?? 0;
  const docCount = results.docs?.length ?? 0;
  const totalCount = messageCount + taskCount + docCount;

  const renderLoadingSkeleton = () => (
    <div className="space-y-4">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );

  const renderMessageCard = (message: MessageSearchResult) => (
    <Card
      key={message.id}
      className="transition-shadow hover:border-primary/40 hover:shadow-glow-sm"
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
              <MessageSquare className="h-4 w-4 text-primary" />
            </div>
            <div>
              <span className="text-sm font-medium">{message.senderName}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {message.senderType === 'human'
                  ? t('sender.human')
                  : message.senderType === 'agent'
                    ? t('sender.agent')
                    : message.senderType === 'system'
                      ? t('sender.system')
                      : message.senderType}
              </span>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(message.createdAt)}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground line-clamp-3">
          {message.highlight ? renderHighlight(message.highlight) : message.contentSnippet || ''}
        </p>
      </CardContent>
    </Card>
  );

  const renderTaskCard = (task: TaskSearchResult) => {
    const status = taskStatusMap[task.status] || {
      labelKey: task.status,
      variant: 'default' as const,
    };
    const priority = taskPriorityMap[task.priority] || { label: task.priority, color: '' };
    return (
      <Card
        key={task.id}
        className="transition-shadow hover:border-primary/40 hover:shadow-glow-sm"
      >
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                <ClipboardList className="h-4 w-4 text-primary" />
              </div>
              <CardTitle className="text-base">
                {task.highlight ? renderHighlight(task.highlight) : task.title}
              </CardTitle>
            </div>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <Badge variant={status.variant}>{tGlobal(status.labelKey as any)}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 text-sm">
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${priority.color}`}
            >
              {priority.label}
            </span>
            {task.assigneeId && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <User className="h-3.5 w-3.5" />
                {t('assigned')}
              </span>
            )}
            <span className="text-muted-foreground">{formatRelativeTime(task.createdAt)}</span>
          </div>
          {task.descriptionSnippet && (
            <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
              {task.descriptionSnippet}
            </p>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderDocCard = (doc: DocSearchHitWithSpace) => (
    <Link
      // 同一文档可能多个 section 命中（position 区分），key 必须组合，否则 React 重复 key 警告
      key={`${doc.docId}-${doc.position}`}
      href={`/docs/${doc.spaceId}?doc=${doc.docId}`}
      className="block"
      title={t('openDoc', { title: doc.docTitle })}
    >
      <Card className="transition-shadow hover:border-primary/40 hover:shadow-glow-sm">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <FileText className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0">
                <CardTitle className="truncate text-base">{doc.docTitle}</CardTitle>
                {doc.headingPath && (
                  <p className="truncate text-xs text-muted-foreground">{doc.headingPath}</p>
                )}
              </div>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{doc.docPath}</span>
          </div>
        </CardHeader>
        {doc.snippet && (
          <CardContent>
            <p className="line-clamp-3 text-sm text-muted-foreground">{doc.snippet}</p>
          </CardContent>
        )}
      </Card>
    </Link>
  );

  const renderLoadMoreButton = (type: 'messages' | 'tasks') => {
    const data = type === 'messages' ? results.messages : results.tasks;
    if (!data || !data.hasNext) return null;
    return (
      <div className="flex justify-center pt-4">
        <Button variant="outline" onClick={() => handleLoadMore(type)} disabled={isLoading}>
          {isLoading ? tGlobal('common.loading') : t('loadMore')}
        </Button>
      </div>
    );
  };

  return (
    // 与 topics/boards 等列表页一致：内容靠左填充，不居中收窄
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t('placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-12 pl-10 text-base"
        />
      </div>

      {!hasSearched ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <Search className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <h3 className="mt-4 text-lg font-medium text-foreground">{t('startSearch')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('startSearchHint')}</p>
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="mb-4">
            <TabsTrigger value="all">
              {t('tab.all')} {totalCount > 0 && `(${totalCount})`}
            </TabsTrigger>
            <TabsTrigger value="messages">
              {t('tab.messages')}{' '}
              {results.messages && results.messages.total > 0 && `(${results.messages.total})`}
            </TabsTrigger>
            <TabsTrigger value="tasks">
              {t('tab.tasks')}{' '}
              {results.tasks && results.tasks.total > 0 && `(${results.tasks.total})`}
            </TabsTrigger>
            <TabsTrigger value="docs">
              {t('tab.docs')} {docCount > 0 && `(${docCount})`}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="all">
            {isLoading && !results.messages && !results.tasks ? (
              renderLoadingSkeleton()
            ) : totalCount === 0 ? (
              <EmptyState title={t('noResults')} description={t('noResultsDesc', { query })} />
            ) : (
              <div className="space-y-6">
                {messageCount > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="text-lg font-semibold">
                        {t('sectionMessages', { count: results.messages?.total ?? 0 })}
                      </h2>
                    </div>
                    <div className="space-y-3">
                      {results.messages!.items.map(renderMessageCard)}
                    </div>
                    {renderLoadMoreButton('messages')}
                  </div>
                )}
                {taskCount > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="text-lg font-semibold">
                        {t('sectionTasks', { count: results.tasks?.total ?? 0 })}
                      </h2>
                    </div>
                    <div className="space-y-3">{results.tasks!.items.map(renderTaskCard)}</div>
                    {renderLoadMoreButton('tasks')}
                  </div>
                )}
                {docCount > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="text-lg font-semibold">
                        {t('sectionDocs', { count: docCount })}
                      </h2>
                    </div>
                    <div className="space-y-3">{results.docs!.map(renderDocCard)}</div>
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="messages">
            {isLoading && !results.messages ? (
              renderLoadingSkeleton()
            ) : messageCount === 0 ? (
              <EmptyState title={t('noMessages')} description={t('noMessagesDesc', { query })} />
            ) : (
              <div className="space-y-3">
                {results.messages!.items.map(renderMessageCard)}
                {renderLoadMoreButton('messages')}
              </div>
            )}
          </TabsContent>

          <TabsContent value="tasks">
            {isLoading && !results.tasks ? (
              renderLoadingSkeleton()
            ) : taskCount === 0 ? (
              <EmptyState title={t('noTasks')} description={t('noTasksDesc', { query })} />
            ) : (
              <div className="space-y-3">
                {results.tasks!.items.map(renderTaskCard)}
                {renderLoadMoreButton('tasks')}
              </div>
            )}
          </TabsContent>

          <TabsContent value="docs">
            {isLoading && !results.docs ? (
              renderLoadingSkeleton()
            ) : docCount === 0 ? (
              <EmptyState title={t('noDocs')} description={t('noDocsDesc', { query })} />
            ) : (
              <div className="space-y-3">{results.docs!.map(renderDocCard)}</div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
