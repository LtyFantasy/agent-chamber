/**
 * providers.test.tsx — **全局查询失败兜底 toast** 的契约（卡 240c74d6）。
 *
 * 为什么必须走**真实 Providers**（而不是测 `pushQueryErrorToast` 就完事）：本层要证明的
 * 是"接线接上了"——`queryCache: new QueryCache({onError})` 真的挂在 client 上、首载判据
 * 真的生效、去重真的在并发失败下收敛成一条。只测纯函数会漏掉整条接线。
 *
 * 三条口径各自的用例：
 * ① 首载失败 → 弹（且文案是本地兜底，**不是** axios 的 'Network Error'）；
 * ② 同窗多 query 去重 → 两个**不同 queryKey** 的 query 同时失败只弹一条
 *    （单 query 恒走不到去重分支——这是防恒过假测的关键，故必须驱动 ≥2 个 key）；
 * ③ 有缓存的刷新失败 → 静音。
 *
 * 时间处理：全局默认 `retry: 2` + 指数退避（1s/2s），真实时间下三个用例要 10s+。
 * 故用 fake timers，让 RTL 的 `waitFor` 推进虚拟时钟（RTL 侦测到 fake timers 时会自行
 * `advanceTimersByTime`），`timeout` 给足 5000ms 虚拟时间覆盖完整重试链。
 */

import { render, screen, waitFor, act } from '@testing-library/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Providers,
  pushQueryErrorToast,
  resetQueryErrorToastDedup,
  QUERY_ERROR_TOAST_DEDUP_MS,
} from './providers';
import { useNotificationStore } from '@/stores/notification.store';

// Providers 会挂 NotificationHost（Toaster/AlertDialog）与 ImagePreviewHost，两者都依赖
// next-intl。测试不关心它们渲染什么（断言直读通知 store），但 next-intl 的 node_modules
// 产物是 ESM，jest 不转译 → 必须 mock（与全仓页面测试同规）。
jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useLocale: () => 'en',
}));

/** 断网形态的错误（axios 网络层失败：无 response，message 是英文原文） */
function networkError(): Error {
  return new Error('Network Error');
}

/** 记录每个用例里"确实失败过"的 queryKey——用来证明去重用例不是空转（真的有两个 query 挂了） */
const failedKeys: string[] = [];

/**
 * 一个会失败的查询（**使用全局默认选项**：不覆写 retry，故真实走 retry:2 + 退避）。
 * queryKey 由调用方给，用来驱动"多个不同 key 并发失败"。
 * `reject` 返回 unknown：既要能造断网（plain Error），也要能造 4xx 信封形态的对象。
 */
function FailingQuery({ queryKey, reject }: { queryKey: string[]; reject: () => unknown }) {
  const { isError } = useQuery({
    queryKey,
    queryFn: () => Promise.reject(reject()),
  });
  if (isError) failedKeys.push(queryKey.join('/'));
  return null;
}

beforeEach(() => {
  jest.useFakeTimers();
  failedKeys.length = 0;
  useNotificationStore.setState({ toasts: [], alerts: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('全局 QueryCache.onError 兜底 toast', () => {
  it('首载失败 → 弹一条本地兜底文案，不出现 axios 英文原文', async () => {
    const reject = jest.fn(networkError);
    render(
      <Providers>
        <FailingQuery queryKey={['probe', 'single']} reject={reject} />
      </Providers>,
    );

    // 真实重试链 = 1s + 2s 退避（虚拟时间由 RTL 的 waitFor 推进）
    await waitFor(
      () => {
        expect(useNotificationStore.getState().toasts).toHaveLength(1);
      },
      { timeout: 5000 },
    );

    const toast = useNotificationStore.getState().toasts[0];
    // 非 React 通道的兜底文案 = getApiMessage('requestFailed')（jsdom 无 locale cookie → en）
    expect(toast.title).toBe('Request failed');
    expect(toast.title).not.toContain('Network Error');
    expect(toast.variant).toBe('error');
    // 初次读取 + 两次重试，直接计数证明读取默认 retry:2 保持生效。
    expect(reject).toHaveBeenCalledTimes(3);
  });

  it('4xx + 业务码 → 兜底 toast 透传服务端 message（与页面内错误态同一分级口径）', async () => {
    render(
      <Providers>
        <FailingQuery
          queryKey={['probe', 'forbidden']}
          reject={() => ({
            response: { status: 403, data: { code: 1009, message: 'you lack the required scope' } },
          })}
        />
      </Providers>,
    );

    await waitFor(
      () => {
        expect(useNotificationStore.getState().toasts).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    // 4xx 的业务原因要能说明"为什么失败"；5xx/断网才回落本地文案（上一条用例）
    expect(useNotificationStore.getState().toasts[0].title).toBe('you lack the required scope');
  });

  it('同窗两个不同 queryKey 并发失败 → 只弹一条（去重生效）', async () => {
    render(
      <Providers>
        <FailingQuery queryKey={['probe', 'a']} reject={networkError} />
        <FailingQuery queryKey={['probe', 'b']} reject={networkError} />
      </Providers>,
    );

    await waitFor(
      () => {
        // 先证明"两个 query 真的都失败了"——否则本用例可能只是没跑到第二个 query
        expect(failedKeys).toContain('probe/a');
        expect(failedKeys).toContain('probe/b');
      },
      { timeout: 5000 },
    );

    // 两个都挂了，但用户只该看到一条（同窗同文案抑制）
    expect(useNotificationStore.getState().toasts).toHaveLength(1);
  });

  it('有缓存的刷新失败 → 静音（不打断正在读页面的用户）', async () => {
    let shouldFail = false;
    function CachedQuery() {
      const { isError, refetch } = useQuery({
        queryKey: ['probe', 'cached'],
        queryFn: () => (shouldFail ? Promise.reject(networkError()) : Promise.resolve('ok')),
      });
      return (
        <button type="button" onClick={() => void refetch()}>
          {isError ? 'refetch-failed' : 'idle'}
        </button>
      );
    }

    render(
      <Providers>
        <CachedQuery />
      </Providers>,
    );

    // 首次成功：data 已落地，toasts 为空
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('idle'));
    expect(useNotificationStore.getState().toasts).toHaveLength(0);

    shouldFail = true;
    await act(async () => {
      screen.getByRole('button').click();
    });

    // 等它真的失败（走完重试链）——失败发生但 data 仍在，故不该弹
    await waitFor(
      () => {
        expect(screen.getByRole('button')).toHaveTextContent('refetch-failed');
      },
      { timeout: 5000 },
    );
    expect(useNotificationStore.getState().toasts).toHaveLength(0);
  });

  // ── 抑制窗口边界（reviewer minor-3）──────────────────────────────────────────
  // 上面三条走真实 Providers 的渲染路径（覆盖"接线接上了"），这条直调导出的
  // `pushQueryErrorToast(error, now)` 打**窗口判据本身**：边界值必须逐个钉死，否则把
  // `< QUERY_ERROR_TOAST_DEDUP_MS` 写成 `<=` 时无人发现。`now` 由调用方注入，故与
  // fake timers 无关、完全确定。
  describe('抑制窗口边界（直调导出）', () => {
    /** 重置窗口 + 清空通知（模块级状态，用例间必须显式隔离） */
    function freshWindow() {
      resetQueryErrorToastDedup();
      useNotificationStore.setState({ toasts: [], alerts: [] });
    }

    it('相隔恰好一个窗口（= 1500ms）→ 弹 2 条（判据是 `<` 不是 `<=`）', () => {
      freshWindow();
      const err = networkError();
      pushQueryErrorToast(err, 10_000);
      pushQueryErrorToast(err, 10_000 + QUERY_ERROR_TOAST_DEDUP_MS);
      expect(useNotificationStore.getState().toasts).toHaveLength(2);
    });

    it('相隔不足一个窗口（1500ms - 1）→ 只弹 1 条（同窗同文案抑制）', () => {
      freshWindow();
      const err = networkError();
      pushQueryErrorToast(err, 10_000);
      pushQueryErrorToast(err, 10_000 + QUERY_ERROR_TOAST_DEDUP_MS - 1);
      expect(useNotificationStore.getState().toasts).toHaveLength(1);
    });

    it('去重键是文案：同窗内两条不同文案各弹一条（不是按 queryHash 粗粒度合并）', () => {
      freshWindow();
      pushQueryErrorToast(networkError(), 10_000);
      pushQueryErrorToast(
        { response: { status: 403, data: { code: 1009, message: 'you lack the required scope' } } },
        10_000 + 1,
      );
      const toasts = useNotificationStore.getState().toasts;
      expect(toasts.map((item) => item.title)).toEqual([
        'Request failed',
        'you lack the required scope',
      ]);
    });
  });
});

describe('全局 mutation 默认不重放非幂等写入', () => {
  it('一次点击已提交后断网 → 一次写入、error，跨旧重试窗口仍不重放', async () => {
    const writes: string[] = [];
    const onError = jest.fn();
    const onSuccess = jest.fn();

    /** 使用真实 Providers 默认项；首次提交后丢失响应，重放则会重复提交并成功。 */
    function UncertainWrite() {
      const mutation = useMutation({
        mutationFn: async () => {
          writes.push('committed');
          if (writes.length === 1) throw networkError();
          return 'duplicate committed';
        },
        onError,
        onSuccess,
      });
      return (
        <>
          <button type="button" onClick={() => mutation.mutate(undefined)}>
            write once
          </button>
          <output data-testid="mutation-status">{mutation.status}</output>
        </>
      );
    }

    render(
      <Providers>
        <UncertainWrite />
      </Providers>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'write once' }).click();
    });
    // 等真实终态；旧 retry:1 会变成 success、两次写入，不能靠调用 mutate 后立即计数蒙混。
    await waitFor(
      () => {
        expect({
          status: screen.getByTestId('mutation-status').textContent,
          writes: writes.length,
          errors: onError.mock.calls.length,
          successes: onSuccess.mock.calls.length,
        }).toEqual({ status: 'error', writes: 1, errors: 1, successes: 0 });
      },
      { timeout: 5000 },
    );

    // 再跨过旧默认的 1s 重试等待，验证没有延迟重放或终态回调。
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(writes).toEqual(['committed']);
    expect(screen.getByTestId('mutation-status')).toHaveTextContent('error');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
