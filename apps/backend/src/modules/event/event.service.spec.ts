/**
 * EventService 单测（mock 仓储）
 *
 * ⚠️ **本文件的 cursor 语义在 v1.95.0-dev 随卡 dc8c7d1e 整体改写**（B-52）：cursor 从
 * 「应用层造的墙钟微秒串」变成「DB 序列发的不透明序列号」——三条旧断言（'now' 解析成
 * `Date.now()*1000`、空结果兜底造墙钟值、「同毫秒的既有事件会被 'now' 越过」）在新语义下
 * **结构上不可能**，故改写/删除；真库行为由 `test/events-cursor.e2e-spec.ts` 覆盖（铁律 #23）。
 */
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository, ObjectLiteral, SelectQueryBuilder, Brackets } from 'typeorm';
import { EventService } from './event.service';
import { Event } from '../../database/entities/event.entity';
import { EventType } from '@agent-chamber/shared';
import { SseService } from '../sse/sse.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ActorType, ErrorCode, UserRole } from '@agent-chamber/shared';
import { UnifiedActor } from '../../common/types/actor.types';

function createMockRepo<T extends ObjectLiteral>() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    softRemove: jest.fn(),
    count: jest.fn(),
    countBy: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      getRawOne: jest.fn(),
    })),
  } as unknown as jest.Mocked<Repository<T>>;
}

function createMockAccessQuery() {
  return {
    getAccessibleTopicIds: jest.fn(),
    getAccessibleBoardIds: jest.fn(),
    getAccessibleDocSpaceIds: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<AccessQueryService>;
}

describe('EventService', () => {
  let service: EventService;
  let mockRepo: jest.Mocked<Repository<Event>>;
  let mockAccessQuery: jest.Mocked<AccessQueryService>;
  let mockEventEmitter: { emit: jest.Mock };
  let queryBuilderChain: {
    orderBy: jest.Mock;
    take: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    select: jest.Mock;
    getMany: jest.Mock;
    getRawOne: jest.Mock;
  };

  const mockActor: UnifiedActor = {
    id: 'actor-1',
    type: ActorType.HUMAN,
    role: UserRole.EDITOR,
    name: 'Test Actor',
  };

  beforeEach(async () => {
    queryBuilderChain = {
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      // resolveMaxCursor 的两环（B-52）：`select('MAX(event.cursor)','max')` + `getRawOne()`
      select: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
      getRawOne: jest.fn(),
    };
    mockRepo = createMockRepo<Event>();
    mockRepo.createQueryBuilder.mockReturnValue(
      queryBuilderChain as unknown as SelectQueryBuilder<Event>,
    );
    mockAccessQuery = createMockAccessQuery();
    mockEventEmitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: getRepositoryToken(Event), useValue: mockRepo },
        { provide: SseService, useValue: { emit: jest.fn() } },
        { provide: AccessQueryService, useValue: mockAccessQuery },
        // 事件总线 mock（M1 圆桌计划决策 2：create() 末尾 emit('event.created')）
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = moduleRef.get<EventService>(EventService);
  });

  describe('poll', () => {
    it('should return { events, nextCursor } — last cursor when events exist', async () => {
      const events = [
        { id: 'evt-1', cursor: '100' },
        { id: 'evt-2', cursor: '200' },
      ] as Event[];
      queryBuilderChain.getMany.mockResolvedValue(events);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const result = await service.poll({}, mockActor);

      expect(result).toEqual({ events, nextCursor: '200' });
      expect(queryBuilderChain.where).toHaveBeenCalled();
      expect(queryBuilderChain.getMany).toHaveBeenCalled();
    });

    it('空结果 + 未传 cursor → nextCursor = 库内 MAX(cursor)（**不再造墙钟值**，B-52）', async () => {
      queryBuilderChain.getMany.mockResolvedValue([]);
      queryBuilderChain.getRawOne.mockResolvedValue({ max: '1792000000000123' });
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const result = await service.poll({}, mockActor);

      expect(result).toEqual({ events: [], nextCursor: '1792000000000123' });
      // 取值来自 QB 的 `MAX(event.cursor)`（不是 Date.now()）
      expect(queryBuilderChain.select).toHaveBeenCalledWith('MAX(event.cursor)', 'max');
      expect(queryBuilderChain.getRawOne).toHaveBeenCalledTimes(1);
    });

    it("空表（MAX 为 NULL）→ nextCursor = '0'（比任何真实 cursor 都小，语义正确）", async () => {
      queryBuilderChain.getMany.mockResolvedValue([]);
      queryBuilderChain.getRawOne.mockResolvedValue({ max: null });
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const result = await service.poll({}, mockActor);

      expect(result.nextCursor).toBe('0');
    });

    it('should filter by cursor when a normal string cursor is provided', async () => {
      const events = [{ id: 'evt-3', cursor: '300' }] as Event[];
      queryBuilderChain.getMany.mockResolvedValue(events);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const result = await service.poll({ cursor: '200', limit: 50 }, mockActor);

      expect(queryBuilderChain.where).toHaveBeenCalledWith('event.cursor > :cursor', {
        cursor: '200',
      });
      expect(queryBuilderChain.andWhere).toHaveBeenCalled();
      expect(result).toEqual({ events, nextCursor: '300' });
      // 显式 cursor 时不需要回库求 MAX（懒求值）
      expect(queryBuilderChain.getRawOne).not.toHaveBeenCalled();
    });

    // cursor='now' 的**新语义**（B-52）：锚定「当前全局最大位点」= 回库取 MAX(cursor)，
    // 不再是「当前墙钟微秒」（那会造出一个可能大于一切真实 cursor 的伪位点 ⇒ 永久静默）
    it("cursor='now' → 生效游标 = 库内 MAX(cursor)", async () => {
      queryBuilderChain.getMany.mockResolvedValue([]);
      queryBuilderChain.getRawOne.mockResolvedValue({ max: '5000' });
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      await service.poll({ cursor: 'now' }, mockActor);

      // where 子句用的是**解析后的 MAX**，不是字面量 'now'，也不是墙钟值
      expect(queryBuilderChain.where).toHaveBeenCalledWith('event.cursor > :cursor', {
        cursor: '5000',
      });
    });

    // 行为变更回归证据：旧实现下 'now' 恒返回「当前时刻之后的新事件」；新语义下
    // 「MAX 之后必然为空」——nextCursor 必须**恰等于**该 MAX（消费方据此续拉不漏不重）
    it("cursor='now' 且无新事件 → events 为空且 nextCursor === MAX(cursor)（恒等式）", async () => {
      queryBuilderChain.getMany.mockResolvedValue([]);
      queryBuilderChain.getRawOne.mockResolvedValue({ max: '9001' });
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const result = await service.poll({ cursor: 'now' }, mockActor);

      expect(result.events).toEqual([]);
      expect(result.nextCursor).toBe('9001');
      // 'now' 已解析成具体值 ⇒ 兜底分支不再二次求值（仍是懒求值的 1 次）
      expect(queryBuilderChain.getRawOne).toHaveBeenCalledTimes(1);
    });

    // 分页硬上限回归：limit 超限静默钳制到 100（轮询热路径不返回 400，避免打断轮询循环）
    it('should clamp limit above 100 down to 100', async () => {
      queryBuilderChain.getMany.mockResolvedValue([]);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      await service.poll({ limit: 999999 }, mockActor);

      expect(queryBuilderChain.take).toHaveBeenCalledWith(100);
    });

    it('should not apply visibility filter for admin actor', async () => {
      const adminActor: UnifiedActor = {
        id: 'admin-1',
        type: ActorType.HUMAN,
        role: UserRole.ADMIN,
      };
      const events = [{ id: 'evt-1', cursor: '100' }] as Event[];
      queryBuilderChain.getMany.mockResolvedValue(events);

      const result = await service.poll({}, adminActor);

      expect(mockAccessQuery.getAccessibleTopicIds).not.toHaveBeenCalled();
      expect(mockAccessQuery.getAccessibleBoardIds).not.toHaveBeenCalled();
      expect(mockAccessQuery.getAccessibleDocSpaceIds).not.toHaveBeenCalled();
      expect(queryBuilderChain.andWhere).not.toHaveBeenCalled();
      expect(result).toEqual({ events, nextCursor: '100' });
    });

    it('should fallback to actor-only events when no accessible resources', async () => {
      queryBuilderChain.getMany.mockResolvedValue([]);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue([]);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue([]);

      await service.poll({}, mockActor);

      expect(queryBuilderChain.where).toHaveBeenCalledWith(expect.any(Brackets));
      expect(queryBuilderChain.andWhere).not.toHaveBeenCalled();
    });

    it.each([undefined, '200'])(
      'DocSpace OR stays inside visibility brackets (cursor=%s)',
      async (cursor) => {
        queryBuilderChain.getMany.mockResolvedValue([{ cursor: '300' }] as Event[]);
        mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
        mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);
        mockAccessQuery.getAccessibleDocSpaceIds.mockResolvedValue(['space-1']);

        await service.poll({ cursor, limit: 1 }, mockActor);

        expect(mockAccessQuery.getAccessibleDocSpaceIds).toHaveBeenCalledWith(mockActor);
        // Execute the actual callback: instanceof alone cannot prove the OR predicates or grouping.
        const clauses = cursor ? queryBuilderChain.andWhere : queryBuilderChain.where;
        const brackets = clauses.mock.calls[0][0] as Brackets;
        expect(brackets).toBeInstanceOf(Brackets);
        const nested = { orWhere: jest.fn().mockReturnThis() };
        brackets.whereFactory(nested as any);
        expect(nested.orWhere.mock.calls).toEqual([
          ['event.topic_id IN (:...accessibleTopicIds)', { accessibleTopicIds: ['topic-1'] }],
          ['event.board_id IN (:...accessibleBoardIds)', { accessibleBoardIds: ['board-1'] }],
          [
            "event.payload->>'spaceId' IN (:...accessibleDocSpaceIds)",
            { accessibleDocSpaceIds: ['space-1'] },
          ],
          ['event.actor_id = :actorId', { actorId: mockActor.id }],
        ]);
        if (cursor) {
          expect(queryBuilderChain.where.mock.calls).toEqual([
            ['event.cursor > :cursor', { cursor }],
          ]);
        } else {
          expect(queryBuilderChain.andWhere).not.toHaveBeenCalled();
        }
        expect(queryBuilderChain.take).toHaveBeenCalledWith(1);
      },
    );

    it('empty DocSpace whitelist omits IN () while preserving topic, board and personal OR', async () => {
      queryBuilderChain.getMany.mockResolvedValue([{ cursor: '100' }] as Event[]);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);
      mockAccessQuery.getAccessibleDocSpaceIds.mockResolvedValue([]);

      await service.poll({}, mockActor);

      expect(mockAccessQuery.getAccessibleDocSpaceIds).toHaveBeenCalledWith(mockActor);
      const brackets = queryBuilderChain.where.mock.calls[0][0] as Brackets;
      const nested = { orWhere: jest.fn().mockReturnThis() };
      brackets.whereFactory(nested as any);
      expect(nested.orWhere.mock.calls).toEqual([
        ['event.topic_id IN (:...accessibleTopicIds)', { accessibleTopicIds: ['topic-1'] }],
        ['event.board_id IN (:...accessibleBoardIds)', { accessibleBoardIds: ['board-1'] }],
        ['event.actor_id = :actorId', { actorId: mockActor.id }],
      ]);
    });
  });

  /**
   * cursor 入参守卫（B-52 + 铁律 #21 双层校验）：格式错误必须在门口拦掉，**不得透传到 PG**
   * （`22P02 invalid input syntax for type bigint` → 500；铁律 #9 禁止把上游错误包装成 500）。
   */
  describe('poll — cursor 入参守卫', () => {
    it("非法 cursor（'abc' / 30 位数字 / 数组 / 负号 / 小数）→ 400 VALIDATION_ERROR，且零查库", async () => {
      const badValues: unknown[] = ['abc', '9'.repeat(30), ['1', '2'], '-1', '1.5', '1e5'];
      for (const bad of badValues) {
        await expect(service.poll({ cursor: bad as string }, mockActor)).rejects.toMatchObject({
          response: { code: ErrorCode.VALIDATION_ERROR },
        });
      }
      await expect(service.poll({ cursor: 'abc' }, mockActor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // 守卫在最前面 ⇒ 一次查询都没打
      expect(queryBuilderChain.getMany).not.toHaveBeenCalled();
      expect(queryBuilderChain.getRawOne).not.toHaveBeenCalled();
    });

    it("cursor='' → 按缺省处理（从最早开始），不报错、不加 cursor 条件", async () => {
      queryBuilderChain.getMany.mockResolvedValue([]);
      queryBuilderChain.getRawOne.mockResolvedValue({ max: '42' });
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const result = await service.poll({ cursor: '' }, mockActor);

      expect(result.nextCursor).toBe('42');
      // 无 cursor ⇒ 走「仅可见性过滤」的 where(Brackets) 分支（未被 andWhere 追加游标条件）
      expect(queryBuilderChain.where).toHaveBeenCalledWith(expect.any(Brackets));
      expect(queryBuilderChain.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('should create and save an event', async () => {
      const dto = {
        eventType: EventType.SYSTEM,
        resourceType: 'test',
        resourceId: 'res-1',
        cursor: '100',
        payload: { key: 'value' },
      };
      const created = { id: 'evt-1', ...dto } as unknown as Event;
      const saved = { id: 'evt-1', ...dto } as unknown as Event;

      mockRepo.create.mockReturnValue(created);
      mockRepo.save.mockResolvedValue(saved);

      const result = await service.create(dto);

      expect(mockRepo.create).toHaveBeenCalledWith(dto);
      expect(mockRepo.save).toHaveBeenCalledWith(created);
      expect(result).toEqual(saved);
      // 事件总线挂点：落库成功后同步派发（新增行为，铁律 #17 同步覆盖）
      expect(mockEventEmitter.emit).toHaveBeenCalledWith('event.created', saved);
    });

    // B-52 核心回归：**未传 cursor ⇒ repo.create 入参里不能有 cursor 键**。
    // 有键（哪怕 undefined）会覆盖实体 default，插入便不再走 `nextval`；而 cursor 列 NOT NULL
    // ⇒ 23502。取值权的唯一路径 = DB 序列 default（+ RETURNING 回填 saved.cursor）。
    it('未传 cursor → repo.create 入参不含 cursor 键（取值权归 DB default）', async () => {
      const dto = {
        eventType: EventType.SYSTEM,
        resourceType: 'test',
        resourceId: 'res-1',
      };
      mockRepo.create.mockReturnValue({ id: 'evt-1' } as unknown as Event);
      mockRepo.save.mockResolvedValue({ id: 'evt-1' } as unknown as Event);

      await service.create(dto);

      const createdArg = mockRepo.create.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(createdArg)).not.toContain('cursor');
      expect(createdArg).toMatchObject(dto);
    });

    it("显式非空 cursor 原样透传；'' 与「未传」同款（空串会让 PG 22P02）", async () => {
      const dto = {
        eventType: EventType.SYSTEM,
        resourceType: 'test',
        resourceId: 'res-1',
      };
      mockRepo.create.mockReturnValue({ id: 'evt-1' } as unknown as Event);
      mockRepo.save.mockResolvedValue({ id: 'evt-1' } as unknown as Event);

      await service.create({ ...dto, cursor: '123' });
      expect(mockRepo.create).toHaveBeenCalledWith({ ...dto, cursor: '123' });

      await service.create({ ...dto, cursor: '' });
      const blankArg = mockRepo.create.mock.calls[1][0] as Record<string, unknown>;
      expect(Object.keys(blankArg)).not.toContain('cursor');
    });

    // B-51 回归：SSE 广播载荷必须带 topicId/boardId/actorId（SseService 按连接过滤的输入）
    it('should emit SSE payload with topicId/boardId/actorId for per-connection filtering', async () => {
      const dto = {
        eventType: EventType.NEW_MESSAGE,
        resourceType: 'message',
        resourceId: 'msg-1',
        topicId: 'topic-1',
        boardId: 'board-1',
        actorId: 'actor-1',
        payload: { messageId: 'msg-1', spaceId: 'space-1' },
        cursor: '100',
      };
      const saved = { id: 'evt-1', ...dto, createdAt: new Date() } as unknown as Event;
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);

      const sseEmit = jest.mocked(service['sseService'].emit);
      await service.create(dto);

      expect(sseEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventType.NEW_MESSAGE,
          topicId: 'topic-1',
          boardId: 'board-1',
          actorId: 'actor-1',
        }),
      );
    });
  });
});
