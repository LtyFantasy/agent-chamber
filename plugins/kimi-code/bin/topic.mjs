#!/usr/bin/env node
// topic.mjs — /agent-chamber:topic 命令的后端逻辑：读绑定 topic 最近 N 条消息（plan §3.2）
// 流程：resolveContext（配置）→ inferTopicId（绑定推断）→ GET {base}/topics/:id/messages?limit=N。
// 注意：messages 端点响应形状 = {messages, nextCursor, hasMore}（非 items/total，topic.service.ts 已钉死）。
// 输出：纯文本 stdout（成功 exit 0；错误同走 stdout + exit 1——agent 读输出引导用户）。
// 用法：node topic.mjs [N]（N 缺省 10；合法 1-50）。
// 铁律 #11：方法/常量 rationale 一律注释。

import {
  resolveContext,
  fetchJson,
  inferTopicId,
  fetchTopicTitle,
  ChamberRequestError,
} from './lib/resolve.mjs';

/** N 合法区间（plan §3.2：1-50；对齐 messages limit 参数后端上限 100 内的保守值） */
const N_MIN = 1;
const N_MAX = 50;
/** N 缺省值（plan §3.2：缺省 10） */
const DEFAULT_N = 10;
/** content 截断长度（plan §3.2：前 160 字；中文按字符计，与 hooks format MAX_CHARS 同口径） */
const CONTENT_MAX = 160;

/**
 * 解析 N 参数：缺省 10；仅接受纯数字且 1-50（'0'/'51'/'abc'/-1 均非法）→ 报错 exit 1。
 * 参数错误在发起任何请求前拦截（不浪费一次无效 API 调用）。
 * @param {string|undefined} raw process.argv[2]
 * @returns {{ok: true, n: number} | {ok: false, error: string}}
 */
function parseN(raw) {
  const rawN = raw ?? String(DEFAULT_N);
  if (!/^\d+$/.test(rawN)) {
    return { ok: false, error: `N 必须为 ${N_MIN}-${N_MAX} 的整数（收到「${rawN}」）` };
  }
  const n = Number(rawN);
  if (n < N_MIN || n > N_MAX) {
    return { ok: false, error: `N 必须为 ${N_MIN}-${N_MAX} 的整数（收到「${rawN}」）` };
  }
  return { ok: true, n };
}

/**
 * 推断结果对象 → 命令行文案（none / ambiguous / mine-unsupported 三态；与 kanban 同构、topic 口径）。
 * @param {object} topic inferTopicId 返回（error 态）
 * @returns {string}
 */
function formatInferError(topic) {
  if (topic.error === 'none') {
    return '[agent-chamber] 绑定未配置且未能推断：你的 agent 当前创建/参与 0 个活跃 topic。请先创建或加入一个 topic（或在 .kimi-code/agent-chamber.json 显式填写 topicId）后重试 /agent-chamber:topic。';
  }
  if (topic.error === 'invalid-config') {
    return '[agent-chamber] 配置错误：.kimi-code/agent-chamber.json 的 topicId 必须是字符串（当前值类型非法）。请修正后重试 /agent-chamber:topic。';
  }
  if (topic.error === 'ambiguous') {
    const lines = topic.candidates.map((c) => `- ${c.id} ${c.name}`);
    const total = topic.candidates.length < topic.total ? `（共 ${topic.total} 个，仅列出前 ${topic.candidates.length} 个）` : '';
    return [
      `[agent-chamber] 绑定未配置且存在多个候选 topic${total}，无法自动推断。候选：`,
      ...lines,
      '请在 .kimi-code/agent-chamber.json 显式填写 topicId 指向其中一个，再重试 /agent-chamber:topic。',
    ].join('\n');
  }
  // mine-unsupported（A2）：同 kanban 语义，禁止回退非 mine 列表
  return '[agent-chamber] 当前 chamber 后端版本不支持绑定推断（列表接口缺少 mine 参数）。请在 .kimi-code/agent-chamber.json 显式填写 topicId，或升级 chamber 后端后再试。';
}

/** 绑定失效文案（P3）：显式 id 路径下 topic 不存在/被删；与「未接入/歧义」文案不混用 */
const BINDING_INVALID_TEXT =
  '[agent-chamber] 绑定的 topic 不存在或已被删除，请检查 .kimi-code/agent-chamber.json 的 topicId。';

/** 连接异常文案（对齐 hooks 模板 D）：所有 ChamberRequestError 的兜底引导 */
function formatConnectError(err) {
  return `[agent-chamber] chamber 连接异常（${err.reason}）：检查 .kimi-code/agent-chamber.json 的 apiBaseUrl / apiKey 与 mcp.json 配置。`;
}

/**
 * 消息时间：取 createdAt 原样前 16 字符并去掉中间的 T（2026-09-01T10:30:00 → 2026-09-01 10:30）。
 * 为什么不自转时区：toLocaleString 受运行环境 TZ 影响，golden 测试不稳定；纯字符串截取确定性最强，
 * 展示精度（分钟级）+ 保留日期已满足「最近讨论」阅读场景。
 * @param {string|Date|undefined} createdAt 消息创建时间
 * @returns {string}
 */
function formatMessageTime(createdAt) {
  const t = String(createdAt ?? '');
  return t.length >= 16 ? `${t.slice(0, 10)} ${t.slice(11, 16)}` : (t || 'unknown-time');
}

/**
 * 消息内容：压平换行（每行一条的列表语义，防止 content 内换行破坏行结构）+ 超 160 字截断加省略号。
 * 只压 \r \n，保留普通空格（不吞缩进语义）。
 * @param {string|undefined} content 消息内容
 * @returns {string}
 */
function formatMessageContent(content) {
  const flat = String(content ?? '').replace(/[\r\n]+/g, ' ');
  return flat.length > CONTENT_MAX ? `${flat.slice(0, CONTENT_MAX)}…` : flat;
}

/**
 * 单条消息行：`- [{time}] {senderName}: {content 前 160 字}`。
 * senderName 缺失兜底 unknown-sender（对齐 hooks unknown-* 兜底口径）。
 * @param {object} m Message（senderName/content/createdAt）
 * @returns {string}
 */
function formatMessageLine(m) {
  const sender = typeof m?.senderName === 'string' && m.senderName !== '' ? m.senderName : 'unknown-sender';
  return `- [${formatMessageTime(m?.createdAt)}] ${sender}: ${formatMessageContent(m?.content)}`;
}

/**
 * 主流程。所有错误路径：stdout 输出文案 + 返回 exit code 1（agent 读 stdout 引导用户）。
 * @returns {Promise<number>} exit code
 */
async function main() {
  const parsed = parseN(process.argv[2]);
  if (!parsed.ok) {
    process.stdout.write(`${parsed.error}\n`);
    return 1;
  }
  const n = parsed.n;

  const ctx = resolveContext(process.cwd());
  if (ctx.error) {
    process.stdout.write(`${ctx.error}\n`);
    return 1;
  }

  let topic;
  try {
    topic = await inferTopicId(ctx.binding, ctx.baseUrl, ctx.key);
  } catch (err) {
    process.stdout.write(`${formatConnectError(err)}\n`);
    return 1;
  }
  if (topic.error) {
    process.stdout.write(`${formatInferError(topic)}\n`);
    return 1;
  }

  // topic 标题解析：推断路径 title 已从列表项拿到；显式 id 需单独请求（404 = 绑定失效）
  let topicTitle = topic.name;
  if (!topic.inferred) {
    let titleResult;
    try {
      titleResult = await fetchTopicTitle(ctx.baseUrl, topic.id, ctx.key);
    } catch (err) {
      process.stdout.write(`${formatConnectError(err)}\n`);
      return 1;
    }
    if (titleResult.error === 'binding-invalid') {
      process.stdout.write(`${BINDING_INVALID_TEXT}\n`);
      return 1;
    }
    topicTitle = titleResult.name;
  }

  let messages;
  try {
    const url = `${ctx.baseUrl}/topics/${encodeURIComponent(topic.id)}/messages?limit=${n}`;
    messages = await fetchJson(url, ctx.key);
  } catch (err) {
    // P3：显式 id 路径下 messages 404 = 绑定失效；推断路径的 404 属连接异常
    if (err instanceof ChamberRequestError && err.status === 404 && !topic.inferred) {
      process.stdout.write(`${BINDING_INVALID_TEXT}\n`);
      return 1;
    }
    process.stdout.write(`${formatConnectError(err)}\n`);
    return 1;
  }

  const items = Array.isArray(messages?.messages) ? messages.messages : [];
  process.stdout.write(
    `topic「${topicTitle}」最近 ${n} 条消息${topic.inferred ? '，自动推断自唯一参与 topic' : ''}\n`,
  );
  if (items.length === 0) {
    process.stdout.write('暂无消息\n');
  } else {
    for (const m of items) {
      process.stdout.write(`${formatMessageLine(m)}\n`);
    }
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
