/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.3 (Board / Task)
 *   - 补充: PROJECT.md §1.5.2 可见性继承规则
 *   - 任务分页: docs/api-definition.md §7（Boards/Tasks 分页与字段精简契约，v1.16.0）
 *   D5: canAccess()/effectiveVisibility() 已从 Service 删除，权限检查迁移到 Controller。
 *         Service 只做业务：findById() + enrich()。见 memory/2026-06-05.md
 *   BoardDetail 与 tasks 解耦：findById 不再 join tasks，taskCount 通过 QueryBuilder 聚合。
 *   MINE-QUERY(v1.70): findAll 收到 mine=true 走 AccessQueryService.getMyBoardIds
 *         （creator+member 去 open 源，admin 不短路）。缓存键 board:mine:<actorKey> 前缀隔离。
 *
 * [踩坑索引] B-45(reorder返回null) B-41(列表页任务统计0/0) B-5(可见性缺失) B-6(可见性继承缺失) D5(权限迁移) B-50(列表权限过滤) B-52(creator缺成员行) R1(公共解析收口) A2.5(写入口assertActorUsable) A2.5b(移除入口不拦截+create/update补齐)
 *
 * [铁律关联] #18(不变量检查) #4(文档优先) #12(文档联动)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   A2.5b: 拦截只针对"新增引用"——removeEditor/uninviteAgent 回退
 *       resourceValidator.exists（软删 agent 的 agents 行永在，移除=清理动作必须可用，
 *       否则已删成员行永远无法清理）；create/update invitedAgentIds 补齐
 *       assertActorUsable（create 一刀切；update 只拦 toAdd——存量含已删成员不拦，
 *       set 语义全量替换否则永远无法保存）。2026-08-26 统一批 A2.5b 修正。
 *   A2.5: 新增类写入口（addEditor/inviteAgent + create/update invitedAgentIds）走
 *       ActorProfileService.assertActorUsable（存在+未软删两态，404 AGENT_NOT_FOUND，
 *       覆盖"从未存在"与"已删除"——契约 docs/spec.md §1 规则 6）。2026-08-26 统一批 A2.5。
 *   R1: Actor.deletedAt 是 @DeleteDateColumn({ select: false })——withDeleted 只解除过滤不选
 *       列。本文件所有 actor 投影（enrich 成员 / digest assignee）一律经 ActorProfileService
 *       .resolveProfiles 取 deletedAt/type/name，禁止散落 queryBuilder 或自建 actors 查询
 *       （收口见 common/services/actor-profile.service.ts，契约 docs/spec.md §1）。2026-08-26 统一批 A2。
 *   B-52: create() 历史上只给 invitedAgentIds 写成员行，creator 不落表——成员列表缺席
 *         + AccessQueryService 按成员表算可见性对 creator 不命中（4b1ddd1c）。修复：
 *         creator 落 role='editor' 且 invitedBy=null 行，invited 列表过滤 creator 防
 *         PK 冲突；removeEditor/uninviteAgent 对 creator 拒绝（409），防 bug 经删除
 *         路径复活。存量数据由 BackfillCreatorMembership1787300000000 回填
 *   BoardDetail 不再 join tasks: findById relations 改为 ['lists']；enrich 通过 QueryBuilder
 *     聚合 taskCount / completedTaskCount / 每列 taskCount，避免大 Board 全量加载任务。
 *   B-45: reorderLists/reorderTasks 返回 null。TypeORM 实体序列化时动态赋值丢失。
 *         修复：返回 plain object 数组 [ { ...entity } ] 而非实体数组。
 *         见 memory/2026-06-05.md
 *   B-41: Board findAll 列表页任务统计始终显示 0/0。TypeORM 实体动态赋值在 NestJS
 *         序列化时被数据库原始值覆盖。修复：显式展开为 plain object
 *         { ...b, taskCount, completedTaskCount }。见 memory/2026-06-04.md §11
 *   B-50: Topic/Board 列表接口在 Controller 层过滤，导致分页 total 与 items 不一致。
 *         修复：findAll 接收 actor，改为 QueryBuilder 在 Service 层加 IN 过滤，空白名单
 *         直接返回空分页，保持 total 与 items 同源。见 Plan §2.3 / §2.4。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not } from 'typeorm';
import { Board } from '../../database/entities/board.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { BoardMember } from '../../database/entities/board-member.entity';
import {
  Visibility,
  ErrorCode,
  ActorType,
  TaskStatus,
  MilestoneStatus,
  BoardMemberRole,
  EventType,
  ResourceType,
  Priority,
  SEAT_LIFECYCLE_STATUS,
  TopicKind,
} from '@agent-chamber/shared';
import type {
  BoardDetail,
  BoardListSummary,
  BoardDigest,
  BoardDigestList,
  BoardDigestMilestone,
  BoardDigestVersionRef,
  BoardDigestRisk,
  BoardDigestOpenTask,
  BoardDigestDoneTask,
  BoardDigestDocs,
  PaginatedResponse,
  TaskSummary,
} from '@agent-chamber/shared';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ResourceValidator } from '../../common/resource-validator';
import { UnifiedActor } from '../../common/types/actor.types';
import { ActorProfileService, ActorProfile } from '../../common/services/actor-profile.service';
import { BoardList } from '../../database/entities/board-list.entity';
import { Task } from '../../database/entities/task.entity';
import { TaskService } from '../task/task.service';
import { EventService } from '../event/event.service';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Doc } from '../../database/entities/doc.entity';
import { Milestone } from '../../database/entities/milestone.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { Message } from '../../database/entities/message.entity';
import { QueryTaskDto } from '../task/dto';
import {
  CreateBoardDto,
  UpdateBoardDto,
  CreateBoardListDto,
  ReorderBoardListsDto,
  UpdateBoardListDto,
  ReorderTasksDto,
  FindListTasksQueryDto,
  BoardDigestQueryDto,
} from './dto';

@Injectable()
export class BoardService {
  constructor(
    @InjectRepository(Board)
    private boardRepo: Repository<Board>,
    @InjectRepository(BoardList)
    private listRepo: Repository<BoardList>,
    @InjectRepository(Task)
    private taskRepo: Repository<Task>,
    @InjectRepository(Topic)
    private topicRepo: Repository<Topic>,
    @InjectRepository(BoardMember)
    private memberRepo: Repository<BoardMember>,
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Actor)
    private actorRepo: Repository<Actor>,
    private readonly accessQuery: AccessQueryService,
    private readonly resourceValidator: ResourceValidator,
    private readonly taskService: TaskService,
    private readonly eventService: EventService,
    @InjectRepository(DocSpace)
    private docSpaceRepo: Repository<DocSpace>,
    // v1.41 digest：绑定空间内最近更新文档（updatedAt desc top N）
    @InjectRepository(Doc)
    private docRepo: Repository<Doc>,
    // v1.41 digest：里程碑元数据 + 批量 stats（无模块循环依赖——实体注册仅依赖表）
    @InjectRepository(Milestone)
    private milestoneRepo: Repository<Milestone>,
    // v1.44.0-dev digest：roundtable 段实时装配（圆桌 topic/座位/座位消息，平台级口径；
    // 实体注册仅依赖表，无模块循环依赖——对齐 milestoneRepo 惯例）
    @InjectRepository(RoundtableSeat)
    private seatRepo: Repository<RoundtableSeat>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    private readonly actorProfileService: ActorProfileService,
  ) {}

  /**
   * 批量聚合 Actor 公开信息（类型、显示名、头像、描述）
   * 统一批 A1 收敛：委托 ActorProfileService（返回元素新增 deletedAt 信号；
   * 软删 actor 解析出真名 + 真实 type，不再是 'Unknown'/被过滤——契约变更见
   * docs/spec.md §1；真孤儿不进 map，由调用方兜底）。
   */
  private async resolveActorProfiles(actorIds: string[]): Promise<Map<string, ActorProfile>> {
    return this.actorProfileService.resolveProfiles(actorIds);
  }

  /** 原始查询：按 ID 查找 Board（含 lists，不再 join tasks），不做权限检查 */
  async findById(id: string): Promise<Board> {
    const board = await this.boardRepo.findOne({
      where: { id },
      relations: ['lists'],
    });
    if (!board) {
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });
    }
    return board;
  }

  /** 查询看板下所有列的元数据（不含 tasks） */
  async findLists(boardId: string): Promise<BoardListSummary[]> {
    const lists = await this.listRepo.find({
      where: { boardId, deletedAt: IsNull() },
      order: { position: 'ASC', createdAt: 'ASC' },
    });

    const listIds = lists.map((l) => l.id);
    const taskCounts =
      listIds.length > 0
        ? await this.taskRepo
            .createQueryBuilder('task')
            .select('task.list_id', 'listId')
            .addSelect('COUNT(*)', 'count')
            .where('task.list_id IN (:...listIds)', { listIds })
            .andWhere('task.deleted_at IS NULL')
            .groupBy('task.list_id')
            .getRawMany()
        : [];
    const countMap = new Map(taskCounts.map((c) => [c.listId, parseInt(c.count, 10)]));

    return lists.map((list) => ({
      id: list.id,
      boardId: list.boardId,
      name: list.name,
      position: list.position,
      color: list.color,
      mappedStatus: list.mappedStatus,
      taskCount: countMap.get(list.id) ?? 0,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
    }));
  }

  /** 查询指定列下的任务列表（按列分页） */
  async findListTasks(
    boardId: string,
    listId: string,
    query: FindListTasksQueryDto,
    actor?: UnifiedActor,
  ): Promise<PaginatedResponse<TaskSummary>> {
    const list = await this.listRepo.findOne({ where: { id: listId } });
    if (!list || list.boardId !== boardId) {
      throw new NotFoundException({ message: 'List not found', code: ErrorCode.LIST_NOT_FOUND });
    }

    const status = query.status ?? [TaskStatus.BACKLOG, TaskStatus.IN_PROGRESS];

    return this.taskService.findAll(
      {
        listId,
        status: status as TaskStatus | TaskStatus[] | 'all',
        page: query.page,
        pageSize: query.pageSize,
      } as QueryTaskDto,
      actor,
    );
  }

  /** 计算并附加动态字段（taskCount / completedTaskCount / listCount / members） */
  async enrich(board: Board): Promise<BoardDetail> {
    // 按 position 稳定排序 lists，position 相同时按 createdAt 兜底
    const sortedLists = board.lists
      ? [...board.lists]
          .filter((l) => !l.deletedAt)
          .sort((a, b) => {
            const posDiff = (a.position ?? 0) - (b.position ?? 0);
            if (posDiff !== 0) return posDiff;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          })
      : [];

    // 查询 board_members 表组装成员列表
    const members = await this.memberRepo.find({
      where: { boardId: board.id },
      order: { createdAt: 'ASC' },
    });
    const memberActorIds = members.map((m) => m.actorId);
    const profileMap = await this.resolveActorProfiles(memberActorIds);
    const memberList = members.map((m) => {
      const profile = profileMap.get(m.actorId);
      return {
        id: m.actorId,
        // 'Unknown' 兜底仅留真孤儿（actors 表无行，公共服务不进 map——R12）
        name: profile?.name || 'Unknown',
        type: (profile?.type === ActorType.HUMAN ? 'human' : 'agent') as 'human' | 'agent',
        avatarUrl: profile?.avatarUrl ?? null,
        // 软删信号透传：非空 = 该成员已删除，name 仍可显示（契约 docs/spec.md §1）
        deletedAt: profile?.deletedAt ? profile.deletedAt.toISOString() : null,
        role: m.role as BoardMemberRole,
        invitedBy: m.invitedBy,
        createdAt: m.createdAt,
      };
    });

    // 按列聚合未删除任务数（BoardDetail 不再 join tasks）
    const listIds = sortedLists.map((l) => l.id);
    const taskCounts =
      listIds.length > 0
        ? await this.taskRepo
            .createQueryBuilder('task')
            .select('task.list_id', 'listId')
            .addSelect('COUNT(*)', 'count')
            .where('task.list_id IN (:...listIds)', { listIds })
            .andWhere('task.deleted_at IS NULL')
            .groupBy('task.list_id')
            .getRawMany()
        : [];
    const countMap = new Map(taskCounts.map((c) => [c.listId, parseInt(c.count, 10)]));

    // 聚合整个 Board 的任务数与已完成数
    const { total: taskCount, completed: completedTaskCount } = await this.countTasksByBoard(
      board.id,
    );

    const listSummaries: BoardListSummary[] = sortedLists.map((list) => ({
      id: list.id,
      boardId: list.boardId,
      name: list.name,
      position: list.position,
      color: list.color,
      mappedStatus: list.mappedStatus,
      taskCount: countMap.get(list.id) ?? 0,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
    }));

    // 显式展开为 plain object，规避 TypeORM 实体序列化时动态赋值属性被覆盖（B-41 教训）
    return {
      ...board,
      lists: listSummaries,
      taskCount,
      completedTaskCount,
      listCount: sortedLists.length,
      visibility: board.settings?.visibility,
      members: memberList,
    };
  }

  /**
   * 按 Board 聚合未删除任务总数与已完成数
   */
  private async countTasksByBoard(boardId: string): Promise<{ total: number; completed: number }> {
    const lists = await this.listRepo.find({
      where: { boardId, deletedAt: IsNull() },
      select: ['id'],
    });
    const listIds = lists.map((l) => l.id);
    if (listIds.length === 0) return { total: 0, completed: 0 };

    const result = await this.taskRepo
      .createQueryBuilder('task')
      .select('COUNT(*)', 'total')
      .addSelect(`SUM(CASE WHEN task.status = :done THEN 1 ELSE 0 END)`, 'completed')
      .where('task.list_id IN (:...listIds)', { listIds })
      .andWhere('task.deleted_at IS NULL')
      .setParameter('done', TaskStatus.DONE)
      .getRawOne();

    return {
      total: parseInt(result?.total ?? '0', 10),
      completed: parseInt(result?.completed ?? '0', 10),
    };
  }

  /**
   * 列表查询：在 Service 层按 Actor 权限做 IN 过滤，保证分页 total 与 items 同源。
   * 不再 join tasks，改为批量聚合查询 taskCount / completedTaskCount。
   * @param query - 分页/话题过滤条件；mine=true 时走 AccessQueryService.getMyBoardIds
   *   （creator+member 去 open 源，admin 不短路——admin 求 mine 也只是 creator/member 身份）
   * @param actor - 当前统一身份；Admin 不过滤（mine=false 时返回 null → 全量），
   *   非 Admin 用白名单 IN 过滤
   */
  async findAll(
    query: { page?: number; pageSize?: number; topicId?: string; mine?: boolean } = {},
    actor?: UnifiedActor,
  ) {
    const { page = 1, pageSize = 20, topicId, mine = false } = query;

    const accessibleBoardIds = mine
      ? await this.accessQuery.getMyBoardIds(actor)
      : await this.accessQuery.getAccessibleBoardIds(actor);
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

    const qb = this.boardRepo.createQueryBuilder('board').where('board.deleted_at IS NULL');

    if (accessibleBoardIds) {
      qb.andWhere('board.id IN (:...accessibleBoardIds)', { accessibleBoardIds });
    }
    if (topicId) {
      qb.andWhere('board.topic_id = :topicId', { topicId });
    }

    const [items, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .orderBy('board.createdAt', 'DESC')
      .getManyAndCount();

    // 批量聚合每个 Board 的任务数（不再 join tasks）
    const boardIds = items.map((b) => b.id);
    const taskCounts =
      boardIds.length > 0
        ? await this.taskRepo
            .createQueryBuilder('task')
            .select('list.board_id', 'boardId')
            .addSelect('COUNT(*)', 'total')
            .addSelect(`SUM(CASE WHEN task.status = :done THEN 1 ELSE 0 END)`, 'completed')
            .innerJoin('task.list', 'list')
            .where('list.board_id IN (:...boardIds)', { boardIds })
            .andWhere('task.deleted_at IS NULL')
            .setParameter('done', TaskStatus.DONE)
            .groupBy('list.board_id')
            .getRawMany()
        : [];
    const countMap = new Map(
      taskCounts.map((c) => [
        c.boardId,
        { total: parseInt(c.total, 10), completed: parseInt(c.completed, 10) },
      ]),
    );

    // 跨 board 批量查询 lists（接口瘦身二期：不再 leftJoinAndSelect board.lists，
    // 改由 1 条批量查询供给——禁止 join 与批量查询双跑；SQL 层过滤软删列，
    // 修正旧实现 BoardList.deletedAt select:false 导致 JS 过滤恒真的软删列泄漏）
    const lists =
      boardIds.length > 0
        ? await this.listRepo
            .createQueryBuilder('list')
            .where('list.board_id IN (:...boardIds)', { boardIds })
            .andWhere('list.deleted_at IS NULL')
            .orderBy('list.position', 'ASC')
            .addOrderBy('list.createdAt', 'ASC')
            .getMany()
        : [];
    const listsByBoard = new Map<string, BoardList[]>();
    for (const l of lists) {
      const arr = listsByBoard.get(l.boardId) ?? [];
      arr.push(l);
      listsByBoard.set(l.boardId, arr);
    }

    // 批量 task count per list（按 listId group by，供 lists 摘要 taskCount；
    // 口径差注记：per-list 仅计非软删列，board 级 taskCount 为全列口径）
    const listIds = lists.map((l) => l.id);
    const listTaskCounts =
      listIds.length > 0
        ? await this.taskRepo
            .createQueryBuilder('task')
            .select('task.list_id', 'listId')
            .addSelect('COUNT(*)', 'count')
            .where('task.list_id IN (:...listIds)', { listIds })
            .andWhere('task.deleted_at IS NULL')
            .groupBy('task.list_id')
            .getRawMany()
        : [];
    const listCountMap = new Map(listTaskCounts.map((c) => [c.listId, parseInt(c.count, 10)]));

    // 批量查询 memberCount per board（从 board_members 表）
    const memberCounts =
      boardIds.length > 0
        ? await this.memberRepo
            .createQueryBuilder('bm')
            .select('bm.board_id', 'boardId')
            .addSelect('COUNT(*)', 'count')
            .where('bm.board_id IN (:...boardIds)', { boardIds })
            .groupBy('bm.board_id')
            .getRawMany()
        : [];
    const memberCountMap = new Map(memberCounts.map((c) => [c.boardId, parseInt(c.count, 10)]));

    // 计算 listCount / taskCount / completedTaskCount / memberCount
    const enrichedItems = items.map((b) => {
      const counts = countMap.get(b.id);
      const boardLists = listsByBoard.get(b.id) ?? [];

      // settings 从响应剔除（web 列表页零消费；顶层 visibility 拍平保留）
      const { description, settings, ...rest } = b;
      void description;
      void settings;

      return {
        ...rest,
        // lists 摘要投影 = findLists 项形状原样（与详情端点一致优先于精确子集）
        lists: boardLists.map((l) => ({
          id: l.id,
          boardId: l.boardId,
          name: l.name,
          position: l.position,
          color: l.color,
          mappedStatus: l.mappedStatus,
          taskCount: listCountMap.get(l.id) ?? 0,
          createdAt: l.createdAt,
          updatedAt: l.updatedAt,
        })),
        taskCount: counts?.total ?? 0,
        completedTaskCount: counts?.completed ?? 0,
        listCount: boardLists.length,
        visibility: b.settings?.visibility,
        memberCount: memberCountMap.get(b.id) ?? 0,
        descriptionSnippet: description?.slice(0, 200) ?? null,
      } as unknown as Board;
    });

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: enrichedItems,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
    };
  }

  /** 查询单个 Board（含权限检查已迁移到 Controller） */
  async findOne(id: string): Promise<BoardDetail> {
    const board = await this.findById(id);
    return this.enrich(board);
  }

  /**
   * Board Digest（v1.41）：实时装配项目总揽视图，永不存储。
   *
   * 设计原则（plan §2）：机器能从事态算出的绝不人填；必须人写的（项目图例）
   * 写在 board.description。装配数据源：tasks（直查，避免 board↔task 模块循环依赖）、
   * milestones、绑定 DocSpace。
   *
   * 各段语义（与 docs/api-definition.md §7 digest 端点契约同步）：
   * - taskCount/completedTaskCount 口径 = GET /boards/:id 详情（countTasksByBoard）：
   *   未删除列 + 未删除任务（含 archived）；与 topic digest 口径（不排除已删除列）
   *   存在已知差异，本视图以 board 详情口径为准（plan §4 A2-4，不修 trigger）
   * - nextUp：open 任务（backlog/todo/in_progress/blocked/review）priority 序，openLimit 截断
   * - risks：labels 与 ['bug','debt'] 数组重叠（PG && 运算符，OR 语义；task.service 的
   *   @> 是 AND 语义不适用）∧ status 非 done/archived，priority 序，riskLimit 截断
   * - recentDone：status=done 且 completedAt 非空，completedAt desc，doneLimit 截断
   * - milestones：v1.42 起 Release 化——version 非空 = Release 里程碑，投影
   *   version/deployedAt/verifiedAt（不返回 body/deployMeta）；stats 口径对齐
   *   milestone.service（done 含 archived；open = backlog/todo/review/blocked，
   *   不含 in_progress）
   * - versions：Release 版本三区（production/development/history），全部内存装配，
   *   复用 milestones 段已加载的全量集合 + stats 批量结果，零新查询；history 按
   *   deployedAt DESC NULLS LAST + createdAt DESC 排序后 slice(versionLimit)；
   *   versionsTruncated = total > history.length，并入 truncated 语义
   *   （versionLimit=0 对齐既有惯例：显式要求空段不参与截断判定）
   * - metrics：board.settings.metrics 透传（report-metrics.mjs 上报的测试基线/MCP
   *   工具数等机器事实），无则 null
   * - roundtable（v1.44.0-dev，M2 阶段 7）：圆桌平台级指标首版——圆桌 topic 数、
   *   active 座位数、近 7 天日均轮次、沉默拦截率、熔断次数；**平台级口径**：
   *   topic/seat/message 均不隶属于 board，digest 按 board 调用但本段统计全平台；
   *   永远输出该段（无圆桌时全零，形状可预测）。五值口径见装配处注释
   * - docs：按 boardId 找绑定空间（无则 docs: null）+ 该空间未删除文档 updatedAt desc；
   *   **权限语义（契约层决定）**：board 可读即蕴含空间元数据可读（不含正文）
   * - truncated：任一列表段"实际存在但被 limit 截断"为 true；limit=0（调用方显式
   *   要求空段）不参与截断判定；v1.42 起 versions.history 截断并入
   *
   * @param boardId - 看板 ID（Controller 层已做权限检查 + findById 判空）
   * @param query   - 各段 limit 与 includeDescription（缺省值在此应用）
   * @returns 实时装配的 BoardDigest
   */
  async getDigest(boardId: string, query?: BoardDigestQueryDto): Promise<BoardDigest> {
    const board = await this.findById(boardId);

    // 缺省值应用：DTO 只做格式校验（铁律 #21），业务缺省在 service 层
    const openLimit = query?.openLimit ?? 10;
    const doneLimit = query?.doneLimit ?? 5;
    const riskLimit = query?.riskLimit ?? 10;
    const docsLimit = query?.docsLimit ?? 5;
    const versionLimit = query?.versionLimit ?? 5;
    // includeDescription 缺省 true（对齐 getOverview 惯例）；显式 false 时 description 置 null
    const includeDescription = query?.includeDescription !== false;

    // ── 列元数据 + 列 taskCount（口径对齐 findLists：未删除任务计数，含 archived） ──
    const lists = await this.listRepo.find({
      where: { boardId, deletedAt: IsNull() },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    const listIds = lists.map((l) => l.id);

    const listTaskCounts =
      listIds.length > 0
        ? await this.taskRepo
            .createQueryBuilder('task')
            .select('task.list_id', 'listId')
            .addSelect('COUNT(*)', 'count')
            .where('task.list_id IN (:...listIds)', { listIds })
            .andWhere('task.deleted_at IS NULL')
            .groupBy('task.list_id')
            .getRawMany()
        : [];
    const listCountMap = new Map(listTaskCounts.map((c) => [c.listId, parseInt(c.count, 10)]));
    const digestLists: BoardDigestList[] = lists.map((l) => ({
      id: l.id,
      name: l.name,
      mappedStatus: l.mappedStatus ?? null,
      taskCount: listCountMap.get(l.id) ?? 0,
    }));

    // ── taskCount / completedTaskCount：复用 enrich 口径（board 详情为准） ──
    const { total: taskCount, completed: completedTaskCount } =
      listIds.length > 0 ? await this.countTasksByBoard(boardId) : { total: 0, completed: 0 };

    // ── open 任务全量（priorityDistribution 需全量；nextUp 是它的前缀切片） ──
    // Priority 枚举序 p0→p1→p2→p3，ORDER BY priority ASC = p0（最高优先级）在前
    const openTasks =
      listIds.length > 0
        ? await this.taskRepo.find({
            where: {
              listId: In(listIds),
              status: In([
                TaskStatus.BACKLOG,
                TaskStatus.TODO,
                TaskStatus.IN_PROGRESS,
                TaskStatus.BLOCKED,
                TaskStatus.REVIEW,
              ]),
            },
            order: { priority: 'ASC', createdAt: 'ASC' },
          })
        : [];

    // priorityDistribution：open 任务按 priority 内存聚合（含 0 值，形状稳定）
    const priorityDistribution: Record<Priority, number> = {
      [Priority.P0]: 0,
      [Priority.P1]: 0,
      [Priority.P2]: 0,
      [Priority.P3]: 0,
    };
    for (const t of openTasks) {
      priorityDistribution[t.priority] = (priorityDistribution[t.priority] ?? 0) + 1;
    }

    // nextUp：open 任务 priority 序前缀（已全量加载，slice 而非 take）
    const nextUpAll: DigestTaskRow[] = openTasks.map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      status: t.status,
      assigneeId: t.assigneeId,
    }));
    const nextUp = nextUpAll.slice(0, openLimit);
    const nextUpTruncated = openLimit > 0 && nextUpAll.length > openLimit;

    // ── risks：labels 数组重叠（&& = 任一命中）∧ status 非 done/archived，priority 序 ──
    // 独立 SQL 查询（对齐 plan 指定的 PG && 运算符；内存过滤会与 open 集合强耦合，语义不清）
    let riskAll: DigestRiskRow[] = [];
    // 全量计数：limit>0 时 = 探针行数（min(全量, limit+1)，维持既有语义）；
    // limit=0 时走 COUNT（调用方只要计数不拉条目——短路空数组会令 total 假报 0）
    let risksTotal = 0;
    if (listIds.length > 0) {
      // 查询条件工厂：行查询与 COUNT 共用同一过滤条件，防口径漂移
      const riskQuery = () =>
        this.taskRepo
          .createQueryBuilder('task')
          .where('task.list_id IN (:...listIds)', { listIds })
          .andWhere('task.deleted_at IS NULL')
          .andWhere("task.labels && ARRAY['bug','debt']")
          .andWhere('task.status NOT IN (:...excluded)', {
            excluded: [TaskStatus.DONE, TaskStatus.ARCHIVED],
          });
      if (riskLimit > 0) {
        const riskRows = await riskQuery()
          .orderBy('task.priority', 'ASC')
          .addOrderBy('task.created_at', 'ASC')
          .take(riskLimit + 1) // +1 探针：超出 limit 即 truncated（避免全量加载风险任务）
          .getMany();
        riskAll = riskRows.map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          status: t.status,
          labels: t.labels,
          assigneeId: t.assigneeId,
        }));
        if (riskAll.length > riskLimit) {
          // 探针截顶（真实数 > limit）：追加 COUNT 拿精确全量——探针行数只是 limit+1 上限，
          // 直接当 total 会截顶虚报（契约：xxxTotal 恒为真实全量计数）
          risksTotal = await riskQuery().getCount();
        } else {
          // 探针未满：行数即精确总数，无需额外 COUNT
          risksTotal = riskAll.length;
        }
      } else {
        // limit=0：不拉行，COUNT 拿真实全量（调用方凭 total 决定是否再拉该段）
        risksTotal = await riskQuery().getCount();
      }
    }
    const risks = riskAll.slice(0, riskLimit);
    const risksTruncated = riskLimit > 0 && riskAll.length > riskLimit;

    // ── recentDone：status=done 且 completedAt 非空（不变量 #18），completedAt desc ──
    // archived 任务已移出视野，不计入"最近完成"（口径注释见 api-definition §7）
    // completedAt NULL 过滤（2026-08-05 产品锚点验收暴露）：PG ORDER BY DESC 默认 NULLS FIRST，
    // 存量 NULL 行（不变量建立前的历史数据）会顶到最前，把真实最近完成挤出 top N。
    let recentDoneAll: DigestDoneRow[] = [];
    // 全量计数：limit>0 时 = 探针行数；limit=0 时走 COUNT（同上，防 total 假报 0）
    let recentDoneTotal = 0;
    if (listIds.length > 0) {
      // 过滤条件工厂：find 与 count 共用同一条件，防口径漂移
      // （软删过滤均由 TypeORM 自动应用，与既有 find 口径一致）
      const doneFilter = () => ({
        listId: In(listIds),
        status: TaskStatus.DONE,
        completedAt: Not(IsNull()),
      });
      if (doneLimit > 0) {
        const doneRows = await this.taskRepo.find({
          where: doneFilter(),
          order: { completedAt: 'DESC', createdAt: 'DESC' },
          take: doneLimit + 1, // +1 探针：超出 limit 即 truncated
        });
        recentDoneAll = doneRows.map((t) => ({
          id: t.id,
          title: t.title,
          completedAt: t.completedAt ?? t.updatedAt,
          assigneeId: t.assigneeId,
        }));
        if (recentDoneAll.length > doneLimit) {
          // 探针截顶：追加 COUNT 拿精确全量（探针行数只是 doneLimit+1 上限，会截顶虚报）
          recentDoneTotal = await this.taskRepo.count({ where: doneFilter() });
        } else {
          // 探针未满：行数即精确总数，无需额外 COUNT
          recentDoneTotal = recentDoneAll.length;
        }
      } else {
        // limit=0：不拉行，COUNT 拿真实全量（调用方凭 total 决定是否再拉该段）
        recentDoneTotal = await this.taskRepo.count({ where: doneFilter() });
      }
    }
    const recentDone = recentDoneAll.slice(0, doneLimit);
    const recentDoneTruncated = doneLimit > 0 && recentDoneAll.length > doneLimit;

    // ── milestones：元数据 + 批量 stats（避免 N+1） ──
    // v1.42 Release 化：投影 version/deployedAt/verifiedAt（不返回 body/deployMeta）
    const milestones = await this.milestoneRepo.find({
      where: { boardId },
      order: { createdAt: 'ASC' },
    });
    const milestoneStats = await this.getMilestoneStatsBatch(milestones.map((m) => m.id));
    const digestMilestones: BoardDigestMilestone[] = milestones.map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      startDate: m.startDate,
      targetDate: m.targetDate,
      // ?? undefined：普通里程碑序列化不出现该键（保持 JSON 干净）
      version: m.version ?? undefined,
      deployedAt: m.deployedAt ?? undefined,
      verifiedAt: m.verifiedAt ?? undefined,
      stats: milestoneStats.get(m.id) ?? { total: 0, done: 0, inProgress: 0, open: 0 },
    }));

    // ── versions：Release 版本三区（全部内存装配，复用上面已加载的 milestone 全量
    //    集合 + stats 批量结果，零新查询；2026-08-05 教训：DESC 排序先想 NULL 处理） ──
    const releaseMilestones = milestones.filter((m) => m.version);
    const toVersionRef = (m: Milestone): BoardDigestVersionRef => ({
      id: m.id,
      version: m.version as string, // filter(m => m.version) 保证非空
      name: m.name,
      status: m.status,
      deployedAt: m.deployedAt ?? undefined,
      verifiedAt: m.verifiedAt ?? undefined,
      stats: milestoneStats.get(m.id) ?? { total: 0, done: 0, inProgress: 0, open: 0 },
    });
    /**
     * Release 排序比较器：deployedAt DESC 且 NULL 排最后（对齐 PG NULLS LAST），
     * 并列（含双 null）取 createdAt DESC。部署事实列可能为 NULL（未部署过的
     * dev/ready release），DESC 排序必须显式处理，否则 NULL 顶到最前（e85938b 教训）。
     */
    const compareReleaseDesc = (a: Milestone, b: Milestone): number => {
      if (a.deployedAt && b.deployedAt) {
        const diff = b.deployedAt.getTime() - a.deployedAt.getTime();
        if (diff !== 0) return diff;
      } else if (a.deployedAt || b.deployedAt) {
        return a.deployedAt ? -1 : 1;
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
    };

    // production：deployed/verified 中 deployedAt 最新（并列 createdAt 最新）
    const production =
      releaseMilestones
        .filter(
          (m) => m.status === MilestoneStatus.DEPLOYED || m.status === MilestoneStatus.VERIFIED,
        )
        .sort(compareReleaseDesc)[0] ?? null;
    // development：dev/ready 中 createdAt 最新（未部署，无 deployedAt 可比）
    const development =
      releaseMilestones
        .filter((m) => m.status === MilestoneStatus.DEV || m.status === MilestoneStatus.READY)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
    // history：version 非空全体，deployedAt DESC NULLS LAST + createdAt DESC，slice(versionLimit)
    const versionsHistory = releaseMilestones
      .slice()
      .sort(compareReleaseDesc)
      .slice(0, versionLimit)
      .map(toVersionRef);
    const versionsTotal = releaseMilestones.length;
    // 截断判定对齐既有语义：limit=0（显式要求空段）不参与截断判定
    const versionsTruncated = versionLimit > 0 && versionsTotal > versionsHistory.length;

    // ── docs：board 绑定空间元数据 + 最近更新文档（updatedAt desc） ──
    // 权限语义（契约层决定，评审已拍板）：board 可读蕴含空间元数据可读，不做 DocSpace 成员校验
    let docs: BoardDigestDocs | null = null;
    let docsTruncated = false;
    // 截断元数据补齐：docsTotal = 最近更新文档全量计数（不受 docsLimit 截断影响）；
    // 无绑定空间（docs 为 null）时缺省，与 docs 段"不存在"语义一致
    let docsTotal: number | undefined;
    const space = await this.docSpaceRepo.findOne({ where: { boardId } });
    if (space) {
      // 查询条件工厂：行查询与 COUNT 共用同一过滤条件，防口径漂移
      const docBase = () =>
        this.docRepo
          .createQueryBuilder('d')
          .where('d.space_id = :spaceId', { spaceId: space.id })
          .andWhere('d.deleted_at IS NULL'); // 显式排除软删文档（对齐 overview 口径）
      const recentDocs =
        docsLimit > 0
          ? await docBase()
              .orderBy('d.updated_at', 'DESC')
              .take(docsLimit + 1) // +1 探针：超出 limit 即 truncated
              .getMany()
          : [];
      docsTruncated = docsLimit > 0 && recentDocs.length > docsLimit;
      // docsTotal 恒为真实全量：limit=0（不拉行）或探针截顶（行数只是 docsLimit+1 上限）时
      // 追加 COUNT 拿精确计数；探针未满时行数即精确总数（docsTotal 不受 docsLimit 截断影响）
      docsTotal =
        docsLimit === 0 || recentDocs.length > docsLimit
          ? await docBase().getCount()
          : recentDocs.length;
      docs = {
        spaceId: space.id,
        spaceName: space.name,
        // snippet 口径对齐 boards 列表页 descriptionSnippet（≤200 字符）
        spaceDescriptionSnippet: space.description?.slice(0, 200) ?? null,
        recentlyUpdated: recentDocs.slice(0, docsLimit).map((d) => ({
          path: d.path,
          title: d.title,
          updatedAt: d.updatedAt,
        })),
      };
    }

    // ── assigneeName 批量解析（risks/nextUp/recentDone 一次补齐，避免 N+1） ──
    const allAssignees = [
      ...riskAll.map((r) => r.assigneeId),
      ...nextUpAll.map((t) => t.assigneeId),
      ...recentDoneAll.map((t) => t.assigneeId),
    ].filter((id): id is string => Boolean(id));
    const profileMap = await this.resolveActorProfiles([...new Set(allAssignees)]);
    const nameOf = (id: string | null | undefined): string | null =>
      id ? (profileMap.get(id)?.name ?? null) : null;
    // 软删信号投影（契约 docs/spec.md §1）：非空 = assignee 已删除，assigneeName 仍显示
    const deletedAtOf = (id: string | null | undefined): string | null =>
      id ? (profileMap.get(id)?.deletedAt?.toISOString() ?? null) : null;

    // metrics：settings.metrics 透传不加工（report-metrics.mjs 上报的机器事实；无则 null）
    const metrics = (board.settings?.metrics as Record<string, unknown> | undefined) ?? null;

    // ── roundtable：圆桌平台级指标（v1.44.0-dev，M2 阶段 7，实时装配新段） ──
    // 平台级口径：topic/seat/message 均不隶属于 board，digest 按 board 调用但本段
    // 统计全平台（设计文档 §12 r10）。永远输出该段——平台无圆桌时全零，形状可预测
    // （不返回 undefined，消费端无需判空）。座位消息判定 = messages.metadata->>'seatLabel'
    // 非空（阶段 3/6 确立的座位身份标记）；TypeORM 软删自动过滤（DeleteDateColumn 令
    // count()/getCount() 隐式加 deleted_at IS NULL）。
    // topicCount：topics.kind='roundtable' 全平台计数（kind 创建后不可变，阶段 1）
    const roundtableTopicCount = await this.topicRepo.count({
      where: { kind: TopicKind.ROUNDTABLE },
    });
    // seatCount：active 状态座位数（status 枚举 active/paused/parked/offline/removed，默认 active）
    const roundtableSeatCount = await this.seatRepo.count({
      where: { status: SEAT_LIFECYCLE_STATUS.ACTIVE },
    });
    // 座位 state 计数求和用 JS 内存累加（座位量小，禁止 jsonb 聚合 SQL——stage 7 口径
    // 拍板）；state 为 jsonb 默认 '{}'，阶段 4 落计数前的历史座位缺键，?? 0 兜底
    const allSeats = await this.seatRepo.find();
    let silentCountSum = 0;
    let valveTripCountSum = 0;
    for (const seat of allSeats) {
      silentCountSum += (seat.state?.silentCount as number | undefined) ?? 0;
      valveTripCountSum += (seat.state?.valveTripCount as number | undefined) ?? 0;
    }
    // 座位消息全时段累计（silentRate 分母——**全时段**，非 7 天窗口；严禁用
    // roundsWithoutHuman 当分母，它会复位清零，阶段 5 已知坑 RT-VALVE 系）
    const seatMessageTotal = await this.messageRepo
      .createQueryBuilder('m')
      .where("m.metadata ->> 'seatLabel' IS NOT NULL")
      .andWhere("m.metadata ->> 'seatLabel' <> ''")
      .getCount();
    // 近 7 天窗口（含当下往前 7×24h；dailyRounds 分子，口径注释见 shared 类型）
    const seatMessage7dCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const seatMessages7d = await this.messageRepo
      .createQueryBuilder('m')
      .where("m.metadata ->> 'seatLabel' IS NOT NULL")
      .andWhere("m.metadata ->> 'seatLabel' <> ''")
      .andWhere('m.createdAt >= :cutoff', { cutoff: seatMessage7dCutoff })
      .getCount();
    // dailyRounds 保留两位小数（除法合理精度）；silentRate 分母 0 → 0（防除零）
    const dailyRounds = Math.round((seatMessages7d / 7) * 100) / 100;
    const silentRateDenominator = silentCountSum + seatMessageTotal;
    const silentRate = silentRateDenominator > 0 ? silentCountSum / silentRateDenominator : 0;

    const truncated =
      risksTruncated ||
      nextUpTruncated ||
      recentDoneTruncated ||
      docsTruncated ||
      versionsTruncated;

    // 最终投影：剔除内部 assigneeId，统一填充 assigneeName + assigneeDeletedAt（软删信号）
    const projectRisk = (r: DigestRiskRow): BoardDigestRisk => {
      const { assigneeId, ...rest } = r;
      return {
        ...rest,
        assigneeName: nameOf(assigneeId),
        assigneeDeletedAt: deletedAtOf(assigneeId),
      };
    };
    const projectOpen = (t: DigestTaskRow): BoardDigestOpenTask => {
      const { assigneeId, ...rest } = t;
      return {
        ...rest,
        assigneeName: nameOf(assigneeId),
        assigneeDeletedAt: deletedAtOf(assigneeId),
      };
    };
    const projectDone = (t: DigestDoneRow): BoardDigestDoneTask => {
      const { assigneeId, ...rest } = t;
      return {
        ...rest,
        assigneeName: nameOf(assigneeId),
        assigneeDeletedAt: deletedAtOf(assigneeId),
      };
    };

    return {
      boardId: board.id,
      boardName: board.name,
      description: includeDescription ? board.description : null,
      visibility: board.settings?.visibility ?? Visibility.OPEN,
      taskCount,
      completedTaskCount,
      lists: digestLists,
      milestones: digestMilestones,
      versions: {
        production: production ? toVersionRef(production) : null,
        development: development ? toVersionRef(development) : null,
        history: versionsHistory,
        total: versionsTotal,
      },
      metrics,
      roundtable: {
        topicCount: roundtableTopicCount,
        seatCount: roundtableSeatCount,
        dailyRounds,
        silentRate,
        valveTripCount: valveTripCountSum,
      },
      priorityDistribution: { open: priorityDistribution },
      risks: risks.map(projectRisk),
      // 截断元数据补齐：各段全量计数恒输出（对齐 versions.total 先例），
      // 截断判断用 xxxTotal > xxx.length；docsTotal 无绑定空间时缺省
      risksTotal,
      nextUp: nextUp.map(projectOpen),
      nextUpTotal: nextUpAll.length,
      recentDone: recentDone.map(projectDone),
      recentDoneTotal,
      docs,
      ...(docsTotal !== undefined ? { docsTotal } : {}),
      truncated,
    };
  }

  /**
   * 写入 board 测试基线等机器事实（v1.42，metrics 唯一写口 = report-metrics.mjs）。
   *
   * 原子单条 SQL：`jsonb_set(settings, '{metrics}', $1::jsonb)` 只动 metrics 键，
   * visibility/archived_lists_visible 等既有键不受影响（禁 read-modify-write——并发下
   * 整对象覆盖会丢键，plan §4 B3-1 硬语义）。metrics 永不经 DTO 之外的路径写入。
   *
   * @param boardId - 看板 ID（Controller 层已做 findById 判空 + write 权限检查）
   * @param metrics - 机器事实对象（整对象覆盖写入 settings.metrics）
   * @returns 写后 settings.metrics（RETURNING 单条 SQL，无第二次查询；无则 null）
   */
  async updateMetrics(
    boardId: string,
    metrics: Record<string, unknown>,
  ): Promise<{ metrics: Record<string, unknown> | null }> {
    // 原生 query：TypeORM 实体级 update 无法表达 jsonb_set 片段，且会整体覆盖 settings
    const rows: Array<{ settings?: Record<string, unknown> | null }> = await this.boardRepo.query(
      `UPDATE boards SET settings = jsonb_set(settings, '{metrics}', $1::jsonb) WHERE id = $2 RETURNING settings`,
      [JSON.stringify(metrics), boardId],
    );
    // 防御：Controller 已判空，此处兜底 TOCTOU 窗口（铁律 #22）
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });
    }
    const stored = (rows[0].settings?.metrics as Record<string, unknown> | undefined) ?? null;
    return { metrics: stored };
  }

  /**
   * 批量聚合 milestone 的 stats（避免 N+1，v1.41 digest 用）
   *
   * 口径对齐 milestone.service.getStatsBatch（保持一致，测试即文档）：
   * - done 含 archived（历史完成任务）
   * - inProgress 仅 in_progress
   * - open = backlog/todo/review/blocked（不含 in_progress/done/archived）
   *
   * @param milestoneIds - 里程碑 ID 列表（空数组返回空 Map）
   * @returns milestoneId → { total, done, inProgress, open }
   */
  private async getMilestoneStatsBatch(
    milestoneIds: string[],
  ): Promise<Map<string, { total: number; done: number; inProgress: number; open: number }>> {
    const map = new Map<
      string,
      { total: number; done: number; inProgress: number; open: number }
    >();
    if (milestoneIds.length === 0) return map;
    for (const id of milestoneIds) map.set(id, { total: 0, done: 0, inProgress: 0, open: 0 });

    const tasks = await this.taskRepo.find({
      where: { milestoneId: In(milestoneIds) },
      select: ['milestoneId', 'status'],
    });
    for (const task of tasks) {
      if (!task.milestoneId) continue;
      const stats = map.get(task.milestoneId);
      if (!stats) continue;
      stats.total += 1;
      if (task.status === TaskStatus.DONE || task.status === TaskStatus.ARCHIVED) stats.done += 1;
      if (task.status === TaskStatus.IN_PROGRESS) stats.inProgress += 1;
      if (
        task.status === TaskStatus.BACKLOG ||
        task.status === TaskStatus.TODO ||
        task.status === TaskStatus.REVIEW ||
        task.status === TaskStatus.BLOCKED
      ) {
        stats.open += 1;
      }
    }
    return map;
  }

  async create(creatorId: string, creatorType: string, dto: CreateBoardDto) {
    // Board autonomy: visibility comes from dto, no topic inheritance
    const visibility = dto.visibility ?? Visibility.OPEN;

    // 如果关联了 Topic，仅校验 Topic 存在性（不再做可见性继承）
    if (dto.topicId) {
      const topic = await this.topicRepo.findOne({ where: { id: dto.topicId } });
      if (!topic)
        throw new NotFoundException({
          message: 'Topic not found',
          code: ErrorCode.TOPIC_NOT_FOUND,
        });
    }

    // 批量校验 invitedAgentIds 中所有 Agent 存在且未软删（统一批 A2.5b：create 一刀切校验
    // 全部 id——新增引用禁止指向已删 actor，契约 docs/spec.md §1 规则 6；与 topic create 对齐）
    const invitedAgentIds = dto.invitedAgentIds || [];
    if (invitedAgentIds.length > 0) {
      await Promise.all(
        [...new Set(invitedAgentIds)].map((id) => this.actorProfileService.assertActorUsable(id)),
      );
    }

    const settings = {
      archived_lists_visible: false,
      allow_wip_limit: true,
      visibility,
    };

    const board = this.boardRepo.create({
      name: dto.name,
      description: dto.description,
      topicId: dto.topicId,
      creatorId,
      creatorType: creatorType as ActorType,
      settings,
    });
    const savedBoard = await this.boardRepo.save(board);

    // 为 invitedAgentIds 创建 board_members 行 (role='member')；Set 去重防同批 PK 冲突。
    // creator 若同时出现在 invitedAgentIds 必须过滤——creator 单独落 role='editor' 行，
    // 重复写会触发 (board_id, actor_id) PK 冲突
    if (invitedAgentIds.length > 0) {
      const memberEntities = [...new Set(invitedAgentIds)]
        .filter((agentId) => agentId !== creatorId)
        .map((agentId) =>
          this.memberRepo.create({
            boardId: savedBoard.id,
            actorId: agentId,
            role: BoardMemberRole.MEMBER,
            invitedBy: creatorId,
          }),
        );
      if (memberEntities.length > 0) {
        await this.memberRepo.save(memberEntities);
      }
    }

    // creator 落成员行（role='editor', invitedBy=null）：成员列表可见 + 按成员表算可见性
    // 的查询路径（AccessQueryService.computeAccessibleBoardIds）对 creator 命中。
    // 权限本身仍由 isCreator 直比保证（board.policy.ts），成员行是补充语义非权限来源；
    // invitedBy=null 标记「非授予产生」，backfill migration 的 down() 据此精确回滚
    await this.memberRepo.save(
      this.memberRepo.create({
        boardId: savedBoard.id,
        actorId: creatorId,
        role: BoardMemberRole.EDITOR,
        invitedBy: null,
      }),
    );

    // 如传入初始 lists，批量创建
    if (dto.lists && dto.lists.length > 0) {
      const listEntities = dto.lists.map((list, index) =>
        this.listRepo.create({
          boardId: savedBoard.id,
          name: list.name,
          position: list.position ?? index,
          mappedStatus: list.mappedStatus,
        }),
      );
      await this.listRepo.save(listEntities);
    }

    // 重新加载 board（含 lists 关系），确保返回完整的 board 结构
    return this.boardRepo.findOne({
      where: { id: savedBoard.id },
      relations: ['lists'],
    });
  }

  async update(id: string, dto: UpdateBoardDto) {
    const board = await this.boardRepo.findOne({ where: { id } });
    if (!board)
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });

    const oldTopicId = board.topicId;

    // 处理 invitedAgentIds：set 语义操作 board_members 表
    if (dto.invitedAgentIds !== undefined) {
      // 获取当前 role='member' 的成员（toRemove 用；editor 不在此集合，永不被移除）
      const currentMembers = await this.memberRepo.find({
        where: { boardId: id, role: BoardMemberRole.MEMBER },
      });
      const newIds = new Set(dto.invitedAgentIds);

      // 需要新增的：排除已有任意 role 成员行的 actor——
      // save 按 PK upsert，若不排除会把 editor 行覆盖降级为 member（review 发现的回归）
      const existingAll = await this.memberRepo.find({
        where: { boardId: id },
        select: ['actorId'],
      });
      const existingIds = new Set(existingAll.map((m) => m.actorId));
      const toAdd = [...new Set(dto.invitedAgentIds)].filter((aid) => !existingIds.has(aid));

      // 只拦新增 id（统一批 A2.5b，R11 同款）：update 是 set 语义全量替换，存量成员行里的
      // 已删 agent 不拦——否则存量含已删成员的话题永远无法保存。契约 docs/spec.md §1 规则 6
      if (toAdd.length > 0) {
        await Promise.all(toAdd.map((aid) => this.actorProfileService.assertActorUsable(aid)));

        const newMembers = toAdd.map((actorId) =>
          this.memberRepo.create({
            boardId: id,
            actorId,
            role: BoardMemberRole.MEMBER,
            invitedBy: board.creatorId,
          }),
        );
        await this.memberRepo.save(newMembers);
      }

      // 需要删除的（仅 role='member'，不碰 editor）
      const toRemove = currentMembers.filter((m) => !newIds.has(m.actorId)).map((m) => m.actorId);
      if (toRemove.length > 0) {
        await this.memberRepo.delete({
          boardId: id,
          actorId: In(toRemove),
          role: BoardMemberRole.MEMBER,
        });
      }

      // 不再写入 board.settings.invitedAgentIds
    }

    // 更新 board.settings.visibility（单独处理，不再做 topic 继承）
    if (dto.visibility !== undefined) {
      board.settings = {
        ...board.settings,
        visibility: dto.visibility,
      };
    }

    if (dto.name !== undefined) board.name = dto.name;
    if (dto.description !== undefined) board.description = dto.description;

    // topicId 变更时，校验 Topic 存在性（Task 不存储 topicId，无需级联更新）
    if (dto.topicId !== undefined && dto.topicId !== oldTopicId) {
      const _topic = await this.resourceValidator.exists(
        this.topicRepo,
        dto.topicId,
        ErrorCode.TOPIC_NOT_FOUND,
      );
      board.topicId = dto.topicId;
      // Board autonomy: 不再从 topic 继承 visibility
    }

    const saved = await this.boardRepo.save(board);
    return saved;
  }

  async remove(id: string) {
    await this.findOne(id);
    // 使用 softDelete(id) 替代 softRemove(entity)，避免 loaded relations 风险（B-49 教训）
    await this.boardRepo.softDelete(id);

    // 知识不随执行工具消亡：space 本体保留，仅解除 board 绑定
    await this.docSpaceRepo
      .createQueryBuilder()
      .update(DocSpace)
      .set({ boardId: null })
      .where('board_id = :boardId', { boardId: id })
      .execute();

    return true;
  }

  /** 原子操作：添加 Board Editor */
  async addEditor(id: string, agentId: string) {
    const board = await this.boardRepo.findOne({ where: { id } });
    if (!board)
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });

    // 校验 Agent 存在且未软删（统一批 A2.5：写入口统一拒绝已删 actor——契约 docs/spec.md §1 规则 6）
    await this.actorProfileService.assertActorUsable(agentId);

    // 查找是否已存在 board_members 行
    const existing = await this.memberRepo.findOne({
      where: { boardId: id, actorId: agentId },
    });

    if (existing) {
      if (existing.role === BoardMemberRole.EDITOR) {
        throw new ConflictException({
          message: 'Agent is already an editor',
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
      // member → editor 升级
      existing.role = BoardMemberRole.EDITOR;
      await this.memberRepo.save(existing);
    } else {
      // 新建 editor 行
      const member = this.memberRepo.create({
        boardId: id,
        actorId: agentId,
        role: BoardMemberRole.EDITOR,
        invitedBy: board.creatorId,
      });
      await this.memberRepo.save(member);
    }

    // 发射 AGENT_JOINED 事件
    await this.eventService.create({
      eventType: EventType.AGENT_JOINED,
      resourceType: ResourceType.BOARD,
      resourceId: id,
      actorId: agentId,
      topicId: board.topicId ?? undefined,
      boardId: id,
    });

    return board;
  }

  /** 原子操作：移除 Board Editor */
  async removeEditor(id: string, agentId: string) {
    const board = await this.boardRepo.findOne({ where: { id } });
    if (!board)
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });

    // creator 的 editor 行不可移除：creator 权限由 isCreator 直比保证，但成员行承载
    // 成员列表可见性 + AccessQueryService 白名单语义，删行会让「creator 缺席成员表」
    // 的原始 bug 经本路径复活（4b1ddd1c）
    if (board.creatorId === agentId) {
      throw new ConflictException({
        message: 'Board creator cannot be removed as editor',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // 校验 Agent 真实存在（A2.5b：移除类入口不拦软删——软删 agent 的 agents 行永在，移除是
    // 清理动作必须可用，否则已删成员行永远无法清理；完全不存在仍 404。拦截只针对新增引用）
    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

    // 查找 editor 行
    const existing = await this.memberRepo.findOne({
      where: { boardId: id, actorId: agentId, role: BoardMemberRole.EDITOR },
    });

    if (!existing) {
      throw new ConflictException({
        message: 'Agent is not an editor',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // 删除 editor 行（editor 撤销 = 完全移除）
    await this.memberRepo.delete({ boardId: id, actorId: agentId, role: BoardMemberRole.EDITOR });

    // 发射 AGENT_LEFT 事件
    await this.eventService.create({
      eventType: EventType.AGENT_LEFT,
      resourceType: ResourceType.BOARD,
      resourceId: id,
      actorId: agentId,
      topicId: board.topicId ?? undefined,
      boardId: id,
    });

    return board;
  }

  /** 原子操作：邀请 Agent 访问 Board */
  async inviteAgent(id: string, agentId: string) {
    const board = await this.boardRepo.findOne({ where: { id } });
    if (!board)
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });

    // 校验 Agent 存在且未软删（统一批 A2.5：写入口统一拒绝已删 actor——契约 docs/spec.md §1 规则 6）
    await this.actorProfileService.assertActorUsable(agentId);

    // 检查是否已是成员/editor（通过 board_members 表）
    const existing = await this.memberRepo.findOne({
      where: { boardId: id, actorId: agentId },
    });
    if (existing) {
      throw new ConflictException({
        message: 'Agent already has access to this board',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // 插入 board_members (role='member')
    const member = this.memberRepo.create({
      boardId: id,
      actorId: agentId,
      role: BoardMemberRole.MEMBER,
      invitedBy: board.creatorId,
    });
    await this.memberRepo.save(member);

    // 发射 AGENT_JOINED 事件
    await this.eventService.create({
      eventType: EventType.AGENT_JOINED,
      resourceType: ResourceType.BOARD,
      resourceId: id,
      actorId: agentId,
      topicId: board.topicId ?? undefined,
      boardId: id,
    });

    return board;
  }

  /** 原子操作：取消 Agent 对 Board 的访问邀请 */
  async uninviteAgent(id: string, agentId: string) {
    const board = await this.boardRepo.findOne({ where: { id } });
    if (!board)
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });

    // creator 成员行不可经 uninvite 移除（显式守卫优先于 editor-role 检查，给出明确语义）
    if (board.creatorId === agentId) {
      throw new ConflictException({
        message: 'Board creator cannot be uninvited',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // 校验 Agent 真实存在（A2.5b：移除类入口不拦软删——软删 agent 的 agents 行永在，移除是
    // 清理动作必须可用，否则已删成员行永远无法清理；完全不存在仍 404。拦截只针对新增引用）
    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

    // 查找 board_members 行
    const existing = await this.memberRepo.findOne({
      where: { boardId: id, actorId: agentId },
    });

    if (!existing) {
      throw new ConflictException({
        message: 'Agent is not a member',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    if (existing.role === BoardMemberRole.EDITOR) {
      throw new ConflictException({
        message: 'Use removeEditor first',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // 删除 member 行
    await this.memberRepo.delete({ boardId: id, actorId: agentId });

    // 发射 AGENT_LEFT 事件
    await this.eventService.create({
      eventType: EventType.AGENT_LEFT,
      resourceType: ResourceType.BOARD,
      resourceId: id,
      actorId: agentId,
      topicId: board.topicId ?? undefined,
      boardId: id,
    });

    return board;
  }

  async createList(boardId: string, dto: CreateBoardListDto) {
    // 仅检查 board 存在性，权限检查由 Controller 层负责
    const board = await this.boardRepo.findOne({ where: { id: boardId } });
    if (!board) {
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });
    }

    // mappedStatus 互斥校验：同一 Board 下每个状态只能绑定一个列
    if (dto.mappedStatus) {
      const existing = await this.listRepo.findOne({
        where: { boardId: board.id, mappedStatus: dto.mappedStatus },
      });
      if (existing) {
        throw new ConflictException({
          message: `Board already has a list mapped to "${dto.mappedStatus}"`,
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
    }

    const list = this.listRepo.create({
      ...dto,
      boardId: board.id,
    });
    const saved = await this.listRepo.save(list);
    return { ...saved };
  }

  async reorderLists(boardId: string, dto: ReorderBoardListsDto) {
    // 仅检查 board 存在性，权限检查由 Controller 层负责
    const board = await this.boardRepo.findOne({ where: { id: boardId } });
    if (!board) {
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });
    }

    for (const item of dto.lists) {
      await this.listRepo.update(item.id, { position: item.position });
    }
    const lists = await this.listRepo.find({ where: { boardId } });
    // 按 position 稳定排序，position 相同时按 createdAt 兜底，与 findOne 保持一致
    lists.sort((a, b) => {
      const posDiff = (a.position ?? 0) - (b.position ?? 0);
      if (posDiff !== 0) return posDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    // 显式展开为 plain object，规避 TypeORM 实体序列化异常
    return lists.map((list) => ({ ...list }));
  }

  async findList(id: string) {
    const list = await this.listRepo.findOne({ where: { id } });
    if (!list)
      throw new NotFoundException({ message: 'List not found', code: ErrorCode.LIST_NOT_FOUND });
    return { ...list };
  }

  async updateList(id: string, dto: UpdateBoardListDto) {
    const list = await this.listRepo.findOne({ where: { id } });
    if (!list)
      throw new NotFoundException({ message: 'List not found', code: ErrorCode.LIST_NOT_FOUND });

    // mappedStatus 互斥校验：排除自身，检查同一 Board 下是否已有该状态绑定
    if (dto.mappedStatus !== undefined && dto.mappedStatus !== null) {
      const existing = await this.listRepo.findOne({
        where: { boardId: list.boardId, mappedStatus: dto.mappedStatus },
      });
      if (existing && existing.id !== list.id) {
        throw new ConflictException({
          message: `Board already has a list mapped to "${dto.mappedStatus}"`,
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
    }

    if (dto.name !== undefined) list.name = dto.name;
    if (dto.position !== undefined) list.position = dto.position;
    if (dto.mappedStatus !== undefined) list.mappedStatus = dto.mappedStatus;
    const saved = await this.listRepo.save(list);
    return { ...saved };
  }

  async removeList(id: string, moveTasksTo?: string) {
    const list = await this.listRepo.findOne({ where: { id }, relations: ['tasks'] });
    if (!list)
      throw new NotFoundException({ message: 'List not found', code: ErrorCode.LIST_NOT_FOUND });

    if (list.tasks && list.tasks.length > 0) {
      if (!moveTasksTo) {
        throw new ConflictException({
          message: 'List is not empty. Provide moveTasksTo to transfer tasks.',
          code: ErrorCode.LIST_NOT_EMPTY,
        });
      }
      // 校验目标列真实存在，避免任务被转移到幽灵列（Phase 2）
      await this.resourceValidator.exists(this.listRepo, moveTasksTo, ErrorCode.LIST_NOT_FOUND);
      // 批量转移任务到目标列
      for (const task of list.tasks) {
        await this.taskRepo.update(task.id, { listId: moveTasksTo, position: 0 });
      }
    }

    await this.listRepo.remove(list);
    return true;
  }

  async reorderTasks(listId: string, dto: ReorderTasksDto) {
    const list = await this.listRepo.findOne({ where: { id: listId } });
    if (!list)
      throw new NotFoundException({ message: 'List not found', code: ErrorCode.LIST_NOT_FOUND });
    for (const item of dto.tasks) {
      await this.taskRepo.update(item.id, { position: item.position, listId });
    }
    const tasks = await this.taskRepo.find({ where: { listId }, order: { position: 'ASC' } });
    return tasks.map((task) => ({ ...task }));
  }
}

// ─── digest 内部中间态类型（v1.41） ──────────────────────────────────────────

/** nextUp/risks 行的内部中间态：带 assigneeId，最终统一解析 assigneeName 后投影为共享类型 */
interface DigestTaskRow {
  id: string;
  title: string;
  priority: Priority;
  status: TaskStatus;
  assigneeId: string | null;
}

/** risks 行：DigestTaskRow + labels（PG && 过滤命中 bug/debt 之一） */
interface DigestRiskRow extends DigestTaskRow {
  labels: string[] | null;
}

/** recentDone 行：内部中间态（completedAt 由 service 兜底填充） */
interface DigestDoneRow {
  id: string;
  title: string;
  completedAt: string | Date;
  assigneeId: string | null;
}
