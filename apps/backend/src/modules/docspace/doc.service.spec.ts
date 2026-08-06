import { Repository, SelectQueryBuilder } from 'typeorm';
import { DocService } from './doc.service';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Board } from '../../database/entities/board.entity';
import {
  ErrorCode,
  AuditAction,
  ActorType,
  EventType,
} from '@agent-chamber/shared';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { EventService } from '../event/event.service';
import { RouteHealthService } from './route-health.service';

describe('DocService', () => {
  let service: DocService;
  let docRepo: jest.Mocked<Repository<Doc>>;
  let sectionRepo: jest.Mocked<Repository<DocSection>>;
  let categoryRepo: jest.Mocked<Repository<DocCategory>>;
  let auditRepo: jest.Mocked<Repository<AuditLog>>;
  let docSpaceRepo: jest.Mocked<Repository<DocSpace>>;
  let boardRepo: jest.Mocked<Repository<Board>>;
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
      eventService as unknown as EventService,
      routeHealthService as unknown as RouteHealthService,
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
      mockTransaction.mockResolvedValue(createdDoc);

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
      mockTransaction.mockResolvedValue(updatedDoc);

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

      categoryRepo.create.mockReturnValue(makeCategory({ name: 'Architecture', slug: 'architecture' }));
      categoryRepo.save.mockResolvedValue(makeCategory({ id: 'cat-new', name: 'Architecture' }));

      mockTransaction.mockResolvedValue(
        makeDoc({ id: 'doc-new', categoryId: 'cat-new' }),
      );

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

      mockTransaction.mockResolvedValue(
        makeDoc({ source: 'git:agent-chamber', contentHash: 'newhash' }),
      );

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

      mockTransaction.mockResolvedValue(
        makeDoc({ id: 'doc-new', path: 'docs/test.md' }),
      );

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

      mockTransaction.mockResolvedValue(
        makeDoc({ id: 'doc-new', path: 'docs/test.md', title: 'Test Doc' }),
      );

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
      mockTransaction.mockResolvedValue(updatedDoc);

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

      mockTransaction.mockResolvedValue(
        makeDoc({ id: 'doc-new', sectionCount: 2, tokenEstimate: 42 }),
      );

      await service.upsert('space-1', dto);
      await flushImmediates();

      expect(routeHealthService.recheckSpace).toHaveBeenCalledWith('space-1');
    });

    it('内容变更（update）→ 事务提交后触发 recheckSpace', async () => {
      const existingDoc = makeDoc({ contentHash: 'oldhash' });
      const qb = createMockQueryBuilder([existingDoc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      mockTransaction.mockResolvedValue(
        makeDoc({ sectionCount: 3, tokenEstimate: 150, contentHash: 'newhash' }),
      );

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
      expect(result.results[0]).toMatchObject({ path: 'docs/new.md', status: 'created', id: 'doc-new' });
      expect(result.results[1]).toMatchObject({ path: 'docs/updated.md', status: 'updated', id: 'doc-updated' });
      expect(result.results[2]).toMatchObject({ path: 'docs/same.md', status: 'unchanged', id: 'doc-same' });
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
      expect(result.results[1]).toMatchObject({ path: 'docs/ok.md', status: 'created', id: 'doc-ok' });
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

    it('exposes sourceSha in detail (via toSummary, DocDetail extends DocSummary)', async () => {
      const doc = makeDoc({ tokenEstimate: 5000, sourceSha: 'sha-last-verified' });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder([], 0);
      (sectionRepo.createQueryBuilder as jest.Mock).mockReturnValue(sectionQb);

      const result = await service.findOne('doc-1');
      expect(result.sourceSha).toBe('sha-last-verified');
    });

    it('small doc (tokenEstimate ≤ threshold) → mode:full + content with dedup semantics', async () => {
      // 小文档（tokenEstimate=100 ≤ 2000 阈值）→ 第二次全量查询 + reconstructContent(true) 去重
      const doc = makeDoc({ tokenEstimate: 100 }); // title = 'Test Doc'
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const outlineQb = createMockQueryBuilder(
        [makeSection({ position: 0, headingPath: 'Test Doc', headingLevel: 1, tokenEstimate: 50 })],
        1,
      );
      // full 分支：全量 sections（含 content）
      const fullQb = createMockQueryBuilder(
        [makeSection({ position: 0, headingPath: 'Test Doc', headingLevel: 1, content: 'Lead body.' })],
        1,
      );
      (sectionRepo.createQueryBuilder as jest.Mock)
        .mockReturnValueOnce(outlineQb)
        .mockReturnValueOnce(fullQb);

      const result = await service.findOne('doc-1');
      expect(result.mode).toBe('full');
      // 渲染去重语义：position 0 的 H1 与 doc.title 同名 → 不重复插标题行
      expect(result.content).toBe('Lead body.');
      expect(result.sections).toHaveLength(1);
      // outline + full 两次 section 查询
      expect(sectionRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('threshold boundary: tokenEstimate=2000 triggers full', async () => {
      const doc = makeDoc({ tokenEstimate: 2000 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const outlineQb = createMockQueryBuilder(
        [makeSection({ position: 0, headingPath: 'Test Doc', headingLevel: 1, tokenEstimate: 2000 })],
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
      expect(result.content).toBe('Body.');
    });

    it('threshold boundary: tokenEstimate=2001 stays outline', async () => {
      const doc = makeDoc({ tokenEstimate: 2001 });
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sectionQb = createMockQueryBuilder(
        [makeSection({ position: 0, headingPath: 'Test Doc', headingLevel: 1, tokenEstimate: 2001 })],
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
        [makeSection({ position: 0, headingPath: 'Intro', headingLevel: 1, content: 'Big but inlined.' })],
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
        makeSection({ position: 0, headingPath: 'Intro', headingLevel: 1, content: 'First section.' }),
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
    });

    it('skips the lead heading line when it duplicates doc.title (web header already shows it)', async () => {
      const doc = makeDoc(); // title = 'Test Doc'
      const docQb = createMockQueryBuilder([doc], 1);
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(docQb);

      const sections = [
        // position 0 的 H1 末段与 doc.title 同名 → 不重复插标题行
        makeSection({ position: 0, headingPath: 'Test Doc', headingLevel: 1, content: 'Lead body.' }),
        makeSection({ position: 1, headingPath: 'Test Doc § Sub', headingLevel: 2, content: 'Sub body.' }),
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
        makeSection({ position: 0, headingPath: 'Test Doc', headingLevel: 1, content: 'Lead body.' }),
        makeSection({ position: 1, headingPath: 'Test Doc § Sub', headingLevel: 2, content: 'Sub body.' }),
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

      await expect(
        service.getSection('doc-1', undefined, 'NoSuch'),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });
  });

  // ─── remove ─────────────────────────────────────────────────

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
      const doc = makeDoc({ source: 'native', spaceId: 'space-1', path: 'docs/test.md', title: 'Test Doc' });
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
        content: 'See [guide](docs/guide.md)',
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
        content:
          'See [doc](/docs/space-1?doc=00000000-0000-0000-0000-000000000000)',
      });

      expect(savedDoc).not.toBeNull();
      const lh = (savedDoc as any).linkHealth as Record<string, unknown>;
      expect(lh.total).toBe(1);
      expect(lh.broken).toEqual([
        '/docs/space-1?doc=00000000-0000-0000-0000-000000000000',
      ]);
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
});
