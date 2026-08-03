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
 *
 * [踩坑索引] B-45(reorder返回null) B-41(列表页任务统计0/0) B-5(可见性缺失) B-6(可见性继承缺失) D5(权限迁移) B-50(列表权限过滤)
 *
 * [铁律关联] #18(不变量检查) #4(文档优先) #12(文档联动)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   BoardDetail 不再 join tasks: findById relations 改为 ['lists']；enrich 通过 QueryBuilder
 *     聚合 taskCount / completedTaskCount / 每列 taskCount，避免大 Board 全量加载任务。
 *   B-45: reorderLists/reorderTasks 返回 null。TypeORM 实体序列化时动态赋值丢失。
 *         修复：返回 plain object 数组 [ { ...entity } ] 而非实体数组。
 *         见 memory/2026-06-05.md
 *   B-41: Board findAll 列表页任务统计始终显示 0/0。TypeORM 实体动态赋值在 NestJS
 *         序列化时被数据库原始值覆盖。修复：显式展开为 plain object
 *         { ...b, taskCount, completedTaskCount }。见 memory/2026-06-04.md §11
 *   B-6: Board 未继承 Topic 可见性，Topic 私密但 Board 仍公开。
 *         修复：effectiveVisibility = max(Topic.vis, Board.vis)。见 memory/2026-05-25.md
 *   B-5: Topic/Board 缺少可见性控制，私密资源可公开访问。
 *         修复：canAccess() + Visibility enum + findAll 过滤。见 memory/2026-05-25.md
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
import { Repository, In, IsNull } from 'typeorm';
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
  BoardMemberRole,
  EventType,
} from '@agent-chamber/shared';
import type {
  BoardDetail,
  BoardListSummary,
  PaginatedResponse,
  TaskSummary,
} from '@agent-chamber/shared';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ResourceValidator } from '../../common/resource-validator';
import { UnifiedActor } from '../../common/types/actor.types';
import { BoardList } from '../../database/entities/board-list.entity';
import { Task } from '../../database/entities/task.entity';
import { TaskService } from '../task/task.service';
import { EventService } from '../event/event.service';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { QueryTaskDto } from '../task/dto';
import {
  CreateBoardDto,
  UpdateBoardDto,
  CreateBoardListDto,
  ReorderBoardListsDto,
  UpdateBoardListDto,
  ReorderTasksDto,
  FindListTasksQueryDto,
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
  ) {}

  /**
   * 批量解析 Actor 类型
   * participant_type / creator_type 等列即将删除，加载实体时该字段为 undefined，
   * 需要通过 actors 表重新推导类型。
   */
  private async resolveActorTypes(actorIds: string[]): Promise<Map<string, ActorType>> {
    const uniqueIds = [...new Set(actorIds)].filter(Boolean);
    if (uniqueIds.length === 0) return new Map();
    const actors = await this.actorRepo.find({ where: { id: In(uniqueIds) } });
    return new Map(actors.map((a) => [a.id, a.type]));
  }

  /**
   * 批量聚合 Actor 公开信息（类型、显示名、头像、描述）
   */
  private async resolveActorProfiles(actorIds: string[]): Promise<
    Map<
      string,
      {
        type: ActorType;
        name: string;
        avatarUrl: string | null;
        description: string | null;
      }
    >
  > {
    const typeMap = await this.resolveActorTypes(actorIds);
    const humanIds = actorIds.filter((id) => typeMap.get(id) === ActorType.HUMAN);
    const agentIds = actorIds.filter((id) => typeMap.get(id) === ActorType.AGENT);

    const [humans, agents] = await Promise.all([
      humanIds.length > 0
        ? this.userRepo.find({ where: { id: In(humanIds) }, relations: { actor: true } })
        : Promise.resolve([] as User[]),
      agentIds.length > 0
        ? this.agentRepo.find({ where: { id: In(agentIds) }, relations: { actor: true } })
        : Promise.resolve([] as Agent[]),
    ]);

    const humanMap = new Map(humans.map((u) => [u.id, u]));
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const result = new Map<
      string,
      { type: ActorType; name: string; avatarUrl: string | null; description: string | null }
    >();
    for (const id of actorIds) {
      const type = typeMap.get(id);
      if (type === ActorType.HUMAN) {
        const user = humanMap.get(id);
        result.set(id, {
          type,
          name: user?.displayName || user?.username || 'Unknown User',
          avatarUrl: user?.avatarUrl ?? null,
          description: null,
        });
      } else if (type === ActorType.AGENT) {
        const agent = agentMap.get(id);
        result.set(id, {
          type,
          name: agent?.name || 'Unknown Agent',
          avatarUrl: agent?.avatarUrl ?? null,
          description: agent?.description ?? null,
        });
      }
    }
    return result;
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
        name: profile?.name || 'Unknown',
        type: (profile?.type === ActorType.HUMAN ? 'human' : 'agent') as 'human' | 'agent',
        avatarUrl: profile?.avatarUrl ?? null,
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
   * @param query - 分页/话题过滤条件
   * @param actor - 当前统一身份；Admin 不过滤，非 Admin 用白名单 IN 过滤
   */
  async findAll(
    query: { page?: number; pageSize?: number; topicId?: string } = {},
    actor?: UnifiedActor,
  ) {
    const { page = 1, pageSize = 20, topicId } = query;

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

    const qb = this.boardRepo
      .createQueryBuilder('board')
      .leftJoinAndSelect('board.lists', 'list')
      .where('board.deleted_at IS NULL');

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
      const activeLists = b.lists?.filter((l) => !l.deletedAt) ?? [];
      const counts = countMap.get(b.id);

      const sortedLists = b.lists
        ? [...b.lists].sort((a, b) => {
            const posDiff = (a.position ?? 0) - (b.position ?? 0);
            if (posDiff !== 0) return posDiff;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          })
        : b.lists;

      const { description, ...rest } = b;
      void description;

      return {
        ...rest,
        lists: sortedLists,
        taskCount: counts?.total ?? 0,
        completedTaskCount: counts?.completed ?? 0,
        listCount: activeLists.length,
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

    // 批量校验 invitedAgentIds 中所有 Agent 真实存在，避免脏数据
    const invitedAgentIds = dto.invitedAgentIds || [];
    if (invitedAgentIds.length > 0) {
      await this.resourceValidator.existsMany(
        this.agentRepo,
        invitedAgentIds,
        ErrorCode.AGENT_NOT_FOUND,
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

    // 为 invitedAgentIds 创建 board_members 行 (role='member')；Set 去重防同批 PK 冲突
    if (invitedAgentIds.length > 0) {
      const memberEntities = [...new Set(invitedAgentIds)].map((agentId) =>
        this.memberRepo.create({
          boardId: savedBoard.id,
          actorId: agentId,
          role: BoardMemberRole.MEMBER,
          invitedBy: creatorId,
        }),
      );
      await this.memberRepo.save(memberEntities);
    }

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
      if (dto.invitedAgentIds.length > 0) {
        await this.resourceValidator.existsMany(
          this.agentRepo,
          dto.invitedAgentIds,
          ErrorCode.AGENT_NOT_FOUND,
        );
      }

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
      if (toAdd.length > 0) {
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

    // 校验 Agent 真实存在
    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

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
      resourceType: 'board',
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

    // 校验 Agent 真实存在
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
      resourceType: 'board',
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

    // 校验 Agent 真实存在
    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

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
      resourceType: 'board',
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

    // 校验 Agent 真实存在
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
      resourceType: 'board',
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
