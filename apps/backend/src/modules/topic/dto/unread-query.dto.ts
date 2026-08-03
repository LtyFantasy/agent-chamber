import { Type } from 'class-transformer';
import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GET /topics/:id/messages/unread 查询参数 DTO
 */
export class UnreadQueryDto {
  /**
   * 返回的未读消息条数，1~50，默认 20。
   * 不影响 unreadCount（全量未读数）。
   */
  @ApiPropertyOptional({
    description:
      'Number of unread messages to return, 1–50, default 20. Does not affect unreadCount (total unread count).',
    minimum: 1,
    maximum: 50,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
