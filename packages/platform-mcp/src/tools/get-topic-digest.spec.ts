/**
 * get_topic_digest 单元测试
 *
 * 验证：并行执行、默认 messageLimit、markRead 默认 true 行为、
 * markRead=false 不调 mark、mark 失败降级、unread 失败降级、错误处理。
 *
 * Batch F（看板任务 fdc1851b）新增守卫：
 * 投影字段缺席、recent snippet 截断 + contentTruncated、unreadCount>0 省略 recent、
 * includeRecent=true 强制携带、unread.messages 不截断、紧凑序列化。
 * B2：recent/unread 原样保留附件发现元数据，正文截断与精确标读不丢附件。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import type { MessageAttachment } from '@agent-chamber/shared';
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

/** 同一组上游消息覆盖附件发现边界；URL 仅为元数据夹具，不访问媒体端点。 */
function attachmentMessages() {
  const permanent: MessageAttachment = {
    id: 'attachment-permanent',
    originalName: 'report.pdf',
    mimeType: 'application/octet-stream',
    clientMimeType: 'application/pdf',
    sizeBytes: 8192,
    expiresAt: null,
    expired: false,
    contentUrl: '/api/v1/attachments/attachment-permanent/content',
  };
  const expired: MessageAttachment = {
    id: 'attachment-expired',
    originalName: 'expired.png',
    mimeType: 'image/png',
    clientMimeType: null,
    sizeBytes: 2048,
    expiresAt: '2026-10-01T00:00:00.000Z',
    expired: true,
    contentUrl: '/api/v1/attachments/attachment-expired/content',
    thumbnailContentUrl: '/api/v1/attachments/attachment-expired/thumbnail',
  };
  const thumbnail: MessageAttachment = {
    id: 'attachment-thumbnail',
    originalName: 'preview.webp',
    mimeType: 'image/webp',
    clientMimeType: 'image/webp',
    sizeBytes: 4096,
    expiresAt: '2026-11-01T00:00:00.000Z',
    expired: false,
    contentUrl: '/api/v1/attachments/attachment-thumbnail/content',
    thumbnailContentUrl: '/api/v1/attachments/attachment-thumbnail/thumbnail',
  };
  // 正常每消息上限为 9；不因正文截断或已读推进而裁掉后面的发现条目。
  const attachments: MessageAttachment[] = [
    permanent,
    expired,
    thumbnail,
    ...Array.from({ length: 6 }, (_, index) => ({
      ...permanent,
      id: `attachment-extra-${index}`,
      contentUrl: `/api/v1/attachments/attachment-extra-${index}/content`,
    })),
  ];
  return [
    { id: 'm-legacy', content: 'old backend omits attachments' },
    { id: 'm-empty', content: 'no attachments', attachments: [] },
    { id: 'm-report', content: '报告摘要'.repeat(125), attachments },
    { id: 'm-attachment-only', content: '', attachments: [thumbnail] },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('get_topic_digest', () => {
  // ==================== 存量用例（保持兼容） ====================

  it('默认 messageLimit=20', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'topic-1', title: 'T' }).mockResolvedValueOnce([]);

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

    await getTopicDigestTool.handler({ topicId: 'topic-1', messageLimit: 5 }, ctx());

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

    const result = await getTopicDigestTool.handler({ topicId: 'bad' }, ctx());

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

    const result = await getTopicDigestTool.handler({ topicId: 't1', markRead: false }, ctx());

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

    const result = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

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
    const markCall = request.mock.calls.find(([, path]: any[]) => path === `/topics/t1/read`);
    expect(markCall).toBeDefined();
    expect(markCall[0]).toBe('POST');
  });

  // ==================== D6 markRead 精确化（v1.96.0-dev） ====================

  it('D6 markRead=true → mark 只推进到**本次返回的最后一条未读**（不是话题最新）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({
        topicId: 't1',
        unreadCount: 5,
        messages: [{ id: 'm2' }, { id: 'm3' }], // 只返回 2 条（余量 3 条留给下一轮 drain）
        hasMore: true,
      })
      .mockResolvedValueOnce({ topicId: 't1', lastReadMessageId: 'm3', advanced: true });

    await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

    const markCall = request.mock.calls.find(([, path]: any[]) => path === '/topics/t1/read');
    expect(markCall).toBeDefined();
    // 精确推进：body.messageId = 列表最后一条（旧行为是不传 body = 标到最新 → 吞掉余量）
    expect(markCall[2]).toEqual({ body: { messageId: 'm3' } });
  });

  it('D6 未读列表为空 → **跳过** mark（没有可推进的目标，不凭空清零）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([{ id: 'm1' }])
      .mockResolvedValueOnce({
        topicId: 't1',
        unreadCount: 0,
        messages: [],
        hasMore: false,
      });

    const result = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

    // 未调 mark（旧行为会不传 messageId 标到最新 = 把「没读到任何未读」当成「全读完了」）
    const markCall = request.mock.calls.find(([, path]: any[]) => path === '/topics/t1/read');
    expect(markCall).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.unread.advanced).toBeUndefined();
    // unreadCount=0 → recentMessages 不被去重省略
    expect(body.recentMessages).toBeDefined();
  });

  it('D4 unread 响应的 mentionsOnly 透传（digest 形状枚举含该字段）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({
        topicId: 't1',
        unreadCount: 1,
        messages: [{ id: 'm9' }],
        hasMore: false,
        mentionsOnly: true,
      })
      .mockResolvedValueOnce({ topicId: 't1', advanced: true });

    const result = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.unread.mentionsOnly).toBe(true);
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

    const result = await getTopicDigestTool.handler({ topicId: 't1', markRead: false }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.unread).toBeDefined();
    expect(body.unread.unreadCount).toBe(2);
    // 不应含 advanced 字段（未调 mark）
    expect(body.unread.advanced).toBeUndefined();

    // 确认未调 mark
    const markCall = request.mock.calls.find(([, path]: any[]) => path === `/topics/t1/read`);
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

    const result = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

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

    const result = await getTopicDigestTool.handler({ topicId: 't1' }, ctx());

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

  it.each(['recentMessages', 'unread'] as const)(
    'B2 %s 保留完整附件投影，正文与分页/精确标读合同不变',
    async (section) => {
      const request = mockRequest();
      const messages = attachmentMessages();
      const snapshot = JSON.parse(JSON.stringify(messages));
      const recentPage = { messages, nextCursor: 'm-legacy', hasMore: true };
      const unread = {
        topicId: 't1',
        unreadCount: 7,
        lastReadMessageId: 'm-before',
        messages,
        hasMore: true,
        mentionsOnly: true,
      };
      request
        .mockResolvedValueOnce({ id: 't1' })
        .mockResolvedValueOnce(recentPage)
        .mockResolvedValueOnce(unread)
        .mockResolvedValueOnce({ topicId: 't1', advanced: true });

      const result = await getTopicDigestTool.handler(
        { topicId: 't1', messageLimit: 4, includeRecent: section === 'recentMessages' },
        ctx(),
      );

      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      const expectedMessages =
        section === 'recentMessages'
          ? [
              messages[0],
              messages[1],
              { ...messages[2], content: '报告摘要'.repeat(75), contentTruncated: true },
              messages[3],
            ]
          : messages;
      expect(body[section].messages).toEqual(expectedMessages);
      expect(body[section].messages[0]).not.toHaveProperty('attachments');
      expect(body[section].messages[1].attachments).toEqual([]);
      expect(body[section].messages[2].attachments).toHaveLength(9);
      expect(body[section].messages[2].attachments[0]).not.toHaveProperty('thumbnailContentUrl');
      expect(body[section].messages[2].attachments[0].expiresAt).toBeNull();
      expect(body[section].messages[2].attachments[1].expired).toBe(true);
      expect(body[section].messages[3].content).toBe('');
      // unread 元数据和全文原样保留，默认 markRead 仍只处理本轮返回的 4 条，余量 3 条。
      expect(body.unread).toEqual({ ...unread, advanced: true });
      if (section === 'recentMessages') {
        expect(body.recentMessages).toEqual({ ...recentPage, messages: expectedMessages });
      } else {
        expect(body).not.toHaveProperty('recentMessages');
      }
      expect(request.mock.calls).toEqual([
        ['GET', '/topics/t1'],
        ['GET', '/topics/t1/messages', { params: { limit: 4 } }],
        ['GET', '/topics/t1/messages/unread', { params: { limit: 4 } }],
        ['POST', '/topics/t1/read', { body: { messageId: 'm-attachment-only' } }],
      ]);
      expect(messages).toEqual(snapshot);
    },
  );

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

    const result = await getTopicDigestTool.handler({ topicId: 't1', maxContentLength: 0 }, ctx());

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
    // 注（D6）：unreadCount=0 且 messages 为空 → markRead **跳过** mark（无可推进目标），
    // 故这里**不再**预置第 4 个 mock（多出来的会串到下一次调用的响应队列里）
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce({ topicId: 't1', unreadCount: 0, messages: [], hasMore: false });

    const r1 = await getTopicDigestTool.handler({ topicId: 't1', maxContentLength: -5 }, ctx());
    const b1 = JSON.parse(r1.content[0].text);
    expect(b1.recentMessages.messages[0].content).toBe('d'.repeat(300));
    expect(b1.recentMessages.messages[0].contentTruncated).toBe(true);

    // 场景 2：非数字（字符串）——同上，空未读列表不触发 mark
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce(recentPage)
      .mockResolvedValueOnce({ topicId: 't1', unreadCount: 0, messages: [], hasMore: false });

    const r2 = await getTopicDigestTool.handler({ topicId: 't1', maxContentLength: 'abc' }, ctx());
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
    const recentPage = {
      messages: [{ id: 'm1', content: 'hi' }],
      nextCursor: null,
      hasMore: false,
    };
    const unread = {
      topicId: 't1',
      unreadCount: 2,
      messages: [{ id: 'm2', content: 'new' }],
      hasMore: false,
    };

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
