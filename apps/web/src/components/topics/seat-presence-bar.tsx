/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（话题详情页——圆桌座位实时态顶部条）
 *   - 补充: docs/roundtable-design.md §8b（实时/近况两层模型：presence 相位唯一权威点
 *     在 chip badge；recentActivity 环形缓冲挂 state jsonb；cancel 语义 = 优雅优先 +
 *     10s 兜底 kill，busy 门控 409）
 *
 * [踩坑索引]
 *   - 空态零渲染（照 seat-badges）：无座位不渲染任何容器——零视觉噪音
 *   - 💤 推导 =「idle 且最近一轮 silent」：服务端 turn 条目 summary 硬编码中文
 *     『沉默』（roundtable.service.ts turnRecentActivityItem），web 按该摘要文本判定，
 *     属服务端摘要语义耦合（契约冻结只增不改，不新增结构化字段）；idle 非 silent
 *     不渲染 presence badge（chip 已有 status=active 徽章，presence 层无信息量）
 *   - cancel 反馈分流（照 permission-request-card 409 模式）：409 = 座位已完成发言
 *     的瞬时竞态（轮询可能未刷到）→ invalidate 重取 + 内联瞬态提示；403 = 治理身份
 *     被降级 → 内联区分提示；成功/真实失败 → 全局 toast（lib/notify）
 *   - confirm 二次确认禁 window.confirm：全局 confirm（lib/notify）+ confirmPendingRef
 *     双击防护（照 seat-badges remove 按钮）；confirmVariant: 'danger'（取消是治理动作）
 *   - 权限闸与后端同规：人类 +（平台 admin ｜ topic 创建者 ｜ creator 的 owner 代理），
 *     页面算好经 props 传入（canManage 照 seat-badges 同款传参惯例）——前端是体验层闸，
 *     后端本来就 403
 *   - avatar 来源 = bindActorId → topic.participants 的 avatarUrl（页面数据已有，
 *     零后端改动）；bindActorId 无匹配参与者时 Avatar fallback=label 兜底
 *   - 传输抽象接缝：数据经 useSeatPresence hook（5s 轮询）——组件不感知轮询/SSE
 *
 * [铁律关联] #7(视觉克制) #11(注释强制) #17(测试契约) #20(契约即设计)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Crown } from 'lucide-react';
import { Api, type RoundtableSeatItem } from '@/lib/api';
import { useSeatPresence } from '@/lib/use-seat-presence';
import { confirm, toast } from '@/lib/notify';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { SeatPresencePopover } from '@/components/topics/seat-presence-popover';
import type { TopicParticipant } from '@/types';

/** busy 相位集合（后端 cancel busy 门控同规：thinking/tool/replying 才可取消） */
const BUSY_PHASES = ['thinking', 'tool', 'replying'] as const;

interface SeatPresenceBarProps {
  /** 圆桌 topic UUID（seats 查询 key 前缀 + cancel 端点目标） */
  topicId: string;
  /** 是否启用（仅 kind='roundtable' 传 true）——非圆桌不挂轮询 hook、不渲染 */
  enabled: boolean;
  /** 参与者列表（bindActorId → avatarUrl 查找源；topic.participants 页面已有） */
  participants?: TopicParticipant[];
  /**
   * 治理权限（平台 admin ｜ topic 创建者 ｜ creator 的 owner 代理——页面算好传入，
   * 与 seat-badges canManage 同规；前端是体验层闸，后端本来就 403）
   */
  canManage: boolean;
}

/**
 * SeatPresenceBar — 圆桌座位实时态顶部常驻条（M4b-1）：
 * 挂在 topic 页 glass header 下方，仅 kind='roundtable' 渲染。每座位一个 chip
 * （头像 + label + 主脑 Crown + presence badge），busy 相位展示取消发言按钮
 * （治理权限门控 + confirm 二次确认）；chip 点击展开 SeatPresencePopover
 * （近况时间线 + 沉默计数 + 用量）。
 *
 * 实时数据经 useSeatPresence hook 5s 轮询（传输抽象接缝，SSE 升级零组件改动）；
 * 空态（无座位）零渲染。presence 相位规则（R4）：thinking/tool/replying 显示
 * 活跃徽章；idle 且最近一轮 silent → 💤；offline → 离线词条；idle 非 silent
 * 不渲染（status 徽章已在参与者面板表达）。
 */
export function SeatPresenceBar({
  topicId,
  enabled,
  participants = [],
  canManage = false,
}: SeatPresenceBarProps) {
  const t = useTranslations('topics');
  const tGlobal = useTranslations();
  const queryClient = useQueryClient();
  const { data: seats } = useSeatPresence(topicId, { enabled });
  /** 当前展开 Popover 的座位 id（null = 全部收起；一次只开一个） */
  const [openSeatId, setOpenSeatId] = useState<string | null>(null);
  /** 内联瞬态提示（409 竞态 / 403 权限降级——他人/状态变化类反馈不打断视野） */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 取消确认弹窗打开期间置 true（双击防护：异步 confirm 无原生同步阻塞，照 seat-badges） */
  const confirmPendingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 3000);
  };

  /** bindActorId → 参与者行映射（avatarUrl 查找源；页面 participants 数据零重复请求） */
  const participantByActorId = useMemo(() => {
    const map = new Map<string, TopicParticipant>();
    for (const p of participants) map.set(p.participantId, p);
    return map;
  }, [participants]);

  const cancelMutation = useMutation({
    mutationFn: (seatId: string) => Api.roundtable.cancelSeat(seatId),
    onSuccess: () => {
      // 取消指令已受理：优雅结果异步（runner 收信后经 presence 轮询自然流转），
      // 无需本地乐观翻转——轮询 5s 内收敛到 idle/offline 即取消生效的观测证据
      toast.success({ title: t('seatPresence.cancelSent') });
    },
    onError: (err) => {
      // 409 = 座位已完成发言（busy 门控竞态：轮询可能尚未刷到终态）→ 失效重取 +
      // 内联瞬态提示（照 permission-request-card 409 模式）；403 = 治理身份被降级
      // → 内联区分提示（照 seat-badges removedForbidden）；其余真实失败 → 全局 toast
      if (err instanceof AxiosError && err.response?.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['roundtable', 'seats', topicId] });
        showNotice(t('seatPresence.cancelConflict'));
      } else if (err instanceof AxiosError && err.response?.status === 403) {
        showNotice(t('seatPresence.cancelForbidden'));
      } else {
        toast.error({ title: t('seatPresence.cancelFailed') });
      }
    },
  });

  // 空态（含加载中无数据）：不渲染任何容器，零视觉噪音（enabled 短路职责同组件内）
  if (!enabled || !seats || seats.length === 0) {
    return null;
  }

  /** 相位是否 busy（后端 cancel busy 门控同规——busy 才显示取消按钮） */
  const isBusy = (seat: RoundtableSeatItem): boolean =>
    !!seat.presence && BUSY_PHASES.includes(seat.presence.phase as (typeof BUSY_PHASES)[number]);

  /** 💤 推导：idle 且最近一轮 silent（服务端 turn 条目 summary='沉默'，契约冻结只增不改） */
  const isLastTurnSilent = (seat: RoundtableSeatItem): boolean => {
    const activity = seat.state?.recentActivity ?? [];
    for (let i = activity.length - 1; i >= 0; i--) {
      if (activity[i].kind === 'turn') return activity[i].summary === '沉默';
    }
    return false;
  };

  /** presence 徽章：busy 相位主色高亮；idle+silent → 💤；offline → 灰；其余不渲染 */
  const renderPresenceBadge = (seat: RoundtableSeatItem) => {
    const phase = seat.presence?.phase;
    if (!phase) return null;
    if (phase === 'thinking') {
      return (
        <PresencePill
          testId={`presence-thinking-${seat.id}`}
        >{`◉ ${t('seatPresence.thinking')}`}</PresencePill>
      );
    }
    if (phase === 'tool' && seat.presence?.toolTitle) {
      return (
        <PresencePill testId={`presence-tool-${seat.id}`} className="max-w-40 truncate">
          {`🔧 ${seat.presence.toolTitle}`}
        </PresencePill>
      );
    }
    if (phase === 'replying') {
      return (
        <PresencePill
          testId={`presence-replying-${seat.id}`}
        >{`▌ ${t('seatPresence.replying')}`}</PresencePill>
      );
    }
    if (phase === 'idle' && isLastTurnSilent(seat)) {
      return (
        <PresencePill testId={`presence-silent-${seat.id}`} className="text-muted-foreground">
          {`💤 ${t('seatPresence.silent')}`}
        </PresencePill>
      );
    }
    if (phase === 'offline') {
      return (
        <PresencePill testId={`presence-offline-${seat.id}`} className="text-muted-foreground">
          {t('seatPresence.offline')}
        </PresencePill>
      );
    }
    // idle 非 silent：不渲染（chip 无信息量冗余——status=active 已在参与者面板表达）
    return null;
  };

  return (
    <div
      // relative z-10：.glass 的 backdrop-filter 创建 stacking context，Popover 的 z-50
      // 被困其中抬不出消息区（framer-motion 气泡 transform 堆叠上下文压过 bar）——整层
      // 抬到 z-10 压过消息流即可；不用更高值：移动侧栏遮罩 z-40 必须能盖住本 bar
      className="glass relative z-10 mb-3 rounded-xl px-3 py-2 md:mb-4"
      data-testid="seat-presence-bar"
    >
      <div className="flex flex-wrap gap-1.5">
        {seats.map((seat) => {
          const participant = seat.config?.bindActorId
            ? participantByActorId.get(seat.config.bindActorId)
            : undefined;
          const busy = isBusy(seat);
          return (
            <div key={seat.id} className="relative inline-flex items-center gap-1">
              {/* chip：头像 + label + 主脑 Crown + presence badge；点击切换 Popover
                  （再次点击同一座位收起；点其他座位自动切换） */}
              <button
                type="button"
                data-testid={`seat-presence-chip-${seat.id}`}
                aria-expanded={openSeatId === seat.id}
                onClick={() => setOpenSeatId((cur) => (cur === seat.id ? null : seat.id))}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/40 px-2 py-1 text-left transition-colors hover:bg-muted/50"
              >
                <Avatar
                  src={participant?.avatarUrl ?? undefined}
                  fallback={participant?.name ?? seat.label}
                  size="xs"
                  actorType={participant?.participantType}
                  seed={participant?.participantId ?? seat.id}
                />
                <span className="shrink-0 text-xs font-medium text-foreground/80">
                  {seat.label}
                </span>
                {/* 主脑标记（沿用 seat-badges 既有做法）：琥珀 Crown 徽章 */}
                {seat.coordinator && (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] font-semibold text-amber-300"
                    title={t('seatManager.coordinatorTitle')}
                  >
                    <Crown className="mr-0.5 h-2.5 w-2.5" />
                    {t('seatManager.coordinator')}
                  </Badge>
                )}
                {renderPresenceBadge(seat)}
              </button>
              {/* 取消发言按钮（busy + 治理权限）：confirm 二次确认（danger 红钮）→
                  POST cancel；409 竞态/403 降级走内联提示，成功/真实失败走全局 toast */}
              {canManage && busy && (
                <button
                  type="button"
                  data-testid={`cancel-seat-${seat.id}`}
                  disabled={cancelMutation.isPending}
                  onClick={async () => {
                    if (confirmPendingRef.current || cancelMutation.isPending) return;
                    confirmPendingRef.current = true;
                    try {
                      const ok = await confirm({
                        title: t('seatPresence.cancelTitle'),
                        description: t('seatPresence.cancelConfirm', { label: seat.label }),
                        confirmText: tGlobal('common.confirm'),
                        cancelText: tGlobal('common.cancel'),
                        confirmVariant: 'danger',
                      });
                      if (!ok) return;
                      cancelMutation.mutate(seat.id);
                    } finally {
                      confirmPendingRef.current = false;
                    }
                  }}
                  className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
                >
                  {t('seatPresence.cancel')}
                </button>
              )}
              {/* 实时态详情浮层（近况时间线 + 沉默计数 + 用量）：手写 Popover，
                  Esc/外点关闭（受控 open 由本组件管理，一次只开一个） */}
              <SeatPresencePopover
                seat={seat}
                open={openSeatId === seat.id}
                onClose={() => setOpenSeatId(null)}
              />
            </div>
          );
        })}
      </div>
      {/* 内联瞬态提示（409 竞态 / 403 降级）：独立于 chip 组外一行——错误提示不混入座位流 */}
      {notice && (
        <span className="mt-1 block text-xs text-destructive" data-testid="seat-presence-notice">
          {notice}
        </span>
      )}
    </div>
  );
}

/** presence 相位小胶囊（统一配色：busy 主色高亮，silent/offline 灰） */
function PresencePill({
  children,
  testId,
  className,
}: {
  children: React.ReactNode;
  testId: string;
  className?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary ${className ?? ''}`}
    >
      {children}
    </span>
  );
}
