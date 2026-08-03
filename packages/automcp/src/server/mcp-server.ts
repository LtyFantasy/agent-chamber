/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plans/miss-martian-polaris-superboy.md §Step 4
 *   - 补充: .kimi/plan-mcp-phase2.md §2 (custom tools 扩展点)
 *   - 补充: AGENTS.md §7 (关键数字速查)
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

import type { Application, Request, Response } from 'express';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ToolMapping,
  ToolCallParams,
  InitializeResult,
  ToolListResult,
  ToolCallResult,
  AuthConfig,
  CustomTool,
  CustomToolContext,
} from '../types';
import { HttpProxy } from '../proxy/http-proxy';

/**
 * MCP Server (HTTP 传输)
 *
 * 基于 Express 手动实现 JSON-RPC over HTTP，不依赖 @modelcontextprotocol/sdk。
 * 处理 initialize 握手、tools/list 查询、tools/call 调用。
 */
export class McpServer {
  private readonly app: Application;
  private readonly port: number;
  private readonly proxy: HttpProxy;
  private readonly basePath: string;
  private readonly baseUrl: string;
  private toolMappings: ToolMapping[] = [];
  private customTools: CustomTool[] = [];
  private fallbackAuth?: AuthConfig;
  private server?: ReturnType<Application['listen']>;

  /**
   * 创建 MCP Server 实例
   * @param app - Express 应用实例
   * @param port - 监听端口
   * @param proxy - HTTP 代理器实例（用于转发 tool call）
   * @param basePath - MCP JSON-RPC endpoint 的 base path（默认 /mcp）
   * @param baseUrl - 目标 API 的基础 URL（用于 custom tools 上下文）
   */
  constructor(app: Application, port: number, proxy: HttpProxy, basePath = '/mcp', baseUrl = '') {
    this.app = app;
    this.port = port;
    this.proxy = proxy;
    this.basePath = basePath;
    this.baseUrl = baseUrl;
  }

  /**
   * 注册所有 tool mappings
   * @param mappings - Tool 映射结果数组
   */
  registerTools(mappings: ToolMapping[]): void {
    this.toolMappings = mappings;
  }

  /**
   * 注册手写 custom tools（与 OpenAPI 自动映射 tools 并存）
   *
   * - 与已注册 toolMappings 或 customTools 内部重名 → 立即 throw（fail fast，避免静默歧义）
   * - fallbackAuth：server 启动配置的默认 auth（client 未透传时使用）
   *
   * @param tools - CustomTool 数组
   * @param fallbackAuth - server 默认认证（可选）
   * @throws 当 tool 名称与自动映射 tool 或 custom tools 内部重名时抛出 Error
   */
  registerCustomTools(tools: CustomTool[], fallbackAuth?: AuthConfig): void {
    // 收集自动映射 tool 的名称集合
    const autoNames = new Set(this.toolMappings.map((m) => m.tool.name));

    for (const ct of tools) {
      const name = ct.tool.name;

      // 与自动映射 tool 重名检查
      if (autoNames.has(name)) {
        throw new Error(
          `Custom tool "${name}" conflicts with an automatically-mapped tool of the same name`,
        );
      }

      // custom tools 内部重名检查（基于已加入的集合）
      const existing = this.customTools.find((t) => t.tool.name === name);
      if (existing !== undefined) {
        throw new Error(
          `Duplicate custom tool name "${name}": each custom tool must have a unique name`,
        );
      }

      this.customTools.push(ct);
    }

    this.fallbackAuth = fallbackAuth;
  }

  /**
   * 启动 HTTP 服务器，配置 JSON-RPC 路由
   * @returns 启动成功后的 URL 字符串
   */
  async start(): Promise<string> {
    this.setupRoutes();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        const address = this.server!.address();
        const actualPort =
          address === null || typeof address === 'string' ? this.port : address.port;
        resolve(`http://localhost:${actualPort}`);
      });

      this.server.on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server === undefined) {
        resolve();
        return;
      }

      this.server.close((err?: Error) => {
        if (err) {
          reject(err);
        } else {
          this.server = undefined;
          resolve();
        }
      });
    });
  }

  /**
   * 配置 Express 路由
   */
  private setupRoutes(): void {
    // 健康检查
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok' });
    });

    // JSON-RPC endpoint
    this.app.post(this.basePath, (req: Request, res: Response) => {
      void this.handleJsonRpc(req, res);
    });
  }

  /**
   * 处理 JSON-RPC 请求
   */
  private async handleJsonRpc(req: Request, res: Response): Promise<void> {
    // 解析 JSON-RPC 请求
    let request: JsonRpcRequest;
    try {
      request = this.parseRequest(req.body);
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      this.sendError(res, null, -32700, `Parse error: ${message}`);
      return;
    }

    // 校验请求结构
    if (!this.isValidRequest(request)) {
      this.sendError(res, request.id ?? null, -32600, 'Invalid request: missing method or id');
      return;
    }

    // 根据 method 分发
    switch (request.method) {
      case 'initialize': {
        const result = this.handleInitialize();
        this.sendResult(res, request.id, result);
        break;
      }
      case 'tools/list': {
        const result = this.handleToolsList();
        this.sendResult(res, request.id, result);
        break;
      }
      case 'tools/call': {
        try {
          const result = await this.handleToolsCall(req, request.params);
          this.sendResult(res, request.id, result);
        } catch (callError) {
          const message = callError instanceof Error ? callError.message : String(callError);
          this.sendError(res, request.id, -32603, `Internal error: ${message}`);
        }
        break;
      }
      default: {
        this.sendError(res, request.id, -32601, `Method not found: ${request.method}`);
      }
    }
  }

  /**
   * 解析请求体为 JsonRpcRequest
   *
   * 只做结构提取，不做业务校验（method/id 空值留给 isValidRequest 处理）。
   */
  private parseRequest(body: unknown): JsonRpcRequest {
    if (typeof body !== 'object' || body === null) {
      throw new Error('Request body must be a JSON object');
    }

    const obj = body as Record<string, unknown>;

    if (obj.jsonrpc !== '2.0') {
      throw new Error('Invalid jsonrpc version');
    }

    const id = obj.id;
    const validId = typeof id === 'number' || typeof id === 'string' ? id : null;

    const method = typeof obj.method === 'string' ? obj.method : '';

    return {
      jsonrpc: '2.0',
      id: validId,
      method,
      params:
        typeof obj.params === 'object' && obj.params !== null
          ? (obj.params as Record<string, unknown>)
          : undefined,
    };
  }

  /**
   * 校验请求是否包含必需的 method 和 id
   */
  private isValidRequest(req: JsonRpcRequest): boolean {
    return req.method !== undefined && req.method !== '' && req.id !== undefined && req.id !== null;
  }

  /**
   * 处理 initialize 请求
   */
  private handleInitialize(): InitializeResult {
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: 'automcp',
        version: '0.1.0',
      },
    };
  }

  /**
   * 处理 tools/list 请求
   * 返回自动映射 tools + custom tools（custom tools 排在尾部，保持稳定顺序）
   */
  private handleToolsList(): ToolListResult {
    return {
      tools: [
        ...this.toolMappings.map((mapping) => mapping.tool),
        ...this.customTools.map((ct) => ct.tool),
      ],
    };
  }

  /**
   * 处理 tools/call 请求
   *
   * 查找顺序：自动映射 tools 优先 → custom tools 兜底。
   * custom tool handler 抛异常 → 返回 isError:true 文本结果（不冒泡为 JSON-RPC -32603，
   * 与 HttpProxy 错误体验一致）。
   */
  private async handleToolsCall(
    req: Request,
    params: Record<string, unknown> | undefined,
  ): Promise<ToolCallResult> {
    if (params === undefined) {
      return {
        content: [{ type: 'text', text: 'Missing params for tools/call' }],
        isError: true,
      };
    }

    const toolParams = params as unknown as ToolCallParams;
    const toolName = toolParams.name;

    if (typeof toolName !== 'string') {
      return {
        content: [{ type: 'text', text: 'Missing or invalid tool name' }],
        isError: true,
      };
    }

    // 从 HTTP request header 中提取 MCP client 传入的认证信息
    const clientAuth = this.extractClientAuth(req);

    // ── 1. 先查自动映射 tool ──
    const mapping = this.toolMappings.find((m) => m.tool.name === toolName);
    if (mapping !== undefined) {
      const args = (toolParams.arguments as Record<string, unknown>) ?? {};
      return this.proxy.execute(mapping, args, clientAuth);
    }

    // ── 2. 再查 custom tool ──
    const customTool = this.customTools.find((ct) => ct.tool.name === toolName);
    if (customTool !== undefined) {
      const args = (toolParams.arguments as Record<string, unknown>) ?? {};

      // 构造上下文：client auth 优先，否则 fallback 到 server 默认 auth
      const ctx: CustomToolContext = {
        baseUrl: this.baseUrl,
        auth: clientAuth ?? this.fallbackAuth,
      };

      try {
        return await customTool.handler(args, ctx);
      } catch (handlerError) {
        // handler 抛异常 → 返回 isError:true 文本结果，不冒泡为 JSON-RPC -32603
        const message = handlerError instanceof Error ? handlerError.message : String(handlerError);
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
        };
      }
    }

    // ── 3. 都未命中 ──
    return {
      content: [{ type: 'text', text: `Tool not found: ${toolName}` }],
      isError: true,
    };
  }

  /**
   * 从 HTTP request header 中提取 MCP client 的认证信息
   *
   * 支持：
   * - X-API-Key: <key> → { type: 'apiKey', apiKey }
   * - Authorization: Bearer <token> → { type: 'bearer', bearerToken }
   * - Authorization: Basic <base64> → { type: 'basic', username, password }
   *
   * 如果 client 未提供认证头，返回 undefined（由 HttpProxy fallback 到 server 默认 auth）
   */
  private extractClientAuth(req: Request): AuthConfig | undefined {
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey !== '') {
      return { type: 'apiKey', apiKey };
    }

    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader !== '') {
      const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      if (bearerMatch && bearerMatch[1]) {
        return { type: 'bearer', bearerToken: bearerMatch[1] };
      }

      const basicMatch = authHeader.match(/^Basic\s+(.+)$/i);
      if (basicMatch && basicMatch[1]) {
        try {
          const decoded = Buffer.from(basicMatch[1], 'base64').toString('utf-8');
          const [username, password] = decoded.split(':', 2);
          if (username !== undefined && password !== undefined) {
            return { type: 'basic', username, password };
          }
        } catch {
          // 忽略 base64 解码失败
        }
      }
    }

    return undefined;
  }

  /**
   * 发送 JSON-RPC 成功响应
   */
  private sendResult(res: Response, id: number | string | null, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    res.json(response);
  }

  /**
   * 发送 JSON-RPC 错误响应
   */
  private sendError(
    res: Response,
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        data,
      },
    };
    res.json(response);
  }
}
