/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.3 (Board / Task)
 *   - 补充: docs/api-definition.md §7.22-7.26 Milestones
 *
 * [踩坑索引] B-50(列表权限过滤) 方案A(creatorId 自管权限) 去嵌套tasks(响应精简) Batch1(topic→board+P2校验)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #7(测试绑定) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条）
 *   B-50: Milestone 列表接口无 actor 权限过滤，无参数时返回全平台数据；stats
 *         统计也可能包含越权任务。修复：findAll 接收 actor，Service 层通过
 *         topicId IN 过滤可访问 Topic，空白名单直接返回空分页，stats 只计算
 *         过滤后的 milestone。见 Plan §3.4。
 *   方案A: create 写入 creatorId=actor.id；update/remove 权限改为「milestone 创建者
 *         或 topic 写权限（topic 创建者/admin）」。creatorId===null（历史数据）时不走
 *         创建者分支，退化为 topic 写权限向后兼容。安全依赖全局 ValidationPipe
 *         whitelist + forbidNonWhitelisted 阻止客户端经 dto 覆写 creatorId；换 topicId
 *         仍要求 newTopic 写权限（creator 不能挪到只有读权限的 topic）。
 *   去嵌套: findOne 移除 relations: ['tasks']，不再内嵌 milestone 下全部 Task 实体
 *         （含 description 全文）到响应。agent 调用时响应从数十 KB 缩至数百字节。
 *         关联任务由调用方走 GET /tasks?milestoneId=X 分页获取。
 *   Batch1: milestones 从挂 Topic 改挂 Board（topicId→boardId NOT NULL）；权限从
 *         TopicPolicy 链路切到 BoardPolicy（create=board read；update/remove=creator
 *         或 board write）；findAll 用 getAccessibleBoardIds 过滤。P2 修复（task 绑
 *         milestone 存在性+同 board 校验）在 task.service.ts 中。见
 *         .kimi/plan-batch1-milestone-board.md。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Milestone } from '../../database/entities/milestone.entity';
import { Task } from '../../database/entities/task.entity';
import { Board } from '../../database/entities/board.entity';
import { ErrorCode, TaskStatus } from '@agent-chamber/shared';
import { ResourceValidator } from '../../common/resource-validator';
import { PermissionService } from '../../common/services/permission.service';
import type { PaginatedResponse, Milestone as MilestoneDto } from '@agent-chamber/shared';
import { CreateMilestoneDto, UpdateMilestoneDto, QueryMilestoneDto } from './dto';
import { AccessQueryService } from '../../common/services/access-query.service';
import { UnifiedActor } from '../../common/types/actor.types';

@Injectable()
export class MilestoneService {
  constructor(
    @InjectRepository(Milestone)
    private milestoneRepo: Repository<Milestone>,
    @InjectRepository(Task)
    private taskRepo: Repository<Task>,
    @InjectRepository(Board)
    private boardRepo: Repository<Board>,
    private readonly accessQuery: AccessQueryService,
    private readonly resourceValidator: ResourceValidator,
    private readonly permService: PermissionService,
  ) {}

  async create(dto: CreateMilestoneDto, actor: UnifiedActor) {
    // Batch 1: milestone 挂 Board，board 必须存在
    const board = await this.resourceValidator.exists(
      this.boardRepo,
      dto.boardId,
      ErrorCode.BOARD_NOT_FOUND,
    );
    // D-B1-3: create = board read（BoardPolicy 内部自查 participant/invited/editor）
    await this.permService.ensureCan(board, actor, 'read');

    // 记录创建者 Actor ID，用于 update/remove 的「创建者可自管」权限判断（方案 A）。
    // 客户端不可经 dto 覆写 creatorId：全局 ValidationPipe 开 whitelist + forbidNonWhitelisted，
    // CreateMilestoneDto 未声明该字段，多传会被 400 拒绝。
    const milestone = this.milestoneRepo.create({ ...dto, creatorId: actor.id });
    return this.milestoneRepo.save(milestone);
  }

  async findAll(
    query: QueryMilestoneDto,
    actor?: UnifiedActor,
  ): Promise<PaginatedResponse<MilestoneDto>> {
    const { boardId, page = 1, pageSize = 20 } = query;

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

    const qb = this.milestoneRepo.createQueryBuilder('milestone');

    if (accessibleBoardIds) {
      qb.andWhere('milestone.board_id IN (:...accessibleBoardIds)', { accessibleBoardIds });
    }
    if (boardId) {
      qb.andWhere('milestone.board_id = :boardId', { boardId });
    }

    const [items, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .orderBy('milestone.createdAt', 'DESC')
      .getManyAndCount();

    // 批量计算 stats，只统计过滤后的 milestone，避免 N+1
    const milestoneIds = items.map((m) => m.id);
    const statsMap =
      milestoneIds.length > 0
        ? await this.getStatsBatch(milestoneIds)
        : new Map<string, { total: number; done: number; inProgress: number; open: number }>();

    const itemsWithStats = items.map((m) => ({
      ...m,
      stats: statsMap.get(m.id) ?? { total: 0, done: 0, inProgress: 0, open: 0 },
    }));

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: itemsWithStats,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
    };
  }

  async findOne(id: string, actor: UnifiedActor): Promise<MilestoneDto> {
    // 不再 join tasks（relations: ['tasks']），避免一次性返回 milestone 下全部 Task 完整实体
    // （含 description 全文）导致外部 Agent 响应巨大。关联任务走 GET /tasks?milestoneId= 分页获取。
    const milestone = await this.milestoneRepo.findOne({ where: { id } });
    if (!milestone) {
      throw new NotFoundException({
        message: 'Milestone not found',
        code: ErrorCode.MILESTONE_NOT_FOUND,
      });
    }

    // D-B1-3: findOne = board read
    const board = await this.resourceValidator.exists(
      this.boardRepo,
      milestone.boardId,
      ErrorCode.BOARD_NOT_FOUND,
    );
    await this.permService.ensureCan(board, actor, 'read');

    // 统计任务数据（不嵌套实体，只返回统计数字）
    const stats = await this.getStats(id);

    return { ...milestone, stats };
  }

  private async getStats(milestoneId: string) {
    const tasks = await this.taskRepo.find({
      where: { milestoneId },
      select: ['status'],
    });

    const total = tasks.length;
    const done = tasks.filter(
      (t) => t.status === TaskStatus.DONE || t.status === TaskStatus.ARCHIVED,
    ).length;
    const inProgress = tasks.filter((t) => t.status === TaskStatus.IN_PROGRESS).length;
    const open = tasks.filter(
      (t) =>
        t.status === TaskStatus.BACKLOG ||
        t.status === TaskStatus.TODO ||
        t.status === TaskStatus.REVIEW ||
        t.status === TaskStatus.BLOCKED,
    ).length;

    return { total, done, inProgress, open };
  }

  /**
   * 批量获取多个 milestone 的 stats（避免 N+1）
   */
  private async getStatsBatch(milestoneIds: string[]) {
    const tasks = await this.taskRepo.find({
      where: { milestoneId: In(milestoneIds) },
      select: ['milestoneId', 'status'],
    });

    const map = new Map<
      string,
      { total: number; done: number; inProgress: number; open: number }
    >();
    for (const id of milestoneIds) {
      map.set(id, { total: 0, done: 0, inProgress: 0, open: 0 });
    }

    for (const task of tasks) {
      if (!task.milestoneId) continue;
      const stats = map.get(task.milestoneId);
      // 只统计在过滤后 milestoneIds 列表中的任务，防御越权/脏数据
      if (!stats) continue;
      stats.total++;
      if (task.status === TaskStatus.DONE || task.status === TaskStatus.ARCHIVED) {
        stats.done++;
      } else if (task.status === TaskStatus.IN_PROGRESS) {
        stats.inProgress++;
      } else {
        stats.open++;
      }
    }

    return map;
  }

  async update(id: string, dto: UpdateMilestoneDto, actor: UnifiedActor) {
    const milestone = await this.milestoneRepo.findOne({ where: { id } });
    if (!milestone) {
      throw new NotFoundException({
        message: 'Milestone not found',
        code: ErrorCode.MILESTONE_NOT_FOUND,
      });
    }

    const currentBoard = await this.resourceValidator.exists(
      this.boardRepo,
      milestone.boardId,
      ErrorCode.BOARD_NOT_FOUND,
    );
    // 方案 A: milestone 创建者可直接编辑；否则需对所属 Board 有写权限（creator/editor）。
    // creatorId === null（历史 milestone）时不走创建者分支，退化为 board 写权限，向后兼容。
    const isMilestoneCreator = milestone.creatorId !== null && milestone.creatorId === actor.id;
    if (!isMilestoneCreator) {
      await this.permService.ensureCan(currentBoard, actor, 'write');
    }

    // 变更 boardId 时，校验新 Board 真实存在且对 actor 有写权限，避免 milestone 变成孤立数据。
    if (dto.boardId && dto.boardId !== milestone.boardId) {
      const newBoard = await this.resourceValidator.exists(
        this.boardRepo,
        dto.boardId,
        ErrorCode.BOARD_NOT_FOUND,
      );
      await this.permService.ensureCan(newBoard, actor, 'write');
    }

    Object.assign(milestone, dto);
    return this.milestoneRepo.save(milestone);
  }

  async remove(id: string, actor: UnifiedActor) {
    const milestone = await this.milestoneRepo.findOne({ where: { id } });
    if (!milestone) {
      throw new NotFoundException({
        message: 'Milestone not found',
        code: ErrorCode.MILESTONE_NOT_FOUND,
      });
    }

    const board = await this.resourceValidator.exists(
      this.boardRepo,
      milestone.boardId,
      ErrorCode.BOARD_NOT_FOUND,
    );
    // 方案 A: milestone 创建者可直接删除；否则需对所属 Board 有写权限（creator/editor）。
    // creatorId === null（历史 milestone）时不走创建者分支，退化为 board 写权限，向后兼容。
    const isMilestoneCreator = milestone.creatorId !== null && milestone.creatorId === actor.id;
    if (!isMilestoneCreator) {
      await this.permService.ensureCan(board, actor, 'write');
    }

    // 级联清空关联任务的 milestoneId
    await this.taskRepo.update({ milestoneId: id }, { milestoneId: null });

    await this.milestoneRepo.remove(milestone);
    return true;
  }
}
