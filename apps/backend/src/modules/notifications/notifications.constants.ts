/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块的**共享常量单源**：分页缺省 / 直发幂等与预算 / 直发信封的 reason
 *     值域。凡"两个文件都要用同一个数/同一份值域"的地方，值都放这里（memory.constants /
 *     experience.constants 同款）。
 *
 * [代码职责]
 *   - 分页缺省（admin 列表端点与投递记录仓储共用）
 *   - 直发链路的三个契约数字：幂等 TTL / 幂等表容量 / 同步等待预算（尝试数与毫秒）
 *   - `NOTIFY_DIRECT_REASONS`：直发信封 `reason` 的**封闭八值**（单源；service 实现、
 *     controller 的 Swagger enum、单测矩阵都引用它）
 *
 * ⚠️ 本文件**只放字面量**，不 import 模块内任何东西——它是所有文件的依赖叶子，
 * 引入任何模块内 import 都会制造环（DTO ↔ service ↔ 常量）。
 *
 * [权威文档]
 *   - 主文档: 线上 `docs/api-definition.md` §20.1（直发端点契约：幂等 TTL 10min、同步预算
 *     ≤2 次 / ≤10s、reason **八值**——二期新增 `recipient_not_bound`）/ §20.2（分页信封）
 *
 * [关键不变量]
 *   - **`reason` 是封闭八值**（plan §7.1 + §D5 的 `recipient_not_bound`）：新增/删除值必须同
 *     commit 改本数组、service 的产出点、controller 的 `@ApiOperation`/`@ApiResponse` 与单测
 *     矩阵（值域断言会红）。值域敞口 = agent 拿到一个它没写过分支处理的理由，只能瞎猜下一步。
 *   - **直发预算 ≤10s 是 agent 客户端超时保护**：本端点是**同步等待**的（不是
 *     fire-and-forget），预算失控会让 agent 侧先超时、把一次成功投递记成失败。改数字必须
 *     同时核对 `NotifySendOptions` 的夹逼语义（feishu 叶子）。
 *   - **幂等表容量 1000**：内存表（进程内、重启清零）。容量只影响"极少数并发 agent 的
 *     幂等命中率"，不影响正确性——淘汰最旧的键最坏退化为"重放变成真发"。
 *
 * [关联代码]
 *   - dto/query-notification-deliveries.dto.ts — 分页缺省的两个消费者之一
 *   - notify-direct.service.ts — 幂等 / 预算 / reason 的实现方
 *   - notify-delivery.repository.ts — 分页的另一个消费者（形状必须与 DTO 一致）
 *   - ../../config/notifications.config.ts — 节流窗口与类别值域（那些值在 config 工厂里）
 * =============================================================================
 */

/** admin 列表缺省每页条数（与 webhook 的 20 同尺度，便于运维在两个列表间平移习惯） */
export const NOTIFY_DEFAULT_PAGE_SIZE = 20;

/** admin 列表每页上限（防一次拉全表把 admin 页面与响应体打爆） */
export const NOTIFY_MAX_PAGE_SIZE = 100;

/**
 * 直发幂等键的生存时间（毫秒）。
 *
 * rationale：10 分钟覆盖"agent 发起 → 客户端超时 → 重试"的完整窗口（agent 客户端超时
 * 通常在秒级，加上模型回合的思考时间也很少超过几分钟）。太短 ⇒ 重试变成第二次真发
 * （人收到两条一样的消息）；太长 ⇒ 内存表被低频 agent 的旧键长期占位。
 */
export const NOTIFY_DIRECT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/**
 * 直发幂等表容量上限（满则插前删最旧；见 `TtlMap`）。
 *
 * rationale：单条 ≈ 一条正文（≤2000 字符）+ 一个信封，1000 条 ≈ 2MB 级内存；淘汰最旧的键
 * 只影响命中率、不影响正确性（见文件头不变量）。
 */
export const NOTIFY_DIRECT_IDEMPOTENCY_MAX_ENTRIES = 1_000;

/** 直发同步等待的**最大尝试次数**（含首次）——plan §7.1 的 ≤2 次 */
export const NOTIFY_DIRECT_MAX_ATTEMPTS = 2;

/** 直发同步等待的**总预算毫秒数**——plan §7.1 的 ≤10s（见文件头不变量） */
export const NOTIFY_DIRECT_BUDGET_MS = 10_000;

/**
 * 直发投递记录行的标题长度上限（与 `notification_deliveries.title` 列宽一致）。
 *
 * ⚠️ 直发的 title 只放 `[<agent 显示名>]` 这一个**短标签**，正文全在 `body`（见
 * notify-direct.service.ts 的渲染注释）——所以这里只是防御性截断。
 */
export const NOTIFY_DIRECT_TITLE_MAX_LENGTH = 200;

/**
 * 直发信封 `reason` 的**封闭取值**（单源，见文件头不变量）。
 *
 * 每条对应 agent 的一个不同下一步：
 * - `notify_disabled`：本部署没开通知出口 ⇒ 改用平台内汇报（任务评论 / 话题消息）
 * - `no_provider`：开了通知但**没有可用的出口**（运维问题；也包含"收件人绑定的渠道不在本部署
 *   的出口列表里"这一理论分支）⇒ 同上，并可提示 Owner
 * - `no_recipient`：**认不出收件人**。一期义 = 没配部署级收件人 open_id；二期批 2 起部署级
 *   收件人已退役，本值收窄为"调用 agent 的认证载荷里没有可解析的 creator（`owner_id`）"
 *   ——那是身份投影的畸形请求，不是用户状态 ⇒ 同上，并提示运维。**"creator 存在但没绑渠道"
 *   走 `recipient_not_bound`，两者不要混。**
 * - `recipient_not_bound`：**你的 creator（这条 agent 的人类 owner）此刻没有任何已验证的通知
 *   渠道** ⇒ 转告你的 creator：Settings → Notifications 绑定并验证一个渠道。**别重试**（重试
 *   不会让渠道凭空出现；但幂等键**不会**被这条结论缓存住——creator 绑好之后同键重放能真发）
 * - `delivery_failed`：**已确认**投递失败（重试预算已用尽）⇒ 换**新幂等键**退避重试 1 次
 * - `category_disabled`：运维把 `direct` 类别关了 ⇒ 请运维在 `NOTIFY_CATEGORIES` 里加上
 * - `rate_limited`：L2 全局窗口耗尽时的**信封内占位值**（正常路径走 HTTP 429，此值预留给
 *   "HTTP 200 内嵌降级"的场景）
 * - `self_echo`：**人类**调用者就是收件人本人（人不通知自己）⇒ 无需任何动作
 */
export const NOTIFY_DIRECT_REASONS = [
  'notify_disabled',
  'no_provider',
  'no_recipient',
  'recipient_not_bound',
  'delivery_failed',
  'category_disabled',
  'rate_limited',
  'self_echo',
] as const;

/** 直发信封 `reason` 的类型（由 {@link NOTIFY_DIRECT_REASONS} 派生） */
export type NotifyDirectReason = (typeof NOTIFY_DIRECT_REASONS)[number];

/**
 * **可以进幂等缓存的 reason**（"已经发生过的投递结论"；单源，判据在 notify-direct.service.ts
 * 的 `shouldCacheDirectEnvelope`）。
 *
 * - `delivery_failed`：**确认发失败了**（重试预算已用尽）⇒ 重放同一个键拿到同一个结论；
 *   要真重跑必须换新键（plan §7.1 的两种重试语义）。
 * - `self_echo`：身份事实（**人类**调用者就是收件人本人）⇒ 在认证身份变化之前不会变。
 *
 * ⚠️ **五个"配置/状态类降级"刻意不在列**（`notify_disabled` / `category_disabled` /
 * `no_provider` / `no_recipient` / **`recipient_not_bound`**）：它们是"此刻的状态"而不是
 * "这次投递的结论"。缓存 10 分钟 = 运维把出口配好、或 **creator 把渠道绑好**之后，
 * **调用方继续被骗 10 分钟**（"平台说没绑渠道"）——那是最难排的一类假象，且重放同一个键本来就
 * 不该被这种状态绑住。`recipient_not_bound` 尤为典型：它描述的是**某个用户**的绑定状态，
 * 而那是**随时可被用户自己改变**的事实。
 */
export const NOTIFY_DIRECT_CACHEABLE_REASONS: readonly NotifyDirectReason[] = [
  'delivery_failed',
  'self_echo',
];

/**
 * test 端点（`POST /notification-settings/me/channels/:provider/test`）的 **per-user 入口闸**：
 * 每用户每窗口最多发几条测试消息。
 *
 * rationale（plan §D5）：测试消息是**真出境**（会真的发到用户手机上），必须防滥用——
 * 3 条/60s 够用户"改一次地址验证一次"重试两轮，又不足以把测试按钮当骚扰工具。
 * 与直发入口闸（`NOTIFY_DIRECT_RATE_LIMIT_PER_WINDOW`）**分开记账**：直发闸是给 agent 的，
 * 把两者并成一个窗口会让 agent 的直发把用户的验证额度吃光。
 */
export const NOTIFY_CHANNEL_TEST_RATE_LIMIT_PER_WINDOW = 3;

/** test 端点 per-user 入口闸的窗口长度（秒）——与 {@link NOTIFY_CHANNEL_TEST_RATE_LIMIT_PER_WINDOW} 成对 */
export const NOTIFY_CHANNEL_TEST_RATE_WINDOW_SECONDS = 60;

/**
 * test 端点投递的标题前缀（可 grep 的对账锚点，也让用户在飞书里一眼认出这是条测试）。
 *
 * 与 `direct` 的 `[<agent 名>]` 前缀刻意不同：测试消息不发自任何 agent。
 */
export const NOTIFY_CHANNEL_TEST_TITLE = '[测试] 通知渠道验证';
