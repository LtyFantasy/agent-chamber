import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Hash } from 'crypto';
import { AuthService } from './auth.service';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { RefreshToken } from '../../database/entities/refresh-token.entity';
import { RegisterDto, LoginDto, RefreshTokenDto } from './dto';
import { UserRole, ActorType, AuditAction } from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('crypto', () => ({
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mocked-hash'),
  })),
}));

function createMockRepo<T extends ObjectLiteral>() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    softRemove: jest.fn(),
    count: jest.fn(),
    countBy: jest.fn(),
    update: jest.fn(),
    manager: {
      save: jest.fn().mockImplementation((entity) => {
        if (!entity.id) {
          entity.id = 'user-1';
        }
        return Promise.resolve(entity);
      }),
    },
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
    })),
  } as unknown as jest.Mocked<Repository<T>>;
}

function createMockUser(overrides: Partial<User> & Partial<Actor> = {}): User {
  const actor = new Actor();
  actor.id = overrides.id ?? 'user-1';
  actor.type = ActorType.HUMAN;
  actor.displayName = overrides.displayName ?? 'Test User';
  actor.avatarUrl = overrides.avatarUrl ?? null;
  actor.status = (overrides.status as string) ?? 'active';
  actor.createdAt = overrides.createdAt ?? new Date('2024-01-01');
  actor.updatedAt = overrides.updatedAt ?? new Date('2024-01-01');
  actor.deletedAt = overrides.deletedAt ?? null;
  if (overrides.actor) {
    Object.assign(actor, overrides.actor);
  }

  const user = new User();
  user.id = overrides.id ?? 'user-1';
  user.actor = actor;
  user.username = overrides.username ?? 'testuser';
  user.email = overrides.email ?? 'test@example.com';
  user.passwordHash = overrides.passwordHash ?? 'hashed-password';
  user.authProvider = (overrides as any).authProvider ?? 'local';
  user.authProviderId = (overrides as any).authProviderId ?? null;
  user.role = overrides.role ?? UserRole.EDITOR;
  user.preferences = overrides.preferences ?? {};
  user.lastLoginAt = overrides.lastLoginAt ?? null;
  user.agents = [];
  user.refreshTokens = [];
  return user;
}

function createMockRefreshToken(overrides: Partial<RefreshToken> = {}): RefreshToken {
  return {
    id: 'rt-1',
    userId: 'user-1',
    tokenHash: 'mocked-hash',
    expiresAt: new Date('2099-12-31'),
    revokedAt: null,
    ipAddress: null,
    userAgent: null,
    createdAt: new Date('2024-01-01'),
    user: createMockUser(),
    ...overrides,
  } as RefreshToken;
}

describe('AuthService', () => {
  let service: AuthService;
  let mockUserRepo: jest.Mocked<Repository<User>>;
  let mockRefreshTokenRepo: jest.Mocked<Repository<RefreshToken>>;
  let mockJwtService: { sign: jest.Mock; verify: jest.Mock };
  let mockConfigService: { get: jest.Mock };
  let mockAuditService: { log: jest.Mock };

  beforeEach(async () => {
    // NestJS module-token-factory uses crypto.createHash to generate module tokens.
    // If createHash always returns the same value, module tokens collide and providers
    // cannot be resolved. We temporarily return unique values during compilation.
    let hashCounter = 0;
    jest.mocked(crypto.createHash).mockImplementation(
      () =>
        ({
          update: jest.fn().mockReturnThis(),
          digest: jest.fn().mockReturnValue(`unique-hash-${++hashCounter}`),
        }) as unknown as Hash,
    );

    mockUserRepo = createMockRepo<User>();
    mockRefreshTokenRepo = createMockRepo<RefreshToken>();

    mockJwtService = {
      sign: jest.fn(() => 'mocked-jwt-token'),
      verify: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, string> = {
          'jwt.secret': 'test-secret',
          'jwt.refreshSecret': 'test-refresh-secret',
          'jwt.expiresIn': '2h',
          'jwt.refreshExpiresIn': '7d',
        };
        return config[key];
      }),
    };

    mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(RefreshToken), useValue: mockRefreshTokenRepo },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = moduleRef.get<AuthService>(AuthService);

    // Restore createHash to return predictable 'mocked-hash' for service tests
    jest.mocked(crypto.createHash).mockImplementation(
      () =>
        ({
          update: jest.fn().mockReturnThis(),
          digest: jest.fn().mockReturnValue('mocked-hash'),
        }) as unknown as Hash,
    );

    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should register a new user and return tokens', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);
      mockUserRepo.create.mockReturnValue(createMockUser());
      mockUserRepo.save.mockResolvedValue(createMockUser());
      mockRefreshTokenRepo.create.mockReturnValue(createMockRefreshToken());
      mockRefreshTokenRepo.save.mockResolvedValue(createMockRefreshToken());

      const dto: RegisterDto = {
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
      };

      const result = await service.register(dto);

      expect(mockUserRepo.findOne).toHaveBeenCalledWith({
        where: { email: dto.email },
        withDeleted: true,
      });
      expect(mockUserRepo.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ type: ActorType.HUMAN, displayName: dto.name, status: 'active' }),
      );
      expect(bcrypt.hash).toHaveBeenCalledWith(dto.password, 12);
      expect(mockUserRepo.save).toHaveBeenCalled();
      // 审计（Phase 2）：register → CREATE + user；actor=操作者（未传 → 兜底新用户）
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: AuditAction.CREATE,
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'user-1',
        newData: { userId: 'user-1', username: 'testuser' },
        source: 'api',
      });
      expect(result).toEqual({
        accessToken: 'mocked-jwt-token',
        refreshToken: 'mocked-jwt-token',
        tokenType: 'Bearer',
        expiresIn: 7200,
        user: {
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          role: UserRole.EDITOR,
          avatar: null,
        },
      });
    });

    it('should throw ConflictException when email already exists', async () => {
      mockUserRepo.findOne.mockResolvedValue(createMockUser());

      const dto: RegisterDto = {
        email: 'test@example.com',
        password: 'password123',
        name: 'New User',
      };

      await expect(service.register(dto)).rejects.toThrow(ConflictException);
      expect(mockUserRepo.findOne).toHaveBeenCalledWith({
        where: { email: dto.email },
        withDeleted: true,
      });
    });
  });

  describe('login', () => {
    const mockLoginQuery = (user: User | null) => {
      (mockUserRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn(),
        getMany: jest.fn(),
        getOne: jest.fn().mockResolvedValue(user),
      });
    };

    it('should login and return tokens', async () => {
      const user = createMockUser();
      mockLoginQuery(user);
      jest.mocked(bcrypt.compare).mockResolvedValue(true as never);
      mockUserRepo.save.mockResolvedValue(user);
      mockRefreshTokenRepo.create.mockReturnValue(createMockRefreshToken());
      mockRefreshTokenRepo.save.mockResolvedValue(createMockRefreshToken());

      const dto: LoginDto = {
        email: 'test@example.com',
        password: 'password123',
      };

      const result = await service.login(dto);

      expect(mockUserRepo.createQueryBuilder).toHaveBeenCalledWith('user');
      expect(bcrypt.compare).toHaveBeenCalledWith(dto.password, user.passwordHash);
      expect(user.lastLoginAt).toBeInstanceOf(Date);
      expect(mockUserRepo.save).toHaveBeenCalledWith(user);
      // 审计（Phase 2）：login → LOGIN + user；actor=实体=登录者自身；newData 无敏感字段
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: AuditAction.LOGIN,
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'user-1',
        newData: { userId: 'user-1', username: 'testuser' },
        source: 'api',
      });
      expect(result).toEqual({
        accessToken: 'mocked-jwt-token',
        refreshToken: 'mocked-jwt-token',
        tokenType: 'Bearer',
        expiresIn: 7200,
        user: {
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          role: UserRole.EDITOR,
          avatar: null,
        },
      });
    });

    it('should throw UnauthorizedException when user not found', async () => {
      mockLoginQuery(null);

      const dto: LoginDto = {
        email: 'notfound@example.com',
        password: 'password123',
      };

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when password is incorrect', async () => {
      const user = createMockUser();
      mockLoginQuery(user);
      jest.mocked(bcrypt.compare).mockResolvedValue(false as never);

      const dto: LoginDto = {
        email: 'test@example.com',
        password: 'wrongpassword',
      };

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(bcrypt.compare).toHaveBeenCalledWith(dto.password, user.passwordHash);
    });

    it('should throw UnauthorizedException when user status is disabled', async () => {
      const user = createMockUser({ status: 'disabled' });
      mockLoginQuery(user);
      jest.mocked(bcrypt.compare).mockResolvedValue(true as never);

      const dto: LoginDto = {
        email: 'test@example.com',
        password: 'password123',
      };

      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(bcrypt.compare).toHaveBeenCalledWith(dto.password, user.passwordHash);
    });

    it('should allow login when user status is active', async () => {
      const user = createMockUser({ status: 'active' });
      mockLoginQuery(user);
      jest.mocked(bcrypt.compare).mockResolvedValue(true as never);
      mockUserRepo.save.mockResolvedValue(user);
      mockRefreshTokenRepo.create.mockReturnValue(createMockRefreshToken());
      mockRefreshTokenRepo.save.mockResolvedValue(createMockRefreshToken());

      const dto: LoginDto = {
        email: 'test@example.com',
        password: 'password123',
      };

      const result = await service.login(dto);

      expect(result).toEqual({
        accessToken: 'mocked-jwt-token',
        refreshToken: 'mocked-jwt-token',
        tokenType: 'Bearer',
        expiresIn: 7200,
        user: {
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          role: UserRole.EDITOR,
          avatar: null,
        },
      });
    });
  });

  describe('refresh', () => {
    it('should refresh tokens successfully', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 'user-1' });
      const refreshToken = createMockRefreshToken();
      mockRefreshTokenRepo.findOne.mockResolvedValue(refreshToken);
      mockRefreshTokenRepo.save.mockResolvedValue(refreshToken);
      mockRefreshTokenRepo.create.mockReturnValue(createMockRefreshToken());
      mockUserRepo.findOne.mockResolvedValue(createMockUser());

      const dto: RefreshTokenDto = {
        refreshToken: 'valid-refresh-token',
      };

      const result = await service.refresh(dto);

      expect(mockJwtService.verify).toHaveBeenCalledWith(dto.refreshToken, {
        secret: 'test-refresh-secret',
      });
      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
      expect(mockRefreshTokenRepo.findOne).toHaveBeenCalledWith({
        where: { tokenHash: 'mocked-hash' },
      });
      expect(mockUserRepo.findOne).toHaveBeenCalledWith({ where: { id: refreshToken.userId } });
      expect(refreshToken.revokedAt).toBeInstanceOf(Date);
      expect(mockRefreshTokenRepo.save).toHaveBeenCalledWith(refreshToken);
      expect(result).toEqual({
        accessToken: 'mocked-jwt-token',
        refreshToken: 'mocked-jwt-token',
        tokenType: 'Bearer',
        expiresIn: 7200,
        user: {
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          role: UserRole.EDITOR,
          avatar: null,
        },
      });
    });

    it('should throw UnauthorizedException when JWT verify fails', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('invalid token');
      });

      const dto: RefreshTokenDto = {
        refreshToken: 'invalid-token',
      };

      await expect(service.refresh(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when refresh token not found', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 'user-1' });
      mockRefreshTokenRepo.findOne.mockResolvedValue(null);

      const dto: RefreshTokenDto = {
        refreshToken: 'unknown-token',
      };

      await expect(service.refresh(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when refresh token is revoked', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 'user-1' });
      const refreshToken = createMockRefreshToken({ revokedAt: new Date() });
      mockRefreshTokenRepo.findOne.mockResolvedValue(refreshToken);

      const dto: RefreshTokenDto = {
        refreshToken: 'revoked-token',
      };

      await expect(service.refresh(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when refresh token is expired', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 'user-1' });
      const refreshToken = createMockRefreshToken({
        expiresAt: new Date('2000-01-01'),
      });
      mockRefreshTokenRepo.findOne.mockResolvedValue(refreshToken);

      const dto: RefreshTokenDto = {
        refreshToken: 'expired-token',
      };

      await expect(service.refresh(dto)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('should revoke refresh token when provided', async () => {
      mockRefreshTokenRepo.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      const result = await service.logout('user-1', 'some-refresh-token');

      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
      expect(mockRefreshTokenRepo.update).toHaveBeenCalledWith(
        { tokenHash: 'mocked-hash', userId: 'user-1' },
        { revokedAt: expect.any(Date) },
      );
      // 审计（Phase 2）：logout → LOGOUT + user；actor=实体=登出者自身
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: AuditAction.LOGOUT,
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'user-1',
        newData: { userId: 'user-1' },
        source: 'api',
      });
      expect(result).toBe(true);
    });

    it('should return true when no refresh token provided', async () => {
      const result = await service.logout('user-1');

      expect(mockRefreshTokenRepo.update).not.toHaveBeenCalled();
      // 无 refreshToken 时仍记 LOGOUT（审计不依赖请求体）
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: AuditAction.LOGOUT,
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'user-1',
        newData: { userId: 'user-1' },
        source: 'api',
      });
      expect(result).toBe(true);
    });
  });
});
