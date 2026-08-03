/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plans/miss-martian-polaris-superboy.md §Step 6
 *   - 补充: .kimi/plan-mcp-phase2.md §2 (custom tools 扩展点)
 *   - 补充: .kimi/plans/miss-martian-polaris-superboy.md §运行模式
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

import express from 'express';
import path from 'path';
import type { Application } from 'express';
import { OpenApiParser } from './parser/openapi-parser';
import { ToolMapper } from './mapper/tool-mapper';
import { McpServer } from './server/mcp-server';
import { HttpProxy } from './proxy/http-proxy';
import { loadProfile, resolveProfilePath } from './profile/profile-loader';
import type {
  ServeOptions,
  AuthConfig,
  ToolFilterOptions,
  ToolProfile,
  CustomToolsModule,
} from './types';

/**
 * Serve 命令执行结果
 */
export interface ServeResult {
  /** 服务器访问 URL */
  url: string;
  /** 注册的 tool 数量 */
  toolCount: number;
  /** Express 应用实例（供测试使用） */
  app: Application;
  /** 停止服务器的回调 */
  stop: () => Promise<void>;
}

/**
 * 执行 serve 命令的完整 pipeline
 *
 * 1. 解析 OpenAPI spec
 * 2. 映射为 MCP tools（应用过滤规则）
 * 3. 创建 Express app + HTTP Proxy + MCP Server
 * 4. 注册 tools 并启动服务器
 *
 * @param options - CLI serve 选项（已解析并转换类型）
 * @returns 服务器启动结果
 * @throws 当 spec 解析失败、base-url 无效或端口冲突时抛出错误
 */
export async function runServe(options: ServeOptions): Promise<ServeResult> {
  // ─── 1. 解析 spec ───
  const parser = new OpenApiParser(options.spec);
  const operations = await parser.parse();

  // ─── 2. 加载 profile 并构建过滤选项 ───
  const profile = await loadProfileForServe(options);
  const filter = buildFilterOptions(options, profile);

  // ─── 3. 映射 tools ───
  const mapper = new ToolMapper();
  const mappings = mapper.mapAll(operations, filter);

  // ─── 4. 创建依赖 ───
  const app = express();
  app.use(express.json());

  const auth = buildAuthConfig(options);
  const proxy = new HttpProxy(options.baseUrl, auth);
  const server = new McpServer(app, options.port, proxy, options.basePath, options.baseUrl);

  // ─── 5. 注册并启动 ───
  server.registerTools(mappings);

  // ─── 6. 加载 custom tools（可选）───
  let customToolCount = 0;
  if (options.customTools !== undefined && options.customTools !== '') {
    const module = await loadCustomToolsModule(options.customTools);
    server.registerCustomTools(module.customTools, auth);
    customToolCount = module.customTools.length;
  }

  const url = await server.start();

  // custom tools 计入总数，日志分行打印以区分来源
  const toolCount = mappings.length + customToolCount;

  return {
    url,
    toolCount,
    app,
    stop: () => server.stop(),
  };
}

/**
 * 根据 serve 选项加载 profile
 *
 * 优先级：--profile-path > --profile。两者都未提供时返回 undefined。
 */
async function loadProfileForServe(options: ServeOptions): Promise<ToolProfile | undefined> {
  if (options.profilePath) {
    return loadProfile(options.profilePath);
  }

  if (options.profile) {
    const resolved = resolveProfilePath(options.profile);
    return loadProfile(resolved);
  }

  return undefined;
}

/**
 * 从 ServeOptions 与 profile 构建 ToolFilterOptions
 *
 * 合并规则：
 * - tags：CLI 显式传入则优先，否则使用 profile.tags
 * - include：CLI 显式传入则优先，否则使用 profile.include
 * - exclude：CLI 与 profile 的 exclude 取并集（两者都能排除更多 tools）
 *
 * 仅当最终 tags / include / exclude 任一存在时才返回 filter 对象。
 */
function buildFilterOptions(
  options: ServeOptions,
  profile?: ToolProfile,
): ToolFilterOptions | undefined {
  const tags = options.tags ?? profile?.tags;
  const include = options.include ?? profile?.include;

  const cliExclude = options.exclude ?? [];
  const profileExclude = profile?.exclude ?? [];
  const exclude =
    cliExclude.length > 0 || profileExclude.length > 0
      ? [...new Set([...profileExclude, ...cliExclude])]
      : undefined;

  if (
    tags === undefined &&
    include === undefined &&
    (exclude === undefined || exclude.length === 0)
  ) {
    return undefined;
  }

  return {
    tags,
    include,
    exclude,
  };
}

/**
 * 从 ServeOptions 构建 AuthConfig
 *
 * 优先级：apiKey > bearerToken。两者皆无时返回 undefined。
 */
function buildAuthConfig(options: ServeOptions): AuthConfig | undefined {
  if (options.apiKey !== undefined && options.apiKey !== '') {
    return { type: 'apiKey', apiKey: options.apiKey };
  }

  if (options.bearerToken !== undefined && options.bearerToken !== '') {
    return { type: 'bearer', bearerToken: options.bearerToken };
  }

  return undefined;
}

/**
 * 动态加载 custom tools 模块并校验导出形状
 *
 * 相对路径按 process.cwd() resolve。校验规则：
 * - 模块须导出 `customTools` 数组
 * - 数组每项须包含 `tool.name`、`tool.inputSchema`、`handler`（函数）
 *
 * @param modulePath - 模块文件绝对/相对路径或包名
 * @returns 校验通过的 CustomToolsModule
 * @throws 模块不存在、导出形状非法时抛出明确错误
 */
async function loadCustomToolsModule(modulePath: string): Promise<CustomToolsModule> {
  // 相对路径按 process.cwd() resolve
  const resolvedPath = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(process.cwd(), modulePath);

  let raw: unknown;
  try {
    raw = await import(resolvedPath);
  } catch (importError) {
    const message = importError instanceof Error ? importError.message : String(importError);
    throw new Error(`Failed to load custom tools module "${resolvedPath}": ${message}`);
  }

  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Custom tools module "${resolvedPath}" must export an object`);
  }

  const mod = raw as Record<string, unknown>;

  if (!Array.isArray(mod.customTools)) {
    throw new Error(`Custom tools module "${resolvedPath}" must export "customTools" as an array`);
  }

  const tools = mod.customTools as unknown[];

  for (let i = 0; i < tools.length; i++) {
    const item = tools[i] as Record<string, unknown> | null | undefined;
    if (item === null || typeof item !== 'object') {
      throw new Error(`customTools[${i}] in module "${resolvedPath}" must be an object`);
    }

    const tool = item.tool as Record<string, unknown> | undefined;
    if (tool === undefined || tool === null || typeof tool !== 'object') {
      throw new Error(`customTools[${i}] in module "${resolvedPath}" is missing "tool" definition`);
    }

    if (typeof tool.name !== 'string' || tool.name === '') {
      throw new Error(
        `customTools[${i}] in module "${resolvedPath}" must have a non-empty "tool.name"`,
      );
    }

    if (tool.inputSchema === undefined || tool.inputSchema === null) {
      throw new Error(
        `customTools[${i}] "${String(tool.name)}" in module "${resolvedPath}" is missing "tool.inputSchema"`,
      );
    }

    if (typeof item.handler !== 'function') {
      throw new Error(
        `customTools[${i}] "${String(tool.name)}" in module "${resolvedPath}" must have a "handler" function`,
      );
    }
  }

  return mod as unknown as CustomToolsModule;
}
