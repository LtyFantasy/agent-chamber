// config.mjs — 配置解析 + 取值优先级（P1 实现，计划 §2.2/§2.3）
// 纯函数模块：不读进程 cwd、不写日志，全部输入显式传入（可测）。
// 铁律 #11：字段/方法/常量 rationale 一律注释。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 惯例名回退链（§2.2.3）：mcpServer 缺失时依次尝试的 server 名 */
export const CONVENTIONAL_NAMES = ['chamber', 'platform', 'agent-chamber'];

/**
 * 从 projectDir 逐层向上查找 .kimi-code/ 下的文件（openviking find_project_config 同款模式）。
 * 为什么向上查找：项目可能嵌套在 monorepo 子目录/子模块中，绑定与身份文件在项目根。
 * @param {string} projectDir 会话项目目录（payload.cwd；绝不用进程 cwd——插件 hooks 运行时 cwd=插件根，官方-plugins）
 * @param {string} relPath 相对 .kimi-code/ 的文件名，如 'agent-chamber.json'
 * @returns {string|null} 找到的绝对路径；未找到返回 null
 */
export function findUpward(projectDir, relPath) {
  if (!projectDir) return null;
  let dir = path.resolve(projectDir);
  for (;;) {
    const candidate = path.join(dir, relPath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // 已到 fs 根，停止
    dir = parent;
  }
}

/**
 * 读取并解析 JSON 文件。
 * @param {string} filePath
 * @returns {object|null} 解析结果；文件不存在或 JSON 畸形返回 null
 *   （fail-open：损坏配置按不存在处理；调用方据 path 是否非空区分「损坏」与「缺失」并记日志）
 */
export function loadJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 解析全部配置输入：绑定文件（向上查找）+ 项目级/用户级身份文件。
 * @param {string} projectDir 会话项目目录
 * @param {object} [env] 环境变量（KIMI_CODE_HOME），可注入便于测试；默认 process.env
 * @param {string} [homeDir] 用户主目录，可注入便于测试；默认 os.homedir()
 * @returns {{binding: object|null, bindingPath: string|null, projectMcp: object|null, projectMcpPath: string|null, userMcp: object|null, userMcpPath: string|null}}
 */
export function resolveConfig(projectDir, env = process.env, homeDir = os.homedir()) {
  const bindingPath = findUpward(projectDir, '.kimi-code/agent-chamber.json');
  const projectMcpPath = findUpward(projectDir, '.kimi-code/mcp.json');
  const userMcpPath = resolveUserMcpPath(env, homeDir);
  return {
    binding: bindingPath ? loadJsonFile(bindingPath) : null,
    bindingPath,
    projectMcp: projectMcpPath ? loadJsonFile(projectMcpPath) : null,
    projectMcpPath,
    userMcp: userMcpPath ? loadJsonFile(userMcpPath) : null,
    userMcpPath,
  };
}

/**
 * 用户级身份文件路径：$KIMI_CODE_HOME/mcp.json || ~/.kimi-code/mcp.json。
 * 插件 hooks 官方保证携带 KIMI_CODE_HOME env；缺省回退 ~/.kimi-code（A4 路径统一）。
 */
function resolveUserMcpPath(env, homeDir) {
  const home = env.KIMI_CODE_HOME || (homeDir ? path.join(homeDir, '.kimi-code') : null);
  return home ? path.join(home, 'mcp.json') : null;
}

/**
 * 四步优先级取 key（§2.3 逐字）：
 *   1. binding.apiKey 非空 → 直接用（REST-only 主路 / 显式覆盖）
 *   2. binding.mcpServer 指针 → 项目 mcp → 用户 mcp 次序找同名 server，取 headers["X-API-Key"]
 *   3. 惯例名 chamber/platform/agent-chamber 依次；全不中且合并后【恰一个】HTTP server → 直用
 *   4. 全不中 → status 'not-configured'（分支①）
 * A4 三边界：
 *   - bearerTokenEnvVar 不支持：平台 Bearer 通道只收 JWT（jwt-or-api-key.guard.ts），
 *     API key 必须走 X-API-Key header → 取 key 只看 headers["X-API-Key"]
 *   - 惯例名回退与单 HTTP 判定均跳过 enabled:false 的 server（官方 mcp.json 禁用语义）
 *   - 指针错配（server 名找不到/非 HTTP/被禁用）与完全未配置用 status 区分（分支④ vs 分支①）
 * @param {object|null} binding agent-chamber.json 解析结果
 * @param {object|null} projectMcp 项目级 mcp.json
 * @param {object|null} userMcp 用户级 mcp.json
 * @returns {{key: string|null, status: string, source: string|null, serverName: string|null, serverUrl: string|null}}
 *   status: 'ok' | 'not-configured' | 'pointer-mismatch' | 'no-key-in-server'
 */
export function resolveKey(binding, projectMcp, userMcp) {
  // ① 显式 apiKey（REST-only 主路 / 显式覆盖）
  const apiKey = binding?.apiKey;
  if (typeof apiKey === 'string' && apiKey.trim() !== '') {
    return { key: apiKey.trim(), status: 'ok', source: 'binding.apiKey', serverName: null, serverUrl: null };
  }

  // ② 显式 mcpServer 指针
  const pointer = binding?.mcpServer;
  if (typeof pointer === 'string' && pointer.trim() !== '') {
    const name = pointer.trim();
    const server = findServer(projectMcp, name) ?? findServer(userMcp, name);
    if (!server || !isHttpServer(server) || server.enabled === false) {
      // 指针错配：server 不存在 / 非 HTTP（stdio 等）/ 被禁用 → 分支④（A4：与完全未配置区分文案）
      return { key: null, status: 'pointer-mismatch', source: null, serverName: name, serverUrl: null };
    }
    const key = getApiKeyFromServer(server);
    if (!key) {
      // 指针命中但 headers 无 X-API-Key → 分支④
      return { key: null, status: 'no-key-in-server', source: null, serverName: name, serverUrl: null };
    }
    return { key, status: 'ok', source: 'mcp.pointer', serverName: name, serverUrl: server.url };
  }

  // ③ 惯例名回退（合并后项目级覆盖用户级同名）
  const merged = mergeMcp(projectMcp, userMcp);
  for (const name of CONVENTIONAL_NAMES) {
    const server = merged[name];
    if (server && isHttpServer(server) && server.enabled !== false) {
      const key = getApiKeyFromServer(server);
      if (key) {
        return { key, status: 'ok', source: 'mcp.convention', serverName: name, serverUrl: server.url };
      }
    }
  }
  // 惯例名全不中：合并后【恰一个】HTTP server → 直接用它（§2.2.3）
  const httpServers = Object.entries(merged).filter(([, s]) => isHttpServer(s) && s.enabled !== false);
  if (httpServers.length === 1) {
    const [name, server] = httpServers[0];
    const key = getApiKeyFromServer(server);
    if (key) {
      return { key, status: 'ok', source: 'mcp.single-http', serverName: name, serverUrl: server.url };
    }
  }

  // ④ 全不中 → 分支①（未接入）
  return { key: null, status: 'not-configured', source: null, serverName: null, serverUrl: null };
}

/**
 * 推导 apiBaseUrl（§2.3）：
 *   1. binding.apiBaseUrl 显式 → 用
 *   2. 否则 mcpServerUrl 去尾 /mcp 或 /mcp-full → 拼 /api/v1
 *      ⚠️ 局限（R8）：自建 automcp 端口与 REST 端口不同（如 8745 vs 8743）时推导必错
 *      → playbook 建议「apiBaseUrl 恒显式写」，推导仅作兜底
 *   3. 无 mcpServerUrl 且无 apiBaseUrl → 配置不完整（分支④）
 * S6：最终值过 scheme 白名单——仅 https；localhost/127.0.0.1 例外允许 http；违例 → 分支④
 * @param {object|null} binding agent-chamber.json 解析结果
 * @param {string|null} mcpServerUrl 命中的 server 的 url（resolveKey 返回的 serverUrl）
 * @returns {{baseUrl: string|null, status: string, derived: boolean}}
 *   status: 'ok' | 'incomplete' | 'invalid-scheme' | 'invalid-mcp-url'
 */
export function resolveApiBase(binding, mcpServerUrl) {
  let candidate = null;
  let derived = false;
  const explicit = binding?.apiBaseUrl;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    candidate = explicit.trim();
  } else if (typeof mcpServerUrl === 'string' && mcpServerUrl !== '') {
    try {
      candidate = deriveApiBaseFromMcpUrl(mcpServerUrl);
      derived = true;
    } catch {
      // mcp.json 的 server url 非法（new URL 抛）→ 分支④
      return { baseUrl: null, status: 'invalid-mcp-url', derived: false };
    }
  }
  if (!candidate) {
    // REST-only 无 apiBaseUrl → 配置不完整（分支④）
    return { baseUrl: null, status: 'incomplete', derived: false };
  }
  if (!isAllowedScheme(candidate)) {
    return { baseUrl: null, status: 'invalid-scheme', derived };
  }
  return { baseUrl: candidate, status: 'ok', derived };
}

/** 从 mcp server url 推导 REST base：去尾 /mcp 或 /mcp-full → 拼 /api/v1（只改路径，端口保留——R8 局限所在） */
function deriveApiBaseFromMcpUrl(mcpUrl) {
  const u = new URL(mcpUrl);
  let p = u.pathname;
  if (p.endsWith('/mcp-full')) p = p.slice(0, -'/mcp-full'.length);
  else if (p.endsWith('/mcp')) p = p.slice(0, -'/mcp'.length);
  if (p.endsWith('/')) p = p.slice(0, -1);
  u.pathname = `${p}/api/v1`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** S6 scheme 白名单：仅 https；localhost/127.0.0.1 例外允许 http；非法 URL 一律拒绝 */
function isAllowedScheme(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  return false;
}

/** 在单个 mcp.json 中按名找 server；mcp 缺失/畸形返回 null */
function findServer(mcp, name) {
  return mcp?.mcpServers?.[name] ?? null;
}

/** 合并项目级+用户级 mcpServers（同名项目级覆盖用户级，官方 mcp.json 语义） */
function mergeMcp(projectMcp, userMcp) {
  const merged = {};
  if (userMcp?.mcpServers && typeof userMcp.mcpServers === 'object') {
    Object.assign(merged, userMcp.mcpServers);
  }
  if (projectMcp?.mcpServers && typeof projectMcp.mcpServers === 'object') {
    Object.assign(merged, projectMcp.mcpServers);
  }
  return merged;
}

/**
 * HTTP server 判定：有 url 字段且非 SSE（transport !== 'sse'）。
 * stdio server（command 字段、无 url）不算 HTTP——指针指向 stdio server 视为不命中。
 */
function isHttpServer(server) {
  return (
    server != null &&
    typeof server === 'object' &&
    typeof server.url === 'string' &&
    server.url !== '' &&
    server.transport !== 'sse'
  );
}

/**
 * 从 server 取 API key：只认 headers["X-API-Key"]。
 * bearerTokenEnvVar 不支持（A4 边界 1）：平台 Bearer 通道只收 JWT，API key 必须走 X-API-Key header。
 */
function getApiKeyFromServer(server) {
  const h = server?.headers;
  if (h && typeof h === 'object' && typeof h['X-API-Key'] === 'string' && h['X-API-Key'].trim() !== '') {
    return h['X-API-Key'].trim();
  }
  return null;
}
