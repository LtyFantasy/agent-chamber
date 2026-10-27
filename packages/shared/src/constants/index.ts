export * from './distribution';

export const API_PREFIX = '/api/v1';

/**
 * 系统 actor 哨兵 id（ActorUnification migration 1781364902335 播种的 actors 行，
 * display_name='system'；平台系统消息（失败回执等）以此为发送者，profile 查询按
 * senderId 命中 type='system'，展示为系统消息——与消息 type=SYSTEM 语义一致）。
 *
 * 全仓单源（review-0831 任务 e013af33 收敛）：roundtable.service / webhook.service
 * 及测试统一引用本常量，禁止散落裸 uuid 字面量。migration 播种值为冻结历史，不改。
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * 话题参与行通知设置的 **mentions_only** 键名（v1.96.0-dev 未读语义批 D4）。
 *
 * `topic_participants.notification_settings` 是 jsonb（DB default
 * `{"mute": false, "mentions_only": false}`），本常量是**全仓唯一**键名事实源——
 * 三处消费点必须同源，禁止散落字符串字面量：
 *  1. 读谓词（topic.service `buildUnreadMessageQb` / `getUnread` 的模式判定）；
 *  2. 裸 SQL 模板插值（agent.service `findMyUnreadCounts` 的 LEFT JOIN ON 子句）；
 *  3. 写侧合并（topic.service `updateNotificationSettings` 的
 *     `jsonb_build_object(<本键>, $v::boolean)`）。
 *
 * ⚠️ 判定语义 = PG `notification_settings @> '{"mentions_only": true}'::jsonb`
 * （DB 实测：脏值零抛错；**禁用** `::boolean` cast——非法值会 22P02 报错）。
 * JS 侧对应判定是严格 `=== true`（两边同口径，不允许 truthy 放宽）。
 */
export const NOTIFY_KEY_MENTIONS_ONLY = 'mentions_only';

/**
 * 话题参与行通知设置的 **mute** 键名（v1.96.0-dev）。
 *
 * ⚠️ **未接线（D8 明确不做）**：`mute` 已存在于 jsonb 默认值与 `PATCH
 * /topics/:id/notification-settings` 的读回中，但**没有任何读路径消费它**——
 * 静音不改变未读计数、不改变投递。写成常量而不是字面量，是为了让"键名已登记、
 * 语义未落地"这件事在代码里可检索；接线时从本常量出发，勿另起字面量。
 */
export const NOTIFY_KEY_MUTE = 'mute';
export const JWT_EXPIRES_IN = '15m';
export const REFRESH_TOKEN_EXPIRES_IN = '7d';
export const SSE_HEARTBEAT_INTERVAL_MS = 30000;

/**
 * headingPath 的层级分隔符（DocSpace markdown-chunker 契约）。
 *
 * headingPath 形如 "一级标题 § 二级标题 § 三级标题"，由 chunker 写入、全链路只读。
 * 这是 chunker join 使用的实际结构 token；消费方禁止按裸字符 `§` 拆分，
 * 必须使用 {@link extractLastHeadingSegment} 取得末段，避免标题正文中的 `§3.2`
 * 被误判为层级边界。
 */
export const HEADING_PATH_SEPARATOR = ' § ';

/**
 * 取得 headingPath 的末段标题文本。
 *
 * 契约：只按 {@link HEADING_PATH_SEPARATOR}（带两侧空格）识别层级边界，并去除
 * 末段两侧空白。已知边界：标题正文自身包含带两侧空格的 ` § ` 仍会被拆分——
 * 这是字符串反解析的理论极限。
 *
 * **⚠️ 债 A 落地后（doc_sections.heading_text 独立列）禁止用于取标题**：新代码
 * 一律直读 headingText 列（chunker 清洗直写，标题正文中的 ` § ` 完整保留）。
 * 本 helper 仅作**兼容兜底**（旧数据/旧服务端无 headingText 列时的降级渲染，
 * 如 platform-mcp read-doc 的双通道 renderer）。
 *
 * @param headingPath - chunker 生成的完整 headingPath
 * @returns 最末级标题文本；空路径或无有效末段时返回空字符串
 */
export function extractLastHeadingSegment(headingPath: string): string {
  return headingPath.split(HEADING_PATH_SEPARATOR).pop()?.trim() ?? '';
}

/**
 * 附件有效期档位值域（v1.90.0-dev 附件 TTL 批，**单一事实源**）。
 *
 * 语义（docs/api-definition.md §16a）：
 * - 写侧：`topic.settings.attachmentTtl`（`POST/PATCH /topics` 的 `config.attachmentTtl`）；
 * - 读侧：上传附件时按 topic 当时的设置把 `expires_at = now() + ttl` **冻结**写入附件行，
 *   事后改设置只影响新上传（不追溯）；`never` → `expires_at = NULL`（永久）；
 * - 缺省 / 脏值：**回退 `7d`**（fail-closed，绝不回退 `never`——否则治理目标被静默关掉）。
 *
 * 提升到 shared 的 rationale：后端 DTO 校验（`@IsIn`）与 web 表单下拉必须同源；
 * 后端 `attachment.constants.ts` 的 ms 映射表以本值域为键（`Record<AttachmentTtl, number|null>`，
 * 漏搬档位即编译期报错）。
 */
export const ATTACHMENT_TTL_VALUES = ['1d', '7d', '30d', 'never'] as const;

/** 附件有效期档位（'1d' | '7d' | '30d' | 'never'） */
export type AttachmentTtl = (typeof ATTACHMENT_TTL_VALUES)[number];

/**
 * API Key 权限范围值域（**单一事实源**，2026-10-16 卡 72566c2e）。
 *
 * 落库位置 = `api_keys.permissions` jsonb 的 `scopes` 数组（默认 `["read","write"]`）。
 * 语义（docs/api-definition.md §2.1）：
 * - `read`  — 只读通道：GET/HEAD，以及显式标注 `@AgentScope('read')` 的读语义端点；
 * - `write` — 其余全部方法（POST/PATCH/PUT/DELETE）。**write 不蕴含 read**（对齐
 *   `task 写不蕴含读` 的既有判定，见 F4 登记），持 write-only key 的 GET 会被拒。
 *
 * 提升到 shared 的 rationale：后端 DTO 校验（`@IsIn(API_KEY_SCOPE_VALUES, {each:true})`）、
 * 运行时收窄（`common/utils/api-key-scope.ts` 逐元素白名单）与 web 展示必须同源，
 * 新增档位只应改这一行。**禁止**在仓库其他位置硬编码 `['read','write']`。
 */
export const API_KEY_SCOPE_VALUES = ['read', 'write'] as const;

/** API Key 权限范围（'read' | 'write'） */
export type ApiKeyScope = (typeof API_KEY_SCOPE_VALUES)[number];
