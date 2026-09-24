'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 导出入方式菜单（docs 空间页页头）——项目无 dropdown 基元（主脑裁决 A：不引依赖、
 * 不提炼 ui/ 通用基元），本组件与 `components/members/row-menu.tsx` 逐行对齐同一模式：
 * useState + fixed 遮罩 + absolute 实色浮层 + Esc / 遮罩 / 选项点击关闭。
 *
 * 与 RowMenu 的差异（故不复用）：触发是**带文案的 Button**（不是 40px 图标钮），
 * 且每个选项带一行说明（两种导出格式的认知差异必须写在选项旁，见 R6）。
 *
 * 行为契约：
 * - 触发钮 → 浮层两选项：JSON（机器可读全量快照）/ ZIP（人类可读目录树）；
 * - `exporting` = 任一导出进行中：触发钮 isLoading（Button 内部 disabled）+ 选项禁用（R7，防连点）；
 * - editing 态**不禁用**触发钮，只换 tooltip（导出取服务端快照，与未保存编辑无关，R4）。
 */

/** 菜单文案（调用方按 locale 注入，组件不依赖 next-intl） */
export interface ExportMenuLabels {
  /** 触发钮文案（如「导出」） */
  trigger: string;
  /** JSON 选项标题 */
  jsonLabel: string;
  /** JSON 选项一行说明（R6：完整快照 + 可回导，preempt「JSON 只是索引」误解） */
  jsonDesc: string;
  /** ZIP 选项标题 */
  zipLabel: string;
  /** ZIP 选项一行说明（**不得**出现可回导暗示，R7） */
  zipDesc: string;
}

interface ExportMenuProps {
  labels: ExportMenuLabels;
  /** 导出 JSON bundle（机器可读，可回导） */
  onExportJson: () => void;
  /** 导出人类可读 ZIP（仅供阅读 / 搬运） */
  onExportZip: () => void;
  /** 是否正在导出：触发钮 isLoading、选项禁用 */
  exporting: boolean;
  /** 触发钮 tooltip（editing 时传「不含未保存编辑」说明） */
  title?: string;
}

export function ExportMenu({
  labels,
  onExportJson,
  onExportZip,
  exporting,
  title,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);

  /** Esc 关闭（open 期间挂载监听，关闭自动移除） */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  /** 选项点击：先关浮层再执行动作（动作含异步导出，与菜单关闭链路解耦） */
  const handleSelect = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="relative" data-testid="export-menu">
      <Button
        type="button"
        variant="outline"
        size="sm"
        isLoading={exporting}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {!exporting && <Download className="mr-1 h-4 w-4" />}
        {labels.trigger}
        {!exporting && <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-70" />}
      </Button>
      {open && (
        <>
          {/* 遮罩：fixed 全屏点击关闭（层级低于浮层、高于页面其余内容） */}
          <div
            className="fixed inset-0 z-40"
            data-testid="export-menu-overlay"
            onClick={() => setOpen(false)}
          />
          {/* 浮层：absolute 定位于触发钮下方；实色底（bg-popover）避免透出下层内容 */}
          <div
            role="menu"
            data-testid="export-menu-panel"
            className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-popover p-1 text-left shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              disabled={exporting}
              data-testid="export-menu-json"
              onClick={() => handleSelect(onExportJson)}
              className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            >
              <span className="text-sm font-medium text-foreground">{labels.jsonLabel}</span>
              <span className="text-xs text-muted-foreground">{labels.jsonDesc}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={exporting}
              data-testid="export-menu-zip"
              onClick={() => handleSelect(onExportZip)}
              className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            >
              <span className="text-sm font-medium text-foreground">{labels.zipLabel}</span>
              <span className="text-xs text-muted-foreground">{labels.zipDesc}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
