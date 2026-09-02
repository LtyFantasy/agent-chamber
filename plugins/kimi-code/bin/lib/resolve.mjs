// resolve.mjs — bin 命令公共件：配置解析 + REST 封装 + 绑定自动推断（plan §3.2）
// 复用 hooks/lib/config.mjs 的纯函数（相对路径 import，不复制代码）：
//   resolveConfig 以 projectDir 逐层向上找绑定/身份文件；resolveKey 取 API key；
//   resolveApiBase 推导 apiBaseUrl 并过 scheme 白名单。
// 铁律 #11：方法/常量 rationale 一律注释。

import os from 'node:os';
import { resolveConfig, resolveKey, resolveApiBase } from '../../hooks/lib/config.mjs';

/** 单次 REST 超时（ms）：与 hooks/lib/briefing.mjs 对齐（8s，同一平台接口量级） */
export const FETCH_TIMEOUT_MS = 8000;

/**
 * 旧后端 mine 判定（评审 A2，已实证）：
 * 全局 ValidationPipe 开 forbidNonWhitelisted（backend main.ts）→ 旧版本后端收到
 * 未声明的 mine 查询参数返回 HTTP 400。故「mine 列表请求收到 400」= mine-unsupported；
 * 与显式 id 路径的 tasks/messages 404（绑定失效，P3）语义不同，必须区分文案。
 * 禁止回退非 mine 列表——open 源会污染唯一性推断（plan §2 关键发现）。
 */
const MINE_UNSUPPORTED_STATUS = 400;

/** 列表页大小：推断唯一性用「拉全量」语义（pageSize=100 一次取尽，≤100 是后端上限） */
const LIST_PAGE_SIZE = 100;

/**
 * REST 请求失败统一错误：携带 reason（人类可读，进输出文案）与 status（HTTP status，
 * 用于 404=绑定失效 / 400=mine-unsupported 的语义分支）。
 * 模式参考 hooks/lib/briefing.mjs 的 BriefingError。
 */
export class ChamberRequestError extends Error {
  /**
   * @param {string} reason 人类可读原因（'HTTP 404' / 'timeout' / 'network-error' / 'code 500'）
   * @param {number|null} status HTTP status 或业务 code；无则 null
   */
  constructor(reason, status = null) {
    super(reason);
    this.name = 'ChamberRequestError';
    this.reason = reason;
    this.status = status;
  }
}

/**
 * 配置解析三步（projectDir → binding → key → apiBase）。
 * cwd 语义：bin 脚本被 agent 经 Bash 调用时 cwd=项目目录（无 hooks 的 cwd 陷阱），
 * 直接 resolveConfig(projectDir) 逐层向上找 .kimi-code/ 即可。
 * @param {string} projectDir 会话项目目录（process.cwd()）
 * @param {object} [opts] { env, homeDir } 可注入便于测试（透传 resolveConfig）
 * @returns {{baseUrl: string, key: string, binding: object|null} | {error: string}}
 *   成功返回 baseUrl/key（binding 供 infer* 读显式 id）；失败返回 error（完整中文文案）
 */
export function resolveContext(projectDir, opts = {}) {
  const { env = process.env, homeDir = os.homedir() } = opts;
  const config = resolveConfig(projectDir, env, homeDir);

  const keyResult = resolveKey(config.binding, config.projectMcp, config.userMcp);
  if (keyResult.status !== 'ok') {
    return { error: keyErrorText(keyResult) };
  }

  const baseResult = resolveApiBase(config.binding, keyResult.serverUrl);
  if (baseResult.status !== 'ok') {
    return { error: baseErrorText(baseResult) };
  }

  return { baseUrl: baseResult.baseUrl, key: keyResult.key, binding: config.binding };
}

/** resolveKey 非 ok 状态的文案（与 hooks 模板 A/指针错配口径对齐，面向命令行引导） */
function keyErrorText(keyResult) {
  if (keyResult.status === 'not-configured') {
    return (
      '[agent-chamber] 未检测到接入配置：项目无 .kimi-code/agent-chamber.json（或 mcp.json 未配 chamber server）。\n' +
      '接入三步：① 登录 chamber（无账号找管理员申请，注册是 admin-only）→ Agents 页创建 agent 复制 API key；② 按插件 README「接入 playbook」初始化（MCP 模式/ REST-only 任一）；③ 重启会话生效。'
    );
  }
  // pointer-mismatch / no-key-in-server：指针命中但 server 不可用或无 X-API-Key
  return `[agent-chamber] mcp.json 中找不到 mcpServer 指针「${keyResult.serverName ?? ''}」对应的可用 HTTP server（或其 headers 无 X-API-Key），请检查 .kimi-code/agent-chamber.json 的 mcpServer 与 mcp.json 配置。`;
}

/** resolveApiBase 非 ok 状态的文案（scheme 违例 / 配置不完整 → 引导显式写 apiBaseUrl） */
function baseErrorText(baseResult) {
  if (baseResult.status === 'invalid-mcp-url' || baseResult.status === 'invalid-scheme') {
    return '[agent-chamber] apiBaseUrl 无效（仅允许 https；localhost/127.0.0.1 例外允许 http）。请在 .kimi-code/agent-chamber.json 显式填写 apiBaseUrl。';
  }
  // incomplete：有 key 但无 mcp server url / apiBaseUrl，推导无从谈起
  return '[agent-chamber] 配置不完整：无法推导 API 地址（无 mcp server url 且未显式写 apiBaseUrl）。请在 .kimi-code/agent-chamber.json 显式填写 apiBaseUrl。';
}

/**
 * 公共请求：fetch + 信封校验 + 错误包装（模式参考 briefing.mjs requestJson）。
 * 信封 {code, message, data}：HTTP 非 2xx 或 code!==200 → 抛 ChamberRequestError；
 * 超时（AbortSignal.timeout）与网络错误（TypeError）统一转网络/超时 reason。
 * @param {string} url 完整 REST URL（base 已过 scheme 白名单）
 * @param {string} key API key（X-API-Key header）
 * @param {object} [opts] { fetchImpl, timeoutMs } 可注入便于单测；bin 走真实网络
 * @returns {Promise<object>} 信封 unwrap 后的 data
 */
export async function fetchJson(url, key, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'X-API-Key': key },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ChamberRequestError(isTimeout ? 'timeout' : 'network-error', null);
  }
  if (!res.ok) {
    throw new ChamberRequestError(`HTTP ${res.status}`, res.status);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new ChamberRequestError('invalid-json-response', null);
  }
  if (body?.code !== 200) {
    throw new ChamberRequestError(`code ${body?.code ?? 'unknown'}`, body?.code ?? null);
  }
  return body?.data ?? {};
}

/**
 * 推断绑定 board：显式 id 非空 → 直接使用（trim，不请求列表）；否则 GET {base}/boards?mine=true&pageSize=100，
 * 按结果分支：0 个 → {error:'none'}；恰 1 个 → {id, name, inferred:true}；>1 个 → {error:'ambiguous', candidates}。
 * ⚠️ name 获取：推断路径从列表项拿 name（免二次请求）；显式 id 路径的 name 由调用方经 fetchBoardName 另取。
 * @param {object|null} binding agent-chamber.json（读 boardId；null 视为未填）
 * @param {string} base apiBaseUrl
 * @param {string} key API key
 * @param {object} [opts] { fetchImpl, timeoutMs } 可注入
 * @returns {Promise<object>}
 *   {id, name, inferred:true} | {id, name:null, inferred:false} | {error:'none'} |
 *   {error:'ambiguous', candidates:[{id,name}]} | {error:'mine-unsupported'}
 *   其他请求错误（401/5xx/网络/超时）→ 抛 ChamberRequestError（调用方统一「连接异常」文案）
 */
export async function inferBoardId(binding, base, key, opts = {}) {
  const explicit = binding?.boardId;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { id: explicit.trim(), name: null, inferred: false };
  }
  // M-3：配置了值但不是字符串（如手写数字 123）→ 配置错误，不静默落入推断（否则用户收到歧义/none 文案会误判）
  if (explicit !== undefined && explicit !== null && typeof explicit !== 'string') {
    return { error: 'invalid-config' };
  }
  const data = await fetchInferList(`${stripTrailingSlash(base)}/boards?mine=true&pageSize=${LIST_PAGE_SIZE}`, key, opts);
  return inferFromList(data, 'board');
}

/**
 * 推断绑定 topic：同 inferBoardId，列表为 GET {base}/topics?mine=true&status=active&pageSize=100。
 * status=active 口径：只对活跃（未归档/未关闭）话题做唯一性推断，避免把已结束话题算进候选。
 * @param {object|null} binding agent-chamber.json（读 topicId）
 * @param {string} base apiBaseUrl
 * @param {string} key API key
 * @param {object} [opts] { fetchImpl, timeoutMs } 可注入
 * @returns {Promise<object>} 结构同 inferBoardId（name=title；候选 {id,name}）
 */
export async function inferTopicId(binding, base, key, opts = {}) {
  const explicit = binding?.topicId;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { id: explicit.trim(), name: null, inferred: false };
  }
  // M-3：同 inferBoardId——配置了非字符串值 → 配置错误，不静默落入推断
  if (explicit !== undefined && explicit !== null && typeof explicit !== 'string') {
    return { error: 'invalid-config' };
  }
  const data = await fetchInferList(
    `${stripTrailingSlash(base)}/topics?mine=true&status=active&pageSize=${LIST_PAGE_SIZE}`,
    key,
    opts,
  );
  return inferFromList(data, 'topic');
}

/**
 * mine 列表请求 + A2 降级判定：收到 HTTP 400 → {error:'mine-unsupported'}（旧后端无 mine 参数）。
 * 其他错误原样抛（401/5xx/网络/超时属连接异常，非版本问题）。
 */
async function fetchInferList(url, key, opts) {
  try {
    return await fetchJson(url, key, opts);
  } catch (err) {
    if (err instanceof ChamberRequestError && err.status === MINE_UNSUPPORTED_STATUS) {
      return { __mineUnsupported: true };
    }
    throw err;
  }
}

/**
 * 列表信封 → 推断结果。0 个 → none；1 个 → 命中；>1 个 → ambiguous 候选（≤10，id+name）。
 * @param {object} data fetchJson unwrap 后的列表 data（{items, total, ...}）
 * @param {'board'|'topic'} kind 名称字段取值（board → name；topic → title）
 * @returns {object|null} null = mine-unsupported 哨兵透传；否则推断结果对象
 */
function inferFromList(data, kind) {
  if (data?.__mineUnsupported) return { error: 'mine-unsupported' };
  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0) return { error: 'none' };
  if (items.length === 1) {
    const item = items[0];
    return { id: item?.id, name: displayName(item, kind), inferred: true };
  }
  // >1 个：候选列 id+name（≤10，不猜）；total 取信封全量总数（>100 个时 items 只是第一页，M-1 修订）
  const candidates = items.slice(0, 10).map((item) => ({ id: item?.id, name: displayName(item, kind) }));
  return { error: 'ambiguous', candidates, total: Number(data?.total) || items.length };
}

/** 列表项展示名：board 取 name、topic 取 title；空值兜底 unknown-*（对齐 hooks format 层兜底口径） */
function displayName(item, kind) {
  const raw = kind === 'board' ? item?.name : item?.title;
  return typeof raw === 'string' && raw !== '' ? raw : `unknown-${kind}`;
}

/**
 * 显式 id 路径的 board 名获取：GET {base}/boards/:id。
 * 404 = 绑定的 board 不存在/被删/无权访问 → {error:'binding-invalid'}（P3，与推断歧义文案不混用）；
 * 其他错误抛 ChamberRequestError。
 * @returns {Promise<{name: string} | {error: 'binding-invalid'}>}
 */
export async function fetchBoardName(base, boardId, key, opts = {}) {
  return fetchEntityName(`${stripTrailingSlash(base)}/boards/${encodeURIComponent(boardId)}`, 'name', 'unknown-board', key, opts);
}

/**
 * 显式 id 路径的 topic 标题获取：GET {base}/topics/:id。
 * 注意字段差异：board 详情取 name、topic 详情取 title（TopicDetail 无 name 字段）。
 * 404 → {error:'binding-invalid'}；其他错误抛（同上）。
 * @returns {Promise<{name: string} | {error: 'binding-invalid'}>}
 */
export async function fetchTopicTitle(base, topicId, key, opts = {}) {
  return fetchEntityName(`${stripTrailingSlash(base)}/topics/${encodeURIComponent(topicId)}`, 'title', 'unknown-topic', key, opts);
}

/**
 * 详情名获取共用：single 详情信封取 nameField（'name'|'title'），空值兜底 fallback；
 * 404 转 binding-invalid（与推断歧义文案不混用，P3）。
 */
async function fetchEntityName(url, nameField, fallback, key, opts) {
  try {
    const data = await fetchJson(url, key, opts);
    const name = typeof data?.[nameField] === 'string' && data[nameField] !== '' ? data[nameField] : fallback;
    return { name };
  } catch (err) {
    if (err instanceof ChamberRequestError && err.status === 404) {
      return { error: 'binding-invalid' };
    }
    throw err;
  }
}

/** 去尾斜杠（base 可能以 / 结尾，防御性处理；与 briefing.mjs stripTrailingSlash 同实现） */
function stripTrailingSlash(base) {
  return String(base).replace(/\/+$/, '');
}
