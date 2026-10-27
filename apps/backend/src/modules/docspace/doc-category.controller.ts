/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (W2 分类 API)
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（removeCategory
 *     controller 层插桩决策 2；updateCategory 在 service 层——importBundle 内部调用）
 *   - 补充: plan black-widow-rocket-nightwing.md（v1.92.0-dev 3 期：POST
 *     /doc-categories/:id/merge——动作型 @HttpCode(200)，write 权限；category rename 已由
 *     PATCH :id 覆盖故不重复造，只补 merge（docs 重指向 + 软引用修正 + source 软删））
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  Controller,
  Patch,
  Delete,
  Post,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBody } from '@nestjs/swagger';
import { DocSpaceService } from './docspace.service';
import { DocRenameService } from './doc-rename.service';
import { PermissionService } from '../../common/services/permission.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import { UpdateDocCategoryDto, MergeDocCategoryDto } from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { AuditAction } from '@agent-chamber/shared';

@ApiTags('DocSpaces')
@Controller('doc-categories')
export class DocCategoryController {
  constructor(
    private readonly docSpaceService: DocSpaceService,
    private readonly docRenameService: DocRenameService,
    private readonly permService: PermissionService,
    private readonly auditService: AuditService,
  ) {}

  @UseGuards(JwtOrApiKeyGuard)
  @Patch(':id')
  @ApiOperation({
    summary: 'Update a category',
    description: 'Update a DocCategory by ID. Requires write access to the parent space.',
  })
  @ApiParam({ name: 'id', description: 'Category ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Category updated successfully' })
  async updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocCategoryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const category = await this.docSpaceService.findCategoryById(id);
    const space = await this.docSpaceService.findById(category.spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docSpaceService.updateCategory(id, dto);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/merge')
  // 动作型端点（把 source 分类合并进 target，不创建资源）：POST 默认 201 → 显式 200
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge a category into another (governance)',
    description:
      'Merge the source category (`:id`) into `targetId` (v1.92.0-dev DocSpace metadata ' +
      'governance phase 3): docs are repointed in one transaction, soft references are fixed ' +
      '(doc_routes.category rewritten from the old slug to the new one, ' +
      'settings.overviewFilter.excludeCategories adjusted), and the source category is ' +
      'soft-deleted (its slug is released). ' +
      'Category rename is already covered by PATCH /doc-categories/:id, so only merge is added here. ' +
      'dryRun=true previews the affected docs (total + sample ≤50), the soft-reference impact and ' +
      'a batchToken with ZERO side effects (no write, no audit, no idempotency record). ' +
      '⚠️ Categories have NO alias mechanism (only canonicalTags carries aliases): after the merge ' +
      'queries by the old slug return nothing — unlike tags, which stay reachable through the ' +
      'alias layer. ' +
      'Fail-closed: 404 source/target not found; 422 target === source, target in another space, ' +
      'or target soft-deleted. ingest documents are repointed too and reported in ingestAffected. ' +
      'After commit: one summary audit row on the source category (oldData carries the per-doc ' +
      'pre-image for rollback). Requires write access (creator or editor).',
  })
  @ApiParam({ name: 'id', description: 'Source category ID (UUID)', type: String })
  @ApiBody({ type: MergeDocCategoryDto })
  @ApiResponse({ status: 200, description: 'Merge previewed (dryRun) or executed' })
  @ApiResponse({ status: 404, description: 'DOC_CATEGORY_NOT_FOUND: source or target missing' })
  @ApiResponse({
    status: 409,
    description: 'IDEMPOTENCY_KEY_CONFLICT: same key with a different payload',
  })
  @ApiResponse({
    status: 422,
    description: 'VALIDATION_ERROR: target === source / cross-space target / target soft-deleted',
  })
  async mergeCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeDocCategoryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const category = await this.docSpaceService.findCategoryById(id);
    const space = await this.docSpaceService.findById(category.spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docRenameService.mergeCategory(id, dto, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a category',
    description:
      'Delete a DocCategory by ID. Documents in the category are moved to uncategorized (categoryId set to null). ' +
      'Requires write access to the parent space.',
  })
  @ApiParam({ name: 'id', description: 'Category ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Category deleted successfully' })
  async removeCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const category = await this.docSpaceService.findCategoryById(id);
    const space = await this.docSpaceService.findById(category.spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    await this.docSpaceService.removeCategory(id);
    // 审计（Phase 2）：DELETE + doc_category；controller 层（removeCategory 无 actor
    // 参数，决策 2）；newData 白名单 {categoryId, spaceId, name}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.DOC_CATEGORY,
      entityId: id,
      actorId: actor.id,
      newData: { categoryId: id, spaceId: category.spaceId, name: category.name },
      source: 'api',
    });
    return { deleted: true };
  }
}
