'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 markdown 渲染共享组件工厂（链接行为 + 附件鉴权图片，plan §5.2）
 *
 * [代码职责]
 *   - 单一事实源：docs 页 / 消息气泡 / doc-editor 预览三处 ReactMarkdown
 *     components 统一由本工厂产出，杜绝三份手写覆盖漂移
 *   - a 覆盖：外部链接新标签 / 平台文档链接 SPA 跳转 / 相对 .md 链接点击解析
 *     （docs 页 :407-455 提取，行为保持一致）
 *   - img 覆盖：img → AttachmentImage（附件 URL 走鉴权 blob 加载）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Attachments（读取链路全鉴权）
 *   - 补充: docs/frontend-architecture.md §8.5（/docs 板块约定）
 *
 * [关键不变量]
 *   - system 公告条与 thinking 过程记录两处 ReactMarkdown 不接本工厂：
 *     平台生成内容，无附件场景（plan §5.2 排除项）
 *   - 相对 .md 链接解析依赖 currentDocPath 注入；无文档上下文（消息气泡/
 *     doc-editor 预览）时相对链接按普通链接渲染，不拦截
 *
 * [关联代码]
 *   - src/components/attachments/attachment-image.tsx — img 覆盖目标
 *   - src/components/docs/doc-link.ts — isExternalHref / PLATFORM_DOC_LINK_RE / resolveDocHref
 *
 * [持久踩坑]
 *   - 无
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { Components } from 'react-markdown';
import { AttachmentImage } from '@/components/attachments/attachment-image';
import { isExternalHref, resolveDocHref, PLATFORM_DOC_LINK_RE } from '@/components/docs/doc-link';

/** markdownComponents 工厂选项（docs 页注入文档上下文；其余调用方零参数） */
export interface MarkdownComponentsOptions {
  /** 当前文档 path（相对 .md 链接解析基准源目录；无 = 相对链接不拦截） */
  currentDocPath?: string;
  /** 平台文档链接点击（SPA 跳转；无 = 普通链接渲染） */
  onPlatformDocLink?: (href: string) => void;
  /** 相对 .md 链接点击解析（异步 path → docId；无 = 不拦截） */
  onRelativeDocLink?: (resolvedPath: string) => void;
  /** 相对链接越出空间根（不可达）时的提示（docs 页 toast） */
  onBrokenDocLink?: () => void;
}

/**
 * 共享 markdownComponents 工厂（plan §5.2）：
 * a 覆盖 = docs 页 :407-455 提取（行为保持一致）+ img 覆盖 = AttachmentImage。
 */
export function createMarkdownComponents(options: MarkdownComponentsOptions = {}): Components {
  const { currentDocPath, onPlatformDocLink, onRelativeDocLink, onBrokenDocLink } = options;
  return {
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      if (isExternalHref(href)) {
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      }
      if (PLATFORM_DOC_LINK_RE.test(href)) {
        if (onPlatformDocLink) {
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                onPlatformDocLink(href);
              }}
            >
              {children}
            </a>
          );
        }
        return <a href={href}>{children}</a>;
      }
      if (currentDocPath) {
        const resolved = resolveDocHref(href, currentDocPath);
        if (resolved !== undefined) {
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (resolved === null) onBrokenDocLink?.();
                else onRelativeDocLink?.(resolved);
              }}
            >
              {children}
            </a>
          );
        }
      }
      return <a href={href}>{children}</a>;
    },
    img: (props) => <AttachmentImage {...props} />,
  };
}
