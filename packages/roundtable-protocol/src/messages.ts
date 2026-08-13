/**
 * 契约② 控制面消息 payload（上行/下行逐类型定义 + 手写校验）
 *
 * 上行（runner → chamber）：hello / seat.event / pong；
 * 下行（chamber → runner）：seat.assign / seat.inject / seat.permission_verdict / seat.cancel / seat.revoke / ping。
 *
 * 出处：docs/roundtable-design.md §4（上行/下行消息表）。
 */
import type { RoundtableMessageType, ValidationResult } from './envelope';
import { PERMISSION_MODES, SEAT_EVENT_TYPES, SEAT_RUNTIME_STATUSES } from './seat';
import type { SeatConfig, SeatEvent, SeatVendor } from './seat';
import { parseInjectBody } from './inject-body';
import type { InjectBody } from './inject-body';

/** hello payload：连接建立/重连对账（§4 上行表） */
export interface HelloPayload {
  /** runner 版本号 */
  version: string;
  /** 支持的厂商列表 */
  vendors: SeatVendor[];
  /**
   * 各座位对账信息（seatId → 已发/已收序号）
   * 重连后双方按缺口重放（双向对账，无逐条 ack，§4 可靠性）
   */
  seats: Record<string, SeatReconciliation>;
}

/** 座位对账信息（§4 可靠性：双向对账，无逐条 ack） */
export interface SeatReconciliation {
  /** 我方已发送的最大 seq（座位级） */
  lastSentSeq: number;
  /** 我方已接收的最大 seq（座位级） */
  lastReceivedSeq: number;
}

/**
 * 座位上行游标信息（chamber 视角，阶段 5 新增，仅增字段）：
 * runner 侧未确认队列裁剪的权威依据——chamber 已处理（落库）的 seq 区间 =
 * `≤ lastEventSeq 且不在 failedEventSeqs`。
 */
export interface SeatAckInfo {
  /** chamber 已处理的最大上行 seq（seat.last_event_seq） */
  lastEventSeq: number;
  /**
   * chamber 留档的失败 seq（message_complete 落库失败，M1 三新债 #1 游标蛙跳修复）：
   * 该区间内的 seq 虽 ≤ lastEventSeq 但**未被处理**，重放时不得被幂等去重——
   * runner 裁剪未确认队列时对这些 seq 必须保留，留待重连重放重试。
   */
  failedEventSeqs: number[];
}

/**
 * hello_ack payload：chamber 对 runner hello 的回执（阶段 5 新增下行类型，仅增）——
 * 各座位上行游标（lastEventSeq + failedEventSeqs）。runner 收到后裁剪「已确认送达」
 * 的未确认队列区间（重连重放成功后清空已确认部分；无逐条 ack 协议下，回执即确认）。
 */
export interface HelloAckPayload {
  /** seatId → 上行游标信息（chamber 已收/已处理视角） */
  seats: Record<string, SeatAckInfo>;
}

/**
 * ping payload：心跳（§4 下行表，原为无字段）——阶段 5 起可选携带 chamber 上行游标：
 * 长连接期间 30s 心跳顺带推送游标，runner 定期裁剪已确认送达条目（M1 三新债 #2
 * 无界增长修复）；缺省 `{}` 与旧协议完全兼容（仅增可选字段）。
 */
export interface PingPayload {
  /** seatId → 上行游标信息（可选；缺省 = 纯心跳，旧 chamber 行为） */
  seats?: Record<string, SeatAckInfo>;
}

/** seat.event payload：契约① SeatEvent 原样透传（§4 上行表，含 silent 标记） */
export type SeatEventPayload = SeatEvent;

/** pong payload：心跳应答（§4 上行表，payload 无字段） */
export interface PongPayload {}

/** seat.assign payload：座位绑定到该 runner，下发 SeatConfig（§4 下行表） */
export type SeatAssignPayload = SeatConfig;

/**
 * seat.inject payload：攒批后注入（§4 下行表）
 * 规则头（chamber §6 统一装配）+ r3 冻结 JSON 消息体
 */
export interface InjectPayload {
  /** 规则头（markdown，chamber §6 统一装配；runner 与 prompt 作者禁止改写） */
  ruleHeader: string;
  /** 合并消息体（r3 冻结 schema，见 inject-body.ts；batch.messages 全量消息 id 支持下钻） */
  body: InjectBody;
}

/**
 * seat.permission_verdict payload：人类裁决下行（§4 下行表）
 * 无超时，runner 永久 park 等待（原则 3.4：平台零缺省）
 */
export interface PermissionVerdictPayload {
  /** 挂起的审批请求 id */
  requestId: string;
  /** 选中的选项 id（对应 PermissionOption 的 id） */
  optionId: string;
}

/** 空 payload（pong / ping / seat.cancel / seat.revoke / error：§4 消息表 payload 为 "—"，无字段定义） */
export interface EmptyPayload {}

/** 判断是否为普通对象（非 null、非数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 判断是否为非负整数 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 判断是否为非负有限数字 */
function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 空错误列表 → 通过 */
function okResult(): ValidationResult {
  return { ok: true, errors: [] };
}

/** 单条错误 → 不通过 */
function failResult(message: string): ValidationResult {
  return { ok: false, errors: [message] };
}

/** 错误列表 → 结果（累积全部问题） */
function resultOf(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

/** 校验 hello payload（runner 版本 / vendors / 各座位对账信息） */
function validateHelloPayload(payload: unknown): ValidationResult {
  if (!isPlainObject(payload)) {
    return failResult('hello payload 必须是普通对象');
  }
  const errors: string[] = [];
  if (typeof payload.version !== 'string' || payload.version.length === 0) {
    errors.push('hello payload.version 必须为非空字符串（runner 版本）');
  }
  if (
    !Array.isArray(payload.vendors) ||
    payload.vendors.some((v) => typeof v !== 'string' || v.length === 0)
  ) {
    errors.push('hello payload.vendors 必须为非空字符串数组（支持的厂商列表）');
  }
  if (!isPlainObject(payload.seats)) {
    errors.push('hello payload.seats 必须为普通对象（seatId → 对账信息）');
  } else {
    for (const [seatId, rec] of Object.entries(payload.seats)) {
      if (
        !isPlainObject(rec) ||
        !isNonNegativeInteger(rec.lastSentSeq) ||
        !isNonNegativeInteger(rec.lastReceivedSeq)
      ) {
        errors.push(
          `hello payload.seats["${seatId}"] 必须为 { lastSentSeq, lastReceivedSeq } 且均为非负整数`,
        );
      }
    }
  }
  return resultOf(errors);
}

/** 单条座位游标信息（SeatAckInfo）形状判定：lastEventSeq 非负整数 + failedEventSeqs 非负整数数组 */
function isAckInfo(value: unknown): value is SeatAckInfo {
  return (
    isPlainObject(value) &&
    isNonNegativeInteger(value.lastEventSeq) &&
    Array.isArray(value.failedEventSeqs) &&
    value.failedEventSeqs.every(isNonNegativeInteger)
  );
}

/** 校验游标映射（hello_ack 必选 / ping 可选共用；seatId → SeatAckInfo） */
function validateAckSeats(seats: unknown, errors: string[]): void {
  if (!isPlainObject(seats)) {
    errors.push('seats 必须为普通对象（seatId → 上行游标信息）');
    return;
  }
  for (const [seatId, info] of Object.entries(seats)) {
    if (!isAckInfo(info)) {
      errors.push(
        `seats["${seatId}"] 必须为 { lastEventSeq, failedEventSeqs }——lastEventSeq 非负整数，failedEventSeqs 为非负整数数组`,
      );
    }
  }
}

/** 校验 hello_ack payload（chamber → runner 的上行游标回执，阶段 5 新增下行类型） */
function validateHelloAckPayload(payload: unknown): ValidationResult {
  if (!isPlainObject(payload)) {
    return failResult('hello_ack payload 必须是普通对象');
  }
  const errors: string[] = [];
  validateAckSeats(payload.seats, errors);
  return resultOf(errors);
}

/** 校验 ping payload（心跳；阶段 5 起可选 seats 游标字段，缺省空对象仍合法——与旧协议兼容） */
function validatePingPayload(payload: unknown): ValidationResult {
  if (!isPlainObject(payload)) {
    return failResult('ping payload 必须为对象');
  }
  if (payload.seats === undefined) return okResult();
  const errors: string[] = [];
  validateAckSeats(payload.seats, errors);
  return resultOf(errors);
}

/** 校验 seat.event payload（契约① SeatEvent 七 variant 透传，含 M3 阶段 5 新增 seat_info） */
function validateSeatEventPayload(payload: unknown): ValidationResult {
  if (!isPlainObject(payload)) {
    return failResult('seat.event payload 必须是普通对象');
  }
  const errors: string[] = [];
  if (typeof payload.seatId !== 'string' || payload.seatId.length === 0) {
    errors.push('seat.event payload.seatId 必须为非空字符串');
  }
  if (
    typeof payload.type !== 'string' ||
    !(SEAT_EVENT_TYPES as readonly string[]).includes(payload.type)
  ) {
    errors.push(`seat.event payload.type 必须为 ${SEAT_EVENT_TYPES.join(' | ')} 之一`);
    return resultOf(errors);
  }
  switch (payload.type) {
    case 'message_chunk':
      if (typeof payload.text !== 'string') {
        errors.push('message_chunk 必须携带字符串 text（流式增量）');
      }
      break;
    case 'message_complete':
      if (typeof payload.stopReason !== 'string') {
        errors.push('message_complete 必须携带字符串 stopReason（turn 终结）');
      }
      if (payload.silent !== undefined && typeof payload.silent !== 'boolean') {
        errors.push('message_complete.silent 若存在必须为布尔（沉默判定输入）');
      }
      if (payload.text !== undefined && typeof payload.text !== 'string') {
        errors.push('message_complete.text 若存在必须为字符串（turn 全文，chamber 优先于 chunk buffer 采用）');
      }
      break;
    case 'tool_event':
      if (!isPlainObject(payload.tool)) {
        errors.push('tool_event 必须携带对象 tool（工具调用可观测）');
      }
      break;
    case 'permission_request':
      if (typeof payload.requestId !== 'string' || payload.requestId.length === 0) {
        errors.push('permission_request 必须携带非空字符串 requestId');
      }
      if (!isPlainObject(payload.tool)) {
        errors.push('permission_request 必须携带对象 tool（ToolBrief）');
      }
      if (!Array.isArray(payload.options)) {
        errors.push('permission_request 必须携带数组 options（PermissionOption[]）');
      }
      break;
    case 'usage':
      if (!isNonNegativeFinite(payload.used)) {
        errors.push('usage.used 必须为非负数字（预算熔断+上下文水位数据源）');
      }
      if (!isNonNegativeFinite(payload.size)) {
        errors.push('usage.size 必须为非负数字');
      }
      break;
    case 'seat_info':
      // M3 阶段 5：实际在跑配置观测（model/thinking/mode 地面真相）——全可选宽松字符串，
      // 不同 vendor 字段可能有缺；仅要求类型（若有）。seatId 必填已在开头统一校验。
      if (payload.model !== undefined && typeof payload.model !== 'string') {
        errors.push('seat_info.model 若存在必须为字符串（实际在跑模型）');
      }
      if (payload.thinking !== undefined && typeof payload.thinking !== 'string') {
        errors.push('seat_info.thinking 若存在必须为字符串（思考等级，原文透传）');
      }
      if (payload.mode !== undefined && typeof payload.mode !== 'string') {
        errors.push('seat_info.mode 若存在必须为字符串（权限模式，原文透传）');
      }
      break;
    case 'status':
      if (
        typeof payload.status !== 'string' ||
        !(SEAT_RUNTIME_STATUSES as readonly string[]).includes(payload.status)
      ) {
        errors.push(`status.status 必须为 ${SEAT_RUNTIME_STATUSES.join(' | ')} 之一`);
      }
      if (payload.detail !== undefined && typeof payload.detail !== 'string') {
        errors.push('status.detail 若存在必须为字符串');
      }
      break;
    default:
      // 理论不可达：payload.type 已在上方校验为 SEAT_EVENT_TYPES 之一
      break;
  }
  return resultOf(errors);
}

/** 校验 seat.assign payload（SeatConfig 结构） */
function validateSeatConfigPayload(payload: unknown): ValidationResult {
  if (!isPlainObject(payload)) {
    return failResult('seat.assign payload 必须是普通对象');
  }
  const errors: string[] = [];
  if (typeof payload.seatId !== 'string' || payload.seatId.length === 0) {
    errors.push('seat.assign payload.seatId 必须为非空字符串');
  }
  if (typeof payload.label !== 'string' || payload.label.length === 0) {
    errors.push('seat.assign payload.label 必须为非空字符串（座位展示名）');
  }
  if (typeof payload.vendor !== 'string' || payload.vendor.length === 0) {
    errors.push('seat.assign payload.vendor 必须为非空字符串（已接入 kimi/codex，类型层预留后续扩展）');
  }
  if (typeof payload.cwd !== 'string' || payload.cwd.length === 0) {
    errors.push('seat.assign payload.cwd 必须为非空字符串（座位工作目录）');
  }
  if (
    typeof payload.permissionMode !== 'string' ||
    !(PERMISSION_MODES as readonly string[]).includes(payload.permissionMode)
  ) {
    errors.push(`seat.assign payload.permissionMode 必须为 ${PERMISSION_MODES.join(' | ')} 之一（显式钉死，禁止吃用户 config 剩饭）`);
  }
  if (payload.model !== undefined && typeof payload.model !== 'string') {
    errors.push('seat.assign payload.model 若存在必须为字符串');
  }
  return resultOf(errors);
}

/** 校验 seat.inject payload（规则头 + r3 冻结消息体） */
function validateInjectPayload(payload: unknown): ValidationResult {
  if (!isPlainObject(payload)) {
    return failResult('seat.inject payload 必须是普通对象');
  }
  const errors: string[] = [];
  if (typeof payload.ruleHeader !== 'string' || payload.ruleHeader.length === 0) {
    errors.push('seat.inject payload.ruleHeader 必须为非空字符串（规则头，chamber §6 统一装配）');
  }
  const bodyResult = parseInjectBody(payload.body);
  if (!bodyResult.ok) {
    for (const e of bodyResult.errors) {
      errors.push(`seat.inject payload.body: ${e}`);
    }
  }
  return resultOf(errors);
}

/** 校验 seat.permission_verdict payload（requestId + optionId） */
function validatePermissionVerdictPayload(payload: unknown): ValidationResult {
  if (!isPlainObject(payload)) {
    return failResult('seat.permission_verdict payload 必须是普通对象');
  }
  const errors: string[] = [];
  if (typeof payload.requestId !== 'string' || payload.requestId.length === 0) {
    errors.push('seat.permission_verdict payload.requestId 必须为非空字符串');
  }
  if (typeof payload.optionId !== 'string' || payload.optionId.length === 0) {
    errors.push('seat.permission_verdict payload.optionId 必须为非空字符串');
  }
  return resultOf(errors);
}

/** 校验空 payload 类型（pong/ping/seat.cancel/seat.revoke/error：无字段定义，仅要求普通对象） */
function validateEmptyPayload(payload: unknown, typeName: string): ValidationResult {
  if (!isPlainObject(payload)) {
    return failResult(`${typeName} payload 必须为对象（当前协议无字段定义）`);
  }
  return okResult();
}

/**
 * 逐类型校验消息 payload（信封外壳校验见 validateEnvelope；两者组合构成完整校验——
 * §7 注入面：WebSocket 仅接受信封内定义的类型与字段，payload 逐类型校验）
 * @param type 消息类型（信封 type 字段）
 * @param payload 待校验的 payload
 * @returns { ok, errors } —— ok=false 时 errors 累积全部问题
 */
export function validatePayload(
  type: RoundtableMessageType,
  payload: unknown,
): ValidationResult {
  switch (type) {
    case 'hello':
      return validateHelloPayload(payload);
    case 'hello_ack':
      return validateHelloAckPayload(payload);
    case 'seat.event':
      return validateSeatEventPayload(payload);
    case 'seat.assign':
      return validateSeatConfigPayload(payload);
    case 'seat.inject':
      return validateInjectPayload(payload);
    case 'seat.permission_verdict':
      return validatePermissionVerdictPayload(payload);
    case 'seat.cancel':
      return validateEmptyPayload(payload, 'seat.cancel');
    case 'seat.revoke':
      return validateEmptyPayload(payload, 'seat.revoke');
    case 'pong':
      return validateEmptyPayload(payload, 'pong');
    case 'ping':
      return validatePingPayload(payload);
    case 'error':
      return validateEmptyPayload(payload, 'error');
    default:
      return failResult(`未知消息类型 "${String(type)}"`);
  }
}
