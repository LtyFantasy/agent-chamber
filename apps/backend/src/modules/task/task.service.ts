/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.3 (Board / Task)
 *   - 补充: docs/api-definition.md §7. Tasks, docs/spec.md §3.2 TaskStatus
 *
 * [踩坑索引] B-50(列表权限过滤) B-50-EVT(任务事件boardId) B-42(单对象返回null) B-49(softDelete500) B-3(completedAt缺失) B-4(move到不存在的list) D5(权限迁移) P1-1(findOne载荷瘦身) Batch1-P2(milestone绑定校验) Batch3(topicId下线) R1(公共解析收口) A2.5(assignee须usable) WS-A(orderBy表达式坑)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #7(测试绑定) #9(代理层透传)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   A2.5: create/update/assign 的 assigneeId 统一走 ActorProfileService.assertActorUsable
 *       （存在+未软删两态，404 AGENT_NOT_FOUND）。assign 原 USER_NOT_FOUND 错误码语义误导
 *       （actorRepo 已挡软删但码说 user），本批统一为 AGENT_NOT_FOUND——消费方对"未存在"
 *       与"已删除"的正确动作相同，不值得双码。契约 docs/spec.md §1 规则 6。2026-08-26 统一批 A2.5。
 *   R1: Actor.deletedAt 是 @DeleteDateColumn({ select: false })——withDeleted 只解除过滤不选
 *       列。本文件所有 actor 投影（findAll/findOne assignee、getActivities 执行者、评论
 *       authorName）一律经 ActorProfileService.resolveProfiles 取 deletedAt/type/name，禁止
 *       散落 queryBuilder 或自建 actors 查询（收口见 common/services/actor-profile.service.ts，
 *       契约 docs/spec.md §1）。2026-08-26 统一批 A2。
 *   B-50: Task / Milestone 列表接口无 actor 权限过滤，无参数时返回全平台数据；
 *         修复：findAll 接收 actor，Service 层通过 list.boardId IN 过滤可访问 Board，
 *         空白名单直接返回空分页，返回 item 填充 boardId/topicId。见 Plan §3.1。
 *   B-50-EVT: Task 变更触发的事件缺少 boardId，导致 Event poll 无法按 board 过滤。
 *             修复：create/update/move 任务时 eventService.create 传入 boardId。
 *             见 Plan §5。
 *   B-42: Task 单对象端点(GET/POST/PATCH)返回 null/500。真实根因：migration 1780385100000
 *         未执行导致 task_comments.author_name 列缺失，TypeORM findOne 加载 comments 时 500。
 *         表象误判为序列化问题。修复：执行 migration SQL + findOne/create/update 返回 plain object。
 *         见 memory/2026-06-05.md
 *   B-49: DELETE /tasks/:id 返回 500。softRemove 对 loaded relations 有风险。
 *         修复：改为 softDelete(id)。见 memory/2026-06-05.md
 *   B-3: PATCH tasks status done 时 completedAt 未自动设置，状态机不一致。
 *         修复：update() 中添加 status→completedAt/startedAt 自动设置逻辑。见 memory/2026-05-24.md
 *   B-4: POST /tasks/:id/move 到不存在的 list → 500。
 *         修复：UUID 格式校验 + boardListRepo.findOne 存在性校验。见 memory/2026-05-24.md
 *   P1-1: findOne 不再内嵌 comments/activities（按需走独立接口）；dependencies/dependents
 *         内嵌 Task 实体摘要化为 {id,title,status}；getComments/getActivities 加 limit 上限。
 *         见 memory/2026-07-25.md
 *   Batch1-P2: create/update task 时 milestoneId 非空新增两道校验——存在性（404/7000）+ 同
 *         board（409/9001），根治之前无校验导致撞 PG FK 变 500 的 bug。见
 *         .kimi/plan-batch1-milestone-board.md §2 D-B1-4。
 *   WS-A: findAll 排序表达式坑——TypeORM 对含 "." 的 orderBy 键按 alias.property 解析，
 *         CASE 表达式直接传 orderBy 会 findAliasByName 抛错；addSelect 命名列 + orderBy
 *         别名可绕开，但别名必须全小写（getManyAndCount 回捞主查询不 escape orderBy 键，
 *         大写别名被 PG 折叠成小写报 column does not exist，真 PG e2e 实测）。
 *         见 plan forge-jubilee-robin.md Workstream A。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import { TaskActivity } from '../../database/entities/task-activity.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { Board } from '../../database/entities/board.entity';
import { TaskDependency } from '../../database/entities/task-dependency.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Milestone } from '../../database/entities/milestone.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import {
  ActorType,
  ErrorCode,
  EventType,
  TaskDependencyType,
  TaskStatus,
} from '@agent-chamber/shared';
import {
  CreateTaskDto,
  UpdateTaskDto,
  MoveTaskDto,
  AssignTaskDto,
  AddCommentDto,
  QueryTaskDto,
  BatchCreateTasksDto,
  ReportTaskResultDto,
  PatchTaskDescriptionDto,
} from './dto';
import { EventService } from '../event/event.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ResourceValidator } from '../../common/resource-validator';
import { UnifiedActor } from '../../common/types/actor.types';
import { DocSpacePolicy } from '../../common/policies/doc-space.policy';
import { ActorProfileService } from '../../common/services/actor-profile.service';
import type { PaginatedResponse, TaskSummary } from '@agent-chamber/shared';
import type { TaskDocLinkItem } from '@agent-chamber/shared';

export interface TaskWithBlockers extends Task {
  blockers?: TaskDependency[];
  assigneeName?: string | null;
  /** 软删信号：非空 = assignee 已删除，assigneeName 仍可显示（契约 docs/spec.md §1） */
  assigneeDeletedAt?: string | null;
}

/**
 * POST /tasks/:id/report 的成功响应形状（幂等快照以此为准）。
 *
 * task 恒有；comment 仅当评论步骤执行过；docLinks 仅当请求带 docIds。
 * idempotentReplay 仅在「完整快照直接回放」路径置 true（恢复路径不做标记——
 * 它补跑了未完成步骤，属于真实的新工作）。
 */
export interface TaskReportResult {
  task: Record<string, unknown>;
  comment?: unknown;
  docLinks?: {
    succeeded: string[];
    failed: TaskDocLinkFailure[];
  };
  idempotentReplay?: boolean;
}

/** 单条 doc-link 失败项（形状对齐 MCP report_task_result 的 docLinks.failed） */
export interface TaskDocLinkFailure {
  docId: string;
  status?: number;
  code?: number | string;
  error: string;
}

/** report 幂等记录专用 entityType（与既有 'task'/'doc' 区分，共用 uq_idempotency_actor_key 表） */
const TASK_REPORT_ENTITY_TYPE = 'task_report';

/** patchDescription 幂等记录专用 entityType（与 'task'/'task_report' 区分，共用 uq_idempotency_actor_key 表） */
const TASK_PATCH_DESCRIPTION_ENTITY_TYPE = 'task_description';

/**
 * PATCH /tasks/:id/description 的成功响应形状（幂等快照以此为准）。
 *
 * task 恒有（含 descriptionHash）；idempotentReplay 仅在「快照直接回放」路径置 true。
 */
export interface TaskPatchDescriptionResult {
  task: Record<string, unknown>;
  idempotentReplay?: boolean;
}

@Injectable()
export class TaskService {
  constructor(
    @InjectRepository(Task)
    private taskRepo: Repository<Task>,
    @InjectRepository(TaskComment)
    private commentRepo: Repository<TaskComment>,
    @InjectRepository(TaskActivity)
    private activityRepo: Repository<TaskActivity>,
    @InjectRepository(BoardList)
    private boardListRepo: Repository<BoardList>,
    @InjectRepository(Board)
    private boardRepo: Repository<Board>,
    @InjectRepository(Milestone)
    private milestoneRepo: Repository<Milestone>,
    @InjectRepository(TaskDependency)
    private depRepo: Repository<TaskDependency>,
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Actor)
    private actorRepo: Repository<Actor>,
    private readonly eventService: EventService,
    private readonly accessQuery: AccessQueryService,
    private readonly resourceValidator: ResourceValidator,
    private readonly dataSource: DataSource,
    @InjectRepository(TaskDocLink)
    private docLinkRepo: Repository<TaskDocLink>,
    @InjectRepository(Doc)
    private docRepo: Repository<Doc>,
    @InjectRepository(DocSpace)
    private docSpaceRepo: Repository<DocSpace>,
    private readonly docSpacePolicy: DocSpacePolicy,
    private readonly actorProfileService: ActorProfileService,
  ) {}

  /**
   * 解析单个 Actor 类型
   * assignee_type / actor_type 等列即将删除，加载实体时该字段为 undefined，
   * 需要通过 actors 表重新推导类型。
   */
  private async resolveActorType(actorId: string): Promise<ActorType | null> {
    const actor = await this.actorRepo.findOne({ where: { id: actorId } });
    return actor?.type ?? null;
  }

  /**
   * 批量解析 Actor 类型
   */
  private async resolveActorTypes(actorIds: string[]): Promise<Map<string, ActorType>> {
    const uniqueIds = [...new Set(actorIds)].filter(Boolean);
    if (uniqueIds.length === 0) return new Map();
    const actors = await this.actorRepo.find({ where: { id: In(uniqueIds) } });
    return new Map(actors.map((a) => [a.id, a.type]));
  }

  async findAll(
    query: QueryTaskDto,
    actor?: UnifiedActor,
  ): Promise<PaginatedResponse<TaskSummary>> {
    const page = Math.max(1, +(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, +(query.pageSize ?? query.limit ?? 20)));

    const accessibleBoardIds = await this.accessQuery.getAccessibleBoardIds(actor);
    // 非 Admin 且白名单为空时直接返回空分页，避免生成空 IN () 导致 SQL 错误
    if (accessibleBoardIds && accessibleBoardIds.length === 0) {
      return {
        items: [],
        total: 0,
        page: +page,
        pageSize: +pageSize,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
    }

    const qb = this.taskRepo
      .createQueryBuilder('task')
      // 部分水合 join（WS-A 扁平化）：只 select 需要的列，避免整行 list/board 实体
      // 泄漏进响应。join 本身必须保留——accessibleBoardIds/boardId/topicId 的 WHERE
      // 过滤只依赖 join 不依赖 select（plan 调查结论 1 已核实）。
      .leftJoin('task.list', 'list')
      .addSelect(['list.id', 'list.name', 'list.boardId'])
      .leftJoin('list.board', 'board')
      .addSelect(['board.id', 'board.name', 'board.topicId'])
      .where('task.deleted_at IS NULL');

    if (accessibleBoardIds) {
      qb.andWhere('list.board_id IN (:...accessibleBoardIds)', { accessibleBoardIds });
    }

    // boardId 过滤：通过 join 的 list.board_id
    if (query.boardId) {
      qb.andWhere('list.board_id = :boardId', { boardId: query.boardId });
    }

    if (query.listId) {
      qb.andWhere('task.list_id = :listId', { listId: query.listId });
    }

    if (query.topicId) {
      qb.andWhere('board.topic_id = :topicId', { topicId: query.topicId });
    }

    if (query.milestoneId) {
      qb.andWhere('task.milestone_id = :milestoneId', { milestoneId: query.milestoneId });
    }

    if (query.status && query.status !== 'all') {
      const rawStatuses = Array.isArray(query.status) ? query.status : [query.status];
      const validStatuses = rawStatuses.filter((s): s is TaskStatus =>
        Object.values(TaskStatus).includes(s as TaskStatus),
      );
      if (validStatuses.length > 0) {
        qb.andWhere('task.status IN (:...statuses)', { statuses: validStatuses });
      }
    }

    if (query.assigneeId) {
      qb.andWhere('task.assignee_id = :assigneeId', { assigneeId: query.assigneeId });
    }
    // assignee_type 列即将删除，不再按负责人类型过滤

    if (query.labels && query.labels.length > 0) {
      // PostgreSQL 数组包含查询：task.labels 包含所有指定标签
      qb.andWhere('task.labels @> :labels', { labels: query.labels });
    }

    if (query.q) {
      // 复用 search_vector 进行全文搜索
      const trimmedQ = query.q.trim();
      if (trimmedQ) {
        qb.andWhere("task.search_vector @@ plainto_tsquery('simple', :tsquery)", {
          tsquery: trimmedQ,
        });
      }
    }

    if (query.unblocked) {
      // 排除有活跃 blockers 的任务（使用 NOT EXISTS 避免子查询参数丢失）
      qb.andWhere(
        `NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          INNER JOIN tasks blocker ON blocker.id = td.depends_on_task_id
          WHERE td.task_id = task.id
            AND td.dependency_type = :blockType
            AND blocker.status NOT IN (:...doneStatuses)
            AND blocker.deleted_at IS NULL
        )`,
        {
          blockType: TaskDependencyType.BLOCKS,
          doneStatuses: [TaskStatus.DONE, TaskStatus.ARCHIVED],
        },
      );
    }

    if (query.sort === 'statusPriority') {
      // 状态优先级排序（opt-in）：in_progress > todo > blocked > backlog > 其余
      // （review/done/archived 恒末位）。CASE 权重越小越靠前；updatedAt DESC 次键 +
      // id ASC 第三键兜底稳定分页（PG 不保证无主序时跨页稳定，plan 架构师修订）。
      // ⚠️ TypeORM 对含 "." 的 orderBy 键按 alias.property 解析（CASE 表达式会被误
      // split 抛错），故 CASE 经 addSelect 命名列 + orderBy 别名。别名必须全小写：
      // getManyAndCount 回捞实体的主查询把 orderBy 键原样拼 SQL（不 escape），
      // 大写别名会被 PG 折叠成小写导致 "column does not exist"（真 PG 实测）。
      qb.addSelect(
        `CASE task.status
          WHEN 'in_progress' THEN 0
          WHEN 'todo' THEN 1
          WHEN 'blocked' THEN 2
          WHEN 'backlog' THEN 3
          ELSE 4 END`,
        'status_priority_order',
      )
        .orderBy('status_priority_order', 'ASC')
        .addOrderBy('task.updatedAt', 'DESC')
        .addOrderBy('task.id', 'ASC');
    } else {
      // 默认排序：创建时间倒序（web 看板分页依赖，前端不重排，一字不动）
      qb.orderBy('task.createdAt', 'DESC');
    }
    qb.skip((page - 1) * pageSize).take(pageSize);

    const [items, total] = await qb.getManyAndCount();

    // 批量解析 assignee 档案（统一批 A2：走公共 ActorProfileService——withDeleted 覆盖
    // 软删 actor，回退链统一 agents.name || displayName，避免 N+1，保持 IN 批次形态）
    const assigneeIds = items.map((t) => t.assigneeId).filter(Boolean) as string[];
    const uniqueIds = [...new Set(assigneeIds)];
    const profileMap =
      uniqueIds.length > 0 ? await this.actorProfileService.resolveProfiles(uniqueIds) : new Map();

    const enrichedItems = items.map((task) => {
      const profile = task.assigneeId ? profileMap.get(task.assigneeId) : undefined;
      return {
        // 显式白名单组装（WS-A 扁平化，不再 spread 实体）：只暴露 TaskSummary 契约
        // 字段，杜绝 list/board/dependencies/dependents 等嵌套实体泄漏进响应。
        // hasBlockers/commentCount/activityCount 在 findAll 路径从不产出，不在白名单。
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        assigneeId: task.assigneeId,
        assigneeType: task.assigneeType,
        assigneeName: profile?.name ?? null,
        // 软删信号：非空 = assignee 已删除，assigneeName 仍可显示（契约 docs/spec.md §1）
        assigneeDeletedAt: profile?.deletedAt ? profile.deletedAt.toISOString() : null,
        position: task.position,
        dueDate: task.dueDate,
        labels: task.labels,
        milestoneId: task.milestoneId,
        // listId 是 Task 实体直接列（task.entity.ts:35），必须显式列出
        listId: task.listId,
        // Task 不存储 boardId/topicId，从已 join 的 list→board 推断
        boardId: task.list?.boardId ?? null,
        topicId: task.list?.board?.topicId ?? null,
        // 部分水合 join 列（leftJoin+addSelect）：list.name / board.name
        boardName: task.list?.board?.name ?? null,
        listName: task.list?.name ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
    });

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: enrichedItems,
      total,
      page,
      pageSize,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /** 将 TypeORM 实体转换为 plain object，避免序列化时动态赋值属性被覆盖（B-42~44） */
  private toPlain(task: Task): TaskWithBlockers {
    return {
      ...task,
      dependencies: task.dependencies,
      dependents: task.dependents,
      // blockers 是运行时动态附加的派生属性，未在 Task 实体中定义
      blockers: (task as TaskWithBlockers).blockers,
    };
  }

  /**
   * 描述乐观锁 token：sha256(description ?? '')。
   * 计算字段（无 DB 列）：findOne 详情响应与 patchDescription 响应携带，
   * 供调用方在局部 patch 前捕获前提（expectedDescriptionHash）。
   */
  private descriptionHash(description: string | null | undefined): string {
    return createHash('sha256')
      .update(description ?? '')
      .digest('hex');
  }

  /** 原始查询：按 ID 查找 Task（含 relations），不做权限检查 */
  async findById(id: string): Promise<Task> {
    const task = await this.taskRepo.findOne({
      where: { id },
      relations: ['milestone'],
    });
    if (!task) {
      throw new NotFoundException({ message: 'Task not found', code: ErrorCode.TASK_NOT_FOUND });
    }
    return task;
  }

  /**
   * 查询任务详情。
   * - 不再内嵌 comments/activities，按需通过 GET /tasks/:id/comments、/activities 独立获取。
   * - dependencies/dependents 内嵌的完整 Task 实体映射为摘要 {id, title, status}。
   */
  async findOne(id: string) {
    const task = await this.taskRepo.findOne({
      where: { id },
      relations: ['milestone'],
    });
    if (!task)
      throw new NotFoundException({ message: 'Task not found', code: ErrorCode.TASK_NOT_FOUND });

    // 加载依赖关系并直接附加到 task 对象上
    task.dependencies = await this.depRepo.find({
      where: { taskId: id },
      relations: ['dependsOnTask'],
      order: { createdAt: 'DESC' },
    });
    task.dependents = await this.depRepo.find({
      where: { dependsOnTaskId: id },
      relations: ['task'],
      order: { createdAt: 'DESC' },
    });

    // 将内嵌的完整 Task 实体映射为摘要 {id, title, status}，减少载荷体积
    task.dependencies = task.dependencies.map((d: TaskDependency) => ({
      ...d,
      dependsOnTask: d.dependsOnTask
        ? { id: d.dependsOnTask.id, title: d.dependsOnTask.title, status: d.dependsOnTask.status }
        : null,
    })) as unknown as TaskDependency[];
    task.dependents = task.dependents.map((d: TaskDependency) => ({
      ...d,
      task: d.task ? { id: d.task.id, title: d.task.title, status: d.task.status } : null,
    })) as unknown as TaskDependency[];

    // blockers 是运行时动态附加的派生属性，未在 Task 实体中定义
    (task as TaskWithBlockers).blockers = task.dependencies.filter(
      (d: TaskDependency) =>
        d.type === TaskDependencyType.BLOCKS &&
        d.dependsOnTask &&
        d.dependsOnTask.status !== TaskStatus.DONE &&
        d.dependsOnTask.status !== TaskStatus.ARCHIVED,
    );

    // 显式展开为 plain object，规避 TypeORM 实体序列化异常（B-41/B-42 教训）
    const plain = this.toPlain(task);
    // 剥离 comments / activities（不再通过 findOne 内嵌返回，按需走独立接口）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plainRecord = plain as any;
    delete plainRecord.comments;
    delete plainRecord.activities;
    if (plain.assigneeId) {
      // 统一批 A2：公共解析一次拿 name + type + deletedAt（替代原 resolveActorType +
      // resolveActorName 两次查询；withDeleted 覆盖软删 assignee，信号透传）
      const profile = (await this.actorProfileService.resolveProfiles([plain.assigneeId])).get(
        plain.assigneeId,
      );
      plain.assigneeName = profile?.name ?? null;
      plain.assigneeDeletedAt = profile?.deletedAt ? profile.deletedAt.toISOString() : null;
    }
    // Task 不存储 boardId/topicId，从 list→board 派生填充（Batch 3：topic_id 列已物理删除）
    const taskList = await this.boardListRepo.findOne({
      where: { id: plain.listId },
      relations: ['board'],
    });
    plain.topicId = taskList?.board?.topicId ?? null;

    // Load doc links
    const links = await this.docLinkRepo.find({ where: { taskId: id } });
    let docs: TaskDocLinkItem[] = [];
    if (links.length > 0) {
      const docIds = links.map((l) => l.docId);
      const docRows = await this.docRepo
        .createQueryBuilder('d')
        .select(['d.id', 'd.path', 'd.title', 'd.summary'])
        .innerJoin('doc_spaces', 'ds', 'ds.id = d.space_id AND ds.deleted_at IS NULL')
        .where('d.id IN (:...docIds)', { docIds })
        .andWhere('d.deleted_at IS NULL')
        .getRawMany<{
          d_id: string;
          d_path: string;
          d_title: string;
          d_summary: string | null;
        }>();
      docs = docRows.map((r) => ({
        docId: r.d_id,
        path: r.d_path,
        title: r.d_title,
        summary: r.d_summary ?? null,
      }));
    }

    return {
      ...plain,
      boardId: taskList?.boardId ?? null,
      docs,
      // 描述乐观锁 token（计算字段）：供 PATCH /tasks/:id/description 的
      // expectedDescriptionHash 前提捕获
      descriptionHash: this.descriptionHash(plain.description),
    };
  }

  async create(dto: CreateTaskDto, actorId?: string, actorType?: ActorType) {
    // ── statusName → listId 解析（与 MCP create_task 的 resolveList 契约对齐）──
    // 契约：listId 与 statusName 必须至少提供一个（都缺 → 400）；同时提供时 listId 优先、
    // statusName 忽略。仅当 !listId && statusName 时触发解析；此路径要求显式 boardId
    // （否则无法确定查哪个 board 的列）。解析出的 listId 回填 dto，后续原有流程不变。
    if (!dto.listId && !dto.statusName) {
      throw new BadRequestException({
        message: 'Either listId or statusName is required',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (!dto.listId && dto.statusName) {
      if (!dto.boardId) {
        throw new BadRequestException({
          message: 'boardId is required when resolving the target list by statusName',
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      const resolved = await this.resolveListIdByStatusName(dto.statusName, dto.boardId);
      dto.listId = resolved.listId;
    }

    // boardId 推断：如果未传，通过 listId 查询 BoardList 获取
    let boardId = dto.boardId;
    let topicId: string | null = null;

    // 显式传入 boardId 时，校验 Board 存在性，避免孤立任务（Phase 2）
    if (boardId) {
      const board = await this.resourceValidator.exists(
        this.boardRepo,
        boardId,
        ErrorCode.BOARD_NOT_FOUND,
      );
      topicId = board.topicId ?? null;
    }

    if (!boardId && dto.listId) {
      const list = await this.boardListRepo.findOne({
        where: { id: dto.listId },
        relations: ['board'],
      });
      if (!list) {
        throw new NotFoundException({
          message: 'Board list not found',
          code: ErrorCode.LIST_NOT_FOUND,
        });
      }
      boardId = list.boardId;
      topicId = list.board?.topicId ?? null;
    }

    // P2 修复: milestoneId 非空时校验 milestone 存在性 + 同 board（D-B1-4）
    if (dto.milestoneId) {
      const milestone = await this.resourceValidator.exists(
        this.milestoneRepo,
        dto.milestoneId,
        ErrorCode.MILESTONE_NOT_FOUND,
      );
      if (milestone.boardId !== boardId) {
        throw new ConflictException({
          message: 'Milestone does not belong to the same board as the task',
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
    }

    // 未指定负责人时，默认将任务分配给创建者，避免出现"无主任务"导致创建者无法继续操作
    const assigneeId = dto.assigneeId?.trim() || actorId || null;
    // 统一批 A2.5（R10/R14）：assigneeId 非空时断言 actor 存在且未软删——新指派指向
    // 已删 actor = 活配置错误，写接口统一 4xx AGENT_NOT_FOUND（契约 docs/spec.md §1 规则 6；
    // assignee 可以是 human，assertActorUsable 覆盖任意 actor type）
    if (assigneeId) {
      await this.actorProfileService.assertActorUsable(assigneeId);
    }
    const assigneeType = assigneeId ? await this.resolveActorType(assigneeId) : null;

    // statusName 必须在铺入 taskRepo.create 前剔除，否则 TypeORM 会把它当实体列写入（unknown column）
    const { clientRequestId, boardId: _boardId, statusName: _statusName, ...taskDto } = dto;

    // ── 无幂等键：走原路径（零开销） ──
    if (!clientRequestId) {
      const task = this.taskRepo.create({
        ...taskDto,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        assigneeId,
        assigneeType,
      });
      const savedTask = (await this.taskRepo.save(task)) as unknown as Task;

      // 触发事件（boardId 复用本地推断值，Task 实体不存储 boardId）
      await this.eventService.create({
        eventType: EventType.TASK_UPDATE,
        resourceType: 'task',
        resourceId: savedTask.id,
        topicId: topicId ?? undefined,
        boardId: boardId ?? undefined,
        actorId,
        actorType,
        payload: { taskId: savedTask.id, action: 'created' },
      });

      // 更新操作者 Agent 的最后活跃时间
      await this.touchAgentLastActiveAt(actorId, actorType);

      // Log activity（actorId 必须是真实的用户/Agent ID，不再 fallback 到 taskId）
      if (actorId) {
        await this.activityRepo.save({
          taskId: savedTask.id,
          action: 'created',
          actorId,
          actorType: actorType ?? ActorType.HUMAN,
          details: '创建了任务',
        });
      }

      return { ...this.toPlain(savedTask), boardId: boardId ?? null, topicId: topicId ?? null };
    }

    // ── 有幂等键：事务保护（创建实体 + 写幂等记录） ──
    try {
      const { savedTask } = await this.dataSource.transaction(async (manager) => {
        const taskRepo = manager.getRepository(Task);
        const task = taskRepo.create({
          ...taskDto,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          assigneeId,
          assigneeType,
        });
        const saved: Task = (await taskRepo.save(task)) as unknown as Task;

        // 写入幂等记录
        await manager.getRepository(IdempotencyRecord).save({
          actorId: actorId || '',
          clientRequestId,
          entityType: 'task',
          entityId: saved.id,
        });

        return { savedTask: saved };
      });

      // 事务成功后执行副作用（事件、活跃时间、活动日志）
      await this.eventService.create({
        eventType: EventType.TASK_UPDATE,
        resourceType: 'task',
        resourceId: savedTask.id,
        topicId: topicId ?? undefined,
        boardId: boardId ?? undefined,
        actorId,
        actorType,
        payload: { taskId: savedTask.id, action: 'created' },
      });

      await this.touchAgentLastActiveAt(actorId, actorType);

      if (actorId) {
        await this.activityRepo.save({
          taskId: savedTask.id,
          action: 'created',
          actorId,
          actorType: actorType ?? ActorType.HUMAN,
          details: '创建了任务',
        });
      }

      return { ...this.toPlain(savedTask), boardId: boardId ?? null, topicId: topicId ?? null };
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key') {
        // 幂等重放：查幂等记录 → 查回实体（不发事件、不写活动日志）
        const idempotencyRepo = this.dataSource.getRepository(IdempotencyRecord);
        const record = await idempotencyRepo.findOne({
          where: { actorId: actorId || '', clientRequestId },
        });
        // record 一定存在（23505 由该唯一索引触发），但防御性判空
        if (!record) {
          throw err;
        }
        const existing = await this.findOne(record.entityId);
        return { ...existing, idempotentReplay: true };
      }
      throw err;
    }
  }

  /**
   * 按 statusName 解析目标列（与 MCP create_task 的 resolveList 契约逐字对齐）：
   * ① mappedStatus 大小写不敏感精确 → ② 列名 ci 精确 → ③ 列名 ci 子串。
   * 0 命中抛 400 并附全部可选项（options）；>1 命中抛 400 并附候选列表
   * （candidates + isAmbiguous），绝不静默挑选。
   * @param statusName 调用方传入的列名/mappedStatus（已由 DTO 保证非空字符串）
   * @param boardId 目标看板 ID（必填，决定查询范围；调用方已校验非空）
   * @returns 唯一命中的列信息（listId 回填 dto 使用，listName/matchedBy/mappedStatus 供调试）
   */
  private async resolveListIdByStatusName(
    statusName: string,
    boardId: string,
  ): Promise<{ listId: string; listName: string; matchedBy: string; mappedStatus: string | null }> {
    const lists = await this.boardListRepo.find({ where: { boardId } });
    const lowerStatus = statusName.toLowerCase();

    // Layer 1: mappedStatus ci 精确（MCP resolveList 同款：仅字符串型 mappedStatus 参与比较）
    const mapped = lists.filter(
      (l) => typeof l.mappedStatus === 'string' && l.mappedStatus.toLowerCase() === lowerStatus,
    );
    if (mapped.length === 1) {
      return {
        listId: mapped[0].id,
        listName: mapped[0].name,
        matchedBy: `mappedStatus=${mapped[0].mappedStatus}`,
        mappedStatus: mapped[0].mappedStatus as string,
      };
    }
    if (mapped.length > 1) {
      throw new BadRequestException({
        message:
          `status "${statusName}" matches ${mapped.length} lists via mappedStatus. ` +
          `Provide a more specific status or use a different status name.`,
        code: ErrorCode.VALIDATION_ERROR,
        candidates: mapped.map((l) => ({ id: l.id, name: l.name, mappedStatus: l.mappedStatus })),
        isAmbiguous: true,
      });
    }

    // Layer 2: 列名 ci 精确
    const nameExact = lists.filter((l) => l.name.toLowerCase() === lowerStatus);
    if (nameExact.length === 1) {
      return {
        listId: nameExact[0].id,
        listName: nameExact[0].name,
        matchedBy: 'listName exact',
        mappedStatus: nameExact[0].mappedStatus ?? null,
      };
    }
    if (nameExact.length > 1) {
      throw new BadRequestException({
        message:
          `status "${statusName}" matches ${nameExact.length} lists by exact name. ` +
          `Refine the status or provide a different name.`,
        code: ErrorCode.VALIDATION_ERROR,
        candidates: nameExact.map((l) => ({
          id: l.id,
          name: l.name,
          mappedStatus: l.mappedStatus,
        })),
        isAmbiguous: true,
      });
    }

    // Layer 3: 列名 ci 子串
    const nameSub = lists.filter((l) => l.name.toLowerCase().includes(lowerStatus));
    if (nameSub.length === 1) {
      return {
        listId: nameSub[0].id,
        listName: nameSub[0].name,
        matchedBy: 'listName substring',
        mappedStatus: nameSub[0].mappedStatus ?? null,
      };
    }
    if (nameSub.length > 1) {
      throw new BadRequestException({
        message:
          `status "${statusName}" matches ${nameSub.length} lists by name substring. ` +
          `Refine the status or provide a more specific name.`,
        code: ErrorCode.VALIDATION_ERROR,
        candidates: nameSub.map((l) => ({ id: l.id, name: l.name, mappedStatus: l.mappedStatus })),
        isAmbiguous: true,
      });
    }

    // 0 命中：列出全部可选项，方便调用方修正
    throw new BadRequestException({
      message:
        `status "${statusName}" did not match any list on board. ` +
        `Available lists: ${lists
          .map((l) => `${l.name} (mappedStatus=${l.mappedStatus})`)
          .join(', ')}`,
      code: ErrorCode.VALIDATION_ERROR,
      options: lists.map((l) => ({ id: l.id, name: l.name, mappedStatus: l.mappedStatus })),
    });
  }

  async update(id: string, dto: UpdateTaskDto, actorId?: string, actorType?: ActorType) {
    // 必须用实体实例执行 save；同时只更新 DTO 中显式传入的字段，避免 class-transformer
    // 生成的可选字段（undefined）把 task 上的现有值（如 listId）覆盖掉。
    const task = await this.findById(id);

    // 手写 assignee 变更（不通过 Object.assign 批量合并，避免 assigneeId/assigneeType 被覆盖）
    // assigneeId 显式传入时应用（传 null/'' 取消分配、未传则不变更）
    const oldAssigneeId = task.assigneeId;
    let effectiveAssigneeId: string | null | undefined = undefined;

    if (dto.assigneeId !== undefined) {
      effectiveAssigneeId = dto.assigneeId || null;
    }

    if (effectiveAssigneeId !== undefined) {
      // 统一批 A2.5（R10/R14）：新指派/换人时断言 actor 存在且未软删（null/'' 取消分配不校验）
      if (effectiveAssigneeId) {
        await this.actorProfileService.assertActorUsable(effectiveAssigneeId);
      }
      task.assigneeId = effectiveAssigneeId;
      task.assigneeType = task.assigneeId ? await this.resolveActorType(task.assigneeId) : null;
    }

    // 保存旧状态用于状态机判断
    const oldStatus = task.status;
    const hadStartedAt = !!task.startedAt;

    // listId 变更时，保留 list 存在性校验（topicId 不再存储，由后续 join 派生）
    if (dto.listId && dto.listId !== task.listId) {
      await this.resourceValidator.exists(this.boardListRepo, dto.listId, ErrorCode.LIST_NOT_FOUND);
    }

    // 其他字段批量合并（排除 assigneeId，已手动处理）
    // 只合并显式传入（非 undefined）的值，防止 DTO 可选字段覆盖 task 现有数据。
    const { assigneeId: _a, ...restDto } = dto;
    for (const [key, value] of Object.entries(restDto)) {
      if (value !== undefined) {
        (task as unknown as Record<string, unknown>)[key] = value;
      }
    }

    // milestone 关系已在 findById 中加载；当同时设置 milestoneId 时，必须同步为新的
    // 里程碑引用（或 null）。仅清空关系对象会导致 TypeORM save() 返回的实体中
    // milestoneId 被同步为 null，使 API 响应显示绑定失败，尽管数据库实际已写入新值。
    // P2 修复 (D-B1-4): milestoneId 非空时校验存在性 + 同 board
    if (dto.milestoneId !== undefined) {
      if (dto.milestoneId) {
        // 确定任务当前有效 boardId：若同请求变更了 listId 则取新 list 的 boardId，
        // 否则按 task.listId 显式查所属 list（注意 task.list 未在 findById 加载，
        // relations 仅 ['milestone']，读 task.list?.boardId 永远拿到 undefined）。
        let effectiveBoardId: string | null = null;
        const effectiveListId = dto.listId && dto.listId !== task.listId ? dto.listId : task.listId;
        const effectiveList = await this.boardListRepo.findOne({
          where: { id: effectiveListId },
          select: ['boardId'],
        });
        effectiveBoardId = effectiveList?.boardId ?? null;

        const milestone = await this.resourceValidator.exists(
          this.milestoneRepo,
          dto.milestoneId,
          ErrorCode.MILESTONE_NOT_FOUND,
        );
        if (milestone.boardId !== effectiveBoardId) {
          throw new ConflictException({
            message: 'Milestone does not belong to the same board as the task',
            code: ErrorCode.RESOURCE_CONFLICT,
          });
        }
      }
      task.milestone = dto.milestoneId ? ({ id: dto.milestoneId } as Milestone) : null;
    }

    // 状态机：根据 status 变化自动设置 completedAt / startedAt
    if (dto.status === TaskStatus.DONE && oldStatus !== TaskStatus.DONE) {
      task.completedAt = new Date();
    }
    if (dto.status && dto.status !== TaskStatus.DONE && oldStatus === TaskStatus.DONE) {
      task.completedAt = null;
    }
    if (dto.status === TaskStatus.IN_PROGRESS && !hadStartedAt) {
      task.startedAt = new Date();
    }

    // 双向联动：status 变更时，自动吸附到对应 mappedStatus 的列
    // 注意：使用 QueryBuilder 绕过 TypeORM 0.3.x 枚举列查询的隐蔽问题（B-50）
    if (dto.status && dto.status !== oldStatus && task.listId) {
      const currentList = await this.boardListRepo.findOne({ where: { id: task.listId } });
      if (currentList?.boardId) {
        const targetList = await this.boardListRepo
          .createQueryBuilder('list')
          .where('list.board_id = :boardId', { boardId: currentList.boardId })
          .andWhere('list.mapped_status = :mappedStatus', { mappedStatus: dto.status })
          .getOne();
        if (targetList) {
          task.listId = targetList.id;
        }
      }
    }

    const saved = await this.taskRepo.save(task);

    // 更新操作者/负责人的 Agent 最后活跃时间
    await this.touchAgentLastActiveAt(actorId, actorType);
    if (saved.status === TaskStatus.DONE && saved.assigneeId) {
      await this.touchAgentLastActiveAt(saved.assigneeId, ActorType.AGENT);
    }

    // 触发事件（boardId 从当前列获取，topicId 由 list→board 派生；Task 实体不存储 boardId）
    const updatedList = await this.boardListRepo.findOne({
      where: { id: saved.listId },
      relations: ['board'],
    });
    await this.eventService.create({
      eventType: EventType.TASK_UPDATE,
      resourceType: 'task',
      resourceId: saved.id,
      topicId: updatedList?.board?.topicId ?? undefined,
      boardId: updatedList?.boardId ?? undefined,
      actorId,
      actorType,
      payload: { taskId: saved.id, action: 'updated', status: saved.status },
    });

    if (actorId) {
      const changedFields: string[] = [];
      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};

      Object.entries(restDto).forEach(([k, v]) => {
        if (v !== undefined) {
          changedFields.push(k);
          newValues[k] = v;
        }
      });

      // assignee 变更单独检测并记录
      if (effectiveAssigneeId !== undefined && effectiveAssigneeId !== oldAssigneeId) {
        changedFields.push('assigneeId');
        oldValues.assigneeId = oldAssigneeId;
        newValues.assigneeId = task.assigneeId;
      }

      if (changedFields.length > 0) {
        await this.activityRepo.save({
          taskId: id,
          action: 'updated',
          fieldName: changedFields.join(', ').slice(0, 50),
          oldValue: Object.keys(oldValues).length > 0 ? oldValues : null,
          newValue: newValues,
          actorId,
          actorType: actorType ?? ActorType.HUMAN,
          details: `更新了: ${changedFields.join(', ').slice(0, 100)}`,
        });
      }
    }

    return {
      ...this.toPlain(saved),
      boardId: updatedList?.boardId ?? null,
      topicId: updatedList?.board?.topicId ?? null,
    };
  }

  /**
   * 任务描述局部 patch（PATCH /tasks/:id/description，消费者反馈批 5bc4a570）。
   *
   * 与 update() 的整段覆盖语义并列的局部写通道：match 模式精确串替换 + 乐观锁 +
   * 幂等，契约对齐 DocSpace patchByMatch（doc.service.ts）：
   * - 0 命中 → 404 DOC_NOT_FOUND（提示先读详情核对 oldString）；
   * - >1 命中 → 409 RESOURCE_CONFLICT + data.matchCount（绝不静默挑选）；
   * - 恰好 1 命中 → 函数式 replacer 替换（newString 中的 $&/$1 按字面量处理）。
   *
   * 乐观锁：expectedDescriptionHash = sha256(description ?? '')（findOne 响应携带
   * descriptionHash）。事务内 FOR UPDATE 锁行后复核，不符 → 409 DOC_CONTENT_CONFLICT
   * + data.currentDescriptionHash 提示重读；缺省 = 无前提（不阻塞无锁调用方）。
   *
   * 幂等（clientRequestId 可选）：同 actor 同 key 重试返回首次响应快照 +
   * idempotentReplay（快照在业务事务内登记——业务提交 ⟺ 快照可查）；同 key 不同
   * payload → 409 IDEMPOTENCY_KEY_CONFLICT。并发同 key 撞 uq_idempotency_actor_key
   * （23505）→ 事务回滚后重读胜者快照返回（更新语义不能查回实体——文档已被首次
   * 请求改写，v1.63.0 教训）。
   *
   * 刻意不做内部重试（与 appendDoc 相反）：并发改动后 oldString 可能已消失，
   * 409/404 让调用方重读才是正确语义；FOR UPDATE 行锁已保证不丢更新。
   *
   * @param id 任务 ID
   * @param dto 请求体（oldString 必填非空；newString 可为空串 = 删除该片段）
   * @param actor 当前操作者（认证 guard 保证非空）
   * @returns { task, idempotentReplay? }——task 含新 descriptionHash
   * @throws NotFoundException(4000/10001) / ConflictException(9001/10009/9002)
   */
  async patchDescription(
    id: string,
    dto: PatchTaskDescriptionDto,
    actor: UnifiedActor,
  ): Promise<TaskPatchDescriptionResult> {
    const { oldString, newString, expectedDescriptionHash, clientRequestId } = dto;

    // ── 幂等上下文：无 key → null（零开销旁路）──
    const idemCtx = clientRequestId
      ? {
          actorKey: actor.id,
          clientRequestId,
          // canonical payload（字面量对象，key 顺序稳定）：含路由参数 taskId，
          // 同 key 换任务也视为不同 payload → 409
          requestHash: createHash('sha256')
            .update(JSON.stringify({ taskId: id, oldString, newString, expectedDescriptionHash }))
            .digest('hex'),
        }
      : null;

    // ── 入口重放查询（有 key 的快速路径）──
    if (idemCtx) {
      const record = await this.dataSource.getRepository(IdempotencyRecord).findOne({
        where: { actorId: idemCtx.actorKey, clientRequestId: idemCtx.clientRequestId },
      });
      if (record) {
        this.assertIdempotencyMatch(record, idemCtx, TASK_PATCH_DESCRIPTION_ENTITY_TYPE);
        const snapshot = record.responseSnapshot as TaskPatchDescriptionResult | null;
        if (!snapshot) {
          // 记录恒带快照；缺失说明数据被外部改动——防御性抛错而非返回残缺响应
          throw new InternalServerErrorException(
            `idempotency record for key '${idemCtx.clientRequestId}' is missing its response snapshot`,
          );
        }
        return { ...snapshot, idempotentReplay: true };
      }
    }

    // ── 主事务：锁行 → 乐观锁 → match → 替换 → save → 幂等记录（同事务）──
    try {
      const { response, oldDescription, newDescription, boardId, topicId } =
        await this.dataSource.transaction(async (manager) => {
          const taskRepo = manager.getRepository(Task);
          // FOR UPDATE 行锁：并发 patch 串行化，锁内复核的 oldString/descriptionHash
          // 不会在写入窗口内漂移（不丢更新；冲突语义交给调用方重读）
          const task = await taskRepo.findOne({
            where: { id },
            lock: { mode: 'pessimistic_write' },
          });
          if (!task) {
            throw new NotFoundException({
              message: 'Task not found',
              code: ErrorCode.TASK_NOT_FOUND,
            });
          }

          // 乐观锁前提：expectedDescriptionHash 与当前 description 哈希不符 → 409 +
          // currentDescriptionHash 提示重读（对齐 DocSpace expectedContentHash 语义）
          const currentHash = this.descriptionHash(task.description);
          if (expectedDescriptionHash && expectedDescriptionHash !== currentHash) {
            throw new ConflictException({
              message:
                'Task description has changed since the expected hash was captured; ' +
                're-read the task (GET /tasks/:id) to get the current descriptionHash and retry',
              code: ErrorCode.DOC_CONTENT_CONFLICT,
              data: { currentDescriptionHash: currentHash },
            });
          }

          // match 计数（split 段数 - 1 = 命中次数；空串 oldString 已在 DTO 层 400 拦截）
          const currentDescription = task.description ?? '';
          const matchCount = currentDescription.split(oldString).length - 1;
          if (matchCount === 0) {
            throw new NotFoundException({
              message:
                `oldString not found in the task description (0 matches); ` +
                `re-read the task (GET /tasks/:id) and retry`,
              code: ErrorCode.DOC_NOT_FOUND,
            });
          }
          if (matchCount > 1) {
            throw new ConflictException({
              message:
                `oldString matches ${matchCount} locations in the task description; ` +
                `expand oldString with more surrounding context to make it unique and retry`,
              code: ErrorCode.RESOURCE_CONFLICT,
              data: { matchCount },
            });
          }

          // 唯一命中：函数式 replacer（newString 中的 $&/$1 等模式按字面量处理，不被解释）
          const oldDescription = task.description;
          task.description = currentDescription.replace(oldString, () => newString);
          const saved = await taskRepo.save(task);

          // 组装响应（boardId/topicId 从 list→board 派生，与 update() 同款；
          // 只读查询，事务内外等价）
          const list = await this.boardListRepo.findOne({
            where: { id: saved.listId },
            relations: ['board'],
          });
          const response: TaskPatchDescriptionResult = {
            task: {
              ...this.toPlain(saved),
              boardId: list?.boardId ?? null,
              topicId: list?.board?.topicId ?? null,
              descriptionHash: this.descriptionHash(saved.description),
            },
          };

          // 幂等记录与业务写同事务：业务提交 ⟺ 快照可查（对齐 create() 骨架）
          if (idemCtx) {
            await manager.getRepository(IdempotencyRecord).save({
              actorId: idemCtx.actorKey,
              clientRequestId: idemCtx.clientRequestId,
              entityType: TASK_PATCH_DESCRIPTION_ENTITY_TYPE,
              entityId: id,
              // 快照列类型为 Record<string, unknown>，接口形状需显式 cast（照 report 先例）
              responseSnapshot: response as unknown as Record<string, unknown>,
              requestHash: idemCtx.requestHash,
            });
          }

          return {
            response,
            oldDescription,
            newDescription: saved.description,
            boardId: list?.boardId ?? null,
            topicId: list?.board?.topicId ?? null,
          };
        });

      // ── 事务提交后副作用（照 update() 对 description 变更的既有行为）──
      await this.eventService.create({
        eventType: EventType.TASK_UPDATE,
        resourceType: 'task',
        resourceId: id,
        topicId: topicId ?? undefined,
        boardId: boardId ?? undefined,
        actorId: actor.id,
        actorType: actor.type,
        payload: { taskId: id, action: 'updated', fieldName: 'description' },
      });

      if (actor.id) {
        await this.activityRepo.save({
          taskId: id,
          action: 'updated',
          fieldName: 'description',
          oldValue: oldDescription,
          newValue: newDescription,
          actorId: actor.id,
          actorType: actor.type ?? ActorType.HUMAN,
          details: '更新了: description',
        });
      }

      return response;
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (idemCtx && pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key') {
        // 并发同 key：事务已回滚（业务写 + 幂等记录同事务），重读胜者快照返回——
        // 更新语义不能查回实体（文档已被首次请求改写，v1.63.0 教训）
        const record = await this.dataSource.getRepository(IdempotencyRecord).findOne({
          where: { actorId: idemCtx.actorKey, clientRequestId: idemCtx.clientRequestId },
        });
        if (record) {
          this.assertIdempotencyMatch(record, idemCtx, TASK_PATCH_DESCRIPTION_ENTITY_TYPE);
          const snapshot = record.responseSnapshot as TaskPatchDescriptionResult | null;
          if (snapshot) return { ...snapshot, idempotentReplay: true };
        }
      }
      throw err;
    }
  }

  async remove(id: string): Promise<boolean> {
    // 先校验任务存在性；findOne 找不到会抛 NotFoundException
    await this.findOne(id);
    // 使用 softDelete 避免 softRemove 对 loaded relations 的级联保存问题（B-49）
    await this.taskRepo.softDelete(id);
    return true;
  }

  async batchCreate(dto: BatchCreateTasksDto, actorId?: string, actorType?: ActorType) {
    const results: Task[] = [];

    for (const taskDto of dto.tasks) {
      const task = await this.create(taskDto, actorId, actorType);
      results.push(task as Task);
    }

    return { items: results, count: results.length };
  }

  async move(id: string, dto: MoveTaskDto, actorId?: string, actorType?: ActorType) {
    // 与 update 保持一致：用实体实例 save，避免 listId 等关联列变更丢失。
    const task = await this.findById(id);

    // 校验 listId 是否为有效 UUID（避免 PostgreSQL 类型错误导致 500）
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(dto.listId)) {
      throw new BadRequestException({
        message: 'listId must be a valid UUID',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    // 校验目标 list 是否存在（含 board 以派生 topicId）
    const list = await this.boardListRepo.findOne({
      where: { id: dto.listId },
      relations: ['board'],
    });
    if (!list)
      throw new NotFoundException({
        message: `List ${dto.listId} not found`,
        code: ErrorCode.LIST_NOT_FOUND,
      });

    const oldListId = task.listId;
    const oldStatus = task.status;
    task.listId = dto.listId;
    task.position = dto.position ?? dto.order ?? 0;

    // 智能状态联动：若目标列配置了 mappedStatus，自动同步任务状态
    let autoStatus = false;
    if (list.mappedStatus && task.status !== list.mappedStatus) {
      task.status = list.mappedStatus;
      autoStatus = true;

      // 状态机不变量
      if (task.status === TaskStatus.DONE) {
        task.completedAt = new Date();
      }
      if (task.status === TaskStatus.IN_PROGRESS && !task.startedAt) {
        task.startedAt = new Date();
      }
    }

    const saved = await this.taskRepo.save(task);

    await this.eventService.create({
      eventType: EventType.TASK_UPDATE,
      resourceType: 'task',
      resourceId: saved.id,
      topicId: list.board?.topicId ?? undefined,
      boardId: list.boardId ?? undefined,
      actorId,
      actorType,
      payload: {
        taskId: saved.id,
        action: 'moved',
        fromListId: oldListId,
        toListId: dto.listId,
        ...(autoStatus && { autoStatus: true, fromStatus: oldStatus, toStatus: saved.status }),
      },
    });

    if (actorId) {
      await this.activityRepo.save({
        taskId: id,
        action: 'moved',
        fieldName: 'listId',
        oldValue: oldListId,
        newValue: dto.listId,
        actorId,
        actorType: actorType ?? ActorType.HUMAN,
        details: '移动了任务',
      });

      if (autoStatus) {
        await this.activityRepo.save({
          taskId: id,
          action: 'updated',
          fieldName: 'status',
          oldValue: oldStatus,
          newValue: saved.status,
          actorId,
          actorType: actorType ?? ActorType.HUMAN,
          details: `状态从 ${oldStatus} 变为 ${saved.status}`,
        });
      }
    }
    return { ...this.toPlain(saved), boardId: list.boardId, topicId: list.board?.topicId ?? null };
  }

  async assign(id: string, dto: AssignTaskDto, actorId?: string, actorType?: ActorType) {
    const task = await this.findOne(id);
    const oldAssigneeId = task.assigneeId;
    if (dto.assigneeId) {
      // 统一批 A2.5（R14）：校验被指派 actor 存在且未软删——错误码由 USER_NOT_FOUND 统一为
      // AGENT_NOT_FOUND（"从未存在"与"已删除"消费方正确动作相同，单一语义，契约 docs/spec.md §1）
      await this.actorProfileService.assertActorUsable(dto.assigneeId);
      task.assigneeId = dto.assigneeId;
      task.assigneeType = (await this.resolveActorType(dto.assigneeId)) ?? null;
    } else {
      task.assigneeId = null;
      task.assigneeType = null;
    }
    const saved = await this.taskRepo.save(task);
    if (actorId) {
      await this.activityRepo.save({
        taskId: id,
        action: 'assigned',
        fieldName: 'assigneeId',
        oldValue: oldAssigneeId,
        newValue: task.assigneeId,
        actorId,
        actorType: actorType ?? ActorType.HUMAN,
        details: oldAssigneeId ? '重新分配了任务' : '分配了任务',
      });
    }
    return this.toPlain(saved);
  }

  /**
   * 获取任务评论列表。
   * @param id 任务 ID
   * @param limit 返回条数上限，默认 50，静默钳制到 [1, 200]
   */
  async getComments(id: string, limit?: number) {
    const parsed = +(limit ?? 50);
    const safeLimit = isNaN(parsed) ? 50 : Math.min(200, Math.max(1, parsed));
    return this.commentRepo.find({
      where: { taskId: id },
      order: { createdAt: 'DESC' },
      take: safeLimit,
    });
  }

  /**
   * 解析 Actor 显示名（统一批 A2：走公共 ActorProfileService——withDeleted 覆盖软删
   * actor，回退链 agents.name || displayName；真孤儿返回 null）
   * @param actorId 待解析的 actor id
   * @param _actorType 兼容旧签名保留（解析不再依赖调用方传入的类型，actors 表自证）
   */
  private async resolveActorName(
    actorId: string,
    _actorType?: ActorType | null,
  ): Promise<string | null> {
    const profile = (await this.actorProfileService.resolveProfiles([actorId])).get(actorId);
    return profile?.name ?? null;
  }

  async addComment(id: string, authorId: string, authorType: ActorType, dto: AddCommentDto) {
    // 先校验任务存在性；findOne 找不到会抛 NotFoundException
    await this.findOne(id);
    const authorName = await this.resolveActorName(authorId, authorType);
    const comment = this.commentRepo.create({
      taskId: id,
      authorId,
      authorType,
      authorName,
      content: dto.content,
    });
    const saved = await this.commentRepo.save(comment);
    await this.activityRepo.save({
      taskId: id,
      action: 'commented',
      actorId: authorId,
      actorType: authorType ?? ActorType.HUMAN,
      details: `添加了评论`,
    });
    return saved;
  }

  /**
   * 获取任务活动日志列表（统一批 A2：批量注入 actorName + actorDeletedAt——现状前端
   * fallback 显示裸 UUID，软删执行者也能解析出真名；真孤儿 actorName 为 null 由消费方兜底）。
   * @param id 任务 ID
   * @param limit 返回条数上限，默认 50，静默钳制到 [1, 200]
   */
  async getActivities(id: string, limit?: number) {
    const parsed = +(limit ?? 50);
    const safeLimit = isNaN(parsed) ? 50 : Math.min(200, Math.max(1, parsed));
    const activities = await this.activityRepo.find({
      where: { taskId: id },
      order: { createdAt: 'DESC' },
      take: safeLimit,
    });
    const actorIds = [...new Set(activities.map((a) => a.actorId).filter(Boolean))];
    const profileMap =
      actorIds.length > 0 ? await this.actorProfileService.resolveProfiles(actorIds) : new Map();
    return activities.map((a) => {
      const profile = a.actorId ? profileMap.get(a.actorId) : undefined;
      return {
        ...a,
        // 注入执行者真名（含软删 actor——withDeleted 查询），真孤儿 null
        actorName: profile?.name ?? null,
        // 软删信号：非空 = 执行者已删除，actorName 仍可显示（契约 docs/spec.md §1）
        actorDeletedAt: profile?.deletedAt ? profile.deletedAt.toISOString() : null,
      };
    });
  }

  /**
   * 更新 Agent 的最后活跃时间。
   * 仅当 actorType 为 AGENT 且数据库中存在对应 Agent 时执行。
   */
  private async touchAgentLastActiveAt(
    actorId: string | undefined,
    actorType: ActorType | undefined,
  ): Promise<void> {
    if (actorType !== ActorType.AGENT || !actorId) return;
    const agent = await this.agentRepo.findOne({ where: { id: actorId } });
    if (agent) {
      agent.lastActiveAt = new Date();
      await this.agentRepo.save(agent);
    }
  }

  // ─── Doc Links ──────────────────────────────────────────────

  /**
   * Add a document link to a task.
   * Idempotent — re-adding the same doc returns the existing link.
   */
  async addDocLink(taskId: string, docId: string, actor: UnifiedActor) {
    // Verify doc exists and is not soft-deleted
    const doc = await this.docRepo
      .createQueryBuilder('d')
      .where('d.id = :docId', { docId })
      .andWhere('d.deleted_at IS NULL')
      .getOne();

    if (!doc) {
      throw new NotFoundException({
        message: 'Document not found',
        code: ErrorCode.DOC_NOT_FOUND,
      });
    }

    // Verify actor has read access to the doc's space
    const space = await this.docSpaceRepo
      .createQueryBuilder('ds')
      .where('ds.id = :spaceId', { spaceId: doc.spaceId })
      .andWhere('ds.deleted_at IS NULL')
      .getOne();

    if (!space) {
      throw new NotFoundException({
        message: 'DocSpace not found',
        code: ErrorCode.DOC_SPACE_NOT_FOUND,
      });
    }

    const canRead = await this.docSpacePolicy.can(actor, space, 'read');
    if (!canRead) {
      throw new ForbiddenException({
        message: 'No read access to document space',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    // Idempotent check
    const existing = await this.docLinkRepo.findOne({ where: { taskId, docId } });
    if (existing) return existing;

    const link = this.docLinkRepo.create({ taskId, docId, createdBy: actor.id });
    return this.docLinkRepo.save(link);
  }

  /**
   * Remove a document link from a task.
   */
  async removeDocLink(taskId: string, docId: string): Promise<boolean> {
    const link = await this.docLinkRepo.findOne({ where: { taskId, docId } });
    if (!link) {
      throw new NotFoundException({
        message: 'Document link not found',
        code: ErrorCode.DOC_LINK_NOT_FOUND,
      });
    }

    await this.docLinkRepo.remove(link);
    return true;
  }

  // ─── Task Report（POST /tasks/:id/report 后端化编排）──────────

  /**
   * 任务结果汇报（原 MCP report_task_result 编排下沉后端）。
   *
   * 执行顺序：评论（可选）→ 状态 → 逐 doc 关联文档；与既有 MCP 编排逐字节一致。
   * - 评论拼接规则：仅 comment → 原文；仅 commitSha → "Commit: <sha>"；
   *   二者都有 → comment + "\n\nCommit: <sha>"（空字符串视为未提供）。
   * - docLinks 逐条 try/catch：单条失败内嵌 {docId,status,code,error} 不拖垮主体
   *   （addDocLink 幂等，重复关联返回既有链接，天然安全）。
   *
   * 幂等（clientRequestId 可选）：
   * - 无 key → 原路径零开销（无任何幂等记录读写）。
   * - 有 key → 入口先查记录：命中且 hash 不符（或 entityType 非 task_report）→ 409
   *   IDEMPOTENCY_KEY_CONFLICT（9002，防同 key 不同 payload 被静默吞写）；
   *   命中且快照含 task 且（未请求 docIds 或快照已含 docLinks）→ 直接返回快照 +
   *   idempotentReplay:true（零副作用重放）。
   * - 部分成功恢复路径（不做跨步骤事务——update() 太大不值得重构）：
   *   评论成功先写快照 {comment} 再改状态；状态成功写 {comment?,task}；docLinks 完成
   *   写全量。重试命中快照 → 跳过已完成步骤只补未完步骤，绝不重复发评论。
   *   无 key 调用方：状态步骤失败且本次已发评论时，错误响应 data 槽带
   *   commentPosted:true（MCP 层归一为 details.commentPosted），盲重试可先自查评论。
   * - 并发同 key：靠 uq_idempotency_actor_key 23505 catch 重读胜者快照继续（照
   *   doc-idempotency.helper 范式）；并发窗口内双方都可能已发评论（无共享事务，
   *   幂等保证的是「重试」而非「并发首击」）。
   *
   * @param id   任务 ID
   * @param dto  请求体（status 必填）
   * @param actor 当前操作者（认证 guard 保证非空）
   * @returns { task, comment?, docLinks?, idempotentReplay? }
   * @throws NotFoundException / 上游 4xx 透传（铁律 #9，不包装为 500）；
   *         ConflictException(9002) 同 key 不同 payload
   */
  async reportResult(
    id: string,
    dto: ReportTaskResultDto,
    actor: UnifiedActor,
  ): Promise<TaskReportResult> {
    const { status, comment, commitSha, docIds, clientRequestId } = dto;
    const hasCommentText = comment !== undefined && comment !== '';
    const hasCommitSha = commitSha !== undefined && commitSha !== '';
    const shouldComment = hasCommentText || hasCommitSha;
    const shouldDocLinks = docIds !== undefined && docIds.length > 0;

    // ── 幂等上下文：无 key → null（零开销旁路）──
    const idemCtx = clientRequestId
      ? {
          actorKey: actor.id,
          clientRequestId,
          // canonical payload（字面量对象，key 顺序稳定）：含路由参数 taskId，
          // 同 key 换任务也视为不同 payload → 409
          requestHash: createHash('sha256')
            .update(JSON.stringify({ taskId: id, status, comment, commitSha, docIds }))
            .digest('hex'),
        }
      : null;

    const result: TaskReportResult = {} as TaskReportResult;
    let idemRecord: IdempotencyRecord | null = null;
    // 本次调用是否实际发了评论（步骤 1 真正执行 addComment 才置位；从快照恢复的
    // result.comment 不算）——状态步骤失败时用它给错误响应打 commentPosted 标记
    let commentPostedThisRun = false;

    // ── 入口重放查询（有 key 的快速路径）──
    if (idemCtx) {
      idemRecord = await this.dataSource.getRepository(IdempotencyRecord).findOne({
        where: { actorId: idemCtx.actorKey, clientRequestId: idemCtx.clientRequestId },
      });
      if (idemRecord) {
        this.assertIdempotencyMatch(idemRecord, idemCtx, TASK_REPORT_ENTITY_TYPE);
        const snapshot = idemRecord.responseSnapshot as Partial<TaskReportResult> | null;
        if (snapshot?.task) {
          if (!(shouldDocLinks && !snapshot.docLinks)) {
            // 完整快照（或请求本就无 docIds）→ 直接回放，零副作用
            return { ...(snapshot as TaskReportResult), idempotentReplay: true };
          }
          // 恢复路径：状态已完成但 docLinks 未跑（首次在 link 步骤前中断）→
          // 复用快照中的 task/comment，只补跑 docLinks
          result.task = snapshot.task as Record<string, unknown>;
          if (snapshot.comment !== undefined) result.comment = snapshot.comment;
        } else if (snapshot?.comment !== undefined) {
          // 恢复路径：评论已完成（checkpoint）→ 跳过评论，继续改状态
          result.comment = snapshot.comment;
        }
      }
    }

    // ── 步骤 1：发评论（仅当 comment/commitSha 提供；快照已含 comment 则跳过）──
    if (shouldComment && result.comment === undefined) {
      let commentText = '';
      if (hasCommentText && hasCommitSha) {
        commentText = `${comment}\n\nCommit: ${commitSha}`;
      } else if (hasCommentText) {
        commentText = comment!;
      } else {
        commentText = `Commit: ${commitSha}`;
      }
      // 失败向上透传（4xx 原样），status 未被触碰
      result.comment = await this.addComment(id, actor.id, actor.type, { content: commentText });
      commentPostedThisRun = true;
      // checkpoint：评论结果先落快照再改状态——此后重试不得重复发评论
      if (idemCtx) {
        idemRecord = await this.checkpointReportSnapshot(idemCtx, id, result, idemRecord);
      }
    }

    // ── 步骤 2：改状态（快照已含 task 的恢复路径跳过）──
    if (result.task === undefined) {
      try {
        result.task = await this.update(id, { status }, actor.id, actor.type);
      } catch (err: unknown) {
        // 部分成功语义显式化：本次已发评论而状态步骤失败 → 异常响应 data 槽增补
        // commentPosted:true（信封约定：异常 body.data 原样透出，见 all-exceptions.filter；
        // MCP 层归一到 PlatformApiError.details）。仅注入 HttpException 的对象型响应体，
        // 非 HttpException 原样透传不包（铁律 #9）。幂等恢复路径不受影响：checkpoint
        // {comment} 已先落库，带 key 重试仍会跳过评论步骤。
        if (commentPostedThisRun && err instanceof HttpException) {
          const resp = err.getResponse();
          if (typeof resp === 'object' && resp !== null) {
            (resp as Record<string, unknown>).data = { commentPosted: true };
          }
        }
        throw err;
      }
      if (idemCtx) {
        idemRecord = await this.checkpointReportSnapshot(idemCtx, id, result, idemRecord);
      }
    }

    // ── 步骤 3（可选）：逐 doc 关联文档 ──
    if (shouldDocLinks) {
      result.docLinks = await this.runDocLinks(id, docIds!, actor);
      if (idemCtx) await this.checkpointReportSnapshot(idemCtx, id, result, idemRecord);
    }

    return result;
  }

  /**
   * 逐 doc 关联任务（单条失败内嵌，不拖垮主体）。
   *
   * 失败项形状对齐 MCP report_task_result 的 docLinks.failed：
   * { docId, status?, code?, error }——Nest 异常提取 status/code，
   * 未知异常仅 error。重复关联既有 link 由 addDocLink 幂等消化（返回既有链接，非失败）。
   */
  private async runDocLinks(
    taskId: string,
    docIds: string[],
    actor: UnifiedActor,
  ): Promise<{ succeeded: string[]; failed: TaskDocLinkFailure[] }> {
    const succeeded: string[] = [];
    const failed: TaskDocLinkFailure[] = [];
    for (const docId of docIds) {
      try {
        await this.addDocLink(taskId, docId, actor);
        succeeded.push(docId);
      } catch (err: unknown) {
        failed.push(this.extractDocLinkFailure(docId, err));
      }
    }
    return { succeeded, failed };
  }

  /**
   * 归一化 doc-link 失败项：Nest HttpException → {status, code?, error}；
   * 其余异常 → {error}。code 取自异常响应体（Nest 业务错误信封的 code 字段）。
   */
  private extractDocLinkFailure(docId: string, err: unknown): TaskDocLinkFailure {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const resp = err.getResponse();
      const body = typeof resp === 'string' ? { message: resp } : (resp as Record<string, unknown>);
      return {
        docId,
        status,
        ...(typeof body.code === 'number' || typeof body.code === 'string'
          ? { code: body.code }
          : {}),
        error: typeof body.message === 'string' ? body.message : err.message,
      };
    }
    return { docId, error: err instanceof Error ? err.message : String(err) };
  }

  /**
   * 幂等记录 hash/entityType 校验（对齐 doc-idempotency.helper 语义）：
   * entityType 非预期值、request_hash 缺失或与当前 payload 不符 → 409，
   * 防「同 key 不同 payload 第二次写被静默吞掉」。
   *
   * @param entityType 本入口的幂等 entityType（task_report / task_description 等）
   */
  private assertIdempotencyMatch(
    record: IdempotencyRecord,
    ctx: { clientRequestId: string; requestHash: string },
    entityType: string,
  ): void {
    if (
      record.entityType !== entityType ||
      !record.requestHash ||
      record.requestHash !== ctx.requestHash
    ) {
      throw new ConflictException({
        message:
          `clientRequestId '${ctx.clientRequestId}' was already used by a different request ` +
          `(entityType=${record.entityType}${record.requestHash ? ', requestHash mismatch' : ', legacy record without requestHash'}). ` +
          'Reusing an idempotency key with a different payload is rejected to prevent silent write loss; generate a new key to proceed',
        code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
      });
    }
  }

  /**
   * 幂等快照 checkpoint：评论/状态/docLinks 每步成功后写/更新 response_snapshot。
   *
   * - 已有记录（顺序重试恢复）→ 更新快照后返回；
   * - 首次 → 插入记录；撞 uq_idempotency_actor_key（并发同 key）→ 重读胜者记录，
   *   hash 校验后返回胜者记录（调用方按其快照继续/回放）。
   *
   * @returns 生效的幂等记录（调用方用于后续 checkpoint）
   */
  private async checkpointReportSnapshot(
    ctx: { actorKey: string; clientRequestId: string; requestHash: string },
    taskId: string,
    snapshot: TaskReportResult,
    existing: IdempotencyRecord | null,
  ): Promise<IdempotencyRecord> {
    const repo = this.dataSource.getRepository(IdempotencyRecord);
    if (existing) {
      existing.responseSnapshot = snapshot as unknown as Record<string, unknown>;
      return repo.save(existing);
    }
    try {
      return await repo.save({
        actorId: ctx.actorKey,
        clientRequestId: ctx.clientRequestId,
        entityType: TASK_REPORT_ENTITY_TYPE,
        entityId: taskId,
        responseSnapshot: snapshot as unknown as Record<string, unknown>,
        requestHash: ctx.requestHash,
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key') {
        const winner = await repo.findOne({
          where: { actorId: ctx.actorKey, clientRequestId: ctx.clientRequestId },
        });
        if (winner) {
          this.assertIdempotencyMatch(winner, ctx, TASK_REPORT_ENTITY_TYPE);
          return winner;
        }
      }
      throw err;
    }
  }
}
