import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MarkAsReadInput } from '@agent-chamber/shared';

/**
 * 标记话题消息为已读的请求 DTO
 * 不传 messageId 时，自动标记到该话题的最新消息
 */
export class MarkAsReadDto implements MarkAsReadInput {
  @ApiPropertyOptional({
    description: 'Message ID to mark as read up to; marks to latest message if omitted',
  })
  @IsOptional()
  @IsUUID()
  messageId?: string;
}
