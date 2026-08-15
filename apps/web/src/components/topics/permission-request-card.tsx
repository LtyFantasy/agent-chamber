'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（话题详情页消息流——审批裁决卡片）
 *   - 补充: docs/roundtable-design.md §6（审批可见性/裁决）+ docs/api-definition.md §7a
 *
 * [踩坑索引]
 *   - tool/options 是 jsonb 原样透传，**形状未冻结**：tool 宽松读 name/title 兜底
 *     JSON 截断；options 真机形状 `{ optionId, kind, name }`（kimi/codex 实测均无
 *     label），按钮文案 = 已知 optionId 映射 i18n 词条（OPTION_I18N_KEYS 展示层
 *     词典），未知回退 label ?? name ?? optionId——不假设形状。optionId 裁决按
 *     optionId/id 双键取（后端同规）。禁止把 kind 硬编码成仅三种——kind 只用于
 *     配色分类（含 'reject' 子串 → 危险色，其余主色）
 *   - avatar 来源 = seatId → seats → config.bindActorId → topic.participants 的
 *     avatarUrl（照 seat-presence-bar 同款数据通路，页面数据零重复请求）；
 *     participants 缺省空数组向后兼容，无参与者数据退化为 seat label 首字母色块
 *   - pending-count 响应是 `{ count }` 包装（非裸 number），queryKey 固定
 *     ['roundtable','permission-count']——与 sidebar 角标、verdict invalidate 三处一致
 *   - 裁决反馈（v1.48.1）：成功/非 409 失败走全局 toast（lib/notify，v1.45+ 全局
 *     Alert/Toast 体系）；409「已被他人先裁决」竞态用卡片内联瞬态提示——他人动作
 *     非本人操作失败，不打断当前视野
 *   - 人类才见裁决按钮：web 会话 = 人类 JWT（auth store user 非空）；agent API Key
 *     不建立 web 会话。按钮渲染以 user 存在为闸（后端本来就 403，前端仅体验层）
 *   - 空态不渲染任何容器（零视觉噪音）；enabled=false（非圆桌 topic）连请求都不发
 *
 * [铁律关联] #7(视觉克制) #11(注释强制) #17(测试契约) #20(契约即设计)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Api, type RoundtablePermissionRequestItem, type RoundtableSeatItem } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { toast } from '@/lib/notify';
import type { TopicParticipant } from '@/types';

/** tool 摘要 JSON 兜底的最大展示长度（超出截断加省略号） */
const TOOL_JSON_FALLBACK_MAX = 80;

/** 词典值 = 三个语义词条的字面量联合（next-intl 类型安全 key 要求，禁止放宽成 string） */
type PermissionOptionI18nKey =
  | 'permissionRequest.option.approveOnce'
  | 'permissionRequest.option.approveAlways'
  | 'permissionRequest.option.reject';

/**
 * optionId → i18n key 的展示层词典（修复 ③：按钮英文）。
 *
 * 为什么按 optionId 做键：optionId 是裁决稳定键（后端 optionId/id 双键同规），
 * name/label 是厂商自由文本（真机实测 kimi 用 'Approve once'，codex 用
 * 'Allow Once'，两侧都无 label）——词典把两家等价选项收敛到 3 个语义词条，
 * 未知 optionId 回退透传（label ?? name ?? optionId），不假设形状、不穷举厂商
 */
const OPTION_I18N_KEYS: Record<string, PermissionOptionI18nKey> = {
  approve_once: 'permissionRequest.option.approveOnce', // kimi
  approve_always: 'permissionRequest.option.approveAlways',
  reject: 'permissionRequest.option.reject',
  allow_once: 'permissionRequest.option.approveOnce', // codex
  allow_always: 'permissionRequest.option.approveAlways',
  reject_once: 'permissionRequest.option.reject',
  allow: 'permissionRequest.option.approveOnce', // claude-code：allow_once kind 对应 optionId=allow（optionId 直透，见 claude-acp.ts §8e）
};

interface PermissionRequestCardProps {
  /** 圆桌 topic UUID（审批请求按 topic 归属查询） */
  topicId: string;
  /** 座位列表（页面 seats useQuery 数据；用于 seatId→label 映射，缺省兜底短 id） */
  seats?: RoundtableSeatItem[];
  /**
   * 参与者列表（seatId → config.bindActorId → 参与者，头像查找源；
   * topic.participants 页面已有，照 SeatPresenceBar 同款数据通路；
   * 缺省空数组向后兼容——无参与者数据时头像退化为 seat label 首字母色块）
   */
  participants?: TopicParticipant[];
  /**
   * 是否启用（仅 kind='roundtable' 传 true）——非圆桌 topic 不请求审批 API、
   * 不渲染卡片（短路条件集中在组件内以便单测覆盖）
   */
  enabled?: boolean;
}

/**
 * 圆桌审批裁决卡片（M3 阶段 2）：topic 内 pending 审批列表。
 *
 * 数据通路：react-query 轮询（web 无 WebSocket）——30s refetchInterval 与全局
 * 角标同节奏；verdict 成功后联动 invalidate 三个 query（本卡片列表、全局
 * pending-count 角标、topic 消息列表——后端裁决会落 topic 公告系统消息）。
 * 空态（无 pending）不渲染任何容器；人类（web 会话恒为人类 JWT）见裁决按钮组，
 * 按钮文案 = 已知 optionId 的 i18n 词条（OPTION_I18N_KEYS 展示层词典），未知
 * optionId 回退 label ?? name ?? optionId；reject 类（kind 含 'reject' 子串）
 * 用危险色。每行 seat label 徽章前渲染参与者头像（bindActorId → participants）。
 */
export function PermissionRequestCard({
  topicId,
  seats,
  participants = [],
  enabled = true,
}: PermissionRequestCardProps) {
  const t = useTranslations('topics');
  const queryClient = useQueryClient();
  // web 会话 = 人类 JWT（agent 走 API Key 不建 web 会话）；user 存在即人类，
  // 显示裁决按钮。后端本来就对 agent 403——这里是体验层闸，防未来 agent 会话回归
  const isHuman = useAuthStore((state) => state.user != null);

  /** 内联瞬态提示（v1.48.1 起仅用于 409「已被他人裁决」竞态——他人动作不打断；
   *  成功/真实失败已走全局 toast，见 lib/notify） */
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

  const { data } = useQuery({
    queryKey: ['roundtable', 'permission-requests', topicId],
    queryFn: () =>
      Api.roundtable.listPermissionRequests(topicId, {
        status: 'pending',
        // 一屏够用的分页大小：卡片不做分页 UI，超出部分随轮询自然滚动更新
        pageSize: 50,
      }),
    enabled: enabled && !!topicId,
    refetchInterval: 30_000,
  });
  const pendingItems = data?.items ?? [];

  const verdictMutation = useMutation({
    mutationFn: ({ requestId, optionId }: { requestId: string; optionId: string }) =>
      Api.roundtable.verdictPermissionRequest(requestId, optionId),
    onSuccess: () => {
      // 联动失效三件套：本卡片 pending 列表 + 全局 pending-count 角标 +
      // topic 消息列表（后端裁决落 topic 公告 system 消息）
      void queryClient.invalidateQueries({
        queryKey: ['roundtable', 'permission-requests', topicId],
      });
      void queryClient.invalidateQueries({ queryKey: ['roundtable', 'permission-count'] });
      void queryClient.invalidateQueries({ queryKey: ['topics', 'messages', topicId] });
      // 裁决成功反馈（v1.48.1 接线）：统一文案「已裁决」——kind 是未冻结的配色字段，
      // 禁止按 approve/reject 区分语义文案（AGENT-HOOK 明文）
      toast.success({ title: t('permissionRequest.verdictSuccess') });
    },
    onError: (err) => {
      // 409 = 已被他人/先到裁决（页面轮询可能还没刷到）→ 失效重取 + 内联提示
      if (err instanceof AxiosError && err.response?.status === 409) {
        void queryClient.invalidateQueries({
          queryKey: ['roundtable', 'permission-requests', topicId],
        });
        void queryClient.invalidateQueries({ queryKey: ['roundtable', 'permission-count'] });
        showNotice(t('permissionRequest.alreadyResolved'));
      } else {
        // 真实失败（网络/权限等）→ 全局 error toast（v1.48.1 接线，词条原有）
        toast.error({ title: t('permissionRequest.verdictFailed') });
      }
    },
  });

  /** bindActorId → 参与者行映射（avatarUrl 查找源；页面 participants 数据零重复请求，
      照 SeatPresenceBar 同款） */
  const participantByActorId = useMemo(() => {
    const map = new Map<string, TopicParticipant>();
    for (const p of participants) map.set(p.participantId, p);
    return map;
  }, [participants]);

  // 空态（含加载中无数据）：不渲染任何容器，零视觉噪音
  if (!enabled || pendingItems.length === 0) {
    return null;
  }

  // seatId→label 映射（seats 数据由页面 useQuery 提供；未加载/缺项时兜底短 id）
  const seatLabelOf = (item: RoundtablePermissionRequestItem): string => {
    const label = seats?.find((s) => s.id === item.seatId)?.label;
    return label ?? t('permissionRequest.seatFallback', { id: item.seatId.slice(0, 8) });
  };

  /** 工具摘要：优先 name/title 友好文案，兜底 JSON 截断（形状未冻结，宽松读取） */
  const toolSummaryOf = (item: RoundtablePermissionRequestItem): string => {
    const tool = item.tool ?? {};
    const friendly =
      (typeof tool.name === 'string' && tool.name.trim()) ||
      (typeof tool.title === 'string' && tool.title.trim());
    if (friendly) return friendly;
    const raw = JSON.stringify(tool);
    return raw.length > TOOL_JSON_FALLBACK_MAX
      ? `${raw.slice(0, TOOL_JSON_FALLBACK_MAX)}…`
      : raw || '—';
  };

  return (
    // 玻璃卡：半透实色底 + 弱边框（页内展示位，非滚动列表重复元素，允许 glass 壳层）
    <div className="glass mb-3 rounded-xl px-3 py-2 md:mb-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-foreground/80">
          {t('permissionRequest.title', { count: pendingItems.length })}
        </h2>
        {notice && (
          <span className="text-xs text-destructive" data-testid="pr-notice">
            {notice}
          </span>
        )}
      </div>
      <ul className="space-y-2">
        {pendingItems.map((item) => {
          // seatId → 座位 → config.bindActorId → 参与者（头像查找链，照 SeatPresenceBar；
          // seats/participants 任一缺数据 → undefined，Avatar 退化为 label 首字母色块）
          const participant = (() => {
            const seat = seats?.find((s) => s.id === item.seatId);
            const actorId = seat?.config?.bindActorId;
            return actorId ? participantByActorId.get(actorId) : undefined;
          })();
          return (
            <li
              key={item.id}
              data-testid="pr-item"
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2"
            >
              <span className="flex shrink-0 items-center gap-1.5">
                <Avatar
                  src={participant?.avatarUrl ?? undefined}
                  fallback={participant?.name ?? seatLabelOf(item)}
                  size="xs"
                  actorType={participant?.participantType}
                  seed={participant?.participantId ?? item.seatId}
                />
                <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80">
                  {seatLabelOf(item)}
                </span>
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {toolSummaryOf(item)}
              </span>
              {/* 选项按钮组：文案 = 已知 optionId 的 i18n 词条（展示层词典），未知回退
                  label ?? name ?? optionId（真机形状无 label，name 兜底）；kind 仅配色
                  分类——含 'reject' 子串危险色，其余主色。仅人类会话显示（agent 体验层
                  闸，后端本来就 403）；裁决中整组禁用防重复点击 */}
              {isHuman && (
                <span className="flex shrink-0 items-center gap-1.5">
                  {item.options.map((option) => {
                    const optionId = option.optionId ?? option.id;
                    if (!optionId) return null;
                    const key = OPTION_I18N_KEYS[optionId];
                    const label = key ? t(key) : (option.label ?? option.name ?? optionId);
                    const dangerous = (option.kind ?? '').includes('reject');
                    const pendingThis =
                      verdictMutation.isPending &&
                      verdictMutation.variables?.requestId === item.id &&
                      verdictMutation.variables?.optionId === optionId;
                    return (
                      <Button
                        key={optionId}
                        size="sm"
                        variant={dangerous ? 'destructive' : 'outline'}
                        isLoading={pendingThis}
                        disabled={verdictMutation.isPending}
                        onClick={() => verdictMutation.mutate({ requestId: item.id, optionId })}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
