/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 正文与纯元数据写入、分节、版本、幂等快照与写侧 hints。
 * [代码职责]
 *   - upsertCore 收口普通正文、PATCH/APPEND 与 diagram 的持久化事务。
 * [权威文档]
 *   - 主文档: 线上 Agent Chamber docs/api-definition.md §16.14/§16.18 — 正文/纯元数据写入及 unchanged 契约。
 *   - 补充: 线上 Agent Chamber docs/architecture.md §3.2.10 — DocSpace 模块与事务边界。
 * [关键不变量]
 *   - 现有正文替换先按 id/spaceId/path/未删除锁父 Doc，再写 sections/versions；
 *     省略字段继承 locked fresh，expectedContentHash/source 在锁后复核。
 *   - core 准备格式与 fresh 在 diagram/non-diagram 间漂移须重读；普通 Markdown
 *     docType 变化继承 fresh。renderer、候选池与链接预读均不得进入持锁事务。
 *   - hashChanged 基于 fresh；late unchanged 不重切/整 save/落版/hints/audit/event，
 *     必要 sourceSha/linkHealth 补列及幂等登记仍使用同一事务连接。
 *   - 内部 PATCH/APPEND 传入的 title/summary 是保留策展值快照，锁后以 fresh 为准；
 *     普通 UPSERT/IMPORT 仍按本次输入派生。事件 title 必须与持久态一致。
 *   - diagram 单节保留 canonical IR，迁出时清图列；forceRechunk 同 hash 不落版本。
 *   - 幂等重放返回首次快照，tags 归一在指纹之后；正文 unchanged 不落 tags/不发 hints，
 *     patchMetadata unchanged 则按 §16.18 返回 hints。
 *   - patchMetadata 两出口的分类视图与幂等快照复用当前事务 manager，持锁时不得另借连接。
 * [关联代码]
 *   - doc.service.spec.ts / test/docspace.e2e-spec.ts — 分支及 HTTP 契约。
 *   - test/docspace-content-consistency.e2e-spec.ts — 独立 PG 持久态/SQL/回滚证据。
 *   - common/services/idempotency.helper.ts — 同事务登记与首次快照回放。
 * [持久踩坑]
 *   - DOC-PARENT-FIRST: 先删 sections 再 UPDATE 父行会让并发写交叉留节；先锁再合并。
 *   - HINT-TX-ZERO-IO: 持锁时用外层仓储会申请第二连接；池/路由预读、事务内纯比对。
 *   - HINT-REQUEST-SCOPE: 比较型 hint 闸门只看请求数据，禁止回退存量 tags；
 *     patchMetadata 另有归一入口，两侧都须核对。词表脏形状须经 parse* 闸门。
 *   - DOC-READ-BYTE-IDENTITY: sectionHash 来自存储三元组；首标题/续节/空节的
 *     markdown 必须与全文匹配面一致，headingPath 只作寻址、标题读 headingText。
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
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { Doc } from '../../database/entities/doc.entity';
// 引用清单类型（MAJOR-2：事务前取回、事务内纯比对）
import type { DocRoute } from '../../database/entities/doc-route.entity';
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
  DocFacetCount,
  // DocSpace 元数据治理 3 期：orphan 诊断面（findOrphans）
  OrphanDocsQuery,
  OrphanDocsResponse,
  OrphanDocItem,
  DocSpaceCanonicalTag,
  DocSpaceHintToggles,
  DocSpacePathType,
  DocHint,
  DocDeleteResult,
  TagNormalization,
  DiagramType,
  DiagramRenderMeta,
  DiagramWriteRenderInfo,
  DiagramDiagnostic,
  UpsertDiagramResult,
  DocListSort,
} from '@agent-chamber/shared';
import { chunkMarkdown, estimateTokens } from './markdown-chunker';
import type { ChunkResult } from './markdown-chunker';
import {
  DOC_CONTENT_CONFLICT_RECOVERY_SUFFIX,
  DOC_IDEMPOTENCY_ENTITY_TYPE,
  DOC_SOURCE_NATIVE,
} from './doc-constants';
// review-0831 任务 bbd175dc 子项 1：slugify 唯一实现（本文件复制品已删，行为统一为
// 带兜底版——中文分类名 slug 从 '' 变为 's-xxxxxxxx'，属预期修复：按 slug 匹配的
// 分类查询对中文名不再必然不命中）
import { slugify } from './doc-slug.helper';
// 空间词表读侧形状解析单源（v1.92.0-dev，code-review F1）：jsonb 脏形状不得抛
// 3 期补 expandTagQueryValues：findAll 的 tag 过滤经空间词表集合展开（alias 兼容）
import {
  expandTagQueryValues,
  parseCanonicalTags,
  parseHintToggles,
  parseStringList,
  parsePathTypes,
} from './doc-vocabulary.helper';
// hint 计算内核（2 期，v1.92.0-dev）：纯函数群 + 优先级/截尾编排；IO 全在本 service
import {
  buildCategoryNearDupHint,
  buildMetadataHints,
  buildPathTypeMismatchHint,
  buildRouteAnchorBrokenHint,
  buildRouteAnchorRecheckHint,
  buildTagNearDupHints,
  buildTagsNormalizedHint,
  DOC_HINT_PROFILE,
  HINT_ROUTE_ANCHOR_CHECK_CAP,
  shouldLoadTagPool,
  type HintCandidate,
  type HintPoolEntry,
} from './doc-hints.helper';
// hint 候选池读取单源（tag 池 / category 池；族闸门内才调用）
import { loadCategoryPool, loadTagPool } from './doc-hint-pools';
// hint 基建（阶段一抽核到 modules/hints/）：去重窗口（@Global 提供的进程单例）、
// 信封接线（emitHints 唯一实现）、埋点面标识
import { HintDedupService } from '../hints/hint-dedup.service';
import { emitHints } from '../hints/hint-emit';
import type { HintSurface } from '../hints/hint-log';
// 凭证粘贴扫描（v1.94.0-dev）：批量通道的**逐条**挂点（batchUpsert 的状态机旁）——
// 单文档 upsert / patch / append 三个挂点在 doc.controller（controller 层是它们的最外入口）
import { emitCredentialScanFactIfHit } from '../hints/credential-scan';
// review-0831 任务 bbd175dc 子项 2：批量 per-item 错误提取唯一实现（batchUpsert
// 内联复制品已删，与 doc-bundle.service 共用同一 { message, code } 契约）；
// F4 项5 追加 batchErrorLogSummary / PER_ITEM_LOG_DETAIL_MAX（per-item 失败的服务端
// 结构化摘要与明细条数上界，三处 catch 共用）
import { batchErrorLogSummary, errorOf, PER_ITEM_LOG_DETAIL_MAX } from './doc-error.helper';
import { computeLinkHealth } from './link-health';
import { computeLineDiff } from './doc-version-diff';
import { RouteHealthService } from './route-health.service';
import { DiagramRendererService, type DiagramRenderArtifacts } from './diagram-renderer.service';
// 类型专用导入（import type，编译期擦除）：避免与 doc-links.service → doc.service 的
// 运行时依赖形成模块环（reconstructContent 的入参放宽，见该方法注释）
import type { SpaceDocCandidate } from './doc-links.service';
import type { UpsertDocDto, BatchUpsertItemDto } from './dto';
import { UnifiedActor } from '../../common/types/actor.types';
// LIKE 字面前缀转义单源（findAll pathPrefix 与 findTree prefix 两处共用；headingQuery 的
// ILIKE 子串转义语义不同，仍就地实现——见 getSectionByHeadingQuery）
import { escapeLikePrefix } from '../../common/utils/sql-like';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { EventService } from '../event/event.service';
// v1.63.0 DocSpace 写族幂等（Board 任务 7d918c7b）：通用实现已上移 common/services
// （幂等 helper 全平台一份；本模块只留身份标记 DOC_IDEMPOTENCY_ENTITY_TYPE）
import {
  buildIdempotencyContext,
  tryIdempotentReplay,
  persistIdempotencyStandalone,
  insertIdempotencyInTx,
  type WriteIdempotencyContext,
} from '../../common/services/idempotency.helper';

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

/**
 * 空间写上下文（2 期，v1.92.0-dev）：一次 settings 读的产物，写路径（upsert /
 * patchMetadata）共用——1 期词表 + 2 期 hint 闸门与 pathTypes。
 *
 * 各键 null 的语义 = 该配置缺省/形状非法（见 doc-vocabulary.helper 的形状闸门）：
 * - `vocabulary === null` → 无 canonicalTags 词表（tag 归一短路）；
 * - `hintToggles === null` → **全关**（消费方一律 `?.<family> === true` 判定）；
 * - `pathTypes === null` → 未声明路径类型（path_type_mismatch 无判定依据）。
 */
export interface DocWriteSpaceContext {
  /** 空间声明的 canonicalTags 词表（null = 未声明） */
  vocabulary: DocSpaceCanonicalTag[] | null;
  /** hint 族开关（null = 全关） */
  hintToggles: DocSpaceHintToggles | null;
  /** 空间声明的 pathTypes（null = 未声明） */
  pathTypes: DocSpacePathType[] | null;
  /** settings 原文（供消费方读其他键，如 overviewFilter；形状未经闸门，消费方自行防御） */
  settings: Record<string, unknown>;
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
    // helper 实现见 common/services/idempotency.helper.ts（DocMoveService 共用同一套）
    @InjectRepository(IdempotencyRecord)
    private readonly idempotencyRepo: Repository<IdempotencyRecord>,
    // Diagram IR v1 渲染门（plan diagram-ir-v1-plan.md §3.2-3.3）：upsertCore diagram
    // 分支在 hashChanged||forceRechunk 时同步调 validateAndRender（fail-closed，
    // 失败即整单拒绝不落库）。markdown 文档路径零开销（仅 effectiveDocType==='diagram'
    // 时触及本依赖）。
    private readonly diagramRenderer: DiagramRendererService,
    // hint 去重窗口（2 期，v1.92.0-dev）：内存 TTL Map 的 Nest provider（A5——不放模块级
    // 单例，测试隔离与 mock 需要）。所有 hint 送达前的过滤/标记都经本依赖。
    private readonly hintDedup: HintDedupService,
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
   *
   * 返回 `{ categoryId, created }`（2 期 A6 修订）：`created=true` 是「本次自动新建了
   * 分类」的信号——category_near_dup hint 的唯一触发条件（只出候选，**不自动合并**，
   * 自动建行为本身不变）。全部调用点必须同步消费该形状。
   *
   * @param spaceId 目标空间 ID
   * @param categoryName 分类名（空/undefined → `{categoryId: null, created: false}`）
   * @returns categoryId（命中或新建）与 created（是否本次新建）
   */
  private async resolveCategory(
    spaceId: string,
    categoryName?: string,
  ): Promise<{ categoryId: string | null; created: boolean }> {
    if (!categoryName) return { categoryId: null, created: false };

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

    if (existing) return { categoryId: existing.id, created: false };

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
    return { categoryId: saved.id, created: true };
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

  /**
   * 读空间**写上下文**（2 期，v1.92.0-dev）：一次 settings 读拿到写路径需要的全部
   * 空间级配置——canonicalTags 词表（1 期归一）、hintToggles 族开关（2 期闸门）、
   * pathTypes 声明（2 期 path_type_mismatch 依据）。
   *
   * 为什么合并成一次读：族开关本身也是 settings 里的键，**不读就无法判定是否要算
   * hint**——把词表读与闸门读合成一次 PK select，避免同请求两次查空间行；batchUpsert
   * 逐 batch 提升本上下文（与 1 期词表提升同款，见 batchUpsert 注释）。
   *
   * 形状解析一律收口于 doc-vocabulary.helper 的 parse* 纯函数（元素级闸门，永不抛——
   * 异形键按「无配置」处理，见该文件 [持久踩坑] VOCAB-SHAPE-1）。
   *
   * @param spaceId 目标空间 ID
   * @returns 三键均已解析的写上下文（各键 null = 该配置缺省/形状非法）
   */
  async getSpaceWriteContext(spaceId: string): Promise<DocWriteSpaceContext> {
    const space = await this.docSpaceRepo.findOne({
      where: { id: spaceId },
      select: ['id', 'settings'],
    });
    const settings = (space?.settings ?? {}) as Record<string, unknown>;
    return {
      vocabulary: parseCanonicalTags(settings.canonicalTags),
      hintToggles: parseHintToggles(settings.hintToggles),
      pathTypes: parsePathTypes(settings.pathTypes),
      settings,
    };
  }

  /**
   * 读分类 slug（2 期：route_target_excluded 的 category 维度判定用）。
   *
   * 只读单列轻查；分类不存在/已软删 → null。
   */
  async findCategorySlug(categoryId: string | null): Promise<string | null> {
    if (!categoryId) return null;
    const cat = await this.categoryRepo
      .createQueryBuilder('dc')
      .select(['dc.id', 'dc.slug'])
      .where('dc.id = :id', { id: categoryId })
      .andWhere('dc.deleted_at IS NULL')
      .getOne();
    return cat?.slug ?? null;
  }

  /**
   * 按空间词表归一 tag 列表（v1.92.0-dev，DocSpace 元数据治理 1 期）。
   *
   * 归一语义（**仅限显式声明的词表**，其余字节不动）：
   * ① 逐 tag 做 trim + 大小写不敏感匹配——先匹配 canonical 值，再匹配各条目 aliases；
   * ② 命中 → 写 canonical 声明形态；未命中 → **原样落库**（不 trim 不改动，重复项也保留）；
   * ③ **仅对命中的归一值**去重（保留首个出现位置），如 `["NPC","npc"]`（canonical=npc）→
   *    `["npc"]`；未命中项不参与去重判定（`["foo","foo"]` → `["foo","foo"]`，忠于
   *    「未命中即原样落库」契约）；
   * ④ 空间未声明 canonicalTags（vocabulary 为 null/空）→ 短路返回原值（零行为变化）。
   *
   * 归一确定性：同一输入恒得同一输出 → 幂等指纹可保持 caller 原始输入不受影响
   * （调用方在幂等 replay 检查**之后**才归一，见 upsert/patchMetadata 注释）。
   *
   * @param tags 调用方原始 tags（undefined = 未携带，原样返回）
   * @param vocabulary 空间声明的 canonicalTags（null/空 = 无词表，短路）
   * @returns tags = 归一后落库值；normalizations = 实际发生的归一映射（仅命中且值变化时记录）
   */
  private resolveTags(
    tags: string[] | undefined,
    vocabulary: DocSpaceCanonicalTag[] | null | undefined,
  ): { tags: string[] | undefined; normalizations: TagNormalization[] } {
    if (!tags || tags.length === 0 || !vocabulary || vocabulary.length === 0) {
      return { tags, normalizations: [] };
    }

    // 建索引：canonical(ci) → 声明形态；alias(ci) → 归属条目（先到先得，与写侧校验口径一致）
    const canonicalByKey = new Map<string, string>();
    const aliasToCanonical = new Map<string, string>();
    for (const entry of vocabulary) {
      const ownKey = entry.value.toLowerCase();
      canonicalByKey.set(ownKey, entry.value);
      for (const alias of entry.aliases ?? []) {
        const key = alias.toLowerCase();
        if (key === ownKey) continue; // 同条目内 alias == 自身 canonical → 等价，跳过
        if (!aliasToCanonical.has(key)) aliasToCanonical.set(key, entry.value);
      }
    }

    const normalizations: TagNormalization[] = [];
    const out: string[] = [];
    const seenNormalized = new Set<string>();
    for (const raw of tags) {
      const key = raw.trim().toLowerCase();
      // 先匹配 canonical 值，再匹配 aliases
      const resolved = canonicalByKey.get(key) ?? aliasToCanonical.get(key) ?? null;
      if (resolved === null) {
        // 未命中 → 原样落库（不 trim / 不去重——含重复项，忠于「原样」契约）
        out.push(raw);
        continue;
      }
      // 命中 → 归一为声明形态；去重**只作用于归一值**（保留首个出现位置）
      if (seenNormalized.has(resolved)) continue;
      seenNormalized.add(resolved);
      if (raw !== resolved) normalizations.push({ from: raw, to: resolved });
      out.push(resolved);
    }
    return { tags: out, normalizations };
  }

  /**
   * 组装 doc 写路径（upsertCore / patchMetadata）的 hint 候选并落信封
   * （2 期，v1.92.0-dev）。
   *
   * 调用点在各自**事务内**（hints 随响应快照进幂等记录，见各处注释）。族闸门
   * （`spaceCtx.hintToggles`）在此收口：未开的族连候选都不构造；**池类与引用清单 IO
   * 全部由调用方在事务前完成**（MAJOR-2：事务内用独立连接查 `doc_routes` 会申请第二条
   * 连接 → **连接饥饿**；机制与池上限的完整说明见 upsertCore 池注释）。
   * **本函数零 IO（结构约束）**：函数体无 `await`、不注入任何仓储——事务内调用它不会
   * 触碰第二条连接。改回 `async` / 加 IO 前先读 upsertCore 池注释。
   *
   * @param params.surface 埋点面标识（upsert / batch_upsert / patch_metadata）
   * @param params.doc 事务内已保存的 doc 实体（**落库后**状态才是判定基准）
   * @param params.headingPaths 本次写入的 headingPath 集合（A4 in-memory chunks）；
   *   **null = 本次不重切 sections**（patchMetadata）→ routes 族整段跳过
   * @param params.routeRefs 事务前取回的**引用本文档的路由清单**（族关 / 本次不评估
   *   routes 时为 null）；比对在本方法内用纯函数完成（零 IO）
   * @param params.tagPool tags 族池（null = 族关/无需池）
   * @param params.precomputedCandidates 事务前算好的候选（category_near_dup）
   * @returns ≤3 条 DocHint；空 → undefined（信封不变量：禁空数组）
   */
  private buildDocWriteHints(params: {
    surface: HintSurface;
    spaceId: string;
    doc: Doc;
    spaceCtx: DocWriteSpaceContext;
    normalizations: TagNormalization[];
    headingPaths: Set<string> | null;
    routeRefs: DocRoute[] | null;
    tagPool: HintPoolEntry[] | null;
    precomputedCandidates: HintCandidate[];
    actorId: string;
  }): DocHint[] | undefined {
    const { spaceId, doc, spaceCtx, normalizations, headingPaths, tagPool, actorId } = params;
    const toggles = spaceCtx.hintToggles;
    const candidates: HintCandidate[] = [...params.precomputedCandidates];

    // tags_normalized（**无族、不去重**）：本请求实际发生归一的事实回显，与
    // tagNormalizations 字段双通道并存。**族关也照发**（它是「动作已发生」的事实，
    // 不是建议）——唯一不挂族闸门的 hint（D1 定形）。
    const normalizedHint = buildTagsNormalizedHint(normalizations, doc.id);
    if (normalizedHint) candidates.push(normalizedHint);

    if (toggles?.metadata === true) {
      candidates.push(
        ...buildMetadataHints(
          { categoryId: doc.categoryId, tags: doc.tags, summary: doc.summary },
          doc.id,
        ),
      );
    }

    if (toggles?.pathType === true) {
      const hint = buildPathTypeMismatchHint(doc.path, doc.docType, spaceCtx.pathTypes, doc.id);
      if (hint) candidates.push(hint);
    }

    // **不变量（批 1，铁律 #18）**：`tagPool` **已加载（非 null）** ⟺ 本请求携带了「词表外
    // ∧ 非实体锚点」tags。注意判据是「非 null」而**不是「非空」**——零文档空间的首篇 upsert
    // 闸门为 true 而池恰为 `[]`（已加载但无内容），这属正常态，不得据此跳过近义判定。
    // 闸门输入 = `resolvedTags`（**请求面**），比较输入 = `doc.tags`（**落库面**）
    // ——两者刻意不同源，**禁止再给闸门加 `?? doc.tags` 回退**（那就是「未携带 tags 时
    // 对存量 tags 跑近义比对」的失效模式）。闸门的锚点预判与 `buildTagNearDupHints` 的
    // 输入过滤共用 `isEntityAnchorTag` 单源（闸门宽 = 白付池聚合；闸门窄 = 静默丢 hint）。
    if (toggles?.tags === true && tagPool) {
      candidates.push(...buildTagNearDupHints(doc.tags, spaceCtx.vocabulary, tagPool, doc.id));
    }

    if (toggles?.routes === true && headingPaths !== null && params.routeRefs !== null) {
      // **纯比对**（零 IO，MAJOR-2）：引用清单已在事务前取回，headingPaths = 本事务刚
      // 插入的同一份 in-memory 数据（A4 的两条硬要求都保持：同源数据 + hints 随快照）
      const { routeCount, brokenRouteIds, anchors } = this.routeHealthService.analyzeRouteAnchors(
        params.routeRefs,
        doc.id,
        headingPaths,
      );
      if (routeCount > HINT_ROUTE_ANCHOR_CHECK_CAP) {
        // 影响面超 cap → 改发 check_skipped（**未检查 ≠ 健康**，plan D4）
        const skipped = buildRouteAnchorRecheckHint([], doc.id, {
          skipped: true,
          total: routeCount,
        });
        if (skipped) candidates.push(skipped);
      } else if (brokenRouteIds.length > 0) {
        const broken = buildRouteAnchorBrokenHint(brokenRouteIds, anchors, doc.id);
        if (broken) candidates.push(broken);
      }
    }

    return this.emitHints(candidates, { surface: params.surface, spaceId, actorId });
  }

  /**
   * hint 落信封（委托 `hint-emit.emitHints` 的唯一接线实现——排序 → 去重过滤 →
   * ≤3 截尾 → 标记 + 埋点；本方法只补 surface/spaceId/actorId 上下文）。
   *
   * @returns ≤3 条 DocHint；无存活候选 → undefined（信封不变量：禁空数组）
   */
  private emitHints(
    candidates: HintCandidate[],
    context: { surface: HintSurface; spaceId: string; actorId: string },
  ): DocHint[] | undefined {
    return emitHints(this.logger, this.hintDedup, candidates, context, {
      profile: DOC_HINT_PROFILE,
    });
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

  /**
   * 纯组装 unchanged 首次响应：共用于事务外快路和锁后的 late unchanged，无 IO。
   * @param doc 当前出口确认的文档快照
   * @returns 新响应对象，diagram 信息仅从该快照派生
   */
  private buildUnchangedResult(doc: Doc): UpsertDiagramResult {
    return {
      id: doc.id,
      path: doc.path,
      sectionCount: doc.sectionCount,
      tokenEstimate: doc.tokenEstimate,
      unchanged: true,
      contentHash: doc.contentHash ?? undefined,
      ...(doc.docType === DOC_TYPE_DIAGRAM
        ? { diagramType: doc.diagramType, render: this.diagramRenderInfoFromMeta(doc.renderMeta) }
        : {}),
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
   * Space-scoped find by ID：`id + space_id + 未软删` 三条件**单条 SQL**定位。
   *
   * 语义（刻意设计，勿"优化"）：
   * - 404 = 文档不存在**或**不属于本空间，二者**不可区分**——异常体与
   *   `findById` 未命中逐字节同文同码（`Document not found` + `DOC_NOT_FOUND`），
   *   调用方与攻击者都拿不到"它存在但你没权限"的信号。
   * - **不变量：禁止改成「先 findById 再比对 doc.spaceId」**。两次行返回 = 可区分
   *   时延差 + 跨空间文档内容进内存，会把 404 变成时延/内容侧信道；本方法存在的
   *   全部意义就是让跨空间与不存在走同一 SQL 形状、单次往返、结果零行同形。
   * - **仅用于 space-scoped 端点**（path 里带 spaceId 的路由，如
   *   `POST /doc-spaces/:id/diagrams/validate` 的 docId 通道）。全局 doc 路由
   *   （`/docs/:id`）继续 `findById` + `doc.spaceId` 反向鉴权——那里按 docId 定位
   *   是产品语义，不是越权面。
   * - **upsert / create-if-missing 流程禁用本方法**：那条路径需要区分"不存在"与
   *   "存在但换空间"，本方法的 404 折叠语义会把它变成静默新建/静默 409。
   *
   * @param spaceId 路径作用域空间（controller 已对该空间做 ensureCan read）
   * @param docId   目标文档 ID
   * @returns 命中且属于该空间的未软删 Doc
   * @throws NotFoundException 404 DOC_NOT_FOUND（不存在/不属本空间/已软删，不可区分）
   */
  async findByIdInSpace(spaceId: string, docId: string): Promise<Doc> {
    const doc = await this.docRepo
      .createQueryBuilder('d')
      .where('d.id = :docId', { docId })
      .andWhere('d.space_id = :spaceId', { spaceId })
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
   * - changed → transaction: lock parent Doc, delete old sections, insert new, update metadata
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
   *   'import'（batchUpsert 批量导入转调）/ 'append'（appendDocOnce 转调）。
   *   PATCH/APPEND 的策展字段来自旧保留快照，锁后继承 fresh；UPSERT/IMPORT 按本次输入。
   *   不进 DTO 校验层——纯 Service 内部传参，controller 直调不传即 'upsert'。
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
    /**
     * 内部参数（v1.92.0-dev，不进 DTO/幂等指纹）：batchUpsert 逐 batch 提升的
     * **空间写上下文**（1 期词表 + 2 期 hint 闸门/pathTypes 三合一，一次 settings 读）
     * ——undefined = 由 upsertCore 自行读取。
     */
    spaceContext?: DocWriteSpaceContext,
    /**
     * 内部参数（2 期 m1，不进 DTO/幂等指纹）：hint 埋点的面标识——batchUpsert 传
     * `'batch_upsert'` 以便日志区分「批量导入的一条」与「单条 upsert」。
     * 缺省 `'upsert'`。
     */
    surface?: HintSurface,
  ): Promise<UpsertDocResult> {
    // 幂等包裹（最外层写入口）：无键零开销旁路；有键先查重放——命中直接返回首次
    // 快照（跳过 unchanged 短路等一切后续逻辑，保证重放响应与首次逐字段一致）。
    // requestHash 只含入口业务字段（versionSource 是内部传参不参与指纹）。
    const ctx = buildIdempotencyContext(DOC_IDEMPOTENCY_ENTITY_TYPE, actor, clientRequestId, {
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
    return this.upsertCore(spaceId, dto, actor, ctx, spaceContext, surface);
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
    ctx?: WriteIdempotencyContext | null,
    /** 内部参数（见 upsert 同名参数注释）：undefined = 自行读取空间写上下文 */
    spaceContext?: DocWriteSpaceContext,
    /** 内部参数（见 upsert 同名参数注释）：hint 埋点面标识，缺省 'upsert' */
    surface?: HintSurface,
  ): Promise<UpsertDocResult> {
    const source = dto.source || DOC_SOURCE_NATIVE;
    // hint 埋点面（m1）：批量导入逐条 → 'batch_upsert'，其余（单条 upsert / patch /
    // append / diagram patch 直调）统一 'upsert'
    const hintSurface: HintSurface = surface ?? 'upsert';
    // hint 去重窗口的 actor 维度（未认证写归 'system'，与 audit/version 的 actor 兜底同源）
    const hintActorId = actor?.id ?? 'system';

    // ── 空间写上下文（2 期，v1.92.0-dev）───────────────────────────────────
    // 一次 settings 读拿到：canonicalTags 词表（1 期归一）+ hintToggles 族开关
    // （2 期闸门）+ pathTypes（path_type_mismatch 依据）。**族开关本身也是 settings
    // 键——不读无法判定是否要算 hint**，故本读不是「族开才有」的额外 IO，而是闸门
    // 本身的读；batchUpsert 逐 batch 提升经 spaceContext 透传（不重复查）。
    // ⚠️ unchanged 早退（下方）发生在 tags 落库之前——tags 属「内容键」语义，
    // 内容未变则 tags 不落库也不归一（A2，非回归）；纯标签调整走 patch_doc_metadata。
    const spaceCtx: DocWriteSpaceContext =
      spaceContext ?? (await this.getSpaceWriteContext(spaceId));
    const { tags: resolvedTags, normalizations } = this.resolveTags(dto.tags, spaceCtx.vocabulary);
    // 归一映射仅在成功出口挂载（unchanged/23505 败者出口零归一）
    const normalizationPatch =
      normalizations.length > 0 ? { tagNormalizations: normalizations } : {};

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
            `(expected ${dto.expectedContentHash}, current ${existing.contentHash}); re-read the document and retry` +
            DOC_CONTENT_CONFLICT_RECOVERY_SUFFIX,
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
        const unchangedResult = this.buildUnchangedResult(existing);
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
          `re-read the document and retry` +
          DOC_CONTENT_CONFLICT_RECOVERY_SUFFIX,
        code: ErrorCode.DOC_CONTENT_CONFLICT,
        data: { currentContentHash: null },
      });
    }

    // Track whether this is a create (for created flag in result)
    const isCreate = !existing;

    // 事务前值仅用于渲染准备；现有文档锁后重新计算，版本/响应/事件共用 fresh 判定。
    // forceRechunk 时 hash 可能相同（内容未变但强制重建），版本契约 = 「contentHash
    // 变化才落版」——hash 未变的重切**不写** doc_versions 版本行（见事务内守卫）。
    let hashChanged = existing ? existing.contentHash !== computedHash : true;

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
    // resolveCategory 返回 { categoryId, created }（2 期 A6）：created=true 是
    // category_near_dup 的唯一触发信号；**自动建行为本身不变**（合法性不变原则）。
    const resolvedCategory = await this.resolveCategory(spaceId, dto.category);
    const categoryId = resolvedCategory.categoryId;

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

    // ── hint 候选池与锚集合（2 期，v1.92.0-dev；全部族闸门内）────────────────
    // ⚠️ **池读与引用清单读全部放在事务之前**：事务内用独立连接（`this.xxxRepo` 而非
    // 事务 manager）查任何东西都要**申请第二条连接**——pg 池 max=10 且无获取超时，
    // ≥10 并发写即整库挂起（**连接饥饿**，不是「自死锁」：READ COMMITTED 下普通 SELECT
    // 不会被 FOR UPDATE 阻塞，但连接的**获取**本身会排队）。事务内只允许零 IO 的纯比对
    // （见 buildDocWriteHints）。
    // 事务前读还带来一个语义好处：池反映**写入前**的空间取值，本文档刚写入的 tag
    // 不会成为自己的近义候选（否则会出现「你的 tag 与你的 tag 相似」的纯噪音）。
    // 闸门（批 1 收口为共享单源 shouldLoadTagPool）：族关 / 请求未携带 tags / 全部
    // tag 已命中词表 / 其余皆为实体锚点 → 零查询。**传入的必须是请求面 resolvedTags**
    // （写语义），不是落库面 doc.tags——后者会让「请求未携带 tags」也去查池（本批
    // 修掉的失效模式，见 patchMetadata 同款闸门）。
    // **本通道的行为变更（批 1 明写）**：旧条件只查「存在词表外 tag」，故「请求 tags
    // 全为实体锚点」时仍会白付一次全空间 `unnest(docs.tags)` 聚合，而 buildTagNearDupHints
    // 必然过滤掉它们 ⇒ 输出**等价**（本就该零产出），只是少一次池查询。既有 upsert
    // 语料（npc / openviking / openvikings / x / t1）全不命中锚点模式，无回归。
    const hintToggles = spaceCtx.hintToggles;
    let tagPool: HintPoolEntry[] | null = null;
    if (shouldLoadTagPool(resolvedTags, hintToggles, spaceCtx.vocabulary)) {
      tagPool = await loadTagPool(this.docRepo, spaceId);
    }
    // category 池：仅在「本次自动新建了分类」时才有意义（排除刚建的那条，不进自己的池）
    let categoryNearDupCandidate: HintCandidate | null = null;
    if (
      hintToggles?.categories === true &&
      resolvedCategory.created &&
      categoryId &&
      dto.category
    ) {
      const pool = await loadCategoryPool(this.categoryRepo, spaceId, categoryId);
      categoryNearDupCandidate = buildCategoryNearDupHint(dto.category, pool, categoryId);
    }
    // 事务内 in-memory chunks 的 headingPath 集合（A4：锚校验对象 = 本事务刚插入的
    // 同一份数据，零额外查询且与幂等快照同事务——绝不可改查已提交的 sections）
    const chunkHeadingPaths = new Set<string>();
    for (const chunk of chunks) {
      if (chunk.headingPath !== null) chunkHeadingPaths.add(chunk.headingPath);
    }
    // 引用本文档的路由清单：**事务前读**（MAJOR-2）——事务内用独立连接查 doc_routes 会
    // 申请第二条连接（pg 池 max=10 无获取超时 → ≥10 并发写整库挂起）；比对留在事务内
    // 用纯函数做（RouteHealthService.analyzeRouteAnchors，零 IO）。routes 不被本事务写
    // ⇒ 读一致性不受影响。新建文档不可能被任何路由引用 → 零查询短路。
    let routeRefs: DocRoute[] | null = null;
    if (hintToggles?.routes === true) {
      routeRefs = existing
        ? await this.routeHealthService.routesReferencingDoc(spaceId, existing.id)
        : [];
    }
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
          // 父行是正文/sections/versions 的串行化入口；完整定位防移动/删除后回写旧快照。
          // 这是现有文档分支的首项事务 DB 操作，无 hash 调用也必须在删节前持锁。
          const target = await docRepo
            .createQueryBuilder('d')
            .setLock('pessimistic_write')
            .where('d.id = :id', { id: existing.id })
            .andWhere('d.space_id = :spaceId', { spaceId })
            .andWhere('d.path = :path', { path: dto.path })
            .andWhere('d.deleted_at IS NULL')
            .getOne();

          if (
            !target ||
            (dto.expectedContentHash !== undefined &&
              target.contentHash !== dto.expectedContentHash)
          ) {
            throw new ConflictException({
              message:
                `Document changed, moved or was deleted (in-transaction recheck); re-read the document and retry` +
                DOC_CONTENT_CONFLICT_RECOVERY_SUFFIX,
              code: ErrorCode.DOC_CONTENT_CONFLICT,
              data: { currentContentHash: target?.contentHash ?? null },
            });
          }
          if (target.source !== source) {
            throw new ConflictException({
              message: `Document source '${target.source}' does not match request source '${source}'`,
              code: ErrorCode.DOC_SOURCE_MISMATCH,
            });
          }
          // 准备阶段的解析/渲染策略只受 diagram 分界影响；普通 Markdown 类型漂移可继承。
          if (
            dto.docType === undefined &&
            (effectiveDocType === DOC_TYPE_DIAGRAM) !== (target.docType === DOC_TYPE_DIAGRAM)
          ) {
            throw new ConflictException({
              message:
                `Document format changed during content preparation; re-read the document and retry` +
                DOC_CONTENT_CONFLICT_RECOVERY_SUFFIX,
              code: ErrorCode.DOC_CONTENT_CONFLICT,
              data: { currentContentHash: target.contentHash },
            });
          }
          hashChanged = target.contentHash !== computedHash;
          if (!hashChanged && !dto.forceRechunk) {
            // 另一写入已提交同正文：只补必要验证列，禁止整 save 覆盖 fresh 的策展元数据。
            const backfill: Partial<Doc> = {};
            if (!target.linkHealth) {
              backfill.linkHealth = linkHealth as unknown as Record<string, unknown>;
            }
            if (dto.sourceSha !== undefined && target.sourceSha !== dto.sourceSha) {
              backfill.sourceSha = dto.sourceSha;
            }
            if (Object.keys(backfill).length > 0) {
              await docRepo
                .createQueryBuilder()
                .update('Doc')
                .set(backfill)
                .where('id = :id', { id: target.id })
                .execute();
            }
            const unchanged = this.buildUnchangedResult(target);
            if (ctx) await insertIdempotencyInTx(manager, ctx, target.id, unchanged);
            return { doc: target, assembled: unchanged };
          }

          // Delete old sections (CASCADE handles FK, but we delete explicitly for clarity)
          await sectionRepo
            .createQueryBuilder()
            .delete()
            .where('doc_id = :docId', { docId: target.id })
            .execute();

          // Update metadata
          // PATCH/APPEND（含 diagram patch）的 title/summary 是 wrapper 旧策展快照，
          // 其内部来源表达“保留”意图；UPSERT/IMPORT 则表达本次输入/正文派生意图。
          const preserveCuration =
            dto.versionSource === DOC_VERSION_SOURCE.PATCH ||
            dto.versionSource === DOC_VERSION_SOURCE.APPEND;
          target.title = preserveCuration ? target.title : autoTitle;
          target.summary = preserveCuration ? target.summary : summary;
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
          target.tags = resolvedTags ?? target.tags;
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
            tags: resolvedTags ?? [],
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
        // rechunked 使用锁后、改写实体前重算的 hashChanged。
        // Diagram IR v1：diagram 写携带 diagramType + render（本次渲染产物元数据）——
        // upsert_diagram/patch_diagram 响应形状的权威来源（含幂等重放快照）
        //
        // 2 期 hints：**同样在事务内组装**（随 assembled 进幂等快照）——挪到事务后会
        // 让重放响应丢失 hints，且 route_anchor_broken 会改查已提交的 sections
        // （与本次写入不同源）。锚校验数据源 = 事务前算好的 in-memory chunks 集合（A4）
        // + 事务前取回的路由引用清单（MAJOR-2：事务内零 IO）。
        const hints = this.buildDocWriteHints({
          surface: hintSurface,
          spaceId,
          doc,
          spaceCtx,
          normalizations,
          headingPaths: chunkHeadingPaths,
          routeRefs,
          tagPool,
          precomputedCandidates: categoryNearDupCandidate ? [categoryNearDupCandidate] : [],
          actorId: hintActorId,
        });
        const assembled: UpsertDiagramResult = {
          id: doc.id,
          path: doc.path,
          sectionCount: doc.sectionCount,
          tokenEstimate: doc.tokenEstimate,
          created: isCreate,
          contentHash: doc.contentHash ?? undefined,
          rechunked: !hashChanged && dto.forceRechunk ? true : undefined,
          // tag 归一映射（v1.92.0-dev）：仅实际发生归一时出现；与幂等快照同引用
          ...normalizationPatch,
          ...(hints ? { hints } : {}),
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

      // late unchanged 的响应与幂等快照已在锁内完成；此处早退隔断所有更新观测副作用。
      if (assembled.unchanged) return assembled;

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
          payload: { spaceId, docId: result.id, path: result.path, title: result.title },
        });
      } else {
        // 两种 unchanged 出口均已早退。禁止用事务外 existing 重新判断内容变化：
        // 它是旧读快照；版本/响应/事件必须共用锁后、改写 target 前捕获的 hashChanged。
        // 债 B（决策 #9）：forceRechunk 且 hash 未变的纯重切也走此分支——payload
        // 携带 rechunked:true 上下文，订阅方可区分「内容变更」与「元数据纯重切」。
        // wasRechunk 与版本守卫共用锁后重算的 hashChanged，禁止再读已改写实体。
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
            title: result.title,
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
          // **并发败者标记**（v1.94.0-dev）：本请求写入的 content 未落库——返回的数据
          // 全来自胜者那一行。领域侧据此跳过「未写入却 emit」的观测面（`doc.upserted`
          // 事实 + 凭证扫描，见 doc.controller 的挂点门控），与 unchanged / rechunked /
          // idempotentReplay 同一族。**缺了这个标记**会让本请求未写入的正文被扫描、并把
          // 告警/hint 的 resourceId 指向胜者的 docId（评审 P2-1，真 bug）。
          concurrentWinner: true,
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

    // 空间写上下文逐 batch 一次读取（2 期 v1.92.0-dev；1 期词表提升的推广）：经内部
    // 参数透传逐条 upsert，避免 N 次重复查询空间 settings。上下文含 canonicalTags 词表
    // + hintToggles 族开关 + pathTypes 三键——族开关本身也在 settings 里，**必须读**
    // 才能判定是否要算 hint，故本读无条件（每 batch 一次，不是每文档一次）。
    const spaceContext = await this.getSpaceWriteContext(spaceId);

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
          spaceContext,
          // m1：批量通道的埋点面标识（日志可区分「导入的一条」与「单条 upsert」）
          'batch_upsert',
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

        // 凭证扫描（v1.94.0-dev）：**逐条**扫本 item 写入的正文——与单文档 upsert 同门控：
        // 跳过 unchanged（内容未变）、幂等 replay 与 **23505 并发败者**（三者都没发生真实
        // 写入；败者的 r.id 是胜者 docId，扫本 item 的正文会把告警指到别人的文档上）；
        // failed 走下方 catch 分支（根本没有 r），天然不扫。见 credential-scan.ts 的 [关键不变量]。
        if (status !== 'unchanged' && !r.idempotentReplay && !r.concurrentWinner) {
          emitCredentialScanFactIfHit(upsertItem.content, {
            resourceKind: 'doc',
            resourceId: r.id,
            actorId: actor?.id ?? null,
          });
        }

        results.push({
          path: dto.path,
          status,
          id: r.id,
          // tag 归一映射（v1.92.0-dev）：仅该条实际发生归一时出现（含幂等重放快照原样）
          ...(r.tagNormalizations ? { tagNormalizations: r.tagNormalizations } : {}),
          // hint 信封（2 期）：逐条结果提升，仅该条命中时出现（含幂等重放快照原样）
          ...(r.hints ? { hints: r.hints } : {}),
        });
      } catch (err: unknown) {
        summary.failed++;
        // 错误形状统一走 doc-error.helper.errorOf（review-0831 任务 bbd175dc 子项 2，
        // 与 doc-bundle.service 共用同一 { message, code } 契约）
        // F4 项5 第 6 条：只记结构化摘要——构造名 + sqlstate + 消毒后文案 + 本条 path，
        // 不记 stack、不记错误原文（原文含用户输入回显，批量场景会被按条重放）；
        // 条数上界（复审 MAJOR-2）与 doc-bundle 两侧同口径——本端点 DTO 有
        // @ArrayMaxSize(50) 兜着，统一口径是为了「新加批量端点照抄即可」
        if (summary.failed <= PER_ITEM_LOG_DETAIL_MAX) {
          this.logger.warn(
            `batchUpsert per-item failed: ${batchErrorLogSummary(err, `path=${dto.path}`)}`,
          );
        }
        results.push({
          path: dto.path,
          status: 'failed',
          error: errorOf(err),
        });
      }
    }

    if (summary.failed > PER_ITEM_LOG_DETAIL_MAX) {
      this.logger.warn(
        `batchUpsert per-item failures truncated: total=${summary.failed} ` +
          `(detail logged for the first ${PER_ITEM_LOG_DETAIL_MAX})`,
      );
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
   * path (exact), pathPrefix (prefix match, v1.55), updatedAfter (metadata-level lower bound,
   * v1.89.0-dev) and sort (path ASC default | updatedAt_desc | updatedAt_asc).
   * path= and q= are mutually exclusive; path= and pathPrefix= are mutually exclusive
   * (both target the path column and exact match subsumes prefix).
   *
   * ⚠️ updatedAfter 的能力边界（契约，消费方别误用）：**只筛元数据** `docs.updated_at`
   * ——无内容级增量；**删除不可见**（硬过滤 deleted_at IS NULL，软删不 bump 时间列）；
   * 且 `updated_at` 由两个时钟源写入（save() 路径 = 应用时钟 `new Date()`，元数据 patch /
   * move = DB 时钟 `NOW()`），增量水位必须回看重叠窗口（详见 QueryDocDto 类头注释）。
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
      updatedAfter?: string;
      sort?: DocListSort;
    },
    /**
     * 空间 settings（v1.92.0-dev 3 期，plan D3/A1）：仅用于 tag 过滤的**词表 alias
     * 集合展开**。controller 权限校验时已持有 space，透传零额外查询；不传 = 不展开
     * （内部调用方零影响，行为逐字节不变）。
     */
    settings?: unknown,
  ): Promise<PaginatedResponse<DocSummary>> {
    const {
      category,
      tag,
      type,
      q,
      path,
      pathPrefix,
      page = 1,
      pageSize = 20,
      updatedAfter,
      sort,
    } = query;

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
    // 用户输入中的 \ % _ 逐字符转义（ESCAPE '\'），不会被当作 LIKE 元字符解释。
    // 转义实现单源 = common/utils/sql-like.ts escapeLikePrefix（与 findTree/exportBundle 共用）
    if (pathPrefix) {
      const escaped = escapeLikePrefix(pathPrefix);
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

    // Tag filter（数组重叠；v1.92.0-dev 3 期 plan D3/A1：先经空间词表集合展开，
    // 使 rename 前写入的存量旧值在 canonical/alias 任一形态查询下都被召回。
    // 未命中词表 / 未传 settings ⇒ 单元素 ⇒ 与旧 `:tag = ANY(d.tags)` 逐字节等价）
    if (tag) {
      const tagValues = expandTagQueryValues(
        parseCanonicalTags((settings as Record<string, unknown> | null | undefined)?.canonicalTags),
        tag,
      );
      qb.andWhere('d.tags && CAST(:tagValues AS text[])', { tagValues });
    }

    // Type filter
    if (type) {
      qb.andWhere('d.doc_type = :docType', { docType: type });
    }

    // updatedAfter（v1.89.0-dev）：元数据级下界，**含边界**（>=）。无上界参数（本版无
    // updatedBefore）——增量消费靠水位回看，见方法注释的三盲区。
    if (updatedAfter) {
      qb.andWhere('d.updated_at >= :updatedAfter', { updatedAfter });
    }

    // 排序：缺省保持 path ASC（逐字节沿用既有行为）；显式 sort 时按 updatedAt，
    // **次键恒为 path ASC**——path 是 upsert 业务键、应用层唯一 ⇒ 全序（批量 upsert
    // 同 updated_at 常见，缺次键会让分页结果在页间抖动/重复）
    //
    // ⚠️ orderBy 必须写**实体属性路径**（d.updatedAt），不能写数据库列名（d.updated_at）：
    // skip/take 分页触发 createOrderByCombinedWithSelectExpression，按属性名查实体元数据，
    // 列名解析不到 → undefined.databaseName 抛 TypeError 500（v1.89.0 生产实踩；mock 单测
    // 测不出真 ORM 行为，该路径由 docspace-bundle e2e 真 PG 用例守门）。andWhere 不受此限
    // （裸 SQL 片段，列名/属性名都能过）。
    if (sort) {
      qb.orderBy('d.updatedAt', sort === 'updatedAt_desc' ? 'DESC' : 'ASC').addOrderBy(
        'd.path',
        'ASC',
      );
    } else {
      qb.orderBy('d.path', 'ASC');
    }

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

    // LIKE 通配符转义（单源 = common/utils/sql-like.ts escapeLikePrefix）：\ % _ 逐字符
    // 转义，保证字面前缀语义
    const escapedPrefix = escapeLikePrefix(normalizedPrefix);

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
    // 目录排序：recent = 最近更新 DESC、段名 ASC（同时间稳定分页）；name = 段名 ASC
    if (sort === 'name') {
      folderQb.orderBy('name', 'ASC');
    } else {
      folderQb.orderBy('MAX(d.updated_at)', 'DESC').addOrderBy('name', 'ASC');
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
   * @param settings 空间 settings（v1.92.0-dev；controller 已持有 space，透传免二次查询）。
   *   携带词表时逐项标 vocabStatus（types: declared/undeclared；tags: canonical/alias/
   *   undeclared + canonicalValue）并回显 vocabulary；未配置该族词表则整字段省略。
   * @returns DocFacetsResponse（types/tags/categories 三组聚合计数 + 词表状态/回显）
   */
  async findFacets(
    spaceId: string,
    settings?: Record<string, unknown> | null,
  ): Promise<DocFacetsResponse> {
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

    // ── 词表状态与回显（v1.92.0-dev，DocSpace 元数据治理 1 期）──────────────
    // 三键统一过 doc-vocabulary.helper 的形状解析器（元素级闸门，永不抛——jsonb 可被
    // 直改库 / bundle 回导写脏，见该文件 VOCAB-SHAPE-1）；null = 该族无有效词表 →
    // 逐项 vocabStatus 整字段省略（区分「没配词表」与「词表外」）。
    const declaredDocTypes = parseStringList(settings?.docTypes);
    const declaredCanonicalTags = parseCanonicalTags(settings?.canonicalTags);
    const declaredPathTypes = parsePathTypes(settings?.pathTypes);
    // hint 族开关现状（2 期 P1）：与三词表键并列回显——一词调用 = 词表 + 开关 + 分布
    const declaredHintToggles = parseHintToggles(settings?.hintToggles);

    // 索引（大小写不敏感；CJK 无大小写不受影响）
    const docTypeKeys = declaredDocTypes
      ? new Set(declaredDocTypes.map((t) => t.toLowerCase()))
      : null;
    const canonicalExact = declaredCanonicalTags
      ? new Set(declaredCanonicalTags.map((e) => e.value))
      : null;
    // ci 索引：alias(ci) 与 canonical(ci) → 声明 canonical 形态。stored 值不等于声明
    // 形态（含大小写变体）时归为 alias，并给出 canonicalValue 指向声明值（喂 3 期 rename/merge）。
    const aliasToCanonical = new Map<string, string>();
    if (declaredCanonicalTags) {
      for (const entry of declaredCanonicalTags) {
        const ownKey = entry.value.toLowerCase();
        if (!aliasToCanonical.has(ownKey)) aliasToCanonical.set(ownKey, entry.value);
        for (const alias of entry.aliases ?? []) {
          const key = alias.toLowerCase();
          if (!aliasToCanonical.has(key)) aliasToCanonical.set(key, entry.value);
        }
      }
    }

    const types: DocFacetCount[] = typeRows.map((r) => {
      const item: DocFacetCount = { value: r.value, count: Number(r.count) };
      if (docTypeKeys) {
        item.vocabStatus = docTypeKeys.has(String(r.value).toLowerCase())
          ? 'declared'
          : 'undeclared';
      }
      return item;
    });

    const tags: DocFacetCount[] = tagRows.map((r) => {
      const item: DocFacetCount = { value: r.value, count: Number(r.count) };
      if (canonicalExact) {
        if (canonicalExact.has(String(r.value))) {
          // stored 值 === 声明 canonical 形态（精确，区分大小写）→ canonical
          item.vocabStatus = 'canonical';
        } else {
          // 非声明形态但 ci 命中 alias 或 canonical（大小写变体）→ alias + 指向声明值
          const canonicalValue = aliasToCanonical.get(String(r.value).toLowerCase());
          if (canonicalValue !== undefined) {
            item.vocabStatus = 'alias';
            item.canonicalValue = canonicalValue;
          } else {
            item.vocabStatus = 'undeclared';
          }
        }
      }
      return item;
    });

    const response: DocFacetsResponse = {
      types,
      tags,
      categories: catRows.map((r) => ({ slug: r.slug, name: r.name, count: Number(r.count) })),
    };
    // vocabulary 回显：四键全未声明时省略（与逐项状态省略口径一致）；只回显词表与
    // hint 开关，内部键（repoManifest 等）不外泄。
    if (declaredDocTypes || declaredCanonicalTags || declaredPathTypes || declaredHintToggles) {
      response.vocabulary = {
        docTypes: declaredDocTypes ?? null,
        canonicalTags: declaredCanonicalTags ?? null,
        pathTypes: declaredPathTypes ?? null,
        hintToggles: declaredHintToggles,
      };
    }
    return response;
  }

  /**
   * orphan 文档清单（GET /doc-spaces/:id/docs/orphans，v1.92.0-dev DocSpace 元数据治理 3 期）。
   *
   * 语义（plan D10）：`deleted_at IS NULL` 且 id ∉ routes(primary ∪ secondary) 的文档。
   * **「route 指向已删 doc」是断链面**（RouteHealthService），不算 orphan——两个维度不混。
   * 「叶子文档无路由 ≠ 错误」（Hument 边界）：本面是**诊断清单**，不是缺陷判定。
   *
   * 口径与实现：
   * - route 引用集 + 文档集两次查询后在内存做差集（plan F9 仓内惯例，500+300 量级无压力）；
   * - 默认应用 `settings.overviewFilter` 的 excludeTypes/excludeCategories（与 overview 的
   *   「导航面」语义同源——日记/归档本就不该上 routes，默认不淹清单）；`includeExcluded=true`
   *   关闭；响应回显 appliedFilters；
   * - `stats.byTopDir` 按 path 第一段分组（无 `/` 的顶层文件归 `(root)`），维护者一眼分辨
   *   「结构性叶子群」vs「可行动孤儿」；分组基于**过滤后**清单（调用方可见的那一份）；
   * - `pathPrefix` 过滤复用 `escapeLikePrefix` 单源（字面前缀语义）；分页 page/pageSize(max 100)。
   *
   * 纯读现算，不落库、无调度——「周期性产出」= 维护者按需调用（plan D10 边界）。
   *
   * @param spaceId 目标空间 ID
   * @param settings 空间 settings（controller 已持有 space，透传免二次查询）
   * @param query { page?, pageSize?, includeExcluded?, pathPrefix? }
   * @returns OrphanDocsResponse（items + total + appliedFilters + stats）
   */
  async findOrphans(
    spaceId: string,
    settings: Record<string, unknown> | null | undefined,
    query: OrphanDocsQuery,
  ): Promise<OrphanDocsResponse> {
    const { page = 1, pageSize = 20, includeExcluded = false, pathPrefix } = query;
    const effectivePage = Math.max(page, 1);
    // 分页硬上限 100（DTO 已拦，Service 直调兜底——对齐 findAll 惯例）
    const effectivePageSize = Math.min(Math.max(pageSize, 1), 100);

    // ① route 引用集（primary ∪ secondary；裸 uuid 无 FK——doc 软删后路由行仍保留）
    const routeRows: Array<{ primary_doc_id: string; secondary_doc_id: string | null }> =
      await this.docRepo.manager.query(
        `SELECT primary_doc_id, secondary_doc_id FROM doc_routes WHERE space_id = $1`,
        [spaceId],
      );
    const routedIds = new Set<string>();
    for (const row of routeRows) {
      routedIds.add(row.primary_doc_id);
      if (row.secondary_doc_id) routedIds.add(row.secondary_doc_id);
    }

    // ② 空间内未软删文档（含分类 slug；分类软删后 slug 视同无分类——照抄 findAll join 条件）
    const params: unknown[] = [spaceId];
    let pathClause = '';
    if (pathPrefix) {
      params.push(`${escapeLikePrefix(pathPrefix)}%`);
      // 转义单源 = common/utils/sql-like.ts escapeLikePrefix（字面前缀语义）
      pathClause = ` AND d.path LIKE $${params.length} ESCAPE '\\'`;
    }
    const docs: Array<{
      id: string;
      path: string;
      title: string;
      docType: string | null;
      categorySlug: string | null;
      updatedAt: Date | string;
    }> = await this.docRepo.manager.query(
      `SELECT d.id, d.path, d.title, d.doc_type AS "docType", dc.slug AS "categorySlug",
              d.updated_at AS "updatedAt"
         FROM docs d
         LEFT JOIN doc_categories dc ON dc.id = d.category_id AND dc.deleted_at IS NULL
        WHERE d.space_id = $1 AND d.deleted_at IS NULL${pathClause}
        ORDER BY d.path ASC`,
      params,
    );

    const routedDocs = docs.filter((doc) => routedIds.has(doc.id)).length;
    const orphans = docs.filter((doc) => !routedIds.has(doc.id));

    // ③ overviewFilter 默认排除（脏数据防御：非数组 → 无默认过滤，对齐 B4 先例）
    const overviewFilter = settings?.overviewFilter as
      | { excludeTypes?: unknown; excludeCategories?: unknown }
      | undefined;
    const excludeTypes = includeExcluded ? null : parseStringList(overviewFilter?.excludeTypes);
    const excludeCategories = includeExcluded
      ? null
      : parseStringList(overviewFilter?.excludeCategories);
    const visible = orphans.filter((doc) => {
      if (excludeTypes && doc.docType !== null && excludeTypes.includes(doc.docType)) return false;
      if (
        excludeCategories &&
        doc.categorySlug !== null &&
        excludeCategories.includes(doc.categorySlug)
      ) {
        return false;
      }
      return true;
    });
    const excludedOrphanDocs = orphans.length - visible.length;

    // ④ byTopDir：path 第一段分组（无 `/` 的顶层文件归 `(root)`）；count DESC + dir ASC
    const dirCounts = new Map<string, number>();
    for (const doc of visible) {
      const slash = doc.path.indexOf('/');
      const dir = slash >= 0 ? doc.path.slice(0, slash) : '(root)';
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    const byTopDir = [...dirCounts.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => b.count - a.count || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

    // ⑤ 分页（过滤后清单；path ASC 全序 ⇒ 页间稳定）
    const total = visible.length;
    const start = (effectivePage - 1) * effectivePageSize;
    const items: OrphanDocItem[] = visible.slice(start, start + effectivePageSize).map((doc) => ({
      id: doc.id,
      path: doc.path,
      title: doc.title,
      docType: doc.docType ?? null,
      categorySlug: doc.categorySlug ?? null,
      updatedAt: new Date(doc.updatedAt).toISOString(),
    }));

    // ⑥ appliedFilters 回显（只回显实际生效的维度）
    const appliedFilters: OrphanDocsResponse['appliedFilters'] = {};
    if (excludeTypes) appliedFilters.excludeTypes = excludeTypes;
    if (excludeCategories) appliedFilters.excludeCategories = excludeCategories;
    if (pathPrefix) appliedFilters.pathPrefix = pathPrefix;
    if (includeExcluded) appliedFilters.includeExcluded = true;

    return {
      items,
      total,
      page: effectivePage,
      pageSize: effectivePageSize,
      appliedFilters,
      stats: {
        totalDocs: docs.length,
        routedDocs,
        orphanDocs: orphans.length,
        excludedOrphanDocs,
        byTopDir,
      },
    };
  }
  /**
   * Get document detail: metadata + section outline (sectionHash 派生，正文不进响应)。
   * QB select 含 content 列**仅为派生 sectionHash**（见下），不进响应体。
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
   * outline 的 sectionHash（v1.93.0 批 2，任务 59cb21e6）：与 DocSectionContent /
   * DocSectionItem 同口径（computeSectionHash，输入 = 存储三元组），为复核/对账场景
   * 提供「一次 outline 调用完成全篇比对」的能力；写前提校验（patch expectedSectionHash）
   * 的取数通道仍是 positions[] / 单节读——口径相同可混用。
   *
   * @param maxFullTokens 覆盖阈值（≥0；0 = 强制 outline；非法值由 controller 双层校验拦截，不达此层）
   */
  async findOne(id: string, maxFullTokens?: number): Promise<DocDetail> {
    const doc = await this.findById(id);

    // 用 getMany 走实体 hydration 取大纲字段，规避 getRawMany 的 raw-key 命名陷阱
    // （该版本下 select 用 DB 列名或属性名都映射不到 headingPath，导致 outline 全空）。
    // hydration 按属性名填充，未选字段为 undefined。
    //
    // v1.93.0 批 2：额外 select content —— **只为在 Node 侧派生 sectionHash**（哈希输入
    // 是存储三元组，没有 content 算不出来）。派生后 content 即随 map 丢弃、不进响应体。
    // 代价：本查询每次 outline 调用都会把整篇正文搬进进程内存（最坏即一次全量正文读，
    // 与 full 分支同量级），响应体则**不因正文膨胀**——每节只多一个哈希字段（≈85B）。
    // 若日后 outline 成为热路径，再评估物化 hash 列——当前 YAGNI，PG 侧 digest 会造成
    // 「口径双实现」漂移（明确否决）。
    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .select([
        's.position',
        's.headingPath',
        's.headingText',
        's.headingLevel',
        's.tokenEstimate',
        's.content',
      ])
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
      // 与 positions[] / getSection / headingQuery 同口径（computeSectionHash 单源）
      sectionHash: this.computeSectionHash(s),
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
      // full 分支独立第二次查询（全量 sections 列）——**不复用**上面那次 outline 查询：
      // outline 投影即便 select 了 content，也缺 reconstructContent / renderSectionPart
      // 依赖的 isContinuation（run-dedup 判据）等列，复用得先把 outline 查询拖回全列，
      // 反而不如两次窄查询清晰（且 outline 分支的响应面无额外开销，代价只在多取一列）。
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
    // 签名放宽（v1.90.0-dev backlinks 批次）：本方法**只读 doc.title**（下方
    // renderSectionPart 的 docTitle 实参），故接纳入链内核的窄候选类型
    // SpaceDocCandidate——调用方无需把候选集 `as Doc` 强转（plan ADR 明令禁止）。
    doc: Doc | SpaceDocCandidate,
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
    const ctx = buildIdempotencyContext(DOC_IDEMPOTENCY_ENTITY_TYPE, actor, clientRequestId, {
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
            `(current sectionCount=${sections.length})` +
            DOC_CONTENT_CONFLICT_RECOVERY_SUFFIX,
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
    const ctx = buildIdempotencyContext(DOC_IDEMPOTENCY_ENTITY_TYPE, actor, clientRequestId, {
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
          `re-read the full content (GET /docs/:id/content?full=true or read_doc) and retry; ` +
          `matching is byte-exact including leading whitespace/indentation — copy oldString ` +
          `verbatim from read_doc / full=true output instead of hand-typing it`,
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
    const ctx = buildIdempotencyContext(DOC_IDEMPOTENCY_ENTITY_TYPE, actor, clientRequestId, {
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
    ctx: WriteIdempotencyContext | null,
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
    const ctx = buildIdempotencyContext(DOC_IDEMPOTENCY_ENTITY_TYPE, actor, clientRequestId, {
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

    // ①.4 空间写上下文（2 期，v1.92.0-dev）：一次 settings 读拿到 canonicalTags 词表
    // （1 期归一）+ hintToggles 族开关（2 期闸门）+ pathTypes。与 upsertCore 同源同读法。
    const spaceCtx = await this.getSpaceWriteContext(doc.spaceId);
    const hintToggles = spaceCtx.hintToggles;
    const hintActorId = actor?.id ?? 'system';

    // ①.5 tag 归一（v1.92.0-dev，挂点 ② metadata-only 通道）——本通道自有事务 +
    // 自有幂等包裹，**不经 upsertCore**（A1 主脑复核：归一必须双挂点）。幂等 replay
    // 检查已在上方完成（指纹用 caller 原始 tags，归一确定性保证重放语义不变），此处
    // 归一后的值参与下方 changedFields 比较与落库。
    const { tags: resolvedTags, normalizations } = this.resolveTags(dto.tags, spaceCtx.vocabulary);
    const tagNormalizations = normalizations.length > 0 ? normalizations : undefined;

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
          `(expected ${dto.expectedContentHash}, current ${doc.contentHash}); re-read the document and retry` +
          DOC_CONTENT_CONFLICT_RECOVERY_SUFFIX,
        code: ErrorCode.DOC_CONTENT_CONFLICT,
        data: { currentContentHash: doc.contentHash },
      });
    }

    // ④ category 解析（仅显式携带时）：默认只解析既有分类（不命中 → 404 明确 code，
    // 防拼写产生近似分类）；allowCreateCategory=true 才走 resolveCategory 自动创建。
    // 事务外解析与 move/upsert 先例同款（创建分类后若事务内 hash 复核失败，
    // 可能留下孤立新分类——既有 upsert 路径同语义，不额外加复杂度）
    let resolvedCategoryId: string | null | undefined;
    let categoryCreated = false;
    if (dto.category !== undefined) {
      if (dto.allowCreateCategory) {
        const resolved = await this.resolveCategory(doc.spaceId, dto.category);
        resolvedCategoryId = resolved.categoryId;
        categoryCreated = resolved.created;
      } else {
        resolvedCategoryId = await this.findCategoryByName(doc.spaceId, dto.category);
      }
      if (!resolvedCategoryId) {
        throw new NotFoundException({
          message:
            `Category '${dto.category}' not found in space (resolve-only mode); ` +
            `pass allowCreateCategory=true to auto-create it`,
          code: ErrorCode.DOC_CATEGORY_NOT_FOUND,
        });
      }
    }

    // ── hint 候选池（2 期，族闸门内；事务前读——连接饥饿规避见 upsertCore 池注释）──────
    // tags 族池：闸门 = `shouldLoadTagPool(resolvedTags, …)`——与 upsertCore 同源。
    // **输入必须是请求面 resolvedTags（未携带 = undefined），禁止回退到 doc.tags**：
    // `resolvedTags ?? doc.tags` 是**写语义的 Partial 回退**（同表达式在 upsertCore 的
    // `target.tags = resolvedTags ?? target.tags` 是合法的），把它当作「评估作用域闸门」
    // 会让「本请求压根没提 tags」的 metadata patch 对**全量存量 tags** 跑近义比对
    // （批 1 修掉的失效模式：客户连发五次改 docType 就收五次 tag 建议）。
    // 比较输入仍是落库面 doc.tags（buildDocWriteHints 侧），两者**刻意不同源**。
    let tagPool: HintPoolEntry[] | null = null;
    if (shouldLoadTagPool(resolvedTags, hintToggles, spaceCtx.vocabulary)) {
      tagPool = await loadTagPool(this.docRepo, doc.spaceId);
    }
    // categories 族：仅本次自动新建分类时才有意义（排除刚建的那条，不进自己的池）
    let categoryNearDupCandidate: HintCandidate | null = null;
    if (hintToggles?.categories === true && categoryCreated && resolvedCategoryId && dto.category) {
      const pool = await loadCategoryPool(this.categoryRepo, doc.spaceId, resolvedCategoryId);
      categoryNearDupCandidate = buildCategoryNearDupHint(dto.category, pool, resolvedCategoryId);
    }
    const precomputedCandidates = categoryNearDupCandidate ? [categoryNearDupCandidate] : [];

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
              `re-read the document and retry` +
              DOC_CONTENT_CONFLICT_RECOVERY_SUFFIX,
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
          resolvedTags !== undefined &&
          (resolvedTags.length !== locked.tags.length ||
            resolvedTags.some((t, i) => t !== locked.tags[i]))
        ) {
          changedFields.push('tags');
          before.tags = [...locked.tags];
          updates.tags = resolvedTags;
        }
        if (resolvedCategoryId !== undefined && resolvedCategoryId !== locked.categoryId) {
          changedFields.push('category');
          before.categoryId = locked.categoryId;
          updates.categoryId = resolvedCategoryId;
        }

        // unchanged 短路：零变更 → 不产生任何写操作（无 UPDATE/audit/事件）。
        // 响应在事务内组装（v1.63.0 幂等：unchanged 快照同样登记，重放语义一致）
        if (changedFields.length === 0) {
          // 2 期 hints：unchanged 出口**同样发**（镜像 1 期「零变更也回显归一」语义：
          // 零写操作 ≠ 零建议）。headingPaths=null → routes 族跳过（本通道不重切
          // sections，锚必然不变）。
          const hints = this.buildDocWriteHints({
            surface: 'patch_metadata',
            spaceId: doc.spaceId,
            doc: locked,
            spaceCtx,
            normalizations,
            headingPaths: null,
            // 本通道不重切 sections（headingPaths=null）→ routes 族整段跳过，无需引用清单
            routeRefs: null,
            tagPool,
            precomputedCandidates,
            actorId: hintActorId,
          });
          const result: PatchDocMetadataResult = {
            docId,
            path: locked.path,
            contentHash: locked.contentHash,
            changedFields: [],
            unchanged: true,
            // tag 归一映射（v1.92.0-dev）：归一后与现值相同也回显（说明 caller 输入
            // 已被词表纠偏；写操作零发生）
            ...(tagNormalizations ? { tagNormalizations } : {}),
            ...(hints ? { hints } : {}),
            // 分类视图与首次幂等快照共用当前事务连接，避免持锁时再申请池连接。
            metadata: await this.buildMetadataView(locked, manager),
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
        // 2 期 hints：同样在事务内组装（随快照进幂等记录），基准 = 落库后的 fresh 行
        const hints = this.buildDocWriteHints({
          surface: 'patch_metadata',
          spaceId: doc.spaceId,
          doc: fresh,
          spaceCtx,
          normalizations,
          headingPaths: null,
          // 本通道不重切 sections（headingPaths=null）→ routes 族整段跳过，无需引用清单
          routeRefs: null,
          tagPool,
          precomputedCandidates,
          actorId: hintActorId,
        });
        const result: PatchDocMetadataResult = {
          docId,
          path: fresh.path,
          contentHash: fresh.contentHash,
          changedFields,
          unchanged: false,
          ...(tagNormalizations ? { tagNormalizations } : {}),
          ...(hints ? { hints } : {}),
          metadata: await this.buildMetadataView(fresh, manager),
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
   * @param doc 当前事务锁定或更新后重读的文档。
   * @param manager 当前事务 manager；分类读取必须复用持锁连接，不得退回全局仓储。
   * @returns 与同事务幂等快照一致的最终元数据视图。
   */
  private async buildMetadataView(doc: Doc, manager: EntityManager): Promise<PatchDocMetadataView> {
    let categoryName: string | null = null;
    if (doc.categoryId) {
      const cat = await manager
        .getRepository(DocCategory)
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
  async remove(docId: string, source?: string, actor?: UnifiedActor): Promise<DocDeleteResult> {
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

    // hint（2 期，v1.92.0-dev）：docId 锚断 = **语义判定**（文档消失 → 指向它的路由
    // 全部失效），无逐锚成本故不受 upsert 侧的 20 条 cap 限制。族关 → 零查询零 hints。
    const hints = await this.buildDeleteHints({
      spaceId: doc.spaceId,
      docId,
      actorId: actor?.id ?? 'system',
    });

    return { deleted: true, path: doc.path, ...(hints ? { hints } : {}) };
  }

  /**
   * 组装 delete 路径的 hint（2 期，v1.92.0-dev）。
   *
   * 唯一 code = `route_anchor_broken`（check_failed）：指向被删文档的路由锚点全部失效
   * ——docId 锚断是语义判定（读面消失），数据源 = RouteHealthService 的引用清单查询
   * （A2 收口，不复制锚校验逻辑）。
   *
   * @returns ≤3 条 DocHint；族关/无引用路由 → undefined
   */
  private async buildDeleteHints(params: {
    spaceId: string;
    docId: string;
    actorId: string;
  }): Promise<DocHint[] | undefined> {
    const spaceCtx = await this.getSpaceWriteContext(params.spaceId);
    if (spaceCtx.hintToggles?.routes !== true) return undefined;

    const { brokenRouteIds, anchors } = await this.routeHealthService.analyzeDocRouteAnchors(
      params.spaceId,
      params.docId,
      null,
    );
    const candidate = buildRouteAnchorBrokenHint(brokenRouteIds, anchors, params.docId);
    if (!candidate) return undefined;

    return this.emitHints([candidate], {
      surface: 'delete',
      spaceId: params.spaceId,
      actorId: params.actorId,
    });
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
