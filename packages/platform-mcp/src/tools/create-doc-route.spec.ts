/**
 * create_doc_route 单元测试（v1.55 任务 T3）
 *
 * 覆盖：happy path（space 解析 → POST 透传 DTO 字段）、空值不携带、
 * 0 候选/多候选 space 解析失败、上游写时校验 400 透传、list_doc_spaces 失败。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { createDocRouteTool } from './create-doc-route';
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

const createdRoute = {
  id: 'route-1',
  spaceId: 'sp-1',
  intent: '我要了解系统架构',
  primaryDocId: 'doc-1',
  sortOrder: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('create_doc_route', () => {
  it('happy path：space 三层匹配 → POST /doc-spaces/:id/routes 透传 DTO 字段', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(createdRoute);

    const result = await createDocRouteTool.handler(
      {
        spaceName: 'My Docs',
        intent: '我要了解系统架构',
        category: 'architecture',
        primaryDocId: 'doc-1',
        primaryHeadingPath: '架构 § 总览',
        codeEntry: 'apps/backend/src/app.module.ts',
        sortOrder: 2,
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).id).toBe('route-1');

    const postCall = request.mock.calls[1];
    expect(postCall[0]).toBe('POST');
    expect(postCall[1]).toBe('/doc-spaces/sp-1/routes');
    expect(postCall[2].body).toEqual({
      intent: '我要了解系统架构',
      category: 'architecture',
      primaryDocId: 'doc-1',
      primaryHeadingPath: '架构 § 总览',
      codeEntry: 'apps/backend/src/app.module.ts',
      sortOrder: 2,
    });
  });

  it('codeEntryType "pattern" 透传（T5：glob 泛化写法豁免 recheck 精确校验）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(createdRoute);

    await createDocRouteTool.handler(
      {
        spaceName: 'My Docs',
        intent: '我要找到页面文件',
        primaryDocId: 'doc-1',
        codeEntry: 'apps/web/app/**' + '/page.tsx',
        codeEntryType: 'pattern',
      },
      ctx(),
    );

    const postCall = request.mock.calls[1];
    expect(postCall[2].body).toEqual({
      intent: '我要找到页面文件',
      primaryDocId: 'doc-1',
      codeEntry: 'apps/web/app/**' + '/page.tsx',
      codeEntryType: 'pattern',
    });
  });

  it('空值不携带（undefined/null 字段不进 body，保持请求干净）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(createdRoute);

    await createDocRouteTool.handler(
      {
        spaceName: 'My Docs',
        intent: '我要了解系统架构',
        primaryDocId: 'doc-1',
        secondaryDocId: null,
        sortOrder: undefined,
      },
      ctx(),
    );

    const postCall = request.mock.calls[1];
    expect(postCall[2].body).toEqual({ intent: '我要了解系统架构', primaryDocId: 'doc-1' });
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }],
    });

    const result = await createDocRouteTool.handler(
      { spaceName: 'Ghost', intent: 'x', primaryDocId: 'doc-1' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Alpha']);
  });

  it('>1 候选 → isError + candidates（绝不静默挑选）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Docs A', slug: 'docs-a' },
        { id: 'sp-2', name: 'Docs B', slug: 'docs-b' },
      ],
    });

    const result = await createDocRouteTool.handler(
      { spaceName: 'Docs', intent: 'x', primaryDocId: 'doc-1' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.isAmbiguous).toBe(true);
    expect(body.candidates).toHaveLength(2);
  });

  it('上游写时校验 400 结构化透传（headingPath 不可解析，铁律 #9 不包装）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 400,
        code: 10006,
        message: "headingPath '不存在的节' does not resolve in primary doc",
      }),
    );

    const result = await createDocRouteTool.handler(
      {
        spaceName: 'My Docs',
        intent: 'x',
        primaryDocId: 'doc-1',
        primaryHeadingPath: '不存在的节',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('create_doc_route');
    expect(body.status).toBe(400);
    expect(body.code).toBe(10006);
  });

  it('list_doc_spaces 失败 → isError list_doc_spaces', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));

    const result = await createDocRouteTool.handler(
      { spaceName: 'My Docs', intent: 'x', primaryDocId: 'doc-1' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).failedStep).toBe('list_doc_spaces');
  });
});
