import { IsOptional, IsString, MinLength, MaxLength, IsUrl } from 'class-validator';
import { UpdateProfileInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto implements UpdateProfileInput {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @ApiPropertyOptional({ description: 'Name', example: 'TestAgent' })
  name?: string;

  @IsOptional()
  @IsUrl()
  @ApiPropertyOptional({
    description: 'Avatar URL; pass null to clear the avatar and cascade-clear avatar_svg',
    example: 'https://example.com/avatar.png',
    nullable: true,
  })
  avatar?: string | null;

  @IsOptional()
  @ApiPropertyOptional({ description: 'Preferences', example: { theme: 'dark', language: 'zh' } })
  preferences?: Record<string, unknown>;
}
