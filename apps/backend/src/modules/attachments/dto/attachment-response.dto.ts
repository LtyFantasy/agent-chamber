import { API_PREFIX } from '@agent-chamber/shared';
import { AttachmentSignedUrlVariant } from '../attachment.constants';

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
  /**
   * 缩略图 URL（相对路径，buildThumbnailUrl 单一拼装点派生）。
   *
   * 缺席语义（**四表面同一口径**：upload 响应 / GET :id / GET mine / 消息投影）：
   * Present ⇔ 该附件当前有缩略图；absent = 无缩略图，回退 contentUrl；
   * 永不为 null/空串（服务端条件展开该键，无缩略图时字面缺键）。
   */
  thumbnailContentUrl?: string;
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

/**
 * thumbnailContentUrl 单一拼装点（与 buildContentUrl 同规，防前缀漂移）。
 * 只在"该附件有缩略图"时被调用（thumb_key 非空判定在 service/投影层）。
 */
export function buildThumbnailUrl(id: string): string {
  return `${API_PREFIX}/attachments/${id}/thumbnail`;
}

/**
 * 短时签名 URL 响应形状（P2 批 2 / plan §②.3 钉死）。
 *
 * - signedUrl：**相对路径**（含 `/api/v1` 前缀，无 origin）——消费方按 origin 拼接
 *   （web 前端 axios 同源实例 / Agent 用平台地址），与 contentUrl 同款约定；
 *   路径指向公开端点（无需 API Key/Authorization），token 已内嵌为 query；
 * - expiresAt：ISO 8601，取自签出 token 的 `exp` 声明（与校验口径同源，不另算时钟）；
 * - variant：回声**实际签发**的变体（请求未指定时为 original），消费方可据此决定
 *   渲染用途（缩略图恒 webp / 原图取 DB mime）。
 */
export interface MintSignedUrlResponse {
  signedUrl: string;
  expiresAt: string;
  variant: AttachmentSignedUrlVariant;
}

/**
 * signedUrl 单一拼装点（与 contentUrl/thumbnailUrl 同规，防前缀漂移）。
 *
 * token 经 `encodeURIComponent`：JWT 字符集（base64url + `.`）本就 URL 安全，
 * 编码是无副作用的防御——若未来 token 形态变化（引入其它字符）也不会拼出坏 URL。
 */
export function buildSignedContentUrl(id: string, token: string): string {
  return `${API_PREFIX}/public/attachments/${id}/content?token=${encodeURIComponent(token)}`;
}
