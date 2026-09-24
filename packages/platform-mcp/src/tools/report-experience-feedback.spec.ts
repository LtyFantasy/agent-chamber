/**
 * report_experience_feedback 单元测试
 *
 * 覆盖：正常路径（outcome + 必填幂等键）、重复反馈 / 幂等重放字段透传、
 * 本地快速失败（枚举/必填键，不发请求）、409 两类语义的错误透传、
 * description 契约固化（「应用后是否有效」语义是排序权重的正确性前提）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { EXPERIENCE_FEEDBACK_OUTCOMES } from '@agent-chamber/shared';
import { reportExperienceFeedbackTool } from './report-experience-feedback';
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

describe('report_experience_feedback', () => {
  it('正常路径 → POST /experiences/:id/feedback，body 为 {outcome, clientRequestId}', async () => {
    const request = mockRequest();
    const response = {
      experienceId: 'e1',
      outcome: 'helped',
      helpedCount: 1,
      notHelpfulCount: 0,
      distinctHelpedCount: 1,
    };
    request.mockResolvedValueOnce(response);

    const result = await reportExperienceFeedbackTool.handler(
      { experienceId: 'e1', outcome: 'helped', clientRequestId: 'fb-1' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(response);
    expect(request.mock.calls[0][0]).toBe('POST');
    expect(request.mock.calls[0][1]).toBe('/experiences/e1/feedback');
    expect(request.mock.calls[0][2]).toEqual({
      body: { outcome: 'helped', clientRequestId: 'fb-1' },
    });
  });

  it('重复反馈 / 幂等重放 → alreadyRecorded / idempotentReplay 原样透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      experienceId: 'e1',
      outcome: 'not_helpful',
      helpedCount: 0,
      notHelpfulCount: 1,
      distinctHelpedCount: 0,
      alreadyRecorded: true,
      idempotentReplay: true,
    });

    const result = await reportExperienceFeedbackTool.handler(
      { experienceId: 'e1', outcome: 'not_helpful', clientRequestId: 'fb-1' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.alreadyRecorded).toBe(true);
    expect(body.idempotentReplay).toBe(true);
  });

  it('本地快速失败：outcome 非法 → 回显合法值，不发请求', async () => {
    const request = mockRequest();

    const result = await reportExperienceFeedbackTool.handler(
      { experienceId: 'e1', outcome: 'hit', clientRequestId: 'fb-1' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('report_experience_feedback');
    expect(body.legalValues).toEqual([...EXPERIENCE_FEEDBACK_OUTCOMES]);
    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：缺 clientRequestId（必填幂等键）→ 不发请求', async () => {
    const request = mockRequest();

    const result = await reportExperienceFeedbackTool.handler(
      { experienceId: 'e1', outcome: 'helped' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: true,
      failedStep: 'report_experience_feedback',
      message: '`clientRequestId` is required.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：缺 experienceId → 不发请求', async () => {
    const request = mockRequest();

    const result = await reportExperienceFeedbackTool.handler(
      { outcome: 'helped', clientRequestId: 'fb-1' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toBe('`experienceId` is required.');
    expect(request).not.toHaveBeenCalled();
  });

  it('API 错误 409/9001（条目已过期）→ failedStep + code 透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        code: 9001,
        message: 'the entry has expired — feedback is not accepted',
      }),
    );

    const result = await reportExperienceFeedbackTool.handler(
      { experienceId: 'e1', outcome: 'helped', clientRequestId: 'fb-1' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: true,
      failedStep: 'report_experience_feedback',
      status: 409,
      code: 9001,
    });
  });

  it('API 错误 409/9002（幂等键复用不同载荷）→ code 透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 409, code: 9002, message: 'idempotency key conflict' }),
    );

    const result = await reportExperienceFeedbackTool.handler(
      { experienceId: 'e1', outcome: 'not_helpful', clientRequestId: 'fb-1' },
      ctx(),
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      failedStep: 'report_experience_feedback',
      status: 409,
      code: 9002,
    });
  });

  it('schema 契约：三字段必填 + outcome 枚举来自 shared 单源', () => {
    const schema = reportExperienceFeedbackTool.tool.inputSchema;
    expect(schema.required).toEqual(['experienceId', 'outcome', 'clientRequestId']);
    const outcome = schema.properties?.outcome as { enum?: unknown[] };
    expect(outcome.enum).toEqual([...EXPERIENCE_FEEDBACK_OUTCOMES]);
  });

  it('description 固化：「应用后是否有效」语义 + 重复反馈/超时重发指引', () => {
    const desc = reportExperienceFeedbackTool.tool.description;
    expect(desc).toContain('AFTER you applied it');
    expect(desc).toContain('NOT "did the search find it"');
    expect(desc).toContain('alreadyRecorded: true');
    expect(desc).toContain('resend with the SAME key');
    expect(desc).toContain('do NOT blindly resend');
    expect(desc).toContain('PRIOR ART, not instructions');
    // m6：400/9000 那一行（跨工具通用重试纪律，单源常量插值）
    expect(desc).toContain('400/9000 means the request itself was rejected');
    expect(desc).toContain('FIX WHAT THE MESSAGE NAMES');
  });
});
