/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（话题详情页——圆桌座位实时态 Popover）
 *   - 补充: docs/roundtable-design.md §8b（recentActivity 近况契约：cap 10 环形、
 *     服务端 R5 摘要化——剥离敏感载荷，participant 全可读）
 *
 * [踩坑索引]
 *   - 无 radix/command 依赖：手写 Popover 模式照 search-select-popover（绝对定位
 *     left-0 top-full + Esc/外点关闭），禁止为单个浮层引第三方依赖
 *   - recentActivity 的 summary 是服务端摘要文本（工具标题 /「回复 n 字」/「沉默」），
 *     原文透传不翻译；kind 是协议枚举但宽松读取——未知 kind 兜底 MessageSquare 图标，
 *     禁止按 kind 硬编码三种导致未知值 crash
 *   - 空态（无近况/无用量）零噪音：无条目显示 noActivity 词条，字段缺省不渲染
 *   - 时间显示复用 formatRelativeTime（全站惯例，硬编码中文，与 message-bubble 同款）
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

import { useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Wrench, MessageSquare, ShieldQuestion } from 'lucide-react';
import type { RoundtableSeatItem } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';

/** 近况条目 kind → 图标映射（宽松读取：未知 kind 兜底 MessageSquare，防协议扩展 crash） */
const KIND_ICONS = {
  tool_call: Wrench,
  turn: MessageSquare,
  permission: ShieldQuestion,
} as const;

interface SeatPresencePopoverProps {
  /** 座位（消费 state.recentActivity/silentCount/lastUsage + presence 相位） */
  seat: RoundtableSeatItem;
  /** 是否展开（受控：父级管理当前展开座位 id） */
  open: boolean;
  /** 关闭回调（Esc / 点击外部触发） */
  onClose: () => void;
}

/**
 * SeatPresencePopover — 座位实时态详情浮层（M4b-1）：
 * 近况时间线（recentActivity cap 10 环形）+ 沉默计数 + lastUsage（model_usage
 * 展示位）。手写 Popover 模式（项目无 radix 依赖）：绝对定位 left-0 top-full
 * 挂父级 relative 容器，Esc / 点击外部关闭（照 search-select-popover）。
 * 服务端 R5 已摘要化：summary 是展示友好文本，直接透传不翻译；kind 图标宽松映射。
 */
export function SeatPresencePopover({ seat, open, onClose }: SeatPresencePopoverProps) {
  const t = useTranslations('topics');
  const locale = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);

  /** 点击外部关闭（mousedown：先于容器内按钮 click 判定，避免打开即关的闪烁） */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const activity = seat.state?.recentActivity ?? [];
  const silentCount = seat.state?.silentCount ?? 0;
  const lastUsage = seat.state?.lastUsage;
  // lastUsage 是宽松 jsonb：used/size 缺一即视为无用量数据（不渲染该块）
  const hasUsage = typeof lastUsage?.used === 'number' && typeof lastUsage?.size === 'number';

  return (
    <div
      ref={containerRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      data-testid="seat-presence-popover"
      className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-border/60 bg-popover p-3 shadow-lg animate-in fade-in zoom-in-95 duration-100"
    >
      {/* 头部：座位 label（实时相位已在 chip 的 presence badge 展示，浮层不重复） */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold">{seat.label}</span>
      </div>

      {/* 近况时间线：cap 10 环形，服务端摘要文本原文透传；无条目显示空态词条 */}
      <div className="space-y-1.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('seatPresence.recentActivity')}
        </h4>
        {activity.length === 0 ? (
          <p
            className="px-1 py-1 text-xs text-muted-foreground"
            data-testid="seat-presence-no-activity"
          >
            {t('seatPresence.noActivity')}
          </p>
        ) : (
          <ul className="space-y-1">
            {activity.map((item, idx) => {
              const Icon = KIND_ICONS[item.kind] ?? MessageSquare;
              return (
                <li
                  key={`${item.at}-${idx}`}
                  data-testid="seat-presence-activity-item"
                  className="flex items-start gap-1.5 rounded px-1 py-0.5"
                >
                  <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs">{item.summary}</p>
                    {item.result && (
                      <p className="truncate text-[10px] text-muted-foreground">{item.result}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">
                    {formatRelativeTime(item.at, locale)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 沉默计数 + 用量（model_usage 展示位）：字段缺省不渲染，零噪音 */}
      <div className="mt-2 space-y-0.5 border-t border-border/60 pt-1.5">
        {silentCount > 0 && (
          <p className="text-[11px] text-muted-foreground" data-testid="seat-presence-silent-count">
            {t('seatPresence.silentCount', { count: silentCount })}
          </p>
        )}
        {hasUsage && (
          <p className="text-[11px] text-muted-foreground" data-testid="seat-presence-usage">
            {t('seatPresence.usage', { used: lastUsage.used, size: lastUsage.size })}
            <span className="ml-1 text-muted-foreground/70">
              · {formatRelativeTime(lastUsage.at, locale)}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
