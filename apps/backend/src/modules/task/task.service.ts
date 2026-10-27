/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.3 (Board / Task)
 *   - 补充: docs/api-definition.md §7. Tasks（PATCH /tasks/:id 的 `expectedUpdatedAt` 与
 *     409 契约、§18.7「可选的锁 = 没有锁」的一般结论——本端点是有意例外）、
 *     docs/spec.md §3.2 TaskStatus 与任务并发语义
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（service 层插桩点 =
 *     create/update/patchDescription/addComment/addDocLink——create 有内部调用方
 *     batchCreate（batch 不单独记，循环自然产 N 行）；update/addComment/addDocLink
 *     有内部调用方 reportResult（report 不单独记，构成写各自落行，幂等 replay 跳过
 *     步骤自然不双记）；patchDescription 幂等 replay 不记。move/remove/assign/
 *     dependency/doc-link 删除在 controller 层）
 *
 * [踩坑索引] B-50(列表权限过滤) B-50-EVT(任务事件boardId) B-42(单对象返回null) B-49(softDelete500) B-3(completedAt缺失) B-4(move到不存在的list) D5(权限迁移) P1-1(findOne载荷瘦身) Batch1-P2(milestone绑定校验) Batch3(topicId下线) R1(公共解析收口) A2.5(assignee须usable) WS-A(orderBy表达式坑) LOCK-LOCKED-ROW(任务乐观锁必须锁内判定) LOCK-TOCTOU-PERM(锁内重跑权限) LOCK-TOKEN-LEAK(锁token非实体字段) F4-2(跨板写族四门+assignee∧boardRead) P-N3(resolveTaskBoard 须与单条 GET 同口径含软删板)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #7(测试绑定) #9(代理层透传) #23(ORM/锁语义须真PG覆盖)
 *
 * [凭证扫描挂点]（v1.94.0-dev，卡 349d337e）四个调用点：create 的**两条返回路径**
 *   （无幂等键 / 有幂等键齐步；replay 分支禁扫）/ update（仅 `dto.description` 存在时）/
 *   patchDescription（只扫 `newString`；入口 replay 与并发 23505 都提前返回 ⇒ 天然不扫）/
 *   addComment（save 成功后）。命中只落告警行 + 领域事实（`hints/credential-scan.ts`），
 *   正文不进日志 / 事实 / hint data。
 *
 * [hint 事实挂点]（值导入 `hints/hint-facts` 的 `emitFact`；载荷只放 ID / 状态标量 /
 *   任务**标题**，**禁正文**）：
 *   - `task.created`（v1.95.0-dev 撞重提示）：create 的**两条真实写入路径**齐步
 *     （与凭证扫描同一位置）；**幂等 replay 分支不 emit**（2 期固化契约）。载荷
 *     `{taskId, boardId?, title}`——拿不到 boardId 就省键（provider fail-closed 跳过）。
 *     `batchCreate` 循环调 create ⇒ 天然覆盖（一次批建 = N 条事实）。
 *   - `task.status_changed`：update 的两条路径 + move 的自动改状态（详见各自调用点注释）。
 *   - `task.comment_added`：addComment（`via` 只在 reportResult 内部路径带）。
 *
 * [事件挂点]（`eventService.create`；notifications 一期 S1 起补 TASK_ASSIGNED）：
 *   - `TASK_UPDATE`：create 的两条真实写入路径（action='created'）/ update（action='updated'，
 *     载荷含 **fromStatus/toStatus** 跃迁前后值——下游据此判完工，见 plan
 *     nightcrawler-black-hawk-devil-dinosaur §5）/ move（action='moved'，autoStatus 分支带跃迁）
 *     / patchDescription（action='updated' + fieldName='description'，**无 status**——描述局部写
 *     不涉及状态，消费侧不得据此判完工）。
 *   - `TASK_ASSIGNED`：**两条入口**——update（PATCH `{assigneeId}` 改派）与 assign
 *     （POST /tasks/:id/assign）。**仅当 assigneeId 由旧值变为非空新值时发**：取消分配（→null）
 *     与重复指派同一人都不发——skill `agent-chamber` §5.3 定义其消费方是「被分配者」，
 *     无被分配者即无该事实（别把"字段有变化就发"当同义词）。载荷
 *     `{taskId, assigneeId, assigneeName, boardId?, topicId?}`，派生失败省键。
 *     改这两处前先读 skill `agent-chamber` §5.3 事件表。
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   LOCK-LOCKED-ROW: update() 的可选乐观锁 `expectedUpdatedAt` **必须在一个事务 + 行锁
 *       内完成**（锁内重读 → 锁内比对 token → 派生写与 save 全部落在锁定行上）。
 *       "先 findOne 比 token、再 save"是 TOCTOU 窗口：并发双写会双双通过、后写覆盖前写
 *       （先例 experience.service 的 M3 同款事故）。token 比对**只在 JS 侧**做毫秒
 *       getTime()：`updated_at` 由 TypeORM 以 `CURRENT_TIMESTAMP` 写（µs 精度，读侧截到
 *       ms），SQL 级时间等值谓词会静默不命中 = "一切 409"；已知限制 = 两次写的事务开始
 *       毫秒相同则 ABA（毫秒量级窗口）。副作用（事件/活动/审计/touch）一律在**提交之后**
 *       跑，行锁不被下游 IO 拖长。并发语义只能靠真 PG 覆盖（mock 桩掉事务与 QueryBuilder
 *       什么都证不了）：test/task-optimistic-lock.e2e-spec.ts。2026-10-16 卡 09ffa9a8。
 *   LOCK-POOL-EXHAUST: 行锁事务**持有 1 条连接**，而锁内的权限重跑（TaskPolicy→
 *       BoardPolicy 2-4 条查询）与派生写用的仍是**全局 Repository** → 每条并发请求还要
 *       临时再借 1 条。连接池被"全部占满且都在等第 2 条"时**永久挂死**（pg `Pool.connect()`
 *       默认不超时），条件 = 带 token 的并发 PATCH 数 ≥ poolSize。当前 poolSize 已显式设为
 *       pg-session-defaults.ts 的 PG_POOL_SIZE（抬高阈值，**不消除**死锁：根因是"事务+行锁
 *       内再用全局 repo"，本仓同款形态还有 patchDescription（本文件 :1690 附近）、
 *       doc.service.ts:1231/3633、doc-move.service.ts:488、docspace.service.ts:1595）。
 *       彻底修法 = 把事务 `manager` 透传进这些查询，属跨模块改造，需单独立卡。
 *   LOCK-TOCTOU-PERM: controller 的第一份快照判权（findById → ensureCan）**不是充分条件**
 *       ——并发 move/改派可在"判权"与"加锁"之间把任务换到当前 actor 无写权的 board。
 *       故锁内基于**锁定行**重跑同一 write 判定，且排在 token 比对**之前**（无权限 +
 *       stale token 该得 403 而非 409；否则 409 会沦为"存在且有人并发写"的 oracle）。
 *   LOCK-TOKEN-LEAK: `expectedUpdatedAt` 是锁 token、**不是实体字段**（tasks 表无此列）：
 *       必须剥在批量合并回环之外，否则会挂到实体上并经 toPlain() 的 `...task` 展开泄漏
 *       进 PATCH 响应（实体展开 = 响应契约），还会混进活动日志的 fieldName 假字段。
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
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource, EntityManager } from 'typeorm';
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
  ResourceType,
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
// 权限门面（PermissionModule 是 @Global()，common/permission.module.ts:24，直接注入即可，
// 无循环依赖）。update() 的乐观锁路径用它做**锁内重跑**判定（TOCTOU，卡 09ffa9a8）
import { PermissionService } from '../../common/services/permission.service';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
// hint 事实袋（阶段二「该提名了」提示的**输入**）：service 只写领域语言的事实，
// hint 层在响应封装前翻译成 hints[]。⚠️ 必须 import 平台单例（禁本地 new 一份 ALS，
// 否则 provider 读到的袋恒为空、提示静默消失）；无请求袋时 emitFact 是 no-op（fail-open）
import { emitFact } from '../hints/hint-facts';
// 凭证粘贴扫描（v1.94.0-dev，卡 349d337e）：**四个** task 写入挂点共用同一 helper——
// create（幂等/无幂等两条返回路径齐步、replay 不扫）/ update（仅 dto.description 存在时）/
// patchDescription（只扫 newString；replay 提前返回故自然不扫）/ addComment
import { emitCredentialScanFactIfHit } from '../hints/credential-scan';
import { AuditAction } from '@agent-chamber/shared';
import type { PaginatedResponse, TaskSummary } from '@agent-chamber/shared';
import { TASK_SEARCH_WEAK_HIT_SCORE, TASK_SEARCH_ZERO_HIT_HINT } from '@agent-chamber/shared';
import type { TaskDocLinkItem } from '@agent-chamber/shared';
import { compileQuery, type CompiledQuery } from '../../common/utils/search/tsquery-compiler';
import {
  buildSearchSql,
  COMPILED_Q_PARAM,
  type SearchSqlGroup,
} from '../../common/utils/search/search-sql';
import { logSearchZeroHit } from '../../common/utils/search/zero-hit-log';

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

/**
 * `applyTaskUpdate()` 的产出（内部类型，不对外导出）。
 *
 * 把「写入阶段算出来的前后值」显式带到 `finishTaskUpdate()` 的副作用阶段——
 * 锁路径下两个阶段之间隔了一次事务提交，无法再靠局部变量传递。
 */
interface TaskUpdateOutcome {
  /** 落库行（响应展开与副作用判据的唯一来源） */
  saved: Task;
  /** 变更前状态（状态机 + `task.status_changed` 事实 + 事件 fromStatus） */
  oldStatus: TaskStatus;
  /** 变更前 listId（审计；可能被 status→mappedStatus 自动吸附改写） */
  oldListId: string;
  /** 变更前 assigneeId（`TASK_ASSIGNED` 事实判据 + 审计） */
  oldAssigneeId: string | null;
  /** `undefined` = DTO 未传 assigneeId（不变更）；`null` = 显式取消分配 */
  effectiveAssigneeId: string | null | undefined;
  /** 已剥 `assigneeId` / `expectedUpdatedAt` 的 DTO 残余，活动日志 fieldName 的唯一来源 */
  restDto: Record<string, unknown>;
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

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
    private readonly auditService: AuditService,
    private readonly permService: PermissionService,
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
  ): Promise<PaginatedResponse<TaskSummary> & { hint?: string }> {
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

    // ── q= 全文检索（v1.86 中文根治接线：compiled + rank 通道 + hint 信封加性键）────
    const trimmedQ = query.q?.trim() ?? '';
    let compiled: CompiledQuery | null = null;
    let searchGroup: SearchSqlGroup | null = null;
    if (trimmedQ) {
      compiled = compileQuery(trimmedQ);
      if (compiled.isEmpty) {
        // 空查询短路返回空（契约③按面枚举：search.service/task q= → 短路——纯标点/
        // 全剥离查询落这里）。这是「检索无结果」不是缺省列表请求：零命中日志 + hint 照常
        logSearchZeroHit(this.logger, {
          surface: 'task',
          query: trimmedQ,
          queryTruncated: compiled.queryTruncated,
          armTruncatedCount: compiled.armTruncatedCount,
        });
        return {
          items: [],
          total: 0,
          page: +page,
          pageSize: +pageSize,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
          hint: TASK_SEARCH_ZERO_HIT_HINT,
        };
      }
      // 不挂 K-gate（主脑裁决 #2：messages/tasks 只换 compiled `@@` + ts_rank_cd rank，
      // 召回语义变更未授权不做）；`:compiledQ` 只经 setParameter 下发（F1 硬约束），
      // SQL 侧经导出组 `to_tsquery('simple', …)` 包裹（tsqueryin 原子语义防线，1-b 实证）
      searchGroup = buildSearchSql(
        {
          vector: 'task.search_vector',
          text: "COALESCE(task.title, '') || ' ' || COALESCE(task.description, '')",
        },
        compiled,
        { startSel: '<<<', stopSel: '>>>' },
      ) as SearchSqlGroup;
      qb.andWhere(searchGroup.prefilterExpr).setParameter(COMPILED_Q_PARAM, compiled.tsquery);
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

    if (searchGroup !== null) {
      // rank 通道（有 q 时接管排序——搜索请求的相关度是表达意图；先例 search.service.ts
      // searchTasks，B-55 纪律：skip/take + innerJoin + orderBy('rank') 必须显式
      // addSelect rank 否则 TypeORM 0.3.30 distinctAlias 类错误）。cd flag 0 直接作 rank；
      // 次键 createdAt DESC + id ASC 兜底全序（PG 不保证无主序时跨页稳定）。
      // 注：q 与 sort=statusPriority 同现时 rank 通道优先（q 的相关度语义是搜索意图本体）。
      qb.addSelect(searchGroup.scoreExpr, 'rank')
        .orderBy('rank', 'DESC')
        .addOrderBy('task.createdAt', 'DESC')
        .addOrderBy('task.id', 'ASC');
    } else if (query.sort === 'statusPriority') {
      // 状态优先级排序（opt-in）：in_progress > todo > blocked > backlog > 其余
      // （review/done/archived 恒末位）。CASE 权重越小越靠前；updatedAt DESC 次键 +
      // id ASC 第三键兜底稳定分页（PG 不保证无主序时跨页稳定，plan 架构师修订）。
      // ⚠️ TypeORM 对含 "." 的 orderBy 键按 alias.property 解析（CASE 表达式会被误
      // split 抛错），故 CASE 经 addSelect 命名列 + orderBy 别名。别名必须全小写：
      // getManyAndCount 回捞实体的主查询把 orderBy 键原样拼 SQL（不 escape），
      // 大写别名会被 PG 折叠成小写导致 "column does not exist"（真 PG 实测）。
      // CASE 状态字面量经 shared TaskStatus 枚举模板插值（受信代码无注入面；
      // review-0831 任务 e013af33 收敛，生成 SQL 与现状逐字一致）
      qb.addSelect(
        `CASE task.status
          WHEN '${TaskStatus.IN_PROGRESS}' THEN 0
          WHEN '${TaskStatus.TODO}' THEN 1
          WHEN '${TaskStatus.BLOCKED}' THEN 2
          WHEN '${TaskStatus.BACKLOG}' THEN 3
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

    let items: Task[];
    let total: number;
    /** 本页最高 rank（有 q 时用于弱命中 hint 判定；page-max 口径与 doc-search 一致） */
    let pageTopRank: number | undefined;
    if (searchGroup !== null) {
      // 有 q：取实体页 + raw rank 值（getRawAndEntities 的 raw 与 entities 按索引对应）
      // + 独立 count（与 getManyAndCount 同为两条查询，成本不变）
      const [{ entities, raw }, count] = await Promise.all([qb.getRawAndEntities(), qb.getCount()]);
      items = entities;
      total = count;
      const ranks = (raw as Record<string, unknown>[])
        .map((row) => Number(row['rank']))
        .filter((value) => Number.isFinite(value));
      pageTopRank = ranks.length > 0 ? Math.max(...ranks) : undefined;
    } else {
      [items, total] = await qb.getManyAndCount();
    }

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
    // hint 信封加性键（主脑裁决 #1，零破坏）：仅 q= 检索时可能触发——零命中（落零命中
    // 日志）或本页最高 rank < TASK_SEARCH_WEAK_HIT_SCORE（0.3）。
    // ⚠️ 本面 rank 通道是**裸** ts_rank_cd（未乘 SEARCH_TS_W1）⇒ 尺度与"cd 单点 0.1 ×
    // W1=1.0"的基准线一致，直接读基准值；**不要**换成 doc-search 侧的
    // DOC_SEARCH_WEAK_HIT_SCORE（那是基准 × W1 的现构，本面会整体失效——两侧分家见
    // 主脑裁决 R4，批次 1-d2）
    let hint: string | undefined;
    if (compiled !== null) {
      if (total === 0) {
        logSearchZeroHit(this.logger, {
          surface: 'task',
          query: trimmedQ,
          queryTruncated: compiled.queryTruncated,
          armTruncatedCount: compiled.armTruncatedCount,
        });
        hint = TASK_SEARCH_ZERO_HIT_HINT;
      } else if (pageTopRank !== undefined && pageTopRank < TASK_SEARCH_WEAK_HIT_SCORE) {
        hint = TASK_SEARCH_ZERO_HIT_HINT;
      }
    }
    return {
      items: enrichedItems,
      total,
      page,
      pageSize,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      ...(hint !== undefined ? { hint } : {}),
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

  /**
   * 解析创建任务的目标 Board（B-58 权限前置检查用，与 create() 的 boardId 解析顺序
   * 逐字对齐，避免 controller 重复实现解析逻辑造成漂移）：
   * ① listId/statusName 都缺 → 400（与 create 契约一致）
   * ② statusName 路径 → 要求 boardId，resolveListIdByStatusName 回填 dto.listId
   *    （副作用与 create 一致；controller 先调本方法后 create 再跑解析是幂等的）
   * ③ boardId 显式 → 校验 Board 存在并返回
   * ④ 仅 listId → 从 list→board 推断（list 的 board 软删/缺失时无法判定权限 → 404）
   * @param dto 创建任务 DTO（statusName 路径会回填 dto.listId）
   * @returns 目标 Board 实体（不存在抛 404）
   */
  async resolveCreateBoard(dto: CreateTaskDto): Promise<Board> {
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
    if (dto.boardId) {
      return this.resourceValidator.exists(this.boardRepo, dto.boardId, ErrorCode.BOARD_NOT_FOUND);
    }
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
    if (!list.board) {
      // list 存在但 board 软删/缺失：create 会照常落库（boardId 仍可派生），但权限
      // 无法判定——安全默认拒绝（404，与 ensureCan read 语义一致，不泄露存在性）
      throw new NotFoundException({
        message: 'Board not found',
        code: ErrorCode.BOARD_NOT_FOUND,
      });
    }
    return list.board;
  }

  /**
   * 解析 Task 所属 Board（B-58 批量权限前置检查用；orphan task 无 listId 返回 null =
   * 公开，与 TaskPolicy 的 orphan 语义一致）
   *
   * ⚠️ **含软删板**（P-N3 镜面一致性）：`GET /tasks/blockers/batch`（task.controller.ts:898-915）
   * 与单条 `GET /tasks/:id` 必须同口径。不带 `withDeleted` 时软删板的 JOIN 被
   * `deleted_at IS NULL` 过滤 ⇒ 本方法返回 null ⇒ batch 走 `if (!board) continue`
   * **放行**，而单条 GET 走 TaskPolicy 的软删板分支拿 404 —— 同一状态在两处一放一拒，
   * 就是一条可探测的「单条 404 / 批量放行」**存在性 oracle 分叉**（P-N3）。
   * 载入软删板后判定交给同一份谓词（controller 的 `permService.can(board, actor, 'read')`）：
   * OPEN 软删板外人仍可读、PRIVATE 软删板外人 403 —— 与单条 GET 结论一致（404 vs 403
   * 是 batch 端点既有且已在 controller:902 注释文档化的差异，不是分叉）。
   *
   * `withDeleted` 的钝器语义（对主实体与所有 join 同时生效）见
   * `common/policies/task.policy.ts` 的 reloadListWithBoard；⚠️ **顺序同样必须
   * `withDeleted()` 在 join 之前**（join 的软删条件在 join() 当场定，后置无效——
   * TypeORM SelectQueryBuilder.js:975-990）。本方法不判板是否已删，故无需 addSelect。
   *
   * @param task 已加载的 Task 实体
   * @returns 所属 Board 实体（含软删板）；orphan task 或 list/board 行不存在返回 null
   */
  async resolveTaskBoard(task: Task): Promise<Board | null> {
    if (!task.listId) return null;
    const list = await this.boardListRepo
      .createQueryBuilder('list')
      .withDeleted()
      .leftJoinAndSelect('list.board', 'board')
      .where('list.id = :id', { id: task.listId })
      .getOne();
    return list?.board ?? null;
  }

  /**
   * 「列 → 所属 boardId」（跨板写族判定用；列不存在返回 null）。
   * 只选 `board_id` 一列——跨板判定不需要 board 实体，避免把整行板数据拉进来。
   * 注意 `findOne` 仍过滤软删列：软删列 → null → 调用方按「跨板」处理（fail-closed）。
   */
  private async resolveListBoardId(listId: string): Promise<string | null> {
    const list = await this.boardListRepo.findOne({ where: { id: listId }, select: ['boardId'] });
    return list?.boardId ?? null;
  }

  /**
   * 跨板写族统一门（V2-N2 / S-N2）：断言 actor 对 `listId` 所属的板有 write。
   * 四个写入点（update 改 listId / move / removeList.moveTasksTo / reorderTasks）统一经
   * `assertCrossBoardPlacement` 走它——四份手写校验必然漂移。
   *
   * ⚠️ 本门**与方向无关**（判定对象只有"该列所属板可写"这一条谓词），作用在哪一端由调用点
   * 按威胁模型决定：**防注入**（update / move / removeList）传**目标**列；**防取出**
   * （reorder）传 item 的**当前**列。理由见各调用点注释，改调用点前先读它们。
   *
   * 404/403 语义照 `resolveCreateBoard` 先例（本文件 :752-770）：
   * - 目标列不存在 → 404 LIST_NOT_FOUND
   * - 列存在但 board 软删/缺失 → 404 BOARD_NOT_FOUND（权限无法判定时安全默认拒绝，
   *   与 create 对软删板的行为一致）
   * - board 存在但 actor 无 write → 403 PERMISSION_DENIED（ensureCan）
   *
   * @param actor 统一身份。**必须传完整 `{id,type,role}` 对象**——传迷你对象（只 id/type）
   *   会让 BoardPolicy 的 `actor?.role === ADMIN` bypass 静默失效（A-C2 实证）
   * @param listId 目标列 id
   */
  async assertCanPlaceTaskInList(actor: UnifiedActor, listId: string): Promise<void> {
    const list = await this.boardListRepo.findOne({
      where: { id: listId },
      relations: ['board'],
    });
    if (!list) {
      throw new NotFoundException({
        message: 'Board list not found',
        code: ErrorCode.LIST_NOT_FOUND,
      });
    }
    if (!list.board) {
      throw new NotFoundException({
        message: 'Board not found',
        code: ErrorCode.BOARD_NOT_FOUND,
      });
    }
    await this.permService.ensureCan(list.board, actor, 'write');
  }

  /**
   * 跨板写族的**触发条件**：目标列与任务当前列是否不同板。
   *
   * 契约（A-C2/P-N1）——**仅 targetBoardId ≠ currentBoardId 时校验**：同板流转只认任务
   * write（controller 的 `ensureCan(task, actor, 'write')`），再加一道目标板 write 会把
   * 「成员 assignee 拖拽自己板内的任务」误杀成 403。这是本 wave 最容易写错的一条。
   *
   * 任一侧无法解析（列缺失 / 数据损坏）→ 返回 **true**（按跨板处理，fail-closed）。
   *
   * @param targetListId 任务将落入的列
   * @param currentListId 任务当前列（null/undefined = 无当前板 → 视为跨板）
   */
  private async isCrossBoardPlacement(
    targetListId: string,
    currentListId: string | null | undefined,
  ): Promise<boolean> {
    if (!currentListId) return true;
    // 同一列（拖拽排序的高频路径：目标列 = 当前列）⇒ 必然同板，直接短路，省两次列查询。
    // 判据等价性：同一 listId 只能落在同一个 board（board_lists.board_id 是列上的单值），
    // 故与下方"两侧解析出的 boardId 相等"逐字等价，不是特例放宽。
    if (targetListId === currentListId) return false;
    const [targetBoardId, currentBoardId] = await Promise.all([
      this.resolveListBoardId(targetListId),
      this.resolveListBoardId(currentListId),
    ]);
    if (!targetBoardId || !currentBoardId) return true;
    return targetBoardId !== currentBoardId;
  }

  /**
   * 跨板写族四门**统一入口**：仅跨板时施加 `assertCanPlaceTaskInList`（同板短路返回 false）。
   *
   * @param actor 操作者（`undefined` **仅在跨板时** fail-closed 抛 500 —— 授权路径不留
   *   "可以跳过"的活口，同 update() 乐观锁路径的 actor 缺失处理；同板流转不需要它）
   * @param targetListId 任务将落入的列
   * @param currentListId 任务当前列
   * @returns true = 施加了门（跨板）；false = 同板短路（只认任务 write）
   */
  async assertCrossBoardPlacement(
    actor: UnifiedActor | undefined,
    targetListId: string,
    currentListId: string | null | undefined,
  ): Promise<boolean> {
    if (!(await this.isCrossBoardPlacement(targetListId, currentListId))) return false;
    if (!actor) {
      throw new InternalServerErrorException({
        message:
          'Cross-board task placement requires an actor: the target-board write check cannot be ' +
          'skipped (internal callers must not move tasks across boards without the actor)',
        code: ErrorCode.INTERNAL_ERROR,
      });
    }
    await this.assertCanPlaceTaskInList(actor, targetListId);
    return true;
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
        resourceType: ResourceType.TASK,
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

      // 审计（Phase 2）：CREATE + task；service 层（batchCreate 循环调本方法——
      // batch 不单独记，决策 2）；newData 白名单 {taskId, title, status?, listId,
      // assigneeId?}（决策 6；description/customFields 不入）
      await this.auditService.log({
        action: AuditAction.CREATE,
        entityType: AUDIT_ENTITY_TYPE.TASK,
        entityId: savedTask.id,
        actorId: actorId ?? null,
        newData: {
          taskId: savedTask.id,
          title: savedTask.title,
          ...(savedTask.status !== undefined && { status: savedTask.status }),
          ...(savedTask.listId !== undefined && { listId: savedTask.listId }),
          ...(savedTask.assigneeId !== undefined && { assigneeId: savedTask.assigneeId }),
        },
        source: 'api',
      });

      // 凭证扫描（v1.94.0-dev）：无幂等键路径——真实写成功后扫；本分支**没有**幂等 replay
      // 形态（零开销原路径），故无需 replay 门控；有幂等键的分支在下面同款调用（双路径齐步）
      emitCredentialScanFactIfHit(dto.description, {
        resourceKind: 'task_description',
        resourceId: savedTask.id,
        actorId: actorId ?? null,
      });

      // 领域事实（v1.95.0-dev 撞重提示的输入）：**真实写成功后**才写——事实必须对应一次
      // 真实发生的创建。带 `title`（标题，**不是正文**——口径与依赖引导的下游 title 同款，
      // 见 task-hygiene-hint.provider.ts 文件头的「回显标题」例外）；带 boardId（本流程
      // 已解析出的板，provider 据此只在同板内判撞重）；拿不到 boardId（orphan 任务）则
      // 省略该键 ⇒ provider fail-closed 跳过（**不猜板**）。
      // ⚠️ 重放路径（下方 23505 分支）**不**写本事实——幂等 replay 禁 emit 是 2 期固化契约。
      emitFact('task.created', {
        taskId: savedTask.id,
        ...(boardId ? { boardId } : {}),
        title: savedTask.title,
      });

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
        resourceType: ResourceType.TASK,
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

      // 审计（Phase 2）：幂等键路径的真实写成功后记（replay 分支在 catch 中提前
      // 返回，不落审计——决策 2「幂等 replay 不重复记」）；载荷与无幂等键路径一致
      await this.auditService.log({
        action: AuditAction.CREATE,
        entityType: AUDIT_ENTITY_TYPE.TASK,
        entityId: savedTask.id,
        actorId: actorId ?? null,
        newData: {
          taskId: savedTask.id,
          title: savedTask.title,
          ...(savedTask.status !== undefined && { status: savedTask.status }),
          ...(savedTask.listId !== undefined && { listId: savedTask.listId }),
          ...(savedTask.assigneeId !== undefined && { assigneeId: savedTask.assigneeId }),
        },
        source: 'api',
      });

      // 凭证扫描（v1.94.0-dev）：**幂等键路径的真实写成功后**扫（本行在 catch 之前 ⇒
      // replay 分支（下方 23505）根本走不到这里）。两条返回路径齐步，见无幂等键分支同款调用。
      emitCredentialScanFactIfHit(dto.description, {
        resourceKind: 'task_description',
        resourceId: savedTask.id,
        actorId: actorId ?? null,
      });

      // 领域事实（v1.95.0-dev 撞重提示的输入）：与无幂等键路径**齐步**（同一位置、同一键集）；
      // 本行同样在 catch 之前 ⇒ 23505 重放分支走不到这里（幂等 replay 禁 emit）。
      emitFact('task.created', {
        taskId: savedTask.id,
        ...(boardId ? { boardId } : {}),
        title: savedTask.title,
      });

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

  /**
   * 更新任务（PATCH /tasks/:id）——派生写 + 落库 + 副作用的唯一入口。
   *
   * **可选乐观锁 `expectedUpdatedAt`**（卡 09ffa9a8）：token 显式传入时全程在
   * 「一个事务 + 行锁」内完成——锁内重读该行 → 锁内重跑权限判定 → 锁内比对 token →
   * 派生写与 save 全部基于**锁定行**；**事务提交之后**才跑副作用（事件 / 活动日志 /
   * 审计 / 触碰 Agent 活跃时间），行锁不被下游 IO 拖长、副作用失败也不连带回滚任务写
   * （`reportResult` 的"状态已改但评论失败"语义不变）。
   *
   * ⚠️ **不传 token = 无锁**，这是**有意的例外**（`docs/api-definition.md` §18.7 的
   * 「可选的锁 = 没有锁」一般结论在此刻意放宽）：`reportResult` 的内部状态写路径与
   * 存量旧客户端无法提供 token，一刀切要求会直接打断它们。**新代码应当总是传**。
   *
   * ⚠️ token 比对**只在 JS 侧**做毫秒 `getTime()` 等值，**禁止写 SQL 级时间等值谓词**：
   * PG 的 UPDATE 由 TypeORM 追加 `updated_at = CURRENT_TIMESTAMP`
   * （typeorm/query-builder/UpdateQueryBuilder.js:403-407；列默认 `NOW()`）——**微秒**精度
   * （实测本地 tasks 表 55/55 行带微秒、0 行毫秒对齐），而读侧经 pg 驱动进 JS `Date` 时被
   * **截到毫秒**。SQL 里拿"详情响应那个毫秒串"去比微秒列 ⇒ 静默不命中，失败形态是
   * "**一切 409**"——**没有正向探针（用例 ①）就只剩这一种症状**。JS 侧毫秒等值则与 token
   * 的表达能力（ISO 毫秒串）严格同域，故比对只在 JS 侧做。
   * **已知限制**：`CURRENT_TIMESTAMP` 取的是**事务开始**时刻（非语句时刻），若两次写的
   * 事务开始时刻落在**同一毫秒**（毫秒量级，不是苛刻的"同瞬间"条件），后写者锁内重读到的
   * `updated_at` 截到毫秒后可能与旧 token 相等 ⇒ 双双通过。故本锁**不承诺"完全消除竞态"**，
   * 只消除人类可感知的写-写覆盖窗口；真正的串行化由 FOR UPDATE 行锁提供。
   *
   * @param id 任务 UUID
   * @param dto 更新载荷（可选 `expectedUpdatedAt` = 详情响应里的 `updatedAt` 原样值）
   * @param actorId 操作者 actor id（副作用用）
   * @param actorType 操作者 actor 类型
   * @param actor 统一身份。**乐观锁路径必需**：锁内拿锁定行重跑 write 判定。
   *   缺省时锁内跳过重跑并打 warn（当前只有不传 token 的内部调用方才走到，不会静默假装判过）
   */
  async update(
    id: string,
    dto: UpdateTaskDto,
    actorId?: string,
    actorType?: ActorType,
    actor?: UnifiedActor,
  ) {
    // 只认显式传入的 token：undefined/null/'' 都走无锁旧路径
    const expectedUpdatedAt = dto.expectedUpdatedAt;

    // ── 乐观锁路径：一个事务 + 行锁，锁内判定，提交后副作用 ──
    if (expectedUpdatedAt) {
      const outcome = await this.dataSource.transaction(async (manager) => {
        // ① 锁内重读（FOR UPDATE）：并发写者在此串行化，读到的 updatedAt 即本次判定基准
        const task = await this.lockTaskForUpdate(manager, id);

        // ② 锁内**重跑**权限判定（sec TOCTOU 修复）：controller 的第一份快照
        //    （findById → ensureCan）与本次加锁之间，并发 move/改派可能已把任务换到
        //    当前 actor 无写权的 board——只用快照判权会放行越权写。判定必须基于
        //    **锁定行**，且排在 token 比对**之前**：无权限者带 stale token 该得 403
        //    （资源无权）而不是 409（资源被改），否则 409 就成了"资源存在且存在并发写"
        //    的 oracle，且会把越权写伪装成可重试的冲突。
        //    TaskPolicy 用自己的 listRepo 按锁定行的 listId 重查 board→权限，正是所需语义。
        //
        // ⚠️ actor 缺失 = **编程错误，fail-closed 抛 500**（授权路径不留"可以跳过"的活口）：
        //    带 token 的调用若不能锁内重跑判定，本路径唯一的存在理由（闭 TOCTOU 窗口）
        //    就形同虚设，而"放行"是**无声**的（日志里的 warn 没人读）。与铁律 #21/#22 同向：
        //    资源/权限不满足必须给明确的 4xx/5xx，不得裸奔。当前全仓只有 controller
        //    （恒传 actor）与 reportResult（恒不传 token）两个调用方，该分支不可达。
        if (!actor) {
          throw new InternalServerErrorException({
            message:
              'expectedUpdatedAt requires an actor: the lock-time permission re-check cannot be ' +
              'skipped (internal callers must not pass an optimistic-lock token without the actor)',
            code: ErrorCode.INTERNAL_ERROR,
          });
        }
        await this.permService.ensureCan(task, actor, 'write');

        // ③ 锁内比对 token（JS 侧毫秒等值，理由见方法头注释）
        const expected = new Date(expectedUpdatedAt).getTime();
        const actual = new Date(task.updatedAt).getTime();
        if (expected !== actual) {
          throw new ConflictException({
            message:
              'Task was modified (any field, including move/assign/report). ' +
              'Re-read it (GET /tasks/:id) and retry with the fresh updatedAt — ' +
              'do NOT retry with the same token, it will keep failing.',
            code: ErrorCode.RESOURCE_CONFLICT,
            // data 槽回吐"当前 token"，调用方一次重读即可重试（形状对齐 doc 的
            // DOC_CONTENT_CONFLICT + data.currentDescriptionHash 先例；experience 的
            // 乐观锁无 data 载荷）。toISOString = HTTP 响应里 updatedAt 的同一形态
            data: { currentUpdatedAt: new Date(task.updatedAt).toISOString() },
          });
        }

        return this.applyTaskUpdate(manager.getRepository(Task), task, dto, actor);
      });
      return this.finishTaskUpdate(id, dto, actorId, actorType, outcome);
    }

    // ── 无锁路径（旧行为逐字不变：不引入事务、不拿行锁）──
    // 必须用实体实例执行 save；同时只更新 DTO 中显式传入的字段，避免 class-transformer
    // 生成的可选字段（undefined）把 task 上的现有值（如 listId）覆盖掉。
    const task = await this.findById(id);
    const outcome = await this.applyTaskUpdate(this.taskRepo, task, dto, actor);
    return this.finishTaskUpdate(id, dto, actorId, actorType, outcome);
  }

  /**
   * 事务内 `SELECT ... FOR UPDATE` 重读任务行（乐观锁路径专用，必须在事务的连接上调用）。
   *
   * 用 QueryBuilder + `setLock('pessimistic_write')` 而不是 `findOne({lock})`，两个原因：
   * ① 与 experience.service 的乐观锁先例同款（同一套锁语义，便于比对排查）；
   * ② `FOR UPDATE` **不能与 relations 的 LEFT JOIN 同用**——PG 会拒绝
   *    `FOR UPDATE cannot be applied to the nullable side of an outer join`。
   *    故锁读不带 relations，`milestone` 关系改按已锁行的 `milestone_id` 列在锁内补载，
   *    使实体形状与 `findById`（relations: ['milestone']）对齐——否则 `save()` 在
   *    relation 属性缺失时可能把 milestone 外键写坏（D-B1-4 踩过同一形状的坑）。
   *
   * @param manager 事务内的 EntityManager（禁止传全局 repository，否则锁在另一条连接上）
   * @param id 任务 UUID
   */
  private async lockTaskForUpdate(manager: EntityManager, id: string): Promise<Task> {
    const task = await manager
      .getRepository(Task)
      .createQueryBuilder('task')
      .setLock('pessimistic_write')
      .where('task.id = :id', { id })
      .getOne();
    if (!task) {
      throw new NotFoundException({ message: 'Task not found', code: ErrorCode.TASK_NOT_FOUND });
    }
    // 关系补载（同一事务连接，只读，不参与锁判定）
    task.milestone = task.milestoneId
      ? ((await manager.getRepository(Milestone).findOne({ where: { id: task.milestoneId } })) ??
        null)
      : null;
    return task;
  }

  /**
   * 「派生写 + 落库」阶段——`update()` 的**唯一写入实现**，加锁/无锁两条路径共用
   * （复制两份派生逻辑必然漂移：状态机、list 吸附、milestone 关系同步三处都极易漏改）。
   *
   * 本方法只做「读校验 + 在传入实体上派生 + 用传入 repo 落库」，**不产生任何跨事务副作用**
   * （事件 / 活动日志 / 审计 / 触碰活跃时间一律交给 `finishTaskUpdate`）——锁路径下那些
   * 副作用因此天然落在事务提交之后。
   *
   * @param taskRepo 落库所用 repository（锁路径 = 事务内 `manager.getRepository(Task)`）
   * @param task 已加载（无锁）或已锁定（有锁）的任务实体，本方法在其上原地派生写
   * @param dto 更新载荷（`assigneeId` / `expectedUpdatedAt` 已由调用方处理，本方法不再合并）
   * @param actor 操作者统一身份（**仅跨板改 listId 时必需**：目标板 write 门；
   *   同板流转不用它，故内部调用方（reportResult 等，恒不带 listId）传 undefined 无害）
   * @returns 落库行 + 副作用与响应组装所需的前后值
   */
  private async applyTaskUpdate(
    taskRepo: Repository<Task>,
    task: Task,
    dto: UpdateTaskDto,
    actor?: UnifiedActor,
  ): Promise<TaskUpdateOutcome> {
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
    // 审计用：listId 前后值（task.listId 在下方可能被 status→mappedStatus 自动吸附改写）
    const oldListId = task.listId;

    // listId 变更时，保留 list 存在性校验（topicId 不再存储，由后续 join 派生）
    if (dto.listId && dto.listId !== task.listId) {
      await this.resourceValidator.exists(this.boardListRepo, dto.listId, ErrorCode.LIST_NOT_FOUND);
      // 跨板写族闭合（V2-N2 / S-N2）：**仅跨板时**要求目标板 write。同板流转只认任务
      // write，再加目标板 write 会把「成员 assignee 在自己板内改列」误杀成 403
      // （A-C2/P-N1——本 wave 最容易写错的一条）。锁路径下本判定在事务内、基于
      // **锁定行**的 task.listId，与上方的 TOCTOU 修复同向。
      await this.assertCrossBoardPlacement(actor, dto.listId, task.listId);
    }

    // 其他字段批量合并（排除 assigneeId 与锁 token，两者都在别处处理）
    // 只合并显式传入（非 undefined）的值，防止 DTO 可选字段覆盖 task 现有数据。
    //
    // ⚠️ `expectedUpdatedAt` **必须在此剥掉**：它是锁 token、不是实体字段（tasks 表无此列），
    // 混进合并回环会以同名字段挂到 task 实体上，再经 `toPlain()` 的 `...task` 整体展开
    // 泄漏进 PATCH 响应（实体展开 = 响应契约，多一个"长得像字段"的键会让调用方误以为
    // 它是可读回的持久化数据）。同时它也绝不能进 restDto——活动日志的 fieldName 由
    // restDto 的键拼出，混进去会出现"更新了: expectedUpdatedAt"这种假字段记录。
    const { assigneeId: _a, expectedUpdatedAt: _lock, ...restDto } = dto;
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

    // ⚠️ 落库必须用**传入的 taskRepo**（锁路径 = 事务内 `manager.getRepository(Task)`）：
    // 若这里写 `this.taskRepo.save(task)`，锁路径会另开一条连接、绕过事务与行锁，
    // 锁内重读+派生就全白做了（典型的"锁了但没锁住写"）。
    const saved = await taskRepo.save(task);

    return { saved, oldStatus, oldListId, oldAssigneeId, effectiveAssigneeId, restDto };
  }

  /**
   * `update()` 的副作用阶段（事件 / 活动日志 / 审计 / 触碰 Agent 活跃时间 / 凭证扫描）。
   *
   * **锁路径下本方法在事务提交之后才被调用**，这是刻意的边界：
   * ① 行锁不被下游 IO（事件分发、审计写、外部调用）拖长；
   * ② 副作用失败不连带回滚已完成的任务写（与 `reportResult` 的"状态已改但评论失败"
   *    部分成功语义一致）；反之，冲突（409）路径在抛出时天然不会跑到这里——不留
   *    "已更新"的假痕迹（事件/活动/审计都不落）。
   *
   * @param id 任务 UUID
   * @param dto 原更新载荷（凭证扫描只认 `dto.description` 显式传入）
   * @param actorId 操作者 actor id（`undefined` = 系统/无操作者，不记活动日志）
   * @param actorType 操作者 actor 类型
   * @param outcome `applyTaskUpdate` 的产出
   * @returns PATCH 响应体（实体展开 + boardId/topicId 派生填充）
   */
  private async finishTaskUpdate(
    id: string,
    dto: UpdateTaskDto,
    actorId: string | undefined,
    actorType: ActorType | undefined,
    outcome: TaskUpdateOutcome,
  ) {
    const { saved, oldStatus, oldListId, oldAssigneeId, effectiveAssigneeId, restDto } = outcome;

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

    // 领域事实（hint 阶段二「该提名了」提示的输入）：**只在状态真实变更时**写——
    // 幂等重试同一状态、只改 title 等路径都不产生事实（否则提示退化成噪音）。
    // 载荷只带 ID 与状态机标量、**禁正文**（provider 需要正文时回库读，见其 MEM-NOM-2）；
    // boardId 派生失败时不落该键 —— provider 拿不到 boardId 会放弃本次判定（不猜）
    if (dto.status && dto.status !== oldStatus) {
      emitFact('task.status_changed', {
        taskId: saved.id,
        ...(updatedList?.boardId ? { boardId: updatedList.boardId } : {}),
        fromStatus: oldStatus,
        toStatus: saved.status,
      });
    }

    await this.eventService.create({
      eventType: EventType.TASK_UPDATE,
      resourceType: ResourceType.TASK,
      resourceId: saved.id,
      topicId: updatedList?.board?.topicId ?? undefined,
      boardId: updatedList?.boardId ?? undefined,
      actorId,
      actorType,
      // 状态跃迁前后值（notifications 一期 S1）：补 fromStatus/toStatus。
      // 此前载荷只有**当前** status，「一个已完成任务被改了描述」与「任务刚刚完工」在事件面上
      // 形状完全相同，下游无法判完工（完工误报）。**无条件带这两个键**（未变化时两值相等），
      // 把「算不算跃迁」的判据只留在消费侧一处（`toStatus∈{done,blocked} && fromStatus!==toStatus`）。
      // 不删既有 `status` 键——旧消费方（SSE 订阅、事件游标）仍在读。
      payload: {
        taskId: saved.id,
        action: 'updated',
        status: saved.status,
        fromStatus: oldStatus,
        toStatus: saved.status,
      },
    });

    // 指派事实（notifications 一期 S1）：PATCH /tasks/:id {assigneeId} 是改派的**第二条入口**，
    // 与 POST /tasks/:id/assign 端点并列——此前两条路径都只写 activity，`TASK_ASSIGNED`
    // （值早在 PG enum 内）是死枚举，事件面完全看不到"任务换人了"。
    // **只在"有人接手"时发**（新 assignee 非空且与旧值不同）：skill `agent-chamber` §5.3 事件表
    // 定义 TASK_ASSIGNED 的消费方是「被分配者」，取消分配（→null）没有被分配者，发出去只会让
    // 下游渲染出空指派误报；重新指派同一人（值未变）亦非事实变更。
    // TASK_UPDATE 照常同发（通用更新事实，粒度更粗），去重交给消费侧的 per-task 节流。
    // boardId/topicId 复用上方同一次派生（updatedList），零额外查询；派生失败省键（同 emitFact
    // 纪律，下游 fail-closed）。
    const assignedId = saved.assigneeId;
    if (assignedId && assignedId !== oldAssigneeId) {
      // 名字走既有收口（R1：禁止散落 actors 查询）——下游通知可直接渲染，不必回库解析
      const assigneeName = await this.resolveActorName(assignedId);
      await this.eventService.create({
        eventType: EventType.TASK_ASSIGNED,
        resourceType: ResourceType.TASK,
        resourceId: saved.id,
        topicId: updatedList?.board?.topicId ?? undefined,
        boardId: updatedList?.boardId ?? undefined,
        actorId,
        actorType,
        payload: {
          taskId: saved.id,
          assigneeId: assignedId,
          assigneeName,
          boardId: updatedList?.boardId ?? undefined,
          topicId: updatedList?.board?.topicId ?? undefined,
        },
      });
    }

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

      // assignee 变更单独检测并记录（`saved` = 落库行；task 实体的引用不跨方法传递）
      if (effectiveAssigneeId !== undefined && effectiveAssigneeId !== oldAssigneeId) {
        changedFields.push('assigneeId');
        oldValues.assigneeId = oldAssigneeId;
        newValues.assigneeId = saved.assigneeId;
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

    // 审计（Phase 2）：UPDATE + task；service 层（reportResult 内部调用本方法——
    // report 不单独记，状态变更由本行承载，决策 2）；newData 白名单 {taskId, title,
    // status?/listId?/assigneeId? 前后值}（决策 6；description/customFields 不入）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.TASK,
      entityId: saved.id,
      actorId: actorId ?? null,
      newData: {
        taskId: saved.id,
        title: saved.title,
        ...(saved.status !== oldStatus && {
          status: saved.status,
          statusBefore: oldStatus,
        }),
        ...(saved.listId !== oldListId && {
          listId: saved.listId,
          listIdBefore: oldListId,
        }),
        ...(saved.assigneeId !== oldAssigneeId && {
          assigneeId: saved.assigneeId,
          assigneeIdBefore: oldAssigneeId,
        }),
      },
      source: 'api',
    });

    // 凭证扫描（v1.94.0-dev）：**只在 `dto.description` 显式传入时**扫（update 是整段覆盖
    // 写；未传 description 的更新没有新描述文本可扫——扫回库旧值会把历史泄漏重复计入分母）
    if (dto.description !== undefined) {
      emitCredentialScanFactIfHit(dto.description, {
        resourceKind: 'task_description',
        resourceId: saved.id,
        actorId: actorId ?? null,
      });
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
      const { response, oldDescription, newDescription, boardId, topicId, title } =
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
                `re-read the task (GET /tasks/:id) and retry; ` +
                `matching is byte-exact including leading whitespace/indentation — copy ` +
                `oldString verbatim from the task detail response instead of hand-typing it`,
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
            title: saved.title,
          };
        });

      // ── 事务提交后副作用（照 update() 对 description 变更的既有行为）──
      await this.eventService.create({
        eventType: EventType.TASK_UPDATE,
        resourceType: ResourceType.TASK,
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

      // 审计（Phase 2）：UPDATE + task；service 层（幂等 replay 在入口/并发 catch
      // 提前返回，只有真实写路径走到这里——决策 2「幂等 replay 不重复记」）；
      // newData 白名单 {taskId, title}（决策 6——description 正文不入）
      await this.auditService.log({
        action: AuditAction.UPDATE,
        entityType: AUDIT_ENTITY_TYPE.TASK,
        entityId: id,
        actorId: actor.id,
        newData: { taskId: id, title },
        source: 'api',
      });

      // 凭证扫描（v1.94.0-dev）：只扫 **newString**（被删片段不报警——删除凭证是修复动作）；
      // 幂等 replay 与并发 23505 都在事务内外**提前返回**（上面两处），走不到这里 ⇒ 天然不扫
      emitCredentialScanFactIfHit(newString, {
        resourceKind: 'task_description',
        resourceId: id,
        actorId: actor.id,
      });

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

  async move(
    id: string,
    dto: MoveTaskDto,
    actorId?: string,
    actorType?: ActorType,
    actor?: UnifiedActor,
  ) {
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

    // 跨板写族闭合（V2-N2 / S-N2）：**仅跨板时**要求目标板 write —— 否则「非目标板成员的
    // assignee」可以把任务注入任意板（P-Q-C 已知情取舍：放弃非 editor 成员的跨板 hand-off）。
    // 同板 move 只认任务 write（controller 的 ensureCan），成员 assignee 拖拽必须仍 200
    // （A-C2/P-N1）。
    // ⚠️ actor 必须是完整 `{id,type,role}`：controller 传的是 @CurrentActor() 原对象，
    // **禁止**在调用链上游改造成迷你对象（丢 role 会让 BoardPolicy 的 admin bypass 失效）。
    await this.assertCrossBoardPlacement(actor, dto.listId, task.listId);

    const oldListId = task.listId;
    const oldStatus = task.status;
    task.listId = dto.listId;
    task.position = dto.position ?? dto.order ?? 0;

    // 智能状态联动：若目标列配置了 mappedStatus，自动同步任务状态
    let autoStatus = false;
    if (list.mappedStatus && task.status !== list.mappedStatus) {
      task.status = list.mappedStatus;
      autoStatus = true;

      // 状态机不变量（与 update() 930-936 双向语义对齐，B-60）：
      // status=done ⇔ completedAt 非空——离开 DONE 必须反向清理，否则
      // board digest recentDone 段（status=DONE + completedAt 非空）口径被污染
      if (task.status === TaskStatus.DONE) {
        task.completedAt = new Date();
      }
      if (task.status !== TaskStatus.DONE && oldStatus === TaskStatus.DONE) {
        task.completedAt = null;
      }
      if (task.status === TaskStatus.IN_PROGRESS && !task.startedAt) {
        task.startedAt = new Date();
      }
    }

    const saved = await this.taskRepo.save(task);

    // 领域事实（hint 阶段二「该提名了」提示的输入）：**move 自动改状态也算一次真实的
    // 状态变更**（P2-3：这条路径此前漏挂，是触发链的真缺口——把任务拖进 mappedStatus=done
    // 的列，语义上就是"这事拍板了"，与 PATCH status 同权）。载荷纪律与 update() 一致：
    // 只带 ID + 状态机标量、**禁正文**；boardId 取自目标 list（move 一定有目标列）
    if (autoStatus) {
      emitFact('task.status_changed', {
        taskId: saved.id,
        boardId: list.boardId,
        fromStatus: oldStatus,
        toStatus: saved.status,
      });
    }

    await this.eventService.create({
      eventType: EventType.TASK_UPDATE,
      resourceType: ResourceType.TASK,
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
    // 事件载荷用的 boardId/topicId（B-51）在 save **之前**先捕获为局部常量：findOne() 已经
    // 用 list→board 派生并对投影赋值过（其 `plain.topicId` / 返回字面量 `boardId`），直接复用
    // 即可省掉 save 之后再查一次 list。
    // **不在 save 之后读 `task.boardId`**：boardId/topicId 是投影字段（不是 Task 列），
    // save() 返回值是否保留非列属性取决于 TypeORM 的实体重载语义，不可依赖；先落局部常量
    // 则与它无关。
    // 语义等价性：assign() 从不改 listId，先前按 `saved.listId` 重查读到的也是同一行。
    const taskBoardId = task.boardId;
    const taskTopicId = task.topicId;
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

    // 指派事实（notifications 一期 S1）：此前 assign() 只写 activity，`TASK_ASSIGNED`（值早在
    // PG enum 内）是死枚举——事件面看不到"任务换人了"。emit 必须在 `await save()` **成功之后**：
    // save 抛错则整体不 emit，事件与业务写入同真同假（事件层不是"意图记录"，是既成事实）。
    // **只在"有人接手"时发**（新 assignee 非空且与旧值不同）：skill `agent-chamber` §5.3 事件表
    // 定义 TASK_ASSIGNED 的消费方是「被分配者」，取消分配（→null）没有被分配者；重新指派同一人
    // 亦非事实变更。载荷与 PATCH 改派路径（update()）保持同形。
    // boardId/topicId 取上方 save 前捕获的 findOne 派生值（`taskBoardId/taskTopicId`），
    // **不在 save 之后重查 list**——findOne 已经查过同一行了。B-51：事件载荷顶层缺
    // topicId/boardId 时 SSE/轮询按 actor 白名单过滤后订阅方收不到。
    const assignedId = saved.assigneeId;
    if (assignedId && assignedId !== oldAssigneeId) {
      // 名字走既有收口（R1：禁止散落 actors 查询）——下游通知可直接渲染，不必回库解析
      const assigneeName = await this.resolveActorName(assignedId);
      await this.eventService.create({
        eventType: EventType.TASK_ASSIGNED,
        resourceType: ResourceType.TASK,
        resourceId: saved.id,
        topicId: taskTopicId ?? undefined,
        boardId: taskBoardId ?? undefined,
        actorId,
        actorType,
        payload: {
          taskId: saved.id,
          assigneeId: assignedId,
          assigneeName,
          boardId: taskBoardId ?? undefined,
          topicId: taskTopicId ?? undefined,
        },
      });
    }

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

  /**
   * 新建任务评论。
   *
   * @param id 任务 ID
   * @param authorId 作者 actor id
   * @param authorType 作者类型
   * @param dto 评论内容
   * @param via **内部路径标记**（缺省 = 外部 REST 调用）：`'report'` = 由 {@link reportResult}
   *   编排内部发起。该标记只进**领域事实**（task hygiene provider 据此豁免
   *   `comment_on_done_task` —— 验收补证是完成流程本身的一部分，不该被提示「挪回进行中
   *   复活」）；**不落库、不入审计**（它是调用路径的元信息，不是评论的属性）。
   */
  async addComment(
    id: string,
    authorId: string,
    authorType: ActorType,
    dto: AddCommentDto,
    via?: 'report',
  ) {
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

    // 领域事实（hint 阶段二「该提名了」提示的输入）：**save 成功后**才写——事实必须对应
    // 一次真实发生的写入。只带 ID：正文由 provider 回库读（评论可能被并发软删，事实里的
    // 快照不可信；同时避免正文经事实袋外流）。`via` 是**路径元信息**（缺省不落键——
    // 事实载荷保持扁平且最小），由 task hygiene provider 消费，见本方法 JSDoc。
    emitFact('task.comment_added', {
      taskId: id,
      commentId: saved.id,
      ...(via ? { via } : {}),
    });

    // 凭证扫描（v1.94.0-dev）：扫描对象 = 本次评论正文（**与上面的事实同门控**——save 成功
    // 之后）；`report_task_result` 内部补证评论同样真实落库 ⇒ 同样扫（那是真实写入）
    emitCredentialScanFactIfHit(dto.content, {
      resourceKind: 'task_comment',
      resourceId: id,
      actorId: authorId,
    });

    await this.activityRepo.save({
      taskId: id,
      action: 'commented',
      actorId: authorId,
      actorType: authorType ?? ActorType.HUMAN,
      details: `添加了评论`,
    });
    // 审计（Phase 2）：CREATE + task_comment；service 层（reportResult 内部调用
    // 本方法——report 不单独记，评论由本行承载，决策 2）；newData 白名单
    // {taskId, commentId}（决策 6——content 显式黑名单，正文永不入审计）
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.TASK_COMMENT,
      entityId: saved.id,
      actorId: authorId,
      newData: { taskId: id, commentId: saved.id },
      source: 'api',
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
    const saved = await this.docLinkRepo.save(link);
    // 审计（Phase 2）：CREATE + doc_link；service 层（reportResult 的 runDocLinks
    // 内部调用本方法——report 不单独记，链接由本行承载，决策 2）；幂等重复关联
    // 提前返回不记；newData 白名单 {taskId, docId}；entityId=docId（复合主键无 id 列）
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.DOC_LINK,
      entityId: docId,
      actorId: actor.id,
      newData: { taskId, docId },
      source: 'api',
    });
    return saved;
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
   *   common/services/idempotency.helper.ts 范式）；并发窗口内双方都可能已发评论（无共享事务，
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
      // 失败向上透传（4xx 原样），status 未被触碰。
      // `via:'report'`（hint 阶段三决策 9）：report 编排内部发的评论被 task hygiene
      // provider 豁免（不产出 comment_on_done_task）——验收补证不是"新增未完成工作"。
      result.comment = await this.addComment(
        id,
        actor.id,
        actor.type,
        { content: commentText },
        'report',
      );
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
   * 幂等记录 hash/entityType 校验（对齐 common/services/idempotency.helper.ts 语义）：
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
