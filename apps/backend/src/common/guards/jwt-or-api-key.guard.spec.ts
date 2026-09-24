/**
 * JwtOrApiKeyGuard 单测（P2 批 2 / security B1-A）。
 *
 * 要证明的事（评审实证的认证绕过）：`findOne({ where: { id: payload.sub } })` 在
 * payload **无 sub** 时退化为 `where: {}`（TypeORM 默认静默丢条件），命中 users
 * 表首条用户 → 任何签名合法但无 sub 的 token（附件签名 token / refresh token /
 * 第三方 JWT）都能换取会话身份。
 *
 * 断言：形状检查必须发生在 **DB 查询之前**（repo.findOne 零调用是最强证据——
 * 只断言最终 401 无法区分"查了库但没命中"与"根本没查库"）。
 *
 * 同时钉死宽松语义不被改变：Bearer 分支失败（含形状断言失败）后仍走 API Key 兜底，
 * 两者都失败才 401 UNAUTHORIZED（存量行为，见 guard 类注释）。
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AgentStatus, ErrorCode, UserRole } from '@agent-chamber/shared';
import { JwtOrApiKeyGuard } from './jwt-or-api-key.guard';
import { ApiKeyAuthService } from '../services/api-key-auth.service';

describe('JwtOrApiKeyGuard（session 形状断言，security B1-A）', () => {
  const JWT_SECRET = 'test-secret';
  const USER_ID = '11111111-2222-3333-4444-555555555555';

  let guard: JwtOrApiKeyGuard;
  let jwtService: JwtService;
  let userRepo: { findOne: jest.Mock };
  let apiKeyAuth: { authenticate: jest.Mock };
  let request: Record<string, unknown>;

  /** 建 active human 用户行（guard 通过分支的最小形状） */
  const activeUser = () => ({
    id: USER_ID,
    email: 'u@example.com',
    role: UserRole.EDITOR,
    username: 'u',
    displayName: 'U',
    deletedAt: null,
    actor: { status: AgentStatus.ACTIVE, deletedAt: null },
  });

  const mockContext = (): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    jwtService = new JwtService({ secret: JWT_SECRET });
    userRepo = { findOne: jest.fn(async () => activeUser()) };
    apiKeyAuth = { authenticate: jest.fn() };
    request = { headers: {} };
    guard = new JwtOrApiKeyGuard(
      jwtService,
      {
        get: (key: string) => (key === 'jwt.secret' ? JWT_SECRET : undefined),
      } as unknown as ConfigService,
      userRepo as never,
      apiKeyAuth as unknown as ApiKeyAuthService,
    );
  });

  /** 生成带指定 payload 的合法签名 token */
  const bearer = (payload: Record<string, unknown>): Record<string, string> => ({
    authorization: `Bearer ${jwtService.sign(payload)}`,
  });

  it('存量形态 {sub:uuid,email,role} → 通过，挂 request.user（零兼容影响）', async () => {
    request.headers = bearer({ sub: USER_ID, email: 'u@example.com', role: UserRole.EDITOR });

    await expect(guard.canActivate(mockContext())).resolves.toBe(true);
    expect(userRepo.findOne).toHaveBeenCalledWith({
      where: { id: USER_ID },
      relations: { actor: true },
    });
    expect(request.user).toMatchObject({ userId: USER_ID, role: UserRole.EDITOR });
  });

  it('无 sub（附件签名 token 形态）→ 401 UNAUTHORIZED，且**不触达 DB**', async () => {
    request.headers = bearer({ aid: USER_ID, var: 'original', scope: 'attachment:content' });

    await expect(guard.canActivate(mockContext())).rejects.toThrow(UnauthorizedException);
    // 认证绕过的根因就在"用 undefined 当主键查库"：零调用是最强证据
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('空串 sub → 401，且不触达 DB', async () => {
    request.headers = bearer({ sub: '' });

    await expect(guard.canActivate(mockContext())).rejects.toThrow(UnauthorizedException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('非字符串 sub（数字）→ 401，且不触达 DB', async () => {
    request.headers = bearer({ sub: 12345 });

    await expect(guard.canActivate(mockContext())).rejects.toThrow(UnauthorizedException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('形状断言失败不影响宽松语义：同请求带合法 API Key → 走兜底并放行', async () => {
    request.headers = {
      ...bearer({ aid: USER_ID, scope: 'attachment:content' }),
      'x-api-key': 'ask_valid',
    };
    const agent = { id: 'agent-1', name: 'A', ownerId: USER_ID, permissions: {} };
    apiKeyAuth.authenticate.mockResolvedValue(agent);

    await expect(guard.canActivate(mockContext())).resolves.toBe(true);
    expect(apiKeyAuth.authenticate).toHaveBeenCalledWith('ask_valid');
    expect(request.agent).toBe(agent);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('形状断言失败且无 API Key → 401 UNAUTHORIZED（code 与既往一致）', async () => {
    request.headers = bearer({ aid: USER_ID });

    await expect(guard.canActivate(mockContext())).rejects.toMatchObject({
      response: { message: 'Authentication required', code: ErrorCode.UNAUTHORIZED },
    });
  });

  it('签名非法（不同密钥签发）→ 不查库，落 401（验签在断言之前）', async () => {
    const foreign = new JwtService({ secret: 'other-secret' }).sign({ sub: USER_ID });
    request.headers = { authorization: `Bearer ${foreign}` };

    await expect(guard.canActivate(mockContext())).rejects.toThrow(UnauthorizedException);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });
});
