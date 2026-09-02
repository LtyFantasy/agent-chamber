import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@/types';
import { Api, setAuthHooks } from '@/lib/api';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
  setUser: (user: User) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,

      login: async (email: string, password: string) => {
        set({ isLoading: true });
        try {
          const res = await Api.auth.login({ email, password });
          set({
            user: res.user,
            accessToken: res.accessToken,
            refreshToken: res.refreshToken,
            isAuthenticated: true,
          });
        } finally {
          set({ isLoading: false });
        }
      },

      register: async (email: string, password: string, name: string) => {
        set({ isLoading: true });
        try {
          const res = await Api.auth.register({ email, password, name });
          set({
            user: res.user,
            accessToken: res.accessToken,
            refreshToken: res.refreshToken,
            isAuthenticated: true,
          });
        } finally {
          set({ isLoading: false });
        }
      },

      logout: () => {
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
        });
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
      },

      setUser: (user: User) => set({ user, isAuthenticated: true }),
      setTokens: (accessToken: string, refreshToken: string) => set({ accessToken, refreshToken }),
    }),
    {
      name: 'auth-storage',
      skipHydration: true,
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);

// 认证钩子注入 api 层（review-0831 任务 04e8d744 拆环：依赖方向 store→api 单向，
// 消除 api.ts ↔ auth.store.ts 循环依赖）。注入时机：(main) 布局 auth-guard.tsx
// import 本 store → 模块先于 (main) 下全部页面求值；非 (main) 页面（skills 等）
// 不 import 本 store → api 保持默认空钩子（getToken→null），与现状等价无回归。
// getToken/onUnauthorized 均为运行时求值（闭包引用 getState），store 状态变更即时生效。
setAuthHooks({
  getToken: () => useAuthStore.getState().accessToken,
  onUnauthorized: () => useAuthStore.getState().logout,
});
