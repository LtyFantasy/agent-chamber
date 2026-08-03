/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.3 (Board / Task)
 *   - 补充: PROJECT.md §1.5.2 可见性继承规则
 *   - 任务分页: docs/api-definition.md §7（Boards/Tasks 分页与字段精简契约，v1.16.0）
 *   新增 GET /boards/:id/lists 与 /boards/:id/lists/:listId/tasks；findOne 不再返回 tasks。
 *
 * [踩坑索引] D5(权限迁移) B-51(admin-403显式检查) B-45(reorder返回null) B-41(列表页任务统计) B-50(列表权限过滤) OWNER-PROXY(update+成员4端点视同creator)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
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
} from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ErrorCode, UserRole } from '@agent-chamber/shared';

@ApiTags('Boards')
@Controller('boards')
export class BoardController {
  constructor(
    private readonly boardService: BoardService,
    private readonly permService: PermissionService,
    private readonly ownerProxy: OwnerProxyService,
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
    return this.boardService.create(actor.id, actor.type, dto);
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
    description: 'Update board by ID. Editors can only modify name and description.',
  })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Board updated successfully' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBoardDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'write');

    // v1.37 owner 代理：人类 owner 对其 agent 创建的 board 视同创建者（允许全字段修改）
    const isCreator =
      board.creatorId === actor.id || (await this.ownerProxy.isOwnerProxy(board.creatorId, actor));
    if (!isCreator) {
      // editor 只允许修改 name/description
      const { name, description } = dto;
      return this.boardService.update(id, { name, description } as UpdateBoardDto);
    }

    return this.boardService.update(id, dto);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete board', description: 'Delete board by ID' })
  @ApiParam({ name: 'id', description: 'Board ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Board deleted successfully' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const board = await this.boardService.findById(id);
    await this.permService.ensureCan(board, actor, 'delete');
    return this.boardService.remove(id);
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
    return this.boardService.inviteAgent(id, dto.agentId);
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
    return this.boardService.uninviteAgent(id, dto.agentId);
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
    return this.boardService.addEditor(id, dto.agentId);
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
    return this.boardService.removeEditor(id, dto.agentId);
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
    return this.boardService.createList(id, dto);
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
    return this.boardService.reorderLists(id, dto);
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
    return this.boardService.updateList(id, dto);
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
    return this.boardService.removeList(id, dto?.moveTasksTo);
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
    return this.boardService.reorderTasks(listId, dto);
  }
}
