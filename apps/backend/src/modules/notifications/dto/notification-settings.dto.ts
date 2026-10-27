/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - `notification-settings` 六端点（Notifications 二期，**JWT 人类端点**）的请求/参数契约：
 *     渠道 upsert（open_id + 启用态）、通知偏好稀疏覆盖、`:provider` 路径参数值域。
 *
 * [代码职责]
 *   - `UpdateChannelDto`：`recipientOpenId`（**可省** = 不改地址，纯状态更新）+ `enabled`
 *   - `UpdatePrefsDto`：`notificationCategories` 稀疏覆盖（自定义 validator：键 ∈ 10 类 + 严格布尔）
 *   - `ProviderTokenParamPipe`：`:provider` 路径参数按 `NOTIFY_PROVIDER_TOKENS` 校验（值域单源）
 *   - `normalizeNotificationCategories`：**读取归一**（白名单键 ∩ 严格 `=== true`，未知键/非布尔丢弃）
 *
 * [权威文档]
 *   - 主文档: plan `red-tornado-wonder-blue-devil.md` §D5（六端点全契约：PUT 分叉 / 读取归一）
 *
 * [关键不变量]
 *   - **`recipientOpenId` 可省是有意的**：静音（`enabled=false`）是**纯状态更新**，不该逼客户端
 *     回填地址（回填错一个字就把用户绑到别人的地址上）。地址变与不变的分叉在 service 里
 *     （变 ⇒ 清验证态；不变 ⇒ 保留验证态）。
 *   - **`@Matches(/^ou_[A-Za-z0-9_-]{1,200}$/)` 同时挡住控制字符**：白名单字符集比"拒绝控制字符"
 *     更强（正则里没有 `\s` / `\x00-\x1f`），故不需要额外的"拒控制字符"校验——两个规则并存只会
 *     让人以为它们各有分工。`@MaxLength(255)` 与列宽一致（第二层是 DB 列宽）。
 *   - **读取归一 = 白名单 ∩ 严格 `=== true`**（`normalizeNotificationCategories`）：未知键
 *   - **读取归一 = 缺省集为基座 ∩ 存量键严格布尔覆盖**（`normalizeNotificationCategories`）：
 *     用户从未写过的键落在 `DEFAULT_NOTIFY_CATEGORIES`（`task_done + direct`，plan §D2），
 *     显式 `true` / `false` 才覆盖；未知键（前端版本漂移 / 手工塞的垃圾）与非布尔值
 *     （`"true"` 字符串、`1`）**一律丢弃**（保持缺省）。若用 truthy 判断，`"false"` 会被当成开启
 *     ——用户看到"已关"却仍收通知。**读取端不报错**（归一而非 4xx）：它保护的是展示，不是写入契约。
 *   - **`defaults` 与用户偏好分离**：`DEFAULT_NOTIFY_CATEGORIES`（部署缺省 `task_done,direct`）
 *     是常量，GET 的 `defaults` 直接回它；用户覆盖层只存 `notificationCategories`。
 *
 * [关联代码]
 *   - notification-settings.controller.ts — 本 DTO 的两个消费端点 + 路径参数 pipe
 *   - notification-settings.service.ts — 归一函数的消费方（GET prefs / PUT 合并）
 *   - ../../config/notifications.config.ts — `NOTIFY_CATEGORIES` / `NOTIFY_PROVIDER_TOKENS` /
 *     `DEFAULT_NOTIFY_CATEGORIES`（三个值域的单源）
 * =============================================================================
 */
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { PipeTransform, BadRequestException, Injectable } from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';
import {
  DEFAULT_NOTIFY_CATEGORIES,
  NOTIFY_CATEGORIES,
  NOTIFY_PROVIDER_TOKENS,
  type NotifyCategory,
  type NotifyProviderToken,
} from '../../../config/notifications.config';

/** 单个通知类别的**归一读取值**（白名单 10 类，键恒在；未覆盖的键落**部署缺省集**而非全 false） */
export type NotificationCategoryPrefs = Record<NotifyCategory, boolean>;

/**
 * 归一派生一个"全键、默认 false"的偏好对象（缺省集 = `DEFAULT_NOTIFY_CATEGORIES`）。
 *
 * @param defaults 视为"开"的类别集合（缺省 = 部署缺省集）
 * @returns 白名单 10 类的完整布尔映射
 */
export function defaultNotificationCategoryPrefs(
  defaults: readonly NotifyCategory[] = DEFAULT_NOTIFY_CATEGORIES,
): NotificationCategoryPrefs {
  const out = {} as NotificationCategoryPrefs;
  for (const category of NOTIFY_CATEGORIES) out[category] = defaults.includes(category);
  return out;
}

/**
 * **读取归一**：把 `users.preferences.notificationCategories` 原始 jsonb 归一成完整布尔映射。
 *
 * 判据（B2 修正版，与 plan §D2「读取 merge 默认集（task_done + direct）」一致）：
 * - **基座 = 部署缺省集**（`defaultNotificationCategoryPrefs()`）——用户从未写过偏好的键
 *   落在缺省上，而不是全 false；
 * - 存量键按**严格布尔**显式覆盖：`=== true` 开、`=== false` 关（`'true'` 字符串 / `1` / 未知键
 *   一律**丢弃**，保持缺省）；
 * - 非对象入参（null / 数组 / 字符串）⇒ 纯缺省集。
 *
 * ⚠️ 基座若是全 false，`DELETE /me/prefs`（恢复默认）与 GET 会互相矛盾（前者回缺省集、后者回全关），
 * 且批 2 的路由按这份归一消费时会**全类别静默不推**。
 *
 * @param raw jsonb 里的原始值（任意，可能是 null / 数组 / 字符串）
 * @returns 白名单 10 类的完整布尔映射（键恒在）
 */
export function normalizeNotificationCategories(raw: unknown): NotificationCategoryPrefs {
  const out = defaultNotificationCategoryPrefs();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  for (const category of NOTIFY_CATEGORIES) {
    const value = record[category];
    // 显式布尔才覆盖缺省（严格 ===；字符串 'false' 这类"看起来像布尔"的值一律不算）
    if (value === true) out[category] = true;
    else if (value === false) out[category] = false;
  }
  return out;
}

/**
 * `notificationCategories` 稀疏覆盖的 validator（键 ∈ 白名单 10 类 + 值严格布尔）。
 *
 * 为什么自定义而不是 `@IsObject()`：`@IsObject()` 只挡"不是对象"，键名拼错（`task_donee`）与
 * 非布尔值（`"true"`）都会静默通过、然后被读取归一丢掉——用户以为改了却毫无效果（最难排的一类
 * 假象）。这里在**写入端**直接 400，把拼错当场暴露（铁律 #21 的格式层）。
 */
@ValidatorConstraint({ name: 'notificationCategoryPrefs', async: false })
export class NotificationCategoryPrefsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
      if (!(NOTIFY_CATEGORIES as readonly string[]).includes(key)) return false;
      if (typeof flag !== 'boolean') return false;
    }
    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    return (
      `${args.property} must be an object whose keys are notification categories ` +
      `(${NOTIFY_CATEGORIES.join(', ')}) and whose values are booleans`
    );
  }
}

/**
 * 通知偏好稀疏覆盖请求体（`PUT /notification-settings/me/prefs`；plan §D5）。
 *
 * 语义 = **只覆盖给出的键**（原子键级合并 `jsonb_set(..., coalesce(prefs->'nc','{}') || $1, true)`）
 * ——未给的键保留原值。这与 `users.preferences` 其余键的整体替换刻意不同（见 service 注释）。
 */
export class UpdatePrefsDto {
  /**
   * 类别开关的稀疏覆盖（键 ∈ 10 类；值严格布尔）。
   *
   * 稀疏：只写给出的键——`{ task_done: false }` 只关任务完工，不影响其余类别；未出现的键保留
   * 用户原值（合并语义见 service）。
   */
  @Validate(NotificationCategoryPrefsConstraint)
  notificationCategories!: Record<string, boolean>;
}

/**
 * 渠道 upsert 请求体（`PUT /notification-settings/me/channels/:provider`；plan §D5）。
 */
export class UpdateChannelDto {
  /**
   * 飞书 open_id（**可省** = 不改地址，纯状态更新；见文件头不变量）。
   *
   * 字符集白名单同时挡住控制字符与空白（比"额外拒控制字符"更强，且只有一条规则）。
   */
  @IsOptional()
  @IsString()
  @Matches(/^ou_[A-Za-z0-9_-]{1,200}$/, {
    message:
      'recipientOpenId must be a Feishu open_id (ou_ followed by 1-200 chars of [A-Za-z0-9_-])',
  })
  @MaxLength(255)
  recipientOpenId?: string;

  /**
   * 启用态（可省 = 不改；true 走服务端验证不变量，见 service）。
   *
   * ⚠️ 显式 `null` 会被 `@IsBoolean()` 拒绝（三态清晰：不传 = 不改 / true = 开 / false = 静音）。
   */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * `:provider` 路径参数校验管道（值域单源 = `NOTIFY_PROVIDER_TOKENS`）。
 *
 * 为什么用 pipe 而不是在 service 里判：值域是**格式层**（铁律 #21）——不该把未知 provider
 * 透传到 DB 查询再靠"查不到"表现成 404（那样 `:provider=email` 会伪装成"你还没绑邮箱"）。
 *
 * @throws BadRequestException 400（未知 provider token，列出合法值域）
 */
@Injectable()
export class ProviderTokenParamPipe implements PipeTransform<string, NotifyProviderToken> {
  transform(value: string): NotifyProviderToken {
    if (!(NOTIFY_PROVIDER_TOKENS as readonly string[]).includes(value)) {
      throw new BadRequestException({
        message:
          `Unknown notification provider "${value}". Known providers: ` +
          `${NOTIFY_PROVIDER_TOKENS.join(', ')}.`,
        code: ErrorCode.BAD_REQUEST,
      });
    }
    return value as NotifyProviderToken;
  }
}
