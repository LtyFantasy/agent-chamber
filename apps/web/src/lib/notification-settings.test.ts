/**
 * notification-settings.test.ts — 通知设置面**纯逻辑单源**的判据测试。
 *
 * 为什么先测纯函数再测组件：本批有大量"判据"（10 类分组不重不漏、四态徽标、
 * 409/400/429 分类、验证门槛），它们在组件里被包在渲染/请求里就难以穷举。
 * 判据单源成纯函数后，这里可以用表驱动把所有边界一次性钉死。
 *
 * 覆盖：类别单源（顺序/分组/缺省集）、open_id 预检、四态徽标、验证门槛、
 * 平台未配置判定、HTTP 错误分类、测试降级原因分类、一次性提示存储。
 */

import {
  FEISHU_OPEN_ID_PATTERN,
  NOTIFICATION_CATEGORY_GROUPS,
  NOTIFICATION_CATEGORY_KEYS,
  NOTIFICATION_DEFAULT_CATEGORY_KEYS,
  NOTIFICATION_FEISHU_PROVIDER,
  NOTIFICATION_NOTICE_STORAGE_KEYS,
  NOTIFICATION_TEST_STATUS,
  NOTIFICATION_TOPIC_CATEGORY,
  classifyChannelError,
  classifyTestReason,
  isChannelVerified,
  isFeishuProviderUnconfigured,
  isNoticeDismissed,
  isValidFeishuOpenId,
  markNoticeDismissed,
  needsChannelVerification,
  parseNotificationError,
  resolveChannelBadgeState,
  type NotificationChannelView,
} from './notification-settings';

/** 渠道行工厂（只关心被测字段，其余给稳定缺省） */
function channel(overrides: Partial<NotificationChannelView> = {}): NotificationChannelView {
  return {
    provider: NOTIFICATION_FEISHU_PROVIDER,
    recipientAddress: 'ou_abc123',
    enabled: false,
    lastTestStatus: null,
    lastTestAt: null,
    source: 'user',
    createdAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

/** axios 风格错误工厂（与 apiRequest 的抛出形态一致） */
function httpError(status: number, message = '', data?: Record<string, unknown>) {
  return { response: { status, data: { code: status, message, data } } };
}

describe('类别单源（10 类 / 4 组）', () => {
  it('顺序与后端单源一致（10 个，题面顺序）', () => {
    expect(NOTIFICATION_CATEGORY_KEYS).toEqual([
      'task_done',
      'task_created',
      'task_updated',
      'task_assigned',
      'topic',
      'doc_created',
      'doc_updated',
      'doc_deleted',
      'doc_moved',
      'direct',
    ]);
  });

  it('4 组不重不漏地覆盖 10 类', () => {
    const grouped = NOTIFICATION_CATEGORY_GROUPS.flatMap((g) => [...g.keys]);
    expect(grouped).toHaveLength(NOTIFICATION_CATEGORY_KEYS.length);
    expect(new Set(grouped).size).toBe(NOTIFICATION_CATEGORY_KEYS.length);
    expect([...grouped].sort()).toEqual([...NOTIFICATION_CATEGORY_KEYS].sort());
  });

  it('组内顺序 == 全局顺序（分组渲染不会打乱阅读顺序）', () => {
    const globalOrder = NOTIFICATION_CATEGORY_KEYS as readonly string[];
    for (const group of NOTIFICATION_CATEGORY_GROUPS) {
      const indexes = group.keys.map((k) => globalOrder.indexOf(k));
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    }
  });

  it('分组 id 与组内容固定（任务 4 / 话题 1 / 文档 4 / 直发 1）', () => {
    expect(NOTIFICATION_CATEGORY_GROUPS.map((g) => [g.id, g.keys.length])).toEqual([
      ['tasks', 4],
      ['topics', 1],
      ['docs', 4],
      ['direct', 1],
    ]);
  });

  it('缺省集 = task_done + direct（与后端 DEFAULT_NOTIFY_CATEGORIES 同口径）', () => {
    expect(NOTIFICATION_DEFAULT_CATEGORY_KEYS).toEqual(['task_done', 'direct']);
  });
});

describe('open_id 预检', () => {
  it('合法形态通过（含前后空白自动 trim）', () => {
    expect(isValidFeishuOpenId('ou_abc123')).toBe(true);
    expect(isValidFeishuOpenId('  ou_a-b_C9  ')).toBe(true);
    expect(isValidFeishuOpenId(`ou_${'a'.repeat(200)}`)).toBe(true);
  });

  it('非法形态一律拒绝', () => {
    for (const bad of [
      '',
      '   ',
      'abc123',
      'ou_',
      'ou_空格 abc',
      `ou_${'a'.repeat(201)}`,
      'ou_abc!',
      'OU_abc123',
    ]) {
      expect(isValidFeishuOpenId(bad)).toBe(false);
    }
  });

  it('正则与后端 @Matches 同源（同一条模式）', () => {
    expect(FEISHU_OPEN_ID_PATTERN.source).toBe('^ou_[A-Za-z0-9_-]{1,200}$');
  });
});

describe('渠道四态徽标', () => {
  it('未绑定 → unbound', () => {
    expect(resolveChannelBadgeState(null)).toBe('unbound');
  });

  it('从未验证（NULL）→ unverified', () => {
    expect(resolveChannelBadgeState(channel({ lastTestStatus: null }))).toBe('unverified');
  });

  it('播种行 → seeded（不冒充"已验证"）', () => {
    expect(
      resolveChannelBadgeState(channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.seeded })),
    ).toBe('seeded');
  });

  it('测试通过 → verified；测试失败 → failed', () => {
    expect(resolveChannelBadgeState(channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.ok }))).toBe(
      'verified',
    );
    expect(
      resolveChannelBadgeState(channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.failed })),
    ).toBe('failed');
  });
});

describe('验证门槛（与后端 enabled=true 的服务端不变量同口径）', () => {
  it('ok / seeded 视为已满足验证（seeded 满足：播种行自带 last_test_address）', () => {
    expect(isChannelVerified(channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.ok }))).toBe(true);
    expect(isChannelVerified(channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.seeded }))).toBe(
      true,
    );
  });

  it('NULL / failed / 未绑定 不满足验证', () => {
    expect(isChannelVerified(channel({ lastTestStatus: null }))).toBe(false);
    expect(isChannelVerified(channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.failed }))).toBe(
      false,
    );
    expect(isChannelVerified(null)).toBe(false);
  });

  it('状态条判据 = lastTestStatus !== ok（覆盖 NULL / failed / seeded）', () => {
    expect(needsChannelVerification(null)).toBe(false);
    expect(needsChannelVerification(channel({ lastTestStatus: null }))).toBe(true);
    expect(
      needsChannelVerification(channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.failed })),
    ).toBe(true);
    expect(
      needsChannelVerification(channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.seeded })),
    ).toBe(true);
    expect(needsChannelVerification(channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.ok }))).toBe(
      false,
    );
  });
});

describe('平台 provider 能力', () => {
  it('configured=false → 表单应禁用', () => {
    expect(isFeishuProviderUnconfigured([{ key: 'feishu', configured: false }])).toBe(true);
  });

  it('configured=true / 无该 provider → 不禁用', () => {
    expect(isFeishuProviderUnconfigured([{ key: 'feishu', configured: true }])).toBe(false);
    expect(isFeishuProviderUnconfigured([])).toBe(false);
  });
});

describe('HTTP 错误分类（决定 toast 文案）', () => {
  it('409 地址被他人占用 —— 后端英文长文案按稳定片段识别', () => {
    const err = httpError(
      409,
      'This Feishu account is already bound to another platform account. If this is you, ...',
    );
    expect(classifyChannelError(err)).toBe('addressTaken');
  });

  it('409 自身重复绑定 —— 与"地址被占用"文案不同（同状态码不同分类）', () => {
    expect(
      classifyChannelError(
        httpError(
          409,
          'This channel already has a binding for your account — refresh and try again.',
        ),
      ),
    ).toBe('channelExists');
  });

  it('400 未验证置启用 / 地址非法 / 首绑缺地址 三态分流', () => {
    expect(
      classifyChannelError(
        httpError(
          400,
          'This address has not been verified for this channel yet: send a test message first',
        ),
      ),
    ).toBe('notVerified');
    expect(
      classifyChannelError(
        httpError(400, 'recipientOpenId must be a Feishu open_id (ou_ followed by 1-200 chars)'),
      ),
    ).toBe('invalidAddress');
    expect(
      classifyChannelError(
        httpError(400, 'recipientOpenId is required to bind a channel for the first time'),
      ),
    ).toBe('missingAddress');
  });

  it('404 → 无活绑定；429 → 限流', () => {
    expect(classifyChannelError(httpError(404, 'No bound channel for this provider'))).toBe(
      'noBinding',
    );
    expect(classifyChannelError(httpError(429, '', { retryAfterSeconds: 42 }))).toBe('rateLimited');
  });

  it('未知错误（网络 / 5xx / 非 HTTP 抛出）一律 unknown，不崩', () => {
    expect(classifyChannelError(new Error('Network Error'))).toBe('unknown');
    expect(classifyChannelError(httpError(500, 'boom'))).toBe('unknown');
    expect(classifyChannelError(null)).toBe('unknown');
    expect(classifyChannelError(undefined)).toBe('unknown');
  });

  it('parseNotificationError 安全提取（缺失字段不抛）', () => {
    expect(parseNotificationError(httpError(429, 'x', { retryAfterSeconds: 7 }))).toEqual({
      status: 429,
      message: 'x',
      retryAfterSeconds: 7,
    });
    expect(parseNotificationError({})).toEqual({
      status: null,
      message: '',
      retryAfterSeconds: undefined,
    });
    // retryAfterSeconds 非数字（后端换了形态）→ 当作缺失，由调用方兜底
    expect(
      parseNotificationError(httpError(429, '', { retryAfterSeconds: '7' })).retryAfterSeconds,
    ).toBeUndefined();
  });
});

describe('测试消息降级原因分类', () => {
  it('运维态三值 → 各自的"联系管理员"文案', () => {
    expect(classifyTestReason('no_provider')).toBe('noProvider');
    expect(classifyTestReason('notify_disabled')).toBe('notifyDisabled');
    expect(classifyTestReason('category_disabled')).toBe('categoryDisabled');
  });

  it('投递失败 / 限流 / 其它', () => {
    expect(classifyTestReason('delivery_failed')).toBe('deliveryFailed');
    expect(classifyTestReason('rate_limited')).toBe('rateLimited');
    expect(classifyTestReason(undefined)).toBe('other');
    expect(classifyTestReason('recipient_not_bound')).toBe('other');
  });
});

describe('一次性提示（localStorage 已读标记）', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('默认未读 → 标记后已读', () => {
    expect(isNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.upgradeBanner)).toBe(false);
    markNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.upgradeBanner);
    expect(isNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.upgradeBanner)).toBe(true);
  });

  it('两个键互不影响（横幅已读不影响 env_seed 告知）', () => {
    markNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.upgradeBanner);
    expect(isNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.envSeedNotice)).toBe(false);
  });

  it('localStorage 抛异常时不崩（私隐模式）', () => {
    // jsdom 的 localStorage 方法不是可 spy 的普通属性，直接替换整个对象模拟"拒绝访问"
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    });
    expect(isNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.upgradeBanner)).toBe(false);
    expect(() => markNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.upgradeBanner)).not.toThrow();
    if (original) Object.defineProperty(window, 'localStorage', original);
  });

  it('topic 类别常量与类别单源一致', () => {
    expect(NOTIFICATION_CATEGORY_KEYS).toContain(NOTIFICATION_TOPIC_CATEGORY);
  });
});
