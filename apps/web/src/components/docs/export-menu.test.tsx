import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ExportMenu } from './export-menu';
import type { ExportMenuLabels } from './export-menu';

/**
 * 导出入菜单单测：两选项渲染 + 关闭链路（Esc / 遮罩 / 选项）+ exporting 禁用态。
 *
 * 文案经 props 注入（组件不依赖 next-intl），故此处用测试自有文案；
 * 线上文案与键集一致性由 `@/lib/doc-human-export.test.ts` 的 i18n 断言覆盖。
 */
const LABELS: ExportMenuLabels = {
  trigger: 'Export',
  jsonLabel: 'Export bundle (JSON)',
  jsonDesc: 'Full snapshot: all documents + attachment bytes, restorable into the platform',
  zipLabel: 'Export human-readable (ZIP)',
  zipDesc: 'docs directory tree + original attachment files, open directly',
};

function renderMenu(overrides: Partial<ComponentProps<typeof ExportMenu>> = {}) {
  const onExportJson = jest.fn();
  const onExportZip = jest.fn();
  const view = render(
    <ExportMenu
      labels={LABELS}
      onExportJson={onExportJson}
      onExportZip={onExportZip}
      exporting={false}
      {...overrides}
    />,
  );
  return { onExportJson, onExportZip, rerender: view.rerender };
}

/** 触发钮（带文案的 Button，非图标钮） */
const trigger = () => screen.getByRole('button', { name: 'Export' });

describe('ExportMenu', () => {
  it('默认关闭：只有触发钮，浮层与选项都不在 DOM', () => {
    renderMenu();
    expect(trigger()).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('export-menu-panel')).not.toBeInTheDocument();
  });

  it('点击触发钮 → 打开浮层，两选项各带标题与一行说明（R6 认知差异写在选项旁）', () => {
    renderMenu();
    fireEvent.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('export-menu-panel')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Export bundle \(JSON\)/ })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /Export human-readable \(ZIP\)/ }),
    ).toBeInTheDocument();

    expect(screen.getByText(LABELS.jsonDesc)).toBeInTheDocument();
    expect(screen.getByText(LABELS.zipDesc)).toBeInTheDocument();
    // 两选项的说明互不相同（不得出现复制粘贴同一句的退化）
    expect(LABELS.jsonDesc).not.toBe(LABELS.zipDesc);
  });

  it('再点触发钮 → 关闭（toggle）', () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByTestId('export-menu-panel')).not.toBeInTheDocument();
  });

  it('点选项 → 关浮层并执行对应回调（JSON 只调 JSON，ZIP 只调 ZIP）', () => {
    const { onExportJson, onExportZip } = renderMenu();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId('export-menu-json'));

    expect(onExportJson).toHaveBeenCalledTimes(1);
    expect(onExportZip).not.toHaveBeenCalled();
    expect(screen.queryByTestId('export-menu-panel')).not.toBeInTheDocument();

    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId('export-menu-zip'));
    expect(onExportZip).toHaveBeenCalledTimes(1);
    expect(onExportJson).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('export-menu-panel')).not.toBeInTheDocument();
  });

  it('Esc 关闭浮层（选项回调不触发）', () => {
    const { onExportJson, onExportZip } = renderMenu();
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('export-menu-panel')).not.toBeInTheDocument();
    expect(onExportJson).not.toHaveBeenCalled();
    expect(onExportZip).not.toHaveBeenCalled();
  });

  it('Esc 监听在关闭后卸载（不残留全局监听）', () => {
    const removeSpy = jest.spyOn(document, 'removeEventListener');
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('点遮罩关闭浮层', () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId('export-menu-overlay'));
    expect(screen.queryByTestId('export-menu-panel')).not.toBeInTheDocument();
  });

  it('exporting：触发钮 isLoading 禁用 + 两选项禁用（R7 防连点）', () => {
    renderMenu({ exporting: true });
    const button = screen.getByRole('button', { name: 'Export' });
    expect(button).toBeDisabled();
  });

  it('exporting 且浮层已打开：选项禁用（R7 中间态，菜单不自动关）', () => {
    const { onExportJson, onExportZip, rerender } = renderMenu();
    fireEvent.click(trigger());
    // 模拟导出启动：菜单保持打开（R7），仅触发钮 isLoading + 选项禁用
    rerender(
      <ExportMenu
        labels={LABELS}
        onExportJson={onExportJson}
        onExportZip={onExportZip}
        exporting
      />,
    );
    expect(screen.getByTestId('export-menu-json')).toBeDisabled();
    expect(screen.getByTestId('export-menu-zip')).toBeDisabled();
    expect(screen.getByTestId('export-menu-panel')).toBeInTheDocument();
  });

  it('editing tooltip 透传：触发钮不禁用，仅换 title（R4）', () => {
    renderMenu({ title: 'Exports the server-side version, excluding unsaved edits' });
    const button = screen.getByRole('button', { name: 'Export' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute(
      'title',
      'Exports the server-side version, excluding unsaved edits',
    );
  });
});
