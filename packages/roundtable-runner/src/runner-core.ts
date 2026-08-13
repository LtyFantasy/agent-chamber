/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §3 (契约①: SeatDriver 接口——座位生命周期/单飞行语义)
 *   - 补充: docs/roundtable-design.md §4 (契约②: 控制面信封——seat.inject 下行/seat.event 上行)
 *           docs/roundtable-design.md §6 (会话层规则: prompt 规则头装配, runner 禁改)
 *
 * [踩坑索引] ④(getSessionId 漏接→resume 永不生效) ⑤(RT-PERM-1: kind 命名不可信→optionId 直透)
 *              ⑧(R1: 审批缓存裸 requestId 跨座位撞键→codex/kimi 双座位并发审批互相覆盖)
 *
 * [铁律关联] #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   ④: getSessionId 回调漏接 → state 里 sessionId 读不出 → 每次重启都 session/new，
 *      resume 永不生效（dogfood 验收②疑点根因）。修复：构造 KimiAcpDriver 时把
 *      state.getSessionId 接通为 getSessionId。见 memory/2026-08-07.md §6
 *   ⑤: RT-PERM-1 —— ACP 审批选项的 kind 是厂商自由命名（真机为 allow_once/
 *      allow_always/reject_once），按猜测的 approve_* 做 kind→verdict 双重映射会把
 *      approve 吞成 reject（P0 真机复现：点 Approve for this session 落库
 *      approve_always，agent 端实际被拒）。根治：kind 命名不可信，optionId 才是
 *      稳定键（与 request_permission params 同源）——handleVerdict 反查 option
 *      存在后把 optionId 原样透传 driver，禁止 kind 猜测映射。
 *   ⑧: R1 —— codex 桥反向 RPC id 从 0 自增、kimi 小整数自增，两侧 requestId 同
 *      命名空间；permissions 缓存若以裸 requestId 为 key，双座位并发审批必互相
 *      覆盖、verdict 反查错位（裁决被忽略/审批楔死，RT-PERM-2 的 runner 侧镜像）。
 *      修复：缓存 key 改 `${seatId}:${requestId}`，set/查/删/revoke 清理同步前缀化。
 *      见 memory/2026-08-10.md §R1
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * Runner 核心编排（组装 driver + ws-client + state-store，处理座位生命周期）
 *
 * 职责（M1 计划 §三 + 阶段 4 交付物）：
 * - seat.assign 落地：**先校验 cwd 存在**（不存在回 status error 事件，不拉起子进程）→
 *   记录配置 → driver.start（幂等）；start 失败回 status offline（不 crash）
 * - seat.inject：prompt 文本装配（`ruleHeader + '\n\n' + JSON.stringify(body, null, 2)`，
 *   设计 §4/§6：runner 与 prompt 作者禁止改写规则头）→ driver.inject；BusyError 回
 *   status busy（防御，chamber 单飞行本应保证不重发）；其余错误回 status offline
 * - driver onEvent → 上行 seat.event（ws-client 先落盘再发送）；permission_request 事件
 *   缓存 options（verdict 下行反查 option 真实性用）
 * - seat.permission_verdict → optionId 查缓存 options 确认存在后**原样透传** →
 *   driver.answerPermission（RT-PERM-1：不做 kind→verdict 映射）
 * - seat.cancel → driver.cancel；seat.revoke → driver.stop + 清状态（state + 本地记录）
 *
 * 连接/心跳/对账/重放全在 ws-client；会话映射/游标/未确认队列全在 state-store——
 * 本类只做「下行信封 → 座位操作」与「座位事件 → 上行信封」的编排，不碰线缆细节。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseInjectBody,
  type Envelope,
  type InjectPayload,
  type PermissionOption,
  type PermissionVerdictPayload,
  type SeatConfig,
  type SeatEvent,
} from '@agent-chamber/roundtable-protocol';
import { BusyError } from './drivers/seat-driver';
import type { InjectedPrompt, SeatDriver } from './drivers/seat-driver';
import { KimiAcpDriver } from './drivers/kimi-acp';
import { CodexAcpDriver } from './drivers/codex-acp';
import { StateStore } from './state-store';
import { RunnerWsClient } from './ws-client';
import { ConsoleLogger } from './logger';
import type { Logger } from './logger';

/** 默认状态目录（--state-dir 未指定时） */
function defaultStateDir(): string {
  return path.join(os.homedir(), '.roundtable-runner');
}

/** RunnerCore 构造选项 */
export interface RunnerCoreOptions {
  /** 平台地址（http(s)://host:port） */
  platformUrl: string;
  /** 平台 API Key */
  apiKey: string;
  /** runner 名称（hello 上报） */
  runnerName: string;
  /** runner 版本（hello 上报） */
  version: string;
  /** 状态目录（默认 ~/.roundtable-runner；与 state 二选一，测试注入 state 用） */
  stateDir?: string;
  /** 状态存储（测试注入；缺省按 stateDir 自建） */
  state?: StateStore;
  /**
   * 座位驱动注入口（按 vendor 注入；测试注入 fake 用。缺省按 vendor 懒加载默认工厂：
   * kimi → KimiAcpDriver、codex → CodexAcpDriver，一个 vendor 一个实例）
   */
  drivers?: Partial<Record<string, SeatDriver>>;
  /** 日志器（默认 ConsoleLogger info） */
  logger?: Logger;
  /** 致命错误回调（ws-client 认证失败/被顶替；cli 里退出进程） */
  onFatal?: (reason: string) => void;
}

/** Runner 核心编排器 */
export class RunnerCore {
  private readonly logger: Logger;
  private readonly state: StateStore;
  /** vendor → 驱动实例（懒加载工厂：首个该 vendor 座位 assign 时创建，一个 vendor 一个实例） */
  private readonly drivers = new Map<string, SeatDriver>();
  private readonly wsClient: RunnerWsClient;
  /** 已绑定座位配置（seatId → SeatConfig；seat.assign 落地后记录） */
  private readonly seats = new Map<string, SeatConfig>();
  /**
   * 审批选项缓存：`${seatId}:${requestId}` → { seatId, options }
   * （R1：key 必须带 seatId 前缀——codex 反向 RPC id 从 0 起、kimi 小整数自增，
   * 两侧 requestId 同命名空间，裸 requestId 双座位并发审批必互相覆盖）
   */
  private readonly permissions = new Map<string, { seatId: string; options: PermissionOption[] }>();

  constructor(private readonly options: RunnerCoreOptions) {
    this.logger = options.logger ?? new ConsoleLogger({ level: 'info' });
    this.state =
      options.state ??
      new StateStore({ dir: options.stateDir ?? defaultStateDir(), logger: this.logger });
    this.state.load();
    this.wsClient = new RunnerWsClient({
      platformUrl: options.platformUrl,
      apiKey: options.apiKey,
      runnerName: options.runnerName,
      version: options.version,
      state: this.state,
      logger: this.logger,
      onDownlink: (envelope) => this.onDownlink(envelope),
      onFatal: options.onFatal,
    });
  }

  /**
   * vendor → 默认驱动工厂（懒加载时构造）。仅 kimi/codex 生产；未知 vendor 返回 null
   * （handleAssign 据此回 status offline，不 crash）。
   */
  private defaultDriverFor(vendor: string): SeatDriver | null {
    if (vendor === 'kimi') {
      return new KimiAcpDriver({
        logger: this.logger,
        // 会话映射读取：start 时 resume 复活用（onSessionId 的读取端，缺它永远 session/new）
        getSessionId: (seatId: string) => this.state.getSessionId(seatId),
        // 会话映射落盘：driver 建立/复用 ACP 会话后写入 state（崩溃/重启后 resume 复活）
        onSessionId: (seatId: string, sessionId: string) =>
          this.state.setSessionId(seatId, sessionId),
      });
    }
    if (vendor === 'codex') {
      return new CodexAcpDriver({
        logger: this.logger,
        getSessionId: (seatId: string) => this.state.getSessionId(seatId),
        onSessionId: (seatId: string, sessionId: string) =>
          this.state.setSessionId(seatId, sessionId),
      });
    }
    return null;
  }

  /**
   * 取 vendor 对应的驱动实例（懒加载：首次命中创建并挂事件出口；注入优先于默认工厂）。
   * 未知 vendor 且未注入 → 返回 null。
   */
  private driverFor(vendor: string): SeatDriver | null {
    const existing = this.drivers.get(vendor);
    if (existing) return existing;
    const driver = this.options.drivers?.[vendor] ?? this.defaultDriverFor(vendor);
    if (!driver) return null;
    driver.onEvent((event) => this.handleSeatEvent(event));
    this.drivers.set(vendor, driver);
    return driver;
  }

  /** 启动连接循环 */
  start(): void {
    this.wsClient.start();
  }

  /**
   * 优雅停止：停连接 → 停全部驱动实例（各实例 stopAll：杀子进程，会话已落盘可复活）→
   * 落盘收尾。SIGINT/SIGTERM 时由 cli 调用。
   */
  async stop(): Promise<void> {
    await this.wsClient.stop();
    for (const [vendor, driver] of [...this.drivers]) {
      try {
        await driver.stopAll?.();
      } catch (err) {
        this.logger.error(`stop driver ${vendor} failed: ${String(err)}`);
      }
    }
    this.state.flush();
    this.logger.info('runner stopped');
  }

  // ─────────────────────────── 下行（chamber → 座位） ───────────────────────────

  /** 下行信封分发（ws-client 校验通过后回调） */
  private onDownlink(envelope: Envelope): void {
    switch (envelope.type) {
      case 'seat.assign':
        void this.handleAssign(envelope);
        break;
      case 'seat.inject':
        void this.handleInject(envelope);
        break;
      case 'seat.permission_verdict':
        void this.handleVerdict(envelope);
        break;
      case 'seat.cancel':
        void this.handleCancel(envelope);
        break;
      case 'seat.revoke':
        void this.handleRevoke(envelope);
        break;
      default:
        // ping 已在 ws-client 内部应答；其余类型理论不可达（validatePayload 兜底）
        this.logger.warn(`unhandled downlink type ${envelope.type}`);
        break;
    }
  }

  /**
   * seat.assign 落地：**先校验 cwd 存在**（P1 自审：缺失回 status error 事件不拉起）→
   * 按 vendor 取驱动（未知 vendor 回 status offline，detail 带 vendor 名，不 crash）→
   * 记录配置 → driver.start（幂等；失败回 status offline，不 crash）。
   */
  private async handleAssign(envelope: Envelope): Promise<void> {
    const config = envelope.payload as unknown as SeatConfig;
    if (!fs.existsSync(config.cwd) || !fs.statSync(config.cwd).isDirectory()) {
      this.logger.error(`seat.assign rejected: seat ${config.seatId} cwd not found: ${config.cwd}`);
      this.wsClient.sendSeatEvent(config.seatId, {
        type: 'status',
        seatId: config.seatId,
        status: 'offline',
        detail: `cwd not found: ${config.cwd}`,
      });
      return;
    }
    const driver = this.driverFor(config.vendor);
    if (!driver) {
      this.logger.error(
        `seat.assign rejected: unsupported vendor ${config.vendor} (seat ${config.seatId})`,
      );
      this.wsClient.sendSeatEvent(config.seatId, {
        type: 'status',
        seatId: config.seatId,
        status: 'offline',
        detail: `unsupported vendor: ${config.vendor}`,
      });
      return;
    }
    this.seats.set(config.seatId, config);
    this.logger.info(
      `seat assigned: ${config.label} (${config.seatId}) vendor=${config.vendor} cwd=${config.cwd} mode=${config.permissionMode}${config.model ? ` model=${config.model}` : ''}`,
    );
    try {
      await driver.start(config);
    } catch (err) {
      this.logger.error(
        `seat ${config.seatId} start failed: ${String(err instanceof Error ? err.message : err)}`,
      );
      this.wsClient.sendSeatEvent(config.seatId, {
        type: 'status',
        seatId: config.seatId,
        status: 'offline',
        detail: `start failed: ${String(err instanceof Error ? err.message : err)}`,
      });
    }
  }

  /**
   * seat.inject → prompt 文本装配 → driver.inject。
   * 装配格式（设计 §4/§6）：`ruleHeader + '\n\n' + JSON.stringify(body, null, 2)`——
   * 规则头 chamber 统一装配，runner 禁止改写；JSON 消息体 r3 冻结 schema 原文。
   */
  private async handleInject(envelope: Envelope): Promise<void> {
    const seatId = envelope.seatId!;
    const config = this.seats.get(seatId);
    if (!config) {
      this.logger.warn(`seat.inject for unassigned seat ${seatId} ignored`);
      return;
    }
    const payload = envelope.payload as unknown as InjectPayload;
    // 双保险：信封已过 validatePayload，此处用 parseInjectBody 再收窄（§7 注入面防御）
    const bodyResult = parseInjectBody(payload.body);
    if (!bodyResult.ok) {
      this.logger.warn(`seat.inject payload.body invalid: ${bodyResult.errors.join('; ')}`);
      return;
    }
    const prompt: InjectedPrompt = {
      text: `${payload.ruleHeader}\n\n${JSON.stringify(bodyResult.body, null, 2)}`,
    };
    this.logger.info(
      `inject seat ${seatId} seq ${envelope.seq} messages=${bodyResult.body.batch.messages.length} windowMs=${bodyResult.body.batch.windowMs} topic=${bodyResult.body.topic.title}`,
    );
    const driver = this.drivers.get(config.vendor);
    if (!driver) {
      // 防御：座位已记录但驱动不存在（理论不可达——assign 时已校验 vendor）
      this.logger.warn(`inject seat ${seatId}: no driver for vendor ${config.vendor}`);
      return;
    }
    try {
      await driver.inject(seatId, prompt);
    } catch (err) {
      if (err instanceof BusyError) {
        // 防御分支：chamber 单飞行本应保证不重发，撞上说明两端状态漂移 → 回 busy 状态
        this.logger.warn(`inject seat ${seatId} rejected: busy (single-flight)`);
        this.wsClient.sendSeatEvent(seatId, {
          type: 'status',
          seatId,
          status: 'busy',
          detail: 'single-flight busy',
        });
      } else {
        this.logger.error(
          `inject seat ${seatId} failed: ${String(err instanceof Error ? err.message : err)}`,
        );
        this.wsClient.sendSeatEvent(seatId, {
          type: 'status',
          seatId,
          status: 'offline',
          detail: `inject failed: ${String(err instanceof Error ? err.message : err)}`,
        });
      }
    }
  }

  /**
   * seat.permission_verdict → answerPermission。
   * 下行 payload 是 optionId（§4 下行表）——通过 permission_request 事件缓存的
   * options 反查确认 option 真实存在（optionId/id 双键匹配），然后**把 optionId
   * 原样透传 driver**（RT-PERM-1：ACP 标准 kind 是 allow_*，猜测命名的 kind→verdict
   * 映射曾把 approve 吞成 reject——optionId 才是稳定键，禁止映射；查不到视为审批
   * 已关闭，忽略）。
   * 缓存 key 带 seatId 前缀（R1：requestId 跨座位同命名空间，防并发审批撞键串台）。
   */
  private async handleVerdict(envelope: Envelope): Promise<void> {
    const seatId = envelope.seatId!;
    const config = this.seats.get(seatId);
    const payload = envelope.payload as unknown as PermissionVerdictPayload;
    const cacheKey = `${seatId}:${payload.requestId}`;
    const cached = this.permissions.get(cacheKey);
    if (!cached) {
      this.logger.warn(
        `verdict for unknown requestId ${payload.requestId} ignored (permission already closed)`,
      );
      return;
    }
    const option = cached.options.find(
      (o) => String(o.optionId) === payload.optionId || String(o.id) === payload.optionId,
    );
    if (!option) {
      this.logger.warn(
        `verdict optionId ${payload.optionId} not found in requestId ${payload.requestId} options`,
      );
      return;
    }
    this.permissions.delete(cacheKey);
    const driver = config ? this.drivers.get(config.vendor) : undefined;
    if (!driver) {
      this.logger.warn(
        `verdict seat ${seatId}: no driver for vendor ${String(config?.vendor)} (seat revoked?)`,
      );
      return;
    }
    try {
      await driver.answerPermission(seatId, payload.requestId, payload.optionId);
      this.logger.info(
        `permission answered: seat ${seatId} requestId=${payload.requestId} optionId=${payload.optionId}`,
      );
    } catch (err) {
      this.logger.error(
        `answerPermission failed: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  }

  /** seat.cancel → 优雅取消当前 turn（driver 发 session/cancel 通知等 prompt 收尾） */
  private async handleCancel(envelope: Envelope): Promise<void> {
    const seatId = envelope.seatId!;
    const config = this.seats.get(seatId);
    const driver = config ? this.drivers.get(config.vendor) : undefined;
    this.logger.info(`seat.cancel: seat ${seatId}`);
    if (!driver) {
      this.logger.warn(`cancel seat ${seatId}: no driver (unassigned?)`);
      return;
    }
    // 取消即关闭当轮审批：按 seatId 前缀清权限缓存（driver 侧同步逐个应答 cancelled；
    // 缓存残留会让迟到的 verdict 反查命中已关闭的审批，清空后迟到 verdict 幂等忽略）
    for (const key of [...this.permissions.keys()]) {
      if (key.startsWith(`${seatId}:`)) {
        this.permissions.delete(key);
      }
    }
    try {
      await driver.cancel(seatId);
    } catch (err) {
      this.logger.error(`cancel seat ${seatId} failed: ${String(err)}`);
    }
  }

  /** seat.revoke → 停掉座位运行时 + 清状态（本地配置 + state 持久化） */
  private async handleRevoke(envelope: Envelope): Promise<void> {
    const seatId = envelope.seatId!;
    const config = this.seats.get(seatId);
    const driver = config ? this.drivers.get(config.vendor) : undefined;
    this.logger.info(`seat.revoke: seat ${seatId} — stop driver and clear state`);
    if (driver) {
      try {
        await driver.stop(seatId);
      } catch (err) {
        this.logger.error(`stop seat ${seatId} failed: ${String(err)}`);
      }
    }
    this.seats.delete(seatId);
    // R1：审批缓存 key 为 `${seatId}:${requestId}`，revoke 按 seatId 前缀清理
    for (const key of [...this.permissions.keys()]) {
      if (key.startsWith(`${seatId}:`)) {
        this.permissions.delete(key);
      }
    }
    this.state.removeSeat(seatId);
  }

  // ─────────────────────────── 上行（座位 → chamber） ───────────────────────────

  /** driver 事件出口 → 上行 seat.event（ws-client 先落盘再发送）；审批事件缓存 options（R1：key 带 seatId 前缀） */
  private handleSeatEvent(event: SeatEvent): void {
    if (event.type === 'permission_request') {
      this.permissions.set(`${event.seatId}:${event.requestId}`, {
        seatId: event.seatId,
        options: event.options,
      });
    }
    switch (event.type) {
      case 'message_chunk':
        this.logger.debug(`message_chunk seat ${event.seatId}: +${event.text.length} chars`);
        break;
      case 'message_complete':
        this.logger.info(
          `message_complete seat ${event.seatId} stopReason=${event.stopReason}${event.silent ? ' (silent)' : ''}`,
        );
        break;
      case 'status':
        this.logger.info(
          `status seat ${event.seatId}: ${event.status}${event.detail ? ` (${event.detail})` : ''}`,
        );
        break;
      case 'permission_request':
        this.logger.info(
          `permission_request seat ${event.seatId} requestId ${event.requestId} options=${event.options.map((o) => String(o.kind)).join(',')}`,
        );
        break;
      case 'usage':
        this.logger.debug(`usage seat ${event.seatId}: ${event.used}/${event.size}`);
        break;
      case 'seat_info':
        // M3 阶段 5 观测上行（model/thinking/mode 地面真相）——透传 chamber 落 state
        this.logger.debug(
          `seat_info seat ${event.seatId}: model=${String(event.model ?? '-')} thinking=${String(event.thinking ?? '-')} mode=${String(event.mode ?? '-')}`,
        );
        break;
      case 'tool_event':
        this.logger.debug(
          `tool_event seat ${event.seatId}: ${JSON.stringify(event.tool).slice(0, 200)}`,
        );
        break;
    }
    this.wsClient.sendSeatEvent(event.seatId, event);
  }
}
