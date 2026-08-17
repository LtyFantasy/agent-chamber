import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral } from 'typeorm';
import { MonitoringService } from './monitoring.service';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { RoundtableRunner } from '../../database/entities/roundtable-runner.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { Event } from '../../database/entities/event.entity';
import { WebhookDelivery } from '../../database/entities/webhook-delivery.entity';
import { Message } from '../../database/entities/message.entity';
import { SseService } from '../sse/sse.service';
import { AuditAction, ActorType, WebhookStatus } from '@agent-chamber/shared';

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
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      getCount: jest.fn(),
      getRawMany: jest.fn().mockResolvedValue([]),
      // 默认 resolve undefined，模拟空表聚合场景（service 端有 null 兜底）
      getRawOne: jest.fn().mockResolvedValue(undefined),
    })),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('MonitoringService', () => {
  let service: MonitoringService;
  let mockRepo: jest.Mocked<Repository<AuditLog>>;
  let mockRunnerRepo: jest.Mocked<Repository<RoundtableRunner>>;
  let mockSeatRepo: jest.Mocked<Repository<RoundtableSeat>>;
  let mockEventRepo: jest.Mocked<Repository<Event>>;
  let mockWebhookRepo: jest.Mocked<Repository<WebhookDelivery>>;
  let mockMessageRepo: jest.Mocked<Repository<Message>>;
  /** SseService mock（1.54.0 埋点批：getOverview 注入 sse 块，第 7 个构造依赖） */
  let mockSseService: { getActiveConnections: jest.Mock };

  beforeEach(async () => {
    mockRepo = createMockRepo<AuditLog>();
    mockRunnerRepo = createMockRepo<RoundtableRunner>();
    mockSeatRepo = createMockRepo<RoundtableSeat>();
    mockEventRepo = createMockRepo<Event>();
    mockWebhookRepo = createMockRepo<WebhookDelivery>();
    mockMessageRepo = createMockRepo<Message>();
    mockSseService = { getActiveConnections: jest.fn().mockReturnValue(0) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringService,
        { provide: getRepositoryToken(AuditLog), useValue: mockRepo },
        { provide: getRepositoryToken(RoundtableRunner), useValue: mockRunnerRepo },
        { provide: getRepositoryToken(RoundtableSeat), useValue: mockSeatRepo },
        { provide: getRepositoryToken(Event), useValue: mockEventRepo },
        { provide: getRepositoryToken(WebhookDelivery), useValue: mockWebhookRepo },
        { provide: getRepositoryToken(Message), useValue: mockMessageRepo },
        { provide: SseService, useValue: mockSseService },
      ],
    }).compile();

    service = moduleRef.get<MonitoringService>(MonitoringService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getApiLogs', () => {
    /**
     * 配置 audit 仓的 queryBuilder 聚合（getApiLogs 内两次调用：todayCount 的
     * getCount + uniqueActors 的 getRawOne，形状同构可共用一个 qb mock）
     */
    function mockAuditAggregates(todayCount: number, uniqueActors: number) {
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(todayCount),
        getRawOne: jest.fn().mockResolvedValue({ count: String(uniqueActors) }),
      };
      mockRepo.createQueryBuilder.mockReturnValue(qb as never);
      return qb;
    }

    it('should return paginated results with default values and header aggregates', async () => {
      const items = [
        {
          id: 'log-1',
          action: AuditAction.LOGIN,
          entityType: 'user',
          entityId: 'user-1',
          actorId: 'user-1',
          actorType: ActorType.HUMAN,
          ipAddress: '127.0.0.1',
          createdAt: new Date(),
        },
      ] as AuditLog[];
      mockRepo.findAndCount.mockResolvedValue([items, 1]);
      mockAuditAggregates(5, 3);

      const result = await service.getApiLogs({});

      // 无时间过滤参数 → where 为空对象（保持全量）
      expect(mockRepo.findAndCount).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 20,
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual({
        items,
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
        todayCount: 5,
        uniqueActors: 3,
      });
    });

    it('should return paginated results with custom page and pageSize', async () => {
      const items = [{ id: 'log-2' }] as AuditLog[];
      mockRepo.findAndCount.mockResolvedValue([items, 25]);
      mockAuditAggregates(0, 0);

      const result = await service.getApiLogs({ page: 2, pageSize: 10 });

      expect(mockRepo.findAndCount).toHaveBeenCalledWith({
        where: {},
        skip: 10,
        take: 10,
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual({
        items,
        total: 25,
        page: 2,
        pageSize: 10,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
        todayCount: 0,
        uniqueActors: 0,
      });
    });

    it('should handle empty results', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);
      mockAuditAggregates(0, 0);

      const result = await service.getApiLogs({ page: 3, pageSize: 5 });

      expect(result).toEqual({
        items: [],
        total: 0,
        page: 3,
        pageSize: 5,
        totalPages: 0,
        hasNext: false,
        hasPrev: true,
        todayCount: 0,
        uniqueActors: 0,
      });
    });

    it('should handle last page correctly', async () => {
      const items = [{ id: 'log-3' }] as AuditLog[];
      mockRepo.findAndCount.mockResolvedValue([items, 21]);
      mockAuditAggregates(1, 1);

      const result = await service.getApiLogs({ page: 2, pageSize: 20 });

      expect(result).toEqual({
        items,
        total: 21,
        page: 2,
        pageSize: 20,
        totalPages: 2,
        hasNext: false,
        hasPrev: true,
        todayCount: 1,
        uniqueActors: 1,
      });
    });

    it('should apply startDate/endDate time filter when provided', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);
      mockAuditAggregates(2, 4);

      // 双边区间
      await service.getApiLogs({
        startDate: '2026-08-01T00:00:00Z',
        endDate: '2026-08-15T00:00:00Z',
      });
      let where = (
        mockRepo.findAndCount.mock.calls[0][0] as { where: { createdAt?: { _type?: string } } }
      ).where;
      expect(where.createdAt?._type).toBe('between');

      // 单边：仅 startDate → >=
      await service.getApiLogs({ startDate: '2026-08-01T00:00:00Z' });
      where = (
        mockRepo.findAndCount.mock.calls[1][0] as { where: { createdAt?: { _type?: string } } }
      ).where;
      expect(where.createdAt?._type).toBe('moreThanOrEqual');

      // 单边：仅 endDate → <=
      await service.getApiLogs({ endDate: '2026-08-15T00:00:00Z' });
      where = (
        mockRepo.findAndCount.mock.calls[2][0] as { where: { createdAt?: { _type?: string } } }
      ).where;
      expect(where.createdAt?._type).toBe('lessThanOrEqual');
    });

    it('should aggregate todayCount from server-local midnight regardless of filters', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);
      const qb = mockAuditAggregates(7, 2);

      const result = await service.getApiLogs({ startDate: '2026-08-01T00:00:00Z' });

      // todayCount 不受时间过滤影响：固定查「服务器本地当日 0 点」起
      const todayCall = qb.where.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('todayStart'),
      );
      expect(todayCall).toBeDefined();
      const passed = (todayCall[1] as { todayStart: Date }).todayStart;
      expect(passed.getHours()).toBe(0);
      expect(passed.getMinutes()).toBe(0);
      expect(result.todayCount).toBe(7);
      expect(result.uniqueActors).toBe(2);
    });
  });

  describe('exportApiLogs', () => {
    it('should return exported logs with count and timestamp', async () => {
      const logs = [
        { id: 'log-1', action: AuditAction.LOGIN },
        { id: 'log-2', action: AuditAction.CREATE },
      ] as AuditLog[];
      mockRepo.find.mockResolvedValue(logs);

      const result = await service.exportApiLogs({});

      expect(mockRepo.find).toHaveBeenCalledWith({
        order: { createdAt: 'DESC' },
        take: 1000,
      });
      expect(result.data).toEqual(logs);
      expect(result.count).toBe(2);
      expect(result.exportedAt).toBeDefined();
      expect(new Date(result.exportedAt).toISOString()).toBe(result.exportedAt);
    });

    it('should handle empty logs export', async () => {
      mockRepo.find.mockResolvedValue([]);

      const result = await service.exportApiLogs({});

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.exportedAt).toBeDefined();
    });
  });

  describe('getOverview', () => {
    /** 配置 webhook count 按 where 条件分流（total/pending/success/failed/retrying） */
    function mockWebhookCounts(map: {
      total: number;
      pending: number;
      success: number;
      failed: number;
      retrying: number;
    }) {
      mockWebhookRepo.count.mockImplementation((opts?: unknown) => {
        const where = (opts as { where?: Record<string, unknown> } | undefined)?.where;
        if (!where) return Promise.resolve(map.total);
        if (where.status === WebhookStatus.PENDING && where.retryCount)
          return Promise.resolve(map.retrying);
        if (where.status === WebhookStatus.PENDING) return Promise.resolve(map.pending);
        if (where.status === WebhookStatus.SUCCESS) return Promise.resolve(map.success);
        if (where.status === WebhookStatus.FAILED) return Promise.resolve(map.failed);
        return Promise.resolve(0);
      });
    }

    it('should return zeroed overview when platform is empty', async () => {
      mockRunnerRepo.find.mockResolvedValue([]);
      mockSeatRepo.find.mockResolvedValue([]);
      mockEventRepo.count.mockResolvedValue(0);
      mockEventRepo.find.mockResolvedValue([]);
      const eventQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      mockEventRepo.createQueryBuilder.mockReturnValue(eventQb as never);
      mockWebhookCounts({ total: 0, pending: 0, success: 0, failed: 0, retrying: 0 });

      const result = await service.getOverview();

      expect(result.runners).toEqual({ total: 0, online: 0, offline: 0, items: [] });
      expect(result.seats).toEqual({ total: 0, unbound: 0, byStatus: {}, items: [] });
      expect(result.events.total).toBe(0);
      expect(result.events.last24h).toBe(0);
      expect(result.events.latestEventAt).toBeNull();
      expect(result.events.byTypeLast24h).toEqual([]);
      // 无完结投递 → successRate/avgResponseTimeMs 为 null（前端显示空态而非 0%）
      expect(result.webhooks.successRate).toBeNull();
      expect(result.webhooks.avgResponseTimeMs).toBeNull();
      expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
      // 1.54.0 埋点批：空平台 → injection 全 0 空态 + sse 瞬时 gauge 0
      expect(result.injection).toEqual({
        latencySamples: 0,
        latencyAvgMs: null,
        latencyMaxMs: null,
        retryCount: 0,
        failCount: 0,
      });
      expect(result.sse).toEqual({ activeConnections: 0 });
    });

    it('should aggregate runners, seats with backlog estimates, events and webhooks', async () => {
      const seenAt = new Date('2026-08-15T08:00:00Z');
      const injectedOld = new Date('2026-08-15T07:00:00Z');
      const injectedNew = new Date('2026-08-15T07:05:00Z');

      mockRunnerRepo.find.mockResolvedValue([
        { id: 'r1', name: 'prod-kimi', status: 'online', version: '0.4.0', lastSeenAt: seenAt },
        { id: 'r2', name: 'stale-runner', status: 'offline', version: null, lastSeenAt: null },
      ] as RoundtableRunner[]);
      mockSeatRepo.find.mockResolvedValue([
        {
          id: 's1',
          label: 'kimi-1',
          vendor: 'kimi',
          status: 'active',
          topicId: 't1',
          runnerId: 'r1',
          state: { recentInjects: [{ seq: 1, messageIds: ['m1', 'm2'] }] },
        },
        // 未绑 runner 且从未派发（state 空）→ backlog null
        {
          id: 's2',
          label: 'codex-1',
          vendor: 'codex',
          status: 'offline',
          topicId: 't1',
          runnerId: null,
          state: {},
        },
        // 绑定 r1 但 ring 为空 → backlog null
        {
          id: 's3',
          label: 'kimi-2',
          vendor: 'kimi',
          status: 'paused',
          topicId: 't2',
          runnerId: 'r1',
          state: { recentInjects: [] },
        },
      ] as unknown as RoundtableSeat[]);

      // ring 消息批量取回（一次 find，select id+createdAt）
      mockMessageRepo.find.mockResolvedValue([
        { id: 'm1', createdAt: injectedOld },
        { id: 'm2', createdAt: injectedNew },
      ] as Message[]);
      // s1 的积压 COUNT（queryBuilder 链）；s2/s3 ring 空不走查询
      const backlogQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(2),
      };
      mockMessageRepo.createQueryBuilder.mockReturnValue(backlogQb as never);

      mockEventRepo.count.mockResolvedValue(100);
      mockEventRepo.find.mockResolvedValue([{ createdAt: seenAt }] as Event[]);
      const eventQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(12),
        getRawMany: jest.fn().mockResolvedValue([
          { eventType: 'task.updated', count: '2' },
          { eventType: 'message.created', count: '10' },
        ]),
      };
      mockEventRepo.createQueryBuilder.mockReturnValue(eventQb as never);

      mockWebhookCounts({ total: 10, pending: 2, success: 7, failed: 1, retrying: 1 });
      const whQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ avg: '123.4' }),
      };
      mockWebhookRepo.createQueryBuilder.mockReturnValue(whQb as never);

      const result = await service.getOverview();

      expect(result.runners.total).toBe(2);
      expect(result.runners.online).toBe(1);
      expect(result.runners.offline).toBe(1);
      expect(result.runners.items[0]).toEqual({
        id: 'r1',
        name: 'prod-kimi',
        status: 'online',
        version: '0.4.0',
        lastSeenAt: seenAt.toISOString(),
        seatCount: 2,
      });
      expect(result.runners.items[1].seatCount).toBe(0);

      expect(result.seats.total).toBe(3);
      expect(result.seats.unbound).toBe(1);
      expect(result.seats.byStatus).toEqual({ active: 1, offline: 1, paused: 1 });
      const seatById = new Map(result.seats.items.map((s) => [s.id, s]));
      expect(seatById.get('s1')?.backlogEstimate).toBe(2);
      expect(seatById.get('s2')?.backlogEstimate).toBeNull();
      expect(seatById.get('s3')?.backlogEstimate).toBeNull();

      // 积压查询语义：水位下界 = ring 内最大 createdAt；回声抑制走 jsonb 路径
      expect(backlogQb.andWhere).toHaveBeenCalledWith('m.created_at >= :watermark', {
        watermark: injectedNew,
      });
      expect(backlogQb.andWhere).toHaveBeenCalledWith(
        "m.metadata->>'seatLabel' IS DISTINCT FROM :label",
        { label: 'kimi-1' },
      );

      expect(result.events).toEqual({
        total: 100,
        last24h: 12,
        latestEventAt: seenAt.toISOString(),
        byTypeLast24h: [
          { eventType: 'message.created', count: 10 },
          { eventType: 'task.updated', count: 2 },
        ],
      });

      expect(result.webhooks).toEqual({
        total: 10,
        pending: 2,
        success: 7,
        failed: 1,
        retrying: 1,
        successRate: 0.875,
        avgResponseTimeMs: 123,
      });
      // 1.54.0 埋点批：既有 ring 条目无 injectedAt（存量旧数据）→ null-skip，
      // injection 空态；sse gauge 取 mock 值 0
      expect(result.injection).toEqual({
        latencySamples: 0,
        latencyAvgMs: null,
        latencyMaxMs: null,
        retryCount: 0,
        failCount: 0,
      });
      expect(result.sse).toEqual({ activeConnections: 0 });
    });

    it('should return null successRate when no finished deliveries (avoid 0% misreading)', async () => {
      mockRunnerRepo.find.mockResolvedValue([]);
      mockSeatRepo.find.mockResolvedValue([]);
      mockEventRepo.count.mockResolvedValue(0);
      mockEventRepo.find.mockResolvedValue([]);
      // 只有 pending，没有 success/failed
      mockWebhookCounts({ total: 3, pending: 3, success: 0, failed: 0, retrying: 0 });

      const result = await service.getOverview();

      expect(result.webhooks.total).toBe(3);
      expect(result.webhooks.successRate).toBeNull();
    });

    it('should aggregate injection stats: skip legacy/no-injectedAt entries, avg/max rounding, retry/fail sums', async () => {
      // 混合场景（延迟样本语义见 shared InjectionOverview 注释）：
      // s1 旧条目 a1 无 injectedAt（存量数据）→ skip；b1 延迟 1001ms
      // s2 新条目 c1 延迟 1002ms；ghost-1 批内消息缺失 → skip；d1 负延迟（时钟防御）→ skip
      // s3 计数为 string（非 number）→ 求和缺省 0
      mockSseService.getActiveConnections.mockReturnValue(7);
      mockRunnerRepo.find.mockResolvedValue([]);
      mockSeatRepo.find.mockResolvedValue([
        {
          id: 's1',
          label: 'kimi-1',
          vendor: 'kimi',
          status: 'active',
          topicId: 't1',
          runnerId: 'r1',
          state: {
            injectRetryCount: 2,
            injectFailCount: 1,
            recentInjects: [
              { seq: 1, messageIds: ['a1'] }, // 存量旧条目：无 injectedAt
              { seq: 2, messageIds: ['b1'], injectedAt: '2026-08-15T08:00:02.001Z' },
            ],
          },
        },
        {
          id: 's2',
          label: 'codex-1',
          vendor: 'codex',
          status: 'active',
          topicId: 't1',
          runnerId: 'r2',
          state: {
            injectRetryCount: 3,
            recentInjects: [
              { seq: 3, messageIds: ['c1'], injectedAt: '2026-08-15T08:00:03.002Z' },
              { seq: 4, messageIds: ['ghost-1'], injectedAt: '2026-08-15T08:00:04.000Z' }, // 批内消息缺失
              { seq: 5, messageIds: ['d1'], injectedAt: '2026-08-15T07:00:00.000Z' }, // 负延迟
            ],
          },
        },
        {
          id: 's3',
          label: 'kimi-3',
          vendor: 'kimi',
          status: 'paused',
          topicId: 't2',
          runnerId: null,
          state: { injectRetryCount: '5', recentInjects: [] }, // string 计数不参与求和
        },
      ] as unknown as RoundtableSeat[]);
      // loadRingMessageCreatedAts 一次 IN 查询取全部 ring 消息 createdAt（含 ghost-1 的缺失）
      mockMessageRepo.find.mockResolvedValue([
        { id: 'a1', createdAt: new Date('2026-08-15T08:00:00.000Z') },
        { id: 'b1', createdAt: new Date('2026-08-15T08:00:01.000Z') },
        { id: 'c1', createdAt: new Date('2026-08-15T08:00:02.000Z') },
        { id: 'd1', createdAt: new Date('2026-08-15T08:00:00.000Z') },
      ] as Message[]);
      // s1/s2 ring 非空 → 各走一次积压 COUNT（值非本用例关注点）
      const backlogQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      };
      mockMessageRepo.createQueryBuilder.mockReturnValue(backlogQb as never);
      mockEventRepo.count.mockResolvedValue(0);
      mockEventRepo.find.mockResolvedValue([]);
      const eventQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      mockEventRepo.createQueryBuilder.mockReturnValue(eventQb as never);
      mockWebhookCounts({ total: 0, pending: 0, success: 0, failed: 0, retrying: 0 });

      const result = await service.getOverview();

      // 有效样本仅 b1（1001ms）与 c1（1002ms）：avg = round(1001.5) = 1002，max = 1002
      expect(result.injection).toEqual({
        latencySamples: 2,
        latencyAvgMs: 1002,
        latencyMaxMs: 1002,
        retryCount: 5, // 2 + 3（s3 的 '5' 为 string 缺省 0）
        failCount: 1, // 仅 s1 有
      });
      // sse 瞬时 gauge 透传 mock 值
      expect(result.sse).toEqual({ activeConnections: 7 });
      // 批量取回只发生一次（backlog 与 injection 共用，不重复查询）
      expect(mockMessageRepo.find).toHaveBeenCalledTimes(1);
    });

    it('should return null avg/max when injection samples are zero (legacy-only rings)', async () => {
      // 座位 ring 仅有存量旧条目（无 injectedAt）→ 全部 null-skip，samples=0；
      // 计数与样本无关，照常求和（sse 默认 mock 0）
      mockRunnerRepo.find.mockResolvedValue([]);
      mockSeatRepo.find.mockResolvedValue([
        {
          id: 's1',
          label: 'kimi-1',
          vendor: 'kimi',
          status: 'active',
          topicId: 't1',
          runnerId: 'r1',
          state: {
            injectRetryCount: 4,
            injectFailCount: 2,
            recentInjects: [{ seq: 1, messageIds: ['a1'] }],
          },
        },
      ] as unknown as RoundtableSeat[]);
      mockMessageRepo.find.mockResolvedValue([
        { id: 'a1', createdAt: new Date('2026-08-15T08:00:00.000Z') },
      ] as Message[]);
      const backlogQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      };
      mockMessageRepo.createQueryBuilder.mockReturnValue(backlogQb as never);
      mockEventRepo.count.mockResolvedValue(0);
      mockEventRepo.find.mockResolvedValue([]);
      const eventQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      mockEventRepo.createQueryBuilder.mockReturnValue(eventQb as never);
      mockWebhookCounts({ total: 0, pending: 0, success: 0, failed: 0, retrying: 0 });

      const result = await service.getOverview();

      expect(result.injection).toEqual({
        latencySamples: 0,
        latencyAvgMs: null, // samples=0 → 前端显示空态而非 0ms
        latencyMaxMs: null,
        retryCount: 4,
        failCount: 2,
      });
      expect(result.sse).toEqual({ activeConnections: 0 });
    });
  });
});
