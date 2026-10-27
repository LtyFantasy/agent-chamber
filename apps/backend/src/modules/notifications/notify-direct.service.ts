/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **直发链路**（`POST /api/v1/notifications/messages` 的服务侧）：agent 显式请求把一条
 *     消息推给**它自己的人类 owner**（`agent.ownerId`）的外部 IM。与事件链路
 *     （`NotifyOrchestrator`）的区别是**同步等待结果**——调用方拿到的不只是 HTTP 200，
 *     还有 `delivered`/`reason` 这一份可据以决定"要不要重试"的事实。
 *     ⚠️ 一期这里是"推给部署级固定的那个 Owner"（`FEISHU_RECIPIENT_OPEN_ID`），二期批 2 棒 B
 *     改成"推给调用者的 creator"——多用户模型下"谁是 Owner"不再有全局答案。
 *
 * [代码职责]
 *   - `send(actor, dto)`：九步管线（**步骤编号与 `send()` 内的注释一一对应**，顺序即语义，
 *     plan §7.1）——
 *     ① **总开关**（`enabled=false` ⇒ 200 降级 `notify_disabled`；**连幂等都不记**）
 *     ② **幂等**（内存 TTL 10min；**仅 200 结果进缓存**；命中即返回首次信封、**不耗额度**；
 *        同键异载荷 ⇒ 409/9002）
 *     ③ **入口节流**（per-agent 滑动窗口；超限 ⇒ 429 三件套里的两件：code + 秒数）
 *     ④ **类别开关**（`direct` 被 `NOTIFY_CATEGORIES` 关掉 ⇒ 200 降级 `category_disabled`）
 *     ⑤ **自回声**（**人类**调用者 = 给自己发 ⇒ 200 降级 `self_echo`；见下方"direct 的自回声
 *        例外"）
 *     ⑥ **收件人解析 + 配置前提**（调用 agent 的 `ownerId` → 该用户的主投递渠道；无出口
 *        `no_provider` / 该 creator 没有 deliveryEligible 绑定 `recipient_not_bound` ⇒ 200 降级）
 *     ⑦ **L2 占额**（**占额但永不合并**：直发是显式的、单条的，把它塞进摘要就违背了
 *        调用方的意图；额度耗尽 ⇒ 429，`retryAfterSeconds` = 窗口剩余秒数）
 *     ⑧ **同步投递**（预算 ≤2 次尝试 / ≤10s）→ 终态落库（`category='direct'`、`event_id` NULL、
 *        `recipient_user_id` = creator）
 *     ⑨ **回填幂等表**（仅走到这里才会写；所有 `throw` 都在它之前）
 *   - `renderDirectNotification()`（**纯函数**，单测直接断言出境面）：`[<agent 显示名>]`
 *     短标签 + agent 自填正文 + 服务端拼接的深链
 *   - `NotifyRateLimitedException`：429 的**服务侧契约**（HTTP 码 + `code` +
 *     `data.retryAfterSeconds`）；`Retry-After` 头由 controller 负责（它在 controller 手里
 *     才拿得到 Response 对象，见 notifications.controller.ts 注释）
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §7.1（直发端点全契约）/
 *     §3（直发链路图）/ §11（风险对策：幂等毒化 / 直发被 L2 合并改写）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/api-definition.md`；
 *     落点后本定位符改为线上文档。
 *
 * [关键不变量]
 *   - **处理顺序钉死**（plan §7.1）：总开关 → 幂等 → 节流 → 类别开关 → 自回声 → 收件人解析
 *     → L2 占额 → 同步投递 → 回填幂等表（编号与 `send()` 内注释一一对应）。
 *     ⚠️ **一处对 plan 的显式偏离（有意）**：两个"配置前提"检查（`no_provider` /
 *     `recipient_not_bound`）插在 **L2 之前**。理由：L2 的窗口维度就是**收件人**（没有收件人
 *     就没有窗口键），且为一次"可证明发不出去"的投递先占用人类额度，等于用一次运维失误
 *     （creator 还没绑渠道）去挤掉他真正该收到的通知——那是把配置错误的代价转嫁给用户。
 *     两者的产出都是 200 降级信封，与 plan 的 reason 值域一致。
 *   - **收件人 = 调用 agent 的 `ownerId`，不是部署级单 Owner**（Notifications 二期批 2 棒 B /
 *     plan §D3 的 `direct` 行）：`UnifiedActor.ownerId` 只在 agent 分支填充（见 actor.types.ts
 *     的踩坑 O1），所以"人给自己发"这件事在这一步就只剩 human 分支可达。
 *     ⚠️ **人类调用者没有 `ownerId`**（刻意不填为"自己"，见同一条踩坑）⇒ **不能用
 *     `actor.ownerId` 去判"人类调用者是不是收件人"**，那会恒为 undefined 从而漏掉自回声。
 *   - **direct 的自回声例外**（plan §D3 写死）：direct **不适用"我的 agent"泛化**，唯一的自回声
 *     是"**人类** JWT 调用者就是收件人本人"（人不需要通知自己）。理由：若也套用"调用者 ∈
 *     收件人的 agents ⇒ 跳过"，**agent 通过本端点给它的人类 owner 发消息会被自己吞掉**——
 *     调用方拿到 `delivered=1` 却没人收到（这是本端点存在的意义被抹掉）。
 *   - **`recipient_not_bound` 不进幂等缓存**（**per-user 状态会变**）：今天没绑不等于十分钟后
 *     没绑——用户绑好之后，同一个 `clientRequestId` 重放必须能真的发出去，而不是被 10 分钟前的
 *     旧结论骗住。判据在 `shouldCacheDirectEnvelope`（单源 = `NOTIFY_DIRECT_CACHEABLE_REASONS`）。
 *   - **仅 200 结果进幂等缓存**：429（限流）/ 400（DTO）/ 409（键冲突）**一律不写**。
 *     否则一个键被一次 429 毒化后，同键重放会拿到"限流"的旧信封、永远拿不到真实结果
 *     （plan §11 的"幂等毒化"对策）。实现上即：所有 `throw` 都在缓存写入之前。
 *   - **命中幂等不耗额度**：命中路径在节流**之前**返回 ⇒ 重放不会二次消耗入口闸与 L2。
 *   - **直发占 L2 额度但永不合并**（plan §11）：`reserveL2ForDirect` 只记账不进摘要；
 *     超额直接 429 让调用方决定何时重试，而不是把它的消息改写成一条"另有 N 条"。
 *   - **同键异载荷必须 409 而不是重放**：重放一个与首次不同的载荷会让人收到一条
 *     与"以为重发的那条"不符的消息（且信封声称成功）。判据 = `text` + `link` 的指纹。
 *   - **信封两分支同形**：`{ delivered, channels, reason? }`——成功也带 `channels`，
 *     降级也带 `channels: []`（**不缺字段**，agent 的解析分支不需要写 null 判断）。
 *     `channels` = **实际送达的渠道**（`delivered=0` 时恒 `[]`，不是"尝试过的渠道"）。
 *   - **本文件不读 ALS**：身份一律来自 controller 传进来的 `UnifiedActor`
 *     （`@CurrentActor()` 是同步投影，无 `{async:true}` 上下文继承问题——与编排器的
 *     "禁读 ALS"是两条不同的理由，别把那条规则误读成"本文件不能用 CurrentActor"）。
 *   - **内存态前提**：幂等表与入口窗口都在**进程内**——每实例独立、重启清零、多副本实际
 *     额度 ×N。**这是限流，不是配额**（无共享存储；生产单实例部署前提成立）。
 *
 * [关联代码]
 *   - notifications.controller.ts — 唯一调用方（负责 `Retry-After` 头与 DTO/守卫）
 *   - notify-orchestrator.service.ts — 复用它的 `resolveDirectTarget`（收件人解析：ownerId →
 *     主投递渠道，**地址与 L2 窗口同一份事实源**）、`reserveL2ForDirect`（L2 窗口，键 = userId）
 *     与 provider 调用兜底（`sendThroughProvider`）；**本文件不另写一份收件人解析，也不自建
 *     读权限/绑定判据**（deliveryEligible 单源在 notification-channel-eligibility.ts）
 *   - notify-delivery.repository.ts — 终态落库（唯一写入口，永不抛）
 *   - notify-provider.interface.ts — `RenderedNotification`（出境面）/ `NotifySendOptions`（预算）
 *   - dto/send-notification-message.dto.ts — 请求契约（link 白名单）
 *   - notifications.constants.ts — 幂等 TTL / 预算 / reason 值域单源
 *
 * [持久踩坑]
 *   NOTIFY-DIRECT-IDEMPOTENCY-POISON(幂等毒化): 把 429/失败也写进幂等缓存 ⇒ 同键重放
 *     永远拿到旧信封，调用方以为"平台说发不出去"。安全方向: 只缓存 200 结果（见不变量）。
 *   NOTIFY-DIRECT-L2-MERGE(直发被合并): 若直发也走"超额合并摘要"的事件链路逻辑，agent 明确
 *     要求的一条消息会被改写成"另有 N 条通知"——调用方拿到 200 却没人收到那条消息。
 *     安全方向: 占额不合并，超额 429 让调用方自己决定。
 *   NOTIFY-DIRECT-QUOTA-BURN(为配置错误烧额度): 先占 L2 再检查收件人是否配置 ⇒ 一次忘配
 *     open_id 就把收件人的窗口挤掉（他真正该收的通知全部进摘要）。安全方向: 配置前提检查
 *     前置到 L2 之前（对 plan 的显式偏离，见不变量）。
 *   NOTIFY-DIRECT-SELF-ECHO-SWALLOW(agent 直发被自己吞掉): 把"调用者 ∈ 收件人的 agents ⇒
 *     跳过"这条事件链路的自回声规则照搬到直发，会让 **agent 给它的 owner 发的每一条消息**
 *     都被吞（调用方还拿到 200/`delivered=1`）。安全方向: direct 的自回声只有"人类调用者 ==
 *     收件人本人"这一种（见不变量）。
 *
 * [铁律关联] #11(注释强制) #9(代理层透传：上游 429 不得包装成 500) #17(测试契约) #18(不变量检查)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改动处理顺序前先读 [关键不变量] 的三条踩坑（顺序即语义）
 *   □ 新增 `reason` 值必须同步 `NOTIFY_DIRECT_REASONS` + controller 的 Swagger + 单测矩阵
 *   □ 新增出境字段必须同 commit 更新 config 的 `NOTIFY_EGRESS_FIELDS`（本文件是出境面成形点之一）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';
import { NOTIFY_CATEGORY, type NotificationsConfig } from '../../config/notifications.config';
import { resolveNotificationsConfig } from './notifications-provider.factory';
import {
  NOTIFY_PROVIDER_LIST,
  type NotifyProvider,
  type RenderedNotification,
} from './notify-provider.interface';
import { NotifyOrchestrator, TtlMap } from './notify-orchestrator.service';
import { NotifyDeliveryRepository } from './notify-delivery.repository';
import type { SendNotificationMessageDto } from './dto/send-notification-message.dto';
import {
  NOTIFY_DIRECT_CACHEABLE_REASONS,
  NOTIFY_DIRECT_BUDGET_MS,
  NOTIFY_DIRECT_IDEMPOTENCY_MAX_ENTRIES,
  NOTIFY_DIRECT_IDEMPOTENCY_TTL_MS,
  NOTIFY_DIRECT_MAX_ATTEMPTS,
  NOTIFY_DIRECT_TITLE_MAX_LENGTH,
  type NotifyDirectReason,
} from './notifications.constants';

/**
 * 直发端点对调用 agent 的**统一应答信封**（两分支同形，见文件头不变量）。
 *
 * 它是 automcp 生成的 MCP 工具输出 schema 的来源——字段语义必须自解释。
 */
export interface NotifyDirectEnvelope {
  /** 是否送达（1 = 至少一个渠道确认成功；0 = 未送达，看 `reason`） */
  delivered: 0 | 1;
  /** **实际送达的渠道**（`= provider.key`；`delivered=0` 时恒 `[]`——不是"尝试过的渠道"） */
  channels: string[];
  /** 降级/失败原因（**成功时字段缺席**；八值封闭，见 `NOTIFY_DIRECT_REASONS`） */
  reason?: NotifyDirectReason;
}

/**
 * 直发/事件链路共用的 429 异常（HTTP 429 + `ErrorCode.RATE_LIMITED` + `data.retryAfterSeconds`）。
 *
 * 为什么是异常而不是返回值：**429 是"这次调用没有发生"**（没有投递、没有落库、没有占幂等键），
 * 用一个普通返回值表达会让调用方以为"调用发生了、只是一条结果"，而它必须知道"重试是安全的、
 * 而且不该立刻重试"。
 *
 * ⚠️ `Retry-After` 头**不在这里设置**：本类拿不到 Response 对象。头由 controller 在
 * `throw` 之前用 `@Res({ passthrough: true })` 显式 `setHeader`（全仓过滤器无 setHeader
 * 先例，必须显式做——见 notifications.controller.ts 注释）。
 */
export class NotifyRateLimitedException extends HttpException {
  /** 建议等待秒数（同时进 `Retry-After` 头与 body 的 `data.retryAfterSeconds`，两处同源） */
  readonly retryAfterSeconds: number;

  /**
   * @param retryAfterSeconds 建议等待秒数（≥1；窗口剩余时间的向上取整）
   * @param message 面向 agent 的失败文案（**必须自带"下一步怎么做"**，见 experience 先例文风）
   */
  constructor(retryAfterSeconds: number, message: string) {
    super(
      {
        message,
        code: ErrorCode.RATE_LIMITED,
        // 全局过滤器按 resObj.data 原样透出到统一信封的 data 槽（见 all-exceptions.filter.ts）
        data: { retryAfterSeconds },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * 幂等表的一行：指纹（同键异载荷的判据）+ 首次调用产出的信封。
 */
interface DirectIdempotencyEntry {
  /** 首次调用的 `text` + `link` 指纹（见 {@link fingerprintOf}） */
  fingerprint: string;
  /** 首次调用的 200 信封（重放时原样返回，不耗额度） */
  envelope: NotifyDirectEnvelope;
}

/**
 * 一条**在飞**的直发请求（同幂等键并发去重的占位值；见 `NotifyDirectService.inFlight`）。
 */
interface DirectInFlight {
  /** 发起该次调用的请求指纹（同 key 异载荷必须 409，**不能**因为"刚好在飞"就放行） */
  fingerprint: string;
  /** 该次调用的最终信封（后到者 await 同一个 promise ⇒ 只发一次、拿到同一个信封对象） */
  promise: Promise<NotifyDirectEnvelope>;
}

/**
 * 直发投递服务（**default-scope 单例**：幂等表与入口窗口必须在整个进程内共享）。
 */
@Injectable()
export class NotifyDirectService {
  private readonly logger = new Logger(NotifyDirectService.name);

  /** 生效配置（构造期解析一次；与编排器同一份解析函数，形状不会漂移） */
  private readonly settings: NotificationsConfig;

  /**
   * 幂等表：`<actor 维度键> → { fingerprint, envelope }`（TTL 10min、容量 1000、满则淘汰最旧）。
   *
   * 值里存 fingerprint（而不是只存信封）是 **409 判据**的来源：同键异载荷必须能被识别，
   * 否则重放会返回一个描述着"另一条消息"的信封。
   *
   * 存指纹原文而不是哈希：正文是调用方自己写的内容、寿命 10 分钟、上限 1000 条，哈希只会
   * 徒增一个"哈希实现换了导致历史键静默失配"的隐患（且 e2e 的 test-setup 全局 mock 了
   * `crypto.createHash`，任何依赖它的判据在那条链上都会退化成恒等）。
   *
   * 复用 `TtlMap`（编排器的 L1 缓存实现）而不是裸 Map + 手写清理：TTL 失效与容量淘汰的语义
   * 已在那边有单测；再写一份、漏掉"过期即删"就会让内存表随时间无上限增长。
   *
   * ⚠️ **只有"已经发生过的投递结论"才进这张表**（判据 = `shouldCacheDirectEnvelope`）：
   * 成功 / `delivery_failed` / `self_echo` 进；四个**配置类降级**（`notify_disabled` /
   * `category_disabled` / `no_provider` / `no_recipient`）**不进**——它们描述的是"此刻的运维
   * 状态"，缓存 10 分钟等于在运维把收件人配好之后继续骗调用方"没配收件人"。
   */
  private readonly idempotency = new TtlMap<DirectIdempotencyEntry>(
    NOTIFY_DIRECT_IDEMPOTENCY_MAX_ENTRIES,
  );

  /**
   * **在飞请求**（同一幂等键的并发去重）：`幂等键 → 该次调用的 promise`。
   *
   * 为什么必须有它（P0）：幂等读（②）与回填（⑨）之间隔着**最长 10s 的同步投递**。同一 agent
   * 的客户端超时重试、或两条并发请求带同一个 key，会在两条都读到"未命中"之后**各发一次**——
   * 人收到两条一样的消息，而幂等表事后只记下一个结论（探针实证）。读缓存**挡不住"还没写进
   * 缓存"的并发**，只有占位能挡。
   *
   * 形态抄 `feishu.notify-provider.ts` 的 `tokenInFlight`（置位 → await → finally 清位）：
   * 后到者共享**同一个 promise**，故只发一次、两者拿到**同一个信封对象**。
   *
   * ⚠️ 指纹校验**在共享之前**：同 key 异载荷必须 409，不能因为"刚好在飞"就放行。
   */
  private readonly inFlight = new Map<string, DirectInFlight>();

  /** 幂等表读（过期即惰性失效；语义见字段注释） */
  private idempotencyGet(key: string): DirectIdempotencyEntry | undefined {
    return this.idempotency.get(key);
  }

  /** 幂等表写（TTL 单源 = `NOTIFY_DIRECT_IDEMPOTENCY_TTL_MS`） */
  private idempotencySet(key: string, value: DirectIdempotencyEntry): void {
    this.idempotency.set(key, value, NOTIFY_DIRECT_IDEMPOTENCY_TTL_MS);
  }

  /** per-agent 直发入口窗口（滑动时间戳；惰性剔除过期项） */
  private readonly directHits = new Map<string, number[]>();

  constructor(
    private readonly config: ConfigService,
    @Inject(NOTIFY_PROVIDER_LIST)
    private readonly providers: NotifyProvider[],
    private readonly orchestrator: NotifyOrchestrator,
    private readonly deliveryRepo: NotifyDeliveryRepository,
  ) {
    this.settings = resolveNotificationsConfig(config);
  }

  /**
   * 直发一条通知（九步管线；见文件头 [代码职责]——步骤编号与下方注释一一对应）。
   *
   * ⚠️ **本方法是幂等门面，不是管线本体**：①（总开关）与 ②（幂等读 + 在飞共享）在这里，
   * ③–⑨ 在 `runDirectPipeline()`。拆两层的唯一理由是**同键并发去重**——读缓存挡不住"还没写进
   * 缓存的并发"（读与写之间隔着最长 10s 的同步投递），只有 in-flight 占位能挡（P0）。
   *
   * @param actor 调用者（`@CurrentActor()` 的同步投影；**不读 ALS**）
   * @param dto 已通过 DTO 校验的请求体
   * @returns 统一信封（成功或降级）
   * @throws NotifyRateLimitedException 429（入口闸或 L2 耗尽）
   * @throws ConflictException 409（同幂等键、不同载荷）
   */
  async send(actor: UnifiedActor, dto: SendNotificationMessageDto): Promise<NotifyDirectEnvelope> {
    // ① 总开关：false ⇒ 一切静默（**连幂等都不记**——没开通知时缓存一个"通知没开"的信封
    //    毫无价值，只会在运维打开开关后继续用旧信封骗调用方 10 分钟）
    if (!this.settings.enabled) return this.degraded('notify_disabled');

    const fingerprint = fingerprintOf(dto);
    const idempotencyKey = actor.type + ':' + actor.id + ':' + (dto.clientRequestId ?? '');

    // ② 幂等（**先于节流**）：命中即返回首次信封，且**不耗额度**
    if (dto.clientRequestId) {
      const cached = this.idempotencyGet(idempotencyKey);
      if (cached !== undefined) {
        return this.replay(cached, fingerprint, dto.clientRequestId, actor);
      }

      // ②b **在飞共享**：同一 key 的并发请求共享同一次投递（见 `inFlight` 字段注释）。
      //     指纹先校验：同 key 异载荷必须 409，不能因为"刚好在飞"就放行。
      const flying = this.inFlight.get(idempotencyKey);
      if (flying !== undefined) {
        if (flying.fingerprint !== fingerprint) throw this.conflict(dto.clientRequestId);
        this.logger.log(
          `direct joined [in_flight] actorId=${actor.id} — a concurrent call with the SAME key is ` +
            'already delivering; this request shares that single delivery and its envelope',
        );
        return flying.promise;
      }
    }

    const work = this.runDirectPipeline(actor, dto, fingerprint, idempotencyKey);
    if (!dto.clientRequestId) return work;

    // 占位与创建**同 tick**（中间没有 await ⇒ 后续并发只可能看到这个 entry）
    this.inFlight.set(idempotencyKey, { fingerprint, promise: work });
    try {
      return await work;
    } finally {
      // settle 即摘牌（成功 / 降级 / 429 抛出都走这里）；此时该回填的缓存已由管线 ⑨ 写好
      this.inFlight.delete(idempotencyKey);
    }
  }

  /**
   * 命中幂等缓存：指纹一致 ⇒ 返回首次信封（**不耗额度**）；不一致 ⇒ 409。
   *
   * @param cached 缓存条目
   * @param fingerprint 本次请求的指纹
   * @param clientRequestId 调用方给的键（只用于 409 文案）
   * @param actor 调用者（只用于日志）
   * @returns 首次信封
   */
  private replay(
    cached: DirectIdempotencyEntry,
    fingerprint: string,
    clientRequestId: string,
    actor: UnifiedActor,
  ): NotifyDirectEnvelope {
    if (cached.fingerprint !== fingerprint) throw this.conflict(clientRequestId);
    this.logger.log(
      `direct replay [idempotent] actorId=${actor.id} — the first envelope is returned ` +
        'without consuming the rate budget',
    );
    return cached.envelope;
  }

  /**
   * 409 幂等冲突（同键异载荷；**不回显正文**——它可能很长）。
   *
   * 文案必须给出两条可行路径（重发原载荷 / 换新键），否则 agent 唯一的反应是"再试一次同样的
   * 请求"，而那条路永远 409。
   *
   * @param clientRequestId 调用方给的键（回显它自身是安全的：键是它自己填的）
   * @returns 可直接 throw 的异常
   */
  private conflict(clientRequestId: string): ConflictException {
    return new ConflictException({
      message:
        `clientRequestId "${clientRequestId}" was already used with a different text/link, so ` +
        "replaying it is refused (the first call's envelope describes a different message). " +
        'Resend the ORIGINAL text/link to get the first envelope back, or use a NEW ' +
        'clientRequestId for this message.',
      code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
    });
  }

  /**
   * 管线本体（步骤 ③–⑨；编号与文件头 [代码职责] 一一对应）。
   *
   * ⚠️ **所有 `throw` 都发生在步骤 ⑨ 之前** —— 这是"仅 200 结果进幂等缓存"的实现方式：
   * 429（③/⑦）与 409（②）都在回填之前抛出，故不会被缓存毒化（plan §11）。
   *
   * @param actor 调用者
   * @param dto 请求体
   * @param fingerprint 幂等指纹（回填用）
   * @param idempotencyKey 幂等键（回填用）
   * @returns 统一信封
   */
  private async runDirectPipeline(
    actor: UnifiedActor,
    dto: SendNotificationMessageDto,
    fingerprint: string,
    idempotencyKey: string,
  ): Promise<NotifyDirectEnvelope> {
    const settings = this.settings;

    // ③ 入口节流（per-agent 滑动窗口）
    const throttle = this.consumeDirectBudget(actor);
    if (throttle !== null) {
      throw new NotifyRateLimitedException(
        throttle,
        `Direct notification rate limit exceeded (${settings.directRateLimitPerWindow} messages ` +
          `per ${settings.directRateWindowSeconds}s per actor). Retry in about ${throttle} ` +
          'second(s). Do NOT retry immediately — the window is rolling, and the limit exists so ' +
          "one agent cannot flood the Owner's phone. This 429 was NOT recorded against your " +
          'clientRequestId, so replaying the SAME key after the window is safe.',
      );
    }

    // ④ 类别开关：运维把 direct 关了（缺省是开的）
    if (!settings.categories.includes(NOTIFY_CATEGORY.DIRECT)) {
      return this.degraded('category_disabled');
    }

    // ⑤ 自回声（**direct 的例外语义**，plan §D3 写死）：**只有"人类调用者就是收件人本人"**算
    //    自回声——人不通知自己。
    //    ⚠️ **刻意不做"我的 agent"泛化**（事件链路 `isSelfEcho` 那条在这里是错的）：本端点的
    //    收件人 = **调用 agent 的 `ownerId`**，所以 agent 调用时"调用者 ∈ 收件人的 agents"
    //    **恒成立**——照搬那条判据会让 agent 给 owner 发的**每一条**消息都被吞掉（调用方拿到
    //    200/`delivered=1` 却没人收到，本端点存在的意义被抹掉）。
    //    ⚠️ **只能按 `actor.type` 分叉，不能拿 `actor.ownerId` 去比**：human 分支刻意不填
    //    `ownerId`（见 actor.types.ts 踩坑 O1），拿它去比会恒为 undefined ⇒ 自回声漏判。
    if (actor.type === ActorType.HUMAN) {
      return this.degraded('self_echo');
    }

    // ⑥ 收件人解析 + 配置前提（**前置到 L2 之前**，理由见文件头不变量的显式偏离说明）
    if (this.providers.length === 0) return this.degraded('no_provider');
    const creatorUserId = actor.ownerId;
    if (!creatorUserId) {
      // agent 的 `agents.owner_id` 是 NOT NULL（认证上下文照抄该列），所以这里只在"认证载荷
      // 缺字段"这种畸形请求上可达（同 controller 里 `!actor` 的处置）。语义仍是"平台配置/
      // 身份投影缺了收件人"这一类 ⇒ 复用 `no_recipient`（**不是** `recipient_not_bound`：
      // 后者是"你的 creator 存在但还没绑渠道"，与"我们根本认不出你的 creator"是两件事）。
      return this.degraded('no_recipient');
    }
    const target = await this.orchestrator.resolveDirectTarget(creatorUserId);
    if (target === null) {
      // 收件人存在、但此刻**没有任何 deliveryEligible 绑定**（没绑 / 解绑 / 静音 / 未验证）。
      // ⚠️ 这个信封**不进幂等缓存**（per-user 状态会变，见文件头不变量）：用户绑好之后再重放
      //    同一个 key 必须能真的发出去。
      return this.degraded('recipient_not_bound');
    }

    // ⑦ L2 占额（**占额但永不合并**；窗口维度 = 收件人用户，与事件链路共用同一份窗口账）
    const reservation = this.orchestrator.reserveL2ForDirect(creatorUserId);
    if (!reservation.allowed) {
      throw new NotifyRateLimitedException(
        reservation.retryAfterSeconds,
        `The global notification window is exhausted (${settings.globalRateLimit} messages per ` +
          `${settings.globalRateWindowSeconds}s to this recipient), so this direct message was ` +
          `NOT sent. Retry in about ${reservation.retryAfterSeconds} second(s). Do NOT retry ` +
          'immediately; direct messages are never folded into a summary digest, so waiting is ' +
          'the only way this message reaches the recipient. This 429 was NOT recorded against your ' +
          'clientRequestId, so replaying the SAME key after the window is safe.',
      );
    }

    // ⑧ 同步投递（预算 ≤2 次 / ≤10s；agent 客户端有超时保护）
    //    ⚠️ **只走收件人自己绑定的那个渠道**（`target.provider`），不再遍历部署的全部出口：
    //    投递地址是**这个渠道上的地址**（飞书 open_id），把它交给另一个 provider 只会得到一次
    //    必然失败、且会把失败记在那个无关渠道账上的投递（信封两分支同形，失败被记为
    //    `delivery_failed`，指向错的方向）。用户的绑定渠道不在本部署的出口列表里（理论分支：
    //    绑了一个部署没启用的 token）⇒ `no_provider`（同"运维问题"一类）。
    const providerImpl = this.providers.find((candidate) => candidate.key === target.provider);
    if (!providerImpl) return this.degraded('no_provider');

    const rendered = renderDirectNotification(
      displayNameOf(actor),
      dto,
      target.recipientAddress,
      settings.webBaseUrl,
    );
    const channels: string[] = [];
    // 发送前 INFO 对账锚点（与事件链路同款：投递表只落终态，"这次发送是哪一行"靠它对齐）
    this.logger.log(`sending category=direct actorId=${actor.id} channel=${providerImpl.key}`);
    const outcome = await this.orchestrator.sendThroughProvider(providerImpl, rendered, {
      maxAttempts: NOTIFY_DIRECT_MAX_ATTEMPTS,
      budgetMs: NOTIFY_DIRECT_BUDGET_MS,
    });
    await this.deliveryRepo.record({
      channel: providerImpl.key,
      recipient: target.recipientAddress,
      category: NOTIFY_CATEGORY.DIRECT,
      // 直发没有事件源（plan §7.1）：NULL 让"事件触发的通知"在数据面可分辨
      eventId: null,
      title: rendered.title,
      body: rendered.body,
      outcome,
      // 归属列（批 2 棒 B 的四路径之一）：直发的收件人 = 调用 agent 的 owner
      recipientUserId: creatorUserId,
    });
    // 与事件链路**共用**同一个失败计数（连续 N 条 failed ⇒ 一行周期 warn）——直发链路的失败
    // 同样不能只躺在投递表里等人去查（fail-open 的补偿观测点，plan §3）
    this.orchestrator.noteDeliveryOutcome(outcome.status, NOTIFY_CATEGORY.DIRECT);
    // switch 而非 `outcome.status === 'success'`：本仓 ESLint 规则 no-magic-string-compare
    // 禁止字面量比较（先例 notify-orchestrator.service.ts 的 noteDeliveryOutcome）
    switch (outcome.status) {
      case 'success':
        channels.push(providerImpl.key);
        break;
      default:
        break;
    }

    const envelope: NotifyDirectEnvelope =
      channels.length > 0
        ? { delivered: 1, channels }
        : // 出口调用失败 ⇒ 明确的 delivery_failed（**换新键**才真重跑，见 controller 文案）
          { delivered: 0, channels: [], reason: 'delivery_failed' };

    // ⑨ 回填幂等表（**仅"已经发生过的投递结论"**；判据 = `shouldCacheDirectEnvelope`）
    if (dto.clientRequestId && shouldCacheDirectEnvelope(envelope)) {
      this.idempotencySet(idempotencyKey, { fingerprint, envelope });
    }
    return envelope;
  }

  // ─────────────────────────────── 内部：节流 ───────────────────────────────

  /**
   * 消费一次直发入口额度（per-agent 滑动窗口）。
   *
   * @param actor 调用者（窗口维度 = `type:id`，与经验库录入配额同口径）
   * @returns 超限时的建议等待秒数；未超限返回 null（并已记账）
   */
  private consumeDirectBudget(actor: UnifiedActor): number | null {
    const settings = this.settings;
    const windowMs = settings.directRateWindowSeconds * 1000;
    const key = actor.type + ':' + actor.id;
    const now = Date.now();
    const windowStart = now - windowMs;
    const hits = (this.directHits.get(key) ?? []).filter((at) => at > windowStart);

    if (hits.length >= settings.directRateLimitPerWindow) {
      // 未记账：超限的这次调用**不推进窗口**（否则持续重试会永远把自己锁在外面）
      this.directHits.set(key, hits);
      return Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    }
    hits.push(now);
    this.directHits.set(key, hits);
    return null;
  }

  // ─────────────────────────────── 内部：降级信封 ───────────────────────────────

  /**
   * 构造一个降级信封（**两分支同形**：`channels` 恒在，只是为空）。
   *
   * @param reason 降级原因（八值之一）
   */
  private degraded(reason: NotifyDirectReason): NotifyDirectEnvelope {
    this.logger.log(`direct degraded [${reason}]`);
    return { delivered: 0, channels: [], reason };
  }
}

/**
 * 这个 200 信封该不该进幂等缓存（**纯函数**：判据与值域一起被单测钉住，单源 = 常量文件）。
 *
 * 判据 = "这是一次**已经发生过的投递结论**吗"：
 * - **进**：成功（无 `reason`）/ `delivery_failed`（确认发失败 ⇒ 重放同一键=同一结论；要真重跑
 *   必须换新键，见 controller 的两种重试语义）/ `self_echo`（身份事实，重启前不会变）；
 * - **不进**：**五个**"配置/状态类"降级（`notify_disabled` / `category_disabled` / `no_provider` /
 *   `no_recipient` / **`recipient_not_bound`**）——它们描述的是"**此刻**的状态"（见
 *   {@link NOTIFY_DIRECT_CACHEABLE_REASONS}）。`recipient_not_bound` 尤其：它是**per-user**
 *   的事实，用户绑好渠道之后，同一个 `clientRequestId` 重放必须能真的发出去。
 * - **不进**：`rate_limited`（本就不产 200 信封，它是 429 的占位值 ⇒ 走 default 分支）。
 *
 * @param envelope 已产出的信封
 * @returns true = 可以进幂等缓存
 */
export function shouldCacheDirectEnvelope(envelope: NotifyDirectEnvelope): boolean {
  // 成功分支：成功时**没有 reason 字段**（不是 reason: null）
  if (envelope.reason === undefined) return true;
  return NOTIFY_DIRECT_CACHEABLE_REASONS.includes(envelope.reason);
}

/**
 * 幂等指纹（`text` + `link`；**不含 clientRequestId 本身**——那是键，不是载荷）。
 *
 * 用 `\u0000` 作分隔符：正文里不可能出现 NUL（JSON 字符串可以有 `\u0000`，但 agent 的
 * 消息正文不可能带它），故不会出现"text="a\0b" / link="c"" 与 "text="a" / link="b\0c""
 * 撞成同一指纹的边界。
 */
export function fingerprintOf(dto: Pick<SendNotificationMessageDto, 'text' | 'link'>): string {
  return dto.text + '\u0000' + (dto.link ?? '');
}

/**
 * 调用者的展示名（出境到 `[<name>]` 前缀）。
 *
 * 缺名时回落 actor id：**不伪造**（"unknown agent" 之类的兜底词会让人以为是某个真实实体）。
 */
export function displayNameOf(actor: UnifiedActor): string {
  const name = actor.name?.trim();
  return name && name.length > 0 ? name : actor.id;
}

/**
 * 渲染一条直发通知（**纯函数**：出境面在这里成形，单测直接断言）。
 *
 * 出境面三条（与 config 的 `NOTIFY_EGRESS_FIELDS` 声明逐项对齐）：
 * ① `title` = `[<agent 显示名>]` —— **只放这一个短标签**，理由：飞书文本消息 =
 *    `title` 换行 `body` 换行 `link`（见 feishu provider 的 `buildMessageText`）。若把正文
 *    也塞进 title（像事件链路的 `[完工] <任务标题>`），同一条正文会在消息里**出现两次**；
 *    若把正文截断进 title，手机上看不到完整消息。故：title 承载"谁发的"，body 承载全文。
 *    代价（显式接受）：admin 列表的 title 列只有发送者、没有内容预览——正文就在**同一行的
 *    `body` 列**里，审计不受影响。
 * ② `body` = agent 自填正文（≤2000，DTO 已保证）
 * ③ `link` = `NOTIFY_WEB_BASE_URL` + 相对路径（**服务端拼**：agent 不掌握 web 基址；
 *    未配基址 ⇒ null，不伪造相对链接——手机点不开相对链接，那是"最后一厘米"失效）
 *
 * @param actorName 调用者展示名（见 {@link displayNameOf}）
 * @param dto 请求体（link 已通过白名单校验）
 * @param recipient 收件人（config 的单收件人 open_id）
 * @param webBaseUrl 深链基址（未配置 null）
 * @returns 成品通知（出境面）
 */
export function renderDirectNotification(
  actorName: string,
  dto: Pick<SendNotificationMessageDto, 'text' | 'link'>,
  recipient: string,
  webBaseUrl: string | null,
): RenderedNotification {
  const label = `[${actorName}]`;
  return {
    category: NOTIFY_CATEGORY.DIRECT,
    eventId: null,
    title:
      label.length > NOTIFY_DIRECT_TITLE_MAX_LENGTH
        ? label.slice(0, NOTIFY_DIRECT_TITLE_MAX_LENGTH)
        : label,
    body: dto.text,
    link: dto.link && webBaseUrl ? `${webBaseUrl}${dto.link}` : null,
    recipient,
  };
}
