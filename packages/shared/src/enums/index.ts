export enum UserRole {
  ADMIN = 'admin',
  EDITOR = 'editor',
}

export enum AgentStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
  PENDING = 'pending',
}

export enum ApiKeyStatus {
  ACTIVE = 'active',
  REVOKED = 'revoked',
}

/**
 * 话题状态（2026-08-31 死契约清理：删除 DRAFT/VOTING——topic 现实定位 = 常驻聊天室，
 * create 恒写 ACTIVE，draft/voting 无入口死状态；生产实证 10 个 topic 全部 active。
 * 流转矩阵见 topic.service.ts TOPIC_STATUS_TRANSITIONS）
 */
export enum TopicStatus {
  OPEN = 'open',
  ACTIVE = 'active',
  PAUSED = 'paused',
  CLOSED = 'closed',
  ARCHIVED = 'archived',
}

export enum Visibility {
  OPEN = 'open',
  PRIVATE = 'private',
}

export enum MessageType {
  CHAT = 'chat',
  PROPOSAL = 'proposal',
  VOTE = 'vote',
  TASK = 'task',
  SYSTEM = 'system',
  ARTIFACT = 'artifact',
  STATUS_UPDATE = 'status_update',
  THINKING = 'thinking',
}

export enum TaskStatus {
  BACKLOG = 'backlog',
  TODO = 'todo',
  IN_PROGRESS = 'in_progress',
  REVIEW = 'review',
  DONE = 'done',
  BLOCKED = 'blocked',
  ARCHIVED = 'archived',
}

export enum TaskDependencyType {
  BLOCKS = 'blocks',
  RELATES_TO = 'relates_to',
  DUPLICATES = 'duplicates',
}

/**
 * 里程碑状态（v1.42 起扩展为 Release 载体，普通里程碑与 Release 里程碑共存一枚举）
 * - 普通生命周期：planned → active → completed / cancelled（version 为空时使用）
 * - Release 生命周期：dev → ready → deployed → verified（version 非空时使用，流转矩阵见
 *   docs/spec.md §3.2 MilestoneStatus；dev/ready 可直落 cancelled，deployed 只能经
 *   POST /tasks/milestones/:id/deployed 写入，verified 为终态）
 * - 两类生命周期由 MilestoneService 流转矩阵隔离：version 非空禁落普通态，
 *   version 为空禁落 Release 四态（cancelled 为共享终态）
 */
export enum MilestoneStatus {
  PLANNED = 'planned',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  /** Release 生命周期初始态（create 带 version 时的缺省状态） */
  DEV = 'dev',
  /** 可发布候选（等待部署） */
  READY = 'ready',
  /** 已部署（只能经 deployed 端点写入，PATCH 一律 400） */
  DEPLOYED = 'deployed',
  /** 已验收（终态，前置 status=deployed） */
  VERIFIED = 'verified',
}

export enum Priority {
  P0 = 'p0',
  P1 = 'p1',
  P2 = 'p2',
  P3 = 'p3',
}

export enum EventType {
  NEW_MESSAGE = 'new_message',
  TASK_UPDATE = 'task_update',
  MENTION = 'mention',
  TOPIC_STATUS_CHANGE = 'topic_status_change',
  SYSTEM = 'system',
  AGENT_JOINED = 'agent_joined',
  AGENT_LEFT = 'agent_left',
  TASK_ASSIGNED = 'task_assigned',
  /** DocSpace 文档事件 */
  DOC_CREATED = 'doc_created',
  DOC_UPDATED = 'doc_updated',
  DOC_DELETED = 'doc_deleted',
  /** v1.60.0-dev：原子 move（同 docId 改 path，保留引用面） */
  DOC_MOVED = 'doc_moved',
}

/**
 * 事件资源类型（events.resourceType 值域；review-0831 任务 8fab2a9d 枚举化）
 * - 与 EventType 同等级的外部契约字段（events/SSE API 载荷顶层），此前无枚举保护；
 *   全仓 eventService.create 调用点实测取值集合 = {task, topic, message, board, doc}。
 * - ⚠️ 与 audit.entityType（开放 free varchar，写入侧已知取值清单 AUDIT_ENTITY_TYPES）
 *   是两套词汇：audit 专有值（board_list/board_member/topic_participant 等）不入本枚举。
 * - DTO 校验保持 @IsString() 开放（外部契约不变），本枚举供内部写入点命名引用。
 */
export enum ResourceType {
  TASK = 'task',
  TOPIC = 'topic',
  MESSAGE = 'message',
  BOARD = 'board',
  DOC = 'doc',
}

export enum ActorType {
  HUMAN = 'human',
  AGENT = 'agent',
  SYSTEM = 'system',
}

export enum ActivityAction {
  CREATED = 'created',
  UPDATED = 'updated',
  MOVED = 'moved',
  ASSIGNED = 'assigned',
  COMMENTED = 'commented',
  STATUS_CHANGED = 'status_changed',
}

export enum AuditAction {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LOGIN = 'login',
  LOGOUT = 'logout',
  RESET_API_KEY = 'reset_api_key',
  TOGGLE_AGENT = 'toggle_agent',
  PAUSE_TOPIC = 'pause_topic',
  RESUME_TOPIC = 'resume_topic',
  /** v1.60.0-dev：文档原子移动（verb_noun 风格对齐 reset_api_key/pause_topic 先例） */
  MOVE_DOC = 'move_doc',
  /**
   * v1.75.0-dev：附件短时签名 URL 铸造（P2 批 2，verb_noun 同款）——
   * audit_logs.action 是 PG 原生枚举，补值需 migration
   * `AddAuditMintAttachmentUrlAction1789205400000`（缺值写入报
   * `invalid input value for enum audit_action` 500）。
   * newData 只记 {variant, ttlSeconds, expiresAt}，**禁含 token**（能力凭证不进审计）。
   * 铸造可安全重试（每次新 token，无副作用），审计行随之逐次留痕。
   */
  MINT_ATTACHMENT_URL = 'mint_attachment_url',
  /**
   * v1.90.0-dev：topic 删除连带软删其全部附件（附件 TTL 批，verb_noun 同款）——
   * `TopicService.remove()` 在同一事务里批量软删 `topic_id = :id` 的附件行后，
   * 写**一条汇总** audit（逐行写太噪）：newData = {topicId, count}。
   *
   * ⚠️ `audit_logs.action` 是 PG 原生枚举，补值需 migration
   * `AddAuditCascadeDeleteAttachmentsAction1791500000001`（与 MINT_ATTACHMENT_URL
   * 同款先例；缺值写入报 `invalid input value for enum audit_action` 500）。
   *
   * 单附件 DELETE 端点的既有 audit（action='delete'）不变；本动作只覆盖连带路径。
   */
  CASCADE_DELETE_ATTACHMENTS = 'cascade_delete_attachments',
  /**
   * v1.92.0-dev：存量 tag rename/merge 批量改写（DocSpace 元数据治理 3 期，verb_noun
   * 同款）。`DocRenameService.renameTags` 单事务批量替换 docs.tags + 词表 alias 声明后，
   * 事务**外** fail-open 写**一条汇总** audit（逐文档写太噪）：entityType=doc_space /
   * entityId=spaceId；newData = {from,to,affectedCount,affectedDocIds,ingestAffectedIds,
   * vocabularyChanges}；oldData = {token, docs:[{id,tags}]} 即**可恢复性载荷**
   * （回滚 = 按 oldData 反向 rename）。dryRun 不写审计。
   *
   * ⚠️ `audit_logs.action` 是 PG 原生枚举，补值需 migration
   * `AddAuditRenameMergeDocActions1791600000000`（同款先例；缺值写入报
   * `invalid input value for enum audit_action` 500）。
   */
  RENAME_DOC_TAGS = 'rename_doc_tags',
  /**
   * v1.92.0-dev：DocCategory merge（DocSpace 元数据治理 3 期，verb_noun 同款）。
   * `DocRenameService.mergeCategory` 单事务把 source 分类下文档重指向 target +
   * doc_routes.category 自由文本改写 + settings.overviewFilter.excludeCategories
   * 修正 + 软删 source 后，事务外 fail-open 写一条汇总 audit：entityType=doc_category /
   * entityId=sourceCategoryId。migration 同 RENAME_DOC_TAGS。
   */
  MERGE_DOC_CATEGORY = 'merge_doc_category',
}

export enum WebhookStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
}

/**
 * 话题参与者状态
 * - invited: 已被邀请但尚未 join
 * - active: 活跃参与者（已 join）
 * - left: 已离开/被移除（保留历史行）
 */
export enum ParticipantStatus {
  INVITED = 'invited',
  ACTIVE = 'active',
  LEFT = 'left',
}

/**
 * 看板成员角色
 * - editor: 可编辑看板内容（列/任务）
 * - member: 只读访问
 */
export enum BoardMemberRole {
  EDITOR = 'editor',
  MEMBER = 'member',
}

/**
 * DocSpace 成员角色（doc_space_members.role 值域；review-0831 任务 a8a295df 枚举化）
 * - editor: 可编辑空间内容（文档/分类），由 addEditor 授予，或 create() 时 creator 自动写入
 * - member: 只读访问，由 inviteAgent 授予
 * creator 行约定：role='editor' 且 invitedBy=null（非授予产生），removeEditor/uninviteAgent
 * 对 creator 拒绝操作。值域与 BoardMemberRole 相同但语义独立（docspace 成员体系专属枚举，
 * 此前 service 裸字面量 + 借用 BoardMemberRole 比较，见 docspace.service.ts）。
 * role 列是裸 varchar(20)，新增枚举值无需 migration
 */
export enum DocSpaceMemberRole {
  EDITOR = 'editor',
  MEMBER = 'member',
}

/**
 * 话题参与者角色（v1.46 TOPIC-PERM 新增 editor，对齐 Board/DocSpace）
 * - moderator: 创建者行标记（topic_participants 中 creator 的 role，历史约定）
 * - editor: 可编辑话题内容字段（title/description）；结构字段/状态流转/成员管理仍 creator-only
 * - member: 普通参与者（只读 + 发言）
 * role 列是裸 varchar(30)，新增枚举值无需 migration
 */
export enum TopicParticipantRole {
  MODERATOR = 'moderator',
  EDITOR = 'editor',
  MEMBER = 'member',
}

export enum ErrorCode {
  // HTTP 基础映射
  SUCCESS = 200,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  RATE_LIMITED = 429,
  INTERNAL_ERROR = 500,

  // 认证/授权 (1000-1999)
  AGENT_DISABLED = 1001,
  TOPIC_PAUSED = 1002,
  INVALID_API_KEY = 1003,
  TASK_NOT_ASSIGNED = 1004,
  TOPIC_CLOSED = 1005,
  AGENT_NOT_IN_TOPIC = 1006,
  TOKEN_EXPIRED = 1007,
  TOKEN_INVALID = 1008,
  PERMISSION_DENIED = 1009,
  /** 404 — 目标 actor（人/agent 统一 actors 行）不存在：DocSpace creator 转让等按 actor 寻址的操作 */
  ACTOR_NOT_FOUND = 1010,
  /**
   * 403 — 本次认证所用 API Key 的 scopes 不足以执行该操作（API Key scopes 执行面）。
   * 判定单源 = `apps/backend/src/common/utils/api-key-scope.ts`；守卫 =
   * `common/guards/api-key-scope.guard.ts`（APP_GUARD）。fail-closed：scopes 缺失/非数组/
   * 空数组/含未知值一律拒。必须是**数字**枚举成员——all-exceptions.filter 只在
   * `typeof resObj.code === 'number'` 时透传业务码，否则静默降级为 FORBIDDEN(403)。
   */
  AGENT_SCOPE_INSUFFICIENT = 1011,

  // Topic (2000-2099)
  // ⚠️ 2001（TOPIC_ALREADY_CLOSED）/ 2003（TOPIC_CANNOT_SEND_MESSAGE）/ 4002（TASK_MOVE_INVALID_LIST）
  //    已退役（2026-08-31 死契约清理），编号永不复用——占位防复用
  TOPIC_NOT_FOUND = 2000,
  TOPIC_ALREADY_ARCHIVED = 2002,

  // Message (2100-2199)
  MESSAGE_NOT_FOUND = 2100,
  MESSAGE_CANNOT_DELETE = 2101,
  TOPIC_MESSAGE_NOT_FOUND = 2102,

  // Board/List (3000-3099)
  BOARD_NOT_FOUND = 3000,
  LIST_NOT_FOUND = 3001,
  LIST_NOT_EMPTY = 3002,

  // Task (4000-4099)
  TASK_NOT_FOUND = 4000,
  TASK_STATUS_INVALID = 4001,
  TASK_DEPENDENCY_CYCLE = 4003,
  TASK_DEPENDENCY_SELF = 4004,
  TASK_DEPENDENCY_NOT_FOUND = 4005,
  TASK_ALREADY_DEPENDS = 4006,

  // Milestone (7000-7099)
  MILESTONE_NOT_FOUND = 7000,
  MILESTONE_NAME_EXISTS = 7001,
  /** 400 — 状态流转非法（含 version 与状态类别不匹配、前置态不满足） */
  MILESTONE_INVALID_TRANSITION = 7002,
  /** 400 — deployed 只能经 POST /tasks/milestones/:id/deployed 写入，PATCH 一律拒绝 */
  MILESTONE_DEPLOY_VIA_ENDPOINT = 7003,
  /** 409 — 同 board 内 version 重复（部分唯一索引 uq_milestones_board_version 23505） */
  MILESTONE_VERSION_CONFLICT = 7004,

  // Agent (5000-5099)
  AGENT_NOT_FOUND = 5000,
  AGENT_NAME_EXISTS = 5001,

  // User (6000-6099)
  USER_NOT_FOUND = 6000,
  USER_EMAIL_EXISTS = 6001,
  USER_PASSWORD_INVALID = 6002,

  // Skill (8000-8099)
  SKILL_NOT_FOUND = 8000,

  // 通用业务 (9000-9099)
  VALIDATION_ERROR = 9000,
  RESOURCE_CONFLICT = 9001,
  /** 409 — 幂等键冲突：同 clientRequestId 但 request_hash 不符（payload 与首次请求不同），拒绝重放（v1.63.0 DocSpace 写族） */
  IDEMPOTENCY_KEY_CONFLICT = 9002,

  // DocSpace (10000-10099)
  DOC_SPACE_NOT_FOUND = 10000,
  DOC_NOT_FOUND = 10001,
  DOC_CATEGORY_NOT_FOUND = 10002,
  /** 409 — 只读来源或 source 冲突 */
  DOC_SOURCE_MISMATCH = 10003,
  DOC_LINK_NOT_FOUND = 10004,
  /** 400 — doc_routes 写时校验：primary/secondary doc 不存在、已软删或不属于该空间 */
  DOC_ROUTE_DOC_NOT_FOUND = 10005,
  /** 400 — doc_routes 写时校验：headingPath 非空但未精确命中该 doc 的 doc_sections.heading_path */
  DOC_ROUTE_HEADING_UNRESOLVED = 10006,
  /** 400 — doc_routes 写时校验：codeEntry 超长、绝对路径或含 `..` 段 */
  DOC_ROUTE_INVALID_CODE_ENTRY = 10007,
  /** 404 — doc_routes 目标路由不存在 */
  DOC_ROUTE_NOT_FOUND = 10008,
  /** 409 — 文档写前提校验失败（stale expectedContentHash / expectedSectionHash，调用方须重读后重试） */
  DOC_CONTENT_CONFLICT = 10009,
  /** 422 — Diagram IR 校验/渲染门不过（parse/schema/render/composition 阶段），data 带 {stage, diagnostics[]} 修复凭据 */
  DIAGRAM_VALIDATION_FAILED = 10010,
  /** 422 — diagram JSON patch 应用失败（指针不存在/类型不符/根操作），data 带 {pointer, reason, supportedOps} */
  DIAGRAM_PATCH_FAILED = 10011,
  /** 400 — markdown 写通道触及 diagram doc（patch_section/patch_match/append/metadata docType 双向转换）或图工具命中非 diagram doc */
  DIAGRAM_DOC_TYPE_LOCKED = 10012,
  /** 409 — 存量 diagram doc 无渲染快照（历史数据），指路 re-upsert / forceRechunk 重渲染 */
  DIAGRAM_SNAPSHOT_MISSING = 10013,
  /**
   * 422 — 空间词表（settings.docTypes/canonicalTags/pathTypes）业务校验失败（v1.92.0-dev，
   * DocSpace 元数据治理 1 期）：canonical 值重复 / alias 跨条目冲突 / pathPrefix 重复。
   * data 带 { conflicts: [...] } 冲突对修复凭据（铁律 #21 双层校验——DTO 管格式，service 管业务）。
   */
  DOC_SPACE_VOCABULARY_INVALID = 10014,
  /**
   * 422 — 空间 hint 族开关（settings.hintToggles）业务校验失败（v1.92.0-dev，DocSpace
   * 元数据治理 2 期）：未知族键 / 非 boolean 值。data 带 { unknownKeys, invalidKeys }
   * 修复凭据（铁律 #21 双层校验——DTO 管格式，service 管业务）。
   * fail-fast 配置语义：拼错的族名静默忽略会让「开关看起来开了却没生效」。
   */
  DOC_SPACE_HINT_TOGGLES_INVALID = 10015,
  /**
   * 409 — 存量 tag rename/merge 的 batchToken 冲突（v1.92.0-dev，DocSpace 元数据治理
   * 3 期）：execute 传入的 `expectedBatchToken` 与事务内 FOR UPDATE 后重算的受影响集
   * 快照不一致（期间有并发写改动 tags/updatedAt）。data 带 { diff: { addedDocIds,
   * removedDocIds } } —— 治理工具宁严勿宽：abort-all 零副作用，调用方重新 dryRun
   * 取新 token 再执行（不附新 token——事务已回滚，重算无意义）。
   */
  DOC_BATCH_CONFLICT = 10016,

  // Roundtable (11000-11099)
  /** 404 — 审批请求不存在（裁决/查询目标缺失） */
  ROUNDTABLE_PERMISSION_REQUEST_NOT_FOUND = 11000,
  /** 404 — 圆桌座位不存在（座位移除等操作目标缺失） */
  ROUNDTABLE_SEAT_NOT_FOUND = 11001,
  /** 409 — 同一 topic 下该 actor 已有 active 座位（r17 唯一约束：一 agent 一 topic 一 active 座位；removed 软删豁免可重建） */
  ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT = 11002,

  // Attachments (12000-12099)
  /** 404 — 附件不存在；对"存在但无权限"的读取/删除访问也返回本码（不泄露存在性） */
  ATTACHMENT_NOT_FOUND = 12000,
  /** 413 — 单文件超过 ATTACHMENT_MAX_BYTES（默认 10MB）；注意配额超限是 12003(403) 不是本码 */
  ATTACHMENT_TOO_LARGE = 12001,
  /**
   * 400 — **上传路径自 v1.90.0-dev 起不再触发（退役触发器，编号保留不复用）**。
   *
   * 历史语义：魔数嗅探不命中图片白名单（png/jpeg/gif/webp）即拒收，不信任客户端
   * 声明的 Content-Type。附件 TTL 批起类型直接放开——非图片字节走
   * `mime_type='application/octet-stream'` + 强制下载出口（安全模型改为"唯一防线=响应头"，
   * 见 api-definition §16a）；上传侧唯一残留的 400 是"嗅探命中图片但头部不可解析"
   * （VALIDATION_ERROR），不是本码。
   *
   * 保留原因：契约编号永不复用（存量消费方/文档仍可能按 12002 分支）；且未来若
   * 重新引入准入策略，值域语义仍然成立。
   */
  ATTACHMENT_TYPE_NOT_ALLOWED = 12002,
  /** 403 — 上传者累计存储配额（ATTACHMENT_QUOTA_BYTES，默认 200MiB）超限；刻意用 403 而非 413（非单请求载荷问题） */
  ATTACHMENT_QUOTA_EXCEEDED = 12003,
  /** 403 — 仅上传绑定场景：对目标 topic/doc 无写权限；读取路径一律 12000（404）不泄露存在性 */
  ATTACHMENT_FORBIDDEN = 12004,
  /** 400 — 绑定非法：topicId 与 docId 必须恰好传一个（双传/双缺均拒绝） */
  ATTACHMENT_BIND_CONFLICT = 12005,
  /**
   * 401 — 短时签名 URL 凭证无效：验签失败 / scope 非 `attachment:content` /
   * token 载荷 `aid` 与路径 `:id` 不符（三断言任一不成立）。
   *
   * 归类**刻意粗粒度**：不回显 token 原文与 claims 明细（防 oracle 与信息泄露），
   * 消费方只需知道"这张凭证不可用"。消息必须指导下一步——重新铸造
   * （`POST /attachments/:id/signed-url`），并说明该公开端点自身不需要 API Key
   * （避免消费方误以为要去配凭证）。
   */
  ATTACHMENT_SIGNATURE_INVALID = 12006,
  /**
   * 401 — 短时签名 URL 已过期（JWT `exp` 到期）。
   *
   * 与 12006 刻意分码：消费方可区分"凭证被篡改/张冠李戴"与"单纯超时"，
   * 消息同样指导下一步（重新铸造，而不是猜测原因或重试同一 URL）。
   */
  ATTACHMENT_SIGNATURE_EXPIRED = 12007,
  /**
   * 404 — 缩略图不可用：附件本身存在且有权读取，但该附件没有缩略图
   * （存量行未回溯生成 / 上传时缩略图 fail-open 失败）。
   *
   * 与 12000（不存在或无权）**刻意分码**：消费方能区分"资源不可达"与
   * "资源可达但无该变体"，消息必须指导下一步（改用 /attachments/:id/content 取原图）。
   * 三表面同码同语义（P2）：① GET /attachments/:id/thumbnail（批 1）；
   * ② POST /attachments/:id/signed-url variant=thumbnail（批 2）；
   * ③ 公开端点 GET /public/attachments/:id/content?token=<签名 token>
   *    （变体取自 token 载荷 `var`，var=thumbnail 时该路径适用，批 2）。
   */
  ATTACHMENT_THUMBNAIL_UNAVAILABLE = 12008,
  /**
   * 410 / 400 — 附件已过期（v1.90.0-dev 附件 TTL 批，墓碑式过期语义）。
   *
   * **同一业务码，两种 HTTP 状态**（按路径语义分工，调用方可据此分支）：
   * - 410 Gone：**字节面**（`GET /attachments/:id/content` / `:id/thumbnail` /
   *   公开端点 `GET /public/attachments/:id/content`）——资源曾经存在、语义上已终结，
   *   与"从未存在"（404·12000）刻意区分；消息指导下一步（重新上传 / 让上传者重发）。
   * - 400 Bad Request：**引用/铸造面**（`POST /topics/:id/messages` 引用已过期附件、
   *   `POST /attachments/:id/signed-url` 为已过期附件铸造凭证）——死了就是死了，
   *   不许铸新票，也不许把过期 id 写进新消息索引。
   *
   * 过期判据 = `expires_at IS NOT NULL AND expires_at < now()`：
   * - `expires_at` 在上传时刻按 topic 当时的 `settings.attachmentTtl` **冻结**写入
   *   （doc 绑定恒 NULL = 永久；`never` → NULL；存量迁移行 NULL = 永久）；
   * - 小时级 GC（`sweepExpiredAttachments`）物理回收后行被硬删，读取面随之从 410 变
   *   404·12000（扫前 410 / 扫后 404，UI 消费投影的 `expired` 字段无感）。
   *
   * 元数据面**不**判过期：`GET /attachments/:id`、`GET /attachments/mine`、消息投影
   * 继续 200 + `expiresAt`（墓碑卡片需要数据；四表面同一口径——上传响应 / GET :id /
   * GET mine / 消息投影）。
   */
  ATTACHMENT_EXPIRED = 12009,

  // Experience (13000-13099)
  /**
   * 404 — 经验条目不存在（含已软删行；软删对读写一律表现为 404，不泄露存在性）。
   *
   * message 必须指导下一步：**勿重试同 id，回 search**（`GET /experiences` /
   * MCP `search_experiences`）——id 可能来自过期缓存或他人转述，重试同 id 恒失败。
   */
  EXPERIENCE_NOT_FOUND = 13000,
  /**
   * 403 — 经验条目**写操作**越权：调用者既非作者（creator / owner 代理）也非 admin。
   *
   * ⚠️ **仅写路径（PATCH / DELETE / 反馈等条目写通道）使用本码**（作者判定）。
   * 终审（`PATCH /experiences/:id/quality`）/ includeSuspect / 判断日志读取
   * （`GET /experiences/judgments`）三处**必须用 13004**（13004 = 需要 admin 或本空间
   * owner/reviewer 角色，是"角色/授权"判定的统一码）——两码分工见 13004 注释：
   * 13001 = 端点对你开放但**这一条**不属于你；13004 = 你**缺角色**。
   * message 必须给出唯一可行动线：**勿重试，走作者或 admin 代管通道**
   * （agent 无自助改他人条目路径）。
   *
   * 与 1009（PERMISSION_DENIED）的分工（2026-09-22 第二期收口）：1009 = 你的身份**类别**
   * 本就不该调这个端点（RolesGuard 对「agent 误调人类 admin 端点」的既有码）；
   * 经验模块的终审/includeSuspect 两处**已下线 1009**，人类身份不再天然被拒——
   * 改由空间成员角色承担（13004）。1009 保留给全平台其它"身份类别不对"场景。
   */
  EXPERIENCE_FORBIDDEN = 13001,
  /**
   * 403 — 经验终审**禁自审**（四态矩阵：作者本人 / 人类审自己 agent 的条目 / agent 审自己
   * owner 的条目 / 同一人类 owner 名下兄弟 agent 互审）。
   *
   * ⚠️ **已退役（2026-09-24 用户拍板，v1.81.0）——号不复用**：单租户 + 同模型 agent +
   * 新会话无上下文包袱的现实下，兄弟 agent 审与自审独立性同构，四态只制造死锁
   * （2026-09-24 生产实证：17 条待审、`viewerCanReview` 全 false ⇒ 无人可 verdict）。
   * 退役后：**任何 admin 或空间 owner/reviewer 可终审任意条目（含本人所录）**，终审资格
   * 退化为**纯角色判定**，唯一的终审拒绝码是 13004（缺角色）。双向权力同时放开：持角色者
   * 也可对自己/兄弟的条目打 `suspect`，靠审计 old→new+reason 留痕 + admin 翻案权兜底。
   * 决策记录与多租户捡回条件见线上 `docs/modules/experience-base.md` §11。
   *
   * 保留本枚举条目只为"号不复用"这条纪律有唯一的落点（**禁止改号、禁止复用**）；
   * 全仓已无任何抛出处。旧详情字段 `viewerReviewBlockReason` 一并停发。
   */
  EXPERIENCE_SELF_REVIEW = 13002,
  /**
   * 404 — 目标 actor 不是经验库空间成员（PATCH/DELETE `/experiences/members/:actorId`
   * 的成员行缺失；「不存在」与「已软删的 actor」同码，不泄露存在性）。
   *
   * message 必须指导下一步：**先核对成员清单**（`GET /experiences/members`，含 actorId
   * 与当前角色），再决定是新增成员还是改用别的 actorId——勿对同 id 反复 PATCH/DELETE。
   */
  EXPERIENCE_MEMBER_NOT_FOUND = 13003,
  /**
   * 403 — 需要「人类 admin 或**本空间** owner/reviewer 角色」的操作被拒。
   *
   * 三处端点共用本码（**message 按端点各自给下一步**）：① 终审
   * `PATCH /experiences/:id/quality`；② `includeSuspect` 放宽（suspect 复核出口）；
   * ③ 判断日志 `GET /experiences/judgments`。缺角色时的动作 = 走
   * `GET /experiences/members` 确认自己是否在册，不在册则请 admin/空间 owner 授权
   * （成员管理端点 `POST /experiences/members`）。
   *
   * 本码是**终审的唯一拒绝码**（v1.81.0）：旧 13002（禁自审）已退役——13004 = 你**缺角色**
   * （可经授权解除）；已不存在"你有资格但这一条不能审"的状态（持角色者可审任意条目）。
   */
  EXPERIENCE_REVIEW_FORBIDDEN = 13004,
  /**
   * 409 — 目标 actor **已是成员**，但请求的角色与现有角色不同（`POST /experiences/members`
   * 的幂等/冲突分工：同角色 → 200 幂等返回成员行；异角色 → 本码）。
   *
   * message 必须指导下一步：**改角色走 PATCH**
   * （`PATCH /experiences/members/:actorId`）——勿删了重加（DELETE + POST 会丢失
   * invited_by 授权留痕，且中途存在"无成员行"窗口）。
   */
  EXPERIENCE_MEMBER_EXISTS = 13005,

  // Memory (14000-14099)
  /**
   * 503 — **引擎动词端点不可用**（memory 是可选增强：未配置引擎时 Chamber 完全可用）。
   *
   * `data.reason` 五值（值域单源 = `MEMORY_UNAVAILABLE_REASONS`）：
   * `not_configured`（全局 `MEMORY_ENGINE` 未配置）/ `project_engine_unbound`
   * （本项目 `memory_projects.engine` 未绑定引擎）/ `engine_unreachable`（请求未到达，
   * 同 key 重发安全）/ `engine_timeout`（**无回执，可能已提交**）/ `engine_error`
   * （引擎回了错误体，`data.engineCode` 透传）。
   *
   * ⚠️ **本地数据端点不适用本码**：项目注册表 / 账本读 / 记忆详情在未配引擎时照常 200，
   * 只在 body 里嵌 `engine:{available,reason}` 块——把"没配增强项"变成 503 会让消费方
   * 以为平台坏了。message 必须区分两态并给出下一步（修配置 vs 稍后重试）。
   */
  MEMORY_UNAVAILABLE = 14000,
  /**
   * 404 — 记忆项目不存在（含已软删；软删对读写一律表现为 404，不泄露存在性）。
   *
   * message 必须指导下一步：**勿重试同 id**，回 `GET /memory/projects` 取现行 id。
   */
  MEMORY_PROJECT_NOT_FOUND = 14001,
  /**
   * 409 — 项目级冲突（`POST`/`PATCH /memory/projects*`）。
   *
   * 五个场景共用本码（message 各自给下一步）：
   * ① slug 已被占用（`uq_memory_projects_slug` 部分唯一索引；换 slug 或复用既有项目）；
   * ② 首条任意耐久账本后改变 engine/workspace/actor（含所有形成态/行状态/软删）——
   *    数据身份固定；同值及 credentialRef 轮换仍可用，其他 namespace 须新建项目；
   * ③ 归档项目（`status=archived`）上发起写路径（nominate/correct/retry/recover）；
   * ④ 引擎身份三元组已被**另一个** projectId 永久占用（`memory_engine_binding_claims`；
   *    改绑/清空/归档/软删/硬删都不释放；同项目重发幂等）——换三元组或交运维审计。
   * ⑤ 准备快照/已授权绑定过期——本次未提交，重读配置权限后可用原 clientRequestId 重试。
   */
  MEMORY_PROJECT_CONFLICT = 14002,
  /**
   * 404 — 提名账本行不存在（含已软删）。
   *
   * 三个 404 共用本码：`GET /memory/nominations/:id`、`POST /memory/nominations/:id/retry`、
   * `GET /memory/projects/:id/memories/:engineMemoryId`（后者是"本项目无账本行映射该 memory id"
   * 的同一语义：映射源就是账本行）。message 指引"回账本列表取现行 id"。
   */
  MEMORY_NOMINATION_NOT_FOUND = 14003,
  /**
   * 502 — **引擎可达但返回错误**（网关语义：Chamber 是引擎的网关）。
   *
   * 与 14000 的分工：14000 = 引擎**不可用**（未配/未绑/不可达/超时）或写入路径已有账本行可查
   * （此时 HTTP 由 §6 的账本态驱动，仍是 503）；本码 = 引擎确实答了但答的是错误
   * （`data.engineCode` 透传），且该端点**没有账本态可回报**（召回 / 记忆详情）。
   */
  MEMORY_ENGINE_ERROR = 14004,
  /**
   * 409 — 提名/更正未能收敛且**需要人工或运维介入**（`POST .../nominations`、
   * `POST .../corrections`）。
   *
   * 三个场景共用本码（message 各自给下一步）：
   * ① `formation_state=conflict`（引擎 409 四类同形：quota / exact_content /
   *    prefix_unresolved / idempotency_conflict）——先稍后查详情，仍失败转 Owner/Hub 运维；
   * ② `formation_state=rejected`（引擎终态拒绝）——**勿重试**，须 Owner 走 recovery；
   * ③ 更正预检失败（旧行非 active / 同一 old 已有有效更正行）——先查旧主张当前状态。
   *
   * 幂等键复用（`uq_memory_nominations_client_key` 23505）也归本码：换新 key 重提。
   */
  MEMORY_NOMINATION_CONFLICT = 14005,
  /**
   * 409 — **引擎身份共享/归属不明，Usage 读面关闭**（`GET /memory/projects/:id/usage/*`）。
   *
   * 触发条件（**AND + deny 优先**，两者任一命中即拒绝，且**不调用 Hub**）：
   * ① 该项目的引擎三元组 `(engine, workspaceId, actorId, credentialRef)` 被**不止一行**
   *    `memory_projects` 引用（含 archived / 软删行——`withDeleted` 全量扫描）；
   * ② `memory_engine_binding_claims` 里没有该三元组的占用行，或占用行归属**不是**本项目。
   *
   * `data.hintCode = shared_engine_binding`。Usage 是项目级引擎聚合，共享身份下无法证明
   * "这些用量只属于本项目"——fail-closed 关闭比给出一个可被误读为完整的 0 更安全。
   * 文案**不回显 credentialRef / workspace / actor / 其他项目 id**。
   */
  MEMORY_USAGE_CONFLICT = 14006,
}

/**
 * 话题类型（topics.kind 列值域，设计 docs/modules/roundtable-design.md §5；review-0831 任务 150bf876）
 * - normal：普通话题（缺省，存量行零感知）
 * - roundtable：圆桌模式（席位 + 会话层规则 wakePolicy/攒批生效）
 * 创建后不可变——update 忽略 kind，normal↔roundtable 互转在 M2 推迟清单
 */
export enum TopicKind {
  NORMAL = 'normal',
  ROUNDTABLE = 'roundtable',
}

/**
 * 圆桌唤醒策略（topic.settings.wakePolicy 值域，设计 §6，r4 + R1 拍板）
 * - mention：仅 @座位label / @all 唤醒对应座位（缺省，新桌默认省钱安全）
 * - broadcast：新消息唤醒全部 active 座位（高强度讨论桌可选）
 * 普通话题（kind=normal）不消费该值，但按「配置原样存储」语义照常写入 settings
 */
export enum WakePolicy {
  MENTION = 'mention',
  BROADCAST = 'broadcast',
}

/**
 * 圆桌座位生命周期状态值域（roundtable_seats.status，五值全量；review-0831 任务 150bf876）
 * - active：座位已启用、待 runner 认领（默认）
 * - paused：暂停（座位管理操作 M3 落地）
 * - parked：非唤醒消息暂存（攒批收集器语义）
 * - offline：runner 断连/主动离线
 * - removed：软删（M3 阶段 3 座位移除，行保留供溯源）
 * ⚠️ 与协议包 SEAT_RUNTIME_STATUSES（online/busy/offline，SeatEvent 运行态）是两套词汇，勿混
 */
export const SEAT_LIFECYCLE_STATUSES = [
  'active',
  'paused',
  'parked',
  'offline',
  'removed',
] as const;

/** 圆桌座位生命周期状态类型 */
export type SeatLifecycleStatus = (typeof SEAT_LIFECYCLE_STATUSES)[number];

/**
 * 命名访问视图（单源派生自 SEAT_LIFECYCLE_STATUSES；与 docspace CODE_ENTRY_TYPE 同款
 * 「值域数组 + 命名化派生」模式，供 entity/query/save 命名引用）
 */
export const SEAT_LIFECYCLE_STATUS = {
  ACTIVE: SEAT_LIFECYCLE_STATUSES[0],
  PAUSED: SEAT_LIFECYCLE_STATUSES[1],
  PARKED: SEAT_LIFECYCLE_STATUSES[2],
  OFFLINE: SEAT_LIFECYCLE_STATUSES[3],
  REMOVED: SEAT_LIFECYCLE_STATUSES[4],
} as const;

/**
 * 座位实时相位值域（M4b-1 presence 派生视图，不落库；review-0831 任务 150bf876）
 * - thinking：思考中（busy 相位 / activity 边沿）
 * - tool：工具调用中（带 toolTitle）
 * - replying：回复中（message_chunk 流式增量）
 * - idle：空闲（message_complete 终结）
 * - offline：离线（runner 断连/主动报离线）
 */
export const PRESENCE_PHASES = ['thinking', 'tool', 'replying', 'idle', 'offline'] as const;

/** 座位实时相位类型 */
export type PresencePhase = (typeof PRESENCE_PHASES)[number];

/** 命名访问视图（单源派生自 PRESENCE_PHASES，供 presence 比较/赋值命名引用） */
export const PRESENCE_PHASE = {
  THINKING: PRESENCE_PHASES[0],
  TOOL: PRESENCE_PHASES[1],
  REPLYING: PRESENCE_PHASES[2],
  IDLE: PRESENCE_PHASES[3],
  OFFLINE: PRESENCE_PHASES[4],
} as const;

// =============================================================================
// 经验库（Experience Base）值域
//
// 统一模式：`<DOMAIN>S` 值域数组（as const）→ 派生 type union → 命名访问视图
// `<DOMAIN>`（与 SEAT_LIFECYCLE_STATUS / PRESENCE_PHASE 同款「值域数组 + 命名化派生」）。
// 三处消费者共用单源：DTO @IsIn 校验 / entity 默认值 / MCP 工具 schema enum。
// =============================================================================

/**
 * 经验条目类型值域（experience_entries.intent，plan v1.3 §1.1；列是裸 varchar(32)，
 * 新增值无需 migration）。
 *
 * 分类学：**按问题性质分，不按行业分**（EvoMap 全球网络同款决策）——行业分类树应对
 * 不了开放领域，检索主入口是 signals 症状匹配而非分类下钻。
 * - pitfall：价值是**警告错误做法**（"别这么干，我踩过"）
 * - repair：价值是**读者手上有报错、要解法**（症状 → 根因 → 修复）
 * - howto：价值是**正确做法的操作序列**（无前置故障）
 * - optimize：价值是**已能跑但想更快/更省**的改进
 * - decision：价值是**取舍记录**（选 A 不选 B 的理由与代价）
 *
 * repair 与 pitfall 重叠时的判别规则（写进 MCP schema description，plan §4）：
 * 标题描述**症状**选 repair，描述**错误做法**选 pitfall。
 */
export const EXPERIENCE_INTENTS = ['pitfall', 'repair', 'howto', 'optimize', 'decision'] as const;

/** 经验条目类型 */
export type ExperienceIntent = (typeof EXPERIENCE_INTENTS)[number];

/** 命名访问视图（单源派生自 EXPERIENCE_INTENTS，供 entity 默认值 / DTO 枚举 / MCP schema 命名引用） */
export const EXPERIENCE_INTENT = {
  PITFALL: EXPERIENCE_INTENTS[0],
  REPAIR: EXPERIENCE_INTENTS[1],
  HOWTO: EXPERIENCE_INTENTS[2],
  OPTIMIZE: EXPERIENCE_INTENTS[3],
  DECISION: EXPERIENCE_INTENTS[4],
} as const;

/**
 * 经验条质量值域（experience_entries.quality，plan v1.3 §6；裸 varchar(32)，新增值无需 migration）。
 *
 * 生命周期（单向为主、双向门见下）：
 * - unverified：缺省（全认证可写，立即可搜、无需审批）；**内容改写自动回落本态**
 * - verified：**人类 admin 或空间 owner/reviewer 终审**通过（写 verified_by/verified_at）；
 *   排序加权层
 * - suspect：终审判定可疑（检索默认排除，详情仍可见可改回——PM R1 复核/申诉动线）
 *
 * 双向门：verified ↔ suspect 可由 admin 互改（终审不是单向判决，plan §3 quality 端点）。
 */
export const EXPERIENCE_QUALITIES = ['unverified', 'verified', 'suspect'] as const;

/** 经验条质量 */
export type ExperienceQuality = (typeof EXPERIENCE_QUALITIES)[number];

/** 命名访问视图（单源派生自 EXPERIENCE_QUALITIES，供 entity 缺省值 / DTO / 查询命名引用） */
export const EXPERIENCE_QUALITY = {
  UNVERIFIED: EXPERIENCE_QUALITIES[0],
  VERIFIED: EXPERIENCE_QUALITIES[1],
  SUSPECT: EXPERIENCE_QUALITIES[2],
} as const;

/**
 * 经验反馈结果值域（experience_feedback.outcome，plan v1.3 §1.2；裸 varchar(16)）。
 *
 * ⚠️ 语义是「**应用后**是否有效」，**不是**「搜索结果是否命中」——写进 MCP schema
 * description 与文档，防消费方把"搜到了"当成"帮到了"（plan §4 report_experience_feedback）。
 */
export const EXPERIENCE_FEEDBACK_OUTCOMES = ['helped', 'not_helpful'] as const;

/** 经验反馈结果 */
export type ExperienceFeedbackOutcome = (typeof EXPERIENCE_FEEDBACK_OUTCOMES)[number];

/** 命名访问视图（单源派生自 EXPERIENCE_FEEDBACK_OUTCOMES） */
export const EXPERIENCE_FEEDBACK_OUTCOME = {
  HELPED: EXPERIENCE_FEEDBACK_OUTCOMES[0],
  NOT_HELPFUL: EXPERIENCE_FEEDBACK_OUTCOMES[1],
} as const;

/**
 * 经验空间成员角色值域（`experience_space_members.role`，第二期 plan §0/§1.1；
 * 列是裸 varchar(20)，新增值无需 migration）。
 *
 * - `owner`（中文标签 = **空间管理员**）：终审权 + 管理 reviewer（增删/改角色，
 *   且**仅对 reviewer 行、仅可授 reviewer 值**——PATCH 双约束，防 owner 自造 owner）
 * - `reviewer`（中文标签 = **终审人**）：终审权（写 verified/suspect 徽章）
 *
 * ⚠️ **术语撞车警示**：平台既有 "owner" 指 agent 的人类主人（`OwnerProxyService`），
 * 本枚举的 "owner" 是**空间角色**——两者语义无关，勿混用命名空间。中文标签已钉死
 * （web/i18n 只许用「空间管理员」/「终审人」），代码标识符保持 owner/reviewer。
 * 人类 admin 是全局兜底（无需入表即可行使全部成员操作）——**零成员 = 无任何条目可终审**
 * 是明文接受的退化态（admin 自录条目保持 unverified）。
 *
 * role 列**刻意无 DB 默认值**：两值皆是特权，默认值 = 默认授权（违反最小权限），
 * service 层显式必填 + `@IsIn` 快速失败。
 */
export const EXPERIENCE_MEMBER_ROLES = ['owner', 'reviewer'] as const;

/** 经验空间成员角色 */
export type ExperienceMemberRole = (typeof EXPERIENCE_MEMBER_ROLES)[number];

/** 命名访问视图（单源派生自 EXPERIENCE_MEMBER_ROLES，供 entity / DTO 枚举 / 服务判定命名引用） */
export const EXPERIENCE_MEMBER_ROLE = {
  OWNER: EXPERIENCE_MEMBER_ROLES[0],
  REVIEWER: EXPERIENCE_MEMBER_ROLES[1],
} as const;

/**
 * 经验判断操作值域（`experience_judgments.operation`，第二期 plan §1.2；裸 varchar(32)）。
 *
 * 本批**唯一产出值** = `record_check`（录入/内容变更后的七维 rubric 软判定）；
 * `rerank` / `autotag` 是**预留值**（搜索重排与自动打标在 plan §13 明列不做，
 * 等 observe 期数据攒够再评估）——预留而非新增，避免将来新增值时历史日志出现
 * "未知操作"的解析分支。
 *
 * ⚠️ 消费面纪律：`operation` 是**过滤参数白名单**（`@IsIn`）——拼错的取值必须 400，
 * 不许静默返回空页（否则"查不到语料"与"参数打错"无法区分）。
 */
export const EXPERIENCE_JUDGMENT_OPERATIONS = ['record_check', 'rerank', 'autotag'] as const;

/** 经验判断操作 */
export type ExperienceJudgmentOperation = (typeof EXPERIENCE_JUDGMENT_OPERATIONS)[number];

/** 命名访问视图（单源派生自 EXPERIENCE_JUDGMENT_OPERATIONS） */
export const EXPERIENCE_JUDGMENT_OPERATION = {
  RECORD_CHECK: EXPERIENCE_JUDGMENT_OPERATIONS[0],
  RERANK: EXPERIENCE_JUDGMENT_OPERATIONS[1],
  AUTOTAG: EXPERIENCE_JUDGMENT_OPERATIONS[2],
} as const;

/**
 * 经验判断结果状态值域（`experience_judgments.status`，第二期 plan §1.2/§3.2；裸 varchar(16)）。
 *
 * - `ok`：判断成功且归一化结果通过逐字段白名单校验（快照列同步写入）
 * - `error`：provider 异常 / HTTP 非 200 / 响应解析失败 / 白名单校验失败。固定失败标签按
 *   provider 分列，口径以线上 `docs/modules/experience-base.md` §12 为准；历史行里的 JSON-RPC error
 *   标签来自已退役的 `jev` MCP 传输（v1.83.0 起不再产生）
 * - `timeout`：超过 `JUDGMENT_TIMEOUT_MS`（默认 8s）硬顶
 * - `skipped`：**限流跳过**（未调用 provider）——`request` 写占位
 *   `{skipped:true, reason:'<EXPERIENCE_JUDGMENT_SKIPPED_REASONS 之一>'}`，`response` 为 null，
 *   **同样计入额度**（行写入有界，防日志表被刷爆）。`reason` 区分**撞的是哪一级闸**
 *   （actor / 全局 / 能力子额度），值域单源见 `EXPERIENCE_JUDGMENT_SKIPPED_REASONS`
 *
 * ⚠️ **失败与跳过都落库**：observe 期的失败率/覆盖率全靠本表；**"未判"与"判失败"的区分
 * = 查本表 status**（条目快照列 `judgment=null` 无法区分，也不自动重判——明文决策）。
 * 失败率分母口径 = `ok + error + timeout`（**排除 skipped**）。
 */
export const EXPERIENCE_JUDGMENT_STATUSES = ['ok', 'error', 'timeout', 'skipped'] as const;

/** 经验判断结果状态 */
export type ExperienceJudgmentStatus = (typeof EXPERIENCE_JUDGMENT_STATUSES)[number];

/** 命名访问视图（单源派生自 EXPERIENCE_JUDGMENT_STATUSES） */
export const EXPERIENCE_JUDGMENT_STATUS = {
  OK: EXPERIENCE_JUDGMENT_STATUSES[0],
  ERROR: EXPERIENCE_JUDGMENT_STATUSES[1],
  TIMEOUT: EXPERIENCE_JUDGMENT_STATUSES[2],
  SKIPPED: EXPERIENCE_JUDGMENT_STATUSES[3],
} as const;

/**
 * 判别跳过原因值域（`experience_judgments.request.reason`，`status='skipped'` 行）。
 *
 * 三级成本闸各对应一个值（v1.85.0 起）——**枚举化是为了防下游按字面量 grep 时静默漏行**：
 * 单常量时代只能匹配 `judgment_rate_limited`，新增的两级闸会从"跳过分布"统计里消失。
 *
 * - `judgment_rate_limited`：**actor** 级额度（`JUDGMENT_RATE_LIMIT`）超限。⚠️ 历史值
 *   （v1.85.0 前的 skipped 行）**逐字节就是它**，兼容性要求它字面不变
 * - `global_rate_limit`：**全局**总闸（`JUDGMENT_GLOBAL_RATE_LIMIT`）超限（跨 actor）
 * - `capability_rate_limit`：**能力子额度**（`JUDGMENT_CAPABILITY_RATE_LIMIT`）超限
 * - `egress_blocked`：**出境闸**命中（v1.85.0 批次 2）——能力的 `egressAllow` 判定本次输入
 *   不得出境（如查询词命中密钥形态）。**不落输入原文**，只落本 reason
 * - `visibility_blocked`：**可见性闸**命中（v1.85.0 批次 2）——重排候选里有非 open 可见性的
 *   空间，放弃本次重排。⚠️ **不带 candidateDocIds**：把"哪些文档被挡下"写进日志，等于反向
 *   泄露"某私有空间里存在这些文档"
 *
 * 三级闸都是**进程内软闸**（每实例每小时 / 重启清零 / 多副本上界 ×N），语义与取值见
 * `.env.example` 判别块与线上 `docs/modules/experience-base.md`。
 *
 * ⚠️ **两个分母口径并排**（别混用）：
 * - **失败率**分母 = `ok + error + timeout`（**排除全部 skipped**）：度量"调用过但失败了"
 * - **fail-open 率**分母 = 上者 **+ skipped 全 reason**：度量"本该判别却没有结论"
 *   （额度闸 / 出境闸 / 可见性闸都算"没结论"）
 */
export const EXPERIENCE_JUDGMENT_SKIPPED_REASONS = [
  'judgment_rate_limited',
  'global_rate_limit',
  'capability_rate_limit',
  'egress_blocked',
  'visibility_blocked',
] as const;

/** 判别跳过原因 */
export type ExperienceJudgmentSkippedReason = (typeof EXPERIENCE_JUDGMENT_SKIPPED_REASONS)[number];

/**
 * 命名访问视图（单源派生自 `EXPERIENCE_JUDGMENT_SKIPPED_REASONS`）。
 *
 * 顺序**有语义**（与值域数组同序）：actor → 全局 → 能力 → 出境 → 可见性。消费点按"撞到哪一级"
 * 取值，不要在调用点重抄字面量（枚举化的唯一意义就是单源）。
 *
 * ⚠️ 新增值一律**尾部追加**：`experience.service.ts` 的 400 文案等按序消费点依赖既有下标。
 */
export const EXPERIENCE_JUDGMENT_SKIPPED_REASON = {
  ACTOR_RATE_LIMITED: EXPERIENCE_JUDGMENT_SKIPPED_REASONS[0],
  GLOBAL_RATE_LIMITED: EXPERIENCE_JUDGMENT_SKIPPED_REASONS[1],
  CAPABILITY_RATE_LIMITED: EXPERIENCE_JUDGMENT_SKIPPED_REASONS[2],
  EGRESS_BLOCKED: EXPERIENCE_JUDGMENT_SKIPPED_REASONS[3],
  VISIBILITY_BLOCKED: EXPERIENCE_JUDGMENT_SKIPPED_REASONS[4],
} as const;

/**
 * 经验终审可写入的质量值域（第二期 plan §2.1：从后端 DTO **提升到 shared**，裸 varchar(32)）。
 *
 * 与 `EXPERIENCE_QUALITIES`（三值，entity 缺省与查询过滤用）的区别：本值域是**终审写路径**
 * 的可选值——`unverified` 刻意不在其中（终审是"给结论"，撤回结论走内容改写回落，
 * 不提供"手动改回未审"的入口）。
 *
 * 提升 rationale：MCP 侧（platform-mcp）需要本地枚举快速失败，而它**不可达后端模块**
 * （`@agent-chamber/backend` 的 DTO 不在其依赖面内）——shared 是唯一双方都可达的单源。
 * 后端 DTO 改为引用本值域（**禁止在 DTO 里再抄一份字面量数组**，两处漂移 = 工具侧
 * 放行后端拒绝的值）。
 */
export const EXPERIENCE_REVIEW_QUALITIES = [
  EXPERIENCE_QUALITY.VERIFIED,
  EXPERIENCE_QUALITY.SUSPECT,
] as const;

/** 经验终审可写入的质量值 */
export type ExperienceReviewQuality = (typeof EXPERIENCE_REVIEW_QUALITIES)[number];

/** 命名访问视图（单源派生自 EXPERIENCE_REVIEW_QUALITIES） */
export const EXPERIENCE_REVIEW_QUALITY = {
  VERIFIED: EXPERIENCE_REVIEW_QUALITIES[0],
  SUSPECT: EXPERIENCE_REVIEW_QUALITIES[1],
} as const;

// =============================================================================
// Memory 模块（Hument 集成一期）值域
//
// 单源模式与经验库族完全一致：值域数组（as const）→ 派生 type union → 命名访问
// 视图。三处消费者共用：entity 列默认值 / DTO & 过滤参数 @IsIn / §7 状态机映射表。
//
// ⚠️ 所有列都是**裸 varchar**（无 PG enum）：新增取值不需要 migration。
// ⚠️ 值域数组的**顺序**对 `MEMORY_FORMATION_STATES` 无语义（与 EXPERIENCE_JUDGMENT_
//    SKIPPED_REASONS 不同，无按序消费点），新增值可任意位置插入，但**推荐尾部追加**
//    以保持既有下标稳定。
// 方案：.kimi 计划 `catwoman-blade-wolfsbane.md` §2（逐列契约）/§7（状态机映射表）
// =============================================================================

/**
 * 提名形成态值域（`memory_nominations.formation_state`，方案 §2/§7；裸 varchar(16)）。
 *
 * 七态是**Chamber 侧对引擎信号的归一化结果**（§7 映射表的像），不是 Hument 的
 * `job_state` 原值——`diagnostics.outcome` 优先、`job_state` 回退（退化路径见 §7）。
 * - `submitted`：**非终态**。job 在途（pending/claimed/inflight/proposed/committing/
 *   no_material）或引擎回 deferred——收敛动作 = 同 key 重发，inspect 只读不推进 job
 * - `committed`：终态，记忆已形成（`engine_memory_ids` 非空；alias 行恒 NULL）
 * - `no_memory`：终态，引擎判定"无需记忆"（**即使 job_state=committed**）——不写 ids；
 *   更正场景下新行转 `withdrawn` 释放 `correction_of` 唯一位
 * - `rejected`：终态，引擎拒绝，须 Owner/Hub 人工 recovery，**勿重试**
 * - `failed`：**非终态**（可同 key 重发）：请求未到达（durable=false 的 500 / 连接拒绝）
 *   或 error.code 归因于配置/参数（`recovery_path` 区分是否值得重试）
 * - `unknown`：Hument 侧终态但 **Chamber 不可恢复**（客户端超时 / provider_outcome_
 *   unknown，无回执）——如实写，绝不落 committed
 * - `conflict`：409 四类同形（quota / exact_content / prefix_unresolved /
 *   idempotency_conflict）——人工处置（先查详情，仍失败转 Owner/Hub 运维）
 *
 * ⚠️ 默认行兜底 = `unknown`（§7 末行）：任何未映射信号绝不落 committed。
 */
export const MEMORY_FORMATION_STATES = [
  'submitted',
  'committed',
  'no_memory',
  'rejected',
  'failed',
  'unknown',
  'conflict',
] as const;

/** 提名形成态 */
export type MemoryFormationState = (typeof MEMORY_FORMATION_STATES)[number];

/** 命名访问视图（单源派生自 MEMORY_FORMATION_STATES，供 entity 默认值 / 服务判定 / 治理投影命名引用） */
export const MEMORY_FORMATION_STATE = {
  SUBMITTED: MEMORY_FORMATION_STATES[0],
  COMMITTED: MEMORY_FORMATION_STATES[1],
  NO_MEMORY: MEMORY_FORMATION_STATES[2],
  REJECTED: MEMORY_FORMATION_STATES[3],
  FAILED: MEMORY_FORMATION_STATES[4],
  UNKNOWN: MEMORY_FORMATION_STATES[5],
  CONFLICT: MEMORY_FORMATION_STATES[6],
} as const;

/**
 * 账本行状态值域（`memory_nominations.status`，方案 §2；裸 varchar(16)）。
 *
 * 与 `formation_state` **正交**：前者是 Chamber 的账本生命周期，后者是引擎信号像。
 * - `active`：当前主张（default）。**更正预检要求旧行 active**（引擎三约束先于 DB 拦截）
 * - `superseded`：被更正取代（`corrections` 成功后旧行转本态）
 * - `withdrawn`：撤回（更正未达成时新行转本态，**释放 `correction_of` 部分唯一位**）
 *
 * ⚠️ 不变量：`withdrawn ⇒ engine_memory_ids 必为空`（方案 §2，DB R8）——由应用层保证，
 * 本列不设 DB 约束。
 */
export const MEMORY_NOMINATION_STATUSES = ['active', 'superseded', 'withdrawn'] as const;

/** 账本行状态 */
export type MemoryNominationStatus = (typeof MEMORY_NOMINATION_STATUSES)[number];

/** 命名访问视图（单源派生自 MEMORY_NOMINATION_STATUSES） */
export const MEMORY_NOMINATION_STATUS = {
  ACTIVE: MEMORY_NOMINATION_STATUSES[0],
  SUPERSEDED: MEMORY_NOMINATION_STATUSES[1],
  WITHDRAWN: MEMORY_NOMINATION_STATUSES[2],
} as const;

/**
 * 形成尝试遥测结果值域（`memory_formation_events.outcome`，方案 §2/§7；裸 varchar(24)）。
 *
 * 口径 = **Hument 原始信号**（不是归一化后的 formation_state）——本表记"每次尝试收到了
 * 什么"，§7 映射表把信号翻译成 formation_state 后才落账本。因此同一个账本行可以有多条
 * 本表行（`retry_count` = 第几次尝试），事实源边界：账本 = 当前态，本表 = 尝试历史。
 * - `memory_committed`：引擎形成成功
 * - `no_memory`：引擎判定无需记忆
 * - `no_change_validated`：引擎判定与既有记忆无实质变化（**即使 job_state=committed**）
 * - `rejected`：引擎拒绝（`recovery_path=hub_manual_required`）
 * - `unknown`：无回执 / provider_outcome_unknown（`input/output_tokens` 置 NULL）
 * - `deferred`：引擎要求延后（`recovery_path=same_key_resend`）
 */
export const MEMORY_FORMATION_OUTCOMES = [
  'memory_committed',
  'no_memory',
  'no_change_validated',
  'rejected',
  'unknown',
  'deferred',
] as const;

/** 形成尝试遥测结果 */
export type MemoryFormationOutcome = (typeof MEMORY_FORMATION_OUTCOMES)[number];

/** 命名访问视图（单源派生自 MEMORY_FORMATION_OUTCOMES，供 §7 映射表与遥测写入命名引用） */
export const MEMORY_FORMATION_OUTCOME = {
  MEMORY_COMMITTED: MEMORY_FORMATION_OUTCOMES[0],
  NO_MEMORY: MEMORY_FORMATION_OUTCOMES[1],
  NO_CHANGE_VALIDATED: MEMORY_FORMATION_OUTCOMES[2],
  REJECTED: MEMORY_FORMATION_OUTCOMES[3],
  UNKNOWN: MEMORY_FORMATION_OUTCOMES[4],
  DEFERRED: MEMORY_FORMATION_OUTCOMES[5],
} as const;

/**
 * 召回遥测结果值域（`memory_recall_events.outcome`，方案 §2；裸 varchar(16)）。
 *
 * **失败也落行**（本表是召回质量与引擎可用性的分母来源）：
 * - `ok`：引擎返回（含零结果——零结果是合法成功）
 * - `unavailable`：引擎不可达 / 未配置（引擎闸 503 组）
 * - `timeout`：客户端超时（不等式见方案 §3；provider timeout 调低会抬高本值出现率）
 */
export const MEMORY_RECALL_OUTCOMES = ['ok', 'unavailable', 'timeout'] as const;

/** 召回遥测结果 */
export type MemoryRecallOutcome = (typeof MEMORY_RECALL_OUTCOMES)[number];

/** 命名访问视图（单源派生自 MEMORY_RECALL_OUTCOMES） */
export const MEMORY_RECALL_OUTCOME = {
  OK: MEMORY_RECALL_OUTCOMES[0],
  UNAVAILABLE: MEMORY_RECALL_OUTCOMES[1],
  TIMEOUT: MEMORY_RECALL_OUTCOMES[2],
} as const;

/**
 * 项目绑定类型值域（`memory_projects.bindings[].type`，方案 §1/§5；裸 varchar 存于 jsonb）。
 *
 * 项目绑定**列表化**（不固化单 trio，Owner 拍板）——权限判定按"任一绑定可读/可写"，
 * 绑定解析失败一律 fail-closed。
 * - `topic`：绑定平台话题（父链 = 话题本身）
 * - `board`：绑定看板（父链 = 看板本身）
 * - `docSpace`：绑定文档空间（**驼峰值**，与平台 `DocSpace` 实体命名一致；父链 = 空间本身）
 */
export const MEMORY_BINDING_TYPES = ['topic', 'board', 'docSpace'] as const;

/** 项目绑定类型 */
export type MemoryBindingType = (typeof MEMORY_BINDING_TYPES)[number];

/** 命名访问视图（单源派生自 MEMORY_BINDING_TYPES，供 DTO @IsIn 与绑定解析命名引用） */
export const MEMORY_BINDING_TYPE = {
  TOPIC: MEMORY_BINDING_TYPES[0],
  BOARD: MEMORY_BINDING_TYPES[1],
  DOC_SPACE: MEMORY_BINDING_TYPES[2],
} as const;

/**
 * 提名来源引用类型值域（`memory_nominations.source_refs[].type`，方案 §2/§4；jsonb 内）。
 *
 * **禁 `memory` 值**（方案 §2）：记忆不能作为记忆的来源——否则形成链可自证，
 * 与"提名只接受原始来源"的虚假共识防护（定论⑤）冲突。
 * - `doc`：文档（父链 doc → docSpace；冻结 contentHash/headingPath）
 * - `message`：话题消息（父链 message → topic）
 * - `task`：看板任务（父链 task → list → board）
 * - `comment`：任务评论（父链 comment → task → list → board）
 *
 * locator 形态（方案 §4）：`chamber://<type>/<id>[#h<contentHash12>]`（≤4 条）。
 */
export const MEMORY_SOURCE_REF_TYPES = ['doc', 'message', 'task', 'comment'] as const;

/** 提名来源引用类型 */
export type MemorySourceRefType = (typeof MEMORY_SOURCE_REF_TYPES)[number];

/** 命名访问视图（单源派生自 MEMORY_SOURCE_REF_TYPES，供来源回取与权限过滤命名引用） */
export const MEMORY_SOURCE_REF_TYPE = {
  DOC: MEMORY_SOURCE_REF_TYPES[0],
  MESSAGE: MEMORY_SOURCE_REF_TYPES[1],
  TASK: MEMORY_SOURCE_REF_TYPES[2],
  COMMENT: MEMORY_SOURCE_REF_TYPES[3],
} as const;

/**
 * 项目引擎值域（`memory_projects.engine`，方案 §2/§3；裸 varchar(16)）。
 *
 * - `none`：**缺省**——未接引擎，Chamber 完全可用（铁约束：memory 是可选增强）；
 *   引擎动词端点返回 503 `MEMORY_UNAVAILABLE(14000)`，本地数据端点照常
 * - `hument`：接 Hument Hub（HTTP loopback）
 *
 * ⚠️ `fake` **刻意不在本值域**：FakeEngine 仅由测试注入进程内端口，production 下
 * `MEMORY_ENGINE=fake` fail-fast ——落库值域里出现 fake 即数据缺陷。
 */
export const MEMORY_ENGINES = ['none', 'hument'] as const;

/** 项目引擎 */
export type MemoryEngine = (typeof MEMORY_ENGINES)[number];

/** 命名访问视图（单源派生自 MEMORY_ENGINES，供 entity 缺省值与引擎闸命名引用） */
export const MEMORY_ENGINE = {
  NONE: MEMORY_ENGINES[0],
  HUMENT: MEMORY_ENGINES[1],
} as const;

/**
 * 项目状态值域（`memory_projects.status`，方案 §2/§5/§6；裸 varchar(16)）。
 *
 * - `active`：缺省。nominate/correct/retry/recover 要求 status=active **且** ≥1 绑定 write
 * - `archived`：归档——**写路径 409**，但 recall / 账本 / 详情**放行**（归档 ≠ 不可读）
 */
export const MEMORY_PROJECT_STATUSES = ['active', 'archived'] as const;

/** 项目状态 */
export type MemoryProjectStatus = (typeof MEMORY_PROJECT_STATUSES)[number];

/** 命名访问视图（单源派生自 MEMORY_PROJECT_STATUSES） */
export const MEMORY_PROJECT_STATUS = {
  ACTIVE: MEMORY_PROJECT_STATUSES[0],
  ARCHIVED: MEMORY_PROJECT_STATUSES[1],
} as const;

/**
 * 引擎不可用原因值域（`MEMORY_UNAVAILABLE(14000)` 的 `data.reason`，方案 §3 引擎闸 +
 * PM③ 追加 `project_engine_unbound`；裸 varchar 不入库、只走响应体）。
 *
 * 服务层的 `assertEngineAvailable` 是**唯一产出点**，两个"不可用"必须分码：
 * - `not_configured`：全局 `MEMORY_ENGINE` 未配（或 `none`）——整个部署没接引擎，
 *   处置 = 配 env 或接受"本地数据可用、引擎动词不可用"
 * - `project_engine_unbound`：全局配了，但**本项目** `memory_projects.engine` 仍是 `none`
 *   或引擎绑定列缺失——处置 = PATCH 项目绑定引擎（配置面，不是运维面）
 * - `engine_unreachable`：请求未到达引擎（连接拒绝/DNS/TLS）——同 key 重发安全
 * - `engine_timeout`：客户端超时、**无回执**（可能已在引擎侧落库）——查账本详情或 retry
 * - `engine_error`：引擎答了错误体——`data.engineCode` 透传（`MEMORY_ENGINE_ERROR(14004)`
 *   只在**没有账本态可回报**的端点用它，见该码注释）
 *
 * 二期「自助开通」四个值（仅在 `POST /memory/projects` 的自动注册分支产出；同样复用
 * `MEMORY_UNAVAILABLE(14000)` 503，**不新增错误码段位**）：
 * - `provisioning_unavailable`：Hub operator 面/launcher socket 不可达（请求未到达）——
 *   处置 = 检查 Hub 与 socket 路径；重发同参安全
 * - `provisioning_timeout`：operator 面超时、无回执（登记**可能**已在 Hub 侧落库）——
 *   处置 = 用同 slug 重试（幂等键 `chamber-provision-<slug>` 会重放），或查 Hub catalog
 * - `provisioning_conflict`：Hub 回 409（同 tenant/project 但元组不同）——**运维不一致**，
 *   需要人工对齐 Hub 侧登记与 Chamber 侧意图
 * - `provisioning_failed`：其余 operator 面错误（参数/认证/权限/未收敛的半成品态）——
 *   处置 = 读 `data.engineCode` 与 Hub 日志
 *
 * Usage 读面（`GET /memory/projects/:id/usage/summary|trace`）的三个值（同样复用
 * `MEMORY_UNAVAILABLE(14000)` 503，**不新增错误码段位**）：
 * - `engine_version_unsupported`：Hub 无 usage 路由（旧版 404）/ capabilities 缺 usage /
 *   平台 normalizer 判响应合同不符——**升级 Hub ≥ alpha.19 或等合同修复版，重试无效**
 * - `engine_data_incompatible`：上游 `schema_incompatible`（Hub 存量账本/回执无法解析或
 *   证据冲突）——**不是版本信号**，交 Hub 运维核对数据/回执，不升级、不盲重试
 * - `engine_identity_invalid`：403 `scope_denied`（binding 不存在/歧义/缺 inspect_read）或
 *   响应 target 回声不符——修项目身份/binding 授权，重试和升级都无效
 */
export const MEMORY_UNAVAILABLE_REASONS = [
  'not_configured',
  'project_engine_unbound',
  'engine_unreachable',
  'engine_timeout',
  'engine_error',
  'provisioning_unavailable',
  'provisioning_timeout',
  'provisioning_conflict',
  'provisioning_failed',
  'engine_version_unsupported',
  'engine_data_incompatible',
  'engine_identity_invalid',
] as const;

/** 引擎不可用原因 */
export type MemoryUnavailableReason = (typeof MEMORY_UNAVAILABLE_REASONS)[number];

/** 命名访问视图（单源派生自 MEMORY_UNAVAILABLE_REASONS，供服务层与 e2e 断言命名引用） */
export const MEMORY_UNAVAILABLE_REASON = {
  NOT_CONFIGURED: MEMORY_UNAVAILABLE_REASONS[0],
  PROJECT_ENGINE_UNBOUND: MEMORY_UNAVAILABLE_REASONS[1],
  ENGINE_UNREACHABLE: MEMORY_UNAVAILABLE_REASONS[2],
  ENGINE_TIMEOUT: MEMORY_UNAVAILABLE_REASONS[3],
  ENGINE_ERROR: MEMORY_UNAVAILABLE_REASONS[4],
  PROVISIONING_UNAVAILABLE: MEMORY_UNAVAILABLE_REASONS[5],
  PROVISIONING_TIMEOUT: MEMORY_UNAVAILABLE_REASONS[6],
  PROVISIONING_CONFLICT: MEMORY_UNAVAILABLE_REASONS[7],
  PROVISIONING_FAILED: MEMORY_UNAVAILABLE_REASONS[8],
  // Usage 读面（alpha.19）：三值各自的动作完全不同，见上方值域注释
  ENGINE_VERSION_UNSUPPORTED: MEMORY_UNAVAILABLE_REASONS[9],
  ENGINE_DATA_INCOMPATIBLE: MEMORY_UNAVAILABLE_REASONS[10],
  ENGINE_IDENTITY_INVALID: MEMORY_UNAVAILABLE_REASONS[11],
} as const;

/**
 * 召回视图值域（`POST /memory/projects/:id/recalls` 入参 + `memory_recall_events.view`
 * 列；裸 varchar(8)，两个值都恰好 7 字符）。
 *
 * 数据层刻意不枚举（实体注释已记），端点契约由服务层按本单源校验——**透传**给引擎，
 * 不由 Chamber 解释语义：`current` = 当前有效主张，`history` = 含被取代的历史主张。
 */
export const MEMORY_RECALL_VIEWS = ['current', 'history'] as const;

/** 召回视图 */
export type MemoryRecallView = (typeof MEMORY_RECALL_VIEWS)[number];

/** 命名访问视图（单源派生自 MEMORY_RECALL_VIEWS，供 DTO 缺省值与服务层命名引用） */
export const MEMORY_RECALL_VIEW = {
  CURRENT: MEMORY_RECALL_VIEWS[0],
  HISTORY: MEMORY_RECALL_VIEWS[1],
} as const;

/**
 * 召回空结果原因值域（召回响应的 `emptyReason`，方案 §6 recall 响应契约）。
 *
 * 三值是**互斥**的"为什么空"判据（消费方据此选文案，不是错误码）：
 * - `none`：有结果（items 非空）
 * - `no_matches`：引擎侧确实没有匹配——「换问法，或该项目尚无相关记忆」
 * - `all_filtered`：引擎返回了条目，但**全部因来源权限被过滤**——
 *   「让有权限同伴召回或申请来源权限」（不是"没有记忆"）
 */
export const MEMORY_RECALL_EMPTY_REASONS = ['none', 'no_matches', 'all_filtered'] as const;

/** 召回空结果原因 */
export type MemoryRecallEmptyReason = (typeof MEMORY_RECALL_EMPTY_REASONS)[number];

/** 命名访问视图（单源派生自 MEMORY_RECALL_EMPTY_REASONS） */
export const MEMORY_RECALL_EMPTY_REASON = {
  NONE: MEMORY_RECALL_EMPTY_REASONS[0],
  NO_MATCHES: MEMORY_RECALL_EMPTY_REASONS[1],
  ALL_FILTERED: MEMORY_RECALL_EMPTY_REASONS[2],
} as const;

/**
 * 来源引用的"回查入口"工具名值域（召回响应 `sources[].readWith.tool`）。
 *
 * 语义 = **关键使用前回查 Chamber 事实源当前版本**的入口（信任框信封的一部分）：
 * 召回正文是**冻结快照**，来源可能已改（`sources[].moved`）。四个值就是平台 MCP 面
 * 对应的读取工具（与 profile 暴露的语义工具同名，消费方不需另学一套名词）。
 */
export const MEMORY_SOURCE_READ_TOOLS = [
  'read_doc',
  'get_topic_digest',
  'follow_up_task',
  'task_controller_get_comments',
] as const;

/** 来源回查工具名 */
export type MemorySourceReadTool = (typeof MEMORY_SOURCE_READ_TOOLS)[number];

// ═══════════════════════════════════════════════════════════════════════════
// Memory 引擎投影读面（hument alpha.5 四读面 /views/*；实验性 · 仅 `memory` 分支）
//
// ⚠️ **值域单源 = Hument 合同，逐字镜像、不自造**：
//   `contracts/schema/memory-view-*.schema.json`（memory_id 投影的响应枚举）+
//   `contracts/openapi/hument-v1.yaml` 的 `MemoryView*` 参数（请求枚举）。
// 这一族**一个值都不入库**（纯响应面 / 查询参数面），与上面的库侧枚举（`memory_*` 裸 varchar
// 列）是两类东西——别把本族拿去写实体列或 DB CHECK。
//
// **请求枚举是响应枚举的「真子集」**（唯一一处刻意的不对称）：
// graph 响应的 `filters` 回声比请求多一个 `any`（"不过滤"的显式表达），故
// `MEMORY_VIEW_GRAPH_FILTERS_ANY` 单列——**请求 DTO 只用请求域，永不接受 `any`**
// （客户端传 `any` 会被引擎当非法枚举拒，平台层先挡在 DTO）。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 记忆类别值域（graph 节点 / detail 的 `memory.kind`；合同 `enum`，请求侧同名参数 `kind`）。
 *
 * 五值 = Hument 的记忆颗粒度分类，**不是**平台自有概念——平台只透传，不做语义解释
 * （与 `MEMORY_RECALL_VIEWS` 同纪律）。
 */
export const MEMORY_VIEW_MEMORY_KINDS = [
  'observation',
  'episode',
  'concept',
  'belief',
  'procedure',
] as const;

/** 记忆类别 */
export type MemoryViewMemoryKind = (typeof MEMORY_VIEW_MEMORY_KINDS)[number];

/** 命名访问（单源派生自 `MEMORY_VIEW_MEMORY_KINDS`；避免各处写裸字面量） */
export const MEMORY_VIEW_MEMORY_KIND = {
  OBSERVATION: MEMORY_VIEW_MEMORY_KINDS[0],
  EPISODE: MEMORY_VIEW_MEMORY_KINDS[1],
  CONCEPT: MEMORY_VIEW_MEMORY_KINDS[2],
  BELIEF: MEMORY_VIEW_MEMORY_KINDS[3],
  PROCEDURE: MEMORY_VIEW_MEMORY_KINDS[4],
} as const;

/**
 * 记忆状态值域（graph 节点 / detail 的 `memory.status`；请求侧同名参数 `status`）。
 *
 * ⚠️ 与库侧的 `MEMORY_NOMINATION_STATUSES`（active/superseded/withdrawn）**不同域、不同表**：
 * 那个是**Chamber 账本行**的状态，本值是**引擎侧记忆**的状态。两者同形不同源，别互相赋值
 * （账本的 `withdrawn` 在本域里没有对应值——撤回行根本没有引擎记忆）。
 */
export const MEMORY_VIEW_MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const;

/** 记忆状态 */
export type MemoryViewMemoryStatus = (typeof MEMORY_VIEW_MEMORY_STATUSES)[number];

/** 命名访问（单源派生自 `MEMORY_VIEW_MEMORY_STATUSES`） */
export const MEMORY_VIEW_MEMORY_STATUS = {
  ACTIVE: MEMORY_VIEW_MEMORY_STATUSES[0],
  SUPERSEDED: MEMORY_VIEW_MEMORY_STATUSES[1],
  ARCHIVED: MEMORY_VIEW_MEMORY_STATUSES[2],
} as const;

/**
 * 分辨率值域（R0–R4；详情页 Resolution Ladder 的五槽 + history 路径参数 `:resolution`）。
 *
 * Hument 的表示层级：R0 Label/Locator、R1 Gist、R2 Overview、R3 Working Model、R4 Deep Memory。
 * 形成默认只产 R0；`available_resolution` = 最高已有当前表示，`active_resolution` = 默认呈现层级
 * （两者**不是**同一个概念，前端分开展示）。
 */
export const MEMORY_VIEW_RESOLUTIONS = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;

/** 分辨率 */
export type MemoryViewResolution = (typeof MEMORY_VIEW_RESOLUTIONS)[number];

/** 命名访问（单源派生自 `MEMORY_VIEW_RESOLUTIONS`） */
export const MEMORY_VIEW_RESOLUTION = {
  R0: MEMORY_VIEW_RESOLUTIONS[0],
  R1: MEMORY_VIEW_RESOLUTIONS[1],
  R2: MEMORY_VIEW_RESOLUTIONS[2],
  R3: MEMORY_VIEW_RESOLUTIONS[3],
  R4: MEMORY_VIEW_RESOLUTIONS[4],
} as const;

/**
 * 锚状态值域（graph 节点的 `anchor_state`；请求侧同名参数 `anchor_state`）。
 *
 * 语义 = 该记忆的来源锚**当前**是否还能重新校验通过（`fresh` = 可，`stale` = 源已变，
 * `failed` = 校验失败，`unknown` = 未校验，`none` = 无锚）。⚠️ 响应侧另有 `any`（见
 * `MEMORY_VIEW_GRAPH_FILTERS_ANY`），本域是**请求域**。
 */
export const MEMORY_VIEW_ANCHOR_STATES = ['none', 'fresh', 'stale', 'unknown', 'failed'] as const;

/** 锚状态 */
export type MemoryViewAnchorState = (typeof MEMORY_VIEW_ANCHOR_STATES)[number];

/** 命名访问（单源派生自 `MEMORY_VIEW_ANCHOR_STATES`） */
export const MEMORY_VIEW_ANCHOR_STATE = {
  NONE: MEMORY_VIEW_ANCHOR_STATES[0],
  FRESH: MEMORY_VIEW_ANCHOR_STATES[1],
  STALE: MEMORY_VIEW_ANCHOR_STATES[2],
  UNKNOWN: MEMORY_VIEW_ANCHOR_STATES[3],
  FAILED: MEMORY_VIEW_ANCHOR_STATES[4],
} as const;

/**
 * 关系边类型值域（graph `edges[].type` 与 detail `relations.items[].type`；请求侧 `relation_type`）。
 *
 * 五类是**引擎侧关系**，与平台账本的「更正链」（`correction_of` 取代关系）**不是同一件事**：
 * `supersedes` 只是其中一类，UI 上更正链与引擎关系边分开展示。
 */
export const MEMORY_VIEW_RELATION_TYPES = [
  'derived_from',
  'supports',
  'contradicts',
  'supersedes',
  'part_of',
] as const;

/** 关系边类型 */
export type MemoryViewRelationType = (typeof MEMORY_VIEW_RELATION_TYPES)[number];

/** 命名访问（单源派生自 `MEMORY_VIEW_RELATION_TYPES`） */
export const MEMORY_VIEW_RELATION_TYPE = {
  DERIVED_FROM: MEMORY_VIEW_RELATION_TYPES[0],
  SUPPORTS: MEMORY_VIEW_RELATION_TYPES[1],
  CONTRADICTS: MEMORY_VIEW_RELATION_TYPES[2],
  SUPERSEDES: MEMORY_VIEW_RELATION_TYPES[3],
  PART_OF: MEMORY_VIEW_RELATION_TYPES[4],
} as const;

/**
 * 记忆作用域值域（graph 节点 / detail 的 `memory.scope` / 响应 `target.scope`）。
 *
 * ⚠️ **平台恒传 `actor_private`**（Chamber 每个项目一个 workspace + 服务 actor，不跨作用域
 * 借读）：本域三值是引擎的完整值域（响应回显用），但**请求侧只可能出现 `actor_private`**
 * ——`scope` 刻意**不进 DTO**（客户端自带 scope 会被 `forbidNonWhitelisted` 拒成 400，
 * fail-closed 是设计意图，见 memory.controller 的 views 族注释）。
 */
export const MEMORY_VIEW_MEMORY_SCOPES = [
  'owner_shared',
  'workspace_shared',
  'actor_private',
] as const;

/** 记忆作用域 */
export type MemoryViewMemoryScope = (typeof MEMORY_VIEW_MEMORY_SCOPES)[number];

/** 命名访问（单源派生自 `MEMORY_VIEW_MEMORY_SCOPES`） */
export const MEMORY_VIEW_MEMORY_SCOPE = {
  OWNER_SHARED: MEMORY_VIEW_MEMORY_SCOPES[0],
  WORKSPACE_SHARED: MEMORY_VIEW_MEMORY_SCOPES[1],
  ACTOR_PRIVATE: MEMORY_VIEW_MEMORY_SCOPES[2],
} as const;

/**
 * 分辨率阶梯槽位状态值域（detail `sections.representations.ladder[].state`；5 槽恒定）。
 *
 * 四态**必须分开呈现**（前端规格）：
 * - `current_materialized`：该层有当前表示（`current` 非 null）
 * - `historical_only`：该层只有旧版本（`historical_count > 0` 且无当前）
 * - `missing_within_available`：该层低于 `available_resolution` 却没有表示 = **引擎侧数据不完整**
 * - `beyond_available`：该层高于 `available_resolution` = 尚未晋升（正常态）
 *
 * `missing_*` 是异常信号，与 `beyond_*` 合并会把它抹平。
 */
export const MEMORY_VIEW_LADDER_STATES = [
  'current_materialized',
  'historical_only',
  'missing_within_available',
  'beyond_available',
] as const;

/** 分辨率阶梯槽位状态 */
export type MemoryViewLadderState = (typeof MEMORY_VIEW_LADDER_STATES)[number];

/** 命名访问（单源派生自 `MEMORY_VIEW_LADDER_STATES`） */
export const MEMORY_VIEW_LADDER_STATE = {
  CURRENT_MATERIALIZED: MEMORY_VIEW_LADDER_STATES[0],
  HISTORICAL_ONLY: MEMORY_VIEW_LADDER_STATES[1],
  MISSING_WITHIN_AVAILABLE: MEMORY_VIEW_LADDER_STATES[2],
  BEYOND_AVAILABLE: MEMORY_VIEW_LADDER_STATES[3],
} as const;

/**
 * graph **响应** `filters` 回声里带 `any` 的过滤器键名（**不是值域，是键名清单**）。
 *
 * 唯一不对称处：请求侧六个过滤器参数（kind / status / active_resolution /
 * available_resolution / anchor_state / relation_type）在响应里各多一个 `any` 值——
 * 「本次没有按这个维度过滤」的显式表达。本常量存在的意义 = 让"响应域 ⊋ 请求域"这件事
 * 有唯一的机器可读落点：服务层据此解释回声、DTO 据此拒绝 `any`、文档据此写清两套域。
 *
 * ⚠️ 键名是**响应侧**的（snake_case，与引擎回声逐字一致），**不是** DTO 属性名。
 */
export const MEMORY_VIEW_GRAPH_FILTERS_ANY = [
  'kind',
  'status',
  'active_resolution',
  'available_resolution',
  'anchor_state',
  'relation_type',
] as const;

/** graph 响应 filters 回声里带 `any` 的过滤器键名 */
export type MemoryViewGraphFilterKey = (typeof MEMORY_VIEW_GRAPH_FILTERS_ANY)[number];
