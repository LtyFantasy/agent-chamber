/**
 * roundtable-mention-hint.test.tsx — 圆桌 mention 模式输入提示渲染契约测试（M2 阶段 6）
 *
 * 覆盖三态：kind=roundtable && wakePolicy=mention → 提示出现；
 * roundtable + broadcast → 不出现；normal（kind 未定义）→ 不出现（后端不输出该字段）。
 * 文案断言用 en.json 快照；@座位名/@all 令牌本身不翻译。
 */

import { render, screen } from '@testing-library/react';
import { RoundtableMentionHint } from './roundtable-mention-hint';

/** topics.message 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'message.mentionHint': '@seat-name wakes that seat, @all wakes everyone',
};

jest.mock('next-intl', () => ({
  // 无命名空间前缀 mock（同 collapsible-markdown.test.tsx 先例）
  useTranslations: () => (key: string) => messages[key] ?? key,
}));

describe('RoundtableMentionHint 三态', () => {
  it('圆桌 + mention：输入框附近提示出现', () => {
    render(<RoundtableMentionHint kind="roundtable" wakePolicy="mention" />);

    expect(screen.getByText('@seat-name wakes that seat, @all wakes everyone')).toBeInTheDocument();
  });

  it('圆桌 + broadcast：不渲染（broadcast 无需 @ 提示）', () => {
    const { container } = render(
      <RoundtableMentionHint kind="roundtable" wakePolicy="broadcast" />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('normal topic（kind 未定义 / wakePolicy 未输出）：不渲染', () => {
    const { container } = render(<RoundtableMentionHint />);

    expect(container.firstChild).toBeNull();
  });
});
