'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/ui-design-system.md §6.1（消息内 Markdown 渲染层级 + 长消息折叠模式）
 *   - 补充: docs/frontend-architecture.md §3.2.3（话题详情页消息流）
 *
 * [踩坑索引]
 *   - 折叠阈值按渲染后高度测量（useLayoutEffect + scrollHeight），不按字符数——
 *     markdown 渲染高度不可预估（代码块/表格/图片随内容与容器宽度变化）
 *   - 动效目标值必须用实测像素：max-height 从 none 到具体值无法插值（无动画），
 *     故展开态 max-height = scrollHeight 实测全高，而非 none
 *   - jsdom 下 scrollHeight 恒为 0（无真实排版），测试须在 Element.prototype 上
 *     mock getter（见同目录 collapsible-markdown.test.tsx）
 *   - 展开态 max-height 固定为实测值，窗口断点切换（md 档）改变气泡宽度后内容
 *     高度变化可能被截断——展开期间挂 window resize 重测（见 handleToggle/onResize）
 *   - 折叠判定在挂载时一次性完成；markdown 图片延迟加载导致的异步高度变化不追溯
 *     （图片未就绪时测量值偏小 → 判定不折叠，后果仅是"未默认折叠"，内容完整可见）
 *   - 折叠态渐隐用 CSS mask-image 让内容自身渐隐，不用配色遮罩——气泡底色有
 *     类型色泡/人类渐变泡等多种，任何单一渐变源色都无法全匹配；mask 与底色无关
 *   - mask 只影响渲染不影响命中区域：渐隐区下被遮住的链接仍可点中，必须叠一层
 *     透明点击层吞掉点击（点渐隐区 = 展开，而不是误点看不见的链接）
 *
 * [铁律关联] #7（视觉样式先看 ui-design-system） #11（注释强制）
 *
 * [详细踩坑]（见上方踩坑索引，2026-08-07 新建组件实录）
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';

/**
 * 折叠阈值（px）：聊天气泡正文 text-sm ≈ 20-24px/行（含行距），88px ≈ 3 行。
 * 为何按渲染后高度而非字符数：markdown 渲染高度由内容结构（代码块/表格/图片）
 * 与容器宽度共同决定，字符数与渲染高度无稳定映射；按 scrollHeight 实测判定
 * 才能对 8 种消息类型统一生效。一处可调——调大 = 更多内容默认可见。
 */
export const COLLAPSED_MAX_HEIGHT_PX = 88;

interface CollapsibleMarkdownProps {
  /** 已渲染的 markdown 内容（调用方负责 ReactMarkdown 与 markdown 样式类） */
  children: React.ReactNode;
  /** 附加到外层容器的样式类（如 MARKDOWN_CHAT_CLASSES 与气泡级条件覆盖） */
  className?: string;
}

/**
 * 长消息折叠容器：内容实测高度超过阈值时默认折叠（max-height 截断 + 内容自身
 * mask-image 渐隐 + chevron 展开/收起按钮），未超阈值原样渲染。纯前端展示效果，
 * 内容本身不做任何截断（API/MCP 侧永远全文）。折叠状态组件内 useState 且
 * 不持久化——重挂载即恢复默认折叠。展开/收起动效 = max-height 折叠高 ↔
 * 实测全高过渡（transition-[max-height] duration-300），零新依赖。
 * 视觉贴合气泡主题色的方式是「派生而非挑选」：渐隐用 mask-image（与底色无关，
 * 任意气泡色自动贴合），按钮用 currentColor 继承气泡自身文字色（opacity 70→100）。
 * 点击目标只有按钮与渐隐区（透明点击层）——不做整容器点击，保留文本选择与链接。
 */
export function CollapsibleMarkdown({ children, className }: CollapsibleMarkdownProps) {
  const t = useTranslations('topics');
  const contentRef = useRef<HTMLDivElement>(null);
  /** 是否超出折叠阈值（挂载时一次性判定） */
  const [isOverflowing, setIsOverflowing] = useState(false);
  /** 展开态（默认折叠 = false；组件内状态，不持久化） */
  const [expanded, setExpanded] = useState(false);
  /** 内容实测全高（px）：展开态 max-height 的动画目标值 */
  const [fullHeight, setFullHeight] = useState(0);

  // 挂载后、浏览器 paint 前实测内容全高并判定阈值。useLayoutEffect 同步执行，
  // setState 在同一帧内完成——用户不会看到「先全展开再折叠」的闪烁。
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setFullHeight(el.scrollHeight);
    setIsOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT_PX);
  }, []);

  // 展开态 max-height 固定为实测值；窗口断点切换（如 md 档）改变气泡宽度后
  // 内容高度随之变化，固定值可能截断内容——resize 时重新测量刷新目标值。
  useEffect(() => {
    if (!expanded) return;
    const onResize = () => {
      const el = contentRef.current;
      if (el) setFullHeight(el.scrollHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [expanded]);

  /** 展开/收起切换：展开前重新测量（同上 rationale——防挂载后异步高度变化） */
  const handleToggle = useCallback(() => {
    if (!expanded) {
      const el = contentRef.current;
      if (el) setFullHeight(el.scrollHeight);
    }
    setExpanded((prev) => !prev);
  }, [expanded]);

  /** 遮罩区点击只负责展开（遮罩仅折叠态渲染）；同样先重测再展开 */
  const handleFadeClick = useCallback(() => {
    const el = contentRef.current;
    if (el) setFullHeight(el.scrollHeight);
    setExpanded(true);
  }, []);

  return (
    <div className={`relative ${className ?? ''}`}>
      <div
        ref={contentRef}
        data-testid="collapsible-content"
        className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
        style={{
          // 未溢出不设 max-height（内容原样）；溢出时折叠态 = 阈值、展开态 = 实测
          // 全高——两个具体像素值之间才能插值出过渡动画（max-height 从 none 起步
          // 无法插值，见文件头踩坑索引）
          maxHeight: isOverflowing ? (expanded ? fullHeight : COLLAPSED_MAX_HEIGHT_PX) : undefined,
          // 折叠态内容自身渐隐（底部 40px 由实到透明）：mask 与气泡底色无关，
          // 任意类型色泡/渐变泡自动贴合，无需为每种气泡配渐变源色
          ...(isOverflowing && !expanded
            ? {
                maskImage: 'linear-gradient(to bottom, black calc(100% - 40px), transparent)',
                WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 40px), transparent)',
              }
            : {}),
        }}
      >
        {children}
        {/* 渐隐区透明点击层：mask 只影响渲染不影响命中——渐隐区下被遮住的链接
            仍可点中，叠此层吞掉点击，点渐隐区 = 展开而非误点看不见的链接。
            仅折叠态渲染，展开后移除、不遮挡内容 */}
        {isOverflowing && !expanded && (
          <div
            data-testid="collapse-fade"
            onClick={handleFadeClick}
            className="absolute inset-x-0 bottom-0 h-12 cursor-pointer"
          />
        )}
      </div>
      {isOverflowing && (
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={expanded}
          // text-current + opacity：继承气泡自身主题文字色（默认泡近白、status_update
          // 青、提案泡绿等），70% 常态 → 100% 悬停，任何气泡色调下都自适配
          className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-current opacity-70 transition-opacity hover:opacity-100"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-300 ${
              expanded ? 'rotate-180' : ''
            }`}
          />
          {expanded ? t('message.collapse') : t('message.expand')}
        </button>
      )}
    </div>
  );
}
