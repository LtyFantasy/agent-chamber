/**
 * RunnerWsClient 测试（真实 ws 服务器 + 随机端口）
 *
 * 覆盖：连接 + hello 对账、心跳 pong、seat.event 先落盘再发送、下行幂等去重、
 * 未确认队列重连重放、退避纯函数、4401/4012 停止重连、stop 清理。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { buildEnvelope, type Envelope, type SeatEvent } from '@agent-chamber/roundtable-protocol';
import { StateStore } from './state-store';
import { RunnerWsClient, nextBackoff } from './ws-client';
import { NoopLogger } from './logger';

jest.setTimeout(15_000);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立（ws 事件异步，避免脆弱 sleep） */
async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timeout');
    }
    await delay(20);
  }
}

/** 启动随机端口 ws 服务器；收到消息全部 push 到 messages */
async function startServer(): Promise<{
  server: WebSocketServer;
  port: number;
  messages: Envelope[];
  connections: WebSocket[];
}> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const messages: Envelope[] = [];
  const connections: WebSocket[] = [];
  server.on('connection', (socket) => {
    connections.push(socket);
    socket.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as Envelope);
    });
  });
  return { server, port, messages, connections };
}

/** server 向全部连接发送信封 */
function serverSend(server: WebSocketServer, envelope: Envelope): void {
  for (const client of server.clients) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(envelope));
    }
  }
}

interface ClientHarness {
  state: StateStore;
  client: RunnerWsClient;
  downlinks: Envelope[];
  connectionChanges: Array<{ connected: boolean; detail?: string }>;
  fatalReasons: string[];
}

function makeClient(opts: {
  port: number;
  stateDir: string;
  vendors?: string[];
  platformUrl?: string;
}): ClientHarness {
  const state = new StateStore({ dir: opts.stateDir, logger: new NoopLogger() });
  state.load();
  const downlinks: Envelope[] = [];
  const connectionChanges: Array<{ connected: boolean; detail?: string }> = [];
  const fatalReasons: string[] = [];
  const client = new RunnerWsClient({
    platformUrl: opts.platformUrl ?? `http://127.0.0.1:${opts.port}`,
    apiKey: 'test-key',
    runnerName: 'test-runner',
    version: '0.1.0',
    state,
    vendors: opts.vendors ?? ['kimi', 'codex'],
    onDownlink: (envelope) => downlinks.push(envelope),
    onConnectionChange: (connected, detail) => connectionChanges.push({ connected, detail }),
    onFatal: (reason) => fatalReasons.push(reason),
    logger: new NoopLogger(),
  });
  return { state, client, downlinks, connectionChanges, fatalReasons };
}

describe('nextBackoff 纯函数（指数退避 1s→30s 上限 + jitter）', () => {
  it('基数翻倍 + ±20% jitter', () => {
    for (let i = 0; i < 50; i += 1) {
      const { delay, next } = nextBackoff(500);
      expect(delay).toBeGreaterThanOrEqual(800); // 1000 * 0.8
      expect(delay).toBeLessThanOrEqual(1200); // 1000 * 1.2
      expect(next).toBe(1000);
    }
  });

  it('30s 封顶（基数与延迟均不超过上限）', () => {
    const { delay, next } = nextBackoff(30_000);
    expect(next).toBe(30_000);
    expect(delay).toBeLessThanOrEqual(30_000);
    expect(delay).toBeGreaterThanOrEqual(24_000);
  });
});

describe('RunnerWsClient 连接与心跳', () => {
  it('连接建立 → 发 hello（version/vendors/各座位对账游标）', async () => {
    const { server, port } = await startServer();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-client-spec-'));
    const state = new StateStore({ dir: stateDir, logger: new NoopLogger() });
    state.load();
    state.setLastReceivedSeq('seat-a', 1);
    state.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'online' }); // lastSentSeq=1
    state.clearPendingEvents('seat-a'); // 只保留游标

    const client = new RunnerWsClient({
      platformUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      runnerName: 'test-runner',
      version: '1.2.3',
      state,
      onDownlink: () => undefined,
      logger: new NoopLogger(),
    });
    const serverMessages: Envelope[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => serverMessages.push(JSON.parse(data.toString()) as Envelope));
    });
    client.start();
    await waitUntil(() => serverMessages.length >= 1);
    const hello = serverMessages[0];
    expect(hello.type).toBe('hello');
    expect(hello.seq).toBe(0);
    expect(hello.seatId).toBeUndefined();
    expect(hello.payload.version).toBe('1.2.3');
    expect(hello.payload.vendors).toEqual(['kimi', 'codex', 'opencode', 'claude-code']);
    expect(hello.payload.name).toBe('test-runner');
    expect(hello.payload.seats).toEqual({ 'seat-a': { lastSentSeq: 1, lastReceivedSeq: 1 } });
    await client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('收 chamber ping → 回 pong（30s 心跳响应）', async () => {
    const { server, port, messages } = await startServer();
    const h = makeClient({ port, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-pong-')) });
    h.client.start();
    await waitUntil(() => messages.some((m) => m.type === 'hello'));
    serverSend(server, buildEnvelope('ping', {}, {}));
    await waitUntil(() => messages.some((m) => m.type === 'pong'));
    const pong = messages.find((m) => m.type === 'pong')!;
    expect(pong.seq).toBe(0);
    await h.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('非法下行（坏 JSON/坏信封）→ 忽略不 crash', async () => {
    const { server, port, connections } = await startServer();
    const h = makeClient({ port, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bad-')) });
    h.client.start();
    await waitUntil(() => connections.length === 1);
    connections[0].send('not json');
    connections[0].send(JSON.stringify({ v: 99, type: 'seat.inject', seq: 0 }));
    await delay(200);
    expect(h.downlinks).toHaveLength(0);
    await h.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('RunnerWsClient 上行 seat.event（先落盘再发送）', () => {
  it('sendSeatEvent：信封正确 + 落盘游标/队列；断线时事件留队列由重放兜底', async () => {
    const { server, port, messages } = await startServer();
    const h = makeClient({ port, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-send-')) });
    h.client.start();
    await waitUntil(() => messages.some((m) => m.type === 'hello'));
    const event: SeatEvent = { type: 'message_chunk', seatId: 'seat-a', text: 'hi' };
    h.client.sendSeatEvent('seat-a', event);
    await waitUntil(() => messages.some((m) => m.type === 'seat.event'));
    const sent = messages.find((m) => m.type === 'seat.event')!;
    expect(sent.seatId).toBe('seat-a');
    expect(sent.seq).toBe(1);
    expect(sent.payload).toEqual(event);
    // 先落盘：state 游标与队列已更新
    expect(h.state.getLastSentSeq('seat-a')).toBe(1);
    expect(h.state.getPendingEvents('seat-a')).toHaveLength(1);
    await h.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('seq 逐条递增（多事件）', async () => {
    const { server, port, messages } = await startServer();
    const h = makeClient({ port, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-seq-')) });
    h.client.start();
    await waitUntil(() => messages.some((m) => m.type === 'hello'));
    h.client.sendSeatEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'online' });
    h.client.sendSeatEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'busy' });
    await waitUntil(() => messages.filter((m) => m.type === 'seat.event').length >= 2);
    const events = messages.filter((m) => m.type === 'seat.event');
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    await h.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('RunnerWsClient 下行幂等去重', () => {
  it('seat.inject 按 seatId+seq 去重并更新 lastReceivedSeq（先落盘再处理）', async () => {
    const { server, port, connections } = await startServer();
    const h = makeClient({ port, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dedup-')) });
    h.client.start();
    await waitUntil(() => connections.length === 1);
    const injectEnv = (seq: number) =>
      buildEnvelope(
        'seat.inject',
        {
          ruleHeader: '# 规则头',
          body: {
            v: 1,
            kind: 'roundtable.inject',
            topic: { id: 't-1', title: '测试桌' },
            seat: { label: 'kimi-1', coordinator: false },
            ruleHeaderVersion: 1,
            batch: { windowMs: 0, messages: [] },
          },
        },
        { seatId: 'seat-a', seq },
      );
    serverSend(server, injectEnv(1));
    await waitUntil(() => h.downlinks.length === 1);
    serverSend(server, injectEnv(1)); // 重复 seq：去重
    serverSend(server, injectEnv(2)); // 新 seq：放行
    await waitUntil(() => h.downlinks.length === 2);
    expect(h.downlinks.map((e) => e.seq)).toEqual([1, 2]);
    expect(h.state.getLastReceivedSeq('seat-a')).toBe(2);
    // 新实例 load（模拟重启）游标仍在 → 重启后重放的同 seq 注入被去重
    const reopened = new StateStore({
      dir: h.state.getStatePath().replace(/state\.json$/, ''),
      logger: new NoopLogger(),
    });
    reopened.load();
    expect(reopened.getLastReceivedSeq('seat-a')).toBe(2);
    await h.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('seat.assign（seq=0）每次执行不参与去重；verdict/cancel/revoke 直接透传', async () => {
    const { server, port, connections } = await startServer();
    const h = makeClient({ port, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-assign-')) });
    h.client.start();
    await waitUntil(() => connections.length === 1);
    const assign = buildEnvelope(
      'seat.assign',
      {
        seatId: 'seat-a',
        label: 'kimi-1',
        vendor: 'kimi',
        cwd: '/tmp',
        permissionMode: 'auto',
      },
      { seatId: 'seat-a', seq: 0 },
    );
    const verdict = buildEnvelope(
      'seat.permission_verdict',
      { requestId: '9001', optionId: 'a1' },
      { seatId: 'seat-a', seq: 1 },
    );
    const cancel = buildEnvelope('seat.cancel', {}, { seatId: 'seat-a', seq: 2 });
    const revoke = buildEnvelope('seat.revoke', {}, { seatId: 'seat-a', seq: 3 });
    serverSend(server, assign);
    serverSend(server, assign); // 重复 assign 也应透传（runner-core start 幂等）
    serverSend(server, verdict);
    serverSend(server, cancel);
    serverSend(server, revoke);
    await waitUntil(() => h.downlinks.length === 5);
    expect(h.downlinks.map((e) => e.type)).toEqual([
      'seat.assign',
      'seat.assign',
      'seat.permission_verdict',
      'seat.cancel',
      'seat.revoke',
    ]);
    // 游标不受 assign/verdict/cancel/revoke 影响（仅 inject 推进）
    expect(h.state.getLastReceivedSeq('seat-a')).toBe(0);
    await h.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('RunnerWsClient 重连与未确认队列重放', () => {
  it('断线 → 指数退避重连（同端口新 server）→ hello + 未确认队列重放（原 seq）→ hello_ack 裁剪已确认区间', async () => {
    // 固定端口：先占用，断线后同端口重启（验证重连路径）
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-replay-'));
    const state = new StateStore({ dir: stateDir, logger: new NoopLogger() });
    state.load();
    const downlinks: Envelope[] = [];

    // 第一段：server1 收 2 条事件（先落盘，队列 2 条）
    const server1 = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server1.once('listening', () => resolve()));
    const port = (server1.address() as AddressInfo).port;
    const client2 = new RunnerWsClient({
      platformUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      runnerName: 'test-runner',
      version: '0.1.0',
      state,
      onDownlink: (e) => downlinks.push(e),
      logger: new NoopLogger(),
    });
    const messages1: Envelope[] = [];
    server1.on('connection', (socket) => {
      socket.on('message', (data) => messages1.push(JSON.parse(data.toString()) as Envelope));
    });
    client2.start();
    await waitUntil(() => messages1.some((m) => m.type === 'hello'));
    client2.sendSeatEvent('seat-a', { type: 'message_chunk', seatId: 'seat-a', text: 'a' });
    client2.sendSeatEvent('seat-a', {
      type: 'message_complete',
      seatId: 'seat-a',
      stopReason: 'end_turn',
    });
    await waitUntil(() => messages1.filter((m) => m.type === 'seat.event').length === 2);
    expect(state.getPendingEvents('seat-a')).toHaveLength(2);

    // 断线：先 terminate 客户端连接（ws 8.21.2 的 server.close() 不主动关闭已建
    // 连接——不断开 client，HTTP server 的 close 回调与端口释放都不会发生）
    for (const c of server1.clients) c.terminate();
    await new Promise<void>((resolve) => server1.close(() => resolve()));

    // 第二段：同端口重启 server2，接收重连后的 hello + 重放
    const server2 = new WebSocketServer({ port });
    await new Promise<void>((resolve) => server2.once('listening', () => resolve()));
    const messages2: Envelope[] = [];
    server2.on('connection', (socket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Envelope;
        messages2.push(msg);
        // 模拟 chamber：收到 hello 后回 hello_ack（阶段 5 债②：携带上行游标，
        // runner 据此裁剪已确认送达区间——取代旧的「重放后无条件清空」）
        if (msg.type === 'hello') {
          socket.send(
            JSON.stringify(
              buildEnvelope(
                'hello_ack',
                { seats: { 'seat-a': { lastEventSeq: 2, failedEventSeqs: [] } } },
                {},
              ),
            ),
          );
        }
      });
    });
    // 重连延迟 ≈1s（初始 500 → 1000±20%），给足窗口
    await waitUntil(() => messages2.filter((m) => m.type === 'seat.event').length === 2, 8000);
    // 重放保持原 seq（chamber 幂等去重依赖）
    const replayed = messages2.filter((m) => m.type === 'seat.event');
    expect(replayed.map((m) => m.seq)).toEqual([1, 2]);
    expect(replayed.map((m) => m.payload)).toMatchObject([
      { type: 'message_chunk', text: 'a' },
      { type: 'message_complete', stopReason: 'end_turn' },
    ]);
    // hello 也已重发（含对账游标 lastSentSeq=2）
    const hello2 = messages2.find((m) => m.type === 'hello');
    expect(hello2).toBeDefined();
    expect(hello2!.payload.seats).toEqual({ 'seat-a': { lastSentSeq: 2, lastReceivedSeq: 0 } });
    // 重放后队列不立即清空（等待 ack）；hello_ack（游标=2，全部已确认）到达后裁剪至空
    await waitUntil(() => state.getPendingEvents('seat-a').length === 0);
    await client2.stop();
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });

  it('断线期间新事件先落盘，重连后一并重放（先落盘再发送语义）', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-replay2-'));
    const state = new StateStore({ dir: stateDir, logger: new NoopLogger() });
    state.load();
    const server1 = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server1.once('listening', () => resolve()));
    const port = (server1.address() as AddressInfo).port;
    const messages1: Envelope[] = [];
    server1.on('connection', (socket) => {
      socket.on('message', (data) => messages1.push(JSON.parse(data.toString()) as Envelope));
    });
    const client = new RunnerWsClient({
      platformUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      runnerName: 'test-runner',
      version: '0.1.0',
      state,
      onDownlink: () => undefined,
      logger: new NoopLogger(),
    });
    client.start();
    await waitUntil(() => messages1.some((m) => m.type === 'hello'));
    // 断线：先 terminate 客户端（否则 server.close 回调与端口释放不会发生）
    for (const c of server1.clients) c.terminate();
    await new Promise<void>((resolve) => server1.close(() => resolve()));
    // 断线窗口内事件：先落盘（此时未连接，发送被跳过）
    client.sendSeatEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'online' });
    expect(state.getLastSentSeq('seat-a')).toBe(1);
    expect(state.getPendingEvents('seat-a')).toHaveLength(1);
    const server2 = new WebSocketServer({ port });
    await new Promise<void>((resolve) => server2.once('listening', () => resolve()));
    const messages2: Envelope[] = [];
    server2.on('connection', (socket) => {
      socket.on('message', (data) => messages2.push(JSON.parse(data.toString()) as Envelope));
    });
    await waitUntil(() => messages2.filter((m) => m.type === 'seat.event').length === 1, 8000);
    await client.stop();
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });

  it('hello_ack：按 chamber 游标裁剪已确认送达区间，留档 seq（failedEventSeqs）不裁（RT-DEBT-2）', async () => {
    const { server, port, messages } = await startServer();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ack-'));
    const state = new StateStore({ dir: stateDir, logger: new NoopLogger() });
    state.load();
    // 4 条未确认：seq 1-4；chamber 游标 = 3 且 seq 2 落库失败留档
    state.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'online' }); // 1
    state.persistSentEvent('seat-a', { type: 'message_chunk', seatId: 'seat-a', text: 'x' }); // 2
    state.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'busy' }); // 3
    state.persistSentEvent('seat-a', { type: 'message_chunk', seatId: 'seat-a', text: 'y' }); // 4

    const client = new RunnerWsClient({
      platformUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      runnerName: 'test-runner',
      version: '0.1.0',
      state,
      onDownlink: () => undefined,
      logger: new NoopLogger(),
    });
    client.start();
    // 等连接建立（hello 到达服务器）后再回 ack，防 serverSend 空投
    await waitUntil(() => messages.some((m) => m.type === 'hello'));
    expect(state.getPendingEvents('seat-a')).toHaveLength(4); // 重放不清空（等待 ack 裁剪）
    // chamber 回 hello_ack：已处理到 3，seq 2 失败留档
    serverSend(
      server,
      buildEnvelope(
        'hello_ack',
        { seats: { 'seat-a': { lastEventSeq: 3, failedEventSeqs: [2] } } },
        {},
      ),
    );
    await waitUntil(() => state.getPendingEvents('seat-a').length === 2);
    const kept = state.getPendingEvents('seat-a').map((e) => e.seq);
    expect(kept).toEqual([2, 4]); // 2 = 留档待重放；4 = 未确认（> 游标）
    await client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('ping 携带游标：长连接期间定期裁剪已确认条目，且照常回 pong（RT-DEBT-2）', async () => {
    const { server, port, messages } = await startServer();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-pingack-'));
    const state = new StateStore({ dir: stateDir, logger: new NoopLogger() });
    state.load();
    state.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'online' }); // 1
    state.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'busy' }); // 2
    state.persistSentEvent('seat-a', { type: 'message_chunk', seatId: 'seat-a', text: 'z' }); // 3

    const client = new RunnerWsClient({
      platformUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      runnerName: 'test-runner',
      version: '0.1.0',
      state,
      onDownlink: () => undefined,
      logger: new NoopLogger(),
    });
    client.start();
    await waitUntil(() => messages.some((m) => m.type === 'hello'));
    serverSend(
      server,
      buildEnvelope('ping', { seats: { 'seat-a': { lastEventSeq: 2, failedEventSeqs: [] } } }, {}),
    );
    await waitUntil(() => messages.some((m) => m.type === 'pong')); // 心跳应答不受影响
    await waitUntil(() => state.getPendingEvents('seat-a').length === 1);
    expect(state.getPendingEvents('seat-a').map((e) => e.seq)).toEqual([3]);
    await client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('RunnerWsClient 4401/4012 停止重连', () => {
  it('close 4401（认证失败）→ onFatal 触发 + 不再重连', async () => {
    const { server, port, connections } = await startServer();
    const h = makeClient({ port, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-4401-')) });
    h.client.start();
    await waitUntil(() => connections.length === 1);
    connections[0].close(4401, 'invalid API key');
    await waitUntil(() => h.fatalReasons.length === 1);
    expect(h.fatalReasons[0]).toContain('4401');
    const connCountAfter = connections.length;
    await delay(1500); // 若未停止重连，会有新连接（同端口 server 仍在监听）
    expect(connections.length).toBe(connCountAfter);
    await h.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('close 4012（被顶替）→ onFatal 触发 + 不再重连（防互踢循环）', async () => {
    const { server, port, connections } = await startServer();
    const h = makeClient({ port, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-4012-')) });
    h.client.start();
    await waitUntil(() => connections.length === 1);
    connections[0].close(4012, 'replaced by a newer connection');
    await waitUntil(() => h.fatalReasons.length === 1);
    expect(h.fatalReasons[0]).toContain('4012');
    const connCountAfter = connections.length;
    await delay(1500);
    expect(connections.length).toBe(connCountAfter);
    await h.client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('普通 close（1006 网络断）→ 指数退避重连', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-reconnect-'));
    const state = new StateStore({ dir: stateDir, logger: new NoopLogger() });
    state.load();
    const server1 = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server1.once('listening', () => resolve()));
    const port = (server1.address() as AddressInfo).port;
    const connectionChanges: Array<{ connected: boolean }> = [];
    const messages1: Envelope[] = [];
    server1.on('connection', (socket) => {
      socket.on('message', (data) => messages1.push(JSON.parse(data.toString()) as Envelope));
    });
    const client = new RunnerWsClient({
      platformUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      runnerName: 'test-runner',
      version: '0.1.0',
      state,
      onDownlink: () => undefined,
      onConnectionChange: (connected) => connectionChanges.push({ connected }),
      logger: new NoopLogger(),
    });
    client.start();
    await waitUntil(() => messages1.some((m) => m.type === 'hello'));
    // 断线（先 terminate 客户端，否则 server.close 回调与端口释放不会发生）
    for (const c of server1.clients) c.terminate();
    await new Promise<void>((resolve) => server1.close(() => resolve()));
    const server2 = new WebSocketServer({ port });
    await new Promise<void>((resolve) => server2.once('listening', () => resolve()));
    const messages2: Envelope[] = [];
    server2.on('connection', (socket) => {
      socket.on('message', (data) => messages2.push(JSON.parse(data.toString()) as Envelope));
    });
    await waitUntil(() => messages2.some((m) => m.type === 'hello'), 8000);
    expect(connectionChanges.filter((c) => c.connected)).toHaveLength(2); // 断 + 重连后各一次 true
    await client.stop();
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });
});

describe('RunnerWsClient stop', () => {
  it('stop：关闭连接、取消重连、无新连接', async () => {
    const { server, port, connections } = await startServer();
    const h = makeClient({ port, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-stop-')) });
    h.client.start();
    await waitUntil(() => connections.length === 1);
    await h.client.stop();
    expect(h.client.isConnected).toBe(false);
    await delay(300);
    expect(connections.length).toBe(1); // 没有重连
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
