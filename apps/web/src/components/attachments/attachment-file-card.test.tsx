/**
 * attachment-file-card.test.tsx — 非图片附件卡片契约测试（v1.90.0-dev 通用附件批 §2 B5）
 *
 * 覆盖：
 * ① 纯函数：图标分类（6 类 + clientMimeType 兜底）、大小格式化、过期态推导、
 *    图片条目判定、可执行扩展名判定（大小写不敏感）
 * ② 渲染态：文件名 + 大小 + 过期倒计时（天/小时/永久三档）；过期 → 置灰 + 禁用
 *    + 「已过期」；可执行扩展名 → 常驻警示 badge
 * ③ 下载流：axiosInstance.get（blob）→ objectURL → 临时 `<a download>` → 延后 revoke；
 *    请求路径剥离 API_PREFIX（双拼 404 回归断言）
 * ④ 可执行警告确认流：确认前不发请求；取消不发请求；确认后照常下载
 * ⑤ 失败路径：410/网络 → 本地 toast（不抛；拦截器不弹全局 toast，见组件注释 R8）
 *
 * jsdom 无 URL.createObjectURL / 无真实导航：均显式 mock（同 docs 页测试先例）。
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { MessageAttachment } from '@agent-chamber/shared';
import {
  AttachmentFileCard,
  classifyAttachment,
  expiryStateOf,
  extensionOf,
  formatAttachmentSize,
  isExecutableAttachment,
  isInlineImageAttachment,
} from './attachment-file-card';

/** attachments 命名空间英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'attachments.card.download': 'Download',
  'attachments.card.downloadFailed': 'Download failed, please retry',
  'attachments.card.expired': 'Expired',
  'attachments.card.expiresInDays': 'Expires in {days}d',
  'attachments.card.expiresInHours': 'Expires in {hours}h',
  'attachments.card.executableBadge': 'Executable',
  'attachments.card.executableTitle': 'Executable file',
  'attachments.card.executableConfirm': '"{name}" may be executable. Download anyway?',
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
};

jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, params?: Record<string, string | number>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    let text = messages[fullKey] ?? fullKey;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.split(`{${k}}`).join(String(v));
      }
    }
    return text;
  },
}));

// axiosInstance mock：axios 响应拦截器不参与单测（410 不弹全局 toast 已在组件注释
// 核实 R8），这里只验请求路径与 blob → objectURL 落盘链路
jest.mock('@/lib/api', () => ({
  axiosInstance: { get: jest.fn() },
}));

jest.mock('@/lib/notify', () => ({
  confirm: jest.fn(),
  toast: { error: jest.fn(), warning: jest.fn(), success: jest.fn(), info: jest.fn() },
}));

import { axiosInstance } from '@/lib/api';
import { confirm, toast } from '@/lib/notify';

const mockGet = axiosInstance.get as jest.Mock;
const mockConfirm = confirm as jest.Mock;
const mockToastError = toast.error as jest.Mock;

/** 构造附件条目（字段对齐 shared MessageAttachment 契约） */
function att(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'att-1',
    originalName: 'report.log',
    mimeType: 'application/octet-stream',
    sizeBytes: 2048,
    clientMimeType: 'text/plain',
    expiresAt: null,
    expired: false,
    contentUrl: '/api/v1/attachments/att-1/content',
    ...overrides,
  };
}

describe('AttachmentFileCard 纯函数', () => {
  it('extensionOf：小写化、隐藏文件与无扩展名返回空串', () => {
    expect(extensionOf('A.PDF')).toBe('.pdf');
    expect(extensionOf('archive.tar.gz')).toBe('.gz');
    expect(extensionOf('.bashrc')).toBe('');
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });

  it('extensionOf：尾空格/尾点伪装归一化（n2 修订）', () => {
    // 尾空格与尾点都能把 `lastIndexOf('.')` 顶到末位 → 原实现会返回 '' 漏判
    expect(extensionOf('payload.exe ')).toBe('.exe');
    expect(extensionOf('payload.exe...')).toBe('.exe');
    expect(extensionOf('payload.exe. ')).toBe('.exe');
    expect(extensionOf('  payload.exe  ')).toBe('.exe');
    // 归一化不吞真实扩展名
    expect(extensionOf('README.md.')).toBe('.md');
  });

  it('classifyAttachment：扩展名优先，6 类各归其位', () => {
    const kind = (name: string, clientMimeType: string | null = null) =>
      classifyAttachment({
        originalName: name,
        clientMimeType,
        mimeType: 'application/octet-stream',
      });
    expect(kind('spec.pdf')).toBe('document');
    expect(kind('bundle.zip')).toBe('archive');
    expect(kind('main.ts')).toBe('code');
    expect(kind('metrics.csv')).toBe('data');
    expect(kind('clip.mp4')).toBe('media');
    expect(kind('clip.mp3')).toBe('media');
    expect(kind('mystery')).toBe('generic');
  });

  it('classifyAttachment：扩展名未命中时用 clientMimeType 兜底（绝不看 mimeType）', () => {
    // mimeType 恒 octet-stream（非图片字节证据），对分类零信息量——即便声明
    // clientMimeType 也未命中词典前缀时仍回退 generic
    const base = { originalName: 'blob', mimeType: 'application/octet-stream' };
    expect(classifyAttachment({ ...base, clientMimeType: 'audio/mpeg' })).toBe('media');
    expect(classifyAttachment({ ...base, clientMimeType: 'application/zip' })).toBe('archive');
    expect(classifyAttachment({ ...base, clientMimeType: 'application/json' })).toBe('data');
    expect(classifyAttachment({ ...base, clientMimeType: 'text/plain' })).toBe('document');
    expect(classifyAttachment({ ...base, clientMimeType: 'application/octet-stream' })).toBe(
      'generic',
    );
    expect(classifyAttachment({ ...base, clientMimeType: null })).toBe('generic');
  });

  it('formatAttachmentSize：B / KB / MB 三档', () => {
    expect(formatAttachmentSize(0)).toBe('0 B');
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(2048)).toBe('2.0 KB');
    expect(formatAttachmentSize(10 * 1024)).toBe('10 KB');
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatAttachmentSize(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatAttachmentSize(Number.NaN)).toBe('—');
  });

  it('expiryStateOf：永久 / 天数 / 钟点（<24h）/ 已过期 四态', () => {
    const now = Date.parse('2026-10-03T00:00:00.000Z');
    expect(expiryStateOf(null, now)).toEqual({ kind: 'never' });
    expect(expiryStateOf('not-a-date', now)).toEqual({ kind: 'never' });
    expect(expiryStateOf('2026-10-06T00:00:00.000Z', now)).toEqual({ kind: 'days', days: 3 });
    expect(expiryStateOf('2026-10-03T02:00:00.000Z', now)).toEqual({ kind: 'soon', hours: 2 });
    expect(expiryStateOf('2026-10-02T23:59:59.000Z', now)).toEqual({ kind: 'expired' });
  });

  it('isInlineImageAttachment：仅 4 种嗅探 mime（svg 不得过闸）', () => {
    expect(isInlineImageAttachment(att({ mimeType: 'image/png' }))).toBe(true);
    expect(isInlineImageAttachment(att({ mimeType: 'image/jpeg' }))).toBe(true);
    expect(isInlineImageAttachment(att({ mimeType: 'image/svg+xml' }))).toBe(false);
    expect(isInlineImageAttachment(att({ mimeType: 'application/octet-stream' }))).toBe(false);
  });

  it('isExecutableAttachment：10 个扩展名，大小写不敏感', () => {
    for (const ext of ['exe', 'scr', 'bat', 'cmd', 'com', 'msi', 'lnk', 'ps1', 'sh', 'jar']) {
      expect(isExecutableAttachment({ originalName: `payload.${ext}` })).toBe(true);
      expect(isExecutableAttachment({ originalName: `PAYLOAD.${ext.toUpperCase()}` })).toBe(true);
    }
    expect(isExecutableAttachment({ originalName: 'photo.png' })).toBe(false);
    expect(isExecutableAttachment({ originalName: 'notes.txt' })).toBe(false);
    // 子串不误判（'shelloworld.txt' 的扩展名是 .txt）
    expect(isExecutableAttachment({ originalName: 'shelloworld.txt' })).toBe(false);
  });

  it('isExecutableAttachment：尾空格/尾点伪装仍被识别（n2——伪装不得绕开下载确认）', () => {
    expect(isExecutableAttachment({ originalName: 'setup.exe ' })).toBe(true);
    expect(isExecutableAttachment({ originalName: 'setup.exe...' })).toBe(true);
    expect(isExecutableAttachment({ originalName: 'setup.exe. ' })).toBe(true);
    expect(isExecutableAttachment({ originalName: 'deploy.ps1 ' })).toBe(true);
    // 归一化不制造假阳性
    expect(isExecutableAttachment({ originalName: 'README.md.' })).toBe(false);
  });
});

describe('AttachmentFileCard 渲染态', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirm.mockReset();
    mockToastError.mockReset();
    mockGet.mockReset();
  });

  it('文件名 + 大小 + 天数倒计时（永久附件不渲染倒计时）', () => {
    const { rerender } = render(
      <ul>
        <AttachmentFileCard
          attachment={att({
            originalName: 'build.log',
            sizeBytes: 2048,
            // 3 天差一点点 → ceil 仍为 3（TTL 刚写入时 diff ≈ 整档，不得跳成 N+1）
            expiresAt: new Date(Date.now() + 3 * 86_400_000 - 60_000).toISOString(),
            expired: false,
          })}
        />
      </ul>,
    );
    expect(screen.getByText('build.log')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('Expires in 3d')).toBeInTheDocument();

    rerender(
      <ul>
        <AttachmentFileCard attachment={att({ originalName: 'perm.txt', expiresAt: null })} />
      </ul>,
    );
    expect(screen.queryByTestId('attachment-expiry')).not.toBeInTheDocument();
  });

  it('临期（<24h）→ 小时倒计时', () => {
    render(
      <ul>
        <AttachmentFileCard
          attachment={att({
            originalName: 'soon.log',
            expiresAt: new Date(Date.now() + 2 * 3_600_000 - 60_000).toISOString(),
          })}
        />
      </ul>,
    );
    expect(screen.getByText('Expires in 2h')).toBeInTheDocument();
  });

  it('过期（expiresAt 已过）→ 置灰 + 下载禁用 + 「已过期」', () => {
    render(
      <ul>
        <AttachmentFileCard
          attachment={att({
            originalName: 'old.log',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
            expired: true,
          })}
        />
      </ul>,
    );
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expired' })).toBeDisabled();
  });

  it('服务端 expired=true 但 expiresAt 尚在未来 → 禁用 + 文案亦称已过期（M2：文案与禁用态同源）', () => {
    render(
      <ul>
        <AttachmentFileCard
          attachment={att({
            originalName: 'stale.log',
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            expired: true,
          })}
        />
      </ul>,
    );
    expect(screen.getByRole('button', { name: 'Expired' })).toBeDisabled();
    // M2 修订断言：禁用态已生效时，倒计时文案必须同为「已过期」——
    // 否则会出现「Expires in 1d」配灰掉按钮的自相矛盾
    expect(screen.getByTestId('attachment-expiry')).toHaveTextContent('Expired');
    expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
  });

  it('可执行扩展名 → 常驻琥珀警示 badge（不只在弹窗里）', () => {
    render(
      <ul>
        <AttachmentFileCard attachment={att({ originalName: 'setup.exe' })} />
      </ul>,
    );
    expect(screen.getByTestId('attachment-executable-badge')).toHaveTextContent('Executable');
  });

  it('普通附件不渲染可执行警示', () => {
    render(
      <ul>
        <AttachmentFileCard attachment={att({ originalName: 'photo.png' })} />
      </ul>,
    );
    expect(screen.queryByTestId('attachment-executable-badge')).not.toBeInTheDocument();
  });
});

describe('AttachmentFileCard 下载流', () => {
  let clickSpy: jest.SpyInstance;
  let createObjectURL: jest.Mock;
  let revokeObjectURL: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirm.mockReset();
    mockToastError.mockReset();
    mockGet.mockReset();
    // jsdom 无导航实现：<a>.click() 会打 "Not implemented: navigation" → 显式 stub
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    createObjectURL = jest.fn(() => 'blob:test-url');
    revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it('点击下载：axios blob → objectURL → 临时 <a download> → 延后 revoke；路径剥离 API_PREFIX', async () => {
    const blob = new Blob(['x'], { type: 'application/octet-stream' });
    mockGet.mockResolvedValue({ data: blob });
    render(
      <ul>
        <AttachmentFileCard attachment={att({ originalName: 'build.log' })} />
      </ul>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    // 请求路径已剥离 /api/v1（axiosInstance.baseURL 已含前缀，双拼会 404）
    expect(mockGet).toHaveBeenCalledWith('/attachments/att-1/content', { responseType: 'blob' });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // revoke 延后一个宏任务（立即 revoke 在部分引擎会得到空文件；0ms 延时足够）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('可执行扩展名：确认前不发请求；取消 → 不下载', async () => {
    mockConfirm.mockResolvedValue(false);
    render(
      <ul>
        <AttachmentFileCard attachment={att({ originalName: 'setup.exe' })} />
      </ul>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await act(async () => {});

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Executable file',
        description: '"setup.exe" may be executable. Download anyway?',
      }),
    );
    expect(mockGet).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('可执行扩展名：确认后照常下载', async () => {
    mockConfirm.mockResolvedValue(true);
    mockGet.mockResolvedValue({ data: new Blob(['x']) });
    render(
      <ul>
        <AttachmentFileCard attachment={att({ originalName: 'setup.exe' })} />
      </ul>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
  });

  it('过期附件：点击不发请求（按钮已禁用）', async () => {
    render(
      <ul>
        <AttachmentFileCard
          attachment={att({ expiresAt: new Date(Date.now() - 1000).toISOString(), expired: true })}
        />
      </ul>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expired' }));
    await act(async () => {});
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('下载失败（410 已过期 / 网络）→ 本地 toast，不抛错', async () => {
    mockGet.mockRejectedValue(new Error('request failed with status 410'));
    render(
      <ul>
        <AttachmentFileCard attachment={att({ originalName: 'gone.log' })} />
      </ul>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith({ title: 'Download failed, please retry' }),
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('重入闸（m3）：可执行附件确认弹窗挂起时双击 → 只弹一次确认、不发请求', async () => {
    mockConfirm.mockReturnValue(new Promise(() => {})); // 弹窗保持打开
    render(
      <ul>
        <AttachmentFileCard attachment={att({ originalName: 'setup.exe' })} />
      </ul>,
    );
    const btn = screen.getByRole('button', { name: 'Download' });

    fireEvent.click(btn);
    fireEvent.click(btn); // 弹窗打开期间连点第二次
    await act(async () => {});

    expect(mockConfirm).toHaveBeenCalledTimes(1); // sync ref 守卫生效（不排第二个确认框）
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('重入闸（m3）：普通附件请求在途时双击 → 只发一次请求', async () => {
    mockGet.mockReturnValue(new Promise(() => {})); // 请求挂起
    render(
      <ul>
        <AttachmentFileCard attachment={att({ originalName: 'slow.log' })} />
      </ul>,
    );
    const btn = screen.getByRole('button', { name: 'Download' });

    fireEvent.click(btn);
    fireEvent.click(btn);
    await act(async () => {});

    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
