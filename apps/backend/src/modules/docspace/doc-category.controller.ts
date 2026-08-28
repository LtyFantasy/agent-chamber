/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (W2 分类 API)
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（removeCategory
 *     controller 层插桩决策 2；updateCategory 在 service 层——importBundle 内部调用）
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
import { Controller, Patch, Delete, Body, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { DocSpaceService } from './docspace.service';
import { PermissionService } from '../../common/services/permission.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import { UpdateDocCategoryDto } from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@agent-chamber/shared';

@ApiTags('DocSpaces')
@Controller('doc-categories')
export class DocCategoryController {
  constructor(
    private readonly docSpaceService: DocSpaceService,
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
      entityType: 'doc_category',
      entityId: id,
      actorId: actor.id,
      newData: { categoryId: id, spaceId: category.spaceId, name: category.name },
      source: 'api',
    });
    return { deleted: true };
  }
}
