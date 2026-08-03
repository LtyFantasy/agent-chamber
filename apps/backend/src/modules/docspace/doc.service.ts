/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.3 (文档读/文档写), plan §4.4 (chunking), plan §1.1-13 (sectionId 不稳定契约)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
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
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Board } from '../../database/entities/board.entity';
import { ErrorCode, AuditAction, EventType } from '@agent-chamber/shared';
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
        code: ErrorCode.RESOURCE_CONFLICT,
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
   * Get document detail: metadata + section outline (no content).
   * QB select explicitly excludes section content.
   */
  async findOne(id: string): Promise<DocDetail> {
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
      headingLevel: s.headingLevel,
      tokenEstimate: s.tokenEstimate,
    }));

    const base = this.toSummary(doc);
    return {
      ...base,
      sections: outline,
      linkHealth: doc.linkHealth as LinkHealth | null | undefined,
    };
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
   * @param skipDuplicateTitle 渲染侧去重：position 0 的 H1 若与 doc.title 同名则不重复
   *   插标题行（web 渲染层已用 header 元数据卡展示 title）；链接巡检等语义消费方应传
   *   false，保证与 upsert 时原文计算口径一致。
   */
  private reconstructContent(
    doc: Doc,
    sections: { content: string; headingLevel: number; headingPath: string | null }[],
    skipDuplicateTitle: boolean,
  ): string {
    return sections
      .map((s, idx) => {
        if (s.headingLevel > 0 && s.headingPath) {
          const lastSegment = s.headingPath.split('§').pop()?.trim() ?? '';
          const isDuplicateTitle = skipDuplicateTitle && idx === 0 && lastSegment === doc.title;
          if (lastSegment && !isDuplicateTitle) {
            const prefix = '#'.repeat(Math.min(s.headingLevel, 6));
            return `${prefix} ${lastSegment}\n\n${s.content}`;
          }
        }
        return s.content;
      })
      .join('\n\n');
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
