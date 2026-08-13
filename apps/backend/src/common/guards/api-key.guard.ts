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
import { ErrorCode } from '@agent-chamber/shared';
import { ApiKeyAuthService } from '../services/api-key-auth.service';

/**
 * 纯 API Key 认证 guard（X-API-Key header）。
 *
 * M1 圆桌计划决策 4：认证逻辑已抽至 ApiKeyAuthService（本 guard 与 JwtOrApiKeyGuard、
 * 后续 WS 握手三方共用），本 guard 只保留职责：① 缺 key 报错（专属于本 guard 的
 * 严格语义——缺失即 401 且 code=INVALID_API_KEY）；② 调 service 并把 AgentPayload
 * 挂到 request.agent。行为与抽取前逐行等价。
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeyAuth: ApiKeyAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKeyHeader = request.headers['x-api-key'] as string;

    if (!apiKeyHeader) {
      throw new UnauthorizedException({
        message: 'API Key required',
        code: ErrorCode.INVALID_API_KEY,
      });
    }

    request.agent = await this.apiKeyAuth.authenticate(apiKeyHeader);

    return true;
  }
}
