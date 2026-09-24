/**
 * JwtStrategy 单测（P2 批 2 / security B1-A）。
 *
 * 与 jwt-or-api-key.guard 同源的绕过面：passport 'jwt' 验签通过后，`validate` 直接把
 * `payload.sub` 当主键查库——无 sub 时 `findOne({id: undefined})` 被 TypeORM 静默丢
 * WHERE 条件，命中 users 表首条用户 = 认证绕过（全局 JwtAuthGuard 走的就是这条路径）。
 *
 * 断言：形状检查必须发生在 DB 查询之前（repo.findOne 零调用），失败抛 TOKEN_INVALID；
 * 合法 payload 的行为与既有实现逐字段一致（零兼容影响）。
 */
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus, ErrorCode, UserRole } from '@agent-chamber/shared';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy（session 形状断言，security B1-A）', () => {
  const USER_ID = '11111111-2222-3333-4444-555555555555';
  let strategy: JwtStrategy;
  let userRepo: { findOne: jest.Mock };

  /** 合法 payload 的完整形状（存量会话 token：auth.service generateTokens） */
  type SessionPayload = { sub: string; email: string; role: string };
  const session = (): SessionPayload => ({
    sub: USER_ID,
    email: 'u@example.com',
    role: UserRole.EDITOR,
  });

  const activeUser = () => ({
    id: USER_ID,
    email: 'u@example.com',
    role: UserRole.EDITOR,
    username: 'u',
    displayName: 'U',
    deletedAt: null,
    actor: { status: AgentStatus.ACTIVE, deletedAt: null },
  });

  beforeEach(() => {
    userRepo = { findOne: jest.fn(async () => activeUser()) };
    strategy = new JwtStrategy(
      {
        get: (key: string) => (key === 'jwt.secret' ? 'test-secret' : undefined),
      } as unknown as ConfigService,
      userRepo as never,
    );
  });

  it('无 sub（附件签名 token 形态）→ TOKEN_INVALID，且**不触达 DB**', async () => {
    await expect(
      strategy.validate({ aid: USER_ID, var: 'original', scope: 'attachment:content' } as never),
    ).rejects.toMatchObject({
      response: { message: 'User not found or inactive', code: ErrorCode.TOKEN_INVALID },
    });
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('空串 sub → TOKEN_INVALID，且不触达 DB', async () => {
    await expect(strategy.validate({ ...session(), sub: '' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('非字符串 sub（数字）→ TOKEN_INVALID，且不触达 DB', async () => {
    await expect(strategy.validate({ ...session(), sub: 42 } as never)).rejects.toMatchObject({
      response: { code: ErrorCode.TOKEN_INVALID },
    });
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('存量形态 {sub:uuid,email,role} → 正常通过（返回 actor 身份，零兼容影响）', async () => {
    await expect(strategy.validate(session())).resolves.toEqual({
      userId: USER_ID,
      email: 'u@example.com',
      role: UserRole.EDITOR,
      name: 'U',
    });
    expect(userRepo.findOne).toHaveBeenCalledWith({
      where: { id: USER_ID },
      relations: { actor: true },
    });
  });

  it('形状合法但用户不存在/非 active → 仍是 TOKEN_INVALID（既有分支不变）', async () => {
    userRepo.findOne.mockResolvedValue(null);
    await expect(strategy.validate(session())).rejects.toMatchObject({
      response: { code: ErrorCode.TOKEN_INVALID },
    });

    userRepo.findOne.mockResolvedValue({
      ...activeUser(),
      actor: { status: AgentStatus.DISABLED, deletedAt: null },
    });
    await expect(strategy.validate(session())).rejects.toMatchObject({
      response: { code: ErrorCode.TOKEN_INVALID },
    });
  });
});
