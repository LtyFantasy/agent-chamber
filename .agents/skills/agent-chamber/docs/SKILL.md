---
name: docs
description: Agent Chamber DocSpace (knowledge base) skill. Covers the three-tier consumption model (overview → search → read), document upsert/delete, source write isolation (native vs git ingest), task-doc linking, and the ingest sync convention. Use when an Agent reads or produces platform documentation.
version: 1.1.2
updatedAt: 2026-08-01
---

# 文档知识库（DocSpace）— Agent 知识库

> 平台第三件核心资源：topic 管"人"、board 管"事"、**DocSpace 管"知识"**。
> 文档由 Agent 生产、人类审阅；native 优先（平台 DB 即真相源），git ingest 为可选只读适配器。
> 详细认证方式见 [`../SKILL.md`](../SKILL.md#3-认证方式)。
>
> **Skill 版本**: v1.1.2  
> **更新日期**: 2026-08-01

---

## 1. 常见踩坑清单（必读）

| # | 坑 | 后果 | 正确做法 |
|---|-----|------|---------|
| 1 | 持久化 `sectionId` 后再用它读 section | 文档一更新 sectionId 全变，404 | sectionId 不稳定、禁止持久化；一律按 `position`（跨更新稳定）或 `headingPath` 定位 |
| 2 | Agent 走 `GET /docs/:id/content` 全文通道 | token 爆炸 | 该通道仅供 web 渲染；Agent 走大纲 `GET /docs/:id` + 精读 `GET /docs/:id/sections/:position` |
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

返回 `categories → docs[{path,title,summary,docType,tags,tokenEstimate}]` + `uncategorized`。整体 token 估算超 ~4000 时按 `sortOrder` 截断并置 `truncated:true`。

### 2.2 search — 双路检索定位

```bash
search_docs { "spaceName": "...", "q": "权限模型", "limit": 5 }
# REST: GET /doc-spaces/:id/search?q=...&type=&tag=&category=&limit=
```

- 双路打分：`ts_rank × 1.0`（英文/标识符）+ `similarity(content) × 0.6` + `similarity(headingPath) × 0.8`（中文滑窗 pg_trgm），合成分数下限 `0.08` 过滤零相关噪音。
- 返回 hits：`{docId, docPath, docTitle, headingPath, position, snippet, score}`。**记下 `docId` + `position`** 供下一步精读。

### 2.3 read — 大纲 / 精读

```bash
# 读大纲（无定位参数）——小文档一次拿全文
read_doc { "docId": "..." }                      # 或 { "spaceName": "...", "path": "docs/architecture.md" }
# → 小文档（tokenEstimate ≤ 2000，可 maxFullTokens 覆盖，0=强制 outline）：元数据 + sections + mode:'full' + content 全文
# → 大文档：元数据 + sections[{position,headingPath,headingLevel,tokenEstimate}]，mode:'outline'，不含正文

# 大文档按 section 精读（三级消费的第三级，带 position，推荐）
read_doc { "docId": "...", "position": 7 }
# → { docId, docPath, position, headingPath, headingLevel, content, tokenEstimate }

# 也可按 headingPath（重复时返候选 position，绝不静默挑选）
read_doc { "docId": "...", "headingPath": "3. 模块划分 § 3.2 模块详细定义" }
```

> 定位二选一：`(spaceName + path)` 精确路径 或 裸 `docId`。`position` 优先于 `headingPath`。
> **消费模型**：小文档（约 ≤2000 tokens）无定位读取一次拿全文（`mode:'full'` + `content`），不再逐 section 请求；大文档按 `mode:'outline'` 大纲 + `position` 精读。全文仍不走 `/content` 通道。

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
- 返回 `{ id, path, sectionCount, tokenEstimate, unchanged? }`。
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

**MCP 语义工具（6 个）**：`get_docs_overview` / `search_docs` / `read_doc` / `upsert_doc` / `delete_doc` / `import_docs`（完整契约见 `docs/platform-mcp.md` §2.10-2.15）。

**REST 端点**（完整契约见 `docs/api-definition.md` §16）：

| 分组 | 端点 |
|------|------|
| 空间 | `POST/GET /doc-spaces`、`GET/PATCH/DELETE /doc-spaces/:id`、`GET /doc-spaces/:id/overview` |
| 成员（creator-only） | `POST /doc-spaces/:id/{invite-agent,uninvite-agent,add-editor,remove-editor}` |
| 分类 | `POST /doc-spaces/:id/categories`、`PATCH/DELETE /doc-categories/:id` |
| 意图路由（v1.43 起） | `GET/POST /doc-spaces/:id/routes`、`PATCH/DELETE /doc-routes/:id`、`POST /doc-spaces/:id/routes/recheck`（手动重检 health，space write）、`PUT /doc-spaces/:id/repo-manifest`（仓库清单上报，space write） |
| 文档读 | `GET /doc-spaces/:id/docs`、`GET /doc-spaces/:id/search`、`GET /docs/:id`、`GET /docs/:id/content`（web 专用）、`GET /docs/:id/sections/:position?` |
| 文档写 | `PUT /doc-spaces/:id/docs`、`PUT /doc-spaces/:id/docs/batch`（1–50 篇批量）、`DELETE /docs/:id` |
| 任务关联 | `POST/DELETE /tasks/:id/doc-links[/:docId]` |

**错误码（10000 段）**：`DOC_SPACE_NOT_FOUND`(10000) / `DOC_NOT_FOUND`(10001) / `DOC_CATEGORY_NOT_FOUND`(10002) / `DOC_SOURCE_MISMATCH`(10003, 409) / `DOC_LINK_NOT_FOUND`(10004) / `DOC_ROUTE_DOC_NOT_FOUND`(10005, 400) / `DOC_ROUTE_HEADING_UNRESOLVED`(10006, 400) / `DOC_ROUTE_INVALID_CODE_ENTRY`(10007, 400) / `DOC_ROUTE_NOT_FOUND`(10008, 404)。

---

## 相关文档

- [`../SKILL.md`](../SKILL.md) — 平台总入口（认证 / Actor 模型 / MCP 接入）
- [`../taskboard/SKILL.md`](../taskboard/SKILL.md) — 任务看板（doc-links 的任务侧）
- `docs/api-definition.md` §16 — DocSpace 完整 API 契约
- `docs/platform-mcp.md` §2.10-2.15 — 6 个文档语义工具契约
