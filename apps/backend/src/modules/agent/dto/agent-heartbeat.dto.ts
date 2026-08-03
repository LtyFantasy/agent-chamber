import { IsString, IsOptional, IsNumber } from 'class-validator';
import { AgentHeartbeatInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AgentHeartbeatDto implements AgentHeartbeatInput {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Status', example: 'active' })
  status?: string;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Payload value', example: 1 })
  load?: number;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Version number', example: '1.0.0' })
  version?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Timestamp', example: '2024-06-30T00:00:00Z' })
  timestamp?: string;
}
