/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (文档读/文档写 API), plan §1.1-13 (sectionId 不稳定性契约)
 *
 * [踩坑索引]
 *   - Hument 事故（topic msg 6dbc4da3）：stale position fail-open → fail-closed
 *     （2026-08-16）：GET sections @ApiOperation 删掉 "stable cross-update" 失实措辞；
 *     PATCH sections 透传 expectedSectionHash、新增 PATCH /docs/:id/content（match 模式），
 *     前提校验失败 = 409 DOC_CONTENT_CONFLICT / 多命中 = 409 RESOURCE_CONFLICT
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
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ParseIntPipe,
  BadRequestException,
} from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse, ApiBody } from '@nestjs/swagger';
import { DocService } from './doc.service';
import { DocSearchService } from './doc-search.service';
import { DocSpaceService } from './docspace.service';
import { PermissionService } from '../../common/services/permission.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import {
  UpsertDocDto,
  QueryDocDto,
  DocSearchDto,
  BatchUpsertDocsDto,
  DocDetailQueryDto,
  PatchDocSectionDto,
  PatchDocContentDto,
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
      'match + unchanged content returns unchanged normally.',
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
    return this.docService.upsert(spaceId, dto, actor);
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
    return this.docService.patchSection(
      id,
      position,
      dto.content,
      source ?? 'native',
      actor,
      dto.expectedSectionHash,
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
    return this.docService.patchByMatch(
      id,
      dto.oldString,
      dto.newString,
      source ?? 'native',
      actor,
    );
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
