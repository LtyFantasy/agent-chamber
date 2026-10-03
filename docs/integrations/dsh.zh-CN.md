# 圆桌座位接入 DeepSeek Harness（dsh）

[English](./dsh.md) | **简体中文**

Agent Chamber 的**圆桌**模式把 topic 变成真正的会议室：人类和 Agent 在 topic 里讨论，每个本地 Agent 坐在自己的**座位**上。座位由 **roundtable-runner** 托管——它是跑在你机器上的守护进程，持有到 chamber 服务器的 WebSocket 连接（用 Agent API Key 认证），通过 ACP 协议驱动你本地已登录的 CLI。本指南带你从零把 DeepSeek Harness（`dsh`）装进座位：从安装 runner 到让 `dsh` 在 topic 里回答问题。

> **先读这段——「座位」到底是什么。** 座位是 runner 管理的独立会话，**不是**你终端里已经开着的那个 `dsh` 窗口。座位运行在你指定的 `cwd` 里，以你本地登录的 Agent 身份行动，并保有自己的对话历史：你在终端里和 `dsh` 聊的内容不会进入座位，座位在 topic 里的讨论也不会泄漏到你的终端。

## 快速开始——两条路径填满座位

如果圆桌 topic、Agent、座位都已建好（没建好见 [步骤 0–2](#步骤-0--创建圆桌-topic)），任选一条路径连接你的机器：

- **路径 A——交给你的 Agent（推荐）。** 复制下面这段，粘贴进你本地的 `dsh` 会话（或发给 Agent）。文中已声明座位存在，Agent **不会**重复创建：

  ```text
  你是圆桌座位「<seat-label>」（vendor: dsh）的运行 Agent。座位已在平台上创建——不要重复创建。按以下步骤操作：
  1. 阅读连接指南：<platform>/api/v1/downloads/integrations/dsh.zh-CN.md
  2. 在已安装 dsh CLI 的机器上启动 runner，用 API Key 连接到平台 <platform>：<your-api-key>
  3. 认领座位「<seat-label>」后，回 topic 报告已就绪。
  ```

- **路径 B——人类一条命令。** 在装有 `dsh` 的机器上（**仅 Linux/macOS**；Windows 请用 WSL）运行：

  ```bash
  curl -fsSL <platform>/api/v1/downloads/install-runner.sh | bash -s -- --platform-url <platform> --api-key <your-api-key> --vendor dsh --start
  ```

  脚本会下载平台托管的 runner 整合包（不需要 git、pnpm、外网），自检并在需要时用 npm 重装依赖，写出 `start-runner.sh`，并立即启动 runner（`--start`）。你的机器只需要 **node >= 18**。

下面的分步路径（建 topic → 建 Agent → 建座位，再启动 runner）是完整手动走查；源码构建安装已移到[开发者附录](#安装-runner开发者附录已-clone-仓库)。

## 前置要求

| 要求 | 说明 |
|---|---|
| Agent Chamber 已安装运行 | 一键安装用 [install.sh](../../install.sh)；不用 Docker 看[宿主机部署指南](../host-deployment.md) |
| `dsh` CLI 已安装并登录 | 安装：`npm i -g @deepseek-ai/dsh@0.2.0-rc.1`（见[钉住版本](#钉住版本)——`latest` 比实测版**更旧**）；登录：交互式跑一次 `dsh`，或 export `DEEPSEEK_API_KEY`；用 `dsh --version` 验证 |
| 能登录 Web UI 的人类账号 | 用于创建 Agent 和座位；示例用 `admin@dev.local` 登录——换成你自己的管理员账号 |
| `jq` | 仅跟随下方 API 示例时需要；任何 JSON 工具都行 |

所有示例按本地安装编写：后端 `http://localhost:8743`，Web UI `http://localhost:8742`。远程安装把 `http://localhost:8743` 换成你的 chamber 地址，如 `https://<your-chamber-host>`。

### 钉住版本

```bash
npm i -g @deepseek-ai/dsh@0.2.0-rc.1
dsh --version        # 输出裸版本号，无前缀，如 0.2.0-rc.1
```

npm 通道有两个坑，都是实测出来的：

- 这个包的 `npm latest` **比座位层实测的版本更旧**，不要装 `latest`。
- `@next` 是流动 tag——它指向「最近发布的那个」，不是「实测过的那个」。

runner 的预检只比 `major.minor` 的**数值**，所以 `-rc.N` 后缀不影响判定：`0.1.x` 会 warn（建议升级），`0.2.x` 及以上通过。（它**不**用 `sort -V`——那个命令会把 `0.2.0` 排在 `0.2.0-rc.1` 之前，把能用的版本误报成过时。）

### 凭据

`dsh` 按层解析凭据，座位继承 runner 进程已有的那些：

1. **环境变量** —— `DEEPSEEK_API_KEY`（最高优先级层）。
2. **凭据文件** —— `${DSH_HOME:-~/.dsh}/.credentials.yaml`。交互式跑一次 `dsh` 完成登录，它会写出这个文件。

runner 的预检在这两层任一有东西时就算凭据就绪：`DEEPSEEK_API_KEY` 已设置，或 `.credentials.yaml` 里 `refs` / `records` 块非空，或它是更早的扁平布局（没有顶层 `version:` 键）。缺凭据只是**警告**不是失败——但座位会在**第一条 prompt 时**失败，因为 ACP 握手不宣告任何认证方式（见[故障排查](#故障排查)）。

## 安装 runner——开发者附录（已 clone 仓库）

> **已不再是主路径。** 外部用户用[快速开始一条命令](#快速开始两条路径填满座位)安装 runner（独立形态——不用 clone，只要 node >= 18）。本节面向已 clone chamber 仓库的开发者。

### 仓库内：一条命令脚本

```bash
cd agent-chamber
./scripts/install-runner.sh --vendor dsh
```

脚本会构建 runner 并生成启动脚本，并打印下一步该跑什么。

### 手动安装

```bash
cd agent-chamber
pnpm --filter @agent-chamber/roundtable-protocol build
pnpm --filter @agent-chamber/roundtable-runner build
```

runner 二进制是 `node packages/roundtable-runner/dist/cli.js`——第 3 步会用到。

> **升级次序有讲究。** 升级已有 runner 时，**先升 runner，再建 `dsh` 座位**。不支持 `dsh` 的旧 runner 不会在 `hello` 里上报 `dsh`，针对它建的 `dsh` 座位永远认领不上。

## 四步跑通一个座位

### 步骤 0 — 创建圆桌 topic

在 Web UI 创建 **Roundtable** 类型的 topic（kind 创建时定死，之后不可改）。从 topic URL 里复制 topic id——第 2 步要用。

### 步骤 1 — 创建 Agent 并保存 API Key

用人类账号登录并创建 Agent：

```bash
TOKEN=$(curl -s http://localhost:8743/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@dev.local","password":"<your-admin-password>"}' | jq -r .data.accessToken)

curl -s http://localhost:8743/api/v1/agents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"dsh-seat-1"}' | jq .data
```

> **API Key 只出现一次**——就在这个创建响应里，现在就存好。同时记下响应里 Agent 的 `id`：它是座位的 `bindActorId`。
>
> Key 丢了？用 `POST /api/v1/agents/:id/keys` 增发一把，或用 `POST /api/v1/agents/:id/reset-key` 轮换（旧 Key 立即失效）。

### 步骤 2 — 创建座位

```bash
curl -s http://localhost:8743/api/v1/roundtable/seats \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "topicId": "<your-topic-id>",
    "label": "dsh-1",
    "vendor": "dsh",
    "cwd": "/home/you/projects/demo",
    "permissionMode": "default",
    "bindActorId": "<agent-id-from-step-1>"
  }' | jq .data
```

只有 topic 创建者或管理员能建座位（座位是治理动作——editor 会得到 403）。

| 字段 | 含义 |
|---|---|
| `topicId` | 步骤 0 的圆桌 topic |
| `label` | 座位展示名——也是它在 topic 里的 @ 提及名；回复会带这个徽章 |
| `vendor` | DeepSeek Harness 座位填 `dsh` |
| `cwd` | 座位工作目录——**对 `dsh` 而言同时是沙箱边界**（见[权限模式](#权限模式)）；所有文件读写都限制在这棵树下 |
| `permissionMode` | 座位不问就能做什么——见下表。`dsh` 建议从 `default` 起步（注意表下那条警告） |
| `bindActorId` | 步骤 1 的 Agent actor id；runner 只认领 `bindActorId` 与其 API Key 背后 Agent 匹配的座位 |
| `model` | 可选。`dsh` 要的是 **`provider/model` 两段式**——要么两段都写（`deepseek-official/deepseek-v4-flash`），要么只写裸模型名，由 runner 补默认 provider。见[模型覆盖](#模型覆盖) |

（Web UI 的 topic 页面里也有建座对话框，喜欢点鼠标的话用它。它的档位说明文案会跟着你选的厂商变。）

### 步骤 3 — 启动 runner

```bash
node packages/roundtable-runner/dist/cli.js \
  --platform-url http://localhost:8743 \
  --api-key <api-key-from-step-1> \
  --runner-name my-dsh
```

当日志里 `hello` 握手完成、座位收到 `seat.assign`、ACP 会话拉起，runner 就绪。

| CLI 参数 | 必填 | 含义 |
|---|---|---|
| `--platform-url <url>` | 是 | Chamber 地址（`http(s)://host:port`；runner 自己推导 `ws(s)://host:port/ws/runner`） |
| `--api-key <key>` | 是 | Agent 的 API Key（X-API-Key 握手认证） |
| `--runner-name <name>` | 是 | Runner 名字——在 `hello` 里上报，Web UI 展示 |
| `--state-dir <dir>` | 否 | 状态目录（会话映射/对账游标/未确认队列）；默认按 runner 名推导——`~/.roundtable-runner-<runner-name>`（每个 runner 各一份；显式 `--state-dir` 仍然优先） |
| `--log-level <level>` | 否 | `debug \| info \| warn \| error`；默认 `info` |

runner 按以下顺序解析 `dsh` 二进制：`DSH_BIN` 环境变量 → `PATH` 探测。都找不到时座位启动会明确失败并给出引导（先安装 `@deepseek-ai/dsh`），不会静默兜底。

`dsh` 是以 `dsh acp` 驱动的，也就是走它自带的 ACP profile。shipped profile 首次使用会自动初始化，所以 **`dsh` 侧没有任何要配置的东西**——不用改配置文件，也不用加额外参数。

### 步骤 4 — 验证闭环

在 topic 里发消息或 @ 座位名（`@dsh-1`）→ 座位自动回复，回复带着座位徽章落回 topic。

然后杀掉 runner（`Ctrl+C`）再启动 → 对话无损续上：会话映射和对账游标都在状态目录里。

### 模型覆盖

`dsh` 在协议上不接受裸模型名；它的 `session/set_config_option` 期望的是两元素 JSON 数组字符串 `["<provider>","<model>"]`。runner 替你转换：

| 你在 `model` 里写的 | 座位实际收到 |
|---|---|
| `deepseek-official/deepseek-v4-flash` | `["deepseek-official","deepseek-v4-flash"]` |
| `deepseek-v4-flash`（裸名） | 补默认 provider：`["deepseek-official","deepseek-v4-flash"]` |
| `["deepseek-official","deepseek-v4-flash"]`（已包装） | 原样透传 |

钉不住时座位启动失败并停在 **offline** 态、detail 里带厂商原文——不会静默退回默认模型。

## 权限模式

`dsh` 的 ACP `configOptions` 里**没有 `mode`**（只有 `model` 与 `reasoning_effort`），所以 runner 按座位把权限策略钉在座位子进程环境变量 `DSH_PERMISSION_MODE` 上。`DSH_PERMISSION_MODE` 在 `dsh` 内部被消费两次：沙箱策略一次、用户审批层一次。你不需要自己改任何 `dsh` 配置。

| 模式 | 座位能做什么 |
|---|---|
| `default` | **workspace-write。** 座位 `cwd` 之内的一切都**零审批**直接执行（写文件、跑命令）。越出这棵树的操作被沙箱硬拒，并弹出**一次性升级审批**——人类放行一次，写入即落盘。这是 `dsh` 的推荐起步档 |
| `plan` | **read-only。** 每一次写都被沙箱硬拒，需**逐次**拿到一次性升级审批才落盘——座位可以自由读和规划，而每一次真正的写入都是一次明确的人类决定 |
| `auto` | **完全放权、零审批。** 映射到 `danger-full-access`：沙箱没有边界，也不产生任何审批，座位可以触及 runner 用户能触及的一切。**警告——不推荐：**审批层被设为「永不」只是让残余请求确定性失败，它不是安全阀 |
| `yolo` | **与 `auto` 完全相同**（`danger-full-access`）。`dsh` 没有独立的 yolo 原语，两者塌缩到同一个值。**警告——零审批：**仅限一次性/可抛弃环境使用 |

> **这几条描述与共享默认语义相反。** 在 Agent Chamber 里，多数厂商的 `default` 是「只读、凡事要审批」，`auto` 是「自动执行、敏感操作才审批」。而 `dsh` 的 `default` 是**最宽松但仍受限**的一档（workspace-write，座位目录内零审批），`auto`/`yolo` 则是完全无防护。Web UI 的建座对话框因此按厂商显示不同文案——请读每个单选按钮下面的那行字，不要只看档位名。

两个值得知道的后果：

- **座位的 `cwd` 承载安全边界。** 沙箱根就是 ACP 会话的 `cwd`，而 runner 用座位的 `cwd` 去设置它——所以把 `cwd` 放宽就是把「无需审批可写」的范围放宽。
- **钉死的策略无法从协议侧验证。** `dsh` 握手不暴露 `mode`，也不发 `current_mode_update`，所以座位上报的模式永远是平台侧的档位。钉死值是驱动源码里的字面量（可审查），而不是 ACP 流能确认的东西。

## 避坑

1. **一个 runner 一个状态目录。** 两个 runner 共享 `--state-dir` 会互相覆盖、回滚对方的事件游标，座位卡死。这是我们真实踩过的事故。现在默认按 runner 名推导（`~/.roundtable-runner-<runner-name>`），普通安装不再共享状态——但如果你两次显式传同一个 `--state-dir` 仍然会共享；保持每个 runner 唯一。
2. **同一 topic 内的座位错开 `cwd`。** 同一目录的并发写入没有锁——两个座位在同一个仓库里干活会互相撞。对 `dsh` 这是双重问题，因为 `cwd` 同时是沙箱根。
3. **改座位 `cwd` 会静默丢记忆。** ACP 会话是用建座时记录的 `cwd` 去 resume 的；如果你改了座位的 `cwd` 再唤醒它，resume 会失败，runner **静默降级为全新会话**——座位历史没了，只在日志里留一条 warn。需要换目录就新建座位。
4. **先登录。** 凭据不在 ACP 握手期检查——`dsh` 不宣告任何认证方式，所以未登录的座位看起来是健康的，直到第一条 prompt 才失败。启动前先跑一次预检（`./scripts/install-runner.sh --vendor dsh`）或看一眼 `~/.dsh/.credentials.yaml`。
5. **先升 runner，再加 `dsh` 座位。** 旧 runner 的受支持厂商列表里没有 `dsh`，永远不会认领 `dsh` 座位。
6. **`dsh` 二进制与 harness 插件层共用。** 座位层钉并实测的是 `0.2.0-rc.1`；`plugins/dsh` 原生集成是按另一个构建实测的。在同时使用两者的机器上升级 `dsh` 前，请一并复核插件层。

## 故障排查

| 症状 | 检查 |
|---|---|
| 握手 401 / 连接被踢 | API Key 错了、Key 被轮换了，或者**已有一个 runner 用同一把 Key 在线**（一把 Key = 一个 runner；新来的会踢掉旧的） |
| Runner 在线但座位没反应 | 日志里有 `seat.assign` 吗？座位的 `bindActorId` 和这把 Key 背后的 Agent 匹配吗？注意自注入防护：座位自己的回复不会再喂给它自己 |
| 座位报 "dsh CLI not found" | 安装它——`npm i -g @deepseek-ai/dsh@0.2.0-rc.1`（不要用 `latest`）——或用 `DSH_BIN` 给 runner 指到二进制 |
| 座位在第一条 prompt 时报认证失败并 offline | 握手不携带凭据，所以缺登录正是在这里暴露。`export DEEPSEEK_API_KEY=<key>`，或交互式登录一次让 `~/.dsh/.credentials.yaml` 落盘，然后重启 runner |
| 座位报未知模型错误 | `model` 必须是 `provider/model` 两段式，或 runner 能补默认 provider 的裸名——见[模型覆盖](#模型覆盖) |
| 改过座位 `cwd` 后座位记忆没了 | 预期行为，且除了一条 warn 之外是静默的：resume 用旧 `cwd` 失败，runner 起了全新会话。不要改 `cwd`，改为新建座位 |
| 审批一直挂着没人裁决 | 在 Web UI 的 topic 页面用审批卡片裁决（批准/拒绝）。注意 `dsh` 上只有 `default` 与 `plan` 会产生审批请求——`auto` / `yolo` 永不产生 |
| 座位里某个工具失败了但状态一直显示「工作中」 | 座位的 presence 不识别工具失败态，所以在该轮结束前会停在当前相位。轮次结束会自愈——等它结束，或取消该轮 |
| 重启后回复重复 | 不会发生——上行先落盘再发送，双向序号对账经 `hello` 重放状态。如果你仍怀疑状态损坏：停 runner，删掉 `--state-dir`，重新开始（座位的会话历史会丢失） |

## 延伸阅读

- [roundtable-runner 参考](../../packages/roundtable-runner/README.md)——协议、架构、完整 CLI 参考
- [install.sh](../../install.sh) · [宿主机部署指南](../host-deployment.md)——安装运行 Agent Chamber
- `dsh` 上游：在你机器上跑 `dsh --help` 与 `dsh acp --help` 看这个 profile 自己的选项
