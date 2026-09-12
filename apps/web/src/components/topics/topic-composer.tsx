'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（话题详情页——TopicComposer 圆桌 @ 补全）
 *   - 补充: docs/roundtable-design.md §6（mention 唤醒） + §12 r11（纯文本打字辅助）
 *   - 附件: docs/api-definition.md §Attachments（上传绑定 topicId；chip 移除 = DELETE + 链接剥离）
 *
 * [踩坑索引] ①(玻璃壳糊掉 backdrop 文字) ②(附件 chips 不得进玻璃壳容器)
 *
 * [铁律关联] #7(退化态零差异) #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   ① 玻璃壳位置（2026-08-08 主 Agent 终审实测抓出）：mention 态下可见文字由
 *      backdrop 层渲染（textarea text-transparent）——若 `.glass` 留在 textarea 上，
 *      其 backdrop-filter: blur(16px) + hsl(card/0.6) 半透底会把【身后】的 backdrop
 *      文字糊到不可读。玻璃壳（含 border/focus 环）必须上移到容器 div：backdrop-filter
 *      只模糊容器背后的页面，容器内部的 backdrop 文字与 caret 保持清晰。
 *   ② 附件 chips 布局（2026-09-09 附件 P0）：chips 列表必须渲染在玻璃壳容器之外
 *     （容器上方独立行）——mention 态 backdrop 是 absolute inset-0 覆盖容器，
 *     chips 若在容器内会破坏 backdrop 与 textarea 的同像素对齐（① 同源约束）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Paperclip, Send, X } from 'lucide-react';
import { ErrorCode } from '@agent-chamber/shared';
import { Button } from '@/components/ui/button';
import { confirm, toast } from '@/lib/notify';
import {
  Api,
  ATTACHMENT_ALLOWED_TYPES,
  ATTACHMENT_MAX_BYTES,
  escapeAttachmentAlt,
} from '@/lib/api';
import {
  detectMentionQuery,
  filterMentionTargets,
  buildHighlightSegments,
  hasAllMention,
} from './mention-utils';

/** textarea 自动增高上限（px；对齐原 page 输入框 max-h-32） */
const MAX_HEIGHT_PX = 128;

/** 广播令牌候选（置顶；协议符号不翻译，见 roundtable-design §6/@all） */
const ALL_CANDIDATE = '@all';

export interface TopicComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** 发送回调：携带当前已上传附件 id 列表（≤9；上传中会阻塞发送，见 handleSend 守卫） */
  onSend: (attachmentIds: string[]) => void;
  /** 附件绑定 topic id（上传必传，plan §0.3 恰好一值） */
  topicId: string;
  /** textarea 禁用（发送中） */
  disabled?: boolean;
  /** 发送按钮 loading */
  isSending?: boolean;
  placeholder?: string;
  /**
   * 座位 label 候选（圆桌 topic active 座位）。
   * null/undefined = 普通 topic 退化态：不渲染 backdrop 高亮、不弹补全框，
   * 输入行为/样式与现状 textarea 逐字节一致。
   */
  mentionTargets?: string[] | null;
}

/**
 * 附件上传 chip（上传中/已上传；localKey 为本地临时标识，上传成功回填 id）。
 * markdownLink = 插入 textarea 的 `![alt](contentUrl)` 链接——移除 chip 时按此
 * 精确剥离，防止「已删附件仍被引用」的死链消息（plan §5.3）。
 */
interface UploadChip {
  /** 本地临时 key（chip 列表 key + 取消标记） */
  localKey: string;
  /** 附件 id（上传成功后回填；上传中为 null） */
  id: string | null;
  /** 原始文件名（chip 展示） */
  name: string;
  /** 上传中 */
  uploading: boolean;
  /** 插入 textarea 的 markdown 链接（移除 chip 时按此剥离） */
  markdownLink?: string;
}

/**
 * 话题详情页输入框（从 page.tsx 抽出，M2 web 批次）：
 * - 圆桌（mentionTargets 传入）启用 @ 补全 + backdrop 高亮：玻璃壳在容器 div
 *   （backdrop-filter 不糊内部高亮层，踩坑①），textarea bg-transparent + 文字透明
 *   （text-transparent + caret-foreground），同像素 backdrop 渲染
 *   buildHighlightSegments 分段，命中段高亮——QQ 式纯视觉效果
 * - 补全框：@all 置顶 + 座位候选大小写不敏感前缀过滤；↑↓ 循环导航、
 *   Enter/Tab 选中（补全框开时 Enter 禁止发送）、Esc 关闭、点击选中
 * - 选中插入纯文本 `@label `（含尾部空格），落库/路由仍走后端文本解析，
 *   不引入任何结构化 mention 数据（roundtable-design §12 r11）
 * - @all 闸门（M3 阶段 3，r13）：发送路径命中可路由 @all（mention-utils
 *   hasAllMention 镜像口径）且本桌有 active 座位 → 全局 confirm 确认
 *   （lib/notify，替换 window.confirm 批次；异步弹窗带发送守卫防连点），
 *   取消不发送；普通 topic 零感知
 * - 协议不变：Enter 发送 / Shift+Enter 换行（原 page handleKeyDown 语义平移）
 */
export function TopicComposer({
  value,
  onChange,
  onSend,
  topicId,
  disabled,
  isSending,
  placeholder,
  mentionTargets,
}: TopicComposerProps) {
  const t = useTranslations('topics');
  const tGlobal = useTranslations();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // @all 确认弹窗打开期间置 true（发送守卫：异步 confirm 无原生同步阻塞，
  // 必须显式防连点——否则连点两次排队两个确认框，确认两次 = 重复发消息）
  const confirmPendingRef = useRef(false);
  // 在途上传取消标记（上传中移除 chip / 发送后 value 清空时登记；成功回调据此
  // 短路不插入链接——附件成为孤儿，plan §1 孤儿语义：计入配额、P0 仅 API 可删）
  const cancelledUploadsRef = useRef<Set<string>>(new Set());
  // 附件 chips（上传中/已上传；发送成功后随 value 清空重置）
  const [chips, setChips] = useState<UploadChip[]>([]);
  // caret 用 state（受控组件无原生事件流）；方向键/点击移动 caret 经 onSelect 同步
  const [caretPos, setCaretPos] = useState(value.length);
  // 当前高亮候选下标（↑↓ 循环导航）
  const [activeIndex, setActiveIndex] = useState(0);
  // Esc 显式关闭标记：picker 开合由「query 存在 && 未 dismiss」推导，失配自动关
  const [mentionDismissed, setMentionDismissed] = useState(false);

  const mentionEnabled = mentionTargets !== null && mentionTargets !== undefined;

  // 最新 value 快照（异步上传成功回调插入链接时用——闭包 value 会过期）
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // 发送成功后 value 清空 → 重置附件 chips（附件已随消息发送，不删除）；
  // 在途上传登记取消（成功回调不再插入链接，附件成为孤儿——plan §1 语义）
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (prevValueRef.current && !value) {
      for (const c of chips) {
        if (c.uploading) cancelledUploadsRef.current.add(c.localKey);
      }
      setChips([]);
    }
    prevValueRef.current = value;
  }, [value, chips]);

  // 自动增高（原 page adjustTextareaHeight 平移；scrollHeight 实测，上限 128px）
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, []);

  // 发送成功后 value 清空 → 重置高度（对齐原 page onSuccess 的显式重置）
  useEffect(() => {
    if (!value) {
      const el = textareaRef.current;
      if (el) el.style.height = 'auto';
    }
  }, [value]);

  // 渲染期推导 @ 查询（caret 脱离 token / query 失配自动关闭）
  const mentionQuery = useMemo(
    () => (mentionEnabled ? detectMentionQuery(value, caretPos) : null),
    [mentionEnabled, value, caretPos],
  );
  const pickerOpen = mentionQuery !== null && !mentionDismissed;

  // backdrop 高亮分段（仅 mention 启用时计算；退化态零开销）
  const segments = useMemo(
    () => (mentionEnabled ? buildHighlightSegments(value, mentionTargets ?? []) : []),
    [mentionEnabled, mentionTargets, value],
  );

  // 候选 = @all 置顶 + 前缀过滤后的座位（统一带 @ 前缀的令牌串，选中直接拼尾部空格插入）
  const filtered = useMemo(
    () => (mentionQuery ? filterMentionTargets(mentionQuery.query, mentionTargets ?? []) : []),
    [mentionQuery, mentionTargets],
  );
  const candidates = useMemo(
    () => (mentionQuery ? [ALL_CANDIDATE, ...filtered.map((l) => `@${l}`)] : []),
    [mentionQuery, filtered],
  );

  // query/候选变化时重置默认选中：query 为空（刚输入 @）默认 @all，
  // query 非空默认第一个匹配座位（Enter 直选最符合直觉）
  useEffect(() => {
    setActiveIndex(
      mentionQuery && mentionQuery.query === '' && filtered.length > 0
        ? 0
        : filtered.length > 0
          ? 1
          : 0,
    );
  }, [mentionQuery, filtered.length]);

  /**
   * @all 闸门发送拦截（M3 阶段 3，r13）：消息文本命中可路由的 @all（mention-utils
   * hasAllMention——后端 mention.ts 口径的视觉镜像，禁止自写正则）且本桌有 active
   * 座位时，先弹确认框（「将唤醒全部 N 个座位，确认发送？」，N = 当前 active 座位
   * 数）——取消不发送。普通 topic（mentionEnabled=false）/ 无 @all / 零座位
   * （N=0 无可唤醒，无确认必要）零感知直发。
   *
   * 发送守卫（plan 并发约定 ⑨）：window.confirm 同步阻塞天然防连点，异步 confirm
   * 必须显式防——confirmPendingRef 在弹窗打开期间忽略重复触发，否则连点两次
   * 排队两个确认框，确认两次 = 重复发消息（@all 发送非幂等）。
   */
  const handleSend = useCallback(async () => {
    if (!value.trim()) return;
    // 上传中阻塞发送：图片链接尚未插入 content，此刻发送会丢图（附件成孤儿）
    if (chips.some((c) => c.uploading)) return;
    const seatCount = mentionEnabled ? (mentionTargets?.length ?? 0) : 0;
    if (seatCount > 0 && hasAllMention(value)) {
      if (confirmPendingRef.current) return;
      confirmPendingRef.current = true;
      try {
        const ok = await confirm({
          title: t('message.allWakeTitle'),
          description: t('message.allWakeConfirm', { count: seatCount }),
          confirmText: tGlobal('common.confirm'),
          cancelText: tGlobal('common.cancel'),
        });
        if (!ok) return;
      } finally {
        confirmPendingRef.current = false;
      }
    }
    // 收集已上传附件 id（上传中已被上方守卫拦截，此处全为已上传）
    onSend(chips.filter((c) => c.id).map((c) => c.id as string));
  }, [value, chips, mentionEnabled, mentionTargets, onSend, t, tGlobal]);

  /** 选中候选：把 [@, caret) 替换为 `@label `，caret 移到空格后，关闭补全框 */
  const applyCandidate = (candidate: string) => {
    const q = mentionQuery;
    if (!q) return;
    const insertion = `${candidate} `;
    onChange(value.slice(0, q.start) + insertion + value.slice(caretPos));
    const newCaret = q.start + insertion.length;
    setCaretPos(newCaret);
    setMentionDismissed(false);
    // 受控组件在 onChange 后浏览器 caret 会漂移，rAF 后恢复焦点与位置
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(newCaret, newCaret);
      }
    });
    requestAnimationFrame(adjustTextareaHeight);
  };

  /**
   * 光标处插入文本（applyCandidate 范式，plan §5.3）：读 textarea 实时
   * selectionStart/End（异步上传回调时闭包 value/caretPos 已过期，必须走
   * valueRef + 实时 DOM 选区），插入后补防粘连换行并恢复焦点与光标。
   */
  const insertAtCursor = (text: string) => {
    const el = textareaRef.current;
    const current = valueRef.current;
    if (!el) {
      onChange(current + text);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = current.slice(0, start);
    const after = current.slice(end);
    // 防粘连：插入点后的内容非空且不以换行开头时补换行（同 doc-editor handleInsertLink）
    const glue = after && !after.startsWith('\n') ? '\n' : '';
    const newValue = before + text + glue + after;
    onChange(newValue);
    const newCaret = start + text.length + glue.length;
    setCaretPos(newCaret);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
    });
    requestAnimationFrame(adjustTextareaHeight);
  };

  /**
   * 上传单个图片文件（paperclip 选择 / onPaste 共用）：
   * 前端拦截（类型/大小，与后端校验对齐，提前失败省一次请求）→ 建 chip →
   * Api.attachments.upload（绑定 topicId）→ 成功插 `![alt](contentUrl)` 到光标
   * （alt 转义 `[ ] ( )`，plan §3.6）→ chip 回填 id；失败 toast + 移除 chip。
   */
  const uploadFile = async (file: File) => {
    if (!ATTACHMENT_ALLOWED_TYPES.includes(file.type)) {
      toast.error({ title: tGlobal('attachments.typeNotAllowed') });
      return;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      toast.error({ title: tGlobal('attachments.tooLarge') });
      return;
    }
    const localKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setChips((prev) => [...prev, { localKey, id: null, name: file.name, uploading: true }]);
    try {
      const res = await Api.attachments.upload(file, { topicId });
      if (cancelledUploadsRef.current.has(localKey)) {
        // 上传中已移除/已随发送清空：不插入链接（附件成为孤儿，plan §1 语义）
        cancelledUploadsRef.current.delete(localKey);
        return;
      }
      const markdownLink = `![${escapeAttachmentAlt(res.originalName)}](${res.contentUrl})`;
      insertAtCursor(markdownLink);
      setChips((prev) =>
        prev.map((c) =>
          c.localKey === localKey ? { ...c, id: res.id, uploading: false, markdownLink } : c,
        ),
      );
    } catch (err) {
      setChips((prev) => prev.filter((c) => c.localKey !== localKey));
      // 配额超限（12003）单独文案；其余统一上传失败
      const code = (err as { code?: number }).code;
      toast.error({
        title:
          code === ErrorCode.ATTACHMENT_QUOTA_EXCEEDED
            ? tGlobal('attachments.quotaExceeded')
            : tGlobal('attachments.uploadFailed'),
      });
    }
  };

  /** paperclip 文件选择（accept 已限图片白名单；清空 value 允许重复选同一文件） */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const f of files) void uploadFile(f);
  };

  /**
   * textarea 粘贴（全仓首例，plan §5.3）：clipboardData.files 命中图片白名单 →
   * 拦截默认粘贴（防文件路径文本）→ 走上传；非图片粘贴保持默认行为（文本）。
   */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    const imageFiles = files.filter((f) => ATTACHMENT_ALLOWED_TYPES.includes(f.type));
    if (imageFiles.length === 0) return;
    e.preventDefault();
    for (const f of imageFiles) void uploadFile(f);
  };

  /**
   * 移除 chip：
   * - 上传中：登记取消（成功回调不再插入链接），附件成为孤儿（plan §1）
   * - 已上传：确认后调 Api.attachments.remove + 同步从 textarea 剥离对应
   *   markdown 链接（先剥离后删除——本地剥离可靠，防「已删附件仍被引用」死链；
   *   删除失败仅提示，链接已剥离消息安全，残留附件为孤儿）
   */
  const removeChip = async (localKey: string) => {
    const chip = chips.find((c) => c.localKey === localKey);
    if (!chip) return;
    if (chip.uploading) {
      cancelledUploadsRef.current.add(localKey);
      setChips((prev) => prev.filter((c) => c.localKey !== localKey));
      return;
    }
    const ok = await confirm({
      title: tGlobal('attachments.removeChip'),
      description: tGlobal('attachments.confirmRemove'),
      confirmText: tGlobal('common.confirm'),
      cancelText: tGlobal('common.cancel'),
    });
    if (!ok) return;
    if (chip.markdownLink) {
      onChange(value.replace(chip.markdownLink, ''));
    }
    setChips((prev) => prev.filter((c) => c.localKey !== localKey));
    if (chip.id) {
      try {
        await Api.attachments.remove(chip.id);
      } catch {
        toast.warning({ title: tGlobal('attachments.removeFailed') });
      }
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCaretPos(e.target.selectionStart);
    setMentionDismissed(false); // 继续输入 = 重新进入查询态（Esc 关闭不持久）
    onChange(e.target.value);
    requestAnimationFrame(adjustTextareaHeight);
  };

  // textarea 内部滚动时 backdrop 同步 scrollTop（两者同像素布局）
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 补全框开时键盘优先级：↑↓ 导航、Enter/Tab 选中、Esc 关闭——
    // 此时 Enter 禁止触发发送（preventDefault 拦截）
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (candidates.length > 0) applyCandidate(candidates[activeIndex]);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (candidates.length > 0) applyCandidate(candidates[activeIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }
    // 协议不变：Enter 发送、Shift+Enter 换行（原 page handleKeyDown）；
    // 发送统一走 handleSend（@all 确认闸，M3 阶段 3）
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="mt-2 md:mt-4">
      {/* 附件 chips（上传中/已上传，可移除）：独立于玻璃壳容器——mention 态 backdrop
          是 absolute inset-0 覆盖容器，chips 若在容器内会破坏 backdrop 与 textarea
          的同像素对齐（AGENT-HOOK 踩坑① 约束，勿破坏 backdrop 布局） */}
      {chips.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip.localKey}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-xs"
            >
              {chip.uploading ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <span className="h-3 w-3 shrink-0 rounded-sm bg-primary/30" aria-hidden />
              )}
              <span className="max-w-[180px] truncate" title={chip.name}>
                {chip.name}
              </span>
              <button
                type="button"
                onClick={() => void removeChip(chip.localKey)}
                aria-label={tGlobal('attachments.removeChip')}
                title={tGlobal('attachments.removeChip')}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border/60 pt-2 md:pt-4">
        {/* paperclip：触发隐藏 file input（accept 限图片白名单）；上传中不禁用——
            可继续选图排队上传（发送按钮在上传中禁用，见 handleSend 守卫） */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          aria-label={tGlobal('attachments.upload')}
          title={tGlobal('attachments.upload')}
          className="shrink-0"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
        <div
          className={
            mentionEnabled
              ? // mention 态：玻璃壳上移到容器（backdrop-filter 只糊容器背后的页面，
                //   不糊容器内部的高亮 backdrop 与 caret——见本文件 AGENT-HOOK 踩坑 ①）
                'glass relative flex-1 min-w-0 rounded-md focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/70'
              : 'relative flex-1 min-w-0'
          }
        >
          {/* backdrop：与 textarea 同像素布局的高亮层（仅 mention 启用）；aria-hidden 纯视觉 */}
          {mentionEnabled && (
            <div
              ref={backdropRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-md px-3 py-2 text-sm"
            >
              {segments.map((seg, i) =>
                seg.highlight ? (
                  <mark key={i} className="rounded-sm bg-primary/15 font-medium text-primary">
                    {seg.text}
                  </mark>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            placeholder={placeholder}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={handleScroll}
            onSelect={(e) => setCaretPos(e.currentTarget.selectionStart)}
            disabled={disabled}
            rows={1}
            className={
              mentionEnabled
                ? // mention 态：文字透明由 backdrop 呈现（caret 保持可见）；bg-transparent
                  // 无自身玻璃/边框（壳在容器上），否则半透底+blur 会把 backdrop 文字糊掉
                  'w-full min-h-[36px] max-h-32 overflow-y-auto resize-none rounded-md bg-transparent px-3 py-2 text-sm text-transparent caret-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50'
                : // 退化态：原 page textarea 类逐字节（玻璃壳在自身、focus 环在自身）
                  'glass w-full min-h-[36px] max-h-32 overflow-y-auto resize-none rounded-md px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-50'
            }
          />
          {/* 补全框：玻璃拟态对齐现有 UI 词表（glass + shadow-lg）；absolute bottom-full 上浮 */}
          {pickerOpen && (
            <div className="glass absolute bottom-full left-0 z-50 mb-1 max-h-56 w-64 overflow-y-auto rounded-md py-1 shadow-lg">
              {candidates.map((c, i) => {
                const isAll = c === ALL_CANDIDATE;
                return (
                  <button
                    key={c}
                    type="button"
                    // mousedown 先于 blur 触发：preventDefault 保住 textarea 焦点与 caret
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyCandidate(c);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors ${
                      i === activeIndex
                        ? 'bg-primary/15 text-primary'
                        : 'text-foreground hover:bg-muted/60'
                    }`}
                  >
                    <span className="font-medium">{c}</span>
                    {isAll && (
                      <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                        {t('message.mentionAllDesc')}
                      </span>
                    )}
                  </button>
                );
              })}
              {/* 无匹配座位空态（不可选，仅提示）——@all 恒在，故 filtered 为空时显示 */}
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t('message.mentionNoMatch')}
                </div>
              )}
            </div>
          )}
        </div>
        <Button
          onClick={handleSend}
          isLoading={isSending}
          disabled={!value.trim() || chips.some((c) => c.uploading)}
          aria-label={t('message.send')}
          className="shrink-0"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
