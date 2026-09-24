/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）REST 面：12 端点（条目 8：录入 / 列表检索 / 分面 / 详情 /
 *     反馈 / 编辑 / 质量终审 / 软删；成员 4：列表 / 授权 / 改角色 / 夺权）
 *
 * [代码职责]
 *   - 路由声明 + **逐端点守卫布局** + 参数形态守卫（括号数组参数）+ 把 service 结果
 *     原样交给全局 ResponseInterceptor 包装
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base-p2.md §2.2（端点表 / 守卫布局 / 成员三端点闸门）
 *   - 补充: .kimi/plans/plan-experience-base.md §3（第一期 8 端点契约）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章（端点与序列化协议）
 *
 * [关键不变量]
 *   1. **类级不挂任何 guard**，全部方法级声明（audit.controller 血泪教训）：全局
 *      `APP_GUARD JwtAuthGuard` 已对**未声明守卫**的端点兜底鉴权，但"类级挂 guard"会让
 *      后来新增的端点**静默继承**一个不属于它的守卫组合。方法级声明让每个端点的
 *      鉴权可被 `Reflect` 逐条断言（controller spec 就靠这一点）
 *   2. **`GET /experiences/facets` 与 `GET/POST /experiences/members` 必须声明在
 *      `GET/POST/PATCH/DELETE /experiences/:id*` 之前**：Express 按声明顺序匹配，
 *      反过来会让字面量段被当成 `:id` 值 → 撞 ParseUUIDPipe 400（单测以路由顺序断言钉住）
 *   3. **终审端点是 `JwtOrApiKeyGuard` + service 内判权**（第二期改造）：旧三元组
 *      `JwtAuthGuard + RolesGuard + @Roles(ADMIN)` 已拆除——它对 agent 硬抛 1009，
 *      而"人类 admin 专属"的语义已不成立（admin ｜ 空间 owner/reviewer）。
 *      权限判定的**唯一收口** = `ExperienceMemberService.assertCanReview`（403/13004 缺角色）；
 *      **自 v1.81.0 起禁自审四态退役，故 403/13002 不再存在**——controller 不复制任何权限逻辑
 *   4. **数组参数只认重复 query 参数**：`signals[]=` 必须在进入 DTO 前被拒
 *      （`assertNoBracketedArrayQuery`，见 experience-query-form.ts 的 qs 归一踩坑）
 *   5. 所有 `:id` / `:actorId` 走 `ParseUUIDPipe`（格式错误不过业务层）；排序/过滤参数
 *      `@IsIn` 白名单（DTO 承担）⇒ **ORDER BY 无任何用户输入拼接**
 *   6. **本批不进全局 /search、不发 events/SSE、不扩 ResourceType/EventType**：本 controller
 *      不注入 EventEmitter/SseService，也不在 SearchModule 里注册（plan §3 末段决策）
 *   7. **四个新端点带完整 Swagger 契约文本**（full profile 原子工具的 description 唯一来源
 *      是 OpenAPI——错误码 + 该做什么，plan §2.2 末段）
 *
 * [关联代码]
 *   - experience.service.ts — 条目业务规则与写读判权调用点（本 controller 不含业务判断）
 *   - experience-member.service.ts — 成员四端点的业务与闸门（admin/owner 双约束、denied 审计）
 *   - experience-query-form.ts — 括号数组形态守卫（findAll 专用）
 *   - dto/index.ts — 请求 DTO 与值域
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增端点必须**方法级**声明守卫（禁搬到类级）
 *   □ facets/:id、members/:id* 的声明顺序不得调换（有单测钉住）
 *   □ 改守卫布局必须同步 controller spec 的 Reflect 断言与真实 guard 用例
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type {
  ExperienceDetail,
  ExperienceFacetsResponse,
  ExperienceFeedbackResponse,
  ExperienceJudgmentsResponse,
  ExperienceListResponse,
  ExperienceMemberDto,
  ExperienceMembersResponse,
  ExperienceQualityReviewResponse,
  RecordExperienceResponse,
} from '@agent-chamber/shared';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import type { UnifiedActor } from '../../common/types/actor.types';
import { ExperienceService } from './experience.service';
import { ExperienceMemberService } from './experience-member.service';
import { ExperienceJudgmentService } from './experience-judgment.service';
import { assertNoBracketedArrayQuery } from './experience-query-form';
import {
  AddExperienceMemberDto,
  CreateExperienceDto,
  QueryExperienceDto,
  QueryJudgmentDto,
  ReportExperienceFeedbackDto,
  ReviewExperienceQualityDto,
  UpdateExperienceDto,
  UpdateExperienceMemberRoleDto,
} from './dto';

/**
 * 经验库 REST 控制器。
 *
 * 认证：**全部端点**用 `JwtOrApiKeyGuard`（人类 JWT 或 Agent API Key 双通道）——第二期
 * 起终审不再是"人类 admin 专属端点"，而是"任何认证身份都可调、由 service 判定角色
 * （admin 或空间 owner/reviewer）"，故守卫与其它端点同形；权限判定的差异全部落在 service。
 */
@ApiTags('Experiences')
@ApiBearerAuth()
@ApiHeader({
  name: 'X-API-Key',
  required: false,
  description: 'Agent authentication (alternative to Bearer JWT)',
})
@Controller('experiences')
export class ExperienceController {
  constructor(
    private readonly experienceService: ExperienceService,
    private readonly memberService: ExperienceMemberService,
    private readonly judgmentService: ExperienceJudgmentService,
  ) {}

  /**
   * 录入经验条目（强制 unverified、疑似重复软提示、按 actor 限流、密钥闸门）。
   *
   * 录入者恒取认证身份（DTO 不含 createdBy/quality ⇒ 客户端自传会被 400 拒绝）。
   */
  @Post()
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Record an experience',
    description:
      'Creates an experience entry, always at quality=unverified and immediately searchable (no ' +
      'approval step). Returns soft hints: `possibleDuplicates` (overlapping signals or a similar ' +
      'title — consider reading/updating that entry instead) and `warnings` (e.g. a missing ' +
      '"How verified" section; never blocks the write). Rate limited to 30 entries/hour per actor (429). ' +
      'Content containing credentials (API keys, private keys, `password=`) is rejected with 400 — the ' +
      'experience base is readable by every authenticated actor.',
  })
  @ApiResponse({
    status: 201,
    description: 'Entry created (or the first response replayed on idempotent retry)',
  })
  @ApiResponse({
    status: 400,
    description:
      '9000 — validation failure (bad enum/length, unknown env key, comma in an array element, credential pattern, past expiresAt)',
  })
  @ApiResponse({
    status: 409,
    description: '9002 — the same clientRequestId was used with a different payload',
  })
  @ApiResponse({
    status: 429,
    description: '429 — recording rate limit exceeded; back off and retry later',
  })
  async create(
    @Body() dto: CreateExperienceDto,
    @CurrentActor() actor: UnifiedActor,
  ): Promise<RecordExperienceResponse> {
    return this.experienceService.create(dto, actor);
  }

  /**
   * 列表 + 检索合一（无 q 是列表，有 q 是融合检索）。
   *
   * 零命中返回**成功信封**（`items: []` + `total: 0` + `hint`），不抛 404——冷启动期零命中
   * 是常态，消费方应继续自己解决。
   */
  @Get()
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'List / search experiences',
    description:
      'Filters are ANDed. `signals`/`domains` match ANY overlap on normalized exact strings ' +
      '(sharing at least one element is a hit, so adding values WIDENS the result); the four env ' +
      'params match by exact equality. Pass arrays as REPEATED query parameters ' +
      '(`?signals=a&signals=b`) — comma-joined values and bracketed forms (`signals[]=`) are ' +
      'rejected, not silently accepted. `q` is both a filter and a ranking signal (fused ' +
      'ts_rank + pg_trgm similarity, floored at 0.08) and takes over ordering; without `q` the ' +
      '`sort` parameter applies. Suspect entries are excluded unless you ask for ' +
      '`quality=suspect`; expired entries are excluded unless `includeExpired=true`. ' +
      'Zero hits is a SUCCESS response carrying a `hint`, not an error. ' +
      '`createdById` filters by one recorder (actor UUID, EXACT equality — take it from an ' +
      "item's `createdById`; display names are NOT accepted). Items carry attribution fields " +
      '(`createdByName`/`createdByDeletedAt`/`createdByAvatarUrl`, plus `verifiedByName` when ' +
      'verified): `createdByName` is null ONLY when the actor row is hard-deleted; a non-null ' +
      '`createdByDeletedAt` means a soft-deleted creator whose real name is still in ' +
      '`createdByName` — render the name, never fall back to a bare UUID.',
  })
  @ApiResponse({
    status: 200,
    description:
      'List envelope: items / total / page / pageSize (+ hint when empty), appliedFilters, availableDomains',
  })
  @ApiResponse({
    status: 400,
    description: '9000 — validation failure or bracketed array query syntax',
  })
  @ApiResponse({
    status: 403,
    description:
      '13004 — includeSuspect requires a human admin or an experience space owner/reviewer (see GET /experiences/members)',
  })
  async findAll(
    @Query() query: QueryExperienceDto,
    @CurrentActor() actor: UnifiedActor,
    @Req() req: Request,
  ): Promise<ExperienceListResponse> {
    // 形态守卫必须在 DTO 绑定之前语义位置（Nest 的 pipe 已跑完才进方法体，故此处是
    // "最早可干预点"：DTO 看到的是 qs 归一后的形态，只有原始 URL 还留着方括号）
    assertNoBracketedArrayQuery(req.originalUrl);
    return this.experienceService.search(query, actor);
  }

  /**
   * 分面聚合（计数 + 开放词表回显）。
   *
   * ⚠️ 声明顺序：必须在 `:id` 之前（Express 顺序匹配）——有单测钉住。
   */
  @Get('facets')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Facet counts',
    description:
      'Aggregated counts over the same base query as the list (soft-deleted + expired + suspect ' +
      'excluded), with `byIntent`/`byQuality` always carrying the FULL key set (未命中 = 0) so ' +
      'clients never invent their own defaults. `availableDomains` is the vocabulary echo — the only ' +
      'channel for enumerating the open domain vocabulary. `byCreator` (top ' +
      'EXPERIENCE_BY_CREATOR_LIMIT recorders by count, each carrying createdById/createdByType/' +
      'createdByName/createdByDeletedAt; `byCreatorTruncated` flags the cut) is deliberately NOT ' +
      'key-complete — an open dimension. NOTE: facets applies every list filter you pass, so a ' +
      'request carrying `createdById` collapses `byCreator` to one row; callers wanting the full ' +
      'creator vocabulary call facets with no filters. `viewerIsReviewer` (role-level: can this ' +
      'caller review anything at all) is returned to human admins and space owner/reviewer members; ' +
      '`suspectCount` (the moderation queue size) shares that same gate.',
  })
  @ApiResponse({
    status: 200,
    description:
      'total / byIntent / byQuality / availableDomains / byCreator (+ byCreatorTruncated) / viewerIsReviewer (+ suspectCount for admins and reviewers)',
  })
  @ApiResponse({
    status: 403,
    description:
      '13004 — includeSuspect requires a human admin or an experience space owner/reviewer (see GET /experiences/members)',
  })
  async facets(
    @Query() query: QueryExperienceDto,
    @CurrentActor() actor: UnifiedActor,
    @Req() req: Request,
  ): Promise<ExperienceFacetsResponse> {
    // 与 findAll 同一形态守卫（评审 m1）：facets 也接收 signals/domains，漏挂会让
    // `?signals[]=` 在这里被静默接受（同端点族两种形态口径 = 调用方最容易被坑的那种不一致）
    assertNoBracketedArrayQuery(req.originalUrl);
    return this.experienceService.facets(query, actor);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 空间成员（第二期）——**字面量路由必须声明在 `:id` 之前**（见文件头不变量 2）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 成员列表（任何认证身份可读；`invitedBy` 仅 admin/owner 非空）。
   *
   * 授权透明性取舍（plan §0 明文）：清单全认证可见——"该找谁终审"比藏住名单更重要。
   */
  @Get('members')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'List experience space members',
    description:
      'Members hold the REVIEW right for the experience base: `owner` (space admin — review + ' +
      'manage reviewers) or `reviewer` (review only). Human admins are not listed here: they are ' +
      'global fallbacks who can do everything without a member row. Readable by EVERY authenticated ' +
      'actor (transparency: an agent must be able to find out who can review); `invitedBy` is ' +
      'exposed to admins/owners only. Use this list to answer "who should I hand this entry to" ' +
      'after a 13004 rejection (you lack the role — a grant you are missing, not a permanent bar).',
  })
  @ApiResponse({
    status: 200,
    description:
      'items[] — actorId / actorType / actorName / avatarUrl / deletedAt / role / invitedBy / createdAt',
  })
  async listMembers(@CurrentActor() actor: UnifiedActor): Promise<ExperienceMembersResponse> {
    return this.memberService.listMembers(actor);
  }

  /**
   * 授权成员（admin 全权；owner 仅可授 reviewer；同角色 200 幂等、异角色 409）。
   */
  @Post('members')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Authorize an experience space member',
    description:
      'Grants `reviewer` (can review) or `owner` (space admin). Gate: a human admin can grant ' +
      'either role; a space **owner** may only grant `reviewer` (promoting anyone — including ' +
      'itself — to `owner` is admin-only, otherwise owners could mint peers). The target actor must ' +
      'exist and not be soft-deleted (404/AGENT_NOT_FOUND otherwise). Idempotent by role: if the ' +
      'actor is ALREADY a member with the SAME role you get 200 and the member row back; with a ' +
      'DIFFERENT role you get 409/13005 — change a role with PATCH /experiences/members/:actorId ' +
      '(never delete + re-add: that loses the invitedBy trail). Rejected attempts are audited ' +
      'as denied.',
  })
  @ApiResponse({
    status: 201,
    description: 'Member row (role / invitedBy / resolved actor profile)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Already a member with the SAME role — idempotent replay returning the same member row (safe to retry)',
  })
  @ApiResponse({
    status: 403,
    description:
      '13004 — not a human admin or space owner, or an owner tried to grant the `owner` role (see GET /experiences/members)',
  })
  @ApiResponse({
    status: 404,
    description: '5000 — target actor not found or soft-deleted (AGENT_NOT_FOUND)',
  })
  @ApiResponse({
    status: 409,
    description:
      '13005 — already a member with a different role: use PATCH, do not delete and re-add',
  })
  async addMember(
    @Body() dto: AddExperienceMemberDto,
    @CurrentActor() actor: UnifiedActor,
    /**
     * passthrough 响应对象：**只为把"幂等同角色"映射成 200**（plan §2.2 码表：同角色 → 200）。
     * Nest 的 POST 默认 201，而幂等分支必须是 200——`@HttpCode` 是方法级常量、无法按分支切换，
     * 故在此手动设状态码；`passthrough: true` 保证返回值仍走全局 ResponseInterceptor 包装
     * （attachments/skill 先例：passthrough 下 writableEnded=false，信封照常生成）。
     */
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExperienceMemberDto> {
    const { member, created } = await this.memberService.addMember(dto, actor);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return member;
  }

  /**
   * 原子改角色（owner 双约束：目标行与请求值都须 reviewer；同角色 200 幂等）。
   */
  @Patch('members/:actorId')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Change an experience space member role',
    description:
      'Atomically replaces the member role (this is NOT add/remove). Gate: a human admin can set ' +
      'either role; a space **owner** must satisfy BOTH constraints — the target row must currently ' +
      'be `reviewer` AND the requested role must be `reviewer` (owners can neither promote anyone ' +
      'to `owner` nor touch existing owner rows). Sending the SAME role is an idempotent 200 no-op ' +
      '(safe to retry). A non-member target is 404/13003. The old→new role pair is audited.',
  })
  @ApiParam({ name: 'actorId', description: 'Member actor UUID' })
  @ApiResponse({
    status: 200,
    description: 'Updated member row (role / invitedBy / actor profile)',
  })
  @ApiResponse({
    status: 403,
    description:
      '13004 — not a human admin or space owner, or an owner attempted an owner-row / owner-value change',
  })
  @ApiResponse({
    status: 404,
    description:
      '13003 — the actor is not a member: check GET /experiences/members before retrying',
  })
  async updateMemberRole(
    @Param('actorId', ParseUUIDPipe) actorId: string,
    @Body() dto: UpdateExperienceMemberRoleDto,
    @CurrentActor() actor: UnifiedActor,
  ): Promise<ExperienceMemberDto> {
    return this.memberService.updateMemberRole(actorId, dto, actor);
  }

  /**
   * 夺权（物理删；owner 仅可删 reviewer 行；非成员 404）。
   */
  @Delete('members/:actorId')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Revoke an experience space member',
    description:
      'Removes the member row physically, so the review right is revoked IMMEDIATELY (no cached ' +
      'role, no soft-delete state). Gate: a human admin can revoke anyone; a space **owner** can ' +
      'only revoke `reviewer` rows (owner rows are admin-only). A non-member target is 404/13003. ' +
      'Revocation is audited with the revoked role and the revoking actor.',
  })
  @ApiParam({ name: 'actorId', description: 'Member actor UUID' })
  @ApiResponse({ status: 200, description: '{ deleted: true, actorId }' })
  @ApiResponse({
    status: 403,
    description:
      '13004 — not a human admin or space owner, or an owner attempted to revoke an owner row',
  })
  @ApiResponse({
    status: 404,
    description:
      '13003 — the actor is not a member: check GET /experiences/members before retrying',
  })
  async removeMember(
    @Param('actorId', ParseUUIDPipe) actorId: string,
    @CurrentActor() actor: UnifiedActor,
  ): Promise<{ deleted: true; actorId: string }> {
    return this.memberService.removeMember(actorId, actor);
  }

  /**
   * 判断日志查询（admin ∪ 空间 owner/reviewer；越权 403/13004）。
   *
   * 语料/复核动线：过滤 operation/status/experienceId/时间窗，按 `created_at DESC, id DESC`
   * 全序翻页；导出训练集按时间窗切片 + `total` 自检。
   */
  @Get('judgments')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'List judgment logs (moderation / corpus export)',
    description:
      'Every judgment attempt is logged (success, failure AND rate-limit skips) — this endpoint is ' +
      'the source of truth for "was this entry ever checked, and how did it go" (the `judgment` field ' +
      'on an entry is only a cache of the latest SUCCESSFUL check). Who may read: a human admin or a ' +
      'space owner/reviewer (403/13004 otherwise). Filters: `operation`, `status` (both whitelisted — ' +
      'a typo is a 400, never a silently empty page), `experienceId`, and a `from`/`to` time window. ' +
      'Ordering is total (`created_at DESC, id DESC`) so paging cannot skip or duplicate rows. ' +
      'Export discipline: slice by time window and self-check with `total`; do NOT just increment ' +
      '`page` (rows written while you page insert into ranges you already walked). Training scripts ' +
      'must skip or separately flag rows carrying `stateRedacted: true` (their stored input differs ' +
      'from what the model actually saw). Page size is capped at 50 — one page can carry ≈1.6MB.',
  })
  @ApiResponse({
    status: 200,
    description:
      'items[] (log rows incl. request/response payloads) / total (export self-check basis) / page / pageSize',
  })
  @ApiResponse({
    status: 400,
    description:
      '9000 — validation failure (unknown operation/status value, bad UUID, bad ISO time)',
  })
  @ApiResponse({
    status: 403,
    description:
      '13004 — requires a human admin or an experience space owner/reviewer role (see GET /experiences/members)',
  })
  async listJudgments(
    @Query() query: QueryJudgmentDto,
    @CurrentActor() actor: UnifiedActor,
  ): Promise<ExperienceJudgmentsResponse> {
    return this.judgmentService.listJudgments(query, actor);
  }

  /**
   * 条目详情（含 content 全文 + expired/quality 标记）。
   *
   * **按 id 只过滤软删**：suspect / 已过期条目照常可见并带标记（复核/申诉动线）。
   */
  @Get(':id')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Read an experience',
    description:
      'Returns the full entry including `content`. Unlike the list, this endpoint only filters ' +
      'soft-deleted rows: suspect and expired entries ARE returned, marked with `quality` and ' +
      '`expired` — that is what makes review/appeal possible. 404 (13000) means the id never ' +
      'existed or was deleted; do NOT retry the same id, go back to search. ' +
      'Review context (server-side authority, do not recompute it yourself): `viewerCanReview` says ' +
      'whether YOU may review — and since the self-review rule was removed (2026-09-24) it is a ' +
      'PURE ROLE FLAG (human admin or space owner/reviewer): it no longer depends on who recorded ' +
      'the entry, so a member MAY review an entry they recorded themselves. ' +
      'Anti-anchoring: while `viewerCanReview === true` and `quality !== "verified"`, the machine ' +
      'pre-check is HIDDEN (`judgment: null` + `judgmentSuppressed: true`) so reviewers form their ' +
      'own verdict first; it becomes visible again once the entry is verified. ' +
      'Creator and verifier are also returned with display names (`createdByName`, ' +
      '`verifiedByName`) — render the name; never fall back to a bare UUID.',
  })
  @ApiParam({ name: 'id', description: 'Experience UUID' })
  @ApiResponse({
    status: 200,
    description:
      'Full entry (marks expired / suspect in place) + viewerCanReview / judgment / judgmentSuppressed + creator/verifier names',
  })
  @ApiResponse({
    status: 404,
    description: '13000 — not found (or soft-deleted); go back to search',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
  ): Promise<ExperienceDetail> {
    return this.experienceService.findOne(id, actor);
  }

  /**
   * 提交使用反馈（「应用后」是否有效，不是「搜索是否命中」）。
   *
   * 幂等键必填；重复反馈按 (entry, actor) 改判并三列联动；过期条目 409 拒绝。
   */
  @Post(':id/feedback')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Report whether an experience helped',
    description:
      'Records whether the experience helped AFTER you applied it — NOT whether the search found ' +
      'it. One row per (entry, actor): sending a different outcome is a re-judgement (改判) that ' +
      'moves the counters by ±1 in the same transaction, so counters can never drift. ' +
      '`clientRequestId` is REQUIRED: same key + same outcome replays (`idempotentReplay: true`) ' +
      'with no counter change; same key + different payload is 409/9002. Expired entries reject ' +
      'feedback with 409.',
  })
  @ApiParam({ name: 'id', description: 'Experience UUID' })
  @ApiResponse({
    status: 200,
    description:
      'Post-transaction counter values (helpedCount / notHelpfulCount / distinctHelpedCount)',
  })
  @ApiResponse({ status: 404, description: '13000 — entry not found (or soft-deleted)' })
  @ApiResponse({
    status: 409,
    description:
      '9001 — the entry has expired (no retry) / 9002 — clientRequestId reused with a different payload (no retry)',
  })
  async feedback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportExperienceFeedbackDto,
    @CurrentActor() actor: UnifiedActor,
  ): Promise<ExperienceFeedbackResponse> {
    return this.experienceService.recordFeedback(id, dto, actor);
  }

  /**
   * 编辑条目（作者/admin/owner 代理 + 乐观锁 + 内容改写回落 unverified）。
   */
  @Patch(':id')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Update an experience',
    description:
      "Only the creator, the creator agent's human owner, or an admin may update. `expectedUpdatedAt` " +
      'is REQUIRED (optimistic lock): on mismatch you get 409 — re-read the entry and retry with the ' +
      'fresh `updatedAt`; blind retries with the same token keep failing. Changing any CONTENT field ' +
      '(title / summary / content / signals) resets quality from `verified` back to `unverified` and ' +
      'clears the verification trail — a verified badge must not survive a content rewrite. ' +
      '**`suspect` is sticky**: editing the content does NOT clear a suspect verdict (that verdict is ' +
      'a reviewer governance action; only a reviewer can lift it via the bidirectional quality gate). ' +
      '`quality` itself is NOT patchable here (400 if sent); use PATCH /experiences/:id/quality ' +
      '(human admin or space owner/reviewer).',
  })
  @ApiParam({ name: 'id', description: 'Experience UUID' })
  @ApiResponse({ status: 200, description: 'Updated entry (full detail)' })
  @ApiResponse({
    status: 403,
    description: '13001 — not your entry (do NOT retry; admin review path)',
  })
  @ApiResponse({ status: 404, description: '13000 — entry not found (or soft-deleted)' })
  @ApiResponse({
    status: 409,
    description: '9001 — expectedUpdatedAt mismatch; re-read and retry with the fresh value',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExperienceDto,
    @CurrentActor() actor: UnifiedActor,
  ): Promise<ExperienceDetail> {
    return this.experienceService.update(id, dto, actor);
  }

  /**
   * 质量终审（admin 或空间 owner/reviewer）：verified / suspect 双向门 + 必填理由。
   *
   * ⚠️ 守卫是 `JwtOrApiKeyGuard`（第二期改造，**不再是** admin 三元组）：权限判定在 service
   * （`assertCanReview` —— 唯一拒绝码 403/13004 缺角色；禁自审四态已于 v1.81.0 退役），
   * controller 不复制逻辑。
   */
  @Patch(':id/quality')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Review quality (human admin or space owner/reviewer)',
    description:
      'Sets `verified` (trusted, ranked first) or `suspect` (excluded from default search, still ' +
      'readable in detail). The gate is BIDIRECTIONAL — a suspect can be verified again and vice ' +
      'versa (this is also the ONLY way to lift a suspect verdict: content edits cannot). ' +
      '`reason` is required and lands in the audit trail (old→new+reason). Who may review: a human ' +
      'admin, or a space member with role `owner`/`reviewer` (GET /experiences/members). ' +
      '**Since 2026-09-24 there is no self-review restriction** (the old 13002 rule was removed): ' +
      'a member may verdict ANY entry, including one they recorded themselves — do not look for ' +
      'another reviewer and do not pre-filter the queue by creator. ' +
      'Missing role → 403/**13004** (ask an admin to grant you the role — a grant you lack, not a ' +
      'permanent bar); 13000 = entry not found. Do NOT retry a rejected call as-is.',
  })
  @ApiParam({ name: 'id', description: 'Experience UUID' })
  @ApiResponse({
    status: 200,
    description: 'Final quality + verifier trail (verifiedBy / verifiedByName / verifiedAt)',
  })
  @ApiResponse({
    status: 403,
    description:
      '13004 — you have no review role (ask an admin; see GET /experiences/members). Since v1.81.0 this is the ONLY review rejection code (13002 was retired).',
  })
  @ApiResponse({ status: 404, description: '13000 — entry not found (or soft-deleted)' })
  async reviewQuality(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewExperienceQualityDto,
    @CurrentActor() actor: UnifiedActor,
  ): Promise<ExperienceQualityReviewResponse> {
    return this.experienceService.reviewQuality(id, dto, actor);
  }

  /**
   * 软删条目（作者/admin/owner 代理）。
   *
   * 软删后读写一律 404；恢复刻意不设应用层 API（admin 走 DB 人工窗口）。
   */
  @Delete(':id')
  @UseGuards(JwtOrApiKeyGuard)
  @ApiOperation({
    summary: 'Delete an experience (soft delete)',
    description:
      'Soft-deletes the entry: it disappears from list/search/facets and its detail returns 404 — ' +
      'the response is identical to "never existed" on purpose (existence is not leaked). Deletion ' +
      'is audited. Same author rule as update; there is deliberately NO restore endpoint (an admin ' +
      'restores via a manual DB window).',
  })
  @ApiParam({ name: 'id', description: 'Experience UUID' })
  @ApiResponse({ status: 200, description: '{ deleted: true, id }' })
  @ApiResponse({
    status: 403,
    description: '13001 — not your entry (do NOT retry; admin review path)',
  })
  @ApiResponse({ status: 404, description: '13000 — entry not found (or already soft-deleted)' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
  ): Promise<{ deleted: boolean; id: string }> {
    await this.experienceService.remove(id, actor);
    return { deleted: true, id };
  }
}
