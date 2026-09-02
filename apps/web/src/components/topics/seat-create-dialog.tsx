'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §5（roundtable_seats 表）/ §6（座位管理）
 *   - 补充: docs/frontend-architecture.md §3.2.3（话题详情页——圆桌座位管理 UI）
 *
 * [踩坑索引]
 *   - web 无 toast 体系：错误用内联瞬态提示（与 seat-badges notice 同款克制模式）
 *   - bindActorId：web（人类 JWT）创建必须显式选择（DTO 缺省只兜 agent 创建者
 *     绑自己——人类不选会落 400/绑定缺失）
 *   - vendor 与 runner 在线状态联动只是「提示」不是「阻断」：允许先建离线座位，
 *     runner 上线后自动认领（bindSeats 规则：bindActorId + vendor ∈ hello.vendors）
 *   - 建座成功不关窗（v1.51.0）：切「下一步」两态视图内嵌 RunnerConnectGuide，
 *     用户手动关闭；关闭路径统一走 handleClose 重置表单+成功态
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { Api, RUNNER_STATUS, type RoundtableRunnerItem, type RoundtableSeatItem } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { RunnerConnectGuide } from './runner-connect-guide';

/**
 * 座位厂商（协议值不翻译，与 backend SEAT_VENDORS 同规；新增厂商时同步此处 +
 * i18n 说明文案）。形状：value = 协议值，descKey = 一句语义说明的 i18n 键。
 */
const VENDOR_OPTIONS = [
  { value: 'kimi' },
  { value: 'codex' },
  { value: 'opencode' },
  { value: 'claude-code' },
] as const;

/**
 * 权限模式四档（协议值不翻译；语义说明走 i18n）。映射关系（runner 侧）：
 * codex = default→read-only / plan→read-only+plan 协作 / auto→agent /
 * yolo→agent-full-access；kimi 同档语义；opencode = default/plan→build/plan +
 * 权限 ask 钉死，auto/yolo→build + 权限全放行（opencode 无 auto/yolo 原语，
 * 语义近似，见 opencode-acp.ts O1/O2）；claude-code = default→default /
 * plan→plan / auto→acceptEdits / yolo→bypassPermissions（claude 五值原语，
 * dontAsk 不用，语义近似，见 claude-acp.ts C2）。'auto' 是 dogfood 推荐档（默认选中）。
 */
const PERMISSION_MODE_OPTIONS = [
  { value: 'default', descKey: 'pmDefaultDesc' },
  { value: 'plan', descKey: 'pmPlanDesc' },
  { value: 'auto', descKey: 'pmAutoDesc' },
  { value: 'yolo', descKey: 'pmYoloDesc' },
] as const;

interface SeatCreateDialogProps {
  /** 所属圆桌 topic UUID（提交 payload + seats 查询 invalidate 键） */
  topicId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** runner 列表（调用方查询结果透传）：vendor 选择处的「无支持 runner 在线」提示数据源 */
  runners: RoundtableRunnerItem[];
}

/**
 * 建座 Dialog（v1.49.0，C3；v1.51.0 两态化）：核心字段平铺（label / vendor / 绑定 agent /
 * cwd / permissionMode），高级项折叠（model / coordinator / batchWindowMs——
 * 用户拍板「核心 + 高级折叠」形态）。
 *
 * 提交流：Api.roundtable.createSeat → invalidate seats 查询（@ 补全候选、
 * SeatBadges、SeatPresenceBar 同源刷新）→ **不关窗**，切「下一步」两态视图内嵌
 * RunnerConnectGuide（座位刚建必 runnerId==null，验收环直接适用），用户手动关闭
 * （v1.51.0，plan §1.3：建座成功不再戛然而止，衔接「最后一公里」连接向导）。
 * 校验：label/cwd/绑定 agent 必填（提交钮 disabled 前置拦截，格式校验仍以后端
 * DTO 为准）；vendor-runner 联动仅 amber 提示不阻断（离线座位是合法中间态）。
 */
export function SeatCreateDialog({ topicId, open, onOpenChange, runners }: SeatCreateDialogProps) {
  const t = useTranslations('topics');
  const queryClient = useQueryClient();

  /** 两态视图：form（表单）/ created（成功 → 内嵌连接向导） */
  const [phase, setPhase] = useState<'form' | 'created'>('form');
  /** 刚创建的座位实体（成功态向导的 seat 上下文；label/vendor/runnerId 全来自响应） */
  const [createdSeat, setCreatedSeat] = useState<RoundtableSeatItem | null>(null);

  // ── 核心字段 ──
  const [label, setLabel] = useState('');
  const [vendor, setVendor] = useState<string>('kimi');
  const [bindActorId, setBindActorId] = useState('');
  const [cwd, setCwd] = useState('');
  const [permissionMode, setPermissionMode] = useState<string>('auto');
  // ── 高级折叠区 ──
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [model, setModel] = useState('');
  const [coordinator, setCoordinator] = useState(false);
  const [batchWindowMs, setBatchWindowMs] = useState('');

  /** 内联瞬态错误提示（web 无 toast 体系，与 seat-badges notice 同款） */
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

  /** 绑定 agent 候选（dialog 打开时才拉取，60s 内复用缓存） */
  const { data: agents } = useQuery({
    queryKey: ['agents', 'listAll'],
    queryFn: () => Api.agents.listAll(),
    enabled: open,
    staleTime: 60_000,
  });

  const resetForm = () => {
    setLabel('');
    setVendor('kimi');
    setBindActorId('');
    setCwd('');
    setPermissionMode('auto');
    setAdvancedOpen(false);
    setModel('');
    setCoordinator(false);
    setBatchWindowMs('');
  };

  /**
   * 关闭（X/遮罩/「完成」钮共用）：重置表单与成功态，回到 form 相位。
   * 下一次打开永远是干净的建座表单。
   */
  const handleClose = () => {
    resetForm();
    setCreatedSeat(null);
    setPhase('form');
    onOpenChange(false);
  };

  const createMutation = useMutation({
    mutationFn: Api.roundtable.createSeat,
    onSuccess: (seat) => {
      // seats 查询失效：@ 补全候选 / SeatBadges / SeatPresenceBar 同源刷新
      void queryClient.invalidateQueries({ queryKey: ['roundtable', 'seats', topicId] });
      // 不关窗：切「下一步」两态视图，内嵌连接向导（v1.51.0）——建座成功不再
      // 戛然而止，用户看完/连接完再手动关闭
      setCreatedSeat(seat);
      setPhase('created');
    },
    onError: (err) => {
      // 403 = 非 topic 参与者无写权限（后端本来就会拒绝）；其余按通用失败提示
      if (err instanceof AxiosError && err.response?.status === 403) {
        showNotice(t('seatCreate.forbidden'));
      } else {
        showNotice(t('seatCreate.failed'));
      }
    },
  });

  /** 必填前置：label/cwd 非空 + 已选绑定 agent（web 人类创建无缺省可兜） */
  const canSubmit = label.trim().length > 0 && cwd.trim().length > 0 && bindActorId.length > 0;

  /** vendor-runner 联动提示：所选 vendor 无任何在线 runner 支持时 amber 提示（不阻断） */
  const vendorHasOnlineRunner = runners.some(
    (r) =>
      r.status === RUNNER_STATUS.ONLINE && Array.isArray(r.vendors) && r.vendors.includes(vendor),
  );

  const handleSubmit = () => {
    if (!canSubmit || createMutation.isPending) return;
    createMutation.mutate({
      topicId,
      label: label.trim(),
      vendor,
      cwd: cwd.trim(),
      permissionMode,
      bindActorId,
      // 高级项：空值不落 payload（缺省由后端/常量兜底，保持载荷瘦）
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(coordinator ? { coordinator: true } : {}),
      ...(batchWindowMs.trim() ? { batchWindowMs: Number(batchWindowMs) } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : handleClose())}>
      <DialogHeader>
        <DialogTitle>{t('seatCreate.title')}</DialogTitle>
        <DialogDescription>{t('seatCreate.desc')}</DialogDescription>
      </DialogHeader>
      {phase === 'form' ? (
        <>
          <div className="space-y-4 py-4">
            {/* label */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('seatCreate.label')}</label>
              <Input
                data-testid="seat-create-label"
                placeholder={t('seatCreate.labelPlaceholder')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>

            {/* vendor（协议值原文；runner 联动提示不阻断） */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('seatCreate.vendor')}</label>
              <div className="flex gap-4">
                {VENDOR_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="seat-vendor"
                      value={opt.value}
                      checked={vendor === opt.value}
                      onChange={() => setVendor(opt.value)}
                    />
                    <span className="text-sm font-mono">{opt.value}</span>
                  </label>
                ))}
              </div>
              {!vendorHasOnlineRunner && (
                <p className="text-xs text-amber-400" data-testid="seat-create-vendor-warning">
                  {t('seatCreate.vendorNoRunner', { vendor })}
                </p>
              )}
            </div>

            {/* 绑定 agent（人类创建必选；native select 克制风，agent 量不需要搜索弹层） */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('seatCreate.bindAgent')}</label>
              <select
                data-testid="seat-create-bind-agent"
                value={bindActorId}
                onChange={(e) => setBindActorId(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="">{t('seatCreate.bindAgentPlaceholder')}</option>
                {(agents ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            {/* cwd */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('seatCreate.cwd')}</label>
              <Input
                data-testid="seat-create-cwd"
                placeholder={t('seatCreate.cwdPlaceholder')}
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('seatCreate.cwdHint')}</p>
            </div>

            {/* permissionMode 四档（协议值 + 一句语义说明） */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('seatCreate.permissionMode')}</label>
              <div className="flex flex-col gap-2">
                {PERMISSION_MODE_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="seat-permission-mode"
                      value={opt.value}
                      checked={permissionMode === opt.value}
                      onChange={() => setPermissionMode(opt.value)}
                    />
                    <span className="text-sm">{t(`seatCreate.${opt.descKey}`)}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* 高级折叠区（model / coordinator / batchWindowMs） */}
            <div className="rounded-lg border border-border/60">
              <button
                type="button"
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="flex w-full items-center gap-1 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {advancedOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                {t('seatCreate.advanced')}
              </button>
              {advancedOpen && (
                <div className="space-y-4 px-3 pb-3">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('seatCreate.model')}</label>
                    <Input
                      placeholder={t('seatCreate.modelPlaceholder')}
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={coordinator}
                      onChange={(e) => setCoordinator(e.target.checked)}
                    />
                    <span className="text-sm">{t('seatCreate.coordinator')}</span>
                  </label>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('seatCreate.batchWindow')}</label>
                    <Input
                      type="number"
                      min={0}
                      max={300000}
                      placeholder={t('seatCreate.batchWindowPlaceholder')}
                      value={batchWindowMs}
                      onChange={(e) => setBatchWindowMs(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 内联瞬态错误提示（无 toast 体系克制模式） */}
            {notice && (
              <p className="text-xs text-destructive" data-testid="seat-create-notice">
                {notice}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose()}>
              {t('seatCreate.cancel')}
            </Button>
            <Button
              data-testid="seat-create-submit"
              onClick={handleSubmit}
              disabled={!canSubmit}
              isLoading={createMutation.isPending}
            >
              {t('seatCreate.submit')}
            </Button>
          </DialogFooter>
        </>
      ) : (
        /* 成功态（v1.51.0）：不关窗，内嵌连接向导——座位刚建必 runnerId==null，
           验收环从「等待 runner 上线」开始；用户连接完或改主意后手动关闭 */
        createdSeat && (
          <>
            <div className="space-y-3 py-4" data-testid="seat-create-success">
              <p className="flex items-center gap-1.5 text-sm text-emerald-400">
                <Check className="h-4 w-4" />
                {t('seatCreate.success', { label: createdSeat.label })}
              </p>
              <RunnerConnectGuide seat={createdSeat} topicId={topicId} defaultOpen />
            </div>
            <DialogFooter>
              <Button data-testid="seat-create-done" onClick={() => handleClose()}>
                {t('seatCreate.done')}
              </Button>
            </DialogFooter>
          </>
        )
      )}
    </Dialog>
  );
}
