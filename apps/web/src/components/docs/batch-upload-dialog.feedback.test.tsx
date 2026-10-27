/** Rejected files remain readable after the transient notification disappears. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BatchUploadDialog } from './batch-upload-dialog';
import { Api } from '@/lib/api';
import { toast } from '@/lib/notify';
jest.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
jest.mock('@/lib/api', () => ({ Api: { docs: { listDocs: jest.fn() } } }));
jest.mock('@/lib/notify', () => ({ toast: { warning: jest.fn() } }));
it('keeps the full rejected names and sizes inside the dialog, across another file selection', async () => {
  (Api.docs.listDocs as jest.Mock).mockResolvedValue({ items: [], total: 0 });
  const { container } = render(
    <BatchUploadDialog open spaceId="space" onOpenChange={jest.fn()} onUploaded={jest.fn()} />,
  );
  const files = ['first-full-name.md', 'second-full-name.md'].map((name) => {
    const file = new File([], name);
    Object.defineProperty(file, 'size', { value: 6 * 1024 * 1024 });
    return file;
  });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files } });
  const rejected = await screen.findByRole('status');
  for (const file of files)
    expect(within(rejected).getByText(file.name, { exact: false })).toHaveTextContent('6.0 MB');
  expect(toast.warning).toHaveBeenCalledTimes(1);
  expect(toast.warning).toHaveBeenCalledWith({ title: 'fileTooLarge' });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [] } });
  await waitFor(() =>
    expect(screen.getByText('first-full-name.md', { exact: false })).toBeInTheDocument(),
  );
});
