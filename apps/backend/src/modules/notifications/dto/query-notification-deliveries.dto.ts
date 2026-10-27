/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - admin 只读列表 `GET /api/v1/notifications/deliveries` 的**查询契约**：分页 + 类别 /
 *     终态过滤。消费方是运维/管理员（**不进 MCP agent 工具面**）。
 *
 * [代码职责]
 *   - `QueryNotificationDeliveriesDto`：`page` / `pageSize`（`@Min(1)` / `@Max(100)`）+
 *     `category` / `status`（`@IsIn` 值域单源）
 *   - `NOTIFICATION_DELIVERY_CATEGORY_VALUES`：**过滤值域**（= 可开关类别 ∪ L2 摘要 ∪ test
 *     验证投递 ∪ 系统告警），由 `NOTIFY_CATEGORIES` 与实体文件三个专用类别常量派生
 *     ——**四个来源缺一不可**
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §7.2（admin 列表：守卫组合 /
 *     分页信封形状 / 过滤值域 / createdAt DESC）；`system_alert` 见 plan
 *     `miles-morales-she-hulk-shazam.md` §D6（运维类别，用户不可静音）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/api-definition.md`；
 *     落点后本定位符改为线上文档。
 *
 * [关键不变量]
 *   - **`category` 过滤值域必须含 `digest`**：L2 超额摘要落库时 `category='digest'`
 *     （见实体文件头的"两个来源"）。若这里只用 `NOTIFY_CATEGORIES`，运维将**永远查不到
 *     摘要行**——而摘要恰恰是"为什么我只收到一条汇总"的唯一数据面线索。
 *   - **`page` / `pageSize` 走 `@Type(() => Number)`**：query 是字符串，不转换会让
 *     `@IsInt()` 把每个正常请求判 400（webhook 的 `QueryWebhookDto` 同款）。
 *   - **`status` 值域 = `NOTIFICATION_DELIVERY_STATUSES`**（两态、无 `pending`）：本表只落
 *     终态，过滤一个不存在的状态只会让用户以为"失败都被清理了"。
 *
 * [关联代码]
 *   - ../notifications.controller.ts — 本 DTO 的唯一消费方（`GET deliveries`）
 *   - ../notify-delivery.repository.ts — 过滤与分页的落地点（唯一读入口）
 *   - ../../../database/entities/notification-delivery.entity.ts — 两个值域的单源
 * =============================================================================
 */
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  DIGEST_DELIVERY_CATEGORY,
  DIRECT_TEST_DELIVERY_CATEGORY,
  NOTIFICATION_DELIVERY_STATUSES,
  SYSTEM_ALERT_DELIVERY_CATEGORY,
  type NotificationDeliveryCategory,
  type NotificationDeliveryStatus,
} from '../../../database/entities/notification-delivery.entity';
import { NOTIFY_CATEGORIES } from '../../../config/notifications.config';
import { NOTIFY_DEFAULT_PAGE_SIZE, NOTIFY_MAX_PAGE_SIZE } from '../notifications.constants';

/**
 * `category` 过滤的完整值域（**四个来源的并集**，见文件头不变量）。
 *
 * 派生而非手写：可开关类别（用户能开关的九类 + `direct`）∪ L2 摘要的 `digest`
 * ∪ test 端点的验证投递 `direct_test` ∪ 系统告警 `system_alert`。
 *
 * ⚠️ `system_alert` 进**过滤值域**不等于它"可开关"：它是运维类别（用户不可静音），
 * 这里收录只是为了让运维能查"告警到底投递出去过没有"。**绝不把它加进 `NOTIFY_CATEGORIES`**
 * （那会让用户关掉系统告警，见实体文件头的该常量 rationale）。
 */
export const NOTIFICATION_DELIVERY_CATEGORY_VALUES: readonly NotificationDeliveryCategory[] = [
  ...NOTIFY_CATEGORIES,
  DIGEST_DELIVERY_CATEGORY,
  DIRECT_TEST_DELIVERY_CATEGORY,
  SYSTEM_ALERT_DELIVERY_CATEGORY,
];

/**
 * 投递记录列表查询参数。
 *
 * 缺省 = 第 1 页 / 每页 `DEFAULT_PAGE_SIZE` 条 / 不过滤（全类别全终态），按 `createdAt DESC`。
 */
export class QueryNotificationDeliveriesDto {
  /** 页码（从 1 起；缺省 1） */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Page number, default 1', example: 1 })
  page?: number;

  /** 每页条数（1..100；缺省 20） */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(NOTIFY_MAX_PAGE_SIZE)
  @Type(() => Number)
  @ApiPropertyOptional({
    description: `Items per page, max ${NOTIFY_MAX_PAGE_SIZE}, default ${NOTIFY_DEFAULT_PAGE_SIZE}`,
    example: 20,
  })
  pageSize?: number;

  /** 类别过滤（值域含 `digest` / `direct_test` / `system_alert`；缺省不过滤） */
  @IsOptional()
  @IsIn(NOTIFICATION_DELIVERY_CATEGORY_VALUES)
  @ApiPropertyOptional({
    enum: NOTIFICATION_DELIVERY_CATEGORY_VALUES,
    description:
      'Filter by notification category. Value domain = the switchable categories ' +
      `(${NOTIFY_CATEGORIES.join(', ')}) PLUS "${DIGEST_DELIVERY_CATEGORY}" (the rate-window ` +
      `suppression digest), "${DIRECT_TEST_DELIVERY_CATEGORY}" (channel test deliveries) and ` +
      `"${SYSTEM_ALERT_DELIVERY_CATEGORY}" (system alerts) — none of the four extras is user-` +
      'switchable. Omit for all categories.',
    example: 'task_done',
  })
  category?: NotificationDeliveryCategory;

  /** 终态过滤（`success` | `failed`；缺省不过滤） */
  @IsOptional()
  @IsIn(NOTIFICATION_DELIVERY_STATUSES)
  @ApiPropertyOptional({
    enum: NOTIFICATION_DELIVERY_STATUSES,
    description:
      'Filter by terminal status. Only terminal states exist (no pending) — a delivery row is ' +
      'written after the provider returned. Omit for both.',
    example: 'failed',
  })
  status?: NotificationDeliveryStatus;

  /**
   * 按平台用户过滤（Notifications 二期新增；取值 = actor/user UUID）。
   *
   * 语义：只看"发给某个人的投递"。⚠️ 存量行与尚未归属的行 `recipient_user_id` 为 NULL
   * （批 1 仅 test 端点路径落值，编排器三路径在批 2）——所以本过滤**只命中已归属的行**，
   * 传了它看到的是子集而非全集。**铁律 #21 第二层**：服务层（repository）也做一次显式构造，
   * 不依赖 DTO 校验必过（另一个调用方——运维脚本——可能不经过 DTO）。
   */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description:
      'Only deliveries attributed to this platform user (UUID). NOTE: pre-upgrade rows and paths ' +
      'not yet attributing a user have recipient_user_id = NULL and will NOT match.',
    example: '0b7e5b1c-3a2f-4d5e-8f90-1a2b3c4d5e6f',
  })
  recipientUserId?: string;
}
