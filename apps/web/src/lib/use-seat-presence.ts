/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（话题详情页——圆桌座位实时态）
 *   - 补充: docs/roundtable-design.md §8b（seat 状态可视化：实时/近况两层模型；
 *     轮询优先 + SSE+Redis 规模化升级路径——本 hook 即传输抽象接缝）
 *
 * [踩坑索引]
 *   - queryKey 必须与 topic 详情页既有 seats 查询同源（['roundtable','seats',topicId]）：
 *     页面 mentionTargets / 审批卡片 seatId→label 映射 / SeatBadges 同缓存共享，
 *     轮询刷新即全量联动，禁止另起异 key 查询（双份请求 + 数据不同步）
 *   - 404 停止轮询：react-query v5 函数式 refetchInterval 按 query.state 返回 false，
 *     仅对 404（被踢出 topic）停；瞬时网络错误继续轮询（恢复后自愈），
 *     禁写成「任何错误都停」——页面隐藏后回归网络恢复，轮询会永久停摆
 *   - 页面隐藏自动暂停 = react-query 默认行为（refetchIntervalInBackground=false），
 *     回前台自动续轮，无需额外 visibilitychange 监听
 *
 * [铁律关联] #10(工具优先) #11(注释强制) #17(测试契约) #23(jsonb 查询集成覆盖)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

'use client';

import { useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Api } from '@/lib/api';

/** 座位实时态轮询间隔（ms）：与 chamber presence 内存推导时效匹配的轻量心跳 */
export const SEAT_PRESENCE_POLL_INTERVAL_MS = 5000;

/** useSeatPresence 可调参数 */
export interface UseSeatPresenceOptions {
  /** 是否启用（仅 kind='roundtable' 传 true）——非圆桌 topic 不发请求 */
  enabled: boolean;
  /** 轮询间隔（ms），默认 SEAT_PRESENCE_POLL_INTERVAL_MS=5000（测试可注入小间隔） */
  intervalMs?: number;
}

/**
 * useSeatPresence — 圆桌座位实时态（presence 相位 + recentActivity 近况）查询 hook。
 *
 * **传输抽象接缝**（M4b-1 设计定稿）：组件只消费数据，不感知轮询/SSE——
 * v1 = seats GET 5s 轮询（react-query refetchInterval，页面隐藏自动暂停）；
 * 未来 SSE + Redis pub/sub 升级只改本文件，组件零改动。
 *
 * 行为契约：
 * - queryKey ['roundtable','seats',topicId] 与页面既有 seats 查询共享缓存
 *   （mentionTargets / 审批卡片 seatId→label 映射 / SeatBadges 同源刷新）；
 * - 404（被踢出 topic）→ 停止轮询 + 不重试：资源已不可达，继续狂刷无意义；
 * - 其他错误 → 静默重试（react-query 默认，不弹错误 UI）；
 * - 卸载自动停止轮询；tab 隐藏期间暂停（refetchIntervalInBackground 默认 false），
 *   回前台立即续轮（react-query 天然行为，见 use-event-poll 同款注释）。
 *
 * @param topicId 圆桌 topic UUID
 * @param options 启用开关（仅 roundtable 传 true）
 */
export function useSeatPresence(
  topicId: string,
  { enabled, intervalMs = SEAT_PRESENCE_POLL_INTERVAL_MS }: UseSeatPresenceOptions,
) {
  return useQuery({
    queryKey: ['roundtable', 'seats', topicId],
    queryFn: () => Api.roundtable.listSeats(topicId),
    enabled,
    refetchInterval: (query) => {
      // 404 = 被踢出 topic/座位不可达：停止轮询；其余错误继续（瞬时网络故障自愈）
      const err = query.state.error;
      if (err instanceof AxiosError && err.response?.status === 404) return false;
      return intervalMs;
    },
    retry: () => {
      // 零重试：404 由 refetchInterval 分支停止轮询；其他错误的「重试」由
      // refetchInterval 下一轮承担（自愈）——避免 react-query 指数退避
      // （1s/2s/4s）打断 5s 心跳节奏，轮询行为对测试可预期
      return false;
    },
  });
}
