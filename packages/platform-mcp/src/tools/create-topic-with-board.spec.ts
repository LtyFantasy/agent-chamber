/**
 * create_topic_with_board 单元测试
 *
 * 验证：成功路径、board 失败部分成功、topic 失败、默认值、visibility 默认 private。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { createTopicWithBoardTool } from './create-topic-with-board';
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

describe('create_topic_with_board', () => {
  it('成功：创建 topic → 创建 board，返回 topic + board', async () => {
    const request = mockRequest();
    const topic = { id: 't1', title: 'New Topic' };
    const board = { id: 'b1', name: 'New Topic' };

    request.mockResolvedValueOnce(topic).mockResolvedValueOnce(board);

    const result = await createTopicWithBoardTool.handler(
      { title: 'New Topic' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.topic).toEqual(topic);
    expect(body.board).toEqual(board);

    // 验证 board 的 topicId 关联正确
    const boardCall = request.mock.calls[1];
    expect(boardCall[2].body.topicId).toBe('t1');
  });

  it('board 失败 → 部分成功：isError=true + failedStep=create_board + topic 已返回', async () => {
    const request = mockRequest();
    const topic = { id: 't1', title: 'New Topic' };

    request
      .mockResolvedValueOnce(topic)
      .mockRejectedValueOnce(
        new PlatformApiError({ status: 400, code: 3001, message: 'Board creation failed' }),
      );

    const result = await createTopicWithBoardTool.handler(
      { title: 'New Topic' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('create_board');
    expect(body.topic).toEqual(topic);
    expect(body.status).toBe(400);
    expect(body.code).toBe(3001);
  });

  it('topic 失败 → isError + failedStep=create_topic，不调 board', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 401, message: 'Unauthorized' }),
    );

    const result = await createTopicWithBoardTool.handler(
      { title: 'X' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('create_topic');
    // board 不应被调用（只有一次 request）
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('visibility 未传时默认 private（显式传值覆盖服务端 open 默认）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce({ id: 'b1' });

    await createTopicWithBoardTool.handler({ title: 'T' }, ctx());

    const topicBody = request.mock.calls[0][2].body;
    expect(topicBody.visibility).toBe('private');
  });

  it('visibility 显式传 open 时透传', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce({ id: 'b1' });

    await createTopicWithBoardTool.handler(
      { title: 'T', visibility: 'open' },
      ctx(),
    );

    const topicBody = request.mock.calls[0][2].body;
    expect(topicBody.visibility).toBe('open');
  });

  it('boardName 未传时默认为 title', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce({ id: 'b1' });

    await createTopicWithBoardTool.handler({ title: 'My Project' }, ctx());

    const boardBody = request.mock.calls[1][2].body;
    expect(boardBody.name).toBe('My Project');
  });

  it('boardName 显式传值时使用之', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce({ id: 'b1' });

    await createTopicWithBoardTool.handler(
      { title: 'My Project', boardName: 'Custom Board' },
      ctx(),
    );

    const boardBody = request.mock.calls[1][2].body;
    expect(boardBody.name).toBe('Custom Board');
  });

  it('lists 未传时默认三列', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce({ id: 'b1' });

    await createTopicWithBoardTool.handler({ title: 'T' }, ctx());

    const boardBody = request.mock.calls[1][2].body;
    expect(boardBody.lists).toEqual([
      { name: 'backlog' },
      { name: 'in_progress' },
      { name: 'done' },
    ]);
  });

  it('lists 自定义时透传', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce({ id: 'b1' });

    const custom = [{ name: 'todo', mappedStatus: 'todo' }, { name: 'done', mappedStatus: 'done' }];
    await createTopicWithBoardTool.handler(
      { title: 'T', lists: custom },
      ctx(),
    );

    const boardBody = request.mock.calls[1][2].body;
    expect(boardBody.lists).toEqual(custom);
  });
});
