---
name: diagrams
description: 用平台四工具（upsert_diagram / read_diagram / patch_diagram / validate_diagram）创建、修改、修复 Architecture Diagram IR v1 图文档的主教材。覆盖五图型选型路由与最小 IR 骨架、quality_profile（standard/showcase）门规则、创作铁律（一条主链路/≤12 主节点/先自动路由）、422 修复凭据消费分层（details.diagnostics vs details.checks，非 data 键）、patch_diagram 的 RFC 6901/6902 指针教程与 409 冲突 rebase、平台限制（repository 证据拒绝、无视口截屏验收、web 只读）。使用场景：用户要求"画架构图/流程图/时序图/数据流图/状态机图"、修改已有图、修复被渲染门拒绝的图。完整 IR schema 见仓库 packages/diagram/schemas/。
version: 1.0.0
updatedAt: 2026-08-30
---

# 画图与改图 — Diagram IR v1（平台四工具）

> **AGENT-DOC-HOOK | 权威文档联动**
>
> 本 skill 是「IR 契约三层投放」的 skill+文档层（Agent 学画图契的主教材）；MCP 四工具的描述只是生存指南，完整契约在本文件与 schema。权威事实源按序：
>
> - **IR schema（契约事实源）**：`agent-chamber/packages/diagram/schemas/`（5 类型 + common；与校验器同源，改契约先改这里）
> - **行为事实源（已实现）**：`apps/backend/src/modules/docspace/diagram.controller.ts`（5 端点）、`diagram.service.ts`、`diagram-renderer.service.ts`（门规则）、`doc.service.ts` `parseDiagramIr`（R3 前置拒绝）；`diagram-patch.ts`（指针语义）；MCP 工具 `packages/platform-mcp/src/tools/{upsert,read,patch,validate}-diagram.ts`
> - **设计决策**：`.kimi/plans/diagram-ir-v1-plan.md`；线上 `docs/api-definition.md` diagram 小节
>
> 契约变更流程：schema/API 变更 → 本 skill 同步更新（version bump）→ `~/.agents/skills/diagrams/` 运行时副本由主 Agent 统一复制。

---

## 0. 四工具总览与定位

用户要一张图时，用 **MCP 四工具**完成全部画图/改图/修图工作流：

| 工具 | 用途 | 关键点 |
|---|---|---|
| `upsert_diagram` | 创建/整体覆盖一张图（按 spaceName + path） | `ir` 对象直传；服务端规范化 + 全量渲染门，不过不入库；命中既有非图 path 会把它翻转为图文档 |
| `read_diagram` | 读图：**解析后的 IR 对象** + `contentHash` + render 元数据 | `contentHash` 是 patch/upsert 的乐观锁 token，改图前必读；patch 数组下标以此对象为准 |
| `patch_diagram` | 原子 JSON patch 改图（RFC 6901/6902 子集） | `expectedContentHash` **必填**；一轮 patch 全过才算数（一败全拒）；409 冲突 → 重读 rebase |
| `validate_diagram` | dry-run 校验拿修复凭据（零副作用） | 两模式：裸 `ir` 校验 / 存量图预演 `patches`；`ok=false` 时 `diagnostics` 就是修复依据 |

人类看图的入口：web 阅读页通过 iframe 挂载渲染快照，**只读预览**（v1 不做 web 编辑，IR 只经 Agent/MCP 写入）。

---

## 1. 选型路由（5 型）

| 类型 | 一句话用途 | 必填顶层字段（除 schema_version=1 / diagram_type / meta.title 外） |
|---|---|---|
| `architecture` | 组件/服务/基础设施拓扑，云与安全边界 | `components`；布局：`layout: {mode:"grid"}` + 每组件 `row`/`col`，或省略 layout 手摆每组件 `pos` |
| `workflow` | 业务流程/审批关卡/CI-CD/runbook | `lanes`、`nodes`（每节点 `lane`+`col`+`type`+`label`）、`edges` |
| `sequence` | API 调用链/请求生命周期/异步追踪 | `participants`（≥2）、`messages`（每条 `from`+`to`+`y`+`label`，`y`≥160） |
| `dataflow` | 数据管线/ETL/血缘/数据治理 | `stages`（2~5）、`nodes`（每节点 `stage`+`row`+`type`+`label`，≥2）、`flows`（每条 `from`+`to`+`label`） |
| `lifecycle` | 状态/状态机/重试/等待与终态 | `lanes`（**必须含 id `main`**）、`states`（每状态 `type`+`lane`+`col`）、`transitions` |

选型歧义时按用户问题的主语定：讲"系统由什么组成"→ architecture；讲"事情怎么流转"→ workflow；讲"谁在什么时候调谁"→ sequence；讲"数据到哪里去"→ dataflow；讲"对象处于什么状态"→ lifecycle。

### 1.1 最小可用 IR（5 型，均实测过渲染门：9/9 artifact checks、0 errors、0 warnings）

```json
{ "schema_version": 1, "diagram_type": "architecture",
  "meta": { "title": "Web 应用架构" },
  "layout": { "mode": "grid" },
  "components": [
    { "id": "web", "type": "frontend", "label": "Web 前端", "row": 0, "col": 0 },
    { "id": "api", "type": "backend", "label": "API 服务", "row": 0, "col": 1 }
  ],
  "connections": [ { "from": "web", "to": "api", "label": "HTTPS" } ] }
```

```json
{ "schema_version": 1, "diagram_type": "workflow",
  "meta": { "title": "工单审批流程" },
  "lanes": [ { "id": "human", "label": "人工" } ],
  "nodes": [
    { "id": "submit", "lane": "human", "col": 0, "type": "frontend", "label": "提交工单" },
    { "id": "approve", "lane": "human", "col": 1, "type": "backend", "label": "审批" }
  ],
  "edges": [ { "from": "submit", "to": "approve", "label": "提交" } ] }
```

```json
{ "schema_version": 1, "diagram_type": "sequence",
  "meta": { "title": "登录时序" },
  "participants": [
    { "id": "client", "type": "frontend", "label": "客户端" },
    { "id": "server", "type": "backend", "label": "服务端" }
  ],
  "messages": [ { "from": "client", "to": "server", "y": 160, "label": "POST /login" } ] }
```

```json
{ "schema_version": 1, "diagram_type": "dataflow",
  "meta": { "title": "日志处理管线" },
  "stages": [ { "label": "采集" }, { "label": "入库" } ],
  "nodes": [
    { "id": "collector", "type": "backend", "label": "采集器", "stage": 0, "row": 0 },
    { "id": "db", "type": "database", "label": "日志库", "stage": 1, "row": 0 }
  ],
  "flows": [ { "from": "collector", "to": "db", "label": "写入" } ] }
```

```json
{ "schema_version": 1, "diagram_type": "lifecycle",
  "meta": { "title": "任务状态机" },
  "lanes": [ { "id": "main", "label": "主流程" } ],
  "states": [
    { "id": "s0", "type": "start", "label": "新建", "lane": "main", "col": 0 },
    { "id": "s1", "type": "active", "label": "处理中", "lane": "main", "col": 2 }
  ],
  "transitions": [ { "from": "s0", "to": "s1" } ] }
```

按这个骨架起步即可被校验器接受；更多字段（subtitle/views/legend/cards/geometry 控制）见 §8 与完整 schema。

---

## 2. IR 通用约定（全部 5 型）

- **顶层必填**：`schema_version: 1`、`diagram_type`（对应型名）、`meta`（含非空 `title`）。**所有层 `additionalProperties: false`**——未知字段直接拒，别发明字段。
- **id 模式**：`^[a-zA-Z][a-zA-Z0-9_-]*$`——字母开头，仅字母数字下划线连字符；所有 `id`（组件/节点/参与者/状态/lane）与关系 `from`/`to` 引用都走它，且各自集合内唯一。关系集合（connections/edges/messages/flows/transitions）可给 `id`（稳定 `#relation=` 锚点），可省略。
- **共享枚举**（`common.schema.json`）：`componentType` = `frontend | backend | database | cloud | security | messagebus | external`；`variant` = `default | emphasis | security | dashed`（顺序图消息另有 `return`）；`locale` = `en | zh-CN`；`point` = `[x, y]` 两数数组。
- **可选常用 meta 字段**：`locale`（控制 viewer 固定 UI 语言，不翻译你写的内容）、`animation: "trace"`（动效，默认静态）、`visual_preset`（classic 默认/信号流/蓝图/editorial——只有用户明确要风格才写）、`views`（引导视角，≤5 个）、`legend`（`mode: auto|all|hidden` + `entries.<kind>.label|visible`；省略 = 诚实 auto）。
- **创作规范**：默认省略 `subtitle`/`legend`/`visual_preset`；`meta.locale` 与正文语言一致（zh-CN 图就写 `"zh-CN"`）；产品名/命令/协议路径保持原文不翻译。
- 完整字段清单与类型范围：`agent-chamber/packages/diagram/schemas/{common,<型名>}.schema.json`（唯一事实源，本文档不复刻全文）。

---

## 3. quality_profile 与门规则（fail-closed）

- `ir.meta.quality_profile`：`standard`（默认）| `showcase`（严格）。**缺省（省略该字段）= 服务端按 `standard` 判定门规则**，生效值记录进 render 元数据——仍请显式写：创作纪律（见 §4 为什么）；**写了非法字面量则被 schema 校验拒**（422 `schema/enum`，"must be equal to one of the allowed values"），改回 `standard`/`showcase` 之一即可。
- **门规则**：schema/geometry/composition **errors 恒拒**（422，不落库）；**warnings 仅 `showcase` 拒**（showcase 过门 = 0 errors + 0 warnings，与 archify 验收口径一致）；`standard` 下 warnings 不拒写，随响应返回供你自查。
- 写入响应带 `render: {qualityProfile, composition, htmlBytes, htmlSha256, renderedAt}`——`composition` 即当时门用的 errors/warnings 数。
- 门失败 = 422 `DIAGRAM_VALIDATION_FAILED`，**整单拒绝、零落库**（无文档行/无版本/无事件）。5xx（如 `renderer unavailable`）= 平台基础设施问题，与你的 IR 无关，重试或上报。

---

## 4. 创作铁律（画图前先读）

1. **一条主链路**：一个显而易见的开心路径，侧支从最近的主路径节点分出。边多了先删低价值边，而不是加路由控制（`via`/`labelAt`/`channelX/Y`——被诊断点名才加，且每轮最多加一个）。
2. **≤12 个主节点**：信息密度让位给可读性；密集场景拆多张图。
3. **先自动路由**：`route` 缺省 `auto` 自动布线，不要预排坐标。**手摆坐标是最后手段**（如 architecture 的 `layout: grid` 自动排布是第一选择；free placement 需给每个组件 `pos`，仅作有界例外）。
4. **写前定 profile**：按交付要求写 `quality_profile`；不确定就用 `standard`（warnings 不阻塞，常规成本低）。
5. **每次修改后 validate**：见 §5 修复剧本；两轮不收敛就停手如实汇报（不硬凑通过）。

---

## 5. 修复剧本（422 错误消费）

### 5.1 定位阶段（MCP 工具结果里的键名是 `details`，不是 `data`）

422 错误在 MCP 工具结果中形如 `{ error, status: 422, message, code: "DIAGRAM_VALIDATION_FAILED", details: { stage, diagnostics[], checks[], composition, profile } }`。按 `stage` 分层消费：

| stage | 修复凭据在哪 | 怎么修 |
|---|---|---|
| `parse` | `details.diagnostics[]`（code `input/json-parse` / `input/not-object`） | 修 JSON 语法/保证是对象——你的 IR 不是合法 JSON 文本 |
| `schema` | `details.diagnostics[]`，每条 `{code: "schema/<keyword>", subject, evidence, supportedFixes[]}` | 对每条按 `code` + `subject`（带 `path`/`identity` 定位）逐条修，优先用 `supportedFixes` 给的可执行修法 |
| `render` | `details.diagnostics[]`（code `layout/*`、`edge/*`、`geometry/*` 等几何/布局约束） | 同上——`layout/constraint` 是渲染器布局约束（如缺 lane `main`、free placement 缺 `pos`），照 `supportedFixes` 或 message 修 |
| `composition` | **`details.checks[].details` 散文指引**（无结构化 fixes）；错误码形如 `check/<name>` 或组合 issue | 按散文逐条修：重叠/越界、边穿节点、交叉/走廊/贴边、间距/标签 |

> 平台前置拒绝（stage=`schema`，即使 schema 本身合法）：`meta.repository` 或 `components[].sources` 非空 → code `platform/repository-evidence-unsupported`。**平台渲染环境不设 `ARCHIFY_REPO_ROOT`，仓库证据永不可用——直接移除字段**，别按 supportedFixes 的去试 --repo-root（那在平台上不存在）。见 §7。

### 5.2 修复顺序（validate_diagram ok=false 时）

1. 修 `meta.quality_profile` 缺失/拼错（先于一切几何——profile 影响 errors/warnings 归类）与 schema 错误；
2. 修节点重叠/越界（坐标、行/列冲突）；
3. 修边穿节点与端点方向错误；
4. 修交叉、歧义走廊、贴边跑线、路由节奏；
5. 修标签间距/遮挡（label↔node → label↔label → label↔route）。

### 5.3 不收敛停手纪律

每轮 `validate` 后只改诊断点名的 `subject`、核对 `evidence`，从 `supportedFixes` 里选；修完再 validate（**错误数必须创新低才继续**）。**连续两轮不收敛（错误数没降）→ 停手**，把剩余 diagnostics 原文如实汇报给用户，不脑补不硬凑。

---

## 6. patch_diagram 教程（改图：RFC 6901/6902 子集）

改图**不是**重发整份 IR：先 `read_diagram`（拿当前 IR 对象 + `contentHash`），再按 JSON pointer 打补丁，服务端应用后重跑完整渲染门。

### 6.1 指针语法（RFC 6901）

- 路径以 `/` 开头，逐段下行：`/components/2/label` = `components` 数组第 2 项（**0-based，等于 read_diagram 返回对象里的下标位置**）的 `label`。
- 三 op：`replace`（改值，目标必须存在）、`add`（加；数组允许下标 == 长度做尾插，也支持 `"-"` 追加标记；对象允许新键）、`remove`（删，目标必须存在）。`replace`/`add` 必须带 `value`（显式 `null` 是合法值）。
- **根路径（`""` 或 `"/"`）恒拒绝**——整体替换走 `upsert_diagram`，不是 patch。
- **`~0`/`~1` 转义在 IR 上零触发**：RFC 6901 规定段内 `~` → `~0`、`/` → `~1` 转义，但 IR 的字段名与 id 值都受 `^[a-zA-Z][a-zA-Z0-9_-]*$` 约束，不含这两个字符——**你唯一的高频错点是数组下标数错**（从 `read_diagram` 返回的数组位置数，不是 1-based）。

最小示例（改第 3 个组件的 label）：

```json
[ { "op": "replace", "path": "/components/2/label", "value": "API 网关" } ]
```

### 6.2 流程与冲突

1. `read_diagram` → `ir` + `contentHash`；
2. 组装 `patches`（可多个，**原子**：一败全拒，全部不生效）；
3. `patch_diagram { docId|path, patches, expectedContentHash }`——**hash 必填**，缺省工具侧直接拒绝；
4. hash 过期（他人在你读之后改过）→ **409 `DOC_CONTENT_CONFLICT`**：重读 → 把补丁 rebase 到新 IR → 重试（这是多 Agent 共改的裁判机制，不是失败，是竞态信号）；
5. 指针错 → 422 `DIAGRAM_PATCH_FAILED` `{pointer, reason, supportedOps}`；
6. patch 后的 IR 若渲染门不过 → 422 诊断指向 **patch 后状态**（按 §5 修）。

---

## 7. 平台限制（不可绕行）

- **repository 证据不支持**：`meta.repository` / `components[].sources`（非空）在写入与 validate 时被前置拒绝（422）。"引真实代码"在平台上是做不到的——基于你已验证的事实手工画，别发明证据。
- **无视口截屏验收**：服务端门 = schema + 几何校验 + 静态 artifact 检查（无 Chrome）。archify 的 `visual-check`（四档桌面视口截屏）**仅本地可用**，平台不会跑它——提交给平台的就是 IR，HTML 是服务端确定性地生成的（同 IR 同 HTML，sha256 可对）。
- **web 端只读**：阅读页只展示渲染快照，没有编辑入口；任何改动都经四工具。
- **markdown 通道被锁**：对图文档调 `patch_doc`/`append_doc` 会被 400 拒绝（`DIAGRAM_DOC_TYPE_LOCKED`，指路 patch_diagram/upsert_diagram）；`patch_doc_metadata` 改 docType 触及 diagram 同样拒绝。`read_doc` 仍能读（返回 IR 全文文本），但解析对象/render 元数据走 `read_diagram`。
- **错误分层铁律**：422 = 你的 IR 要修；500 = 平台渲染器问题（重试/上报），两者不要混淆。

---

## 8. 常见坑速查（字段级，schema 为最终依据）

| 坑 | 正确做法 |
|---|---|
| architecture 组件没位置 | 用 `layout: {mode:"grid"}` + 每组件 `row`/`col`（≥0）；省略 layout = free placement，组件必须有 `pos:[x,y]` |
| lifecycle 报 `layout/constraint` 缺 lane | 必须有 lane id `main`（阶段主轨）；`terminal` 是底部结果带保留名；其余 lane 落中间事件带。`states[].col` 范围 0..4（主轨） |
| lifecycle 过渡太短（<32px） | 拉开列距或经通道布线，或去掉标签——标签是语义数据，能保则保 |
| workflow 节点没位置 | 每节点必带 `lane`（引用 lanes[].id）+ `col`（0..5） |
| sequence 消息 y 太小 | `messages[].y ≥ 160`；参与者在顺序图里**没有**自动端口分散（variant 用于语义表达，非装饰） |
| dataflow 阶段数 | `stages` 2~5；`nodes[].stage` = stages 数组下标（0-based），`row ≥ 0` |
| 关系标签撞车 | 先移标签/改路由/拉开间距，再考虑缩短措辞保语义；`labelAt`/`labelDx`/`labelDy`/`labelSegment` 一次只用一个 |
| 间距口径 | 间距 = 盒子间**净空**不是中心距；标签净空需 > 标签宽度 + 8px（CJK 一字算 2 单位） |
| 边穿节点 | 恒为硬错误（与 profile 无关）；改起终点/路由，别假装看不到 |

---

## 9. 完整工作流示例（走一遍）

1. **画**：选型（§1）→ 按最小骨架写 IR（§1.1）→ 显式 `meta.quality_profile` → `upsert_diagram {spaceName, path, ir}`。
2. **被拒**：422 → 读 `details`（§5.1）→ 按修复顺序改（§5.2）→ 重试；两轮不收敛停手汇报（§5.3）。
3. **改**：`read_diagram` → `patch_diagram`（§6）；冲突 409 → rebase 重试。
4. **交验前**：`validate_diagram` dry-run 确认 `ok:true`（零副作用，可反复跑），再落最终写入。
