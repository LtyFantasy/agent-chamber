/**
 * switch.test.tsx — 手写 Switch 的**行为契约**测试（plan §D6 硬约束：零 radix）。
 *
 * 测的是"用户感知到的东西"，不是实现细节：
 * - 语义：`role="switch"` + `aria-checked`（读屏播报开/关的依据）；
 * - 交互：点击 / 键盘 Space、Enter 都发 `onCheckedChange(!checked)`；
 * - 受控：组件自己不翻状态（点击后 aria-checked 不变，直到调用方改 `checked`）——
 *   偏好区的 optimistic 回滚正是建立在"组件不自持状态"上；
 * - 禁用：不发回调、可聚焦性由 `<button disabled>` 保证；
 * - 动效红线：滑块位移走 `translate-x`（transform），且带 `motion-reduce:transition-none`
 *   （prefers-reduced-motion 下降级为跳变，不是"缩短时长"）。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Switch } from './switch';

describe('Switch（手写、零 radix）', () => {
  it('渲染为 role=switch 且 aria-checked 跟随 checked', () => {
    const { rerender } = render(<Switch checked={false} aria-label="启用通知" />);
    const control = screen.getByRole('switch', { name: '启用通知' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(control).toHaveAttribute('data-state', 'unchecked');
    expect(control).toHaveAttribute('type', 'button');

    rerender(<Switch checked aria-label="启用通知" />);
    expect(screen.getByRole('switch', { name: '启用通知' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: '启用通知' })).toHaveAttribute(
      'data-state',
      'checked',
    );
  });

  it('点击发出相反值（开→关心关闭意图）', async () => {
    const onCheckedChange = jest.fn();
    render(<Switch checked aria-label="启用通知" onCheckedChange={onCheckedChange} />);
    await userEvent.click(screen.getByRole('switch', { name: '启用通知' }));
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('键盘 Space / Enter 均可切换（无鼠标也能用）', async () => {
    const onCheckedChange = jest.fn();
    render(<Switch checked={false} aria-label="启用通知" onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: '启用通知' });

    control.focus();
    expect(control).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);

    await userEvent.keyboard('{Enter}');
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    expect(onCheckedChange).toHaveBeenCalledTimes(2);
  });

  it('受控语义：点击后自身不翻状态（等调用方决定）', async () => {
    const onCheckedChange = jest.fn();
    render(<Switch checked={false} aria-label="启用通知" onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: '启用通知' });
    await userEvent.click(control);
    // 没 rerender ⇒ 状态必须保持 false（否则"失败回滚"会变成"界面已经翻过去了"）
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('disabled：不发回调、标记 aria-disabled', async () => {
    const onCheckedChange = jest.fn();
    render(
      <Switch checked={false} aria-label="启用通知" disabled onCheckedChange={onCheckedChange} />,
    );
    const control = screen.getByRole('switch', { name: '启用通知' });
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(control);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('无 onCheckedChange 时点击不崩（可选回调）', async () => {
    render(<Switch checked={false} aria-label="启用通知" />);
    await expect(
      userEvent.click(screen.getByRole('switch', { name: '启用通知' })),
    ).resolves.toBeUndefined();
  });

  it('动效红线：位移只用 transform，且 reduced-motion 下过渡取消', () => {
    render(<Switch checked aria-label="启用通知" data-testid="sw" />);
    const control = screen.getByTestId('sw');
    const knob = control.querySelector('span') as HTMLElement;

    // 轨道颜色过渡 + 滑块 transform 过渡（不出现 left/top/width 动画）
    expect(control.className).toContain('transition-colors');
    expect(knob.className).toContain('transition-transform');
    expect(knob.className).toContain('translate-x-5');
    expect(knob.className).toContain('motion-reduce:transition-none');
    expect(control.className).toContain('motion-reduce:transition-none');
    for (const forbidden of ['transition-all', 'animate-', 'left-', 'top-']) {
      expect(knob.className).not.toContain(forbidden);
    }
  });

  it('未选中时滑块位移归零（两态只差 transform，尺寸不闪）', () => {
    render(<Switch checked={false} aria-label="启用通知" data-testid="sw" />);
    const knob = screen.getByTestId('sw').querySelector('span') as HTMLElement;
    expect(knob.className).toContain('translate-x-0');
    expect(knob.className).toContain('h-5');
    expect(knob.className).toContain('w-5');
  });

  it('sm 尺寸用于密集列表行（尺寸与位移按比例收窄）', () => {
    render(<Switch checked aria-label="启用通知" size="sm" data-testid="sw" />);
    const control = screen.getByTestId('sw');
    const knob = control.querySelector('span') as HTMLElement;
    expect(control.className).toContain('h-5');
    expect(control.className).toContain('w-9');
    expect(knob.className).toContain('translate-x-4');
  });

  it('有可见 focus ring（键盘可达性基线）', () => {
    render(<Switch checked={false} aria-label="启用通知" data-testid="sw" />);
    const control = screen.getByTestId('sw');
    expect(control.className).toContain('focus-visible:ring-2');
    expect(control.className).toContain('focus-visible:ring-ring');
  });
});
