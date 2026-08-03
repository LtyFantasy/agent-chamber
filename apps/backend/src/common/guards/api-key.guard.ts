import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { AgentStatus, ErrorCode } from '@agent-chamber/shared';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @InjectRepository(ApiKey)
    private apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKeyHeader = request.headers['x-api-key'] as string;

    if (!apiKeyHeader) {
      throw new UnauthorizedException({
        message: 'API Key required',
        code: ErrorCode.INVALID_API_KEY,
      });
    }

    const keyHash = crypto.createHash('sha256').update(apiKeyHeader).digest('hex');

    const apiKey = await this.apiKeyRepo.findOne({
      where: { keyHash },
      relations: ['agent'],
    });

    if (!apiKey) {
      throw new UnauthorizedException({
        message: 'Invalid API Key',
        code: ErrorCode.INVALID_API_KEY,
      });
    }

    if (apiKey.revokedAt || apiKey.deletedAt) {
      throw new UnauthorizedException({
        message: 'API Key has been revoked',
        code: ErrorCode.INVALID_API_KEY,
      });
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException({
        message: 'API Key has expired',
        code: ErrorCode.TOKEN_EXPIRED,
      });
    }

    const agent = await this.agentRepo.findOne({
      where: { id: apiKey.agentId },
      relations: { actor: true },
    });

    if (!agent || agent.actor?.deletedAt) {
      throw new UnauthorizedException({
        message: 'Agent not found',
        code: ErrorCode.AGENT_NOT_FOUND,
      });
    }

    if (agent.actor?.status !== AgentStatus.ACTIVE) {
      throw new UnauthorizedException({
        message: 'Agent is not active',
        code: ErrorCode.AGENT_DISABLED,
      });
    }

    // Update last used
    apiKey.lastUsedAt = new Date();
    await this.apiKeyRepo.save(apiKey);

    // Update agent lastActiveAt asynchronously (non-blocking)
    agent.lastActiveAt = new Date();
    this.agentRepo.save(agent).catch(() => {});

    request.agent = {
      id: agent.id,
      name: agent.name,
      ownerId: agent.ownerId,
      permissions: apiKey.permissions,
    };

    return true;
  }
}
