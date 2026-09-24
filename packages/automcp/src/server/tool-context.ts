/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - MCP 工具调用元数据（toolName / surface）在进程内的传递（usage stats 的 MCP 侧基座）
 *
 * [代码职责]
 *   - AsyncLocalStorage 模块单例：`handleToolsCall` 建立上下文，下游两个注入点读取
 *   - 两个注入头名（`X-MCP-Tool` / `X-MCP-Surface`）的单一定义点
 *   - 工具名归一化（去控制字符 + 128 上限）：头值与上报载荷共用同一结果
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 两个头契约 + 统计口径专章
 *   - 补充: docs/architecture.md §UsageStats 模块
 *
 * [关键不变量]
 *   - **本模块必须只有一个实例**：ALS 靠模块单例工作。若 automcp 与 platform-mcp
 *     各自加载到不同副本（一份 src 一份 dist、或 platform-mcp 未走包入口），
 *     platform-client 读到的 store 恒为 undefined → 语义工具的流量标识静默消失
 *   - **头名厂商中立**（`X-MCP-*`）：随 oss 导出包发布，改名会新增 rebrand 映射
 *   - 归一化只负责"发出的值合法"：surface 的封闭词表收敛、tool_name 的列宽截断
 *     由后端负责，此处不重复实现词表
 *
 * [关联代码]
 *   - server/mcp-server.ts — 上下文的唯一建立点（handleToolsCall 四出口全覆盖）
 *   - proxy/http-proxy.ts — 注入点 ①（原子映射工具）
 *   - packages/platform-mcp/src/platform-client.ts — 注入点 ②（语义工具）
 *   - server/usage-reporter.ts — 上报载荷复用本模块的归一化结果
 *
 * [持久踩坑]
 *   MCP-ALS-1(双实例): ALS 拆成两份实例时两头静默不注入——无报错、无日志，
 *     表现 = 全部 MCP 流量落进空 tool_name / unknown surface，事后不可回填。
 *     安全方向: 断言 platform-mcp 经包名 import 的 helper 与包入口导出是同一引用。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（两个注入点是否仍共用本模块实例）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import { AsyncLocalStorage } from 'async_hooks';

/** MCP 工具名头（后端 usage-stats 拦截器读取；命名厂商中立） */
export const MCP_TOOL_HEADER = 'X-MCP-Tool';

/** MCP 暴露面头（封闭词表 `mcp` / `mcp-full` / `unknown`，由 serve 启动参数解析而来） */
export const MCP_SURFACE_HEADER = 'X-MCP-Surface';

/** 工具名上限：对齐上报 DTO 的 `@MaxLength(128)` 与列宽 `varchar(128)` */
export const TOOL_NAME_MAX_LENGTH = 128;

/**
 * 名字不可用时的哨兵值
 *
 * 用于 tools/call 的两个 pre-name 出口（params 缺失、name 非字符串）。**刻意不用空串**：
 * 后端口径里 `tool_name = ''` 表示"非 MCP 流量"，两者语义不能相撞。
 */
export const INVALID_TOOL_NAME = '__invalid__';

/** 单次 tools/call 的上下文元数据（建立点 = McpServer.handleToolsCall） */
export interface ToolContext {
  /** 本次调用的 tool 名（已归一化） */
  toolName: string;
  /** 本实例的暴露面（serve 启动时解析一次，全程不变） */
  surface: string;
}

/**
 * 进程级单例：一个 automcp 进程内所有工具调用共享同一个 ALS
 *
 * 不做成 class / 工厂——ALS 的语义就是"同模块实例间隐式传参"，
 * 多实例会退化成"上下文随机丢失"（见 [持久踩坑]）。
 */
const toolContextStorage = new AsyncLocalStorage<ToolContext>();

/**
 * 在指定上下文中执行 fn（同步建立、异步继续可见）
 *
 * 用法：`runWithToolContext({ toolName, surface }, async () => {...})`——fn 返回的
 * Promise 及其后续 continuation（await 之后、定时器回调内）都仍在上下文中。
 *
 * @param context - 本次调用的元数据
 * @param fn - 需要上下文覆盖的执行体（通常是一次完整的 tools/call 处理）
 * @returns fn 的返回值（原样透传，不改语义）
 */
export function runWithToolContext<T>(context: ToolContext, fn: () => T): T {
  return toolContextStorage.run(context, fn);
}

/**
 * 读取当前上下文
 *
 * @returns 上下文；非 MCP 场景（如 CLI 直接调用 HttpProxy）返回 undefined——
 *          注入点据此跳过注头，因此"无上下文"是正常态而非错误
 */
export function getToolContext(): ToolContext | undefined {
  return toolContextStorage.getStore();
}

/**
 * 归一化工具名（头值与上报载荷的唯一来源）
 *
 * 两道处理，都是"发出的值必须合法"的必要条件：
 * 1. 剔除控制字符——含 CR/LF 的名字会让 axios 抛 "Invalid character in header content"，
 *    而头注入发生在 try 之外，会把一次普通调用打成 JSON-RPC -32603；
 * 2. 截断到 128——超长名会被上报 DTO 的 `@MaxLength(128)` 拒成 400（fire-and-forget
 *    下这条计数就永久丢了，且 400 属实现缺陷而非正常业务分支）。
 *
 * 清洗后为空（名字全是控制字符）时回退哨兵值，避免发出空名（空串 = "非 MCP 流量"）。
 *
 * @param raw - tools/call 传入的原始 tool 名
 * @returns 可安全放入 header 与上报载荷的工具名
 */
export function normalizeToolName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/gu, '');
  if (cleaned === '') {
    return INVALID_TOOL_NAME;
  }

  return cleaned.slice(0, TOOL_NAME_MAX_LENGTH);
}
