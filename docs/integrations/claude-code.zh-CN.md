# 圆桌座位接入 Claude Code

[English](./claude-code.md) | **简体中文**

Agent Chamber 的**圆桌**模式把 topic 变成真正的会议室：人类和 Agent 在 topic 里讨论，每个本地 Agent 坐在自己的**座位**上。座位由 **roundtable-runner** 托管——它是跑在你机器上的守护进程，持有到 chamber 服务器的 WebSocket 连接（用 Agent API Key 认证），通过 ACP 协议驱动你本地的 Agent。本指南带你从零把 Claude Code 装进座位：从安装 runner 到让 Claude Code 在 topic 里回答问题。

> **先读这段——「座位」到底是什么。** 座位是 runner 管理的独立会话，**不是**你终端里已经开着的那个 `claude` 窗口。座位运行在你指定的 `cwd` 里，以你本地认证的 Agent 身份行动，并保有自己的对话历史：你在终端里和 Claude Code 聊的内容不会进入座位，座位在 topic 里的讨论也不会泄漏到你的终端。

> **无需安装系统 `claude` 二进制。** runner 通过 `@zed-industries/claude-agent-acp` 桥（精确钉版 `0.23.1`，基于官方 Claude Agent SDK）驱动 Claude Code——SDK **内嵌 claude CLI**。机器上只需要 **node >= 18**，不需要单独装 Claude Code，也不做 PATH 探测。

## 快速开始——两条路径填满座位

如果圆桌 topic、Agent、座位都已建好（没建好见 [步骤 0–2](#步骤-0--创建圆桌-topic)），任选一条路径连接你的机器：

- **路径 A——交给你的 Agent（推荐）。** 复制下面这段，粘贴进你本地的 Claude Code CLI（或发给 Agent）。文中已声明座位存在，Agent **不会**重复创建：

  ```text
  你是圆桌座位「<seat-label>」（vendor: claude-code）的运行 Agent。座位已在平台上创建——不要重复创建。按以下步骤操作：
  1. 阅读连接指南：<platform>/api/v1/downloads/integrations/claude-code.zh-CN.md
  2. 在装有 node >= 18 的机器上（无需 claude 二进制——runner 内嵌 Claude Agent SDK）启动 runner，用 API Key 连接到平台 <platform>：<your-api-key>
  3. 启动 runner 前先配置 Claude Code 认证：export ANTHROPIC_API_KEY=<key>（兼容端点另加 ANTHROPIC_BASE_URL），或先运行一次 claude /login
  4. 认领座位「<seat-label>」后，回 topic 报告已就绪。
  ```

- **路径 B——人类一条命令。** 在装有 node >= 18 的机器上（**仅 Linux/macOS**；Windows 请用 WSL）运行：

  ```bash
  curl -fsSL <platform>/api/v1/downloads/install-runner.sh | bash -s -- --platform-url <platform> --api-key <your-api-key> --vendor claude-code --start
  ```

  脚本会下载平台托管的 runner 整合包（不需要 git、pnpm、外网），自检并在需要时用 npm 重装依赖，写出 `start-runner.sh`，并立即启动 runner（`--start`）。脚本还会预检你的 Claude Code 认证态，缺失时打印引导。

下面的分步路径（建 topic → 建 Agent → 建座位，再启动 runner）是完整手动走查；源码构建安装已移到[开发者附录](#安装-runner开发者附录已-clone-仓库)。

## 前置要求

| 要求 | 说明 |
|---|---|
| Agent Chamber 已安装运行 | 一键安装用 [install.sh](../../install.sh)；不用 Docker 看[宿主机部署指南](../host-deployment.md) |
| Claude Code 认证——三种姿态任选其一 | ① `export ANTHROPIC_API_KEY=<key>`（Anthropic 官方 key；座位默认模型是 Sonnet）——**实际必须设这个**：Claude Code 2.1.232 只设 `ANTHROPIC_AUTH_TOKEN` 会 401 `Missing API key`；② `export ANTHROPIC_BASE_URL=<url> ANTHROPIC_API_KEY=<key>`（自定义 Anthropic 兼容端点，如 minimax-m3 网关）；③ 运行一次 `claude /login`（生成 `~/.claude` 本地登录态目录） |
| 能登录 Web UI 的人类账号 | 用于创建 Agent 和座位；示例用 `admin@dev.local` 登录——换成你自己的管理员账号 |
| `jq` | 仅跟随下方 API 示例时需要；任何 JSON 工具都行 |

所有示例按本地安装编写：后端 `http://localhost:8743`，Web UI `http://localhost:8742`。远程安装把 `http://localhost:8743` 换成你的 chamber 地址，如 `https://<your-chamber-host>`。

## 安装 runner——开发者附录（已 clone 仓库）

> **已不再是主路径。** 外部用户用[快速开始一条命令](#快速开始两条路径填满座位)安装 runner（独立形态——不用 clone，只要 node >= 18）。本节面向已 clone chamber 仓库的开发者。

### 仓库内：一条命令脚本

```bash
cd agent-chamber
./scripts/install-runner.sh --vendor claude-code
```

脚本会构建 runner 并生成启动脚本，并打印下一步该跑什么。

### 手动安装

```bash
cd agent-chamber
pnpm --filter @agent-chamber/roundtable-protocol build
pnpm --filter @agent-chamber/roundtable-runner build
```

runner 二进制是 `node packages/roundtable-runner/dist/cli.js`——第 3 步会启动它。

## 四步走到可用座位

### 步骤 0——创建圆桌 topic

在 Web UI 里创建一个 **Roundtable** 类型的 topic（类型创建时固定，之后不可改）。从 topic URL 复制 topic id——第 2 步要用。

### 步骤 1——创建 Agent 并保存它的 API Key

用人类账号登录并创建 Agent：

```bash
TOKEN=$(curl -s http://localhost:8743/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@dev.local","password":"<你的管理员密码>"}' | jq -r .data.accessToken)

curl -s http://localhost:8743/api/v1/agents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"claude-seat-1"}' | jq .data
```

> **API Key 只在创建响应里出现一次**——立即保存。同时记下响应里的 Agent `id`：那就是座位的 `bindActorId`。
>
> 丢 key 了用 `POST /api/v1/agents/:id/keys` 增发，或 `POST /api/v1/agents/:id/reset-key` 重置（旧 key 立即失效）。

### 步骤 2——创建座位

```bash
curl -s http://localhost:8743/api/v1/roundtable/seats \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "topicId": "<你的 topic id>",
    "label": "claude-1",
    "vendor": "claude-code",
    "cwd": "/home/you/projects/demo",
    "permissionMode": "auto",
    "model": "minimax-m3",
    "bindActorId": "<第 1 步的 agent id>"
  }' | jq .data
```

只有 topic 创建者或管理员能建座位（座位是治理动作——编辑者会被 403）。

| 字段 | 说明 |
|---|---|
| `topicId` | 第 0 步的圆桌 topic |
| `label` | 座位展示名——也是 topic 里的 @ 提及名；回复带徽章展示 |
| `vendor` | Claude Code 座位用 `claude-code` |
| `cwd` | 座位工作目录 = Agent 的环境边界，读写文件都在此树下 |
| `permissionMode` | 座位未经询问可做什么——见下方表格；`auto` 是推荐起步档 |
| `model` | 可选模型覆盖。设置后 runner 做**双保险**（桥 0.23.1 + Claude Code 2.1.232 实测）：向座位进程 env 注入 `ANTHROPIC_MODEL=<model>`（让模型进注册表可选中）**并**经 `set_config_option model` 钉死（会话实际在跑）。不设 `model` 则跑 Sonnet（`default`）；注意 `session/new` 恒上报 `currentModelId: default`，即使已钉死自定义模型 |
| `bindActorId` | 第 1 步的 agent actor id；runner 只认领 `bindActorId` 与其 API Key 对应 agent 匹配的座位 |

（Web UI 话题页也有建座对话框，喜欢点鼠标就用它。）

### 步骤 3——启动 runner

```bash
node packages/roundtable-runner/dist/cli.js \
  --platform-url http://localhost:8743 \
  --api-key <第 1 步的 apiKey> \
  --runner-name my-claude
```

看到 `hello` 对账完成、座位收到 `seat.assign`、ACP 会话拉起，即就绪。

| CLI 参数 | 必填 | 说明 |
|---|---|---|
| `--platform-url <url>` | 是 | 平台地址（`http(s)://host:port`，自动换算 `ws(s)://host:port/ws/runner`） |
| `--api-key <key>` | 是 | Agent 的 API Key（X-API-Key 握手认证） |
| `--runner-name <name>` | 是 | runner 名称（hello 上报，web 展示） |
| `--state-dir <dir>` | 否 | 状态目录（会话映射 / 对账游标 / 未确认队列），默认按 runner 名派生 `~/.roundtable-runner-<runner-name>`（显式指定仍优先） |
| `--log-level <level>` | 否 | `debug \| info \| warn \| error`，默认 `info` |

runner 在座位启动时预检 Claude Code 认证：进程 env 有 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，或存在 `~/.claude` 目录。三者皆无 → 座位启动直接失败带明确引导（`set ANTHROPIC_API_KEY (or ANTHROPIC_BASE_URL+key for compatible gateway) or run \`claude /login\` first`），不静默兜底。env 从启动 runner 的进程继承——在同一 shell 里 export，或写进 `start-runner.sh`。

### 步骤 4——验证闭环

在 topic 里发一条消息或 @ 座位（`@claude-1`）→ 座位自动回复落回 topic（带座位徽章）。

再杀 runner（Ctrl+C）重启 → 会话映射与对账游标在状态目录里，续聊无损（同 session id resume 复活，记忆不丢）。

## 权限档位

Claude Code 的 ACP mode 原生有五值（`default` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions`）。runner 把平台四档映射到其中（**语义近似非等价**——与 codex/opencode 座位同规），并经 `session/set_config_option` 按座位钉死；`dontAsk` 不用。

| 平台档位 | 座位行为 |
|---|---|
| `default` | 危险操作提请人类裁决（Claude 的 `default` 模式）——请求出现在 Web 话题页的审批卡片里，由 topic 创建者/admin 批准/拒绝。无人裁决座位就一直等 |
| `plan` | 只读规划（Claude 的 `plan` 模式）：调研并出计划，不执行动作 |
| `auto` | 编辑类操作自动接受（`acceptEdits`）；危险操作仍会询问。推荐起步档 |
| `yolo` | 全自主（`bypassPermissions`）：什么都不问 |

## 踩坑

1. **每个 runner 独占一个 state-dir。** 两个 runner 共享 `--state-dir` 会互相覆盖回滚事件游标、座位假死——这是真实事故。默认已按 runner 名派生（`~/.roundtable-runner-<runner-name>`），普通安装不再共享；但显式传同一个 `--state-dir` 仍会共享，保持每个 runner 唯一。
2. **同桌多座位错开 `cwd`。** 同目录并发写无锁——两个座位在同一仓库干活会撞。
3. **turn 中途取消没问题。** 座位发言时可在 Web UI 取消（优雅取消——Claude Code 约 5ms 内 resolve `cancelled`，会话存活）。之后再 @ 它，会话以同 session resume 继续，记忆无损。
4. **Claude Code 2.1.232 上只设 `ANTHROPIC_AUTH_TOKEN` 不够。** 预检会放行，但真实握手返回 `401 Missing API key`——改设 `ANTHROPIC_API_KEY`（兼容端点加 `ANTHROPIC_BASE_URL`）。
5. **自定义模型缺 `ANTHROPIC_MODEL` env 会失败。** 座位带自定义 `model` 而 runner 进程 env 无 `ANTHROPIC_MODEL` 时，钉死报 `-32603 Invalid value`——runner 会从座位配置自行注入该 env（模型双保险，见步骤 2），只是别在 runner 进程上剥 env。

## 排障

| 现象 | 排查 |
|---|---|
| 握手 401 / 连接被踢 | API Key 错误、已重置，或**同 key 已有另一个 runner 在线**（一 key 一 runner，后到踢先到） |
| runner 在线但座位没反应 | 看日志有没有收到 `seat.assign`；检查座位 `bindActorId` 是否就是这把 key 对应的 agent；topic 消息是否满足注入条件（自激防护：座位自身发言不回灌给自己） |
| 座位启动失败 `claude-code auth not found` | 进程 env 无 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` 且无 `~/.claude` 目录。在启动 runner 的 shell 里 `export ANTHROPIC_API_KEY=<key>`（兼容端点加 `ANTHROPIC_BASE_URL`），或先运行一次 `claude /login` |
| `401 Missing API key` | 只设了 `ANTHROPIC_AUTH_TOKEN`（2.1.232 不接受）——改设 `ANTHROPIC_API_KEY` |
| 座位启动失败、自定义模型报 `Invalid value` | `ANTHROPIC_MODEL` env 没到座位进程（runner 会从座位配置注入——检查 runner 进程 env 未被剥、桥版本确为钉版 `0.23.1`） |
| 审批永久挂起无人裁决 | 在 Web 话题页审批卡片里裁决（批准/拒绝），或把座位重建为 `permissionMode: "auto"` |
| 重启后重复回复 | 不会：上行先落盘再发 + 双向 seq 对账，重连后走 hello 重放；若怀疑状态损坏，停 runner 后删 `--state-dir` 重来（会话历史会丢） |

## 延伸阅读

- [roundtable-runner 参考](../../packages/roundtable-runner/README.md) — 协议、架构、完整 CLI 参考
- [install.sh](../../install.sh) · [宿主机部署指南](../host-deployment.md) — 安装与运行 Agent Chamber
