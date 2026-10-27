/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **§7 状态机映射表**的实现：把引擎回执 / 失败面（Hument 原始信号）翻译成 Chamber 的
 *     `formation_state` + `recovery_path` + 可采纳的 `memoryIds`。**纯函数**，无 IO、无 Logger
 *
 * [代码职责]
 *   - `mapFormationState(signal)`：§7 全表逐值的唯一入口（**diagnostics.outcome 优先、
 *     job_state 回退**；未映射信号落默认行 `unknown`，绝不落 committed）
 *   - `MEMORY_RECOVERY_PATHS` / `MemoryRecoveryPath`：`recovery_path` 值域单源
 *     （`memory_formation_events.recovery_path` 列 + 服务层恢复三通道共用）
 *   - `MEMORY_UNRESUMABLE_RECOVERY_PATHS`：**扫描排除集**（§7：恒错行不得参与自动重扫）
 *   - `FormationSignal`：映射入参（引擎成功面字段 + 失败面字段的并集，全部可选）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §7 状态机映射表（**活文档逐值单测**）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 合同事实源（只读）: Hument 仓 `contracts/schema/memory-nomination-response.schema.json`
 *     （`job_state` / `error_code`）、`memory-nomination-diagnostics.schema.json`
 *     （`outcome` / `reason_code` / `mutation.memory_ids`）、`error.schema.json`（`code` 值域）
 *
 * [关键不变量]
 *   - **本文件的优先级序 = §7 表行序**（下表每行都标了 §7 行号）；改顺序前先改 §7，
 *     否则映射与活文档分叉而单测仍在绿。
 *   - **diagnostics.outcome 优先于 job_state**：`outcome=memory_committed` 即使
 *     `job_state=committing` 也按 committed 采纳 ids（§7 第 1 行）；反之
 *     §7 第 2 行明确"**即使 job_state=committed**"，`no_memory` / `no_change_validated`
 *     仍是 `no_memory` 且**不写 ids**。
 *   - **alias（`duplicate=true`）最先判**（§7 第 12 行的语义前提）：alias 回执**不推进 job**
 *     （方案 §1），且 alias 正文与 canonical 逐字节相同、ids 恒 NULL——若按表行序把它排在
 *     outcome 轴之后，一条 `duplicate=true + outcome=memory_committed` 的回执会被误判成
 *     canonical 行并写 ids（把"我没形成记忆"记成"我形成了"）。
 *   - **alias 的镜像态不由本函数猜**：§7 第 12 行要求"镜像 canonical 行**当前** formation_state
 *     （含非终态、纳入扫描）"——那是 DB 侧事实，纯函数拿不到。故 alias 分支返回
 *     `formationState: null` + `mirrorCanonicalNominationId`，由服务层查 canonical 行后镜像；
 *     **无 canonical 线索时（`mirrorCanonicalNominationId === null`）服务层落 `conflict`**
 *     （§7：canonical 不在本项目 → conflict）。
 *   - **committing 不采纳 ids**（§7 第 7 行）：`committing` 是"正在提交"的中间态，此时带的
 *     ids 可能尚未落定（Hument 合同里 `committing` 与 `committed` 是不同 job_state）。
 *   - **默认行 = `unknown`（fail-safe）**：任何未映射信号绝不落 `committed`——把未识别的回执
 *     记成"已形成"会让召回映射指向不存在的 memory，且错误只能在消费侧暴露。
 *   - **`inspect_backfill` 在 §7 表里没有赋值行**：它属于 `recovery_path` 值域（恢复三通道
 *     的 inspect 回填动作），但 §7 映射表没有任何一行产出它——故本函数**永不返回**该值
 *     （服务层的恢复通道才可能写它）。这是刻意的：值域完整 ≠ 每一行都要出现在映射里。
 *   - **本文件不认识 HTTP**：`httpStatus` / `failureKind` 只是入参（由引擎层翻译好）；
 *     409 → conflict 之所以在这里判，是因为它就是 §7 的一行，而不是因为本层解析了协议。

 * [关联代码]
 *   - engines/memory-engine.interface.ts — `FormationSignal` 的字段来源（`MemoryNominationResult` /
 *     `MemoryEngineFailure`）
 *   - engines/hument.engine.ts — 产出信号（含 diagnostics / error.code 解析）
 *   - packages/shared/src/enums/index.ts — `MEMORY_FORMATION_STATES` / `MEMORY_FORMATION_OUTCOME`
 *     值域单源
 *   - database/entities/memory-formation-event.entity.ts — `recovery_path` 的落库列
 *
 * [持久踩坑]
 *   MEMORY-MAP-JOBSTATE-FIRST(用 job_state 先判): 直接看 `job_state=committed` 就写 committed，
 *     会把 §7 第 2 行的 `no_memory`（引擎明确说"无需记忆"）记成成功——`no_change_validated`
 *     恰好在 `job_state=committed` 下出现（Hument 先落 job 再判无实质变化）。
 *     安全方向: outcome/reason_code 轴先判，job_state 只做回退。
 *   MEMORY-MAP-DEFAULT-COMMITTED(默认行落 committed): 未识别信号落 committed = 召回时
 *     拿着不存在的 memory_id 去查（表现为"记忆凭空消失"而非报错）。安全方向: 默认 unknown。
 *
 * [修改检查]
 *   □ 已读 [权威文档] 的 §7 全表，逐行核对本文件的 switch 分支与注释行号
 *   □ 改映射必须同步单测的逐值用例（§7 是活文档：改代码不改表 = 文档撒谎）
 *   □ 新增 recovery_path 值必须同时更新扫描排除集与 `MEMORY_RECOVERY_PATHS`
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { MEMORY_FORMATION_STATE, type MemoryFormationState } from '@agent-chamber/shared';
import type { MemoryEngineFailureKind } from './memory-engine.interface';

/**
 * `recovery_path` 值域（单源；`memory_formation_events.recovery_path` 列 + 服务层恢复通道）。
 *
 * ⚠️ **未入 shared enums 是刻意的**：`memory-formation-event.entity.ts` 已记下该决定
 * （方案 §2 未把它列为 shared 词表；写入点集中在本模块），在此定义让 §7 映射表与落库列
 * 共用同一份字面量——比"服务层各自写字符串"多一层保护，又不把 memory 内部词表塞进 shared。
 *
 * - `same_key_resend`：平台用账本行的引擎幂等键续跑（`POST /memory/nominations/:id/retry`）——
 *   **唯一的自动重试路径**；同 `clientRequestId` 的 POST 只回放记录结果，不推进 job
 * - `inspect_backfill`：inspect 回填（恢复三通道的只读回查；**§7 映射表无产出行**，服务层用）
 * - `hub_manual_required`：须 Owner/Hub 人工处置（rejected / unknown）
 * - `config_invalid`：配置错（绑定/凭据），重试无效
 * - `param_invalid`：参数错，须**换新 client_request_id** 重提
 */
export const MEMORY_RECOVERY_PATHS = [
  'same_key_resend',
  'inspect_backfill',
  'hub_manual_required',
  'config_invalid',
  'param_invalid',
] as const;

/** `recovery_path` 值 */
export type MemoryRecoveryPath = (typeof MEMORY_RECOVERY_PATHS)[number];

/**
 * 自动重扫（启动扫描 / `POST recover`）的**排除集**（§7 末段定死）。
 *
 * rationale：这三类是**恒错**行（配置错 / 参数错 / 须人工），参与自动重扫只会反复重发
 * 并烧配额。排除后它们仍需可见——靠 `POST retry`（单行显式续跑）与详情页文案处置。
 */
export const MEMORY_UNRESUMABLE_RECOVERY_PATHS: readonly MemoryRecoveryPath[] = [
  'hub_manual_required',
  'config_invalid',
  'param_invalid',
];

/**
 * Hument `diagnostics.outcome` 值域（合同 5 值）+ §7 表在 outcome 列引用的两个 reason_code 同义值。
 *
 * ⚠️ 合同事实源：`memory-nomination-diagnostics.schema.json` 的 `outcome` enum 只有
 * `memory_committed` / `no_memory` / `deferred` / `rejected` / `unknown`；§7 表写的
 * `outcome=no_change_validated` 与 `outcome=provider_outcome_unknown` 在合同里其实是
 * `reason_code` 值——两轴在这里**并列**（同一个 switch，见 §7 行注），这样无论 Hument 把
 * 信号放在哪一轴都不会漏判。
 */
const HUMENT_OUTCOME = {
  MEMORY_COMMITTED: 'memory_committed',
  NO_MEMORY: 'no_memory',
  NO_CHANGE_VALIDATED: 'no_change_validated',
  DEFERRED: 'deferred',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown',
  PROVIDER_OUTCOME_UNKNOWN: 'provider_outcome_unknown',
} as const;

/** Hument `diagnostics.reason_code` 里 §7 用到的两个值（其余 reason_code 不改变分派） */
const HUMENT_REASON_CODE = {
  NO_CHANGE_VALIDATED: 'no_change_validated',
  PROVIDER_OUTCOME_UNKNOWN: 'provider_outcome_unknown',
} as const;

/** Hument `job_state` 值域（合同 10 值；§7 回退轴） */
const HUMENT_JOB_STATE = {
  PENDING: 'pending',
  CLAIMED: 'claimed',
  PROVIDER_INFLIGHT: 'provider_inflight',
  PROVIDER_OUTCOME_UNKNOWN: 'provider_outcome_unknown',
  PROVIDER_REJECTED: 'provider_rejected',
  NO_MATERIAL: 'no_material',
  PROPOSED: 'proposed',
  COMMITTING: 'committing',
  VALIDATION_REJECTED: 'validation_rejected',
  COMMITTED: 'committed',
} as const;

/**
 * 在途 job_state（§7 第 6 行）——**非终态**，收敛动作 = 平台用账本行幂等键续跑（retry；inspect 只读不推进 job）。
 *
 * ⚠️ 合同里 `provider_rejected` / `validation_rejected` **不在此集合**：它们是终态拒绝。
 * 无 diagnostics outcome 的退化路径（缺 header 时）只有 job_state 可判——映射为 §7 第 3 行的
 * 同义形态 `rejected + hub_manual_required`（见下方 job_state switch 的对应 case），
 * **不落默认行 unknown**：rejected 可走 Owner recovery（POST recover 只收 rejected），
 * unknown 在 Chamber 侧不可恢复——映错会把可恢复的拒绝冻结成"永久不可恢复"，
 * 且两者的运维处置文案（修后重提 vs 无从处置）完全不同。
 */
const IN_FLIGHT_JOB_STATES: readonly string[] = [
  HUMENT_JOB_STATE.PENDING,
  HUMENT_JOB_STATE.CLAIMED,
  HUMENT_JOB_STATE.PROVIDER_INFLIGHT,
  HUMENT_JOB_STATE.PROPOSED,
];

/** `error.code` → 配置错族（§7 第 13 行；**重试无效**，须修注册表/凭据） */
const CONFIG_ERROR_CODES: readonly string[] = ['binding_not_found', 'scope_denied'];

/** `error.code` → 参数错族（§7 第 14 行；须**换新 client_request_id** 重提） */
const PARAM_ERROR_CODES: readonly string[] = ['invalid_argument', 'budget_too_small'];

/** `error.code` → 可重试族（§7 第 15 行；稍后**同 key**重试安全） */
const RETRYABLE_ERROR_CODES: readonly string[] = [
  'provider_unavailable',
  'overloaded',
  'cell_unavailable',
];

/**
 * 映射入参：引擎成功面（`MemoryNominationResult` 结构上可直接传入）+ 失败面字段。
 *
 * 全部可选（除两个布尔）的 rationale：成功回执与失败面是**同一决策的两条输入路径**，
 * 合成一个"信号"对象让映射只有一个入口（两个入口 = 两条优先级实现 = 迟早分叉）。
 */
export interface FormationSignal {
  /** 引擎判定重复（alias）；`true` ⇒ 走镜像分支（最先判，见文件头不变量） */
  duplicate: boolean;
  /** 引擎明示延后（`durable=false` 的反面；§7 第 5 行后半句） */
  deferred: boolean;
  /** 引擎侧提名 ID（诊断用） */
  engineNominationId?: string;
  /** alias 回执的 canonical 提名 ID（镜像源；缺失 ⇒ 服务层落 conflict） */
  canonicalNominationId?: string;
  /** Hument `job_state` 原值（回退轴） */
  jobState?: string;
  /** `diagnostics.outcome`（优先轴） */
  outcome?: string;
  /** `diagnostics.reason_code`（同轴并列） */
  reasonCode?: string;
  /** `diagnostics.mutation.memory_ids`（committed 才采纳） */
  memoryIds?: string[];
  /** 错误体 `retryable`（分派以 `error.code` 为准，本字段仅落遥测） */
  retryable?: boolean;
  /** 错误体 `error.code` 或回执 `error_code` */
  engineCode?: string;
  /** `request_id` / `X-Request-ID`（遥测） */
  requestId?: string;
  /** 回执 `durable`；`false` ⇒ §7 第 9 行（请求未到达） */
  durable?: boolean;
  /** 失败分类（引擎层翻译；见 `MemoryEngineFailureKind`） */
  failureKind?: MemoryEngineFailureKind;
  /** 失败时的 HTTP 状态码（409 / 500 两行靠它分派） */
  httpStatus?: number;
}

/**
 * 映射产物（§7 三列 + alias 镜像标记）。
 *
 * - `formationState: null` ⇔ **alias 行**（由服务层镜像 canonical 行当前态；见文件头不变量）
 * - `recoveryPath: null` = §7 表里的"—"（终态或须人工且无自动路径）
 * - `memoryIds`：**只在该采纳时才非空**（committed）；committing / no_memory / rejected /
 *   alias / 失败面一律空数组——服务层必须按它写入，不得自行取 originalSignal.memoryIds
 */
export interface FormationMapping {
  /** 归一化形成态；`null` = alias（镜像 canonical 行） */
  formationState: MemoryFormationState | null;
  /** 恢复路径；`null` = §7 表的"—" */
  recoveryPath: MemoryRecoveryPath | null;
  /** 可采纳的引擎 memory ids（空数组 = 不写 ids） */
  memoryIds: string[];
  /** alias 镜像源（canonical 提名 id）；非 alias 恒 `null` */
  mirrorCanonicalNominationId: string | null;
}

/** 去空去重的 ids 归一（Hument 合同 `uniqueItems`，但仍防脏数据进映射） */
function normalizeIds(ids: string[] | undefined): string[] {
  if (!ids?.length) return [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) seen.add(id);
  }
  return [...seen];
}

/** §7 第 1 行：`committed` + 采纳 ids */
function committed(memoryIds: string[]): FormationMapping {
  return {
    formationState: MEMORY_FORMATION_STATE.COMMITTED,
    recoveryPath: null,
    memoryIds,
    mirrorCanonicalNominationId: null,
  };
}

/** §7 第 2 行：`no_memory`（**不写 ids**） */
function noMemory(): FormationMapping {
  return {
    formationState: MEMORY_FORMATION_STATE.NO_MEMORY,
    recoveryPath: null,
    memoryIds: [],
    mirrorCanonicalNominationId: null,
  };
}

/** §7 第 5/6/7/8 行：`submitted`（非终态；平台以账本行幂等键续跑） */
function submitted(): FormationMapping {
  return {
    formationState: MEMORY_FORMATION_STATE.SUBMITTED,
    recoveryPath: 'same_key_resend',
    memoryIds: [],
    mirrorCanonicalNominationId: null,
  };
}

/** §7 第 3/4 行：`rejected` / `unknown`（Hument 终态；须 Owner/Hub 人工） */
function hubManual(state: MemoryFormationState): FormationMapping {
  return {
    formationState: state,
    recoveryPath: 'hub_manual_required',
    memoryIds: [],
    mirrorCanonicalNominationId: null,
  };
}

/** §7 第 9/13/14/15 行：`failed` + 三类恢复路径 */
function failed(recoveryPath: MemoryRecoveryPath): FormationMapping {
  return {
    formationState: MEMORY_FORMATION_STATE.FAILED,
    recoveryPath,
    memoryIds: [],
    mirrorCanonicalNominationId: null,
  };
}

/**
 * §7 末行：默认 fail-safe（未映射信号 ⇒ `unknown`，**绝不落 committed**）。
 *
 * `recoveryPath` 置 `null`（表里是"—"）：它既不是自动重发也不是已知人工族——
 * 服务层的启动扫描会带上它（非终态 + 不在排除集），故仍有机会在补齐信息后被处理。
 */
function unknownFallback(): FormationMapping {
  return {
    formationState: MEMORY_FORMATION_STATE.UNKNOWN,
    recoveryPath: null,
    memoryIds: [],
    mirrorCanonicalNominationId: null,
  };
}

/**
 * §7 状态机映射（**纯函数**；全表逐值，分支顺序即 §7 行序，见文件头不变量）。
 *
 * @param signal 引擎信号（成功回执字段 + 失败面字段的并集；见 `FormationSignal`）
 * @returns `{formationState, recoveryPath, memoryIds, mirrorCanonicalNominationId}`
 */
export function mapFormationState(signal: FormationSignal): FormationMapping {
  const ids = normalizeIds(signal.memoryIds);

  // ── §7 第 12 行（**提前判**，理由见文件头）：alias —— 镜像标记由返回形状承载 ──
  if (signal.duplicate === true) {
    return {
      // null = "由服务层镜像 canonical 行当前态（含非终态）"，本函数不猜
      formationState: null,
      recoveryPath: null,
      // alias 行 ids 恒 NULL（方案 §2）——即使回执带了 ids 也不采纳
      memoryIds: [],
      mirrorCanonicalNominationId: signal.canonicalNominationId ?? null,
    };
  }

  // ── §7 第 1-5 行：diagnostics.outcome 轴（**优先**；缺 header 时整轴缺席 ⇒ 回退） ──
  switch (signal.outcome) {
    // 第 1 行：memory_committed（**即使 job_state=committing 也按诊断轴采信**）
    case HUMENT_OUTCOME.MEMORY_COMMITTED:
      return committed(ids);
    // 第 2 行：no_memory / no_change_validated（**即使 job_state=committed**）
    case HUMENT_OUTCOME.NO_MEMORY:
    case HUMENT_OUTCOME.NO_CHANGE_VALIDATED:
      return noMemory();
    // 第 3 行：rejected（Hument 终态；勿重试，Owner recovery）
    case HUMENT_OUTCOME.REJECTED:
      return hubManual(MEMORY_FORMATION_STATE.REJECTED);
    // 第 4 行：unknown / provider_outcome_unknown（Hument 终态但 **Chamber 不可恢复**）
    case HUMENT_OUTCOME.UNKNOWN:
    case HUMENT_OUTCOME.PROVIDER_OUTCOME_UNKNOWN:
      return hubManual(MEMORY_FORMATION_STATE.UNKNOWN);
    // 第 5 行：deferred（显式延后 ⇒ 非终态，同 key 重发）
    case HUMENT_OUTCOME.DEFERRED:
      return submitted();
    default:
      break;
  }

  // ── §7 第 2/4 行的**同轴并列**：reason_code（合同里这两个值确实在 reason_code 轴） ──
  switch (signal.reasonCode) {
    case HUMENT_REASON_CODE.NO_CHANGE_VALIDATED:
      return noMemory();
    case HUMENT_REASON_CODE.PROVIDER_OUTCOME_UNKNOWN:
      return hubManual(MEMORY_FORMATION_STATE.UNKNOWN);
    default:
      break;
  }

  // ── §7 第 5 行后半句：deferred 标志（与 outcome 无关的明示延后） ──
  if (signal.deferred === true) return submitted();

  // ── §7 第 6-8 行：job_state 回退轴 ──
  switch (signal.jobState) {
    // 第 1 行括号内：job_state=committed **且 memory_ids 非空** 才算 committed
    case HUMENT_JOB_STATE.COMMITTED:
      if (ids.length > 0) return committed(ids);
      // ids 为空 ⇒ 落默认行（fail-safe：绝不凭一个 job_state 落 committed）
      return unknownFallback();
    // 第 7 行：committing（**ids 不采纳**——在途中间态）
    case HUMENT_JOB_STATE.COMMITTING:
      return submitted();
    // 第 8 行：no_material（finish 前中断残留；finish 后 Hument 自改写）
    case HUMENT_JOB_STATE.NO_MATERIAL:
      return submitted();
    // 第 4 行：provider_outcome_unknown（合同里它也是 job_state 值）
    case HUMENT_JOB_STATE.PROVIDER_OUTCOME_UNKNOWN:
      return hubManual(MEMORY_FORMATION_STATE.UNKNOWN);
    // 第 3 行的退化形态（无 diagnostics outcome，仅凭 job_state 判终态拒绝）：
    // rejected 可 Owner recovery / unknown 在 Chamber 侧不可恢复——落默认行 unknown
    // 会把可恢复的拒绝冻错状态并给出错误的运维文案（见 IN_FLIGHT_JOB_STATES 上方注释）
    case HUMENT_JOB_STATE.PROVIDER_REJECTED:
    case HUMENT_JOB_STATE.VALIDATION_REJECTED:
      return hubManual(MEMORY_FORMATION_STATE.REJECTED);
    default:
      break;
  }
  if (signal.jobState !== undefined && IN_FLIGHT_JOB_STATES.includes(signal.jobState)) {
    return submitted();
  }

  // ── §7 第 9-10 行：请求未到达 / 无回执 ──
  if (signal.failureKind === 'timeout') {
    // 第 10 行：客户端超时（**无回执**）⇒ unknown；平台以账本行幂等键续跑（retry）
    return {
      formationState: MEMORY_FORMATION_STATE.UNKNOWN,
      recoveryPath: 'same_key_resend',
      memoryIds: [],
      mirrorCanonicalNominationId: null,
    };
  }
  if (signal.failureKind === 'unreachable') {
    // 第 9 行：连接拒绝（未到达）⇒ failed；平台可用账本行幂等键续跑本行
    return failed('same_key_resend');
  }
  if (signal.durable === false) {
    // 第 9 行：durable=false（未耐久落盘）——两种表现（500 回执 / 200 但 durable=false）同归
    return failed('same_key_resend');
  }
  if (signal.httpStatus === 500) {
    // 第 9 行：500（Hument 口径 = "source durability 之前的意外失败"）
    return failed('same_key_resend');
  }

  // ── §7 第 11 行：引擎 409（配额 / 精确重复 / 命名空间前缀 / 幂等冲突等多因）——
  //    **归一化仍同形**：conflict + 人工处置。逐因的**动作**由引擎诊断（admissionCause）
  //    在 hintCode 层给出；本层不做分因（归一化与文案分派是两层，别在这里拆） ──
  if (signal.httpStatus === 409) {
    return {
      formationState: MEMORY_FORMATION_STATE.CONFLICT,
      recoveryPath: null,
      memoryIds: [],
      mirrorCanonicalNominationId: null,
    };
  }

  // ── §7 第 13-15 行：error.code 三族（顺序固定：配置 → 参数 → 可重试） ──
  if (signal.engineCode !== undefined) {
    if (CONFIG_ERROR_CODES.includes(signal.engineCode)) return failed('config_invalid');
    if (PARAM_ERROR_CODES.includes(signal.engineCode)) return failed('param_invalid');
    if (RETRYABLE_ERROR_CODES.includes(signal.engineCode)) return failed('same_key_resend');
  }

  // ── §7 第 16 行：默认行（`invalid_response`、未枚举的 error.code、空回执……） ──
  return unknownFallback();
}
