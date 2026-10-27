# 飞书对接攻略（Notifications 通知出口 · 二期）

> 面向自部署用户的飞书自建应用对接指南。全程占位符脱敏：`<your-app-id>` / `<your-app-secret>` / `<open-id>`。
> 适用版本：v1.94.0-dev 起（**二期 = 多用户模型**）。平台侧契约权威 = `docs/api-definition.md` §20。

---

## 0. 一句话架构

平台后端 →（事件总线监听 → 编排器按**权限 + 偏好 + 相关性**路由 → 飞书 provider）→ 飞书开放平台 → **每个用户各自的手机私聊**。
**二期形态 = 多用户自助绑定**：每个人类用户在 Web「设置 → 通知」里绑定自己的飞书、按类别挑想收的通知；不再是「部署级单 Owner 收全平台」。

## 1. 创建飞书自建应用（约 5 分钟）

1. 打开 [飞书开发者后台](https://open.feishu.cn/app) → 创建企业自建应用（名字随意，如 "Agent Chamber"）
2. 左侧「添加应用能力」→ 添加**机器人**
3. 左侧「权限管理」开通以下权限：

| 权限标识 | 必需性 | 用途 |
|---|---|---|
| `im:message` | **必需** | 获取与发送单聊、群组消息 |
| `im:message:send_as_bot` | **必需** | 以应用身份发消息（私聊出口） |
| `contact:user.id:readonly` | 推荐 | 通过邮箱/手机号反查 open_id（见 §3-B） |
| 通讯录只读族（`contact:contact.base:readonly` 等） | 推荐 | `contact/v3/scopes` 反查 open_id（见 §3-A，单人租户最快路径） |

4. 左侧「版本管理与发布」→ 创建版本（如 1.0.0）→ 提交发布 → 等待审批通过（企业自建应用管理员审批；自己就是管理员时可自动通过）。
   ⚠️ **未发布版本机器人不可用**：应用能力/权限的改动都要发布后才生效。

## 2. 拿应用凭证

「凭证与基础信息」页：**App ID**（形如 `cli_xxxxxxxx`）与 **App Secret**。这两个值只进 `.env`，不进任何代码/文档/日志。

## 3. 拿用户的 open_id（三条路径）

> 二期里 open_id 的去向有两个：**用户在 Web「设置 → 通知」里自己填**（常规路径），或**管理员填进 env 做播种**（升级日平滑迁移，见 §4）。
> 无论哪条，先换取 tenant_access_token（所有后续调用的凭证，2 小时有效）：

```bash
curl -sS -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'content-type: application/json' \
  -d '{"app_id":"<your-app-id>","app_secret":"<your-app-secret>"}'
# 成功判据：返回 JSON 的 code === 0（⚠️ HTTP 200 不代表成功，飞书业务错误也是 200 + code!==0）
```

**路径 A：scopes 枚举（单人/小租户最快，实测推荐）**

```bash
curl -sS 'https://open.feishu.cn/open-apis/contact/v3/scopes?user_id_type=open_id' \
  -H "Authorization: Bearer <tenant_access_token>"
# data.user_ids 列出应用授权范围内的全部用户 open_id；单人租户只有你自己
# 拿不确定的 id 验明正身：
curl -sS 'https://open.feishu.cn/open-apis/contact/v3/users/<open_id>?user_id_type=open_id' \
  -H "Authorization: Bearer <tenant_access_token>"   # 核对 data.user.name
```

**路径 B：batch_get_id（需要 `contact:user.id:readonly`）**

```bash
curl -sS -X POST 'https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id' \
  -H "Authorization: Bearer <tenant_access_token>" \
  -H 'content-type: application/json' \
  -d '{"mobiles":["<飞书注册手机号>"]}'   # 或 {"emails":["<飞书注册邮箱>"]}
# ⚠️ 必须是飞书账号的注册邮箱/手机号——你的平台登录邮箱如果不是飞书注册邮箱，会返回 code=0 但无 user_id（查无此人）
```

**路径 C：私聊反查（不推荐）**

直觉做法"给机器人发条私聊再反查"**走不通**：`GET /im/v1/chats` 只列群聊，不含 p2p 会话（实测）。要读 p2p 消息需另开 `im:message.p2p_msg:readonly` + 事件订阅，为拿个 open_id 不值得。

## 4. 配置 .env（部署级键）

```ini
# ── Notifications 外部 IM 通知出口 ──
NOTIFY_ENABLED=true                 # 总开关（缺省 false=全静默；出境功能唯一可接受缺省）
NOTIFY_PROVIDERS=feishu             # 出口白名单（当前只有 feishu）
NOTIFY_CATEGORIES=task_done,direct  # 部署级类别白名单（缺省只开这两类 = 最低噪音）
FEISHU_APP_ID=<your-app-id>
FEISHU_APP_SECRET=<your-app-secret>
NOTIFY_WEB_BASE_URL=https://<你的域名>  # 深链基址（消息里的跳转链接由它拼出）

# ── 播种（可选；升级日平滑迁移用，日常不需要）──
FEISHU_RECIPIENT_OPEN_ID=<open-id>        # 二期起 = 播种源，不再是"收件人"
NOTIFY_OWNER_USERNAMES=<平台username>     # 播种归属依据；恰好转 1 人才会播种
```

**类别全量值域**（按需勾）：`task_done`（完工/阻塞跃迁）· `task_created` · `task_updated` · `task_assigned` · `topic`（你参与的话题有新消息）· `doc_created` · `doc_updated` · `doc_deleted` · `doc_moved` · `direct`（agent 直发端点）。
> 部署白名单只是"平台允许哪些类别出境"；每个用户还在 Web「设置 → 通知」里有自己的偏好开关（默认开 `task_done` + `direct`）。两层是**与**关系。

**播种语义（二期新增，升级版部署必读）**：
- 判据：`NOTIFY_ENABLED=true` ∧ 飞书三键齐 ∧ `FEISHU_RECIPIENT_OPEN_ID` 非空 ∧ `NOTIFY_OWNER_USERNAMES` **恰好解析出 1 人** ∧ 该用户从未有过飞书绑定（含已解绑的）∧ 该地址未被任何人占用。
- 成功 ⇒ 启动日志 `notify env seed: seeded 1 binding + backfilled N deliveries`：为该用户预建绑定（`source='env_seed'`，**已导入但未验证**——可投递，Web 徽标不冒充"已验证"），并把历史台账里发给该地址的行认领到他名下。
- ⚠️ **陷阱**：填了 `FEISHU_RECIPIENT_OPEN_ID` 却**不填** `NOTIFY_OWNER_USERNAMES` ⇒ 启动**直接拒绝**（`skipped_no_source`，补救只能改 env）；填了 ≥2 人 ⇒ ERROR 日志 `skipped_ambiguous`（不阻断）。**多 Owner 部署的正确姿势 = 不配播种键，让大家在 Web 自助绑定**。
- **解绑不复活**：用户解绑后播种判据恒假，重启不会偷偷重绑（tombstone 语义）。

**节流旋钮**（都有缺省，一般不用动）：`NOTIFY_TASK_THROTTLE_SECONDS`(300) / `NOTIFY_DOC_THROTTLE_SECONDS`(600) / `NOTIFY_TOPIC_THROTTLE_SECONDS`(600) / `NOTIFY_GLOBAL_RATE_LIMIT`(5) / `NOTIFY_GLOBAL_RATE_WINDOW_SECONDS`(600) / `NOTIFY_DIRECT_RATE_LIMIT_PER_WINDOW`(6) / `NOTIFY_DIRECT_RATE_WINDOW_SECONDS`(600) / `NOTIFY_HTTP_TIMEOUT_MS`(8000) / **`NOTIFY_PLATFORM_RATE_LIMIT`(20) / `NOTIFY_PLATFORM_RATE_WINDOW_SECONDS`(600)**（二期新增：部署级出境总闸）。
> 三级防刷屏：L1 = 同资源窗口去重（同一任务 300s 内不重复推）；L2 = **每用户**滑动窗口（默认 5 条/10min），超额自动合并为一条「[通知汇总] 另有 N 条通知（类别分布）」摘要；总闸 = 整个部署的出境上限（超额丢弃计入各用户摘要，摘要本身豁免）。
> ⚠️ 关系声明：当活跃绑定用户 ≥ 5 时总闸先于 per-user L2 生效（摘要机制被架空）——启动会有自洽 WARN 提醒调参。

## 5. 自检范式（配错了静默全灭是最难排的失败模式）

**常规自检 = Web 绑定 → 发测试消息**（二期主路径，不再靠 env 瞎猜）：

1. 登录 Web →「设置 → 通知」→ 填 open_id 保存 → 点「发送测试消息」
2. 手机收到 `[测试]` 开头的消息即成；徽标翻「已验证」且渠道自动启用
3. 失败看 toast 文案（已按原因分类人话化：地址错 / 平台未配置 / 限流…），不要啃英文原文

**启动日志锚点**（docker 部署看容器日志；宿主机部署看 logs/backend.log）：

```bash
grep -E 'notifications ENABLED|notify env seed|delivery-eligible|delivery-eligible channel' logs/backend.log
# 期望看到的健康信号：
#   notifications ENABLED — providers=[feishu] categories=[...]
#   （配了播种）notify env seed: seeded 1 binding + backfilled N deliveries
# 告警信号（都不阻断启动，但要处理）：
#   ERROR ... ZERO delivery-eligible channel bindings exist ... bound channels: 0
#     ← 开了通知但没人绑定渠道 = 全静默；引导用户去 Web 绑定
#   WARN ... "direct" but N agent creator(s) have no delivery-eligible channel binding: <名单>
#     ← 这些用户名下 agent 的直发会全部降级（recipient_not_bound）
#   ERROR notify env seed skipped [skipped_ambiguous] / [skipped_address_taken]
#     ← 播种被拒绝（多人 / 地址被别人占用），应用内补救
```

**投递台账核验**（admin 用户）：`GET /api/v1/notifications/deliveries`（可按 `recipientUserId` 过滤）或直接查表：

```bash
docker exec <pg容器> psql -U <db用户> -d <库名> \
  -c "SELECT category,status,title,last_error,recipient_user_id FROM notification_deliveries ORDER BY created_at DESC LIMIT 5;"
```

## 6. 消息格式（v2，含归属信息）

```
[完工] 实现通知模块一期                ← task 四类别：标题前缀 + 任务标题
看板「Agent Chamber」 · 薪火           ← 归属行：看板名 · 操作者名（指派类追加 → 指派给 X）
https://platform.example.com/tasks/<id>

[话题] Agent Chamber 意见箱            ← topic：话题名
agent-01：hint 触发器我建议……         ← 发言人名 + 消息摘要（100 字截断）
https://platform.example.com/topics/<id>

[文档更新] docs/api-definition.md      ← doc 四类别：文档路径
空间「Agent Chamber」 · API 定义总册    ← 空间名 + 文档标题
https://platform.example.com/docs/<id>

[薪火] 部署卡在审批环节，请看一下        ← direct：agent 显示名前缀 + agent 自填正文（≤2000）

[通知汇总]                              ← L2 超额摘要（不占额度、窗口内≤1 条）
另有 7 条通知（task_created×7）
https://platform.example.com
```

**谁会收到什么（二期路由语义）**：
- **自回声抑制（逐收件人）**：你（或你的 agent）触发的事件不会通知你。
- **topic**：只推给话题的 active 参与者；**task_***：推给「有权读该看板 ∧（成员 / 创建者 / 被指派人）」的用户；**doc_***：推给「有权读该空间 ∧（空间创建者/成员/文档作者）」的用户；**direct**：推给该 agent 的创建者（owner）。
- 权限按**事件发生时**实时判定（不留陈旧缓存）；topic 进出人会即时失效相关缓存。

## 7. 踩坑速查（全部实测）

| 坑 | 症状 | 正解 |
|---|---|---|
| HTTP 200 ≠ 成功 | 投递表一片绿但手机收不到 | 飞书业务错误也是 200 + `code!==0`；平台侧已按 code 判，排障看 `notification_deliveries.last_error` |
| 应用未发布 | 机器人搜不到/发不出 | 能力+权限改动都要「创建版本并发布」后生效 |
| 平台邮箱 ≠ 飞书邮箱 | batch_get_id 返回 code=0 但无 user_id | 用飞书**注册**手机号/邮箱，或走 §3-A 的 scopes 枚举 |
| token 边界过期 | 偶发 99991661 | 平台已实现提前 5min 刷新 + 并发去重；不要自己缓存 token |
| 飞书频控 | last_error 出现 `rate_limited` | 频控窗口是分钟级，平台不自动重试（避免放大）；降下来源量或调大 L2 窗口 |
| 通知"没有消息" | 分不清没人触发还是没配上 | 看启动锚点（§5）+ 投递表；抑制类（自回声/类别关/节流/无权限）不落表只打 INFO 日志 |
| 填了地址却不投递 | 渠道在但没验证 | **验证门**：地址必须收到过一条测试消息（或来自部署播种）才允许启用；换地址会重置验证态，需重新测试 |
| 绑定提示 409 占用 | 「该飞书账号已绑定到其他账户」 | 同一飞书账号全平台只能被一个已验证绑定占用（防串号）；是你本人就换回原账户，或找管理员解绑 |
| 解绑后想反悔 | 解绑=通知立即停止 | 重新绑定同一地址会**保留**验证态（不用重新测试）；但部署播种永远不会偷偷重绑你解绑过的渠道 |

## 8. 安全与出境声明

- **缺省全关**：`NOTIFY_ENABLED` 缺省 `false`；出境功能的唯一可接受缺省就是关
- **出境字段白名单**（启用后这些字段会经飞书离开你的网络，单源 = `apps/backend/src/config/notifications.config.ts` 的 `NOTIFY_EGRESS_FIELDS`）：任务标题（≤200）、看板名、操作者/发言人显示名、文档路径+标题、空间名、话题名、消息摘要（≤100）、直发正文（agent 自填，≤2000）、L2 摘要计数、深链 URL
- **生产 fail-fast**：`NODE_ENV=production` 且启用时缺必填键（飞书三键 + WEB_BASE_URL）→ 启动即拒绝，报错文案自带关闭方法；二期起 `NOTIFY_OWNER_USERNAMES` 不再是任何类别的必填项（仅作播种源）
- **验证门（服务端不变量）**：`enabled=true` 要求该地址当前已验证（`last_test_status ∈ {ok, seeded}` 且测试地址 = 当前地址）；未验证地址不占"地址唯一槽位"，防止抢注他人的飞书号
- App Secret 绝不出现在日志/投递记录/响应体（错误串经抹除处理）
