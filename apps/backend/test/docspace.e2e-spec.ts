import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createTestingApp } from './test-setup';
import { ErrorCode, TaskStatus } from '@agent-chamber/shared';

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
  const spaceId   = '00000000-0000-4000-8000-000000000100';
  const boardId   = '00000000-0000-4000-8000-000000000200';
  const listId    = '00000000-0000-4000-8000-000000000210';
  const taskId    = '00000000-0000-4000-8000-000000000300';
  const docId     = '00000000-0000-4000-8000-000000000400';
  const sectionId = '00000000-0000-4000-8000-000000000410';
  const actorId   = '00000000-0000-4000-8000-000000000005';
  const catId     = '00000000-0000-4000-8000-000000000500';

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
    mgr.createQueryBuilder = jest.fn()
      .mockReturnValueOnce(searchQb)
      .mockReturnValue(headlineQb);

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
      .mockReturnValueOnce(docFindQb)  // (a) controller findById
      .mockReturnValueOnce(docFindQb)  // (b) service.remove findById
      .mockReturnValue(updateQb);      // (c) soft-delete update

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
    dsManager.createQueryBuilder = jest.fn()
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
    dsManager.createQueryBuilder = jest.fn()
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
});
