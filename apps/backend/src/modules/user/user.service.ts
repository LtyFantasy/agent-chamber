/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *   - 补充: docs/api-definition.md §4.3-4.6 Admin users
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（user 写操作全量记，
 *     service 层插桩——实体已加载可拿 username；actor=自己（资料类）/操作 admin
 *     （admin 类，createByAdmin 改签名传操作者，auth register 先例）；newData
 *     {userId, username, 变更字段名列表}，passwordHash 黑名单）
 *
 * [踩坑索引] B-55(QueryBuilder orderBy select 风险) LEFTJOIN-SOFTDEL(左连接空虚满足软删过滤)
 *
 * [铁律关联] #21(双层校验) #22(findOne 判空) #11(注释) #23(jsonb/ORM 语义需真 PG 覆盖)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   LEFTJOIN-SOFTDEL: findAll 曾用 leftJoinAndSelect(actor) + 显式 `actor.deleted_at IS NULL`
 *         过滤软删用户，**生产实证真漏**（已软删用户被列表重新捞出）。软删标记
 *         只在 actors 行上（User 无 @DeleteDateColumn），TypeORM 把软删条件塞进 LEFT JOIN
 *         的 ON 子句；左连接下 ON 不匹配不丢行（actor 列全 NULL），显式 where 对 NULL 求值
 *         UNKNOWN（三值逻辑）空虚满足 → 过滤形同虚设。
 *         findAllLightweight 是同一 join 形状，但**并列的** `actor.status = :status` 谓词
 *         把 NULL 行排除掉，故**修复前侥幸不漏**——语义脆弱（该谓词一旦挪走/重排即复现），
 *         一并改 innerJoin 消隐患。
 *         修复与先例：两处 join 旁注释 + agent.service.ts `findAll`（同为"列表 +
 *         innerJoinAndSelect + 显式 deleted_at"）、notifications/notify-orchestrator.service.ts
 *         `resolveOwners`（同族 slug `NOTIFY-CANDIDATE-SOFTDELETED-LEAK`）。
 *         真 PG 覆盖：test/admin-user-delete.e2e-spec.ts（mock 单测证不了 SQL 语义）。
 *         同族第二处（卡 e6926d73）：auth.service.ts login/refresh 同形状漏软删——软删
 *         用户可用原密码登录并拿到 token；已改 innerJoin / 门前移，详见该文件 HOOK。
 *         本文件 5 处 `if (!user || !user.actor)` 守卫（getMe :85 / updateMe :93 /
 *         updateAvatar :216 / updateByAdmin :425 / deleteByAdmin :492）= 软删判定本体：
 *         `findOne({relations:{actor:true}})` 走 eager leftJoin，软删条件在 ON 子句 →
 *         软删行的 actor 列全 NULL → `!user.actor` 命中。原先并列的 `|| user.actor.deletedAt`
 *         是**死代码**（@DeleteDateColumn({select:false}) 该列永不进 SELECT，恒 undefined），
 *         已删——勿再补回；要改判据方向请先读本条与 A3-1b 先例 api-key-auth.service.ts:16-21。
 *   DEL-REVOKE: `deleteByAdmin` 是**事务化凭证吊销**（先 revoke 后软删，照
 *         agent.service.remove :789-804）——删人 ⇒ 该用户全部未撤销 refresh token +
 *         其名下 agent 的全部未撤销 API Key 一并置 revoked_at（`IsNull()` 限定条件，
 *         不覆写历史撤销时间戳）；agent 本体保持 active（Owner 拍板）。改动本方法时
 *         禁止把两步拆回非事务顺序：反序会留下"人已删、凭证仍活跃"的半完成态。
 *         真 PG 覆盖：test/soft-deleted-login.e2e-spec.ts。
 *   B-55: findAllLightweight 中 skip/take + 关联 join + orderBy('actor.displayName') +
 *         select() 未包含 actor 字段，触发 TypeORM 0.3.30
 *         `distinctAlias.actor_display_name does not exist` 生产 500。
 *         修复：select 显式包含 actor.displayName / actor.avatarUrl。
 *         见 memory/2026-07-02.md §1
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ErrorCode, UserRole, ActorType, AgentStatus } from '@agent-chamber/shared';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { RefreshToken } from '../../database/entities/refresh-token.entity';
import { buildAvatarUrl } from '../avatars/avatar.constants';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import type { PaginatedResponse, User as UserDto } from '@agent-chamber/shared';
import { CreateUserByAdminDto } from './dto/create-user-by-admin.dto';
import { UpdateUserByAdminDto } from './dto/update-user-by-admin.dto';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { AuditAction } from '@agent-chamber/shared';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private readonly auditService: AuditService,
  ) {}

  async getMe(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: { actor: true } });
    if (!user || !user.actor) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    return this.toProfile(user);
  }

  async updateMe(userId: string, dto: UpdateProfileDto) {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: { actor: true } });
    if (!user || !user.actor) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    if (dto.name !== undefined) {
      user.displayName = dto.name;
    }
    if (dto.avatar !== undefined) {
      user.avatarUrl = dto.avatar;
      // 联动清理：avatar 被清空或改为非本站 SVG 短链（外部 URL）时，
      // actors.avatar_svg 已成无引用的孤儿数据，一并清除，回落确定性生成头像
      if (dto.avatar !== buildAvatarUrl(user.actor.id)) {
        user.actor.avatarSvg = null;
      }
    }
    await this.userRepo.save(user);
    if (dto.preferences !== undefined) {
      // Notifications 二期堵旁门（两件事，都必须在**这一个**入口做）：
      // ① **剥掉 `notificationCategories`**：通知类别偏好有专门的面（`PUT/DELETE
      //    /notification-settings/me/prefs`，带自定义 validator + 原子键级合并）；从
      //    `/users/me` 的通用 preferences 旁路写它 = 绕过那层校验（拼错的键、非布尔值会静默落库）。
      // ② **原子顶层合并**（`coalesce(preferences,'{}') || $1`）替代"读到内存再整体 save"：
      //    后者在并发下会丢更新（两个请求各读到旧快照，后写的赢，先写的键消失）。
      //    ⚠️ 与 notification-settings 的**键级**合并刻意不同：这里是顶层键合并（`theme` 等
      //    其余偏好仍整体覆盖），那里是 `notificationCategories` 内的键级稀疏覆盖。
      //    ⚠️ 顺序：**在 save(user) 之后**——save 只写内存里变过的列（name/avatar），preferences
      //    未在内存中被改动故不进它的 UPDATE；此处的 SQL 才是 preferences 的唯一写路径。
      const patch = stripNotificationCategories(dto.preferences);
      await this.userRepo.query(
        `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [userId, JSON.stringify(patch)],
      );
      // 内存里的 user.preferences 已陈旧（原子 SQL 绕过了它）⇒ 重读一份给响应
      const fresh = await this.userRepo.findOne({ where: { id: userId } });
      if (fresh) user.preferences = fresh.preferences;
    }
    // 审计（Phase 2）：UPDATE + user；actor=自己；newData {userId, username, 变更字段名列表}
    // （决策 6——email/preferences 值不入，只记字段名）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: userId,
      actorId: userId,
      newData: {
        userId,
        username: user.username,
        changedFields: ['name', 'avatar', 'preferences'].filter(
          (f) => dto[f as keyof UpdateProfileDto] !== undefined,
        ),
      },
      source: 'api',
    });
    return this.toProfile(user);
  }

  async getSettings(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    return user.preferences || {};
  }

  async updateSettings(userId: string, dto: UpdateSettingsDto) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    // Notifications 二期堵旁门 + 原子合并（与 updateMe 同纪律，见那里的注释）：剥掉
    // `notificationCategories`（它有专门的面），并把"读内存再整体 save"换成原子顶层合并
    // （`ValidationPipe` 是裸的、无 whitelist ⇒ 未知属性会透传到这里，剥键必须在此做）。
    const patch = stripNotificationCategories(dto as Record<string, unknown>);
    await this.userRepo.query(
      `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [userId, JSON.stringify(patch)],
    );
    const fresh = await this.userRepo.findOne({ where: { id: userId } });
    if (fresh) user.preferences = fresh.preferences;
    // 审计（Phase 2）：UPDATE + user（settings）；actor=自己；newData 只记字段名
    // （决策 6——preferences 值不入）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: userId,
      actorId: userId,
      newData: { userId, username: user.username, changedFields: ['preferences'] },
      source: 'api',
    });
    return user.preferences;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :userId', { userId })
      .getOne();
    if (!user || !user.passwordHash) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new BadRequestException({
        message: 'Current password is incorrect',
        code: ErrorCode.USER_PASSWORD_INVALID,
      });
    }
    user.passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.userRepo.save(user);
    // 审计（Phase 2）：UPDATE + user（change-password）；actor=自己；newData 白名单
    // {userId, username}——passwordHash 显式黑名单（决策 6），永不入审计
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: userId,
      actorId: userId,
      newData: { userId, username: user.username },
      source: 'api',
    });
    return true;
  }

  async updateAvatar(userId: string, avatarUrl: string) {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: { actor: true } });
    if (!user || !user.actor) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    user.avatarUrl = avatarUrl;
    await this.userRepo.save(user);
    // 审计（Phase 2）：UPDATE + user（avatar）；actor=自己；newData {userId, username,
    // changedFields: ['avatar']}（决策 6——avatarUrl 值不入）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: userId,
      actorId: userId,
      newData: { userId, username: user.username, changedFields: ['avatar'] },
      source: 'api',
    });
    return this.toProfile(user);
  }

  /**
   * 分页查询用户列表（管理员）
   * @param query 查询参数，支持 q（搜索关键字）、page、pageSize
   * @returns 分页用户列表（toProfile 格式）
   */
  async findAll(query: {
    page?: string | number;
    pageSize?: string | number;
    q?: string;
  }): Promise<PaginatedResponse<UserDto>> {
    const page = Math.max(1, parseInt(String(query.page), 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(String(query.pageSize), 10) || 20));
    const q = query.q ? String(query.q).trim() : '';

    // ⚠️ 必须 `innerJoinAndSelect`，不能用 `leftJoinAndSelect`：
    // 软删标记只落在 `actors.deleted_at`（User 实体没有 @DeleteDateColumn，只有 delegating
    // getter/setter），TypeORM 会把 Actor 的软删条件自动追加到 JOIN 的 **ON 子句**。
    // 左连接语义下，"ON 不匹配"不丢行——软删 actor 的用户行照样返回，只是 actor 列全 NULL；
    // 而显式 `.where('actor.deleted_at IS NULL')` 对 NULL 求值为 UNKNOWN（三值逻辑），
    // **空虚满足**，过滤形同虚设 → 已软删用户被列表重新捞出，且因 actor=null 而看起来像活人：
    // status getter 回落 `'active'`（:49-51）、displayName getter 回落 `null`（:27-29）、
    // createdAt getter 无兜底变 `undefined`（:60-62）——合起来看就像个活人。
    // 改 innerJoin 后 ON 条件参与行匹配，软删 actor 的行才真正被丢弃。
    // 同类先例：agent.service.ts `findAll`（列表 + innerJoinAndSelect + 显式 deleted_at）、
    // notifications/notify-orchestrator.service.ts `resolveOwners`（完整说明见其
    // `NOTIFY-CANDIDATE-SOFTDELETED-LEAK`）。
    const qb = this.userRepo
      .createQueryBuilder('user')
      .innerJoinAndSelect('user.actor', 'actor')
      .where('actor.deleted_at IS NULL')
      .orderBy('actor.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (q) {
      qb.andWhere('(user.email ILIKE :q OR actor.display_name ILIKE :q)', { q: `%${q}%` });
    }

    const [users, total] = await qb.getManyAndCount();

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: users.map((user) => this.toProfile(user)),
      total,
      page,
      pageSize,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * 轻量查询用户列表（供前端下拉选择）
   * @param query 查询参数，支持 q（搜索关键字）、page、pageSize
   * @returns 轻量用户列表（仅 id, name, avatarUrl, role）
   */
  async findAllLightweight(query: {
    page?: string | number;
    pageSize?: string | number;
    q?: string;
  }) {
    const page = Math.max(1, parseInt(String(query.page), 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(String(query.pageSize), 10) || 50));
    const q = query.q ? String(query.q).trim() : '';

    /**
     * 必须显式选择 orderBy 依赖的 actor 字段。
     * TypeORM 0.3.30 在 skip/take + 关联 join + orderBy(关联字段) + select(不含该字段) 时，
     * 生成 count 子查询会出现 `distinctAlias.actor_display_name does not exist` 错误。
     *
     * ⚠️ `innerJoin` 而非 `leftJoin`：软删条件被 ORM 塞进 JOIN 的 ON 子句，左连接下软删
     * actor 的行不丢（actor 列全 NULL），显式 `actor.deleted_at IS NULL` 被 NULL 空虚满足。
     * 本查询修复前**侥幸不漏**——靠并列的 `andWhere('actor.status = :status')` 把 NULL 行
     * 排除（`NULL = 'active'` 为 UNKNOWN）；这是运气不是设计，该谓词一旦挪走/重排即复现
     * findAll 的漏洞，故同样改 innerJoin 消隐患。见 findAll 处注释与先例
     * agent.service.ts `findAll`、notifications/notify-orchestrator.service.ts `resolveOwners`
     * （同族 slug `NOTIFY-CANDIDATE-SOFTDELETED-LEAK`）。
     */
    const qb = this.userRepo
      .createQueryBuilder('user')
      .select(['user.id', 'user.username', 'user.role', 'actor.displayName', 'actor.avatarUrl'])
      .innerJoin('user.actor', 'actor')
      .where('actor.deleted_at IS NULL')
      .andWhere('actor.status = :status', { status: AgentStatus.ACTIVE })
      .orderBy('actor.displayName', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (q) {
      qb.andWhere('(actor.display_name ILIKE :q OR user.email ILIKE :q)', { q: `%${q}%` });
    }

    const [users, total] = await qb.getManyAndCount();

    const items = users.map((user) => ({
      id: user.id,
      name: user.displayName || user.username,
      avatarUrl: user.avatarUrl,
      role: user.role,
    }));

    const totalPages = Math.ceil(total / pageSize);
    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * 管理员创建用户
   * @param dto 创建用户数据
   * @param operatorActorId 操作者（admin）actor id——审计 actorId=操作 admin 本人
   *                        （决策 8，auth register 同款语义；缺省兜底新用户自身）
   * @returns 创建成功的用户资料
   * @throws ConflictException 当 email 已存在时
   */
  async createByAdmin(dto: CreateUserByAdminDto, operatorActorId?: string) {
    const existing = await this.userRepo.findOne({
      where: { email: dto.email },
      relations: { actor: true },
      withDeleted: true,
    });
    if (existing) {
      throw new ConflictException({
        message: 'Email already exists',
        code: ErrorCode.USER_EMAIL_EXISTS,
      });
    }

    // 管理员唯一性：若尝试创建 admin，检查是否已有其他 admin
    if (dto.role === UserRole.ADMIN) {
      const adminExists = await this.hasOtherAdmin();
      if (adminExists) {
        throw new ConflictException({
          message: 'An admin already exists',
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const actor = new Actor();
    actor.type = ActorType.HUMAN;
    actor.displayName = dto.name;
    actor.status = AgentStatus.ACTIVE;
    await this.userRepo.manager.save(actor);

    const user = this.userRepo.create({
      id: actor.id,
      actor,
      email: dto.email,
      username: dto.email.split('@')[0] + '_' + Math.random().toString(36).substring(2, 6),
      passwordHash,
      role: dto.role ?? UserRole.EDITOR,
    });

    await this.userRepo.save(user);
    // 审计（Phase 2）：CREATE + user；actor=操作 admin（controller 传入，决策 8）；
    // newData 白名单 {userId, username, role?}（决策 6——email/passwordHash 不入）
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: user.id,
      actorId: operatorActorId ?? user.id,
      newData: {
        userId: user.id,
        username: user.username,
        ...(user.role !== undefined && { role: user.role }),
      },
      source: 'api',
    });
    return this.toProfile(user);
  }

  /**
   * 管理员更新用户
   * @param id 目标用户 ID
   * @param dto 更新数据
   * @param currentAdminId 当前管理员自身 ID（用于自保护）
   * @returns 更新后的用户资料
   * @throws NotFoundException 用户不存在时
   * @throws BadRequestException 管理员尝试降级自己时
   */
  async updateByAdmin(id: string, dto: UpdateUserByAdminDto, currentAdminId: string) {
    const user = await this.userRepo.findOne({ where: { id }, relations: { actor: true } });
    if (!user || !user.actor) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }

    // 管理员自保护：禁止降级自己
    if (id === currentAdminId && dto.role !== undefined && dto.role !== UserRole.ADMIN) {
      throw new BadRequestException({
        message: 'Cannot downgrade yourself',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    // 管理员唯一性：若尝试将他人提升为 admin，检查是否已有其他 admin（允许自我降级）
    if (dto.role === UserRole.ADMIN && user.role !== UserRole.ADMIN) {
      const adminExists = await this.hasOtherAdmin();
      if (adminExists) {
        throw new ConflictException({
          message: 'An admin already exists',
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
    }

    if (dto.name !== undefined) {
      user.displayName = dto.name;
    }
    if (dto.role !== undefined) {
      user.role = dto.role;
    }
    if (dto.status !== undefined) {
      user.status = dto.status;
    }

    await this.userRepo.save(user);
    // 审计（Phase 2）：UPDATE + user（admin 操作）；actor=操作 admin 本人；
    // newData {userId, username, 变更字段名列表}（决策 6——email 不入）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: id,
      actorId: currentAdminId,
      newData: {
        userId: id,
        username: user.username,
        changedFields: ['name', 'role', 'status'].filter(
          (f) => dto[f as keyof UpdateUserByAdminDto] !== undefined,
        ),
      },
      source: 'api',
    });
    return this.toProfile(user);
  }

  /**
   * 管理员删除用户（软删 + 事务化凭证吊销，卡 e6926d73）
   *
   * Owner 2026-10-16 拍板：**删人 = 同事务吊销其名下全部凭证**（refresh token + 名下
   * agent 的 API Key）；**agent 本体保持 active**（孤儿 agent 的状态治理另行登记）。
   *
   * @param id 目标用户 ID
   * @param currentAdminId 当前管理员自身 ID（用于自保护）
   * @returns 是否删除成功
   * @throws NotFoundException 用户不存在时
   * @throws BadRequestException 管理员尝试删除自己时
   */
  async deleteByAdmin(id: string, currentAdminId: string) {
    const user = await this.userRepo.findOne({ where: { id }, relations: { actor: true } });
    if (!user || !user.actor) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }

    // 管理员自保护：禁止删除自己
    if (id === currentAdminId) {
      throw new BadRequestException({
        message: 'Cannot delete yourself',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    // 事务化吊销，顺序**先 revoke 后软删**（照 agent.service.remove :789-804 先例）：
    // revoke 抛错则整个事务回滚、用户仍存活可登录（可恢复）；反序会留下
    // "人已删、凭证仍活跃"的半完成态——旧实现正是如此：软删只写 actors.deleted_at，
    // 该用户的 refresh token 与其名下 agent 的 API Key 原样存活、无人撤销。
    // 用 manager.update / manager.createQueryBuilder 免改 UserModule 的 DI 注册面。
    await this.userRepo.manager.transaction(async (manager) => {
      const now = new Date();

      // ① 该用户全部未吊销的 refresh token。`IsNull()` 限定条件只打未撤销行，
      //    绝不覆写历史已撤销行的 revoked_at 时间戳（吊销时间不可变）。
      await manager.update(RefreshToken, { userId: id, revokedAt: IsNull() }, { revokedAt: now });

      // ② 其名下全部 agent 的未吊销 API Key（revokedReason 对齐 agent.service.ts:797
      //    先例的字段用法）。子查询一次更新，避免"先查 agent id 再 In()"的两趟往返；
      //    agent 本体保持 active（Owner 拍板），此处只动凭证。
      await manager
        .createQueryBuilder()
        .update(ApiKey)
        .set({ revokedAt: now, revokedReason: 'owner deleted' })
        .where('agent_id IN (SELECT id FROM agents WHERE owner_id = :id) AND revoked_at IS NULL', {
          id,
        })
        .execute();

      // ③ 软删除标记在 actor 表上（users 已不再持有 deleted_at）
      user.deletedAt = now;
      await manager.save(user);
    });

    // ④ 审计（Phase 2）：DELETE + user（admin 软删）；actor=操作 admin 本人；
    // newData 白名单 {userId, username}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: id,
      actorId: currentAdminId,
      newData: { userId: id, username: user.username },
      source: 'api',
    });
    return true;
  }

  /**
   * 检查是否已存在其他 admin 用户
   * @returns true 如果已有 admin 存在
   */
  private async hasOtherAdmin(): Promise<boolean> {
    const count = await this.userRepo
      .createQueryBuilder('user')
      .leftJoin('user.actor', 'actor')
      .where('user.role = :role', { role: UserRole.ADMIN })
      .andWhere('actor.status = :status', { status: AgentStatus.ACTIVE })
      .andWhere('actor.deleted_at IS NULL')
      .getCount();
    return count > 0;
  }

  private toProfile(user: User) {
    return {
      id: user.id,
      email: user.email,
      name: user.displayName || user.username,
      role: user.role,
      status: user.status,
      avatar: user.avatarUrl,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      preferences: user.preferences || {},
    };
  }
}

/**
 * `users.preferences` 里**通知类别偏好**的键名（Notifications 二期专用）。
 *
 * 它有专门的面（`PUT/DELETE /notification-settings/me/prefs`，带自定义 validator 与原子键级
 * 合并）——`/users/me` 与 `/users/me/settings` 的通用 preferences 写路径必须**剥掉**它，
 * 否则同一份数据有两条入口，其中一条（通用面）没有任何键/值校验。
 */
const NOTIFICATION_CATEGORIES_PREF_KEY = 'notificationCategories';

/**
 * 剥掉 `notificationCategories` 键（其余偏好原样保留）。
 *
 * 非对象入参一律返回 `{}`（jsonb 的 `||` 对非对象会报错，让一次畸形入参变成 500——
 * 铁律 #21：格式问题在本层收敛，不把畸形值透传给 PostgreSQL）。
 *
 * @param prefs 原始 preferences 补丁（DTO 已保证是对象；此处再兜一层防御）
 * @returns 去掉通知类别键后的补丁
 */
function stripNotificationCategories(
  prefs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(prefs)) {
    if (key === NOTIFICATION_CATEGORIES_PREF_KEY) continue;
    out[key] = value;
  }
  return out;
}
