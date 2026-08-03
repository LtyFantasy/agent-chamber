/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (文档读/文档写 API), plan §1.1-13 (sectionId 不稳定性契约)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #21(双层校验) #22(findOne必须判空)
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
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse, ApiBody } from '@nestjs/swagger';
import { DocService } from './doc.service';
import { DocSearchService } from './doc-search.service';
import { DocSpaceService } from './docspace.service';
import { PermissionService } from '../../common/services/permission.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import { UpsertDocDto, QueryDocDto, DocSearchDto, BatchUpsertDocsDto } from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';

@ApiTags('Docs')
@Controller()
export class DocController {
  constructor(
    private readonly docService: DocService,
    private readonly docSearchService: DocSearchService,
    private readonly docSpaceService: DocSpaceService,
    private readonly permService: PermissionService,
  ) {}

  // ─── Space-scoped doc routes ────────────────────────────────

  @UseGuards(JwtOrApiKeyGuard)
  @Put('doc-spaces/:id/docs/batch')
  @ApiOperation({
    summary: 'Batch upsert documents',
    description:
      'Batch upsert documents by spaceId + path. 1-50 docs per request. ' +
      'Each document runs in its own transaction; a single failure does not abort the batch. ' +
      'Requires write access (creator or editor).',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiBody({ type: BatchUpsertDocsDto })
  @ApiResponse({
    status: 200,
    description: 'Batch upsert completed. See per-item result for details.',
  })
  async batchUpsert(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Body() dto: BatchUpsertDocsDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docService.batchUpsert(spaceId, dto.docs, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Put('doc-spaces/:id/docs')
  @ApiOperation({
    summary: 'Upsert a document',
    description:
      'Upsert a document by spaceId + path. Requires write access (creator or editor). ' +
      'Content-hash unchanged returns { unchanged: true }. ' +
      'Category name is resolved or auto-created. Non-native documents reject writes from different sources (409).',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Document upserted successfully' })
  @ApiResponse({ status: 409, description: 'DOC_SOURCE_MISMATCH: source conflict' })
  async upsert(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Body() dto: UpsertDocDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docService.upsert(spaceId, dto, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('doc-spaces/:id/docs')
  @ApiOperation({
    summary: 'List documents in a DocSpace',
    description:
      'List documents with optional filters: category (by slug), tag, type, q (ILIKE on title/path), ' +
      'path (exact match, mutually exclusive with q). Returns summary list without body content.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'Filter by category slug',
    type: String,
  })
  @ApiQuery({ name: 'tag', required: false, description: 'Filter by tag', type: String })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by document type', type: String })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Full-text search (ILIKE). Mutually exclusive with path=',
    type: String,
  })
  @ApiQuery({
    name: 'path',
    required: false,
    description: 'Exact path match. Mutually exclusive with q=',
    type: String,
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default 1)', type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page (max 100, default 20)',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Document list returned successfully' })
  @ApiResponse({ status: 400, description: 'path= and q= are mutually exclusive' })
  async findAll(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Query() query: QueryDocDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docService.findAll(spaceId, query);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('doc-spaces/:id/search')
  @ApiOperation({
    summary: 'Search documents in a DocSpace',
    description:
      'Search documents within a specific DocSpace using dual-scoring (ts_rank + pg_trgm). ' +
      'Supports optional filters: type, tag, category, limit. Returns ranked DocSearchHit[] ' +
      'with snippet and composite score.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiQuery({ name: 'q', required: true, description: 'Search query string', type: String })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by document type', type: String })
  @ApiQuery({ name: 'tag', required: false, description: 'Filter by tag', type: String })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'Filter by category slug',
    type: String,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max hits (1-20, default 5)',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Search results returned successfully' })
  async search(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Query() query: DocSearchDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    const accessibleSpaceIds = [spaceId];
    return this.docSearchService.search(accessibleSpaceIds, query);
  }

  // ─── Global doc routes (by doc ID) ──────────────────────────

  @UseGuards(JwtOrApiKeyGuard)
  @Get('docs/:id')
  @ApiOperation({
    summary: 'Get document detail',
    description:
      'Return document metadata + section outline (position, headingPath, headingLevel, tokenEstimate) ' +
      'without body content. Designed for Agent consumption with minimal token cost.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Document detail returned successfully' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docService.findOne(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('docs/:id/content')
  @ApiOperation({
    summary: 'Get full document content (web rendering only)',
    description:
      'Return concatenated full text of all sections. ' +
      '⚠️ NOT recommended for Agent consumption — high token cost. Use GET /docs/:id for outline, ' +
      'or GET /docs/:id/sections/:position for targeted reading. ' +
      'Default skips the first H1 when it duplicates the doc title (rendering dedup, since the web ' +
      'header already shows the title); pass ?full=true to get the complete round-trip content ' +
      '(required by the web editor — saving deduped content would drop the title heading and ' +
      're-derive the title from the next heading).',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiQuery({
    name: 'full',
    required: false,
    type: Boolean,
    description: 'true = 不做首标题去重，返回可安全回写 upsert 的完整原文（编辑器专用）',
  })
  @ApiResponse({ status: 200, description: 'Full document content returned successfully' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  async getContent(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Query('full') full?: string,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docService.getContent(id, full === 'true');
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('docs/:id/sections/:position?')
  @ApiOperation({
    summary: 'Get a single section by position or headingPath',
    description:
      'Return a single section body located by position (path param, stable cross-update) ' +
      'or by headingPath (query param) — either one suffices. ' +
      'Section ID is NOT accepted — it is unstable and changes on every content update. ' +
      'position takes priority if headingPath is also provided.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiParam({
    name: 'position',
    description: 'Section position (0-based); omit when locating by headingPath',
    type: Number,
    required: false,
  })
  @ApiQuery({
    name: 'headingPath',
    required: false,
    description: 'Alternative: locate by headingPath',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'Section content returned successfully' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  async getSection(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('position', new ParseIntPipe({ optional: true })) position: number | undefined,
    @Query('headingPath') headingPath?: string,
    @CurrentActor() actor?: UnifiedActor,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docService.getSection(id, position, headingPath);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete('docs/:id')
  @ApiOperation({
    summary: 'Delete a document',
    description:
      'Soft-delete a document. Requires write access (creator or editor). ' +
      'Non-native (ingest) documents can only be deleted with a matching ?source= query param (409 DOC_SOURCE_MISMATCH otherwise).',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiQuery({
    name: 'source',
    required: false,
    description:
      "Source identifier; must exactly match the doc's source for non-native documents (e.g. ingest adapters pass their own git:* source)",
  })
  @ApiResponse({ status: 200, description: 'Document deleted successfully' })
  @ApiResponse({ status: 403, description: 'PERMISSION_DENIED' })
  @ApiResponse({ status: 409, description: 'DOC_SOURCE_MISMATCH' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Query('source') source?: string,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docService.remove(id, source, actor);
  }
}
