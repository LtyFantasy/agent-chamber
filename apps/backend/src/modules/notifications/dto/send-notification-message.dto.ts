/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 直发端点 `POST /api/v1/notifications/messages` 的**请求契约**：agent 请求平台把一条
 *     私聊消息推给它的人类 Owner 的外部 IM（一期 = 飞书自建应用私聊）。
 *
 * [代码职责]
 *   - `SendNotificationMessageDto`：`text`（1..2000 字符）/ 可选 `clientRequestId`（幂等键，
 *     1..64）/ 可选 `link`（**同源相对深链**）
 *   - `NOTIFY_DIRECT_LINK_PREFIXES` / `NOTIFY_DIRECT_LINK_PATTERN`：link 白名单**单源**
 *     ——DTO 校验用；orchestrator 的 `buildLink` 产出同一形状的路径（两处语义必须一致，
 *     改一处必须核对另一处）
 *   - `@ApiProperty` description **就是 automcp 生成的 MCP 工具字段说明**（agent 读到的
 *     "怎么用"由它决定）——改字段而不更新 description = agent 拿到错误的用法说明
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §7.1（直发端点契约：body DTO /
 *     link 同源白名单 / 处理顺序）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/api-definition.md`；
 *     落点后本定位符改为线上文档。
 *
 * [关键不变量]
 *   - **link 只接受同源相对路径**（`^/(tasks|topics|docs|boards|experiences)/`）：绝对
 *     URL / 协议相对 `//host` / 其它前缀一律 400（铁律 #21：格式错在 DTO 层拦下，不许透传到
 *     服务端）。理由：agent **不掌握 web 基址**，链接必须由服务端用 `NOTIFY_WEB_BASE_URL`
 *     拼——否则一条 `https://evil.example/...` 就能让 Owner 在手机上点进第三方站点
 *     （通知是出境面，不能变成开放重定向的载体）。
 *   - **空白串不是"未提供"**：`@IsOptional()` 只跳过 `undefined`/`null`，空串仍走校验
 *     ⇒ `link: ''` 被 `@Length(1, 512)` 拦下 400。这是刻意的：`''` 与"没有链接"是两件事，
 *     静默当成"未提供"会让调用方以为自己传的链接生效了。
 *   - **`text` 上限 2000 是出境面宽度契约**（与 config 的 `NOTIFY_EGRESS_FIELDS` 声明一致）：
 *     改上限必须同 commit 改那份声明（否则用户读到的"出境清单"就是假的）。
 *
 * [关联代码]
 *   - ../notifications.controller.ts — 本 DTO 的唯一消费方（`POST messages`）
 *   - ../notify-direct.service.ts — 直发链路（幂等 / 节流 / 渲染 / 投递）
 *   - ../../../config/notifications.config.ts — `NOTIFY_EGRESS_FIELDS`（出境字段单源）
 *
 * [铁律关联] #11(注释强制) #21(双层校验)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改字段必须同步 `@ApiProperty` description（它直接变成 MCP 工具说明）
 *   □ 改 link 白名单必须同时核对 orchestrator 的 `buildLink` 产出形状
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `link` 的白名单前缀（**同源相对路径**；单源在本常量）。
 *
 * 五段对应平台五个可深链的资源面：任务 / 话题 / 文档 / 看板 / 经验。刻意**不含**任意路径
 * 通配——白名单是"允许哪些"，不是"禁止哪些"（后者永远漏）。
 */
export const NOTIFY_DIRECT_LINK_PREFIXES = [
  '/tasks/',
  '/topics/',
  '/docs/',
  '/boards/',
  '/experiences/',
] as const;

/**
 * `link` 字段的完整校验正则（由 {@link NOTIFY_DIRECT_LINK_PREFIXES} 派生，避免两份清单漂移）。
 *
 * 四段结构（**每一段都在防一类注入**，改正则前先读这四条）：
 * ① `^` 锚定 + 白名单前缀：绝对 URL（`https://…`）与协议相对 URL（`//host/…`）**必然不匹配**
 *    ——前者以字母开头，后者第二字符是 `/` 而非白名单段的字面量（开放重定向的闸门）。
 * ② 尾部字符类 `[^\s\p{Cc}]`（`u` flag）：**空白与一切控制字符**一律不收——`\s` 管换行/制表/
 *    不换行空格，`\p{Cc}` 补上 `\s` 之外的 NUL / DEL 等（`\u0000` 这类字面量既不合法也不该
 *    出现在 URL 里；用 `\p{Cc}` 而不是 `\u0000-\u001f` 是为了不触发 `no-control-regex`）。
 * ③ 负向先行断言排除**百分号编码的控制字符**（`%00`–`%1F`、`%7F`）：`%0a` 这种字面量本身不是
 *    空白（②的字符类拦不住，它是普通 ASCII），但任何在渲染前做 URL 解码的消费方都会把它
 *    变成换行——**在门口拒绝，而不是指望每个消费方都记得转义**。
 * ④ 尾锚 `$`：没有它，前缀之后可以跟任意尾巴（只锚前缀 = 没锚）。
 */
export const NOTIFY_DIRECT_LINK_PATTERN = new RegExp(
  `^(${NOTIFY_DIRECT_LINK_PREFIXES.map((prefix) => prefix.replace(/[/]/g, '\\/')).join('|')})` +
    '((?:(?!%[01][0-9a-fA-F]|%7[fF])[^\\s\\p{Cc}])*)$',
  'u',
);

/** `text` 的长度上限（出境面契约；见文件头 [关键不变量]） */
export const NOTIFY_DIRECT_TEXT_MAX_LENGTH = 2000;

/** `link` 的长度上限（与平台文档路径的 512 上限同尺度） */
export const NOTIFY_DIRECT_LINK_MAX_LENGTH = 512;

/**
 * 直发请求体。
 *
 * 字段顺序 = Swagger/MCP 工具表单顺序（`text` 必填在前）。
 */
export class SendNotificationMessageDto {
  /** 要推给 Owner 的消息正文（agent 自填；≤2000 字符） */
  @IsString()
  @Length(1, NOTIFY_DIRECT_TEXT_MAX_LENGTH)
  @ApiProperty({
    description:
      `Message body, 1–${NOTIFY_DIRECT_TEXT_MAX_LENGTH} characters, written by the calling ` +
      'agent. Delivered as a private IM message to the platform Owner (the human who owns you). ' +
      'Use this ONLY when the Owner must personally notice something — it is not a progress log ' +
      'for routine work (use tasks/topic messages for that). You do not choose the recipient.',
    example:
      'Task "deploy the notifications module" is blocked on your decision: keep the 5/10min window or widen it?',
  })
  text: string;

  /**
   * 幂等键（可选）。
   *
   * ⚠️ 两种重试语义在这里分叉（见 controller 的 `@ApiOperation`）：传输层不确定 ⇒ 同 key
   * 重放（返回首次信封、不重复打扰人）；已确认 `delivery_failed` ⇒ **换新 key** 才会真重跑。
   */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Replaying with the SAME key returns the FIRST ' +
      'envelope without sending again — use it when the transport outcome is unknown (timeout, ' +
      'no reply). If a prior call returned delivered=0/reason=delivery_failed the result is ' +
      'already confirmed, so retrying with the same key just replays that failure; use a NEW key ' +
      'to actually send again. Same key with a different text/link → 409/9002.',
    example: 'nc-20261013-blocker-q1',
  })
  clientRequestId?: string;

  /**
   * 可选深链（**同源相对路径**；服务端拼 `NOTIFY_WEB_BASE_URL`）。
   *
   * 白名单见 `NOTIFY_DIRECT_LINK_PREFIXES`——绝对 URL 一律 400，理由见文件头不变量。
   */
  @IsOptional()
  @IsString()
  @Length(1, NOTIFY_DIRECT_LINK_MAX_LENGTH)
  @Matches(NOTIFY_DIRECT_LINK_PATTERN, {
    message:
      `link must be a platform-relative path starting with one of: ` +
      `${NOTIFY_DIRECT_LINK_PREFIXES.join(', ')} (absolute URLs are rejected — the platform ` +
      'prepends NOTIFY_WEB_BASE_URL for you)',
  })
  @ApiPropertyOptional({
    description:
      'Optional deep link to put into the message, as a PLATFORM-RELATIVE path — allowed ' +
      `prefixes: ${NOTIFY_DIRECT_LINK_PREFIXES.join(', ')} (e.g. /tasks/<uuid>). Absolute URLs ` +
      'are rejected with 400: the server prepends NOTIFY_WEB_BASE_URL so the Owner taps straight ' +
      'back into the platform (you do not know the web base URL of this deployment).',
    example: '/tasks/8f14e45f-ceea-467a-9e2f-1b2c3d4e5f60',
  })
  link?: string;
}
