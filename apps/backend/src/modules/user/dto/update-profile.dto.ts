import { IsOptional, IsObject, IsString, MinLength, MaxLength, IsUrl } from 'class-validator';
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
  // 显式 type：`string | null` 联合类型经 reflect-metadata 推成 Object，仅给 nullable 不足以
  // 修正（Swagger/automcp 仍输出 type:object，MCP 通道传字符串必 400；守卫见 swagger-schema.spec.ts）
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Avatar URL; pass null to clear the avatar and cascade-clear avatar_svg',
    example: 'https://example.com/avatar.png',
  })
  avatar?: string | null;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ description: 'Preferences', example: { theme: 'dark', language: 'zh' } })
  preferences?: Record<string, unknown>;
}
