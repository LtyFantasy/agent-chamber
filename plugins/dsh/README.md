# dsh-agent-chamber

DeepSeek Harness（dsh）的 Agent Chamber 插件 bundle：在 dsh 会话中获得与 kimi-code 插件等价的工作环境——SessionStart 简报、PreCompact 提醒、协作规范 system section、chamber skills。本仓路径 `plugins/dsh/`，与 `plugins/kimi-code/` 对称（复用资产全部来自后者，零拷贝漂移）。

- 包名：`dsh-agent-chamber`，版本 `0.1.0`
- 形态：Cordis 插件（`lib/index.mjs` 导出 `name`/`inject`/`apply`）+ bundle patch（`cordis.patch.yml`）
- 目标 dsh 版本：本机实测 `0.1.5-rc.1`（一切以该版编译产物为准）

## 能力对照表（如实登记）

| 能力 | 本批状态 | 说明 |
|---|---|---|
| SessionStart 简报（`[agent-chamber]` 身份/任务/未读/nextUp） | ✅ | 两段式：`session-start` 存 spawn promise → 首个 `pre-step` waterfall 注入。**「首轮必达」的前提 = 简报脚本 ≤2s（pre-step 预算）内返回**；超时不算失败：槽位保留，后续每个 pre-step 最多再等 2s，直到 spawn 硬超时封顶（`SPAWN_TIMEOUT_MS=10s`，届时 `briefing=timeout-dropped` 清槽） |
| PreCompact 提醒 | ✅（语义折扣） | 提醒经 `agent.inject` 进压缩**之后**的上下文，不参与本次摘要（投递时点限制，见下） |
| SYSTEM.md 协作规范 section | ✅ | `order=100`（persona 之后、策略段之前），含 `{{` 保守自检 |
| chamber skills（7 个束） | ✅ | 由 `cordis.patch.yml` 的 `dsh-skill-filesystem` provider 挂载 |
| 项目 AGENTS.md 链 | ✅（dsh 原生） | dsh 原生读项目 AGENTS.md，本插件不碰 |
| UserPromptSubmit prompt-briefing | ❌ 本批不做 | kimi-code 侧的逐轮简报 hook，dsh 无对应事件面 |
| sessionStart.skill 自动加载 | ❌ 本批不做 | kimi-code 的 `session-start` skill 唤醒机制，dsh 侧以 catalog 可见性替代 |
| 12 人格 agents/ | ❌ 本批不做 | 后续候选 |
| 平台 MCP | ❌ 本批不做 | REST-only（用户已拍板 D-MCP） |

## 安装

### 阶段一：运行时验证形态（绝对路径 patch，零包装风险）

chamber profile 的 `~/.dsh/profiles/chamber/cordis.patch.yml` 直接写绝对路径行：

```yaml
- insert:
    - id: agent-chamber
      name: /path/to/agent-chamber/plugins/dsh/lib/index.mjs
    - id: agent-chamber-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: agent-chamber
        includeDefaultRoots: false
        watch: false
        customSkillDirs:
          - /path/to/agent-chamber/plugins/kimi-code/skills
          - /path/to/agent-chamber/plugins/kimi-code/skills/agent-chamber
```

### 阶段二：bundle 形态（推荐终态）

```bash
dsh plugin --profile chamber add /path/to/agent-chamber/plugins/dsh
```

`reconcilePlugins` 会自动把本包 append 进 profile `package.json` 的 `dsh.profile.bundles`（已实证）。注意：

1. **bundle patch 改动需重启 dsh**——web profile 的 `patchReload: live` 只 watch profile patch，不 watch bundle patch。
2. 若 profile patch 里还留着阶段一的绝对路径行，add 后 `--dump-config` 应见 **4 行 / 2 个重复 id**（两层都活的证据，非失败）；撤掉阶段一的行后应恰好 2 行。失败三层机制：duplicate loader entry id（最先炸）→ provider 重名 → section 重名。
3. `dsh.plugin.add` 前确认本包 `package.json` **没有 `exports` 字段**——bundle patch 的 `!!js` 用 `createRequire(...).resolve('dsh-agent-chamber/package.json')`，写了 exports 就必须含 `./package.json` 子路径，否则解析炸 boot。

## 配置

### 模型与凭据（机器级，不进仓）

`~/.dsh/.credentials.yaml`（0600）：

```yaml
refs:
  KIMI_API_KEY: <Kimi Coding 订阅 key>
```

`~/.dsh/settings.yaml`：

```yaml
llm-pi-ai:
  providers:
    kimi-coding:
      apiKeyEnv: KIMI_API_KEY
agent-default-model:
  provider: kimi-coding
  model: k3            # 端点没有 kimi-k3，用 k3（pi-ai catalog 内置 kimi-coding 路由）
  reasoningEffort: high
```

> ⚠️ **settings.yaml 是机器级，用户层恒覆盖 composition base**：改 `agent-default-model` 对 web/chamber 两 profile **同时生效**（无 profile 级胜出的办法）。
> 改动前原值逐字记录（回滚用）：`ollama-cloud / deepseek-v4.1-flash / high`。
> 回滚一行：把 `agent-default-model` 改回 `{provider: ollama-cloud, model: deepseek-v4.1-flash, reasoningEffort: high}` 并重启。

> ⚠️ **KIMI_API_KEY 缺失时的表现**：`kimi-coding` provider 取不到 key，**web profile 的新会话也会失败**（默认模型已全局切到 kimi-coding/k3）。遇到此现象先补 key 或按上一行回滚。

### 项目侧绑定（REST-only）

跨 harness 中立绑定文件（向上查找，`<项目根>/.agent-chamber/agent-chamber.json`）——与 kimi-code 插件共用同一文件与同一格式：

```json
{
  "schemaVersion": 1,
  "boardId": "<boardId>",
  "topicId": "<topicId>",
  "docSpaceId": "<docSpaceId>",
  "apiBaseUrl": "https://<host>/api/v1",
  "webBaseUrl": "",
  "apiKey": "ask_..."
}
```

`webBaseUrl` 可选：web 控制台与 API 不同域时显式指定（如本地 dev web:8742 vs api:8743）；缺省/空 = 从 `apiBaseUrl` 剥 `/api/v1` 推导——优先级「显式 `webBaseUrl` > `apiBaseUrl` 推导」。

或由 `.kimi-code/mcp.json` 的 server headers 提供 `X-API-Key`（推导优先级见 `plugins/kimi-code/README.md` 接入 playbook）。

### 「我在哪个 profile」判定卡

- CLI：`dsh --profile chamber --dump-config | grep agent-chamber`——应见两行（`agent-chamber` 插件行 + `agent-chamber-skills` provider 行），id 与 `providerName` 精确匹配。
- web UI：Settings → Plugins 面板查 `agent-chamber`。
- **web 会话的 cwd = UI 里选中的 workspace——必须选本项目目录**，否则简报脚本的 `.agent-chamber/` 向上查找会落空（分支①「未接入」模板）。

## 验证（装完后）

1. `dsh --profile chamber --dump-config | grep agent-chamber` → 两行。
2. 起 web（UI 选本项目目录为 workspace）→ 新会话 → transcript 里 `[agent-chamber]` 简报的 `user/message`（`source.plugin=agent-chamber`）**seq < 首个 assistant/message**，且 `session.header.cwd` == 项目根。
3. 端到端 oracle：问模型「我的活跃任务几条/未读多少/项目叫什么」→ 答案与简报数字一致。
4. skills：会话的 skill catalog 含 agent-chamber 系条目（`agent-chamber`、`session-start`、`diagrams`、`docs`、`roundtable`、`taskboard`、`topics`）。
   > 注意：插件 apply 内的 `checkSkillDirs` 自检只验证**目录布局**（isDirectory + 含 SKILL.md 束），**不覆盖 `cordis.patch.yml` 里 `!!js` 表达式的求值**——`--dump-config` 不求值 `!!js`，表达式正确性只能 boot 后由本项 skills 可见性实测兜住（v1.2.1 §6）。
   > 预期警告：双扫描根（扁平 `skills/` + 束 `skills/agent-chamber/`）会让 `agent-chamber` 被重复发现一次（扁平根发现束目录、束根再扫自身子束），boot 日志出现 `ignored because a higher-priority skill already exists` 属**预期**，不影响功能。
5. system prompt 装配含协作规范（「会话冷启动三连」等段落在场）。
6. 模型链路：一发真实对话 + 一次真实工具调用（若 anthropic 协议工具流异常，退路 = 路由级覆写 `api: openai-completions`，已实证 200）。
7. `/compact` 手工触发 → 压缩**之后任一步**出现 PreCompact 提醒即通过（手工 /compact 需 idle，延到下一条消息步属预期）；永不出现或出现在压缩前为失败。
8. 让模型按 skill §2.0a 走一次真实 `GET /agents/me`（REST 可达性）。

## 卸载

- 阶段二形态：`dsh plugin --profile chamber remove dsh-agent-chamber`（或手工从 profile `package.json` 的 `bundles` 删 `dsh-agent-chamber`），重启 dsh。
- 阶段一形态：删 profile `cordis.patch.yml` 的两行 insert（patch 热重载生效；热重载窗口内新建会话允许无简报，属预期）。
- 模型回滚见「配置」节的一行回滚。

## 已知取舍与语义折扣（如实登记）

1. **resume/clear/compact 不注入简报**：gate 仅 `source === 'startup'`。resume 再注入一条「我的待办」可能诱使模型自行开工；`clear`/`compact` 同理。与 kimi-code matcher 对齐（kimi 侧同样只有 startup）。
2. **PreCompact 语义折扣**：dsh 的 `session/event` observer 在 session append 非重入窗口内被同步调用，同步 inject 会撞重入守卫被吞，故提醒只能 `setImmediate` 延后 inject——它进入压缩**之后**的上下文，不参与本次摘要。这是投递时点限制，不是 bug。
3. **模板 A/D 文案的 mcp.json 引导是 kimi 语境**：简报脚本的「未接入」「连接异常」模板的绑定文件路径已随 2026-09-18 迁移指到中立 `.agent-chamber/`（模板现指 `.agent-chamber/agent-chamber.json`），剩余 kimi 语境只有 mcp.json 引导（零拷贝复用的代价）。dsh 语境下的补救动作：① UI workspace 选本项目目录；② 接入 playbook 以 `plugins/kimi-code/README.md` 为准；③ 模板里的 mcp.json 引导本批不适用（REST-only 走 `agent-chamber.json` 显式 `apiBaseUrl`/`apiKey`）。runtime 适配（需动 kimi-code `format.mjs`）登记为后续候选，另案处理。
4. **spawn 环境**：简报脚本以 `process.execPath`（dsh 进程同款 node）启动，继承进程环境（`HOME`/`PATH` 需可用）；脚本自身 logHook 落 `~/.kimi-code/logs/`，属预期、不拦截。

## 降级信号（结构化日志词表）

所有降级都留可见信号（`[agent-chamber] <feature>=<outcome>`），零纯静默：

| 日志 | 含义 | 下一步 |
|---|---|---|
| `briefing=injected` | 首轮 pre-step 注入成功 | — |
| `briefing=injected-late` | 超时后 spawn resolve，已补投 | — |
| `briefing=timeout` | pre-step 等满 2s 未 settle（槽位保留；后续每个 pre-step 最多再等 2s，spawn 硬超时 `SPAWN_TIMEOUT_MS=10s` 封顶累计） | 偶发可忽略；频发查网络/平台可达性 |
| `briefing=timeout-dropped` | 曾超时且 spawn 最终失败（清槽不重试） | 按 reason 查：spawn-timeout → 平台慢/不可达 |
| `briefing=fallback` | spawn error / 非 JSON / 脚本缺失（清槽不重试） | 按 reason 查：script-missing → 仓布局变化；invalid-json → 脚本输出损坏；detail 含 stderr 头/stdin 错误可诊断 |
| `briefing=hook-rejected` | spawn promise 意外 reject（executor 防护的兜底路径，理论上不可达） | 报修，附日志 |
| `briefing=empty` | 脚本 exit 0 但无 additionalContext（fail-open 静默场景） | 查脚本 stdin payload 与 `~/.kimi-code/logs/` |
| `briefing=pre-step-error` / `briefing=session-start-error` | 插件自身逻辑异常（已兜底透传） | 报修，附日志 |
| `briefing=inject-failed` | 补投时 agent.inject 抛错（agent 已 dispose 等） | 偶发可忽略 |
| `briefing=no-agent-id` | session-start payload 无可键控 id | 报修（dsh 契约漂移信号） |
| `compact-reminder=injected` / `=inject-failed` | PreCompact 提醒投递结果 | 失败偶发可忽略 |
| `system-section=registered` | SYSTEM.md section 注册成功 | — |
| `system-section=read-failed` | SYSTEM.md 读取失败 | 查仓布局（`plugins/kimi-code/SYSTEM.md`） |
| `system-section=unsafe-interpolation` | SYSTEM.md 含 `{{`（严格插值会炸装配），拒注册 | 改 SYSTEM.md 去掉 `{{` 或等 dsh 0.1.6 的 interpolate 开关 |
| `system-section=register-failed` | section 注册抛错（重名等） | 查是否有同名 section 提供者 |
| `service=agents missing` / `service=systemPrompt missing` | Cordis 服务缺席，对应功能不装 | 查 dsh 版本/装配顺序 |
| `skills-dir missing / not-a-directory / has-no-skill-bundle` | skills 目录布局自检失败 | 查 `plugins/kimi-code/skills` 布局 |
| `feature=<name> setup-failed` | 某功能装配期异常（其余功能不受影响） | 报修，附日志 |

## 开发

```bash
# 测试（仓根执行；零依赖，纯 node 内置模块）
node --test plugins/dsh/tests/*.test.mjs
```

文件职责：

| 文件 | 职责 |
|---|---|
| `lib/index.mjs` | Cordis 入口薄壳：`name`/`inject`/`apply`，动态装载 chamber.mjs（装载失败只降级不炸 boot） |
| `lib/chamber.mjs` | 三功能胶水：spawn 简报 / pre-step 注入 / compaction 延后 inject / SYSTEM.md section / skills 自检 |
| `cordis.patch.yml` | bundle patch：insert 插件行 + skills provider 行（`!!js` 经 createRequire 定位兄弟目录） |
| `tests/chamber.test.mjs` + `tests/fixtures/*.mjs` | node:test 全套：伪 ctx 驱动 + 真实 spawn + mock platform 端到端 |

设计红线（改动前必读）：apply() 零 throw；三功能各自故障隔离；禁止任何顶层静态跨包 import（含 `@deepseek-ai/*` 与 `../../kimi-code/*`）；用户消息手搓四件套；compaction 提醒严禁同步 inject。
