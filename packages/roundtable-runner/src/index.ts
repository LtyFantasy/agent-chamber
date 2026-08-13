/**
 * @agent-chamber/roundtable-runner —— 桶导出
 *
 * 圆桌模式 runner 独立可执行进程：
 * - SeatDriver 接口（契约①，docs/roundtable-design.md §3）
 * - AcpDriver 传输基座（厂商差异收口 AcpVendorProfile；M4a 由 kimi-acp.ts 提取）
 * - KimiAcpDriver（ACP stdio 驱动 kimi，行为档案 8 条落地 §8）
 * - CodexAcpDriver（ACP stdio 驱动 codex-acp 桥，quirk 薄壳 §8）
 * - RunnerWsClient（控制面 WS 拨号：退避重连/心跳/幂等去重/未确认队列重放，§4）
 * - StateStore（JSON 状态持久化：会话映射/对账游标/未确认队列，原子写+损坏恢复）
 * - RunnerCore（编排：座位生命周期 + 下行分发 + prompt 装配）
 */
export { BusyError } from './drivers/seat-driver';
export type { InjectedPrompt, SeatDriver } from './drivers/seat-driver';
export { AcpDriver, DRIVER_VERSION, MalformedResponseError } from './drivers/acp-driver';
export type { AcpDriverOptions, AcpVendorProfile } from './drivers/acp-driver';
export { KimiAcpDriver } from './drivers/kimi-acp';
export type { KimiAcpDriverOptions } from './drivers/kimi-acp';
export { CodexAcpDriver } from './drivers/codex-acp';
export type { CodexAcpDriverOptions } from './drivers/codex-acp';
export { RunnerWsClient, nextBackoff } from './ws-client';
export type { RunnerWsClientOptions } from './ws-client';
export { StateStore } from './state-store';
export type { PersistedState, SeatPersistedState, PendingEventRecord } from './state-store';
export { RunnerCore } from './runner-core';
export type { RunnerCoreOptions } from './runner-core';
export { ConsoleLogger, NoopLogger } from './logger';
export type { Logger, LogLevel } from './logger';
