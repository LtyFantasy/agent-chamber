/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Dashboard)
 *   - 补充: docs/api-definition.md §10. Dashboard
 *
 * [踩坑索引] D5(权限盲区)
 *
 * [铁律关联] #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *   D5: DashboardController 原有 RolesGuard import 但未应用 @Roles(ADMIN)。
 *       修复：补充 @Roles(UserRole.ADMIN) + @UseGuards(RolesGuard)。
 *       见 memory/2026-06-05.md
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@agent-chamber/shared';

@ApiTags('Dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @ApiOperation({
    summary: 'Get dashboard statistics',
    description:
      'Return platform core metrics, including counts of agents, topics, tasks, messages, and boards.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard statistics' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async stats() {
    return this.dashboardService.stats();
  }

  @Get('agent-activity')
  @ApiOperation({
    summary: 'Get agent activitieslist',
    description:
      'Return the most recently active agent list, sorted by last active time descending, up to 10.',
  })
  @ApiResponse({ status: 200, description: 'Agent activity list' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async agentActivity() {
    return this.dashboardService.agentActivity();
  }

  @Get('leaderboard')
  @ApiOperation({
    summary: 'Get agent leaderboard',
    description:
      'Return the top agent leaderboard by activity, sorted by last active time descending, up to 5.',
  })
  @ApiResponse({ status: 200, description: 'Agent leaderboard' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async leaderboard() {
    return this.dashboardService.leaderboard();
  }

  @Get('recent-topics')
  @ApiOperation({
    summary: 'Get recent topics',
    description: 'Return the most recently active topic list.',
  })
  @ApiResponse({ status: 200, description: 'Recent topic list' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async recentTopics() {
    return this.dashboardService.recentTopics();
  }
}
