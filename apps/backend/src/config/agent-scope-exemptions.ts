/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - API Key scopes 的**豁免清单单源**：被 `@AgentScope('read')` 显式降级为"只需 read"
 *     的端点集合（2026-10-16 卡 72566c2e）
 *
 * [代码职责]
 *   - 只声明清单数据；机器强制在 `agent-scope-exemptions.spec.ts`（扫源码双向相等断言）
 *   - 本文件是**唯一**能新增 scope 豁免的地方：新增一行 ⇒ 必须同时在目标 controller
 *     方法上标 `@AgentScope('read')`，否则 spec 红（多一个/少一个都红）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.1 —— scope 语义表 + 豁免面说明
 *
 * [关键不变量]
 *   - **双向相等**：源码中 `@AgentScope('read')` 的集合 ↔ 本清单，严格相等。
 *   - **豁免只降不升**：本清单是"降低门槛"的唯一入口，且每条必须写明理由；任何"绕过
 *     守卫"的写法（路径字符串白名单、方法白名单、decorator 级 skip）一律禁止。
 *   - 条目必须能机器校验：`method` / `path` / `source` / `handler` 四元组与源码中
 *     decorator 的实际位置严格一致（路径写错同样红）。
 *
 * [关联代码]
 *   - ../common/guards/api-key-scope.guard.ts — 唯一执行方
 *   - ../common/decorators/agent-scope.decorator.ts — 标注载体
 *   - ./agent-scope-exemptions.spec.ts — 双向相等 + 非常规方法面断言
 *
 * [修改检查]
 *   □ 新豁免必须有"该端点是读语义"的论证（副作用是否持久化？是否有独立鉴权？）
 *   □ 已同步目标 controller 的 `@AgentScope('read')` 标注
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */

/**
 * 一条 scope 豁免（四元组必须与源码 decorator 位置严格一致）。
 */
export interface AgentScopeExemption {
  /** HTTP 方法（大写，与 controller 上的 `@Post/@Get` 一致） */
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 路由路径模板（含 `:param`，controller 前缀已在内；仅作文档与机器比对用） */
  path: string;
  /** 仓库相对源文件路径 */
  source: string;
  /** handler 方法名（源码扫描的锚点） */
  handler: string;
  /** 豁免理由（为什么它只算 read） */
  reason: string;
}

/**
 * 初始豁免清单（5 条，2026-10-16 卡 72566c2e，三视角逐条裁定通过）。
 *
 * 每条的理由必须回答两问：
 *  (a) **为什么它是读语义**——本端点对调用方而言是否只是"取回信息/推进读游标"？
 *  (b) **写副作用是否安全**——若确有持久化写，其授权是否独立于本 scope、是否可被本
 *      scope 的持有者滥用？
 */
export const AGENT_SCOPE_READ_EXEMPTIONS: readonly AgentScopeExemption[] = [
  {
    method: 'POST',
    path: '/memory/projects/:id/recalls',
    source: 'apps/backend/src/modules/memory/memory.controller.ts',
    handler: 'recall',
    reason:
      '读语义（召回）。telemetry 写副作用无条件执行（memory-recall.service.ts 落 recall 遥测行，' +
      '与调用方 scope 无关）；限流已按 F4 项3 闭合为双桶——default 每 IP 300/min（拦洪）+ ' +
      'actor 每身份 30/min（公平，头带 -actor 后缀），测试环境放宽，阈值另有 env 逃生口' +
      '（memory.controller.ts 顶层常量）。',
  },
  {
    method: 'POST',
    path: '/doc-spaces/:id/diagrams/validate',
    source: 'apps/backend/src/modules/docspace/diagram.controller.ts',
    handler: 'validateDiagram',
    reason:
      'dry-run 零副作用（不落 doc 行 / 不写版本 / 不发事件），且 path 与 docId 两条 locator ' +
      '通道都受 path spaceId 约束（diagram.controller.ts 的 ensureCan read + ' +
      'DocService.findByIdInSpace 作用域解析）：跨空间 docId 一律 404 DOC_NOT_FOUND，' +
      '与"文档不存在"同文同码（有单测机器守卫该契约）。',
  },
  {
    method: 'POST',
    path: '/attachments/:id/signed-url',
    source: 'apps/backend/src/modules/attachments/attachment.controller.ts',
    handler: 'mintSignedUrl',
    reason:
      'mint 内部含独立读授权（attachment-signed-url.service.ts），即豁免授出的恰是调用方**已有**读权限的' +
      '资源；另有 TTL ≤3600s + 30/min/IP 限流 + MINT_ATTACHMENT_URL 审计。' +
      '⚠️ 已知窗口：吊销 key 不使**已铸出**的短时 URL 失效（最长 3600s），属接受风险（docs/api-definition.md §2.1 已写明）。',
  },
  {
    method: 'POST',
    path: '/topics/:id/read',
    source: 'apps/backend/src/modules/topic/topic.controller.ts',
    handler: 'markAsRead',
    reason:
      '已读游标推进 = 读语义的组成部分（其鉴权本就按 read 判，topic.controller.ts 的 ensureCan read）；' +
      '不豁免则只读 key 下 get_topic_digest 静默退化（读得到消息却清不掉未读）。',
  },
  {
    method: 'POST',
    path: '/system/usage-events',
    source: 'apps/backend/src/modules/usage-stats/usage-events.controller.ts',
    handler: 'reportUsageEvent',
    reason:
      'automcp 以调用方自己的 key 上报（fire-and-forget，fire 后即忘）。actorId 只取认证上下文' +
      '（usage-events.controller.ts），故"自报"不可伪造他人身份；端点自述非审计面。' +
      'viaFallbackAuth 仅 API Key 认证时生效（bearer/JWT 通道服务端强制为 false）。' +
      '不豁免 = 只读 key 的遥测静默丢失。',
  },
];

/**
 * **显式不豁免**名单（钉死在此，防止后续被"顺手豁免"）。
 *
 * 判据：这些端点有**持久化写副作用**或**对外副作用**，且调用方未必在读语义下就该有写权：
 * - `POST /doc-spaces/:id/routes/recheck`、`POST /docs/:id/link-health/recheck`：持久化写（重算并落库）
 * - `POST /webhook/test`：外呼（SSRF 邻域）
 * - `POST /notification-settings/.../test`：外发 IM
 * - `POST /memory/nominations/:id/retry`、`POST /memory/projects/:id/recover`：驱动引擎作业
 *
 * 本名单只是**注释性登记**，机器强制来自"双向相等"——任何新增的 `@AgentScope('read')`
 * 都会让 spec 红，从而强制在评审中显式表态。
 */
export const AGENT_SCOPE_READ_NOT_EXEMPT: readonly string[] = [
  'POST /doc-spaces/:id/routes/recheck（持久化写）',
  'POST /docs/:id/link-health/recheck（持久化写）',
  'POST /webhook/test（外呼 / SSRF 邻域）',
  'POST /notification-settings/.../test（外发 IM）',
  'POST /memory/nominations/:id/retry（驱动引擎作业）',
  'POST /memory/projects/:id/recover（驱动引擎作业）',
];

/**
 * **显式判定记录**：经过审议后**保持 write** 的争议端点。
 *
 * 双向相等断言会强制任何新增端点显式表态；这两族是最容易被误认为读语义的候选，故把
 * 结论连同理由固化成数据（评审可查，而不是散落在某次对话里）：
 * - `POST /agents/:id/heartbeat`：`lastActiveAt` 已在**每次认证**时刷新
 *   （api-key-auth.service.ts），心跳不承担"保活"职责，其真实写入是 agent_heartbeats
 *   全列快照 upsert（持久化写）⇒ keep write。
 * - `POST /topics/:id/join|leave`：OPEN 话题的读取不需要 join（可见性即可读）；
 *   join 的真实效果是写 topic_participants 行 + 触达未读游标 ⇒ keep write。
 */
export const AGENT_SCOPE_WRITE_DECIDED: readonly string[] = [
  'POST /agents/:id/heartbeat（lastActiveAt 已在每次认证刷新；心跳本体是持久化 upsert）',
  'POST /topics/:id/join（participant 行写入；OPEN 话题读取不需要 join）',
  'POST /topics/:id/leave（participant 行写入）',
];
