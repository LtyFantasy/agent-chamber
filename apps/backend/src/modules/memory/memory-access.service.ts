/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块的**权限内核**：① 项目绑定解析（读/写闸门）② 来源引用的**批式**可见性判定
 *     ——"三处同源约束"的唯一实现（召回过滤 / 账本降级投影 / 记忆详情 404）
 *
 * [代码职责]
 *   - `resolveProjectAccess`：逐绑定解析（存在+未软删+可读/可写）+ 治理观察者判定
 *   - `assertProjectRead` / `assertProjectContentRead` / `assertProjectWrite`：三档闸门
 *   - `evaluateSourceRefs`：**一次调用喂全部引用**，内部按类型批量预载父链后逐环判定
 *   - `allSourcesVisible`：单行的"全源可见"判据（三处同源的那一行代码）
 *   - `canReadMemoryUsage`：Usage 读面的权限判据（admin 或非空且**每条**绑定可读）
 *   - `loadMemoryIdMapping`：`engine_memory_ids` → canonical 账本行的**唯一**映射构建点
 *     （应用层内存做，jsonb 禁入 SQL 谓词；召回与投影读面**共用**，见 ②-b 段）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §5 权限模型（项目级门槛 / 来源过滤四步 /
 *     同源约束三处 / 治理白名单）+ §6 端点面
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **批式，不是逐行**（方案 §5 第 2 步 + DB R5）：来源可见性一次调用喂**全部**引用，
 *     内部按类型 `IN (...)` 预载（doc/message/task/comment + 父链 space/topic/list/board），
 *     禁止在循环里对每行每引用各查一次——账本百行 × 4 引用 = 400 次往返。
 *   - **`getAccessible*Ids` 的 null 三态**（R7）：`null` = admin 全放行；`[]` = 无可见；
 *     `string[]` = 白名单。把 `null` 当"空集合"处理 = 把 admin 的读权限整片关掉；
 *     把 `[]` 当"不过滤"处理 = 泄露全部私密来源。**判据只写一次**（`isVisibleIn`）。
 *   - **父链每环都必须"存在且未软删"**：任一环缺失/软删 ⇒ 该来源不可见（不 fail-open）。
 *     软删由 TypeORM 的 `@DeleteDateColumn` 默认谓词过滤（`find`/`findBy` 自动带
 *     `deleted_at IS NULL`），**不要**手写 `withDeleted`。
 *   - **不采信 policy 的 fail-open**（方案 §5）：来源判定只看"白名单命中 + 父链完整"，
 *     不调 Policy（TaskPolicy 对孤儿任务会 fail-open）。
 *   - **`evaluateSourceRefs` 的返回与入参一一对应**（含 `currentVersionHash`）：
 *     调用方按切片还原到行，切片错位 = 把 A 行的可见性安到 B 行上（静默越权）。
 *   - **`moved` 只对 doc 有定义**：message/task/comment **没有版本列**（§6 明文），
 *     故 `currentVersionHash` 对其恒 `null`、`moved` 恒 false——给它们编一个 hash
 *     会让"来源未改"变成永假。
 *   - **治理白名单是"字段级"的**：`isGovernanceViewer`（creator/admin）能看**项目元数据**
 *     与账本**元数据投影**，但内容端点（recall / 记忆详情 / 账本全文字段落）关闭——
 *     所以本类导出两个读闸门，调用方不许把 `isGovernanceViewer` 当万能通行证。
 *   - **topic 绑定的读判定 = 运行时白名单同口径**：`resolveBinding` 对 `topic` 的 read 复用
 *     `getAccessibleTopicIds`（creator / owner-proxy / participant invited+active / OPEN，
 *     admin → null），**不要**退回裸调 `PermissionService.can('read')`——TopicPolicy 的 read
 *     依赖调用方注入 `context.hasAccess`，本服务无该上下文，private topic 的参与者会被误判
 *     无权限（卡 7a21f96b）。write 仍走 Policy（editor 语义只在那边有）。
 *
 * [关联代码]
 *   - ../memory-recall.service.ts — 召回过滤（同源约束①，含 `engineDataSuspect` 判据）
 *   - ../memory-formation.service.ts — 账本投影（同源约束②）与写闸门
 *   - ../memory-correction.service.ts、../memory-project.service.ts — 写闸门与绑定解析
 *   - ../../../common/policies/resource-action.type.ts — `write` 动作的语义
 *   - ../../../common/services/access-query.service.ts — 白名单单源（与 Policy read 严格同步）
 *
 * [持久踩坑]
 *   MEMORY-NULL-WHITELIST(null 当空集): `getAccessibleTopicIds` 对 admin 返回 `null`，
 *     若写成 `ids.includes(x)` 会 TypeError 或把 admin 判成无权限。安全方向: 统一走
 *     `isVisibleIn(id, ids)`（null ⇒ true）。
 *   MEMORY-N1-SOURCE-CHECK(逐行逐引用查库): 账本/召回过滤若在循环里查父链，行数一多就成
 *     N+1（且 e2e 在小数据量下全绿，只在生产放大）。安全方向: 一次喂全量 + 内存切片。
 *   MEMORY-BIND-READ-POLICY-CONTEXT(绑定读裸调 Policy): `PermissionService.can(topic, …, 'read')`
 *     不带 `{hasAccess}` 时，private topic 的 invited/active 参与者被判无权限（Policy 靠调用方
 *     预查注入）。症状 = 参与者能收发消息却建不了绑定 private topic 的项目（400）。安全方向:
 *     绑定读走运行时白名单 `getAccessibleTopicIds`（与召回过滤同源）。
 *
 * [修改检查]
 *   □ 已读 [权威文档] §5，确认修改符合设计意图
 *   □ 新增来源类型必须同时更新：预载批查询 + 父链解析 + locator 形态（三处，缺一即静默拒绝）
 *   □ 改可见性判据必须同步三处调用点的 e2e 用例（三处同源的意义就在这条）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ErrorCode,
  MEMORY_BINDING_TYPE,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  UserRole,
  type MemoryBindingType,
} from '@agent-chamber/shared';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Board } from '../../database/entities/board.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { Doc } from '../../database/entities/doc.entity';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import type { MemoryProject } from '../../database/entities/memory-project.entity';
import type { MemorySourceRef } from '../../database/entities/memory-nomination.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import { AccessQueryService } from '../../common/services/access-query.service';
import { PermissionService } from '../../common/services/permission.service';
import { memoryProjectForbidden, memoryProjectNotFound } from './memory.constants';

/**
 * 映射表的单行投影（只取读面需要的列；正文/理由是 `select:false`，天生不进这个查询）。
 *
 * ⚠️ **本 interface 与 `MemoryIdMapping` 原住在 `memory-recall.service.ts`**，随
 * `loadMemoryIdMapping` 一起下沉到本文件（读面职责）：它们的两个消费方（召回 / 投影读面）
 * 都只需要"memory_id → 账本行"这一个事实，而**权限内核是它天然的层**——
 * 服务互注（recall ⇄ views）会造出循环依赖，复制第三份更糟。
 */
export interface MappedLedgerRow {
  id: string;
  category: string;
  subject: string;
  scope: string;
  contentTruncated: boolean;
  status: string;
  formationState: string;
  reviewAt: Date | null;
  sourceRefs: MemoryNomination['sourceRefs'];
  engineMemoryIds: string[] | null;
}

/** 映射构建产物（含 `engineDataSuspect` 判据要用的两个事实） */
export interface MemoryIdMapping {
  /** memory_id → canonical 行（冲突项已剔除） */
  byMemoryId: Map<string, MappedLedgerRow>;
  /** 本项目存在 committed 行 */
  hasCommitted: boolean;
  /** 本项目存在在途行（`submitted`）——能解释"映射不到的条目" */
  hasInFlight: boolean;
}

/** 单个绑定条目的解析结果（**逐个绑定**；`fail-closed`：解析失败 ⇒ 两个权限位都 false） */
export interface ResolvedMemoryBinding {
  type: MemoryBindingType;
  id: string;
  /** 资源存在且未软删 */
  exists: boolean;
  /** 有读权限（存在为前提；**未计算时为 false**，见 `ResolveBindingOptions`） */
  readable: boolean;
  /** 有写权限（存在为前提；**未计算时为 false**；archived 项目由调用方另行拦截） */
  writable: boolean;
}

/**
 * `resolveBinding` 的计算范围（缺省两位都算）。
 *
 * 为什么需要这个开关：两位判定的成本不对称——`topic` 的 read 走运行时白名单
 *（`getAccessibleTopicIds`，3~4 条查询），而只消费 `writable` 的热路径（提名提示 provider，
 * 每条绑定 memory 的 topic 消息都会触发）不该为不读的位付这笔钱；反之 `describeUnreadableBinding`
 * 只判 read，不该白算 Policy write。
 *
 * ⚠️ **跳过 ≠ 否定**：被关闭的位恒返回 `false`，但那个 false 只表示"未判定"——
 * 只有显式关闭该位的调用方知道这一点，**不得**把它当作权限结论（更不得据此拒绝请求）。
 */
export interface ResolveBindingOptions {
  /** 是否计算 read 位（缺省 true） */
  read?: boolean;
  /** 是否计算 write 位（缺省 true） */
  write?: boolean;
}

/** 项目级访问结论（一次解析，多处复用——避免同一请求把绑定解析跑三遍） */
export interface MemoryProjectAccess {
  /**
   * ≥1 绑定可读（**admin 恒真**：topic 绑定由白名单 `null` 短路放行，
   * board/docSpace 由 Policy 内 admin bypass；绑定为空时也成立）
   */
  readable: boolean;
  /** ≥1 绑定可写 */
  writable: boolean;
  /**
   * 治理观察者（creator 或 admin）：绑定全不可读时仍可看**项目元数据 + 账本元数据投影**，
   * 但**内容端点照旧关闭**（见文件头不变量）。
   */
  isGovernanceViewer: boolean;
  /** 逐绑定明细（排障与 e2e 断言用） */
  resolved: ResolvedMemoryBinding[];
}

/** 单个来源引用的判定结果（与入参**一一对应**） */
export interface SourceRefVerdict {
  /** 该引用是否可见（父链每环都在且未软删 + 白名单命中） */
  visible: boolean;
  /**
   * 当前版本哈希（**仅 doc 有**：当前 `docs.content_hash`；其余类型恒 `null`）。
   * `moved` 判据 = `currentVersionHash !== null && currentVersionHash !== 冻结 versionHash`。
   */
  currentVersionHash: string | null;
}

/**
 * 白名单三态判据（`null` = 全放行；`[]` = 全拒；数组 = 白名单）——**本模块唯一实现点**。
 *
 * @param id 待判定的资源 id
 * @param ids `getAccessible*Ids` 的返回值
 * @returns 是否可见
 */
export function isVisibleIn(id: string, ids: string[] | null): boolean {
  if (ids === null) return true;
  return ids.includes(id);
}

/**
 * 单行的"全源可见"判据（三处同源约束的那一行）。
 *
 * 语义：无 sourceRefs = 纯著述 ⇒ 项目级已过闸即放行；有 sourceRefs ⇒ **任一不可见即整行不可见**。
 *
 * @param verdicts 该行来源的逐条判定（`evaluateSourceRefs` 的切片）
 * @returns true = 该行可给完整投影
 */
export function allSourcesVisible(verdicts: SourceRefVerdict[]): boolean {
  if (verdicts.length === 0) return true;
  return verdicts.every((verdict) => verdict.visible);
}

/**
 * Usage 读面的**权限判据**（admin 或「非空且每条绑定都可读」）。
 *
 * ⚠️ 与 `assertProjectContentRead` 的 any-binding 判据**刻意不同**：Usage 是项目级引擎聚合，
 * 不做逐来源过滤——只要有一条绑定对调用方不可读，聚合结果就可能包含 TA 无权解释的用量。
 * 故要求**全部**绑定可读（空绑定 = 不通过：没有可授权的范围）。
 *
 * 本函数**只回答权限**：共享/历史占用的 fail-closed（409/14006）是端点级判定，不在这里。
 *
 * @param actor 当前身份（admin 短路）
 * @param access `resolveProjectAccess` 的结论
 */
export function canReadMemoryUsage(
  actor: UnifiedActor | null,
  access: MemoryProjectAccess,
): boolean {
  if (actor?.role === UserRole.ADMIN) return true;
  return access.resolved.length > 0 && access.resolved.every((entry) => entry.readable);
}

/** 父链预载容器（一次 `evaluateSourceRefs` 内共享，**循环里不再查库**） */
interface SourceChainCache {
  docs: Map<string, Doc>;
  topics: Map<string, Topic>;
  spaces: Map<string, DocSpace>;
  messages: Map<string, Message>;
  tasks: Map<string, Task>;
  comments: Map<string, TaskComment>;
  lists: Map<string, BoardList>;
  boards: Map<string, Board>;
}

const logger = new Logger('MemoryAccess');

@Injectable()
export class MemoryAccessService {
  constructor(
    @InjectRepository(DocSpace) private readonly spaceRepo: Repository<DocSpace>,
    @InjectRepository(Topic) private readonly topicRepo: Repository<Topic>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    @InjectRepository(BoardList) private readonly listRepo: Repository<BoardList>,
    @InjectRepository(Doc) private readonly docRepo: Repository<Doc>,
    @InjectRepository(Message) private readonly messageRepo: Repository<Message>,
    @InjectRepository(Task) private readonly taskRepo: Repository<Task>,
    @InjectRepository(TaskComment) private readonly commentRepo: Repository<TaskComment>,
    // 第 9 位 = 账本仓储（`loadMemoryIdMapping` 的读源，见下方 ②-b；**不是**第 10 位——
    // 位置参数顺序是 access spec 的构造契约，插入位置错一处就整组红）
    @InjectRepository(MemoryNomination) private readonly nominations: Repository<MemoryNomination>,
    private readonly accessQuery: AccessQueryService,
    private readonly permission: PermissionService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════
  // ① 项目级闸门（绑定解析 / 读 / 内容读 / 写）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 解析项目绑定与访问结论（**一次解析、多处复用**）。
   *
   * @param actor 当前统一身份（可空 = 匿名）
   * @param project 项目实体
   * @returns 读/写/治理三态 + 逐绑定明细
   */
  async resolveProjectAccess(
    actor: UnifiedActor | null,
    project: MemoryProject,
  ): Promise<MemoryProjectAccess> {
    const isAdmin = actor?.role === UserRole.ADMIN;
    const isGovernanceViewer = isAdmin || (actor !== null && project.createdBy === actor.id);

    // 绑定逐条解析：存在 + 未软删 + 读/写。失败一律 fail-closed（两个权限位都 false）
    const resolved: ResolvedMemoryBinding[] = [];
    for (const binding of project.bindings ?? []) {
      resolved.push(await this.resolveBinding(actor, binding.type, binding.id));
    }

    return {
      // admin 恒可读/可写：topic 经白名单 `null` 短路（`isVisibleIn`），board/docSpace 经
      // Policy 内 admin bypass；绑定为空时同样成立
      readable: isAdmin || resolved.some((entry) => entry.readable),
      writable: isAdmin || resolved.some((entry) => entry.writable),
      isGovernanceViewer,
      resolved,
    };
  }

  /**
   * 解析单个绑定（存在性 + 读 + 写；读/写可分别按需关闭，见 `ResolveBindingOptions`）。
   *
   * 顺序不变量：**存在性 + 软删闸门在前**，白名单/Policy 在后——白名单对 topic 不 join
   * `topics` 表（participant 查询只打 `topic_participants`），一个软删话题的 id 仍可能出现在
   * 白名单里；若不先过存在性闸门，`exists:false` 的资源会被判成可读。
   *
   * @param actor 当前身份
   * @param type 绑定类型（topic / board / docSpace）
   * @param id 资源 id
   * @param options 计算范围（缺省两位都算；跳过的位返回 false = "未判定"）
   * @returns 解析结果（资源不存在/已软删 ⇒ 三个位全 false，**不抛错**——创建时的 400 由调用方给）
   */
  async resolveBinding(
    actor: UnifiedActor | null,
    type: MemoryBindingType,
    id: string,
    options: ResolveBindingOptions = {},
  ): Promise<ResolvedMemoryBinding> {
    const resource = await this.loadBindingResource(type, id);
    if (!resource) return { type, id, exists: false, readable: false, writable: false };

    // 软删行不该出现（TypeORM 默认谓词已排除），此处只作防御性判定
    const deletedAt = (resource as { deletedAt?: Date | null }).deletedAt;
    if (deletedAt) return { type, id, exists: false, readable: false, writable: false };

    // 只算调用方真正消费的位（成本 rationale 见 ResolveBindingOptions）
    const wantRead = options.read !== false;
    const wantWrite = options.write !== false;

    let readable = false;
    let writable = false;
    try {
      // topic 绑定的**读**判定走运行时白名单，而不是裸调 `PermissionService.can('read')`。
      //
      // 为什么（卡 7a21f96b）：`TopicPolicy` 的 read 分支对 PRIVATE 话题依赖**调用方注入**的
      // `context.hasAccess`（见 topic.policy.ts 的「权限收敛」与规则同步约束）；本服务不是
      // HTTP Controller 路径，没有 TopicService 预查可注入，`hasAccess` 恒 false——于是
      // private topic 的 active/invited 参与者（可正常收发消息）在**创建/改绑**时被误判 400
      // `bindings[topic:<id>] is not readable`。
      //
      // 为什么复用 `getAccessibleTopicIds`：它就是运行时来源过滤（`evaluateSourceRefs` 的
      // message 分支）与列表可见性的**同一白名单**（creator / owner-proxy 名下 agent /
      // participant status IN invited+active / OPEN，admin → null 全放行）。创建时与运行时
      // 用同一判据，两侧才不会漂移；`topic.policy.ts` 的规则同步注释要求 read 条件变更时
      // 同步 `computeAccessibleTopicIds`，复用同一方法即自动继承该同步。
      //
      // 边界：只替换 **read**。write 的 editor/creator/owner-proxy 语义只存在于 TopicPolicy
      //（`permission.can('write')` 内部自查 participant），保持不变。
      if (wantRead) {
        readable =
          type === MEMORY_BINDING_TYPE.TOPIC
            ? isVisibleIn(id, await this.accessQuery.getAccessibleTopicIds(actor ?? undefined))
            : await this.permission.can(resource as never, actor, 'read');
      }
      if (wantWrite) {
        writable = actor !== null && (await this.permission.can(resource as never, actor, 'write'));
      }
    } catch {
      // 解析失败 fail-closed（方案 §5）——**不**向上抛：调用方要能区分"没权限"与"服务坏了"
      readable = false;
      writable = false;
    }
    return { type, id, exists: true, readable, writable };
  }

  /**
   * 项目读闸门（`GET /memory/projects*`）：可读 **或** 治理观察者放行。
   *
   * @returns 访问结论（调用方按 `readable` 决定账本投影档位）
   * @throws NotFoundException 404/14001（既不可读也不是治理观察者——不确认存在性）
   */
  async assertProjectRead(
    actor: UnifiedActor | null,
    project: MemoryProject,
  ): Promise<MemoryProjectAccess> {
    const access = await this.resolveProjectAccess(actor, project);
    if (!access.readable && !access.isGovernanceViewer) {
      throw memoryProjectNotFound(project.id);
    }
    return access;
  }

  /**
   * 项目**内容**读闸门（recall / 记忆详情 / 账本全文字段）。
   *
   * 与 `assertProjectRead` 的差别 = 治理观察者**不**放行内容面（见文件头不变量）；
   * 治理观察者命中时给 403（它已知项目存在，不存在泄露问题），其余给 404。
   */
  async assertProjectContentRead(
    actor: UnifiedActor | null,
    project: MemoryProject,
  ): Promise<MemoryProjectAccess> {
    const access = await this.resolveProjectAccess(actor, project);
    if (access.readable) return access;
    if (access.isGovernanceViewer) {
      throw new ForbiddenException({
        message:
          `All bindings of memory project '${project.id}' are unreadable to you, so its CONTENT ` +
          'endpoints (recall / memory detail / full-text ledger fields) are closed. You can still ' +
          'read the project metadata and the ledger metadata projection, and you can re-bind the ' +
          'project (PATCH /memory/projects/:id) with a resource you can read. 内容端点关闭',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
    throw memoryProjectNotFound(project.id);
  }

  /**
   * 项目写闸门（nominate / correct / retry / recover 四端点同规）。
   *
   * 顺序 = 先项目存在（调用方已做）→ 归档（409，在调用方）→ 写权限（403）。
   *
   * @throws ForbiddenException 403/1009（无本项目写权限）
   */
  async assertProjectWrite(
    actor: UnifiedActor | null,
    project: MemoryProject,
  ): Promise<MemoryProjectAccess> {
    const access = await this.resolveProjectAccess(actor, project);
    if (!access.writable || actor === null) {
      throw memoryProjectForbidden(project.id);
    }
    return access;
  }

  /** 按类型加载绑定资源（软删由 TypeORM 默认谓词排除） */
  private async loadBindingResource(
    type: MemoryBindingType,
    id: string,
  ): Promise<Topic | Board | DocSpace | null> {
    switch (type) {
      case 'topic':
        return this.topicRepo.findOne({ where: { id } });
      case 'board':
        return this.boardRepo.findOne({ where: { id } });
      case 'docSpace':
        return this.spaceRepo.findOne({ where: { id } });
      default:
        return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // ② 来源可见性（批式；三处同源）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * **批式**判定一组来源引用的可见性（与入参一一对应）。
   *
   * 调用方约定：把**同一响应要判定的所有行的 refs 一次性拼平**传进来（如
   * `rows.flatMap((row) => row.sourceRefs)`），再用 `slice` 还原到行——
   * 这样"批式"是调用方看得见的结构，而不是藏在循环里的 N+1（见文件头不变量）。
   *
   * @param actor 当前身份（匿名时按无身份白名单判定）
   * @param refs 来源引用（可跨行拼接）
   * @returns 与 `refs` 等长的判定数组
   */
  async evaluateSourceRefs(
    actor: UnifiedActor | null,
    refs: MemorySourceRef[],
  ): Promise<SourceRefVerdict[]> {
    if (refs.length === 0) return [];

    const cache = await this.preloadSourceChains(refs);
    const [spaceIds, topicIds, boardIds] = await Promise.all([
      this.accessQuery.getAccessibleDocSpaceIds(actor ?? undefined),
      this.accessQuery.getAccessibleTopicIds(actor ?? undefined),
      this.accessQuery.getAccessibleBoardIds(actor ?? undefined),
    ]);

    return refs.map((ref) => {
      switch (ref.type) {
        case 'doc':
          return this.verdictForDoc(ref, cache, spaceIds);
        case 'message':
          return this.verdictForMessage(ref, cache, topicIds);
        case 'task':
          return this.verdictForTask(ref, cache, boardIds);
        case 'comment':
          return this.verdictForComment(ref, cache, boardIds);
        default:
          // 未知类型 fail-closed（值域外数据=脏数据，不给可见性）
          return { visible: false, currentVersionHash: null };
      }
    });
  }

  /** 父链预载：doc/message/task/comment + space/topic/list/board 一次 `IN` 查询 */
  private async preloadSourceChains(refs: MemorySourceRef[]): Promise<SourceChainCache> {
    const idsBy = (type: MemorySourceRef['type']): string[] =>
      refs.filter((ref) => ref.type === type).map((ref) => ref.id);

    const docIds = idsBy('doc');
    const messageIds = idsBy('message');
    const taskIds = idsBy('task');
    const commentIds = idsBy('comment');

    const [docs, messages, tasks, comments] = await Promise.all([
      docIds.length ? this.docRepo.find({ where: { id: In(docIds) } }) : Promise.resolve([]),
      messageIds.length
        ? this.messageRepo.find({ where: { id: In(messageIds) } })
        : Promise.resolve([]),
      taskIds.length ? this.taskRepo.find({ where: { id: In(taskIds) } }) : Promise.resolve([]),
      commentIds.length
        ? this.commentRepo.find({ where: { id: In(commentIds) } })
        : Promise.resolve([]),
    ]);

    // comment → task（父链第二环；与顶层 task 引用共用同一批加载）
    const taskIdsFromComments = [...new Set(comments.map((comment) => comment.taskId))];
    const allTaskIds = [...new Set([...taskIds, ...taskIdsFromComments])];
    const allTasks =
      allTaskIds.length > 0 && tasks.length !== allTaskIds.length
        ? await this.taskRepo.find({ where: { id: In(allTaskIds) } })
        : tasks;

    const listIds = [...new Set(allTasks.map((task) => task.listId))];
    const lists = listIds.length ? await this.listRepo.find({ where: { id: In(listIds) } }) : [];
    const boardIds = [...new Set(lists.map((list) => list.boardId))];
    const boards = boardIds.length
      ? await this.boardRepo.find({ where: { id: In(boardIds) } })
      : [];
    // message → topic / doc → space（父链末环）
    const topicIds = [...new Set(messages.map((message) => message.topicId))];
    const topics = topicIds.length
      ? await this.topicRepo.find({ where: { id: In(topicIds) } })
      : [];
    const spaceIds = [...new Set(docs.map((doc) => doc.spaceId))];
    const spaces = spaceIds.length
      ? await this.spaceRepo.find({ where: { id: In(spaceIds) } })
      : [];

    return {
      docs: new Map(docs.map((row) => [row.id, row])),
      topics: new Map(topics.map((row) => [row.id, row])),
      spaces: new Map(spaces.map((row) => [row.id, row])),
      messages: new Map(messages.map((row) => [row.id, row])),
      tasks: new Map(allTasks.map((row) => [row.id, row])),
      comments: new Map(comments.map((row) => [row.id, row])),
      lists: new Map(lists.map((row) => [row.id, row])),
      boards: new Map(boards.map((row) => [row.id, row])),
    };
  }

  /** doc 判定（父链 = 自身 + space；`currentVersionHash` = 当前 contentHash，`moved` 的判据） */
  private verdictForDoc(
    ref: MemorySourceRef,
    cache: SourceChainCache,
    spaceIds: string[] | null,
  ): SourceRefVerdict {
    const doc = cache.docs.get(ref.id);
    if (!doc) return { visible: false, currentVersionHash: null };
    const space = cache.spaces.get(doc.spaceId);
    if (!space) return { visible: false, currentVersionHash: null };
    return {
      visible: isVisibleIn(space.id, spaceIds),
      currentVersionHash: doc.contentHash ?? null,
    };
  }

  /** message 判定（父链 = message → topic） */
  private verdictForMessage(
    ref: MemorySourceRef,
    cache: SourceChainCache,
    topicIds: string[] | null,
  ): SourceRefVerdict {
    const message = cache.messages.get(ref.id);
    if (!message) return { visible: false, currentVersionHash: null };
    const topic = cache.topics.get(message.topicId);
    if (!topic) return { visible: false, currentVersionHash: null };
    return { visible: isVisibleIn(topic.id, topicIds), currentVersionHash: null };
  }

  /** task 判定（父链 = task → list → board） */
  private verdictForTask(
    ref: MemorySourceRef,
    cache: SourceChainCache,
    boardIds: string[] | null,
  ): SourceRefVerdict {
    const task = cache.tasks.get(ref.id);
    if (!task) return { visible: false, currentVersionHash: null };
    return { visible: this.taskChainVisible(task, cache, boardIds), currentVersionHash: null };
  }

  /** comment 判定（父链 = comment → task → list → board） */
  private verdictForComment(
    ref: MemorySourceRef,
    cache: SourceChainCache,
    boardIds: string[] | null,
  ): SourceRefVerdict {
    const comment = cache.comments.get(ref.id);
    if (!comment) return { visible: false, currentVersionHash: null };
    if (!comment.taskId) return { visible: false, currentVersionHash: null };
    const task = cache.tasks.get(comment.taskId);
    if (!task) return { visible: false, currentVersionHash: null };
    return { visible: this.taskChainVisible(task, cache, boardIds), currentVersionHash: null };
  }

  /** task → list → board 两环（task 与 comment 共用；任一环缺失/软删 ⇒ 不可见） */
  private taskChainVisible(
    task: Task,
    cache: SourceChainCache,
    boardIds: string[] | null,
  ): boolean {
    const list = cache.lists.get(task.listId);
    if (!list) return false;
    const board = cache.boards.get(list.boardId);
    if (!board) return false;
    return isVisibleIn(board.id, boardIds);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ②-b 映射表构建（`engine_memory_ids` → canonical 账本行）
  //
  // 位置说明：它**不是**权限判定，但两个消费方（召回过滤 / 投影读面的逐节点过滤）都需要
  // "这条引擎记忆属于本项目的哪一行"才谈得上来源可见性——故与来源判定同层，且**唯一实现**
  // （服务互注会造循环依赖，复制第三份会漂移）。
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 构建 `memory_id → canonical 账本行` 映射（**唯一构建点**）。
   *
   * ⚠️ **`engine_memory_ids` 是 jsonb 数组，禁入 SQL 谓词**（嵌套条件 = 整列等值永不命中，铁律 #23）
   * ——故：**显式列投影**拉全量行，在**内存**里展开数组建映射。任何"用 `->>'x'` 把它写进 WHERE"
   * 的改写都会安静地返回空集合（表现为"所有引擎记忆都映射不到"，而不是报错）。
   *
   * 语义（三条，改动前先想清楚谁在依赖）：
   * 1. **只认 canonical 行**：alias 行 `engine_memory_ids` 恒 NULL（实体不变量）⇒ 天然不入映射；
   * 2. **撤回行不认**：`withdrawn` 即使残留 ids 也排除（行为级兜底，不只依赖 `ids 空`的不变量）；
   * 3. **同一 memory_id 出现在两行 ⇒ fail-closed + warn**：删掉该映射——宁可过滤成 unmapped，
   *    也不指向一条不确定的行。
   *
   * @param projectId 项目 id
   * @returns 映射 + `engineDataSuspect` 判据要用的两个事实（有 committed 行 / 有在途行）
   */
  async loadMemoryIdMapping(projectId: string): Promise<MemoryIdMapping> {
    const rows = await this.nominations
      .createQueryBuilder('nomination')
      // ⚠️ `select([...])` 必须用**实体属性名**（camelCase）而不是列名（snake_case）：
      // 用列名 TypeORM 不报错、但映射不到属性 ⇒ 返回的行里 `engineMemoryIds` 恒 undefined
      // ⇒ 映射表恒空（症状 = 读面条目全部被判成 unmapped）。
      // e2e「召回全字段契约」与「三处同源」两条用例正是这条的守卫。
      .select([
        'nomination.id',
        'nomination.category',
        'nomination.subject',
        'nomination.scope',
        'nomination.contentTruncated',
        'nomination.status',
        'nomination.formationState',
        'nomination.reviewAt',
        'nomination.sourceRefs',
        'nomination.engineMemoryIds',
      ])
      .where('nomination.project_id = :projectId', { projectId })
      .andWhere('nomination.deleted_at IS NULL')
      // 撤回行不参与映射（`withdrawn ⇒ ids 空` 的**行为级**兜底：即使 ids 未清也不认它）
      .andWhere('nomination.status != :withdrawn', {
        withdrawn: MEMORY_NOMINATION_STATUS.WITHDRAWN,
      })
      .getMany();

    const byMemoryId = new Map<string, MappedLedgerRow>();
    let hasCommitted = false;
    let hasInFlight = false;

    for (const row of rows) {
      if (row.formationState === MEMORY_FORMATION_STATE.COMMITTED) hasCommitted = true;
      if (row.formationState === MEMORY_FORMATION_STATE.SUBMITTED) hasInFlight = true;

      const ids = row.engineMemoryIds ?? [];
      if (ids.length === 0) continue; // alias 行恒空 ⇒ 天然不入映射
      const projected: MappedLedgerRow = {
        id: row.id,
        category: row.category,
        subject: row.subject,
        scope: row.scope,
        contentTruncated: row.contentTruncated,
        status: row.status,
        formationState: row.formationState,
        reviewAt: row.reviewAt,
        sourceRefs: row.sourceRefs ?? [],
        engineMemoryIds: ids,
      };
      for (const memoryId of ids) {
        if (byMemoryId.has(memoryId)) {
          // 冲突 ⇒ fail-closed + warn：宁可把这条过滤掉（记 unmapped），也不指向不确定的行
          logger.warn(
            `memory id ${memoryId} maps to multiple ledger rows in project ${projectId} — ` +
              'excluding it from the mapping (fail-closed)',
          );
          byMemoryId.delete(memoryId);
          continue;
        }
        byMemoryId.set(memoryId, projected);
      }
    }

    return { byMemoryId, hasCommitted, hasInFlight };
  }

  /** 绑定的"可读资源"判定（**创建/改绑时**的 400 指名字段用；与运行时闸门同判据） */
  async describeUnreadableBinding(
    actor: UnifiedActor | null,
    type: MemoryBindingType,
    id: string,
  ): Promise<string | null> {
    // 只判 read：write 位（Policy 的 editor 查询）在这里无人消费，白算等于给创建/改绑加成本
    const resolved = await this.resolveBinding(actor, type, id, { write: false });
    if (!resolved.exists) {
      return `bindings[${type}:${id}] does not exist or has been deleted (存在+未软删 required)`;
    }
    if (!resolved.readable) {
      return `bindings[${type}:${id}] is not readable by the caller (可读 required)`;
    }
    return null;
  }
}
