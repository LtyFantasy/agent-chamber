/** 解析后的 OpenAPI Operation */
export interface ParsedOperation {
  /** operationId，唯一标识 */
  operationId: string;
  /** HTTP 方法 */
  method: string;
  /** API 路径 */
  path: string;
  /** 简短描述 */
  summary?: string;
  /** 详细描述 */
  description?: string;
  /** 所属标签 */
  tags?: string[];
  /** 参数列表 */
  parameters: Parameter[];
  /** 请求体定义 */
  requestBody?: RequestBody;
  /** 响应定义映射 */
  responses: Record<string, Response>;
  /** 安全要求 */
  security?: SecurityRequirement[];
}

/** OpenAPI 参数 */
export interface Parameter {
  /** 参数名 */
  name: string;
  /** 参数位置 */
  in: 'path' | 'query' | 'header';
  /** 是否必填 */
  required: boolean;
  /** JSON Schema */
  schema: JSONSchema;
  /** 参数描述 */
  description?: string;
}

/** 请求体定义 */
export interface RequestBody {
  /** 是否必填 */
  required: boolean;
  /** Content-Type */
  contentType: string;
  /** JSON Schema */
  schema: JSONSchema;
}

/** 响应定义 */
export interface Response {
  /** 响应描述 */
  description: string;
  /** Content-Type */
  contentType?: string;
  /** JSON Schema */
  schema?: JSONSchema;
}

/** JSON Schema 简化表示 */
export interface JSONSchema {
  /**
   * Schema 类型。
   * 内部表示通常为单个字符串；输出到 MCP wire 时 nullable 字段会被展开为
   * `['string', 'null']` 这类数组形式（合法 JSON Schema Draft-07）。
   */
  type: string | string[];
  /** 对象属性 */
  properties?: Record<string, JSONSchema>;
  /** 数组元素类型 */
  items?: JSONSchema;
  /** 必填字段列表 */
  required?: string[];
  /** 枚举值 */
  enum?: unknown[];
  /** 是否可空 */
  nullable?: boolean;
  /** 描述 */
  description?: string;
  /** 格式 */
  format?: string;
  /** 是否允许额外属性 */
  additionalProperties?: boolean;
  /** 组合 schema：多选一（透传自 OpenAPI，分支已递归转换） */
  oneOf?: JSONSchema[];
  /** 组合 schema：任一匹配（透传自 OpenAPI，分支已递归转换） */
  anyOf?: JSONSchema[];
}

/** 安全要求 */
export interface SecurityRequirement {
  [name: string]: string[];
}

/** MCP Tool 定义 */
export interface ToolDefinition {
  /** Tool 名称 */
  name: string;
  /** Tool 描述 */
  description: string;
  /** 输入参数 JSON Schema */
  inputSchema: JSONSchema;
}

/** 认证配置 */
export interface AuthConfig {
  /** 认证类型 */
  type: 'apiKey' | 'bearer' | 'basic';
  /** API Key（apiKey 类型时使用） */
  apiKey?: string;
  /** Bearer Token（bearer 类型时使用） */
  bearerToken?: string;
  /** 用户名（basic 类型时使用） */
  username?: string;
  /** 密码（basic 类型时使用） */
  password?: string;
}

/** CLI Serve 选项 */
export interface ServeOptions {
  /** OpenAPI spec URL 或文件路径 */
  spec: string;
  /** 目标 API 的基础 URL */
  baseUrl: string;
  /** MCP server 端口 */
  port: number;
  /** API Key 认证 */
  apiKey?: string;
  /** Bearer Token 认证 */
  bearerToken?: string;
  /** 只包含指定 tags 的 operation（逗号分隔） */
  tags?: string[];
  /** 包含匹配 operationId 的 pattern（逗号分隔） */
  include?: string[];
  /** 排除匹配 operationId 的 pattern（逗号分隔） */
  exclude?: string[];
  /** 预设 profile 名称（如 agent），会按约定路径查找 JSON profile */
  profile?: string;
  /** 直接指定 profile JSON 文件路径 */
  profilePath?: string;
  /** MCP JSON-RPC endpoint 的 base path（默认 /mcp） */
  basePath?: string;
  /** 自定义 tools 模块路径（文件绝对/相对路径或包名），模块须导出 customTools: CustomTool[] */
  customTools?: string;
}

/** Tool 预设 profile：声明式的过滤配置 */
export interface ToolProfile extends ToolFilterOptions {
  /** profile 名称（可读） */
  name?: string;
  /** profile 说明 */
  description?: string;
}

/** CLI Generate 选项 */
export interface GenerateOptions {
  /** OpenAPI spec URL 或文件路径 */
  spec: string;
  /** 输出目录 */
  output: string;
}

/** Tool 参数位置映射：tool 参数名 → 实际在 HTTP 请求中的位置和原始名 */
export interface ParamLocation {
  /** 参数在 HTTP 请求中的位置 */
  in: 'path' | 'query' | 'body';
  /** 原始参数名（用于构造 HTTP 请求） */
  name: string;
}

/** Tool 映射结果：包含 tool 定义 + 原始 operation + 参数位置映射 */
export interface ToolMapping {
  /** MCP Tool 定义 */
  tool: ToolDefinition;
  /** 原始 OpenAPI operation（供 proxy 使用） */
  operation: ParsedOperation;
  /** 参数位置映射表：tool 参数名 → 位置和原始名 */
  paramLocations: Record<string, ParamLocation>;
}

/** Tool 过滤选项 */
export interface ToolFilterOptions {
  /** 只包含指定 tags 的 operation */
  tags?: string[];
  /** 包含匹配 operationId 的正则 pattern */
  include?: string[];
  /** 排除匹配 operationId 的正则 pattern */
  exclude?: string[];
}

/** 解析后的 OpenAPI Spec 轻量级表示 */
export interface OpenApiSpec {
  /** OpenAPI 版本号（如 '3.0.0'）或 Swagger 版本（如 '2.0'） */
  version: string;
  /** 规范标题 */
  title: string;
  /** 规范描述 */
  description?: string;
  /** 解析后的 operation 列表 */
  operations: ParsedOperation[];
}

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC 2.0 错误 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** MCP Initialize 请求参数 */
export interface InitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

/** MCP Initialize 结果 */
export interface InitializeResult {
  protocolVersion: string;
  capabilities: { tools?: { listChanged?: boolean } };
  serverInfo: { name: string; version: string };
}

/** MCP Tool List 结果 */
export interface ToolListResult {
  tools: ToolDefinition[];
}

/** MCP Tool Call 参数 */
export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** MCP Tool Call 结果 */
export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /**
   * 结构化内容（可选，MCP 2025-06-18 协议引入）
   *
   * handler 通常不设置——由框架层（McpServer.withStructuredContent）在 text 为
   * 合法 JSON 时自动填充，消费端可免二次 JSON.parse；handler 显式设置时框架层
   * 尊重不覆盖（为将来 outputSchema 校验/定制预留逃生门）。
   */
  structuredContent?: unknown;
}

/** Custom tool 调用上下文：由 McpServer 构造，传给 handler */
export interface CustomToolContext {
  /** 目标 API 基础 URL（来自 --base-url） */
  baseUrl: string;
  /**
   * 生效认证：MCP client 请求 header 透传的 auth 优先；
   * client 未传时为 server 启动配置的 fallback auth；两者皆无则为 undefined
   */
  auth?: AuthConfig;
}

/** 手写自定义 tool（不经过 OpenAPI 自动映射 / HttpProxy） */
export interface CustomTool {
  /** MCP Tool 定义（name / description / inputSchema） */
  tool: ToolDefinition;
  /**
   * 执行编排逻辑
   * @param args - tool 调用参数（扁平键值对）
   * @param ctx - 调用上下文（baseUrl + 生效认证）
   * @returns MCP Tool Call 结果
   */
  handler: (args: Record<string, unknown>, ctx: CustomToolContext) => Promise<ToolCallResult>;
}

/** custom tools 模块的约定导出形状（--custom-tools 动态加载） */
export interface CustomToolsModule {
  customTools: CustomTool[];
}
