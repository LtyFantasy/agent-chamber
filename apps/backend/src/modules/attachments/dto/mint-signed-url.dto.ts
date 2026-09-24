import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ATTACHMENT_SIGNED_URL_TTL_MAX_SECONDS,
  ATTACHMENT_SIGNED_URL_TTL_MIN_SECONDS,
  ATTACHMENT_SIGNED_URL_VARIANTS,
  AttachmentSignedUrlVariant,
} from '../attachment.constants';

/**
 * `POST /attachments/:id/signed-url` 请求体 DTO（P2 批 2 / plan §②.3）。
 *
 * 边界层只管**格式与边界**（整数类型 + 区间 + 变体白名单），资源是否存在/是否有
 * 读取权限/该附件有没有缩略图是业务规则，在 service 层判定（铁律 #21 双层校验）：
 * - 附件不可达（不存在/已软删/无权）→ 404·12000；
 * - variant=thumbnail 但该附件无缩略图 → 404·12008（fail fast，不签出注定 404 的 URL）。
 *
 * 越界一律 400 诚实拒（不静默钳制到区间内——静默钳制会让消费方以为生效了，
 * 而实际有效期与请求不符）。
 */
export class MintSignedUrlDto {
  /**
   * 生效时长（秒），区间 [60, 3600]，缺省 = config `attachmentUrl.ttlDefaultSeconds`（默认 300）。
   * 刻意不加 `@Type(() => Number)`：本参数来自 JSON 请求体（不是 query 串），
   * 字符串 "300" 属形状错误应 400，而不是被悄悄转换。
   */
  @IsOptional()
  @IsInt()
  @Min(ATTACHMENT_SIGNED_URL_TTL_MIN_SECONDS)
  @Max(ATTACHMENT_SIGNED_URL_TTL_MAX_SECONDS)
  @ApiPropertyOptional({
    description:
      `Validity in seconds (${ATTACHMENT_SIGNED_URL_TTL_MIN_SECONDS}-${ATTACHMENT_SIGNED_URL_TTL_MAX_SECONDS}); ` +
      'defaults to ATTACHMENT_SIGNED_URL_TTL_DEFAULT (300)',
    example: 300,
  })
  ttlSeconds?: number;

  /**
   * 变体（缺省 original）：original=原图，thumbnail=webp 缩略图变体。
   * 请求 thumbnail 但附件无缩略图（存量行/生成失败）→ 404·12008，消息指导改签 original。
   */
  @IsOptional()
  @IsIn(ATTACHMENT_SIGNED_URL_VARIANTS)
  @ApiPropertyOptional({
    description: 'Which variant to sign (default: original)',
    enum: ATTACHMENT_SIGNED_URL_VARIANTS,
    example: 'original',
  })
  variant?: AttachmentSignedUrlVariant;
}
