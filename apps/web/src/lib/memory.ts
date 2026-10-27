/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory（Hument 集成一期）web 只读视图的**契约翻译层**：响应形状镜像 +
 *     枚举→展示值域映射 + 引擎不可用文案分叉 + 归属三态复用
 *
 * [代码职责]
 *   - 把后端 `modules/memory/dto/memory-contract.ts` 的**响应形状**逐字镜像成本文件的
 *     TS 接口（web 不能 import backend 包；镜像漂移的表现 = 静默读到 undefined）
 *   - 把后端枚举/原因码翻译成**展示层可直接消费的稳定值**（Badge 变体 / 文案分叉键），
 *     不含任何 JSX（本文件零 React 依赖，可被页面、组件与单测共同引用）
 *   - **引擎投影读面**（第九节）：hument 四读面（graph / detail / history / representation）
 *     的响应镜像 + 节点/边视觉字面量池 + 累积页合并 + views 族错误分叉。该族**逐字透传**
 *     （snake_case），与本文件上半部分（账本族，camelCase 归一）是两个面，别互相套用
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §3（工具类红线）/§4（Badge 七变体）/§5（动效）
 *     + §6.2（关系边配色与线型登记）
 *   - 合同源: apps/backend/src/modules/memory/dto/memory-contract.ts（响应形状唯一真相源）
 *              + apps/backend/src/modules/memory/memory.constants.ts（分页/摘要常量）
 *              + apps/backend/src/modules/memory/engines/memory-engine.interface.ts
 *                （四读面的 `Hument*` 形状 = 第九节的镜像源）
 *              + packages/shared/src/enums/index.ts（Memory 族值域单源，含四读面 8 组）
 *   - 实现蓝本: Memory web 二期 plan v2.1 §1 决策表（D1/D6/D8/D9/D11）+ §5 四十八条 UX 清单
 *              + 关系图批次 plan §4.1/§4.2（四读面消费纪律）
 *
 * [关键不变量]
 *   - **`metadata` 档行"没有那个键"而不是"键为 null"**：`projection === 'metadata'` 的行
 *     整体缺席 full 档字段，故判定必须用 `in`/`hasOwnProperty`（`memoryHasField`），
 *     **禁止**用 `=== undefined` 之外的手法猜（`!== null` 会把"缺席"与"为空"混为一谈）。
 *   - **`contentExcerpt` 空串 ≠ 无摘要**：空串是"后端抽不出摘要"的显式值，渲染退路是
 *     空态文案；而**截断与否由 `MEMORY_EXCERPT_TRUNCATION_MARKER` 尾标体现**，与行级
 *     `contentTruncated`（形成时摘录区被 8192 字节闸门截掉的**落库事实**）**无关**——
 *     卡片截断一律不读不写 `contentTruncated`（plan §5 第 46 条）。
 *   - **归属三态复用 `experienceActorLabel`**：软删保留真名 + 「已删除」小字、无名字退
 *     id 前 8 位、双缺失整行隐藏。本文件只加一层 `system` 哨兵分叉（`nominatorType=
 *     'system'` 时后端刻意给 null 名字，显示名要**按语言**渲染，故由前端出静态文案）。
 *   - **引擎不可用文案只有一个映射源**（`memoryUnavailableReasonKind`）：项目/列表响应里
 *     的 `engineAvailability.reason` 与 runtime 503 `data.reason` **共用**它，禁两处各写一份
 *     （plan §5 第 25 条）。
 *   - **Tailwind 类名必须是静态字面量**：`bg-${hue}-500/15` 不生成 CSS 且零报错，
 *     故 category 配色只能从下面的常量数组里取（plan §5 第 9 条）。
 *   - **`score` 是"词面排序权重"不是"置信度"**：仅同次召回内可比、跨查询/项目不可比、原值
 *     透传不归一化；展示守卫 = `memoryRecallScoresInformative`（缺值/全同值抑制主列表）
 *     + `memoryRecallItemScore`（单条缺值时只不渲染行尾元素）。调试区**恒显原值**（不映射）。
 *   - **`canReadContent` 是项目级**、与行级来源可见性是**两件事**（有意分工）；`provisioningAvailable`
 *     是**部署级**、三态读法 `undefined/false → 不可用`（见 `memoryProvisioningAvailable`）。
 *
 * [关联代码]
 *   - ./api.ts — memory 命名空间（本文件类型是它的返回形状）
 *   - ./experience.ts — `experienceActorLabel`（归属三态唯一实现，本文件复用）
 *   - ../components/memory/* — 卡片/搜索条/徽章/引擎灯（本文件展示映射的消费方）
 *   - ../app/(main)/memory/page.tsx 与 [id]/page.tsx — 列表与详情（D6/D8 的落点）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认改动符合设计意图与 plan 决策表
 *   □ 改响应形状必须同步 apps/backend/src/modules/memory/dto/memory-contract.ts 与单测
 *   □ 新增 Tailwind 类名必须是静态字面量（禁模板拼接）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  ActorType,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  MEMORY_RECALL_EMPTY_REASON,
  MEMORY_UNAVAILABLE_REASON,
  MEMORY_VIEW_LADDER_STATE,
  MEMORY_VIEW_MEMORY_KINDS,
  MEMORY_VIEW_MEMORY_STATUS,
  MEMORY_VIEW_RELATION_TYPES,
  MEMORY_VIEW_RESOLUTIONS,
  type MemoryBindingType,
  type MemoryEngine,
  type MemoryFormationState,
  type MemoryNominationStatus,
  type MemoryProjectStatus,
  type MemoryRecallEmptyReason,
  type MemorySourceReadTool,
  type MemorySourceRefType,
  type MemoryUnavailableReason,
  type MemoryViewLadderState,
  type MemoryViewMemoryKind,
  type MemoryViewRelationType,
} from '@agent-chamber/shared';
import { experienceActorLabel, type ExperienceActorLabel } from './experience';

// ═══════════════════════════════════════════════════════════════════════
// 一、常量镜像（后端 memory.constants.ts 单源的 web 副本）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 账本列表默认每页条数（backend `MEMORY_DEFAULT_PAGE_SIZE`）
 *
 * 语义提醒：后端分页是**内存 slice**，`total` 是**裁剪前全量行数**（不随 pageSize 变化），
 * 故它同时是 tab 计数的权威来源与截断检测依据。
 */
export const MEMORY_DEFAULT_PAGE_SIZE = 20;

/** 账本列表每页条数上限（backend `MEMORY_MAX_PAGE_SIZE`；query DTO 也以它封顶） */
export const MEMORY_MAX_PAGE_SIZE = 100;

/**
 * 摘要截断标记（backend `MEMORY_EXCERPT_TRUNCATION_MARKER`）
 *
 * 用途：卡片摘要是"展示截断"产物，带尾标时向读者点明"这条摘要不全"。
 * **不要**把它与行级 `contentTruncated` 混用（见文件头不变量）。
 */
export const MEMORY_EXCERPT_TRUNCATION_MARKER = '[truncated]';

/**
 * 召回查询词长度上限（backend recall DTO `QUERY_MAX_LENGTH = 16384`，取自 Hument 合同）
 *
 * 用途：搜索框 `maxLength`。刻意**不另设更严的 UI 闸门**——平台不二次收紧合同上限
 * （后端 DTO 注释：收紧会让"我明明按合同传了"变成静默裁剪）。
 */
export const MEMORY_RECALL_QUERY_MAX_LENGTH = 16384;

/**
 * 语义召回每次请求的条数预算（plan §5 第 11/14 条：UI 承诺"最多 20 条"）
 *
 * 后端 DTO 允许到 128，但 web 视图是有界卡片面，故**显式**取 20 并把它写进界面承诺——
 * 承诺与实际请求参数同源，改这里就同时改了文案里的数字。
 */
export const MEMORY_RECALL_MAX_ITEMS = 20;

/**
 * `contextIdentity` 长度上限（backend recall DTO `@Length(1, 256)`）
 *
 * 形态：`web:user:<userId>:project:<projectId>`——**禁塞用户正文**（它会被引擎用于 digest）。
 */
export const MEMORY_CONTEXT_IDENTITY_MAX_LENGTH = 256;

/**
 * 召回 `contextEpoch` 的上限（backend `MEMORY_CONTEXT_EPOCH_MAX = 1_000_000_000`）。
 *
 * 来源是**引擎运行时行为**而不是它的 schema（`recall-request.schema.json` 只声明了
 * `minimum: 0`，`maximum` 缺失——漂移已反馈上游）。web 侧镜像它的唯一用途是
 * `memoryContextEpoch()` 的钳位与测试断言；**改一侧必须同步另一侧**。
 */
export const MEMORY_CONTEXT_EPOCH_MAX = 1_000_000_000;

/**
 * 召回 `contextEpoch` 的取值基准（2026-01-01T00:00:00Z，**Unix 秒**）。
 *
 * 与 `memoryContextEpoch()` 配对：引擎只接受 `0..1e9` 的**相对**纪元，
 * 故 web 侧自定一个基准把"当前时刻"映射进合法区间。
 */
export const MEMORY_EPOCH_ORIGIN = 1767225600;

/**
 * 取本次召回的上下文世代（`contextEpoch`）= **距基准的整秒数**。
 *
 * 三条 rationale（缺一条都会选错取值方式）：
 *
 * 1. **引擎的硬上限是 1e9，而"当前时间"怎么切都超**：hument 运行时拒 `> 1_000_000_000`
 *    （dev 走查实证：1e9 → 200、1_000_000_001 → 400 `invalid_argument`；schema 只声明了
 *    `minimum` 没写 `maximum`，是 schema/运行时漂移，已反馈上游）。毫秒 `Date.now()`
 *    ≈ 1.76e12、**Unix 秒 ≈ 1.76e9 同样超标** ⇒ 绝对时间不是候选，必须是相对量。
 *    后端 `MEMORY_CONTEXT_EPOCH_MAX` 把同一事实挡在 DTO 层（web 传错会当场 400 而不是
 *    503/502——把"参数写错"伪报成"上游崩了"是铁律 #9 明确禁止的）。
 * 2. **D7 要求"每次提交取新值"**：秒级相对纪元当前 ≈ 2.4e7（实测 2026-10），同一秒内唯一、
 *    跨秒必变，天然满足"同词重搜可复现但不复用旧呈现"；1e9 秒 = 自基准起 31.7 年
 *    ⇒ **约 2057 年才撞顶**，远超本功能的生命周期。
 * 3. **跨会话不撞**：引擎按 `(contextIdentity, contextEpoch)` 做呈现去重，而 per-session
 *    自增计数器会**复位到 1**——下一个会话的第 1 次召回就与历史上所有会话的第 1 次同纪元，
 *    去重语义被污染。相对纪元是**单调**的（同一机器上时间只会前进），不会回退撞历史。
 *
 * ⚠️ 精度取舍：同一秒内的两次提交会得到**同一个** epoch。这在 D7 下是可接受的——
 * "每次提交强制打引擎"由客户端 `refetch()` 保证，与 epoch 是否变化无关；epoch 的职责是
 * 上下文归因/去重键，不是请求去重键（同秒重搜本就该归到同一上下文世代）。
 *
 * @returns 0..1e9 的整数（非法区间时钳到上限，见下）
 */
export function memoryContextEpoch(): number {
  const seconds = Math.floor(Date.now() / 1000) - MEMORY_EPOCH_ORIGIN;
  // 系统时钟被拨到基准之前（或基准设置过晚）会给负数，负 epoch 会被 DTO 的 @Min(0) 拒
  // ⇒ 钳到 0（仍是合法值；宁可世代不前进，也不要整页 400）
  if (seconds < 0) return 0;
  // 撞顶（≥1e9，约 2057 年）同样会被 DTO @Max 拒：钳到上限而不是让请求失败——
  // 那时"世代前进"已无意义，保可用性优先
  return Math.min(seconds, MEMORY_CONTEXT_EPOCH_MAX);
}

/**
 * 串链用的每页条数（plan §2 步骤 11：详情页拉该项目**全部**账本行，不带 tab/category 过滤）
 *
 * 取 100（= `MEMORY_MAX_PAGE_SIZE`）：串链要的是"这个项目的取代关系全图"，
 * 翻页次数越少越好。
 */
export const MEMORY_CHAIN_PAGE_SIZE = MEMORY_MAX_PAGE_SIZE;

/**
 * 串链翻页上限（plan §1 D2：cap 5 页）
 *
 * 触顶 ⇒ 链可能不完整，界面必须**显式**渲染「链可能不完整」而不是假装画全了
 * （一个被截断的链会让"现行版本"指向错误节点，是**错误的治理结论**，不只是少画几条）。
 */
export const MEMORY_CHAIN_MAX_PAGES = 5;

/** 链节点数超过它就窄屏退化为纯列表（plan §5 第 29 条：`lg` 以下不画连接线编排） */
export const MEMORY_CHAIN_COMPACT_THRESHOLD = 8;

/**
 * 项目 slug 形态（与后端 `CreateMemoryProjectDto` 的 `SLUG_PATTERN` **逐字一致**）。
 *
 * 前端预校验的唯一用途是**行内即时反馈**（后端仍是最终仲裁者）；两侧正则不许各自演化，
 * 否则会出现"前端说合法、后端 400"的静默错配。
 */
export const MEMORY_PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** 项目名长度上限（后端 `@Length(1, 128)`） */
export const MEMORY_PROJECT_NAME_MAX_LENGTH = 128;

/** 项目 slug 长度上限（后端 `@Length(1, 64)`） */
export const MEMORY_PROJECT_SLUG_MAX_LENGTH = 64;

/**
 * 创建表单「绑定目标」下拉的取数上限（已知限制：只取第一页 100 条）。
 *
 * 与后端列表端点的 `pageSize` 上限一致（`MEMORY_MAX_PAGE_SIZE`）；超过 100 个候选的资源
 * 在表单里选不全 —— 这是**已登记的已知限制**，界面必须写明而不是静默截断。
 */
export const MEMORY_BINDING_TARGET_PAGE_SIZE = MEMORY_MAX_PAGE_SIZE;

/**
 * 单个项目的绑定条数上限（后端 `CreateMemoryProjectDto` 的 `@ArrayMaxSize(20)`）。
 *
 * 后端上限是**防呆**而非方案值（父链解析逐条走，20 远超真实使用：绑定 trio 只占 3 条）。
 * 前端镜像它只为在到达上限时**提前**禁用"添加"并写明原因 —— 不让用户填到 21 条才吃 400。
 * 两侧同改。
 */
export const MEMORY_BINDING_MAX_COUNT = 20;

/** 引擎绑定三键的字段名（与后端 400 `data.field` 的值域对齐，用于错误翻人话） */
export const MEMORY_ENGINE_BINDING_FIELDS = [
  'engineWorkspaceId',
  'engineActorId',
  'engineCredentialRef',
] as const;

/** 引擎绑定三键字段名类型 */
export type MemoryEngineBindingField = (typeof MEMORY_ENGINE_BINDING_FIELDS)[number];

// ═══════════════════════════════════════════════════════════════════════
// 二、响应形状镜像（逐字对齐 backend dto/memory-contract.ts）
// ═══════════════════════════════════════════════════════════════════════

/** 绑定条目（实体 `MemoryBinding` 同形：类型 + 资源 id；web 本批不消费，仅保形） */
export interface MemoryBinding {
  type: MemoryBindingType;
  id: string;
}

/**
 * 引擎可用性块（本地数据端点 200 时嵌入）。
 *
 * ⚠️ 命名偏离方案字面：项目投影本身已有 `engine` 列，同名会撞车，故块名不同、列值在内。
 */
export interface MemoryEngineAvailability {
  /** 项目 `engine` 列（`none` = 本项目未绑引擎） */
  engine: MemoryEngine;
  /** 引擎动词当前可用 */
  available: boolean;
  /** 不可用原因（可用时 `null`） */
  reason: MemoryUnavailableReason | null;
}

/** 项目注册表投影（`GET /memory/projects*`） */
export interface MemoryProjectDto {
  id: string;
  slug: string;
  name: string;
  bindings: MemoryBinding[];
  engine: MemoryEngine;
  engineWorkspaceId: string | null;
  engineActorId: string | null;
  engineCredentialRef: string | null;
  /**
   * 项目生命周期（`active` / `archived`）。
   *
   * 值域单源 = shared `MEMORY_PROJECT_STATUSES`（引用类型而不是写字面量联合：
   * 后端新增取值时前端会**编译期**发现，而不是静默落到 `default` 分支）。
   */
  status: MemoryProjectStatus;
  /** 召回查询原文留存开关（只暴露开关，不暴露原文列） */
  retainQueryText: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  engineAvailability: MemoryEngineAvailability;
  /**
   * 调用者对**本项目内容面**的读权限（= 后端 `resolveProjectAccess().readable`，与内容闸门同源）。
   *
   * - `admin` **恒 true**（bypass 设计：管理面必须能读遍全站）；
   * - `create` 路径恒真 *by construction*（绑定全可读才建得成）；
   * - `false` = 每个绑定都不可读 ⇒ 召回 / 详情 / 正文类字段关闭，但治理观察者仍可读元数据。
   *
   * ⚠️ **项目级可读性 ≠ 行级来源可见性**：行级降级（某条来源已不可见）由卡片锁态行承担，
   * 与本字段是两件事（有意分工，勿当 bug 抹平）。本字段只驱动"项目级"的标注与搜索预置禁用。
   */
  canReadContent: boolean;
  /**
   * 调用者对**本项目 Usage 读面**的权限（admin 或「非空且每条绑定都可读」）。
   *
   * ⚠️ **与 `canReadContent` 不是同一个判据**：内容面是"≥1 绑定可读"，Usage 是项目级
   * 引擎聚合（不做逐来源过滤），要求**全部**绑定可读。本字段**不包含**共享/历史占用的
   * fail-closed 判定（端点级 409/14006），`true` 只表示"权限允许调用"。
   */
  canReadUsage: boolean;
}

/**
 * 项目列表信封。
 *
 * `provisioningAvailable` 是**部署级**字段（不是项目级）：来源 = 后端 provisioning client
 * 是否装配。**三态读法**：`undefined` / `false` 一律按"不可用"处理（默认不承诺自助开通，
 * 前端不得把缺失当可用）——只有显式 `true` 才按可用渲染。
 */
export interface MemoryProjectListResponse {
  items: MemoryProjectDto[];
  total: number;
  page: number;
  pageSize: number;
  /** 部署级自助开通开关（缺失/`false` ⇒ 前端按不可用） */
  provisioningAvailable: boolean;
}

/**
 * 创建项目入参（`POST /memory/projects`）。
 *
 * 引擎三键语义（后端 create DTO 的三分支）：`engine=hument` 且**三键全缺** ⇒ 部署启用自助
 * 开通时自动在 Hub 注册；**全显式** ⇒ 手工复用已有 workspace；**部分缺** ⇒ 400。
 * `engine=none`（或省略）⇒ 纯本地账本，三键一律不发送。
 */
export interface MemoryCreateProjectInput {
  slug: string;
  name: string;
  /** 创建时 ≥1（后端 `@ArrayNotEmpty`；本批表单只选一条） */
  bindings: MemoryBinding[];
  engine?: MemoryEngine;
  engineWorkspaceId?: string;
  engineActorId?: string;
  engineCredentialRef?: string;
}

/**
 * 账本行投影（列表与详情共用）。
 *
 * `projection === 'metadata'`（治理观察者）时，**本接口下列所有 full 档字段整体缺席**
 * （不是 null）——判定用 `memoryHasField`，禁靠 null 猜。
 */
export interface MemoryNominationDto {
  /** 投影档位（full = 全源可见的完整投影；metadata = 治理白名单降级投影） */
  projection: 'full' | 'metadata';
  // ─── 治理白名单字段（两档都有） ───
  id: string;
  category: string;
  formationState: MemoryFormationState;
  status: MemoryNominationStatus;
  /** 提名者 actor（服务 actor，不落用户身份） */
  nominatorId: string;
  nominatorType: string;
  /** 提名者显示名（**三态**：有名直出 / system 哨兵 / 真孤儿 → 见 memoryNominatorLabel） */
  nominatorName: string | null;
  /** 提名者软删时间（未删/无档案恒 null；与名字成对透出） */
  nominatorDeletedAt: string | null;
  /** 所属记忆项目 id（两档都有——详情端点非嵌套路径，靠它归位与校验 `?project=`） */
  projectId: string;
  /** 本行更正的是哪条账本行（两档都有；`null` = 独立新主张） */
  correctionOf: string | null;
  reviewAt: string | null;
  createdAt: string;
  updatedAt: string;
  // ─── 仅 full 档（降级时整个键缺席） ───
  subject?: string;
  scope?: string;
  effectiveNote?: string | null;
  /** 形成正文（冻结快照；**只有详情端点**带） */
  content?: string;
  /** 卡片摘要（锚点后内容 + 剔 locator 前缀 + 280 码点封顶；空串 = 抽不出摘要） */
  contentExcerpt?: string;
  /** 形成**当时**摘录区是否被截（落库事实）——卡片截断**不读不写**它 */
  contentTruncated?: boolean;
  /**
   * 来源引用（**只镜像消费面字段**：`type`/`id` + 父链 `parentId`）。
   *
   * 实体侧还有 `parent` / `versionHash` / `headingPath` / `excerpt`——web 一处都不消费
   * （回查入口走 `sources[].readWith`，冻结哈希走 `sources[].versionHash`），
   * 全量镜像只会多一份需要跟着后端改的副本。**改这里必须回读实体**
   * （`database/entities/memory-nomination.entity.ts` 的 `MemorySourceRef`）确认可选性：
   * `parentId?` 在后端是**可选但不可为 null**（与 `parent?` 同档），镜像不得放宽成 `| null`。
   */
  sourceRefs?: { type: MemorySourceRefType; id: string; parentId?: string }[];
  sources?: MemoryRecallSource[];
  engineNominationId?: string | null;
  engineCanonicalNominationId?: string | null;
  engineJobId?: string | null;
  engineMemoryIds?: string[];
  engineCorrectionId?: string | null;
  correctionTargetMemoryId?: string | null;
  clientRequestId?: string | null;
  /** 恢复路径（由最近一次形成尝试得出；值域见 MEMORY_RECOVERY_PATH） */
  recoveryPath?: string | null;
  /** 引擎明示延后（独立布尔列，非 formationState 取值） */
  deferred?: boolean;
}

/** 账本列表信封（`engineAvailability` 恒带——横幅免额外请求） */
export interface MemoryNominationListResponse {
  items: MemoryNominationDto[];
  /** **裁剪前全量行数**（tab 计数与截断检测的权威来源） */
  total: number;
  page: number;
  pageSize: number;
  engineAvailability: MemoryEngineAvailability;
}

/** 来源回查入口（`sources[].readWith`） */
export interface MemorySourceReadWith {
  /** 平台 MCP 工具名 */
  tool: MemorySourceReadTool;
  /** 工具参数（异质值类型：布尔/数字/字符串都有，故意 unknown） */
  params: Record<string, unknown>;
}

/** 召回项来源投影 */
export interface MemoryRecallSource {
  type: MemorySourceRefType;
  id: string;
  parent: { type: string; id: string } | null;
  versionHash: string | null;
  headingPath: string | null;
  /** `chamber://<type>/<id>[#h<hash12>]` */
  locator: string;
  /** **doc 专属**：当前 contentHash ≠ 冻结 versionHash ⇒ true；其余类型恒 false */
  moved: boolean;
  readWith: MemorySourceReadWith;
}

/**
 * 召回项。
 *
 * ⚠️ `score` 的语义护栏（**推翻本节旧注释「无 score」**）：它是**引擎给出的词面命中排序权重**
 * （hument `Score = full + OpeningBonus`，整数）——**仅同一次召回内可比**，**不是置信度**，
 * 也**不等于「更可能为真」**；跨查询 / 跨项目**不可比**。后端原值透传，前端**不归一化**。
 * 展示与否由 `memoryRecallScoresInformative` + `memoryRecallItemScore` 判定（缺字段 / 全同值不外显）。
 */
export interface MemoryRecallItem {
  memoryId: string;
  ledgerId: string;
  category: string;
  subject: string;
  scope: string;
  /** 引擎词面排序权重（仅同次召回内可比；非置信度；原值透传不归一化） */
  score: number;
  /** 形成正文（冻结快照；非来源当前版本） */
  body: string;
  kind: string;
  resolution: string;
  status: string;
  /** `sourced` = 有来源引用；`authorship` = 纯著述 */
  derivation: 'sourced' | 'authorship';
  contentTruncated: boolean;
  reviewDue: boolean;
  sources: MemoryRecallSource[];
}

/** 召回响应（含信任框信封 + 空结果判据；**有副作用**：遥测 + 配额） */
export interface MemoryRecallResponse {
  items: MemoryRecallItem[];
  emptyReason: MemoryRecallEmptyReason;
  /** 是否有条目**因来源权限被过滤** */
  filteredByPermission: boolean;
  /** 引擎返回了本项目映射不到的条目（且存在 committed 行、无在途行） */
  engineDataSuspect: boolean;
  recallId: string;
  presentationEventId: string | null;
  trustLevel: string;
  decisionAuthority: string;
  usageNote: string;
}

// ═══════════════════════════════════════════════════════════════════════
// 三、Web 本地值域（后端未进 shared 的码，镜像 + 命名访问）
// ═══════════════════════════════════════════════════════════════════════

/** 投影档位（后端 `projection` 的两值**未进 shared**——镜像一份，两侧同改） */
const MEMORY_PROJECTION = {
  /** 全源可见的完整投影 */
  FULL: 'full',
  /** 治理白名单降级投影 */
  METADATA: 'metadata',
} as const;

/**
 * 恢复路径值域（镜像 backend `engines/formation-state.mapper.ts` 的 `MEMORY_RECOVERY_PATHS`）。
 *
 * 该码**没有进 shared**（后端模块内常量），故 web 侧镜像一份；两侧同改。
 * 用途：把 `recoveryPath` 映射成人类文案 + 只读出口（plan §5 第 26 条）。
 */
export const MEMORY_RECOVERY_PATH = {
  /** 非终态：同 key 重发推进（唯一的自动重试路径） */
  SAME_KEY_RESEND: 'same_key_resend',
  /** inspect 回填：只读回查，不推进 job */
  INSPECT_BACKFILL: 'inspect_backfill',
  /** 须 Owner/Hub 人工处置（rejected / unknown，重试无效） */
  HUB_MANUAL_REQUIRED: 'hub_manual_required',
  /** 配置错（绑定/凭据）：重试无效 */
  CONFIG_INVALID: 'config_invalid',
  /** 参数错：须**换新** client_request_id 重提 */
  PARAM_INVALID: 'param_invalid',
} as const;

/** 恢复路径取值（web 镜像；后端单源见 MEMORY_RECOVERY_PATH 注释） */
export type MemoryRecoveryPath = (typeof MEMORY_RECOVERY_PATH)[keyof typeof MEMORY_RECOVERY_PATH];

/**
 * 恢复路径 → 展示分叉键（**白名单**；未映射值走 `unknown` 通用文案）。
 *
 * 为什么不直接渲染 `recoveryPath` 原文：那是一串给机器看的码（`hub_manual_required`），
 * 裸渲染对人类读者是噪音、且会把服务端新增的码无声地泄进界面。白名单外一律通用文案。
 */
export type MemoryRecoveryKind =
  | 'sameKeyResend'
  | 'inspectBackfill'
  | 'hubManualRequired'
  | 'configInvalid'
  | 'paramInvalid'
  | 'unknown';

/**
 * 恢复路径 → 展示分叉键
 *
 * @param path - 后端 `recoveryPath` 原值（可能为 null / 白名单外的新码）
 * @returns 文案分叉键（`unknown` = 通用文案；调用方按它显式选 i18n key）
 */
export function memoryRecoveryKind(path: string | null | undefined): MemoryRecoveryKind {
  switch (path) {
    case MEMORY_RECOVERY_PATH.SAME_KEY_RESEND:
      return 'sameKeyResend';
    case MEMORY_RECOVERY_PATH.INSPECT_BACKFILL:
      return 'inspectBackfill';
    case MEMORY_RECOVERY_PATH.HUB_MANUAL_REQUIRED:
      return 'hubManualRequired';
    case MEMORY_RECOVERY_PATH.CONFIG_INVALID:
      return 'configInvalid';
    case MEMORY_RECOVERY_PATH.PARAM_INVALID:
      return 'paramInvalid';
    default:
      return 'unknown';
  }
}

/**
 * 引擎不可用文案分叉键（plan §5 第 18/25 条：**三分叉**）。
 *
 * `not_configured` = 整个部署没接引擎 / `project_engine_unbound` = 本项目未绑引擎 /
 * 其余（unreachable / timeout / error）= 引擎暂时不可用。
 * **两个来源共用本映射**：`engineAvailability.reason` 与 runtime 503 `data.reason`。
 */
export type MemoryUnavailableKind = 'notConfigured' | 'projectUnbound' | 'engineUnavailable';

/**
 * 引擎不可用原因 → 文案分叉键
 *
 * @param reason - 后端 reason（可为 null = 可用）
 * @returns 文案分叉键（调用方按它显式选 i18n key：next-intl 的 key 有编译期校验，禁动态拼）
 */
export function memoryUnavailableReasonKind(
  reason: MemoryUnavailableReason | null | undefined,
): MemoryUnavailableKind {
  switch (reason) {
    case MEMORY_UNAVAILABLE_REASON.NOT_CONFIGURED:
      return 'notConfigured';
    case MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND:
      return 'projectUnbound';
    default:
      // 全局 fallback = 引擎暂时不可用（unreachable/timeout/error 的处置动作同档：稍后重试）
      return 'engineUnavailable';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 四、字段存在性判定（`metadata` 档契约）
// ═══════════════════════════════════════════════════════════════════════

/**
 * `memoryHasField` 的白名单 = **UI 需要判存在性的那批字段**。
 *
 * 不是与 `MemoryNominationDto` 的可选键一一对应（那是镜像的职责，不在这里）：
 * 列表里只判摘要/来源/归属几项，详情页多判 `content`/`recoveryPath` 等——白名单按
 * **消费需要**开，新增消费点时才加，避免把类型面的每次扩张都变成这里的维护负担。
 */
export type MemoryFullTierField =
  | 'subject'
  | 'scope'
  | 'effectiveNote'
  | 'content'
  | 'contentExcerpt'
  | 'contentTruncated'
  | 'sources'
  | 'recoveryPath'
  | 'deferred';

/**
 * 行投影里是否**真实存在**该 full 档字段。
 *
 * 后端的降级投影是"整键缺席"而不是"置 null"，`dto.contentExcerpt !== undefined` 在
 * 某些序列化路径下会与"显式 undefined"混淆，故统一用 `in` 判定（契约要求消费方 `in` 判定）。
 *
 * @param dto - 账本行投影
 * @param field - 目标字段名
 * @returns 该键是否存在于对象上
 */
export function memoryHasField(dto: MemoryNominationDto, field: MemoryFullTierField): boolean {
  return Object.prototype.hasOwnProperty.call(dto, field);
}

/** 该行是否是治理白名单降级投影（`metadata`） */
export function memoryIsMetadataProjection(dto: MemoryNominationDto): boolean {
  return dto.projection === MEMORY_PROJECTION.METADATA;
}

/**
 * 卡片摘要文本（**只读 `contentExcerpt`，不读不写 `contentTruncated`**）。
 *
 * 三条返回语义：
 * - `metadata` 档（键缺席）→ `null`（调用方渲染"仅元数据"紧凑行，不渲染卡片摘要位）
 * - `full` 档但摘要为空串 → `null`（后端抽不出摘要；空串是显式值，不是"没有这个字段"）
 * - 有值 → 原样返回（含可能的截断尾标，见文件头不变量）
 *
 * @param dto - 账本行投影
 * @returns 摘要文本或 null
 */
export function memoryExcerptOf(dto: MemoryNominationDto): string | null {
  if (!memoryHasField(dto, 'contentExcerpt')) return null;
  const excerpt = dto.contentExcerpt ?? '';
  return excerpt.length > 0 ? excerpt : null;
}

// ═══════════════════════════════════════════════════════════════════════
// 五、展示映射（状态 / 形成态 / category 配色）
// ═══════════════════════════════════════════════════════════════════════

/** Badge 变体值域（对齐 `components/ui/badge.tsx` 的 variant 联合） */
export type MemoryBadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'subtle';

/**
 * 账本状态 → Badge 变体（plan §5 第 5 条）。
 *
 * - `active`（生效中）→ `success`：现行主张，正向
 * - `superseded`（已更正）→ `subtle`：中性降权，**不是**错误态（治理动线上的正常历史）
 * - `withdrawn`（已撤销）→ `outline` + 调用方叠加 `opacity-60`（见 `memoryStatusIsDimmed`）
 *
 * ⚠️ **语义不得只靠颜色**（WCAG 1.4.1）：Badge 文字恒在，颜色只是加强。
 *
 * @param status - 账本行状态
 * @returns Badge 变体
 */
export function memoryStatusBadgeVariant(status: MemoryNominationStatus): MemoryBadgeVariant {
  switch (status) {
    case MEMORY_NOMINATION_STATUS.ACTIVE:
      return 'success';
    case MEMORY_NOMINATION_STATUS.SUPERSEDED:
      return 'subtle';
    default:
      return 'outline';
  }
}

/**
 * 是否降权渲染（`withdrawn` = 已撤销：撤回的主张在视觉上要退到背景里）。
 *
 * plan §5 第 7 条：**删除线不用于卡片标题**（它会被读成"数据被删了"，而这是治理状态的
 * 历史记录，仍可读、仍可点）。降权手法 = opacity + Badge 文字。
 *
 * @param status - 账本行状态
 * @returns true = 调用方给卡片/标题叠加 opacity 降权类
 */
export function memoryStatusIsDimmed(status: MemoryNominationStatus): boolean {
  return status === MEMORY_NOMINATION_STATUS.WITHDRAWN;
}

/**
 * 形成态 → Badge 变体（「提名记录」行内用）。
 *
 * 分档依据 = **是否还在动**（读者唯一要判断的事）：
 * - `submitted` 非终态 → `default`（主光色：还在推进，值得关注）
 * - `committed` 终态成功 → `success`
 * - `no_memory` 终态"无需记忆" → `subtle`（中性：不是错误，是引擎的正常判定）
 * - `failed` 非终态、`conflict` 需人工 → `warning`
 * - `rejected` 终态须人工 → `destructive`
 * - `unknown` 不可恢复 → `outline`（中性存疑，不吓人也不假装正常）
 *
 * @param state - 形成态
 * @returns Badge 变体
 */
export function memoryFormationStateBadgeVariant(state: MemoryFormationState): MemoryBadgeVariant {
  switch (state) {
    case MEMORY_FORMATION_STATE.SUBMITTED:
      return 'default';
    case MEMORY_FORMATION_STATE.COMMITTED:
      return 'success';
    case MEMORY_FORMATION_STATE.NO_MEMORY:
      return 'subtle';
    case MEMORY_FORMATION_STATE.FAILED:
    case MEMORY_FORMATION_STATE.CONFLICT:
      return 'warning';
    case MEMORY_FORMATION_STATE.REJECTED:
      return 'destructive';
    default:
      return 'outline';
  }
}

/**
 * category chip 的静态类名池（plan §5 第 8/9 条）。
 *
 * 两条硬约束：
 * 1. **必须是静态字面量**——`bg-${hue}-500/15` 这种模板拼接 Tailwind 不生成 CSS 且
 *    **零报错**（设计系统 §6.1 工程约束）；本文件在 `src/lib/**` 扫描范围内。
 * 2. **色相与 `avatar.tsx:20-29` AVATAR_PALETTE 对齐**（青 187 / 紫 258 / 深空蓝 222 /
 *    品紫 282 / 青绿 160 / 粉 330 / 琥珀 25 / 天蓝 200），保证同一个"记忆类别"在全站
 *    与头像家族同色系，视觉上不打架。
 *
 * 亮度档取 -300（与设计系统 §6 消息类型配色同档），底一律 `/15` 半透明——
 * **禁**亮主题硬编码（§2.2）。
 */
const MEMORY_CATEGORY_CHIP_CLASSES = [
  'bg-cyan-500/15 text-cyan-300', // 0 青（主光色相）
  'bg-violet-500/15 text-violet-300', // 1 紫（辅助光色相）
  'bg-blue-500/15 text-blue-300', // 2 深空蓝
  'bg-fuchsia-500/15 text-fuchsia-300', // 3 品紫
  'bg-emerald-500/15 text-emerald-300', // 4 青绿
  'bg-pink-500/15 text-pink-300', // 5 粉
  'bg-amber-500/15 text-amber-300', // 6 琥珀
  'bg-sky-500/15 text-sky-300', // 7 天蓝
] as const;

/**
 * 固定占位（防撞色）：**已知类别钉死槽位，且该槽位从 hash 池里排除**。
 *
 * rationale：`ruling` 是记忆类别的首个落点（也是当前绝大多数行），若它也走 hash，
 * 则任何随机类别都可能落进它的槽位 —— 读者刚建立起的"青色 = 裁决"的心智模型会被撞碎。
 * 钉死 + 排除 = 钉子类别的颜色**永不被复用**给其它类别。
 */
const MEMORY_CATEGORY_PINNED_SLOTS: Record<string, number> = {
  ruling: 0,
};

/**
 * hash 池 = 全部槽位**去掉钉死槽位**（顺序保持稳定，保证同一 category 恒同色）。
 *
 * 池为空时（配置错误的极端情况）回落到全表，不抛错——展示层不该因数据面新值崩页。
 */
const MEMORY_CATEGORY_HASH_SLOTS: readonly number[] = MEMORY_CATEGORY_CHIP_CLASSES.map(
  (_, index) => index,
).filter((index) => !Object.values(MEMORY_CATEGORY_PINNED_SLOTS).includes(index));

/**
 * 字符串 → 稳定槽位（djb2，与 `avatar.tsx` 同一 hash 家族：纯算术、无副作用、跨端确定）
 *
 * @param value - hash 种子（category 文本）
 * @param modulo - 取模基数（> 0）
 * @returns 0 ~ modulo-1
 */
function hashToSlot(value: string, modulo: number): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return Math.abs(hash) % modulo;
}

/**
 * category → chip 静态类名（**唯一实现**；卡片/详情/召回结果共用，禁各写一套）。
 *
 * category 是**开放短标签**（后端受控但非封闭词表），新增值不需要前端发版——
 * 故配色必须由 hash 派生而不是查表；已知类别走钉死槽位。
 *
 * @param category - 记忆类别（原样透传，不做大小写归一——后端写入侧已是受控值）
 * @returns 静态字面量类名串（可安全放进 `className`）
 */
export function memoryCategoryChipClass(category: string): string {
  const pinned = MEMORY_CATEGORY_PINNED_SLOTS[category];
  if (pinned !== undefined) return MEMORY_CATEGORY_CHIP_CLASSES[pinned];
  if (MEMORY_CATEGORY_HASH_SLOTS.length === 0) {
    return MEMORY_CATEGORY_CHIP_CLASSES[hashToSlot(category, MEMORY_CATEGORY_CHIP_CLASSES.length)];
  }
  const slot = MEMORY_CATEGORY_HASH_SLOTS[hashToSlot(category, MEMORY_CATEGORY_HASH_SLOTS.length)];
  return MEMORY_CATEGORY_CHIP_CLASSES[slot];
}

// ═══════════════════════════════════════════════════════════════════════
// 六、归属三态（复用 experienceActorLabel + system 哨兵分叉）
// ═══════════════════════════════════════════════════════════════════════

/** 提名者展示态 = 全站三态范式 + 一个"哨兵 system"标记 */
export interface MemoryNominatorLabel extends ExperienceActorLabel {
  /**
   * 是否是无档案的 system 哨兵 actor。
   *
   * true 时**调用方必须渲染 i18n 静态文案**（`memory.nominator.system`）而不是 `name`——
   * 后端刻意不给 system 填显示名，因为"系统"一词要按语言渲染。
   */
  system: boolean;
}

/**
 * `nominatorType` 的 system 哨兵值。
 *
 * **直接引用 shared `ActorType.SYSTEM`**（值域单源）而不是写字面量：自定义 eslint 规则
 * `no-magic-string-compare` 禁止 `=== 'system'` 这类比较（黑名单命中即 error——
 * 它的存在正是因为这类比较会静默漏改），引用枚举让"值域改了"变成编译期问题。
 */
const MEMORY_NOMINATOR_TYPE_SYSTEM = ActorType.SYSTEM;

/**
 * 提名者 → 展示态（plan §5 第 45 条：对齐全站三态范式）。
 *
 * 三态规则（唯一实现在 `experienceActorLabel`，本函数只加 system 分叉）：
 * 1. 有名（含软删）→ 真名（软删保留下方 `deleted=true` 让调用方加「已删除」小字）；
 * 2. `null` + `nominatorType='system'` → `system=true`，名字位交给 i18n 静态文案；
 * 3. `null` 且非 system（真孤儿）→ 退 `nominatorId` 前 8 位（不加"未知用户"类兜底词）。
 *
 * ⚠️ 与 `nominatorId` 配对读：`name === null` **不等于**"没有提名者"。
 *
 * @param nominator - 提名者四件套（id / 名字 / 软删时间 / 类型）
 * @returns 展示态（`visible=false` 时调用方整行隐藏）
 */
export function memoryNominatorLabel(nominator: {
  id?: string | null;
  name?: string | null;
  deletedAt?: string | null;
  type?: string | null;
}): MemoryNominatorLabel {
  const base = experienceActorLabel({
    id: nominator.id,
    name: nominator.name,
    deletedAt: nominator.deletedAt,
  });
  // system 判定只在"没有真名"时生效：有名字就按名字渲染（后端将来给 system 填名字也不用改这里）
  const system = !nominator.name && nominator.type === MEMORY_NOMINATOR_TYPE_SYSTEM;
  return { ...base, system };
}

// ═══════════════════════════════════════════════════════════════════════
// 七、Tab 分面（D6 三 Tab + 6 个 formationState 子标签）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 「提名记录」子标签覆盖的形成态（**6 路**）。
 *
 * 刻意排除 `committed`：已形成的记忆属于「已记住」Tab（它有自己的分页器），
 * 两处都列会让同一行出现两次、计数也对不上。七态减去 committed = 6。
 */
export const MEMORY_NOMINATIONS_FORMATION_STATES = [
  MEMORY_FORMATION_STATE.SUBMITTED,
  MEMORY_FORMATION_STATE.FAILED,
  MEMORY_FORMATION_STATE.CONFLICT,
  MEMORY_FORMATION_STATE.UNKNOWN,
  MEMORY_FORMATION_STATE.REJECTED,
  MEMORY_FORMATION_STATE.NO_MEMORY,
] as const;

/**
 * 「已失效」Tab 覆盖的账本状态（**2 路**）。
 *
 * 与「提名记录」互斥的判据是 `status`（不是 formationState）：
 * 一条 `withdrawn` 更正行的 formationState 可以是 `failed`，但它属于无效主张
 * （DB 不变量 `withdrawn ⇒ engineMemoryIds 为空`），必须只出现在「已失效」。
 * 同理 `superseded` 的旧行即使 formationState=committed 也**不再**是"已记住"。
 */
export const MEMORY_INACTIVE_STATUSES = [
  MEMORY_NOMINATION_STATUS.SUPERSEDED,
  MEMORY_NOMINATION_STATUS.WITHDRAWN,
] as const;

/** Tab 标识（URL `?tab=` 的值域，也是 push 语义的作用面之一） */
export const MEMORY_TAB = {
  /** 已记住：status=active 且 formationState=committed（server 过滤 + 分页器） */
  COMMITTED: 'committed',
  /** 提名记录：status=active 且 formationState ∈ 六态（6 路并行合并） */
  NOMINATIONS: 'nominations',
  /** 已失效：status ∈ {superseded, withdrawn}（2 路并行合并） */
  INACTIVE: 'inactive',
} as const;

/** Tab 标识类型 */
export type MemoryTab = (typeof MEMORY_TAB)[keyof typeof MEMORY_TAB];

/** Tab 值域（URL 白名单校验用；非法值回落默认 Tab） */
export const MEMORY_TABS = [
  MEMORY_TAB.COMMITTED,
  MEMORY_TAB.NOMINATIONS,
  MEMORY_TAB.INACTIVE,
] as const;

/** 搜索模式（URL `?mode=` 的值域；D7/D11：mode 走 replace，可刷新恢复/分享） */
export const MEMORY_SEARCH_MODE = {
  /** 语义：问引擎（消耗配额、有副作用） */
  SEMANTIC: 'semantic',
  /** 字面：只在当前已加载的条目里按文字匹配（即时、零配额） */
  LITERAL: 'literal',
} as const;

/** 搜索模式取值 */
export type MemorySearchMode = (typeof MEMORY_SEARCH_MODE)[keyof typeof MEMORY_SEARCH_MODE];

/** 搜索模式值域（URL 白名单校验用） */
export const MEMORY_SEARCH_MODES = [
  MEMORY_SEARCH_MODE.SEMANTIC,
  MEMORY_SEARCH_MODE.LITERAL,
] as const;

// ═══════════════════════════════════════════════════════════════════════
// 八、查询参数装配 / 派生量 / 错误码读取
// ═══════════════════════════════════════════════════════════════════════

/** 账本列表过滤态（同时是 react-query 的 queryKey 片段） */
export interface MemoryNominationFilters {
  /** 按类别过滤（空串 = 全部） */
  category?: string;
  /** 按账本状态过滤（词表单值，不做多选——多选要多次请求，由 Tab 承担） */
  status?: MemoryNominationStatus;
  /** 按形成态过滤（词表单值） */
  formationState?: MemoryFormationState;
  /** 复核到期过滤（ISO 8601；仅筛选，不自动过期） */
  reviewBefore?: string;
  /** 页码（1 起） */
  page?: number;
  /** 每页条数（后端内存分页，不影响 total） */
  pageSize?: number;
}

/**
 * 过滤态 → 后端 query 参数对象
 *
 * 规则：`undefined` / 空串 → **不发送该键**（`?status=` 会撞后端 `@IsIn` 400——
 * 空串不是词表成员）。与 `buildExperienceQueryParams` 同一纪律。
 *
 * @param filters - UI 过滤态
 * @returns 可直接交给 axios `params` 的扁平对象
 */
export function buildMemoryNominationQueryParams(
  filters: MemoryNominationFilters,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (filters.category) params.category = filters.category;
  if (filters.status) params.status = filters.status;
  if (filters.formationState) params.formationState = filters.formationState;
  if (filters.reviewBefore) params.reviewBefore = filters.reviewBefore;
  if (filters.page !== undefined) params.page = filters.page;
  if (filters.pageSize !== undefined) params.pageSize = filters.pageSize;
  return params;
}

/**
 * 派生分页量（后端列表信封只给 items/total/page/pageSize）
 *
 * @param total - 满足过滤条件的总条数（**裁剪前全量**）
 * @param page - 当前页（1 起）
 * @param pageSize - 每页条数
 * @returns totalPages（至少 1）/ hasPrev / hasNext / 当前页已展示条数上界
 */
export function memoryPagination(
  total: number,
  page: number,
  pageSize: number,
): { totalPages: number; hasPrev: boolean; hasNext: boolean } {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return { totalPages, hasPrev: page > 1, hasNext: page < totalPages };
}

/**
 * 构造召回上下文身份（plan §1 D3：`web:user:<userId>:project:<projectId>`）。
 *
 * ⚠️ **禁塞用户正文**：该串会被引擎用于呈现事件的去重与归因（后端 DTO 明文警告）。
 * 本函数只拼 id（用户 id + 项目 id 都是 UUID），无用户可控文本。
 *
 * @param userId - 当前登录用户 id（缺省用 `anonymous` 占位，长度仍在 1~256 内）
 * @param projectId - 记忆项目 id
 * @returns 1~256 字符的 identity 串
 */
export function memoryContextIdentity(userId: string | undefined, projectId: string): string {
  return `web:user:${userId ?? 'anonymous'}:project:${projectId}`.slice(
    0,
    MEMORY_CONTEXT_IDENTITY_MAX_LENGTH,
  );
}

/** 后端错误码（shared `ErrorCode` 子集；此处只列 web 需要分叉的三个） */
const MEMORY_ERROR_CODE = {
  /** 403：治理观察者无**内容**读权限（本地数据端点仍可读） */
  PERMISSION_DENIED: 1009,
  /** 503：引擎动词不可用（`data.reason` 与 engineAvailability.reason 共用映射） */
  MEMORY_UNAVAILABLE: 14000,
  /** 404：账本行不存在或不可见 */
  MEMORY_NOMINATION_NOT_FOUND: 14003,
} as const;

/**
 * 从 axios 错误里读出"引擎不可用原因"（runtime 503 的分支依据）。
 *
 * 层级提醒：`apiRequest` 只在**成功**时剥 `data`；错误对象里是**原始响应体**
 * `{code, message, data:{reason}}`，故 reason 在 `response.data.data.reason`。
 *
 * @param error - useQuery/useMutation 抛出的错误
 * @returns reason（非 14000 或字段缺失时 null）
 */
export function memoryUnavailableReasonOf(error: unknown): MemoryUnavailableReason | null {
  const err = error as {
    response?: { status?: number; data?: { code?: number; data?: { reason?: string } } };
  };
  if (err?.response?.status !== 503) return null;
  if (err.response.data?.code !== MEMORY_ERROR_CODE.MEMORY_UNAVAILABLE) return null;
  const reason = err.response.data?.data?.reason;
  return (reason as MemoryUnavailableReason | undefined) ?? null;
}

/** HTTP 状态 / 业务码的读取结果（页面据此选独立降级态，不走通用重试） */
export interface MemoryErrorKind {
  /** HTTP 状态码（无响应时为 null） */
  status: number | null;
  /** 业务码（响应体 `code`） */
  code: number | null;
  /** 是否内容读权限不足（403/1009：治理观察者） */
  permissionDenied: boolean;
  /** 是否账本行不存在/不可见（404/14003） */
  notFound: boolean;
  /** 是否引擎不可用（503/14000） */
  engineUnavailable: boolean;
}

/**
 * 错误 → 分叉判据（**唯一实现**：列表/详情/召回三处共用）。
 *
 * 为什么要分叉而不是一律"加载失败，重试"：三种错的**下一步动作完全不同**——
 * 权限不足要去申请权限、行不存在要回账本、引擎不可用要等引擎（本地数据照常可读）。
 * 一张"重试"按钮对前两者是死胡同（plan §5 第 20/21 条）。
 *
 * @param error - 抛出的错误（axios 形态）
 * @returns 分叉判据
 */
export function memoryErrorKind(error: unknown): MemoryErrorKind {
  const err = error as {
    response?: { status?: number; data?: { code?: number } };
  };
  const status = err?.response?.status ?? null;
  const code = err?.response?.data?.code ?? null;
  return {
    status,
    code,
    permissionDenied: status === 403 && code === MEMORY_ERROR_CODE.PERMISSION_DENIED,
    notFound: status === 404 && code === MEMORY_ERROR_CODE.MEMORY_NOMINATION_NOT_FOUND,
    engineUnavailable: status === 503 && code === MEMORY_ERROR_CODE.MEMORY_UNAVAILABLE,
  };
}

/**
 * 信任框原始字段 + 逐条召回原值（plan §5 第 14 条 + N3：调试区**原值直出**是本分）。
 *
 * 信任框是**下游 agent 不把建议当裁决**的防线（后端契约把三件套列为不可省），
 * 对人类读者则要退一步：界面给一句人话，原始机器值放进可展开的调试区，两边都不丢。
 *
 * **原值透传纪律（N3）**：`score` / `resolution` / `kind` 一律**原样**渲染，**不做**任何
 * 值域映射与翻译（域外值如 `canonical` 照原样显示）——调试区的职责是"把机器看到的东西给
 * 排障的人"，映射会把线索洗掉。逐项行**必须带 `items[i].` 归属**（否则一行 `score: 7` 不知是谁的）。
 *
 * ⚠️ 返回键刻意从原来的**闭合联合放宽成 `string`**：扩逐项行后 key 变成动态下标串
 * （`items[3].score`），闭合联合无法表达。这里是**显式放宽类型**，不是 `as` 断言
 * （`as` 会把类型系统关掉，放宽联合则仍由编译器检查写入的 key 形状）。
 *
 * @param response - 召回响应（信封三件套 + items）
 * @returns 调试区行：先是信封三件套，再逐条列出 `items[i].score / .resolution / .kind`
 */
export function memoryTrustDebugRows(
  response: Pick<MemoryRecallResponse, 'trustLevel' | 'decisionAuthority' | 'usageNote' | 'items'>,
): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = [
    { key: 'trustLevel', value: response.trustLevel },
    { key: 'decisionAuthority', value: response.decisionAuthority },
    { key: 'usageNote', value: response.usageNote },
  ];
  response.items.forEach((item, index) => {
    // 原值直出（不映射、不归一化）：缺失的旧后端字段也会显示成 undefined——这正是排障要看到的
    rows.push({ key: `items[${index}].score`, value: String(item.score) });
    rows.push({ key: `items[${index}].resolution`, value: item.resolution });
    rows.push({ key: `items[${index}].kind`, value: item.kind });
  });
  return rows;
}

/**
 * 单条召回的 `score` 是否**可展示**（缺字段 / 非有限数 → null）。
 *
 * 守卫动机（plan §1.8 / W-5）：旧后端或引擎漏字段时，裸渲染会出「相关度 undefined」；
 * 不成立时**只不渲染行尾元素**（W-5 措辞：不是隐藏整条召回结果）。
 *
 * @param item - 召回项
 * @returns 有限数字或 null
 */
export function memoryRecallItemScore(item: Pick<MemoryRecallItem, 'score'>): number | null {
  return Number.isFinite(item.score) ? item.score : null;
}

/**
 * 整次召回的分数是否**有信息量**（= 全部有值 **且** 不全相同）。
 *
 * `false` 的两种情形都必须抑制主列表的分数展示：
 * - 任一条缺 `score` ⇒ 缺值守卫（旧后端）；
 * - 全同值 ⇒ **零信息**（"都相等"不构成任何排序线索，画出来只会误导）。
 *
 * ⚠️ **只作用主列表**：折叠调试区**恒显原值**（C-3，排障需要看到真实分布，含全同值）。
 * 空列表同样返回 false（没有可比的分数）。
 *
 * @param items - 召回项列表
 * @returns true = 主列表可展示分数
 */
export function memoryRecallScoresInformative(items: readonly MemoryRecallItem[]): boolean {
  if (items.length === 0) return false;
  const scores = items.map((item) => memoryRecallItemScore(item));
  if (scores.some((score) => score === null)) return false;
  return new Set(scores).size > 1;
}

/**
 * 召回结果是否"有内容可展示"（空判定收口，避免页面里散落三处判断）。
 *
 * @param response - 召回响应
 * @returns true = items 非空
 */
export function memoryRecallHasItems(response: MemoryRecallResponse | undefined): boolean {
  return !!response && response.items.length > 0;
}

/** 召回空结果原因 → 分叉键（`all_filtered` 与 `no_matches` **必须分清**：下一步动作不同） */
export type MemoryRecallEmptyKind = 'none' | 'noMatches' | 'allFiltered';

/**
 * 召回空结果原因 → 文案分叉键
 *
 * @param reason - 后端 `emptyReason`
 * @returns 文案分叉键
 */
export function memoryRecallEmptyKind(reason: MemoryRecallEmptyReason): MemoryRecallEmptyKind {
  switch (reason) {
    case MEMORY_RECALL_EMPTY_REASON.NO_MATCHES:
      return 'noMatches';
    case MEMORY_RECALL_EMPTY_REASON.ALL_FILTERED:
      return 'allFiltered';
    default:
      return 'none';
  }
}

/**
 * 字面模式匹配：查询词是否命中某条已加载条目（**纯客户端、零配额**）。
 *
 * 匹配面刻意是"读者在卡片上看得见的东西"（subject / scope / category / 摘要），
 * **不含正文**——列表投影里根本没有正文（`content` 只在详情端点），
 * 把"匹配不到"归因于"正文没搜"会是幻觉。
 *
 * @param item - 已加载的账本行投影
 * @param query - 查询词（大小写不敏感；空串恒命中，由调用方在无查询时直接跳过过滤）
 * @returns 是否命中
 */
export function memoryLiteralMatch(dto: MemoryNominationDto, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [dto.subject ?? '', dto.scope ?? '', dto.category, memoryExcerptOf(dto) ?? '']
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * 按 `createdAt` 倒序合并多路查询结果（「提名记录」6 路 /「已失效」2 路）。
 *
 * 为什么在前端合并：后端只支持**单值** `formationState` / `status` 过滤（DTO `@IsIn`），
 * 多路并行 + 前端归并是零新端点下的唯一解（plan §1 D6）。
 *
 * 排序语义与后端一致（`created_at DESC`）；`id` 作为决胜键保证稳定顺序
 * （同一毫秒落库的两行顺序不稳定会让卡片在两路响应到达的间隙里抖动）。
 *
 * @param groups - 各路响应（未就绪的传 undefined，自动跳过）
 * @returns 合并去重后的行（同 id 只保留一条——理论上各路互斥，去重是防御）
 */
export function memoryMergeByCreatedAt(
  groups: readonly (readonly MemoryNominationDto[])[],
): MemoryNominationDto[] {
  const seen = new Set<string>();
  const merged: MemoryNominationDto[] = [];
  for (const group of groups) {
    for (const row of group) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }
  merged.sort((a, b) => {
    if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return merged;
}

/** 引擎当前是否可用（`engineAvailability` 缺失时按"可用"处理：不谎报故障） */
export function memoryEngineAvailable(availability: MemoryEngineAvailability | undefined): boolean {
  if (!availability) return true;
  return availability.available;
}

/**
 * 部署级自助开通是否**可用**（`provisioningAvailable` 的**三态读法**，N2）。
 *
 * 只有显式 `true` 才算可用：`undefined`（旧后端 / 未取到名单）与 `false` 一律按**不可用**处理
 * ——默认**不承诺**自助开通（promise 少一个，用户就少踩一次"以为会自动注册"的坑）。
 *
 * @param provisioningAvailable - 列表信封字段（可能缺失）
 * @returns true = 可按"留空自动注册"渲染
 */
export function memoryProvisioningAvailable(provisioningAvailable: boolean | undefined): boolean {
  return provisioningAvailable === true;
}

// ═══════════════════════════════════════════════════════════════════════
// 九、引擎投影读面镜像（hument alpha.5 四读面；`GET /memory/projects/:id/views/*`）
//
// **逐字镜像，不做任何归一化**（与上面的账本族相反）：四个引擎响应 schema 全是
// `additionalProperties: false`，任何"顺手 camelCase"都会让 `engine` 块与合同漂移，
// 且合同新增字段时静默丢失。故以下接口一律 snake_case，与
// `apps/backend/src/modules/memory/engines/memory-engine.interface.ts` 的 `Hument*` 逐字对应。
//
// **两套枚举域**（唯一一处刻意的不对称）：请求枚举是响应枚举的**真子集**——graph 响应的
// `filters` 回声每个维度多一个 `any`（"本维度未过滤"）。本文件只镜像**响应**侧，
// 请求侧的 `any` 拒绝由后端 DTO 负责。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 投影分页块（合同 `workbench-projection-page`；四响应共用）。
 *
 * ⚠️ `total_kind` 必须留在镜像里：`total` 只有在"精确计数"口径下才能当进度分母用，
 * 丢了它消费方就无从判断分母可不可信。
 */
export interface MemoryViewProjectionPage {
  total: number;
  total_kind: 'exact';
  loaded: number;
  next_cursor: string;
  partial: boolean;
  truncated: boolean;
  truncation_reason: string;
}

/** 视图目标回声（服务端认定的调用上下文，不是请求体） */
export interface MemoryViewTarget {
  target_id: string;
  workspace_id: string;
  actor_id: string;
  binding_id: string;
  scope: string;
}

/** 关系边的审计定位器（合同 `workbench-relation-audit-locator`） */
export interface MemoryViewRelationAuditLocator {
  status: string;
  journal_event_id: string;
  revision_id: string;
  mutation_id: string;
}

/** 关系边（graph `edges[]` 与 detail `relations.items[]` 同形） */
export interface MemoryViewEdge {
  relation_id: string;
  from_id: string;
  to_id: string;
  /** 五类（值域单源 = shared `MEMORY_VIEW_RELATION_TYPES`） */
  type: MemoryViewRelationType | string;
  created_at: string;
  audit_locator: MemoryViewRelationAuditLocator;
}

/**
 * graph 节点。
 *
 * ⚠️ `preview` 是**引擎默认档 160 字符**的截断片段（契约上限 512）——平台不自设默认值，
 * 未传即引擎默认。`confidence_present` 是**"置信度存在与否"的布尔**，不是置信度本身
 * （graph 面刻意不吐置信度值）。
 */
export interface MemoryViewGraphNode {
  memory_id: string;
  kind: MemoryViewMemoryKind | string;
  scope: string;
  status: string;
  active_resolution: string;
  available_resolution: string;
  /** 展示标签（契约上限 80） */
  label: string;
  preview: string;
  label_resolution: string;
  confidence_present: boolean;
  contradiction_count: number;
  supersession_count: number;
  anchor_state: string;
  /** 边界标记（引擎语义；平台只透传） */
  boundary: boolean;
  created_at: string;
  updated_at: string;
}

/** graph 响应 `filters` 回声（响应域，每维**多一个 `any`**，与请求域不可复用） */
export interface MemoryViewGraphFiltersEcho {
  kind: string;
  status: string;
  active_resolution: string;
  available_resolution: string;
  anchor_state: string;
  created_from: string | null;
  created_to: string | null;
  relation_type: string;
}

/** graph 响应 `budget` 回声（**真实生效值**，含引擎默认档） */
export interface MemoryViewGraphBudget {
  node_limit: number;
  edge_limit: number;
  neighborhood_limit: number;
  preview_scalars: number;
  depth: number;
}

/** graph 引擎响应整块 */
export interface MemoryViewGraphEngine {
  schema_version: string;
  request_id: string;
  auth_kind: string;
  authority: string;
  target: MemoryViewTarget;
  snapshot_digest: string;
  mode: string;
  center_memory_id: string;
  filters: MemoryViewGraphFiltersEcho;
  budget: MemoryViewGraphBudget;
  node_page: MemoryViewProjectionPage;
  edge_page: MemoryViewProjectionPage;
  /**
   * 被省略的边数 = 命中任一**已加载节点**的边数 − 实际返回数。
   *
   * ⚠️ browse 边只取**两端点都在本次节点页内**的边 ⇒ 端点分落两页的边**永远画不出来**，
   * 反复"加载更多"也补不齐（治理条必须写明，防"边不存在"误判）。
   */
  omitted_edge_count: number;
  nodes: MemoryViewGraphNode[];
  edges: MemoryViewEdge[];
  redaction: string;
}

/** 表示正文（合同 `workbench-representation-body`；正文 ≤64KiB **纯文本**） */
export interface MemoryViewRepresentationBody {
  representation_id: string;
  resolution: string;
  revision_id: string;
  mutation_id: string;
  source_ref: string;
  current: boolean;
  /** 正文快照；渲染走 `whitespace-pre-wrap` 纯文本（无 markdown / 无 HTML 注入面） */
  body: string;
  digest: string;
  original_bytes: number;
  body_truncated: boolean;
  created_at: string;
}

/**
 * 分辨率阶梯槽（**恒 5 项** = R0..R4 各一）。
 *
 * `current` 就是**一份完整正文**（≤64KiB）：拿到 detail 即可直接渲染，**不必再请求**
 * representation 端点。`historical_count` **每个槽都带**——旧行计入该计数，故
 * "有当前"与"有旧版本"可以**并存**（重新形成后的常态）。
 */
export interface MemoryViewLadderSlot {
  resolution: string;
  state: MemoryViewLadderState | string;
  /** = 默认呈现层级（**必填布尔**；与 `available_resolution` 不是一回事） */
  active: boolean;
  current: MemoryViewRepresentationBody | null;
  historical_count: number;
}

/** 引擎侧记忆元数据（detail 的 `memory` 对象；与账本族 `HumentMemoryDetail` **不同形**） */
export interface MemoryViewMemoryDetail {
  memory_id: string;
  kind: MemoryViewMemoryKind | string;
  scope: string;
  status: string;
  available_resolution: string;
  active_resolution: string;
  /** 来源全谱（**与内容同级可见**，与 19.16 inspect 先例一致） */
  provenance: Record<string, unknown>;
  confidence_present: boolean;
  confidence: number | null;
  evidence: string[];
  contradiction: string[];
  supersession: string[];
  created_at: string;
  updated_at: string;
}

/** 锚（detail `sections.anchors.items[]`） */
export interface MemoryViewAnchor {
  anchor_id: string;
  adapter: string;
  source_ref: string;
  external_revision: string;
  content_digest: string;
  source_receipt_id: string;
  source_receipt_digest: string;
  last_checked_at: string;
  revalidation_state: string;
}

/** detail 引擎响应整块 */
export interface MemoryViewDetailEngine {
  schema_version: string;
  request_id: string;
  auth_kind: string;
  authority: string;
  target: MemoryViewTarget;
  snapshot_digest: string;
  memory: MemoryViewMemoryDetail;
  sections: {
    representations: { page: MemoryViewProjectionPage; ladder: MemoryViewLadderSlot[] };
    anchors: { page: MemoryViewProjectionPage; items: MemoryViewAnchor[] };
    relations: { page: MemoryViewProjectionPage; items: MemoryViewEdge[] };
  };
  redaction: string;
}

/**
 * 历史版本条目（history `items[]`）。
 *
 * ⚠️ `current` **引擎只查 `is_current = 0` ⇒ 恒 `false`**——UI **不渲染**这个标记
 * （渲染一个恒为假的分支等于给读者一个永远不变的假信息）。
 */
export interface MemoryViewHistoryItem {
  representation_id: string;
  resolution: string;
  revision_id: string;
  mutation_id: string;
  current: boolean;
  /** 预览片段（上限 4KiB，比 graph 节点宽松一个量级） */
  preview: string;
  digest: string;
  original_bytes: number;
  preview_truncated: boolean;
  created_at: string;
}

/** history 引擎响应整块 */
export interface MemoryViewHistoryEngine {
  schema_version: string;
  request_id: string;
  auth_kind: string;
  authority: string;
  target: MemoryViewTarget;
  snapshot_digest: string;
  memory_id: string;
  resolution: string;
  page: MemoryViewProjectionPage;
  items: MemoryViewHistoryItem[];
  redaction: string;
}

/** representation 引擎响应整块 */
export interface MemoryViewRepresentationEngine {
  schema_version: string;
  request_id: string;
  auth_kind: string;
  authority: string;
  target: MemoryViewTarget;
  snapshot_digest: string;
  memory_id: string;
  representation: MemoryViewRepresentationBody;
  redaction: string;
}

/**
 * graph 响应信封（平台字段**平铺在外层**，引擎块内部一律不塞）。
 *
 * ⚠️ **`node_page.loaded ≠ nodes.length`**：`nodes[]` 是按来源可见性**过滤后**的数组，
 * 而 `page` / `budget` / `omitted_edge_count` 保持引擎口径。渲染与进度一律用
 * `nodes.length` / `filteredNodeCount`，**不要**拿 `loaded` 当分母。
 */
export interface MemoryGraphViewResponse {
  engine: MemoryViewGraphEngine;
  filteredByPermission: boolean;
  filteredNodeCount: number;
  filteredEdgeCount: number;
  /**
   * 引擎返回但本项目**映射不到**账本行的节点数。
   *
   * **透出是与 recall 的刻意分歧**（recall 只把它落遥测、不进响应体）：图缺节点必须能解释。
   * 对齐两族响应时**不要**把它当漏字段删掉。
   */
  unmappedCount: number;
  engineDataSuspect: boolean;
  /** 可见节点的 `engine_memory_id → 账本行 id`（**只含可见节点**）——图 → 详情钻取的唯一通道 */
  ledgerMapping: Record<string, string>;
  trustLevel: string;
  decisionAuthority: string;
  usageNote: string;
}

/** detail 响应信封（外层无 `ledgerId`：调用方已从路由 / `ledgerMapping` 知道是哪一行） */
export interface MemoryViewResponse {
  engine: MemoryViewDetailEngine;
  trustLevel: string;
  decisionAuthority: string;
  usageNote: string;
}

/** history 响应信封 */
export interface MemoryViewHistoryResponse {
  engine: MemoryViewHistoryEngine;
  trustLevel: string;
  decisionAuthority: string;
  usageNote: string;
}

/** representation 响应信封 */
export interface MemoryViewRepresentationResponse {
  engine: MemoryViewRepresentationEngine;
  trustLevel: string;
  decisionAuthority: string;
  usageNote: string;
}

/** 读面请求的过滤器（`kind`/`status`/`relation_type` 三项进 URL；`undefined` = 不发送该键） */
export interface MemoryGraphFilters {
  kind?: string;
  status?: string;
  relationType?: string;
}

/**
 * graph 过滤器 → 后端 query 参数对象。
 *
 * 规则与 `buildMemoryNominationQueryParams` 同一纪律：`undefined` / 空串 → **不发送该键**
 * （空串不是词表成员，会被引擎当非法枚举拒）。**平台不设默认值**：未传即引擎默认档生效，
 * 真实预算由响应 `engine.budget` 回声。
 *
 * ⚠️ **查询参数名是 camelCase（`relationType`），不是引擎侧的 `relation_type`**：
 * 后端 `QueryMemoryViewGraphDto` 的属性名是 `relationType`，`relation_type` 是**服务层翻译给
 * 引擎**的名字；平台的全局校验管道带 `forbidNonWhitelisted`，传 snake_case 会当场 400
 * 把整页打进错误态。**URL 参数名用 `relation_type` 是 web 内部约定**（与 URL 上其他
 * snake_case 参数一致），两套名字在此处交汇，改任一侧都要回读后端 DTO。
 *
 * @param filters - UI 过滤态（三项原生 select）
 * @returns 可直接交给 axios `params` 的扁平对象
 */
export function buildMemoryGraphQueryParams(filters: MemoryGraphFilters): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (filters.kind) params.kind = filters.kind;
  if (filters.status) params.status = filters.status;
  if (filters.relationType) params.relationType = filters.relationType;
  return params;
}

// ── 节点 / 边视觉（静态字面量池，组件禁内联禁模板拼接）────────────────────────

/**
 * 节点视觉（kind 五色）。
 *
 * **必须是静态字面量**——`fill-${hue}-500/15` 这种模板拼接 Tailwind 不生成 CSS 且**零报错**
 * （设计系统 §6.1 工程约束）。色相沿消息配色族：青（主光）/ 紫（辅助光）/ 青绿 / 琥珀 / 靛。
 */
export interface MemoryGraphNodeVisual {
  /** 节点底板填充 */
  fill: string;
  /** 节点描边（选中态在此基础上加粗并叠外圈 rect） */
  stroke: string;
  /** 节点内文字（label / 角标） */
  text: string;
}

/**
 * kind → 视觉（**单一事实源**）。
 *
 * 五色与 category chip 池同族（`avatar.tsx` 色相表）——同一份数据在账本面与图面同色系，
 * 读者建立的心智模型不打架。
 */
const MEMORY_GRAPH_KIND_VISUALS: Record<MemoryViewMemoryKind, MemoryGraphNodeVisual> = {
  observation: { fill: 'fill-cyan-500/15', stroke: 'stroke-cyan-400', text: 'fill-cyan-200' },
  episode: { fill: 'fill-violet-500/15', stroke: 'stroke-violet-400', text: 'fill-violet-200' },
  concept: { fill: 'fill-emerald-500/15', stroke: 'stroke-emerald-400', text: 'fill-emerald-200' },
  belief: { fill: 'fill-amber-500/15', stroke: 'stroke-amber-400', text: 'fill-amber-200' },
  procedure: { fill: 'fill-indigo-500/15', stroke: 'stroke-indigo-400', text: 'fill-indigo-200' },
};

/**
 * 域外 kind 的回落视觉：**中性灰，不借用任何一个已知 kind 的色**。
 *
 * rationale（与 category hash 池的"钉死槽位"同一考虑）：若未知 kind 回落到 observation 的青，
 * 读者会把一个新概念误读成"观察"——**给一个中性的"未分类"外观比给一个错误的已知外观诚实**。
 */
const MEMORY_GRAPH_KIND_FALLBACK: MemoryGraphNodeVisual = {
  fill: 'fill-muted/40',
  stroke: 'stroke-muted-foreground',
  text: 'fill-muted-foreground',
};

/**
 * kind → 视觉（未知值回落中性灰）。
 *
 * @param kind - 引擎 side 的 `kind`（原样透传，不做大小写归一）
 * @returns 可安全放进 SVG 元素 `className` 的静态字面量集合
 */
export function memoryViewKindVisual(kind: string): MemoryGraphNodeVisual {
  return MEMORY_GRAPH_KIND_VISUALS[kind as MemoryViewMemoryKind] ?? MEMORY_GRAPH_KIND_FALLBACK;
}

/** 关系边视觉（**线型 = 主通道，颜色 = 辅助**） */
export interface MemoryGraphEdgeVisual {
  /** SVG `stroke-dasharray` 值（`null` = 实线）。线型是区分五类边的**主通道** */
  dash: string | null;
  /** 描边类（静态字面量）：三色中性 muted + 两个语义色 */
  stroke: string;
  /**
   * 箭头填充类（**仅 `supersedes` 有**——本批只给 supersedes 画箭头，其余四类方向仓内无据）。
   * ⚠️ 必须是**静态字面量**：Tailwind 扫描不到运行时拼接的 `fill-${...}`，类不会生成 CSS、
   * 箭头会以 SVG 默认黑色渲染且零报错（2026-10-11 复核实测教训）。
   */
  fill?: string;
}

/**
 * 五类边 → 线型 / 颜色（**单一事实源**；图例与画布同源，防静默漂移）。
 *
 * 设计裁决（plan §4.1 / 设计系统 §6.2）：**线型为主通道**——`derived_from` / `supports` /
 * `part_of` 三类的颜色**完全相同**（中性 muted），只靠 dasharray 区分；语义色只给两类：
 * `supersedes` = `--primary`（取代是治理动线上的主线）、`contradicts` = `--destructive`
 * （矛盾是警示）。两条理由：① 五个 kind 已占掉五个色相，再给五类边各一色必然撞车；
 * ② 单靠颜色编码对色觉障碍读者不可用（WCAG 1.4.1 的"不独载语义"同样适用于图）。
 *
 * ⚠️ 线型只在配上 `vector-effect="non-scaling-stroke"` 时才成立：描边宽度默认随
 * `transform` 缩放，0.2 档下 `1 2` 点线会压成亚像素、主通道直接失效（画布组件负责加）。
 */
export const MEMORY_GRAPH_EDGE_VISUALS: Record<MemoryViewRelationType, MemoryGraphEdgeVisual> = {
  supersedes: { dash: null, stroke: 'stroke-primary', fill: 'fill-primary' },
  derived_from: { dash: '6 3', stroke: 'stroke-muted-foreground' },
  supports: { dash: '2 3', stroke: 'stroke-muted-foreground' },
  contradicts: { dash: '8 3 2 3', stroke: 'stroke-destructive' },
  part_of: { dash: '1 2', stroke: 'stroke-muted-foreground' },
};

/**
 * 边类型 → 视觉（域外值回落 `part_of` 的点线中性样式）。
 *
 * 回落刻意**不用实线**：实线是 `supersedes` 的专属编码，误用会让一条未知关系读成"取代"。
 *
 * @param type - 引擎侧的 `edges[].type`
 * @returns 线型 + 描边类
 */
export function memoryViewEdgeVisual(type: string): MemoryGraphEdgeVisual {
  return (
    MEMORY_GRAPH_EDGE_VISUALS[type as MemoryViewRelationType] ?? {
      dash: '1 2',
      stroke: 'stroke-muted-foreground',
    }
  );
}

/** 五类边值域（图例遍历顺序；**引用 shared 单源**，前端不另排一份） */
export const MEMORY_GRAPH_EDGE_TYPES = MEMORY_VIEW_RELATION_TYPES;

/** 节点 kind 值域（孤立区分组顺序；**引用 shared 单源**） */
export const MEMORY_GRAPH_NODE_KINDS = MEMORY_VIEW_MEMORY_KINDS;

/** 分辨率值域（阶梯槽位顺序；**引用 shared 单源**） */
export const MEMORY_GRAPH_RESOLUTIONS = MEMORY_VIEW_RESOLUTIONS;

/**
 * status → 节点不透明度（`superseded` 降权 / `archived` 更灰；`active` 满不透明）。
 *
 * 降透明度是**颜色之外的第二通道**：状态文本恒在 `<title>` 与抽屉里，透明度只是加强
 * （与 `memoryStatusIsDimmed` 的 `opacity-60` 同一手法）。
 *
 * @param status - 引擎侧记忆状态
 * @returns 0..1 的不透明度
 */
export function memoryViewNodeOpacity(status: string): number {
  if (status === MEMORY_VIEW_MEMORY_STATUS.SUPERSEDED) return 0.6;
  if (status === MEMORY_VIEW_MEMORY_STATUS.ARCHIVED) return 0.4;
  return 1;
}

/** 阶梯槽位的展示分叉键（四态**必须分开呈现**，`missing` 是异常信号，与 `beyond` 合并会抹平它） */
export type MemoryLadderSlotKind = 'current' | 'historical' | 'missing' | 'beyond';

/**
 * 阶梯槽位状态 → 展示分叉键
 *
 * @param state - 引擎 `ladder[].state`
 * @returns 分叉键（域外值回落 `beyond`——最保守：不声称"有当前正文"、不声称"数据不完整"）
 */
export function memoryLadderSlotKind(state: string): MemoryLadderSlotKind {
  switch (state) {
    case MEMORY_VIEW_LADDER_STATE.CURRENT_MATERIALIZED:
      return 'current';
    case MEMORY_VIEW_LADDER_STATE.HISTORICAL_ONLY:
      return 'historical';
    case MEMORY_VIEW_LADDER_STATE.MISSING_WITHIN_AVAILABLE:
      return 'missing';
    default:
      return 'beyond';
  }
}

/**
 * 阶梯的默认呈现层级（= `active` 槽）。
 *
 * 用途：history 块在用户**没点任何槽**手动展开时的默认 resolution（契约只保证 `active`
 * 是布尔，不保证恰有一个——故缺失时返回 null，调用方回落 `R0`）。
 *
 * @param ladder - 五槽
 * @returns 默认呈现层级的 resolution，或 null
 */
export function memoryLadderActiveResolution(
  ladder: readonly MemoryViewLadderSlot[],
): string | null {
  return ladder.find((slot) => slot.active)?.resolution ?? null;
}

/**
 * 节点 label 的行宽预算（px，**不是字符数**）——SVG 无自动换行，只能手工切片成 tspan。
 *
 * 口径：盒内容宽 = `MEMORY_GRAPH_NODE_W`(140) − 左右 padding(10×2) = 120px，留 4px 安全边。
 * ⚠️ 与节点盒宽配对——改盒宽不改预算会让文字溢出盒子（布局侧 hook 注释同源指路）。
 * 历史教训：旧常量按字符数切 20/行，校准假设「20 字符 × 12px ≈ 120px」只对纯拉丁成立——
 * 11px 字号下 20 个汉字 ≈ 220px，CJK label 必然溢出盒外（2026-10-11 走查实证）。
 */
export const MEMORY_GRAPH_LABEL_LINE_PX = 116;

/** 省略号占位宽（px）：`…` 按全角字形 ≈ 11px（11px 字号）计 */
export const MEMORY_GRAPH_LABEL_ELLIPSIS_PX = 11;

/**
 * 单字宽度估算（px，11px 字号 Chromium 实测校准，**保守取上界**）。
 *
 * 档位：CJK/全角 = 11（实测 11.0）；ASCII 大写 = 10.5（实测 W=10.38）；小写/数字 = 6.5
 * （实测 a=6.12）；ASCII 空格/窄标点 = 3.5；拉丁扩展/希腊/西里尔 = 6.5；其余非 ASCII
 * （emoji/符号/未列名文字）= 13 上界。宁可低估容量（多截一字）也不许高估（溢出/切半字）。
 * 非 ASCII 兜底必须取上界（终审 P1-1）：低估会走「无需截断」分支，clipPath 在预算处
 * 竖切字形且不补省略号——「半截 label 当全文」正是本批 P0-3 要消灭的缺陷类。
 */
function memoryCharWidthPx(char: string): number {
  const code = char.codePointAt(0) as number;
  if (
    (code >= 0x1100 && code <= 0x11ff) || // 谚文字母
    (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首/假名/统一表意/ CJK 标点
    (code >= 0xac00 && code <= 0xd7af) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0x2013 && code <= 0x2027) || // 破折号/引号/省略号（CJK 文本里按全角渲染）
    (code >= 0x20000 && code <= 0x2a6df) // CJK 扩展 B
  ) {
    return 11;
  }
  if (code >= 0x41 && code <= 0x5a) return 10.5; // A-Z
  if ((code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) return 6.5; // a-z / 0-9
  if (
    (code >= 0x80 && code <= 0x2ff) || // 拉丁扩展/音标
    (code >= 0x370 && code <= 0x52f) || // 希腊/西里尔
    (code >= 0x1e00 && code <= 0x1eff) // 拉丁扩展附加
  ) {
    return 6.5;
  }
  // emoji/符号/未列名文字按最宽上界估（11px 下 emoji 实测 ≈12-13px）：宁可早截带 …
  if (code > 0x7f) return 13;
  return 3.5; // ASCII 空格与窄标点
}

/**
 * 文本行的估算像素宽（11px 字号，四类宽度表求和）。
 *
 * 估算器的职责分层（诚实口径）：它负责「好看」（尽量不切半字、断在词边界），
 * **正确性兜底是节点侧的 clipPath**——任何估算失准都不会让文字渲染出盒子。
 * 纯函数而非运行时测量的理由：jest 跑 jsdom，无 canvas/SVG 布局（`measureText` /
 * `getComputedTextLength` 取不到真值）；图上文字只在容器量出尺寸后挂载，无 SSR 面。
 *
 * @param text - 单行文本
 * @returns 估算宽（px）
 */
export function memoryViewLineWidthPx(text: string): number {
  let width = 0;
  for (const char of text) width += memoryCharWidthPx(char);
  return width;
}

/** 断词字符集（断在该字符**之后**）：空白 / CJK 分句标点 / 常见半角分隔符 */
const MEMORY_LABEL_BREAK_AFTER = new Set([
  ' ',
  '-',
  '/',
  ':',
  '_',
  '.',
  '=',
  '，',
  '。',
  '：',
  '；',
  '、',
  '·',
]);

/** 开括号类（断在该字符**之前**，避免行尾挂开口括号） */
const MEMORY_LABEL_BREAK_BEFORE = new Set(['（', '【', '「', '(', '[']);

/**
 * 单行切片核心：按预算切一刀，返回 [行内文本, 剩余文本]。
 *
 * 断词偏好：累计宽度不超预算的最大切点内，若**尾部 25%** 窗口里存在断词位（可断字符之后 /
 * 开括号之前），断在最后那个断词位；找不到才硬切。空白断点丢弃空白本身，标点断点保留标点。
 */
function sliceLabelLine(text: string, linePx: number): [string, string] {
  const chars = [...text];
  let width = 0;
  let cut = 0;
  let lastBreak = -1; // 切点（第 1 行的排他性结束索引）
  let lastBreakWidth = 0;
  while (cut < chars.length) {
    const charWidth = memoryCharWidthPx(chars[cut]);
    if (width + charWidth > linePx) break;
    width += charWidth;
    cut++;
    if (MEMORY_LABEL_BREAK_AFTER.has(chars[cut - 1])) {
      lastBreak = cut;
      lastBreakWidth = width;
    }
    if (cut < chars.length && MEMORY_LABEL_BREAK_BEFORE.has(chars[cut])) {
      lastBreak = cut;
      lastBreakWidth = width;
    }
  }
  if (cut >= chars.length) return [text, ''];
  if (cut === 0) cut = 1; // 单字超预算的极端兜底：至少切出 1 字，禁止空行死循环
  if (lastBreak > 0 && lastBreakWidth >= width * 0.75) {
    const line = chars.slice(0, lastBreak).join('').replace(/\s+$/, '');
    const rest = chars.slice(lastBreak).join('').replace(/^\s+/, '');
    if (line.length > 0 && rest.length > 0) return [line, rest];
  }
  return [chars.slice(0, cut).join(''), chars.slice(cut).join('')];
}

/**
 * 节点 label → 两行文本（每行估算宽 ≤ `linePx`，第二行溢出时预留省略号位再补 `…`）。
 *
 * 为什么手工切片：SVG `<text>` 不折行（`<foreignObject>` 会带来 HTML 注入面且跨浏览器
 * 渲染不稳），两行 `tspan` + 省略号是零依赖下的唯一解。**全量 label 走原生 `<title>`**
 * 与抽屉（常驻渲染），切片只影响视觉、不丢信息。
 *
 * @param label - 引擎侧 label
 * @param linePx - 每行像素预算（默认 116 = 盒内容宽 120 − 4 安全边，11px 字号）
 * @returns 1~2 行的数组
 */
export function memoryViewLabelLines(
  label: string,
  linePx: number = MEMORY_GRAPH_LABEL_LINE_PX,
): string[] {
  const text = (label ?? '').trim();
  if (memoryViewLineWidthPx(text) <= linePx) return [text];
  const [first, rest] = sliceLabelLine(text, linePx);
  if (rest === '') return [first];
  if (memoryViewLineWidthPx(rest) <= linePx) return [first, rest];
  const [second] = sliceLabelLine(rest, linePx - MEMORY_GRAPH_LABEL_ELLIPSIS_PX);
  return [first, `${second}…`];
}

/**
 * 节点 label → 单行文本（label LOD 档用；截断时**显式补 `…`**）。
 *
 * 背景（P0-3）：label 档只画单行，旧实现截断后不带省略号——读者会把被截断的 label
 * 当成完整文本（静默丢字）。省略号预留 11px，与两行档同一估算器。
 *
 * @param label - 引擎侧 label
 * @param linePx - 单行像素预算（默认同上）
 * @returns 单行文本（溢出时以 `…` 结尾）
 */
export function memoryViewLabelSingleLine(
  label: string,
  linePx: number = MEMORY_GRAPH_LABEL_LINE_PX,
): string {
  const text = (label ?? '').trim();
  if (memoryViewLineWidthPx(text) <= linePx) return text;
  const [first] = sliceLabelLine(text, linePx - MEMORY_GRAPH_LABEL_ELLIPSIS_PX);
  return `${first}…`;
}

/**
 * 账本行 → 引擎记忆 id（**取 `[0]`**）。
 *
 * 口径与 `completeCorrectionLink` 的 `engineMemoryIds?.[0]` 兜底**逐字一致**
 * （`memory-formation.service.ts`）：契约只承诺"恒含主 id"，未承诺首项即主，仓内 `[0]`
 * 是既有约定。长度 >1 时界面必须标注"显示了第 1 条"（`engineMemoryIdCount`）。
 *
 * @param dto - 账本行投影（full 档才有 `engineMemoryIds`）
 * @returns 引擎记忆 id，或 null（空数组 = 更正/提名形成后才产生引擎记忆）
 */
export function memoryViewEngineMemoryId(
  dto: Pick<MemoryNominationDto, 'engineMemoryIds'>,
): string | null {
  const ids = dto.engineMemoryIds;
  if (!ids || ids.length === 0) return null;
  return ids[0] ?? null;
}

/**
 * 账本行的引擎记忆条数（长度 >1 时阶梯块要标注"此处显示第 1 条"）。
 *
 * @param dto - 账本行投影
 * @returns 条数（缺字段时 0）
 */
export function memoryViewEngineMemoryCount(
  dto: Pick<MemoryNominationDto, 'engineMemoryIds'>,
): number {
  return dto.engineMemoryIds?.length ?? 0;
}

/**
 * 图 → 详情的钻取出口：`engine_memory_id` → 账本行 id。
 *
 * `ledgerMapping` **只含可见节点**，故拿不到就是"这个节点在图上不该存在"（未映射 /
 * 来源不可见）——调用方据此把"打开完整详情"渲染成禁用态而不是死链。
 *
 * @param mapping - 累积合并后的映射（跨页合并，见 `mergeMemoryGraphPages`）
 * @param memoryId - 引擎记忆 id
 * @returns 账本行 id，或 null
 */
export function memoryGraphLedgerId(
  mapping: Record<string, string> | undefined,
  memoryId: string,
): string | null {
  return mapping?.[memoryId] ?? null;
}

// ── 累积页合并（cursor 分页）────────────────────────────────────────────────

/** cursor 分页的累积态（组件 state；**与过滤器同生命周期**，过滤器一变就清空） */
export interface MemoryGraphPages {
  /** 已加载节点（按页序累积，去重保序） */
  nodes: MemoryViewGraphNode[];
  /** 已加载边 */
  edges: MemoryViewEdge[];
  /** 节点映射（与 nodes **同步累积**——翻页后早期页节点也要能钻取） */
  ledgerMapping: Record<string, string>;
  /** 各页信封的平台计数（取**最大值**合并：单页的计数是引擎口径、不随页数增长） */
  filteredNodeCount: number;
  filteredEdgeCount: number;
  unmappedCount: number;
  /**
   * 引擎口径的 `omitted_edge_count`（**同样取最大值合并**）。
   *
   * 并进累积态而不是读"最后一页的响应"：那个数字会随翻页跳变（各页各自算一次），
   * 治理条上的数字忽大忽小会让读者以为图在变。取最大值是保守下界（不夸大省略量）。
   */
  omittedEdgeCount: number;
  /** 是否任一分页被截断 / 部分返回 */
  partial: boolean;
  truncated: boolean;
  /** 下一页 cursor（空串 = 没有更多） */
  nextCursor: string;
}

/** 累积态的空值（过滤器变更 / 快照重置时回到这里） */
export function emptyMemoryGraphPages(): MemoryGraphPages {
  return {
    nodes: [],
    edges: [],
    ledgerMapping: {},
    filteredNodeCount: 0,
    filteredEdgeCount: 0,
    unmappedCount: 0,
    omittedEdgeCount: 0,
    partial: false,
    truncated: false,
    nextCursor: '',
  };
}

/**
 * 把一页 graph 响应并进累积态。
 *
 * 三处刻意设计：
 * - **节点 / 边 / 映射同步累积**（N3）：只累积 nodes 而漏掉 `ledgerMapping`，会让"翻页后
 *   早期页的节点点不开详情"——那正是钻取入口存在的意义；
 * - **平台计数取最大值而不是相加**：它们是单次响应的口径（"本次被过滤了多少"），
 *   相加会把同一批过滤数重复计入；取最大值是保守下界（不夸大隐藏量）；
 * - **去重保序**：同一节点理论上不会跨页出现（引擎按 `memory_id` 切片），去重是防御。
 *
 * @param pages - 现有累积态
 * @param response - 新到的一页
 * @returns 新的累积态
 */
export function mergeMemoryGraphPages(
  pages: MemoryGraphPages,
  response: MemoryGraphViewResponse,
): MemoryGraphPages {
  const seenNodes = new Set(pages.nodes.map((node) => node.memory_id));
  const nodes = pages.nodes.slice();
  for (const node of response.engine.nodes) {
    if (seenNodes.has(node.memory_id)) continue;
    seenNodes.add(node.memory_id);
    nodes.push(node);
  }
  const seenEdges = new Set(pages.edges.map((edge) => edge.relation_id));
  const edges = pages.edges.slice();
  for (const edge of response.engine.edges) {
    if (seenEdges.has(edge.relation_id)) continue;
    seenEdges.add(edge.relation_id);
    edges.push(edge);
  }
  return {
    nodes,
    edges,
    ledgerMapping: { ...pages.ledgerMapping, ...response.ledgerMapping },
    filteredNodeCount: Math.max(pages.filteredNodeCount, response.filteredNodeCount),
    filteredEdgeCount: Math.max(pages.filteredEdgeCount, response.filteredEdgeCount),
    unmappedCount: Math.max(pages.unmappedCount, response.unmappedCount),
    omittedEdgeCount: Math.max(
      pages.omittedEdgeCount ?? 0,
      response.engine.omitted_edge_count ?? 0,
    ),
    partial:
      pages.partial || response.engine.node_page.partial || response.engine.edge_page.partial,
    truncated:
      pages.truncated || response.engine.node_page.truncated || response.engine.edge_page.truncated,
    nextCursor: response.engine.node_page.next_cursor ?? '',
  };
}

// ── 错误分叉（views 族；与账本族的 memoryErrorKind 分开）─────────────────────

/** 后端错误码（views 族新增两个；其余复用共享值域语义） */
export const MEMORY_VIEW_ERROR_CODE = {
  /** 503：引擎动词不可用（`data.reason` 与 engineAvailability.reason 共用映射） */
  MEMORY_UNAVAILABLE: 14000,
  /** 502：引擎返回了 4xx/5xx 或不可解析响应（`data.engineCode` 原样透传） */
  MEMORY_ENGINE_ERROR: 14004,
  /** 404：账本行 / 引擎记忆不可见（不泄露存在性） */
  MEMORY_NOMINATION_NOT_FOUND: 14003,
} as const;

/** views 族错误分叉判据 */
export interface MemoryViewErrorKind {
  status: number | null;
  code: number | null;
  /** 404/14003：映射缺失或来源不可见（**块内文案，不给通用重试**） */
  notFound: boolean;
  /** 503/14000：引擎不可用（降级条文案复用 engine-status） */
  engineUnavailable: boolean;
  /** 502/14004：引擎返回错误（`engineCode` 决定文案分叉） */
  engineError: boolean;
  /** 引擎侧错误码（`snapshot_stale` / `invalid_argument` / …；缺失时 null） */
  engineCode: string | null;
}

/**
 * views 族错误 → 分叉判据（**唯一实现**：图页与详情页两块共用）。
 *
 * 与账本族的 `memoryErrorKind` 分开的理由：这两族的**下一步动作不同**——账本的 404 是
 * "回账本换一行"，views 的 404 是"这条账本行还没有引擎投影"；账本没有 502/14004 这一档。
 *
 * @param error - 抛出的错误（axios 形态）
 * @returns 分叉判据
 */
export function memoryViewErrorKind(error: unknown): MemoryViewErrorKind {
  const err = error as {
    response?: {
      status?: number;
      data?: { code?: number; data?: { engineCode?: string } };
    };
  };
  const status = err?.response?.status ?? null;
  const code = err?.response?.data?.code ?? null;
  return {
    status,
    code,
    notFound: status === 404 && code === MEMORY_VIEW_ERROR_CODE.MEMORY_NOMINATION_NOT_FOUND,
    engineUnavailable: status === 503 && code === MEMORY_VIEW_ERROR_CODE.MEMORY_UNAVAILABLE,
    engineError: status === 502 && code === MEMORY_VIEW_ERROR_CODE.MEMORY_ENGINE_ERROR,
    engineCode: err?.response?.data?.data?.engineCode ?? null,
  };
}

/**
 * 是否应触发"丢弃累积页 + 重拉第一页"的**统一重置**。
 *
 * 谓词刻意**只看 HTTP 码与业务码**（502/14004），**不看 `engineCode`**：cursor 失效有
 * **双通道**——409 `snapshot_stale`（快照变了）与 400 `invalid_argument`（携 cursor 改了
 * 任一过滤器）。把谓词写窄成"只看 snapshot_stale"会让 invalid_argument 一路漏到界面上
 * （页面停在半截图上，零反馈）。
 *
 * @param error - 抛出的错误
 * @returns true = 重置并重拉第一页
 */
export function memoryViewNeedsReset(error: unknown): boolean {
  return memoryViewErrorKind(error).engineError;
}

/** 状态条文案分叉键（**必须按 engineCode 分叉**，统一谓词下两种成因的下一步动作不同） */
export type MemoryViewResetKind = 'stale' | 'other';

/**
 * 引擎侧错误码（**引擎透传值，不是平台码**）。
 *
 * 这两个值来自 hument 的错误响应（`internal/app/workbench_projection.go` 的
 * `decodeWorkbenchProjectionCursor`），平台层原样透传到 `data.engineCode`。
 */
export const MEMORY_VIEW_ENGINE_CODE = {
  /** 快照在翻页途中变化（cursor 绑 snapshot_digest） */
  SNAPSHOT_STALE: 'snapshot_stale',
  /** 携 cursor 改了过滤器（cursor 同时绑 query_digest） */
  INVALID_ARGUMENT: 'invalid_argument',
} as const;

/**
 * 重置原因 → 文案分叉键。
 *
 * 为什么必须分叉：统一谓词（任何带 cursor 的 502/14004）覆盖了两种成因——
 * `snapshot_stale` / `invalid_argument` = "引擎数据已变化，重拉第一页就够了"；
 * 其它 engineCode = "引擎真的报错，重拉只是兜底，还可能要稍后重试"。
 * 用一个文案盖住两者，就会对非 stale 的 502 **说假话**。
 *
 * @param engineCode - 引擎侧错误码
 * @returns 分叉键
 */
export function memoryViewResetKind(engineCode: string | null): MemoryViewResetKind {
  if (engineCode === MEMORY_VIEW_ENGINE_CODE.SNAPSHOT_STALE) return 'stale';
  if (engineCode === MEMORY_VIEW_ENGINE_CODE.INVALID_ARGUMENT) return 'stale';
  return 'other';
}
