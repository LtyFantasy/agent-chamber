import { Repository, SelectQueryBuilder } from 'typeorm';
import { DocService } from './doc.service';
import { chunkMarkdown } from './markdown-chunker';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocVersion } from '../../database/entities/doc-version.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Board } from '../../database/entities/board.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { ErrorCode, AuditAction, ActorType, EventType } from '@agent-chamber/shared';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { EventService } from '../event/event.service';
import { RouteHealthService } from './route-health.service';
import type { BatchUpsertItemDto } from './dto';

describe('DocService', () => {
  let service: DocService;
  let docRepo: jest.Mocked<Repository<Doc>>;
  let sectionRepo: jest.Mocked<Repository<DocSection>>;
  let versionRepo: jest.Mocked<Repository<DocVersion>>;
  let categoryRepo: jest.Mocked<Repository<DocCategory>>;
  let auditRepo: jest.Mocked<Repository<AuditLog>>;
  let docSpaceRepo: jest.Mocked<Repository<DocSpace>>;
  let boardRepo: jest.Mocked<Repository<Board>>;
  // v1.63.0 幂等 repo mock：本套件不测幂等路径（e2e 覆盖），仅防构造参数缺失
  let idempotencyRepo: jest.Mocked<Partial<Repository<IdempotencyRecord>>>;
  let eventService: { create: jest.Mock };
  let routeHealthService: { recheckSpace: jest.Mock };
  let mockTransaction: jest.Mock;

  /** 冲刷 setImmediate 队列：让 upsert/remove 里 fire-and-forget 的异步任务先于本回调执行 */
  const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

  function makeDoc(overrides: Partial<Doc> = {}): Doc {
    return {
      id: 'doc-1',
      spaceId: 'space-1',
      categoryId: null,
      path: 'docs/test.md',
      title: 'Test Doc',
      summary: 'A test document',
      docType: null,
      tags: [],
      source: 'native',
      contentHash: 'abc123',
      sourceSha: null,
      sectionCount: 1,
      tokenEstimate: 100,
      linkHealth: null,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    } as Doc;
  }

  function makeCategory(overrides: Partial<DocCategory> = {}): DocCategory {
    return {
      id: 'cat-1',
      spaceId: 'space-1',
      name: 'Test',
      slug: 'test',
      description: null,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    } as DocCategory;
  }

  function makeSection(overrides: Partial<DocSection> = {}): DocSection {
    return {
      id: 'sec-1',
      docId: 'doc-1',
      position: 0,
      headingPath: 'Test',
      headingLevel: 1,
      isContinuation: false,
      content: 'Content here.',
      tokenEstimate: 50,
      searchVector: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as DocSection;
  }

  function createMockQueryBuilder<T>(items: T[], count: number) {
    return {
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([items, count]),
      getMany: jest.fn().mockResolvedValue(items),
      getOne: jest.fn().mockResolvedValue(items[0] ?? null),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue({ count: '0' }),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    } as unknown as SelectQueryBuilder<any>;
  }

  beforeEach(() => {
    // Transaction mock: by default just invokes the callback with a simple manager
    mockTransaction = jest.fn((fn: any) =>
      fn({
        getRepository: jest.fn(() => ({
          save: jest.fn((x: any) => Promise.resolve(x)),
          create: jest.fn((x: any) => x),
          createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
        })),
      }),
    );

    docRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
      manager: {
        transaction: mockTransaction as any,
      },
    } as unknown as jest.Mocked<Repository<Doc>>;

    sectionRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
    } as unknown as jest.Mocked<Repository<DocSection>>;

    categoryRepo = {
      findOne: jest.fn(),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
    } as unknown as jest.Mocked<Repository<DocCategory>>;

    auditRepo = {
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
    } as unknown as jest.Mocked<Repository<AuditLog>>;

    docSpaceRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
    } as unknown as jest.Mocked<Repository<DocSpace>>;

    boardRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Board>>;

    versionRepo = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    } as unknown as jest.Mocked<Repository<DocVersion>>;

    // v1.63.0 幂等 repo mock：findOne 默认 null（无重放）、save 透传；本套件不测幂等
    // 路径（真实 PG e2e 覆盖），仅防构造参数缺失
    idempotencyRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    } as unknown as jest.Mocked<Partial<Repository<IdempotencyRecord>>>;

    eventService = {
      create: jest.fn().mockResolvedValue({}),
    };

    routeHealthService = {
      recheckSpace: jest.fn().mockResolvedValue({ rechecked: 0, broken: 0 }),
    };

    service = new DocService(
      docRepo,
      sectionRepo,
      categoryRepo,
      auditRepo,
      docSpaceRepo,
      boardRepo,
      versionRepo,
      eventService as unknown as EventService,
      routeHealthService as unknown as RouteHealthService,
      idempotencyRepo as unknown as Repository<IdempotencyRecord>,
    );
  });

  afterEach(() => jest.resetAllMocks());

  // ─── findById ───────────────────────────────────────────────

  describe('findById', () => {
    it('returns doc when found', async () => {
      const doc = makeDoc();
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.findById('doc-1');
      expect(result).toBe(doc);
    });

    it('throws DOC_NOT_FOUND when not found', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await expect(service.findById('doc-1')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });
  });

  // ─── upsert ─────────────────────────────────────────────────

  describe('upsert', () => {
    const dto = {
      path: 'docs/test.md',
      content: '# Hello\n\nSome content.',
    };

    it('creates a new document on first upsert', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      // Transaction creates the doc
      const createdDoc = makeDoc({ id: 'doc-new', sectionCount: 2, tokenEstimate: 42 });
      mockTransaction.mockResolvedValue({
        doc: createdDoc,
        assembled: { ...createdDoc, created: true },
      });

      const result = await service.upsert('space-1', dto);
      expect(result.path).toBe('docs/test.md');
      expect(result.sectionCount).toBe(2);
      expect(result.unchanged).toBeUndefined();
      expect(result.created).toBe(true);
    });

    it('returns unchanged when contentHash matches', async () => {
      const testContent = '# Hello\n\nSome content.';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({ contentHash: hash });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
      });
      expect(result.unchanged).toBe(true);
      expect(result.id).toBe('doc-1');
      expect(result.created).toBeUndefined();
    });

    // ─── sourceSha（v1.42 B6，last-verified 语义） ─────────────

    it('create: persists sourceSha when payload carries it', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      // 自定义事务：暴露 manager repo 的 create spy 以断言落库字段
      const createSpy = jest.fn((x: unknown) => x);
      const managerRepo = {
        save: jest.fn((x: unknown) => Promise.resolve(x)),
        create: createSpy,
        createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
      };
      mockTransaction.mockImplementation((fn: any) => fn({ getRepository: () => managerRepo }));

      await service.upsert('space-1', { ...dto, sourceSha: 'sha-abc123' });

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ sourceSha: 'sha-abc123' }));
    });

    it('create: sourceSha stays null when payload omits it (native docs)', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const createSpy = jest.fn((x: unknown) => x);
      const managerRepo = {
        save: jest.fn((x: unknown) => Promise.resolve(x)),
        create: createSpy,
        createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
      };
      mockTransaction.mockImplementation((fn: any) => fn({ getRepository: () => managerRepo }));

      await service.upsert('space-1', dto);

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ sourceSha: null }));
    });

    it('unchanged content + no payload sourceSha → pure early return, zero writes', async () => {
      const testContent = '# Hello\n\nSome content.';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      // linkHealth 非 null：跳过 backfill 分支，隔离 sourceSha 逻辑
      const existingDoc = makeDoc({
        contentHash: hash,
        sourceSha: 'old-sha',
        linkHealth: { total: 0, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
      });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
      });
      expect(result.unchanged).toBe(true);
      // 完全照旧早退：不触发任何 update
      expect(qb.update).not.toHaveBeenCalled();
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('unchanged content + same sourceSha → no refresh write', async () => {
      const testContent = '# Hello\n\nSome content.';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({
        contentHash: hash,
        sourceSha: 'same-sha',
        linkHealth: { total: 0, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
      });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
        sourceSha: 'same-sha',
      });
      expect(result.unchanged).toBe(true);
      expect(qb.update).not.toHaveBeenCalled();
    });

    it('unchanged content + different sourceSha → refreshes source_sha column only, still unchanged:true', async () => {
      const testContent = '# Hello\n\nSome content.';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({
        contentHash: hash,
        sourceSha: 'old-sha',
        linkHealth: { total: 0, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
      });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
        sourceSha: 'new-sha',
      });
      expect(result.unchanged).toBe(true);
      // last-verified 语义：仅刷新 source_sha 列（不碰 sections/contentHash/其他元数据），
      // 响应仍 unchanged:true（sync 即验证，unchanged 文档也推进验证点）
      expect(qb.update).toHaveBeenCalledWith('Doc');
      expect((qb as any).set).toHaveBeenCalledWith({ sourceSha: 'new-sha' });
      expect((qb as any).execute).toHaveBeenCalled();
    });

    it('content change + payload sourceSha → new sha persisted; without → old sha kept', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash', sourceSha: 'old-sha' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      // 事务真实执行：捕获 manager repo 的 save 以断言实体字段
      const saveSpy = jest.fn((x: unknown) => Promise.resolve(x));
      const managerRepo = {
        save: saveSpy,
        create: jest.fn((x: unknown) => x),
        createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
      };
      mockTransaction.mockImplementation((fn: any) => fn({ getRepository: () => managerRepo }));

      await service.upsert('space-1', { ...dto, sourceSha: 'new-sha' });
      expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ sourceSha: 'new-sha' }));

      // 第二次：独立 doc 实例（避免首轮事务对同一引用的原地变更污染断言）
      const existingDoc2 = makeDoc({ contentHash: 'oldhash', sourceSha: 'old-sha' });
      const qb2 = createMockQueryBuilder([existingDoc2], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb2);
      saveSpy.mockClear();
      await service.upsert('space-1', dto);
      // native 编辑不带 sha → 保留旧验证 sha（旧 sha 显 stale 正是消费端新鲜度比较的用途）
      expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ sourceSha: 'old-sha' }));
    });

    it('updates document on content change', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const updatedDoc = makeDoc({ sectionCount: 3, tokenEstimate: 150, contentHash: 'newhash' });
      mockTransaction.mockResolvedValue({
        doc: updatedDoc,
        assembled: { ...updatedDoc, created: false },
      });

      const result = await service.upsert('space-1', dto);
      expect(result.unchanged).toBeUndefined();
      expect(result.sectionCount).toBe(3);
      expect(result.created).toBe(false);
    });

    it('auto-creates category by name', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const catQb = createMockQueryBuilder([], 0);
      (categoryRepo.createQueryBuilder as jest.Mock).mockReturnValue(catQb);

      categoryRepo.create.mockReturnValue(
        makeCategory({ name: 'Architecture', slug: 'architecture' }),
      );
      categoryRepo.save.mockResolvedValue(makeCategory({ id: 'cat-new', name: 'Architecture' }));

      mockTransaction.mockResolvedValue({
        doc: makeDoc({ id: 'doc-new', categoryId: 'cat-new' }),
        assembled: { ...makeDoc({ id: 'doc-new', categoryId: 'cat-new' }), created: true },
      });

      const result = await service.upsert('space-1', {
        ...dto,
        category: 'Architecture',
      });

      expect(result).toBeDefined();
      expect(categoryRepo.create).toHaveBeenCalled();
    });

    it('throws 409 when native doc is upserted with git source', async () => {
      const doc = makeDoc({ source: 'native' });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await expect(
        service.upsert('space-1', {
          ...dto,
          source: 'git:agent-chamber',
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_SOURCE_MISMATCH },
      });
    });

    it('allows git source overwrite when same source', async () => {
      const doc = makeDoc({
        source: 'git:agent-chamber',
        contentHash: 'oldhash',
      });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      mockTransaction.mockResolvedValue({
        doc: makeDoc({ source: 'git:agent-chamber', contentHash: 'newhash' }),
        assembled: {
          ...makeDoc({ source: 'git:agent-chamber', contentHash: 'newhash' }),
          created: false,
        },
      });

      const result = await service.upsert('space-1', {
        ...dto,
        source: 'git:agent-chamber',
      });
      expect(result).toBeDefined();
      expect(result.unchanged).toBeUndefined();
    });

    it('handles 23505 concurrent upsert gracefully', async () => {
      const emptyQb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(emptyQb);

      // Transaction throws 23505
      mockTransaction.mockRejectedValue({
        code: '23505',
        constraint: 'uq_docs_space_id_path',
      });

      // Re-query needs to find the winner
      const winner = makeDoc({ id: 'winner-1', sectionCount: 5, tokenEstimate: 200 });
      const winnerQb = createMockQueryBuilder([winner], 1);

      // Space docs query (for link health) — returns existing docs in space
      const spaceDocsQb = createMockQueryBuilder(
        [{ id: 'doc-other', path: 'docs/other.md' } as Doc],
        1,
      );

      // CreateQueryBuilder is called three times:
      // 1) check existing doc; 2) space docs for link health; 3) after 23505 re-query
      (docRepo.createQueryBuilder as jest.Mock).mockReset();
      (docRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(emptyQb) // first: no existing doc
        .mockReturnValueOnce(spaceDocsQb) // second: space docs for link health
        .mockReturnValueOnce(winnerQb); // after 23505: re-query

      const result = await service.upsert('space-1', dto);
      expect(result.id).toBe('winner-1');
      expect(result.sectionCount).toBe(5);
      expect(result.created).toBe(false);
    });

    it('re-throws non-23505 errors', async () => {
      const emptyQb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(emptyQb);

      mockTransaction.mockRejectedValue(new Error('BOOM'));

      await expect(service.upsert('space-1', dto)).rejects.toThrow('BOOM');
    });

    it('writes audit log on creation', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      mockTransaction.mockResolvedValue({
        doc: makeDoc({ id: 'doc-new', path: 'docs/test.md' }),
        assembled: { ...makeDoc({ id: 'doc-new', path: 'docs/test.md' }), created: true },
      });

      const actor = { id: 'user-1', type: ActorType.HUMAN, role: 'admin' } as any;
      await service.upsert('space-1', dto, actor);

      expect(auditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CREATE,
          entityType: 'doc',
          actorId: 'user-1',
          source: 'api',
        }),
      );
      expect(auditRepo.save).toHaveBeenCalled();
    });

    it('emits DOC_CREATED on new document', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      // Space context: ds_board_id = null, ds_topic_id = 'topic-1'
      const spaceQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ ds_board_id: null, ds_topic_id: 'topic-1' }),
      };
      (docSpaceRepo.createQueryBuilder as jest.Mock).mockReturnValue(spaceQb);

      mockTransaction.mockResolvedValue({
        doc: makeDoc({ id: 'doc-new', path: 'docs/test.md', title: 'Test Doc' }),
        assembled: {
          ...makeDoc({ id: 'doc-new', path: 'docs/test.md', title: 'Test Doc' }),
          created: true,
        },
      });

      await service.upsert('space-1', dto);

      expect(eventService.create).toHaveBeenCalledWith({
        eventType: EventType.DOC_CREATED,
        resourceType: 'doc',
        resourceId: 'doc-new',
        actorId: undefined,
        topicId: 'topic-1',
        boardId: undefined,
        payload: { spaceId: 'space-1', docId: 'doc-new', path: 'docs/test.md', title: 'Hello' },
      });
    });

    it('emits DOC_UPDATED on content change', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      // Space context qb for event
      const spaceQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ ds_board_id: null, ds_topic_id: 'topic-1' }),
      };
      (docSpaceRepo.createQueryBuilder as jest.Mock).mockReturnValue(spaceQb);

      const updatedDoc = makeDoc({ sectionCount: 3, tokenEstimate: 150, contentHash: 'newhash' });
      mockTransaction.mockResolvedValue({
        doc: updatedDoc,
        assembled: { ...updatedDoc, created: false },
      });

      await service.upsert('space-1', dto);

      expect(eventService.create).toHaveBeenCalledWith({
        eventType: EventType.DOC_UPDATED,
        resourceType: 'doc',
        resourceId: 'doc-1',
        actorId: undefined,
        topicId: 'topic-1',
        boardId: undefined,
        payload: { spaceId: 'space-1', docId: 'doc-1', path: 'docs/test.md', title: 'Hello' },
      });
    });

    it('does NOT emit when unchanged', async () => {
      const testContent = '# Hello\n\nSome content.';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({ contentHash: hash });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
      });

      expect(result.unchanged).toBe(true);
      // No event emitted because contentHash matches
      expect(eventService.create).not.toHaveBeenCalled();
    });

    // ─── 批次 C1：route health 异步重检触发（plan §7-C1）──────────────

    it('内容变更（create）→ 事务提交后 setImmediate 触发 recheckSpace（该空间）', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      mockTransaction.mockResolvedValue({
        doc: makeDoc({ id: 'doc-new', sectionCount: 2, tokenEstimate: 42 }),
        assembled: {
          ...makeDoc({ id: 'doc-new', sectionCount: 2, tokenEstimate: 42 }),
          created: true,
        },
      });

      await service.upsert('space-1', dto);
      await flushImmediates();

      expect(routeHealthService.recheckSpace).toHaveBeenCalledWith('space-1');
    });

    it('内容变更（update）→ 事务提交后触发 recheckSpace', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      mockTransaction.mockResolvedValue({
        doc: makeDoc({ sectionCount: 3, tokenEstimate: 150, contentHash: 'newhash' }),
        assembled: {
          ...makeDoc({ sectionCount: 3, tokenEstimate: 150, contentHash: 'newhash' }),
          created: false,
        },
      });

      await service.upsert('space-1', dto);
      await flushImmediates();

      expect(routeHealthService.recheckSpace).toHaveBeenCalledWith('space-1');
    });

    it('unchanged 早退分支 → 不触发 recheckSpace（sections 未重建，重检无意义）', async () => {
      const testContent = '# Hello\n\nSome content.';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({ contentHash: hash });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
      });

      expect(result.unchanged).toBe(true);
      await flushImmediates();
      expect(routeHealthService.recheckSpace).not.toHaveBeenCalled();
    });

    // ─── 债 B：forceRechunk 三分支（hash 同也强制重建；版本行守卫；rechunked 标记）────

    it('forceRechunk 三分支①：hash 同 + force=true → 走事务重建、unchanged 不带、rechunked:true、无版本行', async () => {
      const testContent = '# Hello\n\nSome content.';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({
        contentHash: hash,
        linkHealth: { total: 0, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
      });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      // 版本事务 mock：历史 MAX=5（若守卫失效会插入 version 6）
      const { savedVersions, versionQbGetRawOne } = makeVersionTxManager({ maxVersion: 5 });

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
        forceRechunk: true,
      });

      // 不进 unchanged 早退：事务执行、响应带 rechunked 标记（created 不带）
      expect(result.unchanged).toBeUndefined();
      expect(result.created).toBe(false);
      expect(result.rechunked).toBe(true);
      // 版本守卫（决策 #3）：hash 未变 → 不写版本行、不跑 MAX(version) 查询
      expect(savedVersions).toHaveLength(0);
      expect(versionQbGetRawOne).not.toHaveBeenCalled();
    });

    it('forceRechunk 三分支②：hash 同 + 无 force → unchanged 早退（对照：rechunked 不带、事务不执行）', async () => {
      const testContent = '# Hello\n\nSome content.';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({
        contentHash: hash,
        linkHealth: { total: 0, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
      });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      const { savedVersions } = makeVersionTxManager({ maxVersion: 5 });

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
      });

      expect(result.unchanged).toBe(true);
      expect(result.rechunked).toBeUndefined();
      expect(savedVersions).toHaveLength(0);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('forceRechunk 三分支③：hash 变 + force=true → 正常更新路径（rechunked 不带、版本行照常插入）', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      const { savedVersions } = makeVersionTxManager({ maxVersion: 5 });

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: '# Hello\n\nChanged content.',
        forceRechunk: true,
      });

      // 内容确实变了 → 普通更新语义：rechunked 不带、版本行照常插入（MAX 5 → 6）
      expect(result.unchanged).toBeUndefined();
      expect(result.rechunked).toBeUndefined();
      expect(savedVersions).toHaveLength(1);
      expect(savedVersions[0].version).toBe(6);
    });
  });

  // ─── upsert — doc version history（版本插入/剪枝/来源标记，2026-08-18）───────────

  /**
   * 版本历史测试专用事务 mock：manager.getRepository(DocVersion) 返回可捕获的
   * version 事务 repo，其余实体走通用 repo。
   *
   * 事务内 version repo 的 createQueryBuilder 按调用序号区分语义：
   * 第 1 次 = MAX(version) 统计（getRawOne → { max }）；
   * 第 2 次 = 剪枝 DELETE（execute）。
   * maxVersion 不传 = 该文档无历史版本（新版本号从 1 起）。
   */
  function makeVersionTxManager(overrides: { maxVersion?: number | null } = {}) {
    const savedVersions: any[] = [];
    const versionQbs: any[] = [];
    const versionQbGetRawOne = jest
      .fn()
      .mockResolvedValue(
        overrides.maxVersion === undefined ? { count: '0' } : { max: String(overrides.maxVersion) },
      );
    const versionQbDelete = jest.fn().mockResolvedValue({ affected: 0 });
    const versionTransRepo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => {
        savedVersions.push(x);
        return Promise.resolve(x);
      }),
      createQueryBuilder: jest.fn(() => {
        const qb = createMockQueryBuilder([], 0);
        versionQbs.push(qb);
        if (versionQbs.length === 1) {
          // MAX(version) 统计查询
          qb.getRawOne = versionQbGetRawOne;
        } else {
          // 剪枝 DELETE（execute）
          qb.execute = versionQbDelete;
        }
        return qb;
      }),
    };
    const genericTransRepo = {
      // 模拟 TypeORM save 的行为：新建实体由 PG 分配 uuid → mock 补上 id，
      // 保证事务内 doc.id 可用（版本行的 docId 依赖它）
      save: jest.fn((x: unknown) =>
        Promise.resolve(x ? { ...(x as object), id: (x as { id?: string }).id ?? 'doc-1' } : x),
      ),
      create: jest.fn((x: unknown) => x),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
    };
    mockTransaction.mockImplementation((fn: any) =>
      fn({
        getRepository: jest.fn((Entity: unknown) =>
          Entity === DocVersion ? versionTransRepo : genericTransRepo,
        ),
      }),
    );
    return { savedVersions, versionQbs, versionQbGetRawOne, versionQbDelete };
  }

  describe('upsert — doc version history', () => {
    // 与 upsert describe 同形的基础 dto（版本 describe 独立定义，不引用外部作用域）
    const dto = {
      path: 'docs/test.md',
      content: '# Hello\n\nSome content.',
    };

    it('创建新文档 → 同事务插入 version 1（source=upsert，authorActorId=system）', async () => {
      const qb = createMockQueryBuilder([], 0); // 无现有文档
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      const { savedVersions } = makeVersionTxManager(); // 无历史 → nextVersion=1

      await service.upsert('space-1', dto);

      expect(savedVersions).toHaveLength(1);
      expect(savedVersions[0]).toMatchObject({
        docId: 'doc-1',
        version: 1,
        contentHash: expect.any(String),
        content: dto.content,
        authorActorId: 'system', // 无 actor → system 固定 uuid（对齐 docs.created_by 缺省）
        source: 'upsert',
      });
    });

    it('内容变更（update，历史 MAX=45）→ 新版本号 46：单调递增且删旧不归零', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      const { savedVersions, versionQbGetRawOne } = makeVersionTxManager({ maxVersion: 45 });

      await service.upsert('space-1', { ...dto, content: '# Hello\n\nChanged content.' });

      expect(versionQbGetRawOne).toHaveBeenCalled();
      expect(savedVersions).toHaveLength(1);
      // 版本号 = 历史最大 +1（45 → 46），不依赖行数（删旧后不回填）
      expect(savedVersions[0].version).toBe(46);
      expect(savedVersions[0].source).toBe('upsert');
    });

    it('插入新版本后同事务剪枝：DELETE version < 新版本-20+1（DOC_VERSION_KEEP=20）', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      const { savedVersions, versionQbs } = makeVersionTxManager({ maxVersion: 25 });

      await service.upsert('space-1', { ...dto, content: '# Hello\n\nChanged content.' });

      expect(savedVersions[0].version).toBe(26);
      // 剪枝条件 = version < 26-20+1 = 7（保留 7..26 共 20 版）
      const deleteQb = versionQbs[1];
      expect(deleteQb.andWhere).toHaveBeenCalledWith('version < :keeperFloor', { keeperFloor: 7 });
    });

    it('unchanged 幂等短路 → 不插入版本行（仅内容 hash 变化才记版本）', async () => {
      const testContent = '# Hello\n\nSome content.';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({ contentHash: hash });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      const { savedVersions } = makeVersionTxManager();

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
      });

      expect(result.unchanged).toBe(true);
      expect(savedVersions).toHaveLength(0);
    });

    it('patch 通道转调（versionSource=patch）→ 版本行 source=patch', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      const { savedVersions } = makeVersionTxManager({ maxVersion: 2 });

      await service.upsert('space-1', {
        ...dto,
        content: '# Hello\n\nPatched.',
        versionSource: 'patch',
      });

      expect(savedVersions[0].version).toBe(3);
      expect(savedVersions[0].source).toBe('patch');
    });

    it('batch 导入通道（batchUpsert 转调）→ 版本行 source=import', async () => {
      const { savedVersions } = makeVersionTxManager();

      await service.batchUpsert('space-1', [
        { path: 'docs/imported.md', content: '# Imported\n\nBody.' },
      ]);

      expect(savedVersions).toHaveLength(1);
      expect(savedVersions[0].source).toBe('import');
    });

    it('事务内 doc.save 抛错（版本插入之前）→ 版本行不写入（同事务顺序执行）', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      // 版本插入代码位于 doc.save 之后——doc.save 抛错时版本行绝不产生
      // （真实 DB 下由事务回滚兜底；此处验证代码顺序：版本写入依赖保存成功）
      const versionSaves: unknown[] = [];
      mockTransaction.mockImplementation((fn: any) => {
        const versionTxRepo = {
          save: jest.fn((x: unknown) => {
            versionSaves.push(x);
            return Promise.resolve(x);
          }),
          create: jest.fn((x: unknown) => x),
          createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
        };
        const genericTxRepo = {
          save: jest.fn().mockRejectedValue(new Error('boom')),
          create: jest.fn((x: unknown) => x),
          createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
        };
        return fn({
          getRepository: jest.fn((Entity: unknown) =>
            Entity === DocVersion ? versionTxRepo : genericTxRepo,
          ),
        });
      });

      await expect(service.upsert('space-1', { ...dto, content: '# HELLO' })).rejects.toThrow(
        'boom',
      );
      expect(versionSaves).toHaveLength(0);
    });
  });

  // ─── findVersions（版本历史列表，doc history MVP）────────────────────────

  describe('findVersions', () => {
    it('返回版本元数据（version DESC、contentSize 现算、不含 content 全文）', async () => {
      const docQb = createMockQueryBuilder([makeDoc()], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);
      const versionQb = createMockQueryBuilder([], 0);
      versionQb.getRawMany = jest.fn().mockResolvedValue([
        {
          v_version: 2,
          v_content_hash: 'hash2',
          v_author_actor_id: 'agent-1',
          v_source: 'patch',
          v_created_at: new Date('2026-01-02T00:00:00Z'),
          content_size: '42',
        },
        {
          v_version: 1,
          v_content_hash: 'hash1',
          v_author_actor_id: 'system',
          v_source: 'upsert',
          v_created_at: new Date('2026-01-01T00:00:00Z'),
          content_size: '22',
        },
      ]);
      (versionRepo.createQueryBuilder as jest.Mock).mockReturnValue(versionQb);

      const result = await service.findVersions('doc-1');

      expect(result).toEqual([
        {
          version: 2,
          contentHash: 'hash2',
          authorActorId: 'agent-1',
          source: 'patch',
          createdAt: new Date('2026-01-02T00:00:00Z'),
          contentSize: 42,
        },
        {
          version: 1,
          contentHash: 'hash1',
          authorActorId: 'system',
          source: 'upsert',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          contentSize: 22,
        },
      ]);
      // 最新在前（version DESC）
      expect(versionQb.orderBy).toHaveBeenCalledWith('v.version', 'DESC');
      // 不查 content 大字段（列表最小化；contentSize 由 SQL octet_length 现算）
      expect(versionQb.select).toHaveBeenCalledWith([
        'v.version',
        'v.contentHash',
        'v.authorActorId',
        'v.source',
        'v.createdAt',
      ]);
    });

    it('文档不存在/软删 → 404 DOC_NOT_FOUND', async () => {
      const docQb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      await expect(service.findVersions('missing')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
      expect(versionRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  // ─── findVersion（单版本详情 + 与前一版 diff，doc history MVP）───────────────

  describe('findVersion', () => {
    const prevRow = {
      id: 'v-1',
      docId: 'doc-1',
      version: 1,
      contentHash: 'hash1',
      content: 'line1\nline2\nline3',
      authorActorId: 'system',
      source: 'upsert',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as unknown as DocVersion;
    const targetRow = {
      id: 'v-2',
      docId: 'doc-1',
      version: 2,
      contentHash: 'hash2',
      content: 'line1\nline2-modified\nline3',
      authorActorId: 'agent-1',
      source: 'patch',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    } as unknown as DocVersion;

    function mockVersionQueries(row: DocVersion | null): jest.Mock {
      const rowQb = createMockQueryBuilder(row ? [row] : [], row ? 1 : 0);
      const prevQb = createMockQueryBuilder([prevRow], 1);
      const mock = jest
        .fn()
        .mockReturnValueOnce(rowQb) // 目标版本行查询（getOne）
        .mockReturnValueOnce(prevQb); // 前一版本查询（getOne）
      (versionRepo.createQueryBuilder as jest.Mock).mockImplementation(mock);
      return mock;
    }

    it('返回详情：content 全文 + 与前一版的 diff（added/removed/unified，读时现算）', async () => {
      const docQb = createMockQueryBuilder([makeDoc()], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);
      mockVersionQueries(targetRow);

      const result = await service.findVersion('doc-1', 2);

      expect(result.version).toBe(2);
      expect(result.content).toBe('line1\nline2-modified\nline3');
      expect(result.contentSize).toBe(Buffer.byteLength(result.content, 'utf8'));
      expect(result.diff).not.toBeNull();
      expect(result.diff!.fromVersion).toBe(1);
      expect(result.diff!.added).toBe(1);
      expect(result.diff!.removed).toBe(1);
      // unified 文本包含头部与 +/- 行
      expect(result.diff!.unified).toContain('--- doc v1');
      expect(result.diff!.unified).toContain('+++ doc v2');
      expect(result.diff!.unified).toContain('-line2');
      expect(result.diff!.unified).toContain('+line2-modified');
    });

    it('文档最早保留版本（无前一版）→ diff=null', async () => {
      const docQb = createMockQueryBuilder([makeDoc()], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);
      const rowQb = createMockQueryBuilder([targetRow], 1);
      const prevQb = createMockQueryBuilder([], 0); // 前一版查询零命中
      (versionRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(rowQb)
        .mockReturnValueOnce(prevQb);

      // 断言前一版查询条件：version < 当前
      const result = await service.findVersion('doc-1', 2);

      expect(prevQb.andWhere).toHaveBeenCalledWith('v.version < :version', { version: 2 });
      expect(result.diff).toBeNull();
    });

    it('版本不存在 → 404 DOC_NOT_FOUND（不查询前版）', async () => {
      const docQb = createMockQueryBuilder([makeDoc()], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);
      mockVersionQueries(null);

      await expect(service.findVersion('doc-1', 99)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });
  });

  // ─── batchUpsert ──────────────────────────────────────────────

  describe('batchUpsert', () => {
    const baseDto = {
      path: 'docs/test.md',
      content: '# Hello\n\nSome content.',
    };

    it('handles mixed success: created + updated + unchanged with correct summary counts', async () => {
      // Spy on upsert to control per-call results
      const upsertSpy = jest.spyOn(service, 'upsert');
      upsertSpy
        .mockResolvedValueOnce({
          id: 'doc-new',
          path: 'docs/new.md',
          sectionCount: 1,
          tokenEstimate: 10,
          created: true,
        })
        .mockResolvedValueOnce({
          id: 'doc-updated',
          path: 'docs/updated.md',
          sectionCount: 2,
          tokenEstimate: 20,
          created: false,
        })
        .mockResolvedValueOnce({
          id: 'doc-same',
          path: 'docs/same.md',
          sectionCount: 1,
          tokenEstimate: 15,
          unchanged: true,
        });

      const result = await service.batchUpsert('space-1', [
        { ...baseDto, path: 'docs/new.md', content: 'new' },
        { ...baseDto, path: 'docs/updated.md', content: 'updated' },
        { ...baseDto, path: 'docs/same.md', content: 'same' },
      ]);

      expect(result.results).toHaveLength(3);
      expect(result.results[0]).toMatchObject({
        path: 'docs/new.md',
        status: 'created',
        id: 'doc-new',
      });
      expect(result.results[1]).toMatchObject({
        path: 'docs/updated.md',
        status: 'updated',
        id: 'doc-updated',
      });
      expect(result.results[2]).toMatchObject({
        path: 'docs/same.md',
        status: 'unchanged',
        id: 'doc-same',
      });
      expect(result.summary).toEqual({ total: 3, created: 1, updated: 1, unchanged: 1, failed: 0 });
    });

    it('collects failures without aborting remaining items (source mismatch 409 → failed with code)', async () => {
      const upsertSpy = jest.spyOn(service, 'upsert');
      upsertSpy
        .mockRejectedValueOnce(
          // 真实运行时为 HttpException，response.code 是数值型 ErrorCode（10003）
          Object.assign(new Error('Source mismatch'), {
            response: {
              message: "Document source 'native' does not match request source 'git:fake'",
              code: 10003,
            },
          }),
        )
        .mockResolvedValueOnce({
          id: 'doc-ok',
          path: 'docs/ok.md',
          sectionCount: 1,
          tokenEstimate: 5,
          created: true,
        });

      const result = await service.batchUpsert('space-1', [
        { ...baseDto, path: 'docs/fail.md', content: 'fail', source: 'git:fake' },
        { ...baseDto, path: 'docs/ok.md', content: 'ok' },
      ]);

      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toMatchObject({
        path: 'docs/fail.md',
        status: 'failed',
        error: {
          message: "Document source 'native' does not match request source 'git:fake'",
          code: 10003,
        },
      });
      expect(result.results[1]).toMatchObject({
        path: 'docs/ok.md',
        status: 'created',
        id: 'doc-ok',
      });
      expect(result.summary).toEqual({ total: 2, created: 1, updated: 0, unchanged: 0, failed: 1 });
    });

    it('distinguishes created=true / updated=false / 23505-winner=false in result flags', async () => {
      const upsertSpy = jest.spyOn(service, 'upsert');
      upsertSpy
        .mockResolvedValueOnce({
          id: 'doc-a',
          path: 'docs/a.md',
          sectionCount: 1,
          tokenEstimate: 10,
          created: true,
        })
        .mockResolvedValueOnce({
          id: 'doc-b',
          path: 'docs/b.md',
          sectionCount: 2,
          tokenEstimate: 20,
          created: false,
        });

      const result = await service.batchUpsert('space-1', [
        { ...baseDto, path: 'docs/a.md', content: 'a' },
        { ...baseDto, path: 'docs/b.md', content: 'b' },
      ]);

      expect(result.results[0].status).toBe('created');
      expect(result.results[1].status).toBe('updated');
      expect(result.summary.created).toBe(1);
      expect(result.summary.updated).toBe(1);
      expect(result.summary.unchanged).toBe(0);
      expect(result.summary.failed).toBe(0);
    });

    it('returns total=0 for empty array (service-level direct call, DTO validation separate)', async () => {
      // batchUpsert should handle empty arrays gracefully:
      // DTO-level @ArrayMinSize(1) catches it at the controller boundary,
      // but the service itself doesn't throw for zero docs.
      const result = await service.batchUpsert('space-1', []);
      expect(result.results).toHaveLength(0);
      expect(result.summary).toEqual({ total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 });
    });

    it('债 B 决策 #4：batch 元素携带 forceRechunk 也被显式剔除（不透传 upsert）', async () => {
      const upsertSpy = jest.spyOn(service, 'upsert');
      upsertSpy.mockResolvedValue({
        id: 'doc-a',
        path: 'docs/a.md',
        sectionCount: 1,
        tokenEstimate: 10,
        created: true,
      });

      // @Type(() => UpsertDocDto) 实例化后元素可能携带 forceRechunk——类型 Omit 之外的
      // 运行时剔除（DTO 类型上 BatchUpsertItemDto 已 Omit，此处显式带上模拟运行时形态）
      const result = await service.batchUpsert('space-1', [
        {
          path: 'docs/a.md',
          content: 'a',
          forceRechunk: true,
        } as unknown as BatchUpsertItemDto,
      ]);

      expect(result.results[0].status).toBe('created');
      // upsert 收到的参数绝不带 forceRechunk（batch 通道永不触发重建分支）
      expect(upsertSpy).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({ path: 'docs/a.md', content: 'a', versionSource: 'import' }),
        undefined,
        // 第 4 参 = clientRequestId（v1.63.0 幂等透传；本用例 batch 元素未携带 → undefined）
        undefined,
      );
      const callArg = upsertSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(callArg.forceRechunk).toBeUndefined();
    });
  });

  // ─── findAll ────────────────────────────────────────────────

  describe('findAll', () => {
    it('returns paginated doc summaries', async () => {
      const doc = makeDoc();
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.findAll('space-1', {});
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0].id).toBe('doc-1');
      // v1.62.0：toSummary 透传 contentHash（原始写入 payload 的 SHA-256，乐观锁 token）
      expect(result.items[0].contentHash).toBe('abc123');
    });

    it('throws 400 when path= and q= are both set', async () => {
      await expect(
        service.findAll('space-1', { path: 'docs/test.md', q: 'search' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('filters by exact path', async () => {
      const doc = makeDoc();
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.findAll('space-1', { path: 'docs/test.md' });
      expect(result.items).toHaveLength(1);
    });

    it('filters by q (ILIKE)', async () => {
      const doc = makeDoc();
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.findAll('space-1', { q: 'test' });
      expect(result.items).toHaveLength(1);
    });

    // ─── v1.55 pathPrefix 前缀过滤（list_docs 工具后端支撑）───

    it('throws 400 when path= and pathPrefix= are both set', async () => {
      await expect(
        service.findAll('space-1', { path: 'docs/a.md', pathPrefix: 'docs/' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('filters by pathPrefix with literal-prefix LIKE (wildcards escaped)', async () => {
      const doc = makeDoc();
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.findAll('space-1', { pathPrefix: 'memory/' });
      expect(result.items).toHaveLength(1);
      // LIKE 前缀语义 + ESCAPE 子句；普通前缀无元字符时仅追加尾部 %
      expect(qb.andWhere).toHaveBeenCalledWith("d.path LIKE :pathPrefix ESCAPE '\\'", {
        pathPrefix: 'memory/%',
      });
    });

    it('escapes LIKE metacharacters in pathPrefix input', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      // 用户输入含 % _ \ → 全部转义为字面量，不被解释为 LIKE 元字符
      await service.findAll('space-1', { pathPrefix: 'a%b_c\\d' });
      expect(qb.andWhere).toHaveBeenCalledWith("d.path LIKE :pathPrefix ESCAPE '\\'", {
        pathPrefix: 'a\\%b\\_c\\\\d%',
      });
    });

    it('pathPrefix combinable with q (prefix scope + keyword filter)', async () => {
      const qb = createMockQueryBuilder([], 0);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await expect(
        service.findAll('space-1', { pathPrefix: 'memory/', q: '日记' }),
      ).resolves.toBeDefined();
      expect(qb.andWhere).toHaveBeenCalledWith("d.path LIKE :pathPrefix ESCAPE '\\'", {
        pathPrefix: 'memory/%',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('(d.title ILIKE :q OR d.path ILIKE :q)', {
        q: '%日记%',
      });
    });
  });

  // ─── findOne ────────────────────────────────────────────────

  describe('findOne', () => {
    it('returns doc with section outline (no content) for large docs', async () => {
      // 大文档（tokenEstimate > 2000 阈值）→ 仅大纲，零 content 开销
      const doc = makeDoc({ tokenEstimate: 5000 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      // findOne 走 getMany 实体 hydration（非 getRawMany），故喂带属性的 section 实体
      const sectionQb = createMockQueryBuilder(
        [
          makeSection({ position: 0, headingPath: 'Intro', headingLevel: 1, tokenEstimate: 50 }),
          makeSection({ position: 1, headingPath: 'Details', headingLevel: 2, tokenEstimate: 30 }),
        ],
        2,
      );
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.sections).toHaveLength(2);
      expect(result.sections![0]).toMatchObject({
        position: 0,
        headingPath: 'Intro',
        heading: 'Intro',
        headingLevel: 1,
        tokenEstimate: 50,
      });
      // Should NOT contain content field
      expect((result.sections![0] as any).content).toBeUndefined();
      expect(result.mode).toBe('outline');
      expect((result as any).content).toBeUndefined();
      // outline 分支零额外开销：仅一次 section 查询
      expect(sectionRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('derives local heading as last headingPath segment (display field)', async () => {
      // 多级 headingPath → heading 取末段；headingPath=null（headingLevel 0 文首段）→ heading 为 null；
      // headingPath 本身保留全链作寻址地址（语义不变）
      const doc = makeDoc({ tokenEstimate: 5000 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder(
        [
          makeSection({
            position: 0,
            headingPath: 'AAA § 2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）',
            headingLevel: 3,
            tokenEstimate: 10,
          }),
          makeSection({ position: 1, headingPath: null, headingLevel: 0, tokenEstimate: 20 }),
          makeSection({
            position: 2,
            headingPath: '末段带空格 ',
            headingLevel: 2,
            tokenEstimate: 30,
          }),
        ],
        3,
      );
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.sections![0].heading).toBe(
        '2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）',
      );
      expect(result.sections![1].heading).toBeNull();
      expect(result.sections![2].heading).toBe('末段带空格');
      // headingPath 寻址契约保留完整路径与标题正文中的裸 §
      expect(result.sections![0].headingPath).toBe(
        'AAA § 2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）',
      );
      expect(result.sections![1].headingPath).toBeNull();
    });

    it('债 A：outline heading/headingText 直读 heading_text 列（优先于 headingPath 反解析）', async () => {
      // 标题正文含 ' § ' 时反解析会切错（'A § B' 被切到 'B'）；列直读保留完整本地标题
      const doc = makeDoc({ tokenEstimate: 5000 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder(
        [
          // 核心价值：headingText 与 headingPath 末段不一致（反解析会切错）
          makeSection({
            position: 0,
            headingPath: '父标题 § A § B 子标题',
            headingText: 'A § B 子标题',
            headingLevel: 2,
            tokenEstimate: 10,
          }),
          // level-0 文首段：两字段皆 null
          makeSection({
            position: 1,
            headingPath: null,
            headingText: null,
            headingLevel: 0,
            tokenEstimate: 20,
          }),
        ],
        2,
      );
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.sections![0].heading).toBe('A § B 子标题');
      expect(result.sections![0].headingText).toBe('A § B 子标题');
      expect(result.sections![0].headingPath).toBe('父标题 § A § B 子标题'); // 寻址地址不动
      expect(result.sections![1].heading).toBeNull();
      expect(result.sections![1].headingText).toBeNull();
    });

    it('债 A 兜底：heading_text 缺失（旧行回填前/mock）→ 回退 headingPath 末段反解析', async () => {
      const doc = makeDoc({ tokenEstimate: 5000 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder(
        [
          // 不带 headingText 字段（undefined）→ 双通道 fallback 生效
          makeSection({ position: 0, headingPath: 'P § C', headingLevel: 2, tokenEstimate: 10 }),
        ],
        1,
      );
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.sections![0].heading).toBe('C');
      expect(result.sections![0].headingText).toBeUndefined();
    });

    it('exposes sourceSha in detail (via toSummary, DocDetail extends DocSummary)', async () => {
      const doc = makeDoc({ tokenEstimate: 5000, sourceSha: 'sha-last-verified' });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder([], 0);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.sourceSha).toBe('sha-last-verified');
      // v1.62.0：findOne（outline/full 共用 toSummary）也透传 contentHash（乐观锁 token）
      expect(result.contentHash).toBe('abc123');
    });

    it('small doc (tokenEstimate ≤ threshold) → mode:full + content with faithful semantics (first H1 kept)', async () => {
      // 小文档（tokenEstimate=100 ≤ 2000 阈值）→ 第二次全量查询 + reconstructContent(false)
      // 保真渲染——首 H1 与 title 同名也保留标题行（与 match 写面 pachByMatch 操作面 /
      // getContent(full=true) 逐字节同形；read_doc full 输出可直接作 patch_doc oldString）
      const doc = makeDoc({ tokenEstimate: 100 }); // title = 'Test Doc'
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const outlineQb = createMockQueryBuilder(
        [makeSection({ position: 0, headingPath: 'Test Doc', headingLevel: 1, tokenEstimate: 50 })],
        1,
      );
      // full 分支：全量 sections（含 content）
      const fullQb = createMockQueryBuilder(
        [
          makeSection({
            position: 0,
            headingPath: 'Test Doc',
            headingLevel: 1,
            content: 'Lead body.',
          }),
        ],
        1,
      );
      (sectionRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(outlineQb)
        .mockReturnValueOnce(fullQb);

      const result = await service.findOne('doc-1');
      expect(result.mode).toBe('full');
      // 保真语义：position 0 的 H1 与 doc.title 同名 → 标题行保留（不做渲染侧去重）
      expect(result.content).toBe('# Test Doc\n\nLead body.');
      expect(result.sections).toHaveLength(1);
      // outline + full 两次 section 查询
      expect(sectionRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('threshold boundary: tokenEstimate=2000 triggers full', async () => {
      const doc = makeDoc({ tokenEstimate: 2000 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const outlineQb = createMockQueryBuilder(
        [
          makeSection({
            position: 0,
            headingPath: 'Test Doc',
            headingLevel: 1,
            tokenEstimate: 2000,
          }),
        ],
        1,
      );
      const fullQb = createMockQueryBuilder(
        [makeSection({ position: 0, headingPath: 'Test Doc', headingLevel: 1, content: 'Body.' })],
        1,
      );
      (sectionRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(outlineQb)
        .mockReturnValueOnce(fullQb);

      const result = await service.findOne('doc-1');
      expect(result.mode).toBe('full');
      // 保真语义：首 H1 与 title 同名也保留标题行（与 match 写面逐字节同形）
      expect(result.content).toBe('# Test Doc\n\nBody.');
    });

    it('threshold boundary: tokenEstimate=2001 stays outline', async () => {
      const doc = makeDoc({ tokenEstimate: 2001 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder(
        [
          makeSection({
            position: 0,
            headingPath: 'Test Doc',
            headingLevel: 1,
            tokenEstimate: 2001,
          }),
        ],
        1,
      );
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.mode).toBe('outline');
      expect((result as any).content).toBeUndefined();
      expect(sectionRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('tokenEstimate=0 (legacy unestimated doc) never triggers full content', async () => {
      // 存量 tokenEstimate=0 的文档不触发全文（守卫保留），防止任意大文档误内联
      const doc = makeDoc({ tokenEstimate: 0 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder(
        [makeSection({ position: 0, headingPath: 'Test Doc', headingLevel: 1, tokenEstimate: 0 })],
        1,
      );
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.mode).toBe('outline');
      expect((result as any).content).toBeUndefined();
      expect(sectionRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('maxFullTokens=0 forces outline even for small docs', async () => {
      const doc = makeDoc({ tokenEstimate: 100 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder(
        [makeSection({ position: 0, headingPath: 'Intro', headingLevel: 1, tokenEstimate: 50 })],
        1,
      );
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1', 0);
      expect(result.mode).toBe('outline');
      expect((result as any).content).toBeUndefined();
      expect(sectionRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('maxFullTokens=5000 enlarges threshold (tokenEstimate=3000 inlined)', async () => {
      const doc = makeDoc({ tokenEstimate: 3000 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const outlineQb = createMockQueryBuilder(
        [makeSection({ position: 0, headingPath: 'Intro', headingLevel: 1, tokenEstimate: 3000 })],
        1,
      );
      const fullQb = createMockQueryBuilder(
        [
          makeSection({
            position: 0,
            headingPath: 'Intro',
            headingLevel: 1,
            content: 'Big but inlined.',
          }),
        ],
        1,
      );
      (sectionRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(outlineQb)
        .mockReturnValueOnce(fullQb);

      const result = await service.findOne('doc-1', 5000);
      expect(result.mode).toBe('full');
      expect(result.content).toBe('# Intro\n\nBig but inlined.');
      expect(sectionRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });
  });

  // ─── getContent ─────────────────────────────────────────────

  describe('getContent', () => {
    it('restores heading lines from headingPath/headingLevel when concatenating', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      // headingPath 末段作为标题文本；level 决定 # 个数，验证 web 全文通道还原层级
      const sections = [
        makeSection({
          position: 0,
          headingPath: 'Intro',
          headingLevel: 1,
          content: 'First section.',
        }),
        makeSection({
          position: 1,
          headingPath: 'Intro § Detail',
          headingLevel: 2,
          content: 'Second section.',
        }),
      ];
      const secQb = createMockQueryBuilder(sections, 2);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1');
      expect(result.docPath).toBe('docs/test.md');
      expect(result.title).toBe('Test Doc');
      expect(result.content).toBe('# Intro\n\nFirst section.\n\n## Detail\n\nSecond section.');
      // v1.62.0：getContent 返回原始写入 payload 的 contentHash（乐观锁 token，
      // 与重建正文 SHA-256 不可互算）；makeDoc 默认 contentHash='abc123'
      expect(result.contentHash).toBe('abc123');
    });

    it('round-trips a heading containing §3.2 and preserves nested child headings', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const parentTitle = '2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）';
      const source = [
        `# ${parentTitle}`,
        '',
        '父标题正文。',
        '',
        '## 子标题',
        '',
        '子标题正文。',
      ].join('\n');
      const chunks = chunkMarkdown(source, doc.title);
      const sections = chunks.map((chunk) =>
        makeSection({
          position: chunk.position,
          headingPath: chunk.headingPath,
          headingLevel: chunk.headingLevel,
          content: chunk.content,
          tokenEstimate: chunk.tokenEstimate,
        }),
      );
      const secQb = createMockQueryBuilder(sections, sections.length);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1', true);

      expect(result.content).toBe(source);
      expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
        parentTitle,
        `${parentTitle} § 子标题`,
      ]);
    });

    it('skips the lead heading line when it duplicates doc.title (web header already shows it)', async () => {
      const doc = makeDoc(); // title = 'Test Doc'
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sections = [
        // position 0 的 H1 末段与 doc.title 同名 → 不重复插标题行
        makeSection({
          position: 0,
          headingPath: 'Test Doc',
          headingLevel: 1,
          content: 'Lead body.',
        }),
        makeSection({
          position: 1,
          headingPath: 'Test Doc § Sub',
          headingLevel: 2,
          content: 'Sub body.',
        }),
      ];
      const secQb = createMockQueryBuilder(sections, 2);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1');
      expect(result.content).toBe('Lead body.\n\n## Sub\n\nSub body.');
    });

    it('full=true keeps the duplicate lead heading (editor round-trip safety)', async () => {
      // 编辑器回写场景：去重后的 content 再 upsert 会丢首标题行，
      // title 会被下一个 heading / path 重新派生（数据损坏）。full=true 必须全量还原。
      const doc = makeDoc(); // title = 'Test Doc'
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sections = [
        makeSection({
          position: 0,
          headingPath: 'Test Doc',
          headingLevel: 1,
          content: 'Lead body.',
        }),
        makeSection({
          position: 1,
          headingPath: 'Test Doc § Sub',
          headingLevel: 2,
          content: 'Sub body.',
        }),
      ];
      const secQb = createMockQueryBuilder(sections, 2);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1', true);
      expect(result.content).toBe('# Test Doc\n\nLead body.\n\n## Sub\n\nSub body.');
    });

    it('does not prepend a heading line for level-0 (untitled lead) sections', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const section = makeSection({
        position: 0,
        headingPath: 'Test',
        headingLevel: 0,
        content: 'Body text.',
      });
      const secQb = createMockQueryBuilder([section], 1);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1');
      expect(result.content).toBe('Body text.');
    });

    it('restores empty heading sections as bare heading lines (no dangling blank lines)', async () => {
      // 空 content section（空正文标题，chunker 保真产出）→ 标题行独占一段，
      // 不追加 "\n\n"，join 后恰好一个空行分隔，不得出现 "\n\n\n"
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sections = [
        makeSection({ position: 0, headingPath: '分组', headingLevel: 2, content: '' }),
        makeSection({ position: 1, headingPath: '子节', headingLevel: 2, content: '正文' }),
      ];
      const secQb = createMockQueryBuilder(sections, 2);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1', true);
      expect(result.content).toBe('## 分组\n\n## 子节\n\n正文');
      expect(result.content).not.toContain('\n\n\n');
    });

    it('round-trips idempotently: empty heading sections survive read + rewrite cycles', async () => {
      // 核心验收（任务 e6eaf06d）：含空 H2 分组标题的文档，chunk → reconstructContent
      // （full=true，编辑器回写口径）→ 再 chunk，两次 (headingPath, headingLevel, content)
      // 序列必须完全一致——空标题不再在「全文读 + upsert 回写」往返中渐进丢失
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const source = [
        '# 标题',
        '',
        '引言正文',
        '',
        '## 空分组一',
        '',
        '## 空分组二',
        '',
        '### 有内容子节',
        '子节正文',
        '',
        '## 结尾空分组',
        '',
      ].join('\n');

      const chunks = chunkMarkdown(source, doc.title);
      // 期望分块：1 个 H1（引言）+ 3 个空标题（空分组一/空分组二/结尾空分组）+ 1 个 H3 子节
      const emptyPaths = chunks.filter((c) => c.content === '');
      expect(emptyPaths).toHaveLength(3);

      // chunks 字段与 doc_sections 行一一对应（见 upsert 的 sections 映射），直接当 sections 喂回
      const sections = chunks.map((c) =>
        makeSection({
          position: c.position,
          headingPath: c.headingPath,
          headingLevel: c.headingLevel,
          isContinuation: c.isContinuation,
          content: c.content,
          tokenEstimate: c.tokenEstimate,
        }),
      );
      const secQb = createMockQueryBuilder(sections, sections.length);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const { content: reconstructed } = await service.getContent('doc-1', true);
      // 重建文不含多余空行，空标题行完整保留
      expect(reconstructed).not.toContain('\n\n\n');
      expect(reconstructed).toContain('## 空分组一');
      expect(reconstructed).toContain('## 空分组二');
      expect(reconstructed).toContain('## 结尾空分组');

      // 重建文再切分 → 与首次切分序列完全一致（幂等，不再渐进退化）
      const chunks2 = chunkMarkdown(reconstructed, doc.title);
      expect(chunks2).toHaveLength(chunks.length);
      expect(chunks2.map((c) => [c.headingPath, c.headingLevel, c.content])).toEqual(
        chunks.map((c) => [c.headingPath, c.headingLevel, c.content]),
      );
    });

    it('run-dedup: merges paragraph-split sibling chunks into a single heading line', async () => {
      // 任务 e6eaf06d 第二张脸：chunker step 4 段落切分产生的兄弟 chunk 共用同一
      // (headingPath, headingLevel)——重建时若逐个插标题行，同一标题会重复 N 次；
      // run-dedup 只插回一次标题行，两段正文都在且顺序正确
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sections = [
        makeSection({ position: 0, headingPath: 'A § X', headingLevel: 2, content: 'Para one.' }),
        makeSection({
          position: 1,
          headingPath: 'A § X',
          headingLevel: 2,
          isContinuation: true,
          content: 'Para two.',
        }),
      ];
      const secQb = createMockQueryBuilder(sections, 2);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1', true);
      expect(result.content).toBe('## X\n\nPara one.\n\nPara two.');
      expect(result.content).not.toContain('\n\n\n');
    });

    it('run-dedup: same heading level with different parent chains keeps both heading lines', async () => {
      // headingLevel 相同但 headingPath 不同（父链 A/B 不同，如 `A § X` 与 `B § X`）
      // → 不是续 chunk，两个标题行都必须保留
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sections = [
        makeSection({ position: 0, headingPath: 'A § X', headingLevel: 2, content: 'A body.' }),
        makeSection({ position: 1, headingPath: 'B § X', headingLevel: 2, content: 'B body.' }),
      ];
      const secQb = createMockQueryBuilder(sections, 2);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1', true);
      expect(result.content).toBe('## X\n\nA body.\n\n## X\n\nB body.');
    });

    it('run-dedup: adjacent same-path sibling headings both survive when not continuations', async () => {
      // v1.57.3 regression: same headingPath/headingLevel can represent two real sibling headings.
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sections = [
        makeSection({
          position: 0,
          headingPath: 'Parent § Same',
          headingLevel: 4,
          content: 'First body.',
        }),
        makeSection({
          position: 1,
          headingPath: 'Parent § Same',
          headingLevel: 4,
          content: 'Second body.',
        }),
      ];
      const secQb = createMockQueryBuilder(sections, 2);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1', true);
      expect(result.content).toBe('#### Same\n\nFirst body.\n\n#### Same\n\nSecond body.');
      expect(result.content.match(/^#### Same$/gm)).toHaveLength(2);
    });

    it('run-dedup: empty heading section followed by same-path content chunk renders heading once', async () => {
      // 病态存储形态（chunker 不会自然产出，历史数据/手工构造可能）：空标题 section 后跟
      // 同 (headingPath, headingLevel) 的正文 section → 标题只出现一次——
      // 验证 run-dedup 与空标题分支（只渲染标题行）的交互
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sections = [
        makeSection({ position: 0, headingPath: '分组', headingLevel: 2, content: '' }),
        makeSection({
          position: 1,
          headingPath: '分组',
          headingLevel: 2,
          isContinuation: true,
          content: '正文',
        }),
      ];
      const secQb = createMockQueryBuilder(sections, 2);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getContent('doc-1', true);
      expect(result.content).toBe('## 分组\n\n正文');
      expect(result.content.match(/## 分组/g)).toHaveLength(1);
      expect(result.content).not.toContain('\n\n\n');
    });

    it('run-dedup round-trips idempotently: >4000-char section renders each heading exactly once', async () => {
      // 核心验收（任务 e6eaf06d 第二张脸）：巨型章节（>4000 字符触发 chunker step 4 段落切分，
      // 30 个子 chunk 共用同一 headingPath）+ 空 H2 分组标题的文档：
      // ① chunk → reconstructContent(full=true) 重建后每个标题只出现 1 次（不再重复 N 次）；
      // ② 重建文再 chunk → (headingPath, headingLevel, content) 序列与首次完全相等
      //    （「全文读 + upsert 回写」往返幂等，不再每轮固化重复标题）。
      // 构造约定：段落单行、无内嵌空行、无首尾空白、段落间恰一个空行——保证 trim 后与原文
      // 一致，首次往返即可幂等。
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const bigParas = Array.from({ length: 30 }, (_, i) => `段落${i + 1}：${'甲'.repeat(140)}`);
      const sourceLines = ['# 标题', '', '引言正文', '', '## 空分组', '', '## 巨章'];
      for (const p of bigParas) sourceLines.push(p, '');
      sourceLines.push('## 结尾空分组', '');
      const source = sourceLines.join('\n');

      const chunks1 = chunkMarkdown(source, doc.title);
      // 期望分块：1 个 H1 引言 + 1 个空 H2 分组 + 30 个巨章段落 chunk + 1 个空 H2 结尾 = 33
      expect(chunks1).toHaveLength(33);
      expect(chunks1.filter((c) => c.headingPath === '标题 § 巨章')).toHaveLength(30);

      const sections = chunks1.map((c) =>
        makeSection({
          position: c.position,
          headingPath: c.headingPath,
          headingLevel: c.headingLevel,
          isContinuation: c.isContinuation,
          content: c.content,
          tokenEstimate: c.tokenEstimate,
        }),
      );
      const secQb = createMockQueryBuilder(sections, sections.length);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const { content: reconstructed } = await service.getContent('doc-1', true);

      // 每个标题只出现 1 次：4 个不同标题，巨章 30 个兄弟 chunk 只插回一次标题行
      const headingLines = reconstructed.match(/^#{1,6} .+$/gm) ?? [];
      expect(headingLines).toEqual(['# 标题', '## 空分组', '## 巨章', '## 结尾空分组']);
      // 30 段正文都在且顺序正确，无多余空行
      for (let i = 1; i <= 30; i++) {
        expect(reconstructed).toContain(`段落${i}：`);
      }
      expect(reconstructed.indexOf('段落1：')).toBeLessThan(reconstructed.indexOf('段落2：'));
      expect(reconstructed.indexOf('段落29：')).toBeLessThan(reconstructed.indexOf('段落30：'));
      expect(reconstructed).not.toContain('\n\n\n');

      // 重建文再切分 → 与首次切分序列完全一致（往返幂等）
      const chunks2 = chunkMarkdown(reconstructed, doc.title);
      expect(chunks2).toHaveLength(chunks1.length);
      expect(chunks2.map((c) => [c.headingPath, c.headingLevel, c.content])).toEqual(
        chunks1.map((c) => [c.headingPath, c.headingLevel, c.content]),
      );
    });
  });

  // ─── getSection ─────────────────────────────────────────────

  describe('getSection', () => {
    it('finds section by position', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const section = makeSection({ position: 0, content: 'Body text.' });
      const secQb = createMockQueryBuilder([section], 1);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getSection('doc-1', 0);
      expect(result.position).toBe(0);
      expect(result.content).toBe('Body text.');
    });

    it('债 A：getSection 投影透传 headingText（直读列，含 " § " 完整本地标题）', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const section = makeSection({
        position: 1,
        headingPath: '父 § A § B 子',
        headingText: 'A § B 子',
        headingLevel: 2,
        content: 'Body.',
      });
      const secQb = createMockQueryBuilder([section], 1);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getSection('doc-1', 1);
      expect(result.headingText).toBe('A § B 子');
      expect(result.headingPath).toBe('父 § A § B 子');
      // markdown 渲染也用 headingText（标题行完整，不按 " § " 切错）
      expect(result.markdown).toBe('## A § B 子\n\nBody.');
    });

    it('债 A：getSections 批量投影透传 headingText（含续 chunk 共享值）', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const secQb = createMockQueryBuilder(
        [
          makeSection({
            position: 0,
            headingPath: '长节',
            headingText: '长节',
            headingLevel: 1,
            isContinuation: false,
            content: '首段。',
          }),
          makeSection({
            position: 1,
            headingPath: '长节',
            headingText: '长节',
            headingLevel: 1,
            isContinuation: true,
            content: '续段。',
          }),
        ],
        2,
      );
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getSections('doc-1', [0, 1]);
      expect(result.sections.map((s) => s.headingText)).toEqual(['长节', '长节']);
      // 续 chunk markdown 无标题行（run-dedup 语义保持）
      expect(result.sections[1].markdown).toBe('续段。');
    });

    it('finds section by headingPath', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const section = makeSection({
        position: 1,
        headingPath: 'Setup',
        content: 'Setup instructions.',
      });
      const secQb = createMockQueryBuilder([section], 1);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getSection('doc-1', undefined, 'Setup');
      expect(result.position).toBe(1);
      expect(result.headingPath).toBe('Setup');
    });

    it('throws 404 when section not found by position', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const secQb = createMockQueryBuilder([], 0);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      await expect(service.getSection('doc-1', 99)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });

    it('throws 404 when section not found by headingPath', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const secQb = createMockQueryBuilder([], 0);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      await expect(service.getSection('doc-1', undefined, 'NoSuch')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });

    // ─── markdown 保真字段（v1.57.1：renderSectionPart 口径字节级子串 = patch_doc oldString 参照面）───

    it('markdown: position-0 first chunk renders heading line (faithful, no duplicate-title dedup)', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      // position 0 无前驱 → prev 查询不触发，仅一次 sectionRepo 查询
      const section = makeSection({
        position: 0,
        headingPath: 'Test Doc',
        headingLevel: 1,
        content: 'Lead body.',
      });
      const secQb = createMockQueryBuilder([section], 1);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getSection('doc-1', 0);
      // skipDuplicateTitle=false：首 H1 与 doc.title 同名也保留标题行（与 full=true 全文一致）
      expect(result.markdown).toBe('# Test Doc\n\nLead body.');
    });

    it('markdown: continuation chunk uses its persisted flag and renders body only', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      // 目标节是 >4000 字符长节段落二次切分的续 chunk：renderer 只信 isContinuation，
      // 不再查询或比较前一节的 headingPath/headingLevel。
      const section = makeSection({
        position: 2,
        headingPath: 'A § X',
        headingLevel: 2,
        isContinuation: true,
        content: 'Para two.',
      });
      const targetQb = createMockQueryBuilder([section], 1);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(targetQb);

      const result = await service.getSection('doc-1', 2);
      expect(result.isContinuation).toBe(true);
      expect(result.markdown).toBe('Para two.');
      expect(sectionRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('markdown: empty-content section renders heading line only (no trailing \\n\\n)', async () => {
      const doc = makeDoc();
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      // 空正文标题（chunker 保真产出的空 H2 分组标题）：markdown = 仅标题行、无尾部
      // '\n\n'——与 renderSectionPart 空 content 分支（该节在 full=true 全文中的字节形态）一致
      const section = makeSection({
        position: 0,
        headingPath: '空分组',
        headingLevel: 2,
        content: '',
      });
      const secQb = createMockQueryBuilder([section], 1);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getSection('doc-1', 0);
      expect(result.markdown).toBe('## 空分组');
    });
  });

  // ─── getSections（v1.55 positions[] 批量读节）────────────────

  describe('getSections', () => {
    /** findById 命中目标 doc（getOne 语义） */
    function mockDocFound() {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([makeDoc()], 1),
      );
    }
    /** section 全量查询（position ASC，getMany 语义） */
    function mockAllSections(sections: DocSection[]) {
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder(sections, sections.length),
      );
    }

    const sec = (p: number, headingPath: string | null) =>
      makeSection({
        position: p,
        headingPath,
        headingLevel: headingPath ? 2 : 0,
        content: `body-${p}`,
        tokenEstimate: 10,
      });

    it('returns only requested positions in position ASC with empty missing', async () => {
      mockDocFound();
      mockAllSections([sec(0, 'A § 一'), sec(1, 'A § 二'), sec(2, 'A § 三'), sec(3, 'A § 四')]);

      const result = await service.getSections('doc-1', [3, 0, 1]);

      expect(result.docId).toBe('doc-1');
      expect(result.docPath).toBe('docs/test.md');
      expect(result.sections.map((s) => s.position)).toEqual([0, 1, 3]);
      expect(result.sections[0].content).toBe('body-0');
      expect(result.sections[0].headingPath).toBe('A § 一');
      expect(result.missing).toEqual([]);
    });

    it('dedupes duplicate positions and reports out-of-range ones in missing (partial-failure friendly)', async () => {
      mockDocFound();
      mockAllSections([sec(0, 'A § 一'), sec(2, 'A § 三')]);

      // 请求 [2,2,9,0]：2 重复去重、9 越界 → missing，不整体报错
      const result = await service.getSections('doc-1', [2, 2, 9, 0]);

      expect(result.sections.map((s) => s.position)).toEqual([0, 2]);
      expect(result.missing).toEqual([9]);
    });

    it('missing keeps request order deduped and sorted ascending', async () => {
      mockDocFound();
      mockAllSections([sec(0, 'A § 一')]);

      // 请求含命中 0 与越界 7/3/7/1：missing 去重且升序
      const result = await service.getSections('doc-1', [0, 7, 3, 7, 1]);

      expect(result.sections).toHaveLength(1);
      expect(result.missing).toEqual([1, 3, 7]);
    });

    it('throws 404 when doc does not exist (findById layer)', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([], 0));

      await expect(service.getSections('doc-1', [0])).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
      expect(sectionRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('markdown: per-item fragment follows isContinuation without predecessor context', async () => {
      // v1.57.3：批量读取不再需要全量前驱来猜测 run-dedup；section 自身携带事实标记。
      mockDocFound();
      mockAllSections([
        sec(0, 'A § X'),
        makeSection({
          position: 1,
          headingPath: 'A § X',
          headingLevel: 2,
          isContinuation: true,
          content: 'body-1',
          tokenEstimate: 10,
        }),
        sec(2, 'B § Y'),
      ]);

      const result = await service.getSections('doc-1', [1, 2]);
      expect(result.sections[0].isContinuation).toBe(true);
      expect(result.sections[0].markdown).toBe('body-1');
      expect(result.sections[1].isContinuation).toBe(false);
      expect(result.sections[1].markdown).toBe('## Y\n\nbody-2');

      const single = await service.getSections('doc-1', [1]);
      expect(single.sections[0].markdown).toBe('body-1');
    });

    it('markdown: empty-content section renders heading line only', async () => {
      mockDocFound();
      mockAllSections([
        makeSection({ position: 0, headingPath: '空分组', headingLevel: 2, content: '' }),
      ]);

      const result = await service.getSections('doc-1', [0]);
      expect(result.sections[0].markdown).toBe('## 空分组');
    });
  });

  // ─── getSectionByHeadingQuery（v1.55 headingQuery 模糊定位）───

  describe('getSectionByHeadingQuery', () => {
    const sec = (p: number, headingPath: string | null) =>
      makeSection({
        position: p,
        headingPath,
        headingLevel: headingPath ? 2 : 0,
        content: `body-${p}`,
        tokenEstimate: 10,
      });

    it('unique hit returns that section (same shape as getSection)', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([makeDoc()], 1),
      );
      const secQb = createMockQueryBuilder([sec(2, 'A § 设计')], 1);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      const result = await service.getSectionByHeadingQuery('doc-1', '设计');

      expect(result).toMatchObject({
        docId: 'doc-1',
        docPath: 'docs/test.md',
        position: 2,
        headingPath: 'A § 设计',
        content: 'body-2',
      });
      // ILIKE 模糊匹配：大小写不敏感子串（%query% 包裹）
      expect(secQb.andWhere).toHaveBeenCalledWith(expect.stringContaining('ILIKE'), {
        pattern: '%设计%',
      });
    });

    it('multiple hits → 409 RESOURCE_CONFLICT with data.candidates in position ASC (never silently picks)', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([makeDoc()], 1),
      );
      // 同名子标题在不同章节下可重复（headingPath 链可重复）；
      // mock 注入序模拟 SQL ORDER BY position ASC（真实排序由 SQL 保证）
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([sec(1, 'B § 总结'), sec(5, 'A § 总结')], 2),
      );

      await expect(service.getSectionByHeadingQuery('doc-1', '总结')).rejects.toMatchObject({
        response: {
          code: ErrorCode.RESOURCE_CONFLICT,
          data: {
            candidates: [
              { position: 1, headingPath: 'B § 总结' },
              { position: 5, headingPath: 'A § 总结' },
            ],
          },
        },
      });
    });

    it('zero hits → 404 DOC_NOT_FOUND with outline hint', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([makeDoc()], 1),
      );
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([], 0));

      await expect(service.getSectionByHeadingQuery('doc-1', '无此标题')).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_NOT_FOUND,
          message: expect.stringContaining('outline'),
        },
      });
    });

    it('escapes LIKE wildcards in user input (\\ % _ matched literally, not as patterns)', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([makeDoc()], 1),
      );
      const secQb = createMockQueryBuilder([], 0);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(secQb);

      await expect(service.getSectionByHeadingQuery('doc-1', '100%_\\done')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });

      // 输入中的 % _ \ 必须逐字符转义为 \\% \\_ \\\\（LIKE ESCAPE '\' 语义，字面子串匹配）
      expect(secQb.andWhere).toHaveBeenCalledWith(expect.stringContaining('ESCAPE'), {
        pattern: '%100\\%\\_\\\\done%',
      });
    });

    it('markdown: unique hit carries faithful fragment (prev = nearest lower position)', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([makeDoc()], 1),
      );

      // 目标节前有不同 headingPath 的节 → 非兄弟 → 插标题行；prev 查询取最近前一节
      const target = makeSection({
        position: 2,
        headingPath: 'A § 设计',
        headingLevel: 2,
        content: 'body-2',
      });
      const prev = makeSection({
        position: 1,
        headingPath: 'A § 一',
        headingLevel: 2,
        content: 'body-1',
      });
      // 调用序：findById → ILIKE matches（getMany）→ prev 查询（getOne）
      const matchQb = createMockQueryBuilder([target], 1);
      const prevQb = createMockQueryBuilder([prev], 1);
      (sectionRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(matchQb)
        .mockReturnValueOnce(prevQb);

      const result = await service.getSectionByHeadingQuery('doc-1', '设计');
      expect(result.markdown).toBe('## 设计\n\nbody-2');
    });
  });

  // ─── remove ─────────────────────────────────────────────────

  // ─── patchSection（section 级写，v1.55 T3）──────────────────

  describe('patchSection', () => {
    /** chunker 契约 section：content 不含标题行，标题在 headingPath/headingLevel */
    const secA = () =>
      makeSection({
        id: 'sec-0',
        position: 0,
        headingPath: 'Test Doc',
        headingLevel: 1,
        content: 'Intro body.',
      });
    const secB = () =>
      makeSection({
        id: 'sec-1',
        position: 1,
        headingPath: 'Test Doc § 第二节',
        headingLevel: 2,
        content: 'Section two body.',
      });
    const secC = () =>
      makeSection({
        id: 'sec-2',
        position: 2,
        headingPath: 'Test Doc § 第三节',
        headingLevel: 2,
        content: 'Section three body.',
      });

    /** findById 与 upsert 内部 existing 查询共用 docRepo QB —— 统一返回目标 doc */
    function mockDocFound(doc: Doc) {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([doc], 1));
    }
    /** patchSection 的全量 section 查询（position ASC） */
    function mockSections(sections: DocSection[]) {
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder(sections, sections.length),
      );
    }

    it('替换目标节并复用 upsert 管线（title/summary/source/path 透传防冲掉策展元数据）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB(), secC()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 3, tokenEstimate: 120 });

      const result = await service.patchSection('doc-1', 1, '## 第二节\n\n全新正文', 'native');

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const [spaceId, dto] = upsertSpy.mock.calls[0] as [string, Record<string, any>];
      expect(spaceId).toBe('space-1');
      // 整篇拼接 = 前节渲染片段 + 新节内容 + 后节渲染片段（skipDuplicateTitle=false 保真：
      // 首节 H1 与 doc.title 同名也保留标题行，与 web full=true 回写契约一致）
      expect(dto.content).toBe(
        '# Test Doc\n\nIntro body.\n\n## 第二节\n\n全新正文\n\n## 第三节\n\nSection three body.',
      );
      expect(dto.title).toBe('Test Doc');
      expect(dto.summary).toBe('A test document');
      expect(dto.source).toBe('native');
      expect(dto.path).toBe('docs/test.md');
      expect(result.id).toBe(doc.id);
    });

    it('空 content = 删除该节（拼接时过滤空片段）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB(), secC()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 2, tokenEstimate: 80 });

      await service.patchSection('doc-1', 1, '', 'native');

      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).content).toBe(
        '# Test Doc\n\nIntro body.\n\n## 第三节\n\nSection three body.',
      );
    });

    it('source 原样透传给 upsert（非 native 文档的 409 隔离检查在 upsert 内完成）', async () => {
      const doc = makeDoc({ source: 'git:oss-docs' });
      mockDocFound(doc);
      mockSections([secA()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 1, tokenEstimate: 10 });

      await service.patchSection('doc-1', 0, '# Test Doc\n\nnew body', 'git:oss-docs');

      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).source).toBe('git:oss-docs');
    });

    it('position 越界（≥ section 数 / 负数）→ 404 DOC_NOT_FOUND，upsert 不被调用', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA()]);
      const upsertSpy = jest.spyOn(service as any, 'upsertCore');

      await expect(service.patchSection('doc-1', 1, 'x', 'native')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
      await expect(service.patchSection('doc-1', -1, 'x', 'native')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('文档不存在 → 404 DOC_NOT_FOUND（findById 判空，铁律 #22）', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([], 0));

      await expect(service.patchSection('ghost-doc', 0, 'x', 'native')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });
  });

  // ─── fail-closed 改造（Hument 事故 6dbc4da3）：sectionHash 派生 / 前提校验 ───

  describe('sectionHash 派生（读通道返回写前提校验锚点）', () => {
    // 与服务端 computeSectionHash 同口径的期望哈希：sha256(headingPath\nheadingLevel\ncontent)
    // 输入 = 存储三元组（不是渲染片段——渲染依赖前一节会产生错误耦合）
    const expectedHash = (s: {
      headingPath: string | null;
      headingLevel: number;
      content: string;
    }) =>
      require('crypto')
        .createHash('sha256')
        .update(`${s.headingPath ?? ''}\n${s.headingLevel}\n${s.content}`)
        .digest('hex');

    it('getSection 返回体带 sectionHash（存储三元组派生，可复算验证）', async () => {
      const doc = makeDoc();
      const section = makeSection({ headingPath: 'Test § A', headingLevel: 2, content: 'Body A' });
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([doc], 1));
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([section], 1),
      );

      const result = await service.getSection('doc-1', 0);
      expect(result.sectionHash).toBe(expectedHash(section));
    });

    it('getSections 批量通道每项带 sectionHash', async () => {
      const doc = makeDoc();
      const s0 = makeSection({
        id: 'sec-0',
        position: 0,
        headingPath: 'Test',
        headingLevel: 1,
        content: 'B0',
      });
      const s1 = makeSection({
        id: 'sec-1',
        position: 1,
        headingPath: 'Test § A',
        headingLevel: 2,
        content: 'B1',
      });
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([doc], 1));
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([s0, s1], 2),
      );

      const result = await service.getSections('doc-1', [0, 1]);
      expect(result.sections[0].sectionHash).toBe(expectedHash(s0));
      expect(result.sections[1].sectionHash).toBe(expectedHash(s1));
    });

    it('getSectionByHeadingQuery 唯一命中带 sectionHash', async () => {
      const doc = makeDoc();
      const section = makeSection({
        headingPath: 'Test § Only',
        headingLevel: 2,
        content: 'Only body',
      });
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([doc], 1));
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([section], 1),
      );

      const result = await service.getSectionByHeadingQuery('doc-1', 'Only');
      expect(result.sectionHash).toBe(expectedHash(section));
    });
  });

  describe('patchSection — expectedSectionHash 前提校验（fail-closed）', () => {
    const secA = () =>
      makeSection({
        id: 'sec-0',
        position: 0,
        headingPath: 'Test Doc',
        headingLevel: 1,
        content: 'Intro body.',
      });
    const secB = () =>
      makeSection({
        id: 'sec-1',
        position: 1,
        headingPath: 'Test Doc § 第二节',
        headingLevel: 2,
        content: 'Section two body.',
      });

    const hashOf = (s: DocSection) =>
      require('crypto')
        .createHash('sha256')
        .update(`${s.headingPath ?? ''}\n${s.headingLevel}\n${s.content}`)
        .digest('hex');

    function mockDocFound(doc: Doc) {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([doc], 1));
    }
    function mockSections(sections: DocSection[]) {
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder(sections, sections.length),
      );
    }

    it('hash 匹配 → 放行，且 upsert 携带内部乐观锁 expectedContentHash（TOCTOU 加固）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({
          id: doc.id,
          path: doc.path,
          sectionCount: 2,
          tokenEstimate: 60,
          contentHash: 'new-hash',
        });

      const result = await service.patchSection(
        'doc-1',
        1,
        '## 第二节\n\n新正文',
        'native',
        undefined,
        hashOf(secB()),
      );

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      // 内部乐观锁：读取时的 doc.contentHash 传给 upsert，事务内 FOR UPDATE 复核
      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).expectedContentHash).toBe(
        doc.contentHash,
      );
      expect(result.contentHash).toBe('new-hash');
    });

    it('hash 不符 → 409 DOC_CONTENT_CONFLICT + data.sectionCount（stale position 写不进去），upsert 不被调用', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB()]);
      const upsertSpy = jest.spyOn(service as any, 'upsertCore');

      await expect(
        service.patchSection('doc-1', 1, '## 第二节\n\n篡改', 'native', undefined, 'stale-hash'),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_CONTENT_CONFLICT, data: { sectionCount: 2 } },
      });
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('缺省 expectedSectionHash → 旧行为放行（仍携带内部 expectedContentHash）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 2, tokenEstimate: 60 });

      await service.patchSection('doc-1', 1, '## 第二节\n\n新正文', 'native');

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).expectedContentHash).toBe(
        doc.contentHash,
      );
    });
  });

  // ─── patchByMatch（match 模式写，fail-closed 改造新增）────────────

  describe('patchByMatch', () => {
    const secA = () =>
      makeSection({
        id: 'sec-0',
        position: 0,
        headingPath: 'Test Doc',
        headingLevel: 1,
        content: 'Intro body.',
      });
    const secB = () =>
      makeSection({
        id: 'sec-1',
        position: 1,
        headingPath: 'Test Doc § 第二节',
        headingLevel: 2,
        content: 'Section two body.',
      });
    const secC = () =>
      makeSection({
        id: 'sec-2',
        position: 2,
        headingPath: 'Test Doc § 第三节',
        headingLevel: 2,
        content: 'Section three body.',
      });

    function mockDocFound(doc: Doc) {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([doc], 1));
    }
    function mockSections(sections: DocSection[]) {
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder(sections, sections.length),
      );
    }

    it('唯一命中 → 替换后复用 upsert 管线（操作面 = full=true 保真全文；携带内部乐观锁）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB(), secC()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 3, tokenEstimate: 120 });

      await service.patchByMatch('doc-1', 'Section two body.', 'REPLACED body.', 'native');

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const dto = upsertSpy.mock.calls[0][1] as Record<string, any>;
      // 全文口径与 patchSection 相同（renderSectionPart + skipDuplicateTitle=false + '\n\n' join）
      expect(dto.content).toBe(
        '# Test Doc\n\nIntro body.\n\n## 第二节\n\nREPLACED body.\n\n## 第三节\n\nSection three body.',
      );
      expect(dto.expectedContentHash).toBe(doc.contentHash);
      expect(dto.title).toBe('Test Doc');
      expect(dto.source).toBe('native');
    });

    it('0 命中 → 404 DOC_NOT_FOUND（提示先读全文），upsert 不被调用', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA()]);
      const upsertSpy = jest.spyOn(service as any, 'upsertCore');

      await expect(
        service.patchByMatch('doc-1', '不存在的字符串xyz', 'x', 'native'),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('多命中 → 409 RESOURCE_CONFLICT + data.matchCount（绝不静默替换）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB(), secC()]);
      const upsertSpy = jest.spyOn(service as any, 'upsertCore');

      // 'body' 在三节正文中各出现一次 → 3 命中
      await expect(service.patchByMatch('doc-1', 'body', 'x', 'native')).rejects.toMatchObject({
        response: { code: ErrorCode.RESOURCE_CONFLICT, data: { matchCount: 3 } },
      });
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('newString 中的 $ 模式按字面量处理（函数式 replacer，不被解释）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 2, tokenEstimate: 60 });

      await service.patchByMatch('doc-1', 'Intro body.', '$& $1', 'native');

      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).content).toContain('$& $1');
    });

    it('文档不存在 → 404 DOC_NOT_FOUND（findById 判空，铁律 #22）', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([], 0));

      await expect(service.patchByMatch('ghost-doc', 'x', 'y', 'native')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });
  });

  // ─── appendDoc（追加写原语，v1.65.0 消费者反馈批 7601e2f5）────────────

  describe('appendDoc', () => {
    /** chunker 契约 section：content 不含标题行，标题在 headingPath/headingLevel */
    const secA = () =>
      makeSection({
        id: 'sec-0',
        position: 0,
        headingPath: 'Test Doc',
        headingLevel: 1,
        content: 'Intro body.',
      });
    const secB = () =>
      makeSection({
        id: 'sec-1',
        position: 1,
        headingPath: 'Test Doc § 第二节',
        headingLevel: 2,
        content: 'Section two body.',
      });
    const secC = () =>
      makeSection({
        id: 'sec-2',
        position: 2,
        headingPath: 'Test Doc § 第三节',
        headingLevel: 2,
        content: 'Section three body.',
      });

    /** findById 与 upsert 内部 existing 查询共用 docRepo QB —— 统一返回目标 doc */
    function mockDocFound(doc: Doc) {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([doc], 1));
    }
    /** appendDoc 的全量 section 查询（position ASC） */
    function mockSections(sections: DocSection[]) {
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder(sections, sections.length),
      );
    }

    it('end 模式：全文末尾追加（trim 首尾空白；title/summary/source/path 透传防冲掉策展元数据）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB(), secC()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 4, tokenEstimate: 150 });

      const result = await service.appendDoc('doc-1', { content: '  追加内容  ' }, 'native');

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const [spaceId, dto] = upsertSpy.mock.calls[0] as [string, Record<string, any>];
      expect(spaceId).toBe('space-1');
      // 整篇 = 保真渲染拼接 + '\n\n' + trim 后的追加内容（与管线 join 分隔一致）
      expect(dto.content).toBe(
        '# Test Doc\n\nIntro body.\n\n## 第二节\n\nSection two body.\n\n## 第三节\n\nSection three body.\n\n追加内容',
      );
      expect(dto.title).toBe('Test Doc');
      expect(dto.summary).toBe('A test document');
      expect(dto.source).toBe('native');
      expect(dto.path).toBe('docs/test.md');
      // 内部乐观锁：读取时的 doc.contentHash 传给 upsert（TOCTOU 加固）
      expect(dto.expectedContentHash).toBe(doc.contentHash);
      // versionSource='append'：版本行 source 标记（doc_versions.source 自由 varchar 无约束）
      expect(dto.versionSource).toBe('append');
      expect(result.id).toBe(doc.id);
    });

    it('end 模式：空文档（无 section）直接返回 content，不产生前导空行', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 1, tokenEstimate: 10 });

      await service.appendDoc('doc-1', { content: '  首条内容  ' }, 'native');

      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).content).toBe('首条内容');
    });

    it('end 模式：content 自带 heading → 原样拼接（chunker 会切出新 section）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 2, tokenEstimate: 60 });

      await service.appendDoc('doc-1', { content: '## 新节\n\n新正文' }, 'native');

      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).content).toBe(
        '# Test Doc\n\nIntro body.\n\n## 新节\n\n新正文',
      );
    });

    it('under-heading：目标节有子树（continuation 续节 + 更深节）→ 新 part 插到子树末尾', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([
        secA(),
        makeSection({
          id: 'sec-1',
          position: 1,
          headingPath: 'Test Doc § 目标节',
          headingLevel: 2,
          content: 'Target body.',
        }),
        makeSection({
          id: 'sec-2',
          position: 2,
          headingPath: 'Test Doc § 目标节',
          headingLevel: 2,
          isContinuation: true,
          content: 'Target continuation.',
        }),
        makeSection({
          id: 'sec-3',
          position: 3,
          headingPath: 'Test Doc § 目标节 § 子节',
          headingLevel: 3,
          content: 'Deeper body.',
        }),
        secC(),
      ]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 5, tokenEstimate: 200 });

      await service.appendDoc(
        'doc-1',
        { content: '新追加内容', position: 'under-heading', headingPath: 'Test Doc § 目标节' },
        'native',
      );

      // 子树 = 目标节 + 同 path continuation + 更深节；新 part 插在子树末尾（下一节之前）
      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).content).toBe(
        '# Test Doc\n\nIntro body.\n\n## 目标节\n\nTarget body.\n\nTarget continuation.\n\n' +
          '### 子节\n\nDeeper body.\n\n新追加内容\n\n## 第三节\n\nSection three body.',
      );
    });

    it('under-heading：目标节是叶子（无子树）→ 插到目标节之后、下一节之前', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB(), secC()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 4, tokenEstimate: 150 });

      await service.appendDoc(
        'doc-1',
        { content: '新追加内容', position: 'under-heading', headingPath: 'Test Doc § 第二节' },
        'native',
      );

      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).content).toBe(
        '# Test Doc\n\nIntro body.\n\n## 第二节\n\nSection two body.\n\n新追加内容\n\n## 第三节\n\nSection three body.',
      );
    });

    it('under-heading：0 命中 → 404 DOC_NOT_FOUND + data.availableHeadingPaths（附可用列表）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA(), secB()]);
      const upsertSpy = jest.spyOn(service as any, 'upsertCore');

      await expect(
        service.appendDoc(
          'doc-1',
          { content: 'x', position: 'under-heading', headingPath: '不存在的节' },
          'native',
        ),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_NOT_FOUND,
          data: { availableHeadingPaths: ['Test Doc', 'Test Doc § 第二节'] },
        },
      });
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('under-heading：多命中（同名 sibling）→ 409 RESOURCE_CONFLICT + data.candidates（绝不静默挑选）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([
        secA(),
        makeSection({
          id: 'sec-1',
          position: 1,
          headingPath: 'Test Doc § 同名节',
          headingLevel: 2,
          content: 'First.',
        }),
        makeSection({
          id: 'sec-2',
          position: 2,
          headingPath: 'Test Doc § 同名节',
          headingLevel: 2,
          content: 'Second.',
        }),
      ]);
      const upsertSpy = jest.spyOn(service as any, 'upsertCore');

      await expect(
        service.appendDoc(
          'doc-1',
          { content: 'x', position: 'under-heading', headingPath: 'Test Doc § 同名节' },
          'native',
        ),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.RESOURCE_CONFLICT,
          data: {
            candidates: [
              { position: 1, headingPath: 'Test Doc § 同名节' },
              { position: 2, headingPath: 'Test Doc § 同名节' },
            ],
          },
        },
      });
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('source 原样透传给 upsert（非 native 文档的 409 隔离检查在 upsert 内完成）', async () => {
      const doc = makeDoc({ source: 'git:oss-docs' });
      mockDocFound(doc);
      mockSections([secA()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockResolvedValue({ id: doc.id, path: doc.path, sectionCount: 2, tokenEstimate: 60 });

      await service.appendDoc('doc-1', { content: 'x' }, 'git:oss-docs');

      expect((upsertSpy.mock.calls[0][1] as Record<string, any>).source).toBe('git:oss-docs');
    });

    it('文档不存在 → 404 DOC_NOT_FOUND（findById 判空，铁律 #22）', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([], 0));

      await expect(
        service.appendDoc('ghost-doc', { content: 'x' }, 'native'),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });

    // ─── 并发免疫（本入口核心卖点）：DOC_CONTENT_CONFLICT 服务端内部重试 ───

    it('并发：upsertCore 首次抛 DOC_CONTENT_CONFLICT → 自动重试成功（重读两轮 sections，最终成功）', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA()]);
      const conflict = new ConflictException({
        message:
          'expectedContentHash mismatch (in-transaction recheck): document was modified concurrently',
        code: ErrorCode.DOC_CONTENT_CONFLICT,
      });
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({
          id: doc.id,
          path: doc.path,
          sectionCount: 2,
          tokenEstimate: 60,
          contentHash: 'new-hash',
        });

      const result = await service.appendDoc('doc-1', { content: '追加内容' }, 'native');

      expect(upsertSpy).toHaveBeenCalledTimes(2);
      // 重试 = 重读 doc+sections → 重新变换 → 重写（两轮 section 查询）
      expect(sectionRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(result.contentHash).toBe('new-hash');
    });

    it('并发：3 次耗尽 → 409 DOC_CONTENT_CONFLICT 透传给调用方', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA()]);
      const conflict = new ConflictException({
        message:
          'expectedContentHash mismatch (in-transaction recheck): document was modified concurrently',
        code: ErrorCode.DOC_CONTENT_CONFLICT,
      });
      const upsertSpy = jest.spyOn(service as any, 'upsertCore').mockRejectedValue(conflict);

      await expect(
        service.appendDoc('doc-1', { content: '追加内容' }, 'native'),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_CONTENT_CONFLICT },
      });
      expect(upsertSpy).toHaveBeenCalledTimes(3);
    });

    it('并发：非 409 错误（404）不重试，直接抛', async () => {
      const doc = makeDoc();
      mockDocFound(doc);
      mockSections([secA()]);
      const upsertSpy = jest
        .spyOn(service as any, 'upsertCore')
        .mockRejectedValueOnce(
          new NotFoundException({ message: 'Document not found', code: ErrorCode.DOC_NOT_FOUND }),
        );

      await expect(
        service.appendDoc('doc-1', { content: '追加内容' }, 'native'),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
      expect(upsertSpy).toHaveBeenCalledTimes(1);
    });

    // ─── 幂等（v1.63.0 体系）：重放返回首次快照 / 同 key 不同 payload → 409 ───

    it('幂等：同 key 重放返回首次快照 + idempotentReplay，不重复追加（upsert 不被调用）', async () => {
      const snapshot = {
        id: 'doc-1',
        path: 'docs/test.md',
        sectionCount: 2,
        tokenEstimate: 60,
        contentHash: 'new-hash',
      };
      // 与 buildIdempotencyContext 同口径的 payload 指纹（key 顺序 = 服务端字面量顺序；
      // JSON.stringify 省略 undefined 字段）
      const requestHash = require('crypto')
        .createHash('sha256')
        .update(
          JSON.stringify({
            docId: 'doc-1',
            content: '追加内容',
            position: 'end',
            headingPath: undefined,
            source: 'native',
          }),
        )
        .digest('hex');
      idempotencyRepo.findOne = jest.fn().mockResolvedValue({
        entityType: 'doc',
        requestHash,
        responseSnapshot: snapshot,
      });
      const upsertSpy = jest.spyOn(service as any, 'upsertCore');

      const result = await service.appendDoc(
        'doc-1',
        { content: '追加内容' },
        'native',
        undefined,
        'key-1',
      );

      expect(result).toEqual({ ...snapshot, idempotentReplay: true });
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('幂等：同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT（防静默吞写）', async () => {
      idempotencyRepo.findOne = jest.fn().mockResolvedValue({
        entityType: 'doc',
        requestHash: 'different-hash',
        responseSnapshot: { id: 'doc-1' },
      });
      const upsertSpy = jest.spyOn(service as any, 'upsertCore');

      await expect(
        service.appendDoc('doc-1', { content: '追加内容' }, 'native', undefined, 'key-1'),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT },
      });
      expect(upsertSpy).not.toHaveBeenCalled();
    });
  });

  // ─── upsert expectedContentHash 乐观锁（fail-closed 改造）──────────

  describe('upsert — expectedContentHash 乐观锁', () => {
    const dto = {
      path: 'docs/test.md',
      content: '# Hello\n\nSome content.',
    };

    it('hash 不符 → 409 DOC_CONTENT_CONFLICT（事务外快速失败），不进事务', async () => {
      const existingDoc = makeDoc({ contentHash: 'abc123' });
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([existingDoc], 1),
      );

      await expect(
        service.upsert('space-1', { ...dto, expectedContentHash: 'deadbeef' }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_CONTENT_CONFLICT,
          data: { currentContentHash: 'abc123' },
        },
      });
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('文档不存在 + 携带 expectedContentHash → 409（不得静默降级为新建）', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([], 0));

      await expect(
        service.upsert('space-1', { ...dto, expectedContentHash: 'abc123' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_CONTENT_CONFLICT, data: { currentContentHash: null } },
      });
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('hash 相符 + 内容变更 → 事务内 FOR UPDATE 复核通过后重建，返回值带新 contentHash', async () => {
      const existingDoc = makeDoc({ contentHash: 'abc123' });
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([existingDoc], 1),
      );

      // 事务真实执行：manager repo 的 createQueryBuilder 供 FOR UPDATE 锁行重读（getOne → 同一 doc）
      const saveSpy = jest.fn((x: unknown) => Promise.resolve(x));
      const managerRepo = {
        save: saveSpy,
        create: jest.fn((x: unknown) => x),
        createQueryBuilder: jest.fn(() => createMockQueryBuilder([existingDoc], 1)),
      };
      mockTransaction.mockImplementation((fn: any) => fn({ getRepository: () => managerRepo }));

      const result = await service.upsert('space-1', { ...dto, expectedContentHash: 'abc123' });

      expect(result.contentHash).toBe(
        require('crypto').createHash('sha256').update(dto.content).digest('hex'),
      );
      // 锁行重读发生在事务内（FOR UPDATE 语义由 setLock 调用佐证）
      const lockQb = managerRepo.createQueryBuilder.mock.results[0].value;
      expect(lockQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ contentHash: result.contentHash }),
      );
    });

    it('事务内复核发现并发改动（锁行后 hash 已变）→ 409 回滚，不写库', async () => {
      const existingDoc = makeDoc({ contentHash: 'abc123' });
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([existingDoc], 1),
      );

      // 锁行重读返回的 doc 已是并发改动后的版本（hash 不同）→ 事务内 409
      const concurrentlyModified = makeDoc({ contentHash: 'concurrent-change' });
      const saveSpy = jest.fn((x: unknown) => Promise.resolve(x));
      const managerRepo = {
        save: saveSpy,
        create: jest.fn((x: unknown) => x),
        createQueryBuilder: jest.fn(() => createMockQueryBuilder([concurrentlyModified], 1)),
      };
      mockTransaction.mockImplementation((fn: any) => fn({ getRepository: () => managerRepo }));

      await expect(
        service.upsert('space-1', { ...dto, expectedContentHash: 'abc123' }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_CONTENT_CONFLICT,
          data: { currentContentHash: 'concurrent-change' },
        },
      });
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('hash 相符 + 内容未变 → unchanged 正常返回（不算冲突）且带 contentHash', async () => {
      const hash = require('crypto').createHash('sha256').update(dto.content).digest('hex');
      const existingDoc = makeDoc({
        contentHash: hash,
        linkHealth: { total: 0, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
      });
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([existingDoc], 1),
      );

      const result = await service.upsert('space-1', { ...dto, expectedContentHash: hash });

      expect(result.unchanged).toBe(true);
      expect(result.contentHash).toBe(hash);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('更新/新建返回值统一带 contentHash（链式写免重读）', async () => {
      // 更新分支
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([existingDoc], 1),
      );
      mockTransaction.mockResolvedValue({
        doc: makeDoc({ contentHash: 'newhash' }),
        assembled: { ...makeDoc({ contentHash: 'newhash' }), created: false },
      });

      const updated = await service.upsert('space-1', dto);
      expect(updated.contentHash).toBe('newhash');

      // 新建分支
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([], 0));
      mockTransaction.mockResolvedValue({
        doc: makeDoc({ id: 'doc-new', contentHash: 'createdhash' }),
        assembled: { ...makeDoc({ id: 'doc-new', contentHash: 'createdhash' }), created: true },
      });

      const created = await service.upsert('space-1', dto);
      expect(created.contentHash).toBe('createdhash');
    });
  });

  describe('remove', () => {
    it('soft-deletes a native doc', async () => {
      const doc = makeDoc({ source: 'native' });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.remove('doc-1');
      expect(result.deleted).toBe(true);
      expect(result.path).toBe('docs/test.md');
    });

    it('throws 409 when non-native source does not match', async () => {
      const doc = makeDoc({ source: 'git:other-repo' });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await expect(service.remove('doc-1', 'git:my-repo')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_SOURCE_MISMATCH },
      });
    });

    it('throws 409 when deleting a non-native doc without source (A1: missing source also mismatches)', async () => {
      // 强制校验：非 native 文档必须带精确匹配的 source；缺省 source 同样 409，
      // 防止 ingest 文档被普通 API/MCP 删除路径直接清掉
      const doc = makeDoc({ source: 'git:my-repo' });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await expect(service.remove('doc-1', undefined)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_SOURCE_MISMATCH },
      });
    });

    it('allows deletion when source matches', async () => {
      const doc = makeDoc({ source: 'git:my-repo' });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.remove('doc-1', 'git:my-repo');
      expect(result.deleted).toBe(true);
    });

    it('allows native doc deletion without source param', async () => {
      const doc = makeDoc({ source: 'native' });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.remove('doc-1', undefined);
      expect(result.deleted).toBe(true);
    });

    it('emits DOC_DELETED on soft-delete', async () => {
      const doc = makeDoc({
        source: 'native',
        spaceId: 'space-1',
        path: 'docs/test.md',
        title: 'Test Doc',
      });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      // Space context for event
      const spaceQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ ds_board_id: null, ds_topic_id: 'topic-1' }),
      };
      (docSpaceRepo.createQueryBuilder as jest.Mock).mockReturnValue(spaceQb);

      const result = await service.remove('doc-1');
      expect(result.deleted).toBe(true);

      expect(eventService.create).toHaveBeenCalledWith({
        eventType: EventType.DOC_DELETED,
        resourceType: 'doc',
        resourceId: 'doc-1',
        topicId: 'topic-1',
        boardId: undefined,
        payload: { spaceId: 'space-1', docId: 'doc-1', path: 'docs/test.md', title: 'Test Doc' },
      });
    });

    it('writes audit log when actor is provided', async () => {
      const doc = makeDoc({ source: 'native', spaceId: 'space-1' });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      const spaceQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ ds_board_id: null, ds_topic_id: null }),
      };
      (docSpaceRepo.createQueryBuilder as jest.Mock).mockReturnValue(spaceQb);

      await service.remove('doc-1', undefined, { id: 'user-1' } as never);

      expect(auditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DELETE,
          entityType: 'doc',
          entityId: 'doc-1',
          actorId: 'user-1',
        }),
      );
      expect(auditRepo.save).toHaveBeenCalled();
    });

    it('批次 C1：删文后同一 setImmediate 触发 recheckSpace（路由锚点悬空重检）', async () => {
      const doc = makeDoc({ source: 'native', spaceId: 'space-1' });
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.remove('doc-1');
      await flushImmediates();

      expect(routeHealthService.recheckSpace).toHaveBeenCalledWith('space-1');
    });
  });

  // ─── link_health ─────────────────────────────────────────────

  describe('link_health', () => {
    /**
     * Helper: set up a transaction mock that captures what Doc.save receives.
     * Returns the captured doc via the callback.
     */
    function setupTransactionCapture(onSave: (doc: Doc) => void) {
      mockTransaction.mockImplementation(async (fn: any) => {
        const result = await fn({
          getRepository: jest.fn((Entity: any) => {
            if (Entity === Doc) {
              return {
                save: jest.fn((x: any) => {
                  onSave(x);
                  return Promise.resolve(x);
                }),
                create: jest.fn((x: any) => x),
                createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
              };
            }
            return {
              save: jest.fn((x: any) => Promise.resolve(x)),
              create: jest.fn((x: any) => x),
              createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
            };
          }),
        });
        return result;
      });
    }

    it('computes linkHealth with broken .md path on upsert', async () => {
      // First createQueryBuilder: no existing doc
      const emptyQb = createMockQueryBuilder([], 0);
      // Second createQueryBuilder: space docs for link health resolution
      const spaceDocsQb = createMockQueryBuilder(
        [{ id: 'doc-001', path: 'docs/guide.md' } as Doc],
        1,
      );
      (docRepo.createQueryBuilder as jest.Mock).mockReset();
      (docRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(emptyQb)
        .mockReturnValueOnce(spaceDocsQb);

      let savedDoc: Doc | null = null;
      setupTransactionCapture((doc) => {
        savedDoc = doc;
      });

      await service.upsert('space-1', {
        path: 'docs/test.md',
        content: 'See [missing](docs/nonexistent.md)',
      });

      expect(savedDoc).not.toBeNull();
      const lh = (savedDoc as any).linkHealth as Record<string, unknown>;
      expect(lh).toBeDefined();
      expect(lh.total).toBe(1);
      expect(lh.broken).toEqual(['docs/nonexistent.md']);
      expect(lh.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('computes linkHealth with no broken links when all .md paths valid', async () => {
      const emptyQb = createMockQueryBuilder([], 0);
      const spaceDocsQb = createMockQueryBuilder(
        [{ id: 'doc-001', path: 'docs/guide.md' } as Doc],
        1,
      );
      (docRepo.createQueryBuilder as jest.Mock).mockReset();
      (docRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(emptyQb)
        .mockReturnValueOnce(spaceDocsQb);

      let savedDoc: Doc | null = null;
      setupTransactionCapture((doc) => {
        savedDoc = doc;
      });

      await service.upsert('space-1', {
        path: 'docs/test.md',
        // v1.61.0 严格源解析：docs/test.md 内 ./guide.md → docs/guide.md 命中
        content: 'See [guide](./guide.md)',
      });

      expect(savedDoc).not.toBeNull();
      const lh = (savedDoc as any).linkHealth as Record<string, unknown>;
      expect(lh.total).toBe(1);
      expect(lh.broken).toEqual([]);
    });

    it('computes linkHealth with broken platform doc link for unknown docId', async () => {
      const emptyQb = createMockQueryBuilder([], 0);
      // Space has doc-uuid-1 but NOT the-missing-one
      const spaceDocsQb = createMockQueryBuilder(
        [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', path: 'docs/guide.md' } as Doc],
        1,
      );
      (docRepo.createQueryBuilder as jest.Mock).mockReset();
      (docRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(emptyQb)
        .mockReturnValueOnce(spaceDocsQb);

      let savedDoc: Doc | null = null;
      setupTransactionCapture((doc) => {
        savedDoc = doc;
      });

      await service.upsert('space-1', {
        path: 'docs/test.md',
        content: 'See [doc](/docs/space-1?doc=00000000-0000-0000-0000-000000000000)',
      });

      expect(savedDoc).not.toBeNull();
      const lh = (savedDoc as any).linkHealth as Record<string, unknown>;
      expect(lh.total).toBe(1);
      expect(lh.broken).toEqual(['/docs/space-1?doc=00000000-0000-0000-0000-000000000000']);
    });

    it('skips unchanged content entirely when link_health already present', async () => {
      const testContent = '# Hello\n\nSee [guide](docs/guide.md).';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({
        contentHash: hash,
        linkHealth: { total: 1, broken: [], checkedAt: '2026-07-30T00:00:00.000Z' },
      });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      let savedDoc: Doc | null = null;
      setupTransactionCapture((doc) => {
        savedDoc = doc;
      });

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
      });

      // Unchanged path: early return before link health computation
      expect(result.unchanged).toBe(true);
      expect(savedDoc).toBeNull(); // transaction never called
      expect(qb.update).not.toHaveBeenCalled(); // no backfill either
    });

    it('backfills link_health when hash matches but link_health is NULL', async () => {
      const testContent = '# Hello\n\nSee [guide](docs/guide.md).';
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(testContent).digest('hex');
      const existingDoc = makeDoc({ contentHash: hash, linkHealth: null });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      let savedDoc: Doc | null = null;
      setupTransactionCapture((doc) => {
        savedDoc = doc;
      });

      const result = await service.upsert('space-1', {
        path: 'docs/test.md',
        content: testContent,
      });

      // Caller's contract is still "unchanged", and no chunking transaction ran
      expect(result.unchanged).toBe(true);
      expect(savedDoc).toBeNull();
      // …but link_health was backfilled via a direct update
      expect(qb.update).toHaveBeenCalledWith('Doc');
      expect((qb as unknown as { set: jest.Mock }).set).toHaveBeenCalledWith(
        expect.objectContaining({
          linkHealth: expect.objectContaining({ total: 1, broken: ['docs/guide.md'] }),
        }),
      );
      expect(qb.execute).toHaveBeenCalled();
    });

    it('findOne returns linkHealth from entity', async () => {
      const doc = makeDoc({
        linkHealth: {
          total: 2,
          broken: ['docs/oops.md'],
          checkedAt: '2026-07-30T00:00:00.000Z',
        },
      });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder([], 0);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.linkHealth).toBeDefined();
      expect(result.linkHealth!.total).toBe(2);
      expect(result.linkHealth!.broken).toEqual(['docs/oops.md']);
      expect(result.linkHealth!.checkedAt).toBe('2026-07-30T00:00:00.000Z');
    });

    it('findOne returns linkHealth null when not yet computed', async () => {
      const doc = makeDoc({ linkHealth: null });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder([], 0);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.linkHealth).toBeNull();
    });

    it('remove triggers async recalc (fire-and-forget, does not block response)', async () => {
      // Mock the findById query
      const doc = makeDoc({ source: 'native', spaceId: 'space-1' });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      // Space context for event
      const spaceQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ ds_board_id: null, ds_topic_id: null }),
      };
      (docSpaceRepo.createQueryBuilder as jest.Mock).mockReturnValue(spaceQb);

      const result = await service.remove('doc-1');
      expect(result.deleted).toBe(true);

      // The fire-and-forget runs via setImmediate — we can't easily test it
      // in a synchronous test, but we verify the response is immediate.
    });
  });

  // ─── patchMetadata（v1.61.0 批次 2，metadata-only 写通道，任务 201ae04f）─────

  describe('patchMetadata', () => {
    /** findById 命中的基础文档（native + 已知 contentHash） */
    const HASH = 'a'.repeat(64);

    function mockFindById(doc: Doc) {
      const qb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
    }

    /**
     * 定制 patchMetadata 的事务 mock：事务内 QB 消费顺序 = 锁行（setLock getOne）→
     * UPDATE（update/set/where/execute）→ fresh 重读（getOne）。
     * 返回 setMock/executeMock 供断言「只 UPDATE 变更列」与「是否产生写」。
     */
    function mockMetadataTx(locked: Doc | null, fresh?: Doc | null) {
      const setMock = jest.fn().mockReturnThis();
      const executeMock = jest.fn().mockResolvedValue({ affected: 1 });
      const lockQb = createMockQueryBuilder(locked ? [locked] : [], locked ? 1 : 0);
      const updateQb = {
        update: jest.fn().mockReturnThis(),
        set: setMock,
        where: jest.fn().mockReturnThis(),
        execute: executeMock,
      };
      const freshQb = createMockQueryBuilder(fresh ? [fresh] : [], fresh ? 1 : 0);
      const qbs: unknown[] = [lockQb, updateQb, freshQb];
      docRepo.manager.transaction = jest.fn(async (fn: (manager: unknown) => Promise<unknown>) =>
        fn({
          getRepository: jest.fn(() => ({
            createQueryBuilder: jest.fn(() => qbs.shift()),
          })),
        }),
      ) as unknown as typeof docRepo.manager.transaction;
      return { setMock, executeMock };
    }

    it('partial：仅显式字段进入 UPDATE（缺席字段不动，changedFields 精确）', async () => {
      const doc = makeDoc({ contentHash: HASH, title: '旧标题', tags: ['x'] });
      mockFindById(doc);
      const fresh = makeDoc({ contentHash: HASH, title: '新标题', tags: ['x'] });
      const { setMock, executeMock } = mockMetadataTx(doc, fresh);

      const result = await service.patchMetadata(
        'doc-1',
        { title: '新标题', expectedContentHash: HASH },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      expect(result.changedFields).toEqual(['title']);
      expect(result.unchanged).toBe(false);
      expect(result.contentHash).toBe(HASH);
      expect(result.metadata.title).toBe('新标题');
      // UPDATE set 只含 title + updatedAt——缺席字段/内容列一律不进写面
      const setArg = setMock.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.title).toBe('新标题');
      expect(setArg.updatedAt).toBeDefined();
      expect(Object.keys(setArg).sort()).toEqual(['title', 'updatedAt']);
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it('partial：tags: [] = 清空（空数组是显式值，写入库）', async () => {
      const doc = makeDoc({ contentHash: HASH, tags: ['a', 'b'] });
      mockFindById(doc);
      const fresh = makeDoc({ contentHash: HASH, tags: [] });
      const { setMock } = mockMetadataTx(doc, fresh);

      const result = await service.patchMetadata(
        'doc-1',
        { tags: [], expectedContentHash: HASH },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      expect(result.changedFields).toEqual(['tags']);
      expect(result.metadata.tags).toEqual([]);
      const setArg = setMock.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.tags).toEqual([]);
    });

    it('partial：tags 同值不视为变更（数组等值判定，逐元素比对）', async () => {
      const doc = makeDoc({ contentHash: HASH, tags: ['a', 'b'] });
      mockFindById(doc);
      mockMetadataTx(doc);

      const result = await service.patchMetadata(
        'doc-1',
        { tags: ['a', 'b'], expectedContentHash: HASH },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      expect(result.unchanged).toBe(true);
      expect(result.changedFields).toEqual([]);
    });

    it('partial：全字段显式 → changedFields 全量且顺序稳定', async () => {
      const doc = makeDoc({
        contentHash: HASH,
        title: '旧',
        summary: '旧摘要',
        docType: 'note',
        tags: [],
        categoryId: null,
      });
      mockFindById(doc);
      // category resolve-only 命中
      const cat = makeCategory({ id: 'cat-9', name: '架构', slug: '架构' });
      (categoryRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([cat], 1),
      );
      const fresh = makeDoc({
        contentHash: HASH,
        title: '新',
        summary: '新摘要',
        docType: 'guide',
        tags: ['t1'],
        categoryId: 'cat-9',
      });
      const { setMock } = mockMetadataTx(doc, fresh);

      const result = await service.patchMetadata(
        'doc-1',
        {
          title: '新',
          summary: '新摘要',
          docType: 'guide',
          tags: ['t1'],
          category: '架构',
          expectedContentHash: HASH,
        },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      expect(result.changedFields).toEqual(['title', 'summary', 'docType', 'tags', 'category']);
      expect(result.metadata.categoryId).toBe('cat-9');
      expect(result.metadata.categoryName).toBe('架构');
      const setArg = setMock.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.categoryId).toBe('cat-9');
    });

    it('hash stale（事务外快速失败径）→ 409 DOC_CONTENT_CONFLICT 带 currentContentHash，且不进事务', async () => {
      const doc = makeDoc({ contentHash: 'current-hash' });
      mockFindById(doc);
      const txSpy = jest.fn();
      docRepo.manager.transaction = txSpy as unknown as typeof docRepo.manager.transaction;

      await expect(
        service.patchMetadata('doc-1', { title: 'x', expectedContentHash: 'stale-hash' }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_CONTENT_CONFLICT,
          data: { currentContentHash: 'current-hash' },
        },
      });
      expect(txSpy).not.toHaveBeenCalled();
    });

    it('hash stale（事务内 FOR UPDATE 复核径）→ 409，且不产生 UPDATE', async () => {
      const doc = makeDoc({ contentHash: HASH });
      mockFindById(doc);
      // 锁行后读到并发内容改写（hash 已变）
      const concurrentlyEdited = makeDoc({ contentHash: 'edited-concurrently' });
      const { executeMock } = mockMetadataTx(concurrentlyEdited);

      await expect(
        service.patchMetadata('doc-1', { title: 'x', expectedContentHash: HASH }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_CONTENT_CONFLICT,
          data: { currentContentHash: 'edited-concurrently' },
        },
      });
      expect(executeMock).not.toHaveBeenCalled();
    });

    it('事务内锁行被并发软删 → 404 DOC_NOT_FOUND', async () => {
      const doc = makeDoc({ contentHash: HASH });
      mockFindById(doc);
      mockMetadataTx(null);

      await expect(
        service.patchMetadata('doc-1', { title: 'x', expectedContentHash: HASH }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.DOC_NOT_FOUND } });
    });

    it('非 native source → 409 DOC_SOURCE_MISMATCH（native-only，与 upsert/patch 一致）', async () => {
      const doc = makeDoc({ contentHash: HASH, source: 'git:other-repo' });
      mockFindById(doc);

      await expect(
        service.patchMetadata('doc-1', { title: 'x', expectedContentHash: HASH }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.DOC_SOURCE_MISMATCH } });
    });

    it('文档不存在 → 404 DOC_NOT_FOUND（findById fail-closed）', async () => {
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([], 0));

      await expect(
        service.patchMetadata('doc-1', { title: 'x', expectedContentHash: HASH }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.DOC_NOT_FOUND } });
    });

    it('category 默认只解析既有：未命中 → 404 DOC_CATEGORY_NOT_FOUND（防拼写产生近似分类）', async () => {
      const doc = makeDoc({ contentHash: HASH });
      mockFindById(doc);
      (categoryRepo.createQueryBuilder as jest.Mock).mockReturnValue(createMockQueryBuilder([], 0));
      const txSpy = jest.fn();
      docRepo.manager.transaction = txSpy as unknown as typeof docRepo.manager.transaction;

      await expect(
        service.patchMetadata('doc-1', { category: '拼错分类', expectedContentHash: HASH }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.DOC_CATEGORY_NOT_FOUND } });
      // resolve-only 模式不创建分类，也不进写事务
      expect(categoryRepo.save).not.toHaveBeenCalled();
      expect(txSpy).not.toHaveBeenCalled();
    });

    it('category 解析命中既有（slug 命中同 name）→ 正常落 categoryId', async () => {
      const doc = makeDoc({ contentHash: HASH, categoryId: null });
      mockFindById(doc);
      const cat = makeCategory({ id: 'cat-1', name: 'Arch', slug: 'arch' });
      (categoryRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([cat], 1),
      );
      const fresh = makeDoc({ contentHash: HASH, categoryId: 'cat-1' });
      const { setMock } = mockMetadataTx(doc, fresh);

      const result = await service.patchMetadata(
        'doc-1',
        { category: 'arch', expectedContentHash: HASH },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      expect(result.changedFields).toEqual(['category']);
      expect((setMock.mock.calls[0][0] as Record<string, unknown>).categoryId).toBe('cat-1');
      expect(categoryRepo.save).not.toHaveBeenCalled();
    });

    it('category 解析命中 = 现值 → 不计变更（参与 unchanged 判定）', async () => {
      const doc = makeDoc({ contentHash: HASH, categoryId: 'cat-1' });
      mockFindById(doc);
      const cat = makeCategory({ id: 'cat-1' });
      (categoryRepo.createQueryBuilder as jest.Mock).mockReturnValue(
        createMockQueryBuilder([cat], 1),
      );
      const { executeMock } = mockMetadataTx(doc);

      const result = await service.patchMetadata('doc-1', {
        category: 'Test',
        expectedContentHash: HASH,
      });

      expect(result.unchanged).toBe(true);
      expect(result.changedFields).toEqual([]);
      expect(executeMock).not.toHaveBeenCalled();
    });

    it('allowCreateCategory=true：未命中走 resolveCategory 自动创建', async () => {
      const doc = makeDoc({ contentHash: HASH, categoryId: null });
      mockFindById(doc);
      // 第一次 QB（查找）未命中；resolveCategory 创建后 buildMetadataView 再查新分类名
      const created = makeCategory({ id: 'cat-new', name: '新分类', slug: '新分类' });
      (categoryRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(createMockQueryBuilder([], 0))
        .mockReturnValue(createMockQueryBuilder([created], 1));
      (categoryRepo.save as jest.Mock).mockResolvedValue(created);
      const fresh = makeDoc({ contentHash: HASH, categoryId: 'cat-new' });
      mockMetadataTx(doc, fresh);

      const result = await service.patchMetadata(
        'doc-1',
        { category: '新分类', allowCreateCategory: true, expectedContentHash: HASH },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      expect(categoryRepo.save).toHaveBeenCalled();
      expect(result.changedFields).toEqual(['category']);
      expect(result.metadata.categoryId).toBe('cat-new');
      expect(result.metadata.categoryName).toBe('新分类');
    });

    it('unchanged 短路：全字段与现值相同 → 无 UPDATE/audit/事件', async () => {
      const doc = makeDoc({
        contentHash: HASH,
        title: '同款标题',
        summary: '同款摘要',
        docType: 'guide',
        tags: ['t'],
      });
      mockFindById(doc);
      const { setMock, executeMock } = mockMetadataTx(doc);

      const result = await service.patchMetadata(
        'doc-1',
        {
          title: '同款标题',
          summary: '同款摘要',
          docType: 'guide',
          tags: ['t'],
          expectedContentHash: HASH,
        },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      expect(result.unchanged).toBe(true);
      expect(result.changedFields).toEqual([]);
      expect(result.metadata.title).toBe('同款标题');
      expect(setMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
      // 无写操作 → 不落 audit、不发事件（对齐 upsert unchanged 早退语义）
      expect(auditRepo.save).not.toHaveBeenCalled();
      expect(eventService.create).not.toHaveBeenCalled();
    });

    it('audit：UPDATE 动作 + newData 记 changedFields 前后值（metadataOnly 标注）', async () => {
      const doc = makeDoc({ contentHash: HASH, title: '旧标题' });
      mockFindById(doc);
      const fresh = makeDoc({ contentHash: HASH, title: '新标题' });
      mockMetadataTx(doc, fresh);

      await service.patchMetadata(
        'doc-1',
        { title: '新标题', expectedContentHash: HASH },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      expect(auditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.UPDATE,
          entityType: 'doc',
          entityId: 'doc-1',
          actorId: 'actor-1',
          newData: {
            metadataOnly: true,
            changedFields: ['title'],
            before: { title: '旧标题' },
            after: { title: '新标题' },
          },
        }),
      );
    });

    it('事件：DOC_UPDATED payload 标 metadataOnly + changedFields（订阅方可区分内容变更）', async () => {
      const doc = makeDoc({ contentHash: HASH, tags: [] });
      mockFindById(doc);
      const fresh = makeDoc({ contentHash: HASH, tags: ['n'] });
      mockMetadataTx(doc, fresh);

      await service.patchMetadata(
        'doc-1',
        { tags: ['n'], expectedContentHash: HASH },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      expect(eventService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EventType.DOC_UPDATED,
          resourceType: 'doc',
          resourceId: 'doc-1',
          payload: expect.objectContaining({
            docId: 'doc-1',
            metadataOnly: true,
            changedFields: ['tags'],
          }),
        }),
      );
    });

    it('不变量（铁律 #18）：写面不含内容列，sections/versions 引用面零触碰', async () => {
      const doc = makeDoc({ contentHash: HASH, title: '旧' });
      mockFindById(doc);
      const fresh = makeDoc({ contentHash: HASH, title: '新' });
      const { setMock } = mockMetadataTx(doc, fresh);

      const result = await service.patchMetadata(
        'doc-1',
        { title: '新', expectedContentHash: HASH },
        { id: 'actor-1', type: ActorType.HUMAN },
      );

      // contentHash 原样回传（metadata-only 不动内容面）
      expect(result.contentHash).toBe(HASH);
      const setArg = setMock.mock.calls[0][0] as Record<string, unknown>;
      // UPDATE 面禁止出现内容/结构列
      for (const forbidden of [
        'contentHash',
        'sectionCount',
        'tokenEstimate',
        'linkHealth',
        'path',
        'source',
      ]) {
        expect(setArg).not.toHaveProperty(forbidden);
      }
      // sections 不重切、versions 不落版
      expect(sectionRepo.save).not.toHaveBeenCalled();
      expect(sectionRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(versionRepo.save).not.toHaveBeenCalled();
    });
  });
});
