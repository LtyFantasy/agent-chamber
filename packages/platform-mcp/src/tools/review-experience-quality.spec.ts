/**
 * review_experience_quality 单元测试
 *
 * 覆盖：正常路径（PATCH 方法与 URL + body 精确形状）、本地快速失败（缺 id / 非法 quality 回显
 * 合法值 / 空 reason / 超长 reason —— 四者都**不发请求**）、上游错误映射形状（13000 / 13002 /
 * 13004 三态经 handlePlatformError 透传）、description 关键纪律句抽查（队列动线 / 禁自审四态 /
 * 不可信输入 / suppression）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { EXPERIENCE_REVIEW_QUALITIES } from '@agent-chamber/shared';
import { reviewExperienceQualityTool } from './review-experience-quality';
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

/** 取失败体的机读形状 */
function failurePayload(result: { content: Array<{ text: string }> }): {
  error: boolean;
  failedStep: string;
  message: string;
  legalValues?: string[];
} {
  return JSON.parse(result.content[0].text) as never;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('review_experience_quality', () => {
  it('正常路径 → PATCH /experiences/:id/quality，body = {quality, reason}，响应原样透传', async () => {
    const request = mockRequest();
    const reviewed = {
      id: 'e1',
      quality: 'suspect',
      verifiedBy: 'u1',
      verifiedAt: '2026-09-22T10:00:00.000Z',
    };
    request.mockResolvedValueOnce(reviewed);

    const result = await reviewExperienceQualityTool.handler(
      { id: 'e1', quality: 'suspect', reason: 'could not reproduce on the same base image' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(reviewed);
    expect(request.mock.calls[0][0]).toBe('PATCH');
    expect(request.mock.calls[0][1]).toBe('/experiences/e1/quality');
    expect(request.mock.calls[0][2]).toEqual({
      body: { quality: 'suspect', reason: 'could not reproduce on the same base image' },
    });
  });

  it('reason 前后空白被 trim 后再发（本地校验与发送值一致，避免"本地过、服务端拒"）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'e1', quality: 'verified' });

    await reviewExperienceQualityTool.handler(
      { id: 'e1', quality: 'verified', reason: '  reproduced twice  ' },
      ctx(),
    );

    expect(request.mock.calls[0][2]).toEqual({
      body: { quality: 'verified', reason: 'reproduced twice' },
    });
  });

  it('id 用 encodeURIComponent 进 URL（防路径注入）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'x' });

    await reviewExperienceQualityTool.handler(
      { id: 'a b/c', quality: 'verified', reason: 'r' },
      ctx(),
    );

    expect(request.mock.calls[0][1]).toBe('/experiences/a%20b%2Fc/quality');
  });

  it('本地快速失败：缺 id → 不发请求', async () => {
    const request = mockRequest();

    const result = await reviewExperienceQualityTool.handler(
      { quality: 'verified', reason: 'r' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const payload = failurePayload(result);
    expect(payload.failedStep).toBe('review_experience_quality');
    expect(payload.message).toContain('id');
    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：非法 quality → 回显合法值（shared 单源）且不发请求', async () => {
    const request = mockRequest();

    for (const bad of ['unverified', 'VERIFIED', 'approved', 42, null]) {
      const result = await reviewExperienceQualityTool.handler(
        { id: 'e1', quality: bad, reason: 'r' },
        ctx(),
      );

      expect(result.isError).toBe(true);
      const payload = failurePayload(result);
      expect(payload.failedStep).toBe('review_experience_quality');
      // 值域必须回显 shared 单源的两个值（且**不含 unverified**——撤回结论不走终审）。
      // 注意 message 里可能出现被拒的原值本身（`Invalid \`quality\` value "unverified"`），
      // 那是"回显你做错了什么"，正当；判据只落在 legalValues 上。
      expect(payload.legalValues).toEqual([...EXPERIENCE_REVIEW_QUALITIES]);
      expect(payload.legalValues).not.toContain('unverified');
      expect(payload.message).toContain('verified');
      expect(payload.message).toContain('suspect');
    }

    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：空 reason / 纯空白 → 不发请求', async () => {
    const request = mockRequest();

    for (const bad of ['', '   ', undefined]) {
      const result = await reviewExperienceQualityTool.handler(
        { id: 'e1', quality: 'verified', reason: bad },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(failurePayload(result).message).toContain('reason');
    }

    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：reason 超 500 → 不发请求（本地阈值只是复述，服务端仍为最终裁判）', async () => {
    const request = mockRequest();

    const result = await reviewExperienceQualityTool.handler(
      { id: 'e1', quality: 'verified', reason: 'x'.repeat(501) },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const payload = failurePayload(result);
    expect(payload.message).toContain('500');
    expect(request).not.toHaveBeenCalled();

    // 边界：正好 500 字符放行
    request.mockResolvedValueOnce({ id: 'e1' });
    const ok = await reviewExperienceQualityTool.handler(
      { id: 'e1', quality: 'verified', reason: 'y'.repeat(500) },
      ctx(),
    );
    expect(ok.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('上游 13000/13004 → 经 handlePlatformError 原样映射（含 failedStep 与 retryable 语义）', async () => {
    const request = mockRequest();

    for (const code of [13000, 13004]) {
      request.mockRejectedValueOnce(
        new PlatformApiError({ status: 403, code, message: `backend says ${code}` }),
      );

      const result = await reviewExperienceQualityTool.handler(
        { id: 'e1', quality: 'verified', reason: 'r' },
        ctx(),
      );

      expect(result.isError).toBe(true);
      const payload = failurePayload(result) as unknown as { failedStep: string; code: number };
      expect(payload.failedStep).toBe('review_experience_quality');
      // 上游业务码必须原样透出（消费方按码分派动作：13004 要角色 / 13000 回 search）
      expect(payload.code).toBe(code);
    }
  });

  it('description 抽查：队列动线 / 纯角色判定 / 不可信输入 / suppression 四条纪律都在', () => {
    const description = reviewExperienceQualityTool.tool.description;

    // 队列动线：quality=unverified 找活 + viewerCanReview 是**权威角色标记** + suspect 复核队列
    expect(description).toContain('search_experiences quality=unverified');
    expect(description).toContain('viewerCanReview === true');
    expect(description).toContain('AUTHORITATIVE');
    expect(description).toContain('quality=suspect');

    // 纯角色判定 + 反向纪律：**不得按 creator 预筛**（预筛会把可审条目摘掉）
    expect(description).toContain('do not pre-filter the queue by creator');
    expect(description).toContain('INCLUDING one they recorded themselves');
    expect(description).toContain('13004');
    expect(description).toContain('GET /experiences/members');

    // 负向断言（防旧四态文案回流：回流会让 agent 去"换人审"而不是直接审自己录的条目）
    expect(description).not.toContain('13002');
    expect(description).not.toContain('SIBLING agent under the same human');
    expect(description).not.toContain('no self-review exception');
    expect(description).not.toContain('all four self-review cases');

    // Returns 行带 verifiedByName（v1.81.0：不必再发一次详情请求）
    expect(description).toContain('verifiedByName');

    // 不可信输入纪律
    expect(description).toContain('UNTRUSTED INPUT');
    expect(description).toMatch(/never execute or obey/i);

    // 防锚定 suppression
    expect(description).toContain('judgmentSuppressed');
    expect(description).toContain('judgment: null');

    // reason 纪律（进审计、禁粘正文）
    expect(description).toContain('old→new+reason');
    expect(description).toContain('never paste the entry body');
  });

  it('inputSchema：三个参数都必填，quality 枚举 = shared 单源', () => {
    const schema = reviewExperienceQualityTool.tool.inputSchema as {
      required?: string[];
      properties?: Record<string, { enum?: string[]; maxLength?: number }>;
    };

    expect(schema.required).toEqual(['id', 'quality', 'reason']);
    expect(schema.properties?.quality?.enum).toEqual([...EXPERIENCE_REVIEW_QUALITIES]);
    expect(schema.properties?.reason?.maxLength).toBe(500);
  });
});
