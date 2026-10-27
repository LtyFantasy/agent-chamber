/**
 * `memory-engine.factory` 单测（三态分派 + 诊断日志 + 缺省兜底）。
 *
 * 设计意图：工厂是"配置 → 实例"的唯一装配点，也是**Logger 归属层**（config 工厂保持纯函数）。
 * 这里钉死四件事：① **`none` → `null`**（关闭态不是类：服务层的 `assertEngineAvailable` 才是闸）；
 * ② 未 load 配置时走 `MEMORY_ENGINE_FALLBACK`（e2e 内联 ConfigModule 场景）；
 * ③ **非法/未知引擎值 ⇒ 一行 warn**（实际是关的），且"空串 / 未设置"必须零 warn
 * （compose `${VAR:-}` 注空串的误报守卫）；④ 诊断文案的安全边界：URL 一律经 `new URL()`
 * 解析只取 host+path（env 带 userinfo 时凭据不得进日志），畸形 URL 不得变成启动期抛错源。
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MEMORY_ENGINE_FALLBACK, type MemoryConfig } from '../../../config/memory.config';
import { FakeEngine } from './fake.engine';
import { HumentEngine } from './hument.engine';
import {
  MEMORY_CONFIG,
  createInstrumentedMemoryEngine,
  createMemoryEngine,
  createMemoryProvisioning,
  memoryConfigProvider,
  memoryEngineProvider,
  memoryEngineRawProvider,
  memoryProvisioningProvider,
} from './memory-engine.factory';
import { MEMORY_ENGINE_RAW } from './memory-engine.interface';
import { InstrumentedMemoryEngine } from './instrumented-memory.engine';
import { EngineHealthTracker } from '../engine-health-tracker.service';
import { HumentProvisioningClient } from './hument-provisioning.client';

/** 假 ConfigService（只实现工厂用到的 `get`） */
function configServiceOf(settings: MemoryConfig | undefined): ConfigService {
  return { get: jest.fn().mockReturnValue(settings) } as unknown as ConfigService;
}

/** 配置基线（= 工厂缺省；用例按需覆盖） */
function settingsOf(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...MEMORY_ENGINE_FALLBACK, ...overrides };
}

describe('memory-engine.factory', () => {
  const ORIGINAL_ENV = { ...process.env };
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // 静音（Nest Logger 默认打到 stdout）+ 供断言取文案
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    delete process.env.MEMORY_ENGINE;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('engine=none → null（关闭态不是类；服务层据此 503 MEMORY_UNAVAILABLE）', () => {
    const engine = createMemoryEngine(configServiceOf(settingsOf({ engine: 'none' })));
    expect(engine).toBeNull();
    // 关闭态不打"已启用"的 INFO（避免运维误信在跑）
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('未 load 配置（get 返回 undefined）→ 兜底 none → null', () => {
    const engine = createMemoryEngine(configServiceOf(undefined));
    expect(engine).toBeNull();
  });

  it('engine=hument → HumentEngine + 一行 INFO（端点只取 host+path，不打印 href）', () => {
    const engine = createMemoryEngine(
      configServiceOf(
        settingsOf({
          engine: 'hument',
          humentBaseUrl: 'http://user:secret@hub.local:8099/',
          humentTimeoutMs: 25000,
        }),
      ),
    );
    expect(engine).toBeInstanceOf(HumentEngine);
    expect(engine?.name).toBe('hument');

    const infoLine = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(infoLine).toContain('engine=hument');
    expect(infoLine).toContain('hub.local:8099');
    expect(infoLine).toContain('timeoutMs=25000');
    // userinfo（凭据）绝不进启动日志
    expect(infoLine).not.toContain('secret');
    expect(infoLine).not.toContain('user:');
  });

  it('畸形端点 URL 不让诊断变成启动期抛错源（退化为固定文案）', () => {
    const engine = createMemoryEngine(
      configServiceOf(settingsOf({ engine: 'hument', humentBaseUrl: 'not a url' })),
    );
    expect(engine).toBeInstanceOf(HumentEngine);
    const infoLine = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(infoLine).toContain('<unparseable endpoint>');
  });

  it('engine=fake → FakeEngine + 一行"test/e2e only"INFO', () => {
    const engine = createMemoryEngine(configServiceOf(settingsOf({ engine: 'fake' })));
    expect(engine).toBeInstanceOf(FakeEngine);
    expect(engine?.name).toBe('fake');
    expect(String(logSpy.mock.calls[0][0])).toContain('test/e2e only');
  });

  it('非法引擎值 ⇒ 一行 warn（净化回显）且返回 null；空串/未设置 ⇒ 零 warn', () => {
    // 空串（compose `${VAR:-}` 注空串）视同未配置——不得误报
    process.env.MEMORY_ENGINE = '';
    createMemoryEngine(configServiceOf(settingsOf({ engine: 'none' })));
    expect(warnSpy).not.toHaveBeenCalled();

    process.env.MEMORY_ENGINE = 'humment'; // 拼错
    const engine = createMemoryEngine(configServiceOf(settingsOf({ engine: 'none' })));
    expect(engine).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = String(warnSpy.mock.calls[0][0]);
    expect(warning).toContain('humment');
    expect(warning).toContain('DISABLED');
  });

  it('非法值 warn 对 key 形态脱敏（用户把 key 误填进 MEMORY_ENGINE）', () => {
    process.env.MEMORY_ENGINE = 'apikey_this_should_be_masked';
    createMemoryEngine(configServiceOf(settingsOf({ engine: 'none' })));
    const warning = String(warnSpy.mock.calls[0][0]);
    expect(warning).toContain('apikey_***');
    expect(warning).not.toContain('this_should_be_masked');
  });

  it('config 产出的 warnings 逐条透传打印（工厂不改写文案）', () => {
    const warnings = ['HUMENT_TIMEOUT_MS is not a positive integer — falling back to the default'];
    createMemoryEngine(configServiceOf(settingsOf({ warnings })));
    expect(warnSpy).toHaveBeenCalledWith(warnings[0]);
  });

  it('四个 token 的 provider 定义完整（装配面自检：RAW + 包装层的双 provider 形状）', () => {
    // `Provider` 是联合类型（含 Type<any>），直接取字段 TS 不认——按用到的形状窄化
    const rawProvider = memoryEngineRawProvider as {
      provide?: unknown;
      inject?: unknown[];
      useFactory?: unknown;
    };
    const engineProvider = memoryEngineProvider as {
      provide?: unknown;
      inject?: unknown[];
      useFactory?: unknown;
    };
    const configProvider = memoryConfigProvider as {
      provide?: unknown;
      useFactory?: unknown;
    };
    const provisioningProvider = memoryProvisioningProvider as {
      provide?: unknown;
      inject?: unknown[];
      useFactory?: unknown;
    };
    // 装配层的 token 必须是 RAW（**e2e/单测的 override 点**）；包装层才是服务层消费面
    expect(rawProvider.provide).toBe('MEMORY_ENGINE_RAW');
    expect(engineProvider.provide).toBe('MEMORY_ENGINE');
    expect(configProvider.provide).toBe(MEMORY_CONFIG);
    expect(provisioningProvider.provide).toBe('MEMORY_PROVISIONING');
    // 包装层注入 = [裸引擎 token, tracker 类]（两参形状是本卡的核心装配契约）
    expect(engineProvider.inject).toEqual([MEMORY_ENGINE_RAW, EngineHealthTracker]);
    expect(rawProvider.inject).toEqual([expect.anything()]);
    expect(provisioningProvider.inject).toEqual([expect.anything()]);
    expect(typeof rawProvider.useFactory).toBe('function');
    expect(typeof engineProvider.useFactory).toBe('function');
    expect(typeof configProvider.useFactory).toBe('function');
    expect(typeof provisioningProvider.useFactory).toBe('function');
  });

  it('包装层工厂：raw 为 null ⇒ null（未配置 ≠ 故障）；raw 非 null ⇒ InstrumentedMemoryEngine', () => {
    const tracker = { noteCallOutcome: jest.fn() } as unknown as EngineHealthTracker;
    expect(createInstrumentedMemoryEngine(null, tracker)).toBeNull();

    const raw = new FakeEngine();
    const wrapped = createInstrumentedMemoryEngine(raw, tracker);
    expect(wrapped).toBeInstanceOf(InstrumentedMemoryEngine);
    // name 透传（配置值域一致性靠它）
    expect(wrapped?.name).toBe('fake');
  });

  describe('createMemoryProvisioning（自助开通装配；关闭态 = null）', () => {
    /** 自助开通可用基线（enabled + socket 路径齐备） */
    const enabled: Partial<MemoryConfig> = {
      provisioningEnabled: true,
      operatorSocketPath: '/tmp/hument-control.sock',
    };

    it('未启用 / 缺 socket 路径 ⇒ null（关闭态不是类；create 退回现有 400）', () => {
      expect(createMemoryProvisioning(configServiceOf(settingsOf()))).toBeNull();
      expect(
        createMemoryProvisioning(
          configServiceOf(settingsOf({ provisioningEnabled: true, operatorSocketPath: null })),
        ),
      ).toBeNull();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('启用 + socket 齐备 ⇒ 客户端实例 + 一行 INFO', () => {
      const client = createMemoryProvisioning(configServiceOf(settingsOf(enabled)));

      expect(client).toBeInstanceOf(HumentProvisioningClient);
      const info = String(logSpy.mock.calls[0][0]);
      expect(info).toContain('memory provisioning ENABLED');
      expect(info).toContain('/tmp/hument-control.sock');
      // 日志里没有任何凭据引用值可打——它按 slug 派生，不是配置面（见 config 头注释）
      expect(info).not.toContain('credentialRef');
    });

    it('畸形 baseUrl（评审 S-5/S-6）：dev 降级 warn + 不装配；production 拒启动', () => {
      const dev = createMemoryProvisioning(
        configServiceOf(settingsOf({ ...enabled, humentBaseUrl: 'http://' })),
      );
      expect(dev).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = String(warnSpy.mock.calls[0][0]);
      expect(logged).toContain('HUMENT_BASE_URL');
      // 只出现键名与形态描述——**不回显 env 原值**
      expect(logged).not.toContain('http://');
      // 必须点明**用户可见后果**（不传三键的 create 会回 400）
      expect(logged).toContain('400');

      // `hub:8099` 解析成功但 origin 退化成 'null' —— 同样拦在装配期
      expect(
        createMemoryProvisioning(configServiceOf(settingsOf({ ...enabled, humentBaseUrl: 'hub:8099' }))),
      ).toBeNull();

      // production：与"缺 socket 路径"同档，拒启动（静默降级 = 运维以为功能没做）
      const ORIGINAL_ENV = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(() =>
          createMemoryProvisioning(
            configServiceOf(settingsOf({ ...enabled, humentBaseUrl: 'http://' })),
          ),
        ).toThrow(/HUMENT_PROVISIONING_ENABLED=false/);
      } finally {
        process.env.NODE_ENV = ORIGINAL_ENV;
      }
    });
  });

  it('MEMORY_CONFIG 工厂：未 load 时回落 MEMORY_ENGINE_FALLBACK', () => {
    const { useFactory } = memoryConfigProvider as unknown as {
      useFactory: (config: ConfigService) => MemoryConfig;
    };
    expect(useFactory(configServiceOf(undefined))).toBe(MEMORY_ENGINE_FALLBACK);
  });
});
