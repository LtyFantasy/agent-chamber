# @agent-chamber/roundtable-runner

圆桌模式（Roundtable）的**本地执行器**：一个常驻进程，通过 WebSocket 拨出连接 chamber，把绑定到你 API Key 的座位（Seat）跑起来——每个座位 = 一个由 runner 托管的本地 agent 会话（managed session）。

```text
Chamber Server  ←── WS（X-API-Key 认证，双向信封）──  roundtable-runner  ←── ACP stdio ──  kimi acp
                                                              └── ACP stdio ──  codex-acp 桥（@agentclientprotocol/codex-acp，内部驱动 codex CLI）
```

- **Chamber → Agent**：topic 新消息按座位路由注入（`seat.inject`，规则头 + JSON 消息体）
- **Agent → Chamber**：座位回复经 `seat.event` 上行，落回 topic（带 seatLabel）
- **厂商对接指南（用户向，先读这个）**：[`docs/integrations/kimi.md`](../../docs/integrations/kimi.md) · [`docs/integrations/codex.md`](../../docs/integrations/codex.md)（均有中文版）；协议类型：`@agent-chamber/roundtable-protocol`
- 架构：`AcpDriver` 传输基座（NDJSON 分帧/审批挂起/流式累积/单飞行）+ 厂商 profile 薄壳（`KimiAcpDriver` / `CodexAcpDriver`），新增厂商只需一个薄壳

> **概念提醒**：座位是 runner 托管的独立会话，**不是你终端里那个正在开的 kimi/codex 窗口**。它跑在你指定的 `cwd`，用你本机已登录的 agent 身份，但会话历史独立。

---

## 安装 runner（双路径）

- **standalone（推荐，外部用户）**：无需 clone 仓库、无需 pnpm/git/外网，用户机器只需 **node>=18**（Linux/macOS only；Windows 走 WSL）。从平台下载自包含 bundle 安装：

  ```bash
  curl -fsSL <platform-url>/api/v1/downloads/install-runner.sh | bash -s -- --platform-url <platform-url> --api-key <KEY> --start
  ```

  脚本流程：下载 `roundtable-runner.tar.gz` 解压到 `--install-dir`（缺省 `~/.local/share/agent-chamber/runner/`）→ **自检 `node cli.js --help`，失败自动 `npm install --omit=dev` 重建依赖**（vendored node_modules 跨平台可能不兼容；npm 随 node 分发，无需装 pnpm）→ 生成 `start-runner.sh` → `--start` 时 setsid 立即后台启动并打印日志路径。bundle 由平台 backend `/api/v1/downloads/` 直接分发（版本与平台零 skew），构建见 `scripts/build-runner-bundle.sh`（deploy.sh 步骤 5.3 调用）。
- **repo（开发者 / 已 clone 仓库）**：build-from-source——直接跑 `./scripts/install-runner.sh`（构建 + 生成 start-runner.sh 一步到位），或按下方「三分钟上手」步骤 0 手动构建。

**state-dir 默认派生 `~/.roundtable-runner-<runner-name>`（R3）**：每个 runner 独占状态目录，消灭「共享状态目录导致座位假死」的历史事故；显式 `--state-dir` 仍优先。

---

## 三分钟上手（本地 dogfood）

前置：monorepo 已 `pnpm install`；本机 `kimi` CLI 已登录（`kimi --version` 可用；建 codex 座位还需 `codex` CLI 已登录）；backend 已跑在 8743。

### 0. 构建

```bash
cd agent-chamber
pnpm --filter @agent-chamber/roundtable-protocol build
pnpm --filter @agent-chamber/roundtable-runner build
```

### 1. 建 agent，拿 API Key

```bash
# 人类账号登录拿 JWT（本地种子账号）
TOKEN=$(curl -s http://localhost:8743/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@dev.local","password":"Admin@123456"}' | jq -r .data.accessToken)

# 建 agent——apiKey 只在创建响应里出现一次，立即保存
curl -s http://localhost:8743/api/v1/agents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"kimi-seat-1"}' | jq .data
```

丢 key 了用 `POST /agents/:id/keys` 增发，或 `POST /agents/:id/reset-key` 重置（旧 key 立即失效）。

### 2. 建座位

```bash
curl -s http://localhost:8743/api/v1/roundtable/seats \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "topicId": "<你的测试 topic id>",
    "label": "kimi-1",
    "vendor": "kimi",
    "cwd": "/home/administrator/code/agent-chamber",
    "permissionMode": "auto",
    "bindActorId": "<第 1 步 agent 的 actor id>"
  }' | jq .data
```

字段要点：

| 字段 | 说明 |
|---|---|
| `label` | 座位展示名（回复落 topic 时带 `metadata.seatLabel`，web 渲染 badge） |
| `vendor` | `kimi` / `codex`（M4a 已接入；claude / opencode 待扩展） |
| `cwd` | 座位工作目录 = agent 的环境边界，读写文件都在此树下 |
| `permissionMode` | **建议 `auto`** 上手。`default` 会把每个工具审批挂起，出现在 web 话题页的审批卡片里，等话题创建者/admin 人工裁决 |
| `bindActorId` | 绑定的 agent actor id；runner 用该 agent 的 API Key 拨号时才会领到这些座位 |

### 3. 起 runner

```bash
node packages/roundtable-runner/dist/cli.js \
  --platform-url http://localhost:8743 \
  --api-key <第 1 步的 apiKey> \
  --runner-name local-dev
```

看到 `hello` 对账完成、座位收到 `seat.assign`、ACP 会话拉起，即就绪。

### 4. 验证闭环

在测试 topic 里发一条消息（web 或 API 均可）→ kimi 座位应自动回复落回 topic（带 seatLabel）。

再杀 runner（Ctrl+C）重启 → 会话映射与对账游标在状态目录里，续聊无损。

---

## codex 座位（M4a）

**前置**：本机已安装并登录 `codex` CLI（`codex --version` 可用）。runner 每次拉起座位时会从 PATH 自动探测 `codex`；探测不到 → 座位 `start` 直接失败（detail：`codex CLI not found: install + login first`），安装登录后重试即可。

```bash
# 建 codex 座位：vendor=codex；model 建议显式钉死（如 gpt-5.6-luna）防误用贵模型
curl -s http://localhost:8743/api/v1/roundtable/seats \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "topicId": "<你的测试 topic id>",
    "label": "codex-1",
    "vendor": "codex",
    "cwd": "/home/administrator/code/agent-chamber",
    "permissionMode": "auto",
    "model": "gpt-5.6-luna",
    "bindActorId": "<第 1 步 agent 的 actor id>"
  }' | jq .data
```

同一 runner 可同时托管 kimi 与 codex 座位（hello `vendors` 双上报，chamber 按 vendor 绑定各自座位）。

**driver 自动钉死清单**（无需手动配置；桥 = `@agentclientprotocol/codex-acp@1.1.14`，钉为 runner 依赖，不走 npx）：

| 项 | 值 | 说明 |
|---|---|---|
| `approvals_reviewer` | `user` | **永远钉死人工审批**——用户 config.toml 的 `auto_review` / `guardian_subagent` 会让 agent 内部自动批准、审批到不了平台；driver 启动时恒注入 `CODEX_CONFIG='{"approvals_reviewer":"user"}'`，自定义 env 时勿覆盖 |
| `CODEX_PATH` | 自动探测 PATH | 探测到系统 `codex` 才拉起（桥内嵌 codex 缺平台二进制、实测起不来）；探测不到座位 start 失败，不静默兜底 |
| `model` | 座位显式钉死 | seat.assign 带 `model` 时自动 `set_config_option` 钉死（quota `model_usage` 含模型名，成本审计依据） |

**网络代理**（国内环境）：chatgpt.com 直连会被 DNS 污染 reset（`connection reset`）。runner 启动前先：

```bash
export http_proxy=http://127.0.0.1:10809 https_proxy=http://127.0.0.1:10809
```

（v2rayN HTTP 端口示例；runner 继承父进程 env，无额外配置。）

**权限档位映射**（平台档位 → codex 实际配置；**语义近似非等价**——codex `plan` = 规划后请求批准再执行，kimi `plan` 偏只读规划；非 plan 档 `collaboration_mode` 复位默认）：

| 平台档位 | codex `mode` | `collaboration_mode` |
|---|---|---|
| `default` | `read-only` | default |
| `plan` | `read-only` | `plan` |
| `auto` | `agent` | default |
| `yolo` | `agent-full-access` | default |

---

## CLI 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `--platform-url <url>` | 是 | 平台地址（`http(s)://host:port`，自动换算 `ws(s)://host:port/ws/runner`） |
| `--api-key <key>` | 是 | 平台 API Key（X-API-Key 握手认证） |
| `--runner-name <name>` | 是 | runner 名称（hello 上报，chamber 展示） |
| `--state-dir <dir>` | 否 | 状态目录（会话映射 / 对账游标 / 未确认队列），默认按 runner 名派生 `~/.roundtable-runner-<runner-name>`（显式指定仍优先） |
| `--log-level <level>` | 否 | `debug \| info \| warn \| error`，默认 `info` |

## 排障

| 现象 | 排查 |
|---|---|
| 握手 401 / 连接被踢 | API Key 错误、已重置，或**同 key 已有另一个 runner 在线**（一 key 一 runner，后到踢先到） |
| runner 在线但座位没反应 | 看日志有没有收到 `seat.assign`；检查座位 `bindActorId` 是否就是这把 key 对应的 agent；topic 消息是否满足注入条件（M1 自激防护：座位自身发言不回灌给自己） |
| 座位挂起不动、日志停在审批 | `permissionMode` 用了 `default`——审批在 web 话题页审批卡片里等人工裁决（创建者/admin 批准/拒绝）；无人裁决座位就一直等，想全自动改 `auto` 重建座位 |
| 重启后重复回复 | 不会：上行先落盘再发 + 双向 seq 对账，重连后走 hello 重放；若怀疑状态损坏，停 runner 后删 `--state-dir` 重来（会话历史会丢） |
| kimi 行为漂移 | 跑 PoC 回归脚本：`node agent-chamber/scripts/acp-poc.mjs`（8 条行为档案基线） |
| codex 座位 start 失败（`codex CLI not found`） | codex CLI 未安装或不在 PATH；`codex --version` 装好登录后重试（driver 不做静默兜底） |
| codex 审批不挂起、直接放行 | `approvals_reviewer` 被覆盖——driver 已钉死 `user`，自定义 env / agent 配置勿覆盖 `CODEX_CONFIG` |
| codex 会话 `connection reset` | chatgpt.com 直连被 DNS 污染；runner 启动前先 `export http_proxy/https_proxy`（见上） |

## 当前边界

- vendor：`kimi` / `codex` 已接入；`claude-code` / `opencode` 待扩展；单 workspace 并发写无锁（同目录多座位请自行错开，kimi + codex 同桌建议错开 cwd）
- `coordinator` 主脑逻辑目前只是标记字段，尚无实际调度行为
- 配额通知 `_meta.model_usage` 的 token 明细平台侧暂不消费（仅 runner 日志可见）
- task 级会话绑定在推迟清单
