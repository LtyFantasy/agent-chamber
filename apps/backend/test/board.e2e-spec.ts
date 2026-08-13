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

describe('BoardController (e2e)', () => {
  let app: INestApplication;
  let mockRepos: Record<string, any>;
  let authToken: string;

  const boardId = '00000000-0000-0000-0000-000000000001';
  const listId = '00000000-0000-0000-0000-000000000010';
  const actorId = '00000000-0000-0000-0000-000000000005';

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

  const makeBoard = (lists: any[] = []) => ({
    id: boardId,
    name: 'Test Board',
    topicId: null,
    creatorId: actorId,
    creatorType: 'human',
    settings: { visibility: 'open' },
    lists,
  });

  const makeList = (overrides: Partial<any> = {}) => ({
    id: listId,
    boardId,
    name: 'To Do',
    position: 1,
    color: null,
    mappedStatus: 'todo',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    ...overrides,
  });

  const makeTask = (overrides: Partial<any> = {}) => ({
    id: '00000000-0000-0000-0000-000000000020',
    title: 'Test Task',
    status: TaskStatus.TODO,
    priority: 'p1',
    assigneeId: null,
    assigneeType: null,
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

  const mockAccessQueryBuilder = () => {
    mockRepos.Board.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ id: boardId }]),
    });
  };

  it('GET /boards/:id/lists returns list metadata without tasks', async () => {
    mockRepos.Board.findOne.mockResolvedValue(makeBoard([makeList()]));
    mockRepos.BoardList.find.mockResolvedValue([makeList()]);
    mockRepos.Task.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ listId, count: '2' }]),
    });

    return request(app.getHttpServer())
      .get(`/boards/${boardId}/lists`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).toHaveProperty('id', listId);
        expect(res.body.data[0]).toHaveProperty('taskCount', 2);
        expect(res.body.data[0]).not.toHaveProperty('tasks');
        expect(res.body.data[0]).not.toHaveProperty('description');
      });
  });

  it('GET /boards/:id/lists/:listId/tasks defaults to backlog and in_progress', async () => {
    const activeTask = makeTask({ id: 'task-active', status: TaskStatus.BACKLOG });
    const doneTask = makeTask({ id: 'task-done', status: TaskStatus.DONE });

    mockRepos.Board.findOne.mockResolvedValue(makeBoard([makeList()]));
    mockRepos.BoardList.findOne.mockResolvedValue(makeList());
    mockAccessQueryBuilder();
    mockRepos.Task.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[activeTask], 1]),
    });

    return request(app.getHttpServer())
      .get(`/boards/${boardId}/lists/${listId}/tasks`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.items[0]).toHaveProperty('id', 'task-active');
        expect(res.body.data.items[0]).toHaveProperty('status', TaskStatus.BACKLOG);
      });
  });

  it('GET /boards/:id/lists/:listId/tasks?status=all returns all tasks', async () => {
    const activeTask = makeTask({ id: 'task-active', status: TaskStatus.TODO });
    const doneTask = makeTask({ id: 'task-done', status: TaskStatus.DONE });

    mockRepos.Board.findOne.mockResolvedValue(makeBoard([makeList()]));
    mockRepos.BoardList.findOne.mockResolvedValue(makeList());
    mockAccessQueryBuilder();
    mockRepos.Task.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[activeTask, doneTask], 2]),
    });

    return request(app.getHttpServer())
      .get(`/boards/${boardId}/lists/${listId}/tasks?status=all`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data.items).toHaveLength(2);
        expect(res.body.data.total).toBe(2);
      });
  });

  it('GET /boards/:id/lists/:listId/tasks returns 404 when list belongs to another board', async () => {
    mockRepos.Board.findOne.mockResolvedValue(makeBoard([makeList()]));
    mockRepos.BoardList.findOne.mockResolvedValue(
      makeList({
        id: '00000000-0000-0000-0000-000000000099',
        boardId: '00000000-0000-4000-8000-000000000002',
      }),
    );

    return request(app.getHttpServer())
      .get(`/boards/${boardId}/lists/00000000-0000-0000-0000-000000000099/tasks`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.LIST_NOT_FOUND);
      });
  });

  it('GET /boards/:id no longer returns lists.tasks', async () => {
    mockRepos.Board.findOne.mockResolvedValue(makeBoard([makeList()]));
    mockRepos.BoardList.find.mockResolvedValue([makeList()]);
    mockRepos.Task.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ listId, count: '0' }]),
      getRawOne: jest.fn().mockResolvedValue({ total: '0', completed: '0' }),
    });

    return request(app.getHttpServer())
      .get(`/boards/${boardId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data.lists).toHaveLength(1);
        expect(res.body.data.lists[0]).toHaveProperty('taskCount', 0);
        expect(res.body.data.lists[0]).not.toHaveProperty('tasks');
      });
  });

  // ==================== v1.37 owner 代理权限（agent 创建 → owner 人类全通） ====================

  const agentCreatorId = '00000000-0000-0000-0000-0000000000bb';

  const makeAgentPrivateBoard = () => ({
    id: boardId,
    name: 'Agent Private Board',
    topicId: null,
    creatorId: agentCreatorId,
    creatorType: 'agent',
    settings: { visibility: 'private' },
    lists: [],
  });

  it('GET /boards/:id - owner human can read agent-created private board (owner proxy)', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(true);
    mockRepos.Board.findOne.mockResolvedValue(makeAgentPrivateBoard());
    mockRepos.BoardList.find.mockResolvedValue([]);
    mockRepos.Task.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue({ total: '0', completed: '0' }),
    });

    return request(app.getHttpServer())
      .get(`/boards/${boardId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('creatorId', agentCreatorId);
        // owner 代理命中：确认查了 agents 表（dummy guard 注入的 actor id 为 4000-8000 版本）
        expect(mockRepos.Agent.exists).toHaveBeenCalledWith({
          where: { id: agentCreatorId, ownerId: '00000000-0000-4000-8000-000000000005' },
        });
      });
  });

  it('GET /boards/:id - non-owner human gets 404 for agent-created private board', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);
    mockRepos.Board.findOne.mockResolvedValue(makeAgentPrivateBoard());

    return request(app.getHttpServer())
      .get(`/boards/${boardId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.BOARD_NOT_FOUND);
      });
  });

  it('PATCH /boards/:id - owner human can update agent-created board (owner proxy, full fields)', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(true);
    mockRepos.Board.findOne.mockResolvedValue(makeAgentPrivateBoard());
    mockRepos.Board.save.mockResolvedValue({
      ...makeAgentPrivateBoard(),
      name: 'Renamed By Owner',
      settings: { visibility: 'open' },
    });

    return request(app.getHttpServer())
      .patch(`/boards/${boardId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Renamed By Owner', visibility: 'open' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('name', 'Renamed By Owner');
      });
  });

  // ==================== v1.41 Board Digest（GET /boards/:id/digest） ====================

  const makeDigestMocks = (opts: {
    openTasks?: any[];
    doneRows?: any[];
    milestoneTasks?: any[];
    riskRows?: any[];
    total?: string;
    completed?: string;
    space?: any;
    docs?: any[];
  }) => {
    mockRepos.Board.findOne.mockResolvedValue(
      makeBoard([makeList()]), // findById 返回含 lists；digest 用 listRepo 重查列
    );
    mockRepos.BoardList.find.mockResolvedValue([makeList()]);
    // taskRepo.createQueryBuilder 被 3 次复用：列计数(getRawMany) / countTasksByBoard(getRawOne) / risks(getMany)
    mockRepos.Task.createQueryBuilder.mockReturnValue({
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
      getRawMany: jest.fn().mockResolvedValue([{ listId, count: '3' }]),
      getRawOne: jest
        .fn()
        .mockResolvedValue({ total: opts.total ?? '0', completed: opts.completed ?? '0' }),
      getMany: jest.fn().mockResolvedValue(opts.riskRows ?? []),
    });
    // taskRepo.find 按查询形状分发：milestone stats / done / open
    mockRepos.Task.find.mockImplementation((query: any) => {
      if (query?.where?.milestoneId !== undefined) {
        return Promise.resolve(opts.milestoneTasks ?? []);
      }
      if (query?.where?.status === TaskStatus.DONE) {
        return Promise.resolve(opts.doneRows ?? []);
      }
      return Promise.resolve(opts.openTasks ?? []);
    });
    mockRepos.Milestone.find.mockResolvedValue([]);
    mockRepos.DocSpace.findOne.mockResolvedValue(opts.space ?? null);
    mockRepos.Doc.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(opts.docs ?? []),
    });
    // assignee 解析（无 assignee 时不需要 profiles）
    mockRepos.Actor.find.mockResolvedValue([]);
    mockRepos.User.find.mockResolvedValue([]);
    mockRepos.Agent.find.mockResolvedValue([]);
  };

  it('GET /boards/:id/digest returns assembled project overview (v1.41)', async () => {
    makeDigestMocks({
      openTasks: [
        makeTask({
          id: 't1',
          title: 'Fix auth',
          status: TaskStatus.TODO,
          priority: 'p0',
          labels: ['bug'],
        }),
        makeTask({ id: 't2', title: 'Refactor', status: TaskStatus.IN_PROGRESS, priority: 'p2' }),
      ],
      riskRows: [
        makeTask({
          id: 't1',
          title: 'Fix auth',
          status: TaskStatus.TODO,
          priority: 'p0',
          labels: ['bug'],
        }),
      ],
      doneRows: [
        makeTask({
          id: 't9',
          title: 'Ship digest',
          status: TaskStatus.DONE,
          completedAt: new Date('2024-01-05'),
        }),
      ],
      total: '5',
      completed: '1',
      space: {
        id: '00000000-0000-0000-0000-0000000000aa',
        name: 'Project Docs',
        description: '空间图例',
      },
      docs: [{ id: 'd1', path: 'docs/a.md', title: 'A', updatedAt: new Date('2024-01-02') }],
    });

    return request(app.getHttpServer())
      .get(`/boards/${boardId}/digest`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        const data = res.body.data;
        expect(data.boardId).toBe(boardId);
        expect(data.boardName).toBe('Test Board');
        // taskCount 口径 = board 详情（countTasksByBoard 返回值直通）
        expect(data.taskCount).toBe(5);
        expect(data.completedTaskCount).toBe(1);
        expect(data.lists).toEqual([
          { id: listId, name: 'To Do', mappedStatus: 'todo', taskCount: 3 },
        ]);
        // priorityDistribution：open 任务内存聚合
        expect(data.priorityDistribution.open).toEqual({ p0: 1, p1: 0, p2: 1, p3: 0 });
        expect(data.nextUp).toHaveLength(2);
        // risks：labels bug 命中，剔除 done/archived
        expect(data.risks).toHaveLength(1);
        expect(data.risks[0]).toHaveProperty('labels', ['bug']);
        expect(data.recentDone).toHaveLength(1);
        expect(data.recentDone[0]).toHaveProperty('completedAt');
        // docs：绑定空间元数据 + 最近更新文档
        expect(data.docs).toMatchObject({
          spaceName: 'Project Docs',
          recentlyUpdated: [{ path: 'docs/a.md', title: 'A' }],
        });
        expect(data.truncated).toBe(false);
      });
  });

  it('GET /boards/:id/digest?includeDescription=false omits legend', async () => {
    makeDigestMocks({ openTasks: [], doneRows: [], total: '0', completed: '0' });

    return request(app.getHttpServer())
      .get(`/boards/${boardId}/digest?includeDescription=false`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.description).toBeNull();
        expect(res.body.data.docs).toBeNull(); // 无绑定空间
      });
  });

  it('GET /boards/:id/digest - 404 when board does not exist', async () => {
    mockRepos.Board.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get(`/boards/${boardId}/digest`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.BOARD_NOT_FOUND);
      });
  });

  it('GET /boards/:id/digest - non-member gets 404 for private board (read permission reuse)', async () => {
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);
    mockRepos.Board.findOne.mockResolvedValue(makeAgentPrivateBoard());

    return request(app.getHttpServer())
      .get(`/boards/${boardId}/digest`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.BOARD_NOT_FOUND);
      });
  });

  it('GET /boards/:id/digest?openLimit=abc - 400（DTO 校验失败）', async () => {
    return request(app.getHttpServer())
      .get(`/boards/${boardId}/digest?openLimit=abc`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
      });
  });

  // ==================== v1.46 TOPIC-PERM：PATCH /boards 结构字段显式 403 ====================

  const otherCreatorBoard = () => ({
    ...makeBoard(),
    creatorId: '00000000-0000-0000-0000-000000000009', // 非当前用户
  });

  it('PATCH /boards/:id - editor PATCH topicId → 403，消息列出结构字段名（不再 200 装傻）', async () => {
    mockRepos.Board.findOne.mockResolvedValue(otherCreatorBoard());
    // editor 成员身份：board_members 行 role=editor（BoardPolicy write 放行后仍须 D6 收口）
    mockRepos.BoardMember.findOne.mockResolvedValue({ boardId, actorId, role: 'editor' });
    // D6 结构字段路径走 isCreatorOf → owner 代理查询（非 owner → false）
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);

    return request(app.getHttpServer())
      .patch(`/boards/${boardId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ topicId: '00000000-0000-4000-8000-000000000002' })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
        expect(res.body.message).toContain('topicId');
      });
  });

  it('PATCH /boards/:id - editor 纯内容字段（name/description）→ 200 回读生效', async () => {
    mockRepos.Board.findOne.mockResolvedValue(otherCreatorBoard());
    mockRepos.BoardMember.findOne.mockResolvedValue({ boardId, actorId, role: 'editor' });
    mockRepos.Board.save.mockResolvedValue({
      ...otherCreatorBoard(),
      name: 'Renamed By Editor',
      description: 'Edited legend',
    });

    return request(app.getHttpServer())
      .patch(`/boards/${boardId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Renamed By Editor', description: 'Edited legend' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('name', 'Renamed By Editor');
        expect(res.body.data).toHaveProperty('description', 'Edited legend');
      });
  });

  it('PATCH /boards/:id - creator PATCH topicId → 200 回读生效（creator 全字段）', async () => {
    // creatorId 必须与 guard 注入的 actor id（'00000000-0000-4000-8000-000000000005'）一致，
    // 否则 creator 判定落空走到 ownerProxy（Agent.exists 未 mock → 500）
    mockRepos.Board.findOne.mockResolvedValue({
      ...makeBoard(),
      creatorId: '00000000-0000-4000-8000-000000000005',
    });
    // boardService.update 对 topicId 变更做 Topic 存在性校验（resourceValidator.exists → findOne）
    mockRepos.Topic.findOne.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000002' });
    mockRepos.Board.save.mockResolvedValue({
      ...makeBoard(),
      topicId: '00000000-0000-4000-8000-000000000002',
    });

    return request(app.getHttpServer())
      .patch(`/boards/${boardId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ topicId: '00000000-0000-4000-8000-000000000002' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('topicId', '00000000-0000-4000-8000-000000000002');
      });
  });
});
