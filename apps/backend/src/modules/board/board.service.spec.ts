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
import { Doc } from '../../database/entities/doc.entity';
import { Milestone } from '../../database/entities/milestone.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { Message } from '../../database/entities/message.entity';
import {
  Visibility,
  ErrorCode,
  ActorType,
  UserRole,
  TaskStatus,
  BoardMemberRole,
  EventType,
  Priority,
} from '@agent-chamber/shared';
import { EventService } from '../event/event.service';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ResourceValidator } from '../../common/resource-validator';
import { TaskService } from '../task/task.service';
import { ActorProfileService, ActorProfile } from '../../common/services/actor-profile.service';
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
  let docRepo: jest.Mocked<Repository<Doc>>;
  let milestoneRepo: jest.Mocked<Repository<Milestone>>;
  let seatRepo: jest.Mocked<Repository<RoundtableSeat>>;
  let messageRepo: jest.Mocked<Repository<Message>>;
  let mockActorProfileService: { resolveProfiles: jest.Mock; assertActorUsable: jest.Mock };

  beforeEach(() => {
    accessQuery = {
      getAccessibleBoardIds: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AccessQueryService>;

    boardRepo = {
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      // create() 单测（4b1ddd1c）需要实体工厂：透传入参
      create: jest.fn((x: unknown) => x),
      save: jest.fn((b: unknown) => Promise.resolve(b)),
      softDelete: jest.fn(),
      // v1.42 metrics：原生原子 SQL（jsonb_set 合并），Repository.query 直通
      query: jest.fn(),
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
      // findAll 跨 board 批量 lists 查询（接口瘦身二期：不再 join board.lists）
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as jest.Mocked<Repository<BoardList>>;
    taskRepo = {
      update: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      // digest recentDone limit=0 的 COUNT 兜底（topicRepo.count 已用于 roundtable 段）
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ total: '0', completed: '0' }),
        getMany: jest.fn().mockResolvedValue([]),
        getCount: jest.fn().mockResolvedValue(0),
      })),
    } as unknown as jest.Mocked<Repository<Task>>;
    topicRepo = {
      findOne: jest.fn(),
      // v1.44.0-dev digest roundtable 段：圆桌 topic 数（零态默认 0）
      count: jest.fn().mockResolvedValue(0),
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
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<DocSpace>>;
    docRepo = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as jest.Mocked<Repository<Doc>>;
    milestoneRepo = {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<Milestone>>;
    // v1.44.0-dev digest roundtable 段：座位 repo（count/find 零态默认——无圆桌时全零）
    seatRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Repository<RoundtableSeat>>;
    // v1.44.0-dev digest roundtable 段：座位消息计数（零态默认 0；全时段 → 7 天窗口两次 getCount）
    messageRepo = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      })),
    } as unknown as jest.Mocked<Repository<Message>>;

    // 统一批 A1：resolveActorProfiles 收敛委托 ActorProfileService。mock 默认实现
    // 复用三个 repo mock（actorRepo.find 取 type、user/agent repo 取 profile），
    // 使既有用例经 repo mock 驱动的行为与断言无需逐条改写（公共服务自身逻辑
    // 在 actor-profile.service.spec.ts 单独验证，本 mock 只模拟行为等价）。
    mockActorProfileService = {
      resolveProfiles: jest.fn(async (actorIds: string[]): Promise<Map<string, ActorProfile>> => {
        const uniqueIds = [...new Set(actorIds)].filter(Boolean);
        const map = new Map<string, ActorProfile>();
        if (uniqueIds.length === 0) return map;
        const typeRows = await actorRepo.find({} as any);
        const typeMap = new Map(typeRows.map((a) => [a.id, a.type]));
        // A2：deletedAt 从 actor 行透传（对齐公共服务 withDeleted 行为），
        // 软删用例通过 actorRepo.find 返回带 deletedAt 的行驱动
        const actorRowMap = new Map(typeRows.map((a) => [a.id, a]));
        const humanIds = uniqueIds.filter((id) => typeMap.get(id) === ActorType.HUMAN);
        const agentIds = uniqueIds.filter((id) => typeMap.get(id) === ActorType.AGENT);
        const [humans, agents] = await Promise.all([
          humanIds.length > 0 ? userRepo.find({} as any) : Promise.resolve([] as User[]),
          agentIds.length > 0 ? agentRepo.find({} as any) : Promise.resolve([] as Agent[]),
        ]);
        const humanMap = new Map(humans.map((u) => [u.id, u]));
        const agentMap = new Map(agents.map((a) => [a.id, a]));
        for (const id of uniqueIds) {
          const type = typeMap.get(id);
          const deletedAt = actorRowMap.get(id)?.deletedAt ?? null;
          if (type === ActorType.HUMAN) {
            const u = humanMap.get(id);
            map.set(id, {
              type,
              name: u?.displayName || u?.username || 'Unknown User',
              avatarUrl: u?.avatarUrl ?? null,
              description: null,
              deletedAt,
            });
          } else if (type === ActorType.AGENT) {
            const a = agentMap.get(id);
            map.set(id, {
              type,
              name: a?.name || 'Unknown Agent',
              avatarUrl: a?.avatarUrl ?? null,
              description: a?.description ?? null,
              deletedAt,
            });
          } else if (type) {
            map.set(id, {
              type,
              name: 'System',
              avatarUrl: null,
              description: null,
              deletedAt,
            });
          }
        }
        return map;
      }),
      assertActorUsable: jest.fn().mockResolvedValue(undefined),
    };

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
      docRepo,
      milestoneRepo,
      seatRepo,
      messageRepo,
      mockActorProfileService as unknown as ActorProfileService,
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
        {
          boardId: 'board-1',
          actorId: 'agent-1',
          role: BoardMemberRole.MEMBER,
          invitedBy: 'creator-1',
          createdAt: new Date(),
        } as BoardMember,
        {
          boardId: 'board-1',
          actorId: 'agent-2',
          role: BoardMemberRole.MEMBER,
          invitedBy: 'creator-1',
          createdAt: new Date(),
        } as BoardMember,
      ]);
      actorRepo.find.mockResolvedValue([
        { id: 'agent-1', type: ActorType.AGENT } as Actor,
        { id: 'agent-2', type: ActorType.AGENT } as Actor,
      ]);
      agentRepo.find.mockResolvedValue([
        {
          id: 'agent-1',
          name: 'Kimi',
          avatarUrl: null,
          status: 'active',
          description: null,
        } as any,
        {
          id: 'agent-2',
          name: 'DeepSeek',
          avatarUrl: null,
          status: 'active',
          description: null,
        } as any,
      ]);
      const result = await service.enrich(board);
      expect(result.visibility).toBe(Visibility.PRIVATE);
      expect(result.members).toHaveLength(2);
      expect(result.members![0]).toMatchObject({
        id: 'agent-1',
        name: 'Kimi',
        role: BoardMemberRole.MEMBER,
      });
      expect(result.members![1]).toMatchObject({
        id: 'agent-2',
        name: 'DeepSeek',
        role: BoardMemberRole.MEMBER,
      });
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
        {
          boardId: 'board-1',
          actorId: 'agent-1',
          role: BoardMemberRole.EDITOR,
          invitedBy: 'creator-1',
          createdAt: new Date(),
        } as BoardMember,
        {
          boardId: 'board-1',
          actorId: 'agent-2',
          role: BoardMemberRole.EDITOR,
          invitedBy: 'creator-1',
          createdAt: new Date(),
        } as BoardMember,
      ]);
      actorRepo.find.mockResolvedValue([
        { id: 'agent-1', type: ActorType.AGENT } as Actor,
        { id: 'agent-2', type: ActorType.AGENT } as Actor,
      ]);
      agentRepo.find.mockResolvedValue([
        {
          id: 'agent-1',
          name: 'Kimi',
          avatarUrl: null,
          status: 'active',
          description: null,
        } as any,
        {
          id: 'agent-2',
          name: 'DeepSeek',
          avatarUrl: null,
          status: 'active',
          description: null,
        } as any,
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
        {
          boardId: 'board-1',
          actorId: 'agent-1',
          role: BoardMemberRole.EDITOR,
          invitedBy: 'creator-1',
          createdAt: new Date('2024-01-01'),
        } as BoardMember,
        {
          boardId: 'board-1',
          actorId: 'agent-2',
          role: BoardMemberRole.MEMBER,
          invitedBy: 'creator-1',
          createdAt: new Date('2024-01-02'),
        } as BoardMember,
      ]);
      actorRepo.find.mockResolvedValue([
        { id: 'agent-1', type: ActorType.AGENT } as Actor,
        { id: 'agent-2', type: ActorType.AGENT } as Actor,
      ]);
      agentRepo.find.mockResolvedValue([
        {
          id: 'agent-1',
          name: 'Kimi',
          avatarUrl: 'https://a.com/1.png',
          status: 'active',
          description: null,
        } as any,
        {
          id: 'agent-2',
          name: 'DeepSeek',
          avatarUrl: 'https://a.com/2.png',
          status: 'pending',
          description: null,
        } as any,
      ]);
      const result = await service.enrich(board);
      expect(result.members).toEqual([
        {
          id: 'agent-1',
          name: 'Kimi',
          type: 'agent',
          avatarUrl: 'https://a.com/1.png',
          deletedAt: null,
          role: BoardMemberRole.EDITOR,
          invitedBy: 'creator-1',
          createdAt: expect.any(Date),
        },
        {
          id: 'agent-2',
          name: 'DeepSeek',
          type: 'agent',
          avatarUrl: 'https://a.com/2.png',
          deletedAt: null,
          role: BoardMemberRole.MEMBER,
          invitedBy: 'creator-1',
          createdAt: expect.any(Date),
        },
      ]);
    });

    it('returns unknown agent placeholder when agent not found', async () => {
      const board = makeBoard({
        settings: { visibility: Visibility.OPEN },
      });
      memberRepo.find.mockResolvedValue([
        {
          boardId: 'board-1',
          actorId: 'agent-missing',
          role: BoardMemberRole.MEMBER,
          invitedBy: 'creator-1',
          createdAt: new Date(),
        } as BoardMember,
      ]);
      actorRepo.find.mockResolvedValue([{ id: 'agent-missing', type: ActorType.AGENT } as Actor]);
      agentRepo.find.mockResolvedValue([]);
      const result = await service.enrich(board);
      expect(result.members![0]).toMatchObject({ id: 'agent-missing', name: 'Unknown Agent' });
    });

    it('软删 agent 成员：真名保留 + deletedAt 非空（统一批契约）', async () => {
      const board = makeBoard({
        settings: { visibility: Visibility.OPEN },
      });
      memberRepo.find.mockResolvedValue([
        {
          boardId: 'board-1',
          actorId: 'agent-1',
          role: BoardMemberRole.MEMBER,
          invitedBy: 'creator-1',
          createdAt: new Date(),
        } as BoardMember,
      ]);
      // 软删行：actors 带 deletedAt（withDeleted 语义经 mock 透传）
      actorRepo.find.mockResolvedValue([
        {
          id: 'agent-1',
          type: ActorType.AGENT,
          deletedAt: new Date('2024-06-01T00:00:00Z'),
        } as Actor,
      ]);
      agentRepo.find.mockResolvedValue([
        {
          id: 'agent-1',
          name: 'Kimi',
          avatarUrl: null,
          status: 'active',
          description: null,
        } as any,
      ]);
      const result = await service.enrich(board);
      expect(result.members![0]).toMatchObject({
        id: 'agent-1',
        name: 'Kimi',
        deletedAt: '2024-06-01T00:00:00.000Z',
      });
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
        getRawMany: jest.fn().mockResolvedValue([
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
        getRawMany: jest.fn().mockResolvedValue([{ boardId: 'board-1', count: '2' }]),
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

    it('should delegate to mine-only whitelist when query.mine is true (v1.70)', async () => {
      const board = makeBoard({ id: 'board-1' });
      const qbMock = createMockQueryBuilder([board], 1);
      boardRepo.createQueryBuilder.mockReturnValue(qbMock);
      accessQuery.getMyBoardIds = jest.fn().mockResolvedValue(['board-1']);

      const actor = { id: 'user-1', type: ActorType.HUMAN };
      await service.findAll({ mine: true }, actor);

      expect(accessQuery.getMyBoardIds).toHaveBeenCalledWith(actor);
      expect(accessQuery.getAccessibleBoardIds).not.toHaveBeenCalled();
      expect(qbMock.andWhere).toHaveBeenCalledWith('board.id IN (:...accessibleBoardIds)', {
        accessibleBoardIds: ['board-1'],
      });
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

    it('should expose lists summary (findLists shape) and strip settings (接口瘦身二期)', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      const qbMock = createMockQueryBuilder([board], 1);
      boardRepo.createQueryBuilder.mockReturnValue(qbMock);
      // 跨 board 批量 lists 查询返回 1 条（含软删列应被 SQL 过滤，mock 只给非软删）
      listRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'list-1',
            boardId: 'board-1',
            name: '待办',
            position: 0,
            color: 'blue',
            mappedStatus: 'backlog',
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
            updatedAt: new Date('2026-08-01T00:00:00.000Z'),
          } as BoardList,
        ]),
      } as unknown as SelectQueryBuilder<BoardList>);
      // 批量 task count per list
      taskRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ listId: 'list-1', count: '3' }]),
      } as any);

      const result = await service.findAll();
      const item = result.items[0] as unknown as Record<string, unknown>;

      // settings 不再透传；顶层 visibility 拍平保留
      expect(item).not.toHaveProperty('settings');
      expect(item.visibility).toBe(Visibility.OPEN);
      // lists 摘要形状 = findLists 项形状（含 taskCount），无软删列/实体泄漏
      expect(item.lists).toEqual([
        {
          id: 'list-1',
          boardId: 'board-1',
          name: '待办',
          position: 0,
          color: 'blue',
          mappedStatus: 'backlog',
          taskCount: 3,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      expect((item.lists as unknown[])[0]).not.toHaveProperty('deletedAt');
      expect(item.listCount).toBe(1);
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
      // 统一批 A2.5b：create invitedAgentIds 校验改走 assertActorUsable（create 一刀切）
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(
        service.create('user-1', ActorType.HUMAN, {
          name: 'New Board',
          topicId: 'topic-1',
          invitedAgentIds: ['agent-missing'],
        } as any),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
    });

    it('create：已软删 agent 在 invitedAgentIds → 4xx AGENT_NOT_FOUND（统一批 A2.5b）', async () => {
      topicRepo.findOne.mockResolvedValue({
        id: 'topic-1',
        settings: { visibility: Visibility.OPEN },
      } as unknown as Topic);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(
        service.create('user-1', ActorType.HUMAN, {
          name: 'New Board',
          invitedAgentIds: ['agent-deleted'],
        } as any),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    it('writes creator membership row with editor role and null invitedBy (4b1ddd1c)', async () => {
      boardRepo.save.mockImplementation(async (b: any) => ({ ...b, id: 'board-new' }));

      await service.create('user-1', ActorType.HUMAN, { name: 'New Board' } as any);

      // creator 落成员行：role=editor（与 isCreator 能力对齐）+ invitedBy=null（非授予标记）
      expect(memberRepo.create).toHaveBeenCalledWith({
        boardId: 'board-new',
        actorId: 'user-1',
        role: BoardMemberRole.EDITOR,
        invitedBy: null,
      });
      expect(memberRepo.save).toHaveBeenCalled();
    });

    it('filters creator out of invitedAgentIds — single editor row, no PK conflict', async () => {
      boardRepo.save.mockImplementation(async (b: any) => ({ ...b, id: 'board-new' }));
      // A2.5b：create 校验走 assertActorUsable（默认放行）；受邀 agent-1 照常落成员行

      await service.create('user-1', ActorType.HUMAN, {
        name: 'New Board',
        invitedAgentIds: ['agent-1', 'user-1'],
      } as any);

      const createdRows = memberRepo.create.mock.calls.map((call) => call[0]) as Array<{
        actorId: string;
        role: BoardMemberRole;
      }>;
      // creator 只出现一次且为 editor 行（invited 列表中的重复被过滤）
      const creatorRows = createdRows.filter((r) => r.actorId === 'user-1');
      expect(creatorRows).toHaveLength(1);
      expect(creatorRows[0].role).toBe(BoardMemberRole.EDITOR);
      // 受邀 agent 照常落 member 行
      expect(
        createdRows.some((r) => r.actorId === 'agent-1' && r.role === BoardMemberRole.MEMBER),
      ).toBe(true);
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
      // A2.5b：update 只拦 toAdd——空成员表时全部 id 都是新增
      memberRepo.find.mockResolvedValue([]);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(
        service.update('board-1', { invitedAgentIds: ['agent-missing'] } as any),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
    });

    it('update：存量含已删 agent → 放行（只拦新增，A2.5b/R11 对偶）', async () => {
      const board = makeBoard();
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.find
        // 第一次调用：currentMembers（role='member'）
        .mockResolvedValueOnce([
          {
            boardId: 'board-1',
            actorId: 'agent-deleted',
            role: BoardMemberRole.MEMBER,
          } as BoardMember,
        ])
        // 第二次调用：existingAll（任意 role）
        .mockResolvedValueOnce([{ actorId: 'agent-deleted' }] as BoardMember[]);

      await service.update('board-1', { invitedAgentIds: ['agent-deleted'] } as any);

      // 存量 id 不触发校验、不新增、不删除——set 语义全量替换不得拦存量已删成员
      expect(mockActorProfileService.assertActorUsable).not.toHaveBeenCalled();
      expect(memberRepo.create).not.toHaveBeenCalled();
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('update：新增 id 含已删 agent → 4xx AGENT_NOT_FOUND（A2.5b/R11 对偶）', async () => {
      const board = makeBoard();
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.find
        .mockResolvedValueOnce([
          { boardId: 'board-1', actorId: 'agent-old', role: BoardMemberRole.MEMBER } as BoardMember,
        ])
        .mockResolvedValueOnce([{ actorId: 'agent-old' }] as BoardMember[]);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(
        service.update('board-1', { invitedAgentIds: ['agent-old', 'agent-deleted'] } as any),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
      expect(memberRepo.create).not.toHaveBeenCalled();
    });

    it('does not downgrade editor when invitedAgentIds includes an editor', async () => {
      // review 回归：save 按 PK upsert，toAdd 不排除已有行会把 editor 覆盖降级为 member
      const board = makeBoard();
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.find
        // 第一次调用：currentMembers（role='member'）
        .mockResolvedValueOnce([
          {
            boardId: 'board-1',
            actorId: 'agent-member',
            role: BoardMemberRole.MEMBER,
          } as BoardMember,
        ])
        // 第二次调用：existingAll（任意 role）
        .mockResolvedValueOnce([
          { actorId: 'agent-editor' },
          { actorId: 'agent-member' },
        ] as BoardMember[]);

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
        boardId: 'board-1',
        actorId: 'agent-1',
        role: BoardMemberRole.MEMBER,
      } as BoardMember);

      await expect(service.inviteAgent('board-1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('throws AGENT_NOT_FOUND when agent does not exist', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      // 统一批 A2.5：存在性校验改走 assertActorUsable
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.inviteAgent('board-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });

    it('inviteAgent：已软删 agent → 4xx AGENT_NOT_FOUND + message 断言（统一批 A2.5）', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.inviteAgent('board-1', 'agent-deleted')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
      expect(memberRepo.create).not.toHaveBeenCalled();
      expect(memberRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('uninviteAgent', () => {
    it('deletes member and fires AGENT_LEFT event', async () => {
      const board = makeBoard({
        settings: { visibility: Visibility.OPEN },
      });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1',
        actorId: 'agent-1',
        role: BoardMemberRole.MEMBER,
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

      await expect(service.uninviteAgent('board-1', 'agent-2')).rejects.toThrow(ConflictException);
    });

    it('rejects uninviting the creator (4b1ddd1c 守卫)', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } }); // creatorId='creator-1'
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1',
        actorId: 'creator-1',
        role: BoardMemberRole.MEMBER,
      } as BoardMember);

      await expect(service.uninviteAgent('board-1', 'creator-1')).rejects.toMatchObject({
        response: { code: ErrorCode.RESOURCE_CONFLICT },
      });
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('throws AGENT_NOT_FOUND when agent does not exist', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      // 统一批 A2.5b：移除类入口回退 resourceValidator.exists（软删 agent 不拦）
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(service.uninviteAgent('board-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });

    it('uninviteAgent：已软删 agent → 放行（移除类入口不拦，A2.5b 修正）', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      // 软删 agent 的 agents 行永在 → resourceValidator.exists 放行（清理动作必须可用）
      resourceValidator.exists.mockResolvedValue({ id: 'agent-deleted' } as Agent);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1',
        actorId: 'agent-deleted',
        role: BoardMemberRole.MEMBER,
      } as BoardMember);

      await service.uninviteAgent('board-1', 'agent-deleted');

      expect(memberRepo.delete).toHaveBeenCalledWith({
        boardId: 'board-1',
        actorId: 'agent-deleted',
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
        boardId: 'board-1',
        actorId: 'agent-1',
        role: BoardMemberRole.EDITOR,
      } as BoardMember);

      await expect(service.addEditor('board-1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('throws AGENT_NOT_FOUND when agent does not exist', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      // 统一批 A2.5：存在性校验改走 assertActorUsable
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.addEditor('board-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });

    it('addEditor：已软删 agent → 4xx AGENT_NOT_FOUND + message 断言（统一批 A2.5）', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.addEditor('board-1', 'agent-deleted')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
      expect(memberRepo.create).not.toHaveBeenCalled();
      expect(memberRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('removeEditor', () => {
    it('deletes editor member and fires AGENT_LEFT event', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1',
        actorId: 'agent-1',
        role: BoardMemberRole.EDITOR,
      } as BoardMember);

      const result = await service.removeEditor('board-1', 'agent-1');

      expect(memberRepo.delete).toHaveBeenCalledWith({
        boardId: 'board-1',
        actorId: 'agent-1',
        role: BoardMemberRole.EDITOR,
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

    it('rejects removing the creator editor row (4b1ddd1c 守卫)', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } }); // creatorId='creator-1'
      boardRepo.findOne.mockResolvedValue(board);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1',
        actorId: 'creator-1',
        role: BoardMemberRole.EDITOR,
      } as BoardMember);

      await expect(service.removeEditor('board-1', 'creator-1')).rejects.toMatchObject({
        response: { code: ErrorCode.RESOURCE_CONFLICT },
      });
      // 守卫必须先于删行：成员行不被删除
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('throws AGENT_NOT_FOUND when agent does not exist', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } });
      boardRepo.findOne.mockResolvedValue(board);
      // 统一批 A2.5b：移除类入口回退 resourceValidator.exists（软删 agent 不拦）
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(service.removeEditor('board-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });

    it('removeEditor：已软删 agent → 放行（移除类入口不拦，A2.5b 修正）', async () => {
      const board = makeBoard({ settings: { visibility: Visibility.OPEN } }); // creatorId='creator-1'
      boardRepo.findOne.mockResolvedValue(board);
      // 软删 agent 的 agents 行永在 → resourceValidator.exists 放行（清理动作必须可用）
      resourceValidator.exists.mockResolvedValue({ id: 'agent-deleted' } as Agent);
      memberRepo.findOne.mockResolvedValue({
        boardId: 'board-1',
        actorId: 'agent-deleted',
        role: BoardMemberRole.EDITOR,
      } as BoardMember);

      await service.removeEditor('board-1', 'agent-deleted');

      expect(memberRepo.delete).toHaveBeenCalledWith({
        boardId: 'board-1',
        actorId: 'agent-deleted',
        role: BoardMemberRole.EDITOR,
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

  describe('getDigest', () => {
    // v1.41 项目总揽装配：board 详情口径 taskCount + lists/nextUp/risks/recentDone/milestones/docs
    const makeList = (overrides: Partial<any> = {}) => ({
      id: 'list-1',
      boardId: 'board-1',
      name: 'To Do',
      position: 1,
      color: null,
      mappedStatus: 'todo',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      deletedAt: null,
      ...overrides,
    });
    const makeTaskRow = (overrides: Partial<any> = {}) => ({
      id: 'task-1',
      title: 'Task 1',
      status: TaskStatus.TODO,
      priority: Priority.P1,
      listId: 'list-1',
      assigneeId: 'agent-1',
      labels: null,
      milestoneId: null,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      completedAt: null,
      ...overrides,
    });
    // v1.42 Release 里程碑构造器（version 非空 = release；deployedAt/verifiedAt 可空）
    const makeMilestone = (overrides: Partial<any> = {}) => ({
      id: 'rel-1',
      name: 'Release 1.0',
      status: 'dev',
      version: '1.0.0',
      deployedAt: null,
      verifiedAt: null,
      createdAt: new Date('2024-01-01'),
      startDate: null,
      targetDate: null,
      ...overrides,
    });

    // 通用装配 mock：taskRepo.find 按查询形状分发；createQueryBuilder 各方法各就各位
    const setupDigestMocks = (opts: {
      openTasks?: any[];
      doneRows?: any[];
      milestoneTasks?: any[];
      riskRows?: any[];
      listCounts?: any[];
      total?: string;
      completed?: string;
      milestones?: any[];
      space?: any;
      docs?: any[];
      // limit=0 时 COUNT 查询的返回值（缺省 = 对应 rows 数组长度，模拟真实 DB 计数）
      riskCount?: number;
      doneCount?: number;
      docsCount?: number;
    }) => {
      boardRepo.findOne.mockResolvedValue(
        makeBoard({ id: 'board-1', description: '## 项目图例\n\n由 PM 维护。' }),
      );
      listRepo.find.mockResolvedValue([makeList()] as unknown as BoardList[]);
      taskRepo.createQueryBuilder.mockImplementation(
        () =>
          ({
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            innerJoin: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            setParameter: jest.fn().mockReturnThis(),
            groupBy: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            addOrderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            getRawMany: jest.fn().mockResolvedValue(opts.listCounts ?? []),
            getRawOne: jest
              .fn()
              .mockResolvedValue({ total: opts.total ?? '0', completed: opts.completed ?? '0' }),
            getMany: jest.fn().mockResolvedValue(opts.riskRows ?? []),
            // limit=0 时 risks 段 COUNT（缺省 = riskRows 长度，与行查询同口径）
            getCount: jest.fn().mockResolvedValue(opts.riskCount ?? (opts.riskRows ?? []).length),
          }) as any,
      );
      taskRepo.find.mockImplementation(((query: any) => {
        if (query?.where?.milestoneId !== undefined) {
          return Promise.resolve(opts.milestoneTasks ?? []);
        }
        if (query?.where?.status === TaskStatus.DONE) {
          return Promise.resolve(opts.doneRows ?? []);
        }
        return Promise.resolve(opts.openTasks ?? []);
      }) as any);
      // limit=0 时 recentDone 段 COUNT（缺省 = doneRows 长度，与 find 同口径）
      taskRepo.count.mockResolvedValue(opts.doneCount ?? (opts.doneRows ?? []).length);
      milestoneRepo.find.mockResolvedValue(opts.milestones ?? []);
      docSpaceRepo.findOne.mockResolvedValue(opts.space ?? null);
      docRepo.createQueryBuilder.mockImplementation(
        () =>
          ({
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue(opts.docs ?? []),
            // limit=0 时 docs 段 COUNT（缺省 = docs 长度，与行查询同口径）
            getCount: jest.fn().mockResolvedValue(opts.docsCount ?? (opts.docs ?? []).length),
          }) as any,
      );
      // assignee 解析：agent-1 → Kimi
      actorRepo.find.mockResolvedValue([{ id: 'agent-1', type: ActorType.AGENT } as Actor]);
      agentRepo.find.mockResolvedValue([
        {
          id: 'agent-1',
          name: 'Kimi',
          avatarUrl: null,
          status: 'active',
          description: null,
        } as any,
      ]);
      userRepo.find.mockResolvedValue([]);
    };

    it('assembles all sections from live state (happy path)', async () => {
      setupDigestMocks({
        openTasks: [
          makeTaskRow({ id: 't1', title: 'Fix auth', priority: Priority.P0, labels: ['bug'] }),
          makeTaskRow({ id: 't2', title: 'Refactor', priority: Priority.P2 }),
        ],
        riskRows: [
          makeTaskRow({ id: 't1', title: 'Fix auth', priority: Priority.P0, labels: ['bug'] }),
        ],
        doneRows: [
          makeTaskRow({
            id: 't9',
            title: 'Ship digest',
            status: TaskStatus.DONE,
            completedAt: new Date('2024-01-05'),
          }),
          makeTaskRow({
            id: 't8',
            title: 'Ship overview',
            status: TaskStatus.DONE,
            completedAt: new Date('2024-01-04'),
          }),
        ],
        milestoneTasks: [
          makeTaskRow({ id: 't3', milestoneId: 'm1', status: TaskStatus.DONE }),
          makeTaskRow({ id: 't4', milestoneId: 'm1', status: TaskStatus.IN_PROGRESS }),
          makeTaskRow({ id: 't5', milestoneId: 'm1', status: TaskStatus.BACKLOG }),
        ],
        milestones: [
          {
            id: 'm1',
            name: 'v1.41',
            status: 'active',
            startDate: new Date('2024-01-01'),
            targetDate: new Date('2024-02-01'),
          },
        ],
        listCounts: [{ listId: 'list-1', count: '3' }],
        total: '8',
        completed: '2',
        space: {
          id: 'sp-1',
          name: 'Project Docs',
          description: '空间图例'.repeat(100),
        },
        docs: [
          { id: 'd2', path: 'docs/b.md', title: 'B', updatedAt: new Date('2024-01-02') },
          { id: 'd1', path: 'docs/a.md', title: 'A', updatedAt: new Date('2024-01-01') },
        ],
      });

      const result = await service.getDigest('board-1');

      expect(result.boardId).toBe('board-1');
      expect(result.boardName).toBe('Test Board');
      expect(result.description).toBe('## 项目图例\n\n由 PM 维护。');
      expect(result.visibility).toBe(Visibility.OPEN);
      // taskCount 口径 = board 详情（countTasksByBoard 返回值直通）
      expect(result.taskCount).toBe(8);
      expect(result.completedTaskCount).toBe(2);
      expect(result.lists).toEqual([
        { id: 'list-1', name: 'To Do', mappedStatus: 'todo', taskCount: 3 },
      ]);
      // priorityDistribution：open 任务内存聚合（含 0 值形状稳定；t1=P0、t2=P2）
      expect(result.priorityDistribution.open).toEqual({ p0: 1, p1: 0, p2: 1, p3: 0 });
      // nextUp：open 任务 priority 序 + assigneeName 解析（assigneeDeletedAt 未删为 null）
      expect(result.nextUp).toEqual([
        {
          id: 't1',
          title: 'Fix auth',
          priority: Priority.P0,
          status: TaskStatus.TODO,
          assigneeName: 'Kimi',
          assigneeDeletedAt: null,
        },
        {
          id: 't2',
          title: 'Refactor',
          priority: Priority.P2,
          status: TaskStatus.TODO,
          assigneeName: 'Kimi',
          assigneeDeletedAt: null,
        },
      ]);
      // risks：labels bug 命中；assigneeName 解析（assigneeDeletedAt 未删为 null）
      expect(result.risks).toEqual([
        {
          id: 't1',
          title: 'Fix auth',
          priority: Priority.P0,
          status: TaskStatus.TODO,
          labels: ['bug'],
          assigneeName: 'Kimi',
          assigneeDeletedAt: null,
        },
      ]);
      expect(result.recentDone).toHaveLength(2);
      expect(result.recentDone[0].completedAt).toEqual(new Date('2024-01-05'));
      // milestones：stats 口径对齐 milestone.service（done 含 archived）
      expect(result.milestones).toEqual([
        {
          id: 'm1',
          name: 'v1.41',
          status: 'active',
          startDate: expect.any(Date),
          targetDate: expect.any(Date),
          stats: { total: 3, done: 1, inProgress: 1, open: 1 },
        },
      ]);
      // docs：空间元数据 + 最近更新文档
      expect(result.docs).toEqual({
        spaceId: 'sp-1',
        spaceName: 'Project Docs',
        spaceDescriptionSnippet: expect.any(String),
        recentlyUpdated: [
          { path: 'docs/b.md', title: 'B', updatedAt: expect.any(Date) },
          { path: 'docs/a.md', title: 'A', updatedAt: expect.any(Date) },
        ],
      });
      expect(result.truncated).toBe(false);
    });

    it('queries open tasks with priority order and done tasks with completedAt desc', async () => {
      setupDigestMocks({
        openTasks: [makeTaskRow()],
        doneRows: [makeTaskRow({ status: TaskStatus.DONE, completedAt: new Date('2024-01-05') })],
        total: '1',
        completed: '1',
      });

      await service.getDigest('board-1');

      // open 查询：priority ASC（p0 在前）→ p1 → p2 → p3
      expect(taskRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: expect.objectContaining({
              _value: expect.any(Array),
            }),
          }),
          order: { priority: 'ASC', createdAt: 'ASC' },
        }),
      );
      // done 查询：completedAt DESC + take(doneLimit+1) 探针
      expect(taskRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: TaskStatus.DONE }),
          order: { completedAt: 'DESC', createdAt: 'DESC' },
          take: 6,
        }),
      );
      // done 查询：completedAt 非空过滤（Not(IsNull()) FindOperator）——PG DESC 默认 NULLS FIRST，
      // 存量 NULL 行会顶到 recentDone 最前（2026-08-05 产品锚点验收暴露，铁律 #17 契约化）
      const doneCall = (taskRepo.find as jest.Mock).mock.calls.find(
        (c) => c[0]?.where?.status === TaskStatus.DONE,
      );
      expect(doneCall[0].where.completedAt).toMatchObject({ _type: 'not' });
    });

    it('filters risks via PG && overlap and excludes done/archived', async () => {
      setupDigestMocks({ riskRows: [] });
      await service.getDigest('board-1');

      // 捕获 risks 查询链的 andWhere 调用，断言 SQL 语义
      const qb = (taskRepo.createQueryBuilder as jest.Mock).mock.results[2].value;
      const andWheres: any[] = [];
      for (const call of qb.andWhere.mock.calls) andWheres.push(call);
      expect(andWheres.some((c) => c[0].includes("labels && ARRAY['bug','debt']"))).toBe(true);
      expect(andWheres.some((c) => c[0].includes('status NOT IN'))).toBe(true);
    });

    it('limit=0 → 各段条目空数组但 xxxTotal 为真实全量计数（COUNT 兜底，不拉行）', async () => {
      setupDigestMocks({
        openTasks: [makeTaskRow()],
        doneRows: [makeTaskRow({ status: TaskStatus.DONE, completedAt: new Date('2024-01-05') })],
        riskRows: [makeTaskRow({ labels: ['bug'] })],
        total: '1',
        completed: '1',
        space: { id: 'sp-1', name: 'Docs', description: 'd' },
        docs: [{ id: 'd1', path: 'docs/a.md', title: 'A', updatedAt: new Date('2024-01-01') }],
      });

      const result = await service.getDigest('board-1', {
        openLimit: 0,
        doneLimit: 0,
        riskLimit: 0,
        docsLimit: 0,
      });

      expect(result.nextUp).toEqual([]);
      expect(result.recentDone).toEqual([]);
      expect(result.risks).toEqual([]);
      expect(result.docs).toEqual({
        spaceId: 'sp-1',
        spaceName: 'Docs',
        spaceDescriptionSnippet: 'd',
        recentlyUpdated: [],
      });
      expect(result.truncated).toBe(false);
      // 契约：limit=0 只空条目，total 恒为真实全量（调用方凭 total 决定是否再拉该段）
      expect(result.nextUpTotal).toBe(1);
      expect(result.risksTotal).toBe(1);
      expect(result.recentDoneTotal).toBe(1);
      expect(result.docsTotal).toBe(1);
      // 0 limit 不拉行：done 行查询（find）短路；docs 段只走 COUNT（getMany 不被调用）
      const findCalls = (taskRepo.find as jest.Mock).mock.calls;
      expect(findCalls.some((c) => c[0]?.where?.status === TaskStatus.DONE)).toBe(false);
      const docQb = (docRepo.createQueryBuilder as jest.Mock).mock.results[0].value;
      expect(docQb.getMany).not.toHaveBeenCalled();
      expect(docQb.getCount).toHaveBeenCalled();
    });

    it('limit=0 → xxxTotal 为真实全量（多行数据：条目空 + total 不缩水）', async () => {
      const openTasks = Array.from({ length: 11 }, (_, i) =>
        makeTaskRow({ id: `t${i}`, title: `Task ${i}`, priority: Priority.P2 }),
      );
      const riskRows = Array.from({ length: 6 }, (_, i) =>
        makeTaskRow({ id: `r${i}`, title: `Risk ${i}`, priority: Priority.P2, labels: ['bug'] }),
      );
      const doneRows = Array.from({ length: 4 }, (_, i) =>
        makeTaskRow({
          id: `d${i}`,
          title: `Done ${i}`,
          status: TaskStatus.DONE,
          completedAt: new Date(`2024-01-0${i + 1}`),
        }),
      );
      const docs = Array.from({ length: 4 }, (_, i) => ({
        id: `doc-${i}`,
        path: `docs/${i}.md`,
        title: `Doc ${i}`,
        updatedAt: new Date(`2024-01-0${i + 1}`),
      }));
      setupDigestMocks({
        openTasks,
        riskRows,
        doneRows,
        space: { id: 'sp-1', name: 'Docs', description: 'd' },
        docs,
      });

      const result = await service.getDigest('board-1', {
        openLimit: 0,
        doneLimit: 0,
        riskLimit: 0,
        docsLimit: 0,
      });

      expect(result.nextUp).toEqual([]);
      expect(result.risks).toEqual([]);
      expect(result.recentDone).toEqual([]);
      expect(result.docs!.recentlyUpdated).toEqual([]);
      // 全量计数不受 limit=0 影响（契约漏洞回归：短路空数组曾令 total 假报 0）
      expect(result.nextUpTotal).toBe(11);
      expect(result.risksTotal).toBe(6);
      expect(result.recentDoneTotal).toBe(4);
      expect(result.docsTotal).toBe(4);
      expect(result.truncated).toBe(false);
    });

    it('marks truncated when nextUp exceeds openLimit', async () => {
      const openTasks = Array.from({ length: 11 }, (_, i) =>
        makeTaskRow({ id: `t${i}`, title: `Task ${i}`, priority: Priority.P2 }),
      );
      setupDigestMocks({ openTasks });

      const result = await service.getDigest('board-1', { openLimit: 10 });

      expect(result.nextUp).toHaveLength(10);
      // 截断元数据：nextUpTotal 恒为全量计数（截断判断用 nextUpTotal > nextUp.length）
      expect(result.nextUpTotal).toBe(11);
      expect(result.truncated).toBe(true);
    });

    it('risks 截断 → risksTruncated + risksTotal 全量计数（截断元数据）', async () => {
      const riskRows = Array.from({ length: 6 }, (_, i) =>
        makeTaskRow({ id: `r${i}`, title: `Risk ${i}`, priority: Priority.P2, labels: ['bug'] }),
      );
      setupDigestMocks({ riskRows });

      const result = await service.getDigest('board-1', { riskLimit: 5 });

      expect(result.risks).toHaveLength(5);
      // riskRows 探针 +1：全量 6 条，返回 5 条
      expect(result.risksTotal).toBe(6);
      expect(result.truncated).toBe(true);
    });

    it('risks: actual > limit+1（探针截顶）→ 追加 COUNT，risksTotal 精确全量（不随探针截顶）', async () => {
      // 探针 take(limit+1) 只返回 11 行，但真实风险 50 条——total 必须为 50 而非 11
      const riskRows = Array.from({ length: 11 }, (_, i) =>
        makeTaskRow({ id: `r${i}`, title: `Risk ${i}`, priority: Priority.P2, labels: ['bug'] }),
      );
      setupDigestMocks({ riskRows, riskCount: 50 });

      const result = await service.getDigest('board-1', { riskLimit: 10 });

      expect(result.risks).toHaveLength(10);
      expect(result.risksTotal).toBe(50);
      expect(result.truncated).toBe(true);
    });

    it('recentDone 截断 → recentDoneTruncated + recentDoneTotal 全量计数（截断元数据）', async () => {
      const doneRows = Array.from({ length: 4 }, (_, i) =>
        makeTaskRow({
          id: `d${i}`,
          title: `Done ${i}`,
          status: TaskStatus.DONE,
          completedAt: new Date(`2024-01-0${i + 1}`),
        }),
      );
      setupDigestMocks({ doneRows });

      const result = await service.getDigest('board-1', { doneLimit: 3 });

      expect(result.recentDone).toHaveLength(3);
      // doneRows 探针 +1：全量 4 条，返回 3 条
      expect(result.recentDoneTotal).toBe(4);
      expect(result.truncated).toBe(true);
    });

    it('recentDone: actual > limit+1（探针截顶）→ 追加 COUNT，recentDoneTotal 精确全量', async () => {
      // 探针 take(limit+1) 只返回 11 行，但真实 done 50 条——total 必须为 50 而非 11
      const doneRows = Array.from({ length: 11 }, (_, i) =>
        makeTaskRow({
          id: `d${i}`,
          title: `Done ${i}`,
          status: TaskStatus.DONE,
          completedAt: new Date(`2024-01-${String(i + 1).padStart(2, '0')}`),
        }),
      );
      setupDigestMocks({ doneRows, doneCount: 50 });

      const result = await service.getDigest('board-1', { doneLimit: 10 });

      expect(result.recentDone).toHaveLength(10);
      expect(result.recentDoneTotal).toBe(50);
      expect(result.truncated).toBe(true);
    });

    it('docs 截断 → docsTruncated + docsTotal 全量计数（截断元数据）', async () => {
      const docs = Array.from({ length: 4 }, (_, i) => ({
        id: `doc-${i}`,
        path: `docs/${i}.md`,
        title: `Doc ${i}`,
        updatedAt: new Date(`2024-01-0${i + 1}`),
      }));
      setupDigestMocks({ space: { id: 'sp-1', name: 'Docs', description: 'd' }, docs });

      const result = await service.getDigest('board-1', { docsLimit: 3 });

      expect(result.docs!.recentlyUpdated).toHaveLength(3);
      // docs 探针 +1：全量 4 条，返回 3 条
      expect(result.docsTotal).toBe(4);
      expect(result.truncated).toBe(true);
    });

    it('docs: actual > limit+1（探针截顶）→ 追加 COUNT，docsTotal 精确全量', async () => {
      // 探针 take(limit+1) 只返回 11 条，但真实文档 50 条——total 必须为 50 而非 11
      const docs = Array.from({ length: 11 }, (_, i) => ({
        id: `doc-${i}`,
        path: `docs/${i}.md`,
        title: `Doc ${i}`,
        updatedAt: new Date(`2024-01-${String(i + 1).padStart(2, '0')}`),
      }));
      setupDigestMocks({
        space: { id: 'sp-1', name: 'Docs', description: 'd' },
        docs,
        docsCount: 50,
      });

      const result = await service.getDigest('board-1', { docsLimit: 10 });

      expect(result.docs!.recentlyUpdated).toHaveLength(10);
      expect(result.docsTotal).toBe(50);
      expect(result.truncated).toBe(true);
    });

    it('docs 无绑定空间 → docsTotal 缺省（docs 段不存在，元数据同步缺省）', async () => {
      setupDigestMocks({ space: null });

      const result = await service.getDigest('board-1');

      expect(result.docs).toBeNull();
      expect(result.docsTotal).toBeUndefined();
      expect(result.truncated).toBe(false);
    });

    it('returns null description when board has no description', async () => {
      setupDigestMocks({});
      boardRepo.findOne.mockResolvedValue(makeBoard({ id: 'board-1', description: null }));

      const result = await service.getDigest('board-1');

      expect(result.description).toBeNull();
    });

    it('returns null description when includeDescription=false (legend omitted)', async () => {
      setupDigestMocks({});

      const result = await service.getDigest('board-1', { includeDescription: false });

      expect(result.description).toBeNull();
    });

    it('returns docs: null when board has no bound DocSpace', async () => {
      setupDigestMocks({ space: null });

      const result = await service.getDigest('board-1');

      expect(result.docs).toBeNull();
      expect(result.truncated).toBe(false);
    });

    // ── v1.42 versions 版本区：三区口径 + 截断 + 零新查询（内存装配） ──
    it('versions: 无 release（version 全空）→ production/development null + history [] + total 0', async () => {
      setupDigestMocks({
        milestones: [
          { id: 'm1', name: 'v1.41', status: 'active', createdAt: new Date('2024-01-01') },
        ],
      });

      const result = await service.getDigest('board-1');

      expect(result.versions).toEqual({
        production: null,
        development: null,
        history: [],
        total: 0,
      });
      expect(result.truncated).toBe(false);
    });

    it('versions: 仅 dev release → development 命中、production null、history 含该行', async () => {
      setupDigestMocks({
        milestones: [
          makeMilestone({
            id: 'r1',
            name: 'v1.42',
            version: '1.42.0',
            status: 'dev',
            createdAt: new Date('2024-02-01'),
          }),
        ],
      });

      const result = await service.getDigest('board-1');

      expect(result.versions.production).toBeNull();
      expect(result.versions.development).toMatchObject({
        id: 'r1',
        version: '1.42.0',
        status: 'dev',
      });
      expect(result.versions.history).toHaveLength(1);
      expect(result.versions.history[0].version).toBe('1.42.0');
      expect(result.versions.total).toBe(1);
    });

    it('versions: 仅 deployed release → production 命中、development null', async () => {
      setupDigestMocks({
        milestones: [
          makeMilestone({
            id: 'r1',
            name: 'v1.40',
            version: '1.40.0',
            status: 'deployed',
            deployedAt: new Date('2024-01-01'),
            createdAt: new Date('2024-01-01'),
          }),
        ],
      });

      const result = await service.getDigest('board-1');

      expect(result.versions.production).toMatchObject({
        id: 'r1',
        version: '1.40.0',
        status: 'deployed',
      });
      expect(result.versions.development).toBeNull();
      expect(result.versions.total).toBe(1);
    });

    it('versions: 混合排序 deployedAt DESC NULLS LAST + createdAt DESC（未部署 release 沉底）', async () => {
      setupDigestMocks({
        milestones: [
          makeMilestone({
            id: 'r1',
            version: '1.0.0',
            status: 'deployed',
            deployedAt: new Date('2024-03-01'),
            createdAt: new Date('2024-01-01'),
          }),
          makeMilestone({
            id: 'r2',
            version: '1.1.0',
            status: 'ready',
            deployedAt: null,
            createdAt: new Date('2024-02-01'),
          }),
          makeMilestone({
            id: 'r3',
            version: '1.0.1',
            status: 'verified',
            deployedAt: new Date('2024-02-01'),
            createdAt: new Date('2024-01-15'),
          }),
          makeMilestone({
            id: 'r4',
            version: '1.2.0',
            status: 'dev',
            deployedAt: null,
            createdAt: new Date('2024-03-01'),
          }),
        ],
      });

      const result = await service.getDigest('board-1');

      // production = deployed/verified 中 deployedAt 最新（r1）；verified 也是 production 候选（r3）
      expect(result.versions.production?.id).toBe('r1');
      // development = dev/ready 中 createdAt 最新（r4 > r2）
      expect(result.versions.development?.id).toBe('r4');
      // history：有 deployedAt 的按 DESC 在前（r1→r3），NULL deployedAt 沉底按 createdAt DESC（r4→r2）
      expect(result.versions.history.map((h) => h.id)).toEqual(['r1', 'r3', 'r4', 'r2']);
      expect(result.versions.total).toBe(4);
    });

    it('versions: versionLimit 截断 → history 截断 + total 全量 + truncated=true', async () => {
      const releases = Array.from({ length: 7 }, (_, i) =>
        makeMilestone({
          id: `rel-${i}`,
          version: `1.${i}.0`,
          status: 'deployed',
          deployedAt: new Date(`2024-01-${String(i + 1).padStart(2, '0')}`),
          createdAt: new Date(`2024-01-${String(i + 1).padStart(2, '0')}`),
        }),
      );
      setupDigestMocks({ milestones: releases });

      const result = await service.getDigest('board-1', { versionLimit: 2 });

      expect(result.versions.history).toHaveLength(2);
      // deployedAt 最新（rel-6 = 1.6.0）排最前；production 同口径
      expect(result.versions.history[0].version).toBe('1.6.0');
      expect(result.versions.production?.version).toBe('1.6.0');
      expect(result.versions.total).toBe(7);
      expect(result.truncated).toBe(true);
    });

    it('versions: versionLimit=0 → history 空数组但不截断（对齐 limit=0 显式空段惯例）', async () => {
      setupDigestMocks({
        milestones: [
          makeMilestone({
            id: 'r1',
            version: '1.0.0',
            status: 'deployed',
            deployedAt: new Date('2024-01-01'),
          }),
        ],
      });

      const result = await service.getDigest('board-1', { versionLimit: 0 });

      expect(result.versions.history).toEqual([]);
      expect(result.versions.total).toBe(1);
      expect(result.truncated).toBe(false);
    });

    it('versions/milestones: release 里程碑投影 version/deployedAt/verifiedAt 且不含 body/deployMeta', async () => {
      setupDigestMocks({
        milestones: [
          makeMilestone({
            id: 'm1',
            name: 'v1.42',
            version: '1.42.0',
            status: 'verified',
            deployedAt: new Date('2024-01-01'),
            verifiedAt: new Date('2024-01-02'),
            body: 'should-not-leak',
            deployMeta: { anchors: ['health-ok'] },
            createdAt: new Date('2024-01-01'),
          }),
        ],
      });

      const result = await service.getDigest('board-1');

      const m = result.milestones[0];
      expect(m.version).toBe('1.42.0');
      expect(m.deployedAt).toEqual(new Date('2024-01-01'));
      expect(m.verifiedAt).toEqual(new Date('2024-01-02'));
      expect('body' in m).toBe(false);
      expect('deployMeta' in m).toBe(false);
      const v = result.versions.production;
      expect(v?.version).toBe('1.42.0');
      expect(v?.deployedAt).toEqual(new Date('2024-01-01'));
      expect('body' in (v as any)).toBe(false);
      expect('deployMeta' in (v as any)).toBe(false);
    });

    // ── v1.42 metrics：settings.metrics 透传不加工（report-metrics.mjs 上报的机器事实） ──
    it('metrics: settings 无 metrics → null', async () => {
      setupDigestMocks({});

      const result = await service.getDigest('board-1');

      expect(result.metrics).toBeNull();
    });

    it('metrics: settings.metrics 存在 → 透传原样（含任意嵌套结构）', async () => {
      setupDigestMocks({});
      boardRepo.findOne.mockResolvedValue(
        makeBoard({
          id: 'board-1',
          description: null,
          settings: {
            visibility: Visibility.OPEN,
            metrics: {
              testBaseline: { backend: { suites: 75, tests: 1214 }, e2e: { suites: 6, tests: 75 } },
              mcpTools: { worker: 44, full: 146 },
              updatedAt: '2026-08-05T00:00:00.000Z',
            },
          },
        }),
      );

      const result = await service.getDigest('board-1');

      expect(result.metrics).toEqual({
        testBaseline: { backend: { suites: 75, tests: 1214 }, e2e: { suites: 6, tests: 75 } },
        mcpTools: { worker: 44, full: 146 },
        updatedAt: '2026-08-05T00:00:00.000Z',
      });
    });

    it('throws 404 when board does not exist', async () => {
      boardRepo.findOne.mockResolvedValue(null);

      await expect(service.getDigest('board-404')).rejects.toThrow(NotFoundException);
    });

    // ── v1.44.0-dev roundtable 段：圆桌平台级指标（M2 阶段 7，实时装配，永远输出） ──
    // 口径（主 Agent 拍板，铁律 #20）：topic/seat/message 均不隶属于 board——本段统计
    // 全平台；座位消息 = messages.metadata.seatLabel 非空；silentCount/valveTripCount 从
    // seat.state JS 内存求和；silentRate 分母 = ΣsilentCount + 全时段座位消息数（非 7 天窗口）
    it('roundtable: 零态（无任何圆桌 topic/座位/座位消息）→ 全零且永远输出该段', async () => {
      setupDigestMocks({});
      // beforeEach 默认 mock 即零态：topicRepo.count→0 / seatRepo.count→0 /
      // seatRepo.find→[] / messageRepo getCount→0

      const result = await service.getDigest('board-1');

      // 形状可预测：key 恒存在（不返回 undefined），五值全零
      expect(result.roundtable).toEqual({
        topicCount: 0,
        seatCount: 0,
        dailyRounds: 0,
        silentRate: 0,
        valveTripCount: 0,
      });
    });

    it('roundtable: 填充态五值口径正确（全平台计数 / 7 天窗口 / silentRate 分母）', async () => {
      setupDigestMocks({});
      // 全平台计数：kind='roundtable' topic 3 个、active 座位 4 个
      topicRepo.count.mockResolvedValue(3);
      seatRepo.count.mockResolvedValue(4);
      // 座位 state 求和：silentCount 5+3+0=8；valveTripCount 2+0+0=2（缺省键 ?? 0）
      seatRepo.find.mockResolvedValue([
        { id: 's1', state: { silentCount: 5, valveTripCount: 2 } },
        { id: 's2', state: { silentCount: 3 } },
        { id: 's3', state: {} },
      ] as any);
      // 座位消息计数：第一次 getCount = 全时段（silentRate 分母）100，第二次 = 7 天窗口 70
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn(),
      };
      messageRepo.createQueryBuilder.mockReturnValue(qb as any);
      qb.getCount.mockResolvedValueOnce(100).mockResolvedValueOnce(70);

      const result = await service.getDigest('board-1');

      expect(result.roundtable.topicCount).toBe(3);
      expect(result.roundtable.seatCount).toBe(4);
      // dailyRounds = 70 ÷ 7 = 10，两位小数
      expect(result.roundtable.dailyRounds).toBe(10);
      // silentRate = 8 ÷ (8 + 100)，分母含全时段座位消息数
      expect(result.roundtable.silentRate).toBeCloseTo(8 / 108, 10);
      expect(result.roundtable.valveTripCount).toBe(2);

      // 座位消息判定 SQL：metadata->>'seatLabel' 非空（两处查询同款条件）
      expect(qb.where).toHaveBeenCalledWith("m.metadata ->> 'seatLabel' IS NOT NULL");
      expect(qb.andWhere).toHaveBeenCalledWith("m.metadata ->> 'seatLabel' <> ''");
      // 7 天窗口边界：cutoff ≈ 当前时刻前 7×24h（±60s 容差）
      const cutoffCall = qb.andWhere.mock.calls.find(
        (c: unknown[]) => c[0] === 'm.createdAt >= :cutoff',
      );
      expect(cutoffCall).toBeTruthy();
      const cutoff = (cutoffCall as unknown[])[1] as { cutoff: Date };
      expect(
        Math.abs(cutoff.cutoff.getTime() - (Date.now() - 7 * 24 * 60 * 60 * 1000)),
      ).toBeLessThan(60_000);
      // dailyRounds 两位小数精度：70÷7 之外的边界（如 35 ÷ 7 = 5 不产生小数，用 34/7 验证四舍五入）
    });

    it('roundtable: dailyRounds 除法保留两位小数（34 ÷ 7 = 4.857… → 4.86）', async () => {
      setupDigestMocks({});
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn(),
      };
      messageRepo.createQueryBuilder.mockReturnValue(qb as any);
      qb.getCount.mockResolvedValueOnce(0).mockResolvedValueOnce(34);

      const result = await service.getDigest('board-1');

      expect(result.roundtable.dailyRounds).toBe(4.86);
    });

    it('roundtable: silentRate 分母为 0（ΣsilentCount=0 且无座位消息）→ 0 防除零', async () => {
      setupDigestMocks({});
      // 座位存在但 silentCount 缺省 0；无任何座位消息 → 分母 0，禁止 NaN/Infinity
      seatRepo.find.mockResolvedValue([{ id: 's1', state: { valveTripCount: 1 } }] as any);

      const result = await service.getDigest('board-1');

      expect(result.roundtable.silentRate).toBe(0);
      // 分母为 0 不影响其他计数
      expect(result.roundtable.valveTripCount).toBe(1);
    });

    it('roundtable: seatCount 只数 active 座位（status 过滤传递到 repo.count）', async () => {
      setupDigestMocks({});
      seatRepo.count.mockResolvedValue(2);
      // 断言 service 以 status='active' 作为计数条件（active/paused/parked/offline 四态中只数启用座）
      await service.getDigest('board-1');
      expect(seatRepo.count).toHaveBeenCalledWith({ where: { status: 'active' } });
    });
  });

  describe('updateMetrics (v1.42: PUT /boards/:id/metrics 原子 jsonb_set)', () => {
    // 返回的 settings 预置既有键（visibility/archived_lists_visible）——jsonb_set 语义下
    // 这些键由 SQL 保证不被覆盖；service 只透传 RETURNING 的 settings.metrics
    const storedSettings = {
      visibility: 'private',
      archived_lists_visible: true,
      metrics: { testBaseline: { backend: { suites: 76, tests: 1229 } } },
    };

    it('executes single atomic jsonb_set SQL and returns settings.metrics', async () => {
      boardRepo.query.mockResolvedValue([{ settings: storedSettings }]);

      const metrics = { testBaseline: { backend: { suites: 76, tests: 1229 } } };
      const result = await service.updateMetrics('board-1', metrics);

      expect(result).toEqual({ metrics: metrics });
      // 单条原子 SQL：jsonb_set 只动 metrics 键（$1::jsonb），id 定位（$2），RETURNING 免重查
      expect(boardRepo.query).toHaveBeenCalledTimes(1);
      const [sql, params] = boardRepo.query.mock.calls[0];
      expect(sql).toContain(`jsonb_set(settings, '{metrics}', $1::jsonb)`);
      expect(sql).toContain('WHERE id = $2');
      expect(sql).toContain('RETURNING settings');
      expect(params).toEqual([JSON.stringify(metrics), 'board-1']);
    });

    it('overwrites metrics key while preserving pre-existing settings keys (merge semantics)', async () => {
      boardRepo.query.mockResolvedValue([
        { settings: { ...storedSettings, metrics: { newBaseline: { suites: 1 } } } },
      ]);

      const result = await service.updateMetrics('board-1', { newBaseline: { suites: 1 } });

      // 断言 RETURNING 的 settings 完整包含既有键 + 新 metrics（jsonb_set 的合并结果）
      expect(result.metrics).toEqual({ newBaseline: { suites: 1 } });
      const [sql] = boardRepo.query.mock.calls[0];
      // 只动 metrics 键：SQL 不含 visibility/archived_lists_visible 的整对象覆盖
      expect(sql).not.toContain('archived_lists_visible');
      expect(sql).not.toContain('visibility');
    });

    it('throws BOARD_NOT_FOUND when no row affected (TOCTOU 兜底, 铁律 #22)', async () => {
      boardRepo.query.mockResolvedValue([]);

      await expect(service.updateMetrics('board-gone', {})).rejects.toMatchObject({
        message: 'Board not found',
        response: expect.objectContaining({ code: ErrorCode.BOARD_NOT_FOUND }),
      });
    });
  });
});
