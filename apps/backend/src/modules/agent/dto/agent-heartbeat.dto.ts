import { IsString, IsOptional, IsNumber, IsEnum, IsISO8601, IsObject } from 'class-validator';
import { AgentHeartbeatInput, AgentStatus } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * POST /agents/:id/heartbeat 请求体（plan plastic-man-wonder-man-raven.md §1）
 *
 * 全部字段可选（全列快照 upsert：省略字段被有意清空）；
 * status 走 @IsEnum（值域 = AgentStatus，非法值由全局 ValidationPipe 拦 400，
 * 不落数据库 22P02）；timestamp 走 @IsISO8601（非法字符串防 PG 22007→500）。
 * 服务层语义：status 省略回退 agent 当前 status；timestamp 省略 = now()；
 * lastError 非空时同步写 lastErrorAt = timestamp；load/version 折叠进 meta。
 */
export class AgentHeartbeatDto implements AgentHeartbeatInput {
  @IsOptional()
  @IsEnum(AgentStatus)
  @ApiPropertyOptional({
    description: 'Status（省略回退 agent 当前 status）',
    example: AgentStatus.ACTIVE,
    enum: AgentStatus,
  })
  status?: AgentStatus;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Payload value（折叠进 meta.load）', example: 1 })
  load?: number;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Version number（折叠进 meta.version）', example: '1.0.0' })
  version?: string;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({
    description: '上报时刻（ISO 8601；省略 = now()）',
    example: '2024-06-30T00:00:00Z',
  })
  timestamp?: string;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Latency in milliseconds', example: 12 })
  latencyMs?: number;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Memory usage in MB', example: 256 })
  memoryMb?: number;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'CPU percent (0~100)', example: 3.5 })
  cpuPercent?: number;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Active task count', example: 1 })
  activeTasks?: number;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Queue depth', example: 0 })
  queueDepth?: number;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Processed events (cumulative)', example: 10 })
  processedEvents?: number;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Error count (cumulative)', example: 0 })
  errorCount?: number;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: '最近错误信息；非空时服务端同步写 lastErrorAt = timestamp',
    example: 'upstream timeout',
  })
  lastError?: string;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({
    description: '扩展元数据（load/version 折叠进本字段共存）',
    example: { region: 'cn' },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta?: Record<string, any>;
}
