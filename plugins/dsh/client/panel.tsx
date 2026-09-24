// panel.tsx — dsh 插件浏览器半面「Chamber 任务面板」（批 3 视觉精修；plan §3 数据契约 / §4 UX 终稿 /
// §5 技术要点逐字规格）。职责：右栏注册 Chamber tab（两段式），经 remote.chamber.getPanelState()
// 拉真实数据，行式渲染 boards × 五态活跃任务（只读环境感知面，零写操作）。
//
// 【批 3 落点（视觉/交互终稿，逐条对齐 plan §4 + 批 3 规格钉死）】
//   ① 状态映射表：backlog→Tag neutral / todo→Tag info / in_progress→StateDot ongoing（不用 Tag）/
//      blocked→Tag danger / review→Tag success——一线单一指示，不混用。
//   ② isMine 高亮：标题尾随「·我」（二选一取文本形态；禁背景色/边条，plan §4 的 accent 边被批 3 规格否决）。
//   ③ dueDate：逾期 → 一线前置 warn-label（--dsw-alias-state-warn-label）；非逾期 → 入 HoverCard 钻取。
//   ④ Pill 只中性：组件本身无 tone（primitive 契约），进度用 completedTaskCount/taskCount；折叠组 Pill
//      专数 blocked+review 行动项（0 不渲染；折叠态且有行动项 → pillDanger 类转 danger 色）。
//   ⑤ 动效预算 = 2：hover 背景（--ds-transition-duration-fast）+ 折叠 height（--ds-transition-duration-slow，
//      grid-template-rows 0fr/1fr），easing --ds-ease-in-out；reduced-motion 官方范式（animation/transition:none）兜底。
//      无 stagger / FLIP / 呼吸脉冲；chevron 旋转即时无过渡（不占预算）。
//   ⑥ 颜色一律 --dsw-alias-* token（暗色由 body[data-ds-dark-theme] 在 token 层适配，本文件零暗色分支）。
//   ⑦ 空态三分量：不可达（错误文案+重试钮）≥ 未绑定（引导卡收窄版）≫ 全绿（单行 tertiary 低调，不庆祝）；
//      unauthorized 专属文案（key 失效/无权限 + 指向 .agent-chamber/agent-chamber.json 重配），不与不可达同流。
//   ⑧ 首载骨架条（--dsw-alias-bg-skeleton）；轮询刷新静默——有数据时失败只标记 stale，绝不清空重绘骨架。
//   ⑨ 刷新钮：header 内 28px 图标钮（IconRefreshOutline16 + aria-label + title，照 sidebar-files header
//      .tool 先例）。已知限制：浏览器侧无 bustCache 通路（Remote 仅零参 getPanelState），TTL 内返回缓存属预期
//      ——文案只说「重新拉取」，不做「强制刷新」承诺。
//   ⑩ board 分组：boards.length===1 退化分组头 + board 名上移面板 header；多 board 时有行动项的组默认展开、
//      其余折叠；折叠态 localStorage 记忆（记忆不得静音行动信号：折叠 + 行动项 → Pill danger）。
//   ⑪ 组内 backlog 密度：默认前 5 条 +「还有 N 条」展开（展开后可收起）。
//   ⑫ 行密度：首行块 min-height 32px（jobs 行 min-height:32px / padding 6px 8px 先例的密度量级），
//      二线 12px --dsw-alias-label-tertiary 单行（priority + updatedAt 相对时间）；listName/assignee/labels
//      一律下钻到 HoverCard，二线永不折行（ellipsis）。
//   ⑬ 深链：整行 <a target="_blank" rel="noopener noreferrer"> → <taskUrlBase><taskId>；
//      基座由 host 从绑定配置推导（apiBaseUrl 剥 /api/v1 或显式 webBaseUrl 覆盖）；
//      旧版 host 无此契约字段时不渲染链接，标题降级纯文本（开源中性：不硬编码任何实例域）。
//   ⑭ guide 胶囊文案承担首达引导（description 写全「是什么 + 怎么用」）。
//
// 【死锁红线（plan §5.7，architect 终稿 M1）】本入口 fiber 的 inject 严禁含 'remote.chamber'——
//   自己 $mount 的 namespace 进 inject = fiber 永不激活 = namespace 永不注册，自相死锁。
//   故入口 inject 只写 ['remote']（官方 mounter dsh-api-remotes 同款先例），面板逻辑在
//   $mount 完成后经 ctx.plugin({ inject:['remote.chamber','slots','sidebarRightTabs'] }) 挂子 fiber。
// 【$mount 独占（plan §5.3）】remote.<ns> 是 $mount 独占，无 Proxy 兜底——浏览器消费 Typert
//   Remote 的唯一通路是手写 strict contribution + ctx.remote.$mount（官方 mounter 先例实证：
//   dsh-api-remotes/lib/client.js `await ctx.remote.$mount(contribution)`）。
// 【挂槽先例】两段式照抄 dsh-client-ui-sidebar-files：① sidebarRightTabs.register(静态定义)
//   ② slots.inject('sidebar.right.pane.tab', () => slots.register({name,key,inject}, Body))——
//   key 必须等于 tab 定义的 id（keyed 槽按「在力类型的 id」分派）。
// 【副作用纪律】本模块经 window.__ModuleLoader__.load 的 factory 闭包加载（tsdown 包装），
//   注册/轮询等副作用一律关在 apply/组件内，模块顶层只允许两处「materialize 期」语句（与官方
//   client bundle 同形，非脚本执行期副作用）：① 种子词模块 require 取用；② CSS shim 注入（见下）。
//   官方先例：dsh-client-ui-sidebar-files/lib/client.js 的 FilesBody.module.css shim 即模块顶层注入。
// 【primitives 取用为何走 require（而非静态 import）】@deepseek-ai/dsh-client-ui-primitives 是 shell
//   种子词（web boot staticModules 实证：by() 表内 'dsh-client-ui-primitives': Zg），只在浏览器运行时
//   存在——磁盘上没有该包也没有 .d.ts，静态 import 会让 tsc 报 TS2307 且绑定退化成 any。故用 ModuleLoader
//   factory 注入的 require 取用（等价于 external 静态 import 的产物形态 require(...)），并在此处按
//   /tmp/primitives-contract.md 的实证契约本地声明消费面类型——类型不丢，仍是严格契约。
// 铁律 #11：常量/字段/方法 rationale 一律注释。

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';

// ———————————————————————————— shell primitives 桥（契约本地声明 + require 取用） ————————————————————————————
// 契约来源：shell bundle 实证提取（/tmp/primitives-contract.md）+ 本次复查 dsh-web-frontend/dist
// index-BKQ_L1z6.js 组件实现与 index-DPX2bQLO.css 枚举值：Tag {tone,className,children} 8 tone；
// StateDot {state,size=10}；Pill {active,className,children,onClick?}（无 tone，onClick 才渲染 button）；
// Tooltip {label,side='right',delayMs,disabled,maxWidth,children}（cloneElement 子元素 → 子元素必须是
// 能接 ref 的宿主元素，禁止拿函数组件当子元素）；HoverCard {anchor,content,openDelayMs=500,disabled,
// copyText,copyLabel,copiedLabel}（anchor 为 ReactNode，非 clone）。

/** Tag 的 tone 枚举（CSS 实证 8 值；本面板只用 neutral/info/danger/success + outline 兜底未知态） */
type TagTone = 'danger' | 'info' | 'neutral' | 'outline' | 'quiet' | 'solid' | 'success' | 'warning';

/** 图标 props（shell 图标统一 {size=16,className}；本文件只用默认尺寸加类名） */
interface IconProps {
  size?: number;
  className?: string;
}

/** Tag：状态徽标（pill 形，11px/17px，padding 1px 8px） */
interface TagProps {
  tone?: TagTone;
  className?: string;
  children?: ReactNode;
}

/** StateDot：状态圆点（size 默认 10；state='ongoing' 走像素矩阵 SVG 动效） */
interface StateDotProps {
  state: string;
  size?: number;
  className?: string;
}

/** Pill：中性计数胶囊（无 tone prop；带 onClick 才渲染 button，本面板只用 span 形态避开嵌套按钮） */
interface PillProps {
  active?: boolean;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
}

/** Tooltip：延迟悬浮提示（children 走 cloneElement，必须是宿主元素） */
interface TooltipProps {
  label: string;
  side?: 'right' | 'left' | 'top' | 'bottom';
  delayMs?: number;
  disabled?: boolean;
  maxWidth?: number;
  children: ReactElement;
}

/** HoverCard：悬浮钻取卡（anchor 是普通节点，内容 portal 到 body） */
interface HoverCardProps {
  anchor: ReactNode;
  content: ReactNode;
  openDelayMs?: number;
  disabled?: boolean;
  copyText?: string;
  copyLabel?: string;
  copiedLabel?: string;
}

/** Button：官方按钮（variant/size 枚举实证：ghost|primary|outline|toolbar × md(36px)|sm(28px)） */
interface ButtonProps {
  variant?: 'ghost' | 'primary' | 'outline' | 'toolbar';
  size?: 'sm' | 'md';
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: 'button';
}

/** relativeTime 的返回单位（shell 实现实证：now|minutes|hours|days|months|years，无 seconds 档） */
type RelativeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years';

/** 本面板消费的 primitives 面（最小集，全部有实证出处；未导出者不得使用） */
interface PrimitivesModule {
  Tag: ComponentType<TagProps>;
  StateDot: ComponentType<StateDotProps>;
  Pill: ComponentType<PillProps>;
  Tooltip: ComponentType<TooltipProps>;
  HoverCard: ComponentType<HoverCardProps>;
  Button: ComponentType<ButtonProps>;
  IconRefreshOutline16: ComponentType<IconProps>;
  IconRightUpOutline14: ComponentType<IconProps>;
  IconChevronRightOutline14: ComponentType<IconProps>;
  IconChecklistOutline14: ComponentType<IconProps>;
  relativeTime: (timestamp: number, now: number) => { unit: RelativeUnit; n: number };
}

/**
 * ModuleLoader factory 的 require（tsdown 包装 banner 注入的参数，浏览器运行时由 client-modules
 * 惰性 CJS 模型解析种子词）。declare 只声明本模块作用域内的形态，不污染全局。
 */
declare const require: (id: string) => PrimitivesModule;

const {
  Tag,
  StateDot,
  Pill,
  Tooltip,
  HoverCard,
  Button,
  IconRefreshOutline16,
  IconRightUpOutline14,
  IconChevronRightOutline14,
  IconChecklistOutline14,
  relativeTime,
} = require('@deepseek-ai/dsh-client-ui-primitives');

// ———————————————————————————— 数据契约镜像（host → browser，纯 JSON） ————————————————————————————
// 唯一事实来源 = plugins/dsh/lib/remote.mjs 的 PanelState 组装代码；此处仅作结构化消费镜像，
// 字段逐字对齐 plan §3（批 2 冻结 host 侧，浏览器按形状自律解析）。

/** 活跃五态（plan §1/§3 写死；done 不进面板）。host 已完成组内排序（review 最前），client 不重排 */
type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'review';

/**
 * TaskEntry 九键（remote.mjs toTaskEntry 实证）：priority 平台词汇 p0/p1/p2/p3（可能 null）；
 * dueDate/updatedAt = ISO 字符串或 null（remote.mjs 注释实证，原样透传）；
 * isMine 由 host 算好（assigneeName vs 简报身份名，trim+大小写不敏感），浏览器纯消费。
 */
interface TaskEntry {
  id: string;
  title: string;
  status: TaskStatus | string;
  priority: string | null;
  listName: string | null;
  labels: string[];
  assigneeName: string | null;
  dueDate: string | null;
  updatedAt: string | null;
  isMine: boolean;
}

/** BoardEntry：tasks/error 二选一（单 board 失败降级为 error:{code}，architect-M4） */
interface BoardEntry {
  id: string;
  name: string;
  taskCount: number;
  completedTaskCount: number;
  tasks?: TaskEntry[];
  error?: { code: string };
}

/** PanelState 二变体（plan §3 逐字）：未绑定家族（unbound/unauthorized 专属空态）| 正常聚合 */
type PanelState =
  | { bound: false; reason: 'unbound' | 'unauthorized' }
  // taskUrlBase（2026-09-18 契约扩展）：任务深链基座，host 从绑定配置推导（含尾斜杠，直接拼 taskId）。
  // 可选 = 向后兼容：旧版 host 无此字段，消费侧不渲染深链（标题纯文本降级）。
  | { bound: true; fetchedAt: string; partial: boolean; boards: BoardEntry[]; taskUrlBase?: string };

/**
 * RemoteResult（dsh-typert-protocol types.d.ts 实证形状）：网关把 carrier 失败也折进 error
 * 分支，消费侧判 ok 即可；error 是重建的 RemoteError（判别一律看 code，不看 instanceof）。
 */
type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message?: string } };

// ———————————————————————————— 最小 cordis 类型（本地声明，避免跨包类型依赖） ————————————————————————————

/**
 * 本文件消费的 cordis Context 最小面（真实类型在 @deepseek-ai/cordis，shell 种子词）：
 * 结构镜像仅供 TS 检查；运行时行为以 dsh-api-gateway/dsh-client-ui-sidebar-files 实证为准。
 */
interface CordisContext {
  /** effect 注册：disposer 随 fiber 卸载回收（gateway client $mount 内部同款用法） */
  effect: (fn: () => void | (() => void), name?: string) => unknown;
  /** 挂子插件 fiber：inject 满足后激活 apply（gateway createNamespace 同款用法） */
  plugin: (meta: { name?: string; inject?: string[]; apply: (ctx: CordisContext) => void }) => unknown;
  /** cordis LoggerService 四方法（index.mjs 注释实证） */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  /** 服务面：由 inject 声明保证在场 */
  remote?: {
    $mount: (contribution: typeof CHAMBER_CONTRIBUTION) => Promise<() => Promise<void>>;
    chamber?: { getPanelState: () => Promise<RemoteResult<PanelState>> };
  };
  slots?: {
    inject: (key: string, callback: () => () => void) => () => void;
    register: (declaration: object, component: unknown) => () => void;
  };
  sidebarRightTabs?: { register: (definition: object) => () => void };
}

// ———————————————————————————— 常量（rationale 逐条注释） ————————————————————————————

/** tab 类型定义与 keyed 槽注册的同一身份键（包名即自然值，tab-registry.d.ts 注释先例） */
const CHAMBER_ID = 'dsh-agent-chamber';

/** tab 类型判别词：openTab('chamber') 的寻址键；全局唯一即可，取语义短名 */
const CHAMBER_KIND = 'chamber';

/**
 * 面板轮询间隔（ms）：plan §2 数据流写死 30s；host 侧 TTL 60s + single-flight，
 * 多 tab 首击不穿透，30s 轮询对平台 REST 的压力可忽略。
 */
const POLL_INTERVAL_MS = 30_000;

/**
 * 折叠态 localStorage 键（plan §4：折叠态 localStorage 记忆）。单键存 Record<boardId, boolean>，
 * 与 host 无关（纯浏览器偏好）；读写全 try/catch——隐私模式/配额异常时记忆失效但不影响面板。
 */
const COLLAPSE_STORAGE_KEY = 'dsh-agent-chamber:collapsed-boards';

/** 组内 backlog 默认条数（plan §4：默认前 5 条 +「还有 N 条」展开） */
const BACKLOG_PREVIEW = 5;

/**
 * 状态呈现映射表（plan §4 状态映射表逐字）：四态 Tag tone + in_progress 专走 StateDot(onoging)。
 * 文案取平台 web 端 i18n 中文词汇（tasks.status 逐字：待办/待开始/进行中/已阻塞/审核中）
 * ——面板与产品用同一套词，避免自造译名。
 */
type StatusPresentation =
  | { kind: 'tag'; tone: TagTone; label: string }
  | { kind: 'dot'; state: 'ongoing'; label: string };

const STATUS_PRESENTATION: Record<TaskStatus, StatusPresentation> = {
  backlog: { kind: 'tag', tone: 'neutral', label: '待办' },
  todo: { kind: 'tag', tone: 'info', label: '待开始' },
  in_progress: { kind: 'dot', state: 'ongoing', label: '进行中' },
  blocked: { kind: 'tag', tone: 'danger', label: '已阻塞' },
  review: { kind: 'tag', tone: 'success', label: '审核中' },
};

/**
 * 未知状态兜底（host 侧 status 是 string 透传，未来平台加态时不许炸面板）：outline tone + label「未知」，
 * 原始值保留在 data-chamber-task-status 属性——不发明 tone（映射表只覆盖五态），但也不丢失事实。
 */
const UNKNOWN_STATUS_PRESENTATION: StatusPresentation = { kind: 'tag', tone: 'outline', label: '未知' };

/** 行动项判定（plan §4：折叠组 Pill 专数 blocked+review）——唯一被两处复用的语义（组头 Pill / 默认展开） */
function isActionStatus(status: string): boolean {
  return status === 'blocked' || status === 'review';
}

/**
 * 优先级展示：二线只印平台词汇的紧凑形态（P0…P3，i18n 键 p0/p1/p2/p3），全称（如「P0 - 紧急」）
 * 下钻到 HoverCard——二线是密度敏感的 12px 单行，放不下全称。全称表同源于 zh-CN.json tasks.priority。
 */
const PRIORITY_FULL_LABEL: Record<string, string> = {
  p0: 'P0 - 紧急',
  p1: 'P1 - 高',
  p2: 'P2 - 中',
  p3: 'P3 - 低',
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
  package: 'dsh-agent-chamber',
  descriptors: [
    {
      id: 'dsh-agent-chamber/chamber#getPanelState',
      service: 'chamber',
      namespace: 'chamber',
      method: 'getPanelState',
      invocation: { kind: 'direct' },
      parameters: [],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-agent-chamber/chamber#getPanelState:result',
        schema: { parse: (v: unknown) => v },
      },
    },
  ],
} as const;

// ———————————————————————————— 样式（CSS Modules 形态，单文件内联 + 官方 shim 注入） ————————————————————————————
// 为什么不是 .module.css 文件：本批边界钉死「只碰 panel.tsx」（新文件 = 越界），且 tsdown.config.ts
// 冻结（无 CSS 管线）。故按官方运行时 shim 形态内联：CSS 文本常量 + data-plugin-css 去重注入 +
// 静态类名映射（等价 CSS Modules 的产物形态，官方先例 = sidebar-files FilesBody.module.css shim）。
// 类名前缀 dshAc_（DSh Agent Chamber）：全局唯一，避免与 shell/hash 类名碰撞。
// token 纪律：颜色只用 --dsw-alias-*（暗色由 body[data-ds-dark-theme] 在 token 层适配）；动效只用
// --ds-transition-duration-fast/slow + --ds-ease-in-out；唯一的字面色值出现在 HoverCard 卡内
// （官方卡片底色固定 #2C2C2E，文字色照 dsh-client-ui-workspace hoverContent 先例 #fff/#cfd3d6）。

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
const STYLE_TAG_ID = 'dsh-agent-chamber/client/panel.css';

if (
  typeof document !== 'undefined' &&
  document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') === null
) {
  const styleTag = document.createElement('style');
  styleTag.dataset.plugin = 'dsh-agent-chamber';
  styleTag.dataset.pluginCss = STYLE_TAG_ID;
  styleTag.textContent = PANEL_CSS;
  document.head.appendChild(styleTag);
}

/** 类名映射（等价 CSS Modules 产物的 default 对象；语义名 → 类名） */
const styles = {
  root: 'dshAc_root',
  header: 'dshAc_header',
  title: 'dshAc_title',
  spacer: 'dshAc_spacer',
  updated: 'dshAc_updated',
  pillWrap: 'dshAc_pillWrap',
  pillDanger: 'dshAc_pillDanger',
  tool: 'dshAc_tool',
  body: 'dshAc_body',
  group: 'dshAc_group',
  groupHeader: 'dshAc_groupHeader',
  chevron: 'dshAc_chevron',
  groupName: 'dshAc_groupName',
  groupBody: 'dshAc_groupBody',
  groupClip: 'dshAc_groupClip',
  list: 'dshAc_list',
  item: 'dshAc_item',
  link: 'dshAc_link',
  line1: 'dshAc_line1',
  line2: 'dshAc_line2',
  glyph: 'dshAc_glyph',
  titleText: 'dshAc_titleText',
  mine: 'dshAc_mine',
  overdue: 'dshAc_overdue',
  openIcon: 'dshAc_openIcon',
  more: 'dshAc_more',
  note: 'dshAc_note',
  status: 'dshAc_status',
  statusLine: 'dshAc_statusLine',
  statusCode: 'dshAc_statusCode',
  statusActions: 'dshAc_statusActions',
  card: 'dshAc_card',
  cardTitle: 'dshAc_cardTitle',
  cardBody: 'dshAc_cardBody',
  cardCode: 'dshAc_cardCode',
  skeleton: 'dshAc_skeleton',
  skeletonBar: 'dshAc_skeletonBar',
  srOnly: 'dshAc_srOnly',
  hoverCard: 'dshAc_hoverCard',
  hoverTitle: 'dshAc_hoverTitle',
  hoverGrid: 'dshAc_hoverGrid',
  hoverRow: 'dshAc_hoverRow',
  hoverKey: 'dshAc_hoverKey',
  hoverValue: 'dshAc_hoverValue',
  hoverHint: 'dshAc_hoverHint',
} as const;

// ———————————————————————————— 纯函数（时间/状态/持久化；无 React 依赖，便于推理） ————————————————————————————

/** 取 RemoteFailure 的稳定 code（判 ok 后的错误分支一律按 code 分流，不看 message 措辞） */
function failureCode(error: { code?: unknown } | undefined): string {
  return typeof error?.code === 'string' ? error.code : 'unknown';
}

/** 状态呈现查表（未知态兜底 outline，不发明 tone） */
function presentationOf(status: string): StatusPresentation {
  return STATUS_PRESENTATION[status as TaskStatus] ?? UNKNOWN_STATUS_PRESENTATION;
}

/** ISO → 毫秒（NaN 安全）；非法/缺失一律 null，调用方据此省略整段展示 */
function parseTime(iso: string | null): number | null {
  if (iso === null || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** pad2（时间格式的确定性，不依赖 locale：面板与 host 同机，展示按本机时区） */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO → `YYYY-MM-DD HH:mm`（HoverCard / 逾期 tooltip 的精确时刻；非法值原样回显不吞事实） */
function formatDateTime(iso: string): string {
  const ms = parseTime(iso);
  if (ms === null) return iso;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ISO → 仅日期（截止日的可读形态；时刻对「哪天截止」无增量信息） */
function formatDate(iso: string): string {
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
function relativeText(ms: number, now: number): string {
  const delta = now - ms;
  if (delta < 60_000) return `${Math.max(0, Math.floor(delta / 1000))} 秒前`;
  const { unit, n } = relativeTime(ms, now);
  switch (unit) {
    case 'minutes':
      return `${n} 分钟前`;
    case 'hours':
      return `${n} 小时前`;
    case 'days':
      return `${n} 天前`;
    case 'months':
      return `${n} 个月前`;
    case 'years':
      return `${n} 年前`;
    default:
      return '刚刚';
  }
}

/** ISO → 相对时间（非法/缺失返回 null，调用方省略该段而不是印假时间） */
function relativeFromIso(iso: string | null, now: number): string | null {
  const ms = parseTime(iso);
  return ms === null ? null : relativeText(ms, now);
}

/**
 * 逾期判定 + 文案（plan §4：dueDate 逾期才前置红）。未逾期/无截止/非法 → null。
 * 不足一天的逾期印「已逾期」——「逾期 0 天」是自相矛盾的文案。
 */
function overdueLabel(iso: string | null, now: number): string | null {
  const ms = parseTime(iso);
  if (ms === null || ms >= now) return null;
  const days = Math.floor((now - ms) / 86_400_000);
  return days >= 1 ? `逾期 ${days} 天` : '已逾期';
}

/** 读折叠态记忆（形状校验：只接受 boolean 值；任何异常按「无记忆」处理，不阻断面板） */
function readCollapsedBoards(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写折叠态记忆（配额/隐私模式失败静默——记忆是体验优化，不是功能依赖） */
function writeCollapsedBoards(next: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 记忆失效不影响面板 */
  }
}

// ———————————————————————————— React 组件（行式渲染 + 轮询 + 三态空态） ————————————————————————————

/**
 * 组件状态机（批 3 改造点：value 与 phase 解耦——轮询失败不清空已到数据）。
 * phase = 'loading'（首载，骨架）| 'ready'（有数据，含 bound:false 家族与全绿）| 'error'（从未拿到数据）。
 * stale = 「有数据 + 最近一次拉取失败」：静默标记，禁骨架闪烁（批 3 规格 ⑧）。
 */
interface PanelModel {
  phase: 'loading' | 'ready' | 'error';
  value: PanelState | null;
  error: { code: string; message: string } | null;
  stale: boolean;
}

/** ChamberPanel 组件 props：fetchPanelState 来自槽位声明的 inject 工厂产物（filesFace 先例同款通道） */
interface ChamberPanelProps {
  fetchPanelState?: () => Promise<RemoteResult<PanelState>>;
}

/**
 * 状态指示（plan §4 状态映射表逐字，一线唯一指示）：
 * - in_progress → StateDot(state='ongoing')，官方像素矩阵动效零自造；Tooltip 补可读语义（圆点无文字）；
 * - 其余四态 → Tag tone（neutral/info/danger/success）。
 * 为什么 Tag 不套 Tooltip：Tooltip 走 cloneElement + ref 注入，Tag 是非 forwardRef 函数组件会丢 ref
 * （静默失效）——故 Tag 用 title 原生提示，语义由 Tag 自带文本承担。
 */
function StatusGlyph({ status }: { status: string }) {
  const presentation = presentationOf(status);
  if (presentation.kind === 'dot') {
    return (
      <Tooltip label={presentation.label} side="bottom">
        <span className={styles.glyph} role="img" aria-label={presentation.label} data-chamber-task-status={status}>
          <StateDot state={presentation.state} size={10} />
        </span>
      </Tooltip>
    );
  }
  return (
    <span className={styles.glyph} title={presentation.label} data-chamber-task-status={status}>
      <Tag tone={presentation.tone}>{presentation.label}</Tag>
    </span>
  );
}

/**
 * 「更新于 x 秒前」（plan §4）：每秒自 tick 的独立组件——相对秒数要活，但整面板不能每秒重渲染
 * （重渲染成本随行数增长），故 tick 关在最小组件内（React 状态隔离，父组件零代价）。
 * 首载/隐藏期不 tick 的取舍：本组件只在 ready 面板出现，1s 定时器开销可忽略（无可见性分支）。
 */
function UpdatedAt({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const text = relativeFromIso(iso, now);
  return (
    <span className={styles.updated} data-chamber-fetched-at={iso}>
      {text === null ? '更新时间未知' : `更新于 ${text}`}
    </span>
  );
}

/** HoverCard 内的钻取字段（二线放不下的次级信息；键值对形态 = 一眼扫读） */
interface HoverField {
  key: string;
  value: string;
}

/**
 * 任务 HoverCard 内容（plan §4 钻取层：listName/assignee/labels + dueDate 非逾期入卡）。
 * 卡片底色由官方 HoverCard 固定（--dsw-hovercard-bg），故卡内文字色照 workspace hoverContent 先例
 * 写死浅色（#fff / #cfd3d6）——这不是「手写暗色分支」，官方卡在任何主题下都是深色。
 */
function TaskHoverContent({ task }: { task: TaskEntry }) {
  const fields: HoverField[] = [{ key: '状态', value: presentationOf(task.status).label }];
  if (task.priority !== null && task.priority !== '') {
    fields.push({ key: '优先级', value: PRIORITY_FULL_LABEL[task.priority] ?? task.priority.toUpperCase() });
  }
  if (task.listName !== null) fields.push({ key: '看板列', value: task.listName });
  if (task.assigneeName !== null) fields.push({ key: '负责人', value: task.assigneeName });
  if (task.labels.length > 0) fields.push({ key: '标签', value: task.labels.join('、') });
  if (task.dueDate !== null) fields.push({ key: '截止', value: formatDate(task.dueDate) });
  if (task.updatedAt !== null) fields.push({ key: '更新', value: formatDateTime(task.updatedAt) });
  return (
    <div className={styles.hoverCard}>
      <div className={styles.hoverTitle}>{task.title}</div>
      <div className={styles.hoverGrid}>
        {fields.map((field) => (
          <div key={field.key} className={styles.hoverRow}>
            <span className={styles.hoverKey}>{field.key}</span>
            <span className={styles.hoverValue}>{field.value}</span>
          </div>
        ))}
      </div>
      <div className={styles.hoverHint}>点击此行在平台打开</div>
    </div>
  );
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
function TaskRow({ task, taskUrlBase }: { task: TaskEntry; taskUrlBase?: string }) {
  const now = Date.now();
  const overdue = overdueLabel(task.dueDate, now);
  const relativeUpdated = relativeFromIso(task.updatedAt, now);
  const meta = [
    task.priority === null || task.priority === '' ? null : task.priority.toUpperCase(),
    relativeUpdated,
  ].filter((part): part is string => part !== null);

  // 行内容（line1 + line2）：深链可用时包 <a>，否则纯文本降级——开源中性，
  // 旧版 host 无 taskUrlBase 契约字段时没有可拼的基座，硬编码任何实例域都会把开源用户导向别人的部署
  const rowBody = (
    <>
      <span className={styles.line1}>
        <StatusGlyph status={task.status} />
        {/* overdue !== null 蕴含 dueDate !== null（overdueLabel 对 null 必返回 null）；并列条件纯为 TS 收窄 */}
        {overdue !== null && task.dueDate !== null && (
          <Tooltip label={`截止 ${formatDateTime(task.dueDate)}`} side="bottom">
            <span className={styles.overdue} data-chamber-overdue="true">
              {overdue}
            </span>
          </Tooltip>
        )}
        <span className={styles.titleText} data-chamber-task-title>
          {task.title}
        </span>
        {/* isMine 文本标记（批 3 规格 ②：「·我」与字重加粗二选一取文本形态；禁背景/边条） */}
        {task.isMine && (
          <span className={styles.mine} data-chamber-task-mine="true">
            ·我
          </span>
        )}
        {taskUrlBase && (
          <span className={styles.openIcon} aria-hidden="true">
            <IconRightUpOutline14 />
          </span>
        )}
      </span>
      {meta.length > 0 && <span className={styles.line2}>{meta.join(' · ')}</span>}
    </>
  );

  const anchor = taskUrlBase ? (
    <a
      className={styles.link}
      href={`${taskUrlBase}${encodeURIComponent(task.id)}`}
      target="_blank"
      rel="noopener noreferrer"
      data-chamber-task-link={task.id}
    >
      {rowBody}
    </a>
  ) : (
    <span className={styles.link}>{rowBody}</span>
  );

  return (
    <li
      className={styles.item}
      data-chamber-task={task.id}
      data-chamber-status={task.status}
      data-chamber-task-mine={task.isMine ? 'true' : undefined}
    >
      <HoverCard anchor={anchor} content={<TaskHoverContent task={task} />} />
    </li>
  );
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
function BoardGroup({
  board,
  single,
  collapsed,
  onToggle,
  taskUrlBase,
}: {
  board: BoardEntry;
  single: boolean;
  collapsed: boolean;
  onToggle: (boardId: string, next: boolean) => void;
  /** 任务深链基座（含尾斜杠）：由 ChamberPanel 从 PanelState 提取，逐层透传至 TaskRow；缺省 = 不渲染深链 */
  taskUrlBase?: string;
}) {
  const bodyId = useId();
  const [backlogExpanded, setBacklogExpanded] = useState(false);
  const tasks = board.tasks ?? [];
  const actionCount = tasks.filter((task) => isActionStatus(task.status)).length;
  const backlogCount = tasks.filter((task) => task.status === 'backlog').length;
  const hiddenBacklog = backlogExpanded ? 0 : Math.max(0, backlogCount - BACKLOG_PREVIEW);

  // 单遍保持 host 排序（host 已按 review>blocked>in_progress>todo>backlog 排好，client 不重排）
  const rows: TaskEntry[] = [];
  let backlogSeen = 0;
  for (const task of tasks) {
    if (task.status === 'backlog') {
      backlogSeen += 1;
      if (!backlogExpanded && backlogSeen > BACKLOG_PREVIEW) continue;
    }
    rows.push(task);
  }

  const progressLabel = `已完成 ${board.completedTaskCount} / 共 ${board.taskCount}`;
  const actionLabel = `${actionCount} 个待处理（已阻塞或审核中）`;

  return (
    <section className={styles.group} data-chamber-board={board.id}>
      {!single && (
        <button
          type="button"
          className={styles.groupHeader}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => onToggle(board.id, !collapsed)}
          data-chamber-board-header={board.id}
        >
          <span className={styles.chevron} data-open={collapsed ? 'false' : 'true'} aria-hidden="true">
            <IconChevronRightOutline14 />
          </span>
          <span className={styles.groupName}>{board.name}</span>
          {/* 折叠组行动 Pill：只数 blocked+review（0 不渲染）；折叠态有行动项 → danger 色（记忆不得静音信号） */}
          {collapsed && actionCount > 0 && (
            <>
              <span className={styles.srOnly}>{actionLabel}</span>
              <span className={styles.pillWrap} aria-hidden="true" title={actionLabel}>
                <Pill className={styles.pillDanger}>{actionCount}</Pill>
              </span>
            </>
          )}
          <span className={styles.spacer} />
          <span className={styles.srOnly}>{progressLabel}</span>
          <span className={styles.pillWrap} aria-hidden="true" title={progressLabel}>
            <Pill>
              {board.completedTaskCount}/{board.taskCount}
            </Pill>
          </span>
        </button>
      )}
      <div className={styles.groupBody} id={bodyId} data-collapsed={collapsed ? 'true' : 'false'}>
        <div className={styles.groupClip}>
          {board.error ? (
            <p className={styles.note} data-chamber-board-error={board.error.code}>
              此看板读取失败（{board.error.code}），下轮自动重试。
            </p>
          ) : (
            <ul className={styles.list}>
              {rows.map((task) => (
                <TaskRow key={task.id} task={task} taskUrlBase={taskUrlBase} />
              ))}
              {hiddenBacklog > 0 && (
                <li className={styles.item}>
                  <button type="button" className={styles.more} onClick={() => setBacklogExpanded(true)} data-chamber-more={hiddenBacklog}>
                    还有 {hiddenBacklog} 条
                  </button>
                </li>
              )}
              {backlogExpanded && backlogCount > BACKLOG_PREVIEW && (
                <li className={styles.item}>
                  <button type="button" className={styles.more} onClick={() => setBacklogExpanded(false)}>
                    收起
                  </button>
                </li>
              )}
              {tasks.length === 0 && <li className={styles.note}>这个看板没有活跃任务</li>}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * 面板 header（plan §4 刷新/进度区；28px 图标钮与 38px 行高照 sidebar-files header 先例）：
 * 左：面板/看板名（单 board 时 = board 名）+ 进度 Pill；右：更新态文案 + 重新拉取钮。
 * 更新态三态互斥：更新中… | 更新失败 · 重试中（stale）| 更新于 x 秒前。
 * 刷新钮文案刻意不提「强制」：浏览器侧无 bustCache 通路（Remote 只有零参 getPanelState），
 * TTL 内返回缓存是契约内行为（plan §4 已知限制）。
 */
function PanelHeader({
  title,
  completed,
  total,
  fetchedAt,
  fetching,
  stale,
  onRefresh,
}: {
  title: string;
  completed: number;
  total: number;
  fetchedAt: string | null;
  fetching: boolean;
  stale: boolean;
  onRefresh: () => void;
}) {
  const progressLabel = `已完成 ${completed} / 共 ${total}`;
  return (
    <header className={styles.header} data-chamber-header="true" data-chamber-stale={stale ? 'true' : undefined}>
      <span className={styles.title} data-chamber-header-title>
        {title}
      </span>
      <span className={styles.srOnly}>{progressLabel}</span>
      <span className={styles.pillWrap} aria-hidden="true" title={progressLabel}>
        <Pill>
          {completed}/{total}
        </Pill>
      </span>
      <span className={styles.spacer} />
      {fetching ? (
        <span className={styles.updated}>更新中…</span>
      ) : stale ? (
        <span className={styles.updated}>更新失败 · 重试中</span>
      ) : fetchedAt === null ? null : (
        <UpdatedAt iso={fetchedAt} />
      )}
      <button
        type="button"
        className={styles.tool}
        aria-label="重新拉取面板数据"
        title="重新拉取面板数据"
        onClick={onRefresh}
        data-chamber-refresh="true"
      >
        <IconRefreshOutline16 />
      </button>
    </header>
  );
}

/** 首载骨架条（plan §4：--dsw-alias-bg-skeleton 官方先例）——只在从未拿到数据时出现一次，轮询不重放 */
function PanelSkeleton() {
  return (
    <div className={styles.root} data-chamber-state="loading" aria-busy="true">
      <div className={styles.skeleton}>
        <span className={styles.srOnly}>正在读取 Chamber 面板…</span>
        <span className={styles.skeletonBar} style={{ width: '100%' }} />
        <span className={styles.skeletonBar} style={{ width: '82%' }} />
        <span className={styles.skeletonBar} style={{ width: '64%' }} />
      </div>
    </div>
  );
}

/**
 * 不可达（空态三分量之最重，files status/failureLine 范式）：错误文案 + 错误码 + 重试钮。
 * 重试钮是「立刻再试一次」，不是「强制刷新」；轮询仍在跑，故文案说明 30s 自动重试。
 */
function UnreachableState({ code, message, onRetry }: { code: string; message: string; onRetry: () => void }) {
  return (
    <div className={styles.root} data-chamber-state="error" data-chamber-error-code={code}>
      <div className={styles.status}>
        <p className={styles.statusLine}>
          暂时读不到 Chamber 面板：{message === '' ? '远端未返回原因' : message}。
        </p>
        <p className={styles.statusCode}>错误码 {code} · 每 30 秒自动重试</p>
        <div className={styles.statusActions}>
          <Button variant="outline" size="sm" onClick={onRetry}>
            重试
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 未绑定家族（空态三分量之中）：收窄引导卡。unbound 与 unauthorized 同家族不同文案——
 * unauthorized（401/403）重试必然同样失败，故意不给重试钮（否则是假承诺），指向绑定文件重配。
 * 两个状态都给出「重配后 1 分钟内自动生效」：host 侧绑定每次抓取现场解析，但结果缓存 TTL=60s
 * （remote.mjs 注释实证），所以最快生效时间就是 TTL 到期。
 */
function BindingCard({ reason }: { reason: 'unbound' | 'unauthorized' }) {
  const unbound = reason === 'unbound';
  return (
    <div className={styles.root} data-chamber-state={reason}>
      <div className={styles.card}>
        <p className={styles.cardTitle}>{unbound ? '未绑定 Chamber 平台' : 'Chamber key 失效或无权限'}</p>
        <p className={styles.cardBody}>
          {unbound ? (
            <>
              这个项目还没有绑定：在项目根写入 <span className={styles.cardCode}>.agent-chamber/agent-chamber.json</span>，
              填 <span className={styles.cardCode}>apiBaseUrl</span> 与 <span className={styles.cardCode}>apiKey</span>
              ，最多 1 分钟内自动生效。
            </>
          ) : (
            <>
              平台拒绝了当前凭据（401/403）。请在{' '}
              <span className={styles.cardCode}>.agent-chamber/agent-chamber.json</span> 里换成有效的{' '}
              <span className={styles.cardCode}>apiKey</span> 后等待重连——这个状态重试不会自愈。
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * 面板主体：30s 轮询 remote.chamber.getPanelState()（plan §2）+ visibilitychange 暂停
 * （plan §5.4：React effect cleanup + 页面隐藏不拉取，回可见立即补一拍）。
 * 状态合并纪律（批 3 规格 ⑧）：成功才有新 value；失败只记 error/stale，已有数据一律留着渲染
 * ——轮询失败不闪骨架、不白屏，面板作为环境感知面的连续性优先于「精确错误页」。
 */
function ChamberPanel(props: ChamberPanelProps) {
  const [model, setModel] = useState<PanelModel>({ phase: 'loading', value: null, error: null, stale: false });
  const [fetching, setFetching] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readCollapsedBoards());

  /**
   * fetchPanelState 入 ref：槽位 inject 工厂产物的交付时机/引用稳定性不进契约
   * （filesFace 先例为每 tab 一次，但不赌），ref 化后 tick 依赖归零、轮询不被重建。
   */
  const fetchRef = useRef(props.fetchPanelState);
  fetchRef.current = props.fetchPanelState;
  /** 卸载标记：迟到的 promise 不落 setState（React 纪律）；同时被轮询 effect 与手动刷新共用 */
  const aliveRef = useRef(true);
  /** 重入闸：手动刷新与轮询拍可叠加，闸掉重复请求（host 侧虽 single-flight，浏览器侧也没必要排队） */
  const inFlightRef = useRef(false);
  /** 折叠态 ref 镜像：持久化要在 setState updater 之外写（updater 必须纯净，StrictMode 会双调） */
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const tick = useCallback(async (opts?: { manual?: boolean }) => {
    // 页面隐藏时暂停拉取（plan §5.4）：轮询是环境感知面，没人看就不打平台
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (inFlightRef.current) return;
    const fetchPanelState = fetchRef.current;
    if (!fetchPanelState) {
      setModel((prev) => ({
        phase: prev.value === null ? 'error' : 'ready',
        value: prev.value,
        error: { code: 'not-mounted', message: '面板数据通道未就位' },
        stale: prev.value !== null,
      }));
      return;
    }
    inFlightRef.current = true;
    // 静默轮询纪律（批 3 规格⑧/plan §4「轮询不动 UI」）：仅手动刷新翻「更新中…」文案，轮询拍静默
    if (opts?.manual) setFetching(true);
    try {
      const result = await fetchPanelState();
      if (!aliveRef.current) return;
      if (result.ok) {
        setModel({ phase: 'ready', value: result.value, error: null, stale: false });
      } else {
        const error = { code: failureCode(result.error), message: result.error?.message ?? '' };
        setModel((prev) => ({
          phase: prev.value === null ? 'error' : 'ready',
          value: prev.value,
          error,
          stale: prev.value !== null,
        }));
      }
    } catch (error) {
      // 装配级故障（arity/未挂载/缺 Context adapter）会以 reject 形态出现（typert-protocol 注释实证）
      if (aliveRef.current) {
        setModel((prev) => ({
          phase: prev.value === null ? 'error' : 'ready',
          value: prev.value,
          error: { code: 'call-failed', message: String(error) },
          stale: prev.value !== null,
        }));
      }
    } finally {
      inFlightRef.current = false;
      if (opts?.manual && aliveRef.current) setFetching(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void tick(); // 首拍立即拉（plan §9：真实打开才调用，host 侧日志以此计真实使用）
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    // 回可见立即补一拍：隐藏期错过的状态变化不等下一个 30s
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [tick]);

  /**
   * 折叠态写路径：ref 镜像出完整 record → setState + 持久化（localStorage 记忆，plan §4）。
   * 显式传 next 而非取反：默认折叠由「有无行动项」推导，取反会与默认值打架。
   */
  const setBoardCollapsed = useCallback((boardId: string, next: boolean) => {
    const merged = { ...collapsedRef.current, [boardId]: next };
    collapsedRef.current = merged;
    setCollapsed(merged);
    writeCollapsedBoards(merged);
  }, []);

  const refresh = useCallback(() => {
    void tick({ manual: true });
  }, [tick]);

  if (model.phase === 'loading') return <PanelSkeleton />;
  if (model.phase === 'error' || model.value === null) {
    const code = model.error?.code ?? 'unknown';
    const message = model.error?.message ?? '';
    return <UnreachableState code={code} message={message} onRetry={refresh} />;
  }

  const state = model.value;
  if (state.bound === false) return <BindingCard reason={state.reason} />;

  const boards = state.boards;
  // 任务深链基座：仅用 host 推导值（绑定 webBaseUrl / apiBaseUrl 推导）；缺省（旧 host 无契约字段）
  // = undefined → TaskRow 标题纯文本降级，不渲染深链（开源中性：消费侧不硬编码任何实例域）
  const taskUrlBase = typeof state.taskUrlBase === 'string' && state.taskUrlBase !== '' ? state.taskUrlBase : undefined;
  const single = boards.length === 1;
  const completedTotal = boards.reduce((sum, board) => sum + board.completedTaskCount, 0);
  const taskTotal = boards.reduce((sum, board) => sum + board.taskCount, 0);
  const activeCount = boards.reduce((sum, board) => sum + (board.tasks?.length ?? 0), 0);
  // 空态诚实性（code-review M1）：board 级抓取失败（host 降级 partial，BoardEntry.error 在场、无 tasks）
  // 不得被「全绿」空态掩盖——有 error 时走 body 分支，由 BoardGroup 渲染「此看板读取失败」note。
  const hasBoardError = boards.some((board) => board.error !== undefined);
  const showEmpty = activeCount === 0 && !hasBoardError;
  const headerTitle = single ? (boards[0]?.name ?? 'Chamber') : '全部看板';

  return (
    <div
      className={styles.root}
      data-chamber-state={showEmpty ? 'empty' : 'ready'}
      data-chamber-partial={state.partial ? 'true' : 'false'}
    >
      <PanelHeader
        title={headerTitle}
        completed={completedTotal}
        total={taskTotal}
        fetchedAt={state.fetchedAt}
        fetching={fetching}
        stale={model.stale}
        onRefresh={refresh}
      />
      {showEmpty ? (
        // 全绿空态（plan §4 裁决：单行 tertiary 低调，不做庆祝——不抢占注意力是本面板的纪律）
        <p className={styles.note} data-chamber-empty="true">
          当前没有活跃任务。
        </p>
      ) : (
        <div className={styles.body}>
          {boards.map((board) => {
            const boardActions = (board.tasks ?? []).some((task) => isActionStatus(task.status));
            // 多 board 默认：有行动项的组展开，其余折叠；记忆优先（记忆不得静音行动信号 → 折叠态 Pill danger）。
            // error 组视同行动信号默认展开（code-review minor 6）——折叠会把「此看板读取失败」note 完全静音。
            const boardCollapsed = single ? false : (collapsed[board.id] ?? !(boardActions || board.error !== undefined));
            return (
              <BoardGroup
                key={board.id}
                board={board}
                single={single}
                collapsed={boardCollapsed}
                onToggle={setBoardCollapsed}
                taskUrlBase={taskUrlBase}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ———————————————————————————— 面板插件（$mount 完成后挂，inject 含 remote.chamber） ————————————————————————————

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
    title: () => 'Chamber',
    guide: [
      {
        order: 30,
        title: () => 'Chamber 任务面板',
        icon: IconChecklistOutline14,
        description: () =>
          '我参与的看板与活跃任务（待办 / 待开始 / 进行中 / 已阻塞 / 审核中），30 秒自动刷新；点任务行在平台打开',
      },
    ],
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
function applyPanel(ctx: CordisContext) {
  ctx.effect(() => ctx.sidebarRightTabs!.register(chamberDefinition()), 'agent-chamber: chamber tab type');
  ctx.effect(
    () =>
      ctx.slots!.inject('sidebar.right.pane.tab', () =>
        ctx.slots!.register(
          {
            name: 'sidebar.right.pane.tab',
            key: CHAMBER_ID,
            // 数据通道：remote.chamber 的 getPanelState 零业务参数 + 可选 signal 尾参
            // （descriptor cancellation 契约）；面板轮询不传 signal——host 侧每路 8s 超时兜底。
            inject: () => ({
              fetchPanelState: () => ctx.remote!.chamber!.getPanelState(),
            }),
          },
          ChamberPanel,
        ),
      ),
    'agent-chamber: chamber tab body',
  );
}

// ———————————————————————————— 入口（死锁红线：inject 严禁 remote.chamber） ————————————————————————————

/**
 * 入口 fiber 服务依赖：只写 ['remote']（官方 mounter dsh-api-remotes 先例：inject = ["remote"]）。
 * ⚠️ 死锁红线（plan §5.7）：本 bundle 自己 $mount 的 namespace（remote.chamber）严禁出现在
 * 本数组——inject 未满足则 fiber INACTIVE、apply 永不执行、namespace 永不注册，自相死锁。
 * slots/sidebarRightTabs 也不写：它们由面板子 fiber 自己的 inject 声明，入口不需要。
 * 包级加载序由 package.json dsh.client.inject（sidebar-right + gateway 两包）保证。
 */
export const inject = ['remote'];

/**
 * 入口 apply：手写 strict contribution 经 ctx.remote.$mount 挂载（plan §5.3 代码块形态），
 * 完成后 ctx.plugin 挂面板子 fiber。同步 apply + ctx.effect 包裹（而非官方 mounter 的
 * async apply 直等）——理由：$mount 失败（descriptor 违例/网关缺席）只降级日志，不让
 * 入口 fiber 激活失败拖出插件加载错误（面板缺席 ≠ boot 受损，与 node 半面故障隔离同款哲学）。
 * @param ctx 客户端根 Context（inject=['remote'] 保证 ctx.remote 在场）
 */
export function apply(ctx: CordisContext) {
  ctx.effect(() => {
    const mounted = ctx.remote!.$mount(CHAMBER_CONTRIBUTION);
    mounted.then(
      // createNamespace 在 fiber apply 内同步装方法（gateway client.js 实证），
      // mount promise 解决即可消费 remote.chamber——此刻挂面板子 fiber 安全。
      () => {
        ctx.plugin({ name: 'dsh-agent-chamber/panel', inject: ['remote.chamber', 'slots', 'sidebarRightTabs'], apply: applyPanel });
      },
      (error) => {
        // 挂载失败 = 面板整体缺席但 boot 无损；留机器可归因的日志词表（对齐 node 半面 remote=unavailable）
        ctx.logger?.error?.(`[agent-chamber] client: remote mount failed error=${String(error)}`);
      },
    );
    // 卸载路径：$mount 内部已 callerCtx.effect 持有一份（fiber 卸载自动 dismount），
    // 此处再持一份幂等双保险；拒绝守卫——mount 已失败时 disposer 不得再抛（避免卸载期 unhandled rejection）。
    return () => {
      mounted.then((dispose) => dispose(), () => undefined);
    };
  });
}
