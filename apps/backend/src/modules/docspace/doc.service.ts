/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (文档读/文档写), plan §4.4 (chunking), plan §1.1-13 (sectionId 不稳定契约)
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
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Board } from '../../database/entities/board.entity';
import {
  ErrorCode,
  AuditAction,
  EventType,
  extractLastHeadingSegment,
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
} from '@agent-chamber/shared';
import { chunkMarkdown } from './markdown-chunker';
import { computeLinkHealth } from './link-health';
import { RouteHealthService } from './route-health.service';
import { UnifiedActor } from '../../common/types/actor.types';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { EventService } from '../event/event.service';

/**
 * Generate a URL-friendly slug from a name.
 * Lowercase, replace non-alphanumeric with hyphens, collapse multiples.
 * Mirrors the slugify in docspace.service.ts.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 128);
}

/**
 * 小文档全文内联的缺省 token 阈值（?maxFullTokens= 可覆盖，0 = 强制 outline）。
 *
 * rationale：无定位参数的 GET /docs/:id 面向 Agent 消费——小文档（约 2k tokens 内）
 * 逐 section 精读需要 N 次 round-trip + N 段重复元数据，一次性内联全文对 Agent 更优；
 * 大文档仍走 outline + section 精读，避免单次响应打爆 Agent 上下文。
 * 上限 100000 由 DocDetailQueryDto 校验约束（防任意大文档全文内联 = 响应放大攻击面）。
 */
const FULL_CONTENT_TOKEN_THRESHOLD = 2000;

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
    private readonly eventService: EventService,
    // 循环依赖说明（批次 C1）：本服务触发点注入 RouteHealthService（upsert/remove 内
    // setImmediate 重检），RouteHealthService 又注入本服务复用 sectionExistsByHeadingPath →
    // 互相依赖，双向 forwardRef 是 NestJS 标准解法（plan §2 授权）。
    @Inject(forwardRef(() => RouteHealthService))
    private readonly routeHealthService: RouteHealthService,
  ) {}

  // ─── Helpers ─────────────────────────────────────────────────

  /**
   * Derive topicId and boardId from a DocSpace.
   * If space has boardId, derive topicId from board; otherwise use space.topicId.
   */
  private async getSpaceEventContext(spaceId: string): Promise<{
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
  private extractFirstParagraph(text: string, maxLen = 500): string {
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
      tags: doc.tags,
      source: doc.source,
      sourceSha: doc.sourceSha,
      sectionCount: doc.sectionCount,
      tokenEstimate: doc.tokenEstimate,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
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
   * - changed → transaction: delete old sections, insert new, update metadata
   * - category by name resolution (auto-create if not found)
   * - summary defaults to first section's first paragraph (≤500 chars)
   * - source isolation: existing doc with non-matching source → 409
   * - expectedContentHash（可选乐观锁，v1.57 fail-closed 改造）：携带时校验现存
   *   doc 的 contentHash——doc 不存在或 hash 不符 → 409 DOC_CONTENT_CONFLICT；
   *   hash 相符且内容未变 → unchanged 正常返回（不算冲突）。校验在**事务内**
   *   FOR UPDATE 锁行后复核（TOCTOU 加固，见事务内注释）；事务外同款检查只是
   *   快速失败路径。
   * - 23505 concurrent catch → re-query existing doc (idempotency)
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
    },
    actor?: UnifiedActor,
  ): Promise<UpsertDocResult> {
    const computedHash = this.computeHash(dto.content);
    const source = dto.source || 'native';

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

      // Unchanged check
      if (existing.contentHash === computedHash) {
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
          const backfill: LinkHealth = computeLinkHealth(dto.content, { paths, docIds });
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
        return {
          id: existing.id,
          path: existing.path,
          sectionCount: existing.sectionCount,
          tokenEstimate: existing.tokenEstimate,
          unchanged: true,
          contentHash: existing.contentHash ?? undefined,
        };
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

    // Pre-compute category, title, summary
    const categoryId = await this.resolveCategory(spaceId, dto.category);

    const chunks = chunkMarkdown(dto.content, dto.title || dto.path);
    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenEstimate, 0);
    const autoTitle = dto.title || this.extractHeadingFromContent(dto.content) || dto.path;
    const summary =
      dto.summary ??
      (chunks.length > 0 ? this.extractFirstParagraph(chunks[0].content, 500) : null);

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

    const linkHealth: LinkHealth = computeLinkHealth(dto.content, { paths, docIds });

    try {
      const result = await this.docRepo.manager.transaction(async (manager) => {
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
          target.docType = dto.docType ?? target.docType;
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
          // Create new
          doc = docRepo.create({
            spaceId,
            categoryId,
            path: dto.path,
            title: autoTitle,
            summary,
            docType: dto.docType ?? null,
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
              headingLevel: c.headingLevel,
              isContinuation: c.isContinuation,
              content: c.content,
              tokenEstimate: c.tokenEstimate,
            }),
          );
          await sectionRepo.save(sectionEntities);
        }

        return doc;
      });

      // Audit hook
      if (actor) {
        const auditEntry = this.auditRepo.create({
          action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
          entityType: 'doc',
          entityId: result.id,
          actorId: actor.id,
          newData: { path: result.path, title: result.title },
          source: 'api',
        });
        await this.auditRepo.save(auditEntry);
      }

      // Emit document change event
      if (!existing) {
        const ctx = await this.getSpaceEventContext(spaceId);
        await this.eventService.create({
          eventType: EventType.DOC_CREATED,
          resourceType: 'doc',
          resourceId: result.id,
          actorId: actor?.id ?? undefined,
          topicId: ctx.topicId ?? undefined,
          boardId: ctx.boardId ?? undefined,
          payload: { spaceId, docId: result.id, path: result.path, title: autoTitle },
        });
      } else {
        // Unchanged content already early-returned above; reaching here with an
        // existing doc always means the content changed. NOTE: do not re-check
        // `existing.contentHash !== computedHash` here — the transaction above
        // mutates the entity in place, so that comparison is always false.
        const ctx = await this.getSpaceEventContext(spaceId);
        await this.eventService.create({
          eventType: EventType.DOC_UPDATED,
          resourceType: 'doc',
          resourceId: result.id,
          actorId: actor?.id ?? undefined,
          topicId: ctx.topicId ?? undefined,
          boardId: ctx.boardId ?? undefined,
          payload: { spaceId, docId: result.id, path: result.path, title: autoTitle },
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

      return {
        id: result.id,
        path: result.path,
        sectionCount: result.sectionCount,
        tokenEstimate: result.tokenEstimate,
        created: isCreate,
        contentHash: result.contentHash ?? undefined,
      };
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
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

        return {
          id: winner.id,
          path: winner.path,
          sectionCount: winner.sectionCount,
          tokenEstimate: winner.tokenEstimate,
          created: false,
          contentHash: winner.contentHash ?? undefined,
        };
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
   */
  async batchUpsert(
    spaceId: string,
    docs: Array<{
      path: string;
      content: string;
      title?: string;
      summary?: string;
      docType?: string;
      category?: string;
      tags?: string[];
      source?: string;
    }>,
    actor?: UnifiedActor,
  ): Promise<BatchUpsertDocsResult> {
    const results: BatchUpsertItemResult[] = [];
    const summary = { total: docs.length, created: 0, updated: 0, unchanged: 0, failed: 0 };

    for (const dto of docs) {
      try {
        const r = await this.upsert(spaceId, dto, actor);

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
        const httpErr = err as { response?: { message?: string; code?: number }; message?: string };
        results.push({
          path: dto.path,
          status: 'failed',
          error: {
            message: httpErr.response?.message ?? httpErr.message ?? 'Unknown error',
            code: httpErr.response?.code,
          },
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
      .select(['s.position', 's.headingPath', 's.headingLevel', 's.tokenEstimate'])
      .where('s.docId = :docId', { docId: id })
      .orderBy('s.position', 'ASC')
      .getMany();

    const outline: DocSectionOutline[] = sections.map((s) => ({
      position: s.position,
      headingPath: s.headingPath,
      // heading 派生：headingPath 末段 = 本地标题（展示用；与 reconstructContent 的
      // lastSegment 同款派生）。headingPath 为 null（headingLevel 0 文首无标题段）→ null；
      // headingPath 本身保留作寻址地址，语义不变。
      heading: s.headingPath ? extractLastHeadingSegment(s.headingPath) : null,
      headingLevel: s.headingLevel,
      tokenEstimate: s.tokenEstimate,
    }));

    const base = this.toSummary(doc);
    const result: DocDetail = {
      ...base,
      sections: outline,
      linkHealth: doc.linkHealth as LinkHealth | null | undefined,
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
   */
  private reconstructContent(
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
      isContinuation?: boolean;
    },
    idx: number,
    docTitle: string,
    skipDuplicateTitle: boolean,
  ): string {
    if (s.headingLevel > 0 && s.headingPath && !s.isContinuation) {
      const lastSegment = extractLastHeadingSegment(s.headingPath);
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
   * @returns upsert 结果 {id, path, sectionCount, tokenEstimate, unchanged?, contentHash}
   */
  async patchSection(
    docId: string,
    position: number,
    content: string,
    source: string,
    actor?: UnifiedActor,
    expectedSectionHash?: string,
  ): Promise<UpsertDocResult> {
    const doc = await this.findById(docId);

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
    return this.upsert(
      doc.spaceId,
      {
        path: doc.path,
        content: fullContent,
        title: doc.title,
        summary: doc.summary ?? undefined,
        source,
        // 内部乐观锁（TOCTOU 加固）：doc.contentHash 为 null 的远古文档无哈希可比对，
        // 退化为无前提（无法加固的既有数据形态，不阻塞写）
        expectedContentHash: doc.contentHash ?? undefined,
      },
      actor,
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
   * @returns upsert 结果 {id, path, sectionCount, tokenEstimate, unchanged?, contentHash}
   */
  async patchByMatch(
    docId: string,
    oldString: string,
    newString: string,
    source: string,
    actor?: UnifiedActor,
  ): Promise<UpsertDocResult> {
    const doc = await this.findById(docId);

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

    // 复用 upsert 重建管线 + 内部乐观锁（见方法 doc 注释「TOCTOU 加固」）
    return this.upsert(
      doc.spaceId,
      {
        path: doc.path,
        content: newContent,
        title: doc.title,
        summary: doc.summary ?? undefined,
        source,
        // 内部乐观锁（TOCTOU 加固）：doc.contentHash 为 null 的远古文档无哈希可比对，
        // 退化为无前提（无法加固的既有数据形态，不阻塞写）
        expectedContentHash: doc.contentHash ?? undefined,
      },
      actor,
    );
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
    if (doc.source !== 'native' && source !== doc.source) {
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
        entityType: 'doc',
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
      resourceType: 'doc',
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
   * Recalculate link_health for every non-deleted doc in a space.
   *
   * Fire-and-forget async task — failures are only logged, not surfaced to callers.
   * Called after doc deletion to refresh broken links caused by removed docs (L4).
   */
  private async recalcSpaceLinkHealth(spaceId: string): Promise<void> {
    // Get all non-deleted docs in space (id + path for candidate resolution)
    const docs = await this.docRepo
      .createQueryBuilder('d')
      .select(['d.id', 'd.path'])
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .getMany();

    if (docs.length === 0) return;

    const docIds = new Set(docs.map((d) => d.id));
    const paths = new Set(docs.map((d) => d.path));

    for (const doc of docs) {
      // Fetch sections ordered by position, reconstruct content with heading lines
      // restored (same inverse-of-chunker logic as getContent) so link extraction
      // matches the upsert-time original-content semantics.
      const sections = await this.sectionRepo
        .createQueryBuilder('s')
        .select(['s.content', 's.headingLevel', 's.headingPath', 's.isContinuation'])
        .where('s.doc_id = :docId', { docId: doc.id })
        .orderBy('s.position', 'ASC')
        .getMany();

      const content = this.reconstructContent(doc, sections, false);
      const linkHealth: LinkHealth = computeLinkHealth(content, { paths, docIds });

      await this.docRepo
        .createQueryBuilder()
        .update('Doc')
        .set({ linkHealth: linkHealth as unknown as Record<string, unknown> })
        .where('id = :id', { id: doc.id })
        .execute();
    }
  }
}
