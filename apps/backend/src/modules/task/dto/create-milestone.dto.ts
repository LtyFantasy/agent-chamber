import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsISO8601,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { MilestoneStatus, CreateMilestoneInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Release 版本号格式：`v?X.Y.Z(-suffix)?`，suffix 允许字母数字与 `.`/`-`（如 rc.1）。
 * 与 semver 主次补丁严格段对齐（不校验具体数值），-dev 后缀由调用方剥除（deploy 上报惯例）。
 */
export const MILESTONE_VERSION_REGEX = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;

export class CreateMilestoneDto implements CreateMilestoneInput {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @ApiProperty({ description: 'Name', example: 'TestAgent' })
  name: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Description', example: 'A description' })
  description?: string;

  @IsUUID()
  @ApiProperty({
    description: 'Associated board ID (required)',
    example: '550e8400-e29b-41d4-a716-446655440005',
  })
  boardId: string;

  @IsOptional()
  @IsEnum(MilestoneStatus)
  @ApiPropertyOptional({
    enum: Object.values(MilestoneStatus),
    description:
      'Milestone status. version 非空时缺省 dev、显式仅可 dev/ready；' +
      'version 为空时仅可普通四态：planned, active, completed, cancelled',
    example: MilestoneStatus.ACTIVE,
  })
  status?: MilestoneStatus;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({ description: 'Start date (ISO 8601)', example: '2024-01-01T00:00:00Z' })
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({ description: 'targetDate', example: '2024-12-31T00:00:00Z' })
  targetDate?: string;

  /**
   * Release 版本号（如 v1.42.0 / 1.42.0 / 1.42.0-rc.1）。
   * 非空 = Release 里程碑（status 缺省 dev，显式仅可 dev/ready，其余由 Service 400 拒绝）；
   * 同 board 内唯一（部分唯一索引），冲突由 Service 翻译为 409。
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(MILESTONE_VERSION_REGEX, {
    message: 'version must match v?X.Y.Z(-suffix)?, e.g. v1.42.0 or 1.42.0-rc.1',
  })
  @ApiPropertyOptional({
    description: 'Release version (v?X.Y.Z(-suffix)?), e.g. v1.42.0',
    example: 'v1.42.0',
  })
  version?: string;

  /**
   * Release 变更说明（Markdown 全文，cap 20000 字符；列表接口投影为 bodySnippet）。
   */
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  @ApiPropertyOptional({
    description: 'Release body (Markdown, max 20000 chars)',
    example: '## 变更',
  })
  body?: string;
}
