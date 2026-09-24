/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - serve 命令启动管线：spec → profile 过滤 → tools 映射 → Express + HttpProxy + McpServer
 *   - 接口调用频率统计的暴露面（surface）解析点：MCP 实例身份 `mcp` / `mcp-full` / `unknown`
 *
 * [代码职责]
 *   - 解析启动参数（spec / 认证 / profile）→ 组装依赖 → 注册 tools → 启动
 *   - `resolveSurface()`：按 `MCP_SURFACE` env > `--surface` > profile 名映射 > `'unknown'`
 *     决定本实例的 surface，并交给 McpServer（进入 ALS 上下文 + 上报载荷）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — surface 词表与合法取名源
 *   - 补充: docs/architecture.md §automcp — 双实例（8745 worker / 8746 full）
 *
 * [关键不变量]
 *   - **surface 的取名源禁用 profile JSON 的 `name` 字段**：那是人类可读标签
 *     （实值如 "Platform Agent (Worker)"），不是实例标识——用它会让全部流量落
 *     `unknown`，而聚合表没有明细可回填。合法源只有：MCP_SURFACE / --surface /
 *     文件名（`--profile <name>` 的字面值，或 `--profile-path` 的 basename 剥 `.json`）
 *   - surface 必须是后端封闭词表内的值（不含 `''`——空串语义是"非 MCP 流量"）。
 *     非法显式输入终局归 `'unknown'`（不回落下一个源）：后端 DTO 是严格制，
 *     发出非法值 = 该行 400 → 计数永久丢失
 *   - profile 文件名按**字面值**映射，不读文件内容（解析因此不依赖 IO）
 *
 * [关联代码]
 *   - cli.ts — `--profile` / `--profile-path` / `--surface` 参数入口（env 由进程提供）
 *   - server/mcp-server.ts — surface 的消费方（ALS 上下文 + 上报载荷）
 *
 * [持久踩坑]
 *   MCP-BODY-1(express.json 默认 100kb 卡死大文档 upsert, 须显式 limit):
 *     2026-08-15 实锤（backlog f4fe0a59）——裸 express.json() 默认 100kb，
 *     113KB 文档 upsert_doc 经 MCP 通道 413；backend main.ts 是 5mb，两侧必须对齐语义。
 *     修复 = 显式 { limit: '10mb' }（本文件 serve 入口唯一 json body 解析点）。
 *   MCP-SURFACE-1(profile name 误用): 拿 profile JSON 的 `name` 当实例标识会全落
 *     unknown，事后不可回填。安全方向: 只用文件名/字面值，单测用仓库真实 profile
 *     文件断言"name 字段与解析结果无关"。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（取名源是否仍不含 profile name）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
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
 * profile 名字面值 → surface 词表映射（D4c）
 *
 * 键 = 部署时实际使用的 profile 文件名（`--profile agent` 或
 * `--profile-path …/agent.json`）；值 = 后端封闭词表内的 surface。
 * 新增 MCP 实例时在此补一行，并同步 systemd 的启动参数。
 */
const PROFILE_SURFACE_MAP = new Map<string, string>([
  ['agent', 'mcp'],
  ['full', 'mcp-full'],
]);

/** automcp 可发出的 surface（后端词表去掉 `''`——空串语义是"非 MCP 流量"） */
const EMITTABLE_SURFACE_VALUES: readonly string[] = ['mcp', 'mcp-full', 'unknown'];

/** 无法判定时的终局 surface（词表内合法值：MCP 但暴露面不明） */
const SURFACE_UNKNOWN = 'unknown';

/**
 * 解析本实例的 MCP 暴露面（D4c）
 *
 * 优先级：`MCP_SURFACE` env > `--surface` > profile 名映射 > `'unknown'`。
 * 前两级是操作者的显式声明；profile 名是兜底推断——取**文件名**而不是 profile JSON
 * 里的 `name` 字段（后者是人类可读标签，实值如 "Platform Agent (Worker)"，
 * 拿它当实例标识会让全量流量落 unknown）。
 *
 * @param options - serve 选项（只读 `surface` / `profile` / `profilePath`）
 * @param env - 环境变量来源（默认 process.env；可注入以便单测）
 * @returns 后端词表内的 surface 值
 */
export function resolveSurface(
  options: Pick<ServeOptions, 'surface' | 'profile' | 'profilePath'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = normalizeExplicitSurface(env.MCP_SURFACE);
  if (fromEnv !== undefined) {
    return fromEnv;
  }

  const fromCli = normalizeExplicitSurface(options.surface);
  if (fromCli !== undefined) {
    return fromCli;
  }

  const profileName = resolveProfileName(options);
  const mapped = profileName === undefined ? undefined : PROFILE_SURFACE_MAP.get(profileName);

  return mapped ?? SURFACE_UNKNOWN;
}

/**
 * 归一化显式声明的 surface（`MCP_SURFACE` env / `--surface`）
 *
 * 非法值（不在词表内）终局归 `'unknown'` 而非回落下一个源：操作者明明写了值，
 * 却被静默替换成另一个源的推断结果，比"归为 unknown"更难排查；且后端 DTO 是严格制，
 * 非法值一旦发出，该行计数直接 400 丢失。
 *
 * @param raw - 原始字符串（可能 undefined / 空白 / 大小写不一）
 * @returns 词表内的值；未提供时返回 undefined（表示"继续看下一个源"）
 */
function normalizeExplicitSurface(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') {
    return undefined;
  }

  return EMITTABLE_SURFACE_VALUES.includes(trimmed) ? trimmed : SURFACE_UNKNOWN;
}

/**
 * 提取 profile 名字面值（surface 推断用）
 *
 * 优先级与 `loadProfileForServe` 一致：`--profile-path` 的 basename（剥 `.json`）
 * 优先于 `--profile` 的字面值。**不读文件内容**——surface 解析因此不依赖 IO。
 *
 * @param options - serve 选项（只读 profile 相关两个字段）
 * @returns 归一化（小写）后的 profile 名；两者都未提供时 undefined
 */
function resolveProfileName(
  options: Pick<ServeOptions, 'profile' | 'profilePath'>,
): string | undefined {
  if (options.profilePath !== undefined && options.profilePath !== '') {
    return path.basename(options.profilePath, '.json').toLowerCase();
  }

  if (options.profile !== undefined && options.profile !== '') {
    return options.profile.toLowerCase();
  }

  return undefined;
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
  // body 上限显式放宽到 10mb（2026-08-15 用户拍板）：express.json() 默认 100kb，
  // 大文档 upsert_doc（如 113KB 的 roundtable-design.md r29）经 MCP 通道被 413
  // PayloadTooLargeError 拒绝（backlog f4fe0a59 实锤）；对齐 backend main.ts 的 5mb 语义并留余量
  app.use(express.json({ limit: '10mb' }));

  const auth = buildAuthConfig(options);
  const proxy = new HttpProxy(options.baseUrl, auth);
  // surface 解析一次后全程不变（D4c）：进 ALS 上下文 → 两头与上报载荷都取自它。
  // 认证显式注入 server：`/mcp` 实例没有 custom tools（不走 registerCustomTools），
  // 不注入则 fallbackAuth 恒 undefined → invocation 上报因无凭据被整片跳过。
  const surface = resolveSurface(options);
  const server = new McpServer(
    app,
    options.port,
    proxy,
    options.basePath,
    options.baseUrl,
    surface,
  );
  server.setFallbackAuth(auth);

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
