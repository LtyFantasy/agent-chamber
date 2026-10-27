/** User deletion retains the selected account on error and retries the same target. */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UsersPage from './page';
import { Api } from '@/lib/api';
import { toast } from '@/lib/notify';
jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
jest.mock('@/lib/api', () => ({ Api: { users: { list: jest.fn(), delete: jest.fn() } } }));
jest.mock('@/lib/notify', () => ({ toast: { error: jest.fn() } }));
it('failed delete keeps selected user and confirmation, then retries', async () => {
  (Api.users.list as jest.Mock).mockResolvedValue({
    items: [
      {
        id: 'user-a',
        name: 'Kept user',
        email: 'user@example.com',
        status: 'active',
        role: 'editor',
        createdAt: '2026-10-26',
      },
    ],
  });
  (Api.users.delete as jest.Mock).mockRejectedValue(new Error('Network Error'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UsersPage />
    </QueryClientProvider>,
  );
  const row = (await screen.findByText('Kept user')).closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: 'common.delete' }));
  const dialog = within(screen.getByText('users.delete.title').parentElement!.parentElement!);
  fireEvent.click(dialog.getByRole('button', { name: 'common.delete' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: 'users.deleteFailed' }));
  expect(screen.getByText('users.delete.title')).toBeInTheDocument();
  expect(screen.getByText('Kept user')).toBeInTheDocument();
  (Api.users.delete as jest.Mock).mockResolvedValue({});
  fireEvent.click(dialog.getByRole('button', { name: 'common.delete' }));
  await waitFor(() => expect(screen.queryByText('users.delete.title')).not.toBeInTheDocument());
  expect(Api.users.delete).toHaveBeenCalledTimes(2);
});
