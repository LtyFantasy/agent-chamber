/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/api-definition.md §16 (doc_routes 段), plan §4-B5 (意图路由结构化)
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（route create/update 在
 *     service 层——importBundle 内部调用；remove/recheck 在 controller 层决策 2；
 *     recheck 是空间级健康重检写，记 UPDATE + doc_space 轻量行）
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #21(双层校验) #22(findOne必须判空) #17(测试契约) #11(注释强制)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { DocRouteService } from './doc-route.service';
import { DocSpaceService } from './docspace.service';
import { RouteHealthService } from './route-health.service';
import { PermissionService } from '../../common/services/permission.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import { CreateDocRouteDto, UpdateDocRouteDto, QueryDocRouteDto } from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { AuditAction } from '@agent-chamber/shared';

/**
 * doc_routes 意图路由 Controller（v1.42 批次 B5）
 *
 * 路由设计（对齐 DocController 的"空前缀 + 方法级路径"惯例）：
 * - GET/POST  `doc-spaces/:id/routes`：空间维度入口，权限 = space read / space write（editor）
 * - PATCH/DELETE `doc-routes/:id`：路由实例入口，权限 = 所属空间 write（先查路由拿 spaceId）
 *
 * 双层校验边界：DTO 管格式（长度/UUID/边界），Service 管业务（doc 归属/headingPath/codeEntry）。
 */
@ApiTags('DocRoutes')
@Controller()
export class DocRouteController {
  constructor(
    private readonly routeService: DocRouteService,
    private readonly docSpaceService: DocSpaceService,
    private readonly routeHealthService: RouteHealthService,
    private readonly permService: PermissionService,
    private readonly auditService: AuditService,
  ) {}

  @UseGuards(JwtOrApiKeyGuard)
  @Get('doc-spaces/:id/routes')
  @ApiOperation({
    summary: 'List intent routes of a DocSpace',
    description:
      'List intent routes (doc_routes) of the space, sorted by sortOrder ASC then createdAt ASC. ' +
      'Requires read access to the space. ' +
      'Response shape depends on pagination params (v1.55): omitting page/pageSize returns the legacy ' +
      'full-array shape (capped at 1000 rows as runaway guard); passing page or pageSize switches to ' +
      'the standard paginated envelope {items,total,page,pageSize,totalPages,hasNext,hasPrev} ' +
      '(page default 1, pageSize default 20, max 100). ' +
      'Filters apply to both modes: q = ILIKE fuzzy match on intent, category = exact match.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Routes returned successfully' })
  @ApiResponse({ status: 400, description: 'Invalid pagination params (e.g. pageSize > 100)' })
  async findAll(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Query() query: QueryDocRouteDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');

    const filters = { q: query.q, category: query.category };
    // 分页模式触发条件：显式传 page 或 pageSize 任一项（DTO 已校验整数边界）；
    // 缺省页码/页大小对齐 docs 列表惯例（page=1、pageSize=20）
    if (query.page !== undefined || query.pageSize !== undefined) {
      return this.routeService.findPaged(spaceId, filters, query.page ?? 1, query.pageSize ?? 20);
    }
    // 传统全量模式：返回 DocRoute[] 数组（向后兼容 v1.42 契约）
    return this.routeService.findAll(spaceId, filters);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('doc-spaces/:id/routes/recheck')
  // 动作型端点（重检并覆写存量 health，不创建资源）：POST 默认 201 → 显式 200
  // （auth.controller 同款 @HttpCode 先例）
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recheck health of all intent routes in a space',
    description:
      'Manually trigger an async health recheck of every doc_routes row in the space ' +
      '(headingPath existence against current doc sections) and persist health jsonb. ' +
      'Requires write access to the space. Returns { rechecked, broken } counts. ' +
      'Deployment-time / post-curation fallback for the automatic setImmediate triggers.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Routes rechecked; counts returned' })
  async recheckRoutes(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    const result = await this.routeHealthService.recheckSpace(spaceId);
    // 审计（Phase 2）：UPDATE + doc_space（routes recheck——空间级健康重检写，
    // 覆写全部路由 health jsonb）；轻量 newData {spaceId, rechecked: true}
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE,
      entityId: spaceId,
      actorId: actor.id,
      newData: { spaceId, rechecked: true },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('doc-spaces/:id/routes')
  @ApiOperation({
    summary: 'Create an intent route',
    description:
      'Create an intent route in a DocSpace. Requires write access (creator or editor). ' +
      'Write-time validation: primary/secondary docs must exist and belong to the space ' +
      '(400 DOC_ROUTE_DOC_NOT_FOUND); non-empty headingPath must resolve exactly in the doc sections ' +
      '(400 DOC_ROUTE_HEADING_UNRESOLVED); codeEntry must be a relative path (400 DOC_ROUTE_INVALID_CODE_ENTRY).',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Route created successfully' })
  @ApiResponse({ status: 400, description: 'Write-time validation failed' })
  async create(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateDocRouteDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.routeService.create(spaceId, dto, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch('doc-routes/:id')
  @ApiOperation({
    summary: 'Update an intent route',
    description:
      'Partially update an intent route. Requires write access to the route\u2019s space. ' +
      'When primary/secondary doc or headingPath fields are changed, write-time validation re-runs ' +
      'against the merged view (400 on unresolvable refs).',
  })
  @ApiParam({ name: 'id', description: 'DocRoute ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Route updated successfully' })
  @ApiResponse({ status: 404, description: 'DOC_ROUTE_NOT_FOUND' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocRouteDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    // 先解析路由拿到所属空间，再按空间 write 权限放行（权限边界在 Controller，铁律 #21）
    const route = await this.routeService.findById(id);
    const space = await this.docSpaceService.findById(route.spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    // 审计在 service 层（update 有内部调用方 importRoutes，决策 2）；actor 从 controller 传入
    return this.routeService.update(id, dto, actor.id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete('doc-routes/:id')
  @ApiOperation({
    summary: 'Delete an intent route',
    description:
      'Hard-delete an intent route. Requires write access to the route\u2019s space. ' +
      'Deleting a route does not affect the referenced docs (bare-uuid links, no FK).',
  })
  @ApiParam({ name: 'id', description: 'DocRoute ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Route deleted successfully' })
  @ApiResponse({ status: 404, description: 'DOC_ROUTE_NOT_FOUND' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const route = await this.routeService.findById(id);
    const space = await this.docSpaceService.findById(route.spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    await this.routeService.remove(id);
    // 审计（Phase 2）：DELETE + doc_route；controller 层（remove 无 actor 参数，
    // 决策 2）；newData 白名单 {routeId, spaceId, intent}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.DOC_ROUTE,
      entityId: id,
      actorId: actor.id,
      newData: { routeId: id, spaceId: route.spaceId, intent: route.intent },
      source: 'api',
    });
    return { deleted: true };
  }
}
