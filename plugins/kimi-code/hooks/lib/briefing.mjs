// briefing.mjs — REST 拉取 + 信封 unwrap（P1 实现，计划 §2.4）
// fetch 可注入（fetchImpl 参数，默认 globalThis.fetch）以便测试 mock；
// 超时用 AbortSignal.timeout（node ≥18 内置）。
// 响应信封 {code, message, data}：先 unwrap .data；HTTP 非 2xx 或 code!==200 → 抛 BriefingError（分支④）。
// 铁律 #11：方法/字段/常量 rationale 一律注释。

/** 单次 REST 超时（ms）。manifest timeout 20s 内留足余量；P5 实测点 3 后可调。 */
export const FETCH_TIMEOUT_MS = 8000;

/** 拉取失败统一错误：携带 reason（分支④模板 D 文案用）与 status（日志白名单字段） */
export class BriefingError extends Error {
  /**
   * @param {string} reason 人类可读原因（如 'HTTP 401' / 'timeout' / 'network-error' / 'code 500'）
   * @param {number|null} status HTTP status 或业务 code（日志白名单字段；无则 null）
   */
  constructor(reason, status = null) {
    super(reason);
    this.name = 'BriefingError';
    this.reason = reason;
    this.status = status;
  }
}

/**
 * 拉取我的简报：GET {base}/agents/me/briefing（瘦身参数对齐 SKILL §2.0a）。
 * taskLimit=20：分组化简报需要按 board 分组的任务明细（前 3 标题/组），5 条不够铺满 3 个 board 行；
 * 响应体增量 ≈ items 12 字段投影 ×20 ≈ 几 KB，8s 超时内无压力（plan §7）。
 * @param {string} base apiBaseUrl（resolveApiBase 结果，已过 scheme 白名单）
 * @param {string} key API key（X-API-Key header）
 * @param {object} [opts] { fetchImpl, timeoutMs } 可注入便于测试
 * @returns {Promise<{name: string, activeTasksTotal: number, activeItems: Array<object>, unreadTotal: number, unreadCounts: Array<object>}>}
 *   name=me.name；activeTasksTotal=activeTasks.total；activeItems=activeTasks.items 原样透传（分组/排序收归 format 层）；
 *   unreadTotal=unreadCounts 的 unreadCount 求和（unreadCounts 仅含未读>0 的 topic，逐项累加即未读 M）；
 *   unreadCounts 原样透传（服务端已按 unreadCount DESC 排序，≤50 条）。
 *   数组字段防御性默认空数组（服务端缺字段不炸 format 层）。
 */
export async function fetchBriefing(base, key, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = `${stripTrailingSlash(base)}/agents/me/briefing?statuses=todo,in_progress&taskLimit=20&activityLimit=3&maxContentLength=160`;
  const data = await requestJson(url, key, fetchImpl, timeoutMs);
  return {
    name: data?.me?.name ?? 'unknown',
    activeTasksTotal: Number(data?.activeTasks?.total ?? 0),
    activeItems: Array.isArray(data?.activeTasks?.items) ? data.activeTasks.items : [],
    unreadTotal: sumUnread(data?.unreadCounts),
    unreadCounts: Array.isArray(data?.unreadCounts) ? data.unreadCounts : [],
  };
}

/**
 * 拉取 board digest：GET {base}/boards/{boardId}/digest（瘦身参数：openLimit=3 其余 0，includeDescription=false）。
 * @param {string} base apiBaseUrl
 * @param {string} boardId 绑定文件中的 boardId
 * @param {string} key API key
 * @param {object} [opts] { fetchImpl, timeoutMs } 可注入便于测试
 * @returns {Promise<{boardName: string, nextUp: Array<{title: string}>}>}
 *   nextUp 为原始数组（服务端 openLimit=3 保证 ≤3 条；客户端防御性截断在 format 层）
 */
export async function fetchDigest(base, boardId, key, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = `${stripTrailingSlash(base)}/boards/${encodeURIComponent(boardId)}/digest?openLimit=3&doneLimit=0&riskLimit=0&docsLimit=0&versionLimit=0&includeDescription=false`;
  const data = await requestJson(url, key, fetchImpl, timeoutMs);
  return {
    boardName: data?.boardName ?? '',
    nextUp: Array.isArray(data?.nextUp) ? data.nextUp : [],
  };
}

/**
 * 公共请求：fetch + 信封校验 + 错误包装。
 * 超时（AbortSignal.timeout 抛 TimeoutError/AbortError）与网络错误（TypeError）统一转 BriefingError，
 * 由调用方（session-start）走分支④。
 */
async function requestJson(url, key, fetchImpl, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'X-API-Key': key },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new BriefingError(isTimeout ? 'timeout' : 'network-error', null);
  }
  if (!res.ok) {
    // 非 2xx（401/404/5xx…）→ 分支④；status 进日志白名单
    throw new BriefingError(`HTTP ${res.status}`, res.status);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new BriefingError('invalid-json-response', null);
  }
  if (body?.code !== 200) {
    // 信封 code!==200（业务错误）→ 分支④
    throw new BriefingError(`code ${body?.code ?? 'unknown'}`, body?.code ?? null);
  }
  return body?.data ?? {};
}

/** 未读求和：unreadCounts 仅含未读>0 的 topic，逐项累加 */
function sumUnread(unreadCounts) {
  if (!Array.isArray(unreadCounts)) return 0;
  return unreadCounts.reduce((sum, t) => sum + (Number(t?.unreadCount) || 0), 0);
}

/** 去尾斜杠（base 可能以 / 结尾，防御性处理） */
function stripTrailingSlash(base) {
  return String(base).replace(/\/+$/, '');
}
