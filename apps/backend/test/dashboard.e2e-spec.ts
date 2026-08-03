import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createTestingApp } from './test-setup';

describe('DashboardController (e2e)', () => {
  let app: INestApplication;
  let mockRepos: Record<string, any>;
  let authToken: string;

  beforeEach(async () => {
    ({ app, mockRepos } = await createTestingApp());

    const jwtService = app.get(JwtService);
    authToken = jwtService.sign({ sub: '00000000-0000-0000-0000-000000000005', email: 'test@example.com', role: 'observer' });

    // Support JwtStrategy validation for every request (Actor unified model)
    mockRepos.User.findOne.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000005',
      email: 'test@example.com',
      role: 'observer',
      status: 'active',
      deletedAt: null,
      actor: { status: 'active' },
    });

    // DashboardService.agentActivity / leaderboard use raw SQL queries for counting
    mockRepos.Message.manager = { query: jest.fn().mockResolvedValue([]) };
    mockRepos.Task.manager = { query: jest.fn().mockResolvedValue([]) };
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /dashboard/stats - success', async () => {
    // DashboardService.stats uses createQueryBuilder + innerJoin for Agent counts (Actor unified model)
    const agentQb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(3),
    };
    mockRepos.Agent.createQueryBuilder.mockReturnValue(agentQb as any);

    mockRepos.Topic.count.mockResolvedValueOnce(10).mockResolvedValueOnce(7);
    mockRepos.Task.count.mockResolvedValueOnce(20).mockResolvedValueOnce(15);
    mockRepos.Message.count.mockResolvedValueOnce(100);
    mockRepos.Board.count.mockResolvedValueOnce(4);

    return request(app.getHttpServer())
      .get('/dashboard/stats')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toEqual({
          totalAgents: 5,
          activeAgents: 3,
          totalTopics: 10,
          activeTopics: 7,
          totalTasks: 20,
          completedTasks: 15,
          totalMessages: 100,
          totalBoards: 4,
        });
      });
  });

  it('GET /dashboard/agent-activity - success', async () => {
    const agentQb = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { id: '00000000-0000-0000-0000-000000000002', name: 'Agent One', lastActiveAt: new Date() },
        { id: 'agent-2', name: 'Agent Two', lastActiveAt: new Date() },
      ]),
    };
    mockRepos.Agent.createQueryBuilder.mockReturnValue(agentQb as any);

    return request(app.getHttpServer())
      .get('/dashboard/agent-activity')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0]).toHaveProperty('agentId', '00000000-0000-0000-0000-000000000002');
      });
  });

  it('GET /dashboard/leaderboard - success', async () => {
    const agentQb = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { id: '00000000-0000-0000-0000-000000000002', name: 'Agent One' },
        { id: 'agent-2', name: 'Agent Two' },
      ]),
    };
    mockRepos.Agent.createQueryBuilder.mockReturnValue(agentQb as any);

    return request(app.getHttpServer())
      .get('/dashboard/leaderboard')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0]).toHaveProperty('messageCount', 0);
        expect(res.body.data[0]).toHaveProperty('activityScore', 0);
      });
  });

  it('GET /dashboard/recent-topics - success', async () => {
    mockRepos.Topic.find.mockResolvedValue([
      { id: '00000000-0000-0000-0000-000000000001', title: 'Recent Topic 1', updatedAt: new Date() },
      { id: 'topic-2', title: 'Recent Topic 2', updatedAt: new Date() },
    ]);

    return request(app.getHttpServer())
      .get('/dashboard/recent-topics')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0]).toHaveProperty('id', '00000000-0000-0000-0000-000000000001');
      });
  });
});
