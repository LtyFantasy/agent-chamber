/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块的**唯一 HTTP 面**，两个端点：
 *     ① `POST /api/v1/notifications/messages` —— agent 直发（给 Owner 发一条私聊）；
 *     ② `GET  /api/v1/notifications/deliveries` —— admin 只读投递记录列表。
 *     两者的**消费方完全不同**（agent vs 运维），故守卫组合按方法声明（不是类级）。
 *
 * [代码职责]
 *   - 直发端点：DTO 校验（`SendNotificationMessageDto`）→ 身份投影（`@CurrentActor()`）→
 *     交给 `NotifyDirectService` → 信封原样返回（200）；**唯一属于 controller 的逻辑是
 *     `Retry-After` 头的设置**（见 [关键不变量]）
 *   - admin 列表端点：`JwtAuthGuard + RolesGuard + @Roles(ADMIN)` → `NotifyDeliveryRepository.findAll`
 *   - `@ApiOperation` 的 description **就是 automcp 生成的 MCP 工具说明**（agent 读到的
 *     "这个工具怎么用"全在这里）：用途边界 / 200≠送达 / reason 八值的下一步 / 限流数字与
 *     Retry-After / **收件人 = 你自己的 creator（不是部署级固定的某个人）** / 本部署可能未启用 /
 *     审批安全阀不推送 / 两种重试语义。
 *     改行为不改这段文案 = agent 拿到过时的用法说明（比没有说明更糟）
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §7.1（直发端点全契约）/
 *     §7.2（admin 列表）/ §7.3（MCP 暴露：只暴露直发，列表不进 agent 面）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/api-definition.md`
 *     （两端点 + `/webhooks` 与 `/notifications` 的关系声明）；落点后本定位符改为线上文档。
 *
 * [关键不变量]
 *   - **`Retry-After` 头必须在 controller 显式设置**：429 的三件套 =（HTTP 码 + `code`）+
 *     头 + `data.retryAfterSeconds`。前两者在 `NotifyRateLimitedException` 里，`data` 也
 *     在里面；**只有头需要 Response 对象**，而全局异常过滤器（`all-exceptions.filter.ts`）
 *     只写 body、**从不 setHeader**（全仓零先例）。故这里 `@Res({ passthrough: true })` +
 *     `res.setHeader('Retry-After', ...)` 必须在 `throw` 之前执行——头在响应对象上，
 *     之后过滤器写 body 时它原样保留。**抽掉这段 = 头静默消失**，客户端只能从 body 里刮。
 *   - **`@HttpCode(200)` 不可省**：Nest 对 `@Post` 缺省返回 **201**，而本端点是"动作型"语义
 *     （发送/不发送，没有创建出新资源——幂等重放也不会创建任何东西），且客户端按 200 判
 *     "请求已被处理"。缺了它，agent 侧按 201 分支写的判断会与实际不符。
 *   - **守卫按方法声明、不按类声明**：类级 `@UseGuards` 会让两个端点共用一套鉴权，而直发
 *     走 `JwtOrApiKeyGuard`（agent 用 API Key）、列表走 `JwtAuthGuard + RolesGuard`
 *     （只认人类 admin）——共用的结果是二者之一必然错（webhook 的历史教训 B-50 就是类级
 *     守卫漏了角色过滤）。
 *   - **`@Roles(UserRole.ADMIN)` 与 `RolesGuard` 必须成对出现**：`@Roles` 只是元数据，
 *     少了 guard 就是"写了一个没人读的装饰器"，任何登录用户都能拉全平台投递记录。
 *   - **直发端点的人类调用者是合法的**（`JwtOrApiKeyGuard` 双分支）：人类**给自己**发，
 *     会被自回声降级成 `self_echo`——这是"人不通知自己"的兜底，不是 bug。
 *     ⚠️ **agent 调用者永远不会被自回声吞掉**（哪怕它是自己 owner 名下的 agent）：本端点的
 *     收件人就是它的 owner，套用事件链路的"我的 agent"泛化会让这个端点对 agent 完全失效
 *     （见 notify-direct.service.ts 的 [关键不变量]）。
 *   - **`@CurrentActor()` 可能为 null**（守卫放行但身份投影缺字段的畸形请求）：必须挡住，
 *     否则下游会拿一个 `undefined.id` 去查/去判（静默失败——症状是"消息发给了谁也说不清"）。
 *
 * [关联代码]
 *   - notify-direct.service.ts — 直发九步管线（本文件只做校验/身份/头）
 *   - notify-delivery.repository.ts — admin 列表的读入口（分页与过滤都在那边）
 *   - dto/send-notification-message.dto.ts / dto/query-notification-deliveries.dto.ts — 请求契约
 *   - ../../common/guards/jwt-or-api-key.guard.ts — 双身份守卫（agent API Key + 人类 JWT）
 *   - ../../common/decorators/current-actor.decorator.ts — 统一身份投影（形状单源在 common/utils/actor.ts）
 *   - ../../common/filters/all-exceptions.filter.ts — 429/409 的 body 成形处（**无 setHeader**）
 *   - notifications.module.ts — 本 controller 的装配点
 *
 * [持久踩坑]
 *   NOTIFY-DIRECT-RETRY-AFTER-LOST(429 头静默丢失): 只在异常里带 `data.retryAfterSeconds`
 *     是不够的——HTTP 客户端与 SDK 普遍优先读 `Retry-After` 头做退避。过滤器不会 setHeader，
 *     所以头必须在 controller 里 throw 之前设置。安全方向: 见 [关键不变量] 第一条 + 单测
 *     专门断言头存在。
 *   NOTIFY-DIRECT-POST-DEFAULT-201(缺 @HttpCode): Nest 的 POST 缺省 201，与"动作型端点"
 *     的语义及客户端判断不符。安全方向: `@HttpCode(200)` + 单测断言（201 会红）。
 *
 * [铁律关联] #11(注释强制) #9(代理层透传：429 不得包装成 500) #21(双层校验) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改直发行为必须同步 `@ApiOperation` 的 description（它就是 agent 看到的说明书）
 *   □ 改守卫/角色必须同步 spec 的鉴权矩阵（403 用例会红）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ErrorCode, UserRole } from '@agent-chamber/shared';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import type { UnifiedActor } from '../../common/types/actor.types';
import { SendNotificationMessageDto } from './dto/send-notification-message.dto';
import { QueryNotificationDeliveriesDto } from './dto/query-notification-deliveries.dto';
import {
  NotifyDirectService,
  NotifyRateLimitedException,
  type NotifyDirectEnvelope,
} from './notify-direct.service';
import { NotifyDeliveryRepository } from './notify-delivery.repository';

/** Notifications 模块 HTTP 面（两个端点的消费方完全不同，故守卫按方法声明） */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly directService: NotifyDirectService,
    private readonly deliveryRepo: NotifyDeliveryRepository,
  ) {}

  /**
   * agent 直发一条私聊给 Owner（`POST /api/v1/notifications/messages`）。
   *
   * 身份可以是 API Key（agent）或 JWT（人类 = Owner 本人，会被自回声降级）。
   */
  @Post('messages')
  @UseGuards(JwtOrApiKeyGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a private IM message to your creator (the human who owns you)',
    description:
      "Send one message to YOUR CREATOR — the human who owns you — over that human's configured " +
      'private IM channel (Feishu). Use it ONLY when your creator must personally notice ' +
      'something — it is NOT a progress log: report routine progress through tasks and topic ' +
      'messages. The recipient is YOUR OWNER: there is no recipient parameter, you cannot message ' +
      'anybody else, and the delivered message is prefixed with "[<your agent name>]" so the ' +
      'recipient sees who is asking. The message only goes out if that human has bound (and ' +
      'verified) a notification channel in Settings → Notifications. ' +
      'HTTP 200 means "the request was processed", NOT "the message arrived": read `delivered` ' +
      '(1 = at least one channel confirmed delivery, 0 = not delivered) and, when delivered=0, ' +
      '`reason` — eight closed values, each with a different next step: ' +
      '(1) notify_disabled — notifications are turned off in this deployment ' +
      '(NOTIFY_ENABLED=false): report inside the platform instead (task comment / topic message); ' +
      '(2) recipient_not_bound — your creator has no verified notification channel yet: tell your ' +
      'creator to open Settings → Notifications and bind one (do NOT retry — retrying will not ' +
      'make a channel appear, but the idempotency key is NOT poisoned by this answer, so a retry ' +
      'AFTER your creator binds will really send); (3) no_provider / no_recipient — an operator ' +
      'problem (no IM channel configured, or your credential carries no resolvable creator): ' +
      'report inside the platform and tell the Owner; (4) delivery_failed — the channel was called ' +
      'and rejected or timed out: retry ONCE with a NEW clientRequestId, after backing off; ' +
      '(5) category_disabled — the operator turned the "direct" category off: ask them to add it ' +
      'to NOTIFY_CATEGORIES; (6) self_echo — you ARE the recipient (a human calling on their own ' +
      'behalf): nothing to do; (7) rate_limited — reserved for an in-envelope degradation (a real ' +
      'window overrun returns HTTP 429 instead). ' +
      '`channels` lists the channels that actually delivered (empty when delivered=0). ' +
      'Rate limits, both per actor and in-memory (they reset when the backend restarts): an ' +
      'entry gate of NOTIFY_DIRECT_RATE_LIMIT_PER_WINDOW messages per ' +
      'NOTIFY_DIRECT_RATE_WINDOW_SECONDS (defaults 6 per 600s), plus the shared per-recipient ' +
      'window of NOTIFY_GLOBAL_RATE_LIMIT per NOTIFY_GLOBAL_RATE_WINDOW_SECONDS (defaults 5 per ' +
      '600s). Direct messages occupy that window but are NEVER folded into the suppression ' +
      'digest — waiting is the only way they get through. Exceeding either limit returns HTTP ' +
      '429 with code 429, a Retry-After header (seconds) and data.retryAfterSeconds: wait that ' +
      'long, do NOT retry immediately. A 429 is NOT recorded against your clientRequestId, so ' +
      'replaying the SAME key after the window is safe. ' +
      'TWO retry semantics, do not confuse them: (a) transport outcome unknown (your client ' +
      'timed out, no reply) → replay with the SAME clientRequestId and the FIRST envelope comes ' +
      'back without sending a second time; (b) a confirmed delivered=0/reason=delivery_failed is ' +
      'already final, so replaying the same key just replays that failure — use a NEW ' +
      'clientRequestId (after backing off) to actually send again. The same key with a different ' +
      'text/link is refused with HTTP 409/code 9002. ' +
      'This deployment may have notifications disabled entirely: then every call returns ' +
      'delivered=0/reason=notify_disabled. APPROVALS AND SAFETY VALVES: roundtable approval ' +
      'requests and safety-valve trips are NOT pushed yet (a future roundtable batch — the ' +
      'platform currently cannot notify you about them at all), and an agent PARKED waiting for ' +
      'an approval cannot call this endpoint at all (its process is blocked on the reverse RPC). ' +
      'Do not expect this endpoint to substitute for approval notifications.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Always 200 once the request was accepted: { delivered: 0|1, channels: string[], reason?: ' +
      'string }. delivered=1 means at least one channel confirmed delivery; delivered=0 carries ' +
      'a `reason` (see the tool description) — 200 does NOT mean the Owner received anything.',
  })
  @ApiResponse({
    status: 400,
    // ⚠️ 码是 **400**（= `ErrorCode.BAD_REQUEST`，由全局异常过滤器按 HTTP 状态映射），**不是
    // 9000**：main.ts 用的是裸 `ValidationPipe`（无自定义 exceptionFactory）。9000
    // （VALIDATION_ERROR）是**业务**校验码，只在手写 throw 的场景出现——标在 DTO 校验这条路上
    // 会让调用方去等一个永远不会出现的 9000。
    description:
      '400 — validation failed: text must be 1-2000 characters, and link (when given) must be a ' +
      'platform-relative path under /tasks/, /topics/, /docs/, /boards/ or /experiences/ with no ' +
      'whitespace and no percent-encoded control characters — absolute URLs are rejected.',
  })
  @ApiResponse({ status: 401, description: '401 — missing or invalid credentials' })
  @ApiResponse({
    status: 409,
    description:
      '9002 — IDEMPOTENCY_KEY_CONFLICT: this clientRequestId was already used with a different ' +
      'text/link. Resend the original text/link to get the first envelope, or use a new key.',
  })
  @ApiResponse({
    status: 429,
    description:
      '429 — RATE_LIMITED: the per-actor entry gate or the shared global window is exhausted. ' +
      'Carries a Retry-After header and data.retryAfterSeconds; the call had no effect and the ' +
      'key was not recorded.',
  })
  async sendMessage(
    @Body() dto: SendNotificationMessageDto,
    @CurrentActor() actor: UnifiedActor | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NotifyDirectEnvelope> {
    if (!actor) {
      // 守卫放行但身份投影为空 = 畸形请求（缺 userId/agent.id）：挡住，不要让下游拿
      // `undefined.id` 去做 owner 判定（见文件头 [关键不变量]）
      throw new UnauthorizedException({
        message: 'Authenticated but no usable actor identity was found on the request',
        code: ErrorCode.UNAUTHORIZED,
      });
    }

    try {
      return await this.directService.send(actor, dto);
    } catch (err) {
      // 429 三件套的**头**：过滤器不 setHeader（全仓零先例），故必须在 throw 之前显式设置。
      // 头留在响应对象上，之后过滤器写 body 时原样保留——见文件头 [关键不变量] 第一条。
      if (err instanceof NotifyRateLimitedException) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
      }
      throw err;
    }
  }

  /**
   * 投递记录列表（`GET /api/v1/notifications/deliveries`；只读，admin 专属）。
   *
   * ⚠️ 本表**只有终态行**：自回声 / 类别关 / 节流命中的抑制类事件根本不落表（见实体文件头）
   * ——"表里没有" ≠ "通知没发生过"，排障要靠 INFO 日志（`grep "suppressed \["`）。
   */
  @Get('deliveries')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'List notification delivery records',
    description:
      'Admin-only, paginated read-only view of every notification delivery attempt that reached ' +
      'a channel, newest first. Each row is a TERMINAL state (status is success or failed; ' +
      'attempts >= 1) written after the provider answered — there is no pending row. IMPORTANT ' +
      'BOUNDARY: suppressed notifications are NOT in this table at all (self-echo, ' +
      'category-disabled, L1 throttling and rate-window suppression only produce log lines), so ' +
      '"no row here" does NOT mean "no notification happened". Troubleshoot with the backend ' +
      'logs (`grep "suppressed \\["`, `grep "sending category="`) before concluding anything. ' +
      'category accepts the switchable categories plus "digest" (the rate-window suppression ' +
      'summary, which is not a switchable category); status accepts success|failed. ' +
      'Response envelope: { items, total, page, pageSize, totalPages, hasNext, hasPrev }.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Paginated delivery records (items/total/page/pageSize/totalPages/hasNext/hasPrev)',
  })
  @ApiResponse({ status: 401, description: '401 — missing or invalid credentials' })
  @ApiResponse({
    status: 403,
    description: '403 — admin role required (this view spans the whole deployment)',
  })
  async findAll(@Query() query: QueryNotificationDeliveriesDto) {
    return this.deliveryRepo.findAll(query);
  }
}
