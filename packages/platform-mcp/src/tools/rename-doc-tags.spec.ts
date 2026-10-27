/**
 * rename_doc_tags 单元测试（v1.92.0-dev，DocSpace 元数据治理 3 期）
 *
 * 覆盖：description 的 dryRun 强引导（P3，LLM 消费者按它行动）、happy path（spaceName
 * 解析 → rename 信封）、spaceId 直传（跳过列表拉取）、body 直透（dryRun /
 * expectedBatchToken / idempotencyKey）、缺参 → isError、0/>1 候选 → 结构化信封、
 * list_doc_spaces / rename_doc_tags HTTP 失败透传（铁律 #9：不包装状态码）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { renameDocTagsTool } from './rename-doc-tags';
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

/** dryRun 响应样本（RenameDocTagsResult） */
function dryRunEnvelope() {
  return {
    dryRun: true,
    batchToken: 'a'.repeat(64),
    affectedDocs: {
      total: 72,
      sample: [{ docId: 'd1', path: 'world/npc.md', currentTags: ['NPC'] }],
      truncated: true,
    },
    perValue: [{ value: 'NPC', docCount: 11 }],
    similarNotAffected: [{ value: 'npc-lore', docCount: 3 }],
    vocabularyPlan: {
      created: true,
      addedAliases: ['NPC'],
      removedCanonicals: [],
      movedAliases: [],
    },
    ingestAffected: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('rename_doc_tags', () => {
  it('description 含 dryRun 先行强引导（P3：LLM 消费者按 description 行动）', () => {
    expect(renameDocTagsTool.tool.description).toContain('Always run with dryRun=true first');
    expect(renameDocTagsTool.tool.description).toContain('expectedBatchToken');
    expect(renameDocTagsTool.tool.description).toContain('DOC_BATCH_CONFLICT');
    expect(renameDocTagsTool.tool.inputSchema.required).toEqual(['from', 'to']);
  });

  it('happy path：spaceName 解析 → dryRun 信封原样返回', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'Wayward', slug: 'wayward' }] });
    request.mockResolvedValueOnce(dryRunEnvelope());

    const result = await renameDocTagsTool.handler(
      { spaceName: 'Wayward', from: ['NPC'], to: 'npc', dryRun: true },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.batchToken).toBe('a'.repeat(64));
    expect(body.vocabularyPlan.created).toBe(true);

    const call = request.mock.calls[1];
    expect(call[0]).toBe('POST');
    expect(call[1]).toContain('sp-1/tags/rename');
    expect(call[2].body).toEqual({ from: ['NPC'], to: 'npc', dryRun: true });
  });

  it('spaceId 直传 + execute：跳过列表拉取，body 含 expectedBatchToken / idempotencyKey', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ dryRun: false, batchToken: 'b'.repeat(64), updatedDocs: 72 });

    const result = await renameDocTagsTool.handler(
      {
        spaceId: 'sp-direct',
        from: ['NPC', 'npc '],
        to: 'npc',
        expectedBatchToken: 'a'.repeat(64),
        idempotencyKey: 'k-1',
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toContain('sp-direct/tags/rename');
    expect(request.mock.calls[0][2].body).toEqual({
      from: ['NPC', 'npc '],
      to: 'npc',
      expectedBatchToken: 'a'.repeat(64),
      idempotencyKey: 'k-1',
    });
  });

  it('缺 from / to → isError（不发任何请求）', async () => {
    const request = mockRequest();

    for (const args of [{}, { from: [], to: 'npc' }, { from: ['NPC'] }, { from: ['NPC'], to: 1 }]) {
      const result = await renameDocTagsTool.handler(
        { spaceId: 'sp-1', ...(args as Record<string, unknown>) },
        ctx(),
      );
      expect(result.isError).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('to 空串 / 纯空白 → 400 结构化错误（评审 B1，不发任何请求）', async () => {
    const request = mockRequest();

    for (const bad of ['', '   ', '\t']) {
      const result = await renameDocTagsTool.handler(
        { spaceId: 'sp-1', from: ['NPC'], to: bad },
        ctx(),
      );
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.status).toBe(400);
      expect(body.failedStep).toBe('validate_args');
      expect(body.message).toContain("'to' must be a non-empty tag value");
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }] });

    const result = await renameDocTagsTool.handler(
      { spaceName: 'Ghost', from: ['NPC'], to: 'npc' },
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
        { id: 'sp-1', name: 'Project A', slug: 'project-a' },
        { id: 'sp-2', name: 'Project B', slug: 'project-b' },
      ],
    });

    const result = await renameDocTagsTool.handler(
      { spaceName: 'Project', from: ['NPC'], to: 'npc' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.candidates).toHaveLength(2);
    expect(body.isAmbiguous).toBe(true);
  });

  it('rename_doc_tags HTTP 失败 → 状态码/分码透传（不包装成 500）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 409, message: 'conflict', code: 10016 }),
    );

    const result = await renameDocTagsTool.handler(
      { spaceId: 'sp-1', from: ['NPC'], to: 'npc' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('rename_doc_tags');
    expect(body.status).toBe(409);
    expect(body.code).toBe(10016);
  });
});
