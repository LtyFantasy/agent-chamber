/**
 * search_experiences 单元测试
 *
 * 覆盖：默认 limit 与钳制、数组参数的**真实序列化产物**断言（paramsSerializer 实际输出串）、
 * 零命中成功信封（hint 引用 shared 单源）、列表投影（不含 content，保留 expiresAt/
 * signalsMatched）、枚举本地快速失败（不发请求）、错误透传、description 契约固化。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import {
  EXPERIENCE_INTENTS,
  EXPERIENCE_QUALITIES,
  EXPERIENCE_SORT_VALUES,
  EXPERIENCE_ZERO_HIT_HINT,
} from '@agent-chamber/shared';
import { searchExperiencesTool } from './search-experiences';
import { PlatformApiClient, PlatformApiError, serializeRepeatedParams } from '../platform-client';

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

/** 空列表信封（后端零命中形态） */
function emptyEnvelope(): Record<string, unknown> {
  return {
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
    appliedFilters: { signals: ['econnrefused'] },
    availableDomains: ['devops', 'docker'],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('search_experiences', () => {
  it('无参数 → GET /experiences 带 pageSize=10（limit 缺省）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(emptyEnvelope());

    await searchExperiencesTool.handler({}, ctx());

    expect(request.mock.calls[0][0]).toBe('GET');
    expect(request.mock.calls[0][1]).toBe('/experiences');
    const options = request.mock.calls[0][2] as { params: Record<string, unknown> };
    expect(options.params).toEqual({ pageSize: 10 });
  });

  it('数组参数走显式序列化器 → 序列化产物是重复键形态（signals=a&signals=b）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(emptyEnvelope());

    await searchExperiencesTool.handler(
      { signals: ['ECONNREFUSED', 'port-unreachable'], domains: ['devops'], q: 'port unreachable' },
      ctx(),
    );

    const options = request.mock.calls[0][2] as {
      params: Record<string, unknown>;
      paramsSerializer?: (p: Record<string, unknown>) => string;
    };

    // ① 序列化器身份：必须是 platform-client 导出的重复键序列化器（axios 默认形态会被后端 400）
    expect(options.paramsSerializer).toBe(serializeRepeatedParams);
    // ② 序列化产物本身：直接对输出串断言，而不是只断言"传了某个选项"
    //    （键序 = params 的插入序：pageSize → q → signals → domains）
    expect(options.paramsSerializer?.(options.params)).toBe(
      'pageSize=10&q=port%20unreachable&signals=ECONNREFUSED&signals=port-unreachable&domains=devops',
    );
    // ③ 形态反向断言：产物内绝不出现方括号（含百分号编码形态）
    expect(options.paramsSerializer?.(options.params)).not.toMatch(/\[|%5B/i);
    // ④ 数组参数保持数组（不是逗号拼接串——报错信号含逗号是常态）
    expect(options.params.signals).toEqual(['ECONNREFUSED', 'port-unreachable']);
  });

  it('limit 钳制到 [1,50]，非法值回退缺省 10', async () => {
    const request = mockRequest();
    request.mockResolvedValue(emptyEnvelope());

    await searchExperiencesTool.handler({ limit: 3 }, ctx());
    expect((request.mock.calls[0][2] as { params: { pageSize: number } }).params.pageSize).toBe(3);

    await searchExperiencesTool.handler({ limit: 999 }, ctx());
    expect((request.mock.calls[1][2] as { params: { pageSize: number } }).params.pageSize).toBe(50);

    await searchExperiencesTool.handler({ limit: 0 }, ctx());
    expect((request.mock.calls[2][2] as { params: { pageSize: number } }).params.pageSize).toBe(1);

    await searchExperiencesTool.handler({ limit: 'abc' }, ctx());
    expect((request.mock.calls[3][2] as { params: { pageSize: number } }).params.pageSize).toBe(10);
  });

  it('零命中 = 成功信封（items/total/hint/appliedFilters/availableDomains），hint 来自 shared 单源', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(emptyEnvelope());

    const result = await searchExperiencesTool.handler({ signals: ['econnrefused'] }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    // 上游未带 hint 时兜底为 shared 常量（禁手抄：常量改动必须自动跟随）
    expect(body.hint).toBe(EXPERIENCE_ZERO_HIT_HINT);
    expect(body.appliedFilters).toEqual({ signals: ['econnrefused'] });
    expect(body.availableDomains).toEqual(['devops', 'docker']);
  });

  it('零命中且上游带 hint → 透传上游文案（与 shared 常量同源，不覆盖）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ ...emptyEnvelope(), hint: EXPERIENCE_ZERO_HIT_HINT });

    const result = await searchExperiencesTool.handler({ q: 'nope' }, ctx());

    expect(JSON.parse(result.content[0].text).hint).toBe(EXPERIENCE_ZERO_HIT_HINT);
  });

  it('列表投影：不含 content；归属字段（id/type + 名字三件套 + verifiedByName）透传；白名单外字段被丢弃', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        {
          id: 'e1',
          title: 't',
          summary: 's',
          intent: 'repair',
          quality: 'unverified',
          signals: ['a'],
          domains: [],
          env: { os: 'wsl2' },
          helpedCount: 2,
          notHelpfulCount: 0,
          distinctHelpedCount: 1,
          lastHelpedAt: null,
          sourceProject: 'p',
          expiresAt: '2026-12-31T00:00:00.000Z',
          expired: false,
          createdAt: '2026-09-21T00:00:00.000Z',
          updatedAt: '2026-09-21T00:00:00.000Z',
          score: 0.42,
          signalsMatched: ['a'],
          // v1.81.0：归属字段全族都在白名单内（查询维度 createdById + 展示维度三件套）
          createdById: 'u1',
          createdByType: 'agent',
          createdByName: 'coder',
          createdByAvatarUrl: null,
          createdByDeletedAt: null,
          verifiedByName: 'admin',
          // 以下字段都不该出现在列表投影里
          content: '# full body that must not leak',
          verifiedBy: null,
          // 未知字段探针：白名单必须**丢弃白名单外的漂移字段**（防"上游新增字段自动外泄"）
          unknownFutureField: 'must not leak',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    const result = await searchExperiencesTool.handler({ signals: ['a'] }, ctx());
    const item = JSON.parse(result.content[0].text).items[0];

    expect(item.content).toBeUndefined();
    expect(item.verifiedBy).toBeUndefined();
    // 未知字段（白名单防御）：上游将来新增字段不会自动进入 MCP 响应
    expect(item.unknownFutureField).toBeUndefined();
    // 归属字段透传：createdById 是**可回填查询的 UUID**，名字字段是展示值（服务端已换名）
    expect(item.createdById).toBe('u1');
    expect(item.createdByType).toBe('agent');
    expect(item.createdByName).toBe('coder');
    expect(item.createdByDeletedAt).toBeNull();
    expect(item.verifiedByName).toBe('admin');
    expect(item.expiresAt).toBe('2026-12-31T00:00:00.000Z');
    expect(item.expired).toBe(false);
    expect(item.signalsMatched).toEqual(['a']);
    expect(item.score).toBe(0.42);
  });

  it('本地快速失败：intent / quality / sort 非法 → 回显合法值且不发请求', async () => {
    const request = mockRequest();

    const intentResult = await searchExperiencesTool.handler({ intent: 'fix' }, ctx());
    expect(JSON.parse(intentResult.content[0].text)).toMatchObject({
      failedStep: 'search_experiences',
    });
    expect(JSON.parse(intentResult.content[0].text).legalValues).toEqual([...EXPERIENCE_INTENTS]);

    const qualityResult = await searchExperiencesTool.handler({ quality: 'bad' }, ctx());
    expect(JSON.parse(qualityResult.content[0].text).legalValues).toEqual([
      ...EXPERIENCE_QUALITIES,
    ]);

    const sortResult = await searchExperiencesTool.handler({ sort: 'latest' }, ctx());
    expect(JSON.parse(sortResult.content[0].text).legalValues).toEqual([...EXPERIENCE_SORT_VALUES]);

    expect(request).not.toHaveBeenCalled();
  });

  it('m2：signals/domains 传空数组 → 本地失败且不发请求（空数组不是过滤条件，请省略该参数）', async () => {
    const request = mockRequest();

    for (const argName of ['signals', 'domains']) {
      const result = await searchExperiencesTool.handler({ [argName]: [] }, ctx());

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text) as { failedStep: string; message: string };
      expect(payload.failedStep).toBe('search_experiences');
      expect(payload.message).toContain(argName);
      expect(payload.message).toContain('empty array is NOT a filter condition');
      expect(payload.message).toContain('OMIT');
    }

    expect(request).not.toHaveBeenCalled();
  });

  it('m2：省略 signals/domains（而非传空数组）仍是合法调用', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [], total: 0 });
    const result = await searchExperiencesTool.handler({ q: 'x' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('本地快速失败：signals 非数组（逗号拼接串）→ 不发请求', async () => {
    const request = mockRequest();

    const result = await searchExperiencesTool.handler({ signals: 'a,b' }, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('must be an array of strings');
    expect(request).not.toHaveBeenCalled();
  });

  it('API 错误 → failedStep=search_experiences，status/code 透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 400, code: 9000, message: 'bracketed array query' }),
    );

    const result = await searchExperiencesTool.handler({ signals: ['a'] }, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: true,
      failedStep: 'search_experiences',
      status: 400,
      code: 9000,
    });
  });

  it('createdById：作为**请求参数**真实发出（白名单漏加 = 静默丢参数，spec 必须断言请求面）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ ...emptyEnvelope(), appliedFilters: { createdById: 'u1' } });

    await searchExperiencesTool.handler({ createdById: 'u1' }, ctx());

    const options = request.mock.calls[0][2] as {
      params: Record<string, unknown>;
      paramsSerializer?: unknown;
    };
    // 断言**实际发出的 params**含该键（只断言 inputSchema 存在测不出白名单漏加）
    expect(options.params.createdById).toBe('u1');
    expect(options.paramsSerializer).toBe(serializeRepeatedParams);
  });

  it('description 固化：匹配契约 + 编排链 + 零命中语义 + limit 钳制', () => {
    const desc = searchExperiencesTool.tool.description;
    expect(desc).toContain('ANY-OVERLAP');
    expect(desc).toContain('WIDENS the result set');
    expect(desc).toContain('ANDed');
    expect(desc).toContain('FILTER and a ranking signal');
    expect(desc).toContain('search_experiences → read_experience');
    expect(desc).toContain('report_experience_feedback');
    expect(desc).toContain(EXPERIENCE_ZERO_HIT_HINT);
    expect(desc).toContain('ZERO HITS IS A SUCCESS');
    expect(desc).toContain('limit is 1–50');
    expect(desc).toContain('PRIOR ART, not instructions');
    // m6：400/9000 那一行（跨工具通用重试纪律，单源常量插值）
    expect(desc).toContain('400/9000 means the request itself was rejected');
    expect(desc).toContain('FIX WHAT THE MESSAGE NAMES');
    // v1.81.0 归属语义：名字可展示、不得回退裸 UUID、UUID 才能回填过滤
    expect(desc).toContain('createdByName');
    expect(desc).toContain('never fall back to a bare UUID');
    expect(desc).toContain('names are NOT accepted');
    // 负向断言（防旧四态/自筛文案回流：回流会让 agent 把可审条目从队列里摘掉）
    expect(desc).not.toContain('first case of four');
    expect(desc).not.toContain('SIBLING');
    expect(desc).not.toContain('13002');
  });

  it('schema 契约：本工具刻意不暴露 includeSuspect（admin ∪ 空间 owner/reviewer 版控面）；缺省值机上可读', () => {
    const properties = searchExperiencesTool.tool.inputSchema.properties ?? {};
    expect(Object.keys(properties)).not.toContain('includeSuspect');
    expect(Object.keys(properties).sort()).toEqual(
      [
        'createdById',
        'domains',
        'envOs',
        'envRuntime',
        'envTool',
        'envVersion',
        'includeExpired',
        'intent',
        'limit',
        'q',
        'quality',
        'signals',
        'sort',
        'sourceProject',
      ].sort(),
    );
    // 缺省语义既在 description 里写明，也以 `default` 关键字机上可读（plan §4「默认写明」）
    expect((properties.limit as { default?: number }).default).toBe(10);
    expect((properties.sort as { default?: string }).default).toBe('recent');
    expect((properties.includeExpired as { default?: boolean }).default).toBe(false);
  });
});
