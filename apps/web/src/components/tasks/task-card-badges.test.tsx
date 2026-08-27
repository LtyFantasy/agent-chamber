/**
 * task-card-badges.test.tsx — 任务卡徽章行渲染契约测试（统一批 B）。
 *
 * 覆盖：
 * ① 状态/优先级/负责人/阻塞徽章基础渲染
 * ② assigneeDeletedAt 非空 → 负责人灰化 + title 提示（8 字符截断场景不加 badge，R16 分级）
 * ③ 未删除 assignee 不受影响
 *
 * 组件从 boards/[id]/page.tsx 抽取独立（统一批 B）——脱离页面重依赖（dnd-kit/
 * next-navigation/Api）后纯展示可测；next-intl 按文案快照 mock。
 */

import { render, screen } from '@testing-library/react';
import { TaskCardBadges } from './task-card-badges';
import type { TaskSummary } from '@/types';

/** 组件用到的文案快照（tGlobal 全键查询；未命中回退完整 key 路径） */
const messages: Record<string, string> = {
  'tasks.status.todo': 'To do',
  'tasks.status.blocked': 'Blocked',
  'common.deleted': 'Deleted',
};

jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => messages[key] ?? key,
}));

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 't1',
    title: 'Task one',
    status: 'todo',
    priority: 'p2',
    ...overrides,
  };
}

describe('TaskCardBadges 任务卡徽章行', () => {
  it('基础渲染：状态徽章 + 优先级 + 负责人 + 阻塞徽章', () => {
    render(<TaskCardBadges task={makeTask({ assigneeName: 'Alice' })} hasBlockers />);

    expect(screen.getByText('To do')).toBeInTheDocument();
    expect(screen.getByText('p2')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('assigneeDeletedAt 非空（统一批 B）→ 负责人灰化 + title 提示，不加「已删除」badge', () => {
    render(
      <TaskCardBadges
        task={makeTask({ assigneeName: 'Alice', assigneeDeletedAt: '2026-08-01T00:00:00Z' })}
      />,
    );

    const name = screen.getByText('Alice');
    expect(name.className).toContain('opacity-50');
    expect(name).toHaveAttribute('title', 'Deleted');
    // 8 字符截断场景不加常驻 badge（R16 分级：任务卡信息密度中，灰化即可辨识）
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });

  it('未删除 assignee：正常显色、无 title 提示', () => {
    render(<TaskCardBadges task={makeTask({ assigneeName: 'Alice' })} />);

    const name = screen.getByText('Alice');
    expect(name.className).not.toContain('opacity-50');
    expect(name).not.toHaveAttribute('title');
  });
});
