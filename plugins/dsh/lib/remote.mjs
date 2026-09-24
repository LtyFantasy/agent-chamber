// remote.mjs — dsh 插件 node 半面 Typert Remote namespace 'chamber'（批 1；plan §2 架构 / §3 数据契约 /
// §5 技术要点逐字规格）。唯一方法 getPanelState：浏览器 30s 轮询的只读聚合面（boards × 五态活跃任务）。
//
// 【方法签名硬约束（gateway SRC 回退实证，dsh-api-gateway/lib/index.js methodParameterNames）】
//   无 codegen 时 gateway 按 Function.prototype.toString 源码解析参数名：
//   - Remote 方法参数必须是无重复的纯标识符——禁解构 / 默认值 / rest（违例 → gateway/signature-invalid）；
//   - 取消参数必须命名为 signal 且位于末位（不在末位 → gateway/signature-invalid）；
//   - 本文件所在 lib/ 目录禁止入任何压缩/打包管线（minify 改写参数名 = 直接摧毁 SRC 解析）。
// 【错误契约】业务错误一律 throw new RemoteError(code, message, details)（typed 契约，architect-m4）；
//   出口纯 JSON 自律——gateway 不校验返回值，host 侧自行 assertJsonValue（architect-m3：非 JSON 出口转 RemoteError）。
// 【跨包 import 铁律（v1.2.1 §2 + 批 0 spike）】@deepseek-ai/dsh-typert-protocol 只能经
//   createRequire(realpathSync(process.argv[1])) 锚定 dsh bin 软链真实路径后动态 import
//   （realpath 前 MODULE_NOT_FOUND 已实证）；禁止顶层静态跨包 import。
// 【故障隔离】setupChamberRemote 任何失败只降级日志 '[agent-chamber] remote=unavailable:<reason>'，零 throw。
// 【定时器纪律】本模块无定时需求——TTL 惰性过期（调用时判定），不需要 ctx.interval()；
//   若未来加主动刷新定时器，一律 ctx.interval() 或 ctx.effect 包裹清理，禁裸 setInterval（fiber 泄漏红线）。
// 铁律 #11：常量/字段/方法 rationale 一律注释。
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ———————————————————————————— 常量（rationale 逐条注释） ————————————————————————————

/** Remote namespace 名：浏览器侧 remote.chamber.getPanelState() 的寻址键（plan §3 写死） */
export const REMOTE_NAMESPACE = 'chamber';

/**
 * 绑定文件惯例路径（相对项目根，向上查找）= 跨 harness 中立目录 .agent-chamber/。
 * 2026-09-18 用户拍板一刀切迁移（无兜底、无兼容层）：agent-chamber 是开源跨 harness 项目，
 * 不寄生任一 harness 的私有项目目录（dsh 实证其项目级只认中性 AGENTS.md/CLAUDE.md）；
 * 旧路径（harness 私有的 `.kimi-code/` 目录下同名文件）的迁移 = 用户手工 mv，插件不做双读。
 * 与 kimi-code hooks 共享同一绑定单源（plan §2「设计胜利勿拆」）——注意共享的是【文件】
 * 而非解析代码：远端只需要 apiBaseUrl/apiKey 两字段，本地小解析避免对兄弟包 hooks/lib 的跨包动态依赖。
 */
export const BINDING_REL_PATH = '.agent-chamber/agent-chamber.json';

/** 单路 REST 超时（ms）：与 kimi-code session-start.mjs 同值（8s 实测够跨网段） */
export const FETCH_TIMEOUT_MS = 8000;

/** 面板结果进程内缓存 TTL（ms）：浏览器轮询 30s，60s TTL 保证多 tab 共享一击（plan §2 single-flight+TTL） */
export const CACHE_TTL_MS = 60_000;

/** 部分失败（partial）结果 TTL（ms）：缩至 5s 快速重试，不让单 board 抖动冻结整面板一分钟（architect-M4） */
export const PARTIAL_CACHE_TTL_MS = 5_000;

/** boards 列表分页大小（已实证信封 {code,data:{items}}；面板场景 board 数远小于 50，单页够） */
export const BOARD_PAGE_SIZE = 50;

/** tasks 单 board 分页大小（活跃五态单 board 上限内；pageSize 上限 100 见 task.controller.ts 校验） */
export const TASK_PAGE_SIZE = 100;

/** 活跃五态过滤（plan §1/§3 写死；done 不进面板——目标态不是告警态） */
export const ACTIVE_STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'review'];

/** 组内排序权重（plan §3 行动优先：review > blocked > in_progress > todo > backlog；未知态排最后） */
export const STATUS_RANK = { review: 0, blocked: 1, in_progress: 2, todo: 3, backlog: 4 };

/** 未知/缺失 status 的排序权重：排在 backlog 之后（防御性——枚举外的态不应插队行动信号之前） */
const UNKNOWN_STATUS_RANK = 5;

// ———————————————————————————— 错误类型 ————————————————————————————

/**
 * REST 层失败统一错误（抄 kimi-code hooks/lib/briefing.mjs BriefingError 范式）。
 * @param reason 机器可读原因词表：timeout | aborted | network-error | http-<status> | code-<n> | invalid-json-response
 * @param status HTTP status 或信封业务 code（无则 null）；401 判定只看本字段
 */
class FetchError extends Error {
  constructor(reason, status = null) {
    super(reason);
    this.name = 'FetchError';
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Provider 层业务错误：携带 RemoteError 三件套语义（code/message/details），但本类不依赖
 * typert-protocol——provider 保持协议无关可单测；服务边界（defineChamberService）负责把它
 * 翻译成真实 RemoteError 上 wire（protocol 不可用的测试环境也能断言 code）。
 */
export class PanelError extends Error {
  /**
   * @param {string} code 稳定错误码（当前词表：unreachable | internal）
   * @param {string} message 人类可读诊断
   * @param {object} [details] 结构化负载（必须可 JSON 序列化——要上 wire）
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'PanelError';
    this.code = code;
    this.details = details;
  }
}

// ———————————————————————————— 绑定解析（抄 plugins/kimi-code/hooks/lib/config.mjs 风格） ————————————————————————————

/**
 * 从 startDir 逐层向上查找相对路径文件（openviking/kimi-code 同款模式）。
 * 为什么向上查找：项目可能嵌套在 monorepo 子目录，绑定文件在项目根。
 * @param {string} startDir 起始目录（生产 = process.cwd()；dsh 宿主进程从项目根启动的既定假设）
 * @param {string} relPath 相对路径（如 '.agent-chamber/agent-chamber.json'）
 * @returns {string|null} 命中绝对路径；未命中 null
 */
export function findUpward(startDir, relPath) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, relPath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // 已到 fs 根，停止
    dir = parent;
  }
}

/** apiBaseUrl scheme 白名单（抄 config.mjs S6）：仅 https；localhost/127.0.0.1 例外允许 http——key 绝不走明文外网 */
function isAllowedApiBase(url) {
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

/** 去尾斜杠（apiBaseUrl 可能以 / 结尾，防御性处理） */
function stripTrailingSlash(base) {
  return String(base).replace(/\/+$/, '');
}

/** 平台 API 固定前缀（推导 web 基座时剥除的尾段；与后端 app.config API_PREFIX 同值） */
const API_BASE_SUFFIX = '/api/v1';

/**
 * web 基座推导（任务深链 host 侧计算——「host 算、browser 哑」与 isMine 同款哲学，panel 零配置感知）。
 * 优先级：① 显式 webBaseUrl（API 与 web 不同域的部署，如本地 dev web:8742 vs api:8743、反代拆域）；
 * ② apiBaseUrl 剥尾段 /api/v1（同域标准部署，开源用户零新增配置即跳对自己的实例）；
 * ③ apiBaseUrl 非标准尾段时退到 origin（协议+主机+端口）——确定性兜底，奇异路径用 ① 覆盖。
 * @param {{apiBaseUrl: string, webBaseUrl?: string}} binding 归一化后的绑定（resolveBinding 产物）
 * @returns {string} web 基座 URL（无尾斜杠）
 */
export function deriveWebBaseUrl(binding) {
  const explicit = typeof binding.webBaseUrl === 'string' ? binding.webBaseUrl.trim() : '';
  if (explicit !== '') return stripTrailingSlash(explicit); // scheme 合法性已在 resolveBinding 校验
  const base = binding.apiBaseUrl; // 已归一（trim + 无尾斜杠）
  if (base.endsWith(API_BASE_SUFFIX)) return base.slice(0, -API_BASE_SUFFIX.length);
  try {
    return new URL(base).origin;
  } catch {
    return base; // resolveBinding 已保证合法 URL，本分支理论不可达，防御兜底
  }
}

/**
 * 解析绑定文件：向上查找 + JSON 解析 + 最小字段校验 + scheme 白名单。
 * 每次抓取现场解析（不缓存）——绑定文件可能后落地/换 key，下一次 TTL 未命中即生效。
 * fail-open：文件缺失 / JSON 损坏 / 必填字段缺失 / scheme 违例 一律返回 null（调用方映射 bound:false/unbound），
 * 与 kimi-code hooks「损坏按不存在处理」同款语义。可选键 webBaseUrl 单向降级：值非法只丢该键
 * （深链基座回落 apiBaseUrl 推导），不拖垮整个绑定。
 * @param {string} cwd 查找起点目录
 * @returns {{apiBaseUrl: string, apiKey: string, webBaseUrl?: string, boardId?: string, docSpaceId?: string, topicId?: string}|null}
 */
export function resolveBinding(cwd) {
  const filePath = findUpward(cwd, BINDING_REL_PATH);
  if (!filePath) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null; // 损坏按未绑定处理
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const apiBaseUrl = typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl.trim() : '';
  const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
  if (apiBaseUrl === '' || apiKey === '') return null;
  if (!isAllowedApiBase(apiBaseUrl)) return null;
  // 可选 webBaseUrl：web 控制台与 API 不同域时的深链基座显式覆盖（见 deriveWebBaseUrl）。
  // 校验与 apiBaseUrl 同白名单（https / localhost http）；非法值归一为 undefined = 未配置。
  const webBaseUrlRaw = typeof parsed.webBaseUrl === 'string' ? parsed.webBaseUrl.trim() : '';
  const webBaseUrl = webBaseUrlRaw !== '' && isAllowedApiBase(webBaseUrlRaw) ? stripTrailingSlash(webBaseUrlRaw) : undefined;
  return { ...parsed, apiBaseUrl: stripTrailingSlash(apiBaseUrl), apiKey, webBaseUrl };
}

// ———————————————————————————— REST 层 ————————————————————————————

/**
 * 合并调用方 signal 与单路超时（plan §2：每路 8s 超时，与入参 signal 合并）。
 * AbortSignal.any 需 Node ≥20.3（dsh 运行时 Node 22 满足）；旧运行时走手动中继兜底——
 * 任一信号触发即 abort 合并信号，once 监听防泄漏。
 * @param {AbortSignal|undefined} signal 入参取消信号（gateway 末位注入）
 * @param {number} timeoutMs 超时预算
 * @returns {AbortSignal}
 */
export function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const ac = new AbortController();
  const relay = (s) => {
    if (s.aborted) ac.abort(s.reason);
    else s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  };
  relay(signal);
  relay(timeout);
  return ac.signal;
}

/**
 * 公共请求：fetch + 信封校验 + 错误包装（抄 briefing.mjs requestJson 范式）。
 * 响应信封 {code,message,data}：HTTP 非 2xx → http-<status>；JSON 畸形 → invalid-json-response；
 * 信封 code!==200 → code-<n>；超时/中止/网络错误按 name 分流（TimeoutError 先于 AbortError 判定，
 * 因为 AbortSignal.timeout 触发的 abort 在 undici 里表现为 TimeoutError）。
 * @returns {Promise<object>} 信封 .data（缺省 {}）
 */
async function requestJson(fetchImpl, url, key, signal, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'X-API-Key': key },
      signal: combineSignals(signal, timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'AbortError' ? 'aborted' : 'network-error';
    throw new FetchError(reason, null);
  }
  if (!res.ok) throw new FetchError(`http-${res.status}`, res.status);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new FetchError('invalid-json-response', null);
  }
  if (body?.code !== 200) {
    throw new FetchError(`code-${body?.code ?? 'unknown'}`, typeof body?.code === 'number' ? body.code : null);
  }
  return body?.data ?? {};
}

/** 任务列表 URL（已实证形状：boardId + 逗号多值 status + pageSize；boardId 过 encodeURIComponent） */
function tasksUrl(base, boardId) {
  return `${base}/tasks?boardId=${encodeURIComponent(boardId)}&status=${ACTIVE_STATUSES.join(',')}&pageSize=${TASK_PAGE_SIZE}`;
}

// ———————————————————————————— 数据映射与排序 ————————————————————————————

/** isMine 判定（plan §3 PM-M1）：assigneeName 与简报身份名 trim + 大小写不敏感相等；任一侧空 → false */
function isMineTask(assigneeName, myName) {
  if (typeof assigneeName !== 'string' || typeof myName !== 'string') return false;
  const a = assigneeName.trim().toLowerCase();
  const b = myName.trim().toLowerCase();
  return a !== '' && a === b;
}

/**
 * 平台 task 原始项 → TaskEntry（plan §3 契约逐字；字段名已实证 task.service.ts findAll 白名单投影）。
 * 防御性 coercion：服务端缺字段不炸面板——字符串字段缺省 ''/null，labels 过滤非字符串项。
 * @param {object} raw 平台 task 项
 * @param {string|null} myName 简报身份名（agents/me 进程期缓存结果）
 * @returns {object} TaskEntry {id,title,status,priority,listName,labels,assigneeName,dueDate,updatedAt,isMine}
 */
export function toTaskEntry(raw, myName) {
  const assigneeName = typeof raw?.assigneeName === 'string' ? raw.assigneeName : null;
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? ''),
    status: String(raw?.status ?? ''),
    priority: raw?.priority ?? null, // 枚举字符串原样透传（平台词汇 p0/p1/p2/p3，已实证）
    listName: typeof raw?.listName === 'string' ? raw.listName : null,
    labels: Array.isArray(raw?.labels) ? raw.labels.filter((l) => typeof l === 'string') : [],
    assigneeName,
    dueDate: raw?.dueDate ?? null, // ISO 字符串或 null，原样透传
    updatedAt: raw?.updatedAt ?? null,
    isMine: isMineTask(assigneeName, myName),
  };
}

/**
 * 组内排序（plan §3 写死）：status 权重升序（review 最前），同态 updatedAt desc。
 * 拷贝排序不 mutate 入参；updatedAt 缺失按空串参与比较（ISO 字符串字典序 = 时间序）。
 */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? UNKNOWN_STATUS_RANK;
    const rb = STATUS_RANK[b.status] ?? UNKNOWN_STATUS_RANK;
    if (ra !== rb) return ra - rb;
    return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
  });
}

/**
 * 出口纯 JSON 防御（architect-m3）：gateway 不校验返回值，非 JSON 出口（circular/BigInt）
 * 在这里就地转 PanelError('internal')，由服务边界再上翻成 RemoteError。
 * JSON.stringify 探测足够：PanelState 由本模块纯量组装，函数/undefined 属构造型不可能。
 */
function assertJsonValue(value) {
  try {
    JSON.stringify(value);
  } catch {
    throw new PanelError('internal', 'panel state is not JSON-serializable');
  }
  return value;
}

/** 归一错误原因短语（日志/RemoteError message 用） */
function errorReasonOf(error) {
  if (error instanceof FetchError) return error.reason;
  return error instanceof Error ? error.message : String(error);
}

// ———————————————————————————— Provider（聚合 + 缓存 + single-flight，协议无关可单测） ————————————————————————————

/**
 * 面板状态提供者工厂。职责三层：
 *   ① 聚合：1 次 /boards + 1 次 /agents/me（进程期缓存）+ N 次 /tasks 并发 Promise.allSettled；
 *   ② 缓存：TTL 60s，partial 结果缩至 5s（architect-M4）；惰性过期（无定时器）；
 *   ③ single-flight：TTL 未命中时并发调用共享同一 in-flight Promise（多 tab 首击不穿透，plan §2）。
 * 协议无关：不 import typert-protocol，错误用 PanelError 携带 code，服务边界负责翻译。
 * @param {object} options
 * @param {() => object|null} options.resolveBinding 绑定解析（每次抓取现场调用，见 resolveBinding 注释）
 * @param {Function} [options.fetchImpl] fetch 实现（缺省 globalThis.fetch；测试注入 mock）
 * @param {() => number} [options.now] 时钟（缺省 Date.now；测试注入假时钟做确定性 TTL 断言）
 * @param {number} [options.ttlMs] 正常 TTL（缺省 60000）
 * @param {number} [options.partialTtlMs] partial TTL（缺省 5000）
 * @param {number} [options.timeoutMs] 单路超时（缺省 8000）
 * @param {object} [options.logger] 日志器（panel=fetch 结构化日志，plan §9 成功判定信号；缺省静默）
 * @returns {{getPanelState: (signal?: AbortSignal) => Promise<object>, bustCache: () => void}}
 */
export function createPanelStateProvider(options) {
  const resolveBindingFn = options.resolveBinding;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const partialTtlMs = options.partialTtlMs ?? PARTIAL_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const logger = options.logger;

  /** 缓存槽：{ value, expiresAt } | null——所有 outcome 都缓存（含 unbound/unauthorized），重绑等 TTL 或 bust */
  let cache = null;
  /** in-flight Promise：single-flight 合并键；settle 后立即清空（finally 保证不泄漏悬挂态） */
  let inFlight = null;
  /** 简报身份名进程期缓存：undefined=未取过；成功才缓存（失败本轮降级 isMine=false，下轮重试） */
  let cachedMyName;

  /** 拉取简报身份名（GET /agents/me，已实证 {code,data:{name,...}}）；进程期缓存命中即短路 */
  async function fetchMyName(binding, signal) {
    if (cachedMyName !== undefined) return cachedMyName;
    const data = await requestJson(fetchImpl, `${binding.apiBaseUrl}/agents/me`, binding.apiKey, signal, timeoutMs);
    const name = typeof data?.name === 'string' ? data.name : null;
    cachedMyName = name;
    return name;
  }

  /**
   * 纯聚合（无缓存）：unbound/unauthorized 以值返回（bound:false 家族，浏览器走专属空态）；
   * boards 抓取的其他失败（网络/超时/5xx/信封错误）throw PanelError('unreachable')——
   * plan §3 契约无 unreachable 变体，不可达走 RemoteError 让浏览器进 RemoteResult error 分支（可重试）。
   */
  async function fetchPanelState(signal) {
    const binding = resolveBindingFn();
    if (!binding) return { bound: false, reason: 'unbound' };

    let boardsData;
    try {
      boardsData = await requestJson(
        fetchImpl,
        `${binding.apiBaseUrl}/boards?pageSize=${BOARD_PAGE_SIZE}`,
        binding.apiKey,
        signal,
        timeoutMs,
      );
    } catch (error) {
      // 401（HTTP 层或信封 code）→ unauthorized 值（UX 终稿：key 失效专属文案，重试必然同样失败，不与不可达同流）
      if (error instanceof FetchError && error.status === 401) {
        return { bound: false, reason: 'unauthorized' };
      }
      throw new PanelError('unreachable', `boards fetch failed: ${errorReasonOf(error)}`, {
        reason: errorReasonOf(error),
        status: error instanceof FetchError ? error.status : null,
      });
    }

    const boardItems = Array.isArray(boardsData?.items) ? boardsData.items : [];
    // boards 成功（key 有效）后才并发：me + 每 board tasks；me 失败不拖垮面板（isMine 全 false 降级）
    const [meResult, ...taskResults] = await Promise.allSettled([
      fetchMyName(binding, signal),
      ...boardItems.map((b) => requestJson(fetchImpl, tasksUrl(binding.apiBaseUrl, b?.id), binding.apiKey, signal, timeoutMs)),
    ]);
    const myName = meResult.status === 'fulfilled' ? meResult.value : null;

    let partial = false;
    const boards = boardItems.map((raw, i) => {
      /** BoardEntry 契约四字段先行（plan §3 逐字）；tasks/error 二选一后挂 */
      const entry = {
        id: String(raw?.id ?? ''),
        name: String(raw?.name ?? ''),
        taskCount: Number(raw?.taskCount) || 0,
        completedTaskCount: Number(raw?.completedTaskCount) || 0,
      };
      const result = taskResults[i];
      if (result.status === 'fulfilled') {
        const items = Array.isArray(result.value?.items) ? result.value.items : [];
        entry.tasks = sortTasks(items.map((t) => toTaskEntry(t, myName)));
      } else {
        // 单 board 失败降级：该 entry 带 error:{code}，partial:true，不拖垮整体（architect-M4）
        partial = true;
        entry.error = { code: errorReasonOf(result.reason) };
      }
      return entry;
    });

    // plan §9 成功判定信号：真实抓取才打一行（缓存命中不打——真实打开才调用）
    logger?.info?.(`[agent-chamber] panel=fetch boards=${boards.length} partial=${partial ? 1 : 0}`);
    // taskUrlBase：任务深链基座（web 基座 + /tasks/），host 侧推导（deriveWebBaseUrl 优先级见注释）——
    // 浏览器不再硬编码生产域，开源部署跳回自己的实例；契约加字段向后兼容（旧 client 不读该键无感）。
    return { bound: true, fetchedAt: new Date(now()).toISOString(), partial, boards, taskUrlBase: `${deriveWebBaseUrl(binding)}/tasks/` };
  }

  /**
   * 缓存 + single-flight 包装。
   * 不变量：① TTL 命中直接返回同一对象（引用相等——测试与浏览器都依赖幂等）；
   * ② 未命中时并发调用共享同一 in-flight（第二调用方的 signal 被忽略——合并语义下
   *    首个调用方的取消不取消共享抓取，这是 single-flight 的既定取舍，注释备查）；
   * ③ 只有成功结果进缓存（throw 不缓存——unreachable 下轮轮询自然重试）；
   * ④ finally 清 inFlight——任何 settle 路径都不泄漏悬挂态。
   */
  function getPanelState(signal) {
    if (cache && now() < cache.expiresAt) return Promise.resolve(cache.value);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const value = await fetchPanelState(signal);
        // partial 结果 TTL 缩短（architect-M4）：让失败 board 快速重试
        const ttl = value.bound === true && value.partial === true ? partialTtlMs : ttlMs;
        cache = { value, expiresAt: now() + ttl };
        return value;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * 手动 bust（PM-M4：未来手动刷新按钮调用）。只清结果缓存——
   * 简报身份名是进程期缓存不随 bust 失效（改名场景低频发版级，重启进程即解）；
   * in-flight 不取消（无法取消已发出的抓取，它落地后会重新填充缓存，注释备查）。
   */
  function bustCache() {
    cache = null;
  }

  return { getPanelState, bustCache };
}

// ———————————————————————————— Remote 服务定义（stage-3 decorator 手动形态，批 0 spike 实证） ————————————————————————————

/**
 * 错误上翻：provider 的 PanelError/任意异常 → 真实 RemoteError。
 * 已是 RemoteError（isDSHRemoteError 结构标记，跨 realm 判定）→ 原样透传；
 * 其余取 error.code（PanelError 词表）或兜底 'internal'。
 */
function toRemoteError(RemoteErrorImpl, error) {
  if (error && error.isDSHRemoteError === true) return error;
  const code = typeof error?.code === 'string' ? error.code : 'internal';
  const message = error instanceof Error ? error.message : String(error);
  const details = error && typeof error === 'object' ? error.details : undefined;
  return new RemoteErrorImpl(code, message, details);
}

/**
 * 定义 Chamber Remote 服务类（批 0 spike GO 形态照抄）：
 *   - class extends TypertRemoteService，super(ctx, 'chamber')——构造即经 ctx.reflect.provide
 *     注册服务实例，gateway SRC 发现靠 reflect.props + typertRemote binding；
 *   - Remote 手动调用 stage-3 decorator 形态（legacy 三参写法已证伪必炸）：手动构造
 *     context 对象 {kind:'method', name, static:false, private:false, addInitializer}，
 *     initializer 收集后由 constructor 逐个 fn.call(this) 落 marker（幂等——重复实例化
 *     时 mark() 对同形状 marker 早返回）；
 *   - ⚠️ 方法签名硬约束见文件头：getPanelState(signal) 纯标识符、signal 末位、禁压缩。
 * @param {object} protocol @deepseek-ai/dsh-typert-protocol 模块命名空间 {Remote, RemoteError, TypertRemoteService, ...}
 * @param {{getPanelState: Function}} provider createPanelStateProvider 产物
 * @returns {Function} Chamber 服务类（new Chamber(ctx) 实例化即注册）
 */
export function defineChamberService(protocol, provider) {
  const { Remote, RemoteError: RemoteErrorImpl, TypertRemoteService } = protocol;
  const inits = []; // stage-3 initializer 收集槽（手动形态的 decorator context 替代品）
  class Chamber extends TypertRemoteService {
    /**
     * cordis 服务注入声明：真实 cordis 按注入解析时要求 typert 在场；
     * 手动 new Chamber(ctx) 路径不消费本字段（spike 实证假 ctx 无 typert 亦可实例化）。
     */
    static inject = ['typert'];

    constructor(ctx) {
      super(ctx, REMOTE_NAMESPACE);
      for (const fn of inits) fn.call(this); // 落 Remote marker 到原型（幂等）
    }

    /**
     * 唯一 Remote 方法（plan §3：单调用聚合）。⚠️ 签名约束：纯标识符参数、signal 末位——
     * gateway SRC 按 Function.prototype.toString 解析参数名，禁解构/默认值/rest。
     * @param {AbortSignal} signal 取消信号（gateway 末位注入；未提供时 gateway 推 NEVER_ABORTED_SIGNAL）
     * @returns {Promise<object>} PanelState（纯 JSON 自律，出口 assertJsonValue 把关）
     */
    async getPanelState(signal) {
      try {
        return assertJsonValue(await provider.getPanelState(signal));
      } catch (error) {
        throw toRemoteError(RemoteErrorImpl, error);
      }
    }
  }
  // stage-3 decorator 手动调用（批 0 spike 实证形态，勿改 legacy 三参写法）
  Remote(Chamber.prototype.getPanelState, {
    kind: 'method',
    name: 'getPanelState',
    static: false,
    private: false,
    addInitializer: (fn) => inits.push(fn),
  });
  return Chamber;
}

// ———————————————————————————— 跨包协议装载（唯一通路，铁律③） ————————————————————————————

/**
 * 动态装载 @deepseek-ai/dsh-typert-protocol（批 0 spike 实证唯一通路）：
 * dsh bin 是软链，realpathSync 后 createRequire 才命中 dsh 依赖树（realpath 前 MODULE_NOT_FOUND）。
 * @param {string} anchor 锚点路径（生产 = process.argv[1]，即 dsh bin 软链；测试可注入 dsh 安装路径）
 * @returns {Promise<object>} 协议模块命名空间
 * @throws 锚点缺失/解析失败/import 失败（调用方 setupChamberRemote 统一降级）
 */
export async function resolveProtocolModule(anchor) {
  if (typeof anchor !== 'string' || anchor === '') {
    throw new Error('protocol anchor missing (process.argv[1] unavailable)');
  }
  const req = createRequire(realpathSync(anchor));
  return import(pathToFileURL(req.resolve('@deepseek-ai/dsh-typert-protocol')).href);
}

// ———————————————————————————— 总装（故障隔离入口） ————————————————————————————

/** 日志器归一化：cordis logger / 捕获式测试 logger / 缺失 三态统一为安全调用面 */
function normalizeLogger(logger) {
  return {
    info: (m) => logger?.info?.(m),
    warn: (m) => logger?.warn?.(m),
    error: (m) => logger?.error?.(m),
  };
}

/**
 * 故障隔离总装（apply() 零 throw 的执行层）：协议装载失败 / 服务实例化失败 →
 * 仅降级日志 '[agent-chamber] remote=unavailable:<reason>'，boot 无损；成功 →
 * '[agent-chamber] remote=installed' 并返回 { installed:true, service, bustCache }。
 * 分阶段 try/catch：reason 词表 = protocol | instantiate（模块装载失败由 index.mjs 兜成 module-load）。
 * @param {object} ctx Cordis 上下文（真实 cordis 需 reflect.provide；测试假 ctx 见 remote.test.mjs）
 * @param {object} [log] 日志器（缺省 ctx.logger，再缺省静默）
 * @param {object} [options] 测试注入口
 * @param {object} [options.protocol] 直接注入协议模块（跳过 argv[1] 锚定解析）
 * @param {string} [options.protocolAnchor] 协议解析锚点覆写
 * @param {() => object|null} [options.resolveBinding] 绑定解析覆写（缺省 process.cwd() 向上查找）
 * @param {Function} [options.fetchImpl] fetch 覆写（mock）
 * @param {() => number} [options.now] 时钟覆写
 * @param {number} [options.ttlMs] 正常 TTL 覆写
 * @param {number} [options.partialTtlMs] partial TTL 覆写
 * @param {number} [options.timeoutMs] 单路超时覆写
 * @returns {Promise<{installed: true, service: object, bustCache: () => void} | {installed: false, reason: string}>}
 */
export async function setupChamberRemote(ctx, log, options = {}) {
  const logger = normalizeLogger(log ?? ctx?.logger);

  // 阶段①：协议装载（注入优先；否则 argv[1] 锚定——测试进程锚点必然失败，天然演练降级路径）
  let protocol = options.protocol;
  if (!protocol) {
    try {
      protocol = await resolveProtocolModule(options.protocolAnchor ?? process.argv[1]);
    } catch (error) {
      logger.error(`[agent-chamber] remote=unavailable:protocol error=${String(error)}`);
      return { installed: false, reason: 'protocol' };
    }
  }

  // 阶段②：provider + 服务类定义 + 实例化注册（假 ctx 缺 reflect.provide 等 → 此阶段 throw）
  try {
    const provider = createPanelStateProvider({
      resolveBinding: options.resolveBinding ?? (() => resolveBinding(options.cwd ?? process.cwd())),
      fetchImpl: options.fetchImpl,
      now: options.now,
      ttlMs: options.ttlMs,
      partialTtlMs: options.partialTtlMs,
      timeoutMs: options.timeoutMs,
      logger,
    });
    const Chamber = defineChamberService(protocol, provider);
    const service = new Chamber(ctx);
    logger.info(`[agent-chamber] remote=installed namespace=${REMOTE_NAMESPACE}`);
    return { installed: true, service, bustCache: provider.bustCache };
  } catch (error) {
    logger.error(`[agent-chamber] remote=unavailable:instantiate error=${String(error)}`);
    return { installed: false, reason: 'instantiate' };
  }
}
