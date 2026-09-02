/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (W2 空间/分类/成员 API)
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（space/member 写操作
 *     controller 层插桩决策 2——service 方法均无 actor 参数且仅 controller 调用；
 *     createCategory 在 service 层（importBundle 内部调用）；importBundle 不单独记
 *     （批量回导，构成写各自落行）；entityType=doc_space/doc_space_member）
 *
 * [踩坑索引] OWNER-PROXY(creator硬校验+owner代理) DOCSPACE-PERM(update字段级分权+creator转让)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #21(双层校验) #22(findOne必须判空)
 *
 *   OWNER-PROXY: v1.37 creator 硬校验（delete/invite/uninvite/add-editor/remove-editor/
 *       transfer-creator）扩展 owner 代理判定（isCreatorOf），人类 owner 对其 agent 创建的
 *       space 视同 creator 全通。
 *   DOCSPACE-PERM: v1.45 update() 不再是纯 creator-only——字段级分权：内容字段
 *       （name/description/overviewFilter）走 policy write（editor 可），结构字段
 *       （visibility/topicId/boardId）creator-only。结构字段存在性判断必须 `!== undefined`
 *       （显式 null = 解绑语义也算出现），403 消息列出具体字段名（R1）。
 *       新端点 POST :id/transfer-creator（creator-only，干净交接，见 service 注释）。
 *   VALIDATION-400: 互斥参数同传（topicId+boardId）是请求格式错误，必须 400
 *       VALIDATION_ERROR——历史上本文件误用 403 Forbidden + RESOURCE_CONFLICT
 *       （2026-08-09 修复 edad7a9）。403 只留给真实权限拒绝。
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
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ParseBoolPipe,
  ForbiddenException,
  BadRequestException,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse } from '@nestjs/swagger';
import { DocSpaceService } from './docspace.service';
import { DocBundleService } from './doc-bundle.service';
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
  TransferCreatorDto,
  DocOverviewQueryDto,
  RepoManifestDto,
  ImportDocBundleDto,
} from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { ErrorCode, UserRole, AuditAction } from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';

@ApiTags('DocSpaces')
@Controller('doc-spaces')
export class DocSpaceController {
  constructor(
    private readonly docSpaceService: DocSpaceService,
    private readonly docBundleService: DocBundleService,
    private readonly boardService: BoardService,
    private readonly permService: PermissionService,
    private readonly ownerProxy: OwnerProxyService,
    private readonly auditService: AuditService,
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
      throw new BadRequestException({
        message: 'topicId and boardId are mutually exclusive',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    // If boardId is provided, verify board exists + actor has read access
    if (dto.boardId) {
      const board = await this.boardService.findById(dto.boardId);
      await this.permService.ensureCan(board, actor, 'read');
    }

    const result = await this.docSpaceService.create(actor, dto);
    // 审计（Phase 2）：CREATE + doc_space；controller 层（create 无 actor 参数，
    // 决策 2）；newData 白名单 {spaceId, name}（决策 6——description/settings 不入）
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE,
      entityId: result.id,
      actorId: actor.id,
      newData: { spaceId: result.id, name: result.name },
      source: 'api',
    });
    return result;
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
    description:
      'Update DocSpace by ID. Field-level permission split (v1.45 DOCSPACE-PERM): ' +
      'content fields (name/description/overviewFilter) require write access ' +
      '(creator, editor, owner-proxy, or admin); structural fields ' +
      '(visibility/topicId/boardId) require creator (or admin). ' +
      'An editor request containing any structural field is rejected as a whole (403) ' +
      '— no partial application.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'DocSpace updated successfully' })
  @ApiResponse({
    status: 403,
    description: 'Structural fields require creator permission (PERMISSION_DENIED)',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocSpaceDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);
    const isAdmin = actor?.role === UserRole.ADMIN;

    // 字段级分权（D1）：内容字段（name/description/overviewFilter）走 policy write——
    // permService.ensureCan 全覆盖 creator/editor/owner-proxy/admin，不自造 isCreatorOrEditor
    // 判断（实现收敛）；结构字段（visibility/topicId/boardId）creator-only。
    // ⚠️ 结构字段存在性必须 `!== undefined`（显式 null 也算「出现」= 解绑语义）——
    // truthy 判断会漏掉 { visibility: null } 解绑请求，让 editor 绕过结构字段检查。
    const hasStructural =
      dto.visibility !== undefined || dto.topicId !== undefined || dto.boardId !== undefined;
    if (hasStructural) {
      const isCreator = await this.isCreatorOf(space, actor);
      if (!isCreator && !isAdmin) {
        // R1：403 消息列出实际出现的结构字段名（editor 请求含任一结构字段 → 整体 403，不做部分应用），
        // agent 消费者可据消息自修正
        const presentStructural: string[] = [];
        if (dto.visibility !== undefined) presentStructural.push('visibility');
        if (dto.topicId !== undefined) presentStructural.push('topicId');
        if (dto.boardId !== undefined) presentStructural.push('boardId');
        throw new ForbiddenException({
          message: `Structural fields require creator permission: ${presentStructural.join(', ')}`,
          code: ErrorCode.PERMISSION_DENIED,
        });
      }
    } else {
      await this.permService.ensureCan(space, actor, 'write');
    }

    // If boardId is being set, validate board access
    if (dto.boardId) {
      const board = await this.boardService.findById(dto.boardId);
      await this.permService.ensureCan(board, actor, 'read');
    }

    const result = await this.docSpaceService.update(id, dto);
    // 审计（Phase 2）：UPDATE + doc_space；newData 白名单 {spaceId, name?}（决策 6
    // ——description/overviewFilter/settings 不入）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE,
      entityId: id,
      actorId: actor.id,
      newData: {
        spaceId: id,
        ...(dto.name !== undefined && { name: dto.name }),
      },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Put(':id/repo-manifest')
  @ApiOperation({
    summary: 'Report repository file manifest',
    description:
      'Store the git ls-files manifest (HEAD sha + full relative path list) into ' +
      'doc_spaces.settings.repoManifest (v1.42 batch C2). Atomic jsonb_set merge — only the ' +
      'repoManifest key is touched; visibility and other settings keys are preserved. ' +
      'The only writer is scripts/sync-docs.mjs; route-health recheck consumes the manifest ' +
      'to cascade-check codeEntry existence. reportedAt is generated server-side.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Repo manifest stored successfully' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (files limit / absolute path / `..` segment)',
  })
  async updateRepoManifest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RepoManifestDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);
    await this.permService.ensureCan(space, actor, 'write');
    const result = await this.docSpaceService.updateRepoManifest(id, dto);
    // 审计（Phase 2）：UPDATE + doc_space（repo-manifest）；newData 白名单
    // {spaceId, name}（决策 6——manifest 文件清单不入，可能巨大）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE,
      entityId: id,
      actorId: actor.id,
      newData: { spaceId: id, name: space.name },
      source: 'api',
    });
    return result;
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

    const result = await this.docSpaceService.remove(id, actor);
    // 审计（Phase 2）：DELETE + doc_space；newData 白名单 {spaceId, name}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE,
      entityId: id,
      actorId: actor.id,
      newData: { spaceId: id, name: space.name },
      source: 'api',
    });
    return result;
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
    const result = await this.docSpaceService.inviteAgent(id, dto.agentId);
    // 审计（Phase 2）：CREATE + doc_space_member（invite-agent）；controller 层
    // （inviteAgent 无 actor 参数，决策 2）；newData {spaceId, actorId}
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE_MEMBER,
      entityId: dto.agentId,
      actorId: actor.id,
      newData: { spaceId: id, actorId: dto.agentId },
      source: 'api',
    });
    return result;
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
    const result = await this.docSpaceService.uninviteAgent(id, dto.agentId);
    // 审计（Phase 2）：DELETE + doc_space_member（uninvite-agent）
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE_MEMBER,
      entityId: dto.agentId,
      actorId: actor.id,
      newData: { spaceId: id, actorId: dto.agentId },
      source: 'api',
    });
    return result;
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
    const result = await this.docSpaceService.addEditor(id, dto.agentId);
    // 审计（Phase 2）：CREATE + doc_space_member（add-editor——新建 editor 行或
    // member→editor 升级均属「授予 editor 角色」写入）
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE_MEMBER,
      entityId: dto.agentId,
      actorId: actor.id,
      newData: { spaceId: id, actorId: dto.agentId },
      source: 'api',
    });
    return result;
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
    const result = await this.docSpaceService.removeEditor(id, dto.agentId);
    // 审计（Phase 2）：DELETE + doc_space_member（remove-editor）
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE_MEMBER,
      entityId: dto.agentId,
      actorId: actor.id,
      newData: { spaceId: id, actorId: dto.agentId },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/transfer-creator')
  // 转让修改既有资源（非新建），语义上 200 而非 POST 默认 201（与 ApiResponse 对齐）
  @HttpCode(200)
  @ApiOperation({
    summary: 'Transfer DocSpace creator',
    description:
      'Transfer the creator role to another actor (human or agent, unified actors table). ' +
      'Creator-only (owner-proxy included). Clean handover: the old creator does not ' +
      'automatically receive any role (loses access to PRIVATE spaces); any existing ' +
      'member row of the new creator is removed (creator identity overrides membership). ' +
      'No event/audit is emitted (consistent with invite/add-editor).',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Creator transferred successfully' })
  @ApiResponse({
    status: 403,
    description: 'Only the space creator can transfer (PERMISSION_DENIED)',
  })
  @ApiResponse({ status: 404, description: 'Target actor not found (ACTOR_NOT_FOUND)' })
  @ApiResponse({ status: 409, description: 'Target is already the creator (RESOURCE_CONFLICT)' })
  async transferCreator(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferCreatorDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(id);

    // Creator-only 闸门（owner-proxy 含内，照抄 inviteAgent 模式）
    const isCreator = await this.isCreatorOf(space, actor);
    const isAdmin = actor?.role === UserRole.ADMIN;
    if (!isCreator && !isAdmin) {
      throw new ForbiddenException({
        message: 'Only space creator can transfer the creator role',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    const updated = await this.docSpaceService.transferCreator(id, dto.newCreatorId);
    // 审计（Phase 2）：UPDATE + doc_space（transfer-creator）；newData 白名单
    // {spaceId, newCreatorId}
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.DOC_SPACE,
      entityId: id,
      actorId: actor.id,
      newData: { spaceId: id, newCreatorId: dto.newCreatorId },
      source: 'api',
    });
    // 返回 enrich 后的 space（与 findOne 同款响应形状，前端 invalidate 后可直读）
    return this.docSpaceService.enrich(updated);
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
      '+ uncategorized docs. Total token estimate is capped at ~20000 (overridable via maxTokens, 500–50000); ' +
      'if exceeded, truncation sets `truncated:true`. ' +
      'The response includes spaceDescription (space legend) in full by default; legend tokens are reported ' +
      'separately as legendTokenEstimate and do not consume the maxTokens budget (pass includeDescription=false to omit). ' +
      'Configurable filters (v1.38): type/excludeType/category/excludeCategory (comma-separated, include+exclude = ' +
      'include-then-exclude intersection), tag, pathPrefix, applySpaceDefaults=false ignores space-level default ' +
      'filters (settings.overviewFilter). Response echoes the effective filters as `appliedFilters`. ' +
      'Large-space slimming (v1.56): slim=true projects each doc to {path,title,summary,docType,tokenEstimate} ' +
      '(category grouping preserved); embedded routes are always navigation-projected ' +
      '(intent/category/primaryDocId/primaryHeadingPath/codeEntry/health.codeEntryStatus — full fields via ' +
      'GET /doc-spaces/:id/routes). ' +
      'Lean catalog mode (v1.66): catalog=true projects each doc to {path,title,tokenEstimate} and exempts doc ' +
      'entries from maxTokens truncation (directory completeness is the contract; docsReturned === docsTotal), ' +
      'composes orthogonally with the filters above, and wins over slim when both are passed.',
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

  // ─── 空间级全量导出 / 回导（任务 T6）────────────────────────

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/export')
  @ApiOperation({
    summary: 'Export a DocSpace as a full bundle (formatVersion 1)',
    description:
      'Space-level full export: single JSON bundle containing curated metadata AND full doc ' +
      'content — space meta (name/description/visibility/settings), categories, intent routes ' +
      '(docs referenced by path, incl. codeEntryType), and every doc with its verbatim markdown ' +
      'content plus summary/docType/tags/category. Purpose: version-alignment snapshots + ' +
      'offline backup (pull into git, diff across releases). ' +
      'Permission: same as overview (space read). ' +
      'NOTE: large spaces produce large responses (docs carry full content, no pagination) — ' +
      'this is by design; snapshot integrity is the priority. The output is directly consumable ' +
      'by POST /doc-spaces/:id/import-bundle (roundtrip).',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Export bundle returned successfully' })
  async exportBundle(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const space = await this.docSpaceService.findById(id);
    await this.permService.ensureCan(space, actor, 'read');
    return this.docBundleService.exportBundle(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/import-bundle')
  // 回导是"把 bundle 应用到既有空间"的更新语义（非新建资源），200 而非 POST 默认 201
  @HttpCode(200)
  @ApiOperation({
    summary: 'Import a DocSpace export bundle (formatVersion 1)',
    description:
      'Restore a bundle produced by GET /doc-spaces/:id/export. Four ordered phases: ' +
      '① categories (idempotent by name) → ② docs (per-doc independent transaction via the ' +
      'batch-upsert pipeline; a single failing doc does not abort the batch) → ' +
      '③ routes (idempotent by intent + primaryDocPath, write-time validation reused) → ' +
      '④ space meta, which is SKIPPED unless overwriteSpaceMeta=true (explicit opt-in to avoid ' +
      'clobbering the target space curation). ' +
      'formatVersion mismatch → 400 VALIDATION_ERROR. Re-importing the same bundle is fully ' +
      'idempotent (no duplicate rows). Requires space write permission.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiQuery({
    name: 'overwriteSpaceMeta',
    required: false,
    description:
      'When true, also overwrite target space name/description/settings from the bundle ' +
      '(default false — space meta is never written implicitly).',
    type: Boolean,
  })
  @ApiResponse({ status: 200, description: 'Bundle imported; per-item statuses returned' })
  @ApiResponse({
    status: 400,
    description: 'formatVersion not supported (VALIDATION_ERROR) or bundle shape invalid',
  })
  async importBundle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ImportDocBundleDto,
    @CurrentActor() actor: UnifiedActor,
    @Query('overwriteSpaceMeta', new ParseBoolPipe({ optional: true }))
    overwriteSpaceMeta?: boolean,
  ) {
    const space = await this.docSpaceService.findById(id);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docBundleService.importBundle(id, dto, actor, overwriteSpaceMeta === true);
  }
}
