/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 附件全鉴权端点族（上传 / 元数据 / 字节 / 缩略图 / 铸造 / 删除）
 *
 * [代码职责]
 *   - 路由与守卫（类级 JwtOrApiKeyGuard，刻意拒绝 capability URL）
 *   - multipart 解析配置（memoryStorage + 全维 limits）与拦截器接线
 *   - **响应头**：inline/attachment 分叉、nosniff、CSP sandbox、Cache-Control、ETag
 *   - Swagger 契约描述（错误码/上限/410·12009）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Attachments — 6 端点契约 + 错误码语义
 *   - 补充: docs/api-definition.md §16a「附件 TTL 与类型放开」— 出口头与 410·12009
 *   - 补充: docs/architecture.md §3.2 — Attachments 模块
 *
 * [铁律关联] #11(注释) #17(测试契约) #21(双层校验)
 *
 * [关键不变量]
 *   - 路由顺序：`'mine'` 必须声明在 `':id'` 之前（Express 顺序匹配，反序会被
 *     ParseUUIDPipe 拦成 400）；`content/thumbnail` 的 @SkipTransform() +
 *     @Res({passthrough:true}) 组合不得改动（StreamableFile 必须绕过响应信封）。
 *   - **出口头（§1.2）**：inline 判据 = `isInlineImageMime` **精确成员判断**
 *     （禁前缀/正则——`image/svg+xml` 过闸 = XSS）；非图片恒
 *     `application/octet-stream` + `attachment`；三出口全量 `nosniff` +
 *     `Content-Security-Policy: sandbox`（**纯 sandbox**，不带 default-src）。
 *   - **Cache-Control 范围（N1）**：仅 content/thumbnail 为 `private, max-age=300`；
 *     public 端点保持 `private` 无 max-age 不动（能力 URL 进共享缓存 = 凭证扩散）。
 *   - **分码**：无缩略图必须 12008（不得并回 12000）；已过期附件字节面 410·12009；
 *     铸造端点响应必须 `no-store`（体内含能力凭证），12008 文案逐字钉死。
 *   - 错误码不许说谎：multipart 超限由 MulterLimitErrorInterceptor 映射 413·12001。
 *
 * [关联代码]
 *   - attachment.service.ts — 业务链（本文件只做路由/头/解析面）
 *   - attachment.constants.ts — 上限/限流/inline 判据单源
 *   - attachment-public.controller.ts — 公开面（无守卫，出口头须与本文件同套）
 *   - attachment-upload-multipart.spec.ts — 全仓首个 FileInterceptor 的 multipart 解析实证
 *   - test/attachments.e2e-spec.ts — 响应头逐字断言（改头必先看它）
 *
 * [持久踩坑]
 *   - （无历史踩坑，新建文件；全仓首个 FileInterceptor——multipart 解析实证见
 *     attachment-upload-multipart.spec.ts）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 路由顺序不变量：'mine' 必须声明在 ':id' 之前（Express 顺序匹配）
 *   □ GET content/thumbnail 的 @SkipTransform()/@Res(passthrough) 组合不得改动
 *   □ 改响应头后同步：public 端点同套头 + Swagger 描述 + e2e 断言（三处同批）
 * =============================================================================
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AttachmentService, UploadedMemoryFile } from './attachment.service';
import { AttachmentSignedUrlService } from './attachment-signed-url.service';
import { MulterLimitErrorInterceptor } from './multer-error.interceptor';
import { UploadAttachmentQueryDto } from './dto/upload-attachment-query.dto';
import { QueryMineDto } from './dto/query-mine.dto';
import { MintSignedUrlDto } from './dto/mint-signed-url.dto';
import { MintSignedUrlResponse } from './dto/attachment-response.dto';
import {
  ATTACHMENT_FALLBACK_MIME,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MINT_URL_THROTTLE_LIMIT,
  ATTACHMENT_MINT_URL_THROTTLE_TTL_MS,
  ATTACHMENT_UPLOAD_THROTTLE_LIMIT,
  ATTACHMENT_UPLOAD_THROTTLE_TTL_MS,
  isInlineImageMime,
} from './attachment.constants';
import { encodeFilenameStar, buildThumbnailFilename } from './filename-sanitize';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { UnifiedActor } from '../../common/types/actor.types';

/**
 * 附件控制器（plan §3.1 五端点 + P2 批 1 缩略图端点）。
 *
 * 全端点类级 JwtOrApiKeyGuard（JWT 与 API Key 双通道，roundtable/search 先例）：
 * 读取链路保持全鉴权——刻意拒绝 capability URL（可见性收口哲学，plan §0.2）。
 *
 * multer 配置钉死：memoryStorage（platform-express 默认，buffer 在内存——
 * 10MiB 上限 × 30/min 限流，单实例可承受；**多 IP 并发下在途缓冲会叠加**
 * （限流按 IP 计数不互相削峰），全局在途上传数闸门记 P2（m8））+
 * 全维 limits（fileSize/files/fields/parts/fieldSize，不给 busboy 留无界解析面）。
 * 文件超 10MiB 由 MulterLimitErrorInterceptor 映射 413 + 12001（错误码不许说谎）。
 */
@ApiTags('Attachments')
@Controller('attachments')
@UseGuards(JwtOrApiKeyGuard)
export class AttachmentController {
  constructor(
    private readonly attachmentService: AttachmentService,
    private readonly signedUrlService: AttachmentSignedUrlService,
  ) {}

  /**
   * 上传附件（绑定 topic 或 doc，恰好一值）。
   *
   * 校验链（service 层，顺序钉死）：绑定恰好一值(12005) → 绑定资源存在+写权限(12004)
   * → 字节证据分类（图片：尺寸校验 400；非图片：直接放行）→ 配额事务(12003) → 插行。
   * 出口安全模型（v1.90.0-dev）：唯一防线 = 响应头（非图片恒 octet-stream + attachment），
   * 准入不做类型白名单（详见 api-definition §16a）。
   */
  @Post()
  @Throttle({
    default: {
      limit: ATTACHMENT_UPLOAD_THROTTLE_LIMIT,
      ttl: ATTACHMENT_UPLOAD_THROTTLE_TTL_MS,
    },
  })
  @UseInterceptors(
    MulterLimitErrorInterceptor,
    FileInterceptor('file', {
      limits: {
        fileSize: ATTACHMENT_MAX_BYTES,
        files: 1,
        fields: 5,
        parts: 10,
        fieldSize: 1024 * 1024,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Any file (≤10MB) bound to a topic or doc',
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiQuery({ name: 'topicId', required: false, description: 'Bind to topic (xor docId)' })
  @ApiQuery({ name: 'docId', required: false, description: 'Bind to doc (xor topicId)' })
  @ApiOperation({
    summary: 'Upload attachment',
    description:
      'Upload a file (≤10MB) bound to exactly one of topicId/docId. ' +
      'Magic-byte sniffed: image types (png/jpeg/gif/webp) are inline-eligible; every other ' +
      'byte stream is stored as application/octet-stream and always served as an attachment ' +
      '(client Content-Type is never trusted; it is kept only as clientMimeType for display). ' +
      'Image dimension bombs rejected; per-uploader quota enforced in the same transaction ' +
      'as the row insert. Topic-bound rows get expiresAt = now + topic.settings.attachmentTtl ' +
      '(default 7d, fail-closed); doc-bound rows never expire. ' +
      'Rate limit: 30/min/IP.',
  })
  @ApiResponse({ status: 201, description: 'Attachment uploaded (returns contentUrl)' })
  @ApiResponse({ status: 400, description: 'Bind conflict, or malformed image header' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'No write permission on target, or quota exceeded' })
  @ApiResponse({ status: 404, description: 'Target topic/doc not found' })
  @ApiResponse({ status: 413, description: 'File exceeds 10MB (ATTACHMENT_TOO_LARGE)' })
  @ApiResponse({ status: 429, description: 'Upload rate limit exceeded' })
  upload(
    @CurrentActor() actor: UnifiedActor,
    @Query() query: UploadAttachmentQueryDto,
    @UploadedFile() file: UploadedMemoryFile | undefined,
  ) {
    return this.attachmentService.upload(actor, query, file);
  }

  /**
   * 我的附件分页（自己的上传自己可管理，与绑定资源可见性无关）。
   * ⚠️ 路由顺序不变量：必须声明在 ':id' 之前——Express 顺序匹配，
   * 反序会让 "mine" 被 ':id' 的 ParseUUIDPipe 拦成 400。
   */
  @Get('mine')
  @ApiOperation({
    summary: 'List my attachments',
    description: 'Paginated list of attachments uploaded by the current actor (pageSize ≤ 100).',
  })
  @ApiResponse({ status: 200, description: 'Paginated attachment metadata list' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  findMine(@CurrentActor() actor: UnifiedActor, @Query() query: QueryMineDto) {
    return this.attachmentService.findMine(actor, query);
  }

  /**
   * 附件元数据。无权限与不存在统一 404（不泄露存在性）。
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get attachment metadata',
    description:
      'Returns metadata (no bucket/objectKey internals). 404 both when missing and when access is denied.',
  })
  @ApiParam({ name: 'id', description: 'Attachment UUID', type: String })
  @ApiResponse({ status: 200, description: 'Attachment metadata' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 404, description: 'Attachment not found (or access denied)' })
  getMetadata(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    return this.attachmentService.getMetadata(id, actor);
  }

  /**
   * 附件内容（全鉴权代理流）。
   *
   * @SkipTransform()：StreamableFile 必须绕过 ResponseInterceptor 信封
   * （downloads.controller 先例）；@Res({passthrough:true})：ETag 由 sha256
   * 动态生成，@Header 静态装饰器表达不了，须手动 setHeader（plan §3.1）。
   *
   * 响应头钉死（v1.90.0-dev 出口收紧，§1.2）：
   * - **inline 分叉**：`INLINE_IMAGE_MIME_TYPES` **精确相等**成员判断命中 → Content-Type
   *   取 DB 字节证据值 + `inline`；未命中（含非图片恒 octet-stream）→ Content-Type 恒
   *   `application/octet-stream` + `attachment`（强制下载，不渲染）；
   * - `nosniff` + `Content-Security-Policy: sandbox`（**纯 sandbox，不带 default-src**——
   *   sandbox 已给不透明源 + 禁脚本，是防 polyglot 顶层渲染的全部所需；`default-src 'none'`
   *   对脚本面零增益且可能掐掉浏览器顶层直开图片时合成的内部 `<img>` 造成裂图）；
   * - RFC 6266 filename* / `private, max-age=300`（TTL 最短档 1d 与 1h 客户端缓存冲突，
   *   收到 300s——ETag 兜底重验证）/ ETag=sha256。
   */
  @Get(':id/content')
  @SkipTransform()
  @ApiOperation({
    summary: 'Get attachment content',
    description:
      'Streams the attachment bytes with full auth (Bearer/X-API-Key). Images ' +
      '(png/jpeg/gif/webp, exact mime match) are served inline with their sniffed ' +
      'Content-Type; every other type is forced to application/octet-stream with ' +
      'Content-Disposition: attachment. All responses carry X-Content-Type-Options: nosniff ' +
      'and Content-Security-Policy: sandbox. ETag = sha256; Cache-Control: private, max-age=300. ' +
      '404 both when missing and when access is denied (12000); 410/ATTACHMENT_EXPIRED (12009) ' +
      'for expired attachments (metadata reads still 200 — the row is purged later by GC, ' +
      'after which the byte path returns 404).',
  })
  @ApiParam({ name: 'id', description: 'Attachment UUID', type: String })
  @ApiProduces('image/*', 'application/octet-stream')
  @ApiResponse({
    status: 200,
    description: 'Attachment bytes (inline for images, attachment otherwise)',
  })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 404, description: 'Attachment not found (or access denied)' })
  @ApiResponse({ status: 410, description: 'Attachment expired (12009)' })
  async getContent(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { attachment, stream } = await this.attachmentService.getContent(id, actor);
    // 精确成员判断（禁止前缀/正则：image/svg+xml 过闸 = XSS 面）
    const inline = isInlineImageMime(attachment.mimeType);
    res.setHeader('Content-Type', inline ? attachment.mimeType : ATTACHMENT_FALLBACK_MIME);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 纯 sandbox（不带 default-src 'none'）：见方法注释
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeFilenameStar(attachment.originalName)}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    // ETag = sha256（内容相等性 oracle；带引号是 RFC 7232 强校验器标准形态）
    res.setHeader('ETag', `"${attachment.sha256}"`);
    return new StreamableFile(stream);
  }

  /**
   * 附件缩略图（P2 批 1，webp 变体）。
   *
   * 授权与 /content 同一入口（findAccessible：不存在/无权一律 404·12000）；
   * **无缩略图**（存量行 / 上传时 fail-open 失败）→ 404·12008，消息指导改用
   * /content 取原图——与 12000 刻意分码，消费方可区分两类 404。
   *
   * @SkipTransform()：StreamableFile 绕过响应信封（/content 同款组合）。
   * 响应头钉死：Content-Type 恒 image/webp（DB thumb 列不存 mime——变体格式
   * 是规格常量不是数据）/ nosniff / CSP sandbox / inline + `<原stem>_thumb.webp` /
   * private 缓存 300s / ETag=thumb_sha256。
   */
  @Get(':id/thumbnail')
  @SkipTransform()
  @ApiOperation({
    summary: 'Get attachment thumbnail',
    description:
      'Streams the webp thumbnail variant (max edge 512, first frame for animated input) ' +
      'with full auth. Images only — non-image attachments have no thumbnail. ' +
      'ETag = thumb_sha256; Cache-Control: private, max-age=300; nosniff + CSP sandbox. ' +
      '404/ATTACHMENT_NOT_FOUND when missing or access denied; ' +
      '404/ATTACHMENT_THUMBNAIL_UNAVAILABLE (12008) when the attachment has no thumbnail ' +
      '(use /content for the original); 410/ATTACHMENT_EXPIRED (12009) when expired.',
  })
  @ApiParam({ name: 'id', description: 'Attachment UUID', type: String })
  @ApiProduces('image/webp')
  @ApiResponse({ status: 200, description: 'Thumbnail bytes (image/webp, inline)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({
    status: 404,
    description:
      'Attachment not found / access denied (12000), or the attachment has no thumbnail (12008)',
  })
  @ApiResponse({ status: 410, description: 'Attachment expired (12009)' })
  async getThumbnail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { attachment, stream } = await this.attachmentService.getThumbnail(id, actor);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 纯 sandbox（与 /content 同值）：防 polyglot 顶层渲染的第二道门
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeFilenameStar(buildThumbnailFilename(attachment.originalName))}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    // ETag = thumb_sha256（缩略图内容相等性 oracle，与原图 ETag 同规）
    res.setHeader('ETag', `"${attachment.thumbSha256}"`);
    return new StreamableFile(stream);
  }

  /**
   * 铸造短时签名 URL（P2 批 2 / plan §②.3）。
   *
   * 用途：把附件分享给**没有平台凭证的场景**（外部工具拉图、markdown 直链、
   * 前端 `<img src>`）——铸造本身仍需完整鉴权（类级 JwtOrApiKeyGuard），
   * 拿到的 URL 才是免凭证的一次性凭证。
   *
   * 校验链：ParseUUIDPipe(格式) → DTO(ttlSeconds 区间/variant 白名单) →
   * service：读授权+软删 fail-fast(404·12000) → 变体可行性(无缩略图 404·12008)
   * → HS256 签发（独立密钥）→ audit（newData 不含 token）。
   *
   * 返回 200 而非 201：本端点不创建持久资源（签出的 token 无状态、不落库），
   * 语义是"派生一个凭证"，故用 OK 而非 Created。
   *
   * `Cache-Control: no-store`：响应体内含能力凭证（token 在 signedUrl 内），
   * 任何中间缓存留存都等于凭证扩散。
   */
  @Post(':id/signed-url')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: ATTACHMENT_MINT_URL_THROTTLE_LIMIT,
      ttl: ATTACHMENT_MINT_URL_THROTTLE_TTL_MS,
    },
  })
  @ApiOperation({
    summary: 'Mint a short-lived signed URL',
    description:
      'Mints an HS256 signed URL for this attachment (default TTL 300s, max 3600s). ' +
      'The returned signedUrl points at the public endpoint and needs neither Authorization ' +
      'nor X-API-Key — the token IS the credential. Safe to retry: every call mints a new token. ' +
      'Requires read access; 404 both when missing and when access is denied. ' +
      'variant=thumbnail on an attachment without a thumbnail → 404/ATTACHMENT_THUMBNAIL_UNAVAILABLE (12008). ' +
      'Expired attachments (expiresAt < now) → 400/ATTACHMENT_EXPIRED (12009): a dead attachment ' +
      'cannot be shared, even though its metadata stays readable at GET /attachments/:id. ' +
      'Rate limit: 30/min/IP.',
  })
  @ApiParam({ name: 'id', description: 'Attachment UUID', type: String })
  @ApiResponse({ status: 200, description: 'Signed URL minted (signedUrl/expiresAt/variant)' })
  @ApiResponse({
    status: 400,
    description:
      'Invalid ttlSeconds (outside 60-3600) or variant value, or the attachment has expired (12009)',
  })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({
    status: 404,
    description: 'Attachment not found / access denied (12000), or thumbnail unavailable (12008)',
  })
  @ApiResponse({ status: 429, description: 'Mint rate limit exceeded' })
  async mintSignedUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Body() dto: MintSignedUrlDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MintSignedUrlResponse> {
    const result = await this.signedUrlService.mint(id, actor, dto);
    res.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /**
   * 删除附件（上传者或 admin；存在但无权限同样 404）。
   * 顺序钉死：先软删行 → 后删对象（失败仅记日志，GC 重试）→ 写 audit。
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete attachment',
    description:
      'Soft-delete the row first, then best-effort remove the object (GC retries on failure). ' +
      'Uploader or admin only; 404 both when missing and when access is denied.',
  })
  @ApiParam({ name: 'id', description: 'Attachment UUID', type: String })
  @ApiResponse({ status: 200, description: 'Attachment deleted' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 404, description: 'Attachment not found (or access denied)' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    await this.attachmentService.remove(id, actor);
    return { deleted: true };
  }
}
