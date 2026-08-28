/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.3 (Board / Task)
 *   - 补充: PROJECT.md §1.5.2 可见性继承规则
 *   - 任务分页: docs/api-definition.md §7（Boards/Tasks 分页与字段精简契约，v1.16.0）
 *   新增 GET /boards/:id/lists 与 /boards/:id/lists/:listId/tasks；findOne 不再返回 tasks。
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（board 写操作全量记，
 *     controller 层插桩决策 2——service 方法均无 actor 参数且仅 controller 调用；
 *     member 增删用 CREATE/DELETE + board_member；metrics 只记键名列表不入全量值）
 *
 * [踩坑索引] D5(权限迁移) B-51(admin-403显式检查) B-45(reorder返回null) B-41(列表页任务统计) B-50(列表权限过滤) OWNER-PROXY(update+成员4端点视同creator) TOPIC-PERM(update结构字段显式403替代静默剥离)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   TOPIC-PERM: v1.46 update 删除 v1.37 静默剥离分支（非 creator 解构 name/description，
 *       结构字段静默丢弃 → 200 装傻，前端编辑 dialog 恒带 visibility 全靠此兜底）。
 *       改为 DocSpace v1.45 同构：结构字段（topicId/visibility/invitedAgentIds）任一
 *       `!== undefined`（显式 null 也算）→ 非 creator/admin 整体 403 列字段名；
 *       前端 boards 列表页编辑按钮已门控 creator/admin 防 403 回归。
 *   BoardDetail 解耦 tasks: findOne 返回 lists 为 BoardListSummary[]（无 tasks 数组），
 *     任务列表通过 GET /boards/:id/lists/:listId/tasks 按列分页获取。
 *   B-51: 成员管理端点(invite/uninvite/editor)改用显式 isCreator 检查时遗漏 admin
 *         角色，导致 admin 返回 403。修复：显式检查中增加 isAdmin 判断。
 *         见 memory/2026-06-09.md §B-51
 *   D5: BoardController 权限检查从 Service 迁移到 Controller。
 *       findOne 拆分为 findById() + ensureCan() + enrich() 三步。
 *       Service 删除 canAccess()/effectiveVisibility()。见 memory/2026-06-05.md
 *   B-50: Topic/Board 列表接口在 Controller 层过滤，导致分页 total 与 items 不一致。
 *         修复：Controller.findAll 透传 actor 给 Service，由 Service 层 QueryBuilder 做
 *         IN 过滤，删除 PermissionService.filterBoards。见 Plan §2.3 / §2.4。
 *
 *   OWNER-PROXY: v1.37 update 的 isCreator 判定扩展 owner 代理（人类 owner 对其 agent
 *       创建的 board 视同 creator，允许全字段修改，而非 editor 的 name/description 限制）。
 *       v1.37 补漏：inviteAgent/uninviteAgent/addEditor/removeEditor 四端点同构扩展
 *       （评审 S1：此前漏接，前端已对 owner 展示成员管理入口 → 后端 403）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse } from '@nestjs/swagger';
import { BoardService } from './board.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import {
  CreateBoardDto,
  UpdateBoardDto,
  InviteBoardAgentDto,
  UninviteBoardAgentDto,
  AddBoardEditorDto,
  RemoveBoardEditorDto,
  CreateBoardListDto,
  ReorderBoardListsDto,
  UpdateBoardListDto,
  RemoveBoardListDto,
  ReorderTasksDto,
  FindListTasksQueryDto,
  QueryBoardDto,
  BoardDigestQueryDto,
  UpdateBoardMetricsDto,
} from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ErrorCode, UserRole, AuditAction } from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';

@ApiTags('Boards')
@Controller('boards')
export class BoardController {
  constructor(
    private readonly boardService: BoardService,
    private readonly permService: PermissionService,
    private readonly ownerProxy: OwnerProxyService,
    private readonly auditService: AuditService,
  ) {}

  @UseGuards(JwtOrApiKeyGuard)
  @Get()
  @ApiOperation({
    summary: 'List boards',
    description: 'List all boards with pagination and optional topic filter',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number', type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page (max 100)',
    type: Number,
  })
  @ApiQuery({ name: 'topicId', required: false, description: 'Filter by topic ID', type: String })
  @ApiResponse({ status: 200, description: 'Boards list returned successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed (e.g. pageSize exceeds 100)' })
  async findAll(@Query() query: QueryBoardDto, @CurrentActor() actor: UnifiedActor) {
    return this.boardService.findAll(query, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post()
  @ApiOperation({ summary: 'Create board', description: 'Create a new board' })
  @ApiResponse({ status: 201, description: 'Board created successfully' })
  async create(@CurrentActor() actor: UnifiedActor, @Body() dto: CreateBoardDto) {
    const result = await this.boardService.create(actor.id, actor.type, dto);
    // 审计（Phase 2）：CREATE + board；controller 层（create 无 actor 参数，决策 2）；
    // newData 白名单 {boardId, name, visibility?}（决策 6；description/settings 不入）。
    // result 为 reload 查询（findOne），防御性判空——创建已成功，reload 失败属异常
    if (result) {
      await this.auditService.log({
        action: AuditAction.CREATE,
        entityType: 'board',
        entityId: result.id,
        actorId: actor.id,
        newData: {
          boardId: result.id,
          name: result.name,
          ...(dto.visibility !== undefined && { visibility: dto.visibility }),
        },
        source: 'api',
      });
    }
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id')
  @ApiOperation({
    summary: 'Get board',
    description: 'Get board details by ID including lists metadata (without tasks).',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Board details returned successfully' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'read');
    // Batch 2: enrich() 现在包含 members[] 聚合，不再需要单独的 topic participant 查询
    return this.boardService.enrich(board);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/digest')
  @ApiOperation({
    summary: 'Get board digest',
    description:
      'Real-time assembled project overview (v1.41): task/milestone/docspace status digest, ' +
      'never stored. Replaces the manual PROJECT.md snapshot for session initialization. ' +
      'Includes the board description (legend) in full by default (pass includeDescription=false to omit). ' +
      'docs section permission semantics (contract-level decision): board readability implies ' +
      'readability of its bound DocSpace metadata — spaceName/spaceDescriptionSnippet/doc ' +
      'path+title+updatedAt, never document bodies; no DocSpace membership check is performed.',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiQuery({
    name: 'openLimit',
    required: false,
    description: 'Max nextUp items (default 10; 0 = empty)',
    type: Number,
  })
  @ApiQuery({
    name: 'doneLimit',
    required: false,
    description: 'Max recentDone items (default 5; 0 = empty)',
    type: Number,
  })
  @ApiQuery({
    name: 'riskLimit',
    required: false,
    description: 'Max risks items (default 10; 0 = empty)',
    type: Number,
  })
  @ApiQuery({
    name: 'docsLimit',
    required: false,
    description: 'Max docs.recentlyUpdated items (default 5; 0 = empty)',
    type: Number,
  })
  @ApiQuery({
    name: 'includeDescription',
    required: false,
    description:
      "Include the board description (legend). Default true; pass 'false' to set description to null.",
    type: Boolean,
  })
  @ApiResponse({ status: 200, description: 'Board digest returned successfully' })
  async getDigest(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: BoardDigestQueryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    // 权限复用 findOne 读路径：findById + ensureCan read（board 可读蕴含 docs 段元数据可读）
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'read');
    return this.boardService.getDigest(id, query);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/lists')
  @ApiOperation({
    summary: 'Get board lists',
    description: 'Get all list metadata under the board (excluding tasks)',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Lists returned successfully' })
  async findLists(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'read');
    return this.boardService.findLists(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Put(':id/metrics')
  @ApiOperation({
    summary: 'Update board metrics',
    description:
      'Store machine facts (test baselines, MCP tool counts, etc.) into ' +
      'board.settings.metrics (v1.42). Atomic jsonb_set merge — only the metrics key ' +
      'is touched; visibility and other settings keys are preserved. ' +
      'The only writer is scripts/report-metrics.mjs; digest exposes the same object ' +
      'as the metrics section.',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Board metrics updated successfully' })
  async updateMetrics(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBoardMetricsDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'write');
    const result = await this.boardService.updateMetrics(id, dto.metrics);
    // 审计（Phase 2）：UPDATE + board（metrics）；newData 只记更新的键名列表
    // （决策 6——metrics 全量值不入，机器事实可能含敏感基线）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: 'board',
      entityId: id,
      actorId: actor.id,
      newData: { boardId: id, metricsKeys: Object.keys(dto.metrics) },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/lists/:listId/tasks')
  @ApiOperation({
    summary: 'Get list tasks',
    description:
      'Get tasks in the specified list. Defaults to todo and in_progress; pass status=all to return all.',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiParam({ name: 'listId', description: 'List ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Tasks returned successfully' })
  async findListTasks(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('listId', ParseUUIDPipe) listId: string,
    @Query() query: FindListTasksQueryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'read');
    return this.boardService.findListTasks(id, listId, query, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch(':id')
  @ApiOperation({
    summary: 'Update board',
    description:
      'Update board by ID. Field-level permission split (v1.46 TOPIC-PERM, 对齐 DocSpace v1.45): ' +
      'content fields (name/description) require write access (creator, editor, owner-proxy, ' +
      'or admin); structural fields (topicId/visibility/invitedAgentIds) require creator (or ' +
      'admin). An editor request containing any structural field is rejected as a whole (403) ' +
      '— no partial application.',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Board updated successfully' })
  @ApiResponse({ status: 403, description: 'Structural fields require creator permission' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBoardDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'write');

    // D6（v1.46 TOPIC-PERM）：删除 v1.37 的静默剥离分支（非 creator 只解构 name/description，
    // 结构字段被静默丢弃 → 200 装傻），改为 DocSpace v1.45 同构的显式 403。
    // ⚠️ 结构字段存在性必须 `!== undefined`（显式 null 也算「出现」= 解绑语义）——
    // truthy 判断会漏掉 { topicId: null } 解绑请求，让 editor 绕过结构字段检查。
    const hasStructural =
      dto.topicId !== undefined ||
      dto.visibility !== undefined ||
      dto.invitedAgentIds !== undefined;
    if (hasStructural) {
      // v1.37 owner 代理：人类 owner 对其 agent 创建的 board 视同创建者（允许全字段修改）
      const isCreator =
        board.creatorId === actor.id ||
        (await this.ownerProxy.isOwnerProxy(board.creatorId, actor));
      const isAdmin = actor?.role === UserRole.ADMIN;
      if (!isCreator && !isAdmin) {
        // R1：403 消息列出实际出现的结构字段名（editor 请求含任一结构字段 → 整体 403，
        // 不做部分应用），agent 消费者可据消息自修正
        const presentStructural: string[] = [];
        if (dto.topicId !== undefined) presentStructural.push('topicId');
        if (dto.visibility !== undefined) presentStructural.push('visibility');
        if (dto.invitedAgentIds !== undefined) presentStructural.push('invitedAgentIds');
        throw new ForbiddenException({
          message: `Structural fields require creator permission: ${presentStructural.join(', ')}`,
          code: ErrorCode.PERMISSION_DENIED,
        });
      }
    }

    const result = await this.boardService.update(id, dto);
    // 审计（Phase 2）：UPDATE + board；controller 层（update 无 actor 参数，决策 2）；
    // newData 白名单 {boardId, name?, visibility?}（决策 6；description/settings 不入）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: 'board',
      entityId: id,
      actorId: actor.id,
      newData: {
        boardId: id,
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.visibility !== undefined && { visibility: dto.visibility }),
      },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete board', description: 'Delete board by ID' })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Board deleted successfully' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'delete');
    await this.boardService.remove(id);
    // 审计（Phase 2）：DELETE + board；newData 白名单 {boardId, name}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: 'board',
      entityId: id,
      actorId: actor.id,
      newData: { boardId: id, name: board.name },
      source: 'api',
    });
    return true;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/invite-agent')
  @ApiOperation({
    summary: 'Invite agent to board',
    description: 'Invite an agent to participate in a board',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Agent invited successfully' })
  async inviteAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteBoardAgentDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    // v1.37 owner 代理：人类 owner 对其 agent 创建的 board 视同创建者（与 update 同构）
    const isCreator =
      board.creatorId === actor.id || (await this.ownerProxy.isOwnerProxy(board.creatorId, actor));
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only board creator can manage members',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    const result = await this.boardService.inviteAgent(id, dto.agentId);
    // 审计（Phase 2）：CREATE + board_member（invite-agent）；controller 层
    // （inviteAgent 无 actor 参数，决策 2）；newData {boardId, actorId, role}
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: 'board_member',
      entityId: dto.agentId,
      actorId: actor.id,
      newData: { boardId: id, actorId: dto.agentId, role: 'member' },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/uninvite-agent')
  @ApiOperation({
    summary: 'Uninvite agent from board',
    description: 'Remove an agent invitation from a board',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Agent uninvited successfully' })
  async uninviteAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UninviteBoardAgentDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    // v1.37 owner 代理：人类 owner 对其 agent 创建的 board 视同创建者（与 update 同构）
    const isCreator =
      board.creatorId === actor.id || (await this.ownerProxy.isOwnerProxy(board.creatorId, actor));
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only board creator can manage members',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    const result = await this.boardService.uninviteAgent(id, dto.agentId);
    // 审计（Phase 2）：DELETE + board_member（uninvite-agent）
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: 'board_member',
      entityId: dto.agentId,
      actorId: actor.id,
      newData: { boardId: id, actorId: dto.agentId },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/add-editor')
  @ApiOperation({ summary: 'Add editor to board', description: 'Add an editor agent to a board' })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Editor added successfully' })
  async addEditor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddBoardEditorDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    // v1.37 owner 代理：人类 owner 对其 agent 创建的 board 视同创建者（与 update 同构）
    const isCreator =
      board.creatorId === actor.id || (await this.ownerProxy.isOwnerProxy(board.creatorId, actor));
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only board creator can manage editors',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    const result = await this.boardService.addEditor(id, dto.agentId);
    // 审计（Phase 2）：CREATE + board_member（add-editor——新建 editor 行或
    // member→editor 升级均属「授予 editor 角色」写入）
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: 'board_member',
      entityId: dto.agentId,
      actorId: actor.id,
      newData: { boardId: id, actorId: dto.agentId, role: 'editor' },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/remove-editor')
  @ApiOperation({
    summary: 'Remove editor from board',
    description: 'Remove an editor agent from a board',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Editor removed successfully' })
  async removeEditor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoveBoardEditorDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    // v1.37 owner 代理：人类 owner 对其 agent 创建的 board 视同创建者（与 update 同构）
    const isCreator =
      board.creatorId === actor.id || (await this.ownerProxy.isOwnerProxy(board.creatorId, actor));
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only board creator can manage editors',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    const result = await this.boardService.removeEditor(id, dto.agentId);
    // 审计（Phase 2）：DELETE + board_member（remove-editor）
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: 'board_member',
      entityId: dto.agentId,
      actorId: actor.id,
      newData: { boardId: id, actorId: dto.agentId },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/lists')
  @ApiOperation({ summary: 'Create list', description: 'Create a new list in a board' })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'List created successfully' })
  async createList(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateBoardListDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'write');
    const result = await this.boardService.createList(id, dto);
    // 审计（Phase 2）：CREATE + board_list；newData 白名单 {boardId, listId, name}
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: 'board_list',
      entityId: result.id,
      actorId: actor.id,
      newData: { boardId: id, listId: result.id, name: result.name },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/lists/reorder')
  @ApiOperation({ summary: 'Reorder lists', description: 'Reorder lists within a board' })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Lists reordered successfully' })
  async reorderLists(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderBoardListsDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'write');
    const result = await this.boardService.reorderLists(id, dto);
    // 审计（Phase 2）：UPDATE + board（lists reorder）；轻量 newData {boardId, listCount}
    // （决策 6——不记具体顺序，条目数即可）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: 'board',
      entityId: id,
      actorId: actor.id,
      newData: { boardId: id, listCount: dto.lists.length },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('lists/:id')
  @ApiOperation({ summary: 'Get list', description: 'Get list details by ID' })
  @ApiParam({ name: 'id', description: 'List ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'List details returned successfully' })
  async findList(@Param('id', ParseUUIDPipe) id: string) {
    return this.boardService.findList(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch('lists/:id')
  @ApiOperation({ summary: 'Update list', description: 'Update list by ID' })
  @ApiParam({ name: 'id', description: 'List ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'List updated successfully' })
  async updateList(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBoardListDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const list = await this.boardService.findList(id);
    const board = await this.boardService.findById(list.boardId);
    await this.permService.ensureCan(board, actor, 'write');
    const result = await this.boardService.updateList(id, dto);
    // 审计（Phase 2）：UPDATE + board_list；newData 白名单 {boardId, listId, name?}
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: 'board_list',
      entityId: id,
      actorId: actor.id,
      newData: {
        boardId: list.boardId,
        listId: id,
        ...(dto.name !== undefined && { name: dto.name }),
      },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete('lists/:id')
  @ApiOperation({
    summary: 'Delete list',
    description: 'Delete list by ID with optional task migration',
  })
  @ApiParam({ name: 'id', description: 'List ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'List deleted successfully' })
  async removeList(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoveBoardListDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const list = await this.boardService.findList(id);
    const board = await this.boardService.findById(list.boardId);
    await this.permService.ensureCan(board, actor, 'write');
    await this.boardService.removeList(id, dto?.moveTasksTo);
    // 审计（Phase 2）：DELETE + board_list；newData 白名单 {boardId, listId, name}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: 'board_list',
      entityId: id,
      actorId: actor.id,
      newData: { boardId: list.boardId, listId: id, name: list.name },
      source: 'api',
    });
    return true;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('lists/:id/reorder')
  @ApiOperation({ summary: 'Reorder tasks', description: 'Reorder tasks within a list' })
  @ApiParam({ name: 'id', description: 'List ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Tasks reordered successfully' })
  async reorderTasks(
    @Param('id', ParseUUIDPipe) listId: string,
    @Body() dto: ReorderTasksDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const list = await this.boardService.findList(listId);
    const board = await this.boardService.findById(list.boardId);
    await this.permService.ensureCan(board, actor, 'write');
    const result = await this.boardService.reorderTasks(listId, dto);
    // 审计（Phase 2）：UPDATE + board_list（tasks reorder）；轻量 newData
    // {boardId, listId, taskCount}（决策 6——不记具体顺序）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: 'board_list',
      entityId: listId,
      actorId: actor.id,
      newData: { boardId: list.boardId, listId, taskCount: dto.tasks.length },
      source: 'api',
    });
    return result;
  }
}
