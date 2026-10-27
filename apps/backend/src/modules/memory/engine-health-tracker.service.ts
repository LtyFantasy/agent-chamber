/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **引擎运行时健康观测**（卡 26c43f52；卡 5e6cb000 改通道）：Memory 引擎"已配置但连续失败"
 *     的近实时告警。检测点在引擎端口层（`InstrumentedMemoryEngine` 逐次上报 +
 *     `EngineHealthProbeService` 每 120s 就绪探测），本文件是那双路判据的**双臂状态机 + 告警派发**。
 *   - **终态三通道（2026-10-23 Owner 拍板）**：① notify `system_alert`（推送给 admin 账号绑定的
 *     通信渠道）② `ENGINE_HEALTH_VIEW`（`/health/ready` 的 `optional.memoryEngine` 查询面，
 *     agent/探针主动查）③ 日志（`MEMORY_ENGINE_ALERT`，运行日记兜底）。
 *     **Topic 通道已整体拆除**（原设计零消费者，违背"增量拉取优先"支柱）。
 *
 * [代码职责]
 *   - 双臂状态机（A = availability / B = auth-binding）的事件转移（逐行见下「事件转移表」）
 *   - 告警置位与派发**解耦**（置位同步、派发 fire-and-forget **单链 `.then().catch()`**，
 *     **不做应用层重投**——at-least-once 由 provider 内部重试 + 下一次心跳承担）
 *   - 分臂**诚实态**心跳（前 3 条 60min，之后 240min；内容随该臂当前证据变化）
 *   - `getHealthSnapshot()`：只读证据快照（`ENGINE_HEALTH_VIEW` 每次请求现算的唯一输入）
 *   - `resetForTest()`：**测试专用**复位（e2e 隔离；生产不调用）
 *
 * [事件转移表]（**实现与评审都以本表为据**；改本文件先改表）
 *   | 事件 | 判据 | 迁移 |
 *   |---|---|---|
 *   | `callOk` | 业务调用 ok | A.callCons=0/callFirstAt=null；B.cons=0/firstAt=null；
 *   |          |             | B.alerted → 恢复 B；A.alerted 且**探针已禁用** → 恢复 A |
 *   | `callFailA` | kind∈{timeout,unreachable} / http≥500 / `invalid_response` **且非**
 *   |          | `usageRejection='target_mismatch'`（后者归 B 臂） |
 *   |          |             | A.callCons++/firstAt??=now；B 不动；callCons≥5 && !A.alerted → 告警 A |
 *   | `callFailB` | http 401/403（含 403+`binding_not_found`；hument 对该码回 403，**无 404 臂**）
 *   |          | 或 `invalid_response` + `usageRejection='target_mismatch'`（身份回声不符 = 授权面）|
 *   |          |             | B.cons++/firstAt??=now；**A.callCons=0/callFirstAt=null**（回结构化错 = 活着）；
 *   |          |             | cons≥5 && !B.alerted → 告警 B |
 *   | `callNonCounted` | 其余 4xx（400/409/422/其他 404） |
 *   |          |             | A.callCons=0；B.cons=0（应答 + 凭据通过 = 双路清零）；**不触发** |
 *   | `probeOk` | healthCheck ok | A.probeCons=0/firstAt=null/`probeOkStreak++`/**lastProbeOkAt=now**；
 *   |          |             | A.alerted && probeOkStreak≥2 → 恢复 A（连带 A.callCons=0） |
 *   | `probeFail` | **`!ok` 全收**（ready 无逐请求合法失败；404=baseUrl 配错也是部署故障）|
 *   |          |             | A.probeCons++/firstAt??=now/probeOkStreak=0；probeCons≥3 && !A.alerted → 告警 A |
 *   | `tick`（随探针 cron，120s） | 每臂：`!alerted && cons≥3 && now-firstAt≥5min` |
 *   |          |             | 满足 → 告警该臂（覆盖「连败后停手」burst-then-silence 形态） |
 *   | `heartbeat` | 臂 alerted 且距 lastHeartbeat ≥ `hb<3 ? 60min : 240min` |
 *   |          |             | 发**分臂诚实态**（见 `buildHeartbeatContent`；60/60/60/240… 降频）|
 *
 *   **补充不变量（卡 2 评审批）**：
 *   - **告警置位即清 `probeOkStreak`**（A 臂）：恢复证据必须在告警**之后**产生——否则一个
 *     "探针早已连胜 720 次"的部署在业务 5 连败告警后的**下一轮**探针就会假恢复（≤2 分钟抖动）。
 *   - **探针触发的告警用探针计数**（`alertEvidence`）：零流量形态下 `state.cons=0`，
 *     照打会写出「连续失败 0 次 / 持续 0 分钟」的假数字。
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/architecture.md` — memory 小节「引擎运行时健康观测
 *     （双臂状态机 + ready 探针 + 三通道告警 + 单实例假设 + 重启语义）」；通道语义与盲区清单
 *     见 `docs/api-definition.md` §19.2（三通道 / 告警态视图 / at-least-once 口径）。
 *   - 补充: `engines/instrumented-memory.engine.ts` 文件头（为什么检测点在端口层）
 *   - 补充: `../notifications/notify-orchestrator.service.ts` — `sendSystemAlert()` 端口契约
 *     （九态 outcome / 结构性 never-throw / 量控分桶）
 *
 * [关键不变量]
 *   - **文案闭集**（告警正文只允许出现）：引擎名 / 臂 / kind 枚举 / httpStatus / 连续次数 /
 *     首次失败时间 / 持续分钟 / workspaceId（B 臂必带、A 臂可带）/ 分臂处置指引 /
 *     恢复确认方式。**禁止**：baseUrl、host、port、引擎路由 path、`credentialRef`、
 *     requestId、engineCode、任何上游字符串（错误体可能回显请求片段——先例 JUDGMENT-ERROR-BODY）。
 *     **日志**可以放宽（host 走 `describeEndpoint`、engineCode/requestId/latencyMs），
 *     但**禁止 `JSON.stringify(failure|target)` 整包**（整包 = 把未知字段一次性搬进日志）。
 *   - **展示净化（allowlist 制）**：`sanitizeAlertField()` 把 workspaceId 收进
 *     `^[A-Za-z0-9._:-]{1,128}$`（不合规字符替换 `_`、截断 128）。落点三处：① 存入口
 *     （`lastWorkspaceId` 赋值）② 拼 body（`buildAlertContent`/`buildHeartbeatContent`）
 *     ③ 日志行（`workspaceId` / `engineCode` 过 `sanitizeLogValue`）。
 *     ⚠️ **标识符永远只校验、不改写**：净化**只发生在展示面**；落库侧（`memory-project.service.ts`
 *     对 Hub 返回值的校验）是 fail-closed 拒绝，绝不截断/替换。
 *   - **置位与派发解耦**：`alerted` 在**判定触发时同步置位**，派发是 fire-and-forget。
 *     派发失败**不得**回滚置位（否则一次通道抖动会让状态机永远重复告警），只记
 *     `MEMORY_ENGINE_ALERT` 日志。
 *   - **禁止裸 `void promise`**：Node 22 下未捕获 rejection = **进程退出**。三处派发点一律
 *     `void this.notify.sendSystemAlert(...).then(...).catch(...)`——`.catch` 在链末，兜住
 *     `.then` 回调自身抛错（对端结构性 never-throw，这只是回归钉）。
 *   - **不做应用层重投**（v4 裁决）：`failureKind='transport'` 含 timeout（响应可能已出境），
 *     "确定未出境才重投"是假承诺。可靠性 = provider 内部 3 次尝试 + 下一次心跳；恢复投递失败
 *     = WARN 日志后永久静默（`alerted` 已清、心跳停止）。
 *   - **`alertDelivered` 簿记 + 代际守卫**：告警置位时置 `null`，outcome 回写走
 *     `noteAlertOutcome(arm, since, outcome)`，后者在 `state.alertedSince !== since` 时**直接返回**
 *     ——迟到的 outcome 不得写脏新一代告警期（否则恢复文案谎报送达状态）。
 *   - **重启语义（已知边界，写进文档）**：全部状态在内存，重启 = 重新计数。引擎仍坏 ⇒
 *     阈值后重新告警（自愈）；故障期跨重启 ⇒ **可能缺一条恢复通知**（告警文案自带
 *     "如何自证已恢复"的指引）。
 *   - **flap 上界**：A 臂告警/恢复对 ≤1/4min（恢复要探针**连续 2 次**成功 ⇒ ≥4 分钟迟滞，
 *     天然防抖）；B 臂恢复需**一次成功调用**（探针证明不了凭据），由调用节奏决定，**无上界**
 *     ——反刷屏靠 notify 侧的按臂量控（auth 桶 alert+recovery 都计额）。
 *   - **单实例假设**：多实例 = N 倍探测与 N 条告警（每实例独立内存态）。单实例是当前部署
 *     现实；多实例需外部去重（卡边界外）。
 *   - `noteCallOutcome` / `noteProbeOutcome` / `tick` **永不 throw**：它们跑在业务调用与 cron
 *     的热路径上，抛错 = 把引擎抖动升级成 500 / 把 cron 打死。内部一律 try/catch + error 日志。
 *
 * [关联代码]
 *   - engines/instrumented-memory.engine.ts — 业务调用的唯一上报点（`noteCallOutcome`）
 *   - engine-health-probe.service.ts — `noteProbeOutcome` 与 `tick` 的唯一调用方（@Cron 120s）
 *   - engines/memory-engine.factory.ts — `MEMORY_ENGINE`（包装层）装配 + `MEMORY_CONFIG` token
 *   - ../../config/memory.config.ts — `engine` / `humentBaseUrl` / `healthProbeEnabled` / `describeEndpoint`
 *   - ../notifications/notify-orchestrator.service.ts — `sendSystemAlert()`（**唯一**告警出境端口）
 *   - memory.module.ts — 本类的注册点 + `ENGINE_HEALTH_VIEW` 派生只读 provider（`getHealthSnapshot()` 的消费者）
 *   - ../../health/health.controller.ts — `/health/ready` 的 `optional.memoryEngine`
 *   - test/memory.e2e-spec.ts — 「5×503 → 告警派发 / 恢复行 / 未配引擎零告警」端到端
 *   - engine-health-tracker.service.spec.ts — 事件转移表逐行单测
 *
 * [持久踩坑]
 *   MEMORY-ALERT-BARE-VOID(裸 void promise): fire-and-forget 写成 `void this.notify.sendSystemAlert(...)`
 *     而不接 `.catch` ⇒ 对端一旦 reject（含未来重构丢失 never-throw），Node 22 直接退出进程。
 *     安全方向: 单链 `.then().catch()`，`.catch` 在链末。
 *   MEMORY-ALERT-STALE-OUTCOME(迟到 outcome): 派发是异步的；恢复/再告警之后迟到的 outcome
 *     若直接写 `alertDelivered`，新告警期会带着**上一代**的送达结论进恢复文案。
 *     安全方向: `noteAlertOutcome` 的代际守卫（`alertedSince !== since` ⇒ 丢弃）。
 *   MEMORY-ALERT-LEAK(文案泄露): 排障顺手把 endpoint/errorCode 塞进告警正文 ⇒ 告警推到手机，
 *     运维之外的人也可能看到内部端点与上游错误。安全方向: 闭集文案 + 展示净化（见 [关键不变量]）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改判据/阈值必须同步上面的「事件转移表」与 `engine-health-tracker.service.spec.ts`
 *   □ 新增文案字段前先问：它是否在闭集内？会不会带出端点/凭据/上游原文？
 *   □ 新增派发点必须写单链 `.then().catch()`（禁止裸 void promise）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { describeEndpoint, MEMORY_CONFIG, type MemoryConfig } from '../../config/memory.config';
import { sanitizeLogValue } from '../../config/judgment.config';
import type {
  MemoryEngineFailure,
  MemoryEngineFailureKind,
  MemoryEngineResult,
} from './engines/memory-engine.interface';
import { NotifyOrchestrator } from '../notifications/notify-orchestrator.service';
import type { SystemAlertOutcome } from '../notifications/notify-orchestrator.service';

/**
 * 结构化日志标签（**可 grep**）：告警/恢复/心跳/派发失败四类日志都带它。
 *
 * 用途 = 通道降级时的唯一被动感知面（`NOTIFY_ENABLED=false` / 无 admin 渠道时只剩日志，
 * 未投递的 six 态**不落投递表**——投递表是出境审计语义）。
 */
export const MEMORY_ALERT_LOG_TAG = 'MEMORY_ENGINE_ALERT';

/** 告警臂：A = 可用性（引擎死了/存储挂了），B = 认证/绑定（引擎活着但这次调用没资格） */
export type HealthArm = 'availability' | 'auth';

/** 业务调用连续失败阈值（A 臂与 B 臂同阈值：5 次） */
export const MEMORY_CALL_FAILURE_THRESHOLD = 5;

/** 探针连续失败阈值（120s × 3 ≈ 6 分钟；零流量形态下的主要判据） */
export const MEMORY_PROBE_FAILURE_THRESHOLD = 3;

/** 时间窗求值的**最少连续失败数**（`tick` 行；"连败后停手"的形态靠它兜住） */
export const MEMORY_TIME_WINDOW_MIN_COUNT = 3;

/** 时间窗长度（5 分钟；与探针阈值共同构成 5–10 分钟的量级） */
export const MEMORY_TIME_WINDOW_MS = 5 * 60_000;

/** 探针连续成功次数达到它才恢复 A 臂（≥4 分钟迟滞，天然防抖） */
export const MEMORY_PROBE_OK_STREAK_TO_RECOVER = 2;

/** 心跳间隔（告警刚发生时前 3 条：每 60 分钟一次"我还坏着/我好了但没验证"的诚实播报） */
export const MEMORY_HEARTBEAT_INTERVAL_MS = 60 * 60_000;

/**
 * 心跳降频后的间隔（前 3 条之后：每 240 分钟一次）。
 *
 * rationale：长期故障（几天）里 60min 节律 = 一条永远重复的噪音；降频后既保留"仍然坏着"的
 * 存在感，又不至于把人训成忽略告警。序列 = 60/60/60/240/240…（见 `evaluateHeartbeats`）。
 */
export const MEMORY_HEARTBEAT_SLOW_INTERVAL_MS = 240 * 60_000;

/**
 * allowlist 之外的字符（逐字符替换为 `_`；denylist 会漏 U+2028/U+2029/bidi 控制符）。
 *
 * 允许集 = `A-Za-z0-9._:-`、上限 128 —— 与 `dto/project.dto.ts` 的
 * `@Matches(/^[A-Za-z0-9._:-]{1,128}$/)` **同一字符集**（两处互相注释指向）。
 */
const ALERT_FIELD_DISALLOWED = /[^A-Za-z0-9._:-]/g;

/**
 * 展示净化：把 workspaceId 收进 allowlist（**只在拼正文/日志时调用**）。
 *
 * ⚠️ **绝不是"标识符规范化"**：落库/传引擎的 workspaceId 只校验、永不改写（改写 = 后续所有
 * 引擎调用打到不存在的 workspace）。本函数只保证"这一行正文/日志不会被换行或超长值撑破"。
 *
 * @param value 待展示的标识符（可能含 `\n` / `\r` / U+2028 / 超长）
 * @returns 单行、≤128 字符、字符集合规的展示值（空串退化为 `_`）
 */
export function sanitizeAlertField(value: string): string {
  const replaced = value.replace(ALERT_FIELD_DISALLOWED, '_').slice(0, 128);
  // 空串不合 `{1,128}`：给一个占位符，避免拼出 `workspaceId=` 这种半截字段
  return replaced.length > 0 ? replaced : '_';
}

/** 单臂的计数与告警位（A 臂复用同一形状；探针字段单列见 `ProbeState`） */
interface ArmState {
  /** 连续失败计数（A 臂 = 业务调用；B 臂 = 401/403） */
  cons: number;
  /** 本轮连续失败的首次时刻（epoch ms；`cons === 0` 时恒 null） */
  firstAt: number | null;
  /** 是否处于告警期（置位与派发解耦：置位同步、派发异步） */
  alerted: boolean;
  /** 本轮告警的起始时刻（`alerted === false` 时恒 null；代际守卫的比较基准） */
  alertedSince: number | null;
  /**
   * 本轮告警是否**真的出境**（`null` = 尚在途；`false` = 只进了日志）。
   *
   * 消费方 = `buildRecoveryContent`：`false` 时恢复文案必须补「（此前告警未送达，仅日志。）」
   * ——否则运维会以为"此前收到过告警、现在好了"。
   */
  alertDelivered: boolean | null;
  /** 最近一次心跳时刻（`alerted === false` 时恒 null） */
  lastHeartbeatAt: number | null;
  /** 本告警期内已发心跳次数（决定心跳节律 60/60/60/240…） */
  heartbeatCount: number;
  /** 本轮最近一次失败证据（**只用于文案/日志的选择，不整包外发**） */
  lastFailure: FailureEvidence | null;
  /** 本轮最近一次失败所属的 workspace（**已过展示净化**；B 臂文案必带、A 臂有则带） */
  lastWorkspaceId: string | null;
}

/** 探针路的计数（A 臂的独立证据；与业务流量互不清零） */
interface ProbeState {
  /** 连续失败次数 */
  cons: number;
  /** 本轮连续失败首次时刻 */
  firstAt: number | null;
  /** 连续成功次数（恢复 A 臂的判据） */
  okStreak: number;
}

/** 失败证据（**白名单字段**：新增字段前先想清楚它会不会进日志/文案） */
interface FailureEvidence {
  /** 失败分类（`timeout` / `unreachable` / `http` / `invalid_response`） */
  kind: MemoryEngineFailureKind;
  /** `kind='http'` 时的状态码 */
  httpStatus?: number;
  /** 引擎错误码（**只进日志**，不进告警正文） */
  engineCode?: string;
  /** 引擎请求 id（**只进日志**） */
  requestId?: string;
  /** 本次耗时（**只进日志**） */
  latencyMs: number;
}

/** 上报上下文（**只有 workspaceId**：非机密；凭据引用绝不外传） */
export interface CallOutcomeContext {
  /** 引擎 workspace（= 项目绑定的 `engine_workspace_id`） */
  workspaceId: string;
}

/**
 * 引擎健康快照（**只读证据**；`ENGINE_HEALTH_VIEW` 每次请求现算的唯一输入）。
 *
 * 语义边界：它是**告警态视图**，不是"引擎可用性"的判决——`degraded`（B 臂）可被任何登录用户
 * 诱发（项目 403），**不得作为自动摘流/自动重启判据**（见 `docs/api-definition.md` §19.2）。
 */
export interface EngineHealthSnapshot {
  /** A 臂（可用性）是否处于告警期 */
  availability: { alerted: boolean };
  /** B 臂（认证/绑定）是否处于告警期 */
  auth: { alerted: boolean };
  /** 最近一次探针成功时刻（epoch ms；`null` = 启动后还没有成功证据） */
  lastProbeOkAt: number | null;
}

/**
 * 引擎健康状态机（app-scoped 单例；见文件头事件转移表）。
 *
 * ⚠️ `@Inject(MEMORY_CONFIG)` **不是** `ConfigService`：e2e 用 `overrideProvider(MEMORY_CONFIG)`
 * 注入整份配置对象，走 ConfigService 会读 `process.env`（测试里不可控）。
 */
@Injectable()
export class EngineHealthTracker {
  private readonly logger = new Logger(EngineHealthTracker.name);

  /** A 臂：可用性（业务调用失败） */
  private readonly availability: ArmState = emptyArm();

  /** B 臂：认证 / 绑定（401/403） */
  private readonly auth: ArmState = emptyArm();

  /** A 臂的探针路（独立证据，业务流量不清零） */
  private readonly probe: ProbeState = { cons: 0, firstAt: null, okStreak: 0 };

  /**
   * 最近一次探针成功时刻（`null` = 启动首轮窗口内还没有证据）。
   *
   * 只读证据：不参与任何状态转移（恢复判据仍是 `probe.okStreak`），仅供
   * `getHealthSnapshot()` 回答"到底有没有成功过一次探针"——没有它就是 `unknown` 而非 `up`。
   */
  private lastProbeOkAt: number | null = null;

  constructor(
    @Inject(MEMORY_CONFIG) private readonly config: MemoryConfig,
    private readonly notify: NotifyOrchestrator,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // 上报入口（永不 throw；跑在业务热路径上）
  // ────────────────────────────────────────────────────────────────────────

  /**
   * 上报一次**业务**调用结果（唯一调用方 = `InstrumentedMemoryEngine`）。
   *
   * @param result 引擎结果（判别式联合；本方法只读不写）
   * @param context 上报上下文（**只有 workspaceId**）
   */
  noteCallOutcome(result: MemoryEngineResult<unknown>, context: CallOutcomeContext): void {
    try {
      if (result.ok) this.onCallOk();
      else this.onCallFailure(result.failure, context.workspaceId);
    } catch (err: unknown) {
      // 上报永远不得影响业务调用（抛错 = 一次好调用变成 500）
      this.logger.error(
        `${MEMORY_ALERT_LOG_TAG} call-outcome bookkeeping failed (ignored): ${errorName(err)}`,
      );
    }
  }

  /**
   * 上报一次**探针**结果（唯一调用方 = `EngineHealthProbeService`）。
   *
   * ⚠️ `!ok` **全收**：ready 端点没有"逐请求合法失败"（404 = baseUrl 配错也是部署故障）；
   * 2xx 但体不满足合同已由引擎层翻成 `invalid_response`（同样是失败）。
   *
   * @param result `healthCheck()` 的结果
   */
  noteProbeOutcome(result: MemoryEngineResult<void>): void {
    try {
      if (result.ok) this.onProbeOk();
      else this.onProbeFail(result.failure);
    } catch (err: unknown) {
      this.logger.error(
        `${MEMORY_ALERT_LOG_TAG} probe-outcome bookkeeping failed (ignored): ${errorName(err)}`,
      );
    }
  }

  /**
   * 时间窗求值 + 心跳（随探针 cron 每 120s 一次；探针开关关闭时**照跑**）。
   *
   * 覆盖「连败后停手」：3 次失败后流量消失、又没开探针 ⇒ 5 分钟后仍然告警。
   *
   * @param now 求值时刻（参数化便于单测构造边界；缺省 = 当前时间）
   */
  tick(now: number = Date.now()): void {
    try {
      this.evaluateTimeWindow('availability', this.availability, now);
      this.evaluateTimeWindow('auth', this.auth, now);
      this.evaluateHeartbeats(now);
    } catch (err: unknown) {
      this.logger.error(`${MEMORY_ALERT_LOG_TAG} tick failed (ignored): ${errorName(err)}`);
    }
  }

  /**
   * **只读**健康快照（`ENGINE_HEALTH_VIEW` 的唯一数据源；每次请求现算，不缓存）。
   *
   * @returns 双臂告警位 + 最近一次探针成功时刻（**不含任何转移副作用**）
   */
  getHealthSnapshot(): EngineHealthSnapshot {
    return {
      availability: { alerted: this.availability.alerted },
      auth: { alerted: this.auth.alerted },
      lastProbeOkAt: this.lastProbeOkAt,
    };
  }

  /**
   * **测试专用**：把双臂计数、告警位、探针计数与探针成功时刻全部复位。
   *
   * 用途 = e2e 的隔离（tracker 是 app-scoped 单例，同一 app 的多个 `it` 共享状态；
   * 不复位会形成**执行顺序依赖**——前一个用例的 alert 会让后一个用例的断言失真）。
   * `lastProbeOkAt` 必须一起清：否则"复位后 = 未探过"的 `unknown` 断言会读到上一例的证据。
   *
   * ⚠️ 生产不要调用：它也**不发**任何恢复通知（复位 ≠ 引擎恢复）。
   */
  resetForTest(): void {
    Object.assign(this.availability, emptyArm());
    Object.assign(this.auth, emptyArm());
    this.probe.cons = 0;
    this.probe.firstAt = null;
    this.probe.okStreak = 0;
    this.lastProbeOkAt = null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 状态转移（逐行对应文件头事件转移表）
  // ────────────────────────────────────────────────────────────────────────

  /** `callOk`：双路清零；B 立即恢复；A 仅在探针禁用时由调用恢复 */
  private onCallOk(): void {
    const now = Date.now();
    this.availability.cons = 0;
    this.availability.firstAt = null;
    this.auth.cons = 0;
    this.auth.firstAt = null;

    if (this.auth.alerted) this.recoverArm('auth', now, 'call');

    // A 臂恢复：**探针启用时一律不认业务成功**（一次成功调用证明不了"稳定"；
    // 探针 2 连胜才是恢复判据）。探针禁用时，成功调用是唯一证据 ⇒ 立即恢复。
    if (this.availability.alerted && !this.config.healthProbeEnabled) {
      this.recoverArm('availability', now, 'call');
    }
  }

  /** 业务调用失败的分类与转移（见事件转移表三行 callFail*） */
  private onCallFailure(failure: MemoryEngineFailure, workspaceId: string): void {
    const now = Date.now();
    const evidence = toEvidence(failure);

    if (isAvailabilityFailure(failure)) {
      this.availability.cons += 1;
      this.availability.firstAt ??= now;
      this.availability.lastFailure = evidence;
      // 落点①：**存入口即净化一次**（后续 body/日志/心跳都复用这个已净化值）
      this.availability.lastWorkspaceId = sanitizeAlertField(workspaceId);
      if (this.availability.cons >= MEMORY_CALL_FAILURE_THRESHOLD && !this.availability.alerted) {
        this.raiseAlert('availability', now, workspaceId, 'call');
      }
      return;
    }

    if (isAuthFailure(failure)) {
      this.auth.cons += 1;
      this.auth.firstAt ??= now;
      this.auth.lastFailure = evidence;
      // 落点①：同上（B 臂文案必带 workspaceId）
      this.auth.lastWorkspaceId = sanitizeAlertField(workspaceId);
      // 引擎回了结构化 401/403 = **进程活着**（只是这次没资格）⇒ A 臂业务计数清零。
      // ⚠️ 探针路（probeCons/probeOkStreak）**不动**：那是独立证据。
      this.availability.cons = 0;
      this.availability.firstAt = null;
      if (this.auth.cons >= MEMORY_CALL_FAILURE_THRESHOLD && !this.auth.alerted) {
        this.raiseAlert('auth', now, workspaceId, 'call');
      }
      return;
    }

    // `callNonCounted`：其余 4xx（400/409/422/其他 404）——引擎应答 + 凭据通过 = 双路清零，
    // **不触发任何告警**（409 是业务冲突，不是引擎故障）。
    this.availability.cons = 0;
    this.availability.firstAt = null;
    this.auth.cons = 0;
    this.auth.firstAt = null;
  }

  /** `probeOk`：清探针计数、累计连胜、记最近成功时刻；连胜 ≥2 且 A 告警中 ⇒ 恢复 A */
  private onProbeOk(): void {
    const now = Date.now();
    this.probe.cons = 0;
    this.probe.firstAt = null;
    this.probe.okStreak += 1;
    // 只读证据（不动转移）：健康视图据此区分"没探过"（unknown）与"探过且没问题"（up）
    this.lastProbeOkAt = now;

    if (this.availability.alerted && this.probe.okStreak >= MEMORY_PROBE_OK_STREAK_TO_RECOVER) {
      // 探针是独立证据：恢复时**连带清业务计数**（不等下一次业务流量）
      this.recoverArm('availability', now, 'probe');
    }
  }

  /** `probeFail`：`!ok` 全收；连续 3 次 ⇒ 告警 A（约 6 分钟） */
  private onProbeFail(failure: MemoryEngineFailure): void {
    const now = Date.now();
    this.probe.cons += 1;
    this.probe.firstAt ??= now;
    this.probe.okStreak = 0;
    this.availability.lastFailure = toEvidence(failure);

    if (this.probe.cons >= MEMORY_PROBE_FAILURE_THRESHOLD && !this.availability.alerted) {
      this.raiseAlert('availability', now, null, 'probe');
    }
  }

  /**
   * `tick` 行：`!alerted && cons≥3 && now-firstAt≥5min` ⇒ 告警该臂。
   *
   * ⚠️ 对 **A 臂**，"cons" 取的是**业务调用**计数（`availability.cons`）：探针路有自己的
   * 3 次阈值（120s × 3 ≈ 6 分钟，**比时间窗更早**），故探针失败不需要再经这里求值。
   * 本行真正兜住的是「3 次业务失败后流量停止」（burst-then-silence）——若没有它，一个
   * "调了 3 次就没人再调"的坏引擎永远不会被告警。
   */
  private evaluateTimeWindow(arm: HealthArm, state: ArmState, now: number): void {
    if (state.alerted) return;
    if (state.cons < MEMORY_TIME_WINDOW_MIN_COUNT) return;
    if (state.firstAt === null) return;
    if (now - state.firstAt < MEMORY_TIME_WINDOW_MS) return;
    this.raiseAlert(arm, now, state.lastWorkspaceId, 'window');
  }

  /**
   * `heartbeat` 行：告警中的臂按 **60/60/60/240…** 的降频节律播报**该臂当前证据**（诚实态）。
   *
   * 心跳 outcome **不回写** `alertDelivered`：心跳送达与否不改变"最初那条告警是否送达"的事实
   * （回写会污染恢复文案的条件判断）。
   */
  private evaluateHeartbeats(now: number): void {
    for (const arm of ['availability', 'auth'] as const) {
      const state = this.armState(arm);
      if (!state.alerted) continue;
      // 降频：前 3 条 60min（故障刚发生时需要密度），之后 240min（长期故障不再刷屏）
      const interval =
        state.heartbeatCount < 3 ? MEMORY_HEARTBEAT_INTERVAL_MS : MEMORY_HEARTBEAT_SLOW_INTERVAL_MS;
      if (state.lastHeartbeatAt !== null && now - state.lastHeartbeatAt < interval) {
        continue;
      }
      state.lastHeartbeatAt = now;
      state.heartbeatCount += 1;
      const content = this.buildHeartbeatContent(arm, now);
      // 落点②的延续：payload 与日志都用**已净化**的 workspace
      const workspace =
        state.lastWorkspaceId === null ? null : sanitizeAlertField(state.lastWorkspaceId);
      this.logger.warn(
        `${MEMORY_ALERT_LOG_TAG} heartbeat arm=${arm} consecutive=${state.cons} ` +
          `alertedSince=${iso(state.alertedSince)} ` +
          `workspaceId=${workspace === null ? '-' : sanitizeLogValue(workspace)} ` +
          `heartbeat=${state.heartbeatCount}`,
      );
      const { title, body } = splitAlertContent(content);
      // ⚠️ 单链 `.then().catch()`（禁止裸 void promise —— Node 22 未捕获 rejection = 进程退出）
      void this.notify
        .sendSystemAlert({
          source: 'memory-engine',
          kind: 'heartbeat',
          arm,
          title,
          body,
          occurredAt: iso(now),
          consecutive: state.cons,
          ...(workspace === null ? {} : { workspaceId: workspace }),
        })
        .then((outcome) => {
          if (outcome !== 'delivered') {
            this.logger.warn(
              `${MEMORY_ALERT_LOG_TAG} heartbeat not delivered arm=${arm} outcome=${outcome} ` +
                '— the heartbeat above is the log trace',
            );
          }
        })
        .catch((err: unknown) =>
          this.logger.error(
            `${MEMORY_ALERT_LOG_TAG} heartbeat dispatch failed (ignored): ${errorName(err)}`,
          ),
        );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 告警置位 / 恢复
  // ────────────────────────────────────────────────────────────────────────

  /**
   * 置位告警并异步派发（**置位与派发解耦**：派发失败不回滚置位）。
   *
   * @param arm 告警臂
   * @param now 触发时刻
   * @param workspaceId 触发方 workspace（A 臂探针触发时为 null）
   * @param trigger 触发路径（日志用；`call` / `probe` / `window`）
   */
  private raiseAlert(
    arm: HealthArm,
    now: number,
    workspaceId: string | null,
    trigger: AlertTrigger,
  ): void {
    const state = this.armState(arm);
    if (state.alerted) return;

    state.alerted = true;
    state.alertedSince = now;
    // 送达结论待定：outcome 迟到时由 `noteAlertOutcome`（带代际守卫）回写
    state.alertDelivered = null;
    state.lastHeartbeatAt = now;
    state.heartbeatCount = 0;

    // ⚠️ **恢复证据必须在告警之后产生**（卡 2 评审 M2）：A 臂由探针连胜恢复，
    // 若不清零，一个"探针早就健康了 720 次"的部署在业务 5 连败告警后，**下一轮探针**
    // 就会立刻满足 streak≥2 发假恢复（120s 内 alert/recover 抖动）。清零后，恢复至少
    // 需要告警之后的两轮成功探测（≥4 分钟迟滞）。
    if (arm === 'availability') this.probe.okStreak = 0;

    /** 触发路径决定"数字取自哪一路证据"（探针触发的告警不得打业务计数的 0） */
    const evidence = this.alertEvidence(arm, trigger, now);

    const content = this.buildAlertContent(arm, now, workspaceId, trigger);
    const { title, body } = splitAlertContent(content);
    // 落点②：payload 里的 workspaceId 与正文同源（同一份净化结果）
    const workspace = workspaceId === null ? null : sanitizeAlertField(workspaceId);

    // 日志面可以带 host / engineCode / requestId（告警正文不行，见文案闭集）。
    // ⚠️ 落点③：workspaceId 与 engineCode 是上游可控串，**过 sanitizeLogValue** 再插值
    // （否则 `\n` 可伪造日志行、超长值可刷屏——先例 memory-project.service.ts:634-641）。
    const last = state.lastFailure;
    this.logger.error(
      `${MEMORY_ALERT_LOG_TAG} engine=${this.config.engine} arm=${arm} trigger=${trigger} ` +
        `consecutive=${evidence.consecutive} ` +
        `workspaceId=${workspaceId === null ? '-' : sanitizeLogValue(sanitizeAlertField(workspaceId))} ` +
        `endpoint=${describeEndpoint(this.config.humentBaseUrl)} ` +
        `kind=${last?.kind ?? '-'} httpStatus=${last?.httpStatus ?? '-'} ` +
        `engineCode=${last?.engineCode === undefined ? '-' : sanitizeLogValue(last.engineCode)} ` +
        `requestId=${last?.requestId ?? '-'} ` +
        `latencyMs=${last?.latencyMs ?? '-'} firstFailureAt=${iso(evidence.firstAt)}`,
    );

    // ⚠️ 单链派发（禁止裸 void promise）：`.catch` 在链末，兜住 `.then` 回调自身抛错；
    // 对端 `sendSystemAlert()` 结构性 never-throw（本 catch 是回归钉）。
    const since = state.alertedSince;
    void this.notify
      .sendSystemAlert({
        source: 'memory-engine',
        kind: 'alert',
        arm,
        title,
        body,
        occurredAt: iso(now),
        consecutive: evidence.consecutive,
        ...(workspace === null ? {} : { workspaceId: workspace }),
      })
      .then((outcome) => this.noteAlertOutcome(arm, since, outcome))
      .catch((err: unknown) =>
        this.logger.error(
          `${MEMORY_ALERT_LOG_TAG} alert dispatch failed (ignored): ${errorName(err)}`,
        ),
      );
  }

  /**
   * 告警的证据数字（**哪一路失败就该报哪一路**）。
   *
   * 探针触发的 A 臂告警里，业务计数可能恒为 0（零流量形态）——用 `state.cons/state.firstAt`
   * 会打出「连续失败 0 次 / 持续 0 分钟 / 首次=告警时刻」的假数字（卡 2 评审 M1）。
   *
   * @param arm 告警臂
   * @param trigger 触发路径
   * @param now 告警时刻（`firstAt` 缺失时的兜底）
   * @returns 连续次数 / 首次时刻 / 中文标签（`就绪探测连续失败` 或 `连续失败`）
   */
  private alertEvidence(
    arm: HealthArm,
    trigger: AlertTrigger,
    now: number,
  ): { consecutive: number; firstAt: number; label: string } {
    if (arm === 'availability' && trigger === 'probe') {
      return {
        consecutive: this.probe.cons,
        firstAt: this.probe.firstAt ?? now,
        label: '就绪探测连续失败',
      };
    }
    const state = this.armState(arm);
    return {
      consecutive: state.cons,
      firstAt: state.firstAt ?? now,
      label: '连续失败',
    };
  }

  /**
   * 恢复告警并异步派发恢复通知。
   *
   * @param arm 告警臂
   * @param now 恢复时刻
   * @param basis 恢复依据（`call` = 一次成功调用 / `probe` = 探针 2 连胜）
   */
  private recoverArm(arm: HealthArm, now: number, basis: 'call' | 'probe'): void {
    const state = this.armState(arm);
    if (!state.alerted) return;

    const since = state.alertedSince ?? now;
    // 先取送达结论再清位（清位后无从得知"此前告警是否出境"）。
    // `null`（outcome 未回）**不**算"未送达"：只有明确 `false` 才在文案里声明，避免
    // "派发在途时恰好恢复"被误写成"告警丢了"。
    const priorAlertDelivered = state.alertDelivered;
    state.alerted = false;
    state.alertedSince = null;
    state.alertDelivered = null;
    state.lastHeartbeatAt = null;
    state.heartbeatCount = 0;
    state.cons = 0;
    state.firstAt = null;

    const content = this.buildRecoveryContent(arm, since, now, basis, priorAlertDelivered);
    const { title, body } = splitAlertContent(content);
    this.logger.log(
      `${MEMORY_ALERT_LOG_TAG} RECOVERED engine=${this.config.engine} arm=${arm} ` +
        `basis=${basis} alertedSince=${iso(since)} priorAlertDelivered=${String(priorAlertDelivered)}`,
    );
    // 单链 `.then().catch()`：**恢复结果的回写对 `alertDelivered` 无意义**（代际守卫会拦下
    // ——`alertedSince` 已置 null），但"恢复通知没出境"必须留 WARN（plan D6-6/D8：恢复投递
    // 失败 = WARN 日志后永久静默——alerted 已清、心跳停止，此后不会再有第二次机会）。
    void this.notify
      .sendSystemAlert({
        source: 'memory-engine',
        kind: 'recovery',
        arm,
        title,
        body,
        occurredAt: iso(now),
      })
      .then((outcome) => {
        // 只打日志、**不**回写 `alertDelivered`（恢复不是告警期的簿记）
        if (outcome !== 'delivered') {
          this.logger.warn(
            `${MEMORY_ALERT_LOG_TAG} recovery not delivered arm=${arm} outcome=${outcome} — the ` +
              'recovery notice above is the only trace (see the notify side `system_alert` logs)',
          );
        }
      })
      .catch((err: unknown) =>
        this.logger.error(
          `${MEMORY_ALERT_LOG_TAG} alert dispatch failed (ignored): ${errorName(err)}`,
        ),
      );
  }

  /**
   * 告警派发结果簿记（**代际守卫**：只写回"本次告警期"的结论）。
   *
   * 为什么需要守卫：派发是异步的——若在途期间恢复（`alertedSince` 变 null）或再次告警
   * （新的 `alertedSince`），迟到的 outcome 会把新告警期的 `alertDelivered` 写脏，
   * 导致恢复文案谎报"此前告警已送达/未送达"。
   *
   * @param arm 告警臂
   * @param since 派发时捕获的告警起始时刻（代际基准）
   * @param outcome 对端的九态结果（只有 `delivered` 算"出境了"）
   */
  private noteAlertOutcome(
    arm: HealthArm,
    since: number | null,
    outcome: SystemAlertOutcome,
  ): void {
    const state = this.armState(arm);
    if (state.alertedSince !== since) return;
    state.alertDelivered = outcome === 'delivered';
    if (outcome !== 'delivered') {
      // 未投递六态**不落投递表**（那是出境审计语义）⇒ 这条日志是唯一证据
      this.logger.warn(
        `${MEMORY_ALERT_LOG_TAG} alert not delivered arm=${arm} outcome=${outcome} — the alert ` +
          'above is the only trace (see the notify side `system_alert` logs for the reason)',
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 文案（**闭集**：见文件头 [关键不变量]）
  // ────────────────────────────────────────────────────────────────────────

  /** 告警正文（只含闭集字段；workspaceId 过展示净化） */
  private buildAlertContent(
    arm: HealthArm,
    now: number,
    workspaceId: string | null,
    trigger: AlertTrigger,
  ): string {
    const state = this.armState(arm);
    // **哪一路失败就报哪一路**（探针触发的告警不得打业务计数的 0，见 alertEvidence）
    const evidence = this.alertEvidence(arm, trigger, now);
    const last = state.lastFailure;
    const evidenceLine =
      arm === 'availability'
        ? `最近一次：kind=${last?.kind ?? 'unknown'}${
            last?.httpStatus !== undefined ? ` httpStatus=${last.httpStatus}` : ''
          }`
        : `最近一次：kind=${last?.kind ?? 'unknown'} httpStatus=${last?.httpStatus ?? '-'}`;

    const guidance =
      arm === 'availability'
        ? '处置：检查 Hub 进程与本地存储（就绪探测不通过时业务调用必然失败）。'
        : '处置：检查该项目的绑定三元组（workspace / actor / 凭据引用），' +
          '可用 `GET /memory/projects/:id` 的 engineAvailability 与绑定字段核对；' +
          '与本部署的 MEMORY_ENGINE 配置无关。';

    const lines = [
      `[engine alert] arm=${arm} engine=${this.config.engine}`,
      `${evidence.label} ${evidence.consecutive} 次（首次 ${iso(evidence.firstAt)}，已持续 ` +
        `${elapsedMinutes(evidence.firstAt, now)} 分钟）`,
      evidenceLine,
    ];
    // 落点②：插值点复用净化值（`\n` / U+2028 / 超长 workspaceId 不得撑破正文）
    if (workspaceId) lines.push(`workspaceId=${sanitizeAlertField(workspaceId)}`);
    lines.push(guidance);
    if (arm === 'availability') {
      // 恢复判据**随探针开关变**（否则会写出一个该部署永远等不到的恢复条件）
      lines.push(
        this.config.healthProbeEnabled
          ? '恢复：本通道在引擎就绪探测连续成功 2 次后自动发恢复通知（约 4 分钟）。'
          : '恢复：本部署关闭了就绪探测，因此一次成功的业务调用就会发恢复通知。',
      );
    } else {
      lines.push('恢复：本臂需要一次成功的业务调用才会发恢复通知（就绪探测证明不了凭据）。');
    }
    if (trigger === 'window') {
      lines.push('（本次由时间窗判定触发：连续失败后流量停止，仍按已观测到的失败次数告警。）');
    }
    return lines.join('\n');
  }

  /**
   * 恢复正文（只含闭集字段）。
   *
   * `alertDelivered === false` 时必须如实说明"此前告警没送达"——否则这条恢复通知会让运维
   * 以为"收到过告警、现在好了"，而事实上故障期他什么通知都没收到。`null`（派发仍在途，
   * outcome 未回）**不**触发这句：没有证据就不下结论（恢复文案的默认形态）。
   *
   * @param arm 告警臂
   * @param since 告警起始时刻
   * @param now 恢复时刻
   * @param basis 恢复依据
   * @param alertDelivered 此前那条告警的送达结论（`false` = 明确未出境；`null` = 未知）
   */
  private buildRecoveryContent(
    arm: HealthArm,
    since: number,
    now: number,
    basis: 'call' | 'probe',
    alertDelivered: boolean | null,
  ): string {
    const basisText = basis === 'probe' ? '就绪探测连续成功 2 次' : '一次成功的业务调用';
    const lines = [
      `[engine recovered] arm=${arm} engine=${this.config.engine}`,
      `恢复依据：${basisText}`,
      `告警持续 ${elapsedMinutes(since, now)} 分钟（自 ${iso(since)} 起）`,
    ];
    if (alertDelivered === false) lines.push('（此前告警未送达，仅日志。）');
    lines.push('本通知为恢复确认，无需处置。');
    return lines.join('\n');
  }

  /**
   * 心跳正文（**分臂诚实态**）：只报该臂**当前证据**，不把 A 臂的恢复当成 B 臂的恢复。
   */
  private buildHeartbeatContent(arm: HealthArm, now: number): string {
    const state = this.armState(arm);
    const first = state.firstAt ?? state.alertedSince ?? now;
    const last = state.lastFailure;

    if (arm === 'availability') {
      // 探针已能通过但业务面没有成功调用 ⇒ 必须说清楚"别以为好了"
      if (this.config.healthProbeEnabled && this.probe.okStreak >= 1) {
        return [
          `[engine alert] arm=availability engine=${this.config.engine} — 仍在告警期（心跳）`,
          `就绪探测已恢复（连续成功 ${this.probe.okStreak} 次），但业务面未确认。`,
          '请做一次 recall 验证；成功一次后本臂不会自动恢复（探针 2 连胜才恢复）——' +
            '若 recall 仍失败，说明故障不在存储就绪面。',
        ].join('\n');
      }
      // 探针停用时不得谎报"探针连续失败 0 次"——那一行只在探针路有证据时出现
      const probeLine = this.config.healthProbeEnabled
        ? `；探针连续失败 ${this.probe.cons} 次`
        : '';
      // **零流量形态**（告警由探针触发）：业务计数恒为 0，如实播报探针证据；
      // 否则会打出"本轮累计失败 0 次"这种自相矛盾的心跳
      const accumulated =
        state.cons === 0 && this.probe.cons > 0
          ? `本轮探针连续失败 ${this.probe.cons} 次（无业务调用失败证据）`
          : `本轮累计失败 ${state.cons} 次（业务调用）`;
      return [
        `[engine alert] arm=availability engine=${this.config.engine} — 仍在失败（心跳）`,
        `最近一次：kind=${last?.kind ?? 'unknown'}${
          last?.httpStatus !== undefined ? ` httpStatus=${last.httpStatus}` : ''
        }${probeLine}`,
        `自 ${iso(first)} 起已持续 ${elapsedMinutes(first, now)} 分钟，${accumulated}。`,
        '处置：检查 Hub 进程与本地存储。',
      ].join('\n');
    }

    return [
      `[engine alert] arm=auth engine=${this.config.engine} — 仍在失败（心跳）`,
      `最近一次：httpStatus=${last?.httpStatus ?? '-'}（认证/绑定被拒）`,
      `自 ${iso(first)} 起已持续 ${elapsedMinutes(first, now)} 分钟，本轮累计失败 ${state.cons} 次。`,
      // 落点②：心跳正文同样复用净化值
      ...(state.lastWorkspaceId
        ? [`workspaceId=${sanitizeAlertField(state.lastWorkspaceId)}`]
        : []),
      '处置：核对项目绑定三元组；本臂需要一次成功的业务调用才会恢复。',
    ].join('\n');
  }

  // ────────────────────────────────────────────────────────────────────────
  // 内部小工具
  // ────────────────────────────────────────────────────────────────────────

  /** 臂 → 状态对象 */
  private armState(arm: HealthArm): ArmState {
    return arm === 'availability' ? this.availability : this.auth;
  }
}

/** 空臂初值 */
function emptyArm(): ArmState {
  return {
    cons: 0,
    firstAt: null,
    alerted: false,
    alertedSince: null,
    alertDelivered: null,
    lastHeartbeatAt: null,
    heartbeatCount: 0,
    lastFailure: null,
    lastWorkspaceId: null,
  };
}

/** 告警触发路径（日志用） */
type AlertTrigger = 'call' | 'probe' | 'window';

/**
 * 文案 → 系统告警入参的 title/body 切分。
 *
 * 契约（`SystemAlertInput`）：title = 文案**首行**，body = 余下各行（多行保留 `\n`）。
 *
 * @param content 闭集文案全文
 * @returns 首行与余下部分（单行文案时 body 为空串）
 */
function splitAlertContent(content: string): { title: string; body: string } {
  const lines = content.split('\n');
  return { title: lines[0] ?? '', body: lines.slice(1).join('\n') };
}

/**
 * `kind='http'` 且 **≥500** ⇒ 可用性故障（引擎自己挂了/过载）。
 *
 * @param failure 引擎失败面
 * @returns true = 计入 A 臂
 */
function isAvailabilityFailure(failure: MemoryEngineFailure): boolean {
  if (failure.kind === 'timeout' || failure.kind === 'unreachable') return true;
  // 2xx 但体不可信：中间层改写 / 版本错配 —— 同样"引擎不可用"（不是调用方的错）。
  // ⚠️ 例外：usage 的 target 回声不符是**身份/授权**问题（Hub 活着且答了，只是答的不是
  //    这个 workspace/actor），归 B 臂；把它计入 A 臂会让"项目身份配错"触发引擎不可用告警。
  if (failure.kind === 'invalid_response') {
    return failure.usageRejection !== 'target_mismatch';
  }
  return failure.httpStatus !== undefined && failure.httpStatus >= 500;
}

/**
 * `kind='http'` 且 **401/403** ⇒ 认证/绑定故障。
 *
 * ⚠️ 含 `403 + binding_not_found`：hument 对"绑定不存在"回 **403**（没有 404 臂），
 * 所以这里不需要（也不应该）看 `engineCode`——403 + 任何 code 都归 B 臂。
 *
 * @param failure 引擎失败面
 * @returns true = 计入 B 臂
 */
function isAuthFailure(failure: MemoryEngineFailure): boolean {
  if (failure.httpStatus === 401 || failure.httpStatus === 403) return true;
  // usage 的 target 回声不符 = 身份/授权面（见 `isAvailabilityFailure` 的例外说明）。
  // `schema_mismatch` / `cursor_invalid` **不在此列**：它们仍是 A 臂（版本/合同问题）。
  return failure.kind === 'invalid_response' && failure.usageRejection === 'target_mismatch';
}

/**
 * 失败面 → 白名单证据（**只挑字段**，绝不整包透传）。
 *
 * @param failure 引擎失败面
 * @returns 证据对象（供日志与文案选择，不外发整包）
 */
function toEvidence(failure: MemoryEngineFailure): FailureEvidence {
  return {
    kind: failure.kind,
    ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.engineCode !== undefined ? { engineCode: failure.engineCode } : {}),
    ...(failure.requestId !== undefined ? { requestId: failure.requestId } : {}),
    latencyMs: failure.latencyMs,
  };
}

/** epoch ms → ISO 字符串（`null` → `-`；日志与 `occurredAt` 的确定性格式） */
function iso(value: number | null): string {
  return value === null ? '-' : new Date(value).toISOString();
}

/** 持续分钟（向下取整，≥0） */
function elapsedMinutes(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 60_000));
}

/** 错误名（**不打 message**：仓储/驱动的 message 可能含 SQL 片段） */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
