/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 附件对外契约形状（元数据 DTO / 上传响应 / 铸造响应）与 URL 拼装单源
 *
 * [代码职责]
 *   - `AttachmentMetadataDto` / `UploadAttachmentResponse` / `MintSignedUrlResponse`
 *   - `buildContentUrl` / `buildThumbnailUrl` / `buildSignedContentUrl`（相对路径拼装单源）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Attachments — 端点响应形状与字段语义
 *   - 补充: docs/api-definition.md §16a「附件 TTL 与类型放开」— expiresAt/clientMimeType 语义
 *
 * [铁律关联] #20(契约即设计) #17(测试契约) #11(注释)
 *
 * [关键不变量]
 *   - **四表面同一口径（R3）**：本 DTO 的字段集必须与 `GET :id` / `GET mine` /
 *     消息投影（shared `MessageAttachment`）**同形状同语义**产出——四者任一处新增/
 *     改名/改缺席语义，另外三处必须同批改，否则消费方按形状分支即炸。
 *   - `thumbnailContentUrl` **条件展开**：Present ⇔ 有缩略图；无缩略图**字面缺键**
 *     （绝不落 null/空串）；缩略图有无的判据是 `thumb_key` 非空。
 *   - `expiresAt` 恒出现（null = 永久），`clientMimeType` 恒出现（null = 无声明/非法）——
 *     二者与 `mimeType` 一起构成"呈现形态分类"的唯一输入（`mimeType` 非图片恒
 *     octet-stream，分类要用 `clientMimeType` + 文件名扩展名）。
 *   - `sizeBytes` 是 number（bigint → Number() 的唯一转换点在 attachment.service.toMetadataDto）。
 *   - 内部存储细节（bucket/objectKey/status）**永不**出现在本 DTO。
 *
 * [关联代码]
 *   - ../../../../packages/shared/src/dto/topic-response.dto.ts — MessageAttachment（第四表面）
 *   - attachment.service.ts — toMetadataDto（唯一构造点，四表面的三处共用它）
 *   - topic.service.ts projectAttachments — 消息投影构造点（与 toMetadataDto 对齐）
 *   - attachment.constants.ts — 变体值域（MintSignedUrlResponse.variant）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（尤其"四表面对齐"这条）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增字段先决定缺席语义（恒出现 / 条件展开），并在四处同批落地 + 测试
 * =============================================================================
 */
import { API_PREFIX } from '@agent-chamber/shared';
import { AttachmentSignedUrlVariant } from '../attachment.constants';

/**
 * 附件元数据响应形状（plan §3.1 契约钉死；v1.90.0-dev 补 expiresAt/clientMimeType）。
 *
 * 刻意不含 bucket/objectKey 内部存储细节——外部消费方只需要 id 与 contentUrl，
 * 存储布局是实现私有信息（未来换 bucket 策略/键规则不破坏契约）。
 *
 * sizeBytes 为 number（DB bigint 读出 string，service toDto 显式 Number()；
 * 10MiB 单文件/200MiB 配额规模远低于 2^53，安全——刻意偏离平台 string 先例，
 * 转换点钉死见 attachment.service.ts toMetadataDto）。
 *
 * **四表面同一口径（R3 不变量）**：本形状（含 expiresAt/clientMimeType）在
 * 上传响应 / `GET /attachments/:id` / `GET /attachments/mine` / 消息投影
 * （MessageAttachment）四处同形状同语义产出。
 */
export interface AttachmentMetadataDto {
  id: string;
  originalName: string;
  /**
   * MIME 类型——**字节证据**（4 种嗅探图片之一，或非图片恒 application/octet-stream）。
   * ⚠️ 客户端声明值不在此（见 clientMimeType）；呈现形态分类请用 clientMimeType + 扩展名。
   */
  mimeType: string;
  /**
   * 客户端声明的 mime（sanitize 后；非法/缺失 → null）——**纯展示信息**，不参与服务决策。
   */
  clientMimeType: string | null;
  sizeBytes: number;
  sha256: string;
  topicId: string | null;
  docId: string | null;
  /**
   * 过期时刻（ISO 8601）；**null = 永久**（doc 绑定 / topic 设置 never / 存量迁移行）。
   * 上传时按 topic 当时的 settings.attachmentTtl 冻结，事后改设置不追溯。
   */
  expiresAt: string | null;
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
