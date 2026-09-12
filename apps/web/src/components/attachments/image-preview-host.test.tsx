/**
 * image-preview-host.test.tsx — 全局图片预览宿主契约测试（jsdom，批 3 追加）
 *
 * 覆盖：
 * ① open 后渲染 overlay + img（src/alt 透传）
 * ② ESC 关闭
 * ③ 背板点击关闭（点图片不关——stopPropagation）
 * ④ 适应/原始尺寸切换按钮改 class（fit → actual 容器可滚动）
 * ⑤ body overflow 锁/解锁（打开 hidden，关闭恢复原值）
 *
 * store 用真实实例驱动（zustand getState().open/close + act 包裹），
 * 不 mock——宿主与 store 的契约按真实链路验证。
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

describe('ImagePreviewHost 全局图片预览（批 3 追加）', () => {
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
