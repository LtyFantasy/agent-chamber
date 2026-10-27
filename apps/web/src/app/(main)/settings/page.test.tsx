/**
 * settings/page.test.tsx — 设置页三 tab 壳 + 「通知」tab 全量的契约测试。
 *
 * 隔离策略（同 memory/page.test.tsx 先例）：**只 mock axios，不 mock `@/lib/api`**——
 * 请求形态（method/url/body）本身就是契约（PUT 的稀疏覆盖载荷、DELETE 的目标、
 * test 端点的路径），mock 掉 Api 层会把被测物一起 mock 掉。
 *
 * 覆盖清单：
 * ① 三 tab 受控切换：默认「资料」、切「安全」只剩密码卡、原资料卡行为零改动
 *    （改名仍打 PATCH /users/me 且更新 auth store）；
 * ② 通知 tab 引导层：空渠道 → 空态 + CTA 滚动到绑定卡 + 偏好区常驻提示；
 * ③ 四态徽标（未绑定 / 未验证 / 已导入·未验证 / 已验证 / 验证失败）+ 状态条（含 seeded 特化文案）；
 * ④ open_id 格式预检（非法不发请求）+ 保存载荷 + 发送测试消息（地址未保存时禁用）；
 * ⑤ 错误文案映射：409 占用 / 409 自身重复 / 400 未验证 / 429 带秒插值 / delivered=0 的 reason 族；
 * ⑥ 渠道开关 optimistic 与失败回滚；
 * ⑦ 偏好即改即存（稀疏载荷 / 行内已保存 / 失败回滚 toast）+ 平台未启用行 disabled + topic 灰字；
 * ⑧ 恢复默认：取消不发请求、确认发 DELETE 并按响应更新；
 * ⑨ configured=false → 提示 + 表单禁用；
 * ⑩ env_seed 一次性告知（可关、写 localStorage 标记）；
 * ⑪ 加载失败态 + 重试；
 * ⑫ 静音/解绑文案消歧（解绑确认文案写"重绑同一地址保留验证态"）。
 */

import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettingsPage from './page';
import { axiosInstance } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { confirm, toast } from '@/lib/notify';
import enMessages from '@/i18n/messages/en.json';
import {
  NOTIFICATION_CATEGORY_KEYS,
  NOTIFICATION_NOTICE_STORAGE_KEYS,
  NOTIFICATION_TEST_STATUS,
  type NotificationCategoryPrefs,
  type NotificationChannelView,
  type NotificationSettingsView,
} from '@/lib/notification-settings';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * 命令式壳替身：`confirm` 的可控返回值 + `toast` 的调用记录。
 *
 * 为什么 mock 壳而不是驱动真 store：本 spec 要断言的是**文案**（"该飞书账号已绑定到其他账户"
 * 这类必须是人话），而不是 AlertDialog 的渲染——那由基础组件的既有测试覆盖。
 */
jest.mock('@/lib/notify', () => {
  const toast = Object.assign(jest.fn(), {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
  });
  return { confirm: jest.fn(async () => true), toast };
});

const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockToast = toast as unknown as jest.Mock & {
  success: jest.Mock;
  error: jest.Mock;
  warning: jest.Mock;
};

/**
 * axios 层 mock：`api.ts` 在模块加载期调用 `axios.create(...)`，工厂必须返回带
 * `interceptors.{request,response}.use` 与 `request` 的实例；`request` 是捕获点。
 */
jest.mock('axios', () => {
  const instance = {
    request: jest.fn(),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  };
  const create = jest.fn(() => instance);
  return {
    __esModule: true,
    default: { create, getUri: jest.fn() },
    create,
    AxiosError: class AxiosError extends Error {},
  };
});

const mockRequest = axiosInstance.request as unknown as jest.Mock;

/** 把真实语言包摊平成 `namespace.key` 表（读真 en.json：断言的是上线文案本身） */
function flatten(source: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object')
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    else out[path] = String(value);
  }
  return out;
}

const messages = flatten({
  settings: enMessages.settings,
  common: enMessages.common,
});

/** 极简插值（本批只用 `{seconds}`；无 plural 形态） */
function formatMessage(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  let out = text;
  for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string, params?: Record<string, string | number>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    return formatMessage(messages[fullKey] ?? fullKey, params);
  },
}));

/** 后端统一响应信封（apiRequest 剥 data 层） */
function envelope<T>(data: T) {
  return { data: { code: 0, message: 'ok', data, timestamp: '', requestId: 'r1' } };
}

/** HTTP 错误（拦截器形态：response.data.message 为后端英文文案，data.data 为附加槽） */
function httpError(status: number, message = '', data?: Record<string, unknown>) {
  return { response: { status, data: { code: status, message, data: data ?? {} } } };
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FEISHU_OK = { key: 'feishu', configured: true };

/** 渠道行工厂 */
function channel(overrides: Partial<NotificationChannelView> = {}): NotificationChannelView {
  return {
    provider: 'feishu',
    recipientAddress: 'ou_abc123',
    enabled: false,
    lastTestStatus: null,
    lastTestAt: null,
    source: 'user',
    createdAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

/** 归一偏好工厂（默认集 task_done + direct 开启，其余关闭） */
function prefs(overrides: Partial<NotificationCategoryPrefs> = {}): NotificationCategoryPrefs {
  const base = {} as NotificationCategoryPrefs;
  for (const key of NOTIFICATION_CATEGORY_KEYS) {
    base[key] = (['task_done', 'direct'] as readonly string[]).includes(key);
  }
  return { ...base, ...overrides };
}

/** 设置响应工厂 */
function settingsFixture(
  overrides: Partial<NotificationSettingsView> = {},
): NotificationSettingsView {
  return {
    channels: [channel()],
    prefs: {
      categories: prefs(),
      defaults: ['task_done', 'direct'],
      relevantScopes: { topics: 3, boards: 2, spaces: 1 },
    },
    platform: {
      providers: [FEISHU_OK],
      categories: [...NOTIFICATION_CATEGORY_KEYS],
      webBaseUrl: 'https://platform.example.com',
    },
    ...overrides,
  };
}

/** 当前 GET /notification-settings/me 应返回的数据（各用例改它） */
let settingsResponse: NotificationSettingsView;
/** 设置响应后按序消费的"下一次响应"（模拟写操作后刷新） */
let nextSettingsResponse: NotificationSettingsView | null = null;
/** 由用例注入的自定义处理器（写操作断言 / 失败注入）；返回 undefined 走默认 */
let handler: ((req: { method?: string; url?: string; data?: unknown }) => unknown) | undefined;

/** 记录所有请求（断言 method/url/body 契约） */
const requests: { method?: string; url?: string; data?: unknown }[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  requests.length = 0;
  handler = undefined;
  nextSettingsResponse = null;
  settingsResponse = settingsFixture();
  window.localStorage.clear();
  useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false });

  mockRequest.mockImplementation((req: { method?: string; url?: string; data?: unknown }) => {
    requests.push(req);
    const custom = handler?.(req);
    if (custom !== undefined) {
      // 形状判定：带 `response` 的对象 = HTTP 错误 ⇒ 必须**拒绝**（resolve 会被当成成功）
      if (custom && typeof custom === 'object' && 'response' in custom) {
        return Promise.reject(custom);
      }
      return Promise.resolve(custom);
    }
    if (req.method === 'GET' && req.url === '/notification-settings/me') {
      if (nextSettingsResponse) {
        const payload = nextSettingsResponse;
        nextSettingsResponse = null;
        return Promise.resolve(envelope(payload));
      }
      return Promise.resolve(envelope(settingsResponse));
    }
    if (req.method === 'GET' && req.url === '/users/me') {
      return Promise.resolve(envelope({ id: USER_ID, name: 'Owner', email: 'o@example.com' }));
    }
    return Promise.resolve(envelope({}));
  });
});

/** 渲染设置页（真 QueryClient，retry 关掉让失败路径快速落地） */
function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage />
      </QueryClientProvider>,
    ),
  };
}

/** 渲染并切到通知 tab（等首屏数据到位） */
async function renderNotificationsTab() {
  const view = renderPage();
  await userEvent.click(await screen.findByTestId('settings-tab-notifications'));
  await screen.findByTestId('notification-feishu-card');
  return view;
}

/** 取某个 toast 变体的最近一次调用参数 */
function lastToast(variant: 'error' | 'warning' | 'success') {
  const mock = mockToast[variant];
  return mock.mock.calls[mock.mock.calls.length - 1]?.[0] as
    | { title: string; description?: string }
    | undefined;
}

describe('设置页三 tab 壳（受控 Tabs）', () => {
  it('默认落在「资料」：语言卡 + 个人资料卡可见，密码卡与通知面不在树上', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Language' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Change Password' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('notification-feishu-card')).not.toBeInTheDocument();
  });

  it('切「安全」= 只剩密码卡；切回「资料」资料卡回来（tab 内容互斥）', async () => {
    renderPage();
    await userEvent.click(screen.getByTestId('settings-tab-security'));
    expect(await screen.findByRole('heading', { name: 'Change Password' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Profile' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('settings-tab-profile'));
    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Change Password' })).not.toBeInTheDocument();
  });

  it('aria 契约：tablist / tab / aria-selected 正确（键盘与读屏路径）', async () => {
    renderPage();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(screen.getByTestId('settings-tab-profile')).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByTestId('settings-tab-notifications'));
    expect(screen.getByTestId('settings-tab-notifications')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('settings-tab-profile')).toHaveAttribute('aria-selected', 'false');
  });

  it('既有资料卡行为零改动：改名仍打 PATCH /users/me 并写回 auth store', async () => {
    useAuthStore.setState({
      user: { id: USER_ID, name: 'Owner', email: 'o@example.com' } as never,
      isAuthenticated: true,
    });
    renderPage();
    const input = await screen.findByPlaceholderText('Your username');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    await userEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(requests).toContainEqual(
        expect.objectContaining({ method: 'PATCH', url: '/users/me', data: { name: 'Renamed' } }),
      );
    });
  });
});

describe('通知 tab · 引导层与渠道区', () => {
  it('无绑定：空态 + CTA + 升级横幅 + 偏好区常驻提示', async () => {
    settingsResponse = settingsFixture({ channels: [] });
    await renderNotificationsTab();

    expect(screen.getByText('No notification channel yet')).toBeInTheDocument();
    expect(screen.getByTestId('notification-upgrade-banner')).toBeInTheDocument();
    expect(screen.getByTestId('notification-prefs-no-channel-hint')).toBeInTheDocument();
    // 未绑定仍展示绑定卡（CTA 的目标就在下面，同屏导航）
    expect(screen.getByTestId('notification-channel-badge')).toHaveAttribute(
      'data-state',
      'unbound',
    );
  });

  it('空态 CTA 滚动到绑定卡（Element.scrollIntoView 被调用）', async () => {
    settingsResponse = settingsFixture({ channels: [] });
    const scrollIntoView = jest.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    await renderNotificationsTab();
    await userEvent.click(screen.getByText('Bind a channel'));
    expect(scrollIntoView).toHaveBeenCalled();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('关闭升级横幅 → 写入 localStorage 已读标记', async () => {
    settingsResponse = settingsFixture({ channels: [] });
    await renderNotificationsTab();
    await userEvent.click(screen.getByLabelText('Dismiss banner'));
    await waitFor(() => {
      expect(screen.queryByTestId('notification-upgrade-banner')).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(NOTIFICATION_NOTICE_STORAGE_KEYS.upgradeBanner)).toBe('1');
  });

  it('env_seed 行：一次性告知 + 关闭后写标记', async () => {
    settingsResponse = settingsFixture({
      channels: [
        channel({
          source: 'env_seed',
          lastTestStatus: NOTIFICATION_TEST_STATUS.seeded,
          enabled: true,
        }),
      ],
    });
    await renderNotificationsTab();
    const notice = screen.getByTestId('notification-env-seed-notice');
    expect(
      within(notice).getByText('This channel came from the deployment config'),
    ).toBeInTheDocument();
    await userEvent.click(within(notice).getByText('Got it'));
    await waitFor(() => {
      expect(screen.queryByTestId('notification-env-seed-notice')).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(NOTIFICATION_NOTICE_STORAGE_KEYS.envSeedNotice)).toBe('1');
  });

  it('徽标四态 + seeded 特化（表驱动）', async () => {
    const cases: {
      status: NotificationChannelView['lastTestStatus'];
      state: string;
      label: string;
    }[] = [
      { status: null, state: 'unverified', label: 'Not verified' },
      { status: NOTIFICATION_TEST_STATUS.failed, state: 'failed', label: 'Verification failed' },
      {
        status: NOTIFICATION_TEST_STATUS.seeded,
        state: 'seeded',
        label: 'Imported · unverified',
      },
      { status: NOTIFICATION_TEST_STATUS.ok, state: 'verified', label: 'Verified' },
    ];

    for (const testCase of cases) {
      settingsResponse = settingsFixture({
        channels: [channel({ lastTestStatus: testCase.status })],
      });
      const view = await renderNotificationsTab();
      const badge = screen.getByTestId('notification-channel-badge');
      expect(badge).toHaveAttribute('data-state', testCase.state);
      expect(badge).toHaveTextContent(testCase.label);
      view.unmount();
    }
  });

  it('状态条：`lastTestStatus !== ok` 时出现，seeded 用特化文案', async () => {
    settingsResponse = settingsFixture({ channels: [channel({ lastTestStatus: null })] });
    const view = await renderNotificationsTab();
    expect(screen.getByTestId('notification-channel-status-bar')).toHaveTextContent(
      'One step left: send a test message to finish verification.',
    );
    view.unmount();

    settingsResponse = settingsFixture({
      channels: [channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.seeded, source: 'env_seed' })],
    });
    await renderNotificationsTab();
    expect(screen.getByTestId('notification-channel-status-bar')).toHaveTextContent(
      'Imported from the deployment config',
    );
  });

  it('已验证 + ok 时状态条消失（不制造多余噪音）', async () => {
    settingsResponse = settingsFixture({
      channels: [channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.ok, enabled: true })],
    });
    await renderNotificationsTab();
    expect(screen.queryByTestId('notification-channel-status-bar')).not.toBeInTheDocument();
  });

  it('configured=false：卡顶提示 + 地址表单整体禁用', async () => {
    settingsResponse = settingsFixture({
      platform: {
        providers: [{ key: 'feishu', configured: false }],
        categories: [...NOTIFICATION_CATEGORY_KEYS],
        webBaseUrl: null,
      },
    });
    await renderNotificationsTab();
    expect(screen.getByTestId('notification-provider-unconfigured')).toHaveTextContent(
      'This deployment has no Feishu app configured',
    );
    expect(screen.getByLabelText('Feishu open_id')).toBeDisabled();
    expect(screen.getByText('Save')).toBeDisabled();
    expect(screen.getByText('Send test message')).toBeDisabled();
  });

  it('更多渠道折进 details（钉钉/企微/Slack 占位 + aria-disabled）', async () => {
    await renderNotificationsTab();
    const details = screen.getByTestId('notification-more-channels');
    expect(details.tagName.toLowerCase()).toBe('details');
    for (const key of ['dingtalk', 'wecom', 'slack']) {
      expect(screen.getByTestId(`notification-placeholder-${key}`)).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
  });
});

describe('通知 tab · open_id 与渠道写操作', () => {
  it('格式预检：非法值不发请求 + 保存禁用 + 错误文案出现', async () => {
    await renderNotificationsTab();
    const input = screen.getByLabelText('Feishu open_id');
    fireEvent.change(input, { target: { value: 'not-an-open-id' } });
    fireEvent.blur(input);

    expect(screen.getByText(/Invalid open_id/)).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeDisabled();
    await userEvent.click(screen.getByText('Save'));
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('合法值保存 → PUT 载荷是 trim 后的 open_id，且成功后 toast 提示需重新验证', async () => {
    await renderNotificationsTab();
    const input = screen.getByLabelText('Feishu open_id');
    fireEvent.change(input, { target: { value: '  ou_new123  ' } });

    nextSettingsResponse = settingsFixture({
      channels: [channel({ recipientAddress: 'ou_new123' })],
    });
    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: 'PUT',
          url: '/notification-settings/me/channels/feishu',
          data: { recipientOpenId: 'ou_new123' },
        }),
      );
    });
    await waitFor(() => expect(lastToast('success')?.title).toBe('Channel saved'));
  });

  it('地址未保存时"发送测试消息"禁用（否则测的是旧地址）', async () => {
    await renderNotificationsTab();
    expect(screen.getByText('Send test message')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Feishu open_id'), {
      target: { value: 'ou_changed' },
    });
    expect(screen.getByText('Send test message')).toBeDisabled();
  });

  it('未绑定：发送测试消息禁用（没有地址可测，后端也 404）', async () => {
    settingsResponse = settingsFixture({ channels: [] });
    await renderNotificationsTab();
    expect(screen.getByText('Send test message')).toBeDisabled();
  });

  it('测试成功（delivered=1）→ 刷新后徽标翻「已验证」+ 成功 toast', async () => {
    settingsResponse = settingsFixture({
      channels: [channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.seeded, source: 'env_seed' })],
    });
    await renderNotificationsTab();
    expect(screen.getByTestId('notification-channel-badge')).toHaveAttribute(
      'data-state',
      'seeded',
    );

    nextSettingsResponse = settingsFixture({
      channels: [channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.ok, enabled: true })],
    });
    handler = (req) =>
      req.method === 'POST' && req.url?.endsWith('/test')
        ? envelope({ delivered: 1, channels: ['feishu'] })
        : undefined;

    await userEvent.click(screen.getByText('Send test message'));

    await waitFor(() => {
      expect(screen.getByTestId('notification-channel-badge')).toHaveAttribute(
        'data-state',
        'verified',
      );
    });
    expect(lastToast('success')?.title).toBe('Test message sent');
    expect(requests).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        url: '/notification-settings/me/channels/feishu/test',
      }),
    );
  });

  it('测试降级（delivered=0）：运维态 reason → "联系管理员"文案族', async () => {
    await renderNotificationsTab();
    handler = (req) =>
      req.method === 'POST' && req.url?.endsWith('/test')
        ? envelope({ delivered: 0, channels: [], reason: 'no_provider' })
        : undefined;

    await userEvent.click(screen.getByText('Send test message'));
    await waitFor(() => expect(lastToast('warning')?.title).toBe('No Feishu app configured'));
    expect(lastToast('warning')?.description).toContain('administrator');
  });

  it('测试降级（delivery_failed）→ 引导检查 open_id', async () => {
    await renderNotificationsTab();
    handler = (req) =>
      req.method === 'POST' && req.url?.endsWith('/test')
        ? envelope({ delivered: 0, channels: [], reason: 'delivery_failed' })
        : undefined;

    await userEvent.click(screen.getByText('Send test message'));
    await waitFor(() => expect(lastToast('warning')?.title).toBe('Delivery failed'));
    expect(lastToast('warning')?.description).toContain('open_id');
  });

  it('409 地址被他人占用 → 人话文案（不是后端英文长文）', async () => {
    await renderNotificationsTab();
    handler = (req) =>
      req.method === 'PUT'
        ? httpError(
            409,
            'This Feishu account is already bound to another platform account. If this is you, use the original account — or ask an administrator to unbind it.',
          )
        : undefined;

    fireEvent.change(screen.getByLabelText('Feishu open_id'), { target: { value: 'ou_other' } });
    await userEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(lastToast('error')?.title).toBe('That Feishu account is bound to another account'),
    );
    expect(lastToast('error')?.description).toContain('use the original account');
  });

  it('409 自身重复绑定 → 与"地址占用"不同的文案', async () => {
    await renderNotificationsTab();
    handler = (req) =>
      req.method === 'PUT'
        ? httpError(
            409,
            'This channel already has a binding for your account — refresh and try again.',
          )
        : undefined;

    fireEvent.change(screen.getByLabelText('Feishu open_id'), { target: { value: 'ou_other' } });
    await userEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(lastToast('error')?.title).toBe("Couldn't save"));
    expect(lastToast('error')?.description).toContain('already has a binding');
  });

  it('400 未验证置启用 → 引导先发测试消息', async () => {
    settingsResponse = settingsFixture({
      channels: [channel({ lastTestStatus: null, enabled: false })],
    });
    await renderNotificationsTab();
    handler = () =>
      httpError(
        400,
        'This address has not been verified for this channel yet: send a test message first',
      );

    // 未验证时开关本身就是禁用的（把必然 400 的操作挡在前面）
    expect(screen.getByTestId('notification-channel-switch')).toBeDisabled();
  });

  it('429 测试限流 → 用 data.retryAfterSeconds 插值秒数', async () => {
    await renderNotificationsTab();
    handler = (req) =>
      req.method === 'POST' && req.url?.endsWith('/test')
        ? httpError(429, 'Too many requests', { retryAfterSeconds: 42 })
        : undefined;

    await userEvent.click(screen.getByText('Send test message'));
    await waitFor(() => expect(lastToast('error')?.title).toBe('Too many attempts'));
    expect(lastToast('error')?.description).toBe('Please try again in 42 seconds.');
  });

  it('渠道开关 optimistic 更新 + 失败回滚（服务端拒绝时界面回到原状）', async () => {
    settingsResponse = settingsFixture({
      channels: [channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.ok, enabled: true })],
    });
    await renderNotificationsTab();
    const control = screen.getByTestId('notification-channel-switch');
    expect(control).toHaveAttribute('aria-checked', 'true');

    handler = (req) =>
      req.method === 'PUT'
        ? httpError(400, 'This address has not been verified for this channel yet')
        : undefined;
    await userEvent.click(control);

    await waitFor(() => expect(lastToast('error')?.title).toBe('Not verified yet'));
    // 回滚：快照恢复成"用户没点过"的启用态
    await waitFor(() =>
      expect(screen.getByTestId('notification-channel-switch')).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
  });

  it('静音（enabled=false）走纯状态更新：PUT 不带 recipientOpenId', async () => {
    settingsResponse = settingsFixture({
      channels: [channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.ok, enabled: true })],
    });
    await renderNotificationsTab();
    nextSettingsResponse = settingsFixture({
      channels: [channel({ lastTestStatus: NOTIFICATION_TEST_STATUS.ok, enabled: false })],
    });
    await userEvent.click(screen.getByTestId('notification-channel-switch'));

    await waitFor(() => {
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: 'PUT',
          url: '/notification-settings/me/channels/feishu',
          data: { enabled: false },
        }),
      );
    });
    expect(lastToast('success')?.title).toBe('Notifications muted');
  });

  it('解绑：确认文案写"重绑同一地址保留验证态"，确认后打 DELETE', async () => {
    await renderNotificationsTab();
    mockConfirm.mockResolvedValueOnce(true);
    nextSettingsResponse = settingsFixture({ channels: [] });
    await userEvent.click(screen.getByText('Unbind'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    const confirmOptions = mockConfirm.mock.calls[0][0];
    expect(confirmOptions.title).toBe('Unbind Feishu notifications?');
    expect(confirmOptions.description).toContain('keeps its verification state');
    expect(confirmOptions.confirmVariant).toBe('danger');

    await waitFor(() => {
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: 'DELETE',
          url: '/notification-settings/me/channels/feishu',
        }),
      );
    });
    expect(lastToast('success')?.title).toBe('Feishu notifications unbound');
  });

  it('解绑取消 → 不发请求', async () => {
    await renderNotificationsTab();
    mockConfirm.mockResolvedValueOnce(false);
    await userEvent.click(screen.getByText('Unbind'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });
});

describe('通知 tab · 偏好区（即改即存）', () => {
  it('10 类按 4 组渲染，组标题齐备', async () => {
    await renderNotificationsTab();
    for (const group of ['tasks', 'topics', 'docs', 'direct']) {
      expect(screen.getByTestId(`notification-prefs-group-${group}`)).toBeInTheDocument();
    }
    for (const key of NOTIFICATION_CATEGORY_KEYS) {
      expect(screen.getByTestId(`notification-pref-row-${key}`)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('switch')).toHaveLength(NOTIFICATION_CATEGORY_KEYS.length + 1);
  });

  it('打开一个类别 → 稀疏 PUT 载荷 + 行内「已保存」微反馈', async () => {
    await renderNotificationsTab();
    const row = screen.getByTestId('notification-pref-row-doc_created');
    nextSettingsResponse = null;

    await userEvent.click(within(row).getByRole('switch'));

    await waitFor(() => {
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: 'PUT',
          url: '/notification-settings/me/prefs',
          data: { notificationCategories: { doc_created: true } },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('notification-pref-saved-doc_created')).toBeInTheDocument();
    });
  });

  it('即改即存失败 → 回滚开关 + toast（不留下"以为改了"的假象）', async () => {
    await renderNotificationsTab();
    const row = screen.getByTestId('notification-pref-row-doc_created');
    const control = within(row).getByRole('switch');
    expect(control).toHaveAttribute('aria-checked', 'false');

    handler = (req) =>
      req.method === 'PUT' && req.url === '/notification-settings/me/prefs'
        ? httpError(
            400,
            'notificationCategories must be an object whose keys are notification categories',
          )
        : undefined;

    await userEvent.click(control);
    await waitFor(() => expect(lastToast('error')?.title).toBe("Couldn't save"));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('notification-pref-row-doc_created')).getByRole('switch'),
      ).toHaveAttribute('aria-checked', 'false'),
    );
  });

  it('平台未启用的类别：开关 disabled + 「平台未启用」徽标', async () => {
    settingsResponse = settingsFixture({
      platform: {
        providers: [FEISHU_OK],
        categories: NOTIFICATION_CATEGORY_KEYS.filter((k) => k !== 'doc_deleted'),
        webBaseUrl: null,
      },
    });
    await renderNotificationsTab();
    const row = screen.getByTestId('notification-pref-row-doc_deleted');
    expect(within(row).getByRole('switch')).toBeDisabled();
    expect(screen.getByTestId('notification-pref-platform-off-doc_deleted')).toHaveTextContent(
      'Platform off',
    );
    // 已启用的行不受影响
    expect(
      within(screen.getByTestId('notification-pref-row-doc_updated')).getByRole('switch'),
    ).toBeEnabled();
  });

  it('relevantScopes.topics === 0 → 只有 topic 行出灰字提示', async () => {
    settingsResponse = settingsFixture();
    settingsResponse.prefs.relevantScopes = { topics: 0, boards: 2, spaces: 1 };
    await renderNotificationsTab();

    expect(screen.getByTestId('notification-pref-topic-scope-hint')).toHaveTextContent(
      'You are currently in 0 topics',
    );
    // task/doc 行**不得**出现该提示（有 creator/assignee 旁路，灰字会撒谎）
    const taskRowText = screen.getByTestId('notification-pref-row-task_done').textContent ?? '';
    const docRowText = screen.getByTestId('notification-pref-row-doc_created').textContent ?? '';
    expect(taskRowText).not.toContain('0 topics');
    expect(docRowText).not.toContain('0 topics');
  });

  it('topics > 0 时不出灰字（只有真的为零才提示）', async () => {
    await renderNotificationsTab();
    expect(screen.queryByTestId('notification-pref-topic-scope-hint')).not.toBeInTheDocument();
  });

  it('恢复默认：取消不发请求', async () => {
    await renderNotificationsTab();
    mockConfirm.mockResolvedValueOnce(false);
    await userEvent.click(screen.getByText('Reset to default'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(
      requests.filter((r) => r.method === 'DELETE' && r.url === '/notification-settings/me/prefs'),
    ).toHaveLength(0);
  });

  it('恢复默认：确认 → DELETE /me/prefs 并按响应更新界面', async () => {
    settingsResponse = settingsFixture({
      prefs: {
        categories: prefs({ doc_created: true }),
        defaults: [],
        relevantScopes: { topics: 1, boards: 1, spaces: 1 },
      },
    });
    await renderNotificationsTab();
    expect(
      within(screen.getByTestId('notification-pref-row-doc_created')).getByRole('switch'),
    ).toHaveAttribute('aria-checked', 'true');

    mockConfirm.mockResolvedValueOnce(true);
    handler = (req) =>
      req.method === 'DELETE' && req.url === '/notification-settings/me/prefs'
        ? envelope(prefs())
        : undefined;

    await userEvent.click(screen.getByText('Reset to default'));

    await waitFor(() => {
      expect(requests).toContainEqual(
        expect.objectContaining({ method: 'DELETE', url: '/notification-settings/me/prefs' }),
      );
    });
    await waitFor(() =>
      expect(
        within(screen.getByTestId('notification-pref-row-doc_created')).getByRole('switch'),
      ).toHaveAttribute('aria-checked', 'false'),
    );
    expect(lastToast('success')?.title).toBe('Notification preferences reset');
  });
});

describe('通知 tab · 加载失败', () => {
  it('GET 失败 → 错误态 + 重试按钮重新请求', async () => {
    renderPage();
    handler = (req) =>
      req.method === 'GET' && req.url === '/notification-settings/me'
        ? httpError(500, 'boom')
        : undefined;

    await userEvent.click(screen.getByTestId('settings-tab-notifications'));
    expect(await screen.findByTestId('notification-settings-error')).toHaveTextContent(
      "Couldn't load your notification settings",
    );

    handler = undefined;
    settingsResponse = settingsFixture();
    await userEvent.click(screen.getByText('Retry'));
    expect(await screen.findByTestId('notification-feishu-card')).toBeInTheDocument();
  });
});

/** A cached empty channel still owns an editable binding card after a failed refresh. */
it('keeps an empty-channel address draft across refresh failure and successful retry', async () => {
  settingsResponse = settingsFixture({ channels: [] });
  const { queryClient } = renderPage();
  fireEvent.click(screen.getByTestId('settings-tab-notifications'));
  const input = await screen.findByPlaceholderText(
    enMessages.settings.notifications.channel.openIdPlaceholder,
  );
  fireEvent.change(input, { target: { value: 'ou_unsaved_draft' } });
  handler = (req) =>
    req.method === 'GET' && req.url === '/notification-settings/me'
      ? httpError(503, 'internal detail')
      : undefined;
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ['notification-settings', 'me'] });
  });
  expect(await screen.findByRole('status')).toBeInTheDocument();
  expect(screen.getByDisplayValue('ou_unsaved_draft')).toBeInTheDocument();
  handler = undefined;
  fireEvent.click(screen.getByRole('button', { name: enMessages.common.retry }));
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.getByDisplayValue('ou_unsaved_draft')).toBeInTheDocument();
});

it('profile save failure keeps the edited name and can retry without leaking a 5xx message', async () => {
  useAuthStore.setState({
    user: { id: USER_ID, name: 'Owner', email: 'o@example.com' } as never,
    isAuthenticated: true,
  });
  handler = (req) =>
    req.method === 'PATCH' && req.url === '/users/me' ? httpError(500, 'internal SQL') : undefined;
  renderPage();
  fireEvent.change(await screen.findByPlaceholderText('Your username'), {
    target: { value: 'Keep this name' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(mockToast.error).toHaveBeenCalledWith({ title: enMessages.settings.profile.saveFailed }),
  );
  expect(screen.getByDisplayValue('Keep this name')).toBeInTheDocument();
  handler = undefined;
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(
      requests.filter((req) => req.method === 'PATCH' && req.url === '/users/me'),
    ).toHaveLength(2),
  );
  expect(mockToast.error).toHaveBeenCalledTimes(1);
});
