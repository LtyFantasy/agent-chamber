import { Test, TestingModule } from '@nestjs/testing';
import { ActorType, EventType, UserRole } from '@agent-chamber/shared';
import { SseService, extractEventScope } from './sse.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { UnifiedActor } from '../../common/types/actor.types';

/**
 * B-51 修复核心回归套件：SSE 按连接 actor 过滤。
 * 授权语义与 EventService.poll 一致（同一 AccessQueryService 事实来源）：
 * admin 全通 ∨ 本人事件 ∨ topic/board/space 白名单命中；无归属事件仅本人+admin。
 */
describe('SseService', () => {
  let service: SseService;
  let mockAccessQuery: {
    getAccessibleTopicIds: jest.Mock;
    getAccessibleBoardIds: jest.Mock;
    getAccessibleDocSpaceIds: jest.Mock;
  };

  const alice: UnifiedActor = { id: 'alice-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
  const admin: UnifiedActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };

  /** 收集一个连接收到的事件 */
  function collect(
    actor: UnifiedActor | null,
    filters?: { types?: string[]; topics?: string[] },
  ): { received: Record<string, unknown>[]; close: () => void } {
    const received: Record<string, unknown>[] = [];
    const sub = service
      .subscribe(actor, filters)
      .subscribe((e) => received.push(JSON.parse(e.data as string)));
    return { received, close: () => sub.unsubscribe() };
  }

  /** 等待后台白名单加载/刷新完成（microtask + 宏任务冲刷） */
  const flush = () => new Promise((r) => setImmediate(r));

  function emit(data: Record<string, unknown>) {
    service.emit(data);
  }

  beforeEach(async () => {
    mockAccessQuery = {
      getAccessibleTopicIds: jest.fn().mockResolvedValue(['topic-open', 'topic-a']),
      getAccessibleBoardIds: jest.fn().mockResolvedValue(['board-a']),
      getAccessibleDocSpaceIds: jest.fn().mockResolvedValue(['space-a']),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [SseService, { provide: AccessQueryService, useValue: mockAccessQuery }],
    }).compile();
    service = moduleRef.get<SseService>(SseService);
  });

  describe('extractEventScope', () => {
    it('应从顶层字段与 payload.spaceId 提取归属四元组', () => {
      expect(
        extractEventScope({
          topicId: 't1',
          boardId: 'b1',
          actorId: 'a1',
          payload: { spaceId: 's1' },
        }),
      ).toEqual({ topicId: 't1', boardId: 'b1', spaceId: 's1', actorId: 'a1' });
    });

    it('缺失字段归一为 null（payload 缺省安全）', () => {
      expect(extractEventScope({})).toEqual({
        topicId: null,
        boardId: null,
        spaceId: null,
        actorId: null,
      });
    });
  });

  describe('授权层', () => {
    it('admin 全通且不加载白名单', async () => {
      const c = collect(admin);
      emit({ type: EventType.NEW_MESSAGE, topicId: 'private-topic', actorId: 'bob' });
      expect(c.received).toHaveLength(1);
      expect(mockAccessQuery.getAccessibleTopicIds).not.toHaveBeenCalled();
      c.close();
    });

    it('本人触发的事件始终回显（无需等待白名单）', () => {
      const c = collect(alice);
      // 白名单尚未加载完成也已放行本人事件
      emit({ type: EventType.NEW_MESSAGE, topicId: 'private-topic', actorId: 'alice-1' });
      expect(c.received).toHaveLength(1);
      c.close();
    });

    it('topic 白名单命中放行 / 未命中拦截（核心回归：私密 topic 外人收不到）', async () => {
      const c = collect(alice);
      await flush();
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      emit({ type: EventType.NEW_MESSAGE, topicId: 'private-topic', actorId: 'bob' });
      expect(c.received).toHaveLength(1);
      expect(c.received[0].topicId).toBe('topic-a');
      c.close();
    });

    it('board 白名单命中放行', async () => {
      const c = collect(alice);
      await flush();
      emit({ type: EventType.TASK_UPDATE, boardId: 'board-a', actorId: 'bob' });
      emit({ type: EventType.TASK_UPDATE, boardId: 'board-x', actorId: 'bob' });
      expect(c.received).toHaveLength(1);
      expect(c.received[0].boardId).toBe('board-a');
      c.close();
    });

    it('doc 事件按 payload.spaceId 白名单放行', async () => {
      const c = collect(alice);
      await flush();
      emit({ type: EventType.DOC_UPDATED, payload: { spaceId: 'space-a' }, actorId: 'bob' });
      emit({ type: EventType.DOC_UPDATED, payload: { spaceId: 'space-x' }, actorId: 'bob' });
      expect(c.received).toHaveLength(1);
      expect((c.received[0].payload as Record<string, unknown>).spaceId).toBe('space-a');
      c.close();
    });

    it('topicId/boardId/spaceId 全空的事件仅本人 + admin 可见', async () => {
      const cAlice = collect(alice);
      const cAdmin = collect(admin);
      await flush();
      emit({ type: EventType.SYSTEM, actorId: 'bob', payload: {} });
      expect(cAlice.received).toHaveLength(0);
      expect(cAdmin.received).toHaveLength(1);
      cAlice.close();
      cAdmin.close();
    });

    it('fail-closed：白名单查询失败降级为仅本人事件', async () => {
      mockAccessQuery.getAccessibleTopicIds.mockRejectedValue(new Error('pg down'));
      const c = collect(alice);
      await flush();
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'alice-1' });
      expect(c.received).toHaveLength(1);
      expect(c.received[0].actorId).toBe('alice-1');
      c.close();
    });
  });

  describe('白名单生命周期', () => {
    it('快照过期后台刷新：本次仍用旧快照同步判定，刷新后新快照生效', async () => {
      const c = collect(alice);
      await flush();
      // 初始快照：topic-a 可见
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      expect(c.received).toHaveLength(1);

      // 权限变化：alice 失去 topic-a、获得 topic-c
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-c']);
      // 推进时间超过 TTL（60s）
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);

      // 过期瞬间：本条仍用旧快照判定（topic-a 仍放行，保顺序），后台刷新已触发
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      expect(c.received).toHaveLength(2);

      await flush();
      // 新快照生效：topic-a 拦截、topic-c 放行
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-c', actorId: 'bob' });
      expect(c.received).toHaveLength(3);
      expect(c.received[2].topicId).toBe('topic-c');
      jest.spyOn(Date, 'now').mockRestore();
      c.close();
    });

    it('成员变更事件（AGENT_LEFT）触发全连接白名单即时失效并后台重载', async () => {
      const c = collect(alice);
      await flush();
      expect(mockAccessQuery.getAccessibleTopicIds).toHaveBeenCalledTimes(1);

      // 权限变化后广播成员变更事件
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-c']);
      emit({ type: EventType.AGENT_LEFT, topicId: 'topic-a', actorId: 'bob' });
      await flush();
      expect(mockAccessQuery.getAccessibleTopicIds).toHaveBeenCalledTimes(2);

      // 新快照生效
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-c', actorId: 'bob' });
      // AGENT_LEFT 本身用旧快照判定（topic-a 当时可见）→ 第 1 条；随后仅 topic-c 通过
      expect(c.received.map((e) => e.type)).toEqual([EventType.AGENT_LEFT, EventType.NEW_MESSAGE]);
      expect(c.received[1].topicId).toBe('topic-c');
      c.close();
    });

    it('快照加载中事件仍按序同步送达（顺序性回归）', async () => {
      // 构造可控 deferred，让刷新挂起
      let resolveRefresh!: (v: string[]) => void;
      mockAccessQuery.getAccessibleTopicIds.mockImplementation(
        () => new Promise<string[]>((r) => (resolveRefresh = r)),
      );
      const c = collect(alice);
      // 白名单未加载：本人事件立即可达
      emit({ type: EventType.NEW_MESSAGE, actorId: 'alice-1', cursor: '1' });
      emit({ type: EventType.NEW_MESSAGE, actorId: 'alice-1', cursor: '2' });
      expect(c.received.map((e) => e.cursor)).toEqual(['1', '2']);
      // 放行加载后，后续事件顺序保持
      resolveRefresh(['topic-a']);
      await flush();
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob', cursor: '3' });
      expect(c.received.map((e) => e.cursor)).toEqual(['1', '2', '3']);
      c.close();
    });
  });

  describe('偏好层（types/topics 与授权取交集）', () => {
    it('types 不匹配丢弃', async () => {
      const c = collect(alice, { types: [EventType.TASK_UPDATE] });
      await flush();
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      emit({ type: EventType.TASK_UPDATE, topicId: 'topic-a', actorId: 'bob' });
      expect(c.received).toHaveLength(1);
      expect(c.received[0].type).toBe(EventType.TASK_UPDATE);
      c.close();
    });

    it('topics 声明无权话题不扩大可见面（授权层兜底）', async () => {
      const c = collect(alice, { topics: ['private-topic', 'topic-a'] });
      await flush();
      emit({ type: EventType.NEW_MESSAGE, topicId: 'private-topic', actorId: 'bob' });
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      // private-topic 虽在偏好声明里，但不在白名单 → 拦截
      expect(c.received).toHaveLength(1);
      expect(c.received[0].topicId).toBe('topic-a');
      c.close();
    });

    it('topics 声明后未命中的有权事件也不送达（交集语义）', async () => {
      const c = collect(alice, { topics: ['topic-a'] });
      await flush();
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-open', actorId: 'bob' });
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      expect(c.received).toHaveLength(1);
      expect(c.received[0].topicId).toBe('topic-a');
      c.close();
    });
  });

  describe('连接管理', () => {
    it('getActiveConnections 随订阅/退订增减', () => {
      expect(service.getActiveConnections()).toBe(0);
      const c1 = collect(alice);
      const c2 = collect(admin);
      expect(service.getActiveConnections()).toBe(2);
      c1.close();
      expect(service.getActiveConnections()).toBe(1);
      c2.close();
      expect(service.getActiveConnections()).toBe(0);
    });

    it('退订后不再接收事件', async () => {
      const c = collect(alice);
      await flush();
      c.close();
      emit({ type: EventType.NEW_MESSAGE, topicId: 'topic-a', actorId: 'bob' });
      expect(c.received).toHaveLength(0);
    });
  });
});
