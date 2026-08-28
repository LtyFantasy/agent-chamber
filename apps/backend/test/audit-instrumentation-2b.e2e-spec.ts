/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan shadowcat-sunspot-catwoman.md Phase 2（audit 全覆盖插桩）
 *   - 补充: docs/spec.md §3.1 audit_logs（entity_id UUID NOT NULL、actor_id 无 FK）
 *
 * [踩坑索引]
 *   - FAIL-OPEN: AuditService.log 内部 try/catch，审计写失败不阻断业务——
 *     本套件直接断言 audit_logs 落库（真 PG），mock 测不出 ORM 写
 *   - BATCH: batchCreate 循环调 create 自然产 N 行（决策 2——batch 不单独记）
 *   - REPLAY: reportResult/patchDescription 幂等 replay 只在真实写路径记审计
 *
 * [铁律关联] #17(测试契约) #23(jsonb查询集成覆盖) #8(测试绑定)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * 活动日志插桩（Phase 2 后半）—— task/board/milestone/docspace 真实 PG 集成套件
 *
 * 覆盖（plan shadowcat-sunspot-catwoman.md Phase 2 + 决策 2/6）：
 * ① task create → audit 行（newData 含 listId）
 * ② batch 三任务 → 恰 3 行不双计（决策 2：batch 不单独记，create 循环自然产 N 行）
 * ③ report_task_result 幂等 replay → 不双记（构成写各自落行，replay 跳过步骤零新增）
 * ④ milestone create → audit 行（service 层插桩）
 * ⑤ board list create / doc_space create → service 直调零审计行（负向断言防双计；
 *    插桩在 controller 层，由单测覆盖）
 * ⑥ doc-links 增删 → audit 行（addDocLink service 层 / removeDocLink controller 层）
 *
 * 与 audit-instrumentation.e2e-spec.ts 同款环境约定：本地开发库 chamber-postgres
 * （localhost:8744），PG 不可达整套降级跳过；RUN 后缀隔离测试数据，afterAll 按
 * FK 依赖逆序硬删兜底清理。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import {
  ActorType,
  AgentStatus,
  AuditAction,
  TaskStatus,
  UserRole,
  Visibility,
} from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { TaskService } from '../src/modules/task/task.service';
import { MilestoneService } from '../src/modules/task/milestone.service';
import { BoardService } from '../src/modules/board/board.service';
import { DocSpaceService } from '../src/modules/docspace/docspace.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { ResourceValidator } from '../src/common/resource-validator';
import { EventService } from '../src/modules/event/event.service';
import { PermissionService } from '../src/common/services/permission.service';
import { DocSpacePolicy } from '../src/common/policies/doc-space.policy';
import { Actor } from '../src/database/entities/actor.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { User } from '../src/database/entities/user.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { Task } from '../src/database/entities/task.entity';
import { TaskComment } from '../src/database/entities/task-comment.entity';
import { TaskActivity } from '../src/database/entities/task-activity.entity';
import { TaskDependency } from '../src/database/entities/task-dependency.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { Milestone } from '../src/database/entities/milestone.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { RoundtableSeat } from '../src/database/entities/roundtable-seat.entity';
import { Message } from '../src/database/entities/message.entity';
import * as bcrypt from 'bcrypt';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 每次生成唯一后缀：隔离测试数据（同进程多用例串行，模块级常量会跨用例复用导致唯一冲突） */
const runSuffix = (): string => `ai2b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('活动日志插桩（Phase 2 后半）— task/board/milestone/docspace 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let moduleRef: TestingModule;
  let taskService: TaskService;
  let milestoneService: MilestoneService;
  let boardService: BoardService;
  let docSpaceService: DocSpaceService;

  /** 本次运行创建的实体 id（afterAll 按 FK 依赖逆序清理） */
  const created: {
    auditIds: string[];
    userId?: string;
    userActorId?: string;
    agentIds: string[];
    boardIds: string[];
    listIds: string[];
    taskIds: string[];
    commentIds: string[];
    milestoneIds: string[];
    spaceIds: string[];
    docIds: string[];
    docLinkIds: Array<{ taskId: string; docId: string }>;
  } = {
    auditIds: [],
    agentIds: [],
    boardIds: [],
    listIds: [],
    taskIds: [],
    commentIds: [],
    milestoneIds: [],
    spaceIds: [],
    docIds: [],
    docLinkIds: [],
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(
        `[audit-instrumentation-2b e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    const s = runSuffix();

    // ── 测试数据：human 用户（owner）──
    const userActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `AI2B Owner ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.userActorId = userActor.id;
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: userActor.id,
        actor: userActor,
        username: `ai2bowner${s}`.slice(0, 50),
        email: `ai2b-owner-${s}@example.com`,
        passwordHash: await bcrypt.hash('password123', 4),
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.userId = user.id;

    // 与生产同构直连：AuditService 依赖 OwnerProxyService + ActorProfileService
    const ownerProxy = new OwnerProxyService(ds.getRepository(Agent));
    const actorProfile = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    const auditService = new AuditService(ds.getRepository(AuditLog), ownerProxy, actorProfile);

    // 最小 Nest 模块：各 Service 走**真 repo**（真 ORM SQL），辅助依赖 mock——
    // 插桩断言只关心 audit_logs 落库
    moduleRef = await Test.createTestingModule({
      providers: [
        TaskService,
        MilestoneService,
        BoardService,
        DocSpaceService,
        { provide: AuditService, useValue: auditService },
        { provide: getRepositoryToken(Task), useValue: ds.getRepository(Task) },
        { provide: getRepositoryToken(TaskComment), useValue: ds.getRepository(TaskComment) },
        { provide: getRepositoryToken(TaskActivity), useValue: ds.getRepository(TaskActivity) },
        { provide: getRepositoryToken(TaskDependency), useValue: ds.getRepository(TaskDependency) },
        { provide: getRepositoryToken(TaskDocLink), useValue: ds.getRepository(TaskDocLink) },
        { provide: getRepositoryToken(Board), useValue: ds.getRepository(Board) },
        { provide: getRepositoryToken(BoardList), useValue: ds.getRepository(BoardList) },
        { provide: getRepositoryToken(BoardMember), useValue: ds.getRepository(BoardMember) },
        { provide: getRepositoryToken(Milestone), useValue: ds.getRepository(Milestone) },
        { provide: getRepositoryToken(DocSpace), useValue: ds.getRepository(DocSpace) },
        { provide: getRepositoryToken(DocSpaceMember), useValue: ds.getRepository(DocSpaceMember) },
        { provide: getRepositoryToken(DocCategory), useValue: ds.getRepository(DocCategory) },
        { provide: getRepositoryToken(Doc), useValue: ds.getRepository(Doc) },
        { provide: getRepositoryToken(DocSection), useValue: ds.getRepository(DocSection) },
        { provide: getRepositoryToken(DocVersion), useValue: ds.getRepository(DocVersion) },
        { provide: getRepositoryToken(DocRoute), useValue: ds.getRepository(DocRoute) },
        {
          provide: getRepositoryToken(IdempotencyRecord),
          useValue: ds.getRepository(IdempotencyRecord),
        },
        { provide: getRepositoryToken(Topic), useValue: ds.getRepository(Topic) },
        {
          provide: getRepositoryToken(TopicParticipant),
          useValue: ds.getRepository(TopicParticipant),
        },
        { provide: getRepositoryToken(RoundtableSeat), useValue: ds.getRepository(RoundtableSeat) },
        { provide: getRepositoryToken(Message), useValue: ds.getRepository(Message) },
        { provide: getRepositoryToken(User), useValue: ds.getRepository(User) },
        { provide: getRepositoryToken(Agent), useValue: ds.getRepository(Agent) },
        { provide: getRepositoryToken(Actor), useValue: ds.getRepository(Actor) },
        { provide: EventService, useValue: { create: jest.fn().mockResolvedValue({}) } },
        { provide: AccessQueryService, useValue: {} },
        { provide: OwnerProxyService, useValue: ownerProxy },
        { provide: ResourceValidator, useValue: new ResourceValidator() },
        { provide: DataSource, useValue: ds },
        { provide: ActorProfileService, useValue: actorProfile },
        {
          provide: PermissionService,
          useValue: { ensureCan: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: DocSpacePolicy, useValue: { can: jest.fn().mockResolvedValue(true) } },
      ],
    }).compile();

    taskService = moduleRef.get(TaskService);
    milestoneService = moduleRef.get(MilestoneService);
    boardService = moduleRef.get(BoardService);
    docSpaceService = moduleRef.get(DocSpaceService);
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）
    if (created.auditIds.length > 0) {
      await ds.getRepository(AuditLog).delete({ id: In(created.auditIds) });
    }
    for (const l of created.docLinkIds) {
      await ds.getRepository(TaskDocLink).delete({ taskId: l.taskId, docId: l.docId });
    }
    if (created.commentIds.length > 0) {
      await ds.getRepository(TaskComment).delete({ id: In(created.commentIds) });
    }
    if (created.taskIds.length > 0) {
      await ds.getRepository(Task).delete({ id: In(created.taskIds) });
    }
    if (created.milestoneIds.length > 0) {
      await ds.getRepository(Milestone).delete({ id: In(created.milestoneIds) });
    }
    if (created.docIds.length > 0) {
      await ds.getRepository(Doc).delete({ id: In(created.docIds) });
    }
    if (created.spaceIds.length > 0) {
      await ds.getRepository(DocSpace).delete({ id: In(created.spaceIds) });
    }
    if (created.listIds.length > 0) {
      await ds.getRepository(BoardList).delete({ id: In(created.listIds) });
    }
    if (created.boardIds.length > 0) {
      await ds.getRepository(Board).delete({ id: In(created.boardIds) });
    }
    for (const aid of created.agentIds) {
      await ds.getRepository(Agent).delete({ id: aid });
    }
    if (created.userId) await ds.getRepository(User).delete({ id: created.userId });
    if (created.userActorId) await ds.getRepository(Actor).delete({ id: created.userActorId });
    await moduleRef.close();
    await ds.destroy();
  }, 30000);

  /** 查询某实体的 audit 行（按 entityType + entityId 精确过滤，本套件 UUID 天然隔离） */
  async function findAuditRows(entityType: string, entityId: string): Promise<AuditLog[]> {
    return ds.getRepository(AuditLog).find({
      where: { entityType, entityId },
      order: { createdAt: 'ASC' },
    });
  }

  /** 建一个 board + 默认 list（task 用例前置） */
  async function makeBoardWithList(): Promise<{ boardId: string; listId: string }> {
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `AI2B Board ${runSuffix()}`,
        creatorId: created.userId!,
        creatorType: ActorType.HUMAN,
        settings: { visibility: Visibility.OPEN },
      }),
    );
    created.boardIds.push(board.id);
    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: 'To Do',
        position: 0,
      }),
    );
    created.listIds.push(list.id);
    return { boardId: board.id, listId: list.id };
  }

  it('task create → audit 行（newData 含 listId），batch 三任务 → 恰 3 行不双计', async () => {
    const { listId } = await makeBoardWithList();

    // 单任务 create
    const task = await taskService.create(
      { title: `AI2B Task ${runSuffix()}`, listId },
      created.userId!,
      ActorType.HUMAN,
    );
    created.taskIds.push(task.id);
    const rows = await findAuditRows('task', task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.CREATE);
    expect(rows[0].actorId).toBe(created.userId);
    expect(rows[0].newData).toMatchObject({
      taskId: task.id,
      title: task.title,
      listId,
    });
    created.auditIds.push(rows[0].id);

    // batch 三任务 → 恰 3 行（决策 2：batch 不单独记，create 循环自然产 N 行）
    const batch = await taskService.batchCreate(
      {
        tasks: [
          { title: `AI2B B1 ${runSuffix()}`, listId },
          { title: `AI2B B2 ${runSuffix()}`, listId },
          { title: `AI2B B3 ${runSuffix()}`, listId },
        ],
      },
      created.userId!,
      ActorType.HUMAN,
    );
    expect(batch.count).toBe(3);
    for (const t of batch.items) {
      created.taskIds.push(t.id);
      const tRows = await findAuditRows('task', t.id);
      expect(tRows).toHaveLength(1);
      expect(tRows[0].action).toBe(AuditAction.CREATE);
      created.auditIds.push(tRows[0].id);
    }
  });

  it('report_task_result 幂等 replay → 不双记（构成写各自落行，replay 零新增）', async () => {
    const { listId } = await makeBoardWithList();
    const task = await taskService.create(
      { title: `AI2B Report ${runSuffix()}`, listId },
      created.userId!,
      ActorType.HUMAN,
    );
    created.taskIds.push(task.id);
    const taskRows = await findAuditRows('task', task.id);
    created.auditIds.push(taskRows[0].id);

    const actor = { id: created.userId!, type: ActorType.HUMAN };
    const clientRequestId = `ai2b-${runSuffix()}`;
    const dto = {
      status: TaskStatus.DONE,
      comment: 'done via report',
      clientRequestId,
    };

    // 首次：评论 + 状态变更各落一行（report 不单独记——决策 2）
    const first = await taskService.reportResult(task.id, dto, actor);
    expect(first.idempotentReplay).toBeUndefined();
    const firstComment = first.comment as TaskComment;
    const commentRows = await findAuditRows('task_comment', firstComment.id);
    expect(commentRows).toHaveLength(1);
    created.auditIds.push(commentRows[0].id);
    created.commentIds.push(firstComment.id);
    const taskRowsAfter = await findAuditRows('task', task.id);
    expect(taskRowsAfter).toHaveLength(2); // create + update(status)
    created.auditIds.push(taskRowsAfter[1].id);

    // 同 key 重放 → 快照回放，零新增审计行
    const replay = await taskService.reportResult(task.id, dto, actor);
    expect(replay.idempotentReplay).toBe(true);
    const commentRowsAfter = await findAuditRows('task_comment', firstComment.id);
    expect(commentRowsAfter).toHaveLength(1);
    const taskRowsAfterReplay = await findAuditRows('task', task.id);
    expect(taskRowsAfterReplay).toHaveLength(2);
  });

  it('milestone create → audit 行（service 层插桩）', async () => {
    const { boardId } = await makeBoardWithList();
    const milestone = await milestoneService.create(
      { name: `AI2B MS ${runSuffix()}`, boardId },
      { id: created.userId!, type: ActorType.HUMAN, role: UserRole.EDITOR },
    );
    created.milestoneIds.push(milestone.id);

    const rows = await findAuditRows('milestone', milestone.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.CREATE);
    expect(rows[0].actorId).toBe(created.userId);
    expect(rows[0].newData).toMatchObject({
      milestoneId: milestone.id,
      name: milestone.name,
    });
    created.auditIds.push(rows[0].id);
  });

  it('board list create / doc_space create：service 直调不落审计行（防双计；controller 层插桩由单测覆盖）', async () => {
    // 插桩在 controller 层（board.controller.ts createList / docspace.controller.ts create）——
    // service 直调必须零审计行，否则 controller 再记一次就是双计。负向断言锁定该契约。
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `AI2B Board2 ${runSuffix()}`,
        creatorId: created.userId!,
        creatorType: ActorType.HUMAN,
        settings: { visibility: Visibility.OPEN },
      }),
    );
    created.boardIds.push(board.id);

    const list = await boardService.createList(board.id, { name: 'In Progress' });
    created.listIds.push(list.id);
    expect(await findAuditRows('board_list', list.id)).toHaveLength(0);

    const space = await docSpaceService.create(
      { id: created.userId!, type: ActorType.HUMAN, role: UserRole.EDITOR },
      { name: `AI2B Space ${runSuffix()}` },
    );
    created.spaceIds.push(space.id);
    expect(await findAuditRows('doc_space', space.id)).toHaveLength(0);
  });

  it('doc-links 增删 → audit 行（addDocLink service 层 CREATE / removeDocLink controller 层 DELETE）', async () => {
    const { listId } = await makeBoardWithList();
    const task = await taskService.create(
      { title: `AI2B Link ${runSuffix()}`, listId },
      created.userId!,
      ActorType.HUMAN,
    );
    created.taskIds.push(task.id);
    const taskRows = await findAuditRows('task', task.id);
    created.auditIds.push(taskRows[0].id);

    // 建一个 doc（doc-link 前置；doc_space 插桩在 controller 层，service 直调不落行，无需断言）
    const space = await docSpaceService.create(
      { id: created.userId!, type: ActorType.HUMAN, role: UserRole.EDITOR },
      { name: `AI2B LinkSpace ${runSuffix()}` },
    );
    created.spaceIds.push(space.id);
    const doc = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId: space.id,
        path: `ai2b-${runSuffix()}.md`,
        title: 'AI2B Doc',
        docType: 'note',
        createdBy: created.userId!,
      }),
    );
    created.docIds.push(doc.id);

    // addDocLink（service 层插桩）
    const actor = { id: created.userId!, type: ActorType.HUMAN };
    const link = await taskService.addDocLink(task.id, doc.id, actor);
    created.docLinkIds.push({ taskId: task.id, docId: doc.id });
    const linkRows = await findAuditRows('doc_link', doc.id);
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0].action).toBe(AuditAction.CREATE);
    expect(linkRows[0].newData).toMatchObject({ taskId: task.id, docId: doc.id });
    created.auditIds.push(linkRows[0].id);

    // removeDocLink（controller 层插桩——service 直调不落审计，此处验证 service 行为；
    // controller 层 DELETE 行由 task.controller.spec 单测覆盖）
    await taskService.removeDocLink(task.id, doc.id);
    const linkRowsAfter = await findAuditRows('doc_link', doc.id);
    expect(linkRowsAfter).toHaveLength(1); // 无新增（removeDocLink 审计在 controller 层）
  });
});
