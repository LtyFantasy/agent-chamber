/**
 * RoundtableService 单测（M1 计划阶段 3，铁律 #17：状态流转必须同步测试）
 *
 * 覆盖：注入触发器过滤链（非 NEW_MESSAGE/幻影免疫/自激防护/未绑定跳过）、单飞行 FIFO
 * （busy 排队 → message_complete 排空 → 顺序保持）、沉默拦截跳过落库、chunk 累积拼装
 * 落 topic（身份模型参数）、complete 自带 text 优先落库、落库失败游标不推进、seq 幂等
 * 去重、usage/status/permission_request 上行、归属校验、hello 对账（缺口重建 + 原 seq +
 * runner 超前采纳游标防复用楔死）、座位 CRUD 权限与 404、规则头快照。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventType, ActorType, ErrorCode, MessageType, UserRole } from '@agent-chamber/shared';
import { In, Not } from 'typeorm';
import {
  buildEnvelope,
  type Envelope,
  type InjectBody,
  type InjectPayload,
} from '@agent-chamber/roundtable-protocol';
import { RoundtableService, ALL_WAKE_COOLDOWN_MS, type SeatPresence } from './roundtable.service';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { RoundtableRunner } from '../../database/entities/roundtable-runner.entity';
import { RoundtablePermissionRequest } from '../../database/entities/roundtable-permission-request.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Message } from '../../database/entities/message.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Event } from '../../database/entities/event.entity';
import { TopicService } from '../topic/topic.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { RunnerRegistryService } from './runner-registry.service';
import { UnifiedActor } from '../../common/types/actor.types';

// ─────────────────────────── 构造器 ───────────────────────────

function makeSeat(overrides: Partial<RoundtableSeat> = {}) {
  return {
    id: 'seat-1',
    topicId: 'topic-1',
    label: 'kimi-1',
    vendor: 'kimi',
    runnerId: 'runner-1' as string | null,
    // batchWindowMs: 0 = 直通（M1 行为）——现有直通用例的默认值；攒批用例显式传 >0
    config: { permissionMode: 'auto', cwd: '/tmp/seat', bindActorId: 'agent-1', batchWindowMs: 0 },
    state: { recentInjects: [] },
    status: 'active',
    coordinator: false,
    lastEventSeq: '0',
    lastInjectSeq: '0',
    ...overrides,
  } as unknown as RoundtableSeat;
}

function makeMessage(overrides: Partial<Message> = {}) {
  return {
    id: 'msg-1',
    topicId: 'topic-1',
    senderId: 'agent-1',
    content: 'hello',
    metadata: {},
    replyToId: null,
    createdAt: new Date('2026-08-07T12:00:00Z'),
    ...overrides,
  } as unknown as Message;
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    eventType: EventType.NEW_MESSAGE,
    topicId: 'topic-1',
    resourceId: 'msg-1',
    actorId: 'agent-1',
    ...overrides,
  } as unknown as Event;
}

/** 构造 seat.event 信封（跳过协议校验，直接进入 service 层） */
function seatEventEnvelope(seq: number, payload: Record<string, unknown>): Envelope {
  return buildEnvelope('seat.event', payload, { seatId: 'seat-1', seq });
}

/** 构造合法 seat.event payload（按类型） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function eventPayload(type: string, extra: Record<string, any> = {}): Record<string, unknown> {
  return { seatId: 'seat-1', type, ...extra };
}

const AGENT_ACTOR: UnifiedActor = { id: 'agent-1', type: ActorType.AGENT, name: 'Test Agent' };
const HUMAN_ACTOR: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN, name: 'Tianyu' };
const HUMAN_ADMIN_ACTOR: UnifiedActor = {
  id: 'admin-1',
  type: ActorType.HUMAN,
  name: 'Platform Admin',
  role: UserRole.ADMIN,
};

/** 系统 actor 哨兵 id（与 service 内 SYSTEM_ACTOR_ID 同值，公告断言用） */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * 构造最小合法 PendingInject（注入埋点用例用；buildEnvelope 不校验 payload 结构，
 * 仅信封级语义，故 payload 形状从简）
 */
function makePendingInject(seq: number, messageIds: string[] = ['msg-1']) {
  return {
    seq,
    payload: { ruleHeader: '', body: { batch: { messages: [] } } } as unknown as InjectPayload,
    messageIds,
  };
}

/** 构造审批请求行（M3 阶段 1 默认 pending；options 为 ACP 三选项形状 {optionId, kind, label}） */
function makePermissionRequest(overrides: Partial<RoundtablePermissionRequest> = {}) {
  return {
    id: 'pr-1',
    requestId: 'req-1',
    seatId: 'seat-1',
    topicId: 'topic-1',
    tool: { name: 'bash', input: 'rm -rf /tmp/x' },
    options: [
      { optionId: 'approve_once', kind: 'approve_once', label: 'Approve once' },
      { optionId: 'approve_always', kind: 'approve_always', label: 'Approve always' },
      { optionId: 'reject', kind: 'reject', label: 'Reject' },
    ],
    status: 'pending',
    verdictOptionId: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date('2026-08-08T10:00:00Z'),
    ...overrides,
  } as unknown as RoundtablePermissionRequest;
}

/** 冲刷微任务队列（fire-and-forget 异步路径（回执等）完成后再断言） */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('RoundtableService', () => {
  let service: RoundtableService;
  let seatRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  /** r17 冲突检查的 queryBuilder 链式 mock（RT-SEAT-1：jsonb 路径提取须走 queryBuilder） */
  let seatQb: { where: jest.Mock; andWhere: jest.Mock; getOne: jest.Mock };
  let runnerRepo: { findOne: jest.Mock; find: jest.Mock };
  let topicRepo: { findOne: jest.Mock };
  let messageRepo: { findOne: jest.Mock; find: jest.Mock };
  let actorRepo: { findOne: jest.Mock };
  let permReqRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findAndCount: jest.Mock;
    count: jest.Mock;
  };
  let participantRepo: { find: jest.Mock };
  let topicService: {
    findById: jest.Mock;
    sendMessage: jest.Mock;
    isActiveParticipant: jest.Mock;
    join: jest.Mock;
  };
  let permService: { ensureCan: jest.Mock };
  let registry: { sendToRunner: jest.Mock; isRunnerOnline: jest.Mock };
  let ownerProxy: { isOwnerProxy: jest.Mock };

  beforeEach(async () => {
    seatQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    seatRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(() => seatQb),
    };
    runnerRepo = { findOne: jest.fn(), find: jest.fn() };
    topicRepo = { findOne: jest.fn() };
    messageRepo = { findOne: jest.fn(), find: jest.fn() };
    actorRepo = { findOne: jest.fn() };
    permReqRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      findAndCount: jest.fn(),
      count: jest.fn(),
    };
    participantRepo = { find: jest.fn() };
    topicService = {
      findById: jest.fn(),
      sendMessage: jest.fn(),
      isActiveParticipant: jest.fn(),
      join: jest.fn(),
    };
    permService = { ensureCan: jest.fn() };
    registry = { sendToRunner: jest.fn(), isRunnerOnline: jest.fn() };
    ownerProxy = { isOwnerProxy: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RoundtableService,
        { provide: getRepositoryToken(RoundtableSeat), useValue: seatRepo },
        { provide: getRepositoryToken(RoundtableRunner), useValue: runnerRepo },
        { provide: getRepositoryToken(RoundtablePermissionRequest), useValue: permReqRepo },
        { provide: getRepositoryToken(TopicParticipant), useValue: participantRepo },
        { provide: getRepositoryToken(Topic), useValue: topicRepo },
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: getRepositoryToken(Actor), useValue: actorRepo },
        { provide: TopicService, useValue: topicService },
        { provide: PermissionService, useValue: permService },
        { provide: RunnerRegistryService, useValue: registry },
        { provide: OwnerProxyService, useValue: ownerProxy },
      ],
    }).compile();

    service = moduleRef.get(RoundtableService);
    // 默认行为：消息/主题/actor 都存在，seat 查询命中，发送成功，runner 在线
    messageRepo.findOne.mockResolvedValue(makeMessage());
    topicRepo.findOne.mockResolvedValue({ id: 'topic-1', title: '圆桌测试' });
    actorRepo.findOne.mockResolvedValue({ type: ActorType.AGENT, displayName: 'Test Agent' });
    seatRepo.findOne.mockResolvedValue(makeSeat()); // flushPending / handleSeatEvent 命中
    seatQb.getOne.mockResolvedValue(null); // r17 冲突检查默认无既有座位（各用例按需覆盖）
    registry.sendToRunner.mockReturnValue(true);
    registry.isRunnerOnline.mockReturnValue(true); // 默认可达（M2 阶段 3：回执触发点 A 用）
    ownerProxy.isOwnerProxy.mockResolvedValue(false); // 默认非 owner 代理（removeSeat 权限用例显式覆盖）
    topicService.isActiveParticipant.mockResolvedValue(true); // 系统 actor 已是参与者
    permReqRepo.create.mockImplementation((input: unknown) => input); // create 即实体形状
    permReqRepo.save.mockResolvedValue({});
    permReqRepo.find.mockResolvedValue([]); // 默认无 pending 审批（孤儿/列表查询短路）
  });

  // ─────────────────────────── 注入触发器过滤链 ───────────────────────────

  it('非 NEW_MESSAGE 事件 → 不查消息、不注入', async () => {
    await service.onMessageCreated(makeEvent({ eventType: EventType.SYSTEM }));
    expect(messageRepo.findOne).not.toHaveBeenCalled();
    expect(registry.sendToRunner).not.toHaveBeenCalled();
  });

  it('消息不存在（事务回滚幻影，listener 铁规③）→ 免疫跳过', async () => {
    messageRepo.findOne.mockResolvedValue(null);
    await service.onMessageCreated(makeEvent());
    expect(registry.sendToRunner).not.toHaveBeenCalled();
  });

  it('自激防护：消息 metadata.seatLabel === 座位 label → 不回灌', async () => {
    seatRepo.find.mockResolvedValue([makeSeat()]);
    messageRepo.findOne.mockResolvedValue(makeMessage({ metadata: { seatLabel: 'kimi-1' } }));
    await service.onMessageCreated(makeEvent());
    expect(registry.sendToRunner).not.toHaveBeenCalled();
  });

  it('同 actor 其他座位 label 的消息不跳过（回声抑制按 seatLabel 精确过滤）', async () => {
    seatRepo.find.mockResolvedValue([makeSeat()]);
    messageRepo.findOne.mockResolvedValue(
      makeMessage({ metadata: { seatLabel: 'kimi-2' }, senderId: 'agent-1' }),
    );
    await service.onMessageCreated(makeEvent());
    expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
  });

  it('座位未绑定 runner（离线座位）→ 不入队', async () => {
    seatRepo.find.mockResolvedValue([makeSeat({ runnerId: null })]);
    await service.onMessageCreated(makeEvent());
    expect(registry.sendToRunner).not.toHaveBeenCalled();
  });

  it('listener 异常自吞（铁规②）：消息查询抛错不炸 emit 路径', async () => {
    messageRepo.findOne.mockRejectedValue(new Error('db down'));
    await expect(service.onMessageCreated(makeEvent())).resolves.toBeUndefined();
  });

  // ─────────────────────────── 注入装配 + 直通派发 ───────────────────────────

  it('新消息 → 直通注入：seat.inject 信封（规则头 + r3 冻结 body）+ seq + ring 落库', async () => {
    const seat = makeSeat();
    seatRepo.find.mockResolvedValue([seat]);
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);

    await service.onMessageCreated(makeEvent());

    expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
    const sent = registry.sendToRunner.mock.calls[0][1] as Envelope;
    expect(sent.type).toBe('seat.inject');
    expect(sent.seatId).toBe('seat-1');
    expect(sent.seq).toBe(1); // 首个注入 seq=1
    const payload = sent.payload as {
      ruleHeader: string;
      body: {
        v: number;
        kind: string;
        topic: { id: string; title: string };
        seat: { label: string; coordinator: boolean };
        ruleHeaderVersion: number;
        batch: { windowMs: number; messages: unknown[] };
      };
    };
    // 规则头装配（§6：统一装配 + 版本化；v2 = M2 阶段 3 新增 @all 说明）
    expect(payload.ruleHeader).toContain('规则头（version 2）');
    expect(payload.ruleHeader).toContain('kimi-1');
    expect(payload.ruleHeader).toContain('{"silent": true}');
    expect(payload.ruleHeader).toContain('证据纪律');
    expect(payload.ruleHeader).toContain('@all 唤醒全部座位，慎用');
    // r3 冻结消息体
    expect(payload.body).toEqual(
      expect.objectContaining({
        v: 1,
        kind: 'roundtable.inject',
        topic: { id: 'topic-1', title: '圆桌测试' },
        seat: { label: 'kimi-1', coordinator: false },
        ruleHeaderVersion: 2,
        batch: { windowMs: 0, messages: [expect.any(Object)] },
      }),
    );
    expect(payload.body.batch.messages[0]).toEqual({
      id: 'msg-1',
      from: { name: 'Test Agent', type: 'agent', seatLabel: null, coordinator: false },
      ts: '2026-08-07T12:00:00.000Z',
      replyTo: null,
      content: 'hello',
    });
    // 落库：last_inject_seq=1 + state.recentInjects ring（cap 100）
    // injectedAt（1.54.0 埋点批）为后端发出时刻 ISO 字符串；存量旧条目无此字段，
    // 聚合端（monitoring computeInjectionStats）null-skip——故此处断言存在且为 ISO
    expect(seat.lastInjectSeq).toBe('1');
    expect(seat.state.recentInjects).toEqual([
      { seq: 1, messageIds: ['msg-1'], injectedAt: expect.any(String) },
    ]);
    expect(seatRepo.save).toHaveBeenCalled();
  });

  // ───────────────────── 注入埋点（1.54.0，0c567f8b）─────────────────────
  // ring.injectedAt / injectRetryCount / injectFailCount 三处埋点 + bumpInjectCounter 自吞。

  it('persistDispatch 成功后 ring 新条目含 injectedAt（合法 ISO 字符串）且 lastInjectSeq 推进', async () => {
    const seat = makeSeat();
    seatRepo.find.mockResolvedValue([seat]); // 注入触发器按 label 匹配座位
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);

    await service.onMessageCreated(makeEvent()); // 直通：派发成功 → persistDispatch

    expect(seat.lastInjectSeq).toBe('1');
    const entry = seat.state.recentInjects[0];
    expect(entry).toMatchObject({ seq: 1, messageIds: ['msg-1'] });
    // injectedAt 必须是可解析的 ISO 字符串（monitoring 端 Date.parse 消费，坏值会污染样本）
    expect(typeof entry.injectedAt).toBe('string');
    expect(new Date(entry.injectedAt as string).toISOString()).toBe(entry.injectedAt);
    // 埋点不应改变既有落库行为：save 照常被调
    expect(seatRepo.save).toHaveBeenCalled();
  });

  it('flushPending runner 离线（sendToRunner=false）→ injectRetryCount +1 且队头保留', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    registry.sendToRunner.mockReturnValue(false); // 离线：发送失败
    service['flights'].set('seat-1', {
      busy: false,
      queue: [makePendingInject(1)],
    });

    await service.flushPending('seat-1');

    expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
    // 埋点：每次发送失败累计 injectRetryCount（state jsonb 计数器）
    expect(seat.state.injectRetryCount).toBe(1);
    // 队头保留（等重连 flush 重试），busy 不置位
    expect(service['flights'].get('seat-1')?.queue).toHaveLength(1);
    expect(service['flights'].get('seat-1')?.busy).toBe(false);
  });

  it('flushPending 座位存在但未绑 runner → injectFailCount +1 且队头出队', async () => {
    const seat = makeSeat({ runnerId: null }); // 解绑（座位还在）
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    service['flights'].set('seat-1', {
      busy: false,
      queue: [makePendingInject(1)],
    });

    await service.flushPending('seat-1');

    // 不可派发 → 累计 injectFailCount（座位已删才无处计数，仅日志）
    expect(seat.state.injectFailCount).toBe(1);
    expect(registry.sendToRunner).not.toHaveBeenCalled();
    // 丢弃分支：队头出队
    expect(service['flights'].get('seat-1')?.queue).toHaveLength(0);
  });

  it('persistDispatch 落库失败 → injectFailCount +1（bump 成功）且不再抛出', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    // 第一次 save = persistDispatch 落库失败；第二次 save = bumpInjectCounter 落库成功
    seatRepo.save.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(seat);
    service['flights'].set('seat-1', {
      busy: false,
      queue: [makePendingInject(1)],
    });

    // 落库失败不阻断已发送的注入：flushPending 正常返回，不向上抛
    await expect(service.flushPending('seat-1')).resolves.toBeUndefined();
    // 埋点：catch 分支先 bump injectFailCount 再记日志
    expect(seat.state.injectFailCount).toBe(1);
    expect(seatRepo.save).toHaveBeenCalledTimes(2);
  });

  it('bumpInjectCounter 自身落库失败自吞（不抛出、不递归重试）', async () => {
    const seat = makeSeat();
    seatRepo.save.mockRejectedValue(new Error('db down'));

    await expect(service['bumpInjectCounter'](seat, 'injectRetryCount')).resolves.toBeUndefined();
    // 内存侧计数仍推进（下次 bump 会再试）；save 只尝试一次（无递归）
    expect(seat.state.injectRetryCount).toBe(1);
    expect(seatRepo.save).toHaveBeenCalledTimes(1);
  });

  it('座位发言投影：name=座位 label，coordinator 取座位标记（身份模型 §6）', async () => {
    const seat = makeSeat(); // 本座位 kimi-1（接收方）
    const otherSeat = makeSeat({ id: 'seat-2', label: 'kimi-2', coordinator: true }); // kimi-2 主脑
    messageRepo.findOne.mockResolvedValue(
      makeMessage({ metadata: { seatLabel: 'kimi-2' }, senderId: 'agent-1' }),
    );
    seatRepo.find.mockResolvedValue([seat]);
    // 第一次 findOne：label 查询（kimi-2 座位）；第二次 findOne：flushPending 查本座位
    seatRepo.findOne.mockResolvedValueOnce(otherSeat).mockResolvedValueOnce(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);

    await service.onMessageCreated(makeEvent());

    const sent = registry.sendToRunner.mock.calls[0][1] as Envelope;
    const messages = (
      sent.payload as {
        body: {
          batch: {
            messages: Array<{ from: { name: string; seatLabel: string; coordinator: boolean } }>;
          };
        };
      }
    ).body.batch.messages;
    expect(messages[0].from).toEqual({
      name: 'kimi-2',
      type: 'agent',
      seatLabel: 'kimi-2',
      coordinator: true,
    });
  });

  // ─────────────────────────── 单飞行 FIFO ───────────────────────────

  it('单飞行 FIFO：busy 排队 → message_complete 排空 → 顺序保持', async () => {
    const seat = makeSeat();
    seatRepo.find.mockResolvedValue([seat]);
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
    topicService.sendMessage.mockResolvedValue({ id: 'reply-1' });

    // 第一条消息 → 立即注入（seq 1，busy=true）
    messageRepo.findOne.mockResolvedValue(makeMessage({ id: 'msg-1' }));
    await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
    // 第二条消息 → busy 入队（seq 2，不派发）
    messageRepo.findOne.mockResolvedValue(makeMessage({ id: 'msg-2', content: 'second' }));
    await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
    expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
    expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seq).toBe(1);

    // runner 回流：chunk 累积 → complete 释放单飞行 → 队列下一批（seq 2）
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('message_chunk', { text: 'part1 ' })),
    );
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(2, eventPayload('message_chunk', { text: 'part2' })),
    );
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(3, eventPayload('message_complete', { stopReason: 'end' })),
    );

    expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
    expect((registry.sendToRunner.mock.calls[1][1] as Envelope).seq).toBe(2);
    // 回复落 topic（§6 身份模型：runner actor 身份 + seatLabel 子身份 + 幂等键防重放双写）
    expect(topicService.sendMessage).toHaveBeenCalledWith('topic-1', 'agent-1', ActorType.AGENT, {
      content: 'part1 part2',
      metadata: { seatLabel: 'kimi-1' },
      clientRequestId: 'rt:seat-1:3',
    });
    // 游标推进：事件到 3，注入到 2
    expect(seat.lastEventSeq).toBe('3');
    expect(seat.lastInjectSeq).toBe('2');
  });

  it('沉默拦截（§6）：message_complete silent → 不落 topic，仅释放单飞行', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('message_complete', { stopReason: 'end', silent: true })),
    );

    expect(topicService.sendMessage).not.toHaveBeenCalled();
    expect(seat.lastEventSeq).toBe('1'); // 游标照常推进
    // 释放单飞行：队列中的下一批被派发
    seatRepo.find.mockResolvedValue([seat]);
    messageRepo.findOne.mockResolvedValue(makeMessage({ id: 'msg-9', content: 'after' }));
    await service.onMessageCreated(makeEvent({ resourceId: 'msg-9' }));
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(2, eventPayload('message_complete', { stopReason: 'end', silent: true })),
    );
    expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
    expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seq).toBe(1);
  });

  it('正文为空且非沉默 → 跳过落库（记警告）', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('message_complete', { stopReason: 'end' })),
    );

    expect(topicService.sendMessage).not.toHaveBeenCalled();
    expect(seat.lastEventSeq).toBe('1');
  });

  it('落库失败 → 游标不推进（留待 runner 重放重试）且不抛出', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
    topicService.sendMessage.mockRejectedValue(new Error('topic closed'));
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('message_chunk', { text: 'hi' })),
    );

    await expect(
      service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(2, eventPayload('message_complete', { stopReason: 'end' })),
      ),
    ).resolves.toBeUndefined();

    expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
    expect(seat.lastEventSeq).toBe('1'); // chunk 已推进；complete 失败不推进
  });

  it('蛙跳修复（阶段 5，RT-DEBT-1）：complete 落库失败留档 → 后续事件越过游标 → 重放不被 dedup，成功落库并清档', async () => {
    const seat = makeSeat({ lastEventSeq: '4' });
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
    topicService.sendMessage.mockRejectedValue(new Error('topic closed'));

    // seq 5 complete 落库失败：游标不推进 + 失败 seq 精确留档（随 state 持久化）
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        5,
        eventPayload('message_complete', { stopReason: 'end', text: '重要回复' }),
      ),
    );
    expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
    expect(seat.lastEventSeq).toBe('4');
    expect(seat.state.failedEventSeqs).toEqual([5]);

    // 后续 status seq 6 推进游标越过 5（旧实现的蛙跳触发点：dedup 会误吞重放的 5）
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(6, eventPayload('status', { status: 'busy' })),
    );
    expect(seat.lastEventSeq).toBe('6');

    // 重放 seq 5：留档放行（不被 dedup），落库成功
    topicService.sendMessage.mockResolvedValue({ id: 'reply-retry' });
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        5,
        eventPayload('message_complete', { stopReason: 'end', text: '重要回复' }),
      ),
    );
    expect(topicService.sendMessage).toHaveBeenCalledTimes(2);
    expect(topicService.sendMessage).toHaveBeenLastCalledWith(
      'topic-1',
      'agent-1',
      ActorType.AGENT,
      expect.objectContaining({ content: '重要回复', clientRequestId: 'rt:seat-1:5' }), // 幂等键不回归
    );
    expect(seat.state.failedEventSeqs).toBeUndefined(); // 正常终结清档
    expect(seat.lastEventSeq).toBe('6'); // 游标取 max 不回退
  });

  it('蛙跳修复：重启后留档随 state 持久化（重读 seat 行）→ 重放仍处理不被 dedup', async () => {
    // 模拟 chamber 重启：新读的 seat 行带 state.failedEventSeqs=[5] 与 lastEventSeq='6'
    const seat = makeSeat({ lastEventSeq: '6', state: { failedEventSeqs: [5] } });
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
    topicService.sendMessage.mockResolvedValue({ id: 'ok' });

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        5,
        eventPayload('message_complete', { stopReason: 'end', text: '重放回复' }),
      ),
    );

    expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
    expect(topicService.sendMessage).toHaveBeenLastCalledWith(
      'topic-1',
      'agent-1',
      ActorType.AGENT,
      expect.objectContaining({ content: '重放回复' }),
    );
    expect(seat.state.failedEventSeqs).toBeUndefined(); // 正常终结清档
    expect(seat.lastEventSeq).toBe('6'); // 游标不回退
  });

  it('蛙跳修复：留档 seq 重放为沉默 → 沉默分支清档 + 游标不回退', async () => {
    const seat = makeSeat({ lastEventSeq: '6', state: { failedEventSeqs: [5] } });
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(5, eventPayload('message_complete', { stopReason: 'end', silent: true })),
    );

    expect(topicService.sendMessage).not.toHaveBeenCalled();
    expect(seat.state.failedEventSeqs).toBeUndefined(); // 沉默 = 正常终结，清档
    expect(seat.state.silentCount).toBe(1);
    expect(seat.lastEventSeq).toBe('6'); // 游标不回退
  });

  it('chunk 缓冲超限（阶段 5，RT-DEBT-2）：丢最旧至上限内 + 每座位节流 warn；拼装照常（头部截断降级）', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
    topicService.sendMessage.mockResolvedValue({ id: 'ok' });
    // 监听私有 logger 的 warn（缓冲超限提示）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logger = (service as any).logger as { warn: (msg: string) => void };
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    // 600k + 600k = 1.2M > 1M → 丢最旧；再 +500k = 1.1M > 1M → 再丢（节流窗口内不重复 warn）
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('message_chunk', { text: 'a'.repeat(600_000) })),
    );
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(2, eventPayload('message_chunk', { text: 'b'.repeat(600_000) })),
    );
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(3, eventPayload('message_chunk', { text: 'c'.repeat(500_000) })),
    );
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(4, eventPayload('message_complete', { stopReason: 'end' })),
    );

    // 拼装照常（头部截断降级：只剩最后一条 chunk）
    expect(topicService.sendMessage).toHaveBeenCalledWith(
      'topic-1',
      'agent-1',
      ActorType.AGENT,
      expect.objectContaining({ content: 'c'.repeat(500_000) }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('缓冲超限'));
    expect(warnSpy).toHaveBeenCalledTimes(1); // 节流：同座位 60s 窗口内只 warn 一次
    warnSpy.mockRestore();
  });

  // ─────────────────────────── 攒批收集器（M2 阶段 2，r5 §6） ───────────────────────────

  describe('攒批收集器', () => {
    const BATCH = 30000;

    /** 攒批座位（batchWindowMs > 0） */
    function makeBatchedSeat(overrides: Partial<RoundtableSeat> = {}) {
      return makeSeat({
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/seat',
          bindActorId: 'agent-1',
          batchWindowMs: BATCH,
        },
        ...overrides,
      });
    }

    /** 按 resourceId 返回对应消息的 findOne mock + enqueueBatch 的 find mock（攒批用例） */
    function mockMessagesById(msgs: Message[]) {
      messageRepo.findOne.mockImplementation(
        async ({ where }: { where: { id: string } }) => msgs.find((m) => m.id === where.id) ?? null,
      );
      // 封批入队按 id 批量查（In() FindOperator）；mock 同样按 id 过滤，与真实查询语义一致
      messageRepo.find.mockImplementation(
        async ({ where }: { where: { id?: { _value?: string[] } } }) => {
          const ids = where.id?._value;
          return ids ? msgs.filter((m) => ids.includes(m.id)) : msgs;
        },
      );
    }

    /** 取第 i 次发送的信封 body */
    function sentBody(i: number): InjectBody {
      const env = registry.sendToRunner.mock.calls[i][1] as Envelope;
      return (env.payload as { body: InjectBody }).body;
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it('窗口内多条消息 → 到期一次 inject：batch.messages 多条 ts 升序 + windowMs 传配置值', async () => {
      jest.useFakeTimers();
      const seat = makeBatchedSeat();
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      mockMessagesById([
        makeMessage({ id: 'msg-1', createdAt: new Date('2026-08-07T12:00:00Z') }),
        makeMessage({ id: 'msg-2', createdAt: new Date('2026-08-07T12:00:30Z') }),
        makeMessage({ id: 'msg-3', createdAt: new Date('2026-08-07T12:01:00Z') }),
      ]);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' }));
      // 窗口未到期不派发（攒批：消息只进收集器，不入 FIFO）
      expect(registry.sendToRunner).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(BATCH);

      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const env = registry.sendToRunner.mock.calls[0][1] as Envelope;
      expect(env.type).toBe('seat.inject');
      expect(env.seq).toBe(1);
      const body = sentBody(0);
      expect(body.batch.windowMs).toBe(BATCH);
      expect(body.batch.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
      // ts 升序（协议契约：batch.messages 按 ts 升序）
      expect(body.batch.messages.map((m) => m.ts)).toEqual([
        '2026-08-07T12:00:00.000Z',
        '2026-08-07T12:00:30.000Z',
        '2026-08-07T12:01:00.000Z',
      ]);
      // 一次派发 = 一条 ring 条目（多条 messageIds，重放按批重建）；injectedAt 同直通用例
      expect(seat.lastInjectSeq).toBe('1');
      expect(seat.state.recentInjects).toEqual([
        { seq: 1, messageIds: ['msg-1', 'msg-2', 'msg-3'], injectedAt: expect.any(String) },
      ]);
    });

    it('封批后新消息开新批（封批即冻结，RT-BATCH-1）', async () => {
      jest.useFakeTimers();
      const seat = makeBatchedSeat();
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      mockMessagesById([
        makeMessage({ id: 'msg-1', createdAt: new Date('2026-08-07T12:00:00Z') }),
        makeMessage({ id: 'msg-2', createdAt: new Date('2026-08-07T12:01:00Z') }),
      ]);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await jest.advanceTimersByTimeAsync(BATCH); // 第一批封批派发（seq 1，busy=true）
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' })); // 到期后新消息 → 新批
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // 新批未到期不派发
      await jest.advanceTimersByTimeAsync(BATCH); // 第二批到期封批 → busy 排队不派发
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);

      // 释放第一批单飞行 → 第二批（独立新批）按序发出
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('message_complete', { stopReason: 'end', silent: true })),
      );
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      expect((registry.sendToRunner.mock.calls[1][1] as Envelope).seq).toBe(2);
      expect(sentBody(1).batch.messages.map((m) => m.id)).toEqual(['msg-2']);
    });

    it('busy 时封批入 FIFO 排队，complete 释放后按序 flush（FIFO 顺序正确）', async () => {
      jest.useFakeTimers();
      const seat = makeBatchedSeat();
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      mockMessagesById([
        makeMessage({ id: 'msg-1', createdAt: new Date('2026-08-07T12:00:00Z') }),
        makeMessage({ id: 'msg-2', createdAt: new Date('2026-08-07T12:01:00Z') }),
      ]);

      // 第一批（msg-1）：到期封批 seq 1 → 发送成功（busy=true）
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);

      // 第二批（msg-2）：到期封批 seq 2 → busy 排队不派发
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);

      // runner 完成第一轮（silent 释放单飞行）→ FIFO 下一批（seq 2）发出
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('message_complete', { stopReason: 'end', silent: true })),
      );
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      expect((registry.sendToRunner.mock.calls[1][1] as Envelope).seq).toBe(2);
    });

    it('onRunnerOffline：窗口定时器 cleared + 开着的批立即封批入 FIFO（offline 队头保留，重连 flush 发出）', async () => {
      jest.useFakeTimers();
      const seat = makeBatchedSeat();
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      mockMessagesById([makeMessage({ id: 'msg-1' })]);
      const clearSpy = jest.spyOn(global, 'clearTimeout');

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' })); // 开批（未到期）
      registry.sendToRunner.mockReturnValue(false); // runner 离线：发送失败
      await service.onRunnerOffline('runner-1');
      await jest.advanceTimersByTimeAsync(0); // flush 封批入队的异步链（findOne/查询）

      // 定时器已清理 + 封批尝试派发失败（sendToRunner=false → 队头保留）
      expect(clearSpy).toHaveBeenCalled();
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      expect(registry.sendToRunner.mock.results[0].value).toBe(false);
      // 定时器清理后无第二次封批/派发（防泄漏）
      await jest.advanceTimersByTimeAsync(BATCH * 2);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);

      // 重连后 flushPending 把封批发出（offline 队列保留等重连语义）
      registry.sendToRunner.mockReturnValue(true);
      await service.flushPending('seat-1');
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      expect((registry.sendToRunner.mock.calls[1][1] as Envelope).seq).toBe(1);
    });

    it('status 上行 offline：窗口定时器 cleared + 立即封批入队', async () => {
      jest.useFakeTimers();
      const seat = makeBatchedSeat();
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      mockMessagesById([makeMessage({ id: 'msg-1' })]);
      const clearSpy = jest.spyOn(global, 'clearTimeout');

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' })); // 开批（未到期）
      registry.sendToRunner.mockReturnValue(false);
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('status', { status: 'offline' })),
      );
      await jest.advanceTimersByTimeAsync(0);

      expect(clearSpy).toHaveBeenCalled();
      expect(seat.status).toBe('offline');
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // 封批尝试派发（offline 发送失败）
      expect(registry.sendToRunner.mock.results[0].value).toBe(false);
      await jest.advanceTimersByTimeAsync(BATCH * 2);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // 无第二次派发

      registry.sendToRunner.mockReturnValue(true);
      await service.flushPending('seat-1');
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      expect((registry.sendToRunner.mock.calls[1][1] as Envelope).seq).toBe(1);
    });

    it('R4 重启重建：窗口内未派发消息在 reconcile 后重新注入（回声抑制 + ts 升序 + 新 seq）', async () => {
      // 模拟重启前状态：ring 有 seq1（msg-1 @12:00，已注入）；msg-2/msg-3 在窗口内未派发
      const seat = makeBatchedSeat({
        state: { recentInjects: [{ seq: 1, messageIds: ['msg-1'] }] },
        lastInjectSeq: '1',
      });
      seatRepo.find.mockResolvedValue([seat]); // reconcile 按 runnerId 查
      seatRepo.findOne.mockResolvedValue(seat); // enqueuePending → flushPending 查
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      const ringMsg = makeMessage({
        id: 'msg-1',
        senderId: 'user-1',
        createdAt: new Date('2026-08-07T12:00:00Z'),
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        senderId: 'user-1',
        content: 'second',
        createdAt: new Date('2026-08-07T12:01:00Z'),
      });
      const own = makeMessage({
        id: 'msg-own',
        senderId: 'agent-1',
        metadata: { seatLabel: 'kimi-1' }, // 座位自己的发言：回声抑制过滤
        createdAt: new Date('2026-08-07T12:01:30Z'),
      });
      const msg3 = makeMessage({
        id: 'msg-3',
        senderId: 'user-1',
        content: 'third',
        createdAt: new Date('2026-08-07T12:02:00Z'),
      });
      // 第一次 find：ring 消息（算最后注入时间下界）；第二次 find：黑板候选（未派发）
      messageRepo.find.mockResolvedValueOnce([ringMsg]).mockResolvedValueOnce([msg2, own, msg3]);
      actorRepo.findOne.mockResolvedValue({ type: ActorType.HUMAN, displayName: 'Tianyu' });
      topicRepo.findOne.mockResolvedValue({ id: 'topic-1', title: '圆桌测试' });

      await service.reconcile('runner-1', {
        version: '0.1.0',
        vendors: ['kimi'],
        seats: { 'seat-1': { lastSentSeq: 0, lastReceivedSeq: 1 } },
      });

      // 未派发消息以新 seq 重新注入：msg-own 被回声抑制过滤，候选按 ts 升序
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seq).toBe(2);
      const body = sentBody(0);
      expect(body.batch.messages.map((m) => m.id)).toEqual(['msg-2', 'msg-3']);
      expect(body.batch.windowMs).toBe(BATCH);
    });

    it('R4 重启重建：从未派发过（ring 空）→ 不重建历史消息', async () => {
      const seat = makeSeat({ state: { recentInjects: [] }, lastInjectSeq: '0' });
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      await service.reconcile('runner-1', {
        version: '0.1.0',
        vendors: ['kimi'],
        seats: { 'seat-1': { lastSentSeq: 0, lastReceivedSeq: 0 } },
      });
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      expect(messageRepo.find).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── 唤醒路由（M2 阶段 3，R1 人机一致 / R5 token 精确） ───────────────────────────

  describe('唤醒路由（M2 阶段 3）', () => {
    const BATCH = 30000;

    /** mention 模式 topic（kind=roundtable + settings.wakePolicy=mention） */
    function mockMentionTopic() {
      topicRepo.findOne.mockResolvedValue({
        id: 'topic-1',
        title: '圆桌测试',
        kind: 'roundtable',
        settings: { wakePolicy: 'mention' },
      });
    }

    /** 双座位（kimi-1=seat-1 / kimi-2=seat-2），均直通（batchWindowMs=0）可达 */
    function mockTwoSeats() {
      const s1 = makeSeat();
      const s2 = makeSeat({ id: 'seat-2', label: 'kimi-2' });
      seatRepo.find.mockResolvedValue([s1, s2]);
      seatRepo.findOne.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'seat-1' ? s1 : where.id === 'seat-2' ? s2 : null,
      );
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      registry.sendToRunner.mockReturnValue(true);
      registry.isRunnerOnline.mockReturnValue(true);
      return { s1, s2 };
    }

    /** 按 resourceId 返回对应消息的 findOne mock + enqueueBatch 的 find mock（与攒批收集器同规） */
    function mockMessagesById(msgs: Message[]) {
      messageRepo.findOne.mockImplementation(
        async ({ where }: { where: { id: string } }) => msgs.find((m) => m.id === where.id) ?? null,
      );
      messageRepo.find.mockImplementation(
        async ({ where }: { where: { id?: { _value?: string[] } } }) => {
          const ids = where.id?._value;
          return ids ? msgs.filter((m) => ids.includes(m.id)) : msgs;
        },
      );
    }

    /** 取第 i 次发送的信封 body */
    function sentBody(i: number): InjectBody {
      const env = registry.sendToRunner.mock.calls[i][1] as Envelope;
      return (env.payload as { body: InjectBody }).body;
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it('mention：@甲 唤醒甲不唤醒乙（token 精确，R1/R5）', async () => {
      mockMentionTopic();
      mockTwoSeats();
      messageRepo.findOne.mockResolvedValue(makeMessage({ content: '@kimi-1 请回答' }));

      await service.onMessageCreated(makeEvent());

      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seatId).toBe('seat-1');
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seq).toBe(1);
    });

    it('mention：@all 唤醒全部 active 座位', async () => {
      mockMentionTopic();
      mockTwoSeats();
      messageRepo.findOne.mockResolvedValue(makeMessage({ content: '@all 全体注意' }));

      await service.onMessageCreated(makeEvent());

      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      const seatIds = registry.sendToRunner.mock.calls.map((c) => (c[1] as Envelope).seatId).sort();
      expect(seatIds).toEqual(['seat-1', 'seat-2']);
    });

    // ── @all 冷却（M3 阶段 3，r13：per-topic 60s 内存 Map，ALL_WAKE_COOLDOWN_MS 一处常量）──

    it('@all 冷却：60s 内第二次 @all 不唤醒（只入可见集）+ 冷却提示；冷却期过后恢复', async () => {
      jest.useFakeTimers();
      mockMentionTopic();
      mockTwoSeats();
      topicService.sendMessage.mockResolvedValue({ id: 'hint' });
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '@all 第一次',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@all 第二次（冷却内）',
          createdAt: new Date('2026-08-07T12:00:30Z'),
        }),
        makeMessage({
          id: 'msg-3',
          content: '@all 第三次（冷却后）',
          createdAt: new Date('2026-08-07T12:02:00Z'),
        }),
      ]);
      /** 释放双座位单飞行（silent complete，游标推进不落 topic）——后续消息才可派发 */
      const releaseFlights = async () => {
        for (const seatId of ['seat-1', 'seat-2']) {
          await service.handleSeatEvent(
            'runner-1',
            buildEnvelope(
              'seat.event',
              { seatId, type: 'message_complete', stopReason: 'end', silent: true },
              { seatId, seq: 1 },
            ),
          );
        }
      };

      // 第一次 @all：群体唤醒（2 座位直通派发）
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      await releaseFlights();

      // 第二次 @all（冷却内）：不唤醒不派发，只进 parked 可见集 + 冷却提示（system 通道）
      registry.sendToRunner.mockClear();
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      await jest.advanceTimersByTimeAsync(0); // 冷却提示是 fire-and-forget，排空微任务
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
      const [hintTopic, senderId, senderType, dto] = topicService.sendMessage.mock.calls[0];
      expect(hintTopic).toBe('topic-1');
      expect(senderId).toBe(SYSTEM_ACTOR_ID);
      expect(senderType).toBe(ActorType.SYSTEM);
      expect(dto).toMatchObject({
        type: MessageType.SYSTEM,
        content: '@all 冷却中，稍后再试',
        metadata: {},
      });

      // 冷却内消息仍进可见集：冷却期过后 @all 唤醒时 parked 并入送达（不丢）
      await jest.advanceTimersByTimeAsync(ALL_WAKE_COOLDOWN_MS);
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2); // 两座位
      const bodies = registry.sendToRunner.mock.calls.map(
        (c) =>
          (c[1] as Envelope).payload as { body: { batch: { messages: Array<{ id: string }> } } },
      );
      // 每座位批 = parked(msg-2) + 唤醒(msg-3)（消息不丢、正常进可见集）
      for (const b of bodies) {
        expect(b.body.batch.messages.map((m) => m.id)).toEqual(['msg-2', 'msg-3']);
      }
    });

    it('@all 冷却提示节流：冷却内多次 @all 只提示一次（与冷却同周期，防刷屏）', async () => {
      jest.useFakeTimers();
      mockMentionTopic();
      mockTwoSeats();
      topicService.sendMessage.mockResolvedValue({ id: 'hint' });
      mockMessagesById(
        ['msg-1', 'msg-2', 'msg-3'].map((id, i) =>
          makeMessage({
            id,
            content: '@all again',
            createdAt: new Date(Date.UTC(2026, 7, 7, 12, 0, i)),
          }),
        ),
      );

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' })); // 首次唤醒
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' })); // 冷却内 → 提示
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' })); // 冷却内 → 不再提示
      await jest.advanceTimersByTimeAsync(0); // fire-and-forget 微任务排空

      expect(registry.sendToRunner).toHaveBeenCalledTimes(2); // 仅首次唤醒
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1); // 冷却提示只一条
    });

    it('@all 冷却只闸 mention 模式：broadcast 桌不受影响（decideWake 恒真，无 @all 概念）', async () => {
      jest.useFakeTimers();
      mockTwoSeats(); // 缺省 topic mock → broadcast
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '普通发言',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@all 无所谓',
          createdAt: new Date('2026-08-07T12:00:30Z'),
        }),
      ]);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2); // broadcast 全唤醒
      // 释放双座位单飞行（silent complete）后第二条照常全唤醒
      for (const seatId of ['seat-1', 'seat-2']) {
        await service.handleSeatEvent(
          'runner-1',
          buildEnvelope(
            'seat.event',
            { seatId, type: 'message_complete', stopReason: 'end', silent: true },
            { seatId, seq: 1 },
          ),
        );
      }
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' })); // 冷却内也无所谓
      expect(registry.sendToRunner).toHaveBeenCalledTimes(4); // 照常全唤醒
      expect(topicService.sendMessage).not.toHaveBeenCalled(); // 无冷却提示
    });

    it('@all 冷却只闸 @all 令牌：纯 @座位（无 @all）不受冷却影响，也无冷却提示', async () => {
      jest.useFakeTimers();
      mockMentionTopic();
      mockTwoSeats();
      topicService.sendMessage.mockResolvedValue({ id: 'hint' });
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '@all 广播一次',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@kimi-1 定向',
          createdAt: new Date('2026-08-07T12:00:30Z'),
        }),
      ]);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' })); // 唤醒 + 记录冷却
      // 释放双座位单飞行后，定向 @ 不受冷却影响
      for (const seatId of ['seat-1', 'seat-2']) {
        await service.handleSeatEvent(
          'runner-1',
          buildEnvelope(
            'seat.event',
            { seatId, type: 'message_complete', stopReason: 'end', silent: true },
            { seatId, seq: 1 },
          ),
        );
      }
      registry.sendToRunner.mockClear();
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' })); // 无 @all → 不闸
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seatId).toBe('seat-1');
      expect(topicService.sendMessage).not.toHaveBeenCalled(); // 无提示
    });

    it('@all 冷却（token 级抑制，r13 终审修订）：冷却内 @label+@all 混合消息 → @label 座位仍唤醒、@all 群体不唤醒 + 冷却提示一次', async () => {
      jest.useFakeTimers();
      mockMentionTopic();
      mockTwoSeats();
      topicService.sendMessage.mockResolvedValue({ id: 'hint' });
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '@all 广播一次',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@all 开会 @kimi-1 你先说',
          createdAt: new Date('2026-08-07T12:00:30Z'),
        }),
        makeMessage({
          id: 'msg-3',
          content: '@kimi-2 该你了',
          createdAt: new Date('2026-08-07T12:02:00Z'),
        }),
      ]);
      /** 释放双座位单飞行（silent complete）——后续消息才可派发 */
      const releaseFlights = async () => {
        for (const seatId of ['seat-1', 'seat-2']) {
          await service.handleSeatEvent(
            'runner-1',
            buildEnvelope(
              'seat.event',
              { seatId, type: 'message_complete', stopReason: 'end', silent: true },
              { seatId, seq: 1 },
            ),
          );
        }
      };

      // 第一条 @all：群体唤醒（2 座位）+ 记录冷却
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      await releaseFlights();
      registry.sendToRunner.mockClear();

      // 第二条混合消息（冷却内）：@all 被抑制（不唤醒 seat-2），@kimi-1 token 仍唤醒
      // seat-1；确有 @all 被抑制 → 冷却提示一次
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      await jest.advanceTimersByTimeAsync(0); // 冷却提示是 fire-and-forget，排空微任务
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // 仅 seat-1 派发
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seatId).toBe('seat-1');
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
      const [, , , dto] = topicService.sendMessage.mock.calls[0];
      expect(dto).toMatchObject({ type: MessageType.SYSTEM, content: '@all 冷却中，稍后再试' });

      // 冷却期过后定向 @kimi-2：seat-2 唤醒，批 = parked(msg-2) + 唤醒(msg-3)——
      // 冷却内被抑制的 @all 消息仍进可见集，下次唤醒封批并入不丢
      await jest.advanceTimersByTimeAsync(ALL_WAKE_COOLDOWN_MS);
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      const body = (registry.sendToRunner.mock.calls[1][1] as Envelope).payload as {
        body: { batch: { messages: Array<{ id: string }> } };
      };
      expect(body.body.batch.messages.map((m) => m.id)).toEqual(['msg-2', 'msg-3']);
    });

    it('@all 冷却：代码块内的 @all 不算提及（剥噪口径），不触发冷却也不唤醒', async () => {
      jest.useFakeTimers();
      mockMentionTopic();
      mockTwoSeats();
      // 正文 = 代码块内 @all：后端剥噪后无 @all 令牌 → 不唤醒不冷却
      messageRepo.findOne.mockResolvedValue(
        makeMessage({
          id: 'msg-1',
          content: '```\n@all 不生效\n```',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
      );
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      expect(topicService.sendMessage).not.toHaveBeenCalled();
    });

    it('mention：@kimi-1x 不唤醒 kimi-1（token 后缀边界，R5）', async () => {
      mockMentionTopic();
      mockTwoSeats();
      messageRepo.findOne.mockResolvedValue(makeMessage({ content: '@kimi-1x 你好' }));
      await service.onMessageCreated(makeEvent());
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('mention：人类与 agent 消息同规（不按 senderType 特判，R1）', async () => {
      mockMentionTopic();
      mockTwoSeats();
      // parked 合并路径需要按 id 批量查（enqueueBatch）
      mockMessagesById([
        makeMessage({ content: '大家好', senderId: 'user-1', id: 'msg-1' }),
        makeMessage({ content: '@kimi-1 来一下', senderId: 'user-1', id: 'msg-2' }),
        makeMessage({ content: '我也说一句', senderId: 'agent-9', id: 'msg-3' }),
        makeMessage({ content: '@kimi-2 该你了', senderId: 'agent-9', id: 'msg-4' }),
      ]);
      // 人类未 @ → 不唤醒
      messageRepo.findOne.mockResolvedValue(
        makeMessage({ content: '大家好', senderId: 'user-1', id: 'msg-1' }),
      );
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      // 人类 @ → 唤醒 kimi-1（parked 并入，仍只唤醒 kimi-1）
      messageRepo.findOne.mockResolvedValue(
        makeMessage({ content: '@kimi-1 来一下', senderId: 'user-1', id: 'msg-2' }),
      );
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seatId).toBe('seat-1');
      // agent 未 @ → 不唤醒（与人类同规）
      registry.sendToRunner.mockClear();
      messageRepo.findOne.mockResolvedValue(
        makeMessage({ content: '我也说一句', senderId: 'agent-9', id: 'msg-3' }),
      );
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' }));
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      // agent @ → 唤醒 kimi-2（parked 并入，只唤醒 kimi-2）
      messageRepo.findOne.mockResolvedValue(
        makeMessage({ content: '@kimi-2 该你了', senderId: 'agent-9', id: 'msg-4' }),
      );
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-4' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seatId).toBe('seat-2');
    });

    it('broadcast：任何消息唤醒全部座位（M1 行为不回归，缺省 topic 无 kind）', async () => {
      mockTwoSeats(); // 缺省 topicRepo mock（无 kind/settings）→ 解析为 broadcast
      messageRepo.findOne.mockResolvedValue(makeMessage({ content: '大家好' }));
      await service.onMessageCreated(makeEvent());
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
    });

    it('wakePolicy 缺省：normal 桌（无 kind 键）→ broadcast（M1 行为向后兼容）', async () => {
      mockTwoSeats(); // 缺省 topicRepo mock（无 kind/settings）
      messageRepo.findOne.mockResolvedValue(makeMessage({ content: '普通发言', id: 'msg-1' }));
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2); // 无 @ 也全唤醒
    });

    it('wakePolicy 缺省：roundtable 桌（kind 无 settings 键）→ mention（新桌默认省钱安全）', async () => {
      mockMentionTopic(); // kind=roundtable + 显式 mention——等价缺省路径
      const seat = makeSeat();
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      // parked 合并路径需要按 id 批量查（enqueueBatch）
      mockMessagesById([
        makeMessage({ content: '无 @ 发言', id: 'msg-2' }),
        makeMessage({ content: '@kimi-1 hi', id: 'msg-3' }),
      ]);
      messageRepo.findOne.mockResolvedValue(makeMessage({ content: '无 @ 发言', id: 'msg-2' }));
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      expect(registry.sendToRunner).not.toHaveBeenCalled(); // 无 @ 不唤醒
      messageRepo.findOne.mockResolvedValue(makeMessage({ content: '@kimi-1 hi', id: 'msg-3' }));
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // @ 唤醒（parked 并入）
    });

    it('wakePolicy 显式设置优先于 kind 缺省（roundtable 桌显式 broadcast → 全唤醒）', async () => {
      const seat = makeSeat();
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      topicRepo.findOne.mockResolvedValue({
        id: 'topic-1',
        title: '圆桌测试',
        kind: 'roundtable',
        settings: { wakePolicy: 'broadcast' },
      });
      messageRepo.findOne.mockResolvedValue(makeMessage({ content: '显式广播', id: 'msg-4' }));
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-4' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // 无 @ 也唤醒
    });

    it('mention：无 @ 不派发（parked 躺着不起定时器）→ 下次唤醒批合并可见（messageIds 断言）', async () => {
      jest.useFakeTimers();
      mockMentionTopic();
      const seat = makeSeat({
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/seat',
          bindActorId: 'agent-1',
          batchWindowMs: BATCH,
        },
      });
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '普通发言不唤醒',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@kimi-1 唤醒',
          createdAt: new Date('2026-08-07T12:01:00Z'),
        }),
      ]);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' })); // parked
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).not.toHaveBeenCalled(); // parked 不起定时器

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' })); // 开窗
      await jest.advanceTimersByTimeAsync(BATCH); // 到期封批

      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const body = sentBody(0);
      expect(body.batch.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
      expect(body.batch.windowMs).toBe(BATCH);
    });

    it('回声抑制不回归：座位自己的发言（metadata.seatLabel 匹配）即使含 @ 自己也不回灌', async () => {
      mockMentionTopic();
      mockTwoSeats();
      messageRepo.findOne.mockResolvedValue(
        makeMessage({ content: '@kimi-1 我自己说', metadata: { seatLabel: 'kimi-1' } }),
      );
      await service.onMessageCreated(makeEvent());
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('system 消息不唤醒（mention 模式，即使含 @）：只入可见集，下次唤醒批可见', async () => {
      jest.useFakeTimers();
      mockMentionTopic();
      const seat = makeSeat({
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/seat',
          bindActorId: 'agent-1',
          batchWindowMs: BATCH,
        },
      });
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          type: MessageType.SYSTEM,
          content: '座位 kimi-1 当前离线，消息已暂存，上线后送达',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@kimi-1 正文',
          createdAt: new Date('2026-08-07T12:01:00Z'),
        }),
      ]);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' })); // system：不唤醒
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).not.toHaveBeenCalled(); // 无定时器无派发

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' })); // 正文唤醒
      await jest.advanceTimersByTimeAsync(BATCH);

      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const body = sentBody(0);
      // system 消息只入可见集：下次唤醒批里可见（防回执→唤醒→回复→回执循环）
      expect(body.batch.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
    });

    it('system 消息不唤醒（broadcast 模式，任何内容）：只入可见集', async () => {
      jest.useFakeTimers();
      const seat = makeSeat({
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/seat',
          bindActorId: 'agent-1',
          batchWindowMs: BATCH,
        },
      });
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          type: MessageType.SYSTEM,
          content: '系统公告',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '普通消息',
          createdAt: new Date('2026-08-07T12:01:00Z'),
        }),
      ]);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).not.toHaveBeenCalled();

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' })); // broadcast 唤醒
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      expect(sentBody(0).batch.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
    });

    it('集成级全链路（fake runner）：message 创建 → mention 路由 → 窗口封批 → inject 信封 messageIds/windowMs 断言', async () => {
      jest.useFakeTimers();
      mockMentionTopic();
      const seat = makeSeat({
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/seat',
          bindActorId: 'agent-1',
          batchWindowMs: BATCH,
        },
      });
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '第一条（无 @）',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@kimi-1 第二条',
          createdAt: new Date('2026-08-07T12:00:30Z'),
        }),
        makeMessage({
          id: 'msg-3',
          content: '第三条（无 @）',
          createdAt: new Date('2026-08-07T12:02:00Z'),
        }),
        makeMessage({
          id: 'msg-4',
          content: '@kimi-1 第四条',
          createdAt: new Date('2026-08-07T12:02:30Z'),
        }),
      ]);

      // 批 1：msg-1 parked + msg-2 唤醒开窗 → 到期封批 [msg-1, msg-2]
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const env1 = registry.sendToRunner.mock.calls[0][1] as Envelope;
      expect(env1.type).toBe('seat.inject');
      expect(env1.seq).toBe(1);
      const body1 = sentBody(0);
      expect(body1.batch.windowMs).toBe(BATCH);
      expect(body1.batch.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
      expect(body1.batch.messages.map((m) => m.ts)).toEqual([
        '2026-08-07T12:00:00.000Z',
        '2026-08-07T12:00:30.000Z',
      ]);

      // 批 2：msg-3 parked + msg-4 唤醒 → 到期封批 [msg-3, msg-4]（busy 排队等释放）
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' }));
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-4' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // busy：第二批复排队不派发

      // 释放批 1 单飞行 → 批 2 按序发出
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('message_complete', { stopReason: 'end', silent: true })),
      );
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      expect((registry.sendToRunner.mock.calls[1][1] as Envelope).seq).toBe(2);
      const body2 = sentBody(1);
      expect(body2.batch.messages.map((m) => m.id)).toEqual(['msg-3', 'msg-4']);
    });

    it('集成级：reconcile 后 parked（未派发）消息强制封批注入（重启即到期，宁可多唤醒一次不丢消息）', async () => {
      jest.useFakeTimers();
      mockMentionTopic();
      const seat = makeSeat({
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/seat',
          bindActorId: 'agent-1',
          batchWindowMs: BATCH,
        },
        state: { recentInjects: [{ seq: 1, messageIds: ['msg-1'] }] },
        lastInjectSeq: '1',
      });
      seatRepo.find.mockResolvedValue([seat]); // reconcile 按 runnerId 查
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      const ringMsg = makeMessage({
        id: 'msg-1',
        senderId: 'user-1',
        createdAt: new Date('2026-08-07T12:00:00Z'),
      });
      const parkedMsg = makeMessage({
        id: 'msg-2',
        senderId: 'user-1',
        content: '重启前未派发（mention 桌无 @ 也被强制封批）',
        createdAt: new Date('2026-08-07T12:01:00Z'),
      });
      // 第一次 find：ring 消息（最后注入时间下界）；第二次 find：黑板候选
      messageRepo.find.mockResolvedValueOnce([ringMsg]).mockResolvedValueOnce([parkedMsg]);

      await service.reconcile('runner-1', {
        version: '0.1.0',
        vendors: ['kimi'],
        seats: { 'seat-1': { lastSentSeq: 0, lastReceivedSeq: 1 } },
      });

      // 立即注入（无窗口定时器等待）：重启 = 窗口强制到期
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const env = registry.sendToRunner.mock.calls[0][1] as Envelope;
      expect(env.seq).toBe(2);
      const body = sentBody(0);
      expect(body.batch.messages.map((m) => m.id)).toEqual(['msg-2']);
      expect(body.batch.windowMs).toBe(BATCH);
      // 时间推进不产生第二次派发（非窗口攒批路径）
      await jest.advanceTimersByTimeAsync(BATCH * 2);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────── 失败回执（决策 #6，M2 阶段 3） ───────────────────────────

  describe('失败回执（决策 #6）', () => {
    /** 系统 actor 哨兵 id（ActorUnification migration 播种；与服务常量同值） */
    const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

    /** 单座位直通（batchWindowMs=0）可达/不可达切换 */
    function mockSingleSeat(online: boolean) {
      const seat = makeSeat();
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      registry.sendToRunner.mockReturnValue(online);
      registry.isRunnerOnline.mockReturnValue(online);
      return seat;
    }

    /** 按 resourceId 返回对应消息的 findOne/find mock */
    function mockMessagesById(msgs: Message[]) {
      messageRepo.findOne.mockImplementation(
        async ({ where }: { where: { id: string } }) => msgs.find((m) => m.id === where.id) ?? null,
      );
      messageRepo.find.mockImplementation(
        async ({ where }: { where: { id?: { _value?: string[] } } }) => {
          const ids = where.id?._value;
          return ids ? msgs.filter((m) => ids.includes(m.id)) : msgs;
        },
      );
    }

    /** 触发点 A：mention 桌 @ 离线座位（runner 在线表不可达） */
    function mockOfflineMentionTopic() {
      topicRepo.findOne.mockResolvedValue({
        id: 'topic-1',
        title: '圆桌测试',
        kind: 'roundtable',
        settings: { wakePolicy: 'mention' },
      });
    }

    afterEach(() => {
      jest.useRealTimers(); // 节流用例用 fake timers 推进 Date.now，用例后复位
    });

    it('触发点 A：@离线座位 → system 回执（无 seatLabel）+ 消息 parked 不派发，上线后下次唤醒送达', async () => {
      mockOfflineMentionTopic();
      const seat = mockSingleSeat(false); // runner 离线（DB status=active 但 socket 断开）
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '@kimi-1 在线吗',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@kimi-1 现在呢',
          createdAt: new Date('2026-08-07T12:01:00Z'),
        }),
      ]);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await flushMicrotasks(); // 回执是 fire-and-forget 异步路径，冲刷后再断言

      // 回执：系统 actor + type=system + metadata 不带 seatLabel
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
      const [receiptTopic, senderId, senderType, dto] = topicService.sendMessage.mock.calls[0];
      expect(receiptTopic).toBe('topic-1');
      expect(senderId).toBe(SYSTEM_ACTOR_ID);
      expect(senderType).toBe(ActorType.SYSTEM);
      expect(dto).toMatchObject({ type: MessageType.SYSTEM, metadata: {} });
      expect(dto.content).toContain('离线');
      expect(dto.content).toContain('已暂存');
      // 消息本身 parked（未派发）
      expect(registry.sendToRunner).not.toHaveBeenCalled();

      // 上线后：下次唤醒消息封批 → parked 并入送达（消息不丢）
      mockSingleSeat(true);
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const env = registry.sendToRunner.mock.calls[0][1] as Envelope;
      const body = (env.payload as { body: InjectBody }).body;
      expect(body.batch.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
    });

    it('触发点 A：未绑 runner 的座位 → 回执；私密 topic 前置 join 系统 actor（复用 join 通道）', async () => {
      mockOfflineMentionTopic();
      const seat = mockSingleSeat(false);
      seat.runnerId = null; // 从未绑定 runner
      topicService.isActiveParticipant.mockResolvedValue(false); // 系统 actor 非参与者（私密桌）
      messageRepo.findOne.mockResolvedValue(
        makeMessage({
          id: 'msg-1',
          content: '@kimi-1 hi',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
      );

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await flushMicrotasks(); // 回执是 fire-and-forget 异步路径，冲刷后再断言

      expect(topicService.join).toHaveBeenCalledWith('topic-1', SYSTEM_ACTOR_ID, ActorType.SYSTEM);
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
      expect((topicService.sendMessage.mock.calls[0][3] as { type: string }).type).toBe(
        MessageType.SYSTEM,
      );
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('节流：同一座位同一原因 5 分钟（RECEIPT_THROTTLE_MS）内不重复落回执；到期后恢复', async () => {
      jest.useFakeTimers();
      mockOfflineMentionTopic();
      mockSingleSeat(false);
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '@kimi-1 一次',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@kimi-1 两次',
          createdAt: new Date('2026-08-07T12:00:30Z'),
        }),
        makeMessage({
          id: 'msg-3',
          content: '@kimi-1 三次',
          createdAt: new Date('2026-08-07T12:10:00Z'),
        }),
      ]);

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      // fake timers 下 setImmediate 也被 mock，不能走 flushMicrotasks——advance 0ms 排空微任务
      await jest.advanceTimersByTimeAsync(0);
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1); // 5 分钟内不重复

      // 推进 5 分钟（RECEIPT_THROTTLE_MS 常量 = 5*60*1000）后再次 @ → 恢复落回执
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' }));
      await jest.advanceTimersByTimeAsync(0);
      expect(topicService.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('触发点 B：busy 排队 >20（QUEUE_RECEIPT_THRESHOLD）→ 落回执且消息保留（不丢弃）', async () => {
      const seat = mockSingleSeat(true); // broadcast 缺省桌
      mockMessagesById(
        Array.from({ length: 22 }, (_, i) =>
          makeMessage({
            id: `msg-${i + 1}`,
            content: `第 ${i + 1} 条`,
            createdAt: new Date(Date.UTC(2026, 7, 7, 12, 0, i)),
          }),
        ),
      );

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' })); // 派发成功 → busy
      for (let i = 2; i <= 22; i++) {
        await service.onMessageCreated(makeEvent({ resourceId: `msg-${i}` }));
      }

      // 第 22 条后排队 21 条 > 20 → 落「排队积压」回执
      await flushMicrotasks(); // 回执是 fire-and-forget 异步路径，冲刷后再断言
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
      const [, , , dto] = topicService.sendMessage.mock.calls[0];
      expect((dto as { type: string }).type).toBe(MessageType.SYSTEM);
      expect((dto as { content: string }).content).toContain('排队积压');
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // 只发了第 1 条

      // 释放单飞行（per-seat 单飞行：每轮 complete 只放行一条）→ 21 条全部保留按序派发
      for (let i = 1; i <= 21; i++) {
        await service.handleSeatEvent(
          'runner-1',
          seatEventEnvelope(
            i,
            eventPayload('message_complete', { stopReason: 'end', silent: true }),
          ),
        );
      }
      expect(registry.sendToRunner).toHaveBeenCalledTimes(22); // 消息不丢弃
      const lastEnv = registry.sendToRunner.mock.calls[21][1] as Envelope;
      expect(lastEnv.seq).toBe(22);
      const lastBody = (lastEnv.payload as { body: InjectBody }).body;
      expect(lastBody.batch.messages.map((m) => m.id)).toEqual(['msg-22']);
    });

    it('回执消息不触发唤醒（system 不唤醒 + 回执无 seatLabel）：递归防护断言', async () => {
      mockOfflineMentionTopic();
      mockSingleSeat(true);
      // 模拟回执消息本身经 event → onMessageCreated：type=system 任何模式不唤醒
      messageRepo.findOne.mockResolvedValue(
        makeMessage({
          id: 'msg-1',
          type: MessageType.SYSTEM,
          content: '座位 kimi-1 当前离线，消息已暂存，上线后送达',
        }),
      );
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      // 且回执落库时 metadata 为空（无 seatLabel，不触发回声抑制特例）——由回执测试
      // 触发点 A 的 dto 断言覆盖（metadata: {}）
    });
  });

  // ─────────────────────────── silent 文本兜底（M2 阶段 3） ───────────────────────────

  describe('silent 文本兜底（parseSilentReply）', () => {
    function mockComplete(extra: Record<string, unknown>) {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      return seat;
    }

    it('flag=false + text=哨兵 JSON → 不落库（文本兜底命中）', async () => {
      const seat = mockComplete({});
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('message_complete', {
            stopReason: 'end',
            silent: false,
            text: '{"silent": true}',
          }),
        ),
      );
      expect(topicService.sendMessage).not.toHaveBeenCalled();
      expect(seat.lastEventSeq).toBe('1'); // 游标照常推进
    });

    it('flag=false + chunk 拼装全文为哨兵 JSON → 不落库（buffer 兜底路径）', async () => {
      const seat = mockComplete({});
      // chunk 增量拼装（老 runner 不带 text 的兼容路径）：拼出完整哨兵 JSON
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('message_chunk', { text: '{"silent": ' })),
      );
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(2, eventPayload('message_chunk', { text: 'true}' })),
      );
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          3,
          eventPayload('message_complete', { stopReason: 'end', silent: false }),
        ),
      );
      expect(topicService.sendMessage).not.toHaveBeenCalled();
      expect(seat.lastEventSeq).toBe('3');
    });

    it('flag=true 无论文本 → 不落库（runner 标志优先，不回归）', async () => {
      mockComplete({});
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('message_complete', { stopReason: 'end', silent: true, text: '其实想说话' }),
        ),
      );
      expect(topicService.sendMessage).not.toHaveBeenCalled();
    });

    it('flag=false + 正常文本 → 落库（不回归）', async () => {
      const seat = mockComplete({});
      runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      topicService.sendMessage.mockResolvedValue({ id: 'msg-out' });
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('message_complete', {
            stopReason: 'end_turn',
            silent: false,
            text: '正常回复',
          }),
        ),
      );
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
      expect(topicService.sendMessage.mock.calls[0][3]).toMatchObject({
        content: '正常回复',
        metadata: { seatLabel: 'kimi-1' },
        clientRequestId: 'rt:seat-1:1',
      });
      expect(seat.lastEventSeq).toBe('1');
    });

    it('flag=false + 正文藏 JSON（整体非哨兵）→ 不误杀，正常落库（宽松解析契约）', async () => {
      const seat = mockComplete({});
      runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      topicService.sendMessage.mockResolvedValue({ id: 'msg-out' });
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('message_complete', {
            stopReason: 'end_turn',
            silent: false,
            text: '前面说 {"silent": true} 不算沉默',
          }),
        ),
      );
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
      expect(seat.lastEventSeq).toBe('1');
    });
  });

  // ─────────────────────────── seat.event 上行 ───────────────────────────

  it('seq 幂等去重（§4）：≤ last_event_seq 的事件直接丢弃', async () => {
    const seat = makeSeat({ lastEventSeq: '5' });
    seatRepo.findOne.mockResolvedValue(seat);
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(5, eventPayload('message_complete', { stopReason: 'end' })),
    );
    expect(topicService.sendMessage).not.toHaveBeenCalled();
    expect(seatRepo.save).not.toHaveBeenCalled();
  });

  it('usage → state.lastUsage 落库（M1 顺手存，M3 预算熔断数据源）', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('usage', { used: 100, size: 200 })),
    );
    expect(seat.state.lastUsage).toMatchObject({ used: 100, size: 200 });
    expect(seat.lastEventSeq).toBe('1');
  });

  it('seat_info → state.modelInfo 落库（M3 阶段 5：实际在跑配置观测，全量三字段 + at）', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        1,
        eventPayload('seat_info', { model: 'kimi-k2', thinking: 'high', mode: 'auto' }),
      ),
    );
    expect(seat.state.modelInfo).toMatchObject({
      model: 'kimi-k2',
      thinking: 'high',
      mode: 'auto',
    });
    expect(typeof seat.state.modelInfo.at).toBe('string'); // 落库时间戳
    expect(seat.lastEventSeq).toBe('1');
  });

  it('seat_info 部分字段 → modelInfo 只含提供的字段（宽松透传，不同 vendor 字段可能有缺）', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('seat_info', { mode: 'yolo' })),
    );
    expect(seat.state.modelInfo).toMatchObject({ mode: 'yolo' });
    expect(seat.state.modelInfo.model).toBeUndefined();
    expect(seat.state.modelInfo.thinking).toBeUndefined();
    expect(seat.lastEventSeq).toBe('1');
  });

  it('status → 座位生命周期映射（online/busy → active；offline → offline）', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('status', { status: 'online' })),
    );
    expect(seat.status).toBe('active');
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(2, eventPayload('status', { status: 'offline' })),
    );
    expect(seat.status).toBe('offline');
  });

  // ─────────────────────────── 审批持久化（M3 阶段 1，§6 审批可见性） ───────────────────────────

  it('permission_request → 落库 pending + topic 公告（「座位 X 请求审批：<tool>」）+ 游标推进', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    permReqRepo.findOne.mockResolvedValue(null); // 无已有行（新请求）
    permReqRepo.save.mockResolvedValue({ id: 'pr-1' });

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        1,
        eventPayload('permission_request', {
          requestId: 'req-1',
          tool: { name: 'bash', input: 'rm -rf /tmp/x' },
          options: [{ optionId: 'approve_once', kind: 'approve_once' }],
        }),
      ),
    );
    await flushMicrotasks(); // 公告是 fire-and-forget

    // 落库字段（契约① 原样透传 + 归属/topic 冗余）
    expect(permReqRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        seatId: 'seat-1',
        topicId: 'topic-1',
        tool: { name: 'bash', input: 'rm -rf /tmp/x' },
        options: [{ optionId: 'approve_once', kind: 'approve_once' }],
        status: 'pending',
        verdictOptionId: null,
        resolvedBy: null,
        resolvedAt: null,
      }),
    );
    expect(permReqRepo.save).toHaveBeenCalled();
    // 公告（system 消息通道；system 不唤醒天然免疫递归）
    expect(topicService.sendMessage).toHaveBeenCalledWith(
      'topic-1',
      SYSTEM_ACTOR_ID,
      ActorType.SYSTEM,
      expect.objectContaining({ content: '座位 kimi-1 请求审批：bash', type: MessageType.SYSTEM }),
    );
    // 游标推进（尾部统一推进）
    expect(seat.lastEventSeq).toBe('1');
  });

  it('permission_request 重放幂等：同 (seatId, requestId) 已有 pending 行 → 不重复落库不重复公告，游标推进', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    permReqRepo.findOne.mockResolvedValue(makePermissionRequest()); // 已有 pending 行（首次落库已发生）

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        1,
        eventPayload('permission_request', {
          requestId: 'req-1',
          tool: { name: 'bash' },
          options: [{ optionId: 'approve_once' }],
        }),
      ),
    );

    // RT-PERM-2：幂等查询必须带 status='pending' 过滤（requestId 跨 ACP 会话归零复用）
    expect(permReqRepo.findOne).toHaveBeenCalledWith({
      where: { seatId: 'seat-1', requestId: 'req-1', status: 'pending' },
    });
    expect(permReqRepo.create).not.toHaveBeenCalled();
    expect(permReqRepo.save).not.toHaveBeenCalled();
    expect(topicService.sendMessage).not.toHaveBeenCalled(); // 公告只随首次落库
    expect(seat.lastEventSeq).toBe('1');
  });

  it('RT-PERM-2 回归：同 (seatId, requestId) 仅有已终结行（orphaned/approved/rejected）→ 视为新请求落新行 + 公告（重启恢复不被吞）', async () => {
    // 场景还原（M3 阶段 4 验收实测）：座位请求审批落 pending(requestId=req-1) → runner
    // 断连转 orphaned → runner 重启 ACP session resume → agent 重新发起，requestId 归零
    // 复用 req-1——旧实现按 (seatId, requestId) 命中 orphaned 行当重放吞掉；修复后
    // findOne 带 status='pending' 查不到（mock 返回 null 即模拟「无 pending 行」）→ 落新行
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    permReqRepo.findOne.mockResolvedValue(null); // status='pending' 过滤下无命中（库里只有 orphaned 旧行）
    permReqRepo.save.mockResolvedValue({ id: 'pr-2' });

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        1,
        eventPayload('permission_request', {
          requestId: 'req-1', // 跨会话撞键：与 orphaned 旧行同 requestId
          tool: { name: 'bash' },
          options: [{ optionId: 'approve_once' }],
        }),
      ),
    );
    await flushMicrotasks();

    expect(permReqRepo.findOne).toHaveBeenCalledWith({
      where: { seatId: 'seat-1', requestId: 'req-1', status: 'pending' },
    });
    expect(permReqRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', seatId: 'seat-1', status: 'pending' }),
    );
    expect(permReqRepo.save).toHaveBeenCalled();
    expect(topicService.sendMessage).toHaveBeenCalledWith(
      'topic-1',
      SYSTEM_ACTOR_ID,
      ActorType.SYSTEM,
      expect.objectContaining({ content: '座位 kimi-1 请求审批：bash', type: MessageType.SYSTEM }),
    );
    expect(seat.lastEventSeq).toBe('1');
  });

  it('permission_request 落库失败 → 失败 seq 精确留档（RT-DEBT-1），游标不推进，重放可重试', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    permReqRepo.findOne.mockResolvedValue(null);
    permReqRepo.save.mockRejectedValue(new Error('db down'));

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        1,
        eventPayload('permission_request', {
          requestId: 'req-1',
          tool: { name: 'bash' },
          options: [{ optionId: 'approve_once' }],
        }),
      ),
    );

    expect(seat.lastEventSeq).toBe('0'); // 游标不推进
    expect(seat.state.failedEventSeqs).toEqual([1]); // 留档待重放
    expect(topicService.sendMessage).not.toHaveBeenCalled();
  });

  it('审批公告节流：per-seat 5 分钟内重复请求只公告一次（公告是提示，落库是权威）', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    permReqRepo.findOne.mockResolvedValue(null); // 两条都是新请求
    permReqRepo.save.mockResolvedValue({ id: 'pr-x' });

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        1,
        eventPayload('permission_request', {
          requestId: 'req-1',
          tool: { name: 'bash' },
          options: [{ optionId: 'approve_once' }],
        }),
      ),
    );
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        2,
        eventPayload('permission_request', {
          requestId: 'req-2',
          tool: { name: 'rm' },
          options: [{ optionId: 'reject' }],
        }),
      ),
    );
    await flushMicrotasks();

    expect(permReqRepo.save).toHaveBeenCalledTimes(2); // 两条都落库
    expect(topicService.sendMessage).toHaveBeenCalledTimes(1); // 公告只发一条
  });

  it('审批公告 tool 摘要：tool.name 缺失时回退截断 JSON', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    permReqRepo.findOne.mockResolvedValue(null);
    permReqRepo.save.mockResolvedValue({ id: 'pr-1' });

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        1,
        eventPayload('permission_request', {
          requestId: 'req-1',
          tool: { input: { dangerous: true } },
          options: [{ optionId: 'approve_once' }],
        }),
      ),
    );
    await flushMicrotasks();

    const [call] = topicService.sendMessage.mock.calls;
    const content = (call[3] as { content: string }).content;
    expect(content).toContain('座位 kimi-1 请求审批：');
    expect(content).toContain('dangerous');
    expect(content.length).toBeLessThan(200);
  });

  it('审批公告 tool 摘要：title 优先（真机 ToolBrief 形状 {title, toolCallId, content} → 「座位 X 请求审批：Write」）', async () => {
    const seat = makeSeat();
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    permReqRepo.findOne.mockResolvedValue(null);
    permReqRepo.save.mockResolvedValue({ id: 'pr-1' });

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        1,
        eventPayload('permission_request', {
          requestId: 'req-1',
          // 真机 ACP 形状：无 name 字段（公告正文不得退化成原始 JSON dump）
          tool: { title: 'Write', toolCallId: 'call_abc', content: [{ type: 'text', text: 'x' }] },
          options: [{ optionId: 'approve_once' }],
        }),
      ),
    );
    await flushMicrotasks();

    expect(topicService.sendMessage).toHaveBeenCalledWith(
      'topic-1',
      SYSTEM_ACTOR_ID,
      ActorType.SYSTEM,
      expect.objectContaining({
        content: '座位 kimi-1 请求审批：Write',
        type: MessageType.SYSTEM,
      }),
    );
  });

  it('归属校验：seat 不属于该 runner → error 信封回执，不处理', async () => {
    const seat = makeSeat({ runnerId: 'runner-9' });
    seatRepo.findOne.mockResolvedValue(seat);
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('message_complete', { stopReason: 'end' })),
    );
    const errorEnvelope = registry.sendToRunner.mock.calls[0][1] as Envelope;
    expect(errorEnvelope.type).toBe('error');
    expect(errorEnvelope.payload).toMatchObject({ code: 'SEAT_NOT_BOUND' });
    expect(topicService.sendMessage).not.toHaveBeenCalled();
  });

  it('seat 不存在 → error 信封（SEAT_NOT_FOUND）', async () => {
    seatRepo.findOne.mockResolvedValue(null);
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(1, eventPayload('message_complete', { stopReason: 'end' })),
    );
    const errorEnvelope = registry.sendToRunner.mock.calls[0][1] as Envelope;
    expect(errorEnvelope.type).toBe('error');
    expect(errorEnvelope.payload).toMatchObject({ code: 'SEAT_NOT_FOUND' });
  });

  // ─────────────────────────── hello 对账重放 ───────────────────────────

  it('hello 对账：lastReceivedSeq < lastInjectSeq → 从 recentInjects 按缺口重建（原 seq 重发）', async () => {
    const seat = makeSeat({
      state: {
        recentInjects: [
          { seq: 1, messageIds: ['msg-1'] },
          { seq: 2, messageIds: ['msg-2'] },
          { seq: 3, messageIds: ['msg-3'] },
        ],
      },
      lastInjectSeq: '3',
    });
    seatRepo.find.mockResolvedValue([seat]); // reconcile 按 runnerId 查
    seatRepo.findOne.mockResolvedValue(seat); // flushPending 查 + handleSeatEvent 查
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    // 缺口重建逐条取消息（seq 2 → msg-2，seq 3 → msg-3；In() 为 FindOperator，按调用序 mock）
    messageRepo.find
      .mockResolvedValueOnce([makeMessage({ id: 'msg-2' })])
      .mockResolvedValueOnce([makeMessage({ id: 'msg-3' })])
      // M2 阶段 2：reconcile 尾部 rebuildUndispatched（R4）——ring 消息查询 + 黑板候选查询
      .mockResolvedValueOnce([
        makeMessage({ id: 'msg-1' }),
        makeMessage({ id: 'msg-2' }),
        makeMessage({ id: 'msg-3' }),
      ])
      .mockResolvedValue([]); // 候选为空：无未派发消息可重建
    topicRepo.findOne.mockResolvedValue({ id: 'topic-1', title: '圆桌测试' });

    // runner 已收 seq 1，缺口 = 2,3
    await service.reconcile('runner-1', {
      version: '0.1.0',
      vendors: ['kimi'],
      seats: { 'seat-1': { lastSentSeq: 0, lastReceivedSeq: 1 } },
    });

    // 单飞行：第一条重放立即派发（原 seq 2），第二条排队
    expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
    expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seq).toBe(2);
    // 重放不推进 lastInjectSeq（黑板即真相，原 seq 原样重发）
    expect(seat.lastInjectSeq).toBe('3');

    // runner 完成一轮（silent 释放单飞行）→ 第二条重放（原 seq 3）发出
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(10, eventPayload('message_complete', { stopReason: 'end', silent: true })),
    );
    expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
    expect((registry.sendToRunner.mock.calls[1][1] as Envelope).seq).toBe(3);
    // 重放 body 由消息表重建（黑板即真相）
    const replayed = registry.sendToRunner.mock.calls[1][1] as Envelope;
    const body = replayed.payload as { body: { batch: { messages: Array<{ id: string }> } } };
    expect(body.body.batch.messages[0].id).toBe('msg-3');
  });

  it('reconcile 无缺口（lastReceivedSeq === lastInjectSeq）→ 不重放', async () => {
    const seat = makeSeat({ lastInjectSeq: '2' });
    seatRepo.find.mockResolvedValue([seat]);
    seatRepo.findOne.mockResolvedValue(seat);
    await service.reconcile('runner-1', {
      version: '0.1.0',
      vendors: ['kimi'],
      seats: { 'seat-1': { lastSentSeq: 0, lastReceivedSeq: 2 } },
    });
    expect(registry.sendToRunner).not.toHaveBeenCalled();
    expect(messageRepo.find).not.toHaveBeenCalled();
  });

  it('reconcile 未知座位（hello 报告了 chamber 不认的 seatId）→ 忽略', async () => {
    seatRepo.find.mockResolvedValue([makeSeat()]);
    seatRepo.findOne.mockResolvedValue(makeSeat());
    await service.reconcile('runner-1', {
      version: '0.1.0',
      vendors: ['kimi'],
      seats: { 'seat-ghost': { lastSentSeq: 0, lastReceivedSeq: 5 } },
    });
    expect(registry.sendToRunner).not.toHaveBeenCalled();
  });

  it('reconcile runner 超前（chamber 落库丢失）→ 采纳 runner 游标，后续注入不复用 seq', async () => {
    const seat = makeSeat({ lastInjectSeq: '0' }); // chamber 侧游标丢失
    seatRepo.find.mockResolvedValue([seat]);
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);

    await service.reconcile('runner-1', {
      version: '0.1.0',
      vendors: ['kimi'],
      seats: { 'seat-1': { lastSentSeq: 0, lastReceivedSeq: 1 } }, // runner 已收 seq 1
    });

    // 采纳：lastInjectSeq 抬到 runner 已收位置并落库（防重启后再次复用）
    expect(seat.lastInjectSeq).toBe('1');
    expect(seatRepo.save).toHaveBeenCalledWith(expect.objectContaining({ lastInjectSeq: '1' }));
    // 采纳期间不触发重放
    expect(registry.sendToRunner).not.toHaveBeenCalled();

    // 后续新注入分配 seq 2 而非复用 1（复用会被 runner 幂等去重 → 注入丢失 + busy 楔死）
    await service.onMessageCreated(makeEvent());
    expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
    expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seq).toBe(2);
  });

  it('message_complete 携带 text → 优先按 text 落库（chunk buffer 空也不丢回复）', async () => {
    const seat = makeSeat({ lastEventSeq: '5' });
    seatRepo.findOne.mockResolvedValue(seat);
    runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    topicService.sendMessage.mockResolvedValue({ id: 'msg-out' });

    // 无 chunk 累积（模拟 chamber 重启清空 buffer），complete 自带全文
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        6,
        eventPayload('message_complete', { stopReason: 'end_turn', text: '全文回复' }),
      ),
    );

    expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
    expect(topicService.sendMessage.mock.calls[0][3]).toMatchObject({
      content: '全文回复',
      metadata: { seatLabel: 'kimi-1' },
      clientRequestId: 'rt:seat-1:6',
    });
    expect(seat.lastEventSeq).toBe('6');
  });

  it('seatCoordinator 透传（r13）：主脑座位发言落库 metadata 补 seatCoordinator=true；普通座位缺省不写', async () => {
    // 主脑座位（coordinator=true）：metadata 带 seatCoordinator 单键
    const coordSeat = makeSeat({ coordinator: true, lastEventSeq: '0' });
    seatRepo.findOne.mockResolvedValue(coordSeat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
    topicService.sendMessage.mockResolvedValue({ id: 'msg-out' });

    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        1,
        eventPayload('message_complete', { stopReason: 'end_turn', text: '主脑指令' }),
      ),
    );
    expect(topicService.sendMessage.mock.calls[0][3]).toEqual({
      content: '主脑指令',
      metadata: { seatLabel: 'kimi-1', seatCoordinator: true },
      clientRequestId: 'rt:seat-1:1',
    });

    // 普通座位（coordinator=false）：seatCoordinator 缺省不写（载荷瘦，web 不渲染主脑 badge）
    const plainSeat = makeSeat({ lastEventSeq: '0' });
    seatRepo.findOne.mockResolvedValue(plainSeat);
    topicService.sendMessage.mockClear();
    await service.handleSeatEvent(
      'runner-1',
      seatEventEnvelope(
        2,
        eventPayload('message_complete', { stopReason: 'end_turn', text: '普通发言' }),
      ),
    );
    expect(topicService.sendMessage.mock.calls[0][3]).toEqual({
      content: '普通发言',
      metadata: { seatLabel: 'kimi-1' },
      clientRequestId: 'rt:seat-1:2',
    });
  });

  it('buildSeatAck（阶段 5，RT-DEBT-2）：按 runner 座席装配上行游标（lastEventSeq + failedEventSeqs）', async () => {
    const seat = makeSeat({ lastEventSeq: '7', state: { failedEventSeqs: [5] } });
    seatRepo.find.mockResolvedValue([seat]);
    const ack = await service.buildSeatAck('runner-1');
    expect(ack).toEqual({ seats: { 'seat-1': { lastEventSeq: 7, failedEventSeqs: [5] } } });
  });

  // ─────────────────────────── 断连处理 ───────────────────────────

  it('onRunnerOffline：绑定座位的单飞行 busy 重置（已发未确认由 hello 对账兜底）', async () => {
    const seat = makeSeat();
    seatRepo.find.mockResolvedValue([seat]);
    seatRepo.findOne.mockResolvedValue(seat);
    seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
    messageRepo.findOne.mockResolvedValue(makeMessage());
    await service.onMessageCreated(makeEvent()); // busy=true

    await service.onRunnerOffline('runner-1');

    // busy 已重置：新消息可直接派发（不再排队）
    messageRepo.findOne.mockResolvedValue(makeMessage({ id: 'msg-2' }));
    await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
    expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
  });

  // ─────────────────────────── 座位 CRUD（铁律 #21/#22） ───────────────────────────

  it('createSeat：topic 不存在 → 404 透传（findById findOrThrow）', async () => {
    topicService.findById.mockRejectedValue(
      new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND }),
    );
    await expect(
      service.createSeat(
        {
          topicId: 'topic-1',
          label: 'kimi-1',
          vendor: 'kimi',
          cwd: '/tmp',
          permissionMode: 'auto',
        },
        AGENT_ACTOR,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('createSeat：无 topic 写权限 → 403 透传', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
    permService.ensureCan.mockRejectedValue(
      new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
    );
    await expect(
      service.createSeat(
        {
          topicId: 'topic-1',
          label: 'kimi-1',
          vendor: 'kimi',
          cwd: '/tmp',
          permissionMode: 'auto',
        },
        AGENT_ACTOR,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('createSeat（TOPIC-PERM 收口）：editor 参与方（非 creator 非 admin）→ 403，座位创建保持 creator-only', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'creator-9' });
    // v1.46 TopicPolicy.write 已放宽给 editor（ensureCan 通过），收口必须仍拒绝
    permService.ensureCan.mockResolvedValue(undefined);
    const editorActor = { id: 'editor-1', type: ActorType.HUMAN, role: UserRole.EDITOR };

    await expect(
      service.createSeat(
        {
          topicId: 'topic-1',
          label: 'kimi-1',
          vendor: 'kimi',
          cwd: '/tmp',
          permissionMode: 'auto',
        },
        editorActor,
      ),
    ).rejects.toMatchObject({ response: { code: ErrorCode.PERMISSION_DENIED } });
    expect(seatRepo.create).not.toHaveBeenCalled();
  });

  it('createSeat：agent 创建者缺省 bindActorId = 自己；config 只存静态配置', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatQb.getOne.mockResolvedValue(null); // r17 冲突检查：同 topic 同 bindActorId 无既有座位
    const saved = makeSeat();
    seatRepo.create.mockImplementation((input: unknown) => ({ ...saved, ...(input as object) }));
    seatRepo.save.mockResolvedValue(saved);

    const result = await service.createSeat(
      { topicId: 'topic-1', label: 'kimi-1', vendor: 'kimi', cwd: '/tmp', permissionMode: 'auto' },
      AGENT_ACTOR,
    );

    expect(result).toBe(saved);
    expect(seatRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        topicId: 'topic-1',
        label: 'kimi-1',
        vendor: 'kimi',
        runnerId: null,
        config: {
          permissionMode: 'auto',
          cwd: '/tmp',
          bindActorId: 'agent-1',
          batchWindowMs: 5000, // 缺省 = 设计 §6 默认 5s（DEFAULT_BATCH_WINDOW_MS 一处常量）
        },
        state: {},
        status: 'active',
        coordinator: false,
        lastEventSeq: '0',
        lastInjectSeq: '0',
      }),
    );
  });

  it('createSeat：显式 batchWindowMs → 原样落 config（0=直通 M1 行为）', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatQb.getOne.mockResolvedValue(null); // r17 冲突检查：无既有座位
    const saved = makeSeat();
    seatRepo.create.mockImplementation((input: unknown) => ({ ...saved, ...(input as object) }));
    seatRepo.save.mockResolvedValue(saved);

    await service.createSeat(
      {
        topicId: 'topic-1',
        label: 'kimi-1',
        vendor: 'kimi',
        cwd: '/tmp',
        permissionMode: 'auto',
        batchWindowMs: 0,
      },
      AGENT_ACTOR,
    );

    expect(seatRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ batchWindowMs: 0 }),
      }),
    );
  });

  it('createSeat：人类创建者必须显式 bindActorId → 400', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'user-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    await expect(
      service.createSeat(
        {
          topicId: 'topic-1',
          label: 'kimi-1',
          vendor: 'kimi',
          cwd: '/tmp',
          permissionMode: 'auto',
        },
        HUMAN_ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  // ── r17 唯一座位约束（一 agent 一 topic 一 active 座位，docs/roundtable-design.md §12 r17）──

  it('createSeat（r17 唯一约束）：同 topic 同 bindActorId 已有 active 座位 → 409 且 code=11002', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatQb.getOne.mockResolvedValue(makeSeat()); // 同 topic 同 bindActorId（agent-1）既有座位
    seatRepo.create.mockImplementation((input: unknown) => input);
    seatRepo.save.mockResolvedValue(makeSeat());

    const err = await service
      .createSeat(
        {
          topicId: 'topic-1',
          label: 'kimi-2',
          vendor: 'kimi',
          cwd: '/tmp',
          permissionMode: 'auto',
          bindActorId: 'agent-1',
        },
        AGENT_ACTOR,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: ErrorCode.ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT,
    });
    // 检查条件 = 唯一索引同语义：同 topic + 同 bindActorId + 排除 removed（软删豁免）
    expect(seatQb.andWhere).toHaveBeenCalledWith("seat.status != 'removed'");
    expect(seatQb.andWhere).toHaveBeenCalledWith("seat.config->>'bindActorId' = :bindActorId", {
      bindActorId: 'agent-1',
    });
    expect(seatRepo.save).not.toHaveBeenCalled(); // 冲突在插入前短路
  });

  it('createSeat（r17 唯一约束）：同 actor 不同 topic → 允许（不冲突）', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-2', title: 't2', creatorId: 'agent-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatQb.getOne.mockResolvedValue(null); // 另一 topic 无该 actor 座位
    const saved = makeSeat({ topicId: 'topic-2' });
    seatRepo.create.mockImplementation((input: unknown) => ({ ...saved, ...(input as object) }));
    seatRepo.save.mockResolvedValue(saved);

    const result = await service.createSeat(
      {
        topicId: 'topic-2',
        label: 'kimi-1',
        vendor: 'kimi',
        cwd: '/tmp',
        permissionMode: 'auto',
      },
      AGENT_ACTOR, // 缺省 bindActorId = agent-1，topic-2 下无冲突
    );

    expect(result).toBe(saved);
    expect(seatRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        topicId: 'topic-2',
        config: expect.objectContaining({ bindActorId: 'agent-1' }),
      }),
    );
  });

  it('createSeat（r17 唯一约束）：既有座位 status=removed → 允许重建（软删豁免）', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    // 冲突检查查询带 status != 'removed'：已软删座位不命中（makeSeat 默认 active，
    // 显式 null = 查询未命中）
    seatQb.getOne.mockResolvedValue(null);
    const saved = makeSeat();
    seatRepo.create.mockImplementation((input: unknown) => ({ ...saved, ...(input as object) }));
    seatRepo.save.mockResolvedValue(saved);

    const result = await service.createSeat(
      {
        topicId: 'topic-1',
        label: 'kimi-1',
        vendor: 'kimi',
        cwd: '/tmp',
        permissionMode: 'auto',
        bindActorId: 'agent-1',
      },
      AGENT_ACTOR,
    );

    expect(result).toBe(saved);
    expect(seatQb.andWhere).toHaveBeenCalledWith("seat.status != 'removed'");
    expect(seatQb.andWhere).toHaveBeenCalledWith("seat.config->>'bindActorId' = :bindActorId", {
      bindActorId: 'agent-1',
    });
  });

  it('createSeat（r17 唯一约束）：bindActorId 缺省（人类创建者）→ 400 先行，不触发冲突检查', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'user-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    await expect(
      service.createSeat(
        {
          topicId: 'topic-1',
          label: 'kimi-1',
          vendor: 'kimi',
          cwd: '/tmp',
          permissionMode: 'auto',
        },
        HUMAN_ACTOR, // 人类缺省 bindActorId → 400 短路（bindActorId 无值无唯一性可言）
      ),
    ).rejects.toThrow(BadRequestException);
    expect(seatRepo.createQueryBuilder).not.toHaveBeenCalled(); // 缺省路径跳过唯一性检查
  });

  it('createSeat（r17 唯一约束）：save 触发 DB 唯一索引 23505 → 翻译为 409 code=11002（并发兜底，铁律 #9）', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatQb.getOne.mockResolvedValue(null); // 业务检查未命中（并发窗口内另一请求已落库）
    seatRepo.create.mockImplementation((input: unknown) => input);
    seatRepo.save.mockRejectedValue({
      code: '23505',
      constraint: 'uq_roundtable_seats_topic_bind_actor',
    });

    const err = await service
      .createSeat(
        {
          topicId: 'topic-1',
          label: 'kimi-1',
          vendor: 'kimi',
          cwd: '/tmp',
          permissionMode: 'auto',
          bindActorId: 'agent-1',
        },
        AGENT_ACTOR,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: ErrorCode.ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT,
    });
  });

  it('createSeat（阶段 5，RT-DEBT-3）：绑定 actor 非 active 参与者 → 自动 join + 「座位 X 已入座」公告', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatQb.getOne.mockResolvedValue(null); // r17 冲突检查：agent-9 在该 topic 无既有座位
    const saved = makeSeat({ label: 'kimi-9' });
    seatRepo.create.mockImplementation((input: unknown) => ({ ...saved, ...(input as object) }));
    seatRepo.save.mockResolvedValue(saved);
    // 绑定 actor（agent-9）非参与者 → 触发 join；系统 actor 也非参与者 → sendSystemMessage 前置 join
    topicService.isActiveParticipant
      .mockResolvedValueOnce(false) // 绑定 actor 检查
      .mockResolvedValueOnce(false); // 系统 actor 检查
    topicService.join.mockResolvedValue(undefined);
    topicService.sendMessage.mockResolvedValue({ id: 'ann' });
    actorRepo.findOne.mockResolvedValue({ type: ActorType.AGENT, displayName: 'Agent Nine' });

    const result = await service.createSeat(
      {
        topicId: 'topic-1',
        label: 'kimi-9',
        vendor: 'kimi',
        cwd: '/tmp',
        permissionMode: 'auto',
        bindActorId: 'agent-9',
      },
      AGENT_ACTOR,
    );

    expect(result).toBe(saved);
    // 绑定 actor 以自身类型 join（复用 topicService.join 通道）
    expect(topicService.isActiveParticipant).toHaveBeenCalledWith('topic-1', 'agent-9');
    expect(topicService.join).toHaveBeenCalledWith('topic-1', 'agent-9', ActorType.AGENT);
    // 公告：系统 actor 前置 join + type=system「座位 kimi-9 已入座」（sendSystemMessage 通道）
    expect(topicService.join).toHaveBeenCalledWith(
      'topic-1',
      '00000000-0000-0000-0000-000000000000',
      ActorType.SYSTEM,
    );
    expect(topicService.sendMessage).toHaveBeenCalledWith(
      'topic-1',
      '00000000-0000-0000-0000-000000000000',
      ActorType.SYSTEM,
      expect.objectContaining({ content: '座位 kimi-9 已入座', type: MessageType.SYSTEM }),
    );
  });

  it('createSeat（阶段 5，RT-DEBT-3）：绑定 actor 已是 active 参与者 → 不 join 不公告（幂等，防重复）', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-1' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatQb.getOne.mockResolvedValue(null); // r17 冲突检查：无既有座位
    const saved = makeSeat();
    seatRepo.create.mockImplementation((input: unknown) => ({ ...saved, ...(input as object) }));
    seatRepo.save.mockResolvedValue(saved);
    topicService.isActiveParticipant.mockResolvedValue(true); // 已是参与者

    await service.createSeat(
      { topicId: 'topic-1', label: 'kimi-1', vendor: 'kimi', cwd: '/tmp', permissionMode: 'auto' },
      AGENT_ACTOR,
    );

    expect(topicService.join).not.toHaveBeenCalled();
    expect(topicService.sendMessage).not.toHaveBeenCalled();
    expect(actorRepo.findOne).not.toHaveBeenCalled();
  });

  it('createSeat 入座公告（system）不唤醒任何座位（RT-DEBT-3 / RT-ROUTE-1 免疫）', async () => {
    seatRepo.find.mockResolvedValue([makeSeat()]);
    messageRepo.findOne.mockResolvedValue(
      makeMessage({ id: 'ann-1', type: MessageType.SYSTEM, content: '座位 kimi-1 已入座' }),
    );
    await service.onMessageCreated(makeEvent({ resourceId: 'ann-1' }));
    expect(registry.sendToRunner).not.toHaveBeenCalled(); // system 只入 parked，不派发
  });

  it('listSeats：topic 不存在 → 404；成功返回座位列表', async () => {
    topicService.findById.mockRejectedValue(new NotFoundException());
    await expect(service.listSeats('topic-1', AGENT_ACTOR)).rejects.toThrow(NotFoundException);

    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatRepo.find.mockResolvedValue([makeSeat()]);
    const list = await service.listSeats('topic-1', AGENT_ACTOR);
    expect(list).toHaveLength(1);
    expect(permService.ensureCan).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'topic-1' }),
      AGENT_ACTOR,
      'read',
    );
  });

  it('listSeats：排除 status=removed 的已移除座位（软删语义，M3 阶段 3）', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatRepo.find.mockResolvedValue([makeSeat()]);
    await service.listSeats('topic-1', AGENT_ACTOR);
    expect(seatRepo.find).toHaveBeenCalledWith({
      where: { topicId: 'topic-1', status: Not('removed') },
    });
  });

  it('listSeats：响应透出 state.modelInfo（M3 阶段 5——实体原样返回，modelInfo 与 lastUsage 同款嵌套 state jsonb，web 直接消费）', async () => {
    topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
    permService.ensureCan.mockResolvedValue(undefined);
    seatRepo.find.mockResolvedValue([
      makeSeat({
        state: {
          recentInjects: [],
          modelInfo: {
            model: 'kimi-k2',
            thinking: 'high',
            mode: 'auto',
            at: '2026-08-08T00:00:00Z',
          },
        },
      }),
    ]);
    const list = await service.listSeats('topic-1', AGENT_ACTOR);
    expect(list[0].state.modelInfo).toMatchObject({
      model: 'kimi-k2',
      thinking: 'high',
      mode: 'auto',
    });
  });

  // ─────────────────────────── runner 列表 listRunners（v1.49.0） ───────────────────────────

  describe('runner 列表 listRunners（v1.49.0 web 座位管理数据源）', () => {
    it('字段投影：不透 actorId/createdAt/updatedAt（最小暴露面）', async () => {
      runnerRepo.find.mockResolvedValue([
        {
          id: 'runner-1',
          name: 'local-dev',
          status: 'online',
          version: '0.3.1',
          vendors: ['kimi'],
          lastSeenAt: new Date('2026-08-11T00:00:00Z'),
          actorId: 'agent-secret',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const list = await service.listRunners();
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        id: 'runner-1',
        name: 'local-dev',
        status: 'online',
        version: '0.3.1',
        vendors: ['kimi'],
        lastSeenAt: new Date('2026-08-11T00:00:00Z'),
      });
      expect(list[0]).not.toHaveProperty('actorId');
    });

    it('排序契约：online 优先，同状态 lastSeenAt 倒序（null 沉底）', async () => {
      runnerRepo.find.mockResolvedValue([
        {
          id: 'r-off',
          name: 'off',
          status: 'offline',
          version: null,
          vendors: [],
          lastSeenAt: new Date('2026-08-11T03:00:00Z'),
        },
        {
          id: 'r-on-old',
          name: 'on-old',
          status: 'online',
          version: null,
          vendors: [],
          lastSeenAt: new Date('2026-08-11T01:00:00Z'),
        },
        {
          id: 'r-on-new',
          name: 'on-new',
          status: 'online',
          version: null,
          vendors: [],
          lastSeenAt: new Date('2026-08-11T02:00:00Z'),
        },
        {
          id: 'r-null',
          name: 'null',
          status: 'offline',
          version: null,
          vendors: [],
          lastSeenAt: null,
        },
      ]);
      const list = await service.listRunners();
      expect(list.map((r) => r.id)).toEqual(['r-on-new', 'r-on-old', 'r-off', 'r-null']);
    });

    it('空表 → 空数组（web 无在线 runner 警告态的数据前提）', async () => {
      runnerRepo.find.mockResolvedValue([]);
      await expect(service.listRunners()).resolves.toEqual([]);
    });
  });

  // ─────────────────────────── 座位移除 removeSeat（M3 阶段 3，r13） ───────────────────────────

  describe('座位移除 removeSeat（M3 阶段 3）', () => {
    afterEach(() => {
      jest.useRealTimers(); // 收集器清理用例用 fake timers（窗口定时器/Date.now），用例后复位防级联超时
    });

    /** 默认 admin 上下文：座位存在（topic-1 创建者 user-1）、系统 actor 已参与者、保存成功 */
    function mockRemovalContext(seatOverrides: Partial<RoundtableSeat> = {}) {
      const seat = makeSeat(seatOverrides);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'user-1' });
      topicService.sendMessage.mockResolvedValue({ id: 'ann' });
      return seat;
    }

    it('座位不存在 → 404（铁律 #22 findOne 判空）', async () => {
      seatRepo.findOne.mockResolvedValue(null);
      await expect(service.removeSeat('seat-ghost', HUMAN_ADMIN_ACTOR)).rejects.toThrow(
        NotFoundException,
      );
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('agent → 403（治理动作人类特权，§7；agent key 无管理员概念）', async () => {
      mockRemovalContext();
      await expect(service.removeSeat('seat-1', AGENT_ACTOR)).rejects.toThrow(ForbiddenException);
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      expect(seatRepo.save).not.toHaveBeenCalled();
    });

    it('非管理员人类（非 creator 非 owner 代理非平台 admin）→ 403', async () => {
      mockRemovalContext();
      ownerProxy.isOwnerProxy.mockResolvedValue(false);
      await expect(
        service.removeSeat('seat-1', { id: 'user-9', type: ActorType.HUMAN, name: 'Bystander' }),
      ).rejects.toThrow(ForbiddenException);
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('topic 创建者 → 移除成功：revoke 下行 + 软删落库 + topic 公告 + 收集器/单飞行清理', async () => {
      const seat = mockRemovalContext();
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);

      const result = await service.removeSeat('seat-1', HUMAN_ACTOR); // creatorId=user-1
      await flushMicrotasks(); // 公告 fire-and-forget

      // revoke 下行（seq=0 无对账语义 + 空 payload——协议 validateEmptyPayload 同规）
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const envelope = registry.sendToRunner.mock.calls[0][1] as Envelope;
      expect(envelope.type).toBe('seat.revoke');
      expect(envelope.seatId).toBe('seat-1');
      expect(envelope.seq).toBe(0);
      expect(envelope.payload).toEqual({});
      // 软删：status='removed' + 解绑 runner（行保留，label/config 留档溯源）
      expect(result.status).toBe('removed');
      expect(result.runnerId).toBeNull();
      expect(seatRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'removed', runnerId: null }),
      );
      // topic 公告（「座位 X 已被移除」，system 通道免疫递归）
      expect(topicService.sendMessage).toHaveBeenCalledWith(
        'topic-1',
        SYSTEM_ACTOR_ID,
        ActorType.SYSTEM,
        expect.objectContaining({ content: '座位 kimi-1 已被移除', type: MessageType.SYSTEM }),
      );
      // owner 代理不触发（直接 creator 短路）
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('creator 的人类 owner 代理 → 移除成功（与 topic.service sendMessage 私密桌放行同规）', async () => {
      mockRemovalContext({ runnerId: null });
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-9' });
      ownerProxy.isOwnerProxy.mockResolvedValue(true);

      const result = await service.removeSeat('seat-1', HUMAN_ACTOR);

      expect(ownerProxy.isOwnerProxy).toHaveBeenCalledWith('agent-9', HUMAN_ACTOR);
      expect(result.status).toBe('removed');
      expect(registry.sendToRunner).not.toHaveBeenCalled(); // 座位未绑 runner
    });

    it('平台管理员（role=ADMIN）→ 移除成功（admin 短路，不触发 owner 代理查询）', async () => {
      const seat = mockRemovalContext({ runnerId: null });
      const result = await service.removeSeat('seat-1', HUMAN_ADMIN_ACTOR);
      expect(result.status).toBe('removed');
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
      void seat;
    });

    it('runner 离线：revoke 下行失败只记 warning，移除照常完成（fire-and-forget 语义）', async () => {
      const seat = mockRemovalContext();
      registry.sendToRunner.mockReturnValue(false); // runner 离线

      const result = await service.removeSeat('seat-1', HUMAN_ACTOR);

      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // 尝试过
      expect(result.status).toBe('removed'); // 移除不因下行失败回滚
    });

    it('收集器清理：开着的窗口/parked 封批丢弃 + 单飞行 pending 清空 + chunk 缓冲清除（勿注入）', async () => {
      jest.useFakeTimers();
      const seat = mockRemovalContext({
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/seat',
          bindActorId: 'agent-1',
          batchWindowMs: 30000,
        },
      });
      // 先造一条开窗消息（唤醒开批 + 定时器）：mention topic + 单座位
      topicRepo.findOne.mockResolvedValue({
        id: 'topic-1',
        title: '圆桌测试',
        kind: 'roundtable',
        settings: { wakePolicy: 'mention' },
      });
      seatRepo.find.mockResolvedValue([seat]);
      // removeSeat 上下文里 seatRepo.findOne 返回 seat（onMessageCreated 消息查询不走它）
      seatRepo.findOne.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'seat-1' ? seat : null,
      );
      messageRepo.findOne.mockResolvedValue(
        makeMessage({
          id: 'msg-1',
          content: '@kimi-1 开窗',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
      );
      messageRepo.find.mockResolvedValue([]); // enqueueBatch 查询：无消息可入队（收集器清理路径）
      service['chunkBuffers'].set('seat-1', ['in-flight text']); // 模拟进行中 turn 的 chunk

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' })); // 开窗（定时器挂起，不派发）
      expect(registry.sendToRunner).not.toHaveBeenCalled(); // 攒批中未到期

      // 移除：封批丢弃（不派发）+ 清 pending + 清 chunk 缓冲
      registry.sendToRunner.mockClear();
      const result = await service.removeSeat('seat-1', HUMAN_ACTOR);
      await jest.advanceTimersByTimeAsync(60000); // 原窗口定时器到期也不派发（已出表）

      expect(result.status).toBe('removed');
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // 仅 revoke，无 inject
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).type).toBe('seat.revoke');
      // 收集器已出表 + 单飞行队列清空 + chunk 缓冲清除
      expect(service['batchCollectors'].has('seat-1')).toBe(false);
      expect(service['flights'].get('seat-1')?.queue ?? []).toHaveLength(0);
      expect(service['chunkBuffers'].has('seat-1')).toBe(false);
    });

    it('幂等：已 removed 的座位重复移除直接返回（不重复 revoke/公告）', async () => {
      const seat = mockRemovalContext({ status: 'removed', runnerId: null });
      const result = await service.removeSeat('seat-1', HUMAN_ACTOR);
      expect(result.status).toBe('removed');
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      expect(topicService.sendMessage).not.toHaveBeenCalled();
      expect(seatRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── 审批裁决（M3 阶段 1 状态机，铁律 #17/#18） ───────────────────────────

  describe('审批裁决 verdictPermissionRequest（M3 阶段 1）', () => {
    beforeEach(() => {
      permReqRepo.findOne.mockResolvedValue(makePermissionRequest());
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'user-1' });
      permService.ensureCan.mockResolvedValue(undefined);
      permReqRepo.save.mockImplementation(async (r: RoundtablePermissionRequest) => r);
    });

    it('pending → approved（approve_once 放行）：落库三件套 + verdict 下行 + topic 公告', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      const result = await service.verdictPermissionRequest(
        'pr-1',
        { optionId: 'approve_once' },
        HUMAN_ACTOR,
      );
      await flushMicrotasks(); // 公告 fire-and-forget

      // 落库（铁律 #18：状态与 resolved 字段同次写入）
      expect(result.status).toBe('approved');
      expect(result.verdictOptionId).toBe('approve_once');
      expect(result.resolvedBy).toBe('user-1');
      expect(result.resolvedAt).toBeInstanceOf(Date);
      expect(permReqRepo.save).toHaveBeenCalled();
      // verdict 下行（§4：requestId + optionId；seq=0 对账游标仅适用 inject）
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const envelope = registry.sendToRunner.mock.calls[0][1] as Envelope;
      expect(envelope.type).toBe('seat.permission_verdict');
      expect(envelope.seatId).toBe('seat-1');
      expect(envelope.seq).toBe(0);
      expect(envelope.payload).toEqual({ requestId: 'req-1', optionId: 'approve_once' });
      // topic 公告（「<人> 已批准了座位 X 的审批请求」）
      expect(topicService.sendMessage).toHaveBeenCalledWith(
        'topic-1',
        SYSTEM_ACTOR_ID,
        ActorType.SYSTEM,
        expect.objectContaining({
          content: 'Tianyu 已批准了座位 kimi-1 的审批请求',
          type: MessageType.SYSTEM,
        }),
      );
    });

    it('pending → rejected（option.kind=reject）：状态 rejected + 「已拒绝」公告', async () => {
      seatRepo.findOne.mockResolvedValue(makeSeat());
      const result = await service.verdictPermissionRequest(
        'pr-1',
        { optionId: 'reject' },
        HUMAN_ACTOR,
      );
      await flushMicrotasks();
      expect(result.status).toBe('rejected');
      expect(result.verdictOptionId).toBe('reject');
      expect(topicService.sendMessage).toHaveBeenCalledWith(
        'topic-1',
        SYSTEM_ACTOR_ID,
        ActorType.SYSTEM,
        expect.objectContaining({
          content: 'Tianyu 已拒绝了座位 kimi-1 的审批请求',
          type: MessageType.SYSTEM,
        }),
      );
    });

    it('裁决（TOPIC-PERM 收口）：editor 参与方（非 creator 非 admin）→ 403，裁决保持 creator-only', async () => {
      // 覆盖 beforeEach 的 topic mock（creatorId=user-1 → creator-9），write 已放宽仍须收口
      topicService.findById.mockResolvedValue({
        id: 'topic-1',
        title: 't',
        creatorId: 'creator-9',
      });
      permService.ensureCan.mockResolvedValue(undefined);
      const editorActor = { id: 'editor-1', type: ActorType.HUMAN, role: UserRole.EDITOR };

      await expect(
        service.verdictPermissionRequest('pr-1', { optionId: 'approve_once' }, editorActor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.PERMISSION_DENIED } });
      expect(permReqRepo.save).not.toHaveBeenCalled();
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('重复裁决（非 pending）→ 409 ConflictException，不落库不下行', async () => {
      permReqRepo.findOne.mockResolvedValue(makePermissionRequest({ status: 'approved' }));
      await expect(
        service.verdictPermissionRequest('pr-1', { optionId: 'approve_once' }, HUMAN_ACTOR),
      ).rejects.toThrow(ConflictException);
      expect(permReqRepo.save).not.toHaveBeenCalled();
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('已作废（orphaned）同样 409（非 pending 一律拒裁）', async () => {
      permReqRepo.findOne.mockResolvedValue(makePermissionRequest({ status: 'orphaned' }));
      await expect(
        service.verdictPermissionRequest('pr-1', { optionId: 'approve_once' }, HUMAN_ACTOR),
      ).rejects.toThrow(ConflictException);
    });

    it('非法 optionId（∉ options）→ 422 UnprocessableEntityException', async () => {
      await expect(
        service.verdictPermissionRequest('pr-1', { optionId: 'approve_forever' }, HUMAN_ACTOR),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(permReqRepo.save).not.toHaveBeenCalled();
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('agent API Key → 403 ForbiddenException（先于一切资源校验，不泄露请求存在性）', async () => {
      await expect(
        service.verdictPermissionRequest('pr-1', { optionId: 'approve_once' }, AGENT_ACTOR),
      ).rejects.toThrow(ForbiddenException);
      expect(permReqRepo.findOne).not.toHaveBeenCalled(); // 403 优先于资源校验
    });

    it('请求不存在 → 404 NotFoundException', async () => {
      permReqRepo.findOne.mockResolvedValue(null);
      await expect(
        service.verdictPermissionRequest('pr-ghost', { optionId: 'approve_once' }, HUMAN_ACTOR),
      ).rejects.toThrow(NotFoundException);
    });

    it('非参与者（ensureCan write 拒绝）→ 403 透传（铁律 #9）', async () => {
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );
      await expect(
        service.verdictPermissionRequest('pr-1', { optionId: 'approve_once' }, HUMAN_ACTOR),
      ).rejects.toThrow(ForbiddenException);
      expect(permReqRepo.save).not.toHaveBeenCalled();
    });

    it('座位离线/未绑定 → 下行失败只记 warning 不报错，审批状态照常落库（审批永不过期）', async () => {
      seatRepo.findOne.mockResolvedValue(makeSeat({ runnerId: null })); // 未绑定 runner
      const result = await service.verdictPermissionRequest(
        'pr-1',
        { optionId: 'approve_once' },
        HUMAN_ACTOR,
      );
      await flushMicrotasks();
      expect(result.status).toBe('approved');
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      // 公告照常（座位 label 进文案）
      expect(topicService.sendMessage).toHaveBeenCalledWith(
        'topic-1',
        SYSTEM_ACTOR_ID,
        ActorType.SYSTEM,
        expect.objectContaining({
          content: 'Tianyu 已批准了座位 kimi-1 的审批请求',
          type: MessageType.SYSTEM,
        }),
      );
    });

    it('座位行缺失 → 下行跳过，公告回退 seatId 标识', async () => {
      seatRepo.findOne.mockResolvedValue(null);
      const result = await service.verdictPermissionRequest(
        'pr-1',
        { optionId: 'approve_always' },
        HUMAN_ACTOR,
      );
      await flushMicrotasks();
      expect(result.status).toBe('approved');
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      expect(topicService.sendMessage).toHaveBeenCalledWith(
        'topic-1',
        SYSTEM_ACTOR_ID,
        ActorType.SYSTEM,
        expect.objectContaining({
          content: 'Tianyu 已批准了座位 seat-1 的审批请求',
          type: MessageType.SYSTEM,
        }),
      );
    });
  });

  // ─────────────────────────── 审批查询 API（M3 阶段 1，阶段 2 UI 数据源） ───────────────────────────

  describe('审批查询（listPermissionRequests / pendingPermissionRequestCount）', () => {
    it('列表：topic 存在 + read 权限 → findAndCount 分页，status 过滤传递', async () => {
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
      permService.ensureCan.mockResolvedValue(undefined);
      const items = [makePermissionRequest()];
      permReqRepo.findAndCount.mockResolvedValue([items, 1]);

      const result = await service.listPermissionRequests(
        { topicId: 'topic-1', status: 'pending', page: 2, pageSize: 10 },
        HUMAN_ACTOR,
      );

      expect(permService.ensureCan).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'topic-1' }),
        HUMAN_ACTOR,
        'read',
      );
      expect(permReqRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { topicId: 'topic-1', status: 'pending' },
          skip: 10,
          take: 10,
          order: { createdAt: 'DESC' },
        }),
      );
      expect(result).toEqual({
        items,
        total: 1,
        page: 2,
        pageSize: 10,
        totalPages: 1,
        hasNext: false,
        hasPrev: true,
      });
    });

    it('列表：无 status → where 只带 topicId；缺省分页 1/20', async () => {
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
      permService.ensureCan.mockResolvedValue(undefined);
      permReqRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.listPermissionRequests({ topicId: 'topic-1' }, HUMAN_ACTOR);

      expect(permReqRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { topicId: 'topic-1' }, skip: 0, take: 20 }),
      );
    });

    it('列表：无 topic 权限 → 404（ensureCan read 语义，安全 through obscurity）', async () => {
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
      permService.ensureCan.mockRejectedValue(new NotFoundException());
      await expect(
        service.listPermissionRequests({ topicId: 'topic-1' }, AGENT_ACTOR),
      ).rejects.toThrow(NotFoundException);
      expect(permReqRepo.findAndCount).not.toHaveBeenCalled();
    });

    it('pending-count：按参与者口径聚合（active 参与 topic 内的 pending 总数）', async () => {
      participantRepo.find.mockResolvedValue([
        { topicId: 'topic-1', participantId: 'user-1' },
        { topicId: 'topic-2', participantId: 'user-1' },
      ]);
      permReqRepo.count.mockResolvedValue(3);

      const count = await service.pendingPermissionRequestCount(HUMAN_ACTOR);

      expect(count).toBe(3);
      expect(participantRepo.find).toHaveBeenCalledWith({
        where: { participantId: 'user-1', status: 'active' },
      });
      expect(permReqRepo.count).toHaveBeenCalledWith({
        where: { topicId: In(['topic-1', 'topic-2']), status: 'pending' },
      });
    });

    it('pending-count：无任何参与 topic → 0（不查审批表）', async () => {
      participantRepo.find.mockResolvedValue([]);
      expect(await service.pendingPermissionRequestCount(HUMAN_ACTOR)).toBe(0);
      expect(permReqRepo.count).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── 断连孤儿作废（M3 阶段 1） ───────────────────────────

  describe('runner 断连孤儿作废 onRunnerOffline（M3 阶段 1）', () => {
    it('pending 审批 → orphaned（resolved_at 写入，resolved_by 留空）+ per-topic 公告', async () => {
      const seat = makeSeat();
      seatRepo.find.mockResolvedValue([seat]);
      permReqRepo.find.mockResolvedValue([
        makePermissionRequest({ id: 'pr-1', topicId: 'topic-1' }),
        makePermissionRequest({ id: 'pr-2', topicId: 'topic-1', requestId: 'req-2' }),
      ]);
      permReqRepo.save.mockImplementation(async (r: RoundtablePermissionRequest) => r);

      await service.onRunnerOffline('runner-1');
      await flushMicrotasks();

      const saved = permReqRepo.save.mock.calls.map((c) => c[0] as RoundtablePermissionRequest);
      expect(saved).toHaveLength(2);
      for (const r of saved) {
        expect(r.status).toBe('orphaned');
        expect(r.resolvedAt).toBeInstanceOf(Date);
        expect(r.resolvedBy).toBeNull(); // 作废非人类裁决（铁律 #18：状态与字段不变量）
      }
      // 公告按 topic 一条，计数 = 成功作废数
      expect(topicService.sendMessage).toHaveBeenCalledWith(
        'topic-1',
        SYSTEM_ACTOR_ID,
        ActorType.SYSTEM,
        expect.objectContaining({
          content: 'runner 断连，2 条待审批已作废，agent 重连后将重新发起',
          type: MessageType.SYSTEM,
        }),
      );
    });

    it('无 pending 审批 → 不作废不公告', async () => {
      seatRepo.find.mockResolvedValue([makeSeat()]);
      permReqRepo.find.mockResolvedValue([]);
      await service.onRunnerOffline('runner-1');
      expect(permReqRepo.save).not.toHaveBeenCalled();
      expect(topicService.sendMessage).not.toHaveBeenCalled();
    });

    it('无绑定座位 → 不查审批表（短路）', async () => {
      seatRepo.find.mockResolvedValue([]);
      await service.onRunnerOffline('runner-1');
      expect(permReqRepo.find).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── 圆桌安全阀（M2 阶段 4，R2/R6/R7） ───────────────────────────

  describe('圆桌安全阀（M2 阶段 4）', () => {
    const BATCH = 30000;
    /** 系统 actor 哨兵 id（与服务常量同值） */
    const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

    /** mention 模式 topic + 安全阀阈值（undefined = settings 无该键 → 缺省 8） */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function mockValveTopic(threshold: any) {
      topicRepo.findOne.mockResolvedValue({
        id: 'topic-1',
        title: '圆桌测试',
        kind: 'roundtable',
        settings:
          threshold === undefined
            ? { wakePolicy: 'mention' }
            : { wakePolicy: 'mention', maxRoundsWithoutHuman: threshold },
      });
    }

    /** 按 resourceId 返回对应消息的 findOne mock + enqueueBatch 的 find mock */
    function mockMessagesById(msgs: Message[]) {
      messageRepo.findOne.mockImplementation(
        async ({ where }: { where: { id: string } }) => msgs.find((m) => m.id === where.id) ?? null,
      );
      messageRepo.find.mockImplementation(
        async ({ where }: { where: { id?: { _value?: string[] } } }) => {
          const ids = where.id?._value;
          return ids ? msgs.filter((m) => ids.includes(m.id)) : msgs;
        },
      );
    }

    /** 指定 seatId 的 seat.event 信封（默认 seatEventEnvelope 固定 seat-1） */
    function seatEventFor(seatId: string, seq: number, payload: Record<string, unknown>): Envelope {
      return buildEnvelope('seat.event', payload, { seatId, seq });
    }

    /** 系统 actor 发的「安全阀触发」公告调用列表（过滤回复落库的 AGENT 调用） */
    function sysTripCalls() {
      return topicService.sendMessage.mock.calls.filter(
        ([, , t, dto]) =>
          t === ActorType.SYSTEM && (dto as { content: string }).content.includes('安全阀触发'),
      );
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it('计数推进：非沉默落库成功 roundsWithoutHuman+1；沉默只加 silentCount 不加 rounds（均与游标同次 save）', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      topicService.sendMessage.mockResolvedValue({ id: 'out' });
      mockValveTopic(8);

      // 非沉默轮：落库成功 → rounds+1（与 lastEventSeq 同一次 save）
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('message_complete', {
            stopReason: 'end_turn',
            silent: false,
            text: '正常回复',
          }),
        ),
      );
      expect(seat.lastEventSeq).toBe('1');
      expect(seat.state.roundsWithoutHuman).toBe(1);
      expect(seat.state.silentCount).toBeUndefined();
      expect(seatRepo.save).toHaveBeenCalledTimes(1); // 不新增 save

      // 沉默轮：silentCount+1，rounds 不动（沉默不推进安全阀）
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(2, eventPayload('message_complete', { stopReason: 'end', silent: true })),
      );
      expect(seat.lastEventSeq).toBe('2');
      expect(seat.state.silentCount).toBe(1);
      expect(seat.state.roundsWithoutHuman).toBe(1);
      expect(seatRepo.save).toHaveBeenCalledTimes(2);
    });

    it('人类消息复位：清零全部 active 座位计数，只 save 计数>0 的行；复位不附带唤醒；未 paused 无公告', async () => {
      mockValveTopic(8); // 计数 3 < 8：未暂停 → 无复位公告
      const s1 = makeSeat({ state: { recentInjects: [], roundsWithoutHuman: 3 } });
      const s2 = makeSeat({
        id: 'seat-2',
        label: 'kimi-2',
        state: { recentInjects: [], roundsWithoutHuman: 0 },
      });
      const s3 = makeSeat({ id: 'seat-3', label: 'kimi-3', state: { recentInjects: [] } }); // 无计数键
      seatRepo.find.mockResolvedValue([s1, s2, s3]);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      actorRepo.findOne.mockResolvedValue({ type: ActorType.HUMAN, displayName: 'Tianyu' });
      messageRepo.findOne.mockResolvedValue(
        makeMessage({ id: 'msg-1', content: '大家好', senderId: 'user-1' }),
      );

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await flushMicrotasks();

      expect(s1.state.roundsWithoutHuman).toBe(0);
      expect(s2.state.roundsWithoutHuman).toBe(0);
      // s3 无计数键（等效 0）→ 不被写入，键保持不存在（复位写只触达计数>0 的行）
      expect(s3.state.roundsWithoutHuman).toBeUndefined();
      // 复位写只触达计数>0 的行：仅 s1 被 save
      expect(seatRepo.save).toHaveBeenCalledTimes(1);
      expect(seatRepo.save).toHaveBeenCalledWith(s1);
      // 复位不附带唤醒：mention 桌人类无 @ → 全部只 park 不派发
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      // 未 paused → 无复位公告
      expect(topicService.sendMessage).not.toHaveBeenCalled();
    });

    it('agent 消息不复位（计数保留，无 save）', async () => {
      mockValveTopic(8);
      const seat = makeSeat({ state: { recentInjects: [], roundsWithoutHuman: 5 } });
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      actorRepo.findOne.mockResolvedValue({ type: ActorType.AGENT, displayName: 'Agent-9' });
      messageRepo.findOne.mockResolvedValue(
        makeMessage({ id: 'msg-1', content: 'agent 发言', senderId: 'agent-9' }),
      );

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      expect(seat.state.roundsWithoutHuman).toBe(5);
      expect(seatRepo.save).not.toHaveBeenCalled();
    });

    it('N=2：两轮非沉默落库 → 跨过阈值那一 turn 触发公告一次 + valveTripCount=1；后续轮不重复', async () => {
      mockValveTopic(2);
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      topicService.sendMessage.mockResolvedValue({ id: 'out' });
      topicService.isActiveParticipant.mockResolvedValue(true);

      // 第 1 轮：rounds=1，未达阈值 → 无公告（sendMessage 只有回复落库的 AGENT 调用）
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('message_complete', {
            stopReason: 'end_turn',
            silent: false,
            text: '第一轮',
          }),
        ),
      );
      await flushMicrotasks();
      expect(seat.state.roundsWithoutHuman).toBe(1);
      expect(sysTripCalls()).toHaveLength(0);

      // 第 2 轮：跨过阈值 → 触发公告（系统 actor + type=system + 阈值进文案）+ valveTripCount=1
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          2,
          eventPayload('message_complete', {
            stopReason: 'end_turn',
            silent: false,
            text: '第二轮',
          }),
        ),
      );
      await flushMicrotasks();
      expect(seat.state.roundsWithoutHuman).toBe(2);
      expect(seat.state.valveTripCount).toBe(1);
      expect(sysTripCalls()).toHaveLength(1);
      const [receiptTopic, senderId, senderType, dto] = sysTripCalls()[0];
      expect(receiptTopic).toBe('topic-1');
      expect(senderId).toBe(SYSTEM_ACTOR_ID);
      expect(senderType).toBe(ActorType.SYSTEM);
      expect(dto).toMatchObject({ type: MessageType.SYSTEM, metadata: {} });
      expect((dto as { content: string }).content).toContain('安全阀触发');
      expect((dto as { content: string }).content).toContain('连续 2 轮');
      expect((dto as { content: string }).content).toContain('人类发言即可恢复');

      // 第 3 轮（已暂停态，rounds=3）：非跨过阈值 turn → 不重复公告
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          3,
          eventPayload('message_complete', {
            stopReason: 'end_turn',
            silent: false,
            text: '第三轮',
          }),
        ),
      );
      await flushMicrotasks();
      expect(sysTripCalls()).toHaveLength(1);
    });

    it('多座位同窗口跨过阈值 → 只一条触发公告（per-topic 节流）；节流到期后恢复', async () => {
      jest.useFakeTimers();
      mockValveTopic(2);
      const s1 = makeSeat();
      const s2 = makeSeat({ id: 'seat-2', label: 'kimi-2' });
      seatRepo.findOne.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'seat-1' ? s1 : s2,
      );
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      topicService.sendMessage.mockResolvedValue({ id: 'out' });
      topicService.isActiveParticipant.mockResolvedValue(true);

      // s1 跨过阈值 → 公告 1
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('message_complete', { stopReason: 'end_turn', silent: false, text: 'a1' }),
        ),
      );
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          2,
          eventPayload('message_complete', { stopReason: 'end_turn', silent: false, text: 'a2' }),
        ),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(sysTripCalls()).toHaveLength(1);
      expect(s1.state.valveTripCount).toBe(1);

      // s2 跨过阈值（同 topic 同窗口）→ 节流不重复公告，但自身熔断计数照记
      await service.handleSeatEvent(
        'runner-1',
        seatEventFor(
          'seat-2',
          1,
          eventPayload('message_complete', { stopReason: 'end_turn', silent: false, text: 'b1' }),
        ),
      );
      await service.handleSeatEvent(
        'runner-1',
        seatEventFor(
          'seat-2',
          2,
          eventPayload('message_complete', { stopReason: 'end_turn', silent: false, text: 'b2' }),
        ),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(sysTripCalls()).toHaveLength(1);
      expect(s2.state.valveTripCount).toBe(1);

      // 节流到期（>5 分钟）后：s2 计数清零再跨过 → 公告恢复
      s2.state.roundsWithoutHuman = 0;
      await jest.advanceTimersByTimeAsync(6 * 60 * 1000);
      await service.handleSeatEvent(
        'runner-1',
        seatEventFor(
          'seat-2',
          3,
          eventPayload('message_complete', { stopReason: 'end_turn', silent: false, text: 'b3' }),
        ),
      );
      await service.handleSeatEvent(
        'runner-1',
        seatEventFor(
          'seat-2',
          4,
          eventPayload('message_complete', { stopReason: 'end_turn', silent: false, text: 'b4' }),
        ),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(sysTripCalls()).toHaveLength(2);
    });

    it('暂停中 @座位 只 park 不派发、无回执；复位后下一条 @ 唤醒并把 parked 并入批（messageIds 断言）', async () => {
      jest.useFakeTimers();
      mockValveTopic(2);
      const seat = makeSeat({
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/seat',
          bindActorId: 'agent-1',
          batchWindowMs: BATCH,
        },
        state: { recentInjects: [], roundsWithoutHuman: 2 }, // 已暂停（≥ 阈值 2）
      });
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      registry.sendToRunner.mockReturnValue(true);
      registry.isRunnerOnline.mockReturnValue(true);
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '@kimi-1 在吗',
          createdAt: new Date('2026-08-07T12:00:00Z'),
        }),
        makeMessage({
          id: 'msg-2',
          content: '大家好',
          senderId: 'user-1',
          createdAt: new Date('2026-08-07T12:01:00Z'),
        }),
        makeMessage({
          id: 'msg-3',
          content: '@kimi-1 现在呢',
          createdAt: new Date('2026-08-07T12:02:00Z'),
        }),
      ]);

      // 暂停中：agent @ 消息 → 只 park，不派发、无回执（gate 短路回执触发点 A）
      actorRepo.findOne.mockResolvedValue({ type: ActorType.AGENT, displayName: 'Agent' });
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      expect(topicService.sendMessage).not.toHaveBeenCalled();

      // 人类消息 → 复位（paused → 复位公告一条）→ 无 @ 不唤醒（复位不附带唤醒）
      actorRepo.findOne.mockResolvedValue({ type: ActorType.HUMAN, displayName: 'Tianyu' });
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      await jest.advanceTimersByTimeAsync(0);
      expect(seat.state.roundsWithoutHuman).toBe(0);
      expect(registry.sendToRunner).not.toHaveBeenCalled();
      expect(topicService.sendMessage).toHaveBeenCalledTimes(1);
      const [, , senderType, dto] = topicService.sendMessage.mock.calls[0];
      expect(senderType).toBe(ActorType.SYSTEM);
      expect((dto as { type: string }).type).toBe(MessageType.SYSTEM);
      expect((dto as { content: string }).content).toContain('已复位');

      // 复位后下一条 @ 唤醒：parked（msg-1 + msg-2）并入批派发
      actorRepo.findOne.mockResolvedValue({ type: ActorType.AGENT, displayName: 'Agent' });
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const env = registry.sendToRunner.mock.calls[0][1] as Envelope;
      expect(env.seatId).toBe('seat-1');
      expect(env.seq).toBe(1);
      const body = (env.payload as { body: InjectBody }).body;
      expect(body.batch.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('阈值矩阵（活文档）：缺省 8 / 显式 N 生效 / 0=关闭 / 非法值兜底缺省', async () => {
      jest.useFakeTimers();
      // 每行 = settings 配置 → 期望触发轮次（null = 永不触发/暂停）。断言双轨：
      // 触发公告次数 + valveTripCount（熔断计数），非法值验证 service 防御性解析。
      const cases: Array<{ name: string; config: unknown; tripsAt: number | null }> = [
        { name: '缺省（settings 无该键）', config: undefined, tripsAt: 8 },
        { name: '显式 8', config: 8, tripsAt: 8 },
        { name: '显式 2', config: 2, tripsAt: 2 },
        { name: '显式 0 = 关闭', config: 0, tripsAt: null },
        { name: '非法 -1 → 兜底缺省 8', config: -1, tripsAt: 8 },
        { name: '非法 "abc" → 兜底缺省 8', config: 'abc', tripsAt: 8 },
        { name: '非法 1001 → 兜底缺省 8', config: 1001, tripsAt: 8 },
      ];
      for (const c of cases) {
        mockValveTopic(c.config);
        const seat = makeSeat();
        seatRepo.findOne.mockResolvedValue(seat);
        seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
        runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
        topicService.sendMessage.mockResolvedValue({ id: 'out' });
        topicService.isActiveParticipant.mockResolvedValue(true);
        const before = sysTripCalls().length;
        for (let round = 1; round <= 12; round++) {
          await service.handleSeatEvent(
            'runner-1',
            seatEventEnvelope(
              round,
              eventPayload('message_complete', {
                stopReason: 'end_turn',
                silent: false,
                text: `第${round}轮`,
              }),
            ),
          );
          await jest.advanceTimersByTimeAsync(0);
        }
        const trips = sysTripCalls().length - before;
        if (c.tripsAt === null) {
          expect(trips).toBe(0);
          expect(seat.state.valveTripCount).toBeUndefined();
          expect(seat.state.roundsWithoutHuman).toBe(12); // 计数照常推进（digest 可读）
        } else {
          expect(trips).toBe(1); // 只跨过阈值一次，不重复公告
          expect(seat.state.valveTripCount).toBe(1);
        }
        // 推进节流窗口（>5 分钟），避免下一 case 被 per-topic 节流误伤
        await jest.advanceTimersByTimeAsync(6 * 60 * 1000);
      }
    });

    it('0=关闭：计数 ≥ 任何阈值也不暂停（agent @ 消息照常唤醒派发）', async () => {
      mockValveTopic(0);
      const seat = makeSeat({ state: { recentInjects: [], roundsWithoutHuman: 5 } });
      seatRepo.find.mockResolvedValue([seat]);
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      registry.sendToRunner.mockReturnValue(true);
      registry.isRunnerOnline.mockReturnValue(true);
      messageRepo.findOne.mockResolvedValue(
        makeMessage({ id: 'msg-1', content: '@kimi-1 hi', senderId: 'agent-9' }),
      );

      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));

      expect(registry.sendToRunner).toHaveBeenCalledTimes(1); // 直通派发（不暂停）
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seatId).toBe('seat-1');
    });

    it('集成级（fake runner 全链路）：A/B 互 @ 循环 → 第 N 轮注入停止+公告 → 人类发言复位 → @A 收到含 parked 的批', async () => {
      jest.useFakeTimers();
      // mention 桌 + N=2：两座互 @ 的礼貌循环在第二轮后触发安全阀
      topicRepo.findOne.mockResolvedValue({
        id: 'topic-1',
        title: '圆桌测试',
        kind: 'roundtable',
        settings: { wakePolicy: 'mention', maxRoundsWithoutHuman: 2 },
      });
      const a = makeSeat({
        id: 'seat-a',
        label: 'kimi-A',
        runnerId: 'runner-a',
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/a',
          bindActorId: 'agent-a',
          batchWindowMs: BATCH,
        },
      });
      const b = makeSeat({
        id: 'seat-b',
        label: 'kimi-B',
        runnerId: 'runner-b',
        config: {
          permissionMode: 'auto',
          cwd: '/tmp/b',
          bindActorId: 'agent-b',
          batchWindowMs: BATCH,
        },
      });
      seatRepo.find.mockResolvedValue([a, b]);
      seatRepo.findOne.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'seat-a' ? a : where.id === 'seat-b' ? b : null,
      );
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      registry.sendToRunner.mockReturnValue(true);
      registry.isRunnerOnline.mockReturnValue(true);
      runnerRepo.findOne.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'runner-a'
          ? { id: 'runner-a', actorId: 'agent-a' }
          : { id: 'runner-b', actorId: 'agent-b' },
      );
      actorRepo.findOne.mockResolvedValue({ type: ActorType.AGENT, displayName: 'Agent' });
      topicService.sendMessage.mockResolvedValue({ id: 'out' });
      topicService.isActiveParticipant.mockResolvedValue(true);
      const t = (min: number) => new Date(Date.UTC(2026, 7, 7, 12, min));
      mockMessagesById([
        makeMessage({
          id: 'msg-1',
          content: '@kimi-B 开始',
          metadata: { seatLabel: 'kimi-A' },
          createdAt: t(0),
        }),
        makeMessage({
          id: 'msg-2',
          content: '@kimi-A 收到',
          metadata: { seatLabel: 'kimi-B' },
          createdAt: t(1),
        }),
        makeMessage({
          id: 'msg-3',
          content: '@kimi-B 继续',
          metadata: { seatLabel: 'kimi-A' },
          createdAt: t(2),
        }),
        makeMessage({
          id: 'msg-4',
          content: '@kimi-A 继续',
          metadata: { seatLabel: 'kimi-B' },
          createdAt: t(3),
        }),
        makeMessage({ id: 'msg-5', content: '大家停一下', senderId: 'user-1', createdAt: t(4) }),
        makeMessage({
          id: 'msg-6',
          content: '@kimi-A 请继续',
          senderId: 'user-1',
          createdAt: t(5),
        }),
      ]);
      const sysMsgs = () =>
        topicService.sendMessage.mock.calls.filter(([, , st]) => st === ActorType.SYSTEM);

      // 轮 1：A 发言 @B → B 唤醒开窗 → 到期封批派发（B seq 1）；B 非沉默完成 → B.rounds=1
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-1' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      expect((registry.sendToRunner.mock.calls[0][1] as Envelope).seatId).toBe('seat-b');
      await service.handleSeatEvent(
        'runner-b',
        seatEventFor(
          'seat-b',
          1,
          eventPayload('message_complete', { stopReason: 'end_turn', silent: false, text: '收到' }),
        ),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(b.state.roundsWithoutHuman).toBe(1);

      // 轮 2：B 发言 @A → A 唤醒派发（A seq 1）；A 完成 → A.rounds=1
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-2' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(2);
      expect((registry.sendToRunner.mock.calls[1][1] as Envelope).seatId).toBe('seat-a');
      await service.handleSeatEvent(
        'runner-a',
        seatEventFor(
          'seat-a',
          1,
          eventPayload('message_complete', { stopReason: 'end_turn', silent: false, text: '收到' }),
        ),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(a.state.roundsWithoutHuman).toBe(1);

      // 轮 3：A 发言 @B → B 唤醒派发（B seq 2）；B 完成跨过阈值 → 触发公告 + 熔断计数
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-3' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(3);
      await service.handleSeatEvent(
        'runner-b',
        seatEventFor(
          'seat-b',
          2,
          eventPayload('message_complete', { stopReason: 'end_turn', silent: false, text: '继续' }),
        ),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(b.state.roundsWithoutHuman).toBe(2);
      expect(b.state.valveTripCount).toBe(1);
      expect(sysMsgs()).toHaveLength(1);
      expect((sysMsgs()[0][3] as { content: string }).content).toContain('安全阀触发');

      // 轮 4：B 发言 @A → 已暂停 → A 只 park 不派发、无回执（注入停止）
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-4' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(3);
      expect(sysMsgs()).toHaveLength(1);

      // 人类发言 → 复位（paused → 复位公告）→ 无 @ 只 park（复位不附带唤醒）
      actorRepo.findOne.mockResolvedValue({ type: ActorType.HUMAN, displayName: 'Tianyu' });
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-5' }));
      await jest.advanceTimersByTimeAsync(0);
      expect(a.state.roundsWithoutHuman).toBe(0);
      expect(b.state.roundsWithoutHuman).toBe(0);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(3);
      expect(sysMsgs()).toHaveLength(2);
      expect((sysMsgs()[1][3] as { content: string }).content).toContain('已复位');

      // 人类 @A → A 唤醒 → 批 = parked（msg-4 B 发言 + msg-5 人类）+ 窗口 msg-6
      await service.onMessageCreated(makeEvent({ resourceId: 'msg-6' }));
      await jest.advanceTimersByTimeAsync(BATCH);
      expect(registry.sendToRunner).toHaveBeenCalledTimes(4);
      const env = registry.sendToRunner.mock.calls[3][1] as Envelope;
      expect(env.seatId).toBe('seat-a');
      expect(env.seq).toBe(2);
      const body = (env.payload as { body: InjectBody }).body;
      expect(body.batch.messages.map((m) => m.id)).toEqual(['msg-4', 'msg-5', 'msg-6']);
    });
  });

  // ─────────────────────────── 规则头装配快照 ───────────────────────────

  it('buildRuleHeader：普通座位（身份/沉默协议/@路由含 @all/证据纪律），主脑座位含主脑加成', () => {
    const header = service.buildRuleHeader({ label: 'kimi-1', coordinator: false });
    expect(header).toContain('规则头（version 2）');
    expect(header).toContain('kimi-1');
    expect(header).toContain('{"silent": true}');
    expect(header).toContain('证据纪律');
    expect(header).toContain('@kimi-1');
    expect(header).toContain('@all 唤醒全部座位，慎用');
    expect(header).not.toContain('主脑');

    const bossHeader = service.buildRuleHeader({ label: 'boss', coordinator: true });
    expect(bossHeader).toContain('主脑');
  });

  // ─────────────────────────── M4b-1：presence 推导 + recentActivity 聚合 + cancelSeat ───────────────────────────

  describe('M4b-1 presence 推导（R4 映射，内存 Map 不落库）', () => {
    /** 便捷：触发上行事件后经 listSeats 观察 presence（overlay 语义） */
    async function presenceAfter(
      seq: number,
      payload: Record<string, unknown>,
    ): Promise<SeatPresence | undefined> {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(seq, eventPayload(String(payload.type), payload)),
      );
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
      permService.ensureCan.mockResolvedValue(undefined);
      seatRepo.find.mockResolvedValue([seat]);
      const list = await service.listSeats('topic-1', AGENT_ACTOR);
      return list[0].presence;
    }

    it('无任何事件 → listSeats 不加 presence 字段（无条目 = 从未活动）', async () => {
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
      permService.ensureCan.mockResolvedValue(undefined);
      seatRepo.find.mockResolvedValue([makeSeat()]);
      const list = await service.listSeats('topic-1', AGENT_ACTOR);
      expect(list[0]).not.toHaveProperty('presence');
    });

    it('status busy → thinking（默认思考相位）', async () => {
      const p = await presenceAfter(1, { type: 'status', status: 'busy' });
      expect(p?.phase).toBe('thinking');
      expect(p?.at).toEqual(expect.any(String));
    });

    it('status online → idle；status offline → offline', async () => {
      expect((await presenceAfter(1, { type: 'status', status: 'online' }))?.phase).toBe('idle');
      expect((await presenceAfter(2, { type: 'status', status: 'offline' }))?.phase).toBe(
        'offline',
      );
    });

    it('tool_event in_progress → tool（带 toolTitle）；completed → 回 thinking（r1 漏边修正）', async () => {
      const inProgress = await presenceAfter(1, {
        type: 'tool_event',
        tool: { title: 'read_file', kind: 'read', status: 'in_progress' },
      });
      expect(inProgress).toMatchObject({ phase: 'tool', toolTitle: 'read_file' });
      const completed = await presenceAfter(2, {
        type: 'tool_event',
        tool: { title: 'read_file', kind: 'read', status: 'completed' },
      });
      expect(completed?.phase).toBe('thinking');
      expect(completed?.toolTitle).toBeUndefined(); // 非 tool 相位不带工具标题
    });

    it('message_chunk → replying；message_complete → idle', async () => {
      expect((await presenceAfter(1, { type: 'message_chunk', text: '好的' }))?.phase).toBe(
        'replying',
      );
      expect((await presenceAfter(2, { type: 'message_complete', stopReason: 'end' }))?.phase).toBe(
        'idle',
      );
    });

    it('activity thinking → thinking（1.54.0 R4 补边：replying → 再思考 翻转）', async () => {
      // replying 相位下收到 thought 边沿信号 → 回 thinking；游标照常推进（seq 递增）
      expect((await presenceAfter(1, { type: 'message_chunk', text: '先说一段' }))?.phase).toBe(
        'replying',
      );
      const p = await presenceAfter(2, { type: 'activity', activity: 'thinking' });
      expect(p?.phase).toBe('thinking');
      expect(p?.toolTitle).toBeUndefined(); // 非 tool 相位不带工具标题
    });

    it('silent 轮 message_complete → idle（沉默不是相位，💤 由 idle+上轮 silent 在 web 推导）', async () => {
      const p = await presenceAfter(1, {
        type: 'message_complete',
        stopReason: 'end',
        silent: true,
      });
      expect(p?.phase).toBe('idle');
    });

    it('runner 断连（onRunnerOffline）→ 绑定座位 presence offline', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('status', { status: 'busy' })),
      );
      seatRepo.find.mockResolvedValue([seat]);
      await service.onRunnerOffline('runner-1');
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
      permService.ensureCan.mockResolvedValue(undefined);
      seatRepo.find.mockResolvedValue([seat]);
      const list = await service.listSeats('topic-1', AGENT_ACTOR);
      expect(list[0].presence?.phase).toBe('offline');
    });

    it('座位移除（removeSeat）→ presence 条目清除（listSeats 不再带 presence）', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('status', { status: 'busy' })),
      );
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'user-1' });
      await service.removeSeat('seat-1', HUMAN_ACTOR); // creatorId=user-1，治理身份放行
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't' });
      permService.ensureCan.mockResolvedValue(undefined);
      seatRepo.find.mockResolvedValue([seat]);
      const list = await service.listSeats('topic-1', AGENT_ACTOR);
      expect(list[0]).not.toHaveProperty('presence');
    });
  });

  describe('M4b-1 recentActivity 聚合（R3 冲刷式 + cap 10 环形 + R5 摘要化）', () => {
    it('tool_event 只入缓冲不落库；message_complete 冲刷一次落库（tool 条目在 turn 前）', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      topicService.sendMessage.mockResolvedValue({ id: 'reply-1' });

      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('tool_event', {
            tool: { title: 'read_file', kind: 'read', status: 'in_progress' },
          }),
        ),
      );
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          2,
          eventPayload('tool_event', {
            tool: { title: 'write_file', kind: 'write', status: 'completed' },
          }),
        ),
      );
      // 工具事件不落库：state 无 recentActivity（R3 冲刷式，高频不写放大）
      expect(seat.state.recentActivity).toBeUndefined();

      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(3, eventPayload('message_complete', { stopReason: 'end', text: '好的' })),
      );
      // 一次落库：state.recentActivity = [tool(in_progress), tool(completed), turn]
      expect(seat.state.recentActivity).toHaveLength(3);
      expect(seat.state.recentActivity[0]).toMatchObject({
        kind: 'tool_call',
        summary: 'read_file（read）',
        result: 'in_progress',
      });
      expect(seat.state.recentActivity[1]).toMatchObject({
        kind: 'tool_call',
        summary: 'write_file（write）',
        result: 'completed',
      });
      expect(seat.state.recentActivity[2]).toMatchObject({
        kind: 'turn',
        summary: '回复 2 字',
        result: 'end',
      });
    });

    it('silent 轮 → turn 条目「沉默」（与 silentCount 同次 save）', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('message_complete', { stopReason: 'end', silent: true })),
      );
      expect(seat.state.recentActivity).toEqual([
        expect.objectContaining({ kind: 'turn', summary: '沉默', result: 'end' }),
      ]);
      expect(seat.state.silentCount).toBe(1);
    });

    it('cap 10 环形：超限淘汰最旧（11 tool + 1 turn = 12 条 → 保留最新 10 条）', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      topicService.sendMessage.mockResolvedValue({ id: 'reply-1' });
      for (let i = 1; i <= 11; i += 1) {
        await service.handleSeatEvent(
          'runner-1',
          seatEventEnvelope(
            i,
            eventPayload('tool_event', {
              tool: { title: `tool-${i}`, status: 'in_progress' },
            }),
          ),
        );
      }
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          12,
          eventPayload('message_complete', { stopReason: 'end', text: '完毕' }),
        ),
      );
      expect(seat.state.recentActivity).toHaveLength(10);
      // 最旧两条（tool-1/tool-2）被淘汰，最新 turn 保留
      expect(seat.state.recentActivity[0].summary).toBe('tool-3');
      expect(seat.state.recentActivity[9]).toMatchObject({ kind: 'turn', result: 'end' });
    });

    it('R5 摘要化：剥离 rawInput/locations + cwd 前缀 + title 截断 80 字符', async () => {
      const seat = makeSeat(); // config.cwd = '/tmp/seat'
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      runnerRepo.findOne.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      topicService.sendMessage.mockResolvedValue({ id: 'reply-1' });

      const longTitle = 'x'.repeat(120);
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('tool_event', {
            tool: {
              title: '/tmp/seat/project/src/x.ts',
              kind: 'read',
              status: 'in_progress',
              rawInput: 'SECRET_CONTENT',
              locations: ['/etc/passwd'],
            },
          }),
        ),
      );
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          2,
          eventPayload('tool_event', {
            tool: { title: longTitle, status: 'in_progress' },
          }),
        ),
      );
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(3, eventPayload('message_complete', { stopReason: 'end' })),
      );
      const items = seat.state.recentActivity as Array<Record<string, unknown>>;
      // cwd 前缀剥离（/tmp/seat/ → project/src/x.ts），敏感字段不进入条目
      expect(items[0]).toMatchObject({ kind: 'tool_call', summary: 'project/src/x.ts（read）' });
      expect(JSON.stringify(items[0])).not.toContain('SECRET_CONTENT');
      expect(JSON.stringify(items[0])).not.toContain('/etc/passwd');
      expect(items[0]).not.toHaveProperty('rawInput');
      expect(items[0]).not.toHaveProperty('locations');
      // title 截断 80 字符 + 省略号
      expect(String(items[1].summary).length).toBe(81);
      expect(String(items[1].summary).startsWith('x'.repeat(80))).toBe(true);
    });

    it('permission_request → 即时写（不经 message_complete 冲刷，同 handler 尾部 save 落库）', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      permReqRepo.findOne.mockResolvedValue(null);
      permReqRepo.save.mockResolvedValue({});
      permReqRepo.create.mockImplementation((input: unknown) => input);

      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('permission_request', {
            requestId: 'req-1',
            tool: { title: 'bash', kind: 'shell' },
            options: [],
          }),
        ),
      );
      await flushMicrotasks(); // 公告 fire-and-forget
      expect(seat.state.recentActivity).toEqual([
        expect.objectContaining({ kind: 'permission', summary: 'bash', result: 'pending' }),
      ]);
    });

    it('permission_request 重放命中已有 pending 行 → 不重复写近况条目（幂等）', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      permReqRepo.findOne.mockResolvedValue({ id: 'pr-1', status: 'pending' });
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('permission_request', {
            requestId: 'req-1',
            tool: { title: 'bash' },
            options: [],
          }),
        ),
      );
      await flushMicrotasks();
      expect(seat.state.recentActivity).toBeUndefined();
    });

    it('runner 断连 → 当轮缓冲丢弃（半截活动不落库）', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(
          1,
          eventPayload('tool_event', {
            tool: { title: 'read_file', status: 'in_progress' },
          }),
        ),
      );
      seatRepo.find.mockResolvedValue([seat]);
      await service.onRunnerOffline('runner-1');
      // 断连后无 complete 冲刷点：state 不应含缓冲条目
      expect(seat.state.recentActivity).toBeUndefined();
    });
  });

  describe('M4b-1 cancelSeat（治理权限 + busy 门控 + seat.cancel 下行）', () => {
    /** 构造 busy 座位（先上行 status busy 让 presence=thinking）并 mock 权限放行 */
    async function makeBusySeat(): Promise<RoundtableSeat> {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('status', { status: 'busy' })),
      );
      return seat;
    }

    it('topic 创建者 → 下发 seat.cancel 信封（seq=0 + 空 payload）并返回 accepted', async () => {
      await makeBusySeat();
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'user-1' });
      permService.ensureCan.mockResolvedValue(undefined);
      registry.sendToRunner.mockReturnValue(true);

      const result = await service.cancelSeat('seat-1', HUMAN_ACTOR);
      expect(result).toEqual({ accepted: true, seatId: 'seat-1' });
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
      const envelope = registry.sendToRunner.mock.calls[0][1] as Envelope;
      expect(envelope.type).toBe('seat.cancel');
      expect(envelope.seatId).toBe('seat-1');
      expect(envelope.seq).toBe(0);
      expect(envelope.payload).toEqual({});
    });

    it('平台管理员（role=ADMIN）→ 放行（admin 短路，不触发 owner 代理查询）', async () => {
      await makeBusySeat();
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-9' });
      permService.ensureCan.mockResolvedValue(undefined);
      const result = await service.cancelSeat('seat-1', HUMAN_ADMIN_ACTOR);
      expect(result.accepted).toBe(true);
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('creator 的人类 owner 代理 → 放行', async () => {
      await makeBusySeat();
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-9' });
      permService.ensureCan.mockResolvedValue(undefined);
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      const result = await service.cancelSeat('seat-1', HUMAN_ACTOR);
      expect(result.accepted).toBe(true);
    });

    it('editor 参与方（非 creator 非 admin 非 owner 代理）→ 403 ForbiddenException', async () => {
      await makeBusySeat();
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-9' });
      permService.ensureCan.mockResolvedValue(undefined); // read 通过（参与方）
      ownerProxy.isOwnerProxy.mockResolvedValue(false);
      await expect(service.cancelSeat('seat-1', HUMAN_ACTOR)).rejects.toThrow(ForbiddenException);
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('非参与者 → 404（ensureCan read 失败统一 404，先 404 后 403 同 verdict 模式）', async () => {
      await makeBusySeat();
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'agent-9' });
      permService.ensureCan.mockRejectedValue(new NotFoundException());
      await expect(service.cancelSeat('seat-1', AGENT_ACTOR)).rejects.toThrow(NotFoundException);
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('seat 不存在 → 404 NotFoundException（铁律 #22 findOne 判空）', async () => {
      seatRepo.findOne.mockResolvedValue(null);
      await expect(service.cancelSeat('seat-1', HUMAN_ACTOR)).rejects.toThrow(NotFoundException);
      expect(topicService.findById).not.toHaveBeenCalled();
    });

    it('busy 门控（R1）：无 presence 条目（从未活动）→ 409 RESOURCE_CONFLICT，不下发', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'user-1' });
      permService.ensureCan.mockResolvedValue(undefined);
      await expect(service.cancelSeat('seat-1', HUMAN_ACTOR)).rejects.toMatchObject({
        response: { code: ErrorCode.RESOURCE_CONFLICT },
      });
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('busy 门控（R1）：presence idle（已发言完）→ 409，不误杀健康会话', async () => {
      const seat = makeSeat();
      seatRepo.findOne.mockResolvedValue(seat);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);
      await service.handleSeatEvent(
        'runner-1',
        seatEventEnvelope(1, eventPayload('message_complete', { stopReason: 'end' })),
      );
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'user-1' });
      permService.ensureCan.mockResolvedValue(undefined);
      await expect(service.cancelSeat('seat-1', HUMAN_ACTOR)).rejects.toMatchObject({
        response: { code: ErrorCode.RESOURCE_CONFLICT },
      });
      expect(registry.sendToRunner).not.toHaveBeenCalled();
    });

    it('runner 离线 → 下行失败只记 warning，仍返回 accepted（fire-and-forget 语义）', async () => {
      await makeBusySeat();
      topicService.findById.mockResolvedValue({ id: 'topic-1', title: 't', creatorId: 'user-1' });
      permService.ensureCan.mockResolvedValue(undefined);
      registry.sendToRunner.mockReturnValue(false); // runner 离线
      const result = await service.cancelSeat('seat-1', HUMAN_ACTOR);
      expect(result).toEqual({ accepted: true, seatId: 'seat-1' });
      expect(registry.sendToRunner).toHaveBeenCalledTimes(1);
    });
  });
});
