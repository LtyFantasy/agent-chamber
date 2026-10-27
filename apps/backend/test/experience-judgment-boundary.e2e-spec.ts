/**
 * B5 受控 HTTP：真实 Controller/Service/DTO/信封/异常过滤器，全部持久化与判别均为内存桩。
 * 不导入 AppModule/test-setup，不连接 PG、不实例化 provider，不调用真实 backfill。
 */
import 'reflect-metadata';
import request = require('supertest');
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import { ExperienceController } from '../src/modules/experience/experience.controller';
import { ExperienceService } from '../src/modules/experience/experience.service';
import { ExperienceMemberService } from '../src/modules/experience/experience-member.service';
import { ExperienceJudgmentService } from '../src/modules/experience/experience-judgment.service';
import { ExperienceEntry } from '../src/database/entities/experience-entry.entity';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

/** 自建 actor/entry 标识，仅在本测试的内存仓储出现。 */
const actorId = '10000000-0000-4000-8000-000000000001';
const entryId = '20000000-0000-4000-8000-000000000001';
/** 库内微秒基准按原契约传递，不能被 JS 毫秒截断。 */
const updatedAtText = '2026-10-25 00:00:00.123456+00';
/** 最小合法请求，不含真实业务数据。 */
const createBody = {
  title: 'Fixture title',
  summary: 'Fixture summary',
  content: '## How verified\nFixture check.',
  intent: 'repair',
  signals: ['fixture'],
};
/** 非空有效旧快照，用 fresh GET 排除响应 override/suppression 假绿。 */
const oldJudgment = {
  provider: 'typesafe',
  model: 'fixture',
  judgedAt: '2026-10-24T00:00:00Z',
  completeness: { level: 'complete', confidence: 0.9 },
  reusability: null,
  signalQuality: null,
  duplicate: null,
  intentSuggestion: null,
  domainSuggestion: null,
  admissionSuggestion: null,
};

/** 所有查询返回深拷贝；链方法只记录形状，完全不生成或执行 SQL。 */
function queryBuilder(read: () => ExperienceEntry | null) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'andWhere',
    'orWhere',
    'addSelect',
    'select',
    'setLock',
    'setParameters',
    'setParameter',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'limit',
    'groupBy',
    'addGroupBy',
  ])
    qb[method] = jest.fn(() => qb);
  qb.clone = jest.fn(() => qb);
  qb.getOne = jest.fn(async () => structuredClone(read()));
  qb.getMany = jest.fn(async () => []);
  qb.getRawMany = jest.fn(async () => []);
  qb.getCount = jest.fn(async () => 0);
  qb.getRawAndEntities = jest.fn(async () => ({ entities: [], raw: [] }));
  qb.getQueryAndParameters = jest.fn(() => ['SELECT domains FROM fixture_only', []]);
  return qb;
}

describe('Experience judgment boundary (controlled HTTP)', () => {
  let app: INestApplication;
  let service: ExperienceService;
  let raw: ExperienceEntry | null;
  let pending: ExperienceEntry | null;
  let requestActor: string;
  let businessFailure: 'transaction' | 'duplicates' | 'version-query' | null;
  let preparationFails: boolean;
  let order: string[];
  let savedRows: ExperienceEntry[];
  let judgments: { providerEnabled: boolean; evaluateAndPersist: jest.Mock };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };

  /** 确定性 fixture；原始行与每次仓储读取不共享对象引用。 */
  function initialEntry(): ExperienceEntry {
    return Object.assign(new ExperienceEntry(), {
      id: entryId,
      ...createBody,
      domains: [],
      env: {},
      quality: 'unverified',
      createdById: actorId,
      createdByType: ActorType.HUMAN,
      verifiedBy: null,
      verifiedAt: null,
      sourceProject: null,
      expiresAt: null,
      helpedCount: 0,
      notHelpfulCount: 0,
      distinctHelpedCount: 0,
      lastHelpedAt: null,
      createdAt: new Date('2026-10-24T00:00:00Z'),
      updatedAt: new Date('2026-10-25T00:00:00.123Z'),
      judgment: structuredClone(oldJudgment),
    });
  }

  beforeEach(async () => {
    raw = null;
    pending = null;
    requestActor = actorId;
    businessFailure = null;
    preparationFails = false;
    order = [];
    savedRows = [];
    judgments = { providerEnabled: true, evaluateAndPersist: jest.fn(async () => null) };
    const repo = {
      findOne: jest.fn(async () => null),
      createQueryBuilder: jest.fn(() => {
        const qb = queryBuilder(() => raw);
        qb.getRawMany.mockImplementation(async () => {
          if (businessFailure === 'duplicates')
            throw new Error('fixture business duplicates failed');
          return [];
        });
        return qb;
      }),
    };
    const manager = {
      create: jest.fn((_entity: unknown, fields: object) =>
        Object.assign(initialEntry(), fields, { judgment: null }),
      ),
      save: jest.fn(async (entry: ExperienceEntry) => {
        order.push('save');
        pending = structuredClone(entry);
        savedRows.push(structuredClone(entry));
        return structuredClone(entry);
      }),
      query: jest.fn(async () => {
        if (businessFailure === 'version-query') throw new Error('fixture version query failed');
        return [{ updated_at: updatedAtText }];
      }),
      getRepository: jest.fn((entity: unknown) => {
        if (entity !== ExperienceEntry) throw new Error('Unexpected fixture entity');
        return { createQueryBuilder: () => queryBuilder(() => pending) };
      }),
    };
    dataSource = {
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        pending = structuredClone(raw);
        if (businessFailure === 'transaction')
          throw new Error('fixture business transaction failed');
        try {
          const result = await fn(manager);
          raw = structuredClone(pending);
          order.push('commit');
          return result;
        } catch (error) {
          pending = null;
          order.push('rollback');
          throw error;
        }
      }),
      query: jest.fn(async () => {
        order.push('prepare');
        if (preparationFails) throw new Error('fixture optional vocabulary failed');
        return [];
      }),
    };
    const members = {
      evaluateReviewPermission: jest.fn(async () => ({ canReview: false })),
      resolveMemberRole: jest.fn(async () => null),
    };
    service = new ExperienceService(
      repo as never,
      {} as never,
      {} as never,
      { findOne: jest.fn(async () => null) } as never,
      dataSource as never,
      { log: jest.fn(async () => undefined) } as never,
      {
        isOwnerProxy: jest.fn(async () => false),
        getOwnedAgentIds: jest.fn(async () => []),
      } as never,
      members as never,
      { resolveProfiles: jest.fn(async () => new Map()) } as never,
      judgments as never,
    );
    const module = await Test.createTestingModule({
      controllers: [ExperienceController],
      providers: [
        { provide: ExperienceService, useValue: service },
        { provide: ExperienceMemberService, useValue: members },
        { provide: ExperienceJudgmentService, useValue: judgments },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({
        canActivate(ctx: ExecutionContext) {
          ctx.switchToHttp().getRequest().user = { userId: requestActor, name: 'Fixture reader' };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor(new Reflector()));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('POST preparation failure after commit returns 201/null with saved business state', async () => {
    preparationFails = true;
    const response = await request(app.getHttpServer())
      .post('/experiences')
      .send(createBody)
      .expect(201);
    expect(response.body).toMatchObject({ code: 200, data: { id: entryId, judgment: null } });
    expect(raw).toMatchObject({ title: createBody.title, judgment: null });
    expect(order).toEqual(['save', 'commit', 'prepare']);
    expect(judgments.evaluateAndPersist).not.toHaveBeenCalled();
  });

  it('PATCH preparation failure clears stored cache before fresh non-reviewer GET', async () => {
    raw = initialEntry();
    const initial = await request(app.getHttpServer()).get(`/experiences/${entryId}`).expect(200);
    expect(initial.body.data).toMatchObject({
      judgment: oldJudgment,
      viewerCanReview: false,
      judgmentSuppressed: false,
    });
    preparationFails = true;
    const updated = await request(app.getHttpServer())
      .patch(`/experiences/${entryId}`)
      .send({ content: 'Changed fixture body', expectedUpdatedAt: raw.updatedAt.toISOString() })
      .expect(200);
    expect(updated.body.data).toMatchObject({ judgment: null, judgmentSuppressed: false });
    expect(savedRows[0]).toMatchObject({ judgment: null });
    expect(raw).toMatchObject({ content: 'Changed fixture body', judgment: null });
    expect(order).toEqual(['save', 'commit', 'prepare']);
    const fresh = await request(app.getHttpServer()).get(`/experiences/${entryId}`).expect(200);
    expect(fresh.body.data).toMatchObject({
      judgment: null,
      viewerCanReview: false,
      judgmentSuppressed: false,
    });
  });

  it.each(['transaction', 'duplicates', 'version-query'] as const)(
    'POST business %s failure stays 500 and does not prepare',
    async (failure) => {
      businessFailure = failure;
      const response = await request(app.getHttpServer())
        .post('/experiences')
        .send(createBody)
        .expect(500);
      expect(response.body.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(raw).toBeNull();
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(judgments.evaluateAndPersist).not.toHaveBeenCalled();
    },
  );

  it.each(['version', 'permission'] as const)(
    'PATCH business %s failure retains 4xx and old cache',
    async (failure) => {
      raw = initialEntry();
      if (failure === 'permission') requestActor = '30000000-0000-4000-8000-000000000001';
      const response = await request(app.getHttpServer())
        .patch(`/experiences/${entryId}`)
        .send({
          content: 'Changed',
          expectedUpdatedAt:
            failure === 'version' ? '2020-01-01T00:00:00Z' : raw.updatedAt.toISOString(),
        })
        .expect(failure === 'version' ? 409 : 403);
      if (failure === 'version') expect(response.body.code).toBe(ErrorCode.RESOURCE_CONFLICT);
      expect(raw.judgment).toEqual(oldJudgment);
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(judgments.evaluateAndPersist).not.toHaveBeenCalled();
    },
  );

  it('DTO failure stays 400 before any business transaction', async () => {
    await request(app.getHttpServer())
      .post('/experiences')
      .send({ ...createBody, quality: 'verified' })
      .expect(400);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it.each(['/experiences', '/experiences/facets'])(
    'formal dictionary failure at %s stays 500 while provider is none',
    async (path) => {
      judgments.providerEnabled = false;
      preparationFails = true;
      await request(app.getHttpServer()).get(path).expect(500);
      expect(dataSource.query).toHaveBeenCalledTimes(1);
    },
  );
});
