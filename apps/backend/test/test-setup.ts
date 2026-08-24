import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral, DataSource } from 'typeorm';
import * as entities from '../src/database/entities';
import { AppModule } from '../src/app.module';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import * as crypto from 'crypto';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    createHash: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue('mocked-hash'),
    })),
  };
});

function createMockRepo<T extends ObjectLiteral = any>(EntityClass?: any, manager?: any) {
  const wrapWithPrototype = (fn: jest.Mock, proto: any) => {
    const original = fn;
    return jest.fn(async (...args: any[]) => {
      const result = await original(...args);
      if (!proto || !result || typeof result !== 'object') return result;
      const applyProto = (item: any) => {
        if (item && typeof item === 'object' && !item.constructor?.prototype?.name) {
            Object.setPrototypeOf(item, proto);
        }
        return item;
      };
      if (Array.isArray(result)) {
        return result.map(applyProto);
      }
      return applyProto(result);
    });
  };

  const mock: any = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findAndCount: jest.fn(),
    findBy: jest.fn(),
    save: jest.fn((entity) => Promise.resolve(entity)),
    create: jest.fn((entity) => entity),
    delete: jest.fn(),
    softDelete: jest.fn(),
    softRemove: jest.fn(),
    count: jest.fn(),
    countBy: jest.fn(),
    query: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
    findByIds: jest.fn(),
    createQueryBuilder: jest.fn(() => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn(),
        getMany: jest.fn(),
        getOne: jest.fn(),
        getRawMany: jest.fn().mockResolvedValue([]),
        // 默认 resolve undefined，模拟空表 SUM 场景（service 端有 ?? '0' 兜底）
        getRawOne: jest.fn().mockResolvedValue(undefined),
        getCount: jest.fn(),
        clone: jest.fn().mockReturnThis(),
      };
      if (EntityClass?.prototype) {
        qb.getManyAndCount = wrapWithPrototype(qb.getManyAndCount, EntityClass.prototype);
        qb.getMany = wrapWithPrototype(qb.getMany, EntityClass.prototype);
        qb.getOne = wrapWithPrototype(qb.getOne, EntityClass.prototype);
      }
      return qb;
    }),
  };

  if (EntityClass?.prototype) {
    mock.find = wrapWithPrototype(mock.find, EntityClass.prototype);
    mock.findOne = wrapWithPrototype(mock.findOne, EntityClass.prototype);
    mock.findOneBy = wrapWithPrototype(mock.findOneBy, EntityClass.prototype);
    mock.findAndCount = wrapWithPrototype(mock.findAndCount, EntityClass.prototype);
    mock.findBy = wrapWithPrototype(mock.findBy, EntityClass.prototype);
    mock.findByIds = wrapWithPrototype(mock.findByIds, EntityClass.prototype);
  }

  mock.manager = manager;

  return mock as unknown as jest.Mocked<Repository<T>>;
}

export async function createTestingApp(): Promise<{
  app: INestApplication;
  mockRepos: Record<string, jest.Mocked<Repository<any>>>;
}> {
  // NestJS module-token-factory uses crypto.createHash to generate module tokens.
  // We temporarily restore the real implementation so module tokens are generated
  // deterministically (same input → same hash). This avoids token collisions while
  // keeping dynamic-module imports/exports consistent.
  const { createHash: realCreateHash } = jest.requireActual('crypto');
  jest.mocked(crypto.createHash).mockImplementation(realCreateHash as any);

  const builder = Test.createTestingModule({
    imports: [AppModule],
  });

  const mockRepos: Record<string, jest.Mocked<Repository<any>>> = {};

  const managerMock: any = {
    save: jest.fn((entity: any) => {
      if (entity && typeof entity === 'object' && !entity.id) {
        entity.id = '00000000-0000-0000-0000-000000000000';
      }
      return Promise.resolve(entity);
    }),
    create: jest.fn((EntityClass: any, entity: any) => entity),
    transaction: jest.fn(async (cb: any) => cb(managerMock)),
    createQueryBuilder: jest.fn(),
    getRepository: jest.fn(),
  };

  const dataSourceMock = {
    isInitialized: true,
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    manager: managerMock,
    transaction: jest.fn((cb: any) => cb(managerMock)),
    // service 内经 dataSource 取仓库的路径（如 TaskService.create/reportResult 的
    // 幂等记录读写）→ 按实体类名映射到 mockRepos 中对应的 mock repo
    getRepository: jest.fn((entityClass: any) => mockRepos[entityClass?.name]),
  };

  for (const [name, EntityClass] of Object.entries(entities)) {
    if (typeof EntityClass === 'function') {
      const mock = createMockRepo(EntityClass, managerMock);
      mockRepos[name] = mock;
      builder.overrideProvider(getRepositoryToken(EntityClass as any)).useValue(mock);
    }
  }

  // Prevent TypeORM from connecting to a real database
  builder.overrideProvider(DataSource).useValue(dataSourceMock as any);

  const dummyAuthGuard = {
    canActivate: (context: any) => {
      const req = context.switchToHttp().getRequest();
      req.user = {
        userId: '00000000-0000-4000-8000-000000000005',
        email: 'test@example.com',
        role: 'observer',
        name: 'Test User',
      };
      return true;
    },
  };

  builder
    .overrideGuard(JwtAuthGuard)
    .useValue(dummyAuthGuard)
    .overrideGuard(JwtOrApiKeyGuard)
    .useValue(dummyAuthGuard)
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true });

  // JwtStrategy (called by the APP_GUARD/global JwtAuthGuard) requires the loaded
  // User to have an active Actor. Provide a default valid user for E2E auth contexts.
  mockRepos.User.findOne.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000005',
    email: 'test@example.com',
    username: 'testuser',
    role: 'observer',
    status: 'active',
    deletedAt: null,
    actor: { status: 'active' },
  } as any);

  const moduleRef: TestingModule = await builder.compile();

  // Restore createHash to return predictable 'mocked-hash' for service tests
  jest.mocked(crypto.createHash).mockImplementation(
    () =>
      ({
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('mocked-hash'),
      }) as any,
  );

  const app = moduleRef.createNestApplication();

  // 与 main.ts 对齐注册 WsAdapter：M1阶段3 起 AppModule 含 runner WS gateway，
  // E2E 绕开 main.ts 引导，缺 WS driver 会在 app.init() 抛
  // "No driver (WebSockets) has been selected"（6 suites 全灭的既有债）
  app.useWebSocketAdapter(new WsAdapter(app));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.init();

  return { app, mockRepos };
}
