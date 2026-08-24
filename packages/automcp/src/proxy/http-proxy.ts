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
import type { AuthConfig, ToolMapping, ToolCallResult, ParamLocation } from '../types';

/**
 * HTTP 请求代理器
 *
 * 将 MCP tool call 转换为实际 HTTP 请求，转发到目标 API。
 * 负责 URL 构造（含 path 插值）、query string 生成、body 还原、请求头注入、响应格式化。
 */
export class HttpProxy {
  private readonly baseUrl: string;
  private readonly basePathname: string;
  private readonly auth?: AuthConfig;

  /**
   * 创建代理器实例
   * @param baseUrl - 目标 API 的基础 URL
   * @param auth - 认证配置（可选）
   */
  constructor(baseUrl: string, auth?: AuthConfig) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.auth = auth;

    // 提取 baseUrl 的 pathname，用于避免 operation path 与 baseUrl 重复拼接
    try {
      const urlObj = new URL(this.baseUrl);
      this.basePathname = urlObj.pathname.replace(/\/$/, '');
    } catch {
      this.basePathname = '';
    }
  }

  /**
   * 执行 tool 调用，转发为 HTTP 请求
   *
   * @param mapping - Tool 映射结果（含 operation 定义和参数位置映射）
   * @param args - tool 调用参数（扁平化的键值对）
   * @returns MCP Tool Call 结果
   */
  async execute(
    mapping: ToolMapping,
    args: Record<string, unknown>,
    authOverride?: AuthConfig,
  ): Promise<ToolCallResult> {
    const { operation, paramLocations } = mapping;

    // ─── 1. URL 构造（含 path 插值）───
    const pathResult = this.buildPath(operation.path, args, paramLocations);
    if (pathResult.isError) {
      return {
        content: [{ type: 'text', text: pathResult.errorText }],
        isError: true,
      };
    }

    // 避免 operation path 已包含 baseUrl 的 pathname 导致重复拼接
    // 例如：baseUrl=http://host/api/v1, path=/api/v1/topics → 应拼接为 /api/v1/topics
    let relativePath = pathResult.path;
    if (this.basePathname !== '' && relativePath.startsWith(this.basePathname)) {
      const afterBase = relativePath.slice(this.basePathname.length);
      if (afterBase === '' || afterBase.startsWith('/')) {
        relativePath = afterBase || '/';
      }
    }

    const url = `${this.baseUrl}${relativePath}`;

    // ─── 2. Query String 构造 ──
    const queryString = this.buildQueryString(args, paramLocations);
    const fullUrl = queryString ? `${url}?${queryString}` : url;

    // ─── 3. Body 构造 ──
    const body = this.buildBody(args, paramLocations);

    // ─── 4. Headers ──
    // 优先使用调用方传入的 auth（MCP client 透传），否则 fallback 到 server 默认 auth
    const effectiveAuth = authOverride ?? this.auth;
    const headers = this.buildHeaders(body !== undefined, effectiveAuth);

    // ─── 5. 发送 HTTP 请求 ──
    try {
      const response = await axios({
        method: operation.method,
        url: fullUrl,
        headers,
        data: body,
        // 120s：与生产 nginx /mcp 的 proxy_read_timeout 120s 对齐
        // （scripts/nginx/agent-chamber.conf location = /mcp）。本代理处于
        // nginx 与 platform-client 之间，超时同样不得低于上游链路——否则大写慢调用
        // （如 58k patch）会在这里先断，服务端事务照常提交 = "写成功、响应无人接收"
        // （Board 任务 7d918c7b 根因之一）。对齐后最先断的是 nginx（504，语义明确）。
        timeout: 120_000,
        maxRedirects: 5,
        validateStatus: () => true, // 让 axios 不抛出 4xx/5xx，我们自己处理
      });

      // ─── 6. 响应处理 ──
      if (response.status >= 200 && response.status < 300) {
        const formatted = this.formatResponseData(response.data);
        return {
          content: [{ type: 'text', text: formatted }],
        };
      }

      // 4xx/5xx 错误
      const errorText = this.formatErrorResponse(
        response.status,
        response.statusText,
        response.data,
      );
      return {
        content: [{ type: 'text', text: errorText }],
        isError: true,
      };
    } catch (error) {
      // 网络错误 / 超时 / 其他 axios 错误
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Request failed: ${errorMessage}` }],
        isError: true,
      };
    }
  }

  /**
   * 构建请求路径，替换 path 参数占位符
   *
   * 支持两种风格：`{paramName}` 和 `:paramName`
   *
   * @param pathTemplate - 原始路径模板（如 /topics/{id}）
   * @param args - tool 调用参数
   * @param paramLocations - 参数位置映射表
   * @returns 插值后的路径，若 path 参数缺失则返回错误信息
   */
  private buildPath(
    pathTemplate: string,
    args: Record<string, unknown>,
    paramLocations: Record<string, ParamLocation>,
  ): { path: string; isError: false } | { errorText: string; isError: true } {
    // 收集 path 参数：toolParamName → originalName
    const pathParams = new Map<string, string>();
    for (const [toolName, location] of Object.entries(paramLocations)) {
      if (location.in === 'path') {
        pathParams.set(location.name, toolName);
      }
    }

    let path = pathTemplate;

    // 替换 {paramName} 风格
    path = path.replace(/\{([^}]+)\}/g, (_match, originalName: string) => {
      const toolName = pathParams.get(originalName) ?? originalName;
      const value = args[toolName];
      if (value === undefined || value === null) {
        return `{${originalName}}`; // 保留占位符，后面统一报错
      }
      return encodeURIComponent(String(value));
    });

    // 替换 :paramName 风格
    path = path.replace(/:([a-zA-Z0-9_]+)/g, (_match, originalName: string) => {
      const toolName = pathParams.get(originalName) ?? originalName;
      const value = args[toolName];
      if (value === undefined || value === null) {
        return `:${originalName}`; // 保留占位符，后面统一报错
      }
      return encodeURIComponent(String(value));
    });

    // 检查是否还有未替换的占位符
    if (/\{[^}]+\}/.test(path) || /:[a-zA-Z0-9_]+/.test(path)) {
      return { isError: true, errorText: `Missing required path parameter for: ${pathTemplate}` };
    }

    return { path, isError: false };
  }

  /**
   * 构建 query string
   *
   * 从 args 中提取 in: 'query' 的参数，使用原始参数名作为 key。
   * 跳过 undefined / null 值。数组值用逗号分隔。
   *
   * @param args - tool 调用参数
   * @param paramLocations - 参数位置映射表
   * @returns URL 编码后的 query string（无 ? 前缀）
   */
  private buildQueryString(
    args: Record<string, unknown>,
    paramLocations: Record<string, ParamLocation>,
  ): string {
    const params = new URLSearchParams();

    for (const [toolName, location] of Object.entries(paramLocations)) {
      if (location.in !== 'query') {
        continue;
      }

      const value = args[toolName];
      if (value === undefined || value === null) {
        continue;
      }

      const originalName = location.name;

      if (Array.isArray(value)) {
        // 数组值：逗号分隔
        params.set(originalName, value.join(','));
      } else {
        params.set(originalName, String(value));
      }
    }

    return params.toString();
  }

  /**
   * 构建请求体
   *
   * - 情况 A（展开的 body properties）：组装为 { [originalName]: argValue }
   * - 情况 B（primitive/array 包装）：取 args.body 作为 body 值
   *
   * @param args - tool 调用参数
   * @param paramLocations - 参数位置映射表
   * @returns 请求体对象，如无 body 参数则返回 undefined
   */
  private buildBody(
    args: Record<string, unknown>,
    paramLocations: Record<string, ParamLocation>,
  ): unknown {
    const bodyEntries: Array<[string, unknown]> = [];
    let hasBodyParam = false;
    let isWrappedBody = false;

    for (const [toolName, location] of Object.entries(paramLocations)) {
      if (location.in !== 'body') {
        continue;
      }

      hasBodyParam = true;
      const value = args[toolName];

      if (toolName === 'body' && location.name === 'body') {
        // 情况 B：primitive/array 包装
        isWrappedBody = true;
        return value;
      }

      // 情况 A：展开的 body properties
      bodyEntries.push([location.name, value]);
    }

    if (!hasBodyParam) {
      return undefined;
    }

    if (isWrappedBody) {
      // 已在循环中 return，不会走到这里
      return undefined;
    }

    // 组装为对象
    const body: Record<string, unknown> = {};
    for (const [key, value] of bodyEntries) {
      body[key] = value;
    }

    return body;
  }

  /**
   * 构建请求头
   *
   * 包含 Content-Type（当有 body 时）和认证头。
   *
   * @param hasBody - 是否包含请求体
   * @returns HTTP 请求头对象
   */
  private buildHeaders(hasBody: boolean, auth?: AuthConfig): Record<string, string> {
    const headers: Record<string, string> = {};

    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }

    if (auth === undefined) {
      return headers;
    }

    switch (auth.type) {
      case 'apiKey': {
        if (auth.apiKey !== undefined) {
          headers['X-API-Key'] = auth.apiKey;
        }
        break;
      }
      case 'bearer': {
        if (auth.bearerToken !== undefined) {
          headers['Authorization'] = `Bearer ${auth.bearerToken}`;
        }
        break;
      }
      case 'basic': {
        if (auth.username !== undefined && auth.password !== undefined) {
          const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
        }
        break;
      }
    }

    return headers;
  }

  /**
   * 格式化 4xx/5xx 错误响应为文本
   *
   * 上游若返回结构化业务错误信封（含 message 字段的对象，如本平台的
   * `{ code, message, data }`），则归一化为 `{ error, status, code?, message, details? }`
   * 的紧凑 JSON —— Agent 可直接 JSON.parse 拿到机器可读业务错误码，
   * 无需从 "HTTP 404: Not Found" 这类 statusText 噪音里脆弱地抠信息。
   * 非结构化上游（纯文本/HTML/无 message 字段）回退为状态行 + 原始 body。
   *
   * @param status - HTTP 状态码
   * @param statusText - HTTP 状态文本
   * @param data - 上游响应体
   * @returns 格式化后的错误文本
   */
  private formatErrorResponse(status: number, statusText: string, data: unknown): string {
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const body = data as Record<string, unknown>;
      if (typeof body.message === 'string') {
        const normalized: Record<string, unknown> = {
          error: true,
          status,
          message: body.message,
        };
        if (typeof body.code === 'number' || typeof body.code === 'string') {
          normalized.code = body.code;
        }
        if (body.data !== undefined && body.data !== null) {
          normalized.details = body.data;
        }
        return JSON.stringify(normalized, null, 2);
      }
    }

    // 非结构化上游：保留状态行 + 原始 body
    return `HTTP ${status}: ${statusText}\n${this.formatResponseData(data)}`;
  }

  /**
   * 格式化响应数据为文本
   *
   * - object / array → JSON.stringify(data, null, 2)
   * - string / number / boolean → 直接转为 string
   *
   * @param data - HTTP 响应数据
   * @returns 格式化后的文本
   */
  private formatResponseData(data: unknown): string {
    if (data === null) {
      return 'null';
    }

    if (typeof data === 'object') {
      return JSON.stringify(data, null, 2);
    }

    return String(data);
  }
}
