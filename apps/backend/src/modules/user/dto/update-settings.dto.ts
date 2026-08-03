import { IsOptional, IsString, IsBoolean } from 'class-validator';
import { UpdateSettingsInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSettingsDto implements UpdateSettingsInput {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Subject', example: 'dark' })
  theme?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Language', example: 'zh-CN' })
  language?: string;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Email notifications', example: true })
  emailNotifications?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Push notifications', example: true })
  pushNotifications?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Notification toggles', example: true })
  notifications?: boolean;
}
