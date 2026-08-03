# @agent-chamber/automcp

从 OpenAPI 规范自动生成 MCP Server 的通用工具。

## 概述

`automcp` 接受任意 OpenAPI (Swagger) 规范作为输入，自动生成一个符合 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 标准的服务端。Agent（Kimi CLI、Claude Desktop、Cursor 等）可通过标准 MCP client 接入，将平台 API 作为 MCP tool 调用。

## 架构

```
OpenAPI Spec (URL or file)
    ↓
Swagger Parser (@apidevtools/swagger-parser)
    ↓
OpenAPI 3.0 规范对象
    ↓
Tool Mapper — 将每个 operation 映射为 MCP tool
    ↓
MCP Server (HTTP/SSE 传输)
    ↓
HTTP Proxy — tool call 转发为 HTTP 请求到实际 API
```

## 安装

```bash
pnpm install
```

## 使用

### 模式 A：运行时动态（serve）

启动 MCP server，运行时动态解析 OpenAPI spec 并注册 tools：

```bash
automcp serve \
  --spec https://api.example.com/openapi.json \
  --base-url https://api.example.com \
  --port 3000 \
  --api-key <your-api-key>
```

### 模式 B：静态生成（generate）

生成独立可运行的 TypeScript MCP Server 项目：

```bash
automcp generate \
  --spec https://api.example.com/openapi.json \
  --output ./my-mcp-server
```

## 开发

```bash
# 开发模式（热重载）
pnpm dev

# 类型检查
pnpm typecheck

# 构建
pnpm build

# 测试
pnpm test
```

## 核心映射规则

| OpenAPI | MCP Tool |
|---------|----------|
| `operationId` (snake_case) | `name` |
| `summary + description` | `description` |
| `parameters` (path/query/body) | `inputSchema` (JSON Schema) |
| `responses` | 返回值（结构化文本） |
| `security` | 认证头注入 |

## License

MIT
