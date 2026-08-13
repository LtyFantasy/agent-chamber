/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (文档读/文档写), plan §4.4 (chunking), plan §1.1-13 (sectionId 不稳定契约)
 *
 * [踩坑索引]
 *   - 任务 e6eaf06d 第二张脸：chunker step 4 段落切分产生的兄弟 chunk 共用同一 headingPath，
 *     重建时若逐个插标题行，同一标题会重复 N 次（生产实证 12~180 次），且「全文读 + upsert
 *     回写」每轮固化重复标题，文档越往返越臃肿；reconstructContent 已实现 run-dedup
 *     （相邻 section 同 (headingPath, headingLevel) 只插回一次标题）——修改该逻辑前先跑
 *     docspace 测试验证往返幂等（长文 round-trip 用例）
 *   - 互斥查询参数（path= 与 q=）同传是请求格式错误：400 VALIDATION_ERROR，禁止用
 *     RESOURCE_CONFLICT（2026-08-09 修复 edad7a9，原误挂 RESOURCE_CONFLICT）
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释) #21(双层校验) #22(findOne必须判空)
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
import { ErrorCode, AuditAction, EventType, HEADING_PATH_SEPARATOR } from '@agent-chamber/shared';
import type {
  DocSummary,
  DocDetail,
  DocSectionOutline,
  DocSectionContent,
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
        };
      }
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
          // Delete old sections (CASCADE handles FK, but we delete explicitly for clarity)
          await sectionRepo
            .createQueryBuilder()
            .delete()
            .where('doc_id = :docId', { docId: existing.id })
            .execute();

          // Update metadata
          existing.title = autoTitle;
          existing.summary = summary;
          existing.docType = dto.docType ?? existing.docType;
          existing.tags = dto.tags ?? existing.tags;
          existing.categoryId = categoryId ?? existing.categoryId;
          existing.contentHash = computedHash;
          // 内容变更时刷新 last-verified sha（sync 携带则覆盖；native 编辑不带 sha 保留旧值——
          // 旧 sha 将显 stale，正是消费端 doc.sourceSha vs 空间 maxSha 新鲜度比较的用途）
          existing.sourceSha = dto.sourceSha ?? existing.sourceSha;
          existing.sectionCount = chunks.length;
          existing.tokenEstimate = totalTokens;
          existing.linkHealth = linkHealth as unknown as Record<string, unknown>;
          doc = await docRepo.save(existing);
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
   * List documents in a space. Supports filters: category, tag, type, q (full-text), path (exact).
   * path= and q= are mutually exclusive.
   */
  async findAll(
    spaceId: string,
    query: {
      category?: string;
      tag?: string;
      type?: string;
      q?: string;
      path?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<PaginatedResponse<DocSummary>> {
    const { category, tag, type, q, path, page = 1, pageSize = 20 } = query;

    // path= and q= are mutually exclusive
    if (path && q) {
      throw new BadRequestException({
        message: 'path= and q= are mutually exclusive',
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
      heading: s.headingPath
        ? (s.headingPath.split(HEADING_PATH_SEPARATOR).pop()?.trim() ?? '')
        : null,
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
      // 复用 reconstructContent 渲染去重语义（skipDuplicateTitle=true，与 web /content 默认一致）。
      const fullSections = await this.sectionRepo
        .createQueryBuilder('s')
        .where('s.docId = :docId', { docId: id })
        .orderBy('s.position', 'ASC')
        .getMany();

      result.mode = 'full';
      result.content = this.reconstructContent(doc, fullSections, true);
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
   * run-dedup：chunker step 4 对 >4000 字符的 section 按段落二次切分，子 chunk 共用同一
   * headingPath/headingLevel 且相邻——重建时逐个插回标题行会把同一标题重复 N 次（生产实证
   * 同标题重复 12~180 次），每轮「全文读 + upsert 回写」还会把重复标题固化进下一轮存储。
   * 因此相邻 section 的 (headingPath, headingLevel) 相同 = 同一切分段，仅首个插标题行、
   * 后续兄弟只接正文。已知取舍：原文「同父同名且相邻」的病态重复标题会被合并
   * （极罕见，且本身就是坏文档）。
   *
   * @param skipDuplicateTitle 渲染侧去重：position 0 的 H1 若与 doc.title 同名则不重复
   *   插标题行（web 渲染层已用 header 元数据卡展示 title）；链接巡检等语义消费方应传
   *   false，保证与 upsert 时原文计算口径一致。
   */
  private reconstructContent(
    doc: Doc,
    sections: { content: string; headingLevel: number; headingPath: string | null }[],
    skipDuplicateTitle: boolean,
  ): string {
    const parts = sections
      .map((s, idx) => {
        if (s.headingLevel > 0 && s.headingPath) {
          // run-dedup：与前一 section 同 (headingPath, headingLevel) 视为段落切分兄弟 chunk
          // （chunker step 4 共用同一 headingPath 的产物），只由首个插标题行，后续只接正文。
          // 与 idx===0 的 skipDuplicateTitle 去重独立生效：idx 0 被去重后，idx 1 若同
          // headingPath 也不插标题（正确，本就是同一切分段）。
          const prev = idx > 0 ? sections[idx - 1] : null;
          const isSiblingParagraphChunk =
            prev !== null &&
            prev.headingPath === s.headingPath &&
            prev.headingLevel === s.headingLevel;
          if (!isSiblingParagraphChunk) {
            const lastSegment = s.headingPath.split(HEADING_PATH_SEPARATOR).pop()?.trim() ?? '';
            const isDuplicateTitle = skipDuplicateTitle && idx === 0 && lastSegment === doc.title;
            if (lastSegment && !isDuplicateTitle) {
              const prefix = '#'.repeat(Math.min(s.headingLevel, 6));
              // 空 content section 只插标题行（不追加 "\n\n"），避免 join 后产生多余空行
              return s.content
                ? `${prefix} ${lastSegment}\n\n${s.content}`
                : `${prefix} ${lastSegment}`;
            }
          }
        }
        return s.content;
      })
      // 过滤被去重吞掉（isDuplicateTitle）或 level-0 且内容为空的 section 产生的空串，
      // 防止 join 拼接出多余空行；正常 section 的 content 非空，不受影响
      .filter((part) => part !== '');
    return parts.join('\n\n');
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
      content: section.content,
      tokenEstimate: section.tokenEstimate,
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
        .select(['s.content', 's.headingLevel', 's.headingPath'])
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
