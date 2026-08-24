/**
 * PlatformApiClient 单元测试
 *
 * 覆盖：信封剥壳、4xx 归一化、网络错误、三种 auth header 构造、默认 timeout。
 */

import { PlatformApiClient, PlatformApiError } from './platform-client';
import axios from 'axios';
import type { AuthConfig } from '@agent-chamber/automcp';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/** 创建 mock axios instance */
function mockInstance() {
  const instance = {
    request: jest.fn(),
  } as unknown as jest.Mocked<ReturnType<typeof axios.create>>;
  mockedAxios.create.mockReturnValue(instance as any);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PlatformApiClient', () => {
  describe('构造与认证', () => {
    it('不传 auth 时 axios.create 不带认证头', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { code: 200, message: 'success', data: { id: 'me' } },
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      await client.request('GET', '/agents/me');

      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'http://localhost:8743/api/v1', timeout: 120_000 }),
      );
      // headers 中不应有 X-API-Key 或 Authorization
      const callHeaders = inst.request.mock.calls[0][0]?.headers ?? {};
      expect(callHeaders['X-API-Key']).toBeUndefined();
      expect(callHeaders['Authorization']).toBeUndefined();
    });

    it('apiKey auth → 设置 X-API-Key header', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { code: 200, message: 'success', data: {} },
        headers: {},
        config: {} as any,
      });

      const auth: AuthConfig = { type: 'apiKey', apiKey: 'my-key-123' };
      const client = new PlatformApiClient('http://localhost:8743/api/v1', auth);
      await client.request('GET', '/agents/me');

      const callHeaders = inst.request.mock.calls[0][0]?.headers ?? {};
      expect(callHeaders['X-API-Key']).toBe('my-key-123');
    });

    it('bearer auth → 设置 Authorization: Bearer header', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { code: 200, message: 'success', data: {} },
        headers: {},
        config: {} as any,
      });

      const auth: AuthConfig = { type: 'bearer', bearerToken: 'token-abc' };
      const client = new PlatformApiClient('http://localhost:8743/api/v1', auth);
      await client.request('GET', '/agents/me');

      const callHeaders = inst.request.mock.calls[0][0]?.headers ?? {};
      expect(callHeaders['Authorization']).toBe('Bearer token-abc');
    });

    it('basic auth → 设置 Authorization: Basic base64 header', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { code: 200, message: 'success', data: {} },
        headers: {},
        config: {} as any,
      });

      const auth: AuthConfig = { type: 'basic', username: 'u', password: 'p' };
      const client = new PlatformApiClient('http://localhost:8743/api/v1', auth);
      await client.request('GET', '/agents/me');

      const callHeaders = inst.request.mock.calls[0][0]?.headers ?? {};
      const expected = `Basic ${Buffer.from('u:p').toString('base64')}`;
      expect(callHeaders['Authorization']).toBe(expected);
    });

    it('带 body 时设置 Content-Type: application/json', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { code: 200, message: 'success', data: {} },
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      await client.request('POST', '/topics', { body: { title: 'test' } });

      const callHeaders = inst.request.mock.calls[0][0]?.headers ?? {};
      expect(callHeaders['Content-Type']).toBe('application/json');
    });

    it('无 body 时不设置 Content-Type', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { code: 200, message: 'success', data: {} },
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      await client.request('GET', '/agents/me');

      const callHeaders = inst.request.mock.calls[0][0]?.headers ?? {};
      expect(callHeaders['Content-Type']).toBeUndefined();
    });
  });

  describe('2xx 信封剥壳', () => {
    it('标准信封 {code,message,data} → 返回 data', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { code: 200, message: 'success', data: { id: 'abc', name: 'Agent' } },
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      const result = await client.request('GET', '/agents/me');
      expect(result).toEqual({ id: 'abc', name: 'Agent' });
    });

    it('非标准响应（无 data 字段）→ 返回整个 body', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { hello: 'world' },
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      const result = await client.request('GET', '/custom');
      expect(result).toEqual({ hello: 'world' });
    });
  });

  describe('非 2xx 归一化', () => {
    it('结构化错误信封（含 code/message/data）→ PlatformApiError 含全部字段', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 404,
        statusText: 'Not Found',
        data: { code: 1001, message: 'Topic not found', data: { field: 'id' } },
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      await expect(client.request('GET', '/topics/x')).rejects.toThrow(PlatformApiError);

      try {
        await client.request('GET', '/topics/x');
      } catch (err: unknown) {
        const e = err as PlatformApiError;
        expect(e.status).toBe(404);
        expect(e.code).toBe(1001);
        expect(e.message).toBe('Topic not found');
        expect(e.details).toEqual({ field: 'id' });
      }
    });

    it('结构化错误无 code → code 为 undefined', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 400,
        statusText: 'Bad Request',
        data: { message: 'Validation failed' },
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      await expect(client.request('POST', '/topics')).rejects.toMatchObject({
        status: 400,
        message: 'Validation failed',
      });
    });

    it('非结构化错误 → 回退状态行 + 原始 body', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 500,
        statusText: 'Internal Server Error',
        data: '<html>Error</html>',
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      await expect(client.request('GET', '/crash')).rejects.toMatchObject({
        status: 500,
        message: expect.stringContaining('HTTP 500'),
      });
    });
  });

  describe('网络错误', () => {
    it('axios 抛异常 → PlatformApiError with Request failed', async () => {
      const inst = mockInstance();
      inst.request.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      await expect(client.request('GET', '/agents/me')).rejects.toMatchObject({
        message: expect.stringContaining('Request failed: connect ECONNREFUSED'),
      });
    });
  });

  describe('query params 与 body 透传', () => {
    it('params → axios params 正确透传', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { code: 200, message: 'success', data: { items: [] } },
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      await client.request('GET', '/tasks', {
        params: { assigneeId: 'u1', status: 'todo,in_progress', pageSize: 20 },
      });

      const callConfig = inst.request.mock.calls[0][0];
      expect(callConfig.params).toEqual({
        assigneeId: 'u1',
        status: 'todo,in_progress',
        pageSize: 20,
      });
    });

    it('body → axios data 正确透传', async () => {
      const inst = mockInstance();
      inst.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { code: 200, message: 'success', data: { id: 't1' } },
        headers: {},
        config: {} as any,
      });

      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      await client.request('POST', '/topics', {
        body: { title: 'Hello', visibility: 'private' },
      });

      const callConfig = inst.request.mock.calls[0][0];
      expect(callConfig.data).toEqual({ title: 'Hello', visibility: 'private' });
    });
  });

  describe('validateStatus', () => {
    it('validateStatus 为 () => true（不抛 axios 异常）', () => {
      const client = new PlatformApiClient('http://localhost:8743/api/v1');
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ validateStatus: expect.any(Function) }),
      );
    });
  });
});
