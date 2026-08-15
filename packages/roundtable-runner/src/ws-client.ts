/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §4 (契约②: 控制面协议——拨号/心跳/双向对账/幂等去重/重连重放)
 *   - 补充: docs/roundtable-design.md §7 (安全边界: X-API-Key 握手认证, 注入面逐类型校验)
 *
 * [踩坑索引] ②(seq 复用→幂等去重静默丢弃→busy 楔死) RT-DEBT-2(未确认队列按 hello_ack/ping 游标裁剪, 不无条件清空)
 *
 * [铁律关联] #11(注释) #17(测试契约) #20(契约即设计) #21(双层校验)
 *
 * [详细踩坑]（最多 5 条）
 *   ②: 下行注入按 seatId+seq 幂等去重 → chamber 重启丢 last_inject_seq 后新注入复用 seq 1
 *      → 被静默丢弃 → 单飞行 busy 永等 complete 楔死。修复：hello 双向对账上报双向游标，
 *      reconcile 遇 runner 超前时采纳 runner 游标并抬高 chamber 分配游标。
 *      见 memory/2026-08-07.md §6
 *   RT-DEBT-2: 未确认队列重放后无条件清空会丢「尚未被 chamber 确认」的事件（chamber
 *      落库失败留档待重放的 seq 被抹掉，重放重试机制失效）；长连接期间队列只增不减。
 *      修复：chamber 新增 hello_ack 下行 + ping 可选 seats 游标（阶段 5，仅增），
 *      ws-client 按游标裁剪已确认区间（ackPendingEvents，留档 seq 不裁）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * Runner 控制面 WebSocket 客户端（拨出连 chamber /ws/runner）
 *
 * 职责（设计 §4 契约② + M1 计划 §三）：
 * - 拨出 `ws(s)://<platform>/ws/runner`（Header 携带 X-API-Key 认证，§7 安全边界）
 * - 指数退避重连（1s 起 → 30s 上限 + jitter），连接成功重置退避；
 *   认证失败 close 4401 / 被顶替 close 4012 → 停止重连（重试无意义 / 防互踢循环）
 * - 30s 心跳响应：收 chamber ping 回 pong（§4 下行表）
 * - 上行 seat.event：**先落盘再发送**（lastSentSeq 递增 + 未确认队列），断线事件留队列，
 *   重连后 hello 对账 + 队列重放（chamber 按 seatId+seq 幂等去重，§4 可靠性）
 * - 下行按 seatId+seq 幂等去重：seat.inject 严格去重并推进 lastReceivedSeq 游标
 *   （先落盘再处理注入）；seat.assign seq=0 不参与对账（chamber registry 注释），每次执行；
 *   permission_verdict/cancel/revoke 为操作语义，幂等执行不做 seq 去重
 * - 连接建立后发 hello（version/vendors/各座位 lastSentSeq+lastReceivedSeq 对账信息）
 *
 * 信封即线缆 JSON（无 {event,data} 包装，chamber runner.gateway spike 结论①）；
 * 下行先 validateEnvelope + validatePayload 再分发（§7 注入面），非法帧只记日志不 crash。
 */
import WebSocket from 'ws';
import {
  buildEnvelope,
  validateEnvelope,
  validatePayload,
  SEAT_VENDORS,
  type Envelope,
  type HelloAckPayload,
  type HelloPayload,
  type PingPayload,
  type SeatEvent,
  type SeatReconciliation,
  type SeatVendor,
} from '@agent-chamber/roundtable-protocol';
import type { StateStore } from './state-store';
import { ConsoleLogger } from './logger';
import type { Logger } from './logger';

/** 重连退避初始基数（首次重连延迟 ≈ 1s：500 × 2 = 1000） */
const BACKOFF_INITIAL_MS = 500;
/** 重连退避上限（指数退避 1s → 30s 上限，设计 §4） */
const BACKOFF_MAX_MS = 30_000;
/** jitter 比例 ±20%（防多 runner 同时断线重连共振） */
const JITTER_RATIO = 0.2;

/** 握手认证失败关闭码（chamber runner.gateway，4401）：key 错误/失效，重试无意义 → 停止重连 */
const CLOSE_AUTH_FAILED = 4401;
/** 被同 API Key 新连接顶替（chamber registry 一 key 一 runner，4012）：停止重连防互踢循环 */
const CLOSE_REPLACED = 4012;

/** RunnerWsClient 构造选项 */
export interface RunnerWsClientOptions {
  /** 平台地址（http(s)://host:port，自动换算 ws(s)://host:port/ws/runner） */
  platformUrl: string;
  /** 平台 API Key（握手 X-API-Key header） */
  apiKey: string;
  /** runner 名称（hello 可选 name 字段，chamber 宽松读取） */
  runnerName: string;
  /** runner 版本（hello.version） */
  version: string;
  /** 状态存储（hello 对账游标 + 未确认队列 + lastReceivedSeq 去重） */
  state: StateStore;
  /** 支持的厂商列表（默认协议包 SEAT_VENDORS = ['kimi','codex','opencode','claude-code']；chamber 按 vendor ∈ hello.vendors 绑定座位） */
  vendors?: SeatVendor[];
  /** 下行信封分发（校验通过后；runner-core 处理座位业务） */
  onDownlink: (envelope: Envelope) => void;
  /** 连接状态变化回调（调试/日志用） */
  onConnectionChange?: (connected: boolean, detail?: string) => void;
  /** 致命错误回调（认证失败/被顶替后触发；cli 里退出进程） */
  onFatal?: (reason: string) => void;
  /** 日志器（默认 ConsoleLogger info） */
  logger?: Logger;
}

/**
 * 指数退避计算（纯函数，测试友好）：基数翻倍（上限 30s）+ ±20% jitter。
 * @param current 当前退避基数（ms；初始 BACKOFF_INITIAL_MS=500）
 * @returns { delay: 本次实际延迟, next: 下次基数 }
 */
export function nextBackoff(current: number): { delay: number; next: number } {
  const base = Math.min(current * 2, BACKOFF_MAX_MS);
  const jitter = 1 + (Math.random() * 2 - 1) * JITTER_RATIO;
  const delay = Math.min(Math.round(base * jitter), BACKOFF_MAX_MS);
  return { delay, next: base };
}

/** 控制面 WebSocket 客户端 */
export class RunnerWsClient {
  private readonly logger: Logger;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private started = false;
  private stopped = false;
  private connected = false;

  constructor(private readonly options: RunnerWsClientOptions) {
    this.logger = options.logger ?? new ConsoleLogger({ level: 'info' });
  }

  /** 当前是否已连接 */
  get isConnected(): boolean {
    return this.connected;
  }

  /** 开始连接循环（幂等：已启动则忽略） */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  /** 停止（关闭连接 + 取消重连定时器；状态已同步落盘无需额外 flush） */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'runner stopping');
      } catch {
        // 连接已关闭则忽略
      }
      this.ws = null;
    }
    this.connected = false;
    this.options.onConnectionChange?.(false, 'stopped');
  }

  // ─────────────────────────── 连接生命周期 ───────────────────────────

  /** 平台 URL → ws URL（http→ws / https→wss，路径固定 /ws/runner） */
  private buildWsUrl(): string {
    const base = this.options.platformUrl.replace(/\/+$/, '');
    return `${base.replace(/^http/i, 'ws')}/ws/runner`;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.buildWsUrl();
    this.logger.debug(`connecting ${url}`);
    const ws = new WebSocket(url, { headers: { 'X-API-Key': this.options.apiKey } });
    this.ws = ws;
    ws.on('open', () => this.onOpen(ws));
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', (code, reason) => this.onClose(ws, code, reason.toString()));
    ws.on('error', (err) => this.logger.debug(`ws error: ${String(err)}`));
  }

  /** 连接建立：重置退避 → hello 对账 → 未确认队列重放 */
  private onOpen(ws: WebSocket): void {
    if (this.ws !== ws) return; // 已被 stop/替换
    this.connected = true;
    this.backoffMs = BACKOFF_INITIAL_MS;
    this.options.onConnectionChange?.(true);
    this.logger.info(`connected to chamber (${this.buildWsUrl()})`);
    this.sendHello();
    this.replayPending();
  }

  /** 连接关闭：4401/4012 停止重连；其余指数退避重连 */
  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.connected = false;
    this.options.onConnectionChange?.(false, `${code} ${reason}`);
    if (this.stopped) return;
    if (code === CLOSE_AUTH_FAILED) {
      // 认证失败：API Key 错误/失效，重试无意义 → 停止并报 fatal（cli 退出）
      this.logger.error(`connection closed by chamber: auth failed (4401) — ${reason}`);
      this.stopped = true;
      this.options.onFatal?.(`auth failed (4401): ${reason}`);
      return;
    }
    if (code === CLOSE_REPLACED) {
      // 被同 key 新 runner 顶替：停止重连（否则与新 runner 互踢循环，§7 一 key 一 runner）
      this.logger.warn(
        `connection replaced by a newer runner (4012) — stopping to avoid kick loop`,
      );
      this.stopped = true;
      this.options.onFatal?.(`replaced by a newer runner (4012): ${reason}`);
      return;
    }
    this.scheduleReconnect();
  }

  /** 指数退避重连调度（1s 起，30s 上限，jitter；连接成功在 onOpen 重置） */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const { delay, next } = nextBackoff(this.backoffMs);
    this.backoffMs = next;
    this.logger.warn(`reconnecting in ${delay}ms (backoff ${this.backoffMs}ms)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ─────────────────────────── 上行 ───────────────────────────

  /** hello：version + vendors + 各座位对账信息（连接建立/重连必发，§4 上行表） */
  private sendHello(): void {
    const seats: Record<string, SeatReconciliation> = {};
    for (const seatId of this.options.state.getSeatIds()) {
      seats[seatId] = {
        lastSentSeq: this.options.state.getLastSentSeq(seatId),
        lastReceivedSeq: this.options.state.getLastReceivedSeq(seatId),
      };
    }
    const payload = {
      version: this.options.version,
      // M4a 起：厂商数组上报（kimi/codex/opencode/claude-code；chamber 按 vendor ∈ hello.vendors 绑定座位）
      vendors: this.options.vendors ?? [...SEAT_VENDORS],
      seats,
      // 可选 name（hello payload 契约 v1 未冻结该键，chamber updateHelloInfo 宽松读取）
      name: this.options.runnerName,
    } as HelloPayload & { name: string };
    this.send(buildEnvelope('hello', payload as unknown as Record<string, unknown>, {}));
    this.logger.info(
      `hello sent: version=${payload.version} vendors=${payload.vendors.join(',')} seats=${Object.keys(seats).length}`,
    );
  }

  /**
   * 未确认队列重放（连接建立后）：队列内事件原 seq 重发。
   * RT-DEBT-2（阶段 5）：**不再无条件清空**——已确认送达区间由 chamber 的 hello_ack
   * （hello 对账完成的回执，携带上行游标）裁剪；无条件清空会丢「尚未被 chamber 确认」
   * 的事件（如 chamber 落库失败留档待重放的 seq，见 roundtable.service RT-DEBT-1）。
   * chamber 按 seatId+seq 幂等去重（§4 可靠性：上行缺口 = runner 本地持久化未确认
   * seat.event 队列，重连重放）。
   */
  private replayPending(): void {
    for (const seatId of this.options.state.getSeatIds()) {
      const pending = this.options.state.getPendingEvents(seatId);
      if (pending.length === 0) continue;
      for (const { seq, event } of pending) {
        this.send(
          buildEnvelope('seat.event', event as unknown as Record<string, unknown>, { seatId, seq }),
        );
      }
      this.logger.info(
        `seat ${seatId} replayed ${pending.length} pending event(s), awaiting hello_ack trim`,
      );
    }
  }

  /** 按 chamber 游标裁剪未确认队列（hello_ack / ping 共用入口，RT-DEBT-2） */
  private trimAcked(ack: HelloAckPayload): void {
    for (const [seatId, info] of Object.entries(ack.seats)) {
      this.options.state.ackPendingEvents(seatId, info.lastEventSeq, info.failedEventSeqs);
    }
  }

  /**
   * 上行 seat.event：**先落盘再发送**（§4 可靠性）——persistSentEvent 分配 seq 并写入
   * 未确认队列，随后发送；断线时发送失败，事件留在队列由重连重放。
   * @param seatId 座位 id
   * @param event SeatEvent 事件本体（driver 上行透传）
   */
  sendSeatEvent(seatId: string, event: SeatEvent): void {
    const seq = this.options.state.persistSentEvent(seatId, event);
    this.send(
      buildEnvelope('seat.event', event as unknown as Record<string, unknown>, { seatId, seq }),
    );
  }

  /** 发送信封（未连接时丢弃——seat.event 已落盘由重放兜底；hello/pong 仅在连接态发送） */
  private send(envelope: Envelope): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope));
    } else {
      this.logger.warn(
        `send ${envelope.type} while not connected, dropped (persisted state covers seat.event)`,
      );
    }
  }

  // ─────────────────────────── 下行 ───────────────────────────

  /** 下行帧：JSON 解析 + 信封校验 + payload 逐类型校验（§7 注入面）→ 分发；非法帧只记日志 */
  private onMessage(ws: WebSocket, data: WebSocket.RawData): void {
    if (this.ws !== ws) return;
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      this.logger.warn('downlink: non-JSON message ignored');
      return;
    }
    const envResult = validateEnvelope(raw);
    if (!envResult.ok) {
      this.logger.warn(`downlink: invalid envelope: ${envResult.errors.join('; ')}`);
      return;
    }
    const envelope = raw as Envelope;
    const payloadResult = validatePayload(envelope.type, envelope.payload);
    if (!payloadResult.ok) {
      this.logger.warn(`downlink: invalid payload: ${payloadResult.errors.join('; ')}`);
      return;
    }
    this.dispatchDownlink(envelope);
  }

  /** 下行类型分发（信封已校验通过） */
  private dispatchDownlink(envelope: Envelope): void {
    switch (envelope.type) {
      case 'ping': {
        // 30s 心跳响应（§4 下行表：chamber ping → runner pong）；RT-DEBT-2：ping
        // 可选携带 chamber 上行游标 seats（阶段 5 仅增字段）→ 顺带定期裁剪已确认
        // 送达的未确认队列（长连接期间无界增长的修复载体）
        const pingPayload = envelope.payload as unknown as PingPayload;
        if (pingPayload.seats) {
          this.trimAcked(pingPayload as unknown as HelloAckPayload);
        }
        this.send(buildEnvelope('pong', {}, {}));
        this.logger.debug('pong sent');
        break;
      }
      case 'hello_ack': {
        // chamber 对 hello 的回执（阶段 5 新增下行类型）：各座位上行游标
        // （lastEventSeq + failedEventSeqs）→ 裁剪已确认送达区间（重连重放后清空
        // 已确认部分；留档 seq 不裁，待重放重试）
        const ack = envelope.payload as unknown as HelloAckPayload;
        this.trimAcked(ack);
        this.logger.info(
          `hello_ack received: ${Object.keys(ack.seats).length} seat cursor(s), pending queue trimmed`,
        );
        break;
      }
      case 'seat.assign': {
        // seq=0 每次绑定独立下行，对账游标不适用（chamber registry buildAssignEnvelope
        // 注释）→ 每次执行（runner-core start 幂等）
        this.options.onDownlink(envelope);
        break;
      }
      case 'seat.inject': {
        const seatId = envelope.seatId!; // validateEnvelope 保证座位归属消息必带 seatId
        // 幂等去重（§4）：≤ 已收最大 seq 丢弃；先落盘游标再处理（崩溃后不重复注入）
        const lastReceived = this.options.state.getLastReceivedSeq(seatId);
        if (envelope.seq <= lastReceived) {
          this.logger.debug(
            `seat.inject dedup: seat ${seatId} seq ${envelope.seq} ≤ ${lastReceived}`,
          );
          return;
        }
        this.options.state.setLastReceivedSeq(seatId, envelope.seq);
        this.options.onDownlink(envelope);
        break;
      }
      case 'seat.permission_verdict':
      case 'seat.cancel':
      case 'seat.revoke': {
        // 操作语义（应答/打断/解绑）：chamber 重放重复指令无副作用 → 幂等执行，不做 seq 去重
        this.options.onDownlink(envelope);
        break;
      }
      case 'error': {
        // chamber 显式错误回执（如 INVALID_DIRECTION）：只记日志
        this.logger.warn(`chamber error: ${JSON.stringify(envelope.payload)}`);
        break;
      }
      default: {
        // hello/seat.event/pong 是上行类型，chamber 不应下发（防御分支）
        this.logger.warn(`downlink: unexpected type ${envelope.type} ignored`);
      }
    }
  }
}
