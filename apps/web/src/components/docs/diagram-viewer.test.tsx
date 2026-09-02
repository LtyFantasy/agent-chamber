import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiagramViewer } from './diagram-viewer';
import { Api } from '@/lib/api';

/** 本测试用到的文案快照（同 en.json；未命中 key 回退为完整 key 路径，不影响断言） */
const messages: Record<string, string> = {
  'common.retry': 'Retry',
  'docs.diagram.viewerTitle': 'Diagram preview',
  'docs.diagram.loadFailed': 'Failed to load diagram',
  'docs.diagram.loadFailedDesc':
    'The diagram snapshot could not be loaded. Please retry, or re-save the diagram through an agent tool.',
  'docs.diagram.fullscreen': 'Fullscreen',
  'docs.diagram.exitFullscreen': 'Exit fullscreen',
};

jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    return messages[fullKey] ?? fullKey;
  },
  // DIAGRAM-WEB-004：DiagramViewer 用 useLocale 进 queryKey/请求参数，mock 必须提供
  useLocale: () => 'en',
}));

jest.mock('@/lib/api', () => ({
  Api: {
    docs: {
      getDiagramHtml: jest.fn(),
    },
  },
}));

const mockApi = Api.docs as unknown as { getDiagramHtml: jest.Mock };

/** 可控 Promise（pending 态断言用）：先断言 loading，再 act 内 resolve 收尾 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderViewer() {
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DiagramViewer docId="doc-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('DiagramViewer（Diagram IR v1 web 预览）', () => {
  it('loading 态：渲染 Loading（无 iframe），数据到达后卸载 Loading', async () => {
    const d = deferred<string>();
    mockApi.getDiagramHtml.mockReturnValue(d.promise);

    renderViewer();

    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByTitle('Diagram preview')).not.toBeInTheDocument();
    expect(mockApi.getDiagramHtml).toHaveBeenCalledWith('doc-1', 'en');

    await act(async () => {
      d.resolve('<svg/>');
    });
    await waitFor(() => {
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument();
    });
  });

  it('loaded 态：iframe srcdoc 挂载，sandbox 精确授予 allow-scripts allow-downloads（无 allow-same-origin/allow-top-navigation/allow-modals）', async () => {
    const html = '<svg viewBox="0 0 100 100"><rect width="10" height="10"/></svg>';
    mockApi.getDiagramHtml.mockResolvedValue(html);

    renderViewer();

    const iframe = await screen.findByTitle('Diagram preview');
    expect(iframe).toHaveAttribute('srcDoc', html);
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-downloads');
    expect(iframe).toHaveAttribute('referrerPolicy', 'no-referrer');
    // clipboard-write 委托（DIAGRAM-WEB-006）：复制图片在 sandbox iframe 内需
    // Permissions-Policy 放行，缺则写入被 permissions policy 拦截（2026-09-02 A/B 实证）
    expect(iframe).toHaveAttribute('allow', 'clipboard-write');
    // 安全不变量（plan §5.2）：不透明源语义——禁止 allow-same-origin / allow-top-navigation / allow-modals
    expect(iframe.getAttribute('sandbox') ?? '').not.toContain('allow-same-origin');
    expect(iframe.getAttribute('sandbox') ?? '').not.toContain('allow-top-navigation');
    expect(iframe.getAttribute('sandbox') ?? '').not.toContain('allow-modals');
  });

  it('loaded 态：含 <head> 的快照注入整形桩（DIAGRAM-WEB-003：钉死 dark + embed 纯画布 + 捞回工具栏）；无 <head> 原样透传', async () => {
    const html = '<html><head><title>t</title></head><body><svg/></body></html>';
    mockApi.getDiagramHtml.mockResolvedValue(html);

    const { unmount } = renderViewer();

    // 有 <head>：桩脚本紧随其后（先于模板主题解析脚本执行），原文完整保留
    const iframe = await screen.findByTitle('Diagram preview');
    const srcDoc = iframe.getAttribute('srcdoc') ?? '';
    const pinIdx = srcDoc.indexOf('window.matchMedia=function(q)');
    expect(pinIdx).toBeGreaterThan(-1);
    expect(srcDoc.indexOf('<head>')).toBeLessThan(pinIdx);
    // embed 纯画布：设 data-embed + 捞回工具栏 + 隐藏死按钮 btn-present
    expect(srcDoc).toContain("setAttribute('data-embed','true')");
    expect(srcDoc).toContain('html[data-embed="true"] body .toolbar{display:flex !important;}');
    expect(srcDoc).toContain('#btn-present{display:none !important;}');
    // 捞回缩放条（仅 data-view 三按钮；route/radar/lens/finder/guide 面板被 embed 隐藏，藏掉防死按钮）
    expect(srcDoc).toContain(
      'html[data-embed="true"] body .diagram-nav{display:inline-flex !important;}',
    );
    expect(srcDoc).toContain('.diagram-nav > button:not([data-view]){display:none !important;}');
    expect(srcDoc).toContain('<title>t</title>');

    // 无 <head>（防御非模板来源快照）：原样透传不注入
    unmount();
    mockApi.getDiagramHtml.mockResolvedValue('<svg/>');
    renderViewer();
    const iframe2 = await screen.findAllByTitle('Diagram preview');
    expect(iframe2[iframe2.length - 1]).toHaveAttribute('srcDoc', '<svg/>');
  });

  it('全屏：父侧按钮渲染 + 点击请求/退出 fullscreen（Esc 退出经 fullscreenchange 复位图标）', async () => {
    // jsdom 无 Fullscreen API——打桩验证调用语义
    const requestFs = jest.fn().mockResolvedValue(undefined);
    const exitFs = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      value: requestFs,
      configurable: true,
    });
    Object.defineProperty(document, 'exitFullscreen', { value: exitFs, configurable: true });
    Object.defineProperty(document, 'fullscreenElement', {
      get: () => null,
      configurable: true,
    });

    mockApi.getDiagramHtml.mockResolvedValue('<svg/>');
    renderViewer();

    await screen.findByTitle('Diagram preview');
    const btn = screen.getByRole('button', { name: 'Fullscreen' });
    fireEvent.click(btn);
    expect(requestFs).toHaveBeenCalledTimes(1);

    // Esc 等外部退出：fullscreenchange 事件驱动图标复位（fullscreenElement 仍 null → 保持 Maximize）
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
  });

  it('error 态：EmptyState + 重试（重新拉取成功后渲染 iframe）', async () => {
    mockApi.getDiagramHtml.mockRejectedValueOnce(new Error('boom'));
    mockApi.getDiagramHtml.mockResolvedValueOnce('<svg/>');

    renderViewer();

    expect(await screen.findByText('Failed to load diagram')).toBeInTheDocument();
    expect(screen.queryByTitle('Diagram preview')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const iframe = await screen.findByTitle('Diagram preview');
    expect(mockApi.getDiagramHtml).toHaveBeenCalledTimes(2);
    expect(iframe).toHaveAttribute('srcDoc', '<svg/>');
  });
});
