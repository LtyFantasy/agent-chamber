/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **通知设置面**（Notifications 二期，`/api/v1/notification-settings/*`，**JWT 人类端点**）的
 *     服务侧：把"每个用户自己的通知渠道绑定 + 类别偏好"暴露成一套读写 API，并承载**验证不变量**
 *     （`enabled=true` 必须已有对该地址的成功测试 / 播种）与**解绑 tombstone** 语义。
 *
 * [代码职责]
 *   - `getMe`：渠道视图（**过滤 tombstone**）+ 归一偏好 + 平台能力（provider 是否 configured /
 *     部署启用的类别 / 深链基址）+ `relevantScopes`（**请求期直调** `getMy*` 三方法）
 *   - `upsertChannel`：PUT upsert（**按地址是否变化分叉**：变 ⇒ 清验证态 + 清 tombstone +
 *     `source='user'`；不变 ⇒ 保留验证态）；地址重复占用 ⇒ **409**（23505 人话）
 *   - `deleteChannel`：解绑 = tombstone（`enabled=false` + `unbound_at=now`）；**从未绑定或已解绑
 *     一律 404**（tombstone 对用户不可见，语义一致）
 *   - `testChannel`：测试消息（走 `orchestrator.sendThroughProvider` + 预算 ≤2/≤10s + per-user
 *     3/60s + **过平台总闸** + 跳过 L1/L2/幂等 + 落台账 `category='direct_test'`）
 *   - `updatePrefs` / `deletePrefs`：偏好**原子键级**合并 / 键级删除
 *
 * [权威文档]
 *   - 主文档: 线上 `docs/api-definition.md` §20.3（六端点全契约）/ `docs/spec.md` §3.2.33（表语义）/
 *     部署 `.env.example`（配置校验矩阵）/ skill `notifications/feishu-setup.md` §4（播种）
 *
 * [关键不变量]
 *   - **验证不变量 = 条件更新，不写在内存里**：`enabled=true` 的落库条件是
 *     `WHERE last_test_address = recipient_address AND last_test_status IN ('ok','seeded')`——
 *     一条 UPDATE 里完成"检查 + 写入"，不满足则 `affected=0` ⇒ 400。写成"先读到内存再判断再 save"
 *     会在并发下漏（两个请求都读到旧值）。这是 plan §D5 的"服务端不变量"。
 *   - **地址变与不变的分叉是唯一防线**：改地址 ⇒ 清 `last_test_*`（否则旧地址的验证态会给新地址
 *     背书——"验证门绕过"）。同一地址重绑 ⇒ **保留**验证态（用户换手机号又换回来不该重新验证）。
 *   - **tombstone 对用户不可见**：GET 过滤 `unbound_at IS NULL`，DELETE 也只认"活的"行（已解绑再解绑
 *     = 404）。tombstone 行的唯一作用 = 让**播种判据**（"该 user 无任意 feishu 行"）恒假（解绑不复活）。
 *   - **写态纪律**（plan §D5）：test 只有 `delivery_failed`（**真的调过 provider 且失败**）才写
 *     `last_test_status='failed'`；`notify_disabled` / `no_provider` **短路返回、不写验证态**
 *     ——"此刻的运维状态 ≠ 这个地址的判决"（`notifications.constants.ts` 判例）。
 *   - **test 不检查任何内容类别开关**：测试端点的类别是 `direct_test`（不可开关），若再 gate 在
 *     `direct` 上，"只想验证我的地址"会被一个与地址无关的运维开关挡死（且验证恰恰应在类别故障时
 *     仍可用）。它只受 `NOTIFY_ENABLED` / provider 存在 / 限流约束。
 *   - **偏好读取归一 = 白名单 ∩ 严格 `=== true`**（见 dto 的 `normalizeNotificationCategories`）。
 *   - **偏好写入是原子 `jsonb_set` 合并，与 `users.preferences` 其余键的整体替换刻意不同**：
 *     通知偏好按**键**稀疏覆盖（`{task_done:false}` 只关这一类），而 `updateMe`/`updateSettings`
 *     的其余键是整体替换。两者形状不同是有意的（见各方法注释）。
 *   - **`relevantScopes` 是"触发面"不是"会不会收到"**：定义为"作用域类通知的来源集合"，
 *     **请求期直算**（`getMyTopicIds` / `getMyBoardIds` / `getMyDocSpaceIds`，走请求级 ALS 缓存），
 *     **不缓存成用户属性**（权限/成员变化必须即时反映）。
 *   - **本服务是 orchestrator 的下游**（注入它做 test 投递与总闸），反向依赖禁止（见 module 文件头）。
 *
 * [关联代码]
 *   - notification-settings.controller.ts — 本服务的唯一 HTTP 调用方（六端点）
 *   - dto/notification-settings.dto.ts — 请求契约与读取归一
 *   - notify-orchestrator.service.ts — `sendThroughProvider`（端口兜底）/ `consumePlatformGate`
 *     （部署级出境总闸）/ 配置解析
 *   - notify-delivery.repository.ts — 台账唯一写入口（`record()` 永不抛）
 *   - ../../common/services/access-query.service.ts — `relevantScopes` 的三个 `getMy*` 方法与
 *     `getMyDocSpaceIds`
 *   - ../../database/entities/user-notification-channel.entity.ts — 表契约 + deliveryEligible 谓词
 *
 * [持久踩坑]
 *   NOTIFY-CHANNEL-ENABLE-WITHOUT-VERIFY(未验证就置启用): 内存判断 + save 会在并发下漏；且"改了
 *     地址但保留旧验证态"会让验证门形同虚设。安全方向: 单条条件 UPDATE（WHERE 绑地址 + 验证态），
 *     地址一变就清验证态。
 *   NOTIFY-CHANNEL-TEST-WRITES-STATE-ON-OPS-ERROR(运维状态污染验证态): 把 `no_provider` /
 *     `notify_disabled` 也写进 `last_test_status='failed'` ⇒ 运维修好 provider 后用户看到
 *     "地址验证失败"（错误归因，还会引导用户去改一个没问题的地址）。安全方向: 短路返回、不写态。
 *
 * [铁律关联] #11(注释强制) #21(双层校验) #22(findOne 判空) #18(不变量检查)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改验证不变量必须同步 schema e2e（部分唯一谓词）与 plan §D5
 *   □ 新增 reason 值必须同步 `NOTIFY_DIRECT_REASONS`（复用同一封闭值域）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';
import { AccessQueryService } from '../../common/services/access-query.service';
import {
  DEFAULT_NOTIFY_CATEGORIES,
  NOTIFY_PROVIDER_TOKENS,
  type NotifyCategory,
  type NotifyProviderToken,
  type NotificationsConfig,
} from '../../config/notifications.config';
import { User } from '../../database/entities/user.entity';
import {
  DELIVERY_ELIGIBLE_LAST_TEST_STATUSES,
  UserNotificationChannel,
  type UserNotificationChannelTestStatus,
} from '../../database/entities/user-notification-channel.entity';
import { DIRECT_TEST_DELIVERY_CATEGORY } from '../../database/entities/notification-delivery.entity';
import { resolveNotificationsConfig } from './notifications-provider.factory';
import {
  NOTIFY_PROVIDER_LIST,
  type NotifyProvider,
  type RenderedNotification,
} from './notify-provider.interface';
import { NotifyOrchestrator } from './notify-orchestrator.service';
import { NotifyDeliveryRepository } from './notify-delivery.repository';
import { NotifyRateLimitedException, type NotifyDirectEnvelope } from './notify-direct.service';
import {
  defaultNotificationCategoryPrefs,
  normalizeNotificationCategories,
  type NotificationCategoryPrefs,
  type UpdateChannelDto,
  type UpdatePrefsDto,
} from './dto/notification-settings.dto';
import {
  NOTIFY_CHANNEL_TEST_RATE_LIMIT_PER_WINDOW,
  NOTIFY_CHANNEL_TEST_RATE_WINDOW_SECONDS,
  NOTIFY_CHANNEL_TEST_TITLE,
  NOTIFY_DIRECT_BUDGET_MS,
  NOTIFY_DIRECT_MAX_ATTEMPTS,
} from './notifications.constants';

/**
 * 渠道视图（GET 的 `channels[]` 元素；**过滤掉 tombstone 行**——见文件头不变量）。
 *
 * 不直接回实体：实体带 `user` 关系与内部列（`unbound_at` / `last_test_address` 是服务端判定锚点，
 * 客户端不需要也不该拿它做逻辑）。视图是**稳定契约**（前端与 automcp 都按它写）。
 */
export interface NotificationChannelView {
  /** 渠道 provider（`feishu`） */
  provider: string;
  /** 收件地址（飞书 = open_id） */
  recipientAddress: string;
  /** 是否启用（false = 静音或未验证） */
  enabled: boolean;
  /** 验证态（`ok|failed|seeded`；null = 从未测试）——驱动前端四态徽标 */
  lastTestStatus: UserNotificationChannelTestStatus | null;
  /** 最近测试时刻（null = 从未测试） */
  lastTestAt: Date | null;
  /** 绑定来源（`env_seed` = 部署导入，前端提示"建议发送测试消息确认"） */
  source: string;
  /** 行创建时刻 */
  createdAt: Date;
}

/** 通知设置面的完整响应（`GET /notification-settings/me`） */
export interface NotificationSettingsView {
  /** 该用户的非 tombstone 渠道列表 */
  channels: NotificationChannelView[];
  /** 归一后的偏好（类别布尔映射 + 部署缺省集 + 作用域触发面） */
  prefs: {
    /** 白名单 10 类的完整布尔映射（读取已归一） */
    categories: NotificationCategoryPrefs;
    /** 部署缺省开启的类别（常量 `DEFAULT_NOTIFY_CATEGORIES`；用户覆盖层的参照） */
    defaults: NotifyCategory[];
    /** 作用域类通知的**触发面**（不是"会不会收到"） */
    relevantScopes: { topics: number; boards: number; spaces: number };
  };
  /** 平台能力（只回布尔 / 部署常量，不回任何密钥） */
  platform: {
    /** 已知 provider 及"本部署能否用它投递"（`configured=false` ⇒ 前端禁用表单并提示联系管理员） */
    providers: Array<{ key: string; configured: boolean }>;
    /** 部署启用的类别集（前端据此把未启用行置灰 + 「平台未启用」徽标） */
    categories: NotifyCategory[];
    /** 深链基址（未配 null） */
    webBaseUrl: string | null;
  };
}

/** PG 唯一约束冲突的 SQLSTATE（23505）；用于把"地址已被占用"映射成 409 而不是 500 */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * 部分唯一索引名（**地址归属证明**）：只有 `last_test_status='ok'` 且未解绑的行才占槽。
 *
 * M4：23505 的文案必须**按约束名分流**——撞它 = 该地址已被其他账户验证占用；
 * 撞 `uq_user_notification_channels_user_provider` 只是"你自己已有一行"。
 */
const VERIFIED_ADDRESS_UNIQUE_INDEX = 'uq_user_notification_channels_verified_address';

/** 地址重复占用的 409 文案（**人话 + 下一步**，见文件头） */
const ADDRESS_TAKEN_MESSAGE =
  'This Feishu account is already bound to another platform account. If this is you, use the ' +
  'original account — or ask an administrator to unbind it. (If it is not you, contact an ' +
  'administrator: an open_id cannot be enumerated, so no other detail can be shown here.)';

/**
 * 同用户同 provider 已存在绑定时的 409 文案（M4：撞 `uq_..._user_provider`）。
 *
 * 与"地址被占用"刻意不同：这里不存在"别人的飞书号"这回事，只是并发双提交/重复绑定。
 */
const CHANNEL_EXISTS_MESSAGE =
  'This channel already has a binding for your account — refresh and try again.';

/** 未完成验证就置启用时的 400 文案（**人话 + 下一步**） */
const NOT_VERIFIED_MESSAGE =
  'This address has not been verified for this channel yet: send a test message first (or use ' +
  'the address that was verified), then enable it. Enabling is refused because an unverified ' +
  'address would silently never receive anything.';

/**
 * 测试窗口 Map 的清扫阈值（m8）：超过它才做一次窗口外键回收。
 *
 * rationale：这个 map 只含"点过发送测试消息"的用户（天然稀疏），清扫是 O(size) 的纯内存操作；
 * 设阈值是为了让稳态（少量用户）零额外开销，同时把"只试过一次就再也不来"的用户键**真正删掉**
 * （否则键数只增不减）。
 */
const TEST_HITS_SWEEP_THRESHOLD = 64;

/**
 * 通知设置服务（default-scope 单例：per-user 测试窗口必须整个进程内共享）。
 *
 * ⚠️ 内存态前提：test 的 per-user 入口闸在进程内（每实例独立、重启清零、多副本额度 ×N）——
 * **这是限流不是配额**（同 direct 入口闸的声明）。
 */
@Injectable()
export class NotificationSettingsService {
  private readonly logger = new Logger(NotificationSettingsService.name);

  /** 生效配置（构造期解析一次；与编排器同一份解析函数，形状不会漂移） */
  private readonly settings: NotificationsConfig;

  /** test 端点 per-user 入口窗口（滑动时间戳；惰性剔除过期项） */
  private readonly testHits = new Map<string, number[]>();

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserNotificationChannel)
    private readonly channelRepo: Repository<UserNotificationChannel>,
    private readonly config: ConfigService,
    @Inject(NOTIFY_PROVIDER_LIST)
    private readonly providers: NotifyProvider[],
    private readonly orchestrator: NotifyOrchestrator,
    private readonly deliveryRepo: NotifyDeliveryRepository,
    private readonly accessQuery: AccessQueryService,
  ) {
    this.settings = resolveNotificationsConfig(config);
  }

  // ─────────────────────────────── GET /me ───────────────────────────────

  /**
   * 读取当前用户的通知设置全景（`GET /notification-settings/me`）。
   *
   * `relevantScopes` **请求期直算**（三方法走请求级 ALS 缓存，冷路径三次 count）——它是
   * "作用域类通知的触发面"，**不是**缓存成用户属性的静态字段（成员/权限变化必须即时反映）。
   *
   * @param userId 当前登录用户 id（`@CurrentUser('userId')`）
   * @returns 设置视图（渠道 / 偏好 / 平台能力）
   */
  async getMe(userId: string): Promise<NotificationSettingsView> {
    const user = await this.requireUser(userId);

    // 渠道：**过滤 tombstone**（用户视野里"未绑定"就是没有这一行；tombstone 只服务播种判据）
    const rows = await this.channelRepo.find({
      where: { userId, unboundAt: IsNull() },
      order: { createdAt: 'ASC' },
    });

    const preferences = (user.preferences ?? {}) as Record<string, unknown>;
    const categories = normalizeNotificationCategories(preferences['notificationCategories']);

    // 请求期直算触发面：actor 由 user 行合成（role 从 users 表实读，无需调用方自报）
    const actor: UnifiedActor = { id: userId, type: ActorType.HUMAN, role: user.role };
    const [topics, boards, spaces] = await Promise.all([
      this.accessQuery.getMyTopicIds(actor),
      this.accessQuery.getMyBoardIds(actor),
      this.accessQuery.getMyDocSpaceIds(actor),
    ]);

    return {
      channels: rows.map((row) => this.toChannelView(row)),
      prefs: {
        categories,
        defaults: [...DEFAULT_NOTIFY_CATEGORIES],
        relevantScopes: { topics: topics.length, boards: boards.length, spaces: spaces.length },
      },
      platform: {
        providers: NOTIFY_PROVIDER_TOKENS.map((key) => ({
          key,
          configured: this.isProviderConfigured(key),
        })),
        categories: [...this.settings.categories],
        webBaseUrl: this.settings.webBaseUrl,
      },
    };
  }

  // ──────────────────────── PUT /me/channels/:provider ────────────────────────

  /**
   * upsert 一个渠道绑定（`PUT /notification-settings/me/channels/:provider`）。
   *
   * 分叉（plan §D5）：
   * - **地址变化**（或首次绑定）⇒ `enabled=false` + 清 `last_test_*` + 清 tombstone + `source='user'`
   *   （旧验证态不得给新地址背书）；
   * - **地址不变** ⇒ 保留验证态（含从 tombstone 复活同一行）；
   * - `dto.enabled === true` ⇒ 走**条件更新**（见文件头不变量），不满足 400；
   * - `dto.enabled === false` ⇒ 静音（保留验证态，回程可再开）。
   *
   * @param userId 当前登录用户 id
   * @param provider 已通过 `ProviderTokenParamPipe` 校验的 provider token
   * @param dto 请求体（`recipientOpenId` 可省 = 不改地址）
   * @returns 更新后的渠道视图
   * @throws BadRequestException 400（首次绑定缺地址 / 未验证却置启用）
   * @throws ConflictException 409（地址已被其他账户验证占用）
   */
  async upsertChannel(
    userId: string,
    provider: NotifyProviderToken,
    dto: UpdateChannelDto,
  ): Promise<NotificationChannelView> {
    await this.requireUser(userId);

    const existing = await this.channelRepo.findOne({ where: { userId, provider } });
    const address = dto.recipientOpenId ?? existing?.recipientAddress ?? null;
    if (!address) {
      throw new BadRequestException({
        message: 'recipientOpenId is required to bind a channel for the first time',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    const addressChanged = !existing || existing.recipientAddress !== address;

    if (!existing) {
      // 首绑 = INSERT（唯一约束兜住并发双插；23505 走约束名分流，见 saveChannel）
      await this.saveChannel(
        this.channelRepo.create({
          userId,
          provider,
          recipientAddress: address,
          enabled: false,
          lastTestStatus: null,
          lastTestAddress: null,
          lastTestAt: null,
          source: 'user',
          unboundAt: null,
        }),
      );
    } else if (addressChanged) {
      // **换地址 = 条件 UPDATE**（M3：替代"读到内存再 save()"——那种写法会把并发请求对同一行
      // 的其它列改动整体覆盖）。乐观守卫 = **旧地址**（`recipient_address = :oldAddress`）：
      // 期间别人改过地址 ⇒ affected=0 ⇒ 本次写态丢弃（按现状返回，不抛）。
      const affected = await this.updateChannelRowOrConflict(
        {
          userId,
          provider,
          recipientAddress: existing.recipientAddress,
        },
        {
          recipientAddress: address,
          // 地址一变，旧地址的验证态失效（唯一防线，见文件头不变量）
          enabled: false,
          lastTestStatus: null,
          lastTestAddress: null,
          lastTestAt: null,
          source: 'user',
          unboundAt: null,
        },
      );
      this.noteDiscardedWrite(affected, userId, provider, 'address change was overtaken');
    } else {
      // **地址不变 = 只做"复活"**（清 tombstone）。乐观守卫 = 地址未变：期间别人改了地址
      // ⇒ affected=0 ⇒ 丢弃（否则会把一个已经指向新地址的行 unbound_at 清掉）。
      // ⚠️ 这里刻意**不**加 `unbound_at IS NULL` 谓词：那会让 D5/D6 的
      //    「tombstone 行重绑同一地址 = 复活同一行、保留验证态」永久失效（见下方汇报的偏离说明）。
      // ⚠️ 这条 UPDATE 也是 PUT 侧唯一可能撞**地址部分唯一**的地方：复活一行保留着
      //    `last_test_status='ok'` 的 tombstone 行时，若该地址期间已被别的账户验证占用，
      //    部分唯一索引会拒绝 ⇒ 必须走约束名分流的 409（不是 500）。
      const affected = await this.updateChannelRowOrConflict(
        { userId, provider, recipientAddress: address },
        { unboundAt: null },
      );
      this.noteDiscardedWrite(affected, userId, provider, 'same-address revive was overtaken');
    }

    if (dto.enabled === true) {
      await this.enableChannelOrThrow(userId, provider, address);
    } else if (dto.enabled === false) {
      // 静音：保留验证态（回程即刻可用），只落 enabled=false；**不碰 tombstone 行**
      await this.channelRepo
        .createQueryBuilder()
        .update(UserNotificationChannel)
        .set({ enabled: false })
        .where('user_id = :userId', { userId })
        .andWhere('provider = :provider', { provider })
        .andWhere('unbound_at IS NULL')
        .execute();
    }

    const fresh = await this.channelRepo.findOne({ where: { userId, provider } });
    // 刚 upsert 过，且 save/update 都成功；查不到只能是并发解绑（tombstone）——按 404 语义处理
    if (!fresh || fresh.unboundAt !== null) {
      throw new NotFoundException({
        message: 'No bound channel for this provider',
        code: ErrorCode.NOT_FOUND,
      });
    }
    // **写时失效**（Notifications 二期批 2）：绑定行是 per-user 快照的输入之一，改完必须让
    // 路由立刻看到新事实（否则 ≤TTL 的窗口里"刚绑好的人"仍收不到、"刚静音的人"仍在收）
    this.orchestrator.invalidateUser(userId);
    return this.toChannelView(fresh);
  }

  // ────────────────────── DELETE /me/channels/:provider ──────────────────────

  /**
   * 解绑一个渠道（`DELETE /notification-settings/me/channels/:provider`）。
   *
   * **解绑 = tombstone**（`enabled=false` + `unbound_at=now`，不真删）：真删会让播种判据在下一次
   * 进程重启时重新成立 ⇒ 复活已解绑的绑定。**从未绑定或已解绑 ⇒ 404**（tombstone 对用户不可见，
   * "已解绑"与"没绑过"对用户是同一件事）。
   *
   * @param userId 当前登录用户 id
   * @param provider provider token
   * @throws NotFoundException 404（无活绑定）
   */
  async deleteChannel(userId: string, provider: NotifyProviderToken): Promise<void> {
    await this.requireUser(userId);
    // **条件 UPDATE**（M3）：`WHERE ... AND unbound_at IS NULL` 让"并发重复解绑"只有一个赢家。
    // affected=0 ⇒ 期间已被解绑（或从未绑定）⇒ 与"无活绑定"同语义 **404**（tombstone 对用户
    // 不可见，"已解绑"与"没绑过"是同一件事；选 404 而非幂等 200 的理由见文件头）。
    const affected = await this.updateChannelRow(
      { userId, provider, onlyUnbound: true },
      { enabled: false, unboundAt: new Date() },
    );
    if (affected === 0) {
      throw new NotFoundException({
        message: 'No bound channel for this provider (nothing to unbind)',
        code: ErrorCode.NOT_FOUND,
      });
    }
    // 写时失效：解绑 = 该地址立刻停止投递（快照里的 channels 少了这一条）
    this.orchestrator.invalidateUser(userId);
    this.logger.log(`channel unbound (tombstoned) userId=${userId} provider=${provider}`);
  }

  // ──────────────────── POST /me/channels/:provider/test ────────────────────

  /**
   * 发送一条测试消息（`POST /notification-settings/me/channels/:provider/test`）。
   *
   * 顺序（与注释编号一致）：**活绑定存在（否则 404，无信封）→ 总开关 → provider 存在 →
   * per-user 入口闸（429）→ 平台总闸（429）→ 同步投递（预算 ≤2/≤10s）→ 落台账
   * `direct_test` → 写验证态（仅成功/真的失败）**。
   *
   * 跳过 L1 / L2 / 幂等（它是用户主动的一次验证，不是事件流的一部分）；但**过平台总闸**
   * （测试消息同样出境）。
   *
   * @param userId 当前登录用户 id
   * @param provider provider token
   * @returns 统一信封（`{delivered, channels, reason?}`，与直发同形）
   * @throws NotFoundException 404（无活绑定）
   * @throws NotifyRateLimitedException 429（per-user 入口闸或平台总闸）
   * @throws ConflictException 409（成功但地址已被其他账户占用）
   */
  async testChannel(userId: string, provider: NotifyProviderToken): Promise<NotifyDirectEnvelope> {
    await this.requireUser(userId);

    // ① 活绑定（tombstone / 未绑定 ⇒ 404 且**无信封**——"没绑过"不是一次降级投递）
    const row = await this.channelRepo.findOne({
      where: { userId, provider, unboundAt: IsNull() },
    });
    if (!row) {
      throw new NotFoundException({
        message: 'No bound channel for this provider — bind it before sending a test message',
        code: ErrorCode.NOT_FOUND,
      });
    }

    const settings = this.settings;

    // ② 总开关（短路：不写验证态——这是运维状态，不是这个地址的判决）
    if (!settings.enabled) return { delivered: 0, channels: [], reason: 'notify_disabled' };

    // ③ provider 出口存在（同上，不写验证态）
    const providerImpl = this.providers.find((candidate) => candidate.key === provider);
    if (!providerImpl) return { delivered: 0, channels: [], reason: 'no_provider' };

    // ④ per-user 入口闸（防"测试按钮当骚扰工具"）
    const throttle = this.consumeTestBudget(userId);
    if (throttle !== null) {
      throw new NotifyRateLimitedException(
        throttle,
        `Test message rate limit exceeded (${NOTIFY_CHANNEL_TEST_RATE_LIMIT_PER_WINDOW} per ` +
          `${NOTIFY_CHANNEL_TEST_RATE_WINDOW_SECONDS}s). Retry in about ${throttle} second(s); ` +
          'this 429 had no effect (no message was sent, no verification state changed).',
      );
    }

    // ⑤ 部署级出境总闸（测试消息同样出境；批 2 事件路径复用同一原语）
    const gate = this.orchestrator.consumePlatformGate();
    if (!gate.allowed) {
      throw new NotifyRateLimitedException(
        gate.retryAfterSeconds,
        `The deployment-wide egress window is exhausted (${settings.platformRateLimit} messages ` +
          `per ${settings.platformRateWindowSeconds}s across all channels), so the test message ` +
          `was NOT sent. Retry in about ${gate.retryAfterSeconds} second(s).`,
      );
    }

    // ⑥ 同步投递（与直发同预算：agent/人 的客户端不该被退避拖过超时）
    const rendered: RenderedNotification = {
      category: DIRECT_TEST_DELIVERY_CATEGORY,
      eventId: null,
      title: NOTIFY_CHANNEL_TEST_TITLE,
      body:
        'This is a test notification from your notification settings. If you can read this, the ' +
        'channel works and will be used for your notifications.',
      link: settings.webBaseUrl,
      recipient: row.recipientAddress,
    };
    this.logger.log(`sending category=direct_test userId=${userId} channel=${provider}`);
    const outcome = await this.orchestrator.sendThroughProvider(providerImpl, rendered, {
      maxAttempts: NOTIFY_DIRECT_MAX_ATTEMPTS,
      budgetMs: NOTIFY_DIRECT_BUDGET_MS,
    });

    // ⑦ 台账（category='direct_test' 第三来源；recipient_user_id 归属本用户——批 1 只有这条路径落值）
    await this.deliveryRepo.record({
      channel: provider,
      recipient: row.recipientAddress,
      category: DIRECT_TEST_DELIVERY_CATEGORY,
      eventId: null,
      title: rendered.title,
      body: rendered.body,
      outcome,
      recipientUserId: userId,
    });

    // ⑧ 写验证态（**只有真的调过 provider 才走到这里**——见 applyTestOutcome 的写态纪律）
    await this.applyTestOutcome(row, outcome);
    // 写时失效：验证态 / 启用态可能刚变（`ok` ⇒ 该地址由"不可投"变"可投"），快照必须重建
    this.orchestrator.invalidateUser(userId);

    // switch 而非 `outcome.status === 'success'`：本仓 ESLint 规则 no-magic-string-compare
    // 禁止字面量比较（先例 notify-direct.service.ts 的 channels 收集处注释）
    switch (outcome.status) {
      case 'success':
        return { delivered: 1, channels: [provider] };
      default:
        return { delivered: 0, channels: [], reason: 'delivery_failed' };
    }
  }

  // ────────────────────────── PUT/DELETE /me/prefs ──────────────────────────

  /**
   * 稀疏覆盖通知类别偏好（`PUT /notification-settings/me/prefs`）。
   *
   * **原子键级合并**（一条 SQL，无读改写）：
   * `jsonb_set(coalesce(preferences,'{}'), '{notificationCategories}',
   * coalesce(preferences->'notificationCategories','{}') || $1::jsonb, true)`。
   *
   * 与 `updateMe`/`updateSettings` 的**整体替换**刻意不同：通知偏好按**键**稀疏覆盖
   * （`{task_done:false}` 只关这一类），而那两个端点替换整个 preferences 对象。两处偏离注释声明
   * （plan §D5 明写）：① 形状不同（键级 vs 顶层）；② **不做软删守卫**——`users` 表**没有**
   * `deleted_at` 列（软删事实在 `actors.deleted_at`），一条 `UPDATE users` 天然没有软删谓词可加；
   * 存在性由前置的 `requireUser`（带 actor 软删判定）保证。
   *
   * @param userId 当前登录用户 id
   * @param dto 稀疏覆盖（键 ∈ 10 类 + 严格布尔，DTO 已挡格式）
   * @returns 归一后的**完整**偏好映射（键恒在）
   */
  async updatePrefs(userId: string, dto: UpdatePrefsDto): Promise<NotificationCategoryPrefs> {
    await this.requireUser(userId);
    const patch = dto.notificationCategories ?? {};
    await this.userRepo.query(
      `UPDATE users
          SET preferences = jsonb_set(
                coalesce(preferences, '{}'::jsonb),
                '{notificationCategories}',
                coalesce(preferences -> 'notificationCategories', '{}'::jsonb) || $2::jsonb,
                true)
        WHERE id = $1`,
      [userId, JSON.stringify(patch)],
    );
    // 写时失效：类别偏好是快照输入——不失效会让"刚关掉的类别"在 TTL 窗口内继续推
    this.orchestrator.invalidateUser(userId);
    const user = await this.requireUser(userId);
    return normalizeNotificationCategories(
      (user.preferences ?? {})['notificationCategories'] as unknown,
    );
  }

  /**
   * 恢复默认通知偏好（`DELETE /notification-settings/me/prefs`）。
   *
   * **键级删除**：`preferences - 'notificationCategories'`——只删这一个键，不动用户的其余偏好
   * （主题 / 语言等）。删除后读取归一自然回落 `DEFAULT_NOTIFY_CATEGORIES`。
   *
   * @param userId 当前登录用户 id
   * @returns 归一后的完整偏好映射（= 缺省集全键形态）
   */
  async deletePrefs(userId: string): Promise<NotificationCategoryPrefs> {
    await this.requireUser(userId);
    await this.userRepo.query(
      `UPDATE users SET preferences = preferences - 'notificationCategories' WHERE id = $1`,
      [userId],
    );
    // 写时失效：恢复默认 = 偏好变了（缺省集回到 `DEFAULT_NOTIFY_CATEGORIES`）
    this.orchestrator.invalidateUser(userId);
    return defaultNotificationCategoryPrefs();
  }

  // ─────────────────────────────── 内部 ───────────────────────────────

  /**
   * 加载并校验当前用户（**必须存在且 actor 未软删**，铁律 #22）。
   *
   * @param userId 用户 id
   * @returns 实体（带 `relations.actor`，供 `user.role` / 软删判定）
   * @throws UnauthorizedException 401（请求没有 human 身份——见下方 B1 说明）
   * @throws NotFoundException 404（不存在 / actor 已软删）
   */
  private async requireUser(userId: string): Promise<User> {
    // ⚠️ **B1（评审）：这里的判空是认证绕过防线，不是防御性写法**。
    // `JwtAuthGuard` 对 `X-API-Key` 请求走的是 `request.agent = await apiKeyAuth.authenticate(...)`
    // 分支（`common/guards/jwt-auth.guard.ts` 的 apiKeyHeader 分支）——**它不挂 `request.user`**，
    // 于是 `@CurrentUser('userId')` 为 `undefined`。而 `findOne({ where: { id: undefined } })`
    // 会被 TypeORM **静默丢掉 WHERE**（同形态在 `jwt.strategy.ts` 注释里被定性为认证绕过），
    // 命中 `users` 表**第一行** ⇒ agent key 持有者能读写那个用户的渠道绑定并触发真实外发。
    // 故：拿不到 userId 一律 401（对齐本仓守卫的既有错误形态），绝不进仓储。
    if (!userId) {
      throw new UnauthorizedException({ message: 'Unauthorized', code: ErrorCode.TOKEN_INVALID });
    }
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: { actor: true } });
    if (!user || !user.actor || user.actor.deletedAt) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    return user;
  }

  /**
   * 保存渠道行（**仅 INSERT 路径**：首绑）并把 23505 按**约束名分流**成 409（不是 500）。
   *
   * M4：两条唯一约束含义不同，文案不能混：
   * - `uq_user_notification_channels_verified_address` ⇒ 该地址已被**其他账户**验证占用；
   * - `uq_user_notification_channels_user_provider` ⇒ 同一用户同一 provider 已有一行
   *   （并发双提交）⇒ 通用"已存在绑定，请刷新后重试"，不能让用户以为自己的飞书号被别人占了。
   *
   * @param row 待保存实体
   * @throws ConflictException 409（约束名决定文案）
   */
  private async saveChannel(row: UserNotificationChannel): Promise<void> {
    try {
      await this.channelRepo.save(row);
    } catch (err) {
      this.throwChannelConflict(err);
    }
  }

  /**
   * {@link updateChannelRow} 的**冲突映射版**（仅 PUT 的两条绑定分支用）。
   *
   * 为什么只有 PUT 要它：**复活 tombstone 行**是 PUT 侧唯一能撞地址部分唯一的地方
   * （`unbound_at: null` 会把一行 `last_test_status='ok'` 的旧行重新纳入索引范围），
   * 若该地址期间已被别的账户验证 ⇒ 23505 ⇒ 必须是 409（D5 的"PUT 撞 23505 → 409"），不是 500。
   * DELETE / 静音路径的 23505 在语义上不可能出现，故不给它们套这层（避免把不可能的事说成可能）。
   *
   * @param where 同 {@link updateChannelRow}
   * @param patch 同 {@link updateChannelRow}
   * @returns 命中行数
   * @throws ConflictException 409（按约束名分流文案）
   */
  private async updateChannelRowOrConflict(
    where: Parameters<NotificationSettingsService['updateChannelRow']>[0],
    patch: Parameters<NotificationSettingsService['updateChannelRow']>[1],
  ): Promise<number> {
    try {
      return await this.updateChannelRow(where, patch);
    } catch (err) {
      this.throwChannelConflict(err);
    }
  }

  /**
   * 渠道行的**条件 UPDATE**（M3 的统一形态：替代"读到内存再 `save()`"）。
   *
   * 为什么必须条件化：`save()` 会把**整行**（含我们读到内存时的旧列值）写回，两个并发请求
   * （一个换地址、一个静音）会互相覆盖对方的列；而一条带乐观守卫的 UPDATE 只写本次要改的列，
   * 守卫未通过（`affected=0`）就是"别人先改了"⇒ 调用方丢弃本次写态即可，不产生丢失更新。
   *
   * @param where 守卫（`id` 或 `userId` 二选一 + provider + 可选地址 + 可选"仅未解绑行"）
   * @param patch 只含本次要改的列（实体属性名，TypeORM 按元数据映射列名）
   * @returns 命中行数（0 = 守卫未通过 ⇒ 调用方丢弃本次写态）
   */
  private async updateChannelRow(
    where: {
      userId?: string;
      id?: string;
      provider: string;
      recipientAddress?: string;
      onlyUnbound?: boolean;
    },
    patch: Partial<
      Pick<
        UserNotificationChannel,
        | 'enabled'
        | 'lastTestAt'
        | 'lastTestStatus'
        | 'lastTestAddress'
        | 'source'
        | 'unboundAt'
        | 'recipientAddress'
      >
    >,
  ): Promise<number> {
    const builder = this.channelRepo
      .createQueryBuilder()
      .update(UserNotificationChannel)
      .set(patch);
    if (where.id) {
      builder.where('id = :id', { id: where.id });
    } else {
      builder.where('user_id = :userId', { userId: where.userId });
    }
    builder.andWhere('provider = :provider', { provider: where.provider });
    if (where.recipientAddress !== undefined) {
      // 乐观守卫：地址变了 ⇒ 本次写态作废（不覆盖别人刚改的地址/验证态）
      builder.andWhere('recipient_address = :recipientAddress', {
        recipientAddress: where.recipientAddress,
      });
    }
    if (where.onlyUnbound) {
      builder.andWhere('unbound_at IS NULL');
    }
    const result = await builder.execute();
    return result.affected ?? 0;
  }

  /**
   * 条件更新未命中（`affected=0`）⇒ 记一行 INFO（可 grep），不抛。
   *
   * 语义：本次写态被并发的解绑 / 改址"超越"了——按现状返回即可，用户看到的是最新事实。
   * 不抛的理由：这是**正常的并发结果**（不是错误）；抛错会让用户收到一个无法行动的 500。
   */
  private noteDiscardedWrite(
    affected: number,
    userId: string,
    provider: string,
    reason: string,
  ): void {
    if (affected > 0) return;
    this.logger.log(
      `channel write discarded [${reason}] userId=${userId} provider=${provider} ` +
        '(a concurrent unbind/rebind won — the write was not applied)',
    );
  }

  /**
   * 把 23505 映射成 409，**按约束名分流文案**（M4；见 {@link saveChannel}）。
   *
   * @param err 仓储抛出的错误（非 23505 原样再抛）
   * @throws ConflictException 409
   */
  private throwChannelConflict(err: unknown): never {
    const constraint = uniqueViolationConstraint(err);
    if (!constraint) throw err;
    throw new ConflictException({
      message:
        constraint === VERIFIED_ADDRESS_UNIQUE_INDEX
          ? ADDRESS_TAKEN_MESSAGE
          : CHANNEL_EXISTS_MESSAGE,
      code: ErrorCode.RESOURCE_CONFLICT,
    });
  }

  /**
   * 置 `enabled=true`——**服务端验证不变量**（条件更新，见文件头不变量）。
   *
   * `WHERE last_test_address = recipient_address AND last_test_status IN ('ok','seeded')`：
   * 一条 UPDATE 完成"检查 + 写入"，`affected=0` ⇒ 400。
   *
   * @param userId 用户 id
   * @param provider provider token
   * @param address 当前地址（用于 WHERE 三重命中）
   * @throws BadRequestException 400（该地址尚无有效验证）
   */
  private async enableChannelOrThrow(
    userId: string,
    provider: NotifyProviderToken,
    address: string,
  ): Promise<void> {
    const result = await this.channelRepo
      .createQueryBuilder()
      .update(UserNotificationChannel)
      .set({ enabled: true })
      .where('user_id = :userId', { userId })
      .andWhere('provider = :provider', { provider })
      .andWhere('recipient_address = :address', { address })
      // tombstone 行不许被置启用（解绑 = 通知立即停止；复活必须走 PUT 的绑定动作）
      .andWhere('unbound_at IS NULL')
      // 列对列比较：验证锚点必须等于当前地址（"改了地址但保留旧验证态"在此被挡）
      .andWhere('last_test_address = recipient_address')
      .andWhere('last_test_status IN (:...verifiedStatuses)', {
        verifiedStatuses: [...DELIVERY_ELIGIBLE_LAST_TEST_STATUSES],
      })
      .execute();

    if (!result.affected) {
      throw new BadRequestException({
        message: NOT_VERIFIED_MESSAGE,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
  }

  /**
   * 消费一次 test 入口额度（per-user 滑动窗口，3/60s）。
   *
   * @param userId 用户 id（窗口维度）
   * @returns 超限时的建议等待秒数；未超限返回 null（并已记账）
   */
  private consumeTestBudget(userId: string): number | null {
    const windowMs = NOTIFY_CHANNEL_TEST_RATE_WINDOW_SECONDS * 1000;
    const now = Date.now();
    const windowStart = now - windowMs;
    const hits = (this.testHits.get(userId) ?? []).filter((at) => at > windowStart);

    if (hits.length >= NOTIFY_CHANNEL_TEST_RATE_LIMIT_PER_WINDOW) {
      // 未记账：超限的这次调用不推进窗口（否则持续重试会把自己锁在外面）
      this.testHits.set(userId, hits);
      return Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    }
    hits.push(now);
    this.testHits.set(userId, hits);
    // m8：顺手回收**窗口外已无记录**的键——否则每个"只试过一次"的用户会在 Map 里永久留一个
    // 条目，键数单调增长。map 只含"调用过测试消息"的用户且清扫有阈值，开销可忽略。
    if (this.testHits.size > TEST_HITS_SWEEP_THRESHOLD) this.sweepTestHits(windowStart);
    return null;
  }

  /**
   * 删除所有窗口外已无记录的键（m8：**delete 而不是 set 空数组**——空数组同样占一个键）。
   *
   * @param windowStart 窗口起点（早于它的时间戳都算过期）
   */
  private sweepTestHits(windowStart: number): void {
    for (const [key, hits] of [...this.testHits]) {
      if (hits.every((at) => at <= windowStart)) this.testHits.delete(key);
    }
  }

  /**
   * 依据一次真实投递结果写验证态（**只在这里、且只在真的调过 provider 后调用**）。
   *
   * 写态纪律（M6 修正版；判据见 `DeliveryOutcome.failureKind`）：
   * - `success` ⇒ `ok` + `last_test_address=当前地址` + `last_test_at` + 自动 `enabled=true`
   *   （测试通过即视为用户想收——省一步点击；地址占用冲突在此冒 409）；
   * - `failed` **且 `failureKind === 'address'`**（消息端点 4xx / 业务码拒绝——receive_id 非法等，
   *   plan 归因"这个地址不行"）⇒ `last_test_status='failed'`；
   * - `failed` 但 `failureKind` 是 `'transport'`（无 HTTP 响应：超时 / 网络 / 凭据短路）或
   *   `'provider'`（5xx / 鉴权 / 限流 / 体不可解析 / 未分类）⇒ **不写验证态**：那是"此刻的运维
   *   或网络状态"，不是这个地址的判决。一次上游 5xx 把已验证的地址打成 `failed` = 让用户
   *   掉出 `deliveryEligible`，从此静默收不到通知。
   *
   * 写入形态（M3）：**条件 UPDATE**（`id = :id AND unbound_at IS NULL AND
   * recipient_address = :address`）——期间被解绑/改址 ⇒ affected=0 ⇒ 本次写态丢弃（只记 INFO），
   * 不覆盖并发写。
   *
   * @param row 渠道行（活绑定）
   * @param outcome provider 终态
   * @throws ConflictException 409（成功写 `ok` 时该地址已被其他账户验证占用）
   */
  private async applyTestOutcome(
    row: UserNotificationChannel,
    outcome: Awaited<ReturnType<NotifyOrchestrator['sendThroughProvider']>>,
  ): Promise<void> {
    const lastTestAt = outcome.deliveredAt ?? new Date();
    let patch: Parameters<NotificationSettingsService['updateChannelRow']>[1];

    switch (outcome.status) {
      case 'success':
        patch = {
          lastTestAt,
          lastTestStatus: 'ok',
          lastTestAddress: row.recipientAddress,
          enabled: true,
        };
        break;
      default:
        // 失败：只有**地址可归因**才写 failed（见上方写态纪律）
        if (outcome.failureKind !== 'address') {
          this.logger.log(
            `test outcome not written to verification state [${outcome.failureKind ?? 'unclassified'}] ` +
              `userId=${row.userId} provider=${row.provider} — not an address verdict`,
          );
          return;
        }
        patch = { lastTestAt, lastTestStatus: 'failed' };
        break;
    }

    try {
      const affected = await this.updateChannelRow(
        {
          id: row.id,
          provider: row.provider,
          recipientAddress: row.recipientAddress,
          onlyUnbound: true,
        },
        patch,
      );
      this.noteDiscardedWrite(affected, row.userId, row.provider, 'test verdict was overtaken');
    } catch (err) {
      this.throwChannelConflict(err);
    }
  }

  /**
   * 判断一个 provider 在本部署是否**可投递**（`configured`）。
   *
   * 判据 = 该 provider 在 `NOTIFY_PROVIDERS` 白名单里 **且**（飞书）应用凭据齐。
   * ⚠️ 与总开关无关：`NOTIFY_ENABLED=false` 时前端仍要显示"平台已配置飞书"（只是没开通知），
   * 否则用户会误以为要去配 App ID。
   *
   * @param key provider token
   * @returns true = 本部署能通过它投递
   */
  private isProviderConfigured(key: NotifyProviderToken): boolean {
    if (!this.settings.providers.includes(key)) return false;
    if (key === 'feishu') {
      return Boolean(this.settings.feishuAppId && this.settings.feishuAppSecret);
    }
    return false;
  }

  /** 实体 → 视图（只暴露稳定契约字段；内部判定列不外泄） */
  private toChannelView(row: UserNotificationChannel): NotificationChannelView {
    return {
      provider: row.provider,
      recipientAddress: row.recipientAddress,
      enabled: row.enabled,
      lastTestStatus: row.lastTestStatus,
      lastTestAt: row.lastTestAt,
      source: row.source,
      createdAt: row.createdAt,
    };
  }
}

/**
 * 读取 PG 唯一约束冲突的**约束名**（`23505` 才返回；其它错误一律 null）。
 *
 * TypeORM 的 `QueryFailedError` 把 pg 的 `constraint` 放在 `driverError` 上（部分版本也直接挂在
 * 错误对象上），两个位置都探一次（M4 的分流依赖它）。
 *
 * @param err 仓储抛出的错误
 * @returns 约束名，或 null（非唯一冲突）
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  const candidate = err as
    | { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } }
    | null
    | undefined;
  const code = candidate?.constraint
    ? candidate.code
    : (candidate?.driverError?.code ?? candidate?.code);
  if (code !== PG_UNIQUE_VIOLATION) return null;
  return candidate?.constraint ?? candidate?.driverError?.constraint ?? null;
}
