import 'reflect-metadata';
import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ApiKeyAuthService } from '../../common/services/api-key-auth.service';
import { SKIP_USAGE_STATS_KEY } from './skip-usage-stats.decorator';
import { UsageEventsController } from './usage-events.controller';
import { UsageStatsBufferService } from './usage-stats-buffer.service';
import { UsageEventDto } from './dto/usage-event.dto';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * 上报端点单测：**认证契约**（双通道）+ **自统计排除** + **fail-open**。
 *
 * 认证用**真实 JwtOrApiKeyGuard 实例**验证（单测全局 overrideGuard 换的是放行桩，
 * 只断言元数据等于没断言）：未认证必须 401、API Key 与 JWT 两条通道都必须真的通。
 */
describe('UsageEventsController', () => {
  let controller: UsageEventsController;
  const mockBuffer = { recordInvocation: jest.fn() };

  const validEvent: UsageEventDto = {
    toolName: 'task',
    surface: 'mcp',
    ok: true,
    latencyMs: 42,
  };

  beforeEach(() => {
    controller = new UsageEventsController(mockBuffer as unknown as UsageStatsBufferService);
  });

  afterEach(() => jest.clearAllMocks());

  it('类级声明 JwtOrApiKeyGuard（Bearer 或 X-API-Key 双通道）', () => {
    const guards = (Reflect.getMetadata('__guards__', UsageEventsController) ?? []) as Array<{
      name?: string;
      constructor?: { name?: string };
    }>;
    const names = guards.map((g) => g?.name ?? g?.constructor?.name);
    expect(names).toContain('JwtOrApiKeyGuard');
  });

  it('handler 挂 @SkipUsageStats()（防自统计污染 channel=rest 口径）', () => {
    expect(
      Reflect.getMetadata(SKIP_USAGE_STATS_KEY, UsageEventsController.prototype.reportUsageEvent),
    ).toBe(true);
  });

  it('上报一次 → buffer 收到维度与身份（actorId 取 request.agent.id）', async () => {
    const result = await controller.reportUsageEvent(
      { agent: { id: AGENT_ID } } as unknown as Request,
      { ...validEvent, viaFallbackAuth: true },
    );

    expect(result).toEqual({ accepted: true });
    expect(mockBuffer.recordInvocation).toHaveBeenCalledWith({
      toolName: 'task',
      surface: 'mcp',
      ok: true,
      latencyMs: 42,
      viaFallbackAuth: true,
      actorId: AGENT_ID,
    });
  });

  it('人类 JWT 调用（无 request.agent）→ actorId 为 null（不混进 Agent 用量画像）', async () => {
    await controller.reportUsageEvent(
      { user: { userId: USER_ID } } as unknown as Request,
      validEvent,
    );

    expect(mockBuffer.recordInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: null }),
    );
  });

  it('agent 无 id → actorId 为 null（不产生空串身份）', async () => {
    await controller.reportUsageEvent({ agent: {} } as unknown as Request, validEvent);

    expect(mockBuffer.recordInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: null }),
    );
  });

  it('fail-open：buffer 抛错也只 warn，仍返回 accepted（上报失败不打成 5xx）', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockBuffer.recordInvocation.mockImplementation(() => {
      throw new Error('buffer exploded');
    });

    await expect(
      controller.reportUsageEvent({ agent: { id: AGENT_ID } } as unknown as Request, validEvent),
    ).resolves.toEqual({ accepted: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage event dropped'));

    warn.mockRestore();
  });
});

describe('UsageEventsController — 真实 JwtOrApiKeyGuard 双通道', () => {
  function buildGuard() {
    const jwtService = { verify: jest.fn() } as unknown as JwtService;
    const configService = { get: jest.fn(() => 'jwt-secret') } as unknown as ConfigService;
    const userRepo = { findOne: jest.fn() };
    const apiKeyAuth = { authenticate: jest.fn() } as unknown as ApiKeyAuthService;
    const guard = new JwtOrApiKeyGuard(
      jwtService,
      configService,
      userRepo as never,
      apiKeyAuth,
    );
    return { guard, jwtService, userRepo, apiKeyAuth };
  }

  function buildContext(request: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  it('未认证（无 Authorization / 无 X-API-Key）→ 401', async () => {
    const { guard } = buildGuard();

    await expect(guard.canActivate(buildContext({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('Agent API Key 通道：X-API-Key 认证成功 → 放行并挂 request.agent', async () => {
    const { guard, apiKeyAuth } = buildGuard();
    (apiKeyAuth.authenticate as jest.Mock).mockResolvedValue({ id: AGENT_ID, name: 'kimi-1' });
    const request: Record<string, unknown> = { headers: { 'x-api-key': 'key-123' } };

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    expect(request.agent).toMatchObject({ id: AGENT_ID });
  });

  it('Agent API Key 通道：key 无效 → 401', async () => {
    const { guard, apiKeyAuth } = buildGuard();
    (apiKeyAuth.authenticate as jest.Mock).mockRejectedValue(new Error('invalid key'));

    await expect(
      guard.canActivate(buildContext({ headers: { 'x-api-key': 'bad' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('human JWT 通道：Bearer 有效且用户 active → 放行并挂 request.user', async () => {
    const { guard, jwtService, userRepo } = buildGuard();
    (jwtService.verify as jest.Mock).mockReturnValue({ sub: USER_ID });
    userRepo.findOne.mockResolvedValue({
      id: USER_ID,
      email: 'admin@example.com',
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      deletedAt: null,
      actor: { status: 'active', deletedAt: null },
    });
    const request: Record<string, unknown> = { headers: { authorization: 'Bearer token' } };

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ userId: USER_ID, role: 'admin' });
  });

  it('human JWT 通道：用户已删除 → 401', async () => {
    const { guard, jwtService, userRepo } = buildGuard();
    (jwtService.verify as jest.Mock).mockReturnValue({ sub: USER_ID });
    userRepo.findOne.mockResolvedValue(null);

    await expect(
      guard.canActivate(buildContext({ headers: { authorization: 'Bearer token' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
