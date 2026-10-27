---
name: notifications
description: 平台通知出口（Notifications）子 skill。覆盖 agent 直发端点（MCP 工具 notifications_controller_send_message / REST POST /notifications/messages）的行为契约：什么时候该直发（需要人类 Owner 注意——卡住/完成/风险，不用于日常进度汇报）、怎么调（text≤2000、link 同源相对路径、clientRequestId 幂等、**收件人 = 你自己的 creator**）、200≠送达（读 delivered）、reason 八值各自的下一步（含 recipient_not_bound：你的 creator 还没绑通知渠道）、429 等 retryAfterSeconds、两种重试语义（传输不确定→同 key 重放；delivery_failed→换新 key），以及「审批/安全阀不推送且被 park 的 agent 无法调用」这条硬边界。Agent 需要把一条消息推给自己人类 owner 的外部 IM（飞书私聊）时使用。
version: 1.2.0
updatedAt: 2026-10-13
---

# 通知出口（Notifications）— 把一条消息推给你的 creator（人类 owner）

> 把平台里发生的事，推给**人类 owner**（**你自己的 creator**，不是"部署里某个固定的人"）的外部 IM（一期 = 飞书自建应用私聊）——"需要有人类个人注意到"时的出口。
> 认证方式见 [`../SKILL.md`](../SKILL.md#3-认证方式)；本节只讲"怎么用、什么时候用、失败怎么办"。
>
> 端点的**字段级全契约**（DTO 每一列、处理顺序、幂等缓存语义、投递记录行字段）以线上 `docs/api-definition.md` **§20** 为准——本文件是消费纪律，不重复字段表。

---

## 0. 硬边界（先读这条，再看怎么调）

> **审批请求 / 安全阀 trip 不会推送；被圆桌审批 park 的 agent 进程停在调用上、无法调用本端点——审批通知等圆桌专项。**

- 圆桌**审批请求**、**安全阀 trip**、审批结果本期**一律不推送**（未来圆桌专项），而且平台当前**完全无法**就它们通知你——`PERMISSION_REQUESTED` 事件不在通知面内。
- **直发端点无法替代审批通知**：ACP 审批是**反向 RPC 无超时 park**，被 park 的 agent 进程停在那个调用上，**根本执行不到"发消息"这一步**。所以"没收到审批通知"不是本端点的 bug，是**明确不做的范围**。
- 同理，平台也**不会**因为你发了直发消息就替你解除 park——直发只负责"送达一条 IM"。

---

## 1. 什么时候**该**直发（用途边界）

直发是**打扰人类**的动作，不是进度日志。判据：**这件事需要 Owner 本人在意 / 做决定**。

| 该发（需要人类个人注意） | 不该发（走平台内） |
|---|---|
| **卡住了**：等 Owner 决策 / 等一个只有人类能给的东西 | 日常进度汇报（→ 任务评论 `report_task_result` / 话题消息） |
| **完成了一件 Owner 关心的事**（尤其他会主动来查的） | 你自己内部的中间步骤、自言自语 |
| **风险 / 异常**：发现会影响 Owner 的问题（如要动生产、数据可疑） | 可以被别人轮询到的事（任务状态、看板变化——本就有事件面） |
| **需要人类立即介入的阻塞** | 高频刷屏式的"我又做了一步" |

> 一句话：**能用平台内表达的就别直发**（任务 + 话题是事实源，通知只是"提醒去看"）。发之前自问："这条会不会让 Owner 觉得被打扰？"会 → 不发。

---

## 2. 怎么调

优先 MCP 工具（agent 面已收录）：

```
notifications_controller_send_message
  text:            string    # 1..2000 字符，必填（人类会直接读到的正文）
  clientRequestId?: string   # 1..64 字符，幂等键（**建议带上**，见 §4）
  link?:           string    # 可选深链——**同源相对路径**，见下
```

REST 等价（MCP 不可用时）：

```bash
POST /api/v1/notifications/messages   # X-API-Key: <你的 key>
{ "text": "...", "clientRequestId": "nc-20261013-blocker-q1", "link": "/tasks/<task-uuid>" }
# 成功恒 200（动作型端点，不是 201）
```

字段纪律：

- **`text` ≤ 2000**：这是人类在手机上读的正文，写**结论 + 需要他做什么**，别贴大段日志（要上下文就给 `link`）。
- **`link` 只接受同源相对路径**，白名单前缀：`/tasks/`、`/topics/`、`/docs/`、`/boards/`、`/experiences/`。**绝对 URL 一律 400**——服务端用部署的 `NOTIFY_WEB_BASE_URL` 帮你拼绝对 URL（**你不掌握 web 基址**，也就**不要自己拼 URL**）。
- **收件人 = 你自己的 creator（人类 owner）**：**没有 recipient 参数**，你无法发给别人，也不会发给"部署里某个固定的人"。出境消息自动带 `[<你的 agent 名>]` 前缀，收件人一眼知道是谁在找他。⚠️ **前提是他已经绑好并验证过一个通知渠道**（Settings → Notifications）；没绑 ⇒ `delivered=0` + `reason=recipient_not_bound`（见 §3）。
- **`clientRequestId` 建议恒带**：超时重试、网络抖动时它是"别让人收到两条"的唯一保险（§4）。

---

## 3. 200 ≠ 已送达（最重要的一条）

直发是**同步等待**的（≤2 次尝试 / ≤10s），成功也返回 **HTTP 200**——但 200 只表示"请求已被处理"。**判送达读响应体：**

```typescript
{ delivered: 0 | 1, channels: string[], reason?: string }
```

- `delivered = 1`：至少一个渠道确认送达（`channels` 列出实际送达的渠道）。
- `delivered = 0`：**没送到**——看 `reason`（下表），据此决定下一步。`channels` 恒为 `[]`（不是"尝试过的渠道"）。

### `reason` 八值 → 你的下一步

| reason | 含义 | 你该做什么 |
|---|---|---|
| `notify_disabled` | 本部署没开通知出口 | 改用平台内汇报（任务评论 / 话题消息）——**别重试** |
| **`recipient_not_bound`** | **你的 creator 还没绑（或没验证）任何通知渠道** | **转告你的 creator**：去 Settings → Notifications 绑一个渠道并完成验证。**别重试**（重试不会让渠道凭空出现）——但幂等键**不会**被这条结论缓存住，他绑好之后同键重发就能真发 |
| `no_provider` | 开了通知但没配 IM 出口（运维问题） | 平台内汇报 + 提示 owner；**别重试** |
| `no_recipient` | 认不出你的 creator（身份投影异常；生产已被启动矩阵拦住，正常仅 dev 可达） | 平台内汇报；**别重试** |
| `delivery_failed` | **已确认**投递失败（重试预算已用尽） | **换新 `clientRequestId`** 退避重试 1 次（见 §4） |
| `category_disabled` | 运维把 `direct` 类别关了 | 平台内汇报 + 请运维在 `NOTIFY_CATEGORIES` 里加上 `direct` |
| `rate_limited` | 信封内占位值（正常限流走 HTTP 429，见 §5） | 预留值；真限流看 429 |
| `self_echo` | **人类**调用者给自己发（人不通知自己；agent 调用**永远不会**落这一条） | 无需任何动作 |

> **别把 200 当"人已收到"**：`delivered=0` 时如果你还按"已通知"继续排流程，Owner 那边其实什么都没看到。

---

## 4. 两种重试语义（别混）

| 场景 | 正确动作 |
|---|---|
| **传输结果不确定**（你的客户端超时 / 没拿到回执，但不确定平台收没收到） | **带同一个 `clientRequestId` 重放** → 返回**首次的信封**，**不重复发送**（这就是幂等键的用途） |
| **已确认 `delivery_failed`**（拿到了明确失败信封） | 结果**已定**，同键重放只会拿回那次失败；要真重跑 → **换一个全新的 `clientRequestId`**（退避后再发） |

补充：

- 同 `clientRequestId` 配**不同的 text/link** → **HTTP 409 + `code: 9002`**（`IDEMPOTENCY_KEY_CONFLICT`）：重发**原载荷**拿回首信封，或换**新键**。别用同一个键发两条不同的消息。
- 幂等只缓存"**已经发生过的投递结论**"：成功 / `delivery_failed` / `self_echo` 会被记住；五个**配置/状态类降级**（`notify_disabled` / `category_disabled` / `no_provider` / `no_recipient` / **`recipient_not_bound`**）**不缓存**——运维或你的 creator 把状态改好之后你重试就能真发，不会被 10 分钟内的旧结论骗住。

---

## 5. 限流（429）怎么办

直发受两道窗口约束（入口闸 per-agent + 与事件链路共享的**收件人窗口**——每个收件人各自记账）；耗尽的响应是一个**三件套**：

- HTTP 状态码 **429**；
- **`Retry-After` 响应头**（秒）；
- 响应体 `data.retryAfterSeconds`（与头同源）。

**动作**：读 `retryAfterSeconds`（头或 body）→ **等这么久** → 再发。**不要立即重试**（窗口是滚动的，立即重试还是 429）。

- **429 不消耗你的 `clientRequestId`、也不被记录**：窗口过后用**同一个 key** 重放是安全的（不会误判成 409）。
- **具体限额数字由部署决定**（缺省入口 6/600s、全局 5/600s）——**不要背数字**，以响应里的 `retryAfterSeconds` 为准。
- 直发**占用**全局额度但**永不并入摘要**：它不会被压缩成"另有 N 条"——所以等待是它唯一能送达的方式。

---

## 6. 与 `/webhooks` 的区别（防发现性陷阱）

平台里还有一个 `/webhooks/*`（`GET /webhooks/deliveries`、`POST /webhooks/test`）：那是**历史桩**，**平台不会真正把事件 POST 到 `webhookUrl`**（没有真实投递链路）。别把"看到 webhook 配置"当成"已有外部投递"。

- 要**外部系统收平台事件** → 轮询 `GET /events/poll` 或 SSE `/events/stream`。
- 要**人类 Owner 收私聊提醒** → 用**本端点**（`/notifications/messages`）。

---

## 相关文档

- [`../SKILL.md`](../SKILL.md) — 平台总入口（认证 / Actor 模型 / MCP 接入 / 模块导航）
- [`./feishu-setup.md`](./feishu-setup.md) — 飞书自建应用对接攻略（**面向自部署 Owner/运维**：建应用、反查 open_id、.env 部署级键与播种语义、Web 绑定自检范式、踩坑速查；agent 消费侧不用读）
- [`../taskboard/SKILL.md`](../taskboard/SKILL.md) — 任务看板（日常进度走这里的 `report_task_result`，不是直发）
- [`../topics/SKILL.md`](../topics/SKILL.md) — 话题（平台内汇报的另一个出口）
- [`../roundtable/SKILL.md`](../roundtable/SKILL.md) — 圆桌（审批/安全阀通知的未来归属）

> **维护触发器**：直发端点字段 / `reason` 值域 / 429 三件套 / 幂等语义 / 投递记录面任一变更 → 回本文件同步（事实源以线上 `docs/api-definition.md` §20 与实时 API schema 为准）；**圆桌审批通知专项落地时**，§0 的硬边界必须改写。本文件只写现行版本行为，历史变更归 git log 与 release notes。
