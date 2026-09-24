import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AgentStatus, ErrorCode } from '@agent-chamber/shared';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../database/entities/user.entity';
import { hasSessionSubject } from '../../common/utils/session-token-shape';

/**
 * 会话 JWT 校验策略（passport 'jwt'，全局 JwtAuthGuard 的底层实现）。
 *
 * P2 批 2（security B1-A）：`validate` 首行加 session 形状断言（**DB 查询前**）——
 * payload 缺 sub / sub 为空串 / sub 非字符串时直接抛 TOKEN_INVALID，禁止把
 * `undefined` 当主键丢给 TypeORM（`findOne({id: undefined})` 会静默丢 WHERE 条件，
 * 命中 users 表首条用户 = 认证绕过；附件签名 token 正是无 sub 形态）。
 * 消息与既有失败分支一致（'User not found or inactive'），不回显具体断言——
 * 粗粒度不泄露 token 形状线索。
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('jwt.secret') || 'default-jwt-secret-change-me',
    });
  }

  async validate(payload: { sub: string; email: string; role: string }) {
    if (!hasSessionSubject(payload)) {
      throw new UnauthorizedException({
        message: 'User not found or inactive',
        code: ErrorCode.TOKEN_INVALID,
      });
    }
    const user = await this.userRepo.findOne({
      where: { id: payload.sub },
      relations: { actor: true },
    });
    if (
      !user ||
      user.actor?.status !== AgentStatus.ACTIVE ||
      user.actor?.deletedAt ||
      user.deletedAt
    ) {
      throw new UnauthorizedException({
        message: 'User not found or inactive',
        code: ErrorCode.TOKEN_INVALID,
      });
    }
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.displayName || user.username,
    };
  }
}
