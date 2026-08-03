/**
 * get_topic_digest 单元测试
 *
 * 验证：并行执行、默认 messageLimit、markRead 默认 true 行为、
 * markRead=false 不调 mark、mark 失败降级、unread 失败降级、错误处理。
 *
 * Batch F（看板任务 fdc1851b）新增守卫：
 * 投影字段缺席、recent snippet 截断 + contentTruncated、unreadCount>0 省略 recent、
 * includeRecent=true 强制携带、unread.messages 不截断、紧凑序列化。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { getTopicDigestTool } from './get-topic-digest';
import { PlatformApiClient, PlatformApiError } from '../platform-client';

jest.mock('../platform-client', () => {
  const actual = jest.requireActual('../platform-client');
  return { ...actual, PlatformApiClient: jest.fn() };
});
const MockClient = PlatformApiClient as jest.MockedClass<typeof PlatformApiClient>;

function ctx(): CustomToolContext {
  return { baseUrl: 'http://localhost:8743/api/v1' };
}

function mockRequest() {
  const mockFn = jest.fn();
  MockClient.prototype.request = mockFn;
  return mockFn;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('get_topic_digest', () => {
  // ==================== 存量用例（保持兼容） ====================

  it('默认 messageLimit=20', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'topic-1', title: 'T' })
      .mockResolvedValueOnce([]);

    await getTopicDigestTool.handler({ topicId: 'topic-1' }, ctx());

    const msgCall = request.mock.calls.find(
      ([, path]: any[]) => path === '/topics/topic-1/messages',
    );
    expect(msgCall[2].params.limit).toBe(20);
  });

  it('自定义 messageLimit 透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'topic-1' });
    request.mockResolvedValueOnce([]);

    await getTopicDigestTool.handler(
      { topicId: 'topic-1', messageLimit: 5 },
      ctx(),
    );

    const msgCall = request.mock.calls.find(
      ([, path]: any[]) => path === '/topics/topic-1/messages',
    );
    expect(msgCall[2].params.limit).toBe(5);
  });

  it('topic 失败 → failedStep=get_topic', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Topic not found' }),
    );

    const result = await getTopicDigestTool.handler(
      { topicId: 'bad' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_topic');
  });

  it('成功 → 返回 topic + recentMessages', async () => {
    const request = mockRequest();
    const topic = { id: 't1', title: 'Hello' };
    const messages = [{ id: 'm1', content: 'hi' }];

    request.mockResolvedValueOnce(topic);
    request.mockResolvedValueOnce(messages);

    const result = await getTopicDigestTool.handler(
      { topicId: 't1', markRead: false },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.topic).toEqual(topic);
    expect(body.recentMessages).toEqual(messages);
  });

  // ==================== markRead 默认 true 行为 ====================

  it('markRead 默认 true → 调 unread + mark 端点', async () => {
    const request = mockRequest();
    const topic = { id: 't1', title: 'Hello' };
    const messages = [{ id: 'm1', content: 'hi' }];
    const unread = {
      topicId: 't1',
      unreadCount: 3,
      lastReadMessageId: 'm0',
      messages: [{ id: 'm2' }, { id: 'm3' }],
      hasMore: false,
    };
    const markResult = { topicId: 't1', lastReadMessageId: 'm3', advanced: true };

    request
      .mockResolvedValueOnce(topic)
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(unread)
      .mockResolvedValueOnce(markResult);

    const result = await getTopicDigestTool.handler(
      { topicId: 't1' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.topic).toEqual(topic);
    // Batch F 起步去重：unreadCount=3 > 0 → 省略 recentMessages
    expect(body.recentMessages).toBeUndefined();
    expect(body.unread).toBeDefined();
    expect(body.unread.unreadCount).toBe(3);
    expect(body.unread.messages).toEqual([{ id: 'm2' }, { id: 'm3' }]);
    expect(body.unread.advanced).toBe(true);

    // 确认调了 mark
    const markCall = request.mock.calls.find(
      ([, path]: any[]) => path === `/topics/t1/read`,
    );
    expect(markCall).toBeDefined();
    expect(markCall[0]).toBe('POST');
  });

  // ==================== markRead=false 不调 mark ====================

  it('markRead=false → 调 unread 但不调 mark', async () => {
    const request = mockRequest();
    const topic = { id: 't1', title: 'Hello' };
    const messages = [{ id: 'm1' }];
    const unread = {
      topicId: 't1',
      unreadCount: 2,
      messages: [{ id: 'm2' }],
      hasMore: false,
    };

    request
      .mockResolvedValueOnce(topic)
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(unread);

    const result = await getTopicDigestTool.handler(
      { topicId: 't1', markRead: false },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.unread).toBeDefined();
    expect(body.unread.unreadCount).toBe(2);
    // 不应含 advanced 字段（未调 mark）
    expect(body.unread.advanced).toBeUndefined();

    // 确认未调 mark
    const markCall = request.mock.calls.find(
      ([, path]: any[]) => path === `/topics/t1/read`,
    );
    expect(markCall).toBeUndefined();
  });

  // ==================== 降级：mark 失败 ====================

  it('mark 失败 → 保留 unread 计数，省略 advanced', async () => {
    const request = mockRequest();
    const topic = { id: 't1' };
    const messages: unknown[] = [];
    const unread = {
      topicId: 't1',
      unreadCount: 5,
      messages: [{ id: 'm2' }],
      hasMore: true,
    };

    request
      .mockResolvedValueOnce(topic)
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(unread)
      .mockRejectedValueOnce(new Error('POST /read failed'));

    const result = await getTopicDigestTool.handler(
      { topicId: 't1' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.unread).toBeDefined();
    expect(body.unread.unreadCount).toBe(5);
    expect(body.unread.advanced).toBeUndefined();
  });

  // ==================== 降级：unread 失败 ====================

  it('unread 失败 → 省略 unread 字段', async () => {
    const request = mockRequest();
    const topic = { id: 't1' };
    const messages: unknown[] = [];

    request
      .mockResolvedValueOnce(topic)
      .mockResolvedValueOnce(messages)
      .mockRejectedValueOnce(new Error('GET /unread failed'));

    const result = await getTopicDigestTool.handler(
      { topicId: 't1' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.topic).toEqual(topic);
    expect(body.recentMessages).toEqual(messages);
    expect(body.unread).toBeUndefined();
  });

  // ==================== Batch F：字段投影 ====================

  it('投影：participants 无 avatarUrl/joinedAt/description，顶层无 invitedAgentIds，消息无 senderAvatar/topicId', async () => {
    const request = mockRequest();
    const topic = {
      id: 't1',
      title: 'Hello',
      invitedAgentIds: ['agent-x'],
      participants: [
        {
          participantId: 'u-1',
          participantType: 'agent',
          name: 'Alice',
          role: 'member',
          status: 'active',
          avatarUrl: '/alice.png',
          joinedAt: '2026-07-01T00:00:00.000Z',
          description: 'human UI only',
        },
      ],
    };
    const recentPage = {
      messages: [
        {
          id: 'm1',
          senderId: 'u-1',
          senderName: 'Alice',
          senderType: 'agent',
          senderAvatar: '/alice.png',
          topicId: 't1',
          content: 'hi',
          replyTo: null,
          type: 'chat',
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
      nextCursor: 'c1',
      hasMore: false,
    };
    const unread = { topicId: 't1', unreadCount: 0, messages: [], hasMore: false };

    request
      .mockResolvedValueOnce(topic)
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce(unread)
      .mockResolvedValueOnce({ advanced: false });

    const result = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    // topic 投影
    expect(body.topic.invitedAgentIds).toBeUndefined();
    expect(body.topic.participants[0]).toEqual({
      participantId: 'u-1',
      participantType: 'agent',
      name: 'Alice',
      role: 'member',
      status: 'active',
    });
    expect(body.topic.participants[0].avatarUrl).toBeUndefined();
    expect(body.topic.participants[0].joinedAt).toBeUndefined();
    expect(body.topic.participants[0].description).toBeUndefined();
    // 消息投影（分页元数据保留）
    expect(body.recentMessages.nextCursor).toBe('c1');
    expect(body.recentMessages.hasMore).toBe(false);
    expect(body.recentMessages.messages[0]).toEqual({
      id: 'm1',
      senderId: 'u-1',
      senderName: 'Alice',
      senderType: 'agent',
      content: 'hi',
      replyTo: null,
      type: 'chat',
      createdAt: '2026-07-27T00:00:00.000Z',
    });
    expect(body.recentMessages.messages[0].senderAvatar).toBeUndefined();
    expect(body.recentMessages.messages[0].topicId).toBeUndefined();
  });

  // ==================== Batch F：recent snippet 截断 ====================

  it('recent content >300 字符 → 截断到 300 + contentTruncated:true；≤300 原样不加标记', async () => {
    const request = mockRequest();
    const longContent = 'x'.repeat(500);
    const shortContent = 'y'.repeat(300);
    const recentPage = {
      messages: [
        { id: 'm1', content: longContent },
        { id: 'm2', content: shortContent },
      ],
      nextCursor: null,
      hasMore: false,
    };

    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce({ topicId: 't1', unreadCount: 0, messages: [], hasMore: false })
      .mockResolvedValueOnce({ advanced: false });

    const result = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    const [m1, m2] = body.recentMessages.messages;
    expect(m1.content).toBe('x'.repeat(300));
    expect(m1.contentTruncated).toBe(true);
    expect(m2.content).toBe(shortContent);
    expect(m2.contentTruncated).toBeUndefined();
  });

  // ==================== maxContentLength 可配置截断（get_topic_digest 新增参数） ====================

  it('maxContentLength=1000 → 500 字符不截断；1500 字符截到 1000 + contentTruncated', async () => {
    const request = mockRequest();
    const recentPage = {
      messages: [
        { id: 'm1', content: 'a'.repeat(500) },
        { id: 'm2', content: 'b'.repeat(1500) },
      ],
      nextCursor: null,
      hasMore: false,
    };

    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce({ topicId: 't1', unreadCount: 0, messages: [], hasMore: false })
      .mockResolvedValueOnce({ advanced: false });

    const result = await getTopicDigestTool.handler(
      { topicId: 't1', maxContentLength: 1000 },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    const [m1, m2] = body.recentMessages.messages;
    expect(m1.content).toBe('a'.repeat(500));
    expect(m1.contentTruncated).toBeUndefined();
    expect(m2.content).toBe('b'.repeat(1000));
    expect(m2.contentTruncated).toBe(true);
  });

  it('maxContentLength=0 → 不截断返全文、不加 contentTruncated', async () => {
    const request = mockRequest();
    const longContent = 'c'.repeat(500);
    const recentPage = {
      messages: [{ id: 'm1', content: longContent }],
      nextCursor: null,
      hasMore: false,
    };

    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce({ topicId: 't1', unreadCount: 0, messages: [], hasMore: false })
      .mockResolvedValueOnce({ advanced: false });

    const result = await getTopicDigestTool.handler(
      { topicId: 't1', maxContentLength: 0 },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.recentMessages.messages[0].content).toBe(longContent);
    expect(body.recentMessages.messages[0].contentTruncated).toBeUndefined();
  });

  it('maxContentLength 负数/非数字 → 按缺省 300 截断', async () => {
    const request = mockRequest();
    const recentPage = {
      messages: [{ id: 'm1', content: 'd'.repeat(500) }],
      nextCursor: null,
      hasMore: false,
    };

    // 场景 1：负数
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce({ topicId: 't1', unreadCount: 0, messages: [], hasMore: false })
      .mockResolvedValueOnce({ advanced: false });

    const r1 = await getTopicDigestTool.handler(
      { topicId: 't1', maxContentLength: -5 },
      ctx(),
    );
    const b1 = JSON.parse(r1.content[0].text);
    expect(b1.recentMessages.messages[0].content).toBe('d'.repeat(300));
    expect(b1.recentMessages.messages[0].contentTruncated).toBe(true);

    // 场景 2：非数字（字符串）
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce({ topicId: 't1', unreadCount: 0, messages: [], hasMore: false })
      .mockResolvedValueOnce({ advanced: false });

    const r2 = await getTopicDigestTool.handler(
      { topicId: 't1', maxContentLength: 'abc' },
      ctx(),
    );
    const b2 = JSON.parse(r2.content[0].text);
    expect(b2.recentMessages.messages[0].content).toBe('d'.repeat(300));
    expect(b2.recentMessages.messages[0].contentTruncated).toBe(true);
  });

  it('maxContentLength 超 50000 → 钳到 50000', async () => {
    const request = mockRequest();
    const recentPage = {
      messages: [{ id: 'm1', content: 'e'.repeat(50001) }],
      nextCursor: null,
      hasMore: false,
    };

    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce({ topicId: 't1', unreadCount: 0, messages: [], hasMore: false })
      .mockResolvedValueOnce({ advanced: false });

    const result = await getTopicDigestTool.handler(
      { topicId: 't1', maxContentLength: 999999 },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.recentMessages.messages[0].content).toBe('e'.repeat(50000));
    expect(body.recentMessages.messages[0].contentTruncated).toBe(true);
  });

  // ==================== Batch F：起步去重 + includeRecent ====================

  it('unreadCount>0 → 省略 recentMessages；includeRecent=true → 强制携带', async () => {
    const request = mockRequest();
    const recentPage = { messages: [{ id: 'm1', content: 'hi' }], nextCursor: null, hasMore: false };
    const unread = { topicId: 't1', unreadCount: 2, messages: [{ id: 'm2', content: 'new' }], hasMore: false };

    // 场景 1：默认（unreadCount>0）→ 省略
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce(unread)
      .mockResolvedValueOnce({ advanced: true });

    const r1 = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());
    const b1 = JSON.parse(r1.content[0].text);
    expect(b1.recentMessages).toBeUndefined();
    expect(b1.unread.unreadCount).toBe(2);

    // 场景 2：includeRecent=true → 强制携带（recent content 仍按 snippet 规则截断投影）
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce(unread)
      .mockResolvedValueOnce({ advanced: true });

    const r2 = await getTopicDigestTool.handler({ topicId: 't1', includeRecent: true }, ctx());
    const b2 = JSON.parse(r2.content[0].text);
    expect(b2.recentMessages).toBeDefined();
    expect(b2.recentMessages.messages).toEqual([{ id: 'm1', content: 'hi' }]);
    expect(b2.unread.unreadCount).toBe(2);
  });

  // ==================== Batch F：unread.messages 不截断 ====================

  it('unread.messages 保持全文（>300 也不截断、不加 contentTruncated）', async () => {
    const request = mockRequest();
    const longContent = 'z'.repeat(500);
    const unread = {
      topicId: 't1',
      unreadCount: 1,
      messages: [
        {
          id: 'm9',
          senderId: 'u-2',
          senderName: 'Bob',
          senderType: 'agent',
          senderAvatar: '/bob.png',
          topicId: 't1',
          content: longContent,
          type: 'chat',
          createdAt: '2026-07-27T01:00:00.000Z',
        },
      ],
      hasMore: false,
    };

    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce({ messages: [], nextCursor: null, hasMore: false })
      .mockResolvedValueOnce(unread)
      .mockResolvedValueOnce({ advanced: true });

    const result = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    const um = body.unread.messages[0];
    expect(um.content).toBe(longContent);
    expect(um.contentTruncated).toBeUndefined();
    // unread 消息同样剔除 senderAvatar/topicId
    expect(um.senderAvatar).toBeUndefined();
    expect(um.topicId).toBeUndefined();
  });

  // ==================== Batch F：紧凑序列化 ====================

  it('输出为紧凑 JSON（无 pretty-print 缩进）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1', title: 'Hello' })
      .mockResolvedValueOnce([{ id: 'm1', content: 'hi' }])
      .mockResolvedValueOnce({ topicId: 't1', unreadCount: 0, messages: [], hasMore: false })
      .mockResolvedValueOnce({ advanced: false });

    const result = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

    expect(result.content[0].text).not.toContain('\n  ');
    // 单行紧凑 JSON
    expect(result.content[0].text).not.toContain('\n');
  });
});
