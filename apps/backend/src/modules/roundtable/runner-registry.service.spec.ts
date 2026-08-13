/**
 * RunnerRegistryService 单测（M1 计划阶段 3）
 *
 * 覆盖：DB upsert（新建/复用）、一 key 一 runner 踢旧（§7 后到踢先到）、hello 元信息刷新、
 * 座位绑定（bindActorId + vendor 规则、assign 下行）、sendToRunner 在线/离线、断连清理、
 * touch 心跳。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type WebSocket from 'ws';
import { RunnerRegistryService } from './runner-registry.service';
import { RoundtableRunner } from '../../database/entities/roundtable-runner.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import type { AgentPayload } from '../../common/services/api-key-auth.service';
import { buildEnvelope, type HelloPayload } from '@agent-chamber/roundtable-protocol';

/** 假 WS 连接（ws 库 readyState: OPEN=1；保持 jest.Mock 类型供断言，调用处 cast） */
function makeSocket() {
  return {
    readyState: 1,
    OPEN: 1,
    send: jest.fn(),
    close: jest.fn(),
  };
}

/** 调用处类型适配：mock 对象 → WebSocket（service 签名需要） */
function asWs(socket: ReturnType<typeof makeSocket>): WebSocket {
  return socket as unknown as WebSocket;
}

function makeAgent(overrides: Partial<AgentPayload> = {}): AgentPayload {
  return { id: 'agent-1', name: 'Test Agent', ownerId: 'owner-1', permissions: {}, ...overrides };
}

function makeSeat(overrides: Partial<RoundtableSeat> = {}) {
  return {
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
    ...overrides,
  } as unknown as RoundtableSeat;
}

describe('RunnerRegistryService', () => {
  let service: RunnerRegistryService;
  let runnerRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  let seatRepo: {
    find: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(async () => {
    runnerRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    seatRepo = {
      find: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    // service 内 DB 写均为 .catch 链（fire-and-forget 语义），mock 需返回 Promise
    runnerRepo.save.mockResolvedValue({});
    runnerRepo.update.mockResolvedValue({ affected: 1 });
    seatRepo.save.mockResolvedValue({});
    seatRepo.update.mockResolvedValue({ affected: 1 });
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RunnerRegistryService,
        { provide: getRepositoryToken(RoundtableRunner), useValue: runnerRepo },
        { provide: getRepositoryToken(RoundtableSeat), useValue: seatRepo },
      ],
    }).compile();
    service = moduleRef.get(RunnerRegistryService);
  });

  describe('register（DB upsert + 在线表）', () => {
    it('新建 runner 行：create + save，写入在线表并返回 id', async () => {
      runnerRepo.findOne.mockResolvedValue(null);
      const row = { id: 'runner-1', name: 'Test Agent', actorId: 'agent-1', status: 'online' };
      runnerRepo.create.mockImplementation((input: unknown) => ({ ...row, ...(input as object) }));
      runnerRepo.save.mockResolvedValue(row);

      const socket = makeSocket();
      const runnerId = await service.register(makeAgent(), asWs(socket));

      expect(runnerId).toBe('runner-1');
      expect(runnerRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Agent',
          actorId: 'agent-1',
          status: 'online',
          vendors: [],
        }),
      );
      expect(runnerRepo.save).toHaveBeenCalled();
      // 在线表生效：sendToRunner 可送达
      const ok = service.sendToRunner(
        'runner-1',
        buildEnvelope('ping', {}, {}),
      );
      expect(ok).toBe(true);
      expect(socket.send).toHaveBeenCalled();
    });

    it('复用已有行：status 刷新 online + lastSeenAt 更新，返回同一 id', async () => {
      const existing = {
        id: 'runner-1',
        name: 'Old Name',
        actorId: 'agent-1',
        status: 'offline',
        lastSeenAt: null as Date | null,
      };
      runnerRepo.findOne.mockResolvedValue(existing);
      runnerRepo.save.mockResolvedValue(existing);

      const runnerId = await service.register(makeAgent(), asWs(makeSocket()));

      expect(runnerId).toBe('runner-1');
      expect(existing.status).toBe('online');
      expect(existing.lastSeenAt).toBeInstanceOf(Date);
      expect(runnerRepo.save).toHaveBeenCalledWith(existing);
    });

    it('一 key 一 runner（§7）：同 actor 新连接踢掉旧连接 close(4012)', async () => {
      runnerRepo.findOne.mockResolvedValue(null);
      runnerRepo.create.mockImplementation((input: unknown) => ({ id: 'runner-1', ...(input as object) }));
      runnerRepo.save.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });

      const oldSocket = makeSocket();
      const newSocket = makeSocket();
      await service.register(makeAgent(), asWs(oldSocket));
      await service.register(makeAgent(), asWs(newSocket));

      expect(oldSocket.close).toHaveBeenCalledWith(4012, expect.any(String));
      const entry = service.getOnline('runner-1');
      expect(entry?.socket).toBe(newSocket);
    });
  });

  describe('updateHelloInfo（hello 元信息刷新）', () => {
    it('刷新 version/vendors/lastSeenAt；hello 可选 name 字段生效', async () => {
      const runner = {
        id: 'runner-1',
        name: 'Agent Name',
        version: null as string | null,
        vendors: [] as string[],
        lastSeenAt: null as Date | null,
      };
      runnerRepo.findOne.mockResolvedValue(runner);
      runnerRepo.save.mockResolvedValue(runner);

      await service.updateHelloInfo('runner-1', {
        version: '0.1.0',
        vendors: ['kimi'],
        name: 'my-runner',
        seats: {},
      } as unknown as HelloPayload);

      expect(runner.version).toBe('0.1.0');
      expect(runner.vendors).toEqual(['kimi']);
      expect(runner.name).toBe('my-runner');
      expect(runner.lastSeenAt).toBeInstanceOf(Date);
    });

    it('hello 未带 name 时保留现有展示名', async () => {
      const runner = { id: 'runner-1', name: 'Agent Name', version: null, vendors: [] as string[] };
      runnerRepo.findOne.mockResolvedValue(runner);
      runnerRepo.save.mockResolvedValue(runner);
      await service.updateHelloInfo('runner-1', {
        version: '0.1.0',
        vendors: ['kimi'],
        seats: {},
      } as unknown as HelloPayload);
      expect(runner.name).toBe('Agent Name');
    });
  });

  describe('bindSeats（绑定规则 + seat.assign 下行）', () => {
    it('匹配 bindActorId + vendor + 可绑定状态 → 落库并逐座位下行 seat.assign', async () => {
      const socket = makeSocket();
      runnerRepo.findOne.mockResolvedValue(null);
      runnerRepo.create.mockImplementation((input: unknown) => ({ id: 'runner-1', ...(input as object) }));
      runnerRepo.save.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      await service.register(makeAgent(), asWs(socket));

      const seat = makeSeat();
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([seat]),
      };
      seatRepo.createQueryBuilder.mockReturnValue(qb);
      seatRepo.save.mockImplementation(async (s: RoundtableSeat) => s);

      const bound = await service.bindSeats('runner-1', ['kimi']);

      expect(bound).toEqual([seat]);
      // 绑定规则断言（M1 自审补：bindActorId == runner actor 且 vendor ∈ hello.vendors）
      expect(qb.where).toHaveBeenCalledWith(
        `seat.config->>'bindActorId' = :actorId`,
        { actorId: 'agent-1' },
      );
      expect(qb.andWhere).toHaveBeenCalledWith(`seat.vendor IN (:...vendors)`, {
        vendors: ['kimi'],
      });
      expect(seat.runnerId).toBe('runner-1');
      expect(seat.status).toBe('active');
      // seat.assign 信封下行（§4：SeatConfig 即 payload）
      const sent = JSON.parse(socket.send.mock.calls[0][0]);
      expect(sent.type).toBe('seat.assign');
      expect(sent.seatId).toBe('seat-1');
      expect(sent.seq).toBe(0);
      expect(sent.payload).toEqual({
        seatId: 'seat-1',
        label: 'kimi-1',
        vendor: 'kimi',
        cwd: '/tmp/seat',
        permissionMode: 'auto',
      });
    });

    it('已被其他 runner 绑定的座位不抢（跳过且不下发）', async () => {
      const socket = makeSocket();
      runnerRepo.findOne.mockResolvedValue(null);
      runnerRepo.create.mockImplementation((input: unknown) => ({ id: 'runner-1', ...(input as object) }));
      runnerRepo.save.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      await service.register(makeAgent(), asWs(socket));

      const occupied = makeSeat({ runnerId: 'runner-99' });
      seatRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([occupied]),
      });

      const bound = await service.bindSeats('runner-1', ['kimi']);

      expect(bound).toEqual([]);
      expect(socket.send).not.toHaveBeenCalled();
      expect(occupied.runnerId).toBe('runner-99');
    });

    it('runner 不在线 / hello 未声明 vendor → 不绑定', async () => {
      expect(await service.bindSeats('runner-missing', ['kimi'])).toEqual([]);
      const socket = makeSocket();
      runnerRepo.findOne.mockResolvedValue(null);
      runnerRepo.create.mockImplementation((input: unknown) => ({ id: 'runner-1', ...(input as object) }));
      runnerRepo.save.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      await service.register(makeAgent(), asWs(socket));
      expect(await service.bindSeats('runner-1', [])).toEqual([]);
      expect(seatRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('sendToRunner', () => {
    it('在线 → socket.send(JSON 信封)，返回 true', async () => {
      const socket = makeSocket();
      runnerRepo.findOne.mockResolvedValue(null);
      runnerRepo.create.mockImplementation((input: unknown) => ({ id: 'runner-1', ...(input as object) }));
      runnerRepo.save.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      await service.register(makeAgent(), asWs(socket));

      const envelope = buildEnvelope('ping', {}, {});
      expect(service.sendToRunner('runner-1', envelope)).toBe(true);
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify(envelope));
    });

    it('离线/未知 runner → false（调用方自行兜底）', () => {
      expect(
        service.sendToRunner('runner-ghost', buildEnvelope('ping', {}, {})),
      ).toBe(false);
    });
  });

  describe('unregisterBySocket（断连清理）', () => {
    it('移除在线表 + runner/seat DB status=offline，返回 runnerId', async () => {
      const socket = makeSocket();
      runnerRepo.findOne.mockResolvedValue(null);
      runnerRepo.create.mockImplementation((input: unknown) => ({ id: 'runner-1', ...(input as object) }));
      runnerRepo.save.mockResolvedValue({ id: 'runner-1', actorId: 'agent-1' });
      await service.register(makeAgent(), asWs(socket));

      const runnerId = await service.unregisterBySocket(asWs(socket));

      expect(runnerId).toBe('runner-1');
      expect(service.getOnline('runner-1')).toBeUndefined();
      expect(runnerRepo.update).toHaveBeenCalledWith(
        { id: 'runner-1' },
        expect.objectContaining({ status: 'offline' }),
      );
      expect(seatRepo.update).toHaveBeenCalledWith(
        { runnerId: 'runner-1' },
        { status: 'offline' },
      );
    });

    it('未知连接 → null（幂等）', async () => {
      expect(await service.unregisterBySocket(asWs(makeSocket()))).toBeNull();
    });
  });

  describe('touch（心跳刷新）', () => {
    it('更新 lastSeenAt（fire-and-forget 语义，失败不抛出）', async () => {
      runnerRepo.update.mockRejectedValue(new Error('db down'));
      await expect(service.touch('runner-1')).resolves.toBeUndefined();
      expect(runnerRepo.update).toHaveBeenCalledWith(
        { id: 'runner-1' },
        expect.objectContaining({ lastSeenAt: expect.any(Date) }),
      );
    });
  });
});
