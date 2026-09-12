/**
 * attachment-image.test.tsx — 附件鉴权图片组件契约测试（jsdom，plan §5.6）
 *
 * 覆盖：
 * ① 附件前缀 src → axiosInstance blob 拉取 → createObjectURL 渲染
 * ② 404 → i18n 裂图占位（401 走 axiosInstance 全局跳登录，组件不特殊处理）
 * ③ 外部 URL 变体（//evil.com、https://evil.com/api/v1/attachments/x、data:、blob:）
 *    一律不走 axios，渲染原生 <img>（防 token 出站安全红线）
 * ④ 空 src → 占位，不渲染 <img src="">
 * ⑤ 同源绝对 URL → 走 axios
 * ⑥ blob 缓存引用计数：同图多处引用复用（fetch 一次）；卸载 refs-1；归零 revoke
 * ⑦ 图片预览触发（批 3 追加）：渲染态 img 点击/Enter → store.open（attachment
 *    分支传 blob URL，外部图传原始 URL）；裂图占位不触发
 *
 * 缓存为模块级 Map：RTL 每用例自动 unmount → refs 归零 → 条目自清，用例间无污染。
 * 预览 store 为真实实例（不 mock）：用例间 close 重置。
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import {
  AttachmentImage,
  isAttachmentContentUrl,
  resolveAttachmentRequestPath,
} from './attachment-image';
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
beforeEach(() => {
  mockGet.mockReset();
  mockCreateObjectURL.mockClear();
  mockRevokeObjectURL.mockClear();
  // 预览 store 真实实例：用例间关闭重置（跨用例残留会污染 open 断言）
  useImagePreviewStore.getState().close();
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

  it('缓存复用：同图两处引用只 fetch 一次；卸载一个不 revoke；全卸载归零 revoke', async () => {
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

    // 卸载 B：refs 归零 → revoke
    unmountB();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('加载失败不建缓存条目（后续同 src 重新 fetch）', async () => {
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

describe('AttachmentImage 图片预览触发（批 3 追加，全局 Lightbox）', () => {
  it('attachment 渲染后点击 → store.open 被调且 src=blobUrl（当前显示 URL）', async () => {
    mockGet.mockResolvedValue({ data: new Blob(['img']) });
    render(<AttachmentImage src={ATT_SRC} alt="chart" />);
    await waitFor(() => {
      expect(screen.getByAltText('chart')).toHaveAttribute('src', 'blob:mock-url');
    });

    fireEvent.click(screen.getByAltText('chart'));

    expect(useImagePreviewStore.getState().src).toBe('blob:mock-url');
    expect(useImagePreviewStore.getState().alt).toBe('chart');
  });

  it('外部图点击 → src=原始 URL（非 blob）', async () => {
    render(<AttachmentImage src="https://example.com/photo.png" alt="ext" />);
    await waitFor(() => {
      expect(screen.getByAltText('ext')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByAltText('ext'));

    expect(useImagePreviewStore.getState().src).toBe('https://example.com/photo.png');
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
