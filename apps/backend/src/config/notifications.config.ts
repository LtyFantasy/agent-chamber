/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块（外部 IM 通知出口，一期）的**配置工厂**：`registerAs('notifications')`
 *     产出总开关 / 细粒度类别白名单 / provider 白名单 / 飞书四键 / owner 名单 / web 深链基址 /
 *     两级节流 + 直发限流 + HTTP 超时 + 系统告警上限共 **17 个 env 键**的解析结果与 `warnings`。
 *   - **对外出境功能**：启用后任务标题、**看板名 + 操作者显示名**、文档路径、**空间名**、
 *     话题名、**发言人显示名 + 消息摘要**（截断）、agent 直发正文、**系统告警正文**
 *     会经飞书私聊离开本机网络。**"默认关"是出境功能的唯一可接受缺省**（缺省 `NOTIFY_ENABLED=false`）。
 *
 * [代码职责]
 *   - 纯函数解析 + **fail-fast 矩阵三组合**（production）+ 解析防御 + 净化 warnings；
 *     **无 Logger**（warn / INFO 的打印归属 provider 工厂，见 [关键不变量]）
 *   - `NOTIFY_CATEGORIES`：细粒度类别 token 值域单源（映射判据在 NotifyOrchestrator）
 *   - `NOTIFY_EGRESS_DECLARATION`：**出境字段白名单**单源——`.env.example` / 生产 fail-fast 文案 /
 *     启动 INFO 三处引用同一段文字（渲染层实际外发字段与它逐字对齐）
 *   - `NOTIFICATIONS_CONFIG_FALLBACK`：e2e 内联 ConfigModule 未 load 本工厂时的形状兜底
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §4 配置（逐键表 + fail-fast 矩阵）
 *     / §5 类别→事件映射（token 值域与 L1 键）/ §11 风险对策
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/api-definition.md`（两端点
 *     + `/webhooks` vs `/notifications` 关系声明）与 `docs/architecture.md`（模块节）；落点后本
 *     定位符改为线上文档。
 *
 * [关键不变量]
 *   - **`NOTIFY_ENABLED=false` ⇒ 一切静默**：不校验**必填键**（fail-fast 矩阵不跑）、不发任何
 *     通知、不落任何投递记录。缺省即此态；`undefined` / 非 `'true'` 一律视为关闭（仓内布尔约定，
 *     与 DB_SSL 同口径）。
 *     ⚠️ 但**解析类 warning 与开关无关**：非法 token / 非法数值仍会被忽略或回落，并**照常产出一条
 *     warning**——"我配了这个键但没生效"是用户必须知道的事，与总开关无关（矩阵①只关掉
 *     "缺必填键就崩"，见下）。
 *   - **fail-fast 矩阵（仅 production）三组合**（顺序即校验顺序，首个不满足即抛）：
 *     ① `ENABLED=false` ⇒ 不校验（缺省态不打扰部署）；
 *     ② `ENABLED=true` + providers 含 `feishu` ⇒ `FEISHU_APP_ID` / `FEISHU_APP_SECRET` /
 *        `NOTIFY_WEB_BASE_URL` **三键必填**；
 *     ③ （Notifications 二期起本组合**已撤**）一期曾是"categories 含 `topic` ⇒
 *        `NOTIFY_OWNER_USERNAMES` 必填"，二期多用户模型下 topic 的收件人来自**用户各自的
 *        渠道绑定**（不是部署级 owner 名单），owner 名单降级为 **D4 播种源**——由 orchestrator
 *        的播种 outcome（`skipped_no_source` ⇒ throw）在**运行期按真实 DB 事实**判定，比这里
 *        "env 键是否为空"精确。⚠️ 故本矩阵**不再**因缺 owner 名单 fail-fast。
 *     dev/test 一律降级为 `warnings` 一条（可 grep），**绝不阻断启动**。
 *   - **owner usernames 的"至少解析出 1 个未软删 actor"不在本文件判定**：它是运行期 DB 事实
 *     （需查 `users` 表），由 NotifyOrchestrator 启动解析后按**解析数 0 ⇒ 跳过 topic 类别 +
 *     warn** 处置（见该文件头）。本文件只钉"env 键非空"这层格式前提（铁律 #21 分层）。
 *   - **`NOTIFY_CATEGORIES` 非法 token 忽略 + 一条 warning**（经 `sanitizeLogValue` 净化），
 *     合法 token 去重保序；缺省 `task_done,direct`（"只有完工与直发"= 最低噪音可用集）。
 *   - **`NOTIFY_PROVIDERS` 未知 token 忽略 + fail-open**：零 provider 时**不抛**（通知是可选出口，
 *     配错出口不该让平台起不来），由工厂打一行 warning；编排器对每次投递**丢弃并打一行 INFO**
 *     `dropped [no_provider]`，且**不落投递行**（没有出口就没有投递尝试——见 orchestrator 与
 *     repository 文件头）。⚠️ `no_provider` 作为**信封 reason** 只属于直发端点（S4），
 *     与本层的日志标记不是一回事。
 *   - **数值键一律正整数解析**：NaN / 非正数 / 空串回落缺省 + 一条 warning（**文案只出现键名与
 *     回落缺省值，绝不回显 env 原值**——畸形值可能是 token 或带 userinfo 的 URL，见文件头
 *     judgment `JUDGMENT-WARNING-VALUE-LEAK` 同族纪律）。空白串视同"未配置"（compose 的
 *     `${VAR:-}` 在 .env 缺键时注空串，裸判"已设置"会对每个默认部署 100% 误报）。
 *   - **`system_alert` 不是可开关类别**（plan D6，路线 B）：它**不进** `NOTIFY_CATEGORIES`，
 *     用户不能静音、设置页不展示；唯一治理面是部署级 `NOTIFY_ENABLED`。本文件只为它提供
 *     一个量控上限（`NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR`，按臂分桶，见
 *     orchestrator 的 `consumeSystemAlertQuota`）。⚠️ 别"顺手"把它加进类别词表——
 *     那等于给"平台病了没人知道"开一条用户可关的静默通道。
 *   - **出境声明三处同源**（本文件的 `NOTIFY_EGRESS_DECLARATION` 是单源）：`.env.example` 的
 *     Notify 区块、生产 fail-fast 文案、启动 INFO 逐项都引用**同一份字段清单**——fail-fast 与
 *     启动 INFO 逐字引用本常量（英文），`.env.example` 按同一清单逐项列出（中文，随该文件的
 *     语言惯例；**字段集合必须逐个对齐**）。三处各维护一份 = 迟早有一处漏更新，
 *     而漏的那处正是用户读的那处。
 *     ⚠️ 本句曾被写成"与 `.env.example` 逐字相同"——那是一句做不到的话（中英文案不可能逐字
 *     相等），写下来只会让后来者以为这里有自动化校验。**契约是字段集合，不是字面量。**
 *   - **本文件绝不回显 `FEISHU_APP_SECRET` / `FEISHU_APP_ID` / `FEISHU_RECIPIENT_OPEN_ID` 的值**：
 *     warnings 与 fail-fast 文案只出现键名 / 合法值域 / 逃生阀（配置错误信息会进启动日志）。
 *   - **内存态前提（写进常量头）**：L1 / L2 / 直发幂等在**进程内内存**实现，每实例独立、重启清零、
 *     多副本实际额度 ×N——**这是限流不是配额**，生产单实例部署前提成立（见 orchestrator 文件头）。
 *
 * [关联代码]
 *   - modules/notifications/notifications-provider.factory.ts — config 的**唯一消费方**
 *     （装配 provider + 逐条打印 warnings + 启动 INFO；Logger 归属层）
 *   - modules/notifications/notify-orchestrator.service.ts — 类别映射 / 自回声 / topic 参与 /
 *     两级节流 / 渲染（读本文件全部字段）
 *   - database/entities/notification-delivery.entity.ts — `category` 列的落库值域同源
 *   - config/app-config-loads.ts — 本工厂的注册点（load 清单末尾）
 *   - app.module.spec.ts — load 清单守卫（漏挂 = 静默配置失效，D6 类）
 *
 * [持久踩坑]
 *   NOTIFY-CONFIG-SILENT-SUBMIT(配了却不推): 出境功能"启用成功"与"启用失败"在行为上都表现为
 *     "没有消息"——用户分不清是没人触发还是没配上。安全方向: 生产 fail-fast 三组合 + dev
 *     warning + 启动 INFO（owner actors resolved n/N）+ `.env.example` 生效自检 grep 范式。
 *   NOTIFY-EGRESS-UNDECLARED(出境字段未声明): 通知正文里天然含任务标题 / 看板名 / 操作者名 /
 *     文档路径 / 空间名 / 话题名 / 发言人名 / 消息摘要，用户以为"只是发个提醒"。
 *     安全方向: 出境字段白名单单源声明 + 三处同源 + **渲染层实际外发字段与声明逐字对齐**
 *     （新增外发字段必须同 commit 改本文件的声明表）。
 *   NOTIFY-EMPTY-ENV-STRING(空串当"已设置"): compose `${VAR:-}` 注空串 ⇒ 裸判 `process.env`
 *     非空会对默认部署 100% 误报。安全方向: 一律 `?.trim()` 后判非空（与 judgment 同源纪律）。
 *
 * [铁律关联] #11(注释强制) #21(双层校验) #26(文档联动)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 env 键必须同时更新 `.env.example`、`docker-compose.yml` 透传与本文件的 fail-fast 文案
 *     （三处漏一处 = 容器内该键永远不存在或用户读不到说明）
 *   □ 新增出境字段必须同 commit 更新 `NOTIFY_EGRESS_DECLARATION` 与 `.env.example` 的声明段
 *   □ 新增类别 token 必须同步 orchestrator 映射表 + 本文件值域 + 单测矩阵（枚举一致性断言会红）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { registerAs } from '@nestjs/config';
import { sanitizeLogValue } from './judgment.config';

/**
 * 细粒度通知类别 token 值域（**单源**：orchestrator 的映射判据、`.env.example` 说明、
 * 投递记录 `category` 列的落库值域都引用它）。
 *
 * 顺序 = `.env.example` 与帮助文案的呈现顺序（`task_done` / `direct` 是缺省开启项，排前）。
 * ⚠️ **映射判据**（哪个事件 → 哪个 token）属 orchestrator，本数组只管"合法名字有哪些"。
 */
export const NOTIFY_CATEGORY = {
  /** 任务完工/阻塞跃迁（`TASK_UPDATE` 且 `toStatus∈{done,blocked}` 且 `fromStatus!==toStatus`）；缺省开 */
  TASK_DONE: 'task_done',
  /** 任务创建（`TASK_UPDATE` 且 action='created'） */
  TASK_CREATED: 'task_created',
  /** 任务其余更新（改标题/描述/优先级…；**不**判完工） */
  TASK_UPDATED: 'task_updated',
  /** 任务指派（`TASK_ASSIGNED`：assign() 与 PATCH 改派两路径） */
  TASK_ASSIGNED: 'task_assigned',
  /** 话题新消息（`NEW_MESSAGE` 且非 system 且 owner 是 active 参与者） */
  TOPIC: 'topic',
  /** 文档创建 */
  DOC_CREATED: 'doc_created',
  /** 文档更新（`DOC_UPDATED`；`payload.rechunked===true` 的纯重切短路） */
  DOC_UPDATED: 'doc_updated',
  /** 文档删除 */
  DOC_DELETED: 'doc_deleted',
  /** 文档移动（同 docId 改 path） */
  DOC_MOVED: 'doc_moved',
  /** agent 直发端点（`POST /notifications/messages`；不经 L1，占用 L2 额度但永不合并）；缺省开 */
  DIRECT: 'direct',
} as const;

/** 类别 token 类型（落库列 `category` 与 env 解析共用） */
export type NotifyCategory = (typeof NOTIFY_CATEGORY)[keyof typeof NOTIFY_CATEGORY];

/**
 * 类别值域数组（**由 {@link NOTIFY_CATEGORY} 派生**，顺序 = 对象插入序）。
 *
 * 用途：env 白名单校验（`includes`）、`.env.example` 的呈现顺序、单测的枚举一致性断言。
 * 新增类别**只需在对象里加一行**——数组自动跟上（两份手写清单 = 迟早漂移）。
 */
export const NOTIFY_CATEGORIES: readonly NotifyCategory[] = Object.values(NOTIFY_CATEGORY);

/**
 * 缺省开启的类别（"只有完工与直发" = 最低噪音可用集）。
 *
 * rationale：缺省全开会在任何活跃项目上立刻撞 L2 全局窗口（5 条/10min）被压成摘要——
 * 用户第一印象是"发了一堆没用的汇总"，而不是"通知真好用"。缺省只留**用户最不可能嫌多**的
 * 两类（完工 = 关心结果；直发 = 显式请求），其余按需在 `.env.example` 的推荐组合里勾。
 */
export const DEFAULT_NOTIFY_CATEGORIES: readonly NotifyCategory[] = ['task_done', 'direct'];

/**
 * provider token 值域（**单源**：`NOTIFY_PROVIDERS` 解析 + provider 工厂装配分派）。
 *
 * 一期只有 `feishu`（飞书自建应用私聊）。未知 token 由工厂忽略 + warn（fail-open）。
 */
export const NOTIFY_PROVIDER_TOKENS = ['feishu'] as const;

/** provider token 类型 */
export type NotifyProviderToken = (typeof NOTIFY_PROVIDER_TOKENS)[number];

/**
 * **出境字段白名单**（三处同源的唯一副本——见文件头 [关键不变量]）。
 *
 * 每项 = 一行"字段名：来源与截断"。⚠️ 它是**声明**，不是文档修辞：orchestrator 渲染层实际放进
 * `RenderedNotification`（title / body / link）的内容必须与这里逐项对齐；新增外发字段必须同
 * commit 改本数组，否则用户读到的"出境清单"就是假的。
 */
export const NOTIFY_EGRESS_FIELDS: readonly string[] = [
  'task title (truncated to 200 chars) + board name + actor display name (body truncated to 200 chars, rendered as `看板「<board>」 · <actor>`, plus `→ 指派给 <assignee>` on assignment events) — 任务事件（完工/创建/更新/指派）',
  'document path (truncated to 200 chars) + DocSpace name + doc title (body truncated to 200 chars, rendered as `空间「<space>」 · <title>`) — 文档事件（创建/更新/移动）；**删除事件的 path/title/spaceId 来自事件载荷**（行已软删）',
  'topic name — 话题事件（他人新消息）',
  'message sender display name + message excerpt (both composed, then truncated to 100 chars) — 话题事件的消息摘要与发言人',
  'direct message body (authored by the calling agent, ≤2000 chars) — 直发端点（正文由 agent 自填）',
  'agent display name (rendered as the `[<name>]` title prefix of direct messages) — 直发端点（让 Owner 知道是谁在找他；S4 补登）',
  'suppression digest (per-category counts of notifications held back by the global rate window + web root link) — L2 超额摘要',
  'system alert title + body (fixed operational templates authored at compile time by the producer — NEVER URLs, endpoints, credential refs, request ids or raw upstream responses; body ≤1000 chars) — 系统告警（引擎健康 arms）',
  'engine workspace id (user-controllable, sanitised by the producer before it reaches the notification) — 系统告警的归属标识',
  'alert metadata (source / kind / arm / occurredAt) — 系统告警的分类与发生时刻（用于正文里说明"哪条臂、什么时候"，不单独出境）',
  'deep link (NOTIFY_WEB_BASE_URL + resource path / fixed operational page (alerts = /memory)) — 每个事件的跳转链接与告警的固定运维页',
];

/**
 * 出境声明的**可读段**（`NOTIFY_EGRESS_FIELDS` 的派生文本；fail-fast 文案 / `.env.example` /
 * 启动 INFO 三处引用它，避免"三处各写一遍"）。
 */
export const NOTIFY_EGRESS_DECLARATION: string = NOTIFY_EGRESS_FIELDS.map(
  (field) => `${field}`,
).join('; ');

/**
 * "如何关掉"逃生阀文案（fail-fast 与 `.env.example` 共用）。
 *
 * 出境类功能的报错文案必须自带关闭方法——否则用户唯一的反应是"把整个功能删掉"。
 */
export const NOTIFY_DISABLE_HINT =
  'Set NOTIFY_ENABLED=false to disable every external notification (the platform keeps working ' +
  'unchanged — notifications are an optional egress). See .env.example.';

/** 两级节流 / 限流 / 超时的缺省值（**单源**：解析回落与 `.env.example` 说明共用） */
const DEFAULT_TASK_THROTTLE_SECONDS = 300;
const DEFAULT_DOC_THROTTLE_SECONDS = 600;
const DEFAULT_TOPIC_THROTTLE_SECONDS = 600;
const DEFAULT_GLOBAL_RATE_LIMIT = 5;
const DEFAULT_GLOBAL_RATE_WINDOW_SECONDS = 600;
const DEFAULT_DIRECT_RATE_LIMIT_PER_WINDOW = 6;
const DEFAULT_DIRECT_RATE_WINDOW_SECONDS = 600;
const DEFAULT_HTTP_TIMEOUT_MS = 8000;
/**
 * 部署级**出境总闸**缺省（Notifications 二期，plan §D3）：整个部署在窗口内最多向所有渠道投递
 * 多少条。它与 per-user L2（`globalRateLimit`）是**两种不同粒度**的闸：
 * L2 是"别把某个人的手机刷爆"，总闸是"别把整个部署的外部配额烧穿"（飞书应用级限流 / 账单）。
 * 缺省 20/600s：N≥5 个活跃绑定用户时总闸会先于 per-user L2 生效（关系声明见模块文件头）。
 */
const DEFAULT_PLATFORM_RATE_LIMIT = 20;
const DEFAULT_PLATFORM_RATE_WINDOW_SECONDS = 600;
/**
 * 系统告警的每小时上限缺省（plan D6-4）：**按臂分桶**——`auth` 桶 `alert + recovery` 都计额，
 * `availability` 桶只计 alert（recovery 免额），heartbeat 不计额。
 *
 * 12/h 的取舍：B 臂 flap 可被普通用户诱发（5×403 + 1 次成功循环），没有上限就是一条反刷屏
 * 旁路；上限太高则"真的挂了"时刷屏，太低则"平台病了"的信号可能被自己的量控吞掉。
 * 12/h ≈ 每 5 分钟一条，足够刻画一次 flap 循环又不至于刷爆手机。
 */
const DEFAULT_SYSTEM_ALERT_MAX_PER_HOUR = 12;

/**
 * 本工厂产出的配置形状（DI / 消费方读它；e2e 可 override）。
 *
 * 单独导出类型：provider 工厂与 orchestrator 共用一份定义——避免"配置字段名在两处各写一遍"
 * 的漂移（judgment 先例）。
 */
export interface NotificationsConfig {
  /** 总开关。false ⇒ 一切静默（不校验键 / 不发通知 / 不落投递记录） */
  enabled: boolean;
  /** 已启用的细粒度类别（非法 token 已剔除；缺省 `task_done,direct`） */
  categories: NotifyCategory[];
  /** 已启用的 provider token（未知 token 已剔除；缺省空集 = 无出口） */
  providers: NotifyProviderToken[];
  /** 飞书自建应用 App ID（仅 providers 含 feishu 时有消费者；未配置为 null） */
  feishuAppId: string | null;
  /** 飞书自建应用 App Secret（**绝不出现在日志 / 投递记录 / 响应体**） */
  feishuAppSecret: string | null;
  /** 单收件人 open_id（一期固定 Owner；**二期起仅作 D4 播种源**，见 §D4） */
  feishuRecipientOpenId: string | null;
  /** owner 的**平台 username** 列表（启动解析成 actorId 缓存；二期起作 D4 播种源，见 §D4） */
  ownerUsernames: string[];
  /** 深链基址（**单源**：渲染层所有链接都由它拼接；与 CORS_ORIGINS 是两个面，不可互替） */
  webBaseUrl: string | null;
  /** L1 per-task 窗口（秒）；`task_done` / `task_created` / `task_updated` / `task_assigned` 共用 */
  taskThrottleSeconds: number;
  /** L1 per-doc 窗口（秒）；四个 doc 类别共用 */
  docThrottleSeconds: number;
  /** L1 per-topic 窗口（秒） */
  topicThrottleSeconds: number;
  /** L2 全局滑动窗口条数（per-recipient；超额合并为摘要） */
  globalRateLimit: number;
  /** L2 全局滑动窗口长度（秒） */
  globalRateWindowSeconds: number;
  /** 直发端点 per-agent 窗口条数（与 L2 分开记账——直发占 L2 但有自己的入口闸） */
  directRateLimitPerWindow: number;
  /** 直发端点 per-agent 窗口长度（秒） */
  directRateWindowSeconds: number;
  /**
   * 部署级出境总闸条数（Notifications 二期）：整个部署在窗口内最多投递多少条（见上方缺省注释）。
   * 它约束**事件链路与 test 端点**（直发链路是否过闸属批 2 收口，见模块文件头）。
   */
  platformRateLimit: number;
  /** 部署级出境总闸窗口长度（秒） */
  platformRateWindowSeconds: number;
  /**
   * 系统告警的**每小时上限**（per arm，见 plan D6-4；缺省 12）。
   *
   * 分桶语义在 orchestrator 的 `consumeSystemAlertQuota`：`auth` 桶 alert+recovery 都计额，
   * `availability` 桶只计 alert（recovery 免额），heartbeat 不计额。进程内计数、重启清零。
   */
  systemAlertMaxPerHour: number;
  /** provider HTTP 超时（毫秒） */
  httpTimeoutMs: number;
  /**
   * 配置组合异常描述（**已净化**：键名 / 常量 / 合法值域 / 经净化的 token，**绝不含 env 原值**）。
   *
   * 空数组 = 无异常。产出规则：非法 token 各一条 + 数值键解析回退各一条 + dev 下的 fail-fast
   * 降级各一条。**打印由持 Logger 的 provider 工厂做**（本文件纯函数纪律）。
   */
  warnings: string[];
}

/**
 * 配置缺省兜底（e2e 内联 ConfigModule 未 load 本工厂时的形状保证；值 = 本工厂缺省）。
 *
 * ⚠️ **加键必须同步这里与 registerAs 的产出**：`NotificationsConfig` 的类型标注会让漏字段变成
 * 编译期报错（fail-closed），故不存在"少一个键静默吃 undefined"的窗口。
 */
export const NOTIFICATIONS_CONFIG_FALLBACK: NotificationsConfig = {
  enabled: false,
  categories: [...DEFAULT_NOTIFY_CATEGORIES],
  providers: [],
  feishuAppId: null,
  feishuAppSecret: null,
  feishuRecipientOpenId: null,
  ownerUsernames: [],
  webBaseUrl: null,
  taskThrottleSeconds: DEFAULT_TASK_THROTTLE_SECONDS,
  docThrottleSeconds: DEFAULT_DOC_THROTTLE_SECONDS,
  topicThrottleSeconds: DEFAULT_TOPIC_THROTTLE_SECONDS,
  globalRateLimit: DEFAULT_GLOBAL_RATE_LIMIT,
  globalRateWindowSeconds: DEFAULT_GLOBAL_RATE_WINDOW_SECONDS,
  directRateLimitPerWindow: DEFAULT_DIRECT_RATE_LIMIT_PER_WINDOW,
  directRateWindowSeconds: DEFAULT_DIRECT_RATE_WINDOW_SECONDS,
  platformRateLimit: DEFAULT_PLATFORM_RATE_LIMIT,
  platformRateWindowSeconds: DEFAULT_PLATFORM_RATE_WINDOW_SECONDS,
  systemAlertMaxPerHour: DEFAULT_SYSTEM_ALERT_MAX_PER_HOUR,
  httpTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
  warnings: [],
};

/**
 * 正整数解析（非法 / 缺失 → null）。
 *
 * 与 judgment 的 `parsePositiveInt` **同形**（独立副本：两个 config 工厂互不 import 对方的
 * 私有解析函数；判据本身是"正整数"，无语义分叉风险）。
 */
function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed);
}

/**
 * 该 env 值是否触发了"解析回退"（供 warnings 产出）。
 *
 * **空白串不算**配置错误：compose 的 `${VAR:-}` 在 .env 缺键时注空串，裸判"已设置"会对每个
 * 默认部署 100% 误报（judgment / memory 同源纪律）。
 */
function isParseFallback(raw: string | undefined): boolean {
  return Boolean(raw?.trim()) && parsePositiveInt(raw) === null;
}

/**
 * 逗号分隔 token 列表解析（去空 / 去重保序）。
 *
 * @param raw env 原值
 * @returns trim 后的非空 token 数组（保持出现顺序）
 */
function splitTokens(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const token of (raw ?? '').split(',')) {
    const trimmed = token.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * 解析数值旋钮并产出解析回退 warnings（**已净化**，顺序固定 = 启动日志顺序）。
 */
function resolveNumericKnobs(): {
  taskThrottleSeconds: number;
  docThrottleSeconds: number;
  topicThrottleSeconds: number;
  globalRateLimit: number;
  globalRateWindowSeconds: number;
  directRateLimitPerWindow: number;
  directRateWindowSeconds: number;
  platformRateLimit: number;
  platformRateWindowSeconds: number;
  systemAlertMaxPerHour: number;
  httpTimeoutMs: number;
  warnings: string[];
} {
  const knobs = {
    taskThrottleSeconds:
      parsePositiveInt(process.env.NOTIFY_TASK_THROTTLE_SECONDS) ?? DEFAULT_TASK_THROTTLE_SECONDS,
    docThrottleSeconds:
      parsePositiveInt(process.env.NOTIFY_DOC_THROTTLE_SECONDS) ?? DEFAULT_DOC_THROTTLE_SECONDS,
    topicThrottleSeconds:
      parsePositiveInt(process.env.NOTIFY_TOPIC_THROTTLE_SECONDS) ?? DEFAULT_TOPIC_THROTTLE_SECONDS,
    globalRateLimit:
      parsePositiveInt(process.env.NOTIFY_GLOBAL_RATE_LIMIT) ?? DEFAULT_GLOBAL_RATE_LIMIT,
    globalRateWindowSeconds:
      parsePositiveInt(process.env.NOTIFY_GLOBAL_RATE_WINDOW_SECONDS) ??
      DEFAULT_GLOBAL_RATE_WINDOW_SECONDS,
    directRateLimitPerWindow:
      parsePositiveInt(process.env.NOTIFY_DIRECT_RATE_LIMIT_PER_WINDOW) ??
      DEFAULT_DIRECT_RATE_LIMIT_PER_WINDOW,
    directRateWindowSeconds:
      parsePositiveInt(process.env.NOTIFY_DIRECT_RATE_WINDOW_SECONDS) ??
      DEFAULT_DIRECT_RATE_WINDOW_SECONDS,
    platformRateLimit:
      parsePositiveInt(process.env.NOTIFY_PLATFORM_RATE_LIMIT) ?? DEFAULT_PLATFORM_RATE_LIMIT,
    platformRateWindowSeconds:
      parsePositiveInt(process.env.NOTIFY_PLATFORM_RATE_WINDOW_SECONDS) ??
      DEFAULT_PLATFORM_RATE_WINDOW_SECONDS,
    systemAlertMaxPerHour:
      parsePositiveInt(process.env.NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR) ??
      DEFAULT_SYSTEM_ALERT_MAX_PER_HOUR,
    httpTimeoutMs: parsePositiveInt(process.env.NOTIFY_HTTP_TIMEOUT_MS) ?? DEFAULT_HTTP_TIMEOUT_MS,
  };

  const warnings: string[] = [];
  // 解析回退逐键一条：**只回显键名与回落缺省值**——env 原值可能是 token / URL，原样回显即
  // 泄漏（见文件头 [关键不变量]）。
  const fallbackRows: Array<[key: string, raw: string | undefined, value: number, unit: string]> = [
    [
      'NOTIFY_TASK_THROTTLE_SECONDS',
      process.env.NOTIFY_TASK_THROTTLE_SECONDS,
      knobs.taskThrottleSeconds,
      's',
    ],
    [
      'NOTIFY_DOC_THROTTLE_SECONDS',
      process.env.NOTIFY_DOC_THROTTLE_SECONDS,
      knobs.docThrottleSeconds,
      's',
    ],
    [
      'NOTIFY_TOPIC_THROTTLE_SECONDS',
      process.env.NOTIFY_TOPIC_THROTTLE_SECONDS,
      knobs.topicThrottleSeconds,
      's',
    ],
    [
      'NOTIFY_GLOBAL_RATE_LIMIT',
      process.env.NOTIFY_GLOBAL_RATE_LIMIT,
      knobs.globalRateLimit,
      'per window',
    ],
    [
      'NOTIFY_GLOBAL_RATE_WINDOW_SECONDS',
      process.env.NOTIFY_GLOBAL_RATE_WINDOW_SECONDS,
      knobs.globalRateWindowSeconds,
      's',
    ],
    [
      'NOTIFY_DIRECT_RATE_LIMIT_PER_WINDOW',
      process.env.NOTIFY_DIRECT_RATE_LIMIT_PER_WINDOW,
      knobs.directRateLimitPerWindow,
      'per window',
    ],
    [
      'NOTIFY_DIRECT_RATE_WINDOW_SECONDS',
      process.env.NOTIFY_DIRECT_RATE_WINDOW_SECONDS,
      knobs.directRateWindowSeconds,
      's',
    ],
    [
      'NOTIFY_PLATFORM_RATE_LIMIT',
      process.env.NOTIFY_PLATFORM_RATE_LIMIT,
      knobs.platformRateLimit,
      'per window',
    ],
    [
      'NOTIFY_PLATFORM_RATE_WINDOW_SECONDS',
      process.env.NOTIFY_PLATFORM_RATE_WINDOW_SECONDS,
      knobs.platformRateWindowSeconds,
      's',
    ],
    [
      'NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR',
      process.env.NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR,
      knobs.systemAlertMaxPerHour,
      'per hour (per arm)',
    ],
    ['NOTIFY_HTTP_TIMEOUT_MS', process.env.NOTIFY_HTTP_TIMEOUT_MS, knobs.httpTimeoutMs, 'ms'],
  ];
  for (const [key, raw, value, unit] of fallbackRows) {
    if (isParseFallback(raw)) {
      warnings.push(
        `${key} is not a positive integer — falling back to the default of ${value} ${unit} ` +
          '(the configured value was ignored).',
      );
    }
  }

  return { ...knobs, warnings };
}

/**
 * 解析 `NOTIFY_CATEGORIES` 类别白名单（非法 token 忽略 + 一条净化 warning）。
 *
 * 规则（顺序固定）：空白串 ⇒ 回落缺省集；非法 token ⇒ 一条 warning（名字经 `sanitizeLogValue`
 * 净化）、不入选；合法 token ⇒ 去重保序入选。
 *
 * @returns `{ categories, warnings }`
 */
function resolveCategories(): { categories: NotifyCategory[]; warnings: string[] } {
  const raw = process.env.NOTIFY_CATEGORIES;
  const warnings: string[] = [];

  // 空白串视同"未配置" ⇒ 回落缺省集（**不**产 warning：这是正常缺省态）
  if (!raw?.trim()) {
    return { categories: [...DEFAULT_NOTIFY_CATEGORIES], warnings };
  }

  const categories: NotifyCategory[] = [];
  for (const token of splitTokens(raw)) {
    if (!(NOTIFY_CATEGORIES as readonly string[]).includes(token)) {
      warnings.push(
        `NOTIFY_CATEGORIES: "${sanitizeLogValue(token)}" is not a known category — the entry was ` +
          `ignored (known: ${NOTIFY_CATEGORIES.join(', ')}).`,
      );
      continue;
    }
    if (!categories.includes(token as NotifyCategory)) categories.push(token as NotifyCategory);
  }
  return { categories, warnings };
}

/**
 * 解析 `NOTIFY_PROVIDERS` provider 白名单（未知 token 忽略 + 一条净化 warning，fail-open）。
 */
function resolveProviders(): { providers: NotifyProviderToken[]; warnings: string[] } {
  const warnings: string[] = [];
  const providers: NotifyProviderToken[] = [];
  for (const token of splitTokens(process.env.NOTIFY_PROVIDERS)) {
    if (!(NOTIFY_PROVIDER_TOKENS as readonly string[]).includes(token)) {
      warnings.push(
        `NOTIFY_PROVIDERS: "${sanitizeLogValue(token)}" is not a known provider — the entry was ` +
          `ignored (known: ${NOTIFY_PROVIDER_TOKENS.join(', ')}).`,
      );
      continue;
    }
    if (!providers.includes(token as NotifyProviderToken)) {
      providers.push(token as NotifyProviderToken);
    }
  }
  return { providers, warnings };
}

/**
 * production fail-fast 矩阵（**二期起两组合**：① 关开关不校验 ② feishu 缺三键即抛；dev/test
 * 降级为 warnings——见文件头 [关键不变量]）。
 *
 * 文案铁律：只出现**键名 / 合法值域 / 逃生阀 / 出境声明**，绝不回显任何键的值。
 *
 * @param enabled 总开关
 * @param providers 已解析 provider 白名单
 * @param resolved 该部署是否 production 及各必填键的值
 * @returns dev/test 下的降级 warnings（production 下不满足即抛，返回值恒为空）
 */
function enforceFailFastMatrix(
  enabled: boolean,
  providers: NotifyProviderToken[],
  resolved: {
    isProduction: boolean;
    feishuAppId: string | null;
    feishuAppSecret: string | null;
    feishuRecipientOpenId: string | null;
    webBaseUrl: string | null;
    ownerUsernames: string[];
  },
): string[] {
  // ① ENABLED=false ⇒ 不校验任何键（缺省态不打扰部署）
  if (!enabled) return [];

  const warnings: string[] = [];

  // ② providers 含 feishu ⇒ 三键必填（Notifications 二期：`FEISHU_RECIPIENT_OPEN_ID` 从必填表
  //    撤出——二期收件人来自用户各自的渠道绑定，env 里的 open_id 只是 D4 的**播种源**，缺它只
  //    意味着"无法自动播种一次"，不再意味着"通知发不出去"）。
  if (providers.includes('feishu')) {
    const missing = [
      ['FEISHU_APP_ID', resolved.feishuAppId],
      ['FEISHU_APP_SECRET', resolved.feishuAppSecret],
      ['NOTIFY_WEB_BASE_URL', resolved.webBaseUrl],
    ].filter(([, value]) => !value) as Array<[string, unknown]>;

    if (missing.length > 0) {
      // 文案结构：① 缺了哪几个键 ② 为什么危险（出境声明逐字引用单源）③ 如何关掉
      const message =
        `NOTIFY_ENABLED=true with the "feishu" provider requires ${missing
          .map(([key]) => key)
          .join(' and ')}. Every external notification leaves your network — fields that egress: ` +
        `${NOTIFY_EGRESS_DECLARATION}. ${NOTIFY_DISABLE_HINT}`;
      if (resolved.isProduction) throw new Error(message);
      warnings.push(message);
    }
  }

  // ③ 撤除（Notifications 二期）：一期是"categories 含 topic ⇒ NOTIFY_OWNER_USERNAMES 必填"
  //    （否则 topic 类别静默全灭）。二期 topic 的收件人来自用户各自的渠道绑定，owner 名单降级为
  //    **D4 播种源**——由 orchestrator 播种 outcome（`skipped_no_source` ⇒ throw）按**真实 DB 事实**
  //    判定（"有地址但解析不出唯一归属"），比这里"env 键是否为空"精确得多。此处刻意留注释（不静默
  //    删除）：将来若有人"顺手加回来"，会先读到为什么它不该回来。

  return warnings;
}

export default registerAs('notifications', (): NotificationsConfig => {
  // 布尔约定 = 仓内既有形态（`=== 'true'`，与 DB_SSL / MINIO_USE_SSL / HUMENT_PROVISIONING_ENABLED
  // 同口径）：非 `'true'` 一律视为关闭，**缺省即关闭**（出境功能唯一可接受缺省）。
  const enabled = process.env.NOTIFY_ENABLED === 'true';

  const categoryKnobs = resolveCategories();
  const providerKnobs = resolveProviders();

  // 飞书四键：trim 归一（.env 尾随空格 / CRLF 污染不得把合法值判成非法），空串 ⇒ null
  const feishuAppId = process.env.FEISHU_APP_ID?.trim() || null;
  const feishuAppSecret = process.env.FEISHU_APP_SECRET?.trim() || null;
  const feishuRecipientOpenId = process.env.FEISHU_RECIPIENT_OPEN_ID?.trim() || null;
  // 深链基址：**去掉尾斜杠**（拼接端统一 `base + path`，尾斜杠会造出 `//tasks/...` 双斜杠）
  const webBaseUrl = process.env.NOTIFY_WEB_BASE_URL?.trim().replace(/\/+$/, '') || null;
  const ownerUsernames = splitTokens(process.env.NOTIFY_OWNER_USERNAMES);

  const knobs = resolveNumericKnobs();

  const matrixWarnings = enforceFailFastMatrix(enabled, providerKnobs.providers, {
    isProduction: process.env.NODE_ENV === 'production',
    feishuAppId,
    feishuAppSecret,
    feishuRecipientOpenId,
    webBaseUrl,
    ownerUsernames,
  });

  return {
    /** 总开关（缺省 false；非 'true' 一律关闭） */
    enabled,
    /** 细粒度类别白名单（缺省 `task_done,direct`；非法 token 已剔除） */
    categories: categoryKnobs.categories,
    /** provider 白名单（缺省空集；未知 token 已剔除） */
    providers: providerKnobs.providers,
    /** 飞书 App ID（未配置 null） */
    feishuAppId,
    /** 飞书 App Secret（未配置 null；**绝不入日志 / 投递记录 / 响应体**） */
    feishuAppSecret,
    /** 单收件人 open_id（未配置 null） */
    feishuRecipientOpenId,
    /** owner 平台 username 列表（启动解析成 actorId；自回声与 topic 参与判定的输入） */
    ownerUsernames,
    /** 深链基址（尾斜杠已剥；未配置 null） */
    webBaseUrl,
    /** L1 per-task 窗口（秒） */
    taskThrottleSeconds: knobs.taskThrottleSeconds,
    /** L1 per-doc 窗口（秒） */
    docThrottleSeconds: knobs.docThrottleSeconds,
    /** L1 per-topic 窗口（秒） */
    topicThrottleSeconds: knobs.topicThrottleSeconds,
    /** L2 窗口条数 */
    globalRateLimit: knobs.globalRateLimit,
    /** L2 窗口长度（秒） */
    globalRateWindowSeconds: knobs.globalRateWindowSeconds,
    /** 直发窗口条数 */
    directRateLimitPerWindow: knobs.directRateLimitPerWindow,
    /** 直发窗口长度（秒） */
    directRateWindowSeconds: knobs.directRateWindowSeconds,
    /** 部署级出境总闸条数（Notifications 二期） */
    platformRateLimit: knobs.platformRateLimit,
    /** 部署级出境总闸窗口长度（秒） */
    platformRateWindowSeconds: knobs.platformRateWindowSeconds,
    /** 系统告警每小时上限（per arm；缺省 12） */
    systemAlertMaxPerHour: knobs.systemAlertMaxPerHour,
    /** provider HTTP 超时（毫秒） */
    httpTimeoutMs: knobs.httpTimeoutMs,
    /** 配置组合异常（**已净化**；由 provider 工厂启动时逐条 warn；空数组 = 无异常） */
    warnings: [
      ...categoryKnobs.warnings,
      ...providerKnobs.warnings,
      ...knobs.warnings,
      ...matrixWarnings,
    ],
  };
});
