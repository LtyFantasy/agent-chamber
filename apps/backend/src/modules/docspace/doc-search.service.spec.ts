import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocSearchService } from './doc-search.service';
import { DocSection } from '../../database/entities/doc-section.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { JudgmentRunnerService } from '../judgment/judgment-runner.service';
import * as zeroHitLog from '../../common/utils/search/zero-hit-log';
import { DOC_SEARCH_WEAK_HIT_SCORE } from '../../common/utils/search/search-tuning';
import {
  DOC_SEARCH_STRONG_HIT_SCORE,
  DOC_SEARCH_WEAK_HIT_HINT,
  DOC_SEARCH_ZERO_HIT_HINT,
} from '@agent-chamber/shared';

// ─── Mock helpers ──────────────────────────────────────────────

/** Create a chainable mock QueryBuilder */
function createMockQueryBuilder(overrides: Record<string, jest.Mock> = {}) {
  return {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/** Build a raw DB row matching SearchRow shape + score */
function makeRawRow(overrides: Record<string, unknown> = {}) {
  return {
    doc_id: 'doc-1',
    doc_path: 'docs/test.md',
    doc_title: 'Test Doc',
    section_position: 0,
    heading_path: 'Introduction',
    section_content: 'Some test content here for searching.',
    ts_rank_score: 0,
    trgm_content_score: 0,
    trgm_heading_score: 0,
    score: 0,
    ...overrides,
  };
}

/** Create a minimal mock Repository */
function createMockRepo<T extends object>() {
  const qb = createMockQueryBuilder();
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    create: jest.fn((x: unknown) => x),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    manager: {
      createQueryBuilder: jest.fn().mockReturnValue(createMockQueryBuilder()),
    },
  } as unknown as jest.Mocked<Repository<T>>;
}

// ─── Constants from the service (keep in sync) ─────────────────
const SCORE_FLOOR = 0.08;
const SNIPPET_MAX_CHARS = 300;
const DEFAULT_LIMIT = 5;

/** Build a doc_routes similarity raw row (PG numeric columns come back as string) */
function makeRouteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'route-1',
    primary_doc_id: 'doc-1',
    secondary_doc_id: null,
    intent_similarity: '0.5',
    category_similarity: '0',
    ...overrides,
  };
}

/** Build a task_doc_links COUNT raw row */
function makeTaskLinkRow(docId: string, count: number) {
  return { doc_id: docId, c: String(count) };
}

describe('DocSearchService', () => {
  let service: DocSearchService;
  let mockSectionRepo: jest.Mocked<Repository<DocSection>>;
  let mockDocRepo: jest.Mocked<Repository<Doc>>;
  let mockRouteRepo: jest.Mocked<Repository<DocRoute>>;
  let mockTaskLinkRepo: jest.Mocked<Repository<TaskDocLink>>;

  // The subquery mock — captured by the outer QB's `from` factory
  let mockSubQb: ReturnType<typeof createMockQueryBuilder>;
  // The outer QB returned by manager.createQueryBuilder() (main query)
  let mockOuterQb: ReturnType<typeof createMockQueryBuilder>;
  // The typed QB returned by sectionRepo.createQueryBuilder('s')
  let mockTypedQb: ReturnType<typeof createMockQueryBuilder>;
  // The QBs returned by routeRepo / taskLinkRepo.createQueryBuilder (三路融合 boost 查询)
  let mockRouteQb: ReturnType<typeof createMockQueryBuilder>;
  let mockTaskLinkQb: ReturnType<typeof createMockQueryBuilder>;

  /**
   * 判别重排编排器 mock（v1.85.0 批次 3）：**默认未启用**（`isEnabled` 恒 false）——
   * 既有用例因此全部走原路径，断言与未接入判别前逐字节一致。
   */
  let judgment: {
    isEnabled: jest.Mock;
    run: jest.Mock;
    recordSkip: jest.Mock;
  };

  beforeEach(async () => {
    // ── Subquery mock ──
    mockSubQb = createMockQueryBuilder();

    // ── Outer query builder (manager.createQueryBuilder() — 1st call) ──
    mockOuterQb = createMockQueryBuilder();
    // Override `from` to invoke the subquery factory with our mockSubQb
    (mockOuterQb.from as jest.Mock).mockImplementation((factoryFn: any, alias: string) => {
      factoryFn(mockSubQb);
      return mockOuterQb;
    });

    // ── Typed query builder (sectionRepo.createQueryBuilder('s')) ──
    mockTypedQb = createMockQueryBuilder();

    // ── 三路融合 boost 查询 builders（routeRepo / taskLinkRepo）──
    mockRouteQb = createMockQueryBuilder();
    mockTaskLinkQb = createMockQueryBuilder();

    // ── Create repos ──
    const sectionRepoPair = createMockRepo<DocSection>();
    mockSectionRepo = sectionRepoPair;
    // Override createQueryBuilder to return the typed QB
    (mockSectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(mockTypedQb);
    // manager.createQueryBuilder returns different QBs per call
    (mockSectionRepo.manager.createQueryBuilder as jest.Mock).mockReturnValue(mockOuterQb);

    const docRepoPair = createMockRepo<Doc>();
    mockDocRepo = docRepoPair;

    const routeRepoPair = createMockRepo<DocRoute>();
    mockRouteRepo = routeRepoPair;
    (mockRouteRepo.createQueryBuilder as jest.Mock).mockReturnValue(mockRouteQb);

    const taskLinkRepoPair = createMockRepo<TaskDocLink>();
    mockTaskLinkRepo = taskLinkRepoPair;
    (mockTaskLinkRepo.createQueryBuilder as jest.Mock).mockReturnValue(mockTaskLinkQb);

    // 判别重排编排器：缺省未启用（能力未开）——用例按需打开并注入逐候选档位
    judgment = {
      isEnabled: jest.fn().mockReturnValue(false),
      run: jest.fn().mockResolvedValue({ status: 'disabled' }),
      recordSkip: jest.fn().mockResolvedValue(true),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DocSearchService,
        { provide: getRepositoryToken(DocSection), useValue: mockSectionRepo },
        { provide: getRepositoryToken(Doc), useValue: mockDocRepo },
        { provide: getRepositoryToken(DocRoute), useValue: mockRouteRepo },
        { provide: getRepositoryToken(TaskDocLink), useValue: mockTaskLinkRepo },
        // 判别重排的编排器（v1.85.0 批次 3）：默认**未启用** ⇒ 既有用例全走原路径
        // （与未接入判别前的行为逐字节一致——这正是"重排是可选增强"的验证基础）
        { provide: JudgmentRunnerService, useValue: judgment },
      ],
    }).compile();

    service = moduleRef.get<DocSearchService>(DocSearchService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── Test 1: Chinese hit (trgm) ──────────────────────────────
  it('should return hits for Chinese (trgm) matches when ts_rank is zero', async () => {
    // ts_rank=0, trgm_content=0.2 => score = 0 + 0.2*0.6 + 0 = 0.12 (>0.08)
    const rawRows = [
      makeRawRow({
        ts_rank_score: 0,
        trgm_content_score: 0.2,
        trgm_heading_score: 0,
        score: 0.12,
      }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    const { hits } = await service.search(['space-1'], { q: '搜索' });

    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].docId).toBe('doc-1');
    // trgm snippet (not ts_headline) — should come from buildTrgmSnippet
    expect(hits[0].snippet).toBeTruthy();
    expect(hits[0].contentTruncated).toBe(false);
  });

  // ─── Test 2: English hit (ts) ────────────────────────────────
  it('should return hits for English (ts) matches with ts_headline snippet', async () => {
    // ts_rank=0.15, trgm=0 => score = 0.15*1.0 = 0.15
    const rawRows = [
      makeRawRow({
        ts_rank_score: 0.15,
        trgm_content_score: 0,
        trgm_heading_score: 0,
        score: 0.15,
        section_content: 'This is the full section content for testing.',
      }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    // The ts_headline query builder (2nd manager.createQueryBuilder call)
    const mockHeadlineQb = createMockQueryBuilder({
      getRawOne: jest
        .fn()
        .mockResolvedValue({ headline: 'This is the <b>full</b> section content.' }),
    });
    (mockSectionRepo.manager.createQueryBuilder as jest.Mock)
      .mockReturnValueOnce(mockOuterQb)
      .mockReturnValueOnce(mockHeadlineQb);

    const { hits } = await service.search(['space-1'], { q: 'full' });

    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].snippet).toBe('This is the <b>full</b> section content.');
  });

  // ─── Test 2b: ts_headline options 串语法（bug 9082464c 回归）─────
  it('builds ts_headline with double-quoted empty sels and explicit simple regconfig', async () => {
    const rawRows = [makeRawRow({ ts_rank_score: 0.15, score: 0.15 })];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    const mockHeadlineQb = createMockQueryBuilder({
      getRawOne: jest.fn().mockResolvedValue({ headline: 'clean snippet' }),
    });
    (mockSectionRepo.manager.createQueryBuilder as jest.Mock)
      .mockReturnValueOnce(mockOuterQb)
      .mockReturnValueOnce(mockHeadlineQb);

    await service.search(['space-1'], { q: 'test' });

    // PG 实测（bug 9082464c）：options 串按空白拆分而非逗号——`'StartSel=,StopSel='`
    // 会被吞为 StartSel 的值（`,StopSel=` 残渣）；空值必须双引号包裹。
    const headlineSql = (mockHeadlineQb.select as jest.Mock).mock.calls[0][0] as string;
    expect(headlineSql).toContain('StartSel="", StopSel=""');
    // v1.86 中文根治：headline 作用于**单字化文本**（原文 CJK 巨 token 零高亮），
    // tsquery 经 `:compiledQ` 绑定下发（regconfig 仍显式 'simple'，与打分通道一致）
    expect(headlineSql).toContain(
      `ts_headline('simple', cjk_unigram_text(s.content), to_tsquery('simple', :compiledQ)`,
    );
  });

  // ─── Test 3: Mixed scoring sorts by composite score DESC ─────
  it('should sort results by composite score in descending order', async () => {
    const rawRows = [
      makeRawRow({ doc_id: 'doc-a', score: 0.5, ts_rank_score: 0, trgm_content_score: 0.5 / 0.6 }),
      makeRawRow({ doc_id: 'doc-c', score: 0.15, ts_rank_score: 0.15, trgm_content_score: 0 }),
      makeRawRow({
        doc_id: 'doc-b',
        score: 1.2,
        ts_rank_score: 1.0,
        trgm_content_score: 0.2 / 0.6,
      }),
    ];
    // getRawMany already returns them in DB order (ORDER BY is in SQL). Since neither
    // route nor task-link boosts apply in this test, the post-boost re-sort is a no-op —
    // order is preserved (JS sort is stable + position tiebreak). We just verify getRawMany was called.
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    const mockHeadlineQb = createMockQueryBuilder({
      getRawOne: jest.fn().mockResolvedValue({ headline: 'snippet' }),
    });
    (mockSectionRepo.manager.createQueryBuilder as jest.Mock)
      .mockReturnValueOnce(mockOuterQb)
      .mockReturnValueOnce(mockHeadlineQb)
      .mockReturnValueOnce(mockHeadlineQb)
      .mockReturnValueOnce(mockHeadlineQb);

    const { hits } = await service.search(['space-1'], { q: 'test' });

    expect(hits).toHaveLength(3);
    // Since DB does ORDER BY score DESC, rows are passed through as-is
    expect(mockOuterQb.orderBy).toHaveBeenCalledWith('score', 'DESC');
  });

  // ─── Test 4: Score floor filters zero-relevance docs ─────────
  it('should filter out rows with composite score ≤ 0.08', async () => {
    // Only one row passes the floor
    const rawRows = [
      makeRawRow({ doc_id: 'doc-keep', score: 0.09, ts_rank_score: 0, trgm_content_score: 0.15 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    const { hits } = await service.search(['space-1'], { q: 'noise' });

    expect(hits).toHaveLength(1);
    expect(hits[0].docId).toBe('doc-keep');

    // Verify the WHERE clause includes the score floor
    expect(mockOuterQb.where).toHaveBeenCalledWith(
      expect.stringContaining(`> :scoreFloor`),
      expect.objectContaining({ scoreFloor: SCORE_FLOOR }),
    );
  });

  // ─── Test 5: Tag filter ──────────────────────────────────────
  it('should add tag filter to subquery WHERE clause', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test', tag: 'combat' });

    // Verify subquery includes tag condition
    expect(mockSubQb.andWhere).toHaveBeenCalledWith(':tagVal = ANY(d.tags)', { tagVal: 'combat' });
  });

  // ─── Test 6: Type filter ─────────────────────────────────────
  it('should add type filter to subquery WHERE clause', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test', type: 'architecture' });

    // Verify subquery includes type condition
    expect(mockSubQb.andWhere).toHaveBeenCalledWith('d.doc_type = :docType', {
      docType: 'architecture',
    });
  });

  // ─── Test 7: Snippet ≤ 300 chars + contentTruncated ──────────
  it('should truncate snippets longer than 300 chars and set contentTruncated', async () => {
    const rawRows = [
      makeRawRow({
        ts_rank_score: 0.15,
        trgm_content_score: 0,
        score: 0.15,
      }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    // ts_headline returns a very long string (>300 chars)
    const longHeadline = 'x'.repeat(500);
    const mockHeadlineQb = createMockQueryBuilder({
      getRawOne: jest.fn().mockResolvedValue({ headline: longHeadline }),
    });
    (mockSectionRepo.manager.createQueryBuilder as jest.Mock)
      .mockReturnValueOnce(mockOuterQb)
      .mockReturnValueOnce(mockHeadlineQb);

    const { hits } = await service.search(['space-1'], { q: 'test' });

    expect(hits).toHaveLength(1);
    expect(hits[0].snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(hits[0].snippet).toBe(longHeadline.slice(0, SNIPPET_MAX_CHARS));
    expect(hits[0].contentTruncated).toBe(true);
  });

  // ─── Test 8: No sectionId in response ────────────────────────
  it('should not expose sectionId in returned hits', async () => {
    const rawRows = [
      makeRawRow({
        ts_rank_score: 0,
        trgm_content_score: 0.2,
        score: 0.12,
      }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    const { hits } = await service.search(['space-1'], { q: 'test' });

    expect(hits).toHaveLength(1);
    // Must NOT contain sectionId
    expect(hits[0]).not.toHaveProperty('sectionId');
    // Must contain the declared DocSearchHit fields
    expect(hits[0]).toHaveProperty('docId');
    expect(hits[0]).toHaveProperty('docPath');
    expect(hits[0]).toHaveProperty('docTitle');
    expect(hits[0]).toHaveProperty('position');
    expect(hits[0]).toHaveProperty('headingPath');
    expect(hits[0]).toHaveProperty('snippet');
    expect(hits[0]).toHaveProperty('score');
    expect(hits[0]).toHaveProperty('contentTruncated');
  });

  // ─── Test 9: Empty space whitelist returns empty array ───────
  it('should return empty array immediately when accessibleSpaceIds is empty', async () => {
    const { hits } = await service.search([], { q: 'test' });

    expect(hits).toEqual([]);
    // createQueryBuilder('s') IS called before the empty check (line 127)
    // but manager.createQueryBuilder (the actual query) must NOT be called
    expect(mockSectionRepo.manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  // ─── Test 10: Admin null whitelist searches all ──────────────
  it('should not add space filter when accessibleSpaceIds is null (admin)', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(null, { q: 'test' });

    // Subquery should NOT have an IN filter on space_id
    const spaceFilterCalls = (mockSubQb.andWhere as jest.Mock).mock.calls.filter(
      (call: string[]) => typeof call[0] === 'string' && call[0].includes('space_id'),
    );
    expect(spaceFilterCalls).toHaveLength(0);
  });

  // ─── Test 11: Default limit of 5 ─────────────────────────────
  it('should default to limit 5 when limit is not specified', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test' });

    // The outer query should have limit(5) (effectiveLimit = DEFAULT_LIMIT)
    expect(mockOuterQb.limit).toHaveBeenCalledWith(DEFAULT_LIMIT);
  });

  // ─── Test 12: Category filter ─────────────────────────────────
  it('should add category filter to subquery WHERE clause', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test', category: 'architecture' });

    // Verify subquery includes category condition
    expect(mockSubQb.andWhere).toHaveBeenCalledWith('dc.slug = :catSlug', {
      catSlug: 'architecture',
    });
  });

  // ─── Bonus: Space whitelist with IDs adds IN filter ──────────
  it('should add space IN filter when accessibleSpaceIds is provided', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1', 'space-2'], { q: 'test' });

    // Subquery should have IN filter on space_id
    expect(mockSubQb.andWhere).toHaveBeenCalledWith('d.space_id IN (:...spaceIds)', {
      spaceIds: ['space-1', 'space-2'],
    });
  });

  // ─── Bonus: Trgm fallback snippet for non-English matches ────
  it('should build trgm snippet for non-ts matches (Chinese)', async () => {
    const content = '这是一段测试内容，用于验证中文搜索片段生成功能。';
    const rawRows = [
      makeRawRow({
        ts_rank_score: 0,
        trgm_content_score: 0.2,
        score: 0.12,
        section_content: content,
      }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    const { hits } = await service.search(['space-1'], { q: '中文搜索' });

    expect(hits).toHaveLength(1);
    // snippet should be built from content via buildTrgmSnippet (not ts_headline)
    expect(hits[0].snippet.length).toBeGreaterThan(0);
    // manager.createQueryBuilder should NOT have been called a second time
    // (it was called once for the outer query, zero times for ts_headline)
    expect(mockSectionRepo.manager.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  // ─── 三路融合 boost（plan §4-C3）───────────────────────────────

  it('should boost primaryDocId hits by ×1.5 and expose boosts.route=primary', async () => {
    const rawRows = [makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 })];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // doc-1 是命中路由（intent 0.5 ≥ 0.15）的 primaryDoc
    mockRouteQb.getRawMany.mockResolvedValue([makeRouteRow()]);

    const { hits } = await service.search(['space-1'], { q: '架构' });

    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeCloseTo(0.2 * 1.5, 6);
    expect(hits[0].boosts).toEqual({ route: 'primary' });
    // 路由查询限定在可访问空间内
    expect(mockRouteQb.where).toHaveBeenCalledWith('r.spaceId IN (:...spaceIds)', {
      spaceIds: ['space-1'],
    });
  });

  it('should boost secondaryDocId hits by ×1.2 and expose boosts.route=secondary', async () => {
    const rawRows = [makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 })];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // doc-1 是命中路由（intent 0.4 ≥ 0.15）的 secondaryDoc
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({
        primary_doc_id: 'doc-other',
        secondary_doc_id: 'doc-1',
        intent_similarity: '0.4',
      }),
    ]);

    const { hits } = await service.search(['space-1'], { q: '再看' });

    expect(hits[0].score).toBeCloseTo(0.2 * 1.2, 6);
    expect(hits[0].boosts).toEqual({ route: 'secondary' });
  });

  it('route threshold: intent 0.14 misses (no boost), 0.15 hits (×1.5, ≥ semantics)', async () => {
    const rawRows = [makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 })];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    // 0.14 < ROUTE_INTENT_FLOOR(0.15) → 不命中
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ intent_similarity: '0.14', category_similarity: '0' }),
    ]);
    let { hits } = await service.search(['space-1'], { q: '边界' });
    expect(hits[0].score).toBeCloseTo(0.2, 6);
    expect(hits[0].boosts).toBeUndefined();

    // 0.15 = ROUTE_INTENT_FLOOR → 命中（≥ 判定，边界值必须命中）
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ intent_similarity: '0.15', category_similarity: '0' }),
    ]);
    ({ hits } = await service.search(['space-1'], { q: '边界' }));
    expect(hits[0].score).toBeCloseTo(0.2 * 1.5, 6);
    expect(hits[0].boosts).toEqual({ route: 'primary' });
  });

  it('route threshold: category 0.29 misses, 0.3 hits (intent can be zero)', async () => {
    const rawRows = [makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 })];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    // 0.29 < ROUTE_CATEGORY_FLOOR(0.3) 且 intent=0 → 不命中
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ intent_similarity: '0', category_similarity: '0.29' }),
    ]);
    let { hits } = await service.search(['space-1'], { q: '分类' });
    expect(hits[0].boosts).toBeUndefined();

    // 0.3 = ROUTE_CATEGORY_FLOOR → 命中（category 单独达标即命中）
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ intent_similarity: '0', category_similarity: '0.3' }),
    ]);
    ({ hits } = await service.search(['space-1'], { q: '分类' }));
    expect(hits[0].score).toBeCloseTo(0.2 * 1.5, 6);
    expect(hits[0].boosts).toEqual({ route: 'primary' });
  });

  it('multiple routes hitting the same doc take the max multiplier (no stacking)', async () => {
    const rawRows = [
      makeRawRow({ doc_id: 'doc-1', ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
      makeRawRow({ doc_id: 'doc-2', ts_rank_score: 0, trgm_content_score: 0.3 / 0.6, score: 0.3 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // doc-1：route A 的 primary（×1.5）+ route B 的 secondary（×1.2）→ 取 1.5，绝不叠加 1.8
    // doc-2：route A 的 secondary（×1.2）
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({
        id: 'r1',
        primary_doc_id: 'doc-1',
        secondary_doc_id: 'doc-2',
        intent_similarity: '0.5',
      }),
      makeRouteRow({
        id: 'r2',
        primary_doc_id: 'doc-3',
        secondary_doc_id: 'doc-1',
        intent_similarity: '0.4',
      }),
    ]);

    const { hits } = await service.search(['space-1'], { q: '架构' });

    const doc1 = hits.find((h) => h.docId === 'doc-1')!;
    const doc2 = hits.find((h) => h.docId === 'doc-2')!;
    expect(doc1.score).toBeCloseTo(0.2 * 1.5, 6);
    expect(doc1.boosts).toEqual({ route: 'primary' });
    expect(doc2.score).toBeCloseTo(0.3 * 1.2, 6);
    expect(doc2.boosts).toEqual({ route: 'secondary' });
  });

  it('task-link multiplier follows min(count,5)×0.05 ladder with cap at ×1.25', async () => {
    const rawRows = [
      makeRawRow({ doc_id: 'doc-3', ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
      makeRawRow({ doc_id: 'doc-5', ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
      makeRawRow({ doc_id: 'doc-8', ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
      makeRawRow({ doc_id: 'doc-0', ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // c=3 → ×1.15；c=5 → ×1.25；c=8 → ×1.25（封顶）；doc-0 无链接 → 无 boost
    mockTaskLinkQb.getRawMany.mockResolvedValue([
      makeTaskLinkRow('doc-3', 3),
      makeTaskLinkRow('doc-5', 5),
      makeTaskLinkRow('doc-8', 8),
    ]);

    const { hits } = await service.search(['space-1'], { q: '任务' });

    const byId = (id: string) => hits.find((h) => h.docId === id)!;
    expect(byId('doc-3').score).toBeCloseTo(0.2 * 1.15, 6);
    expect(byId('doc-3').boosts).toEqual({ taskLinks: 3 });
    expect(byId('doc-5').score).toBeCloseTo(0.2 * 1.25, 6);
    expect(byId('doc-5').boosts).toEqual({ taskLinks: 5 });
    expect(byId('doc-8').score).toBeCloseTo(0.2 * 1.25, 6); // 封顶
    expect(byId('doc-8').boosts).toEqual({ taskLinks: 8 }); // 透出实际 count（未封顶）
    expect(byId('doc-0').score).toBeCloseTo(0.2, 6);
    expect(byId('doc-0').boosts).toBeUndefined();
    // 聚合查询按 docId 集合一把 COUNT（去重后传入）
    expect(mockTaskLinkQb.where).toHaveBeenCalledWith('tdl.docId IN (:...docIds)', {
      docIds: ['doc-3', 'doc-5', 'doc-8', 'doc-0'],
    });
    expect(mockTaskLinkQb.groupBy).toHaveBeenCalledWith('tdl.docId');
  });

  it('boost only re-ranks: hit set after boost equals hit set from SQL (floor already applied)', async () => {
    const rawRows = [
      makeRawRow({ doc_id: 'doc-keep', ts_rank_score: 0, trgm_content_score: 0.15, score: 0.09 }),
      makeRawRow({
        doc_id: 'doc-top',
        ts_rank_score: 0,
        trgm_content_score: 0.2 / 0.6,
        score: 0.2,
      }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // doc-keep 是命中路由 primary（0.09×1.5=0.135）——boost 只重排，不得增加/移除命中
    mockRouteQb.getRawMany.mockResolvedValue([makeRouteRow({ primary_doc_id: 'doc-keep' })]);

    const { hits } = await service.search(['space-1'], { q: 'noise' });

    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.docId).sort()).toEqual(['doc-keep', 'doc-top']);
    // doc-top(0.2) 仍居首（boost 后 doc-keep 0.135 未反超）
    expect(hits[0].docId).toBe('doc-top');
  });

  it('omits boosts key when no route or task-link boost applies', async () => {
    const rawRows = [makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2, score: 0.12 })];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // 路由与任务链接均无命中（默认空结果）

    const { hits } = await service.search(['space-1'], { q: 'plain' });

    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toHaveProperty('boosts');
    expect(hits[0].score).toBeCloseTo(0.12, 6);
  });

  it('exposes both route and taskLinks keys when both boosts apply', async () => {
    const rawRows = [makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 })];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    mockRouteQb.getRawMany.mockResolvedValue([makeRouteRow()]);
    mockTaskLinkQb.getRawMany.mockResolvedValue([makeTaskLinkRow('doc-1', 2)]);

    const { hits } = await service.search(['space-1'], { q: '架构' });

    expect(hits[0].score).toBeCloseTo(0.2 * 1.5 * 1.1, 6); // 1.5 × (1 + 2×0.05)
    expect(hits[0].boosts).toEqual({ route: 'primary', taskLinks: 2 });
  });

  it('re-sorts ties by position ASC after boost (same final score)', async () => {
    const rawRows = [
      makeRawRow({
        doc_id: 'doc-a',
        section_position: 1,
        ts_rank_score: 0,
        trgm_content_score: 0.2 / 0.6,
        score: 0.2,
      }),
      makeRawRow({
        doc_id: 'doc-b',
        section_position: 0,
        ts_rank_score: 0,
        trgm_content_score: 0.2 / 0.6,
        score: 0.2,
      }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // 无 boost，同分 → position ASC（SQL 结果序 doc-a 在前，重排后 doc-b 在前）

    const { hits } = await service.search(['space-1'], { q: 'tie' });

    expect(hits.map((h) => h.docId)).toEqual(['doc-b', 'doc-a']);
  });

  it('re-ranks hits by boosted score DESC (boosted doc overtakes higher base score)', async () => {
    const rawRows = [
      makeRawRow({
        doc_id: 'doc-plain',
        ts_rank_score: 0,
        trgm_content_score: 0.2 / 0.6,
        score: 0.2,
      }),
      makeRawRow({
        doc_id: 'doc-boost',
        ts_rank_score: 0,
        trgm_content_score: 0.17 / 0.6,
        score: 0.17,
      }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // doc-boost 是命中路由 primary：0.17 × 1.5 = 0.255 > 0.2 → 反超 doc-plain
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ primary_doc_id: 'doc-boost', intent_similarity: '0.5' }),
    ]);

    const { hits } = await service.search(['space-1'], { q: '架构' });

    expect(hits.map((h) => h.docId)).toEqual(['doc-boost', 'doc-plain']);
    expect(hits[0].score).toBeCloseTo(0.255, 5);
  });

  it('does not filter routes by space when accessibleSpaceIds is null (admin)', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([
      makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ]);
    mockRouteQb.getRawMany.mockResolvedValue([makeRouteRow()]);

    const { hits } = await service.search(null, { q: '架构' });

    expect(mockRouteQb.where).not.toHaveBeenCalled();
    expect(hits[0].score).toBeCloseTo(0.3, 6);
    expect(hits[0].boosts).toEqual({ route: 'primary' });
  });

  it('skips route/task-link boost queries when no hits pass the floor', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    const { hits } = await service.search(['space-1'], { q: 'nothing' });

    expect(hits).toEqual([]);
    expect(mockRouteRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(mockTaskLinkRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  // ─── v1.55：offset 翻页 ──────────────────────────────────────

  it('applies SQL OFFSET when offset > 0 (paired with limit for exhaustive pagination)', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test', offset: 20, limit: 5 });

    expect(mockOuterQb.offset).toHaveBeenCalledWith(20);
    expect(mockOuterQb.limit).toHaveBeenCalledWith(5);
  });

  it('does NOT call offset() when offset is omitted or 0 (keeps default query plan)', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test' });
    await service.search(['space-1'], { q: 'test', offset: 0 });

    expect(mockOuterQb.offset).not.toHaveBeenCalled();
  });

  it('clamps negative offset to 0 defensively (service-level floor)', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test', offset: -5 });

    expect(mockOuterQb.offset).not.toHaveBeenCalled();
  });

  // ─── v1.55：时间窗过滤 createdAfter/createdBefore（含边界）───

  it('adds createdAfter/createdBefore inclusive filters to the subquery WHERE', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], {
      q: 'test',
      createdAfter: '2026-08-08T00:00:00.000Z',
      createdBefore: '2026-08-15T23:59:59.999Z',
    });

    expect(mockSubQb.andWhere).toHaveBeenCalledWith('d.created_at >= :createdAfter', {
      createdAfter: '2026-08-08T00:00:00.000Z',
    });
    expect(mockSubQb.andWhere).toHaveBeenCalledWith('d.created_at <= :createdBefore', {
      createdBefore: '2026-08-15T23:59:59.999Z',
    });
  });

  it('omits time-window filters when neither bound is provided', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test' });

    const timeCalls = (mockSubQb.andWhere as jest.Mock).mock.calls.filter(
      (call: string[]) => typeof call[0] === 'string' && call[0].includes('d.created_at'),
    );
    expect(timeCalls).toHaveLength(0);
  });

  // ─── v1.55：sort 接管语义（时间序 vs 相关度）────────────────

  it('sort=createdAt_desc takes over ORDER BY (doc_created_at DESC) and skips boost fusion entirely', async () => {
    // 时间序下 boost 查询不得执行——即便有命中（SQL 顺序即最终顺序，score 保留原始合成分）
    mockOuterQb.getRawMany.mockResolvedValue([
      makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ]);

    const { hits } = await service.search(['space-1'], { q: 'test', sort: 'createdAt_desc' });

    expect(mockOuterQb.orderBy).toHaveBeenCalledWith('sub.doc_created_at', 'DESC');
    expect(mockOuterQb.addOrderBy).toHaveBeenCalledWith('sub.section_position', 'ASC');
    // boost 融合仅适用相关度排序：路由/任务链接查询被完全跳过
    expect(mockRouteRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(mockTaskLinkRepo.createQueryBuilder).not.toHaveBeenCalled();
    // 命中透出但无 boosts 键（时间序下恒省略）
    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toHaveProperty('boosts');
    expect(hits[0].score).toBeCloseTo(0.2, 6);
  });

  it('sort=createdAt_asc takes over ORDER BY (doc_created_at ASC)', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test', sort: 'createdAt_asc' });

    expect(mockOuterQb.orderBy).toHaveBeenCalledWith('sub.doc_created_at', 'ASC');
    expect(mockRouteRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('sort=relevance (default) keeps score DESC ordering and runs boost fusion', async () => {
    const rawRows = [
      makeRawRow({ doc_id: 'doc-1', ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // 路由查询执行（即使无命中路由——查询照发，Node 侧阈值过滤）
    mockRouteQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test', sort: 'relevance' });

    expect(mockOuterQb.orderBy).toHaveBeenCalledWith('score', 'DESC');
    expect(mockRouteRepo.createQueryBuilder).toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 零命中日志 + 弱命中线（计划 §2.6 四路之一；主脑裁决 R4）
  // ═══════════════════════════════════════════════════════════════════════

  describe('零命中日志与弱命中线', () => {
    it('零命中分支落 logSearchZeroHit（surface=doc）+ 零命中 hint', async () => {
      const spy = jest.spyOn(zeroHitLog, 'logSearchZeroHit');
      try {
        mockOuterQb.getRawMany.mockResolvedValue([]);

        const res = await service.search(['space-1'], { q: '端口映射失效' });

        expect(res.hits).toEqual([]);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toMatchObject({
          surface: 'doc',
          query: '端口映射失效',
        });
        expect(res.hint).toBe(DOC_SEARCH_ZERO_HIT_HINT);
      } finally {
        spy.mockRestore();
      }
    });

    it('弱命中线读**现构** DOC_SEARCH_WEAK_HIT_SCORE（= 基准 0.3 × W1，R4）+ 独立 hint/hintCode', async () => {
      // 旧口径直读基准 0.3：W1=3 时 cd 单点恰好 0.3 ⇒ `0.3 < 0.3` 为假 ⇒ 弱命中分支整体失效
      // （1-d1 实测 3~4 条 → 0 条）。故取现构线的两侧各测一次：线内触发、线外不触发。
      const atScore = async (score: number) => {
        mockOuterQb.getRawMany.mockResolvedValue([makeRawRow({ score })]);
        return service.search(['space-1'], { q: '端口映射失效' });
      };

      // 线内：弱命中 ⇒ **独立文案**（v1.89.0-dev 批次 A：不再复用零命中文案）+ hintCode
      const weak = await atScore(DOC_SEARCH_WEAK_HIT_SCORE * 0.5);
      expect(weak.hint).toBe(DOC_SEARCH_WEAK_HIT_HINT);
      expect(weak.hintCode).toBe('weak_hit');
      expect(DOC_SEARCH_WEAK_HIT_HINT).not.toBe(DOC_SEARCH_ZERO_HIT_HINT);

      // 线外：强命中 ⇒ hint / hintCode 两个键都不出现（additive 契约，禁 null）
      const strong = await atScore(DOC_SEARCH_WEAK_HIT_SCORE * 1.5);
      expect(Object.keys(strong)).toEqual(['hits']);

      // 前提自证：现构线必须**高于**基准线（否则本用例退化成旧口径的等价物）
      expect(DOC_SEARCH_WEAK_HIT_SCORE).toBeGreaterThan(DOC_SEARCH_STRONG_HIT_SCORE);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 判别重排（v1.85.0 批次 3）：只在"能力启用 + agent + relevance + 窗口内 + 池非空 +
  // 可见性全 open"时启用；其余一切结局都走原路径（逐字节一致）
  // ═══════════════════════════════════════════════════════════════════════
  describe('判别重排（agent + 能力启用）', () => {
    const AGENT = { id: 'agent-1', type: 'agent' } as never;
    const HUMAN = { id: 'human-1', type: 'human' } as never;

    /** 池：8 条（limit=5 ⇒ poolSize=15，池不满）；score 递减，便于断言 SQL 序 */
    function poolRows(overrides: (index: number) => Record<string, unknown> = () => ({})) {
      return Array.from({ length: 8 }, (_, index) =>
        makeRawRow({
          doc_id: `doc-${index}`,
          doc_path: `docs/${index}.md`,
          doc_title: `Doc ${index}`,
          section_position: index,
          // ts_rank=0 ⇒ 走 trgm snippet 路径（**不触发 ts_headline 的额外 SQL**：mock 的
          // `from` 被覆写成"工厂函数"形态，字符串 from 会炸——既有用例同款约定）
          ts_rank_score: 0,
          trgm_content_score: 0.2,
          trgm_heading_score: 0,
          score: 1 - index / 10, // 递减：SQL 序 = doc-0..doc-7
          ...overrides(index),
        }),
      );
    }

    beforeEach(() => {
      judgment.isEnabled.mockReturnValue(true);
      mockRouteQb.getRawMany.mockResolvedValue([]);
      mockTaskLinkQb.getRawMany.mockResolvedValue([]);
    });

    it('启用且成功：按模型档位重排返回页 + reranked:true + 条数与 SQL 序相等', async () => {
      mockOuterQb.getRawMany.mockResolvedValue(poolRows());
      // 页外（i≥5）给最高档，页内给最低档 ⇒ 位置带允许页外进页尾 3 槽
      judgment.run.mockResolvedValue({
        status: 'ok',
        value: { tiers: [0, 0, 0, 0, 0, 3, 3, 3] },
        meta: { provider: 'typesafe', model: 'm', judgedAt: 'now', rubricVersion: 'v1' },
      });

      const { hits } = await service.search(['space-1'], { q: 'test', limit: 5 }, { actor: AGENT });

      expect(hits.map((hit) => hit.docId)).toEqual(['doc-0', 'doc-1', 'doc-5', 'doc-6', 'doc-7']);
      expect(hits).toHaveLength(5); // 与 SQL 序路径条数相等
      expect(hits.every((hit) => hit.reranked === true)).toBe(true);
      expect(judgment.run).toHaveBeenCalledTimes(1);
      // 能力名与身份都透传正确（能力=rerank；身份=agent）
      const [capability, , actor] = judgment.run.mock.calls[0];
      expect(capability.name).toBe('rerank');
      expect(actor).toBe(AGENT);
    });

    it('provider 失败 ⇒ fail-open 回**原路径**（与人类同结果，无 reranked 标记）', async () => {
      // 终审 MAJOR-3：非成功结局统一走 `searchBySqlOrder` ⇒ 与人类（未启用重排）**逐字同结果**。
      // 两次查询：① 池查询（LIMIT poolSize）；② 回落原路径（LIMIT limit OFFSET offset）
      mockOuterQb.getRawMany
        .mockResolvedValueOnce(poolRows())
        .mockResolvedValueOnce(poolRows().slice(0, 5));
      judgment.run.mockResolvedValue({ status: 'timeout' });

      const { hits } = await service.search(['space-1'], { q: 'test', limit: 5 }, { actor: AGENT });

      expect(hits.map((hit) => hit.docId)).toEqual(['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4']);
      expect(hits.some((hit) => hit.reranked === true)).toBe(false);
    });

    it('NEW-4：重排路径同样透传时间窗过滤（createdAfter/createdBefore 进池查询 WHERE）', async () => {
      mockOuterQb.getRawMany.mockResolvedValue(poolRows());
      judgment.run.mockResolvedValue({
        status: 'ok',
        value: { tiers: [0, 0, 0, 0, 0, 3, 3, 3] },
        meta: { provider: 'typesafe', model: 'm', judgedAt: 'now', rubricVersion: 'v1' },
      });

      await service.search(
        ['space-1'],
        {
          q: 'test',
          limit: 5,
          createdAfter: '2026-08-08T00:00:00.000Z',
          createdBefore: '2026-08-15T23:59:59.999Z',
        },
        { actor: AGENT },
      );

      // 池查询与原路径共用 `buildScoredQuery` ⇒ 时间窗谓词必须同样出现在子查询 WHERE 上
      // （`searchWithRerank` 的 filters 形参若窄化掉时间窗，这里会因"查不到谓词"而红）
      expect(mockSubQb.andWhere).toHaveBeenCalledWith('d.created_at >= :createdAfter', {
        createdAfter: '2026-08-08T00:00:00.000Z',
      });
      expect(mockSubQb.andWhere).toHaveBeenCalledWith('d.created_at <= :createdBefore', {
        createdBefore: '2026-08-15T23:59:59.999Z',
      });
      // 且重排确实生效（不是提前回退）
      expect(judgment.run).toHaveBeenCalledTimes(1);
    });

    it('MAJOR-3：**带 boost 且 boost 跨过页边界**时，非成功结局仍与人类结果有序相同', async () => {
      // 判别性构造（复审 NEW-1）：夹具 score = 1 − index/10 ⇒ doc-5 = 0.5，被 primary route
      // 加成 ×1.5 = **0.75 > doc-3 的 0.7** ⇒ 按"池内 boost 序" doc-5 能挤进 `slice(0,5)`；
      // 而原路径是"先 SQL 取页（doc-0..doc-4）、再页内 boost"⇒ doc-5 不该出现。
      // ⚠️ 旧夹具用 doc-7（0.3×1.5 = 0.45 < doc-4 的 0.6）**不具判别性**：池切片同样不含它，
      // 旧实现照样绿（复审指出的测试强度缺陷）。
      mockOuterQb.getRawMany
        .mockResolvedValueOnce(poolRows())
        .mockResolvedValueOnce(poolRows().slice(0, 5));
      mockRouteQb.getRawMany.mockResolvedValue([
        makeRouteRow({
          primary_doc_id: 'doc-5',
          intent_similarity: '0.9',
          category_similarity: '0',
        }),
      ]);
      judgment.run.mockResolvedValue({ status: 'timeout' });

      const { hits: agentHits } = await service.search(
        ['space-1'],
        { q: 'test', limit: 5 },
        { actor: AGENT },
      );

      // 人类（未启用重排）：同一条原路径（单次查询）
      mockOuterQb.getRawMany.mockReset();
      mockOuterQb.getRawMany.mockResolvedValue(poolRows().slice(0, 5));
      const { hits: humanHits } = await service.search(
        ['space-1'],
        { q: 'test', limit: 5 },
        { actor: HUMAN },
      );

      expect(agentHits.map((hit) => hit.docId)).toEqual(humanHits.map((hit) => hit.docId));
      // 页外候选 doc-5 **不得**因 boost 被拉进页（池切片会把它排到第 4 位 = 本用例的判别点）
      expect(agentHits.map((hit) => hit.docId)).not.toContain('doc-5');
    });

    it('人类身份 ⇒ 走原路径（不调用判别、web 面不受判别延迟影响）', async () => {
      // SQL 会按 LIMIT 5 只返回 5 行，mock 不模拟 LIMIT ⇒ 夹具直接给 5 行（模拟真实返回）
      mockOuterQb.getRawMany.mockResolvedValue(poolRows().slice(0, 5));
      const { hits } = await service.search(['space-1'], { q: 'test', limit: 5 }, { actor: HUMAN });
      expect(judgment.run).not.toHaveBeenCalled();
      expect(hits.map((hit) => hit.docId)).toEqual(['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4']);
    });

    it('越窗页（offset 不是 limit 的整数倍 / offset+limit > poolSize）⇒ 原路径', async () => {
      mockOuterQb.getRawMany.mockResolvedValue(poolRows().slice(0, 5));
      const { hits } = await service.search(
        ['space-1'],
        { q: 'test', limit: 5, offset: 3 },
        { actor: AGENT },
      );
      expect(judgment.run).not.toHaveBeenCalled();
      expect(hits).toHaveLength(5);
    });

    it('池内候选属非 open 空间 ⇒ 跳过重排 + 落 visibility_blocked 标量行 + **不带候选清单**', async () => {
      mockOuterQb.getRawMany
        .mockResolvedValueOnce(
          poolRows((index) =>
            index === 6 ? { space_visibility: 'private' } : { space_visibility: 'open' },
          ),
        ) // ① 池查询（LIMIT poolSize）
        .mockResolvedValueOnce(poolRows().slice(0, 5)); // ② 回落原路径（LIMIT limit OFFSET offset）

      const { hits } = await service.search(['space-1'], { q: 'test', limit: 5 }, { actor: AGENT });

      expect(judgment.recordSkip).toHaveBeenCalledWith('rerank', AGENT, 'visibility_blocked');
      expect(judgment.run).not.toHaveBeenCalled();
      // 回原路径（不是池切片）：结果与未启用重排时一致
      expect(hits.map((hit) => hit.docId)).toEqual(['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4']);
    });

    it('空池 ⇒ **不发起付费调用**（与既有 rows.length===0 早退同语义）', async () => {
      mockOuterQb.getRawMany.mockResolvedValue([]);
      const { hits } = await service.search(['space-1'], { q: 'test', limit: 5 }, { actor: AGENT });
      expect(hits).toEqual([]);
      expect(judgment.run).not.toHaveBeenCalled();
    });

    it('能力未启用（isEnabled=false）⇒ 完全不碰内核', async () => {
      judgment.isEnabled.mockReturnValue(false);
      mockOuterQb.getRawMany.mockResolvedValue(poolRows());
      await service.search(['space-1'], { q: 'test', limit: 5 }, { actor: AGENT });
      expect(judgment.run).not.toHaveBeenCalled();
      // 原路径的 SQL 排序（无池查询的额外 doc_id 平局键）
      expect(mockOuterQb.orderBy).toHaveBeenCalledWith('score', 'DESC');
    });

    it('落行载荷含标量集（候选 id / sqlRanks / finalOrderKeys / traceId），且日志与返回同一次求解', async () => {
      mockOuterQb.getRawMany.mockResolvedValue(poolRows());
      judgment.run.mockResolvedValue({
        status: 'ok',
        value: { tiers: [0, 0, 0, 0, 0, 3, 3, 3] },
        meta: { provider: 'typesafe', model: 'm', judgedAt: 'now', rubricVersion: 'v1' },
      });

      await service.search(
        ['space-1'],
        { q: 'test', limit: 5 },
        { actor: AGENT, traceId: 'req_trace1' },
      );

      const input = judgment.run.mock.calls[0][1] as {
        plan: { candidates: Array<{ key: string }> };
        eligibleForPromotion: number;
        traceId: string | null;
        decide: (value: unknown) => { finalOrderKeys: string[] | null; sqlTop1Key: string | null };
      };
      expect(input.traceId).toBe('req_trace1');
      expect(input.eligibleForPromotion).toBe(8 - 5); // 页外池行数 = 3
      expect(input.plan.candidates.map((candidate) => candidate.key)).toEqual([
        'c0',
        'c1',
        'c2',
        'c3',
        'c4',
        'c5',
        'c6',
        'c7',
      ]);
      // 决策闭包带记忆：第二次调用返回同一对象（日志载荷与返回序读同一次求解）
      const first = input.decide({ tiers: [0, 0, 0, 0, 0, 3, 3, 3] });
      const second = input.decide(null);
      expect(second).toBe(first);
      expect(first.finalOrderKeys).toEqual(['c0', 'c1', 'c5', 'c6', 'c7', 'c2', 'c3', 'c4']);
      expect(first.sqlTop1Key).toBe('c0');
    });
  });
});
