'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { RowMenu, type RowMenuItem } from './row-menu';
import type { MemberItem, MembersSheetLabels, MembersSheetProps } from './types';

interface MemberRowProps {
  member: MemberItem;
  labels: MembersSheetLabels;
  capabilities: MembersSheetProps['capabilities'];
  onRemove?: (actorId: string) => void;
  onChangeRole?: (actorId: string, newRole: string) => void;
  onTransferCreator?: (actorId: string) => void;
  /** 行扩展插槽（圆桌 SeatBadges）：Avatar 与名字之间渲染 */
  renderRowExtra?: (member: MemberItem) => React.ReactNode;
}

/** 行级危险操作确认态：null = 无弹窗（AlertDialog 一次只承载一个操作） */
type ConfirmKind = 'remove' | 'transfer' | null;

/**
 * 成员行（主视图列表单元）：
 * Avatar + 名字 + type·role 副行 + 行扩展插槽 + 角色 Badge + 三点菜单。
 * 菜单项按 capabilities 装配（R3：changeRole 按 fromRole 匹配当前行角色——member 行
 * 显「设为编辑者」、editor 行显「设为成员」）；危险项（移除/转让创建者）经 AlertDialog
 * 二次确认后才回调。无任何操作能力时渲染纯展示行（无菜单按钮）。
 */
export function MemberRow({
  member,
  labels,
  capabilities,
  onRemove,
  onChangeRole,
  onTransferCreator,
  renderRowExtra,
}: MemberRowProps) {
  const t = useTranslations('members');
  const tGlobal = useTranslations('common');
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);

  // 已删除降级（统一批 B）：deletedAt 非空 → 名字灰化 + 「已删除」Badge + Avatar
  // 灰化（Avatar deleted prop 隐藏 Bot 角标）；名字保留（历史归因不丢）
  const isDeleted = !!member.deletedAt;

  // 文案映射缺省回退原始值（协议值不翻译，页面层 labels 覆盖显示文案）
  const typeLabel = labels.typeLabels[member.actorType] ?? member.actorType;
  const roleLabel = labels.roleLabels[member.role] ?? member.role;

  /** 三点菜单项装配（capabilities 驱动；R3 升降级按 fromRole 过滤） */
  const items: RowMenuItem[] = [
    // 升降级：非危险项，直接回调（页面层 mutation 自行处理失败）
    ...(capabilities.changeRole ?? [])
      .filter((c) => c.fromRole === member.role)
      .map((c) => ({
        key: `change-role-${c.toRole}`,
        label: c.label,
        onSelect: () => onChangeRole?.(member.actorId, c.toRole),
      })),
    // 转让创建者（docs 特有）：危险项 → 先弹确认
    ...(capabilities.transferCreator
      ? [
          {
            key: 'transfer-creator',
            label: t('transferCreator'),
            danger: true as const,
            onSelect: () => setConfirmKind('transfer'),
          },
        ]
      : []),
    // 移除：危险项 → 先弹确认；member.canRemove === false 的行直接不给入口
    // （自己/创建者等后端注定拒绝的行——前端克制优先于后端 400/403 兜底）
    ...(capabilities.remove && member.canRemove !== false
      ? [
          {
            key: 'remove',
            label: t('remove'),
            danger: true as const,
            onSelect: () => setConfirmKind('remove'),
          },
        ]
      : []),
  ];

  return (
    <div
      data-testid={`member-row-${member.actorId}`}
      className="flex items-center gap-3 rounded-lg border p-2.5"
    >
      <Avatar
        src={member.avatarUrl ?? undefined}
        fallback={member.name}
        size="sm"
        actorType={member.actorType}
        seed={member.actorId}
        deleted={isDeleted}
      />
      {renderRowExtra?.(member)}
      <div className="min-w-0 flex-1">
        <p
          className={cn('truncate text-sm font-medium', isDeleted && 'opacity-60')}
          title={isDeleted ? tGlobal('deleted') : undefined}
        >
          {member.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {typeLabel} · {roleLabel}
        </p>
      </div>
      {/* 角色 Badge：纯展示（行操作已收敛到三点菜单） */}
      <Badge variant="outline" className="shrink-0 text-[10px]">
        {roleLabel}
      </Badge>
      {/* 已删除 Badge（统一批 B）：secondary 低调标记，与角色 Badge 并列；名字保留 */}
      {isDeleted && (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {tGlobal('deleted')}
        </Badge>
      )}
      {items.length > 0 && (
        <RowMenu
          testId={`member-menu-${member.actorId}`}
          ariaLabel={t('menuAria', { name: member.name })}
          items={items}
        />
      )}

      {/* 危险操作二次确认（移除/转让创建者）：确认后回调并关弹窗；取消/遮罩/Esc 仅关弹窗 */}
      <AlertDialog
        open={confirmKind !== null}
        title={confirmKind === 'transfer' ? t('transferConfirmTitle') : t('removeConfirmTitle')}
        description={
          confirmKind === 'transfer'
            ? t('transferConfirmDesc', { name: member.name })
            : t('removeConfirmDesc', { name: member.name })
        }
        confirmText={confirmKind === 'transfer' ? t('transferCreator') : t('remove')}
        cancelText={tGlobal('cancel')}
        confirmVariant="danger"
        onConfirm={() => {
          if (confirmKind === 'transfer') {
            onTransferCreator?.(member.actorId);
          } else if (confirmKind === 'remove') {
            onRemove?.(member.actorId);
          }
          setConfirmKind(null);
        }}
        onCancel={() => setConfirmKind(null)}
        onOpenChange={(next) => {
          if (!next) setConfirmKind(null);
        }}
      />
    </div>
  );
}
