/**
 * 契约② 控制面信封（chamber ⇆ runner，WebSocket 传输）
 *
 * 全部消息统一外壳，字段一旦上线冻结，只增不改。
 * 传输：runner 主动拨出 `wss://<platform>/ws/runner`（Header 携带 X-API-Key），断线指数退避重连。
 *
 * 出处：docs/roundtable-design.md §4（契约②：控制面协议）。
 */

/** 上行消息类型（runner → chamber） */
export const UPLINK_MESSAGE_TYPES = ['hello', 'seat.event', 'pong'] as const;

/** 上行消息类型（runner → chamber）：hello / seat.event / pong */
export type UplinkMessageType = (typeof UPLINK_MESSAGE_TYPES)[number];

/** 下行消息类型（chamber → runner） */
export const DOWNLINK_MESSAGE_TYPES = [
  'seat.assign',
  'seat.inject',
  'seat.permission_verdict',
  'seat.cancel',
  'seat.revoke',
  'ping',
  // 阶段 5（M2，M1 三新债 #2）新增：chamber 对 hello 的回执——携带各座位上行游标
  // （lastEventSeq + failedEventSeqs），runner 据此裁剪已确认送达的未确认队列。
  // 信封冻结只增不改：仅新增类型，既有类型/字段不动。
  'hello_ack',
] as const;

/** 下行消息类型（chamber → runner）：seat.assign / seat.inject / seat.permission_verdict / seat.cancel / seat.revoke / ping / hello_ack */
export type DownlinkMessageType = (typeof DOWNLINK_MESSAGE_TYPES)[number];

/**
 * 无座位归属消息类型：不带 seatId，seq 固定 0
 * （docs/roundtable-design.md §4：无座位归属的消息（hello/ping/pong/error）不带 seatId，seq=0；
 * hello_ack 与 hello 对称——payload 内按 seatId 携带全部座位游标，信封本身无座位归属）
 */
export const SEATLESS_MESSAGE_TYPES = ['hello', 'ping', 'pong', 'error', 'hello_ack'] as const;

/** 无座位归属消息类型（hello / ping / pong / error / hello_ack） */
export type SeatlessMessageType = (typeof SEATLESS_MESSAGE_TYPES)[number];

/** 全部控制面消息类型（上行 ∪ 下行 ∪ error） */
export const MESSAGE_TYPES = [
  ...UPLINK_MESSAGE_TYPES,
  ...DOWNLINK_MESSAGE_TYPES,
  'error',
] as const;

/** 控制面消息类型全集 */
export type RoundtableMessageType = (typeof MESSAGE_TYPES)[number];

/**
 * 信封（全部消息统一外壳；字段一旦上线冻结，只增不改）
 * `{ v, type, seatId?, seq, ts, payload }`（docs/roundtable-design.md §4）
 */
export interface Envelope {
  /** 协议版本（当前固定 1；版本字段预留演进，见 §4/§11 风险对策「信封字段上线后难改」） */
  v: 1;
  /** 消息类型（MESSAGE_TYPES 之一） */
  type: RoundtableMessageType;
  /** 座位归属（可选；无座位归属消息必须省略） */
  seatId?: string;
  /** 座位级序号（双向各自编号；无座位归属消息固定 0；接收方按 seatId+seq 幂等去重） */
  seq: number;
  /** 发送时间戳（毫秒） */
  ts: number;
  /** 消息体（逐类型结构见 messages.ts；seat.inject 的 body 见 inject-body.ts） */
  payload: Record<string, unknown>;
}

/** 校验结果（手写校验统一返回形状，不用 zod） */
export interface ValidationResult {
  /** 是否通过全部校验 */
  ok: boolean;
  /** 未通过时的人类可读错误列表（累积全部问题，便于调试） */
  errors: string[];
}

/** buildEnvelope 可选参数 */
export interface BuildEnvelopeOptions {
  /** 座位 ID（座位归属消息必填；无座位归属消息传入会抛错） */
  seatId?: string;
  /** 座位级序号（座位归属消息必填且为非负整数；无座位归属消息固定 0） */
  seq?: number;
  /** 发送时间戳（毫秒，默认 Date.now()） */
  ts?: number;
}

/**
 * 构造信封
 * 产出保证合法：无座位归属消息强制 seq=0 且不带 seatId；座位归属消息强制携带非负整数 seq 与 seatId。
 * @param type 消息类型
 * @param payload 消息体（调用方需保证与 type 匹配；payload 结构校验见 messages.ts validatePayload）
 * @param options 可选参数（见 BuildEnvelopeOptions）
 * @returns 合法信封
 * @throws TypeError 参数与消息类型的座位归属语义冲突（如 hello 带 seatId、座位消息缺 seatId/seq）
 */
export function buildEnvelope(
  type: RoundtableMessageType,
  payload: Record<string, unknown>,
  options: BuildEnvelopeOptions = {},
): Envelope {
  const seatless = (SEATLESS_MESSAGE_TYPES as readonly string[]).includes(type);
  if (seatless) {
    // 无座位归属：显式传 seatId 或非零 seq 视为调用方误解消息语义，立即失败（fail fast）
    if (options.seatId !== undefined || (options.seq !== undefined && options.seq !== 0)) {
      throw new TypeError(
        `buildEnvelope: 无座位归属消息类型 "${type}" 不允许携带 seatId 或非零 seq`,
      );
    }
    return { v: 1, type, seq: 0, ts: options.ts ?? Date.now(), payload };
  }
  if (options.seatId === undefined) {
    throw new TypeError(`buildEnvelope: 座位归属消息类型 "${type}" 必须携带 seatId`);
  }
  if (options.seq === undefined || !Number.isInteger(options.seq) || options.seq < 0) {
    throw new TypeError(`buildEnvelope: 座位归属消息类型 "${type}" 必须携带非负整数 seq`);
  }
  return {
    v: 1,
    type,
    seatId: options.seatId,
    seq: options.seq,
    ts: options.ts ?? Date.now(),
    payload,
  };
}

/**
 * 校验信封外壳（v/type/seatId/seq/ts/payload 的格式与座位归属语义）。
 * payload 的逐类型结构校验见 messages.ts validatePayload；两者组合即完整校验（§7 注入面）。
 * @param input 待校验对象
 * @returns { ok, errors } —— ok=false 时 errors 累积全部问题
 */
export function validateEnvelope(input: unknown): ValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['信封必须是普通对象'] };
  }
  const env = input as Record<string, unknown>;
  const errors: string[] = [];

  if (env.v !== 1) {
    errors.push(`v 必须为 1（当前协议版本），实际 ${String(env.v)}`);
  }
  if (typeof env.type !== 'string' || !(MESSAGE_TYPES as readonly string[]).includes(env.type)) {
    errors.push(
      `type 必须是已知消息类型之一（${(MESSAGE_TYPES as readonly string[]).join(', ')}），实际 ${String(env.type)}`,
    );
  }

  const seatless =
    typeof env.type === 'string' && (SEATLESS_MESSAGE_TYPES as readonly string[]).includes(env.type);
  if (seatless) {
    if (env.seatId !== undefined) {
      errors.push(`无座位归属消息类型 "${env.type}" 不允许携带 seatId`);
    }
    if (env.seq !== 0) {
      errors.push(`无座位归属消息类型 "${env.type}" 的 seq 必须为 0，实际 ${String(env.seq)}`);
    }
  } else {
    if (typeof env.seatId !== 'string' || env.seatId.length === 0) {
      errors.push('座位归属消息必须携带非空字符串 seatId');
    }
    if (typeof env.seq !== 'number' || !Number.isInteger(env.seq) || env.seq < 0) {
      errors.push(`seq 必须为非负整数（座位级有序，双向各自编号），实际 ${String(env.seq)}`);
    }
  }

  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts) || env.ts < 0) {
    errors.push(`ts 必须为非负有限数字（毫秒时间戳），实际 ${String(env.ts)}`);
  }
  if (env.payload === null || typeof env.payload !== 'object' || Array.isArray(env.payload)) {
    errors.push('payload 必须是对象');
  }

  return { ok: errors.length === 0, errors };
}
