import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyAuthService, AgentPayload } from '../services/api-key-auth.service';

/**
 * JwtAuthGuard 单测（B-59，2026-08-31 全仓评审）
 *
 * 修复前：见 X-API-Key 头即 return true「放行不认证」——任何带垃圾 key 的请求
 * 都能绕过认证进入 controller（下游靠手工 403/404 兜底）。
 * 修复后：X-API-Key 头走真实 API Key 认证（复用 ApiKeyAuthService），成功挂
 * request.agent、失败抛 401（具体 code 由 service 抛出并原样透传，铁律 #9）。
 *
 * 测试面（铁律 #17）：
 * 1. @Public() 端点不受 X-API-Key 影响（优先放行）
 * 2. 合法 API Key → request.agent 正确挂载
 * 3. 垃圾 API Key → 401（旧行为是放行后 403/404）
 * 4. 无 X-API-Key → 委托 passport JWT 路径（纯 JWT 流程不变）
 */
describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let apiKeyAuth: { authenticate: jest.Mock };

  const mockAgentPayload: AgentPayload = {
    id: 'agent-1',
    name: 'Test Agent',
    ownerId: 'user-1',
    permissions: {},
  };

  /** 构造最小 ExecutionContext（headers 可注入） */
  const mockContext = (headers: Record<string, string | undefined>): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    apiKeyAuth = { authenticate: jest.fn() };
    guard = new JwtAuthGuard(
      reflector as unknown as Reflector,
      apiKeyAuth as unknown as ApiKeyAuthService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('should pass through for @Public() endpoints without touching API key auth', async () => {
    // @Public() 优先：即使带垃圾 X-API-Key 头也不要求 API Key 认证
    // （login/refresh/health 等公开端点不受 B-59 影响）
    reflector.getAllAndOverride.mockReturnValue(true);
    const context = mockContext({ 'x-api-key': 'garbage-key' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyAuth.authenticate).not.toHaveBeenCalled();
  });

  it('should authenticate a valid API key and mount request.agent (B-59)', async () => {
    apiKeyAuth.authenticate.mockResolvedValue(mockAgentPayload);
    const request: { headers: Record<string, string | undefined>; agent?: AgentPayload } = {
      headers: { 'x-api-key': 'valid-key' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyAuth.authenticate).toHaveBeenCalledWith('valid-key');
    // 与 JwtOrApiKeyGuard 同形状：挂 request.agent（@CurrentActor 可消费）
    expect(request.agent).toEqual(mockAgentPayload);
  });

  it('should throw 401 with the service error code when API key is invalid (B-59)', async () => {
    // 旧行为：放行不认证 → 下游 403/404；新行为：fail-closed 401，code 原样透传
    const serviceError = new UnauthorizedException({
      message: 'Invalid API Key',
      code: 1003, // ErrorCode.INVALID_API_KEY
    });
    apiKeyAuth.authenticate.mockRejectedValue(serviceError);
    const context = mockContext({ 'x-api-key': 'garbage-key' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 1003, message: 'Invalid API Key' },
    });
  });

  it('should delegate to the passport JWT path when no API key is present (pure JWT flow unchanged)', async () => {
    // 无 X-API-Key → 走 super.canActivate（passport jwt 策略），B-59 不触碰 JWT 路径
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentProto = Object.getPrototypeOf(JwtAuthGuard.prototype) as any;
    const spy = jest.spyOn(parentProto, 'canActivate').mockResolvedValue(true);
    const context = mockContext({});

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith(context);
    expect(apiKeyAuth.authenticate).not.toHaveBeenCalled();
  });
});
