/**
 * notifications.config 单测（解析矩阵 + fail-fast 三组合 + 净化纪律）。
 *
 * 设计意图：通知出口是**出境功能**——"启用成功"与"启用失败"在行为上都表现为"没有消息"，
 * 用户分不清是没人触发还是没配上。故本文件的契约有三条硬边：
 * ① `NOTIFY_ENABLED=false` ⇒ **不校验任何键**（缺省态不打扰任何部署）；
 * ② production + 启用 + 缺关键键 ⇒ **启动即崩**（文案含出境字段与"如何关掉"）；
 * ③ warnings **绝不回显 env 原值**（畸形值可能是凭据 / 带 userinfo 的 URL）。
 *
 * 用例覆盖 = plan §4 的键表 + §9 的"config 解析矩阵（fail-fast 三组合 / 非法 token / 默认值 / 净化）"。
 */
import notificationsConfig, {
  DEFAULT_NOTIFY_CATEGORIES,
  NOTIFY_CATEGORIES,
  NOTIFY_EGRESS_FIELDS,
  NOTIFY_PROVIDER_TOKENS,
  NOTIFICATIONS_CONFIG_FALLBACK,
  type NotificationsConfig,
} from './notifications.config';

describe('notificationsConfig', () => {
  const factory = notificationsConfig as unknown as () => NotificationsConfig;
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  /** 清掉本模块管辖的全部 env（缺省态用例的前置） */
  function clearNotifyEnv(): void {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('NOTIFY_') || key.startsWith('FEISHU_')) delete process.env[key];
    }
  }

  // ───────────────────────── 缺省态 ─────────────────────────

  it('缺省（无任何 NOTIFY_* env）→ 关闭 + `task_done,direct` + 空出口 + 缺省旋钮', () => {
    clearNotifyEnv();
    const config = factory();
    expect(config.enabled).toBe(false);
    expect(config.categories).toEqual(['task_done', 'direct']);
    expect(config.providers).toEqual([]);
    expect(config.feishuAppId).toBeNull();
    expect(config.feishuAppSecret).toBeNull();
    expect(config.feishuRecipientOpenId).toBeNull();
    expect(config.webBaseUrl).toBeNull();
    expect(config.ownerUsernames).toEqual([]);
    expect(config.taskThrottleSeconds).toBe(300);
    expect(config.docThrottleSeconds).toBe(600);
    expect(config.topicThrottleSeconds).toBe(600);
    expect(config.globalRateLimit).toBe(5);
    expect(config.globalRateWindowSeconds).toBe(600);
    expect(config.directRateLimitPerWindow).toBe(6);
    expect(config.directRateWindowSeconds).toBe(600);
    expect(config.httpTimeoutMs).toBe(8000);
    expect(config.warnings).toEqual([]);
  });

  it('兜底常量与缺省解析一致（e2e 未 load 工厂时的形状保证不会漂移）', () => {
    clearNotifyEnv();
    const config = factory();
    expect(NOTIFICATIONS_CONFIG_FALLBACK.enabled).toBe(config.enabled);
    expect(NOTIFICATIONS_CONFIG_FALLBACK.categories).toEqual(config.categories);
    expect(NOTIFICATIONS_CONFIG_FALLBACK.globalRateLimit).toBe(config.globalRateLimit);
    expect(NOTIFICATIONS_CONFIG_FALLBACK.httpTimeoutMs).toBe(config.httpTimeoutMs);
  });

  it('布尔约定：只有字面 `true` 才算启用（`1`/`TRUE`/空串一律关闭）', () => {
    clearNotifyEnv();
    for (const value of ['1', 'TRUE', 'True', 'yes', '', ' true']) {
      process.env.NOTIFY_ENABLED = value;
      expect(factory().enabled).toBe(false);
    }
    process.env.NOTIFY_ENABLED = 'true';
    expect(factory().enabled).toBe(true);
  });

  // ───────────────────────── fail-fast 矩阵 ─────────────────────────

  it('矩阵① ENABLED=false ⇒ 不校验任何键（production 亦然）', () => {
    clearNotifyEnv();
    process.env.NODE_ENV = 'production';
    process.env.NOTIFY_ENABLED = 'false';
    // 故意配上"看起来需要四键"的 provider，并让 categories 含 topic —— 关着就一律不校验
    process.env.NOTIFY_PROVIDERS = 'feishu';
    process.env.NOTIFY_CATEGORIES = 'topic';
    const config = factory();
    expect(config.enabled).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  it('矩阵② production + feishu 缺四键 ⇒ 抛错（文案含出境字段与"如何关掉"）', () => {
    clearNotifyEnv();
    process.env.NODE_ENV = 'production';
    process.env.NOTIFY_ENABLED = 'true';
    process.env.NOTIFY_PROVIDERS = 'feishu';
    expect(() => factory()).toThrow(/FEISHU_APP_ID/);
    expect(() => factory()).toThrow(/NOTIFY_ENABLED=false/);
    // 出境声明三处同源：fail-fast 文案必须含声明里的字段（用朴素子串断言——声明含正则元字符）
    expect(() => factory()).toThrow('task title');
    expect(() => factory()).toThrow('deep link');
  });

  it('矩阵② production + feishu 四键齐 ⇒ 不抛（且无残留 warning）', () => {
    clearNotifyEnv();
    process.env.NODE_ENV = 'production';
    process.env.NOTIFY_ENABLED = 'true';
    process.env.NOTIFY_PROVIDERS = 'feishu';
    process.env.FEISHU_APP_ID = 'cli_unit_test';
    process.env.FEISHU_APP_SECRET = 'unit-test-secret';
    process.env.FEISHU_RECIPIENT_OPEN_ID = 'ou_unit_test';
    process.env.NOTIFY_WEB_BASE_URL = 'https://platform.example.com';
    const config = factory();
    expect(config.enabled).toBe(true);
    expect(config.providers).toEqual(['feishu']);
    expect(config.feishuRecipientOpenId).toBe('ou_unit_test');
    expect(config.warnings).toEqual([]);
  });

  it('矩阵② dev（非 production）缺四键 ⇒ 只产 warning、不抛', () => {
    clearNotifyEnv();
    process.env.NODE_ENV = 'development';
    process.env.NOTIFY_ENABLED = 'true';
    process.env.NOTIFY_PROVIDERS = 'feishu';
    const config = factory();
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toMatch(/FEISHU_APP_ID/);
  });

  it('矩阵② 二期三键：production + feishu + 三键齐（**无** RECIPIENT_OPEN_ID）⇒ 不抛、无 warning', () => {
    clearNotifyEnv();
    process.env.NODE_ENV = 'production';
    process.env.NOTIFY_ENABLED = 'true';
    process.env.NOTIFY_PROVIDERS = 'feishu';
    process.env.FEISHU_APP_ID = 'cli_unit_test';
    process.env.FEISHU_APP_SECRET = 'unit-test-secret';
    // 二期：FEISHU_RECIPIENT_OPEN_ID 已从必填表撤出（它是 D4 播种源，缺它只意味着"不自动播种"）
    process.env.NOTIFY_WEB_BASE_URL = 'https://platform.example.com';
    const config = factory();
    expect(config.enabled).toBe(true);
    expect(config.feishuRecipientOpenId).toBeNull();
    expect(config.warnings).toEqual([]);
  });

  it('矩阵② 二期三键：production + feishu 缺 NOTIFY_WEB_BASE_URL ⇒ 抛错', () => {
    clearNotifyEnv();
    process.env.NODE_ENV = 'production';
    process.env.NOTIFY_ENABLED = 'true';
    process.env.NOTIFY_PROVIDERS = 'feishu';
    process.env.FEISHU_APP_ID = 'cli_unit_test';
    process.env.FEISHU_APP_SECRET = 'unit-test-secret';
    process.env.FEISHU_RECIPIENT_OPEN_ID = 'ou_unit_test';
    expect(() => factory()).toThrow(/NOTIFY_WEB_BASE_URL/);
  });

  it('矩阵③ 已撤（二期）：production + topic 类别 + owner 名单空 ⇒ **不抛也不 warn**', () => {
    clearNotifyEnv();
    process.env.NODE_ENV = 'production';
    process.env.NOTIFY_ENABLED = 'true';
    process.env.NOTIFY_CATEGORIES = 'task_done,topic';
    // 二期 topic 的收件人来自用户各自的渠道绑定，owner 名单降级为播种源；"有地址无归属"由
    // orchestrator 的播种 outcome 在运行期按真实 DB 事实报错——本矩阵不再管这件事
    const config = factory();
    expect(config.enabled).toBe(true);
    expect(config.warnings).toEqual([]);
  });

  it('矩阵③ 已撤（二期）：dev + topic 类别 + owner 名单空 ⇒ 无该条 warning', () => {
    clearNotifyEnv();
    process.env.NODE_ENV = 'test';
    process.env.NOTIFY_ENABLED = 'true';
    process.env.NOTIFY_CATEGORIES = 'topic';
    expect(factory().warnings).toEqual([]);
  });

  it('ENABLED=false 时**不抛**（fail-fast 矩阵不校验；解析类 warning 照常产出）', () => {
    clearNotifyEnv();
    process.env.NOTIFY_ENABLED = 'false';
    process.env.NOTIFY_CATEGORIES = 'not_a_category';
    process.env.NOTIFY_GLOBAL_RATE_LIMIT = 'abc';
    // 矩阵① 只关掉**必填键校验**（production 的 fail-fast）：非法 token 与非法数值仍被
    // 忽略/回落，且解析类 warning **照常产出**（用户需要知道自己的配置没生效）——故这里
    // 断言"不抛 + 有 warning"，而不是"什么都不报"。
    expect(() => factory()).not.toThrow();
    expect(factory().warnings).toHaveLength(2);
  });

  // ───────────────────────── token 解析 ─────────────────────────

  it('NOTIFY_CATEGORIES：非法 token 忽略 + 一条净化 warning；合法去重保序', () => {
    clearNotifyEnv();
    process.env.NOTIFY_CATEGORIES = 'task_done, nope ,task_done,direct';
    const config = factory();
    expect(config.categories).toEqual(['task_done', 'direct']);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toMatch(/nope/);
    // 值域提示随文案给出（用户据此自查）
    expect(config.warnings[0]).toMatch(/task_done/);
  });

  it('NOTIFY_CATEGORIES：空白串 ⇒ 回落缺省集且**不产 warning**（compose `${VAR:-}` 注空串）', () => {
    clearNotifyEnv();
    process.env.NOTIFY_CATEGORIES = '   ';
    const config = factory();
    expect(config.categories).toEqual([...DEFAULT_NOTIFY_CATEGORIES]);
    expect(config.warnings).toEqual([]);
  });

  it('NOTIFY_PROVIDERS：未知 token 忽略 + warning（fail-open，不抛）', () => {
    clearNotifyEnv();
    process.env.NOTIFY_PROVIDERS = 'slack,feishu';
    const config = factory();
    expect(config.providers).toEqual(['feishu']);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toMatch(/slack/);
  });

  it('类别与 provider 值域是枚举单源（新增 token 必须同步用例，这里是自检锚点）', () => {
    // 值域成员数变化 = 契约变化（改这里必须同时改 orchestrator 映射表 + .env.example）
    expect(NOTIFY_CATEGORIES).toHaveLength(10);
    expect(NOTIFY_PROVIDER_TOKENS).toEqual(['feishu']);
    expect(NOTIFY_CATEGORIES).toContain('direct');
    expect(NOTIFY_CATEGORIES).toContain('task_done');
  });

  // ───────────────────────── 数值解析防御 ─────────────────────────

  it('数值键：NaN / 零 / 负数 / 非数 ⇒ 回落缺省 + 逐键一条 warning', () => {
    clearNotifyEnv();
    process.env.NOTIFY_GLOBAL_RATE_LIMIT = 'abc';
    process.env.NOTIFY_HTTP_TIMEOUT_MS = '0';
    process.env.NOTIFY_TASK_THROTTLE_SECONDS = '-5';
    const config = factory();
    expect(config.globalRateLimit).toBe(5);
    expect(config.httpTimeoutMs).toBe(8000);
    expect(config.taskThrottleSeconds).toBe(300);
    expect(config.warnings).toHaveLength(3);
    for (const warning of config.warnings) expect(warning).toMatch(/NOTIFY_/);
  });

  it('数值键：空白串视同"未配置"（不产 warning）', () => {
    clearNotifyEnv();
    process.env.NOTIFY_GLOBAL_RATE_LIMIT = '  ';
    const config = factory();
    expect(config.globalRateLimit).toBe(5);
    expect(config.warnings).toEqual([]);
  });

  it('数值键：合法值向下取整生效', () => {
    clearNotifyEnv();
    process.env.NOTIFY_GLOBAL_RATE_LIMIT = '7.9';
    expect(factory().globalRateLimit).toBe(7);
  });

  it('NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR：非正数 / NaN ⇒ 回落 12 + warning；合法值生效', () => {
    // 系统告警的量控上限（plan D6-4）：**只卡可诱发的 auth 面**，缺省 12/h
    clearNotifyEnv();
    expect(factory().systemAlertMaxPerHour).toBe(12);
    expect(factory().warnings).toEqual([]);

    for (const invalid of ['abc', '0', '-3', 'NaN']) {
      process.env.NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR = invalid;
      const config = factory();
      expect(config.systemAlertMaxPerHour).toBe(12);
      expect(
        config.warnings.some((warning) => warning.includes('NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR')),
      ).toBe(true);
      // 净化纪律：只出现键名与缺省值，不回显原值
      for (const warning of config.warnings) expect(warning).not.toContain(invalid);
    }

    process.env.NOTIFY_SYSTEM_ALERT_MAX_PER_HOUR = '30';
    expect(factory().systemAlertMaxPerHour).toBe(30);
  });

  it('fallback 兜底同步覆盖 systemAlertMaxPerHour（e2e 未 load 工厂时不漂移）', () => {
    clearNotifyEnv();
    expect(NOTIFICATIONS_CONFIG_FALLBACK.systemAlertMaxPerHour).toBe(12);
    expect(NOTIFICATIONS_CONFIG_FALLBACK.systemAlertMaxPerHour).toBe(
      factory().systemAlertMaxPerHour,
    );
  });

  // ───────────────────────── 净化纪律 ─────────────────────────

  it('warnings **绝不回显 env 原值**（凭据形态的值只能出现在脱敏回显里）', () => {
    clearNotifyEnv();
    const secret = 'apikey_SUPER_SECRET_VALUE_1234567890';
    process.env.NOTIFY_PROVIDERS = secret; // 把凭据误填进 provider 键（最常见的配置手滑）
    process.env.NOTIFY_GLOBAL_RATE_LIMIT = secret;
    const config = factory();
    for (const warning of config.warnings) {
      expect(warning).not.toContain(secret);
      // 脱敏后只留前缀（sanitizeLogValue 的行为）
      expect(warning).not.toContain('SUPER_SECRET');
    }
    // 至少有一条 warning 提醒用户"这个 token 不认"（而不是静默吞掉）
    expect(config.warnings.length).toBeGreaterThan(0);
  });

  it('fail-fast 文案不回显凭据值（只出现键名）', () => {
    clearNotifyEnv();
    process.env.NODE_ENV = 'production';
    process.env.NOTIFY_ENABLED = 'true';
    process.env.NOTIFY_PROVIDERS = 'feishu';
    process.env.FEISHU_RECIPIENT_OPEN_ID = 'ou_real_recipient';
    expect(() => factory()).toThrow();
    try {
      factory();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('FEISHU_APP_SECRET'); // 缺哪个键是必须说的
      expect(message).not.toContain('ou_real_recipient'); // 已有的值一个字都不能回显
    }
  });

  // ───────────────────────── 其余键 ─────────────────────────

  it('NOTIFY_WEB_BASE_URL 尾斜杠剥离（防拼出 `//tasks/...` 双斜杠）', () => {
    clearNotifyEnv();
    process.env.NOTIFY_WEB_BASE_URL = 'https://platform.example.com///';
    expect(factory().webBaseUrl).toBe('https://platform.example.com');
  });

  it('NOTIFY_OWNER_USERNAMES 逗号分隔 + trim + 去重', () => {
    clearNotifyEnv();
    process.env.NOTIFY_OWNER_USERNAMES = ' owner , owner ,second ';
    expect(factory().ownerUsernames).toEqual(['owner', 'second']);
  });

  it('飞书三键 trim 归一（`.env` 尾随空格 / CRLF 不得把合法值判成非法）', () => {
    clearNotifyEnv();
    process.env.FEISHU_APP_ID = ' cli_x \r';
    process.env.FEISHU_APP_SECRET = ' secret \n';
    const config = factory();
    expect(config.feishuAppId).toBe('cli_x');
    expect(config.feishuAppSecret).toBe('secret');
  });

  it('出境字段声明非空且逐项可读（三处同源的单一副本）', () => {
    expect(NOTIFY_EGRESS_FIELDS.length).toBeGreaterThanOrEqual(5);
    for (const field of NOTIFY_EGRESS_FIELDS) expect(field.trim().length).toBeGreaterThan(0);
  });
});
