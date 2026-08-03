import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { AgentStatus, ErrorCode } from '@agent-chamber/shared';

@Injectable()
export class JwtOrApiKeyGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(ApiKey)
    private apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization as string;
    const apiKeyHeader = request.headers['x-api-key'] as string;

    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const payload = this.jwtService.verify(token, {
          secret: this.configService.get('jwt.secret'),
        });
        const user = await this.userRepo.findOne({
          where: { id: payload.sub },
          relations: { actor: true },
        });
        if (
          user &&
          user.actor?.status === AgentStatus.ACTIVE &&
          !user.actor?.deletedAt &&
          !user.deletedAt
        ) {
          request.user = {
            userId: user.id,
            email: user.email,
            role: user.role,
            name: user.displayName || user.username,
          };
          return true;
        }
      } catch {
        // JWT failed, try API key
      }
    }

    if (apiKeyHeader) {
      try {
        const keyHash = crypto.createHash('sha256').update(apiKeyHeader).digest('hex');
        const apiKey = await this.apiKeyRepo.findOne({
          where: { keyHash },
          relations: ['agent'],
        });

        if (apiKey && !apiKey.revokedAt && !apiKey.deletedAt) {
          if (!apiKey.expiresAt || apiKey.expiresAt >= new Date()) {
            const agent = await this.agentRepo.findOne({
              where: { id: apiKey.agentId },
              relations: { actor: true },
            });
            if (agent && !agent.actor?.deletedAt && agent.actor?.status === AgentStatus.ACTIVE) {
              apiKey.lastUsedAt = new Date();
              await this.apiKeyRepo.save(apiKey);

              request.agent = {
                id: agent.id,
                name: agent.name,
                ownerId: agent.ownerId,
                permissions: apiKey.permissions,
              };
              return true;
            }
          }
        }
      } catch {
        // API key failed
      }
    }

    throw new UnauthorizedException({
      message: 'Authentication required',
      code: ErrorCode.UNAUTHORIZED,
    });
  }
}
