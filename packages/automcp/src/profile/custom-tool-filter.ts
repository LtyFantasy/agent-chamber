/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - profile 的 `excludeCustomTools`：按精确工具名把语义工具（custom tools）
 *     从本实例的工具面移除，实现"低频工具降级到 mcp-full、worker 面不暴露"。
 *
 * [代码职责]
 *   - 在 `registerCustomTools` **之前**过滤模块导出的 customTools 数组
 *   - 未知工具名 → 启动期抛错（fail fast：拼错的排除项静默无效是配置事故）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/integrations/platform-mcp.md「工具面契约」；docs/api-definition.md MCP 章节
 *   - 补充: packages/automcp/src/types.ts 的 ToolProfile.excludeCustomTools
 *
 * [关键不变量]
 *   - **精确名而非正则**：custom tools 是封闭集合，且存在同前缀工具
 *     （`delete_doc` / `delete_doc_route`）——正则排除会误伤。
 *   - 只动 custom tools；OpenAPI 自动映射的原子工具仍由 include/exclude 正则控制。
 *   - 排除表非空时必须全部命中，否则抛错（不做"尽力而为"的静默忽略）。
 *
 * [关联代码]
 *   - profile-loader.ts — 解析 excludeCustomTools 字段
 *   - serve-runner.ts — 唯一调用点（加载 custom tools 模块之后、注册之前）
 * =============================================================================
 */

import type { CustomTool } from '../types';

/**
 * 按 profile 的 `excludeCustomTools` 过滤 custom tools
 *
 * 执行顺序：先校验排除表全部命中，再过滤——校验失败时不返回部分结果，
 * 避免"配置写错但仍启动、只是少排了几个工具"的静默漂移。
 *
 * @param tools - `--custom-tools` 模块导出的 customTools 数组
 * @param excludeNames - profile 声明的精确工具名（undefined / 空数组 = 不过滤）
 * @returns 过滤后的数组（保持原顺序）；未配置排除时原样返回
 * @throws 当排除表引用了模块中不存在的工具名时抛出 Error（含未知名与可用名，便于对账）
 */
export function filterCustomTools(
  tools: CustomTool[],
  excludeNames?: string[],
): CustomTool[] {
  if (excludeNames === undefined || excludeNames.length === 0) {
    return tools;
  }

  const available = new Set(tools.map((ct) => ct.tool.name));
  const unknown = excludeNames.filter((name) => !available.has(name));

  if (unknown.length > 0) {
    throw new Error(
      `Profile field "excludeCustomTools" references unknown custom tool(s): ${unknown.join(', ')}. ` +
        `Available custom tools: ${[...available].sort().join(', ')}`,
    );
  }

  const excluded = new Set(excludeNames);
  return tools.filter((ct) => !excluded.has(ct.tool.name));
}
