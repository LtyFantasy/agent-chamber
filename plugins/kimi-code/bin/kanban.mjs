#!/usr/bin/env node
// kanban.mjs — /agent-chamber:kanban 命令的后端逻辑：读绑定 board 的待办任务（plan §3.2）
// 流程：resolveContext（配置）→ inferBoardId（绑定推断）→ GET {base}/tasks?boardId=&status=&sort=statusPriority&pageSize=20。
// 输出：纯文本 stdout（成功 exit 0；错误同走 stdout + exit 1——agent 读输出引导用户）。
// 用法：node kanban.mjs [status]（status 缺省 todo；合法值见 VALID_STATUSES）。
// 铁律 #11：方法/常量 rationale 一律注释。

import {
  resolveContext,
  fetchJson,
  inferBoardId,
  fetchBoardName,
  ChamberRequestError,
} from './lib/resolve.mjs';

/** status 合法值（对齐后端 TaskStatus + 'all' 通配；plan §3.2 逐字清单） */
const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked', 'archived', 'all'];
/** status 缺省值（plan §3.2：缺省 todo） */
const DEFAULT_STATUS = 'todo';
/** 单页大小：看板待办一屏展示量（plan §3.2：pageSize=20） */
const PAGE_SIZE = 20;

/**
 * 解析 status 参数：缺省 todo；非法 → 输出合法值清单并 exit 1（参数错误在发起任何请求前拦截）。
 * @param {string|undefined} raw process.argv[2]
 * @returns {{ok: true, status: string} | {ok: false, error: string}}
 */
function parseStatus(raw) {
  const status = raw ?? DEFAULT_STATUS;
  if (!VALID_STATUSES.includes(status)) {
    return { ok: false, error: `非法 status「${status}」，合法值：${VALID_STATUSES.join(', ')}` };
  }
  return { ok: true, status };
}

/**
 * 推断结果对象 → 命令行文案（none / ambiguous / mine-unsupported 三态）。
 * 文案要点：none → 引导先创建/加入；ambiguous → 列候选 + 引导显式绑定；mine-unsupported → 显式填 id 或升级后端。
 * @param {object} board inferBoardId 返回（error 态）
 * @returns {string}
 */
function formatInferError(board) {
  if (board.error === 'none') {
    return '[agent-chamber] 绑定未配置且未能推断：你的 agent 当前创建/参与 0 个 board。请先创建或加入一个 board（或在 .kimi-code/agent-chamber.json 显式填写 boardId）后重试 /agent-chamber:kanban。';
  }
  if (board.error === 'invalid-config') {
    return '[agent-chamber] 配置错误：.kimi-code/agent-chamber.json 的 boardId 必须是字符串（当前值类型非法）。请修正后重试 /agent-chamber:kanban。';
  }
  if (board.error === 'ambiguous') {
    const lines = board.candidates.map((c) => `- ${c.id} ${c.name}`);
    const total = board.candidates.length < board.total ? `（共 ${board.total} 个，仅列出前 ${board.candidates.length} 个）` : '';
    return [
      `[agent-chamber] 绑定未配置且存在多个候选 board${total}，无法自动推断。候选：`,
      ...lines,
      '请在 .kimi-code/agent-chamber.json 显式填写 boardId 指向其中一个，再重试 /agent-chamber:kanban。',
    ].join('\n');
  }
  // mine-unsupported（A2）：旧后端收到未声明的 mine 参数 → 400；禁止回退非 mine 列表（open 污染推断）
  return '[agent-chamber] 当前 chamber 后端版本不支持绑定推断（列表接口缺少 mine 参数）。请在 .kimi-code/agent-chamber.json 显式填写 boardId，或升级 chamber 后端后再试。';
}

/** 绑定失效文案（P3）：显式 id 路径下实体不存在/被删；与「未接入/歧义」文案不混用 */
const BINDING_INVALID_TEXT =
  '[agent-chamber] 绑定的 board 不存在或已被删除，请检查 .kimi-code/agent-chamber.json 的 boardId。';

/** 连接异常文案（对齐 hooks 模板 D）：所有 ChamberRequestError 的兜底引导 */
function formatConnectError(err) {
  return `[agent-chamber] chamber 连接异常（${err.reason}）：检查 .kimi-code/agent-chamber.json 的 apiBaseUrl / apiKey 与 mcp.json 配置。`;
}

/**
 * 单条任务行：`- [{priority}] {title}（{assigneeName}，截止 {dueDate}）`，缺字段省略对应段。
 * 组合括号规则：assignee 与「截止 date」任一存在 → 合并进同一对括号（「，」连接）；
 * 两者皆无 → 无括号。dueDate 原样展示（ISO 字符串，不转时区——确定性优先，观察由 agent 解读）。
 * @param {object} t TaskSummary（title/priority/assigneeName/dueDate；均可缺）
 * @returns {string}
 */
function formatTaskLine(t) {
  const head = `${t?.priority ? `[${t.priority}] ` : ''}${t?.title ?? ''}`;
  const detail = [t?.assigneeName, t?.dueDate ? `截止 ${t.dueDate}` : null].filter(Boolean).join('，');
  return `- ${head}${detail ? `（${detail}）` : ''}`;
}

/**
 * 主流程。所有错误路径：stdout 输出文案 + 返回 exit code 1（agent 读 stdout 引导用户）。
 * @returns {Promise<number>} exit code
 */
async function main() {
  const parsed = parseStatus(process.argv[2]);
  if (!parsed.ok) {
    process.stdout.write(`${parsed.error}\n`);
    return 1;
  }
  const status = parsed.status;

  const ctx = resolveContext(process.cwd());
  if (ctx.error) {
    process.stdout.write(`${ctx.error}\n`);
    return 1;
  }

  let board;
  try {
    board = await inferBoardId(ctx.binding, ctx.baseUrl, ctx.key);
  } catch (err) {
    process.stdout.write(`${formatConnectError(err)}\n`);
    return 1;
  }
  if (board.error) {
    process.stdout.write(`${formatInferError(board)}\n`);
    return 1;
  }

  // board 名解析：推断路径 name 已从列表项拿到；显式 id 需单独请求（404 = 绑定失效）
  let boardName = board.name;
  if (!board.inferred) {
    let nameResult;
    try {
      nameResult = await fetchBoardName(ctx.baseUrl, board.id, ctx.key);
    } catch (err) {
      process.stdout.write(`${formatConnectError(err)}\n`);
      return 1;
    }
    if (nameResult.error === 'binding-invalid') {
      process.stdout.write(`${BINDING_INVALID_TEXT}\n`);
      return 1;
    }
    boardName = nameResult.name;
  }

  let tasks;
  try {
    const url = `${ctx.baseUrl}/tasks?boardId=${encodeURIComponent(board.id)}&status=${encodeURIComponent(
      status,
    )}&sort=statusPriority&pageSize=${PAGE_SIZE}`;
    tasks = await fetchJson(url, ctx.key);
  } catch (err) {
    // P3：显式 id 路径下 tasks 404 = 绑定失效（board 不存在/被删/无权）；推断路径的 404 属连接异常
    if (err instanceof ChamberRequestError && err.status === 404 && !board.inferred) {
      process.stdout.write(`${BINDING_INVALID_TEXT}\n`);
      return 1;
    }
    process.stdout.write(`${formatConnectError(err)}\n`);
    return 1;
  }

  const total = Number(tasks?.total ?? 0);
  const items = Array.isArray(tasks?.items) ? tasks.items : [];
  process.stdout.write(
    `board「${boardName}」待办（${status}）：共 ${total} 项${board.inferred ? '，自动推断自唯一参与 board' : ''}\n`,
  );
  if (items.length === 0) {
    process.stdout.write('无待办任务\n');
  } else {
    for (const t of items) {
      process.stdout.write(`${formatTaskLine(t)}\n`);
    }
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
