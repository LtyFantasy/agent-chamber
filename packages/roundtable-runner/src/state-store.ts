/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §4 (契约② 可靠性: 双向对账游标/未确认队列/sessionId 落盘,
 *           无逐条 ack)
 *
 * [踩坑索引] ④(sessionId 映射丢失→永远 new session) RT-DEBT-2(无界增长: 未确认队列靠对账游标裁剪, 不无条件清空)
 *
 * [铁律关联] #11(注释) #17(测试契约) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   ④: seatId↔sessionId 映射是 resume 复活唯一来源——丢失或读不出 → 永远 new session
 *      （与 runner-core 漏接 getSessionId 同源）。修复：session/new|resume 后同步原子落盘，
 *      start 时经 getSessionId 回调读出。见 memory/2026-08-07.md §6
 *   RT-DEBT-2: 未确认队列重放后「无条件清空」会丢尚未被 chamber 确认的事件（落库失败
 *      留档待重放的 seq 被抹掉）；长连接期间队列只增不减（无逐条 ack）。修复：chamber
 *      hello_ack / ping 携带上行游标（lastEventSeq + failedEventSeqs），按已确认区间
 *      裁剪（ackPendingEvents）——留档 seq 不裁，待重放。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * JSON 文件状态持久化（默认 ~/.roundtable-runner/state.json，--state-dir 可改目录）
 *
 * 持久化内容（设计 §4 可靠性 / 阶段 4 交付物）：
 * - seatId ↔ ACP sessionId（session/new 或 session/resume 后落盘 → start 时 resume 复活）
 * - per-seat lastSentSeq / lastReceivedSeq（双向对账游标，重连 hello 上报）
 * - 未确认 seat.event 队列（先落盘再发送；重连重放后清空；chamber 按 seatId+seq 幂等去重）
 *
 * 可靠性：
 * - 原子写：先写 state.json.tmp 再 rename（崩溃不留下半截文件）
 * - 损坏恢复：JSON 解析失败 → 坏文件备份为 state.json.corrupt-<ts> → 从空状态恢复（不 crash）
 * - 同步写（writeFileSync + renameSync）：每次状态变更即时落盘，kill -9 也不丢已记录游标
 *
 * 出处：docs/roundtable-design.md §4（可靠性：双向对账，无逐条 ack）/ M1 计划 §三。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SeatEvent } from '@agent-chamber/roundtable-protocol';
import { ConsoleLogger } from './logger';
import type { Logger } from './logger';

/** 状态文件格式版本（结构变更时递增并做兼容迁移；当前 v1） */
const STATE_VERSION = 1;

/** 未确认队列每座位容量上限（无逐条 ack 协议，队列靠重连重放循环清空；超限丢最旧防无限增长） */
const PENDING_EVENT_CAP = 500;

/** 未确认 seat.event 队列条目（重连重放，§4 可靠性） */
export interface PendingEventRecord {
  /** 已分配的座位级上行 seq（chamber 按 seatId+seq 幂等去重，重放保持原 seq） */
  seq: number;
  /** SeatEvent 事件本体 */
  event: SeatEvent;
}

/** 座位级持久化状态 */
export interface SeatPersistedState {
  /** ACP 会话 id（session/new 或 session/resume 后落盘；start 时 resume 复活，§3） */
  sessionId?: string;
  /** 我方已发送的最大上行 seq（对账游标，hello 上报） */
  lastSentSeq: number;
  /** 我方已接收的最大下行 seq（对账游标，hello 上报；仅 seat.inject 推进） */
  lastReceivedSeq: number;
  /** 未确认 seat.event 队列（先落盘再发送；重连重放后清空） */
  pendingEvents: PendingEventRecord[];
}

/** 持久化状态整体（state.json 文件结构） */
export interface PersistedState {
  /** 格式版本（固定 1） */
  version: typeof STATE_VERSION;
  /** seatId → 座位状态 */
  seats: Record<string, SeatPersistedState>;
}

/** StateStore 构造选项 */
export interface StateStoreOptions {
  /** 状态目录（默认调用方给 ~/.roundtable-runner；测试可给临时目录） */
  dir: string;
  /** 日志器（默认 ConsoleLogger info） */
  logger?: Logger;
}

/** JSON 状态存储（同步 API：每次变更立即原子落盘） */
export class StateStore {
  private readonly dir: string;
  private readonly statePath: string;
  private readonly logger: Logger;
  private state: PersistedState = { version: STATE_VERSION, seats: {} };

  constructor(options: StateStoreOptions) {
    this.dir = options.dir;
    this.statePath = path.join(options.dir, 'state.json');
    this.logger = options.logger ?? new ConsoleLogger({ level: 'info' });
  }

  /** 状态文件完整路径（测试/调试用） */
  getStatePath(): string {
    return this.statePath;
  }

  /**
   * 加载状态（启动时调用；损坏/结构非法 → 备份坏文件并从空状态恢复，不 crash）
   */
  load(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw: string;
    try {
      raw = fs.readFileSync(this.statePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // 首次运行：无状态文件 → 空状态
      }
      this.recoverCorrupt(`read failed: ${String(err)}`);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        parsed.version !== STATE_VERSION ||
        parsed.seats === null ||
        typeof parsed.seats !== 'object'
      ) {
        throw new Error(`unexpected state shape (version=${String(parsed?.version)})`);
      }
      // 逐座位规范化：旧数据/手改文件缺字段时补默认，防下游拿到 undefined
      const seats: Record<string, SeatPersistedState> = {};
      for (const [seatId, rec] of Object.entries(parsed.seats as Record<string, Partial<SeatPersistedState>>)) {
        seats[seatId] = {
          sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : undefined,
          lastSentSeq: Number.isInteger(rec.lastSentSeq) && rec.lastSentSeq! >= 0 ? rec.lastSentSeq! : 0,
          lastReceivedSeq:
            Number.isInteger(rec.lastReceivedSeq) && rec.lastReceivedSeq! >= 0 ? rec.lastReceivedSeq! : 0,
          pendingEvents: Array.isArray(rec.pendingEvents) ? (rec.pendingEvents as PendingEventRecord[]) : [],
        };
      }
      this.state = { version: STATE_VERSION, seats };
    } catch (err) {
      this.recoverCorrupt(`parse failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  /**
   * 损坏恢复：坏文件改名备份（state.json.corrupt-<ts>，人工可查）→ 空状态。
   * 绝不 crash——runner 是常驻进程，状态丢了可以重来（chamber 对账兜底），进程死了才是事故。
   */
  private recoverCorrupt(reason: string): void {
    const backupPath = `${this.statePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(this.statePath, backupPath);
      this.logger.warn(
        `state file corrupted (${reason}); backed up to ${backupPath}, starting from empty state`,
      );
    } catch (err) {
      this.logger.error(`corrupt state backup failed: ${String(err)}; starting from empty state`);
    }
    this.state = { version: STATE_VERSION, seats: {} };
  }

  /** 原子写：先写 .tmp 再 rename（目标文件要么是旧完整版要么是新完整版） */
  private write(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmpPath = `${this.statePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmpPath, this.statePath);
  }

  /** 显式落盘（stop/flush 时调用；正常路径每次变更已同步写盘，此处为收尾保险） */
  flush(): void {
    this.write();
  }

  /** 全部已知 seatId（hello 对账上报范围） */
  getSeatIds(): string[] {
    return Object.keys(this.state.seats);
  }

  /** 读取座位状态；create=true 时不存在则创建默认条目（首个游标/会话落盘时） */
  private seat(seatId: string, create: boolean): SeatPersistedState | undefined {
    let rec = this.state.seats[seatId];
    if (!rec && create) {
      rec = { lastSentSeq: 0, lastReceivedSeq: 0, pendingEvents: [] };
      this.state.seats[seatId] = rec;
    }
    return rec;
  }

  /** ACP 会话 id（无则 undefined → start 时 session/new） */
  getSessionId(seatId: string): string | undefined {
    return this.seat(seatId, false)?.sessionId;
  }

  /** 落盘 ACP 会话 id（session/new 或 resume 成功后调用，一次原子写） */
  setSessionId(seatId: string, sessionId: string): void {
    const rec = this.seat(seatId, true)!;
    rec.sessionId = sessionId;
    this.write();
  }

  /** 已发送最大上行 seq（hello 上报） */
  getLastSentSeq(seatId: string): number {
    return this.seat(seatId, false)?.lastSentSeq ?? 0;
  }

  /** 已接收最大下行 seq（hello 上报；仅 seat.inject 推进） */
  getLastReceivedSeq(seatId: string): number {
    return this.seat(seatId, false)?.lastReceivedSeq ?? 0;
  }

  /** 更新已接收下行游标（seat.inject 幂等去重时调用，先落盘再处理注入） */
  setLastReceivedSeq(seatId: string, seq: number): void {
    const rec = this.seat(seatId, true)!;
    rec.lastReceivedSeq = seq;
    this.write();
  }

  /** 未确认事件队列（重连重放用） */
  getPendingEvents(seatId: string): PendingEventRecord[] {
    return this.seat(seatId, false)?.pendingEvents ?? [];
  }

  /**
   * 上行事件落盘（「先落盘再发送」的落盘步，§4 可靠性）：
   * 分配 seq（lastSentSeq+1）→ 入未确认队列 → 一次原子写。
   * @param seatId 座位 id
   * @param event SeatEvent 事件本体
   * @returns 分配到的 seq（调用方以它构造 seat.event 信封发送；断线时留在队列由重连重放）
   */
  persistSentEvent(seatId: string, event: SeatEvent): number {
    const rec = this.seat(seatId, true)!;
    const seq = rec.lastSentSeq + 1;
    rec.lastSentSeq = seq;
    rec.pendingEvents.push({ seq, event });
    if (rec.pendingEvents.length > PENDING_EVENT_CAP) {
      const dropped = rec.pendingEvents.splice(0, rec.pendingEvents.length - PENDING_EVENT_CAP);
      this.logger.warn(
        `seat ${seatId} pending queue capped at ${PENDING_EVENT_CAP}, dropped ${dropped.length} oldest (no-ack protocol)`,
      );
    }
    this.write();
    return seq;
  }

  /** 重放完成后清空未确认队列（连接建立 → hello → 重放 → 清空；chamber 幂等去重兜底） */
  clearPendingEvents(seatId: string): void {
    const rec = this.seat(seatId, false);
    if (!rec || rec.pendingEvents.length === 0) return;
    rec.pendingEvents = [];
    this.write();
  }

  /**
   * 按 chamber 上行游标裁剪已确认送达的未确认队列（RT-DEBT-2 无界增长修复，阶段 5）：
   * chamber 已处理（≤ lastEventSeq 且不在 failedEventSeqs）的条目可安全移除；
   * failedEventSeqs 里的 seq = chamber 落库失败留档待重放（游标蛙跳修复，重放不可被
   * 去重），**不得裁剪**——保留到下次重连重放重试。
   * 触发：hello_ack（重连对账完成，清已确认区间——取代旧的「重放后无条件清空」，
   * 后者会丢尚未被 chamber 确认的事件）/ ping 携带游标（长连接期间定期裁剪）。
   * lastSentSeq 快进（2026-08-11 dogfood 事故修复）：chamber 游标领先本地计数器
   * （多进程共享 state.json 互相覆盖回滚 / 状态文件恢复旧副本）时，后续新事件
   * seq ≤ 游标会被 chamber 幂等去重静默丢弃——座位永久假死（ws-client 踩坑②同族）。
   * 每次对账把计数器快进到游标：跳过的是 chamber 已确认消费的序号区间，不会重号。
   * @param seatId 座位 id
   * @param lastEventSeq chamber 已处理的最大上行 seq
   * @param failedEventSeqs chamber 留档的失败 seq（保留项）
   */
  ackPendingEvents(seatId: string, lastEventSeq: number, failedEventSeqs: number[]): void {
    const rec = this.seat(seatId, false);
    if (!rec) return;
    if (rec.lastSentSeq < lastEventSeq) {
      this.logger.warn(
        `seat ${seatId} lastSentSeq ${rec.lastSentSeq} 落后 chamber 游标 ${lastEventSeq}，快进对齐（防新事件被幂等去重静默丢弃）`,
      );
      rec.lastSentSeq = lastEventSeq;
      this.write();
    }
    if (rec.pendingEvents.length === 0) return;
    const failedSet = new Set(failedEventSeqs);
    const kept = rec.pendingEvents.filter(
      (entry) => entry.seq > lastEventSeq || failedSet.has(entry.seq),
    );
    if (kept.length === rec.pendingEvents.length) return;
    const trimmed = rec.pendingEvents.length - kept.length;
    rec.pendingEvents = kept;
    this.write();
    this.logger.info(
      `seat ${seatId} ack 裁剪 ${trimmed} 条已确认送达事件（游标 ${lastEventSeq}），未确认/留档 ${kept.length} 条保留`,
    );
  }

  /** 座位解绑（seat.revoke）：删除该座位全部持久化状态（会话映射/游标/队列） */
  removeSeat(seatId: string): void {
    if (!this.state.seats[seatId]) return;
    delete this.state.seats[seatId];
    this.write();
  }
}
