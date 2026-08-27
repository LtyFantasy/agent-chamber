/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plans/miss-martian-polaris-superboy.md §Step 4
 *   - 补充: .kimi/plans/miss-martian-polaris-superboy.md §核心映射规则
 *
 * [踩坑索引] -
 *
 * [铁律关联] #7(编译优先) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import axios from 'axios';
import { HttpProxy } from './http-proxy';
import type { ToolMapping, AuthConfig } from '../types';

jest.mock('axios');
const mockedAxios = axios as unknown as jest.Mock;

/**
 * 辅助函数：创建基础 ToolMapping
 */
function makeMapping(overrides: Partial<ToolMapping> = {}): ToolMapping {
  return {
    tool: {
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    operation: {
      operationId: 'testOperation',
      method: 'get',
      path: '/test',
      summary: 'Test',
      parameters: [],
      responses: {},
    },
    paramLocations: {},
    ...overrides,
  };
}

describe('HttpProxy', () => {
  let proxy: HttpProxy;

  beforeEach(() => {
    proxy = new HttpProxy('https://api.example.com');
    jest.clearAllMocks();
  });

  describe('baseUrl 与 operation path 重复前缀处理', () => {
    it('should avoid double pathname when path already contains baseUrl prefix', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { id: '1' },
      });

      // baseUrl 包含 /api/v1，而 operation path 也以 /api/v1 开头
      const proxyWithPrefix = new HttpProxy('https://api.example.com/api/v1');
      const mapping = makeMapping({
        operation: {
          operationId: 'listTopics',
          method: 'get',
          path: '/api/v1/topics',
          summary: 'List topics',
          parameters: [],
          responses: {},
        },
      });

      await proxyWithPrefix.execute(mapping, {});

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://api.example.com/api/v1/topics',
        }),
      );
    });

    it('should not strip path when there is no duplicate prefix', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { id: '1' },
      });

      const mapping = makeMapping({
        operation: {
          operationId: 'listTopics',
          method: 'get',
          path: '/topics',
          summary: 'List topics',
          parameters: [],
          responses: {},
        },
      });

      await proxy.execute(mapping, {});

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://api.example.com/topics',
        }),
      );
    });
  });

  describe('基本 GET 请求（path + query 参数）', () => {
    it('should interpolate path params and include query params', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { id: '123', name: 'Test' },
      });

      const mapping = makeMapping({
        operation: {
          operationId: 'getTopic',
          method: 'get',
          path: '/topics/{id}',
          summary: 'Get topic',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          id: { in: 'path', name: 'id' },
          page: { in: 'query', name: 'page' },
          limit: { in: 'query', name: 'limit' },
        },
      });

      const result = await proxy.execute(mapping, { id: 'abc-123', page: 1, limit: 10 });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'get',
          url: 'https://api.example.com/topics/abc-123?page=1&limit=10',
          data: undefined,
        }),
      );
      expect(result.content[0].text).toBe(JSON.stringify({ id: '123', name: 'Test' }));
      expect(result.isError).toBeUndefined();
    });

    it('should skip undefined/null query params', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: [],
      });

      const mapping = makeMapping({
        operation: {
          operationId: 'listTopics',
          method: 'get',
          path: '/topics',
          summary: 'List topics',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          page: { in: 'query', name: 'page' },
          limit: { in: 'query', name: 'limit' },
        },
      });

      await proxy.execute(mapping, { page: 1, limit: null });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://api.example.com/topics?page=1',
        }),
      );
    });
  });

  describe('POST 请求（body object 还原）', () => {
    it('should assemble body from multiple body properties', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 201,
        statusText: 'Created',
        data: { id: 'new-id', title: 'Hello' },
      });

      const mapping = makeMapping({
        operation: {
          operationId: 'createTopic',
          method: 'post',
          path: '/topics',
          summary: 'Create topic',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          title: { in: 'body', name: 'title' },
          description: { in: 'body', name: 'description' },
        },
      });

      const result = await proxy.execute(mapping, {
        title: 'Hello World',
        description: 'A test topic',
      });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'post',
          url: 'https://api.example.com/topics',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          data: { title: 'Hello World', description: 'A test topic' },
        }),
      );
      expect(result.isError).toBeUndefined();
    });
  });

  describe('POST 请求（body primitive）', () => {
    it('should use args.body directly for primitive body', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { success: true },
      });

      const mapping = makeMapping({
        operation: {
          operationId: 'sendMessage',
          method: 'post',
          path: '/messages',
          summary: 'Send message',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          body: { in: 'body', name: 'body' },
        },
      });

      await proxy.execute(mapping, { body: 'Hello there' });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'Hello there',
        }),
      );
    });

    it('should use args.body directly for array body', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: [],
      });

      const mapping = makeMapping({
        operation: {
          operationId: 'batchCreate',
          method: 'post',
          path: '/batch',
          summary: 'Batch create',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          body: { in: 'body', name: 'body' },
        },
      });

      await proxy.execute(mapping, { body: ['a', 'b', 'c'] });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: ['a', 'b', 'c'],
        }),
      );
    });
  });

  describe('Path interpolation', () => {
    it('should support {paramName} style', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, statusText: 'OK', data: {} });

      const mapping = makeMapping({
        operation: {
          operationId: 'getTopic',
          method: 'get',
          path: '/topics/{id}/comments/{commentId}',
          summary: 'Get comment',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          id: { in: 'path', name: 'id' },
          comment_id: { in: 'path', name: 'commentId' },
        },
      });

      await proxy.execute(mapping, { id: 'topic-1', comment_id: 'cmt-2' });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://api.example.com/topics/topic-1/comments/cmt-2',
        }),
      );
    });

    it('should support :paramName style', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, statusText: 'OK', data: {} });

      const mapping = makeMapping({
        operation: {
          operationId: 'getUser',
          method: 'get',
          path: '/users/:userId/posts/:postId',
          summary: 'Get post',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          userId: { in: 'path', name: 'userId' },
          postId: { in: 'path', name: 'postId' },
        },
      });

      await proxy.execute(mapping, { userId: 'u1', postId: 'p2' });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://api.example.com/users/u1/posts/p2',
        }),
      );
    });
  });

  describe('Query 参数 URL encoding', () => {
    it('should URL-encode special characters in query params', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, statusText: 'OK', data: {} });

      const mapping = makeMapping({
        operation: {
          operationId: 'searchTopics',
          method: 'get',
          path: '/topics',
          summary: 'Search',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          q: { in: 'query', name: 'q' },
        },
      });

      await proxy.execute(mapping, { q: 'hello world & more=stuff' });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('q=hello+world+%26+more%3Dstuff'),
        }),
      );
    });

    it('should join array query params with commas', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, statusText: 'OK', data: {} });

      const mapping = makeMapping({
        operation: {
          operationId: 'filterTopics',
          method: 'get',
          path: '/topics',
          summary: 'Filter',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          tags: { in: 'query', name: 'tags' },
        },
      });

      await proxy.execute(mapping, { tags: ['a', 'b', 'c'] });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('tags=a%2Cb%2Cc'),
        }),
      );
    });

    it('should use original name for query params with prefix', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, statusText: 'OK', data: {} });

      const mapping = makeMapping({
        operation: {
          operationId: 'getTopic',
          method: 'get',
          path: '/topics',
          summary: 'Get topic',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          // body param 'name' conflicts with query param 'name'
          name: { in: 'body', name: 'name' },
          query_name: { in: 'query', name: 'name' },
        },
      });

      await proxy.execute(mapping, { name: 'body-name', query_name: 'query-name' });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('name=query-name'),
          data: { name: 'body-name' },
        }),
      );
    });
  });

  describe('API Key 认证头注入', () => {
    it('should inject X-API-Key header', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, statusText: 'OK', data: {} });

      const auth: AuthConfig = { type: 'apiKey', apiKey: 'secret-key-123' };
      const proxyWithAuth = new HttpProxy('https://api.example.com', auth);

      await proxyWithAuth.execute(makeMapping(), {});

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-API-Key': 'secret-key-123' }),
        }),
      );
    });
  });

  describe('Bearer Token 认证头注入', () => {
    it('should inject Authorization: Bearer header', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, statusText: 'OK', data: {} });

      const auth: AuthConfig = { type: 'bearer', bearerToken: 'my-jwt-token' };
      const proxyWithAuth = new HttpProxy('https://api.example.com', auth);

      await proxyWithAuth.execute(makeMapping(), {});

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer my-jwt-token' }),
        }),
      );
    });
  });

  describe('Basic Auth 认证头注入', () => {
    it('should inject Authorization: Basic header', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, statusText: 'OK', data: {} });

      const auth: AuthConfig = { type: 'basic', username: 'admin', password: 'secret' };
      const proxyWithAuth = new HttpProxy('https://api.example.com', auth);

      await proxyWithAuth.execute(makeMapping(), {});

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}`,
          }),
        }),
      );
    });
  });

  describe('HTTP 4xx 错误处理', () => {
    it('should normalize structured upstream error envelope ({code, message}) for agent consumption', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 404,
        statusText: 'Not Found',
        data: { message: 'Topic not found', code: 'NOT_FOUND' },
      });

      const result = await proxy.execute(makeMapping(), {});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
      expect(parsed.error).toBe(true);
      expect(parsed.status).toBe(404);
      expect(parsed.message).toBe('Topic not found');
      expect(parsed.code).toBe('NOT_FOUND');
      // 不再包含 HTTP 状态行噪音
      expect(result.content[0].text).not.toContain('HTTP 404');
    });

    it('should pass through business error details (data field) for agent self-correction', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 400,
        statusText: 'Bad Request',
        data: {
          message: 'assigneeId must be a UUID',
          code: 400,
          data: { errors: ['assigneeId must be a UUID', 'title should not be empty'] },
        },
      });

      const result = await proxy.execute(makeMapping(), {});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
      expect(parsed.code).toBe(400);
      expect(parsed.details).toEqual({
        errors: ['assigneeId must be a UUID', 'title should not be empty'],
      });
    });

    it('should keep 409 conflict message machine-readable', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 409,
        statusText: 'Conflict',
        data: { message: 'Email already exists', code: 9001 },
      });

      const result = await proxy.execute(makeMapping(), {});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
      expect(parsed.status).toBe(409);
      expect(parsed.code).toBe(9001);
    });

    it('should fall back to status line for unstructured upstream errors', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 500,
        statusText: 'Internal Server Error',
        data: { error: 'Database connection failed' },
      });

      const result = await proxy.execute(makeMapping(), {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('HTTP 500: Internal Server Error');
      expect(result.content[0].text).toContain('Database connection failed');
    });
  });

  describe('网络错误处理', () => {
    it('should return isError=true on network failure', async () => {
      mockedAxios.mockRejectedValueOnce(new Error('Network Error'));

      const result = await proxy.execute(makeMapping(), {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Request failed: Network Error');
    });

    it('should handle timeout errors', async () => {
      const axiosError = new Error('timeout of 60000ms exceeded');
      mockedAxios.mockRejectedValueOnce(axiosError);

      const result = await proxy.execute(makeMapping(), {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout of 60000ms exceeded');
    });
  });

  describe('path 参数缺失处理', () => {
    it('should return error when path param is missing', async () => {
      const mapping = makeMapping({
        operation: {
          operationId: 'getTopic',
          method: 'get',
          path: '/topics/{id}',
          summary: 'Get topic',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          id: { in: 'path', name: 'id' },
        },
      });

      const result = await proxy.execute(mapping, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required path parameter');
    });

    it('should return error when colon-style path param is missing', async () => {
      const mapping = makeMapping({
        operation: {
          operationId: 'getUser',
          method: 'get',
          path: '/users/:userId',
          summary: 'Get user',
          parameters: [],
          responses: {},
        },
        paramLocations: {
          userId: { in: 'path', name: 'userId' },
        },
      });

      const result = await proxy.execute(mapping, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required path parameter');
    });
  });

  describe('响应格式化', () => {
    it('should format object response as compact JSON', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: { items: [1, 2, 3], total: 3 },
      });

      const result = await proxy.execute(makeMapping(), {});

      expect(result.content[0].text).toBe('{"items":[1,2,3],"total":3}');
    });

    it('should format array response as compact JSON', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: [{ id: '1' }, { id: '2' }],
      });

      const result = await proxy.execute(makeMapping(), {});

      expect(result.content[0].text).toBe('[{"id":"1"},{"id":"2"}]');
    });

    it('should return string response directly', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: 'Hello world',
      });

      const result = await proxy.execute(makeMapping(), {});

      expect(result.content[0].text).toBe('Hello world');
    });

    it('should return number response as string', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: 42,
      });

      const result = await proxy.execute(makeMapping(), {});

      expect(result.content[0].text).toBe('42');
    });

    it('should return null as string null', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        data: null,
      });

      const result = await proxy.execute(makeMapping(), {});

      expect(result.content[0].text).toBe('null');
    });
  });
});
