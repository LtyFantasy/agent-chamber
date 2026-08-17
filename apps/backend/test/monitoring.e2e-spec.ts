import request = require('supertest');
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createTestingApp } from './test-setup';

describe('MonitoringController (e2e)', () => {
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
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /system/overview - success', async () => {
    const seenAt = new Date('2026-08-15T08:00:00Z');
    // 1.54.0 埋点批：ring 条目带 injectedAt（后端发出时刻），与批内消息 createdAt 配对
    const injectedAt = new Date(seenAt.getTime() + 1200).toISOString(); // 延迟样本 1200ms
    mockRepos.RoundtableRunner.find.mockResolvedValue([
      { id: 'r1', name: 'prod-kimi', status: 'online', version: '0.4.0', lastSeenAt: seenAt },
    ]);
    mockRepos.RoundtableSeat.find.mockResolvedValue([
      {
        id: 's1', label: 'kimi-1', vendor: 'kimi', status: 'active', topicId: 't1', runnerId: 'r1',
        state: { recentInjects: [{ seq: 1, messageIds: ['m1'], injectedAt }] },
      },
    ]);
    mockRepos.Message.find.mockResolvedValue([{ id: 'm1', createdAt: seenAt }]);
    mockRepos.Message.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(1),
    });
    mockRepos.Event.count.mockResolvedValue(42);
    mockRepos.Event.find.mockResolvedValue([{ createdAt: seenAt }]);
    mockRepos.Event.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(5),
      getRawMany: jest.fn().mockResolvedValue([{ eventType: 'message.created', count: '5' }]),
    });
    mockRepos.WebhookDelivery.count.mockResolvedValue(0);
    mockRepos.WebhookDelivery.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(undefined),
    });

    return request(app.getHttpServer())
      .get('/system/overview')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        const data = res.body.data;
        expect(data.runners.total).toBe(1);
        expect(data.runners.online).toBe(1);
        expect(data.runners.items[0].seatCount).toBe(1);
        expect(data.seats.total).toBe(1);
        // backlogEstimate 字段链路：ring 非空座位返回 COUNT 值
        expect(data.seats.items[0].backlogEstimate).toBe(1);
        expect(data.events.total).toBe(42);
        expect(data.events.last24h).toBe(5);
        expect(data.events.latestEventAt).toBe(seenAt.toISOString());
        expect(data.events.byTypeLast24h).toEqual([{ eventType: 'message.created', count: 5 }]);
        // 无完结投递 → null（前端空态语义）
        expect(data.webhooks.successRate).toBeNull();
        expect(data.webhooks.avgResponseTimeMs).toBeNull();
        // 1.54.0 埋点批：injection 五字段（延迟样本 1200ms，retry/fail 计数全 0）
        expect(data.injection).toEqual({
          latencySamples: 1,
          latencyAvgMs: 1200,
          latencyMaxMs: 1200,
          retryCount: 0,
          failCount: 0,
        });
        // sse 活跃连接：本 e2e 无 /events/stream 连接 → 0（number gauge）
        expect(typeof data.sse.activeConnections).toBe('number');
        expect(data.sse.activeConnections).toBe(0);
      });
  });

  it('GET /system/overview - empty platform returns zeroed structure', async () => {
    mockRepos.RoundtableRunner.find.mockResolvedValue([]);
    mockRepos.RoundtableSeat.find.mockResolvedValue([]);
    mockRepos.Event.count.mockResolvedValue(0);
    mockRepos.Event.find.mockResolvedValue([]);
    mockRepos.Event.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
      getRawMany: jest.fn().mockResolvedValue([]),
    });
    mockRepos.WebhookDelivery.count.mockResolvedValue(0);
    mockRepos.WebhookDelivery.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(undefined),
    });

    return request(app.getHttpServer())
      .get('/system/overview')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        const data = res.body.data;
        expect(data.runners).toEqual({ total: 0, online: 0, offline: 0, items: [] });
        expect(data.seats).toEqual({ total: 0, unbound: 0, byStatus: {}, items: [] });
        expect(data.events.latestEventAt).toBeNull();
        // 空平台 → injection 空态（samples=0 → avg/max null）+ sse gauge 0
        expect(data.injection).toEqual({
          latencySamples: 0,
          latencyAvgMs: null,
          latencyMaxMs: null,
          retryCount: 0,
          failCount: 0,
        });
        expect(data.sse).toEqual({ activeConnections: 0 });
      });
  });

  it('GET /system/api-logs - success with backend aggregates', async () => {
    mockRepos.AuditLog.findAndCount.mockResolvedValue([[], 0]);
    // 聚合链：todayCount（getCount）+ uniqueActors（getRawOne）
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(4),
      getRawOne: jest.fn().mockResolvedValue({ count: '2' }),
    };
    mockRepos.AuditLog.createQueryBuilder.mockReturnValue(qb as any);

    return request(app.getHttpServer())
      .get('/system/api-logs')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect((res: any) => {
        expect(res.body.code).toBe(200);
        expect(res.body.data.total).toBe(0);
        expect(res.body.data.todayCount).toBe(4);
        expect(res.body.data.uniqueActors).toBe(2);
      });
  });

  it('GET /system/api-logs - startDate/endDate 时间过滤透传到查询', async () => {
    mockRepos.AuditLog.findAndCount.mockResolvedValue([[], 0]);

    return request(app.getHttpServer())
      .get('/system/api-logs?startDate=2026-08-01T00:00:00Z&endDate=2026-08-15T00:00:00Z')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)
      .expect(() => {
        const call = mockRepos.AuditLog.findAndCount.mock.calls[0][0] as any;
        // 双边区间 → TypeORM Between operator
        expect(call.where?.createdAt?._type).toBe('between');
      });
  });
});
