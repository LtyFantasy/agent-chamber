/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.3 (Board / Task)
 *   - 补充: docs/api-definition.md §7.22-7.26 Milestones、docs/spec.md §3.2 MilestoneStatus
 *
 * [踩坑索引] B-50(列表权限过滤) 方案A(creatorId 自管权限) 去嵌套tasks(响应精简) Batch1(topic→board+P2校验) B1-Release(状态机+deployed端点)
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
 *   B1-Release: milestone 增强为 Release 载体（v1.42 批次 B1）：version/body/deployMeta/
 *         deployedAt/verifiedAt 五列 + MilestoneStatus 八态；Service 层流转矩阵隔离
 *         普通/Release 生命周期（version 非空禁落普通态、反之禁落 release 四态）；
 *         deployed 只经 POST /tasks/milestones/:id/deployed 写入（PATCH 400）；补挂
 *         version 须同请求携带 release 状态；同 board version 冲突 23505 → 409。详见
 *         .kimi/plan-info-online-batch-b.md §4-B1。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Milestone } from '../../database/entities/milestone.entity';
import { Task } from '../../database/entities/task.entity';
import { Board } from '../../database/entities/board.entity';
import { ErrorCode, TaskStatus, MilestoneStatus } from '@agent-chamber/shared';
import { ResourceValidator } from '../../common/resource-validator';
import { PermissionService } from '../../common/services/permission.service';
import type { PaginatedResponse, Milestone as MilestoneDto } from '@agent-chamber/shared';
import {
  CreateMilestoneDto,
  UpdateMilestoneDto,
  QueryMilestoneDto,
  MarkMilestoneDeployedDto,
} from './dto';
import { AccessQueryService } from '../../common/services/access-query.service';
import { UnifiedActor } from '../../common/types/actor.types';

/**
 * Release 专属态（version 非空里程碑可落；普通里程碑禁落）。
 * deployed 实际只能经 deployed 端点写入，PATCH 目标为 deployed 时先行 400 拦截，
 * 故不在流转矩阵的合法目标列表中。
 */
const RELEASE_STATUSES: ReadonlySet<MilestoneStatus> = new Set<MilestoneStatus>([
  MilestoneStatus.DEV,
  MilestoneStatus.READY,
  MilestoneStatus.DEPLOYED,
  MilestoneStatus.VERIFIED,
]);

/**
 * 普通专属态（version 为空里程碑可落；Release 里程碑禁落）。
 * cancelled 是两生命周期共享终态，不在任何专属集合中。
 */
const NORMAL_STATUSES: ReadonlySet<MilestoneStatus> = new Set<MilestoneStatus>([
  MilestoneStatus.PLANNED,
  MilestoneStatus.ACTIVE,
  MilestoneStatus.COMPLETED,
]);

/**
 * Release 生命周期合法流转矩阵（PATCH 路径；活文档，docs/spec.md §3.2 同步）：
 * - dev → ready / cancelled
 * - ready → cancelled
 * - deployed → verified（重部署 deployed→deployed 是同值 no-op，走 deployed 端点幂等覆盖）
 * - verified = 终态
 * - deployed 目标一律被 assertStatusTransition 前置拦截（MILESTONE_DEPLOY_VIA_ENDPOINT）
 * - 普通态 → release 初始化（dev/ready）仅「补挂 version」场景合法，在 update 中单独处理
 */
const RELEASE_TRANSITIONS: Readonly<Record<MilestoneStatus, MilestoneStatus[]>> = {
  [MilestoneStatus.DEV]: [MilestoneStatus.READY, MilestoneStatus.CANCELLED],
  [MilestoneStatus.READY]: [MilestoneStatus.CANCELLED],
  [MilestoneStatus.DEPLOYED]: [MilestoneStatus.VERIFIED],
  [MilestoneStatus.VERIFIED]: [],
  [MilestoneStatus.PLANNED]: [],
  [MilestoneStatus.ACTIVE]: [],
  [MilestoneStatus.COMPLETED]: [],
  [MilestoneStatus.CANCELLED]: [],
};

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

    // Release 里程碑（version 非空）的状态约束（普通里程碑零校验、行为不变）：
    // - status 缺省 dev；显式仅可 dev/ready
    // - deployed 只能经 deployed 端点写入（创建时直接置 deployed 一律 400）
    // - verified 前置 deployed（创建时不可能满足）→ 400
    // - 普通四态与 release 态互斥（普通 milestone 传 release 态同样 400，普通态隔离）
    let status = dto.status;
    if (dto.version !== undefined && dto.version !== null && dto.version !== '') {
      if (status === undefined) {
        status = MilestoneStatus.DEV;
      } else if (status === MilestoneStatus.DEPLOYED) {
        throw new BadRequestException({
          message: 'Deployed status can only be set via POST /tasks/milestones/:id/deployed',
          code: ErrorCode.MILESTONE_DEPLOY_VIA_ENDPOINT,
        });
      } else if (
        status !== MilestoneStatus.DEV &&
        status !== MilestoneStatus.READY
      ) {
        throw new BadRequestException({
          message:
            'Release milestone (version set) can only start as dev or ready (default dev)',
          code: ErrorCode.MILESTONE_INVALID_TRANSITION,
        });
      }
    } else if (status !== undefined && RELEASE_STATUSES.has(status)) {
      // 普通 milestone（version 为空）禁落 release 四态
      throw new BadRequestException({
        message: 'Release statuses (dev/ready/deployed/verified) require a version',
        code: ErrorCode.MILESTONE_INVALID_TRANSITION,
      });
    }

    // 记录创建者 Actor ID，用于 update/remove 的「创建者可自管」权限判断（方案 A）。
    // 客户端不可经 dto 覆写 creatorId：全局 ValidationPipe 开 whitelist + forbidNonWhitelisted，
    // CreateMilestoneDto 未声明该字段，多传会被 400 拒绝。
    const milestone = this.milestoneRepo.create({ ...dto, status, creatorId: actor.id });
    try {
      return await this.milestoneRepo.save(milestone);
    } catch (err: unknown) {
      // 同 board 内 version 重复 → 部分唯一索引 23505 → 409（不同 board 同 version 不受影响）
      throw this.translateVersionConflict(err);
    }
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

    const itemsWithStats = items.map((m) => {
      const item = { ...m, stats: statsMap.get(m.id) ?? { total: 0, done: 0, inProgress: 0, open: 0 } } as MilestoneDto;
      // 列表投影（响应体积规范）：body → bodySnippet(300)，deployMeta 不在列表返回
      item.bodySnippet = item.body != null ? item.body.slice(0, 300) : null;
      delete item.body;
      delete item.deployMeta;
      return item;
    });

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

    // ---- Release 状态机（只约束 release/version 相关流转；普通 milestone 既有行为零变更）----
    const attachingVersion =
      dto.version !== undefined && dto.version !== null && dto.version !== '' &&
      milestone.version == null;

    if (attachingVersion) {
      // 存量 milestone 补挂 version：禁止「version 非空 + 普通态」中间态，
      // 必须同请求携带 release 初始状态（dev/ready）。
      if (dto.status === undefined) {
        throw new BadRequestException({
          message: 'Attaching a version requires a release status (dev/ready) in the same request',
          code: ErrorCode.MILESTONE_INVALID_TRANSITION,
        });
      }
      if (dto.status === MilestoneStatus.DEPLOYED) {
        throw new BadRequestException({
          message: 'Deployed status can only be set via POST /tasks/milestones/:id/deployed',
          code: ErrorCode.MILESTONE_DEPLOY_VIA_ENDPOINT,
        });
      }
      if (dto.status !== MilestoneStatus.DEV && dto.status !== MilestoneStatus.READY) {
        throw new BadRequestException({
          message: 'Attaching a version can only initialize status to dev or ready',
          code: ErrorCode.MILESTONE_INVALID_TRANSITION,
        });
      }
    } else if (dto.status !== undefined && dto.status !== milestone.status) {
      // 同值 no-op 放行（如 deployed→deployed 重部署后的 PATCH 确认）；不同值才校验流转
      this.assertStatusTransition(milestone, dto.status);
    }

    Object.assign(milestone, dto);
    if (dto.status === MilestoneStatus.VERIFIED) {
      // 不变量：verified ⇔ verifiedAt 非空（铁律 #18）
      milestone.verifiedAt = new Date();
    }
    try {
      return await this.milestoneRepo.save(milestone);
    } catch (err: unknown) {
      // 同 board 内 version 重复（补挂/改 version 触发唯一索引）→ 409
      throw this.translateVersionConflict(err);
    }
  }

  /**
   * PATCH 路径的状态流转校验（普通/Release 生命周期隔离 + Release 流转矩阵）。
   * @param milestone 当前持久化状态（含 version 类别判定）
   * @param targetStatus 请求目标状态（已排除同值 no-op）
   * @throws BadRequestException 400：MILESTONE_DEPLOY_VIA_ENDPOINT / MILESTONE_INVALID_TRANSITION
   */
  private assertStatusTransition(milestone: Milestone, targetStatus: MilestoneStatus): void {
    // 宽松比较：DB 列 version 为 NULL，防御性兼容 undefined（旧 mock/异常数据不算 release）
    const isRelease = milestone.version != null;

    // deployed 的唯一写口是部署端点本身：无论从哪个状态 PATCH 置 deployed 一律拒绝
    if (targetStatus === MilestoneStatus.DEPLOYED) {
      throw new BadRequestException({
        message: isRelease
          ? 'Deployed status can only be set via POST /tasks/milestones/:id/deployed'
          : 'Release statuses (dev/ready/deployed/verified) require a version',
        code: isRelease
          ? ErrorCode.MILESTONE_DEPLOY_VIA_ENDPOINT
          : ErrorCode.MILESTONE_INVALID_TRANSITION,
      });
    }

    if (isRelease) {
      // Release milestone：禁落普通专属态（planned/active/completed；cancelled 是共享终态）
      if (NORMAL_STATUSES.has(targetStatus)) {
        throw new BadRequestException({
          message: 'Release milestone cannot transition to planned/active/completed',
          code: ErrorCode.MILESTONE_INVALID_TRANSITION,
        });
      }
      // 其余（dev/ready/verified）按矩阵校验；verified 的前置 deployed 由矩阵表达。
      // ?? [] 防御脏数据（status 不在矩阵键中时按非法处理，避免 TypeError）
      if (!(RELEASE_TRANSITIONS[milestone.status] ?? []).includes(targetStatus)) {
        throw new BadRequestException({
          message: `Invalid milestone transition: ${milestone.status} -> ${targetStatus}`,
          code: ErrorCode.MILESTONE_INVALID_TRANSITION,
        });
      }
    } else {
      // 普通 milestone：禁落 release 四态（deployed 已在上方拦截），其余行为零变更
      if (RELEASE_STATUSES.has(targetStatus)) {
        throw new BadRequestException({
          message: 'Release statuses (dev/ready/deployed/verified) require a version',
          code: ErrorCode.MILESTONE_INVALID_TRANSITION,
        });
      }
    }
  }

  /**
   * 部署里程碑（POST /tasks/milestones/:id/deployed）——部署事实的唯一写口（设计原则：
   * 「每个事实有且只有一个写入者」）。幂等：重复部署（热修重部署是常态）合并写入
   * deployMeta 并刷新 deployedAt，响应 = milestone 详情（含 stats）。
   * @param id 里程碑 ID
   * @param dto 全可选 payload（anchors/backup/migrations/deployedAt）
   * @param actor 执行者（需所属 Board write 权限；部署是机器动作，无 creator 自管概念）
   */
  async markDeployed(
    id: string,
    dto: MarkMilestoneDeployedDto,
    actor: UnifiedActor,
  ): Promise<MilestoneDto> {
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
    await this.permService.ensureCan(board, actor, 'write');

    // 前置态：dev/ready 首次部署、deployed 重部署；verified（终态）/cancelled 拒绝
    if (
      milestone.status !== MilestoneStatus.DEV &&
      milestone.status !== MilestoneStatus.READY &&
      milestone.status !== MilestoneStatus.DEPLOYED
    ) {
      throw new BadRequestException({
        message: `Cannot deploy milestone in status ${milestone.status}`,
        code: ErrorCode.MILESTONE_INVALID_TRANSITION,
      });
    }

    milestone.status = MilestoneStatus.DEPLOYED;
    // deployedAt：payload 优先（回填历史部署时间），缺省 = 服务器当前时间
    milestone.deployedAt = dto.deployedAt ? new Date(dto.deployedAt) : new Date();

    // deployMeta 合并写入（只覆盖显式提供的键；undefined 键跳过，幂等重部署不丢旧锚点）
    const patch: Record<string, unknown> = {};
    if (dto.anchors !== undefined) patch.anchors = dto.anchors;
    if (dto.backup !== undefined) patch.backup = dto.backup;
    if (dto.migrations !== undefined) patch.migrations = dto.migrations;
    milestone.deployMeta = { ...(milestone.deployMeta ?? {}), ...patch };

    try {
      const saved = await this.milestoneRepo.save(milestone);
      // 响应 = 详情投影（同 findOne：含 stats，含 deployMeta/body 全量）
      const stats = await this.getStats(saved.id);
      return { ...saved, stats };
    } catch (err: unknown) {
      // 防御：本路径不写 version，正常不会触发；保留翻译保证 23505 永不漏成 500
      throw this.translateVersionConflict(err);
    }
  }

  /**
   * 把 version 唯一索引冲突（23505 / uq_milestones_board_version）翻译为 409。
   * @throws ConflictException 409 MILESTONE_VERSION_CONFLICT（非 version 冲突原样抛出）
   */
  private translateVersionConflict(err: unknown): Error {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'uq_milestones_board_version') {
      return new ConflictException({
        message: 'Milestone version already exists in this board',
        code: ErrorCode.MILESTONE_VERSION_CONFLICT,
      });
    }
    return err as Error;
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
