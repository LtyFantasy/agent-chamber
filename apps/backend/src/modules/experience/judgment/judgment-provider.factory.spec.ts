/**
 * judgment-provider.factory 单测（两态分派 + 退役值 warn + 诊断日志）。
 *
 * 设计意图：工厂是"配置 → 实例"的唯一装配点，也是**Logger 归属层**（config 工厂保持纯函数）。
 * 这里钉死四件事：① 两态分派正确（含未 load 配置的兜底）；② **真 provider 缺 key 时降级为
 * none 并留一行 warn**——绝不静默打真网关；③ **退役/非法 provider 值 ⇒ 一行 warn**（实际判别
 * 是关的，不能让用户误信在跑），且"空串 / 未设置"必须零 warn（compose `${VAR:-}` 注空串的
 * 误报守卫）；④ 诊断文案的**安全边界**：URL 一律经 `new URL()` 解析只取 host+path（env 带
 * userinfo 时凭证不得进日志）、畸形 URL 不得让诊断变成启动期抛错源。
 *
 * provider 用例**表驱动**：矩阵键集由一致性用例钉死 = `JUDGMENT_PROVIDERS` 去掉 `none`。
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DEFAULT_TYPESAFE_BASE_URL,
  JUDGMENT_PROVIDERS,
  type JudgmentConfig,
  type JudgmentProviderName,
} from '../../../config/judgment.config';
import { createJudgmentProvider, resolveJudgmentConfig } from './judgment-provider.factory';
import { NoopJudgmentProvider } from './noop.judgment-provider';
import { TypeSafeJudgmentProvider } from './typesafe.judgment-provider';

/** 假 ConfigService（只实现工厂用到的 `get`） */
function configServiceOf(settings: JudgmentConfig | undefined): ConfigService {
  return { get: jest.fn().mockReturnValue(settings) } as unknown as ConfigService;
}

/** 配置基线（= 工厂缺省；用例按需覆盖单个字段） */
const BASE_SETTINGS: JudgmentConfig = {
  provider: 'none',
  baseUrl: DEFAULT_TYPESAFE_BASE_URL,
  apiKey: null,
  typesafeModel: null,
  timeoutMs: 8000,
  rateLimitPerHour: 60,
};

function settingsOf(overrides: Partial<JudgmentConfig>): JudgmentConfig {
  return { ...BASE_SETTINGS, ...overrides };
}

/** 合成假 key（仓库 NIT-1：只借用公开前缀形态，后缀全合成） */
const FAKE_TYPESAFE_KEY = 'apikey_unit_test_only';

type RealProviderName = Exclude<JudgmentProviderName, 'none'>;

/** 一个真 provider 的分派期望（表驱动；键集由一致性用例钉死 = 枚举去 `none`） */
interface FactoryMatrixRow {
  settings: JudgmentConfig;
  expectedClass: new (...args: never[]) => unknown;
}

const FACTORY_MATRIX: Record<RealProviderName, FactoryMatrixRow> = {
  typesafe: {
    settings: settingsOf({
      provider: 'typesafe',
      baseUrl: 'https://api.typesafe.ai',
      apiKey: FAKE_TYPESAFE_KEY,
      typesafeModel: 'jev-latest',
    }),
    expectedClass: TypeSafeJudgmentProvider as new (...args: never[]) => unknown,
  },
};

describe('judgment-provider.factory', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // 静音（Nest Logger 默认打到 stdout）+ 供断言取文案
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 取全部 warn / log 文案（多行拼接，便于 `toContain`） */
  function loggedText(spy: jest.SpyInstance): string {
    return spy.mock.calls.map((call) => String(call[0])).join('\n');
  }

  describe('两态分派', () => {
    it('矩阵键集 === 枚举成员集（往枚举加值却漏分派用例 → 当场红）', () => {
      expect(Object.keys(FACTORY_MATRIX).sort()).toEqual(
        JUDGMENT_PROVIDERS.filter((name) => name !== 'none').sort(),
      );
    });

    it.each(Object.entries(FACTORY_MATRIX))(
      'provider=%s → 对应实现 + name + enabled=true',
      (name, row) => {
        const provider = createJudgmentProvider(configServiceOf(row.settings));
        expect(provider).toBeInstanceOf(row.expectedClass);
        // name 落 `experience_judgments.provider`，必须与 config 值域同域
        expect(provider.name).toBe(name);
        expect(provider.enabled).toBe(true);
      },
    );

    it('provider=none → NoopJudgmentProvider（enabled=false ⇒ 调用点短路）', () => {
      const provider = createJudgmentProvider(configServiceOf(settingsOf({ provider: 'none' })));
      expect(provider).toBeInstanceOf(NoopJudgmentProvider);
      expect(provider.name).toBe('none');
      expect(provider.enabled).toBe(false);
    });

    it('未 load judgment 工厂（config.get 返回 undefined）→ 完整缺省形状 + none', () => {
      const settings = resolveJudgmentConfig(configServiceOf(undefined));
      expect(settings).toEqual({
        provider: 'none',
        baseUrl: DEFAULT_TYPESAFE_BASE_URL,
        apiKey: null,
        typesafeModel: null,
        timeoutMs: 8000,
        rateLimitPerHour: 60,
      });
      expect(createJudgmentProvider(configServiceOf(undefined))).toBeInstanceOf(
        NoopJudgmentProvider,
      );
    });
  });

  describe('dev 缺 key → 降级 none + warn 一行', () => {
    it.each(Object.entries(FACTORY_MATRIX))(
      'provider=%s 缺 key → Noop + warn（只出现键名，不出现值）',
      (_name, row) => {
        const provider = createJudgmentProvider(configServiceOf({ ...row.settings, apiKey: null }));

        expect(provider).toBeInstanceOf(NoopJudgmentProvider);
        expect(provider.enabled).toBe(false);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const text = loggedText(warnSpy);
        expect(text).toContain('DISABLED');
        // 真实联网绝不允许静默发生 ⇒ 该分支不得同时打 ENABLED 行
        expect(loggedText(logSpy)).not.toContain('ENABLED');
      },
    );
  });

  describe('启动 INFO（真启用时一行：provider + model + 解析后的 endpoint）', () => {
    it('typesafe：打请求模型与 host+path（含 /v1/systemone，一眼可判 double-/v1 错配）', () => {
      createJudgmentProvider(
        configServiceOf(
          settingsOf({
            provider: 'typesafe',
            baseUrl: 'https://api.typesafe.ai',
            apiKey: FAKE_TYPESAFE_KEY,
            typesafeModel: 'jev-1.13.0',
          }),
        ),
      );

      const text = loggedText(logSpy);
      expect(text).toContain('provider=typesafe');
      expect(text).toContain('model=jev-1.13.0');
      expect(text).toContain('endpoint=api.typesafe.ai/v1/systemone');
      expect(text).not.toContain(FAKE_TYPESAFE_KEY);
    });

    it('env 带 userinfo 时**凭证不进日志**（只取 host+path）', () => {
      logSpy.mockClear();
      createJudgmentProvider(
        configServiceOf(
          settingsOf({
            provider: 'typesafe',
            baseUrl: 'https://leaked-user:leaked-pass@api.typesafe.ai/',
            apiKey: FAKE_TYPESAFE_KEY,
            typesafeModel: 'jev-latest',
          }),
        ),
      );

      const text = loggedText(logSpy);
      expect(text).toContain('endpoint=api.typesafe.ai/v1/systemone');
      expect(text).not.toContain('leaked-user');
      expect(text).not.toContain('leaked-pass');
      // href 含 userinfo ⇒ 任何一行日志都不许出现完整 URL 形态
      expect(text).not.toContain('leaked-user:leaked-pass@');
    });

    it('畸形端点 URL → 诊断退化为固定文案（不抛、不打 href）（PM nit1）', () => {
      expect(() =>
        createJudgmentProvider(
          configServiceOf(
            settingsOf({ provider: 'typesafe', baseUrl: 'not-a-url', apiKey: FAKE_TYPESAFE_KEY }),
          ),
        ),
      ).not.toThrow();
      expect(loggedText(logSpy)).toContain('<unparseable endpoint>');
    });
  });

  describe('退役/非法 provider 值 → warn 一行（判据 = trim 后非空 + 解析落 none + 原值 ≠ none）', () => {
    const ORIGINAL_PROVIDER = process.env.JUDGMENT_PROVIDER;

    afterEach(() => {
      // 用例自身直接改 process.env（判据读它），必须逐条还原——否则污染同 worker 的其他用例
      if (ORIGINAL_PROVIDER === undefined) delete process.env.JUDGMENT_PROVIDER;
      else process.env.JUDGMENT_PROVIDER = ORIGINAL_PROVIDER;
    });

    it('显式设置退役值 jev → warn 一行（带净化后的值）+ 落 Noop', () => {
      process.env.JUDGMENT_PROVIDER = 'jev';

      const provider = createJudgmentProvider(configServiceOf(settingsOf({ provider: 'none' })));

      expect(provider).toBeInstanceOf(NoopJudgmentProvider);
      expect(provider.enabled).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const text = loggedText(warnSpy);
      expect(text).toContain('JUDGMENT_PROVIDER=jev is not valid');
      expect(text).toContain('DISABLED');
      // 关态告警不得伴随"已启用"的 INFO 行（否则运维会以为在跑）
      expect(loggedText(logSpy)).not.toContain('ENABLED');
    });

    it('非法拼写同样 warn + 落 Noop（值域收窄后任何未知值都可见）', () => {
      process.env.JUDGMENT_PROVIDER = 'JEVI';

      expect(
        createJudgmentProvider(configServiceOf(settingsOf({ provider: 'none' }))),
      ).toBeInstanceOf(NoopJudgmentProvider);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(loggedText(warnSpy)).toContain('JUDGMENT_PROVIDER=JEVI is not valid');
    });

    it('回显值被净化（剔除换行 + 截断 32）——防 `.env` 注入伪造日志行', () => {
      process.env.JUDGMENT_PROVIDER = `jev\nFATAL fake line ${'x'.repeat(40)}`;

      createJudgmentProvider(configServiceOf(settingsOf({ provider: 'none' })));

      const text = loggedText(warnSpy);
      // 换行被剔除 ⇒ 注入内容无法自成一行
      expect(text).toContain('JUDGMENT_PROVIDER=jevFATAL fake line');
      // 截断 32 ⇒ 无 33 连串的 x 出现（32 只是"够看清填错的是什么"）
      expect(text).not.toContain('x'.repeat(33));
    });

    it('合法值 typesafe 且配置已解析为 typesafe → 零 warn', () => {
      process.env.JUDGMENT_PROVIDER = 'typesafe';

      createJudgmentProvider(
        configServiceOf(
          settingsOf({ provider: 'typesafe', apiKey: FAKE_TYPESAFE_KEY, typesafeModel: 'jev-latest' }),
        ),
      );

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('回显值是 key 形态（`apikey_` / `sk_`）→ 只回显前缀 + `***`（防误填 key 后泄漏进启动日志）', () => {
      for (const secret of ['apikey_unit_test_only', 'sk_unit_test_only']) {
        process.env.JUDGMENT_PROVIDER = secret;
        warnSpy.mockClear();

        createJudgmentProvider(configServiceOf(settingsOf({ provider: 'none' })));

        const text = loggedText(warnSpy);
        const prefix = secret.slice(0, secret.indexOf('_') + 1);
        expect(text).toContain(`JUDGMENT_PROVIDER=${prefix}***`);
        // 整值任一片段都不许出现（不能只掩前半）
        expect(text).not.toContain(secret);
        expect(text).not.toContain('unit_test_only');
      }
    });

    it.each([
      ['未设置', undefined],
      ['空串（compose `${VAR:-}` 在 .env 缺该键时的注值）', ''],
      ['纯空白', '   '],
      ['合法值 none', 'none'],
    ])('负例：%s → 零 warn（防默认 OSS 部署 100% 误报）', (_label, value) => {
      if (value === undefined) delete process.env.JUDGMENT_PROVIDER;
      else process.env.JUDGMENT_PROVIDER = value;

      const provider = createJudgmentProvider(configServiceOf(settingsOf({ provider: 'none' })));

      expect(provider).toBeInstanceOf(NoopJudgmentProvider);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
