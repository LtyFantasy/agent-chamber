/**
 * image-preview-host.test.tsx — 全局图片预览宿主契约测试（jsdom）
 *
 * 覆盖：
 * ① open 后渲染 overlay + img（src/alt 透传）
 * ② ESC 关闭
 * ③ 背板点击关闭（点图片不关——stopPropagation）
 * ④ 适应/原始尺寸切换按钮改 class（fit → actual 容器可滚动）
 * ⑤ body overflow 锁/解锁（打开 hidden，关闭恢复原值）
 * ⑥ 预览 pin 键空间契约（附件 P2 §③）：open 三参存 pinKey / close 清 pinKey /
 *    无条目的 pinKey 安全 no-op（acquireRef miss 不抛——blobUrl 误传时就是这个形态）
 *
 * store 用真实实例驱动（zustand getState().open/close + act 包裹），
 * 不 mock——宿主与 store 的契约按真实链路验证。
 * pin 的引用计数语义（存活/释放）在 attachment-image.test.tsx 用真实 blob 全链验证。
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { ImagePreviewHost } from './image-preview-host';
import { useImagePreviewStore } from '@/stores/image-preview.store';

/** attachments 命名空间英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  preview: 'Image preview',
  zoomActual: 'Actual size',
  zoomFit: 'Fit to window',
  closePreview: 'Close preview',
};

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => messages[key] ?? key,
}));

beforeEach(() => {
  useImagePreviewStore.getState().close();
  document.body.style.overflow = '';
});

describe('ImagePreviewHost 全局图片预览', () => {
  it('open 后渲染 overlay + img（src/alt 透传）', () => {
    render(<ImagePreviewHost />);
    act(() => {
      useImagePreviewStore.getState().open('blob:mock-url', 'chart');
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:mock-url');
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'chart');
  });

  it('ESC 关闭', () => {
    render(<ImagePreviewHost />);
    act(() => {
      useImagePreviewStore.getState().open('blob:mock-url', 'chart');
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('背板点击关闭；点图片不关（stopPropagation）', () => {
    render(<ImagePreviewHost />);
    act(() => {
      useImagePreviewStore.getState().open('blob:mock-url', 'chart');
    });

    // 点图片（图片区 stopPropagation）→ 不关
    fireEvent.click(screen.getByRole('img'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // 点背板（overlay 本体 onClick=close）→ 关
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('切换按钮改 class：fit（object-contain）→ actual（原始尺寸 + 容器滚动）', () => {
    render(<ImagePreviewHost />);
    act(() => {
      useImagePreviewStore.getState().open('blob:mock-url', 'chart');
    });
    const img = screen.getByRole('img');
    expect(img.className).toContain('object-contain');

    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));

    expect(img.className).not.toContain('object-contain');
    // 按钮文案翻转（actual 态显示「适应窗口」）
    expect(screen.getByRole('button', { name: 'Fit to window' })).toBeInTheDocument();
  });

  it('body overflow 锁/解锁（打开 hidden，关闭恢复原值）', () => {
    render(<ImagePreviewHost />);
    act(() => {
      useImagePreviewStore.getState().open('blob:mock-url', 'chart');
    });
    expect(document.body.style.overflow).toBe('hidden');

    act(() => {
      useImagePreviewStore.getState().close();
    });
    expect(document.body.style.overflow).toBe('');
  });

  it('关闭按钮（X）关闭', () => {
    render(<ImagePreviewHost />);
    act(() => {
      useImagePreviewStore.getState().open('blob:mock-url', 'chart');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ImagePreviewHost 预览 pin 键空间契约（附件 P2 §③）', () => {
  it('open 三参 → store 存 pinKey；close 清空（宿主据此 acquire/release blob 引用）', () => {
    render(<ImagePreviewHost />);

    act(() => {
      useImagePreviewStore
        .getState()
        .open('blob:mock-url', 'chart', '/api/v1/attachments/att-1/content');
    });
    expect(useImagePreviewStore.getState().pinKey).toBe('/api/v1/attachments/att-1/content');
    // pinKey 只作内部键：不得渲染进 DOM（blob/附件 URL 都是会话资源）
    expect(screen.getByRole('dialog').innerHTML).not.toContain('/api/v1/attachments/');

    act(() => {
      useImagePreviewStore.getState().close();
    });
    expect(useImagePreviewStore.getState().pinKey).toBeUndefined();
  });

  it('pinKey 无缓存条目（误传 blobUrl 时的形态）→ acquireRef miss 安全 no-op，不抛不阻塞渲染', () => {
    render(<ImagePreviewHost />);

    expect(() => {
      act(() => {
        useImagePreviewStore.getState().open('blob:mock-url', 'chart', 'blob:mock-url');
      });
    }).not.toThrow();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    expect(() => {
      act(() => {
        useImagePreviewStore.getState().close();
      });
    }).not.toThrow();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('无 pinKey（外部图）→ 宿主不做引用计数（open/close 全链无副作用）', () => {
    render(<ImagePreviewHost />);

    act(() => {
      useImagePreviewStore.getState().open('https://example.com/photo.png', 'ext');
    });
    expect(useImagePreviewStore.getState().pinKey).toBeUndefined();
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.com/photo.png');

    act(() => {
      useImagePreviewStore.getState().close();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
