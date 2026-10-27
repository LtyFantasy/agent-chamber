import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * PATCH /topics/:id/notification-settings 请求体（v1.96.0-dev 未读语义批 D5）。
 *
 * **契约钉死：`mentionsOnly` 必填布尔**（不是可选、不是三态）。
 * - 不传 / 传 null / 传字符串 `"true"` → 400 VALIDATION_ERROR（pipe 层拦，格式错误
 *   止于边界层——这是双层校验的第一层，不许漏到 SQL）；
 * - 未知键（例如 `mute`）→ 400：全局 ValidationPipe 开了 `forbidNonWhitelisted`，
 *   多一个键即整体拒绝。**`mute` 尚未接线**（读路径零消费，见 shared
 *   `NOTIFY_KEY_MUTE` 注释）——把它写进契约等于承诺一个不存在的行为，故显式拒绝
 *   而不是静默忽略。
 *
 * 为什么必填而不是 `mentionsOnly?: boolean`：本端点只有这一个开关，缺省语义
 * （省略 = 不动）会让"我想关掉静默"和"我忘了传"无法区分；显式传值 + 幂等
 * （重复传同一值恒返回同结果）是更小的心智负担。
 */
export class UpdateNotificationSettingsDto {
  /**
   * 是否只把「提及我的消息」计入未读（静默模式）。
   *
   * true = 开启：`GET /topics/:id/messages/unread` 与 `GET /agents/me/unread` 的
   * 计数只统计 mentions 含我（或 `@all`）的消息；false = 关闭（默认，全部消息计数）。
   *
   * ⚠️ 开启瞬间，**存量未读（含历史 @）立即不再计数**——这不是丢失，是口径切换，
   * 响应里的 `hiddenUnreadCount` 会给出被隐藏的条数。
   */
  @IsBoolean()
  @ApiProperty({
    description:
      'Whether to count ONLY messages that mention me (or @all) as unread (silent mode). ' +
      'true = enable: unread counts from GET /topics/:id/messages/unread and GET /agents/me/unread ' +
      'only include messages whose mentions contain my actor id or the "*" broadcast token. ' +
      'false = disable (default; every message counts). ' +
      'Required boolean — omitted/null/string values are rejected with 400 VALIDATION_ERROR, ' +
      'and unknown keys (e.g. "mute", which is NOT wired yet) are rejected with 400 as well. ' +
      'Enabling does NOT lose data: pre-existing unread (including historical @ that was never ' +
      'extracted) simply stops counting, and the response reports how many were hidden.',
    example: true,
  })
  mentionsOnly: boolean;
}
