/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *   - 补充: docs/api-definition.md §3. Auth
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（login/logout/register，
 *     actor=操作者语义决策 8，refresh 显式排除）
 *
 * [踩坑索引] （暂无重大踩坑）
 *
 * [铁律关联] #11(代理层透传)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { RefreshToken } from '../../database/entities/refresh-token.entity';
import { RegisterDto, LoginDto, RefreshTokenDto } from './dto';
import { UserRole, AgentStatus, ErrorCode, ActorType, AuditAction } from '@agent-chamber/shared';
import type { AuthResponse } from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(RefreshToken)
    private refreshTokenRepo: Repository<RefreshToken>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * 注册新用户（admin-only，plan shadowcat-sunspot-catwoman 决策 8）
   *
   * @param dto 注册表单
   * @param operatorActorId 操作者（admin）actor id——审计 actorId=操作者而非新用户
   *                        （与 login 的 actor=实体主体语义区分）；缺省兜底新用户自身
   */
  async register(dto: RegisterDto, operatorActorId?: string): Promise<AuthResponse> {
    const existing = await this.userRepo.findOne({
      where: { email: dto.email },
      withDeleted: true,
    });
    if (existing) {
      throw new ConflictException({
        message: 'Email already registered',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
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
      role: UserRole.EDITOR,
    });

    await this.userRepo.save(user);

    // 审计（决策 8）：actor=操作 admin（controller 传入）；实体=新用户
    // newData 白名单 {userId, username}（决策 6）——passwordHash/email 不入
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: user.id,
      actorId: operatorActorId ?? user.id,
      newData: { userId: user.id, username: user.username },
      source: 'api',
    });

    return this.generateTokens(user);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.actor', 'actor')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email: dto.email })
      .getOne();

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException({
        message: 'Invalid credentials',
        code: ErrorCode.TOKEN_INVALID,
      });
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException({
        message: 'Invalid credentials',
        code: ErrorCode.TOKEN_INVALID,
      });
    }

    if (user.status !== AgentStatus.ACTIVE) {
      throw new UnauthorizedException({
        message: 'Account is disabled',
        code: ErrorCode.AGENT_DISABLED,
      });
    }

    user.lastLoginAt = new Date();
    await this.userRepo.save(user);

    // 审计（决策 8）：LOGIN 行，actor=实体=登录用户自身；
    // newData 白名单 {userId, username}——失败 login 记不了（entity_id NOT NULL）
    await this.auditService.log({
      action: AuditAction.LOGIN,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: user.id,
      actorId: user.id,
      newData: { userId: user.id, username: user.username },
      source: 'api',
    });

    return this.generateTokens(user);
  }

  async refresh(dto: RefreshTokenDto): Promise<AuthResponse> {
    try {
      this.jwtService.verify(dto.refreshToken, {
        secret: this.configService.get('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException({
        message: 'Invalid refresh token',
        code: ErrorCode.TOKEN_INVALID,
      });
    }

    const tokenHash = crypto.createHash('sha256').update(dto.refreshToken).digest('hex');
    const refreshToken = await this.refreshTokenRepo.findOne({
      where: { tokenHash },
    });

    if (!refreshToken || refreshToken.revokedAt || refreshToken.expiresAt < new Date()) {
      throw new UnauthorizedException({
        message: 'Refresh token revoked or expired',
        code: ErrorCode.TOKEN_EXPIRED,
      });
    }

    // Revoke old token
    refreshToken.revokedAt = new Date();
    await this.refreshTokenRepo.save(refreshToken);

    const user = await this.userRepo.findOne({ where: { id: refreshToken.userId } });
    if (!user) {
      throw new UnauthorizedException({
        message: 'User not found',
        code: ErrorCode.TOKEN_INVALID,
      });
    }

    return this.generateTokens(user);
  }

  async logout(userId: string, refreshToken?: string) {
    // B-57 兜底（铁律 #21 第二层：service 负责业务存在性）：userId 为空（如 agent
    // 身份调 logout——B-59 后 guard 只挂 request.agent，request.user 不存在）→
    // fail-closed 明确拒绝，禁止静默成功。旧实现 userId=undefined 时
    // refreshTokenRepo.update 的 criteria 绑定 SQL NULL 恒不命中（撤销 0 行），
    // 且审计 entityId=undefined 违反 NOT NULL 落库失败被 fail-open 吞掉——
    // logout 实际是空操作却返回成功。
    if (!userId) {
      throw new ForbiddenException({
        message: 'Logout requires a human (JWT) session',
        code: ErrorCode.FORBIDDEN,
      });
    }
    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await this.refreshTokenRepo.update({ tokenHash, userId }, { revokedAt: new Date() });
    }

    // 审计（决策 8）：LOGOUT 行，actor=实体=登出用户自身
    await this.auditService.log({
      action: AuditAction.LOGOUT,
      entityType: AUDIT_ENTITY_TYPE.USER,
      entityId: userId,
      actorId: userId,
      newData: { userId },
      source: 'api',
    });

    return true;
  }

  private async generateTokens(user: User) {
    const payload = { sub: user.id, email: user.email, role: user.role };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get('jwt.secret'),
      expiresIn: this.configService.get('jwt.expiresIn') || '2h',
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get('jwt.refreshSecret'),
      expiresIn: this.configService.get('jwt.refreshExpiresIn') || '7d',
    });

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresInDays = 7;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    await this.refreshTokenRepo.save(
      this.refreshTokenRepo.create({
        userId: user.id,
        tokenHash,
        expiresAt,
      }),
    );

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: 7200,
      user: {
        id: user.id,
        email: user.email,
        name: user.displayName || user.username,
        role: user.role,
        avatar: user.avatarUrl,
      },
    };
  }
}
