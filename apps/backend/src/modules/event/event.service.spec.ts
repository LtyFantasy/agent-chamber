import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository, ObjectLiteral, SelectQueryBuilder, Brackets } from 'typeorm';
import { EventService } from './event.service';
import { Event } from '../../database/entities/event.entity';
import { EventType } from '@agent-chamber/shared';
import { SseService } from '../sse/sse.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ActorType, UserRole } from '@agent-chamber/shared';
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
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
    })),
  } as unknown as jest.Mocked<Repository<T>>;
}

function createMockAccessQuery() {
  return {
    getAccessibleTopicIds: jest.fn(),
    getAccessibleBoardIds: jest.fn(),
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
    getMany: jest.Mock;
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
      getMany: jest.fn(),
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

    it('should return nextCursor = current timestamp when empty with no cursor', async () => {
      const fakeNow = 1721800000000;
      jest.spyOn(Date, 'now').mockReturnValue(fakeNow);
      queryBuilderChain.getMany.mockResolvedValue([]);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const result = await service.poll({}, mockActor);

      expect(result).toEqual({ events: [], nextCursor: String(fakeNow * 1000) });
      jest.spyOn(Date, 'now').mockRestore();
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
    });

    // cursor=now alias —— agent 想跳过历史从当前时刻开始监听
    it('should resolve cursor=now to Date.now() * 1000 microsecond string', async () => {
      const fakeNow = 1721800000000;
      jest.spyOn(Date, 'now').mockReturnValue(fakeNow);
      queryBuilderChain.getMany.mockResolvedValue([]);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      await service.poll({ cursor: 'now' }, mockActor);

      // where clause should use the resolved microsecond value, NOT the literal 'now'
      expect(queryBuilderChain.where).toHaveBeenCalledWith('event.cursor > :cursor', {
        cursor: String(fakeNow * 1000),
      });
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('should return nextCursor = resolved now value when cursor=now and no events', async () => {
      const fakeNow = 1721800000000;
      jest.spyOn(Date, 'now').mockReturnValue(fakeNow);
      queryBuilderChain.getMany.mockResolvedValue([]);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const result = await service.poll({ cursor: 'now' }, mockActor);

      // nextCursor = the resolved effectiveCursor (not a fresh Date.now() call)
      expect(result.nextCursor).toBe(String(fakeNow * 1000));
      expect(result.events).toEqual([]);
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('should return nextCursor = last event cursor when cursor=now and events exist', async () => {
      const fakeNow = 1721800000000;
      jest.spyOn(Date, 'now').mockReturnValue(fakeNow);
      const events = [{ id: 'evt-4', cursor: String(fakeNow * 1000 + 500) }] as Event[];
      queryBuilderChain.getMany.mockResolvedValue(events);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const result = await service.poll({ cursor: 'now' }, mockActor);

      expect(result).toEqual({ events, nextCursor: events[0].cursor });
      jest.spyOn(Date, 'now').mockRestore();
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
