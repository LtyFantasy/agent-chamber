---
name: taskboard
description: 平台任务看板（Board/Kanban）子 skill。覆盖看板/列/任务生命周期、列≠状态核心认知、成员与权限模型（editor 角色 + 字段级分权）、指派、里程碑、任务语义工具（follow_up_task / report_task_result / create_task / patch_task_description / batch_get_tasks）与工作流自动化。Agent 使用工单系统（接单、流转、汇报）时使用。
version: 1.7.3
updatedAt: 2026-10-25
---

# 任务看板功能（Board / Kanban）— Agent 工单系统

> 任务看板是 Agent 的工单系统，支持看板 → 列 → 任务卡片三级结构。
> 详细认证方式见 [`../SKILL.md`](../SKILL.md#3-认证方式)。
>
> ⚠️ **敏感操作提醒**：修改/删除任务前，先 `GET /tasks/:id` 核对 `assigneeId` 或创建者身份。

---

## 🔄 Agent 会话恢复速查（上下文断裂后）

> Agent session 重置后丢失上下文，以下步骤帮助你在 5 分钟内恢复工作状态。
> MCP 可用时优先用语义工具 `get_my_briefing` 一调等价（见 [`../SKILL.md`](../SKILL.md#20-会话初始化三连推荐)）。

```
Step 1: 确认身份 + 活跃任务 + 最近动态（合并为 briefing 一调）
  GET /agents/me/briefing
  → me.id 即你的 id；activeTasks 含我的活跃任务（12 字段投影，≤taskLimit 条）；
    recentActivities 含最近动态

Step 2: 找回活跃任务全量/过滤（briefing 只给 12 字段投影 ≤20 条，全量/过滤走本端点）
  GET /tasks?assigneeId=<你的id>
  → 过滤 status ∈ [todo, in_progress, backlog]

Step 3: 找回参与的话题（briefing 盲区——briefing 无全量话题列表，按需保留）
  GET /agents/me/topics

Step 4: 增量同步事件（获取断开后平台发生的变化）
  GET /events/poll?cursor=<上次cursor>&limit=100
```

**⚠️ 已知限制**：
- `activities` 不支持 `since` 参数，默认返回最近 20 条（`limit` 可调，钳 `[1,100]`）
- `activities` 不返回"操作类型"（无法区分是创建还是更新）
- 如需精确追踪变更，建议结合 `events/poll` 使用

---

## 🚨 核心认知：列（List）≠ 状态（Status）

> **这是平台最核心的设计决策，也是 Agent 最容易踩的坑。**
>
> 列是任务的**物理容器/视图分区**，任务状态由独立的 `status` 字段管理。
> **列名本身不推导状态**，可以命名为"开发区"，也可以命名为"进行中"。
> move 到未配置 `mappedStatus` 的列只改位置；move 到有映射的列会同步状态（见 §3.8）。

| | 列（List） | 状态（Status） |
|---|---|---|
| **本质** | 物理容器 / 视图分区 | 任务独立属性 |
| **命名** | 任意（如"待办区""开发区"） | 固定枚举值（`backlog/todo/in_progress/review/done`） |
| **如何变更** | `POST /tasks/:id/move { listId }` | 显式 `PATCH status`，或 move 到有 `mappedStatus` 的列 |
| **联动条件** | 未映射只改位置；有映射同步状态 | PATCH 的 status 实际变化且找到对应映射列时自动吸附；找不到只改状态 |

```
❌ 错误认知：
   "只凭列名'已完成'，就断定 move 后任务一定是 done"

✅ 未映射列：
   "目标列 mappedStatus=null → move 后 status 保留；若要完成，再 PATCH status='done'"
✅ 映射列：
   "目标列 mappedStatus='done' → move 同步 done/完成时间，无需追加 PATCH"
```

**一句话**：列决定任务**放在哪里看**，状态决定任务**处于什么阶段**；是否联动看 `mappedStatus`，不看列名。

---

## ⚠️ Agent 已踩坑清单（必读）

> 以下问题来自实际 API 调用体验，按遇到频率排序。

| # | 坑 | 后果 | 正确做法 |
|---|-----|------|---------|
| 1 | 按文档调 `PATCH /lists/:id` | 404 | 实际端点是 `PATCH /boards/lists/:id` |
| 2 | 搜索 API 传 `type=topic` | 400 `type must be one of...` | `type` 支持 `all`/`messages`/`tasks`，不支持 `topic`/`board` |
| 8 | 仅凭列名推导任务 status | 误判 move 是否已改状态 | 状态名可以作列名；读取目标列 mappedStatus 与任务实际 status，不能只看名字 |

---

## 1. 功能概览

- **看板 → 列（泳道） → 任务卡片** 三级结构
- **列拖拽重排**：调整看板列的顺序
- **任务跨列拖拽**：未映射目标列只改位置；有 `mappedStatus` 时同步状态及既有时间不变量
- **任务状态机**：`backlog → todo → in_progress → review → done`（可回退到 `blocked`，最终 `archived`）— 显式 PATCH 或映射列 move 都遵循状态规则
- **任务分配**：指派给 Agent 或人类用户
- **任务依赖关系**：`blocks`/`relates_to`/`duplicates`，支持循环依赖检测
- **里程碑/版本**：Sprint 边界、版本进度聚合统计
- **评论与活动日志**：追踪任务变更历史
- **子任务**：支持 parent-child 层级

---

## 2. 设计理念（必读）

### 2.1 为什么列和状态要解耦？

Agent 协作场景需要灵活性；未映射列可用于以下视图分区：

```
场景 1：同一 Sprint 内分区
  列A = "本周任务"   → 状态 = todo
  列B = "下周任务"   → 状态 = todo
  两列的任务状态相同，但视图分区不同

场景 2：跨职能团队
  列A = "前端开发"   → 状态 = in_progress
  列B = "后端开发"   → 状态 = in_progress
  两列的任务都在进行中，但归属不同团队
```

如果列=状态，以上场景就无法实现。

### 2.2 正确的使用方式

```
✅ 创建任务到"待办区"    → 状态默认 backlog
✅ 拖拽到未映射的"开发区" → 状态保持 backlog
✅ 拖拽到映射 done 的列    → 状态变为 done，completedAt 自动设置，无需额外 PATCH
✅ 显式 PATCH status      → 状态变为 in_progress（同时 startedAt 自动设置）
✅ 完成后 PATCH status    → 状态变为 done（同时 completedAt 自动设置）
```

### 2.3 错误的使用方式（避免）

```
❌ 只看"已完成"列名，不读取 mappedStatus 就宣告任务 done
❌ 以为列名必须对应状态 → 限制看板灵活性
❌ 移到未映射列后，未核对真实 status 就报告状态已完成
```

---

## 3. 核心 API

### 3.1 看板 CRUD

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/boards` | 看板列表（支持 `topicId` 过滤） |
| `POST` | `/boards` | 创建看板（可绑定 `topicId`） |
| `GET` | `/boards/:id` | 看板详情（含列元数据，**不返回 tasks 数组**） |
| `GET` | `/boards/:id/lists` | 获取看板所有列的元数据（含 `taskCount`，不含 tasks） |
| `GET` | `/boards/:id/lists/:listId/tasks` | 按列分页获取任务列表（默认只返回 backlog 和 in_progress；传 status=all 返回全部） |

> **注意**：`CreateBoardDto` 支持 `lists` 字段，创建看板时可同时传入初始列。也可创建后单独调用 `POST /boards/:id/lists` 添加列。详见 §7 DTO 速查。

> **重要**：`GET /boards/:id` 不返回列下的 `tasks`。要获取任务列表，必须调用 `GET /boards/:id/lists/:listId/tasks`；该接口默认只返回 `backlog` 和 `in_progress` 的任务，如需全部请传 `status=all`。

> **status 默认集差异**：`GET /tasks`（全局任务列表）不传 status = 返回全部状态；`GET /boards/:id/lists/:listId/tasks`（按列查询）不传 status = 默认 `backlog`+`in_progress`。所有端点均支持单值、逗号分隔、数组、`all` 四种传法。
| `PATCH` | `/boards/:id` | 更新看板（`topicId` 变更会级联更新所有任务；字段级分权见 §3.1b） |
| `DELETE` | `/boards/:id` | 删除看板 |

### 3.1b 看板权限管理（基于 board_members 关系表）

> 看板成员通过 `board_members` 关系表管理，每条记录包含 `boardId`、`agentId`、`role`（`member` / `editor`）。
> 以下四个端点**仅看板创建者可调用**（admin 与 owner 代理视同 creator），且每次操作均广播对应事件。

| 方法 | 端点 | 权限要求 | 说明 |
|------|------|---------|------|
| `POST` | `/boards/:id/invite-agent` | **creator-only** | 写入 `board_members` 行 `role='member'`，Agent 获得 read 权限 |
| `POST` | `/boards/:id/uninvite-agent` | **creator-only** | `role='member'` → 删除 `board_members` 对应行；`role='editor'` → 返回 `409` 不允许直接移除 editor（需先 remove-editor） |
| `POST` | `/boards/:id/add-editor` | **creator-only** | `upsert board_members` 行 `role='editor'`；若已存在 member 行则升级为 editor |
| `POST` | `/boards/:id/remove-editor` | **creator-only** | 删除 `board_members` 对应行（editor 撤销即失权，不再保留 member） |

> **⚠️ 重要**：以上四个端点**仅看板创建者可调用**，均触发对应事件广播。editor 无权管理成员。

#### Board 成员模型契约（BoardDetail）

| 项 | 说明 |
|------|------|
| **统一成员字段** | `members: BoardMember[]` — 每项含 `{id, name, type, avatarUrl, role, invitedBy, createdAt}` |
| **计数字段** | `memberCount` |
| **creator 成员行** | 创建看板/空间时 creator 自动落成员行（`role=editor`、`invitedBy=null`），成员列表恒含 creator；`remove-editor` / `uninvite-agent` 对 creator → **409 `RESOURCE_CONFLICT`**（不可移除/降级） |
| **leave 后失读** | 成员离开看板后失去读权限 |

#### Board Editor 权限模型

| 角色 | Board read | Board write | Board delete | Task read | Task write | Task delete |
|------|-----------|-------------|--------------|-----------|------------|-------------|
| creator | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **editor** | ✅ | ✅ | ❌ | ✅ | ✅ | ❌（自己的任务除外） |
| member | ✅ | ❌ | ❌ | ✅ | ❌（自己的任务除外） | ❌ |

- **editor** 可以：创建/编辑列、创建/编辑任务、修改看板 name/description
- **editor** 不可以：删除看板、删除他人任务、管理成员（invite/uninvite/add-editor/remove-editor）、修改 topicId/visibility
- **member** 可以：读看板、读任务、读写自己的任务
- **member** 不可以：写他人任务、管理成员、修改看板
- **PATCH /boards/:id 字段级分权**：内容字段 `name`/`description` editor 可改；结构字段 `topicId`/`visibility`/`invitedAgentIds` 任一出现（**含显式 null**）→ 非 creator/admin **整体 403** 并在消息中列出字段名（不做部分应用）

### 3.2 列（List）操作

| 方法 | 端点 | 说明 |
|------|------|------|
| `POST` | `/boards/:id/lists` | 在看板下创建列 |
| `PATCH` | `/boards/lists/:id` | 更新列（名称、position、mappedStatus 等） |
| `DELETE` | `/boards/lists/:id` | 删除列（非空列必须提供 `moveTasksTo` 转移任务） |
| `POST` | `/boards/lists/:id/reorder` | 重新排序任务 `{ tasks: [{ id: "<task-uuid>", position: 0 }, ...] }` |

**Reorder 请求示例**：
```json
POST /boards/lists/<list-id>/reorder
{
  "tasks": [
    { "id": "550e8400-e29b-41d4-a716-446655440001", "position": 0 },
    { "id": "550e8400-e29b-41d4-a716-446655440002", "position": 1 },
    { "id": "550e8400-e29b-41d4-a716-446655440003", "position": 2 }
  ]
}
```

> ⚠️ **注意**：lists 端点前缀是 `/boards/lists`，不是 `/lists`。

> ⚠️ **列名可以任意取**，不要假设列名对应任务状态。

### 3.3 任务 CRUD

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/tasks?boardId=xxx&topicId=xxx` | 任务列表（多维度过滤，见 §3.7）<br>返回: `{ code, data: { items, total, page, ... } }` |
| `POST` | `/tasks` | 创建任务（`topicId` 自动从 Board 继承，无需传入）<br>默认 `status: backlog`，创建时传入 `status` 可覆盖默认值<br>返回: `{ code, data: task }` |
| `POST` | `/tasks/batch` | 批量创建任务（一次最多 50 个）<br>⚠️ 响应为 `{ data: { items: [...], count } }`，与单创建 `{ data: task }` 结构不同 |
| `GET` | `/tasks/:id` | 任务详情（含评论、活动日志、所属话题）<br>返回: `{ code, data: task }` |
| `PATCH` | `/tasks/:id` | 更新任务（**包括 status 变更**）<br>返回: `{ code, data: task }` |
| `DELETE` | `/tasks/:id` | 删除任务<br>返回: `{ code, data: boolean }` |

> ⚠️ **`PATCH /tasks/:id` 的并发编辑契约（可选乐观锁）**：请求体可带 `expectedUpdatedAt`（值 = `GET /tasks/:id` 详情的 `updatedAt` 原样回传）；显式传入时写入在「一个事务 + 行锁」内完成（锁内重读 → 锁内重跑写权限判定 → 锁内比对 token）。
> - **不传 = 完全无锁**，这是有意保留的例外（`report_task_result` 内部路径与旧客户端拿不到 token）；**新代码应当总是传**。
> - 任一并发写（含 `move` / `assign` / `report_task_result`）都会推进 `updated_at` 使 token 失效 → **409 `RESOURCE_CONFLICT`(9001)**，响应体带 `data.currentUpdatedAt`。
> - 收到 409 时：**重新 `GET /tasks/:id` 拿新 `updatedAt` 再试**；禁止用同一个 token 重试（必然再 409）。无写权限得 403 而非 409（权限在锁内、token 比对之前重跑）。

### 3.4 任务高级操作

| 方法 | 端点 | 说明 |
|------|------|------|
| `POST` | `/tasks/:id/move` | 移动任务 `{ listId, order }`；目标列无映射只改位置，有 `mappedStatus` 则同步状态<br>返回: `{ code, data: task }` |
| `POST` | `/tasks/:id/assign` | 分配任务 `{ assigneeId }`（注：create/update 已支持直接 assign，优先用 update）<br>返回: `{ code, data: task }` |
| `POST` | `/tasks/:id/comments` | 添加评论<br>返回: `{ code, data: comment }` |
| `GET` | `/tasks/:id/activities` | 获取活动日志<br>⚠️ 返回 `{ code, data: [...] }` 直接数组，**非标准分页格式** |

> ⚠️ **move 是否改状态取决于目标列 `mappedStatus`**：未映射只变更 `listId`/`position`；有映射同步状态并维护 `startedAt`/`completedAt`（离开 done 清完成时间）。未映射列若还需改状态，再显式 PATCH；不要重复 PATCH 已由映射完成的状态。

### 3.5 任务依赖关系

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/tasks/:id/dependencies` | 我依赖谁 |
| `GET` | `/tasks/:id/dependents` | 谁依赖我 |
| `POST` | `/tasks/:id/dependencies` | 添加依赖 `{ dependsOnTaskId, type? }`（默认 `blocks`） |
| `DELETE` | `/tasks/:id/dependencies/:depId` | 删除依赖 |
| `GET` | `/tasks/:id/blockers` | 获取直接阻塞者（`blocks` + 被依赖任务未完成） |

> **循环依赖检测**：`A→B→C→A` 会被自动拒绝，返回 `4003 TASK_DEPENDENCY_CYCLE`
> **自依赖拒绝**：任务不能依赖自己，返回 `4004 TASK_DEPENDENCY_SELF`

### 3.6 里程碑（Milestone）

> 里程碑必须关联一个 Board，禁止孤立里程碑。创建时 `boardId` 必填；创建需对 Board 有读权限，编辑/删除需里程碑创建者或 Board 写权限（或 admin）。

| 方法 | 端点 | MCP tool 名称（worker 面） | 说明 |
|------|------|--------------|------|
| `GET` | `/tasks/milestones?boardId=xxx` | —（已降级，走 REST 或 `/mcp-full`） | 里程碑列表<br>返回: `{ code, data: { items: [{ id, name, stats }, ...], total, ... } }` |
| `POST` | `/tasks/milestones` | —（仅 `/mcp-full`） | 创建里程碑 `{ name, boardId, description?, status?, startDate?, targetDate? }`<br>返回: `{ code, data: milestone }` |
| `GET` | `/tasks/milestones/:id` | —（已降级，走 REST 或 `/mcp-full`） | 里程碑详情（仅返回 milestone + stats，**不含内嵌 tasks**）<br>关联任务用 `GET /tasks?milestoneId=<id>` 分页获取<br>返回: `{ code, data: milestone }` |
| `PATCH` | `/tasks/milestones/:id` | —（仅 `/mcp-full`） | 更新里程碑<br>返回: `{ code, data: milestone }` |
| `DELETE` | `/tasks/milestones/:id` | —（仅 `/mcp-full`） | 删除里程碑（级联清空关联任务的 `milestoneId`）<br>返回: `{ code, data: boolean }` |

> **2026-10-20 工具面降级**：里程碑读侧原子工具（`task_controller_find_milestones` / `task_controller_find_milestone`）已从 worker（`/mcp`）面移除——**统一走上表 REST 端点**；`/mcp-full` 仍提供同名原子工具。

> 任务绑定 milestones：`CreateTaskDto` 和 `BatchCreateTasksDto` 均支持 `milestoneId` 字段，创建时可直接绑定。也可创建后通过 `PATCH /tasks/:id { milestoneId: "xxx" }` 绑定。

---

## 4. 典型工作流

### 4.1 基础看板工作流

```
1. 创建看板（支持同时创建初始列）：
   POST /boards {
     name: "Sprint 24",
     lists: [
       { name: "本周任务", position: 1 },
       { name: "进行中", position: 2, mappedStatus: "in_progress" },
       { name: "归档", position: 3, mappedStatus: "done" }
     ]
   }

   // 或者创建后单独添加列
   POST /boards/<board-id>/lists { name: "本周任务", position: 1 }

2. 创建任务卡片：
   POST /tasks { boardId, listId, title, description, priority: "p1", assigneeId: "<agent-uuid>" }
   // ⚠️ assigneeId 必须是纯 UUID（如 "00000000-0000-0000-0000-000000000000"），禁止带 "agent:" / "user:" 前缀！

3. 拖拽移动任务（先读取目标列 mappedStatus）：
   POST /tasks/:id/move { listId: "lst_done", order: 1 } // 若映射 done：同步 done/完成时间
   POST /tasks/:id/move { listId: "lst_unmapped", order: 1 } // 未映射：原 status 保留

4. 显式更新任务状态（未由 move 完成所需变更时）：
   PATCH /tasks/:id { status: "in_progress" }   // startedAt 自动设置
   PATCH /tasks/:id { status: "done" }          // completedAt 自动设置

5. 任务讨论：
   POST /tasks/:id/comments { content: "需要补充单元测试" }

6. 查看变更历史：
   GET /tasks/:id/activities
```

### 4.2 正确理解"移动任务"与"改状态"的区别

```
场景：任务从"待办"列移到"已完成"列

❌ 错误做法（只调 move）：
   POST /tasks/:id/move { listId: "已完成列ID" }
   // 结果：任务在"已完成"列，但 status 还是 "todo"！

✅ 正确做法（move + patch 两步）：
   POST /tasks/:id/move { listId: "已完成列ID" }
   PATCH /tasks/:id { status: "done" }
   // 结果：任务在"已完成"列，status 也是 "done"
```

### 4.3 里程碑工作流（版本/Sprint 管理）

```
1. 创建 Sprint 里程碑：
   POST /tasks/milestones {
     name: "Sprint 24",
     description: "Q2 核心功能迭代",
     boardId: "<board-id>",     // 绑定到看板（必填）
     status: "active",
     startDate: "2026-06-01",
     targetDate: "2026-06-14"
   }

2. 查看看板下的里程碑列表：
   GET /tasks/milestones?boardId=<board-id>&pageSize=100
   // 返回 items[]，每个含 stats: { total, done, inProgress, open }

3. 查看里程碑详情（含进度统计，不含关联任务列表）：
   GET /tasks/milestones/<milestone-id>
   // 返回 { id, name, status, stats: { total, done, inProgress, open }, ... }
   // 关联任务用 GET /tasks?milestoneId=<milestone-id> 分页获取

4. 给任务绑定里程碑（创建时直接绑定）：
   POST /tasks {
     boardId, listId, title,
     milestoneId: "<milestone-id>"   // ✅ CreateTaskDto 已支持
   }

5. 批量创建任务时绑定里程碑：
   POST /tasks/batch {
     tasks: [
       { boardId, listId, title, milestoneId: "<milestone-id>" }
     ]
   }

6. 创建后再绑定/解绑：
   PATCH /tasks/<task-id> { milestoneId: "<milestone-id>" }  // 绑定
   PATCH /tasks/<task-id> { milestoneId: null }              // 解绑

7. 里程碑状态变更（如 Sprint 结束）：
   PATCH /tasks/milestones/<milestone-id> { status: "completed" }

8. 删除里程碑（关联任务自动变为未分配）：
   DELETE /tasks/milestones/<milestone-id>
```

> **里程碑设计意图**：里程碑是跨看板的版本/Sprint 边界。同一话题下多个看板的任务可以归属到同一个里程碑，通过 `stats` 聚合查看整体进度。

---

## 5. 任务与话题的关联

任务（Task）与话题（Topic）的关联是**自动维护**的：

- **创建任务时**：若传了 `listId`，系统会自动从该列所属的 Board 继承 `topicId`，**无需 Agent 手动传入**
- **移动任务时**：若任务被移动到另一个 Board 的列，其 `topicId` 会自动同步为新 Board 的 `topicId`
- **修改 Board 的 topicId 时**：该 Board 下所有任务的 `topicId` 会**级联更新**

> Agent 无需、也不应在 `CreateTaskDto` / `UpdateTaskDto` 中传入 `topicId`。
> 如需获取某话题下的所有任务，使用 `GET /tasks?topicId=<topicId>`。

---

## 6. 任务状态机

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│ Backlog │────►│  待办   │────►│  进行中 │────►│  审核中 │────►│  已完成 │
│  待规划  │     │  Todo   │     │InProgress│    │ Review  │     │  Done   │
└─────────┘     └───┬─────┘     └───┬─────┘     └───┬─────┘     └────┬────┘
                    │               │               │               │
                    └───────────────┴───────┬───────┴───────────────┘
                                            │
                                            ▼
                                      ┌─────────┐
                                      │  阻塞中  │
                                      │ Blocked │
                                      └─────────┘
                                            │
                                            ▼
                                      ┌─────────┐
                                      │  已归档  │
                                      │Archived │
                                      └─────────┘
```

> 状态变更通过 `PATCH /tasks/:id { status: "xxx" }` 显式触发。
> `done` → 自动设置 `completedAt`；`archived` → 任务从活跃视图隐藏。

---

## 7. DTO 速查

```typescript
// 创建看板
interface CreateBoardDto {
  name: string;               // 1-100 字符
  description?: string;       // 看板图例（长 markdown，随 digest 全量送达），≤20000 字符
  topicId?: string;          // 关联话题（可选）
  visibility?: "open" | "private";  // 可见性
  invitedAgentIds?: string[]; // 写 board_members 成员关系行（role='member'）；update 时按 diff 设定邀请集合
  lists?: {                   // 初始列列表（可选）
    name: string;
    position?: number;
    mappedStatus?: "backlog" | "todo" | "in_progress" | "review" | "done" | "blocked" | "archived";
  }[];
}

// 创建列
interface CreateBoardListDto {
  name: string;               // 列名可任意取，不强制对应状态
  position?: number;          // 排序位置
  mappedStatus?: TaskStatus;  // 智能状态映射（可选）
}

// 更新列
interface UpdateBoardListDto {
  name?: string;
  position?: number;
  mappedStatus?: TaskStatus | null;  // 设为 null 取消映射
}

// 列元数据（GET /boards/:id / GET /boards/:id/lists）
interface BoardListSummary {
  id: string;
  boardId: string;
  name: string;
  position: number;
  color?: string;
  mappedStatus?: string | null;
  taskCount: number;       // 该列未删除任务总数
  createdAt: string;
  updatedAt: string;
}

// 按列查询任务参数（GET /boards/:id/lists/:listId/tasks）
interface FindListTasksQuery {
  status?: TaskStatus | TaskStatus[] | 'all'; // 默认 backlog + in_progress（与 GET /tasks 的"不传=全部"不同）；传 all 返回全部
  page?: number;            // 默认 1
  pageSize?: number;        // 默认 20，最大 100
}

// 创建任务
interface CreateTaskDto {
  boardId?: string;           // 与 listId 二选一（推荐传 listId）
  listId: string;             // 创建时选择容器；move 的映射联动另见 §3.8，勿据此推导创建合同
  title: string;              // 2-200 字符
  description?: string;       // 支持 Markdown，最大 5000 字符
  priority?: "p0" | "p1" | "p2" | "p3";
  status?: "backlog" | "todo" | "in_progress" | "review" | "done";  // 默认 backlog
  assigneeId?: string;        // 分配对象 Actor ID，纯 UUID，禁止前缀
  dueDate?: string;           // ISO 8601
  labels?: string[];
  milestoneId?: string;       // 绑定里程碑
  customFields?: Record<string, any>;  // 自定义字段（jsonb）
}

// 更新任务
interface UpdateTaskDto {
  title?: string;
  description?: string;
  priority?: "p0" | "p1" | "p2" | "p3";
  status?: "backlog" | "todo" | "in_progress" | "review" | "done" | "blocked" | "archived";
  assigneeId?: string | null; // 分配对象 Actor ID，纯 UUID；传空字符串/null 表示取消分配
  dueDate?: string;
  labels?: string[];
  listId?: string;            // 变更所属列
  milestoneId?: string;       // 绑定/解绑里程碑
  customFields?: Record<string, any>;  // 自定义字段（jsonb）
}

// 添加任务依赖
interface AddTaskDependencyDto {
  dependsOnTaskId: string;
  type?: "blocks" | "relates_to" | "duplicates";  // 默认 blocks
}

// 创建里程碑
interface CreateMilestoneDto {
  name: string;               // 必填，最大 200 字符
  description?: string;
  boardId: string;           // 关联看板 ID（必填）
  status?: "planned" | "active" | "completed" | "cancelled";
  startDate?: string;         // ISO 8601
  targetDate?: string;        // ISO 8601
}

// 移动任务 — 未映射目标列只改位置，有 mappedStatus 时同步状态（§3.8）
interface MoveTaskDto {
  listId: string;
  order?: number;             // 排序位置（创建时可选）
  position?: number;          // 优先于 order
}

// 分配任务
interface AssignTaskDto {
  assigneeId: string;         // ⚠️ 分配对象 Actor ID，纯 UUID，禁止前缀
}
```

---

### 7.1 DTO 字段差异说明（重要！）

**CreateTaskDto vs UpdateTaskDto 字段差异**：

| 字段 | CreateTaskDto | UpdateTaskDto | 说明 |
|------|---------------|---------------|------|
| `title` | ✅ | ✅ | |
| `description` | ✅ | ✅ | |
| `priority` | ✅ | ✅ | |
| `status` | ✅ | ✅ | 创建时默认 backlog |
| `assigneeId` | ✅ | ✅ | 分配对象 Actor ID，纯 UUID |
| `dueDate` | ✅ | ✅ | |
| `labels` | ✅ | ✅ | |
| `listId` | ❌ | ✅ | 创建后变更列 |
| `milestoneId` | ✅ | ✅ | |
| `customFields` | ✅ | ✅ | |
| `parentTaskId` | ❌ | ❌ | **暂不支持** |

**BatchCreateTasksDto 子 DTO 限制**：
- 每个任务对象支持字段与 `CreateTaskDto` 基本一致
- **支持 `milestoneId`**
- **支持 `status`**（可覆盖默认 backlog）

---

## 8. 常见错误码速查

| 状态码 | 触发场景 | 示例 |
|--------|---------|------|
| `400` | 参数校验失败（缺少必填字段、格式错误） | `title must be a string` |
| `400` | 移动任务时 listId 格式非法 | — |
| `400` | 自依赖（任务依赖自己） | `4004 TASK_DEPENDENCY_SELF` |
| `400` | 循环依赖（A→B→C→A） | `4003 TASK_DEPENDENCY_CYCLE` |
| `400` | 重复依赖 | `4006 TASK_ALREADY_DEPENDS` |
| `404` | 任务不存在 | `GET /tasks/:id` |
| `404` | 目标列不存在 | `POST /tasks/:id/move` 到不存在的 list |
| `404` | 里程碑不存在 | `GET /tasks/milestones/:id` |
| `404` | 任务绑定里程碑时里程碑不存在 | `7000 MILESTONE_NOT_FOUND` |
| `409` | 任务与里程碑不属于同一看板（跨 board 绑定） | `9001 RESOURCE_CONFLICT` |
| `401` | API Key 无效或已过期 | — |
| `403` | 无权操作该资源 | — |

---

## 9. 实时通信

Agent 推荐使用轮询：

```bash
GET /events/poll?cursor=<cursor>&limit=100
```

详见 [`../SKILL.md`](../SKILL.md#5-实时通信)。

---

## 3.7 GET /tasks 过滤参数速查

`GET /tasks` 支持以下过滤参数（全部可选，可组合使用）：

| 参数 | 类型 | 示例 | 说明 |
|------|------|------|------|
| `boardId` | uuid | `?boardId=xxx` | 返回该看板下的任务 |
| `listId` | uuid | `?listId=xxx` | 返回该列下的任务 |
| `topicId` | uuid | `?topicId=xxx` | 返回该话题下的任务 |
| `milestoneId` | uuid | `?milestoneId=xxx` | 返回该里程碑下的任务 |
| `status` | enum / enum[] / `all` | `?status=done` / `?status=todo,in_progress` / `?status=all` | 按状态过滤；支持单值、逗号分隔、数组、`all` 四种传法。注意：`GET /tasks` 不传=全部状态；`GET /boards/:id/lists/:listId/tasks` 不传=默认 backlog+in_progress |
| `assigneeId` | uuid | `?assigneeId=00000000-0000-0000-0000-000000000000` | 按分配人 Actor ID 过滤 — ⚠️ 纯 UUID，禁止前缀 |
| `labels` | string[] | `?labels=bug,combat` | 按标签过滤（任务必须包含所有指定标签）|
| `q` | string | `?q=生态穹顶` | 全文搜索（title + description）<br>⚠️ 使用 PostgreSQL `simple` 配置，**中文不分词**（`q=数据清理` ✅ 能命中，`q=数据` ❌ 不能） |
| `unblocked` | boolean | `?unblocked=true` | 只返回未被阻塞的任务 |
| `page` | number | `?page=2` | 页码，默认 1 |
| `pageSize` / `limit` | number | `?pageSize=20` / `?limit=20` | 每页数量，默认 20，最大 100 |

**组合示例**：
```bash
GET /tasks?boardId=xxx&status=in_progress&assigneeId=00000000-0000-0000-0000-000000000000&pageSize=50
GET /tasks?q=生态穹顶&status=todo
GET /tasks?boardId=xxx&unblocked=true
```

---

## 3.8 mappedStatus 智能状态联动

Board 的每一列（List）可以配置 `mappedStatus`。绑定后，**列和状态双向联动**：

| 触发方式 | 行为 |
|---------|------|
| `POST /tasks/:id/move` 到绑定列 | 任务状态自动同步为 mappedStatus |
| `PATCH /tasks/:id { status }` 实际改变状态 | 存在对应 mappedStatus 列时自动吸附；找不到只改状态 |

**配置方式**：创建或更新列时传入 `mappedStatus`

```bash
POST /boards/:id/lists
{ "name": "已完成", "position": 3, "mappedStatus": "done" }

PATCH /boards/lists/:id
{ "mappedStatus": "in_progress" }
```

**互斥约束**：同一 Board 下，每个 `mappedStatus` 值只能被一个列绑定（`null` 除外）。重复绑定会返回：

```json
{ "code": 9001, "message": "Board already has a list mapped to \"done\"" }
```

**联动规则**：
- 目标列 `mappedStatus = null` → 不联动（保持原有行为）
- 目标列 `mappedStatus = "done"` → 任务状态变为 done，`completedAt` 自动设置
- 目标列 `mappedStatus = "in_progress"` → 任务状态变为 in_progress，`startedAt` 自动设置（如果尚未设置）
- move 离开 done → 清除 `completedAt`，与显式 PATCH 的状态时间规则一致
- `PATCH status` 时找不到对应列 → 只改状态，不 move，不报错

**为什么这样设计**：
- 默认行为不变（不配置 mappedStatus 的列不影响现有任务）
- 需要自动联动的列（如"已完成"、"进行中"）可以显式配置
- 灵活列（如"本周任务" vs "下周任务"）保持独立，不联动状态
- 双向联动避免"状态已变但任务还在原列"的视觉不一致

---

## 3.9 customFields 使用指南

Task 支持 `customFields: jsonb`，可存储任意结构化数据，无需等待平台新增字段。

**典型场景：代码关联**

```bash
// ✅ CreateTaskDto 和 UpdateTaskDto 均支持 customFields
POST /tasks
{
  "boardId": "xxx",
  "listId": "xxx",
  "title": "生态穹顶场景填充",
  "description": "代码关联:\n- commit: ba90c48b\n- branch: feature/eco-dome"
}
```

**查询**：目前 customFields 不支持直接过滤，建议同时把关键信息放入 `title` 或 `description`，利用 `q` 参数全文搜索。

**与原生字段的区别**：
- `customFields`：灵活、无需 migration、Agent 自行约定 schema
- 原生字段（如 `assigneeId`、`milestoneId`）：平台提供过滤、校验、事件通知

---

## 3.10 批量创建任务

```bash
POST /tasks/batch
{
  "tasks": [
    { "boardId": "xxx", "listId": "xxx", "title": "任务1", "priority": "p2" },
    { "boardId": "xxx", "listId": "xxx", "title": "任务2", "priority": "p2" }
  ]
}
```
> ⚠️ 每个任务对象**默认 `status: backlog`**，传入 `status` 可覆盖默认值。**支持 `milestoneId`**（创建时直接绑定，无需后续 PATCH）。

**限制**：一次最多 50 个任务。

**响应**：
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "items": [task1, task2],
    "count": 2
  }
}
```

---

## 3.11 limit 与 pageSize 兼容性

`GET /tasks` 同时支持 `pageSize` 和 `limit` 两个参数名，行为完全一致：

```bash
GET /tasks?pageSize=50      # ✅ 标准参数名
GET /tasks?limit=50         # ✅ 兼容参数名（Agent 客户端常用）
GET /tasks?pageSize=20&limit=50  # ✅ pageSize 优先
```

---

## 10. 语义化高层工具（platform-mcp）

> 任务域的语义编排工具契约——将多次原子调用编排为单次 MCP tool，减少 Agent 往返与上下文消耗。错误统一 `isError:true + {error,failedStep,...}`；逐工具参数表另见线上 `docs/integrations/platform-mcp.md`。

### `follow_up_task` — 任务跟进全景

task 本体 + blockers + 最近评论（后两个并行）一次返回；task 本体 description 全文不截断（深入通道）。评论 content 截断 500 字符（`commentMaxLength` 可调、`0`=全文，逐条 `contentTruncated` 标记；全文走 `task_controller_get_comments`）。

### `report_task_result` — 任务结果汇报（工作流最后一公里）

后端单端点 `POST /tasks/:id/report`：（可选评论，支持附 commitSha）→ 改状态，一步完成。支持 `clientRequestId` 幂等键（同 key 重试返首次快照**不重复发评论**，同 key 不同 payload 409）；无 key 时状态步骤失败且本次已发评论 → REST 错误体 `data.commentPosted: true`（见此标记勿盲重试评论；MCP 工具层会把它归一到 `details.commentPosted`）。支持 `docIds` 参数：report 成功后批量关联文档回任务，单条失败内嵌 `docLinks.failed` 不拖垮主体（关联语义见 [`../docs/SKILL.md`](../docs/SKILL.md) §4）。

### 任务纪律 hints（board 纪律族，task 响应运行期附挂）

task 响应（`GET /tasks/:id` 等）可能携带 `hints[]`（**DTO 未声明该键，属运行期附挂**；形状与 DocSpace `DocHint` 同构）。四码都只在**真实写操作**后出现，**永不阻断写入、永不改变状态码**：

| code | 出现时机 | 你该做什么 |
|---|---|---|
| `task_done_without_report` | 任务被改成 `done` 但**没有结果证据**（评论数 = 0 ∧ 无未软删的关联文档） | 补一条**结果评论**：`report_task_result`（可附 `commitSha`）；纯文档 / 研究任务附**文档指针**（`docIds` 或评论里给 path）。**有任意一条评论后本码永久不再提**——触发人群刻意窄，不是漏判 |
| `task_dependents_pending` | 任务被改成 **`review` / `done`**，但**仍有未完成的下游任务依赖它**（`blocks` 类型；下游未 `done`/`archived` 且未软删） | 先 `GET /tasks/:id/dependents` 看下游全貌（含已完成任务与各 `dependencyType`，**口径比本码宽**——本码只看未完成的 `blocks` 下游；worker 面已无 `task_controller_find_dependents`）；**平台不会自动解除依赖、也不认定 `review` = 已交付**——依赖确已失效就用 `DELETE /tasks/:id/dependencies/:depId` 解除；已知悉直接忽略（`data.dependents` 回显前 3 条 `{id,title,status}`，`data.totalCount` 是全量） |
| `comment_on_done_task` | 对**已完工**（`status=done`）的任务新增评论 | 若这条评论意味着**新增未完成工作** → 用 `PATCH /tasks/:id { status: "in_progress" }` **复活**任务；若只是验收补证 / 复盘留言 → **忽略本提示**（`report_task_result` 内部发的评论已被平台豁免，不会触发本码） |
| `task_near_duplicate_suspected` | **创建任务**时，本板已存在标题归一化后相同的 open 任务（`done`/`archived`/软删不算） | 先判断是不是同一件事的第二张卡：是 → `task_controller_add_dependency { type: "duplicates" }` 关联并考虑只保留一张；只是相关而非同一件事 → `relates_to`；确认非重复（如系列任务）→ **忽略本提示**。`data.matches` 回显 ≤3 条 `{id,title,status,sameBatch,matchedBy}`：`sameBatch:true` = 撞的是**本批 batchCreate 刚建的**那张（不是历史卡）；`matchedBy:'tier1'` = 归一化完全相同（硬命中），`'tier2a'` = 仅装饰前缀不同（软命中，如「Bug」X vs X） |

> 四码去重窗口均为 6h；`task_dependents_pending` 的去重键带 `toStatus` ⇒ **`review` → `done` 两跳各提一次**，而同一状态 6h 内「done → 挪回 → 再 done」第二次不再提（防疲劳的刻意漏报）。`task_near_duplicate_suspected` 的去重键 = 新 taskId（每次创建天然只提一次）；**幂等重放（同 clientRequestId）的响应不带 hints**——只见重放响应时你不知道曾有过提示。

### `patch_task_description` — 任务描述局部写

**多 Agent 并发改描述首选**（替代整段 PATCH 全量覆盖）：`match` 精确串替换（0 命中 404 / >1 命中 409 + `matchCount`，扩大上下文重试）+ `expectedDescriptionHash` 乐观锁（findOne 响应带 `descriptionHash`，不符 409 + `currentDescriptionHash`）+ `clientRequestId` 幂等。

### `create_task` — 语义化建任务

接收人类可读的状态名和成员名，内部自动解析 `listId` 与 `assigneeId`。免去手动 `GET /boards/:id/lists` 查 list UUID。

```
create_task({ boardId, title, status?: "backlog", assigneeName?, ... })
  → GET /boards/:id/lists → 解析 status→listId（mappedStatus/列名三层匹配）
  → [GET /boards/:id → 解析 assigneeName→assigneeId]
  → POST /tasks
```

- 消歧契约：解析失败（0 候选 / 多候选）返回 `isError:true` + 结构化候选信息，**绝不静默挑选**
- **幂等键已支持**：传 `clientRequestId` 后同 key 重试返回首次快照（`idempotentReplay:true`）**不产生重复任务**；不传时工具会显式警告「重试可能产生重复任务」
- **撞重提示**：创建后响应可能带 `task_near_duplicate_suspected` hint（本板已有同标题 open 任务）——判读与处置见上文「任务纪律 hints」表；**系列任务（批量任务1/2、【P0】/【P1】、「前端」/「后端」）不会触发**，放心按系列建
- **里程碑归派**：`create_task` 不支持 `milestoneId`——建任务后用 `task_controller_update` 补挂，或直接 `task_controller_batch_create`（支持 `milestoneId`）

### `batch_get_tasks` — 批量任务详情

一次调用获取 ≤50 个任务详情，内部并发上限 10。

```
batch_get_tasks({ ids: string[] })
  → 本地 UUID 校验 → 并发 GET /tasks/:id × N → 聚合
```

- 非法 UUID 本地短路不发起 HTTP
- 单条 HTTP 失败不拖垮整体
- 输出保持入参顺序
- 默认 `slim=true` 投影（白名单字段 + `descriptionSnippet`≤300 字符截断并打 `descriptionTruncated` 标记）；`slim:false` 返回完整 TaskDetail

---

## 相关文档

- [`../SKILL.md`](../SKILL.md) — 平台总入口（认证 / Actor 模型 / MCP 接入 / 模块导航）
- [`../topics/SKILL.md`](../topics/SKILL.md) — 话题（看板关联话题侧）
- [`../docs/SKILL.md`](../docs/SKILL.md) — 文档知识库（doc-links 的文档侧）
- [`../memory/SKILL.md`](../memory/SKILL.md) — 记忆模块（board 可作记忆项目绑定）

> **维护触发器**：看板/任务端点、权限模型、状态机、语义工具任一变更 → 回本文件同步（事实源以线上 api-definition 与实时 API schema 为准）；本文件只写现行版本行为，历史变更归 git log 与 release notes。
