import { IsString, IsOptional, IsArray, IsEnum, ValidateNested, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { AgentStatus, AgentConfigInput, UpdateAgentInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

class AgentConfigDto implements AgentConfigInput {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Model name', example: 'gpt-4o' })
  model?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Temperature parameter', example: '0.7' })
  temperature?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Max tokens', example: '4096' })
  maxTokens?: string;

  @IsOptional()
  @ApiPropertyOptional({ description: 'Custom parameters', example: { provider: 'openai' } })
  customParams?: Record<string, unknown>;
}

export class UpdateAgentDto implements UpdateAgentInput {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Name', example: 'TestAgent' })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ApiPropertyOptional({ description: 'Description', example: 'A description' })
  description?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'System prompt', example: 'You are a helpful assistant' })
  systemPrompt?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({ description: 'Capabilities', example: ['code_review', 'testing'] })
  capabilities?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentConfigDto)
  @ApiPropertyOptional({ description: 'Configuration', example: { model: 'gpt-4o' } })
  config?: AgentConfigDto;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Avatar URL; pass null to clear the avatar and cascade-clear avatar_svg',
    example: 'https://example.com/avatar.png',
    nullable: true,
  })
  avatar?: string | null;

  @IsOptional()
  @IsEnum(AgentStatus)
  @ApiPropertyOptional({
    enum: Object.values(AgentStatus),
    description: 'Agent status, one of: active, disabled, pending',
    example: AgentStatus.ACTIVE,
  })
  status?: AgentStatus;
}
