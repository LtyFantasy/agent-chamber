import { Repository, SelectQueryBuilder, DeepPartial } from 'typeorm';
import { DocSpaceService } from './docspace.service';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocSpaceMember } from '../../database/entities/doc-space-member.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Board } from '../../database/entities/board.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Visibility, ErrorCode, ActorType, UserRole, EventType } from '@agent-chamber/shared';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ResourceValidator } from '../../common/resource-validator';
import { EventService } from '../event/event.service';

describe('DocSpaceService', () => {
  let service: DocSpaceService;
  let spaceRepo: jest.Mocked<Repository<DocSpace>>;
  let memberRepo: jest.Mocked<Repository<DocSpaceMember>>;
  let categoryRepo: jest.Mocked<Repository<DocCategory>>;
  let docRepo: jest.Mocked<Repository<Doc>>;
  let sectionRepo: jest.Mocked<Repository<DocSection>>;
  let taskDocLinkRepo: jest.Mocked<Repository<TaskDocLink>>;
  let routeRepo: jest.Mocked<Repository<DocRoute>>;
  let agentRepo: jest.Mocked<Repository<Agent>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let actorRepo: jest.Mocked<Repository<Actor>>;
  let boardRepo: jest.Mocked<Repository<Board>>;
  let topicRepo: jest.Mocked<Repository<Topic>>;
  let accessQuery: jest.Mocked<AccessQueryService>;
  let resourceValidator: { exists: jest.Mock; existsMany: jest.Mock };
  let eventService: { create: jest.Mock };

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  const nonAdminActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };

  function makeSpace(overrides: Partial<DocSpace> = {}): DocSpace {
    return {
      id: 'space-1',
      name: 'Test Space',
      slug: 'test-space',
      description: 'A test space',
      topicId: null,
      boardId: null,
      creatorId: 'user-1',
      settings: { visibility: Visibility.OPEN },
      docCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    } as DocSpace;
  }

  function makeCategory(overrides: Partial<DocCategory> = {}): DocCategory {
    return {
      id: 'cat-1',
      spaceId: 'space-1',
      name: 'Test Category',
      slug: 'test-category',
      description: null,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    } as DocCategory;
  }

  function createMockQueryBuilder<T>(items: T[], count: number) {
    return {
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
    } as unknown as SelectQueryBuilder<any>;
  }

  beforeEach(() => {
    spaceRepo = {
      findOne: jest.fn(),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
      // v1.42 批次 C2：updateRepoManifest 走原生 jsonb_set SQL（board updateMetrics 同款）
      query: jest.fn(),
      manager: {
        transaction: jest.fn((fn: any) =>
          fn({
            createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
          }),
        ),
      },
    } as unknown as jest.Mocked<Repository<DocSpace>>;

    memberRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
    } as unknown as jest.Mocked<Repository<DocSpaceMember>>;

    categoryRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
      manager: {
        transaction: jest.fn((fn: any) =>
          fn({
            createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
          }),
        ),
      },
    } as unknown as jest.Mocked<Repository<DocCategory>>;

    docRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
    } as unknown as jest.Mocked<Repository<Doc>>;

    sectionRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
    } as unknown as jest.Mocked<Repository<DocSection>>;

    taskDocLinkRepo = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder([], 0)),
    } as unknown as jest.Mocked<Repository<TaskDocLink>>;

    agentRepo = {
      find: jest.fn(),
      findBy: jest.fn(),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Agent>>;

    userRepo = {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<User>>;

    actorRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Actor>>;

    boardRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Board>>;

    topicRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Topic>>;

    accessQuery = {
      getAccessibleDocSpaceIds: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AccessQueryService>;

    routeRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<DocRoute>>;

    resourceValidator = {
      exists: jest.fn().mockResolvedValue({ id: 'agent-1' } as Agent),
      existsMany: jest.fn().mockResolvedValue([]),
    };

    eventService = { create: jest.fn().mockResolvedValue(undefined) };

    service = new DocSpaceService(
      spaceRepo,
      memberRepo,
      categoryRepo,
      docRepo,
      sectionRepo,
      taskDocLinkRepo,
      routeRepo,
      agentRepo,
      userRepo,
      actorRepo,
      boardRepo,
      topicRepo,
      accessQuery,
      resourceValidator as unknown as ResourceValidator,
      eventService as unknown as EventService,
    );
  });

  afterEach(() => jest.resetAllMocks());

  // ─── findById ─────────────────────────────────────────────

  describe('findById', () => {
    it('returns space when found', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      expect(await service.findById('space-1')).toBe(space);
    });

    it('throws DOC_SPACE_NOT_FOUND when not found', async () => {
      spaceRepo.findOne.mockResolvedValue(null);
      await expect(service.findById('space-1')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_SPACE_NOT_FOUND },
      });
    });
  });

  // ─── updateRepoManifest（v1.42 批次 C2）────────────────────

  describe('updateRepoManifest', () => {
    const sha = 'e75475d3c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d';
    const files = ['apps/backend/src/app.module.ts', 'docs/architecture.md'];

    it('原子 jsonb_set：单条 UPDATE 只动 repoManifest 键，params=[序列化清单, spaceId]', async () => {
      const storedManifest = {
        sha,
        files,
        reportedAt: '2026-08-06T00:00:00.000Z',
      };
      spaceRepo.query.mockResolvedValue([
        { settings: { visibility: Visibility.OPEN, repoManifest: storedManifest } },
      ]);

      const result = await service.updateRepoManifest('space-1', { sha, files });

      expect(spaceRepo.query).toHaveBeenCalledTimes(1);
      const [sql, params] = spaceRepo.query.mock.calls[0] as [string, [string, string]];
      expect(sql).toContain("jsonb_set(settings, '{repoManifest}', $1::jsonb)");
      expect(sql).toContain('deleted_at IS NULL');
      expect(params[1]).toBe('space-1');
      // 序列化载荷 = { sha, files, reportedAt }：reportedAt 服务端生成（ISO），非客户端传入
      const payload = JSON.parse(params[0]) as {
        sha: string;
        files: string[];
        reportedAt: string;
      };
      expect(payload.sha).toBe(sha);
      expect(payload.files).toEqual(files);
      expect(payload.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // 返回写后 settings.repoManifest（RETURNING 读回，无第二次查询）
      expect(result.repoManifest).toEqual(storedManifest);
    });

    it('reportedAt 由服务端 now 生成（合法 ISO 时间戳），请求载荷不含该键', async () => {
      spaceRepo.query.mockResolvedValue([{ settings: { repoManifest: null } }]);

      await service.updateRepoManifest('space-1', { sha, files });

      const [, params] = spaceRepo.query.mock.calls[0] as [string, [string, string]];
      const payload = JSON.parse(params[0]) as { reportedAt: string };
      expect(payload.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(payload.reportedAt).toISOString()).toBe(payload.reportedAt);
    });

    it('空间不存在（0 行 RETURNING）→ 404 DOC_SPACE_NOT_FOUND（TOCTOU 兜底，铁律 #22）', async () => {
      spaceRepo.query.mockResolvedValue([]);

      await expect(service.updateRepoManifest('space-1', { sha, files })).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_SPACE_NOT_FOUND },
      });
    });

    it('settings 既有键不受影响——SQL 形状即语义：单条 UPDATE + jsonb_set 片段（非 read-modify-write）', async () => {
      spaceRepo.query.mockResolvedValue([
        {
          settings: {
            visibility: Visibility.PRIVATE,
            overviewFilter: { excludeTypes: ['memory'] },
            repoManifest: { sha, files, reportedAt: '2026-08-06T00:00:00.000Z' },
          },
        },
      ]);

      await service.updateRepoManifest('space-1', { sha, files });

      const sql = spaceRepo.query.mock.calls[0][0] as string;
      expect(sql).toMatch(/^UPDATE doc_spaces SET settings = jsonb_set\(/);
      expect(spaceRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── findAll ──────────────────────────────────────────────

  describe('findAll', () => {
    it('returns empty page when whitelist is empty', async () => {
      accessQuery.getAccessibleDocSpaceIds.mockResolvedValue([]);
      const result = await service.findAll({}, nonAdminActor);
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it('passes boardId filter to query', async () => {
      const space = makeSpace({ boardId: 'board-1' });
      const qb = createMockQueryBuilder([space], 1);
      spaceRepo.createQueryBuilder.mockReturnValue(qb);
      accessQuery.getAccessibleDocSpaceIds.mockResolvedValue(null);

      await service.findAll({ boardId: 'board-1' }, mockActor);
      expect(qb.andWhere).toHaveBeenCalledWith('ds.board_id = :boardId', { boardId: 'board-1' });
    });

    it('passes topicId filter to query', async () => {
      const space = makeSpace({ topicId: 'topic-1' });
      const qb = createMockQueryBuilder([space], 1);
      spaceRepo.createQueryBuilder.mockReturnValue(qb);
      accessQuery.getAccessibleDocSpaceIds.mockResolvedValue(null);

      await service.findAll({ topicId: 'topic-1' }, mockActor);
      expect(qb.andWhere).toHaveBeenCalledWith('ds.topic_id = :topicId', { topicId: 'topic-1' });
    });
  });

  // ─── create ───────────────────────────────────────────────

  describe('create', () => {
    it('creates a space with generated slug', async () => {
      const saved = makeSpace({ name: 'My Space', slug: 'my-space' });
      spaceRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any);
      spaceRepo.create.mockReturnValue(saved);
      spaceRepo.save.mockResolvedValue(saved);

      const result = await service.create(mockActor, { name: 'My Space' });
      expect(result.name).toBe('My Space');
      expect(result.slug).toBe('my-space');
    });

    it('falls back to random slug for non-Latin names (e.g. Chinese)', async () => {
      spaceRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any);
      spaceRepo.create.mockImplementation((input: DeepPartial<DocSpace>) => input as DocSpace);
      spaceRepo.save.mockImplementation(async (input: DeepPartial<DocSpace>) => input as DocSpace);

      const result = await service.create(mockActor, { name: '集成验证空间' });
      // 中文名 slugify 为空串 → 兜底 's-' + 8 位随机 hex，不得为空
      expect(result.slug).toMatch(/^s-[0-9a-f]{8}$/);
    });

    it('throws on both topicId and boardId', async () => {
      await expect(
        service.create(mockActor, {
          name: 'Test',
          topicId: 'topic-1',
          boardId: 'board-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('validates board existence when boardId given', async () => {
      const saved = makeSpace({ boardId: 'board-1' });
      spaceRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any);
      spaceRepo.create.mockReturnValue(saved);
      spaceRepo.save.mockResolvedValue(saved);
      boardRepo.findOne.mockResolvedValue({ id: 'board-1' } as Board);

      const result = await service.create(mockActor, { name: 'Test', boardId: 'board-1' });
      expect(result.boardId).toBe('board-1');
    });

    it('throws AGENT_NOT_FOUND when invitedAgentIds invalid', async () => {
      resourceValidator.existsMany.mockRejectedValue(
        new NotFoundException({
          message: 'Some resources not found',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );
      await expect(
        service.create(mockActor, { name: 'Test', invitedAgentIds: ['agent-missing'] }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.AGENT_NOT_FOUND } });
    });

    it('creates initial member rows for invited agents', async () => {
      const saved = makeSpace();
      spaceRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any);
      spaceRepo.create.mockReturnValue(saved);
      spaceRepo.save.mockResolvedValue(saved);

      await service.create(mockActor, {
        name: 'Test',
        invitedAgentIds: ['agent-1', 'agent-2'],
      });

      expect(memberRepo.create).toHaveBeenCalledTimes(2);
      expect(memberRepo.save).toHaveBeenCalled();
    });
  });

  // ─── update (re-bind / unbind) ────────────────────────────

  describe('update', () => {
    it('re-binds board → topic and clears the other side', async () => {
      spaceRepo.findOne.mockResolvedValue(makeSpace({ boardId: 'board-1' }));
      topicRepo.findOne.mockResolvedValue({ id: 'topic-1' } as Topic);

      const saved = await service.update('space-1', { topicId: 'topic-1' });
      expect(saved.topicId).toBe('topic-1');
      expect(saved.boardId).toBeNull();
    });

    it('rejects topicId + boardId together (mutually exclusive)', async () => {
      spaceRepo.findOne.mockResolvedValue(makeSpace());
      await expect(
        service.update('space-1', { topicId: 'topic-1', boardId: 'board-1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('explicit null unbinds the bound side without touching task-doc links', async () => {
      spaceRepo.findOne.mockResolvedValue(makeSpace({ boardId: 'board-1' }));

      const saved = await service.update('space-1', { boardId: null });
      expect(saved.boardId).toBeNull();
      expect(saved.topicId).toBeNull();
      // 任务↔文档链接按 docId 关联，与 space 绑定无关，解绑不级联
      expect(taskDocLinkRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('both null fully unbinds', async () => {
      spaceRepo.findOne.mockResolvedValue(makeSpace({ topicId: 'topic-1' }));

      const saved = await service.update('space-1', { topicId: null, boardId: null });
      expect(saved.topicId).toBeNull();
      expect(saved.boardId).toBeNull();
    });

    it('null on the unbound side is a no-op', async () => {
      spaceRepo.findOne.mockResolvedValue(makeSpace({ topicId: 'topic-1' }));

      const saved = await service.update('space-1', { boardId: null });
      expect(saved.topicId).toBe('topic-1');
      expect(saved.boardId).toBeNull();
    });

    it('explicit null description clears it (A8：字段出现即采用)', async () => {
      spaceRepo.findOne.mockResolvedValue(makeSpace({ description: 'Old desc' }));

      const saved = await service.update('space-1', { description: null });
      expect(saved.description).toBeNull();
    });

    it('omitted description preserves the old value (A8：未传保留旧值)', async () => {
      spaceRepo.findOne.mockResolvedValue(makeSpace({ description: 'Old desc' }));

      const saved = await service.update('space-1', { name: 'New Name' });
      expect(saved.description).toBe('Old desc');
    });

    it('persists overviewFilter into settings (v1.38 空间默认过滤)', async () => {
      spaceRepo.findOne.mockResolvedValue(makeSpace());

      const saved = await service.update('space-1', {
        overviewFilter: { excludeTypes: ['memory'], excludeCategories: ['archive'] },
      });
      expect(saved.settings.overviewFilter).toEqual({
        excludeTypes: ['memory'],
        excludeCategories: ['archive'],
      });
      // 与既有 visibility 同存 settings，互不覆盖
      expect(saved.settings.visibility).toBe(Visibility.OPEN);
    });

    it('explicit null clears overviewFilter (字段出现即采用)', async () => {
      spaceRepo.findOne.mockResolvedValue(
        makeSpace({
          settings: { visibility: Visibility.OPEN, overviewFilter: { excludeTypes: ['memory'] } },
        }),
      );

      const saved = await service.update('space-1', { overviewFilter: null });
      expect(saved.settings.overviewFilter).toBeUndefined();
      expect(saved.settings.visibility).toBe(Visibility.OPEN);
    });

    it('omitted overviewFilter preserves the old value', async () => {
      spaceRepo.findOne.mockResolvedValue(
        makeSpace({
          settings: { visibility: Visibility.OPEN, overviewFilter: { excludeTypes: ['memory'] } },
        }),
      );

      const saved = await service.update('space-1', { name: 'New Name' });
      expect(saved.settings.overviewFilter).toEqual({ excludeTypes: ['memory'] });
    });
  });

  // ─── enrich (detail 聚合) ─────────────────────────────────

  describe('enrich', () => {
    it('returns linkedTaskCount aggregated from task_doc_links (A9)', async () => {
      const docQb = createMockQueryBuilder([], 0);
      docQb.getRawOne = jest.fn().mockResolvedValue({ count: '5' });
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const linkQb = createMockQueryBuilder([], 0);
      linkQb.getRawOne = jest.fn().mockResolvedValue({ count: '3' });
      taskDocLinkRepo.createQueryBuilder.mockReturnValue(linkQb);

      const detail = await service.enrich(makeSpace());
      expect(detail.docCount).toBe(5);
      expect(detail.linkedTaskCount).toBe(3);
    });

    it('returns linkedTaskCount=0 when no docs are linked', async () => {
      // 默认 mock QB getRawOne → { count: '0' }
      const detail = await service.enrich(makeSpace());
      expect(detail.linkedTaskCount).toBe(0);
    });
  });

  // ─── remove (cascade) ─────────────────────────────────────

  describe('remove', () => {
    it('cascade soft-deletes docs, emits doc_deleted per doc, returns counts', async () => {
      const space = makeSpace({ topicId: 'topic-9' });
      spaceRepo.findOne.mockResolvedValue(space);

      const docQb = createMockQueryBuilder([], 0);
      docQb.getRawMany = jest.fn().mockResolvedValue([
        { id: 'doc-1', path: 'a.md', title: 'A' },
        { id: 'doc-2', path: 'b.md', title: 'B' },
      ]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const linkQb = createMockQueryBuilder([], 0);
      linkQb.getRawOne = jest.fn().mockResolvedValue({ count: '3' });
      taskDocLinkRepo.createQueryBuilder.mockReturnValue(linkQb);

      const result = await service.remove('space-1', mockActor as never);
      expect(result.deleted).toBe(true);
      expect(result.docCount).toBe(2);
      expect(result.linkedTaskCount).toBe(3);
      // 级联删除的每篇文档都发 doc_deleted（plan §4.2，事件 payload 对齐 DocService.remove）
      expect(eventService.create).toHaveBeenCalledTimes(2);
      expect(eventService.create).toHaveBeenCalledWith({
        eventType: EventType.DOC_DELETED,
        resourceType: 'doc',
        resourceId: 'doc-1',
        actorId: 'user-1',
        topicId: 'topic-9',
        boardId: undefined,
        payload: { spaceId: 'space-1', docId: 'doc-1', path: 'a.md', title: 'A' },
      });
    });

    it('emits no events when space has no docs', async () => {
      spaceRepo.findOne.mockResolvedValue(makeSpace());
      const result = await service.remove('space-1');
      expect(result.docCount).toBe(0);
      expect(eventService.create).not.toHaveBeenCalled();
    });
  });

  // ─── Members ──────────────────────────────────────────────

  describe('inviteAgent', () => {
    it('creates member row', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      memberRepo.findOne.mockResolvedValue(null);

      await service.inviteAgent('space-1', 'agent-1');
      expect(memberRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: 'space-1',
          actorId: 'agent-1',
          role: 'member',
        }),
      );
    });

    it('throws 409 if agent already a member', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      memberRepo.findOne.mockResolvedValue({
        spaceId: 'space-1',
        actorId: 'agent-1',
        role: 'member',
      } as DocSpaceMember);

      await expect(service.inviteAgent('space-1', 'agent-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('uninviteAgent', () => {
    it('removes member row', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      memberRepo.findOne.mockResolvedValue({
        spaceId: 'space-1',
        actorId: 'agent-1',
        role: 'member',
      } as DocSpaceMember);

      await service.uninviteAgent('space-1', 'agent-1');
      expect(memberRepo.delete).toHaveBeenCalledWith({ spaceId: 'space-1', actorId: 'agent-1' });
    });

    it('throws if agent is editor (must remove editor first)', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      memberRepo.findOne.mockResolvedValue({
        spaceId: 'space-1',
        actorId: 'agent-1',
        role: 'editor',
      } as DocSpaceMember);

      await expect(service.uninviteAgent('space-1', 'agent-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('addEditor', () => {
    it('promotes member to editor', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const memberRow = {
        spaceId: 'space-1',
        actorId: 'agent-1',
        role: 'member',
      } as DocSpaceMember;
      memberRepo.findOne.mockResolvedValue(memberRow);

      await service.addEditor('space-1', 'agent-1');
      expect(memberRow.role).toBe('editor');
      expect(memberRepo.save).toHaveBeenCalledWith(memberRow);
    });

    it('prevents downgrade — existing editor stays editor', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      memberRepo.findOne.mockResolvedValue({
        spaceId: 'space-1',
        actorId: 'agent-1',
        role: 'editor',
      } as DocSpaceMember);

      await expect(service.addEditor('space-1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('creates editor row if not already a member', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      memberRepo.findOne.mockResolvedValue(null);

      await service.addEditor('space-1', 'agent-1');
      expect(memberRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ spaceId: 'space-1', actorId: 'agent-1', role: 'editor' }),
      );
    });
  });

  describe('removeEditor', () => {
    it('demotes editor to member', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const editorRow = {
        spaceId: 'space-1',
        actorId: 'agent-1',
        role: 'editor',
      } as DocSpaceMember;
      memberRepo.findOne.mockResolvedValue(editorRow);

      await service.removeEditor('space-1', 'agent-1');
      expect(editorRow.role).toBe('member');
      expect(memberRepo.save).toHaveBeenCalledWith(editorRow);
    });

    it('throws if not an editor', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      memberRepo.findOne.mockResolvedValue(null);

      await expect(service.removeEditor('space-1', 'agent-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('transferCreator', () => {
    const newAgentCreatorId = 'agent-9';

    it('转让成功（agent 目标）：creatorId 更新 + 删除新 creator 的 member 行（干净交接）', async () => {
      const space = makeSpace(); // creatorId = 'user-1'
      spaceRepo.findOne.mockResolvedValue(space);
      // actorRepo.findOne 命中（人/agent 统一 actors 表）
      resourceValidator.exists.mockResolvedValue({ id: newAgentCreatorId, type: 'agent' } as Actor);

      const result = await service.transferCreator('space-1', newAgentCreatorId);

      // 双层校验第二层：目标存在性走 actors 表 + ACTOR_NOT_FOUND（铁律 #21/#22）
      expect(resourceValidator.exists).toHaveBeenCalledWith(
        actorRepo,
        newAgentCreatorId,
        ErrorCode.ACTOR_NOT_FOUND,
      );
      // 干净交接：既有 member 行被删除（幂等 delete，无行时 affected=0 非错误）
      expect(memberRepo.delete).toHaveBeenCalledWith({
        spaceId: 'space-1',
        actorId: newAgentCreatorId,
      });
      expect(space.creatorId).toBe(newAgentCreatorId);
      expect(result.creatorId).toBe(newAgentCreatorId);
      expect(spaceRepo.save).toHaveBeenCalledWith(space);
    });

    it('转让成功（user 目标）：与 agent 目标同路径（actors 表统一，不区分类型）', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      resourceValidator.exists.mockResolvedValue({ id: 'user-2', type: 'human' } as Actor);

      const result = await service.transferCreator('space-1', 'user-2');

      expect(result.creatorId).toBe('user-2');
      expect(memberRepo.delete).toHaveBeenCalledWith({ spaceId: 'space-1', actorId: 'user-2' });
    });

    it('目标 actor 不存在 → 404 ACTOR_NOT_FOUND（resourceValidator 抛透传）', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Resource not found', code: ErrorCode.ACTOR_NOT_FOUND }),
      );

      await expect(service.transferCreator('space-1', 'ghost-actor')).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.ACTOR_NOT_FOUND }),
        }),
      );
      // 不落库、不删 member 行
      expect(spaceRepo.save).not.toHaveBeenCalled();
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('目标已是当前 creator → 409 RESOURCE_CONFLICT（无操作请求，真实状态冲突）', async () => {
      const space = makeSpace(); // creatorId = 'user-1'，目标 'user-1' 即自己
      spaceRepo.findOne.mockResolvedValue(space);
      resourceValidator.exists.mockResolvedValue({ id: 'user-1', type: 'human' } as Actor);

      await expect(service.transferCreator('space-1', 'user-1')).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.RESOURCE_CONFLICT }),
        }),
      );
      expect(space.creatorId).toBe('user-1');
      expect(spaceRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── Categories ───────────────────────────────────────────

  describe('createCategory', () => {
    it('creates a category with generated slug', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      // create returns the entity passed to it (identity)
      categoryRepo.create.mockImplementation((x: any) => ({ ...x, id: 'cat-1' }));
      categoryRepo.save.mockImplementation((x: any) => Promise.resolve(x));

      const result = await service.createCategory('space-1', { name: 'Architecture' });
      expect(result.name).toBe('Architecture');
      expect(result.slug).toBe('architecture');
    });
  });

  describe('removeCategory', () => {
    it('sets doc.categoryId to null and soft-deletes category', async () => {
      const cat = makeCategory();
      categoryRepo.findOne.mockResolvedValue(cat);

      await service.removeCategory('cat-1');
      // Transaction was called
      expect(categoryRepo.manager.transaction).toHaveBeenCalled();
    });
  });

  // ─── Overview ─────────────────────────────────────────────

  describe('getOverview', () => {
    it('returns empty overview when no docs exist', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);

      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);

      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue([]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const result = await service.getOverview('space-1');
      expect(result.spaceId).toBe('space-1');
      expect(result.categories).toEqual([]);
      expect(result.uncategorized).toEqual([]);
      expect(result.truncated).toBe(false);
    });

    it('includes large docs (cost = map row footprint, not full tokenEstimate)', async () => {
      // 生产回归：39k token 的大文档不得顶爆上限——成本按 title+path+summary 估算
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);

      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);

      const largeDoc = {
        id: 'doc-1',
        spaceId: 'space-1',
        categoryId: null,
        path: 'docs/api-definition.md',
        title: 'API 定义',
        summary: '短摘要',
        docType: null,
        tags: [],
        source: 'native',
        contentHash: null,
        sourceSha: null,
        sectionCount: 1,
        tokenEstimate: 39000,
        linkHealth: null,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as Doc;

      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue([largeDoc]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const result = await service.getOverview('space-1');
      expect(result.truncated).toBe(false);
      expect(result.uncategorized).toHaveLength(1);
      expect(result.totalTokenEstimate).toBeGreaterThan(0);
      expect(result.totalTokenEstimate).toBeLessThan(100);
    });

    // ─── v1.42 B6 linkHealth 汇总 + sourceSha 透出 ─────────────

    it('surfaces brokenLinkCount per doc + totalBrokenLinks (sum over visible docs) + sourceSha', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);

      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);

      // 三态：2 断链 / 0 断链（已检查）/ NULL 未检查
      const docs = [
        makeOverviewDoc({
          id: 'doc-broken',
          path: 'a.md',
          sourceSha: 'sha-1',
          linkHealth: {
            total: 3,
            broken: ['/docs/x', '/docs/y'],
            checkedAt: '2026-08-05T00:00:00Z',
          },
        }),
        makeOverviewDoc({
          id: 'doc-clean',
          path: 'b.md',
          linkHealth: { total: 1, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
        }),
        makeOverviewDoc({ id: 'doc-unchecked', path: 'c.md', linkHealth: null }),
      ] as Doc[];
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue(docs);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const result = await service.getOverview('space-1');
      const byPath = Object.fromEntries(result.uncategorized.map((d) => [d.path, d]));
      expect(byPath['a.md'].brokenLinkCount).toBe(2);
      expect(byPath['b.md'].brokenLinkCount).toBe(0); // 已检查且 0 断链：0 而非缺省
      expect(byPath['c.md'].brokenLinkCount).toBeUndefined(); // 未检查（NULL）：省略
      expect(result.totalBrokenLinks).toBe(2);
      expect(byPath['a.md'].sourceSha).toBe('sha-1');
      // 实体字段直拷：无验证记录 = null（与 brokenLinkCount 的"未检查省略"语义不同）
      expect(byPath['b.md'].sourceSha).toBeNull();
    });

    it('totalBrokenLinks: omitted when no doc checked; 0 returned when checked docs have no broken links', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);

      // 全部文档 linkHealth = NULL（未检查）→ 省略 totalBrokenLinks（与"检查过且 0 断链"区分）
      const unchecked = [makeOverviewDoc({ id: 'd1', path: 'a.md' })] as Doc[];
      const uncheckedQb = createMockQueryBuilder([], 0);
      uncheckedQb.getMany = jest.fn().mockResolvedValue(unchecked);
      docRepo.createQueryBuilder.mockReturnValue(uncheckedQb);
      const r1 = await service.getOverview('space-1');
      expect(r1.totalBrokenLinks).toBeUndefined();

      // 有已检查文档且全 0 断链 → totalBrokenLinks = 0 返回
      const clean = [
        makeOverviewDoc({
          id: 'd1',
          path: 'a.md',
          linkHealth: { total: 1, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
        }),
      ] as Doc[];
      const cleanQb = createMockQueryBuilder([], 0);
      cleanQb.getMany = jest.fn().mockResolvedValue(clean);
      docRepo.createQueryBuilder.mockReturnValue(cleanQb);
      const r2 = await service.getOverview('space-1');
      expect(r2.totalBrokenLinks).toBe(0);
    });

    it('totalBrokenLinks counts only visible (post-filter) docs', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);

      // memory 文档（将被 excludeType 过滤）带断链；可见 guide 文档 0 断链
      const docs = [
        makeOverviewDoc({
          id: 'doc-memory',
          path: 'memory/m.md',
          docType: 'memory',
          linkHealth: { total: 2, broken: ['/docs/x'], checkedAt: '2026-08-05T00:00:00Z' },
        }),
        makeOverviewDoc({
          id: 'doc-guide',
          path: 'docs/g.md',
          docType: 'guide',
          linkHealth: { total: 1, broken: [], checkedAt: '2026-08-05T00:00:00Z' },
        }),
      ] as Doc[];
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue(docs);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const result = await service.getOverview('space-1', { excludeType: 'memory' });
      // 过滤掉 memory 文档后：可见文档 0 断链 → totalBrokenLinks = 0（1 被过滤不计入）
      expect(result.uncategorized.map((d) => d.path)).toEqual(['docs/g.md']);
      expect(result.totalBrokenLinks).toBe(0);
    });

    it('sets truncated when map row footprint cap exceeded', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);

      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);

      // 单条 summary 500 字符（CJK≈500 token），50 条即超 20000 上限（v1.41 图例化后默认 cap 放宽）
      const docs = Array.from({ length: 50 }, (_, i) => ({
        id: `doc-${i}`,
        spaceId: 'space-1',
        categoryId: null,
        path: `p${i}.md`,
        title: `T${i}`,
        summary: '摘'.repeat(500),
        docType: null,
        tags: [],
        source: 'native',
        contentHash: null,
        sourceSha: null,
        sectionCount: 1,
        tokenEstimate: 600,
        linkHealth: null,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      })) as Doc[];

      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue(docs);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const result = await service.getOverview('space-1');
      expect(result.truncated).toBe(true);
      expect(result.uncategorized.length).toBeGreaterThan(0);
      expect(result.uncategorized.length).toBeLessThan(50);
    });

    // ─── v1.38 可配置过滤 ─────────────────────────────────

    /** 构造最小 Doc 对象（docType/tags/categoryId 等过滤字段可覆盖） */
    function makeOverviewDoc(overrides: Partial<Doc> = {}): Doc {
      return {
        id: 'doc-x',
        spaceId: 'space-1',
        categoryId: null,
        path: 'p.md',
        title: 'T',
        summary: 'S',
        docType: null,
        tags: [],
        source: 'native',
        contentHash: null,
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

    /** 搭建 overview 数据场景（space + categories + docs 全 mock） */
    function mockOverview(cats: DocCategory[], docs: Doc[], space: DocSpace = makeSpace()) {
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue(cats);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue(docs);
      docRepo.createQueryBuilder.mockReturnValue(docQb);
    }

    it('type= 白名单只保留对应 docType（null docType 也被剔除）', async () => {
      const docs = [
        makeOverviewDoc({ id: 'd1', docType: 'guide' }),
        makeOverviewDoc({ id: 'd2', docType: 'reference' }),
        makeOverviewDoc({ id: 'd3', docType: 'note' }),
        makeOverviewDoc({ id: 'd4', docType: null }),
      ];
      mockOverview([], docs);

      const result = await service.getOverview('space-1', { type: 'guide,reference' });
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1', 'd2']);
      expect(result.appliedFilters?.types).toEqual(['guide', 'reference']);
    });

    it('excludeType= 剔除对应 docType（null docType 保留）', async () => {
      const docs = [
        makeOverviewDoc({ id: 'd1', docType: 'memory' }),
        makeOverviewDoc({ id: 'd2', docType: 'note' }),
        makeOverviewDoc({ id: 'd3', docType: null }),
      ];
      mockOverview([], docs);

      const result = await service.getOverview('space-1', { excludeType: 'memory' });
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d2', 'd3']);
      expect(result.appliedFilters?.excludeTypes).toEqual(['memory']);
    });

    it('category= 白名单：只输出命中分类，uncategorized 段省略', async () => {
      const cats = [
        makeCategory({ id: 'cat-1', slug: 'arch' }),
        makeCategory({ id: 'cat-2', slug: 'ref' }),
      ];
      const docs = [
        makeOverviewDoc({ id: 'd1', path: 'a.md', categoryId: 'cat-1' }),
        makeOverviewDoc({ id: 'd2', path: 'b.md', categoryId: 'cat-2' }),
        makeOverviewDoc({ id: 'd3', path: 'c.md', categoryId: null }),
      ];
      mockOverview(cats, docs);

      const result = await service.getOverview('space-1', { category: 'arch' });
      expect(result.categories.map((c) => c.slug)).toEqual(['arch']);
      expect(result.categories[0].docs.map((d) => d.id)).toEqual(['d1']);
      expect(result.uncategorized).toEqual([]);
      expect(result.appliedFilters?.categories).toEqual(['arch']);
    });

    it('excludeCategory= 剔除对应分类，uncategorized 保留', async () => {
      const cats = [
        makeCategory({ id: 'cat-1', slug: 'arch' }),
        makeCategory({ id: 'cat-2', slug: 'archive' }),
      ];
      const docs = [
        makeOverviewDoc({ id: 'd1', path: 'a.md', categoryId: 'cat-1' }),
        makeOverviewDoc({ id: 'd2', path: 'b.md', categoryId: 'cat-2' }),
        makeOverviewDoc({ id: 'd3', path: 'c.md', categoryId: null }),
      ];
      mockOverview(cats, docs);

      const result = await service.getOverview('space-1', { excludeCategory: 'archive' });
      expect(result.categories.map((c) => c.slug)).toEqual(['arch']);
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d3']);
      expect(result.appliedFilters?.excludeCategories).toEqual(['archive']);
    });

    it('category 白名单 + 未命中 slug（写错）→ 空分类输出（分类不泄露文档）', async () => {
      const cats = [makeCategory({ id: 'cat-1', slug: 'arch' })];
      const docs = [makeOverviewDoc({ id: 'd1', categoryId: 'cat-1' })];
      mockOverview(cats, docs);

      const result = await service.getOverview('space-1', { category: 'nonexistent' });
      expect(result.categories.map((c) => c.slug)).toEqual([]);
      expect(result.uncategorized).toEqual([]);
    });

    it('tag= 只保留 tags 数组包含该 tag 的文档', async () => {
      const docs = [
        makeOverviewDoc({ id: 'd1', tags: ['prod', 'guide'] }),
        makeOverviewDoc({ id: 'd2', tags: ['dev'] }),
        makeOverviewDoc({ id: 'd3', tags: [] }),
      ];
      mockOverview([], docs);

      const result = await service.getOverview('space-1', { tag: 'prod' });
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1']);
      expect(result.appliedFilters?.tag).toBe('prod');
    });

    it('pathPrefix= 按路径前缀过滤', async () => {
      const docs = [
        makeOverviewDoc({ id: 'd1', path: 'memory/2026-08-03.md' }),
        makeOverviewDoc({ id: 'd2', path: 'docs/architecture.md' }),
      ];
      mockOverview([], docs);

      const result = await service.getOverview('space-1', { pathPrefix: 'memory/' });
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1']);
      expect(result.appliedFilters?.pathPrefix).toBe('memory/');
    });

    it('maxTokens= 显式上限生效（超过即截断并回显）', async () => {
      // 单条 summary 500 字符 CJK≈500 token，3 条超 1500 上限
      const docs = Array.from({ length: 3 }, (_, i) =>
        makeOverviewDoc({ id: `d${i}`, summary: '摘'.repeat(500) }),
      );
      mockOverview([], docs);

      const result = await service.getOverview('space-1', { maxTokens: 1500 });
      expect(result.truncated).toBe(true);
      expect(result.uncategorized.length).toBeGreaterThan(0);
      expect(result.uncategorized.length).toBeLessThan(3);
      expect(result.appliedFilters?.maxTokens).toBe(1500);
    });

    it('空间默认 excludeTypes 生效（settings.overviewFilter）', async () => {
      const space = makeSpace({
        settings: {
          visibility: Visibility.OPEN,
          overviewFilter: { excludeTypes: ['memory'] },
        },
      });
      const docs = [
        makeOverviewDoc({ id: 'd1', docType: 'memory' }),
        makeOverviewDoc({ id: 'd2', docType: 'guide' }),
      ];
      mockOverview([], docs, space);

      const result = await service.getOverview('space-1');
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d2']);
      expect(result.appliedFilters?.excludeTypes).toEqual(['memory']);
    });

    it('空间默认 excludeCategories 生效（settings.overviewFilter）', async () => {
      const space = makeSpace({
        settings: {
          visibility: Visibility.OPEN,
          overviewFilter: { excludeCategories: ['archive'] },
        },
      });
      const cats = [
        makeCategory({ id: 'cat-1', slug: 'arch' }),
        makeCategory({ id: 'cat-2', slug: 'archive' }),
      ];
      const docs = [
        makeOverviewDoc({ id: 'd1', categoryId: 'cat-1' }),
        makeOverviewDoc({ id: 'd2', categoryId: 'cat-2' }),
      ];
      mockOverview(cats, docs, space);

      const result = await service.getOverview('space-1');
      expect(result.categories.map((c) => c.slug)).toEqual(['arch']);
      expect(result.appliedFilters?.excludeCategories).toEqual(['archive']);
    });

    it('脏数据防御：空间默认 excludeTypes 存成字符串（非数组）→ 视为无默认过滤（评审 B4）', async () => {
      // jsonb 手工改库可能把数组存成字符串 "memory"；字符串同样有 .includes() 会静默产生
      // 错误语义（"memory" 的 includes('m') 为 true），故非数组一律视为无默认过滤
      const space = makeSpace({
        settings: {
          visibility: Visibility.OPEN,
          overviewFilter: { excludeTypes: 'memory' as unknown as string[] },
        },
      });
      const docs = [
        makeOverviewDoc({ id: 'd1', docType: 'memory' }),
        makeOverviewDoc({ id: 'd2', docType: 'guide' }),
      ];
      mockOverview([], docs, space);

      const result = await service.getOverview('space-1');
      // 非数组 → 无默认过滤：memory 文档保留，appliedFilters 不含 excludeTypes
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1', 'd2']);
      expect(result.appliedFilters?.excludeTypes).toBeUndefined();
    });

    it('per-call excludeType 逐字段覆盖空间默认 excludeTypes', async () => {
      const space = makeSpace({
        settings: {
          visibility: Visibility.OPEN,
          overviewFilter: { excludeTypes: ['memory'] },
        },
      });
      const docs = [
        makeOverviewDoc({ id: 'd1', docType: 'memory' }),
        makeOverviewDoc({ id: 'd2', docType: 'note' }),
        makeOverviewDoc({ id: 'd3', docType: 'guide' }),
      ];
      mockOverview([], docs, space);

      const result = await service.getOverview('space-1', { excludeType: 'note' });
      // 空间默认 ['memory'] 被 per-call ['note'] 完全替换：memory 重新可见
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1', 'd3']);
      expect(result.appliedFilters?.excludeTypes).toEqual(['note']);
    });

    it('per-call type 白名单同样抑制空间默认 excludeTypes（显式 type=memory 可取回）', async () => {
      const space = makeSpace({
        settings: {
          visibility: Visibility.OPEN,
          overviewFilter: { excludeTypes: ['memory'] },
        },
      });
      const docs = [
        makeOverviewDoc({ id: 'd1', docType: 'memory' }),
        makeOverviewDoc({ id: 'd2', docType: 'guide' }),
      ];
      mockOverview([], docs, space);

      // plan WS2 验证场景：空间默认排除 memory，但显式 type=memory 应能取回
      const result = await service.getOverview('space-1', { type: 'memory' });
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1']);
      expect(result.appliedFilters?.types).toEqual(['memory']);
      // 空间默认被同维度 per-call 抑制 → 不回显默认 excludeTypes
      expect(result.appliedFilters?.excludeTypes).toBeUndefined();
    });

    it('applySpaceDefaults=false 逃生门：完全忽略空间默认过滤', async () => {
      const space = makeSpace({
        settings: {
          visibility: Visibility.OPEN,
          overviewFilter: { excludeTypes: ['memory'] },
        },
      });
      const docs = [
        makeOverviewDoc({ id: 'd1', docType: 'memory' }),
        makeOverviewDoc({ id: 'd2', docType: 'guide' }),
      ];
      mockOverview([], docs, space);

      const result = await service.getOverview('space-1', { applySpaceDefaults: false });
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1', 'd2']);
      // 逃生门下空间默认不生效 → appliedFilters 也不回显默认维度
      expect(result.appliedFilters).toBeUndefined();
    });

    it('include+exclude 同现 = 先 include 后 exclude（交集）', async () => {
      const docs = [
        makeOverviewDoc({ id: 'd1', docType: 'guide' }),
        makeOverviewDoc({ id: 'd2', docType: 'note' }),
        makeOverviewDoc({ id: 'd3', docType: 'reference' }),
      ];
      mockOverview([], docs);

      const result = await service.getOverview('space-1', {
        type: 'guide,note',
        excludeType: 'note',
      });
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1']);
      expect(result.appliedFilters?.types).toEqual(['guide', 'note']);
      expect(result.appliedFilters?.excludeTypes).toEqual(['note']);
    });

    it('appliedFilters 回显全部生效维度', async () => {
      const docs = [
        makeOverviewDoc({ id: 'd1', path: 'docs/a.md', docType: 'guide', tags: ['prod'] }),
      ];
      mockOverview([], docs);

      const result = await service.getOverview('space-1', {
        type: 'guide',
        tag: 'prod',
        pathPrefix: 'docs/',
        maxTokens: 5000,
      });
      expect(result.appliedFilters).toEqual({
        types: ['guide'],
        tag: 'prod',
        pathPrefix: 'docs/',
        maxTokens: 5000,
      });
    });

    it('无过滤且无空间默认 → 不携带 appliedFilters（向后兼容）', async () => {
      mockOverview([], [makeOverviewDoc()]);

      const result = await service.getOverview('space-1');
      expect(result.appliedFilters).toBeUndefined();
    });

    // ─── v1.41 空间图例（description 内嵌 + legendTokenEstimate 单列） ────

    it('默认内嵌 spaceDescription 图例全文（legendTokenEstimate 单列，totalTokenEstimate 合计）', async () => {
      const space = makeSpace({ description: '## 空间图例\n\n由 PM 维护的 INDEX。' });
      mockOverview([], [], space);

      const result = await service.getOverview('space-1');
      expect(result.spaceDescription).toBe('## 空间图例\n\n由 PM 维护的 INDEX。');
      expect(result.legendTokenEstimate).toBeDefined();
      expect(result.legendTokenEstimate).toBeGreaterThan(0);
      // 空文档时 totalTokenEstimate = 图例 token（仅信息回显）
      expect(result.totalTokenEstimate).toBe(result.legendTokenEstimate);
    });

    it('includeDescription=false → 省略 spaceDescription/legendTokenEstimate', async () => {
      const space = makeSpace({ description: '## 图例' });
      mockOverview([], [], space);

      const result = await service.getOverview('space-1', { includeDescription: false });
      expect(result.spaceDescription).toBeUndefined();
      expect(result.legendTokenEstimate).toBeUndefined();
      expect(result.totalTokenEstimate).toBe(0);
    });

    it('description 为空 → 不携带图例字段（向后兼容）', async () => {
      mockOverview([], [], makeSpace({ description: null }));

      const result = await service.getOverview('space-1');
      expect(result.spaceDescription).toBeUndefined();
      expect(result.legendTokenEstimate).toBeUndefined();
    });

    it('图例 token 不占 maxTokens 预算（万级图例 + 小预算，文档仍全量不截断）', async () => {
      // 10000 CJK 图例（≈10000 token）远超大预算上限 2000：图例仍全量内嵌，文档条目不受影响
      const space = makeSpace({ description: '摘'.repeat(10000) });
      const docs = [makeOverviewDoc({ id: 'd1' })];
      mockOverview([], docs, space);

      const result = await service.getOverview('space-1', { maxTokens: 2000 });
      expect(result.truncated).toBe(false);
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1']);
      expect(result.spaceDescription).toBe('摘'.repeat(10000));
      expect(result.legendTokenEstimate).toBe(10000);
      // totalTokenEstimate = 图例 + 文档条目合计（仅信息回显，可超 maxTokens）
      expect(result.totalTokenEstimate).toBeGreaterThan(10000);
    });

    it('文档截断时图例仍全量返回（truncated 语义不变，仅文档条目截断）', async () => {
      const space = makeSpace({ description: '## 图例' });
      const docs = Array.from({ length: 3 }, (_, i) =>
        makeOverviewDoc({ id: `d${i}`, summary: '摘'.repeat(500) }),
      );
      mockOverview([], docs, space);

      const result = await service.getOverview('space-1', { maxTokens: 1000 });
      expect(result.truncated).toBe(true);
      expect(result.spaceDescription).toBe('## 图例');
      expect(result.legendTokenEstimate).toBeDefined();
      // 截断后文档数仍少于全部（预算只装文档条目）
      expect(result.uncategorized.length).toBeLessThan(3);
    });

    // ─── v1.42 B5 意图路由内嵌（routes 全量返回 + routesTokenEstimate 单列） ────

    it('默认内嵌 routes 全量（routesTokenEstimate 单列计入 totalTokenEstimate，不占文档预算）', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue([]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const routeRows = [
        {
          id: 'r1',
          spaceId: 'space-1',
          intent: '我要了解系统架构',
          category: 'architecture',
          primaryDocId: 'doc-1',
          primaryHeadingPath: '## 3. 架构总览',
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: 'apps/backend/src/app.module.ts',
          sortOrder: 1,
          createdBy: 'user-1',
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
        {
          id: 'r2',
          spaceId: 'space-1',
          intent: '我要了解数据库设计',
          category: 'architecture',
          primaryDocId: 'doc-2',
          primaryHeadingPath: null,
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          sortOrder: 0,
          createdBy: 'user-1',
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-02'),
        },
      ] as unknown as DocRoute[];
      routeRepo.find.mockResolvedValue(routeRows);

      const result = await service.getOverview('space-1');
      expect(result.routes).toHaveLength(2);
      // 响应 DTO 投影：保留完整字段（含 intent/category/headingPath/codeEntry）
      expect(result.routes![0]).toMatchObject({
        id: 'r1',
        intent: '我要了解系统架构',
        category: 'architecture',
        primaryHeadingPath: '## 3. 架构总览',
        codeEntry: 'apps/backend/src/app.module.ts',
      });
      // routesTokenEstimate 单列（序列化 routes 的 CJK 感知估算），计入 totalTokenEstimate
      expect(result.routesTokenEstimate).toBeGreaterThan(0);
      // makeSpace 默认 description='A test space' → totalTokenEstimate = 图例 + routes 合计
      expect(result.totalTokenEstimate).toBe(
        result.legendTokenEstimate! + result.routesTokenEstimate!,
      );
      // 空文档时 truncated 仍为 false（routes 不参与文档条目预算竞争）
      expect(result.truncated).toBe(false);
    });

    it('includeRoutes=false → 省略 routes/routesTokenEstimate（省 token 逃生门）', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue([]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const result = await service.getOverview('space-1', { includeRoutes: false });
      expect(result.routes).toBeUndefined();
      expect(result.routesTokenEstimate).toBeUndefined();
      // includeRoutes=false 时不查 routes（省一次查询）
      expect(routeRepo.find).not.toHaveBeenCalled();
      // makeSpace 默认 description='A test space' → totalTokenEstimate 仅含图例
      expect(result.totalTokenEstimate).toBe(result.legendTokenEstimate!);
    });

    it('routes 不占 maxTokens 预算（大路由集合 + 小预算，文档仍全量不截断）', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue([makeOverviewDoc({ id: 'd1' })]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      // 50 条 CJK 意图路由（序列化估算 ≈ 数千 token）远超预算 500：仍全量返回不截断
      const routeRows = Array.from({ length: 50 }, (_, i) => ({
        id: `r${i}`,
        spaceId: 'space-1',
        intent: `我要了解第 ${i} 号功能的实现细节`,
        category: 'reference',
        primaryDocId: 'doc-1',
        primaryHeadingPath: null,
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: null,
        sortOrder: i,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as unknown as DocRoute[];
      routeRepo.find.mockResolvedValue(routeRows);

      const result = await service.getOverview('space-1', { maxTokens: 500 });
      expect(result.routes).toHaveLength(50);
      expect(result.truncated).toBe(false);
      expect(result.uncategorized.map((d) => d.id)).toEqual(['d1']);
      // totalTokenEstimate = 文档条目 + routes（仅信息回显，可超 maxTokens）
      expect(result.totalTokenEstimate).toBeGreaterThan(500);
    });

    // ─── v1.42 批次 C1 路由健康透出（health 原样透传 + totalBrokenRoutes 省略键语义） ────

    it('routes 段每条 health 原样透传（NULL=未检与已检值均透传）；broken 路由计入 totalBrokenRoutes', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue([]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const routeRows = [
        {
          id: 'r1',
          spaceId: 'space-1',
          intent: '我要了解系统架构',
          category: null,
          primaryDocId: 'doc-1',
          primaryHeadingPath: null,
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          sortOrder: 0,
          createdBy: 'user-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          health: {
            issues: [{ kind: 'heading', target: 'primary', value: '## 悬空的节' }],
            checkedAt: '2026-08-06T00:00:00.000Z',
          },
        },
        {
          id: 'r2',
          spaceId: 'space-1',
          intent: '我要了解数据库设计',
          category: null,
          primaryDocId: 'doc-2',
          primaryHeadingPath: null,
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          sortOrder: 1,
          createdBy: 'user-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          health: { issues: [], checkedAt: '2026-08-06T00:00:00.000Z' },
        },
        {
          id: 'r3',
          spaceId: 'space-1',
          intent: '未检路由',
          category: null,
          primaryDocId: 'doc-3',
          primaryHeadingPath: null,
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          sortOrder: 2,
          createdBy: 'user-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          health: null, // 未检（NULL）——不参与汇总也不省略别的路由的结果
        },
      ] as unknown as DocRoute[];
      routeRepo.find.mockResolvedValue(routeRows);

      const result = await service.getOverview('space-1');
      // health 原样透传：已检值完整保留、NULL 透传为 null（区别于 brokenLinkCount 的省略语义）
      expect(result.routes![0].health).toEqual({
        issues: [{ kind: 'heading', target: 'primary', value: '## 悬空的节' }],
        checkedAt: '2026-08-06T00:00:00.000Z',
      });
      expect(result.routes![1].health).toEqual({
        issues: [],
        checkedAt: '2026-08-06T00:00:00.000Z',
      });
      expect(result.routes![2].health).toBeNull();
      // 有已检路由（r1/r2）→ totalBrokenRoutes 返回；只数 issues.length>0 的路由（r1），未检 r3 不计
      expect(result.totalBrokenRoutes).toBe(1);
    });

    it('totalBrokenRoutes：全部路由未检（health NULL）→ 省略该键（"全健康"≠"从未检查"）', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue([]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const routeRows = [
        {
          id: 'r1',
          spaceId: 'space-1',
          intent: '未检 1',
          category: null,
          primaryDocId: 'doc-1',
          primaryHeadingPath: null,
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          sortOrder: 0,
          createdBy: 'user-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          health: null,
        },
        {
          id: 'r2',
          spaceId: 'space-1',
          intent: '未检 2',
          category: null,
          primaryDocId: 'doc-2',
          primaryHeadingPath: null,
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          sortOrder: 1,
          createdBy: 'user-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          health: null,
        },
      ] as unknown as DocRoute[];
      routeRepo.find.mockResolvedValue(routeRows);

      const result = await service.getOverview('space-1');
      expect(result.totalBrokenRoutes).toBeUndefined();
    });

    it('totalBrokenRoutes：有已检路由且全健康 → 0 返回（合法结果，区别于省略）', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue([]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const routeRows = [
        {
          id: 'r1',
          spaceId: 'space-1',
          intent: '健康路由',
          category: null,
          primaryDocId: 'doc-1',
          primaryHeadingPath: null,
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          sortOrder: 0,
          createdBy: 'user-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          health: { issues: [], checkedAt: '2026-08-06T00:00:00.000Z' },
        },
      ] as unknown as DocRoute[];
      routeRepo.find.mockResolvedValue(routeRows);

      const result = await service.getOverview('space-1');
      expect(result.totalBrokenRoutes).toBe(0);
    });

    it('includeRoutes=false → totalBrokenRoutes 同步省略（无 routes 可统计）', async () => {
      const space = makeSpace();
      spaceRepo.findOne.mockResolvedValue(space);
      const catQb = createMockQueryBuilder([], 0);
      catQb.getMany = jest.fn().mockResolvedValue([]);
      categoryRepo.createQueryBuilder.mockReturnValue(catQb);
      const docQb = createMockQueryBuilder([], 0);
      docQb.getMany = jest.fn().mockResolvedValue([]);
      docRepo.createQueryBuilder.mockReturnValue(docQb);

      const result = await service.getOverview('space-1', { includeRoutes: false });
      expect(result.routes).toBeUndefined();
      expect(result.totalBrokenRoutes).toBeUndefined();
      expect(routeRepo.find).not.toHaveBeenCalled();
    });
  });

  // ─── Slug generation ──────────────────────────────────────

  describe('slug uniqueness', () => {
    it('appends suffix on collision', async () => {
      const saved = makeSpace({ name: 'test', slug: 'test-2' });
      // First call: slug "test" already exists → getOne returns a doc
      // Second call: slug "test-2" does not exist → getOne returns null
      let callCount = 0;
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn(() => {
          callCount++;
          return callCount === 1 ? { id: 'other' } : null;
        }),
      } as any;
      spaceRepo.createQueryBuilder.mockReturnValue(qb);
      spaceRepo.create.mockReturnValue(saved);
      spaceRepo.save.mockResolvedValue(saved);

      const result = await service.create(mockActor, { name: 'test' });
      expect(result.slug).toBe('test-2');
    });
  });
});
