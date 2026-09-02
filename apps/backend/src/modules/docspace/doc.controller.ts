/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (文档读/文档写 API), plan §1.1-13 (sectionId 不稳定性契约)
 *   - 补充: plan patriot-cyclone-deadman.md §1.5（v1.61.0 批次 1：link-health recheck
 *     双端点——单文档 + 空间全量，write 权限，对齐 routes/recheck 先例）
 *   - 补充: plan patriot-cyclone-deadman.md §2.1（v1.61.0 批次 2：PATCH /docs/:id/metadata
 *     metadata-only 写通道——Partial 三态/hash 必填/native-only/category 解析开关）
 *   - 补充: plan docspace-lazy-tree-v1.md（v1.70.0-dev：GET /doc-spaces/:id/docs/tree
 *     懒加载目录树 + /docs/facets 聚合计数——只读端点，权限与 findAll 同款
 *     ensureCan(space, actor ?? null, 'read')；字面路由与既有 :docId 参数路由无冲突）
 *
 * [踩坑索引]
 *   - Hument 事故（topic msg 6dbc4da3）：stale position fail-open → fail-closed
 *     （2026-08-16）：GET sections @ApiOperation 删掉 "stable cross-update" 失实措辞；
 *     PATCH sections 透传 expectedSectionHash、新增 PATCH /docs/:id/content（match 模式），
 *     前提校验失败 = 409 DOC_CONTENT_CONFLICT / 多命中 = 409 RESOURCE_CONFLICT
 *   - tree/facets SQL 形态硬约束（plan A1/A2）：WHERE 只用 LIKE（禁止 substring 进
 *     WHERE）、substring/split_part 只进 SELECT/GROUP BY、plen 由 service JS 算好整数
 *     传入——改 SQL 前先读 doc.service.ts findTree 注释与 plan「SQL 形态硬约束」节
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
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ParseIntPipe,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ErrorCode, DOC_SOURCE_NATIVE } from '@agent-chamber/shared';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse, ApiBody } from '@nestjs/swagger';
import { DocService } from './doc.service';
import { DocMoveService } from './doc-move.service';
import { DocSearchService } from './doc-search.service';
import { DocSpaceService } from './docspace.service';
import { PermissionService } from '../../common/services/permission.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import {
  UpsertDocDto,
  QueryDocDto,
  QueryDocTreeDto,
  DocSearchDto,
  BatchUpsertDocsDto,
  DocDetailQueryDto,
  PatchDocSectionDto,
  PatchDocContentDto,
  AppendDocDto,
  MoveDocDto,
  PatchDocMetadataDto,
} from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';

/**
 * 批量读节单次请求 position 数上限
 *
 * rationale：position 逐节携带正文，无上限 = 单次请求可拉整篇任意大文档（响应放大攻击面，
 * 与 maxFullTokens 上限 100000 同款动机）；100 节远超真实文档规模（chunker 切分下
 * 万 token 级文档约几十节），穷尽读整篇应走 GET /docs/:id/content 或 maxFullTokens 通道。
 */
const MAX_BATCH_POSITIONS = 100;

@ApiTags('Docs')
@Controller()
export class DocController {
  constructor(
    private readonly docService: DocService,
    private readonly docMoveService: DocMoveService,
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
      'Category name is resolved or auto-created. Non-native documents reject writes from different sources (409). ' +
      'Optional optimistic lock: pass expectedContentHash (from a previous read/write response contentHash) — ' +
      'missing doc or hash mismatch → 409 DOC_CONTENT_CONFLICT (rechecked in-transaction under row lock); ' +
      'match + unchanged content returns unchanged normally. ' +
      'forceRechunk=true rebuilds sections even when the content hash is unchanged (fixes corrupted chunk-level ' +
      'metadata); response carries rechunked:true and no doc_versions row is written.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Document upserted successfully' })
  @ApiResponse({
    status: 409,
    description:
      'DOC_SOURCE_MISMATCH: source conflict; DOC_CONTENT_CONFLICT: expectedContentHash precondition failed',
  })
  async upsert(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Body() dto: UpsertDocDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    // v1.63.0：clientRequestId 幂等键透传（重放返回首次响应快照 + idempotentReplay）
    return this.docService.upsert(spaceId, dto, actor, dto.clientRequestId);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('doc-spaces/:id/docs')
  @ApiOperation({
    summary: 'List documents in a DocSpace',
    description:
      'List documents with optional filters: category (by slug), tag, type, q (ILIKE on title/path), ' +
      'path (exact match, mutually exclusive with q), pathPrefix (prefix match, mutually exclusive with path). ' +
      'Returns summary list without body content.',
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
  @ApiQuery({
    name: 'pathPrefix',
    required: false,
    description: 'Path prefix match (e.g. "memory/"). Mutually exclusive with path=',
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
  @Get('doc-spaces/:id/docs/tree')
  @ApiOperation({
    summary: 'Get lazy directory tree at a prefix (folders + direct docs)',
    description:
      'Lazy directory browsing (v1.70.0-dev): returns the direct sub-folders of the given ' +
      'prefix (with recursive docCount/latestDocAt aggregation) plus the direct docs ' +
      'attached at this level (slim projection, paginated). ' +
      'prefix defaults to "" (root level); server normalizes it (leading "/" stripped, ' +
      'trailing "/" appended when non-empty). sort=recent (default, folders by ' +
      'latestDocAt DESC) | name (folders by segment name ASC). ' +
      'docsLimit max 200 / foldersLimit max 500 (400 when exceeded). ' +
      'Requires the same read permission as the space.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiQuery({
    name: 'prefix',
    required: false,
    description: 'Path prefix (default "" = root level)',
    type: String,
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    description: 'recent (default) | name',
    enum: ['recent', 'name'],
  })
  @ApiQuery({
    name: 'docsLimit',
    required: false,
    description: 'Max direct docs (default 50, max 200)',
    type: Number,
  })
  @ApiQuery({
    name: 'docsOffset',
    required: false,
    description: 'Docs offset (default 0)',
    type: Number,
  })
  @ApiQuery({
    name: 'foldersLimit',
    required: false,
    description: 'Max folders (default 200, max 500)',
    type: Number,
  })
  @ApiQuery({
    name: 'foldersOffset',
    required: false,
    description: 'Folders offset (default 0)',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Directory tree returned successfully' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR: limit exceeded or malformed query' })
  async findTree(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Query() query: QueryDocTreeDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docService.findTree(spaceId, query);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('doc-spaces/:id/docs/facets')
  @ApiOperation({
    summary: 'Get space-wide aggregation counts (types / tags / categories)',
    description:
      'Space-wide facet counts (v1.70.0-dev): types = GROUP BY doc_type (non-empty), ' +
      'tags = unnest(tags) GROUP BY, categories = JOIN doc_categories (soft-deleted ' +
      'filtered). Only non-deleted docs are counted. Replaces client-side full-list ' +
      'aggregation. Requires the same read permission as the space.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Facet counts returned successfully' })
  async findFacets(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docService.findFacets(spaceId);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('doc-spaces/:id/search')
  @ApiOperation({
    summary: 'Search documents in a DocSpace',
    description:
      'Search documents within a specific DocSpace using dual-scoring (ts_rank + pg_trgm). ' +
      'Supports optional filters: type, tag, category, limit, offset (pagination), ' +
      'createdAfter/createdBefore (ISO time window, inclusive). ' +
      'sort=relevance (default) ranks by score + intent fusion boosts; ' +
      'sort=createdAt_desc/createdAt_asc orders by doc creation time and skips boost fusion. ' +
      'Returns ranked DocSearchHit[] with snippet and composite score.',
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
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Pagination offset — hits to skip (paired with limit, default 0, max 100000)',
    type: Number,
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    description:
      'Sort mode: relevance (default, dual-scoring + boost fusion) | createdAt_desc | ' +
      'createdAt_asc (time order takes over ORDER BY; boost fusion skipped)',
    enum: ['relevance', 'createdAt_desc', 'createdAt_asc'],
  })
  @ApiQuery({
    name: 'createdAfter',
    required: false,
    description: 'Only docs created at/after this ISO 8601 time (inclusive)',
    type: String,
  })
  @ApiQuery({
    name: 'createdBefore',
    required: false,
    description: 'Only docs created at/before this ISO 8601 time (inclusive)',
    type: String,
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
      'Return document metadata + section outline (position, headingPath, headingLevel, tokenEstimate). ' +
      'Small documents (tokenEstimate > 0 and ≤ 2000 by default, overridable via maxFullTokens) are ' +
      'inlined with full content (mode:"full" + content) — Agent-friendly, no per-section round trips. ' +
      'Large documents return mode:"outline" (metadata + section list without body) for targeted reading. ' +
      'tokenEstimate=0 (legacy docs) never triggers full content.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiQuery({
    name: 'maxFullTokens',
    required: false,
    description:
      'Inline-full-content token threshold override (default 2000; 0 = force outline; max 100000 to prevent response amplification)',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Document detail returned successfully' })
  @ApiResponse({
    status: 400,
    description: 'Invalid maxFullTokens (non-integer or out of [0, 100000])',
  })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    // 双层校验（铁律 #21）层 1：ParseIntPipe 拦非整数格式（400）；
    // 层 2：DocDetailQueryDto 的 @IsInt @Min(0) @Max(100000) 拦越界（400）。
    // 非法值在 controller 层拦截，不得透传到 service。
    @Query('maxFullTokens', new ParseIntPipe({ optional: true })) maxFullTokens: number | undefined,
    @Query() _query: DocDetailQueryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docService.findOne(id, maxFullTokens);
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
  @Get('docs/:id/versions')
  @ApiOperation({
    summary: 'List document version history (metadata only, doc history MVP)',
    description:
      'Return the version history of a document as metadata only — ' +
      'version / contentHash / authorActorId / source / createdAt / contentSize, NO content body. ' +
      'Newest version first (version DESC). Version numbers are monotonically increasing ' +
      '(max+1, never reset after pruning) and stable identifiers. ' +
      'Each version is created inside the upsert transaction when the content hash actually ' +
      'changes; at most the latest 20 versions are kept (older ones are pruned in the same transaction). ' +
      'Requires the same read permission as the document itself.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Version history returned successfully (version DESC)' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  async getVersions(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docService.findVersions(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('docs/:id/versions/:version')
  @ApiOperation({
    summary: 'Get a single document version (full content + diff vs previous version)',
    description:
      'Return one version of a document: metadata + full content snapshot + a line-level diff ' +
      'against the previous version (computed on read, NOT stored). ' +
      'The previous version is the largest version below the requested one (pruning may skip numbers). ' +
      'diff is null for the earliest kept version; a diff with added=0/removed=0 means identical content. ' +
      'Requires the same read permission as the document itself.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiParam({ name: 'version', description: 'Version number (positive integer)', type: Number })
  @ApiResponse({
    status: 200,
    description: 'Version detail (content + diff) returned successfully',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR: non-positive version' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND: document or version missing' })
  async getVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentActor() actor: UnifiedActor,
  ) {
    // 双层校验（铁律 #21）层 1 格式：version 必须为正整数（<1 无版本语义）—
    // 格式错误快速失败 400，不透传 service（service 层 404 兜底不存在的版本）
    if (version < 1) {
      throw new BadRequestException({
        message: 'version must be a positive integer (>= 1)',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docService.findVersion(id, version);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('docs/:id/sections/:position?')
  @ApiOperation({
    summary: 'Get section(s) by position / positions[] / headingPath / headingQuery',
    description:
      'Four locator channels (priority: position path param > headingPath exact > headingQuery fuzzy; ' +
      'positions batch channel is mutually exclusive with all single-section channels, 400 otherwise): ' +
      '(1) position path param — single section. ⚠️ position DRIFTS after any re-chunk ' +
      '(structural edits re-number sections) — before writing, pass expectedSectionHash ' +
      '(fail-closed precondition) or re-fetch the outline; ' +
      '(2) positions=1,3,5 query — BATCH read multiple sections in one round trip (v1.55): ' +
      'duplicates deduped, out-of-range positions reported in `missing` instead of failing the whole ' +
      'request (partial-failure friendly); returns {docId, docPath, sections[], missing[]} with sections ' +
      'in position ASC; every section item carries sectionHash (derived anchor hash for ' +
      'expectedSectionHash write preconditions); ' +
      '(3) headingPath query — exact headingPath match; ' +
      '(4) headingQuery query — fuzzy locate (v1.55): case-insensitive substring match on outline ' +
      'headingPath; unique hit returns the section, multiple hits return 409 RESOURCE_CONFLICT with ' +
      'data.candidates [{position, headingPath}], zero hits return 404 DOC_NOT_FOUND. ' +
      'Section ID is NOT accepted — it is unstable and changes on every content update.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiParam({
    name: 'position',
    description: 'Section position (0-based); omit when using any query-param locator',
    type: Number,
    required: false,
  })
  @ApiQuery({
    name: 'headingPath',
    required: false,
    description: 'Alternative: locate by exact headingPath',
    type: String,
  })
  @ApiQuery({
    name: 'positions',
    required: false,
    description:
      'Batch channel: comma-separated 0-based positions (e.g. "1,3,5", max 100). ' +
      'Mutually exclusive with position/headingPath/headingQuery.',
    type: String,
  })
  @ApiQuery({
    name: 'headingQuery',
    required: false,
    description:
      'Fuzzy locator: case-insensitive substring match on headingPath. ' +
      'Unique hit → section; multiple hits → 409 + data.candidates; zero hits → 404.',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Section content (or batch result) returned successfully',
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR: malformed/oversized positions list, or batch channel mixed with single-section locators',
  })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description:
      'RESOURCE_CONFLICT: headingQuery matches multiple sections (data.candidates lists them)',
  })
  async getSection(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('position', new ParseIntPipe({ optional: true })) position: number | undefined,
    @Query('headingPath') headingPath?: string,
    @Query('positions') positionsRaw?: string,
    @Query('headingQuery') headingQuery?: string,
    @CurrentActor() actor?: UnifiedActor,
  ) {
    // ── 批量通道（v1.55 positions[]）─────────────────────────────
    if (positionsRaw !== undefined) {
      // 双层校验（铁律 #21）层 1 格式：批量与单节定位语义不共存，混传 = 请求格式错误；
      // 格式解析先于 findById/权限检查执行——畸形请求快速失败（400），不浪费业务查询
      if (position !== undefined || headingPath !== undefined || headingQuery !== undefined) {
        throw new BadRequestException({
          message:
            'positions= (batch) is mutually exclusive with position path param / headingPath / headingQuery',
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      const positions = this.parsePositionsParam(positionsRaw);
      const doc = await this.docService.findById(id);
      const space = await this.docSpaceService.findById(doc.spaceId);
      await this.permService.ensureCan(space, actor ?? null, 'read');
      return this.docService.getSections(id, positions);
    }

    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');

    // ── 单节通道优先级：position > headingPath > headingQuery（与既有 position 优先契约一致）──
    if (position === undefined && headingPath === undefined) {
      if (headingQuery !== undefined) {
        // headingQuery 空串/全空白无定位语义（子串匹配空串会全命中，禁止）——
        // 400 快速失败，不透传到 service 的 ILIKE 查询
        if (headingQuery.trim() === '') {
          throw new BadRequestException({
            message: 'headingQuery must be a non-empty substring',
            code: ErrorCode.VALIDATION_ERROR,
          });
        }
        return this.docService.getSectionByHeadingQuery(id, headingQuery);
      }
    }
    return this.docService.getSection(id, position, headingPath);
  }

  /**
   * 解析 positions= 查询参数为 number[]（双层校验铁律 #21 层 1 格式部分）
   *
   * 格式契约：逗号分隔的非负整数（"1,3,5"），允许空白容差（"1, 3"）；
   * 空串、非整数、负数、超过 MAX_BATCH_POSITIONS 上限均 400 VALIDATION_ERROR——
   * 格式错误不透传 service/PG。去重不在此处（去重是响应契约的一部分，service 层执行并在
   * 文档中声明）；上限按原始 token 数判定（防 abuse 先于语义）。
   */
  private parsePositionsParam(raw: string): number[] {
    const tokens = raw.split(',').map((t) => t.trim());
    if (tokens.length > MAX_BATCH_POSITIONS) {
      throw new BadRequestException({
        message: `positions list exceeds max ${MAX_BATCH_POSITIONS} entries`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const positions: number[] = [];
    for (const token of tokens) {
      // 仅接受纯非负整数字面量（拒绝 "+1"/"1.5"/"1e2"/空串）
      if (!/^\d+$/.test(token)) {
        throw new BadRequestException({
          message: `positions must be comma-separated non-negative integers, got "${token}"`,
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      positions.push(Number(token));
    }
    if (positions.length === 0) {
      throw new BadRequestException({
        message: 'positions must contain at least one entry',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    return positions;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch('docs/:id/sections/:position')
  @ApiOperation({
    summary: 'Replace a single section by position (section-level write)',
    description:
      'Replace ONE section of a large document without full read-modify-write by the caller. ' +
      'Symmetric write-side counterpart of GET /docs/:id/sections/:position. ' +
      'body.content is the full rendered section fragment INCLUDING its heading line ' +
      '(same shape read_doc section mode / GET /docs/:id/content?full=true produce); the whole ' +
      'section (heading included) is replaced, then the document is re-chunked and all derived ' +
      'data (outline/position/contentHash/tokenEstimate/linkHealth) is rebuilt via the upsert pipeline. ' +
      'Empty content deletes the section. Requires write access (creator or editor). ' +
      'Non-native documents require a matching ?source= (409 DOC_SOURCE_MISMATCH otherwise). ' +
      'NOTE (fail-closed): positions of other sections DRIFT after structural changes, and a ' +
      'stale position otherwise writes the WRONG block silently (fail-open legacy). Pass ' +
      'body.expectedSectionHash (copied from the sectionHash field of GET sections responses) ' +
      'to make the write precondition-checked: mismatch → 409 DOC_CONTENT_CONFLICT ' +
      '(data.sectionCount included) instead of a silent wrong-block write; concurrent ' +
      'modification between your read and this write is also detected inside the upsert ' +
      'transaction (409). Re-fetch the outline and retry on 409.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiParam({
    name: 'position',
    description: 'Section position (0-based, same locator as GET /docs/:id/sections/:position)',
    type: Number,
  })
  @ApiQuery({
    name: 'source',
    required: false,
    description:
      "Source identifier (default 'native'); must match the doc's source for non-native documents",
  })
  @ApiBody({ type: PatchDocSectionDto })
  @ApiResponse({
    status: 200,
    description:
      'Section replaced; upsert result returned (includes contentHash for chained writes)',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR: negative position or invalid body' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND: document or section position missing' })
  @ApiResponse({
    status: 409,
    description:
      'DOC_SOURCE_MISMATCH: source conflict; DOC_CONTENT_CONFLICT: expectedSectionHash / ' +
      'concurrent-modification precondition failed (re-fetch outline and retry)',
  })
  async patchSection(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('position', ParseIntPipe) position: number,
    @Body() dto: PatchDocSectionDto,
    @Query('source') source?: string,
    @CurrentActor() actor?: UnifiedActor,
  ) {
    // 双层校验（铁律 #21）层 1 格式：ParseIntPipe 拦非整数（400）；
    // 负数不可能是合法 0-based position → 格式层 400 VALIDATION_ERROR，不得透传 service。
    // 层 2 业务存在性（position 是否落在实际 section 数内）在 service 判 404。
    if (position < 0) {
      throw new BadRequestException({
        message: 'position must be a non-negative integer (0-based section index)',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'write');
    // source 缺省 native（与 upsert 契约一致）；非 native 文档须携带匹配 source（隔离检查在 upsert 内）
    // v1.63.0：clientRequestId 幂等键透传（幂等包裹在 patchSection 入口，快照 = 本入口响应）
    return this.docService.patchSection(
      id,
      position,
      dto.content,
      source ?? DOC_SOURCE_NATIVE,
      actor,
      dto.expectedSectionHash,
      dto.clientRequestId,
    );
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch('docs/:id/content')
  @ApiOperation({
    summary: 'Replace an exact substring in the full document content (match-mode write)',
    description:
      'Match-mode write (fail-closed counterpart of section-mode PATCH sections/:position): ' +
      'replaces oldString with newString in the document FULL content. ' +
      '⚠️ The match surface is the full=true faithful content (GET /docs/:id/content?full=true — ' +
      'skipDuplicateTitle=false, sections joined with "\\n\\n"), byte-identical to the read-side ' +
      'full=true channel; the default rendering (full=false) drops the first title heading and ' +
      'will produce 0-match 404s if used to construct oldString. ' +
      'Match semantics: 0 matches → 404 DOC_NOT_FOUND (re-read the content first); ' +
      'multiple matches → 409 RESOURCE_CONFLICT with data.matchCount (expand oldString with ' +
      'more surrounding context and retry); exactly 1 match → replaced and the document is ' +
      're-chunked via the upsert pipeline. ' +
      'Concurrent modification between your read and this write is detected inside the upsert ' +
      'transaction (409 DOC_CONTENT_CONFLICT). Requires write access (creator or editor). ' +
      'Non-native documents require a matching ?source= (409 DOC_SOURCE_MISMATCH otherwise).',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiQuery({
    name: 'source',
    required: false,
    description:
      "Source identifier (default 'native'); must match the doc's source for non-native documents",
  })
  @ApiBody({ type: PatchDocContentDto })
  @ApiResponse({
    status: 200,
    description:
      'Substring replaced; upsert result returned (includes contentHash for chained writes)',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR: missing/empty oldString or invalid body',
  })
  @ApiResponse({
    status: 404,
    description: 'DOC_NOT_FOUND: document missing or oldString has 0 matches',
  })
  @ApiResponse({
    status: 409,
    description:
      'RESOURCE_CONFLICT: oldString matches multiple locations (data.matchCount); ' +
      'DOC_CONTENT_CONFLICT: concurrent modification detected; DOC_SOURCE_MISMATCH: source conflict',
  })
  async patchContent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchDocContentDto,
    @Query('source') source?: string,
    @CurrentActor() actor?: UnifiedActor,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'write');
    // source 缺省 native（与 upsert 契约一致）；非 native 文档须携带匹配 source（隔离检查在 upsert 内）
    // v1.63.0：clientRequestId 幂等键透传（幂等包裹在 patchByMatch 入口，快照 = 本入口响应）
    return this.docService.patchByMatch(
      id,
      dto.oldString,
      dto.newString,
      source ?? DOC_SOURCE_NATIVE,
      actor,
      dto.clientRequestId,
    );
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('docs/:id/append')
  // 动作型端点（追加写，不创建资源）：POST 默认 201 → 显式 200
  // （link-health recheck 同款 @HttpCode 先例）
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Append content to a document (end or under a heading) — concurrency-immune write primitive',
    description:
      'One-step append write (v1.65.0 consumer feedback batch 7601e2f5): appends body.content ' +
      'to the document END (position=end, default) or to the end of the target heading ' +
      'subtree (position=under-heading + headingPath exact match). ' +
      '⚠️ CONCURRENCY-IMMUNE: concurrent modification between the server read and write is ' +
      'retried INTERNALLY (re-read → re-transform → re-write, up to 3 attempts) — the caller ' +
      'never sees DOC_CONTENT_CONFLICT unless 3 attempts are exhausted. Preferred for diary ' +
      'append scenarios; replaces the read → patch match three-step round trip. ' +
      'headingPath semantics: 0 matches → 404 DOC_NOT_FOUND (available headingPaths included); ' +
      'multiple matches → 409 RESOURCE_CONFLICT (candidate positions included, never silently picked). ' +
      'The document is re-chunked via the upsert pipeline (outline/position/contentHash/ ' +
      'tokenEstimate/linkHealth all rebuilt). Requires write access (creator or editor). ' +
      'Non-native documents require a matching ?source= (409 DOC_SOURCE_MISMATCH otherwise).',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiQuery({
    name: 'source',
    required: false,
    description:
      "Source identifier (default 'native'); must match the doc's source for non-native documents",
  })
  @ApiBody({ type: AppendDocDto })
  @ApiResponse({
    status: 200,
    description:
      'Content appended; upsert result returned (includes contentHash for chained writes)',
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR: empty/whitespace-only content, under-heading without headingPath, or invalid body',
  })
  @ApiResponse({
    status: 404,
    description:
      'DOC_NOT_FOUND: document missing or headingPath has 0 matches (available headingPaths included)',
  })
  @ApiResponse({
    status: 409,
    description:
      'RESOURCE_CONFLICT: headingPath matches multiple sections (data.candidates); ' +
      'DOC_SOURCE_MISMATCH: source conflict; DOC_CONTENT_CONFLICT: concurrent modification ' +
      'survived 3 internal retries',
  })
  async appendDoc(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AppendDocDto,
    @Query('source') source?: string,
    @CurrentActor() actor?: UnifiedActor,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'write');
    // source 缺省 native（与 upsert 契约一致）；非 native 文档须携带匹配 source（隔离检查在 upsert 内）
    // v1.63.0：clientRequestId 幂等键透传（幂等包裹在 appendDoc 入口，快照 = 本入口响应）
    return this.docService.appendDoc(
      id,
      { content: dto.content, position: dto.position, headingPath: dto.headingPath },
      source ?? DOC_SOURCE_NATIVE,
      actor,
      dto.clientRequestId,
    );
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch('docs/:id/metadata')
  @ApiOperation({
    summary: 'Patch document metadata only (no content/section rebuild)',
    description:
      'Metadata-only write channel (v1.61.0): updates ONLY the docs row metadata columns — ' +
      'no section re-chunk, no doc_versions row, contentHash/docId/task_doc_links/doc_routes ' +
      'all untouched. PARTIAL three-state semantics: only explicit fields are updated ' +
      '(title/summary/docType/tags/category); absent field = keep; tags: [] = CLEAR; ' +
      'null = 400 rejected (unambiguous three-state, DTO-enforced). ' +
      'expectedContentHash is REQUIRED: mismatch → 409 DOC_CONTENT_CONFLICT (checked fast ' +
      'outside the transaction + rechecked under FOR UPDATE inside — TOCTOU-guarded); ' +
      'metadata-only writes never change contentHash, so a matching hash stays valid across ' +
      'chained metadata writes. ' +
      'category resolves EXISTING space categories only by default — an unknown name → ' +
      '404 DOC_CATEGORY_NOT_FOUND (prevents typo-born near-duplicate categories); pass ' +
      'allowCreateCategory=true to auto-create via the existing upsert resolution path. ' +
      'Non-native documents → 409 DOC_SOURCE_MISMATCH (consistent with upsert/patch). ' +
      'When every explicit field equals the current value the call short-circuits: ' +
      'unchanged:true, empty changedFields, NO write/audit/event. ' +
      'Response carries the final metadata view for single-call verification. ' +
      'Requires write access (creator or editor).',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiBody({ type: PatchDocMetadataDto })
  @ApiResponse({
    status: 200,
    description:
      'PatchDocMetadataResult: { docId, path, contentHash (unchanged), changedFields, unchanged, metadata }',
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR: null field value (three-state contract) or malformed body',
  })
  @ApiResponse({
    status: 404,
    description: 'DOC_NOT_FOUND; DOC_CATEGORY_NOT_FOUND (resolve-only mode miss)',
  })
  @ApiResponse({ status: 403, description: 'PERMISSION_DENIED' })
  @ApiResponse({
    status: 409,
    description:
      'DOC_SOURCE_MISMATCH (non-native); DOC_CONTENT_CONFLICT (expectedContentHash precondition failed)',
  })
  async patchMetadata(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchDocMetadataDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    // 权限对齐 PATCH /docs/:id/sections（write：creator 或 editor）
    await this.permService.ensureCan(space, actor ?? null, 'write');
    // v1.63.0：clientRequestId 幂等键透传（重放返回首次响应快照 + idempotentReplay）
    return this.docService.patchMetadata(id, dto, actor, dto.clientRequestId);
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

  // ─── Move / move-impact（v1.60.0-dev，P1 双件 73cadb0d + 8d763914）─────────

  @UseGuards(JwtOrApiKeyGuard)
  @Get('docs/:id/move-impact')
  @ApiOperation({
    summary: 'Get move impact (backlinks / route refs / task links / collision)',
    description:
      'Pre-move impact query — same kernel as POST /docs/:id/move dryRun. ' +
      'Scans the whole space for inbound Markdown links (backlinks) pointing at this doc, ' +
      'plus doc_routes references, task_doc_links, and optional target-path collision ' +
      '(pass ?proposedPath= to include no-op detection and collision check). ' +
      'Requires the same read permission as the document itself.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiQuery({
    name: 'proposedPath',
    required: false,
    description:
      'Proposed target path — when present computes targetCollision and samePath ' +
      '(same as current path → no-op) in the response',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'DocMoveImpact view returned successfully' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  async getMoveImpact(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('proposedPath') proposedPath?: string,
    @CurrentActor() actor?: UnifiedActor,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.docMoveService.computeMoveImpact(doc.spaceId, doc, proposedPath);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('docs/:id/move')
  @ApiOperation({
    summary: 'Atomically move (rename) a document',
    description:
      'Atomic rename by doc ID — single transaction, same docId, only docs.path is updated ' +
      '(content/sections/contentHash/title untouched). docId/versions/task doc links/' +
      'doc_routes references are preserved (all reference by docId, move is naturally continuous). ' +
      'Fail-closed validation order: 404 (missing/soft-deleted) → 409 DOC_SOURCE_MISMATCH ' +
      '(non-native source) → 409 RESOURCE_CONFLICT (toPath == current path, no-op rejected) → ' +
      '409 DOC_CONTENT_CONFLICT (expectedContentHash mismatch, TOCTOU-guarded in-transaction) → ' +
      '409 RESOURCE_CONFLICT (target path taken, data.conflictDocId). ' +
      'dryRun=true runs the full validation chain + impact preview without writing. ' +
      'Requires write access (creator or editor). ' +
      'After commit: DOC_MOVED event, audit log, and async link_health recalculation ' +
      '(old-path inbound links become broken immediately).',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiBody({ type: MoveDocDto })
  @ApiResponse({ status: 200, description: 'DocMoveResult (moved:true or dryRun preview)' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  @ApiResponse({ status: 403, description: 'PERMISSION_DENIED' })
  @ApiResponse({
    status: 409,
    description:
      'DOC_SOURCE_MISMATCH (non-native); RESOURCE_CONFLICT (no-op or target taken, data.conflictDocId); ' +
      'DOC_CONTENT_CONFLICT (expectedContentHash precondition failed)',
  })
  async move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveDocDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docMoveService.move(id, dto, actor);
  }

  // ─── Link-health recheck（v1.61.0 批次 1：手动重检入口，对齐 routes/recheck 先例）─────────

  @UseGuards(JwtOrApiKeyGuard)
  @Post('docs/:id/link-health/recheck')
  // 动作型端点（重检并覆写存量 health，不创建资源）：POST 默认 201 → 显式 200
  // （doc-route.controller.ts recheck 同款 @HttpCode 先例）
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recheck link health of a single document',
    description:
      'Manually recompute and persist link_health for one document (strict source-relative ' +
      'POSIX path resolution, v1.61.0) and return the latest LinkHealth. ' +
      'Requires write access to the space. ' +
      'Fallback entry for post-migration reconciliation: after the strict-resolution ' +
      "semantic change, re-running this endpoint refreshes the doc's broken-link view " +
      'without touching content/sections.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Latest LinkHealth of the document' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  @ApiResponse({ status: 403, description: 'PERMISSION_DENIED' })
  async recheckDocLinkHealth(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docService.recheckDocLinkHealth(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('doc-spaces/:id/docs/link-health/recheck')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recheck link health of all documents in a space',
    description:
      'Synchronously recompute and persist link_health for every non-deleted doc in the ' +
      'space (strict source-relative POSIX path resolution, v1.61.0) and return ' +
      '{ checked, broken } counts — checked = docs re-scanned, broken = total broken ' +
      'links across all docs. Requires write access to the space. ' +
      'Deployment-time fallback for the strict-resolution semantic change: run once after ' +
      'deploy to surface the newly-broken links under exact source-directory rules.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiResponse({
    status: 200,
    description: 'Space-wide link health rechecked; counts returned',
  })
  @ApiResponse({ status: 403, description: 'PERMISSION_DENIED' })
  async recheckSpaceLinkHealth(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.docService.recalcSpaceLinkHealth(spaceId);
  }
}
