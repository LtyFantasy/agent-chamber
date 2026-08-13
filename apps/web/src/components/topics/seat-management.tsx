'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §6（座位管理）/ §7（runner 认领规则）
 *   - 补充: docs/frontend-architecture.md §3.2.3（话题详情页——圆桌座位管理 UI）
 *
 * [踩坑索引]
 *   - runner 列表排序契约在后端（online 优先 + lastSeenAt 倒序），web 按序直渲
 *   - 启动命令的 platform-url 曾取 window.location.origin——dev 下是 8742（web），
 *     runner 要连 8743（backend）——已整体替换为 RunnerConnectGuide（v1.51.0，
 *     平台 URL 经 lib/platform-url.ts getRunnerPlatformUrl 推导）
 *   - 复制反馈用内联瞬态文案（web 无 toast 体系，与 message-bubble「已复制」同款）
 *   - 离线 runner 沉底但不隐藏：排障需要看到「曾经有 runner」（后端排序契约）
 *   - 向导默认展开条件 = 有未认领座位（runnerId == null）：座位全认领 = 连接闭环，
 *     不再渲染指引（无 seat 上下文可指）；多未认领只对第一个渲染
 *   - 连接向导挂载改版（2026-08-12）：不再常驻头部大块（信息密度失衡 + 多未认领
 *     无入口）——头部只留一行轻量 amber 提示「N 个座位待连接 →」；点击提示 →
 *     模态框定位**第一个**未认领座位（座位 chip 点击同理，见 seat-badges.tsx 同款
 *     模态框）。向导轮询随弹窗生命周期启停（组件自带）；弹窗关闭即卸载
 *
 * [铁律关联] #7(视觉克制) #11(注释强制) #17(测试契约)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Plus, Server } from 'lucide-react';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatRelativeTime } from '@/lib/utils';
import { useSeatPresence } from '@/lib/use-seat-presence';
import { SeatCreateDialog } from './seat-create-dialog';
import { RunnerConnectGuide } from './runner-connect-guide';

interface SeatManagementProps {
  /** 圆桌 topic UUID（建座 payload + seats invalidate 键） */
  topicId: string;
  /** 是否展示「添加座位」入口（人类 + topic 管理员/平台管理员，与 SeatBadges 移除同规） */
  canManage?: boolean;
  /** 验收全绿后「去 @ 它试试」的附加动作（话题页传 = 关闭参与者 Sheet）；可选 */
  onExitGuide?: () => void;
}

/**
 * 圆桌座位管理分区（v1.49.0，C2；v1.51.0 换挂载连接向导；2026-08-12 改版为
 * 模态框入口）：参与者面板顶部的圆桌专属块——
 * ① runner 在线状态行（chips：状态点 + name + vendors + 最近心跳相对时间）；
 * ② 未认领座位（runnerId == null）时的一行轻量 amber 提示「N 个座位待连接」
 *    （v1.51.0 的常驻 RunnerConnectGuide 大块已移除——点击提示才打开向导模态框，
 *    定位第一个未认领座位；向导经 getRunnerPlatformUrl 推导平台 URL，带 agent
 *    路径 + 验收环，本体见 runner-connect-guide.tsx，座位 chip 点击同理）；
 * ③ 「添加座位」入口（canManage 门控）+ SeatCreateDialog。
 *
 * 数据：GET /roundtable/runners 30s 轮询（与 sidebar 审批角标同节奏；后端已按
 * online 优先排序）+ seats 经 useSeatPresence 5s 轮询（与 SeatPresenceBar 同 key
 * 共享缓存，零额外请求）——未认领座位是轻量提示的显隐条件。
 */
export function SeatManagement({ topicId, canManage = false, onExitGuide }: SeatManagementProps) {
  const t = useTranslations('topics');
  const [createOpen, setCreateOpen] = useState(false);

  const { data: runners } = useQuery({
    queryKey: ['roundtable', 'runners'],
    queryFn: () => Api.roundtable.listRunners(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // 座位 5s 轮询（与 SeatPresenceBar/页面同 key 共享；SeatManagement 需要座位列表
  // 统计未认领座位数——只认本话题座位 runnerId==null）
  const { data: seats } = useSeatPresence(topicId, { enabled: true });

  const runnerList = runners ?? [];
  /** 未认领座位（runnerId == null）：>0 时头部渲染轻量提示（计数） */
  const unclaimedSeats = (seats ?? []).filter((s) => !s.runnerId);
  /**
   * 向导模态框定位座位：点击轻量提示时锁定为**第一个**未认领座位（与 seat-badges
   * 同款模态框模式）；锁定的座位即使后续被认领，向导仍保留（验收环可走完「等待 →
   * 全绿 → 去 @ 它试试」完整闭环）；座位被移除/关闭弹窗才消失。
   */
  const [guideSeatId, setGuideSeatId] = useState<string | null>(null);
  const guideSeat = guideSeatId ? ((seats ?? []).find((s) => s.id === guideSeatId) ?? null) : null;

  return (
    <div className="space-y-3" data-testid="seat-management">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t('seatMgmt.title')}</h3>
        {canManage && (
          <Button
            size="sm"
            variant="outline"
            data-testid="seat-management-add"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('seatMgmt.addSeat')}
          </Button>
        )}
      </div>

      {/* runner 状态行（后端已排序：online 优先，离线沉底灰显） */}
      {runnerList.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="runner-chips">
          {runnerList.map((r) => (
            <span
              key={r.id}
              data-testid={`runner-chip-${r.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/40 px-2 py-1 text-[10px]"
            >
              {/* 状态点：online 主色 / offline 灰（status 是协议值不翻译） */}
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  r.status === 'online' ? 'bg-emerald-400' : 'bg-muted-foreground/50'
                }`}
              />
              <Server className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium text-foreground/80">{r.name}</span>
              {Array.isArray(r.vendors) && r.vendors.length > 0 && (
                <span className="text-muted-foreground">{r.vendors.join(', ')}</span>
              )}
              {r.lastSeenAt && (
                <span className="text-muted-foreground/70">{formatRelativeTime(r.lastSeenAt)}</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* 未认领座位轻量提示（2026-08-12 改版：常驻大块向导 → 一行 amber 小字）：
          有未认领座位才显示，点击打开向导模态框（定位第一个未认领座位）——
          座位 chip 上的「待连接」徽章点击同理（seat-badges.tsx 同款模态框） */}
      {unclaimedSeats.length > 0 && (
        <button
          type="button"
          data-testid="seat-mgmt-pending-hint"
          onClick={() => setGuideSeatId(unclaimedSeats[0].id)}
          className="text-xs text-amber-400 transition-colors hover:text-amber-300"
        >
          {t('seatMgmt.pendingCount', { count: unclaimedSeats.length })}
        </button>
      )}

      {/* 向导模态框：点击轻量提示打开；锁定座位被认领后 guide 保留展示（验收环
          全绿闭环）；关闭/座位被移除即卸载——轮询随弹窗生命周期启停 */}
      {guideSeat && (
        <Dialog open onOpenChange={() => setGuideSeatId(null)}>
          <DialogHeader>
            <DialogTitle>{t('seatGuide.connectTitle', { label: guideSeat.label })}</DialogTitle>
            <DialogDescription>{t('seatGuide.connectDesc')}</DialogDescription>
          </DialogHeader>
          <RunnerConnectGuide
            seat={guideSeat}
            topicId={topicId}
            defaultOpen
            onExit={() => {
              setGuideSeatId(null);
              onExitGuide?.();
            }}
          />
        </Dialog>
      )}

      <SeatCreateDialog
        topicId={topicId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        runners={runnerList}
      />
    </div>
  );
}
