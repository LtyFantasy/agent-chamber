/**
 * DocSpace 模块 — 输入 DTO
 *
 * 定义创建/更新操作的请求 Shape。
 * 所有输入 DTO 不包含 id、createdAt 等服务端生成字段。
 */
import { Visibility } from '../enums';

/**
 * 创建 DocSpace 输入
 */
export interface CreateDocSpaceInput {
  /** 空间名称 */
  name: string;
  /** URL 友好标识（不传则应用层从 name 推导） */
  slug?: string;
  /** 空间描述 */
  description?: string;
  /** 绑定话题 ID（与 boardId 二选一） */
  topicId?: string;
  /** 绑定看板 ID（与 topicId 二选一） */
  boardId?: string;
  /** 可见性，缺省 open */
  visibility?: Visibility;
  /** 邀请的 Agent IDs */
  invitedAgentIds?: string[];
}

/**
 * 空间级 overview 默认过滤（v1.38 起，存 `space.settings.overviewFilter`）
 *
 * 语义：仅当请求未显式传同维度 per-call 参数时生效（按维度覆盖：传了 type 或 excludeType 任一即抑制 excludeTypes，category 维度同理）；
 * `applySpaceDefaults=false` 时整体忽略。只含 exclude 维度（默认视图 = 全量减噪音）。
 */
export interface DocSpaceOverviewFilter {
  /** 默认排除的 docType 列表（如 ['memory'] 排除日记类高频噪音） */
  excludeTypes?: string[];
  /** 默认排除的 category slug 列表 */
  excludeCategories?: string[];
}

// ─── 空间词表（DocSpace 元数据治理 1 期，v1.92.0-dev）────────────────────
//
// 三个词表字段存 `doc_spaces.settings` jsonb（懒写键，无 DDL migration，照
// overviewFilter 先例）。语义 = **advisory 软校验**：词表只声明「推荐/规范值」，
// 不是写入闸门（不拒绝词表外的 docType/tag，只做 alias 归一与状态标注）。
// 逐字段上限常量与 DTO 校验装饰器共用，单一事实来源。

/** 空间声明 docType 词表上限（数组项数） */
export const DOC_SPACE_DOC_TYPES_MAX = 50;
/** 空间声明 docType 单值长度上限（对齐 docs.doc_type varchar(64)） */
export const DOC_SPACE_DOC_TYPE_MAX_LENGTH = 64;
/** 空间声明 canonical tag 条目上限（数组项数） */
export const DOC_SPACE_CANONICAL_TAGS_MAX = 200;
/** canonical tag 的 value 长度上限（对齐 upsert tags 单值上限 50） */
export const DOC_SPACE_TAG_MAX_LENGTH = 50;
/** 单个 canonical tag 的 aliases 数组项上限 */
export const DOC_SPACE_TAG_ALIASES_MAX = 20;
/** 空间声明 pathPrefix→docType 映射上限（数组项数） */
export const DOC_SPACE_PATH_TYPES_MAX = 50;
/** pathPrefix 长度上限 */
export const DOC_SPACE_PATH_PREFIX_MAX_LENGTH = 255;

/**
 * 规范标签声明（settings.canonicalTags 元素）
 *
 * `value` = canonical 落库形态（写入归一的目标值）；`aliases` = 归一命中的别名清单
 * （大小写不敏感匹配，**可选**——缺省等价于空表，消费方一律 `?? []`）。
 * 归一后写 `value`，未命中则原样落库。
 */
export interface DocSpaceCanonicalTag {
  /** 规范值（归一目标；≤50 字符，空间内大小写不敏感唯一） */
  value: string;
  /** 别名清单（可选；≤20 项、每项 ≤50 字符；不得与其他 canonical/alias 冲突） */
  aliases?: string[];
}

/**
 * 路径前缀 → docType 声明（settings.pathTypes 元素）
 *
 * 本期**纯声明**（写路径零消费，2 期 hint 消费）；匹配语义 = 前缀字串匹配，
 * pathPrefix 不强制尾斜杠，按原样存。
 */
export interface DocSpacePathType {
  /** 路径前缀（≤255 字符，空间内唯一；不强制尾斜杠，按原样存） */
  pathPrefix: string;
  /** 该前缀下的推荐 docType（≤64 字符；**不做** ∈ docTypes 跨字段校验，词表是 advisory） */
  docType: string;
}

// ─── hint 族开关（DocSpace 元数据治理 2 期，v1.92.0-dev）─────────────────
//
// `settings.hintToggles` 逐族 opt-in boolean map（懒写键，无 DDL migration）。
// 语义 = **稀疏触发默认面**：缺省/缺键/非 boolean 一律视为「关」，族关时该族
// 的 hint 计算与全部相关 IO（tag 池 / category 池 / route 查询 / path 存在性
// 轻查）都不发生（零行为变化、零额外查询）。
//
// 为什么默认全关：hint 疲劳是最大风险（收敛帖共识）——提示只在空间维护者
// 显式开启后才出现，且只出确定性项、单响应 ≤3 条、带去重窗口（见 DocHint）。

/**
 * hint 族清单（`settings.hintToggles` 的合法键集合，单一事实来源）
 *
 * - `metadata`：missing_category / empty_tags / empty_summary（正式文档面适用；
 *   日记主导空间慎开——写日记无 category 是常态，属周期噪音）；
 * - `tags`：tag_near_dup（近义 tag 候选）；
 * - `categories`：category_near_dup（近义分类候选）；
 * - `pathType`：path_type_mismatch（另需 `settings.pathTypes` 已声明，否则无判定依据）；
 * - `routes`：route_target_excluded / route_anchor_recheck / route_anchor_broken；
 * - `read`：query_looks_like_path / suggest_relaxing（搜索读侧）。
 *
 * ⚠️ `tags_normalized` **不属于任何族**——它是「归一已发生」的事实回显
 * （status=normalized），不做开关、不做去重，与 `tagNormalizations` 字段双通道并存。
 */
export const DOC_HINT_FAMILIES = [
  'metadata',
  'tags',
  'categories',
  'pathType',
  'routes',
  'read',
] as const;

/** DOC_HINT_FAMILIES 元素联合（'metadata' | 'tags' | 'categories' | 'pathType' | 'routes' | 'read'） */
export type DocHintFamily = (typeof DOC_HINT_FAMILIES)[number];

/**
 * hint 族开关（`settings.hintToggles`，v1.92.0-dev 2 期）
 *
 * 六族可选 boolean；缺键 = 该族关。merge 语义与 overviewFilter / 词表三键一致：
 * 字段出现即整键替换、显式 null 删键、未传保留。未知族键 → 422（fail-fast 配置）。
 */
export interface DocSpaceHintToggles {
  /** metadata 族：missing_category / empty_tags / empty_summary */
  metadata?: boolean;
  /** tags 族：tag_near_dup */
  tags?: boolean;
  /** categories 族：category_near_dup */
  categories?: boolean;
  /** pathType 族：path_type_mismatch（需 pathTypes 已声明） */
  pathType?: boolean;
  /** routes 族：route_target_excluded / route_anchor_recheck / route_anchor_broken */
  routes?: boolean;
  /** read 族：query_looks_like_path / suggest_relaxing */
  read?: boolean;
}

/**
 * 更新 DocSpace 输入
 */
export interface UpdateDocSpaceInput {
  /** 空间名称 */
  name?: string;
  /** 空间描述；显式 null = 清空（空串 '' 被 DTO 层 @MinLength(1) 拒绝为 400） */
  description?: string | null;
  /** 可见性 */
  visibility?: Visibility;
  /** 换绑：绑定 topic（与 boardId 二选一）；显式 null = 解除该侧绑定（两侧皆 null = 完全解绑） */
  topicId?: string | null;
  /** 换绑：绑定 board（与 topicId 二选一）；显式 null = 解除该侧绑定 */
  boardId?: string | null;
  /**
   * 空间级 overview 默认过滤；显式 null = 清除（「字段出现即采用」语义，对齐 P2-#15）。
   * creator 可配置空间默认视图；per-call 查询参数逐字段覆盖。
   */
  overviewFilter?: DocSpaceOverviewFilter | null;
  /**
   * 空间 docType 词表（settings.docTypes）；显式 null = 清除该键，未传 = 保留旧值。
   * 大小写不敏感去重（重复 → 422 DOC_SPACE_VOCABULARY_INVALID）。
   */
  docTypes?: string[] | null;
  /**
   * 空间规范标签词表（settings.canonicalTags）；显式 null = 清除该键，未传 = 保留旧值。
   * 供 upsert / patch_doc_metadata 写路径的 tag alias 归一消费。
   */
  canonicalTags?: DocSpaceCanonicalTag[] | null;
  /**
   * 空间路径前缀→docType 声明（settings.pathTypes）；显式 null = 清除该键，未传 = 保留旧值。
   * 本期纯声明（无写路径消费）。
   */
  pathTypes?: DocSpacePathType[] | null;
  /**
   * hint 族开关（settings.hintToggles，v1.92.0-dev 2 期）；显式 null = 清除该键，
   * 未传 = 保留旧值。缺省（全关）= 稀疏触发默认面；未知族键 → 422。
   */
  hintToggles?: DocSpaceHintToggles | null;
}

/**
 * 创建 DocCategory 输入
 */
export interface CreateDocCategoryInput {
  /** 分类名称 */
  name: string;
  /** URL 友好标识（不传则应用层从 name 推导） */
  slug?: string;
  /** 分类描述 */
  description?: string;
  /** 排序顺序 */
  sortOrder?: number;
}

/**
 * 更新 DocCategory 输入
 */
export interface UpdateDocCategoryInput {
  /** 分类名称 */
  name?: string;
  /** URL 友好标识 */
  slug?: string;
  /** 分类描述 */
  description?: string;
  /** 排序顺序 */
  sortOrder?: number;
}

/**
 * 创建 doc_route 输入（v1.42 批次 B5：INDEX.md 意图路由结构化）
 *
 * 语义：intent（"我要…"）→ primaryDoc+headingPath（先看）→ secondaryDoc（再看）→ codeEntry（代码入口）。
 * 写时校验（Service 层，铁律 #21/#22）：doc 必须存在且属于该空间、headingPath 非空时须精确命中
 * doc_sections.heading_path、codeEntry 禁绝对路径与 `..` 段。
 */
export interface CreateDocRouteInput {
  /** 用户意图描述（"我要…"），如 "我要了解系统架构" */
  intent: string;
  /** 路由分组（可空），如 "architecture"、"troubleshooting" */
  category?: string;
  /** 主文档 ID（必填，路由的第一步跳转） */
  primaryDocId: string;
  /** 主文档定位锚点（doc_sections.heading_path 精确匹配，可空 = 文档级） */
  primaryHeadingPath?: string;
  /** 次文档 ID（可空，看完主文档后需要再看时跳转） */
  secondaryDocId?: string;
  /** 次文档定位锚点（可空） */
  secondaryHeadingPath?: string;
  /** 代码入口（仓库内相对路径，如 `apps/backend/src/modules/docspace/doc.service.ts`；禁绝对路径与 `..`） */
  codeEntry?: string;
  /** 排序权重（同空间内 ASC 升序展示，缺省 0） */
  sortOrder?: number;
}

/**
 * 更新 doc_route 输入（Partial 语义；PATCH 改 primary/secondary doc 或 headingPath 时重新走写时校验）
 */
export type UpdateDocRouteInput = Partial<CreateDocRouteInput>;

/**
 * Upsert 文档输入（PUT by space+path）
 */
export interface UpsertDocInput {
  /** 文档路径，space 内定位锚点（必填，upsert 幂等键之一） */
  path: string;
  /** Markdown 正文 */
  content: string;
  /** 文档标题（不传则尝试从 content 首个标题推导） */
  title?: string;
  /** 摘要（不传则应用层取首段） */
  summary?: string;
  /** 文档类型，用户自定义 */
  docType?: string;
  /** 分类名称（按名解析，不存在则自动创建） */
  category?: string;
  /** 标签列表 */
  tags?: string[];
  /** 文档来源（仅 ingest 适配器可设非 native 值；MCP 不可指定） */
  source?: string;
}

/**
 * 文档源哨兵值：'native'（平台 API/MCP 可写；review-0831 任务 8fab2a9d 上移 shared 单源）
 * - source 是开放字符串（ingest 来源如 'git:xxx' 不枚举），但 'native' 是保留语义值——
 *   native-only 写通道（patch/append/move/delete 的 source 隔离检查）的判别点，
 *   拼错无编译期保护，故收口为常量供全仓引用。
 * - 原 backend 模块常量 docspace/doc-constants.ts 已改 re-export 保持兼容。
 */
export const DOC_SOURCE_NATIVE = 'native' as const;

/**
 * 文档摘要列长上限（docs.summary varchar(500)；review-0831 任务 e013af33 收敛）
 *
 * 单源供三处引用：entity 列长装饰器 / UpsertDocDto @MaxLength / service 截断
 * （extractFirstParagraph 与 diagram summary 派生）。⚠️ 改此值必须配套 TypeORM
 * migration 变更 docs.summary 列长（生产库禁止直接改列，铁律 §0.2）。
 */
export const DOC_SUMMARY_MAX_LENGTH = 500;

/**
 * 文档标题列长上限（docs.title varchar(200)；review-0831 任务 e013af33 收敛）
 *
 * 单源供三处引用：entity 列长装饰器 / UpsertDocDto @MaxLength / service 截断
 * （IR meta.title 派生）。⚠️ 改此值必须配套 TypeORM migration 变更 docs.title
 * 列长（生产库禁止直接改列，铁律 §0.2）。
 */
export const DOC_TITLE_MAX_LENGTH = 200;

/**
 * 追加位置（POST /docs/:id/append 的 position 参数）
 *
 * - 'end'（缺省）：追加到文档末尾；
 * - 'under-heading'：追加到指定 heading 小节子树末尾（需配 headingPath 精确匹配）。
 */
export type AppendPosition = 'end' | 'under-heading';

/** AppendPosition 合法值清单（DTO @IsIn 校验与 swagger enum 共用，单一事实来源） */
export const APPEND_POSITION_VALUES: readonly AppendPosition[] = ['end', 'under-heading'];

/**
 * 追加文档内容输入（POST /docs/:id/append，v1.65.0 消费者反馈批 7601e2f5）
 *
 * 语义：一步把 content 追加到文档末尾（position='end'，默认）或指定 heading 小节
 * 末尾（position='under-heading' + headingPath 精确匹配）。服务端内部消化并发冲突
 * （DOC_CONTENT_CONFLICT 自动重读重写，最多 3 次）——调用方无需 read→patch 三步。
 */
export interface AppendDocInput {
  /** 追加的 Markdown 内容（非空、非全空白；可自带标题行触发新 section） */
  content: string;
  /** 追加位置：'end'（文档末尾，默认）| 'under-heading'（指定小节子树末尾） */
  position?: AppendPosition;
  /** position='under-heading' 时必填：目标节的 heading_path 精确匹配（0 命中 404 / 多命中 409） */
  headingPath?: string;
}

/**
 * 添加/移除 Space 成员输入
 */
export interface SpaceMemberInput {
  /** Agent ID */
  agentId: string;
}

/**
 * Task-Doc 链接输入
 */
export interface TaskDocLinkInput {
  /** 文档 ID */
  docId: string;
}

// ─── 存量治理（DocSpace 元数据治理 3 期，v1.92.0-dev）──────────────────────
//
// 批量 tag rename/merge 与 category merge 的模块级输入形状。HTTP 层校验类
// （class-validator）在 apps/backend/src/modules/docspace/dto/ 下，本文件只承载
// 与传输无关的语义形状（对齐 CreateDocSpaceInput 等既有惯例）。

/**
 * 存量 tag rename/merge 输入（POST /doc-spaces/:id/tags/rename）
 *
 * rename = `from` 单元素；merge = `from` 多元素（或 `to` 已是既有值）。存储层语义同一
 * ——把 `from` 里每个值替换为 `to`，不拆两个端点（plan D1）。
 */
export interface RenameDocTagsInput {
  /**
   * 待替换的旧 tag 值数组（trim 后非空、**字节精确**去重；与 `to` **字节全等**的值剔除，
   * 全被剔除 → 422）。⚠️ ci 变体（`NPC` / `NpC`）**全部保留**——它们是不同的存量存储值，
   * 都要进改写集合与词表 aliases（ci 合并会漏召回，见 `normalizeTagRenameValues`）。
   */
  from: string[];
  /** 目标 tag 值（trim 后**非空**：DTO 层 400 / Service 层 422；成为 canonical 声明值） */
  to: string;
  /** true = 只预演（受影响清单 + 词表变换计划 + batchToken），零副作用零审计零幂等占用 */
  dryRun?: boolean;
  /** dryRun 返回的批次快照 token；execute 传入做并发冲突检测（不符 → 409 DOC_BATCH_CONFLICT） */
  expectedBatchToken?: string;
  /** 幂等键（可选，1~64 字符；重放返回首次响应快照 + idempotentReplay） */
  idempotencyKey?: string;
}

/**
 * DocCategory merge 输入（POST /doc-categories/:id/merge）
 *
 * 把 source（路径参数 `:id`）下的文档重指向 target，并软删 source。category 无 alias
 * 机制（词表只有 canonicalTags 承载 aliases）——merge 后旧 slug 查询即空，响应显式告知。
 */
export interface MergeDocCategoryInput {
  /** 目标分类 ID（同空间、未软删；与 source 相同 → 422） */
  targetId: string;
  /** true = 只预演（受影响文档 + 软引用影响面 + batchToken），零副作用零审计零幂等占用 */
  dryRun?: boolean;
  /** 幂等键（可选，1~64 字符；重放返回首次响应快照 + idempotentReplay） */
  idempotencyKey?: string;
}

/**
 * orphan 文档清单查询（GET /doc-spaces/:id/docs/orphans）
 *
 * 只读诊断面：`deleted_at IS NULL` 且 id ∉ routes(primary ∪ secondary) 的文档。
 * 「route 指向已删 doc」属断链面（RouteHealthService），**不算 orphan**（两个维度不混）。
 * 默认应用 `settings.overviewFilter` 的 excludeTypes/excludeCategories（导航面语义同源）。
 */
export interface OrphanDocsQuery {
  /** 页码（缺省 1） */
  page?: number;
  /** 每页条数（缺省 20，上限 100） */
  pageSize?: number;
  /** true = 不做 overviewFilter 默认排除，返回全量 orphan */
  includeExcluded?: boolean;
  /** 路径前缀过滤（LIKE 字面前缀语义，复用 escapeLikePrefix 单源） */
  pathPrefix?: string;
}
