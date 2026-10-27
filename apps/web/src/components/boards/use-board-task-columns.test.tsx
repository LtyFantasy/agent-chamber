/** Actual React effects and deferred responses cover the Board reader's races and cursors. */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useBoardTaskColumns } from './use-board-task-columns';
import { Api } from '@/lib/api';
import { Suspense, startTransition, useState } from 'react';
import type { TaskSummary } from '@/types';

jest.mock('@/lib/api', () => ({ Api: { boards: { getListTasks: jest.fn() } } }));
const request = Api.boards.getListTasks as jest.Mock;
/** Responses deliberately keep item identifiers distinct so late writes are observable. */
function page(id: string, page = 1, hasNext = false) {
  return {
    items: [{ id, title: id, status: 'todo', priority: 'p2' } as TaskSummary],
    page,
    hasNext,
  };
}
/** Externally settled transport lets tests choose completion order rather than relying on timers. */
function deferred() {
  let resolve!: (value: ReturnType<typeof page>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof page>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  jest.resetAllMocks();
});
it('keeps successful siblings when another column initially fails, and retries only that column', async () => {
  request.mockImplementation((_board, list) =>
    list === 'a' ? Promise.resolve(page('good')) : Promise.reject(new Error('down')),
  );
  const { result } = renderHook(() => useBoardTaskColumns('board', ['a', 'b']));
  await waitFor(() => expect(result.current.errors.b).toBeDefined());
  expect(result.current.tasks.a[0].id).toBe('good');
  expect(result.current.tasks.b).toBeUndefined();
  request.mockResolvedValue(page('recovered'));
  await act(async () => {
    await result.current.retry('b');
  });
  expect(result.current.tasks.a[0].id).toBe('good');
  expect(result.current.tasks.b[0].id).toBe('recovered');
  expect(request.mock.calls.filter((call) => call[1] === 'a')).toHaveLength(1);
});
it('deduplicates same-column append and retries a failed append at the same successful cursor', async () => {
  request.mockResolvedValue(page('first', 1, true));
  const { result } = renderHook(() => useBoardTaskColumns('board', ['a']));
  await waitFor(() => expect(result.current.pagination.a?.page).toBe(1));
  const pending = deferred();
  request.mockReturnValue(pending.promise);
  let one!: Promise<void>;
  let two!: Promise<void>;
  act(() => {
    one = result.current.loadMore('a');
    two = result.current.loadMore('a');
  });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => {
    pending.reject(new Error('down'));
    await Promise.all([one, two]);
  });
  expect(result.current.tasks.a.map((item) => item.id)).toEqual(['first']);
  expect(result.current.pagination.a).toEqual({ page: 1, hasNext: true });
  request.mockResolvedValue(page('second', 2, false));
  await act(async () => {
    await result.current.retry('a');
  });
  expect(request).toHaveBeenLastCalledWith('board', 'a', {
    status: undefined,
    page: 2,
    pageSize: 100,
  });
  expect(result.current.tasks.a.map((item) => item.id)).toEqual(['first', 'second']);
});
it.each(['success', 'error'])(
  'ignores a late old-status %s including its loading/error effects',
  async (completion) => {
    const old = deferred();
    const fresh = deferred();
    request.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { result, rerender } = renderHook(
      ({ status }) => useBoardTaskColumns('board', ['a'], status),
      { initialProps: { status: 'todo' } },
    );
    rerender({ status: 'done' });
    expect(result.current.tasks.a).toBeUndefined();
    await act(async () => {
      if (completion === 'success') old.resolve(page('old'));
      else old.reject(new Error('old error'));
      await old.promise.catch(() => undefined);
    });
    expect(result.current.pending.a).toBe(true);
    expect(result.current.tasks.a).toBeUndefined();
    expect(result.current.errors.a).toBeUndefined();
    await act(async () => {
      fresh.resolve(page('new'));
      await fresh.promise;
    });
    expect(result.current.tasks.a[0].id).toBe('new');
  },
);
it.each(['success', 'error'])(
  'refresh supersedes a pending append %s without changing its new pending state',
  async (completion) => {
    request.mockResolvedValueOnce(page('first', 1, true));
    const { result } = renderHook(() => useBoardTaskColumns('board', ['a']));
    await waitFor(() => expect(result.current.pagination.a?.page).toBe(1));
    const append = deferred();
    const refresh = deferred();
    request.mockReturnValueOnce(append.promise).mockReturnValueOnce(refresh.promise);
    let appended!: Promise<void>;
    let refreshed!: Promise<void>;
    act(() => {
      appended = result.current.loadMore('a');
      refreshed = result.current.refresh('a');
    });
    await act(async () => {
      if (completion === 'success') append.resolve(page('obsolete append', 2));
      else append.reject(new Error('obsolete error'));
      await appended;
    });
    expect(result.current.pending.a).toBe(true);
    expect(result.current.errors.a).toBeUndefined();
    expect(result.current.tasks.a[0].id).toBe('first');
    await act(async () => {
      refresh.resolve(page('replacement', 1, true));
      await refreshed;
    });
    expect(result.current.tasks.a.map((item) => item.id)).toEqual(['replacement']);
    expect(result.current.pagination.a.page).toBe(1);
  },
);
it('changes board/list identity without accepting an old board completion', async () => {
  const old = deferred();
  request.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page('new board'));
  const { result, rerender } = renderHook(({ board, ids }) => useBoardTaskColumns(board, ids), {
    initialProps: { board: 'old', ids: ['a'] },
  });
  rerender({ board: 'new', ids: ['b'] });
  await waitFor(() => expect(result.current.tasks.b?.[0].id).toBe('new board'));
  await act(async () => {
    old.resolve(page('old board'));
    await old.promise;
  });
  expect(result.current.tasks.a).toBeUndefined();
  expect(result.current.tasks.b[0].id).toBe('new board');
});
it('adding/removing a sibling preserves last-good data and does not refetch the existing column', async () => {
  request.mockResolvedValueOnce(page('retained'));
  const { result, rerender } = renderHook(({ ids }) => useBoardTaskColumns('board', ids), {
    initialProps: { ids: ['a'] },
  });
  await waitFor(() => expect(result.current.tasks.a?.[0].id).toBe('retained'));
  request.mockRejectedValue(new Error('new column unavailable'));
  rerender({ ids: ['a', 'b'] });
  await waitFor(() => expect(result.current.errors.b).toBeDefined());
  expect(result.current.tasks.a[0].id).toBe('retained');
  expect(request.mock.calls.filter((call) => call[1] === 'a')).toHaveLength(1);
  rerender({ ids: ['a'] });
  expect(result.current.tasks.a[0].id).toBe('retained');
  expect(result.current.errors.b).toBeUndefined();
});
it('successful empty data stays successful and keeps its cursor when refresh fails', async () => {
  request.mockResolvedValue({ items: [], page: 1, hasNext: false });
  const { result } = renderHook(() => useBoardTaskColumns('board', ['a']));
  await waitFor(() => expect(result.current.tasks.a).toEqual([]));
  request.mockRejectedValue(new Error('down'));
  await act(async () => {
    await result.current.refresh('a');
  });
  expect(result.current.tasks.a).toEqual([]);
  expect(result.current.pagination.a).toEqual({ page: 1, hasNext: false });
  expect(result.current.errors.a).toBeDefined();
});
it('ignores a removed/re-added column response even if its range string is unchanged', async () => {
  const old = deferred();
  request.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page('new membership'));
  const { result, rerender } = renderHook(({ ids }) => useBoardTaskColumns('board', ids), {
    initialProps: { ids: ['a'] },
  });
  rerender({ ids: [] });
  rerender({ ids: ['a'] });
  await waitFor(() => expect(result.current.tasks.a?.[0].id).toBe('new membership'));
  await act(async () => {
    old.resolve(page('old membership'));
    await old.promise;
  });
  expect(result.current.tasks.a[0].id).toBe('new membership');
});

it('an abandoned suspended candidate render cannot invalidate the committed range request', async () => {
  const committedRequest = deferred();
  request.mockReturnValue(committedRequest.promise);
  const never = new Promise<void>(() => undefined);
  let attempted = false;
  let changeRange!: () => void;
  function Reader({ board }: { board: string }) {
    const reads = useBoardTaskColumns(board, ['a']);
    if (board === 'candidate') {
      attempted = true;
      throw never;
    }
    return (
      <div>
        {reads.pending.a
          ? 'Committed range pending'
          : (reads.tasks.a?.[0]?.id ?? 'No committed result')}
      </div>
    );
  }
  function Harness() {
    const [board, setBoard] = useState('committed');
    changeRange = () => startTransition(() => setBoard('candidate'));
    return (
      <Suspense fallback={<p>Uncommitted fallback</p>}>
        <Reader board={board} />
      </Suspense>
    );
  }
  render(<Harness />);
  await screen.findByText('Committed range pending');
  await act(async () => {
    changeRange();
  });
  expect(attempted).toBe(true);
  expect(screen.queryByText('Uncommitted fallback')).not.toBeInTheDocument();
  await act(async () => {
    committedRequest.resolve(page('Committed successful result'));
    await committedRequest.promise;
  });
  expect(await screen.findByText('Committed successful result')).toBeInTheDocument();
  expect(screen.queryByText('Committed range pending')).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});
