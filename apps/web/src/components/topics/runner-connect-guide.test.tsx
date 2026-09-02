/**
 * runner-connect-guide.test.tsx — 圆桌「最后一公里」连接向导契约测试（v1.51.0，plan §1.3）
 *
 * 覆盖：① vendor 感知（kimi/codex runner 匹配判定；指南 URL 按 vendor + locale
 * 选文件）；② API Key 内插（填入 → 指令/命令含真实 key；未填 → <AGENT_API_KEY>
 * 占位符）；③ 复制反馈（剪贴板内容 + 内联瞬态「已复制」）；④ 收起态（defaultOpen=false
 * → 常驻按钮 + 轮询不启，点击展开）；⑤ 验收环三级迁移（无 runner → runner 上线 →
 * runnerId 认领 → presence 存活 → 全绿 + R10 按钮复制 @label + onExit）；
 * ⑥ R5 卡死诊断（runner 在线但 90s 未认领 → amber，fake timers 推进）。
 *
 * 隔离策略：mock use-seat-presence 返回可控 seats（状态迁移经 rerender 驱动，同
 * seat-presence-bar 模式）；runners 走真实 react-query + listRunners mock（迁移经
 * invalidate 驱动）；轮询契约本身在 lib/use-seat-presence.test 单独覆盖。
 * 文案断言用 en.json 快照；platform URL 走 getRunnerPlatformUrl（测试环境无
 * NEXT_PUBLIC_API_URL → 缺省 /api/v1 → jsdom origin http://localhost）。
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RunnerConnectGuide } from './runner-connect-guide';
import { useSeatPresence } from '@/lib/use-seat-presence';
import { Api, type RoundtableRunnerItem, type RoundtableSeatItem } from '@/lib/api';

/** topics.seatGuide 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'topics.seatGuide.model':
    'A runner dials into the platform from the machine where its CLI is installed — not necessarily the machine hosting the platform — and claims seats with the bound agent API key.',
  'topics.seatGuide.expandButton': 'Connect seat "{label}"',
  'topics.seatGuide.apiKeyLabel': 'Agent API Key (optional)',
  'topics.seatGuide.apiKeyPlaceholder':
    'Paste the bound agent API key; leave blank to keep a placeholder',
  'topics.seatGuide.apiKeyHint': "Kept in this page's memory only — never uploaded or saved",
  'topics.seatGuide.forgotKey': 'Forgot the key? Reset it on the agent keys page',
  'topics.seatGuide.pathATitle': 'Option A (recommended): copy instructions for the agent',
  'topics.seatGuide.pathADesc':
    'Send this to the target agent (or paste it into its CLI) — it will read the guide and start the runner:',
  'topics.seatGuide.copyPrompt': 'Copy instructions',
  'topics.seatGuide.pathBTitle': 'Option B: one-line command for humans',
  'topics.seatGuide.pathBDesc':
    'Run on a machine with a CLI installed (Linux/macOS; Windows via WSL). First run auto-downloads and installs the runner:',
  'topics.seatGuide.copyCommand': 'Copy command',
  'topics.seatGuide.repoAltTitle': 'Already cloned the repo?',
  'topics.seatGuide.repoAltDesc': 'From the repo root, run these instead, then start:',
  'topics.seatGuide.verifyTitle': 'Connection check (automatic)',
  'topics.seatGuide.stepRunner': 'Waiting for a runner that supports {vendor} to come online',
  'topics.seatGuide.stepRunnerOk': 'A runner supporting {vendor} is online',
  'topics.seatGuide.stepClaim': 'Waiting for seat "{label}" to be claimed',
  'topics.seatGuide.stepClaimOk': 'Seat "{label}" has been claimed',
  'topics.seatGuide.stepAlive': 'Waiting for the seat to become active',
  'topics.seatGuide.stepAliveOk': 'Seat is online',
  'topics.seatGuide.stuckTitle': 'The runner is online, but the seat has not been claimed yet',
  'topics.seatGuide.stuckHint':
    "Check that the runner's API key belongs to the seat's bound agent (reset it on the agent keys page) and that its CLI vendor is {vendor}.",
  'topics.seatGuide.allGreen': 'Connected — the seat is ready. Say hello!',
  'topics.seatGuide.goMention': 'Go @ it',
  'topics.seatGuide.mentionCopied': 'Copied "@{label} " — paste it in the topic to @ it',
  'topics.seatGuide.copied': 'Copied',
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
  useLocale: () => mockLocale,
}));
let mockLocale = 'en';

// 传输抽象接缝隔离：seats 由可控 mock 提供（状态迁移经 rerender 驱动）
jest.mock('@/lib/use-seat-presence', () => ({
  useSeatPresence: jest.fn(),
}));
const mockUseSeatPresence = useSeatPresence as jest.Mock;

jest.mock('@/lib/api', () => ({
  Api: {
    roundtable: {
      listRunners: jest.fn(),
      listSeats: jest.fn(),
    },
  },
  // 值域常量（与 api.ts 单源一致；runner 在线判定 + presence 存活判定消费）
  RUNNER_STATUS: { ONLINE: 'online', OFFLINE: 'offline' },
  PRESENCE_PHASE: {
    THINKING: 'thinking',
    TOOL: 'tool',
    REPLYING: 'replying',
    IDLE: 'idle',
    OFFLINE: 'offline',
  },
}));
const mockListRunners = Api.roundtable.listRunners as jest.Mock;

const TOPIC_ID = 't1';
const ORIGIN = 'http://localhost'; // jsdom window.location.origin

/** 座位 fixture：kimi 未认领（runnerId null——向导的典型起点） */
const SEAT: RoundtableSeatItem = {
  id: 'seat-1',
  label: 'kimi-1',
  status: 'active',
  vendor: 'kimi',
  runnerId: null,
  config: { bindActorId: 'agent-1' },
};
const CODEX_SEAT: RoundtableSeatItem = { ...SEAT, id: 'seat-2', label: 'codex-1', vendor: 'codex' };

const ONLINE_KIMI_RUNNER: RoundtableRunnerItem = {
  id: 'r1',
  name: 'local-dev',
  status: 'online',
  version: '0.3.1',
  vendors: ['kimi', 'codex'],
  lastSeenAt: new Date().toISOString(),
};

/** 可变数据源：runners 经 react-query invalidate 驱动重取；seats 经 rerender 驱动 */
let runnersData: RoundtableRunnerItem[];
let seatsData: RoundtableSeatItem[];

function renderGuide(
  props: Partial<{ seat: RoundtableSeatItem; onExit: () => void; defaultOpen: boolean }> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RunnerConnectGuide
        seat={props.seat ?? SEAT}
        topicId={TOPIC_ID}
        defaultOpen={props.defaultOpen ?? true}
        onExit={props.onExit}
      />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLocale = 'en';
  runnersData = [];
  seatsData = [SEAT];
  mockUseSeatPresence.mockImplementation(() => ({ data: seatsData }));
  mockListRunners.mockImplementation(() => Promise.resolve(runnersData));
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
});

describe('双路径内容与 vendor 感知', () => {
  it('渲染模型说明 + API Key 输入 + 路径 A/B（命令含平台 URL 与占位 Key）', async () => {
    renderGuide();
    expect(screen.getByTestId('runner-connect-guide')).toBeInTheDocument();
    expect(
      screen.getByText(/not necessarily the machine hosting the platform/),
    ).toBeInTheDocument();
    expect(screen.getByTestId('seat-guide-api-key')).toBeInTheDocument();
    // 路径 B 命令：standalone 一行 + repo 备选
    const curl = screen.getByText(
      `curl -fsSL ${ORIGIN}/api/v1/downloads/install-runner.sh | bash -s -- --platform-url ${ORIGIN} --api-key <AGENT_API_KEY> --start`,
    );
    expect(curl).toBeInTheDocument();
    expect(
      screen.getByText(
        `./scripts/install-runner.sh --platform-url ${ORIGIN} --api-key <AGENT_API_KEY>`,
      ),
    ).toBeInTheDocument();
    // 路径 A prompt：幂等声明（R9）+ 指南 URL（vendor + locale 选文件，en → kimi.md）
    expect(screen.getByText(/do NOT create it again/)).toBeInTheDocument();
    expect(screen.getByText(/integrations\/kimi\.md/)).toBeInTheDocument();
    // 忘记 Key 链接：座位绑定的 agent 密钥页路由
    expect(screen.getByRole('link', { name: /agent keys page/ })).toHaveAttribute(
      'href',
      '/agents/agent-1/keys',
    );
  });

  it('API Key 填入后内插进指令与两条命令（真实 key 替换占位符）', async () => {
    renderGuide();
    fireEvent.change(screen.getByTestId('seat-guide-api-key'), { target: { value: 'ask_abc123' } });
    expect(
      screen.getByText(
        `curl -fsSL ${ORIGIN}/api/v1/downloads/install-runner.sh | bash -s -- --platform-url ${ORIGIN} --api-key ask_abc123 --start`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/using API key: ask_abc123/)).toBeInTheDocument();
    expect(screen.queryByText(/<AGENT_API_KEY>/)).not.toBeInTheDocument();
  });

  it('vendor 感知：kimi runner 不匹配 codex 座位（第①条不绿）；指南 URL 按 vendor 切换', async () => {
    runnersData = [ONLINE_KIMI_RUNNER];
    renderGuide({ seat: CODEX_SEAT });
    await waitFor(() =>
      expect(screen.getByTestId('verify-step-runner')).toHaveTextContent(
        'Waiting for a runner that supports codex',
      ),
    );
    // codex 指南 URL（en → codex.md）
    expect(screen.getByText(/integrations\/codex\.md/)).toBeInTheDocument();
  });

  it('zh 界面 → 指南 URL 指向 zh-CN 镜像（kimi.zh-CN.md）', () => {
    mockLocale = 'zh-CN';
    renderGuide();
    expect(screen.getByText(/integrations\/kimi\.zh-CN\.md/)).toBeInTheDocument();
  });
});

describe('复制反馈（内联瞬态文案克制模式）', () => {
  it('复制指令：写剪贴板（prompt 全文）并显示「已复制」', async () => {
    renderGuide();
    fireEvent.click(screen.getByTestId('seat-guide-copy-prompt'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining(`roundtable seat "kimi-1"`),
      ),
    );
    expect(await screen.findByTestId('seat-guide-prompt-copied')).toHaveTextContent('Copied');
  });

  it('复制命令：写剪贴板（curl 一行）并显示「已复制」', async () => {
    renderGuide();
    fireEvent.click(screen.getByTestId('seat-guide-copy-command'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('curl -fsSL'),
      ),
    );
    expect(await screen.findByTestId('seat-guide-command-copied')).toHaveTextContent('Copied');
  });
});

describe('收起态（常驻入口 + 轮询开关）', () => {
  it('defaultOpen=false → 收成按钮，轮询不启（listRunners 零调用）；点击展开后开始轮询', async () => {
    renderGuide({ defaultOpen: false });
    expect(screen.getByTestId('connect-guide-expand')).toHaveTextContent('Connect seat "kimi-1"');
    expect(mockListRunners).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('connect-guide-expand'));
    await waitFor(() => expect(mockListRunners).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('runner-connect-guide')).toBeInTheDocument();
  });
});

describe('验收环状态迁移', () => {
  it('三级递进：无 runner → runner 上线 → 座位认领 → presence 存活 → 全绿', async () => {
    const { queryClient, rerender } = renderGuide();
    const guideJsx = (props: object = {}) => (
      <QueryClientProvider client={queryClient}>
        <RunnerConnectGuide seat={SEAT} topicId={TOPIC_ID} {...props} />
      </QueryClientProvider>
    );

    // ① 初始（无 runner）：等待 runner，其余两级灰
    expect(await screen.findByTestId('verify-step-runner')).toHaveTextContent(
      'Waiting for a runner that supports kimi',
    );
    expect(screen.getByTestId('verify-step-claim')).toHaveTextContent(
      'Waiting for seat "kimi-1" to be claimed',
    );
    expect(screen.queryByTestId('seat-guide-all-green')).not.toBeInTheDocument();

    // ② runner 上线（runners 经 invalidate 重取）
    await act(async () => {
      runnersData = [ONLINE_KIMI_RUNNER];
      await queryClient.invalidateQueries({ queryKey: ['roundtable', 'runners'] });
    });
    await waitFor(() =>
      expect(screen.getByTestId('verify-step-runner')).toHaveTextContent(
        'A runner supporting kimi is online',
      ),
    );

    // ③ 座位被认领（seats 迁移经 rerender；runnerId != null 是直接信号，R6）
    act(() => {
      seatsData = [{ ...SEAT, runnerId: 'r1' }];
      rerender(guideJsx());
    });
    expect(screen.getByTestId('verify-step-claim')).toHaveTextContent(
      'Seat "kimi-1" has been claimed',
    );
    // presence 缺失（从未活动）≠ offline：第③条已绿——presence 只在活动事件时
    // 写入，若等 presence 出现，「去 @ 它试试」按钮将永远不出现（死循环）
    expect(screen.getByTestId('verify-step-alive')).toHaveTextContent('Seat is online');
    expect(screen.getByTestId('seat-guide-all-green')).toBeInTheDocument();

    // ④ presence 出现（idle）→ 保持全绿
    act(() => {
      seatsData = [
        { ...SEAT, runnerId: 'r1', presence: { phase: 'idle', at: new Date().toISOString() } },
      ];
      rerender(guideJsx());
    });
    expect(screen.getByTestId('verify-step-alive')).toHaveTextContent('Seat is online');
    expect(screen.getByTestId('seat-guide-all-green')).toBeInTheDocument();
  });

  it('presence 显式 offline → 第三步不绿（座位虽被认领但已离线）', () => {
    seatsData = [
      { ...SEAT, runnerId: 'r1', presence: { phase: 'offline', at: new Date().toISOString() } },
    ];
    renderGuide();
    expect(screen.getByTestId('verify-step-alive')).toHaveTextContent(
      'Waiting for the seat to become active',
    );
    expect(screen.queryByTestId('seat-guide-all-green')).not.toBeInTheDocument();
  });

  it('全绿后「去 @ 它试试」：复制 @label 进剪贴板 + 触发 onExit + 瞬态提示', async () => {
    runnersData = [ONLINE_KIMI_RUNNER];
    seatsData = [
      { ...SEAT, runnerId: 'r1', presence: { phase: 'idle', at: new Date().toISOString() } },
    ];
    const onExit = jest.fn();
    renderGuide({ onExit });

    const button = await screen.findByTestId('seat-guide-go-mention');
    fireEvent.click(button);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('@kimi-1 '));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('seat-guide-mention-copied')).toHaveTextContent(
      'Copied "@kimi-1 "',
    );
  });
});

describe('R5 卡死诊断', () => {
  it('runner 在线但 90s 未认领 → amber 提示检查 API Key 归属（fake timers 推进）', async () => {
    jest.useFakeTimers();
    try {
      runnersData = [ONLINE_KIMI_RUNNER];
      renderGuide();
      // fake timers 下首轮查询结算：waitFor 自动推进（<5000ms 不触发轮询，
      // <90s 不触发超时计时）→ runner 在线生效 → 认领计时器启动
      await waitFor(() =>
        expect(screen.getByTestId('verify-step-runner')).toHaveTextContent(
          'A runner supporting kimi is online',
        ),
      );
      expect(screen.queryByTestId('seat-guide-stuck')).not.toBeInTheDocument();

      // 推进 90s（超时阈值）→ amber 提示
      await act(async () => {
        jest.advanceTimersByTime(90_000);
      });
      expect(screen.getByTestId('seat-guide-stuck')).toBeInTheDocument();
      expect(screen.getByTestId('seat-guide-stuck')).toHaveTextContent(
        'but the seat has not been claimed yet',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('认领成功即重置超时计时：90s 内 runnerId 出现 → 无 amber', async () => {
    jest.useFakeTimers();
    try {
      runnersData = [ONLINE_KIMI_RUNNER];
      const { queryClient, rerender } = renderGuide();
      await waitFor(() =>
        expect(screen.getByTestId('verify-step-runner')).toHaveTextContent(
          'A runner supporting kimi is online',
        ),
      );
      // 60s 时座位被认领（seats 迁移）
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      act(() => {
        seatsData = [{ ...SEAT, runnerId: 'r1' }];
        rerender(
          <QueryClientProvider client={queryClient}>
            <RunnerConnectGuide seat={SEAT} topicId={TOPIC_ID} />
          </QueryClientProvider>,
        );
      });
      // 再推进 90s：状态已离开「等待认领」，超时计时已重置，不应出现 amber
      await act(async () => {
        jest.advanceTimersByTime(90_000);
      });
      expect(screen.queryByTestId('seat-guide-stuck')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
