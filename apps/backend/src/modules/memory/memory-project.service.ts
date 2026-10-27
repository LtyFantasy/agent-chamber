/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory **项目注册表**（`memory_projects`）的服务层：创建 / 列表 / 详情 / 更新
 *     ——"记忆跟项目走"的锚点，也是绑定与引擎绑定的唯一写入面
 *
 * [代码职责]
 *   - 创建：绑定校验（存在+未软删+可读，**400 指名字段**）/ slug 冲突 409 / 引擎绑定三元组
 *     完整性 + 凭据形态闸门 / **自助开通**（`engine=hument` 且三键全缺时自动注册 Hub 并把
 *     派生三键落库）
 *   - 列表：slug / `bindingType+bindingId` 过滤 + 应用层可见性过滤 + 分页钳制
 *   - 更新：改名 / 绑定 / 归档 / 绑定引擎（**首条耐久账本后固定 engine/workspace/actor，凭据引用可轮换** 409）/
 *     翻转召回原文留存开关（`retainQueryText`，默认 true）
 *   - `engineAvailability`：本地数据端点嵌的引擎可用性块（两态区分，见 memory.constants）
 *   - 项目投影的 `canReadUsage`：Usage 读面权限（admin 或**全部**绑定可读；与 any-binding
 *     的 `canReadContent` 刻意不同，共享/claim 的 409 不在此列）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/api-definition.md` §19 — 项目权限与 409 合同
 *   - 补充: `docs/database.md` §4.35 / §4.39 — 当前身份唯一索引与永久 claim 职责
 *
 * [关键不变量]
 *   - 当前完整身份的目标索引冲突与历史 claim 冲突同为 409；只翻译精确约束名，
 *     必须在事务回滚之后翻译，且绝不触发自动注册的 workspace disable。
 *   - **创建时必须逐个绑定「存在 + 未软删 + 可读」**（方案 §5）：不可读的绑定不是"以后再说"
 *     ——它会让项目落进"全部绑定不可读"的治理路径（连自己都读不到自己刚建的项目）。
 *     400 的 message 必须指名字段（`bindings[topic:<id>] ...`），否则用户只能猜。
 *   - **`engine` 与三个引擎绑定列的一致性**：`engine=none` ⇒ 三个绑定列**强制 null**
 *     （留半个绑定 = 后人以为配好了）；`engine≠none` ⇒ 三列必填且非空（缺一 400 指名字段）。
 *     这是"注册表里没有半配置状态"这条不变量的唯一执行点。
 *   - **创建的三分支（二期自助开通）**：`engine=hument` 且三键**全缺**且 provisioning 客户端
 *     可用 ⇒ **自动注册** Hub 并把派生三键落库；三键**全显式** ⇒ 手工老路（**零注册调用**，
 *     Kairos 迁移 / 特殊 workspace 场景保留）；**部分缺**（或全缺但未启用自助开通）⇒ 400
 *     （现状不变）。判「全缺」用 trim 口径（空串/空白视同未给，与 `normalizeEngineBinding`
 *     同口径），否则用户传 `""` 会被判成"部分缺"而 400。
 *   - **自动注册的顺序 = slug 预检 → provision → 落库**：先预检是因为注册**不可撤销**
 *     （hument 无 unregister 端点）——slug 已占用时提前 409，绝不在 Hub 留下孤儿；
 *     而 provision 之后才 save 意味着 save 失败就是孤儿（见下条）。
 *   - **孤儿 workspace 风险（接受 + 大声记日志 + alpha.4 起 best-effort 善后）**：provision 成功但
 *     `save` 失败时，Hub 侧已登记的 workspace 无端点可删 ⇒ 原错误照常返回（23505 时是 409）+
 *     `Logger.error` 记录 workspace_id 与幂等键（提示需运维处理）。**alpha.4 起**在这条路径上
 *     **best-effort** 调 `disableProject(slug)`（FEEDBACK-11）：disabled 保留记忆/审计、拒新业务、
 *     重启保持、**可被运维恢复**——比"还活着的孤儿"安全得多（alpha.3 时代只能等运维手术）。
 *   - **`provisioned` 非空 ≠ 本地无行 ⇒ disable 前必须复核**（评审 B-1，**不可省**）：并发同 slug
 *     的 23505 **败者**手里 `provisioned` 同样非空，但胜者的行已 commit 且可见——无条件 disable
 *     会把**正在服务**的 workspace 置于死地（`save` 在 COMMIT 后抛错的假孤儿同理）。故
 *     `disableOrphanWorkspace` 先 `findOne({slug, deletedAt: IsNull()})`：**有行 ⇒
 *     `disable_skipped:local_row_exists`**；**复核查询自身抛错 ⇒ `disable_skipped:check_failed`**
 *     （宁可留孤儿，绝不误伤活项目）；**只有确认无行才 disable**。于是**常见并发冲突路径零加价**
 *     （一次索引点查），孤儿路径才付 disable 代价。
 *   - **善后预算 = 独立 30s 墙钟（`HUMENT_PROVISIONING_DISABLE_TOTAL_TIMEOUT_MS`）**：孤儿路径的
 *     最坏耗时 = provision 墙钟（120s）+ 30s 善后，且**只在这条罕见路径上**发生（S-2）——
 *     常态与"本地有行"的冲突路径都不发起 disable。
 *   - **善后绝不改变 create 的报错路径**：disable 的任何失败都不 throw，只在日志里多一个字段
 *     （`disabled` / `disabled(replayed-receipt)` / `disable_failed:<分类>` / `disable_skipped:<原因>`）。
 *     ⚠️ **日志按 skip/disable 分叉**（评审 N1）：`disable_skipped:*` = 复核判定"这不是孤儿"
 *     ⇒ **warn 级独立文案 `ORPHAN CHECK`**（无运维动作，**绝不**套 ORPHAN WORKSPACE 模板——
 *     那条模板固定宣称"本地无项目"并给"运维删/改 workspace"处方，会诱导误删胜者的活注册）；
 *     其余（真发起 disable 或 disable 失败）⇒ **error 级 `ORPHAN WORKSPACE` + 运维处方**。
 *     ⚠️ `replayed-receipt` 是"该 key 的历史 receipt 已落地"，**不代表项目当前实时状态**
 *     （运维 re-enable 后同 key 重放仍回 replay）——运维读它要回查 GET（评审 S-1）。
 *     ⚠️ 告警判据是**任何 save 失败**，不是只有 23505（PG 抖动/死锁/驱动错/约束名变化同样会留下
 *     孤儿）——详见 `create` 的 catch 注释。
 *   - **自动注册的展示名 = DTO 的 `name`（trim 后）**：alpha.4 起注册体带可选 `display_name`
 *     （与激活同一事务原子写入），故项目名在注册那一刻就与 Hub 侧对齐；**注册后改名仍走不通**
 *     （需 workspace_admin 能力，我们持有 manager binding）——Chamber 侧改名以本项目注册表为准。
 *     ⚠️ 孤儿后"同 slug 换名重试"会被 Hub 409（幂等 request digest 含 `display_name`）。
 *     处置分层（评审 S-3a）：**同名重试只在 disable 尚未落地时能自愈**（digest 一致 ⇒ 重放推进）；
 *     若善后已把 workspace 置为 disabled ⇒ **需运维先 re-enable**，或**显式传三键**绕过注册
 *     （但**不得复用**那个已禁的 workspace）。
 *   - **provision 失败 ⇒ 503 `MEMORY_UNAVAILABLE(14000)`**，`data.reason` 按失败类型取
 *     `provisioning_timeout` / `provisioning_unavailable` / `provisioning_conflict` /
 *     `provisioning_failed`（值域单源 = shared），**`save` 未被调用**（本地零副作用）。
 *     理由：这是"增强项的上游暂不可用"，与引擎不可用同族；用 502 会把"没登记上"伪报成
 *     "Hub 崩了"（铁律 #9 的近亲）。
 *   - **`mayHaveLanded` 优先于失败分类**：client 在**观测到过 202** 之后产生的任何无定论失败
 *     都带这个标记，其唯一正确的措辞是"登记可能已落 Hub，同 slug 同参重试安全"⇒ 一律映射
 *     `provisioning_timeout`。**不能**映射成 `provisioning_unavailable`（"请求未到达"）——
 *     那会让调用方以为 Hub 上没有残留，从而在换 slug 时留下一个再也对不上的登记。
 *   - **PATCH 的写权限判据**（方案未明文，本批定的口径）：admin ｜ creator ｜ ≥1 绑定 write。
 *     理由：绑定是权限的**唯一来源**，若"任何认证 actor"都能改别人的项目绑定，
 *     任何人都能把自己的资源绑进别人的项目来提权（读别人的账本）。此口径写进 e2e 断言。
 *   - **首条任意耐久账本后固定数据身份(engine/workspace/actor)**，包含软删与所有状态。
 *     PATCH 与首次建账共锁项目行，显式 READ COMMITTED；Provider 与权限 IO 都不持锁。
 *     credentialRef 可独立轮换；元数据 PATCH 只在锁内 fresh 实体上应用显式 DTO delta。
 *   - **slug 不可改**（DTO 里没有它）：slug 是展示/过滤辅助，改名走 `name`；
 *     允许改 slug 会让"我记得那个项目叫 xxx"变成一条误导线索。
 *   - **`retainQueryText` 只收布尔、无 `null` 清空语义**（对应列 NOT NULL）：DTO 用
 *     `@IsBoolean()` 在层 1 挡掉 null；service 只做值判定 `!== undefined`。
 *     它是**唯一**能被 PATCH 翻转的"留存"开关，只影响之后新落的召回遥测行（不回改历史），
 *     消费点只有 `memory-recall.service.ts` 一处——本文件不读、不转存任何 query 原文。
 *   - **引擎身份永久占用（Hument Usage 隔离前提）**：完整非 `none` 三元组在**同一 DB
 *     事务**内 `INSERT … ON CONFLICT DO NOTHING` 后回读归属。同一 projectId 幂等放行
 *     （含 PATCH 重发与改绑回旧三元组）；不同 projectId 精确 409（`MEMORY_PROJECT_CONFLICT`）。
 *     改绑 / 清空 / 归档 / 软删 / 项目硬删**都不释放** claim；`engine=none` 或不完整三元组
 *     **不写** claim。自动注册与手工绑定走同一条事务路径。
 *     - **旧三元组 best-effort 占用**：改绑/清空前的旧身份先 `DO NOTHING` 写入（不判 owner），
 *       避免 rollout 前无 claim 的项目换绑后旧身份被冒领；历史重复三元组的"败者"仍可改绑逃生。
 *       历史项目补录的 `first_claimed_at` 显式取**项目 `createdAt`**；create / 改绑到新三元组
 *       的严格 claim 仍用 DB `now()`（"本次新占用"）。`DO NOTHING` 保证既有 claim 不被覆盖。
 *     - **非引擎 PATCH 也补 claim**：项目当前有完整三元组时，改名/归档等 PATCH 同样 best-effort
 *       补缺失 claim（幂等，不判 owner）。
 *     - **自动注册前预查派生三元组**（claim + `withDeleted` 历史行）：命中直接 409，Hub 调用为 0；
 *       事务内 claim 冲突（竞态）同样**不得**触发孤儿 disable（会误杀有历史归属的 workspace）。
 *     - **409 文案零用户输入**：不回显 workspace/actor/credentialRef/owner project id；
 *       标识符三列（workspace/actor/credentialRef）都过同一字符集闸门。
 *     ⚠️ 该事务只包「落项目 + 写 claim」；Hub 注册（不可撤销、有孤儿语义）必须在事务**之前**，
 *     否则长事务 + 网络等待会放大锁面，且孤儿善后模板会误判。
 *   - **软删项目读写一律 404**（`memoryProjectNotFound`）：不泄露存在性。
 *   - **`engineAvailability` 的判据只看"token 是否是 null + 项目引擎列"**，不看
 *     `MEMORY_CONFIG.engine`：e2e 用 `overrideProvider(MEMORY_ENGINE_RAW)` 注入 FakeEngine 时
 *     config 仍是缺省 `none`——用 config 判会把这套装配判成"未配置"（而闸门实际是开着的）。
 *   - **项目投影的 `canReadContent` 是"读权限"的函数，逐请求实算**（Memory web 二期 A3）：
 *     值 = `resolveProjectAccess().readable`，与 `assertProjectContentRead` 同源。三个纪律：
 *     ① `findOne` **接住** `assertProjectRead` 的返回值（它本就返回访问结论——不要多查一次）；
 *     ② `findAll` 的可见性过滤循环必须把 `{project, access}` **配对**带过分页切片
 *     （access 出了循环作用域就没了，重算 = 多打一轮库，丢掉 = 只能瞎填）；
 *     ③ `update` 改绑后**必须重算**（变更前的结论已过期），而 `canUpdate` 的授权判定继续用
 *     变更前的 access——授权看"改之前"，投影看"改之后"，两者不可混用。
 *     ④ `create` 的投影**必须在 `save` 的 try/catch 之外**（评审 M-1）：那个 catch 的语义是
 *     "**save 失败** ⇒ Hub 孤儿善后"；投影抛错（绑定查库驱动错等）时 save **已 commit**，
 *     落进孤儿模板会去 disable 一个**正在服务**的 workspace，还把已建成的项目伪报成失败。
 *     ⚠️ **admin 恒 true**——topic 绑定由白名单 `null` 短路放行，board/docSpace 由 Policy 内
 *     admin bypass；别把它当"有没有绑定"的判据。
 *   - **`provisioningAvailable` 是部署级字段，不是项目级**：值 = `this.provisioning !== null`，
 *     即 `create` 的 `autoProvision` 判据里的**部署因子**（另两个因子——`engine=hument` 与三键
 *     全缺——属**请求**态，刻意不进这个信封字段）。挂在**列表信封**上，零项目时也返回；
 *     前端据此决定"engine=hument 留空可自动注册"还是"必须手填三键"，那是部署态而非项目态。
 *
 * [关联代码]
 *   - ../memory-access.service.ts — 绑定解析与三档闸门（本文件不自己判权限）
 *   - ./memory-binding-query.ts — 绑定 containment 谓词的单源（列表反查的 `?bindingType=`）
 *   - ../memory.constants.ts — `isSafeCredentialRef` / 错误构造器 / 分页上界 / `memoryUnavailable`
 *   - ../engines/memory-engine.factory.ts — `MEMORY_ENGINE` / `MEMORY_CONFIG` /
 *     `MEMORY_PROVISIONING` 三个 token 的来源
 *   - ../engines/hument-provisioning.client.ts — 自助开通实现（自动注册分支的唯一依赖；
 *     失败面的 `mayHaveLanded` 标记由它给出；孤儿善后走它的 `disableProject`）
 *   - ../../config/judgment.config.ts — `sanitizeLogValue`（日志回显净化单源；Hub 给的
 *     engineCode / requestId 是上游可控串，插值前一律净化）
 *   - ./memory-formation.service.ts — 首次建账共锁项目行，防准备快照跨 namespace
 *   - ../../database/entities/memory-engine-binding-claim.entity.ts — 永久占用表契约
 *   - ../../database/migrations/1792400000000-AddMemoryEngineBindingClaims.ts — 建表 + 历史回填
 *
 * [持久踩坑]
 *   MEMORY-PROVISION-ORPHAN(注册成功但落库失败): 顺序反了（先 save 后注册）会留下"Chamber 有
 *     项目、Hub 没登记"的半成品（每次形成都 404）；而 provision 后 save 撞 23505 则是
 *     "Hub 有登记、Chamber 无项目"的孤儿（Hub 无删除端点）。两者都不能静默。
 *     安全方向: slug 预检前置 + 任何 save 失败都大声记孤儿日志 + **best-effort disableProject**
 *     （alpha.4；把孤儿从"还在服务"降级为"保留数据但拒新业务、可恢复"，本文件），
 *     且 **disable 前必须复核本地无行**（否则并发败者会把胜者的活 workspace 禁掉，评审 B-1）。
 *   MEMORY-BLANK-TRIPLE(空串当作"部分缺"): 用户传 `engineWorkspaceId: ""` 时若按 `!== undefined`
 *     判"给了"，会跳过自动注册而落 400（用户看到的是"三键缺一不可"而它明明没打算填）。
 *     安全方向: 与 `normalizeEngineBinding` 同口径——trim 后判空（本文件 `isBlankEngineField`）。
 *   MEMORY-CLAIM-DISABLE(软删同 slug 自动注册): 软删项目保留 claim；同 slug 再自动注册会让 Hub
 *     按幂等键重放既有登记，若先注册再落库，claim 冲突回滚后的孤儿善后会把仍有历史归属的
 *     workspace disable。安全方向: Hub 调用前预查派生三元组（claim + withDeleted）；claim 冲突
 *     不进 disable；孤儿复核用 `withDeleted: true`。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, type EntityManager } from 'typeorm';
import {
  ErrorCode,
  MEMORY_ENGINE,
  MEMORY_UNAVAILABLE_REASON,
  type MemoryEngine,
  type MemoryUnavailableReason,
} from '@agent-chamber/shared';
import { MemoryProject, type MemoryBinding } from '../../database/entities/memory-project.entity';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import { MemoryEngineBindingClaim } from '../../database/entities/memory-engine-binding-claim.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import {
  MEMORY_ENGINE as MEMORY_ENGINE_TOKEN,
  type MemoryEngine as MemoryEnginePort,
} from './engines/memory-engine.interface';
// `MEMORY_PROVISIONING` token 的运行时值来自工厂（字符串稳定值；e2e 按它 override）
import { MEMORY_PROVISIONING as MEMORY_PROVISIONING_TOKEN } from './engines/memory-engine.factory';
import {
  HUMENT_PROVISIONING_ACTOR_ID,
  buildProvisioningCredentialRef,
  type HumentProvisioningClient,
  type HumentProvisioningFailure,
} from './engines/hument-provisioning.client';
import {
  canReadMemoryUsage,
  MemoryAccessService,
  type MemoryProjectAccess,
} from './memory-access.service';
// 绑定 containment 谓词的**单源**（阶段二起列表反查与拦截器 provider 共用一份；
// SQL 文本与参数名是 memory-project.service.spec.ts 的逐字断言对象，见该文件头）
import { andWhereProjectBindingsContain } from './memory-binding-query';
import { sanitizeLogValue } from '../../config/judgment.config';
import {
  isSafeCredentialRef,
  MEMORY_DEFAULT_PAGE_SIZE,
  MEMORY_ENGINE_IDENTIFIER_PATTERN,
  MEMORY_MAX_PAGE_SIZE,
  memoryProjectConflict,
  memoryProjectNotFound,
  memoryUnavailable,
} from './memory.constants';
import type {
  MemoryEngineAvailability,
  MemoryProjectDto,
  MemoryProjectListResponse,
} from './dto/memory-contract';
import type {
  CreateMemoryProjectDto,
  QueryMemoryProjectsDto,
  UpdateMemoryProjectDto,
} from './dto/project.dto';

const logger = new Logger('MemoryProject');

/** 完整引擎绑定三元组（只在 `engine !== none` 且三列全非空时构造） */
interface EngineBindingTriple {
  engine: MemoryEngine;
  workspaceId: string;
  actorId: string;
  credentialRef: string;
}

/**
 * 引擎身份占用冲突（内部类型）。
 *
 * ⚠️ 必须可被 create 的孤儿善后逻辑识别：**claim 冲突不是孤儿**，不得触发 Hub disable。
 * message **不含任何用户输入**（workspace/actor/owner project id 一律不回显）——避免把
 * 调用方输入或他项目 id 塞进错误响应；下一步动作固定写在文案里。
 */
const ENGINE_BINDING_CONFLICT_MESSAGE =
  'The engine identity is already used or permanently claimed by another memory project. Claims are ' +
  'never released by rebinding, clearing, archiving, soft-deleting or deleting the owning ' +
  'project. Use a DIFFERENT engine identity, or ask an operator to audit the stale claim. ' +
  '引擎身份已被其他项目使用或永久占用';

class EngineBindingClaimConflict extends ConflictException {
  constructor() {
    super({
      message: ENGINE_BINDING_CONFLICT_MESSAGE,
      code: ErrorCode.MEMORY_PROJECT_CONFLICT,
      data: { reason: 'engine_binding_claimed' },
    });
  }
}

/**
 * 善后复核判定「不该 disable」的日志字段前缀（评审 N1 的分叉依据）。
 *
 * 命中它的 outcome（`disable_skipped:local_row_exists` / `disable_skipped:check_failed`）意味着
 * **这不是孤儿**（或孤儿身份未知）⇒ 走 warn 级 `ORPHAN CHECK` 文案，**绝不**套 `ORPHAN WORKSPACE`
 * 模板——那条模板固定宣称"本地无项目"并给"运维删/改/重启用 workspace"的处方，套在良性并发竞态上
 * 既自相矛盾、又会诱导运维误删**胜者的活注册**。
 */
const DISABLE_SKIP_PREFIX = 'disable_skipped:';

@Injectable()
export class MemoryProjectService {
  constructor(
    @InjectRepository(MemoryProject) private readonly projects: Repository<MemoryProject>,
    @InjectRepository(MemoryNomination) private readonly nominations: Repository<MemoryNomination>,
    private readonly access: MemoryAccessService,
    @Inject(MEMORY_ENGINE_TOKEN) private readonly engine: MemoryEnginePort | null,
    // 自助开通客户端（**可为 null**：未启用 / 缺 socket 路径 ⇒ 走现有 400 语义）；
    // token 值是 `null` 而不是 Noop（同引擎纪律，见工厂文件头）
    @Inject(MEMORY_PROVISIONING_TOKEN)
    private readonly provisioning: HumentProvisioningClient | null,
  ) {}

  // ══════════════════════════════════════════════════════════════════════
  // 引擎可用性（本地数据端点嵌的块；**唯一判据点**）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 计算项目的引擎可用性块（见文件头不变量）。
   *
   * @param project 项目实体
   * @returns `{engine, available, reason}`
   */
  engineAvailability(
    project: Pick<
      MemoryProject,
      'engine' | 'engineWorkspaceId' | 'engineActorId' | 'engineCredentialRef'
    >,
  ): MemoryEngineAvailability {
    if (this.engine === null) {
      return {
        engine: project.engine,
        available: false,
        reason: MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED,
      };
    }
    if (project.engine === MEMORY_ENGINE.NONE || !this.hasCompleteEngineBinding(project)) {
      return {
        engine: project.engine,
        available: false,
        reason: MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
      };
    }
    return { engine: project.engine, available: true, reason: null };
  }

  /** 引擎绑定三元组是否齐备（缺一 = 未绑定；见文件头不变量） */
  hasCompleteEngineBinding(
    project: Pick<MemoryProject, 'engineWorkspaceId' | 'engineActorId' | 'engineCredentialRef'>,
  ): boolean {
    return Boolean(
      project.engineWorkspaceId?.trim() &&
      project.engineActorId?.trim() &&
      project.engineCredentialRef?.trim(),
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // 读面
  // ══════════════════════════════════════════════════════════════════════

  /** 取项目（软删视为不存在 → 404） */
  async findProjectOrThrow(projectId: string): Promise<MemoryProject> {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw memoryProjectNotFound(projectId);
    return project;
  }

  /** 项目详情（`GET /memory/projects/:id`；**零副作用**：不写库、不调引擎） */
  async findOne(actor: UnifiedActor | null, projectId: string): Promise<MemoryProjectDto> {
    const project = await this.findProjectOrThrow(projectId);
    // `assertProjectRead` **本身就返回**访问结论（PM Q3-c）——接住它，绝不为此多查一次绑定
    const access = await this.access.assertProjectRead(actor, project);
    return this.toDto(project, access, actor);
  }

  /** 项目列表（应用层可见性过滤 + 分页钳制；见文件头不变量） */
  async findAll(
    actor: UnifiedActor | null,
    query: QueryMemoryProjectsDto,
  ): Promise<MemoryProjectListResponse> {
    if (query.bindingId !== undefined && query.bindingType === undefined) {
      throw new BadRequestException({
        message:
          'bindingId requires bindingType: pass both (e.g. ?bindingType=board&bindingId=<uuid>) so ' +
          'the reverse lookup is unambiguous. 反查必须给全 bindingType+bindingId',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? MEMORY_DEFAULT_PAGE_SIZE, MEMORY_MAX_PAGE_SIZE);

    const qb = this.projects
      .createQueryBuilder('project')
      .where('project.deleted_at IS NULL')
      .orderBy('project.created_at', 'DESC')
      .addOrderBy('project.id', 'ASC');

    if (query.slug) qb.andWhere('project.slug = :slug', { slug: query.slug });
    // 绑定过滤走 jsonb 的 containment（`@>`）——**谓词与参数名的单源 =
    // memory-binding-query.ts**（阶段二 provider 共用同一份，消灭第二份漂移面）：
    // 嵌套对象等值（`bindings = :x`）永不命中（铁律 #23），`@>` 是 PG 原生语义、走 GIN 或顺序扫描
    if (query.bindingType) {
      andWhereProjectBindingsContain(qb, 'project', {
        type: query.bindingType,
        ...(query.bindingId ? { id: query.bindingId } : {}),
      });
    }

    const rows = await qb.getMany();

    // 应用层可见性过滤（分页在过滤**之后**做：先过滤再切片，否则页码会跳空）。
    // ⚠️ 必须把 **access 与 project 配对**带过分页切片：access 是在本循环里算出来的
    // （每个项目一次绑定解析），若只 push project、到 `map` 再重新解析，要么多打一轮库、
    // 要么（曾发生的写法）在循环外已出作用域只能丢掉 ⇒ `canReadContent` 只能瞎填。
    const visible: Array<{ project: MemoryProject; access: MemoryProjectAccess }> = [];
    for (const project of rows) {
      const access = await this.access.resolveProjectAccess(actor, project);
      if (access.readable || access.isGovernanceViewer) visible.push({ project, access });
    }

    const start = (page - 1) * pageSize;
    return {
      items: visible
        .slice(start, start + pageSize)
        .map(({ project, access }) => this.toDto(project, access, actor)),
      total: visible.length,
      page,
      pageSize,
      // 部署级开关（**不是项目级**）：来源 = provisioning client 是否装配（= create 的
      // autoProvision 判据里的**部署因子**；另两个因子属请求态）。见 dto/memory-contract.ts。零项目也照带。
      provisioningAvailable: this.provisioning !== null,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 写面
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 创建项目（`POST /memory/projects`）。
   *
   * 引擎绑定的**三分支**见文件头不变量：全缺 + engine=hument + 自助开通可用 ⇒ 自动注册；
   * 全显式 ⇒ 手工老路；其余 ⇒ 400。
   */
  async create(actor: UnifiedActor, dto: CreateMemoryProjectDto): Promise<MemoryProjectDto> {
    const bindings = dto.bindings.map((binding) => ({ type: binding.type, id: binding.id }));
    await this.assertBindingsResolvable(actor, bindings);

    const engine = dto.engine ?? MEMORY_ENGINE.NONE;

    // 三键是否**全缺**（trim 口径：空串/空白 = 未给；见文件头不变量）
    const allEngineFieldsBlank =
      isBlankEngineField(dto.engineWorkspaceId) &&
      isBlankEngineField(dto.engineActorId) &&
      isBlankEngineField(dto.engineCredentialRef);
    // 自动注册分支的判据（**只在 engine=hument + 三键全缺 + 客户端可用**时成立）：
    // 客户端为 null（未启用自助开通）= 现状语义（下面 normalizeEngineBinding 抛 400）
    const autoProvision =
      engine === MEMORY_ENGINE.HUMENT && allEngineFieldsBlank && this.provisioning !== null;

    // ⚠️ 非自动路径**先**做三元组校验：保持"部分缺 ⇒ 400"先于"slug 冲突 ⇒ 409"的现状顺序
    // （自动路径刻意把校验延后到 slug 预检之后——见下一步的理由）
    const explicitBinding = autoProvision ? null : this.normalizeEngineBinding(dto, engine);

    // slug 预检（唯一索引仍是最终仲裁者：并发下靠 23505 兜底，见下方 catch）
    const existing = await this.projects.findOne({
      where: { slug: dto.slug, deletedAt: IsNull() },
    });
    if (existing) {
      throw memoryProjectConflict(
        `slug '${dto.slug}' is already taken by project ${existing.id}. Pick another slug, or ` +
          'reuse the existing project (GET /memory/projects?slug=...). slug 已被占用',
      );
    }

    // 自动注册前**先**查派生三元组的永久占用（claim + withDeleted 历史行）。
    // 软删项目沿用同 slug 时，Hub 的 `chamber-provision-<slug>` 会重放既有登记；
    // 若此时先注册再落库、claim 冲突回滚，就会把仍有历史归属的 Hub workspace 误 disable。
    // 预查命中 ⇒ 直接 409，Hub 调用为 0。
    if (autoProvision) await this.assertDerivedBindingClaimFree(dto.slug);

    // 自动注册在**预检之后**：注册不可撤销（Hub 无 unregister），预检命中时提前 409，
    // 绝不在 Hub 留下孤儿（见文件头不变量）
    // 展示名一并交给 Hub（alpha.4 `display_name`，与激活同一事务写入）——用 DTO 的 `name`（trim 后）
    const provisioned = autoProvision
      ? await this.provisionEngineBinding(dto.slug, dto.name.trim())
      : null;
    const engineBinding = provisioned ?? explicitBinding;

    const entity = this.projects.create({
      slug: dto.slug,
      name: dto.name,
      bindings,
      engine,
      engineWorkspaceId: engineBinding?.workspaceId ?? null,
      engineActorId: engineBinding?.actorId ?? null,
      engineCredentialRef: engineBinding?.credentialRef ?? null,
      createdBy: actor.id,
    });

    // ⚠️ **try 只包落库事务**（评审 M-1）：本 catch 的语义是"**落库失败** ⇒ Hub 孤儿善后"。
    // 事务内 = 项目 save + 引擎身份 claim（claim 冲突会让整个事务回滚，不留半成品）。
    // 若把后面的投影（resolveProjectAccess / toDto）也留在 try 内，它们抛错（如绑定资源查库
    // 驱动错）会落进孤儿模板——但此时 save **已 commit**（项目建成了，客户端却拿到错误、
    // 重试还会撞 409），而善后还会去 disable 一个**正在服务**的 workspace。故投影一律在
    // catch **之后**做：那里能保证 `saved` 已真实落库。
    let saved: MemoryProject;
    try {
      saved = await this.saveProjectWithEngineClaim(entity, { strictNew: true });
    } catch (error) {
      // ⚠️ 孤儿告警放在 catch **顶部**（评审 B-1）：**任何** save 失败——不只 23505（PG 抖动 /
      // 死锁 / 驱动错 / 约束名变化同样命中）——都意味着"Hub 已登记、Chamber 无项目"。只在 23505
      // 分支里喊 = 其余失败静默留下孤儿（Hub 无删除端点，运维永远看不见）。
      // 诊断只用 error 的**类型名 + PG code**，**绝不落 error.message**（可能回显 SQL/参数）。
      //
      // ⚠️ **claim 冲突不是孤儿**（F1）：它说明该引擎身份已有历史归属（可能是软删项目的
      // 旧 workspace / 并发创建者），此时 disable 会把仍有历史归属的 Hub workspace 置于死地。
      // 预查已尽量在 Hub 调用前拦下；这里是事务内竞态的兜底。
      if (provisioned && !(error instanceof EngineBindingClaimConflict)) {
        // alpha.4 起 best-effort 收口（FEEDBACK-11）：把孤儿置为 disabled——保留记忆/审计、
        // 拒新业务、可被运维**恢复**，比"还活着的孤儿"安全得多。**绝不 throw**：善后失败
        // 只在日志里多一个字段，原 save 错误照常抛（错误路径不变）。
        // ⚠️ 进 disable 前先做**前提复核**（本轮评审 B-1：disable 前提复核）：`provisioned` 非空 ≠ 本地真的没项目——
        //   · 并发同 slug：败者 INSERT 撞 `uq_memory_projects_slug` 时，胜者的行**已经 commit 且可见**
        //     （唯一冲突只可能发生在胜者 commit 之后，READ COMMITTED 下读得到）；无条件 disable
        //     会把胜者正在用的 workspace 置于死地。
        //   · save 在 COMMIT 之后抛错（连接中断/读回执失败）会造出"假孤儿"。
        // 复核见 `disableOrphanWorkspace`：有行/复核失败一律跳过。
        const orphanOutcome = await this.disableOrphanWorkspace(dto.slug);
        if (orphanOutcome.startsWith(DISABLE_SKIP_PREFIX)) {
          // 复核判定"不该 disable"（并发败者 / post-commit 假孤儿，或复核查询失败）⇒ **这不是孤儿**，
          // 走**独立文案 + warn 级**（评审 N1）：ORPHAN WORKSPACE 模板固定写着"本地无项目"并给
          // "运维删/改/重启用 workspace"的处方，套在良性竞态上既自相矛盾、又会诱导运维删掉
          // **胜者的活注册**（把 B-1 的损害从代码层挪到人手里）。
          const reason =
            orphanOutcome === 'disable_skipped:local_row_exists'
              ? 'a local row already exists (concurrent winner / post-commit save error / ' +
                'soft-deleted historical project) — NOT an orphan'
              : 'the local pre-check read FAILED, so the orphan status is UNKNOWN (never disable ' +
                'without confirming absence)';
          logger.warn(
            `ORPHAN CHECK: ${orphanOutcome} slug='${dto.slug}' — ${reason}; no disable issued, ` +
              'NO operator action required' +
              (orphanOutcome === 'disable_skipped:check_failed' ? ' yet' : '') +
              ` (save error: ${describeSaveError(error)}). 非孤儿（或状态未知），未发 disable，` +
              '无需运维处理',
          );
        } else {
          logger.error(
            `ORPHAN WORKSPACE: Hub registration succeeded but the local save failed ` +
              `(${describeSaveError(error)}) — workspace_id='${provisioned.workspaceId}' was ` +
              `registered under idempotency key 'chamber-provision-${dto.slug}' with NO local ` +
              `project. best-effort disable: ${orphanOutcome}. ` +
              'The Hub has no unregister endpoint: this needs OPERATOR SURGERY (remove, re-shape, ' +
              'or RE-ENABLE the workspace on the Hub side). ⚠️ Retrying the SAME slug with a ' +
              'DIFFERENT name is rejected by the Hub (409): the idempotency request digest covers ' +
              'display_name. Retry with the SAME name — but note that it only self-heals while the ' +
              'workspace is NOT disabled; if the best-effort disable above landed, an operator must ' +
              're-enable it first, or pass the engine binding triple explicitly (and do NOT reuse ' +
              'that disabled workspace). slug 冲突已登记孤儿 workspace，需运维处理',
          );
        }
      }
      // 并发窗口：预检与插入之间被别人抢了同名 slug（部分唯一索引 = 最终仲裁者）
      if (isUniqueViolation(error, 'uq_memory_projects_slug')) {
        throw memoryProjectConflict(
          `slug '${dto.slug}' was taken concurrently. Pick another slug and retry once. slug 已被占用`,
        );
      }
      throw error;
    }

    logger.log(
      `memory project created id=${saved.id} slug=${saved.slug} engine=${saved.engine}` +
        (provisioned ? ' (auto-registered)' : ''),
    );
    // save 已 commit ⇒ 可以实算权限（`assertBindingsResolvable` 已要求**每个绑定都可读**，
    // 故这里的 `canReadContent` **恒真 by construction**——是投影口径的完整性要求，
    // 不是一条有效断言；后来者若把它当"权限校验"删掉或依赖它做鉴权都是误读）。
    // ⚠️ 投影在 try **之外**（评审 M-1）：此处任何失败都**不是孤儿**，绝不能触发孤儿善后。
    const access = await this.access.resolveProjectAccess(actor, saved);
    return this.toDto(saved, access, actor);
  }

  /** 更新项目（`PATCH /memory/projects/:id`） */
  async update(
    actor: UnifiedActor,
    projectId: string,
    dto: UpdateMemoryProjectDto,
  ): Promise<MemoryProjectDto> {
    const authorizedProject = await this.findProjectOrThrow(projectId);
    const access = await this.access.resolveProjectAccess(actor, authorizedProject);

    // 写权限口径（见文件头不变量）：admin ｜ creator ｜ ≥1 绑定 write。
    // admin 的 writable 由 Policy 的 admin bypass 承担（resolveProjectAccess 里 can() 已 bypass），
    // 故这里只需三选一，无需单独判 role。
    // **403 不是 409**：无权不是"状态冲突"——与模块写闸门（nominate/retry/recover）同码族
    const canUpdate = access.writable || authorizedProject.createdBy === actor.id;
    if (!canUpdate) {
      throw new ForbiddenException({
        message:
          `You may not update memory project '${projectId}': updating bindings is a privilege ` +
          'change, so it requires being the project creator, an admin, or holding write access ' +
          'on at least one current binding. 无本项目管理权限',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    // 权限与给定资源的解析都在锁外；锁内只核对同一份已授权的 bindings 值快照。
    const authorizedBindings = authorizedProject.bindings.map(({ type, id }) => ({ type, id }));
    const requestedBindings = dto.bindings?.map(({ type, id }) => ({ type, id }));
    if (requestedBindings && requestedBindings.length > 0) {
      await this.assertBindingsResolvable(actor, requestedBindings);
    }
    const saved = await this.projects.manager
      .transaction('READ COMMITTED', async (manager) => {
        const project = await manager.getRepository(MemoryProject).findOne({
          where: { id: projectId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!project) throw memoryProjectNotFound(projectId);
        if (!sameMemoryProjectBindings(project.bindings, authorizedBindings)) {
          throw memoryProjectConflict(
            'Project bindings changed while this PATCH was being authorized. Re-read the project ' +
              'and permissions, then retry. No changes were saved. 项目授权绑定已变化，请重读后重试',
          );
        }
        // 在**任何 mutation 之前**捕获旧三元组：改绑/清空后仍要对旧身份做 best-effort 补 claim
        // （历史项目可能从未有过 claim；旧身份一旦被项目用过，就必须永久占用，即使本次不再使用）。
        const previousBinding = this.completeEngineBindingOf(project);

        // ① 只应用请求显式给定的 delta，绝不把锁前旧实体写回去。
        if (requestedBindings !== undefined) project.bindings = requestedBindings;

        // ② 改名
        if (dto.name !== undefined) project.name = dto.name;

        // ③ 归档
        if (dto.status !== undefined) project.status = dto.status;

        // ④ 引擎绑定（含换绑 409 判定）
        // ⚠️ **值判定，不是 `hasOwnProperty`**：`useDefineForClassFields`（target=ES2022）+
        // ValidationPipe 的 `plainToInstance` 会给**未发送**的字段也定义 own property（值 undefined），
        // `hasOwnProperty` 因此**恒真** ⇒ `engineTouched` 恒真 ⇒ 已绑引擎的项目 PATCH 任何字段
        // （哪怕只改 name）都会撞上"引擎绑定三元组缺一不可"的 400。三列同理，故一律值判定；
        // `undefined` = 未发送（不改），`null` = 显式清空（见 DTO 的 null 三态语义）。
        const engineTouched =
          dto.engine !== undefined ||
          dto.engineWorkspaceId !== undefined ||
          dto.engineActorId !== undefined ||
          dto.engineCredentialRef !== undefined;

        if (engineTouched) {
          const nextEngine = dto.engine ?? project.engine;
          const nextBinding = this.normalizeEngineBinding(
            {
              engineWorkspaceId:
                dto.engineWorkspaceId !== undefined
                  ? dto.engineWorkspaceId
                  : project.engineWorkspaceId,
              engineActorId:
                dto.engineActorId !== undefined ? dto.engineActorId : project.engineActorId,
              engineCredentialRef:
                dto.engineCredentialRef !== undefined
                  ? dto.engineCredentialRef
                  : project.engineCredentialRef,
            },
            nextEngine,
          );

          // 首条耐久账本即固定数据 namespace，不能按可能被并发回执改写的形成态计数。
          // credentialRef 是鉴权引用，可在同一数据身份下轮换；软删账本仍代表已发送的历史。
          const identityChanged =
            nextEngine !== project.engine ||
            nextBinding.workspaceId !== project.engineWorkspaceId ||
            nextBinding.actorId !== project.engineActorId;
          if (
            identityChanged &&
            (await manager.getRepository(MemoryNomination).exists({
              where: { projectId: project.id },
              withDeleted: true,
            }))
          ) {
            throw memoryProjectConflict(
              'The engine/workspace/actor identity is fixed after the first durable ledger row, ' +
                'including pending, failed, withdrawn or deleted rows. Keep this namespace; credentialRef ' +
                'may be rotated. Create a NEW project for another namespace. Existing unknown outcomes ' +
                'still require their original hint/operator recovery; do not bypass them with a new key. ' +
                '已有耐久账本，数据身份不可改绑；凭据引用可轮换，其他空间请新建项目',
            );
          }

          project.engine = nextEngine;
          project.engineWorkspaceId = nextBinding.workspaceId;
          project.engineActorId = nextBinding.actorId;
          project.engineCredentialRef = nextBinding.credentialRef;
        }

        // ⑤ 召回查询原文留存开关（默认 `true` = 内部项目排障刚需，见 `memory-project.entity.ts`）。
        // 值判定同④（`undefined` = 未发送 ⇒ 不改，绝不用 `hasOwnProperty`）；本列 NOT NULL
        // ⇒ **没有** `null` 清空语义，DTO 的 `@IsBoolean()` 已把 null 挡在层 1（铁律 #21）。
        // 只影响**之后新落**的召回遥测行，不回改历史。
        if (dto.retainQueryText !== undefined) project.retainQueryText = dto.retainQueryText;

        // 同一 manager 保持 project → claims 锁序，不嵌套全局事务/借第二连接。
        return this.saveProjectWithEngineClaimRaw(manager, project, {
          previousBinding,
          strictNew: engineTouched,
        });
      })
      .catch(rethrowEngineIdentityConflict);
    // ⚠️ **改绑后必须重算**：方法开头那次 `resolveProjectAccess` 是**变更前**实体的结论
    // （当时绑的可能已被替换成不可读资源，或已被清空）⇒ 直接拿它投影会把过期的权限写进响应。
    // 上面 `canUpdate` 的授权判定继续用**变更前** access（授权看的是"改之前的身份"），两者不可混用。
    const freshAccess = await this.access.resolveProjectAccess(actor, saved);
    return this.toDto(saved, freshAccess, actor);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 在**同一 DB 事务**内落项目并处理引擎身份（见文件头不变量）。
   *
   * 顺序固定：
   * 1. 旧三元组 best-effort 补 claim（DO NOTHING，**不判 owner**）——改绑/清空后旧身份仍永久占用；
   * 2. save 项目；
   * 3. `strictNew=true` 时，对新完整三元组严格回读归属（被别的项目占用 ⇒ 409，事务回滚）。
   *
   * Hub 注册留在事务外（长网络等待不应持有 DB 事务，且孤儿善后语义在事务外更清晰）。
   *
   * @param project 待落库实体（创建时无 id，save 后回填）
   * @param options.previousBinding mutation 前的旧三元组（没有则 null）
   * @param options.strictNew 是否对新三元组做 owner 归属校验（create / 引擎 PATCH = true）
   * @returns 已落库实体
   * @throws 409/14002 新三元组已被**另一个** projectId 永久占用时（事务回滚）
   */
  private async saveProjectWithEngineClaim(
    project: MemoryProject,
    options: { previousBinding?: EngineBindingTriple | null; strictNew?: boolean } = {},
  ): Promise<MemoryProject> {
    return this.projects.manager
      .transaction('READ COMMITTED', (manager) =>
        this.saveProjectWithEngineClaimRaw(manager, project, options),
      )
      .catch(rethrowEngineIdentityConflict);
  }

  /** 同连接持久化原语：调用方负责最外层事务，不能在已 abort 的事务里翻译后继续查库。 */
  private async saveProjectWithEngineClaimRaw(
    manager: EntityManager,
    project: MemoryProject,
    options: { previousBinding?: EngineBindingTriple | null; strictNew?: boolean },
  ): Promise<MemoryProject> {
    if (options.previousBinding) {
      await this.insertClaimBestEffort(
        manager,
        project.id,
        options.previousBinding,
        project.createdAt,
      );
    }
    const saved = await manager.getRepository(MemoryProject).save(project);
    if (options.strictNew) {
      const binding = this.completeEngineBindingOf(saved);
      if (binding) await this.claimEngineBindingStrict(manager, saved.id, binding);
    }
    return saved;
  }

  /**
   * best-effort 写 claim：`INSERT … ON CONFLICT DO NOTHING`，**不判 owner**。
   *
   * 用途：① 改绑/清空前的旧三元组（旧身份永久占用）；② 非引擎 PATCH 对当前三元组补缺失 claim。
   * 不判 owner 是刻意的——历史重复三元组的"败者"必须能改绑逃生。
   *
   * @param firstClaimedAt 历史项目补录时显式传**项目 createdAt**；不传 = 交给 DB 默认
   *   `now()`（create / 改绑到新三元组的"新占用"语义）。已存在 claim 由 DO NOTHING 保留原值。
   */
  private async insertClaimBestEffort(
    manager: EntityManager,
    projectId: string,
    binding: EngineBindingTriple,
    firstClaimedAt?: Date,
  ): Promise<void> {
    await manager
      .getRepository(MemoryEngineBindingClaim)
      .createQueryBuilder()
      .insert()
      .into(MemoryEngineBindingClaim)
      .values({
        engine: binding.engine,
        engineWorkspaceId: binding.workspaceId,
        engineActorId: binding.actorId,
        engineCredentialRef: binding.credentialRef,
        projectId,
        ...(firstClaimedAt ? { firstClaimedAt } : {}),
      })
      .orIgnore()
      .execute();
  }

  /**
   * 新三元组严格占用：best-effort INSERT 后回读归属；不是本项目 ⇒ 409（事务回滚）。
   *
   * 回读不可省：`ON CONFLICT DO NOTHING` 静默成功，只有回读才能区分"本项目"与"别人"。
   */
  private async claimEngineBindingStrict(
    manager: EntityManager,
    projectId: string,
    binding: EngineBindingTriple,
  ): Promise<void> {
    await this.insertClaimBestEffort(manager, projectId, binding);
    const claim = await manager.getRepository(MemoryEngineBindingClaim).findOne({
      where: {
        engine: binding.engine,
        engineWorkspaceId: binding.workspaceId,
        engineActorId: binding.actorId,
        engineCredentialRef: binding.credentialRef,
      },
    });
    if (!claim || claim.projectId !== projectId) {
      // ⚠️ 文案**不含任何用户输入 / owner project id**（F3）：workspace/actor 也不回显。
      throw new EngineBindingClaimConflict();
    }
  }

  /**
   * 自动注册前预查派生三元组是否已被永久占用（claim + withDeleted 历史项目）。
   *
   * 软删项目同 slug 重放时，Hub 会按 `chamber-provision-<slug>` 重放既有登记；若先注册再落库，
   * claim 冲突回滚后的孤儿善后会把仍有历史归属的 workspace 误 disable。故必须在 Hub 调用前拦截。
   */
  private async assertDerivedBindingClaimFree(slug: string): Promise<void> {
    const binding: EngineBindingTriple = {
      engine: MEMORY_ENGINE.HUMENT,
      workspaceId: slug,
      actorId: HUMENT_PROVISIONING_ACTOR_ID,
      credentialRef: buildProvisioningCredentialRef(slug),
    };
    const claim = await this.projects.manager.getRepository(MemoryEngineBindingClaim).findOne({
      where: {
        engine: binding.engine,
        engineWorkspaceId: binding.workspaceId,
        engineActorId: binding.actorId,
        engineCredentialRef: binding.credentialRef,
      },
    });
    if (claim) throw new EngineBindingClaimConflict();

    // 迁移前 / claim 缺失的 withDeleted 历史行兜底（同一派生三元组）
    const historical = await this.projects.findOne({
      where: {
        slug,
        engine: binding.engine,
        engineWorkspaceId: binding.workspaceId,
        engineActorId: binding.actorId,
        engineCredentialRef: binding.credentialRef,
      },
      withDeleted: true,
    });
    if (historical) throw new EngineBindingClaimConflict();
  }

  /** 完整非 `none` 三元组（否则 null）；只做读取，不改写标识符 */
  private completeEngineBindingOf(
    project: Pick<
      MemoryProject,
      'engine' | 'engineWorkspaceId' | 'engineActorId' | 'engineCredentialRef'
    >,
  ): EngineBindingTriple | null {
    if (project.engine === MEMORY_ENGINE.NONE || !this.hasCompleteEngineBinding(project)) {
      return null;
    }
    return {
      engine: project.engine,
      workspaceId: project.engineWorkspaceId as string,
      actorId: project.engineActorId as string,
      credentialRef: project.engineCredentialRef as string,
    };
  }

  /** 逐个绑定校验（存在 + 未软删 + 可读）；任一不通过 → 400 指名字段 */
  private async assertBindingsResolvable(
    actor: UnifiedActor,
    bindings: MemoryBinding[],
  ): Promise<void> {
    for (const binding of bindings) {
      const problem = await this.access.describeUnreadableBinding(actor, binding.type, binding.id);
      if (problem) {
        throw new BadRequestException({
          message:
            `${problem}. Bind only resources you can read (they become the permission source of ` +
            'this project). bindings[i] 字段错误',
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
    }
  }

  /**
   * 自助开通：调 Hub operator 面注册 workspace/binding，成功返回**派生三键**。
   *
   * 失败一律翻成 503 `MEMORY_UNAVAILABLE(14000)`（reason 按失败类型分四值，见文件头不变量）；
   * **本方法抛出前不写库**——`save` 尚未被调用，本地零副作用。
   *
   * @param slug 项目 slug（= Hub `project_id` / `workspace_id`）
   * @param displayName 项目展示名（DTO 的 `name`；客户端 trim 后作为注册体可选 `display_name`）
   * @returns 派生三键（与 `normalizeEngineBinding` 同形，便于统一落库）
   */
  private async provisionEngineBinding(
    slug: string,
    displayName: string,
  ): Promise<{
    workspaceId: string;
    actorId: string;
    credentialRef: string;
  }> {
    // `this.provisioning` 由调用方保证非 null（`autoProvision` 判据里已查）
    const result = await this.provisioning!.provision(slug, displayName);
    if (!result.ok) {
      const failure = result.failure;
      // 日志只落**我们自己的固定文案 + 标量**（code/status/request id），不含 socket/cookie/注册体。
      // ⚠️ Hub 给的两个标量（engineCode / requestId）**经 sanitizeLogValue 净化**再插值（评审 N-4）：
      // 它们是上游可控串，不净化就能凭 `\n` 伪造日志行 / 凭超长值刷屏。
      // `slug` 不必净化——它已被 DTO 的 `^[a-z0-9][a-z0-9._-]*$` 限定（无换行面）。
      logger.error(
        `memory provisioning FAILED slug=${slug} kind=${failure.kind}` +
          (failure.httpStatus !== undefined ? ` httpStatus=${failure.httpStatus}` : '') +
          (failure.engineCode ? ` engineCode=${sanitizeLogValue(failure.engineCode)}` : '') +
          (failure.requestId ? ` requestId=${sanitizeLogValue(failure.requestId)}` : '') +
          (failure.mayHaveLanded ? ' mayHaveLanded=true' : '') +
          ` — ${failure.message}`,
      );
      throw memoryUnavailable(this.provisioningFailureReason(failure), {
        engineCode: failure.engineCode,
      });
    }
    // ⚠️ **Hub 返回值同样过字符集闸门**（plan D7）：越界标识符一旦落库，后续引擎调用都会
    // 打到不存在的 workspace/actor/credential。**fail-closed 拒绝、禁止改写/截断**（改写 =
    // 指向另一个同样不存在的地方，比不校验更危险）。此时 Hub 侧已登记 ⇒ 日志必须说清"需要
    // 运维对账"，且**不**做 best-effort 收口（`save` 尚未发生，本地零副作用）。
    if (
      !MEMORY_ENGINE_IDENTIFIER_PATTERN.test(result.value.workspaceId) ||
      !MEMORY_ENGINE_IDENTIFIER_PATTERN.test(result.value.actorId) ||
      !MEMORY_ENGINE_IDENTIFIER_PATTERN.test(result.value.credentialRef)
    ) {
      logger.error(
        `memory provisioning REJECTED slug=${slug} — hub returned an engine identifier outside ` +
          '^[A-Za-z0-9._:-]{1,128}$ (value omitted on purpose). Nothing was saved in Chamber; ' +
          'the workspace registration on the hub must be reconciled by an operator ' +
          '(re-register with a valid id, or pass the engine binding triple explicitly).',
      );
      throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.PROVISIONING_FAILED);
    }
    // 成功信号：`replay=true` 说明**这个 slug 之前就登记过**（幂等重放）——排障时能区分
    // "本次真的建了"与"复用了既有登记"（评审 N-5：replay 必须有消费者）
    logger.log(
      `memory provisioning OK slug=${slug} replay=${result.value.replay} ` +
        `workspaceId=${result.value.workspaceId}`,
    );
    return {
      workspaceId: result.value.workspaceId,
      actorId: result.value.actorId,
      credentialRef: result.value.credentialRef,
    };
  }

  /**
   * 孤儿 workspace 的 best-effort 善后：**前提复核通过后**调 `disableProject` 把 Hub 侧已登记
   * 但本地确实无行的项目置为 `disabled`。
   *
   * 语义（alpha.4 FEEDBACK-11）：disabled 保留记忆/审计、拒新业务、重启保持、**可被运维恢复**
   * ——比"还活着的孤儿"安全得多。四条纪律：
   * ① **先复核再动手**（评审 B-1）：`findOne({slug, deletedAt: IsNull()})` 命中本地行 ⇒ 这不是
   *    孤儿（并发败者 / save 在 COMMIT 后抛错的假孤儿）⇒ **跳过 disable**，返回
   *    `disable_skipped:local_row_exists`。判据成立的理由：23505 只可能发生在胜者 commit 之后，
   *    READ COMMITTED 下这条读得到。
   * ② **复核查询自身失败也必须跳过**（`disable_skipped:check_failed`）：宁可留一个孤儿等运维，
   *    也绝不因为"查不出来"就去 disable 一个可能正在服务的项目（不可逆误伤 >> 孤儿成本）。
   * ③ **绝不 throw**：客户端本身 never-throw，善后失败只返回一个**日志字段**
   *    （`disabled` / `disabled(replayed-receipt)` / `disable_failed:<分类>` /
   *    `disable_skipped:<原因>`），原 save 错误照常抛——错误路径**绝不**被善后改变。
   * ④ 日志只带**分类名**（我们自己的枚举），不带上游 message 原文、不带 cookie/code 值。
   *
   * @param slug 项目 slug（= Hub `project_id`）
   * @returns 日志字段值（见上；`disable_skipped:*` = 复核判定"不该 disable"）
   */
  private async disableOrphanWorkspace(slug: string): Promise<string> {
    // ①/② 前提复核：只有"确认本地无行"才允许 disable（见方法注释的 B-1 论证）
    let localRowExists: boolean;
    try {
      // ⚠️ **必须覆盖 withDeleted**（F1）：软删项目仍是"历史归属"——同 slug 重放时
      // Hub 的 workspace 可能仍属于它，disable 会把有历史记忆/审计的 workspace 置于死地。
      // 任何本地行（含软删）都视为"不是孤儿"，跳过 disable。
      const localRow = await this.projects.findOne({ where: { slug }, withDeleted: true });
      localRowExists = localRow !== null;
    } catch {
      // 复核查询失败 ⇒ 宁可留孤儿，不可误伤活项目（不落 error.message）
      return `${DISABLE_SKIP_PREFIX}check_failed`;
    }
    if (localRowExists) return `${DISABLE_SKIP_PREFIX}local_row_exists`;

    // 客户端承诺 never-throw；善后路径**再兜一层**——任何意外也不许顶替 create 的原报错
    try {
      const result = await this.provisioning!.disableProject(slug);
      if (!result.ok) return `disable_failed:${result.failure.kind}`;
      // `replay:true` = Hub 回放的是**同 key 的历史 receipt**（该命令此前已落地），不是本次执行。
      // 读法（评审 S-1）：它代表**该命令曾在某刻**把这个项目置为 disabled；
      // 但它**不代表项目当前实时状态**——运维 re-enable 之后同 key 重放仍回 `replay:true` 而
      // 项目其实是活的。运维看到这个字段要**去 GET 一次实时状态**，不要当作"现在也是 disabled"。
      return result.value.replay ? 'disabled(replayed-receipt)' : 'disabled';
    } catch (err: unknown) {
      // 只取构造器名（错误类型名），**不取 message**（可能回显上游原文）
      const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? 'Error';
      return `disable_failed:${name}`;
    }
  }

  /**
   * provision 失败分类 → `MEMORY_UNAVAILABLE` 的 reason（值域单源 = shared）。
   *
   * 判据（见文件头不变量）：
   * ① **`mayHaveLanded` 优先**——登记可能已落 Hub，唯一正确的措辞是"同 slug 同参重试安全"，
   *    即 `provisioning_timeout`（评审 S-4：把它说成 `unavailable`（"未到达"）会让调用方
   *    以为"重试必然安全、Hub 上没有残留"，而实际可能已经登记）；
   * ② 超时 = 无回执（可能已登记）；
   * ③ 不可达 = 请求未到达（**只可能出现在从未见过 202 的路径上**）；
   * ④ http 409 = Hub 侧登记元组与本次意图不一致（运维面）；
   * ⑤ 其余 = operator 面错误。
   */
  private provisioningFailureReason(failure: HumentProvisioningFailure): MemoryUnavailableReason {
    if (failure.mayHaveLanded) return MEMORY_UNAVAILABLE_REASON.PROVISIONING_TIMEOUT;
    if (failure.kind === 'timeout') return MEMORY_UNAVAILABLE_REASON.PROVISIONING_TIMEOUT;
    if (failure.kind === 'unreachable') return MEMORY_UNAVAILABLE_REASON.PROVISIONING_UNAVAILABLE;
    if (failure.httpStatus === 409) return MEMORY_UNAVAILABLE_REASON.PROVISIONING_CONFLICT;
    return MEMORY_UNAVAILABLE_REASON.PROVISIONING_FAILED;
  }

  /**
   * 归一化引擎绑定三元组（一致性见文件头不变量）。
   *
   * @param input 三列候选值（`null` = 清空；`undefined` = 未给）
   * @param engine 目标引擎名
   * @returns 三列最终值（`engine=none` 时全 null）
   */
  private normalizeEngineBinding(
    input: {
      engineWorkspaceId?: string | null;
      engineActorId?: string | null;
      engineCredentialRef?: string | null;
    },
    engine: MemoryEngine,
  ): { workspaceId: string | null; actorId: string | null; credentialRef: string | null } {
    if (engine === MEMORY_ENGINE.NONE) {
      // engine=none ⇒ 三列强制 null（"没有半配置状态"）
      return { workspaceId: null, actorId: null, credentialRef: null };
    }

    // ⚠️ **`engineWorkspaceId` 不 trim**（标识符只校验、永不改写 —— plan §5 三方收敛项）：
    // 空白串（`''` / 全空白）视同"未给"⇒ null（与 `isBlankEngineField` 同口径；那是**归一**
    // 不是改写——没有标识符被改动）；**非空白**值原样送下面的字符集闸门 ⇒ `" ws1 "` 因含空格
    // 被 fail-closed 拒绝，而不是被静默修剪成 `ws1` 落库（后者 = 引擎调用打到一个不存在的
    // workspace）。actorId / credentialRef 的 trim 保留：它们是 DTO 侧的历史约定，且不参与
    // workspace 寻址。
    const workspaceIdRaw = input.engineWorkspaceId ?? null;
    const workspaceId =
      workspaceIdRaw !== null && workspaceIdRaw.trim() === '' ? null : workspaceIdRaw;
    const actorId = input.engineActorId?.trim() || null;
    const credentialRef = input.engineCredentialRef?.trim() || null;

    // 引擎绑定三元组缺一不可——缺了就 400 指名字段（而不是"先存着以后补"）
    if (!workspaceId) throw this.engineBindingFieldError('engineWorkspaceId', engine);
    if (!actorId) throw this.engineBindingFieldError('engineActorId', engine);
    if (!credentialRef) throw this.engineBindingFieldError('engineCredentialRef', engine);

    // 三列都是**引擎标识符**：只校验字符集、**永不改写/截断**（铁律 #21 双层校验——
    // **创建与改绑**两个 DTO 都带同一正则的 `@Matches`，这里是服务层第二道，覆盖直呼 service
    // 的调用方）。越界值一旦落库，后续引擎调用会打到不存在的 workspace/actor/credential，
    // 症状是"引擎每次都 403/404"（plan D7 / §5）。
    this.assertEngineIdentifier('engineWorkspaceId', workspaceId);
    this.assertEngineIdentifier('engineActorId', actorId);
    this.assertEngineIdentifier('engineCredentialRef', credentialRef);

    // 凭据引用形态闸门（KEY_SHAPED）：防把真 key 当引用名落库（会随投影回显给读权限者）
    if (!isSafeCredentialRef(credentialRef)) {
      throw new BadRequestException({
        message:
          'engineCredentialRef looks like a REAL credential (apikey_/sk_ prefix). It must be a ' +
          'non-secret reference NAME resolved by the engine side — never the secret itself ' +
          '(project projections echo this column to every reader). 凭据引用不是机密',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    return { workspaceId, actorId, credentialRef };
  }

  /** 引擎标识符字符集闸门（三列同一份正则；失败 400 指名字段） */
  private assertEngineIdentifier(
    field: 'engineWorkspaceId' | 'engineActorId' | 'engineCredentialRef',
    value: string,
  ): void {
    if (MEMORY_ENGINE_IDENTIFIER_PATTERN.test(value)) return;
    throw new BadRequestException({
      message:
        `${field} may only contain A-Z a-z 0-9 . _ : - (1-128 chars). It is an identifier and ` +
        'is never rewritten — send the exact value the engine uses. ' +
        `${field} 字段错误`,
      code: ErrorCode.VALIDATION_ERROR,
      data: { field },
    });
  }

  /** 引擎绑定字段缺失的 400（指名字段 + 逃生阀） */
  private engineBindingFieldError(field: string, engine: MemoryEngine): BadRequestException {
    return new BadRequestException({
      message:
        `${field} is required when engine='${engine}': the engine binding is a triple ` +
        '(engineWorkspaceId + engineActorId + engineCredentialRef) and a partial binding would ' +
        "silently look configured. Send all three, or use engine='none' to keep the project " +
        'local-only (Chamber stays fully usable without an engine). 引擎绑定三元组缺一不可',
      code: ErrorCode.VALIDATION_ERROR,
      data: { field },
    });
  }

  /**
   * 实体 → 对外投影。
   *
   * @param project 项目实体
   * @param access 调用者对该项目的**访问结论**（`canReadContent` 的来源）。必须传**本次请求
   *   实算**的值：`update` 改绑后旧结论已过期（见 `update` 的注释），`create` 恒真 by construction。
   */
  private toDto(
    project: MemoryProject,
    access: MemoryProjectAccess,
    actor: UnifiedActor | null,
  ): MemoryProjectDto {
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      bindings: (project.bindings ?? []).map((binding) => ({ type: binding.type, id: binding.id })),
      engine: project.engine,
      engineWorkspaceId: project.engineWorkspaceId,
      engineActorId: project.engineActorId,
      engineCredentialRef: project.engineCredentialRef,
      status: project.status,
      // 召回原文留存开关（默认 true）：**开关可见、原文不可见**——原文列 select:false
      // 且零 API 读取面（见 memory-recall-event.entity.ts 的 [关键不变量]）
      retainQueryText: project.retainQueryText,
      createdBy: project.createdBy,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      engineAvailability: this.engineAvailability(project),
      // 内容读权限**逐请求实算**（同源 = `assertProjectContentRead` 的判据，见 memory-access）；
      // 只暴露"这个调用者此刻能不能读正文"，不暴露绑定明细（`resolved[]` 是内部排障面）
      canReadContent: access.readable,
      // Usage 读面权限：admin 或「非空且每条绑定都可读」——**不是** canReadContent 的
      // any-binding 判据（见 memory-access.canReadMemoryUsage）。共享/claim 的 409 不在此列。
      canReadUsage: canReadMemoryUsage(actor, access),
    };
  }
}

// ⚠️ 这里曾有一个 `hasOwn()` 辅助函数（`Object.prototype.hasOwnProperty.call`），用于区分
// "字段缺席 = 不改" 与 "显式 null = 清空"。它在 `useDefineForClassFields`（target=ES2022）+
// ValidationPipe transform 下**恒真**（未发送的字段也是 own property，值 undefined），
// 已删除；判别改用值判定（见 update() 的注释与该文件头不变量）。

/** Postgres 23505 + 约束名判定 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pg = error as { code?: string; constraint?: string };
  return pg?.code === '23505' && pg?.constraint === constraint;
}

/**
 * save 失败的**安全诊断描述**（类型名 + PG code；**绝不取 `error.message`**）。
 *
 * rationale：`save` 的错误可能是 TypeORM/PG 原样透出的（含 SQL 片段与参数值）。孤儿告警要
 * 说清"是什么失败"，但那句话不需要错误原文——`QueryFailedError/23505` 已经足够排障，
 * 而错误原文可能把注册体（含 credential_ref）写进长期保留的启动日志。
 *
 * @param error 任意错误
 * @returns 形如 `QueryFailedError/23505` 或 `Error`
 */
function describeSaveError(error: unknown): string {
  const shaped = error as { code?: unknown; constructor?: { name?: string } };
  const name = shaped?.constructor?.name ?? 'Error';
  return typeof shaped?.code === 'string' ? `${name}/${shaped.code}` : name;
}

/**
 * 引擎绑定字段是否「未给」（`null` / `undefined` / 空串 / 纯空白）。
 *
 * rationale：与 `normalizeEngineBinding` 的 `?.trim() || null` **同口径**——若这里按
 * `!== undefined` 判"给了"，用户传 `engineWorkspaceId: ""` 时会被判成"部分缺"而落 400
 * （见文件头踩坑 MEMORY-BLANK-TRIPLE）。
 *
 * @param value DTO 的三键候选值
 * @returns true = 视同未给
 */
function isBlankEngineField(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

/** bindings 是权限集合：比较 type/id 值，忽略对象键序与列表排列，不依赖 jsonb 字面序列化。 */
export function sameMemoryProjectBindings(
  left: readonly MemoryBinding[],
  right: readonly MemoryBinding[],
): boolean {
  const key = (binding: MemoryBinding): string => `${binding.type}:${binding.id}`;
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 只在最外层事务完成回滚后翻译；目标唯一冲突与永久 claim 冲突共用“不 disable”分类。 */
function rethrowEngineIdentityConflict(error: unknown): never {
  if (isUniqueViolation(error, 'uq_memory_projects_engine_triple'))
    throw new EngineBindingClaimConflict();
  throw error;
}
