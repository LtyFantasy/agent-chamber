/**
 * seat-create-dialog.test.tsx — 建座 Dialog 契约测试（v1.49.0，C3；v1.51.0 两态化适配）
 *
 * 覆盖：① 必填门控（label/cwd/绑定 agent 未齐 → 提交钮 disabled）；
 * ② vendor-runner 联动提示（无支持 runner 在线 → amber 提示，不阻断提交）；
 * ③ 高级折叠区默认收起、展开后可填；④ 提交 payload（高级项空值不落载荷；
 * 填了才带）；⑤ 成功后**不关窗**、切「下一步」成功态内嵌连接向导（v1.51.0），
 * 点「完成」才关闭；X/遮罩关闭重置回表单态。文案断言用 en.json 快照。
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SeatCreateDialog } from './seat-create-dialog';
import { Api } from '@/lib/api';

const messages: Record<string, string> = {
  'topics.seatCreate.title': 'Add seat',
  'topics.seatCreate.desc': 'Add an agent seat to the roundtable',
  'topics.seatCreate.label': 'Seat label',
  'topics.seatCreate.labelPlaceholder': 'e.g. kimi-1',
  'topics.seatCreate.vendor': 'Vendor',
  'topics.seatCreate.vendorNoRunner':
    'No online runner supports {vendor} — you can create the seat now and the runner will claim it when it comes online',
  'topics.seatCreate.bindAgent': 'Bound agent',
  'topics.seatCreate.bindAgentPlaceholder': 'Select an agent to bind',
  'topics.seatCreate.cwd': 'Working directory',
  'topics.seatCreate.cwdPlaceholder': '/home/user/projects/demo',
  'topics.seatCreate.cwdHint': "A directory on the runner's machine",
  'topics.seatCreate.permissionMode': 'Permission mode',
  'topics.seatCreate.pmDefaultDesc': 'default (read-only, writes need approval)',
  'topics.seatCreate.pmPlanDesc': 'plan (read-only + plan collaboration mode)',
  'topics.seatCreate.pmAutoDesc': 'auto (auto-execute, sensitive ops need approval — recommended)',
  'topics.seatCreate.pmYoloDesc': 'yolo (full access, no approvals — use with caution)',
  'topics.seatCreate.advanced': 'Advanced options',
  'topics.seatCreate.model': 'Model override (optional)',
  'topics.seatCreate.modelPlaceholder': 'e.g. kimi-k2',
  'topics.seatCreate.coordinator': 'Coordinator seat',
  'topics.seatCreate.batchWindow': 'Batch window ms (optional)',
  'topics.seatCreate.batchWindowPlaceholder': 'Default 30000; 0 = direct',
  'topics.seatCreate.cancel': 'Cancel',
  'topics.seatCreate.submit': 'Create',
  'topics.seatCreate.success':
    'Seat "{label}" created — an online runner will claim it automatically. Next, connect it:',
  'topics.seatCreate.done': 'Done',
  'topics.seatCreate.failed': 'Failed to create seat, please retry',
  'topics.seatCreate.forbidden': 'No permission to create a seat in this topic',
  'topics.seatGuide.promptText':
    'You are the agent running roundtable seat "{label}" (vendor: {vendor}). The seat is already created on the platform — do NOT create it again. Follow these steps:\n1. Read the connection guide: {guideUrl}\n2. On a machine with your CLI installed, start the runner and connect to the platform at {platformUrl} using API key: {apiKey}\n3. After claiming seat "{label}", report back to the topic that you are ready.',
};

jest.mock('next-intl', () => ({
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
  useLocale: () => 'en',
}));

jest.mock('@/lib/api', () => ({
  Api: {
    roundtable: {
      createSeat: jest.fn(),
      listRunners: jest.fn(),
      listSeats: jest.fn(),
    },
    agents: {
      listAll: jest.fn(),
    },
  },
  // 值域常量（与 api.ts 单源一致；vendor-runner 联动提示消费）
  RUNNER_STATUS: { ONLINE: 'online', OFFLINE: 'offline' },
}));

const mockCreateSeat = Api.roundtable.createSeat as jest.Mock;
const mockListAll = Api.agents.listAll as jest.Mock;

const AGENTS = [
  { id: 'agent-1', name: 'Kimi 开发者' },
  { id: 'agent-2', name: 'Codex 评审' },
];

const ONLINE_KIMI_RUNNER = {
  id: 'r1',
  name: 'local-dev',
  status: 'online',
  version: null,
  vendors: ['kimi'],
  lastSeenAt: null,
};

/** 建座成功响应（RoundtableSeatItem 完整形状：label/vendor/runnerId 是向导上下文） */
const CREATED_SEAT = {
  id: 'seat-new',
  label: 'kimi-1',
  status: 'active',
  vendor: 'kimi',
  runnerId: null,
  config: { bindActorId: 'agent-1' },
};

function renderDialog(runners: Parameters<typeof SeatCreateDialog>[0]['runners'] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = jest.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <SeatCreateDialog topicId="t1" open={true} onOpenChange={onOpenChange} runners={runners} />
    </QueryClientProvider>,
  );
  return { onOpenChange, queryClient };
}

/** 填齐核心必填项（label/cwd/绑定 agent） */
async function fillRequired() {
  fireEvent.change(screen.getByTestId('seat-create-label'), { target: { value: 'kimi-1' } });
  fireEvent.change(screen.getByTestId('seat-create-cwd'), { target: { value: '/home/user/p' } });
  // agents 查询异步：option 出现后再选，否则 jsdom select 收不到合法 value
  await screen.findByRole('option', { name: 'Kimi 开发者' });
  fireEvent.change(screen.getByTestId('seat-create-bind-agent'), {
    target: { value: 'agent-1' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListAll.mockResolvedValue(AGENTS);
  // 成功态内嵌的连接向导会发起 runners/seats 查询（默认空数据，不干扰断言）
  (Api.roundtable.listRunners as jest.Mock).mockResolvedValue([]);
  (Api.roundtable.listSeats as jest.Mock).mockResolvedValue([]);
});

describe('必填门控', () => {
  it('核心必填未齐 → 提交钮 disabled；填齐后可提交', async () => {
    mockCreateSeat.mockResolvedValue(CREATED_SEAT);
    renderDialog([ONLINE_KIMI_RUNNER]);
    const submit = screen.getByTestId('seat-create-submit');
    expect(submit).toBeDisabled();
    await fillRequired();
    expect(submit).not.toBeDisabled();
  });
});

describe('vendor-runner 联动提示', () => {
  it('无支持所选 vendor 的在线 runner → amber 提示（不阻断提交）', async () => {
    mockCreateSeat.mockResolvedValue(CREATED_SEAT);
    renderDialog([]); // 无任何 runner
    expect(screen.getByTestId('seat-create-vendor-warning')).toHaveTextContent('kimi');
    await fillRequired();
    expect(screen.getByTestId('seat-create-submit')).not.toBeDisabled();
  });

  it('有支持所选 vendor 的在线 runner → 不渲染提示', () => {
    renderDialog([ONLINE_KIMI_RUNNER]);
    expect(screen.queryByTestId('seat-create-vendor-warning')).not.toBeInTheDocument();
  });
});

describe('提交 payload', () => {
  it('高级项留空不落载荷（核心字段 + permissionMode 默认 auto）', async () => {
    mockCreateSeat.mockResolvedValue(CREATED_SEAT);
    renderDialog([ONLINE_KIMI_RUNNER]);
    await fillRequired();
    fireEvent.click(screen.getByTestId('seat-create-submit'));
    await waitFor(() => expect(mockCreateSeat).toHaveBeenCalledTimes(1));
    expect(mockCreateSeat.mock.calls[0][0]).toEqual({
      topicId: 't1',
      label: 'kimi-1',
      vendor: 'kimi',
      cwd: '/home/user/p',
      permissionMode: 'auto',
      bindActorId: 'agent-1',
    });
  });

  it('展开高级区填写后：model/coordinator/batchWindowMs 落载荷', async () => {
    mockCreateSeat.mockResolvedValue(CREATED_SEAT);
    renderDialog([ONLINE_KIMI_RUNNER]);
    // 高级区默认收起
    expect(screen.queryByPlaceholderText('e.g. kimi-k2')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Advanced options'));
    fireEvent.change(screen.getByPlaceholderText('e.g. kimi-k2'), {
      target: { value: 'kimi-k2' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByPlaceholderText('Default 30000; 0 = direct'), {
      target: { value: '0' },
    });
    await fillRequired();
    fireEvent.click(screen.getByTestId('seat-create-submit'));
    await waitFor(() => expect(mockCreateSeat).toHaveBeenCalledTimes(1));
    expect(mockCreateSeat.mock.calls[0][0]).toEqual(
      expect.objectContaining({ model: 'kimi-k2', coordinator: true, batchWindowMs: 0 }),
    );
  });

  it('成功后不关窗：切「下一步」成功态内嵌连接向导（v1.51.0），点「完成」才关闭', async () => {
    mockCreateSeat.mockResolvedValue(CREATED_SEAT);
    const { onOpenChange } = renderDialog([ONLINE_KIMI_RUNNER]);
    await fillRequired();
    fireEvent.click(screen.getByTestId('seat-create-submit'));
    // 提交成功 → 不调 onOpenChange(false)（不再戛然而止）
    await waitFor(() => expect(mockCreateSeat).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalled();
    // 成功态：提示 + 内嵌连接向导（座位刚建必 runnerId==null）
    expect(await screen.findByTestId('seat-create-success')).toHaveTextContent(
      'Seat "kimi-1" created',
    );
    expect(screen.getByTestId('runner-connect-guide')).toBeInTheDocument();
    // 向导指令含新建座位 label（幂等声明上下文）
    expect(screen.getByText(/roundtable seat "kimi-1"/)).toBeInTheDocument();
    // 点「完成」→ 关闭
    fireEvent.click(screen.getByTestId('seat-create-done'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
