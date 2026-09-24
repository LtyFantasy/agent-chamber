/**
 * attachment-url.config 单测（P2 批 2 / plan §②.1）。
 *
 * 设计意图：生产环境若 ATTACHMENT_URL_SECRET 缺失或仍是占位值（docker-compose
 * `change-me-…` 兜底、.env.example 占位被沿用），必须启动即崩——否则附件签名
 * 退化为"公开密钥"，任何人都能给任意附件 id 造 URL；
 * 与 JWT_SECRET 同值同样拒绝（运维防呆：密钥隔离防线不得被静默放弃）。
 * development/test 保留默认值，便于本地零配置起步与 e2e 构造同钥场景。
 */
import attachmentUrlConfig from './attachment-url.config';

describe('attachmentUrlConfig', () => {
  const factory = attachmentUrlConfig as unknown as () => {
    secret: string;
    ttlDefaultSeconds: number;
  };

  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('production: 缺失 ATTACHMENT_URL_SECRET → throw', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ATTACHMENT_URL_SECRET;

    expect(() => factory()).toThrow(/ATTACHMENT_URL_SECRET/);
  });

  it('production: change-me 前缀占位值 → throw（.env.example 直接沿用场景）', () => {
    process.env.NODE_ENV = 'production';
    process.env.ATTACHMENT_URL_SECRET = 'change-me-to-a-random-32-char-string-attachment-url';

    expect(() => factory()).toThrow(/ATTACHMENT_URL_SECRET/);
  });

  it('production: 与会话 JWT_SECRET 同值 → throw（密钥隔离不得被静默放弃）', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-strong-random-jwt-secret-0123456789';
    process.env.ATTACHMENT_URL_SECRET = 'a-strong-random-jwt-secret-0123456789';

    expect(() => factory()).toThrow(/must differ from JWT_SECRET/);
  });

  it('production: 独立强随机密钥 → 正常返回', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-strong-random-jwt-secret-0123456789';
    process.env.ATTACHMENT_URL_SECRET = 'another-strong-random-secret-9876543210';

    const config = factory();
    expect(config.secret).toBe('another-strong-random-secret-9876543210');
    expect(config.ttlDefaultSeconds).toBe(300);
  });

  it('development: 缺失密钥回退默认值，TTL 默认 300 秒', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ATTACHMENT_URL_SECRET;
    delete process.env.ATTACHMENT_SIGNED_URL_TTL_DEFAULT;

    const config = factory();
    expect(config.secret).toBe('default-attachment-url-secret-change-me');
    expect(config.ttlDefaultSeconds).toBe(300);
  });

  it('TTL 显式配置生效；NaN/非正数回落到 300（防 expiresIn=NaN 让签发路径 500）', () => {
    process.env.NODE_ENV = 'development';
    process.env.ATTACHMENT_SIGNED_URL_TTL_DEFAULT = '900';
    expect(factory().ttlDefaultSeconds).toBe(900);

    process.env.ATTACHMENT_SIGNED_URL_TTL_DEFAULT = 'not-a-number';
    expect(factory().ttlDefaultSeconds).toBe(300);

    process.env.ATTACHMENT_SIGNED_URL_TTL_DEFAULT = '0';
    expect(factory().ttlDefaultSeconds).toBe(300);
  });
});
