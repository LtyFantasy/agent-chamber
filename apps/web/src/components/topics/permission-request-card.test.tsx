/**
 * permission-request-card.test.tsx — 圆桌审批裁决卡片渲染契约测试（M3 阶段 2）
 *
 * 覆盖：pending 列表渲染（座位 label 映射 / tool 摘要 name→title→JSON 兜底截断 /
 * options 按钮组文案 = 已知 optionId 的 i18n 词条、未知回退 label ?? name ?? optionId，
 * 且 reject 类危险色）；行内参与者头像（bindActorId→participants，缺失退化 label
 * 首字母色块）；裁决交互（点击→调 verdict API→invalidate 三件套：本列表+全局
 * pending-count+topic 消息）；409 提示+失效重取；空态零渲染；enabled=false
 * （非圆桌）不发请求；agent 会话（user null）按钮隐藏。文案断言用 en.json 快照。
 */

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { PermissionRequestCard } from './permission-request-card';
import { Api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { ParticipantStatus, type TopicParticipant } from '@/types';

/** topics.permissionRequest 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'topics.permissionRequest.title': '{count} pending approval(s)',
  'topics.permissionRequest.seatFallback': 'Seat {id}',
  'topics.permissionRequest.alreadyResolved': 'Already resolved by someone else',
  'topics.permissionRequest.verdictFailed': 'Failed to resolve',
  'topics.permissionRequest.verdictSuccess': 'Verdict submitted',
  'topics.permissionRequest.option.approveOnce': 'Allow once',
  'topics.permissionRequest.option.approveAlways': 'Allow for session',
  'topics.permissionRequest.option.reject': 'Reject',
};

jest.mock('@/lib/notify', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
  },
  confirm: jest.fn(),
}));

import { toast } from '@/lib/notify';

const mockToastSuccess = toast.success as jest.Mock;
const mockToastError = toast.error as jest.Mock;

jest.mock('next-intl', () => ({
  // 支持 {param} 简单插值（同 docs/page.test.tsx 先例）
  useTranslations: (ns?: string) => (key: string, params?: Record<string, string | number>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    let text = messages[fullKey] ?? fullKey;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.split(`{${k}}`).join(String(v));
      }
    }
    return text;
  },
}));

jest.mock('@/lib/api', () => ({
  Api: {
    roundtable: {
      listPermissionRequests: jest.fn(),
      verdictPermissionRequest: jest.fn(),
      pendingPermissionRequestCount: jest.fn(),
    },
  },
}));

const mockList = Api.roundtable.listPermissionRequests as jest.Mock;
const mockVerdict = Api.roundtable.verdictPermissionRequest as jest.Mock;

const TOPIC_ID = 't1';

/** 构造一个标准分页响应 */
function paged(items: unknown[]) {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 50,
    totalPages: items.length ? 1 : 0,
    hasNext: false,
    hasPrev: false,
  };
}

const REQ_APPROVE = {
  id: 'req-approve',
  requestId: 'rpc-1',
  seatId: 'seat-1',
  topicId: TOPIC_ID,
  tool: { name: 'Bash' },
  // 真机形状（kimi/codex 实测）：{ optionId, kind, name }，无 label
  options: [
    { optionId: 'approve_once', kind: 'allow_once', name: 'Approve once' },
    { optionId: 'reject', kind: 'reject', name: 'Reject' },
  ],
  status: 'pending',
  verdictOptionId: null,
  resolvedBy: null,
  createdAt: '2026-08-08T00:00:00Z',
  resolvedAt: null,
  updatedAt: '2026-08-08T00:00:00Z',
};

const SEATS = [
  {
    id: 'seat-1',
    label: 'Seat Alpha',
    status: 'active',
    vendor: 'kimi',
    runnerId: null,
    config: { bindActorId: 'actor-1' },
  },
  { id: 'seat-2', label: 'Seat Beta', status: 'active', vendor: 'kimi', runnerId: null },
];

/** 参与者 fixture（avatarUrl 缺省 → Avatar 走 fallback 首字母色块，照 seat-presence-bar.test） */
const PARTICIPANTS: TopicParticipant[] = [
  {
    participantId: 'actor-1',
    participantType: 'agent',
    name: 'Alpha Agent',
    avatarUrl: null,
    description: null,
    role: 'member',
    status: ParticipantStatus.ACTIVE,
  },
];

/** 409 AxiosError（组件用 instanceof + response.status 判定） */
function conflictError() {
  return new AxiosError('Conflict', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: {} as never,
    data: { message: 'already resolved' },
  });
}

function renderCard(
  props: {
    topicId?: string;
    seats?: typeof SEATS;
    enabled?: boolean;
    participants?: TopicParticipant[];
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <PermissionRequestCard
        topicId={props.topicId ?? TOPIC_ID}
        seats={props.seats}
        enabled={props.enabled}
        participants={props.participants}
      />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

describe('PermissionRequestCard 审批裁决卡片', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 默认：人类会话（web = 人类 JWT），1 条 pending 审批
    useAuthStore.setState({
      user: { id: 'u1', email: 'u@x.io', name: 'U', role: 'admin' },
      isAuthenticated: true,
    });
    mockList.mockResolvedValue(paged([REQ_APPROVE]));
  });

  afterEach(() => {
    act(() => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
    });
  });

  it('pending 列表渲染：座位 label 映射 + tool 摘要 + options 按钮组（reject 类危险色）', async () => {
    renderCard({ seats: SEATS });

    expect(await screen.findByText('Seat Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    const approveBtn = screen.getByRole('button', { name: 'Allow once' });
    const rejectBtn = screen.getByRole('button', { name: 'Reject' });
    // reject 类（kind 含 'reject'）走 destructive 危险色，其余 outline 主色系
    expect(rejectBtn.className).toContain('bg-destructive');
    expect(approveBtn.className).not.toContain('bg-destructive');
    // 请求只发 status=pending
    expect(mockList).toHaveBeenCalledWith(TOPIC_ID, { status: 'pending', pageSize: 50 });
  });

  it('tool 无 name/title：JSON 兜底截断展示', async () => {
    mockList.mockResolvedValue(
      paged([
        {
          ...REQ_APPROVE,
          id: 'req-2',
          tool: { name: '', title: undefined, long: 'x'.repeat(200) },
        },
      ]),
    );
    const { container } = renderCard({ seats: SEATS });

    await waitFor(() => {
      const items = container.querySelectorAll('[data-testid="pr-item"]');
      expect(items.length).toBe(1);
    });
    const summary = container.querySelector('[data-testid="pr-item"] span:nth-of-type(2)');
    // JSON 兜底按整体截断 80 字符（含 `{"name":"","long":"` 前缀），只断言截断语义
    expect(summary?.textContent).toContain('…');
    expect(summary?.textContent?.length ?? 0).toBeLessThanOrEqual(81);
  });

  it('裁决交互：点击 → 调 verdict API（optionId 正确）→ invalidate 三件套', async () => {
    mockVerdict.mockResolvedValue({
      ...REQ_APPROVE,
      status: 'approved',
      verdictOptionId: 'approve_once',
    });
    const { queryClient } = renderCard({ seats: SEATS });

    // 预置联动目标缓存：invalidate 后 isInvalidated 置 true（观测 invalidate 发生）
    queryClient.setQueryData(['roundtable', 'permission-count'], { count: 1 });
    queryClient.setQueryData(['topics', 'messages', TOPIC_ID], {
      messages: [],
      nextCursor: null,
      hasMore: false,
    });

    const approveBtn = await screen.findByRole('button', { name: 'Allow once' });
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(mockVerdict).toHaveBeenCalledWith('req-approve', 'approve_once');
    });
    // 本列表失效重取（observer 活跃 → 重新请求）
    await waitFor(() => {
      expect(mockList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(queryClient.getQueryState(['roundtable', 'permission-count'])?.isInvalidated).toBe(
        true,
      );
      expect(queryClient.getQueryState(['topics', 'messages', TOPIC_ID])?.isInvalidated).toBe(true);
    });
    // v1.48.1：裁决成功 → 全局 success toast（统一「已提交裁决」文案）
    expect(mockToastSuccess).toHaveBeenCalledWith({ title: 'Verdict submitted' });
  });

  it('409（已被他人裁决）：内联提示 + 失效重取', async () => {
    mockVerdict.mockRejectedValue(conflictError());
    const { queryClient } = renderCard({ seats: SEATS });
    queryClient.setQueryData(['roundtable', 'permission-count'], { count: 1 });

    const rejectBtn = await screen.findByRole('button', { name: 'Reject' });
    fireEvent.click(rejectBtn);

    expect(await screen.findByTestId('pr-notice')).toHaveTextContent(
      'Already resolved by someone else',
    );
    await waitFor(() => {
      expect(mockList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(queryClient.getQueryState(['roundtable', 'permission-count'])?.isInvalidated).toBe(true);
    // v1.48.1：409 竞态不是本人操作失败 → 不触发全局 error toast（保持内联）
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('非 409 错误：全局 error toast（v1.48.1 接线）', async () => {
    mockVerdict.mockRejectedValue(new Error('network down'));
    renderCard({ seats: SEATS });

    const approveBtn = await screen.findByRole('button', { name: 'Allow once' });
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith({ title: 'Failed to resolve' });
    });
    // 真实失败走 toast，不再出现卡片内联提示
    expect(screen.queryByTestId('pr-notice')).not.toBeInTheDocument();
  });

  it('空态（无 pending）：不渲染任何容器', async () => {
    mockList.mockResolvedValue(paged([]));
    const { container } = renderCard({ seats: SEATS });

    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('enabled=false（普通 topic 短路）：不请求审批 API、不渲染', async () => {
    const { container } = renderCard({ seats: SEATS, enabled: false });

    expect(mockList).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it('座位映射缺失：兜底短 id 文案', async () => {
    // seats 未传（页面 seats 数据未加载）
    renderCard();

    expect(await screen.findByText('Seat seat-1')).toBeInTheDocument();
  });

  it('非人类会话（agent）：列表可见但裁决按钮隐藏', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
    const { container } = renderCard({ seats: SEATS });

    expect(await screen.findByText('Seat Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('已知 optionId：按钮显示 i18n 词条（展示层词典收敛三语义词条）', async () => {
    mockList.mockResolvedValue(
      paged([
        {
          ...REQ_APPROVE,
          id: 'req-all',
          options: [
            { optionId: 'approve_once', kind: 'allow_once', name: 'Approve once' },
            { optionId: 'approve_always', kind: 'allow_always', name: 'Approve always' },
            { optionId: 'reject', kind: 'reject', name: 'Reject' },
          ],
        },
      ]),
    );
    renderCard({ seats: SEATS });

    // 词典生效：厂商原文 name 不再出现，统一走 i18n 词条（en 快照）
    expect(await screen.findByRole('button', { name: 'Allow once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow for session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByText('Approve once')).not.toBeInTheDocument();
    expect(screen.queryByText('Approve always')).not.toBeInTheDocument();
  });

  it('未知 optionId：回退 name（真机形状无 label 也不崩）', async () => {
    mockList.mockResolvedValue(
      paged([
        {
          ...REQ_APPROVE,
          id: 'req-unknown',
          options: [
            { optionId: 'weird_vendor_option', kind: 'allow_once', name: 'Custom Vendor Label' },
          ],
        },
      ]),
    );
    renderCard({ seats: SEATS });

    // 词典外 optionId：不假设形状，透传厂商原文 name
    expect(await screen.findByRole('button', { name: 'Custom Vendor Label' })).toBeInTheDocument();
  });

  it('participants 传入：行内出现参与者头像（Avatar fallback 首字母）', async () => {
    renderCard({ seats: SEATS, participants: PARTICIPANTS });

    // seat-1 → config.bindActorId=actor-1 → 命中 Alpha Agent → Avatar fallback 'AA'
    expect(await screen.findByText('AA')).toBeInTheDocument();
    // 座位 label 徽章仍在（头像在徽章前，不替换）
    expect(screen.getByText('Seat Alpha')).toBeInTheDocument();
  });

  it('participants 缺失：头像兜底 seat label 首字母，渲染不崩', async () => {
    renderCard({ seats: SEATS });

    // seat-1 有 bindActorId 但 participants 未传 → 查不到参与者 → Avatar 退化为
    // seat label 首字母 'SA'（Seat Alpha），按钮/工具摘要正常渲染
    expect(await screen.findByText('SA')).toBeInTheDocument();
    expect(screen.getByText('Seat Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument();
  });

  it('裁决中按钮 loading：整组禁用防重复点击', async () => {
    let resolveVerdict!: (v: unknown) => void;
    mockVerdict.mockReturnValue(
      new Promise((resolve) => {
        resolveVerdict = resolve;
      }),
    );
    renderCard({ seats: SEATS });

    const approveBtn = await screen.findByRole('button', { name: 'Allow once' });
    fireEvent.click(approveBtn);

    // pending 未落定：两个按钮都应禁用（防连点）
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    });
    expect(mockVerdict).toHaveBeenCalledTimes(1);

    resolveVerdict({ ...REQ_APPROVE, status: 'approved' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow once' })).not.toBeDisabled();
    });
  });
});
