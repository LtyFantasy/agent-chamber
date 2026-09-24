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

import express from 'express';
import request from 'supertest';
import { McpServer } from './mcp-server';
import { HttpProxy } from '../proxy/http-proxy';
import { getToolContext } from './tool-context';
import { reportToolInvocation } from './usage-reporter';
import type { ToolMapping, ToolCallResult, CustomTool, CustomToolContext } from '../types';

// Mock HttpProxy
jest.mock('../proxy/http-proxy');
const MockedHttpProxy = HttpProxy as jest.MockedClass<typeof HttpProxy>;

// 上报是 fire-and-forget 的副作用：mock 掉发送层才能在 tools/call 路径上断言载荷形状
jest.mock('./usage-reporter');
const mockedReport = reportToolInvocation as jest.MockedFunction<typeof reportToolInvocation>;

describe('McpServer', () => {
  let app: express.Application;
  let proxy: jest.Mocked<HttpProxy>;
  let server: McpServer;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    proxy = new HttpProxy('https://api.example.com') as jest.Mocked<HttpProxy>;
    MockedHttpProxy.mockClear();
    server = new McpServer(app, 9876, proxy);
  });

  afterEach(async () => {
    await server.stop();
  });

  /**
   * 辅助函数：创建基础 ToolMapping
   */
  function makeMapping(name: string, overrides: Partial<ToolMapping> = {}): ToolMapping {
    return {
      tool: {
        name,
        description: `Tool ${name}`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      operation: {
        operationId: name,
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

  describe('initialize 请求', () => {
    it('should return correct initialize result', async () => {
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe(1);
      expect(res.body.result).toEqual({
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: 'automcp',
          version: '0.1.0',
        },
      });
    });
  });

  describe('tools/list 请求', () => {
    it('should return all registered tool definitions', async () => {
      const mappings = [makeMapping('list_topics'), makeMapping('create_topic')];
      server.registerTools(mappings);
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe(2);
      expect(res.body.result.tools).toHaveLength(2);
      expect(res.body.result.tools[0].name).toBe('list_topics');
      expect(res.body.result.tools[1].name).toBe('create_topic');
    });

    it('should return empty tools array when no tools registered', async () => {
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
        });

      expect(res.status).toBe(200);
      expect(res.body.result.tools).toEqual([]);
    });
  });

  describe('tools/call 请求', () => {
    it('should successfully call proxy and return result', async () => {
      const mockResult: ToolCallResult = {
        content: [{ type: 'text', text: '{"id": "abc"}' }],
      };
      proxy.execute.mockResolvedValueOnce(mockResult);

      const mappings = [makeMapping('list_topics')];
      server.registerTools(mappings);
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'list_topics',
            arguments: { page: 1 },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe(4);
      // proxy 返回的 JSON text 经框架归一化收敛为单载荷：text 降为占位，数据在 structuredContent
      expect(res.body.result).toEqual({
        content: [{ type: 'text', text: '[structured]' }],
        structuredContent: { id: 'abc' },
      });
      expect(proxy.execute).toHaveBeenCalledWith(
        expect.objectContaining({ tool: expect.objectContaining({ name: 'list_topics' }) }),
        { page: 1 },
        undefined,
      );
    });

    it('should return error when tool not found', async () => {
      server.registerTools([makeMapping('list_topics')]);
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'non_existent_tool',
            arguments: {},
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.result).toEqual({
        content: [{ type: 'text', text: 'Tool not found: non_existent_tool' }],
        isError: true,
      });
    });

    it('should handle missing params gracefully', async () => {
      server.registerTools([makeMapping('list_topics')]);
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
        });

      expect(res.status).toBe(200);
      expect(res.body.result).toEqual({
        content: [{ type: 'text', text: 'Missing params for tools/call' }],
        isError: true,
      });
    });
  });

  describe('未知 method', () => {
    it('should return -32601 for unknown method', async () => {
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'unknown/method',
        });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe(7);
      expect(res.body.error).toEqual({
        code: -32601,
        message: 'Method not found: unknown/method',
      });
    });
  });

  describe('缺少 method', () => {
    it('should return -32600 when method is missing', async () => {
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 8,
        });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe(8);
      expect(res.body.error).toEqual({
        code: -32600,
        message: 'Invalid request: missing method or id',
      });
    });

    it('should return -32600 when method is empty string', async () => {
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 9,
          method: '',
        });

      expect(res.status).toBe(200);
      expect(res.body.error).toEqual({
        code: -32600,
        message: 'Invalid request: missing method or id',
      });
    });

    it('should return -32600 when id is missing', async () => {
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          method: 'initialize',
        });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBeNull();
      expect(res.body.error).toEqual({
        code: -32600,
        message: 'Invalid request: missing method or id',
      });
    });
  });

  describe('JSON parse error', () => {
    it('should return -32700 for invalid JSON body', async () => {
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send('not valid json');

      // express.json() middleware returns 400 for invalid JSON
      // before the route handler is invoked
      expect(res.status).toBe(400);
    });
  });

  describe('start/stop 生命周期', () => {
    it('should start server and return URL', async () => {
      const url = await server.start();
      expect(url).toBe('http://localhost:9876');
    });

    it('should stop server without error', async () => {
      await server.start();
      await expect(server.stop()).resolves.toBeUndefined();
    });

    it('should stop gracefully when server was never started', async () => {
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  describe('健康检查', () => {
    it('should return ok on GET /health', async () => {
      await server.start();

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('自定义 basePath', () => {
    afterEach(async () => {
      await server.stop();
    });

    it('should serve JSON-RPC on configured basePath', async () => {
      // 端口 9879（原 9877）：9877 被 Windows 宿主进程占用（WSL2 localhost 转发镜像
      // Windows 端口，WSL 内 ss/lsof 不可见、bind 必 EADDRINUSE——同族坑见 9876/Blender）
      server = new McpServer(app, 9879, proxy, '/mcp-full');
      server.registerTools([makeMapping('custom_path_tool')]);
      await server.start();

      const res = await request(app)
        .post('/mcp-full')
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/list',
        });

      expect(res.status).toBe(200);
      expect(res.body.result.tools).toHaveLength(1);
      expect(res.body.result.tools[0].name).toBe('custom_path_tool');
    });

    it('should not respond on default /mcp when custom basePath is set', async () => {
      server = new McpServer(app, 9878, proxy, '/mcp-full');
      await server.start();

      const res = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/list',
        });

      expect(res.status).toBe(404);
    });
  });

  describe('custom tools', () => {
    /**
     * 辅助函数：创建 CustomTool
     */
    function makeCustomTool(
      name: string,
      handler?: CustomTool['handler'],
      overrides: Partial<CustomTool['tool']> = {},
    ): CustomTool {
      return {
        tool: {
          name,
          description: `Custom tool ${name}`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          ...overrides,
        },
        handler:
          handler ??
          (async () => ({
            content: [{ type: 'text', text: 'ok' }],
          })),
      };
    }

    describe('tools/list 含 custom tools', () => {
      it('① custom tools 出现在 tools/list 尾部', async () => {
        const baseUrl = 'http://localhost:8743/api/v1';
        server = new McpServer(app, 9876, proxy, '/mcp', baseUrl);
        const autoMappings = [makeMapping('auto_tool')];
        server.registerTools(autoMappings);

        const ctA = makeCustomTool('custom_a');
        const ctB = makeCustomTool('custom_b');
        server.registerCustomTools([ctA, ctB]);

        await server.start();

        const res = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
          });

        expect(res.status).toBe(200);
        expect(res.body.result.tools).toHaveLength(3);
        expect(res.body.result.tools[0].name).toBe('auto_tool');
        expect(res.body.result.tools[1].name).toBe('custom_a');
        expect(res.body.result.tools[2].name).toBe('custom_b');
      });
    });

    describe('tools/call 路由到 custom tool', () => {
      it('② handler 收到正确 args 与 ctx（X-API-Key 透传进 ctx.auth）', async () => {
        const baseUrl = 'http://localhost:8743/api/v1';
        server = new McpServer(app, 9876, proxy, '/mcp', baseUrl);

        const handler = jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'done' }],
        });
        const ctFoo = makeCustomTool('foo_tool', handler);
        server.registerCustomTools([ctFoo]);
        await server.start();

        await request(app)
          .post('/mcp')
          .set('X-API-Key', 'my-secret-key')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'foo_tool',
              arguments: { param1: 'val1' },
            },
          });

        expect(handler).toHaveBeenCalledTimes(1);
        // 第一个参数：args
        expect(handler).toHaveBeenCalledWith(
          { param1: 'val1' },
          expect.objectContaining({
            baseUrl: 'http://localhost:8743/api/v1',
            auth: { type: 'apiKey', apiKey: 'my-secret-key' },
          }),
        );
      });

      it('③ client 无 auth header 时 ctx.auth = fallbackAuth', async () => {
        const baseUrl = 'http://localhost:8743/api/v1';
        server = new McpServer(app, 9876, proxy, '/mcp', baseUrl);

        const fallbackAuth = { type: 'apiKey' as const, apiKey: 'fallback-key' };
        const handler = jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'done' }],
        });
        const ctFoo = makeCustomTool('bar_tool', handler);
        server.registerCustomTools([ctFoo], fallbackAuth);
        await server.start();

        // 不传任何 auth header
        await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'bar_tool',
              arguments: {},
            },
          });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(
          {},
          expect.objectContaining({
            baseUrl: 'http://localhost:8743/api/v1',
            auth: { type: 'apiKey', apiKey: 'fallback-key' },
          }),
        );
      });

      it('④ handler 抛异常 → isError:true 文本结果（非 JSON-RPC error）', async () => {
        const baseUrl = 'http://localhost:8743/api/v1';
        server = new McpServer(app, 9876, proxy, '/mcp', baseUrl);

        const handler = jest.fn().mockRejectedValue(new Error('something went wrong'));
        const ctFail = makeCustomTool('fail_tool', handler);
        server.registerCustomTools([ctFail]);
        await server.start();

        const res = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'fail_tool',
              arguments: {},
            },
          });

        expect(res.status).toBe(200);
        // 应该是 JSON-RPC 成功响应，包含 isError:true 的 result（非 error 字段）
        expect(res.body.result).toEqual({
          content: [{ type: 'text', text: 'something went wrong' }],
          isError: true,
        });
        expect(res.body.error).toBeUndefined();
      });

      it('⑦ 未知 tool 仍返回 Tool not found', async () => {
        const baseUrl = 'http://localhost:8743/api/v1';
        server = new McpServer(app, 9876, proxy, '/mcp', baseUrl);

        const ctFoo = makeCustomTool('baz_tool');
        server.registerCustomTools([ctFoo]);
        await server.start();

        const res = await request(app)
          .post('/mcp')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'nonexistent',
              arguments: {},
            },
          });

        expect(res.body.result).toEqual({
          content: [{ type: 'text', text: 'Tool not found: nonexistent' }],
          isError: true,
        });
      });
    });

    describe('registerCustomTools 重名检测', () => {
      it('⑤ 与自动映射 tool 重名 → registerCustomTools throw', () => {
        const baseUrl = 'http://localhost:8743/api/v1';
        server = new McpServer(app, 9876, proxy, '/mcp', baseUrl);
        server.registerTools([makeMapping('shared_name')]);

        const ctDup = makeCustomTool('shared_name');
        expect(() => {
          server.registerCustomTools([ctDup]);
        }).toThrow(/conflicts with an automatically-mapped tool/);
      });

      it('⑥ custom tools 内部重名 → throw', () => {
        const baseUrl = 'http://localhost:8743/api/v1';
        server = new McpServer(app, 9876, proxy, '/mcp', baseUrl);

        const ctA = makeCustomTool('dup_name');
        const ctB = makeCustomTool('dup_name');
        expect(() => {
          server.registerCustomTools([ctA, ctB]);
        }).toThrow(/Duplicate custom tool name/);
      });
    });
  });

  describe('structuredContent 归一化', () => {
    /**
     * 辅助函数：创建返回指定 result 的 CustomTool
     */
    function makeCustomTool(name: string, result: ToolCallResult): CustomTool {
      return {
        tool: {
          name,
          description: `Custom tool ${name}`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        handler: async () => result,
      };
    }

    /** 辅助函数：发起 tools/call 请求并返回 supertest 响应 */
    function callTool(name: string, args: Record<string, unknown> = {}) {
      return request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        });
    }

    it('custom 工具返回 JSON text → 收敛为单载荷（text 降为占位，structuredContent 与 parse(text) 深度相等）', async () => {
      const jsonText = JSON.stringify({ topics: [{ id: 't1' }], total: 1 });
      server.registerCustomTools([
        makeCustomTool('json_tool', { content: [{ type: 'text', text: jsonText }] }),
      ]);
      await server.start();

      const res = await callTool('json_tool');

      expect(res.status).toBe(200);
      expect(res.body.result.content).toEqual([{ type: 'text', text: '[structured]' }]);
      expect(res.body.result.structuredContent).toEqual(JSON.parse(jsonText));
    });

    it('自动映射（proxy）工具 JSON 响应 → 同样收敛', async () => {
      const jsonText = JSON.stringify([{ id: 'a' }, { id: 'b' }]);
      proxy.execute.mockResolvedValueOnce({ content: [{ type: 'text', text: jsonText }] });
      server.registerTools([makeMapping('list_items')]);
      await server.start();

      const res = await callTool('list_items');

      expect(res.body.result.content).toEqual([{ type: 'text', text: '[structured]' }]);
      expect(res.body.result.structuredContent).toEqual(JSON.parse(jsonText));
    });

    it('handler 显式设置 structuredContent → 尊重不覆盖', async () => {
      const explicit = { custom: true, source: 'handler' };
      server.registerCustomTools([
        makeCustomTool('explicit_tool', {
          content: [{ type: 'text', text: '{"ignored": true}' }],
          structuredContent: explicit,
        }),
      ]);
      await server.start();

      const res = await callTool('explicit_tool');

      expect(res.body.result.structuredContent).toEqual(explicit);
      expect(res.body.result.content[0].text).toBe('{"ignored": true}');
    });

    it('非 JSON text（markdown）→ 无 structuredContent 字段', async () => {
      const markdown = '# Title\n\nsome **markdown** body';
      server.registerCustomTools([
        makeCustomTool('md_tool', { content: [{ type: 'text', text: markdown }] }),
      ]);
      await server.start();

      const res = await callTool('md_tool');

      expect(res.body.result.content[0].text).toBe(markdown);
      expect(res.body.result.structuredContent).toBeUndefined();
    });

    it('scalar JSON text（"123" / "\"str\""）→ 不填充', async () => {
      server.registerCustomTools([
        makeCustomTool('num_tool', { content: [{ type: 'text', text: '123' }] }),
        makeCustomTool('str_tool', { content: [{ type: 'text', text: '"str"' }] }),
      ]);
      await server.start();

      const resNum = await callTool('num_tool');
      const resStr = await callTool('str_tool');

      expect(resNum.body.result.structuredContent).toBeUndefined();
      expect(resStr.body.result.structuredContent).toBeUndefined();
    });

    it('isError 错误信封（JSON）→ 原样不动（text 保留，不额外填充 structuredContent——错误双发留给 handler 自主，人类排障读 text）', async () => {
      const errorText = JSON.stringify({ error: true, code: 9002, message: 'conflict' });
      server.registerCustomTools([
        makeCustomTool('err_tool', {
          content: [{ type: 'text', text: errorText }],
          isError: true,
        }),
      ]);
      await server.start();

      const res = await callTool('err_tool');

      expect(res.body.result.isError).toBe(true);
      expect(res.body.result.content[0].text).toBe(errorText);
      expect(res.body.result.structuredContent).toBeUndefined();
    });

    it('超过 1MB 的 JSON text → 无 cap 照常收敛（R1：取消 1MB 上限，消灭大响应 text-only 沉默分叉）', async () => {
      // 构造 >1MB 的合法 JSON：新契约下无长度阈值，parse 成功即收敛
      const bigText = JSON.stringify({ data: 'x'.repeat(1024 * 1024) });
      expect(bigText.length).toBeGreaterThan(1024 * 1024);
      server.registerCustomTools([
        makeCustomTool('big_tool', { content: [{ type: 'text', text: bigText }] }),
      ]);
      await server.start();

      const res = await callTool('big_tool');

      expect(res.body.result.content).toEqual([{ type: 'text', text: '[structured]' }]);
      expect(res.body.result.structuredContent).toEqual(JSON.parse(bigText));
    });

    it('多块 content（未来 text+image 等）→ 原样不动（防静默吞块）', async () => {
      const jsonText = JSON.stringify({ ok: true });
      server.registerCustomTools([
        makeCustomTool('multi_tool', {
          content: [
            { type: 'text', text: jsonText },
            { type: 'text', text: 'second block' },
          ],
        }),
      ]);
      await server.start();

      const res = await callTool('multi_tool');

      expect(res.body.result.content).toEqual([
        { type: 'text', text: jsonText },
        { type: 'text', text: 'second block' },
      ]);
      expect(res.body.result.structuredContent).toBeUndefined();
    });
  });

  describe('usage stats（D4b：ALS 上下文 + invocation 上报）', () => {
    const usageBaseUrl = 'http://localhost:8743/api/v1';
    const fallbackAuth = { type: 'apiKey' as const, apiKey: 'shared-key' };

    // 外层的 beforeEach 只清 HttpProxy 构造 mock，上报 mock 需在本组内清（否则计数累积）
    beforeEach(() => {
      mockedReport.mockClear();
    });

    /** 构造带 surface 与服务端默认认证的 server（上报的两个前提） */
    function makeReportingServer(surface = 'mcp'): McpServer {
      const instance = new McpServer(app, 9876, proxy, '/mcp', usageBaseUrl, surface);
      instance.setFallbackAuth(fallbackAuth);
      return instance;
    }

    /** 取出最近一次上报载荷 */
    function lastReport(): Parameters<typeof reportToolInvocation>[0] {
      const calls = mockedReport.mock.calls;
      return calls[calls.length - 1][0];
    }

    /** 发起一次 tools/call（可带 client 认证头） */
    function callToolRequest(
      params: Record<string, unknown> | undefined,
      apiKeyHeader?: string,
    ): request.Test {
      const httpRequest = request(app).post('/mcp');
      if (apiKeyHeader !== undefined) {
        httpRequest.set('X-API-Key', apiKeyHeader);
      }
      return httpRequest.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        ...(params === undefined ? {} : { params }),
      });
    }

    it('自动映射工具成功调用 → 恰好上报一次，载荷含 baseUrl/toolName/surface/ok/latencyMs', async () => {
      proxy.execute.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
      server = makeReportingServer('mcp');
      server.registerTools([makeMapping('list_topics')]);
      await server.start();

      await callToolRequest({ name: 'list_topics', arguments: {} });

      expect(mockedReport).toHaveBeenCalledTimes(1);
      expect(lastReport()).toMatchObject({
        baseUrl: usageBaseUrl,
        toolName: 'list_topics',
        surface: 'mcp',
        ok: true,
        // 无 client 认证头 → 走服务端默认认证（后端据此落 actor_type='system'）
        viaFallbackAuth: true,
      });
      expect(lastReport().latencyMs as number).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(lastReport().latencyMs)).toBe(true);
    });

    it('proxy 返回 isError:true → ok:false', async () => {
      proxy.execute.mockResolvedValue({
        content: [{ type: 'text', text: 'HTTP 404: Not Found' }],
        isError: true,
      });
      server = makeReportingServer('mcp');
      server.registerTools([makeMapping('list_topics')]);
      await server.start();

      await callToolRequest({ name: 'list_topics', arguments: {} });

      expect(mockedReport).toHaveBeenCalledTimes(1);
      expect(lastReport()).toMatchObject({ toolName: 'list_topics', ok: false });
    });

    it('出口 ④ tool-not-found → 用真名 + ok:false（"想用但入口没有"的晋升信号）', async () => {
      server = makeReportingServer('mcp');
      server.registerTools([makeMapping('list_topics')]);
      await server.start();

      await callToolRequest({ name: 'non_existent_tool', arguments: {} });

      expect(mockedReport).toHaveBeenCalledTimes(1);
      expect(lastReport()).toMatchObject({ toolName: 'non_existent_tool', ok: false });
    });

    it('pre-name 出口（params 缺失）→ toolName=__invalid__ + ok:false', async () => {
      server = makeReportingServer('mcp');
      await server.start();

      await callToolRequest(undefined);

      expect(mockedReport).toHaveBeenCalledTimes(1);
      expect(lastReport()).toMatchObject({ toolName: '__invalid__', ok: false });
    });

    it('pre-name 出口（name 非字符串）→ toolName=__invalid__ + ok:false', async () => {
      server = makeReportingServer('mcp');
      await server.start();

      await callToolRequest({ name: 123, arguments: {} });

      expect(mockedReport).toHaveBeenCalledTimes(1);
      expect(lastReport()).toMatchObject({ toolName: '__invalid__', ok: false });
    });

    it('client 自带认证头 → viaFallbackAuth:false（身份可信）', async () => {
      proxy.execute.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
      server = makeReportingServer('mcp');
      server.registerTools([makeMapping('list_topics')]);
      await server.start();

      await callToolRequest({ name: 'list_topics', arguments: {} }, 'client-own-key');

      expect(lastReport()).toMatchObject({ viaFallbackAuth: false });
    });

    it('无任何凭据（无 client 头 + 无 fallbackAuth）→ 不上报（两通道均不可见，D1 口径代价）', async () => {
      proxy.execute.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
      server = new McpServer(app, 9876, proxy, '/mcp', usageBaseUrl, 'mcp');
      server.registerTools([makeMapping('list_topics')]);
      await server.start();

      await callToolRequest({ name: 'list_topics', arguments: {} });

      expect(mockedReport).not.toHaveBeenCalled();
    });

    it('代理调用点可见 ALS 上下文（两头注入的前提，V4）', async () => {
      let seen: unknown;
      proxy.execute.mockImplementation(async () => {
        seen = getToolContext();
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      });
      server = makeReportingServer('mcp-full');
      server.registerTools([makeMapping('list_topics')]);
      await server.start();

      await callToolRequest({ name: 'list_topics', arguments: {} });

      expect(seen).toEqual({ toolName: 'list_topics', surface: 'mcp-full' });
    });

    it('custom tool handler 内可见 ALS 上下文（platform-mcp 语义工具路径）', async () => {
      let seen: unknown;
      server = makeReportingServer('mcp');
      server.registerCustomTools([
        {
          tool: {
            name: 'read_doc',
            description: 'Read a doc',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          handler: async () => {
            seen = getToolContext();
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        },
      ]);
      await server.start();

      await callToolRequest({ name: 'read_doc', arguments: {} });

      expect(seen).toEqual({ toolName: 'read_doc', surface: 'mcp' });
      expect(mockedReport).toHaveBeenCalledTimes(1);
    });
  });
});
