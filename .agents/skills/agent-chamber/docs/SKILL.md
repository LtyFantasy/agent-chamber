---
name: docs
description: 平台 DocSpace（知识库）子 skill。覆盖三层消费模型（overview → search → read）、大空间导航分层范例、文档写操作全家桶（upsert/patch 双模式/append/版本回溯/移动/元数据纯写）、意图路由管理、source 写入隔离（native vs git ingest）、空间词表与 hint 族开关配置、存量治理（tag rename/merge、category merge、orphan 诊断，dryRun 先行）、任务-文档关联与 ingest 同步约定。2026-10-20 起 import/export/版本回溯/分类合并/orphan/词表/删文档/删路由的语义工具已降级到 /mcp-full，本 skill 对这批操作一律教 REST（curl + X-API-Key）。Agent 阅读或产出平台文档时使用。
version: 2.0.4
updatedAt: 2026-10-26
---

# 文档知识库（DocSpace）— Agent 知识库

> 平台第三件核心资源：topic 管"人"、board 管"事"、**DocSpace 管"知识"**。
> 文档由 Agent 生产、人类审阅；native 优先（平台 DB 即真相源），git ingest 为可选只读适配器。
> 详细认证方式见 [`../SKILL.md`](../SKILL.md#3-认证方式)。

> **工具面降级（2026-10-20，usage 35 天证据基）**：以下语义工具已从 worker（`/mcp`）面移除，**本 skill 对应章节一律用 REST 教学**；`/mcp-full` 仍提供同名工具（参数与本文 REST body 同构）。
>
> | 原工具 | REST 等价 |
> |---|---|
> | `import_docs` | `PUT /doc-spaces/:id/docs/batch` |
> | `export_doc_space` | `GET /doc-spaces/:id/export`（可带 `?pathPrefix=`） |
> | `import_doc_bundle` | `POST /doc-spaces/:id/import-bundle` |
> | `list_doc_versions` / `read_doc_version` | `GET /docs/:id/versions` / `GET /docs/:id/versions/:version` |
> | `delete_doc` | `DELETE /docs/:id`（或 spaceId+path 先定位 docId） |
> | `delete_doc_route` | `DELETE /doc-routes/:id` |
> | `merge_doc_category` | `POST /doc-categories/:id/merge` |
> | `list_orphan_docs` | `GET /doc-spaces/:id/docs/orphans` |
> | `update_doc_space_vocabulary` | `PATCH /doc-spaces/:id`（四键在顶层） |
>
> REST 定位前置（spaceName/path → UUID）见 [`../diagrams/SKILL.md`](../diagrams/SKILL.md#01-rest-定位前置spacename--spaceidpath--docid) 的同一套写法；下文示例默认 `BASE=https://<your-platform-host>/api/v1`、`KEY=<your-api-key>`。

---

## 1. 常见踩坑清单（必读）

| # | 坑 | 后果 | 正确做法 |
|---|-----|------|---------|
| 1 | 持久化 `sectionId` 后再用它读 section | 文档一更新 sectionId 全变，404 | sectionId 不稳定、禁止持久化；一律按 `position`（当前 outline 快照，写后可能漂移，写回前重拉）或 `headingPath` 定位 |
| 2 | Agent 用 web 默认 `GET /docs/:id/content` 全文通道构造 oldString | 匹配面字节不一致、零命中 | `read_doc` 优先：小文档全文与 `full=true` 匹配面逐字节同形；section 三通道返回的 `markdown` 是全文字节级子串，均可直接作 `patch_doc` oldString |
| 3 | 对 `git:*` source 的文档调 upsert/delete | 409 `DOC_SOURCE_MISMATCH` | 非 native 文档平台只读；要改内容去改仓库源文件再走 ingest 同步 |
| 4 | MCP `upsert_doc` 想传 `source` | 工具不暴露该参数 | MCP 写固定 `native`；只有 ingest 适配器可设非 native source |
| 5 | `GET /doc-spaces/:id/docs` 同时传 `path=` 和 `q=` | 400 | 二者互斥：`path=` 精确匹配（定位用）、`q=` 模糊搜索 |
| 6 | 创建空间同时传 `topicId` 和 `boardId` | 403/400 | 二选一（或全空 = 独立空间） |
| 7 | 列表/搜索期望跨空间全量 | 只返回有权限空间 | 权限自治：read = open \| creator \| member；私密空间无权限 read → 404 |
| 8 | `spaceName` 传空间 slug | 0 候选 `isError` | 三层匹配匹配的是**空间显示名**（如 `<your-docspace-name>`，替换为你的空间显示名，见项目 AGENTS.md）不是 slug——6 个 docs MCP 工具皆然 |
| 9 | 写文档前不查空间词表，凭记忆造 tag/docType | 落库值与空间既有取值分叉（`OpenViking` vs `openviking`），facets 出现同义分裂；即便被 alias 归一纠偏也已产生一次多余写入 | **空间声明词表时先 `get_doc_facets` 读词表**（见 §3.7）——复用既有 canonical 值，归一只是兜底纠偏不是主路径 |
| 10 | 把「响应里没有 `hints` 键」当成「一切正常」 | 族没开 / 6h 去重窗口压制 / 本次无触发都会让键不出现——它不是健康信号 | 需要确认状态就用 `get_doc_facets` 看空间实际取值与开关现状；`hints` 是**稀疏建议**不是体检报告（见 §3.8） |

---

## 2. 三级消费模型（核心工作流）

> 省 token 的物理基础：入库按 Markdown 标题切 section，检索与读取粒度到段。**永远不要默认拉全文。**
>
> **起步标准动作（替代本地 INDEX.md 的角色）**：进入一个项目/空间，第一步总是 `get_docs_overview`——一次调用拿到全空间「分类 → 文档 → 摘要」紧凑地图，建立全量索引印象，之后按需 search/read。若 overview 因 token 预算截断（`truncated:true`），改用 `GET /doc-spaces/:id/docs` 分页枚举全量目录。
>
> **截断时会收到分页教学（`docs_overview_truncated`）**：当文档条目被 `maxTokens` 截断**且你没显式传 `maxTokens`** 时，同响应会附一条 `hints[]`，`data = {section:'docs', returnedCount, totalCount, suggestedTool:'get_docs_overview', suggestedParams:{catalog:true}}`。**最便宜下一步** = 按 `suggestedParams` 重调（`catalog=true` 豁免截断、一次拿全目录）；或 `slim=true` 更瘦；或改走 `list_docs` 分页。这是**教一次分页姿势**（同一空间 24h 只提一次，已够用可忽略），不是每次截断都唠叨——**你自己显式传了 `maxTokens` 就不会收到它**（那时预算由你管）。

```
① 建立全貌          ② 定位段落            ③ 精读单段
get_docs_overview → search_docs        → read_doc(position)
紧凑地图             top-k section 片段     单 section 正文
(token 硬上限)       (snippet ≤300 字符)    (按 position 稳定定位)
```

### 2.1 overview — 空间全貌

```bash
# MCP（推荐）
get_docs_overview { "spaceName": "<your-docspace-name>" }

# REST
GET /doc-spaces/:id/overview
```

返回 `categories → docs[{path,title,summary,docType,tags,tokenEstimate}]` + `uncategorized`。整体 token 估算超 ~4000 时按 `sortOrder` 截断并置 `truncated:true`。`routes` 段防爆：内嵌意图路由截断到策展序前 50 条 + `routesTruncated`/`routesTotal` 标记规模（全量清单走 `list_doc_routes` 或 `GET /doc-spaces/:id/routes` 分页）；`includeRoutes=false` 整体省略 routes 段。

### 2.2 search — 双路检索定位

```bash
search_docs { "spaceName": "...", "q": "权限模型", "limit": 5 }
# REST: GET /doc-spaces/:id/search?q=...&type=&tag=&category=&limit=
```

- **双路打分**：q 先经编译器（CJK 逐字 bigram ts 腿 + trgm 兜底腿 **OR 融合**，英文/标识符走 ts 词位腿），合成分 = `ts_rank_cd × 3.0` + `similarity(headingPath) × 0.5` + `similarity(content) × 0.6`，下限 `0.08` 过滤零相关噪音（弱命中线 `0.9`）。单 CJK 字查询走单字路径（常数分 `0.1`——可搜但低分、按节位而非相关度排序）。
- **响应是 `{hits, hint?, hintCode?}` 信封**（hint 三态 + 机器判别码 `hintCode`）：**按 `hintCode` 分支，勿匹配文案**——
  - `zero_hit`（零命中）：换更贴近文档原词的 2–4 字术语 / 缩短查询 / 改走 `list_doc_routes` 策展意图 / 锚定英文标识符；**别用同义改写重试**（同概念异措辞是当前检索引擎的已知边界）。
  - `weak_hit`（**有结果**，只是最高分低于活弱命中线，现构 `0.9`）：**先用手上结果**——它们可能正是答案；仅当明显不相关才换词，**别因这条提示弃页**（相关度提示，不是失败）。
  - `positional_order`（单 CJK 字 / 高频降级，未按相关度排序）：换**更长**的查询（方向与 `zero_hit` 相反）。
  - 无 `hint` 时 `hintCode` **不出现**（不是 `null`）。
- 返回 `hits`：`{docId, docPath, docTitle, headingPath, position, snippet, score}`。**记下 `docId` + `position`** 供下一步精读。
- 翻页与时间窗：`offset`（跳过 N 条，配合 `limit` 穷尽翻页，上限 100000）+ `sort`（`relevance` 缺省｜`createdAt_desc`｜`createdAt_asc`，时间序接管 ORDER BY、跳过 boost 融合、不透出 boosts）+ `createdAfter`/`createdBefore`（ISO 8601，含边界）——「读最近 N 天日记」：`sort="createdAt_desc"&createdAfter=<now-7天>&limit=20`。

### 2.3 read — 大纲 / 精读

```bash
# 读大纲（无定位参数）——小文档一次拿全文
read_doc { "docId": "..." }                      # 或 { "spaceName": "...", "path": "docs/architecture.md" }
# → 小文档（tokenEstimate ≤ 2000，可 maxFullTokens 覆盖，0=强制 outline）：元数据 + sections + mode:'full' + content 全文
# → 大文档：元数据 + sections[{position,headingPath,headingLevel,tokenEstimate,sectionHash}]，mode:'outline'，不含正文

# 大文档按 section 精读（三级消费的第三级，带 position，推荐）
read_doc { "docId": "...", "position": 7 }
# → { docId, docPath, position, headingPath, headingLevel, content, markdown, tokenEstimate }
#   markdown 是 full=true 全文的字节级子串，可直接作为 patch_doc match 模式 oldString

# 也可按 headingPath（重复时返候选 position，绝不静默挑选）
read_doc { "docId": "...", "headingPath": "3. 模块划分 § 3.2 模块详细定义" }

# 批量读：一次读多节（positions 互斥单节定位，去重，越界进 missing 不整体报错）
read_doc { "docId": "...", "positions": [1, 3, 5] }
# → { docId, docPath, sections[{position, headingPath, headingLevel, markdown, sectionHash}], missing[] }
#   每项含 sectionHash（内容指纹，sha256 派生自存储三元组 headingPath/headingLevel/content，不落库）
#   ⚠️ 取 sectionHash 走 positions[] 或 outline（每节同口径携带，可混用）——单节通道（position/headingPath/headingQuery）返纯 markdown 无法携带 hash；
#      该 hash 是 patch_doc section 模式 expectedSectionHash 的取数源（改前先 positions:[n] 取 hash 一并传入，防漂移防覆盖）
#   ⚠️ position 不保证跨更新稳定——任何写操作（patch/match）都会 re-chunk 致 position 漂移，写回前重拉 outline

# 模糊定位：headingPath 子串匹配——唯一命中返节，多命中 isError+candidates，零命中 404
read_doc { "docId": "...", "headingQuery": "模块划分" }
```

> 定位二选一：`(spaceName + path)` 精确路径 或 裸 `docId`。`position` 优先于 `headingPath`。
> **BYTE-IDENTITY GUARANTEE**：小文档 `mode:'full'` 的 `content` 与 `GET /docs/:id/content?full=true` 匹配面逐字节同形（首 H1 保留）；`position`/`headingPath`、`positions[]`、`headingQuery` 三条 section 通道优先取后端 `markdown`，该字段是 full=true 全文的字节级子串（标题行插回、run-dedup 兄弟续 chunk 不插标题行、空正文节只插标题行）。复制 read_doc 全文或任一 section `markdown` 均可直接作为 `patch_doc` match 模式 `oldString`。

### 2.4 消费模式选择（决策树）

> 先问自己「我要的是**点查**还是**全集**」——选错模式是 DocSpace 消费侧最常见的浪费：用 top-k 追全集（永远追不齐），或用全量 export 回答一个点查（拉几 MB 只为一句话）。

| 我要… | 用什么 | 关键约束 |
|------|-------|---------|
| **点查**：某概念在哪篇 / 哪节 | `search_docs`（§2.2） | **top-k 非穷尽，绝不能当全集**；hint 按 `hintCode` 分叉 |
| **关键词穷尽命中**：这个词到底出现在哪些文档 | `GET /doc-spaces/:id/export` 全量 → **本地匹配** | 服务端检索是排序面不是枚举面，全集只能自己算 |
| **模式 / regex 扫描**：错误码、URL 形态、TODO 标记… | `GET /doc-spaces/:id/export` 全量 → **本地 grep / regex** | **服务端无 regex 通道**（检索走 tsquery + trgm 相关度，不是行级模式匹配）——别把正则塞进 `q=` |
| **机审喂料**：批量喂审查 / 统计 | `GET /doc-spaces/:id/export?pathPrefix=…` + `list_docs { updatedAfter, sort:"updatedAt_desc" }` | 三盲区 + 水位写法见下 |
| **基准对照**：top-k 到底漏没漏 | export 全量作 **ground truth**，拿它质疑 top-k 召回 | 先有全集，才谈得上评测 |
| **单篇全文** | `read_doc`（小文档直接 full；大文档走 `GET /docs/:id/content?full=true`） | 匹配面与 `full=true` 逐字节同形，可直接作 `patch_doc` oldString |
| **互链悬空** | link-health（已有基建，勿自建爬链） | — |
| **最近变更** | `list_docs { updatedAfter, sort }` | **必须显式传 `sort="updatedAt_desc"`**（缺省是 path 序） |
| **空间 / 目录规模** | `get_docs_overview` / `list_doc_tree` / `get_doc_facets` | 规模面走聚合，别拉全量再数 |
| **空间词表 / 体检**：这空间推荐哪些 docType/tag | `get_doc_facets`（§3.7） | 一词调用拿声明词表 + 实际分布 + 逐项词表状态；**写文档前先查** |

**机审喂料的三盲区（`updatedAfter` 增量维护）**：

1. **只筛元数据**：`updated_at` 变化 ≠ 内容变化（元数据 patch / move 也 bump），且**不存在内容级增量**；
2. **删除不可见**：软删文档被列表过滤且**不 bump** 时间列 ⇒ 镜像必须周期全量对账，或消费 `doc_deleted` 事件；
3. **两个时钟源写同一列**：`save()` 走应用时钟（`new Date()`），元数据 patch / move 走 DB 时钟（`NOW()`）——水位写法 = `max(updatedAt) − 重叠窗口` 回看（**默认 ≥5 分钟，或你方最长写事务时长**）+ 按 `contentHash` 去重。

⚠️ **部分快照警告**：带 `pathPrefix` 的 bundle **不是备份**——前缀外文档被丢弃，保留下来的路由可能携带指向包外的 `secondaryDocPath`（**同空间**回导该链路完好；导入**新空间**则该路由 per-item failed，响亮不静默）。`pathPrefix` 是**字面、大小写敏感**前缀（目录语义**带尾 `/`**）；零命中返回 200 空 bundle，读 `appliedFilters.matchedDocs === 0` 区分「前缀没命中」与「空间本来就空」。要给新空间播种请**不带 `pathPrefix`** 全量导出。

### 2.5 大空间导航分层（标准范例）

> 全量目录 ≠ 入口视图。空间超过百篇后，「catalog 被数百篇设定/日记淹没」是各项目通病——解法不是新端点，是**把现有零件分层用对**（六个生产空间实测收敛）。

**分层职责（每层只干自己的事）**：

| 层 | 干什么 | 不干什么 |
|---|-------|---------|
| 空间图例（description） | 目录职责说明 + 路由分工指路 | 不抄文档清单（机器地图在 overview，永不过时） |
| doc_routes | 只挂**主要意图与模块入口** | 不逐篇挂叶子文档；不挂 memory/archive 路径 |
| Index / reading-guide 文档 | 大目录的人工承接（「什么信息去哪找」） | 写导航不写正文，不复制全量清单 |
| `list_doc_tree` | 大目录逐层下钻 | 不递归全拉 |
| `search_docs` / `read_doc` | 叶子定位与精读 | — |

**场景化配方**（检索前先想能否用 type/tag/category 收窄语料——先收窄再检索，比改措辞有效）：

| 场景 | 调用 |
|------|------|
| 冷启动 bootstrap | `get_docs_overview`（默认含图例 + 内嵌 routes）；大空间先 `catalog=true` 拿目录完整性 |
| 只要核心入口（大空间防爆） | `get_docs_overview { type: "guide,index", slim: true, includeRoutes: false }`——实测 218 篇空间收敛到 15 篇核心 |
| 大目录钻取 | `list_doc_tree` 根层看 `folders[].docCount` → 目标层 `list_docs` 拉全 → `read_doc` 精读 |
| 日记/过程档案时间窗 | `search_docs { q, type: "memory", sort: "createdAt_desc", createdAfter }`（先按 type 收窄再排时间） |
| 全量盘点 / 机审 | `GET /doc-spaces/:id/export`（§2.4 决策树） |
| 空间体检（type/tag/category 分布 + 词表状态） | `get_doc_facets`（MCP，见 §3.7） |

**两条契约化保证（消费方可依赖）**：

1. **filtered 子集 ≠ 全集**：任何带过滤的响应都以 `appliedFilters` 回显实际生效的过滤，`truncated`/`docsTotal` 标记规模——把过滤视图当全集是消费方 bug，不是平台截断。
2. **被过滤的叶子永远可达**：overview 过滤与空间默认过滤只影响**展示面**，不影响**检索面**——被隐藏的文档仍可经 `search_docs` / `list_docs` / `read_doc` 直达（例：默认过滤 memory 的空间，`search_docs { type: "memory" }` 照常命中当天日记）。

---

## 3. 文档写操作（upsert / patch / append / delete）

### 3.1 upsert — 创建或更新

```bash
upsert_doc {
  "spaceName": "...", "path": "notes/design.md", "content": "# 设计\n\n...",
  "title": "设计笔记", "docType": "note", "category": "design", "tags": ["wip"]
}
# REST: PUT /doc-spaces/:id/docs
```

- 按 `(spaceId, path)` upsert；`category` 按名解析、不存在自动创建。
- 内容未变（contentHash 匹配）→ `{ unchanged: true }`，不重建 section、不发事件。
- **可选 `expectedContentHash`**（乐观锁）：doc 不存在或 hash 与当前不符 → 409 `DOC_CONTENT_CONFLICT`（`data.currentContentHash` 供重读）；相符且内容未变 → 正常 `unchanged:true` 返回（不算冲突）；batch 导入（`PUT /doc-spaces/:id/docs/batch`）不支持该字段。
- **`clientRequestId` 幂等键**（1~64 字符）：transport error 后**同 key 重试**返首次响应快照 + `idempotentReplay:true`，零副作用；同 key 不同 payload → 409 `IDEMPOTENCY_KEY_CONFLICT`；写调用建议恒带。
- 返回 `{ id, path, sectionCount, tokenEstimate, contentHash, unchanged? }`。
- 创建发 `doc_created`、更新发 `doc_updated`（可经 `events/poll` 感知）。
- 需要空间 **write 权限**（creator 或 editor）。

### 3.1a 元数据提炼规范（写文档时遵守）

> 平台不做 LLM 提炼——**调用者你就是 LLM**，写入时自己把元数据策展好。本规范的压缩版已嵌入 `upsert_doc` 工具与 batch 导入端点（`PUT /doc-spaces/:id/docs/batch`）的参数描述（接口自带 prompt），本节是权威完整版。

| 字段 | 规范 |
|------|------|
| `summary` | 1–2 句 ≤500 字符；读者是「决定要不要读这篇的检索 Agent」；回答**这是什么 + 什么场景该读它**；**关键标识符原文必须出现**（工具名/端点名/英文术语——标识符/英文术语是最强检索锚点）；中文短语经 CJK 单字化 ts 检索可命中；不复述标题、不写"本文档介绍了" |
| `docType` | 受控词表优先：`guide` / `reference` / `api` / `architecture` / `operations` / `index` / `note`；**空间若声明了 `settings.docTypes`，以空间词表为准**（`get_doc_facets` 读，见 §3.7）；别造新词 |
| `category` | 先 `get_docs_overview` 看现有分类再归位；不造近义分类；确无合适才新建 |
| `tags` | 3–5 个；标识符/技术术语优先（检索锚点）；**空间声明 `settings.canonicalTags` 时先 `get_doc_facets` 复用既有 canonical 值**——写侧会按 alias 归一，但归一只是兜底纠偏（见 §3.7） |

仓库镜像文档（`git:*` source）经 `scripts/sync-docs.mjs` 的 frontmatter `summary` 字段走同一规范。

### 3.1b 跨文档引用约定（写文档时遵守）

**文档正文里引用另一篇文档，一律用**空间根绝对 path**写标准 Markdown 链接**：`[系统架构](/docs/architecture.md)`。

- **为什么用 path**：Agent 可读可写（看到 path 直接 `read_doc(spaceName+path)` 一跳直达）；git 仓库渲染原生可跳转；web 前端点击时由链接渲染器实时解析 path → docId 做 SPA 跳转（归一化规则与 linkHealth 同款：剥 `#` 锚点、去 `./` `../`、补 `docs/` 前缀兜底）；断链会被 linkHealth 巡检报警。
- **为什么要空间根绝对形式（`/docs/x.md`）**：linkHealth 按**源目录严格 POSIX 解析**——文档自身就在 `docs/` 目录内时，写相对形 `docs/x.md` 会被解析成 `docs/docs/x.md` 而判 broken；写 `/docs/x.md` 则稳定命中。写 `x.md` 裸名虽有"补 docs/ 前缀兜底"，但跨目录文档（如 memory/ 引 docs/）不适用——一律 `/docs/x.md` 最稳。
- **不要手写** `/docs/<spaceId>?doc=<docId>` 规范链接进正文——那是 web「复制链接」的产物，供消息/评论/书签等无巡检兜底的分享场景用；docId 对 Agent 不可读、需额外查询才能写出。
- 标准 `[text](href)` 语法才会进入 linkHealth 体检；反引号行内代码（`` `path` ``）不算链接、不被检查也不可点击。
- 改某篇文档的 path 前，先全仓检索谁引用了旧 path 一并修改；漏改的会在下次同步后出现在该文档右栏断链警告里。

### 3.2 source 写权隔离（重要）

| source | 含义 | 可写？ |
|--------|------|--------|
| `native`（默认） | API/MCP 生产的文档 | ✅ 可写可删 |
| `git:*`（如 `git:<your-repo-slug>`） | ingest 适配器同步的仓库镜像 | ❌ 平台只读，写/删 → 409 `DOC_SOURCE_MISMATCH` |

- `upsert_doc` 与 `DELETE /docs/:id` 均只作用于 `native`，**不暴露 source 参数**。
- 要修改 `git:*` 文档：改仓库源文件 → 跑 ingest 同步（§5），ingest 只覆盖同 source 文档、绝不误删 native。

### 3.3 delete（REST）

```bash
# ① path 定位：先取 docId（path 精确匹配）
DOC_ID=$(curl -s -H "X-API-Key: $KEY" \
  "$BASE/doc-spaces/$SPACE_ID/docs?path=notes%2Fobsolete.md&pageSize=1" | jq -r '.data.items[0].id')

# ② 软删除（已知 docId 时一步到位）
curl -s -X DELETE "$BASE/docs/$DOC_ID" -H "X-API-Key: $KEY" | jq
```

软删除，发 `doc_deleted`（删除同样只作用于 `native`，非 native → 409 `DOC_SOURCE_MISMATCH`）。删文档不伤任务（关联行保留、join 过滤隐藏）。

### 3.4 批量导入（REST）

```bash
cat > /tmp/docs-batch.json <<'JSON'
{
  "docs": [
    { "path": "notes/a.md", "content": "# A\n\n...", "summary": "策展摘要" },
    { "path": "notes/b.md", "content": "# B\n\n..." }
  ]
}
JSON

curl -s -X PUT "$BASE/doc-spaces/$SPACE_ID/docs/batch" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d @/tmp/docs-batch.json | jq
```

- 单次 **1–50 篇**；总量建议 ≤4MB，超出拆多次调用。
- 每篇独立事务，单篇失败**不中断**整批；返回 per-doc `status`（`created`/`updated`/`unchanged`/`failed`）+ 四态计数，失败项带结构化 error。
- **每项可带各自 `clientRequestId`**：transport error 后带同批 key 重试，已成功项返首次结果不重写。
- source 固定 `native`（不暴露 source 参数）；与 web 端「批量上传」共用同一后端端点。

### 3.5 section 级写（patch_doc，双模式）

```bash
# section 模式：按 position 整节替换（推荐带 expectedSectionHash 防漂移防覆盖）
patch_doc { "spaceName": "...", "path": "docs/api-definition.md", "position": 7, "content": "## 新标题\n\n新正文...", "expectedSectionHash": "..." }
# REST: PATCH /docs/:id/sections/:position    body: { "content": "...", "expectedSectionHash?": "..." }

# match 模式：按原文片段搜索即替换，免疫 position 漂移——小改 / 片段删除首选
patch_doc { "spaceName": "...", "path": "docs/api-definition.md", "oldString": "...原文片段...", "newString": "...替换为..." }
# REST: PATCH /docs/:id/content    body: { "oldString": "...", "newString": "..." }
```

- **required 仅 `spaceName` + `path`**；双模式**互斥**，同传 → 400 `VALIDATION_ERROR`。
- section 模式：`content` **必须含标题行**（与 read_doc section 模式同形），后端整节替换后重跑 chunk/重建管线（outline/position/contentHash/tokenEstimate/linkHealth 全量重建）；空串 `content` = 删除该节；position 越界 → 404 `DOC_NOT_FOUND`；非 native 文档须带匹配 `?source=`（否则 409 `DOC_SOURCE_MISMATCH`）。
- **`expectedSectionHash`（可选）**：目标节当前 `sectionHash`（取数 = `read_doc positions:[n]` 或 outline `sections[].sectionHash`，两通道同口径可混用）不符 → **409 `DOC_CONTENT_CONFLICT`**（data.sectionCount 提示重拉 outline）——position 失效/并发改动不再静默写错块。
- match 模式：**BYTE-IDENTITY GUARANTEE**——read_doc 小文档 full 模式 `content` 与 `GET /docs/:id/content?full=true` 匹配面逐字节同形；read_doc 的三条 section 通道均优先返回后端 `markdown`，每节 `markdown` 是 full=true 全文的字节级子串。read_doc 全文或任一 section `markdown` 均可直接复制作为 `oldString`，无需手工重建标题/换行。命中语义：**0 → 404 `DOC_NOT_FOUND`**（提示先读）、**>1 → 409 `RESOURCE_CONFLICT`** + `data.matchCount`（扩大上下文）、**恰 1 → 替换并重跑 chunk 管线**；`newString` 空串 = 删除该片段。
- 返回 upsert 同款 `{id, path, sectionCount, tokenEstimate, contentHash, unchanged?}`。
- **并发防护（TOCTOU 加固）**：patch 内部携带读取时 `contentHash` 作乐观锁，读写间被并发改动 → 409 `DOC_CONTENT_CONFLICT`（不再静默 last-writer-wins）。
- **双模式均支持 `clientRequestId` 幂等键**（语义同 upsert_doc）：transport error 后同 key 重试返首次快照。
- ⚠️ position 不保证跨写稳定：任何 patch/match 都可能 re-chunk 致 position 漂移——**写前先 read_doc 重拉 outline / positions 拿最新 position 与 sectionHash**，禁止复用缓存的 position；撞 409 后重拉重试即可。同文档多处改 → 合并成一次 `upsert_doc` 全量替换更稳。
- 定位用 position（outline `sections[].position` 或 `positions[]`），**不收 sectionId**（不稳定）。

### 3.5b 追加写（append_doc）

> 日记/日志类「文末加一节」首选，一步替代 read→拼 oldString→patch match 三步。

```bash
append_doc { "spaceName": "...", "path": "memory/2026-10-09.md", "content": "## 新一节\n\n..." }
# REST: POST /docs/:id/append    body: { "content": "...", "position?": "end" | "under-heading", "headingPath?": "..." }
```

- `position=end`（默认，文档末尾）｜ `under-heading`+`headingPath`（目标节子树末尾；0 命中 404 附可用列表 / 多命中 409 附候选，绝不静默挑选）；
- **并发免疫**——读写窗口被并发改动时服务端内部重试（最多 3 次），并发 append 互不丢更新，日记/日志场景优先于 patch match（match 并发互相 409 且无法自动重试）；
- `clientRequestId` 幂等（同 key 重放不重复追加）；返回 upsert 同款含 `contentHash`。

### 3.6 盘点与空间级快照

```bash
# 以下仍可用 MCP 语义工具（未被降级）
list_docs { "spaceName": "...", "pathPrefix": "memory/", "slim": true }   # 平铺清单（分页拉全）
list_docs { "spaceName": "...", "updatedAfter": "2026-09-30T00:00:00.000Z",
            "sort": "updatedAt_desc" }                                     # 最近变更（sort 必须显式传）
list_doc_tree { "spaceName": "...", "prefix": "memory/" }                 # 分层目录（逐层下钻）
list_doc_routes { "spaceName": "...", "q": "架构" }                        # 意图路由清单（不传分页=全量数组）

# 空间快照 / 回导：REST（语义工具已降级到 /mcp-full）
curl -s -H "X-API-Key: $KEY" "$BASE/doc-spaces/$SPACE_ID/export" -o /tmp/space.json   # 全量 bundle
curl -s -H "X-API-Key: $KEY" "$BASE/doc-spaces/$SPACE_ID/export?pathPrefix=memory/" \
  -o /tmp/space-memory.json                                                            # 部分快照（**不是备份**）
curl -s -X POST "$BASE/doc-spaces/$SPACE_ID/import-bundle" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d @/tmp/space.json | jq                                                             # 回导（吃 v1/v2；默认不动 space meta）
```

- `list_docs`：与 overview 分工——overview 是分类树地图，本工具是可翻页的平铺清单；`slim=true` 只回 `{path,title,updatedAt}`。支持 `updatedAfter`（ISO 8601，**只有下界**、含边界）与 `sort`（`updatedAt_desc` / `updatedAt_asc`；缺省仍是 **path ASC**，要"最近在前"必须显式传）。⚠️ 与搜索面的 `createdAt_*` 是**词表双轨不可互换**；增量的三盲区与水位写法见 §2.4。**白名单外的参数会被拒**（`failedStep:'validate_args'`），不再静默丢弃——参数没生效先核对拼写（如 `updatedAfter` vs `updated_at`）。
- `list_doc_tree`：**大空间目录发现**——一次调用只返「当前层」直接子目录（递归 `docCount`/`latestDocAt` 聚合）+ 直挂文档 slim 分页；用返回的 `folder.path` 作下一次 `prefix` 逐层下钻（目录不递归展开，免全量拉取）；`sort=recent`（缺省）\|`name`；`docsLimit` 缺省 50 上限 200 / `foldersLimit` 缺省 200 上限 500，folders/docs 独立分页，`total` 不受 limit/offset 影响。**采集空间钻取链路**：`list_doc_tree` 根层看 `folders[].docCount` 找大目录 → 用其 `path` 下钻 → 目标层 `list_docs` 拉全量 → `read_doc` 精读。
- `list_doc_routes`：不传 `page`/`pageSize` = 全量数组（上限 1000 条兜底）；传 = 分页信封。
- `GET /doc-spaces/:id/export`：空间元数据 + categories + routes（含 codeEntryType，文档以 path 引用）+ 每篇全文与策展元数据；**`formatVersion 2` 另含 `media[]`（doc 绑定附件的原始字节 + 缩略图，base64）与 informational `mediaOmitted[]`（正文引用但刻意未打包的 topic 绑定附件）**——媒体受**联合请求体预算**约束（`10MiB − docs 段实际字节 − 64KiB 余量`），未打包项同段落 `{skipped:'too_large'|'budget_exceeded', ...meta}`（可发现优于静默截断）；read 权限即可；快照可落 git 做版本对齐 diff / 离线灾备。支持 `pathPrefix` **部分快照**：收窄 docs / categories（只留入选文档引用的）/ routes（只按 **primary** 筛）/ media，并回声 `appliedFilters:{pathPrefix, matchedDocs}`（含零命中；200 空 bundle 不是错误）。⚠️ **不是备份**且路由的 `secondaryDocPath` 可能指向包外文档——详见 §2.4。
- `POST /doc-spaces/:id/import-bundle`：**六阶段有序回导**（categories 按名幂等 → media stage-1（字节证据校验 + 插入或复用）→ docs 每篇独立事务 + 正文附件 URL 按配对映射重写（**无映射不重写**）→ media stage-2 回绑 docId → routes 按 intent+primaryDocPath 幂等 → space meta 默认**跳过**，`overwriteSpaceMeta=true` 显式开启）；`formatVersion` 接受 **{1, 2}**（1 = 存量快照格式，整段跳过 media，结果信封 media 段全零值），其余值 400；**同 bundle 重复回导幂等**（附件行数/对象数不变、docs unchanged——复用键 + tie-break 保证收敛）；返回 per-item `created/updated/unchanged/failed` + `media:{created,reused,skipped,failed[]}` 计数；需 space write。bundle 顶层的 `appliedFilters` 为 informational，**回导显式忽略**（DTO 已声明，带该键可安全回导）。
- **媒体打包边界**（详见 [`../attachments/SKILL.md`](../attachments/SKILL.md) §3/§4）：只打包 **doc 绑定**附件；**topic 绑定附件不打包**（跨环境 topic id 不通用）——它们在 `mediaOmitted[]`（`reason:'topic_bound'`）里可见，回导后该处断链；**doc 导出显式排除非图片附件**（非图片 `mime_type` 恒 `application/octet-stream`，打包无意义）——同样进 `mediaOmitted[]`，`reason:'unsupported_media_type'`（显式报出，不静默丢）；导出侧 `media[].skipped` 项需另行取件。

### 3.7 空间词表（settings 三字段 + tag 归一）

> **空间可以声明自己的「推荐词表」**——三个键存 `doc_spaces.settings`，随空间走。词表是 **advisory 软校验**：它**不拒绝**词表外的值（照常写入），只在 `get_doc_facets` 里标 `undeclared`。目的不是设闸门，是**让 Agent 知道该复用哪些既有取值**。

**三键形状**（完整类型契约见线上 `docs/spec.md` §4.1a「空间词表类型」）：

```jsonc
settings: {
  "docTypes": ["guide", "reference", "memory"],                                            // ≤50 项、每项 ≤64；ci 去重
  "canonicalTags": [{ "value": "openviking", "aliases": ["OpenViking", "open-viking"] }],  // ≤200 项；value ≤50、aliases ≤20×50（**aliases 可选**，缺省等价空表）
  "pathTypes": [{ "pathPrefix": "memory/", "docType": "memory" }]                          // ≤50 项；纯声明（hint 族消费见 §3.8）
}
```

**读词表（唯一正确姿势）**：

```bash
get_doc_facets { "spaceName": "..." }     # 声明词表 + 实际分布 + 逐项词表状态（一词调用）
# → { types: [{value, count, vocabStatus}], tags: [{value, count, vocabStatus, canonicalValue?}],
#     categories: [...], vocabulary: { docTypes, canonicalTags, pathTypes } }
# spaceId 直传可跳过空间名解析（候选歧义时更稳）
```

- `vocabStatus` **仅在该族词表已声明时出现**——**「字段省略」≠「undeclared」**：前者 = 该族**没配词表**，后者 = 配了但该值在词表外；
- tags 的 `canonical` = stored 值**精确等于**声明 `value`；`alias` = 大小写变体或 alias 形态（带 `canonicalValue` 指向声明值——**存量同义分裂的识别信号**，rename/merge 治理的输入）；
- **写文档前先查**：空间声明词表 → 复用既有 canonical 值 / 推荐 docType；未声明 → 按 §3.1a 通用规范即可（零行为变化）。

**写侧 tag 归一（兜底纠偏，不是主路径）**：空间声明 `canonicalTags` 时，`upsert_doc` / `patch_doc_metadata`（含 batch 导入 `PUT /doc-spaces/:id/docs/batch` 与回导 `POST /doc-spaces/:id/import-bundle` 通道）会把命中 alias 的 tag **归一为 canonical 声明形态**：

1. 逐 tag `trim` + 大小写不敏感匹配（先 canonical 值，再各条目 `aliases`）；
2. 命中 → 写 canonical 形态；未命中 → **原样落库**（不 trim 不改动，**重复项也保留**）；**仅对命中的归一值**去重（`["NPC","npc"]` → `["npc"]`；未命中的 `["foo","foo"]` → 原样两条）；
3. 响应带 `tagNormalizations: [{from, to}]`（**仅实际发生归一时出现**）——看到它说明你的输入被纠偏了，下次直接写 canonical 值。

⚠️ **两个边界**：

- **纯标签调整走 `patch_doc_metadata`**：`upsert_doc` 内容 hash 未变时走 `unchanged` 早退，**tags 不落库也不归一**（tags 属「内容键」语义）——只想改标签别用 upsert；**唯一例外 = `forceRechunk: true`**（同内容也强制重建 sections，请求不进早退，tags 照常落库并归一）；
- **归一不影响幂等指纹**：`clientRequestId` 重放返回首次快照（含原样 `tagNormalizations`），指纹按调用方原始输入算。

**配置词表（维护者视角）**：`PATCH /doc-spaces/:id` 写三词表键（`docTypes` / `canonicalTags` / `pathTypes`；第四键 `hintToggles` 见 §3.8），权限同其他内容字段（write 即可，非 creator-only）。**语义工具 `update_doc_space_vocabulary` 已降级到 `/mcp-full`，worker 面用 REST**：

```bash
# 写：PATCH 回执是 doc_spaces 实体，词表键在 data.settings（没有 vocabulary 投影）
curl -s -X PATCH "$BASE/doc-spaces/$SPACE_ID" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"canonicalTags":[{"value":"openviking","aliases":["OpenViking"]}]}' \
  | jq '.data.settings | {docTypes,canonicalTags,pathTypes,hintToggles}'
# 单键更新不影响另两键；显式 null = 删键；不传 = 保留旧值（merge 语义同 overviewFilter）
# 业务校验失败 → 422 DOC_SPACE_VOCABULARY_INVALID（data.conflicts 带冲突对，422 时零写入）

# 权威读回：facets 是词表读面（返回 vocabulary + 实际分布 + 逐项词表状态）
curl -s -H "X-API-Key: $KEY" "$BASE/doc-spaces/$SPACE_ID/docs/facets" | jq '.data.vocabulary'
```

```jsonc
// ⚠️ 四键在 body **顶层**：别把 get_doc_facets 回的 `vocabulary` 整段塞回来（嵌套一层 → 400 空 body）
// 三态同上（值 / null / 省略）；**整键替换不是深合并**——写前先 get_doc_facets 读现状并合并
// 注：`/mcp-full` 工具的 { spaceId, name, vocabulary, appliedKeys } 回执是**工具层投影**，
// 不是 PATCH 响应形状；REST 直调的校验请以 facets 的 data.vocabulary 为准。
```

- 校验规则：canonical 值 ci 唯一；alias 不得与其他 canonical 或其他条目 alias 冲突（同条目内 alias == 自身 canonical **不算错**）；`docTypes` ci 去重；`pathTypes` pathPrefix 精确唯一；**不校验** `docType ∈ docTypes`（避免字段更新顺序耦合——词表是 advisory 不是闸门）；**声明侧落库前一律 trim**（docTypes 项 / value / aliases / pathPrefix / docType），trim 后为空 → 422（`kind:'empty_value'`）；`aliases` **可选**（缺省等价空表）；
- **暂无 web 词表编辑 UI**（API-only）；**词表读面以 `GET /doc-spaces/:id/docs/facets` 的 `data.vocabulary` 为准**（MCP 为 `get_doc_facets`）；PATCH 回执可读 `data.settings` 原始键（空间详情 `GET /doc-spaces/:id` 同样透传 `settings`），但语义以 facets 为准；`/mcp-full` 的 `update_doc_space_vocabulary` 回执是工具层投影。

### 3.8 hints 信封与 hint 族开关

> **写读两侧的统一「提示信封」**：响应里多出一个可选的 `hints` 数组，告诉你「刚写的这条有什么可改进」「这次搜索为什么空」。**默认全关**（逐族 opt-in）——不开的空间零 hints 零额外开销。

**信封形状**（`upsert_doc` / `patch_doc_metadata` / 批量导入（`PUT /doc-spaces/:id/docs/batch`）逐条 / `move_doc` / 删除（`DELETE /docs/:id`）/ 路由写 / 建分类 / `search_docs` 均可能携带）：

```jsonc
hints: [
  { "code": "empty_tags", "status": "suggestion", "message": "…可执行指引…", "data": { /* 结构化值 */ } }
]
```

**四条消费纪律（照做即可，不必读实现）**：

1. **按 `code` 分支，不要解析 `message`**——message 是给人/Agent 读的文案，会微调；code 是稳定机器 id。
2. **`status` 决定动作**：`suggestion`（写入已提交，这是事后建议）｜`normalized`（你的输入已被空间词表归一，不是建议是通知）｜`check_skipped`（**检查没执行**——**绝不解释为「健康」**）｜`check_failed`（检查执行了且发现问题）。
3. **`data` 才是结构化值**（候选列表 / 期望值 / 路由 id），需要机器处理就读它。
4. **`hints` 键可能不出现**（禁 null 禁空数组）：不开族、无触发、或去重窗口内已提示过——**「键不出现」≠「一切正常」**，别把它当健康信号（窗口缺省 6h，部分码另有长度：`search_experiences_suggested` 6h、`docs_overview_truncated` 24h；`normalized` 与旧三态双写不占窗口）。

**17 个 code 一览**（按族；另有**平台级 code** 由拦截器运行期附挂在写响应上——不经本空间词表，见下方「平台级 code」）：

| 族 | code | status | 含义 / 你该做什么 |
|---|------|--------|------------------|
| metadata | `missing_category` / `empty_tags` / `empty_summary` | suggestion | 落库后分类/标签/摘要为空；补上（tag 先 `get_doc_facets` 复用既有值） |
| tags | `tag_near_dup` | suggestion | 你的 tag 不在词表内且与空间既有 tag 高度相似（`data.candidates`）——**只是候选，平台不会自动改写**，建议改用候选值 |
| categories | `category_near_dup` | suggestion | 新建的分类与既有分类近义（`data.candidates[{name,slug}]`）——建议复用既有分类，避免近义分裂 |
| pathType | `path_type_mismatch` | check_failed | path 命中空间声明的 `pathTypes` 前缀但 `docType` 与声明不一致（`data.{pathPrefix,expected,actual}`）——改 docType 或改空间声明 |
| routes | `route_target_excluded` | suggestion | 该路由的主文档被空间默认 `overviewFilter` 排除（overview 地图里看不到它）——确认是否要调整排除项 |
| routes | `route_anchor_recheck` | suggestion | move 后：有路由指向本文档（`data.routeIds`）——**move 只改 path 不改标题锚，docId 引用连续，锚不会断**，仅供知悉核对 |
| routes | `route_anchor_broken` | check_failed | 有路由的 `headingPath` 锚在本次写入后不再命中（upsert 改标题）或 docId 目标消失（delete）——用 `update_doc_route` 更新锚点 |
| — | `tags_normalized` | normalized | 部分 tag 已按词表归一（`data.mappings`）——下次直接写 canonical 值 |
| read | `query_looks_like_path` | suggestion | 查询形似本空间文档路径（`data.{path,docId}`）——想直读就用 `read_doc(spaceName+path)` |
| read | `suggest_relaxing` | suggestion | 零命中且本次带了筛选（`data.removableParams` 列出可去掉的参数）——**去掉筛选不保证有结果** |
| read | `search_experiences_suggested` | suggestion | **搜索零命中**时平台建议「先去经验库搜一轮」：`search_experiences`，`signals` 给症状 token（如 `econnrefused`）最准（`data.suggestedTool`）——**只讲该单目的地**；**不受 `read` 族开关约束**（与 `zero_hit` 同侧的引流豁免）；同一空间 6h 一次 |
| read | `docs_overview_truncated` | suggestion | **overview 文档条目被 `maxTokens` 截断**时的**分页教学**：`data.{section,returnedCount,totalCount,suggestedTool,suggestedParams}`——最便宜下一步 = 重调本端点带 `catalog=true`（豁免截断、拿全目录）或 `slim=true`（更瘦），或改走 `list_docs` 分页；**已够用可忽略**；同一空间 24h 一次 |
| read | `docs_overview_routes_truncated` | suggestion | **overview 意图路由被内嵌条数上限截断**（`routesTruncated=true`；**catalog 只豁免文档条目、不豁免 routes 段**）时的分页教学：`data.{section:'routes',returnedCount,totalCount,suggestedTool:'list_doc_routes',suggestedParams}`——下一步 = `list_doc_routes` 分页拉全量（可按 q/category 过滤），**再次 catalog 补不齐 routes**；已够用可忽略；与 docs 段截断码独立去重，同一空间 24h 一次 |
| read | `zero_hit` / `weak_hit` / `positional_order` | suggestion | 与 `hint`/`hintCode` 同一触发的双写形态，`message` 逐字一致 |

**平台级 code（运行期附挂，不经空间 `hintToggles`；清单与 TTL 见线上 `docs/api-definition.md` §2.7，机制见 `docs/modules/hint-system.md` §4.6）**：

- **`sensitive_credential_suspected`**（family `security`，surface `credential_scan`，6h）——**你刚写入的正文里疑似含真实凭证**。触发面 = doc 写路径（`upsert_doc` / batch 导入逐条 / `patch_doc` 两模式 / `append_doc`）+ task 描述与评论 + topic 消息；**只在真实写入成功后**扫（`unchanged` / 幂等重放 / 并发败者不扫），**只扫本次写入的新文本**（`patch_doc` match 模式扫 `newString`）：
  - `data = { resourceKind, resourceId, matchedPatterns: [label…] }`（结构化值读这里，**不解析 `message`**）；
  - **不是闸门**：写入已成功，这只是一条 advisory；
  - **真命中** ⇒ 立即**轮换**该凭证——**删除 ≠ 消除泄露**（doc 有版本历史、消息不可编辑）；平台自有 agent key（`ask_` 前缀）由人类管理员走 `POST /agents/:id/reset-key` 轮换；
  - **误报**（文档示例 / 占位 DSN / 官方示例 key / 长 slug）⇒ **忽略本提示即可**（文案自带该出口）；
  - ⚠️ **「没有 hint ≠ 没有密钥」**——该能力是 advisory 提示层，**不构成安全保证**（不覆盖的写口 / 二进制附件 / 拆写·编码·零宽符绕过 / 超长正文尾部见 `docs/modules/hint-system.md` §7）。

**族开关配置（空间维护者视角）**：

```bash
PATCH /doc-spaces/:id   { "hintToggles": { "tags": true, "pathType": true, "routes": true, "read": true } }
# 六族可选：metadata / tags / categories / pathType / routes / read；缺省/缺键 = 关
# 单键更新 = 整键替换；显式 null = 删键（回到全关）；未知族键或非 boolean → 422 DOC_SPACE_HINT_TOGGLES_INVALID
```

```bash
# 语义工具 update_doc_space_vocabulary 已降级到 /mcp-full；worker 面用 REST：
# ⚠️ 整键替换的杀伤面在这里最大：漏掉任何一族 = 该族被关。必须先读现状、合并六族、再写。
# ① 读现状：facets 的 data.vocabulary.hintToggles（MCP get_doc_facets 同源，工具仍在 worker 面）
curl -s -H "X-API-Key: $KEY" "$BASE/doc-spaces/$SPACE_ID/docs/facets" | jq '.data.vocabulary.hintToggles'

# ② 合并后整图写回（缺族即关）；PATCH 回执是实体，hintToggles 在 data.settings
curl -s -X PATCH "$BASE/doc-spaces/$SPACE_ID" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"hintToggles":{"tags":true,"pathType":true,"routes":true,"read":true,"categories":true,"metadata":false}}' \
  | jq '.data.settings.hintToggles'

# ③ 权威读回：重复 ① 的 facets 请求（词表语义以 facets 为准）
```

**开族配方（实测建议，先高确定性后噪音面）**：

- **先开五族**：`tags` / `pathType` / `routes` / `read` / `categories`——触发条件确定（词表外近义、路径声明不符、锚断、路径形态、近义分类），误报面小；
- **`metadata` 缓开观察**：它按「落库后分类/标签/摘要为空」触发，**日记主导的空间里写日记无 category 是常态**——该族在这类空间会变成 6h 一次的周期噪音。**正式文档面（guide/reference/architecture）主导的空间适合开；memory/ 日记主导的空间建议先不开或只在正式文档批次开**；
- 族关 = 零 hints **且零额外查询**（连 tag 池聚合、路径存在性轻查都不做），所以「先全关、按需逐族开」没有任何隐藏成本。

**去重窗口**：同一 `(actor, code, 资源)` 在**窗口内只提示一次**——缺省 **6 小时**，部分码按注册表声明另有长度（`search_experiences_suggested` 6h、`docs_overview_truncated` 24h；`normalized` 态不占窗口——它是每次请求的事实回显）。所以「第一次写没看到 hint、第二次也没看到」可能是窗口压制而非没触发；想立刻复核可换个 actor 或用 `get_doc_facets` 看空间状态。

**与幂等/unchanged 的边界**：`upsert_doc` 内容未变（`unchanged:true`）**不发 hints**（纯标签/元数据调整请走 `patch_doc_metadata`，它的 unchanged 出口**仍发** metadata 族 hints）；`clientRequestId` 重放返回**首次 hints 快照**且不消耗去重窗口。

---

### 3.9 存量治理：tag rename/merge + category merge + orphan 诊断

> 三个治理端点把「存量 metadata 收拾干净」变成可控操作。**核心纪律：写操作永远 `dryRun` 先行**——预演零副作用，拿 `batchToken` 后带 `expectedBatchToken` 执行，把「执行时世界已变」变成一次 409 而非静默错改。

**① tag rename / merge（`rename_doc_tags` / `POST /doc-spaces/:id/tags/rename`）**

`from` 单元素 = rename，多元素 = merge（`["NPC","npc "]` → `"npc"` 一次收拢）；存储层语义同一（每个 from 值替换为 to）。

```bash
# 第 1 步：预演（零副作用零审计零幂等占用）——拿到受影响清单与 batchToken
rename_doc_tags { "spaceName": "…", "from": ["NPC","npc "], "to": "npc", "dryRun": true }
# → { dryRun:true, affectedDocs:{total,sample≤50,truncated}, perValue:[{value,docCount}],
#     similarNotAffected:[…trgm 近义候选，可补进 from…], vocabularyPlan:{…}, ingestAffected:[…], batchToken }
# 第 2 步：核对 sample（currentTags 是改写前快照）与 perValue 命中数；
#          若 similarNotAffected 里有本该一起收拢的值，把它补进 from 重跑第 1 步。
# 第 3 步：执行——必须带第 1 步返回的 batchToken
rename_doc_tags { "spaceName": "…", "from": ["NPC","npc "], "to": "npc", "expectedBatchToken": "<token>" }
# 并发写改了受影响集 → 409 DOC_BATCH_CONFLICT（abort-all 零副作用）
#   data.diff.currentAffectedDocIds = 当前受影响集（token 单向哈希，服务端无法重建你的 dryRun 快照）
#   → 与你的 dryRun 结果对比，然后重新 dryRun 拿新 token；不要盲重试
# 省略 expectedBatchToken = 盲执行（未校验）——治理场景不要这么做
```

**rename 后的验证路径（两步都要做）**：

1. **facets 复核**：`get_doc_facets { spaceName }` 看 `tags[]`——旧值应消失、新 canonical 值出现；`vocabulary.canonicalTags` 里应能看到旧值作为 alias（词表原本未声明则此时被创建，`vocabularyPlan.created=true`）；
2. **旧值搜索验证 alias 兼容**：`search_docs { q, tag: "NPC" }`（**旧值**）应仍命中改名后的文档——per-space 搜索/列表的 `tag` 过滤经词表 alias **集合展开**（`[canonical, ...aliases]` 数组重叠）；**全局 `GET /search` 不展开**，别用全局面验证。

**`truncatedAliases` 的含义**：词表 alias 有上限（`DOC_SPACE_TAG_ALIASES_MAX = 20`）。单次 rename 最多加 20 个（`from` ≤20）**自身不会溢出**，但**反复 rename 累积**可超限——此时尾部 alias 被截断（保「先旧后新」）并在 `vocabularyPlan.truncatedAliases` / `vocabulary.truncatedAliases` 报告（**空则不出现该键**）。这是**有意的取舍**：宁可截断 alias 也要让空间保持可 `PATCH`（canonicalTags 超限后该空间 `PATCH /doc-spaces/:id` 直接 422、编辑面锁死）；被裁形态对应的存量文档已改写成 canonical，**当前数据零召回损失**。看到该字段 = 你的 alias 兼容层已被裁剪，旧值召回可能不再完整。

**其他语义**：docId / 正文 / `updatedAt` **不动**（治理性 metadata 改写不 bump 排序面）；ingest 文档也被改写并单列 `ingestAffected`（记得同步仓侧 frontmatter）；审计写一条汇总行，`oldData` 含 per-doc 前快照——**回滚 = 按 oldData 反向 rename**。

**② category merge（`POST /doc-categories/:id/merge`；语义工具已降级）**

把 source 分类（`categoryId`）合并进 `targetId`：docs 重指向 + 软删 source。**dryRun 先行**（**execute 不接 `expectedBatchToken`**——merge 的 `batchToken` 仅供自行交叉核对）：

```bash
# 预演（零副作用）
curl -s -X POST "$BASE/doc-categories/$SOURCE_CATEGORY_ID/merge" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"targetId\":\"$TARGET_CATEGORY_ID\",\"dryRun\":true}" | jq
# → { dryRun:true, source:{id,slug,name}, target:{…}, affectedDocs:{total,sample≤50,truncated},
#     softRefs:{routesCategoryCount, excludeCategories}, ingestAffected, batchToken }

# 执行
curl -s -X POST "$BASE/doc-categories/$SOURCE_CATEGORY_ID/merge" \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"targetId\":\"$TARGET_CATEGORY_ID\"}" | jq
```

**软引用修正（`removeCategory` 没有、merge 必须有的部分）**：merge 会**同事务**改写 `doc_routes.category`（旧 slug → 新 slug，计数 `softRefsFixed.routesUpdated`）与 `settings.overviewFilter.excludeCategories`（含旧 slug 则替换，`excludeCategoriesUpdated` 0/1），再软删 source（slug 释放）。dryRun 的 `softRefs` 就是这两项的将影响面。

**⚠️ category 无 alias 机制**：与 tag 不同，**merge 后按旧 slug 查询即空**——合并前先把「按旧 slug 的引用」改掉，别指望 alias 兜底。错误面：404（source/target 不存在）、422（`target===source` / 跨空间 / target 已软删）。

**③ orphan 诊断（`GET /doc-spaces/:id/docs/orphans`；语义工具已降级）**

只读诊断面：列出**未被任何 `doc_routes`（primary ∪ secondary）引用的未删文档**。**叶子文档无路由 ≠ 错误**；「route 指向已删 doc」属断链面（link health），不算 orphan。

```bash
curl -s -H "X-API-Key: $KEY" "$BASE/doc-spaces/$SPACE_ID/docs/orphans" | jq
curl -s -H "X-API-Key: $KEY" "$BASE/doc-spaces/$SPACE_ID/docs/orphans?includeExcluded=true" | jq   # 含默认排除项
curl -s -H "X-API-Key: $KEY" "$BASE/doc-spaces/$SPACE_ID/docs/orphans?pathPrefix=world/" | jq      # 切片一个目录群
# → { items:[{id,path,title,docType,categorySlug,updatedAt}], total, page, pageSize,
#     appliedFilters:{excludeTypes?,excludeCategories?,pathPrefix?,includeExcluded?},
#     stats:{totalDocs, routedDocs, orphanDocs, excludedOrphanDocs, byTopDir:[{dir,count}]} }
```

**`stats.byTopDir` 读法（怎么从清单里挑出「可行动」的）**：按 path 第一段分组计数（顶层散文件归 `"(root)"`，count DESC + dir ASC）。先看 `byTopDir`——**某个 dir 计数巨大且形态一致（如 190 篇 `world/` 叶子）= 结构性叶子群，大概率是「本就不上 routes」的采集/设定面，不该逐篇挂路由**；真正值得动手的是**零散、跨目录、计数小的条目 = 可行动孤儿**。用 `pathPrefix` 把某个群单独拉出来复核，用 `includeExcluded=true` 看默认排除挡掉了多少（`stats.excludedOrphanDocs`）。分页 `pageSize` 上限 100。

---

### 3.10 版本回溯与文档移动

**版本列表与详情**（doc history，语义工具已降级 → REST）：

```bash
# 列表（元数据 only，version DESC、单调递增、剪枝不回填）
curl -s -H "X-API-Key: $KEY" "$BASE/docs/$DOC_ID/versions" | jq
# → [{version, contentHash, authorActorId, source, createdAt, contentSize}]

# 单个版本（元数据 + 全文快照 content + 与前一版的行级 unified diff）
curl -s -H "X-API-Key: $KEY" "$BASE/docs/$DOC_ID/versions/12" | jq
# diff 读时现算不落库；fromVersion = 小于当前的最大版本号，剪枝跳号不一定是 version-1
```

- 回溯误写先列版本再取快照比对；**回滚 = 取旧版 content 走一次正常 upsert**（回滚本身也落新版，历史可审计）。

**移动/重命名（`move_doc`，原子）**：

```bash
move_doc { "spaceName": "...", "path": "docs/old.md", "toPath": "docs/new.md" }
# REST: POST /docs/:id/move
```

- 同 docId 单事务只改 path——versions / Task Links / Route 引用 / 审计链全部连续（**迁移重构禁止用 upsert+delete 绕行**，会割裂 docId 引用链）；
- 参数：`toPath`（必填）/ `expectedContentHash`（乐观锁）/ `dryRun`（完整校验链预演不写库）/ `clientRequestId`（幂等键——仅写调用登记，dryRun 不登记；同 key 重试文档不二次移动）；
- fail-closed：非 native / no-op / 撞车 / stale hash → 409；返 `{docId,oldPath,newPath,contentHash,moved,wouldMove?,impact}`；
- oldPath 不留别名、入链不静默改写（`impact.pathBasedLinksToRewrite` 给人工清单）；
- 链接解析为严格 POSIX 源目录语义（`/` 前缀 = 空间根绝对、`./` `../` 裸 href 按源文档 dirname 解析、越界 = 断链；语义表见线上 api-definition §16.19），且传 toPath 时 impact 附 `outboundPathLinksToRewrite`（被移文档自身相对出链失效清单，old/new resolvedTarget + oldTargetExists/targetExists 双标记）。

**移动前影响面（`get_doc_move_impact`，backlinks）**：

```bash
get_doc_move_impact { "spaceName": "...", "path": "docs/old.md", "proposedPath": "docs/new.md" }
# REST: GET /docs/:id/move-impact
# → inbound Markdown 入链（sourceDoc/path/title、href、isPathBased、section position/headingPath）
#   + DocRoutes + Task Doc Links；传 proposedPath 时含 targetCollision/samePath + outboundPathLinksToRewrite
# 与 move dryRun 同内核
```

**link-health 手动重检（`recheck_doc_link_health`）**：

```bash
recheck_doc_link_health { "spaceName": "...", "path": "docs/x.md" }   # 单文档；只传 spaceName = 空间级
# REST: POST /docs/:id/link-health/recheck ｜ POST /doc-spaces/:id/docs/link-health/recheck
# → 单文档返最新 LinkHealth {total,broken[],checkedAt}；空间级返 {checked,broken} 计数
```

- 场景 = 目标文档补建后刷新既有 broken 判定、解析语义升级后收敛存量混合语义、人工复核；需 write 权限。

### 3.11 元数据纯写（patch_doc_metadata）

> 只改元数据（`title`/`summary`/`docType`/`tags`/`category`），不重送全文、不触发 rechunk、不落版本、不动 contentHash/docId/引用面。**纯标签调整走这里**（upsert 内容未变时 tags 不落库，见 §3.7 边界）。

```bash
patch_doc_metadata { "spaceName": "...", "path": "docs/x.md", "tags": ["a","b"], "expectedContentHash": "..." }
# REST: PATCH /docs/:id/metadata
```

- **Partial 三态**：缺席 = 不动 / `null` = 400 / 值 = 更新，`tags: []` = 清空；
- `expectedContentHash` **必填**（乐观锁，不符 → 409 `DOC_CONTENT_CONFLICT`）；
- category 默认只解析既有（未命中 404 `DOC_CATEGORY_NOT_FOUND`，防拼写产生近似分类），`allowCreateCategory: true` 才自动创建；
- 全同值 → unchanged 短路零写零事件；返 `{docId,path,contentHash,changedFields,unchanged,metadata}`。

### 3.12 意图路由写（create / update / delete route）

```bash
create_doc_route {
  "spaceName": "...", "intent": "我要改 API", "category": "api",
  "primaryDocId": "...", "primaryHeadingPath": "§16 ...", "codeEntry": "apps/backend/src/...",
  "codeEntryType": "exact", "sortOrder": 10
}
# REST: POST /doc-spaces/:id/routes
```

- 字段：`intent`/`category`/`primaryDocId`/`primaryHeadingPath`/`secondaryDocId`/`secondaryHeadingPath`/`codeEntry`/`codeEntryType`（缺省 `exact`；`pattern` = glob 泛化写法，recheck 豁免）/`sortOrder`；写时校验服务端执行（doc 归属 / headingPath 精确命中 / codeEntry 格式），400 结构化错误透传。
- `update_doc_route { "routeId": "...", ... }`（REST `PATCH /doc-routes/:id`）：可选更新字段同上。
- **路由更新三态**：省略字段 = 保留现值；`category` / `primaryHeadingPath` / `secondaryDocId` / `secondaryHeadingPath` / `codeEntry` 的 `null` = 清空，字符串 = 更新（仍须满足既有字段约束）。这五项的 MCP schema 均为 `type: ["string", "null"]`；`intent` / `primaryDocId` / `sortOrder` / `codeEntryType` 不可空，工具丢弃其 `null`，不会替它们清空。
- **组合更新**：仅清 `secondaryDocId` 不会自动清旧 `secondaryHeadingPath`，移除次文档时推荐两者一起置 `null`；`codeEntryType: "pattern"` 时单独清 `codeEntry` 仍会触发服务端 400，可在同次更新切回 `exact` 后清空。

```json
{
  "routeId": "...",
  "category": null,
  "primaryHeadingPath": null,
  "secondaryDocId": null,
  "secondaryHeadingPath": null,
  "codeEntry": null,
  "codeEntryType": "exact"
}
```

以上参数传给 `update_doc_route`；只清目标字段时省略其余字段。

- 删除路由（语义工具 `delete_doc_route` 已降级）：`curl -X DELETE "$BASE/doc-routes/$ROUTE_ID" -H "X-API-Key: $KEY"`；routeId 来自 `list_doc_routes`。

---

## 4. 任务-文档关联（task ↔ doc N:M）

```bash
# 关联（幂等；需对任务有写权限 + 对文档空间有读权限）
POST /tasks/:id/doc-links        { "docId": "..." }
# 移除
DELETE /tasks/:id/doc-links/:docId
```

- `TaskDetail` 内嵌 `docs?: [{ docId, path, title, summary }]`（已删文档/空间自动过滤）。
- MCP `follow_up_task` 返回里已带关联文档摘要投影（零新增请求）。
- MCP `report_task_result` 支持 `docIds` 参数：report 成功后批量关联回任务，单条失败内嵌 `docLinks.failed` 不拖垮主体。

---

## 5. ingest 同步约定（scripts/sync-docs.mjs）

仓库文档镜像到平台 DocSpace 的可选适配器（零依赖 Node 原生）。**frontmatter 约定只活在本适配器，不进平台核心。**

```bash
PLATFORM_API_KEY=asp_xxx node scripts/sync-docs.mjs            # 正式同步
PLATFORM_API_KEY=asp_xxx node scripts/sync-docs.mjs --dry-run  # 只打印不写
```

- **source** = `git:<your-repo-slug>`；空间名 `<your-docspace-name>`（不存在则自建并绑定 topic）。
- **扫描范围**：仓库根白名单（`INDEX.md`/`PROJECT.md`/`AGENTS.md`/`README.md`/`DEPLOY.md`/`change-checklists.md`）+ `docs/**/*.md`（排除 `docs/plans/`）；明确排除 `memory/`、`.kimi/`、`.agents/`、`node_modules/`。
- **行为**：逐文件 `PUT` upsert（contentHash 相同 → unchanged 跳过）；仓库已删文件 → 对比远端后 `DELETE`（仅同 source）；输出 changed/unchanged/deleted 统计，任一失败 exit 1。
- **环境变量**：`PLATFORM_API_KEY`（必填，不入库不入 git）、`PLATFORM_BASE_URL`（默认 `http://localhost:<port>/api/v1`，端口默认 8743）、`PLATFORM_TOPIC_ID`（绑定 topic 覆盖）。
- **frontmatter 约定**（写入文档头，适配器解析）：`title / summary / type / category / tags`；无 frontmatter 时以文件名推导 title、首段推导 summary。
- `deploy.sh` 含可选 ingest 步骤：检测到脚本且 env 具备时执行，失败 WARN 不阻断部署。

---

## 6. 端点与工具速查

**MCP 语义工具**：数量以主 SKILL.md §6.1a 机器装配总览（`pnpm skill:gen` AUTO 区）为准；**DocSpace 工具的契约详情 = 本文档各章节**（唯一事实源，主文件只留分组导航）；逐工具参数契约另见线上 `docs/integrations/platform-mcp.md` §2。

**REST 端点**（完整契约见 `docs/api-definition.md` §16）：

| 分组 | 端点 |
|------|------|
| 空间 | `POST/GET /doc-spaces`、`GET/PATCH/DELETE /doc-spaces/:id`、`GET /doc-spaces/:id/overview`（routes 段截断 + `routesTruncated`/`routesTotal`）、`GET /doc-spaces/:id/export`（全量导出 bundle，`formatVersion 2` 含媒体字节；`?pathPrefix=` 部分快照 + `appliedFilters` 回声；未知 query 参数 → 400）、`POST /doc-spaces/:id/import-bundle`（回导，吃 v1/v2，`?overwriteSpaceMeta=`） |
| 成员（creator-only） | `POST /doc-spaces/:id/{invite-agent,uninvite-agent,add-editor,remove-editor}` |
| 分类 | `POST /doc-spaces/:id/categories`、`PATCH/DELETE /doc-categories/:id` |
| 意图路由 | `GET/POST /doc-spaces/:id/routes`（GET 双模式：不传分页参数 = 全量数组 + 1000 兜底，传 page/pageSize = 分页信封；q/category 过滤）、`PATCH/DELETE /doc-routes/:id`、`POST /doc-spaces/:id/routes/recheck`（手动重检 health，space write）、`PUT /doc-spaces/:id/repo-manifest`（仓库清单上报，space write） |
| 文档读 | `GET /doc-spaces/:id/docs`（`pathPrefix=` 前缀过滤，与 `path=` 互斥；`updatedAfter=`（ISO 8601 下界，含边界）+ `sort=`（`updatedAt_desc`/`updatedAt_asc`，缺省 path ASC）——⚠️ 与搜索面的 `createdAt_*` 词表**双轨不可互换**）、`GET /doc-spaces/:id/docs/tree`（懒加载目录树：prefix 分层 + folders/docs 独立分页）、`GET /doc-spaces/:id/docs/facets`（全空间 type/tag/category 聚合计数；逐项带 `vocabStatus`（types declared/undeclared；tags canonical/alias/undeclared，alias 带 `canonicalValue`）并回显 `vocabulary`——MCP `get_doc_facets`，见 §3.7）、`GET /doc-spaces/:id/search`（`offset`/`sort`/`createdAfter`/`createdBefore`；响应信封带 `hintCode` 三态判别与 `hints[]` 统一提示，读侧两条仅在该空间开了 `read` 族时出现）、`GET /docs/:id`（小文档 full 与 `full=true` 匹配面逐字节同形）、`GET /docs/:id/content`（`full=true` 为保真匹配面，默认 `false` web 渲染）、`GET /docs/:id/sections/:position?`（`positions=1,3,5` 批量 + `headingQuery=` 模糊定位；响应含保真 `markdown` 字段） |
| 文档写 | `PUT /doc-spaces/:id/docs`（可选 `expectedContentHash`）、`PUT /doc-spaces/:id/docs/batch`（1–50 篇批量，不支持 expectedContentHash）、`PATCH /docs/:id/sections/:position`（section 级写，body `{content, expectedSectionHash?}`，`?source=` 可选）、`PATCH /docs/:id/content`（match 模式写，body `{oldString, newString}`，操作面 = full=true 保真全文）、`POST /docs/:id/append`（追加写，`position=end|under-heading`）、`PATCH /docs/:id/metadata`（纯元数据，`expectedContentHash` 必填）、`POST /docs/:id/move`（原子移动/重命名）、`DELETE /docs/:id` |
| 版本与巡检 | `GET /docs/:id/versions`、`GET /docs/:id/versions/:version`（快照 + 行级 diff）、`GET /docs/:id/move-impact`（backlinks）、`POST /docs/:id/link-health/recheck`、`POST /doc-spaces/:id/docs/link-health/recheck`（空间级） |
| 存量治理 | `POST /doc-spaces/:id/tags/rename`（存量 tag rename/merge，dryRun 先行 + `expectedBatchToken`；§3.9）、`POST /doc-categories/:id/merge`（分类合并 + 软引用修正；§3.9）、`GET /doc-spaces/:id/docs/orphans`（orphan 诊断清单，含 `stats.byTopDir`；§3.9） |
| 任务关联 | `POST/DELETE /tasks/:id/doc-links[/:docId]` |

**错误码（10000 段）**：`DOC_SPACE_NOT_FOUND`(10000) / `DOC_NOT_FOUND`(10001) / `DOC_CATEGORY_NOT_FOUND`(10002) / `DOC_SOURCE_MISMATCH`(10003, 409) / `DOC_LINK_NOT_FOUND`(10004) / `DOC_ROUTE_DOC_NOT_FOUND`(10005, 400) / `DOC_ROUTE_HEADING_UNRESOLVED`(10006, 400) / `DOC_ROUTE_INVALID_CODE_ENTRY`(10007, 400) / `DOC_ROUTE_NOT_FOUND`(10008, 404) / `DOC_CONTENT_CONFLICT`(10009, 409：写并发冲突——expectedSectionHash / expectedContentHash / 读取时 contentHash 校验失败) / `DOC_SPACE_VOCABULARY_INVALID`(10014, 422：`settings.docTypes/canonicalTags/pathTypes` 业务校验失败——canonical 值 ci 重复 / alias 跨条目冲突 / pathPrefix 重复 / trim 后为空；`data.conflicts` 逐条带 field/kind/value/`index`（**入参数组下标**）/conflictsWith/conflictingIndex，**422 时零写入**——逐条改完重发，别原样重试) / `DOC_SPACE_HINT_TOGGLES_INVALID`(10015, 422：`settings.hintToggles` 未知族键或非 boolean，`data` 带 `unknownKeys`/`invalidKeys`/`allowedFamilies`) / `DOC_BATCH_CONFLICT`(10016, 409：批量治理快照冲突——`expectedBatchToken` 与事务内重算不符，`data.diff.currentAffectedDocIds`，abort-all 零副作用)。

---

## 相关文档

- [`../SKILL.md`](../SKILL.md) — 平台总入口（认证 / Actor 模型 / MCP 接入 / 模块导航）
- [`../attachments/SKILL.md`](../attachments/SKILL.md) — 附件上传/签名 URL/TTL（bundle 媒体边界见 §3.6）
- [`../taskboard/SKILL.md`](../taskboard/SKILL.md) — 任务看板（doc-links 的任务侧）
- `docs/api-definition.md` §16 — DocSpace 完整 API 契约
- `docs/integrations/platform-mcp.md` §2 — 文档语义工具参数契约

> **维护触发器**：DocSpace 端点/工具/词表/hint 族/治理面任一变更 → 回本文件同步（事实源以线上 api-definition 与实时 API schema 为准）；本文件只写现行版本行为，历史变更归 git log 与 release notes。
