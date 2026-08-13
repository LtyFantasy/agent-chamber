import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { Actor } from '../../database/entities/actor.entity';
import { User } from '../../database/entities/user.entity';
import { ActorType, UserRole } from '@agent-chamber/shared';
import { AdminBootstrapService } from './admin-bootstrap.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-admin-password'),
}));

describe('AdminBootstrapService', () => {
  let service: AdminBootstrapService;
  let mockUserRepo: jest.Mocked<Repository<User>>;
  let mockConfigService: jest.Mocked<Pick<ConfigService, 'get'>>;
  let managerSave: jest.Mock;

  beforeEach(() => {
    managerSave = jest.fn().mockImplementation(async (entity: Actor) => {
      entity.id = 'admin-actor-1';
      return entity;
    });
    mockUserRepo = {
      findOne: jest.fn(),
      create: jest.fn((value) => value as User),
      save: jest.fn((value) => Promise.resolve(value)),
      manager: { save: managerSave },
    } as unknown as jest.Mocked<Repository<User>>;
    mockConfigService = {
      get: jest.fn(),
    };
    service = new AdminBootstrapService(
      mockUserRepo,
      mockConfigService as unknown as ConfigService,
    );
    jest.clearAllMocks();
  });

  it('does not touch the database when bootstrap env is missing', async () => {
    mockConfigService.get.mockReturnValue(undefined);

    await service.onApplicationBootstrap();

    expect(mockUserRepo.findOne).not.toHaveBeenCalled();
    expect(managerSave).not.toHaveBeenCalled();
    expect(mockUserRepo.save).not.toHaveBeenCalled();
  });

  it('skips creation when an admin already exists', async () => {
    mockConfigService.get.mockImplementation((key: string) =>
      key === 'ADMIN_EMAIL' ? 'admin@example.com' : 'admin-password',
    );
    mockUserRepo.findOne.mockResolvedValue({ role: UserRole.ADMIN } as User);

    await service.onApplicationBootstrap();

    expect(mockUserRepo.findOne).toHaveBeenCalledWith({
      where: { role: UserRole.ADMIN },
    });
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(managerSave).not.toHaveBeenCalled();
    expect(mockUserRepo.save).not.toHaveBeenCalled();
  });

  it('creates an active human actor and admin user', async () => {
    const email = 'admin@example.com';
    const password = 'admin-password';
    mockConfigService.get.mockImplementation((key: string) =>
      key === 'ADMIN_EMAIL' ? email : password,
    );
    mockUserRepo.findOne.mockResolvedValue(null);

    await service.onApplicationBootstrap();

    expect(bcrypt.hash).toHaveBeenCalledWith(password, 12);
    expect(managerSave).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ActorType.HUMAN,
        displayName: 'admin',
        status: 'active',
      }),
    );

    const actor = managerSave.mock.calls[0][0] as Actor;
    expect(mockUserRepo.create).toHaveBeenCalledWith({
      id: 'admin-actor-1',
      actor,
      email,
      username: expect.stringMatching(/^admin_/),
      passwordHash: 'hashed-admin-password',
      role: UserRole.ADMIN,
    });
    expect(mockUserRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'admin-actor-1',
        actor,
        email,
        role: UserRole.ADMIN,
        passwordHash: 'hashed-admin-password',
      }),
    );
    expect(managerSave.mock.invocationCallOrder[0]).toBeLessThan(
      mockUserRepo.save.mock.invocationCallOrder[0],
    );
  });

  it('does not fail application bootstrap when creation throws', async () => {
    mockConfigService.get.mockImplementation((key: string) =>
      key === 'ADMIN_EMAIL' ? 'admin@example.com' : 'admin-password',
    );
    mockUserRepo.findOne.mockRejectedValue(new Error('database unavailable'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
