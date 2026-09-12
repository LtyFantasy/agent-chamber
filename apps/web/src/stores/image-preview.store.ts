import { create } from 'zustand';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 全局图片预览（Lightbox）：markdown 渲染图片点击放大（用户拍板，批 3 追加）
 *
 * [代码职责]
 *   - 命令式触发点（attachment-image.tsx 的 img onClick）↔ 声明式宿主
 *     （image-preview-host.tsx）之间的契约层：open(src, alt) / close()
 *
 * [权威文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（消息渲染）— 图片预览宿主挂载
 *   - 补充: docs/ui-design-system.md §6.1（markdown 图片渲染层级）
 *
 * [关键不变量]
 *   - 不 persist（瞬态 UI 状态，会话刷新即消失——与 notification.store 同范式）
 *   - src 为「当前显示 URL」：attachment 分支传 blob URL（blob 生命周期由
 *     AttachmentImage 的引用计数缓存管理，宿主只消费不持有）
 *
 * [关联代码]
 *   - src/components/attachments/attachment-image.tsx — 唯一触发点（open）
 *   - src/components/attachments/image-preview-host.tsx — 唯一消费点（渲染/close）
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

interface ImagePreviewState {
  /** 预览图片 src（null = 关闭；attachment 分支为 blob URL，外部图为原始 URL） */
  src: string | null;
  /** 图片 alt（读屏/对话框 aria-label，可选） */
  alt?: string;
  /** 打开预览（AttachmentImage 渲染态 img 点击触发） */
  open: (src: string, alt?: string) => void;
  /** 关闭预览（ESC / 背板点击 / 关闭按钮共用） */
  close: () => void;
}

/**
 * 全局图片预览 store（命令式触发 ↔ 声明式宿主的契约层，notification.store 范式）。
 * 不 persist：预览是瞬态 UI 状态，会话刷新即消失。
 */
export const useImagePreviewStore = create<ImagePreviewState>()((set) => ({
  src: null,
  alt: undefined,

  open: (src, alt) => set({ src, alt }),

  close: () => set({ src: null, alt: undefined }),
}));
