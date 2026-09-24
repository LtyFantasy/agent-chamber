/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - MCP JSON-RPC over HTTP 服务器（initialize / tools/list / tools/call）
 *   - 接口调用频率统计的 MCP 侧采集点（上下文建立 + invocation 上报）
 *
 * [代码职责]
 *   - 手工 JSON-RPC 分发（不依赖 @modelcontextprotocol/sdk）+ MCP client 认证解析
 *   - `handleToolsCall` = tools/call 的**唯一出口**：structuredContent 归一化、
 *     ALS 上下文建立（toolName / surface）、每次调用恰好一次 fire-and-forget 上报
 *   - `fallbackAuth`（server 默认认证）与 `extractClientAuth`（client 头透传）共同
 *     决定生效凭据，也决定上报走哪条凭据、是否标 viaFallbackAuth
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 上报契约 + 统计口径专章
 *   - 补充: docs/architecture.md §automcp — MCP 通道在链路中的位置
 *
 * [关键不变量]
 *   - **上报在 `handleToolsCall` 整层包裹，四个出口恰好一次**（自动映射 / custom /
 *     tool-not-found / 两个 pre-name 出口）；`executeToolCall` 内部不得再包一层——
 *     重复上报 = 计数翻倍且不报错，属静默数据污染
 *   - **无凭据不上报**（clientAuth 与 fallbackAuth 皆空）：未认证调用在 REST 与上报
 *     两条通道均不可见，这是刻意的口径代价（文档口径专章）
 *   - `viaFallbackAuth = clientAuth 缺失且存在服务端默认认证`：后端据此落
 *     actor_type='system'（共享 --api-key 时 distinctActors 失真，此标记是其过滤器）
 *   - 上报失败绝不影响工具响应（fail-open，实现见 usage-reporter）
 *
 * [关联代码]
 *   - server/tool-context.ts — ALS 上下文与头名常量的单一定义点
 *   - server/usage-reporter.ts — 上报发送（本文件只做认证解析与出口挂载）
 *   - proxy/http-proxy.ts — 原子映射工具执行 + 头注入点 ①
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（四出口是否仍恰好上报一次）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
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
import { INVALID_TOOL_NAME, normalizeToolName, runWithToolContext } from './tool-context';
import { reportToolInvocation } from './usage-reporter';

/**
 * 尝试把 text 解析为结构化内容
 *
 * 仅 object / array 算结构化内容；scalar（'123'、'"str"'、'true'、'null'）不算——
 * JSON.parse('123') 同样成功，但消费端无法从中提取字段，填充无意义。
 *
 * @param text - tool 响应的 text 内容
 * @returns 解析成功且为 object/array 时返回解析结果，否则 undefined
 */
function tryParseStructuredContent(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      return parsed;
    }
    return undefined;
  } catch {
    // 非 JSON text（如 markdown 原文）→ 跳过
    return undefined;
  }
}

/**
 * 归一化 ToolCallResult（v1.66 新契约：JSON 响应只发 structuredContent，消灭双倍载荷）
 *
 * 四分支规则：
 * 1. handler 显式设置 structuredContent → 原样不动（逃生门，为将来 outputSchema 校验/定制预留）
 * 2. isError === true → 原样不动（错误信封双发保留：错误响应小，双发成本可忽略，
 *    且错误 text 的人类可读性对排障有价值）
 * 3. content 恰好为单 text 块且 text 为合法 JSON、解析为 object/array → 填充
 *    structuredContent，且 content 收敛为单条占位文本 `[{ type: 'text', text: '[structured]' }]`
 *    ——text 只作"这是结构化响应"的固定标记（MCP 2025-06-18 schema 中 content 为
 *    required，留占位块既合规又便于日志/抓包识别），数据唯一载荷在 structuredContent。
 *    无大小上限（R1）：服务端本就已完成 JSON 序列化，多 parse 一次成本可忽略；
 *    旧 1MB cap 会把大 JSON 响应退化为 text-only 沉默分叉，已删除。
 * 4. 其余（多块 content / 非 JSON / scalar JSON / 无 content）→ 原样不动
 *    （read_doc 的 markdown 原文等非结构化场景零影响）
 *
 * @param result - handler / proxy 返回的原始结果
 * @returns 归一化后的结果
 */
function withStructuredContent(result: ToolCallResult): ToolCallResult {
  if (result.structuredContent !== undefined || result.isError === true) {
    return result;
  }

  // 仅恰好单 text 块时收敛；多块 content（如未来 text+image）原样不动，防静默吞块
  const content = result.content;
  if (content.length !== 1) {
    return result;
  }

  const parsed = tryParseStructuredContent(content[0].text);
  if (parsed === undefined) {
    return result;
  }

  return {
    ...result,
    content: [{ type: 'text', text: '[structured]' }],
    structuredContent: parsed,
  };
}

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
  /**
   * 本实例的 MCP 暴露面（`mcp` / `mcp-full` / `unknown`）
   *
   * 由 serve 启动参数解析一次后全程不变（D4c），随每次 tools/call 进入 ALS 上下文，
   * 最终以 `X-MCP-Surface` 头与上报载荷两种形式抵达后端。
   */
  private readonly surface: string;
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
   * @param baseUrl - 目标 API 的基础 URL（custom tools 上下文 + invocation 上报的 base URL）
   * @param surface - MCP 暴露面（默认 `'unknown'`：MCP 但暴露面不明，刻意不用空串——
   *                  空串在统计口径里表示"非 MCP 流量"）
   */
  constructor(
    app: Application,
    port: number,
    proxy: HttpProxy,
    basePath = '/mcp',
    baseUrl = '',
    surface = 'unknown',
  ) {
    this.app = app;
    this.port = port;
    this.proxy = proxy;
    this.basePath = basePath;
    this.baseUrl = baseUrl;
    this.surface = surface;
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

    // 只在显式传入时更新默认认证：省略该参数不应清空既有配置——serve 入口先
    // setFallbackAuth(auth) 再 registerCustomTools(tools)，若这里被 undefined 覆盖，
    // invocation 上报会因"无凭据"被整片跳过（静默丢计数，无任何报错）
    if (fallbackAuth !== undefined) {
      this.fallbackAuth = fallbackAuth;
    }
  }

  /**
   * 设置 server 默认认证（fallbackAuth）
   *
   * 由 serve 入口在构造后立即注入，使 `/mcp`（无 custom tools）与 `/mcp-full` 两种
   * 实例都持有同一份默认认证——usage 上报与 custom tools 的 `ctx.auth` 都依赖它
   * （`clientAuth ?? fallbackAuth`）。`registerCustomTools` 会写入同一字段，两者
   * 取值同源（都来自 serve 的 `--api-key` / `--bearer-token`），重复赋值无副作用。
   *
   * @param auth - 服务端默认认证；无默认认证时传 undefined（上报随之跳过）
   */
  setFallbackAuth(auth?: AuthConfig): void {
    this.fallbackAuth = auth;
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
      // 2025-06-18：structuredContent 字段的引入版本（2024-11-05 无此字段）。
      // 声明新版本后，支持 structuredContent 的 client 直接消费 result.structuredContent
      // （JSON 响应下它是唯一数据载荷，text 收敛为 '[structured]' 占位）。
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
   * 统一出口：所有路径（自动映射 / custom / tool-not-found / 两个 pre-name 出口）
   * 都过 withStructuredContent 归一化——JSON 成功响应收敛为单载荷（structuredContent
   * 唯一数据 + text 占位 '[structured]'），错误/非 JSON 响应原样不动。
   *
   * 同时是 usage stats 的唯一采集点（D4b），一次调用做两件事：
   * 1. 用 ALS 把 `{toolName, surface}` 建立为本次调用的上下文——下游两个注入点
   *    （http-proxy / platform-client）据此加 `X-MCP-Tool` / `X-MCP-Surface` 头；
   * 2. 执行完成后 fire-and-forget 上报一次 invocation（成败、耗时、凭据来源）。
   *
   * 包裹点刻意放在**本层整层**：executeToolCall 内部的任一分支再包一层都会让同一次
   * 调用上报两次（计数翻倍且无任何报错）。
   */
  private async handleToolsCall(
    req: Request,
    params: Record<string, unknown> | undefined,
  ): Promise<ToolCallResult> {
    const toolName = this.resolveToolName(params);

    return runWithToolContext({ toolName, surface: this.surface }, async () => {
      const startedAt = Date.now();
      let result: ToolCallResult;

      try {
        result = withStructuredContent(await this.executeToolCall(req, params));
      } catch (error) {
        // executeToolCall 内部已把 handler 异常收敛为 isError 信封，正常不会走到这里；
        // 真抛了（如代理层意外错误）也要留一次失败计数再放行给 handleJsonRpc → -32603
        this.reportInvocation(req, toolName, false, Date.now() - startedAt);
        throw error;
      }

      // ok 语义 = MCP 结果信封的成败（工具自身/上游的 4xx-5xx 都体现为 isError:true）
      this.reportInvocation(req, toolName, result.isError !== true, Date.now() - startedAt);
      return result;
    });
  }

  /**
   * 解析本次 tools/call 的 tool 名（覆盖两个 pre-name 出口）
   *
   * params 缺失、`name` 非字符串——这两个出口连名字都没有，用哨兵 `'__invalid__'`
   * 而非空串：空串在后端口径里表示"非 MCP 流量"，两者语义不能相撞。
   *
   * @param params - JSON-RPC 请求的 params
   * @returns 可安全入头与入上报载荷的工具名（已归一化）
   */
  private resolveToolName(params: Record<string, unknown> | undefined): string {
    if (params === undefined) {
      return INVALID_TOOL_NAME;
    }

    const name = (params as unknown as ToolCallParams).name;
    if (typeof name !== 'string') {
      return INVALID_TOOL_NAME;
    }

    return normalizeToolName(name);
  }

  /**
   * 上报一次 invocation（fire-and-forget，绝不抛、绝不 await）
   *
   * 认证解析与工具执行完全同源：`clientAuth ?? fallbackAuth`——上报必须用"这次调用
   * 实际用的那把凭据"，否则 401 会让计数静默丢失。
   *
   * **无凭据（两者皆空）或 baseUrl 未配置时跳过上报**：未认证的 MCP 调用在 REST
   * （guard 短路不计）与上报（无凭据无法认证）两条通道均不可见，这是 D1 的既定口径代价。
   *
   * @param req - 原始 HTTP 请求（取 client 透传的认证头）
   * @param toolName - 已解析并归一化的工具名
   * @param ok - 本次调用是否成功
   * @param latencyMs - 工具执行耗时（ms）
   */
  private reportInvocation(req: Request, toolName: string, ok: boolean, latencyMs: number): void {
    const clientAuth = this.extractClientAuth(req);
    const auth = clientAuth ?? this.fallbackAuth;

    if (auth === undefined || this.baseUrl === '') {
      return;
    }

    reportToolInvocation({
      baseUrl: this.baseUrl,
      auth,
      toolName,
      surface: this.surface,
      ok,
      latencyMs,
      // 走服务端默认认证 = 身份不可信（共享 --api-key / 单 token），后端据此落
      // actor_type='system'，让 distinctActors 失真可被过滤
      viaFallbackAuth: clientAuth === undefined,
    });
  }

  /**
   * 执行 tool 调用（不经过 structuredContent 归一化，由 handleToolsCall 统一收口）
   *
   * 查找顺序：自动映射 tools 优先 → custom tools 兜底。
   * custom tool handler 抛异常 → 返回 isError:true 文本结果（不冒泡为 JSON-RPC -32603，
   * 与 HttpProxy 错误体验一致）。
   */
  private async executeToolCall(
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
