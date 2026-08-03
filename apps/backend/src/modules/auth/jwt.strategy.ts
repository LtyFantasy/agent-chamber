import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AgentStatus, ErrorCode } from '@agent-chamber/shared';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../database/entities/user.entity';

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
