import { API_PREFIX } from '@agent-chamber/shared';

/**
 * 附件元数据响应形状（plan §3.1 契约钉死）。
 *
 * 刻意不含 bucket/objectKey 内部存储细节——外部消费方只需要 id 与 contentUrl，
 * 存储布局是实现私有信息（未来换 bucket 策略/键规则不破坏契约）。
 *
 * sizeBytes 为 number（DB bigint 读出 string，service toDto 显式 Number()；
 * 8MiB 单文件/200MiB 配额规模远低于 2^53，安全——刻意偏离平台 string 先例，
 * 转换点钉死见 attachment.service.ts toMetadataDto）。
 */
export interface AttachmentMetadataDto {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  topicId: string | null;
  docId: string | null;
  createdAt: Date;
}

/**
 * POST /attachments 响应形状（§3.1 钉死，Agent/SKILL 依赖）：
 * 元数据 + contentUrl（相对路径，前端 axios 实例同源拼接；Agent 直接引用进 markdown）。
 */
export interface UploadAttachmentResponse extends AttachmentMetadataDto {
  contentUrl: string;
}

/** contentUrl 单一拼装点（controller/service 不各自拼，防前缀漂移） */
export function buildContentUrl(id: string): string {
  return `${API_PREFIX}/attachments/${id}/content`;
}
