/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §Attachments（6 端点契约 + 错误码语义）
 *   - 补充: docs/architecture.md §3.2 (Attachments 模块)
 *
 * [踩坑索引] (无历史踩坑，新建文件；全仓首个 FileInterceptor——multipart
 *            解析实证见 attachment-upload-multipart.spec.ts)
 *
 * [铁律关联] #11(注释) #17(测试契约) #21(双层校验)
 *
 * [详细踩坑]（最多 5 条）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 路由顺序不变量：'mine' 必须声明在 ':id' 之前（Express 顺序匹配）
 *   □ GET content/thumbnail 的 @SkipTransform()/@Res(passthrough) 组合不得改动
 *   □ 缩略图 404 分码不变量：无缩略图必须 12008（不得并回 12000）
 *   □ 铸造端点（:id/signed-url）：响应必须 no-store（体内含能力凭证）；
 *     12008 文案逐字钉死（见 plan §②.6 文案表）
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
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MINT_URL_THROTTLE_LIMIT,
  ATTACHMENT_MINT_URL_THROTTLE_TTL_MS,
  ATTACHMENT_UPLOAD_THROTTLE_LIMIT,
  ATTACHMENT_UPLOAD_THROTTLE_TTL_MS,
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
 * 8MiB 上限 × 30/min 限流，单实例可承受，plan §10 已评估）+ 全维 limits
 * （fileSize/files/fields/parts/fieldSize，不给 busboy 留无界解析面）。
 * 文件超 8MiB 由 MulterLimitErrorInterceptor 映射 413 + 12001（错误码不许说谎）。
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
   * → 魔数白名单(12002) → 头部尺寸(400) → 配额事务(12003) → 插行。
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
    description: 'Image file (png/jpeg/gif/webp) bound to a topic or doc',
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
      'Upload an image (png/jpeg/gif/webp, ≤8MiB) bound to exactly one of topicId/docId. ' +
      'Magic-byte sniffed (client Content-Type not trusted); dimension bomb rejected; ' +
      'per-uploader quota enforced in the same transaction as the row insert. ' +
      'Rate limit: 30/min/IP.',
  })
  @ApiResponse({ status: 201, description: 'Attachment uploaded (returns contentUrl)' })
  @ApiResponse({ status: 400, description: 'Bind conflict / type not allowed / bad image header' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'No write permission on target, or quota exceeded' })
  @ApiResponse({ status: 404, description: 'Target topic/doc not found' })
  @ApiResponse({ status: 413, description: 'File exceeds 8MiB (ATTACHMENT_TOO_LARGE)' })
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
   * 响应头钉死：Content-Type 用 DB 存值（魔数嗅探单一来源）/ nosniff /
   * inline + RFC 6266 filename* / private 缓存 1h / ETag=sha256。
   */
  @Get(':id/content')
  @SkipTransform()
  @ApiOperation({
    summary: 'Get attachment content',
    description:
      'Streams the image with full auth (Bearer/X-API-Key). ETag = sha256; ' +
      'Cache-Control: private, max-age=3600. 404 both when missing and when access is denied.',
  })
  @ApiParam({ name: 'id', description: 'Attachment UUID', type: String })
  @ApiProduces('image/*')
  @ApiResponse({ status: 200, description: 'Image bytes (inline)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 404, description: 'Attachment not found (or access denied)' })
  async getContent(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { attachment, stream } = await this.attachmentService.getContent(id, actor);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeFilenameStar(attachment.originalName)}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');
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
   * 是规格常量不是数据）/ nosniff / inline + `<原stem>_thumb.webp` /
   * private 缓存 1h / ETag=thumb_sha256。
   */
  @Get(':id/thumbnail')
  @SkipTransform()
  @ApiOperation({
    summary: 'Get attachment thumbnail',
    description:
      'Streams the webp thumbnail variant (max edge 512, first frame for animated input) ' +
      'with full auth. ETag = thumb_sha256; Cache-Control: private, max-age=3600. ' +
      '404/ATTACHMENT_NOT_FOUND when missing or access denied; ' +
      '404/ATTACHMENT_THUMBNAIL_UNAVAILABLE (12008) when the attachment has no thumbnail ' +
      '(use /content for the original).',
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
  async getThumbnail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { attachment, stream } = await this.attachmentService.getThumbnail(id, actor);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeFilenameStar(buildThumbnailFilename(attachment.originalName))}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');
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
      'Rate limit: 30/min/IP.',
  })
  @ApiParam({ name: 'id', description: 'Attachment UUID', type: String })
  @ApiResponse({ status: 200, description: 'Signed URL minted (signedUrl/expiresAt/variant)' })
  @ApiResponse({
    status: 400,
    description: 'Invalid ttlSeconds (outside 60-3600) or variant value',
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
