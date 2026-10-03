/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16a（附件安全模型 / mime 不变量）
 *   - 补充: docs/frontend-architecture.md §3.2.3（消息渲染 + 附件卡片）
 *
 * [踩坑索引]
 *   - 本模块是**纯常量 + 纯谓词**（无 'use client'、无 React、无 axios）：三个消费面
 *     （消息卡片 / topic composer / doc-editor）都要判「这条附件是不是内联图片」，
 *     若把常量放在组件模块里，后两者会被迫拖入整个客户端组件图（附件卡片 →
 *     attachment-image → image-preview.store），bundle 与测试 mock 面都被无谓放大。
 *
 * [铁律关联] #11（注释强制） #20（契约即设计）
 *
 * [修改检查]
 *   □ 已读 [设计文档]，确认修改符合设计意图
 *   □ 值域变更必须与后端 `INLINE_IMAGE_MIME_TYPES` 同步（不变量，见下）
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

/**
 * 内联图片 mime 白名单（**镜像后端 `INLINE_IMAGE_MIME_TYPES` 不变量**）。
 *
 * 语义：仅这 4 种**嗅探值**由 content 的 `![]()` 内联渲染（服务端 `mime_type` 列
 * 只承载字节证据：这 4 种之一，或非图片恒 `application/octet-stream`）。
 * 精确相等判断，**禁止 `startsWith('image/')` 前缀**——`image/svg+xml` 过闸即 XSS，
 * 后端已在三处出口用同一冻结常量做成员判断，前端只是其展示层镜像。
 *
 * 前端只用它回答两个问题：①「这条附件由 content 渲染还是渲染卡片」（消息气泡）；
 * ②「用户选的文件是不是图片」（doc-editor 的客户端提前拦截，判的是客户端声明的
 * `file.type`，与服务端嗅探门是两道独立的门，二者都要求图片）。
 */
export const INLINE_IMAGE_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** 图片附件判定（服务端 `mimeType` 是字节证据，可信；也可用于客户端声明值的粗门） */
export function isInlineImageAttachment(attachment: { mimeType: string }): boolean {
  return INLINE_IMAGE_MIME_TYPES.includes(attachment.mimeType);
}
