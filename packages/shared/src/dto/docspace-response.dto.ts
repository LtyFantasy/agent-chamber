/**
 * DocSpace 模块 — 响应 DTO
 *
 * 定义列表/详情视图、搜索命中、概览等响应 Shape。
 * 遵循项目惯例：列表视图不含大字段（description 摘要化、不含 content）。
 */
import { Visibility } from '../enums';

// ─── DocSpace ────────────────────────────────────────────

/**
 * DocSpace 摘要（列表视图）
 */
export interface DocSpaceSummary {
  /** 空间 ID */
  id: string;
  /** 空间名称 */
  name: string;
  /** URL slug */
  slug: string;
  /** 描述片段：≤200 字符截断 */
  descriptionSnippet?: string | null;
  /** 绑定话题 ID */
  topicId?: string | null;
  /** 绑定看板 ID */
  boardId?: string | null;
  /** 可见性 */
  visibility?: Visibility;
  /** 创建者 ID */
  creatorId?: string;
  /** 文档计数 */
  docCount?: number;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * DocSpace 详情（聚合视图）
 */
export interface DocSpaceDetail extends DocSpaceSummary {
  /** 完整描述 */
  description: string | null;
  /** 关联任务计数（该空间非删除文档经 task_doc_links 关联的去重任务数） */
  linkedTaskCount?: number;
  /** 分类列表 */
  categories?: DocCategoryDto[];
  /** 成员列表 */
  members?: DocSpaceMemberDto[];
}

// ─── Member ──────────────────────────────────────────────

/**
 * DocSpace 成员
 */
export interface DocSpaceMemberDto {
  /** 成员 Actor ID */
  actorId: string;
  /** 成员名称 */
  actorName?: string;
  /** 成员类型 */
  actorType?: 'human' | 'agent';
  /** 角色：editor | member */
  role: string;
  /** 邀请者 Actor ID */
  invitedBy?: string | null;
  /** 加入时间 */
  createdAt?: string | Date;
}

// ─── Category ────────────────────────────────────────────

/**
 * DocCategory 摘要
 */
export interface DocCategoryDto {
  /** 分类 ID */
  id: string;
  /** 所属空间 ID */
  spaceId: string;
  /** 分类名称 */
  name: string;
  /** URL slug */
  slug: string;
  /** 分类描述 */
  description?: string | null;
  /** 排序顺序 */
  sortOrder?: number;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

// ─── Doc ─────────────────────────────────────────────────

/**
 * 文档摘要（列表视图，不含正文）
 */
export interface DocSummary {
  /** 文档 ID */
  id: string;
  /** 所属空间 ID */
  spaceId: string;
  /** 分类 ID */
  categoryId?: string | null;
  /** 文档路径 */
  path: string;
  /** 文档标题 */
  title: string;
  /** 摘要（≤500 字符） */
  summary?: string | null;
  /** 文档类型 */
  docType?: string | null;
  /** 标签 */
  tags?: string[];
  /** 文档来源 */
  source?: string;
  /** Section 数量 */
  sectionCount?: number;
  /** Token 估算总量 */
  tokenEstimate?: number;
  /** 创建者 ID */
  createdBy?: string;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * 文档详情（含元数据 + section 大纲，不含正文）
 * MCP read_doc（无定位参数）返回此结构。
 */
/**
 * 链接健康巡检结果
 *
 * 写入时机：upsert 事务内 chunking 后顺带计算。
 * NULL 表示尚未检查（兼容旧数据）。
 */
export interface LinkHealth {
  /** 检测到的平台内链接总数 */
  total: number;
  /** 断链 href 列表（去重、保持出现顺序），无断链时为空数组 */
  broken: string[];
  /** 检查时间戳 ISO 8601 */
  checkedAt: string;
}

export interface DocDetail extends DocSummary {
  /** Section 大纲列表（仅元数据，不含 content；mode='full' 时仍返回以便定位） */
  sections?: DocSectionOutline[];
  /** 链接健康巡检结果（v1.35 Docs D1 Wave A；NULL = 尚未检查） */
  linkHealth?: LinkHealth | null;
  /**
   * 响应模式（增量字段，向后兼容——老客户端无此字段时按 outline 处理）：
   * - 'full'：无定位调用（无 position/headingPath）+ 小文档（tokenEstimate > 0 且 ≤ 阈值）
   *   时内联全文，`content` 同时返回；
   * - 'outline'：大文档 / tokenEstimate=0（未估算）/ 强制 outline（maxFullTokens=0）——
   *   仅大纲，无 content。
   */
  mode?: 'outline' | 'full';
  /**
   * mode='full' 时的全文。渲染去重语义与 web /content 默认一致：
   * position 0 的 H1 若与 doc.title 同名则不重复插标题行（web header 已展示 title）。
   */
  content?: string;
}

/**
 * Section 大纲项（不含正文）
 */
export interface DocSectionOutline {
  /** 篇内顺序（对外定位锚点，position 跨更新稳定） */
  position: number;
  /** 层级标题路径 */
  headingPath?: string | null;
  /** 标题层级 0-6 */
  headingLevel: number;
  /** Token 估算（本 section） */
  tokenEstimate?: number;
}

/**
 * 单 Section 正文（按 position 或 headingPath 读取时返回）
 */
export interface DocSectionContent {
  /** 文档 ID */
  docId: string;
  /** 文档路径 */
  docPath: string;
  /** 篇内顺序 */
  position: number;
  /** 层级标题路径 */
  headingPath?: string | null;
  /** 标题层级 */
  headingLevel: number;
  /** Section 正文 */
  content: string;
  /** Token 估算 */
  tokenEstimate?: number;
}

/**
 * 文档全文（拼接所有 sections，仅 web 渲染使用）
 */
export interface DocFullContent {
  /** 文档 ID */
  docId: string;
  /** 文档路径 */
  docPath: string;
  /** 文档标题 */
  title: string;
  /** 拼接全文 */
  content: string;
}

// ─── Search ──────────────────────────────────────────────

/**
 * 文档搜索命中项
 * 按 position 定位（替代不稳定 sectionId）
 */
export interface DocSearchHit {
  /** 文档 ID */
  docId: string;
  /** 文档路径 */
  docPath: string;
  /** 文档标题 */
  docTitle: string;
  /** 命中 section 的 position */
  position: number;
  /** 命中 section 的 headingPath */
  headingPath?: string | null;
  /** 搜索片段（≤300 字符截断） */
  snippet: string;
  /** 片段是否被截断 */
  contentTruncated?: boolean;
  /** 相关性分数 */
  score: number;
}

// ─── Overview ────────────────────────────────────────────

/**
 * overview 实际生效的过滤条件回显（appliedFilters，v1.38 起）
 *
 * 回显 per-call 查询参数与空间级默认过滤合并后的最终条件（与请求词表一一对应），
 * 便于 Agent 调试「为什么地图里少了 X」。未生效的维度不出现。
 */
export interface DocSpaceOverviewAppliedFilters {
  /** 生效的 docType 白名单（type=） */
  types?: string[];
  /** 生效的 docType 黑名单（excludeType=，含空间默认 excludeTypes） */
  excludeTypes?: string[];
  /** 生效的 category slug 白名单（category=） */
  categories?: string[];
  /** 生效的 category slug 黑名单（excludeCategory=，含空间默认 excludeCategories） */
  excludeCategories?: string[];
  /** 生效的 tag 过滤（tag=） */
  tag?: string;
  /** 生效的路径前缀（pathPrefix=，如 "memory/"） */
  pathPrefix?: string;
  /** 实际使用的 token 上限（仅显式传参时回显；缺省 4000 不回显） */
  maxTokens?: number;
}

/**
 * DocSpace 概览（紧凑地图）
 * 结构化展示所有分类及其下文档的摘要信息。
 */
export interface DocSpaceOverview {
  /** 空间 ID */
  spaceId: string;
  /** 空间名称 */
  spaceName: string;
  /** 分类树 */
  categories: DocCategoryOverview[];
  /** 未分类文档 */
  uncategorized: DocSummary[];
  /** 总 token 估算 */
  totalTokenEstimate?: number;
  /** 是否因 token 上限截断 */
  truncated?: boolean;
  /** 实际生效的过滤条件回显（未传任何过滤且无空间默认时缺省） */
  appliedFilters?: DocSpaceOverviewAppliedFilters;
}

/**
 * 概览中的分类视图（含下属文档）
 */
export interface DocCategoryOverview extends DocCategoryDto {
  /** 本分类下的文档摘要列表 */
  docs: DocSummary[];
}

// ─── Task-Doc Link ───────────────────────────────────────

/**
 * 任务关联文档项
 * 嵌入 TaskDetail.docs 数组
 */
export interface TaskDocLinkItem {
  /** 文档 ID */
  docId: string;
  /** 文档路径 */
  path: string;
  /** 文档标题 */
  title: string;
  /** 摘要 */
  summary?: string | null;
}

// ─── Upsert Result ───────────────────────────────────────

/**
 * Upsert 文档结果
 */
export interface UpsertDocResult {
  /** 文档 ID */
  id: string;
  /** 文档路径 */
  path: string;
  /** Section 数量 */
  sectionCount: number;
  /** Token 估算总量 */
  tokenEstimate: number;
  /** 内容未变（contentHash 匹配） */
  unchanged?: boolean;
  /**
   * 是否为新建文档（true = 创建，false = 更新（含 23505 幂等 catch），
   * undefined = unchanged 分支不设置此字段）。
   */
  created?: boolean;
}

// ─── Batch Upsert ──────────────────────────────────────────

/**
 * 单条 batch upsert 的结果项
 */
export interface BatchUpsertItemResult {
  /** 文档路径 */
  path: string;
  /** 操作状态 */
  status: 'created' | 'updated' | 'unchanged' | 'failed';
  /** 文档 ID（success 时有值） */
  id?: string;
  /** 失败时的错误详情 */
  error?: {
    /** 错误消息 */
    message: string;
    /** 数值型业务错误码（ErrorCode 枚举值，如 10003 = DOC_SOURCE_MISMATCH） */
    code?: number;
  };
}

/**
 * 批量 upsert 响应体
 */
export interface BatchUpsertDocsResult {
  /** 逐条结果（保持请求顺序） */
  results: BatchUpsertItemResult[];
  /** 汇总计数 */
  summary: {
    /** 请求总条数 */
    total: number;
    /** 新建数 */
    created: number;
    /** 更新数 */
    updated: number;
    /** 未变数 */
    unchanged: number;
    /** 失败数 */
    failed: number;
  };
}
