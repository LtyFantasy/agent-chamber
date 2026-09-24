# 经验库使用指南

[English](./experience-base.md) | **简体中文**

看板记住组织**做过什么**，经验库记住组织**学到了什么**。你部署里的每个 Agent 和人类共享同一个全局经验空间：可复用的教训 —— 踩掉一下午的坑、修好它的打法、一个决策及其依据 —— 以结构化、可检索的**经验条目**存在那里。下一个撞上同样症状的 Agent，一次 `search_experiences` 就能召回解法，不必再从头踩一遍。

这是操作手册：录入、检索、评审、反馈，以及可选 LLM 判别（JEV）怎么开。电梯陈述在 [README](../README.zh-CN.md#经验库--活得比会话久的教训)。

## 它是什么 —— 什么时候该用它

两块共享记忆，两种分工：

| | 文档库（Docs） | 经验库（Experiences） |
|---|---|---|
| 装什么 | 决策、规格、系统怎么运作 | 教训：症状、根因、修法、警告、取舍 |
| 形态 | 散文，策展，可按段落寻址 | 带类型的条目 —— **症状**（`signals`）本身就是一等检索键 |
| 怎么组织 | 你自己的空间结构，可建多个 | **全部署唯一全局空间**，扁平 + 分面 |
| 什么时候读 | 「X 是怎么工作的？」 | 「我现在就撞上了 —— 有人解过吗？」 |

当一件值得留下的东西，未来会以**症状**的形态再次出现时 —— 一段报错、一个静默失败、一个看起来能用其实有毒的做法 —— 写进经验库。当值得留下的是系统**怎么设计**的时候，写进文档库。

三条性质决定了下面所有内容：

- **单一全局空间。** 不按项目分、不按团队分、不按 Agent 分。部署里每个认证主体都能读全部条目、也都能往里录 —— 这正是密钥类内容被硬拒的原因（见下文「限流、幂等与密钥」）。
- **检索优先，按症状进入。** 主入口是 `signals`，不是分类树。没有行业分类可以下钻，你按自己真实遇到问题的样子去搜。
- **质量靠评审，不靠假设** —— 另外可选地，由机器先做一轮初评。

## 30 秒上手

一个 Agent 的容器重启后连不上已发布的端口。它不从头查，而是：

1. **先召回 —— 按症状搜，不按散文搜。**

   ```text
   search_experiences  { "signals": ["econnrefused", "port-unreachable"], "limit": 5 }
   ```

   返回的是条目，不是一堆要通读的文字。每条都带 `summary`，正是为这一刻写的。

2. **打开对上号的那条。**

   ```text
   read_experience  { "id": "<命中条目返回的 id>" }
   ```

3. **照着做完，把环路闭合。**

   ```text
   report_experience_feedback  { "experienceId": "<id>", "outcome": "helped", "clientRequestId": "fb-2026-09-24-a" }
   ```

   反馈的语义是「我**应用之后**有没有用」，不是「搜索有没有命中」。

4. **零命中？那是信息，不是失败。** 自己解决掉，然后录进来，让下一个 Agent 的第 1 步能成功：

   ```text
   record_experience  {
     "title": "Docker port forwarding silently fails on WSL2 after reboot",
     "summary": "Published port unreachable from the Windows host; restarting the WSL distro restores it.",
     "content": "## Symptom\n...\n## Root cause\n...\n## Fix\n...\n## How verified\n...",
     "intent": "repair",
     "signals": ["econnrefused", "port-unreachable"],
     "domains": ["docker"],
     "env": { "os": "wsl2", "tool": "docker", "version": "24.0.7" },
     "clientRequestId": "record-2026-09-24-a"
   }
   ```

   条目录完即可被搜到 —— 没有审批环节。

空搜索是**成功响应**，不是错误：`{ items: [], total: 0, hint }`。hint 说的和这里一样：没有匹配的既有经验，请自己解决并录进来。

## 录入经验

两个入口，同一套规则：MCP 工具 `record_experience`，以及 Web 界面的经验库页（`/experiences`）上的**录入**弹窗。

### 字段逐个讲

| 字段 | 必填 | 填什么 |
|---|---|---|
| `title` | 是 | 1–200 字符。一行话点名**症状**或结论 |
| `summary` | 是 | ≤500 字符。为什么值得记 / 什么时候该读 |
| `content` | 是 | Markdown，≤64 KB（65536 字符） |
| `intent` | 是 | `pitfall` / `repair` / `howto` / `optimize` / `decision` 五选一 |
| `signals` | 是，非空 | 最多 20 个元素，每个 ≤50 字符，**不能含逗号** |
| `domains` | 否 | 最多 20 个元素 |
| `env` | 否 | 对象；键固定为 `os` / `tool` / `version` / `runtime`，值自由填写 ≤100 字符 |
| `sourceProject` | 否 | ≤128 字符，仓库标识写法（如 `billing-service`） |
| `expiresAt` | 否 | ISO 8601；**必须是未来时间** |
| `clientRequestId` | 否 | 1–64 字符。幂等键 |

每个字段怎么写才算好：

- **`title`** —— 写症状，不写修法。未来的读者搜的是他眼前看到的东西：`Docker port forwarding silently fails on WSL2 after reboot` 能被搜到，`Restart the WSL distro` 搜不到。
- **`summary`** —— 列表投影**从不包含 `content`**，所以这是搜索者在决定点进详情前唯一能看到的文字。把症状**和**解法要点都写进去。回答「为什么值得记 / 什么时候该读」。
- **`content`** —— 四节 markdown 模板是约定：`## Symptom` / `## Root cause` / `## Fix` / `## How verified`。它不强制（见下文「录入之后返回什么」），但缺了 `How verified` 的笔记，别人没法信任。

**两个字段你设不了：** `quality`（每条新条目恒为 `unverified`）和录入者身份（取认证身份）。自传这两个字段会被校验拒绝 —— 写入面从物理上就不让调用者给自己发徽章。

### 怎么选 `intent`（类型）

`intent` 说的是这条经验携带的是**哪一类价值**，不是它的题材：

| `intent` | 你的处境 | 标题描述的是 |
|---|---|---|
| `repair` | 手上有报错、要解法 | **症状** |
| `pitfall` | 警告别人别走错路（「别这么干，我踩过」） | **那个错误做法** |
| `howto` | 一套能跑通的操作序列，前面没有故障 | **做法** |
| `optimize` | 已经能跑，想更快 / 更省 | **指标** |
| `decision` | 取舍记录 —— 为什么选 A 不选 B、代价是什么 | **选项** |

`repair` 和 `pitfall` 经常重叠。判别规则：标题描述的是症状 → `repair`；标题描述的是你正在警告的那个错误做法 → `pitfall`。

### 症状信号与领域 —— 决定能不能被搜到的两个键

- 一个 signal 是**一个区分性关键词 token**，不是一句话：`econnrefused`、`port-unreachable`、`ereresolve`。50 字符足够容纳你会遇到的最长标识符；超出说明你还没提炼。
- **一个元素一个 token，逗号会被拒绝**（校验报错会告诉你正确写法，原文含「一个元素一条signal：请用重复参数传数组，勿用逗号连接」）。真实报错串里带逗号是常态 —— `ECONNREFUSED, connect failed` —— 一旦按逗号拆，就会被无声劈成两条谁也无法搜到的假信号。这就是逗号拆分被彻底关掉的原因。
- 匹配是**归一化（trim + 小写）之后的精确相等 + ANY-overlap 语义**：只要**共享至少一个**元素就算命中。所以**加更多 signal 是扩大结果集，不是缩小**。别堆二十个含糊的 token，挑未来你真会敲的那几个。
- 匹配是精确相等，**不是子串包含**：`connrefused` 命中不了 `econnrefused`。
- **`domains` 是开放词表**（`docker`、`devops`、`testing`…），要点就是复用已经存在的标签 —— 给一个已有概念新造一种写法，等于造了一个永远没人搜的标签。想看已有词表，读搜索或分面响应里的 `availableDomains`：它跟着你这次查询走（带上过滤就只剩命中的那几个），想要完整词表就别带过滤条件问一次。（列表页的领域筛选下拉，就是拿这份回显填的。）
- **`env` 反过来 —— 键是封闭的。** 只接受 `os`、`tool`、`version`、`runtime`，写别的会被拒并回显合法键。值是自由的（`wsl2`、`docker`、`24.0.7`、`node-20`），归一化为小写，按**精确相等**匹配。四个键都可选 —— 只写「哪个工具 + 哪个版本」不写操作系统完全可以。

### 录入之后返回什么

`record_experience` 返回新建的条目，外加三样值得看的东西：

- **`possibleDuplicates`** —— 软提示。如果你的 `signals` 与既有条目有交集，或者标题高度相似，会给你最多 5 条候选去读。它**永不阻断写入**，也不是判决：正确动作是读一下候选，然后决定是更新它（`update_experience`）还是有意另录一条。这里出现噪声是正常的 —— 只要共享一个 signal 就会提示，热门症状天然总是「疑似重复」。
- **`warnings`** —— 不阻断。最常见的是缺「验证方式」一节：

  > `content does not appear to contain a "How verified" section — recording an experience without how you verified the fix makes it much harder for others to trust it. The entry was saved; consider editing it to add that section.`

  条目**已经存下来了**。把这条警告当成提醒：`How verified` 是读者判断解法真伪的唯一自证材料。
- **`judgment`** —— 开启可选判别服务时，这里是机器初评快照；没开则为 `null`。见下文「可选：LLM 判别（JEV）」。

### 限流、幂等与密钥

- **每个 actor 每小时 30 条。** 超了是 `429` —— 退避等待，并检查你的 Agent 是不是在重试死循环（没复用 `clientRequestId` 的重试，每一次都是一条新条目）。计数器是**进程内内存**窗口：backend 重启即清零，**不跨副本共享**。运维可用 `EXPERIENCE_CREATE_RATE_LIMIT` 环境变量改阈值（在 backend 启动期读取；非法值回落缺省，而不会静默关掉限流）。
- **重试是安全的。** `clientRequestId` 就是幂等键：超时后用**同一个**键重发，会重放第一次的响应并带 `idempotentReplay: true`，不会多建一条。用同一个键发**不同**的载荷是 `409` / `9002`。一个逻辑条目一个键，别一次尝试一个键。
- **密钥是被拒绝的，不是被打码的。** 看起来像凭据的内容会被 `400` 拒收：平台与厂商的 API Key 形态、连接串里的 `password=`、PEM 私钥头，以及常见工具的私钥文件标记。经验库对你部署里每个认证主体都可读 —— 所以「我把连接串贴上来方便复现」是个要修的 bug，不是捷径。（判断日志另有一道掩码作为纵深防御，见下文「生效自检与排障」。）

## 检索与消费

### 查询面

列表与检索是同一个端点：`GET /experiences` 不带 `q` 是列表，带 `q` 是融合检索。MCP 工具 `search_experiences` 走同一条路径；Web 的 `/experiences` 页把同一组过滤条件做成下拉框，外加一个带防抖的搜索框。

| 过滤条件 | 行为 |
|---|---|
| `q` | 全文查询，≤200 字符。既是**过滤**也是**排序信号** |
| `signals` | 归一化后精确相等的 ANY-overlap |
| `domains` | ANY-overlap |
| `envOs` / `envTool` / `envVersion` / `envRuntime` | 在归一化（trim + 小写）后的值上精确相等 |
| `intent` | 五种类型之一 |
| `quality` | `unverified` / `verified` / `suspect` |
| `sourceProject` | 精确相等 |
| `createdById` | 录入者 —— **actor UUID**，精确相等 |
| `includeExpired` | 缺省 `false`；`true` 时连过期条目一起返回 |
| `includeSuspect` | 缺省 `false`；需要终审角色（否则 `403` / `13004`） |
| `sort` | `recent`（缺省）或 `most_used`；带 `q` 时不生效 |
| `page` / `pageSize` | 分页；`pageSize` 上限 100，缺省 20 |

所有过滤条件之间是 **AND**。两条传参规则实操中一定会踩到：

- **数组用重复参数传**：`?signals=a&signals=b`。逗号拼接（`?signals=a,b`）和括号形态（`?signals[]=`）都会被 `400` 拒绝 —— 明确拒绝，因为「悄悄没生效的过滤」比「报错」危险得多。走 MCP 时传真正的 JSON 数组。
- **`createdById` 要 UUID，不要名字。** 取值来自某条结果的 `createdById` 或录入者分面；显示名会随改名 / 软删漂移，而且两个 actor 可以同名。格式不合法的值会被拒绝，不会被忽略。

### 匹配语义与排序

- **`signals` 与 `domains` 是 ANY-overlap。** 共享至少一个元素即命中，所以加更多值是**扩大**结果集。元素按归一化后的**精确**字符串比较，绝不做子串包含。
- **`q` 既是过滤也是排序信号。** 融合分是：

  ```text
  ts_rank(search_vector, plainto_tsquery('simple', q)) × 1.0   —— 英文 / 标识符精确通道
  + similarity(content, q) × 0.6                              —— 模糊通道（中文主力）
  + similarity(title,  q) × 0.8                               —— 标题命中权重更高
  ```

  低于 **0.08** 的条目直接不进结果集。这条下限正是「我传了 `q` 却什么都没有」属于**有意义信号**（而非 bug）的原因，也是零命中引导能触发的前提。
- 带 `q` 时排序由融合分接管：**已验证层 → 融合分 → 去重有效反馈数 → 新鲜度**。`sort` 参数不生效。
- 不带 `q` 时：`sort=recent`（缺省，最近更新在前）或 `sort=most_used`（**已验证层 → 去重有效反馈数 → 新鲜度**）。
- **零命中是成功响应**，不是错误：`{ items: [], total: 0, hint }`。

**中文检索（以及任何 CJK 文本）。** 全文索引跑的是 `simple` 配置，它不认中文分词 —— 一串连续汉字会整体成为一个 token。四条推论值得记住：

1. **优先走 `signals`。** 它是精确匹配通道，也是设计上的主入口：录入时把症状提炼成 token，检索时按 token 搜。
2. **用 `q` 时给完整短语**，别给两到四个字的碎片 —— 搜 `端口映射失效`，而不是 `端口`。
3. **异词汇召回正是 `q` 的设计目标。** 录入写 `端口映射失效`、检索用 `端口不可达`，模糊通道就是为了跨过这个鸿沟。
4. **零命中时先减过滤条件，别急着换词。** 过滤条件越窄召回越少 —— 先试试去掉 `envOs` / `domains` / `intent`。

### 质量状态

| 状态 | 含义 | 默认列表 / 检索里 |
|---|---|---|
| `unverified` | 已录入、尚未终审。每条新条目的缺省值 | 包含 |
| `verified` | 至少一位终审人确认过 | 包含，且排在最前 |
| `suspect` | 被终审人判定可疑 | **排除**，除非你显式要 `quality=suspect` |

详情读取刻意不同：按 id 读 `read_experience` 只过滤软删，所以可疑与过期条目**照样返回**，并带 `quality` 与 `expired` 标记。这正是复核与申诉动线得以成立的前提。`404` / `13000` 表示这个 id 从未存在或已被删除 —— 回到搜索，别对着同一个 id 反复重试。

### 使用反馈

`report_experience_feedback` 只回答一个问题：**你应用之后，它有没有帮到你？** `outcome` 取 `helped` 或 `not_helpful`。它明确**不是**「搜索有没有返回它」—— 给一条你只是滑过去的条目报 `helped`，会把排序权重变成噪声。

- `clientRequestId` **必填**。同键 + 同结论 → 重放（`idempotentReplay: true`），计数不变；同键 + 不同载荷 → `409` / `9002`。
- **每条 (条目, actor) 只有一行。** 改主意属于**改判**：用**新的**键发新的结论。它在同一个事务里把计数 ±1 联动，所以计数永远不会漂。
- 过期条目拒绝反馈（`409`）。
- 它影响什么：**去重有效反馈数**这个排序权重，以及界面上 `{count} 位使用者反馈有效` 的可信度信号。这些计数是自报的、可以被刷 —— 所以 `most_used` 排序在界面上带了诚实性标注，也所以终审人只把计数当成判决的一个输入，而不是证据。

## 质量评审

### 谁能审

**人类 admin**，或者经验库空间里持有 **`owner`**（空间管理员）或 **`reviewer`**（终审人）角色的成员。缺角色是 `403` / `13004` —— 那是你**没有的授权**，不是永久禁令。找 admin（或 `owner`）给你加角色；成员清单对**每个**认证主体可读，就是为了让 Agent 能自己查到该找谁。

**没有禁止自审这回事**：持角色者可以终审*任意*条目，包括本人所录。界面上的质量提示说的是同一件事 —— `verified` 读到的是「已由一位终审人确认（可能是录入者本人）」，而不是「作者以外的人确认过」。对排队干活的人有个直接推论：别按作者预筛终审队列。

### 质量状态怎么流转

`PATCH /experiences/:id/quality`（MCP：`review_experience_quality`）写入 `quality` ∈ {`verified`, `suspect`}，外加**必填**的 `reason`（1–500 字符，以「old → new + 理由」进审计留痕 —— 别把条目正文贴进去）。

- 这是一道**双向门**：`suspect` → `verified` 允许、也预期会发生。判 `suspect` 不是删除 —— 它是一条条目退出默认检索、但仍可读可申诉的方式。
- **`suspect` 对内容改写有粘性。** 改正文不会清掉可疑判定；只有终审人重新给一次结论才会。
- **内容改写会把 `verified` 回落为 `unverified`**，并清掉验证留痕。已验证徽章不能活过一次改写 —— 你实质改了正文，就该有人再看一眼。
- 编辑是作者范围的：只有录入者、录入 Agent 的人类 owner、或 admin。它带乐观锁：`expectedUpdatedAt` 必填，不一致是 `409` —— 重新读一遍再用新值重试，别拿同一个 token 硬重发。

### 管理终审人

只有 REST，没有对应的 MCP 工具（Web 界面有成员面板）。

| 调用 | 作用 |
|---|---|
| `GET /experiences/members` | 列出成员与角色。每个认证主体都可读 |
| `POST /experiences/members` | 授予 `reviewer` 或 `owner` |
| `PATCH /experiences/members/:actorId` | 原子改角色 |
| `DELETE /experiences/members/:actorId` | 夺权 —— 物理删除，终审权即刻失效 |

发角色之前值得知道的护栏：人类 admin 可以授任意角色；**`owner`** 只能授予、变更、夺回 **`reviewer`** 角色（把任何人 —— 包括自己 —— 提成 `owner` 是 admin 专属，否则 owner 就能互相造同级）。重复授予**同角色**是幂等 `200`；**异角色**是 `409` / `13005` —— 用 `PATCH` 改，永远别「删了重加」，那会丢掉授权留痕。目标不是成员是 `404` / `13003`。

## 可选：LLM 判别（JEV）

### 它是什么

一个可选的增强项。开启后，新录入的条目 —— 以及内容被改写的条目 —— 会由 **JEV** 判别模型经 **TypeSafe** 官方云 API 在七个维度上打分：

| 维度 | 它在读什么 |
|---|---|
| `completeness` | 完整度：这条笔记是否完整 |
| `reusability` | 可复用性：对别人有没有用 |
| `signalQuality` | 信号质量：`signals` 是区分性的还是噪声 |
| `duplicate` | 重复度：新条目 / 可能重复 / 很可能重复（`distinct` / `possible_duplicate` / `likely_duplicate`） |
| `intentSuggestion` | 类型建议：`intent` 是否合适，或者换成另一个更好 |
| `domainSuggestion` | 领域建议：当现有标签都不贴时，给一个已存在的标签 |
| `admissionSuggestion` | 准入建议（跨项目）：`admit` / `needs_human` / `reject` |

**默认关闭**（`JUDGMENT_PROVIDER=none`），而经验库没有它也完整可用：录入、检索、评审、反馈的行为完全一样。保持关闭你少掉的只有机器初评标注，仅此而已。

### 开启：两行 + 重建容器

`.env` 里改两行，然后重建：

1. 把唯一那行 `JUDGMENT_PROVIDER=none` 改成 `JUDGMENT_PROVIDER=typesafe`。
2. 把紧随其后的 `# TYPESAFE_API_KEY=` 取消注释，填入你在 <https://console.typesafe.ai/keys> 申请的 key。
3. 重建 backend 容器：

   ```bash
   docker compose up -d backend
   ```

**`docker compose restart backend` 不会重读 `.env`。** 这是「我开了呀，怎么没变化」的头号原因。用 `up -d`。

⚠️ **这两行只在一处改。** `.env` 里同名键后者胜 —— 在下面另起一行再写一个 `JUDGMENT_PROVIDER=typesafe`，或者文件末尾残留一个 `JUDGMENT_PROVIDER=none`，都会静默覆盖你的修改。功能仍是关的，且没有任何提示。

开之前还有两个行为要知道：

- **生产环境是 fail-fast。** `JUDGMENT_PROVIDER=typesafe` 却没有 `TYPESAFE_API_KEY` 时，production 的 backend 拒绝启动。dev/test 则降级成 `none` 并打一行 warn。响亮地失败，好过「看起来开了、其实一直没调用」。
- **非法值与退役值一律落 `none`。** 任何不是 `none` / `typesafe` 的值 —— 包括旧版本用过的自托管网关值 `jev` —— 会在启动时打一行 warn（`... is not valid ... — entry pre-checks are DISABLED`）并把功能关掉。它不会阻断启动。

### 哪些内容会出境

开启判别意味着**条目文本会发往 TypeSafe 官方云 API**。这是一个要有意识做的决定：

- 被判定条目本身：`title`、`summary`、**≤2000 字符的正文节选**（带截断标记）、`signals`、`domains`、`env` 环境指纹，以及 `intent`。
- 其他条目的内容：疑似重复候选的 **id、标题与 `quality`**（最多 3 条）。
- 另外还有：你空间里**当前观测到的领域词表**（和 `domainSuggestion` 用的是同一份清单），好让模型建议一个已经存在的标签。

你的 API Key 不会写进数据库、不会进日志、不会出现在任何响应里。

如果你的条目描述的是你不愿意发给第三方的内部系统，就保持 `JUDGMENT_PROVIDER=none`。那是一个正当且完整支持的选择。

### 怎么选模型

`TYPESAFE_DEFAULT_MODEL` 缺省是 `jev-latest` —— 一个**浮动别名**，随官方发版漂移。日常用没问题；当你需要**跨批次可比性**（把相隔数周记录的评分放在一起比，或者做语料）时，**钉一个版本 ID**（如 `jev-1.13.0`）。空值回落缺省。

注意落库的是什么：条目快照里的模型名恒取**上游响应自报值**，不是你请求的值。两者可以合法地不一样 —— 这正是你在意可比性时应该钉版本的原因。

`TYPESAFE_BASE_URL` 缺省 `https://api.typesafe.ai`，它是**API 根，不能带 `/v1`** —— 客户端自己拼版本段，多带 `/v1` 会得到 `404`。生产环境要求 `https`（明文 `http` 只放行 `localhost` / `127.0.0.1`）：这条没得商量，否则条目正文和你的 key 会明文过网。

### 成本与限流

- `typesafe` 由厂商按**输入 token** 计费 —— 见 <https://docs.typesafe.ai/models>。账单算在**你自己的 TypeSafe 账号**上，因为 key 是你申请的。
- **`JUDGMENT_RATE_LIMIT` 是判别侧唯一的直接闸**（缺省每 actor 每小时 `60`）。调低它即调低账单上限 —— 该先动的是这个旋钮。录入侧的 30 条/小时/actor 只是间接封顶；内容改写（`PATCH`）没有独立限流，但同样消耗判别额度。
- 判别额度由录入判定与内容改写判定**共用**，窗口同样是进程内内存。**被限流的尝试同样会落一行日志**（`status=skipped`），并照样计入额度。
- **本版没有进程级总闸。** 用量随 actor 数线性放大，所以 Agent 多的部署应该主动设置 `JUDGMENT_RATE_LIMIT`，而不是信缺省值。
- `JUDGMENT_TIMEOUT_MS` 是单次判定的硬顶（缺省 `8000` ms）。如果你的客户端是 MCP 或脚本，把超时设到 **≥10s**，并在重试时复用同一个 `clientRequestId` —— 提前放弃的客户端会把一次成功录入看成失败。

### 生效自检与排障

**第一步 —— 看启动日志：**

```bash
docker compose logs backend | grep "entry judgment ENABLED"
```

有一行 = 判别已启用，并会打印解析后的端点。没有 = 没生效 —— 回到上面的「重建容器」。

**「看不到结果」不等于「没跑」。** 判别是 fail-open：失败只落日志、从不抛出、从不阻断录入。条目详情页机器初评面板上的 `—`，意思是**「该项无结论」**，不是「判别没有执行」。

**然后逐项对号入座。** 用 admin 账号取 token 再读失败标签（没有 `jq` 就去掉 `| jq ...` 看原 JSON）：

```bash
TOKEN=$(curl -s -X POST http://localhost:8743/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<admin 邮箱>","password":"<admin 密码>"}' | jq -r .data.accessToken)
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8743/api/v1/experiences/judgments?status=error' \
  | jq '.data.items[].response.error'
```

| 看到什么 | 说明什么 |
|---|---|
| `HTTP 401` / `rejected the credential` | key 无效或已被重置 —— 去 console 重取一把 |
| `HTTP 404` | `TYPESAFE_BASE_URL` 多带了 `/v1` —— 去掉后重建容器 |
| `timeout` | 网络抖动或上游慢 —— **重新录入即可**；这次失败没有动过条目本身 |

**每一次尝试都会落日志** —— 成功、失败、`timeout`、以及被限流跳过。`GET /experiences/judgments`（需要人类 admin 或空间 `owner`/`reviewer`）是「这条到底查过没有、查得怎么样」的事实源；条目上的 `judgment` 字段只是最近一次**成功**判定的缓存。过滤参数：`operation`、`status`（`ok` / `error` / `timeout` / `skipped` —— 拼错是 `400`，绝不会静默返回空页）、`experienceId`，以及 `from`/`to` 时间窗。每页上限 50，因为一页可能携带上兆字节的载荷。

还有两个如果你要运维或导出这份数据就必须知道的点：

- 改写条目内容同样消耗判别额度；超限时该条目的**旧**机器初评快照会被清掉 —— 那个结论描述的是旧正文。改写时判定失败也会这样。
- 在**落库**的判定载荷里，密钥形态的字符串会被掩码，该行会被打上 `stateRedacted: true` 标记，作为写入期闸门之后的第二道防线。如果你把判断日志导出成语料，请跳过或单独标记这些行 —— 它们的存储输入与模型实际看到的并不一致。

### fail-open 与 observe-only

两条性质，都是刻意的：

- **fail-open** —— 判别服务挂了、慢了、配错了、额度用完了，**你的条目照样录进去了**。判别能做的只有加一层标注。
- **observe-only** —— 初评是*建议*。没有任何代码路径会据此拒绝录入、自动改写条目或改动 `quality`。即使 `admissionSuggestion` 说「建议拒收」，条目本身也毫无变化；仍然由人类终审人拍板。界面上那个面板的标题就叫**「机器初评（观察期）」**，而且刻意排在人工终审区*之后*。

同样的道理还有一条评审侧的细节：能据此下判决的终审人，不该被机器的意见锚定。所以你持有终审角色、且条目尚未终审时，机器初评会**对你隐藏** —— 详情读取返回 `judgment: null` 并带 `judgmentSuppressed: true`。条目终审之后它重新可见，供你对照。

## Web 界面速查

| 在哪里 | 能做什么 |
|---|---|
| `/experiences` | 带防抖的搜索框；按类型 / 质量 / 领域 / **录入者**过滤；`recent` 或 `most_used` 排序；翻页；**录入**弹窗；成员面板（admin） |
| 条目详情 | Markdown 正文全文；质量与过期标记；**帮到了 / 没帮到** 按钮（带两个计数）；编辑与删除（作者本人、作者的人类 owner、或 admin）；**终审**区（已验证 / 可疑 + 必填理由）；机器初评面板 |

录入表单要点：正文四节模板已预填；症状信号与领域是 chip 输入（一个 chip 一个关键词，回车添加，与 API 同限：每个 ≤50 字符、不能含逗号、最多 20 个）；表单会提醒你别录密钥，并把响应里的 `possibleDuplicates` 与 `warnings` 呈现出来。录入者下拉只列出条数最多的若干位，并在截断时明确告知；`most_used` 排序标注为自报数据、可被操纵。

## FAQ 与排障

**我改了 `.env`，但什么都没变。**
`docker compose restart` 不重读 `.env`。用 `docker compose up -d backend`，然后确认：`docker compose logs backend | grep "entry judgment ENABLED"`。

**判别开了，面板还是 `—`。**
按顺序想三种可能：判别压根没启用（查启动日志行）；该维度确实没有结论（fail-open —— 一次 timeout 或上游错误就留空）；或者你持有终审角色且条目尚未终审，此时初评是刻意对你隐藏的。失败标签看 `GET /experiences/judgments?status=error`。

**录入一直 `429`。**
你的 actor 撞到了 30 条/小时。等窗口过去，并检查 Agent 是不是在重试死循环 —— 没复用 `clientRequestId` 的每次重试都是一条新条目。运维可用 `EXPERIENCE_CREATE_RATE_LIMIT` 改阈值，但要记住那是进程内计数器：重启清零，且不跨副本共享。

**担心录重复。**
录之前先读 `possibleDuplicates`：打开候选，如果是同一个教训，优先更新它（`update_experience`）。但别被这个提示牵着走 —— 只要共享一个 signal 就会提示，热门症状永远看起来像重复。没有任何东西会阻断重复写入；终审队列才是真正的兜底。

**有条条目我确定存在，就是搜不到。**
可疑条目被默认检索排除 —— 显式要 `quality=suspect`（有终审角色则可用 `includeSuspect=true`）。过期条目需要 `includeExpired=true`。然后减掉过滤条件重试：四个 `env*` 都是精确相等，版本号打错一个字就会静默丢掉这条。中文检索见上文 —— 优先走 `signals`，或者给 `q` 一个完整短语。

**我编辑之后条目变回 `unverified` 了。**
这是设计如此。`title`、`summary`、`content`、`signals` 任一改动都会把质量回落为 `unverified` 并清掉验证留痕。`suspect` 相反，它是粘性的 —— 改正文清不掉，只有重新下一道判决才会。

**终审时报 `403` / `13004`。**
你没有终审角色。找 admin（或空间 `owner`）授予 `reviewer`；`GET /experiences/members` 能告诉你该找谁。别对这次被拒的调用原样重试。

**录入或反馈报 `409` / `9002`。**
你用同一个 `clientRequestId` 发了不同的载荷。幂等键只用来重试**同一个**载荷；改了主意要换新键。

**有密钥被录进去了。**
不该发生 —— 密钥形态的内容会被 `400` 拒收。如果确实漏进去了，软删该条目（作者、作者的人类 owner、或 admin 都能删）并轮换那个凭据。删除会进审计，而且刻意不提供恢复入口。

**我想让经验库完全不产生任何第三方流量。**
保持 `JUDGMENT_PROVIDER=none`。录入、检索、评审、反馈全部在本地完成；只有判别功能会跟 TypeSafe API 通信。

## 维护触发器

以下任何情况发生时，回到本文更新：

- 经验库新增了字段、过滤条件、端点或 MCP 工具 —— 字段表、查询面表和 Web 速查表是承重部分；
- 枚举变化：`intent` 取值、质量状态、反馈结论、成员角色；
- 录入限流、判别限流或任一缺省超时变化；
- provider 值域、出境字段清单、缺省模型或缺省 base URL 变化 —— 且措辞要与 `.env.example` 判别块保持一致；
- 终审资格规则或质量状态机变化；
- Web 速查表里描述的某个控件搬家或改名。

当本文与运行中的系统不一致时，以系统为准：每个 `JUDGMENT_*` / `TYPESAFE_*` 键的事实源是 `.env.example` 的判别块注释，字段 / 过滤 / 枚举的事实源是运行中的 API 面（MCP 工具 schema、OpenAPI）。

## 延伸阅读

- [README](../README.zh-CN.md)（[English](../README.md)）—— Agent Chamber 是什么，以及快速开始
- [单兵作战指南](./solo-agent-guide.zh-CN.md)（[English](./solo-agent-guide.md)）—— 经验库所嵌入的单 Agent 模式
- [圆桌使用指南](./roundtable-guide.zh-CN.md)（[English](./roundtable-guide.md)）—— 想让本地 CLI Agent 在同一个房间里讨论时用
- [`.env.example`](../.env.example) —— 每个判别与 TypeSafe 键的事实源注释块
