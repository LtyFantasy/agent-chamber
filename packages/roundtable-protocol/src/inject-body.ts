/**
 * seat.inject 消息体（r3 冻结 schema，只增不改）
 *
 * inject 的 prompt 文本 = 规则头（markdown，chamber §6 统一装配）+ 本 JSON 消息体。
 * 消息体投影对齐 MCP 消息结构，agent 可明确解析每条消息的发送角色与 id。
 *
 * 出处：docs/roundtable-design.md §4「seat.inject 消息体格式（r3 冻结，只增不改）」。
 */

/**
 * 规则头版本（chamber 统一装配并写入；演进时全平台一致升级，见 §6/§11 风险对策「规则头漂移」）
 * v2（M2 阶段 3）：规则头「身份与路由」段新增 @all 显式广播令牌说明（R1 用户拍板，
 * mention 模式下人机皆可用；chamber 侧 buildRuleHeader 文本与 body.ruleHeaderVersion
 * 同步升级，全平台一致——runner 侧不校验具体版本值，仅要求 >=1 整数，向后兼容）。
 * v1：M1 初版（身份 / 沉默协议 / @提及路由 / 攒批语义 / 证据纪律）。
 */
export const RULE_HEADER_VERSION = 2;

/** 沉默哨兵：整个回复仅为此文本时判定为沉默（结构化哨兵，不用裸字符串；§3/§4 上行回复约定 r3 冻结） */
export const SILENT_SENTINEL = '{"silent": true}';

/** 注入消息体协议版本（r3 冻结，固定 1） */
export const INJECT_BODY_VERSION = 1 as const;

/** 注入消息体类型标识（r3 冻结，固定 'roundtable.inject'） */
export const INJECT_BODY_KIND = 'roundtable.inject' as const;

/** 消息发送者类型枚举（r3 冻结）：human / agent / system */
export const INJECT_FROM_TYPES = ['human', 'agent', 'system'] as const;

/** 消息发送者类型（r3 冻结）：human / agent / system */
export type InjectFromType = (typeof INJECT_FROM_TYPES)[number];

/** 注入消息体（r3 冻结 schema，只增不改，docs/roundtable-design.md §4） */
export interface InjectBody {
  /** 协议版本（固定 1；r3 冻结） */
  v: typeof INJECT_BODY_VERSION;
  /** 消息体类型标识（固定 'roundtable.inject'；r3 冻结） */
  kind: typeof INJECT_BODY_KIND;
  /** 所属 topic 投影（对齐 MCP 消息结构） */
  topic: {
    /** topic id */
    id: string;
    /** topic 标题 */
    title: string;
  };
  /** 接收座位（主脑座位 coordinator: true） */
  seat: {
    /** 座位 label */
    label: string;
    /** 是否主脑座位（主脑调度指令必须 topic 明说可观测，§6） */
    coordinator: boolean;
  };
  /** 规则头版本（当前 2；chamber 装配时写入 RULE_HEADER_VERSION） */
  ruleHeaderVersion: number;
  /** 攒批消息块（batch.messages 按 ts 升序，全量携带消息 id 支持下钻） */
  batch: {
    /** 攒批窗口毫秒数：0 = 直通注入（M1）；>0 = 攒批窗口（M2 起，§6 默认 30s 一处常量可调） */
    windowMs: number;
    /** 消息列表（按 ts 升序；全量携带消息 id，agent/人类可按 id 下钻上下文） */
    messages: InjectBodyMessage[];
  };
}

/** 注入消息体中的单条消息（r3 冻结，只增不改） */
export interface InjectBodyMessage {
  /** 消息 id（agent/人类可按 id 下钻上下文） */
  id: string;
  /** 发送者信息 */
  from: {
    /** 发送者展示名 */
    name: string;
    /** 发送者类型：human / agent / system（r3 冻结） */
    type: InjectFromType;
    /**
     * 座位 label（座位发言时非 null；回声抑制保证座位收不到自己的消息，体中出现的必然都是别人的）
     * 非座位发言（人类/系统）为 null
     */
    seatLabel: string | null;
    /**
     * 主脑座位发言为 true（主脑身份随消息显性传递，接收 agent 一眼识别主脑指令；
     * 仅座位发言时有意义，2026-08-07 用户拍板）
     */
    coordinator: boolean;
    /**
     * 发送者软删时间（ISO 8601 字符串；未删除为 null，2026-08-26 统一批新增）。
     * 非空 = 该发送者已从平台删除——名字仍可显示（历史归因保留），但消费方不得
     * 再 @、邀请或改派该 actor（写接口会拒绝，见 docs/spec.md §1 契约）。
     * r3 冻结"只增不改"：本字段为可选新增，旧消息体（无此键）解析仍通过。
     */
    deletedAt?: string | null;
  };
  /** 消息时间戳（ISO 8601 字符串，如 2026-08-07T12:00:00Z） */
  ts: string;
  /** 引用的父消息 id（无引用为 null） */
  replyTo: string | null;
  /** 消息正文 */
  content: string;
}

/** assembleInjectBody 输入 */
export interface AssembleInjectBodyInput {
  /** 所属 topic */
  topic: { id: string; title: string };
  /** 接收座位 label（主脑座位调用方需同时传 coordinator: true） */
  seatLabel: string;
  /** 是否主脑座位（默认 false） */
  coordinator?: boolean;
  /** 攒批窗口毫秒数（默认 0 = M1 直通注入；M2 起 chamber 传入 >0） */
  windowMs?: number;
  /** 消息列表（调用方保证按 ts 升序） */
  messages: InjectBodyMessage[];
}

/**
 * 装配注入消息体（v=1 / kind='roundtable.inject' / ruleHeaderVersion=当前版本 自动填充）
 * @param input 装配输入（topic/座位/窗口/消息）
 * @returns 符合 r3 冻结 schema 的 InjectBody
 */
export function assembleInjectBody(input: AssembleInjectBodyInput): InjectBody {
  return {
    v: INJECT_BODY_VERSION,
    kind: INJECT_BODY_KIND,
    topic: { id: input.topic.id, title: input.topic.title },
    seat: { label: input.seatLabel, coordinator: input.coordinator ?? false },
    ruleHeaderVersion: RULE_HEADER_VERSION,
    batch: { windowMs: input.windowMs ?? 0, messages: input.messages },
  };
}

/** parseInjectBody 结果（ok 时 body 收窄为通过校验的 InjectBody） */
export type ParseInjectBodyResult =
  | { ok: true; body: InjectBody; errors: [] }
  | { ok: false; errors: string[] };

/** 判断是否为普通对象（非 null、非数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验单条注入消息（私有，供 parseInjectBody 使用）
 * @param msg 待校验消息
 * @param index 在 batch.messages 中的下标（用于错误定位）
 * @param errors 累积错误列表（就地追加）
 */
function validateInjectBodyMessage(msg: unknown, index: number, errors: string[]): void {
  const where = `batch.messages[${index}]`;
  if (!isPlainObject(msg)) {
    errors.push(`${where} 必须是对象`);
    return;
  }
  if (typeof msg.id !== 'string' || msg.id.length === 0) {
    errors.push(`${where}.id 必须为非空字符串`);
  }
  if (!isPlainObject(msg.from)) {
    errors.push(`${where}.from 必须是对象`);
  } else {
    if (typeof msg.from.name !== 'string' || msg.from.name.length === 0) {
      errors.push(`${where}.from.name 必须为非空字符串`);
    }
    if (
      typeof msg.from.type !== 'string' ||
      !(INJECT_FROM_TYPES as readonly string[]).includes(msg.from.type)
    ) {
      errors.push(`${where}.from.type 必须为 ${INJECT_FROM_TYPES.join(' | ')} 之一`);
    }
    if (msg.from.seatLabel !== null && typeof msg.from.seatLabel !== 'string') {
      errors.push(`${where}.from.seatLabel 必须为字符串或 null`);
    }
    if (typeof msg.from.coordinator !== 'boolean') {
      errors.push(`${where}.from.coordinator 必须为布尔`);
    }
  }
  if (typeof msg.ts !== 'string' || msg.ts.length === 0 || Number.isNaN(Date.parse(msg.ts))) {
    errors.push(`${where}.ts 必须为可解析的 ISO 8601 时间字符串（如 2026-08-07T12:00:00Z）`);
  }
  if (msg.replyTo !== null && typeof msg.replyTo !== 'string') {
    errors.push(`${where}.replyTo 必须为字符串或 null`);
  }
  if (typeof msg.content !== 'string') {
    errors.push(`${where}.content 必须为字符串`);
  }
}

/**
 * 解析并校验注入消息体（r3 冻结 schema）
 * @param input 待校验对象（典型来源：seat.inject payload.body）
 * @returns ok:true 时 body 为通过校验的 InjectBody；ok:false 时 errors 累积全部问题
 */
export function parseInjectBody(input: unknown): ParseInjectBodyResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['注入消息体必须是普通对象'] };
  }
  const errors: string[] = [];

  if (input.v !== INJECT_BODY_VERSION) {
    errors.push(`v 必须为 ${INJECT_BODY_VERSION}（r3 冻结），实际 ${String(input.v)}`);
  }
  if (input.kind !== INJECT_BODY_KIND) {
    errors.push(`kind 必须为 "${INJECT_BODY_KIND}"（r3 冻结），实际 ${String(input.kind)}`);
  }
  if (!isPlainObject(input.topic)) {
    errors.push('topic 必须是对象');
  } else {
    if (typeof input.topic.id !== 'string' || input.topic.id.length === 0) {
      errors.push('topic.id 必须为非空字符串');
    }
    if (typeof input.topic.title !== 'string' || input.topic.title.length === 0) {
      errors.push('topic.title 必须为非空字符串');
    }
  }
  if (!isPlainObject(input.seat)) {
    errors.push('seat 必须是对象');
  } else {
    if (typeof input.seat.label !== 'string' || input.seat.label.length === 0) {
      errors.push('seat.label 必须为非空字符串');
    }
    if (typeof input.seat.coordinator !== 'boolean') {
      errors.push('seat.coordinator 必须为布尔');
    }
  }
  if (
    typeof input.ruleHeaderVersion !== 'number' ||
    !Number.isInteger(input.ruleHeaderVersion) ||
    input.ruleHeaderVersion < 1
  ) {
    errors.push(
      `ruleHeaderVersion 必须为 >= 1 的整数（当前版本 ${RULE_HEADER_VERSION}），实际 ${String(input.ruleHeaderVersion)}`,
    );
  }
  if (!isPlainObject(input.batch)) {
    errors.push('batch 必须是对象');
  } else {
    if (
      typeof input.batch.windowMs !== 'number' ||
      !Number.isInteger(input.batch.windowMs) ||
      input.batch.windowMs < 0
    ) {
      errors.push(
        `batch.windowMs 必须为非负整数（0 = 直通注入 M1；>0 = 攒批窗口 M2 起），实际 ${String(input.batch.windowMs)}`,
      );
    }
    if (!Array.isArray(input.batch.messages)) {
      errors.push('batch.messages 必须是数组（按 ts 升序）');
    } else {
      input.batch.messages.forEach((msg, index) => validateInjectBodyMessage(msg, index, errors));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  // 已通过全量字段校验，此处断言收窄；Record<string, unknown> 与 InjectBody 无直接重叠，须经 unknown 过渡
  return { ok: true, body: input as unknown as InjectBody, errors: [] };
}

/**
 * 宽松解析沉默哨兵
 * 规则（§3/§4 上行回复约定 r3 冻结）：trim 后整体可被 JSON.parse 且结果对象 silent === true 才判定沉默，
 * 其余一律 false。回复正文不做 JSON 约束（强制全文 JSON 太脆——agent 一次忘记全链路乱），
 * 因此正文里藏 JSON、silent 为字符串等均不判定沉默。
 * @param text agent 回复正文（自然 markdown 原文）
 * @returns 是否判定为沉默（true 时由 chamber 拦截不落 topic，§6 沉默拦截）
 */
export function parseSilentReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).silent === true
    );
  } catch {
    return false;
  }
}
