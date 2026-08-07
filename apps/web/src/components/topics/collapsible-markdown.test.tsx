/**
 * collapsible-markdown.test.tsx — CollapsibleMarkdown 折叠行为契约测试（jsdom）
 *
 * 覆盖（memory/2026-08-07.md §1 消息折叠设计定稿）：
 * ① 低于阈值（scrollHeight ≤ 88px）不折叠：无按钮/遮罩，内容不设 max-height
 * ② 超过阈值默认折叠：max-height=阈值、内容 mask-image 渐隐、透明点击层与「展开全文」按钮存在
 * ③ 点击按钮展开：max-height=实测全高、渐隐移除、按钮变「收起」、chevron rotate-180
 * ④ 再点收起：回到折叠态（max-height=阈值）
 * ⑤ 点击渐隐区（透明点击层）同样展开
 * ⑥ 展开后窗口 resize 重新测量，max-height 跟随内容新高度（防断点切换截断）
 * ⑦ className 透传到外层容器（markdown 样式类由调用方提供）
 *
 * jsdom 坑位：无真实排版，scrollHeight 恒为 0——组件判定阈值与展开目标值都依赖
 * scrollHeight，测试在 Element.prototype 上 mock getter，按用例返回内容全高。
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsibleMarkdown, COLLAPSED_MAX_HEIGHT_PX } from './collapsible-markdown';

/** topics.message 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'message.expand': 'Expand',
  'message.collapse': 'Collapse',
};

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => messages[key] ?? key,
}));

/** mock 内容实测全高（jsdom scrollHeight 恒 0，见文件头注释） */
function mockScrollHeight(height: number) {
  jest.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(height);
}

/** 折叠内容容器（max-height 断言抓手） */
function contentBox(): HTMLElement {
  return screen.getByTestId('collapsible-content');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CollapsibleMarkdown 折叠行为', () => {
  it('内容高度低于阈值时不折叠：无按钮/遮罩，内容不设 max-height', () => {
    mockScrollHeight(COLLAPSED_MAX_HEIGHT_PX - 10);
    render(
      <CollapsibleMarkdown>
        <p>short content</p>
      </CollapsibleMarkdown>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('collapse-fade')).not.toBeInTheDocument();
    expect(contentBox().style.maxHeight).toBe('');
  });

  it('内容高度刚好等于阈值时也不折叠（只有严格超出才折叠）', () => {
    mockScrollHeight(COLLAPSED_MAX_HEIGHT_PX);
    render(<CollapsibleMarkdown>exactly three lines</CollapsibleMarkdown>);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(contentBox().style.maxHeight).toBe('');
  });

  it('超过阈值时默认折叠：max-height=阈值，内容渐隐，显示点击层与「展开全文」按钮', () => {
    mockScrollHeight(300);
    render(<CollapsibleMarkdown>long content</CollapsibleMarkdown>);

    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('collapse-fade')).toBeInTheDocument();
    expect(contentBox().style.maxHeight).toBe(`${COLLAPSED_MAX_HEIGHT_PX}px`);
    // 内容自身 mask-image 渐隐（与气泡底色无关的主题色自适配手段）
    expect(contentBox().style.maskImage).toContain('linear-gradient');
  });

  it('点击按钮展开：max-height=实测全高，渐隐移除，按钮变「收起」，chevron rotate-180', () => {
    mockScrollHeight(300);
    render(<CollapsibleMarkdown>long content</CollapsibleMarkdown>);

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    expect(contentBox().style.maxHeight).toBe('300px');
    // 展开后渐隐移除，内容完整呈现
    expect(contentBox().style.maskImage).toBe('');
    const collapseBtn = screen.getByRole('button', { name: 'Collapse' });
    expect(collapseBtn).toBeInTheDocument();
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');
    // chevron 旋转：transform 过渡类（UI 动效红线允许 transform/opacity）；
    // 注意 SVG className 在 jsdom 中是 SVGAnimatedString，须用 getAttribute
    expect(collapseBtn.querySelector('svg')?.getAttribute('class')).toContain('rotate-180');
    // 展开后透明点击层不再遮挡内容
    expect(screen.queryByTestId('collapse-fade')).not.toBeInTheDocument();
  });

  it('再点收起：回到折叠态（max-height=阈值，按钮变回「展开全文」）', () => {
    mockScrollHeight(300);
    render(<CollapsibleMarkdown>long content</CollapsibleMarkdown>);

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));

    expect(contentBox().style.maxHeight).toBe(`${COLLAPSED_MAX_HEIGHT_PX}px`);
    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument();
    expect(screen.getByTestId('collapse-fade')).toBeInTheDocument();
  });

  it('点击渐隐区（透明点击层）同样展开', () => {
    mockScrollHeight(300);
    render(<CollapsibleMarkdown>long content</CollapsibleMarkdown>);

    fireEvent.click(screen.getByTestId('collapse-fade'));

    expect(contentBox().style.maxHeight).toBe('300px');
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
  });

  it('展开后窗口 resize：重新测量，max-height 跟随内容新高度（防断点切换截断）', () => {
    mockScrollHeight(300);
    render(<CollapsibleMarkdown>long content</CollapsibleMarkdown>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(contentBox().style.maxHeight).toBe('300px');

    // 窗口变窄 → 换行增多 → 内容变高，resize 后 max-height 应刷新为新实测值
    mockScrollHeight(500);
    fireEvent(window, new Event('resize'));

    expect(contentBox().style.maxHeight).toBe('500px');
  });

  it('className 透传到外层容器（markdown 样式类与气泡条件覆盖由调用方提供）', () => {
    mockScrollHeight(300);
    const { container } = render(
      <CollapsibleMarkdown className="text-sm [&_strong]:text-primary">
        long content
      </CollapsibleMarkdown>,
    );

    expect(container.firstChild).toHaveClass('text-sm');
    expect(container.firstChild).toHaveClass('[&_strong]:text-primary');
  });
});
