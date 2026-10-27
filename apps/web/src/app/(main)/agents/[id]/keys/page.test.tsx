/** Independent read failures must never turn a missing response into an empty key list. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentKeysPage from './page';
import { Api } from '@/lib/api';
import { toast } from '@/lib/notify';
jest.mock('@/lib/notify', () => ({ toast: { error: jest.fn() } }));
jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'agent-a' }) }));
jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
jest.mock('@/lib/api', () => ({
  Api: {
    agents: { getById: jest.fn(), findKeys: jest.fn(), createKey: jest.fn(), revokeKey: jest.fn() },
  },
}));
const getAgent = Api.agents.getById as jest.Mock;
const getKeys = Api.agents.findKeys as jest.Mock;
/** Fresh elements and real observers preserve the same mounted dialog across a failed refetch. */
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => (
    <QueryClientProvider client={client}>
      <AgentKeysPage />
    </QueryClientProvider>
  );
  return { client, element, ...render(element()) };
}
beforeEach(() => {
  jest.clearAllMocks();
  getAgent.mockResolvedValue({ id: 'agent-a', name: 'Agent A' });
  getKeys.mockResolvedValue([]);
});
it('keys failure can retry only the list while the successful agent remains available', async () => {
  getKeys.mockRejectedValue(new Error('Network Error'));
  renderPage();
  const retry = await screen.findByRole('button', { name: 'common.retry' });
  expect(screen.queryByText('agents.keys.empty')).not.toBeInTheDocument();
  getKeys.mockResolvedValue([]);
  fireEvent.click(retry);
  expect(await screen.findByText('agents.keys.empty')).toBeInTheDocument();
  expect(getAgent).toHaveBeenCalledTimes(1);
  expect(getKeys).toHaveBeenCalledTimes(2);
});
it('agent failure does not hide a successful keys list and retries only agent metadata', async () => {
  getAgent.mockRejectedValue(new Error('Network Error'));
  renderPage();
  const retry = await screen.findByRole('button', { name: 'common.retry' });
  expect(await screen.findByText('agents.keys.empty')).toBeInTheDocument();
  getAgent.mockResolvedValue({ id: 'agent-a', name: 'Agent A' });
  fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(getKeys).toHaveBeenCalledTimes(1);
  expect(getAgent).toHaveBeenCalledTimes(2);
});
it('cached empty keys preserve an open creation dialog and draft across failure and successful retry', async () => {
  const { client, element, rerender } = renderPage();
  await screen.findByText('agents.keys.empty');
  fireEvent.click(screen.getAllByRole('button', { name: 'agents.keys.create' })[0]);
  fireEvent.change(await screen.findByPlaceholderText('agents.keys.namePlaceholder'), {
    target: { value: 'Draft key name' },
  });
  getKeys.mockRejectedValue(new Error('Network Error'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['agents', 'keys', 'agent-a'] });
  });
  rerender(element());
  expect(await screen.findByRole('status')).toHaveTextContent('common.refreshFailed');
  expect(screen.getByDisplayValue('Draft key name')).toBeInTheDocument();
  getKeys.mockResolvedValue([]);
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.getByDisplayValue('Draft key name')).toBeInTheDocument();
});

it('create key failure keeps the name and retries without exposing a 5xx detail', async () => {
  (Api.agents.createKey as jest.Mock).mockRejectedValue({
    response: { status: 500, data: { code: 500, message: 'internal SQL detail' } },
  });
  renderPage();
  await screen.findByText('agents.keys.empty');
  fireEvent.click(
    within(
      screen.getByRole('heading', { name: 'agents.keys.title' }).parentElement!.parentElement!,
    ).getByRole('button', { name: 'agents.keys.create' }),
  );
  fireEvent.change(screen.getByPlaceholderText('agents.keys.namePlaceholder'), {
    target: { value: 'Keep key name' },
  });
  const dialog = within(
    screen.getByRole('heading', { name: 'agents.keys.createDialogTitle' }).parentElement!
      .parentElement!,
  );
  fireEvent.click(dialog.getByRole('button', { name: 'common.create' }));
  expect(await screen.findByText('agents.keys.createError')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Keep key name')).toBeInTheDocument();
  (Api.agents.createKey as jest.Mock).mockResolvedValue({
    id: 'new-key',
    name: 'Keep key name',
    apiKey: 'fixture-public-key',
  });
  fireEvent.click(dialog.getByRole('button', { name: 'common.create' }));
  expect(
    await screen.findByRole('heading', { name: 'agents.keys.createSuccess' }),
  ).toBeInTheDocument();
  expect(Api.agents.createKey).toHaveBeenCalledTimes(2);
});
it('revoke key failure preserves active status and the selected key, then retries', async () => {
  getKeys.mockResolvedValue([
    {
      id: 'key-a',
      name: 'Kept key',
      keyPrefix: 'fixture',
      createdAt: '2026-10-26',
      revokedAt: null,
    },
  ]);
  (Api.agents.revokeKey as jest.Mock).mockRejectedValue(new Error('Network Error'));
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'agents.keys.revoke' }));
  const dialog = within(
    screen.getByRole('heading', { name: 'agents.keys.revokeTitle' }).parentElement!.parentElement!,
  );
  fireEvent.click(dialog.getByRole('button', { name: 'agents.keys.revoke' }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith({ title: 'agents.keys.revokeError' }),
  );
  expect(screen.getByText('agents.keys.status.active')).toBeInTheDocument();
  (Api.agents.revokeKey as jest.Mock).mockResolvedValue({});
  fireEvent.click(dialog.getByRole('button', { name: 'agents.keys.revoke' }));
  expect(await screen.findByText('agents.keys.status.revoked')).toBeInTheDocument();
  expect(Api.agents.revokeKey).toHaveBeenCalledTimes(2);
});
