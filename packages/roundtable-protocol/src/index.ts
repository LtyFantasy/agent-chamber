/**
 * 圆桌模式共享契约包 —— 桶导出
 * 纯 TypeScript 类型 + 手写校验函数，零运行时依赖。
 * 设计出处：docs/roundtable-design.md §3（SeatDriver 契约）/ §4（控制面协议 + r3 冻结注入消息体）。
 */
export * from './envelope';
export * from './seat';
export * from './inject-body';
export * from './messages';
