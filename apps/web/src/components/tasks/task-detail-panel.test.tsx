/** Real query observers exercise draft retention, lazy child errors and task identity. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskDetailPanel } from './task-detail-panel';
import { Api } from '@/lib/api';
import { toast } from '@/lib/notify';
jest.mock('@/lib/notify', () => ({
  toast: { error: jest.fn() },
  confirm: jest.fn().mockResolvedValue(true),
}));
import TaskDetailPage from '@/app/(main)/tasks/[id]/page';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useParams: () => ({ id: 'task-a' }),
}));
jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
jest.mock('@/components/docs/doc-picker', () => ({
  DocPicker: ({ onSelect }: { onSelect: (pick: { docId: string }) => void }) => (
    <button onClick={() => onSelect({ docId: 'new-doc' })}>Pick doc</button>
  ),
}));
jest.mock('@/components/tasks/task-picker', () => ({
  TaskPicker: ({
    onSelect,
    selectedTitle,
  }: {
    onSelect: (pick: { id: string; title: string }) => void;
    selectedTitle?: string;
  }) => (
    <button onClick={() => onSelect({ id: 'new-dependency', title: 'Selected dependency' })}>
      {selectedTitle ?? 'Pick dependency'}
    </button>
  ),
}));
jest.mock('@/lib/api', () => ({
  Api: {
    tasks: {
      getById: jest.fn(),
      getComments: jest.fn(),
      getActivities: jest.fn(),
      getDependencies: jest.fn(),
      getBlockers: jest.fn(),
      getMilestones: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      addComment: jest.fn(),
      removeDependency: jest.fn(),
      removeDocLink: jest.fn(),
      addDocLink: jest.fn(),
      addDependency: jest.fn(),
    },
    docs: { getDoc: jest.fn() },
    agents: { listAll: jest.fn() },
    boards: { getById: jest.fn() },
    topics: { getById: jest.fn() },
  },
}));
const task = {
  id: 'task-a',
  title: 'Server title',
  description: '',
  assigneeId: null,
  milestoneId: null,
  status: 'todo',
  priority: 'p2',
  labels: [] as string[],
  createdAt: '2026-10-26',
  updatedAt: '2026-10-26T01:00:00.000Z',
};
const getTask = Api.tasks.getById as jest.Mock;
/** Fresh element factory avoids React same-element bailout during observer delivery. */
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = (taskId = 'task-a') => (
    <QueryClientProvider client={client}>
      <TaskDetailPanel taskId={taskId} />
    </QueryClientProvider>
  );
  return { client, element };
}
beforeEach(() => {
  jest.clearAllMocks();
  getTask.mockReset().mockResolvedValue(task);
  (Api.tasks.update as jest.Mock).mockReset().mockResolvedValue(task);
  (Api.agents.listAll as jest.Mock).mockResolvedValue([]);
  (Api.boards.getById as jest.Mock).mockResolvedValue({ lists: [] });
  (Api.tasks.getComments as jest.Mock).mockResolvedValue([]);
  (Api.tasks.getMilestones as jest.Mock).mockResolvedValue({
    items: [{ id: 'milestone-a', name: 'Target milestone' }],
  });
  (Api.tasks.getBlockers as jest.Mock).mockResolvedValue([]);
  (Api.tasks.getDependencies as jest.Mock).mockResolvedValue({ blocks: [], dependsOn: [] });
});
it('initial task failure can retry instead of staying in loading', async () => {
  getTask.mockRejectedValue(new Error('Network Error'));
  const { element } = harness();
  render(element());
  const retry = await screen.findByRole('button', { name: 'common.retry' });
  getTask.mockResolvedValue(task);
  fireEvent.click(retry);
  expect(await screen.findByDisplayValue('Server title')).toBeInTheDocument();
});
it('dirty draft survives a failed refresh and a successful retry; changing task initializes a new draft', async () => {
  const { client, element } = harness();
  const view = render(element());
  const title = await screen.findByDisplayValue('Server title');
  fireEvent.change(title, { target: { value: 'My unsaved title' } });
  getTask.mockRejectedValue(new Error('Network Error'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['tasks', 'detail', 'task-a'] });
  });
  expect(await screen.findByRole('status')).toBeInTheDocument();
  expect(screen.getByDisplayValue('My unsaved title')).toBeInTheDocument();
  getTask.mockResolvedValue({ ...task, title: 'New server title' });
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
  await waitFor(() =>
    expect(client.getQueryData(['tasks', 'detail', 'task-a'])).toMatchObject({
      title: 'New server title',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.getByDisplayValue('My unsaved title')).toBeInTheDocument();
  getTask.mockResolvedValue({ ...task, id: 'task-b', title: 'Second task' });
  view.rerender(element('task-b'));
  expect(await screen.findByDisplayValue('Second task')).toBeInTheDocument();
  expect(screen.queryByDisplayValue('My unsaved title')).not.toBeInTheDocument();
});
it('comment error is local, retry does not start inactive activity/dependency queries', async () => {
  (Api.tasks.getComments as jest.Mock).mockRejectedValue(new Error('Network Error'));
  const { element } = harness();
  render(element());
  await screen.findByDisplayValue('Server title');
  fireEvent.click(screen.getByRole('tab', { name: 'tasks.tab.comments' }));
  const retry = await screen.findByRole('button', { name: 'common.retry' });
  expect(screen.queryByText('tasks.comment.empty')).not.toBeInTheDocument();
  (Api.tasks.getComments as jest.Mock).mockResolvedValue([]);
  fireEvent.click(retry);
  expect(await screen.findByText('tasks.comment.empty')).toBeInTheDocument();
  expect(Api.tasks.getActivities).not.toHaveBeenCalled();
  expect(Api.tasks.getDependencies).not.toHaveBeenCalled();
});

it('clean draft follows refreshed server fields', async () => {
  const { client, element } = harness();
  render(element());
  await screen.findByDisplayValue('Server title');
  getTask.mockResolvedValue({ ...task, title: 'Refreshed title' });
  await act(async () => {
    await client.refetchQueries({ queryKey: ['tasks', 'detail', 'task-a'] });
  });
  expect(await screen.findByDisplayValue('Refreshed title')).toBeInTheDocument();
});
it('save accepts the successful normalized response before a pending read can refill old cached fields', async () => {
  const { element } = harness();
  render(element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: ' save me ' },
  });
  (Api.tasks.update as jest.Mock).mockResolvedValue({ ...task, title: 'save me' });
  getTask.mockImplementation(() => new Promise(() => undefined));
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  expect(await screen.findByDisplayValue('save me')).toBeInTheDocument();
  expect(screen.queryByDisplayValue('Server title')).not.toBeInTheDocument();
});
it('typing while save is pending survives successful response acceptance', async () => {
  let resolve!: (value: typeof task) => void;
  (Api.tasks.update as jest.Mock).mockReturnValue(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const { element } = harness();
  render(element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: 'Submitted' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(Api.tasks.update).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByDisplayValue('Submitted'), { target: { value: 'Newer typing' } });
  getTask.mockResolvedValue({ ...task, title: 'Submitted' });
  await act(async () => {
    resolve({ ...task, title: 'Submitted' });
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'common.save' })).not.toBeDisabled(),
  );
  expect(screen.getByDisplayValue('Newer typing')).toBeInTheDocument();
});
it('independent page and panel share one visible stale landing', async () => {
  const { client } = harness();
  render(
    <QueryClientProvider client={client}>
      <TaskDetailPage />
    </QueryClientProvider>,
  );
  await screen.findByDisplayValue('Server title');
  getTask.mockRejectedValue(new Error('Network Error'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['tasks', 'detail', 'task-a'] });
  });
  await screen.findByRole('status');
  expect(screen.getAllByRole('status')).toHaveLength(1);
});

it('failed save reports a local fallback, keeps the draft and permits a successful retry', async () => {
  (Api.tasks.update as jest.Mock).mockRejectedValue(new Error('Network Error'));
  const { element } = harness();
  render(element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: 'Keep my draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: 'tasks.saveFailed' }));
  expect(screen.getByDisplayValue('Keep my draft')).toBeInTheDocument();
  (Api.tasks.update as jest.Mock).mockResolvedValue({ ...task, title: 'Keep my draft' });
  getTask.mockResolvedValue({ ...task, title: 'Keep my draft' });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(Api.tasks.update).toHaveBeenCalledTimes(2));
  expect(toast.error).toHaveBeenCalledTimes(1);
});

it('failed comment keeps the text and retries the same comment', async () => {
  (Api.tasks.addComment as jest.Mock).mockRejectedValue(new Error('Network Error'));
  const { element } = harness();
  render(element());
  await screen.findByDisplayValue('Server title');
  fireEvent.click(screen.getByRole('tab', { name: 'tasks.tab.comments' }));
  fireEvent.change(screen.getByPlaceholderText('tasks.comment.placeholder'), {
    target: { value: 'Keep this comment' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.submit' }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith({ title: 'tasks.comment.addFailed' }),
  );
  expect(screen.getByDisplayValue('Keep this comment')).toBeInTheDocument();
  (Api.tasks.addComment as jest.Mock).mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'common.submit' }));
  await waitFor(() => expect(Api.tasks.addComment).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByPlaceholderText('tasks.comment.placeholder')).toHaveValue(''),
  );
});
it('failed task deletion keeps the task and can be confirmed again', async () => {
  (Api.tasks.delete as jest.Mock).mockRejectedValue({
    response: { status: 500, data: { code: 500, message: 'internal SQL' } },
  });
  const { element } = harness();
  render(element());
  await screen.findByDisplayValue('Server title');
  fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: 'tasks.deleteFailed' }));
  expect(screen.getByDisplayValue('Server title')).toBeInTheDocument();
  (Api.tasks.delete as jest.Mock).mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
  await waitFor(() => expect(Api.tasks.delete).toHaveBeenCalledTimes(2));
});
it('milestone is a dirty local draft and is retained when the unified save fails', async () => {
  getTask.mockResolvedValue({ ...task, boardId: 'board-a' });
  (Api.tasks.update as jest.Mock).mockRejectedValue(new Error('Network Error'));
  const { element } = harness();
  render(element());
  await screen.findByDisplayValue('Server title');
  const select = await screen.findByRole('combobox', { name: 'tasks.form.milestone' });
  await waitFor(() => expect(select).not.toBeDisabled());
  fireEvent.change(select, { target: { value: 'milestone-a' } });
  expect(Api.tasks.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: 'tasks.saveFailed' }));
  expect(select).toHaveValue('milestone-a');
  expect(Api.tasks.update).toHaveBeenCalledWith('task-a', {
    milestoneId: 'milestone-a',
    expectedUpdatedAt: task.updatedAt,
  });
});
it('failed document unlink preserves the existing link and retries', async () => {
  getTask.mockResolvedValue({
    ...task,
    docs: [{ docId: 'doc-a', path: 'kept.md', title: 'Kept document' }],
  });
  (Api.tasks.removeDocLink as jest.Mock).mockRejectedValue(new Error('Network Error'));
  const { element } = harness();
  render(element());
  const remove = await screen.findByRole('button', { name: 'tasks.docs.remove' });
  fireEvent.click(remove);
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith({ title: 'tasks.docs.removeFailed' }),
  );
  expect(screen.getByText('Kept document')).toBeInTheDocument();
  (Api.tasks.removeDocLink as jest.Mock).mockResolvedValue({});
  fireEvent.click(remove);
  await waitFor(() => expect(Api.tasks.removeDocLink).toHaveBeenCalledTimes(2));
});
it('failed dependency unlink preserves the existing dependency and retries', async () => {
  (Api.tasks.getDependencies as jest.Mock).mockResolvedValue([
    {
      id: 'dep-a',
      type: 'blocks',
      dependsOnTaskId: 'other-task',
      dependsOnTask: { id: 'other-task', title: 'Kept dependency', status: 'todo', priority: 'p2' },
    },
  ]);
  (Api.tasks.removeDependency as jest.Mock).mockRejectedValue(new Error('Network Error'));
  const { element } = harness();
  render(element());
  await screen.findByDisplayValue('Server title');
  fireEvent.click(screen.getByRole('tab', { name: 'tasks.tab.dependencies' }));
  const remove = await screen.findByRole('button', { name: 'tasks.dependency.remove' });
  fireEvent.click(remove);
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith({ title: 'tasks.dependency.removeFailed' }),
  );
  expect(screen.getByText('Kept dependency')).toBeInTheDocument();
  (Api.tasks.removeDependency as jest.Mock).mockResolvedValue({});
  fireEvent.click(remove);
  await waitFor(() => expect(Api.tasks.removeDependency).toHaveBeenCalledTimes(2));
});

it('dependency creation uses business error text and keeps the chosen task for retry', async () => {
  (Api.tasks.addDependency as jest.Mock).mockRejectedValue({
    response: { status: 409, data: { code: 4006, message: '  Cycle would be created  ' } },
  });
  const { element } = harness();
  render(element());
  await screen.findByDisplayValue('Server title');
  fireEvent.click(screen.getByRole('tab', { name: 'tasks.tab.dependencies' }));
  fireEvent.click(screen.getByRole('button', { name: 'Pick dependency' }));
  const tab = screen.getByRole('tabpanel');
  const submit = within(tab).getByRole('button', { name: 'common.create' });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith({ title: 'Cycle would be created' }),
  );
  expect(screen.getByRole('button', { name: 'Selected dependency' })).toBeInTheDocument();
  (Api.tasks.addDependency as jest.Mock).mockResolvedValue({});
  fireEvent.click(submit);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Pick dependency' })).toBeInTheDocument(),
  );
  expect(Api.tasks.addDependency).toHaveBeenCalledTimes(2);
});
it('document link creation and linked document open use local fallback and can retry', async () => {
  getTask.mockResolvedValue({
    ...task,
    docs: [{ docId: 'doc-a', path: 'kept.md', title: 'Kept document' }],
  });
  (Api.tasks.addDocLink as jest.Mock).mockRejectedValue(new Error('Network Error'));
  (Api.docs.getDoc as jest.Mock).mockRejectedValue(new Error('Network Error'));
  const { element } = harness();
  render(element());
  await screen.findByDisplayValue('Server title');
  fireEvent.click(screen.getByRole('button', { name: 'Pick doc' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: 'tasks.docs.addFailed' }));
  (Api.tasks.addDocLink as jest.Mock).mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'Pick doc' }));
  await waitFor(() => expect(Api.tasks.addDocLink).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'Kept document' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: 'tasks.docs.openFailed' }));
  expect(screen.getByText('Kept document')).toBeInTheDocument();
  (Api.docs.getDoc as jest.Mock).mockResolvedValue({ spaceId: 'space-a' });
  fireEvent.click(screen.getByRole('button', { name: 'Kept document' }));
  await waitFor(() => expect(Api.docs.getDoc).toHaveBeenCalledTimes(2));
});

/** Deferred promises prove ordering at the observer and actual rendered-input boundary. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const nextToken = '2026-10-26T02:00:00.000Z';
const conflict = {
  response: { status: 409, data: { code: 9001, data: { currentUpdatedAt: nextToken } } },
};

it('sends only changed fields, including explicit clears, and does not write an unchanged form', async () => {
  getTask.mockResolvedValue({
    ...task,
    boardId: 'board-a',
    description: 'Old description',
    assigneeId: 'agent-a',
    milestoneId: 'milestone-a',
  });
  (Api.agents.listAll as jest.Mock).mockResolvedValue([
    { id: 'agent-a', name: 'Agent A', status: 'active' },
  ]);
  render(harness().element());
  await screen.findByDisplayValue('Server title');
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  expect(Api.tasks.update).not.toHaveBeenCalled();
  fireEvent.change(screen.getByDisplayValue('Old description'), { target: { value: '' } });
  const selects = screen.getAllByRole('combobox');
  fireEvent.change(selects[2], { target: { value: '' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'tasks.form.milestone' }), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() =>
    expect(Api.tasks.update).toHaveBeenCalledWith('task-a', {
      description: '',
      assigneeId: null,
      milestoneId: null,
      expectedUpdatedAt: task.updatedAt,
    }),
  );
});
it('dirty background refresh cannot replace the token; conflict needs a successful explicit read and another save', async () => {
  const { client, element } = harness();
  render(element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: 'Local title' },
  });
  getTask.mockResolvedValue({
    ...task,
    title: 'Remote title',
    description: 'Remote description',
    updatedAt: nextToken,
  });
  await act(async () => {
    await client.refetchQueries({ queryKey: ['tasks', 'detail', 'task-a'] });
  });
  (Api.tasks.update as jest.Mock).mockRejectedValue(conflict);
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await screen.findByText('tasks.editor.conflict');
  expect(Api.tasks.update).toHaveBeenLastCalledWith('task-a', {
    title: 'Local title',
    expectedUpdatedAt: task.updatedAt,
  });
  expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  getTask.mockRejectedValue(new Error('read failed'));
  fireEvent.click(screen.getByRole('button', { name: 'tasks.editor.readLatest' }));
  await screen.findByText('tasks.editor.readFailed');
  expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  getTask.mockResolvedValue({
    ...task,
    title: 'Remote title',
    description: 'Remote description',
    updatedAt: nextToken,
  });
  fireEvent.click(screen.getByRole('button', { name: 'tasks.editor.readLatest' }));
  await screen.findByText('tasks.editor.review');
  expect(screen.getByDisplayValue('Local title')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Remote description')).toBeInTheDocument();
  expect(Api.tasks.update).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('tasks.editor.latestValues'));
  expect(within(screen.getByRole('status')).getByText('Remote title')).toBeInTheDocument();
  (Api.tasks.update as jest.Mock).mockResolvedValue({
    ...task,
    title: 'Local title',
    description: 'Remote description',
    updatedAt: '2026-10-26T03:00:00.000Z',
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() =>
    expect(Api.tasks.update).toHaveBeenLastCalledWith('task-a', {
      title: 'Local title',
      expectedUpdatedAt: nextToken,
    }),
  );
});
it.each([
  ['missing token', { ...task, updatedAt: undefined }],
  ['wrong identity', { ...task, id: 'task-b' }],
  ['incomplete editable fields', { ...task, description: undefined }],
])('an explicit read with %s cannot unblock a conflicted save', async (_label, invalid) => {
  render(harness().element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), { target: { value: 'Kept' } });
  (Api.tasks.update as jest.Mock).mockRejectedValue(conflict);
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await screen.findByText('tasks.editor.conflict');
  getTask.mockResolvedValue(invalid);
  fireEvent.click(screen.getByRole('button', { name: 'tasks.editor.readLatest' }));
  await screen.findByText('tasks.editor.readFailed');
  expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  expect(screen.getByDisplayValue('Kept')).toBeInTheDocument();
  expect(Api.tasks.update).toHaveBeenCalledTimes(1);
});
it('read-in-flight edits and reversions are rebased from the original baseline, and feedback survives tab changes', async () => {
  render(harness().element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: 'First edit' },
  });
  (Api.tasks.update as jest.Mock).mockRejectedValue(conflict);
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await screen.findByText('tasks.editor.conflict');
  fireEvent.click(screen.getByRole('tab', { name: 'tasks.tab.comments' }));
  expect(screen.getByText('tasks.editor.conflict')).toBeInTheDocument();
  const read = deferred<typeof task>();
  getTask.mockReturnValue(read.promise);
  fireEvent.click(screen.getByRole('button', { name: 'tasks.editor.readLatest' }));
  fireEvent.click(screen.getByRole('tab', { name: 'tasks.tab.detail' }));
  fireEvent.change(screen.getByDisplayValue('First edit'), { target: { value: 'Server title' } });
  fireEvent.change(screen.getByPlaceholderText('tasks.form.descPlaceholder'), {
    target: { value: 'Typed during read' },
  });
  await act(async () => {
    read.resolve({
      ...task,
      title: 'Latest title',
      description: 'Latest description',
      updatedAt: nextToken,
    });
  });
  await screen.findByText('tasks.editor.review');
  expect(screen.getByDisplayValue('Latest title')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Typed during read')).toBeInTheDocument();
  fireEvent.change(screen.getByDisplayValue('Typed during read'), {
    target: { value: 'Latest description' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  expect(Api.tasks.update).toHaveBeenCalledTimes(1);
});
it('sparse save adopts normalized values and remote untouched fields while retaining only later typing', async () => {
  const save = deferred<typeof task>();
  (Api.tasks.update as jest.Mock).mockReturnValue(save.promise);
  const { element } = harness();
  render(element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: ' Submitted ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(Api.tasks.update).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByPlaceholderText('tasks.form.descPlaceholder'), {
    target: { value: 'Later typing' },
  });
  getTask.mockImplementation(() => new Promise(() => undefined));
  await act(async () => {
    save.resolve({ ...task, title: 'Submitted', labels: ['remote-label'], updatedAt: nextToken });
  });
  expect(await screen.findByDisplayValue('Submitted')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Later typing')).toBeInTheDocument();
  (Api.tasks.update as jest.Mock).mockResolvedValue({
    ...task,
    title: 'Submitted',
    description: 'Later typing',
    labels: ['remote-label'],
    updatedAt: '2026-10-26T03:00:00.000Z',
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() =>
    expect(Api.tasks.update).toHaveBeenLastCalledWith('task-a', {
      description: 'Later typing',
      expectedUpdatedAt: nextToken,
    }),
  );
});
it('a successful write without a new token is read recovery, not a retryable failed write', async () => {
  render(harness().element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: 'Saved title' },
  });
  (Api.tasks.update as jest.Mock).mockResolvedValue({
    ...task,
    title: 'Saved title',
    updatedAt: undefined,
  });
  getTask.mockImplementation(() => new Promise(() => undefined));
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await screen.findByText('tasks.editor.savedNeedsRead');
  expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  expect(toast.error).not.toHaveBeenCalled();
  expect(Api.tasks.update).toHaveBeenCalledTimes(1);
});
it.each([
  { response: { status: 409, data: { code: 9001 } } },
  { response: { status: 409, data: { code: '9001', data: { currentUpdatedAt: nextToken } } } },
  { response: { status: 500, data: { code: 9001, data: { currentUpdatedAt: nextToken } } } },
])('other errors do not enter optimistic conflict recovery', async (error) => {
  render(harness().element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), { target: { value: 'Draft' } });
  (Api.tasks.update as jest.Mock).mockRejectedValue(error);
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('tasks.editor.conflict')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.save' })).not.toBeDisabled();
});
it('a canceled old detail GET really returning after save cannot roll back the accepted version', async () => {
  const { client, element } = harness();
  render(element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: 'New version' },
  });
  const oldRead = deferred<typeof task>();
  getTask
    .mockReturnValueOnce(oldRead.promise)
    .mockImplementation(() => new Promise(() => undefined));
  void client.refetchQueries({ queryKey: ['tasks', 'detail', 'task-a'] });
  await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  (Api.tasks.update as jest.Mock).mockResolvedValue({
    ...task,
    title: 'New version',
    updatedAt: nextToken,
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await screen.findByDisplayValue('New version');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'common.save' })).not.toBeDisabled(),
  );
  await act(async () => {
    oldRead.resolve(task);
  });
  expect(screen.getByDisplayValue('New version')).toBeInTheDocument();
  expect(client.getQueryData(['tasks', 'detail', 'task-a'])).toMatchObject({
    title: 'New version',
    updatedAt: nextToken,
  });
});
it.each(['success', 'failure'])(
  'late task A save %s cannot change task B or emit a late callback/toast',
  async (outcome) => {
    const pending = deferred<typeof task>();
    (Api.tasks.update as jest.Mock).mockReturnValue(pending.promise);
    const { client } = harness();
    const changed = jest.fn();
    const element = (id: string) => (
      <QueryClientProvider client={client}>
        <TaskDetailPanel taskId={id} onChanged={changed} />
      </QueryClientProvider>
    );
    const view = render(element('task-a'));
    fireEvent.change(await screen.findByDisplayValue('Server title'), {
      target: { value: 'A submitted' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(Api.tasks.update).toHaveBeenCalledTimes(1));
    getTask.mockResolvedValue({ ...task, id: 'task-b', title: 'B title' });
    view.rerender(element('task-b'));
    fireEvent.change(await screen.findByDisplayValue('B title'), { target: { value: 'B draft' } });
    await act(async () => {
      if (outcome === 'success')
        pending.resolve({ ...task, title: 'A submitted', updatedAt: nextToken });
      else pending.reject(new Error('late failure'));
    });
    expect(screen.getByDisplayValue('B draft')).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    if (outcome === 'success')
      expect(client.getQueryState(['tasks', 'detail', 'task-a'])?.isInvalidated).toBe(true);
  },
);

it('an initial response without a usable token cannot issue an unlocked write', async () => {
  getTask.mockResolvedValue({ ...task, updatedAt: undefined });
  render(harness().element());
  await screen.findByText('tasks.editor.invalidBaseline');
  fireEvent.change(screen.getByDisplayValue('Server title'), {
    target: { value: 'Keep this draft' },
  });
  expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  expect(Api.tasks.update).not.toHaveBeenCalled();
});
it('task A recovery GET finishing after navigation cannot replace B or emit feedback', async () => {
  const { client, element } = harness();
  const view = render(element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: 'A local edit' },
  });
  (Api.tasks.update as jest.Mock).mockRejectedValue(conflict);
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await screen.findByText('tasks.editor.conflict');
  const read = deferred<typeof task>();
  getTask
    .mockReturnValueOnce(read.promise)
    .mockResolvedValue({ ...task, id: 'task-b', title: 'B title' });
  const readsBeforeRecovery = getTask.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'tasks.editor.readLatest' }));
  await waitFor(() => expect(getTask).toHaveBeenCalledTimes(readsBeforeRecovery + 1));
  expect(getTask).toHaveBeenLastCalledWith('task-a');
  view.rerender(element('task-b'));
  fireEvent.change(await screen.findByDisplayValue('B title'), { target: { value: 'B edit' } });
  await act(async () => {
    read.resolve({ ...task, title: 'A remote title', updatedAt: nextToken });
  });
  expect(screen.getByDisplayValue('B edit')).toBeInTheDocument();
  expect(screen.queryByText('tasks.editor.review')).not.toBeInTheDocument();
  expect(client.getQueryData(['tasks', 'detail', 'task-b'])).toMatchObject({ title: 'B title' });
  expect(toast.error).not.toHaveBeenCalled();
});
it('double Save clicks share one pending write', async () => {
  (Api.tasks.update as jest.Mock).mockImplementation(() => new Promise(() => undefined));
  render(harness().element());
  fireEvent.change(await screen.findByDisplayValue('Server title'), {
    target: { value: 'One write' },
  });
  const save = screen.getByRole('button', { name: 'common.save' });
  fireEvent.click(save);
  fireEvent.click(save);
  await waitFor(() => expect(Api.tasks.update).toHaveBeenCalledTimes(1));
});
