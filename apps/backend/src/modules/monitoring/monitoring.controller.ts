/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.8 (运维与观测)
 *   - 补充: docs/api-definition.md §Monitoring
 *
 * [踩坑索引] B-50(api-logs列表越权)
 *
 * [铁律关联] #9(代理层透传) #17(测试契约) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   B-50: GET /system/api-logs 与 /system/api-logs/export 仅 JWT 认证，无角色过滤，
 *          任何登录用户都可查看/导出全平台 API 日志。修复：Controller 类级别添加
 *          @UseGuards(JwtAuthGuard, RolesGuard) + @Roles(ADMIN)，与 /audit 保持一致，
 *          Service 签名不变。见 Plan §5。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { MonitoringService } from './monitoring.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@agent-chamber/shared';
import { ApiLogQueryDto } from './dto/api-log-query.dto';

@ApiTags('Monitoring')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('system')
export class MonitoringController {
  constructor(private readonly monitoringService: MonitoringService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'System overview',
    description:
      'Read-only operational overview aggregated from existing tables (runners / seats / events / webhooks); no instrumentation; admin only',
  })
  @ApiResponse({ status: 200, description: 'System overview (SystemOverview DTO)' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async getOverview() {
    return this.monitoringService.getOverview();
  }

  @Get('api-logs')
  @ApiOperation({
    summary: 'List API call logs',
    description: 'Paginated list of API call logs with time-range filtering; admin only',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number, minimum 1',
    type: Number,
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page, range 1–100',
    type: Number,
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Start date (ISO 8601 format)',
    type: String,
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'End date (ISO 8601 format)',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'Paginated list of API call logs' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async getApiLogs(@Query() query: ApiLogQueryDto) {
    return this.monitoringService.getApiLogs(query);
  }

  @Get('api-logs/export')
  @ApiOperation({
    summary: 'Export API logs',
    description: 'Export API log data (up to 1000 entries) as JSON; admin only',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number, minimum 1',
    type: Number,
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page, range 1–100',
    type: Number,
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Start date (ISO 8601 format)',
    type: String,
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'End date (ISO 8601 format)',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'Exported API log data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async exportApiLogs(@Query() query: ApiLogQueryDto) {
    return this.monitoringService.exportApiLogs(query);
  }
}
