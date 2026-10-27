/**
 * HealthController 单元测试（铁律 #17：新增观测字段必须同步测试覆盖）
 *
 * 覆盖点：
 * - 存活探针基础字段（status/timestamp/uptime）不回归
 * - version 来自 monorepo 根 package.json（子包 version 恒 1.0.0，是错误来源）
 * - commit：GIT_SHA 环境变量优先；无 GIT_SHA 时回退 git rev-parse（无 .git 环境则省略）
 * - readiness（F4 项1）：详情白名单渲染、失败固定文案（无 PG/路径原文）、HTTP 恒 200、
 *   限流接线（readiness 有 / check 无，P-C6）与按 IP 分桶隔离
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerGuard, Throttle } from '@nestjs/throttler';
import request = require('supertest');
import { DataSource } from 'typeorm';
import { HealthController } from './health.controller';
// 卡 5e6cb000：`ENGINE_HEALTH_VIEW` 派生 provider 的五态映射（判定顺序）在本文件钉住
import { MEMORY_ENGINE_FALLBACK, type MemoryConfig } from '../config/memory.config';
import { engineHealthViewProvider, type EngineHealthView } from '../modules/memory/memory.module';
import type { EngineHealthTracker } from '../modules/memory/engine-health-tracker.service';

/**
 * 限流探针替身（手法同 modules/auth/auth-throttle.spec.ts）：真端点 readiness() 在测试环境
 * 阈值放宽（100_000）不可判，故用携带同形 @Throttle 的 dummy controller 验证机制本身——
 * 「超限 429」与「按 XFF 最右段分桶」。真端点的接线由下方元数据断言钉死。
 */
const PROBE_TTL_MS = 60_000;

@Controller('health-throttle-probe')
class ReadyThrottleProbeController {
  @Throttle({ default: { limit: 2, ttl: PROBE_TTL_MS } })
  @Get('limited')
  limited() {
    return { status: 'ok' };
  }
}

/** 读取 monorepo 根 package.json 的 version（本文件位于 apps/backend/src/health/，向上 4 级为根） */
function rootPackageVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../../../package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

describe('HealthController', () => {
  /** DataSource 仅 readiness 使用，存活探针不触达，给最小桩即可 */
  const mockDataSource = { query: jest.fn() } as unknown as DataSource;

  /** GIT_SHA 环境变量隔离：每个用例前后清理，避免污染版本解析序 */
  const ORIGINAL_GIT_SHA = process.env.GIT_SHA;
  afterEach(() => {
    if (ORIGINAL_GIT_SHA === undefined) {
      delete process.env.GIT_SHA;
    } else {
      process.env.GIT_SHA = ORIGINAL_GIT_SHA;
    }
  });

  describe('check（存活探针）', () => {
    it('返回 status/timestamp/uptime 基础字段', () => {
      const controller = new HealthController(mockDataSource);
      const res = controller.check();
      expect(res.status).toBe('ok');
      expect(typeof res.timestamp).toBe('string');
      expect(typeof res.uptime).toBe('number');
    });

    it('version 等于 monorepo 根 package.json 的 version（而非子包 1.0.0）', () => {
      const controller = new HealthController(mockDataSource);
      const res = controller.check();
      expect(res.version).toBe(rootPackageVersion());
      expect(res.version).not.toBe('1.0.0');
      expect(res.version).not.toBe('unknown');
    });

    it('GIT_SHA 环境变量优先于 git rev-parse', () => {
      process.env.GIT_SHA = 'testsha123';
      const controller = new HealthController(mockDataSource);
      expect(controller.check().commit).toBe('testsha123');
    });

    it('无 GIT_SHA 时回退 git rev-parse（有 .git）或省略字段（无 .git）', () => {
      delete process.env.GIT_SHA;
      const controller = new HealthController(mockDataSource);
      const commit = controller.check().commit;
      // 开发/CI 环境有 .git → short SHA；docker 运行镜像无 .git → undefined。两种均合法
      if (commit !== undefined) {
        expect(commit).toMatch(/^[0-9a-f]{7,40}$/);
      }
    });

    it('chamber 品牌名（oss-rebrand 后）同样能解析 version（v1.57.3 冒烟 unknown 坑回归）', () => {
      // 搭临时目录模拟 chamber 快照仓布局：cwd=apps/backend（子包名不匹配），
      // 向上命中 name=agent-chamber 的根 package.json（fs.readFileSync 在本测试
      // 环境不可 redefine，改用真实文件 + process.chdir 驱动 findRepoRoot 上溯）
      const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chamber-health-'));
      fs.mkdirSync(path.join(tmp, 'apps', 'backend'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'apps', 'backend', 'package.json'),
        JSON.stringify({ name: '@agent-chamber/backend', version: '1.0.0' }),
      );
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'agent-chamber', version: '9.9.9-test' }),
      );
      const originalCwd = process.cwd();
      try {
        process.chdir(path.join(tmp, 'apps', 'backend'));
        const controller = new HealthController(mockDataSource);
        expect(controller.check().version).toBe('9.9.9-test');
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  // ─── readiness（F4 项1：消毒 + 白名单 + 限流）─────────────────────────────
  describe('readiness（就绪探针）', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      // 探针失败的原始错误只进日志（响应面只给固定文案）——spy 掉以免污染测试输出
      errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => errorSpy.mockRestore());

    it('db + disk 全 up：两个检查各自只有 status + responseTimeMs 两个键（白名单渲染，无 cwd）', async () => {
      const ds = { query: jest.fn().mockResolvedValue([{ column: 1 }]) } as unknown as DataSource;
      const controller = new HealthController(ds);

      const body = await controller.readiness();

      expect(body.status).toBe('ok');
      expect(body.error).toBeUndefined();
      const info = body.info as Record<string, Record<string, unknown>>;
      expect(Object.keys(info).sort()).toEqual(['database', 'disk']);
      for (const name of ['database', 'disk']) {
        // 键集合精确相等：disk 的 details 曾经是 { cwd: process.cwd() }（部署绝对路径泄露）
        expect(Object.keys(info[name]).sort()).toEqual(['responseTimeMs', 'status']);
        expect(typeof info[name].responseTimeMs).toBe('number');
      }
    });

    it('db down：固定文案（无 PG 原文），原始错误只进日志（带 [health/ready] 前缀）', async () => {
      const ds = {
        query: jest
          .fn()
          .mockRejectedValue(
            new Error('connect ECONNREFUSED 10.0.0.5:5432 db=agent_chamber user=postgres'),
          ),
      } as unknown as DataSource;
      const controller = new HealthController(ds);

      const body = await controller.readiness();

      expect(body.status).toBe('error');
      const errorBucket = body.error as Record<string, Record<string, unknown>>;
      expect(errorBucket.database).toEqual({ status: 'down', message: 'database check failed' });
      // 泄露面回归：PG/host/port/dbname 原文绝不进 body
      expect(JSON.stringify(body)).not.toMatch(
        /ECONNREFUSED|5432|agent_chamber|postgres|10\.0\.0\.5/,
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[health/ready] database check failed'),
      );
      // 恒 200 语义：readiness() 不抛 HttpException，只以 body 表达失败（HTTP 层断言在
      // 下一个 describe，这里断言方法级语义：**resolve** 且 body.status 为 error）
      await expect(controller.readiness()).resolves.toMatchObject({ status: 'error' });
    });

    it('白名单行为：未来新增的敏感 details 字段被过滤（F4-1 回归钉）', async () => {
      const controller = new HealthController(mockDataSource);
      // 私有检查替身：模拟「某次观测增强往 details 里塞了敏感字段」
      (controller as unknown as { checkDiskSpace: () => unknown }).checkDiskSpace = () => ({
        name: 'disk',
        status: 'up',
        details: {
          responseTimeMs: 3,
          cwd: '/srv/secret/deploy/path',
          databaseUrl: 'postgres://user:pw@host:5432/db',
        },
      });

      const body = await controller.readiness();

      const info = body.info as Record<string, Record<string, unknown>>;
      expect(info.disk).toEqual({ status: 'up', responseTimeMs: 3 });
      expect(JSON.stringify(body)).not.toMatch(/secret|postgres:\/\//);
    });

    it('限流接线：readiness 挂 @Throttle 元数据，check（liveness）绝不挂（P-C6）', () => {
      const readyLimit = Reflect.getMetadata(
        'THROTTLER:LIMITdefault',
        HealthController.prototype.readiness,
      );
      const readyTtl = Reflect.getMetadata(
        'THROTTLER:TTLdefault',
        HealthController.prototype.readiness,
      );

      // 测试环境阈值放宽为 100000（防 e2e 误伤），生产默认 120/min/IP——只断言元数据存在
      expect(typeof readyLimit).toBe('number');
      expect(readyLimit).toBeGreaterThan(0);
      expect(readyTtl).toBe(PROBE_TTL_MS);

      // ⚠️ 这条是本批最贵的回归：deploy.sh 健康门 2s 轮询 /health，给它加限流
      // 会把健康部署打成 429 → 自动回滚（P-C6）
      expect(
        Reflect.getMetadata('THROTTLER:LIMITdefault', HealthController.prototype.check),
      ).toBeUndefined();
    });
  });

  describe('readiness（就绪探针）— HTTP 层：依赖不健康时仍恒 200', () => {
    let app: INestApplication | undefined;

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    it('db down → HTTP 200（不是 503）+ body.status=error + 固定文案（真实 503 语义另立卡⑥）', async () => {
      const ds = {
        query: jest
          .fn()
          .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 db=agent_chamber')),
      };
      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [{ provide: DataSource, useValue: ds }],
      }).compile();
      app = module.createNestApplication();
      await app.init();

      const res = await request(app.getHttpServer()).get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('error');
      expect(res.body.error.database).toEqual({ status: 'down', message: 'database check failed' });
      expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|5432|agent_chamber/);
    });
  });

  describe('readiness 限流（F4 项1 / 依据 S-N4）', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        // 模块默认极宽松（同 app.module.ts），实际只对显式标注 @Throttle 的端点生效
        imports: [ThrottlerModule.forRoot([{ ttl: PROBE_TTL_MS, limit: 100_000 }])],
        controllers: [ReadyThrottleProbeController],
        providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
      }).compile();

      app = module.createNestApplication();
      // 与 main.ts 一致（生产经 nginx 反代）：不开 trust proxy 时 express 报的 req.ip 是
      // 反代地址，所有真实客户端会被合进同一个桶
      (app as unknown as { set: (key: string, value: unknown) => void }).set('trust proxy', 1);
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('同 IP 第 3 次 429；桶键取 XFF 最右段；换 IP 即新桶（同文件其他用例天然隔离）', async () => {
      const server = app.getHttpServer();
      const probe = (forwardedFor: string) =>
        request(server).get('/health-throttle-probe/limited').set('X-Forwarded-For', forwardedFor);

      await probe('198.51.100.1, 203.0.113.10').expect(200);
      // 最左段不同、最右段相同 ⇒ 仍是同一个桶（trust proxy=1 取最右段）——否则下一条不会 429
      await probe('198.51.100.2, 203.0.113.10').expect(200);
      await probe('198.51.100.3, 203.0.113.10').expect(429);
      // 换 IP 立即恢复：证明分桶是按 IP 的，本文件其他用例不会被这里的计数污染
      await probe('203.0.113.11').expect(200);
    });

    it('生产默认阈值 = 120/min（用 isolateModules + NODE_ENV=production 穿透 isTestEnv 遮蔽）', () => {
      // 为什么必须这样钉（复审 MINOR-4）：测试环境把 READY_THROTTLE_LIMIT 放宽成 100000，
      // 普通断言只能证明「是个正数」——真实阈值 120（S-N4）会在无人察觉时漂移。
      // 手法：临时把环境变量切成生产形态，用 isolateModules 重新加载控制器模块，
      // 让模块级常量按生产分支求值（reviewer 已进程外验证该技术可行）。
      const prevNodeEnv = process.env.NODE_ENV;
      const prevWorkerId = process.env.JEST_WORKER_ID;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.JEST_WORKER_ID;

        let limit: unknown;
        let ttl: unknown;
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const isolated = require('./health.controller') as typeof import('./health.controller');
          limit = Reflect.getMetadata(
            'THROTTLER:LIMITdefault',
            isolated.HealthController.prototype.readiness,
          );
          ttl = Reflect.getMetadata(
            'THROTTLER:TTLdefault',
            isolated.HealthController.prototype.readiness,
          );
        });

        expect(limit).toBe(120);
        expect(ttl).toBe(60_000);
      } finally {
        // 环境变量必须原样还原（同文件其他用例与 jest 自身都可能读 JEST_WORKER_ID）
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevNodeEnv;
        if (prevWorkerId === undefined) delete process.env.JEST_WORKER_ID;
        else process.env.JEST_WORKER_ID = prevWorkerId;
      }
    });
  });

  // ─── optional.memoryEngine（卡 5e6cb000：引擎告警态视图桶）───────────────────
  describe('readiness — optional.memoryEngine（告警态视图桶）', () => {
    /** 数据源桩：两项依赖检查都 up */
    function healthyDs(): DataSource {
      return { query: jest.fn().mockResolvedValue([{ column: 1 }]) } as unknown as DataSource;
    }

    it('顶层键集合精确相等：view 缺席 ⇒ 只有 status/timestamp/info', async () => {
      const controller = new HealthController(healthyDs());
      const body = await controller.readiness();
      expect(Object.keys(body).sort()).toEqual(['info', 'status', 'timestamp']);
    });

    it('固定映射：view 可用 ⇒ 顶层多一个 optional.memoryEngine = { status }（禁止 spread 快照）', async () => {
      const controller = new HealthController(healthyDs(), { read: () => 'up' });
      const body = await controller.readiness();
      expect(Object.keys(body).sort()).toEqual(['info', 'optional', 'status', 'timestamp']);
      expect(body.optional).toEqual({ memoryEngine: { status: 'up' } });
    });

    it('down 时整体 status 仍 ok（告警态视图**不参与**就绪判定）', async () => {
      const controller = new HealthController(healthyDs(), { read: () => 'down' });
      const body = await controller.readiness();
      expect(body.status).toBe('ok');
      expect(body.error).toBeUndefined();
      expect(body.optional).toEqual({ memoryEngine: { status: 'down' } });
    });

    it('view 读取抛错 ⇒ 省略该桶（观测面不得拖垮探针）', async () => {
      const controller = new HealthController(healthyDs(), {
        read: () => {
          throw new Error('view exploded');
        },
      });
      const body = await controller.readiness();
      expect(body.optional).toBeUndefined();
      expect(body.status).toBe('ok');
    });
  });

  // ─── ENGINE_HEALTH_VIEW 五态映射（派生 provider 的判定顺序固定）───────────────
  describe('ENGINE_HEALTH_VIEW 五态映射', () => {
    type Snapshot = ReturnType<EngineHealthTracker['getHealthSnapshot']>;

    /** 直接跑 provider 工厂（装配层的判定顺序是本文件的被测物） */
    const factory = (
      engineHealthViewProvider as unknown as {
        useFactory: (
          engine: unknown,
          tracker: { getHealthSnapshot: () => Snapshot },
          config: MemoryConfig,
        ) => EngineHealthView;
      }
    ).useFactory;

    /** 引擎已装配的替身（工厂只做 `!engine` 判空） */
    const ENGINE = { name: 'fake' } as unknown;

    /** 配置基线（探针开） */
    function configOf(healthProbeEnabled = true): MemoryConfig {
      return { ...MEMORY_ENGINE_FALLBACK, engine: 'hument', healthProbeEnabled };
    }

    /** 快照基线：无告警 + 已有一次成功探针 */
    function snapshotOf(over: Partial<Snapshot> = {}): Snapshot {
      return {
        availability: { alerted: false },
        auth: { alerted: false },
        lastProbeOkAt: 1,
        ...over,
      };
    }

    /** 读一次状态（tracker 替身只暴露 `getHealthSnapshot`） */
    function readWith(
      snapshot: Snapshot,
      options: { engine?: unknown; probeEnabled?: boolean } = {},
    ): string {
      const view = factory(
        options.engine === undefined ? ENGINE : options.engine,
        { getHealthSnapshot: () => snapshot },
        configOf(options.probeEnabled ?? true),
      );
      return view.read();
    }

    let logSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => logSpy.mockRestore());

    it('启动打一行 INFO：engine=assembled|none probe=on|off（旧 Topic 自检行的替代可见性）', () => {
      factory(ENGINE, { getHealthSnapshot: snapshotOf }, configOf(true));
      expect(logSpy).toHaveBeenCalledWith('engine health view: engine=assembled probe=on');

      logSpy.mockClear();
      factory(null, { getHealthSnapshot: snapshotOf }, configOf(false));
      expect(logSpy).toHaveBeenCalledWith('engine health view: engine=none probe=off');
    });

    it('① engine == null ⇒ disabled（引擎未装配不是故障）', () => {
      expect(readWith(snapshotOf({ availability: { alerted: true } }), { engine: null })).toBe(
        'disabled',
      );
    });

    it('② A 臂告警 ⇒ down（唯一产出 down 的臂）', () => {
      expect(readWith(snapshotOf({ availability: { alerted: true } }))).toBe('down');
    });

    it('③ B 臂告警 ⇒ degraded（引擎活着、单项目绑定坏）', () => {
      expect(readWith(snapshotOf({ auth: { alerted: true } }))).toBe('degraded');
    });

    it('④ 探针关闭 ⇒ unknown（无持续证据，不凭"没告警"报 up）', () => {
      expect(readWith(snapshotOf(), { probeEnabled: false })).toBe('unknown');
    });

    it('⑤ 启动首轮窗口（lastProbeOkAt === null）⇒ unknown（无证据不报 up）', () => {
      expect(readWith(snapshotOf({ lastProbeOkAt: null }))).toBe('unknown');
    });

    it('⑥ 无未恢复告警 + 至少一轮探针成功 ⇒ up', () => {
      expect(readWith(snapshotOf())).toBe('up');
    });

    it('判定顺序固定：A 臂告警优先于探针关闭（down 而不是 unknown）', () => {
      expect(
        readWith(snapshotOf({ availability: { alerted: true }, lastProbeOkAt: null }), {
          probeEnabled: false,
        }),
      ).toBe('down');
    });

    it('判定顺序固定：A 臂优先于 B 臂（双臂同时告警 ⇒ down）', () => {
      expect(
        readWith(snapshotOf({ availability: { alerted: true }, auth: { alerted: true } })),
      ).toBe('down');
    });
  });
});
