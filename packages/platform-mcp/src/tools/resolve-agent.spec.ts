/**
 * resolve_agent 单元测试
 *
 * 覆盖：topic scope、board scope、缺省扇出去重+roles 合并、
 * 层级优先级（精确胜子串）、truncated。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { resolveAgentTool } from './resolve-agent';
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

describe('resolve_agent', () => {
  it('topic scope：精确匹配', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      participants: [
        {
          participantId: 'u-1',
          participantType: 'agent',
          name: 'Alice',
          avatarUrl: null,
          role: 'member',
          status: 'active',
        },
        {
          participantId: 'u-2',
          participantType: 'agent',
          name: 'Bob',
          avatarUrl: '/bob.png',
          role: 'moderator',
          status: 'active',
        },
      ],
    });

    const result = await resolveAgentTool.handler({ name: 'alice', scopeTopicId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.candidates.length).toBe(1);
    expect(body.candidates[0].id).toBe('u-1');
    expect(body.candidates[0].name).toBe('Alice');
    expect(body.candidates[0].matchedBy).toBe('name exact');
    expect(body.candidates[0].roles[0].scope).toBe('topic');
    expect(body.candidates[0].roles[0].scopeId).toBe('t1');
    expect(body.candidates[0].roles[0].status).toBe('active');
    expect(body.count).toBe(1);
  });

  it('topic scope：大小写不敏感', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      participants: [
        {
          participantId: 'u-1',
          participantType: 'agent',
          name: 'Alice',
          role: 'member',
          status: 'active',
        },
      ],
    });

    const result = await resolveAgentTool.handler({ name: 'ALICE', scopeTopicId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.candidates.length).toBe(1);
  });

  it('topic scope：前缀匹配 > 子串', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      participants: [
        {
          participantId: 'u-1',
          participantType: 'agent',
          name: 'Alison',
          role: 'member',
          status: 'active',
        },
        {
          participantId: 'u-2',
          participantType: 'agent',
          name: 'Alistair',
          role: 'member',
          status: 'active',
        },
      ],
    });

    const result = await resolveAgentTool.handler({ name: 'Ali', scopeTopicId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.candidates.length).toBe(2);
    expect(body.candidates[0].matchedBy).toBe('name prefix');
  });

  it('board scope：精确匹配', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      members: [
        { id: 'u-1', name: 'Charlie', type: 'agent', role: 'editor' },
        { id: 'u-2', name: 'Dana', type: 'human', role: 'member' },
      ],
    });

    const result = await resolveAgentTool.handler({ name: 'Dana', scopeBoardId: 'b1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.candidates.length).toBe(1);
    expect(body.candidates[0].name).toBe('Dana');
    expect(body.candidates[0].roles[0].scope).toBe('board');
    expect(body.candidates[0].roles[0].scopeId).toBe('b1');
  });

  it('scope topic + board 同时传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      participants: [
        {
          participantId: 'u-1',
          participantType: 'agent',
          name: 'Sam',
          role: 'member',
          status: 'active',
        },
      ],
    });
    request.mockResolvedValueOnce({
      members: [{ id: 'u-1', name: 'Sam', type: 'agent', role: 'editor' }],
    });

    const result = await resolveAgentTool.handler(
      { name: 'Sam', scopeTopicId: 't1', scopeBoardId: 'b1' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.candidates.length).toBe(1);
    expect(body.candidates[0].roles.length).toBe(2); // topic + board 合并
    expect(body.candidates[0].roles.map((r: any) => r.scope).sort()).toEqual(['board', 'topic']);
  });

  it('缺省扇出：我参与的 topics + boards 去重合并', async () => {
    const request = mockRequest();
    // GET /agents/me/topics
    request.mockResolvedValueOnce({ items: [{ id: 't1' }], total: 1 });
    // GET /topics/t1
    request.mockResolvedValueOnce({
      participants: [
        {
          participantId: 'u-1',
          participantType: 'agent',
          name: 'Worker',
          role: 'member',
          status: 'active',
        },
      ],
    });
    // GET /boards
    request.mockResolvedValueOnce({ items: [{ id: 'b1' }], total: 1 });
    // GET /boards/b1
    request.mockResolvedValueOnce({
      members: [
        { id: 'u-1', name: 'Worker', type: 'agent', role: 'editor' },
        { id: 'u-2', name: 'Reviewer', type: 'agent', role: 'member' },
      ],
    });

    const result = await resolveAgentTool.handler({ name: 'Worker' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.candidates.length).toBe(1);
    expect(body.candidates[0].id).toBe('u-1');
    // roles 合并：topic + board
    expect(body.candidates[0].roles.length).toBe(2);
  });

  it('缺省扇出无命中 → 返回空候选', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 't1' }], total: 1 });
    request.mockResolvedValueOnce({
      participants: [
        {
          participantId: 'u-1',
          participantType: 'agent',
          name: 'Alice',
          role: 'member',
          status: 'active',
        },
      ],
    });
    request.mockResolvedValueOnce({ items: [], total: 0 });

    const result = await resolveAgentTool.handler({ name: 'NoSuchUser' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.candidates.length).toBe(0);
    expect(body.count).toBe(0);
  });

  it('truncated：topic 数量超过 limit', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 't1' }], total: 20 }); // total > limit
    // 不调 boards（因为 topic 请求就触发了 truncated）
    request.mockResolvedValueOnce({
      participants: [],
    });
    request.mockResolvedValueOnce({ items: [], total: 0 });

    const result = await resolveAgentTool.handler({ name: 'x', limit: 5 }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.truncated).toBe(true);
  });

  it('HTTP 错误：topic scope 失败 → isError', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Topic not found' }),
    );

    const result = await resolveAgentTool.handler({ name: 'x', scopeTopicId: 't1' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_topic');
  });

  it('HTTP 错误：board scope 失败 → isError', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Board not found' }),
    );

    const result = await resolveAgentTool.handler({ name: 'x', scopeBoardId: 'b1' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_board');
  });

  it('子串匹配（无精确/前缀命中时）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      participants: [
        {
          participantId: 'u-1',
          participantType: 'agent',
          name: 'FrontendDev',
          role: 'member',
          status: 'active',
        },
        {
          participantId: 'u-2',
          participantType: 'agent',
          name: 'BackendDev',
          role: 'member',
          status: 'active',
        },
      ],
    });

    const result = await resolveAgentTool.handler({ name: 'dev', scopeTopicId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.candidates.length).toBe(2);
    expect(body.candidates[0].matchedBy).toBe('name substring');
  });

  // ==================== Batch F：candidates 投影 ====================

  it('Batch F：candidates 不携带 avatarUrl（topic/board 来源均剔除）', async () => {
    const request = mockRequest();
    // topic 来源（participant 带 avatarUrl）
    request.mockResolvedValueOnce({
      participants: [
        {
          participantId: 'u-1',
          participantType: 'agent',
          name: 'Sam',
          role: 'member',
          status: 'active',
          avatarUrl: '/sam.png',
        },
      ],
    });
    // board 来源（member 带 avatarUrl）
    request.mockResolvedValueOnce({
      members: [{ id: 'u-1', name: 'Sam', type: 'agent', role: 'editor', avatarUrl: '/sam.png' }],
    });

    const result = await resolveAgentTool.handler(
      { name: 'Sam', scopeTopicId: 't1', scopeBoardId: 'b1' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.candidates.length).toBe(1);
    expect(body.candidates[0].avatarUrl).toBeUndefined();
    expect(body.candidates[0]).toEqual({
      id: 'u-1',
      name: 'Sam',
      type: 'agent',
      roles: [
        { scope: 'topic', scopeId: 't1', role: 'member', status: 'active' },
        { scope: 'board', scopeId: 'b1', role: 'editor' },
      ],
      matchedBy: 'name exact',
    });
    // 紧凑序列化（无 pretty-print 缩进）
    expect(result.content[0].text).not.toContain('\n  ');
  });

  describe('directory fallback', () => {
    it('已知宇宙 0 命中 → 兜底查 directory', async () => {
      const request = mockRequest();
      // 缺省扇出：我参与的 topics 有 1 个，但里面没有匹配的人
      request.mockResolvedValueOnce({ items: [{ id: 't1' }], total: 1 });
      request.mockResolvedValueOnce({
        participants: [
          {
            participantId: 'u-1',
            participantType: 'agent',
            name: 'Alice',
            role: 'member',
            status: 'active',
          },
        ],
      });
      request.mockResolvedValueOnce({ items: [], total: 0 });
      // directory 兜底命中
      request.mockResolvedValueOnce({
        items: [
          {
            id: 'd-1',
            name: 'Bob',
            type: 'agent',
            avatarUrl: '/bob.png',
            capabilities: ['chat'],
            status: 'active',
          },
        ],
      });

      const result = await resolveAgentTool.handler({ name: 'Bob' }, ctx());

      const body = JSON.parse(result.content[0].text);
      expect(body.candidates.length).toBe(1);
      expect(body.candidates[0].id).toBe('d-1');
      expect(body.candidates[0].name).toBe('Bob');
      expect(body.candidates[0].type).toBe('agent');
      // Batch F：directory 兜底候选不携带 avatarUrl（人类 UI 字段）
      expect(body.candidates[0].avatarUrl).toBeUndefined();
      expect(body.candidates[0].matchedBy).toBe('directory');
      expect(body.candidates[0].roles).toEqual([]);
      expect(body.count).toBe(1);
    });

    it('已知宇宙有命中 → 不查 directory', async () => {
      const request = mockRequest();
      request.mockResolvedValueOnce({
        participants: [
          {
            participantId: 'u-1',
            participantType: 'agent',
            name: 'Alice',
            role: 'member',
            status: 'active',
          },
        ],
      });

      const result = await resolveAgentTool.handler({ name: 'Alice', scopeTopicId: 't1' }, ctx());

      const body = JSON.parse(result.content[0].text);
      expect(body.candidates.length).toBe(1);
      expect(body.candidates[0].matchedBy).toBe('name exact');
      // directory 不应被调用（共 1 次 request，即 topic）
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('已知宇宙 + directory 双 0 命中 → 返回空候选', async () => {
      const request = mockRequest();
      request.mockResolvedValueOnce({ items: [{ id: 't1' }], total: 1 });
      request.mockResolvedValueOnce({
        participants: [
          {
            participantId: 'u-1',
            participantType: 'agent',
            name: 'Alice',
            role: 'member',
            status: 'active',
          },
        ],
      });
      request.mockResolvedValueOnce({ items: [], total: 0 });
      // directory 也无结果
      request.mockResolvedValueOnce({ items: [], total: 0 });

      const result = await resolveAgentTool.handler({ name: 'NoSuchAgent' }, ctx());

      const body = JSON.parse(result.content[0].text);
      expect(body.candidates.length).toBe(0);
      expect(body.count).toBe(0);
    });

    it('directory HTTP 失败 → 静默忽略，返回 0 候选', async () => {
      const request = mockRequest();
      request.mockResolvedValueOnce({ items: [{ id: 't1' }], total: 1 });
      request.mockResolvedValueOnce({
        participants: [
          {
            participantId: 'u-1',
            participantType: 'agent',
            name: 'Alice',
            role: 'member',
            status: 'active',
          },
        ],
      });
      request.mockResolvedValueOnce({ items: [], total: 0 });
      // directory 请求失败
      request.mockRejectedValueOnce(
        new PlatformApiError({ status: 500, message: 'Internal Server Error' }),
      );

      const result = await resolveAgentTool.handler({ name: 'NoSuchAgent' }, ctx());

      const body = JSON.parse(result.content[0].text);
      expect(body.candidates.length).toBe(0);
      expect(body.count).toBe(0);
      expect(result.isError).toBeUndefined();
    });
  });
});
