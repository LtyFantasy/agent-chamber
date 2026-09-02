/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (文档读/文档写), plan §4.4 (chunking), plan §1.1-13 (sectionId 不稳定契约)
 *   - 补充: doc history MVP（doc_versions 表，2026-08-18）——所有内容变更写通道
 *     收口于本文件 upsert 事务：同事务插版本快照 + DOC_VERSION_KEEP 剪枝
 *   - 补充: plan patriot-cyclone-deadman.md §1.4（v1.61.0 批次 1：computeLinkHealth 三调用点
 *     sourcePath + recheckDocLinkHealth + recalcSpaceLinkHealth 批量 sections）
 *   - 补充: plan patriot-cyclone-deadman.md §2.1（v1.61.0 批次 2：patchMetadata
 *     metadata-only 写通道——不重切/不落版/不动 contentHash，游戏方 6 条契约）
 *   - 补充: v1.62.0（contentHash 读路径透传）：list/read outline/full/content 读路径
 *     统一返回原始写入 payload 的 SHA-256（乐观锁 token）；它与读出重建正文的
 *     SHA-256 **不可互算**——expectedContentHash 一律用响应返回的同源 token
 *   - 补充: plan fire-jericho-she-hulk.md（v1.63.0 Board 任务 7d918c7b）：写入口
 *     clientRequestId 幂等——upsert/patchSection/patchByMatch/patchMetadata 四入口，
 *     helper 见 doc-idempotency.helper.ts；重放返回 response_snapshot 首次快照，
 *     同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT；patch 借道 upsertCore
 *     事务登记（快照形状 = patch 入口响应），禁止把幂等包裹放进 upsert 内层
 *   - 补充: plan docspace-lazy-tree-v1.md（v1.70.0-dev：findTree/findFacets 只读端点）。
 *     SQL 形态硬约束（plan A1/A2）：WHERE 只用 LIKE 模式（索引友好），禁止 substring
 *     进 WHERE；substring/split_part 只允许在 SELECT/GROUP BY（narrowing 之后）；
 *     plen 由 JS 算好整数传入（归一化 prefix 含尾 / 时 plen = prefix.length + 1，
 *     PG 1-based）；folders total = 分组数子查询 COUNT；docs total = getManyAndCount
 *     双查；一律显式 d.deleted_at IS NULL。改 findTree 前先读 plan「SQL 形态硬约束」节
 *   - 补充: plan diagram-ir-v1-plan.md（Diagram IR v1）：upsertCore diagram 分支——
 *     parse/canonicalize 前置（computeHash 对规范化形态生效）→ R3 仓库证据前置拒绝 →
 *     R1 渲染门仅 hashChanged||forceRechunk 触发（unchanged 零渲染）→ 单节合成
 *     （headingPath=null 刻意差异，绕过 chunkMarkdown）→ title/summary 从 ir.meta
 *     派生 → 三列同事务写入/迁出置 null（不变量：docType='diagram' ⟺
 *     diagram_type/rendered_html 非空）。D9 三拒绝落点 = patchSection/patchByMatch/
 *     appendDocOnce 的 findById 之后；D10 patchMetadata docType 双向守卫在事务内
 *     变更面判定处。渲染门实现见 diagram-renderer.service.ts
 *
 * [踩坑索引]
 *   - headingPath-separator-v1.57.2：headingPath 结构分隔符必须是带空格的 ` § `；标题正文中的
 *     `§3.2` 不能按裸字符拆分，末段标题统一走 shared extractLastHeadingSegment()。
 *   - patch_doc MATCH 模式字节一致性（2026-08-17，Hument 同类事故在 match 面）：工具描述
 *     「read_doc 返回文本与 match 匹配面相同」曾经失实——full 丢首标题 / section 幻影标题
 *     （续 chunk 无标题行）/ 空正文尾部 \n\n 三处字节不一致，复制的 oldString 必 0 命中。
 *     修复：findOne full 分支改 skipDuplicateTitle=false（与 match 面/getContent(full=true)
 *     逐字节同形）；getSection/getSections/getSectionByHeadingQuery 新增 markdown 字段
 *     （renderSectionPart 口径的字节级子串）供 MCP 读侧直用。改渲染规则先跑 docspace 测试
 *   - 任务 e6eaf06d 第二张脸：chunker step 4 段落切分产生的兄弟 chunk 共用同一 headingPath，
 *     重建时若逐个插标题行，同一标题会重复 N 次（生产实证 12~180 次），且「全文读 + upsert
 *     回写」每轮固化重复标题，文档越往返越臃肿；v1.57.3 起 renderSectionPart 仅依据
 *     chunker 持久化的 isContinuation 事实去重，不能再用相邻 headingPath/headingLevel 猜测，
 *     否则合法同名 sibling 标题会被吞掉。修改该逻辑前先跑 docspace 测试验证往返幂等
 *     （长文 round-trip 用例 + docspace-patch.e2e-spec.ts 真实 PG 集成）
 *   - rundedup-continuation-v1.57.3：相邻同路径 section 可能是真实同名标题；chunker 直写
 *     isContinuation=true，renderer 只据事实去重，老服务端缺字段时保留标题、不静默吞正文。
 *   - 互斥查询参数（path= 与 q=）同传是请求格式错误：400 VALIDATION_ERROR，禁止用
 *     RESOURCE_CONFLICT（2026-08-09 修复 edad7a9，原误挂 RESOURCE_CONFLICT）
 *   - Hument 事故（topic msg 6dbc4da3）：patch_doc stale position 在 re-chunk 漂移后
 *     静默写错块（fail-open）→ fail-closed 改造（2026-08-16）：读通道派生 sectionHash
 *     （存储三元组 sha256，**非渲染片段**——渲染依赖 isContinuation 事实，禁止改口径）、
 *     patchSection expectedSectionHash / upsert expectedContentHash 前提校验
 *     （事务内 FOR UPDATE 锁行复核，TOCTOU 加固）、新增 patchByMatch match 模式写
 *     （操作面 = full=true 全文；0 命中 404 / 多命中 409+matchCount / 唯一命中替换）
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释) #21(双层校验) #22(findOne必须判空)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   rundedup-continuation-v1.57.3: 相邻同 headingPath/headingLevel 可能是真实同名 sibling，旧启发式会吞标题。renderer 改为只依据 chunker 持久化的 isContinuation 去重。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocVersion } from '../../database/entities/doc-version.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Board } from '../../database/entities/board.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import {
  ErrorCode,
  AuditAction,
  EventType,
  ResourceType,
  extractLastHeadingSegment,
  DOC_TYPE_DIAGRAM,
  DIAGRAM_TYPES,
  DOC_VERSION_SOURCE,
  DOC_SUMMARY_MAX_LENGTH,
  DOC_TITLE_MAX_LENGTH,
} from '@agent-chamber/shared';
import type {
  DocSummary,
  DocDetail,
  DocSectionOutline,
  DocSectionContent,
  DocSectionItem,
  DocBatchSectionsResult,
  DocFullContent,
  UpsertDocResult,
  PaginatedResponse,
  LinkHealth,
  BatchUpsertItemResult,
  BatchUpsertDocsResult,
  DocVersionSource,
  DocVersionSummary,
  DocVersionDetail,
  PatchDocMetadataResult,
  PatchDocMetadataView,
  AppendDocInput,
  DocTreeResponse,
  DocFacetsResponse,
  DiagramType,
  DiagramRenderMeta,
  DiagramWriteRenderInfo,
  DiagramDiagnostic,
  UpsertDiagramResult,
} from '@agent-chamber/shared';
import { chunkMarkdown, estimateTokens } from './markdown-chunker';
import type { ChunkResult } from './markdown-chunker';
import { DOC_SOURCE_NATIVE } from './doc-constants';
// review-0831 任务 bbd175dc 子项 1：slugify 唯一实现（本文件复制品已删，行为统一为
// 带兜底版——中文分类名 slug 从 '' 变为 's-xxxxxxxx'，属预期修复：按 slug 匹配的
// 分类查询对中文名不再必然不命中）
import { slugify } from './doc-slug.helper';
// review-0831 任务 bbd175dc 子项 2：批量 per-item 错误提取唯一实现（batchUpsert
// 内联复制品已删，与 doc-bundle.service 共用同一 { message, code } 契约）
import { errorOf } from './doc-error.helper';
import { computeLinkHealth } from './link-health';
import { computeLineDiff } from './doc-version-diff';
import { RouteHealthService } from './route-health.service';
import { DiagramRendererService, type DiagramRenderArtifacts } from './diagram-renderer.service';
import type { UpsertDocDto, BatchUpsertItemDto } from './dto';
import { UnifiedActor } from '../../common/types/actor.types';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { EventService } from '../event/event.service';
// v1.63.0 DocSpace 写族幂等（Board 任务 7d918c7b）：helper 与 DocMoveService 共用
import {
  buildIdempotencyContext,
  tryIdempotentReplay,
  persistIdempotencyStandalone,
  insertIdempotencyInTx,
  type DocWriteIdempotencyContext,
} from './doc-idempotency.helper';

/**
 * 小文档全文内联的缺省 token 阈值（?maxFullTokens= 可覆盖，0 = 强制 outline）。
 *
 * rationale：无定位参数的 GET /docs/:id 面向 Agent 消费——小文档（约 2k tokens 内）
 * 逐 section 精读需要 N 次 round-trip + N 段重复元数据，一次性内联全文对 Agent 更优；
 * 大文档仍走 outline + section 精读，避免单次响应打爆 Agent 上下文。
 * 上限 100000 由 DocDetailQueryDto 校验约束（防任意大文档全文内联 = 响应放大攻击面）。
 */
const FULL_CONTENT_TOKEN_THRESHOLD = 2000;

/**
 * 文档版本历史保留上限（doc history MVP，doc_versions 剪枝阈值）
 *
 * rationale：每文档最多保留最近 N=20 个版本。取 20 = 误写安全网（Agent 误写后
 * 能在合理深度内找回旧内容）+ 防 Agent 循环写无界膨胀（每次内容变更都写入一行
 * text 全文快照，无上限 = 高频写文档的存储无限增长）。超出部分在插入新版本的
 * 同一事务内 DELETE 剪掉（见 upsert 事务内剪枝注释）。
 */
const DOC_VERSION_KEEP = 20;

/**
 * 判定错误是否为 DOC_CONTENT_CONFLICT（appendDoc 并发免疫重试循环的唯一重试条件）。
 *
 * 只认这一个错误码：该错误语义 = 「读取→写入窗口内被并发改动」（upsertCore 事务外
 * 快速失败 + 事务内 FOR UPDATE 复核两处抛出），重读重写即可收敛；其他错误
 * （404/409 source/幂等冲突/500 等）直接抛，禁止盲目重试放大副作用。
 */
function isDocContentConflictError(err: unknown): boolean {
  if (!(err instanceof ConflictException)) return false;
  const response = err.getResponse();
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: number }).code === ErrorCode.DOC_CONTENT_CONFLICT
  );
}

@Injectable()
export class DocService {
  /** NestJS 内置 Logger（fire-and-forget 异步任务的错误只记日志不透出，对齐仓内惯例） */
  private readonly logger = new Logger(DocService.name);

  constructor(
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    @InjectRepository(DocSection)
    private readonly sectionRepo: Repository<DocSection>,
    @InjectRepository(DocCategory)
    private readonly categoryRepo: Repository<DocCategory>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(DocSpace)
    private readonly docSpaceRepo: Repository<DocSpace>,
    @InjectRepository(Board)
    private readonly boardRepo: Repository<Board>,
    @InjectRepository(DocVersion)
    private readonly versionRepo: Repository<DocVersion>,
    private readonly eventService: EventService,
    // 循环依赖说明（批次 C1）：本服务触发点注入 RouteHealthService（upsert/remove 内
    // setImmediate 重检），RouteHealthService 又注入本服务复用 sectionExistsByHeadingPath →
    // 互相依赖，双向 forwardRef 是 NestJS 标准解法（plan §2 授权）。
    @Inject(forwardRef(() => RouteHealthService))
    private readonly routeHealthService: RouteHealthService,
    // 幂等记录 repo（v1.63.0 DocSpace 写族幂等）：与业务写同事务插入（主路径）或
    // 独立单插（unchanged 早退 / 23505 winner 分支），重放返回 response_snapshot。
    // helper 实现见 doc-idempotency.helper.ts（DocMoveService 共用同一套）
    @InjectRepository(IdempotencyRecord)
    private readonly idempotencyRepo: Repository<IdempotencyRecord>,
    // Diagram IR v1 渲染门（plan diagram-ir-v1-plan.md §3.2-3.3）：upsertCore diagram
    // 分支在 hashChanged||forceRechunk 时同步调 validateAndRender（fail-closed，
    // 失败即整单拒绝不落库）。markdown 文档路径零开销（仅 effectiveDocType==='diagram'
    // 时触及本依赖）。
    private readonly diagramRenderer: DiagramRendererService,
  ) {}

  // ─── Helpers ─────────────────────────────────────────────────

  /**
   * Derive topicId and boardId from a DocSpace.
   * If space has boardId, derive topicId from board; otherwise use space.topicId.
   *
   * public（v1.60.0-dev）：DocMoveService 事件发射复用同一派生路径——所有 doc 事件
   * （created/updated/deleted/moved）的 topicId/boardId 必须同源，SSE actor 过滤下
   * 可见性语义不分裂（对齐 906a5a3 事件载荷收口）。
   */
  async getSpaceEventContext(spaceId: string): Promise<{
    topicId: string | null;
    boardId: string | null;
  }> {
    const space = await this.docSpaceRepo
      .createQueryBuilder('ds')
      .select(['ds.id', 'ds.board_id', 'ds.topic_id'])
      .where('ds.id = :id', { id: spaceId })
      .andWhere('ds.deleted_at IS NULL')
      .getRawOne<{ ds_board_id: string | null; ds_topic_id: string | null }>();

    if (!space) {
      return { topicId: null, boardId: null };
    }

    const boardId = space.ds_board_id ?? null;
    let topicId = space.ds_topic_id ?? null;

    // If space is attached to a board, derive topicId from board
    if (boardId) {
      const board = await this.boardRepo.findOne({
        where: { id: boardId },
        select: ['id', 'topicId'],
      });
      topicId = board?.topicId ?? null;
    }

    return { topicId, boardId };
  }

  /** Compute sha256 hex of content string. */
  private computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * 派生 section 锚点哈希（写前提校验用，fail-closed 改造的读侧契约）。
   *
   * 纯派生不落库：DocSection 的存储三元组仍是哈希输入，读时算给调用方抄、
   * 写时（patchSection expectedSectionHash）重算比对；isContinuation 不参与哈希。
   *
   * ⚠️ 输入 = **存储三元组**（headingPath/headingLevel/content），不是渲染片段
   * （架构评审钉死）：渲染片段包含标题恢复规则，若用渲染文本算 hash，修改渲染策略
   * 会导致同一 section 的锚点变化——错误耦合。
   * 禁止把本方法「优化」成渲染文本口径。headingPath 为 null（headingLevel 0 文首段）
   * 时按空串参与，保证确定性。
   */
  private computeSectionHash(section: {
    headingPath: string | null;
    headingLevel: number;
    content: string;
  }): string {
    return createHash('sha256')
      .update(`${section.headingPath ?? ''}\n${section.headingLevel}\n${section.content}`)
      .digest('hex');
  }

  /** Extract first paragraph (≤ maxLen) from text for auto-summary. */
  private extractFirstParagraph(text: string, maxLen = DOC_SUMMARY_MAX_LENGTH): string {
    const firstPara = text.split('\n\n')[0]?.trim() || text.slice(0, maxLen);
    return firstPara.length > maxLen ? firstPara.slice(0, maxLen) : firstPara;
  }

  /**
   * Resolve category by name within a space.
   * Looks up by name or slug; creates it if not found (slug derived via slugify).
   * Returns categoryId (or null if no category name given).
   */
  private async resolveCategory(spaceId: string, categoryName?: string): Promise<string | null> {
    if (!categoryName) return null;

    // Services-only existence check: find category by name or slug in this space
    const existing = await this.categoryRepo
      .createQueryBuilder('dc')
      .where('dc.space_id = :spaceId', { spaceId })
      .andWhere('dc.deleted_at IS NULL')
      .andWhere('(dc.name = :name OR dc.slug = :slug)', {
        name: categoryName,
        slug: slugify(categoryName),
      })
      .getOne();

    if (existing) return existing.id;

    // Auto-create category (slug derived from name, aligned with W2 category logic)
    const slug = slugify(categoryName);
    const cat = this.categoryRepo.create({
      spaceId,
      name: categoryName,
      slug,
      description: null,
      sortOrder: 0,
    });
    const saved = await this.categoryRepo.save(cat);
    return saved.id;
  }

  /**
   * 只解析既有分类（resolve-only，v1.61.0 批次 2 metadata-only patch 用）。
   *
   * 与 resolveCategory 的查找段同款（name 或 slug 命中空间内未软删分类），
   * 但**不命中时返回 null 而非自动创建**——metadata patch 默认防拼写产生近似分类，
   * 调用方据 null 抛 404 DOC_CATEGORY_NOT_FOUND（显式 allowCreateCategory 才走
   * resolveCategory 自动创建路径）。
   *
   * @param spaceId 目标空间 ID
   * @param categoryName 分类名（空/undefined → null，与 resolveCategory 对齐）
   * @returns 命中分类的 ID；未命中返回 null
   */
  private async findCategoryByName(spaceId: string, categoryName?: string): Promise<string | null> {
    if (!categoryName) return null;

    const existing = await this.categoryRepo
      .createQueryBuilder('dc')
      .where('dc.space_id = :spaceId', { spaceId })
      .andWhere('dc.deleted_at IS NULL')
      .andWhere('(dc.name = :name OR dc.slug = :slug)', {
        name: categoryName,
        slug: slugify(categoryName),
      })
      .getOne();

    return existing?.id ?? null;
  }

  /** Build a DocSummary from a Doc entity. */
  private toSummary(doc: Doc): DocSummary {
    return {
      id: doc.id,
      spaceId: doc.spaceId,
      categoryId: doc.categoryId,
      path: doc.path,
      title: doc.title,
      summary: doc.summary,
      docType: doc.docType,
      // Diagram IR v1：反正范化列直读透传（列表/过滤免解析 IR；非 diagram 为 null）
      diagramType: doc.diagramType ?? null,
      tags: doc.tags,
      source: doc.source,
      sourceSha: doc.sourceSha,
      sectionCount: doc.sectionCount,
      tokenEstimate: doc.tokenEstimate,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      // 原始写入 payload 的 SHA-256（乐观锁 token）；NULL → 省略（list/read 读路径
      // 均携带 contentHash，保证"凡读路径皆有 token"契约；见 DocSummary.contentHash 注释）
      contentHash: doc.contentHash ?? undefined,
    };
  }

  // ─── CRUD ────────────────────────────────────────────────────

  /** Raw find by ID, no permission check. Throws DOC_NOT_FOUND if missing or soft-deleted. */
  async findById(id: string): Promise<Doc> {
    const doc = await this.docRepo
      .createQueryBuilder('d')
      .where('d.id = :id', { id })
      .andWhere('d.deleted_at IS NULL')
      .getOne();

    if (!doc) {
      throw new NotFoundException({
        message: 'Document not found',
        code: ErrorCode.DOC_NOT_FOUND,
      });
    }
    return doc;
  }

  /**
   * Upsert a document by spaceId + path.
   *
   * - contentHash (sha256) unchanged → { unchanged: true }, no section rebuild
   * - forceRechunk=true：内容 hash 相同也强制重建 sections（债 B——修复 chunk 级
   *   section 元数据损坏的正式路径，如 heading_path/is_continuation 被直改出错）。
   *   语义（plan 决策 #9）：走事务重建路径（删旧插新 sections），但**跳过**版本
   *   快照插入 + 剪枝（版本契约 = contentHash 变化才落版，见 hashChanged 守卫）；
   *   doc 元数据照常刷新（updatedAt bump 是预期语义）；响应带 `rechunked: true`
   *   （unchanged 恒不出现）；DOC_UPDATED 事件携带 rechunked 上下文。
   * - changed → transaction: delete old sections, insert new, update metadata
   * - category by name resolution (auto-create if not found)
   * - summary defaults to first section's first paragraph (≤500 chars)
   * - source isolation: existing doc with non-matching source → 409
   * - expectedContentHash（可选乐观锁，v1.57 fail-closed 改造）：携带时校验现存
   *   doc 的 contentHash——doc 不存在或 hash 不符 → 409 DOC_CONTENT_CONFLICT；
   *   hash 相符且内容未变 → unchanged 正常返回（不算冲突）。校验在**事务内**
   *   FOR UPDATE 锁行后复核（TOCTOU 加固，见事务内注释）；事务外同款检查只是
   *   快速失败路径。
   *   ⚠️ forceRechunk 与 expectedContentHash 组合：hash 相符 + forceRechunk →
   *   **不**早退（强制重建），前提校验通过即正常执行重建。
   * - versionSource（内部写通道标记，doc history MVP）：区分版本来源
   *   'upsert'（缺省，直接 upsert 端点）/ 'patch'（patchSection/patchByMatch 转调）/
   *   'import'（batchUpsert 批量导入转调）。不进 DTO 校验层——纯 Service 内部
   *   传参，controller 直调不传即 'upsert'。
   * - 23505 concurrent catch → re-query existing doc (idempotency)
   * - v1.63.0 幂等（Board 任务 7d918c7b）：可选 clientRequestId——重放返回首次响应
   *   快照 + idempotentReplay:true（零副作用）；同 key 不同 payload → 409
   *   IDEMPOTENCY_KEY_CONFLICT。patchSection/patchByMatch 借道本方法的事务写入，
   *   通过 upsertCore 的 ctx 参数共享同一套事务内登记机制。
   */
  async upsert(
    spaceId: string,
    dto: {
      path: string;
      content: string;
      title?: string;
      summary?: string;
      docType?: string;
      category?: string;
      tags?: string[];
      source?: string;
      sourceSha?: string;
      expectedContentHash?: string;
      versionSource?: DocVersionSource;
      forceRechunk?: boolean;
    },
    actor?: UnifiedActor,
    clientRequestId?: string,
  ): Promise<UpsertDocResult> {
    // 幂等包裹（最外层写入口）：无键零开销旁路；有键先查重放——命中直接返回首次
    // 快照（跳过 unchanged 短路等一切后续逻辑，保证重放响应与首次逐字段一致）。
    // requestHash 只含入口业务字段（versionSource 是内部传参不参与指纹）。
    const ctx = buildIdempotencyContext(actor, clientRequestId, {
      path: dto.path,
      content: dto.content,
      title: dto.title,
      summary: dto.summary,
      docType: dto.docType,
      category: dto.category,
      tags: dto.tags,
      source: dto.source,
      sourceSha: dto.sourceSha,
      expectedContentHash: dto.expectedContentHash,
      forceRechunk: dto.forceRechunk,
    });
    if (ctx) {
      const replay = await tryIdempotentReplay<UpsertDocResult>(this.idempotencyRepo, ctx);
      if (replay) return { ...replay, idempotentReplay: true };
    }
    return this.upsertCore(spaceId, dto, actor, ctx);
  }

  /**
   * upsert 业务内核（upsert 公开入口的主体；patchSection/patchByMatch 转调时携带
   * 各自入口的幂等 ctx——requestHash 是 patch 入口 payload 的指纹而非本方法的）。
   *
   * public（Diagram IR v1）：内部收口，外部仅 DiagramService patch 入口可直调
   * （patchSection/patchByMatch/appendDoc 本就同模式直调，只是它们长在本类内部）——
   * 所有内容变更写通道必须收口于本事务，禁止另起写管线（版本/幂等/事件/23505 漂移源）。
   *
   * @param ctx 幂等上下文（null/undefined = 无键旁路）；携带时在三个成功出口登记
   *   幂等记录：① unchanged 早退（独立单插）② 主事务内（与业务写同事务）
   *   ③ 23505 path-winner catch（独立单插）
   */
  async upsertCore(
    spaceId: string,
    dto: {
      path: string;
      content: string;
      title?: string;
      summary?: string;
      docType?: string;
      category?: string;
      tags?: string[];
      source?: string;
      sourceSha?: string;
      expectedContentHash?: string;
      versionSource?: DocVersionSource;
      forceRechunk?: boolean;
    },
    actor?: UnifiedActor,
    ctx?: DocWriteIdempotencyContext | null,
  ): Promise<UpsertDocResult> {
    const source = dto.source || DOC_SOURCE_NATIVE;

    // Check existing doc
    const existing = await this.docRepo
      .createQueryBuilder('d')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.path = :path', { path: dto.path })
      .andWhere('d.deleted_at IS NULL')
      .getOne();

    // Source isolation check
    if (existing) {
      if (existing.source !== source) {
        throw new ConflictException({
          message: `Document source '${existing.source}' does not match request source '${source}'`,
          code: ErrorCode.DOC_SOURCE_MISMATCH,
        });
      }
    }

    // ── Diagram IR v1 分支前置（plan §3.3，D4 写通道收口）──────────────────
    // effectiveDocType = 请求显式 docType ?? 现存 docType——通用 upsert 不传 docType 时
    // 继承现存值：diagram doc 上的 markdown 内容写入因此仍撞图校验门（fail-closed，
    // 不可能误腐化）；upsert_diagram 命中非 diagram path 则显式翻转为 diagram。
    // parse + canonicalize 是纯 CPU（微秒级），保持前置使 computeHash 对规范化形态生效
    // （unchanged 短路对规范化形态判定——同语义异格式 IR 二次 upsert 正确早退）；
    // 渲染动作按 R1 修订置于 unchanged 短路**之后**（见下方 hashChanged 处注释）。
    const effectiveDocType = dto.docType ?? existing?.docType ?? null;
    let diagramIr: {
      irObj: Record<string, unknown>;
      diagramType: DiagramType;
      canonical: string;
    } | null = null;
    if (effectiveDocType === DOC_TYPE_DIAGRAM) {
      diagramIr = this.parseDiagramIr(dto.content);
      // 规范化形态入管线：contentHash / doc_versions 快照 / bundle 导出全部基于
      // canonical（JSON.parse→stringify(2)），二次 upsert 同语义 IR 才能 hash 命中
      dto.content = diagramIr.canonical;
    }

    const computedHash = this.computeHash(dto.content);

    if (existing) {
      // expectedContentHash 乐观锁——事务外快速失败路径（fail-closed 改造）：
      // 此刻 hash 已不符则直接 409，不必进事务；权威校验在事务内 FOR UPDATE 后复核
      // （防「事务外校验通过 → 并发写入 → 事务内覆盖」的 TOCTOU 窗口）。
      if (
        dto.expectedContentHash !== undefined &&
        existing.contentHash !== dto.expectedContentHash
      ) {
        throw new ConflictException({
          message:
            `expectedContentHash mismatch: document was modified since the caller's read ` +
            `(expected ${dto.expectedContentHash}, current ${existing.contentHash}); re-read the document and retry`,
          code: ErrorCode.DOC_CONTENT_CONFLICT,
          data: { currentContentHash: existing.contentHash },
        });
      }

      // Unchanged check（债 B：forceRechunk 短路豁免）——hash 相同且未要求强制重建
      // 才走 unchanged 早退；hash 相同 + forceRechunk=true 继续进入事务重建路径
      // （section 元数据损坏的修复入口，响应带 rechunked:true）。
      // R1（Diagram IR v1）：unchanged 重放**零渲染**——unchanged 内容库存时必已过门，
      // 跳过渲染安全；三列保持库存快照不动。
      if (existing.contentHash === computedHash && !dto.forceRechunk) {
        // Backfill gap: docs ingested before link_health existed keep NULL forever
        // on no-op re-ingests. If content is unchanged but link_health is missing,
        // compute and persist it now (still an "unchanged" result for the caller).
        if (!existing.linkHealth) {
          const spaceDocs = await this.docRepo
            .createQueryBuilder('d')
            .select(['d.id', 'd.path'])
            .where('d.space_id = :spaceId', { spaceId })
            .andWhere('d.deleted_at IS NULL')
            .getMany();
          const docIds = new Set(spaceDocs.map((d) => d.id));
          const paths = new Set(spaceDocs.map((d) => d.path));
          const backfill: LinkHealth = computeLinkHealth(dto.content, existing.path, {
            paths,
            docIds,
          });
          await this.docRepo
            .createQueryBuilder()
            .update('Doc')
            .set({ linkHealth: backfill as unknown as Record<string, unknown> })
            .where('id = :id', { id: existing.id })
            .execute();
        }

        // sourceSha 刷新（v1.42 B6，last-verified 语义关键）：contentHash 相同（内容未变）
        // 但 payload 携带的 sha 与现存不同 → 仅更新 source_sha 列，不碰 sections/contentHash/
        // 其他元数据，响应仍 unchanged:true。理由：sourceSha 语义 = "内容在此 sha 验证一致"，
        // 每次 sync 都是一次验证（sync 时统一取 git rev-parse HEAD），unchanged 文档也必须
        // 刷新验证点，否则旧 sha 会误显 stale。payload 不带 sourceSha（如 native 编辑）→
        // 完全照旧早退，不产生任何写操作。
        if (dto.sourceSha !== undefined && existing.sourceSha !== dto.sourceSha) {
          await this.docRepo
            .createQueryBuilder()
            .update('Doc')
            .set({ sourceSha: dto.sourceSha })
            .where('id = :id', { id: existing.id })
            .execute();
        }
        const unchangedResult: UpsertDiagramResult = {
          id: existing.id,
          path: existing.path,
          sectionCount: existing.sectionCount,
          tokenEstimate: existing.tokenEstimate,
          unchanged: true,
          contentHash: existing.contentHash ?? undefined,
          // Diagram IR v1：diagram doc 的 unchanged 早退同样携带图信息（库存快照元数据，
          // 不触发重渲染）——upsert_diagram 响应形状在各出口一致
          ...(existing.docType === DOC_TYPE_DIAGRAM
            ? {
                diagramType: existing.diagramType,
                render: this.diagramRenderInfoFromMeta(existing.renderMeta),
              }
            : {}),
        };
        // 幂等登记（plan 设计决定：unchanged 也写幂等记录——重放返回 unchanged 快照，
        // 语义一致）。此出口在主事务外早退 → 独立单插；并发同 key 抢先时改用对方快照。
        if (ctx) {
          const replayed = await persistIdempotencyStandalone<UpsertDocResult>(
            this.idempotencyRepo,
            ctx,
            existing.id,
            unchangedResult,
          );
          if (replayed) return { ...replayed, idempotentReplay: true };
        }
        return unchangedResult;
      }
    } else if (dto.expectedContentHash !== undefined) {
      // 乐观锁语义：对不存在的文档无法断言前提（调用方持有的 hash 无所指）→ 409，
      // 不得静默降级为新建（那会把「我以为在改旧文档」变成「意外创建新文档」）
      throw new ConflictException({
        message:
          `expectedContentHash provided but document does not exist at path '${dto.path}'; ` +
          `re-read the document and retry`,
        code: ErrorCode.DOC_CONTENT_CONFLICT,
        data: { currentContentHash: null },
      });
    }

    // Track whether this is a create (for created flag in result)
    const isCreate = !existing;

    // 债 B 版本守卫：内容 hash 是否真的变化（新建 = 恒 true）。
    // forceRechunk 时 hash 可能相同（内容未变但强制重建），版本契约 = 「contentHash
    // 变化才落版」——hash 未变的重切**不写** doc_versions 版本行（见事务内守卫）。
    const hashChanged = existing ? existing.contentHash !== computedHash : true;

    // ── Diagram IR v1 渲染门（plan §3.3 R1 修订顺序）──────────────────────
    // 渲染只发生在内容真变更（hashChanged）或 forceRechunk（派生数据修复入口，
    // rendered_html 是派生数据）时——unchanged 重放 / stale hash 409 / bundle 重复
    // 导入都零渲染（unchanged 短路已在上方早退）。校验+渲染全部在事务**之前**完成，
    // 失败即抛（422 IR 内容问题 / 500 渲染器基础设施问题），此刻零写入——无 sections、
    // 无版本行、无事件、无幂等记录（同 key 重试会重新校验，语义正确）。
    let diagramArtifacts: DiagramRenderArtifacts | null = null;
    if (diagramIr && (hashChanged || dto.forceRechunk)) {
      diagramArtifacts = await this.diagramRenderer.validateAndRender(diagramIr.irObj, {
        qualityProfile: (diagramIr.irObj.meta as Record<string, unknown> | undefined)
          ?.quality_profile,
      });
    }

    // Pre-compute category, title, summary
    const categoryId = await this.resolveCategory(spaceId, dto.category);

    // 分块策略（plan §1.1）：diagram → 单节合成（position=0, headingLevel=0,
    // headingPath=null, headingText=null, content=规范化 IR 全文, isContinuation=false,
    // tokenEstimate=CJK 估算）——绕过 chunkMarkdown：markdown 语义切分（ATX 标题 +
    // >4000 字符段落二切）对 JSON 无意义且有字节一致性风险。
    // ⚠️ 合成节 headingPath=null 与 chunker level-0 产物（headingPath=文档 title）是
    // **刻意差异**——IR 无标题层级语义；全部消费路径已验证 null 安全（搜索 trigger
    // COALESCE / reconstructContent / link_health / bundle / outline / positions 批量读）。
    // SectionInput = ChunkResult 放宽 headingPath 可空（chunker 契约恒 string，不污染其类型）
    type SectionInput = Omit<ChunkResult, 'headingPath'> & { headingPath: string | null };
    const chunks: SectionInput[] = diagramIr
      ? [
          {
            position: 0,
            headingPath: null,
            headingText: null,
            headingLevel: 0,
            content: dto.content,
            tokenEstimate: estimateTokens(dto.content),
            isContinuation: false,
          },
        ]
      : chunkMarkdown(dto.content, dto.title || dto.path);
    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenEstimate, 0);
    // title 派生：diagram → dto.title ?? ir.meta.title（截 200）?? path——IR 无 ATX
    // 标题，不拦截会把 title 写成 path（extractHeadingFromContent 对 JSON 恒 null）
    const irMetaTitle = diagramIr ? this.extractIrMetaTitle(diagramIr.irObj) : null;
    const autoTitle = diagramIr
      ? dto.title || irMetaTitle || dto.path
      : dto.title || this.extractHeadingFromContent(dto.content) || dto.path;
    // summary 派生：diagram → dto.summary ?? `${diagramType} 图：${ir.meta.title}`（截 500）
    // ——现状首段派生对 JSON 会截出 `"schema_version": 1,` 这种无信息片段
    const summary =
      dto.summary ??
      (diagramIr
        ? (irMetaTitle
            ? `${diagramIr.diagramType} 图：${irMetaTitle}`
            : `${diagramIr.diagramType} 图`
          ).slice(0, DOC_SUMMARY_MAX_LENGTH)
        : chunks.length > 0
          ? this.extractFirstParagraph(chunks[0].content, DOC_SUMMARY_MAX_LENGTH)
          : null);

    // Link health: query all docs in space for candidate resolution (light query, id+path only)
    const spaceDocs = await this.docRepo
      .createQueryBuilder('d')
      .select(['d.id', 'd.path'])
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .getMany();

    // Include the current doc's own id (for self-referential link detection:
    // the doc may reference itself via /docs/<spaceId>?doc=<ownId> — valid)
    const docIds = new Set(spaceDocs.map((d) => d.id));
    const paths = new Set(spaceDocs.map((d) => d.path));
    // Also add the current doc's id/path (in case it's new and not yet in DB)
    if (existing) {
      docIds.add(existing.id);
      paths.add(existing.path);
    }

    // sourcePath = dto.path（最终落库 path——upsert 无 path 归一化，查询与创建均直存
    // dto.path，v1.61.0 严格源目录解析的基准与落库值严格一致）
    const linkHealth: LinkHealth = computeLinkHealth(dto.content, dto.path, { paths, docIds });

    try {
      // 事务返回 { doc, assembled }：doc 供事务后 audit/event 使用；assembled 是
      // 与幂等快照同引用的最终响应（v1.63.0）
      const { doc: result, assembled } = await this.docRepo.manager.transaction(async (manager) => {
        const docRepo = manager.getRepository(Doc);
        const sectionRepo = manager.getRepository(DocSection);

        let doc: Doc;

        if (existing) {
          let target = existing;

          // TOCTOU 加固（fail-closed 改造，架构评审拍板）：expectedContentHash 携带时，
          // 事务内对 doc 行 SELECT ... FOR UPDATE 锁行后重读比对——事务外的 existing
          // 查询与事务写入之间有并发窗口，两个并发写可双双通过事务外校验再互相覆盖
          // （乐观锁失效，Hument 事故的多 agent 变体）。锁行后复核，不符即抛 409 回滚。
          // 仅在携带前提校验时加锁：缺省调用保持现状行为（行锁本就会在 UPDATE 时获取，
          // 这里只是提前到写前并附加重读比对），不改变无前提请求的执行路径。
          if (dto.expectedContentHash !== undefined) {
            const locked = await docRepo
              .createQueryBuilder('d')
              .setLock('pessimistic_write')
              .where('d.id = :id', { id: existing.id })
              .andWhere('d.deleted_at IS NULL')
              .getOne();

            if (!locked || locked.contentHash !== dto.expectedContentHash) {
              throw new ConflictException({
                message:
                  `expectedContentHash mismatch (in-transaction recheck): document was modified ` +
                  `concurrently (expected ${dto.expectedContentHash}, current ${locked?.contentHash ?? '<deleted>'}); ` +
                  `re-read the document and retry`,
                code: ErrorCode.DOC_CONTENT_CONFLICT,
                data: { currentContentHash: locked?.contentHash ?? null },
              });
            }
            target = locked;
          }

          // Delete old sections (CASCADE handles FK, but we delete explicitly for clarity)
          await sectionRepo
            .createQueryBuilder()
            .delete()
            .where('doc_id = :docId', { docId: target.id })
            .execute();

          // Update metadata
          target.title = autoTitle;
          target.summary = summary;
          // Diagram IR v1 三列维护（不变量：docType='diagram' ⟺ diagram_type/rendered_html
          // 非空，铁律 #18 断言点）——先捕获迁出前状态，再赋新 docType
          const wasDiagram = target.docType === DOC_TYPE_DIAGRAM;
          target.docType = dto.docType ?? target.docType;
          if (target.docType === DOC_TYPE_DIAGRAM) {
            // diagram 分支：写反正范化图类型 + 渲染产物（artifacts 在本路径必然已渲染
            // ——能进事务 = hashChanged||forceRechunk = 已过渲染门；防御性 ?? 保留旧值不破坏）
            target.diagramType = diagramIr?.diagramType ?? target.diagramType;
            target.renderedHtml = diagramArtifacts?.html ?? target.renderedHtml;
            target.renderMeta =
              (diagramArtifacts?.meta as unknown as Record<string, unknown>) ?? target.renderMeta;
          } else if (wasDiagram) {
            // docType 迁出（显式 dto.docType='note' 等，plan §4.1 防呆矩阵唯一合法
            // 迁出通道）：三列同置 null——不留"非 diagram 带渲染快照"的烂态
            target.diagramType = null;
            target.renderedHtml = null;
            target.renderMeta = null;
          }
          target.tags = dto.tags ?? target.tags;
          target.categoryId = categoryId ?? target.categoryId;
          target.contentHash = computedHash;
          // 内容变更时刷新 last-verified sha（sync 携带则覆盖；native 编辑不带 sha 保留旧值——
          // 旧 sha 将显 stale，正是消费端 doc.sourceSha vs 空间 maxSha 新鲜度比较的用途）
          target.sourceSha = dto.sourceSha ?? target.sourceSha;
          target.sectionCount = chunks.length;
          target.tokenEstimate = totalTokens;
          target.linkHealth = linkHealth as unknown as Record<string, unknown>;
          doc = await docRepo.save(target);
        } else {
          // Create new（diagram 新建：effectiveDocType 来自 dto.docType，渲染门已过）
          doc = docRepo.create({
            spaceId,
            categoryId,
            path: dto.path,
            title: autoTitle,
            summary,
            docType: dto.docType ?? null,
            // Diagram IR v1 三列（非 diagram 恒 null）
            diagramType: diagramIr?.diagramType ?? null,
            renderedHtml: diagramArtifacts?.html ?? null,
            renderMeta: (diagramArtifacts?.meta as unknown as Record<string, unknown>) ?? null,
            tags: dto.tags ?? [],
            source,
            contentHash: computedHash,
            sourceSha: dto.sourceSha ?? null,
            sectionCount: chunks.length,
            tokenEstimate: totalTokens,
            linkHealth: linkHealth as unknown as Record<string, unknown>,
            createdBy: actor?.id ?? 'system',
          });
          doc = await docRepo.save(doc);
        }

        // Insert new sections
        if (chunks.length > 0) {
          const sectionEntities = chunks.map((c) =>
            sectionRepo.create({
              docId: doc.id,
              position: c.position,
              headingPath: c.headingPath,
              // 债 A：本地标题列直写（chunker 清洗值；level-0 文首段为 null）
              headingText: c.headingText,
              headingLevel: c.headingLevel,
              isContinuation: c.isContinuation,
              content: c.content,
              tokenEstimate: c.tokenEstimate,
            }),
          );
          await sectionRepo.save(sectionEntities);
        }

        // ── 版本历史快照（doc history MVP）──────────────────────────
        // 收口点语义：所有内容变更写通道（直接 upsert / patchSection /
        // patchByMatch / batch import）最终都经过本事务，而 unchanged 幂等短路
        // 已在事务外早退——正常情况下能执行到这里必然 contentHash 变化（内容真的改了）。
        // ⚠️ 债 B 例外（hashChanged 守卫）：forceRechunk 强制重建时 hash 可能相同，
        // 本段被守卫跳过——版本契约 = 「contentHash 变化才落版」，内容未变的纯重切
        // 不污染编辑历史（plan 决策 #3）。
        // 并发安全：本段位于 doc.save（UPDATE 非新建路径持有 doc 行锁）之后，
        // 同一文档的并发写被行锁串行化——后到事务读 MAX(version) 时先到事务
        // 已提交，version 单调递增且不重复；同 path 并发新建由 23505 幂等 catch
        // 兜底（败者不写版本，胜者事务内已写）。
        if (hashChanged) {
          const versionRepo = manager.getRepository(DocVersion);
          const versionSource = dto.versionSource ?? DOC_VERSION_SOURCE.UPSERT;
          const maxVersion = await versionRepo
            .createQueryBuilder('v')
            .select('MAX(v.version)', 'max')
            .where('v.doc_id = :docId', { docId: doc.id })
            .getRawOne<{ max: string | null }>();
          // 单调递增不归零：新版本号 = 历史最大 +1——剪枝删除旧版本后不回填，
          // version 作为稳定标识不随剪枝漂移（新增可能跳号，MIN 不再从 1 开始）
          const nextVersion = Number(maxVersion?.max ?? 0) + 1;
          await versionRepo.save(
            versionRepo.create({
              docId: doc.id,
              version: nextVersion,
              contentHash: computedHash,
              content: dto.content,
              authorActorId: actor?.id ?? 'system',
              source: versionSource,
            }),
          );
          // 保留策略（DOC_VERSION_KEEP=20）：同事务剪掉超出保留上限的最旧版本。
          // 剪枝条件 = version < 新版本号-上限+1（按单调版本号而非 count——与
          // 「删旧不归零」语义自洽）。快照插入与剪枝同事务 → 读侧永远看不到
          // 中间态（短时间超过 20 个版本的窗口不存在）。
          await versionRepo
            .createQueryBuilder()
            .delete()
            .where('doc_id = :docId', { docId: doc.id })
            .andWhere('version < :keeperFloor', { keeperFloor: nextVersion - DOC_VERSION_KEEP + 1 })
            .execute();
        }

        // ── v1.63.0 幂等：最终响应在事务内组装并落快照 ────────────────────
        // 「业务提交 ⟺ 快照可查」原子性：快照与业务写同事务，crash/回滚不留半状态。
        // rechunked 判断沿用事务前算好的 hashChanged（实体已被原地改写，见上）。
        // Diagram IR v1：diagram 写携带 diagramType + render（本次渲染产物元数据）——
        // upsert_diagram/patch_diagram 响应形状的权威来源（含幂等重放快照）
        const assembled: UpsertDiagramResult = {
          id: doc.id,
          path: doc.path,
          sectionCount: doc.sectionCount,
          tokenEstimate: doc.tokenEstimate,
          created: isCreate,
          contentHash: doc.contentHash ?? undefined,
          rechunked: !hashChanged && dto.forceRechunk ? true : undefined,
          ...(diagramIr
            ? {
                diagramType: diagramIr.diagramType,
                render: diagramArtifacts
                  ? this.diagramRenderInfoFromMeta(
                      diagramArtifacts.meta as unknown as Record<string, unknown>,
                    )
                  : this.diagramRenderInfoFromMeta(existing?.renderMeta ?? null),
              }
            : {}),
        };

        // 幂等记录与业务写同事务插入；并发同 key 撞 uq_idempotency_actor_key →
        // 异常上抛使整个业务事务回滚（零副作用），由外层 catch 走重放路径
        if (ctx) {
          await insertIdempotencyInTx(manager, ctx, doc.id, assembled);
        }

        return { doc, assembled };
      });

      // Audit hook
      if (actor) {
        const auditEntry = this.auditRepo.create({
          action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
          entityType: AUDIT_ENTITY_TYPE.DOC,
          entityId: result.id,
          actorId: actor.id,
          newData: { path: result.path, title: result.title },
          source: 'api',
        });
        await this.auditRepo.save(auditEntry);
      }

      // Emit document change event（eventCtx 局部改名避免与幂等 ctx 混淆）
      if (!existing) {
        const eventCtx = await this.getSpaceEventContext(spaceId);
        await this.eventService.create({
          eventType: EventType.DOC_CREATED,
          resourceType: ResourceType.DOC,
          resourceId: result.id,
          actorId: actor?.id ?? undefined,
          topicId: eventCtx.topicId ?? undefined,
          boardId: eventCtx.boardId ?? undefined,
          payload: { spaceId, docId: result.id, path: result.path, title: autoTitle },
        });
      } else {
        // Unchanged content already early-returned above; reaching here with an
        // existing doc always means the content changed. NOTE: do not re-check
        // `existing.contentHash !== computedHash` here — the transaction above
        // mutates the entity in place, so that comparison is always false.
        // 债 B（决策 #9）：forceRechunk 且 hash 未变的纯重切也走此分支——payload
        // 携带 rechunked:true 上下文，订阅方可区分「内容变更」与「元数据纯重切」。
        // ⚠️ wasRechunk 必须用事务前算好的 hashChanged 判断（实体被原地改写，见上）
        const wasRechunk = !hashChanged && !!dto.forceRechunk;
        const eventCtx = await this.getSpaceEventContext(spaceId);
        await this.eventService.create({
          eventType: EventType.DOC_UPDATED,
          resourceType: ResourceType.DOC,
          resourceId: result.id,
          actorId: actor?.id ?? undefined,
          topicId: eventCtx.topicId ?? undefined,
          boardId: eventCtx.boardId ?? undefined,
          payload: {
            spaceId,
            docId: result.id,
            path: result.path,
            title: autoTitle,
            ...(wasRechunk ? { rechunked: true } : {}),
          },
        });
      }

      // Async fire-and-forget（批次 C1）：内容变更分支事务提交后异步重检该空间 doc_routes
      // health。内容变更会重建 sections → 既有路由 headingPath 可能悬空，重检刷新 health。
      // unchanged 早退分支不触发（sections 未重建，重检结果不会变化）；23505 幂等 catch
      // 分支也不触发（本请求未写入内容）。
      // 安全模式：Promise.resolve().then(...).catch(...) 保证 setImmediate 回调内永不抛出
      // 未捕获异常（同步 throw 与异步 reject 均被 catch 吞掉）——fire-and-forget 语义
      // = 失败仅记日志不透出（recalcSpaceLinkHealth 同款先例语义的强化版）。
      setImmediate(() => {
        void Promise.resolve()
          .then(() => this.routeHealthService.recheckSpace(spaceId))
          .catch((err: unknown) => {
            this.logger.error(`route health recheck failed for space ${spaceId}`, err);
          });
      });

      // 响应直接用事务内组装的快照对象（与幂等记录里的 responseSnapshot 同一引用，
      // 保证重放返回值与首次响应逐字段一致）
      return assembled;
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      // v1.63.0 幂等并发撞键：事务内幂等记录插入触发 uq_idempotency_actor_key →
      // 整个业务事务已回滚（零副作用）→ 按重放语义返回对方首次快照
      if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key' && ctx) {
        const replay = await tryIdempotentReplay<UpsertDocResult>(this.idempotencyRepo, ctx);
        if (replay) return { ...replay, idempotentReplay: true };
      }
      // 23505: partial unique (spaceId, path) WHERE deleted_at IS NULL
      // concurrent upsert → catch and re-query the winning doc
      if (pgErr.code === '23505' && pgErr.constraint && pgErr.constraint.includes('path')) {
        const winner = await this.docRepo
          .createQueryBuilder('d')
          .where('d.space_id = :spaceId', { spaceId })
          .andWhere('d.path = :path', { path: dto.path })
          .andWhere('d.deleted_at IS NULL')
          .getOne();

        if (!winner) {
          // Should not happen — if 23505 fired, a row exists
          throw err;
        }

        const winnerResult: UpsertDocResult = {
          id: winner.id,
          path: winner.path,
          sectionCount: winner.sectionCount,
          tokenEstimate: winner.tokenEstimate,
          created: false,
          contentHash: winner.contentHash ?? undefined,
        };
        // 幂等登记（败者出口同样留痕；并发同 key 抢先则改用对方快照）
        if (ctx) {
          const replayed = await persistIdempotencyStandalone<UpsertDocResult>(
            this.idempotencyRepo,
            ctx,
            winner.id,
            winnerResult,
          );
          if (replayed) return { ...replayed, idempotentReplay: true };
        }
        return winnerResult;
      }
      throw err;
    }
  }

  /**
   * Batch upsert documents in a space.
   *
   * **事务边界 = 每文档独立**（D2）：for...of 逐条 await this.upsert()，
   * 单条 try/catch 收集 failed 不中断后续。不包大事务。
   * 容错继续语义参照 sync-docs.mjs 逐个串行先例。
   *
   * ⚠️ forceRechunk 在 batch 通道**显式剔除**（决策 #4）：每个元素即使带上
   * forceRechunk 字段也不生效（类型与运行时双保险）——batch 语义 = 批量内容导入，
   * forceRechunk 是单文档元数据修复入口，契约干净优先。
   */
  async batchUpsert(
    spaceId: string,
    docs: BatchUpsertItemDto[],
    actor?: UnifiedActor,
  ): Promise<BatchUpsertDocsResult> {
    const results: BatchUpsertItemResult[] = [];
    const summary = { total: docs.length, created: 0, updated: 0, unchanged: 0, failed: 0 };

    for (const dto of docs) {
      try {
        // versionSource='import'：批量导入通道（PUT /docs/batch，MCP import_docs /
        // import_doc_bundle 均经此）→ 版本行的 source 字段标记为 'import'
        // forceRechunk 显式剔除（决策 #4）：类型层 Omit 之外，运行时再析构一次——
        // @Type(() => UpsertDocDto) 实例化后元素仍可能携带该字段，双保险保障
        // batch 通道永不触发 forceRechunk 分支（断言回完整 UpsertDocDto 取剩余字段类型）
        const { forceRechunk: _excluded, ...upsertItem } = dto as UpsertDocDto;
        void _excluded;
        // v1.63.0：逐文档透传 clientRequestId（继承单条 upsert 幂等语义，照批量创建
        // task.service.ts 先例——每文档可带各自 key，重放返回该文档的首次结果）
        const r = await this.upsert(
          spaceId,
          { ...upsertItem, versionSource: DOC_VERSION_SOURCE.IMPORT },
          actor,
          upsertItem.clientRequestId,
        );

        let status: BatchUpsertItemResult['status'];
        if (r.unchanged) {
          status = 'unchanged';
          summary.unchanged++;
        } else if (r.created) {
          status = 'created';
          summary.created++;
        } else {
          // updated (including 23505 winner)
          status = 'updated';
          summary.updated++;
        }

        results.push({ path: dto.path, status, id: r.id });
      } catch (err: unknown) {
        summary.failed++;
        // 错误形状统一走 doc-error.helper.errorOf（review-0831 任务 bbd175dc 子项 2，
        // 与 doc-bundle.service 共用同一 { message, code } 契约）
        results.push({
          path: dto.path,
          status: 'failed',
          error: errorOf(err),
        });
      }
    }

    return { results, summary };
  }

  /** Extract the first heading title from content (for auto-title). */
  private extractHeadingFromContent(content: string): string | null {
    const m = content.match(/^#+\s+(.+)$/m);
    return m ? m[1].trim() : null;
  }

  /**
   * Diagram IR v1：解析 + 规范化 + 前置校验（upsertCore diagram 分支的唯一入口）。
   *
   * public：DiagramService validate dry-run 共用同一道前置门（DRY——R3 仓库证据拒绝
   * 与 diagram_type 校验口径只此一份；validate 对 object 入参先 stringify 再走本方法）。
   *
   * 校验链（顺序即错误语义，全部 fail-closed）：
   * ① JSON parse 失败 / 非 object → 422 DIAGRAM_VALIDATION_FAILED stage:'parse'
   *   （诊断 code 'input/json-parse' 对齐 renderer fallback，diagnostics.mjs:60-68）；
   * ② diagram_type ∉ 5 型 → 400 VALIDATION_ERROR 列支持类型（类型选择是格式错误，
   *   不是渲染门失败——DTO 层管格式原则的 service 侧延伸，ir 来源是自由文本 content）；
   * ③ R3 安全收口：前置拒绝 meta.repository 与 components[].sources（非空）两者——
   *   平台渲染环境永不设置 ARCHIFY_REPO_ROOT，vendored verifyRepositoryEvidence 会
   *   硬失败且其 supportedFixes（'pass --repo-root...'）是平台永不支持的修法，会把
   *   Agent 引向不可修复方向（repository-evidence.mjs:81-85/:114-118）。parse 后即报，
   *   省一次 spawn。
   *
   * 规范化（canonicalize）幂等：JSON.parse → stringify(obj, null, 2)——canonical∘
   * canonical = canonical（JSON 对象键序 = 解析插入序，同输入恒同输出），保证
   * contentHash 稳定、doc_versions 行级 diff 可读（pretty JSON 逐行 diff 天然可用）。
   */
  parseDiagramIr(content: string): {
    irObj: Record<string, unknown>;
    diagramType: DiagramType;
    canonical: string;
  } {
    // ① parse
    let irObj: unknown;
    try {
      irObj = JSON.parse(content);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UnprocessableEntityException({
        message: `Diagram IR JSON parse failed: ${reason}`,
        code: ErrorCode.DIAGRAM_VALIDATION_FAILED,
        data: {
          stage: 'parse',
          diagnostics: [
            {
              code: 'input/json-parse',
              severity: 'error',
              message: `Input JSON could not be parsed: ${reason}`,
              evidence: { reason },
              supportedFixes: ['repair the JSON syntax and retry'],
            } satisfies DiagramDiagnostic,
          ],
        },
      });
    }
    if (!irObj || typeof irObj !== 'object' || Array.isArray(irObj)) {
      throw new UnprocessableEntityException({
        message: 'Diagram IR must be a JSON object',
        code: ErrorCode.DIAGRAM_VALIDATION_FAILED,
        data: {
          stage: 'parse',
          diagnostics: [
            {
              code: 'input/not-object',
              severity: 'error',
              message: `Diagram IR must be a JSON object, got ${Array.isArray(irObj) ? 'array' : typeof irObj}`,
              supportedFixes: [
                'pass the diagram IR as a JSON object with schema_version/diagram_type/meta',
              ],
            } satisfies DiagramDiagnostic,
          ],
        },
      });
    }
    const ir = irObj as Record<string, unknown>;

    // ② diagram_type 反正范化校验（varchar(16) 列写库；5 型对应 vendored 渲染器）
    const diagramType = ir.diagram_type;
    if (
      typeof diagramType !== 'string' ||
      !(DIAGRAM_TYPES as readonly string[]).includes(diagramType)
    ) {
      throw new BadRequestException({
        message:
          `Invalid or missing IR 'diagram_type': ${JSON.stringify(diagramType)}; ` +
          `supported types: ${DIAGRAM_TYPES.join(', ')}`,
        code: ErrorCode.VALIDATION_ERROR,
        data: { supportedTypes: [...DIAGRAM_TYPES] },
      });
    }

    // ③ R3 前置拒绝仓库证据（两路触发面：meta.repository 或任一 component 带非空
    // sources 数组——与 vendored hasRepositoryEvidence 的判定面一致，但平台不按
    // diagram_type 放行其他类型：sources 字段在非 architecture 类型上本就会被
    // schema 拒，统一提前拒绝口径更干净）
    const meta = ir.meta as Record<string, unknown> | undefined;
    const components = Array.isArray(ir.components) ? ir.components : [];
    const hasComponentSources = components.some(
      (c) =>
        c &&
        typeof c === 'object' &&
        Array.isArray((c as Record<string, unknown>).sources) &&
        ((c as Record<string, unknown>).sources as unknown[]).length > 0,
    );
    if (meta?.repository || hasComponentSources) {
      throw new UnprocessableEntityException({
        message:
          'Diagram IR declares repository evidence (meta.repository / components[].sources): ' +
          '平台渲染环境不支持仓库证据，请移除该字段（the platform renderer never sets ' +
          'ARCHIFY_REPO_ROOT; repository verification is not available)',
        code: ErrorCode.DIAGRAM_VALIDATION_FAILED,
        data: {
          stage: 'schema',
          diagnostics: [
            {
              code: 'platform/repository-evidence-unsupported',
              severity: 'error',
              message:
                '平台渲染环境不支持仓库证据，请移除该字段 (repository evidence is not supported on the platform renderer; remove meta.repository and any components[].sources)',
              subject: {
                path: meta?.repository ? '/meta/repository' : '/components[].sources',
              },
              supportedFixes: ['remove meta.repository and any components[].sources from the IR'],
            } satisfies DiagramDiagnostic,
          ],
        },
      });
    }

    return {
      irObj: ir,
      diagramType: diagramType as DiagramType,
      canonical: JSON.stringify(ir, null, 2),
    };
  }

  /** IR meta.title 提取（title 派生用；截 DOC_TITLE_MAX_LENGTH 对齐 docs.title 列长） */
  private extractIrMetaTitle(irObj: Record<string, unknown>): string | null {
    const meta = irObj.meta as Record<string, unknown> | undefined;
    const title = meta?.title;
    return typeof title === 'string' && title.trim()
      ? title.trim().slice(0, DOC_TITLE_MAX_LENGTH)
      : null;
  }

  /** DocDetail.diagram 摘要装配（render_meta 子集；存量无快照 → 各字段 undefined） */
  private buildDiagramSummary(doc: Doc): NonNullable<DocDetail['diagram']> {
    const meta = doc.renderMeta as Partial<DiagramRenderMeta> | null;
    return {
      diagramType: doc.diagramType,
      qualityProfile: meta?.qualityProfile,
      renderedAt: meta?.renderedAt,
      htmlBytes: meta?.htmlBytes,
      composition: meta?.composition,
    };
  }

  /**
   * render_meta jsonb → 响应级渲染信息（upsert_diagram/patch_diagram/read 透出用）。
   * 存量无快照 diagram（renderMeta NULL，历史数据）→ undefined（响应省略 render 键）。
   */
  private diagramRenderInfoFromMeta(
    renderMeta: Record<string, unknown> | null,
  ): DiagramWriteRenderInfo | undefined {
    if (!renderMeta) return undefined;
    const meta = renderMeta as Partial<DiagramRenderMeta>;
    return {
      renderedAt: typeof meta.renderedAt === 'string' ? meta.renderedAt : '',
      rendererVersion: typeof meta.rendererVersion === 'string' ? meta.rendererVersion : '',
      qualityProfile: typeof meta.qualityProfile === 'string' ? meta.qualityProfile : '',
      htmlBytes: typeof meta.htmlBytes === 'number' ? meta.htmlBytes : 0,
      htmlSha256: typeof meta.htmlSha256 === 'string' ? meta.htmlSha256 : '',
      composition:
        meta.composition &&
        typeof meta.composition === 'object' &&
        typeof (meta.composition as { errors?: unknown }).errors === 'number'
          ? (meta.composition as { errors: number; warnings: number })
          : { errors: 0, warnings: 0 },
    };
  }

  /**
   * List documents in a space. Supports filters: category, tag, type, q (full-text),
   * path (exact), pathPrefix (prefix match, v1.55).
   * path= and q= are mutually exclusive; path= and pathPrefix= are mutually exclusive
   * (both target the path column and exact match subsumes prefix).
   */
  async findAll(
    spaceId: string,
    query: {
      category?: string;
      tag?: string;
      type?: string;
      q?: string;
      path?: string;
      pathPrefix?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<PaginatedResponse<DocSummary>> {
    const { category, tag, type, q, path, pathPrefix, page = 1, pageSize = 20 } = query;

    // path= and q= are mutually exclusive
    if (path && q) {
      throw new BadRequestException({
        message: 'path= and q= are mutually exclusive',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    // path= 与 pathPrefix= 互斥（同打 path 列；精确匹配语义包含前缀匹配，同传无意义）
    if (path && pathPrefix) {
      throw new BadRequestException({
        message: 'path= and pathPrefix= are mutually exclusive',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    const qb = this.docRepo
      .createQueryBuilder('d')
      // 裸表 join 仅用于按分类 slug 过滤（无关系可水合，禁 leftJoinAndSelect）；
      // join 条件带软删过滤——已软删分类不应再作为过滤命中依据
      .leftJoin('doc_categories', 'dc', 'dc.id = d.category_id AND dc.deleted_at IS NULL')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL');

    // Exact path match
    if (path) {
      qb.andWhere('d.path = :exactPath', { exactPath: path });
    }

    // Path prefix match（v1.55）：LIKE 通配符转义保证字面前缀语义——
    // 用户输入中的 \ % _ 逐字符转义（ESCAPE '\'），不会被当作 LIKE 元字符解释
    if (pathPrefix) {
      const escaped = pathPrefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      qb.andWhere("d.path LIKE :pathPrefix ESCAPE '\\'", { pathPrefix: `${escaped}%` });
    }

    // Full-text search (ILIKE on title + path)
    if (q) {
      qb.andWhere('(d.title ILIKE :q OR d.path ILIKE :q)', { q: `%${q}%` });
    }

    // Category filter (by slug)
    if (category) {
      qb.andWhere('dc.slug = :catSlug', { catSlug: category });
    }

    // Tag filter (array contains)
    if (tag) {
      qb.andWhere(':tag = ANY(d.tags)', { tag });
    }

    // Type filter
    if (type) {
      qb.andWhere('d.doc_type = :docType', { docType: type });
    }

    // Default ordering
    qb.orderBy('d.path', 'ASC');

    const [items, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: items.map((d) => this.toSummary(d)),
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
    };
  }

  /**
   * 目录树分层浏览（GET /doc-spaces/:id/docs/tree，v1.70.0-dev）
   *
   * 按 prefix 返回「当前层直接子目录（docCount/latestDocAt 递归聚合）+ 当前层
   * 直挂文档（slim 分页）」。web 左栏懒加载与 Agent 目录发现共用。
   *
   * SQL 形态硬约束（plan A1/A2，防 implementation drift）：
   * - WHERE 只用 LIKE 模式（索引友好），禁止 substring 进 WHERE：
   *   子树收窄 `d.path LIKE :escapedPrefix || '%' ESCAPE '\'`；folders 追加
   *   `AND d.path LIKE :escapedPrefix || '%/%' ESCAPE '\'`（剩余部分含更深分隔符
   *   = 有子目录）；docs 追加 `AND d.path NOT LIKE :escapedPrefix || '%/%'
   *   ESCAPE '\'`（无更深分隔符 = 直挂）。转义照抄 findAll 先例（\ % _ 逐字符）。
   * - substring/split_part 只出现在 SELECT/GROUP BY（narrowing 之后）：
   *   `split_part(substring(d.path from :plen::int), '/', 1)`——plen 由本方法 JS 算好
   *   整数传入（归一化 prefix 含尾 / 时 plen = prefix.length + 1，PG 1-based）。
   *   ⚠️ `::int` cast 必须保留：node pg 绑定 number 到 `substring(text from $1)`
   *   时 PG 参数类型推断为 text（正则重载，实测返回匹配子串而非位置截取），
   *   显式 cast 强制 int4 重载（位置截取）。
   * - 一律显式 d.deleted_at IS NULL。
   * - folders total = 分组数（子查询 COUNT）；docs total 用 getManyAndCount 双查。
   *
   * @param spaceId 目标空间 ID
   * @param query 查询参数（prefix/sort/docsLimit/docsOffset/foldersLimit/foldersOffset）
   * @returns DocTreeResponse（prefix 归一化回显 + folders/docs 分页信封）
   */
  async findTree(
    spaceId: string,
    query: {
      prefix?: string;
      sort?: 'recent' | 'name';
      docsLimit?: number;
      docsOffset?: number;
      foldersLimit?: number;
      foldersOffset?: number;
    },
  ): Promise<DocTreeResponse> {
    const {
      prefix: rawPrefix = '',
      sort = 'recent',
      docsLimit = 50,
      docsOffset = 0,
      foldersLimit = 200,
      foldersOffset = 0,
    } = query;

    // 纵深防御钳制（DTO 已 @Max 校验，service 层兜底，对齐 spec §7.4 双层保护）
    const docsLimitC = Math.min(docsLimit, 200);
    const foldersLimitC = Math.min(foldersLimit, 500);

    // prefix 归一化：去前导 /、非空补尾部 /（根层 = ''）
    const prefix = rawPrefix.replace(/^\/+/, '');
    const normalizedPrefix = prefix === '' ? '' : prefix.endsWith('/') ? prefix : `${prefix}/`;

    // LIKE 通配符转义（照抄 findAll 先例）：\ % _ 逐字符转义，保证字面前缀语义
    const escapedPrefix = normalizedPrefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);

    // plen：substring(d.path from :plen) 的起始位置（PG 1-based）。
    // 归一化 prefix 恒以 / 结尾（非空时），plen = prefix.length + 1 跳过 "prefix/"
    // 本身、从下一段开始取；根层（''）plen = 1 取全文首段。
    const plen = normalizedPrefix === '' ? 1 : normalizedPrefix.length + 1;

    // ── folders：当前层直接子目录（GROUP BY 首段）──
    const folderQb = this.docRepo
      .createQueryBuilder('d')
      .select(`split_part(substring(d.path from :plen::int), '/', 1)`, 'name')
      .addSelect('COUNT(*)', 'docCount')
      .addSelect('MAX(d.updated_at)', 'latestDocAt')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .andWhere(`d.path LIKE :escapedPrefix || '%' ESCAPE '\\'`, { escapedPrefix })
      .andWhere(`d.path LIKE :escapedPrefix || '%/%' ESCAPE '\\'`, { escapedPrefix })
      .groupBy(`split_part(substring(d.path from :plen::int), '/', 1)`)
      .setParameter('plen', plen)
      .offset(foldersOffset)
      .limit(foldersLimitC);
    // 目录排序：recent = 最近更新 DESC（MAX(updated_at)）；name = 段名 ASC
    if (sort === 'name') {
      folderQb.orderBy('name', 'ASC');
    } else {
      folderQb.orderBy('MAX(d.updated_at)', 'DESC');
    }
    const folderRows = await folderQb.getRawMany();

    // folders total = 分组数（子查询 COUNT，不拉全量分组行）
    // from 工厂契约：返回 subQuery QB（TypeORM 内部自行 getQuery/getParameters 合并），
    // 禁止返回 getQuery() 字符串——否则 subQueryBuilder.getParameters 不存在。
    // ⚠️ 必须用 manager.createQueryBuilder()（无主 FROM）：repo.createQueryBuilder()
    // 无论是否传 alias 都会设主 FROM（alias 缺省 = 实体名），.from(sub) 变成追加
    // FROM（逗号笛卡尔积），COUNT(*) 会变成 docs 行数 × 分组数
    const folderTotalQb = this.docRepo.manager
      .createQueryBuilder()
      .select('COUNT(*)', 'total')
      .from((qb) => {
        return qb
          .select(`split_part(substring(d.path from :plen::int), '/', 1)`, 'seg')
          .from(Doc, 'd')
          .where('d.space_id = :spaceId')
          .andWhere('d.deleted_at IS NULL')
          .andWhere(`d.path LIKE :escapedPrefix || '%' ESCAPE '\\'`)
          .andWhere(`d.path LIKE :escapedPrefix || '%/%' ESCAPE '\\'`)
          .groupBy(`split_part(substring(d.path from :plen::int), '/', 1)`);
      }, 't')
      .setParameter('spaceId', spaceId)
      .setParameter('escapedPrefix', escapedPrefix)
      .setParameter('plen', plen);
    const folderTotalRow = await folderTotalQb.getRawOne();
    const folderTotal = Number(folderTotalRow?.total ?? 0);

    // ── docs：当前层直挂文档（无更深分隔符，slim 分页）──
    const docQb = this.docRepo
      .createQueryBuilder('d')
      .select(['d.id', 'd.path', 'd.title', 'd.docType', 'd.updatedAt'])
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .andWhere(`d.path LIKE :escapedPrefix || '%' ESCAPE '\\'`, { escapedPrefix })
      .andWhere(`d.path NOT LIKE :escapedPrefix || '%/%' ESCAPE '\\'`, { escapedPrefix })
      .orderBy('d.path', 'ASC')
      .skip(docsOffset)
      .take(docsLimitC);
    const [docItems, docTotal] = await docQb.getManyAndCount();

    return {
      prefix: normalizedPrefix,
      folders: {
        items: folderRows.map((r) => ({
          path: `${normalizedPrefix}${r.name}/`,
          name: r.name,
          docCount: Number(r.docCount),
          latestDocAt: r.latestDocAt ? new Date(r.latestDocAt).toISOString() : null,
        })),
        total: folderTotal,
        hasMore: foldersOffset + folderRows.length < folderTotal,
      },
      docs: {
        items: docItems.map((d) => ({
          id: d.id,
          path: d.path,
          title: d.title,
          docType: d.docType,
          updatedAt: d.updatedAt,
        })),
        total: docTotal,
        hasMore: docsOffset + docItems.length < docTotal,
      },
    };
  }

  /**
   * 全空间聚合计数（GET /doc-spaces/:id/docs/facets，v1.70.0-dev）
   *
   * 替代前端全量列表聚合：types = GROUP BY doc_type（非空）；tags = unnest(tags)
   * GROUP BY；categories = JOIN doc_categories（含软删过滤，照抄 findAll 先例
   * doc.service.ts:1021）。全部只统计未删文档；排序 count DESC + value/slug ASC
   * tie-break（确定性输出）。
   *
   * @param spaceId 目标空间 ID
   * @returns DocFacetsResponse（types/tags/categories 三组聚合计数）
   */
  async findFacets(spaceId: string): Promise<DocFacetsResponse> {
    // types：GROUP BY doc_type（非空 = IS NOT NULL AND <> ''）
    const typeRows = await this.docRepo
      .createQueryBuilder('d')
      .select('d.doc_type', 'value')
      .addSelect('COUNT(*)', 'count')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .andWhere('d.doc_type IS NOT NULL')
      .andWhere("d.doc_type <> ''")
      .groupBy('d.doc_type')
      .orderBy('count', 'DESC')
      .addOrderBy('value', 'ASC')
      .getRawMany();

    // tags：unnest(tags) GROUP BY（空 tags 数组不产出行）
    const tagRows = await this.docRepo
      .createQueryBuilder('d')
      .select('unnest(d.tags)', 'value')
      .addSelect('COUNT(*)', 'count')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .groupBy('unnest(d.tags)')
      .orderBy('count', 'DESC')
      .addOrderBy('value', 'ASC')
      .getRawMany();

    // categories：JOIN doc_categories（裸表 join 仅用于按 slug/name 聚合，无关系可
    // 水合，禁 leftJoinAndSelect——照抄 findAll 先例）；join 条件带软删过滤——
    // 已软删分类不应再作为聚合命中依据
    const catRows = await this.docRepo
      .createQueryBuilder('d')
      .select('dc.slug', 'slug')
      .addSelect('dc.name', 'name')
      .addSelect('COUNT(*)', 'count')
      .leftJoin('doc_categories', 'dc', 'dc.id = d.category_id AND dc.deleted_at IS NULL')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .andWhere('dc.id IS NOT NULL')
      .groupBy('dc.slug')
      .addGroupBy('dc.name')
      .orderBy('count', 'DESC')
      .addOrderBy('slug', 'ASC')
      .getRawMany();

    return {
      types: typeRows.map((r) => ({ value: r.value, count: Number(r.count) })),
      tags: tagRows.map((r) => ({ value: r.value, count: Number(r.count) })),
      categories: catRows.map((r) => ({ slug: r.slug, name: r.name, count: Number(r.count) })),
    };
  }

  /**
   * Get document detail: metadata + section outline (no content by default).
   * QB select explicitly excludes section content.
   *
   * 小文档全文内联（v1.39.x）：无定位调用时，tokenEstimate > 0 且 ≤ 阈值（缺省
   * FULL_CONTENT_TOKEN_THRESHOLD，可 maxFullTokens 覆盖，0 = 强制 outline）→ 额外
   * 第二次全量查询 sections 并重建全文，返回 mode:'full' + content；否则 mode:'outline'。
   * tokenEstimate=0（存量未估算文档）守卫不触发全文，避免任意大文档误内联。
   *
   * full 模式 content = **与 match 写面 / full=true 通道逐字节同形的保真全文**
   * （skipDuplicateTitle=false：首 H1 与 title 同名也保留标题行）——read_doc full 输出
   * 可直接作 patch_doc MATCH 模式 oldString 来源（字节一致性保证）；首标题去重只剩
   * web 渲染侧（getContent full=false）使用。
   *
   * @param maxFullTokens 覆盖阈值（≥0；0 = 强制 outline；非法值由 controller 双层校验拦截，不达此层）
   */
  async findOne(id: string, maxFullTokens?: number): Promise<DocDetail> {
    const doc = await this.findById(id);

    // 用 getMany 走实体 hydration 取大纲字段，规避 getRawMany 的 raw-key 命名陷阱
    // （该版本下 select 用 DB 列名或属性名都映射不到 headingPath，导致 outline 全空）。
    // select 指定属性名以排除 content 大字段；hydration 按属性名填充，未选字段为 undefined。
    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .select(['s.position', 's.headingPath', 's.headingText', 's.headingLevel', 's.tokenEstimate'])
      .where('s.docId = :docId', { docId: id })
      .orderBy('s.position', 'ASC')
      .getMany();

    const outline: DocSectionOutline[] = sections.map((s) => ({
      position: s.position,
      headingPath: s.headingPath,
      // 债 A：标题改读 heading_text 列（chunker 清洗直写，headingPath 退化纯寻址）。
      // headingText 缺失（mock/旧行回填前）时回退 headingPath 末段反解析作兼容兜底
      // （extractLastHeadingSegment 已标记为新代码禁用，仅兜底路径使用）。
      heading: s.headingText ?? (s.headingPath ? extractLastHeadingSegment(s.headingPath) : null),
      headingText: s.headingText,
      headingLevel: s.headingLevel,
      tokenEstimate: s.tokenEstimate,
    }));

    const base = this.toSummary(doc);
    const result: DocDetail = {
      ...base,
      sections: outline,
      linkHealth: doc.linkHealth as LinkHealth | null | undefined,
      // Diagram IR v1：图信息摘要透传（DocDetail.diagram，免二次请求拿渲染元数据）——
      // 数据源自 docs.render_meta（不含 rendered_html 大字段，select:false 未水合）
      ...(doc.docType === DOC_TYPE_DIAGRAM ? { diagram: this.buildDiagramSummary(doc) } : {}),
    };

    // 生效阈值：显式 maxFullTokens 优先（0 = 强制 outline），缺省用模块常量
    const threshold = maxFullTokens ?? FULL_CONTENT_TOKEN_THRESHOLD;

    if (
      threshold > 0 &&
      doc.tokenEstimate &&
      doc.tokenEstimate > 0 &&
      doc.tokenEstimate <= threshold
    ) {
      // full 分支独立第二次查询（全量 sections 含 content 大字段）——outline 分支零额外开销。
      // 复用 reconstructContent 保真渲染（skipDuplicateTitle=false：与 match 写面
      // patchByMatch 操作面 / getContent(full=true) 通道逐字节同形——read_doc full 输出
      // 可直接作 patch_doc oldString 来源）。首标题去重只剩 web 渲染侧（getContent full=false）。
      const fullSections = await this.sectionRepo
        .createQueryBuilder('s')
        .where('s.docId = :docId', { docId: id })
        .orderBy('s.position', 'ASC')
        .getMany();

      result.mode = 'full';
      result.content = this.reconstructContent(doc, fullSections, false);
    } else {
      result.mode = 'outline';
    }

    return result;
  }

  /**
   * Get full content (all sections concatenated by position).
   * Intended for web rendering ONLY — not recommended for Agent (high token cost).
   *
   * @param full false（默认）= 渲染侧去重首标题（web header 已展示 title）；
   *   true = 完整还原原文（web 编辑器专用——去重后的内容回写 upsert 会丢首标题行，
   *   导致 title 被下一个 heading /path 重新派生，数据损坏）
   */
  async getContent(id: string, full = false): Promise<DocFullContent> {
    const doc = await this.findById(id);

    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .where('s.doc_id = :docId', { docId: id })
      .orderBy('s.position', 'ASC')
      .getMany();

    // 还原标题行：chunker 把标题存进 headingPath/headingLevel，section.content 不含标题行；
    // web 全文通道必须把标题行插回，否则 react-markdown 渲染丢失层级（plan §1.1-14 全文渲染语义）。
    // 去重首标题仅渲染侧需要（web header 已展示 title），编辑器/链接巡检等消费方全量还原。
    const content = this.reconstructContent(doc, sections, !full);

    return {
      docId: doc.id,
      docPath: doc.path,
      title: doc.title,
      content,
      // 原始写入 payload 的 SHA-256（乐观锁 token）——content 是 sections 重建产物，
      // 其 SHA-256 ≠ 本值；乐观锁（expectedContentHash）一律用本 token，禁止对读出
      // 正文自算 SHA（docs.content_hash nullable，旧数据可能缺省）
      contentHash: doc.contentHash ?? undefined,
    };
  }

  /**
   * 列出文档的版本历史（doc history MVP，GET /docs/:id/versions）。
   *
   * 仅返回元数据（version / contentHash / authorActorId / source / createdAt /
   * contentSize），不含 content 全文——列表响应最小化（对齐列表视图不含大字段
   * 的项目惯例；contentSize 由 SQL octet_length 现算，避免 full 行带出正文）。
   *
   * 排序：version DESC（最新在前）。软删文档 → 404 DOC_NOT_FOUND（findById），
   * 与文档读语义一致。
   *
   * @param docId 目标文档 ID
   * @returns 版本元数据列表（version DESC）
   */
  async findVersions(docId: string): Promise<DocVersionSummary[]> {
    // 存在性 + 软删检查（版本历史挂在文档生命周期下：软删后不可见）
    await this.findById(docId);

    // getRawMany + 实体属性名（实测 raw key = `别名_蛇形列名`，如 v_content_hash）：
    // select 裸 DB 列名（v.content_hash）时 raw key 会丢别名前缀（'content_hash'），
    // 属性名路径才是 TypeORM 0.3 的稳定命名（先例：getSpaceEventContext ds_board_id）——
    // 铁律 #23：raw-key 映射必须真库验证，mock 测不出。
    // octet_length 在 SQL 侧算字节数，避免拉 content 大字段。
    const rows = await this.versionRepo
      .createQueryBuilder('v')
      .select(['v.version', 'v.contentHash', 'v.authorActorId', 'v.source', 'v.createdAt'])
      .addSelect('octet_length(v.content)', 'content_size')
      .where('v.doc_id = :docId', { docId })
      .orderBy('v.version', 'DESC')
      .getRawMany<{
        v_version: number;
        v_content_hash: string;
        v_author_actor_id: string;
        v_source: string;
        v_created_at: Date;
        content_size: string;
      }>();

    return rows.map((r) => ({
      version: r.v_version,
      contentHash: r.v_content_hash,
      authorActorId: r.v_author_actor_id,
      source: r.v_source as DocVersionSource,
      createdAt: r.v_created_at,
      contentSize: Number(r.content_size),
    }));
  }

  /**
   * 读取单个版本的详情（doc history MVP，GET /docs/:id/versions/:version）。
   *
   * 返回元数据 + 该版本全文快照 + 与前一版本的 diff（**读时现算，不落库**——
   * 快照只存全文，diff 每次读取由 computeLineDiff 行级 LCS 现算）。
   *
   * 前一版定义：版本号小于当前的最大版本行——注意剪枝跳号后不一定是
   * version-1（如保留 20 条后版本 21 的前一版是 19）。无前一版（文档最早一版）
   * → diff 为 null（有前版但内容一致 → 非 null，added/removed 为 0）。
   *
   * 版本不存在 → 404 DOC_NOT_FOUND（与 section 越界同语义，不新增错误码）；
   * 负/非整数 version 由 controller 层格式校验拦截（铁律 #21 层 1），此处不重复。
   *
   * @param docId 目标文档 ID
   * @param version 目标版本号（1-based）
   * @returns DocVersionDetail（含 content 全文与 diff）
   */
  async findVersion(docId: string, version: number): Promise<DocVersionDetail> {
    // 存在性 + 软删检查（与 findVersions 一致）
    await this.findById(docId);

    const row = await this.versionRepo
      .createQueryBuilder('v')
      .where('v.doc_id = :docId', { docId })
      .andWhere('v.version = :version', { version })
      .getOne();

    if (!row) {
      throw new NotFoundException({
        message: `Document version ${version} not found (doc ${docId})`,
        code: ErrorCode.DOC_NOT_FOUND,
      });
    }

    // 前一版（version 小于当前的最大行；剪枝可能跳号，故不能用 version-1）
    const prev = await this.versionRepo
      .createQueryBuilder('v')
      .select(['v.version', 'v.content'])
      .where('v.doc_id = :docId', { docId })
      .andWhere('v.version < :version', { version })
      .orderBy('v.version', 'DESC')
      .getOne();

    const diff: DocVersionDetail['diff'] = prev
      ? {
          fromVersion: prev.version,
          ...computeLineDiff(
            prev.content,
            row.content,
            `doc v${prev.version}`,
            `doc v${row.version}`,
          ),
        }
      : null;

    return {
      version: row.version,
      contentHash: row.contentHash,
      authorActorId: row.authorActorId,
      source: row.source as DocVersionSource,
      createdAt: row.createdAt,
      contentSize: Buffer.byteLength(row.content, 'utf8'),
      content: row.content,
      diff,
    };
  }

  /**
   * 由 sections 重建文档全文（标题行插回，与 chunker 的切分互逆）。
   *
   * headingLevel 0 = 文首无标题段，不插标题行；标题文本取 headingPath 末段，
   * 与前端 scrollToHeading 的匹配逻辑一致。
   *
   * 空 content 的 section（空正文标题，chunker 保真产出）只渲染标题行、不追加正文段——
   * join 后与相邻段之间恰好一个空行，保证「全文读 + upsert 回写」往返幂等
   * （否则空 H2 分组标题会在重建中被吞掉，见 markdown-chunker AGENT-HOOK e6eaf06d）。
   *
   * run-dedup：chunker step 4 对 >4000 字符的 section 按段落二次切分，并将续 chunk
   * 持久化为 isContinuation=true；重建时续 chunk 只接正文，真实同名 sibling（isContinuation=false）
   * 仍插回标题行，避免旧的相邻 headingPath/headingLevel 启发式误吞合法标题。
   *
   * @param skipDuplicateTitle 渲染侧去重：position 0 的 H1 若与 doc.title 同名则不重复
   *   插标题行（web 渲染层已用 header 元数据卡展示 title）；链接巡检等语义消费方应传
   *   false，保证与 upsert 时原文计算口径一致。
   *
   * public（v1.60.0-dev）：move-impact 入链反扫与 recalcSpaceLinkHealth 同源复用
   * （reconstructContent + extractDocLinks = 与 linkHealth 数据完全一致的输入），
   * 禁止在 DocMoveService 复制渲染实现。
   */
  reconstructContent(
    doc: Doc,
    sections: {
      content: string;
      headingLevel: number;
      headingPath: string | null;
      isContinuation?: boolean;
    }[],
    skipDuplicateTitle: boolean,
  ): string {
    const parts = sections
      .map((s, idx) => this.renderSectionPart(s, idx, doc.title, skipDuplicateTitle))
      // 过滤被去重吞掉（isDuplicateTitle）或 level-0 且内容为空的 section 产生的空串，
      // 防止 join 拼接出多余空行；正常 section 的 content 非空，不受影响
      .filter((part) => part !== '');
    return parts.join('\n\n');
  }

  /**
   * 渲染单个 section 为 markdown 片段（标题行插回的最小复用单元）。
   *
   * reconstructContent（全文重建）与 patchSection（section 级写的整篇拼接）共用本方法，
   * 保证「标题行如何插回」只有一份实现——修改渲染规则两侧自动同步。
   * run-dedup / 首标题去重 / 空 content 只插标题行的完整语义见 reconstructContent 方法注释。
   *
   * 债 A：标题文本直读 headingText 列（chunker 清洗值，标题正文 ` § ` 完整保留），
   * headingPath 退化为寻址地址；headingText 缺失（mock/旧行）时回退 headingPath
   * 末段反解析（extractLastHeadingSegment 仅兜底路径使用）。
   *
   * @param s 当前 section（content 不含标题行，chunker 契约）；isContinuation=true 时不插标题
   * @param idx section 在有序列表中的下标（skipDuplicateTitle 仅作用于 idx 0）
   * @param docTitle 文档标题（首标题去重比对用）
   * @param skipDuplicateTitle 渲染侧首标题去重开关（全文读渲染 true；回写保真语义 false）
   * @returns 该 section 的渲染片段（可能为空串：被去重吞掉或 level-0 空内容）
   */
  private renderSectionPart(
    s: {
      content: string;
      headingLevel: number;
      headingPath: string | null;
      headingText?: string | null;
      isContinuation?: boolean;
    },
    idx: number,
    docTitle: string,
    skipDuplicateTitle: boolean,
  ): string {
    if (s.headingLevel > 0 && s.headingPath && !s.isContinuation) {
      const lastSegment = s.headingText ?? extractLastHeadingSegment(s.headingPath);
      const isDuplicateTitle = skipDuplicateTitle && idx === 0 && lastSegment === docTitle;
      if (lastSegment && !isDuplicateTitle) {
        const prefix = '#'.repeat(Math.min(s.headingLevel, 6));
        // 空 content section 只插标题行（不追加 "\n\n"），避免 join 后产生多余空行
        return s.content ? `${prefix} ${lastSegment}\n\n${s.content}` : `${prefix} ${lastSegment}`;
      }
    }
    return s.content;
  }

  /**
   * headingPath 精确命中 exists 查询（v1.42 B5 doc_routes 写时校验复用）。
   *
   * 与 getSection 的 headingPath 分支同款 where（doc_id + heading_path 精确匹配）：
   * 抽成 exists 版供 Service 层"写时校验"使用——校验路由引用的 heading 在写入当下可解析。
   * 已知边界：doc 后续编辑/重排导致 headingPath 悬空属批次 C 异步校验范围，写时校验只管当下。
   *
   * @param docId 目标文档 ID（须未软删，由调用方保证存在性）
   * @param headingPath 待校验的 heading 路径（精确匹配，不做模糊/前缀匹配）
   * @returns true = 存在至少一个 section 的 heading_path 精确命中
   */
  async sectionExistsByHeadingPath(docId: string, headingPath: string): Promise<boolean> {
    const section = await this.sectionRepo
      .createQueryBuilder('s')
      .where('s.doc_id = :docId', { docId })
      .andWhere('s.heading_path = :headingPath', { headingPath })
      .getOne();
    return !!section;
  }

  /**
   * Get a single section by position OR headingPath.
   *
   * - position (from URL param) takes priority if both provided
   * - sectionId is NOT accepted (unstable contract, see plan §1.1-13)
   * - 404 DOC_NOT_FOUND if doc or section not found
   * - 返回值带 markdown：保真渲染片段（renderSectionPart skipDuplicateTitle=false 口径：
   *   标题行插回 + run-dedup + 空正文只插标题行）——该节在 full=true 全文中的**字节级子串**，
   *   可直接作 patch_doc MATCH 模式 oldString / section 模式 content 参照面
   */
  async getSection(
    docId: string,
    position?: number,
    headingPath?: string,
  ): Promise<DocSectionContent> {
    const doc = await this.findById(docId);

    let section: DocSection | null = null;

    if (position !== undefined && position !== null) {
      section = await this.sectionRepo
        .createQueryBuilder('s')
        .where('s.doc_id = :docId', { docId })
        .andWhere('s.position = :position', { position })
        .getOne();
    } else if (headingPath) {
      section = await this.sectionRepo
        .createQueryBuilder('s')
        .where('s.doc_id = :docId', { docId })
        .andWhere('s.heading_path = :headingPath', { headingPath })
        .getOne();
    }

    if (!section) {
      // Section not found → treat as DOC_NOT_FOUND (sectionId is unstable,
      // position/headingPath are the stable locators; if neither matches,
      // the requested anchor doesn't exist in any valid form)
      throw new NotFoundException({
        message: 'Document or section not found',
        code: ErrorCode.DOC_NOT_FOUND,
      });
    }

    return {
      docId: doc.id,
      docPath: doc.path,
      position: section.position,
      headingPath: section.headingPath,
      // 债 A：本地标题直读列（旧数据回填前为 null）
      headingText: section.headingText,
      headingLevel: section.headingLevel,
      isContinuation: section.isContinuation,
      content: section.content,
      tokenEstimate: section.tokenEstimate,
      sectionHash: this.computeSectionHash(section),
      // 保真渲染片段（与全文重建同款渲染规则，idx 仅 skipDuplicateTitle=true 有意义，此处恒 false）
      markdown: this.renderSectionPart(section, section.position, doc.title, false),
    };
  }

  /**
   * 批量读取多个 section（v1.55，与单节 getSection 同口径的 position 语义）。
   *
   * 场景：outline 后一次拿多个目标节，N 节一次往返（原 N 次）。
   *
   * **部分失败友好契约**（批量场景核心决策）：
   * - 越界/不存在的 position **不整体报错**，单独列入 `missing`——批量请求里一个
   *   陈旧 position（文档结构漂移）不应让其余节的读取一起失败；
   * - 重复 position 去重（每个 position 至多返回一次）；
   * - 结果 sections 按 position ASC（与 outline 顺序一致，便于调用方顺序消费）。
   *
   * 格式层错误（非整数/负数/超限/混用单节定位参数）在 Controller 层 400 拦截
   * （铁律 #21 层 1），本方法只做业务存在性判定（层 2）。
   *
   * @param docId 目标文档 ID（不存在/软删 → 404 DOC_NOT_FOUND，findById）
   * @param positions 0-based position 列表（与 outline/getSection 同口径）
   * @returns {docId, docPath, sections（命中节，position ASC）, missing（去重升序）}
   *   sections 每项带 markdown：保真渲染片段（与 getSection.markdown 同口径——该节在
   *   full=true 全文中的**字节级子串**，oldString / section 模式 content 参照面；
   *   run-dedup 由每个 section 的 isContinuation 持久化事实决定，不依赖请求上下文）
   */
  async getSections(docId: string, positions: number[]): Promise<DocBatchSectionsResult> {
    const doc = await this.findById(docId);

    // 全量 section（position ASC）一次拉齐，Node 侧按 position 命中——
    // 批量场景逐 position 发 SQL 会 N+1，全量单查 + Map 命中最优（文档 section
    // 规模有限，chunker 切分下无超大 section 表）
    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .where('s.doc_id = :docId', { docId })
      .orderBy('s.position', 'ASC')
      .getMany();
    const byPosition = new Map(sections.map((s) => [s.position, s]));
    // 去重（Set 保序后升序重排——响应契约：position ASC）
    const uniquePositions = [...new Set(positions)].sort((a, b) => a - b);

    const found: DocSectionItem[] = [];
    const missing: number[] = [];
    for (const p of uniquePositions) {
      const section = byPosition.get(p);
      if (section) {
        found.push({
          position: section.position,
          headingPath: section.headingPath,
          // 债 A：本地标题直读列（旧数据回填前为 null）
          headingText: section.headingText,
          headingLevel: section.headingLevel,
          isContinuation: section.isContinuation,
          content: section.content,
          tokenEstimate: section.tokenEstimate,
          sectionHash: this.computeSectionHash(section),
          // 保真渲染片段（与全文重建同款渲染规则）
          markdown: this.renderSectionPart(section, section.position, doc.title, false),
        });
      } else {
        missing.push(p);
      }
    }

    return { docId: doc.id, docPath: doc.path, sections: found, missing };
  }

  /**
   * headingQuery 模糊定位单节（v1.55）：对 outline headingPath 做大小写不敏感子串匹配。
   *
   * 场景：Agent 凭 route/记忆里不完整的 heading 片段定位节，免去「先 outline 抄精确
   * headingPath 再读节」的往返。
   *
   * **命中语义**（本方法拍板）：
   * - 唯一命中 → 返回该节（与 getSection 同形 DocSectionContent）；
   * - 多命中 → 409 RESOURCE_CONFLICT + data.candidates [{position, headingPath}]——
   *   绝不静默挑选（同名子标题在不同章节下可重复，静默选错节比报错更危险），
   *   候选透出 position 供调用方改用精确定位；
   * - 零命中 → 404 DOC_NOT_FOUND（与 getSection 锚点缺失语义一致），message 提示
   *   走 GET /docs/:id 拿 outline 核对 headingPath。
   *
   * 匹配实现：ILIKE '%<escaped>%'——LIKE 通配符（\ % _）逐字符转义保证字面子串语义
   * （findAll pathPrefix 同款先例）；NULL headingPath（headingLevel 0 文首段）不命中。
   *
   * @param docId 目标文档 ID（不存在/软删 → 404，findById）
   * @param headingQuery 非空子串（空串/全空白由 Controller 层拦在模糊通道之外）
   * 唯一命中返回值带 markdown（与 getSection 同口径：renderSectionPart skipDuplicateTitle=false
   * 保真渲染片段 = 该节在 full=true 全文中的**字节级子串**，oldString / section content 参照面）
   */
  async getSectionByHeadingQuery(docId: string, headingQuery: string): Promise<DocSectionContent> {
    const doc = await this.findById(docId);

    // LIKE 元字符转义（ESCAPE '\'）：用户输入中的 \ % _ 按字面量匹配
    const escaped = headingQuery.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const matches = await this.sectionRepo
      .createQueryBuilder('s')
      .where('s.doc_id = :docId', { docId })
      .andWhere("s.heading_path ILIKE :pattern ESCAPE '\\'", { pattern: `%${escaped}%` })
      .orderBy('s.position', 'ASC')
      .getMany();

    if (matches.length === 0) {
      throw new NotFoundException({
        message: `No section headingPath contains "${headingQuery}"; fetch the outline via GET /docs/:id to check available headingPaths`,
        code: ErrorCode.DOC_NOT_FOUND,
      });
    }

    if (matches.length > 1) {
      // 多命中歧义：409 + 候选列表（candidates 经 AllExceptionsFilter 的 data 槽透传）
      throw new ConflictException({
        message: `headingQuery "${headingQuery}" matches ${matches.length} sections; retry with an exact position or headingPath`,
        code: ErrorCode.RESOURCE_CONFLICT,
        data: {
          candidates: matches.map((m) => ({ position: m.position, headingPath: m.headingPath })),
        },
      });
    }

    const section = matches[0];
    return {
      docId: doc.id,
      docPath: doc.path,
      position: section.position,
      headingPath: section.headingPath,
      // 债 A：本地标题直读列（旧数据回填前为 null）
      headingText: section.headingText,
      headingLevel: section.headingLevel,
      isContinuation: section.isContinuation,
      content: section.content,
      tokenEstimate: section.tokenEstimate,
      sectionHash: this.computeSectionHash(section),
      // 保真渲染片段（与全文重建同款渲染规则）
      markdown: this.renderSectionPart(section, section.position, doc.title, false),
    };
  }

  /**
   * Section 级写：替换指定 position 的整节（v1.55，与 getSection 读侧对称）。
   *
   * **content 契约（含标题行，勿传裸正文）**：替换范围覆盖该 section 的**整节**——
   * 标题行 + 正文（chunker 把标题存进 headingPath/headingLevel，section.content 不含
   * 标题行；本方法替换的是该节在全文中的完整渲染片段）。因此 content 必须是与
   * read_doc section 模式 / GET /docs/:id/content?full=true 同形的渲染结果：
   * `## 标题\n\n正文...`。想保留原标题就在 content 里带上原标题行；传空串 = 删除该节。
   *
   * **管线复用**：替换后把整篇（其余 section 按 renderSectionPart 保真渲染 + 目标节
   * 换成新 content）交给 this.upsert 重跑 chunk/重建管线——sections 重建、outline /
   * position / contentHash / tokenEstimate / linkHealth 全部一致刷新，审计 / DOC_UPDATED
   * 事件 / route health 异步重检 / source 隔离 / unchanged 短路全部继承 upsert 语义，
   * 不新写第二套重建逻辑。title/summary 透传现存值，避免整篇回写冲掉策展元数据。
   *
   * **并发与 position 漂移**：本操作语义 = 文档粒度的 read-modify-write。fail-closed
   * 改造后，写路径携带内部乐观锁（expectedContentHash = 读取时的 doc.contentHash，
   * 在 upsert 事务内 FOR UPDATE 锁行复核）——读取→写入之间文档被并发改动 → 409
   * DOC_CONTENT_CONFLICT 而非静默覆盖；expectedSectionHash 携带时再叠加目标节锚点
   * 比对（事务外快速失败 + 文档级事务内复核兜底）。patch 改变文档结构（新 content
   * 引入/删除标题）后，其余节的 position 会漂移，调用方持有的旧 position/outline
   * 需重新 GET /docs/:id 刷新后再用。
   *
   * **错误语义**：文档不存在 → 404 DOC_NOT_FOUND（findById）；position 未落在实际
   * section 范围内 → 404 DOC_NOT_FOUND（与 getSection 的锚点缺失语义一致；负数等格式
   * 错误在 Controller 层 400 VALIDATION_ERROR 拦截，铁律 #21）；expectedSectionHash
   * 与目标节当前 hash 不符 → 409 DOC_CONTENT_CONFLICT（data.sectionCount 提示重拉
   * outline）；source 与文档 source 不符 → 409 DOC_SOURCE_MISMATCH（upsert 隔离检查
   * 继承）；读写在并发窗口内被抢改 → 409 DOC_CONTENT_CONFLICT（事务内复核）。
   *
   * @param docId 目标文档 ID
   * @param position 目标 section 的 0-based position（与 getSection/outline 同口径）
   * @param content 替换该整节的新渲染片段（含标题行；空串 = 删除该节）
   * @param source 请求方 source 标识（native 缺省；非 native 文档须携带匹配 source）
   * @param actor 操作者（审计用）
   * @param expectedSectionHash 可选前提校验：调用方读取时抄下的目标节 sectionHash
   *   （getSection/getSections 返回值），不符 → 409 fail-closed，防止 stale position
   *   在 re-chunk 漂移后写错块（Hument 事故 6dbc4da3）
   * @param clientRequestId 可选幂等键（v1.63.0）：重放返回首次响应快照 + idempotentReplay；
   *   同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT。幂等包裹在本入口（最外层），
   *   借道 upsertCore 的事务登记，快照形状 = 本入口响应（UpsertDocResult）
   * @returns upsert 结果 {id, path, sectionCount, tokenEstimate, unchanged?, contentHash}
   */
  async patchSection(
    docId: string,
    position: number,
    content: string,
    source: string,
    actor?: UnifiedActor,
    expectedSectionHash?: string,
    clientRequestId?: string,
  ): Promise<UpsertDocResult> {
    // 幂等包裹（最外层写入口）：requestHash = 本入口 payload 指纹（position/content/
    // source/expectedSectionHash），非内层 upsert 的 fullContent 指纹——同 key 不同
    // position 的两次 patch 必须判冲突而非静默复用首次结果
    const ctx = buildIdempotencyContext(actor, clientRequestId, {
      docId,
      position,
      content,
      source,
      expectedSectionHash,
    });
    if (ctx) {
      const replay = await tryIdempotentReplay<UpsertDocResult>(this.idempotencyRepo, ctx);
      if (replay) return { ...replay, idempotentReplay: true };
    }

    const doc = await this.findById(docId);

    // D9 防呆（Diagram IR v1，plan §3.3 M-b 落点）：diagram doc 禁止 markdown section 写——
    // 若放行进 upsertCore，拼接产物会被当 IR 解析报 422 stage:'parse'，错误语境混乱。
    // 统一心智模型：IR 按文档整体（upsert_diagram）或 JSON-patch（patch_diagram）改。
    if (doc.docType === DOC_TYPE_DIAGRAM) {
      throw new BadRequestException({
        message:
          `Document is docType='diagram': section-based text patching is not applicable; ` +
          `use patch_diagram (RFC 6902 JSON patch) or upsert_diagram (full IR replace) instead`,
        code: ErrorCode.DIAGRAM_DOC_TYPE_LOCKED,
      });
    }

    // 全量 section（position ASC）：拼接整篇与越界判断都需要有序全量。
    // 与 getContent 同款查询（doc_id + position ASC），走实体 hydration。
    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .where('s.doc_id = :docId', { docId: docId })
      .orderBy('s.position', 'ASC')
      .getMany();

    // 越界判断（铁律 #21 层 2 业务存在性）：position 必须命中实际存在的 section。
    // 负数由 Controller 层格式校验先行拦截，此处 <0 判断是对 Service 直调的防御兜底。
    if (!Number.isInteger(position) || position < 0 || position >= sections.length) {
      throw new NotFoundException({
        message: `Section position ${position} out of range (document has ${sections.length} sections, valid range 0-${Math.max(sections.length - 1, 0)})`,
        code: ErrorCode.DOC_NOT_FOUND,
      });
    }

    // expectedSectionHash 前提校验（fail-closed，事务外快速失败路径）：目标节锚点哈希
    // 与调用方读取时抄下的值不符 = 节已漂移/被改（stale position 写错块的事故形态），
    // 409 + data.sectionCount 提示重拉 outline。权威并发兜底 = 下方 upsert 携带的
    // expectedContentHash 事务内复核（sections 只由 upsert 重建管线写入，doc.contentHash
    // 不变 ⟺ sections 未重建，文档级哈希比对即可覆盖节级并发漂移）。
    if (expectedSectionHash !== undefined) {
      const currentHash = this.computeSectionHash(sections[position]);
      if (currentHash !== expectedSectionHash) {
        throw new ConflictException({
          message:
            `expectedSectionHash mismatch for position ${position}: the section changed since ` +
            `the caller's read (stale position/anchor); re-fetch the outline and retry ` +
            `(current sectionCount=${sections.length})`,
          code: ErrorCode.DOC_CONTENT_CONFLICT,
          data: { sectionCount: sections.length },
        });
      }
    }

    // 逐节渲染（skipDuplicateTitle=false：与 web full=true 通道一致的完整保真语义，
    // 保证拼回的整篇可安全回写不丢首标题），把目标节片段替换为新 content 后拼回整篇。
    // 注意替换发生在 filter 前的原始 parts 上（下标与 section position 一一对应）。
    const rawParts = sections.map((s, idx) => this.renderSectionPart(s, idx, doc.title, false));
    rawParts[position] = content;
    const fullContent = rawParts.filter((part) => part !== '').join('\n\n');

    // 复用 upsert 重建管线（title/summary 透传现存值；source 透传供隔离检查）。
    // expectedContentHash = 本次读取时的 doc.contentHash → TOCTOU 加固：读取 sections
    // 与 upsert 事务写入之间的并发改动在事务内 FOR UPDATE 复核时 409 回滚（fail-closed），
    // 不再静默互相覆盖。unchanged 幂等短路不受影响（hash 相符且内容未变 → 正常早退）。
    // versionSource='patch'：局部写通道（section 级 / 等面）→ 版本行的 source 字段标记。
    // 直调 upsertCore 携带本入口幂等 ctx（快照 = patchSection 响应形状，登记进 upsert
    // 主事务——业务提交 ⟺ 快照可查）
    return this.upsertCore(
      doc.spaceId,
      {
        path: doc.path,
        content: fullContent,
        title: doc.title,
        summary: doc.summary ?? undefined,
        source,
        versionSource: DOC_VERSION_SOURCE.PATCH,
        // 内部乐观锁（TOCTOU 加固）：doc.contentHash 为 null 的远古文档无哈希可比对，
        // 退化为无前提（无法加固的既有数据形态，不阻塞写）
        expectedContentHash: doc.contentHash ?? undefined,
      },
      actor,
      ctx,
    );
  }

  /**
   * Match 模式文档写：全文精确串替换（fail-closed 改造新增，与 patchSection 并列的
   * 第二种写模式——patch_doc 工具的 match 通道 / PATCH /docs/:id/content 端点）。
   *
   * **操作面钉死 = full=true 保真全文**（架构评审）：与 getContent(id, full=true)
   * 同款全文（renderSectionPart + skipDuplicateTitle=false + '\n\n' join）——
   * 与读侧 full=true 通道逐字节同形。web 渲染默认版（full=false）会去掉与 title
   * 同名的首标题行，调用方拿错通道构造 oldString 会零命中。
   *
   * **命中语义（fail-closed，绝不静默）**：
   * - 0 命中 → 404 DOC_NOT_FOUND（提示先读全文核对 oldString）；
   * - >1 命中 → 409 RESOURCE_CONFLICT + data.matchCount（提示扩大 oldString 上下文
   *   后重试——与 headingQuery 多命中「绝不静默挑选」同款哲学）；
   * - 恰好 1 命中 → 替换后复用 upsert 重建管线。
   *
   * **TOCTOU 加固**：与 patchSection 同款——upsert 携带 expectedContentHash =
   * 读取时的 doc.contentHash，事务内 FOR UPDATE 锁行复核；「计数时 1 处、写入时
   * 已变」的并发窗口在事务内被文档级哈希比对 409 回滚（内容不变 ⟹ 计数不变，
   * 哈希复核蕴含计数复核，无需独立闭包）。
   *
   * @param docId 目标文档 ID（不存在/软删 → 404 DOC_NOT_FOUND，findById）
   * @param oldString 待替换的精确子串（空串在 DTO 层 400 拦截；此处不重复校验）
   * @param newString 替换内容（可为空串 = 删除该片段；函数式 replacer 防 $ 模式被解释）
   * @param source 请求方 source 标识（native 缺省；非 native 文档须携带匹配 source）
   * @param actor 操作者（审计用）
   * @param clientRequestId 可选幂等键（v1.63.0）：重放返回首次响应快照 + idempotentReplay；
   *   同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT。幂等包裹在本入口（最外层），
   *   借道 upsertCore 的事务登记，快照形状 = 本入口响应（UpsertDocResult）
   * @returns upsert 结果 {id, path, sectionCount, tokenEstimate, unchanged?, contentHash}
   */
  async patchByMatch(
    docId: string,
    oldString: string,
    newString: string,
    source: string,
    actor?: UnifiedActor,
    clientRequestId?: string,
  ): Promise<UpsertDocResult> {
    // 幂等包裹（最外层写入口）：requestHash = 本入口 payload 指纹（oldString/newString/
    // source），非内层 upsert 的 fullContent 指纹
    const ctx = buildIdempotencyContext(actor, clientRequestId, {
      docId,
      oldString,
      newString,
      source,
    });
    if (ctx) {
      const replay = await tryIdempotentReplay<UpsertDocResult>(this.idempotencyRepo, ctx);
      if (replay) return { ...replay, idempotentReplay: true };
    }

    const doc = await this.findById(docId);

    // D9 防呆（Diagram IR v1，plan §3.3 M-b 落点）：diagram doc 禁止 markdown match 写——
    // IR 是结构化 JSON，substring 替换语义不适用；用 patch_diagram / upsert_diagram。
    if (doc.docType === DOC_TYPE_DIAGRAM) {
      throw new BadRequestException({
        message:
          `Document is docType='diagram': match-based text patching is not applicable; ` +
          `use patch_diagram (RFC 6902 JSON patch) or upsert_diagram (full IR replace) instead`,
        code: ErrorCode.DIAGRAM_DOC_TYPE_LOCKED,
      });
    }

    // 操作面 = getContent(id, full=true) 同款全文（见方法 doc 注释「操作面钉死」）
    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .where('s.doc_id = :docId', { docId: doc.id })
      .orderBy('s.position', 'ASC')
      .getMany();
    const fullContent = this.reconstructContent(doc, sections, false);

    // 精确子串计数（split 段数 - 1 = 命中次数）
    const matchCount = fullContent.split(oldString).length - 1;

    if (matchCount === 0) {
      throw new NotFoundException({
        message:
          `oldString not found in the document's full content (0 matches); ` +
          `re-read the full content (GET /docs/:id/content?full=true or read_doc) and retry`,
        code: ErrorCode.DOC_NOT_FOUND,
      });
    }

    if (matchCount > 1) {
      // 多命中歧义：409 + matchCount（绝不静默替换某一处——与 headingQuery 多命中同款契约）
      throw new ConflictException({
        message:
          `oldString matches ${matchCount} locations in the document; ` +
          `expand oldString with more surrounding context to make it unique and retry`,
        code: ErrorCode.RESOURCE_CONFLICT,
        data: { matchCount },
      });
    }

    // 唯一命中：函数式 replacer（newString 中的 $&/$1 等模式按字面量处理，不被解释）
    const newContent = fullContent.replace(oldString, () => newString);

    // 复用 upsert 重建管线 + 内部乐观锁（见方法 doc 注释「TOCTOU 加固」）。
    // versionSource='patch'：match 模式局部写 → 版本行的 source 字段标记。
    // 直调 upsertCore 携带本入口幂等 ctx（快照 = patchByMatch 响应形状，登记进 upsert
    // 主事务——业务提交 ⟺ 快照可查）。
    return this.upsertCore(
      doc.spaceId,
      {
        path: doc.path,
        content: newContent,
        title: doc.title,
        summary: doc.summary ?? undefined,
        source,
        versionSource: DOC_VERSION_SOURCE.PATCH,
        // 内部乐观锁（TOCTOU 加固）：doc.contentHash 为 null 的远古文档无哈希可比对，
        // 退化为无前提（无法加固的既有数据形态，不阻塞写）
        expectedContentHash: doc.contentHash ?? undefined,
      },
      actor,
      ctx,
    );
  }

  /**
   * 追加写原语（v1.65.0 消费者反馈批 7601e2f5）：一步把 content 追加到文档末尾
   * （position='end'，默认）或指定 heading 小节子树末尾（position='under-heading'）。
   *
   * **并发免疫（本入口核心卖点）**：upsertCore 抛 DOC_CONTENT_CONFLICT（读取→写入
   * 窗口内被并发改动，事务内 FOR UPDATE 复核 409 回滚）时，服务端**内部重试**——
   * 重读 doc+sections → 重新变换 → 重写，最多 3 次；只对这一个错误码重试，其他
   * 错误直接抛。重试循环在事务外（每次 upsertCore 自开事务），无长事务；幂等 ctx
   * 跨重试保持不变（快照登记在最终成功的那次 upsert 事务里——业务提交 ⟺ 快照可查）。
   * 3 次耗尽才把 409 抛给调用方。调用方因此无需 read→patch 三步（日记场景首选）。
   *
   * **变换语义**：
   * - 'end'：full=true 保真全文 + '\n\n' + content.trim()（trim 掉首尾空白，拼接分隔
   *   与管线 '\n\n' join 一致；空文档直接 content，避免前导空行）；
   * - 'under-heading'：sections 按 heading_path 精确匹配定位目标节；子树边界推导 =
   *   目标节 + 其后所有「同 heading_path 的 is_continuation 节」+「heading_path 以
   *   目标path + ' § ' 为前缀的更深节」；新内容作为新 part 插到子树末尾（下一个
   *   非子树节之前），parts 数组插入后 filter(p => p !== '').join('\n\n') 拼回
   *   （照 patchSection 的整篇拼接手法）。
   *
   * **headingPath 解析错误语义（对齐平台惯例，绝不静默挑选）**：0 命中 → 404
   * DOC_NOT_FOUND + data.availableHeadingPaths（与 getSection 锚点缺失语义一致）；
   * >1 命中（同名标题同 path，v1.57.3 后可能存在）→ 409 RESOURCE_CONFLICT +
   * data.candidates [{position, headingPath}]。
   *
   * **幂等**：与 patch 两入口同款——requestHash = 本入口 payload 指纹（docId/content/
   * position/headingPath/source），重放返回首次快照 + idempotentReplay；同 key 不同
   * payload → 409 IDEMPOTENCY_KEY_CONFLICT。幂等包裹在最外层，借道 upsertCore 事务登记。
   *
   * @param docId 目标文档 ID（不存在/软删 → 404 DOC_NOT_FOUND，findById）
   * @param dto 追加输入（content 必填；position 缺省 'end'；under-heading 时 headingPath 必填）
   * @param source 请求方 source 标识（native 缺省；非 native 文档须携带匹配 source，
   *   隔离检查在 upsertCore 内完成——与 patch 两入口同款）
   * @param actor 操作者（审计用）
   * @param clientRequestId 可选幂等键（v1.63.0 幂等体系）
   * @returns upsert 结果 {id, path, sectionCount, tokenEstimate, unchanged?, contentHash}
   *   （新 contentHash 供链式写；幂等重放附 idempotentReplay: true）
   */
  async appendDoc(
    docId: string,
    dto: AppendDocInput,
    source: string,
    actor?: UnifiedActor,
    clientRequestId?: string,
  ): Promise<UpsertDocResult> {
    // 幂等包裹（最外层写入口）：requestHash = 本入口 payload 指纹（position 缺省值
    // 归一化进指纹——'end' 显式传与缺省视为同一请求），非内层 upsert 的 fullContent 指纹
    const ctx = buildIdempotencyContext(actor, clientRequestId, {
      docId,
      content: dto.content,
      position: dto.position ?? 'end',
      headingPath: dto.headingPath,
      source,
    });
    if (ctx) {
      const replay = await tryIdempotentReplay<UpsertDocResult>(this.idempotencyRepo, ctx);
      if (replay) return { ...replay, idempotentReplay: true };
    }

    // 并发免疫重试循环（事务外，无长事务）：只对 DOC_CONTENT_CONFLICT 重试——
    // 该错误语义 = 「读取→写入窗口内被并发改动」，重读重写即可收敛；其他错误
    // （404/409 source/幂等冲突等）直接抛。幂等 ctx 跨重试保持不变。
    const MAX_APPEND_RETRIES = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.appendDocOnce(docId, dto, source, actor, ctx);
      } catch (err) {
        if (attempt < MAX_APPEND_RETRIES && isDocContentConflictError(err)) continue;
        throw err;
      }
    }
  }

  /**
   * appendDoc 单次尝试（重试循环的循环体）：读 doc+sections → 变换 → upsertCore。
   *
   * 与 patch 两入口同构：findById（404 判空）→ 全量 section（position ASC）→
   * 变换 → upsertCore（title/summary 透传现存值防冲掉策展元数据；expectedContentHash
   * = 读取时的 doc.contentHash 作内部乐观锁，事务内 FOR UPDATE 复核——并发改动
   * 409 回滚，由外层 appendDoc 重试循环消化）。
   *
   * @param ctx 幂等上下文（null = 无键旁路）；携带时快照登记进 upsert 主事务
   */
  private async appendDocOnce(
    docId: string,
    dto: AppendDocInput,
    source: string,
    actor: UnifiedActor | undefined,
    ctx: DocWriteIdempotencyContext | null,
  ): Promise<UpsertDocResult> {
    const doc = await this.findById(docId);

    // D9 防呆（Diagram IR v1，plan §3.3 M-b 落点）：diagram doc 禁止 markdown 追加写——
    // 单节合成文档无 heading 子树语义；用 patch_diagram / upsert_diagram。
    if (doc.docType === DOC_TYPE_DIAGRAM) {
      throw new BadRequestException({
        message:
          `Document is docType='diagram': append is not applicable to a structured IR document; ` +
          `use patch_diagram (RFC 6902 JSON patch) or upsert_diagram (full IR replace) instead`,
        code: ErrorCode.DIAGRAM_DOC_TYPE_LOCKED,
      });
    }

    // 全量 section（position ASC）：end 模式拼整篇与 under-heading 模式子树推导
    // 都需要有序全量（与 patch 两入口同款查询）
    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .where('s.doc_id = :docId', { docId: doc.id })
      .orderBy('s.position', 'ASC')
      .getMany();

    const position = dto.position ?? 'end';
    const newContent =
      position === 'under-heading'
        ? this.appendUnderHeading(doc, sections, dto.headingPath ?? '', dto.content)
        : this.appendToEnd(doc, sections, dto.content);

    // 复用 upsert 重建管线（title/summary 透传现存值；source 透传供隔离检查）。
    // versionSource='append'：追加写 → 版本行的 source 字段标记（doc_versions.source
    // 为自由 varchar(16) 无 DB 约束，直接扩展字面量，见 shared DOC_VERSION_SOURCES）。
    // 直调 upsertCore 携带本入口幂等 ctx（快照 = appendDoc 响应形状，登记进 upsert
    // 主事务——业务提交 ⟺ 快照可查）
    return this.upsertCore(
      doc.spaceId,
      {
        path: doc.path,
        content: newContent,
        title: doc.title,
        summary: doc.summary ?? undefined,
        source,
        versionSource: DOC_VERSION_SOURCE.APPEND,
        // 内部乐观锁（TOCTOU 加固）：doc.contentHash 为 null 的远古文档无哈希可比对，
        // 退化为无前提（无法加固的既有数据形态，不阻塞写）
        expectedContentHash: doc.contentHash ?? undefined,
      },
      actor,
      ctx,
    );
  }

  /**
   * end 模式变换：full=true 保真全文 + '\n\n' + content.trim()。
   *
   * trim 掉首尾空白（追加内容不应携带调用方排版噪声）；拼接分隔与管线 '\n\n' join
   * 一致（保证「全文读 + upsert 回写」往返幂等）。空文档（无 section，fullContent=''）
   * 直接返回 content.trim()——避免前导空行被 chunker 解析成空 level-0 段。
   */
  private appendToEnd(doc: Doc, sections: DocSection[], content: string): string {
    const fullContent = this.reconstructContent(doc, sections, false);
    const trimmed = content.trim();
    return fullContent === '' ? trimmed : `${fullContent}\n\n${trimmed}`;
  }

  /**
   * under-heading 模式变换：把 content 作为新 part 插到目标节子树末尾。
   *
   * **子树边界推导**（设计决策，架构评审拍板）：目标节 + 其后所有「同 heading_path
   * 的 is_continuation 节」（chunker 对 >4000 字符长节按段落二次切分的续 chunk）+
   * 「heading_path 以 目标path + ' § ' 为前缀的更深节」（子标题）构成子树；新内容
   * 插到子树末尾 = 下一个非子树节之前。' § ' 带空格后缀防前缀碰撞（'A § B' 不吞
   * 'A § B2'）。
   *
   * **命中语义（fail-closed，绝不静默）**：匹配只认 isContinuation=false 的真实
   * 标题节（continuation 与目标节同 path，是子树成员而非独立目标——计入会把
   * 「目标节+续节」误判成多命中）；0 命中 → 404 DOC_NOT_FOUND +
   * data.availableHeadingPaths（与 getSection 锚点缺失语义一致）；>1 命中（真实
   * 同名 sibling 标题，v1.57.3 run-dedup 后可能）→ 409 RESOURCE_CONFLICT +
   * data.candidates [{position, headingPath}]（与 headingQuery 多命中同款契约）。
   *
   * 拼接手法照 patchSection：rawParts 与 sections 下标一一对应（渲染可能产生空串：
   * 首标题去重/空 level-0 段），插入发生在 filter 前，最后 filter + '\n\n' join。
   */
  private appendUnderHeading(
    doc: Doc,
    sections: DocSection[],
    headingPath: string,
    content: string,
  ): string {
    // 精确匹配（heading_path 列等值；level-0 文首段 headingPath=null 不命中）。
    // ⚠️ 只认 isContinuation=false 的真实标题节：continuation 续 chunk 与目标节共享
    // 同一 heading_path（chunker 对 >4000 字符长节的段落二次切分），它们是目标节的
    // 子树成员而非独立目标——计入匹配会把「目标节 + 续节」误判成多命中 409。
    // 真实同名 sibling（v1.57.3 后可能：同 path 两个 isContinuation=false 节）仍多命中。
    const targetIndexes = sections
      .map((s, idx) => (s.headingPath === headingPath && !s.isContinuation ? idx : -1))
      .filter((idx) => idx >= 0);

    if (targetIndexes.length === 0) {
      // 0 命中 → 404 + 可用 headingPath 列表（去重保序，供调用方核对 outline；
      // continuation 节与父节同 path，天然被去重）
      const available = [
        ...new Set(
          sections
            .filter((s) => !s.isContinuation)
            .map((s) => s.headingPath)
            .filter((p): p is string => p !== null && p !== ''),
        ),
      ];
      throw new NotFoundException({
        message:
          `headingPath "${headingPath}" not found in document; ` +
          `available headingPaths: ${available.length > 0 ? available.join(', ') : '(none)'}`,
        code: ErrorCode.DOC_NOT_FOUND,
        data: { availableHeadingPaths: available },
      });
    }

    if (targetIndexes.length > 1) {
      // 多命中歧义：409 + 候选 position 列表（绝不静默挑选——与 headingQuery 多命中同款契约）
      throw new ConflictException({
        message:
          `headingPath "${headingPath}" matches ${targetIndexes.length} sections; ` +
          `retry with a more specific headingPath`,
        code: ErrorCode.RESOURCE_CONFLICT,
        data: {
          candidates: targetIndexes.map((idx) => ({
            position: sections[idx].position,
            headingPath: sections[idx].headingPath,
          })),
        },
      });
    }

    const targetIdx = targetIndexes[0];

    // 子树边界推导（见方法 doc 注释）：目标节 + 同 path 的 continuation 续节 +
    // 以 '目标path § ' 为前缀的更深节；边界 = 第一个非子树节
    let subtreeEnd = targetIdx + 1;
    while (subtreeEnd < sections.length) {
      const s = sections[subtreeEnd];
      const isContinuationOfTarget = s.headingPath === headingPath && s.isContinuation;
      const isDeeper = s.headingPath !== null && s.headingPath.startsWith(`${headingPath} § `);
      if (!isContinuationOfTarget && !isDeeper) break;
      subtreeEnd++;
    }

    // 逐节渲染（skipDuplicateTitle=false：与 web full=true 通道一致的完整保真语义），
    // 新 part 插到子树末尾（splice 在 filter 前的原始 parts 上，下标与 section 一一对应）
    const rawParts = sections.map((s, idx) => this.renderSectionPart(s, idx, doc.title, false));
    rawParts.splice(subtreeEnd, 0, content.trim());
    return rawParts.filter((part) => part !== '').join('\n\n');
  }

  /**
   * Metadata-only patch：只更新 docs 行元数据列，不触碰内容面
   * （v1.61.0 批次 2，Board 任务 201ae04f，游戏方 Pilot 1b 契约 6 条照单实现）。
   *
   * **Partial 三态语义**：只更新显式字段（title/summary/docType/tags/category）；
   * 字段缺席 = 不动；`tags: []` = 清空；null 在 DTO 层 400 拒绝（@ValidateIf 三态
   * 区分，见 patch-doc-metadata.dto.ts AGENT-HOOK）。
   *
   * **不变量契约（铁律 #18）**：不重切 sections、不落 doc_versions、不动
   * contentHash/docId/task_doc_links/doc_routes——唯一写操作 = 单事务
   * `UPDATE docs SET <changed metadata columns>`。因此也不触发 route health
   * recheck（sections 未动，headingPath 不会悬空）与 linkHealth 重算（内容未动）。
   *
   * **fail-closed 校验链（顺序即错误码语义）**：
   * 404 DOC_NOT_FOUND（不存在/软删，findById）→ 409 DOC_SOURCE_MISMATCH
   * （非 native——与 upsert/patch 一致，ingest 文档由适配器管）→
   * 409 DOC_CONTENT_CONFLICT（expectedContentHash 必填，事务外快速失败 +
   * 事务内 FOR UPDATE 复核，复用 upsert/move 先例模式）→
   * 404 DOC_CATEGORY_NOT_FOUND（category 默认只解析既有分类，防拼写产生近似分类；
   * 显式 allowCreateCategory=true 才走 resolveCategory 自动创建）。
   *
   * **unchanged 短路**：全部显式字段与现值相同 → 不产生任何写操作
   * （无 UPDATE/audit/事件），响应 unchanged:true + changedFields:[]。
   * 变更判定在事务内 FOR UPDATE 锁行后对锁行值计算——并发 metadata 写不改变
   * contentHash（hash 复核只拦内容并发），锁行值才是权威的比对基准。
   *
   * @param docId 目标文档 ID（不存在/软删 → 404）
   * @param dto Partial 元数据 + 必填 expectedContentHash + allowCreateCategory 开关
   * @param actor 操作者（audit 用；未认证写不落 audit，对齐既有 doc 写通道）
   * @param clientRequestId 可选幂等键（v1.63.0）：重放返回首次响应快照 + idempotentReplay
   *   （unchanged 快照同样登记）；同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT
   * @returns PatchDocMetadataResult（changedFields/unchanged/最终元数据视图）
   */
  async patchMetadata(
    docId: string,
    dto: {
      title?: string;
      summary?: string;
      docType?: string;
      tags?: string[];
      category?: string;
      expectedContentHash: string;
      allowCreateCategory?: boolean;
    },
    actor?: UnifiedActor,
    clientRequestId?: string,
  ): Promise<PatchDocMetadataResult> {
    // 幂等包裹（最外层写入口）：无键零开销旁路；有键先查重放——命中直接返回首次快照，
    // 跳过 source/hash/category 校验链（首次已验证过，重放零副作用）
    const ctx = buildIdempotencyContext(actor, clientRequestId, {
      docId,
      title: dto.title,
      summary: dto.summary,
      docType: dto.docType,
      tags: dto.tags,
      category: dto.category,
      allowCreateCategory: dto.allowCreateCategory,
      expectedContentHash: dto.expectedContentHash,
    });
    if (ctx) {
      const replay = await tryIdempotentReplay<PatchDocMetadataResult>(this.idempotencyRepo, ctx);
      if (replay) return { ...replay, idempotentReplay: true };
    }

    // ① 404：文档不存在/已软删（findById fail-closed，铁律 #22）
    const doc = await this.findById(docId);

    // ② 409 DOC_SOURCE_MISMATCH：native-only（与 upsert/patch 一致——ingest 文档
    // 元数据由适配器管，平台侧直改会撕裂 sync 语义）
    if (doc.source !== DOC_SOURCE_NATIVE) {
      throw new ConflictException({
        message:
          `Document source '${doc.source}' is not ${DOC_SOURCE_NATIVE}; only native documents can be ` +
          `metadata-patched (ingest documents are managed by their adapter)`,
        code: ErrorCode.DOC_SOURCE_MISMATCH,
      });
    }

    // ③ 409 DOC_CONTENT_CONFLICT：expectedContentHash 事务外快速失败——
    // 权威校验在事务内 FOR UPDATE 后复核（防 TOCTOU 窗口，复用 upsert/move 先例模式）
    if (doc.contentHash !== dto.expectedContentHash) {
      throw new ConflictException({
        message:
          `expectedContentHash mismatch: document was modified since the caller's read ` +
          `(expected ${dto.expectedContentHash}, current ${doc.contentHash}); re-read the document and retry`,
        code: ErrorCode.DOC_CONTENT_CONFLICT,
        data: { currentContentHash: doc.contentHash },
      });
    }

    // ④ category 解析（仅显式携带时）：默认只解析既有分类（不命中 → 404 明确 code，
    // 防拼写产生近似分类）；allowCreateCategory=true 才走 resolveCategory 自动创建。
    // 事务外解析与 move/upsert 先例同款（创建分类后若事务内 hash 复核失败，
    // 可能留下孤立新分类——既有 upsert 路径同语义，不额外加复杂度）
    let resolvedCategoryId: string | null | undefined;
    if (dto.category !== undefined) {
      resolvedCategoryId = dto.allowCreateCategory
        ? await this.resolveCategory(doc.spaceId, dto.category)
        : await this.findCategoryByName(doc.spaceId, dto.category);
      if (!resolvedCategoryId) {
        throw new NotFoundException({
          message:
            `Category '${dto.category}' not found in space (resolve-only mode); ` +
            `pass allowCreateCategory=true to auto-create it`,
          code: ErrorCode.DOC_CATEGORY_NOT_FOUND,
        });
      }
    }

    // ── 事务：锁行 → hash 复核 → 对锁行值算变更面 → 仅 UPDATE 变更列 ──────────
    // v1.63.0 幂等：事务内登记幂等记录；并发同 key 撞 uq_idempotency_actor_key →
    // 整个事务回滚（零副作用）→ catch 按重放语义返回对方首次快照
    let tx: {
      changed: boolean;
      result: PatchDocMetadataResult;
      changedFields: string[];
      before: Record<string, unknown>;
      updates: Record<string, unknown>;
    };
    try {
      tx = await this.docRepo.manager.transaction(async (manager) => {
        const docRepo = manager.getRepository(Doc);

        // FOR UPDATE 锁行（并发写被行锁串行化，与 upsert/move 同款）
        const locked = await docRepo
          .createQueryBuilder('d')
          .setLock('pessimistic_write')
          .where('d.id = :id', { id: docId })
          .andWhere('d.deleted_at IS NULL')
          .getOne();
        if (!locked) {
          // 事务外 findById 通过但锁行时已被并发删（软删）——回滚并 404
          throw new NotFoundException({
            message: 'Document not found',
            code: ErrorCode.DOC_NOT_FOUND,
          });
        }

        // 事务内复核 expectedContentHash（TOCTOU：事务外校验与写入之间有并发窗口）
        if (locked.contentHash !== dto.expectedContentHash) {
          throw new ConflictException({
            message:
              `expectedContentHash mismatch (in-transaction recheck): document was modified ` +
              `concurrently (expected ${dto.expectedContentHash}, current ${locked.contentHash}); ` +
              `re-read the document and retry`,
            code: ErrorCode.DOC_CONTENT_CONFLICT,
            data: { currentContentHash: locked.contentHash },
          });
        }

        // 变更面判定——基准 = 锁行值（并发 metadata 写不改 contentHash，hash 复核拦不住，
        // 锁行值才是权威基准；缺席字段不参与判定 = Partial 语义）
        const before: Record<string, unknown> = {};
        const updates: Record<string, unknown> = {};
        const changedFields: string[] = [];

        if (dto.title !== undefined && dto.title !== locked.title) {
          changedFields.push('title');
          before.title = locked.title;
          updates.title = dto.title;
        }
        if (dto.summary !== undefined && dto.summary !== locked.summary) {
          changedFields.push('summary');
          before.summary = locked.summary;
          updates.summary = dto.summary;
        }
        if (dto.docType !== undefined && dto.docType !== locked.docType) {
          // D10 docType 转换双向守卫（Diagram IR v1，plan §0 D10）：metadata-only 通道
          // 不重切/不渲染（本方法契约），任何触及 'diagram' 的转换都会留下"diagram 无
          // 快照"（转入）或"IR 当 markdown"（转出）的烂态 → 400 指路 upsert 通道。
          if (dto.docType === DOC_TYPE_DIAGRAM || locked.docType === DOC_TYPE_DIAGRAM) {
            throw new BadRequestException({
              message:
                `docType transitions involving 'diagram' are not allowed on the metadata-only ` +
                `channel (no re-chunk/re-render here); use upsert_diagram / PUT /doc-spaces/:id/diagrams ` +
                `with the full IR (markdown → diagram) or PUT /docs with the full markdown content ` +
                `and an explicit non-diagram docType (diagram → markdown) instead`,
              code: ErrorCode.DIAGRAM_DOC_TYPE_LOCKED,
            });
          }
          changedFields.push('docType');
          before.docType = locked.docType;
          updates.docType = dto.docType;
        }
        if (
          dto.tags !== undefined &&
          (dto.tags.length !== locked.tags.length || dto.tags.some((t, i) => t !== locked.tags[i]))
        ) {
          changedFields.push('tags');
          before.tags = [...locked.tags];
          updates.tags = dto.tags;
        }
        if (resolvedCategoryId !== undefined && resolvedCategoryId !== locked.categoryId) {
          changedFields.push('category');
          before.categoryId = locked.categoryId;
          updates.categoryId = resolvedCategoryId;
        }

        // unchanged 短路：零变更 → 不产生任何写操作（无 UPDATE/audit/事件）。
        // 响应在事务内组装（v1.63.0 幂等：unchanged 快照同样登记，重放语义一致）
        if (changedFields.length === 0) {
          const result: PatchDocMetadataResult = {
            docId,
            path: locked.path,
            contentHash: locked.contentHash,
            changedFields: [],
            unchanged: true,
            // buildMetadataView 在事务内调用安全：locked 行来自事务连接（可见未提交值）；
            // category 行不被本事务修改，经独立连接读取已提交数据正确
            metadata: await this.buildMetadataView(locked),
          };
          if (ctx) {
            await insertIdempotencyInTx(manager, ctx, docId, result);
          }
          return { changed: false as const, result, changedFields, before, updates };
        }

        // 唯一写操作：只 UPDATE 变更的元数据列 + updatedAt（⚠️ QueryBuilder.update
        // 不触发 @UpdateDateColumn——那是 save() 的行为，必须显式 NOW()，同 move 先例）。
        // 不碰 content/sections/contentHash/versions/引用面——metadata-only 契约核心
        await docRepo
          .createQueryBuilder()
          .update('Doc')
          .set({ ...updates, updatedAt: () => 'NOW()' })
          .where('id = :id', { id: docId })
          .execute();

        const fresh = await docRepo
          .createQueryBuilder('d')
          .where('d.id = :id', { id: docId })
          .andWhere('d.deleted_at IS NULL')
          .getOne();
        if (!fresh) {
          throw new NotFoundException({
            message: 'Document not found',
            code: ErrorCode.DOC_NOT_FOUND,
          });
        }

        // 最终响应在事务内组装并落幂等快照——「业务提交 ⟺ 快照可查」原子性；
        // 并发同 key 撞 uq_idempotency_actor_key → 异常上抛使整个事务回滚（零副作用）
        const result: PatchDocMetadataResult = {
          docId,
          path: fresh.path,
          contentHash: fresh.contentHash,
          changedFields,
          unchanged: false,
          metadata: await this.buildMetadataView(fresh),
        };
        if (ctx) {
          await insertIdempotencyInTx(manager, ctx, docId, result);
        }
        return { changed: true as const, result, changedFields, before, updates };
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key' && ctx) {
        const replay = await tryIdempotentReplay<PatchDocMetadataResult>(this.idempotencyRepo, ctx);
        if (replay) return { ...replay, idempotentReplay: true };
      }
      throw err;
    }

    // unchanged 短路：不发 audit/事件（无写操作，对齐 upsert unchanged 早退语义）
    if (!tx.changed) {
      return tx.result;
    }

    // audit（复用 UPDATE 类动作；newData 记 changedFields 前后值——任务契约）
    if (actor) {
      const after: Record<string, unknown> = {};
      for (const field of tx.changedFields) {
        if (field === 'category') {
          after.categoryId = tx.updates.categoryId;
        } else {
          after[field] = tx.updates[field];
        }
      }
      const auditEntry = this.auditRepo.create({
        action: AuditAction.UPDATE,
        entityType: AUDIT_ENTITY_TYPE.DOC,
        entityId: docId,
        actorId: actor.id,
        newData: { metadataOnly: true, changedFields: tx.changedFields, before: tx.before, after },
        source: 'api',
      });
      await this.auditRepo.save(auditEntry);
    }

    // DOC_UPDATED 事件：payload 标 metadataOnly + changedFields（订阅方可区分内容变更）；
    // topicId/boardId 经 getSpaceEventContext 从空间绑定派生（B-51 SSE actor 过滤同路径；
    // eventCtx 局部改名避免与幂等 ctx 混淆）
    const eventCtx = await this.getSpaceEventContext(doc.spaceId);
    await this.eventService.create({
      eventType: EventType.DOC_UPDATED,
      resourceType: ResourceType.DOC,
      resourceId: docId,
      actorId: actor?.id ?? undefined,
      topicId: eventCtx.topicId ?? undefined,
      boardId: eventCtx.boardId ?? undefined,
      payload: {
        spaceId: doc.spaceId,
        docId,
        path: tx.result.path,
        title: tx.result.metadata.title,
        metadataOnly: true,
        changedFields: tx.changedFields,
      },
    });

    // 正常执行路径直接返回事务内组装的响应（与幂等快照同引用，重放逐字段一致）
    return tx.result;
  }

  /**
   * 构建 metadata-only patch 响应的最终元数据视图（buildMetadataView）。
   *
   * categoryId 非空时查分类名（轻量单查，select name）；null 时 categoryName 亦 null。
   * 供 patchMetadata 的 changed/unchanged 两分支共用。
   */
  private async buildMetadataView(doc: Doc): Promise<PatchDocMetadataView> {
    let categoryName: string | null = null;
    if (doc.categoryId) {
      const cat = await this.categoryRepo
        .createQueryBuilder('dc')
        .select(['dc.id', 'dc.name'])
        .where('dc.id = :id', { id: doc.categoryId })
        .andWhere('dc.deleted_at IS NULL')
        .getOne();
      categoryName = cat?.name ?? null;
    }
    return {
      title: doc.title,
      summary: doc.summary,
      docType: doc.docType,
      tags: [...doc.tags],
      categoryId: doc.categoryId,
      categoryName,
    };
  }

  /**
   * Soft-delete a document.
   * Source isolation: non-native (ingest) docs only deletable by matching source.
   * Native docs deletable by any authorized actor (creator/editor gate in controller).
   */
  async remove(
    docId: string,
    source?: string,
    actor?: UnifiedActor,
  ): Promise<{ deleted: boolean; path: string }> {
    const doc = await this.findById(docId);

    // Source isolation (强制校验): non-native docs can only be deleted by a
    // request carrying the EXACT matching source (?source= query param).
    // A missing/undefined source also mismatches → ingest docs cannot be
    // deleted through the plain API path (sync-docs.mjs passes ?source=).
    // Native docs are unaffected (deletable by any authorized actor).
    if (doc.source !== DOC_SOURCE_NATIVE && source !== doc.source) {
      throw new ConflictException({
        message: `Document source '${doc.source}' does not match request source '${source ?? '<missing>'}'`,
        code: ErrorCode.DOC_SOURCE_MISMATCH,
      });
    }

    // Soft-delete the doc (sections cascade via CASCADE FK)
    await this.docRepo
      .createQueryBuilder()
      .update('Doc')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ deletedAt: new Date() } as any)
      .where('id = :id', { id: docId })
      .execute();

    // Audit hook (对齐 upsert；plan §1.1-17 审计覆盖 doc 写操作)
    if (actor) {
      const auditEntry = this.auditRepo.create({
        action: AuditAction.DELETE,
        entityType: AUDIT_ENTITY_TYPE.DOC,
        entityId: docId,
        actorId: actor.id,
        newData: { path: doc.path, title: doc.title },
        source: 'api',
      });
      await this.auditRepo.save(auditEntry);
    }

    // Emit event after soft-delete
    const ctx = await this.getSpaceEventContext(doc.spaceId);
    await this.eventService.create({
      eventType: EventType.DOC_DELETED,
      resourceType: ResourceType.DOC,
      resourceId: docId,
      actorId: actor?.id ?? undefined,
      topicId: ctx.topicId ?? undefined,
      boardId: ctx.boardId ?? undefined,
      payload: { spaceId: doc.spaceId, docId, path: doc.path, title: doc.title },
    });

    // Async fire-and-forget: recalculate link_health for all docs in space
    // (removing this doc may break links in other docs that reference it)
    const spaceId = doc.spaceId;
    setImmediate(() => {
      this.recalcSpaceLinkHealth(spaceId).catch((err: unknown) => {
        this.logger.error(`recalcSpaceLinkHealth failed for space ${spaceId}`, err);
      });
      // 批次 C1：路由引用的 doc 被删 → 该路由指向的锚点大概率悬空，同批次异步重检
      // doc_routes health（与 link_health 重算同一 fire-and-forget 时机，不引入额外调度；
      // Promise.resolve().then(...).catch(...) 安全模式见 upsert 触发点注释）
      void Promise.resolve()
        .then(() => this.routeHealthService.recheckSpace(spaceId))
        .catch((err: unknown) => {
          this.logger.error(`route health recheck failed for space ${spaceId}`, err);
        });
    });

    return { deleted: true, path: doc.path };
  }

  /**
   * Recalculate link_health for every non-deleted doc in a space（v1.61.0 批次 1 重构）。
   *
   * - 调用方：remove/move 事务后的 fire-and-forget 异步任务（失败仅记日志不透出），
   *   以及 POST /doc-spaces/:id/docs/link-health/recheck 同步手动重检端点（返回值
   *   即响应体——checked/broken 计数）。
   * - sections 拉取批量（v1.61.0 性能修复，review 发现）：一次 `WHERE doc_id IN (...)`
   *   取全空间 sections 按 docId 分组，替换逐 doc 单查（N+1）——同步 HTTP 端点下
   *   千级文档会把单次 recheck 顶穿超时。
   *
   * 返回值契约（v1.61.0 从 void 升级为计数）：{ checked, broken }——
   * checked = 本次重算的文档数；broken = 全部文档 broken 数组长度合计。
   * 语义对齐 routes/recheck 先例（rechecked/broken 计数），供端点直接透传。
   *
   * public（v1.60.0-dev）：move 事务提交后同款异步重算（旧 path 入链即刻变断链可见），
   * 与 remove 触发路径共用一份实现。
   */
  async recalcSpaceLinkHealth(spaceId: string): Promise<{ checked: number; broken: number }> {
    // Get all non-deleted docs in space (id + path for candidate resolution)
    const docs = await this.docRepo
      .createQueryBuilder('d')
      .select(['d.id', 'd.path'])
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .getMany();

    if (docs.length === 0) return { checked: 0, broken: 0 };

    const docIds = new Set(docs.map((d) => d.id));
    const paths = new Set(docs.map((d) => d.path));

    // 批量拉取全部 sections（一次 IN 查询，按 docId 分组后再按 position 排序——
    // 替代逐 doc 单查的 N+1；排序在内存完成，量级为单空间文档总数，安全）
    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .select([
        's.docId',
        's.content',
        's.headingLevel',
        's.headingPath',
        's.headingText',
        's.isContinuation',
      ])
      .where('s.doc_id IN (:...ids)', { ids: docs.map((d) => d.id) })
      .orderBy('s.position', 'ASC')
      .getMany();

    const sectionsByDoc = new Map<string, (typeof sections)[number][]>();
    for (const s of sections) {
      const list = sectionsByDoc.get(s.docId) ?? [];
      list.push(s);
      sectionsByDoc.set(s.docId, list);
    }

    let brokenTotal = 0;
    for (const doc of docs) {
      // Fetch sections ordered by position, reconstruct content with heading lines
      // restored (same inverse-of-chunker logic as getContent) so link extraction
      // matches the upsert-time original-content semantics.
      const docSections = sectionsByDoc.get(doc.id) ?? [];
      const content = this.reconstructContent(doc, docSections, false);
      const linkHealth: LinkHealth = computeLinkHealth(content, doc.path, { paths, docIds });

      brokenTotal += linkHealth.broken.length;

      await this.docRepo
        .createQueryBuilder()
        .update('Doc')
        .set({ linkHealth: linkHealth as unknown as Record<string, unknown> })
        .where('id = :id', { id: doc.id })
        .execute();
    }

    return { checked: docs.length, broken: brokenTotal };
  }

  /**
   * 单文档 linkHealth 手动重检（POST /docs/:id/link-health/recheck，v1.61.0 批次 1）。
   *
   * 使用场景：文档写入后的任意时点手动刷新断链判定（如空间其他文档路径变化、
   * 摄入历史数据后的人工复核）——同步重算 + 落库 + 返回最新 LinkHealth。
   * 候选集 = 空间全部未删 doc（自身经 findById 已在库中，自然含于候选集——
   * 自引用链接按现状有效）。
   *
   * @param docId - 目标文档 ID（不存在/已软删 → 404 DOC_NOT_FOUND，findById 判空）
   * @returns 最新 LinkHealth（落库后的权威值）
   */
  async recheckDocLinkHealth(docId: string): Promise<LinkHealth> {
    // 404 判空（铁律 #22）：不存在/已软删直接抛，不静默透传
    const doc = await this.findById(docId);

    const docs = await this.docRepo
      .createQueryBuilder('d')
      .select(['d.id', 'd.path'])
      .where('d.space_id = :spaceId', { spaceId: doc.spaceId })
      .andWhere('d.deleted_at IS NULL')
      .getMany();

    const docIds = new Set(docs.map((d) => d.id));
    const paths = new Set(docs.map((d) => d.path));

    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .select(['s.content', 's.headingLevel', 's.headingPath', 's.headingText', 's.isContinuation'])
      .where('s.doc_id = :docId', { docId })
      .orderBy('s.position', 'ASC')
      .getMany();

    const content = this.reconstructContent(doc, sections, false);
    const linkHealth: LinkHealth = computeLinkHealth(content, doc.path, { paths, docIds });

    await this.docRepo
      .createQueryBuilder()
      .update('Doc')
      .set({ linkHealth: linkHealth as unknown as Record<string, unknown> })
      .where('id = :id', { id: docId })
      .execute();

    return linkHealth;
  }
}
