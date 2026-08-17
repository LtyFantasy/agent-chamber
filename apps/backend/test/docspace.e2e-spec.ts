import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createTestingApp } from './test-setup';
import { ErrorCode, TaskStatus } from '@agent-chamber/shared';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mocked-hash'),
  })),
  randomBytes: jest.fn(() => ({
    toString: jest.fn().mockReturnValue('mocked-random-bytes'),
  })),
}));

describe('DocSpaceController (e2e)', () => {
  let app: INestApplication;
  let mockRepos: Record<string, any>;
  let authToken: string;

  // Valid UUID v4 format (version=4, variant=8xxx)
  const spaceId = '00000000-0000-4000-8000-000000000100';
  const boardId = '00000000-0000-4000-8000-000000000200';
  const listId = '00000000-0000-4000-8000-000000000210';
  const taskId = '00000000-0000-4000-8000-000000000300';
  const docId = '00000000-0000-4000-8000-000000000400';
  const sectionId = '00000000-0000-4000-8000-000000000410';
  const actorId = '00000000-0000-4000-8000-000000000005';
  const catId = '00000000-0000-4000-8000-000000000500';

  beforeEach(async () => {
    ({ app, mockRepos } = await createTestingApp());

    const jwtService = app.get(JwtService);
    authToken = jwtService.sign({
      sub: actorId,
      email: 'test@example.com',
      role: 'observer',
    });

    // Support JwtStrategy validation for every request (Actor unified model)
    mockRepos.User.findOne.mockResolvedValue({
      id: actorId,
      email: 'test@example.com',
      role: 'observer',
      status: 'active',
      deletedAt: null,
      actor: { status: 'active' },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  // ─── Helper makers ────────────────────────────────────────────

  const makeSpace = (overrides: Partial<any> = {}) => ({
    id: spaceId,
    name: 'Test Space',
    slug: 'test-space',
    description: null,
    topicId: null,
    boardId: null,
    creatorId: actorId,
    settings: { visibility: 'open' },
    docCount: 0,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    ...overrides,
  });

  const makeBoard = (overrides: Partial<any> = {}) => ({
    id: boardId,
    name: 'Test Board',
    topicId: null,
    creatorId: actorId,
    creatorType: 'human',
    settings: { visibility: 'open' },
    lists: [],
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    ...overrides,
  });

  const makeBoardList = (overrides: Partial<any> = {}) => ({
    id: listId,
    boardId,
    name: 'To Do',
    position: 1,
    color: null,
    mappedStatus: 'todo',
    board: makeBoard(),
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    ...overrides,
  });

  const makeTask = (overrides: Partial<any> = {}) => ({
    id: taskId,
    title: 'Test Task',
    status: TaskStatus.TODO,
    priority: 'p1',
    assigneeId: actorId,
    assigneeType: 'human',
    listId,
    topicId: null,
    labels: [],
    milestoneId: null,
    position: 0,
    description: 'A task description',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    ...overrides,
  });

  const makeDoc = (overrides: Partial<any> = {}) => ({
    id: docId,
    spaceId,
    categoryId: null,
    path: 'test.md',
    title: '测试文档',
    summary: 'A test doc summary',
    docType: 'guide',
    tags: [],
    source: 'native',
    contentHash: 'mocked-hash',
    sectionCount: 1,
    tokenEstimate: 50,
    createdBy: actorId,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    ...overrides,
  });

  const makeSection = (overrides: Partial<any> = {}) => ({
    id: sectionId,
    docId,
    position: 0,
    headingPath: '你好世界',
    headingLevel: 1,
    content: '# 你好世界\n\n这是一段中文测试内容。',
    tokenEstimate: 20,
    searchVector: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  });

  const makeCategory = (overrides: Partial<any> = {}) => ({
    id: catId,
    spaceId,
    name: 'tutorial',
    slug: 'tutorial',
    description: null,
    sortOrder: 0,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    ...overrides,
  });

  // ─── Reusable mock helpers ────────────────────────────────────

  /** Build a generic chainable query builder mock. */
  const genericQb = (overrides: Record<string, jest.Mock | (() => any)> = {}) => {
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue(null),
      getOne: jest.fn().mockResolvedValue(null),
      getMany: jest.fn().mockResolvedValue([]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getCount: jest.fn().mockResolvedValue(0),
      clone: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      ...overrides,
    };
    return qb;
  };

  /** Setup the manager mock on a repo with createQueryBuilder chaining. */
  const setupManagerQb = (repoKey: string, ...qbs: any[]) => {
    const mgr: any = mockRepos[repoKey].manager;
    if (qbs.length === 1) {
      mgr.createQueryBuilder = jest.fn().mockReturnValue(qbs[0]);
      mgr.getRepository = jest.fn().mockReturnValue(mockRepos[repoKey]);
    } else {
      mgr.createQueryBuilder = jest.fn();
      for (const qb of qbs) {
        mgr.createQueryBuilder.mockReturnValueOnce(qb);
      }
    }
  };

  // ─── Test 1: POST /doc-spaces — create space ──────────────────

  it('POST /doc-spaces — creates a DocSpace', async () => {
    const space = makeSpace();

    // Board lookup for controller-level boardId validation
    mockRepos.Board.findOne.mockResolvedValue(makeBoard());
    // BoardMember lookup for BoardPolicy.can (open visibility short-circuits)
    mockRepos.BoardMember.findOne.mockResolvedValue(null);

    // Slug uniqueness check — no existing space
    const slugQb = genericQb({ getOne: jest.fn().mockResolvedValue(null) });
    mockRepos.DocSpace.createQueryBuilder.mockReturnValue(slugQb);

    // spaceRepo.create + save
    mockRepos.DocSpace.create.mockReturnValue(space);
    mockRepos.DocSpace.save.mockResolvedValue(space);

    return request(app.getHttpServer())
      .post('/doc-spaces')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Test Space', boardId, visibility: 'open' })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data).toHaveProperty('id', spaceId);
        expect(res.body.data).toHaveProperty('name', 'Test Space');
        expect(res.body.data).toHaveProperty('slug', 'test-space');
      });
  });

  // ─── Test 2: PUT /doc-spaces/:id/docs — upsert document ───────

  it('PUT /doc-spaces/:id/docs — upserts a document with content', async () => {
    const space = makeSpace();
    const doc = makeDoc();
    const category = makeCategory();

    // Permission: write access (creator match)
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // DocService.upsert: existing doc lookup → null
    const docFindQb = genericQb({ getOne: jest.fn().mockResolvedValue(null) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docFindQb);

    // Category resolution: no existing category → auto-create
    const catFindQb = genericQb({ getOne: jest.fn().mockResolvedValue(null) });
    mockRepos.DocCategory.createQueryBuilder.mockReturnValue(catFindQb);
    mockRepos.DocCategory.create.mockReturnValue(category);
    mockRepos.DocCategory.save.mockResolvedValue(category);

    // Transaction: manager.getRepository(Doc/DocSection) returns the same repo mock.
    // The transaction callback runs with the managerMock which calls
    // manager.getRepository(Doc) → returns mockRepos.Doc (same instance).
    // So docRepo.create/save, sectionRepo.create/save all work through the existing mocks.
    mockRepos.Doc.create.mockReturnValue(doc);
    mockRepos.Doc.save.mockResolvedValue(doc);
    mockRepos.DocSection.create.mockReturnValue(makeSection());
    mockRepos.DocSection.save.mockResolvedValue([makeSection()]);

    // Audit log
    mockRepos.AuditLog.create.mockReturnValue({});
    mockRepos.AuditLog.save.mockResolvedValue({});

    // Event emission: getSpaceEventContext → docSpaceRepo.createQueryBuilder
    const spaceCtxQb = genericQb({
      getRawOne: jest.fn().mockResolvedValue({ ds_board_id: null, ds_topic_id: null }),
    });
    // The DocService uses this.docSpaceRepo — a separate injection.
    // So DocSpace.createQueryBuilder is already set above; we need to differentiate.
    // Override for the event-context query:
    mockRepos.DocSpace.createQueryBuilder.mockReturnValue(spaceCtxQb);

    mockRepos.Event.create = jest.fn().mockReturnValue({});
    mockRepos.Event.save = jest.fn().mockResolvedValue({});

    // Manager transaction needs to be set up
    setupManagerQb('Doc', genericQb());

    return request(app.getHttpServer())
      .put(`/doc-spaces/${spaceId}/docs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        path: 'test.md',
        content: '# 你好世界\n\n这是一段中文测试内容。',
        title: '测试文档',
        docType: 'guide',
        category: 'tutorial',
      })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveProperty('id', docId);
        expect(res.body.data).toHaveProperty('path', 'test.md');
        expect(res.body.data).toHaveProperty('sectionCount');
      });
  });

  // ─── Test 2b: PUT upsert sourceSha last-verified 刷新（v1.42 B6） ───

  it('PUT /doc-spaces/:id/docs — unchanged content + different sourceSha → refreshes source_sha, response unchanged:true', async () => {
    const space = makeSpace();
    // 真实 hash：服务端 computeHash 计算内容哈希，相等才走 unchanged 分支
    const crypto = require('crypto');
    const testContent = '# 你好世界\n\n这是一段中文测试内容。';
    const hash = crypto.createHash('sha256').update(testContent).digest('hex');
    const existingDoc = makeDoc({
      source: 'git:agent-chamber',
      contentHash: hash,
      sourceSha: 'old-sha',
      linkHealth: { total: 0, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
    });

    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // 既有文档命中 → unchanged 分支：仅刷新 source_sha（update mock 断言）
    const docFindQb = genericQb({ getOne: jest.fn().mockResolvedValue(existingDoc) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docFindQb);

    return request(app.getHttpServer())
      .put(`/doc-spaces/${spaceId}/docs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        path: 'test.md',
        content: testContent,
        source: 'git:agent-chamber',
        sourceSha: 'new-sha',
      })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.unchanged).toBe(true);
        expect(docFindQb.update).toHaveBeenCalledWith('Doc');
        expect(docFindQb.set).toHaveBeenCalledWith({ sourceSha: 'new-sha' });
      });
  });

  // ─── Test 3: GET /doc-spaces/:id/docs?category=tutorial ───────

  it('GET /doc-spaces/:id/docs — lists documents with category filter', async () => {
    const space = makeSpace();
    const doc = makeDoc({ categoryId: catId });

    // Permission: read access (open visibility)
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // DocService.findAll: query builder chain
    const listQb = genericQb({
      getManyAndCount: jest.fn().mockResolvedValue([[doc], 1]),
    });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(listQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/docs?category=tutorial`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveProperty('items');
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.items[0]).toHaveProperty('id', docId);
        expect(res.body.data.items[0]).toHaveProperty('docType', 'guide');
      });
  });

  it('GET /doc-spaces/:id/docs?pathPrefix=memory/ — 前缀过滤转 LIKE 字面量（v1.55）', async () => {
    const space = makeSpace();
    const doc = makeDoc();

    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const listQb = genericQb({
      getManyAndCount: jest.fn().mockResolvedValue([[doc], 1]),
    });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(listQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/docs?pathPrefix=memory/`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.items).toHaveLength(1);
        // LIKE 前缀语义 + ESCAPE 子句（通配符转义保证字面前缀）
        expect(listQb.andWhere).toHaveBeenCalledWith("d.path LIKE :pathPrefix ESCAPE '\\'", {
          pathPrefix: 'memory/%',
        });
      });
  });

  it('GET /doc-spaces/:id/docs?path=a&pathPrefix=b — 400（path 与 pathPrefix 互斥）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/docs?path=docs/a.md&pathPrefix=docs/`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400);
  });

  // ─── Test 4: GET /doc-spaces/:id/search?q=中文 ────────────────

  it('GET /doc-spaces/:id/search — searches with Chinese query', async () => {
    const space = makeSpace();

    // Permission: read access
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // DocSearchService.search runs a complex subquery via sectionRepo.manager.
    const searchRow = {
      doc_id: docId,
      doc_path: 'test.md',
      doc_title: '测试文档',
      section_position: 0,
      heading_path: '你好世界',
      section_content: '这是一段中文测试内容。',
      ts_rank_score: 0,
      trgm_content_score: 0.15,
      trgm_heading_score: 0.0,
      score: 0.09,
    };

    const searchQb = genericQb({
      getRawMany: jest.fn().mockResolvedValue([searchRow]),
    });

    const headlineQb = genericQb({
      getRawOne: jest.fn().mockResolvedValue({ headline: '这是一段<b>中文</b>测试内容。' }),
    });

    // sectionRepo.manager.createQueryBuilder is called twice:
    // 1st: outer wrapper search
    // 2nd: ts_headline snippet
    const mgr: any = mockRepos.DocSection.manager;
    mgr.createQueryBuilder = jest.fn().mockReturnValueOnce(searchQb).mockReturnValue(headlineQb);

    // Also, the sectionRepo.findOne for the fallback snippet
    mockRepos.DocSection.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/search?q=中文`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.data.length).toBeGreaterThanOrEqual(1);
        expect(res.body.data[0]).toHaveProperty('docId', docId);
        expect(res.body.data[0]).toHaveProperty('docTitle', '测试文档');
      });
  });

  // ─── Test 4b: v1.55 search 翻页/时间序参数（HTTP 层透传 + 排序接管）───

  it('GET /doc-spaces/:id/search — v1.55 offset/sort/时间窗透传 service（OFFSET + 时间序 ORDER BY 接管）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const searchRow = {
      doc_id: docId,
      doc_path: 'test.md',
      doc_title: '测试文档',
      section_position: 0,
      heading_path: '你好世界',
      section_content: '这是一段中文测试内容。',
      ts_rank_score: 0,
      trgm_content_score: 0.15,
      trgm_heading_score: 0.0,
      score: 0.09,
    };
    const searchQb = genericQb({
      getRawMany: jest.fn().mockResolvedValue([searchRow]),
    });
    // 捕获子查询 builder：时间窗过滤（createdAfter/createdBefore）在 subQuery 上执行
    const subQb = genericQb();
    searchQb.from.mockImplementation((factoryFn: any, alias: string) => {
      factoryFn(subQb);
      return searchQb;
    });
    // 时间序分支跳过 boost 查询：仅 1 次 manager.createQueryBuilder（外层 search）
    const mgr: any = mockRepos.DocSection.manager;
    mgr.createQueryBuilder = jest.fn().mockReturnValue(searchQb);
    mockRepos.DocSection.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get(
        `/doc-spaces/${spaceId}/search?q=中文&offset=10&sort=createdAt_desc` +
          `&createdAfter=2026-08-08T00:00:00.000Z&createdBefore=2026-08-15T23:59:59.999Z`,
      )
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect(() => {
        // 翻页：OFFSET 10 附加在外层查询
        expect(searchQb.offset).toHaveBeenCalledWith(10);
        // 时间序接管 ORDER BY：doc_created_at DESC（boost 融合被跳过）
        expect(searchQb.orderBy).toHaveBeenCalledWith('sub.doc_created_at', 'DESC');
        // 时间窗过滤进入子查询（andWhere 收到包含边界的条件）
        expect(subQb.andWhere).toHaveBeenCalledWith(expect.stringContaining('d.created_at >='), {
          createdAfter: '2026-08-08T00:00:00.000Z',
        });
        expect(subQb.andWhere).toHaveBeenCalledWith(expect.stringContaining('d.created_at <='), {
          createdBefore: '2026-08-15T23:59:59.999Z',
        });
      });
  });

  it('GET /doc-spaces/:id/search — 非法 sort 值 400（@IsIn 格式层拦截）', async () => {
    // ValidationPipe 在 controller 之前拦截：BadRequestException 无自定义 code，
    // 过滤器 fallback → ErrorCode.BAD_REQUEST(400)（与 overview?maxTokens=abc 同款断言）
    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/search?q=中文&sort=bogus`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
      });
  });

  it('GET /doc-spaces/:id/search — 非 ISO 8601 时间窗 400（@IsISO8601 格式层拦截）', async () => {
    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/search?q=中文&createdAfter=2026-13-99`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
      });
  });

  // ─── Test 4c: v1.55 批量读节 positions= 与模糊定位 headingQuery（HTTP 层）───

  it('GET /docs/:id/sections?positions=1,3 — 200 批量结果（去重 ASC + 越界进 missing 不整体报错）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const sectionQb = genericQb({
      getMany: jest
        .fn()
        .mockResolvedValue([
          makeSection({
            position: 1,
            headingPath: '你好世界 § 设置',
            headingLevel: 2,
            content: '设置正文',
          }),
          makeSection({
            position: 3,
            headingPath: '你好世界 § 进阶',
            headingLevel: 2,
            content: '进阶正文',
          }),
        ]),
    });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .get(`/docs/${docId}/sections?positions=1,3,9`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.docId).toBe(docId);
        expect(res.body.data.sections.map((s: any) => s.position)).toEqual([1, 3]);
        expect(res.body.data.sections[0].content).toBe('设置正文');
        // 越界 position 单独列出（部分失败友好）
        expect(res.body.data.missing).toEqual([9]);
      });
  });

  it('GET /docs/:id/sections/:position?positions=1 — 400：批量与单节定位混用（VALIDATION_ERROR）', async () => {
    // 单节定位走路径参数（sections/2），批量走 query positions=——混传由 controller 层 400
    return request(app.getHttpServer())
      .get(`/docs/${docId}/sections/2?positions=1`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
      });
  });

  it('GET /docs/:id/sections?headingQuery= — 200：唯一命中返回该节', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const sectionQb = genericQb({
      getMany: jest
        .fn()
        .mockResolvedValue([
          makeSection({
            position: 2,
            headingPath: '你好世界 § 设计',
            headingLevel: 2,
            content: '设计正文',
          }),
        ]),
    });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .get(`/docs/${docId}/sections?headingQuery=设计`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.position).toBe(2);
        expect(res.body.data.content).toBe('设计正文');
      });
  });

  it('GET /docs/:id/sections?headingQuery= — 409：多命中 + data.candidates 透传（filter data 槽）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // 同名子标题重复（headingPath 链可重复）→ 多命中
    const sectionQb = genericQb({
      getMany: jest
        .fn()
        .mockResolvedValue([
          makeSection({ position: 1, headingPath: 'A § 总结', headingLevel: 2, content: 'a' }),
          makeSection({ position: 5, headingPath: 'B § 总结', headingLevel: 2, content: 'b' }),
        ]),
    });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .get(`/docs/${docId}/sections?headingQuery=总结`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(409)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.RESOURCE_CONFLICT);
        // AllExceptionsFilter 业务 data 透传：candidates 进入统一信封 data 槽
        expect(res.body.data.candidates).toEqual([
          { position: 1, headingPath: 'A § 总结' },
          { position: 5, headingPath: 'B § 总结' },
        ]);
      });
  });

  it('GET /docs/:id/sections?headingQuery= — 404：零命中（DOC_NOT_FOUND）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const sectionQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .get(`/docs/${docId}/sections?headingQuery=无此标题`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.DOC_NOT_FOUND);
      });
  });

  // ─── Test 5: GET /docs/:id/content — read full content ────────

  it('GET /docs/:id/content — returns full document content', async () => {
    const space = makeSpace();
    const doc = makeDoc();
    const section = makeSection();

    // DocService.findById — called once by controller, once by getContent → getContent calls this.findById(id)
    // The first call comes from the controller, the second from within getContent.
    const docFindQb = genericQb({ getOne: jest.fn().mockResolvedValue(doc) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docFindQb);

    // DocSpaceService.findById
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // DocService.getContent: sectionRepo query
    const sectionQb = genericQb({
      getMany: jest.fn().mockResolvedValue([section]),
    });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .get(`/docs/${docId}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveProperty('docId', docId);
        expect(res.body.data).toHaveProperty('content');
        expect(res.body.data.content).toContain('你好世界');
      });
  });

  // ─── Test 6: POST /tasks/:id/doc-links — link doc to task ─────

  it('POST /tasks/:id/doc-links — links a document to a task', async () => {
    const task = makeTask();
    const board = makeBoard();
    const boardList = makeBoardList();

    // TaskService.findById uses taskRepo.findOne (not createQueryBuilder)
    mockRepos.Task.findOne.mockResolvedValue(task);

    // PermissionService.ensureCan(task, actor, 'write'):
    //   TaskPolicy.can → listRepo.findOne({ where: { id: listId }, relations: ['board'] })
    mockRepos.BoardList.findOne.mockResolvedValue(boardList);

    // BoardPolicy.can(actor, board, 'write'): creator match → board.creatorId === actor.id
    mockRepos.BoardMember.findOne.mockResolvedValue(null);

    // TaskService.addDocLink: docRepo query → find doc
    const docFindQb = genericQb({
      getOne: jest.fn().mockResolvedValue(makeDoc()),
    });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docFindQb);

    //   docSpaceRepo query → find space
    const spaceFindQb = genericQb({
      getOne: jest.fn().mockResolvedValue(makeSpace()),
    });
    mockRepos.DocSpace.createQueryBuilder.mockReturnValue(spaceFindQb);

    //   docSpacePolicy.can (internally called by addDocLink)
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    //   Idempotent check: existing link → null
    mockRepos.TaskDocLink.findOne.mockResolvedValue(null);

    //   create + save link
    const link = { taskId, docId, createdBy: actorId, createdAt: new Date() };
    mockRepos.TaskDocLink.create.mockReturnValue(link);
    mockRepos.TaskDocLink.save.mockResolvedValue(link);

    return request(app.getHttpServer())
      .post(`/tasks/${taskId}/doc-links`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ docId })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data).toHaveProperty('taskId', taskId);
        expect(res.body.data).toHaveProperty('docId', docId);
      });
  });

  // ─── Test 7: DELETE /docs/:id — delete document ───────────────

  it('DELETE /docs/:id — deletes a document', async () => {
    const space = makeSpace();
    const doc = makeDoc();

    // DocService.findById is called three times total across the pipeline:
    //   (a) controller: docService.findById(id)
    //   (b) docService.remove: this.findById(docId)
    //   (c) docService.remove emits event → getSpaceEventContext → ... but that's a separate repo
    // plus the soft-delete update query via createQueryBuilder().update().set().where().execute()
    const docFindQb = genericQb({ getOne: jest.fn().mockResolvedValue(doc) });
    const updateQb = genericQb({ execute: jest.fn().mockResolvedValue({ affected: 1 }) });

    mockRepos.Doc.createQueryBuilder
      .mockReturnValueOnce(docFindQb) // (a) controller findById
      .mockReturnValueOnce(docFindQb) // (b) service.remove findById
      .mockReturnValue(updateQb); // (c) soft-delete update

    // DocSpaceService.findById
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // Event emission after delete: getSpaceEventContext
    const spaceCtxQb = genericQb({
      getRawOne: jest.fn().mockResolvedValue({ ds_board_id: null, ds_topic_id: null }),
    });
    mockRepos.DocSpace.createQueryBuilder.mockReturnValue(spaceCtxQb);

    mockRepos.Event.create = jest.fn().mockReturnValue({});
    mockRepos.Event.save = jest.fn().mockResolvedValue({});

    return request(app.getHttpServer())
      .delete(`/docs/${docId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveProperty('deleted', true);
      });
  });

  // ─── Test 8: DELETE /doc-spaces/:id — delete space ────────────

  it('DELETE /doc-spaces/:id — deletes a DocSpace', async () => {
    const space = makeSpace();

    // DocSpaceService.remove: findById → spaceRepo.findOne
    mockRepos.DocSpace.findOne.mockResolvedValue(space);

    // Count docs in space
    const docCountQb = genericQb({
      getRawMany: jest.fn().mockResolvedValue([{ id: docId }]),
    });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docCountQb);

    // Count linked tasks
    const linkCountQb = genericQb({
      getRawOne: jest.fn().mockResolvedValue({ count: '2' }),
    });
    mockRepos.TaskDocLink.createQueryBuilder.mockReturnValue(linkCountQb);

    // Transaction manager — createQueryBuilder is called multiple times:
    // 1. select section IDs
    // 2. update DocSection set deletedAt
    // 3. update Doc set deletedAt
    // 4. update DocSpace set deletedAt
    const sectionSelectQb = genericQb({
      getRawMany: jest.fn().mockResolvedValue([{ id: sectionId }]),
    });
    const updateQb = genericQb({ execute: jest.fn().mockResolvedValue({ affected: 1 }) });
    const dsManager: any = mockRepos.DocSpace.manager;
    dsManager.createQueryBuilder = jest
      .fn()
      .mockReturnValueOnce(sectionSelectQb)
      .mockReturnValue(updateQb);

    return request(app.getHttpServer())
      .delete(`/doc-spaces/${spaceId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveProperty('deleted', true);
      });
  });

  // ==================== v1.37 owner 代理权限（agent 创建 → owner 人类全通） ====================

  const agentCreatorId = '00000000-0000-4000-8000-0000000000cc';

  const makeAgentPrivateSpace = (overrides: Partial<any> = {}) =>
    makeSpace({
      creatorId: agentCreatorId,
      settings: { visibility: 'private' },
      ...overrides,
    });

  it('GET /doc-spaces/:id - owner human can read agent-created private space (owner proxy)', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(true);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeAgentPrivateSpace());
    // enrich：members/categories/docs count/linked tasks
    mockRepos.DocSpaceMember.find.mockResolvedValue([]);
    mockRepos.DocCategory.find.mockResolvedValue([]);
    const countQb = genericQb({ getRawOne: jest.fn().mockResolvedValue({ count: '0' }) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(countQb);
    mockRepos.TaskDocLink.createQueryBuilder.mockReturnValue(countQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('creatorId', agentCreatorId);
        // owner 代理命中：确认查了 agents 表
        expect(mockRepos.Agent.exists).toHaveBeenCalledWith({
          where: { id: agentCreatorId, ownerId: actorId },
        });
      });
  });

  it('GET /doc-spaces/:id - non-owner human gets 404 for agent-created private space', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeAgentPrivateSpace());

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.DOC_SPACE_NOT_FOUND);
      });
  });

  it('PATCH /doc-spaces/:id - owner human can update agent-created space (owner proxy)', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(true);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeAgentPrivateSpace());
    mockRepos.DocSpace.save.mockResolvedValue({
      ...makeAgentPrivateSpace(),
      name: 'Renamed Space',
      settings: { visibility: 'private' },
    });

    return request(app.getHttpServer())
      .patch(`/doc-spaces/${spaceId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Renamed Space' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('name', 'Renamed Space');
      });
  });

  it('DELETE /doc-spaces/:id - owner human can delete agent-created space (owner proxy)', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(true);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeAgentPrivateSpace());

    const docCountQb = genericQb({
      getRawMany: jest.fn().mockResolvedValue([{ id: docId }]),
    });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docCountQb);

    const linkCountQb = genericQb({
      getRawOne: jest.fn().mockResolvedValue({ count: '2' }),
    });
    mockRepos.TaskDocLink.createQueryBuilder.mockReturnValue(linkCountQb);

    const sectionSelectQb = genericQb({
      getRawMany: jest.fn().mockResolvedValue([{ id: sectionId }]),
    });
    const updateQb = genericQb({ execute: jest.fn().mockResolvedValue({ affected: 1 }) });
    const dsManager: any = mockRepos.DocSpace.manager;
    dsManager.createQueryBuilder = jest
      .fn()
      .mockReturnValueOnce(sectionSelectQb)
      .mockReturnValue(updateQb);

    return request(app.getHttpServer())
      .delete(`/doc-spaces/${spaceId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveProperty('deleted', true);
      });
  });

  // ==================== v1.45 DOCSPACE-PERM：update 字段级分权 + creator 转让 ====================
  // R4：旧 creator 断言一律用非 admin 身份（observer 用户），防 admin bypass 污染判定。

  it('PATCH /doc-spaces/:id - editor 可改 name/description（内容字段走 policy write）', async () => {
    // 空间创建者是别人（非测试 actor），actor 以 editor 成员身份访问
    mockRepos.DocSpace.findOne.mockResolvedValue(
      makeSpace({ creatorId: '00000000-0000-4000-8000-0000000000bb' }),
    );
    // policy write：member 行 role=editor → 放行
    mockRepos.DocSpaceMember.findOne.mockResolvedValue({ role: 'editor' });

    return request(app.getHttpServer())
      .patch(`/doc-spaces/${spaceId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Editor Renamed', description: 'Editor written legend' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('name', 'Editor Renamed');
        expect(res.body.data).toHaveProperty('description', 'Editor written legend');
      });
  });

  it('PATCH /doc-spaces/:id - editor PATCH visibility → 403（结构字段 creator-only，R1 消息列字段名）', async () => {
    mockRepos.DocSpace.findOne.mockResolvedValue(
      makeSpace({ creatorId: '00000000-0000-4000-8000-0000000000bb' }),
    );
    mockRepos.DocSpaceMember.findOne.mockResolvedValue({ role: 'editor' });
    // owner-proxy 未命中（Agent.exists 显式 false；mock repo 默认无 exists 方法，不设会 500）
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);

    return request(app.getHttpServer())
      .patch(`/doc-spaces/${spaceId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ visibility: 'private' })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
        expect(res.body.message).toContain('visibility');
      });
  });

  it('POST /doc-spaces/:id/transfer-creator - creator 转让给 agent：新 creator（agent 身份）可改 visibility，旧 creator 403', async () => {
    const newCreatorAgentId = '00000000-0000-4000-8000-0000000000dd';
    // 旧 creator = 测试 observer 用户（非 admin，R4）
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    // 双层校验第二层：目标存在性 → actors 表 findOne（ACTOR_NOT_FOUND）
    mockRepos.Actor.findOne.mockResolvedValue({ id: newCreatorAgentId, type: 'agent' });
    // owner-proxy 未命中（mock repo 默认无 exists 方法，不设会 500）
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);
    // transfer 响应走 enrich（memberRepo.find/categoryRepo.find 默认 []，count 需 getRawOne）
    const countQb = genericQb({ getRawOne: jest.fn().mockResolvedValue({ count: '0' }) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(countQb);
    mockRepos.TaskDocLink.createQueryBuilder.mockReturnValue(countQb);

    // 转让：creator 闸门命中（creatorId === actor.id）→ service 置 creatorId 并 save
    await request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/transfer-creator`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ newCreatorId: newCreatorAgentId })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('creatorId', newCreatorAgentId);
      });

    // 旧 creator 的 member 行被删（干净交接：memberRepo.delete 被调）
    expect(mockRepos.DocSpaceMember.delete).toHaveBeenCalledWith({
      spaceId,
      actorId: newCreatorAgentId,
    });

    // ── 新 creator（agent 身份，API key → req.agent）PATCH visibility 成功 ──
    const guard: any = app.get(JwtOrApiKeyGuard);
    const originalCanActivate = guard.canActivate;
    guard.canActivate = (context: any) => {
      const req = context.switchToHttp().getRequest();
      req.user = undefined;
      req.agent = { id: newCreatorAgentId, name: 'Transfer Target Agent', permissions: ['*'] };
      return true;
    };
    try {
      mockRepos.DocSpace.findOne.mockResolvedValue({
        ...space,
        creatorId: newCreatorAgentId,
      });
      await request(app.getHttpServer())
        .patch(`/doc-spaces/${spaceId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ visibility: 'private' })
        .expect(200)
        .expect((res: any) => {
          expect(res.body.data).toHaveProperty('creatorId', newCreatorAgentId);
          expect(res.body.data.settings).toHaveProperty('visibility', 'private');
        });
    } finally {
      guard.canActivate = originalCanActivate;
    }

    // ── 旧 creator（人类 observer）再 PATCH visibility → 403（已非 creator，owner-proxy 未命中）──
    mockRepos.DocSpace.findOne.mockResolvedValue({ ...space, creatorId: newCreatorAgentId });
    return request(app.getHttpServer())
      .patch(`/doc-spaces/${spaceId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ visibility: 'private' })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('POST /doc-spaces/:id/transfer-creator - 目标 actor 不存在 → 404 ACTOR_NOT_FOUND', async () => {
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    // Actor.findOne 默认 undefined → resourceValidator 抛 404
    mockRepos.Actor.findOne.mockResolvedValue(undefined);

    return request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/transfer-creator`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ newCreatorId: '00000000-0000-4000-8000-0000000000ee' })
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.ACTOR_NOT_FOUND);
      });
  });

  it('POST /doc-spaces/:id/transfer-creator - 转给自己 → 409 RESOURCE_CONFLICT', async () => {
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    // 目标存在（自己也是合法 actor），但已是 creator → 409
    mockRepos.Actor.findOne.mockResolvedValue({ id: actorId, type: 'human' });

    return request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/transfer-creator`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ newCreatorId: actorId })
      .expect(409)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.RESOURCE_CONFLICT);
      });
  });

  // ==================== v1.38 overview 可配置过滤（HTTP 层 + ValidationPipe 链路） ====================

  it('GET /doc-spaces/:id/overview?maxTokens=abc - 400（DTO 校验失败）', async () => {
    // ValidationPipe 在 controller 之前拦截，无需 mock service 数据。
    // 校验失败是 BadRequestException（无自定义 code），过滤器 fallback → ErrorCode.BAD_REQUEST(400)
    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/overview?maxTokens=abc`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
      });
  });

  it('GET /doc-spaces/:id/overview?foo=bar - 400（forbidNonWhitelisted 未知参数）', async () => {
    // 评审 B5：引入 @Query() DTO 后全局 forbidNonWhitelisted 使未知 query 参数从静默忽略变 400
    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/overview?foo=bar`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
      });
  });

  it('GET /doc-spaces/:id/overview - per-call 过滤透传 service 并回显 appliedFilters', async () => {
    const space = makeSpace({
      settings: {
        visibility: 'open',
        overviewFilter: { excludeTypes: ['memory'] },
      },
    });
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const catQb = genericQb({ getMany: jest.fn().mockResolvedValue([makeCategory()]) });
    mockRepos.DocCategory.createQueryBuilder.mockReturnValue(catQb);

    // 3 篇文档：memory（空间默认应排除，但被 per-call type= 抑制）、guide/reference（保留）
    const memoryDoc = makeDoc({
      id: '00000000-0000-4000-8000-000000000402',
      docType: 'memory',
    });
    const guideDoc = makeDoc({
      id: '00000000-0000-4000-8000-000000000403',
      docType: 'guide',
    });
    const referenceDoc = makeDoc({
      id: '00000000-0000-4000-8000-000000000404',
      docType: 'reference',
    });
    const docQb = genericQb({
      getMany: jest.fn().mockResolvedValue([memoryDoc, guideDoc, referenceDoc]),
    });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/overview?type=guide,reference&maxTokens=6000`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        // 透传证据：service 确实收到了 query 并驱动了过滤查询
        expect(mockRepos.Doc.createQueryBuilder).toHaveBeenCalled();
        expect(mockRepos.DocCategory.createQueryBuilder).toHaveBeenCalled();
        // per-call type/maxTokens 透传回显
        expect(res.body.data.appliedFilters.types).toEqual(['guide', 'reference']);
        expect(res.body.data.appliedFilters.maxTokens).toBe(6000);
        // per-call type 白名单抑制空间默认 excludeTypes（plan WS2 语义）：不回显
        expect(res.body.data.appliedFilters.excludeTypes).toBeUndefined();
        // 结果只含 guide/reference，memory 被剔除
        const allDocs = [
          ...res.body.data.categories.flatMap((c: any) => c.docs),
          ...res.body.data.uncategorized,
        ];
        expect(allDocs.map((d: any) => d.docType).sort()).toEqual(['guide', 'reference']);
      });
  });

  // ==================== v1.41 空间图例（description 内嵌） ====================

  it('GET /doc-spaces/:id/overview - 默认内嵌 spaceDescription 图例全文 + legendTokenEstimate 单列', async () => {
    const space = makeSpace({ description: '## 空间图例\n\n由 PM 维护的 INDEX。' });
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const catQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.DocCategory.createQueryBuilder.mockReturnValue(catQb);
    const docQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/overview`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.spaceDescription).toBe('## 空间图例\n\n由 PM 维护的 INDEX。');
        expect(res.body.data.legendTokenEstimate).toBeGreaterThan(0);
        // 空文档时 totalTokenEstimate = 图例 token（仅信息回显）
        expect(res.body.data.totalTokenEstimate).toBe(res.body.data.legendTokenEstimate);
        expect(res.body.data.truncated).toBe(false);
      });
  });

  it('GET /doc-spaces/:id/overview?includeDescription=false - 省略图例字段（v1.41）', async () => {
    const space = makeSpace({ description: '## 图例' });
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const catQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.DocCategory.createQueryBuilder.mockReturnValue(catQb);
    const docQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/overview?includeDescription=false`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.spaceDescription).toBeUndefined();
        expect(res.body.data.legendTokenEstimate).toBeUndefined();
        expect(res.body.data.totalTokenEstimate).toBe(0);
      });
  });

  // ==================== v1.56 slim 投影（大空间瘦身） ====================

  it('GET /doc-spaces/:id/overview?slim=true — doc 条目只含 5 个导航字段（whitelist 放行）', async () => {
    const space = makeSpace({ description: null });
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const catQb = genericQb({
      getMany: jest
        .fn()
        .mockResolvedValue([makeCategory({ id: '00000000-0000-4000-8000-000000000401' })]),
    });
    mockRepos.DocCategory.createQueryBuilder.mockReturnValue(catQb);

    const docQb = genericQb({
      getMany: jest.fn().mockResolvedValue([
        makeDoc({
          id: '00000000-0000-4000-8000-000000000402',
          categoryId: '00000000-0000-4000-8000-000000000401',
          path: 'docs/a.md',
          title: 'A',
          summary: '摘要',
          docType: 'guide',
        }),
        makeDoc({
          id: '00000000-0000-4000-8000-000000000403',
          categoryId: null,
          path: 'memory/m.md',
          title: 'M',
          summary: '日记',
          docType: 'memory',
        }),
      ]),
    });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/overview?slim=true`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        // 分类分组结构保留，doc 条目裁到 5 个导航键
        const catDoc = res.body.data.categories[0].docs[0];
        expect(Object.keys(catDoc).sort()).toEqual([
          'docType',
          'path',
          'summary',
          'title',
          'tokenEstimate',
        ]);
        expect(catDoc).not.toHaveProperty('id');
        expect(catDoc).not.toHaveProperty('tags');
        // uncategorized 段同款投影
        const uncatDoc = res.body.data.uncategorized[0];
        expect(Object.keys(uncatDoc).sort()).toEqual([
          'docType',
          'path',
          'summary',
          'title',
          'tokenEstimate',
        ]);
        // slim 是 whitelisted query 参数（forbidNonWhitelisted 放行）——200 而非 400
        expect(res.status).toBe(200);
      });
  });

  // ==================== v1.42 B5 意图路由（doc_routes CRUD + overview 内嵌） ====================

  it('GET /doc-spaces/:id/routes — 排序返回全量意图路由', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const routeRows = [
      {
        id: '00000000-0000-4000-8000-000000000610',
        spaceId,
        intent: '我要了解系统架构',
        category: 'architecture',
        primaryDocId: docId,
        primaryHeadingPath: '你好世界',
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: 'apps/backend/src/app.module.ts',
        sortOrder: 1,
        createdBy: actorId,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      },
      {
        id: '00000000-0000-4000-8000-000000000611',
        spaceId,
        intent: '我要了解数据库设计',
        category: 'architecture',
        primaryDocId: docId,
        primaryHeadingPath: null,
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: null,
        sortOrder: 0,
        createdBy: actorId,
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02'),
      },
    ];
    mockRepos.DocRoute.find.mockResolvedValue(routeRows);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/routes`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        // 排序契约在 find 参数（sortOrder ASC + createdAt ASC，mock 原样透传不排序）
        expect(mockRepos.DocRoute.find).toHaveBeenCalledWith({
          where: { spaceId },
          order: { sortOrder: 'ASC', createdAt: 'ASC' },
        });
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0].intent).toBe('我要了解系统架构');
        expect(res.body.data[1].intent).toBe('我要了解数据库设计');
      });
  });

  // ==================== v1.55 routes 列表增强（分页 + q/category 过滤） ====================

  it('GET /doc-spaces/:id/routes?page=1&pageSize=1 — 分页信封（items/total/hasNext）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const routeRow = {
      id: '00000000-0000-4000-8000-000000000610',
      spaceId,
      intent: '我要了解系统架构',
      category: 'architecture',
      primaryDocId: docId,
      primaryHeadingPath: null,
      secondaryDocId: null,
      secondaryHeadingPath: null,
      codeEntry: null,
      sortOrder: 0,
      createdBy: actorId,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    };
    const pagedQb = genericQb({
      getManyAndCount: jest.fn().mockResolvedValue([[routeRow], 2]),
    });
    mockRepos.DocRoute.createQueryBuilder.mockReturnValue(pagedQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/routes?page=1&pageSize=1`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        // 分页模式 → 标准信封（非数组），skip/take 由 page/pageSize 派生
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.total).toBe(2);
        expect(res.body.data.page).toBe(1);
        expect(res.body.data.pageSize).toBe(1);
        expect(res.body.data.totalPages).toBe(2);
        expect(res.body.data.hasNext).toBe(true);
        expect(res.body.data.hasPrev).toBe(false);
        expect(pagedQb.skip).toHaveBeenCalledWith(0);
        expect(pagedQb.take).toHaveBeenCalledWith(1);
        // 分页模式不触碰 legacy find 路径
        expect(mockRepos.DocRoute.find).not.toHaveBeenCalled();
      });
  });

  it('GET /doc-spaces/:id/routes?q=架构 — q 过滤走 intent ILIKE（传统数组形状不变）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const filteredQb = genericQb({
      getMany: jest.fn().mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000610',
          spaceId,
          intent: '我要了解系统架构',
          category: null,
          primaryDocId: docId,
          primaryHeadingPath: null,
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          sortOrder: 0,
          createdBy: actorId,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ]),
    });
    mockRepos.DocRoute.createQueryBuilder.mockReturnValue(filteredQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/routes?q=架构`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        // 仅过滤不分页 → 保持传统数组形状（向后兼容）
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.data).toHaveLength(1);
        expect(filteredQb.andWhere).toHaveBeenCalledWith('r.intent ILIKE :q', { q: '%架构%' });
      });
  });

  it('GET /doc-spaces/:id/routes?category=ops — category 精确过滤', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const filteredQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.DocRoute.createQueryBuilder.mockReturnValue(filteredQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/routes?category=ops`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toEqual([]);
        expect(filteredQb.andWhere).toHaveBeenCalledWith('r.category = :category', {
          category: 'ops',
        });
      });
  });

  it('GET /doc-spaces/:id/routes?pageSize=101 — 400（分页硬上限 100，铁律 #21 不透传 DB）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/routes?pageSize=101`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400);
  });

  it('GET /doc-spaces/:id/routes?page=0 — 400（page 最小 1）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/routes?page=0`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400);
  });

  it('GET /doc-spaces/:id/routes?foo=bar — 400（forbidNonWhitelisted 未知参数）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/routes?foo=bar`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400);
  });

  it('POST /doc-spaces/:id/routes — 创建成功（写时校验通过，createdBy=actor.id）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // primary doc 存在且属于该空间
    mockRepos.Doc.findOne.mockResolvedValue(makeDoc());
    // headingPath 精确命中（sectionExistsByHeadingPath → sectionRepo QB getOne）
    const sectionQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeSection()) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    mockRepos.DocRoute.create.mockImplementation((x: any) => x);
    mockRepos.DocRoute.save.mockImplementation(async (x: any) => ({
      ...x,
      id: '00000000-0000-4000-8000-000000000612',
    }));

    return request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/routes`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        intent: '我要了解系统架构',
        category: 'architecture',
        primaryDocId: docId,
        primaryHeadingPath: '你好世界',
        codeEntry: 'apps/backend/src/app.module.ts',
        sortOrder: 2,
      })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data.primaryDocId).toBe(docId);
        expect(res.body.data.primaryHeadingPath).toBe('你好世界');
        expect(res.body.data.createdBy).toBe(actorId);
      });
  });

  it('POST /doc-spaces/:id/routes — codeEntryType:pattern 创建（DTO 枚举放行 + 落库透传，T5）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // primary doc 存在且属于该空间
    mockRepos.Doc.findOne.mockResolvedValue(makeDoc());

    mockRepos.DocRoute.create.mockImplementation((x: any) => x);
    mockRepos.DocRoute.save.mockImplementation(async (x: any) => ({
      ...x,
      id: '00000000-0000-4000-8000-000000000613',
    }));

    return request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/routes`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        intent: '我要找到页面文件',
        primaryDocId: docId,
        codeEntry: 'apps/web/app/**' + '/page.tsx',
        codeEntryType: 'pattern',
      })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data.codeEntryType).toBe('pattern');
        expect(res.body.data.codeEntry).toBe('apps/web/app/**' + '/page.tsx');
      });
  });

  it('POST /doc-spaces/:id/routes — codeEntryType 非法值 400（DTO IsIn 白名单）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/routes`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ intent: 'i', primaryDocId: docId, codeEntryType: 'glob' })
      .expect(400);
  });

  it('POST /doc-spaces/:id/routes/recheck — 全量重检落库 health，返回 {rechecked, broken}', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // 两条路由：r1 带 primaryHeadingPath（存在）、r2 文档级跳转（无锚点）
    const routeRows = [
      {
        id: '00000000-0000-4000-8000-000000000610',
        spaceId,
        intent: '我要了解系统架构',
        category: 'architecture',
        primaryDocId: docId,
        primaryHeadingPath: '你好世界',
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: 'apps/backend/src/app.module.ts',
        sortOrder: 1,
        createdBy: actorId,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        health: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000611',
        spaceId,
        intent: '我要了解数据库设计',
        category: 'architecture',
        primaryDocId: docId,
        primaryHeadingPath: null,
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: null,
        sortOrder: 0,
        createdBy: actorId,
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02'),
        health: null,
      },
    ];
    mockRepos.DocRoute.find.mockResolvedValue(routeRows);
    // headingPath 精确命中（sectionExistsByHeadingPath → sectionRepo QB getOne）
    const sectionQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeSection()) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/routes/recheck`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toEqual({ rechecked: 2, broken: 0 });
        // 全量批量落库：每条路由 health 已装配（issues 空 = 健康；checkedAt ISO 时间戳）
        const saved = mockRepos.DocRoute.save.mock.calls[0][0] as any[];
        expect(saved).toHaveLength(2);
        expect(saved[0].health.issues).toEqual([]);
        expect(saved[1].health.issues).toEqual([]);
        expect(saved[0].health.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // 重检走 section 精确命中（复用 DocService.sectionExistsByHeadingPath）
        expect(sectionQb.getOne).toHaveBeenCalled();
      });
  });

  it('recheck — pattern 型 codeEntry 豁免（T5）：codeEntryStatus:exempt 不报 broken；exact 失配照报 broken', async () => {
    const space = makeSpace({
      // 挂 repoManifest：exact 路由走真实存在性校验；pattern 路由豁免（与 manifest 有无无关）
      settings: {
        repoManifest: { sha: 'abc', files: ['apps/web/app/page.tsx'], reportedAt: 'x' },
      },
    });
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const routeRows = [
      {
        id: '00000000-0000-4000-8000-000000000614',
        spaceId,
        intent: '我要找到页面文件',
        category: null,
        primaryDocId: docId,
        primaryHeadingPath: null,
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: 'apps/web/app/**' + '/page.tsx',
        codeEntryType: 'pattern',
        sortOrder: 0,
        createdBy: actorId,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        health: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000615',
        spaceId,
        intent: '我要了解已删除文件',
        category: null,
        primaryDocId: docId,
        primaryHeadingPath: null,
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: 'apps/gone.ts',
        codeEntryType: 'exact',
        sortOrder: 1,
        createdBy: actorId,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        health: null,
      },
    ];
    mockRepos.DocRoute.find.mockResolvedValue(routeRows);
    const sectionQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeSection()) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/routes/recheck`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        // pattern 豁免 → 不算 broken；exact 失配 → broken 照计
        expect(res.body.data).toEqual({ rechecked: 2, broken: 1 });
        const saved = mockRepos.DocRoute.save.mock.calls[0][0] as any[];
        expect(saved[0].health).toMatchObject({
          issues: [],
          codeEntryStatus: 'exempt',
        });
        expect(saved[0].health.codeEntryNote).toEqual(expect.any(String));
        expect(saved[1].health).toMatchObject({
          codeEntryStatus: 'broken',
        });
        expect(saved[1].health.issues).toEqual([
          { kind: 'codeEntry', target: 'codeEntry', value: 'apps/gone.ts' },
        ]);
      });
  });

  it('PUT /doc-spaces/:id/repo-manifest — 200：原子 jsonb_set 落库，reportedAt 服务端生成', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const manifest = {
      sha: 'e75475d3c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d',
      files: ['apps/backend/src/app.module.ts', 'docs/architecture.md'],
      reportedAt: '2026-08-06T00:00:00.000Z',
    };
    mockRepos.DocSpace.query.mockResolvedValue([
      { settings: { ...space.settings, repoManifest: manifest } },
    ]);

    return request(app.getHttpServer())
      .put(`/doc-spaces/${spaceId}/repo-manifest`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ sha: manifest.sha, files: manifest.files })
      .expect(200)
      .expect((res: any) => {
        // 响应 = 写后 settings.repoManifest（RETURNING 读回）；reportedAt 服务端 ISO 时间戳
        expect(res.body.data.repoManifest.sha).toBe(manifest.sha);
        expect(res.body.data.repoManifest.files).toEqual(manifest.files);
        expect(res.body.data.repoManifest.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // 原子 jsonb_set：单条 UPDATE 只动 repoManifest 键（对齐 board metrics 先例）
        const [sql, params] = mockRepos.DocSpace.query.mock.calls[0] as [string, [string, string]];
        expect(sql).toContain("jsonb_set(settings, '{repoManifest}', $1::jsonb)");
        expect(params[1]).toBe(spaceId);
        // 请求不含 reportedAt（服务端生成，不信客户端）
        const payload = JSON.parse(params[0]) as { reportedAt: string };
        expect(payload.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });
  });

  it('PUT /doc-spaces/:id/repo-manifest — 400：files 超 20000 条（DTO arrayMaxSize）', async () => {
    // 用最短文件名（'a'×20001）控制 body < 100kb（E2E app 默认 body 限制；生产 main.ts 为 5mb），
    // 使请求能到达 ValidationPipe 触发 arrayMaxSize 400。真实 20001 长名边界由 DTO 单测覆盖。
    const files = Array.from({ length: 20001 }, () => 'a');
    return request(app.getHttpServer())
      .put(`/doc-spaces/${spaceId}/repo-manifest`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ sha: 'e75475d3c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d', files })
      .expect(400);
  });

  it('PUT /doc-spaces/:id/repo-manifest — 400：绝对路径文件（自定义约束）', async () => {
    return request(app.getHttpServer())
      .put(`/doc-spaces/${spaceId}/repo-manifest`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ sha: 'e75475d3c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d', files: ['/etc/passwd'] })
      .expect(400);
  });

  it('PUT /doc-spaces/:id/repo-manifest — 400：`..` 段文件（自定义约束）', async () => {
    return request(app.getHttpServer())
      .put(`/doc-spaces/${spaceId}/repo-manifest`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ sha: 'e75475d3c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d', files: ['apps/../secret'] })
      .expect(400);
  });

  it('PUT /doc-spaces/:id/repo-manifest — 400：sha 超 64 字符（DTO maxLength）', async () => {
    return request(app.getHttpServer())
      .put(`/doc-spaces/${spaceId}/repo-manifest`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ sha: 'a'.repeat(65), files: ['apps/backend/src/app.module.ts'] })
      .expect(400);
  });

  it('POST /doc-spaces/:id/routes — 写时校验 400：headingPath 不可解析', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // primary doc 存在
    mockRepos.Doc.findOne.mockResolvedValue(makeDoc());
    // headingPath 精确命中失败（section exists 查询返回 null）
    const sectionQb = genericQb({ getOne: jest.fn().mockResolvedValue(null) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/routes`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        intent: '我要了解系统架构',
        primaryDocId: docId,
        primaryHeadingPath: '## 不存在的节',
      })
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.DOC_ROUTE_HEADING_UNRESOLVED);
      });
  });

  it('POST /doc-spaces/:id/routes — 写时校验 400：doc 不属于该空间', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // doc 存在但属于其他空间（空间归属不符）
    mockRepos.Doc.findOne.mockResolvedValue(
      makeDoc({ spaceId: '00000000-0000-4000-8000-000000000999' }),
    );

    return request(app.getHttpServer())
      .post(`/doc-spaces/${spaceId}/routes`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ intent: '我要了解系统架构', primaryDocId: docId })
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.DOC_ROUTE_DOC_NOT_FOUND);
      });
  });

  it('GET /doc-spaces/:id/overview — 默认内嵌 routes 全量 + routesTokenEstimate 单列', async () => {
    const space = makeSpace({ description: '## 空间图例' });
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const catQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.DocCategory.createQueryBuilder.mockReturnValue(catQb);
    const docQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);

    const routeRows = [
      {
        id: '00000000-0000-4000-8000-000000000613',
        spaceId,
        intent: '我要了解系统架构',
        category: 'architecture',
        primaryDocId: docId,
        primaryHeadingPath: null,
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: null,
        sortOrder: 0,
        createdBy: actorId,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      },
    ];
    mockRepos.DocRoute.find.mockResolvedValue(routeRows);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/overview`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        // 默认内嵌 routes（全量，不占 maxTokens 预算）
        expect(res.body.data.routes).toHaveLength(1);
        expect(res.body.data.routes[0].intent).toBe('我要了解系统架构');
        // routesTokenEstimate 单列 + 计入 totalTokenEstimate（图例 + routes 合计）
        expect(res.body.data.routesTokenEstimate).toBeGreaterThan(0);
        expect(res.body.data.totalTokenEstimate).toBe(
          res.body.data.legendTokenEstimate + res.body.data.routesTokenEstimate,
        );
        expect(res.body.data.truncated).toBe(false);
        // v1.55：≤50 条不截断，标记字段恒返回（includeRoutes=true 时）
        expect(res.body.data.routesTruncated).toBe(false);
        expect(res.body.data.routesTotal).toBe(1);
      });
  });

  it('GET /doc-spaces/:id/overview — routes >50 条截断到前 50 + routesTruncated/routesTotal（v1.55 防爆）', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const catQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.DocCategory.createQueryBuilder.mockReturnValue(catQb);
    const docQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);

    // 51 条路由：最小越界样本（模拟最重租户 191 条的真实压力）
    const routeRows = Array.from({ length: 51 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      spaceId,
      intent: `我要了解第 ${i} 号功能`,
      category: null,
      primaryDocId: docId,
      primaryHeadingPath: null,
      secondaryDocId: null,
      secondaryHeadingPath: null,
      codeEntry: null,
      sortOrder: i,
      createdBy: actorId,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    }));
    mockRepos.DocRoute.find.mockResolvedValue(routeRows);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/overview`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.routes).toHaveLength(50);
        expect(res.body.data.routesTruncated).toBe(true);
        expect(res.body.data.routesTotal).toBe(51);
        // 截断保留策展序头部，尾部走分页端点获取
        expect(res.body.data.routes[0].intent).toBe('我要了解第 0 号功能');
        expect(res.body.data.routes[49].intent).toBe('我要了解第 49 号功能');
      });
  });

  it('GET /doc-spaces/:id/overview?includeRoutes=false — 省略 routes/routesTokenEstimate', async () => {
    const space = makeSpace();
    mockRepos.DocSpace.findOne.mockResolvedValue(space);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const catQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.DocCategory.createQueryBuilder.mockReturnValue(catQb);
    const docQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);

    return request(app.getHttpServer())
      .get(`/doc-spaces/${spaceId}/overview?includeRoutes=false`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.routes).toBeUndefined();
        expect(res.body.data.routesTokenEstimate).toBeUndefined();
        expect(mockRepos.DocRoute.find).not.toHaveBeenCalled();
      });
  });

  // ==================== v1.55 T3 section 级写（PATCH /docs/:id/sections/:position） ====================
  // 重建管线（chunk/派生数据一致性）由真实 PG 集成套件覆盖（docspace-patch.e2e-spec.ts）；
  // 本段只覆盖 HTTP 层路由/双层校验/权限边界。

  it('PATCH /docs/:id/sections/:position — 200：creator 写放行，走 upsert 重建管线返回结果', async () => {
    // findById（doc → space 解析链）
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // patchSection 全量 section 查询（position ASC）
    const sectionQb = genericQb({ getMany: jest.fn().mockResolvedValue([makeSection()]) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    // upsert 内部：crypto 全局 mock 恒返 'mocked-hash' === makeDoc().contentHash
    // → unchanged 早退（无需 transaction mock；linkHealth backfill 走 QB update 链）
    const spaceDocsQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    // Doc QB 消费顺序：controller findById → patchSection 内 findById → upsert existing
    // 查询 → linkHealth 候选 → linkHealth backfill update
    mockRepos.Doc.createQueryBuilder
      .mockReturnValueOnce(docQb)
      .mockReturnValueOnce(docQb)
      .mockReturnValueOnce(docQb)
      .mockReturnValueOnce(spaceDocsQb)
      .mockReturnValueOnce(genericQb());

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/sections/0`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: '# 你好世界\n\n替换后的正文' })
      .expect(200)
      .expect((res: any) => {
        // unchanged 早退 = upsert 管线被完整驱动的证明（hash mock 恒等）
        expect(res.body.data).toHaveProperty('id', docId);
        expect(res.body.data).toHaveProperty('path', 'test.md');
        expect(res.body.data.unchanged).toBe(true);
      });
  });

  it('PATCH /docs/:id/sections/-1 — 400：负数 position 在格式层拦截（VALIDATION_ERROR）', async () => {
    return request(app.getHttpServer())
      .patch(`/docs/${docId}/sections/-1`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'x' })
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
      });
  });

  it('PATCH /docs/:id/sections/abc — 400：非整数 position（ParseIntPipe 格式层）', async () => {
    return request(app.getHttpServer())
      .patch(`/docs/${docId}/sections/abc`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'x' })
      .expect(400);
  });

  it('PATCH /docs/:id/sections/:position — 400：body 缺 content（DTO 必填）', async () => {
    return request(app.getHttpServer())
      .patch(`/docs/${docId}/sections/0`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({})
      .expect(400);
  });

  it('PATCH /docs/:id/sections/:position — 404：文档不存在（DOC_NOT_FOUND，铁律 #22）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(null) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/sections/0`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'x' })
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.DOC_NOT_FOUND);
      });
  });

  it('PATCH /docs/:id/sections/99 — 404：position 越界（业务存在性层，与 getSection 锚点缺失同 code）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    // 该文档只有 1 个 section → position 99 越界
    const sectionQb = genericQb({ getMany: jest.fn().mockResolvedValue([makeSection()]) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/sections/99`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'x' })
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.DOC_NOT_FOUND);
        expect(res.body.message).toContain('out of range');
      });
  });

  it('PATCH /docs/:id/sections/:position — 403：非 creator/editor 拒绝写（权限在 Controller 层）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    // 空间创建者是别人，actor 也不是成员 → write 拒绝
    mockRepos.DocSpace.findOne.mockResolvedValue(
      makeSpace({ creatorId: '00000000-0000-4000-8000-0000000000bb' }),
    );
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);
    // owner-proxy 未命中（mock repo 默认无 exists 方法，不设会 500；同 DOCSPACE-PERM 先例）
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/sections/0`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'x' })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('PATCH /docs/:id/sections/:position — expectedSectionHash 相符 → 200 放行（fail-closed 前提校验通过）', async () => {
    // crypto 全局 mock 恒返 'mocked-hash' → 服务端重算的 sectionHash === 'mocked-hash'
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const sectionQb = genericQb({ getMany: jest.fn().mockResolvedValue([makeSection()]) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    // upsert 走 unchanged 早退（hash mock 恒等），Doc QB 消费顺序同 200 用例
    const spaceDocsQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.Doc.createQueryBuilder
      .mockReturnValueOnce(docQb)
      .mockReturnValueOnce(docQb)
      .mockReturnValueOnce(docQb)
      .mockReturnValueOnce(spaceDocsQb)
      .mockReturnValueOnce(genericQb());

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/sections/0`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: '# 你好世界\n\n替换后的正文', expectedSectionHash: 'mocked-hash' })
      .expect(200);
  });

  it('PATCH /docs/:id/sections/:position — expectedSectionHash 不符 → 409 DOC_CONTENT_CONFLICT（stale 写不进去）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const sectionQb = genericQb({ getMany: jest.fn().mockResolvedValue([makeSection()]) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/sections/0`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'x', expectedSectionHash: 'stale-hash' })
      .expect(409)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.DOC_CONTENT_CONFLICT);
        expect(res.body.message).toContain('expectedSectionHash');
      });
  });

  // ==================== fail-closed 改造：match 模式写（PATCH /docs/:id/content） ====================
  // 全文重建/计数语义由真实 PG 集成套件覆盖（docspace-patch.e2e-spec.ts）；
  // 本段只覆盖 HTTP 层路由/DTO 校验/命中分支的错误透传。

  it('PATCH /docs/:id/content — 200：唯一命中替换，走 upsert 管线返回（带 contentHash）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const sectionQb = genericQb({ getMany: jest.fn().mockResolvedValue([makeSection()]) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    // oldString '这是一段中文测试内容' 在重建全文中唯一命中；
    // upsert 走 unchanged 早退（crypto mock 恒等），Doc QB 消费顺序：
    // controller findById → patchByMatch findById → upsert existing 查询 → linkHealth 候选 → backfill update
    const spaceDocsQb = genericQb({ getMany: jest.fn().mockResolvedValue([]) });
    mockRepos.Doc.createQueryBuilder
      .mockReturnValueOnce(docQb)
      .mockReturnValueOnce(docQb)
      .mockReturnValueOnce(docQb)
      .mockReturnValueOnce(spaceDocsQb)
      .mockReturnValueOnce(genericQb());

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ oldString: '这是一段中文测试内容', newString: '替换后的内容' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveProperty('id', docId);
        expect(res.body.data).toHaveProperty('contentHash');
      });
  });

  it('PATCH /docs/:id/content — 400：body 缺 oldString / oldString 空串（DTO 格式层拦截）', async () => {
    await request(app.getHttpServer())
      .patch(`/docs/${docId}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ newString: 'x' })
      .expect(400);

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ oldString: '', newString: 'x' })
      .expect(400);
  });

  it('PATCH /docs/:id/content — 404：oldString 零命中（DOC_NOT_FOUND，提示先读）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const sectionQb = genericQb({ getMany: jest.fn().mockResolvedValue([makeSection()]) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ oldString: '全文中不存在的字符串xyz', newString: 'x' })
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.DOC_NOT_FOUND);
        expect(res.body.message).toContain('0 matches');
      });
  });

  it('PATCH /docs/:id/content — 409：多命中（RESOURCE_CONFLICT + matchCount，绝不静默替换）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(makeSpace());
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);

    const sectionQb = genericQb({ getMany: jest.fn().mockResolvedValue([makeSection()]) });
    mockRepos.DocSection.createQueryBuilder.mockReturnValue(sectionQb);

    // makeSection 的 content 自带标题行文本，重建后 '# 你好世界' 出现 2 次（插回标题行 + content 内）
    return request(app.getHttpServer())
      .patch(`/docs/${docId}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ oldString: '# 你好世界', newString: 'x' })
      .expect(409)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.RESOURCE_CONFLICT);
        expect(res.body.message).toContain('matches');
      });
  });

  it('PATCH /docs/:id/content — 404：文档不存在（DOC_NOT_FOUND，铁律 #22）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(null) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ oldString: 'x', newString: 'y' })
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.DOC_NOT_FOUND);
      });
  });

  it('PATCH /docs/:id/content — 403：非 creator/editor 拒绝写（权限在 Controller 层）', async () => {
    const docQb = genericQb({ getOne: jest.fn().mockResolvedValue(makeDoc()) });
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.findOne.mockResolvedValue(
      makeSpace({ creatorId: '00000000-0000-4000-8000-0000000000bb' }),
    );
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);

    return request(app.getHttpServer())
      .patch(`/docs/${docId}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ oldString: 'x', newString: 'y' })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });
});
