export { OpenApiParser } from './parser/openapi-parser';
export { ToolMapper } from './mapper/tool-mapper';
export { McpServer } from './server/mcp-server';
export { HttpProxy } from './proxy/http-proxy';
export { AuthProvider } from './auth/auth-provider';
export { loadProfile, resolveProfilePath } from './profile/profile-loader';
// MCP 工具上下文（ALS）：平台侧（platform-mcp）经包名运行时 import 同一实例——
// 少一行 re-export，语义工具的两头会静默消失（详见 server/tool-context.ts 的 hook）
export {
  INVALID_TOOL_NAME,
  MCP_SURFACE_HEADER,
  MCP_TOOL_HEADER,
  TOOL_NAME_MAX_LENGTH,
  getToolContext,
  normalizeToolName,
  runWithToolContext,
} from './server/tool-context';
export type { ToolContext } from './server/tool-context';
export type {
  ParsedOperation,
  Parameter,
  RequestBody,
  Response,
  JSONSchema,
  SecurityRequirement,
  ToolDefinition,
  AuthConfig,
  ServeOptions,
  GenerateOptions,
  OpenApiSpec,
  ParamLocation,
  ToolMapping,
  ToolFilterOptions,
  ToolProfile,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  InitializeParams,
  InitializeResult,
  ToolListResult,
  ToolCallParams,
  ToolCallResult,
  CustomToolContext,
  CustomTool,
  CustomToolsModule,
} from './types';
