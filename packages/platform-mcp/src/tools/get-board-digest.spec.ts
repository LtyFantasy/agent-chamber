/**
 * get_board_digest 单元测试
 *
 * 覆盖：boardId 直查、boardName 三层匹配（精确/前缀/子串/大小写不敏感）、
 * 二缺一报错、0 候选 → isError+candidates、>1 候选 → isError+candidates、
 * limit/includeDescription 透传、后端错误透传、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { getBoardDigestTool } from './get-board-digest';
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

describe('get_board_digest', () => {
  it('boardId 直查：跳过名称解析，返回 digest', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      boardId: 'board-1',
      boardName: 'Agent Chamber',
      taskCount: 8,
      truncated: false,
    });

    const result = await getBoardDigestTool.handler({ boardId: 'board-1' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.boardId).toBe('board-1');
    expect(body.taskCount).toBe(8);

    // 单次请求：直接打 digest 端点
    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0];
    expect(call[0]).toBe('GET');
    expect(call[1]).toContain('board-1/digest');
  });

  it('boardName 精确匹配 → 解析后查 digest', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'b1', name: 'Agent Chamber' },
        { id: 'b2', name: 'Other Board' },
      ],
    });
    request.mockResolvedValueOnce({ boardId: 'b1', boardName: 'Agent Chamber', truncated: false });

    const result = await getBoardDigestTool.handler({ boardName: 'Agent Chamber' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.boardId).toBe('b1');
  });

  it('boardName 前缀匹配', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'b1', name: 'Agent Chamber' },
        { id: 'b2', name: 'Other' },
      ],
    });
    request.mockResolvedValueOnce({ boardId: 'b1', truncated: false });

    const result = await getBoardDigestTool.handler({ boardName: 'Agent' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).boardId).toBe('b1');
  });

  it('boardName 子串匹配 + 大小写不敏感', async () => {
    const request = mockRequest();
    // fixture 必须用品牌中立名：oss-rebrand 会改写品牌词（含本注释若带品牌词），
    // 断言若依赖品牌词子串（如 'swarm'）会在快照仓测试时失配。
    request.mockResolvedValueOnce({
      items: [
        { id: 'b1', name: 'Alpha Project Board' },
        { id: 'b2', name: 'Other' },
      ],
    });
    request.mockResolvedValueOnce({ boardId: 'b1', truncated: false });

    const result = await getBoardDigestTool.handler({ boardName: 'project' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).boardId).toBe('b1');
  });

  it('boardId 与 boardName 同时给出 → boardId 优先，不触发名称解析', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ boardId: 'b1', truncated: false });

    const result = await getBoardDigestTool.handler(
      { boardId: 'b1', boardName: 'Something Else' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toContain('b1/digest');
  });

  it('boardId/boardName 都缺 → isError（二缺一契约）', async () => {
    const request = mockRequest();
    const result = await getBoardDigestTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_board');
    expect(request).not.toHaveBeenCalled();
  });

  it('boardName 0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'b1', name: 'Only Board' }],
    });

    const result = await getBoardDigestTool.handler({ boardName: 'Nope' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_board');
    expect(body.isAmbiguous).toBe(false);
    expect(body.availableNames).toEqual(['Only Board']);
  });

  it('boardName >1 候选 → isError + candidates（绝不静默挑选）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'b1', name: 'Project A' },
        { id: 'b2', name: 'Project B' },
      ],
    });

    const result = await getBoardDigestTool.handler({ boardName: 'Project' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_board');
    expect(body.isAmbiguous).toBe(true);
    expect(body.layer).toBe('prefix');
    expect(body.candidates).toHaveLength(2);
  });

  it('limit 参数与 includeDescription 透传到 digest 请求', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ boardId: 'b1', truncated: false });

    const result = await getBoardDigestTool.handler(
      {
        boardId: 'b1',
        openLimit: 3,
        doneLimit: 1,
        riskLimit: 2,
        docsLimit: 0,
        includeDescription: false,
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const call = request.mock.calls[0];
    expect(call[2].params).toEqual({
      openLimit: 3,
      doneLimit: 1,
      riskLimit: 2,
      docsLimit: 0,
      includeDescription: false,
    });
  });

  it('versionLimit 透传到 digest 请求（v1.42 versions.history 上限）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      boardId: 'b1',
      versions: { production: null, development: null, history: [], total: 0 },
      metrics: null,
      truncated: false,
    });

    const result = await getBoardDigestTool.handler(
      { boardId: 'b1', openLimit: 3, versionLimit: 8 },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.versions.total).toBe(0);
    expect(body.metrics).toBeNull();
    const call = request.mock.calls[0];
    expect(call[2].params).toEqual({ openLimit: 3, versionLimit: 8 });
  });

  it('tool description 声明 versions/metrics 段语义（production=生产版、development=开发版）', () => {
    const description = getBoardDigestTool.tool.description;

    expect(description).toContain('versions');
    expect(description).toContain('production=currently deployed version');
    expect(description).toContain('development=in-development version');
    expect(description).toContain('metrics');
    expect(description).toContain('test baselines');
  });

  it('未传 limit 时不携带空值参数（请求干净）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ boardId: 'b1', truncated: false });

    await getBoardDigestTool.handler({ boardId: 'b1' }, ctx());

    const call = request.mock.calls[0];
    expect(call[2].params).toEqual({});
  });

  it('后端 404 → isError + failedStep get_board_digest + status 透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 404,
        code: 20004,
        message: 'Board not found',
      }),
    );

    const result = await getBoardDigestTool.handler({ boardId: 'board-404' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_board_digest');
    expect(body.status).toBe(404);
    expect(body.code).toBe(20004);
  });

  it('紧凑 JSON（无 pretty-print 缩进）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ boardId: 'b1', lists: [], truncated: false });

    const result = await getBoardDigestTool.handler({ boardId: 'b1' }, ctx());

    expect(result.content[0].text).not.toContain('\n  ');
  });
});
