/** Board pagination must preserve a successful cursor and keep request ranges isolated. */
import { fireEvent, render, screen, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BoardDetailPage from './page';
import { Api } from '@/lib/api';
import { toast, confirm } from '@/lib/notify';
jest.mock('@/lib/notify', () => ({
  toast: { error: jest.fn(), warning: jest.fn() },
  confirm: jest.fn().mockResolvedValue(true),
}));
let mockDragHandlers: Record<string, (event?: unknown) => void>;
jest.mock('@dnd-kit/core', () => ({
  ...jest.requireActual('@dnd-kit/core'),
  DndContext: ({ children, ...handlers }: { children: React.ReactNode }) => {
    mockDragHandlers = handlers;
    return <div>{children}</div>;
  },
  DragOverlay: () => null,
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: mockBoardId }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
jest.mock('@/stores/auth.store', () => ({
  useAuthStore: () => ({ user: { id: 'owner', role: 'admin' } }),
}));
jest.mock('@/components/tasks/task-detail-panel', () => ({
  TaskDetailPanel: ({
    taskId,
    onDirtyChange,
    onNavigateTask,
    onNavigateBack,
    showBack,
  }: {
    taskId: string;
    onDirtyChange: (dirty: boolean) => void;
    onNavigateTask: (id: string) => void;
    onNavigateBack: () => void;
    showBack: boolean;
  }) => (
    <div>
      <p>Open panel {taskId}</p>
      <button onClick={() => onDirtyChange(true)}>Make task dirty</button>
      <button onClick={() => onNavigateTask('dependency-task')}>Open dependency</button>
      {showBack && <button onClick={onNavigateBack}>Previous task</button>}
    </div>
  ),
}));

jest.mock('@/lib/api', () => ({
  Api: {
    boards: {
      getById: jest.fn(),
      getListTasks: jest.fn(),
      createList: jest.fn(),
      updateList: jest.fn(),
      deleteList: jest.fn(),
      reorderLists: jest.fn(),
      reorderTasks: jest.fn(),
      update: jest.fn(),
      uninviteAgent: jest.fn(),
      addEditor: jest.fn(),
      removeEditor: jest.fn(),
    },
    agents: { listAll: jest.fn() },
    tasks: {
      getMilestones: jest.fn(),
      getBatchBlockers: jest.fn(),
      create: jest.fn(),
      move: jest.fn(),
    },
    docs: { listSpaces: jest.fn(), createSpace: jest.fn() },
  },
}));
let mockBoardId = 'board-a';
const getListTasks = Api.boards.getListTasks as jest.Mock;
const items = Array.from({ length: 101 }, (_, i) => ({
  id: `task-${i + 1}`,
  title: `Task ${i + 1}`,
  status: 'todo',
  priority: 'p2',
  labels: [],
}));
beforeEach(() => {
  jest.clearAllMocks();
  (confirm as jest.Mock).mockResolvedValue(true);
  mockBoardId = 'board-a';
  (Api.boards.getById as jest.Mock).mockResolvedValue({
    id: 'board-a',
    name: 'Test board',
    creatorId: 'owner',
    lists: [{ id: 'list-a', name: 'Column A' }],
    members: [],
  });
  (Api.agents.listAll as jest.Mock).mockResolvedValue([]);
  (Api.tasks.getMilestones as jest.Mock).mockResolvedValue({ items: [] });
  (Api.tasks.getBatchBlockers as jest.Mock).mockResolvedValue({});
  (Api.docs.listSpaces as jest.Mock).mockResolvedValue({ items: [] });
  getListTasks.mockImplementation(
    (_board, _list, { page = 1, pageSize }: { page?: number; pageSize: number }) =>
      Promise.resolve({
        items: items.slice((page - 1) * pageSize, page * pageSize),
        page,
        hasNext: page * pageSize < items.length,
      }),
  );
});
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <BoardDetailPage />
      </QueryClientProvider>,
    ),
  };
}
it('loads item 101 exactly once with the same page size as the first request', async () => {
  renderPage();
  await screen.findByText('Task 100');
  fireEvent.click(screen.getByRole('button', { name: 'boards.list.loadMore' }));
  expect(await screen.findByText('Task 101')).toBeInTheDocument();
  expect(screen.getAllByText('Task 21')).toHaveLength(1);
  expect(getListTasks).toHaveBeenLastCalledWith(
    'board-a',
    'list-a',
    expect.objectContaining({ page: 2, pageSize: 100 }),
  );
});
it('initial column error is retryable and does not fabricate an empty successful page', async () => {
  getListTasks.mockRejectedValue(new Error('Network Error'));
  renderPage();
  const retry = await screen.findByRole('button', { name: 'common.retry' });
  getListTasks.mockResolvedValue({ items: [items[0]], page: 1, hasNext: false });
  fireEvent.click(retry);
  expect(await screen.findByText('Task 1')).toBeInTheDocument();
});

it('keeps the real MembersSheet mounted while agent candidates are unavailable', async () => {
  (Api.agents.listAll as jest.Mock).mockRejectedValue(new Error('Network Error'));
  renderPage();
  expect(await screen.findByText('Test board')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /boards.members.(permissions|count)/ }));
  expect(await screen.findByText('boards.members.title')).toBeInTheDocument();
  expect(screen.queryByTestId('open-invite')).not.toBeInTheDocument();
});
it('unavailable agents cannot become an empty unassigned-only creation selector', async () => {
  (Api.agents.listAll as jest.Mock).mockRejectedValue(new Error('Network Error'));
  renderPage();
  await screen.findByText('Task 100');
  fireEvent.click(screen.getByRole('button', { name: 'boards.list.addTask' }));
  const selector = await screen.findByRole('combobox', { name: 'tasks.form.assignee' });
  expect(selector).toBeDisabled();
  expect(selector).not.toHaveTextContent('tasks.form.unassigned');
});

it('retains known blocker badges when an expanded batch fails and accepts an explicit false only after retry', async () => {
  (Api.tasks.getBatchBlockers as jest.Mock).mockResolvedValue({ 'task-1': true });
  renderPage();
  await screen.findByTitle('tasks.hasBlockers');
  (Api.tasks.getBatchBlockers as jest.Mock).mockRejectedValue(new Error('new batch failed'));
  fireEvent.click(screen.getByRole('button', { name: 'boards.list.loadMore' }));
  await screen.findByText('Task 101');
  const retry = await screen.findByRole('button', { name: 'common.retry' });
  expect(screen.getByTitle('tasks.hasBlockers')).toBeInTheDocument();
  (Api.tasks.getBatchBlockers as jest.Mock).mockResolvedValue({});
  fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByTitle('tasks.hasBlockers')).not.toBeInTheDocument());
});
it('never carries blocker knowledge across boards even if a task identifier is reused', async () => {
  (Api.tasks.getBatchBlockers as jest.Mock).mockResolvedValue({ 'task-1': true });
  const view = renderPage();
  await screen.findByTitle('tasks.hasBlockers');
  (Api.boards.getById as jest.Mock).mockResolvedValue({
    id: 'board-b',
    name: 'Second board',
    creatorId: 'owner',
    lists: [{ id: 'list-b', name: 'Column B' }],
    members: [],
  });
  getListTasks.mockResolvedValue({ items: [items[0]], page: 1, hasNext: false });
  (Api.tasks.getBatchBlockers as jest.Mock).mockRejectedValue(new Error('new board batch failed'));
  mockBoardId = 'board-b';
  await act(async () => {
    view.rerender(
      <QueryClientProvider client={view.client}>
        <BoardDetailPage />
      </QueryClientProvider>,
    );
  });
  await screen.findByText('Second board');
  await screen.findByRole('button', { name: 'common.retry' });
  expect(screen.queryByTitle('tasks.hasBlockers')).not.toBeInTheDocument();
});

it('candidate refresh error stays visible in the real invite view and successful retry preserves selection', async () => {
  const agents = [{ id: 'candidate', name: 'Available Agent', status: 'active' }];
  (Api.agents.listAll as jest.Mock).mockResolvedValue(agents);
  const { client } = renderPage();
  await screen.findByText('Task 100');
  fireEvent.click(screen.getByRole('button', { name: /boards.members.(permissions|count)/ }));
  fireEvent.click(await screen.findByTestId('open-invite'));
  const checkbox = within(await screen.findByTestId('invite-candidate-candidate')).getByRole(
    'checkbox',
  );
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();
  (Api.agents.listAll as jest.Mock).mockRejectedValue(new Error('Network Error'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['agents', 'list'] });
  });
  const retry = await screen.findByRole('button', { name: 'common.retry' });
  expect(checkbox).toBeChecked();
  (Api.agents.listAll as jest.Mock).mockResolvedValue(agents);
  fireEvent.click(retry);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'common.retry' })).not.toBeInTheDocument(),
  );
  expect(
    within(screen.getByTestId('invite-candidate-candidate')).getByRole('checkbox'),
  ).toBeChecked();
});

/** Sensor events drive the real page's optimistic state; no mocked read helper or cache reset. */
async function drag(kind: 'column' | 'task', targetList = 'list-a') {
  const active = {
    id: kind === 'column' ? 'list-a' : 'task-1',
    data: { current: { type: kind, listId: 'list-a' } },
  };
  const over = {
    id: kind === 'column' ? 'list-b' : targetList === 'list-a' ? 'task-2' : 'task-3',
    data: { current: { listId: targetList } },
  };
  await act(async () => mockDragHandlers.onDragStart({ active }));
  await act(async () => mockDragHandlers.onDragOver({ active, over }));
  await act(async () => mockDragHandlers.onDragEnd({ active, over }));
}
function twoColumns() {
  (Api.boards.getById as jest.Mock).mockResolvedValue({
    id: 'board-a',
    name: 'Test board',
    creatorId: 'owner',
    lists: [
      { id: 'list-a', name: 'Column A', taskCount: 2 },
      { id: 'list-b', name: 'Column B', taskCount: 2 },
    ],
    members: [],
  });
  getListTasks.mockImplementation((_board, list) =>
    Promise.resolve({
      items: list === 'list-a' ? items.slice(0, 2) : items.slice(2, 4),
      page: 1,
      hasNext: false,
    }),
  );
}
it.each([
  ['column', 'list-a', 'reorderLists', 'list.reorderFailed'],
  ['task', 'list-a', 'reorderTasks', 'list.reorderTasksFailed'],
  ['task', 'list-b', 'move', 'list.moveTaskFailed'],
] as const)(
  '%s to %s restores local order after %s fails, without a refetch, and retries',
  async (kind, target, method, fallback) => {
    twoColumns();
    const request = (method === 'move' ? Api.tasks.move : Api.boards[method]) as jest.Mock;
    let reject!: (error: Error) => void;
    request.mockReturnValue(
      new Promise((_, no) => {
        reject = no;
      }),
    );
    renderPage();
    await screen.findByText('Task 4');
    const reads = getListTasks.mock.calls.length;
    await drag(kind, target);
    if (kind === 'column')
      expect(screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent)).toEqual([
        'Column B',
        'Column A',
      ]);
    else
      expect(screen.getAllByText(/^Task [1-4]$/).map((el) => el.textContent)).toEqual(
        target === 'list-a'
          ? ['Task 2', 'Task 1', 'Task 3', 'Task 4']
          : ['Task 2', 'Task 3', 'Task 1', 'Task 4'],
      );
    await act(async () => reject(new Error('Network Error')));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: `boards.${fallback}` }));
    expect(screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent)).toEqual([
      'Column A',
      'Column B',
    ]);
    expect(screen.getAllByText(/^Task [1-4]$/).map((el) => el.textContent)).toEqual([
      'Task 1',
      'Task 2',
      'Task 3',
      'Task 4',
    ]);
    expect(getListTasks).toHaveBeenCalledTimes(reads);
    request.mockResolvedValue({});
    await drag(kind, target);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledTimes(1);
  },
);
it('a pending drag blocks all three drag writes and a late failure cannot restore another board', async () => {
  twoColumns();
  let reject!: (error: Error) => void;
  (Api.boards.reorderLists as jest.Mock).mockReturnValue(
    new Promise((_, no) => {
      reject = no;
    }),
  );
  const view = renderPage();
  await screen.findByText('Task 4');
  await drag('column');
  await act(async () => mockDragHandlers.onDragCancel());
  expect(screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent)).toEqual([
    'Column B',
    'Column A',
  ]);
  await drag('task', 'list-b');
  expect(Api.tasks.move).not.toHaveBeenCalled();
  (Api.boards.getById as jest.Mock).mockResolvedValue({
    id: 'board-b',
    name: 'Second board',
    creatorId: 'owner',
    lists: [{ id: 'list-c', name: 'New range' }],
    members: [],
  });
  getListTasks.mockResolvedValue({ items: [], page: 1, hasNext: false });
  mockBoardId = 'board-b';
  view.rerender(
    <QueryClientProvider client={view.client}>
      <BoardDetailPage />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'New range' });
  await act(async () => reject(new Error('late failure')));
  expect(screen.queryByRole('heading', { name: 'Column A' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'New range' })).toBeInTheDocument();
  expect(toast.error).not.toHaveBeenCalled();
});
it('failed task creation keeps title, description and assignee for the retry', async () => {
  (Api.tasks.create as jest.Mock).mockRejectedValue(new Error('Network Error'));
  (Api.agents.listAll as jest.Mock).mockResolvedValue([
    { id: 'candidate', name: 'Candidate', status: 'active' },
  ]);
  renderPage();
  await screen.findByText('Task 100');
  fireEvent.click(screen.getByRole('button', { name: 'boards.list.addTask' }));
  fireEvent.change(screen.getByPlaceholderText('tasks.form.titlePlaceholder'), {
    target: { value: 'Draft task' },
  });
  fireEvent.change(screen.getByPlaceholderText('tasks.form.descPlaceholder'), {
    target: { value: 'Draft details' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'tasks.form.assignee' }), {
    target: { value: 'candidate' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith({ title: 'boards.list.createTaskFailed' }),
  );
  expect(screen.getByDisplayValue('Draft task')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Draft details')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'tasks.form.assignee' })).toHaveValue('candidate');
  (Api.tasks.create as jest.Mock).mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
  await waitFor(() => expect(screen.queryByDisplayValue('Draft task')).not.toBeInTheDocument());
  expect(Api.tasks.create).toHaveBeenCalledTimes(2);
});
it.each([
  [
    'createList',
    'boards.list.addColumn',
    'boards.list.namePlaceholder',
    'common.create',
    'boards.list.createFailed',
  ],
  [
    'createSpace',
    'boards.docs.bind',
    'boards.docs.namePlaceholder',
    'common.create',
    'boards.docs.createFailed',
  ],
] as const)(
  '%s failure retains the name and retries',
  async (method, trigger, placeholder, action, fallback) => {
    const request = (
      method === 'createList' ? Api.boards.createList : Api.docs.createSpace
    ) as jest.Mock;
    request.mockRejectedValue(new Error('Network Error'));
    renderPage();
    await screen.findByText('Task 100');
    fireEvent.click(screen.getByRole('button', { name: trigger }));
    fireEvent.change(await screen.findByPlaceholderText(placeholder), {
      target: { value: 'Keep this name' },
    });
    fireEvent.click(screen.getByRole('button', { name: action }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: fallback }));
    expect(screen.getByDisplayValue('Keep this name')).toBeInTheDocument();
    request.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: action }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue('Keep this name')).not.toBeInTheDocument(),
    );
    expect(request).toHaveBeenCalledTimes(2);
  },
);
it('failed list rename retains edited name and status binding for retry', async () => {
  (Api.boards.updateList as jest.Mock).mockRejectedValue(new Error('Network Error'));
  renderPage();
  await screen.findByText('Task 100');
  fireEvent.click(screen.getByRole('button', { name: 'boards.list.edit' }));
  fireEvent.change(screen.getByPlaceholderText('boards.list.namePlaceholder'), {
    target: { value: 'Renamed list' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith({ title: 'boards.list.updateFailed' }),
  );
  expect(screen.getByDisplayValue('Renamed list')).toBeInTheDocument();
  (Api.boards.updateList as jest.Mock).mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(screen.queryByDisplayValue('Renamed list')).not.toBeInTheDocument());
  expect(Api.boards.updateList).toHaveBeenCalledTimes(2);
});
it('failed list deletion retains the transfer destination and retries', async () => {
  twoColumns();
  (Api.boards.deleteList as jest.Mock).mockRejectedValue(new Error('Network Error'));
  renderPage();
  await screen.findByText('Task 4');
  const column = screen.getByRole('heading', { name: 'Column A' }).parentElement!.parentElement!
    .parentElement!.parentElement!;
  fireEvent.click(within(column).getByRole('button', { name: 'boards.list.delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'boards.list.confirmDeleteAndTransfer' }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith({ title: 'boards.list.deleteFailed' }),
  );
  expect(screen.getByRole('radio', { name: 'Column B' })).toBeChecked();
  (Api.boards.deleteList as jest.Mock).mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'boards.list.confirmDeleteAndTransfer' }));
  await waitFor(() =>
    expect(screen.queryByRole('radio', { name: 'Column B' })).not.toBeInTheDocument(),
  );
  expect(Api.boards.deleteList).toHaveBeenCalledTimes(2);
});

it.each([
  ['uninviteAgent', 'member', 'members.remove'],
  ['addEditor', 'member', 'boards.members.setEditor'],
  ['removeEditor', 'editor', 'members.remove'],
] as const)(
  '%s failure keeps the real member row and retries from its menu',
  async (method, role, action) => {
    (Api.boards.getById as jest.Mock).mockResolvedValue({
      id: 'board-a',
      name: 'Test board',
      creatorId: 'owner',
      lists: [],
      members: [{ id: 'actor-a', name: 'Kept member', type: 'agent', role }],
    });
    const request = Api.boards[method] as jest.Mock;
    request.mockRejectedValue(new Error('Network Error'));
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: /boards.members.(permissions|count)/ }),
    );
    const perform = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'members.menuAria' }));
      fireEvent.click(screen.getByRole('menuitem', { name: action }));
      if (action === 'members.remove')
        fireEvent.click(
          within(await screen.findByRole('alertdialog')).getByRole('button', { name: action }),
        );
    };
    await perform();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith({ title: 'boards.members.actionFailed' }),
    );
    expect(screen.getByText('Kept member')).toBeInTheDocument();
    request.mockResolvedValue({});
    await perform();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledTimes(1);
  },
);
it('board settings helper reports a business 4xx once, keeps the draft and retries', async () => {
  (Api.boards.update as jest.Mock).mockRejectedValue({
    response: { status: 409, data: { code: 3002, message: '  Actionable\nreason  ' } },
  });
  renderPage();
  await screen.findByText('Task 100');
  fireEvent.click(screen.getByRole('button', { name: 'boards.settings.title' }));
  fireEvent.change(screen.getByDisplayValue('Test board'), {
    target: { value: 'Keep settings name' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: 'Actionable reason' }));
  expect(screen.getByDisplayValue('Keep settings name')).toBeInTheDocument();
  (Api.boards.update as jest.Mock).mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() =>
    expect(screen.queryByDisplayValue('Keep settings name')).not.toBeInTheDocument(),
  );
  expect(Api.boards.update).toHaveBeenCalledTimes(2);
});
it('late drag failure does not restore tasks hidden by a newly selected local milestone filter', async () => {
  twoColumns();
  let reject!: (error: Error) => void;
  (Api.boards.reorderTasks as jest.Mock).mockReturnValue(
    new Promise((_, no) => {
      reject = no;
    }),
  );
  (Api.tasks.getMilestones as jest.Mock).mockResolvedValue({
    items: [{ id: 'm-a', name: 'Empty milestone' }],
  });
  renderPage();
  await screen.findByText('Task 4');
  await drag('task');
  const filter = screen.getByRole('option', { name: 'Empty milestone' }).parentElement!;
  fireEvent.change(filter, { target: { value: 'm-a' } });
  await waitFor(() => expect(screen.queryByText('Task 1')).not.toBeInTheDocument());
  await act(async () => reject(new Error('late failure')));
  expect(screen.queryByText('Task 1')).not.toBeInTheDocument();
  expect(screen.queryByText('Task 2')).not.toBeInTheDocument();
  expect(filter).toHaveValue('m-a');
  expect(toast.error).not.toHaveBeenCalled();
});

it.each([
  ['column', 'list-a', 'reorderLists'],
  ['task', 'list-a', 'reorderTasks'],
  ['task', 'list-b', 'move'],
] as const)(
  'late successful %s write after a local filter change still refreshes its server owner',
  async (kind, target, method) => {
    twoColumns();
    let resolve!: (value: unknown) => void;
    const request = (method === 'move' ? Api.tasks.move : Api.boards[method]) as jest.Mock;
    request.mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const view = renderPage();
    await screen.findByText('Task 4');
    await drag(kind, target);
    const milestoneFilter = screen.getByRole('option', {
      name: 'boards.filter.unassigned',
    }).parentElement!;
    fireEvent.change(milestoneFilter, { target: { value: 'none' } });
    await waitFor(() => expect(milestoneFilter).toHaveValue('none'));
    const invalidate = jest.spyOn(view.client, 'invalidateQueries');
    if (method === 'reorderLists') {
      (Api.boards.getById as jest.Mock).mockResolvedValue({
        id: 'board-a',
        name: 'Test board',
        creatorId: 'owner',
        lists: [
          { id: 'list-b', name: 'Column B' },
          { id: 'list-a', name: 'Column A' },
        ],
        members: [],
      });
    } else {
      getListTasks.mockImplementation((_board, list) =>
        Promise.resolve({
          items:
            list === 'list-a'
              ? method === 'move'
                ? [items[1]]
                : [items[1], items[0]]
              : method === 'move'
                ? [items[2], items[0], items[3]]
                : items.slice(2, 4),
          page: 1,
          hasNext: false,
        }),
      );
    }
    await act(async () => resolve({}));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['boards', 'detail', 'board-a'] }),
    );
    if (method === 'reorderLists') {
      await waitFor(() =>
        expect(screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent)).toEqual([
          'Column B',
          'Column A',
        ]),
      );
    } else {
      await waitFor(() =>
        expect(screen.getAllByText(/^Task [1-4]$/).map((el) => el.textContent)).toEqual(
          method === 'move'
            ? ['Task 2', 'Task 3', 'Task 1', 'Task 4']
            : ['Task 2', 'Task 1', 'Task 3', 'Task 4'],
        ),
      );
    }
    expect(milestoneFilter).toHaveValue('none');
    expect(toast.error).not.toHaveBeenCalled();
  },
);
it('late successful move after switching boards invalidates the original board and never reads new-board columns', async () => {
  twoColumns();
  let resolve!: (value: unknown) => void;
  (Api.tasks.move as jest.Mock).mockReturnValue(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const view = renderPage();
  await screen.findByText('Task 4');
  await drag('task', 'list-b');
  (Api.boards.getById as jest.Mock).mockResolvedValue({
    id: 'board-b',
    name: 'Second board',
    creatorId: 'owner',
    lists: [{ id: 'list-c', name: 'New range' }],
    members: [],
  });
  getListTasks.mockResolvedValue({ items: [], page: 1, hasNext: false });
  mockBoardId = 'board-b';
  view.rerender(
    <QueryClientProvider client={view.client}>
      <BoardDetailPage />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'New range' });
  await waitFor(() =>
    expect(getListTasks).toHaveBeenCalledWith('board-b', 'list-c', expect.anything()),
  );
  const readCount = getListTasks.mock.calls.length;
  const invalidate = jest.spyOn(view.client, 'invalidateQueries');
  await act(async () => resolve({}));
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['boards', 'detail', 'board-a'] }),
  );
  expect(view.client.getQueryState(['boards', 'detail', 'board-a'])?.isInvalidated).toBe(true);
  expect(getListTasks).toHaveBeenCalledTimes(readCount);
  expect(screen.getByRole('heading', { name: 'New range' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Column A' })).not.toBeInTheDocument();
  expect(Api.tasks.move).toHaveBeenCalledWith('task-1', {
    listId: 'list-b',
    order: expect.any(Number),
  });
});

it.each(['task', 'column'] as const)(
  'rapid %s start/over/end in one batch submits the exact visible order',
  async (kind) => {
    twoColumns();
    const request = (
      kind === 'task' ? Api.boards.reorderTasks : Api.boards.reorderLists
    ) as jest.Mock;
    request.mockImplementation(() => new Promise(() => undefined));
    renderPage();
    await screen.findByText('Task 4');
    const handlers = mockDragHandlers;
    const active = {
      id: kind === 'task' ? 'task-1' : 'list-a',
      data: { current: { type: kind, listId: 'list-a' } },
    };
    const over = {
      id: kind === 'task' ? 'task-2' : 'list-b',
      data: { current: { listId: kind === 'task' ? 'list-a' : 'list-b' } },
    };
    await act(async () => {
      handlers.onDragStart({ active });
      handlers.onDragOver({ active, over });
      handlers.onDragEnd({ active, over });
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    if (kind === 'task') {
      expect(request).toHaveBeenCalledWith('list-a', {
        tasks: [
          { id: 'task-2', position: 0 },
          { id: 'task-1', position: 1 },
        ],
      });
      expect(screen.getAllByText(/^Task [1-4]$/).map((el) => el.textContent)).toEqual([
        'Task 2',
        'Task 1',
        'Task 3',
        'Task 4',
      ]);
    } else {
      expect(request).toHaveBeenCalledWith('board-a', {
        lists: [
          { id: 'list-b', position: 0 },
          { id: 'list-a', position: 1 },
        ],
      });
      expect(screen.getAllByRole('heading', { level: 3 }).map((el) => el.textContent)).toEqual([
        'Column B',
        'Column A',
      ]);
    }
  },
);
it('a retained old End callback submits the latest logical task order after Over commits', async () => {
  twoColumns();
  (Api.boards.reorderTasks as jest.Mock).mockImplementation(() => new Promise(() => undefined));
  renderPage();
  await screen.findByText('Task 4');
  const oldEnd = mockDragHandlers.onDragEnd;
  const active = { id: 'task-1', data: { current: { type: 'task', listId: 'list-a' } } };
  const over = { id: 'task-2', data: { current: { listId: 'list-a' } } };
  await act(async () => mockDragHandlers.onDragStart({ active }));
  await act(async () => mockDragHandlers.onDragOver({ active, over }));
  expect(screen.getAllByText(/^Task [1-4]$/).map((el) => el.textContent)).toEqual([
    'Task 2',
    'Task 1',
    'Task 3',
    'Task 4',
  ]);
  await act(async () => oldEnd({ active, over }));
  await waitFor(() =>
    expect(Api.boards.reorderTasks).toHaveBeenCalledWith('list-a', {
      tasks: [
        { id: 'task-2', position: 0 },
        { id: 'task-1', position: 1 },
      ],
    }),
  );
});
it.each([
  ['first', 'task-3', true, 0, ['Task 2', 'Task 1', 'Task 3', 'Task 4']],
  ['middle', 'task-3', false, 1, ['Task 2', 'Task 3', 'Task 1', 'Task 4']],
  ['last', 'task-4', false, 2, ['Task 2', 'Task 3', 'Task 4', 'Task 1']],
] as const)(
  'rapid cross-column drop at %s sends the actual visible active index',
  async (_position, overId, moveBefore, expectedIndex, visibleOrder) => {
    twoColumns();
    (Api.tasks.move as jest.Mock).mockImplementation(() => new Promise(() => undefined));
    renderPage();
    await screen.findByText('Task 4');
    const handlers = mockDragHandlers;
    const active = { id: 'task-1', data: { current: { type: 'task', listId: 'list-a' } } };
    const over = { id: overId, data: { current: { listId: 'list-b' } } };
    await act(async () => {
      handlers.onDragStart({ active });
      handlers.onDragOver({ active, over });
      // Moving upward within the target column must locate active in the latest logical array,
      // even when the sensor still holds its original listId and no render occurred in between.
      if (moveBefore) handlers.onDragOver({ active, over });
      handlers.onDragEnd({ active, over });
    });
    await waitFor(() => expect(Api.tasks.move).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText(/^Task [1-4]$/).map((el) => el.textContent)).toEqual(visibleOrder);
    expect(Api.tasks.move).toHaveBeenCalledWith('task-1', {
      listId: 'list-b',
      order: expectedIndex,
    });
  },
);

/** The real Board owns navigation and its shared discard confirmation; the panel only reports intent. */
it('dirty task stack forward/back cancellation preserves the current task, and confirmation discards without writing', async () => {
  (confirm as jest.Mock).mockResolvedValue(false);
  renderPage();
  fireEvent.click(await screen.findByText('Task 1'));
  await screen.findByText('Open panel task-1');
  fireEvent.click(screen.getByRole('button', { name: 'Make task dirty' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open dependency' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(confirm).toHaveBeenLastCalledWith({
    title: 'boards.unsavedConfirm',
    description: 'boards.unsavedDescription',
    confirmText: 'common.confirm',
    cancelText: 'common.cancel',
  });
  expect(screen.getByText('Open panel task-1')).toBeInTheDocument();
  (confirm as jest.Mock).mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open dependency' }));
  await screen.findByText('Open panel dependency-task');
  fireEvent.click(screen.getByRole('button', { name: 'Make task dirty' }));
  (confirm as jest.Mock).mockResolvedValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Previous task' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(3));
  expect(screen.getByText('Open panel dependency-task')).toBeInTheDocument();
  (confirm as jest.Mock).mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Previous task' }));
  await screen.findByText('Open panel task-1');
  expect(Api.tasks.create).not.toHaveBeenCalled();
  expect(Api.tasks.move).not.toHaveBeenCalled();
});

it('dirty close cancellation keeps the drawer; confirmed discard closes without a task write', async () => {
  renderPage();
  fireEvent.click(await screen.findByText('Task 1'));
  await screen.findByText('Open panel task-1');
  fireEvent.click(screen.getByRole('button', { name: 'Make task dirty' }));
  (confirm as jest.Mock).mockResolvedValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(confirm).toHaveBeenLastCalledWith({
    title: 'boards.unsavedConfirm',
    description: 'boards.unsavedDescription',
    confirmText: 'common.confirm',
    cancelText: 'common.cancel',
  });
  expect(screen.getByText('Open panel task-1')).toBeInTheDocument();
  (confirm as jest.Mock).mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
  await waitFor(() => expect(screen.queryByText('Open panel task-1')).not.toBeInTheDocument());
  expect(Api.tasks.create).not.toHaveBeenCalled();
  expect(Api.tasks.move).not.toHaveBeenCalled();
});
