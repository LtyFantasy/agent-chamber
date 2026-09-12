import { IsString, IsOptional, IsEnum, IsUUID, Length, ArrayMaxSize } from 'class-validator';
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

  /**
   * 附件 ID 列表（≤9；MinIO 媒体附件 P0，plan §4.1 契约最小改动）。
   * 服务端校验：全部存在 + 上传者=发送者 + 绑定本 topic；
   * 通过后服务端覆盖写 metadata.attachments 索引（客户端自传的该键不被信任）。
   */
  @IsOptional()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(9)
  @ApiPropertyOptional({
    description:
      'Attachment IDs (max 9, UUID v4). All must exist, be uploaded by the sender, and be bound to this topic.',
    example: ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
  })
  attachmentIds?: string[];

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
