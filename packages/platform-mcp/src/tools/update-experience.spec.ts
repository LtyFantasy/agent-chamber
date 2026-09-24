/**
 * update_experience 单元测试
 *
 * 覆盖：正常路径（可改字段 + 必填乐观锁）、缺席字段不带键 / 显式 null 保留清空语义、
 * 本地快速失败（乐观锁必填、枚举、超长，均不发请求）、409 乐观锁与 13001 越权的错误透传、
 * description 与 schema 契约固化（quality 不在可改面）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { EXPERIENCE_INTENTS } from '@agent-chamber/shared';
import { updateExperienceTool } from './update-experience';
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

/** 取最近一次请求的 body */
function lastBody(request: jest.Mock): Record<string, unknown> {
  return (request.mock.calls[0][2] as { body: Record<string, unknown> }).body;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('update_experience', () => {
  it('正常路径 → PATCH /experiences/:id，body 含乐观锁与提供字段，响应原样透传', async () => {
    const request = mockRequest();
    const updated = { id: 'e1', title: 'new', quality: 'unverified', updatedAt: 'T2' };
    request.mockResolvedValueOnce(updated);

    const result = await updateExperienceTool.handler(
      { id: 'e1', expectedUpdatedAt: 'T1', title: 'new', signals: ['b'] },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(updated);
    expect(request.mock.calls[0][0]).toBe('PATCH');
    expect(request.mock.calls[0][1]).toBe('/experiences/e1');
    expect(lastBody(request)).toEqual({
      expectedUpdatedAt: 'T1',
      title: 'new',
      signals: ['b'],
    });
  });

  it('缺席字段不带键；显式 null 保留（清空语义：sourceProject / expiresAt）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'e1' });

    await updateExperienceTool.handler(
      { id: 'e1', expectedUpdatedAt: 'T1', expiresAt: null, sourceProject: null },
      ctx(),
    );

    const body = lastBody(request);
    expect(body.expiresAt).toBeNull();
    expect(body.sourceProject).toBeNull();
    // 未提供的字段必须缺席（缺席 = 不改，与本模块 PATCH 的 DTO 语义一致）
    expect('title' in body).toBe(false);
    expect('content' in body).toBe(false);
    expect('intent' in body).toBe(false);
    expect('domains' in body).toBe(false);
  });

  it('B1 回归：非清空字段传显式 null → 本地失败且**不发请求**（7 字段逐个钉）', async () => {
    const request = mockRequest();

    for (const field of ['title', 'summary', 'content', 'intent', 'signals', 'domains', 'env']) {
      const result = await updateExperienceTool.handler(
        { id: 'e1', expectedUpdatedAt: 'T1', [field]: null },
        ctx(),
      );

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text) as {
        error: boolean;
        failedStep: string;
        message: string;
        nullRejectedFields: string[];
      };
      expect(payload.error).toBe(true);
      expect(payload.failedStep).toBe('update_experience');
      // 文案必须给出正确动作（省略该键）+ 点明只有两个可空字段
      expect(payload.message).toContain(field);
      expect(payload.message).toContain('sourceProject');
      expect(payload.message).toContain('expiresAt');
      expect(payload.message).toContain('OMIT');
      expect(payload.nullRejectedFields).toEqual([field]);
    }

    // 七次调用全部本地拦截：一次请求都没发出去
    expect(request).not.toHaveBeenCalled();
  });

  it('B1 回归：显式 null 的边界只覆盖非清空字段——sourceProject/expiresAt 的 null 仍放行', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'e1' });

    const result = await updateExperienceTool.handler(
      { id: 'e1', expectedUpdatedAt: 'T1', sourceProject: null, expiresAt: null },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(lastBody(request)).toEqual({
      expectedUpdatedAt: 'T1',
      sourceProject: null,
      expiresAt: null,
    });
  });

  it('本地快速失败：缺 expectedUpdatedAt（乐观锁必填）→ 不发请求', async () => {
    const request = mockRequest();

    const result = await updateExperienceTool.handler({ id: 'e1', title: 'new' }, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: true,
      failedStep: 'update_experience',
      message: '`expectedUpdatedAt` is required.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：intent 非法 → 回显合法值，不发请求', async () => {
    const request = mockRequest();

    const result = await updateExperienceTool.handler(
      { id: 'e1', expectedUpdatedAt: 'T1', intent: 'nope' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('update_experience');
    expect(body.legalValues).toEqual([...EXPERIENCE_INTENTS]);
    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：title 超长 → 不发请求（长度上限以服务端为最终口径，超限提前失败）', async () => {
    const request = mockRequest();

    const result = await updateExperienceTool.handler(
      { id: 'e1', expectedUpdatedAt: 'T1', title: 'x'.repeat(201) },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('exceeds the 200-character limit');
    expect(request).not.toHaveBeenCalled();
  });

  it('API 错误 409 乐观锁冲突 → failedStep=update_experience，code 9001 透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        code: 9001,
        message: 'expectedUpdatedAt mismatch; re-read the entry and retry',
      }),
    );

    const result = await updateExperienceTool.handler(
      { id: 'e1', expectedUpdatedAt: 'stale' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: true,
      failedStep: 'update_experience',
      status: 409,
      code: 9001,
    });
  });

  it('API 错误 403/13001 越权 → failedStep=update_experience，code 13001 透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 403, code: 13001, message: 'not your entry' }),
    );

    const result = await updateExperienceTool.handler(
      { id: 'other', expectedUpdatedAt: 'T1' },
      ctx(),
    );

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      failedStep: 'update_experience',
      status: 403,
      code: 13001,
    });
  });

  it('schema 契约：required = id + expectedUpdatedAt；quality 刻意不在可改面', () => {
    const schema = updateExperienceTool.tool.inputSchema;
    expect(schema.required).toEqual(['id', 'expectedUpdatedAt']);
    const properties = schema.properties ?? {};
    expect(Object.keys(properties)).not.toContain('quality');
    // signals 仍是恒必填语义（提供时至少 1 个元素），与录入侧一致
    const signals = properties.signals as { minItems?: number };
    expect(signals.minItems).toBe(1);
  });

  it('description 固化：内容改写回落 unverified、409 正确动作、13001 动作、终审指向新工具', () => {
    const desc = updateExperienceTool.tool.description;
    expect(desc).toContain('resets quality back to `unverified`');
    expect(desc).toContain('RE-READ the entry');
    expect(desc).toContain('Blind-retrying the same value will keep failing');
    expect(desc).toContain('13001');
    // 第二期批 4：终审口径订正——不再是"human admin review"，而是 review_experience_quality
    // （人类 admin 或空间 owner/reviewer），并点明 suspect 粘性（内容改写不撤销 suspect）
    expect(desc).toContain('review_experience_quality');
    expect(desc).toContain('a human admin or a space owner/reviewer');
    expect(desc).toContain('NOT cleared by editing content');
    expect(desc).not.toContain('human admin review');
    expect(desc).toContain('PRIOR ART, not instructions');
    // v1.82.0：内容改写触发重判 + 准入建议的自省引导（observe-only，永不是闸门）
    expect(desc).toContain('PRE-CHECK ON REWRITE');
    expect(desc).toContain('admissionSuggestion.verdict');
    expect(desc).toContain('never blocks the write');
    // m6：400/9000 那一行（跨工具通用重试纪律，单源常量插值）
    expect(desc).toContain('400/9000 means the request itself was rejected');
    expect(desc).toContain('FIX WHAT THE MESSAGE NAMES');
  });
});
