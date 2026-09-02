/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 全局认证 guard（APP_GUARD）：JWT 与 API Key 双通道的默认认证入口
 *
 * [代码职责]
 *   - @Public() 端点优先放行；X-API-Key 头走真实 API Key 认证（B-59 起，不再
 *     「放行不认证」），成功挂 request.agent；无 X-API-Key 走 passport JWT 路径
 *
 * [权威文档]
 *   - 主文档: 线上 docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *
 * [关键不变量]
 *   - 见 X-API-Key 头必须真实认证：失败 401（code 由 ApiKeyAuthService 抛出），
 *     禁止放行不认证（B-59，2026-08-31 全仓评审）
 *   - API Key 认证成功只挂 request.agent（不挂 request.user）——下游 human-only
 *     端点（user.findAll / agent.findAll 等）依赖此判别
 *   - @Public() 优先于 X-API-Key 检查：公开端点不因携带 key 头而要求认证
 *
 * [关联代码]
 *   - common/guards/jwt-or-api-key.guard.ts — 双通道 guard（JWT 优先、API Key 兜底）
 *   - common/guards/api-key.guard.ts — 纯 API Key guard
 *   - common/services/api-key-auth.service.ts — API Key 认证单一事实来源
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyAuthService } from '../services/api-key-auth.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private readonly apiKeyAuth: ApiKeyAuthService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // @Public() 端点优先放行：不因携带 X-API-Key 头而要求 API Key 认证
    // （login/refresh/health 等公开端点不受影响）
    if (isPublic) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
    if (apiKeyHeader) {
      // B-59（2026-08-31 全仓评审）：见 X-API-Key 头不再「放行不认证」——改走真实
      // API Key 认证，与 JwtOrApiKeyGuard / ApiKeyGuard 共用 ApiKeyAuthService
      // （AuthModule @Global 导出，全局 APP_GUARD 可注入）。认证成功挂 request.agent
      // （与 JwtOrApiKeyGuard 同形状，@CurrentActor 可消费）；失败抛 401，具体 code
      // 由 ApiKeyAuthService 抛出（INVALID_API_KEY / TOKEN_EXPIRED / AGENT_NOT_FOUND /
      // AGENT_DISABLED），遵守错误码既有惯例（铁律 #9：不包装成 500）。
      request.agent = await this.apiKeyAuth.authenticate(apiKeyHeader);
      return true;
    }
    // 无 X-API-Key → 走 passport JWT 路径（基类签名允许 Observable，实际为 async
    // Promise<boolean>，await 后断言为 boolean）
    return (await super.canActivate(context)) as boolean;
  }

  // Passport IAuthGuard 基类签名要求参数为 any，保留以兼容第三方类型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest(err: any, user: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('Unauthorized');
    }
    return user;
  }
}
