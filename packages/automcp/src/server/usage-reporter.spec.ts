/**
 * usage-reporter 单测（usage stats D4b）：上报载荷形状、fire-and-forget 语义、失败留痕
 *
 * 覆盖 plan §4 批 3.6 的两条：上报失败静默 + console.warn / viaFallbackAuth 标记载荷。
 */

import axios from 'axios';
import { buildAuthHeaders, reportToolInvocation } from './usage-reporter';
import type { AuthConfig } from '../types';

jest.mock('axios');
const mockedAxios = axios as unknown as jest.Mock;

/** 等 fire-and-forget 的 then/catch 跑完（上报不返回 Promise，测试必须自己让出） */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 基准上报输入（各用例只覆盖自己关心的字段） */
const baseOptions = {
  baseUrl: 'http://localhost:8743/api/v1',
  auth: { type: 'apiKey', apiKey: 'key-1' } as AuthConfig,
  toolName: 'read_doc',
  surface: 'mcp',
  ok: true,
  latencyMs: 12,
  viaFallbackAuth: false,
};

describe('reportToolInvocation（D4b 上报通道）', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('POST {baseUrl}/system/usage-events，带认证头与完整载荷；202 不留痕', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 202, data: { accepted: true } });

    reportToolInvocation(baseOptions);
    await flush();

    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'http://localhost:8743/api/v1/system/usage-events',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-API-Key': 'key-1',
        }),
        data: { toolName: 'read_doc', surface: 'mcp', ok: true, latencyMs: 12 },
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('baseUrl 尾部斜杠不产生双斜杠', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 202 });

    reportToolInvocation({ ...baseOptions, baseUrl: 'http://localhost:8743/api/v1/' });
    await flush();

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:8743/api/v1/system/usage-events' }),
    );
  });

  it('viaFallbackAuth=true → 载荷带该字段（后端据此落 actor_type=system）', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 202 });

    reportToolInvocation({ ...baseOptions, viaFallbackAuth: true });
    await flush();

    expect(mockedAxios.mock.calls[0][0].data.viaFallbackAuth).toBe(true);
  });

  it('viaFallbackAuth=false → 载荷不含该字段（省略即"非 fallback"）', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 202 });

    reportToolInvocation({ ...baseOptions, viaFallbackAuth: false });
    await flush();

    expect(mockedAxios.mock.calls[0][0].data).not.toHaveProperty('viaFallbackAuth');
  });

  it('latencyMs 归一化为非负整数（DTO 是 @IsInt @Min(0)）', async () => {
    mockedAxios.mockResolvedValue({ status: 202 });

    reportToolInvocation({ ...baseOptions, latencyMs: 12.6 });
    reportToolInvocation({ ...baseOptions, latencyMs: -3 });
    reportToolInvocation({ ...baseOptions, latencyMs: Number.NaN });
    await flush();

    expect(mockedAxios.mock.calls.map((call) => call[0].data.latencyMs)).toEqual([13, 0, 0]);
  });

  it('网络失败：不抛异常（fail-open），console.warn 恰好一行', async () => {
    mockedAxios.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8743'));

    expect(() => reportToolInvocation(baseOptions)).not.toThrow();
    await flush();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('read_doc');
    expect(line).toContain('ECONNREFUSED');
  });

  it('非 2xx（401/400）：同样留一行 warn（只 warn transport error 会让计数静默丢失）', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 401, data: { message: 'unauthorized' } });

    reportToolInvocation(baseOptions);
    await flush();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('401');
  });

  it('不返回 Promise（调用点无需 await，不阻塞 tools/call 响应）', () => {
    mockedAxios.mockResolvedValueOnce({ status: 202 });

    expect(reportToolInvocation(baseOptions)).toBeUndefined();
  });
});

describe('buildAuthHeaders（凭据 → 头上报复用）', () => {
  it('apiKey → X-API-Key', () => {
    expect(buildAuthHeaders({ type: 'apiKey', apiKey: 'k' })).toEqual({ 'X-API-Key': 'k' });
  });

  it('bearer → Authorization: Bearer', () => {
    expect(buildAuthHeaders({ type: 'bearer', bearerToken: 't' })).toEqual({
      Authorization: 'Bearer t',
    });
  });

  it('basic → Authorization: Basic base64', () => {
    expect(buildAuthHeaders({ type: 'basic', username: 'u', password: 'p' })).toEqual({
      Authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
    });
  });

  it('凭据字段缺失 → 空头对象（不发半截认证头）', () => {
    expect(buildAuthHeaders({ type: 'apiKey' })).toEqual({});
    expect(buildAuthHeaders({ type: 'bearer' })).toEqual({});
    expect(buildAuthHeaders({ type: 'basic', username: 'u' })).toEqual({});
  });
});
