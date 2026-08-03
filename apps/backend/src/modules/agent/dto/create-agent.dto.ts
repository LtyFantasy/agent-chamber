import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsUrl,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AgentConfigInput, CreateAgentInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

export class CreateAgentDto implements CreateAgentInput {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @ApiProperty({ description: 'Name', example: 'TestAgent' })
  name: string;

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
  @IsUrl()
  @ApiPropertyOptional({ description: 'Avatar URL', example: 'https://example.com/avatar.png' })
  avatar?: string;
}
