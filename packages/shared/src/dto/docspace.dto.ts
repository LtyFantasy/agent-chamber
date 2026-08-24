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
  position?: 'end' | 'under-heading';
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
