/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.4 (统一事件层)
 *   - 补充: docs/api-definition.md §8. Events
 *
 * [踩坑索引] 无
 *
 * [铁律关联] #11(注释强制) #17(测试契约)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

'use client';

import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Api } from '@/lib/api';
import type { EventItem } from '@/lib/api';

/** useEventPoll 可调参数 */
export interface UseEventPollOptions {
  /** 轮询间隔（ms）。默认 5000 */
  intervalMs?: number;
  /** 新事件回调：按事件产生顺序逐条调用（调用方按需过滤事件类型） */
  onEvent: (event: EventItem) => void;
}

/** 轮询默认间隔：与后端事件落库时效匹配的轻量心跳（5s 轮询 × 单请求，成本可控） */
const DEFAULT_INTERVAL_MS = 5000;

/**
 * useEventPoll — 通用事件轮询 hook（GET /events/poll 的 react-query 封装）。
 *
 * 行为契约：
 * - 首轮请求固定用 cursor='now'：跳过全部历史事件，仅锚定当前时刻并记录服务端
 *   返回的 nextCursor（历史数据由各页面自身查询兜底，重放事件会与既有数据重复）；
 * - 之后每 intervalMs 用「最近一次返回的 nextCursor」轮询（cursor 单调递增），
 *   有事件则按序逐条回调 onEvent 并推进游标——多轮之间不重不漏；
 * - cursor 存 ref：查询函数每次执行时读最新值，轮询循环不会因闭包持有旧游标；
 * - onEvent 也经 ref 转发：调用方渲染期传入的新回调立即生效，无需重启轮询；
 * - 失败容错：轮询报错走 react-query 默认 retry（静默重试），不弹错误 UI；
 * - 卸载自动停止：query observer 销毁即停轮询（react-query 天然行为）；
 *   tab 隐藏期间暂停（refetchIntervalInBackground 默认 false），回前台立即续轮。
 * - 注意：queryKey 全局单例（['events','poll']）——同屏多个消费者会共享首个
 *   observer 的 queryFn，后挂载者的 onEvent 不会触发。当前仅 topic 详情页单点
 *   消费；未来多处复用时需把 queryKey 按消费方参数化（如带页面标识）。
 *
 * @param options 轮询参数（intervalMs 可选，onEvent 必填）
 */
export function useEventPoll({ intervalMs = DEFAULT_INTERVAL_MS, onEvent }: UseEventPollOptions) {
  /** 当前轮询游标：null = 尚未锚定（首轮用 'now'）；之后恒为服务端返回的 nextCursor */
  const cursorRef = useRef<string | null>(null);
  /** 最新 onEvent 回调（ref 转发，避免轮询回调闭包持有旧函数） */
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useQuery({
    queryKey: ['events', 'poll'],
    queryFn: async () => {
      const cursor = cursorRef.current ?? 'now';
      const res = await Api.events.poll(cursor);
      cursorRef.current = res.nextCursor;
      res.events.forEach((event) => onEventRef.current(event));
      return res;
    },
    refetchInterval: intervalMs,
  });
}
