import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

describe('UserController', () => {
  let controller: UserController;
  let service: typeof mockService;

  const mockService = {
    getMe: jest.fn(),
    updateMe: jest.fn(),
    getSettings: jest.fn(),
    updateSettings: jest.fn(),
    changePassword: jest.fn(),
    updateAvatar: jest.fn(),
    findAllLightweight: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [{ provide: UserService, useValue: mockService }],
    })
      // JwtAuthGuard 构造依赖 ApiKeyAuthService（B-59 起），单测 override 掉
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<UserController>(UserController);
    service = moduleRef.get<UserService>(UserService) as unknown as typeof service;
  });

  afterEach(() => jest.clearAllMocks());

  describe('getMe', () => {
    it('should call service.getMe with userId and return result', async () => {
      const result = { id: 'user-1', name: 'Test User' };
      service.getMe.mockResolvedValue(result);

      expect(await controller.getMe('user-1')).toBe(result);
      expect(service.getMe).toHaveBeenCalledWith('user-1');
    });
  });

  describe('updateMe', () => {
    it('should call service.updateMe with userId and dto and return result', async () => {
      const result = { id: 'user-1', name: 'New Name' };
      service.updateMe.mockResolvedValue(result);

      const dto: UpdateProfileDto = { name: 'New Name', avatar: 'https://example.com/avatar.png' };
      expect(await controller.updateMe('user-1', dto)).toBe(result);
      expect(service.updateMe).toHaveBeenCalledWith('user-1', dto);
    });
  });

  describe('getSettings', () => {
    it('should call service.getSettings with userId and return result', async () => {
      const result = { theme: 'dark' };
      service.getSettings.mockResolvedValue(result);

      expect(await controller.getSettings('user-1')).toBe(result);
      expect(service.getSettings).toHaveBeenCalledWith('user-1');
    });
  });

  describe('updateSettings', () => {
    it('should call service.updateSettings with userId and settings and return result', async () => {
      const result = { theme: 'light' };
      service.updateSettings.mockResolvedValue(result);

      const settings = { theme: 'light' };
      expect(await controller.updateSettings('user-1', settings)).toBe(result);
      expect(service.updateSettings).toHaveBeenCalledWith('user-1', settings);
    });
  });

  describe('changePassword', () => {
    it('should call service.changePassword with userId and dto and return result', async () => {
      const result = true;
      service.changePassword.mockResolvedValue(result);

      const dto: ChangePasswordDto = { currentPassword: 'old', newPassword: 'new-pass-123' };
      expect(await controller.changePassword('user-1', dto)).toBe(result);
      expect(service.changePassword).toHaveBeenCalledWith('user-1', dto);
    });
  });

  describe('updateAvatar', () => {
    it('should call service.updateAvatar with userId and avatarUrl and return result', async () => {
      const result = { id: 'user-1', avatar: 'https://example.com/new.png' };
      service.updateAvatar.mockResolvedValue(result);

      expect(await controller.updateAvatar('user-1', 'https://example.com/new.png')).toBe(result);
      expect(service.updateAvatar).toHaveBeenCalledWith('user-1', 'https://example.com/new.png');
    });
  });

  describe('findAll', () => {
    it('should call service.findAllLightweight with query and return result (human JWT)', async () => {
      const result = {
        items: [{ id: 'user-1', name: 'Test', avatarUrl: null, role: 'editor' }],
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      };
      service.findAllLightweight.mockResolvedValue(result);

      // 人类 JWT：JwtAuthGuard 挂载 request.user → 第一个参数非空
      expect(await controller.findAll({ userId: 'user-1' }, { q: 'test' })).toBe(result);
      expect(service.findAllLightweight).toHaveBeenCalledWith({ q: 'test' });
    });

    it('should reject API key callers (no mounted user) with 403', async () => {
      // API key：JwtAuthGuard 直接放行但不挂载 request.user → user 为 undefined
      await expect(controller.findAll(undefined, { q: 'test' })).rejects.toThrow(ForbiddenException);
      expect(service.findAllLightweight).not.toHaveBeenCalled();
    });
  });
});
