/**
 * message-bubble.test.tsx — 圆桌消息气泡渲染契约测试（jsdom，M2 阶段 6）
 *
 * 覆盖：
 * ① seatLabel badge：backend 透传 seatLabel 时 senderName 旁渲染 badge（文案即 label
 *    本身）；无 seatLabel 时不渲染（两态）
 * ② thinking 过程折叠：type='thinking' 无条件默认折叠为「过程记录」摘要行
 *    （不依赖 CollapsibleMarkdown 的实测高度阈值——短内容也折叠），点击展开完整
 *    markdown，再点收起；aria-expanded 双态
 * ③ 非 thinking 消息不回归：不出现 thinking 折叠开关，内容照常渲染
 * ④ system 发送者：渲染为居中系统公告条（无 senderName/气泡附件，仅正文 + 时间，
 *    M3 验收 P2 bug 修复——公告不是「名为 System 的 Agent 在发言」）
 * ⑤ 系统公告条折叠（M3 验收第二批）：正文默认 truncate 单行；scrollWidth > clientWidth
 *    溢出检测（jsdom 恒 0，用 Object.defineProperty mock）决定 chevron 是否出现；
 *    点击展开完整正文 + aria-expanded 翻转，再点收起
 *
 * 依赖 stub：react-markdown/remark-gfm 为纯 ESM（Jest 不转换 node_modules），
 * 同 docs 页测试先例 stub 成透传容器；next-intl 按文案快照 mock。
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { MessageBubble } from './message-bubble';
import { MessageType, type Message } from '@/types';
import { confirm } from '@/lib/notify';

/** topics.message 命名空间的英语文案快照（同 en.json；未命中 key 回退完整路径） */
const messages: Record<string, string> = {
  'message.thinkingSummary': 'Process log',
  'message.collapse': 'Collapse',
  'topics.messageType.thinking': 'Thinking',
  'message.coordinatorBadge': 'Coordinator',
  'message.coordinatorTitle': 'Coordinator seat',
  'message.deleteTitle': 'Delete message',
  'message.deleteConfirm': 'Are you sure you want to delete this message?',
  'message.deletedSenderTitle': 'This member has been deleted',
};

jest.mock('next-intl', () => ({
  // 无命名空间前缀 mock（同 collapsible-markdown.test.tsx 先例）：
  // t('message.x') 直接按 'message.x' 查快照；tGlobal('topics.messageType.x') 按全键查
  useTranslations: () => (key: string) => messages[key] ?? key,
}));

// 全局 confirm mock（删除消息确认用；resolve 值控制「删除/取消」分支）
jest.mock('@/lib/notify', () => ({
  confirm: jest.fn(),
}));
const mockConfirm = confirm as jest.Mock;

// react-markdown / remark-gfm 为纯 ESM，Jest 不转换 node_modules，stub 之
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => undefined,
}));

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    topicId: 'topic-1',
    senderId: 'agent-1',
    senderType: 'agent',
    senderName: 'Agent One',
    content: 'Hello world',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('MessageBubble 圆桌扩展', () => {
  describe('seatLabel badge', () => {
    it('seatLabel 存在时在 senderName 旁渲染 badge（文案即 label 本身）', () => {
      render(<MessageBubble msg={makeMessage({ seatLabel: 'kimi-1' })} />);

      // 座位 label 是标识符不翻译：直接按原文断言
      const badge = screen.getByText('kimi-1');
      expect(badge).toBeInTheDocument();
      expect(screen.getByText('Agent One')).toBeInTheDocument();
    });

    it('seatLabel 缺省时不渲染 badge（两态）', () => {
      render(<MessageBubble msg={makeMessage()} />);

      expect(screen.queryByText('kimi-1')).not.toBeInTheDocument();
      expect(screen.getByText('Agent One')).toBeInTheDocument();
    });
  });

  describe('主脑 badge（M3 阶段 3，r13）', () => {
    it('seatCoordinator=true 时在座位 badge 旁渲染主脑标识', () => {
      render(<MessageBubble msg={makeMessage({ seatLabel: 'kimi-1', seatCoordinator: true })} />);

      expect(screen.getByText('kimi-1')).toBeInTheDocument(); // 座位 badge
      expect(screen.getByText('Coordinator')).toBeInTheDocument(); // 主脑标识
    });

    it('seatCoordinator 缺省（普通座位/人类/系统消息）不渲染主脑标识', () => {
      render(<MessageBubble msg={makeMessage({ seatLabel: 'kimi-1' })} />);

      expect(screen.getByText('kimi-1')).toBeInTheDocument();
      expect(screen.queryByText('Coordinator')).not.toBeInTheDocument();
    });

    it('主脑标识不会在无座位 badge 时单独出现（seatCoordinator 仅随座位发言透传）', () => {
      render(<MessageBubble msg={makeMessage({ seatCoordinator: true })} />);

      expect(screen.queryByText('Coordinator')).not.toBeInTheDocument();
    });
  });

  describe('thinking 过程折叠', () => {
    it('thinking 消息默认折叠：显示「过程记录」摘要行，内容不可见', () => {
      render(
        <MessageBubble
          msg={makeMessage({ type: MessageType.THINKING, content: 'deep reasoning' })}
        />,
      );

      const toggle = screen.getByTestId('thinking-toggle');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByText('Process log')).toBeInTheDocument();
      // 折叠态正文不渲染（展开后才是完整 markdown）
      expect(screen.queryByTestId('thinking-content')).not.toBeInTheDocument();
    });

    it('点击展开完整 markdown，再点收起（双态切换）', () => {
      render(
        <MessageBubble
          msg={makeMessage({ type: MessageType.THINKING, content: 'deep reasoning' })}
        />,
      );

      fireEvent.click(screen.getByTestId('thinking-toggle'));
      expect(screen.getByTestId('thinking-toggle')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('thinking-content')).toBeInTheDocument();
      // 展开后正文可见（react-markdown stub 透传 children）
      expect(screen.getByText('deep reasoning')).toBeInTheDocument();
      // 按钮变「收起」（复用 message.collapse 键）
      expect(screen.getByText('Collapse')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('thinking-toggle'));
      expect(screen.getByTestId('thinking-toggle')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('thinking-content')).not.toBeInTheDocument();
    });
  });

  describe('非 thinking 消息不回归', () => {
    it('chat 消息不出现 thinking 折叠开关，内容照常渲染', () => {
      render(<MessageBubble msg={makeMessage({ type: MessageType.CHAT })} />);

      expect(screen.queryByTestId('thinking-toggle')).not.toBeInTheDocument();
      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });

    it('system 消息渲染为居中系统公告条：无 senderName、无气泡附件，正文可见', () => {
      const { container } = render(
        <MessageBubble
          msg={makeMessage({ senderType: 'system', senderName: 'System', type: undefined })}
        />,
      );

      // 公告条：整行居中（组件内 items-center 收拢内容，父行 justify-center 全宽）
      expect(container.firstChild).toHaveClass('items-center');
      expect(container.firstChild).toHaveClass('w-full');
      // 不显示发送者名——公告不是「名为 System 的 Agent 在发言」
      expect(screen.queryByText('System')).not.toBeInTheDocument();
      // 正文可见（react-markdown stub 透传 children）
      expect(screen.getByText('Hello world')).toBeInTheDocument();
      // 无 thinking 折叠开关、无复制 id 等气泡附件
      expect(screen.queryByTestId('thinking-toggle')).not.toBeInTheDocument();
      expect(screen.queryByText('msg-1')).not.toBeInTheDocument();
    });
  });

  describe('删除消息确认（全局 confirm 替换 window.confirm 批次）', () => {
    beforeEach(() => {
      mockConfirm.mockReset();
    });

    it('人类自己的消息 + onDelete → 删除按钮可见；confirm 取消 → 不调 onDelete', async () => {
      mockConfirm.mockResolvedValue(false);
      const onDelete = jest.fn();
      render(
        <MessageBubble
          msg={makeMessage({ senderId: 'me', senderType: 'human' })}
          currentUserId="me"
          onDelete={onDelete}
        />,
      );

      fireEvent.click(screen.getByTitle('Delete message'));
      await act(async () => {}); // 结算 confirm Promise（异步确认无同步阻塞）

      expect(mockConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Are you sure you want to delete this message?',
        }),
      );
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('confirm 确认 → onDelete(msg.id)', async () => {
      mockConfirm.mockResolvedValue(true);
      const onDelete = jest.fn();
      render(
        <MessageBubble
          msg={makeMessage({ id: 'msg-9', senderId: 'me', senderType: 'human' })}
          currentUserId="me"
          onDelete={onDelete}
        />,
      );

      fireEvent.click(screen.getByTitle('Delete message'));
      await act(async () => {});

      expect(onDelete).toHaveBeenCalledWith('msg-9');
    });

    it('非本人消息（senderId ≠ currentUserId）→ 不渲染删除按钮', () => {
      render(
        <MessageBubble
          msg={makeMessage({ senderId: 'other', senderType: 'human' })}
          currentUserId="me"
          onDelete={jest.fn()}
        />,
      );
      expect(screen.queryByTitle('Delete message')).not.toBeInTheDocument();
    });
  });

  describe('系统公告条折叠（M3 验收第二批）', () => {
    const longAnnouncement = '这是一个非常长的系统公告正文'.repeat(20);

    it('默认单行截断：正文容器带 truncate；无溢出（jsdom scrollWidth=clientWidth=0）时不显示 chevron', () => {
      render(
        <MessageBubble
          msg={makeMessage({
            senderType: 'system',
            senderName: 'System',
            type: undefined,
            content: longAnnouncement,
          })}
        />,
      );

      const content = screen.getByTestId('system-announcement-content');
      expect(content).toHaveClass('truncate');
      // jsdom 无布局：scrollWidth=clientWidth=0 → 0 > 0 = false → 无折叠控件
      expect(screen.queryByTestId('system-announcement-toggle')).not.toBeInTheDocument();
      // 无 "System" 名字不回归
      expect(screen.queryByText('System')).not.toBeInTheDocument();
    });

    it('内容溢出时显示 chevron；点击展开完整正文 + aria-expanded 翻转，再点收起', () => {
      // jsdom 无布局，scrollWidth/clientWidth 恒 0——mock 成溢出（scrollWidth > clientWidth）
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        value: 800,
      });
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        value: 300,
      });
      try {
        render(
          <MessageBubble
            msg={makeMessage({
              senderType: 'system',
              senderName: 'System',
              type: undefined,
              content: longAnnouncement,
            })}
          />,
        );

        // 溢出 → chevron 出现，默认折叠态
        const toggle = screen.getByTestId('system-announcement-toggle');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByTestId('system-announcement-content')).toHaveClass('truncate');

        // 展开：truncate 移除 + 完整正文可见 + aria-expanded 翻转
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId('system-announcement-content')).not.toHaveClass('truncate');
        expect(screen.getByText(longAnnouncement)).toBeInTheDocument();

        // 收起：回到单行截断态
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByTestId('system-announcement-content')).toHaveClass('truncate');
      } finally {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      }
    });

    it('短公告无折叠控件（无溢出 → 无 chevron），正文直接可见', () => {
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        value: 100,
      });
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        value: 200,
      });
      try {
        render(
          <MessageBubble
            msg={makeMessage({
              senderType: 'system',
              senderName: 'System',
              type: undefined,
              content: '座位 kimi-1 请求审批：Write',
            })}
          />,
        );

        expect(screen.queryByTestId('system-announcement-toggle')).not.toBeInTheDocument();
        expect(screen.getByText('座位 kimi-1 请求审批：Write')).toBeInTheDocument();
      } finally {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      }
    });
  });

  describe('已删除发送者降级（统一批 B）', () => {
    it('deletedAt 非空 → senderName 灰化 + title 提示，不加常驻 badge（高密度流防噪音，R16 钉死）', () => {
      render(<MessageBubble msg={makeMessage({ deletedAt: '2026-08-01T00:00:00Z' })} />);

      const name = screen.getByText('Agent One');
      expect(name.className).toContain('opacity-60');
      expect(name).toHaveAttribute('title', 'This member has been deleted');
      // 无「已删除」常驻 badge（与搜索页/成员列表的 badge 分级差异）
      expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
    });

    it('未删除发送者：名字正常显色、无 title 提示', () => {
      render(<MessageBubble msg={makeMessage()} />);

      const name = screen.getByText('Agent One');
      expect(name.className).toContain('opacity-80');
      expect(name.className).not.toContain('opacity-60');
      expect(name).not.toHaveAttribute('title');
    });
  });
});
