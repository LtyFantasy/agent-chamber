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

  // dummyAuthGuard 注入的请求身份（test-setup 硬编码）——POST /boards 的实际 creator
  const requestActorId = '00000000-0000-4000-8000-000000000005';

  it('POST /boards + GET /boards/:id — creator 写入成员表（role=editor, invitedBy=null），成员列表含 creator（4b1ddd1c）', async () => {
    const board = makeBoard();
    mockRepos.Board.create.mockReturnValue(board);
    // save 回填 id（模拟 DB 生成），create() 尾部 findOne 返回完整结构
    mockRepos.Board.save.mockImplementation(async (b: any) => ({ ...b, id: boardId }));
    mockRepos.Board.findOne.mockResolvedValue({ ...board, lists: [] });

    await request(app.getHttpServer())
      .post('/boards')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Test Board' })
      .expect(201);

    // 服务层写入的成员行：creator 落 editor 行 + invitedBy=null（非授予标记）
    const createdRows = mockRepos.BoardMember.create.mock.calls.map((c: any[]) => c[0]);
    const creatorRow = createdRows.find((r: any) => r.actorId === requestActorId);
    expect(creatorRow).toMatchObject({
      boardId,
      actorId: requestActorId,
      role: 'editor',
      invitedBy: null,
    });

    // 成员列表（detail.enrich）含 creator 一行
    mockRepos.BoardMember.find.mockResolvedValue([creatorRow]);
    mockRepos.Actor.find.mockResolvedValue([{ id: requestActorId, type: 'human' }]);
    mockRepos.User.find.mockResolvedValue([
      { id: requestActorId, username: 'testuser', displayName: 'Test User', avatarUrl: null },
    ]);

    await request(app.getHttpServer())
      .get(`/boards/${boardId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        const members = res.body.data.members;
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({
          id: requestActorId,
          role: 'editor',
          invitedBy: null,
        });
      });
  });

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
    // 部分水合形状（leftJoin+addSelect 后 list/board 只含选中列）
    const hydratedList = {
      id: listId,
      name: 'To Do',
      boardId,
      board: { id: boardId, name: 'My Board', topicId: null },
    };
    const activeTask = makeTask({
      id: 'task-active',
      status: TaskStatus.BACKLOG,
      list: hydratedList,
    });
    const doneTask = makeTask({ id: 'task-done', status: TaskStatus.DONE });

    mockRepos.Board.findOne.mockResolvedValue(makeBoard([makeList()]));
    mockRepos.BoardList.findOne.mockResolvedValue(makeList());
    mockAccessQueryBuilder();
    mockRepos.Task.createQueryBuilder.mockReturnValue({
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
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
        // WS-A 扁平化：item 无嵌套实体键，含扁平 listId/boardName/listName
        expect(res.body.data.items[0]).not.toHaveProperty('list');
        expect(res.body.data.items[0]).not.toHaveProperty('board');
        expect(res.body.data.items[0]).toHaveProperty('listId', listId);
        expect(res.body.data.items[0]).toHaveProperty('boardName', 'My Board');
        expect(res.body.data.items[0]).toHaveProperty('listName', 'To Do');
      });
  });

  it('GET /boards/:id/lists/:listId/tasks?status=all returns all tasks', async () => {
    const activeTask = makeTask({ id: 'task-active', status: TaskStatus.TODO });
    const doneTask = makeTask({ id: 'task-done', status: TaskStatus.DONE });

    mockRepos.Board.findOne.mockResolvedValue(makeBoard([makeList()]));
    mockRepos.BoardList.findOne.mockResolvedValue(makeList());
    mockAccessQueryBuilder();
    mockRepos.Task.createQueryBuilder.mockReturnValue({
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
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

  it('POST /tasks/batch — item with statusName resolves the target list via three-layer match', async () => {
    // 请求体必须通过 DTO 的 @IsUUID()（默认 v4），不能用全局 mock 的 0000 形状常量
    const boardIdV4 = '550e8400-e29b-41d4-a716-446655440001';
    // statusName 'todo' → mappedStatus ci 精确命中 makeList()（name='To Do', mappedStatus='todo'）
    mockRepos.BoardList.find.mockResolvedValue([makeList()]);
    mockRepos.Board.findOne.mockResolvedValue({ ...makeBoard([makeList()]), id: boardIdV4 });
    const task = makeTask({ title: 'From statusName' });
    mockRepos.Task.create.mockReturnValue(task);
    mockRepos.Task.save.mockImplementation(async (t: any) => ({ ...t, id: task.id }));
    mockRepos.TaskActivity.save.mockResolvedValue({});
    mockRepos.Event.save.mockResolvedValue({});
    // 统一批 A2.5（R10/R14）：task create 未指定 assignee 时默认 assign 给创建者（actor），
    // assertActorUsable 走 actor queryBuilder.getOne——必须 mock 否则 404 AGENT_NOT_FOUND
    mockRepos.Actor.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000005',
        deletedAt: null,
      }),
    });

    return request(app.getHttpServer())
      .post('/tasks/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ tasks: [{ title: 'From statusName', boardId: boardIdV4, statusName: 'todo' }] })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.items[0]).toMatchObject({ title: 'From statusName', listId });
      });
  });

  it('POST /tasks/:id/report — 全链路（评论→状态→docLinks）+ 同 key 重放零副作用', async () => {
    // DTO @IsUUID() 要求 v4 形状（全局 mock 的 0000 常量会被校验拒绝）
    const taskIdV4 = '550e8400-e29b-41d4-a716-446655440020';
    const docIdV4 = '550e8400-e29b-41d4-a716-446655440030';
    const spaceIdV4 = '550e8400-e29b-41d4-a716-446655440040';
    const reportKey = 'e2e-report-key-001';
    const requestBody = {
      status: TaskStatus.DONE,
      comment: 'e2e 完成',
      commitSha: 'abc1234',
      docIds: [docIdV4],
      clientRequestId: reportKey,
    };

    // ── 权限与任务查询链路 ──
    // TaskService.findById / findOne（controller + addComment + update 共用）
    mockRepos.Task.findOne.mockResolvedValue(makeTask({ id: taskIdV4 }));
    // TaskPolicy：list 无 board → 视为公开放行（既有 e2e 同款简化）
    mockRepos.BoardList.findOne.mockResolvedValue(makeList());

    // ── 评论链路（addComment）──
    const comment = {
      id: 'comment-1',
      taskId: taskIdV4,
      authorId: requestActorId,
      authorType: 'human',
      content: 'e2e 完成\n\nCommit: abc1234',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    };
    mockRepos.TaskComment.create.mockReturnValue(comment);
    mockRepos.TaskComment.save.mockResolvedValue(comment);
    mockRepos.TaskActivity.save.mockResolvedValue({});

    // ── 状态链路（update：save 后的事件落库）──
    mockRepos.Task.save.mockResolvedValue(makeTask({ id: taskIdV4, status: TaskStatus.DONE }));
    mockRepos.Event.create = jest.fn().mockReturnValue({});
    mockRepos.Event.save.mockResolvedValue({});

    // ── doc-link 链路（addDocLink：doc/space 查询 + 权限 + 落库）──
    const docQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ id: docIdV4, spaceId: spaceIdV4 }),
      getMany: jest.fn(),
      getManyAndCount: jest.fn(),
    };
    const spaceQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        id: spaceIdV4,
        settings: { visibility: 'open' },
      }),
      getMany: jest.fn(),
      getManyAndCount: jest.fn(),
    };
    mockRepos.Doc.createQueryBuilder.mockReturnValue(docQb);
    mockRepos.DocSpace.createQueryBuilder.mockReturnValue(spaceQb);
    mockRepos.DocSpaceMember.findOne.mockResolvedValue(null);
    const link = { taskId: taskIdV4, docId: docIdV4, createdBy: requestActorId };
    mockRepos.TaskDocLink.findOne.mockResolvedValue(null);
    mockRepos.TaskDocLink.create.mockReturnValue(link);
    mockRepos.TaskDocLink.save.mockResolvedValue(link);

    // ── 幂等链路：入口无记录；checkpoint save 回填实体 ──
    mockRepos.IdempotencyRecord.findOne.mockResolvedValue(null);
    mockRepos.IdempotencyRecord.save.mockImplementation(async (e: any) => e);

    const first = await request(app.getHttpServer())
      .post(`/tasks/${taskIdV4}/report`)
      .set('Authorization', `Bearer ${authToken}`)
      .send(requestBody)
      .expect(201);

    expect(first.body.data.task.status).toBe(TaskStatus.DONE);
    expect(first.body.data.comment.content).toBe('e2e 完成\n\nCommit: abc1234');
    expect(first.body.data.docLinks).toEqual({ succeeded: [docIdV4], failed: [] });
    expect(first.body.data.idempotentReplay).toBeUndefined();
    expect(mockRepos.TaskComment.save).toHaveBeenCalledTimes(1);
    // 幂等记录已落库（checkpoint 链：comment → {comment,task} → 全量）
    expect(mockRepos.IdempotencyRecord.save).toHaveBeenCalledTimes(3);

    // ── 同 key 重放：入口命中完整快照 → 直接回放，零副作用 ──
    mockRepos.IdempotencyRecord.findOne.mockResolvedValue({
      id: 'idem-rec-1',
      actorId: requestActorId,
      clientRequestId: reportKey,
      entityType: 'task_report',
      entityId: taskIdV4,
      requestHash: 'mocked-hash', // 与 test-setup 的 crypto mock 产出一致
      responseSnapshot: {
        task: { id: taskIdV4, status: TaskStatus.DONE },
        comment: { id: 'comment-1', content: 'e2e 完成\n\nCommit: abc1234' },
        docLinks: { succeeded: [docIdV4], failed: [] },
      },
      createdAt: new Date('2024-01-01'),
    });

    const replay = await request(app.getHttpServer())
      .post(`/tasks/${taskIdV4}/report`)
      .set('Authorization', `Bearer ${authToken}`)
      .send(requestBody)
      .expect(201);

    expect(replay.body.data.idempotentReplay).toBe(true);
    expect(replay.body.data.comment.id).toBe('comment-1');
    expect(replay.body.data.docLinks).toEqual({ succeeded: [docIdV4], failed: [] });
    // 评论/状态/链接零副作用：无重复执行
    expect(mockRepos.TaskComment.save).toHaveBeenCalledTimes(1);
    expect(mockRepos.Task.save).toHaveBeenCalledTimes(1);
    expect(mockRepos.TaskDocLink.save).toHaveBeenCalledTimes(1);
  });

  it('PATCH /tasks/:id/description — match 替换 + 乐观锁 + 同 key 重放零副作用', async () => {
    // DTO @IsUUID() 要求 v4 形状（全局 mock 的 0000 常量会被校验拒绝）
    const taskIdV4 = '550e8400-e29b-41d4-a716-446655440050';
    const patchKey = 'e2e-patch-desc-key-001';
    const requestBody = {
      oldString: '旧描述',
      newString: '新描述',
      // test-setup 的 crypto mock 使 descriptionHash/requestHash 恒为 'mocked-hash'
      expectedDescriptionHash: 'mocked-hash',
      clientRequestId: patchKey,
    };

    // ── 权限与任务查询链路（controller findById + 事务内锁行查询共用）──
    mockRepos.Task.findOne.mockResolvedValue(makeTask({ id: taskIdV4, description: '旧描述' }));
    // list→board 派生（service 内 this.boardListRepo.findOne）
    mockRepos.BoardList.findOne.mockResolvedValue(makeList());
    mockRepos.Task.save.mockImplementation(async (t: any) => ({ ...t, id: taskIdV4 }));
    mockRepos.TaskActivity.save.mockResolvedValue({});
    mockRepos.Event.create = jest.fn().mockReturnValue({});
    mockRepos.Event.save.mockResolvedValue({});

    // ── 事务 manager：getRepository(Task/IdempotencyRecord) → 同源 repo mock ──
    // （照 docspace.e2e-spec 的 setupManagerQb 先例；managerMock 为全 repo 共享实例）
    const mgr: any = mockRepos.Task.manager;
    mgr.getRepository = jest.fn((entityClass: any) => mockRepos[entityClass?.name]);

    // ── 幂等链路：入口无记录；事务内 save 回填实体 ──
    mockRepos.IdempotencyRecord.findOne.mockResolvedValue(null);
    mockRepos.IdempotencyRecord.save.mockImplementation(async (e: any) => e);

    const first = await request(app.getHttpServer())
      .patch(`/tasks/${taskIdV4}/description`)
      .set('Authorization', `Bearer ${authToken}`)
      .send(requestBody)
      .expect(200);

    expect(first.body.data.task.description).toBe('新描述');
    expect(first.body.data.task.descriptionHash).toBe('mocked-hash');
    expect(first.body.data.idempotentReplay).toBeUndefined();
    // 业务写 1 次 + 幂等记录 1 次（同事务）
    expect(mockRepos.Task.save).toHaveBeenCalledTimes(1);
    expect(mockRepos.IdempotencyRecord.save).toHaveBeenCalledTimes(1);

    // ── 同 key 重放：入口命中完整快照 → 直接回放，零副作用 ──
    mockRepos.IdempotencyRecord.findOne.mockResolvedValue({
      id: 'idem-rec-2',
      actorId: requestActorId,
      clientRequestId: patchKey,
      entityType: 'task_description',
      entityId: taskIdV4,
      requestHash: 'mocked-hash', // 与 test-setup 的 crypto mock 产出一致
      responseSnapshot: {
        task: { id: taskIdV4, description: '新描述', descriptionHash: 'mocked-hash' },
      },
      createdAt: new Date('2024-01-01'),
    });

    const replay = await request(app.getHttpServer())
      .patch(`/tasks/${taskIdV4}/description`)
      .set('Authorization', `Bearer ${authToken}`)
      .send(requestBody)
      .expect(200);

    expect(replay.body.data.idempotentReplay).toBe(true);
    expect(replay.body.data.task.description).toBe('新描述');
    // 零副作用：无重复写
    expect(mockRepos.Task.save).toHaveBeenCalledTimes(1);
    expect(mockRepos.IdempotencyRecord.save).toHaveBeenCalledTimes(1);
  });
});
