'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 账本行的**下一步出口**：把 `recoveryPath`（机器码）翻译成人类文案 + 账本 id 出口
 *
 * [代码职责]
 *   - 单一实现"recoveryPath → 人话"：卡片（「提名记录」行）与详情页共用，禁两处各写一份
 *   - 提供 `ledgerId` 与（可选的）**复制**按钮——卡内不能放（见下），详情页可以
 *
 * [权威文档]
 *   - 实现蓝本: Memory web 二期 plan v2.1 §5 第 26 条（人类文案 + 只读出口，不裸渲染机器码）
 *     + 第 48 条（卡内不得有独立可点元素）
 *   - 值域源: apps/backend/src/modules/memory/engines/formation-state.mapper.ts
 *     （`MEMORY_RECOVERY_PATHS`；web 镜像在 lib/memory.ts）
 *
 * [关键不变量]
 *   - **未映射值走通用文案**：`recoveryPath` 是**开放**的后端码（新码不需要前端发版），
 *     把未知值原样渲染会向用户泄露"hub_manual_required"这类机器码，也给不出下一步
 *   - **卡片里没有复制按钮、详情页才有**（第 26 与 48 条的交汇点）：整卡是一个 `<Link>`，
 *     `<a>` 内嵌 `<button>` 是非法 HTML，且会抢走"整卡即钻取"的单一语义。
 *     故卡片渲染文案 + 账本 id **文本**（可选中复制），交互式复制留到详情页
 *   - 复制按钮失败要静默降级（无 `navigator.clipboard` 的 http/老旧环境）——
 *     账本 id 恒以**可选中文本**并列渲染，复制只是便利，不是唯一通道
 *
 * [关联代码]
 *   - ../../lib/memory.ts — `memoryRecoveryKind` 白名单映射（本组件只做文案与出口）
 *   - ./memory-card.tsx / ../app/(main)/memory/[id]/page.tsx — 两个消费点
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增码仍走白名单（不裸渲染机器码）
 *   □ 不要在卡片上下文传入 `ledgerId` 的复制按钮（见 [关键不变量]）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/notify';
import { memoryRecoveryKind, type MemoryRecoveryKind } from '@/lib/memory';
import { cn } from '@/lib/utils';

/**
 * recoveryPath 分叉键 → 人类文案（**显式字面量映射**：next-intl 的 key 有编译期校验，
 * 禁动态拼 key；新增分叉必须同时改这里与两侧语言包）。
 *
 * @param t - `memory` 命名空间的 translator
 * @param kind - 白名单分叉键（未映射值 = 'unknown'）
 * @returns 可直接渲染的文案
 */
function recoveryText(
  t: ReturnType<typeof useTranslations<'memory'>>,
  kind: MemoryRecoveryKind,
): string {
  switch (kind) {
    case 'sameKeyResend':
      return t('recovery.sameKeyResend');
    case 'inspectBackfill':
      return t('recovery.inspectBackfill');
    case 'hubManualRequired':
      return t('recovery.hubManualRequired');
    case 'configInvalid':
      return t('recovery.configInvalid');
    case 'paramInvalid':
      return t('recovery.paramInvalid');
    default:
      return t('recovery.unknown');
  }
}

interface MemoryRecoveryNoteProps {
  /** 后端 `recoveryPath` 原值 */
  recoveryPath: string;
  /** 账本行 id（恒以可选中文本渲染；`copyable` 时额外给复制按钮） */
  ledgerId: string;
  /**
   * 是否渲染复制按钮。
   *
   * **卡片上下文必须留 false**：整卡是一个 `<Link>`，`<a>` 内嵌 `<button>` 是非法 HTML，
   * 且违反"卡内不得有独立可点元素"（第 48 条）。
   */
  copyable?: boolean;
  className?: string;
  /** 外层测试锚点（两个消费点的 testid 不同） */
  testId?: string;
}

/**
 * 下一步出口（人类文案 + 账本 id [+ 复制]）。
 *
 * 只渲染**有 recoveryPath** 的行——空值意味着"这条没有记录下一步动作"，
 * 渲染一句"无"反而让人怀疑是数据丢了。
 */
function MemoryRecoveryNote({
  recoveryPath,
  ledgerId,
  copyable = false,
  className,
  testId,
}: MemoryRecoveryNoteProps) {
  const t = useTranslations('memory');

  /** 复制账本 id：失败静默（id 文本恒在旁边，可手动选中——复制只是便利通道） */
  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(ledgerId).then(
      () => toast.success({ title: t('recovery.copied') }),
      () => undefined,
    );
  };

  return (
    <div className={cn('space-y-1', className)} data-testid={testId}>
      <p className="text-[11px] text-amber-300" data-testid="memory-recovery-text">
        {recoveryText(t, memoryRecoveryKind(recoveryPath))}
      </p>
      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <span className="text-muted-foreground">{t('recovery.label')}</span>
        <span className="font-mono" data-testid="memory-recovery-ledger-id">
          {ledgerId}
        </span>
        {copyable && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            data-testid="memory-recovery-copy"
            onClick={copy}
          >
            <Copy className="mr-1 h-3 w-3" />
            {t('recovery.copyLedgerId')}
          </Button>
        )}
      </p>
    </div>
  );
}

export { MemoryRecoveryNote, recoveryText };
