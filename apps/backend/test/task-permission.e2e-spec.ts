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
 *
 * 另挂 2 条 PATCH /tasks/:id 的可选乐观锁用例（卡 09ffa9a8）——只补"过 HTTP 才能证明"的两件事：
 * DTO 接收面（whitelist + forbidNonWhitelisted 下新字段不被 400）与 409 的**信封形状**
 * （data.currentUpdatedAt 经 AllExceptionsFilter 透传）。服务层与真 PG 并发语义见
 * test/task-optimistic-lock.e2e-spec.ts，勿在此重复。
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
  /**
   * **有效 actor id** = dummy guard 注入的 `req.user.userId`（test-setup.ts:210），
   * 形状是 `0000-4000-8000-...`，与本文件用于签 JWT 的 `actorId`（`0000-0000-0000-...`）
   * **不同**。凡是要证明"当前 actor 就是 assignee / 就是 creator"的用例，必须用这个值——
   * 用错会得到"看似通过实为另一个原因"的假绿（如 403 来自 controller 的 board write 而不是门）。
   */
  const effectiveActorId = '00000000-0000-4000-8000-000000000005';
  const otherCreatorId = '00000000-0000-4000-8000-000000000009';
  /** 第二块板（跨板用例的目标板）与其列 —— F4-2 跨板写族用 */
  const otherBoardId = '00000000-0000-4000-8000-000000000002';
  const otherListId = '00000000-0000-4000-8000-000000000011';

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

    // ── F4-2：TaskPolicy 的 list→board 归属判定改走**定主键重载**
    // （createQueryBuilder + withDeleted + addSelect('board.deletedAt')），**不是 findOne**
    // （软删板必须先载得回来，才谈得上"只读冷藏"）。test-setup 通用 QB 的 getOne 默认
    // resolve null ⇒ 不接管的话 Policy 会掉进"真缺失"分支全拒，本套件所有正例变 403/404。
    // 这里把 BoardList 的 QB getOne 指向当前用例的 `listReloadRow`（由 mockListReload 设置），
    // 其余链方法沿用 test-setup 默认实现。
    const baseBoardListQb = mockRepos.BoardList.createQueryBuilder;
    mockRepos.BoardList.createQueryBuilder = jest.fn((...args: any[]) => {
      const qb = baseBoardListQb(...args);
      qb.getOne.mockImplementation(async () =>
        listReloadQueue.length === 0
          ? null
          : listReloadQueue.length === 1
            ? listReloadQueue[0]
            : listReloadQueue.shift(),
      );
      return qb;
    });
    // 每用例从空队列起步（防上一个用例的重载行泄漏到下一个）
    listReloadQueue = [];
  });

  afterEach(async () => {
    await app.close();
  });

  /**
   * 当前用例的「重载行」队列（TaskPolicy / resolveTaskBoard 的定主键查询结果）。
   * 每用例由 mockListReload / mockListReloadQueue 显式指定；队列空 → null = 查不到 →
   * Policy 走"真缺失"全拒，这样"忘了喂夹具"的用例会**变红**而不是悄悄拿到一个板（防假绿）。
   * 队列语义：多于一条时逐次 shift（batch 端点一次请求内多次重载），单条则重复返回。
   */
  let listReloadQueue: any[] = [];

  /** 夹具：设置定主键重载命中行（含 board 关系） */
  const mockListReload = (row: any) => {
    listReloadQueue = [row];
  };

  /** 夹具：同一请求内多次重载按序取（如 blockers/batch 逐 task 解析所属板） */
  const mockListReloadQueue = (rows: any[]) => {
    listReloadQueue = [...rows];
  };

  /**
   * 夹具：按 listId 分发 `BoardList.findOne`。
   * 跨板场景必需 —— TaskPolicy 的重载走 QB，而**跨板门与存在性校验走 findOne**，
   * 两者必须给出**不同**的行（不同 boardId）才能证明"跨板"被正确识别。
   */
  const mockListLookupById = (rows: Record<string, any>) => {
    mockRepos.BoardList.findOne.mockImplementation(async (opts: any) => {
      const id = opts?.where?.id;
      return rows[id] ?? null;
    });
  };

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

  /** 当前 actor 创建的 board（成员正常场景）——注意这里 creatorId 用的是签 JWT 的
   *  `actorId`（0000-0000 形状），**不等于**注入的 effectiveActorId；既有用例靠
   *  board_members editor 行放行，与 creator 短路无关，故保持原样不动。 */
  const makeOwnBoard = (overrides: Partial<any> = {}) =>
    makePrivateBoard({ creatorId: actorId, ...overrides });

  /**
   * **actor 自己创建的板**（creator = effectiveActorId）——creator 短路 ⇒ BoardPolicy
   * read/write/delete 全放行。用于"目标板有权"的正例与"403 必须来自跨板门而不是
   * controller 的 board write"的负例（用 makeOwnBoard 会让 controller 先 403，测不到门）。
   */
  const makeActorOwnedBoard = (overrides: Partial<any> = {}) =>
    makePrivateBoard({ creatorId: effectiveActorId, ...overrides });

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
    // TaskPolicy 的重载走 QB：必须同喂，否则 Policy 掉进"真缺失"全拒
    mockListReload(makeList());
    mockRepos.Task.findOne.mockResolvedValue(makeTask());
    mockRepos.BoardMember.findOne.mockResolvedValue(null);
  };

  /**
   * F4-2 核心场景夹具：**非 editor 的成员**板（actor 是 board_members 的 role=member，
   * 板 creator 是别人）——BoardPolicy write=false、read=true，任务的 write 只能靠
   * 「assignee ∧ boardRead」这一条合取成立。任务 assigneeId = 当前 actor。
   */
  const mockNonEditorMemberContext = () => {
    const board = makePrivateBoard();
    const list = makeList({ board });
    mockRepos.Board.findOne.mockResolvedValue(board);
    mockRepos.BoardList.findOne.mockResolvedValue(list);
    mockListReload(list);
    // assignee 必须是**有效 actor id**，否则 isAssignee 为假，本夹具就退化成了普通的
    // "非成员 → 拒绝"，测不到 F4-2 的 assignee 通道
    mockRepos.Task.findOne.mockResolvedValue(makeTask({ assigneeId: effectiveActorId }));
    mockRepos.BoardMember.findOne.mockResolvedValue({
      boardId,
      actorId: effectiveActorId,
      role: 'member',
    });
  };

  /**
   * 成员场景公共 mock：dummy guard 注入的 actor id 为 4000-8000 形状（非 board
   * creator 0000 形状）——用 board_members editor 行放行（与 board.e2e 既有
   * editor 用例同款，BoardPolicy write 对 editor 放行）
   */
  const mockMemberTaskContext = (opts: { memberRole?: string } = {}) => {
    mockRepos.Board.findOne.mockResolvedValue(makeOwnBoard());
    const list = makeList({ board: makeOwnBoard() });
    mockRepos.BoardList.findOne.mockResolvedValue(list);
    mockListReload(list);
    mockRepos.Task.findOne.mockResolvedValue(makeTask());
    mockRepos.BoardMember.findOne.mockResolvedValue({
      boardId,
      actorId,
      role: opts.memberRole ?? 'editor',
    });
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
    // 逐 task 的所属板经 resolveTaskBoard（withDeleted 重载）解析 ⇒ 按序喂两行
    // （P-N3：软删板也要能解析出来，与单条 GET 同口径；这里两行均存活，只验顺序与判定）
    mockListReloadQueue([
      makeList({ board: makePrivateBoard() }),
      makeList({
        boardId: '00000000-0000-4000-8000-000000000002',
        board: makeOwnBoard({ id: '00000000-0000-4000-8000-000000000002' }),
      }),
    ]);
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

  // ==================== F4-2 / V2-N2：assignee 通道 + 跨板写族四门 ====================
  //
  // 本组是**唯一在真 HTTP 层**（真 ValidationPipe + 真 AllExceptionsFilter + 真
  // PermissionService/TaskPolicy，仅 repo 层 mock）打这四个写入点的 task 套件——专治
  // 「service 单测绿但接线错了」这一类问题：跨板门的四个调用点分落 task.service /
  // board.service，各自的单测会把对方的门 mock 掉，**接错不会红**，只有过 HTTP 才证明得了。

  it('私有板非成员 assignee：GET /tasks/:id → 404（F4-2：被指派不是授权来源）', async () => {
    mockRepos.Board.findOne.mockResolvedValue(makePrivateBoard());
    mockRepos.BoardList.findOne.mockResolvedValue(makeList());
    mockListReload(makeList());
    // 当前 actor 就是 assignee（必须用 effectiveActorId，否则这条退化成普通"非成员"用例），
    // 但既非成员也非 creator ⇒ read 都不成立 ⇒ 404
    mockRepos.Task.findOne.mockResolvedValue(makeTask({ assigneeId: effectiveActorId }));
    mockRepos.BoardMember.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get(`/tasks/${taskId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TASK_NOT_FOUND);
      });
  });

  it('私有板非成员 assignee：PATCH /tasks/:id → 403（write 合取 boardRead）', async () => {
    mockRepos.Board.findOne.mockResolvedValue(makePrivateBoard());
    mockRepos.BoardList.findOne.mockResolvedValue(makeList());
    mockListReload(makeList());
    mockRepos.Task.findOne.mockResolvedValue(makeTask({ assigneeId: effectiveActorId }));
    mockRepos.BoardMember.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .patch(`/tasks/${taskId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'should be rejected' })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('非 editor 成员 assignee：PATCH /tasks/:id → 200（assignee ∧ boardRead 成立）', async () => {
    mockNonEditorMemberContext();

    return request(app.getHttpServer())
      .patch(`/tasks/${taskId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'member assignee patch' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.data.title).toBe('member assignee patch');
      });
  });

  it('非 editor 成员 assignee：同板 move → 200（同板不施加目标板门，A-C2/P-N1）', async () => {
    mockNonEditorMemberContext();
    // 目标列与当前列**同板**（两次 boardId 解析同值）⇒ 跨板门短路，
    // 只认 controller 的任务 write（本 actor 是 assignee ∧ 能读板）——这条就是
    // 「成员 assignee 拖拽不被 403 误杀」的回归护栏。
    mockListLookupById({
      [listId]: makeList({ id: listId, board: makePrivateBoard() }),
      [otherListId]: makeList({ id: otherListId, boardId, board: makePrivateBoard() }),
    });

    return (
      request(app.getHttpServer())
        .post(`/tasks/${taskId}/move`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ listId: otherListId, order: 0 })
        // move 端点声明为 201（POST 缺省）——断言的是"未被 403 误杀"，状态码照实现取
        .expect(201)
        .expect((res: any) => {
          expect(res.body.data.listId).toBe(otherListId);
        })
    );
  });

  it('跨板 move 进无权私有板 → 403（目标板 write 门）', async () => {
    mockNonEditorMemberContext();
    mockListLookupById({
      [listId]: makeList({ id: listId, board: makePrivateBoard() }),
      // 目标列在另一块私有板：actor 既非 creator 也无成员行 ⇒ 目标板 write 拒
      [otherListId]: makeList({
        id: otherListId,
        boardId: otherBoardId,
        board: makePrivateBoard({ id: otherBoardId }),
      }),
    });

    return request(app.getHttpServer())
      .post(`/tasks/${taskId}/move`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ listId: otherListId, order: 0 })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('跨板 PATCH listId 进无权私有板 → 403（update 路径同门）', async () => {
    mockNonEditorMemberContext();
    mockListLookupById({
      [listId]: makeList({ id: listId, board: makePrivateBoard() }),
      [otherListId]: makeList({
        id: otherListId,
        boardId: otherBoardId,
        board: makePrivateBoard({ id: otherBoardId }),
      }),
    });

    return request(app.getHttpServer())
      .patch(`/tasks/${taskId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ listId: otherListId })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
      });
  });

  it('有权限板间 move → 200（两块板 creator 都是 actor：目标板 write 成立）', async () => {
    mockRepos.Task.findOne.mockResolvedValue(makeTask({ assigneeId: effectiveActorId }));
    mockListReload(makeList({ board: makeActorOwnedBoard() }));
    mockListLookupById({
      [listId]: makeList({ id: listId, board: makeActorOwnedBoard() }),
      [otherListId]: makeList({
        id: otherListId,
        boardId: otherBoardId,
        board: makeActorOwnedBoard({ id: otherBoardId }),
      }),
    });

    return request(app.getHttpServer())
      .post(`/tasks/${taskId}/move`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ listId: otherListId, order: 0 })
      .expect(201)
      .expect((res: any) => {
        expect(res.body.data.listId).toBe(otherListId);
      });
  });

  it('跨板 reorder 拉取无权私有板的任务 → 403（S-N2 最重项：批量外泄）', async () => {
    // 目标列在 actor **自己的**板（controller 的 board write 必然通过），但 item 当前躺在
    // 一块 actor 无权的私有板里 —— 门必须落在**当前列**所属板上，否则等于放任
    // "有目标板 write 的人把别人私板里的任务批量拉走"。
    // 断言 taskRepo.update 未被调用 = 拒绝发生在**批量写之前**（无部分成功、无泄漏）。
    const ownList = makeList({ id: listId, board: makeActorOwnedBoard() });
    mockRepos.Board.findOne.mockResolvedValue(makeActorOwnedBoard());
    mockRepos.Task.find.mockResolvedValue([{ id: otherTaskId, listId: otherListId }]);
    mockListLookupById({
      [listId]: ownList,
      [otherListId]: makeList({
        id: otherListId,
        boardId: otherBoardId,
        board: makePrivateBoard({ id: otherBoardId }),
      }),
    });

    return request(app.getHttpServer())
      .post(`/boards/lists/${listId}/reorder`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ tasks: [{ id: otherTaskId, position: 0 }] })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
        expect(mockRepos.Task.update).not.toHaveBeenCalled();
      });
  });

  it('跨板 removeList moveTasksTo 进无权私有板 → 403（批量倾倒注入）', async () => {
    mockRepos.Board.findOne.mockResolvedValue(makeActorOwnedBoard());
    mockListLookupById({
      [listId]: {
        ...makeList({ id: listId, board: makeActorOwnedBoard() }),
        tasks: [{ id: otherTaskId }],
      },
      [otherListId]: makeList({
        id: otherListId,
        boardId: otherBoardId,
        board: makePrivateBoard({ id: otherBoardId }),
      }),
    });

    return request(app.getHttpServer())
      .delete(`/boards/lists/${listId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ moveTasksTo: otherListId })
      .expect(403)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
        // 拒绝在批量转移之前：一条任务都不许先落库
        expect(mockRepos.Task.update).not.toHaveBeenCalled();
      });
  });

  it('跨板 reorder 的判定查询必须含软删任务（复审 C1：判据集合 ⊇ 写入集合）', async () => {
    const ownList = makeList({ id: listId, board: makeActorOwnedBoard() });
    mockRepos.Board.findOne.mockResolvedValue(makeActorOwnedBoard());
    mockRepos.Task.find.mockResolvedValue([] as never);
    mockListLookupById({ [listId]: ownList });

    await request(app.getHttpServer())
      .post(`/boards/lists/${listId}/reorder`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ tasks: [{ id: otherTaskId, position: 0 }] })
      .expect(201);

    // 写入循环用 taskRepo.update（TypeORM UPDATE 不追加 deleted_at IS NULL）⇒ 判定查询
    // 必须 withDeleted，否则软删任务 id 会漏门（HTTP 层再钉一次，与 board.service 单测双保险）
    expect(mockRepos.Task.find).toHaveBeenCalledWith(
      expect.objectContaining({ withDeleted: true }),
    );
  });

  it('reorder 引用解析不到的当前列 → 404（门的存在性语义，HTTP 可达性）', async () => {
    const ownList = makeList({ id: listId, board: makeActorOwnedBoard() });
    mockRepos.Board.findOne.mockResolvedValue(makeActorOwnedBoard());
    // item 当前列 = 查不到的列（数据损坏形态）；目标列有权 ⇒ 拒绝只能来自门的存在性判定
    mockRepos.Task.find.mockResolvedValue([{ id: otherTaskId, listId: otherListId }] as never);
    mockListLookupById({ [listId]: ownList });

    return request(app.getHttpServer())
      .post(`/boards/lists/${listId}/reorder`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ tasks: [{ id: otherTaskId, position: 0 }] })
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.LIST_NOT_FOUND);
        expect(mockRepos.Task.update).not.toHaveBeenCalled();
      });
  });

  // ==================== PATCH /tasks/:id 可选乐观锁（卡 09ffa9a8）====================
  //
  // 为什么这两条挂在本套件：本套件是唯一在**真 HTTP 层**（真 ValidationPipe + 真
  // AllExceptionsFilter，仅 repo 层 mock）打 PATCH /tasks/:id 的 task 套件。乐观锁路径的
  // 服务层语义与真 PG 并发语义由 test/task-optimistic-lock.e2e-spec.ts 负责；这里只补两件
  // **只有过 HTTP 才能证明**的事：
  //   ① DTO 接收面：新字段带 `@IsOptional() @IsISO8601()` 后才不会被 whitelist +
  //      forbidNonWhitelisted 判成未声明属性（漏装饰器 = 一切带 token 的请求 400）；
  //   ② 409 信封形状：`data.currentUpdatedAt` 必须经 AllExceptionsFilter 透传到顶层 data
  //      （automcp / platform-mcp 的契约面，先例 docspace-move 的 currentContentHash）。

  /** 锁路径的行锁读取（service 用 QueryBuilder + setLock，不走 findOne） */
  const mockLockedRowRead = (row: Record<string, unknown>) => {
    // manager.getRepository(<Entity>).createQueryBuilder → 与 repo mock 同源
    const mgr: any = mockRepos.Task.manager;
    mgr.getRepository = jest.fn((entityClass: any) => mockRepos[entityClass?.name]);
    mockRepos.Task.createQueryBuilder.mockReturnValue({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(row),
    });
  };

  it('PATCH /tasks/:id - 带 expectedUpdatedAt（与库内一致）→ 200（DTO 接收面 + 锁路径放行）', async () => {
    mockMemberTaskContext();
    mockLockedRowRead(makeTask());

    return (
      request(app.getHttpServer())
        .patch(`/tasks/${taskId}`)
        .set('Authorization', `Bearer ${authToken}`)
        // 与 makeTask() 的 updatedAt（2024-01-01）逐字一致 = GET 详情后原样回传的形态
        .send({ title: 'renamed via lock', expectedUpdatedAt: '2024-01-01T00:00:00.000Z' })
        .expect(200)
        .expect((res: any) => {
          expect(res.body.data.title).toBe('renamed via lock');
          // 锁 token 非实体字段：不得经 toPlain() 展开泄漏进响应
          expect(res.body.data.expectedUpdatedAt).toBeUndefined();
        })
    );
  });

  it('PATCH /tasks/:id - stale expectedUpdatedAt → 409 + data.currentUpdatedAt 经信封透传', async () => {
    mockMemberTaskContext();
    mockLockedRowRead(makeTask());

    return request(app.getHttpServer())
      .patch(`/tasks/${taskId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'too late', expectedUpdatedAt: '2023-12-31T23:59:59.000Z' })
      .expect(409)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.RESOURCE_CONFLICT);
        expect(res.body.message).toContain('Re-read it (GET /tasks/:id)');
        // 信封 data 透传（AllExceptionsFilter 的 business data 槽）
        expect(res.body.data.currentUpdatedAt).toBe('2024-01-01T00:00:00.000Z');
      });
  });
});
