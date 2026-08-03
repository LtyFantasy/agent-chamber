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
      makeList({ id: '00000000-0000-0000-0000-000000000099', boardId: '00000000-0000-0000-0000-000000000002' }),
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
});
