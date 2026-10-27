/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **通知设置面**（Notifications 二期）的 HTTP 面，六个**人类 JWT 端点**（不进 agent MCP 面）：
 *     `GET /notification-settings/me`、`PUT|DELETE /notification-settings/me/channels/:provider`、
 *     `POST /notification-settings/me/channels/:provider/test`、`PUT|DELETE /notification-settings/me/prefs`。
 *
 * [代码职责]
 *   - 类级 `JwtAuthGuard`（**六个端点消费方相同**：只有登录人类能改自己的通知设置，故与
 *     notifications.controller.ts 的"按方法声明守卫"不同——这里是正当的类级）；身份取
 *     `@CurrentUser('userId')`
 *   - `:provider` 走 `ProviderTokenParamPipe`（值域单源 = `NOTIFY_PROVIDER_TOKENS`）
 *   - test 端点的 429 三件套里的**头**（`Retry-After`）在本文件显式设置——与直发端点同因
 *     （全局异常过滤器从不 setHeader，见 notifications.controller.ts 的详细踩坑）
 *
 * [权威文档]
 *   - 主文档: 线上 `docs/api-definition.md` §20.3（六端点全契约 + 前端消费形状）
 *
 * [关键不变量]
 *   - **类级 `@UseGuards(JwtAuthGuard)` 在此是正确的**：六个端点共享同一身份模型（登录人类改自己
 *     的设置）。⚠️ 判据是"消费方是否相同"，不是"类级守卫本身好不好"——notifications.controller.ts
 *     的两个端点消费方完全不同（agent vs admin），那里才必须按方法声明。
 *   - **`@CurrentUser('userId')` 是 JWT 载荷的 userId**（`JwtAuthGuard` 写入 `request.user`），
 *     与 `@CurrentActor()`（统一身份投影）不同：本面**只服务人类**，不需要 agent 分支。
 *   - **`Retry-After` 头必须在 controller 里 throw 之前设置**：过滤器只写 body、无 setHeader 先例。
 *   - **DELETE 返回 200 + `{deleted:true}`**：Nest 对 DELETE 缺省 200（不是 204）；显式回 body 让
 *     前端能确认（与解绑/恢复默认两条 DELETE 一致）。**404 走异常**（从未绑定 / 已解绑）。
 *   - **端点路径不含资源 id**：渠道/偏好都是"当前登录用户的"，`me` 段即自我指涉（越权面为零）。
 *
 * [关联代码]
 *   - notification-settings.service.ts — 六端点的服务侧（本文件只做校验/身份/头）
 *   - dto/notification-settings.dto.ts — 请求契约 + `:provider` 管道
 *   - notify-direct.service.ts — `NotifyRateLimitedException` / `NotifyDirectEnvelope`（信封与 429 契约单源）
 * =============================================================================
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  NotificationSettingsService,
  type NotificationChannelView,
  type NotificationSettingsView,
} from './notification-settings.service';
import {
  ProviderTokenParamPipe,
  UpdateChannelDto,
  UpdatePrefsDto,
} from './dto/notification-settings.dto';
import type { NotifyProviderToken } from '../../config/notifications.config';
import { NotifyRateLimitedException, type NotifyDirectEnvelope } from './notify-direct.service';
import type { NotificationCategoryPrefs } from './dto/notification-settings.dto';

/** 删除类端点的统一应答体（解绑渠道 / 恢复默认偏好共用） */
export interface NotificationSettingsDeleted {
  /** 恒为 true（失败走异常，不会返回本对象） */
  deleted: true;
}

/**
 * 通知设置面 HTTP controller（六个 JWT 人类端点；见文件头不变量关于类级守卫的判据）。
 */
@ApiTags('Notification Settings')
@UseGuards(JwtAuthGuard)
@Controller('notification-settings')
export class NotificationSettingsController {
  constructor(private readonly settingsService: NotificationSettingsService) {}

  /**
   * 读取当前用户的通知设置（渠道 / 偏好 / 平台能力）。
   */
  @Get('me')
  @ApiOperation({
    summary: 'Get my notification settings',
    description:
      'Everything the notification settings UI needs, for the CURRENT user only (no id in the ' +
      'path). `channels` lists active bindings (unbound/tombstoned rows are hidden — they only ' +
      'exist to stop the deployment-env seeding from re-binding a channel the user removed). ' +
      '`prefs.categories` is the normalized per-user override (whitelisted keys, strictly ' +
      'boolean); `prefs.defaults` is the deployment default set; `prefs.relevantScopes` counts ' +
      'the topics/boards/spaces this user is a participant/member/creator of — it describes ' +
      'WHERE scope-based notifications would come from, NOT whether you will receive them. ' +
      '`platform.providers[].configured` is a boolean only (no credentials are ever returned); ' +
      '`configured=false` means the deployment has no working app credentials, so the channel ' +
      'form should be disabled.',
  })
  @ApiResponse({ status: 200, description: 'Notification settings for the current user' })
  @ApiResponse({ status: 401, description: '401 — missing or invalid credentials' })
  async getMe(@CurrentUser('userId') userId: string): Promise<NotificationSettingsView> {
    return this.settingsService.getMe(userId);
  }

  /**
   * upsert 一个渠道绑定（地址可省 = 仅改状态）。
   */
  @Put('me/channels/:provider')
  @ApiOperation({
    summary: 'Bind or update one notification channel',
    description:
      "Upsert the CURRENT user's binding for a provider. Send `recipientOpenId` to set/change " +
      "the address: changing it RESETS verification (the old address's test result must not " +
      'vouch for a new address) and revives a previously unbound row. Omit it to keep the ' +
      'current address (e.g. to just mute). `enabled=true` is REFUSED (400) unless the CURRENT ' +
      'address already has a successful test (or was seeded from deployment config) — an ' +
      'unverified address would silently never receive anything. `enabled=false` mutes while ' +
      'keeping the verification state. Binding an address already verified by ANOTHER account ' +
      'returns 409.',
  })
  @ApiResponse({ status: 200, description: 'The updated channel (same shape as `channels[]`)' })
  @ApiResponse({
    status: 400,
    description:
      '400 — no address given for a first-time binding, or `enabled=true` on an unverified address',
  })
  @ApiResponse({ status: 401, description: '401 — missing or invalid credentials' })
  @ApiResponse({
    status: 404,
    description: '404 — unknown provider token (:provider is validated against the known list)',
  })
  @ApiResponse({
    status: 409,
    description: '409 — this address is already verified and bound to another platform account',
  })
  async upsertChannel(
    @CurrentUser('userId') userId: string,
    @Param('provider', ProviderTokenParamPipe) provider: NotifyProviderToken,
    @Body() dto: UpdateChannelDto,
  ): Promise<NotificationChannelView> {
    return this.settingsService.upsertChannel(userId, provider, dto);
  }

  /**
   * 解绑一个渠道（tombstone；从未绑定或已解绑 ⇒ 404）。
   */
  @Delete('me/channels/:provider')
  @ApiOperation({
    summary: 'Unbind one notification channel',
    description:
      'Stops notifications for this channel IMMEDIATELY. The row is tombstoned (not deleted) so ' +
      'the deployment-config seeding will never silently re-bind it — re-binding the same ' +
      'address later keeps the previous verification state. Returns 404 when there is no active ' +
      'binding (never bound, or already unbound) — an unbound channel is invisible, so ' +
      '"already unbound" and "never bound" are the same thing to you.',
  })
  @ApiResponse({ status: 200, description: '{ deleted: true }' })
  @ApiResponse({ status: 401, description: '401 — missing or invalid credentials' })
  @ApiResponse({ status: 404, description: '404 — no active binding for this provider' })
  async deleteChannel(
    @CurrentUser('userId') userId: string,
    @Param('provider', ProviderTokenParamPipe) provider: NotifyProviderToken,
  ): Promise<NotificationSettingsDeleted> {
    await this.settingsService.deleteChannel(userId, provider);
    return { deleted: true };
  }

  /**
   * 发送一条测试消息（验证渠道；429 三件套含 `Retry-After` 头）。
   */
  @Post('me/channels/:provider/test')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a test message to my channel',
    description:
      "Sends one real message to the CURRENT user's bound address so they can verify the " +
      'channel actually works. A successful test marks the channel verified and turns it ON ' +
      '(so the next notifications are delivered); a delivery failure is recorded on the channel ' +
      'as a failed verification. Operator-side problems (notifications disabled, no provider ' +
      'configured) are reported as `{delivered:0, reason}` WITHOUT touching your verification ' +
      "state — they are the deployment's current status, not a verdict on your address. There " +
      'is no binding (or it was unbound): 404 with no envelope. Rate limited per user (3 per ' +
      '60s) and by the deployment-wide egress window: both return 429 with a Retry-After ' +
      'header, and neither has any effect.',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ delivered: 0|1, channels: string[], reason?: string } — same envelope as direct messages',
  })
  @ApiResponse({ status: 401, description: '401 — missing or invalid credentials' })
  @ApiResponse({ status: 404, description: '404 — no active binding for this provider' })
  @ApiResponse({
    status: 409,
    description: '409 — the test succeeded but this address is already verified by another account',
  })
  @ApiResponse({
    status: 429,
    description:
      '429 — RATE_LIMITED: per-user test gate (3 per 60s) or the deployment-wide egress window. ' +
      'Carries a Retry-After header and data.retryAfterSeconds; nothing was sent.',
  })
  async testChannel(
    @CurrentUser('userId') userId: string,
    @Param('provider', ProviderTokenParamPipe) provider: NotifyProviderToken,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NotifyDirectEnvelope> {
    try {
      return await this.settingsService.testChannel(userId, provider);
    } catch (err) {
      // 429 三件套的**头**：过滤器不 setHeader（全仓零先例），必须在 throw 之前显式设置
      if (err instanceof NotifyRateLimitedException) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
      }
      throw err;
    }
  }

  /**
   * 稀疏覆盖通知类别偏好（原子键级合并）。
   */
  @Put('me/prefs')
  @ApiOperation({
    summary: 'Update my notification category preferences',
    description:
      'Sparse per-key override: only the keys you send are changed (`{"notificationCategories":' +
      '{"task_done": false}}` turns off just that category). Unknown keys and non-boolean values ' +
      'are rejected with 400 rather than silently ignored. The merge is atomic (key-level), so ' +
      "concurrent updates cannot lose each other's keys. Returns the FULL normalized map.",
  })
  @ApiResponse({ status: 200, description: 'The full normalized category map (all keys present)' })
  @ApiResponse({
    status: 400,
    description: '400 — keys must be known categories and values must be booleans',
  })
  @ApiResponse({ status: 401, description: '401 — missing or invalid credentials' })
  async updatePrefs(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdatePrefsDto,
  ): Promise<NotificationCategoryPrefs> {
    return this.settingsService.updatePrefs(userId, dto);
  }

  /**
   * 恢复默认通知偏好（键级删除，不动其余偏好）。
   */
  @Delete('me/prefs')
  @ApiOperation({
    summary: 'Reset my notification category preferences to the deployment default',
    description:
      'Removes ONLY the notificationCategories key (your other preferences are untouched), so ' +
      'the effective categories fall back to the deployment default set. Returns the normalized ' +
      'map (which is now the default set).',
  })
  @ApiResponse({ status: 200, description: 'The normalized category map (now the default set)' })
  @ApiResponse({ status: 401, description: '401 — missing or invalid credentials' })
  async deletePrefs(@CurrentUser('userId') userId: string): Promise<NotificationCategoryPrefs> {
    return this.settingsService.deletePrefs(userId);
  }
}
