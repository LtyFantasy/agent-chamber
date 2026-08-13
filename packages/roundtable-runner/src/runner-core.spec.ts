/**
 * RunnerCore 测试（真实 ws 服务器 + fake driver）
 *
 * 覆盖：seat.assign cwd 校验（缺失回 status error 不拉起）、prompt 装配格式
 * （ruleHeader + '\n\n' + JSON.stringify(body, null, 2)）、事件上行、verdict
 * optionId 直透（RT-PERM-1：kind 命名不可信，不做 kind→verdict 映射）、cancel/revoke、
 * busy 防御回执。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  buildEnvelope,
  type Envelope,
  type SeatConfig,
  type SeatEvent,
} from '@agent-chamber/roundtable-protocol';
import { StateStore } from './state-store';
import { RunnerCore } from './runner-core';
import { BusyError } from './drivers/seat-driver';
import type { InjectedPrompt, SeatDriver } from './drivers/seat-driver';
import type { KimiAcpDriverOptions } from './drivers/kimi-acp';
import type { CodexAcpDriverOptions } from './drivers/codex-acp';
import { NoopLogger } from './logger';

/**
 * 拦截 KimiAcpDriver 构造：捕获构造 options（getSessionId/onSessionId 接线断言用），
 * 返回文件内 FakeDriver 实例。仅未注入 drivers 的用例（默认工厂路径）走该构造器。
 */
const mockCapturedOptions: KimiAcpDriverOptions[] = [];
let mockFakeDriver: FakeDriver;
jest.mock('./drivers/kimi-acp', () => {
  const actual = jest.requireActual('./drivers/kimi-acp');
  return {
    ...actual,
    KimiAcpDriver: jest.fn((options: KimiAcpDriverOptions) => {
      mockCapturedOptions.push(options);
      return mockFakeDriver;
    }),
  };
});

/** 拦截 CodexAcpDriver 构造（同 kimi：默认工厂路径捕获 options + 返回 fake） */
const mockCodexCapturedOptions: CodexAcpDriverOptions[] = [];
let mockCodexFakeDriver: FakeDriver;
jest.mock('./drivers/codex-acp', () => {
  const actual = jest.requireActual('./drivers/codex-acp');
  return {
    ...actual,
    CodexAcpDriver: jest.fn((options: CodexAcpDriverOptions) => {
      mockCodexCapturedOptions.push(options);
      return mockCodexFakeDriver;
    }),
  };
});

jest.setTimeout(15_000);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timeout');
    }
    await delay(20);
  }
}

/** 内存 fake driver：记录调用，可编程失败；事件出口手动触发 */
class FakeDriver implements SeatDriver {
  started: SeatConfig[] = [];
  stopped: string[] = [];
  cancelled: string[] = [];
  injected: Array<{ seatId: string; prompt: InjectedPrompt }> = [];
  answered: Array<{ seatId: string; requestId: string; optionId: string }> = [];
  failStart = false;
  busyOnInject = false;
  private handler: ((event: SeatEvent) => void) | null = null;

  onEvent(handler: (event: SeatEvent) => void): void {
    this.handler = handler;
  }

  /** 测试触发 driver 事件（模拟真实 driver 的事件出口） */
  emit(event: SeatEvent): void {
    this.handler?.(event);
  }

  async start(config: SeatConfig): Promise<void> {
    if (this.failStart) {
      throw new Error('start boom');
    }
    this.started.push(config);
    this.emit({ type: 'status', seatId: config.seatId, status: 'online' });
  }

  async inject(seatId: string, prompt: InjectedPrompt): Promise<void> {
    if (this.busyOnInject) {
      throw new BusyError(seatId);
    }
    this.injected.push({ seatId, prompt });
    this.emit({ type: 'message_complete', seatId, stopReason: 'end_turn' });
  }

  async answerPermission(
    seatId: string,
    requestId: string,
    optionId: string,
  ): Promise<void> {
    this.answered.push({ seatId, requestId, optionId });
  }

  async cancel(seatId: string): Promise<void> {
    this.cancelled.push(seatId);
  }

  async stop(seatId: string): Promise<void> {
    this.stopped.push(seatId);
  }

  async stopAll(): Promise<void> {
    // runner-core stop 遍历驱动实例调用；fake 无需清理
  }
}

interface Harness {
  server: WebSocketServer;
  port: number;
  messages: Envelope[];
  connections: WebSocket[];
  driver: FakeDriver;
  state: StateStore;
  core: RunnerCore;
  stateDir: string;
}

/** 搭建 core + 真实 ws server；返回时已收到 hello（连接就绪） */
async function makeHarness(
  overrides: { failStart?: boolean; busyOnInject?: boolean } = {},
): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const messages: Envelope[] = [];
  const connections: WebSocket[] = [];
  server.on('connection', (socket) => {
    connections.push(socket);
    socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as Envelope));
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-core-spec-'));
  const state = new StateStore({ dir: stateDir, logger: new NoopLogger() });
  const driver = new FakeDriver();
  driver.failStart = overrides.failStart ?? false;
  driver.busyOnInject = overrides.busyOnInject ?? false;
  const core = new RunnerCore({
    platformUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    runnerName: 'test-runner',
    version: '0.1.0',
    state,
    // R4：统一注入口 drivers（按 vendor 注入 fake）
    drivers: { kimi: driver },
    logger: new NoopLogger(),
  });
  core.start();
  await waitUntil(() => messages.some((m) => m.type === 'hello'));
  return { server, port, messages, connections, driver, state, core, stateDir };
}

/** 向 runner 发送下行信封 */
function serverSend(server: WebSocketServer, envelope: Envelope): void {
  for (const client of server.clients) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(envelope));
    }
  }
}

function assignEnvelope(config: SeatConfig): Envelope {
  return buildEnvelope('seat.assign', config as unknown as Record<string, unknown>, {
    seatId: config.seatId,
    seq: 0,
  });
}

const SEAT_CONFIG: SeatConfig = {
  seatId: 'seat-a',
  label: 'kimi-1',
  vendor: 'kimi',
  cwd: '/tmp/roundtable-runner-test-cwd',
  permissionMode: 'auto',
};

/** r3 冻结注入消息体（protocol 包 assembleInjectBody 等价物） */
const INJECT_BODY = {
  v: 1,
  kind: 'roundtable.inject',
  topic: { id: 't-1', title: '测试桌' },
  seat: { label: 'kimi-1', coordinator: false },
  ruleHeaderVersion: 1,
  batch: {
    windowMs: 0,
    messages: [
      {
        id: 'msg-1',
        from: { name: 'tianyu', type: 'human', seatLabel: null, coordinator: false },
        ts: '2026-08-07T12:00:00Z',
        replyTo: null,
        content: '大家好',
      },
    ],
  },
};

function injectEnvelope(seq: number): Envelope {
  return buildEnvelope(
    'seat.inject',
    { ruleHeader: '# 圆桌规则头', body: INJECT_BODY },
    { seatId: 'seat-a', seq },
  );
}

/**
 * 真机形状（RT-PERM-1）：ACP 真实 kind（allow_once/allow_always/reject_once）+
 * 平台 optionId（approve_once/approve_always/reject）——kind 命名不可信，
 * optionId 才是稳定键，runner-core 只反查存在性后原样透传
 */
const PERMISSION_EVENT: SeatEvent = {
  type: 'permission_request',
  seatId: 'seat-a',
  requestId: '9001',
  tool: { id: 'tc-1' },
  options: [
    { optionId: 'approve_once', kind: 'allow_once' },
    { optionId: 'approve_always', kind: 'allow_always' },
    { optionId: 'reject', kind: 'reject_once' },
  ],
};

/** 等待上行 seat.event 满足条件 */
function waitForEvent(
  messages: Envelope[],
  predicate: (m: Envelope) => boolean,
  timeoutMs = 5000,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const found = messages.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timeout waiting for message'));
      }
    }, 20);
  });
}

describe('RunnerCore seat.assign 落地', () => {
  it('cwd 存在 → driver.start + status online 上行', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-cwd-ok-'));
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);
    expect(h.driver.started[0]).toMatchObject({ seatId: 'seat-a', cwd });
    await waitForEvent(
      h.messages,
      (m) =>
        m.type === 'seat.event' &&
        (m.payload as SeatEvent).type === 'status' &&
        (m.payload as Extract<SeatEvent, { type: 'status' }>).status === 'online',
    );
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it('cwd 不存在 → 回 status error 事件（offline + detail）且不拉起 driver', async () => {
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd: '/nonexistent/roundtable-cwd' }));
    const statusEnv = await waitForEvent(
      h.messages,
      (m) => m.type === 'seat.event' && (m.payload as SeatEvent).type === 'status',
    );
    const status = statusEnv.payload as Extract<SeatEvent, { type: 'status' }>;
    expect(status.status).toBe('offline');
    expect(status.detail).toContain('cwd not found');
    expect(h.driver.started).toHaveLength(0);
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it('driver.start 失败 → 回 status offline（不 crash）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-cwd-fail-'));
    const h = await makeHarness({ failStart: true });
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    const statusEnv = await waitForEvent(
      h.messages,
      (m) => m.type === 'seat.event' && (m.payload as SeatEvent).type === 'status',
    );
    const status = statusEnv.payload as Extract<SeatEvent, { type: 'status' }>;
    expect(status.status).toBe('offline');
    expect(status.detail).toContain('start failed');
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });
});

describe('RunnerCore seat.inject 装配与上行', () => {
  it('prompt 文本 = ruleHeader + \'\\n\\n\' + JSON.stringify(body, null, 2)；事件上行透传', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-inject-'));
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);

    const completePromise = waitForEvent(
      h.messages,
      (m) =>
        m.type === 'seat.event' &&
        (m.payload as SeatEvent).type === 'message_complete' &&
        m.seatId === 'seat-a',
    );
    serverSend(h.server, injectEnvelope(1));
    await completePromise;
    expect(h.driver.injected).toHaveLength(1);
    const { prompt } = h.driver.injected[0];
    expect(prompt.text).toBe(`# 圆桌规则头\n\n${JSON.stringify(INJECT_BODY, null, 2)}`);

    // 上行事件 seq 自增且信封正确：assign→online(seq1)，inject→complete(seq2)
    const statusEnvs = h.messages.filter((m) => m.type === 'seat.event');
    expect(statusEnvs.map((m) => m.seq)).toEqual([1, 2]);
    const complete = statusEnvs[1];
    expect(complete.payload).toMatchObject({ type: 'message_complete', stopReason: 'end_turn' });
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it('未绑定座位收到 inject → 忽略（防御）', async () => {
    const h = await makeHarness();
    serverSend(h.server, injectEnvelope(1));
    await delay(200);
    expect(h.driver.injected).toHaveLength(0);
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it('busy 防御：driver.inject 抛 BusyError → 回 status busy 事件', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-busy-'));
    const h = await makeHarness({ busyOnInject: true });
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);
    serverSend(h.server, injectEnvelope(1));
    const busyEnv = await waitForEvent(
      h.messages,
      (m) =>
        m.type === 'seat.event' &&
        (m.payload as SeatEvent).type === 'status' &&
        (m.payload as Extract<SeatEvent, { type: 'status' }>).status === 'busy',
    );
    expect((busyEnv.payload as Extract<SeatEvent, { type: 'status' }>).detail).toContain('busy');
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it('seat_info 事件透传上行（M3 阶段 5 观测：model/thinking/mode 地面真相）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-seatinfo-'));
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);

    const infoPromise = waitForEvent(
      h.messages,
      (m) =>
        m.type === 'seat.event' &&
        (m.payload as SeatEvent).type === 'seat_info' &&
        m.seatId === 'seat-a',
    );
    h.driver.emit({
      type: 'seat_info',
      seatId: 'seat-a',
      model: 'kimi-k2',
      thinking: 'high',
      mode: 'auto',
    });
    const env = await infoPromise;
    expect(env.payload).toMatchObject({
      type: 'seat_info',
      seatId: 'seat-a',
      model: 'kimi-k2',
      thinking: 'high',
      mode: 'auto',
    });
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });
});

describe('RunnerCore permission_verdict 映射', () => {
  it('optionId 原样透传 → answerPermission（approve_always，ACP kind=allow_always 不参与映射）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-verdict-'));
    const h = await makeHarness();
    // 先 assign（verdict 按座位路由驱动——driverFor 依赖 seats 记录）
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);
    // 模拟 driver 事件出口：先触发 permission_request（core 缓存 options）
    h.driver.emit(PERMISSION_EVENT);
    const verdictEnv = buildEnvelope(
      'seat.permission_verdict',
      { requestId: '9001', optionId: 'approve_always' },
      { seatId: 'seat-a', seq: 5 },
    );
    serverSend(h.server, verdictEnv);
    await waitUntil(() => h.driver.answered.length === 1);
    // 透传的是 optionId 原文（与 ACP request_permission params 同源），非 kind 猜测映射
    expect(h.driver.answered[0]).toEqual({
      seatId: 'seat-a',
      requestId: '9001',
      optionId: 'approve_always',
    });
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it('reject 选项（ACP kind=reject_once）同样按 optionId 直透', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-verdict2-'));
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);
    h.driver.emit(PERMISSION_EVENT);
    serverSend(
      h.server,
      buildEnvelope(
        'seat.permission_verdict',
        { requestId: '9001', optionId: 'reject' },
        { seatId: 'seat-a', seq: 5 },
      ),
    );
    await waitUntil(() => h.driver.answered.length === 1);
    expect(h.driver.answered[0]).toEqual({
      seatId: 'seat-a',
      requestId: '9001',
      optionId: 'reject',
    });
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it('未知 requestId / 未知 optionId → 忽略不 crash', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-verdict3-'));
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);
    h.driver.emit(PERMISSION_EVENT);
    serverSend(
      h.server,
      buildEnvelope(
        'seat.permission_verdict',
        { requestId: 'unknown-1', optionId: 'approve_always' },
        { seatId: 'seat-a', seq: 6 },
      ),
    );
    serverSend(
      h.server,
      buildEnvelope(
        'seat.permission_verdict',
        { requestId: '9001', optionId: 'no-such-option' },
        { seatId: 'seat-a', seq: 7 },
      ),
    );
    await delay(200);
    expect(h.driver.answered).toHaveLength(0);
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });
});

describe('RunnerCore cancel / revoke', () => {
  it('seat.cancel → driver.cancel', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-cancel-'));
    const h = await makeHarness();
    // 先 assign（cancel 按座位路由驱动——driverFor 依赖 seats 记录）
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);
    serverSend(h.server, buildEnvelope('seat.cancel', {}, { seatId: 'seat-a', seq: 1 }));
    await waitUntil(() => h.driver.cancelled.length === 1);
    expect(h.driver.cancelled).toEqual(['seat-a']);
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it('seat.cancel → 清权限缓存（cancel 后迟到 verdict 幂等忽略，不路由 driver）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-cancel-perm-'));
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);
    // 挂起审批入缓存 → seat.cancel 应清空该座位全部审批缓存（与 revoke 同款前缀清理）
    h.driver.emit(PERMISSION_EVENT);
    serverSend(h.server, buildEnvelope('seat.cancel', {}, { seatId: 'seat-a', seq: 1 }));
    await waitUntil(() => h.driver.cancelled.length === 1);
    // 迟到的 verdict（审批已随 cancel 关闭）：缓存缺失 → 忽略，不路由 answerPermission
    serverSend(
      h.server,
      buildEnvelope(
        'seat.permission_verdict',
        { requestId: '9001', optionId: 'approve_always' },
        { seatId: 'seat-a', seq: 2 },
      ),
    );
    await delay(200);
    expect(h.driver.answered).toHaveLength(0);
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });

  it('seat.revoke → driver.stop + 清状态（state 移除）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-revoke-'));
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, cwd }));
    await waitUntil(() => h.driver.started.length === 1);
    serverSend(h.server, buildEnvelope('seat.revoke', {}, { seatId: 'seat-a', seq: 1 }));
    await waitUntil(() => h.driver.stopped.length === 1);
    expect(h.driver.stopped).toEqual(['seat-a']);
    expect(h.state.getSeatIds()).toEqual([]);
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });
});

describe('RunnerCore 默认驱动工厂（vendor → 懒加载）', () => {
  it('kimi/codex 座位 → 各自默认驱动实例；getSessionId/onSessionId 接到 state-store（接线断言）', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const messages: Envelope[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as Envelope));
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-core-wire-'));
    const state = new StateStore({ dir: stateDir, logger: new NoopLogger() });
    state.setSessionId('seat-a', 'sess-persisted'); // 预置落盘 sessionId（模拟上次运行遗留）
    const kimiDriver = new FakeDriver();
    const codexDriver = new FakeDriver();
    mockCapturedOptions.length = 0;
    mockFakeDriver = kimiDriver;
    mockCodexCapturedOptions.length = 0;
    mockCodexFakeDriver = codexDriver;
    const core = new RunnerCore({
      platformUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      runnerName: 'test-runner',
      version: '0.1.0',
      state,
      // 不注入 drivers → 默认工厂懒加载 mock 的 KimiAcpDriver/CodexAcpDriver
      logger: new NoopLogger(),
    });
    core.start();
    await waitUntil(() => messages.some((m) => m.type === 'hello'));

    // 懒加载工厂：首个 kimi 座位 assign 时才构造 KimiAcpDriver（capturedOptions 此时才有）
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-wire-cwd-'));
    serverSend(server, assignEnvelope({ ...SEAT_CONFIG, seatId: 'seat-a', cwd }));
    await waitUntil(() => kimiDriver.started.length === 1);
    serverSend(server, assignEnvelope({ ...SEAT_CONFIG, seatId: 'seat-b', vendor: 'codex', cwd }));
    await waitUntil(() => codexDriver.started.length === 1);

    expect(mockCapturedOptions).toHaveLength(1);
    const opts = mockCapturedOptions[0];
    // getSessionId 读取 state 预置 id（resume 复活数据源；缺此接线永远 session/new）
    expect(opts.getSessionId?.('seat-a')).toBe('sess-persisted');
    expect(opts.getSessionId?.('unknown-seat')).toBeUndefined();
    // onSessionId 落盘进 state（会话建立后覆盖写入）
    opts.onSessionId?.('seat-a', 'sess-new');
    expect(state.getSessionId('seat-a')).toBe('sess-new');
    expect(mockCodexCapturedOptions).toHaveLength(1);
    const codexOpts = mockCodexCapturedOptions[0];
    expect(codexOpts.getSessionId?.('seat-b')).toBeUndefined();
    codexOpts.onSessionId?.('seat-b', 'sess-codex');
    expect(state.getSessionId('seat-b')).toBe('sess-codex');
    await core.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('未知 vendor（如 gpt）→ 座位 status offline（detail 带 vendor 名），不 crash 不拉起', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-unknown-vendor-'));
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, seatId: 'seat-gpt', vendor: 'gpt', cwd }));
    const statusEnv = await waitForEvent(
      h.messages,
      (m) =>
        m.type === 'seat.event' &&
        (m.payload as SeatEvent).type === 'status' &&
        m.seatId === 'seat-gpt',
    );
    const status = statusEnv.payload as Extract<SeatEvent, { type: 'status' }>;
    expect(status.status).toBe('offline');
    expect(status.detail).toContain('unsupported vendor: gpt');
    expect(h.driver.started).toHaveLength(0);
    // 后续注入该未知 vendor 座位 → 忽略（座位未记录，driver 不拉起）
    serverSend(
      h.server,
      buildEnvelope(
        'seat.inject',
        { ruleHeader: '# 圆桌规则头', body: INJECT_BODY },
        { seatId: 'seat-gpt', seq: 1 },
      ),
    );
    await delay(200);
    expect(h.driver.injected).toHaveLength(0);
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });
});

describe('RunnerCore R1 审批缓存跨座位隔离（seatId 前缀 key）', () => {
  it('两座位同 requestId（如 codex 反向 RPC id=0）并发审批不串：verdict 各自路由', async () => {
    const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'core-r1-a-'));
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'core-r1-b-'));
    const h = await makeHarness();
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, seatId: 'seat-a', cwd: cwdA }));
    serverSend(h.server, assignEnvelope({ ...SEAT_CONFIG, seatId: 'seat-b', cwd: cwdB }));
    await waitUntil(() => h.driver.started.length === 2);
    // 两座位各自挂起一个 requestId='0' 的审批（旧实现裸 key 会互相覆盖）
    h.driver.emit({
      type: 'permission_request',
      seatId: 'seat-a',
      requestId: '0',
      tool: { id: 'tc-a' },
      options: [{ optionId: 'allow_once', kind: 'allow_once' }],
    });
    h.driver.emit({
      type: 'permission_request',
      seatId: 'seat-b',
      requestId: '0',
      tool: { id: 'tc-b' },
      options: [{ optionId: 'reject_once', kind: 'reject_once' }],
    });
    // seat-a 的 verdict：选项在 seat-a 的缓存里（seat-b 的同 requestId 不干扰）
    serverSend(
      h.server,
      buildEnvelope(
        'seat.permission_verdict',
        { requestId: '0', optionId: 'allow_once' },
        { seatId: 'seat-a', seq: 5 },
      ),
    );
    await waitUntil(() => h.driver.answered.length === 1);
    expect(h.driver.answered).toEqual([{ seatId: 'seat-a', requestId: '0', optionId: 'allow_once' }]);
    // seat-b 的 verdict 照常路由（缓存未被 seat-a 的 verdict 清掉）
    serverSend(
      h.server,
      buildEnvelope(
        'seat.permission_verdict',
        { requestId: '0', optionId: 'reject_once' },
        { seatId: 'seat-b', seq: 6 },
      ),
    );
    await waitUntil(() => h.driver.answered.length === 2);
    expect(h.driver.answered[1]).toEqual({ seatId: 'seat-b', requestId: '0', optionId: 'reject_once' });
    await h.core.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  });
});
