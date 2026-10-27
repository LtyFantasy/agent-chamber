/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念] 看板每列分页的成功快照与并发读取代际
 * [代码职责] 三条读取路径共享局部页长、成功游标、列级反馈和迟到响应保护。
 * [权威文档] DocSpace Agent Chamber: docs/frontend/frontend-architecture.md §12。
 * [关键不变量] board/status/pageSize 隔离；list 成员变化不清兄弟列；固定页长100；
 *   同列 refresh 使旧 append 失效，失败不改成功游标；scope/member/state refs 只在
 *   提交阶段发布，不能让被 Suspense 放弃的 render 作废仍在显示的请求。
 * [关联代码] app/(main)/boards/[id]/page.tsx；use-board-task-columns.test.tsx。
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Api } from '@/lib/api';
import type { TaskSummary } from '@/types';

/** All three request paths must use the same size to keep page numbers contiguous. */
const COLUMN_PAGE_SIZE = 100;

/** Last successful values and request feedback belong to exactly one board/list/status range. */
interface ColumnReadState {
  /** Identity includes page size so cursors cannot be reused across incompatible requests. */
  scope: string;
  /** Presence, including [], means this column has completed a successful read. */
  tasks: Record<string, TaskSummary[]>;
  /** Cursor changes only together with a successful response. */
  pagination: Record<string, { page: number; hasNext: boolean }>;
  /** Remember whether retry should repeat a failed append or replace page one. */
  errors: Record<string, { error: unknown; append: boolean } | undefined>;
  /** Per-column pending state also disables duplicate load-more/retry clicks. */
  pending: Record<string, boolean>;
}

/** Empty state is a range transition, never a substitute for a failed successful-range refresh. */
function emptyRange(scope: string): ColumnReadState {
  return { scope, tasks: {}, pagination: {}, errors: {}, pending: {} };
}

/**
 * Local Board reader: preserve each successful column independently and invalidate late responses.
 * Refresh always starts a new generation, including when an append is still in flight.
 */
export function useBoardTaskColumns(boardId: string, listIds: string[], status?: string) {
  const idsKey = JSON.stringify([...listIds].sort());
  const scope = JSON.stringify([boardId, status ?? null, COLUMN_PAGE_SIZE]);
  const [state, setState] = useState<ColumnReadState>(() => emptyRange(scope));
  const stateRef = useRef(state);
  // Only committed renders may publish state to asynchronous request continuations.
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const mountedRef = useRef(true);
  const rangeRef = useRef({ scope, epoch: 0 });
  /** Membership epochs isolate removed/re-added columns without invalidating sibling reads. */
  const memberEpochsRef = useRef<Record<string, number>>({});
  const membersRef = useRef(new Set<string>());
  useLayoutEffect(() => {
    // A suspended or abandoned candidate render must not invalidate the still-committed reader.
    if (rangeRef.current.scope !== scope) {
      rangeRef.current = { scope, epoch: rangeRef.current.epoch + 1 };
    }
    const members: string[] = JSON.parse(idsKey);
    const nextMembers = new Set(members);
    for (const listId of new Set([...membersRef.current, ...nextMembers])) {
      if (membersRef.current.has(listId) !== nextMembers.has(listId)) {
        memberEpochsRef.current[listId] = (memberEpochsRef.current[listId] ?? 0) + 1;
      }
    }
    membersRef.current = nextMembers;
  }, [scope, idsKey]);
  const requestedRangeRef = useRef({ scope: '', ids: new Set<string>() });
  const serialRef = useRef(0);
  const generationsRef = useRef<Record<string, number>>({});
  const pendingRef = useRef<Record<string, number>>({});

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Read one column. A stale response must change neither items, cursor, error nor pending. */
  const read = useCallback(
    async (listId: string, append = false) => {
      const range = rangeRef.current;
      if (range.scope !== scope || !boardId || !membersRef.current.has(listId)) return;
      const memberEpoch = memberEpochsRef.current[listId];
      const pendingKey = `${range.epoch}:${listId}`;
      if (append && pendingRef.current[pendingKey] !== undefined) return;
      const previous = stateRef.current.scope === scope ? stateRef.current : emptyRange(scope);
      if (append && !previous.pagination[listId]?.hasNext) return;
      const page = append ? previous.pagination[listId].page + 1 : 1;
      const generation = ++serialRef.current;
      generationsRef.current[listId] = generation;
      pendingRef.current[pendingKey] = generation;
      const current = () =>
        mountedRef.current &&
        rangeRef.current.epoch === range.epoch &&
        rangeRef.current.scope === scope &&
        generationsRef.current[listId] === generation &&
        membersRef.current.has(listId) &&
        memberEpochsRef.current[listId] === memberEpoch;
      setState((old) => ({
        ...(old.scope === scope ? old : emptyRange(scope)),
        pending: { ...(old.scope === scope ? old.pending : {}), [listId]: true },
      }));
      try {
        const result = await Api.boards.getListTasks(boardId, listId, {
          status,
          page,
          pageSize: COLUMN_PAGE_SIZE,
        });
        if (!current()) return;
        setState((old) => {
          const good = old.scope === scope ? old : emptyRange(scope);
          return {
            ...good,
            tasks: {
              ...good.tasks,
              [listId]: append ? [...(good.tasks[listId] ?? []), ...result.items] : result.items,
            },
            pagination: {
              ...good.pagination,
              [listId]: { page: result.page, hasNext: result.hasNext },
            },
            errors: { ...good.errors, [listId]: undefined },
          };
        });
      } catch (error) {
        if (!current()) return;
        setState((old) => ({ ...old, errors: { ...old.errors, [listId]: { error, append } } }));
      } finally {
        // A late request may release only its own lock, never a newer request or UI state.
        if (pendingRef.current[pendingKey] === generation) delete pendingRef.current[pendingKey];
        if (current()) {
          setState((old) => ({ ...old, pending: { ...old.pending, [listId]: false } }));
        }
      }
    },
    [boardId, scope, status],
  );

  useEffect(() => {
    const ids: string[] = JSON.parse(idsKey);
    const previous = requestedRangeRef.current;
    const rangeChanged = previous.scope !== scope;
    requestedRangeRef.current = { scope, ids: new Set(ids) };
    setState((old) => {
      if (old.scope !== scope) return emptyRange(scope);
      const keep = <T>(entries: Record<string, T>) =>
        Object.fromEntries(Object.entries(entries).filter(([id]) => ids.includes(id)));
      return {
        ...old,
        tasks: keep(old.tasks),
        pagination: keep(old.pagination),
        errors: keep(old.errors),
        pending: keep(old.pending),
      };
    });
    ids.forEach((listId) => {
      if (rangeChanged || !previous.ids.has(listId)) void read(listId);
    });
  }, [scope, idsKey, read]);

  const visible = useMemo(() => {
    if (state.scope !== scope) return emptyRange(scope);
    const ids: string[] = JSON.parse(idsKey);
    const keep = <T>(entries: Record<string, T>) =>
      Object.fromEntries(Object.entries(entries).filter(([id]) => ids.includes(id)));
    return {
      ...state,
      tasks: keep(state.tasks),
      pagination: keep(state.pagination),
      errors: keep(state.errors),
      pending: keep(state.pending),
    };
  }, [state, scope, idsKey]);
  /** Retry preserves the successful page and repeats the exact failed append when applicable. */
  const retry = (listId: string) => read(listId, visible.errors[listId]?.append ?? false);
  return { ...visible, refresh: read, loadMore: (listId: string) => read(listId, true), retry };
}
