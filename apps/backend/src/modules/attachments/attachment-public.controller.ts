/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 附件公开读取端点：短时签名 URL 的消费侧（capability URL）
 *
 * [代码职责]
 *   - `GET /public/attachments/:id/content?token=` 流式返回对象字节，
 *     token 即凭证（**不做授权检查**，与 /attachments/:id/content 的本质差异）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Attachments — 公开端点契约/响应头/12006/12007/12008
 *   - 补充: DEPLOY.md — 反代与限流（trust proxy 语义）
 *
 * [关键不变量]
 *   - **类级不得挂任何守卫**（无 JwtOrApiKeyGuard）：这是本端点存在的理由——
 *     要能直接进 `<img src>` / markdown。仅 `@Public()` 让全局 JwtAuthGuard 放行
 *   - 无 `Cache-Control` 的 max-age（或极短）：能力 URL 进共享缓存 = 凭证随缓存扩散，
 *     故恒 `Cache-Control: private`（与 /attachments/:id/content 的 private, max-age=3600 刻意不同）
 *   - 响应头不得泄露存储内部（无 bucket/objectKey；文件名走 RFC 6266 filename*）
 *   - 断言顺序由 service 保证：无效凭证先 401，绝不借 404 探测附件存在性
 *
 * [关联代码]
 *   - attachment-signed-url.service.ts — 验签/三断言/取流（本端点唯一业务依赖）
 *   - common/utils/redact-url.ts — 日志脱敏（?token= 不进日志）
 *   - attachment.controller.ts — 全鉴权版读取端点（授权路径对照）
 *
 * [持久踩坑]
 *   P2-B1(凭证同钥): 会话 token 打到本端点必须 401·12006（scope 断言挡下）——
 *     两族凭证的密钥/声明隔离是双向回归的验收项。安全方向: 独立密钥 + scope 断言。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ErrorCode } from '@agent-chamber/shared';
import {
  AttachmentSignedUrlService,
  SIGNATURE_INVALID_MESSAGE,
} from './attachment-signed-url.service';
import { SignedUrlTokenQueryDto } from './dto/signed-url-token-query.dto';
import { encodeFilenameStar, buildThumbnailFilename } from './filename-sanitize';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { Public } from '../../common/decorators/public.decorator';
import {
  ATTACHMENT_PUBLIC_CONTENT_THROTTLE_LIMIT,
  ATTACHMENT_PUBLIC_CONTENT_THROTTLE_TTL_MS,
} from './attachment.constants';

/**
 * 附件公开控制器（P2 批 2 / plan §②.4）。
 *
 * 与 AttachmentController 的分工：本控制器的端点是**唯一**允许无 Authorization、
 * 无 X-API-Key 访问附件字节的入口，凭证是 query 里的短时签名 token；其余读取路径
 * 保持全鉴权（可见性收口哲学不变）。
 *
 * 安全面（逐条对应实现）：
 * - 无类级守卫 + `@Public()`：全局 JwtAuthGuard 放行；**类级挂 JwtOrApiKeyGuard
 *   会直接废掉该端点**（公开 URL 带不了 Authorization 头）；
 * - token 格式校验走 DTO（必填/非空/≤2048 字符；数组形态由 @IsString 拒），
 *   controller 侧另有显式 typeof 复检（校验链被绕过时也不把非字符串喂进验签器）；
 * - 限流 60/min/IP（常量+env 范式）；生产需 `trust proxy` 才能按真实客户端计数
 *   （main.ts 已设，见该文件注释）；
 * - 响应头：Content-Type 按变体（thumbnail 恒 image/webp，original 取 DB mime_type）、
 *   nosniff、inline + RFC 6266 文件名、ETag=对应内容 sha256、`Cache-Control: private`。
 */
@ApiTags('Attachments (public)')
@Controller('public/attachments')
export class AttachmentPublicController {
  constructor(private readonly signedUrlService: AttachmentSignedUrlService) {}

  /**
   * 公开内容读取（签名 URL 的消费点）。
   *
   * @SkipTransform()：StreamableFile 必须绕过 ResponseInterceptor 信封
   * （/attachments/:id/content 同款组合）；@Res({passthrough:true})：ETag/文件名
   * 随变体动态变化，静态 @Header 表达不了。
   */
  @Get(':id/content')
  @Public()
  @SkipTransform()
  @Throttle({
    default: {
      limit: ATTACHMENT_PUBLIC_CONTENT_THROTTLE_LIMIT,
      ttl: ATTACHMENT_PUBLIC_CONTENT_THROTTLE_TTL_MS,
    },
  })
  @ApiOperation({
    summary: 'Get attachment content via signed URL (no API key)',
    description:
      'Streams the attachment (or its webp thumbnail, per the token variant) using a ' +
      'short-lived signed URL token. This endpoint needs no Authorization header and no ' +
      'X-API-Key — the token in the query string IS the credential. ' +
      '401/ATTACHMENT_SIGNATURE_INVALID (12006) on bad signature / wrong scope / id mismatch; ' +
      '401/ATTACHMENT_SIGNATURE_EXPIRED (12007) when expired; ' +
      '404/ATTACHMENT_NOT_FOUND (12000) when the attachment is missing or soft-deleted; ' +
      '404/ATTACHMENT_THUMBNAIL_UNAVAILABLE (12008) for thumbnail tokens without a thumbnail. ' +
      'Rate limit: 60/min/IP.',
  })
  @ApiParam({ name: 'id', description: 'Attachment UUID', type: String })
  @ApiQuery({
    name: 'token',
    description: 'Signed URL token from POST /attachments/:id/signed-url',
  })
  @ApiProduces('image/*')
  @ApiResponse({
    status: 200,
    description: 'Image bytes (inline; Cache-Control: private, no shared caching)',
  })
  @ApiResponse({
    status: 401,
    description: 'Signed URL token invalid (12006) or expired (12007)',
  })
  @ApiResponse({
    status: 404,
    description: 'Attachment not found / soft-deleted (12000), or thumbnail unavailable (12008)',
  })
  @ApiResponse({ status: 429, description: 'Read rate limit exceeded' })
  async getPublicContent(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: SignedUrlTokenQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // 显式形状复检（DTO 已拦，此处防"校验链被绕过"——绝不把非字符串喂给 verify）：
    // 数组形态（?token=a&token=b）在此同样被拒，归类到 12006（凭证不可用），
    // 与 service 的三断言失败同码同文案（文案常量从 service 导出，逐字同源）。
    const token = query?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new UnauthorizedException({
        message: SIGNATURE_INVALID_MESSAGE,
        code: ErrorCode.ATTACHMENT_SIGNATURE_INVALID,
      });
    }

    const { attachment, variant, stream } = await this.signedUrlService.resolvePublicContent(
      id,
      token,
    );

    if (variant === 'thumbnail') {
      // 缩略图变体：格式是规格常量（webp），mime 不从 DB 取（DB 无 thumb mime 列）
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeFilenameStar(buildThumbnailFilename(attachment.originalName))}`,
      );
      res.setHeader('ETag', `"${attachment.thumbSha256}"`);
    } else {
      res.setHeader('Content-Type', attachment.mimeType);
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeFilenameStar(attachment.originalName)}`,
      );
      res.setHeader('ETag', `"${attachment.sha256}"`);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 能力 URL 场景禁共享缓存（凭证随缓存扩散）：恒 private，不设 max-age
    res.setHeader('Cache-Control', 'private');
    return new StreamableFile(stream);
  }
}
