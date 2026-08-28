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
 * [踩坑索引] B-55(QueryBuilder orderBy select 风险)
 *
 * [铁律关联] #21(双层校验) #22(findOne 判空) #11(注释)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   B-55: findAllLightweight 中 skip/take + leftJoin + orderBy('actor.displayName') +
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
import { ErrorCode, UserRole, ActorType } from '@agent-chamber/shared';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import type { PaginatedResponse, User as UserDto } from '@agent-chamber/shared';
import { CreateUserByAdminDto } from './dto/create-user-by-admin.dto';
import { UpdateUserByAdminDto } from './dto/update-user-by-admin.dto';
import { AuditService } from '../audit/audit.service';
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
    if (!user || !user.actor || user.actor.deletedAt) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    return this.toProfile(user);
  }

  async updateMe(userId: string, dto: UpdateProfileDto) {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: { actor: true } });
    if (!user || !user.actor || user.actor.deletedAt) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    if (dto.name !== undefined) {
      user.displayName = dto.name;
    }
    if (dto.avatar !== undefined) {
      user.avatarUrl = dto.avatar;
      // 联动清理：avatar 被清空或改为非本站 SVG 短链（外部 URL）时，
      // actors.avatar_svg 已成无引用的孤儿数据，一并清除，回落确定性生成头像
      if (dto.avatar !== `/api/v1/avatars/${user.actor.id}.svg`) {
        user.actor.avatarSvg = null;
      }
    }
    if (dto.preferences !== undefined) {
      user.preferences = { ...user.preferences, ...dto.preferences };
    }
    await this.userRepo.save(user);
    // 审计（Phase 2）：UPDATE + user；actor=自己；newData {userId, username, 变更字段名列表}
    // （决策 6——email/preferences 值不入，只记字段名）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: 'user',
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
    user.preferences = { ...user.preferences, ...dto };
    await this.userRepo.save(user);
    // 审计（Phase 2）：UPDATE + user（settings）；actor=自己；newData 只记字段名
    // （决策 6——preferences 值不入）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: 'user',
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
      entityType: 'user',
      entityId: userId,
      actorId: userId,
      newData: { userId, username: user.username },
      source: 'api',
    });
    return true;
  }

  async updateAvatar(userId: string, avatarUrl: string) {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: { actor: true } });
    if (!user || !user.actor || user.actor.deletedAt) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }
    user.avatarUrl = avatarUrl;
    await this.userRepo.save(user);
    // 审计（Phase 2）：UPDATE + user（avatar）；actor=自己；newData {userId, username,
    // changedFields: ['avatar']}（决策 6——avatarUrl 值不入）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: 'user',
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

    const qb = this.userRepo
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.actor', 'actor')
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
     * TypeORM 0.3.30 在 skip/take + leftJoin + orderBy(关联字段) + select(不含该字段) 时，
     * 生成 count 子查询会出现 `distinctAlias.actor_display_name does not exist` 错误。
     */
    const qb = this.userRepo
      .createQueryBuilder('user')
      .select(['user.id', 'user.username', 'user.role', 'actor.displayName', 'actor.avatarUrl'])
      .leftJoin('user.actor', 'actor')
      .where('actor.deleted_at IS NULL')
      .andWhere('actor.status = :status', { status: 'active' })
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
    actor.status = 'active';
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
      entityType: 'user',
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
    if (!user || !user.actor || user.actor.deletedAt) {
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
      entityType: 'user',
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
   * 管理员删除用户（软删除）
   * @param id 目标用户 ID
   * @param currentAdminId 当前管理员自身 ID（用于自保护）
   * @returns 是否删除成功
   * @throws NotFoundException 用户不存在时
   * @throws BadRequestException 管理员尝试删除自己时
   */
  async deleteByAdmin(id: string, currentAdminId: string) {
    const user = await this.userRepo.findOne({ where: { id }, relations: { actor: true } });
    if (!user || !user.actor || user.actor.deletedAt) {
      throw new NotFoundException({ message: 'User not found', code: ErrorCode.USER_NOT_FOUND });
    }

    // 管理员自保护：禁止删除自己
    if (id === currentAdminId) {
      throw new BadRequestException({
        message: 'Cannot delete yourself',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    // 软删除标记在 actor 表上（users 已不再持有 deleted_at）
    user.deletedAt = new Date();
    await this.userRepo.save(user);
    // 审计（Phase 2）：DELETE + user（admin 软删）；actor=操作 admin 本人；
    // newData 白名单 {userId, username}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: 'user',
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
      .andWhere('actor.status = :status', { status: 'active' })
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
