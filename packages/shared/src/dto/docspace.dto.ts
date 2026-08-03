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
