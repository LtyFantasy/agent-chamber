'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 全局查询与写请求的默认重试合同
 * [代码职责]
 *   - 装配 QueryClient 默认项及查询失败 toast；各调用点可显式覆写
 * [权威文档]
 *   - DocSpace Agent Chamber docs/frontend/frontend-architecture.md §4.3 — TanStack Query 配置
 * [关键不变量]
 *   - query 默认 retry:2；mutation 默认 retry:0，避免结果不确定时重放非幂等写入
 *   - 查询首载错误 toast、同窗去重与缓存刷新静音保持下方既有合同
 * [关联代码]
 *   - apps/web/src/app/providers.test.tsx — 真实 Providers 重试及错误反馈验证
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { NotificationHost } from '@/components/ui/notification-host';
import { ImagePreviewHost } from '@/components/attachments/image-preview-host';
import { getApiMessage } from '@/i18n/api-messages';
import { errorMessageOf } from '@/lib/error-message';
import { toast } from '@/lib/notify';

/**
 * 全局 Providers。
 * 主题已收敛为 dark-only（layout.tsx 服务端硬编码 <html class="dark">），
 * 原 ThemeProvider（mode 判断 + mounted hack）已随 theme.store.ts 一并移除，
 * 此处保留：React Query + 全局通知宿主（NotificationHost：AlertDialog/Toaster
 * 的唯一挂载点，命令式 confirm/toast 经 store 回流到这里渲染）+ 全局图片预览
 * 宿主（ImagePreviewHost：markdown 图片点击放大的唯一挂载点，批 3 追加）
 * + **查询失败的全局兜底 toast**（卡 240c74d6，见下）。
 *
 * ── 查询失败兜底（卡 240c74d6）────────────────────────────────────────────────
 * 为什么需要全局兜底：查询失败的默认可见性为零——`lib/api.ts` 的拦截器只写 console，
 * 页面若没接 `isError` 就会把失败渲染成**空态**（"这里没有数据"与"请求挂了"看起来一样，
 * 就是静默失败）。本批已接三列表页 + memory 页，其余页面在 F3 前靠这一层兜底。
 *
 * 三条口径（改动前先读 `lib/error-message.ts` 的 [关键不变量]）：
 * ① **只有"从未成功过"才弹**（`query.state.data === undefined`）：有缓存的后台刷新失败
 *    会被下一次成功覆盖，弹 toast 等于用一次瞬时网络抖动打断正在读页面的用户；
 * ② **同窗去重**：断网时同屏多个 query 会并发失败，文案相同就只留一条（抑制窗口
 *    `QUERY_ERROR_TOAST_DEDUP_MS`，去重键 = 文案本身）。去重记录随 `Providers` 每次挂载
 *    重置，不动 notification store 的既有上限（5 条）语义；
 * ③ **文案通道分级**：走 `errorMessageOf`（4xx 带业务码才透传服务端 message，其余用
 *    本地文案）。这里跑在 React 之外拿不到 `useTranslations`，所以兜底文案走非 React
 *    先例通道 `getApiMessage('requestFailed')`——**不是** axios 的 `error.message`
 *    （断网时那是 'Network Error' 英文原文）。
 *
 * **双通道是有意的，别当 bug 修**：已接线的页面（三列表页 + memory 页）首载失败会同时看到
 * 全局 toast 与页面内错误态——toast 是"此刻发生了什么"的即时反馈，页面错误态是"停在哪、
 * 怎么重试"的持久落点（用户切走再回来时 toast 早消失了）。页面**不要**因为有了全局 toast
 * 就省掉自己的 `isError` 分支。
 *
 * 边界（诚实声明）：本层只覆盖 `useQuery`；`useMutation` 的失败必须在调用点自己挂
 * `onError`（失败语义各页不同，无法全局兜底）。
 */

/** 同窗错误 toast 的抑制窗口（ms）：断网时同屏多 query 并发失败，用户只该看到一条 */
export const QUERY_ERROR_TOAST_DEDUP_MS = 1500;

/**
 * 最近一次全局错误 toast 的抑制记录。
 *
 * 模块级（不进 store、不进 React state）：去重天然是「跨 query 的全局短窗」语义，而
 * `onError` 跑在 React 之外。生命周期 = `Providers` 每次挂载重置一次（见 `Providers`），
 * 生产只有一个实例，测试各自挂载即天然隔离（否则 fake timers 下 `Date.now()` 不前进，
 * 上个用例的抑制记录会静默吃掉下个用例本该出现的 toast）。
 */
let lastErrorToast: { message: string; at: number } | null = null;

/** 重置抑制窗口（`Providers` 挂载时调用；导出以便测试直击时间窗边界） */
export function resetQueryErrorToastDedup(): void {
  lastErrorToast = null;
}

/**
 * 弹出兜底错误 toast（**同窗同文案去重**）。
 *
 * 去重键取**文案**而非 queryHash：断网时同屏多个 query 并发失败，文案都是同一句
 * "请求失败"，用户只需看到一条；按 queryHash 去重反而会一次弹满屏。
 *
 * @param error 查询抛出的错误
 * @param now 当前时刻（ms；**注入**而非内部读 `Date.now()`，测试才能确定性地走时间窗边界）
 */
export function pushQueryErrorToast(error: unknown, now: number): void {
  const message = errorMessageOf(error, getApiMessage('requestFailed'));
  if (
    lastErrorToast !== null &&
    lastErrorToast.message === message &&
    now - lastErrorToast.at < QUERY_ERROR_TOAST_DEDUP_MS
  ) {
    return;
  }
  lastErrorToast = { message, at: now };
  toast.error({ title: message });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => {
    // 抑制窗口随实例重置（幂等；dev StrictMode 下 render 两次也无副作用）
    resetQueryErrorToastDedup();
    return new QueryClient({
      queryCache: new QueryCache({
        onError: (error, query) => {
          // 全局兜底只在"首载失败"时说话（口径 ①）；有缓存的刷新失败静音
          if (query.state.data !== undefined) return;
          pushQueryErrorToast(error, Date.now());
        },
      }),
      defaultOptions: {
        queries: {
          staleTime: 5 * 60 * 1000,
          gcTime: 10 * 60 * 1000,
          refetchOnWindowFocus: true,
          refetchOnReconnect: true,
          retry: 2,
          retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
        },
        mutations: {
          /** 非幂等写入可能已提交但响应丢失；结果不确定时不自动重放。 */
          retry: 0,
        },
      },
    });
  });

  return (
    <QueryClientProvider client={queryClient}>
      <NotificationHost />
      <ImagePreviewHost />
      {children}
    </QueryClientProvider>
  );
}
