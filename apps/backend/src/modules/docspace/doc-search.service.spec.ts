import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocSearchService } from './doc-search.service';
import { DocSection } from '../../database/entities/doc-section.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';

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
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
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

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DocSearchService,
        { provide: getRepositoryToken(DocSection), useValue: mockSectionRepo },
        { provide: getRepositoryToken(Doc), useValue: mockDocRepo },
        { provide: getRepositoryToken(DocRoute), useValue: mockRouteRepo },
        { provide: getRepositoryToken(TaskDocLink), useValue: mockTaskLinkRepo },
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

    const hits = await service.search(['space-1'], { q: '搜索' });

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
      getRawOne: jest.fn().mockResolvedValue({ headline: 'This is the <b>full</b> section content.' }),
    });
    (mockSectionRepo.manager.createQueryBuilder as jest.Mock)
      .mockReturnValueOnce(mockOuterQb)
      .mockReturnValueOnce(mockHeadlineQb);

    const hits = await service.search(['space-1'], { q: 'full' });

    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].snippet).toBe('This is the <b>full</b> section content.');
  });

  // ─── Test 3: Mixed scoring sorts by composite score DESC ─────
  it('should sort results by composite score in descending order', async () => {
    const rawRows = [
      makeRawRow({ doc_id: 'doc-a', score: 0.5, ts_rank_score: 0, trgm_content_score: 0.5 / 0.6 }),
      makeRawRow({ doc_id: 'doc-c', score: 0.15, ts_rank_score: 0.15, trgm_content_score: 0 }),
      makeRawRow({ doc_id: 'doc-b', score: 1.2, ts_rank_score: 1.0, trgm_content_score: 0.2 / 0.6 }),
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

    const hits = await service.search(['space-1'], { q: 'test' });

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

    const hits = await service.search(['space-1'], { q: 'noise' });

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
    expect(mockSubQb.andWhere).toHaveBeenCalledWith(
      ':tagVal = ANY(d.tags)',
      { tagVal: 'combat' },
    );
  });

  // ─── Test 6: Type filter ─────────────────────────────────────
  it('should add type filter to subquery WHERE clause', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1'], { q: 'test', type: 'architecture' });

    // Verify subquery includes type condition
    expect(mockSubQb.andWhere).toHaveBeenCalledWith(
      'd.doc_type = :docType',
      { docType: 'architecture' },
    );
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

    const hits = await service.search(['space-1'], { q: 'test' });

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

    const hits = await service.search(['space-1'], { q: 'test' });

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
    const hits = await service.search([], { q: 'test' });

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
    expect(mockSubQb.andWhere).toHaveBeenCalledWith(
      'dc.slug = :catSlug',
      { catSlug: 'architecture' },
    );
  });

  // ─── Bonus: Space whitelist with IDs adds IN filter ──────────
  it('should add space IN filter when accessibleSpaceIds is provided', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    await service.search(['space-1', 'space-2'], { q: 'test' });

    // Subquery should have IN filter on space_id
    expect(mockSubQb.andWhere).toHaveBeenCalledWith(
      'd.space_id IN (:...spaceIds)',
      { spaceIds: ['space-1', 'space-2'] },
    );
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

    const hits = await service.search(['space-1'], { q: '中文搜索' });

    expect(hits).toHaveLength(1);
    // snippet should be built from content via buildTrgmSnippet (not ts_headline)
    expect(hits[0].snippet.length).toBeGreaterThan(0);
    // manager.createQueryBuilder should NOT have been called a second time
    // (it was called once for the outer query, zero times for ts_headline)
    expect(mockSectionRepo.manager.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  // ─── 三路融合 boost（plan §4-C3）───────────────────────────────

  it('should boost primaryDocId hits by ×1.5 and expose boosts.route=primary', async () => {
    const rawRows = [
      makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // doc-1 是命中路由（intent 0.5 ≥ 0.15）的 primaryDoc
    mockRouteQb.getRawMany.mockResolvedValue([makeRouteRow()]);

    const hits = await service.search(['space-1'], { q: '架构' });

    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeCloseTo(0.2 * 1.5, 6);
    expect(hits[0].boosts).toEqual({ route: 'primary' });
    // 路由查询限定在可访问空间内
    expect(mockRouteQb.where).toHaveBeenCalledWith('r.spaceId IN (:...spaceIds)', {
      spaceIds: ['space-1'],
    });
  });

  it('should boost secondaryDocId hits by ×1.2 and expose boosts.route=secondary', async () => {
    const rawRows = [
      makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // doc-1 是命中路由（intent 0.4 ≥ 0.15）的 secondaryDoc
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ primary_doc_id: 'doc-other', secondary_doc_id: 'doc-1', intent_similarity: '0.4' }),
    ]);

    const hits = await service.search(['space-1'], { q: '再看' });

    expect(hits[0].score).toBeCloseTo(0.2 * 1.2, 6);
    expect(hits[0].boosts).toEqual({ route: 'secondary' });
  });

  it('route threshold: intent 0.14 misses (no boost), 0.15 hits (×1.5, ≥ semantics)', async () => {
    const rawRows = [
      makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    // 0.14 < ROUTE_INTENT_FLOOR(0.15) → 不命中
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ intent_similarity: '0.14', category_similarity: '0' }),
    ]);
    let hits = await service.search(['space-1'], { q: '边界' });
    expect(hits[0].score).toBeCloseTo(0.2, 6);
    expect(hits[0].boosts).toBeUndefined();

    // 0.15 = ROUTE_INTENT_FLOOR → 命中（≥ 判定，边界值必须命中）
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ intent_similarity: '0.15', category_similarity: '0' }),
    ]);
    hits = await service.search(['space-1'], { q: '边界' });
    expect(hits[0].score).toBeCloseTo(0.2 * 1.5, 6);
    expect(hits[0].boosts).toEqual({ route: 'primary' });
  });

  it('route threshold: category 0.29 misses, 0.3 hits (intent can be zero)', async () => {
    const rawRows = [
      makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);

    // 0.29 < ROUTE_CATEGORY_FLOOR(0.3) 且 intent=0 → 不命中
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ intent_similarity: '0', category_similarity: '0.29' }),
    ]);
    let hits = await service.search(['space-1'], { q: '分类' });
    expect(hits[0].boosts).toBeUndefined();

    // 0.3 = ROUTE_CATEGORY_FLOOR → 命中（category 单独达标即命中）
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ intent_similarity: '0', category_similarity: '0.3' }),
    ]);
    hits = await service.search(['space-1'], { q: '分类' });
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
      makeRouteRow({ id: 'r1', primary_doc_id: 'doc-1', secondary_doc_id: 'doc-2', intent_similarity: '0.5' }),
      makeRouteRow({ id: 'r2', primary_doc_id: 'doc-3', secondary_doc_id: 'doc-1', intent_similarity: '0.4' }),
    ]);

    const hits = await service.search(['space-1'], { q: '架构' });

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

    const hits = await service.search(['space-1'], { q: '任务' });

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
      makeRawRow({ doc_id: 'doc-top', ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // doc-keep 是命中路由 primary（0.09×1.5=0.135）——boost 只重排，不得增加/移除命中
    mockRouteQb.getRawMany.mockResolvedValue([makeRouteRow({ primary_doc_id: 'doc-keep' })]);

    const hits = await service.search(['space-1'], { q: 'noise' });

    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.docId).sort()).toEqual(['doc-keep', 'doc-top']);
    // doc-top(0.2) 仍居首（boost 后 doc-keep 0.135 未反超）
    expect(hits[0].docId).toBe('doc-top');
  });

  it('omits boosts key when no route or task-link boost applies', async () => {
    const rawRows = [
      makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2, score: 0.12 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // 路由与任务链接均无命中（默认空结果）

    const hits = await service.search(['space-1'], { q: 'plain' });

    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toHaveProperty('boosts');
    expect(hits[0].score).toBeCloseTo(0.12, 6);
  });

  it('exposes both route and taskLinks keys when both boosts apply', async () => {
    const rawRows = [
      makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    mockRouteQb.getRawMany.mockResolvedValue([makeRouteRow()]);
    mockTaskLinkQb.getRawMany.mockResolvedValue([makeTaskLinkRow('doc-1', 2)]);

    const hits = await service.search(['space-1'], { q: '架构' });

    expect(hits[0].score).toBeCloseTo(0.2 * 1.5 * 1.1, 6); // 1.5 × (1 + 2×0.05)
    expect(hits[0].boosts).toEqual({ route: 'primary', taskLinks: 2 });
  });

  it('re-sorts ties by position ASC after boost (same final score)', async () => {
    const rawRows = [
      makeRawRow({ doc_id: 'doc-a', section_position: 1, ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
      makeRawRow({ doc_id: 'doc-b', section_position: 0, ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // 无 boost，同分 → position ASC（SQL 结果序 doc-a 在前，重排后 doc-b 在前）

    const hits = await service.search(['space-1'], { q: 'tie' });

    expect(hits.map((h) => h.docId)).toEqual(['doc-b', 'doc-a']);
  });

  it('re-ranks hits by boosted score DESC (boosted doc overtakes higher base score)', async () => {
    const rawRows = [
      makeRawRow({ doc_id: 'doc-plain', ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
      makeRawRow({ doc_id: 'doc-boost', ts_rank_score: 0, trgm_content_score: 0.17 / 0.6, score: 0.17 }),
    ];
    mockOuterQb.getRawMany.mockResolvedValue(rawRows);
    // doc-boost 是命中路由 primary：0.17 × 1.5 = 0.255 > 0.2 → 反超 doc-plain
    mockRouteQb.getRawMany.mockResolvedValue([
      makeRouteRow({ primary_doc_id: 'doc-boost', intent_similarity: '0.5' }),
    ]);

    const hits = await service.search(['space-1'], { q: '架构' });

    expect(hits.map((h) => h.docId)).toEqual(['doc-boost', 'doc-plain']);
    expect(hits[0].score).toBeCloseTo(0.255, 5);
  });

  it('does not filter routes by space when accessibleSpaceIds is null (admin)', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([
      makeRawRow({ ts_rank_score: 0, trgm_content_score: 0.2 / 0.6, score: 0.2 }),
    ]);
    mockRouteQb.getRawMany.mockResolvedValue([makeRouteRow()]);

    const hits = await service.search(null, { q: '架构' });

    expect(mockRouteQb.where).not.toHaveBeenCalled();
    expect(hits[0].score).toBeCloseTo(0.3, 6);
    expect(hits[0].boosts).toEqual({ route: 'primary' });
  });

  it('skips route/task-link boost queries when no hits pass the floor', async () => {
    mockOuterQb.getRawMany.mockResolvedValue([]);

    const hits = await service.search(['space-1'], { q: 'nothing' });

    expect(hits).toEqual([]);
    expect(mockRouteRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(mockTaskLinkRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
