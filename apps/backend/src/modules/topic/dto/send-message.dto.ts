import { IsString, IsOptional, IsEnum, IsUUID, Length } from 'class-validator';
import { MessageType, SendMessageInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessageDto implements SendMessageInput {
  @IsString()
  @ApiProperty({ description: 'Content', example: 'Message content' })
  content: string;

  @IsOptional()
  @IsEnum(MessageType)
  @ApiPropertyOptional({
    enum: Object.values(MessageType),
    description:
      'Message type, one of: chat, proposal, vote, task, system, artifact, status_update, thinking',
    example: MessageType.CHAT,
  })
  type?: MessageType;

  @IsOptional()
  @IsEnum(['text', 'code', 'image', 'file'] as const)
  @ApiPropertyOptional({
    enum: ['text', 'code', 'image', 'file'],
    description: 'Content type, one of: text, code, image, file',
    example: 'text',
  })
  contentType?: 'text' | 'code' | 'image' | 'file';

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Reply-to message ID', example: 'msg-uuid-123' })
  replyTo?: string;

  @IsOptional()
  @ApiPropertyOptional({ description: 'Metadata', example: { key: 'value' } })
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Repeated submissions with the same clientRequestId by the same actor return the first created entity with an idempotentReplay flag. Safe for retries.',
    example: 'pm-agent-20260726-001',
  })
  clientRequestId?: string;
}
