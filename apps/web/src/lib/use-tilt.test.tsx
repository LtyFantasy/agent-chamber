/**
 * use-tilt.test.ts — useTilt hook 行为契约测试（jsdom）
 *
 * 覆盖（plans/magik-pantha-static.md §步骤5）：
 * ① reduced-motion → 不挂 listener、不写 transform
 * ② 非精密指针（hover: none）→ 同上
 * ③ 正常环境：pointermove 写 rotateX/rotateY，pointerleave 清空
 * ④ pointercancel / window blur → 异常复位清空
 * ⑤ 卸载 → listener 全清理（卸载后派发事件不再写入、不报错）
 *
 * jsdom 坑位：无 matchMedia / getBoundingClientRect 全零 / rAF 需 pretendToBeVisual——
 * 全部在本文件内 mock，不改 jest.setup.js（避免影响其他测试）。
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { useTilt } from './use-tilt';

/** 按测试场景控制 matchMedia 命中结果 */
function mockMatchMedia({ reduced = false, finePointer = true } = {}) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduced : finePointer,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
}

/** 测试组件：默认参数挂 tilt */
function TiltBox({ disabled = false }: { disabled?: boolean }) {
  const ref = useTilt<HTMLDivElement>(undefined, disabled);
  return <div ref={ref} data-testid="box" />;
}

/** jsdom rect 全零会触发除零防御，mock 100×100 画布 */
function mockRect(el: HTMLElement) {
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** 等一帧（rAF polyfill 为 setTimeout 0） */
async function nextFrame() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

beforeAll(() => {
  // jsdom 坑（实测）：window.requestAnimationFrame 存在但 pretendToBeVisual 未开时
  // 帧回调永不触发——无条件覆盖为 setTimeout 版，保证测试内帧可推进
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0)) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
});

/** jsdom 无 PointerEvent，fireEvent.pointerMove 会丢 clientX（实测为 undefined）——
 *  用 MouseEvent 构造同名事件，clientX/clientY 才能带上 */
function pointer(type: string, x = 0, y = 0): MouseEvent {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useTilt', () => {
  it('reduced-motion 命中时不挂 listener、pointermove 不写 transform', async () => {
    mockMatchMedia({ reduced: true });
    render(<TiltBox />);
    const box = screen.getByTestId('box');
    mockRect(box);

    fireEvent(box, pointer('pointerenter'));
    fireEvent(box, pointer('pointermove', 75, 25));
    await nextFrame();

    expect(box.style.transform).toBe('');
    expect(box.style.transition).toBe('');
  });

  it('非精密指针（触屏）时不挂 listener、不写 transform', async () => {
    mockMatchMedia({ finePointer: false });
    render(<TiltBox />);
    const box = screen.getByTestId('box');
    mockRect(box);

    fireEvent(box, pointer('pointerenter'));
    fireEvent(box, pointer('pointermove', 75, 25));
    await nextFrame();

    expect(box.style.transform).toBe('');
    expect(box.style.transition).toBe('');
  });

  it('正常环境：pointermove 写 rotateX/rotateY，pointerleave 清空', async () => {
    mockMatchMedia();
    render(<TiltBox />);
    const box = screen.getByTestId('box');
    mockRect(box);

    // clientX 75/100 → px=0.25；clientY 25/100 → py=-0.25；默认 max=6
    // → rotateX = py*2*6 = -3deg，rotateY = -px*2*6 = -3deg
    fireEvent(box, pointer('pointerenter'));
    fireEvent(box, pointer('pointermove', 75, 25));
    await nextFrame();

    expect(box.style.transform).toContain('rotateX(-3.00deg)');
    expect(box.style.transform).toContain('rotateY(-3.00deg)');
    expect(box.style.transform).toContain('perspective(1000px)');

    fireEvent(box, pointer('pointerleave'));
    expect(box.style.transform).toBe('');
  });

  it('pointercancel 与 window blur 均触发异常复位清空 transform', async () => {
    mockMatchMedia();
    render(<TiltBox />);
    const box = screen.getByTestId('box');
    mockRect(box);

    // pointercancel 路径
    fireEvent(box, pointer('pointermove', 75, 25));
    await nextFrame();
    expect(box.style.transform).toContain('rotateX');
    fireEvent(box, pointer('pointercancel'));
    expect(box.style.transform).toBe('');

    // window blur 路径
    fireEvent(box, pointer('pointermove', 75, 25));
    await nextFrame();
    expect(box.style.transform).toContain('rotateX');
    fireEvent.blur(window);
    expect(box.style.transform).toBe('');
  });

  it('卸载后 listener 全清理：派发事件不再写入且不报错', async () => {
    mockMatchMedia();
    const { unmount } = render(<TiltBox />);
    const box = screen.getByTestId('box');
    mockRect(box);

    fireEvent(box, pointer('pointermove', 75, 25));
    await nextFrame();
    expect(box.style.transform).toContain('rotateX');

    unmount();
    // 卸载后派发事件：listener 已移除，不写入、不抛错
    expect(() => {
      fireEvent(box, pointer('pointermove', 10, 10));
      fireEvent.blur(window);
    }).not.toThrow();
    await nextFrame();
    expect(box.style.transform).toContain('rotateX'); // 保持卸载前状态，未被改写
  });
});
