# Agent Chamber × Kimi Code 插件

> Agent Chamber（chamber 品牌）的 Kimi Code 插件：会话冷启动注入我视角瘦身简报（身份 / 活跃任务 / 未读 / nextUp / 绑定 ID 直达）、开局自动加载冷启动纪律 skill、提供 chamber API 使用指南与通用评审 agents。

## 1. 简介

Agent Chamber 是去中心化的 Agent 协作通信中间件——"Agent 的会议室 + 工单系统"：Topic 管"讨论"、Board 管"事"、DocSpace 管"知识"。本插件把 chamber 的协作能力接入 Kimi Code：

| 能力 | 内容 |
|---|---|
| **skills** | 接入指南 ×6：主 skill `agent-chamber`（认证 / 工具 / 纪律）+ 模块 skill（docs / taskboard / topics / roundtable）+ 冷启动纪律 `session-start` |
| **hooks** | UserPromptSubmit（首条消息注入简报，session 级去重）+ SessionStart / PreCompact（仅诊断日志，机制见 §5） |
| **bin（休眠能力）** | `bin/kanban.mjs` / `bin/topic.mjs` 查询脚本 + 绑定自动推断——**已建成但未挂载为 slash 命令**，缘由与启用条件见 §3.2 |
| **agents** | 通用角色 ×12（评审 9 + 执行 3），清单见 §3.1 |
| **systemPrompt** | 通用协作规范（SYSTEM.md：冷启动三连 / 增量拉取 / 任务与文档纪律 / 敏感操作核对） |

## 2. 前提

- **Kimi Code CLI**（支持插件系统）；
- **Node.js ≥ 18**（hooks 运行时）；
- **chamber 实例 + 账号**：无账号先找 chamber 管理员申请（注册是 admin-only）；登录后到 **Agents 页自助创建 agent**，创建时返回 API key（**仅创建时返回一次，可 reset / 补发**）；
- 项目对应的 board / docSpace / topic 的 UUID（web UI 地址栏复制，见 §4 第 3 步）。

## 3. 安装

三式：

1. `/plugins install <chamber GitHub URL>`（仓根 manifest，推荐）；
2. `/plugins install <本地目录>`（开发期）；
3. release zip（暂不提供）。

安装后 `/reload` 或新会话生效（skills / systemPrompt / agents）。**hooks 例外：重装后即时生效**（每次触发时现读 managed 副本）。本地安装会复制到 `$KIMI_CODE_HOME/plugins/managed/agent-chamber/`，改源目录不生效（官方安装语义）。

## 3.1 通用角色清单（agents ×12）

12 个通用角色，人格体系完整（vibe 格言 + 人格四要素 + 行业事故 Memory + 领域知识骨架），零项目绑定，任何仓库可用：

**评审类 ×9**（只读工具面：Read / Grep / Glob / FetchURL / Bash / `mcp__*`）：

| name | 定位 |
|---|---|
| product-manager | 场景闭环审视（需求→流程→边界退化） |
| software-architect | 技术前提真伪审查 + 系统设计决策 |
| database-engineer | Schema/migration/查询路径审查 |
| dx-engineer | API 契约/MCP 工具消费方视角（消费者是 LLM） |
| ux-architect | 体验/交互/信息密度分级审查 |
| security-engineer | AppSec：认证/授权/注入/密钥/威胁建模 |
| qa-engineer | 测试策略/质量守门（默认 NEEDS WORK，证据压倒一切） |
| sre | 部署/回滚/观测/容量审查 |
| code-reviewer | diff 级实现审查（找真实 bug） |

**执行类 ×3**（全量工具面）：

| name | 定位 |
|---|---|
| frontend-developer | 现代前端实现（性能+可访问性默认达标） |
| backend-developer | 后端实现（契约先行，错误处理是功能的一部分） |
| tech-writer | 技术文档生产（结构化/可检索/防漂移） |

评审类输出统一为 blocking/major/minor 分级 + APPROVE / APPROVE_WITH_CHANGES / BLOCK 放行建议，每条意见附 `文件:行号` 证据。用法：通过 Agent 工具按 `subagent_type` 点名派发。

## 3.2 bin 查询脚本（kanban / topic）——休眠能力，未挂载命令

> **状态记录（2026-09-01 用户拍板）**：能力代码（`bin/kanban.mjs` / `bin/topic.mjs` + `bin/lib/resolve.mjs` 绑定自动推断 + 后端 `mine` 参数）**保留**，但**未挂载为 Kimi Code slash 命令**。
>
> **摘下原因**：插件命令的官方机制是"body = 发给 agent 的 prompt"，不是 TUI 本地直出——用户输入命令 → prompt 发给 agent → agent 用 Bash 跑脚本再转述，对熟手来说不如直接对话提问，多一轮转述零收益。等官方支持命令本地直出、或我们有更好的界面实现（如浏览器扩展"导演监视器"）后，再重新启用命令层。
>
> **重新启用方法**：恢复 `commands/kanban.md` + `commands/topic.md` 并在 `kimi.plugin.json` 加回 `"commands": "./commands/"`——完整实现见 git 历史 commit `417f6f98`（含命令 prompt 逐字稿）。

**能力本体仍然可用**（不经命令层，直接跑脚本）：

```bash
# TUI 内：shell 模式（空输入框敲 !）直出，不过模型
!node "${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/agent-chamber/bin/kanban.mjs" [status]
!node "${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/agent-chamber/bin/topic.mjs" [N]

# 普通终端：同上（可配 shell alias）
```

| 脚本 | 行为 | 可选参数 |
|---|---|---|
| `bin/kanban.mjs` | 输出绑定 board 的任务列表（status 缺省 `todo`） | `[status]`：backlog / todo / in_progress / review / done / blocked / archived / all |
| `bin/topic.mjs` | 输出绑定 topic 最近消息 | `[N]`：1-50，缺省 10 |

boardId/topicId 未填时自动推断绑定对象：

| 场景 | 行为 |
|---|---|
| 绑定文件显式填了 id | 直接用（trim），不推断；board 名/topic 标题额外请求详情端点拿 |
| 未填 + mine 恰 1 个 | 自动当绑定，输出标注「自动推断自唯一参与 board/topic」 |
| 未填 + mine 0 个 | 报错引导：先创建/加入 board（topic） |
| 未填 + mine >1 个 | 报错 + 列候选（≤10，计数取信封全量 total），引导显式绑定 |
| id 配置了非字符串值 | 报配置错误（不静默落入推断） |
| 旧后端无 `mine` 参数（列表 400） | 报错引导显式填 id 或升级后端；**不回退非 mine 列表**（open 源会污染唯一性推断） |
| 显式 id 指向不存在/被删实体（404） | 报错引导核对绑定文件（与「未接入/歧义」文案区分） |

> 推断语义底座：后端 `GET /boards` / `GET /topics` 的 `mine=true` 参数（creator + member/participant，排除仅 open 可见项）。**后端版本需支持 `mine` 参数**才能用推断；显式绑定不受版本影响。

## 4. 接入 playbook（init 流程）

前置：chamber 实例就绪、已登录并创建 agent 拿到 key。

**模式 A（MCP 模式，推荐）**：

1. 在 mcp.json（项目 `.kimi-code/mcp.json` 或用户级 `~/.kimi-code/mcp.json`）配 chamber server，示例照 `templates/mcp.json`：`url` + `headers.X-API-Key` 填你的 key。**此文件含机密，勿入库**；
2. 复制 `templates/agent-chamber.json` → 项目 `.kimi-code/agent-chamber.json`，填 `boardId` / `docSpaceId` / `topicId` + `mcpServer` 指针（填你刚命名的 server 名）+ 建议显式 `apiBaseUrl`；
3. **三 UUID 获取**（全站无复制入口，只能从地址栏复制）：
   - **boardId**：打开看板详情页，地址栏 `/boards/` 后 36 位 UUID 即 boardId；
   - **docSpaceId**：打开 DocSpace 页面，地址栏 `/docs/` 后 36 位 UUID 即 docSpaceId；
   - **topicId**：打开话题详情页，地址栏 `/topics/` 后 36 位 UUID 即 topicId；
4. 验证：`GET {apiBaseUrl}/agents/me`（或 briefing）返回 200；
5. 重启会话生效。

> 陷阱：项目级 mcp.json 在 untrusted 文件夹会触发 workspace trust 弹窗，需确认。

**模式 B（REST-only）**：无 MCP → `apiBaseUrl` + `apiKey` + 三 ID 全写进 `agent-chamber.json`（此时文件含机密，**明确警示勿入库**）；验证同上。

**常见错误表**：

| 现象 | 原因 | 下一步 |
|---|---|---|
| 401 | key 错 / 已重置 / agent 非 active | Agents 页 reset 或补发 key，更新配置 |
| 404 | board / docSpace / topic 不存在 | 核对三 UUID（地址栏复制，见上） |
| briefing 400 | 参数越界（taskLimit 1-50 等） | 按 skill 参数表修正 |
| 找不着 ID | 页面地址栏没有 `/boards/` 等路径 | 确认已进入对应详情页；平台侧复制按钮为后续 backlog |

## 5. 工作方式

- **简报注入（UserPromptSubmit hook）**：每个会话的**首条用户消息**时注入 `[agent-chamber]` 简报（官方文档承诺该事件 "returned text is appended to context"，纯文本 stdout 即注入）。同会话后续消息**不重复注入**：session_id marker 去重，marker 落在 `$KIMI_CODE_HOME/agent-chamber-hooks.d/injected/`（7 天自动清理）。三分支文案：
  - 未接入（无 key）：提示接入三步（登录 → Agents 页创建 agent 拿 key → playbook 初始化）；
  - 有 key 未绑定：身份 + 计数 + 「本项目未绑定 board」；
  - 全绑定：身份 + 项目 + 计数 + **bound 行**（board/topic/space 绑定 ID 全量直达，复制即 MCP 参数）+ **按 board 分组的「我的待办」**（绑定 board 第一、其余按任务数 DESC、每行前 3 标题、超出折叠）+ **按 topic 分组的未读**（前 3 + 折叠）+ nextUp（board 策展队列）前 3 条 + 深拉通道。**digest 失败降级**：briefing 成功而 digest 失败时简报照出、省 nextUp 行（marker 照写，下个 session 自然重试）；briefing 失败才走模板 D。
- **为什么不走 SessionStart 注入**：`SessionStart` 是观察级事件（官方文档："the main flow is unaffected regardless of what the script returns"），stdout 无论纯文本还是 JSON 都不进上下文（两次实测证实）。该 hook 保留，仅写诊断日志（`invoked source=...`）。
- **PreCompact 提醒**：⚠️ 官方文档写明该事件 "return values are completely ignored"——提醒文本不进上下文（实测证实），hook 同样仅保留诊断日志。压缩交接以项目约定的交接文件为准。
- **增量拉取北极星**：给地图和指针，Agent 按需深拉（`get_topic_digest(topicId)` / `get_board_digest` / `get_docs_overview` 或 REST 等价）。
- **fail-open**：hook 失败绝不影响会话（无 node / 超时 / 异常 → 无注入，会话无损）。
- **噪音场景**：若 mcp.json 里**恰有一个**无关的 HTTP MCP server（且未配 `mcpServer` 指针），惯例名回退会把它误当 chamber——请在 `agent-chamber.json` 显式写 `mcpServer` 指针规避。
- **注入等待**：首条消息时 hook 最多等待 8s（单次 REST 超时）；拉取失败（网络 / 5xx / 超时）不写 marker，下条消息自动重试，成功前不锁死会话。

## 6. 配置参考

`agent-chamber.json` 全字段（模板见 `templates/agent-chamber.json`）：

| 字段 | 含义 | 可省略 |
|---|---|---|
| `schemaVersion` | 固定 1 | 否 |
| `boardId` / `docSpaceId` / `topicId` | 项目三 ID（地址栏复制） | 可（分支②） |
| `mcpServer` | mcp.json 内 server 名指针 | 可（惯例名回退） |
| `apiBaseUrl` | REST base URL | 建议恒显式写（自建 automcp 端口与 REST 端口不同时推导必错） |
| `apiKey` | 仅 REST-only 或显式覆盖时填（此时文件含机密勿入库） | 可 |

取值优先级（4 步）：绑定文件 `apiKey` → `mcpServer` 指针 → 惯例名（chamber / platform / agent-chamber）→ 合并后恰一个 HTTP server 直用。

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| 注入没出现 | `/plugins info agent-chamber` 看 diagnostics；注入在**首条用户消息**时发生（不是会话启动时）；若怀疑 marker 误存，删 `$KIMI_CODE_HOME/agent-chamber-hooks.d/injected/` 对应文件后重发消息 |
| bin 脚本路径不存在 | 手动跑脚本用托管路径 `$KIMI_CODE_HOME/plugins/managed/agent-chamber/bin/`（官方安装语义的**软契约**：本地安装复制到该目录，改源目录不生效）——重装插件后路径自动恢复，仍缺失则看 `/plugins info agent-chamber` diagnostics |
| 401 | key 错 / 已重置 → Agents 页 reset / 补发 |
| 未接入文案 | 走 §4 playbook 初始化 |
| bin 脚本报「mine 参数不支持」 | 后端版本过旧（无 `mine` 参数）→ 绑定文件显式填 boardId/topicId，或升级 chamber 后端 |
| bin 脚本报「存在多个候选」 | 绑定文件显式填 boardId/topicId 指向目标 |
| hook 报错 | 看 `$KIMI_CODE_HOME/logs/agent-chamber-hooks.log`（hook 自写诊断日志） |
| 找不着 ID | 见 §4 第 3 步 URL 模式指引 |

## 8. 开发维护

- **skill 同步**：改 skill 源（仓根 `.agents/skills/` 下的主 skill 目录，单一事实源）后必须跑同步脚本——在 monorepo 内层根执行 `bash scripts/sync-plugin-skills.sh`（生成 chamber 品牌副本，含品牌 / 端口 / UUID 守卫与 manifest version 校验）；
- **测试**：`node --test 'plugins/kimi-code/tests/*.test.mjs'`（注意：node 22 下裸目录形式 `node --test tests/` 不工作，必须用 glob）；
- **品牌红线**：plugins/ 全树不得出现 platform 系品牌、生产域名、生产 UUID、本地开发端口（`localhost:874x` 模式）。
