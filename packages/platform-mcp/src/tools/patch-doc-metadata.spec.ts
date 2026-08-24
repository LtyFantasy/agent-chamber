/**
 * patch_doc_metadata 单元测试（v1.61.0 批次 2，Board 任务 201ae04f）
 *
 * 覆盖：双通道定位（spaceName+path / docId）、缺参数校验、expectedContentHash
 * 必填快速失败、resolve 失败、path 定位失败、Partial 三态 body 直透（缺席字段
 * 不进 body / tags: [] 直透 / null 直透交服务端 400）、allowCreateCategory 透传、
 * PATCH HTTP 失败、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { patchDocMetadataTool } from './patch-doc-metadata';
import { PlatformApiClient } from '../platform-client';

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

describe('patch_doc_metadata', () => {
  const HASH = 'a'.repeat(64);

  it('description 契约回归：三态语义 + 必填乐观锁 + category 解析开关', () => {
    const desc = patchDocMetadataTool.tool.description;
    expect(desc).toContain('METADATA ONLY');
    expect(desc).toContain('expectedContentHash is REQUIRED');
    expect(desc).toContain('tags: [] = CLEAR');
    expect(desc).toContain('DOC_CATEGORY_NOT_FOUND');
    expect(desc).toContain('allowCreateCategory');
    expect(desc).toContain('DOC_SOURCE_MISMATCH');
    // inputSchema：expectedContentHash 必填，元数据字段全部可选
    const schema = patchDocMetadataTool.tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['expectedContentHash']);
    for (const field of [
      'title',
      'summary',
      'docType',
      'tags',
      'category',
      'allowCreateCategory',
    ]) {
      expect(schema.properties[field]).toBeDefined();
    }
  });

  it('happy path（spaceName + path 双通道定位 + title patch）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce({
      docId: 'd1',
      path: 'docs/a.md',
      contentHash: HASH,
      changedFields: ['title'],
      unchanged: false,
      metadata: {
        title: '新标题',
        summary: null,
        docType: null,
        tags: [],
        categoryId: null,
        categoryName: null,
      },
    });

    const result = await patchDocMetadataTool.handler(
      { spaceName: 'My Docs', path: 'docs/a.md', title: '新标题', expectedContentHash: HASH },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.changedFields).toEqual(['title']);
    expect(body.unchanged).toBe(false);

    // 验证 PATCH /docs/:id/metadata 调用与 body 直透
    const patchCall = request.mock.calls[2];
    expect(patchCall[0]).toBe('PATCH');
    expect(patchCall[1]).toContain('/docs/d1/metadata');
    expect(patchCall[2]).toMatchObject({
      body: { title: '新标题', expectedContentHash: HASH },
    });
  });

  it('happy path（docId 直接定位，不调 list spaces）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd2',
      path: 'docs/x.md',
      contentHash: HASH,
      changedFields: ['tags'],
      unchanged: false,
      metadata: {
        title: 'X',
        summary: null,
        docType: null,
        tags: [],
        categoryId: null,
        categoryName: null,
      },
    });

    const result = await patchDocMetadataTool.handler(
      { docId: 'd2', tags: [], expectedContentHash: HASH },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).changedFields).toEqual(['tags']);
    expect(request.mock.calls.length).toBe(1);
    // tags: [] = 清空语义直透（空数组必须进 body）
    expect(request.mock.calls[0][2]).toMatchObject({
      body: { tags: [], expectedContentHash: HASH },
    });
  });

  it('Partial 三态：缺席字段不进 body（服务端才能区分不动/更新）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd3',
      path: 'a.md',
      contentHash: HASH,
      changedFields: ['summary'],
      unchanged: false,
      metadata: {
        title: 'A',
        summary: '新摘要',
        docType: null,
        tags: [],
        categoryId: null,
        categoryName: null,
      },
    });

    await patchDocMetadataTool.handler(
      { docId: 'd3', summary: '新摘要', expectedContentHash: HASH },
      ctx(),
    );

    const body = request.mock.calls[0][2].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expectedContentHash', 'summary']);
  });

  it('null 字段直透服务端（400 由服务端 DTO 判定，工具层不吞）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd4',
      path: 'a.md',
      contentHash: HASH,
      changedFields: [],
      unchanged: true,
      metadata: {
        title: 'A',
        summary: null,
        docType: null,
        tags: [],
        categoryId: null,
        categoryName: null,
      },
    });

    await patchDocMetadataTool.handler(
      { docId: 'd4', title: null, expectedContentHash: HASH },
      ctx(),
    );

    const body = request.mock.calls[0][2].body as Record<string, unknown>;
    expect(body).toHaveProperty('title', null);
  });

  it('allowCreateCategory + category 显式字段全量透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd5',
      path: 'a.md',
      contentHash: HASH,
      changedFields: ['category'],
      unchanged: false,
      metadata: {
        title: 'A',
        summary: null,
        docType: null,
        tags: [],
        categoryId: 'c1',
        categoryName: '新',
      },
    });

    await patchDocMetadataTool.handler(
      {
        docId: 'd5',
        category: '新',
        allowCreateCategory: true,
        docType: 'guide',
        expectedContentHash: HASH,
      },
      ctx(),
    );

    expect(request.mock.calls[0][2]).toMatchObject({
      body: {
        category: '新',
        allowCreateCategory: true,
        docType: 'guide',
        expectedContentHash: HASH,
      },
    });
  });

  it('缺定位参数 → isError（docId 与 spaceName+path 都没有）', async () => {
    const request = mockRequest();

    const result = await patchDocMetadataTool.handler(
      { title: 'x', expectedContentHash: HASH },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('Either docId or');
    expect(request).not.toHaveBeenCalled();
  });

  it('缺 expectedContentHash → isError 快速失败（不打服务端）', async () => {
    const request = mockRequest();

    const result = await patchDocMetadataTool.handler({ docId: 'd1', title: 'x' }, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('expectedContentHash is required');
    expect(request).not.toHaveBeenCalled();
  });

  it('spaceName 零命中 → resolve_space 失败体（availableNames 透出）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'Real Space', slug: 'real-space' }],
    });

    const result = await patchDocMetadataTool.handler(
      { spaceName: '幽灵空间', path: 'a.md', expectedContentHash: HASH },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Real Space']);
  });

  it('spaceName 多命中 → resolve_space 歧义体（candidates 透出）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Docs A', slug: 'docs-a' },
        { id: 'sp-2', name: 'Docs B', slug: 'docs-b' },
      ],
    });

    const result = await patchDocMetadataTool.handler(
      { spaceName: 'Docs', path: 'a.md', expectedContentHash: HASH },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.isAmbiguous).toBe(true);
    expect(body.candidates).toHaveLength(2);
  });

  it('path 定位零命中 → locate 失败体', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [] });

    const result = await patchDocMetadataTool.handler(
      { spaceName: 'My Docs', path: 'ghost.md', expectedContentHash: HASH },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('Document not found at path');
  });

  it('PATCH HTTP 失败 → handlePlatformError 结构化透传（铁律 #9）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), {
        status: 409,
        code: 10009,
        data: { currentContentHash: 'other' },
      }),
    );

    const result = await patchDocMetadataTool.handler(
      { docId: 'd1', title: 'x', expectedContentHash: HASH },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe(true);
  });
});
