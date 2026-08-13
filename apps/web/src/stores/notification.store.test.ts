/**
 * notification.store.test.ts — 通知 store 队列语义契约测试（jsdom）。
 *
 * 覆盖：
 * ① confirm 队列：同时 requestConfirm 两个 → alerts 只展示语义（第一个在队首），
 *    resolve 第一个后第二个上屏；resolve true/false 原样回执 Promise；
 * ② resolve 先出队再回执（resolve 后队列已推进——调用方续行读到最新队列）；
 * ③ toast 上限 5 丢最旧；dismissToast 按 id 移除。
 */

import { useNotificationStore, type AlertOptions } from './notification.store';

function makeAlert(overrides: Partial<AlertOptions> = {}) {
  return {
    title: 'Delete message',
    description: 'This action is irreversible.',
    confirmText: 'Delete',
    cancelText: 'Cancel',
    confirmVariant: 'danger' as const,
    ...overrides,
  };
}

describe('notification.store 队列语义', () => {
  beforeEach(() => {
    // 重置 store（zustand 无内置 reset，直接 setState 清空）
    useNotificationStore.setState({ alerts: [], toasts: [] });
  });

  it('requestConfirm 入队：alerts 追加，队首即第一个弹窗', async () => {
    const p1 = useNotificationStore.getState().requestConfirm(makeAlert({ title: 'A' }));
    const p2 = useNotificationStore.getState().requestConfirm(makeAlert({ title: 'B' }));

    const alerts = useNotificationStore.getState().alerts;
    expect(alerts).toHaveLength(2);
    expect(alerts[0].title).toBe('A');
    expect(alerts[1].title).toBe('B');

    // resolve 第一个：true 原样回执，且出队后第二个（B）成为队首
    useNotificationStore.getState().resolveAlert(true);
    await expect(p1).resolves.toBe(true);
    expect(useNotificationStore.getState().alerts).toHaveLength(1);
    expect(useNotificationStore.getState().alerts[0].title).toBe('B');

    // resolve 第二个：false 原样回执，队列清空
    useNotificationStore.getState().resolveAlert(false);
    await expect(p2).resolves.toBe(false);
    expect(useNotificationStore.getState().alerts).toHaveLength(0);
  });

  it('resolveAlert 先出队再回执：resolve 完成时队列已推进（防渲染竞态）', async () => {
    const p1 = useNotificationStore.getState().requestConfirm(makeAlert({ title: 'A' }));
    void useNotificationStore.getState().requestConfirm(makeAlert({ title: 'B' }));

    // resolve 调用本身是同步的：回执 Promise 之前，队列必须已经出队
    useNotificationStore.getState().resolveAlert(true);
    expect(useNotificationStore.getState().alerts).toHaveLength(1);
    expect(useNotificationStore.getState().alerts[0].title).toBe('B');
    await expect(p1).resolves.toBe(true);
  });

  it('alerts 为空时 resolveAlert 是幂等 no-op（不抛错、状态不变）', () => {
    expect(() => useNotificationStore.getState().resolveAlert(true)).not.toThrow();
    expect(useNotificationStore.getState().alerts).toHaveLength(0);
  });

  it('toast 上限 5：第 6 条挤掉最旧，保留最新', () => {
    for (let i = 1; i <= 6; i += 1) {
      useNotificationStore.getState().pushToast({ title: `toast-${i}` });
    }
    const titles = useNotificationStore.getState().toasts.map((t) => t.title);
    expect(titles).toEqual(['toast-2', 'toast-3', 'toast-4', 'toast-5', 'toast-6']);
  });

  it('toast id 唯一（randomUUID 不可用时自增兜底仍唯一）', () => {
    useNotificationStore.getState().pushToast({ title: 'a' });
    useNotificationStore.getState().pushToast({ title: 'b' });
    const ids = useNotificationStore.getState().toasts.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('dismissToast 按 id 精确移除（其余保留）', () => {
    useNotificationStore.getState().pushToast({ title: 'a' });
    useNotificationStore.getState().pushToast({ title: 'b' });
    const [first] = useNotificationStore.getState().toasts;

    useNotificationStore.getState().dismissToast(first.id);
    const remaining = useNotificationStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('b');
  });
});
