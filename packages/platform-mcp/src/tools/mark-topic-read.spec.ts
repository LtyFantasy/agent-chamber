/**
 * mark_topic_read 单元测试
 *
 * 验证：参数透传、无 messageId 时不带 body、错误处理。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { markTopicReadTool } from './mark-topic-read';
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

describe('mark_topic_read', () => {
  it('不传 messageId → POST 无 body', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      topicId: 't1',
      lastReadMessageId: 'm99',
      advanced: true,
    });

    await markTopicReadTool.handler({ topicId: 't1' }, ctx());

    const call = request.mock.calls[0];
    expect(call[0]).toBe('POST');
    expect(call[1]).toBe('/topics/t1/read');
    // 无 body：options 为 undefined，不传 body 参数
    expect(call[2]).toBeUndefined();
  });

  it('传 messageId → POST 带 body', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      topicId: 't1',
      lastReadMessageId: 'm42',
      advanced: true,
    });

    await markTopicReadTool.handler(
      { topicId: 't1', messageId: 'm42' },
      ctx(),
    );

    const call = request.mock.calls[0];
    expect(call[0]).toBe('POST');
    expect(call[1]).toBe('/topics/t1/read');
    expect(call[2]).toEqual({ body: { messageId: 'm42' } });
  });

  it('成功 → 返回服务端响应', async () => {
    const request = mockRequest();
    const body = { topicId: 't1', lastReadMessageId: 'm1', advanced: true };
    request.mockResolvedValueOnce(body);

    const result = await markTopicReadTool.handler(
      { topicId: 't1', messageId: 'm1' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(body);
  });

  it('API 错误 → failedStep=mark_topic_read', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Topic not found' }),
    );

    const result = await markTopicReadTool.handler(
      { topicId: 'bad' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('mark_topic_read');
  });
});
