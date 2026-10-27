/**
 * memory.config 单测（值域 `none|fake|hument`；memory = 可选增强）。
 *
 * 设计意图：memory 是增强项——**配置缺失不能阻断启动**，故 `undefined`/非法 `MEMORY_ENGINE`
 * 一律视为 `none`。三条例外必须硬：① **production 拒 `fake`**（测试引擎会把每次形成伪装成
 * committed，Hub 里空无一物）；② **production 下 `hument` 必须显式给 `HUMENT_BASE_URL`**
 * （缺省 loopback 是 dev 便利，生产静默用它 = "引擎配了但每次都 unknown"）；
 * ③ **超时解析防御 + 120s 上限**（值写错或超限一律回落缺省并告警——不等式见 config 文件头）。
 *
 * 值域一致性用例钉死「config 值域 − fake === 落库值域（shared `MEMORY_ENGINES`）」：
 * 往任一枚举加值而忘了另一处，是这类改动最典型的漏网方式。
 */
import { MEMORY_ENGINES } from '@agent-chamber/shared';
import type { ConfigService } from '@nestjs/config';
import memoryConfig, {
  DEFAULT_HUMENT_BASE_URL,
  DEFAULT_HUMENT_OPERATOR_BINDING_ID,
  DEFAULT_HUMENT_PROVISIONING_TENANT_ID,
  DEFAULT_HUMENT_TIMEOUT_MS,
  HUMENT_TIMEOUT_CEILING_MS,
  MEMORY_ENGINE_FALLBACK,
  MEMORY_ENGINE_PROVIDERS,
  MEMORY_PERSISTED_ENGINES,
  isPersistableMemoryEngine,
  resolveMemoryConfig,
  type MemoryConfig,
} from './memory.config';

describe('memoryConfig', () => {
  const factory = memoryConfig as unknown as () => MemoryConfig;
  const ORIGINAL_ENV = { ...process.env };

  /** 清掉本配置管辖的全部键（避免宿主环境残留导致串扰） */
  function clearMemoryEnv(): void {
    delete process.env.MEMORY_ENGINE;
    delete process.env.HUMENT_BASE_URL;
    delete process.env.HUMENT_TIMEOUT_MS;
    delete process.env.HUMENT_PROVISIONING_ENABLED;
    delete process.env.HUMENT_OPERATOR_SOCKET_PATH;
    delete process.env.HUMENT_OPERATOR_BINDING_ID;
    delete process.env.HUMENT_PROVISIONING_TENANT_ID;
    delete process.env.MEMORY_HEALTH_PROBE_ENABLED;
  }

  beforeEach(() => {
    clearMemoryEnv();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('缺省（无任何 MEMORY_*/HUMENT_* env）→ engine=none + loopback 端点 + 90000ms + 自助开通关闭 + 零 warning', () => {
    const config = factory();
    expect(config.engine).toBe('none');
    expect(config.humentBaseUrl).toBe(DEFAULT_HUMENT_BASE_URL);
    expect(config.humentBaseUrl).toBe('http://127.0.0.1:8099');
    expect(config.humentTimeoutMs).toBe(DEFAULT_HUMENT_TIMEOUT_MS);
    expect(config.humentTimeoutMs).toBe(90000);
    // 自助开通缺省关闭：socket 路径为 null（消费方据此把 provider 置 null）
    expect(config.provisioningEnabled).toBe(false);
    expect(config.operatorSocketPath).toBeNull();
    expect(config.operatorBindingId).toBe(DEFAULT_HUMENT_OPERATOR_BINDING_ID);
    expect(config.provisioningTenantId).toBe(DEFAULT_HUMENT_PROVISIONING_TENANT_ID);
    // 运行时告警：探针缺省开（零流量形态的唯一证据）
    expect(config.healthProbeEnabled).toBe(true);
    expect(config.warnings).toEqual([]);
  });

  it('非法 / 未知引擎值 → none（不抛错：配置错误不阻断启动）', () => {
    for (const value of ['', 'HUMENT', 'true', '1', 'noop', 'none ']) {
      process.env.MEMORY_ENGINE = value;
      expect(factory().engine).toBe('none');
    }
  });

  it('合法引擎值生效 + 两端空白 / CRLF trim 归一（与工厂 warn 判据同口径）', () => {
    for (const raw of ['hument', ' hument ', '\thument', 'hument\r', ' hument\r\n']) {
      process.env.MEMORY_ENGINE = raw;
      expect(factory().engine).toBe('hument');
    }
    process.env.MEMORY_ENGINE = ' fake ';
    expect(factory().engine).toBe('fake');
  });

  it('端点：显式值生效 + 空白串视同"未配置"回落缺省', () => {
    process.env.MEMORY_ENGINE = 'hument';
    process.env.HUMENT_BASE_URL = 'http://10.0.0.4:8099';
    expect(factory().humentBaseUrl).toBe('http://10.0.0.4:8099');

    // compose `${VAR:-}` 在 .env 缺键时注空串——视同未配置（不报错）
    process.env.HUMENT_BASE_URL = '   ';
    expect(factory().humentBaseUrl).toBe(DEFAULT_HUMENT_BASE_URL);
  });

  it('超时解析防御：NaN / 非正数 → 回落缺省 + 一条 warning（且不回显 env 原值）', () => {
    for (const raw of ['abc', '-5', '0', 'null', 'apikey_should_not_leak']) {
      process.env.HUMENT_TIMEOUT_MS = raw;
      const config = factory();
      expect(config.humentTimeoutMs).toBe(DEFAULT_HUMENT_TIMEOUT_MS);
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain('HUMENT_TIMEOUT_MS');
    }

    // 告警只出现键名与回落缺省值——env 原值可能是 key 或带 userinfo 的 URL
    // （用区分度高的哨兵值断言；`'0'` 这种会撞进缺省值数字里，不做子串断言）
    for (const raw of ['apikey_should_not_leak', 'abc', 'http://user:pw@hub.local']) {
      process.env.HUMENT_TIMEOUT_MS = raw;
      expect(factory().warnings[0]).not.toContain(raw);
    }
  });

  it('超时合法值生效（小数向下取整；计数语义）', () => {
    process.env.HUMENT_TIMEOUT_MS = '25000';
    expect(factory().humentTimeoutMs).toBe(25000);
    process.env.HUMENT_TIMEOUT_MS = '2500.9';
    expect(factory().humentTimeoutMs).toBe(2500);
  });

  it('超时上限：≥120000ms 回落缺省 + 一条 warning；119999ms 仍生效', () => {
    process.env.HUMENT_TIMEOUT_MS = String(HUMENT_TIMEOUT_CEILING_MS);
    const capped = factory();
    expect(capped.humentTimeoutMs).toBe(DEFAULT_HUMENT_TIMEOUT_MS);
    expect(capped.warnings).toHaveLength(1);
    expect(capped.warnings[0]).toContain(String(HUMENT_TIMEOUT_CEILING_MS));

    process.env.HUMENT_TIMEOUT_MS = '119999';
    const allowed = factory();
    expect(allowed.humentTimeoutMs).toBe(119999);
    expect(allowed.warnings).toEqual([]);
  });

  it('空白串超时视同"未配置"：回落缺省且**零 warning**（compose 注空串的误报守卫）', () => {
    process.env.HUMENT_TIMEOUT_MS = '   ';
    const config = factory();
    expect(config.humentTimeoutMs).toBe(DEFAULT_HUMENT_TIMEOUT_MS);
    expect(config.warnings).toEqual([]);
  });

  it('production fail-fast：MEMORY_ENGINE=fake 拒绝启动（dev/test 允许）', () => {
    process.env.MEMORY_ENGINE = 'fake';
    expect(() => factory()).not.toThrow();

    process.env.NODE_ENV = 'production';
    expect(() => factory()).toThrow(/MEMORY_ENGINE=fake/);
  });

  it('production fail-fast：hument 缺显式 HUMENT_BASE_URL 拒绝启动（给了就放行）', () => {
    process.env.NODE_ENV = 'production';
    process.env.MEMORY_ENGINE = 'hument';
    expect(() => factory()).toThrow(/HUMENT_BASE_URL/);

    process.env.HUMENT_BASE_URL = 'http://127.0.0.1:8099';
    expect(() => factory()).not.toThrow();
    expect(factory().humentBaseUrl).toBe('http://127.0.0.1:8099');
  });

  it('production fail-fast 文案只出现键名/合法值域/逃生阀（不回显 env 原值）', () => {
    process.env.NODE_ENV = 'production';
    process.env.MEMORY_ENGINE = 'fake';
    expect(() => factory()).toThrow(/See \.env\.example\.$/);
    try {
      factory();
      throw new Error('expected the production fail-fast to throw');
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(message).toContain('MEMORY_ENGINE');
      // 逃生阀必须写明（运维据此自救）
      expect(message).toContain('MEMORY_ENGINE=none');
    }
  });

  it('值域一致性：config 值域 − fake === 落库值域（shared MEMORY_ENGINES）', () => {
    const configEngines = MEMORY_ENGINE_PROVIDERS.filter((name) => name !== 'fake');
    expect([...configEngines]).toEqual([...MEMORY_ENGINES]);
    expect([...MEMORY_PERSISTED_ENGINES]).toEqual([...MEMORY_ENGINES]);
    // fake 只在 config 面合法，**永不可落库**
    expect(isPersistableMemoryEngine('fake')).toBe(false);
    expect(isPersistableMemoryEngine('none')).toBe(true);
    expect(isPersistableMemoryEngine('hument')).toBe(true);
  });

  describe('自助开通（二期；缺省关闭 + production fail-fast）', () => {
    it('enabled 解析：只有字面 `true` 才开（仓内约定；其它值一律视为关闭）', () => {
      for (const raw of ['', '1', 'TRUE', 'yes', 'on', ' true ']) {
        process.env.HUMENT_PROVISIONING_ENABLED = raw;
        expect(factory().provisioningEnabled).toBe(false);
      }
      process.env.HUMENT_PROVISIONING_ENABLED = 'true';
      expect(factory().provisioningEnabled).toBe(true);
    });

    it('enabled + socket 路径 ⇒ 四字段就位（缺省值可被显式覆盖）', () => {
      // engine=hument 隔离掉"配了却用不上"的组合 warning（那条另有用例）
      process.env.MEMORY_ENGINE = 'hument';
      process.env.HUMENT_PROVISIONING_ENABLED = 'true';
      process.env.HUMENT_OPERATOR_SOCKET_PATH =
        '/home/u/.hument/chamber-dev/runtime/run/hument-control.sock';
      process.env.HUMENT_OPERATOR_BINDING_ID = 'binding-ops-other';
      process.env.HUMENT_PROVISIONING_TENANT_ID = 'chamber-dev';

      const config = factory();

      expect(config.provisioningEnabled).toBe(true);
      expect(config.operatorSocketPath).toBe(
        '/home/u/.hument/chamber-dev/runtime/run/hument-control.sock',
      );
      expect(config.operatorBindingId).toBe('binding-ops-other');
      expect(config.provisioningTenantId).toBe('chamber-dev');
      // ⚠️ 凭据引用**不是配置键**（按 slug 派生 `ref-<slug>`，Hub 侧主键 1:1）
      expect(config).not.toHaveProperty('provisioningCredentialRef');
      expect(config.warnings).toEqual([]);
    });

    it('两个派生键的空白串视同"未配置"⇒ 回落缺省（compose 注空串的误报守卫）', () => {
      process.env.HUMENT_PROVISIONING_ENABLED = 'true';
      process.env.HUMENT_OPERATOR_SOCKET_PATH = '/tmp/hument-control.sock';
      process.env.HUMENT_OPERATOR_BINDING_ID = '   ';
      process.env.HUMENT_PROVISIONING_TENANT_ID = '';

      const config = factory();

      expect(config.operatorBindingId).toBe(DEFAULT_HUMENT_OPERATOR_BINDING_ID);
      expect(config.provisioningTenantId).toBe(DEFAULT_HUMENT_PROVISIONING_TENANT_ID);
    });

    it('dev/test：enabled 缺 socket 路径 ⇒ **不抛**，降级为 socketPath=null + 一条已净化 warning', () => {
      // engine=hument 隔离：本用例只验"缺 socket"这一条 warning
      process.env.MEMORY_ENGINE = 'hument';
      process.env.HUMENT_PROVISIONING_ENABLED = 'true';

      let config!: MemoryConfig;
      expect(() => {
        config = factory();
      }).not.toThrow();

      expect(config.operatorSocketPath).toBeNull();
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain('HUMENT_OPERATOR_SOCKET_PATH');
      // 文案只出现键名（**不回显 env 原值**）
      expect(config.warnings[0]).not.toContain('/tmp');
    });

    it('production fail-fast：enabled 缺 socket 路径拒绝启动（给了就放行）', () => {
      process.env.NODE_ENV = 'production';
      process.env.HUMENT_PROVISIONING_ENABLED = 'true';

      expect(() => factory()).toThrow(/HUMENT_OPERATOR_SOCKET_PATH/);
      // 逃生阀必须写明（运维据此自救）
      try {
        factory();
        throw new Error('expected the production fail-fast to throw');
      } catch (err: unknown) {
        const message = (err as Error).message;
        expect(message).toContain('HUMENT_PROVISIONING_ENABLED=false');
        expect(message).toContain('See .env.example.');
      }

      process.env.HUMENT_OPERATOR_SOCKET_PATH = '/tmp/hument-control.sock';
      expect(() => factory()).not.toThrow();
      expect(factory().operatorSocketPath).toBe('/tmp/hument-control.sock');
    });

    it('enabled 但 engine≠hument ⇒ 一条组合异常 warning（不是 fail-fast）', () => {
      process.env.HUMENT_PROVISIONING_ENABLED = 'true';
      process.env.HUMENT_OPERATOR_SOCKET_PATH = '/tmp/hument-control.sock';
      process.env.MEMORY_ENGINE = 'none';

      const config = factory();

      expect(config.warnings.some((warning) => warning.includes('MEMORY_ENGINE'))).toBe(true);
    });

    it('enabled + engine=hument + socket ⇒ 零 warning（正常组合不误报）', () => {
      process.env.MEMORY_ENGINE = 'hument';
      process.env.HUMENT_PROVISIONING_ENABLED = 'true';
      process.env.HUMENT_OPERATOR_SOCKET_PATH = '/tmp/hument-control.sock';

      expect(factory().warnings).toEqual([]);
    });
  });

  describe('引擎运行时告警（卡 26c43f52；探针开关解析）', () => {
    it('MEMORY_HEALTH_PROBE_ENABLED：缺省开；只有显式 false 才关（大小写/空白容错）', () => {
      expect(factory().healthProbeEnabled).toBe(true);

      process.env.MEMORY_HEALTH_PROBE_ENABLED = 'false';
      expect(factory().healthProbeEnabled).toBe(false);

      process.env.MEMORY_HEALTH_PROBE_ENABLED = ' FALSE ';
      expect(factory().healthProbeEnabled).toBe(false);

      // 其它任何值都是"开"（缺省态是开，与 `=== 'true'` 的布尔约定相反）
      for (const raw of ['true', 'TRUE', '']) {
        process.env.MEMORY_HEALTH_PROBE_ENABLED = raw;
        const config = factory();
        expect(config.healthProbeEnabled).toBe(true);
        expect(config.warnings).toEqual([]);
      }
    });

    it('MEMORY_HEALTH_PROBE_ENABLED：值域外写法 ⇒ 判开 + **一条 warning**（不再静默）', () => {
      // 卡 2 评审 m3：`no` / `off` / `0` 之前会静默判开（运维以为关了其实还在探）
      for (const raw of ['no', 'off', '0', 'yes', 'disabled']) {
        process.env.MEMORY_HEALTH_PROBE_ENABLED = raw;
        const config = factory();
        expect(config.healthProbeEnabled).toBe(true);
        expect(config.warnings).toHaveLength(1);
        // 文案是**定值**（不内插 env 值）：值域外的写法可能来自误填的 key
        expect(config.warnings[0]).toBe(
          'MEMORY_HEALTH_PROBE_ENABLED is not "true"/"false" — treated as ENABLED, so the ' +
            'readiness probe keeps running. Set it to "false" to disable the probe.',
        );
      }
    });

    it('HUMENT_BASE_URL scheme 校验：所有环境 warn-only（不回显原值、不改写端点）', () => {
      process.env.MEMORY_ENGINE = 'hument';
      process.env.HUMENT_BASE_URL = 'ftp://hub.local:8099';
      const bad = factory();
      // **warn-only**：不抛、不改写（回落 loopback 比响亮失败更糟）
      expect(bad.humentBaseUrl).toBe('ftp://hub.local:8099');
      expect(bad.warnings.join('\n')).toContain('unsupported scheme');
      expect(bad.warnings.join('\n')).not.toContain('hub.local');

      // 畸形串（如漏写协议的 `hub.local:8099`：`new URL()` 会把 `hub.local:` 当成 scheme）
      // 同样只 warn，且**不回显任何值片段**（连 protocol 也不打）
      process.env.HUMENT_BASE_URL = 'hub.local:8099';
      const malformed = factory();
      expect(malformed.warnings.join('\n')).toContain('unsupported scheme');
      expect(malformed.warnings.join('\n')).not.toContain('hub.local');

      // 合法 scheme 零 warning
      process.env.HUMENT_BASE_URL = 'https://hub.local:8099';
      expect(factory().warnings).toEqual([]);
    });
  });

  describe('resolveMemoryConfig（缺省兜底）', () => {
    function configServiceOf(settings: MemoryConfig | undefined): ConfigService {
      return { get: jest.fn().mockReturnValue(settings) } as unknown as ConfigService;
    }

    it('未 load 工厂（get 返回 undefined）→ MEMORY_ENGINE_FALLBACK（engine=none）', () => {
      expect(resolveMemoryConfig(configServiceOf(undefined))).toBe(MEMORY_ENGINE_FALLBACK);
      expect(MEMORY_ENGINE_FALLBACK.engine).toBe('none');
      expect(MEMORY_ENGINE_FALLBACK.humentBaseUrl).toBe(DEFAULT_HUMENT_BASE_URL);
      expect(MEMORY_ENGINE_FALLBACK.humentTimeoutMs).toBe(DEFAULT_HUMENT_TIMEOUT_MS);
      // 兜底形状必须与工厂产出**同形**（漏字段会被 MemoryConfig 类型标注在编译期拦住）
      expect(MEMORY_ENGINE_FALLBACK.provisioningEnabled).toBe(false);
      expect(MEMORY_ENGINE_FALLBACK.operatorSocketPath).toBeNull();
      expect(MEMORY_ENGINE_FALLBACK.operatorBindingId).toBe(DEFAULT_HUMENT_OPERATOR_BINDING_ID);
      expect(MEMORY_ENGINE_FALLBACK.provisioningTenantId).toBe(
        DEFAULT_HUMENT_PROVISIONING_TENANT_ID,
      );
      // 探针开关的兜底形状（未 load 工厂 ⇒ 探针开；与工厂缺省一致）
      expect(MEMORY_ENGINE_FALLBACK.healthProbeEnabled).toBe(true);
      expect(MEMORY_ENGINE_FALLBACK.warnings).toEqual([]);
    });

    it('已 load（get 返回对象）→ 原样返回，不走兜底', () => {
      const settings: MemoryConfig = {
        engine: 'hument',
        humentBaseUrl: 'http://127.0.0.1:8099',
        humentTimeoutMs: 25000,
        provisioningEnabled: true,
        operatorSocketPath: '/tmp/hument-control.sock',
        operatorBindingId: 'binding-ops-chamber',
        provisioningTenantId: 'chamber',
        healthProbeEnabled: false,
        warnings: ['x'],
      };
      expect(resolveMemoryConfig(configServiceOf(settings))).toBe(settings);
    });
  });
});
