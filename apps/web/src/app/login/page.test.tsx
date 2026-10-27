import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from './page';

const mockPush = jest.fn();
const mockLogin = jest.fn();
/** 受控 query 串（`?` 之后部分）：由用例设置以驱动 `useSearchParams().get('next')` */
let mockSearchParamsString = '';

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
}));

jest.mock('next/link', () => {
  return function MockLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});

jest.mock('@/stores/auth.store', () => ({
  useAuthStore: () => ({
    login: mockLogin,
    isLoading: false,
  }),
}));

jest.mock('next-intl', () => {
  /** auth 命名空间的英语文案快照（同 en.json） */
  const messages: Record<string, string> = {
    loginTitle: 'Login',
    loginDescription: 'Enter your credentials to continue',
    email: 'Email',
    emailPlaceholder: 'name@example.com',
    password: 'Password',
    passwordPlaceholder: '••••••••',
    loginButton: 'Login',
    loginFailed: 'Login failed',
    loginErrorInvalidCredentials:
      'Incorrect email or password. If your account has been deactivated, please contact an administrator.',
    loginErrorAccountDisabled:
      'This account has been deactivated. Please contact an administrator.',
    loginErrorRateLimited: 'Too many login attempts. Please wait a moment and try again.',
    viewAgentGuide: 'View Agent Integration Guide',
  };
  return {
    useTranslations: (_ns?: string) => (key: string) => {
      return messages[key] ?? key;
    },
    // LocaleSwitcher 依赖：固定英文 locale（语言切换交互不在本测试范围）
    useLocale: () => 'en',
    NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

describe('LoginPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockSearchParamsString = '';
  });

  it('renders login form', () => {
    render(<LoginPage />);
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
  });

  it('allows typing email and password', () => {
    render(<LoginPage />);
    const emailInput = screen.getByLabelText('Email') as HTMLInputElement;
    const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;

    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });

    expect(emailInput.value).toBe('test@example.com');
    expect(passwordInput.value).toBe('password123');
  });

  it('submits form with email and password', async () => {
    mockLogin.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('test@example.com', 'password123');
    });
    expect(mockPush).toHaveBeenCalledWith('/');
  });

  // ── `?next=` 回跳（通知深链的最后一厘米，plan §8 S5）────────────────────────
  // 发送侧（api.ts 401 / AuthGuard）写 next，消费侧在本页 —— 只测消费侧与安全边界；
  // 同源白名单本身的行/列矩阵在 lib/login-redirect.test.ts（纯函数层）。
  describe('登录成功后按 ?next= 回跳', () => {
    /** 填表并提交（成功路径） */
    async function submitLogin() {
      mockLogin.mockResolvedValueOnce(undefined);
      render(<LoginPage />);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: 'Login' }));
      await waitFor(() => expect(mockLogin).toHaveBeenCalled());
      return waitFor(() => expect(mockPush).toHaveBeenCalled());
    }

    it('合法站点相对路径：回跳该路径（含 query 原样保留）', async () => {
      mockSearchParamsString = 'next=%2Ftasks%2Fabc%3Ftab%3Ddesc';
      await submitLogin();
      expect(mockPush).toHaveBeenCalledWith('/tasks/abc?tab=desc');
    });

    it('缺失 next：回首页（既有行为不变）', async () => {
      mockSearchParamsString = '';
      await submitLogin();
      expect(mockPush).toHaveBeenCalledWith('/');
    });

    it('协议相对 next（//evil.com）：拒绝并回首页', async () => {
      mockSearchParamsString = 'next=%2F%2Fevil.com';
      await submitLogin();
      expect(mockPush).toHaveBeenCalledWith('/');
    });

    it('绝对 URL next：拒绝并回首页', async () => {
      mockSearchParamsString = `next=${encodeURIComponent('https://evil.com')}`;
      await submitLogin();
      expect(mockPush).toHaveBeenCalledWith('/');
    });

    it('反斜杠变体 next（/\\evil.com）：拒绝并回首页', async () => {
      mockSearchParamsString = `next=${encodeURIComponent('/\\evil.com')}`;
      await submitLogin();
      expect(mockPush).toHaveBeenCalledWith('/');
    });
  });

  // ── 登录失败文案：code → i18n key 映射（卡 240c74d6）─────────────────────────
  // 旧写法把 `err.message` 直接上屏：401 时是后端英文 'Invalid credentials'，断网时是
  // axios 的 'Network Error'——两者都不告诉用户下一步，且中文界面夹生。现在按
  // (status, code) 映射本地文案（单源 = lib/error-message.ts 的 loginErrorKeyOf）。
  describe('登录失败文案映射', () => {
    /** 填表并提交一次必然失败的登录 */
    function submitFailure(rejected: unknown) {
      mockLogin.mockRejectedValueOnce(rejected);
      render(<LoginPage />);
      fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrongpassword' } });
      fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    }

    /** axios 风格失败响应（code 用后端 ErrorCode 线值） */
    const httpError = (status: number, code: number, message: string) => ({
      response: { status, data: { code, message } },
    });

    it('401 + 1008（密码错，与"账号已软删"同码）→ 邮箱或密码错误（含停用兜底提示）', async () => {
      submitFailure(httpError(401, 1008, 'Invalid credentials'));
      expect(
        await screen.findByText(
          'Incorrect email or password. If your account has been deactivated, please contact an administrator.',
        ),
      ).toBeInTheDocument();
      // 服务端英文原文不再上屏
      expect(screen.queryByText('Invalid credentials')).not.toBeInTheDocument();
    });

    it('401 + 1001（账号停用）→ 账号已停用', async () => {
      submitFailure(httpError(401, 1001, 'Account is disabled'));
      expect(
        await screen.findByText(
          'This account has been deactivated. Please contact an administrator.',
        ),
      ).toBeInTheDocument();
    });

    it('429（登录限流）→ 提示稍后重试', async () => {
      submitFailure(httpError(429, 429, 'Too Many Requests'));
      expect(
        await screen.findByText('Too many login attempts. Please wait a moment and try again.'),
      ).toBeInTheDocument();
    });

    it('无 response（断网）→ 通用失败文案，不出现 axios 英文原文', async () => {
      submitFailure(new Error('Network Error'));
      expect(await screen.findByText('Login failed')).toBeInTheDocument();
      expect(screen.queryByText('Network Error')).not.toBeInTheDocument();
    });
  });

  it('prefills email from last successful login', () => {
    localStorage.setItem('auth:last-email', 'saved@example.com');
    render(<LoginPage />);
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('saved@example.com');
  });

  it('remembers email after successful login', async () => {
    mockLogin.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => {
      expect(localStorage.getItem('auth:last-email')).toBe('test@example.com');
    });
  });
});
