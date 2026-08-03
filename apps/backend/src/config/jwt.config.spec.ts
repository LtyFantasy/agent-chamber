/**
 * jwt.config 单元测试（P2 批次 A1：生产缺密钥 / 占位值 fail-fast）
 *
 * 设计意图：生产环境若 JWT_SECRET / JWT_REFRESH_SECRET 缺失或仍是占位值
 * （docker-compose `change-me-in-production` 兜底、.env.example 占位被沿用），
 * 必须启动即崩，绝不静默回退默认值；development 保留默认值便于本地开发。
 */
import jwtConfig from './jwt.config';

describe('jwtConfig', () => {
  // registerAs 返回的 ConfigFactory 可直接调用得到配置对象
  const factory = jwtConfig as unknown as () => {
    secret: string;
    refreshSecret: string;
  };

  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    // 恢复环境变量，避免污染其他测试
    process.env = { ...ORIGINAL_ENV };
  });

  it('production: 缺失 JWT_SECRET 时 throw', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    process.env.JWT_REFRESH_SECRET = 'a-strong-random-refresh-secret-0123456789';

    expect(() => factory()).toThrow(/JWT_SECRET/);
  });

  it('production: 缺失 JWT_REFRESH_SECRET 时 throw', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-strong-random-jwt-secret-0123456789';
    delete process.env.JWT_REFRESH_SECRET;

    expect(() => factory()).toThrow(/JWT_REFRESH_SECRET/);
  });

  it('production: change-me 前缀占位值 throw（.env.example 直接沿用场景）', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'change-me-to-a-random-32-char-string';
    process.env.JWT_REFRESH_SECRET = 'change-me-to-a-random-32-char-string-refresh';

    expect(() => factory()).toThrow(/JWT_SECRET/);
  });

  it('production: docker-compose change-me-in-production 兜底值 throw', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'change-me-in-production';
    process.env.JWT_REFRESH_SECRET = 'a-strong-random-refresh-secret-0123456789';

    expect(() => factory()).toThrow(/JWT_SECRET/);
  });

  it('production: 随机强密钥正常返回', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-strong-random-jwt-secret-0123456789';
    process.env.JWT_REFRESH_SECRET = 'a-strong-random-refresh-secret-0123456789';

    const config = factory();
    expect(config.secret).toBe('a-strong-random-jwt-secret-0123456789');
    expect(config.refreshSecret).toBe('a-strong-random-refresh-secret-0123456789');
  });

  it('development: 缺失密钥回退默认值（便于本地开发）', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;

    const config = factory();
    expect(config.secret).toBe('default-jwt-secret-change-me');
    expect(config.refreshSecret).toBe('default-refresh-secret-change-me');
  });
});
