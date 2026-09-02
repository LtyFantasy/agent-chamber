'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（话题详情页——圆桌座位管理 UI）
 *   - 补充: docs/roundtable-design.md §6（座位管理：人类 topic 管理员/平台管理员可
 *     移除座位，全部动作 topic 公告可观测）+ §12 r13（座位移除软删语义）
 *
 * [踩坑索引]
 *   - 空态零渲染（无座位不渲染容器——零视觉噪音）
 *   - web 无 toast 体系（无 sonner/Toaster 依赖）：移除失败用内联瞬态提示
 *     （与 message-bubble「已复制」同款克制模式），二次确认用全局 confirm
 *     （lib/notify，替换 window.confirm 批次；danger 红钮 + 确认前双击防护），
 *     禁止为单个提示引第三方依赖
 *   - 权限闸与后端同规：人类 + （平台 admin ｜ topic 创建者 ｜ creator 的 owner
 *     代理）才显示移除按钮——前端是体验层闸，后端本来就 403
 *   - 座位行软删（status='removed'）不出现在列表（后端 listSeats 已排除），
 *     移除成功后 invalidate seats 查询——@ 补全候选、审批卡片 seatId→label
 *     映射同源刷新
 *   - M3 阶段 3 改版（2026-08-08）：座位块从 topic 页消息流上方移入参与者面板
 *     （Participants Sheet）——本组件只渲染座位 chip 组（flex wrap，无 glass
 *     卡片容器），由调用方（页面 agent 行 / 离桌兜底组）决定摆放位置；chip 归组
 *     键 = RoundtableSeatItem.config.bindActorId（backend config jsonb 原样透出，
 *     非 state.modelInfo——前者是绑定声明，后者是运行观测）
 *   - 连接向导模态框改版（2026-08-12）：未认领座位（runnerId == null）chip 可点击
 *     打开 RunnerConnectGuide 模态框（组件本体零改动复用）——chip 外层是 span 非
 *     button（内嵌移除按钮，禁止 button 嵌 button），可点击态用 role=button +
 *     onKeyDown(Enter/Space) + aria-haspopup=dialog；移除按钮 onClick 必须
 *     stopPropagation，否则点移除会连带打开向导弹窗；向导随弹窗挂载/卸载
 *     （轮询生命周期 = 弹窗生命周期）
 *
 * [铁律关联] #7(视觉克制) #11(注释强制) #17(测试契约) #20(契约即设计)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Crown, Trash2 } from 'lucide-react';
import { Api, SEAT_LIFECYCLE_STATUS, type RoundtableSeatItem } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { confirm } from '@/lib/notify';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { RunnerConnectGuide } from './runner-connect-guide';

interface SeatBadgesProps {
  /** 圆桌 topic UUID（seats 查询 key 前缀） */
  topicId: string;
  /** 座位列表（页面 seats useQuery 数据；含 status/coordinator/绑定 agent 展示） */
  seats?: RoundtableSeatItem[];
  /** 是否展示管理操作（人类 + topic 管理员/平台管理员，与后端权限同规） */
  canManage?: boolean;
  /** 验收全绿后「去 @ 它试试」的附加动作（话题页传 = 关闭参与者 Sheet）；可选 */
  onExitGuide?: () => void;
}

/**
 * 圆桌座位 chip 组（M3 阶段 3 r13 + 阶段 5 配置观测，2026-08-08 改版）：
 * topic 参与者面板内嵌的座位展示单位——一行 wrap 的座位 chip（label + 状态 +
 * 主脑标记 + model/thinking/mode 三件套小字），管理员可见移除按钮
 * （全局 confirm 二次确认 → DELETE /roundtable/seats/:id →
 * invalidate seats 查询——@ 补全候选与审批卡片 label 映射同源刷新）。
 *
 * 与旧 SeatManager 的差异：**无 glass 卡片容器、无标题**——调用方（页面 agent
 * 行 / 离桌兜底组）负责摆放；空态（无座位）零渲染。移除/notice 逻辑原样保留。
 * 设计克制：只做「看座位 + 移除」最小操作面（r12 范围收敛）；status 徽章覆盖
 * active/paused/parked/offline 四种生命周期值（协议符号不翻译）；主脑座位多一枚
 * 琥珀 Crown 徽章；三件套数据源 state.modelInfo（runner 从 ACP configOptions
 * 实测上行，地面真相非创建声明），缺省字段不渲染。
 */
export function SeatBadges({ topicId, seats, canManage = false, onExitGuide }: SeatBadgesProps) {
  const t = useTranslations('topics');
  const tGlobal = useTranslations();
  const queryClient = useQueryClient();
  // 移除确认弹窗打开期间置 true（双击防护：异步 confirm 无原生同步阻塞，
  // 不防则连点排队两个确认框——确认两次 = 重复 DELETE 座位）
  const confirmPendingRef = useRef(false);

  /** 连接向导模态框状态：点击未认领座位 chip 时打开（值 = 当前定位座位 id）；
   * 关闭/座位从列表消失时置 null——向导轮询随弹窗生命周期启停（组件自带） */
  const [guideSeatId, setGuideSeatId] = useState<string | null>(null);

  /** 内联瞬态提示（移除失败等；web 无 toast 体系，克制模式与「已复制」同款） */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const removeMutation = useMutation({
    mutationFn: (seatId: string) => Api.roundtable.deleteSeat(seatId),
    onSuccess: () => {
      // 移除后联动失效：座位列表（@ 补全候选 + 审批卡片 label 映射同源刷新）；
      // topic 消息列表也失效——后端移除会落 topic 公告 system 消息
      void queryClient.invalidateQueries({ queryKey: ['roundtable', 'seats', topicId] });
      void queryClient.invalidateQueries({ queryKey: ['topics', 'messages', topicId] });
    },
    onError: (err) => {
      // 403 = 权限过期/被降级（后端本来就会拒绝）；其余按通用失败提示
      if (err instanceof AxiosError && err.response?.status === 403) {
        showNotice(t('seatManager.removedForbidden'));
      } else {
        showNotice(t('seatManager.removeFailed'));
      }
    },
  });

  // 空态（含加载中无数据）：不渲染任何容器，零视觉噪音（非圆桌由调用方短路）
  if (!seats || seats.length === 0) {
    return null;
  }

  /** 模态框定位座位（点击 chip 时锁定；从列表消失即关闭——移除/轮询刷新均安全） */
  const guideSeat = guideSeatId ? (seats.find((s) => s.id === guideSeatId) ?? null) : null;

  /** 状态徽章样式映射（status 是协议值不翻译；active 主色、offline 灰、其余 outline） */
  const statusBadgeClass = (status: string) =>
    status === SEAT_LIFECYCLE_STATUS.ACTIVE // 值域单源见 api.ts（shared 派生）
      ? 'border-primary/40 bg-primary/10 text-primary'
      : 'border-border/60 bg-muted/40 text-muted-foreground';

  return (
    <>
      <div className="flex flex-wrap gap-1.5" data-testid="seat-badges">
        {seats.map((seat) => {
          // 未认领（runnerId == null）= 可点击打开连接向导；已认领纯展示
          const unclaimed = seat.runnerId === null;
          return (
            <span
              key={seat.id}
              data-testid="seat-chip"
              // 可点击态：外层是 span（内嵌移除按钮，button 嵌 button 非法 HTML），
              // 用 role=button + tabIndex + Enter/Space 键盘语义补齐可访问性
              role={unclaimed ? 'button' : undefined}
              tabIndex={unclaimed ? 0 : undefined}
              aria-haspopup={unclaimed ? 'dialog' : undefined}
              title={unclaimed ? t('seatGuide.connectTitle', { label: seat.label }) : undefined}
              onClick={unclaimed ? () => setGuideSeatId(seat.id) : undefined}
              onKeyDown={
                unclaimed
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setGuideSeatId(seat.id);
                      }
                    }
                  : undefined
              }
              // max-w-full：chip 是外层 flex 容器的单项，内容（label+徽章+移除）
              // 最小宽度可能超过参与者卡片宽度——不设上限会溢出卡片；cap 住后由
              // 内层 flex-wrap 换行消化
              className={`inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border px-2 py-1 ${
                unclaimed
                  ? 'cursor-pointer border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60'
                  : 'border-border/60 bg-background/40'
              }`}
            >
              <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80">
                {seat.label}
              </span>
              {/* 主脑标记（仅 coordinator 座位）：琥珀 Crown 徽章，与消息流主脑 badge
                同族强调色——人类一眼区分主脑座位（roundtable-design §6 主脑条） */}
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
              <Badge
                variant="outline"
                className={`shrink-0 px-1.5 py-0 text-[10px] font-medium ${statusBadgeClass(seat.status)}`}
              >
                {seat.status}
              </Badge>
              {/* 待连接提示（未认领座位）：amber 状态点 + 小字——引导点击 chip 打开
                连接向导模态框；已认领座位不渲染（连接闭环零噪音） */}
              {unclaimed && (
                <span
                  data-testid={`seat-pending-${seat.id}`}
                  className="flex shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  {t('seatManager.pendingConnect')}
                </span>
              )}
              {/* 实际运行配置观测（M3 阶段 5）：model/thinking/mode 三件套——克制小字，
                数据源 state.modelInfo（runner 从 ACP configOptions 实测上行，地面真相
                非创建声明）；字段全可选，缺省值不渲染对应项（不同 vendor 可能有缺）；
                thinking 等级译 label（思考等级/Thinking），model/mode 值原文透传不翻译 */}
              {seat.state?.modelInfo &&
                (seat.state.modelInfo.model ||
                  seat.state.modelInfo.thinking ||
                  seat.state.modelInfo.mode) && (
                  <span
                    data-testid={`seat-model-info-${seat.id}`}
                    className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground"
                  >
                    {seat.state.modelInfo.model && (
                      <span data-testid={`seat-model-${seat.id}`}>
                        {seat.state.modelInfo.model}
                      </span>
                    )}
                    {seat.state.modelInfo.thinking && (
                      <span data-testid={`seat-thinking-${seat.id}`}>
                        {t('seatManager.thinking')} {seat.state.modelInfo.thinking}
                      </span>
                    )}
                    {seat.state.modelInfo.mode && (
                      <span data-testid={`seat-mode-${seat.id}`}>{seat.state.modelInfo.mode}</span>
                    )}
                  </span>
                )}
              {/* 移除按钮（仅管理员）：全局 confirm 二次确认（danger 红钮），
                确认后 DELETE；确认弹窗 + 移除中双重防重复点击。
                stopPropagation：未认领 chip 整体可点击，不隔离会连带打开向导弹窗 */}
              {canManage && (
                <button
                  type="button"
                  data-testid={`remove-seat-${seat.id}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (confirmPendingRef.current || removeMutation.isPending) return;
                    confirmPendingRef.current = true;
                    try {
                      const ok = await confirm({
                        title: t('seatManager.removeTitle'),
                        description: t('seatManager.removeConfirm', { label: seat.label }),
                        confirmText: tGlobal('common.confirm'),
                        cancelText: tGlobal('common.cancel'),
                        confirmVariant: 'danger',
                      });
                      if (!ok) return;
                      removeMutation.mutate(seat.id);
                    } finally {
                      confirmPendingRef.current = false;
                    }
                  }}
                  disabled={removeMutation.isPending}
                  className="ml-auto shrink-0 text-xs text-destructive hover:text-destructive/80 disabled:opacity-50"
                >
                  <Trash2 className="mr-0.5 inline h-3 w-3" />
                  {t('seatManager.remove')}
                </button>
              )}
            </span>
          );
        })}
      </div>
      {/* 内联瞬态提示（移除失败等）：独立于 chip 组外一行——错误提示不混入座位流，
          克制模式同旧 SeatManager（无 toast 体系） */}
      {notice && (
        <span className="text-xs text-destructive" data-testid="seat-badges-notice">
          {notice}
        </span>
      )}
      {/* 连接向导模态框（2026-08-12 改版）：点击未认领 chip 打开；内容 = 复用
          RunnerConnectGuide（组件本体零改动）——验收环轮询随弹窗挂载启停；
          关闭（遮罩/X）或座位从列表消失（被移除）即卸载。onExit 除关闭弹窗外
          透传外层动作（话题页 = 关闭参与者 Sheet，与 SeatManagement 同规） */}
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
    </>
  );
}
