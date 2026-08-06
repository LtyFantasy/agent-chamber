import { IsOptional, IsObject, IsString, IsArray, IsISO8601, MaxLength } from 'class-validator';
import { MarkMilestoneDeployedInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 部署里程碑请求体（POST /tasks/milestones/:id/deployed）——全可选，热修重部署幂等：
 * 只覆盖 payload 中显式提供的字段，deployMeta 与既有值合并写入。
 * deployMeta/deployedAt/verifiedAt 三个字段永远不可经本 DTO 写入（未声明 → 全局
 * ValidationPipe whitelist + forbidNonWhitelisted 直接 400 拦截）：部署事实的唯一写口
 * 是部署端点本身，客户端不能伪造部署记录（设计原则「每个事实有且只有一个写入者」）。
 */
export class MarkMilestoneDeployedDto implements MarkMilestoneDeployedInput {
  /** 部署锚点（health ok / web ok / migration 防呆结果等），对象透传不加工 */
  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({ description: 'Deployment anchors (object)', example: { health: 'ok' } })
  anchors?: Record<string, unknown>;

  /** 部署前备份文件名 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ description: 'Backup file name (max 500 chars)' })
  backup?: string;

  /** 本次执行的 migration 名称清单 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({
    description: 'Migrations executed in this deployment',
    example: ['AddMilestoneReleaseFields1785949186866'],
  })
  migrations?: string[];

  /** 部署时间（ISO 8601），缺省 = 服务器当前时间 */
  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({ description: 'Deployed at (ISO 8601), defaults to now' })
  deployedAt?: string;
}
