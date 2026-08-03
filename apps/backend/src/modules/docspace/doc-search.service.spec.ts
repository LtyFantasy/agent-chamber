import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocSearchService } from './doc-search.service';
import { DocSection } from '../../database/entities/doc-section.entity';
import { Doc } from '../../database/entities/doc.entity';

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

describe('DocSearchService', () => {
  let service: DocSearchService;
  let mockSectionRepo: jest.Mocked<Repository<DocSection>>;
  let mockDocRepo: jest.Mocked<Repository<Doc>>;

  // The subquery mock — captured by the outer QB's `from` factory
  let mockSubQb: ReturnType<typeof createMockQueryBuilder>;
  // The outer QB returned by manager.createQueryBuilder() (main query)
  let mockOuterQb: ReturnType<typeof createMockQueryBuilder>;
  // The typed QB returned by sectionRepo.createQueryBuilder('s')
  let mockTypedQb: ReturnType<typeof createMockQueryBuilder>;

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

    // ── Create repos ──
    const sectionRepoPair = createMockRepo<DocSection>();
    mockSectionRepo = sectionRepoPair;
    // Override createQueryBuilder to return the typed QB
    (mockSectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(mockTypedQb);
    // manager.createQueryBuilder returns different QBs per call
    (mockSectionRepo.manager.createQueryBuilder as jest.Mock).mockReturnValue(mockOuterQb);

    const docRepoPair = createMockRepo<Doc>();
    mockDocRepo = docRepoPair;

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DocSearchService,
        { provide: getRepositoryToken(DocSection), useValue: mockSectionRepo },
        { provide: getRepositoryToken(Doc), useValue: mockDocRepo },
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
    // getRawMany already returns them in DB order; service does NOT re-sort
    // (ORDER BY is in SQL). We just verify getRawMany was called.
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
});
