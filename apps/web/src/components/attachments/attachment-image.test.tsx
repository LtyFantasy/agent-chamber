/**
 * attachment-image.test.tsx — 附件鉴权图片组件契约测试（jsdom，plan §5.6 + 附件 P2 §③）
 *
 * 覆盖：
 * ① 附件前缀 src → axiosInstance blob 拉取 → createObjectURL 渲染
 * ② 404 → i18n 裂图占位（401 走 axiosInstance 全局跳登录，组件不特殊处理）
 * ③ 外部 URL 变体（//evil.com、https://evil.com/api/v1/attachments/x、data:、blob:）
 *    一律不走 axios，渲染原生 <img>（防 token 出站安全红线）
 * ④ 空 src → 占位，不渲染 <img src="">
 * ⑤ 同源绝对 URL → 走 axios
 * ⑥ blob 缓存引用计数：同图多处引用复用（fetch 一次）；卸载 refs-1；归零 defer 释放
 * ⑦ 图片预览触发：渲染态 img 点击/Enter → store.open（attachment 分支传 blob URL +
 *    pinKey=附件内容 URL，外部图传原始 URL 且无 pinKey）；裂图占位不触发
 * ⑧ 视口门控（P2 §③）：observer root/rootMargin；滚出 defer 释放 + 占位；滚回重取；
 *    defer 窗口内滚回取消释放；宽高比占位；预览 pin 存活；在途竞态丢弃；多等待者聚合
 *
 * 计时器：全文用 jest fake timers（条目级 defer 是产品语义，必须可控推进）；
 * afterEach 先 cleanup 卸载（refs 归零）再推进 defer，条目自清，防跨用例污染。
 * IntersectionObserver：jsdom 无此 API，组件按 typeof 降级为「常驻可见」（= 不门控）；
 * 门控用例自行安装可控 mock 并手动 emit 可见性。
 * 缓存为模块级 Map（组件不导出 reset），用例间靠「卸载 → defer → revoke → 删条目」自清。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  AttachmentImage,
  isAttachmentContentUrl,
  resolveAttachmentRequestPath,
} from './attachment-image';
import { ImagePreviewHost } from './image-preview-host';
import { axiosInstance } from '@/lib/api';
import { useImagePreviewStore } from '@/stores/image-preview.store';

jest.mock('@/lib/api', () => ({
  axiosInstance: { get: jest.fn() },
}));
const mockGet = axiosInstance.get as jest.Mock;

/** attachments 命名空间英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  brokenImage: 'Image failed to load',
  preview: 'Image preview',
  zoomActual: 'Actual size',
  zoomFit: 'Fit to window',
  closePreview: 'Close preview',
};

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => messages[key] ?? key,
}));

// jsdom 无 URL.createObjectURL/revokeObjectURL，stub 之（blob 先例 skills 页同款）
const mockCreateObjectURL = jest.fn(() => 'blob:mock-url');
const mockRevokeObjectURL = jest.fn();
beforeAll(() => {
  URL.createObjectURL = mockCreateObjectURL;
  URL.revokeObjectURL = mockRevokeObjectURL;
});

/** 条目级 defer 释放延迟（对齐 attachment-image.tsx BLOB_RELEASE_DEFER_MS） */
const DEFER_MS = 300;
/** 推进过 defer 窗口（+50ms 余量） */
const pastDefer = () => {
  act(() => {
    jest.advanceTimersByTime(DEFER_MS + 50);
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockGet.mockReset();
  mockCreateObjectURL.mockClear();
  mockRevokeObjectURL.mockClear();
  // 预览 store 真实实例：用例间关闭重置（跨用例残留会污染 open/pin 断言）
  useImagePreviewStore.getState().close();
});

afterEach(() => {
  // 先显式卸载（refs 归零 → defer 计时器就位）再推进，让条目被 revoke 后自清
  cleanup();
  pastDefer();
  jest.useRealTimers();
});

/** 附件内容 URL（精确前缀形态） */
const ATT_SRC = '/api/v1/attachments/att-1/content';

describe('isAttachmentContentUrl 识别（安全红线，plan §5.2）', () => {
  it('精确前缀命中', () => {
    expect(isAttachmentContentUrl(ATT_SRC)).toBe(true);
  });

  it('同源绝对 URL 命中（origin 相同 + pathname 前缀命中）', () => {
    expect(isAttachmentContentUrl('http://localhost/api/v1/attachments/att-1/content')).toBe(true);
  });

  it('外部/协议变体一律 false（绝不走 axios）', () => {
    expect(isAttachmentContentUrl('//evil.com/api/v1/attachments/x')).toBe(false);
    expect(isAttachmentContentUrl('https://evil.com/api/v1/attachments/x')).toBe(false);
    expect(isAttachmentContentUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isAttachmentContentUrl('blob:http://localhost/abc')).toBe(false);
    expect(isAttachmentContentUrl('')).toBe(false);
    expect(isAttachmentContentUrl('/api/v2/attachments/x')).toBe(false);
    expect(isAttachmentContentUrl('https://evil.com/api/v1/attachments/x?token=leak')).toBe(false);
  });
});

describe('resolveAttachmentRequestPath 剥离契约（防双前缀 404 回归，主脑 Playwright 实测抓出）', () => {
  it('相对形态：/api/v1/attachments/<id>/content → /attachments/<id>/content', () => {
    expect(resolveAttachmentRequestPath(ATT_SRC)).toBe('/attachments/att-1/content');
  });

  it('同源绝对形态：取 pathname 再剥前缀', () => {
    expect(resolveAttachmentRequestPath('http://localhost/api/v1/attachments/att-2/content')).toBe(
      '/attachments/att-2/content',
    );
  });

  it('非附件形态一律 null（外部/协议变体/空）', () => {
    expect(resolveAttachmentRequestPath('//evil.com/api/v1/attachments/x')).toBeNull();
    expect(resolveAttachmentRequestPath('https://evil.com/api/v1/attachments/x')).toBeNull();
    expect(resolveAttachmentRequestPath('data:image/png;base64,AAAA')).toBeNull();
    expect(resolveAttachmentRequestPath('blob:http://localhost/abc')).toBeNull();
    expect(resolveAttachmentRequestPath('')).toBeNull();
    expect(resolveAttachmentRequestPath('/api/v2/attachments/x')).toBeNull();
  });
});

describe('AttachmentImage 渲染', () => {
  it('附件前缀 src → 剥离 API_PREFIX 后走 axios → 渲染 blob URL 图片', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    render(<AttachmentImage src={ATT_SRC} alt="chart" />);

    await waitFor(() => {
      expect(screen.getByAltText('chart')).toHaveAttribute('src', 'blob:mock-url');
    });
    // 回归断言（主脑 Playwright 实测抓出双前缀 404）：请求路径必须剥离 /api/v1——
    // axiosInstance.baseURL 已含 API_PREFIX，src 原样传会拼成 /api/v1/api/v1/... 404
    expect(mockGet).toHaveBeenCalledWith('/attachments/att-1/content', { responseType: 'blob' });
    expect(mockGet.mock.calls[0][0]).not.toContain('/api/v1');
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
  });

  it('同源绝对 URL → 取 pathname 剥前缀后走 axios（与相对前缀同通道）', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    render(<AttachmentImage src="http://localhost/api/v1/attachments/att-2/content" alt="abs" />);

    await waitFor(() => {
      expect(screen.getByAltText('abs')).toHaveAttribute('src', 'blob:mock-url');
    });
    // 回归断言：同源绝对形态同样剥离 /api/v1（baseURL 负责补 host 与前缀）
    expect(mockGet).toHaveBeenCalledWith('/attachments/att-2/content', { responseType: 'blob' });
    expect(mockGet.mock.calls[0][0]).not.toContain('/api/v1');
  });

  it('404 → i18n 裂图占位（不渲染 img）', async () => {
    mockGet.mockRejectedValue(new Error('404'));
    const { container } = render(<AttachmentImage src={ATT_SRC} alt="gone" />);

    await waitFor(() => {
      expect(screen.getByText('Image failed to load')).toBeInTheDocument();
    });
    expect(container.querySelector('img')).toBeNull();
  });

  it('外部 URL 变体一律原生 <img>，绝不走 axios', async () => {
    const variants = [
      '//evil.com/api/v1/attachments/x',
      'https://evil.com/api/v1/attachments/x',
      'data:image/png;base64,AAAA',
      'blob:http://localhost/abc',
    ];
    for (const src of variants) {
      const { container } = render(<AttachmentImage src={src} alt={`v-${src.slice(0, 8)}`} />);
      await waitFor(() => {
        expect(container.querySelector('img')).not.toBeNull();
      });
      expect(container.querySelector('img')?.getAttribute('src')).toBe(src);
      expect(mockGet).not.toHaveBeenCalled();
    }
  });

  it('空 src → 占位，不渲染 <img src="">（浏览器会请求页面自身）', async () => {
    const { container } = render(<AttachmentImage src="" alt="empty" />);

    await waitFor(() => {
      expect(screen.getByText('Image failed to load')).toBeInTheDocument();
    });
    expect(container.querySelector('img')).toBeNull();
  });

  it('缓存复用：同图两处引用只 fetch 一次；卸载一个不 revoke；全卸载 defer 后 revoke', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    const { unmount: unmountA } = render(<AttachmentImage src={ATT_SRC} alt="a" />);
    await waitFor(() => {
      expect(screen.getByAltText('a')).toHaveAttribute('src', 'blob:mock-url');
    });
    expect(mockGet).toHaveBeenCalledTimes(1);

    // 第二处引用：缓存命中，不重复 fetch
    const { unmount: unmountB } = render(<AttachmentImage src={ATT_SRC} alt="b" />);
    await waitFor(() => {
      expect(screen.getByAltText('b')).toHaveAttribute('src', 'blob:mock-url');
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);

    // 卸载 A：仍有 B 引用，不 revoke
    unmountA();
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();

    // 卸载 B：refs 归零 → 条目级 defer（不立即 revoke，窗口内可复用）；defer 过后 revoke
    unmountB();
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();
    pastDefer();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('加载失败不建缓存条目（后续同 src 重新 fetch；error 为终态直到 src 变更）', async () => {
    mockGet
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce({ data: new Blob(['img']) });
    const { unmount } = render(<AttachmentImage src={ATT_SRC} alt="retry" />);
    await waitFor(() => {
      expect(screen.getByText('Image failed to load')).toBeInTheDocument();
    });
    unmount();

    // 重新挂载同 src：无缓存条目 → 重新 fetch
    render(<AttachmentImage src={ATT_SRC} alt="retry2" />);
    await waitFor(() => {
      expect(screen.getByAltText('retry2')).toHaveAttribute('src', 'blob:mock-url');
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});

describe('AttachmentImage 图片预览触发（全局 Lightbox）', () => {
  it('attachment 渲染后点击 → store.open 收到 displaySrc=blobUrl + pinKey=附件内容 URL', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    render(<AttachmentImage src={ATT_SRC} alt="chart" />);
    await waitFor(() => {
      expect(screen.getByAltText('chart')).toHaveAttribute('src', 'blob:mock-url');
    });

    fireEvent.click(screen.getByAltText('chart'));

    expect(useImagePreviewStore.getState().src).toBe('blob:mock-url');
    expect(useImagePreviewStore.getState().alt).toBe('chart');
    // 键空间契约（plan §③ B-2）：pin 键 = 附件内容 URL，与 blobCache 同键空间；
    // 传 blobUrl 的宿主 acquireRef 必 miss
    expect(useImagePreviewStore.getState().pinKey).toBe(ATT_SRC);
  });

  it('外部图点击 → src=原始 URL 且无 pinKey（无 blob 可持有）', async () => {
    render(<AttachmentImage src="https://example.com/photo.png" alt="ext" />);
    await waitFor(() => {
      expect(screen.getByAltText('ext')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByAltText('ext'));

    expect(useImagePreviewStore.getState().src).toBe('https://example.com/photo.png');
    expect(useImagePreviewStore.getState().pinKey).toBeUndefined();
  });

  it('键盘 Enter 触发预览（role=button + tabIndex 语义）', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    render(<AttachmentImage src={ATT_SRC} alt="chart" />);
    await waitFor(() => {
      expect(screen.getByAltText('chart')).toHaveAttribute('src', 'blob:mock-url');
    });

    fireEvent.keyDown(screen.getByAltText('chart'), { key: 'Enter' });

    expect(useImagePreviewStore.getState().src).toBe('blob:mock-url');
  });

  it('裂图占位不触发预览（占位非渲染态 img）', async () => {
    mockGet.mockRejectedValue(new Error('404'));
    render(<AttachmentImage src={ATT_SRC} alt="gone" />);
    await waitFor(() => {
      expect(screen.getByText('Image failed to load')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Image failed to load'));

    expect(useImagePreviewStore.getState().src).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 视口门控（附件 P2 §③）：IntersectionObserver
// ---------------------------------------------------------------------------

type IOCallback = (
  entries: IntersectionObserverEntry[],
  observer: MockIntersectionObserver,
) => void;

/** 已创建的 observer 实例（emit/断言用；新实例追加在尾部） */
const ioInstances: MockIntersectionObserver[] = [];

/**
 * 可控 IntersectionObserver mock（jsdom 无 IO）：记录 root/rootMargin/观察节点，
 * 用例手动 emit 可见性（真实 IO 的初始回调语义由用例显式表达，避免隐式时序）。
 */
class MockIntersectionObserver {
  readonly observed = new Set<Element>();
  readonly root: Element | null;
  readonly rootMargin: string;
  disconnected = false;

  constructor(
    private readonly callback: IOCallback,
    options?: { root?: Element | null; rootMargin?: string },
  ) {
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? '0px';
    ioInstances.push(this);
  }

  observe(el: Element): void {
    this.observed.add(el);
  }

  unobserve(el: Element): void {
    this.observed.delete(el);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** 触发可见性回调（作用于当前观察节点） */
  emit(isIntersecting: boolean): void {
    const entries = [...this.observed].map(
      (target) => ({ isIntersecting, target }) as unknown as IntersectionObserverEntry,
    );
    if (entries.length > 0) this.callback(entries, this);
  }
}

/** 安装/卸载 IO mock（组件按 typeof 检测 → 装 = 启用门控，卸 = 降级常驻可见） */
function installIntersectionObserverMock(): void {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver =
    MockIntersectionObserver;
}
function uninstallIntersectionObserverMock(): void {
  delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
}

/** 取容器内当前节点对应的最新 observer（节点替换会重建 observer，disconnect 会清空旧观察集） */
function observerFor(container: HTMLElement): MockIntersectionObserver {
  const found = [...ioInstances]
    .reverse()
    .find((o) => [...o.observed].some((el) => container.contains(el)));
  if (!found) throw new Error('容器内没有已登记的 IntersectionObserver');
  return found;
}

/** 对容器内当前观察节点触发一次可见性变化（act 包裹：会引发 React 状态更新） */
function emitInView(container: HTMLElement, isIntersecting: boolean): void {
  act(() => {
    observerFor(container).emit(isIntersecting);
  });
}

describe('AttachmentImage 视口门控（IntersectionObserver，附件 P2 §③）', () => {
  beforeEach(() => {
    installIntersectionObserverMock();
  });
  afterEach(() => {
    uninstallIntersectionObserverMock();
  });

  it('observer root = 最近的 data-scroll-container 祖先 + rootMargin 400px；无容器 → root null', () => {
    // 嵌套滚动容器（topic 消息区 / docs 正文 / doc-editor 预览面板同款标注）
    const wrapped = render(
      <div data-scroll-container id="scroll">
        <AttachmentImage src={ATT_SRC} alt="rooted" />
      </div>,
    );
    const observer = observerFor(wrapped.container);
    expect(observer.root).toBe(wrapped.container.querySelector('#scroll'));
    expect(observer.rootMargin).toBe('400px');

    // 无标注容器 → fallback root:null（视口），行为与标注前一致
    ioInstances.length = 0;
    const plain = render(<AttachmentImage src={ATT_SRC} alt="plain" />);
    expect(observerFor(plain.container).root).toBeNull();
  });

  it('滚出视口不加载；滚入才发请求（门控生效）', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    const { container } = render(<AttachmentImage src={ATT_SRC} alt="gated" />);

    // IO 存在 → 初始不可见：占位骨架、零请求（首载位移为已登记残留）
    expect(container.querySelector('img')).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();

    emitInView(container, true);
    await waitFor(() => {
      expect(screen.getByAltText('gated')).toHaveAttribute('src', 'blob:mock-url');
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('滚出视口 → defer 释放（不立即 revoke）+ 骨架占位；defer 过后 revoke', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    const { container } = render(<AttachmentImage src={ATT_SRC} alt="gated" />);
    emitInView(container, true);
    await waitFor(() => {
      expect(screen.getByAltText('gated')).toHaveAttribute('src', 'blob:mock-url');
    });

    emitInView(container, false);

    // 立刻：img 换成占位、blob 未 revoke（defer 窗口，plan §③）
    expect(container.querySelector('img')).toBeNull();
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();

    pastDefer();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('滚回重取：defer 释放后滚回 → 重新 fetch + 重新渲染 blob', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    const { container } = render(<AttachmentImage src={ATT_SRC} alt="gated" />);
    emitInView(container, true);
    await waitFor(() => {
      expect(screen.getByAltText('gated')).toHaveAttribute('src', 'blob:mock-url');
    });

    emitInView(container, false);
    pastDefer();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    // 滚回视口：条目已回收 → re-acquire = 重新 fetch
    emitInView(container, true);
    await waitFor(() => {
      expect(screen.getByAltText('gated')).toHaveAttribute('src', 'blob:mock-url');
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(2);
  });

  it('defer 窗口内滚回 → acquire 取消 pending defer，复用同一 blob（不重复 fetch）', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    const { container } = render(<AttachmentImage src={ATT_SRC} alt="gated" />);
    emitInView(container, true);
    await waitFor(() => {
      expect(screen.getByAltText('gated')).toHaveAttribute('src', 'blob:mock-url');
    });

    emitInView(container, false);
    act(() => {
      jest.advanceTimersByTime(DEFER_MS - 100); // 仍在 defer 窗口内
    });
    emitInView(container, true);

    expect(screen.getByAltText('gated')).toHaveAttribute('src', 'blob:mock-url');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);

    // defer 已被取消：再推进很久也不会 revoke（仍被可见组件持有）
    pastDefer();
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();
  });

  it('已加载过的图滚出 → naturalWidth/Height 宽高比占位盒（回滚不跳高度）', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    const { container } = render(<AttachmentImage src={ATT_SRC} alt="sized" />);
    emitInView(container, true);
    await waitFor(() => {
      expect(screen.getByAltText('sized')).toHaveAttribute('src', 'blob:mock-url');
    });

    // jsdom 不加载图片资源 → naturalWidth/Height 由 load 事件用例手动给值
    const img = screen.getByAltText('sized');
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    fireEvent.load(img);

    emitInView(container, false);

    const box = container.querySelector('span[style]');
    expect(box).not.toBeNull();
    expect(box?.getAttribute('style')).toContain('aspect-ratio: 800 / 600');
    expect(container.querySelector('img')).toBeNull();
  });

  it('在途 fetch 完成时已不可见 → 不建缓存条目、直接 revoke（丢弃）', async () => {
    let resolveGet: (value: { data: Blob }) => void = () => {};
    mockGet.mockImplementation(
      () =>
        new Promise<{ data: Blob }>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const first = render(<AttachmentImage src={ATT_SRC} alt="inflight" />);
    emitInView(first.container, true);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // 在途期间滚出视口（唯一等待者已不可见）
    emitInView(first.container, false);
    await act(async () => {
      resolveGet({ data: new Blob(['img']) });
    });

    // 丢弃：直接 revoke（无 defer 等待），不建条目
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);

    // 不建条目的行为证据：新挂载同 src 仍会重新 fetch
    const second = render(<AttachmentImage src={ATT_SRC} alt="inflight-2" />);
    emitInView(second.container, true);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('多等待者聚合：同 src 只发一次请求；一个滚出、另一个仍可见 → 不误 revoke', async () => {
    let resolveGet: (value: { data: Blob }) => void = () => {};
    mockGet.mockImplementation(
      () =>
        new Promise<{ data: Blob }>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const a = render(<AttachmentImage src={ATT_SRC} alt="wa-a" />);
    emitInView(a.container, true);
    const b = render(<AttachmentImage src={ATT_SRC} alt="wa-b" />);
    emitInView(b.container, true);
    // pending 级 in-flight 去重：同 src 并发只发一次请求
    expect(mockGet).toHaveBeenCalledTimes(1);

    // 一个滚出（还有另一个可见）→ 完成时不丢弃
    emitInView(a.container, false);
    await act(async () => {
      resolveGet({ data: new Blob(['img']) });
    });

    expect(mockRevokeObjectURL).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByAltText('wa-b')).toHaveAttribute('src', 'blob:mock-url');
    });
    // 可见者复用同一 blob（未重复建 URL）
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    // 滚出者不持有：仍是占位
    expect(a.container.querySelector('img')).toBeNull();
  });

  it('预览 pin 存活：打开预览 → 组件卸载 blob 仍存活（refs≥1）；关闭 → defer 后 revoke', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    render(<ImagePreviewHost />);
    const first = render(<AttachmentImage src={ATT_SRC} alt="pinned" />);
    emitInView(first.container, true);
    await waitFor(() => {
      expect(screen.getByAltText('pinned')).toHaveAttribute('src', 'blob:mock-url');
    });

    // 点击放大：宿主按 pinKey（附件内容 URL）acquireRef 持有 blob
    fireEvent.click(screen.getByAltText('pinned'));
    expect(useImagePreviewStore.getState().src).toBe('blob:mock-url');
    expect(useImagePreviewStore.getState().pinKey).toBe(ATT_SRC);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute(
      'src',
      'blob:mock-url',
    );

    // 组件卸载（预览仍开）：组件引用归还 + observer 断开，但 pin 持有 → blob 存活
    const currentObserver = observerFor(first.container);
    first.unmount();
    expect(currentObserver.disconnected).toBe(true);
    act(() => {
      jest.advanceTimersByTime(DEFER_MS * 4);
    });
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();

    // pin 存活的第二条证据：重新挂载同 src → 缓存命中（不重新 fetch）
    const again = render(<AttachmentImage src={ATT_SRC} alt="pinned-again" />);
    emitInView(again.container, true);
    await waitFor(() => {
      expect(screen.getByAltText('pinned-again')).toHaveAttribute('src', 'blob:mock-url');
    });
    expect(mockGet).toHaveBeenCalledTimes(1);

    // 关闭预览 → 宿主 releaseRef → refs 归零 → defer 后 revoke
    again.unmount();
    act(() => {
      useImagePreviewStore.getState().close();
    });
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();
    pastDefer();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('卸载时 observer disconnect（不泄漏观察）', () => {
    const { container, unmount } = render(<AttachmentImage src={ATT_SRC} alt="bye" />);
    const observer = observerFor(container);

    unmount();

    expect(observer.disconnected).toBe(true);
  });
});
