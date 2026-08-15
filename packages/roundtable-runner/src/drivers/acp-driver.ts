/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §3 (契约①: SeatDriver 的厂商实现——单飞行/BusyError)
 *   - 补充: docs/roundtable-design.md §8 (kimi ACP 行为档案 8 条 / codex ACP 行为档案,
 *           0.34.0 / 0.147.0 实测——本文件设计输入；M4a 由 kimi-acp.ts 提取为传输基座)
 *
 * [踩坑索引] ③(message_complete 无 text) ④(resume 失败无降级→楔死) ⑤(fs caps 声明→turn 静默死亡)
 *              ⑥(RT-PERM-1: kind 命名不可信→optionId 直透) ⑦(RT-PERM-2: tool 元数据在 update 本体非 content)
 *              ⑧(cancel 语义：优雅优先，kill 仅为超时兜底) ⑨(codex 桥 request_permission 不带 title——
 *              toolCallId 缓存补全，只补缺省不覆盖)
 *
 * [铁律关联] #9(代理层透传) #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   ④: session/resume 失败（缓存 sessionId 失效）无降级 → 座位启动卡死、turn 楔死。
 *      修复：resume 失败降级 session/new 并落盘新 id + warn。见 memory/2026-08-07.md §6
 *   ③: message_complete 不带 turn 全文 text → chamber 重启清内存 buffer 后回复正文丢失。
 *      修复：driver 累积 message_chunk 全文，complete 携带全文 text。见 memory/2026-08-07.md §6
 *   ⑤: client 声明 fs caps 后 turn 静默死亡（Write 成功但完成路径无响应）→ 一律不声明
 *      fs caps（clientCapabilities 仅 terminal:false）。见 memory/2026-08-07.md §4
 *   ⑥: RT-PERM-1 —— ACP 审批选项的 kind 是厂商自由命名（真机为 allow_once/
 *      allow_always/reject_once），旧代码按猜测的 approve_* 双重映射把 approve 吞成
 *      reject。根治：answerPermission 收 optionId（与 request_permission params 同源），
 *      在挂起选项里精确匹配 String(o.optionId) === optionId，不做 kind 猜测。
 *   ⑦: RT-PERM-2 —— ACP tool_call/tool_response 更新的工具元数据（toolCallId/title/
 *      kind/status/locations/rawInput）挂在 update 本体上，content 是内容块数组（或
 *      缺失）；旧代码取 update.content ?? {} 当 tool 载荷 → chamber 校验丢弃。
 *      根治：tool 透传整个 update 对象（浅拷贝后剥离 sessionUpdate 键），保证永远是对象。
 *      侧记（M4a R1）：codex 桥反向 RPC id 从 0 自增、kimi 从小整数自增——两侧 requestId
 *      同命名空间，runner-core 审批缓存必须按 `${seatId}:${requestId}` 复合键防跨座位
 *      撞键（本文件只透传 requestId，不在本文件修）。
 *   ⑧: cancel 语义（M4b-1）：kimi 0.34.0 / codex 0.147.0 实测支持 session/cancel
 *      （探针 scripts/acp-cancel-probe.mjs，8ms resolve cancelled、会话存活），推翻
 *      「ACP 无 cancel 方法，kill 即打断」旧认知——优雅优先（notify → 等 prompt resolve），
 *      kill 仅为 10s 无响应兜底；busy=false 禁止 kill 空闲会话（R1），prompt resolve
 *      必须清超时句柄（R2 防自然 end_turn 被误杀）。勿回退 kill-first。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * AcpDriver —— ACP 传输基座（厂商差异收口为 AcpVendorProfile 的 SeatDriver 实现）
 *
 * M4a 由 kimi-acp.ts 提取：kimi/codex 共用同一套 ACP stdio 传输层，厂商 quirk
 * （spawn 命令 / 权限档位映射 / 日志前缀）经构造注入的 profile 区分。
 *
 * 传输层整体提升自 scripts/acp-poc.mjs 的 AcpConnection：
 * spawn acp 子进程 / NDJSON readline 分帧 / pending Map 请求-响应 /
 * 三分发（响应 / 反向 RPC / 通知）/ 反向 RPC 应答 / 流式通知。
 *
 * 行为档案落地（docs/roundtable-design.md §8，kimi 0.34.0 / codex 0.147.0 实测）：
 *   1. 会话全量落盘，跨进程复活无损 → sessionId 由 getSessionId 回调注入，
 *      start/inject 懒启动时 session/resume 复活（而非 session/new）；
 *   2. 审批全异步 → session/request_permission 反向 RPC → permission_request 事件
 *      （挂起不自动应答），等 answerPermission 应答（无超时，平台零缺省）；
 *   3. 用量可观测 → usage_update 通知 → usage 事件（used/size）；
 *   4. 已知 bug：fs caps 声明后 turn 静默死亡 → **一律不声明 fs caps**
 *      （clientCapabilities 仅 terminal:false，agent 改用本地 fs）；
 *   5. config.toml 泄漏（yolo 泄漏进会话）→ start 后显式
 *      session/set_config_option 钉死权限档位（kimi 单条 mode；codex 拆
 *      mode + collaboration_mode，见 profile.modeConfigEntries）；
 *   6. configOptions 可切换 → model 可选覆盖（set_config_option model）；
 *      M3 阶段 5：session/new 或 resume 响应里宽松解析 configOptions 当前值
 *      （model/thinking/mode）→ seat_info 事件上行（实际在跑观测，仅上行不下发）；
 *      current_mode_update 通知解析出 mode 时也触发 seat_info（热更新可见）；
 *   7. terminal 不经 client → 审批只在 mode=default 下由 agent 自行触发，driver 只中继；
 *   8. 无 system prompt 通道 → prompt 只收 content blocks，规则头由 chamber 装配进
 *      inject 文本（本文件不装配，runner-core 负责）。
 *
 * 单飞行：inject 一进入即置 busy（含懒启动全程），turn 终结（message_complete 发出）
 * 或异常才释放；busy 期间并发 inject 抛 BusyError。
 *
 * 畸形响应（无 result 无 error，档案 #4 的 wire 表现）：request() 拒绝为
 * MalformedResponseError；inject 捕获后发 message_complete(stopReason='error')
 * 释放单飞行——否则 chamber 侧座位永久 busy 死锁。
 *
 * 沉默判定：本侧累积 message_chunk 全文，turn 结束时用 protocol 的 parseSilentReply
 * 宽松判定（trim 后整体可 parse 且 silent===true）透传到 message_complete.silent。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import {
  parseSilentReply,
  type PermissionMode,
  type PermissionOption,
  type SeatConfig,
  type SeatEvent,
  type ToolBrief,
  type ToolEventPayload,
} from '@agent-chamber/roundtable-protocol';
import { BusyError } from './seat-driver';
import type { InjectedPrompt, SeatDriver } from './seat-driver';
import { ConsoleLogger } from '../logger';
import type { Logger } from '../logger';

/**
 * 本包版本（hello/initialize 上报；与 cli.ts VERSION 单一常量同源，R5——
 * clientInfo.version 上报的是 runner 版本，不按 profile 各报各的；与 package.json 保持一致）
 */
export const DRIVER_VERSION = '0.4.0';

/** ACP initialize 的 clientInfo.name（chamber 侧日志识别 runner 来源） */
const CLIENT_NAME = 'agent-chamber-roundtable-runner';

/**
 * 优雅取消兜底超时（ms）：`session/cancel` 通知后等 prompt resolve 的默认时限，
 * 超时未响应才走 kill 兜底（防御 agent 不应答）。kimi 0.34.0 实测 cancel 后 8ms
 * resolve cancelled——10s 是防御性上限；测试经构造选项 cancelKillTimeoutMs 覆盖。
 */
const CANCEL_KILL_TIMEOUT_MS = 10_000;

/**
 * 厂商 profile：AcpDriver 与厂商的全部差异收口点（kimi/codex 各一份薄壳构造注入）。
 * 新增厂商 = 新增一个 profile + 薄壳类，传输层零改动。
 */
export interface AcpVendorProfile {
  /** 厂商名（日志前缀/错误文案；如 'kimi'/'codex'） */
  vendorName: string;
  /**
   * 构造 ACP 子进程 spawn 命令（每次拉起时调用，带座位配置——opencode 需要按
   * 座位 permissionMode 注入 OPENCODE_CONFIG_CONTENT 权限钉死，见 opencode-acp.ts；
   * 不需要座位上下文的厂商（kimi/codex）可忽略该参数）。
   * 可抛错——抛错即 start/inject 失败，错误信息直接成为座位 offline 的 detail
   * （如 codex 探测不到 CLI：R3 不静默兜底）。
   */
  spawnCommand(config: SeatConfig): { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  /**
   * 平台权限档位 → set_config_option 钉死序列（档案 #5 泄漏防护的厂商映射）。
   * kimi：单条 mode=permissionMode；codex：mode（read-only/agent/agent-full-access）
   * + plan 档追加 collaboration_mode=plan（语义近似非等价，见 codex-acp.ts）。
   */
  modeConfigEntries(permissionMode: PermissionMode): Array<{ configId: string; value: string }>;
}

/** ACP 反向 RPC 应答结果：审批选中选项 */
interface PermissionOutcome {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
}

/**
 * 畸形响应错误：JSON-RPC 响应既无 result 也无 error。
 * kimi 0.34.0 fs caps bug 的 wire 表现（档案 #4）——作为可辨识错误类型抛出，
 * inject 捕获后按 turn 异常终结处理。
 */
export class MalformedResponseError extends Error {
  constructor(method: string) {
    super(`ACP malformed response for "${method}" (no result, no error)`);
    this.name = 'MalformedResponseError';
  }
}

/** pending 请求条目 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

/** 挂起审批条目（requestId → 选项列表，answerPermission 应答时按 optionId 精确匹配） */
interface PendingPermission {
  options: PermissionOption[];
}

/**
 * 会话实际运行配置快照（M3 阶段 5 观测用——model/thinking/mode 地面真相，非配置声明）。
 * 来源：session/new 或 session/resume 响应里的 configOptions 当前值（宽松解析，字段
 * 可能缺——不同 vendor 形状不同：kimi 为 {configId,value}，codex 为 {id,currentValue}）；
 * mode 另有 session/set_config_option 钉死值兜底。
 */
interface ConfigSnapshot {
  /** 实际在跑的模型（configOptions 当前值） */
  model?: string;
  /** 思考等级（low/high/max 等，原文透传；codex 键名 reasoning_effort → thinking，R2） */
  thinking?: string;
  /** 权限模式（default/plan/auto/yolo 等，原文透传） */
  mode?: string;
}

/** 单座位 ACP 会话（一个座位 = 一个 ACP 子进程，隔离崩坏与生命周期） */
interface AcpSession {
  config: SeatConfig;
  child: ChildProcess;
  nextId: number;
  pending: Map<number, PendingRequest>;
  permissions: Map<string, PendingPermission>;
  /** 当前 turn 流式全文累积（message_complete 时用于沉默判定） */
  streamedText: string;
  /** 单飞行标志：inject 进行中 true（并发 inject 抛 BusyError） */
  busy: boolean;
  /** 优雅取消进行中标志：重复 cancel no-op（幂等） */
  cancelling: boolean;
  /** 优雅取消兜底超时句柄（prompt resolve 时必须清除——R2 防自然 end_turn 被误杀） */
  cancelTimer: NodeJS.Timeout | null;
  /** 当前 in-flight turn 的 promise（cancel 等待其 resolve；turn 终结后置 null） */
  turnPromise: Promise<void> | null;
  /** initialize + session 建立完成标志 */
  started: boolean;
  /** 当前 ACP 会话 id（resume/new 后填充） */
  sessionId: string | null;
  /** 子进程已退出（不可再请求；inject 时按「叫醒」语义重新 spawn+resume） */
  dead: boolean;
  /** 实际运行配置快照（configOptions 解析 + set_config_option 钉死值合并；seat_info 上行数据源） */
  configSnapshot: ConfigSnapshot;
  /**
   * 工具元数据缓存（toolCallId → {title,kind}）：tool_call/tool_response 到达时记录；
   * request_permission 的 toolCall 缺 title 时查表补全（codex 桥 quirk：审批载荷不带
   * title，DB 实测仅 {kind,status,toolCallId}）。cap 100 FIFO（Map 迭代序=插入序）。
   * 会话级内存态：重启/resume 后为空 → 优雅降级为现状（缺省不补），非回归
   */
  toolMeta: Map<string, { title?: unknown; kind?: unknown }>;
}

/** AcpDriver 构造选项 */
export interface AcpDriverOptions {
  /** 厂商差异 profile（必填；kimi/codex 薄壳构造时注入各自 quirk） */
  profile: AcpVendorProfile;
  /** 会话 id 读取回调（start 时 resume 用；runner-core 接 state-store） */
  getSessionId?: (seatId: string) => string | undefined;
  /** 会话 id 落盘回调（session/new 或 resume 后；runner-core 接 state-store） */
  onSessionId?: (seatId: string, sessionId: string) => void;
  /** 日志器（默认 ConsoleLogger info） */
  logger?: Logger;
  /**
   * 优雅取消兜底超时（ms，默认 10_000）：`session/cancel` 通知后等 prompt resolve 的
   * 时限，超时未响应才走既有 kill 兜底（防御 agent 不应答；kimi 0.34.0 实测 cancel
   * 后 8ms 即 resolve cancelled，10s 是防御性上限）。测试注入短值覆盖超时分支。
   */
  cancelKillTimeoutMs?: number;
}

/**
 * ACP 座位驱动基座（契约① SeatDriver 的一个实现；r4 统一层=SeatDriver 而非 ACP）
 */
export class AcpDriver implements SeatDriver {
  private readonly profile: AcpVendorProfile;
  private readonly logger: Logger;
  private readonly sessions = new Map<string, AcpSession>();
  private eventHandler: ((event: SeatEvent) => void) | null = null;

  constructor(private readonly options: AcpDriverOptions) {
    this.profile = options.profile;
    this.logger = options.logger ?? new ConsoleLogger({ level: 'info' });
  }

  /** 事件出口（上行全部走这里；重复设置覆盖） */
  onEvent(handler: (event: SeatEvent) => void): void {
    this.eventHandler = handler;
  }

  /** 事件透传出口 */
  private emit(event: SeatEvent): void {
    this.eventHandler?.(event);
  }

  // ─────────────────────────── SeatDriver 接口实现 ───────────────────────────

  /**
   * 拉起或复活座位对应的运行时会话（幂等：已活则复用）。
   * 流程：spawn acp 子进程 → initialize → 有落盘 sessionId 则 session/resume 否则
   * session/new（档案 #1）→ set_config_option 钉死权限档位（档案 #5，profile 映射）→
   * 可选 model 覆盖（档案 #6）。
   * 失败抛错（不 emit status，由 runner-core 捕获后上行 status offline 事件，避免双发）。
   */
  async start(config: SeatConfig): Promise<void> {
    const existing = this.sessions.get(config.seatId);
    if (existing && !existing.dead && existing.started) {
      existing.config = config; // 幂等复用（config 更新仅记录，不重启会话）
      return;
    }
    const session = this.launch(config);
    this.sessions.set(config.seatId, session);
    try {
      await this.initialize(session);
      await this.ensureSession(session);
      this.emit({ type: 'status', seatId: config.seatId, status: 'online' });
    } catch (err) {
      session.dead = true;
      this.teardown(session);
      this.sessions.delete(config.seatId);
      throw err;
    }
  }

  /**
   * 注入一轮 prompt（单飞行）：busy 时抛 BusyError。
   * 座位无活进程时按「叫醒」语义自动 spawn + resume 复活（设计 §1：消息到达时
   * 座位无活进程 → spawn + resume，已实测无损）。
   * turn 终结：message_complete（stopReason + silent 判定）→ 释放 busy。
   * 异常终结（畸形响应/子进程退出）：message_complete(stopReason='error')，同样释放
   * busy——否则 chamber 侧座位永久 busy 死锁。
   */
  async inject(seatId: string, prompt: InjectedPrompt): Promise<void> {
    let session = this.sessions.get(seatId);
    if (!session || session.dead || !session.started) {
      const config = session?.config;
      if (!config) {
        throw new Error(`seat ${seatId} has no config (seat.assign not received?)`);
      }
      session = this.launch(config);
      this.sessions.set(seatId, session);
      await this.initialize(session);
      await this.ensureSession(session);
    }
    if (session.busy) {
      throw new BusyError(seatId);
    }
    session.busy = true;
    session.streamedText = '';
    // 新一轮 turn：复位优雅取消标志 + 清残留超时句柄（上一轮 cancel 已终结；
    // R2：cancel 后 agent 自然 end_turn 时兜底超时器必须已清，不得误杀）
    session.cancelling = false;
    this.clearCancelTimer(session);
    this.emit({ type: 'status', seatId, status: 'busy' });
    const turn = this.runPrompt(session, prompt);
    session.turnPromise = turn;
    try {
      await turn;
    } finally {
      session.busy = false;
      session.turnPromise = null;
      // R2：prompt resolve（任何 stopReason / 异常）必须清超时句柄——agent 在兜底
      // 超时前自然 end_turn 时不得被 kill 误杀
      this.clearCancelTimer(session);
    }
  }

  /**
   * 执行一轮 prompt 并收尾：request → message_complete（stopReason + silent 判定）。
   * 异常终结（畸形响应/子进程退出）也发 message_complete(stopReason='error') 释放
   * chamber 单飞行——否则座位永久 busy 死锁；错误继续抛给调用方（runner-core 据此
   * 上行 status offline / 记日志——只 emit 不抛会让调用方误以为 turn 正常完成）。
   */
  private async runPrompt(session: AcpSession, prompt: InjectedPrompt): Promise<void> {
    const seatId = session.config.seatId;
    try {
      const result = await this.request(session, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: prompt.text }],
      });
      const resultObj = (result ?? {}) as { stopReason?: unknown };
      const stopReason =
        typeof resultObj.stopReason === 'string' && resultObj.stopReason.length > 0
          ? resultObj.stopReason
          : 'error';
      // 沉默判定：本侧累积全文，宽松解析（§3/§4 上行回复约定 r3 冻结）
      const silent = parseSilentReply(session.streamedText);
      // text 随 complete 上行：chamber 重启清空 chunk buffer 后仍能落库（dogfood 实测缺口）
      this.emit({
        type: 'message_complete',
        seatId,
        stopReason,
        silent,
        text: session.streamedText,
      });
      this.logger.info(
        `seat ${seatId} turn done stopReason=${stopReason} silent=${silent} (streamed ${session.streamedText.length} chars)`,
      );
    } catch (err) {
      this.logger.error(
        `seat ${seatId} prompt failed: ${String(err instanceof Error ? err.message : err)}`,
      );
      // 异常终结也要发 message_complete（释放 chamber 单飞行），stopReason='error' 标记
      this.emit({ type: 'message_complete', seatId, stopReason: 'error' });
      if (session.dead) {
        this.emit({
          type: 'status',
          seatId,
          status: 'offline',
          detail: `${this.profile.vendorName} acp exited`,
        });
      }
      throw err;
    }
  }

  /**
   * 应答挂起的审批请求（人类裁决下行 → session/request_permission 的反向 RPC 应答）。
   * optionId 在挂起选项里**精确匹配**（RT-PERM-1：optionId 命名空间与 ACP
   * request_permission params 同源——runner-core 缓存与 driver 挂起表来自同一事件，
   * 精确匹配即可；kind 是厂商自由命名不可信，禁止按 kind 猜测映射）。命中答
   * { outcome: 'selected', optionId }；未命中答 cancelled 并 warn（不选任何选项）。
   * 审批已随 turn 结束关闭（挂起表已清）→ 幂等忽略（chamber 重放 verdict 的场景）。
   */
  async answerPermission(seatId: string, requestId: string, optionId: string): Promise<void> {
    const session = this.sessions.get(seatId);
    const perm = session?.permissions.get(requestId);
    if (!session || !perm || session.dead) {
      this.logger.warn(
        `answerPermission: seat ${seatId} requestId ${requestId} not pending (turn closed?)`,
      );
      return;
    }
    const option = perm.options.find((o) => String(o.optionId) === optionId);
    let outcome: PermissionOutcome;
    if (option) {
      outcome = { outcome: { outcome: 'selected', optionId } };
    } else {
      this.logger.warn(
        `answerPermission: optionId ${optionId} not found in requestId ${requestId} options (answering cancelled)`,
      );
      outcome = { outcome: { outcome: 'cancelled' } };
    }
    this.respond(session, Number(requestId), { result: outcome });
    session.permissions.delete(requestId);
    this.logger.info(
      `seat ${seatId} permission ${requestId} answered optionId=${optionId} -> ${JSON.stringify(outcome)}`,
    );
  }

  /**
   * 优雅取消当前 turn（双厂商统一——kimi 0.34.0 / codex 0.147.0 实测均支持
   * `session/cancel`，推翻「ACP 无 cancel 方法，kill 即打断」旧认知，见
   * scripts/acp-cancel-probe.mjs）：
   * - R1 busy 门控：无 in-flight prompt（busy=false）→ 幂等直接返回，**禁止 kill 空闲
   *   会话**（否则兜底 kill 会误杀健康进程）；
   * - session.cancelling 幂等：重复 cancel no-op；
   * - `session/cancel` 通知（无 id、不等响应）→ 对挂起审批逐个应答 Cancelled
   *   （ACP 规范 MUST：不答 agent 侧审批会楔死）；
   * - 等 prompt 正常 resolve（stopReason=cancelled → 单条 message_complete，会话存活
   *   可续聊）；prompt resolve（任何 stopReason）时清超时句柄（R2：agent 在超时前
   *   自然 end_turn 不得误杀）；
   * - 超时未响应 → 既有 kill 路径兜底（触发前再查 busy——turn 可能已在竞态中终结）。
   */
  async cancel(seatId: string): Promise<void> {
    const session = this.sessions.get(seatId);
    if (!session || session.dead) {
      return; // 无活动会话：幂等
    }
    if (!session.busy || session.cancelling) {
      // R1：空闲会话（无 in-flight prompt）或已在取消中 → 幂等 no-op，不碰子进程
      return;
    }
    session.cancelling = true;
    this.logger.info(`seat ${seatId} cancel: session/cancel notify (graceful)`);
    // ACP 通知：无 id、不登记 pending、不等响应（SDK AgentClient.cancel 同款语义）
    this.notify(session, 'session/cancel', { sessionId: session.sessionId });
    // ACP 规范 MUST：取消时对挂起审批逐个应答 Cancelled（历史代码无人清理——
    // 不答则 agent 侧审批挂起楔死，turn 无法收尾）
    for (const requestId of [...session.permissions.keys()]) {
      this.respond(session, Number(requestId), { result: { outcome: { outcome: 'cancelled' } } });
      this.logger.info(`seat ${seatId} pending permission ${requestId} answered cancelled`);
    }
    session.permissions.clear();
    // 等 prompt 正常 resolve（stopReason=cancelled → 单条 message_complete，会话存活
    // 续聊）；10s 无响应 → 既有 kill 路径兜底（会话已落盘可 resume 复活）
    const turn = session.turnPromise;
    if (turn) {
      const timeoutMs = this.options.cancelKillTimeoutMs ?? CANCEL_KILL_TIMEOUT_MS;
      const timeout = new Promise<void>((resolve) => {
        session.cancelTimer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([turn, timeout]);
      this.clearCancelTimer(session);
      if (session.busy) {
        // 触发前再查 busy：turn 可能已在超时竞态中自然终结（R2），不得误杀
        this.logger.warn(
          `seat ${seatId} cancel: ${this.profile.vendorName} acp no response within ${timeoutMs}ms, killing (session persisted, resumable)`,
        );
        // kill 是异步的（SIGTERM → 退出事件稍后到）：立即标记 dead，
        // 使后续 inject 走「叫醒」重新 spawn 分支，不向将死的进程发请求
        session.dead = true;
        session.busy = false;
        this.kill(session);
        this.emit({ type: 'status', seatId, status: 'offline', detail: 'cancelled' });
      }
    }
  }

  /** JSON-RPC 通知（无 id、不登记 pending；fire-and-forget 单向消息，如 session/cancel） */
  private notify(session: AcpSession, method: string, params: Record<string, unknown>): void {
    try {
      session.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch (err) {
      this.logger.warn(`notify ${method} write failed: ${String(err)}`);
    }
  }

  /** 清优雅取消超时句柄（turn 终结 / 新一轮 inject 时调用；R2 防自然 end_turn 被兜底 kill 误杀） */
  private clearCancelTimer(session: AcpSession): void {
    if (session.cancelTimer) {
      clearTimeout(session.cancelTimer);
      session.cancelTimer = null;
    }
  }

  /** 停掉座位运行时（杀子进程；会话已落盘，随时可 start 复活） */
  async stop(seatId: string): Promise<void> {
    const session = this.sessions.get(seatId);
    if (session && !session.dead) {
      this.kill(session);
      this.emit({ type: 'status', seatId, status: 'offline' });
    }
    this.sessions.delete(seatId);
  }

  /** 停止全部座位运行时（runner 退出/cli 收尾/测试清理用，逐个 stop） */
  async stopAll(): Promise<void> {
    for (const seatId of [...this.sessions.keys()]) {
      await this.stop(seatId);
    }
  }

  // ─────────────────────────── ACP 传输层（acp-poc 提升） ───────────────────────────

  /** spawn acp 子进程（命令与 env 由 profile 决定）并挂接 stdout 分帧 / stderr 透传 / exit 清理 */
  private launch(config: SeatConfig): AcpSession {
    const { bin, args, env } = this.profile.spawnCommand(config);
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const session: AcpSession = {
      config,
      child,
      nextId: 1,
      pending: new Map(),
      permissions: new Map(),
      streamedText: '',
      busy: false,
      cancelling: false,
      cancelTimer: null,
      turnPromise: null,
      started: false,
      sessionId: null,
      dead: false,
      configSnapshot: {},
      toolMeta: new Map(),
    };
    child.stderr?.on('data', (d: Buffer) => {
      // agent 诊断日志透传（不污染协议观察；acp-poc 同款模式）
      this.logger.debug(`[${this.profile.vendorName}:stderr] ${d.toString().trimEnd()}`);
    });
    child.on('error', (err) => this.onChildError(session, err));
    child.on('exit', (code, signal) => this.onChildExit(session, code, signal));
    const rl = readline.createInterface({ input: child.stdout ?? undefined });
    rl.on('line', (line) => this.onLine(session, line));
    return session;
  }

  /** 子进程 spawn 失败（如二进制不存在）：拒绝全部 pending，标记 dead */
  private onChildError(session: AcpSession, err: Error): void {
    this.logger.error(`${this.profile.vendorName} acp spawn error: ${String(err)}`);
    session.dead = true;
    this.rejectAll(
      session,
      new Error(`${this.profile.vendorName} acp spawn failed: ${String(err)}`),
    );
  }

  /** 子进程退出：拒绝全部 pending（prompt 挂起方感知 turn 异常），标记 dead */
  private onChildExit(
    session: AcpSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.logger.warn(`${this.profile.vendorName} acp exited code=${code} signal=${String(signal)}`);
    session.dead = true;
    this.rejectAll(session, new Error(`${this.profile.vendorName} acp exited (code=${code})`));
  }

  /** 拒绝并清空 pending（子进程退出/spawn 失败时） */
  private rejectAll(session: AcpSession, err: Error): void {
    for (const { reject } of session.pending.values()) {
      reject(err);
    }
    session.pending.clear();
  }

  /** 子进程清理：杀进程 + 关闭 stdin（死进程挂着的 readline 一并释放） */
  private teardown(session: AcpSession): void {
    try {
      session.child.kill('SIGKILL');
    } catch {
      // 已退出则忽略
    }
  }

  /** 杀子进程（SIGTERM，acp-poc close() 同款） */
  private kill(session: AcpSession): void {
    try {
      session.child.kill('SIGTERM');
    } catch {
      // 已退出则忽略
    }
  }

  /** NDJSON 分帧：stdout 每行一个 JSON-RPC 对象（acp-poc readline 模式） */
  private onLine(session: AcpSession, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.logger.warn(`non-JSON line from agent: ${trimmed.slice(0, 200)}`);
      return;
    }
    this.dispatch(session, msg as Record<string, unknown>);
  }

  /** 三分发：响应 / 反向 RPC / 通知（acp-poc #dispatch 提升） */
  private dispatch(session: AcpSession, msg: Record<string, unknown>): void {
    const id = msg.id;
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    // 1) 响应：有 id 且对应 pending 请求
    if (id !== undefined && typeof id === 'number' && session.pending.has(id)) {
      const pending = session.pending.get(id)!;
      session.pending.delete(id);
      const hasResult = 'result' in msg;
      const hasError = 'error' in msg;
      if (hasError) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(msg.error)}`));
      } else if (hasResult) {
        pending.resolve(msg.result);
      } else {
        // 畸形响应（档案 #4 wire 表现）：无 result 无 error
        pending.reject(new MalformedResponseError(pending.method));
      }
      return;
    }
    // 2) 反向请求：agent → client（有 id + method），必须应答
    if (id !== undefined && method) {
      void this.handleReverseRequest(session, msg);
      return;
    }
    // 3) 通知：无 id（session/update 流式块等）
    this.handleNotification(session, msg);
  }

  /** 反向 RPC：session/request_permission → permission_request 事件（挂起等应答）；其余 methodNotFound */
  private async handleReverseRequest(
    session: AcpSession,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const id = msg.id;
    const method = String(msg.method);
    const params = (msg.params ?? {}) as Record<string, unknown>;
    try {
      if (method === 'session/request_permission') {
        // 档案 #2：审批全异步——只上报事件，不自动应答（平台零缺省，无超时 park）。
        // requestId = 反向 RPC id 原文（codex 从 0 起、kimi 小整数——跨座位可能撞键，
        // 防串台在 runner-core 缓存层按 seatId 前缀化，本层只透传）
        const options = Array.isArray(params.options) ? (params.options as PermissionOption[]) : [];
        const requestId = String(id);
        session.permissions.set(requestId, { options });
        const tool = (params.toolCall ?? params.tool ?? {}) as ToolBrief;
        // M4b-1 ②（踩坑⑨）：codex 桥 request_permission 的 toolCall 缺 title（DB 实测仅
        // {kind,status,toolCallId}）→ 从 toolMeta 缓存（同 toolCallId 的 tool_call 通知）
        // 补缺省 title，recentActivity 才能显示真实工具名而非 "unknown tool"。只补缺省
        // 不覆盖：kimi 自带 title 的路径零影响；缓存 miss（重启/前置无 tool_call）→
        // 原样透传，优雅降级为现状
        const meta = session.toolMeta.get(String(tool.toolCallId ?? tool.id ?? ''));
        const toolWithTitle =
          tool.title === undefined && typeof meta?.title === 'string' && meta.title.length > 0
            ? { ...tool, title: meta.title }
            : tool;
        this.emit({
          type: 'permission_request',
          seatId: session.config.seatId,
          requestId,
          tool: toolWithTitle,
          options,
        });
        this.logger.info(
          `permission_request seat ${session.config.seatId} requestId ${requestId} options=${options.map((o) => String(o.kind)).join(',')}`,
        );
        return;
      }
      // 未实现的反向方法：按 JSON-RPC 规范回 methodNotFound（driver 不声明 fs caps，
      // agent 不应发起 fs RPC；防御性应答避免挂起 agent 侧）
      this.respond(session, id, {
        error: { code: -32601, message: `method not found: ${method}` },
      });
    } catch (err) {
      this.respond(session, id, {
        error: { code: -32603, message: String(err instanceof Error ? err.message : err) },
      });
    }
  }

  /** 通知分发：session/update（流式块/工具事件）、usage_update、current_mode_update */
  private handleNotification(session: AcpSession, msg: Record<string, unknown>): void {
    const method = String(msg.method ?? '');
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (method === 'session/update') {
      const update = params.update as Record<string, unknown> | undefined;
      if (update && typeof update === 'object') {
        const kind = String(update.sessionUpdate ?? '');
        if (kind === 'agent_message_chunk') {
          const content = update.content as Record<string, unknown> | undefined;
          if (content?.type === 'text' && typeof content.text === 'string') {
            // 流式增量：累积全文（沉默判定用）+ 事件上行
            session.streamedText += content.text;
            this.emit({ type: 'message_chunk', seatId: session.config.seatId, text: content.text });
            return;
          }
        } else if (kind === 'tool_call' || kind === 'tool_response') {
          // 工具调用可观测（M2 过程折叠视图数据源；字段未冻结，宽松透传——RT-PERM-2：
          // 工具元数据（toolCallId/title/kind/status/locations/rawInput）挂在 update
          // 本体上，content 是内容块数组或缺失——取 content 当 tool 载荷会被 chamber
          // 校验丢弃）。透传整个 update 对象（浅拷贝后剥离 sessionUpdate 键），
          // 保证 tool 永远是对象。
          const tool = { ...update };
          delete tool.sessionUpdate;
          // toolMeta 缓存（M4b-1 ②）：按 toolCallId 记录工具元数据，供 request_permission
          // 补缺省 title——codex 桥审批载荷不带 title（DB 实测仅 {kind,status,toolCallId}，
          // 而 7ms 前同 toolCallId 的 tool_event 有 title）。key 兼容 toolCallId/id 双键
          // （真机与 fixture 形状不一）；cap 100 FIFO 防无限增长（Map 迭代序=插入序，
          // 删最早键）；tool_response 覆盖写（status 更新不影响 title）
          const metaKey = String(tool.toolCallId ?? tool.id ?? '');
          if (metaKey) {
            if (session.toolMeta.size >= 100 && !session.toolMeta.has(metaKey)) {
              session.toolMeta.delete(session.toolMeta.keys().next().value as string);
            }
            session.toolMeta.set(metaKey, { title: tool.title, kind: tool.kind });
          }
          this.emit({
            type: 'tool_event',
            seatId: session.config.seatId,
            tool: tool as ToolEventPayload,
          });
          return;
        }
        // 其他 update（agent_thought_chunk 等）：M1 只记日志
        this.logger.debug(`session/update kind=${kind} (ignored)`);
        return;
      }
    }
    if (method === 'usage_update') {
      // 档案 #3：用量可观测（used/size）；shape 宽松读取（params 直挂或嵌套 usage）
      const used = this.readNumber(params, 'used') ?? this.readNumber(params.usage, 'used');
      const size = this.readNumber(params, 'size') ?? this.readNumber(params.usage, 'size');
      if (used !== undefined && size !== undefined) {
        this.emit({ type: 'usage', seatId: session.config.seatId, used, size });
      } else {
        this.logger.debug(`usage_update without used/size: ${JSON.stringify(params)}`);
      }
      return;
    }
    if (method === 'current_mode_update') {
      // 档案 #6：set_config_option 的确认通知——除 debug 日志外，若载荷可解析出 mode
      // 也合并进配置快照并触发一次 seat_info 上行（热更新可见；M3 阶段 5 本批仅观测，
      // 不做下发钉死——座位侧实际怎么跑就展示什么）
      const mode = this.readModeFromParams(params);
      if (mode) {
        session.configSnapshot = { ...session.configSnapshot, mode };
        this.emitSeatInfo(session);
        this.logger.debug(`current_mode_update: mode=${mode} (reported via seat_info)`);
      } else {
        this.logger.debug(`current_mode_update: ${JSON.stringify(params)}`);
      }
      return;
    }
    this.logger.debug(`notification method=${method} (ignored)`);
  }

  /** 宽松数字读取：从对象里取数字字段（兼容嵌套） */
  private readNumber(obj: unknown, key: string): number | undefined {
    if (obj === null || typeof obj !== 'object') return undefined;
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  /** JSON-RPC 请求并等待响应（pending Map；畸形响应 → MalformedResponseError） */
  private request(
    session: AcpSession,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      session.pending.set(id, { resolve, reject, method });
      try {
        session.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        session.pending.delete(id);
        reject(new Error(`write to ${this.profile.vendorName} acp failed: ${String(err)}`));
      }
    });
  }

  /** 应答 agent 发起的反向 RPC（acp-poc #respond 提升） */
  private respond(session: AcpSession, id: unknown, body: Record<string, unknown>): void {
    try {
      session.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
    } catch (err) {
      this.logger.warn(`respond failed (id=${String(id)}): ${String(err)}`);
    }
  }

  /** initialize：版本协商 + 声明 client 能力（档案 #4：**不声明 fs caps**） */
  private async initialize(session: AcpSession): Promise<void> {
    const init = await this.request(session, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { terminal: false }, // 铁律：不声明 fs（0.34.0 bug：fs 写入后 turn 静默死亡）
      clientInfo: { name: CLIENT_NAME, version: DRIVER_VERSION },
    });
    const info = (init ?? {}) as { agentInfo?: { name?: string; version?: string } };
    this.logger.debug(
      `initialize ok: agent=${String(info.agentInfo?.name)}@${String(info.agentInfo?.version)}`,
    );
  }

  /**
   * 会话建立：有落盘 sessionId → 先 session/resume（档案 #1 无损复活）；resume 失败
   * （agent 侧会话文件被清理/损坏，缓存 id 失效）→ 记 warn 降级 session/new 重建
   * （new 成功后 onSessionId 落盘新 id，自然覆盖失效旧 id，无需额外清理）；
   * 无落盘 id → 直接 session/new。随后按 profile 钉死权限档位 + 可选 model，并上行
   * 一次 seat_info（M3 阶段 5：实际在跑配置观测——session/new 或 session/resume 响应的
   * configOptions 当前值 + 钉死值合并，new/resume 两条路径统一覆盖）。
   */
  private async ensureSession(session: AcpSession): Promise<void> {
    const seatId = session.config.seatId;
    const persisted = this.options.getSessionId?.(seatId);
    let sessionId: string;
    let initResult: unknown;
    if (persisted) {
      try {
        const r = await this.request(session, 'session/resume', {
          sessionId: persisted,
          cwd: session.config.cwd,
          mcpServers: [],
        });
        const rr = (r ?? {}) as { sessionId?: unknown };
        sessionId = typeof rr.sessionId === 'string' ? rr.sessionId : persisted;
        initResult = r;
        this.logger.info(`seat ${seatId} resumed session ${sessionId}`);
      } catch (err) {
        // 缓存 sessionId 失效（agent 侧会话文件被清理/损坏）：resume 抛错若直接冒泡，
        // 该座位永久起不来——降级 session/new 重建，让座位恢复可服务
        this.logger.warn(
          `seat ${seatId} session/resume failed (sessionId=${persisted}), falling back to session/new: ${String(err instanceof Error ? err.message : err)}`,
        );
        const created = await this.createSession(session);
        sessionId = created.sessionId;
        initResult = created.result;
      }
    } else {
      const created = await this.createSession(session);
      sessionId = created.sessionId;
      initResult = created.result;
    }
    session.sessionId = sessionId;
    session.started = true;
    // 会话映射落盘（崩溃/重启后 resume 复活；new 重建时覆盖失效旧 id）
    this.options.onSessionId?.(seatId, sessionId);
    // 档案 #5：显式钉死权限档位（config.toml yolo 泄漏防护；kimi 单条 mode，
    // codex 拆 mode + collaboration_mode——profile 映射）；档案 #6：可选 model 覆盖
    for (const entry of this.profile.modeConfigEntries(session.config.permissionMode)) {
      await this.request(session, 'session/set_config_option', {
        sessionId,
        configId: entry.configId,
        value: entry.value,
      });
    }
    if (session.config.model) {
      await this.request(session, 'session/set_config_option', {
        sessionId,
        configId: 'model',
        value: session.config.model,
      });
    }
    // M3 阶段 5：解析会话初始化响应里的 configOptions 当前值（宽松读取，防缺省；
    // kimi 形状 {configId,value}、codex 形状 {id,currentValue} 双形态兼容，R2）
    session.configSnapshot = this.extractConfigSnapshot(initResult);
    // mode 以钉死档位为准（档案 #5：configOptions 展示值可能为 config.toml 泄漏值——
    // 「显示 default 实为 yolo」，钉死后的实际在跑 = permissionMode，泄漏展示值不误报；
    // 后续 current_mode_update 确认值可热更新覆盖）
    session.configSnapshot.mode = session.config.permissionMode;
    this.emitSeatInfo(session);
  }

  /** 新建会话（session/new）：resume 失败降级与无落盘 id 共用路径 */
  private async createSession(
    session: AcpSession,
  ): Promise<{ sessionId: string; result: unknown }> {
    const seatId = session.config.seatId;
    const r = await this.request(session, 'session/new', {
      cwd: session.config.cwd,
      mcpServers: [],
    });
    const rr = (r ?? {}) as { sessionId?: unknown };
    const sessionId = typeof rr.sessionId === 'string' ? rr.sessionId : '';
    if (!sessionId) {
      throw new Error('session/new returned no sessionId');
    }
    this.logger.info(`seat ${seatId} new session ${sessionId} cwd=${session.config.cwd}`);
    return { sessionId, result: r };
  }

  /**
   * 从会话初始化响应宽松解析 configOptions 当前值（model/thinking/mode 三项）。
   * 为什么宽松：ACP session/new 响应形状未在本仓 fixture 全量验证（fixture 仅
   * `{ sessionId }`）——按档案 #6「configOptions 可切换」与常见 ACP 形状双形态
   * 防御读取：条目数组按 id/configId/name 匹配、值按 currentValue/value/current/
   * defaultValue 取；或对象按键取 value/current。解析不出就缺省（厂商字段可能有缺）。
   * 思考等级键名厂商不同：kimi 'thinking'；codex 'reasoning_effort'（category
   * thought_level）→ 统一映射到 snap.thinking（R2，否则 codex seat_info 三件套缺一角）。
   */
  private extractConfigSnapshot(result: unknown): ConfigSnapshot {
    if (result === null || typeof result !== 'object') return {};
    const root = result as Record<string, unknown>;
    const opts = root.configOptions;
    const snap: ConfigSnapshot = {};
    if (Array.isArray(opts)) {
      // 形态①：configOptions 为条目数组，每条 { configId|id|name, value|currentValue|current|defaultValue }
      for (const entry of opts) {
        if (entry === null || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const id = String(e.configId ?? e.id ?? e.name ?? '');
        const value = e.value ?? e.currentValue ?? e.current ?? e.defaultValue;
        if (typeof value !== 'string' || value.length === 0) continue;
        if (id === 'model') snap.model = value;
        else if (id === 'thinking' || id === 'reasoning_effort') snap.thinking = value;
        else if (id === 'mode') snap.mode = value;
      }
      return snap;
    }
    if (opts !== null && typeof opts === 'object') {
      // 形态②：configOptions 为对象，{ model|thinking|mode: { value|current } }
      for (const key of ['model', 'thinking', 'mode'] as const) {
        const entry = (opts as Record<string, unknown>)[key];
        if (entry === null || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const value = e.value ?? e.current;
        if (typeof value === 'string' && value.length > 0) snap[key] = value;
      }
    }
    return snap;
  }

  /**
   * current_mode_update 载荷宽松解析 mode：直接键（mode/currentMode）或
   * { configId: 'mode', value } 形态；解析不出返回 undefined（仅记日志）。
   */
  private readModeFromParams(params: Record<string, unknown>): string | undefined {
    for (const key of ['mode', 'currentMode']) {
      const v = params[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    if (params.configId === 'mode' && typeof params.value === 'string' && params.value.length > 0) {
      return params.value;
    }
    return undefined;
  }

  /**
   * 上行一次 seat_info（M3 阶段 5 观测：model/thinking/mode 实际在跑值，全可选宽松）。
   * 取值优先级：model = seat.assign 显式钉死值优先（set_config_option model 后实际在跑
   * 即 config.model），configOptions 解析值兜底（无显式覆盖时即会话默认模型）；
   * mode = 快照值（ensureSession 后恒为钉死 permissionMode，current_mode_update
   * 确认值热更新覆盖）兜底 permissionMode；thinking 仅 configOptions 来源。
   */
  private emitSeatInfo(session: AcpSession): void {
    const snap = session.configSnapshot ?? {};
    const event: Extract<SeatEvent, { type: 'seat_info' }> = {
      type: 'seat_info',
      seatId: session.config.seatId,
      ...((session.config.model ?? snap.model)
        ? { model: session.config.model ?? snap.model }
        : {}),
      ...(snap.thinking ? { thinking: snap.thinking } : {}),
      // mode 恒可上报：座位 start 后必已钉死 permissionMode（档案 #5 泄漏防护）
      mode: snap.mode ?? session.config.permissionMode,
    };
    this.emit(event);
    this.logger.debug(
      `seat_info seat ${session.config.seatId}: model=${String(event.model ?? '-')} thinking=${String(event.thinking ?? '-')} mode=${String(event.mode ?? '-')}`,
    );
  }
}
