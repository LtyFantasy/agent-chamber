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
  /** 413 — 单文件超过 ATTACHMENT_MAX_BYTES（默认 8MiB）；注意配额超限是 12003(403) 不是本码 */
  ATTACHMENT_TOO_LARGE = 12001,
  /** 400 — 魔数嗅探不命中图片白名单（png/jpeg/gif/webp），不信任客户端声明的 Content-Type */
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
   * 决策记录与多租户捡回条件见线上 `docs/experience-base.md` §11。
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
}

/**
 * 话题类型（topics.kind 列值域，设计 docs/roundtable-design.md §5；review-0831 任务 150bf876）
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
 *   provider 分列，口径以线上 `docs/experience-base.md` §12 为准；历史行里的 JSON-RPC error
 *   标签来自已退役的 `jev` MCP 传输（v1.83.0 起不再产生）
 * - `timeout`：超过 `JUDGMENT_TIMEOUT_MS`（默认 8s）硬顶
 * - `skipped`：**限流跳过**（未调用 provider）——`request` 写占位
 *   `{skipped:true, reason:'judgment_rate_limited'}`，`response` 为 null，
 *   **同样计入 actor 判断额度**（行写入有界，防日志表被刷爆）
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
