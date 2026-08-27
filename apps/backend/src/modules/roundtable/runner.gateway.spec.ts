/**
 * RunnerGateway 集成测试（阶段 2 WS spike 结论的落地验证）
 *
 * 真实 Nest app（WsAdapter + 随机端口）+ 真 ws 客户端：
 * - 握手认证：无 key / 坏 key → close(4401)（spike 结论②）
 * - 好 key → hello → 座位绑定 → seat.assign 下行（信封形状断言）
 * - 信封校验：非法 JSON / 非法信封 / 下行方向被上行 → error 帧（spike 结论③）
 * - 端到端回流：message_chunk + message_complete → 回复落 topic（sendMessage 参数断言）
 * - 一 key 一 runner（§7）：同 key 第二连接踢掉第一连接 close(4012)
 *
 * 每个测试重建 app + 全新 mock（mock 内含 runnerExists/座位绑定等闭包状态，避免跨测试泄漏）。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { AgentStatus, ActorType } from '@agent-chamber/shared';
import { buildEnvelope } from '@agent-chamber/roundtable-protocol';
import { RunnerGateway } from './runner.gateway';
import { RunnerRegistryService } from './runner-registry.service';
import { RoundtableService } from './roundtable.service';
import { ApiKeyAuthService } from '../../common/services/api-key-auth.service';
import { RoundtableRunner } from '../../database/entities/roundtable-runner.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { RoundtablePermissionRequest } from '../../database/entities/roundtable-permission-request.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Message } from '../../database/entities/message.entity';
import { Actor } from '../../database/entities/actor.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { TopicService } from '../topic/topic.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { ActorProfileService, ActorProfile } from '../../common/services/actor-profile.service';

const VALID_KEY = 'ask_test_gateway_key_123';

/** 测试共享 mock 集合（每次构建全新实例，闭包状态不跨测试泄漏） */
function createMocks() {
  const runnerRow = {
    id: 'runner-1',
    name: 'Test Agent',
    actorId: 'agent-1',
    status: 'online',
    version: null as string | null,
    vendors: [] as string[],
    lastSeenAt: null as Date | null,
  };
  const seatRow = {
    id: 'seat-1',
    topicId: 'topic-1',
    label: 'kimi-1',
    vendor: 'kimi',
    runnerId: null as string | null,
    config: { permissionMode: 'auto', cwd: '/tmp/seat', bindActorId: 'agent-1' },
    state: {},
    status: 'active',
    coordinator: false,
    lastEventSeq: '0',
    lastInjectSeq: '0',
  };
  let runnerExists = false;
  return {
    runnerRow,
    seatRow,
    runnerRepo: {
      findOne: jest.fn(async () => {
        if (!runnerExists) return null;
        return runnerRow;
      }),
      create: jest.fn((input: unknown) => ({ ...runnerRow, ...(input as object) })),
      save: jest.fn(async (row: unknown) => {
        runnerExists = true;
        Object.assign(runnerRow, row);
        return runnerRow;
      }),
      update: jest.fn(async () => ({ affected: 1 })),
    },
    seatRepo: {
      findOne: jest.fn(async () => seatRow),
      find: jest.fn(async () => [seatRow]),
      create: jest.fn(),
      save: jest.fn(async (row: unknown) => row),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => [seatRow]),
      })),
    },
    topicRepo: { findOne: jest.fn(async () => ({ id: 'topic-1', title: '圆桌测试' })) },
    messageRepo: { findOne: jest.fn(), find: jest.fn() },
    actorRepo: {
      findOne: jest.fn(),
      find: jest.fn(async (_criteria: unknown) => []),
    },
    apiKeyRepo: {
      // 默认实现（有效 key）在 buildApp 中统一设置（保持 jest.fn 无类型约束，便于
      // 坏 key 测试 mockResolvedValueOnce(null)）
      findOne: jest.fn(),
      save: jest.fn(async (row: unknown) => row),
    },
    agentRepo: {
      findOne: jest.fn(async () => ({
        id: 'agent-1',
        name: 'Test Agent',
        ownerId: 'owner-1',
        lastActiveAt: null,
        actor: { status: AgentStatus.ACTIVE, deletedAt: null },
      })),
      save: jest.fn(async (row: unknown) => row),
    },
    topicService: {
      findById: jest.fn(),
      sendMessage: jest.fn(async () => ({ id: 'reply-1' })),
      isActiveParticipant: jest.fn(async () => true),
      join: jest.fn(async () => undefined),
    },
    permService: { ensureCan: jest.fn() },
    ownerProxy: { isOwnerProxy: jest.fn(async () => false) },
    permReqRepo: {
      findOne: jest.fn(async () => null),
      find: jest.fn(async () => []),
      create: jest.fn((input: unknown) => input),
      save: jest.fn(async (row: unknown) => row),
      findAndCount: jest.fn(async () => [[], 0]),
      count: jest.fn(async () => 0),
    },
    participantRepo: { find: jest.fn(async () => []) },
  };
}

type MockSet = ReturnType<typeof createMocks>;

describe('RunnerGateway (integration, real ws client)', () => {
  let app: INestApplication;
  let port: number;
  let mocks: MockSet;
  /** buildApp 创建的测试模块（M4b-1：cancel 下行信封测试经 service 直调触发，断言信封经真实 ws 到达） */
  let moduleRef: TestingModule;

  const url = () => `ws://127.0.0.1:${port}/ws/runner`;
  const keyHeaders = { 'x-api-key': VALID_KEY };

  /** 打开连接（open 事件后 resolve） */
  function openSocket(headers?: Record<string, string>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url(), { headers: headers ?? {} });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  /** 等待 close（返回关闭码与原因） */
  function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  /** 等待下一帧（JSON 解析） */
  function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for ws message')),
        timeoutMs,
      );
      ws.on('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      ws.on('close', (code) => reject(new Error(`closed before message: ${code}`)));
    });
  }

  /** 等待 mock 被调用（异步服务端处理轮询） */
  async function waitForCall(mock: jest.Mock, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (mock.mock.calls.length === 0) {
      if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for mock call');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** 每个测试重建 app（mock 闭包状态不跨测试泄漏） */
  async function buildApp(): Promise<void> {
    mocks = createMocks();
    // 默认有效 API Key（认证通过路径）；坏 key 测试用 mockResolvedValueOnce(null) 覆盖
    mocks.apiKeyRepo.findOne.mockResolvedValue({
      agentId: 'agent-1',
      revokedAt: null,
      deletedAt: null,
      expiresAt: null,
      permissions: {},
      lastUsedAt: null,
    });
    const moduleRefBuilt: TestingModule = await Test.createTestingModule({
      providers: [
        RunnerGateway,
        RunnerRegistryService,
        RoundtableService,
        ApiKeyAuthService,
        // 统一批 A2：RoundtableService 依赖 ActorProfileService（projectMessage 公共解析）。
        // mock 以 actorRepo.find 行为准（默认空 → 真孤儿，注入路径不解析名字也不报错）。
        {
          provide: ActorProfileService,
          useValue: {
            resolveProfiles: jest.fn(
              async (actorIds: string[]): Promise<Map<string, ActorProfile>> => {
                const uniqueIds = [...new Set(actorIds)].filter(Boolean);
                const map = new Map<string, ActorProfile>();
                if (uniqueIds.length === 0) return map;
                const rows = (await mocks.actorRepo.find({} as any)) as Array<{
                  id: string;
                  type: ActorType;
                  displayName?: string | null;
                  avatarUrl?: string | null;
                  deletedAt?: Date | null;
                }>;
                const rowMap = new Map(rows.map((a) => [a.id, a]));
                for (const id of uniqueIds) {
                  const row = rowMap.get(id);
                  if (!row) continue;
                  map.set(id, {
                    type: row.type,
                    name: row.displayName || 'System',
                    avatarUrl: row.avatarUrl ?? null,
                    description: null,
                    deletedAt: row.deletedAt ?? null,
                  });
                }
                return map;
              },
            ),
            assertActorUsable: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: getRepositoryToken(RoundtableRunner), useValue: mocks.runnerRepo },
        { provide: getRepositoryToken(RoundtableSeat), useValue: mocks.seatRepo },
        { provide: getRepositoryToken(RoundtablePermissionRequest), useValue: mocks.permReqRepo },
        { provide: getRepositoryToken(TopicParticipant), useValue: mocks.participantRepo },
        { provide: getRepositoryToken(Topic), useValue: mocks.topicRepo },
        { provide: getRepositoryToken(Message), useValue: mocks.messageRepo },
        { provide: getRepositoryToken(Actor), useValue: mocks.actorRepo },
        { provide: getRepositoryToken(ApiKey), useValue: mocks.apiKeyRepo },
        { provide: getRepositoryToken(Agent), useValue: mocks.agentRepo },
        { provide: TopicService, useValue: mocks.topicService },
        { provide: PermissionService, useValue: mocks.permService },
        { provide: OwnerProxyService, useValue: mocks.ownerProxy },
      ],
    }).compile();
    moduleRef = moduleRefBuilt;
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  }

  beforeEach(async () => {
    await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('握手认证（spike 结论②：handleConnection 内读 header → close(4401)）', () => {
    it('无 X-API-Key → close 4401', async () => {
      const ws = await openSocket();
      const closed = await waitForClose(ws);
      expect(closed.code).toBe(4401);
    });

    it('坏 key（认证失败）→ close 4401', async () => {
      mocks.apiKeyRepo.findOne.mockResolvedValueOnce(null);
      const ws = await openSocket(keyHeaders);
      const closed = await waitForClose(ws);
      expect(closed.code).toBe(4401);
    });
  });

  describe('hello 对账 + 座位绑定（seat.assign 下行）', () => {
    it('好 key → hello → 绑定座位 → seat.assign 信封（SeatConfig 即 payload）', async () => {
      const ws = await openSocket(keyHeaders);
      const msgPromise = waitForMessage(ws);
      ws.send(
        JSON.stringify(
          buildEnvelope('hello', { version: '0.1.0', vendors: ['kimi'], seats: {} }, {}),
        ),
      );
      const msg = await msgPromise;
      expect(msg.type).toBe('seat.assign');
      expect(msg.seatId).toBe('seat-1');
      expect(msg.seq).toBe(0);
      expect(msg.payload).toEqual({
        seatId: 'seat-1',
        label: 'kimi-1',
        vendor: 'kimi',
        cwd: '/tmp/seat',
        permissionMode: 'auto',
      });
      // 绑定落库（runner_id + status active）
      expect(mocks.seatRow.runnerId).toBe('runner-1');
      expect(mocks.seatRow.status).toBe('active');
      ws.close();
    });

    it('hello 处理完成后 → hello_ack 下行（各座位上行游标，阶段 5 债②）', async () => {
      const ws = await openSocket(keyHeaders);
      // 缓冲式收帧：seat.assign 与 hello_ack 可能在同一事件循环突发中连发——
      // 若等第一帧 resolve 后才挂第二个 message 监听器，第二帧已在挂载前发出而永久
      // 丢失（waitForMessage 两次调用间的竞态，实测 3 次单跑挂 1 次）。一次性挂监听
      // 收满 2 帧再断言，与帧到达时序无关。
      const frames: Record<string, unknown>[] = [];
      const twoFrames = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for 2 frames')), 5000);
        ws.on('message', (data) => {
          frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
          if (frames.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.on('close', (code) => reject(new Error(`closed before message: ${code}`)));
      });
      ws.send(
        JSON.stringify(
          buildEnvelope('hello', { version: '0.1.0', vendors: ['kimi'], seats: {} }, {}),
        ),
      );
      await twoFrames;
      expect(frames[0].type).toBe('seat.assign'); // seat.assign 先于回执（绑定是业务前件）
      const ack = frames[1];
      expect(ack.type).toBe('hello_ack');
      expect(ack.seq).toBe(0);
      expect(ack.seatId).toBeUndefined();
      expect(ack.payload).toEqual({
        seats: { 'seat-1': { lastEventSeq: 0, failedEventSeqs: [] } },
      });
      ws.close();
    });
  });

  describe('信封校验（spike 结论③：错误一律显式 error 帧回执）', () => {
    it('非法 JSON → error INVALID_JSON', async () => {
      const ws = await openSocket(keyHeaders);
      const msgPromise = waitForMessage(ws);
      ws.send('this is not json');
      const msg = await msgPromise;
      expect(msg.type).toBe('error');
      expect(msg.payload).toMatchObject({ code: 'INVALID_JSON' });
      ws.close();
    });

    it('信封缺 type（validateEnvelope 失败）→ error INVALID_ENVELOPE', async () => {
      const ws = await openSocket(keyHeaders);
      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ v: 1, seq: 0, ts: Date.now(), payload: {} }));
      const msg = await msgPromise;
      expect(msg.type).toBe('error');
      expect(msg.payload).toMatchObject({ code: 'INVALID_ENVELOPE' });
      ws.close();
    });

    it('下行类型被上行（ping）→ error INVALID_DIRECTION', async () => {
      const ws = await openSocket(keyHeaders);
      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify(buildEnvelope('ping', {}, {})));
      const msg = await msgPromise;
      expect(msg.type).toBe('error');
      expect(msg.payload).toMatchObject({ code: 'INVALID_DIRECTION' });
      ws.close();
    });
  });

  describe('回流落 topic（端到端）', () => {
    it('message_chunk 累积 + message_complete → 回复以 runner actor 身份落 topic', async () => {
      const ws = await openSocket(keyHeaders);
      const assignPromise = waitForMessage(ws);
      ws.send(
        JSON.stringify(
          buildEnvelope('hello', { version: '0.1.0', vendors: ['kimi'], seats: {} }, {}),
        ),
      );
      await assignPromise;

      ws.send(
        JSON.stringify(
          buildEnvelope(
            'seat.event',
            { seatId: 'seat-1', type: 'message_chunk', text: '好的，' },
            { seatId: 'seat-1', seq: 1 },
          ),
        ),
      );
      ws.send(
        JSON.stringify(
          buildEnvelope(
            'seat.event',
            { seatId: 'seat-1', type: 'message_chunk', text: '我来处理。' },
            { seatId: 'seat-1', seq: 2 },
          ),
        ),
      );
      ws.send(
        JSON.stringify(
          buildEnvelope(
            'seat.event',
            { seatId: 'seat-1', type: 'message_complete', stopReason: 'end' },
            { seatId: 'seat-1', seq: 3 },
          ),
        ),
      );
      await waitForCall(mocks.topicService.sendMessage);
      expect(mocks.topicService.sendMessage).toHaveBeenCalledWith(
        'topic-1',
        'agent-1',
        ActorType.AGENT,
        {
          content: '好的，我来处理。',
          metadata: { seatLabel: 'kimi-1' },
          clientRequestId: 'rt:seat-1:3',
        },
      );
      ws.close();
    });
  });

  describe('seat.cancel 下行（M4b-1：busy 座位经 service.cancelSeat 触发 → 信封经真实 ws 到达）', () => {
    it('busy 座位 cancel → seat.cancel 信封（seatId + seq=0 + 空 payload）', async () => {
      const ws = await openSocket(keyHeaders);
      // hello 处理会连发两帧（seat.assign + hello_ack）——一次性收满再继续，
      // 避免 hello_ack 帧被后续 cancelPromise 误收（与 hello_ack 测试同规防竞态）
      const frames: Record<string, unknown>[] = [];
      const twoFrames = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for 2 frames')), 5000);
        ws.on('message', (data) => {
          frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
          if (frames.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.on('close', (code) => reject(new Error(`closed before message: ${code}`)));
      });
      ws.send(
        JSON.stringify(
          buildEnvelope('hello', { version: '0.1.0', vendors: ['kimi'], seats: {} }, {}),
        ),
      );
      await twoFrames;
      expect(frames[0].type).toBe('seat.assign'); // 绑定完成
      expect(frames[1].type).toBe('hello_ack');

      const roundtable = moduleRef.get(RoundtableService);
      // 先构造 busy 相位：status busy 上行 → presence=thinking（R4 映射）
      await roundtable.handleSeatEvent(
        'runner-1',
        buildEnvelope(
          'seat.event',
          { seatId: 'seat-1', type: 'status', status: 'busy' },
          { seatId: 'seat-1', seq: 1 },
        ),
      );
      // cancel 走真实 service：mock topic 查询与权限（creator 身份放行）
      mocks.topicService.findById.mockResolvedValue({
        id: 'topic-1',
        title: 't',
        creatorId: 'user-1',
      });
      mocks.permService.ensureCan.mockResolvedValue(undefined);
      const creatorActor = { id: 'user-1', type: ActorType.HUMAN, name: 'Tianyu' };

      const cancelPromise = waitForMessage(ws);
      const result = await roundtable.cancelSeat('seat-1', creatorActor);
      expect(result).toEqual({ accepted: true, seatId: 'seat-1' });
      const frame = await cancelPromise;
      expect(frame.type).toBe('seat.cancel');
      expect(frame.seatId).toBe('seat-1');
      expect(frame.seq).toBe(0);
      expect(frame.payload).toEqual({});
      ws.close();
    });
  });

  describe('一 key 一 runner（§7 后到踢先到）', () => {
    it('同 key 第二连接 → 第一连接 close(4012)', async () => {
      const ws1 = await openSocket(keyHeaders);
      // 等 ws1 完成注册 + 绑定（收到 seat.assign）再上第二连接，消除注册竞态
      const assign1 = waitForMessage(ws1);
      ws1.send(
        JSON.stringify(
          buildEnvelope('hello', { version: '0.1.0', vendors: ['kimi'], seats: {} }, {}),
        ),
      );
      await assign1;

      const closed1 = waitForClose(ws1);
      const ws2 = await openSocket(keyHeaders);
      const closed = await closed1;
      expect(closed.code).toBe(4012);
      expect(closed.reason).toContain('replaced');

      // 新连接可正常绑定（同 runner 行，seat 已绑定 → 直接 assign）
      const assign2 = waitForMessage(ws2);
      ws2.send(
        JSON.stringify(
          buildEnvelope('hello', { version: '0.1.0', vendors: ['kimi'], seats: {} }, {}),
        ),
      );
      expect((await assign2).type).toBe('seat.assign');
      ws2.close();
    });
  });
});
