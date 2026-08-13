/**
 * 契约① SeatDriver 类型面（厂商适配层对上统一面）
 *
 * 以 ACP 能力超集设计（流式块/工具事件/审批请求/用量 四样齐备），能力弱的厂商降级接入并挂风险注记。
 * 统一层是本接口而非 ACP（r4 明确）：ACP 是首选传输实现，不是前提。
 *
 * 全部字段出处：docs/roundtable-design.md §3（契约①：SeatDriver 接口，r4）。
 */

/** 已知座位厂商集合。已接入 'kimi' | 'codex'（M4a）；后续 'claude-code' | 'opencode' 按序扩展（docs/roundtable-design.md §3） */
export const SEAT_VENDORS = ['kimi', 'codex'] as const;

/**
 * 座位厂商标识
 * 已接入 'kimi' | 'codex'；类型层仍保留 `(string & {})` 联合承接后续
 * 'claude-code' | 'opencode' —— 接入新厂商无需改本协议包。
 */
export type SeatVendor = 'kimi' | 'codex' | (string & {});

/** 权限模式枚举值（docs/roundtable-design.md §3 原文：'default' | 'plan' | 'auto' | 'yolo'） */
export const PERMISSION_MODES = ['default', 'plan', 'auto', 'yolo'] as const;

/**
 * 权限模式
 * 显式钉死，禁止吃用户 config 剩饭（§8 实测：config.toml 的 yolo 会泄漏进 ACP 会话，
 * 显示 default 实为 yolo —— 每个座位 start 后须显式 set_config_option mode 钉死）。
 */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** 座位运行时状态枚举值（SeatEvent status variant 的 status 字段取值，docs/roundtable-design.md §3 原文） */
export const SEAT_RUNTIME_STATUSES = ['online', 'busy', 'offline'] as const;

/** 座位运行时状态：online / busy / offline */
export type SeatRuntimeStatus = (typeof SEAT_RUNTIME_STATUSES)[number];

/**
 * 座位配置（seat.assign 下行下发，docs/roundtable-design.md §3 原文）
 * 一个座位 = 一个运行时会话（单线程串行）
 */
export interface SeatConfig {
  /** 座位 ID */
  seatId: string;
  /** 座位展示名（身份模型见 docs/roundtable-design.md §6） */
  label: string;
  /** 厂商标识（'kimi'/'codex' 已接入，M4a 起扩展） */
  vendor: SeatVendor;
  /** 座位工作目录（agent 的环境边界） */
  cwd: string;
  /** 权限模式（显式钉死，禁止吃用户 config 剩饭，见 PermissionMode 注释） */
  permissionMode: PermissionMode;
  /** 可选模型覆盖（ACP set_config_option） */
  model?: string;
}

/**
 * 工具事件负载
 * 字段未在 docs/roundtable-design.md §3 冻结（原文仅声明 `tool: ToolEventPayload`），
 * 预留宽松形状，待厂商实测后收紧。
 */
export type ToolEventPayload = Record<string, unknown>;

/** 工具摘要（字段未冻结，同上；审批请求展示用） */
export type ToolBrief = Record<string, unknown>;

/** 审批选项（字段未冻结，同上；§4 下行 seat.permission_verdict 的 optionId 即选项 id） */
export type PermissionOption = Record<string, unknown>;

/** SeatEvent 七 variant 的 type 取值（docs/roundtable-design.md §3 原文 + M3 阶段 5 追加 seat_info） */
export const SEAT_EVENT_TYPES = [
  'message_chunk',
  'message_complete',
  'tool_event',
  'permission_request',
  'usage',
  'status',
  'seat_info',
] as const;

/**
 * 座位事件（SeatDriver 事件出口，docs/roundtable-design.md §3 原文，七 variant）
 * 上行全部走 onEvent → seat.event 透传。
 * - message_chunk：流式增量
 * - message_complete：turn 终结（含沉默判定输入 silent?）
 * - tool_event：工具调用可观测
 * - permission_request：审批请求（无限期阻塞，平台零缺省）
 * - usage：预算熔断 + 上下文水位数据源
 * - status：online / busy / offline
 * - seat_info：座位**实际在跑**的配置观测（model/thinking/mode 地面真相，M3 阶段 5；
 *   全可选宽松字符串——不同 vendor 的字段可能有缺；本批仅观测上行，不做下发钉死）
 */
export type SeatEvent =
  | { type: 'message_chunk'; seatId: string; text: string }
  | {
      type: 'message_complete';
      seatId: string;
      stopReason: string;
      silent?: boolean;
      /** turn 全文（runner 侧流式累积）——chamber 优先采用，chunk buffer 仅兜底：
       *  chamber 重启清空内存 buffer 后，靠本字段保证回复不丢（2026-08-07 dogfood 实测踩中） */
      text?: string;
    }
  | { type: 'tool_event'; seatId: string; tool: ToolEventPayload }
  | {
      type: 'permission_request';
      seatId: string;
      requestId: string;
      tool: ToolBrief;
      options: PermissionOption[];
    }
  | { type: 'usage'; seatId: string; used: number; size: number }
  | { type: 'status'; seatId: string; status: SeatRuntimeStatus; detail?: string }
  | {
      type: 'seat_info';
      seatId: string;
      /** 实际在跑的模型（configOptions 当前值；seat.assign 显式 model 覆盖时以钉死值为准） */
      model?: string;
      /** 思考等级（low/high/max 等，原文透传不翻译） */
      thinking?: string;
      /** 权限模式（default/plan/auto/yolo 等，原文透传不翻译） */
      mode?: string;
    };
