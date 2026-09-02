import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, RefreshTokenDto } from './dto';
import { UserRole, ActorType } from '@agent-chamber/shared';
import { ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

describe('AuthController', () => {
  let controller: AuthController;
  let service: typeof mockService;

  const mockService = {
    register: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockService }],
    })
      // JwtAuthGuard 构造依赖 ApiKeyAuthService（B-59 起），单测 override 掉
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
    service = module.get<AuthService>(AuthService) as unknown as typeof mockService;
  });

  afterEach(() => jest.clearAllMocks());

  describe('register', () => {
    it('should call authService.register with dto and return result (admin only)', async () => {
      const dto: RegisterDto = {
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User',
      };
      const expectedResult = {
        accessToken: 'token',
        refreshToken: 'refresh',
        tokenType: 'Bearer',
        expiresIn: 7200,
        user: {
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          role: UserRole.EDITOR,
          avatar: null,
        },
      };
      service.register.mockResolvedValue(expectedResult);

      const result = await controller.register(dto, { id: 'admin-1', type: ActorType.HUMAN });

      // 审计 actor=操作 admin（决策 8，从 controller 传入 service）
      expect(service.register).toHaveBeenCalledWith(dto, 'admin-1');
      expect(result).toBe(expectedResult);
    });

    it('should require ADMIN role decorator on register', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, AuthController.prototype.register);
      expect(roles).toContain(UserRole.ADMIN);
    });

    it('should require JwtAuthGuard and RolesGuard on register', () => {
      const guards = Reflect.getMetadata('__guards__', AuthController.prototype.register);
      expect(guards).toBeDefined();
      const guardClasses = guards.map((g: unknown) =>
        (g as { name?: string }).name
          ? (g as { name?: string }).name
          : (g as { constructor?: { name?: string } }).constructor?.name || g,
      );
      expect(guardClasses).toContain('JwtAuthGuard');
      expect(guardClasses).toContain('RolesGuard');
    });
  });

  describe('login', () => {
    it('should call authService.login with dto and return result', async () => {
      const dto: LoginDto = {
        email: 'test@example.com',
        password: 'password123',
      };
      const expectedResult = {
        accessToken: 'token',
        refreshToken: 'refresh',
        tokenType: 'Bearer',
        expiresIn: 7200,
        user: {
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          role: UserRole.EDITOR,
          avatar: null,
        },
      };
      service.login.mockResolvedValue(expectedResult);

      const result = await controller.login(dto);

      expect(service.login).toHaveBeenCalledWith(dto);
      expect(result).toBe(expectedResult);
    });
  });

  describe('refresh', () => {
    it('should call authService.refresh with dto and return result', async () => {
      const dto: RefreshTokenDto = {
        refreshToken: 'valid-refresh-token',
      };
      const expectedResult = {
        accessToken: 'new-token',
        refreshToken: 'new-refresh',
        tokenType: 'Bearer',
        expiresIn: 7200,
        user: {
          id: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          role: UserRole.EDITOR,
          avatar: null,
        },
      };
      service.refresh.mockResolvedValue(expectedResult);

      const result = await controller.refresh(dto);

      expect(service.refresh).toHaveBeenCalledWith(dto);
      expect(result).toBe(expectedResult);
    });
  });

  describe('logout', () => {
    it('should call authService.logout with userId and refreshToken', async () => {
      const body: RefreshTokenDto = {
        refreshToken: 'some-refresh-token',
      };
      service.logout.mockResolvedValue(true);

      const result = await controller.logout('user-1', body);

      expect(service.logout).toHaveBeenCalledWith('user-1', 'some-refresh-token');
      expect(result).toBe(true);
    });

    it('should call authService.logout with userId when no refreshToken', async () => {
      const body: RefreshTokenDto = {
        refreshToken: '',
      };
      service.logout.mockResolvedValue(true);

      const result = await controller.logout('user-1', body);

      expect(service.logout).toHaveBeenCalledWith('user-1', '');
      expect(result).toBe(true);
    });

    it('should reject logout when userId is missing (agent identity path, B-57)', async () => {
      // B-57 回归：agent 用 API Key 调 logout 时 guard 只挂 request.agent、
      // request.user 不存在 → @CurrentUser('userId') 为 undefined → fail-closed
      // 拒绝（旧实现静默成功：撤销 0 行 + 审计丢失）
      const body: RefreshTokenDto = {
        refreshToken: 'some-refresh-token',
      };

      await expect(controller.logout(undefined as unknown as string, body)).rejects.toThrow(
        ForbiddenException,
      );
      expect(service.logout).not.toHaveBeenCalled();
    });
  });
});
