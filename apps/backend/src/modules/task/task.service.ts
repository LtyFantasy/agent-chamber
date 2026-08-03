/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.3 (Board / Task)
 *   - 补充: docs/api-definition.md §7. Tasks, docs/spec.md §3.2 TaskStatus
 *
 * [踩坑索引] B-50(列表权限过滤) B-50-EVT(任务事件boardId) B-42(单对象返回null) B-49(softDelete500) B-3(completedAt缺失) B-4(move到不存在的list) D5(权限迁移) P1-1(findOne载荷瘦身) Batch1-P2(milestone绑定校验) Batch3(topicId下线)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #7(测试绑定) #9(代理层透传)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
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
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
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
} from './dto';
import { EventService } from '../event/event.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ResourceValidator } from '../../common/resource-validator';
import { UnifiedActor } from '../../common/types/actor.types';
import { DocSpacePolicy } from '../../common/policies/doc-space.policy';
import type { PaginatedResponse, TaskSummary } from '@agent-chamber/shared';
import type { TaskDocLinkItem } from '@agent-chamber/shared';

export interface TaskWithBlockers extends Task {
  blockers?: TaskDependency[];
  assigneeName?: string | null;
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
      .leftJoinAndSelect('task.list', 'list')
      .leftJoinAndSelect('list.board', 'board')
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

    qb.orderBy('task.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();

    // 批量查询所有 assignee 的名称，避免 N+1
    const assigneeIds = items.map((t) => t.assigneeId).filter(Boolean) as string[];
    const uniqueIds = [...new Set(assigneeIds)];

    const [agents, users] = await Promise.all([
      uniqueIds.length > 0 ? this.agentRepo.findBy({ id: In(uniqueIds) }) : Promise.resolve([]),
      uniqueIds.length > 0 ? this.userRepo.findBy({ id: In(uniqueIds) }) : Promise.resolve([]),
    ]);

    const nameMap = new Map<string, string>();
    agents.forEach((a) => nameMap.set(a.id, a.name));
    users.forEach((u) => nameMap.set(u.id, u.displayName || u.username || '未知用户'));

    const enrichedItems = items.map((task) => {
      const { description: _desc, ...plain } = this.toPlain(task);
      return {
        ...plain,
        // Task 不存储 boardId/topicId，从已 join 的 list→board 推断
        boardId: task.list?.boardId ?? null,
        topicId: task.list?.board?.topicId ?? null,
        assigneeName: task.assigneeId ? nameMap.get(task.assigneeId) || null : null,
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
      const assigneeType = await this.resolveActorType(plain.assigneeId);
      plain.assigneeName = await this.resolveActorName(plain.assigneeId, assigneeType);
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

    return { ...plain, boardId: taskList?.boardId ?? null, docs };
  }

  async create(dto: CreateTaskDto, actorId?: string, actorType?: ActorType) {
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
    const assigneeType = assigneeId ? await this.resolveActorType(assigneeId) : null;

    const { clientRequestId, boardId: _boardId, ...taskDto } = dto;

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
      // 校验被指派的 Actor 真实存在，避免幽灵分配（Phase 2）
      const actor = await this.resourceValidator.exists(
        this.actorRepo,
        dto.assigneeId,
        ErrorCode.USER_NOT_FOUND,
      );
      task.assigneeId = dto.assigneeId;
      task.assigneeType = actor.type;
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

  private async resolveActorName(
    actorId: string,
    actorType?: ActorType | null,
  ): Promise<string | null> {
    try {
      const type = actorType ?? (await this.resolveActorType(actorId));
      if (type === ActorType.AGENT) {
        const agent = await this.agentRepo.findOne({ where: { id: actorId } });
        return agent?.name ?? null;
      }
      if (type === ActorType.HUMAN) {
        const user = await this.userRepo.findOne({ where: { id: actorId } });
        return user?.displayName || user?.username || null;
      }
      return null;
    } catch {
      return null;
    }
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
   * 获取任务活动日志列表。
   * @param id 任务 ID
   * @param limit 返回条数上限，默认 50，静默钳制到 [1, 200]
   */
  async getActivities(id: string, limit?: number) {
    const parsed = +(limit ?? 50);
    const safeLimit = isNaN(parsed) ? 50 : Math.min(200, Math.max(1, parsed));
    return this.activityRepo.find({
      where: { taskId: id },
      order: { createdAt: 'DESC' },
      take: safeLimit,
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
}
