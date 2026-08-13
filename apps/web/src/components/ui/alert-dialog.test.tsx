/**
 * alert-dialog.test.tsx — 声明式 AlertDialog 契约测试（jsdom）。
 *
 * 覆盖：渲染（title/description/确认/取消按钮）、确认/取消回调、
 * Esc=取消、遮罩点击=取消（dismissable 开关）、danger 变体按钮类名、
 * autoFocus 确认钮、alertdialog 无障碍角色。
 *
 * 注意：组件 createPortal 到 document.body，查询一律从 body 顶层找
 * `[role="alertdialog"]`（portal 内容不在 render 返回的 container 内）。
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { AlertDialog } from './alert-dialog';

function renderDialog(overrides: Partial<Parameters<typeof AlertDialog>[0]> = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  const onOpenChange = jest.fn();
  render(
    <AlertDialog
      open
      title="Delete message"
      description="This action is irreversible."
      confirmText="Delete"
      cancelText="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
      onOpenChange={onOpenChange}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel, onOpenChange };
}

describe('AlertDialog', () => {
  it('渲染 title / description / 确认 / 取消按钮，并带 alertdialog 无障碍角色', () => {
    renderDialog();

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Delete message')).toBeInTheDocument();
    expect(screen.getByText('This action is irreversible.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('打开时 autoFocus 确认按钮（默认焦点落主操作，键盘用户直接回车确认）', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it('title/description 与 aria-labelledby/aria-describedby 关联（读屏语境）', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    const title = screen.getByText('Delete message');
    const desc = screen.getByText('This action is irreversible.');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(dialog.getAttribute('aria-describedby')).toBe(desc.id);
  });

  it('确认按钮 → onConfirm', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('取消按钮 → onCancel（不触发 onConfirm）', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Esc → onCancel（取消路径，不触发 onOpenChange）', () => {
    const { onCancel, onOpenChange } = renderDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('遮罩点击（dismissable 默认）→ onCancel + onOpenChange(false)', () => {
    const { onCancel, onOpenChange } = renderDialog();
    // portal 结构：role=alertdialog > Dialog 根 > 第一个子 div = 遮罩
    const dialog = document.body.querySelector('[role="alertdialog"]');
    const overlay = dialog?.firstElementChild?.firstElementChild as HTMLElement;
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('dismissable=false → 遮罩点击忽略（用户必须显式选择）', () => {
    const { onCancel, onOpenChange } = renderDialog({ dismissable: false });
    const dialog = document.body.querySelector('[role="alertdialog"]');
    const overlay = dialog?.firstElementChild?.firstElementChild as HTMLElement;
    fireEvent.click(overlay);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('confirmVariant="danger" → 确认钮 destructive 类（红钮克制无渐变）', () => {
    renderDialog({ confirmVariant: 'danger' });
    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    expect(confirmBtn).toHaveClass('bg-destructive');
    expect(confirmBtn.className).not.toContain('bg-gradient-to-r');
  });

  it('confirmVariant 缺省 → 确认钮 default 渐变主钮', () => {
    renderDialog();
    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    expect(confirmBtn).toHaveClass('bg-gradient-to-r');
  });

  it('open=false → 不渲染任何内容（portal 内无弹窗）', () => {
    render(
      <AlertDialog
        open={false}
        title="T"
        confirmText="OK"
        cancelText="No"
        onConfirm={() => {}}
        onCancel={() => {}}
        onOpenChange={() => {}}
      />,
    );
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
