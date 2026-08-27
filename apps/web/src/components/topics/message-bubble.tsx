'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/ui-design-system.md §6.1（消息内 Markdown 渲染层级 + 长消息折叠模式）
 *   - 补充: docs/frontend-architecture.md §3.2.3（话题详情页消息流）
 *   - 圆桌: docs/roundtable-design.md §6/§7（座位 badge 展示语义 / 过程折叠视图）
 *
 * [踩坑索引]
 *   - thinking 折叠不能用 CollapsibleMarkdown 的实测高度阈值模式：其折叠判定是
 *     挂载时按 scrollHeight > 88px 一次性判定，展开态会立刻被同一阈值再次截断——
 *     thinking 需要「无条件默认折叠 + 展开后完整可见」，故独立条件渲染（本组件内
 *     useState），不往 CollapsibleMarkdown 里加 force 参数（保持其 8 条测试契约不动）
 *   - seatLabel 是展示层语义不是权限边界（roundtable-design §7）：badge 纯展示，
 *     删除/编辑等操作判定仍走 senderId/senderType
 *   - 圆桌座位消息 senderName 是 runner 对应 agent 名，多个座位同 actor 时靠
 *     seatLabel badge 区分（roundtable-design §6 身份条）——badge 文案就是 label
 *     本身，不翻译（座位名是标识符不是 UI 文案）
 *   - senderType='system' 的消息（哨兵 actor 公告）整体走独立渲染分支：居中公告条
 *     （灰小字/轻边框/无发送者名与附件），不进入气泡分支——系统公告不是「名为 System
 *     的 Agent 在发言」（M3 验收 P2 bug 修复）；正文默认 truncate 单行，仅内容真溢出
 *     时显示 chevron 折叠控件（scrollWidth > clientWidth 检测，M3 验收第二批升级）。
 *     折叠相关 hook 必须在早返回之前声明（早返回在所有 hook 之后的铁律）
 *
 * [铁律关联] #7（视觉样式先看 ui-design-system） #11（注释强制）
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  AlertCircle,
  FileText,
  Brain,
  Lightbulb,
  Vote,
  CheckSquare,
  Copy,
  Trash2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { Message } from '@/types';
import { formatRelativeTime } from '@/lib/utils';
import { MARKDOWN_CHAT_CLASSES } from '@/lib/markdown-classes';
import { CollapsibleMarkdown } from '@/components/topics/collapsible-markdown';
import { Badge } from '@/components/ui/badge';
import { confirm } from '@/lib/notify';

/**
 * 消息气泡：8 种消息类型配色体系（docs/ui-design-system.md §6）+ 圆桌扩展。
 *
 * 圆桌三件套（docs/roundtable-design.md §6/§7，M2 阶段 6）：
 * 1. seatLabel badge：消息头 senderName 旁渲染圆桌座位标签（仅 backend 透传
 *    metadata.seatLabel 单键时出现），subtle variant 中性低调不抢正文；
 * 2. thinking 过程折叠：type='thinking' 无条件默认折叠为「过程记录」摘要行，
 *    点击展开完整 markdown（独立条件渲染，理由见文件头踩坑索引）；
 * 3. 其余消息走 CollapsibleMarkdown 实测高度阈值折叠（v1.43.1 长消息折叠，不回归）。
 */
export function MessageBubble({
  msg,
  currentUserId,
  onDelete,
  isDeleting,
  copiedId,
  onCopy,
  copiedContentId,
  onCopyContent,
}: {
  msg: Message;
  currentUserId?: string;
  onDelete?: (messageId: string) => void;
  isDeleting?: boolean;
  copiedId?: string | null;
  onCopy?: (messageId: string) => void;
  copiedContentId?: string | null;
  onCopyContent?: (messageId: string, content: string) => void;
}) {
  const t = useTranslations('topics');
  // 删除确认弹窗打开期间置 true（双击防护：异步 confirm 无原生同步阻塞，
  // 不防则连点排队两个确认框——确认两次 = 重复删除消息）
  const deleteConfirmPendingRef = useRef(false);
  // 8 种消息类型配色体系（docs/ui-design-system.md §6）：
  // status_update 青 / system 红 / artifact 紫 / thinking 灰+呼吸微光 /
  // proposal 绿 / vote 琥珀 / task 靛——全部暗色适配（半透明底 + 亮阶文字）。
  // strong 字段 = markdown 强调同族提亮（2026-08-02 用户拍板）：彩色气泡内
  // **强调** 取同一色相的 100 亮阶（emerald-100 等），不借中性白——纯白不属
  // 任何色相家族，叠加彩色正文会触发同时对比残影（红旁白泛青绿等）；
  // thinking 灰泡是无彩色，不设 strong，沿用默认档近白（黑白同族提亮）。
  const typeConfig: Record<
    string,
    {
      icon: React.ReactNode;
      labelKey: string;
      bg: string;
      text: string;
      border: string;
      /** markdown strong 同族提亮覆盖（&& 提权）；缺省 = 共享默认档近白 */
      strong?: string;
    }
  > = {
    status_update: {
      icon: <Activity className="h-3 w-3" />,
      labelKey: 'topics.messageType.status_update',
      bg: 'bg-primary/10',
      text: 'text-primary',
      border: 'border-primary/25',
      strong: '[&&_strong]:text-cyan-100',
    },
    system: {
      icon: <AlertCircle className="h-3 w-3" />,
      labelKey: 'topics.messageType.system',
      bg: 'bg-destructive/15',
      text: 'text-red-300',
      border: 'border-destructive/25',
      strong: '[&&_strong]:text-red-100',
      // 注：senderType='system' 的公告已提前走居中公告条分支（下方早返回），
      // 本条目服务的是「type='system' 但发送者非 system」的消息（SendMessageDto
      // 允许任意发送者带 type=system）——保留非死代码
    },
    artifact: {
      icon: <FileText className="h-3 w-3" />,
      labelKey: 'topics.messageType.artifact',
      bg: 'bg-violet-glow/15',
      text: 'text-violet-300',
      border: 'border-violet-glow/25',
      strong: '[&&_strong]:text-violet-100',
    },
    thinking: {
      icon: <Brain className="h-3 w-3" />,
      labelKey: 'topics.messageType.thinking',
      bg: 'bg-muted/50',
      text: 'text-muted-foreground',
      border: 'border-border/60',
    },
    proposal: {
      icon: <Lightbulb className="h-3 w-3" />,
      labelKey: 'topics.messageType.proposal',
      bg: 'bg-emerald-500/15',
      text: 'text-emerald-300',
      border: 'border-emerald-500/25',
      strong: '[&&_strong]:text-emerald-100',
    },
    vote: {
      icon: <Vote className="h-3 w-3" />,
      labelKey: 'topics.messageType.vote',
      bg: 'bg-amber-500/15',
      text: 'text-amber-300',
      border: 'border-amber-500/25',
      strong: '[&&_strong]:text-amber-100',
    },
    task: {
      icon: <CheckSquare className="h-3 w-3" />,
      labelKey: 'topics.messageType.task',
      bg: 'bg-indigo-500/15',
      text: 'text-indigo-300',
      border: 'border-indigo-500/25',
      strong: '[&&_strong]:text-indigo-100',
    },
  };

  /** thinking 过程记录展开态（默认折叠；组件内状态，不持久化） */
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  const tGlobal = useTranslations();

  // ── 系统公告条折叠态（M3 验收第二批）──
  // 所有 hook 必须位于下方早返回之前（文件头注释铁律：早返回在所有 hook 之后）。
  const systemContentRef = useRef<HTMLDivElement | null>(null);
  const [systemExpanded, setSystemExpanded] = useState(false);
  const [systemOverflow, setSystemOverflow] = useState(false);
  useEffect(() => {
    // 溢出检测：scrollWidth > clientWidth = 单行截断确实发生 → 才显示折叠控件。
    // jsdom 无布局恒 0（测试用 Object.defineProperty mock）；非 system 消息无元素直接返回。
    const el = systemContentRef.current;
    if (!el) return;
    const check = () => setSystemOverflow(el.scrollWidth > el.clientWidth);
    check();
    // 聊天气列宽度随侧边栏折叠变化（不触发 window resize）——ResizeObserver 兜底；
    // 缺失环境（老浏览器/jsdom）回退 window resize
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(check);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // 系统公告（senderType='system'，哨兵 actor）：居中公告条——整行居中、轻边框
  // （border-border/60 与文件内既有半透边框同族，无 backdrop-blur）、灰色小字，
  // 不显示 senderName/座位 badge/主脑 badge/复制 id 等气泡附件。
  // 折叠：正文默认 truncate 单行；仅内容真溢出（scrollWidth > clientWidth）时在
  // 末尾显示 chevron——点击展开完整正文，再点收起（aria-expanded 双态）。
  // 早返回：所有 hook 均在其上，无 hook 顺序问题。
  if (msg.senderType === 'system') {
    return (
      <div className="flex w-full flex-col items-center gap-0.5 py-1">
        <div className="flex max-w-[80%] items-center gap-1 rounded-md border border-border/60 px-3 py-1.5 md:max-w-[60%]">
          <div
            ref={systemContentRef}
            data-testid="system-announcement-content"
            className={`min-w-0 flex-1 text-xs text-muted-foreground opacity-70 ${
              systemExpanded ? 'whitespace-pre-wrap break-words' : 'truncate'
            } ${MARKDOWN_CHAT_CLASSES}`}
          >
            {/* p 是真正持有文本的块元素：折叠态把 truncate 落在 p 上才出省略号
                （wrapper 的 truncate 对块级 p 只裁剪不出省略号）；展开态 p 恢复换行 */}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => (
                  <p className={systemExpanded ? 'whitespace-pre-wrap break-words' : 'truncate'}>
                    {children}
                  </p>
                ),
              }}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
          {systemOverflow && (
            <button
              type="button"
              data-testid="system-announcement-toggle"
              onClick={() => setSystemExpanded((prev) => !prev)}
              aria-expanded={systemExpanded}
              aria-label={systemExpanded ? t('message.collapse') : t('message.expand')}
              className="shrink-0 text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
            >
              {systemExpanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground opacity-50">
          {formatRelativeTime(msg.createdAt)}
        </span>
      </div>
    );
  }

  const cfg = msg.type ? typeConfig[msg.type] : null;
  const isUser = msg.senderType === 'human';

  // 气泡底（滚动区重复元素，红线：禁 backdrop-blur，一律半透实色底/工具类）
  let bubbleClass: string;
  if (cfg) {
    bubbleClass = `${cfg.bg} ${cfg.text} border ${cfg.border}`;
  } else if (isUser) {
    // 人类消息靠右：主光色青→紫渐变底 + 微光（克制的点缀发光）
    bubbleClass =
      'bg-gradient-to-br from-primary/25 via-primary/15 to-violet-glow/15 text-foreground border border-primary/30 shadow-glow-sm';
  } else {
    // Agent chat：半透实色玻璃平替（无 blur）
    bubbleClass = 'glass-flat';
  }

  return (
    <div className={`max-w-[82%] md:max-w-[70%] rounded-lg px-3 py-2 md:px-4 ${bubbleClass}`}>
      <div className="flex items-center gap-1.5 md:gap-2 mb-1 flex-wrap">
        {cfg && (
          // thinking 类型附呼吸微光（animate-breathing 仅 opacity+transform，符合动效红线）
          <span
            className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-background/60 ${msg.type === 'thinking' ? 'animate-breathing' : ''}`}
          >
            {cfg.icon}
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {tGlobal(cfg.labelKey as any)}
          </span>
        )}
        {/* 已删除降级（统一批 B）：senderName 灰化 + title 提示——不加常驻 badge
            （高密度消息流防噪音，R16 钉死） */}
        <span
          className={`text-xs font-medium truncate max-w-[120px] md:max-w-none ${
            msg.deletedAt ? 'opacity-60' : 'opacity-80'
          }`}
          title={msg.deletedAt ? t('message.deletedSenderTitle') : undefined}
        >
          {msg.senderName}
        </span>
        {/* 圆桌座位 badge：仅 backend 透传 seatLabel 时渲染；文案就是 label 本身
            （座位名是标识符不翻译，roundtable-design §6/§7）；展示语义，非权限边界 */}
        {msg.seatLabel && (
          <Badge variant="subtle" className="px-1.5 py-0 text-[10px] font-medium shrink-0">
            {msg.seatLabel}
          </Badge>
        )}
        {/* 圆桌主脑标识（M3 阶段 3，r13）：仅 backend 透传 seatCoordinator=true 且
            有座位 badge 时渲染——主脑标识语义是「座位 badge 旁」（§6 主脑条，人类
            一眼区分主脑指令），无座位身份的消息不单独出现；样式与 subtle badge
            同族但琥珀强调（克制，不抢正文） */}
        {msg.seatLabel && msg.seatCoordinator && (
          <Badge
            variant="outline"
            className="shrink-0 border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] font-semibold text-amber-300"
            title={t('message.coordinatorTitle')}
          >
            {t('message.coordinatorBadge')}
          </Badge>
        )}
        <span className="text-xs opacity-60">{formatRelativeTime(msg.createdAt)}</span>
        <code
          className="text-[10px] opacity-40 font-mono cursor-pointer hover:opacity-70 transition-opacity relative"
          title={t('message.copyId')}
          onClick={(e) => {
            e.stopPropagation();
            onCopy?.(msg.id);
          }}
        >
          {msg.id}
          {copiedId === msg.id && (
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] bg-popover text-popover-foreground border border-border/60 px-1.5 py-0.5 rounded whitespace-nowrap">
              {t('message.copied')}
            </span>
          )}
        </code>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCopyContent?.(msg.id, msg.content);
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground relative"
          title={t('message.copyContent')}
        >
          <Copy className="h-3 w-3" />
          {copiedContentId === msg.id && (
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] bg-popover text-popover-foreground border border-border/60 px-1.5 py-0.5 rounded whitespace-nowrap">
              {t('message.copied')}
            </span>
          )}
        </button>
        {currentUserId &&
          msg.senderId === currentUserId &&
          msg.senderType === 'human' &&
          onDelete && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                if (deleteConfirmPendingRef.current || isDeleting) return;
                deleteConfirmPendingRef.current = true;
                try {
                  const ok = await confirm({
                    title: t('message.deleteTitle'),
                    description: t('message.deleteConfirm'),
                    confirmText: tGlobal('common.confirm'),
                    cancelText: tGlobal('common.cancel'),
                    confirmVariant: 'danger',
                  });
                  if (!ok) return;
                  onDelete(msg.id);
                } finally {
                  deleteConfirmPendingRef.current = false;
                }
              }}
              disabled={isDeleting}
              className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive/80 disabled:opacity-30"
              title={t('message.deleteTitle')}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
      </div>
      {/* Markdown 暗色适配（共享紧凑版，单一事实源 lib/markdown-classes.ts，
          设计约定见 docs/ui-design-system.md §6.1）：
          - whitespace-pre-wrap 有意保留：聊天换行语义（Enter 发送 / Shift+Enter 换行），
            段落间距由 pre-wrap 保留的换行提供，故聊天版不含 [&_p] margin（叠加会双倍空行）
          - 条件覆盖用 `&&` 双写父选择器提权——与共享类同属性冲突时，胜负由生成
            样式表规则顺序决定（与 className 书写顺序无关），&& 使特异性 2>1 确定性胜出：
            · 彩色类型气泡：strong 同族提亮（cfg.strong，emerald-100/red-100 等，
              见 typeConfig 头注释；thinking 灰泡不设，沿用默认档近白）
            · 无类型 chat（人类/Agent 普通消息）：strong 改青色——中性气泡正文已是
              foreground，共享默认档（白）无区分
            · thinking：斜体容器内 strong/em 回归正体（italic 内强调 = roman 排版约定）
            · status_update：整泡 text-primary，链接改近白 + 青下划线方可辨识
            （senderType='system' 已早返回公告条，不经过本分支）
          - 外层由 CollapsibleMarkdown 包装（components/topics/collapsible-markdown.tsx）：
            Agent 长消息默认折叠（实测高度阈值，8 种消息类型统一），详见 ui-design-system §6.1。
            thinking 例外：走下方独立「过程记录」折叠（无条件默认折叠 + 展开完整可见） */}
      {msg.type === 'thinking' ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            data-testid="thinking-toggle"
            onClick={() => setThinkingExpanded((prev) => !prev)}
            aria-expanded={thinkingExpanded}
            // 与 CollapsibleMarkdown 按钮同款克制风：text-current 继承气泡文字色
            className="inline-flex w-fit items-center gap-1 text-xs font-medium text-current opacity-70 transition-opacity hover:opacity-100"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-300 ${
                thinkingExpanded ? 'rotate-180' : ''
              }`}
            />
            {thinkingExpanded ? t('message.collapse') : t('message.thinkingSummary')}
          </button>
          {/* 展开态渲染完整 markdown（不挂 CollapsibleMarkdown——其 88px 实测阈值
              会把长过程记录再次截断，违背「展开后完整可见」语义） */}
          {thinkingExpanded && (
            <div
              data-testid="thinking-content"
              className={`text-sm whitespace-pre-wrap break-words ${MARKDOWN_CHAT_CLASSES} italic opacity-80 [&&_strong]:not-italic [&&_em]:not-italic`}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
            </div>
          )}
        </div>
      ) : (
        <CollapsibleMarkdown
          className={`text-sm whitespace-pre-wrap break-words ${MARKDOWN_CHAT_CLASSES}${
            cfg?.strong ? ` ${cfg.strong}` : ''
          }${!cfg ? ' [&&_strong]:text-primary' : ''}${
            msg.type === 'status_update'
              ? ' [&&_a]:text-foreground [&&_a]:decoration-primary [&&_a]:decoration-2'
              : ''
          }`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        </CollapsibleMarkdown>
      )}
    </div>
  );
}
