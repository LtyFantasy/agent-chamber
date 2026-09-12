import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * POST /attachments 绑定查询参数 DTO。
 *
 * 边界层只管格式（UUID 形态）；「topicId 与 docId 恰好一值」是业务规则，
 * 在 service 校验链第一道判定（违例 400 ATTACHMENT_BIND_CONFLICT）——
 * 双传/双缺都不是格式错误，不进 DTO 层（铁律 #21 双层校验分工）。
 */
export class UploadAttachmentQueryDto {
  /** 绑定话题 ID（与 docId 互斥，恰好传一个） */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Bind to topic UUID (mutually exclusive with docId)' })
  topicId?: string;

  /** 绑定文档 ID（与 topicId 互斥，恰好传一个） */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Bind to doc UUID (mutually exclusive with topicId)' })
  docId?: string;
}
