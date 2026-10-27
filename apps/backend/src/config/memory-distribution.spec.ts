/**
 * 发行合同：两模式真实清单/HealthModule 元数据，及关闭模式的无 PG HTTP 实例。
 * 本文件不启动 AppModule；完整候选的 Swagger/MCP 由发行集成验证补充。
 */
import 'reflect-metadata';
import { Global, INestApplication, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import request = require('supertest');

/** 以独立模块缓存读取同一源码的发行分支，不改宿主环境或写回 shared 源。 */
function loadMode(enabled: boolean) {
  let loaded!: {
    HealthModule: typeof import('../health/health.module').HealthModule;
    MemoryModule: typeof import('../modules/memory/memory.module').MemoryModule;
    DataSource: typeof import('typeorm').DataSource;
    configs: unknown[];
    memoryConfig: unknown;
    hints: readonly unknown[];
    memoryHint: unknown;
    taskHint: unknown;
    securityHint: unknown;
  };
  jest.isolateModules(() => {
    jest.doMock('@agent-chamber/shared', () => ({
      ...jest.requireActual('@agent-chamber/shared'),
      MEMORY_FEATURE_ENABLED: enabled,
    }));
    loaded = {
      HealthModule: require('../health/health.module').HealthModule,
      MemoryModule: require('../modules/memory/memory.module').MemoryModule,
      DataSource: require('typeorm').DataSource,
      configs: require('./app-config-loads').APP_CONFIG_LOADS,
      memoryConfig: require('./memory.config').default,
      hints: require('./app-hint-provider-chain').HINT_FACT_PROVIDER_CHAIN,
      memoryHint: require('../modules/memory/memory-nomination-hint.provider')
        .MemoryNominationHintProvider,
      taskHint: require('../modules/task/task-hygiene-hint.provider').TaskHygieneHintProvider,
      securityHint: require('../modules/hints/security-hint.provider').SecurityHintProvider,
    };
  });
  jest.dontMock('@agent-chamber/shared');
  return loaded;
}

describe('Memory 发行装配门', () => {
  it.each([true, false])('配置、hint 与健康模块同门（enabled=%s）', (enabled) => {
    const loaded = loadMode(enabled);
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, loaded.HealthModule) as unknown[];
    expect(imports.includes(loaded.MemoryModule)).toBe(enabled);
    expect(loaded.configs.includes(loaded.memoryConfig)).toBe(enabled);
    expect(loaded.hints.includes(loaded.memoryHint)).toBe(enabled);
    expect(loaded.hints.slice(0, 2)).toEqual([loaded.securityHint, loaded.taskHint]);
    // 剩余六个配置保持装配，关闭 Memory 不应让平台基础配置一起缺席。
    expect(loaded.configs).toHaveLength(enabled ? 7 : 6);
  });

  describe('关闭模式的真实 HealthModule HTTP 合同（只有 DataSource 替身，无 PG）', () => {
    let app: INestApplication;

    afterEach(async () => {
      await app?.close();
    });

    it('探针成功，Memory route/Swagger 与可选引擎桶均缺席', async () => {
      const loaded = loadMode(false);
      /** 只满足平台 readiness 的数据库查询；不会连接、同步或迁移任何数据库。 */
      const dataSource = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
      @Global()
      @Module({
        providers: [{ provide: loaded.DataSource, useValue: dataSource }],
        exports: [loaded.DataSource],
      })
      class ProbeDataModule {}

      const module = await Test.createTestingModule({
        imports: [ProbeDataModule, loaded.HealthModule],
      }).compile();
      app = module.createNestApplication();
      await app.init();

      const live = await request(app.getHttpServer()).get('/health').expect(200);
      expect(live.body.status).toBe('ok');
      const ready = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(ready.body.status).toBe('ok');
      expect(ready.body.optional?.memoryEngine).toBeUndefined();
      await request(app.getHttpServer()).get('/memory/projects').expect(404);
      const spec = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('distribution probe').setVersion('test').build(),
      );
      expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/health', '/health/ready']));
      expect(Object.keys(spec.paths).some((path) => path.startsWith('/memory'))).toBe(false);
      expect(dataSource.query).toHaveBeenCalledTimes(1);
    });
  });
});
