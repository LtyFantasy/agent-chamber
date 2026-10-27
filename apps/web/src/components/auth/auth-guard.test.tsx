/**
 * auth-guard.test.tsx — 未登录兜底跳转契约（plan §8 S5：登录回跳）
 *
 * 覆盖：AuthGuard 把「当前 pathname + search」编码进 `?next=` 一并跳登录页，使通知
 * 深链（如 /tasks/abc?tab=desc）登录后能回到原页；已在 /login 时不自指 next=/login。
 * 同源白名单本身（`?next=` 是攻击者可控参数）的边界矩阵在 lib/login-redirect.test.ts。
 */

import { render, screen, waitFor } from '@testing-library/react';
import { AuthGuard } from './auth-guard';

const mockPush = jest.fn();
const mockRehydrate = jest.fn();
/** 受控登录态（useAuthStore() 的返回值） */
let mockAuthState: { isAuthenticated: boolean; accessToken: string | null } = {
  isAuthenticated: false,
  accessToken: null,
};

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/stores/auth.store', () => {
  // jest.mock 工厂先于模块体执行：persist 用 getter 惰性取 mock，直接引用会命中 TDZ
  const useAuthStore = jest.fn(() => mockAuthState);
  Object.defineProperty(useAuthStore, 'persist', {
    get: () => ({ rehydrate: mockRehydrate }),
  });
  return { useAuthStore };
});

describe('AuthGuard 未登录跳转', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRehydrate.mockResolvedValue(undefined);
    mockAuthState = { isAuthenticated: false, accessToken: null };
    window.history.pushState({}, '', '/');
  });

  it('带上当前 pathname + search 跳登录页（深链可回跳）', async () => {
    window.history.pushState({}, '', '/tasks/abc?tab=desc');
    render(
      <AuthGuard>
        <div>secret</div>
      </AuthGuard>,
    );

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/login?next=%2Ftasks%2Fabc%3Ftab%3Ddesc'),
    );
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('fragment 一并带上（与消费侧放行的 #anchor 对称，锚点不丢）', async () => {
    window.history.pushState({}, '', '/tasks/abc?tab=desc#comment-2');
    render(
      <AuthGuard>
        <div>secret</div>
      </AuthGuard>,
    );

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent('/tasks/abc?tab=desc#comment-2')}`,
      ),
    );
  });

  it('已在登录页：只跳裸 /login（不自指 next=/login）', async () => {
    window.history.pushState({}, '', '/login');
    render(
      <AuthGuard>
        <div>secret</div>
      </AuthGuard>,
    );

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/login'));
  });

  it('已登录：渲染 children 且不跳转', async () => {
    mockAuthState = { isAuthenticated: true, accessToken: 'token' };
    render(
      <AuthGuard>
        <div>secret</div>
      </AuthGuard>,
    );

    expect(await screen.findByText('secret')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
