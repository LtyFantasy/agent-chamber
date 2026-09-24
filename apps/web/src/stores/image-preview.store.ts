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
 *     （image-preview-host.tsx）之间的契约层：open(displaySrc, alt, pinKey) / close()
 *
 * [权威文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（消息渲染）— 图片预览宿主挂载
 *   - 补充: docs/ui-design-system.md §6.1（markdown 图片渲染层级）
 *
 * [关键不变量]
 *   - 不 persist（瞬态 UI 状态，会话刷新即消失——与 notification.store 同范式）
 *   - **显示源与 pin 键分离**（plan §③ 键空间契约）：src = 「当前显示 URL」（attachment
 *     分支为 blob URL，外部图为原始 URL）；pinKey = 「附件内容 URL」，与
 *     attachment-image 的 blobCache 同键空间，宿主据此 acquireRef/releaseRef 持有 blob
 *     （附件 blob 由引用计数缓存管理，宿主按 pinKey 持有、不按 blobUrl——blobUrl 必 miss）
 *   - pinKey 仅内部流转：不得渲染进 DOM/URL（blob URL 与附件 URL 都属会话资源）
 *
 * [关联代码]
 *   - src/components/attachments/attachment-image.tsx — 唯一触发点（open）
 *     + acquireRef/releaseRef 模块 API（pin 计数）
 *   - src/components/attachments/image-preview-host.tsx — 唯一消费点（渲染/close/pin）
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
  /** 预览图片当前显示 URL（null = 关闭；attachment 分支为 blob URL，外部图为原始 URL） */
  src: string | null;
  /** 图片 alt（读屏/对话框 aria-label，可选） */
  alt?: string;
  /**
   * 预览图的附件内容 URL（pin 键，plan §③ 键空间契约）：
   * 与 attachment-image 的模块级 blobCache 同键空间，宿主据此引用计数持有 blob，
   * 保证预览期间组件滚出视口/卸载不会 revoke 掉正在显示的 blob；
   * 外部图无 blob → undefined（宿主不做引用计数）。
   */
  pinKey?: string;
  /** 打开预览（AttachmentImage 渲染态 img 点击触发；pinKey 见上） */
  open: (displaySrc: string, alt?: string, pinKey?: string) => void;
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
  pinKey: undefined,

  open: (displaySrc, alt, pinKey) => set({ src: displaySrc, alt, pinKey }),

  close: () => set({ src: null, alt: undefined, pinKey: undefined }),
}));
