import { create } from 'zustand';

/**
 * 全局通知 store（命令式壳 ↔ 声明式组件的契约层）。
 *
 * 双层架构（见 plan「Web 全局 Alert/Notification 基础组件」）：
 * - 命令式壳（lib/notify.ts 的 confirm/toast）调用本 store 的 action；
 * - 声明式底层（components/ui/notification-host.tsx）订阅 state 渲染
 *   AlertDialog（取 alerts 队列首个）+ Toaster（toasts 列表）。
 *
 * 队列语义：alerts 同时只展示一个（FIFO 排队），toasts 堆叠展示（上限 5 丢最旧）。
 * 不 persist（弹窗/通知是瞬态 UI 状态，会话刷新即消失，与 auth.store 的
 * persist 形成对比）。
 */

/** 确认框展示选项（命令式 confirm 壳与声明式 AlertDialog 的契约） */
export interface AlertOptions {
  /** 标题（调用方传入 i18n 文案；壳层不依赖 next-intl） */
  title: string;
  /** 描述正文（可选） */
  description?: string;
  /** 确认按钮文案（调用方传 i18n 文案） */
  confirmText: string;
  /** 取消按钮文案（调用方传 i18n 文案） */
  cancelText: string;
  /** 确认按钮视觉变体：danger → destructive 红钮（删除/破坏性操作） */
  confirmVariant?: 'default' | 'danger';
}

/** toast 展示选项（不含运行时 id） */
export interface ToastOptions {
  /** 标题（必填；调用方传 i18n 文案） */
  title: string;
  /** 描述正文（可选） */
  description?: string;
  /** 语义变体：success/error/info/warning → 左侧色条 */
  variant?: 'success' | 'error' | 'info' | 'warning';
  /** 自动消失时长（ms；缺省 4000） */
  duration?: number;
}

/** toast 队列项（含运行时 id） */
export interface ToastItem extends ToastOptions {
  id: string;
}

interface NotificationState {
  /** 确认框队列：同时只展示第一个，resolve 后出队展示下一个 */
  alerts: AlertOptions[];
  /** toast 列表（堆叠，上限 5 丢最旧） */
  toasts: ToastItem[];
  /** 命令式 confirm：入队并返回 Promise<boolean>（确认 true / 取消·遮罩·Esc false） */
  requestConfirm: (opts: AlertOptions) => Promise<boolean>;
  /** 出队并回执当前弹窗的 Promise（先出队再 resolve——队列推进先于调用方续行） */
  resolveAlert: (result: boolean) => void;
  /** 入队 toast（自动分配 id；超上限丢最旧） */
  pushToast: (opts: ToastOptions) => void;
  /** 按 id 移除 toast（手动关闭/自动消失共用） */
  dismissToast: (id: string) => void;
}

/** toast 上限（超出丢最旧，防止无限堆叠遮挡页面） */
const TOAST_MAX_COUNT = 5;

/**
 * 待回执的确认框 resolver 队列（模块级，不进 zustand state：
 * resolver 是瞬态回执函数，持久化/序列化无意义，且 state 里存函数
 * 会破坏「state 可序列化」的直觉）。
 * 下标与 alerts 队列一一对应：第 i 个弹窗的 Promise 由第 i 个 resolver 回执。
 */
const alertResolvers: Array<(result: boolean) => void> = [];

/** toast id 自增兜底计数器（jsdom 等环境可能没有 crypto.randomUUID） */
let fallbackToastId = 0;

/**
 * 生成 toast 运行时 id：优先 crypto.randomUUID（浏览器标准），
 * 不可用时降级为时间戳 + 自增计数拼接（保证队列内唯一）。
 */
function generateToastId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackToastId += 1;
  return `toast-${Date.now()}-${fallbackToastId}`;
}

export const useNotificationStore = create<NotificationState>()((set) => ({
  alerts: [],
  toasts: [],

  requestConfirm: (opts) =>
    new Promise<boolean>((resolve) => {
      alertResolvers.push(resolve);
      set((state) => ({ alerts: [...state.alerts, opts] }));
    }),

  resolveAlert: (result) => {
    // 先出队再 resolve：队列推进在 Promise 回执之前完成，调用方续行时
    // 读到的一定是最新队列（防渲染竞态，见 plan §1）
    const resolver = alertResolvers.shift();
    set((state) => ({ alerts: state.alerts.slice(1) }));
    resolver?.(result);
  },

  pushToast: (opts) => {
    set((state) => ({
      // slice(-TOAST_MAX_COUNT)：超上限时从头丢最旧（保留最新）
      toasts: [...state.toasts, { ...opts, id: generateToastId() }].slice(-TOAST_MAX_COUNT),
    }));
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));
