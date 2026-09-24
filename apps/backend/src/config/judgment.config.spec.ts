/**
 * judgment.config 单测（单真 provider 版：值域 `none|typesafe`）。
 *
 * 设计意图：判别服务是 observe 期增强，**配置缺失不能阻断录入**——故 `undefined`/非法
 * provider（含 v1.83.0 退役的 `jev`）一律视为 `none`（完全跳过：不调用、不写日志、不占额度）。
 * 但三条例外必须硬：① **production 明确要求 typesafe 却没给 key ⇒ 启动即崩**（否则每次
 * 录入白等一轮超时，运维还以为在跑）；② **typesafe 端点在生产必须 https**（仅本机放行
 * http，否则条目正文与 key 明文过网）；③ **数值解析防御**：超时/额度写错一律回落缺省
 * （"配置写错就静默关闭限流"是最糟的失败模式）。
 *
 * provider 用例**表驱动**：矩阵键集由一致性用例钉死 = `JUDGMENT_PROVIDERS` 去掉 `none`——
 * "往枚举加值却漏加用例"是这类改动最典型的漏网方式，让它当场红。
 */
import judgmentConfig, {
  JUDGMENT_PROVIDERS,
  type JudgmentConfig,
  type JudgmentProviderName,
} from './judgment.config';

describe('judgmentConfig', () => {
  const factory = judgmentConfig as unknown as () => JudgmentConfig;
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('缺省（无任何 JUDGMENT_* env）→ provider=none + 缺省端点/超时/额度', () => {
    delete process.env.JUDGMENT_PROVIDER;
    delete process.env.JUDGMENT_TIMEOUT_MS;
    delete process.env.JUDGMENT_RATE_LIMIT;

    const config = factory();
    expect(config.provider).toBe('none');
    // none 下 baseUrl 填官方缺省根（无消费者：工厂只在 typesafe 分支读）
    expect(config.baseUrl).toBe('https://api.typesafe.ai');
    expect(config.apiKey).toBeNull();
    expect(config.timeoutMs).toBe(8000);
    expect(config.rateLimitPerHour).toBe(60);
  });

  it('非法 / 退役 provider 值 → none（不抛错：配置错误不阻断启动）', () => {
    // 'jev' 是 v1.83.0 退役值：值域收窄后与拼错的值走同一条路（启动可见性 = 工厂的 warn）
    for (const value of ['', 'JEVI', 'true', '1', 'openai', 'jev']) {
      process.env.JUDGMENT_PROVIDER = value;
      expect(factory().provider).toBe('none');
    }
  });

  it('provider=none 时 apiKey 恒 null（`TYPESAFE_API_KEY` 在场也不生效）', () => {
    clearJudgmentEnv();
    process.env.TYPESAFE_API_KEY = 'apikey_decoy';
    expect(factory().apiKey).toBeNull();

    // 退役值同样不读 key（值域收窄 ⇒ 不该有第二个 key 来源）
    process.env.JUDGMENT_PROVIDER = 'jev';
    expect(factory().apiKey).toBeNull();
  });

  it('provider 值两端空白 / CRLF → trim 归一（与工厂 warn 判据同口径）', () => {
    clearJudgmentEnv();
    process.env.TYPESAFE_API_KEY = 'apikey_unit_test';

    // `.env` 手改留下的尾随空格 / CRLF 不得把合法值判成非法——否则会出现
    // "配了 typesafe 却落 none + 一条矛盾 warn"的组合
    for (const raw of [' typesafe ', '\ttypesafe', 'typesafe\r', ' typesafe\r\n']) {
      process.env.JUDGMENT_PROVIDER = raw;
      const config = factory();
      expect(config.provider).toBe('typesafe');
      expect(config.apiKey).toBe('apikey_unit_test');
    }
  });

  it('解析防御：timeout / rateLimit 的 NaN、非正数、小数一律回落缺省', () => {
    process.env.JUDGMENT_TIMEOUT_MS = 'abc';
    process.env.JUDGMENT_RATE_LIMIT = '-5';
    expect(factory().timeoutMs).toBe(8000);
    expect(factory().rateLimitPerHour).toBe(60);

    process.env.JUDGMENT_TIMEOUT_MS = '0';
    process.env.JUDGMENT_RATE_LIMIT = '0';
    expect(factory().timeoutMs).toBe(8000);
    expect(factory().rateLimitPerHour).toBe(60);
  });

  it('合法数值生效（小数向下取整：额度/超时都是计数语义）', () => {
    process.env.JUDGMENT_TIMEOUT_MS = '2500';
    process.env.JUDGMENT_RATE_LIMIT = '10.9';
    expect(factory().timeoutMs).toBe(2500);
    expect(factory().rateLimitPerHour).toBe(10);
  });

  it('production: 退役值 jev → 解析落 none，**不抛**（删 fail-fast 后旧 .env 不会崩启动）', () => {
    process.env.NODE_ENV = 'production';
    process.env.JUDGMENT_PROVIDER = 'jev';
    delete process.env.TYPESAFE_API_KEY;

    const config = factory();
    expect(config.provider).toBe('none'); // 退役值不再是真 provider ⇒ 无 key 要求
    expect(config.apiKey).toBeNull();
  });

  it('production: provider=none 且无 key → 正常启动（默认关闭不该被 key 缺失卡住）', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JUDGMENT_PROVIDER;
    expect(factory().provider).toBe('none');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 真 provider（typesafe = TypeSafe 官方云 REST；jev 已于 v1.83.0 退役，不再入矩阵）
  // ══════════════════════════════════════════════════════════════════════════

  type RealProviderName = Exclude<JudgmentProviderName, 'none'>;

  /** 一个真 provider 的完整 env 与期望产出（表驱动；见文件头"矩阵键集"说明） */
  interface ProviderMatrixRow {
    env: Record<string, string>;
    expectedBaseUrl: string;
    expectedApiKey: string;
    expectedTypesafeModel: string | null;
  }

  const PROVIDER_MATRIX: Record<RealProviderName, ProviderMatrixRow> = {
    typesafe: {
      env: {
        JUDGMENT_PROVIDER: 'typesafe',
        TYPESAFE_BASE_URL: 'https://api.staging.typesafe.ai',
        TYPESAFE_API_KEY: '  apikey_unit_test  ',
        TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0',
      },
      expectedBaseUrl: 'https://api.staging.typesafe.ai',
      // key 去空白（复制粘贴常带尾随空格）
      expectedApiKey: 'apikey_unit_test',
      expectedTypesafeModel: 'jev-1.13.0',
    },
  };

  /** 清掉全部判别相关 env（新增用例的干净起点；afterEach 另有全量还原） */
  function clearJudgmentEnv(): void {
    for (const key of [
      'JUDGMENT_PROVIDER',
      'JUDGMENT_TIMEOUT_MS',
      'JUDGMENT_RATE_LIMIT',
      'TYPESAFE_BASE_URL',
      'TYPESAFE_API_KEY',
      'TYPESAFE_DEFAULT_MODEL',
    ]) {
      delete process.env[key];
    }
  }

  it('矩阵键集 === 枚举成员集（往枚举加值却漏加用例 → 当场红）', () => {
    expect(Object.keys(PROVIDER_MATRIX).sort()).toEqual(
      JUDGMENT_PROVIDERS.filter((name) => name !== 'none').sort(),
    );
  });

  it.each(Object.entries(PROVIDER_MATRIX))(
    'provider=%s：读自己的键（key 去空白）+ 模型语义正确',
    (name, row) => {
      clearJudgmentEnv();
      Object.assign(process.env, row.env);

      const config = factory();
      expect(config.provider).toBe(name);
      expect(config.baseUrl).toBe(row.expectedBaseUrl);
      expect(config.apiKey).toBe(row.expectedApiKey);
      expect(config.typesafeModel).toBe(row.expectedTypesafeModel);
    },
  );

  it('provider=typesafe 缺省：官方 API 根（不含 /v1）+ jev-latest 模型', () => {
    clearJudgmentEnv();
    process.env.JUDGMENT_PROVIDER = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'apikey_unit_test';

    const config = factory();
    expect(config.provider).toBe('typesafe');
    // API 根语义：provider 内才拼 /v1/systemone（用户填了 /v1 会打 404）
    expect(config.baseUrl).toBe('https://api.typesafe.ai');
    expect(config.typesafeModel).toBe('jev-latest');
  });

  it('TYPESAFE_BASE_URL / TYPESAFE_DEFAULT_MODEL 空串与纯空白 → 一律回落缺省（compose `${VAR:-}` 注空串）', () => {
    clearJudgmentEnv();
    process.env.JUDGMENT_PROVIDER = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'apikey_unit_test';

    for (const blank of ['', '   ']) {
      process.env.TYPESAFE_BASE_URL = blank;
      process.env.TYPESAFE_DEFAULT_MODEL = blank;
      const config = factory();
      expect(config.baseUrl).toBe('https://api.typesafe.ai');
      // 空串若当请求 model 发出 = 官方 422（arch R4）
      expect(config.typesafeModel).toBe('jev-latest');
    }
  });

  it('未启用 typesafe 时 typesafeModel 恒 null（env 在场也不生效）', () => {
    clearJudgmentEnv();
    process.env.TYPESAFE_DEFAULT_MODEL = 'jev-1.13.0';

    expect(factory().typesafeModel).toBeNull(); // provider 缺省 = none

    // 退役值（v1.83.0 前的 jev）同样不伪造模型名——值域收窄后它落 none
    process.env.JUDGMENT_PROVIDER = 'jev';
    expect(factory().typesafeModel).toBeNull();
  });

  it('production: provider=typesafe 且缺 key → throw（四要素：键名 / key 入口 / 逃生阀 / 出境）', () => {
    clearJudgmentEnv();
    process.env.NODE_ENV = 'production';
    process.env.JUDGMENT_PROVIDER = 'typesafe';

    expect(() => factory()).toThrow(/TYPESAFE_API_KEY/);
    try {
      factory();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('TYPESAFE_API_KEY'); // ① 键名
      expect(message).toContain('https://console.typesafe.ai/keys'); // ② key 获取入口
      expect(message).toContain('JUDGMENT_PROVIDER=none'); // ③ 逃生阀
      expect(message).toMatch(/sends entry text|leaves your network/i); // ④ 出境提示
    }
  });

  it('production: provider=typesafe 且 key 为纯空白 → 视为缺失（throw；文案不回显值）', () => {
    clearJudgmentEnv();
    process.env.NODE_ENV = 'production';
    process.env.JUDGMENT_PROVIDER = 'typesafe';
    process.env.TYPESAFE_API_KEY = '   ';

    expect(() => factory()).toThrow(/TYPESAFE_API_KEY/);
    try {
      factory();
    } catch (err) {
      expect((err as Error).message).not.toContain('apikey_');
    }
  });

  it('production: typesafe scheme 硬闸（https 放行 / 本机 http 放行 / 外部 http 抛 / 畸形串抛）', () => {
    clearJudgmentEnv();
    process.env.NODE_ENV = 'production';
    process.env.JUDGMENT_PROVIDER = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'apikey_unit_test';

    for (const allowed of [
      'https://api.typesafe.ai',
      'http://localhost:9999',
      'http://127.0.0.1:9999',
    ]) {
      process.env.TYPESAFE_BASE_URL = allowed;
      expect(factory().provider).toBe('typesafe');
    }

    for (const blocked of ['http://api.typesafe.ai', 'not-a-url']) {
      process.env.TYPESAFE_BASE_URL = blocked;
      expect(() => factory()).toThrow(/TYPESAFE_BASE_URL/);
      // 错误文案不得回显**用户填的值**（它可能带 userinfo；缺省根提示是允许的）
      try {
        factory();
      } catch (err) {
        expect((err as Error).message).not.toContain(blocked);
      }
    }
  });

  it('development: typesafe 的 http 端点不抛（scheme 闸只锁生产）', () => {
    clearJudgmentEnv();
    process.env.NODE_ENV = 'development';
    process.env.JUDGMENT_PROVIDER = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'apikey_unit_test';
    process.env.TYPESAFE_BASE_URL = 'http://api.typesafe.ai';

    expect(factory().provider).toBe('typesafe');
  });

  it('development: provider=typesafe 且缺 key → **不抛**（由 provider 工厂降级 none 并 warn）', () => {
    clearJudgmentEnv();
    process.env.NODE_ENV = 'development';
    process.env.JUDGMENT_PROVIDER = 'typesafe';

    const config = factory();
    expect(config.provider).toBe('typesafe'); // 请求值原样保留（降级发生在 DI 层）
    expect(config.apiKey).toBeNull();
  });
});
