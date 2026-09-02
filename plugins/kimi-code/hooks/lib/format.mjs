// format.mjs — 三分支输出模板 + 长度护栏（P1 实现，计划 §2.6 逐字草案 + 评审修订）
// 纯函数模块：输入显式传入，输出纯文本模板；stdout 形态由 toHookJson 包装（实验 c：
// 纯文本 stdout 实测不进上下文，改试 Claude Code 惯例的 hookSpecificOutput JSON——
// 官方未记载该字段（R3），SessionStart 是 observation-only，CLI 不识别则输出无害 JSON，失败代价为零）。
// 铁律 #11：常量 rationale 一律注释。

/** 单次注入最大行数（P5 实测点 3 后再调，§6.2.3 实验 b） */
export const MAX_LINES = 12;
/** 单次注入最大字符数（同上） */
export const MAX_CHARS = 1200;
/** nextUp 标题截断长度（字符；中文按字符计） */
export const TITLE_MAX = 40;

/**
 * 模板 A：未接入（无 key，分支①）。
 * 接入三步按评审修订（C-P1/P2）：登录（注册 admin-only）→ Agents 页自助创建 agent 拿 key → playbook 初始化 → 重启。
 * @returns {string}
 */
export function formatNotConfigured() {
  return [
    '[agent-chamber] 未检测到接入配置：项目无 .kimi-code/agent-chamber.json（或 mcp.json 未配 chamber server）。',
    '接入三步：① 登录 chamber（无账号找管理员申请，注册是 admin-only）→ Agents 页创建 agent 复制 API key；② 按插件 README「接入 playbook」初始化（MCP 模式/ REST-only 任一）；③ 重启会话生效。',
  ].join('\n');
}

/**
 * 模板 B：有 key、无绑定（分支②）。
 * 末尾「没有 board 就先去 web 建一个」为评审修订（C-P4）。
 * @param {string} name agent 名（me.name）
 * @param {number} activeTasksTotal 活跃任务数（activeTasks.total）
 * @param {number} unreadTotal 未读消息数（unreadCounts 求和）
 * @returns {string}
 */
export function formatUnbound(name, activeTasksTotal, unreadTotal) {
  return [
    `[agent-chamber] 已认证 chamber（agent: ${name}）· 活跃任务 ${activeTasksTotal} · 未读 ${unreadTotal}`,
    '本项目未绑定 board：在 .kimi-code/agent-chamber.json 填入 boardId / docSpaceId / topicId 后重启会话，即可注入项目 digest。没有 board 就先去 web 建一个。',
  ].join('\n');
}

/**
 * 模板 C：全绑定（分支③）——分组化简报 + 绑定 ID 直达（plan §3 终稿）。
 * 行结构（自上而下，空段省略）：
 *   1. summary：`[agent-chamber] {name} · 项目「{boardName}」· 活跃任务 {total} · 未读 {unreadTotal}`
 *      （digest 失败时 boardName 缺失 → 省略「· 项目「」」段）
 *   2. bound：`bound: board={boardId} topic={topicId} space={docSpaceId}`（只列非空 id，键固定顺序）
 *   3. board 段：按 boardId 分组「我的待办 n — 前 3 标题」；绑定 board 第一、其余按任务数 DESC；
 *      最多 3 行，超出折叠「其余 k 个 board 共 m 项」并入最后一行；total>items.length 时段尾追加截断标注
 *   4. topic 行：unreadCounts 前 3「topic「name」: 未读 n」+ 折叠「其余 k 个 topic 共 m 条」，全部一行
 *   5. nextUp 行：`nextUp（board 策展队列）: 前 3 标题`（digest 失败 → 整行省略）
 *   6. 深拉通道行
 * 消歧（评审 A2/P3）：board 行口径 = hook 拉取的 statuses=todo,in_progress（我的待办）；
 * nextUp 行口径 = 绑定 board 的策展队列（含 backlog/非我任务），文案「board 策展队列」区分两个数据源。
 * @param {object} briefing fetchBriefing 结果 {name, activeTasksTotal, activeItems, unreadTotal, unreadCounts}
 * @param {object|null} digest fetchDigest 结果 {boardName, nextUp}；digest 失败降级时传 null（省 nextUp 行）
 * @param {object} binding agent-chamber.json 绑定 {boardId, topicId, docSpaceId}
 * @returns {string}
 */
export function formatBound(briefing, digest, binding) {
  const lines = [];
  const name = briefing?.name ?? 'unknown';
  const boardName = digest?.boardName ?? '';
  // summary 行：项目名段与「· 活跃任务」之间无空格（「」· 紧贴，plan §3 逐字）；
  // digest 失败（boardName 缺失）→ 省项目名段，此时需保留 name 后的空格分隔（projectPart || ' '）
  const projectPart = boardName !== '' ? ` · 项目「${boardName}」` : '';
  lines.push(`[agent-chamber] ${name}${projectPart || ' '}· 活跃任务 ${briefing?.activeTasksTotal ?? 0} · 未读 ${briefing?.unreadTotal ?? 0}`);

  const boundLine = formatBoundLine(binding);
  if (boundLine) lines.push(boundLine);

  // board 段：无活跃任务 → 整段省略（含截断标注）
  lines.push(...formatBoardSection(briefing?.activeItems ?? [], briefing?.activeTasksTotal ?? 0, binding?.boardId));

  const topicLine = formatTopicLine(briefing?.unreadCounts ?? []);
  if (topicLine) lines.push(topicLine);

  // nextUp 行：digest 失败（null）→ 整行省略（A5 降级）；成功但队列空 → 「无」
  if (digest != null) {
    const titles = (Array.isArray(digest.nextUp) ? digest.nextUp : [])
      .slice(0, 3)
      .map((t) => truncateTitle(t?.title ?? ''));
    lines.push(titles.length > 0 ? `nextUp（board 策展队列）: ${titles.join(' / ')}` : 'nextUp（board 策展队列）: 无');
  }

  lines.push('深拉通道：get_topic_digest(topicId) / get_board_digest / get_docs_overview（或 REST 等价，见 skill）。');
  return lines.join('\n');
}

/**
 * bound 行：只列绑定文件中非空的 id，键固定顺序 board → topic → space。
 * bound 分支 boardId 必非空故该行恒存在；topic/space 可缺省（只列有的）。
 * @param {object} binding agent-chamber.json 绑定
 * @returns {string|null} bound 行文本；全部 id 为空返回 null（防御，正常不会发生）
 */
function formatBoundLine(binding) {
  const parts = [];
  for (const [key, value] of [
    ['board', binding?.boardId],
    ['topic', binding?.topicId],
    ['space', binding?.docSpaceId],
  ]) {
    if (typeof value === 'string' && value.trim() !== '') parts.push(`${key}=${value.trim()}`);
  }
  return parts.length > 0 ? `bound: ${parts.join(' ')}` : null;
}

/**
 * board 段：activeItems 按 boardId 分组 → 每行「board「name」: 我的待办 n — 前 3 标题」。
 * 排序（评审 A4 钉死）：绑定 board 排第一，其余按组内任务数 DESC（同数保持服务端顺序，稳定排序）；
 * 组内标题顺序 = 服务端返回顺序（statusPriority，in_progress 优先），不重排。
 * 折叠：最多 3 行，超出「其余 k 个 board 共 m 项」并入最后一个 board 行尾部。
 * 截断标注（P2a）：activeTasksTotal > items.length → 段尾追加「（另有 N 项未分组列出）」，贴近被截断的数据。
 * @param {Array<object>} items activeTasks.items（服务端顺序）
 * @param {number} total activeTasks.total（服务端总数，可能 > items.length）
 * @param {string} boundBoardId 绑定 boardId（排第一；可能含手写空白，比较前先 trim——
 *   与 formatBoundLine/fetchDigest 调用点的 trim 惯例一致，否则 ' board-1 ' 永不命中导致绑定 board 失序）
 * @returns {string[]} board 段行数组；无活跃任务返回空数组（整段省略）
 */
function formatBoardSection(items, total, boundBoardId) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const boundId = typeof boundBoardId === 'string' ? boundBoardId.trim() : boundBoardId;
  // 分组：Map<boardId, {boardId, boardName, count, titles}>；boardName 取组内首个非空值
  const groups = new Map();
  for (const item of items) {
    const bid = item?.boardId ?? '';
    if (!groups.has(bid)) groups.set(bid, { boardId: bid, boardName: '', count: 0, titles: [] });
    const g = groups.get(bid);
    g.count += 1;
    if (g.boardName === '' && typeof item?.boardName === 'string' && item.boardName !== '') g.boardName = item.boardName;
    const title = truncateTitle(item?.title ?? '');
    if (title !== '') g.titles.push(title);
  }
  const groupList = [...groups.values()];
  // 绑定 board 第一，其余按任务数 DESC；稳定排序保证同数时保持服务端顺序
  groupList.sort((a, b) => {
    if (a.boardId === boundId) return -1;
    if (b.boardId === boundId) return 1;
    return b.count - a.count;
  });
  const lines = [];
  for (const g of groupList.slice(0, 3)) {
    const boardName = g.boardName !== '' ? g.boardName : 'unknown-board';
    let line = `board「${boardName}」: 我的待办 ${g.count}`;
    if (g.titles.length > 0) line += ` — ${g.titles.slice(0, 3).join(' / ')}`;
    lines.push(line);
  }
  // 折叠：第 4 个起的 board 并入最后一个 board 行尾部（与 topic 行折叠同用「 / 」分隔）
  if (groupList.length > 3) {
    const folded = groupList.slice(3);
    const k = folded.length;
    const m = folded.reduce((sum, g) => sum + g.count, 0);
    lines[lines.length - 1] += ` / 其余 ${k} 个 board 共 ${m} 项`;
  }
  // 截断标注：total > items.length → 段尾追加（贴近被截断的数据，不放 summary 行）
  if (total > items.length) {
    lines.push(`（另有 ${total - items.length} 项未分组列出）`);
  }
  return lines;
}

/**
 * topic 行：unreadCounts 服务端已按 unreadCount DESC 排序，取前 3 列「topic「name」: 未读 n」，
 * 其余折叠「其余 k 个 topic 共 m 条」；全部一行（「 / 」分隔）。无未读 → 返回 null（整行省略）。
 * topic 名超长（>TITLE_MAX）同样截断；名缺失兜底 unknown-topic（与 board 行 unknown-board 同口径）。
 * @param {Array<object>} unreadCounts [{topicId, topicName, unreadCount}]
 * @returns {string|null}
 */
function formatTopicLine(unreadCounts) {
  if (!Array.isArray(unreadCounts) || unreadCounts.length === 0) return null;
  const parts = unreadCounts.slice(0, 3).map((t) => {
    const topicName = typeof t?.topicName === 'string' && t.topicName !== '' ? t.topicName : 'unknown-topic';
    return `topic「${truncateTitle(topicName)}」: 未读 ${Number(t?.unreadCount) || 0}`;
  });
  if (unreadCounts.length > 3) {
    const folded = unreadCounts.slice(3);
    const k = folded.length;
    const m = folded.reduce((sum, t) => sum + (Number(t?.unreadCount) || 0), 0);
    parts.push(`其余 ${k} 个 topic 共 ${m} 条`);
  }
  return parts.join(' / ');
}

/**
 * 模板 D：配置异常（分支④）。
 * @param {string} reason 原因（HTTP status / timeout / network-error / 指针错配 / scheme 违例等）
 * @returns {string}
 */
export function formatConfigError(reason) {
  return `[agent-chamber] chamber 连接异常（${reason}）：检查 .kimi-code/agent-chamber.json 的 apiBaseUrl / apiKey 与 mcp.json 配置。`;
}

/**
 * 模板 E：PreCompact 提醒（§2.5）。
 * 官方事件表明示 PreCompact "return values are completely ignored"（§0.3），
 * 本输出是否进上下文待 P5 决策门判定（§6.2.3）；不通过则裁掉本 hook。
 * @returns {string}
 */
export function formatPreCompact() {
  return '[agent-chamber] 会话即将压缩。持久化提示：把当前工作状态（改动的文件、下一步、遗留问题）写入项目约定的交接记录（如 AGENTS.md 指定的位置），并同步 board 任务状态。';
}

/**
 * 硬护栏：单次注入 ≤ MAX_LINES 行 / ≤ MAX_CHARS 字符。
 * 先按字符截再按行截（行截只会减少字符，两约束同时满足）。
 * @param {string} text
 * @returns {string} 护栏内文本
 */
export function enforceGuardrail(text) {
  let out = String(text);
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);
  const lines = out.split('\n');
  if (lines.length > MAX_LINES) out = lines.slice(0, MAX_LINES).join('\n');
  return out;
}

/** 标题超长截断：超过 max 字符截断并加省略号 */
function truncateTitle(title, max = TITLE_MAX) {
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

/**
 * hook stdout 输出形态（实验 c，P5 决策门）：hookSpecificOutput JSON 包装。
 * 背景：P5 实证本 CLI 下纯文本 stdout 不进上下文（官方措辞 "may be appended"，实测未注入）；
 * additionalContext 字段官方未记载（R3），本函数是实验性通路——CLI 不识别则为无害 JSON 输出，
 * hook 仍 exit 0、observation-only，会话无损。实验判负则回退本函数为透传。
 * @param {string} eventName hook 事件名（如 'SessionStart'，Claude Code 惯例字段）
 * @param {string} text 已过护栏的纯文本（先 enforceGuardrail 再传入）
 * @returns {string} 单行 JSON 字符串
 */
export function toHookJson(eventName, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
}
