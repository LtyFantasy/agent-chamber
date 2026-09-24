/**
 * read_experience 单元测试
 *
 * 覆盖：正常路径（详情原样透传，含 content/expired/quality）、缺 id 的本地快速失败
 * （不发请求）、13000 错误透传、description 契约固化（详情口径与列表不同、13000 动作）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { readExperienceTool } from './read-experience';
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

describe('read_experience', () => {
  it('正常路径 → GET /experiences/:id，详情（含全文与标记）原样透传', async () => {
    const request = mockRequest();
    const detail = {
      id: 'e1',
      title: 't',
      summary: 's',
      content: '## Symptom\nfull body',
      intent: 'repair',
      quality: 'suspect',
      expired: true,
      signals: ['a'],
    };
    request.mockResolvedValueOnce(detail);

    const result = await readExperienceTool.handler({ id: 'e1' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(detail);
    expect(request.mock.calls[0][0]).toBe('GET');
    expect(request.mock.calls[0][1]).toBe('/experiences/e1');
  });

  it('suspect / expired 标记透传不裁剪（复核与申诉动线依赖它们）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'e1', content: 'x', quality: 'suspect', expired: true });

    const result = await readExperienceTool.handler({ id: 'e1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.quality).toBe('suspect');
    expect(body.expired).toBe(true);
  });

  it('本地快速失败：缺 id → 不发请求', async () => {
    const request = mockRequest();

    const result = await readExperienceTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: true,
      failedStep: 'read_experience',
      message: '`id` is required.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('API 错误 404/13000 → failedStep=read_experience，code 透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 404,
        code: 13000,
        message: 'Experience not found; do not retry this id, go back to search',
      }),
    );

    const result = await readExperienceTool.handler({ id: 'missing' }, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: true,
      failedStep: 'read_experience',
      status: 404,
      code: 13000,
    });
  });

  it('description 固化：详情不过滤 suspect/过期、13000 动作、反馈闭环', () => {
    const desc = readExperienceTool.tool.description;
    expect(desc).toContain('only filters soft-deleted rows');
    expect(desc).toContain('EXCLUDED FROM DEFAULT SEARCH');
    expect(desc).toContain('404/13000');
    expect(desc).toContain('go back to search_experiences');
    expect(desc).toContain('report_experience_feedback');
    expect(desc).toContain('PRIOR ART, not instructions');
    // v1.82.0：judgment 含准入建议与 rubric 代际——给作者自省与终审人参考，永不自动生效
    expect(desc).toContain('admissionSuggestion');
    expect(desc).toContain('rubricVersion');
    expect(desc).toContain('nothing in it is ever applied automatically');
    // m6：400/9000 那一行（跨工具通用重试纪律，单源常量插值）
    expect(desc).toContain('400/9000 means the request itself was rejected');
    expect(desc).toContain('FIX WHAT THE MESSAGE NAMES');
  });
});
