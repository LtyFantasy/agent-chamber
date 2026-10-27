/**
 * Usage 双桶限流（alpha.19）。
 *
 * 与 `memory-recall-throttle.spec.ts` 同结构：真端点阈值在测试环境被放宽到 100_000
 * （e2e 多次翻页会撞桶），故 429 语义在**同构 dummy controller** 上判；真端点只判
 * "元数据已接线"与"生产默认值被钉住"。
 *
 * 桶：default（IP 拦洪）+ actor（身份公平配额），两桶独立计数。Usage 的生产默认是
 * **10/min**（不是 recall 的 300/30）——它扫 ledger 的成本更高。
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Controller, Get, HttpCode, HttpStatus, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request = require('supertest');
import { actorTracker } from '../../common/utils/throttler-trackers';
import { MemoryController } from './memory.controller';

const TTL_MS = 60_000;
const GLOBAL_LIMIT = 100_000;
const RELAXED_LIMIT = 100_000;
const WIDE = 1_000;

/** 与两条 usage 端点同构的 @Throttle 声明（桶名/TRACKER/TTL 完全一致） */
const usageLikeThrottle = (ipLimit: number, actorLimit: number) =>
  Throttle({
    default: { limit: ipLimit, ttl: TTL_MS },
    actor: { limit: actorLimit, ttl: TTL_MS, getTracker: actorTracker },
  });

@Controller('usage-throttle-probe')
class UsageThrottleProbeController {
  @usageLikeThrottle(3, 2)
  @Get('both-tight')
  @HttpCode(HttpStatus.OK)
  bothTight() {
    return { ok: true };
  }

  @usageLikeThrottle(WIDE, 2)
  @Get('actor-isolation')
  @HttpCode(HttpStatus.OK)
  actorIsolation() {
    return { ok: true };
  }

  @usageLikeThrottle(3, WIDE)
  @Get('shared-ip')
  @HttpCode(HttpStatus.OK)
  sharedIp() {
    return { ok: true };
  }
}

interface ProbeIdentity {
  agent?: { id: string } | null;
  user?: { userId: string } | null;
}

describe('usage 双桶限流（alpha.19）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { ttl: TTL_MS, limit: GLOBAL_LIMIT },
          { name: 'actor', ttl: TTL_MS, limit: GLOBAL_LIMIT },
        ]),
      ],
      controllers: [UsageThrottleProbeController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    app = module.createNestApplication();
    app.use((req: unknown, _res: unknown, next: () => void) => {
      const r = req as ProbeIdentity & { headers: Record<string, string | undefined> };
      const agentId = r.headers['x-test-agent'];
      if (typeof agentId === 'string' && agentId.length > 0) r.agent = { id: agentId };
      const userId = r.headers['x-test-user'];
      if (typeof userId === 'string' && userId.length > 0) r.user = { userId };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('同一 agent 超过 actor 桶配额 ⇒ 429（`Retry-After-actor`），两桶独立计数', async () => {
    const server = app.getHttpServer();
    const asAgent = (id: string) =>
      request(server).get('/usage-throttle-probe/both-tight').set('X-Test-Agent', id);

    await asAgent('agent-A').expect(200);
    await asAgent('agent-A').expect(200);

    const blocked = await asAgent('agent-A').expect(429);
    expect(blocked.headers['retry-after-actor']).toBeDefined();
    expect(blocked.headers['retry-after']).toBeUndefined();
    // default 桶先放行并写了计数头；那是 IP 桶的数字，不代表 IP 桶也超限
    expect(blocked.headers['x-ratelimit-limit']).toBe('3');
    expect(blocked.headers['x-ratelimit-limit-actor']).toBeUndefined();
  });

  it('actor 桶按身份隔离（不同 agent 互不挤占）', async () => {
    const server = app.getHttpServer();
    const asAgent = (id: string) =>
      request(server).get('/usage-throttle-probe/actor-isolation').set('X-Test-Agent', id);

    await asAgent('agent-1').expect(200);
    await asAgent('agent-1').expect(200);
    await asAgent('agent-1').expect(429);

    await asAgent('agent-2').expect(200);
    await asAgent('agent-2').expect(200);
    await asAgent('agent-2').expect(429);
  });

  it('IP 桶跨身份合计计数（双桶不是冗余）', async () => {
    const server = app.getHttpServer();
    const asAgent = (id: string) =>
      request(server).get('/usage-throttle-probe/shared-ip').set('X-Test-Agent', id);

    await asAgent('agent-P').expect(200);
    await asAgent('agent-P').expect(200);
    await asAgent('agent-Q').expect(200);
    const blocked = await asAgent('agent-Q').expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('真 usage 端点：双桶元数据已接线（LIMIT/TTL/TRACKER × default/actor）', () => {
    for (const handler of [
      MemoryController.prototype.getUsageSummary,
      MemoryController.prototype.getUsageTrace,
    ]) {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(RELAXED_LIMIT);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(TTL_MS);
      expect(Reflect.getMetadata('THROTTLER:LIMITactor', handler)).toBe(RELAXED_LIMIT);
      expect(Reflect.getMetadata('THROTTLER:TTLactor', handler)).toBe(TTL_MS);
      expect(Reflect.getMetadata('THROTTLER:TRACKERactor', handler)).toBe(actorTracker);
      expect(Reflect.getMetadata('THROTTLER:TRACKERdefault', handler)).toBeUndefined();
    }
  });

  it('生产默认阈值实读 = IP 10 / actor 10（isolateModules 穿透 isTestEnv 遮蔽）', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevWorkerId = process.env.JEST_WORKER_ID;
    const prevIp = process.env.MEMORY_USAGE_IP_THROTTLE_LIMIT;
    const prevActor = process.env.MEMORY_USAGE_THROTTLE_LIMIT;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.JEST_WORKER_ID;
      delete process.env.MEMORY_USAGE_IP_THROTTLE_LIMIT;
      delete process.env.MEMORY_USAGE_THROTTLE_LIMIT;

      let ipLimit: unknown;
      let actorLimit: unknown;
      let actorTtl: unknown;
      jest.isolateModules(() => {
        const isolated =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('./memory.controller') as typeof import('./memory.controller');
        ipLimit = Reflect.getMetadata(
          'THROTTLER:LIMITdefault',
          isolated.MemoryController.prototype.getUsageTrace,
        );
        actorLimit = Reflect.getMetadata(
          'THROTTLER:LIMITactor',
          isolated.MemoryController.prototype.getUsageTrace,
        );
        actorTtl = Reflect.getMetadata(
          'THROTTLER:TTLactor',
          isolated.MemoryController.prototype.getUsageTrace,
        );
      });

      expect(ipLimit).toBe(10);
      expect(actorLimit).toBe(10);
      expect(actorTtl).toBe(TTL_MS);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevWorkerId === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = prevWorkerId;
      if (prevIp === undefined) delete process.env.MEMORY_USAGE_IP_THROTTLE_LIMIT;
      else process.env.MEMORY_USAGE_IP_THROTTLE_LIMIT = prevIp;
      if (prevActor === undefined) delete process.env.MEMORY_USAGE_THROTTLE_LIMIT;
      else process.env.MEMORY_USAGE_THROTTLE_LIMIT = prevActor;
    }
  });

  it('阈值/TTL 单源被源码钉住（不耦合 recall TTL、不硬编码 10）', () => {
    const controllerSrc = fs.readFileSync(path.join(__dirname, 'memory.controller.ts'), 'utf-8');
    // 阈值来自 memory.constants 的 MEMORY_USAGE_THROTTLE_LIMIT（env 逃生口只覆盖值）
    expect(controllerSrc).toContain('process.env.MEMORY_USAGE_IP_THROTTLE_LIMIT');
    expect(controllerSrc).toContain('process.env.MEMORY_USAGE_THROTTLE_LIMIT');
    expect(controllerSrc).toContain('String(MEMORY_USAGE_THROTTLE_LIMIT)');
    // TTL 来自 MEMORY_USAGE_THROTTLE_TTL_MS，**不再**复用 recall 的 TTL 常量
    expect(controllerSrc).toContain('MEMORY_USAGE_THROTTLE_TTL_MS');
    const summaryBlock = controllerSrc.slice(
      controllerSrc.indexOf("projects/:id/usage/summary"),
      controllerSrc.indexOf('async getUsageSummary'),
    );
    const traceBlock = controllerSrc.slice(
      controllerSrc.indexOf("projects/:id/usage/trace"),
      controllerSrc.indexOf('async getUsageTrace'),
    );
    for (const block of [summaryBlock, traceBlock]) {
      expect(block).toContain('MEMORY_USAGE_THROTTLE_TTL_MS');
      expect(block).not.toContain('MEMORY_RECALL_THROTTLE_TTL_MS');
      // 端点级阈值不得再出现裸字面量 10（防"改常量但路由没跟着"）
      expect(block).not.toMatch(/limit:\s*10\b/);
    }
  });
});
