'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 下拉候选项（id 回传，label 展示，hint 次级说明行） */
export interface SearchSelectOption {
  id: string;
  label: string;
  hint?: string;
}

interface SearchSelectPopoverProps {
  open: boolean;
  onClose: () => void;
  /** 异步搜索函数：父级负责调 API，返回候选列表 */
  onSearch: (q: string) => Promise<SearchSelectOption[]>;
  onSelect: (option: SearchSelectOption) => void;
  placeholder?: string;
  emptyText?: string;
  /** 搜索防抖毫秒数，默认 250 */
  debounceMs?: number;
  /** 选中后是否自动关闭面板，默认 true；两步流程的第一步需置 false */
  closeOnSelect?: boolean;
  className?: string;
}

/**
 * SearchSelectPopover — 搜索选择下拉面板（doc-picker / task-picker 共用底层）
 *
 * 项目无 command/popover UI 组件先例，本组件即「自定义 dropdown」的收敛实现：
 * 父级提供相对定位容器与触发按钮，本组件渲染绝对定位面板，内置输入框 + 防抖搜索 +
 * 候选列表。Escape / 点击外部关闭；请求序号守卫防止慢响应覆盖新结果。
 */
export function SearchSelectPopover({
  open,
  onClose,
  onSearch,
  onSelect,
  placeholder,
  emptyText,
  debounceMs = 250,
  closeOnSelect = true,
  className,
}: SearchSelectPopoverProps) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchSelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 请求序号：仅最后一次请求的结果可落屏，防抖 + 乱序守卫 */
  const requestSeq = useRef(0);

  /** 打开时复位状态并聚焦输入框 */
  useEffect(() => {
    if (open) {
      setQuery('');
      setOptions([]);
      requestSeq.current += 1;
      // 等面板挂载后再聚焦
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  /** 防抖搜索（query 变化即触发，空串也搜——父级决定空串返回什么） */
  useEffect(() => {
    if (!open) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      onSearch(query)
        .then((result) => {
          if (seq !== requestSeq.current) return;
          setOptions(result);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setOptions([]);
        })
        .finally(() => {
          if (seq !== requestSeq.current) return;
          setLoading(false);
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [query, open, onSearch, debounceMs]);

  /** 点击外部关闭 */
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

  return (
    <div
      ref={containerRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      className={cn(
        'absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-border/60 bg-popover p-2 shadow-lg animate-in fade-in zoom-in-95 duration-100',
        className,
      )}
    >
      <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
      </div>
      <div className="mt-1 max-h-56 overflow-y-auto">
        {!loading && options.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          options.map((option) => (
            <button
              key={option.id}
              onClick={() => {
                onSelect(option);
                if (closeOnSelect) onClose();
              }}
              className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent"
            >
              <span className="w-full truncate text-sm">{option.label}</span>
              {option.hint && (
                <span className="w-full truncate text-xs text-muted-foreground">{option.hint}</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
