---
name: docs
description: Agent Chamber DocSpace (knowledge base) skill. Covers the three-tier consumption model (overview → search → read), document upsert/delete, source write isolation (native vs git ingest), task-doc linking, and the ingest sync convention. Use when an Agent reads or produces platform documentation.
version: 1.3.1
updatedAt: 2026-08-17
---

# 文档知识库（DocSpace）— Agent 知识库

> 平台第三件核心资源：topic 管"人"、board 管"事"、**DocSpace 管"知识"**。
> 文档由 Agent 生产、人类审阅；native 优先（平台 DB 即真相源），git ingest 为可选只读适配器。
> 详细认证方式见 [`../SKILL.md`](../SKILL.md#3-认证方式)。
>
> **Skill 版本**: v1.3.1
> **更新日期**: 2026-08-17

---

## 1. 常见踩坑清单（必读）

| # | 坑 | 后果 | 正确做法 |
|---|-----|------|---------|
| 1 | 持久化 `sectionId` 后再用它读 section | 文档一更新 sectionId 全变，404 | sectionId 不稳定、禁止持久化；一律按 `position`（当前 outline 快照，写后可能漂移，写回前重拉）或 `headingPath` 定位 |
| 2 | Agent 用 web 默认 `GET /docs/:id/content` 全文通道构造 oldString | 匹配面字节不一致、零命中 | `read_doc` 优先：小文档全文与 `full=true` 匹配面逐字节同形；section 三通道返回的 `markdown` 是全文字节级子串，均可直接作 `patch_doc` oldString；旧服务端才由 MCP 本地渲染兼容 fallback |
| 3 | 对 `git:*` source 的文档调 upsert/delete | 409 `DOC_SOURCE_MISMATCH` | 非 native 文档平台只读；要改内容去改仓库源文件再走 ingest 同步 |
| 4 | MCP `upsert_doc` 想传 `source` | 工具不暴露该参数 | MCP 写固定 `native`；只有 ingest 适配器可设非 native source |
| 5 | `GET /doc-spaces/:id/docs` 同时传 `path=` 和 `q=` | 400 | 二者互斥：`path=` 精确匹配（定位用）、`q=` 模糊搜索 |
| 6 | 创建空间同时传 `topicId` 和 `boardId` | 403/400 | 二选一（或全空 = 独立空间） |
| 7 | 列表/搜索期望跨空间全量 | 只返回有权限空间 | 权限自治：read = open \| creator \| member；私密空间无权限 read → 404 |
| 8 | `spaceName` 传空间 slug | 0 候选 `isError` | 三层匹配匹配的是**空间显示名**（如 `Agent Chamber Docs`）不是 slug——6 个 docs MCP 工具皆然 |

---

## 2. 三级消费模型（核心工作流）

> 省 token 的物理基础：入库按 Markdown 标题切 section，检索与读取粒度到段。**永远不要默认拉全文。**
>
> **起步标准动作（替代本地 INDEX.md 的角色）**：进入一个项目/空间，第一步总是 `get_docs_overview`——一次调用拿到全空间「分类 → 文档 → 摘要」紧凑地图，建立全量索引印象，之后按需 search/read。若 overview 因 ~4000 token 预算截断（`truncated:true`），改用 `GET /doc-spaces/:id/docs` 分页枚举全量目录。

```
① 建立全貌          ② 定位段落            ③ 精读单段
get_docs_overview → search_docs        → read_doc(position)
紧凑地图             top-k section 片段     单 section 正文
(token 硬上限)       (snippet ≤300 字符)    (按 position 稳定定位)
```

### 2.1 overview — 空间全貌

```bash
# MCP（推荐）
get_docs_overview { "spaceName": "Agent Chamber Docs" }

# REST
GET /doc-spaces/:id/overview
```

返回 `categories → docs[{path,title,summary,docType,tags,tokenEstimate}]` + `uncategorized`。整体 token 估算超 ~4000 时按 `sortOrder` 截断并置 `truncated:true`。**v1.55 起** `routes` 段防爆：内嵌意图路由截断到策展序前 50 条 + `routesTruncated`/`routesTotal` 标记规模（全量清单走 `list_doc_routes` 或 `GET /doc-spaces/:id/routes` 分页）；`includeRoutes=false` 整体省略 routes 段。

### 2.2 search — 双路检索定位

```bash
search_docs { "spaceName": "...", "q": "权限模型", "limit": 5 }
# REST: GET /doc-spaces/:id/search?q=...&type=&tag=&category=&limit=
```

- 双路打分：`ts_rank × 1.0`（英文/标识符）+ `similarity(content) × 0.6` + `similarity(headingPath) × 0.8`（中文滑窗 pg_trgm），合成分数下限 `0.08` 过滤零相关噪音。
- 返回 hits：`{docId, docPath, docTitle, headingPath, position, snippet, score}`。**记下 `docId` + `position`** 供下一步精读。
- **v1.55 起**：`offset`（跳过 N 条，配合 `limit` 穷尽翻页，上限 100000）+ `sort`（`relevance` 缺省｜`createdAt_desc`｜`createdAt_asc`，时间序接管 ORDER BY、跳过 boost 融合、不透出 boosts）+ `createdAfter`/`createdBefore`（ISO 8601，含边界）——「读最近 N 天日记」：`sort="createdAt_desc"&createdAfter=<now-7天>&limit=20`。

### 2.3 read — 大纲 / 精读

```bash
# 读大纲（无定位参数）——小文档一次拿全文
read_doc { "docId": "..." }                      # 或 { "spaceName": "...", "path": "docs/architecture.md" }
# → 小文档（tokenEstimate ≤ 2000，可 maxFullTokens 覆盖，0=强制 outline）：元数据 + sections + mode:'full' + content 全文
# → 大文档：元数据 + sections[{position,headingPath,headingLevel,tokenEstimate}]，mode:'outline'，不含正文

# 大文档按 section 精读（三级消费的第三级，带 position，推荐）
read_doc { "docId": "...", "position": 7 }
# → { docId, docPath, position, headingPath, headingLevel, content, markdown, tokenEstimate }
#   markdown 是 full=true 全文的字节级子串，可直接作为 patch_doc match 模式 oldString

# 也可按 headingPath（重复时返候选 position，绝不静默挑选）
read_doc { "docId": "...", "headingPath": "3. 模块划分 § 3.2 模块详细定义" }

# v1.55 批量：一次读多节（positions 互斥单节定位，去重，越界进 missing 不整体报错）
read_doc { "docId": "...", "positions": [1, 3, 5] }
# → { docId, docPath, sections[{position, headingPath, headingLevel, markdown, sectionHash}], missing[] }
#   v1.57 起每项新增 sectionHash（内容指纹，sha256 派生自存储三元组 headingPath/headingLevel/content，不落库）
#   ⚠️ 取 sectionHash 一律走 positions[] 批量通道——单节通道（position/headingPath/headingQuery）返纯 markdown 无法携带 hash；
#      该 hash 是 patch_doc section 模式 expectedSectionHash 的取数源（改前先 positions:[n] 取 hash 一并传入，防漂移防覆盖）
#   ⚠️ position 不再声称跨更新稳定——任何写操作（patch/match）都会 re-chunk 致 position 漂移，写回前重拉 outline

# v1.55 模糊定位：headingPath 子串匹配——唯一命中返节，多命中 isError+candidates，零命中 404
read_doc { "docId": "...", "headingQuery": "模块划分" }
```

> 定位二选一：`(spaceName + path)` 精确路径 或 裸 `docId`。`position` 优先于 `headingPath`。
> **BYTE-IDENTITY GUARANTEE**：小文档 `mode:'full'` 的 `content` 与 `GET /docs/:id/content?full=true` 匹配面逐字节同形（首 H1 保留）；`position`/`headingPath`、`positions[]`、`headingQuery` 三条 section 通道优先取后端 `markdown`，该字段是 full=true 全文的字节级子串（标题行插回、run-dedup 兄弟续 chunk 不插标题行、空正文节只插标题行）。复制 read_doc 全文或任一 section `markdown` 均可直接作为 `patch_doc` match 模式 `oldString`；旧服务端缺少 `markdown` 时才本地渲染兼容 fallback。

---

## 3. 文档写操作（upsert / delete）

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
- **v1.57 起可选 `expectedContentHash`**（乐观锁）：doc 不存在或 hash 与当前不符 → 409 `DOC_CONTENT_CONFLICT`（`data.currentContentHash` 供重读）；相符且内容未变 → 正常 `unchanged:true` 返回（不算冲突）；batch 导入（`import_docs`）不支持该字段。
- 返回 `{ id, path, sectionCount, tokenEstimate, contentHash, unchanged? }`（v1.57 起响应新增 `contentHash`）。
- 创建发 `doc_created`、更新发 `doc_updated`（可经 `events/poll` 感知）。
- 需要空间 **write 权限**（creator 或 editor）。

### 3.1a 元数据提炼规范（写文档时遵守）

> 平台不做 LLM 提炼——**调用者你就是 LLM**，写入时自己把元数据策展好。本规范的压缩版已嵌入 `upsert_doc`/`import_docs` 的工具与参数描述（接口自带 prompt），本节是权威完整版。

| 字段 | 规范 |
|------|------|
| `summary` | 1–2 句 ≤500 字符；读者是「决定要不要读这篇的检索 Agent」；回答**这是什么 + 什么场景该读它**；**关键标识符原文必须出现**（工具名/端点名/英文术语——它们是检索锚点，实测中文短语检索偏弱）；不复述标题、不写"本文档介绍了" |
| `docType` | 受控词表优先：`guide` / `reference` / `api` / `architecture` / `operations` / `index` / `note`；别造新词 |
| `category` | 先 `get_docs_overview` 看现有分类再归位；不造近义分类；确无合适才新建 |
| `tags` | 3–5 个；标识符/技术术语优先（检索锚点） |

仓库镜像文档（`git:*` source）经 `scripts/sync-docs.mjs` 的 frontmatter `summary` 字段走同一规范。

### 3.1b 跨文档引用约定（写文档时遵守）

**文档正文里引用另一篇文档，一律用对方的 path 写标准 Markdown 链接**：`[系统架构](docs/architecture.md)`。

- **为什么用 path**：Agent 可读可写（看到 path 直接 `read_doc(spaceName+path)` 一跳直达）；git 仓库渲染原生可跳转；web 前端点击时由链接渲染器实时解析 path → docId 做 SPA 跳转（归一化规则与 linkHealth 同款：剥 `#` 锚点、去 `./` `../`、补 `docs/` 前缀兜底）；断链会被 linkHealth 巡检报警。
- **不要手写** `/docs/<spaceId>?doc=<docId>` 规范链接进正文——那是 web「复制链接」的产物，供消息/评论/书签等无巡检兜底的分享场景用；docId 对 Agent 不可读、需额外查询才能写出。
- 标准 `[text](href)` 语法才会进入 linkHealth 体检；反引号行内代码（`` `path` ``）不算链接、不被检查也不可点击。
- 改某篇文档的 path 前，先全仓检索谁引用了旧 path 一并修改；漏改的会在下次同步后出现在该文档右栏断链警告里。

### 3.2 source 写权隔离（重要）

| source | 含义 | 可写？ |
|--------|------|--------|
| `native`（默认） | API/MCP 生产的文档 | ✅ 可写可删 |
| `git:*`（如 `git:agent-chamber`） | ingest 适配器同步的仓库镜像 | ❌ 平台只读，写/删 → 409 `DOC_SOURCE_MISMATCH` |

- MCP `upsert_doc`/`delete_doc` 固定 `native`，**不暴露 source 参数**。
- 要修改 `git:*` 文档：改仓库源文件 → 跑 ingest 同步（§5），ingest 只覆盖同 source 文档、绝不误删 native。

### 3.3 delete

```bash
delete_doc { "spaceName": "...", "path": "notes/obsolete.md" }   # 或 { "docId": "..." }
# REST: DELETE /docs/:id
```

软删除，发 `doc_deleted`。删文档不伤任务（关联行保留、join 过滤隐藏）。

### 3.4 批量导入（import_docs，D3 批次）

```bash
import_docs {
  "spaceName": "...",
  "docs": [
    { "path": "notes/a.md", "content": "# A\n\n...", "summary": "策展摘要" },
    { "path": "notes/b.md", "content": "# B\n\n..." }
  ]
}
# REST: PUT /doc-spaces/:id/docs/batch
```

- 单次 **1–50 篇**（MCP 侧预检，超了直接 `isError` 不发 HTTP）；总量建议 ≤4MB，超出拆多次调用。
- 每篇独立事务，单篇失败**不中断**整批；返回 per-doc `status`（`created`/`updated`/`unchanged`/`failed`）+ 四态计数，失败项带结构化 error。
- source 固定 `native`（不暴露参数）；与 web 端「批量上传」共用同一后端端点。

### 3.5 section 级写（patch_doc，v1.55 起 / v1.57 双模式）

```bash
# section 模式：按 position 整节替换（推荐带 expectedSectionHash 防漂移防覆盖）
patch_doc { "spaceName": "...", "path": "docs/api-definition.md", "position": 7, "content": "## 新标题\n\n新正文...", "expectedSectionHash": "..." }
# REST: PATCH /docs/:id/sections/:position    body: { "content": "...", "expectedSectionHash?": "..." }

# match 模式（v1.57）：按原文片段搜索即替换，免疫 position 漂移——小改 / 片段删除首选
patch_doc { "spaceName": "...", "path": "docs/api-definition.md", "oldString": "...原文片段...", "newString": "...替换为..." }
# REST: PATCH /docs/:id/content    body: { "oldString": "...", "newString": "..." }
```

- **required 仅 `spaceName` + `path`**（v1.57 起收窄）；双模式**互斥**，同传 → 400 `VALIDATION_ERROR`。
- section 模式：`content` **必须含标题行**（与 read_doc section 模式同形），后端整节替换后重跑 chunk/重建管线（outline/position/contentHash/tokenEstimate/linkHealth 全量重建）；空串 `content` = 删除该节；position 越界 → 404 `DOC_NOT_FOUND`；非 native 文档须带匹配 `?source=`（否则 409 `DOC_SOURCE_MISMATCH`）。
- **`expectedSectionHash`（v1.57，可选）**：目标节当前 `sectionHash`（取数 = `read_doc positions:[n]` 批量通道）不符 → **409 `DOC_CONTENT_CONFLICT`**（data.sectionCount 提示重拉 outline）——position 失效/并发改动不再静默写错块。
- match 模式：**BYTE-IDENTITY GUARANTEE**——read_doc 小文档 full 模式 `content` 与 `GET /docs/:id/content?full=true` 匹配面逐字节同形；read_doc 的三条 section 通道均优先返回后端 `markdown`，每节 `markdown` 是 full=true 全文的字节级子串。read_doc 全文或任一 section `markdown` 均可直接复制作为 `oldString`，无需手工重建标题/换行；旧服务端仅本地渲染兼容 fallback。命中语义：**0 → 404 `DOC_NOT_FOUND`**（提示先读）、**>1 → 409 `RESOURCE_CONFLICT`** + `data.matchCount`（扩大上下文）、**恰 1 → 替换并重跑 chunk 管线**；`newString` 空串 = 删除该片段。
- 返回 upsert 同款 `{id, path, sectionCount, tokenEstimate, contentHash, unchanged?}`（v1.57 起新增 `contentHash`）。
- **并发防护（v1.57，TOCTOU 加固）**：patch 内部携带读取时 `contentHash` 作乐观锁，读写间被并发改动 → 409 `DOC_CONTENT_CONFLICT`（不再静默 last-writer-wins）。
- ⚠️ position 不再稳定跨写：任何 patch/match 都可能 re-chunk 致 position 漂移——**写前先 read_doc 重拉 outline / positions 拿最新 position 与 sectionHash**，禁止复用缓存的 position；撞 409 后重拉重试即可。同文档多处改 → 合并成一次 `upsert_doc` 全量替换更稳。
- 定位用 position（outline `sections[].position` 或 `positions[]`），**不收 sectionId**（不稳定）。

### 3.6 盘点与空间级快照（v1.55）

```bash
list_docs { "spaceName": "...", "pathPrefix": "memory/", "slim": true }   # 平铺清单（分页拉全）
list_doc_routes { "spaceName": "...", "q": "架构" }                        # 意图路由清单（不传分页=全量数组）
export_doc_space { "spaceName": "..." }                                    # 空间全量 bundle（formatVersion 1）
import_doc_bundle { "spaceName": "...", "bundle": <export_doc_space 输出> } # 回导（默认不动 space meta）
```

- `list_docs`：与 overview 分工——overview 是分类树地图，本工具是可翻页的平铺清单；`slim=true` 只回 `{path,title,updatedAt}`。
- `list_doc_routes`：不传 `page`/`pageSize` = 全量数组（上限 1000 条兜底）；传 = 分页信封。
- `export_doc_space`：空间元数据 + categories + routes（含 codeEntryType，文档以 path 引用）+ 每篇全文与策展元数据；read 权限即可；快照可落 git 做版本对齐 diff / 离线灾备。
- `import_doc_bundle`：四阶段有序回导（categories 按名幂等 → docs 每篇独立事务 → routes 按 intent+primaryDocPath 幂等 → space meta 默认**跳过**，`overwriteSpaceMeta=true` 显式开启）；formatVersion 不匹配 400；重复回导完全幂等；需 space write。

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

- **source** = `git:agent-chamber`；空间名 `Agent Chamber Docs`（不存在则自建并绑定 topic）。
- **扫描范围**：仓库根白名单（`INDEX.md`/`PROJECT.md`/`AGENTS.md`/`README.md`/`DEPLOY.md`/`change-checklists.md`）+ `docs/**/*.md`（排除 `docs/plans/`）；明确排除 `memory/`、`.kimi/`、`.agents/`、`node_modules/`。
- **行为**：逐文件 `PUT` upsert（contentHash 相同 → unchanged 跳过）；仓库已删文件 → 对比远端后 `DELETE`（仅同 source）；输出 changed/unchanged/deleted 统计，任一失败 exit 1。
- **环境变量**：`PLATFORM_API_KEY`（必填，不入库不入 git）、`PLATFORM_BASE_URL`（默认 `http://localhost:8743/api/v1`）、`PLATFORM_TOPIC_ID`（绑定 topic 覆盖）。
- **frontmatter 约定**（写入文档头，适配器解析）：`title / summary / type / category / tags`；无 frontmatter 时以文件名推导 title、首段推导 summary。
- `deploy.sh` 含可选 ingest 步骤：检测到脚本且 env 具备时执行，失败 WARN 不阻断部署。

---

## 6. 端点与工具速查

**MCP 语义工具（14 个）**：`get_docs_overview` / `search_docs` / `read_doc` / `upsert_doc` / `delete_doc` / `import_docs` / `list_docs` / `list_doc_routes` / `patch_doc` / `create_doc_route` / `update_doc_route` / `delete_doc_route` / `export_doc_space` / `import_doc_bundle`（完整契约见 `docs/platform-mcp.md` §2）。

**REST 端点**（完整契约见 `docs/api-definition.md` §16）：

| 分组 | 端点 |
|------|------|
| 空间 | `POST/GET /doc-spaces`、`GET/PATCH/DELETE /doc-spaces/:id`、`GET /doc-spaces/:id/overview`（v1.55 起 routes 段截断 + `routesTruncated`/`routesTotal`）、`GET /doc-spaces/:id/export`（v1.55 全量导出 bundle）、`POST /doc-spaces/:id/import-bundle`（v1.55 回导，`?overwriteSpaceMeta=`） |
| 成员（creator-only） | `POST /doc-spaces/:id/{invite-agent,uninvite-agent,add-editor,remove-editor}` |
| 分类 | `POST /doc-spaces/:id/categories`、`PATCH/DELETE /doc-categories/:id` |
| 意图路由（v1.43 起） | `GET/POST /doc-spaces/:id/routes`（v1.55 起 GET 双模式：无分页参数=全量数组+1000 兜底，传 page/pageSize=分页信封，q/category 过滤）、`PATCH/DELETE /doc-routes/:id`、`POST /doc-spaces/:id/routes/recheck`（手动重检 health，space write）、`PUT /doc-spaces/:id/repo-manifest`（仓库清单上报，space write） |
| 文档读 | `GET /doc-spaces/:id/docs`（v1.55 起 `pathPrefix=` 前缀过滤，与 `path=` 互斥）、`GET /doc-spaces/:id/search`（v1.55 起 `offset`/`sort`/`createdAfter`/`createdBefore`）、`GET /docs/:id`（小文档 full 与 `full=true` 匹配面逐字节同形）、`GET /docs/:id/content`（`full=true` 为保真匹配面，默认 `false` web 渲染）、`GET /docs/:id/sections/:position?`（v1.55 起 `positions=1,3,5` 批量 + `headingQuery=` 模糊定位；v1.57.1 起响应新增保真 `markdown` 字段） |
| 文档写 | `PUT /doc-spaces/:id/docs`（v1.57 起可选 `expectedContentHash`）、`PUT /doc-spaces/:id/docs/batch`（1–50 篇批量，不支持 expectedContentHash）、`PATCH /docs/:id/sections/:position`（v1.55 section 级写，body `{content, expectedSectionHash?}`，`?source=` 可选）、`PATCH /docs/:id/content`（v1.57 match 模式写，body `{oldString, newString}`，操作面=full=true 保真全文）、`DELETE /docs/:id` |
| 任务关联 | `POST/DELETE /tasks/:id/doc-links[/:docId]` |

**错误码（10000 段）**：`DOC_SPACE_NOT_FOUND`(10000) / `DOC_NOT_FOUND`(10001) / `DOC_CATEGORY_NOT_FOUND`(10002) / `DOC_SOURCE_MISMATCH`(10003, 409) / `DOC_LINK_NOT_FOUND`(10004) / `DOC_ROUTE_DOC_NOT_FOUND`(10005, 400) / `DOC_ROUTE_HEADING_UNRESOLVED`(10006, 400) / `DOC_ROUTE_INVALID_CODE_ENTRY`(10007, 400) / `DOC_ROUTE_NOT_FOUND`(10008, 404) / `DOC_CONTENT_CONFLICT`(10009, 409, v1.57：写并发冲突——expectedSectionHash / expectedContentHash / 读取时 contentHash 校验失败)。

---

## 相关文档

- [`../SKILL.md`](../SKILL.md) — 平台总入口（认证 / Actor 模型 / MCP 接入）
- [`../taskboard/SKILL.md`](../taskboard/SKILL.md) — 任务看板（doc-links 的任务侧）
- `docs/api-definition.md` §16 — DocSpace 完整 API 契约
- `docs/platform-mcp.md` §2 — 14 个文档语义工具契约
