import { Repository } from 'typeorm';
import { BoardService } from './board.service';
import { Board } from '../../database/entities/board.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { Task } from '../../database/entities/task.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { BoardMember } from '../../database/entities/board-member.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Visibility, ErrorCode, ActorType, UserRole, TaskStatus, BoardMemberRole, EventType } from '@agent-chamber/shared';
import { EventService } from '../event/event.service';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ResourceValidator } from '../../common/resource-validator';
import { TaskService } from '../task/task.service';
import { FindListTasksQueryDto } from './dto';

describe('BoardService', () => {
  let service: BoardService;
  let accessQuery: jest.Mocked<AccessQueryService>;
  let boardRepo: jest.Mocked<Repository<Board>>;
  let listRepo: jest.Mocked<Repository<BoardList>>;
  let taskRepo: jest.Mocked<Repository<Task>>;
  let topicRepo: jest.Mocked<Repository<Topic>>;
  let memberRepo: jest.Mocked<Repository<BoardMember>>;
  let agentRepo: jest.Mocked<Repository<Agent>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let actorRepo: jest.Mocked<Repository<Actor>>;
  let resourceValidator: { exists: jest.Mock; existsMany: jest.Mock };
  let taskService: jest.Mocked<TaskService>;
  let eventService: { create: jest.Mock };
  let docSpaceRepo: jest.Mocked<Repository<DocSpace>>;

  beforeEach(() => {
    accessQuery = {
      getAccessibleBoardIds: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AccessQueryService>;

    boardRepo = {
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      save: jest.fn((b: unknown) => Promise.resolve(b)),
      softDelete: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      })),
    } as unknown as jest.Mocked<Repository<Board>>;
    listRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn(),
    } as unknown as jest.Mocked<Repository<BoardList>>;
    taskRepo = {
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ total: '0', completed: '0' }),
      })),
    } as unknown as jest.Mocked<Repository<Task>>;
    topicRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Topic>>;
    memberRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as jest.Mocked<Repository<BoardMember>>;
    agentRepo = {
      find: jest.fn(),
      findBy: jest.fn(),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Agent>>;
    userRepo = {
      find: jest.fn(),
      findBy: jest.fn(),
    } as unknown as jest.Mocked<Repository<User>>;
    actorRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Actor>>;

    resourceValidator = {
      exists: jest.fn().mockResolvedValue({ id: 'agent-1' } as Agent),
      existsMany: jest.fn().mockResolvedValue([]),
    };

    taskService = {
      findAll: jest.fn(),
    } as unknown as jest.Mocked<TaskService>;

    eventService = {
      create: jest.fn().mockResolvedValue({}),
    };

    docSpaceRepo = {
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn(() => ({
          set: jest.fn(() => ({
            where: jest.fn(() => ({
              execute: jest.fn().mockResolvedValue({ affected: 0 }),
            })),
          })),
        })),
      })),
    } as unknown as jest.Mocked<Repository<DocSpace>>;

    service = new BoardService(
      boardRepo,
      listRepo,
      taskRepo,
      topicRepo,
      memberRepo,
      agentRepo,
      userRepo,
      actorRepo,
      accessQuery,
      resourceValidator as unknown as ResourceValidator,
      taskService,
      eventService as unknown as EventService,
      docSpaceRepo,
    );
  });

  afterEach(() => jest.clearAllMocks());

  const makeBoard = (overrides: Partial<Board> = {}): Board =>
    ({
      id: 'board-1',
      name: 'Test Board',
      topicId: 'topic-1',
      creatorId: 'creator-1',
      creatorType: 'human',
      settings: { visibility: Visibility.OPEN, invitedAgentIds: [] },
      lists: [],
      ...overrides,
    }) as Board;

  describe('enrich', () => {
    it('returns visibility and members from board_members table', async () => {
      const board = makeBoard({
        settings: { visibility: Visibility.PRIVATE },
      });
      memberRepo.find.mockResolvedValue([
        { boardId: 'board-1', actorId: 'agent-1', role: BoardMemberRole.MEMBER, invitedBy: 'creator-1', createdAt: new Date() } as BoardMember,
        { boardId: 'board-1', actorId: 'agent-2', role: BoardMemberRole.MEMBER, invitedBy: 'creator-1', createdAt: new Date() } as BoardMember,
      ]);
      actorRepo.find.mockResolvedValue([
        { id: 'agent-1', type: ActorType.AGENT } as Actor,
        { id: 'agent-2', type: ActorType.AGENT } as Actor,
      ]);
      agentRepo.find.mockResolvedValue([
        { id: 'agent-1', name: 'Kimi', avatarUrl: null, status: 'active', description: null } as any,
        { id: 'agent-2', name: 'DeepSeek', avatarUrl: null, status: 'active', description: null } as any,
      ]);
      const result = await service.enrich(board);
      expect(result.visibility).toBe(Visibility.PRIVATE);
      expect(result.members).toHaveLength(2);
      expect(result.members![0]).toMatchObject({ id: 'agent-1', name: 'Kimi', role: BoardMemberRole.MEMBER });
      expect(result.members![1]).toMatchObject({ id: 'agent-2', name: 'DeepSeek', role: BoardMemberRole.MEMBER });
    });

    it('returns empty members when board has no members', async () => {
      const board = makeBoard({ settings: {} });
      memberRepo.find.mockResolvedValue([]);
      const result = await service.enrich(board);
      expect(result.members).toEqual([]);
    });

    it('returns editor role members', async () => {
      const board = makeBoard({
        settings: { visibility: Visibility.OPEN },
      });
      memberRepo.find.mockResolvedValue([
        { boardId: 'board-1', actorId: 'agent-1', role: BoardMemberRole.EDITOR, invitedBy: 'creator-1', createdAt: new Date() } as BoardMember,
        { boardId: 'board-1', actorId: 'agent-2', role: BoardMemberRole.EDITOR, invitedBy: 'creator-1', createdAt: new Date() } as BoardMember,
      ]);
      actorRepo.find.mockResolvedValue([
        { id: 'agent-1', type: ActorType.AGENT } as Actor,
        { id: 'agent-2', type: ActorType.AGENT } as Actor,
      ]);
      agentRepo.find.mockResolvedValue([
        { id: 'agent-1', name: 'Kimi', avatarUrl: null, status: 'active', description: null } as any,
        { id: 'agent-2', name: 'DeepSeek', avatarUrl: null, status: 'active', description: null } as any,
      ]);
      const result = await service.enrich(board);
      expect(result.members).toHaveLength(2);
      expect(result.members![0].role).toBe(BoardMemberRole.EDITOR);
      expect(result.members![1].role).toBe(BoardMemberRole.EDITOR);
    });

    it('returns members with mixed roles and agent details', async () => {
      const board = makeBoard({
        settings: { visibility: Visibility.OPEN },
      });
      memberRepo.find.mockResolvedValue([
        { boardId: 'board-1', actorId: 'agent-1', role: BoardMemberRole.EDITOR, invitedBy: 'creator-1', createdAt: new Date('2024-01-01') } as BoardMember,
        { boardId: 'board-1', actorId: 'agent-2', role: BoardMemberRole.MEMBER, invitedBy: 'creator-1', createdAt: new Date('2024-01-02') } as BoardMember,
      ]);
      actorRepo.find.mockResolvedValue([
        { id: 'agent-1', type: ActorType.AGENT } as Actor,
        { id: 'agent-2', type: ActorType.AGENT } as Actor,
      ]);
      agentRepo.find.mockResolvedValue([
        { id: 'agent-1', name: 'Kimi', avatarUrl: 'https://a.com/1.png', status: 'active', description: null } as any,
        { id: 'agent-2', name: 'DeepSeek', avatarUrl: 'https://a.com/2.png', status: 'pending', description: null } as any,
      ]);
      const result = await service.enrich(board);
      expect(result.members).toEqual([
        { id: 'agent-1', name: 'Kimi', type: 'agent', avatarUrl: 'https://a.com/1.png', role: BoardMemberRole.EDITOR, invitedBy: 'creator-1', createdAt: expect.any(Date) },
        { id: 'agent-2', name: 'DeepSeek', type: 'agent', avatarUrl: 'https://a.com/2.png', role: BoardMemberRole.MEMBER, invitedBy: 'creator-1', createdAt: expect.any(Date) },
      ]);
    });

    it('returns unknown agent placeholder when agent not found', async () => {
      const board = makeBoard({
        settings: { visibility: Visibility.OPEN },
      });
      memberRepo.find.mockResolvedValue([
        { boardId: 'board-1', actorId: 'agent-missing', role: BoardMemberRole.MEMBER, invitedBy: 'creator-1', createdAt: new Date() } as BoardMember,
      ]);
      actorRepo.find.mockResolvedValue([
        { id: 'agent-missing', type: ActorType.AGENT } as Actor,
      ]);
      agentRepo.find.mockResolvedValue([]);
      const result = await service.enrich(board);
      expect(result.members![0]).toMatchObject({ id: 'agent-missing', name: 'Unknown Agent' });
    });

  });

  describe('enrich lists', () => {
    it('returns lists as BoardListSummary with taskCount and without tasks', async () => {
      const board = makeBoard({
        lists: [
          {
            id: 'list-1',
            boardId: 'board-1',
            name: 'To Do',
            position: 1,
            color: null,
            mappedStatus: 'todo',
            createdAt: new Date('2024-01-01'),
            updatedAt: new Date('2024-01-01'),
            deletedAt: null,
          },
        ] as unknown as BoardList[],
      });

      listRepo.find.mockResolvedValue([{ id: 'list-1' }] as BoardList[]);
      memberRepo.find.mockResolvedValue([]);
      taskRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ listId: 'list-1', count: '2' }]),
        getRawOne: jest.fn().mockResolvedValue({ total: '2', completed: '1' }),
      } as any);

      const result = await service.enrich(board);

      expect(result.lists[0]).toHaveProperty('taskCount', 2);
      expect(result.lists[0]).not.toHaveProperty('tasks');
      expect(result.taskCount).toBe(2);
      expect(result.completedTaskCount).toBe(1);
      expect(result.listCount).toBe(1);
    });
  });

  describe('findLists', () => {
    it('returns list metadata and taskCount sorted by position', async () => {
      // TypeORM returns lists already ordered by position ASC
      const lists = [
        {
          id: 'list-1',
          boardId: 'board-1',
          name: 'To Do',
          position: 1,
          color: null,
          mappedStatus: 'todo',
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
          deletedAt: null,
        },
        {
          id: 'list-2',
          boardId: 'board-1',
          name: 'In Progress',
          position: 2,
          color: '#fff',
          mappedStatus: 'in_progress',
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-02'),
          deletedAt: null,
        },
      ] as unknown as BoardList[];
      listRepo.find.mockResolvedValue(lists);

      taskRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { listId: 'list-1', count: '3' },
            { listId: 'list-2', count: '5' },
          ]),
      } as any);

      const result = await service.findLists('board-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('list-1');
      expect(result[0].taskCount).toBe(3);
      expect(result[0]).not.toHaveProperty('tasks');
      expect(result[1].id).toBe('list-2');
      expect(result[1].taskCount).toBe(5);
      expect(listRepo.find).toHaveBeenCalledWith({
        where: { boardId: 'board-1', deletedAt: expect.anything() },
        order: { position: 'ASC', createdAt: 'ASC' },
      });
    });

    it('returns empty array when board has no lists', async () => {
      listRepo.find.mockResolvedValue([]);

      const result = await service.findLists('board-1');

      expect(result).toEqual([]);
      expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('findListTasks', () => {
    it('defaults to backlog and in_progress', async () => {
      listRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      taskService.findAll.mockResolvedValue({
        items: [{ id: 'task-1', title: 'Task 1', status: TaskStatus.BACKLOG, priority: 'p1' }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });

      const result = await service.findListTasks('board-1', 'list-1', {} as FindListTasksQueryDto);

      expect(result.items).toHaveLength(1);
      expect(taskService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          listId: 'list-1',
          status: [TaskStatus.BACKLOG, TaskStatus.IN_PROGRESS],
        }),
        undefined,
      );
    });

    it('supports status=all', async () => {
      listRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      taskService.findAll.mockResolvedValue({
        items: [
          { id: 'task-1', title: 'Task 1', status: TaskStatus.TODO, priority: 'p1' },
          { id: 'task-2', title: 'Task 2', status: TaskStatus.DONE, priority: 'p2' },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });

      const result = await service.findListTasks('board-1', 'list-1', {
        status: 'all',
      } as FindListTasksQueryDto);

      expect(result.total).toBe(2);
      expect(taskService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          listId: 'list-1',
          status: 'all',
        }),
        undefined,
      );
    });

    it('supports status array', async () => {
      listRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      taskService.findAll.mockResolvedValue({
        items: [{ id: 'task-1', title: 'Task 1', status: TaskStatus.DONE, priority: 'p1' }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });

      const result = await service.findListTasks('board-1', 'list-1', {
        status: [TaskStatus.DONE],
      } as FindListTasksQueryDto);

      expect(result.total).toBe(1);
      expect(taskService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          listId: 'list-1',
          status: [TaskStatus.DONE],
        }),
        undefined,
      );
    });

    it('returns 404 when list does not belong to board', async () => {
      listRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-2',
      } as BoardList);

      await expect(
        service.findListTasks('board-1', 'list-1', {} as FindListTasksQueryDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns 404 when list not found', async () => {
      listRepo.findOne.mockResolvedValue(null);

      await expect(
        service.findListTasks('board-1', 'list-1', {} as FindListTasksQueryDto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    function createMockQueryBuilder(items: Board[], total: number) {
      const getManyAndCountMock = jest.fn().mockResolvedValue([items, total]);
      const andWhereMock = jest.fn().mockReturnThis();
      return {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: andWhereMock,
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getManyAndCount: getManyAndCountMock,
      } as unknown as SelectQueryBuilder<Board> & {
        andWhere: jest.Mock;
        getManyAndCount: jest.Mock;
      };
    }

    it('returns memberCount from board_members table', async () => {
      const board = makeBoard({
        settings: { visibility: Visibility.OPEN },
      });
      const qbMock = createMockQueryBuilder([board], 1);
      boardRepo.createQueryBuilder.mockReturnValue(qbMock);
      memberRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { boardId: 'board-1', count: '2' },
        ]),
      } as any);

      const result = await service.findAll();
      expect((result.items[0] as unknown as { memberCount: number }).memberCount).toBe(2);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });

    it('returns zero memberCount when board has no members', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      const qbMock = createMockQueryBuilder([board], 1);
      boardRepo.createQueryBuilder.mockReturnValue(qbMock);
      memberRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      } as any);

      const result = await service.findAll();
      expect((result.items[0] as unknown as { memberCount: number }).memberCount).toBe(0);
    });

    it('should strip description and produce descriptionSnippet from board', async () => {
      const board = makeBoard({ description: 'A board description' });
      const qbMock = createMockQueryBuilder([board], 1);
      boardRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll();
      const item = result.items[0] as unknown as Record<string, unknown>;
      expect(item).not.toHaveProperty('description');
      expect(item.descriptionSnippet).toBe('A board description');
    });

    it('should truncate long board description to 200 characters', async () => {
      const longDesc = 'y'.repeat(300);
      const board = makeBoard({ description: longDesc });
      const qbMock = createMockQueryBuilder([board], 1);
      boardRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll();
      const item = result.items[0] as unknown as Record<string, unknown>;
      expect(item.descriptionSnippet).toHaveLength(200);
      expect(item.descriptionSnippet).toBe(longDesc.slice(0, 200));
    });

    it('should return null descriptionSnippet when board description is null', async () => {
      const board = makeBoard({ description: null });
      const qbMock = createMockQueryBuilder([board], 1);
      boardRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll();
      const item = result.items[0] as unknown as Record<string, unknown>;
      expect(item.descriptionSnippet).toBeNull();
    });

    it('should not add IN filter for admin actor', async () => {
      const board = makeBoard();
      const qbMock = createMockQueryBuilder([board], 1);
      boardRepo.createQueryBuilder.mockReturnValue(qbMock);
      accessQuery.getAccessibleBoardIds.mockResolvedValue(null);

      const adminActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
      await service.findAll({}, adminActor);

      expect(accessQuery.getAccessibleBoardIds).toHaveBeenCalledWith(adminActor);
      expect(qbMock.andWhere).not.toHaveBeenCalledWith(
        'board.id IN (:...accessibleBoardIds)',
        expect.anything(),
      );
    });

    it('should add IN filter for non-admin actor', async () => {
      const board = makeBoard({ id: 'board-1' });
      const qbMock = createMockQueryBuilder([board], 1);
      boardRepo.createQueryBuilder.mockReturnValue(qbMock);
      accessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const result = await service.findAll({}, actor);

      expect(accessQuery.getAccessibleBoardIds).toHaveBeenCalledWith(actor);
      expect(qbMock.andWhere).toHaveBeenCalledWith('board.id IN (:...accessibleBoardIds)', {
        accessibleBoardIds: ['board-1'],
      });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });

    it('should return empty pagination when accessible board ids is empty', async () => {
      accessQuery.getAccessibleBoardIds.mockResolvedValue([]);

      const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const result = await service.findAll({ page: 1, pageSize: 20 }, actor);

      expect(boardRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      });
    });
  });

  describe('create', () => {
    it('throws TOPIC_NOT_FOUND when topicId does not exist', async () => {
      topicRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create('user-1', ActorType.HUMAN, {
          name: 'New Board',
          topicId: 'topic-missing',
        } as any),
      ).rejects.toMatchObject({ response: { code: ErrorCode.TOPIC_NOT_FOUND } });
    });

    it('throws AGENT_NOT_FOUND when invitedAgentIds contains non-existent agent', async () => {
      topicRepo.findOne.mockResolvedValue({
        id: 'topic-1',
        settings: { visibility: Visibility.OPEN },
      } as unknown as Topic);
      resourceValidator.existsMany.mockRejectedValue(
        new NotFoundException({ message: 'Some resources not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(
        service.create('user-1', ActorType.HUMAN, {
          name: 'New Board',
          topicId: 'topic-1',
          invitedAgentIds: ['agent-missing'],
        } as any),
      ).rejects.toMatchObject({ response: { code: ErrorCode.AGENT_NOT_FOUND } });
    });
  });

  describe('update', () => {
    it('throws TOPIC_NOT_FOUND when topicId changed to non-existent topic', async () => {
      const board = makeBoard({ topicId: 'topic-1' });
      boardRepo.findOne.mockResolvedValue(board);
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND }),
      );

      await expect(
        service.update('board-1', { topicId: 'topic-missing' } as any),
      ).rejects.toMatchObject({ response: { code: ErrorCode.TOPIC_NOT_FOUND } });
    });

    it('throws AGENT_NOT_FOUND when invitedAgentIds contains non-existent agent', async () => {
      const board = makeBoard();
      boardRepo.findOne.mockResolvedValue(board);
      resourceValidator.existsMany.mockRejectedValue(
        new NotFoundException({ message: 'Some resources not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(
        service.update('board-1', { invitedAgentIds: ['agent-missing'] } as any),
      ).rejects.toMatchObject({ response: { code: ErrorCode.AGENT_NOT_FOUND } });
    });

    it('does not downgrade editor when invitedAgentIds includes an editor', async () => {
      // review 回归：save 按 PK upsert，toAdd 不排除已有行会把 editor 覆盖降级为 member
      const board = makeBoard();
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.find
        // 第一次调用：currentMembers（role='member'）
        .mockResolvedValueOnce([
          { boardId: 'board-1', actorId: 'agent-member', role: BoardMemberRole.MEMBER } as BoardMember,
        ])
        // 第二次调用：existingAll（任意 role）
        .mockResolvedValueOnce([{ actorId: 'agent-editor' }, { actorId: 'agent-member' }] as BoardMember[]);

      await service.update('board-1', { invitedAgentIds: ['agent-editor', 'agent-new'] } as any);

      // 仅 agent-new 被插入 member 行；editor 行不被覆盖
      expect(memberRepo.create).toHaveBeenCalledTimes(1);
      expect(memberRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'agent-new', role: BoardMemberRole.MEMBER }),
      );
    });
  });

  describe('removeList', () => {
    it('throws LIST_NOT_FOUND when moveTasksTo target list does not exist', async () => {
      const list = {
        id: 'list-1',
        tasks: [{ id: 'task-1' }],
      } as unknown as BoardList;
      listRepo.findOne.mockResolvedValue(list);
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'List not found', code: ErrorCode.LIST_NOT_FOUND }),
      );

      await expect(service.removeList('list-1', 'list-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.LIST_NOT_FOUND },
      });
    });
  });

  describe('inviteAgent', () => {
    it('creates board member and fires AGENT_JOINED event', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue(null);

      const result = await service.inviteAgent('board-1', 'agent-2');

      expect(memberRepo.create).toHaveBeenCalledWith({
        boardId: 'board-1',
        actorId: 'agent-2',
        role: BoardMemberRole.MEMBER,
        invitedBy: board.creatorId,
      });
      expect(memberRepo.save).toHaveBeenCalled();
      expect(eventService.create).toHaveBeenCalledWith({
        eventType: EventType.AGENT_JOINED,
        resourceType: 'board',
        resourceId: 'board-1',
        actorId: 'agent-2',
        topicId: board.topicId,
        boardId: 'board-1',
      });
      expect(result).toBe(board);
    });

    it('throws when board not found', async () => {
      boardRepo.findOne.mockResolvedValue(null);
      await expect(service.inviteAgent('board-1', 'agent-1')).rejects.toThrow(NotFoundException);
    });

    it('throws when agent already has access', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1', actorId: 'agent-1', role: BoardMemberRole.MEMBER,
      } as BoardMember);

      await expect(service.inviteAgent('board-1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('throws AGENT_NOT_FOUND when agent does not exist', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(service.inviteAgent('board-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });
  });

  describe('uninviteAgent', () => {
    it('deletes member and fires AGENT_LEFT event', async () => {
      const board = makeBoard({
        settings: { visibility: Visibility.OPEN },
      });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1', actorId: 'agent-1', role: BoardMemberRole.MEMBER,
      } as BoardMember);

      const result = await service.uninviteAgent('board-1', 'agent-1');

      expect(memberRepo.delete).toHaveBeenCalledWith({ boardId: 'board-1', actorId: 'agent-1' });
      expect(eventService.create).toHaveBeenCalledWith({
        eventType: EventType.AGENT_LEFT,
        resourceType: 'board',
        resourceId: 'board-1',
        actorId: 'agent-1',
        topicId: board.topicId,
        boardId: 'board-1',
      });
      expect(result).toBe(board);
    });

    it('throws when board not found', async () => {
      boardRepo.findOne.mockResolvedValue(null);
      await expect(service.uninviteAgent('board-1', 'agent-1')).rejects.toThrow(NotFoundException);
    });

    it('throws when agent is not a member', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue(null);

      await expect(service.uninviteAgent('board-1', 'agent-2')).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws AGENT_NOT_FOUND when agent does not exist', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(service.uninviteAgent('board-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });
  });

  describe('addEditor', () => {
    it('creates board member with editor role and fires AGENT_JOINED', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue(null);

      const result = await service.addEditor('board-1', 'agent-2');

      expect(memberRepo.create).toHaveBeenCalledWith({
        boardId: 'board-1',
        actorId: 'agent-2',
        role: BoardMemberRole.EDITOR,
        invitedBy: board.creatorId,
      });
      expect(memberRepo.save).toHaveBeenCalled();
      expect(eventService.create).toHaveBeenCalledWith({
        eventType: EventType.AGENT_JOINED,
        resourceType: 'board',
        resourceId: 'board-1',
        actorId: 'agent-2',
        topicId: board.topicId,
        boardId: 'board-1',
      });
      expect(result).toBe(board);
    });

    it('throws when board not found', async () => {
      boardRepo.findOne.mockResolvedValue(null);
      await expect(service.addEditor('board-1', 'agent-1')).rejects.toThrow(NotFoundException);
    });

    it('throws when agent is already an editor', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1', actorId: 'agent-1', role: BoardMemberRole.EDITOR,
      } as BoardMember);

      await expect(service.addEditor('board-1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('throws AGENT_NOT_FOUND when agent does not exist', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(service.addEditor('board-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });
  });

  describe('removeEditor', () => {
    it('deletes editor member and fires AGENT_LEFT event', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1', actorId: 'agent-1', role: BoardMemberRole.EDITOR,
      } as BoardMember);

      const result = await service.removeEditor('board-1', 'agent-1');

      expect(memberRepo.delete).toHaveBeenCalledWith({
        boardId: 'board-1', actorId: 'agent-1', role: BoardMemberRole.EDITOR,
      });
      expect(eventService.create).toHaveBeenCalledWith({
        eventType: EventType.AGENT_LEFT,
        resourceType: 'board',
        resourceId: 'board-1',
        actorId: 'agent-1',
        topicId: board.topicId,
        boardId: 'board-1',
      });
      expect(result).toBe(board);
    });

    it('throws when board not found', async () => {
      boardRepo.findOne.mockResolvedValue(null);
      await expect(service.removeEditor('board-1', 'agent-1')).rejects.toThrow(NotFoundException);
    });

    it('throws when agent is not an editor', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue(null);

      await expect(service.removeEditor('board-1', 'agent-2')).rejects.toThrow(ConflictException);
    });

    it('throws AGENT_NOT_FOUND when agent does not exist', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(service.removeEditor('board-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });
  });

  describe('remove', () => {
    it('nullifies board_id on linked doc_spaces', async () => {
      const board = makeBoard({ id: 'board-1' });
      boardRepo.findOne.mockResolvedValue(board);
      boardRepo.softDelete.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      // Capture the docSpaceRepo QB chain mocks
      const executeMock = jest.fn().mockResolvedValue({ affected: 1 });
      const whereMock = jest.fn().mockReturnValue({ execute: executeMock });
      const setMock = jest.fn().mockReturnValue({ where: whereMock });
      const updateMock = jest.fn().mockReturnValue({ set: setMock });
      docSpaceRepo.createQueryBuilder = jest.fn().mockReturnValue({ update: updateMock });

      // Default mocks for enrich (called via findOne inside remove)
      memberRepo.find.mockResolvedValue([]);
      listRepo.find.mockResolvedValue([]);

      const result = await service.remove('board-1');

      expect(result).toBe(true);
      expect(boardRepo.softDelete).toHaveBeenCalledWith('board-1');

      // Verify docSpaceRepo cascade
      expect(docSpaceRepo.createQueryBuilder).toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalledWith(DocSpace);
      expect(setMock).toHaveBeenCalledWith({ boardId: null });
      expect(whereMock).toHaveBeenCalledWith('board_id = :boardId', { boardId: 'board-1' });
      expect(executeMock).toHaveBeenCalled();
    });
  });
});
