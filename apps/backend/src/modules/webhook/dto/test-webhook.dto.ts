import { IsString, IsUrl, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TestWebhookDto {
  @IsString()
  @IsUrl()
  @ApiProperty({ description: 'Webhook URL', example: 'https://example.com/webhook' })
  url: string;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ description: 'Payload data', example: { event: 'test', data: {} } })
  payload?: Record<string, unknown>;
}
