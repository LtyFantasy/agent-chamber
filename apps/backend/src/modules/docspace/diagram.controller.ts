/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：5 个 REST 端点（upsert/read/read.html/patch/validate）
 *
 * [代码职责]
 *   - REST 装配层：权限检查（ensureCan，与 doc.controller.ts 同款分区惯例——
 *     space 级写/读 + doc 级读/写）+ DTO 格式校验（层 1）+ 响应直出（HTML 端点）
 *   - 业务逻辑全部在 DiagramService / DocService.upsertCore（本文件零业务分支）
 *
 * [权威文档]
 *   - 主文档: plan .kimi/plans/diagram-ir-v1-plan.md §4.1（端点表 + M-c addSelect 要点）
 *   - 补充: 线上 docs/api-definition.md diagram 小节（read_doc）
 *
 * [关键不变量]
 *   - 错误透出 = 统一信封 {code,message,data}（all-exceptions.filter）；
 *     4xx 不得包装成 500（铁律 #9）；422 带 {stage, diagnostics[]} 修复凭据
 *   - diagram.html 直出带 CSP/nosniff 头（直接访问场景的纵深防御；web 走 srcdoc）
 *   - PUT 在 space 级、GET/PATCH 在 doc 级的不对称符合既有分区惯例
 *     （doc.controller.ts "Space-scoped doc routes" vs "Global doc routes (by doc ID)"）
 *
 * [关联代码]
 *   - diagram.service.ts — 业务服务
 *   - doc.service.ts upsertCore — diagram 分支（写门唯一落点）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  Controller,
  Get,
  Put,
  Patch,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiBody } from '@nestjs/swagger';
import { DiagramService } from './diagram.service';
import { DocService } from './doc.service';
import { DocSpaceService } from './docspace.service';
import { PermissionService } from '../../common/services/permission.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import type { UnifiedActor } from '../../common/types/actor.types';
import { UpsertDiagramDto, PatchDiagramDto, ValidateDiagramDto, DiagramHtmlQueryDto } from './dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';

/**
 * diagram.html 直出端点的 CSP（直接访问场景的纵深防御——web 实际走 iframe srcDoc
 * + sandbox，本头是第二道防线）：自包含快照只需内联 script/style + data: 图片
 * （brand mark 内联 data URI），其余源全禁。
 *
 * img-src 含 blob:（2026-09-01 导出修复）：栅格化导出（PNG/JPEG/WebP）把序列化
 * SVG 经 URL.createObjectURL 生成 blob: URL 喂给 <img> 再画到 canvas——缺 blob:
 * 时浏览器按 CSP 拦截该图片加载，导出静默失败（console 报
 * "Loading the image 'blob:...' violates CSP img-src data:"）。
 */
const DIAGRAM_HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:";

@ApiTags('Diagrams')
@Controller()
export class DiagramController {
  constructor(
    private readonly diagramService: DiagramService,
    private readonly docService: DocService,
    private readonly docSpaceService: DocSpaceService,
    private readonly permService: PermissionService,
  ) {}

  // ─── Space-scoped diagram routes ─────────────────────────────

  @UseGuards(JwtOrApiKeyGuard)
  @Put('doc-spaces/:id/diagrams')
  @ApiOperation({
    summary: 'Upsert a diagram document (Diagram IR v1)',
    description:
      'Upsert a diagram by spaceId + path. Body carries the IR as a JSON object; the server ' +
      'canonicalizes it (2-space JSON) and runs the fail-closed render gate (schema + geometry + ' +
      'artifact checks) — a rejected IR is never persisted (422 DIAGRAM_VALIDATION_FAILED with ' +
      'data.stage + data.diagnostics[] repair hints). composition.summary.errors always reject; ' +
      'warnings reject only under quality_profile=showcase (missing/invalid profile is injected ' +
      'as standard). Repository evidence (meta.repository / components[].sources) is rejected ' +
      'upfront. Hitting an existing non-diagram path flips its docType to diagram. ' +
      'Requires write access (creator or editor).',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiBody({ type: UpsertDiagramDto })
  @ApiResponse({
    status: 200,
    description: 'Diagram upserted (UpsertDiagramResult with render info)',
  })
  @ApiResponse({
    status: 422,
    description: 'DIAGRAM_VALIDATION_FAILED: render gate rejected the IR',
  })
  async upsertDiagram(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Body() dto: UpsertDiagramDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.diagramService.upsertDiagram(spaceId, dto, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post('doc-spaces/:id/diagrams/validate')
  @ApiOperation({
    summary: 'Validate a diagram IR (dry-run, zero side effects)',
    description:
      'Two mutually exclusive modes: (a) {ir} validates a bare IR object; (b) {path | docId, ' +
      'patches?} simulates JSON patches on the stored IR of an existing diagram doc and validates ' +
      'the result. Runs the same render gate as writes but persists nothing (no doc row, no ' +
      'version, no event). Returns {ok, stage?, diagnostics[], checks[], composition, profile}; ' +
      'a non-diagram doc target → 400 DIAGRAM_DOC_TYPE_LOCKED. Requires read access.',
  })
  @ApiParam({ name: 'id', description: 'DocSpace ID (UUID)', type: String })
  @ApiBody({ type: ValidateDiagramDto })
  @ApiResponse({
    status: 200,
    description: 'Validation result (ok:false carries repair diagnostics)',
  })
  async validateDiagram(
    @Param('id', ParseUUIDPipe) spaceId: string,
    @Body() dto: ValidateDiagramDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const space = await this.docSpaceService.findById(spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.diagramService.validateDiagram(spaceId, dto);
  }

  // ─── Global doc routes (by doc ID) ───────────────────────────

  @UseGuards(JwtOrApiKeyGuard)
  @Get('docs/:id/diagram')
  @ApiOperation({
    summary: 'Read a diagram (parsed IR + render metadata)',
    description:
      'Returns the parsed IR object (not a string), the contentHash optimistic-lock token ' +
      '(required by patch_diagram), and render metadata (qualityProfile/composition/htmlBytes/' +
      'htmlSha256/renderedAt). A non-diagram doc → 400 DIAGRAM_DOC_TYPE_LOCKED (use read_doc); ' +
      'a diagram doc without a snapshot (legacy data) → 409 DIAGRAM_SNAPSHOT_MISSING ' +
      '(re-upsert to regenerate). Requires the same read permission as the document itself.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'DiagramDetail returned successfully' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  async readDiagram(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    return this.diagramService.readDiagram(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('docs/:id/diagram.html')
  @ApiOperation({
    summary: 'Get the rendered diagram HTML snapshot (self-contained viewer)',
    description:
      'Returns the stored self-contained HTML snapshot (inline SVG+CSS+JS) as text/html with ' +
      'a restrictive CSP and X-Content-Type-Options: nosniff. The web reader embeds it via ' +
      'iframe srcdoc + sandbox="allow-scripts". A diagram doc without a snapshot → 409 ' +
      'DIAGRAM_SNAPSHOT_MISSING. Requires the same read permission as the document itself. ' +
      'Optional ?lang=en|zh-CN: when it differs from the stored IR meta.locale, the IR is ' +
      're-rendered read-through in that language (NOT persisted — the stored snapshot keeps ' +
      'the author locale). Only renderer-generated viewer chrome/legend/default text is ' +
      'translated; user-authored node labels/titles stay in the author language. Re-render ' +
      'failure (gate rejection / infra) falls back to the stored snapshot with an ' +
      'X-Diagram-Lang-Fallback: 1 header.',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiQuery({ name: 'lang', required: false, enum: ['en', 'zh-CN'] })
  @ApiResponse({ status: 200, description: 'Self-contained HTML snapshot' })
  @ApiResponse({ status: 404, description: 'DOC_NOT_FOUND' })
  async getDiagramHtml(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
    @Query() query: DiagramHtmlQueryDto,
    @Res() res: Response,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor ?? null, 'read');
    const { html, langFallback } = await this.diagramService.getDiagramHtml(id, query.lang);
    const headers: Record<string, string> = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': DIAGRAM_HTML_CSP,
      'X-Content-Type-Options': 'nosniff',
    };
    // 降级可见性：语言重渲染失败时显式标记（前端可据此提示"该图暂无此语言版"）
    if (langFallback) {
      headers['X-Diagram-Lang-Fallback'] = '1';
    }
    res.set(headers).send(html);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch('docs/:id/diagram')
  @ApiOperation({
    summary: 'Patch a diagram IR (RFC 6901 pointer + RFC 6902 subset)',
    description:
      'Applies replace/add/remove JSON patches to the current IR atomically (all-or-nothing), ' +
      'then re-runs the full render gate on the patched IR. expectedContentHash is REQUIRED ' +
      '(from read_diagram): stale → 409 DOC_CONTENT_CONFLICT (re-read, rebase, retry); bad ' +
      'pointer → 422 DIAGRAM_PATCH_FAILED with {pointer, reason, supportedOps}; patched IR ' +
      'rejected by the gate → 422 DIAGRAM_VALIDATION_FAILED. A non-diagram doc → 400 ' +
      'DIAGRAM_DOC_TYPE_LOCKED. Requires write access (creator or editor).',
  })
  @ApiParam({ name: 'id', description: 'Document ID (UUID)', type: String })
  @ApiBody({ type: PatchDiagramDto })
  @ApiResponse({ status: 200, description: 'Patch applied (UpsertDiagramResult + appliedPatches)' })
  async patchDiagram(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchDiagramDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const doc = await this.docService.findById(id);
    const space = await this.docSpaceService.findById(doc.spaceId);
    await this.permService.ensureCan(space, actor, 'write');
    return this.diagramService.patchDiagram(id, dto, actor);
  }
}
