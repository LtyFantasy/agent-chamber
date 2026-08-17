/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.5 (检索规格), plan §1.5 (检索双路纯 PostgreSQL),
 *     plan §4-C3 (意图融合检索：路由/任务链接 boost 重排 + boosts 透出)
 *
 * [踩坑索引]
 *   - bug 9082464c：ts_headline options 串 `'...,StartSel=,StopSel='` 无空格无引号 →
 *     `,StopSel=` 字面量残渣污染 snippet；空值必须写成 `StartSel="", StopSel=""`（详见
 *     buildTsHeadlineSnippet 注释）
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
import { DocRoute } from '../../database/entities/doc-route.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import type { DocSearchHit, DocSearchSort } from '@agent-chamber/shared';

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
 * 三路融合检索加权常量（plan §4-C3 意图融合检索）
 *
 * 语义：SQL SCORE_FLOOR 过滤**之后**，对命中 doc 叠加「策展路由命中」与「任务链接数」
 * 两路乘数加权重排——只重排、不引入新结果（plan §4 明文边界）。
 *
 * rationale：
 * - ROUTE_PRIMARY_BOOST 1.5 > ROUTE_SECONDARY_BOOST 1.2：路由的「先看」文档比「再看」
 *   文档更贴近用户意图，加权更高；同一 doc 被多条路由命中时**取最大倍率不叠加连乘**
 *   （避免策展重复导致分数虚高）；
 * - 阈值语义（≥ 判定）：intent 相似度 ≥0.15 或 category 相似度 ≥0.3 即视为路由命中。
 *   intent 是自由文本（"我要…"），trgm 相似度普遍偏低，故阈值低于 category
 *   （短 slug 词如 "architecture"，命中通常更强）；
 * - TASK_LINK_STEP 0.05 × min(count, TASK_LINK_CAP=5)：被 ≥1 个任务引用的文档带
 *   「被使用」信号加分，封顶 ×1.25 防止高频引用文档（如 README/INDEX 常客）垄断排序；
 * - 所有常量集中一处，后续调参只需改这里。
 */
const ROUTE_PRIMARY_BOOST = 1.5;
const ROUTE_SECONDARY_BOOST = 1.2;
/** 路由 intent 相似度阈值（≥ 命中） */
const ROUTE_INTENT_FLOOR = 0.15;
/** 路由 category 相似度阈值（≥ 命中） */
const ROUTE_CATEGORY_FLOOR = 0.3;
/** 任务链接阶梯步长：每个任务 +5% 权重 */
const TASK_LINK_STEP = 0.05;
/** 任务链接计数封顶（超出不再累加，乘数上限 ×1.25） */
const TASK_LINK_CAP = 5;

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
  /** 文档创建时间（v1.55 时间序排序 + 时间窗过滤的 ORDER BY/WHERE 载体） */
  doc_created_at: string;
  section_position: number;
  heading_path: string | null;
  section_content: string;
  ts_rank_score: number;
  trgm_content_score: number;
  trgm_heading_score: number;
}

/** doc_routes 相似度查询行（raw row：PG 数值列经驱动返回 string） */
interface RouteSimilarityRow {
  id: string;
  primary_doc_id: string;
  secondary_doc_id: string | null;
  intent_similarity: string;
  category_similarity: string;
}

/** 单 doc 的路由加权结果：乘数 + 用于 boosts 透出的角色标签 */
interface RouteBoost {
  multiplier: number;
  label: 'primary' | 'secondary';
}

@Injectable()
export class DocSearchService {
  constructor(
    @InjectRepository(DocSection)
    private readonly sectionRepo: Repository<DocSection>,
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    @InjectRepository(DocRoute)
    private readonly routeRepo: Repository<DocRoute>,
    @InjectRepository(TaskDocLink)
    private readonly taskLinkRepo: Repository<TaskDocLink>,
  ) {}

  /**
   * Search documents within accessible spaces using dual scoring + intent fusion.
   *
   * Scoring:
   *   composite = ts_rank(search_vector, query) × TS_RANK(1.0)
   *             + similarity(content, query) × TRGM_CONTENT(0.6)
   *             + similarity(heading_path, query) × TRGM_HEADING(0.8)
   *   → SQL SCORE_FLOOR 过滤后，命中 doc 再叠加两路乘数（plan §4-C3 三路融合）：
   *     ① 策展路由命中：命中路由的 primaryDoc ×1.5 / secondaryDoc ×1.2（取最大不叠加）
   *     ② 任务链接数：×(1 + min(count, 5) × 0.05)，封顶 ×1.25
   *
   * Filtering:
   *   - Only spaces in accessibleSpaceIds
   *   - docs.deleted_at IS NULL
   *   - Optional type / tag / category filters
   *
   * Score floor: composite > SCORE_FLOOR (0.08) —
   *   filters zero-relevance noise that pg_trgm would otherwise pass through.
   *   ⚠️ 边界（plan §4 明文）：boost 在 floor 之后执行——只重排、不引入新结果；
   *   query 与 doc 内容零重叠但仅与路由 intent 重叠的 doc 不会召回，留待未来版本。
   *
   * Snippet:
   *   - ts_headline when ts_rank > 0
   *   - Fallback: matched substring ±150 chars, ≤300 chars total
   *
   * Sorting（v1.55 sort 接管语义）:
   *   - sort='relevance'（缺省，现有行为不变）：SQL ORDER BY score DESC, position ASC；
   *     boost 融合在 Node 侧应用并重排（页内重排——翻页时 boost 只重排当前页，
   *     不跨页搬移命中，与「boost 只重排、不引入新结果」边界一致）。
   *   - sort='createdAt_desc'/'createdAt_asc'：时间序**接管 ORDER BY**（docs.created_at
   *     + section_position ASC 平局兜底），双评分仅保留 SCORE_FLOOR 噪音过滤——
   *     boost 融合**仅适用相关度排序**，时间序下完全跳过（不查询、不应用、不透出
   *     boosts，score 保留 SQL 原始合成分）。理由：时间序的业务意图是「按时间穷尽
   *     遍历」（如读最近 N 天日记），策展/任务链接加权会破坏时间连续性且无意义。
   *
   * Time window（v1.55 createdAfter/createdBefore）: 过滤 docs.created_at，
   * 双侧**含边界**（>= / <=）——「最近 7 天」按 now-7d 取 createdAfter 时边界文档不丢。
   *
   * Pagination（v1.55 offset）: SQL OFFSET，与 limit 配对穷尽翻页；缺省 0。
   *
   * 可解释性：命中携带 boosts（route/taskLinks）透出加权来源；无 boost 省略该键
   * （时间序下恒省略）。
   *
   * @param accessibleSpaceIds - Whitelist from AccessQueryService (null = admin, all spaces)
   * @param query - Search parameters (q, type, tag, category, limit, offset, sort,
   *   createdAfter, createdBefore)
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
      offset?: number;
      sort?: DocSearchSort;
      createdAfter?: string;
      createdBefore?: string;
    },
  ): Promise<DocSearchHit[]> {
    const {
      q,
      type,
      tag,
      category,
      limit = DEFAULT_LIMIT,
      offset = 0,
      sort = 'relevance',
      createdAfter,
      createdBefore,
    } = query;
    const effectiveLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    // offset 防御性下钳 0（controller/DTO 层已拦格式，此处兜底 Service 直调）
    const effectiveOffset = Math.max(offset, 0);
    // 时间序接管 ORDER BY：boost 融合仅适用相关度排序（见方法注释）
    const sortByTime = sort === 'createdAt_desc' || sort === 'createdAt_asc';

    // Empty whitelist short-circuit (non-admin with zero accessible spaces)
    if (accessibleSpaceIds !== null && accessibleSpaceIds.length === 0) {
      return [];
    }

    // Dual-scoring subquery: per-section ts_rank + trgm(content) + trgm(headingPath),
    // wrapped so the composite score can be filtered (floor) and ordered as a column.
    const mainQb = this.sectionRepo.manager
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
          .addSelect('d.created_at', 'doc_created_at')
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
        // 时间窗过滤（v1.55）：双侧含边界（>= / <=）——参数为 ISO 8601 字符串，
        // PG timestamptz 列与 ISO 文本比较安全（DTO @IsISO8601 已拦格式，层 1）
        if (createdAfter) {
          sqb.andWhere('d.created_at >= :createdAfter', { createdAfter });
        }
        if (createdBefore) {
          sqb.andWhere('d.created_at <= :createdBefore', { createdBefore });
        }

        return sqb;
      }, 'sub')
      .where(
        `(sub.ts_rank_score * ${RANK_WEIGHTS.TS_RANK} + sub.trgm_content_score * ${RANK_WEIGHTS.TRGM_CONTENT} + sub.trgm_heading_score * ${RANK_WEIGHTS.TRGM_HEADING}) > :scoreFloor`,
        { scoreFloor: SCORE_FLOOR },
      )
      // 排序接管（v1.55 sort）：时间序按 docs.created_at（section_position ASC 平局兜底）；
      // 相关度（缺省）保持既有 score DESC, position ASC——boost 重排语义见方法注释
      .orderBy(
        sortByTime ? 'sub.doc_created_at' : 'score',
        sortByTime ? (sort === 'createdAt_desc' ? 'DESC' : 'ASC') : 'DESC',
      )
      .addOrderBy('sub.section_position', 'ASC')
      .limit(effectiveLimit);
    // 翻页（v1.55 offset）：仅在 >0 时附加，保持缺省查询计划与既有行为一致
    if (effectiveOffset > 0) {
      mainQb.offset(effectiveOffset);
    }
    const rows = await mainQb.getRawMany<SearchRow & { score: number }>();

    // ── 三路融合 boost（plan §4-C3）────────────────────────────────
    // 边界（plan §4 明文）：boost 在 SQL SCORE_FLOOR 过滤之后执行——只重排、不引入新结果
    // （query 与 doc 内容零重叠但仅与路由 intent 重叠的 doc 不会被召回，留待未来版本）。
    // 无命中直接短路，跳过两路 boost 查询。
    if (rows.length === 0) {
      return [];
    }

    // ── 时间序分支（v1.55）：ORDER BY 已由 SQL 按 created_at 接管，boost 融合
    //    仅适用相关度排序——时间序下跳过两路 boost 查询与 Node 侧重排，SQL 顺序
    //    即最终顺序（score 保留原始合成分，不透出 boosts）。
    if (sortByTime) {
      return Promise.all(rows.map((row) => this.buildHit(row, q)));
    }

    // ① 策展路由命中：命中路由的 primaryDocId ×1.5 / secondaryDocId ×1.2
    const routeBoosts = await this.computeRouteBoosts(accessibleSpaceIds, q);
    // ② 任务链接加权：×(1 + min(count, 5) × 0.05)，封顶 ×1.25（docId 去重防重复计数）
    const taskLinkCounts = await this.countTaskLinksByDoc([
      ...new Set(rows.map((row) => row.doc_id)),
    ]);

    // Build hits
    const hits: DocSearchHit[] = [];
    for (const row of rows) {
      const hit = await this.buildHit(row, q);

      // ③ 应用两路乘数并透出 boosts（可解释性：调用方知道结果为何排前）
      // 无任何 boost 的命中分数不变、boosts 键省略（taskLinks=0 视为无 boost——GROUP BY
      // 实际不会产出 0 行，此处为防御性语义）。
      const route = routeBoosts.get(row.doc_id);
      const taskLinks = taskLinkCounts.get(row.doc_id);
      const hasRoute = route !== undefined;
      const hasTaskLinks = taskLinks !== undefined && taskLinks > 0;
      if (hasRoute || hasTaskLinks) {
        if (hasRoute) {
          hit.score *= route.multiplier;
        }
        if (hasTaskLinks) {
          hit.score *= 1 + Math.min(taskLinks, TASK_LINK_CAP) * TASK_LINK_STEP;
        }
        hit.boosts = {};
        if (hasRoute) {
          hit.boosts.route = route.label;
        }
        if (hasTaskLinks) {
          hit.boosts.taskLinks = taskLinks;
        }
      }

      hits.push(hit);
    }

    // ④ 重排：boost 后按 score DESC、position ASC 重新排序（对齐既有 ORDER BY 语义；
    //    无 boost 时分数不变，JS sort 稳定 + position 平局兜底，顺序与 SQL 结果一致）
    hits.sort((a, b) => b.score - a.score || a.position - b.position);

    return hits;
  }

  /**
   * 由单条 SQL 行构建命中项（snippet 生成 + 字段投影，不含 boost）
   *
   * 相关度排序与时间序排序共用的命中构建管线：ts_rank > 0 走 ts_headline
   * （额外一次 SQL），否则 trgm 子串窗口。boost 乘数仅由相关度分支在此结果上叠加。
   *
   * @param row - 双评分子查询原始行（含合成分 score）
   * @param q - 检索词（ts_headline / trgm snippet 共用）
   */
  private async buildHit(row: SearchRow & { score: number }, q: string): Promise<DocSearchHit> {
    const hasTsMatch = Number(row.ts_rank_score) > 0;
    const snippet = hasTsMatch
      ? await this.buildTsHeadlineSnippet(row.doc_id, row.section_position, q)
      : this.buildTrgmSnippet(row.section_content, q);

    return {
      docId: row.doc_id,
      docPath: row.doc_path,
      docTitle: row.doc_title,
      position: Number(row.section_position),
      headingPath: row.heading_path ?? null,
      snippet: snippet.text,
      contentTruncated: snippet.truncated,
      score: Number(row.score),
    };
  }

  /**
   * 策展路由命中加权（plan §4-C3 三路融合之一）
   *
   * 一次 SQL 拉取查询空间全部路由及 PG `similarity()` 预计算分数——与正文检索同款函数，
   * 保证语义一致（单空间 ≤16 条规模，无索引压力），Node 侧按阈值过滤：
   * intent ≥ ROUTE_INTENT_FLOOR（0.15）或 category ≥ ROUTE_CATEGORY_FLOOR（0.3）即视为命中。
   * 命中路由的 primaryDocId → ×ROUTE_PRIMARY_BOOST（1.5）、secondaryDocId → ×ROUTE_SECONDARY_BOOST
   * （1.2）；同一 doc 同时被多条路由命中时取最大倍率（不叠加连乘，见 applyRouteBoost）。
   *
   * @param accessibleSpaceIds - 可访问空间白名单（null = admin，全量空间不过滤）
   * @param q - 检索词（与正文检索同参数，保证 similarity 打分一致）
   * @returns docId → { multiplier, label } 映射；未命中任何路由的 doc 不在映射中
   */
  private async computeRouteBoosts(
    accessibleSpaceIds: string[] | null,
    q: string,
  ): Promise<Map<string, RouteBoost>> {
    const boosts = new Map<string, RouteBoost>();

    const qb = this.routeRepo
      .createQueryBuilder('r')
      .select('r.id', 'id')
      .addSelect('r.primaryDocId', 'primary_doc_id')
      .addSelect('r.secondaryDocId', 'secondary_doc_id')
      .addSelect('similarity(r.intent, :q)', 'intent_similarity')
      .addSelect("similarity(COALESCE(r.category, ''), :q)", 'category_similarity')
      .setParameter('q', q);
    if (accessibleSpaceIds !== null) {
      qb.where('r.spaceId IN (:...spaceIds)', { spaceIds: accessibleSpaceIds });
    }
    const rows = await qb.getRawMany<RouteSimilarityRow>();

    for (const row of rows) {
      // 阈值过滤（≥ 判定，0.15/0.3 为边界值）：intent/category 任一达标即路由命中
      const intentSim = Number(row.intent_similarity);
      const categorySim = Number(row.category_similarity);
      if (intentSim < ROUTE_INTENT_FLOOR && categorySim < ROUTE_CATEGORY_FLOOR) {
        continue;
      }
      this.applyRouteBoost(boosts, row.primary_doc_id, ROUTE_PRIMARY_BOOST, 'primary');
      if (row.secondary_doc_id) {
        this.applyRouteBoost(boosts, row.secondary_doc_id, ROUTE_SECONDARY_BOOST, 'secondary');
      }
    }

    return boosts;
  }

  /**
   * 写入/覆盖单 doc 的路由加权（取最大倍率语义）
   *
   * 同一 doc 可能同时是路由 A 的 primary 与路由 B 的 secondary：若直接连乘，
   * 策展重复会虚高分数（1.5×1.2=1.8），故仅当新倍率更高时覆盖——plan §4-C3 明文。
   * label 与倍率一一对应（primary 1.5 > secondary 1.2，存谁 label 就是谁）。
   */
  private applyRouteBoost(
    boosts: Map<string, RouteBoost>,
    docId: string,
    multiplier: number,
    label: 'primary' | 'secondary',
  ): void {
    const current = boosts.get(docId);
    if (!current || multiplier > current.multiplier) {
      boosts.set(docId, { multiplier, label });
    }
  }

  /**
   * 任务链接加权（plan §4-C3 三路融合之二）
   *
   * 一把聚合查询：对 hits 涉及的 docId 集合按 doc 分组 COUNT(DISTINCT task_id)
   * （task_doc_links 裸 uuid 无 FK，按 docId 直接计数即可——docspace.service.countLinkedTasks
   * 同款先例）。乘数 = ×(1 + min(count, TASK_LINK_CAP) × TASK_LINK_STEP)，封顶 ×1.25。
   *
   * @param docIds - hits 涉及的 docId 集合（已去重，≤20 条）
   * @returns docId → 实际关联任务数（原始 COUNT 未封顶；无链接的 doc 不在映射中）
   */
  private async countTaskLinksByDoc(docIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (docIds.length === 0) {
      return counts;
    }
    const rows = await this.taskLinkRepo
      .createQueryBuilder('tdl')
      .select('tdl.docId', 'doc_id')
      .addSelect('COUNT(DISTINCT tdl.taskId)', 'c')
      .where('tdl.docId IN (:...docIds)', { docIds })
      .groupBy('tdl.docId')
      .getRawMany<{ doc_id: string; c: string }>();
    for (const row of rows) {
      counts.set(row.doc_id, Number(row.c));
    }
    return counts;
  }

  /**
   * Build ts_headline snippet for a specific section.
   * Falls back to trgm snippet if ts_headline returns empty.
   *
   * ts_headline options 语法铁律（PG 实测，bug 9082464c 教训）：
   * - options 串按**空白**拆分选项（不是按逗号）——`'StartSel=,StopSel='` 会被整体吞为
   *   StartSel 的值，`,StopSel=` 字面量混进 snippet（StopSel 落回默认 `</b>`）；
   * - 空值必须双引号包裹 `StartSel=""`——裸空值（即便空格分隔）报 invalid parameter list format；
   * - plainto_tsquery 显式传 'simple'，与 search() 双路打分 ts_rank 的 regconfig 一致，
   *   否则 default_text_search_config 漂移会导致高亮位置与打分 token 不对齐。
   */
  private async buildTsHeadlineSnippet(
    docId: string,
    position: number,
    q: string,
  ): Promise<{ text: string; truncated: boolean }> {
    const row = await this.sectionRepo.manager
      .createQueryBuilder()
      .select(
        "ts_headline('simple', s.content, plainto_tsquery('simple', :q), 'MaxWords=50, MaxFragments=2, StartSel=\"\", StopSel=\"\"')",
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
