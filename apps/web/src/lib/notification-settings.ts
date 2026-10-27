/**
 * notification-settings.ts — 通知设置面（Notifications 二期批 3）的**纯逻辑单源**。
 *
 * 为什么单独成文件（而不是散在组件里）：
 * - **10 类别顺序 / 4 组分组**是这一屏的骨架，必须只有一个来源——顺序漂移会让分组标题
 *   与开关错位（最难看的一类 bug），而分组本身又是纯数据；
 * - **错误分类**（409 占用 / 400 未验证 / 限流 429 / 平台运维态）是**判据**不是文案：
 *   判据进 lib（可单测），文案进组件（靠 `useTranslations` 的字面量键拿到编译期校验）。
 *   混在一起就只能靠"渲染一个真组件再看文字"来验证判据，代价高且脆。
 *
 * ⚠️ 值域单源在**后端**：`apps/backend/src/config/notifications.config.ts` 的
 * `NOTIFY_CATEGORIES`（10 类，顺序即此处顺序）与 `DEFAULT_NOTIFY_CATEGORIES`
 * （缺省集 `task_done + direct`）。web 侧刻意**不从后端 import**（跨端边界），
 * 故这里复刻一份并靠 `notification-category-parity` 单测锁住"10 类键集一致"。
 *
 * [关联代码]
 * - lib/api.ts — `Api.notificationSettings` 六方法（本文件的类型消费点）
 * - components/settings/notifications-tab.tsx — 本文件的唯一 UI 消费方
 * - app/(main)/settings/page.tsx — 三 tab 壳（通知 tab 的宿主）
 */

// ──────────────────────────────────────────────
// 类别：单源顺序 + 4 组分组
// ──────────────────────────────────────────────

/**
 * 10 个通知类别（顺序 = 后端 `NOTIFY_CATEGORIES` 顺序 = 后端 `prefs.categories` 的键序）。
 *
 * 顺序有意义：偏好区按它渲染，读屏/键盘遍历顺序与产品文档顺序一致。
 */
export const NOTIFICATION_CATEGORY_KEYS = [
  'task_done',
  'task_created',
  'task_updated',
  'task_assigned',
  'topic',
  'doc_created',
  'doc_updated',
  'doc_deleted',
  'doc_moved',
  'direct',
] as const;

/** 单个通知类别键（由 {@link NOTIFICATION_CATEGORY_KEYS} 派生，禁止手写第二份联合类型） */
export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORY_KEYS)[number];

/** 类别偏好映射（后端 `prefs.categories` 已归一为全键布尔，10 键恒在） */
export type NotificationCategoryPrefs = Record<NotificationCategoryKey, boolean>;

/** 偏好区的一个分组（组标题 + 该组类别，顺序即渲染顺序） */
export interface NotificationCategoryGroup {
  /** 分组 id（i18n 键后缀，如 `tasks`） */
  id: 'tasks' | 'topics' | 'docs' | 'direct';
  /** 该组的类别键（必须是 {@link NOTIFICATION_CATEGORY_KEYS} 的子集且四组不重不漏） */
  keys: readonly NotificationCategoryKey[];
}

/**
 * 4 组分组（plan §D2：任务 / 话题 / 文档 / 直发）。
 *
 * 分组与 10 类的关系由单测锁死：四组并集 == 10 类全集、组间无交集、组内顺序 == 全局顺序。
 */
export const NOTIFICATION_CATEGORY_GROUPS: readonly NotificationCategoryGroup[] = [
  { id: 'tasks', keys: ['task_done', 'task_created', 'task_updated', 'task_assigned'] },
  { id: 'topics', keys: ['topic'] },
  { id: 'docs', keys: ['doc_created', 'doc_updated', 'doc_deleted', 'doc_moved'] },
  { id: 'direct', keys: ['direct'] },
] as const;

/** 缺省开启的类别集（与后端 `DEFAULT_NOTIFY_CATEGORIES` 一致；仅用于说明文案，不参与判定） */
export const NOTIFICATION_DEFAULT_CATEGORY_KEYS: readonly NotificationCategoryKey[] = [
  'task_done',
  'direct',
];

/**
 * 通知设置 query 键（tab / 渠道卡 / 偏好区三处**必须共用同一把键**）。
 *
 * 为什么提到 lib：渠道卡的 optimistic 回滚要 `setQueryData` 同一把键，偏好区的
 * 即改即存也要写同一把键——三处各写字符串字面量必然漂移（而且漂移是静默的：
 * 只是"回滚没生效/界面不刷新"，没有任何报错）。放一处，改一处。
 */
export const NOTIFICATION_SETTINGS_QUERY_KEY = ['notification-settings', 'me'] as const;

// ──────────────────────────────────────────────
// 飞书 open_id 预检
// ──────────────────────────────────────────────

/**
 * 飞书 open_id 格式（**与后端 `UpdateChannelDto` 的 `@Matches` 逐字同源**）：
 * `ou_` + 1~200 个 `[A-Za-z0-9_-]`。
 *
 * 前端预检的意义是"不把必然 400 的请求发出去"，不是安全边界（后端仍会校验）。
 */
export const FEISHU_OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,200}$/;

/**
 * open_id 格式预检。
 *
 * @param value 用户输入的原始值（本函数自行 trim；全空白 ⇒ false）
 * @returns 是否形如合法 open_id
 */
export function isValidFeishuOpenId(value: string): boolean {
  return FEISHU_OPEN_ID_PATTERN.test(value.trim());
}

// ──────────────────────────────────────────────
// 渠道四态徽标 + 验证不变量（与后端 `deliveryEligible` 同口径的部分）
// ──────────────────────────────────────────────

/** 验证态原始值（null = 从未测试 / 未验证） */
export type NotificationTestStatus = 'ok' | 'failed' | 'seeded' | null;

/**
 * 验证态字面量常量。
 *
 * 为什么要常量而不是直接写 `=== 'failed'`：本仓的 `no-magic-string-compare` 规则把
 * `'failed'`（与 WebhookStatus 撞值）列进黑名单——判据要么走枚举要么走常量，
 * 写裸字面量 lint 直接报错。这里给三个值一个具名常量，比较点全部走它。
 */
export const NOTIFICATION_TEST_STATUS = {
  /** 测试通过（可投递、徽标「已验证」） */
  ok: 'ok',
  /** 测试失败（调用过 provider 且失败；徽标「验证失败」） */
  failed: 'failed',
  /** 由部署配置播种（投递可信，但用户没验证过；徽标「已导入·未验证」） */
  seeded: 'seeded',
} as const;

/** 需要显示「已保存」灰字提示的类别（`topic` 与 ResourceType 撞值，故走常量比较） */
export const NOTIFICATION_TOPIC_CATEGORY: NotificationCategoryKey = 'topic';

/**
 * 飞书 provider 标识（值域单源 = 后端 `NOTIFY_PROVIDER_TOKENS`）。
 *
 * 单独成常量而不是各处写 `'feishu'`：provider 标识会同时出现在路径参数、平台能力匹配、
 * 渠道查找三处，裸字面量在重构（换 token 值）时会漏改一处而**静默失效**。
 */
export const NOTIFICATION_FEISHU_PROVIDER = 'feishu';

/** 渠道绑定来源（`env_seed` = 部署配置导入） */
export type NotificationChannelSource = 'env_seed' | 'user';

/** 飞书渠道视图（`GET /notification-settings/me` 的 `channels[]` 元素；tombstone 行已被后端过滤） */
export interface NotificationChannelView {
  /** 渠道 provider（当前仅 `feishu`） */
  provider: string;
  /** 收件地址（飞书 = open_id） */
  recipientAddress: string;
  /** 是否启用（false = 静音或未验证） */
  enabled: boolean;
  /** 验证态（驱动四态徽标） */
  lastTestStatus: NotificationTestStatus;
  /** 最近测试时刻（ISO 串；null = 从未测试） */
  lastTestAt: string | null;
  /** 绑定来源 */
  source: NotificationChannelSource;
  /** 行创建时刻（ISO 串） */
  createdAt: string;
}

/** 平台能力块（`GET /notification-settings/me` 的 `platform`；**只回布尔/部署常量，不回任何凭据**） */
export interface NotificationPlatformView {
  /** 已知 provider 及"本部署能否用它投递"（`configured=false` ⇒ 前端禁用表单并提示联系管理员） */
  providers: { key: string; configured: boolean }[];
  /** 部署启用的类别集（据此把未启用行置灰 + 「平台未启用」徽标） */
  categories: NotificationCategoryKey[];
  /** 深链基址（未配 null） */
  webBaseUrl: string | null;
}

/**
 * 通知设置面完整响应（`GET /notification-settings/me`，镜像后端 `NotificationSettingsView`）。
 *
 * 形状单源放本文件而不是 `lib/api.ts`：api.ts 的请求编排要 import 本文件的类别值域类型，
 * 若形状也写在 api.ts，lib ↔ api 就成环（本仓 `api ↔ auth.store` 已有拆环先例）。
 */
export interface NotificationSettingsView {
  /** 该用户的非 tombstone 渠道列表（解绑后的行对用户不可见） */
  channels: NotificationChannelView[];
  /** 归一后的偏好（全键布尔映射 + 部署缺省集 + 作用域触发面） */
  prefs: {
    /** 白名单 10 类的完整布尔映射（读取已归一，10 键恒在） */
    categories: NotificationCategoryPrefs;
    /** 部署缺省开启的类别（常量；用户覆盖层的参照） */
    defaults: NotificationCategoryKey[];
    /** 作用域类通知的**触发面**（不是"会不会收到"） */
    relevantScopes: { topics: number; boards: number; spaces: number };
  };
  /** 平台能力 */
  platform: NotificationPlatformView;
}

/**
 * 测试消息应答信封（`POST /notification-settings/me/channels/:provider/test`；
 * 与直发端点同一形状——`delivered=0` 时 `reason` 说明降级原因）。
 */
export interface NotificationTestEnvelope {
  /** 是否真的发出了（1 = 已投递；0 = 降级，看 reason） */
  delivered: 0 | 1;
  /** 实际投递到的渠道标识（降级时为空数组） */
  channels: string[];
  /** 降级原因（成功时字段缺席） */
  reason?: NotificationTestReason;
}

/**
 * 渠道四态徽标状态（plan §D6 的"四态徽标"）。
 *
 * - `unbound`：未绑定（secondary）
 * - `unverified`：已绑定但从未验证（warning）
 * - `seeded`：**已从部署配置导入、未验证**（warning；文案特化，不冒充「已验证」）
 * - `verified`：测试通过（success）
 * - `failed`：测试失败（destructive）
 */
export type NotificationChannelBadgeState =
  | 'unbound'
  | 'unverified'
  | 'seeded'
  | 'verified'
  | 'failed';

/**
 * 由渠道行推导徽标状态。
 *
 * `seeded` 与 `verified` 刻意分开：播种行**投递可信**但用户**没验证过自己的地址**，
 * 徽标若合并会让「已验证」变成一句不成立的陈述（plan §D2「未验证是 UI 陈述」）。
 *
 * @param channel 渠道行（null = 未绑定）
 * @returns 徽标状态
 */
export function resolveChannelBadgeState(
  channel: NotificationChannelView | null,
): NotificationChannelBadgeState {
  if (!channel) return 'unbound';
  if (channel.lastTestStatus === NOTIFICATION_TEST_STATUS.ok) return 'verified';
  if (channel.lastTestStatus === NOTIFICATION_TEST_STATUS.failed) return 'failed';
  if (channel.lastTestStatus === NOTIFICATION_TEST_STATUS.seeded) return 'seeded';
  return 'unverified';
}

/**
 * 该地址是否已满足「可以置 `enabled=true`」的服务端不变量
 * （`last_test_status IN ('ok','seeded')`，plan §D5）。
 *
 * 播种行（`seeded`）**满足**：它带着 `last_test_address` 落库，是可信投递地址。
 * 前端用它决定「启用」开关是否可点击——把必然 400 的操作直接做成禁用态，
 * 比让用户点了再吃一个错误弹窗好。
 */
export function isChannelVerified(channel: NotificationChannelView | null): boolean {
  return (
    channel?.lastTestStatus === NOTIFICATION_TEST_STATUS.ok ||
    channel?.lastTestStatus === NOTIFICATION_TEST_STATUS.seeded
  );
}

/**
 * 是否需要在渠道卡顶部显示「还差一步」状态条（plan §D6：`lastTestStatus !== 'ok'`，
 * 覆盖 NULL / failed / seeded 三态）。
 */
export function needsChannelVerification(channel: NotificationChannelView | null): boolean {
  return !!channel && channel.lastTestStatus !== NOTIFICATION_TEST_STATUS.ok;
}

/**
 * 是否需要显示「平台未配置飞书应用」提示并禁用表单。
 *
 * @param providers `platform.providers`（只含布尔 `configured`，不回任何凭据）
 * @returns 飞书 provider 存在但未配置时为 true
 */
export function isFeishuProviderUnconfigured(
  providers: readonly { key: string; configured: boolean }[],
): boolean {
  const feishu = providers.find((p) => p.key === 'feishu');
  return !!feishu && !feishu.configured;
}

// ──────────────────────────────────────────────
// 错误分类（判据；文案在组件里按字面量键取）
// ──────────────────────────────────────────────

/** HTTP 错误的可判定部分（从 axios 错误里安全提取；缺失一律 null/空串） */
export interface ParsedHttpError {
  /** HTTP 状态码（非 HTTP 错误 ⇒ null） */
  status: number | null;
  /** 后端 `message`（英文长文案；仅用于**分类**，绝不直接回显给用户） */
  message: string;
  /** 429 的 `data.retryAfterSeconds`（缺失 ⇒ undefined） */
  retryAfterSeconds?: number;
}

/**
 * 从任意抛出值里安全提取 HTTP 错误要素。
 *
 * 为什么要"安全提取"：`apiRequest` 抛的是 AxiosError，但组件树里也可能抛别的（渲染期错误、
 * mock 的不完整对象）。分类器不该因为读不到字段就崩——读不到就当作"未知错误"。
 *
 * @param err 抛出值（任意）
 * @returns 归一后的可判定要素
 */
export function parseNotificationError(err: unknown): ParsedHttpError {
  const response = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  const status = typeof response?.status === 'number' ? response.status : null;
  const body = response?.data as { message?: unknown; data?: unknown } | undefined;
  const message = typeof body?.message === 'string' ? body.message : '';
  const retryAfter = (body?.data as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  return {
    status,
    message,
    retryAfterSeconds: typeof retryAfter === 'number' ? retryAfter : undefined,
  };
}

/**
 * 渠道写操作（保存 / 静音 / 解绑 / 测试）失败原因的分类。
 *
 * - `addressTaken`：409 —— 该地址已被**其他账户**验证占用（后端长英文文案 → 人话）
 * - `channelExists`：409 —— 你自己已有绑定（并发双提交；文案与上面不同）
 * - `invalidAddress`：400 —— open_id 格式被后端拒绝
 * - `notVerified`：400 —— 未验证就置 `enabled=true`
 * - `missingAddress`：400 —— 首次绑定没给地址
 * - `noBinding`：404 —— 无活绑定（从未绑定 / 已解绑：同一件事）
 * - `rateLimited`：429 —— 太频繁（带 `retryAfterSeconds`）
 * - `unknown`：其余（含网络错误 / 5xx）
 */
export type NotificationChannelErrorKind =
  | 'addressTaken'
  | 'channelExists'
  | 'invalidAddress'
  | 'notVerified'
  | 'missingAddress'
  | 'noBinding'
  | 'rateLimited'
  | 'unknown';

/**
 * 把 HTTP 错误分类成 {@link NotificationChannelErrorKind}。
 *
 * 分类依据 = **状态码 + 后端英文文案的稳定片段**（不比对全文：文案会演化，判据要稳）。
 * 后端三处文案锚点（`notification-settings.service.ts`）：地址占用 `already bound to another
 * platform account`；自身重复绑定 `already has a binding`；未验证 `has not been verified`。
 *
 * @param err 抛出值
 * @returns 分类结果（未知一律 `unknown`）
 */
export function classifyChannelError(err: unknown): NotificationChannelErrorKind {
  const { status, message } = parseNotificationError(err);
  if (status === 429) return 'rateLimited';
  if (status === 409) {
    return /already bound to another platform account/i.test(message)
      ? 'addressTaken'
      : 'channelExists';
  }
  if (status === 400) {
    if (/has not been verified/i.test(message)) return 'notVerified';
    // ⚠️ 顺序有意义：首绑缺地址的文案里**也含 "recipientOpenId"**，先判它才不会误分类
    if (/required to bind/i.test(message)) return 'missingAddress';
    if (/must be a Feishu open_id|open_id format/i.test(message)) return 'invalidAddress';
    return 'unknown';
  }
  if (status === 404) return 'noBinding';
  return 'unknown';
}

/** 测试消息降级原因（后端 `NOTIFY_DIRECT_REASONS` 的封闭值域，此处只用得上的子集） */
export type NotificationTestReason =
  | 'notify_disabled'
  | 'no_provider'
  | 'no_recipient'
  | 'recipient_not_bound'
  | 'delivery_failed'
  | 'category_disabled'
  | 'rate_limited'
  | 'self_echo';

/**
 * 测试消息失败原因分类。
 *
 * - `admin` 族：`no_provider` / `notify_disabled` / `category_disabled` —— **运维侧**未就绪，
 *   用户改不了任何东西（后端刻意不写验证态："此刻的运维状态 ≠ 这个地址的判决"）
 * - `deliveryFailed`：真调过 provider 且失败 ⇒ 大概率是 open_id 填错
 * - `rateLimited`：信封内嵌的 `rate_limited`（正常路径走 HTTP 429）
 * - `other`：`no_recipient` / `recipient_not_bound` / `self_echo` 等（本屏语境下不该出现）
 *
 * @param reason 后端信封的 reason（可能缺失）
 * @returns 分类
 */
export type NotificationTestFailureKind =
  | 'noProvider'
  | 'notifyDisabled'
  | 'categoryDisabled'
  | 'deliveryFailed'
  | 'rateLimited'
  | 'other';

export function classifyTestReason(reason: string | undefined): NotificationTestFailureKind {
  switch (reason) {
    case 'no_provider':
      return 'noProvider';
    case 'notify_disabled':
      return 'notifyDisabled';
    case 'category_disabled':
      return 'categoryDisabled';
    case 'delivery_failed':
      return 'deliveryFailed';
    case 'rate_limited':
      return 'rateLimited';
    default:
      return 'other';
  }
}

// ──────────────────────────────────────────────
// 一次性提示（localStorage 已读标记）
// ──────────────────────────────────────────────

/**
 * 一次性提示的 localStorage 键。
 *
 * 代价（plan §D6 显式声明）：标记按**浏览器**记，换设备/换浏览器会重现。
 * 服务端没有"已读"字段，也不该为此新增后端面（零新后端面是本批的硬约束）。
 */
export const NOTIFICATION_NOTICE_STORAGE_KEYS = {
  /** 升级日横幅（channels 为空时的一次性引导） */
  upgradeBanner: 'notify:upgrade-banner-dismissed',
  /** `env_seed` 行首次进 tab 的告知 */
  envSeedNotice: 'notify:env-seed-notice-read',
} as const;

/** 一次性提示键（{@link NOTIFICATION_NOTICE_STORAGE_KEYS} 的值域） */
export type NotificationNoticeKey =
  (typeof NOTIFICATION_NOTICE_STORAGE_KEYS)[keyof typeof NOTIFICATION_NOTICE_STORAGE_KEYS];

/**
 * 该一次性提示是否已被用户处理过。
 *
 * SSR / 私隐模式（localStorage 抛异常）一律当"未读"——宁可多提示一次，不可静默吞掉引导。
 *
 * @param key 存储键
 * @returns 已读为 true
 */
export function isNoticeDismissed(key: NotificationNoticeKey): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * 标记一次性提示已处理（失败静默：写不进去的代价只是下次再提示一遍）。
 *
 * @param key 存储键
 */
export function markNoticeDismissed(key: NotificationNoticeKey): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // 私隐模式 / 配额满：忽略——已读标记是体验优化，不是契约
  }
}
