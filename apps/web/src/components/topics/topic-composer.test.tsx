/**
 * topic-composer.test.tsx — 圆桌输入框 @ 补全 + 高亮交互契约测试（jsdom，M2 web 批次）
 *
 * 覆盖：
 * ① 退化态（mentionTargets 缺省 = 普通 topic）：输入 @ 不弹补全框、不高亮
 *    （无 mark 元素）、textarea 文字不透明、Enter 直接发送
 * ② 补全框：输入 @ 弹出且 @all 置顶（右侧 i18n 说明）；继续输入前缀过滤；
 *    无匹配显示 i18n 空态行
 * ③ 键盘：Enter/Tab 选中插入 `@label `（含尾部空格）且不触发 onSend；
 *    ↑↓ 循环导航；Esc 关闭后 Enter 恢复发送；空 query 直接 Enter 选 @all
 * ④ 点击选中；补全框开时 Enter 禁止发送
 *
 * 受控流经 Harness 包装（onChange → setValue → rerender），模拟 page 真实数据流；
 * next-intl 按文案快照 mock（同 roundtable-mention-hint.test.tsx 先例）。
 */

import { useState } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopicComposer } from './topic-composer';
import { confirm } from '@/lib/notify';

/** topics.message 命名空间的英语文案快照（同 en.json；未命中 key 回退完整路径） */
const messages: Record<string, string> = {
  'message.mentionAllDesc': 'Notify all seats',
  'message.mentionNoMatch': 'No matching seat',
  'message.allWakeTitle': 'Wake all seats',
  'message.allWakeConfirm': 'This will wake all {count} seats. Send anyway?',
};

// 全局 confirm（lib/notify）mock：window.confirm 替换批次后，@all 闸门改走
// 异步 Promise 确认——测试用 mockResolvedValue 控制结果 + await act 结算
jest.mock('@/lib/notify', () => ({
  confirm: jest.fn(),
}));
const mockConfirm = confirm as jest.Mock;

beforeEach(() => {
  mockConfirm.mockReset();
});

jest.mock('next-intl', () => ({
  // 文案快照 + {count} 插值（@all 闸门确认框断言 N 用；其余 key 无参数不受影响）
  useTranslations: () => (key: string, opts?: { count?: number }) => {
    const tpl = messages[key] ?? key;
    return opts && typeof opts.count === 'number'
      ? tpl.replace('{count}', String(opts.count))
      : tpl;
  },
}));

/** 受控包装：onChange 同步 value，模拟 page 的真实受控流 */
function Harness({
  onSend,
  mentionTargets,
}: {
  onSend: () => void;
  mentionTargets?: string[] | null;
}) {
  const [value, setValue] = useState('');
  return (
    <TopicComposer
      value={value}
      onChange={setValue}
      onSend={onSend}
      placeholder="Type a message..."
      mentionTargets={mentionTargets}
    />
  );
}

/** 圆桌 active 座位 label（模拟 GET /roundtable/seats 过滤后） */
const SEATS = ['kimi-1', 'codex-1'];

function textareaOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

describe('TopicComposer 退化态（普通 topic，mentionTargets 缺省）', () => {
  it('输入 @ 不弹补全框、不高亮（无 mark 元素）、文字不透明', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, 'hello @kimi');

    expect(screen.queryByText('@all')).not.toBeInTheDocument();
    expect(container.querySelector('mark')).toBeNull();
    expect(ta.className).not.toContain('text-transparent');
  });

  it('Enter 直接发送（无补全框拦截）', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, 'hello{Enter}');

    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('TopicComposer 圆桌 @ 补全', () => {
  it('输入 @ → 补全框出现且 @all 置顶（第一候选）+ 全部座位可见', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@');

    // @all 置顶：DOM 顺序上先于第一个座位候选
    const candidateButtons = Array.from(container.querySelectorAll('button'));
    expect(candidateButtons[0]?.textContent).toContain('@all');
    expect(candidateButtons[0]?.textContent).toContain('Notify all seats');
    expect(screen.getByText('@kimi-1')).toBeInTheDocument();
    expect(screen.getByText('@codex-1')).toBeInTheDocument();
  });

  it('继续输入过滤：@ki → 只剩 kimi-1', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');

    expect(screen.getByText('@kimi-1')).toBeInTheDocument();
    expect(screen.queryByText('@codex-1')).not.toBeInTheDocument();
  });

  it('无匹配座位 → i18n 空态行（不可选）', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@zzz');

    expect(screen.getByText('No matching seat')).toBeInTheDocument();
  });

  it('Enter 选中第一个匹配座位：插入 `@kimi-1 `（含尾部空格）且不触发 onSend', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');
    await user.keyboard('{Enter}');

    expect(ta.value).toBe('@kimi-1 ');
    expect(onSend).not.toHaveBeenCalled();
    // 补全框已关闭
    expect(screen.queryByText('Notify all seats')).not.toBeInTheDocument();
    // caret 移到插入文本之后（空格后）
    await waitFor(() => expect(ta.selectionStart).toBe(8));
  });

  it('空 query 直接 Enter → 选 @all（广播快捷路径）', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@{Enter}');

    expect(ta.value).toBe('@all ');
  });

  it('Tab 选中候选（与 Enter 同语义）', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');
    await user.keyboard('{Tab}');

    expect(ta.value).toBe('@kimi-1 ');
  });

  it('↑↓ 循环导航：query 非空默认高亮首个座位，↑ 循环回 @all', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');
    await user.keyboard('{ArrowUp}{Enter}');

    expect(ta.value).toBe('@all ');
  });

  it('Esc 关闭补全框：随后 Enter 恢复发送', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@ki');
    expect(screen.getByText('@kimi-1')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByText('@kimi-1')).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('点击选中 @all：插入 `@all `', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness onSend={jest.fn()} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@');
    await user.click(screen.getByText('@all'));

    expect(ta.value).toBe('@all ');
  });

  it('补全框开时 Enter 不发送（即使已有非空正文）', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, 'hey @ki{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe('hey @kimi-1 ');
  });
});

describe('TopicComposer @all 闸门（M3 阶段 3，r13；全局 confirm 替换 window.confirm 批次）', () => {
  it('命中 @all + 有 active 座位 → 弹确认框（N = 座位数）；取消不发送', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(false); // 取消
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@all 开会{Enter}');
    await act(async () => {}); // 结算 confirm Promise（异步确认无同步阻塞）

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        // N = SEATS.length = 2
        description: expect.stringContaining('wake all 2 seats'),
      }),
    );
    expect(onSend).not.toHaveBeenCalled(); // 取消不发送
  });

  it('确认后发送（Enter 路径）', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(true);
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@all 全体{Enter}');
    await act(async () => {});

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('确认后发送（发送按钮路径）', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(true);
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);

    await user.type(screen.getByPlaceholderText('Type a message...'), '@all 全体');
    // 补全框已关闭时组件内唯一 button = 发送按钮（图标无文字，按位置取）
    await user.click(container.querySelector('button') as HTMLButtonElement);
    await act(async () => {});

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('发送守卫：确认弹窗打开期间重复触发被忽略（不排队第二个 confirm）', async () => {
    const user = userEvent.setup();
    // 第一个 confirm 挂起（pending）：模拟弹窗打开中
    mockConfirm.mockReturnValue(new Promise(() => {}));
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);

    await user.type(screen.getByPlaceholderText('Type a message...'), '@all 连点');
    const sendBtn = container.querySelector('button') as HTMLButtonElement;
    await user.click(sendBtn);
    await user.click(sendBtn); // 弹窗打开期间连点第二次

    expect(mockConfirm).toHaveBeenCalledTimes(1); // 守卫生效：只排一个确认框
    expect(onSend).not.toHaveBeenCalled();
  });

  it('无 @all（定向 @座位）→ 零感知直发，不弹确认', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    await user.type(ta, '@kimi-1 定向{Enter}');

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('@all 在代码块内 → 不算提及（剥噪口径镜像），不弹确认直发', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={SEATS} />);
    const ta = textareaOf(container);

    // Shift+Enter 插入换行（不触发发送），最后的 Enter 才是发送
    await user.type(
      ta,
      '```[ShiftLeft>][Enter][/ShiftLeft]@all 代码内[ShiftLeft>][Enter][/ShiftLeft]```{Enter}',
    );

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('零座位（mentionTargets=[]）→ 无可唤醒，不弹确认直发', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} mentionTargets={[]} />);
    const ta = textareaOf(container);

    await user.type(ta, '@all 没人{Enter}');

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('普通 topic（mentionTargets 缺省）→ 零感知直发，不弹确认', async () => {
    const user = userEvent.setup();
    const onSend = jest.fn();
    const { container } = render(<Harness onSend={onSend} />);
    const ta = textareaOf(container);

    await user.type(ta, '@all 普通桌{Enter}');

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
