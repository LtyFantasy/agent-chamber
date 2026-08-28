import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminUserController } from './admin-user.controller';
import { UserService } from './user.service';
import { CreateUserByAdminDto, UpdateUserByAdminDto } from './dto';
import { UserRole } from '@agent-chamber/shared';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

describe('AdminUserController', () => {
  let controller: AdminUserController;
  let service: typeof mockService;

  const mockService = {
    findAll: jest.fn(),
    createByAdmin: jest.fn(),
    updateByAdmin: jest.fn(),
    deleteByAdmin: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AdminUserController],
      providers: [{ provide: UserService, useValue: mockService }],
    }).compile();

    controller = moduleRef.get<AdminUserController>(AdminUserController);
    service = moduleRef.get<UserService>(UserService) as unknown as typeof service;
  });

  afterEach(() => jest.clearAllMocks());

  describe('findAll', () => {
    it('should return user list for admin', async () => {
      const result = {
        data: [
          { id: 'user-1', email: 'test@example.com', name: 'Test User', role: UserRole.EDITOR },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      };
      service.findAll.mockResolvedValue(result);

      const query = { page: 1, pageSize: 20 };
      expect(await controller.findAll(query)).toBe(result);
      expect(service.findAll).toHaveBeenCalledWith(query);
    });

    it('should support pagination params', async () => {
      const result = {
        data: [],
        pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
      };
      service.findAll.mockResolvedValue(result);

      const query = { page: '2', pageSize: '10' };
      expect(await controller.findAll(query)).toBe(result);
      expect(service.findAll).toHaveBeenCalledWith(query);
    });

    it('should support search param q', async () => {
      const result = {
        data: [
          { id: 'user-1', email: 'test@example.com', name: 'Test User', role: UserRole.EDITOR },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      };
      service.findAll.mockResolvedValue(result);

      const query = { q: 'test' };
      expect(await controller.findAll(query)).toBe(result);
      expect(service.findAll).toHaveBeenCalledWith(query);
    });

    it('should require ADMIN role decorator', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, AdminUserController.prototype.findAll);
      expect(roles).toContain(UserRole.ADMIN);
    });

    it('should require JwtAuthGuard and RolesGuard', () => {
      const guards = Reflect.getMetadata('__guards__', AdminUserController.prototype.findAll);
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

  describe('createByAdmin', () => {
    it('should create user successfully for admin', async () => {
      const result = {
        id: 'user-new',
        email: 'new@example.com',
        name: 'New User',
        role: UserRole.EDITOR,
      };
      service.createByAdmin.mockResolvedValue(result);

      const dto: CreateUserByAdminDto = {
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
      };

      expect(await controller.createByAdmin(dto, 'admin-1')).toBe(result);
      expect(service.createByAdmin).toHaveBeenCalledWith(dto, 'admin-1');
    });

    it('should require ADMIN role decorator', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, AdminUserController.prototype.createByAdmin);
      expect(roles).toContain(UserRole.ADMIN);
    });

    it('should require JwtAuthGuard and RolesGuard', () => {
      const guards = Reflect.getMetadata('__guards__', AdminUserController.prototype.createByAdmin);
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

  describe('updateByAdmin', () => {
    it('should update user successfully for admin', async () => {
      const result = {
        id: 'user-1',
        email: 'test@example.com',
        name: 'Updated Name',
        role: UserRole.ADMIN,
      };
      service.updateByAdmin.mockResolvedValue(result);

      const dto: UpdateUserByAdminDto = { name: 'Updated Name' };
      expect(await controller.updateByAdmin('user-1', dto, 'admin-1')).toBe(result);
      expect(service.updateByAdmin).toHaveBeenCalledWith('user-1', dto, 'admin-1');
    });

    it('should require ADMIN role decorator', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, AdminUserController.prototype.updateByAdmin);
      expect(roles).toContain(UserRole.ADMIN);
    });

    it('should require JwtAuthGuard and RolesGuard', () => {
      const guards = Reflect.getMetadata('__guards__', AdminUserController.prototype.updateByAdmin);
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

  describe('deleteByAdmin', () => {
    it('should delete user successfully for admin', async () => {
      service.deleteByAdmin.mockResolvedValue(true);

      expect(await controller.deleteByAdmin('user-1', 'admin-1')).toBe(true);
      expect(service.deleteByAdmin).toHaveBeenCalledWith('user-1', 'admin-1');
    });

    it('should require ADMIN role decorator', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, AdminUserController.prototype.deleteByAdmin);
      expect(roles).toContain(UserRole.ADMIN);
    });

    it('should require JwtAuthGuard and RolesGuard', () => {
      const guards = Reflect.getMetadata('__guards__', AdminUserController.prototype.deleteByAdmin);
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
});
