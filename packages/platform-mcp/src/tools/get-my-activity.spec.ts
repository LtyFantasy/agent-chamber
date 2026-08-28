/**
 * get_my_activity 单元测试
 *
 * 验证：limit 默认/clamp、过滤参数透传、成功响应、错误处理。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { getMyActivityTool } from './get-my-activity';
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

describe('get_my_activity', () => {
  it('无参数 → GET /activity-logs 带 pageSize=20（limit 缺省）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [], total: 0, scope: ['me'] });

    await getMyActivityTool.handler({}, ctx());

    const call = request.mock.calls[0];
    expect(call[0]).toBe('GET');
    expect(call[1]).toBe('/activity-logs');
    expect(call[2]).toEqual({ params: { pageSize: 20 } });
  });

  it('limit 传入 → clamp 到 [1,50]', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [], total: 0, scope: ['me'] });

    await getMyActivityTool.handler({ limit: 5 }, ctx());
    expect(request.mock.calls[0][2]).toEqual({ params: { pageSize: 5 } });

    // 超上限钳到 50
    await getMyActivityTool.handler({ limit: 999 }, ctx());
    expect(request.mock.calls[1][2]).toEqual({ params: { pageSize: 50 } });

    // 低于下限钳到 1
    await getMyActivityTool.handler({ limit: 0 }, ctx());
    expect(request.mock.calls[2][2]).toEqual({ params: { pageSize: 1 } });

    // 非法值回退缺省 20
    await getMyActivityTool.handler({ limit: 'abc' }, ctx());
    expect(request.mock.calls[3][2]).toEqual({ params: { pageSize: 20 } });
  });

  it('过滤参数透传：entityType/action/from/to 仅非 undefined 携带', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [], total: 0, scope: ['me'] });

    await getMyActivityTool.handler(
      {
        entityType: 'message',
        action: 'create',
        from: '2026-08-27T08:36:00+08:00',
        to: '2026-08-27T23:59:59+08:00',
      },
      ctx(),
    );

    expect(request.mock.calls[0][2]).toEqual({
      params: {
        pageSize: 20,
        entityType: 'message',
        action: 'create',
        from: '2026-08-27T08:36:00+08:00',
        to: '2026-08-27T23:59:59+08:00',
      },
    });
  });

  it('成功 → 返回服务端响应（含 total/hasNext/scope 翻页指导字段）', async () => {
    const request = mockRequest();
    const body = {
      items: [{ id: 'l1', action: 'create', actorName: 'me' }],
      total: 25,
      page: 1,
      pageSize: 20,
      totalPages: 2,
      hasNext: true,
      hasPrev: false,
      scope: ['agent-1'],
    };
    request.mockResolvedValueOnce(body);

    const result = await getMyActivityTool.handler({}, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(body);
  });

  it('API 错误 → failedStep=get_my_activity，状态码透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 400, code: 'BAD_REQUEST', message: 'Invalid date format' }),
    );

    const result = await getMyActivityTool.handler({ from: 'not-a-date' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_my_activity');
    expect(body.status).toBe(400);
  });

  it('工具 description 固化防误导两句（覆盖起点 + 空结果≠未发生）', () => {
    const desc = getMyActivityTool.tool.description;
    expect(desc).toContain('only operations AFTER this feature was deployed are recorded');
    expect(desc).toContain('An empty result does NOT mean nothing happened');
  });
});
