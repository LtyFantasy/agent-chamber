/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：diagram 四个 REST 端点的业务服务
 *     （upsert / read / patch / validate dry-run）
 *
 * [代码职责]
 *   - 写通道收口：upsert/patch 全部委托 DocService.upsert / upsertCore（版本/幂等/
 *     事件/23505 零分叉，plan §0 D4）；本服务只做入口适配（IR 对象 ↔ canonical
 *     文本、patch 应用、入口级幂等 ctx、响应图字段组装）
 *   - 读通道：readDiagram / getDiagramHtml（rendered_html 是 select:false 列，
 *     QB 必须 addSelect 显式取——M-c）
 *   - validate dry-run：完整渲染门预演，零写入零事件
 *
 * [权威文档]
 *   - 主文档: plan .kimi/plans/diagram-ir-v1-plan.md §4.1（REST 端点 + 实现要点）
 *   - 补充: 线上 docs/api-definition.md diagram 小节（read_doc）
 *
 * [关键不变量]
 *   - nit#5：patch/validate 命中非 diagram doc → 400 DIAGRAM_DOC_TYPE_LOCKED
 *     （先于任何 JSON.parse——否则 markdown 会撞 422 stage:'parse'，错误语境混乱）
 *   - patch 入口幂等指纹 = patch payload（patches+expectedContentHash），非派生全文——
 *     否则"首次成功+重试"会因基准已变算出不同内容指纹误 409（plan §4.1/§8 R8）
 *   - validate 恒零副作用；渲染门 422 转 {ok:false, stage, diagnostics...} 响应，
 *     500 基础设施错误照常上抛（Agent 必须能区分 IR 错了 vs 平台坏了）
 *   - docType 守卫先于内容读取：非 diagram 不得进入 patch/validate 的 IR 解析路径
 *
 * [关联代码]
 *   - doc.service.ts upsertCore — diagram 分支（唯一渲染门位/三列写入）
 *   - diagram-patch.ts — RFC 6901/6902 纯函数（DiagramPatchError → 422 映射在本文件）
 *   - diagram-renderer.service.ts — validateAndRender（spawn vendor CLI）
 *   - diagram.controller.ts — REST 装配（权限 ensureCan 在 controller）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ErrorCode,
  DOC_TYPE_DIAGRAM,
  DIAGRAM_PATCH_OPS,
  DOC_VERSION_SOURCE,
  type DiagramDetail,
  type DiagramValidationResult,
  type DiagramDiagnostic,
  type UpsertDiagramResult,
} from '@agent-chamber/shared';
import { Doc } from '../../database/entities/doc.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { DocService } from './doc.service';
import { DiagramRendererService } from './diagram-renderer.service';
import { applyDiagramPatch, DiagramPatchError } from './diagram-patch';
import {
  buildIdempotencyContext,
  tryIdempotentReplay,
  persistIdempotencyStandalone,
} from './doc-idempotency.helper';
import type { UnifiedActor } from '../../common/types/actor.types';
import type { UpsertDiagramDto, PatchDiagramDto, ValidateDiagramDto } from './dto';

/**
 * Diagram 业务服务（写通道委托 DocService 收口；读/校验自持）。
 */
@Injectable()
export class DiagramService {
  private readonly logger = new Logger(DiagramService.name);

  constructor(
    private readonly docService: DocService,
    private readonly diagramRenderer: DiagramRendererService,
    // patch 入口级幂等登记（standalone——快照形状 = 本入口响应含 appliedPatches，
    // 与 upsertCore 内组装的 UpsertDiagramResult 不同，故不借道 upsert 事务内登记）
    @InjectRepository(IdempotencyRecord)
    private readonly idempotencyRepo: Repository<IdempotencyRecord>,
    // read/validate 的 doc 读取（含 addSelect('d.renderedHtml') 显式取隐藏列，M-c）
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
  ) {}

  /**
   * upsert_diagram（PUT /doc-spaces/:id/diagrams）：IR 对象规范化后委托公共 upsert。
   *
   * 幂等指纹 = 规范化 IR 内容（upsert 内层指纹即 canonical 文本）——同语义异格式
   * 的重复提交在内容层 unchanged 早退，重放语义正确。
   * 命中既有非 diagram path → docType 翻转为 diagram（显式工具 = 显式意图，plan §4.1）。
   */
  async upsertDiagram(
    spaceId: string,
    dto: UpsertDiagramDto,
    actor?: UnifiedActor,
  ): Promise<UpsertDiagramResult> {
    const canonical = JSON.stringify(dto.ir, null, 2);
    // upsertCore diagram 分支完成：parse/canonicalize（幂等）→ diagram_type 校验 →
    // R3 仓库证据前置拒绝 → R1 渲染门（仅 hashChanged||forceRechunk）→ 单节合成 →
    // 三列写入；响应已携带 diagramType/render（UpsertDiagramResult 形状）
    const result = await this.docService.upsert(
      spaceId,
      {
        path: dto.path,
        content: canonical,
        title: dto.title,
        summary: dto.summary,
        docType: DOC_TYPE_DIAGRAM,
        category: dto.category,
        tags: dto.tags,
        expectedContentHash: dto.expectedContentHash,
      },
      actor,
      dto.clientRequestId,
    );
    return result as UpsertDiagramResult;
  }

  /**
   * read_diagram（GET /docs/:id/diagram）：解析后 IR 对象 + contentHash + render 元数据。
   *
   * 与 read_doc 的分工：read_doc 对 diagram doc 也能返回 IR 文本全文（合成节 full
   * 内联），但无解析对象/render meta/非图守卫——本端点是图消费的权威通道。
   */
  async readDiagram(docId: string): Promise<DiagramDetail> {
    const doc = await this.findDiagramDocWithSnapshot(docId);
    // IR 全文 = sections 重建（单节合成 level-0 → renderSectionPart 原样返回 content，
    // 逐字节等于落库的规范化 IR 文本——plan §1.1 字节一致性验证）
    const { content } = await this.docService.getContent(docId, true);
    const ir = this.parseStoredIr(content, docId);
    const render = this.renderInfoFromMeta(doc.renderMeta);
    return {
      docId: doc.id,
      path: doc.path,
      title: doc.title,
      summary: doc.summary,
      tags: doc.tags,
      docType: doc.docType,
      diagramType: doc.diagramType,
      ir,
      contentHash: doc.contentHash ?? undefined,
      render: render ?? {
        // 不变量保证 diagram doc 必有 renderMeta（与 renderedHtml 同事务写入）；
        // 走到这里 = 历史烂态兜底（read 侧守卫已在 findDiagramDocWithSnapshot 拦 409）
        renderedAt: '',
        rendererVersion: '',
        qualityProfile: '',
        htmlBytes: 0,
        htmlSha256: '',
        composition: { errors: 0, warnings: 0 },
      },
      updatedAt: doc.updatedAt,
    };
  }

  /**
   * GET /docs/:id/diagram.html：直出 HTML 快照（web iframe srcDoc / 直接访问两用）。
   * 无快照（存量历史 diagram）→ 409 DIAGRAM_SNAPSHOT_MISSING 指路 re-upsert/forceRechunk。
   *
   * lang（读时视图语言覆盖，2026-08-30）：viewer 文案是渲染期烘焙进快照的
   * （模板 i18n 节点 + SVG 文本），前端运行时无法换语言——lang 与存储 IR 的
   * meta.locale（缺省视为 'en'，与渲染器 resolveLocale 回落一致）不一致时，
   * 覆盖 meta.locale 后走与写通道同一道渲染门重渲染直出。**不落库、不写版本**
   * （存储快照保持作者语言，重渲染只是读时视图；避免版本/哈希/快照漂移）。
   * 降级（2+1 评审 blocking 修订）：重渲染段抛 422/500 → warn 日志 + 直出存储
   * 快照（langFallback=true，响应带 X-Diagram-Lang-Fallback 头）——语言匹配
   * 失败 ≠ 图不可见（CJK 宽度下 legend_clearance 硬门存在真实拒绝面）。
   */
  async getDiagramHtml(
    docId: string,
    lang?: 'en' | 'zh-CN',
  ): Promise<{ html: string; doc: Doc; langFallback?: boolean }> {
    const doc = await this.findDiagramDocWithSnapshot(docId);
    if (!lang) {
      return { html: doc.renderedHtml as string, doc };
    }

    // 与存储语言一致 → 直出存储快照（零重渲染成本）
    const { content } = await this.docService.getContent(docId, true);
    const ir = this.parseStoredIr(content, docId);
    const irMeta = ir.meta as { locale?: unknown } | undefined;
    const storedLocale = irMeta?.locale === 'zh-CN' ? 'zh-CN' : 'en';
    if (lang === storedLocale) {
      return { html: doc.renderedHtml as string, doc };
    }

    try {
      // 覆盖 locale 后恒 schema-valid（meta 为 5 型顶层 required 已过写门；lang 值域
      // 被 DTO @IsIn 收口）；qualityProfile 透传存储 render_meta，与写通道同门
      const overridden = { ...ir, meta: { ...(ir.meta as object), locale: lang } };
      const artifacts = await this.diagramRenderer.validateAndRender(overridden, {
        qualityProfile: (doc.renderMeta as { qualityProfile?: unknown } | null)?.qualityProfile,
      });
      return { html: artifacts.html, doc };
    } catch (err) {
      // 只降级重渲染段的 422/500（渲染门拒绝/基础设施故障）；404/400/409 等
      // 业务错误保持原样透出（铁律 #9：代理层不得吞/包装上游错误）
      if (
        err instanceof UnprocessableEntityException ||
        err instanceof InternalServerErrorException
      ) {
        this.logger.warn(
          `diagram.html lang re-render failed for doc ${docId} (lang=${lang}), ` +
            `falling back to stored snapshot: ${err.message}`,
        );
        return { html: doc.renderedHtml as string, doc, langFallback: true };
      }
      throw err;
    }
  }

  /**
   * patch_diagram（PATCH /docs/:id/diagram）：RFC 6901/6902 子集原子应用 →
   * 规范化 → 委托 upsertCore（versionSource='patch'，版本行 source='patch'）。
   *
   * 入口级幂等（standalone 登记）：指纹 = {docId, patches, expectedContentHash}——
   * 首次成功 + 同 key 重试 → 重放首次快照（含 appliedPatches），不因基准漂移误 409。
   * 极端窗口（业务提交后、幂等登记前 crash）的重试退化为 409 DOC_CONTENT_CONFLICT +
   * 重读——fail-safe 方向正确（绝不双写）。
   */
  async patchDiagram(
    docId: string,
    dto: PatchDiagramDto,
    actor?: UnifiedActor,
  ): Promise<UpsertDiagramResult> {
    // expectedContentHash 必填（plan §0 D8 拍板：圆桌多 Agent 共改的裁判机制）——
    // DTO 层 @Length 拦格式；service 层再拦缺失（直调防御，缺省无前提 = 盲写）
    if (!dto.expectedContentHash) {
      throw new BadRequestException({
        message:
          'expectedContentHash is required for patch_diagram (from read_diagram response contentHash); ' +
          'patching without a base hash would be a blind write in multi-agent editing',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    // 入口级幂等 ctx（最外层写入口，照 patchSection/patchByMatch 先例）
    const ctx = buildIdempotencyContext(actor, dto.clientRequestId, {
      docId,
      patches: dto.patches,
      expectedContentHash: dto.expectedContentHash,
    });
    if (ctx) {
      const replay = await tryIdempotentReplay<UpsertDiagramResult>(this.idempotencyRepo, ctx);
      if (replay) return { ...replay, idempotentReplay: true };
    }

    // nit#5：docType 守卫先于内容读取——非 diagram → 400 指路（不得撞 422 parse）
    const doc = await this.docService.findById(docId);
    this.ensureDiagramDoc(doc, 'patch_diagram');

    const { content } = await this.docService.getContent(docId, true);
    const currentIr = this.parseStoredIr(content, docId);
    const nextIr = this.applyPatchesOrThrow(currentIr, dto.patches);

    // 委托 upsertCore（内部乐观锁 = 调用方 expectedContentHash；渲染门/三列/版本
    // 全部继承）。ctx 不传——快照形状不同（本入口响应多 appliedPatches），登记在
    // 下方 standalone 完成（见方法注释的窗口语义说明）
    const result = (await this.docService.upsertCore(
      doc.spaceId,
      {
        path: doc.path,
        content: JSON.stringify(nextIr, null, 2),
        title: doc.title,
        summary: doc.summary ?? undefined,
        // source 透传现存值过隔离检查（与 patchSection/patchByMatch 同款）
        source: doc.source,
        versionSource: DOC_VERSION_SOURCE.PATCH,
        expectedContentHash: dto.expectedContentHash,
      },
      actor,
    )) as UpsertDiagramResult;
    const response: UpsertDiagramResult = { ...result, appliedPatches: dto.patches.length };

    if (ctx) {
      const replayed = await persistIdempotencyStandalone<UpsertDiagramResult>(
        this.idempotencyRepo,
        ctx,
        doc.id,
        response,
      );
      if (replayed) return { ...replayed, idempotentReplay: true };
    }
    return response;
  }

  /**
   * validate_diagram dry-run（POST /doc-spaces/:id/diagrams/validate）：
   * 完整渲染门预演（与写通道同一道门——upsertCore 前置校验 + validateAndRender），
   * **零写入零事件零幂等登记**。渲染门 422 → {ok:false, stage, diagnostics, checks,
   * composition, profile}；500 基础设施错误照常上抛（非 IR 问题不包装成 ok:false）。
   */
  async validateDiagram(
    spaceId: string,
    dto: ValidateDiagramDto,
  ): Promise<DiagramValidationResult> {
    // 模式互斥（语义互斥 = 请求格式错误，400；照 patch_doc 工具侧快速失败范式）
    const hasIr = dto.ir !== undefined;
    const hasDocId = dto.docId !== undefined;
    const hasPath = dto.path !== undefined;
    if (hasIr && (hasDocId || hasPath || dto.patches !== undefined)) {
      throw new BadRequestException({
        message:
          'ir is mutually exclusive with path/docId/patches (mode (a) bare IR vs mode (b) stored-doc simulation)',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (!hasIr && !hasDocId && !hasPath) {
      throw new BadRequestException({
        message: 'provide exactly one mode: {ir} or {path | docId, patches?}',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (hasDocId && hasPath) {
      throw new BadRequestException({
        message: 'docId and path are mutually exclusive locators',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    let irInput: Record<string, unknown>;
    if (hasIr) {
      irInput = dto.ir as Record<string, unknown>;
    } else {
      const doc = hasDocId
        ? await this.docService.findById(dto.docId as string)
        : await this.findDocByPath(spaceId, dto.path as string);
      // nit#5：非 diagram → 400 指路（不得把 markdown 当 IR 解析报 422）
      this.ensureDiagramDoc(doc, 'validate_diagram');
      const { content } = await this.docService.getContent(doc.id, true);
      const currentIr = this.parseStoredIr(content, doc.id);
      irInput = (
        dto.patches && dto.patches.length > 0
          ? this.applyPatchesOrThrow(currentIr, dto.patches)
          : currentIr
      ) as Record<string, unknown>;
    }

    // 与写通道同一道前置门（parse/diagram_type/R3 仓库证据拒绝，DocService.parseDiagramIr）
    // ——stringify 后走字符串入口，规范化幂等保证口径一致
    const preflight = this.docService.parseDiagramIr(JSON.stringify(irInput, null, 2));
    try {
      const artifacts = await this.diagramRenderer.validateAndRender(preflight.irObj, {
        qualityProfile: (preflight.irObj.meta as Record<string, unknown> | undefined)
          ?.quality_profile,
      });
      return {
        ok: true,
        diagnostics: [],
        checks: artifacts.checks,
        composition: artifacts.composition,
        profile: artifacts.meta.qualityProfile,
      };
    } catch (err) {
      // 渲染门 422 → ok:false 修复凭据响应；其余（400 前置校验/500 基础设施）照常上抛
      if (err instanceof UnprocessableEntityException) {
        const res = err.getResponse() as {
          data?: {
            stage?: string;
            diagnostics?: DiagramDiagnostic[];
            checks?: { name: string; ok: boolean; details?: string[] }[];
            composition?: { errors: number; warnings: number };
            profile?: string;
          };
        };
        return {
          ok: false,
          stage: res.data?.stage,
          diagnostics: res.data?.diagnostics ?? [],
          checks: res.data?.checks ?? [],
          composition: res.data?.composition ?? { errors: 0, warnings: 0 },
          // 渲染门 422 自带生效 profile；前置门（parse/R3）尚未到 profile 注入点 → 'standard'
          profile: res.data?.profile ?? 'standard',
        };
      }
      throw err;
    }
  }

  // ─── 内部 ────────────────────────────────────────────────────

  /**
   * diagram doc 读取（含 rendered_html 隐藏列）+ 双守卫：
   * 404 DOC_NOT_FOUND（不存在/软删）→ 400 DIAGRAM_DOC_TYPE_LOCKED（非 diagram，
   * 指路 read_doc）→ 409 DIAGRAM_SNAPSHOT_MISSING（存量无快照，指路 re-upsert）。
   */
  private async findDiagramDocWithSnapshot(docId: string): Promise<Doc> {
    // M-c：rendered_html 为 select:false 列，QB 默认不出——必须 addSelect 显式取
    const doc = await this.docRepo
      .createQueryBuilder('d')
      .addSelect('d.renderedHtml')
      .where('d.id = :id', { id: docId })
      .andWhere('d.deleted_at IS NULL')
      .getOne();
    if (!doc) {
      throw new NotFoundException({
        message: 'Document not found',
        code: ErrorCode.DOC_NOT_FOUND,
      });
    }
    this.ensureDiagramDoc(doc, 'read_diagram');
    if (!doc.renderedHtml) {
      throw new ConflictException({
        message:
          `Diagram snapshot missing for this document (legacy data predating the render gate); ` +
          `re-upsert the IR (upsert_diagram) or forceRechunk via upsert to regenerate the snapshot`,
        code: ErrorCode.DIAGRAM_SNAPSHOT_MISSING,
      });
    }
    return doc;
  }

  /** path 通道定位（validate mode b；spaceId+path+未软删，铁律 #22 判空） */
  private async findDocByPath(spaceId: string, path: string): Promise<Doc> {
    const doc = await this.docRepo
      .createQueryBuilder('d')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.path = :path', { path })
      .andWhere('d.deleted_at IS NULL')
      .getOne();
    if (!doc) {
      throw new NotFoundException({
        message: `Document not found at path '${path}'`,
        code: ErrorCode.DOC_NOT_FOUND,
      });
    }
    return doc;
  }

  /** 非 diagram doc 守卫（nit#5）：400 + 指路正确工具 */
  private ensureDiagramDoc(
    doc: Doc,
    callerTool: 'read_diagram' | 'patch_diagram' | 'validate_diagram',
  ): void {
    if (doc.docType !== DOC_TYPE_DIAGRAM) {
      throw new BadRequestException({
        message:
          `Document is not docType='diagram' (actual: ${JSON.stringify(doc.docType)}) — ` +
          `${callerTool} only serves diagram documents; ` +
          `use read_doc / GET /docs/:id for reading and patch_doc/append_doc for markdown writes`,
        code: ErrorCode.DIAGRAM_DOC_TYPE_LOCKED,
      });
    }
  }

  /**
   * 库存 IR 解析（单节合成 → content 逐字节等于规范化 IR 文本）。
   * 库存内容必已过写入门，parse 失败 = 数据被外部改动 → 500（fail-closed 不静默）。
   */
  private parseStoredIr(content: string, docId: string): Record<string, unknown> {
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new ConflictException({
        message: `Stored diagram IR of doc ${docId} is not parseable (data corrupted outside the write gate); re-upsert the IR to repair`,
        code: ErrorCode.DIAGRAM_SNAPSHOT_MISSING,
      });
    }
  }

  /** patch 应用（DiagramPatchError → 422 DIAGRAM_PATCH_FAILED + 修复凭据） */
  private applyPatchesOrThrow(
    ir: unknown,
    patches: { op: string; path: string; value?: unknown }[],
  ): unknown {
    try {
      return applyDiagramPatch(ir, patches as never);
    } catch (err) {
      if (err instanceof DiagramPatchError) {
        throw new UnprocessableEntityException({
          message: err.message,
          code: ErrorCode.DIAGRAM_PATCH_FAILED,
          data: { pointer: err.pointer, reason: err.reason, supportedOps: [...DIAGRAM_PATCH_OPS] },
        });
      }
      throw err;
    }
  }

  /** render_meta → 响应级渲染信息（缺字段兜底；存量无快照 → undefined 由调用方处理） */
  private renderInfoFromMeta(renderMeta: Record<string, unknown> | null) {
    if (!renderMeta) return undefined;
    const meta = renderMeta as {
      renderedAt?: unknown;
      rendererVersion?: unknown;
      qualityProfile?: unknown;
      htmlBytes?: unknown;
      htmlSha256?: unknown;
      composition?: { errors: number; warnings: number };
    };
    return {
      renderedAt: typeof meta.renderedAt === 'string' ? meta.renderedAt : '',
      rendererVersion: typeof meta.rendererVersion === 'string' ? meta.rendererVersion : '',
      qualityProfile: typeof meta.qualityProfile === 'string' ? meta.qualityProfile : '',
      htmlBytes: typeof meta.htmlBytes === 'number' ? meta.htmlBytes : 0,
      htmlSha256: typeof meta.htmlSha256 === 'string' ? meta.htmlSha256 : '',
      composition: meta.composition ?? { errors: 0, warnings: 0 },
    };
  }
}
