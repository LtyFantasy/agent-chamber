/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §3 (契约①: SeatDriver 接口原文——统一层是本接口而非 ACP,
 *           r4 明确)
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * 契约① SeatDriver 接口（厂商适配层对上统一面）
 *
 * 一个座位 = 一个运行时会话（单线程串行）。厂商无关——chamber 与 runner 其余部分
 * 对具体厂商零感知，只需面向本接口编程。
 *
 * 出处：docs/roundtable-design.md §3（契约①：SeatDriver 接口，r4 原文）。
 * 类型面（SeatEvent/SeatConfig）统一复用 @agent-chamber/roundtable-protocol。
 */
import type { SeatConfig, SeatEvent } from '@agent-chamber/roundtable-protocol';

/** 注入提示词（runner-core 装配后传给 driver：规则头 + JSON 消息体全文） */
export interface InjectedPrompt {
  /** 装配后的完整 prompt 文本（规则头 + '\n\n' + JSON.stringify(body, null, 2)，设计 §4/§6） */
  text: string;
}

/**
 * 单飞行冲突错误：座位 busy 时拒绝并发 inject（设计 §3 关键语义「per-seat 单飞行」）。
 * runner-core 捕获后上行 status busy 事件（防御性，chamber 单飞行本应保证不重发）。
 */
export class BusyError extends Error {
  constructor(seatId: string) {
    super(`seat ${seatId} is busy (single-flight)`);
    this.name = 'BusyError';
  }
}

/**
 * 座位驱动：一个座位 = 一个运行时会话（单线程串行）
 * （docs/roundtable-design.md §3 原文接口）
 */
export interface SeatDriver {
  /** 拉起或复活座位对应的运行时会话；幂等（已活则复用） */
  start(config: SeatConfig): Promise<void>;
  /** 注入一轮 prompt（规则头+攒批合并文本，chamber 装配）；座位 busy 时拒绝并发（单飞行） */
  inject(seatId: string, prompt: InjectedPrompt): Promise<void>;
  /**
   * 应答一个挂起的审批请求（人类裁决下行）。
   * optionId 为 ACP 审批选项 id（与 session/request_permission params.options 同源），
   * **原样透传不做 kind 映射**——RT-PERM-1：ACP 标准 kind 是 allow_*，kind 命名不可信，
   * optionId 才是稳定键（runner-core 反查确认 option 存在后直传）。
   */
  answerPermission(seatId: string, requestId: string, optionId: string): Promise<void>;
  /**
   * 优雅打断当前 turn（driver 发 `session/cancel` 通知等 prompt 正常 resolve——
   * stopReason=cancelled 单条收尾、会话存活；无响应超时兜底 kill，会话可 resume 复活）。
   */
  cancel(seatId: string): Promise<void>;
  /** 停掉座位运行时（杀子进程；会话已落盘，随时可 start 复活） */
  stop(seatId: string): Promise<void>;
  /** 停止全部座位运行时（runner 退出/cli 收尾用；可选——runner-core stop 时逐个调用） */
  stopAll?(): Promise<void>;
  /** 事件出口（上行全部走这里） */
  onEvent(handler: (event: SeatEvent) => void): void;
}

export type { SeatConfig, SeatEvent };
