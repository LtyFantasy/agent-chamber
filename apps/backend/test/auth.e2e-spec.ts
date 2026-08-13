import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createTestingApp } from './test-setup';
import { ErrorCode } from '@agent-chamber/shared';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

describe('AuthController (e2e)', () => {
  let app: INestApplication;
  let mockRepos: Record<string, any>;

  beforeEach(async () => {
    ({ app, mockRepos } = await createTestingApp());
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  });

  afterEach(async () => {
    await app.close();
  });

  it('/auth/register (POST) - success (admin only)', async () => {
    const jwtService = app.get(JwtService);
    const adminToken = jwtService.sign({
      sub: '00000000-0000-0000-0000-000000000001',
      email: 'admin@example.com',
      role: 'admin',
    });

    // Mock findOne to return admin user for JWT validation (by id) and null for email check
    mockRepos.User.findOne.mockImplementation((options: any) => {
      const where = options?.where || {};
      if (where.id === '00000000-0000-0000-0000-000000000001') {
        return {
          id: '00000000-0000-0000-0000-000000000001',
          email: 'admin@example.com',
          role: 'admin',
          status: 'active',
          deletedAt: null,
          actor: { status: 'active' },
        };
      }
      if (where.email === 'test@example.com') {
        return null;
      }
      return null;
    });
    mockRepos.User.create.mockReturnValue({
      id: '00000000-0000-0000-0000-000000000005',
      email: 'test@example.com',
    });
    mockRepos.User.save.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000005',
      email: 'test@example.com',
    });
    mockRepos.RefreshToken.create.mockReturnValue({});
    mockRepos.RefreshToken.save.mockResolvedValue({});

    return request(app.getHttpServer())
      .post('/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', password: 'password123', name: 'Test' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('accessToken');
        expect(res.body.data).toHaveProperty('refreshToken');
      });
  });

  it('/auth/register (POST) - failure when email already exists (admin only)', async () => {
    const jwtService = app.get(JwtService);
    const adminToken = jwtService.sign({
      sub: '00000000-0000-0000-0000-000000000001',
      email: 'admin@example.com',
      role: 'admin',
    });

    // Mock findOne to return admin user for JWT validation (by id) and existing user for email check
    mockRepos.User.findOne.mockImplementation((options: any) => {
      const where = options?.where || {};
      if (where.id === '00000000-0000-0000-0000-000000000001') {
        return {
          id: '00000000-0000-0000-0000-000000000001',
          email: 'admin@example.com',
          role: 'admin',
          status: 'active',
          deletedAt: null,
          actor: { status: 'active' },
        };
      }
      if (where.email === 'test@example.com') {
        return { id: '00000000-0000-0000-0000-000000000005', email: 'test@example.com' };
      }
      return null;
    });

    return request(app.getHttpServer())
      .post('/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'test@example.com', password: 'password123', name: 'Test' })
      .expect(409)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.RESOURCE_CONFLICT);
        expect(res.body.message).toContain('already registered');
      });
  });

  it('/auth/login (POST) - success', async () => {
    const mockUser = {
      id: '00000000-0000-0000-0000-000000000005',
      email: 'test@example.com',
      passwordHash: 'hashed-password',
      status: 'active',
      lastLoginAt: null,
      actor: { status: 'active' },
    };
    mockRepos.User.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(mockUser),
    } as any);
    mockRepos.User.save.mockResolvedValue({
      ...mockUser,
      lastLoginAt: new Date(),
    });
    mockRepos.RefreshToken.create.mockReturnValue({});
    mockRepos.RefreshToken.save.mockResolvedValue({});

    return request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'test@example.com', password: 'password123' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('accessToken');
        expect(res.body.data).toHaveProperty('refreshToken');
      });
  });

  it('/auth/login (POST) - failure when password is incorrect', async () => {
    mockRepos.User.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        id: '00000000-0000-0000-0000-000000000005',
        email: 'test@example.com',
        passwordHash: 'hashed-password',
        actor: { status: 'active' },
      }),
    } as any);
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    return request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'test@example.com', password: 'wrongpassword' })
      .expect(401)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TOKEN_INVALID);
        expect(res.body.message).toContain('Invalid credentials');
      });
  });

  it('/auth/refresh (POST) - success', async () => {
    const jwtService = app.get(JwtService);
    const configService = app.get(ConfigService);
    const refreshSecret = configService.get<string>('jwt.refreshSecret')!;
    const refreshToken = jwtService.sign(
      { sub: '00000000-0000-0000-0000-000000000005' },
      { secret: refreshSecret, expiresIn: '7d' },
    );

    mockRepos.RefreshToken.findOne.mockResolvedValue({
      id: 'rt-1',
      userId: '00000000-0000-0000-0000-000000000005',
      tokenHash: 'mocked-hash',
      expiresAt: new Date('2099-12-31'),
      revokedAt: null,
    });
    mockRepos.RefreshToken.save.mockResolvedValue({});
    mockRepos.RefreshToken.create.mockReturnValue({});
    mockRepos.User.findOne.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000005',
      email: 'test@example.com',
      displayName: 'Test User',
      username: 'testuser',
      role: 'observer',
      avatarUrl: null,
      status: 'active',
    });

    return request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('accessToken');
        expect(res.body.data).toHaveProperty('refreshToken');
      });
  });

  it('/auth/refresh (POST) - failure with invalid refresh token', async () => {
    return request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'invalid-token' })
      .expect(401)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.TOKEN_INVALID);
        expect(res.body.message).toContain('Invalid refresh token');
      });
  });

  it('/auth/logout (POST) - success', async () => {
    const jwtService = app.get(JwtService);
    const token = jwtService.sign({
      sub: '00000000-0000-0000-0000-000000000005',
      email: 'test@example.com',
      role: 'observer',
    });

    mockRepos.User.findOne.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000005',
      email: 'test@example.com',
      role: 'observer',
      status: 'active',
      deletedAt: null,
      actor: { status: 'active' },
    });
    mockRepos.RefreshToken.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

    return request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({ refreshToken: 'some-refresh-token' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toBe(true);
      });
  });
});
