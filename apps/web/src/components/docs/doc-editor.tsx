/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §8.5（/docs 板块编辑/新建约定）
 *   - 补充: docs/api-definition.md §16（upsert 语义：未传字段保留、contentHash no-op、source 隔离）
 *
 * [踩坑索引]
 *   - 新建路径冲突两级预检：existingPaths（前 100 篇）快速拦截 + listDocs({ path }) 精确兜底；
 *     预检与 PUT 之间无锁（TOCTOU），并发覆盖属已知残余风险（后端 create-only 记入 P2 债）
 *
 * [铁律关联] #1（每次 session 必读 AGENTS.md/INDEX.md） #12（写/改文件分批、匹配现有风格）
 *
 * [详细踩坑]（暂无）
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

'use client';

import { useRef, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DocPicker, type DocPick } from '@/components/docs/doc-picker';
import { MARKDOWN_CLASSES } from '@/lib/markdown-classes';
import { confirm } from '@/lib/notify';

/**
 * DocEditor 组件 props 契约（plan §3.1 R5 定稿，逐字遵守）。
 */
export interface DocEditorProps {
  /** 编辑器模式：edit = 编辑已有文档，create = 新建文档 */
  mode: 'edit' | 'create';
  /** 所属空间 ID（create 模式路径冲突精确校验 listDocs({ path }) 用） */
  spaceId: string;
  /** 初始内容：edit 模式来自 doc-content 缓存，create 传 '' */
  initialContent: string;
  /** 初始路径：edit 模式传入锁定展示；create 不渲染锁 */
  initialPath?: string;
  /** create 模式路径冲突第一级快速预检（来自 facetDocs 全量列表，仅前 100 篇——
   *  未命中还会走 listDocs({ path }) 精确校验兜底，见 handleSave） */
  existingPaths: string[];
  /** 透传 DocPicker：当前空间绑定的看板 ID（置顶排序） */
  boardId?: string;
  /** 外部 mutation.isPending，用于禁用保存按钮防重复提交 */
  saving: boolean;
  /** 保存回调：路径 + 内容（仅传 { path, content }，后端 upsert 未传字段全部保留） */
  onSave: (input: { path: string; content: string }) => void;
  /** 取消回调：组件内完成脏状态 confirm 后再调 */
  onCancel: () => void;
}

/**
 * DocEditor — 文档编辑器组件（手写 textarea + 预览切换）。
 *
 * 结构：
 * - 工具栏：编辑/预览 tab + 插入链接按钮（预览态禁用）+ 右侧保存/取消
 * - 编辑态：原生 textarea（暗色适配、等宽字体、flex-1 撑满）
 * - 预览态：ReactMarkdown + remarkGfm + MARKDOWN_CLASSES 共享常量
 * - 新建模式：底部 path 输入框（必填、≤512、冲突预检）
 *
 * 脏状态：content !== original，取消时全局 confirm 防误丢（danger 红钮）。
 * 保存只发 { path, content }——title/summary/docType/tags/category 全部由
 * 后端 upsert 的 ?? existing 兜底保留。
 */
export function DocEditor({
  mode,
  spaceId,
  initialContent,
  initialPath,
  existingPaths,
  boardId,
  saving,
  onSave,
  onCancel,
}: DocEditorProps) {
  const t = useTranslations('docs.editor');
  const tGlobal = useTranslations();
  const [tab, setTab] = useState('edit');
  const [content, setContent] = useState(initialContent);
  /** 新建模式路径输入值 */
  const [path, setPath] = useState(initialPath ?? '');
  /** 路径冲突错误文案（新建模式客户端预检，null = 无冲突） */
  const [pathError, setPathError] = useState<string | null>(null);
  /** 精确路径校验请求进行中（保存按钮联动禁用，防校验期间重复提交） */
  const [checkingPath, setCheckingPath] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** 原始内容（进入编辑态快照，脏状态判断基准） */
  const originalContentRef = useRef(initialContent);

  /** 是否脏（内容与进入时不同） */
  const dirty = content !== originalContentRef.current;

  /**
   * 尝试退出编辑器（R1 统一脏状态守卫）：
   * 取消按钮/切文档/返回列表/搜索跳转——所有退出路径都走此函数。
   * 脏状态时弹全局 confirm（danger 红钮：放弃编辑不可逆），确认才放行。
   */
  const tryExit = useCallback(async () => {
    if (dirty) {
      const ok = await confirm({
        title: t('discardTitle'),
        description: t('discardConfirm'),
        confirmText: tGlobal('common.confirm'),
        cancelText: tGlobal('common.cancel'),
        confirmVariant: 'danger',
      });
      if (!ok) return;
    }
    onCancel();
  }, [dirty, onCancel, t, tGlobal]);

  /**
   * 提交保存：create 模式先预检 path 冲突，通过后调用 onSave。
   * 两级预检：① existingPaths 本地快速拦截（前 100 篇，不发请求）；
   * ② listDocs({ path }) 精确校验兜底——existingPaths 来自 pageSize=100 的
   * facetDocs 列表，>100 篇空间本地不全，精确匹配命中即阻止（防静默覆盖已有文档）。
   * 冲突时设置 pathError 阻止提交。
   *
   * 残余风险（TOCTOU）：预检与 PUT upsert 之间无锁，并发下仍可能覆盖——
   * 前端仅作缓解；后端 upsert 支持 create-only 模式（409 on existing path）已记入 P2 债。
   */
  const handleSave = useCallback(async () => {
    if (mode === 'create') {
      // 客户端路径冲突预检（plan §2 第 5 条：upsert 对已存在 path 是静默覆盖更新）
      const normalized = path.trim();
      if (!normalized) {
        setPathError(t('pathPlaceholder'));
        return;
      }
      // 第一级：本地列表快速拦截（命中无需发请求）
      if (existingPaths.includes(normalized)) {
        setPathError(t('pathConflict'));
        return;
      }
      // 第二级：精确校验（契约支持 path 精确匹配），覆盖本地列表截断的盲区
      setCheckingPath(true);
      try {
        const res = await Api.docs.listDocs(spaceId, { path: normalized });
        if ((res.items?.length ?? 0) > 0) {
          setPathError(t('pathConflict'));
          return;
        }
      } catch {
        // 校验请求失败时阻塞保存并提示重试——宁可误拦，不可静默覆盖
        setPathError(t('pathCheckFailed'));
        return;
      } finally {
        setCheckingPath(false);
      }
      onSave({ path: normalized, content });
    } else {
      onSave({ path: initialPath!, content });
    }
  }, [mode, path, content, existingPaths, initialPath, spaceId, onSave, t]);

  /** 路径输入变更时清除冲突错误 */
  const handlePathChange = useCallback(
    (val: string) => {
      setPath(val);
      if (pathError) setPathError(null);
    },
    [pathError],
  );

  /**
   * 插入链接回调：在 textarea 光标处插入
   * `[title](/docs/<spaceId>?doc=<docId>)` 格式（匹配 link-health 平台规范链接正则）。
   * 插入后恢复 focus 并把光标移到插入文本之后。
   */
  const handleInsertLink = useCallback(
    (doc: DocPick) => {
      const link = `[${doc.title}](/docs/${doc.spaceId}?doc=${doc.docId})`;
      const el = textareaRef.current;
      if (!el) {
        setContent((prev) => prev + link);
        return;
      }
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const before = content.slice(0, start);
      const after = content.slice(end);
      // 防粘连：插入点后的内容非空且不以换行开头时补换行——否则链接与同行文本/标题
      // 粘在一起（如 `[x](url)# 标题`），markdown 解析不出 heading，title 派生被破坏
      const glue = after && !after.startsWith('\n') ? '\n' : '';
      const newContent = before + link + glue + after;
      setContent(newContent);
      // 恢复 focus 并移动光标到插入文本之后
      requestAnimationFrame(() => {
        el.focus();
        const cursorPos = start + link.length + glue.length;
        el.setSelectionRange(cursorPos, cursorPos);
      });
    },
    [content],
  );

  // ── Enter 提交（仅路径输入框，防 textarea 误触） ──
  const handlePathKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') void handleSave();
    },
    [handleSave],
  );

  return (
    <div className="flex h-full flex-col gap-2">
      {/* 工具栏：tabs 切换 + 插入链接 + 保存/取消 */}
      <div className="flex shrink-0 items-center gap-2">
        <Tabs value={tab} onValueChange={setTab} className="w-auto">
          <TabsList>
            <TabsTrigger value="edit">{t('editTab')}</TabsTrigger>
            <TabsTrigger value="preview">{t('preview')}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex-1" />

        {/* 插入链接：预览 tab 禁用（R6），点击自动切回编辑 tab */}
        <DocPicker
          boardId={boardId}
          onSelect={handleInsertLink}
          disabled={tab === 'preview'}
          label={t('insertLink')}
          buttonClassName="h-8 text-xs"
        />

        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => void tryExit()}
          disabled={saving}
        >
          {t('cancel')}
        </Button>
        <Button
          size="sm"
          className="h-8 text-xs"
          onClick={() => void handleSave()}
          disabled={saving || checkingPath}
          isLoading={saving || checkingPath}
        >
          {t('save')}
        </Button>
      </div>

      {/* 编辑/预览主体 */}
      <div className="flex flex-1 min-h-0 flex-col gap-2">
        {tab === 'edit' ? (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('contentPlaceholder')}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/70"
          />
        ) : (
          <div
            className={`flex-1 overflow-y-auto rounded-md border border-border/40 px-3 py-2 text-sm ${MARKDOWN_CLASSES}`}
          >
            {content.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            ) : (
              <p className="text-muted-foreground">{t('contentPlaceholder')}</p>
            )}
          </div>
        )}

        {/* 新建模式：路径输入 + hint */}
        {mode === 'create' && (
          <div className="shrink-0 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('path')}</label>
              <span className="text-[11px] text-muted-foreground/60">{t('pathHint')}</span>
            </div>
            <input
              value={path}
              onChange={(e) => handlePathChange(e.target.value.slice(0, 512))}
              onKeyDown={handlePathKeyDown}
              placeholder={t('pathPlaceholder')}
              maxLength={512}
              className={`flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/70 ${pathError ? 'border-red-500' : 'border-input'}`}
            />
            {pathError && <p className="text-xs text-red-500">{pathError}</p>}
          </div>
        )}

        {/* 标题自动派生 hint（仅非 git:* 文档时提示） */}
        <p className="shrink-0 text-[11px] text-muted-foreground/60">{t('titleAutoHint')}</p>
      </div>
    </div>
  );
}
