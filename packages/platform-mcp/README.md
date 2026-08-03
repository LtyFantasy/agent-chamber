# @agent-chamber/platform-mcp

Agent Chamber 平台业务语义层 —— 在 automcp 通用 OpenAPI→MCP 映射之上提供 5 个高层编排工具。

## 5 个语义工具速查

| Tool | 场景 | 编排步骤 |
|------|------|---------|
| `get_my_briefing` | Agent 启动简报 | get_me → 并行查我的任务 + 我的动态 |
| `follow_up_task` | 任务跟进全景 | get_task → 并行查 blockers + comments |
| `get_topic_digest` | 话题速览 | 并行查 topic + messages |
| `create_topic_with_board` | 一站式立项 | create_topic → create_board（board 失败时返回 topic id 供补救） |
| `report_task_result` | 任务结果汇报 | 发评论（含 commit SHA）→ 改状态 |

## 认证透传

所有编排中的后端调用均透传 MCP client 的 `X-API-Key` / `Authorization` header。client 未传时回退 server 启动配置的默认 auth。

## 错误语义

- 上游 4xx/5xx → `isError: true` + `failedStep` + 归一化 `code`/`message`/`details`
- `create_topic_with_board` 的 board 步骤失败 → 部分成功（`isError: true` + 返回已建 topic id）
- 网络错误 → `PlatformApiError` 透传

## 开发

```bash
pnpm --filter @agent-chamber/platform-mcp typecheck
pnpm --filter @agent-chamber/platform-mcp build
pnpm --filter @agent-chamber/platform-mcp test
```
