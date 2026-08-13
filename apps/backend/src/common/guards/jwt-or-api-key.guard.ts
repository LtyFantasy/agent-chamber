/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *
 * [踩坑索引]
 *
 * [铁律关联] #9(代理层透传) #21(双层校验)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../database/entities/user.entity';
import { AgentStatus, ErrorCode } from '@agent-chamber/shared';
import { ApiKeyAuthService } from '../services/api-key-auth.service';

/**
 * JWT 优先、API Key 兜底的认证 guard（Bearer / X-API-Key 双通道）。
 *
 * M1 圆桌计划决策 4：API Key 分支已抽至 ApiKeyAuthService（严格语义：校验失败抛
 * 具体 code），本 guard 保留宽松语义——Bearer 失败或 API Key 校验抛错（含过期/
 * 吊销/agent 非 active 等全部拒绝路径）一律落入本分支的 catch，统一回
 * `Authentication required`（UNAUTHORIZED），与抽取前的 inline boolean 链行为等价。
 * 注意：ApiKeyAuthService 会同步写 lastUsedAt + 异步写 lastActiveAt（抽取前
 * JwtOrApiKeyGuard 只写 lastUsedAt，此为抽取统一带来的唯一差异，语义为「活跃时间
 * 更准确」，无客户端可见行为变化）。
 */
@Injectable()
export class JwtOrApiKeyGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private readonly apiKeyAuth: ApiKeyAuthService,
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
        request.agent = await this.apiKeyAuth.authenticate(apiKeyHeader);
        return true;
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
