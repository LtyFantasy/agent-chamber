/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库空间成员（终审权委托：owner / reviewer）与其派生的**终审资格判定**
 *     —— 自 2026-09-24（v1.81.0）起为**纯角色判定**：禁自审四态已整体退役
 *
 * [代码职责]
 *   - `experience_space_members` 的四端点写读路径（列表/授权/改角色/夺权）+ 闸门与 denied 审计
 *   - `resolveMemberRole`（角色解析，**禁缓存**）与 `evaluateReviewPermission` /
 *     `assertCanReview`（终审资格，服务端单源：detail 的 viewer 字段与终审端点共用同一实现）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` §7（终审纪律）/§11（威胁模型 +
 *     退役决策记录）/`docs/api-definition.md` §18
 *   - 历史: .kimi/plans/plan-experience-base-p2.md §0（禁自审四态矩阵——**已退役**）
 *     /§2.2（端点闸门表）/§2.3（既有口径联动：facets 例外、禁止缓存）
 *
 * [关键不变量]
 *   - **角色解析禁止缓存**（plan §0/§2.3）：DELETE 是物理删、夺权须**即时生效**；任何
 *     Map/请求级缓存都会让被吊销的 reviewer 继续终审。每次都查 PK 单行（成本可忽略）。
 *   - **权限判定 ≠ 展示判定**：`assertCanReview`（写/终审动作）会写 denied 审计并抛错；
 *     `evaluateReviewPermission`（detail 读路径）**绝不写审计、绝不抛错**——读详情是
 *     全认证可用的动作，给读路径插审计会把审计表刷成噪声。
 *   - **禁自审四态已整体退役（2026-09-24 用户拍板，v1.81.0）**：单租户 + 同模型 agent +
 *     新会话无上下文包袱的现实下，"兄弟 agent 审"与"自审"的独立性同构，规则只制造死锁
 *     （2026-09-24 生产实证：17 条待审、`viewerCanReview` 全 false ⇒ 无人能 verdict）。
 *     结论：**任何 admin 或空间 owner/reviewer 可终审任意条目（含本人所录）**，终审资格
 *     退化为纯角色判定。双向权力同时放开：持角色者也可对自己/兄弟的条目打 `suspect`
 *     （默认检索排除的唯一隐藏原语）——明文接受，靠审计 old→new+reason 留痕 + admin
 *     翻案权兜底；多租户开放时按决策记录捡回（线上 `docs/experience-base.md` §11）。
 *     ⚠️ **编辑/删除的作者判定不受本次变更影响**：`experience.service.ts` 的
 *     `assertCanWrite`（admin ｜ creator ｜ owner 代理 → 403/13001）照旧，其中
 *     `ownerProxy.isOwnerProxy` 仍在使用——勿因"四态退役"连带删掉它（那是另一个方向的
 *     权限面，删了等于放开他人条目被代改）。
 *   - **成员管理闸门（§2.2）**：admin 全权；owner **双约束**——PATCH 要求
 *     `目标行.role === 'reviewer'` **且** `请求值 === 'reviewer'`（否则 owner 可自造 owner）；
 *     DELETE 仅可删 reviewer 行；POST 仅可授 reviewer 值。**被拒一律 denied 审计**。
 *   - **写路径并发护栏（2026-09-22 复审补齐，三处都要）**：
 *     ① POST 用**显式 `insert()`**（不是 `save()`——已设业务 PK 的新实体会被 save 先探测
 *        存在性而改走 UPDATE，静默改写别人的角色）并 catch **23505** 回读收敛（同角色幂等 /
 *        异角色 409）——**绝不把 23505 泄漏成全局过滤器的 409/RESOURCE_CONFLICT**
 *        （那会让"同角色可重试"契约失效）；
 *     ② owner 的 PATCH 走**条件 no-op UPDATE**、owner 的 DELETE 走**条件 DELETE**
 *        （`WHERE actor_id AND role='reviewer'`），`affected=0` ⇒ 回读后 404/13003 或
 *        403/13004——否则"检查通过后 admin 刚把该行升成 owner"会被这次写顺带改掉/删掉
 *        （检查与写入之间的时序窗）；
 *     ③ admin 的 PATCH 走**按 PK 条件写**（`affected=0` ⇒ 404），避免 `save()` 把刚被
 *        并发夺权的行**重建**出来（"夺权后复活"事故）。
 *   - **空身份一律首行拒**（`assertReviewIdentity` / `assertManageIdentity`）：拒绝分支要写
 *     denied 审计（读 `actor.id`），空身份直通会把 403 变成 500（安全分支不得以 500 收场）。
 *   - `role` 列无 DB 默认值，写入恒显式带值（见 entity 注释）。
 *
 * [关联代码]
 *   - experience.service.ts — 终审端点 / 详情 viewer 字段 / includeSuspect 闸门的调用方
 *   - experience-actor.ts — `isAdmin`（叶子谓词，两边共用；此处不 import service 以避免环）
 *   - common/services/actor-profile.service.ts — `assertActorUsable`（存在性）与
 *     `resolveProfiles`（name/type/avatarUrl/deletedAt 投影，成员行不存名）
 *   - common/services/owner-proxy.service.ts — `isOwnerProxy`（条目编辑/删除的作者判定，
 *     消费方是 experience.service；本服务自 v1.81.0 起不再注入它）
 *   - database/entities/experience-space-member.entity.ts — 表契约
 *   - modules/audit/audit-constants.ts — `EXPERIENCE_SPACE_MEMBER` 插桩归属（第 25 值）
 *
 * [持久踩坑]
 *   EXPERIENCE-MEMBER-ROLE-GATE(owner 造 owner): 只写"owner 只能改 reviewer 行"漏掉
 *     "也只能授 reviewer 值"⇒ owner 可把 reviewer 提升为 owner 造出同级。安全方向:
 *     目标行与请求值**双约束**，两条都在断言里显式写出（见 §2.2 的 security 复核 N1）。
 *   EXPERIENCE-MEMBER-CACHE(夺权滞后): 缓存角色会让 DELETE 夺权后仍可终审 N 分钟。
 *     安全方向: 每次判定现查；本条不引入任何缓存层。
 *   EXPERIENCE-SELF-REVIEW-RETIRED(旧约束静默回流): 四态退役后，若有人照旧文档/旧
 *     MCP 文案"按 creator 把队列预筛掉"，会把**可审**条目误判成不可审（线上表现 = 队列
 *     空转、"待审永远审不完"，且无任何报错）。安全方向: 13002 号**不复用**、退役注记写在
 *     **引用处**（shared enums 的 13004 分工注释 + 本服务 reviewForbidden 注释），MCP
 *     description **反向改写**为"不要按 creator 预筛"，并用负向断言（not.toContain）钉住
 *     旧文案不回流。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改动权限判定前先确认**终审资格仍是纯角色判定**（自 v1.81.0 起不再有按条目维度的
 *     禁自审分支；重新引入 = 恢复已拍板退役的死锁）
 *   □ 编辑/删除的作者判定（experience.service 的 assertCanWrite + ownerProxy）**不在本文件**
 *     ——不要因为看到"自审"二字就把那里的 owner 代理判定一并删掉
 *   □ 四端点闸门改动必须同步 denied 审计与 e2e 用例（铁律 #17/#18）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ActorType,
  AuditAction,
  EXPERIENCE_MEMBER_ROLE,
  ErrorCode,
  type ExperienceMemberDto,
  type ExperienceMemberRole,
  type ExperienceMembersResponse,
} from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';
import { ActorProfileService } from '../../common/services/actor-profile.service';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { ExperienceSpaceMember } from '../../database/entities/experience-space-member.entity';
import type { ExperienceEntry } from '../../database/entities/experience-entry.entity';
import { isAdmin } from './experience-actor';
import type { AddExperienceMemberDto, UpdateExperienceMemberRoleDto } from './dto';

/**
 * 终审资格判定结果（**服务端单源**；shared `ExperienceDetail` 的 viewer 字段直接取自它）。
 *
 * 自 v1.81.0（禁自审四态退役）起**只剩一个维度**：`canReview` = "调用者持终审角色吗"
 * （admin ∪ 空间 owner/reviewer）。原先的 `blockReason` 词表随四态一并退役——响应侧
 * `viewerReviewBlockReason` 已停发，消费方收到 `undefined`（语义 = "不再有原因码"）。
 *
 * ⚠️ 旧值 `'self' | 'owner_proxy'` **刻意不再保留任何兼容分支**：四态退役是"资格判定
 * 收敛为角色判定"这一个语义变更，留一个恒 null 的字段会让消费方继续按旧语义写代码。
 */
export interface ViewerReviewState {
  /** 当前调用者能否终审（纯角色判定：admin ∪ 空间 owner/reviewer） */
  canReview: boolean;
}

/** 成员管理动作（denied 审计的 attempt 值，与条目侧 attempt:'update'|'delete' 同规） */
type MemberManageAction = 'add_member' | 'update_member_role' | 'remove_member';

/** 成员管理权限等级（admin 全权；owner 受限） */
type ManageAuthority = 'admin' | 'owner';

/**
 * 经验库空间成员服务（第二期批 2，plan §2）。
 *
 * 授权模型：`owner`（空间管理员：终审 + 管理 reviewer）/ `reviewer`（终审人）；
 * 人类 admin 是**全局兜底**（不入表即可行使一切成员操作）。经验库是全局单空间
 * （member 表刻意无 space_id，见 entity 注释）。
 */
@Injectable()
export class ExperienceMemberService {
  private readonly logger = new Logger(ExperienceMemberService.name);

  constructor(
    @InjectRepository(ExperienceSpaceMember)
    private readonly memberRepo: Repository<ExperienceSpaceMember>,
    private readonly auditService: AuditService,
    // ⚠️ `OwnerProxyService` 自 v1.81.0 起**不再注入**：它的唯一用途是禁自审四态
    // （`isOwnerProxy` 态 2 / `getAgentOwnerId` 态 4），四态退役后本服务零引用。
    // 条目编辑/删除的作者判定仍在用同名方法，但那个消费方是 experience.service
    // （它自己注入），与这里无关——不要因此把本注入"补回来"。
    private readonly actorProfile: ActorProfileService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // 读：成员列表
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 成员列表（`GET /experiences/members`，**任何认证身份可读**）。
   *
   * 透明性取舍（plan §0 明文）：成员清单对全体认证身份可见——平台用户是 Agent，
   * "该找谁终审"比藏住名单更重要；唯一收窄项是 `invitedBy`（仅 admin/owner 非空）。
   *
   * 投影说明：成员行只存 actorId，name/type/avatarUrl/deletedAt 由
   * `ActorProfileService.resolveProfiles` 批量解析（**禁 N+1**，与列表/审计页同族）。
   *
   * @param actor 当前统一身份（null 时 invitedBy 恒不可见）
   * @returns 成员列表（按 createdAt, actorId 稳定排序）
   */
  async listMembers(actor: UnifiedActor | null): Promise<ExperienceMembersResponse> {
    const rows = await this.memberRepo
      .createQueryBuilder('m')
      .orderBy('m.created_at', 'ASC')
      .addOrderBy('m.actor_id', 'ASC')
      .getMany();

    // invitedBy 的可见性门：admin 或 owner（|| 短路：admin 不触发成员表查询）
    const canSeeInvitedBy =
      isAdmin(actor) || (await this.resolveMemberRole(actor?.id)) === EXPERIENCE_MEMBER_ROLE.OWNER;

    const profiles = await this.actorProfile.resolveProfiles(rows.map((row) => row.actorId));
    return {
      items: rows.map((row) => this.toMemberDto(row, profiles.get(row.actorId), canSeeInvitedBy)),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 写：授权 / 改角色 / 夺权
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 授权成员（`POST /experiences/members`）。
   *
   * 执行序：**闸门 → 存在性 → 幂等/冲突 → 写入**（闸门最前：无管理权的调用者不该通过
   * 404/409 的差异反推"某个 actor 是不是成员"）。
   *
   * - 幂等：已是成员且**同角色** → 返回成员行且 `created=false`（**HTTP 200**，不写审计，
   *   无状态变化）——重复授权是网络重试的常态，必须可重试
   * - 冲突：已是成员但**异角色** → 409/13005（指引走 PATCH；禁"删了重加"——会丢
   *   invited_by 授权留痕，且中途存在无成员行窗口）
   *
   * `created` 由 controller 映射到状态码（新建 201 / 幂等 200，plan §2.2 的码表）。
   *
   * @param dto actorId + role（格式已过 DTO 层）
   * @param actor 调用者（须 admin 或 owner；owner 仅可授 reviewer）
   * @returns `{ member, created }`——created=false 表示命中同角色幂等分支
   * @throws ForbiddenException 403/13004（无管理权或 owner 越权授 owner）
   * @throws NotFoundException 404/AGENT_NOT_FOUND（目标 actor 不存在或已软删）
   * @throws ConflictException 409/13005（已是成员、异角色）
   */
  async addMember(
    dto: AddExperienceMemberDto,
    actor: UnifiedActor,
  ): Promise<{ member: ExperienceMemberDto; created: boolean }> {
    // 身份前置判空（零仓储访问）：actor 为空时若继续走闸门，recordDenied 读 actor.id 会
    // TypeError→500（越权拒绝绝不该表现成 500）
    this.assertManageIdentity(actor);
    const authority = await this.requireManageAuthority(actor, {
      action: 'add_member',
      targetActorId: dto.actorId,
      requestedRole: dto.role,
    });
    // owner 仅可授 reviewer 值（授 owner = admin 专属，否则 owner 自造同级）
    if (authority === 'owner' && dto.role !== EXPERIENCE_MEMBER_ROLE.REVIEWER) {
      await this.recordDenied(actor, {
        action: 'add_member',
        targetActorId: dto.actorId,
        requestedRole: dto.role,
        reason: 'owner_may_only_grant_reviewer',
      });
      throw reviewForbidden('grant the `owner` role');
    }

    // 存在性：不存在 / 已软删统一 404（spec §1 规则 6；**禁用 resolveProfiles 判存在**）
    await this.actorProfile.assertActorUsable(dto.actorId);

    // ① 快路径：已是成员 → 幂等/冲突（绝大多数"重复授权"走这里，零写入）
    const existing = await this.memberRepo.findOne({ where: { actorId: dto.actorId } });
    if (existing) return this.convergeOnExistingMember(existing, dto.role);

    // ② **显式 INSERT**（不是 `save()`）：本表主键是业务键 actor_id，`save()` 对"已设 PK 的
    //    新实体"会先探测存在性，并发下可能改走 UPDATE 分支**静默改写别人的角色**且不报错；
    //    `insert()` 遇并发抢占会如实抛出 23505，让下面的收敛分支接手。
    try {
      await this.memberRepo.insert({
        actorId: dto.actorId,
        role: dto.role,
        // 授权人留痕（admin 直接授权时也落 admin 的 actorId）
        invitedBy: actor.id,
      });
    } catch (err: unknown) {
      // ③ 并发同 actorId 抢先（PK 撞键）→ 回读该行按同/异角色语义收敛。
      //    ⚠️ **绝不把 23505 泄漏出去**：全局异常过滤器会把它映射成 409/RESOURCE_CONFLICT，
      //    那会让"同角色重复授权"这个**可重试幂等**操作变成失败（违反 §2.2 码表）。
      //    写法照 idempotency.helper.ts 的 23505 path-winner 先例。
      if (!isUniqueViolation(err)) throw err;
      const concurrent = await this.memberRepo.findOne({ where: { actorId: dto.actorId } });
      if (concurrent) return this.convergeOnExistingMember(concurrent, dto.role);
      // 并发方在两次读之间又删掉了（极窄窗）：重试一次即可成功，故显式要求重试而非静默
      throw concurrentMembershipChange(dto.actorId);
    }

    // ④ 回读落库行：`created_at` 由 DB `DEFAULT now()` 生成，响应要真实值（不自己造时间）
    const stored = await this.memberRepo.findOne({ where: { actorId: dto.actorId } });
    if (!stored) throw concurrentMembershipChange(dto.actorId);

    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.EXPERIENCE_SPACE_MEMBER,
      entityId: stored.actorId,
      actorId: actor.id,
      // 授权动作必须可复盘"谁在什么时候给谁什么角色"
      newData: { role: stored.role, targetActorId: stored.actorId, grantedBy: actor.id },
      source: 'api',
    });

    return {
      member: this.toMemberDto(
        stored,
        await this.profileOf(stored.actorId),
        true /* admin/owner 才有权到此 */,
      ),
      created: true,
    };
  }

  /**
   * 原子改角色（`PATCH /experiences/members/:actorId`）。
   *
   * 闸门（owner **双约束**：目标行与请求值都须 reviewer）；同角色 → 200 幂等 no-op；
   * 非成员 → 404/13003。角色历史不进表（查 audit_logs 的 UPDATE old→new）。
   *
   * @param actorId 目标成员（path 参数，controller 已 ParseUUIDPipe）
   * @param dto 新角色
   * @param actor 调用者
   * @throws ForbiddenException 403/13004（无管理权或 owner 越权）
   * @throws NotFoundException 404/13003（非成员）
   */
  async updateMemberRole(
    actorId: string,
    dto: UpdateExperienceMemberRoleDto,
    actor: UnifiedActor,
  ): Promise<ExperienceMemberDto> {
    this.assertManageIdentity(actor);
    const authority = await this.requireManageAuthority(actor, {
      action: 'update_member_role',
      targetActorId: actorId,
      requestedRole: dto.role,
    });

    const existing = await this.memberRepo.findOne({ where: { actorId } });
    if (!existing) throw memberNotFound(actorId);

    // owner 双约束：**目标行**须 reviewer **且** 请求值须 reviewer（两条缺一即 owner 造 owner）
    if (
      authority === 'owner' &&
      (existing.role !== EXPERIENCE_MEMBER_ROLE.REVIEWER ||
        dto.role !== EXPERIENCE_MEMBER_ROLE.REVIEWER)
    ) {
      await this.recordDenied(actor, {
        action: 'update_member_role',
        targetActorId: actorId,
        requestedRole: dto.role,
        currentRole: existing.role,
        reason: 'owner_may_only_touch_reviewer_rows',
      });
      throw reviewForbidden('change a member role');
    }

    // 同角色 → 幂等 no-op（200）：重复 PATCH 是重试的常态，不该报 409/无意义写。
    // 注意：owner 分支**恒**落在这里（双约束下它只可能 reviewer→reviewer），故 owner 的
    // 写路径没有真实角色变更——但"读取时它是 reviewer 行"这个放行前提仍须原子化，见下。
    if (existing.role === dto.role) {
      if (authority === 'owner') {
        // 护栏（并发时序窗）：条件 no-op UPDATE（WHERE actor_id AND role='reviewer'）。
        // 若检查之后 admin 已把该行升成 owner，affected=0 —— 此时**不能**带着陈旧的
        // 'reviewer' 返 200（客户端会以为对方还是 reviewer，而实际已是同级 owner）。
        // 无 updated_at 列，故该 no-op 写只产生一次 HOT 更新，无额外副作用。
        const probe = await this.memberRepo.update(
          { actorId, role: EXPERIENCE_MEMBER_ROLE.REVIEWER },
          { role: EXPERIENCE_MEMBER_ROLE.REVIEWER },
        );
        if (probe.affected === 0) {
          await this.throwAfterConcurrentMemberChange(actor, actorId, 'update_member_role');
        }
      }
      return this.toMemberDto(existing, await this.profileOf(actorId), true);
    }

    // admin 分支：**按 PK 条件写**（affected=0 ⇒ 行已被并发删除 → 404，而不是用
    // `save()` 把刚被夺权的行**重建**出来——那是"夺权后复活"的真事故形态）
    const oldRole = existing.role;
    const result = await this.memberRepo.update({ actorId }, { role: dto.role });
    if (result.affected === 0) throw memberNotFound(actorId);

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.EXPERIENCE_SPACE_MEMBER,
      entityId: actorId,
      actorId: actor.id,
      oldData: { role: oldRole },
      newData: { role: dto.role, targetActorId: actorId, changedBy: actor.id },
      source: 'api',
    });

    return this.toMemberDto({ ...existing, role: dto.role }, await this.profileOf(actorId), true);
  }

  /**
   * 夺权（`DELETE /experiences/members/:actorId`，**物理删**）。
   *
   * 物理删 = 夺权**即时生效**（无软删态可漏判）；owner 仅可删 reviewer 行（不可动 owner 行
   * ——owner 任免是 admin 专属）；非成员 → 404/13003。
   *
   * @param actorId 目标成员
   * @param actor 调用者
   * @returns `{ deleted: true, actorId }`
   * @throws ForbiddenException 403/13004（无管理权或 owner 越权删 owner 行）
   * @throws NotFoundException 404/13003（非成员）
   */
  async removeMember(
    actorId: string,
    actor: UnifiedActor,
  ): Promise<{ deleted: true; actorId: string }> {
    this.assertManageIdentity(actor);
    const authority = await this.requireManageAuthority(actor, {
      action: 'remove_member',
      targetActorId: actorId,
    });

    const existing = await this.memberRepo.findOne({ where: { actorId } });
    if (!existing) throw memberNotFound(actorId);

    if (authority === 'owner' && existing.role !== EXPERIENCE_MEMBER_ROLE.REVIEWER) {
      await this.recordDenied(actor, {
        action: 'remove_member',
        targetActorId: actorId,
        currentRole: existing.role,
        reason: 'owner_may_only_remove_reviewer_rows',
      });
      throw reviewForbidden('remove a member');
    }

    if (authority === 'owner') {
      // 护栏（并发时序窗）：**条件删**（WHERE actor_id AND role='reviewer'）——检查之后
      // admin 刚把该行升成 owner 时，owner 这次 DELETE 不得把它顺带删掉。
      const result = await this.memberRepo.delete({
        actorId,
        role: EXPERIENCE_MEMBER_ROLE.REVIEWER,
      });
      if (result.affected === 0) {
        await this.throwAfterConcurrentMemberChange(actor, actorId, 'remove_member');
      }
    } else {
      // admin：无条件删（不限制 role，owner 任免是 admin 专属）——但 affected=0 说明
      // 行已被并发夺权，此时报 404（语义正确）而不是装作删成功
      const result = await this.memberRepo.delete({ actorId });
      if (result.affected === 0) throw memberNotFound(actorId);
    }

    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.EXPERIENCE_SPACE_MEMBER,
      entityId: existing.actorId,
      actorId: actor.id,
      // 夺权留痕：被夺者的角色与执行者（复盘"谁什么时候收回了谁的终审权"）。
      // owner 分支的角色由条件删保证为 reviewer；admin 分支是"删除前读到的角色"。
      newData: {
        actorId: existing.actorId,
        role: existing.role,
        revokedBy: actor.id,
      },
      source: 'api',
    });

    return { deleted: true, actorId: existing.actorId };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 角色解析与终审资格（经验库三处判定的单源）
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 解析 actor 的空间成员角色（**禁止缓存**：DELETE 夺权须即时生效）。
   *
   * 空值防御：`findOne({ where: { actorId: undefined } })` 会退化成"取任意一行"（同族坑
   * 见 `jwt-or-api-key.guard.ts:43-45`），故空 id 直接返回 null 不查库。
   *
   * @param actorId 待查 actor（可为 null/undefined/空串）
   * @returns 'owner' | 'reviewer' | null（非成员）
   */
  async resolveMemberRole(
    actorId: string | null | undefined,
  ): Promise<ExperienceMemberRole | null> {
    if (!actorId) return null;
    const row = await this.memberRepo.findOne({ where: { actorId } });
    return row?.role ?? null;
  }

  /**
   * 终审资格判定（**非抛出式**，供详情读路径计算 viewer 字段）。
   *
   * 判定序 = **身份 → 角色门**（自 v1.81.0 起没有第三步：禁自审四态已退役）：
   * ① 无身份 → 无资格（不查库）；
   * ② 角色门：admin（不查库）或空间成员 owner/reviewer（PK 单查）。
   *
   * 为什么"先过角色门"的措辞曾经重要、现在只剩成本收益：旧实现要先算自审矩阵才能给出
   * `blockReason`（`'self'` / `'owner_proxy'`），故顺序会改变给用户的文案；四态退役后
   * 文案维度消失，先过角色门剩下**纯成本收益**——非成员请求零额外查询，有角色者多一次
   * 成员表 PK 查（可忽略）。
   *
   * ⚠️ **`entry` 参数现已不参与判定**（资格是纯角色判定，与"哪一条"无关）：保留形参是
   * 为了调用点签名稳定、并为将来的多租户恢复（按条目判定的配置开关）留座位；参数按
   * `_entry` 命名以明示"刻意未使用"，而不是被误读成漏用。
   *
   * 读路径**不写审计、不抛错**（见文件头不变量）。
   *
   * @param _entry 目标条目（**当前不参与判定**，见上）
   * @param actor 当前统一身份（可为 null）
   * @returns `{canReview}`（纯角色判定）
   */
  async evaluateReviewPermission(
    _entry: ExperienceEntry,
    actor: UnifiedActor | null,
  ): Promise<ViewerReviewState> {
    if (!actor?.id) return { canReview: false };

    const hasRole = isAdmin(actor) || (await this.resolveMemberRole(actor.id)) !== null;
    return { canReview: hasRole };
  }

  /**
   * 身份前置守卫（终审端点**首行**用）：无 `actor?.id` → 403/13004，**不触碰任何仓储**。
   *
   * 为什么单独一个公开方法：终审端点需要在"加载条目"**之前**就拒掉无身份调用（否则
   * 无身份 + 不存在的 id 会先返回 404，把 404/403 的差异变成存在性探针）。`assertCanReview`
   * 的第一行同样调用本方法（纵深防御：任何调用方都受保护）。
   *
   * @param actor 当前统一身份
   * @throws ForbiddenException 403/13004
   */
  assertReviewIdentity(actor: UnifiedActor | null): void {
    if (!actor?.id) throw reviewForbidden('review an experience');
  }

  /**
   * 身份前置守卫（成员三端点**首行**用）：无 `actor?.id` → 403/13004，**不触碰任何仓储**。
   *
   * 与 `assertReviewIdentity` 同形、分工不同（终审 vs 成员管理，message 给各自下一步）。
   * 必要性：拒绝分支要写 denied 审计（读 `actor.id`），空身份直通会让越权拒绝**表现成
   * 500 TypeError**——安全分支绝不能以 500 收场。`requireManageAuthority` 首行也调用本方法
   * （纵深防御：未来新增调用方不会漏）。
   *
   * @param actor 当前统一身份
   * @throws ForbiddenException 403/13004
   */
  assertManageIdentity(actor: UnifiedActor | null): void {
    if (!actor?.id) throw reviewForbidden('manage space members');
  }

  /**
   * 终审资格断言（**抛出式**，供终审写路径）。
   *
   * 首行即身份守卫：`actor?.id` 缺失 → 403/13004 **且不触碰成员仓储**（单测钉住"零调用"）
   * ——防 `findOne({ actorId: undefined })` 认证绕过同族坑（铁律 #22）。
   *
   * 唯一拒绝码 = 403/**13004**（无终审角色，写 denied 审计）。**13002（禁自审）已于
   * 2026-09-24 随四态矩阵退役，号不复用**——持角色者可终审任意条目（含本人所录）。
   * 「自审」在 v1.81.0 之后**不再是权限概念**：若某条内容可疑，正确动作是走双向门打
   * `suspect`（同一个终审端点），而不是拒绝自己审自己。
   *
   * @param entry 目标条目（denied 审计载荷的 entityId / creatorId 来源）
   * @param actor 当前统一身份
   * @throws ForbiddenException 403/13004（无终审角色）
   */
  async assertCanReview(entry: ExperienceEntry, actor: UnifiedActor | null): Promise<void> {
    this.assertReviewIdentity(actor);
    // 上面已抛过 null 分支，此处收窄仅为类型可读性（运行时恒为 UnifiedActor）
    const reviewer = actor as UnifiedActor;

    const state = await this.evaluateReviewPermission(entry, reviewer);
    if (state.canReview) return;

    await this.recordDenied(reviewer, {
      action: 'review_experience',
      entityId: entry.id,
      reason: 'no_review_role',
      creatorId: entry.createdById,
    });

    // 唯一拒绝路径：无终审角色（13002 已退役，见方法注释）
    throw reviewForbidden('review an experience');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 内部：闸门 / 投影
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 成员管理闸门（三端点共用）：解析调用者的管理权限等级。
   *
   * - 空身份 → **首行即拒** 403/13004（零仓储访问；见 assertManageIdentity）
   * - admin → `'admin'`（全权，不查成员表）
   * - owner → `'owner'`（受限，具体约束由各端点施加——需目标行信息，见各方法）
   * - 其余（reviewer 成员 / 非成员 / agent）→ denied 审计 + 403/13004
   *
   * @param actor 调用者（可为 null：三端点虽由 guard 保证非空，但服务不该依赖调用方装配）
   * @param context 审计上下文（动作/目标 actor/请求角色）
   * @returns 调用者的管理权限等级
   */
  private async requireManageAuthority(
    actor: UnifiedActor | null,
    context: {
      action: MemberManageAction;
      targetActorId: string;
      requestedRole?: ExperienceMemberRole;
    },
  ): Promise<ManageAuthority> {
    // 首行判空：拒绝分支要写 denied 审计（读 actor.id），空身份直通会变 TypeError→500
    this.assertManageIdentity(actor);
    const manager = actor as UnifiedActor;

    if (isAdmin(manager)) return 'admin';
    const role = await this.resolveMemberRole(manager.id);
    if (role === EXPERIENCE_MEMBER_ROLE.OWNER) return 'owner';

    await this.recordDenied(manager, {
      ...context,
      reason: role === null ? 'not_a_member' : 'reviewer_cannot_manage_members',
    });
    throw reviewForbidden('manage space members');
  }

  /**
   * 已有成员行时的收敛（POST 的"快路径"与"23505 竞态回读"两条入口共用**唯一定义**）。
   *
   * - 同角色 → 幂等返回（`created: false` ⇒ HTTP 200），零写入
   * - 异角色 → 409/13005（指引 PATCH；禁"删了重加"——会丢 invitedBy 留痕且留无行窗口）
   *
   * @param existing 已存在的成员行
   * @param requestedRole 本次请求的角色
   */
  private async convergeOnExistingMember(
    existing: ExperienceSpaceMember,
    requestedRole: ExperienceMemberRole,
  ): Promise<{ member: ExperienceMemberDto; created: false }> {
    if (existing.role === requestedRole) {
      return {
        member: this.toMemberDto(
          existing,
          await this.profileOf(existing.actorId),
          true /* 能走到这里 = admin/owner，恒可见 invitedBy */,
        ),
        created: false,
      };
    }
    throw new ConflictException({
      message:
        `Actor '${existing.actorId}' is already an experience space member with role ` +
        `'${existing.role}'. Changing a role is PATCH /experiences/members/:actorId — do NOT ` +
        'delete and re-add (that loses the invitedBy trail and leaves a window with no member ' +
        'row). 已是成员且角色不同：改角色请走 PATCH',
      code: ErrorCode.EXPERIENCE_MEMBER_EXISTS,
    });
  }

  /**
   * 并发改动的统一收口（条件写 affected=0 后调用）：回读现状决定 404 还是 403。
   *
   * - 行已不存在（被并发夺权）→ 404/13003
   * - 行仍在但角色已变（被并发改角色）→ denied 审计 + 403/13004（owner 的放行前提已失效）
   *
   * @param actor 调用者（已过身份与角色闸门）
   * @param actorId 目标成员
   * @param action 触发本次收口的动作（审计载荷）
   * @throws NotFoundException 404/13003 / ForbiddenException 403/13004
   */
  private async throwAfterConcurrentMemberChange(
    actor: UnifiedActor,
    actorId: string,
    action: 'update_member_role' | 'remove_member',
  ): Promise<never> {
    const current = await this.memberRepo.findOne({ where: { actorId } });
    if (!current) throw memberNotFound(actorId);

    await this.recordDenied(actor, {
      action,
      targetActorId: actorId,
      currentRole: current.role,
      reason: 'role_changed_before_write',
    });
    throw reviewForbidden(action === 'remove_member' ? 'remove a member' : 'change a member role');
  }

  /**
   * 越权尝试留痕（fail-open：审计失败不得盖过 403 本身；照条目侧先例）
   *
   * ⚠️ 前置条件：**调用方必须先过 `assertReviewIdentity` / `assertManageIdentity`**
   * ——本方法读 `actor.id` 组装审计载荷，空身份直通会抛 TypeError（500）。
   * 当前四个调用点（requireManageAuthority 首行、三端点的 owner 约束分支、并发收口、
   * assertCanReview）都在身份守卫之后，故类型收成非空 `UnifiedActor`。
   */
  private async recordDenied(
    actor: UnifiedActor,
    payload: {
      action: MemberManageAction | 'review_experience';
      targetActorId?: string;
      requestedRole?: ExperienceMemberRole;
      currentRole?: ExperienceMemberRole;
      reason: string;
      entityId?: string;
      creatorId?: string;
    },
  ): Promise<void> {
    await this.auditService.log({
      action: payload.action === 'remove_member' ? AuditAction.DELETE : AuditAction.UPDATE,
      entityType:
        payload.action === 'review_experience'
          ? AUDIT_ENTITY_TYPE.EXPERIENCE
          : AUDIT_ENTITY_TYPE.EXPERIENCE_SPACE_MEMBER,
      entityId: payload.entityId ?? payload.targetActorId ?? actor.id,
      actorId: actor.id,
      newData: { denied: true, ...payload, deniedBy: actor.id },
      source: 'api',
    });
  }

  /** 单 actor 档案解析（授权/改角色响应用；走公共 service，不自行查 actors 表） */
  private async profileOf(actorId: string) {
    const profiles = await this.actorProfile.resolveProfiles([actorId]);
    return profiles.get(actorId);
  }

  /**
   * 成员行 → 响应投影。
   *
   * `actorType` 只暴露 human/agent 两值（`ExperienceMemberDto` 的词表）：system 哨兵理论上
   * 不入表，若被写入则保持字段缺省，而不是把 'system' 当第三值泄漏出去。
   */
  private toMemberDto(
    row: ExperienceSpaceMember,
    profile: Awaited<ReturnType<ExperienceMemberService['profileOf']>>,
    canSeeInvitedBy: boolean,
  ): ExperienceMemberDto {
    const actorType =
      profile && profile.type !== ActorType.SYSTEM
        ? (profile.type as 'human' | 'agent')
        : undefined;
    return {
      actorId: row.actorId,
      ...(actorType !== undefined ? { actorType } : {}),
      actorName: profile?.name ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      deletedAt: profile?.deletedAt ? profile.deletedAt.toISOString() : null,
      role: row.role,
      invitedBy: canSeeInvitedBy ? row.invitedBy : null,
      createdAt: row.createdAt,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 模块级错误构造（message 一律"英文指令 + 中文尾 + 明确下一步"）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 13004 —— 缺终审角色 / 缺成员管理权 / 缺判断日志读取权（三处共用此码，message 按场景给下一步）
 *
 * **13002（禁自审）已于 2026-09-24 随四态矩阵退役**（号不复用，见 shared enums 注释与
 * 线上 `docs/experience-base.md` §11 的决策记录）：终审资格如今是**纯角色判定**，
 * "这一条是不是你自己录的"不再参与判权——持角色者可以终审本人所录条目，可疑内容走
 * 双向门打 `suspect`。故本文件里已无第二个终审拒绝码可分。
 *
 * 导出给 `experience-judgment.service.ts` 复用（judgments 端点判权同为 13004）：
 * 同一错误码的文案必须有**单一事实源**，否则两条码文会在不同端点漂移。
 */
export function reviewForbidden(what: string): ForbiddenException {
  return new ForbiddenException({
    message:
      `You are not allowed to ${what}: this action requires a human admin or an experience space ` +
      'owner/reviewer role. Check the member list (GET /experiences/members) to see who can, then ' +
      'ask an admin to grant you the role. Do NOT retry as-is. ' +
      '需要 admin 或空间 owner/reviewer；成员清单见 GET /experiences/members',
    code: ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
  });
}

/** 13003 —— 目标 actor 不是经验空间成员（PATCH/DELETE 的成员行缺失；含"先核对清单"指引） */
function memberNotFound(actorId: string): NotFoundException {
  return new NotFoundException({
    message:
      `Actor '${actorId}' is not an experience space member. Check the member list ` +
      '(GET /experiences/members) for current actorIds and roles before retrying — do NOT repeat ' +
      'the same PATCH/DELETE, and do not use DELETE + POST to change a role (use PATCH). ' +
      '先核对成员清单（GET /experiences/members）',
    code: ErrorCode.EXPERIENCE_MEMBER_NOT_FOUND,
  });
}

/**
 * PG 唯一约束冲突判定（SQLSTATE 23505）。
 *
 * 为什么单独抽出来：本表主键是**业务键** `actor_id`，"并发同 actor 授权"是 23505 的
 * 正常形态而非系统故障——必须能被识别并收敛成幂等/冲突语义（照
 * `common/services/idempotency.helper.ts` 的 23505 path-winner 先例；该处额外比对
 * `constraint`，这里只有一条键可撞，故按码判定即可）。
 */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

/**
 * 409 —— 成员关系在本次操作过程中被并发改变到"无法收敛"的极窄状态（如 23505 回读为空：
 * 对方插入后又立刻删除）。
 *
 * 刻意**不复用** 13005（"已是成员异角色"）：那不是这个场景的语义。用通用 9001 +
 * message 明确"重读清单后重试"，避免消费方按 13005 的动作（走 PATCH）误入歧途。
 */
function concurrentMembershipChange(actorId: string): ConflictException {
  return new ConflictException({
    message:
      `Membership for actor '${actorId}' changed concurrently while this request was in flight, ` +
      'so the result is ambiguous. Re-read GET /experiences/members and retry — a retry is SAFE ' +
      '(same-role authorization is idempotent). 并发改动导致结果不确定：重读成员清单后重试',
    code: ErrorCode.RESOURCE_CONFLICT,
  });
}
