/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (W2 空间/分类/成员 API)

 * [踩坑索引] (无历史踩坑，新建文件) OWNER-PROXY(六处creator硬校验)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #21(双层校验) #22(findOne必须判空)
 *
 *   OWNER-PROXY: v1.37 六处 isCreator 硬校验（update/remove/invite/uninvite/add-editor/
 *       remove-editor）扩展 owner 代理判定（isCreatorOf），人类 owner 对其 agent 创建的
 *       space 视同 creator 全通。
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
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse } from '@nestjs/swagger';
import { DocSpaceService } from './docspace.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { BoardService } from '../board/board.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import {
  CreateDocSpaceDto,
  UpdateDocSpaceDto,
  QueryDocSpaceDto,
  CreateDocCategoryDto,
  InviteDocSpaceAgentDto,
  UninviteDocSpaceAgentDto,
  AddDocSpaceEditorDto,
  RemoveDocSpaceEditorDto,
  DocOverviewQueryDto,
} from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { ErrorCode, UserRole } from '@agent-chamber/shared';

@ApiTags('DocSpaces')
@Controller('doc-spaces')
export class DocSpaceController {
  constructor(
    private readonly docSpaceService: DocSpaceService,
    private readonly boardService: BoardService,
    private readonly permService: PermissionService,
    private readonly ownerProxy: OwnerProxyService,
  ) {}

  /**
   * 判定 actor 是否空间创建者（v1.37 owner 代理：人类 owner 对其 agent 创建的
   * space 视同 creator，读/写/删/成员管理全通）
   */
  private async isCreatorOf(space: DocSpace, actor: UnifiedActor | null): Promise<boolean> {
    if (!actor) return false;
    if (space.creatorId === actor.id) return true;
    return this.ownerProxy.isOwnerProxy(space.creatorId, actor);
  }

  // ─── Space CRUD ─────────────────────────────────────────────

  @UseGuards(JwtOrApiKeyGuard)
  @Post()
  @ApiOperation({
    summary: 'Create a DocSpace',
    description:
      'Create a new DocSpace. topicId and boardId are mutually exclusive (provide at most one). ' +
      'If boardId is given, the actor must have read access to the board.',
  })
  @ApiResponse({ status: 201, description: 'DocSpace created successfully' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (e.g. both topicId and boardId provided)',
  })
  async create(@CurrentActor() actor: UnifiedActor, @Body() dto: CreateDocSpaceDto) {
    // Mutual exclusivity check (validation layer only catches both via class-validator;
    // service also guards, but controller-level check gives nicer error for edge case)
    if (dto.topicId && dto.boardId) {
      throw new ForbiddenException({
        message: 'topicId and boardId are mutually exclusive',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // If boardId is provided, verify board exists + actor has read access
    if (dto.boardId) {
      const board = await this.boardService.findById(dto.boardId);
      await this.permService.ensureCan(board, actor, 'read');
    }

    return this.docSpaceService.create(actor, dto);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get()
  @ApiOperation({
    summary: 'List DocSpaces',
    description: 'List all DocSpaces with pagination and optional boardId/topicId filter.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number', type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page (max 100)',
    type: Number,
  })
  @ApiQuery({
    name: 'boardId',
    required: false,
    description: 'Filter by bound board ID',
    type: String,
  })
  @ApiQuery({
    name: 'topicId',
    required: false,
    description: 'Filter by bound topic ID',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'DocSpaces list returned successfully' })
  async findAll(@Query() query: QueryDocSpaceDto, @CurrentActor() actor: UnifiedActor) {
    return this.docSpaceService.findAll(query, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id')
  @ApiOperation({
    summary: 'Get DocSpace detail',
    description:
      'Get DocSpace details by ID including members, categories, binding info, and docCount. ' +
      'Private spaces return 404 for unauthorized actors.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'DocSpace details returned successfully' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const space = await this.docSpaceService.findById(id);
    await this.permService.ensureCan(space, actor, 'read');
    return this.docSpaceService.enrich(space);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch(':id')
  @ApiOperation({
    summary: 'Update DocSpace',
    description: 'Update DocSpace by ID. Only the creator can update.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'DocSpace updated successfully' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocSpaceDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);

    // Only creator (or admin) can update
    const isCreator = await this.isCreatorOf(space, actor);
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only the space creator can update',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    // If boardId is being set, validate board access
    if (dto.boardId) {
      const board = await this.boardService.findById(dto.boardId);
      await this.permService.ensureCan(board, actor, 'read');
    }

    return this.docSpaceService.update(id, dto);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete DocSpace',
    description:
      'Delete a DocSpace by ID. Only the creator can delete. Cascade soft-deletes all docs and sections. ' +
      'Returns docCount and linkedTaskCount for frontend confirmation.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'DocSpace deleted successfully with reference counts' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const space = await this.docSpaceService.findById(id);

    const isCreator = await this.isCreatorOf(space, actor);
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only the space creator can delete',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    return this.docSpaceService.remove(id, actor);
  }

  // ─── Members ────────────────────────────────────────────────

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/invite-agent')
  @ApiOperation({
    summary: 'Invite agent to DocSpace',
    description: 'Invite an agent to participate in a DocSpace. Creator-only.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Agent invited successfully' })
  async inviteAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteDocSpaceAgentDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);
    const isCreator = await this.isCreatorOf(space, actor);
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only space creator can manage members',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    return this.docSpaceService.inviteAgent(id, dto.agentId);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/uninvite-agent')
  @ApiOperation({
    summary: 'Uninvite agent from DocSpace',
    description: 'Remove an agent invitation from a DocSpace. Creator-only.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Agent uninvited successfully' })
  async uninviteAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UninviteDocSpaceAgentDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);
    const isCreator = await this.isCreatorOf(space, actor);
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only space creator can manage members',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    return this.docSpaceService.uninviteAgent(id, dto.agentId);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/add-editor')
  @ApiOperation({
    summary: 'Add editor to DocSpace',
    description: 'Add an editor agent to a DocSpace. Creator-only.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Editor added successfully' })
  async addEditor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddDocSpaceEditorDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);
    const isCreator = await this.isCreatorOf(space, actor);
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only space creator can manage editors',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    return this.docSpaceService.addEditor(id, dto.agentId);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/remove-editor')
  @ApiOperation({
    summary: 'Remove editor from DocSpace',
    description: 'Demote an editor to member in a DocSpace. Creator-only.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Editor removed successfully' })
  async removeEditor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoveDocSpaceEditorDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);
    const isCreator = await this.isCreatorOf(space, actor);
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only space creator can manage editors',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    return this.docSpaceService.removeEditor(id, dto.agentId);
  }

  // ─── Categories ─────────────────────────────────────────────

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/categories')
  @ApiOperation({
    summary: 'Create a category',
    description: 'Create a category in a DocSpace. Requires write access (creator or editor).',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Category created successfully' })
  @ApiResponse({ status: 409, description: 'Category slug already exists in this space' })
  async createCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDocCategoryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docSpaceService.createCategory(id, dto);
  }

  // ─── Overview ───────────────────────────────────────────────

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/overview')
  @ApiOperation({
    summary: 'Get DocSpace overview',
    description:
      'Return a compact overview map: categories (sorted by sortOrder) → docs[{path,title,summary,docType,tags,tokenEstimate}] ' +
      '+ uncategorized docs. Total token estimate is capped at ~4000 (overridable via maxTokens, 500–16000); ' +
      'if exceeded, truncation sets `truncated:true`. ' +
      'Configurable filters (v1.38): type/excludeType/category/excludeCategory (comma-separated, include+exclude = ' +
      'include-then-exclude intersection), tag, pathPrefix, applySpaceDefaults=false ignores space-level default ' +
      'filters (settings.overviewFilter). Response echoes the effective filters as `appliedFilters`.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Overview returned successfully' })
  async getOverview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DocOverviewQueryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);
    await this.permService.ensureCan(space, actor, 'read');
    return this.docSpaceService.getOverview(id, query);
  }
}
