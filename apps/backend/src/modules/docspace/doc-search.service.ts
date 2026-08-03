/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.5 (检索规格), plan §1.5 (检索双路纯 PostgreSQL)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释) #21(双层校验)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocSection } from '../../database/entities/doc-section.entity';
import { Doc } from '../../database/entities/doc.entity';
import type { DocSearchHit } from '@agent-chamber/shared';

/**
 * 双路打分权重常量
 *
 * rationale：
 * - ts_rank 对英文/标识符精确匹配贡献最大（1.0 权重）
 * - similarity(content) × 0.6 提供中文模糊匹配（pg_trgm 滑窗）
 * - similarity(headingPath) × 0.8 标题路径命中权重略高于正文（结构信息更值钱）
 * - 所有常量集中一处，后续调参只需改这里
 */
const RANK_WEIGHTS = {
  /** ts_rank 权重 — 英文/标识符精确匹配 */
  TS_RANK: 1.0,
  /** pg_trgm similarity(content) 权重 — 中文模糊匹配 */
  TRGM_CONTENT: 0.6,
  /** pg_trgm similarity(headingPath) 权重 — 标题结构匹配 */
  TRGM_HEADING: 0.8,
} as const;

/**
 * 合成分数下限阈值
 *
 * rationale：
 * - `similarity()` 函数打分不走 `%` 操作符，不受 `pg_trgm.similarity_threshold` 约束
 * - 必须应用层加合成分数下限，防止零相关文档混入 top-k
 * - 0.08 为初始经验值：单一 trgm 命中约 0.05~0.15，ts_rank 命中 > 0.1
 *   取 0.08 留足余量同时截断纯噪音
 */
const SCORE_FLOOR = 0.08;

/** Snippet 最大字符数 */
const SNIPPET_MAX_CHARS = 300;

/** 纯 trgm 命中时，匹配子串前后各取字符数 */
const SNIPPET_CONTEXT_CHARS = 150;

/** 默认返回条数 */
const DEFAULT_LIMIT = 5;
/** 最大返回条数 */
const MAX_LIMIT = 20;

interface SearchRow {
  doc_id: string;
  doc_path: string;
  doc_title: string;
  section_position: number;
  heading_path: string | null;
  section_content: string;
  ts_rank_score: number;
  trgm_content_score: number;
  trgm_heading_score: number;
}

@Injectable()
export class DocSearchService {
  constructor(
    @InjectRepository(DocSection)
    private readonly sectionRepo: Repository<DocSection>,
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
  ) {}

  /**
   * Search documents within accessible spaces using dual scoring.
   *
   * Scoring:
   *   composite = ts_rank(search_vector, query) × TS_RANK(1.0)
   *             + similarity(content, query) × TRGM_CONTENT(0.6)
   *             + similarity(heading_path, query) × TRGM_HEADING(0.8)
   *
   * Filtering:
   *   - Only spaces in accessibleSpaceIds
   *   - docs.deleted_at IS NULL
   *   - Optional type / tag / category filters
   *
   * Score floor: composite > SCORE_FLOOR (0.08) —
   *   filters zero-relevance noise that pg_trgm would otherwise pass through.
   *
   * Snippet:
   *   - ts_headline when ts_rank > 0
   *   - Fallback: matched substring ±150 chars, ≤300 chars total
   *
   * Sorting: score DESC, position ASC (stable within same doc).
   *
   * @param accessibleSpaceIds - Whitelist from AccessQueryService (null = admin, all spaces)
   * @param query - Search parameters (q, type, tag, category, limit)
   * @returns Ranked search hits
   */
  async search(
    accessibleSpaceIds: string[] | null,
    query: {
      q: string;
      type?: string;
      tag?: string;
      category?: string;
      limit?: number;
    },
  ): Promise<DocSearchHit[]> {
    const { q, type, tag, category, limit = DEFAULT_LIMIT } = query;
    const effectiveLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);

    // Empty whitelist short-circuit (non-admin with zero accessible spaces)
    if (accessibleSpaceIds !== null && accessibleSpaceIds.length === 0) {
      return [];
    }

    // Dual-scoring subquery: per-section ts_rank + trgm(content) + trgm(headingPath),
    // wrapped so the composite score can be filtered (floor) and ordered as a column.
    const rows = await this.sectionRepo.manager
      .createQueryBuilder()
      .select('sub.*')
      .addSelect(
        `(sub.ts_rank_score * ${RANK_WEIGHTS.TS_RANK} + sub.trgm_content_score * ${RANK_WEIGHTS.TRGM_CONTENT} + sub.trgm_heading_score * ${RANK_WEIGHTS.TRGM_HEADING})`,
        'score',
      )
      .from((subQuery) => {
        const sqb = subQuery
          .select('d.id', 'doc_id')
          .addSelect('d.path', 'doc_path')
          .addSelect('d.title', 'doc_title')
          .addSelect('s.position', 'section_position')
          .addSelect('s.heading_path', 'heading_path')
          .addSelect('s.content', 'section_content')
          .addSelect(
            `COALESCE(ts_rank(s.search_vector, plainto_tsquery('simple', :q)), 0)`,
            'ts_rank_score',
          )
          .addSelect('similarity(s.content, :q)', 'trgm_content_score')
          .addSelect("similarity(COALESCE(s.heading_path, ''), :q)", 'trgm_heading_score')
          .from('doc_sections', 's')
          .innerJoin('docs', 'd', 'd.id = s.doc_id')
          .leftJoin('doc_categories', 'dc', 'dc.id = d.category_id')
          .where('d.deleted_at IS NULL')
          .setParameter('q', q);

        if (accessibleSpaceIds !== null) {
          if (accessibleSpaceIds.length === 0) {
            return sqb.where('1 = 0');
          }
          sqb.andWhere('d.space_id IN (:...spaceIds)', { spaceIds: accessibleSpaceIds });
        }
        if (type) {
          sqb.andWhere('d.doc_type = :docType', { docType: type });
        }
        if (tag) {
          sqb.andWhere(':tagVal = ANY(d.tags)', { tagVal: tag });
        }
        if (category) {
          sqb.andWhere('dc.slug = :catSlug', { catSlug: category });
        }

        return sqb;
      }, 'sub')
      .where(
        `(sub.ts_rank_score * ${RANK_WEIGHTS.TS_RANK} + sub.trgm_content_score * ${RANK_WEIGHTS.TRGM_CONTENT} + sub.trgm_heading_score * ${RANK_WEIGHTS.TRGM_HEADING}) > :scoreFloor`,
        { scoreFloor: SCORE_FLOOR },
      )
      .orderBy('score', 'DESC')
      .addOrderBy('sub.section_position', 'ASC')
      .limit(effectiveLimit)
      .getRawMany<SearchRow & { score: number }>();

    // Build hits
    const hits: DocSearchHit[] = [];
    for (const row of rows) {
      const hasTsMatch = Number(row.ts_rank_score) > 0;
      const snippet = hasTsMatch
        ? await this.buildTsHeadlineSnippet(row.doc_id, row.section_position, q)
        : this.buildTrgmSnippet(row.section_content, q);

      hits.push({
        docId: row.doc_id,
        docPath: row.doc_path,
        docTitle: row.doc_title,
        position: Number(row.section_position),
        headingPath: row.heading_path ?? null,
        snippet: snippet.text,
        contentTruncated: snippet.truncated,
        score: Number(row.score),
      });
    }

    return hits;
  }

  /**
   * Build ts_headline snippet for a specific section.
   * Falls back to trgm snippet if ts_headline returns empty.
   */
  private async buildTsHeadlineSnippet(
    docId: string,
    position: number,
    q: string,
  ): Promise<{ text: string; truncated: boolean }> {
    const row = await this.sectionRepo.manager
      .createQueryBuilder()
      .select(
        "ts_headline('simple', s.content, plainto_tsquery(:q), 'MaxWords=50,MaxFragments=2,StartSel=,StopSel=')",
        'headline',
      )
      .from('doc_sections', 's')
      .where('s.doc_id = :docId', { docId })
      .andWhere('s.position = :position', { position })
      .setParameter('q', q)
      .getRawOne<{ headline: string }>();

    if (row?.headline) {
      const truncated = row.headline.length > SNIPPET_MAX_CHARS;
      return {
        text: truncated ? row.headline.slice(0, SNIPPET_MAX_CHARS) : row.headline,
        truncated,
      };
    }

    // Fallback: get content and build trgm snippet
    const section = await this.sectionRepo.findOne({
      where: { docId, position },
      select: ['content'],
    });
    if (section) {
      return this.buildTrgmSnippetRefined(section.content, q);
    }

    return { text: '', truncated: false };
  }

  /**
   * Build snippet from content when no tsvector match (pure trgm).
   * Finds the first matching substring and returns ±150 chars context, ≤300 chars.
   */
  private buildTrgmSnippet(content: string, q: string): { text: string; truncated: boolean } {
    return this.buildTrgmSnippetRefined(content, q);
  }

  /**
   * Core trgm snippet logic: find first match, extract context window.
   */
  private buildTrgmSnippetRefined(
    content: string,
    q: string,
  ): { text: string; truncated: boolean } {
    // Find first occurrence of any query word (case-insensitive)
    const queryWords = q.split(/\s+/).filter(Boolean);
    let matchIndex = -1;
    let matchLen = 0;

    for (const word of queryWords) {
      const idx = content.toLowerCase().indexOf(word.toLowerCase());
      if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
        matchIndex = idx;
        matchLen = word.length;
      }
    }

    // Also try trigram fuzzy: find 3-char substrings
    if (matchIndex === -1 && q.length >= 3) {
      for (let i = 0; i <= q.length - 3; i++) {
        const trigram = q.slice(i, i + 3).toLowerCase();
        const idx = content.toLowerCase().indexOf(trigram);
        if (idx !== -1) {
          matchIndex = idx;
          matchLen = 3;
          break;
        }
      }
    }

    if (matchIndex === -1) {
      // No match found, return beginning of content
      const truncated = content.length > SNIPPET_MAX_CHARS;
      return {
        text: truncated ? content.slice(0, SNIPPET_MAX_CHARS) : content,
        truncated,
      };
    }

    const matchCenter = matchIndex + Math.floor(matchLen / 2);
    const start = Math.max(0, matchCenter - SNIPPET_CONTEXT_CHARS);
    const end = Math.min(content.length, matchCenter + SNIPPET_CONTEXT_CHARS);

    let snippet = content.slice(start, end);
    const wasTruncatedLeft = start > 0;
    const wasTruncatedRight = end < content.length;

    // Add ellipsis markers
    if (wasTruncatedLeft) snippet = '…' + snippet;
    if (wasTruncatedRight) snippet = snippet + '…';

    const truncated = snippet.length > SNIPPET_MAX_CHARS;
    if (truncated) {
      snippet = snippet.slice(0, SNIPPET_MAX_CHARS);
    }

    return { text: snippet, truncated };
  }
}
