'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Hument Usage **trace 折叠懒加载 + cursor 分页**的会话状态机
 *
 * [代码职责]
 *   - 首次展开只发**恰好一次**首页请求（成功/失败都不自动重试）
 *   - load-more 三态（idle/loading/error）：第二页失败保留已加载行并允许重试
 *   - 游标复位（502/14004 `cursor_reset_required`）：保留旧行、重拉首页一次；
 *     第二次仍复位则停止（有界，不无限循环）
 *   - 过滤器/项目变化时丢弃在途旧响应（key + 自增序号双重校验）
 *
 * [权威文档]
 *   - 计划 `constantine-pantha-lockjaw.md` §2.4 / §3.4.6
 *   - 后端 `memory.controller.ts` usage trace 的 `hintCode` / cursor 契约
 *
 * [关键不变量]
 *   - **首屏失败恰好 1 次**：`retry: false` 不适用（本 hook 不走 useQuery 的自动重试），
 *     由 `initialRequestedRef` 保证同一 key 只自动发一次。
 *   - **带 cursor 必须回送首页原 since/until/filter/limit**：本 hook 从同一个
 *     `filter` + `limit` 组装每一页，禁止翻页时重新计算时间窗。
 *   - **resetPending 不闪空**：复位期间保留 rows，只置 `refreshing=true`。
 *   - **旧 filter 响应丢弃**：`activeKeyRef` + `seqRef` 双校验（仅靠 key 不够：
 *     同一 key 的手动刷新也会产生在途响应）。
 *   - **403/版本/身份错误不盲重试**：由 UI 读 `usageErrorInfo().retryable` 决定按钮；
 *     本 hook 只负责把错误原样交出去。
 *
 * [关联代码]
 *   - ../../lib/usage.ts — trace 参数装配 / 错误分桶
 *   - ../../lib/api.ts — `Api.usage.trace`
 *   - ./hument-usage-tab.tsx — 唯一消费方
 *
 * [修改检查]
 *   □ 改动分页/复位语义必须同步 `usage/page.test.tsx` 的调用次数断言
 *   □ 新增状态必须考虑 key 切换/组件卸载后的在途响应
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-CODE-HOOK
 * =============================================================================
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Api } from '@/lib/api';
import {
  buildUsageTraceQuery,
  usageErrorInfo,
  usageFilterKey,
  type HumentUsageTraceRow,
  type UsageFilter,
} from '@/lib/usage';

/** trace 会话快照 */
export interface HumentTraceState {
  /** 该快照对应的稳定 key（项目 + 过滤 + limit） */
  key: string;
  rows: HumentUsageTraceRow[];
  totalRows: number;
  nextCursor: string | null;
  hasMore: boolean;
  firstLoading: boolean;
  firstError: unknown | null;
  loadingMore: boolean;
  loadMoreError: unknown | null;
  /** 游标复位中（保留旧行，不闪空） */
  refreshing: boolean;
  /** 连续第二次复位 → 停止（防止无限重拉） */
  resetExhausted: boolean;
  /** 已自动复位次数（0/1；成功 load-more 后清零） */
  resetCount: number;
}

function initialState(key: string): HumentTraceState {
  return {
    key,
    rows: [],
    totalRows: 0,
    nextCursor: null,
    hasMore: false,
    firstLoading: false,
    firstError: null,
    loadingMore: false,
    loadMoreError: null,
    refreshing: false,
    resetExhausted: false,
    resetCount: 0,
  };
}

/** 稳定 trace key（**不含 as_of / request_id**） */
export function humentTraceKey(
  projectId: string | null,
  filter: UsageFilter,
  limit: number,
  session = 0,
): string {
  return `${projectId ?? ''}|${usageFilterKey(filter)}|${limit}|${session}`;
}

/**
 * trace 分页状态机。
 *
 * @param projectId 当前项目（null = 不请求）
 * @param filter 生效过滤（含**首页物化**的绝对 since/until）
 * @param limit 页大小（1–200；页面只给 50/100/200）
 * @param expanded 折叠区是否展开（false = 懒加载未触发）
 * @param session UI 会话号：显式「重新从首页加载」或 Apply 同 filter 时 +1，
 *   强制同一 filter/limit 也重新发首页（不靠"改 key 才能重试"的巧合）
 */
export function useHumentTrace(
  projectId: string | null,
  filter: UsageFilter,
  limit: number,
  expanded: boolean,
  session = 0,
) {
  const key = humentTraceKey(projectId, filter, limit, session);
  const [state, setState] = useState<HumentTraceState>(() => initialState(key));
  const stateRef = useRef<HumentTraceState>(state);
  const activeKeyRef = useRef(key);
  const seqRef = useRef(0);
  const initialRequestedRef = useRef<string | null>(null);
  /** 过滤/limit 的读时快照（避免闭包读到旧渲染值） */
  const paramsRef = useRef({ projectId, filter, limit });
  paramsRef.current = { projectId, filter, limit };

  const commit = useCallback((next: Partial<HumentTraceState>) => {
    const merged = { ...stateRef.current, ...next };
    stateRef.current = merged;
    setState(merged);
  }, []);

  /** 首页（initial = 首次/手动重试；reset = 游标复位；refresh = 已有行的刷新） */
  const loadFirstPage = useCallback(
    async (targetKey: string, mode: 'initial' | 'reset' | 'refresh') => {
      const { projectId: pid, filter: currentFilter, limit: currentLimit } = paramsRef.current;
      if (!pid) return;
      const seq = ++seqRef.current;
      const hasRows = stateRef.current.rows.length > 0;
      commit({
        firstLoading: mode === 'initial' && !hasRows,
        refreshing: mode === 'reset' || (mode === 'refresh' && hasRows),
        firstError: null,
      });
      try {
        const response = await Api.usage.trace(
          pid,
          buildUsageTraceQuery(currentFilter, currentLimit),
        );
        if (activeKeyRef.current !== targetKey || seq !== seqRef.current) return;
        commit({
          key: targetKey,
          rows: response.engine.rows,
          totalRows: response.engine.total_rows,
          // `has_more=true` 时合同保证 next_cursor 非空；双条件防御破损回执
          nextCursor:
            response.engine.has_more && response.engine.next_cursor
              ? response.engine.next_cursor
              : null,
          hasMore: Boolean(response.engine.has_more && response.engine.next_cursor),
          firstLoading: false,
          firstError: null,
          loadingMore: false,
          refreshing: false,
          loadMoreError: null,
          resetExhausted: false,
        });
      } catch (error) {
        if (activeKeyRef.current !== targetKey || seq !== seqRef.current) return;
        commit({
          firstLoading: false,
          loadingMore: false,
          refreshing: false,
          firstError: error,
        });
      }
    },
    [commit],
  );

  // 项目/过滤/limit 变化：丢弃旧快照与在途响应；展开态下只自动发一次首页
  useEffect(() => {
    const previousKey = activeKeyRef.current;
    activeKeyRef.current = key;
    if (previousKey !== key) {
      // 自增序号 = 让在途旧响应（含同 key 手动刷新）当场失效
      seqRef.current += 1;
      initialRequestedRef.current = null;
      const next = initialState(key);
      stateRef.current = next;
      setState(next);
    }
    if (!expanded || !projectId) return;
    if (initialRequestedRef.current === key) return;
    initialRequestedRef.current = key;
    const mode = stateRef.current.rows.length > 0 ? 'refresh' : 'initial';
    void loadFirstPage(key, mode);
  }, [key, expanded, projectId, loadFirstPage]);

  /** 手动重试首页（失败面板按钮） */
  const retryFirstPage = useCallback(() => {
    if (!projectId) return;
    const current = stateRef.current;
    stateRef.current = { ...current, resetCount: 0, resetExhausted: false };
    setState(stateRef.current);
    void loadFirstPage(key, current.rows.length > 0 ? 'refresh' : 'initial');
  }, [key, loadFirstPage, projectId]);

  /** 加载下一页；游标复位时有界重拉首页 */
  const loadMore = useCallback(async () => {
    const { projectId: pid, filter: currentFilter, limit: currentLimit } = paramsRef.current;
    const current = stateRef.current;
    if (!pid || current.loadingMore || !current.nextCursor) return;
    const cursor = current.nextCursor;
    const targetKey = key;
    const seq = ++seqRef.current;
    commit({ loadingMore: true, loadMoreError: null });
    try {
      const response = await Api.usage.trace(
        pid,
        buildUsageTraceQuery(currentFilter, currentLimit, cursor),
      );
      if (activeKeyRef.current !== targetKey || seq !== seqRef.current) return;
      // 去重按 id（同一页重复调用/引擎边界不应产生重复行）
      const seen = new Set(stateRef.current.rows.map((row) => row.id));
      const appended = response.engine.rows.filter((row) => !seen.has(row.id));
      commit({
        rows: [...stateRef.current.rows, ...appended],
        totalRows: response.engine.total_rows,
        nextCursor:
          response.engine.has_more && response.engine.next_cursor
            ? response.engine.next_cursor
            : null,
        hasMore: Boolean(response.engine.has_more && response.engine.next_cursor),
        loadingMore: false,
        loadMoreError: null,
        resetCount: 0,
      });
    } catch (error) {
      if (activeKeyRef.current !== targetKey || seq !== seqRef.current) return;
      const info = usageErrorInfo(error);
      if (info.kind === 'cursorReset') {
        if (stateRef.current.resetCount >= 1) {
          // 第二次复位 = 停止（有界；不再重拉首页）
          commit({ loadingMore: false, loadMoreError: error, resetExhausted: true });
          return;
        }
        // 第一次复位：保留行，重拉首页（不闪空）
        commit({ loadingMore: false, loadMoreError: null, resetCount: 1 });
        await loadFirstPage(targetKey, 'reset');
        return;
      }
      commit({ loadingMore: false, loadMoreError: error });
    }
  }, [commit, key, loadFirstPage]);

  return {
    state,
    rows: state.key === key ? state.rows : [],
    totalRows: state.key === key ? state.totalRows : 0,
    hasMore: state.key === key && state.hasMore,
    nextCursor: state.key === key ? state.nextCursor : null,
    // 首帧不闪「无 trace 行」：展开后、首次请求提交前也按 loading 渲染。
    // 请求成功返回空才落到 EmptyState（此时 initialRequestedRef 已指向当前 key）。
    firstLoading:
      state.key !== key ||
      state.firstLoading ||
      (expanded &&
        !!projectId &&
        initialRequestedRef.current !== key &&
        !state.firstError &&
        state.rows.length === 0),
    firstError: state.key === key ? state.firstError : null,
    loadingMore: state.loadingMore,
    loadMoreError: state.loadMoreError,
    refreshing: state.refreshing,
    resetExhausted: state.resetExhausted,
    retryFirstPage,
    loadMore,
  };
}
