window.__ModuleLoader__.load({
	id: "dsh-agent-chamber",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region client/panel.tsx
const { Tag, StateDot, Pill, Tooltip, HoverCard, Button, IconRefreshOutline16, IconRightUpOutline14, IconChevronRightOutline14, IconChecklistOutline14, relativeTime } = require("@deepseek-ai/dsh-client-ui-primitives");
/** tab 类型定义与 keyed 槽注册的同一身份键（包名即自然值，tab-registry.d.ts 注释先例） */
const CHAMBER_ID = "dsh-agent-chamber";
/** tab 类型判别词：openTab('chamber') 的寻址键；全局唯一即可，取语义短名 */
const CHAMBER_KIND = "chamber";
/**
* 面板轮询间隔（ms）：plan §2 数据流写死 30s；host 侧 TTL 60s + single-flight，
* 多 tab 首击不穿透，30s 轮询对平台 REST 的压力可忽略。
*/
const POLL_INTERVAL_MS = 3e4;
/**
* 折叠态 localStorage 键（plan §4：折叠态 localStorage 记忆）。单键存 Record<boardId, boolean>，
* 与 host 无关（纯浏览器偏好）；读写全 try/catch——隐私模式/配额异常时记忆失效但不影响面板。
*/
const COLLAPSE_STORAGE_KEY = "dsh-agent-chamber:collapsed-boards";
/** 组内 backlog 默认条数（plan §4：默认前 5 条 +「还有 N 条」展开） */
const BACKLOG_PREVIEW = 5;
const STATUS_PRESENTATION = {
	backlog: {
		kind: "tag",
		tone: "neutral",
		label: "待办"
	},
	todo: {
		kind: "tag",
		tone: "info",
		label: "待开始"
	},
	in_progress: {
		kind: "dot",
		state: "ongoing",
		label: "进行中"
	},
	blocked: {
		kind: "tag",
		tone: "danger",
		label: "已阻塞"
	},
	review: {
		kind: "tag",
		tone: "success",
		label: "审核中"
	}
};
/**
* 未知状态兜底（host 侧 status 是 string 透传，未来平台加态时不许炸面板）：outline tone + label「未知」，
* 原始值保留在 data-chamber-task-status 属性——不发明 tone（映射表只覆盖五态），但也不丢失事实。
*/
const UNKNOWN_STATUS_PRESENTATION = {
	kind: "tag",
	tone: "outline",
	label: "未知"
};
/** 行动项判定（plan §4：折叠组 Pill 专数 blocked+review）——唯一被两处复用的语义（组头 Pill / 默认展开） */
function isActionStatus(status) {
	return status === "blocked" || status === "review";
}
/**
* 优先级展示：二线只印平台词汇的紧凑形态（P0…P3，i18n 键 p0/p1/p2/p3），全称（如「P0 - 紧急」）
* 下钻到 HoverCard——二线是密度敏感的 12px 单行，放不下全称。全称表同源于 zh-CN.json tasks.priority。
*/
const PRIORITY_FULL_LABEL = {
	p0: "P0 - 紧急",
	p1: "P1 - 高",
	p2: "P2 - 中",
	p3: "P3 - 低"
};
/**
* 手写 strict contribution（plan §5.3 代码块逐字段照抄；InvocationDescriptor 逐字段
* 已过 dsh-api-gateway/lib/client.js requireStrictDescriptor/mountContribution 核对）：
* - id：全局稳定生成身份，格式 <pkg>/<ns>#<method>；
* - service/namespace/method：wire 寻址三元组，与 host 侧 super(ctx,'chamber') +
*   Remote marker 派生的 SRC 契约一致（批 1 真机实证 chamber/getPanelState 可达）；
* - invocation.kind='direct'：直接寻址（非 context 投影）；
* - parameters:[]：零业务参数（host 方法仅 signal 尾参）；
* - cancellation：传输取消参数 signal 末位注入（host 签名硬约束同款）；
* - result codec strict + 恒等 parse：值已由 host 侧 assertJsonValue 把关为纯 JSON，
*   浏览器不再校验（恒等 parse = strict 模式的合法最小实现，官方生成代码同形）。
*/
const CHAMBER_CONTRIBUTION = {
	package: "dsh-agent-chamber",
	descriptors: [{
		id: "dsh-agent-chamber/chamber#getPanelState",
		service: "chamber",
		namespace: "chamber",
		method: "getPanelState",
		invocation: { kind: "direct" },
		parameters: [],
		cancellation: { parameter: "signal" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-agent-chamber/chamber#getPanelState:result",
			schema: { parse: (v) => v }
		}
	}]
};
const PANEL_CSS = `
.dshAc_root{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshAc_header{display:flex;align-items:center;gap:6px;flex:none;height:38px;box-sizing:border-box;padding:0 6px 0 16px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dshAc_title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshAc_spacer{flex:1 1 auto;min-width:6px}
.dshAc_updated{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshAc_pillWrap{display:inline-flex;align-items:center;flex:none}
.dshAc_pillDanger{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dshAc_tool{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:6px;border:none;border-radius:28px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1;transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out),color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out)}
.dshAc_tool svg{width:15px;height:15px}
.dshAc_tool:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshAc_tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshAc_body{flex:1 1 auto;min-height:0;overflow:auto;scrollbar-gutter:stable;padding:6px 8px 12px}
.dshAc_group{margin:0 0 2px}
.dshAc_groupHeader{display:flex;align-items:center;gap:6px;width:100%;min-height:32px;box-sizing:border-box;padding:4px 8px;border:none;border-radius:8px;background:0 0;font:inherit;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out)}
.dshAc_groupHeader:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshAc_groupHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshAc_chevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.dshAc_chevron[data-open=true]{transform:rotate(90deg)}
.dshAc_groupName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshAc_groupBody{display:grid;grid-template-rows:1fr;transition:grid-template-rows var(--ds-transition-duration-slow,.3s) var(--ds-ease-in-out)}
.dshAc_groupBody[data-collapsed=true]{grid-template-rows:0fr}
.dshAc_groupClip{min-height:0;overflow:hidden}
.dshAc_groupBody[data-collapsed=true] .dshAc_groupClip{visibility:hidden}
.dshAc_list{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none}
.dshAc_item{margin:0;padding:0}
.dshAc_link{display:block;box-sizing:border-box;min-height:32px;padding:4px 8px;border-radius:8px;color:inherit;text-decoration:none;transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out)}
.dshAc_link:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshAc_link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshAc_line1{display:flex;align-items:center;gap:6px;min-height:20px}
.dshAc_line2{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshAc_glyph{display:inline-flex;align-items:center;flex:none}
.dshAc_titleText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dshAc_mine{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshAc_overdue{flex:none;font-size:12px;line-height:16px;font-weight:500;color:var(--dsw-alias-state-warn-label);white-space:nowrap}
.dshAc_openIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.dshAc_more{display:inline-flex;align-items:center;min-height:28px;padding:3px 8px;border:none;border-radius:6px;background:0 0;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out),color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out)}
.dshAc_more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshAc_more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshAc_note{margin:0;padding:3px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshAc_status{display:flex;flex-direction:column;gap:8px;padding:12px 10px}
.dshAc_statusLine{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dshAc_statusCode{margin:0;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshAc_statusActions{display:flex;gap:8px}
.dshAc_card{display:flex;flex-direction:column;gap:8px;margin:12px 10px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.dshAc_cardTitle{margin:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshAc_cardBody{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshAc_cardCode{font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary)}
.dshAc_skeleton{display:flex;flex-direction:column;gap:10px;padding:12px 10px}
.dshAc_skeletonBar{height:12px;border-radius:6px;background:var(--dsw-alias-bg-skeleton)}
.dshAc_srOnly{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dshAc_hoverCard{display:flex;flex-direction:column;gap:8px}
.dshAc_hoverTitle{color:#fff;font-size:14px;line-height:20px;overflow-wrap:break-word}
.dshAc_hoverGrid{display:flex;flex-direction:column;gap:4px}
.dshAc_hoverRow{display:flex;gap:8px;font-size:12px;line-height:16px;color:#cfd3d6}
.dshAc_hoverKey{flex:none;min-width:40px;opacity:.75}
.dshAc_hoverValue{min-width:0;word-break:break-word}
.dshAc_hoverHint{color:#cfd3d6;font-size:12px;line-height:16px;opacity:.75}
@media (prefers-reduced-motion:reduce){
.dshAc_tool,.dshAc_groupHeader,.dshAc_link,.dshAc_more{transition:none}
.dshAc_groupBody{transition:none}
.dshAc_link svg rect{animation:none}
}
`;
/** 样式 shim 的 tagId（去重键 + 现场排障锚点；官方 shim 同款 data-plugin-css 机制） */
const STYLE_TAG_ID = "dsh-agent-chamber/client/panel.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]") === null) {
	const styleTag = document.createElement("style");
	styleTag.dataset.plugin = "dsh-agent-chamber";
	styleTag.dataset.pluginCss = STYLE_TAG_ID;
	styleTag.textContent = PANEL_CSS;
	document.head.appendChild(styleTag);
}
/** 类名映射（等价 CSS Modules 产物的 default 对象；语义名 → 类名） */
const styles = {
	root: "dshAc_root",
	header: "dshAc_header",
	title: "dshAc_title",
	spacer: "dshAc_spacer",
	updated: "dshAc_updated",
	pillWrap: "dshAc_pillWrap",
	pillDanger: "dshAc_pillDanger",
	tool: "dshAc_tool",
	body: "dshAc_body",
	group: "dshAc_group",
	groupHeader: "dshAc_groupHeader",
	chevron: "dshAc_chevron",
	groupName: "dshAc_groupName",
	groupBody: "dshAc_groupBody",
	groupClip: "dshAc_groupClip",
	list: "dshAc_list",
	item: "dshAc_item",
	link: "dshAc_link",
	line1: "dshAc_line1",
	line2: "dshAc_line2",
	glyph: "dshAc_glyph",
	titleText: "dshAc_titleText",
	mine: "dshAc_mine",
	overdue: "dshAc_overdue",
	openIcon: "dshAc_openIcon",
	more: "dshAc_more",
	note: "dshAc_note",
	status: "dshAc_status",
	statusLine: "dshAc_statusLine",
	statusCode: "dshAc_statusCode",
	statusActions: "dshAc_statusActions",
	card: "dshAc_card",
	cardTitle: "dshAc_cardTitle",
	cardBody: "dshAc_cardBody",
	cardCode: "dshAc_cardCode",
	skeleton: "dshAc_skeleton",
	skeletonBar: "dshAc_skeletonBar",
	srOnly: "dshAc_srOnly",
	hoverCard: "dshAc_hoverCard",
	hoverTitle: "dshAc_hoverTitle",
	hoverGrid: "dshAc_hoverGrid",
	hoverRow: "dshAc_hoverRow",
	hoverKey: "dshAc_hoverKey",
	hoverValue: "dshAc_hoverValue",
	hoverHint: "dshAc_hoverHint"
};
/** 取 RemoteFailure 的稳定 code（判 ok 后的错误分支一律按 code 分流，不看 message 措辞） */
function failureCode(error) {
	return typeof error?.code === "string" ? error.code : "unknown";
}
/** 状态呈现查表（未知态兜底 outline，不发明 tone） */
function presentationOf(status) {
	return STATUS_PRESENTATION[status] ?? UNKNOWN_STATUS_PRESENTATION;
}
/** ISO → 毫秒（NaN 安全）；非法/缺失一律 null，调用方据此省略整段展示 */
function parseTime(iso) {
	if (iso === null || iso === "") return null;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}
/** pad2（时间格式的确定性，不依赖 locale：面板与 host 同机，展示按本机时区） */
function pad2(n) {
	return String(n).padStart(2, "0");
}
/** ISO → `YYYY-MM-DD HH:mm`（HoverCard / 逾期 tooltip 的精确时刻；非法值原样回显不吞事实） */
function formatDateTime(iso) {
	const ms = parseTime(iso);
	if (ms === null) return iso;
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** ISO → 仅日期（截止日的可读形态；时刻对「哪天截止」无增量信息） */
function formatDate(iso) {
	const ms = parseTime(iso);
	if (ms === null) return iso;
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/**
* 相对时间文案（plan §4「更新于 x 秒前」/ 二线 updatedAt）。
* 为什么 <60s 自算：shell 的 relativeTime 最小档是 minutes（单位枚举 now|minutes|…，无 seconds），
* 「x 秒前」必须自己补；≥60s 一律交给官方 relativeTime（单位分档与 shell 完全一致），仅做中文映射。
*/
function relativeText(ms, now) {
	const delta = now - ms;
	if (delta < 6e4) return `${Math.max(0, Math.floor(delta / 1e3))} 秒前`;
	const { unit, n } = relativeTime(ms, now);
	switch (unit) {
		case "minutes": return `${n} 分钟前`;
		case "hours": return `${n} 小时前`;
		case "days": return `${n} 天前`;
		case "months": return `${n} 个月前`;
		case "years": return `${n} 年前`;
		default: return "刚刚";
	}
}
/** ISO → 相对时间（非法/缺失返回 null，调用方省略该段而不是印假时间） */
function relativeFromIso(iso, now) {
	const ms = parseTime(iso);
	return ms === null ? null : relativeText(ms, now);
}
/**
* 逾期判定 + 文案（plan §4：dueDate 逾期才前置红）。未逾期/无截止/非法 → null。
* 不足一天的逾期印「已逾期」——「逾期 0 天」是自相矛盾的文案。
*/
function overdueLabel(iso, now) {
	const ms = parseTime(iso);
	if (ms === null || ms >= now) return null;
	const days = Math.floor((now - ms) / 864e5);
	return days >= 1 ? `逾期 ${days} 天` : "已逾期";
}
/** 读折叠态记忆（形状校验：只接受 boolean 值；任何异常按「无记忆」处理，不阻断面板） */
function readCollapsedBoards() {
	try {
		const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
		if (raw === null) return {};
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const out = {};
		for (const [key, value] of Object.entries(parsed)) if (typeof value === "boolean") out[key] = value;
		return out;
	} catch {
		return {};
	}
}
/** 写折叠态记忆（配额/隐私模式失败静默——记忆是体验优化，不是功能依赖） */
function writeCollapsedBoards(next) {
	try {
		window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
	} catch {}
}
/**
* 状态指示（plan §4 状态映射表逐字，一线唯一指示）：
* - in_progress → StateDot(state='ongoing')，官方像素矩阵动效零自造；Tooltip 补可读语义（圆点无文字）；
* - 其余四态 → Tag tone（neutral/info/danger/success）。
* 为什么 Tag 不套 Tooltip：Tooltip 走 cloneElement + ref 注入，Tag 是非 forwardRef 函数组件会丢 ref
* （静默失效）——故 Tag 用 title 原生提示，语义由 Tag 自带文本承担。
*/
function StatusGlyph({ status }) {
	const presentation = presentationOf(status);
	if (presentation.kind === "dot") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tooltip, {
		label: presentation.label,
		side: "bottom",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: styles.glyph,
			role: "img",
			"aria-label": presentation.label,
			"data-chamber-task-status": status,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StateDot, {
				state: presentation.state,
				size: 10
			})
		})
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: styles.glyph,
		title: presentation.label,
		"data-chamber-task-status": status,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tag, {
			tone: presentation.tone,
			children: presentation.label
		})
	});
}
/**
* 「更新于 x 秒前」（plan §4）：每秒自 tick 的独立组件——相对秒数要活，但整面板不能每秒重渲染
* （重渲染成本随行数增长），故 tick 关在最小组件内（React 状态隔离，父组件零代价）。
* 首载/隐藏期不 tick 的取舍：本组件只在 ready 面板出现，1s 定时器开销可忽略（无可见性分支）。
*/
function UpdatedAt({ iso }) {
	const [now, setNow] = (0, react.useState)(() => Date.now());
	(0, react.useEffect)(() => {
		const timer = setInterval(() => setNow(Date.now()), 1e3);
		return () => clearInterval(timer);
	}, []);
	const text = relativeFromIso(iso, now);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: styles.updated,
		"data-chamber-fetched-at": iso,
		children: text === null ? "更新时间未知" : `更新于 ${text}`
	});
}
/**
* 任务 HoverCard 内容（plan §4 钻取层：listName/assignee/labels + dueDate 非逾期入卡）。
* 卡片底色由官方 HoverCard 固定（--dsw-hovercard-bg），故卡内文字色照 workspace hoverContent 先例
* 写死浅色（#fff / #cfd3d6）——这不是「手写暗色分支」，官方卡在任何主题下都是深色。
*/
function TaskHoverContent({ task }) {
	const fields = [{
		key: "状态",
		value: presentationOf(task.status).label
	}];
	if (task.priority !== null && task.priority !== "") fields.push({
		key: "优先级",
		value: PRIORITY_FULL_LABEL[task.priority] ?? task.priority.toUpperCase()
	});
	if (task.listName !== null) fields.push({
		key: "看板列",
		value: task.listName
	});
	if (task.assigneeName !== null) fields.push({
		key: "负责人",
		value: task.assigneeName
	});
	if (task.labels.length > 0) fields.push({
		key: "标签",
		value: task.labels.join("、")
	});
	if (task.dueDate !== null) fields.push({
		key: "截止",
		value: formatDate(task.dueDate)
	});
	if (task.updatedAt !== null) fields.push({
		key: "更新",
		value: formatDateTime(task.updatedAt)
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: styles.hoverCard,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: styles.hoverTitle,
				children: task.title
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: styles.hoverGrid,
				children: fields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: styles.hoverRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.hoverKey,
						children: field.key
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.hoverValue,
						children: field.value
					})]
				}, field.key))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: styles.hoverHint,
				children: "点击此行在平台打开"
			})
		]
	});
}
/**
* 单任务行（plan §4 信息三级 + 批 3 规格 ⑫/⑬）：
* 一线 = 状态指示 +（逾期预警） + title（ellipsis）+ isMine「·我」+ 深链图标；
* 二线 = 12px tertiary 单行（priority + updatedAt 相对时间，任一段缺失即省略，绝不印占位符）；
* 钻取 = 整行 HoverCard（listName/assignee/labels/dueDate/priority 全称）。
* 整行是 <a target="_blank" rel="noopener noreferrer">：键盘 Tab 可达、回车即开平台任务页。
* dueDate 非逾期「入 HoverCard」= 一行内不占位（密度纪律），信息在卡的「截止」字段。
* @param taskUrlBase 深链基座（host 推导，含尾斜杠）——跨域部署由绑定 webBaseUrl 覆盖，勿在消费侧再拼域；
* 缺省（旧版 host 无契约字段）时标题降级纯文本，不渲染 <a>
*/
function TaskRow({ task, taskUrlBase }) {
	const now = Date.now();
	const overdue = overdueLabel(task.dueDate, now);
	const relativeUpdated = relativeFromIso(task.updatedAt, now);
	const meta = [task.priority === null || task.priority === "" ? null : task.priority.toUpperCase(), relativeUpdated].filter((part) => part !== null);
	const rowBody = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: styles.line1,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusGlyph, { status: task.status }),
			overdue !== null && task.dueDate !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tooltip, {
				label: `截止 ${formatDateTime(task.dueDate)}`,
				side: "bottom",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.overdue,
					"data-chamber-overdue": "true",
					children: overdue
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.titleText,
				"data-chamber-task-title": true,
				children: task.title
			}),
			task.isMine && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.mine,
				"data-chamber-task-mine": "true",
				children: "·我"
			}),
			taskUrlBase && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.openIcon,
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRightUpOutline14, {})
			})
		]
	}), meta.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: styles.line2,
		children: meta.join(" · ")
	})] });
	const anchor = taskUrlBase ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
		className: styles.link,
		href: `${taskUrlBase}${encodeURIComponent(task.id)}`,
		target: "_blank",
		rel: "noopener noreferrer",
		"data-chamber-task-link": task.id,
		children: rowBody
	}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: styles.link,
		children: rowBody
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
		className: styles.item,
		"data-chamber-task": task.id,
		"data-chamber-status": task.status,
		"data-chamber-task-mine": task.isMine ? "true" : void 0,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HoverCard, {
			anchor,
			content: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskHoverContent, { task })
		})
	});
}
/**
* 单 board 分组（plan §4 分组规则 + 批 3 规格 ⑩）：
* - single=true（boards.length===1）→ 不渲染分组头（board 名已上移面板 header），恒展开；
* - 多 board → 组头 = chevron + board 名 + 折叠态行动 Pill + 进度 Pill；折叠态由父级记忆；
* - 折叠 height 用 grid-template-rows 0fr↔1fr 过渡（唯一的折叠动效，无需魔数高度）；
*   折叠时内容 visibility:hidden（移出 Tab 序 / 移出读屏，防键盘走进不可见行）；
* - 组内 backlog 密度：非 backlog 全量 + backlog 前 5 条，其余收在「还有 N 条」后面。
* 注意：组头里的 Pill 不传 onClick（span 形态）——组头本身已是 button，嵌套 button 是非法 HTML。
*/
function BoardGroup({ board, single, collapsed, onToggle, taskUrlBase }) {
	const bodyId = (0, react.useId)();
	const [backlogExpanded, setBacklogExpanded] = (0, react.useState)(false);
	const tasks = board.tasks ?? [];
	const actionCount = tasks.filter((task) => isActionStatus(task.status)).length;
	const backlogCount = tasks.filter((task) => task.status === "backlog").length;
	const hiddenBacklog = backlogExpanded ? 0 : Math.max(0, backlogCount - BACKLOG_PREVIEW);
	const rows = [];
	let backlogSeen = 0;
	for (const task of tasks) {
		if (task.status === "backlog") {
			backlogSeen += 1;
			if (!backlogExpanded && backlogSeen > BACKLOG_PREVIEW) continue;
		}
		rows.push(task);
	}
	const progressLabel = `已完成 ${board.completedTaskCount} / 共 ${board.taskCount}`;
	const actionLabel = `${actionCount} 个待处理（已阻塞或审核中）`;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: styles.group,
		"data-chamber-board": board.id,
		children: [!single && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: styles.groupHeader,
			"aria-expanded": !collapsed,
			"aria-controls": bodyId,
			onClick: () => onToggle(board.id, !collapsed),
			"data-chamber-board-header": board.id,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.chevron,
					"data-open": collapsed ? "false" : "true",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconChevronRightOutline14, {})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.groupName,
					children: board.name
				}),
				collapsed && actionCount > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.srOnly,
					children: actionLabel
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.pillWrap,
					"aria-hidden": "true",
					title: actionLabel,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
						className: styles.pillDanger,
						children: actionCount
					})
				})] }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.spacer }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.srOnly,
					children: progressLabel
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.pillWrap,
					"aria-hidden": "true",
					title: progressLabel,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Pill, { children: [
						board.completedTaskCount,
						"/",
						board.taskCount
					] })
				})
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: styles.groupBody,
			id: bodyId,
			"data-collapsed": collapsed ? "true" : "false",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: styles.groupClip,
				children: board.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: styles.note,
					"data-chamber-board-error": board.error.code,
					children: [
						"此看板读取失败（",
						board.error.code,
						"），下轮自动重试。"
					]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
					className: styles.list,
					children: [
						rows.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskRow, {
							task,
							taskUrlBase
						}, task.id)),
						hiddenBacklog > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
							className: styles.item,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: styles.more,
								onClick: () => setBacklogExpanded(true),
								"data-chamber-more": hiddenBacklog,
								children: [
									"还有 ",
									hiddenBacklog,
									" 条"
								]
							})
						}),
						backlogExpanded && backlogCount > BACKLOG_PREVIEW && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
							className: styles.item,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: styles.more,
								onClick: () => setBacklogExpanded(false),
								children: "收起"
							})
						}),
						tasks.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
							className: styles.note,
							children: "这个看板没有活跃任务"
						})
					]
				})
			})
		})]
	});
}
/**
* 面板 header（plan §4 刷新/进度区；28px 图标钮与 38px 行高照 sidebar-files header 先例）：
* 左：面板/看板名（单 board 时 = board 名）+ 进度 Pill；右：更新态文案 + 重新拉取钮。
* 更新态三态互斥：更新中… | 更新失败 · 重试中（stale）| 更新于 x 秒前。
* 刷新钮文案刻意不提「强制」：浏览器侧无 bustCache 通路（Remote 只有零参 getPanelState），
* TTL 内返回缓存是契约内行为（plan §4 已知限制）。
*/
function PanelHeader({ title, completed, total, fetchedAt, fetching, stale, onRefresh }) {
	const progressLabel = `已完成 ${completed} / 共 ${total}`;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
		className: styles.header,
		"data-chamber-header": "true",
		"data-chamber-stale": stale ? "true" : void 0,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.title,
				"data-chamber-header-title": true,
				children: title
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.srOnly,
				children: progressLabel
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.pillWrap,
				"aria-hidden": "true",
				title: progressLabel,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Pill, { children: [
					completed,
					"/",
					total
				] })
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: styles.spacer }),
			fetching ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.updated,
				children: "更新中…"
			}) : stale ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: styles.updated,
				children: "更新失败 · 重试中"
			}) : fetchedAt === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UpdatedAt, { iso: fetchedAt }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: styles.tool,
				"aria-label": "重新拉取面板数据",
				title: "重新拉取面板数据",
				onClick: onRefresh,
				"data-chamber-refresh": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRefreshOutline16, {})
			})
		]
	});
}
/** 首载骨架条（plan §4：--dsw-alias-bg-skeleton 官方先例）——只在从未拿到数据时出现一次，轮询不重放 */
function PanelSkeleton() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: styles.root,
		"data-chamber-state": "loading",
		"aria-busy": "true",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: styles.skeleton,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.srOnly,
					children: "正在读取 Chamber 面板…"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.skeletonBar,
					style: { width: "100%" }
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.skeletonBar,
					style: { width: "82%" }
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: styles.skeletonBar,
					style: { width: "64%" }
				})
			]
		})
	});
}
/**
* 不可达（空态三分量之最重，files status/failureLine 范式）：错误文案 + 错误码 + 重试钮。
* 重试钮是「立刻再试一次」，不是「强制刷新」；轮询仍在跑，故文案说明 30s 自动重试。
*/
function UnreachableState({ code, message, onRetry }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: styles.root,
		"data-chamber-state": "error",
		"data-chamber-error-code": code,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: styles.status,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: styles.statusLine,
					children: [
						"暂时读不到 Chamber 面板：",
						message === "" ? "远端未返回原因" : message,
						"。"
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: styles.statusCode,
					children: [
						"错误码 ",
						code,
						" · 每 30 秒自动重试"
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: styles.statusActions,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						onClick: onRetry,
						children: "重试"
					})
				})
			]
		})
	});
}
/**
* 未绑定家族（空态三分量之中）：收窄引导卡。unbound 与 unauthorized 同家族不同文案——
* unauthorized（401/403）重试必然同样失败，故意不给重试钮（否则是假承诺），指向绑定文件重配。
* 两个状态都给出「重配后 1 分钟内自动生效」：host 侧绑定每次抓取现场解析，但结果缓存 TTL=60s
* （remote.mjs 注释实证），所以最快生效时间就是 TTL 到期。
*/
function BindingCard({ reason }) {
	const unbound = reason === "unbound";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: styles.root,
		"data-chamber-state": reason,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: styles.card,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: styles.cardTitle,
				children: unbound ? "未绑定 Chamber 平台" : "Chamber key 失效或无权限"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: styles.cardBody,
				children: unbound ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					"这个项目还没有绑定：在项目根写入 ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.cardCode,
						children: ".agent-chamber/agent-chamber.json"
					}),
					"， 填 ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.cardCode,
						children: "apiBaseUrl"
					}),
					" 与 ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.cardCode,
						children: "apiKey"
					}),
					"，最多 1 分钟内自动生效。"
				] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					"平台拒绝了当前凭据（401/403）。请在",
					" ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.cardCode,
						children: ".agent-chamber/agent-chamber.json"
					}),
					" 里换成有效的",
					" ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.cardCode,
						children: "apiKey"
					}),
					" 后等待重连——这个状态重试不会自愈。"
				] })
			})]
		})
	});
}
/**
* 面板主体：30s 轮询 remote.chamber.getPanelState()（plan §2）+ visibilitychange 暂停
* （plan §5.4：React effect cleanup + 页面隐藏不拉取，回可见立即补一拍）。
* 状态合并纪律（批 3 规格 ⑧）：成功才有新 value；失败只记 error/stale，已有数据一律留着渲染
* ——轮询失败不闪骨架、不白屏，面板作为环境感知面的连续性优先于「精确错误页」。
*/
function ChamberPanel(props) {
	const [model, setModel] = (0, react.useState)({
		phase: "loading",
		value: null,
		error: null,
		stale: false
	});
	const [fetching, setFetching] = (0, react.useState)(false);
	const [collapsed, setCollapsed] = (0, react.useState)(() => readCollapsedBoards());
	/**
	* fetchPanelState 入 ref：槽位 inject 工厂产物的交付时机/引用稳定性不进契约
	* （filesFace 先例为每 tab 一次，但不赌），ref 化后 tick 依赖归零、轮询不被重建。
	*/
	const fetchRef = (0, react.useRef)(props.fetchPanelState);
	fetchRef.current = props.fetchPanelState;
	/** 卸载标记：迟到的 promise 不落 setState（React 纪律）；同时被轮询 effect 与手动刷新共用 */
	const aliveRef = (0, react.useRef)(true);
	/** 重入闸：手动刷新与轮询拍可叠加，闸掉重复请求（host 侧虽 single-flight，浏览器侧也没必要排队） */
	const inFlightRef = (0, react.useRef)(false);
	/** 折叠态 ref 镜像：持久化要在 setState updater 之外写（updater 必须纯净，StrictMode 会双调） */
	const collapsedRef = (0, react.useRef)(collapsed);
	collapsedRef.current = collapsed;
	const tick = (0, react.useCallback)(async (opts) => {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
		if (inFlightRef.current) return;
		const fetchPanelState = fetchRef.current;
		if (!fetchPanelState) {
			setModel((prev) => ({
				phase: prev.value === null ? "error" : "ready",
				value: prev.value,
				error: {
					code: "not-mounted",
					message: "面板数据通道未就位"
				},
				stale: prev.value !== null
			}));
			return;
		}
		inFlightRef.current = true;
		if (opts?.manual) setFetching(true);
		try {
			const result = await fetchPanelState();
			if (!aliveRef.current) return;
			if (result.ok) setModel({
				phase: "ready",
				value: result.value,
				error: null,
				stale: false
			});
			else {
				const error = {
					code: failureCode(result.error),
					message: result.error?.message ?? ""
				};
				setModel((prev) => ({
					phase: prev.value === null ? "error" : "ready",
					value: prev.value,
					error,
					stale: prev.value !== null
				}));
			}
		} catch (error) {
			if (aliveRef.current) setModel((prev) => ({
				phase: prev.value === null ? "error" : "ready",
				value: prev.value,
				error: {
					code: "call-failed",
					message: String(error)
				},
				stale: prev.value !== null
			}));
		} finally {
			inFlightRef.current = false;
			if (opts?.manual && aliveRef.current) setFetching(false);
		}
	}, []);
	(0, react.useEffect)(() => {
		aliveRef.current = true;
		tick();
		const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
		const onVisibilityChange = () => {
			if (typeof document !== "undefined" && document.visibilityState === "visible") tick();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			aliveRef.current = false;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [tick]);
	/**
	* 折叠态写路径：ref 镜像出完整 record → setState + 持久化（localStorage 记忆，plan §4）。
	* 显式传 next 而非取反：默认折叠由「有无行动项」推导，取反会与默认值打架。
	*/
	const setBoardCollapsed = (0, react.useCallback)((boardId, next) => {
		const merged = {
			...collapsedRef.current,
			[boardId]: next
		};
		collapsedRef.current = merged;
		setCollapsed(merged);
		writeCollapsedBoards(merged);
	}, []);
	const refresh = (0, react.useCallback)(() => {
		tick({ manual: true });
	}, [tick]);
	if (model.phase === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelSkeleton, {});
	if (model.phase === "error" || model.value === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UnreachableState, {
		code: model.error?.code ?? "unknown",
		message: model.error?.message ?? "",
		onRetry: refresh
	});
	const state = model.value;
	if (state.bound === false) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BindingCard, { reason: state.reason });
	const boards = state.boards;
	const taskUrlBase = typeof state.taskUrlBase === "string" && state.taskUrlBase !== "" ? state.taskUrlBase : void 0;
	const single = boards.length === 1;
	const completedTotal = boards.reduce((sum, board) => sum + board.completedTaskCount, 0);
	const taskTotal = boards.reduce((sum, board) => sum + board.taskCount, 0);
	const activeCount = boards.reduce((sum, board) => sum + (board.tasks?.length ?? 0), 0);
	const hasBoardError = boards.some((board) => board.error !== void 0);
	const showEmpty = activeCount === 0 && !hasBoardError;
	const headerTitle = single ? boards[0]?.name ?? "Chamber" : "全部看板";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: styles.root,
		"data-chamber-state": showEmpty ? "empty" : "ready",
		"data-chamber-partial": state.partial ? "true" : "false",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelHeader, {
			title: headerTitle,
			completed: completedTotal,
			total: taskTotal,
			fetchedAt: state.fetchedAt,
			fetching,
			stale: model.stale,
			onRefresh: refresh
		}), showEmpty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: styles.note,
			"data-chamber-empty": "true",
			children: "当前没有活跃任务。"
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: styles.body,
			children: boards.map((board) => {
				const boardActions = (board.tasks ?? []).some((task) => isActionStatus(task.status));
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BoardGroup, {
					board,
					single,
					collapsed: single ? false : collapsed[board.id] ?? !(boardActions || board.error !== void 0),
					onToggle: setBoardCollapsed,
					taskUrlBase
				}, board.id);
			})
		})]
	});
}
/**
* tab 静态定义（tab-registry.d.ts SidebarRightTabDefinition 实证形状）：
* - priority 省略 = 'extension'（外部类型默认 band，官方注释：「a type that says nothing is one
*   from outside the product」——本插件正是外部类型；files 写 'builtin' 因为它是产品内置）；
* - title(address)：tab chip 初始文本，page 类型按 kind 打开，address 为 sidebar://chamber；
* - guide：右栏 guide 页胶囊入口（点击即 openTab('chamber')），是面板的首达路径
*   （右栏「New tab」→ 胶囊「Chamber 任务面板」），故 description 写足「是什么 + 怎么用」；
*   icon 取 shell 的 checklist 图标（guide 条目 icon?: ComponentType<IconProps>，实证形状），
*   有图标就不落 guide 的占位方块；order 30 排在 files(10) 之后，避免撞内置类型排序位。
*/
function chamberDefinition() {
	return {
		id: CHAMBER_ID,
		kind: CHAMBER_KIND,
		title: () => "Chamber",
		guide: [{
			order: 30,
			title: () => "Chamber 任务面板",
			icon: IconChecklistOutline14,
			description: () => "我参与的看板与活跃任务（待办 / 待开始 / 进行中 / 已阻塞 / 审核中），30 秒自动刷新；点任务行在平台打开"
		}]
	};
}
/**
* 面板子插件 apply（inject: ['remote.chamber','slots','sidebarRightTabs'] 满足后才激活）：
* 两段式挂槽照抄 sidebar-files 先例——
*   ① sidebarRightTabs.register：注册「类型是什么」（静态面，无运行时钩子）；
*   ② slots.inject('sidebar.right.pane.tab', …register)：等槽位声明在场后注册 keyed 条目
*      （key = tab 定义 id，dispatch 按「该 kind 在力类型的 id」寻址）。
* 槽位声明的 inject 字段 = 数据通道工厂（filesFace 同款范式）：闭包捕获 ctx，
* 产物方法作为 props 注入组件——组件不直接碰 ctx，保持纯 props 渲染。
*/
function applyPanel(ctx) {
	ctx.effect(() => ctx.sidebarRightTabs.register(chamberDefinition()), "agent-chamber: chamber tab type");
	ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
		name: "sidebar.right.pane.tab",
		key: CHAMBER_ID,
		inject: () => ({ fetchPanelState: () => ctx.remote.chamber.getPanelState() })
	}, ChamberPanel)), "agent-chamber: chamber tab body");
}
/**
* 入口 fiber 服务依赖：只写 ['remote']（官方 mounter dsh-api-remotes 先例：inject = ["remote"]）。
* ⚠️ 死锁红线（plan §5.7）：本 bundle 自己 $mount 的 namespace（remote.chamber）严禁出现在
* 本数组——inject 未满足则 fiber INACTIVE、apply 永不执行、namespace 永不注册，自相死锁。
* slots/sidebarRightTabs 也不写：它们由面板子 fiber 自己的 inject 声明，入口不需要。
* 包级加载序由 package.json dsh.client.inject（sidebar-right + gateway 两包）保证。
*/
const inject = ["remote"];
/**
* 入口 apply：手写 strict contribution 经 ctx.remote.$mount 挂载（plan §5.3 代码块形态），
* 完成后 ctx.plugin 挂面板子 fiber。同步 apply + ctx.effect 包裹（而非官方 mounter 的
* async apply 直等）——理由：$mount 失败（descriptor 违例/网关缺席）只降级日志，不让
* 入口 fiber 激活失败拖出插件加载错误（面板缺席 ≠ boot 受损，与 node 半面故障隔离同款哲学）。
* @param ctx 客户端根 Context（inject=['remote'] 保证 ctx.remote 在场）
*/
function apply(ctx) {
	ctx.effect(() => {
		const mounted = ctx.remote.$mount(CHAMBER_CONTRIBUTION);
		mounted.then(() => {
			ctx.plugin({
				name: "dsh-agent-chamber/panel",
				inject: [
					"remote.chamber",
					"slots",
					"sidebarRightTabs"
				],
				apply: applyPanel
			});
		}, (error) => {
			ctx.logger?.error?.(`[agent-chamber] client: remote mount failed error=${String(error)}`);
		});
		return () => {
			mounted.then((dispose) => dispose(), () => void 0);
		};
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;
		return module.exports;
	}
});