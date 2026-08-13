import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createTestingApp } from './test-setup';
import { ErrorCode } from '@agent-chamber/shared';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mocked-hash'),
  })),
  randomBytes: jest.fn(() => ({
    toString: jest.fn().mockReturnValue('mocked-random-bytes'),
  })),
}));

describe('AgentController (e2e)', () => {
  let app: INestApplication;
  let mockRepos: Record<string, any>;
  let authToken: string;

  beforeEach(async () => {
    ({ app, mockRepos } = await createTestingApp());

    const jwtService = app.get(JwtService);
    authToken = jwtService.sign({
      sub: '00000000-0000-4000-8000-000000000005',
      email: 'test@example.com',
      role: 'observer',
    });

    // Support JwtStrategy validation for every request (Actor unified model)
    mockRepos.User.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000005',
      email: 'test@example.com',
      role: 'observer',
      status: 'active',
      deletedAt: null,
      actor: { status: 'active' },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /agents - success', async () => {
    mockRepos.Agent.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    });

    return request(app.getHttpServer())
      .get('/agents')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('items');
        expect(res.body.data).toHaveProperty('total', 0);
      });
  });

  it('POST /agents - success', async () => {
    mockRepos.Agent.create.mockReturnValue({ name: 'Test Agent' });
    mockRepos.Agent.save.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Test Agent',
    });
    mockRepos.ApiKey.create.mockReturnValue({});
    mockRepos.ApiKey.save.mockResolvedValue({});

    return request(app.getHttpServer())
      .post('/agents')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Test Agent', description: 'A test agent' })
      .expect(201)
      .expect((res: any) => {
        // ResponseInterceptor reads statusCode before NestJS sets the default 201 for POST
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('id', '00000000-0000-4000-8000-000000000002');
        expect(res.body.data).toHaveProperty('apiKey');
      });
  });

  it('GET /agents/:id - success', async () => {
    mockRepos.Agent.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Test Agent',
      status: 'active',
      ownerId: '00000000-0000-4000-8000-000000000005',
      capabilities: [],
      actor: { status: 'active', deletedAt: null },
    });

    return request(app.getHttpServer())
      .get('/agents/00000000-0000-4000-8000-000000000002')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('id', '00000000-0000-4000-8000-000000000002');
      });
  });

  it('GET /agents/:id - not found (404)', async () => {
    mockRepos.Agent.findOne.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get('/agents/00000000-0000-4000-8000-000000000999')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(404)
      .expect((res: any) => {
        expect(res.body.code).toBe(ErrorCode.AGENT_NOT_FOUND);
        expect(res.body.message).toContain('Agent not found');
      });
  });

  it('PATCH /agents/:id - success', async () => {
    mockRepos.Agent.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Old Name',
      status: 'active',
      ownerId: '00000000-0000-4000-8000-000000000005',
      capabilities: [],
      actor: { status: 'active', deletedAt: null },
    });
    mockRepos.Agent.save.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'New Name',
      status: 'active',
    });

    return request(app.getHttpServer())
      .patch('/agents/00000000-0000-4000-8000-000000000002')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'New Name' })
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('name', 'New Name');
      });
  });

  it('DELETE /agents/:id - success', async () => {
    mockRepos.Agent.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Test Agent',
      ownerId: '00000000-0000-4000-8000-000000000005',
      capabilities: [],
      status: 'active',
      actor: { status: 'active', deletedAt: null },
    });
    mockRepos.Agent.softRemove.mockResolvedValue({});

    return request(app.getHttpServer())
      .delete('/agents/00000000-0000-4000-8000-000000000002')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toBe(true);
      });
  });

  it('POST /agents/:id/toggle - success', async () => {
    mockRepos.Agent.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Test Agent',
      status: 'active',
      ownerId: '00000000-0000-4000-8000-000000000005',
      capabilities: [],
      actor: { status: 'active', deletedAt: null },
    });
    mockRepos.Agent.save.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Test Agent',
      status: 'disabled',
    });

    return request(app.getHttpServer())
      .post('/agents/00000000-0000-4000-8000-000000000002/toggle')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(201)
      .expect((res: any) => {
        // ResponseInterceptor reads statusCode before NestJS sets the default 201 for POST
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('status', 'disabled');
      });
  });

  it('POST /agents/:id/reset-key - success', async () => {
    mockRepos.Agent.findOne.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Test Agent',
      ownerId: '00000000-0000-4000-8000-000000000005',
      capabilities: [],
      status: 'active',
      actor: { status: 'active', deletedAt: null },
    });
    mockRepos.ApiKey.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    mockRepos.ApiKey.create.mockReturnValue({});
    mockRepos.ApiKey.save.mockResolvedValue({});

    return request(app.getHttpServer())
      .post('/agents/00000000-0000-4000-8000-000000000002/reset-key')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(201)
      .expect((res: any) => {
        // ResponseInterceptor reads statusCode before NestJS sets the default 201 for POST
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveProperty('apiKey');
      });
  });
});
