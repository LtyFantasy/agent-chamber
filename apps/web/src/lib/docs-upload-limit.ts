/**
 * DocSpace 批量上传的大小限制工具（纯函数，无组件依赖，便于单测）。
 */

/**
 * 单文件大小上限：4.5MB。
 * rationale：后端 body limit 为 5mb 且作用于整个请求体（JSON 封装 + 批量元数据有开销），
 * 单文件阈值预留 ~0.5MB 余量，避免单文件顶格时整片请求被 413 拒绝（B4）。
 */
export const FILE_MAX_BYTES = 4.5 * 1024 * 1024;

/** 单文件大小校验（纯函数，B4 提前拒绝超限文件入列）：size > maxBytes 判定超限 */
export function isOverFileLimit(size: number, maxBytes: number = FILE_MAX_BYTES): boolean {
  return size > maxBytes;
}
