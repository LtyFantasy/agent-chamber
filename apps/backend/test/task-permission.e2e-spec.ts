import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createTestingApp } from './test-setup';
import { ErrorCode, TaskStatus, TaskDependencyType } from '@agent-chamber/shared';

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

/**
 * B-58 权限漏挂集成级验证（打真实 PermissionService/Policy 判定路径，repo 层 mock）：
 * 10 个 task 端点 + GET /boards/lists/:id 的「非成员拒绝」与「成员放行」双向用例。
 * 非成员 = 私有 board + creator 非当前 actor + 无 board_members 行 + 非 owner 代理。
 * 语义：read 无权限 → 404（ensureCan 安全语义）；write 无权限 → 403；
 *       GET /tasks/blockers/batch 任一 board 不可读 → 403（batch 场景 404 无法隐藏存在性）。
 */
describe('TaskController permission (e2e, B-58)', () => {
  let app: INestApplication;
  let mockRepos: Record<string, any>;
  let authToken: string;

  const boardId = '00000000-0000-4000-8000-000000000001';
  const listId = '00000000-0000-4000-8000-000000000010';
  const taskId = '00000000-0000-4000-8000-000000000020';
  const otherTaskId = '00000000-0000-4000-8000-000000000021';
  const actorId = '00000000-0000-0000-0000-000000000005';
  const otherCreatorId = '00000000-0000-4000-8000-000000000009';

  beforeEach(async () => {
    ({ app, mockRepos } = await createTestingApp());

    const jwtService = app.get(JwtService);
    authToken = jwtService.sign({
      sub: actorId,
      email: 'test@example.com',
      role: 'observer',
    });

    // JwtStrategy validation for every request (Actor unified model)
    mockRepos.User.findOne.mockResolvedValue({
      id: actorId,
      email: 'test@example.com',
      role: 'observer',
      status: 'active',
      deletedAt: null,
      actor: { status: 'active' },
    });

    // 非 owner 代理默认（BoardPolicy 性能短路末位查询）
    mockRepos.Agent.exists = jest.fn().mockResolvedValue(false);
  });

  afterEach(async () => {
    await app.close();
  });

  /** 私有 board（非成员场景默认：creator 非当前 actor） */
  const makePrivateBoard = (overrides: Partial<any> = {}) => ({
    id: boardId,
    name: 'Private Board',
    topicId: null,
    creatorId: otherCreatorId,
    creatorType: 'human',
    settings: { visibility: 'private' },
    lists: [],
    ...overrides,
  });

  /** 当前 actor 创建的 board（成员正常场景） */
  const makeOwnBoard = (overrides: Partial<any> = {}) =>
    makePrivateBoard({ creatorId: actorId, ...overrides });

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
    // TaskPolicy 经 list→board 解析权限：默认挂私有 board（非成员语义），
    // 成员场景由 mockMemberTaskContext 覆盖为 makeOwnBoard
    board: makePrivateBoard(),
    ...overrides,
  });

  const makeTask = (overrides: Partial<any> = {}) => ({
    id: taskId,
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

  /** 非成员场景公共 mock：私有 board + task 挂在该 board 的 list 下 */
  const mockNonMemberTaskContext = () => {
    mockRepos.Board.findOne.mockResolvedValue(makePrivateBoard());
    mockRepos.BoardList.findOne.mockResolvedValue(makeList());
    mockRepos.Task.findOne.mockResolvedValue(makeTask());
    mockRepos.BoardMember.findOne.mockResolvedValue(null);
  };

  /**
   * 成员场景公共 mock：dummy guard 注入的 actor id 为 4000-8000 形状（非 board
   * creator 0000 形状）——用 board_members editor 行放行（与 board.e2e 既有
   * editor 用例同款，BoardPolicy write 对 editor 放行）
   */
  const mockMemberTaskContext = () => {
    mockRepos.Board.findOne.mockResolvedValue(makeOwnBoard());
    mockRepos.BoardList.findOne.mockResolvedValue(makeList({ board: makeOwnBoard() }));
    mockRepos.Task.findOne.mockResolvedValue(makeTask());
    mockRepos.BoardMember.findOne.mockResolvedValue({ boardId, actorId, role: 'editor' });
  };

  // ==================== 非成员拒绝（每个补挂端点至少一条） ====================

  it('POST /tasks - non-member → 403 (board write)', async () => {
    mockNonMemberTaskContext();

    return request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'T', boardId, listId })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('POST /tasks/batch - non-member → 403 (board write)', async () => {
    mockNonMemberTaskContext();

    return request(app.getHttpServer())
      .post('/tasks/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ tasks: [{ title: 'T1', boardId, listId }] })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('GET /tasks/:id/comments - non-member → 404 (board read)', async () => {
    mockNonMemberTaskContext();

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TASK_NOT_FOUND);
      });
  });

  it('GET /tasks/:id/activities - non-member → 404 (board read)', async () => {
    mockNonMemberTaskContext();

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/activities`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TASK_NOT_FOUND);
      });
  });

  it('GET /tasks/:id/dependencies - non-member → 404 (board read)', async () => {
    mockNonMemberTaskContext();

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/dependencies`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TASK_NOT_FOUND);
      });
  });

  it('GET /tasks/:id/dependents - non-member → 404 (board read)', async () => {
    mockNonMemberTaskContext();

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/dependents`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TASK_NOT_FOUND);
      });
  });

  it('GET /tasks/:id/blockers - non-member → 404 (board read)', async () => {
    mockNonMemberTaskContext();

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/blockers`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TASK_NOT_FOUND);
      });
  });

  it('POST /tasks/:id/dependencies - non-member → 403 (board write on task)', async () => {
    mockNonMemberTaskContext();

    return request(app.getHttpServer())
      .post(`/tasks/${taskId}/dependencies`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ dependsOnTaskId: otherTaskId, type: TaskDependencyType.BLOCKS })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('DELETE /tasks/:id/dependencies/:depId - non-member → 403 (board write)', async () => {
    mockNonMemberTaskContext();

    return request(app.getHttpServer())
      .delete(`/tasks/${taskId}/dependencies/00000000-0000-0000-0000-000000000030`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('GET /tasks/blockers/batch - any task board unreadable → 403', async () => {
    // task-1 在私有 board（不可读），task-2 在 actor 自己的 board（可读）
    mockRepos.Task.findOne
      .mockResolvedValueOnce(makeTask())
      .mockResolvedValueOnce(makeTask({ id: otherTaskId }));
    mockRepos.BoardList.findOne
      .mockResolvedValueOnce(makeList())
      .mockResolvedValueOnce(makeList({ boardId: '00000000-0000-4000-8000-000000000002' }));
    mockRepos.Board.findOne
      .mockResolvedValueOnce(makePrivateBoard())
      .mockResolvedValueOnce(makeOwnBoard({ id: '00000000-0000-4000-8000-000000000002' }));
    mockRepos.BoardMember.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get(`/tasks/blockers/batch?ids=${taskId},${otherTaskId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('GET /tasks/blockers/batch - invalid UUID segment → 400 before permission check', async () => {
    // B-61：非法 UUID 段必须在权限判定前被格式校验拦截（400 VALIDATION_ERROR），
    // 不得透传到 PG 绑定参数变成 22P02 500；断言 Task.findOne 未被调用 = 格式先于权限
    return request(app.getHttpServer())
      .get(`/tasks/blockers/batch?ids=${taskId},not-a-uuid`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(400)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
        expect(mockRepos.Task.findOne).not.toHaveBeenCalled();
      });
  });

  // ==================== 成员正常路径（不回归） ====================

  it('POST /tasks - member (board creator) → 201', async () => {
    mockMemberTaskContext();
    // create 链路：assignee 存在性（assertActorUsable）+ 类型解析
    mockRepos.Actor.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ id: actorId, deletedAt: null }),
    });
    mockRepos.Actor.findOne.mockResolvedValue({ id: actorId, type: 'human' });

    return request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'T', boardId, listId })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data.title).toBe('T');
      });
  });

  it('POST /tasks/batch - member (board creator) → 201', async () => {
    mockMemberTaskContext();
    mockRepos.Actor.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      withDeleted: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ id: actorId, deletedAt: null }),
    });
    mockRepos.Actor.findOne.mockResolvedValue({ id: actorId, type: 'human' });

    return request(app.getHttpServer())
      .post('/tasks/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ tasks: [{ title: 'T1', boardId, listId }] })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data.count).toBe(1);
      });
  });

  it('GET /tasks/:id/comments - member → 200', async () => {
    mockMemberTaskContext();
    mockRepos.TaskComment.find.mockResolvedValue([
      { id: 'c-1', taskId, content: 'hi', createdAt: new Date() },
    ]);

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveLength(1);
      });
  });

  it('GET /tasks/:id/activities - member → 200', async () => {
    mockMemberTaskContext();
    mockRepos.TaskActivity.find.mockResolvedValue([
      { id: 'a-1', taskId, action: 'created', createdAt: new Date() },
    ]);

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/activities`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveLength(1);
      });
  });

  it('GET /tasks/:id/dependencies - member → 200', async () => {
    mockMemberTaskContext();
    mockRepos.TaskDependency.find.mockResolvedValue([
      { id: 'd-1', taskId, dependsOnTaskId: otherTaskId, type: 'blocks', createdAt: new Date() },
    ]);

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/dependencies`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveLength(1);
      });
  });

  it('GET /tasks/:id/dependents - member → 200', async () => {
    mockMemberTaskContext();
    mockRepos.TaskDependency.find.mockResolvedValue([
      {
        id: 'd-1',
        taskId: otherTaskId,
        dependsOnTaskId: taskId,
        type: 'blocks',
        createdAt: new Date(),
      },
    ]);

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/dependents`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toHaveLength(1);
      });
  });

  it('GET /tasks/:id/blockers - member → 200', async () => {
    mockMemberTaskContext();
    mockRepos.TaskDependency.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    });

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}/blockers`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data).toEqual([]);
      });
  });

  it('POST /tasks/:id/dependencies - member (both boards owned) → 201', async () => {
    mockMemberTaskContext();
    // dependsOnTask 也在 actor 自己的 board
    mockRepos.Task.findOne
      .mockResolvedValueOnce(makeTask())
      .mockResolvedValueOnce(makeTask({ id: otherTaskId }));
    mockRepos.TaskDependency.findOne.mockResolvedValue(null); // 无重复依赖
    mockRepos.TaskDependency.create.mockReturnValue({
      id: 'd-1',
      taskId,
      dependsOnTaskId: otherTaskId,
      type: TaskDependencyType.BLOCKS,
    });

    return request(app.getHttpServer())
      .post(`/tasks/${taskId}/dependencies`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ dependsOnTaskId: otherTaskId, type: TaskDependencyType.BLOCKS })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data.taskId).toBe(taskId);
      });
  });

  it('DELETE /tasks/:id/dependencies/:depId - member → 200', async () => {
    mockMemberTaskContext();
    mockRepos.TaskDependency.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000030',
      taskId,
      dependsOnTaskId: otherTaskId,
      type: TaskDependencyType.BLOCKS,
    });
    // createMockRepo 默认无 remove 方法（task-dependency.service 用 depRepo.remove）
    mockRepos.TaskDependency.remove = jest.fn().mockResolvedValue({});

    return request(app.getHttpServer())
      .delete(`/tasks/${taskId}/dependencies/00000000-0000-0000-0000-000000000030`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);
  });

  it('GET /tasks/blockers/batch - member → 200 with blocker map', async () => {
    mockMemberTaskContext();
    mockRepos.Task.findOne.mockResolvedValue(makeTask());
    mockRepos.TaskDependency.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    });

    return request(app.getHttpServer())
      .get(`/tasks/blockers/batch?ids=${taskId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data[taskId]).toBe(false);
      });
  });
});
