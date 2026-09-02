/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md Audit 节
 *   - 补充: plan shadowcat-sunspot-catwoman.md（活动日志系统，Phase 1 查询 API）
 *
 * [踩坑索引] GUARD(全局APP_GUARD是JwtAuthGuard，方法级必须显式覆盖)
 *
 * [铁律关联] #9(代理层透传) #21(双层校验) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   GUARD: 全局 APP_GUARD 是 JwtAuthGuard（B-59 起对 X-API-Key 头做真实 API Key
 *          认证：成功挂 request.agent、失败 401，不再「放行不认证」），
 *          @Roles(ADMIN) 若留在类级，RolesGuard 会拦截方法级 JwtOrApiKeyGuard
 *          认证通过的 agent 请求（403）。类级 guard 与角色声明一律下沉到方法级：
 *          GET /activity-logs 只挂 JwtOrApiKeyGuard，GET /audit 才挂
 *          JwtAuthGuard+RolesGuard+@Roles(ADMIN)。
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UserRole } from '@agent-chamber/shared';
import { UnifiedActor } from '../../common/types/actor.types';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';

/**
 * GET /activity-logs — 活动日志查询（三层权限，活动日志系统主入口）
 *
 * 权限语义见 AuditService.findScoped：agent 只见自己；human 非 admin 见
 * 自己 + 名下 agent（含软删）；admin 全量（含 actorId=null 系统行）。
 * 越权 actorId 收窄不 403，响应 scope 字段回声实际生效范围。
 * 注意：全局 APP_GUARD 是 JwtAuthGuard（B-59 起对 X-API-Key 做真实认证并挂
 * request.agent），此处方法级 @UseGuards(JwtOrApiKeyGuard) 仍是双通道认证
 * （JWT 优先、API Key 兜底；全局 guard 已认证时二次认证幂等，语义不变）。
 * 路径注意：@Controller() 根路径 + 方法路径精确声明（NestJS 方法级 leading
 * slash 不会忽略 controller 前缀——concatPaths 恒拼接，实证 RoutePathFactory），
 * 故 /activity-logs 与 /audit 均为顶层路径。
 */
@ApiTags('Audit')
@Controller()
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('activity-logs')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'List activity logs (scoped)',
    description:
      'Paginated activity log query with three-layer permission scoping: ' +
      'agent → self only; human non-admin → self + owned agents (incl. soft-deleted); ' +
      'admin → all (incl. actorId=null system rows). Out-of-scope actorId is narrowed, ' +
      'not 403; response carries a scope echo field.',
  })
  @ApiQuery({
    name: 'actorId',
    required: false,
    description: 'Filter by actor ID; out-of-scope values are narrowed to the caller scope',
  })
  @ApiQuery({
    name: 'entityType',
    required: false,
    description: 'Entity type (task/topic/message/doc/…)',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    description: 'Action (AuditAction enum value)',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Start time (ISO 8601 with timezone, inclusive)',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'End time (ISO 8601 with timezone, inclusive)',
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
  @ApiResponse({ status: 200, description: 'Paginated activity logs with scope echo' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async findActivityLogs(@Query() query: AuditLogQueryDto, @CurrentActor() actor: UnifiedActor) {
    return this.auditService.findScoped(query, actor);
  }

  /**
   * GET /audit — 系统审计日志（admin-only 兼容壳）
   *
   * 保留既有 admin 语义，转调同一 findScoped（admin 无 scope 限制，
   * 顺带获得过滤参数）；响应兼容原分页结构，新增 scope=null 回声字段。
   */
  @Get('audit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'List audit logs',
    description: 'Paginated list of system audit logs; admin only',
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
  @ApiResponse({ status: 200, description: 'Paginated list of audit logs' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async findAll(@Query() query: AuditLogQueryDto, @CurrentActor() actor: UnifiedActor) {
    return this.auditService.findScoped(query, actor);
  }
}
