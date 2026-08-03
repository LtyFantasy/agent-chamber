'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { FileText, ChevronLeft } from 'lucide-react';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  SearchSelectPopover,
  type SearchSelectOption,
} from '@/components/ui/search-select-popover';

/** 选中的文档（回传给父级用于建立 task↔doc 链接） */
export interface DocPick {
  docId: string;
  title: string;
  spaceId: string;
}

interface DocPickerProps {
  /** 任务所属看板 ID：绑定的空间排序靠前（默认选择优先体验） */
  boardId?: string;
  onSelect: (doc: DocPick) => void;
  disabled?: boolean;
  /** 触发按钮文案（默认走 i18n `docs.picker.addLabel`） */
  label?: string;
  /** 附加到触发按钮的 className（编辑器工具栏小按钮等场景） */
  buttonClassName?: string;
}

/**
 * DocPicker — 文档搜索选择器（先选 space 再模糊搜索文档）
 *
 * 两步流程，均复用底层 SearchSelectPopover：
 * 1. 空间选择：一次拉全量空间（pageSize 50），客户端按 q 过滤；
 *    任务 board 绑定的空间排序靠前。
 * 2. 文档搜索：空串走 listDocs 最近文档；有 q 走 search API（section 命中），
 *    同文档多 section 命中按 docId 去重。
 */
export function DocPicker({ boardId, onSelect, disabled, label, buttonClassName }: DocPickerProps) {
  const t = useTranslations('docs.picker');
  const [open, setOpen] = useState(false);
  const [space, setSpace] = useState<{ id: string; name: string } | null>(null);

  /** 空间列表（打开面板才拉） */
  const { data: spacesData } = useQuery({
    queryKey: ['docs', 'spaces', 'picker'],
    queryFn: () => Api.docs.listSpaces({ pageSize: 50 }),
    enabled: open,
  });

  /** 绑定当前看板的空间排前 */
  const spaces = useMemo(() => {
    const items = spacesData?.items ?? [];
    return [...items].sort((a, b) => {
      const aBound = a.boardId === boardId ? 0 : 1;
      const bBound = b.boardId === boardId ? 0 : 1;
      return aBound - bBound;
    });
  }, [spacesData, boardId]);

  /** 空间搜索：客户端过滤（全量已拉） */
  const searchSpaces = useCallback(
    async (q: string): Promise<SearchSelectOption[]> => {
      const keyword = q.trim().toLowerCase();
      return spaces
        .filter((s) => !keyword || s.name.toLowerCase().includes(keyword))
        .map((s) => ({
          id: s.id,
          label: s.name,
          hint: t('docCountHint', { count: s.docCount ?? 0 }),
        }));
    },
    [spaces, t],
  );

  /** 文档搜索：空串列最近文档；有 q 走检索 API 并按 docId 去重 */
  const searchDocs = useCallback(
    async (q: string): Promise<SearchSelectOption[]> => {
      if (!space) return [];
      if (!q.trim()) {
        const res = await Api.docs.listDocs(space.id, { pageSize: 8 });
        return res.items.map((d) => ({ id: d.id, label: d.title, hint: d.path }));
      }
      const hits = await Api.docs.search(space.id, { q, limit: 8 });
      const seen = new Set<string>();
      return hits
        .filter((h) => {
          if (seen.has(h.docId)) return false;
          seen.add(h.docId);
          return true;
        })
        .map((h) => ({ id: h.docId, label: h.docTitle, hint: h.headingPath || h.docPath }));
    },
    [space],
  );

  return (
    <div className="relative inline-block">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        className={buttonClassName}
        onClick={() => {
          setSpace(null);
          setOpen((v) => !v);
        }}
      >
        <FileText className="mr-1 h-3.5 w-3.5" />
        {label ?? t('addLabel')}
      </Button>

      {/* 第一步：选空间（closeOnSelect=false——选中不关闭，由 space 状态切换到第二步；w-72 防窄触发按钮压窄面板） */}
      <SearchSelectPopover
        open={open && !space}
        onClose={() => setOpen(false)}
        onSearch={searchSpaces}
        onSelect={(option) => setSpace({ id: option.id, name: option.label })}
        placeholder={t('selectSpace')}
        emptyText={t('noSpaces')}
        closeOnSelect={false}
        className="w-72"
      />

      {/* 第二步：空间内搜文档（头部带返回上一级） */}
      {open && space && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72">
          <button
            onClick={() => setSpace(null)}
            className="mb-1 flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span className="truncate">{space.name}</span>
          </button>
          <SearchSelectPopover
            open
            onClose={() => setOpen(false)}
            onSearch={searchDocs}
            onSelect={(option) =>
              onSelect({ docId: option.id, title: option.label, spaceId: space.id })
            }
            placeholder={t('searchDocs')}
            emptyText={t('noResults')}
            className="static mt-0 w-full"
          />
        </div>
      )}
    </div>
  );
}
