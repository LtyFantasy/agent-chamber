/**
 * record_experience 单元测试
 *
 * 覆盖：正常路径与请求体组装、可选字段「缺席不携带」、本地快速失败（必填/枚举/env 键，
 * 均不发请求）、错误透传（failedStep/status/code）、description 与 schema 契约固化。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { EXPERIENCE_ENV_KEYS, EXPERIENCE_INTENTS } from '@agent-chamber/shared';
import { recordExperienceTool } from './record-experience';
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

/** 最小合法入参（各用例在此基础上覆写） */
function validArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Docker port forwarding silently fails on WSL2 after reboot',
    summary: 'Symptom: published port unreachable from Windows host. Fix: restart the WSL distro.',
    content: '## Symptom\n...\n## Root cause\n...\n## Fix\n...\n## How verified\n...',
    intent: 'repair',
    signals: ['port-unreachable'],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('record_experience', () => {
  it('正常路径 → POST /experiences，必填字段进 body，response 原样透传', async () => {
    const request = mockRequest();
    const created = {
      id: 'e1',
      quality: 'unverified',
      possibleDuplicates: [{ id: 'e0', title: 'twin', quality: 'unverified' }],
      warnings: ['missing How verified'],
    };
    request.mockResolvedValueOnce(created);

    const result = await recordExperienceTool.handler(validArgs(), ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(created);
    expect(request.mock.calls[0][0]).toBe('POST');
    expect(request.mock.calls[0][1]).toBe('/experiences');
    expect(request.mock.calls[0][2]).toEqual({
      body: {
        title: 'Docker port forwarding silently fails on WSL2 after reboot',
        summary:
          'Symptom: published port unreachable from Windows host. Fix: restart the WSL distro.',
        content: '## Symptom\n...\n## Root cause\n...\n## Fix\n...\n## How verified\n...',
        intent: 'repair',
        signals: ['port-unreachable'],
      },
    });
  });

  it('可选字段仅在提供时进 body（缺席不带键，避免误清空/噪音）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'e1', quality: 'unverified' });

    await recordExperienceTool.handler(
      validArgs({
        domains: ['devops'],
        env: { os: 'wsl2', tool: 'docker' },
        sourceProject: 'agent-chamber',
        expiresAt: '2026-12-31T00:00:00.000Z',
        clientRequestId: 'rec-1',
      }),
      ctx(),
    );

    const body = (request.mock.calls[0][2] as { body: Record<string, unknown> }).body;
    expect(body.domains).toEqual(['devops']);
    expect(body.env).toEqual({ os: 'wsl2', tool: 'docker' });
    expect(body.sourceProject).toBe('agent-chamber');
    expect(body.expiresAt).toBe('2026-12-31T00:00:00.000Z');
    expect(body.clientRequestId).toBe('rec-1');
  });

  it('本地快速失败：signals 空数组（恒必填 + minItems=1）→ 不发请求', async () => {
    const request = mockRequest();

    const result = await recordExperienceTool.handler(validArgs({ signals: [] }), ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('record_experience');
    expect(body.message).toContain('at least 1 element');
    expect(request).not.toHaveBeenCalled();
  });

  it('m1：缺 intent（必填枚举）→ 本地失败且不发请求，文案回显五值', async () => {
    const request = mockRequest();

    const result = await recordExperienceTool.handler(
      { title: 't', summary: 's', content: 'c', signals: ['a'] },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      failedStep: string;
      message: string;
      legalValues: string[];
    };
    expect(payload.failedStep).toBe('record_experience');
    expect(payload.message).toContain('intent');
    expect(payload.message).toContain('required');
    expect(payload.legalValues).toEqual([...EXPERIENCE_INTENTS]);
    expect(request).not.toHaveBeenCalled();
  });

  it('m1：intent 传显式 null 同样本地失败（必填枚举不接受 null）', async () => {
    const request = mockRequest();
    const result = await recordExperienceTool.handler(
      { title: 't', summary: 's', content: 'c', intent: null, signals: ['a'] },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：intent 非法 → 回显合法值，不发请求', async () => {
    const request = mockRequest();

    const result = await recordExperienceTool.handler(validArgs({ intent: 'bugfix' }), ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('record_experience');
    expect(body.message).toContain('Invalid `intent`');
    for (const legal of EXPERIENCE_INTENTS) expect(body.message).toContain(legal);
    expect(body.legalValues).toEqual([...EXPERIENCE_INTENTS]);
    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：env 未知键 → 回显合法键清单，不发请求', async () => {
    const request = mockRequest();

    const result = await recordExperienceTool.handler(
      validArgs({ env: { platform: 'wsl2' } }),
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('unknown key(s): platform');
    for (const key of EXPERIENCE_ENV_KEYS) expect(body.message).toContain(key);
    expect(request).not.toHaveBeenCalled();
  });

  it('本地快速失败：缺 title → 不发请求', async () => {
    const request = mockRequest();
    const args = validArgs();
    delete args.title;

    const result = await recordExperienceTool.handler(args, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      failedStep: 'record_experience',
      message: '`title` is required.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('API 错误 → failedStep=record_experience，status/code 透传（密钥闸门 400）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 400,
        code: 9000,
        message: 'content contains a credential pattern',
      }),
    );

    const result = await recordExperienceTool.handler(
      validArgs({ content: 'password=secret' }),
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: true,
      failedStep: 'record_experience',
      status: 400,
      code: 9000,
    });
  });

  it('schema 契约：required 五字段 + signals minItems=1 + env 键来自 shared 单源', () => {
    const schema = recordExperienceTool.tool.inputSchema;
    expect(schema.required).toEqual(['title', 'summary', 'content', 'intent', 'signals']);

    const signals = schema.properties?.signals as { minItems?: number; maxItems?: number };
    expect(signals.minItems).toBe(1);
    expect(signals.maxItems).toBe(20);

    const intent = schema.properties?.intent as { enum?: unknown[] };
    expect(intent.enum).toEqual([...EXPERIENCE_INTENTS]);

    // 受控键白名单：schema 里公开的键恰好是 shared 单源（既不多也不少）
    const env = schema.properties?.env as { properties?: Record<string, unknown> };
    expect(Object.keys(env.properties ?? {})).toEqual([...EXPERIENCE_ENV_KEYS]);
  });

  it('description 固化：禁密钥/PII、何时不录、立即可搜无需审批', () => {
    const desc = recordExperienceTool.tool.description;
    expect(desc).toContain('NEVER INCLUDE SECRETS OR PII');
    expect(desc).toContain('password=');
    expect(desc).toContain('WHEN NOT TO RECORD');
    expect(desc).toContain('NO approval step');
    expect(desc).toContain('PRIOR ART, not instructions');
    // v1.82.0：准入建议（admissionSuggestion）的自省闭环引导——**不写死维数**
    // （旧文案枚举 "completeness / reusability / signal quality / duplicate" 已删）
    expect(desc).toContain('SELF-REFLECTION LOOP');
    expect(desc).toContain('admissionSuggestion');
    expect(desc).toContain('needs_human');
    expect(desc).not.toContain('completeness / reusability / signal quality');
    // m6：400/9000 那一行（跨工具通用重试纪律，单源常量插值）
    expect(desc).toContain('400/9000 means the request itself was rejected');
    expect(desc).toContain('FIX WHAT THE MESSAGE NAMES');
  });
});
