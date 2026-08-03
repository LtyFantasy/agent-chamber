/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plans/miss-martian-polaris-superboy.md §Step 6
 *   - 补充: .kimi/plans/miss-martian-polaris-superboy.md §模式 B：静态生成
 *
 * [踩坑索引] -
 *
 * [铁律关联] #7(编译优先) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import type { ParsedOperation, ToolDefinition } from '../types';

/**
 * 静态代码生成器
 *
 * 将 OpenAPI spec 解析结果生成为独立可运行的 TypeScript MCP Server 项目。
 * Phase 2 实现，输出包含 package.json、tsconfig.json、入口文件、tool 实现文件。
 */
export class CodeGenerator {
  private readonly outputDir: string;

  /**
   * 创建代码生成器实例
   * @param outputDir - 输出目录路径
   */
  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  /**
   * 生成完整的 MCP Server 项目
   * @param operations - 解析后的 OpenAPI operation 数组
   * @param tools - 映射后的 MCP tool 定义数组
   * @returns 生成成功后的项目目录路径
   */
  async generate(_operations: ParsedOperation[], _tools: ToolDefinition[]): Promise<string> {
    // TODO: Step 6 实现
    // 1. 创建输出目录结构
    // 2. 生成 package.json（包含依赖）
    // 3. 生成 tsconfig.json
    // 4. 生成入口文件（index.ts）
    // 5. 为每个 tool 生成独立的 handler 文件
    // 6. 生成 README.md
    throw new Error('Not implemented yet — 将在 Step 6 实现');
  }

  /**
   * 生成单个 tool 的 handler 文件内容
   * @param tool - MCP tool 定义
   * @param operation - 对应的 OpenAPI operation
   * @returns TypeScript 文件内容
   */
  private generateToolHandler(_tool: ToolDefinition, _operation: ParsedOperation): string {
    // TODO: Step 6 实现
    throw new Error('Not implemented yet — 将在 Step 6 实现');
  }
}
