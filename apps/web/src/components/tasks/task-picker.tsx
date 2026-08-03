'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckSquare } from 'lucide-react';
import { Api } from '@/lib/api';
import {
  SearchSelectPopover,
  type SearchSelectOption,
} from '@/components/ui/search-select-popover';

/** 选中的任务（id 回传建立依赖，title 供触发器展示） */
export interface TaskPick {
  id: string;
  title: string;
}

interface TaskPickerProps {
  onSelect: (task: TaskPick) => void;
  /** 排除的任务 ID（不把自己加为自己的依赖） */
  excludeTaskId?: string;
  /** 触发器占位文案（未选择时显示） */
  placeholder: string;
  /** 已选择的任务标题（有值时触发器展示它） */
  selectedTitle?: string;
}

/**
 * TaskPicker — 任务搜索选择器（U5：替换依赖 Tab 裸 UUID 输入）
 *
 * 与 doc-picker 同模式，共用底层 SearchSelectPopover；搜索走 GET /tasks?q=。
 * 触发器为只读输入框样式的按钮，选中后展示任务标题。
 */
export function TaskPicker({
  onSelect,
  excludeTaskId,
  placeholder,
  selectedTitle,
}: TaskPickerProps) {
  const t = useTranslations('tasks.dependency');
  const tGlobal = useTranslations();
  const [open, setOpen] = useState(false);

  const searchTasks = useCallback(
    async (q: string): Promise<SearchSelectOption[]> => {
      const res = await Api.tasks.list({ q: q.trim() || undefined, pageSize: 8 });
      return (res.items ?? [])
        .filter((task) => task.id !== excludeTaskId)
        .map((task) => ({
          id: task.id,
          label: task.title,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hint: tGlobal(`tasks.status.${task.status}` as any),
        }));
    },
    [excludeTaskId, tGlobal],
  );

  return (
    <div className="relative flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <CheckSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span
          className={
            selectedTitle
              ? 'flex-1 truncate text-left'
              : 'flex-1 truncate text-left text-muted-foreground'
          }
        >
          {selectedTitle || placeholder}
        </span>
      </button>
      <SearchSelectPopover
        open={open}
        onClose={() => setOpen(false)}
        onSearch={searchTasks}
        onSelect={(option) => onSelect({ id: option.id, title: option.label })}
        placeholder={t('searchPlaceholder')}
        emptyText={t('noResults')}
      />
    </div>
  );
}
