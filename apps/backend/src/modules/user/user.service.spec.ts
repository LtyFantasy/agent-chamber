import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UserService } from './user.service';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { CreateUserByAdminDto } from './dto/create-user-by-admin.dto';
import { UpdateUserByAdminDto } from './dto/update-user-by-admin.dto';
import { UserRole, ActorType, ErrorCode } from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

function createMockRepo<T extends ObjectLiteral>() {
  /**
   * 事务内 EntityManager 桩（deleteByAdmin 的凭证连带吊销走
   * `userRepo.manager.transaction(...)`，卡 e6926d73）：事务回调拿到同一个 manager，
   * 顺序/调用面由调用方断言。SQL 语义（`IsNull()` 只打未撤销行、子查询命中名下 agent
   * 的 key）mock 证不了——真 PG 覆盖见 test/soft-deleted-login.e2e-spec.ts（铁律 #23）。
   */
  const mockManager = {
    save: jest.fn().mockImplementation(async (entity: { id?: string }) => {
      if (!entity.id) {
        entity.id = 'actor-new';
      }
      return entity;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
    })),
    transaction: jest.fn(),
  };
  mockManager.transaction.mockImplementation(async (cb: (m: unknown) => Promise<unknown>) =>
    cb(mockManager),
  );

  return {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findAndCount: jest.fn(),
    // Notifications 二期：preferences 走原子合并 SQL（裸 query）
    query: jest.fn().mockResolvedValue([]),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    softRemove: jest.fn(),
    count: jest.fn(),
    countBy: jest.fn(),
    update: jest.fn(),
    manager: mockManager,
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      getCount: jest.fn(),
    })),
  } as unknown as jest.Mocked<Repository<T>>;
}

function createMockUser(overrides: Partial<User> & Partial<Actor> = {}): User {
  const actor = new Actor();
  actor.id = overrides.id ?? 'user-1';
  actor.type = ActorType.HUMAN;
  actor.displayName = overrides.displayName !== undefined ? overrides.displayName : 'Test User';
  actor.avatarUrl = overrides.avatarUrl !== undefined ? overrides.avatarUrl : null;
  actor.status =
    (overrides.status as string) !== undefined ? (overrides.status as string) : 'active';
  actor.createdAt =
    overrides.createdAt !== undefined ? overrides.createdAt : new Date('2024-01-01');
  actor.updatedAt =
    overrides.updatedAt !== undefined ? overrides.updatedAt : new Date('2024-01-01');
  actor.deletedAt = overrides.deletedAt !== undefined ? overrides.deletedAt : null;
  if (overrides.actor) {
    Object.assign(actor, overrides.actor);
  }

  const user = new User();
  user.id = overrides.id ?? 'user-1';
  user.actor = actor;
  user.username = overrides.username ?? 'testuser';
  user.email = overrides.email ?? 'test@example.com';
  user.passwordHash =
    overrides.passwordHash !== undefined ? overrides.passwordHash : 'hashed-password';
  user.authProvider = (overrides as any).authProvider ?? 'local';
  user.authProviderId = (overrides as any).authProviderId ?? null;
  user.role = overrides.role ?? UserRole.EDITOR;
  user.preferences =
    overrides.preferences !== undefined ? (overrides.preferences as any) : { theme: 'dark' };
  user.lastLoginAt = overrides.lastLoginAt !== undefined ? overrides.lastLoginAt : null;
  user.agents = [];
  user.refreshTokens = [];
  return user;
}

describe('UserService', () => {
  let service: UserService;
  let mockRepo: jest.Mocked<Repository<User>>;
  let mockAuditService: { log: jest.Mock };

  beforeEach(async () => {
    mockRepo = createMockRepo<User>();
    mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = moduleRef.get<UserService>(UserService);

    jest.clearAllMocks();
  });

  describe('getMe', () => {
    it('should return user profile', async () => {
      const user = createMockUser();
      mockRepo.findOne.mockResolvedValue(user);

      const result = await service.getMe('user-1');

      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        relations: { actor: true },
      });
      expect(result).toEqual({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        role: UserRole.EDITOR,
        status: 'active',
        avatar: null,
        createdAt: user.createdAt,
        lastLoginAt: null,
        preferences: { theme: 'dark' },
      });
    });

    it('should throw NotFoundException when user not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.getMe('not-found')).rejects.toThrow(NotFoundException);
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'not-found' },
        relations: { actor: true },
      });
    });
  });

  describe('updateMe', () => {
    it('should update name, avatar and preferences', async () => {
      const user = createMockUser();
      // preferences 走原子合并后服务会**重读**一份（内存不再持有合并结果）
      const merged = createMockUser({ preferences: { theme: 'dark', lang: 'en' } });
      mockRepo.findOne.mockResolvedValueOnce(user).mockResolvedValueOnce(merged);
      mockRepo.save.mockResolvedValue(user);

      const dto: UpdateProfileDto = {
        name: 'New Name',
        avatar: 'https://example.com/avatar.png',
        preferences: { lang: 'en' },
      };

      const result = await service.updateMe('user-1', dto);

      expect(user.displayName).toBe('New Name');
      expect(user.avatarUrl).toBe('https://example.com/avatar.png');
      // Notifications 二期：preferences 是**一条原子 SQL**（不是读内存再整体 save）
      expect(mockRepo.query).toHaveBeenCalledWith(
        expect.stringContaining("coalesce(preferences, '{}'::jsonb) || $2::jsonb"),
        ['user-1', JSON.stringify({ lang: 'en' })],
      );
      expect(mockRepo.save).toHaveBeenCalledWith(user);
      expect(result.name).toBe('New Name');
      expect(result.avatar).toBe('https://example.com/avatar.png');
      expect(result.preferences).toEqual({ theme: 'dark', lang: 'en' });
      // 审计（Phase 2）：UPDATE + user；actor=自己；newData 只记字段名
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'update',
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'user-1',
        newData: {
          userId: 'user-1',
          username: 'testuser',
          changedFields: ['name', 'avatar', 'preferences'],
        },
        source: 'api',
      });
    });

    it('should clear avatarSvg when avatar is cleared (avatar: null)', async () => {
      // 联动清理：恢复默认后 actors.avatar_svg 不得残留为无引用孤儿数据
      const user = createMockUser();
      user.actor.avatarSvg = '<svg></svg>';
      user.actor.avatarUrl = '/api/v1/avatars/user-1.svg';
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      await service.updateMe('user-1', { avatar: null });

      expect(user.actor.avatarUrl).toBeNull();
      expect(user.actor.avatarSvg).toBeNull();
    });

    it('should clear avatarSvg when avatar is replaced with an external URL', async () => {
      const user = createMockUser();
      user.actor.avatarSvg = '<svg></svg>';
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      await service.updateMe('user-1', { avatar: 'https://example.com/new.png' });

      expect(user.actor.avatarSvg).toBeNull();
    });

    it('should keep avatarSvg when avatar is re-set to the same site SVG short-link', async () => {
      // uploadSvg 自身路径：avatarUrl 指向本站短链时 avatar_svg 必须保留
      const user = createMockUser();
      user.actor.avatarSvg = '<svg></svg>';
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      await service.updateMe('user-1', { avatar: '/api/v1/avatars/user-1.svg' });

      expect(user.actor.avatarSvg).toBe('<svg></svg>');
    });

    it('should throw NotFoundException when user not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.updateMe('not-found', { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSettings', () => {
    it('should return user preferences', async () => {
      const user = createMockUser();
      mockRepo.findOne.mockResolvedValue(user);

      const result = await service.getSettings('user-1');

      expect(mockRepo.findOne).toHaveBeenCalledWith({ where: { id: 'user-1' } });
      expect(result).toEqual({ theme: 'dark' });
    });

    it('should return empty object when preferences are null', async () => {
      const user = createMockUser({ preferences: null as any });
      mockRepo.findOne.mockResolvedValue(user);

      const result = await service.getSettings('user-1');

      expect(result).toEqual({});
    });

    it('should throw NotFoundException when user not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.getSettings('not-found')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateSettings', () => {
    it('should merge and return updated preferences', async () => {
      const user = createMockUser();
      const merged = createMockUser({ preferences: { theme: 'dark', notifications: true } });
      mockRepo.findOne.mockResolvedValueOnce(user).mockResolvedValueOnce(merged);
      mockRepo.save.mockResolvedValue(user);

      const result = await service.updateSettings('user-1', { notifications: true });

      // Notifications 二期：原子合并（一条 SQL）+ 不再走 save（避免陈旧快照覆盖）
      expect(mockRepo.query).toHaveBeenCalledWith(
        expect.stringContaining("coalesce(preferences, '{}'::jsonb) || $2::jsonb"),
        ['user-1', JSON.stringify({ notifications: true })],
      );
      expect(mockRepo.save).not.toHaveBeenCalled();
      expect(result).toEqual({ theme: 'dark', notifications: true });
      // 审计（Phase 2）：UPDATE + user（settings）；只记字段名
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'update',
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'user-1',
        newData: { userId: 'user-1', username: 'testuser', changedFields: ['preferences'] },
        source: 'api',
      });
    });

    it('should throw NotFoundException when user not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.updateSettings('not-found', {})).rejects.toThrow(NotFoundException);
    });

    it('should strip notificationCategories from the preferences patch (Notifications 二期堵旁门)', async () => {
      const user = createMockUser();
      const merged = createMockUser({ preferences: { theme: 'dark' } });
      mockRepo.findOne.mockResolvedValueOnce(user).mockResolvedValueOnce(merged);

      await service.updateSettings('user-1', {
        notifications: true,
        // 旁路写入：通知类别偏好只能走 /notification-settings/me/prefs（带自定义 validator + 原子键级合并）
        notificationCategories: { task_done: false },
      } as never);

      const [, params] = mockRepo.query.mock.calls[0] as [string, unknown[]];
      const patch = JSON.parse(params[1] as string) as Record<string, unknown>;
      expect(patch).not.toHaveProperty('notificationCategories');
      expect(patch).toHaveProperty('notifications', true);
    });
  });

  describe('changePassword', () => {
    const mockPasswordQuery = (user: User | null) => {
      (mockRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(user),
      });
    };

    it('should change password successfully', async () => {
      const user = createMockUser();
      mockPasswordQuery(user);
      jest.mocked(bcrypt.compare).mockResolvedValue(true as never);
      jest.mocked(bcrypt.hash).mockResolvedValue('new-hashed' as never);
      mockRepo.save.mockResolvedValue(user);

      const dto: ChangePasswordDto = { currentPassword: 'old-pass', newPassword: 'new-pass-123' };
      const result = await service.changePassword('user-1', dto);

      expect(bcrypt.compare).toHaveBeenCalledWith('old-pass', 'hashed-password');
      expect(bcrypt.hash).toHaveBeenCalledWith('new-pass-123', 12);
      expect(user.passwordHash).toBe('new-hashed');
      expect(mockRepo.save).toHaveBeenCalledWith(user);
      expect(result).toBe(true);
      // 审计（Phase 2）：UPDATE + user（change-password）；passwordHash 黑名单不入
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'update',
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'user-1',
        newData: { userId: 'user-1', username: 'testuser' },
        source: 'api',
      });
    });

    it('should throw NotFoundException when user not found', async () => {
      mockPasswordQuery(null);

      const dto: ChangePasswordDto = { currentPassword: 'old', newPassword: 'new-pass-123' };
      await expect(service.changePassword('not-found', dto)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when user has no password hash', async () => {
      const user = createMockUser({ passwordHash: null });
      mockPasswordQuery(user);

      const dto: ChangePasswordDto = { currentPassword: 'old', newPassword: 'new-pass-123' };
      await expect(service.changePassword('user-1', dto)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when current password is incorrect', async () => {
      const user = createMockUser();
      mockPasswordQuery(user);
      jest.mocked(bcrypt.compare).mockResolvedValue(false as never);

      const dto: ChangePasswordDto = { currentPassword: 'wrong-pass', newPassword: 'new-pass-123' };
      await expect(service.changePassword('user-1', dto)).rejects.toThrow(BadRequestException);
      expect(bcrypt.compare).toHaveBeenCalledWith('wrong-pass', 'hashed-password');
    });
  });

  describe('updateAvatar', () => {
    it('should update avatar and return profile', async () => {
      const user = createMockUser();
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      const result = await service.updateAvatar('user-1', 'https://example.com/new.png');

      expect(user.avatarUrl).toBe('https://example.com/new.png');
      expect(mockRepo.save).toHaveBeenCalledWith(user);
      expect(result.avatar).toBe('https://example.com/new.png');
      // 审计（Phase 2）：UPDATE + user（avatar）；只记字段名
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'update',
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'user-1',
        newData: { userId: 'user-1', username: 'testuser', changedFields: ['avatar'] },
        source: 'api',
      });
    });

    it('should throw NotFoundException when user not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.updateAvatar('not-found', 'url')).rejects.toThrow(NotFoundException);
    });
  });

  // ============================================================================
  // Admin methods
  // ============================================================================

  describe('findAll', () => {
    function createMockQueryBuilder(items: User[], total: number) {
      return {
        // findAll 走 innerJoinAndSelect：软删条件在 JOIN 的 ON 子句里，左连接下 NULL 会
        // 空虚满足 `actor.deleted_at IS NULL`（真 PG 语义证明见 admin-user-delete.e2e-spec.ts）
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([items, total]),
        getMany: jest.fn(),
        getOne: jest.fn(),
        getCount: jest.fn(),
      } as unknown as SelectQueryBuilder<User>;
    }

    it('should return paginated user list', async () => {
      const user1 = createMockUser({ id: 'user-1', email: 'a@example.com', displayName: 'User A' });
      const user2 = createMockUser({ id: 'user-2', email: 'b@example.com', displayName: 'User B' });
      const qbMock = createMockQueryBuilder([user1, user2], 2);
      mockRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({ page: '1', pageSize: '20' });

      expect(mockRepo.createQueryBuilder).toHaveBeenCalledWith('user');
      // 回归闸：软删过滤依赖 inner join（改回 leftJoin 即失效，见上方注释）
      expect(qbMock.innerJoinAndSelect).toHaveBeenCalledWith('user.actor', 'actor');
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it('should support q search via QueryBuilder for email match', async () => {
      const user = createMockUser({
        id: 'user-1',
        email: 'test@example.com',
        displayName: 'Test User',
      });
      const qbMock = createMockQueryBuilder([user], 1);
      mockRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({ q: 'test' });

      expect(mockRepo.createQueryBuilder).toHaveBeenCalledWith('user');
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should support q search via QueryBuilder for displayName match', async () => {
      const user = createMockUser({
        id: 'user-1',
        email: 'a@example.com',
        displayName: 'Test Name',
      });
      const qbMock = createMockQueryBuilder([user], 1);
      mockRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({ q: 'Name' });

      expect(result.items[0].name).toBe('Test Name');
    });

    it('should return all users when q is empty', async () => {
      const user = createMockUser();
      const qbMock = createMockQueryBuilder([user], 1);
      mockRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({ q: '' });

      expect(mockRepo.createQueryBuilder).toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
    });

    it('should clamp pageSize to max 100', async () => {
      const qbMock = createMockQueryBuilder([], 0);
      mockRepo.createQueryBuilder.mockReturnValue(qbMock);

      await service.findAll({ pageSize: '200' });

      expect(mockRepo.createQueryBuilder).toHaveBeenCalled();
    });
  });

  describe('findAllLightweight', () => {
    it('should return active users with names', async () => {
      const user = createMockUser({ id: 'user-1', displayName: 'Alice' });
      const qbMock = {
        select: jest.fn().mockReturnThis(),
        // findAllLightweight 走 innerJoin（软删过滤依赖它，见 user.service.ts 处注释）
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[user], 1]),
      } as unknown as SelectQueryBuilder<User>;
      mockRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAllLightweight({});

      // 防止 TypeORM 0.3.30 在 skip/take + 关联 join + orderBy(关联字段) 时
      // 生成 `distinctAlias.actor_display_name does not exist` 的回归
      expect(qbMock.select).toHaveBeenCalledWith([
        'user.id',
        'user.username',
        'user.role',
        'actor.displayName',
        'actor.avatarUrl',
      ]);
      expect(qbMock.innerJoin).toHaveBeenCalledWith('user.actor', 'actor');
      expect(qbMock.orderBy).toHaveBeenCalledWith('actor.displayName', 'ASC');
      expect(result.items).toEqual([
        { id: 'user-1', name: 'Alice', avatarUrl: null, role: UserRole.EDITOR },
      ]);
    });
  });

  describe('createByAdmin', () => {
    it('should create user successfully', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed-password' as never);
      const createdUser = createMockUser({
        id: 'actor-new',
        email: 'new@example.com',
        displayName: 'New User',
      });
      mockRepo.create.mockReturnValue(createdUser);
      mockRepo.save.mockResolvedValue(createdUser);

      const dto: CreateUserByAdminDto = {
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
      };

      const result = await service.createByAdmin(dto, 'admin-1');

      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { email: dto.email },
        relations: { actor: true },
        withDeleted: true,
      });
      expect(bcrypt.hash).toHaveBeenCalledWith(dto.password, 12);
      expect(mockRepo.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ActorType.HUMAN,
          displayName: dto.name,
          status: 'active',
        }),
      );
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'actor-new',
          email: dto.email,
          passwordHash: 'hashed-password',
          role: UserRole.EDITOR,
        }),
      );
      expect(mockRepo.save).toHaveBeenCalled();
      expect(result.email).toBe('new@example.com');
      expect(result.name).toBe('New User');
      // 审计（Phase 2）：CREATE + user；actor=操作 admin（决策 8）；passwordHash 不入
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'create',
        entityType: 'user',
        entityId: 'actor-new',
        actorId: 'admin-1',
        newData: { userId: 'actor-new', username: 'testuser', role: UserRole.EDITOR },
        source: 'api',
      });
    });

    it('should throw ConflictException when email already exists', async () => {
      mockRepo.findOne.mockResolvedValue(createMockUser());

      const dto: CreateUserByAdminDto = {
        email: 'test@example.com',
        password: 'password123',
        name: 'New User',
      };

      await expect(service.createByAdmin(dto)).rejects.toThrow(ConflictException);
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { email: dto.email },
        relations: { actor: true },
        withDeleted: true,
      });
    });

    it('should throw ConflictException when email belongs to a soft-deleted user', async () => {
      const softDeletedUser = createMockUser({ deletedAt: new Date('2024-01-01') });
      mockRepo.findOne.mockResolvedValue(softDeletedUser);

      const dto: CreateUserByAdminDto = {
        email: 'test@example.com',
        password: 'password123',
        name: 'New User',
      };

      await expect(service.createByAdmin(dto)).rejects.toThrow(ConflictException);
      await expect(service.createByAdmin(dto)).rejects.toMatchObject({
        response: {
          message: 'Email already exists',
          code: ErrorCode.USER_EMAIL_EXISTS,
        },
      });
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { email: dto.email },
        relations: { actor: true },
        withDeleted: true,
      });
    });

    it('should hash password with bcrypt', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed-password' as never);
      mockRepo.create.mockReturnValue(createMockUser());
      mockRepo.save.mockResolvedValue(createMockUser());

      const dto: CreateUserByAdminDto = {
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
      };

      await service.createByAdmin(dto);

      expect(bcrypt.hash).toHaveBeenCalledWith('password123', 12);
    });

    it('should default role to EDITOR when not provided', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed-password' as never);
      mockRepo.create.mockReturnValue(createMockUser());
      mockRepo.save.mockResolvedValue(createMockUser());

      const dto: CreateUserByAdminDto = {
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
      };

      await service.createByAdmin(dto);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ role: UserRole.EDITOR }),
      );
    });

    it('should use provided role when specified', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed-password' as never);
      mockRepo.create.mockReturnValue(createMockUser({ role: UserRole.ADMIN }));
      mockRepo.save.mockResolvedValue(createMockUser({ role: UserRole.ADMIN }));

      const dto: CreateUserByAdminDto = {
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
        role: UserRole.ADMIN,
      };

      await service.createByAdmin(dto);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ role: UserRole.ADMIN }),
      );
    });

    it('should default status to active', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      jest.mocked(bcrypt.hash).mockResolvedValue('hashed-password' as never);
      mockRepo.create.mockReturnValue(createMockUser());
      mockRepo.save.mockResolvedValue(createMockUser());

      const dto: CreateUserByAdminDto = {
        email: 'new@example.com',
        password: 'password123',
        name: 'New User',
      };

      await service.createByAdmin(dto);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: expect.objectContaining({ status: 'active' }),
        }),
      );
    });
  });

  describe('updateByAdmin', () => {
    it('should update user successfully', async () => {
      const user = createMockUser({ id: 'user-1', role: UserRole.EDITOR });
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      const dto: UpdateUserByAdminDto = { name: 'Updated Name', role: UserRole.ADMIN };
      const result = await service.updateByAdmin('user-1', dto, 'admin-1');

      expect(user.displayName).toBe('Updated Name');
      expect(user.role).toBe(UserRole.ADMIN);
      expect(mockRepo.save).toHaveBeenCalledWith(user);
      expect(result.name).toBe('Updated Name');
      expect(result.role).toBe(UserRole.ADMIN);
      // 审计（Phase 2）：UPDATE + user（admin 操作）；actor=操作 admin；只记字段名
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'update',
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'admin-1',
        newData: {
          userId: 'user-1',
          username: 'testuser',
          changedFields: ['name', 'role'],
        },
        source: 'api',
      });
    });

    it('should throw NotFoundException when user not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const dto: UpdateUserByAdminDto = { name: 'Updated' };
      await expect(service.updateByAdmin('not-found', dto, 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when admin tries to downgrade themselves', async () => {
      const user = createMockUser({ id: 'admin-1', role: UserRole.ADMIN });
      mockRepo.findOne.mockResolvedValue(user);

      const dto: UpdateUserByAdminDto = { role: UserRole.EDITOR };
      await expect(service.updateByAdmin('admin-1', dto, 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should allow admin to update themselves without role change', async () => {
      const user = createMockUser({ id: 'admin-1', role: UserRole.ADMIN });
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      const dto: UpdateUserByAdminDto = { name: 'New Name' };
      const result = await service.updateByAdmin('admin-1', dto, 'admin-1');

      expect(result.name).toBe('New Name');
      expect(user.role).toBe(UserRole.ADMIN);
    });

    it('should only update provided fields', async () => {
      const user = createMockUser({
        id: 'user-1',
        displayName: 'Original',
        role: UserRole.EDITOR,
        status: 'active',
      });
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      const dto: UpdateUserByAdminDto = { name: 'New Name' };
      await service.updateByAdmin('user-1', dto, 'admin-1');

      expect(user.displayName).toBe('New Name');
      expect(user.role).toBe(UserRole.EDITOR); // unchanged
      expect(user.status).toBe('active'); // unchanged
    });

    it('should update status when provided', async () => {
      const user = createMockUser({ id: 'user-1', status: 'active' });
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      const dto: UpdateUserByAdminDto = { status: 'disabled' };
      const result = await service.updateByAdmin('user-1', dto, 'admin-1');

      expect(user.status).toBe('disabled');
      expect(result).toBeDefined();
    });
  });

  describe('deleteByAdmin', () => {
    it('should soft delete user successfully', async () => {
      const user = createMockUser({ id: 'user-1' });
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      const result = await service.deleteByAdmin('user-1', 'admin-1');

      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        relations: { actor: true },
      });
      expect(user.actor.deletedAt).toBeInstanceOf(Date);
      // 卡 e6926d73：软删改由**事务内 manager** 执行（同事务先吊销 refresh token 与
      // 名下 agent 的 API Key，再软删）——顺序不变量即"先 revoke 后软删"
      const mgr = mockRepo.manager as unknown as {
        transaction: jest.Mock;
        update: jest.Mock;
        save: jest.Mock;
        createQueryBuilder: jest.Mock;
      };
      expect(mgr.transaction).toHaveBeenCalled();
      expect(mgr.update).toHaveBeenCalledWith(
        expect.anything(),
        { userId: 'user-1', revokedAt: expect.anything() },
        { revokedAt: expect.any(Date) },
      );
      expect(mgr.save).toHaveBeenCalledWith(user);
      // 三步顺序不变量：① refresh 吊销 → ② API Key 连带吊销（事务内 queryBuilder）→
      // ③ actor 软删。② 若被挪到 ③ 之后（或漏掉），本断言即红。
      expect(mgr.createQueryBuilder).toHaveBeenCalled();
      const revokeOrder = mgr.update.mock.invocationCallOrder[0];
      const keyRevokeOrder = mgr.createQueryBuilder.mock.invocationCallOrder[0];
      const softDeleteOrder = mgr.save.mock.invocationCallOrder[0];
      expect(revokeOrder).toBeLessThan(keyRevokeOrder);
      expect(keyRevokeOrder).toBeLessThan(softDeleteOrder);
      // ② 步的 update 目标与 set 载荷（SQL 语义 mock 证不了，真 PG 覆盖见
      // test/soft-deleted-login.e2e-spec.ts ⑥）
      const keyQb = mgr.createQueryBuilder.mock.results[0].value as {
        update: jest.Mock;
        set: jest.Mock;
        where: jest.Mock;
      };
      expect(keyQb.update).toHaveBeenCalled();
      expect(keyQb.set).toHaveBeenCalledWith({
        revokedAt: expect.any(Date),
        revokedReason: 'owner deleted',
      });
      expect(result).toBe(true);
      // 审计（Phase 2）：DELETE + user（admin 软删）；actor=操作 admin
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'delete',
        entityType: 'user',
        entityId: 'user-1',
        actorId: 'admin-1',
        newData: { userId: 'user-1', username: 'testuser' },
        source: 'api',
      });
    });

    it('should abort the soft delete when the API Key revoke step fails (事务回滚语义)', async () => {
      const user = createMockUser({ id: 'user-1' });
      mockRepo.findOne.mockResolvedValue(user);
      mockRepo.save.mockResolvedValue(user);

      // ② 步（API Key 连带吊销）SQL 失败
      const mgr = mockRepo.manager as unknown as {
        createQueryBuilder: jest.Mock;
        save: jest.Mock;
      };
      mgr.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockRejectedValue(new Error('api key revoke failed')),
      });

      await expect(service.deleteByAdmin('user-1', 'admin-1')).rejects.toThrow(
        'api key revoke failed',
      );
      // 回滚语义的单元级证据：③ 软删未执行（真实回滚由 manager.transaction 承担，
      // 本桩不模拟回滚，故"未往下走"就是可断言的部分）
      expect(mgr.save).not.toHaveBeenCalled();
      expect(user.actor.deletedAt).toBeNull();
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when user not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.deleteByAdmin('not-found', 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when admin tries to delete themselves', async () => {
      const user = createMockUser({ id: 'admin-1' });
      mockRepo.findOne.mockResolvedValue(user);

      await expect(service.deleteByAdmin('admin-1', 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
