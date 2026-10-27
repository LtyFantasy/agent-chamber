/** Message failure recovery must stay local and respect all conditional query gates. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TopicDetailPage from './page';
import { Api } from '@/lib/api';
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'topic-a' }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('@/lib/use-event-poll', () => ({ useEventPoll: () => undefined }));
jest.mock('@/stores/auth.store', () => ({
  useAuthStore: (select: (state: unknown) => unknown) =>
    select({ isAuthenticated: false, user: { id: 'owner', role: 'admin' } }),
}));
jest.mock('@/components/topics/topic-composer', () => ({
  TopicComposer: () => <div>Composer remains mounted</div>,
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  SEAT_LIFECYCLE_STATUS: { ACTIVE: 'active' },
  Api: {
    topics: { getById: jest.fn(), getMessages: jest.fn(), getUnread: jest.fn() },
    agents: { listAll: jest.fn() },
    users: { listUsers: jest.fn() },
    boards: { list: jest.fn() },
    docs: { listSpaces: jest.fn() },
    roundtable: { listSeats: jest.fn() },
  },
}));
const messages = Api.topics.getMessages as jest.Mock;
/** Real React Query observers deliver errors asynchronously, independent of the rendered title. */
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => (
    <QueryClientProvider client={client}>
      <TopicDetailPage />
    </QueryClientProvider>
  );
  return { client, element, ...render(element()) };
}
beforeEach(() => {
  jest.clearAllMocks();
  (Api.topics.getById as jest.Mock).mockResolvedValue({
    id: 'topic-a',
    title: 'Topic title',
    status: 'active',
    visibility: 'open',
    kind: 'discussion',
    creatorId: 'owner',
    participants: [],
    boards: [],
    tasks: [],
  });
  (Api.agents.listAll as jest.Mock).mockResolvedValue([]);
  (Api.users.listUsers as jest.Mock).mockResolvedValue({ items: [] });
  messages.mockResolvedValue({ messages: [], hasMore: false });
  Element.prototype.scrollIntoView = jest.fn();
});
it('message first error retries only messages, never hidden boards/spaces/seats/unread queries', async () => {
  messages.mockRejectedValue(new Error('Network Error'));
  renderPage();
  const retry = await screen.findByRole('button', { name: 'common.retry' });
  expect(screen.getByText('Topic title')).toBeInTheDocument();
  expect(screen.queryByText('topics.message.empty')).not.toBeInTheDocument();
  messages.mockResolvedValue({ messages: [], hasMore: false });
  fireEvent.click(retry);
  expect(await screen.findByText('topics.message.empty')).toBeInTheDocument();
  expect(Api.boards.list).not.toHaveBeenCalled();
  expect(Api.docs.listSpaces).not.toHaveBeenCalled();
  expect(Api.roundtable.listSeats).not.toHaveBeenCalled();
  expect(Api.topics.getUnread).not.toHaveBeenCalled();
});
it('successful empty messages and composer remain mounted after a failed refresh and retry recovery', async () => {
  const { client, element, rerender } = renderPage();
  await screen.findByText('topics.message.empty');
  messages.mockRejectedValue(new Error('Network Error'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['topics', 'messages', 'topic-a'] });
  });
  rerender(element());
  expect(await screen.findByRole('status')).toHaveTextContent('common.refreshFailed');
  expect(screen.getByText('topics.message.empty')).toBeInTheDocument();
  expect(screen.getByText('Composer remains mounted')).toBeInTheDocument();
  messages.mockResolvedValue({ messages: [], hasMore: false });
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.getByText('topics.message.empty')).toBeInTheDocument();
});
