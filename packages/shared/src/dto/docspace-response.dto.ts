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
  /** 软删时间；非空 = 该成员已删除，actorName 仍可显示（历史归因保留） */
  deletedAt?: string | null;
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
  /**
   * last-verified 源码提交 sha（v1.42 B6）：内容在此 sha 验证一致（sync 适配器上报）；
   * 仅 ingest 文档（source=git:*）携带；NULL/缺省 = 无验证记录（native 或旧数据）。
   */
  sourceSha?: string | null;
  /**
   * 原始写入 payload 的 SHA-256（乐观锁 token，v1.62.0）。**与读出正文不可互算**：
   * 读路径内容 = doc_sections 重建产物（CRLF→LF / 去 frontmatter / 段 trim / 标题行
   * 重新注入），其 SHA-256 ≠ 本值。乐观锁（expectedContentHash）一律用响应返回的
   * token，禁止对读出文本自算 SHA。docs.content_hash 为 nullable 列——本字段可选，
   * 缺省 = 无 contentHash（旧数据/未写入）。
   */
  contentHash?: string | null;
  /**
   * 断链计数（v1.42 B6，仅 overview 装配）：从 link_health jsonb broken 数组取 length。
   * 无 linkHealth（NULL = 尚未检查）时省略该键——与"已检查且 0 断链"区分。
   */
  brokenLinkCount?: number;
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
 * 文档摘要 slim 投影（v1.56，overview?slim=true 专用）
 *
 * 只保留地图导航字段：{path, title, summary, docType, tokenEstimate}——
 * 摘要是地图条目的 token 大头，slim 场景（大空间冷启动）下其余元数据
 * （id/spaceId/tags/source/sourceSha/断链计数/时间戳/创建者）一律省略，
 * 需要明细走 read_doc / list_docs 全字段通道。
 */
export interface DocSummarySlim {
  /** 文档路径 */
  path: string;
  /** 文档标题 */
  title: string;
  /** 摘要（≤500 字符） */
  summary?: string | null;
  /** 文档类型 */
  docType?: string | null;
  /** Token 估算总量 */
  tokenEstimate?: number;
}

/**
 * 文档摘要 catalog 投影（v1.66，overview?catalog=true 专用）
 *
 * 只保留目录三键：{path, title, tokenEstimate}——tokenEstimate 是消费方决定
 * "要不要 read_doc 读全文"的唯一预算依据（R3 保留理由）。summary/docType 等
 * 一并省略（比 slim 更瘦）；目录完整性由服务端豁免 maxTokens 截断保证，
 * category 归属由分组结构承载。
 */
export interface DocSummaryCatalog {
  /** 文档路径 */
  path: string;
  /** 文档标题 */
  title: string;
  /** Token 估算总量（读全文的成本预算依据） */
  tokenEstimate?: number;
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

/**
 * 路由健康巡检 issue 单项（doc_routes.health，v1.42 批次 C1/C2）
 *
 * - 'heading'（C1）：headingPath 悬空（primary/secondary 锚点）；
 * - 'codeEntry'（C2）：仓库 manifest 级联校验未命中（codeEntry 不在 repoManifest.files）。
 */
export interface RouteHealthIssue {
  /** issue 类别：'heading' = 定位锚点悬空；'codeEntry' = 代码入口失配 */
  kind: 'heading' | 'codeEntry';
  /** 命中位置：'primary' | 'secondary' = 主/次文档 headingPath；'codeEntry' = 代码入口 */
  target: 'primary' | 'secondary' | 'codeEntry';
  /** 未解析的原始引用值（headingPath 原文或 codeEntry 原文） */
  value: string;
}

/**
 * 路由健康巡检结果（doc_routes.health jsonb，v1.42 批次 C1/C2）
 *
 * 写入时机：route-health.service.recheckSpace（upsert 内容变更 / remove / 手动 recheck 端点
 * 三触发点异步重检）。
 * 语义：空 issues = 健康；NULL = 尚未检查（对齐 LinkHealth「无数据 ≠ 零断链」）。
 *
 * codeEntryStatus（C2 + T5 扩展，codeEntry 非空时出现）：'ok' = 精确命中或目录前缀命中
 * repoManifest.files；'broken' = 有 manifest 且不命中（issues 同时含 kind:'codeEntry'）；
 * 'unchecked' = 空间无 repoManifest（不算 broken——「从未上报清单」≠「代码入口失配」）；
 * 'exempt' = codeEntryType 为 'pattern'（glob 泛化写法），豁免精确存在性校验，不算 broken
 * （codeEntryNote 附豁免原因）。codeEntry 为空时省略该键。
 */
export interface RouteHealth {
  /** issue 列表，空数组 = 健康 */
  issues: RouteHealthIssue[];
  /** codeEntry 级联校验状态（C2/T5；仅 codeEntry 非空时携带，详见类型注释） */
  codeEntryStatus?: 'ok' | 'broken' | 'unchecked' | 'exempt';
  /** 豁免说明（T5；仅 codeEntryStatus='exempt' 时携带）：pattern 型路由不参与精确存在性校验的原因 */
  codeEntryNote?: string;
  /** 检查时间戳 ISO 8601 */
  checkedAt: string;
}

/**
 * 仓库文件清单（doc_spaces.settings.repoManifest jsonb，v1.42 批次 C2）
 *
 * 写入时机：scripts/sync-docs.mjs 每次同步末尾 PUT /doc-spaces/:id/repo-manifest
 * （git ls-files 全量清单 + HEAD sha，原子 jsonb_set 覆写——对齐 board metrics 先例）。
 * 消费方：route-health.service.recheckSpace 对每条路由 codeEntry 做存在性级联校验。
 * reportedAt 由服务端生成（不信客户端时钟）。
 */
export interface RepoManifest {
  /** 上报时的 git HEAD commit sha（≤64；清单所对应的仓库版本） */
  sha: string;
  /** git ls-files 全量相对路径清单（仓库内路径，禁绝对路径与 `..` 段；≤20000 条、每条 ≤512） */
  files: string[];
  /** 服务端写入时刻 ISO 8601（非客户端上报值） */
  reportedAt: string;
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
  /** 层级标题路径（全祖先链，如 "AAA § BBB § CCC"，纯寻址地址） */
  headingPath?: string | null;
  /**
   * 本地标题（展示用；**heading_text 列直读**，如 "CCC"；headingLevel=0 文首段为 null。
   * 债 A 落地后 headingPath 退化纯寻址，标题展示禁止反解析末段——标题正文含 ` § `
   * 时反解析会切错（9a15f86 / ebe7685 两次踩坑）。headingPath 保留完整链作寻址地址
   * （headingPath= 精确定位、重名消歧），语义不变。
   */
  heading?: string | null;
  /** 标题层级 0-6 */
  headingLevel: number;
  /** Token 估算（本 section） */
  tokenEstimate?: number;
  /**
   * 本地标题原文（heading_text 列直读，债 A）。与 heading 同源，但保留原始清洗文本
   * （含行内 markdown 标记）；旧服务端/旧数据无此列时为 undefined（消费方可用
   * 提取 lastHeadingSegment 兜底）。headingLevel=0 文首段为 null。
   */
  headingText?: string | null;
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
  /**
   * 本地标题原文（heading_text 列直读，债 A）：chunker 清洗后的本地标题
   * （含行内 markdown 标记，标题正文 ` § ` 完整保留）；headingLevel=0 文首段 null；
   * 旧服务端/旧数据无此列时为 undefined（消费方可用 extractLastHeadingSegment 兜底）。
   */
  headingText?: string | null;
  /** 是否为长 section 的续 chunk；老服务端缺字段时为 undefined */
  isContinuation?: boolean;
  /** Section 正文 */
  content: string;
  /** Token 估算 */
  tokenEstimate?: number;
  /**
   * 派生锚点哈希（sha256(headingPath + '\n' + headingLevel + '\n' + content) hex，
   * 纯派生不落库）。写前提校验用：patch 时携带 expectedSectionHash 比对，
   * 防止 stale position 在 re-chunk 漂移后写错块（fail-closed）。
   */
  sectionHash?: string;
  /**
   * 保真渲染片段（renderSectionPart skipDuplicateTitle=false 口径：标题行插回 + run-dedup）。
   * 是该节在 full=true 全文中的字节级子串——可直接作 patch_doc oldString 来源 /
   * section 模式 content 参照。
   */
  markdown?: string;
}

/**
 * 批量读取的单个 section 项（GET /docs/:id/sections?positions= 响应元素）
 *
 * 与 DocSectionContent 同口径的 section 正文，但不重复携带文档级字段
 * （docId/docPath 提升到批量结果信封 DocBatchSectionsResult 上，响应最小化）。
 */
export interface DocSectionItem {
  /** 篇内顺序（0-based，与 outline/单节读同口径） */
  position: number;
  /** 层级标题路径 */
  headingPath?: string | null;
  /** 标题层级 */
  headingLevel: number;
  /**
   * 本地标题原文（heading_text 列直读，债 A）；语义同 DocSectionContent.headingText：
   * headingLevel=0 文首段 null；旧服务端/旧数据无此列时为 undefined。
   */
  headingText?: string | null;
  /** 是否为长 section 的续 chunk；老服务端缺字段时为 undefined */
  isContinuation?: boolean;
  /** Section 正文（不含标题行，chunker 契约） */
  content: string;
  /** Token 估算 */
  tokenEstimate?: number;
  /** 派生锚点哈希（与 DocSectionContent.sectionHash 同口径，写前提校验用） */
  sectionHash?: string;
  /**
   * 保真渲染片段（renderSectionPart skipDuplicateTitle=false 口径：标题行插回 + run-dedup）。
   * 是该节在 full=true 全文中的字节级子串——可直接作 patch_doc oldString 来源 /
   * section 模式 content 参照。
   */
  markdown?: string;
}

/**
 * 批量 section 读取结果（GET /docs/:id/sections?positions=1,3,5，v1.55）
 *
 * 部分失败友好：越界/不存在的 position 不整体报错，单独列入 missing；
 * 重复 position 去重（每个 position 至多返回一次）。sections 按 position ASC。
 */
export interface DocBatchSectionsResult {
  /** 文档 ID */
  docId: string;
  /** 文档路径 */
  docPath: string;
  /** 命中的 section 列表（position ASC） */
  sections: DocSectionItem[];
  /** 越界/不存在的 position 列表（请求去重后、升序） */
  missing: number[];
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
  /**
   * 原始写入 payload 的 SHA-256（乐观锁 token，v1.62.0）。content 是 sections 重建
   * 产物，其 SHA-256 ≠ 本值——乐观锁一律用本 token（expectedContentHash），禁止
   * 对读出正文自算 SHA。docs.content_hash nullable，旧数据可能缺省。
   */
  contentHash?: string | null;
}

// ─── Search ──────────────────────────────────────────────

/**
 * 文档搜索排序模式（v1.55 search_docs 翻页/时间序）
 *
 * - relevance（缺省）：双评分 + boost 融合排序（现有行为不变）；
 * - createdAt_desc / createdAt_asc：按 docs.created_at 时间序**接管 ORDER BY**——
 *   boost 融合仅适用相关度排序，时间序下不计算、不应用、不透出 boosts，
 *   score 保留 SQL 原始合成分（语义详见 DocSearchService.search 注释）。
 */
export type DocSearchSort = 'relevance' | 'createdAt_desc' | 'createdAt_asc';

/** DocSearchSort 合法值清单（DTO @IsIn 校验与 swagger enum 共用，单一事实来源） */
export const DOC_SEARCH_SORT_VALUES: readonly DocSearchSort[] = [
  'relevance',
  'createdAt_desc',
  'createdAt_asc',
];

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
  /**
   * 命中加权的可解释性透出（v1.42 批次 C3 意图融合检索）
   *
   * 三路融合：SQL SCORE_FLOOR 过滤之后，命中 doc 叠加「策展路由命中」（route）与
   * 「任务链接数」（taskLinks）两路固定倍率加权重排——只重排、不引入新结果。
   * - route: 'primary' = 该 doc 是命中路由的 primaryDoc（×1.5）；'secondary' = ×1.2。
   *   同一 doc 被多条路由命中取最大倍率，不叠加连乘。
   * - taskLinks: task_doc_links 中该 doc 的关联任务数（原始 COUNT，未封顶；
   *   乘数按 min(count,5)×0.05 封顶 ×1.25）。
   * 无任何 boost 的命中省略本键（后端不产出空 boosts 对象）。
   */
  boosts?: {
    route?: 'primary' | 'secondary';
    taskLinks?: number;
  };
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
  /** 实际使用的 token 上限（仅显式传参时回显；缺省 20000 不回显） */
  maxTokens?: number;
}

/**
 * doc_routes.codeEntryType 取值冻结（T5，类型前置铁律 #25）
 *
 * - 'exact'（缺省，存量/缺省行为）：codeEntry 是仓库内精确文件或目录路径，
 *   recheck 时做 repoManifest.files 精确/目录前缀存在性校验；
 * - 'pattern'：codeEntry 是 glob 型泛化写法（如 `apps/web/app/**` + `/page.tsx`），
 *   对人类有指引价值但无法精确校验，recheck 时豁免存在性校验（health 标记
 *   codeEntryStatus:'exempt'，绝不报 broken、不参与 broken 统计）。
 */
export const DOC_ROUTE_CODE_ENTRY_TYPES = ['exact', 'pattern'] as const;

/** codeEntryType 取值联合（'exact' | 'pattern'） */
export type DocRouteCodeEntryType = (typeof DOC_ROUTE_CODE_ENTRY_TYPES)[number];

/**
 * 意图路由（doc_routes，v1.42 批次 B5）
 *
 * INDEX.md 功能-文档映射表的结构化形态：intent（"我要…"）→ primaryDoc+headingPath（先看）→
 * secondaryDoc（再看）→ codeEntry（代码入口）。category = 路由分组。
 */
export interface DocRoute {
  /** 路由 ID */
  id: string;
  /** 所属空间 ID */
  spaceId: string;
  /** 用户意图描述（"我要…"） */
  intent: string;
  /** 路由分组（可空） */
  category?: string | null;
  /** 主文档 ID（路由第一步跳转） */
  primaryDocId: string;
  /** 主文档定位锚点（doc_sections.heading_path 精确匹配；null = 文档级） */
  primaryHeadingPath?: string | null;
  /** 次文档 ID（可空） */
  secondaryDocId?: string | null;
  /** 次文档定位锚点（可空） */
  secondaryHeadingPath?: string | null;
  /** 代码入口（仓库内相对路径；null = 无） */
  codeEntry?: string | null;
  /**
   * codeEntry 类型（T5）：'exact'（缺省）= 精确路径，recheck 参与存在性校验；
   * 'pattern' = glob 泛化写法，recheck 豁免（不报 broken）。随 codeEntry 语义配套填写。
   */
  codeEntryType: DocRouteCodeEntryType;
  /**
   * 路由健康巡检结果（v1.42 批次 C1，异步重检写入）：
   * 空 issues = 健康；NULL = 尚未检查。C1 只产出 kind:'heading' 的 issue。
   */
  health?: RouteHealth | null;
  /** 排序权重（同空间内 ASC 升序） */
  sortOrder: number;
  /** 创建者 Actor ID */
  createdBy: string;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * 意图路由导航投影（v1.56，overview 内嵌段专用）
 *
 * 只保留「导航够用」的字段：intent（我要…）→ category（分组）→
 * primaryDocId+primaryHeadingPath（先看哪篇的哪个节）→ codeEntry（代码入口）
 * + health.codeEntryStatus（codeEntry 可用性指示）。
 * health 语义：null = 未检；{codeEntryStatus} = 已检（仅 codeEntry 非空时携带 status，
 * 无 status 时序列化为 {}，与 null 的「未检」区分）；issues/checkedAt/codeEntryNote
 * 等明细一律省略——全字段走 GET /doc-spaces/:id/routes 或 list_doc_routes 通道
 * （overview 只做导航门面，v1.55 起 routes 段本就截断策展序前 50 条）。
 */
export interface DocRouteNav {
  /** 用户意图描述（"我要…"） */
  intent: string;
  /** 路由分组（可空） */
  category?: string | null;
  /** 主文档 ID（路由第一步跳转） */
  primaryDocId: string;
  /** 主文档定位锚点（doc_sections.heading_path 精确匹配；null = 文档级） */
  primaryHeadingPath?: string | null;
  /** 代码入口（仓库内相对路径；null = 无） */
  codeEntry?: string | null;
  /**
   * 导航级健康指示：只保留 codeEntryStatus（对齐 RouteHealth 定义）；
   * 未检（health NULL）→ null；已检但 codeEntry 为空（无 status）→ {}
   */
  health?: Pick<RouteHealth, 'codeEntryStatus'> | null;
}
export interface DocSpaceOverview {
  /** 空间 ID */
  spaceId: string;
  /** 空间名称 */
  spaceName: string;
  /** 空间图例（v1.41）：description 全文内嵌，markdown；includeDescription=false 或 description 为空时缺省 */
  spaceDescription?: string | null;
  /** 空间图例 token 估算（v1.41）：单列记账，不参与 maxTokens 文档条目预算竞争 */
  legendTokenEstimate?: number;
  /**
   * 意图路由导航投影列表（v1.42 B5 内嵌，v1.56 起恒为导航投影）：按 sortOrder+createdAt ASC 排序，
   * 与图例同待遇——不占 maxTokens 文档条目预算；includeRoutes=false 时缺省。
   * 每条只含导航字段（intent/category/primaryDocId/primaryHeadingPath/codeEntry/health.codeEntryStatus）——
   * 全字段走 GET /doc-spaces/:id/routes（分页）或 list_doc_routes 工具。
   * 防爆截断（v1.55）：最多内嵌前 OVERVIEW_ROUTES_LIMIT（=50）条策展序最前的路由；
   * 超出时 routesTruncated=true 且 routesTotal 给出全量条数。
   */
  routes?: DocRouteNav[];
  /** 意图路由 token 估算（v1.42 B5）：estimateTokens 对序列化 routes（截断后）单列记账，计入 totalTokenEstimate */
  routesTokenEstimate?: number;
  /**
   * routes 段是否被截断（v1.55）：空间路由总数 > OVERVIEW_ROUTES_LIMIT（=50）时为 true，
   * 此时 routes 只含策展序前 50 条；includeRoutes=false 时缺省
   */
  routesTruncated?: boolean;
  /**
   * 空间路由全量条数（v1.55）：不受截断影响（routesTotal 恒为全量计数），
   * 供调用方判断是否需要走分页端点拉全；includeRoutes=false 时缺省
   */
  routesTotal?: number;
  /** 分类树 */
  categories: DocCategoryOverview[];
  /** 未分类文档 */
  uncategorized: DocSummary[];
  /**
   * 空间断链合计（v1.42 B6）：过滤后可见文档的 brokenLinkCount 求和。
   * 0 也返回（有已检查文档时）；全部文档均未检查（无 linkHealth）时省略。
   */
  totalBrokenLinks?: number;
  /**
   * 空间 broken 路由合计（v1.42 批次 C1）：routes 段内 health 非 NULL 的路由中
   * issues.length>0 的计数和。0 也返回（有已检查路由时）；全部路由均未检查
   * （health NULL）时省略——"空间路由全健康"与"从未检查过路由"语义不同。
   * includeRoutes=false 时同步省略。
   */
  totalBrokenRoutes?: number;
  /** 总 token 估算（图例 + 文档条目 + 意图路由合计，仅信息回显） */
  totalTokenEstimate?: number;
  /** 是否因 token 上限截断（仅文档条目截断，图例始终全量；意图路由截断见 routesTruncated） */
  truncated?: boolean;
  /**
   * 过滤后文档总数（截断元数据补齐）：不受 maxTokens 截断影响（恒为过滤后
   * 全量计数），供调用方判断是否需要分页拉全；截断时 docsReturned < docsTotal
   */
  docsTotal: number;
  /**
   * 实际返回的文档条目数（截断元数据补齐）：categories.docs 与 uncategorized
   * 之和；未截断时等于 docsTotal
   */
  docsReturned: number;
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

/**
 * slim 模式下的分类视图（v1.56，overview?slim=true）
 *
 * 与 DocCategoryOverview 同构，仅 docs 元素换为 DocSummarySlim——
 * category 归属/分组结构不动（slim 只裁文档条目字段，不改变地图形状）。
 */
export interface DocCategoryOverviewSlim extends Omit<DocCategoryOverview, 'docs'> {
  /** 本分类下的文档 slim 摘要列表（{path,title,summary,docType,tokenEstimate}） */
  docs: DocSummarySlim[];
}

/**
 * catalog 模式下的分类视图（v1.66，overview?catalog=true）
 *
 * 与 DocCategoryOverview 同构，仅 docs 元素换为 DocSummaryCatalog（三键）。
 */
export interface DocCategoryOverviewCatalog extends Omit<DocCategoryOverview, 'docs'> {
  /** 本分类下的文档 catalog 条目列表（{path,title,tokenEstimate}） */
  docs: DocSummaryCatalog[];
}

/**
 * DocSpace 概览 slim 变体（v1.56，overview?slim=true）
 *
 * 与 DocSpaceOverview 同构，仅 categories/uncategorized 的文档条目换为
 * DocSummarySlim（routes 段两种模式同为 DocRouteNav 导航投影）。
 * 语义：slim=true 时返回本形状；缺省/false 返回 DocSpaceOverview（向后兼容）。
 */
export interface DocSpaceOverviewSlim
  extends Omit<DocSpaceOverview, 'categories' | 'uncategorized'> {
  /** 分类树（docs 为 slim 条目） */
  categories: DocCategoryOverviewSlim[];
  /** 未分类文档（slim 条目） */
  uncategorized: DocSummarySlim[];
}

/**
 * DocSpace 概览 catalog 变体（v1.66，overview?catalog=true）
 *
 * 与 DocSpaceOverview 同构，仅 categories/uncategorized 的文档条目换为
 * DocSummaryCatalog（三键）。语义：catalog=true 时返回本形状（与 slim 同给时
 * catalog 胜出）；缺省/false 返回 DocSpaceOverview（向后兼容）。
 * 与 slim 的差异：catalog 豁免 maxTokens 对 doc 条目的截断（目录完整性是契约）。
 */
export interface DocSpaceOverviewCatalog
  extends Omit<DocSpaceOverview, 'categories' | 'uncategorized'> {
  /** 分类树（docs 为 catalog 三键条目） */
  categories: DocCategoryOverviewCatalog[];
  /** 未分类文档（catalog 三键条目） */
  uncategorized: DocSummaryCatalog[];
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
  /**
   * 写后内容哈希（sha256 hex）。链式写免重读：下次写携带 expectedContentHash
   * 做乐观锁前提校验（409 DOC_CONTENT_CONFLICT = 期间被他人改动）。
   */
  contentHash?: string;
  /**
   * true = 内容 hash 未变但 forceRechunk 强制重建了 sections（债 B：section 级
   * 元数据修复路径）。携带时 unchanged 恒不出现（真早退才返回 unchanged:true）；
   * 注意 updatedAt 会随元数据重建 bump——这是预期语义，不是 bug。
   */
  rechunked?: boolean;
  /**
   * true = 幂等重放（v1.63.0）：同 actor + clientRequestId 的重复请求，返回
   * response_snapshot 存的首次成功响应（非当前状态）。仅携带幂等键的请求可能出现。
   */
  idempotentReplay?: boolean;
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

// ─── Doc Version（文档编辑历史，doc history MVP）──────────────

/**
 * 版本来源字面量（doc_versions.source，单一事实来源）
 *
 * - 'upsert'：直接 full upsert（PUT /doc-spaces/:id/docs，含 web 编辑回写）；
 * - 'patch'：section 级 / match 模式局部写（PATCH /docs/:id/sections/:position、PATCH /docs/:id/content）；
 * - 'import'：批量导入通道（PUT /doc-spaces/:id/docs/batch，MCP import_docs / import_doc_bundle）；
 * - 'append'：追加写原语（POST /docs/:id/append，v1.65.0 消费者反馈批 7601e2f5——
 *   doc_versions.source 为自由 varchar(16) 无 DB 约束，直接扩展字面量即可）。
 */
export const DOC_VERSION_SOURCES = ['upsert', 'patch', 'import', 'append'] as const;

/** 版本来源联合（'upsert' | 'patch' | 'import' | 'append'） */
export type DocVersionSource = (typeof DOC_VERSION_SOURCES)[number];

/**
 * 文档版本摘要（GET /docs/:id/versions 列表项，不含 content 全文）
 *
 * 版本号语义：单调递增（历史最大 version+1），旧版本被保留策略剪除后不回填不归零——
 * version 是稳定标识，引用不随剪枝漂移。
 */
export interface DocVersionSummary {
  /** 版本号（1 起，单调递增不归零） */
  version: number;
  /** 该版本内容 SHA256（= 写入后 docs.content_hash） */
  contentHash: string;
  /** 写入者 actor ID（'system' 固定 uuid = 系统/无认证写） */
  authorActorId: string;
  /** 版本来源：'upsert' | 'patch' | 'import' */
  source: DocVersionSource;
  /** 版本创建时间（服务端时间） */
  createdAt: string | Date;
  /** 内容字节数（utf8，octet_length；不含正文仍能评估抓取成本） */
  contentSize: number;
}

/**
 * 版本间行级 diff（读时现算，不落库；与前一版本对比）
 *
 * 无外部依赖的行级 LCS 实现：逐行比对（doc-version-diff.ts），输出简易
 * unified diff 文本 + 增删计数。'fromVersion' = 剪枝后该版本的前一版本
 * （version 小于当前的最大版本，不一定是 version-1——剪枝可能跳号）。
 */
export interface DocVersionDiff {
  /** 对比基准版本号（前一版本；不存在时为 null 字段） */
  fromVersion: number;
  /** 相对前一版本新增的行数 */
  added: number;
  /** 相对前一版本删除的行数 */
  removed: number;
  /** 行级 unified diff 文本（hunk 头 + ' '/'+'/'-' 前缀行） */
  unified: string;
}

/**
 * 文档版本详情（GET /docs/:id/versions/:version）
 *
 * 单版本详情 = 元数据 + 该版本全文快照 + 与前一版本的 diff（读时现算）。
 */
export interface DocVersionDetail extends DocVersionSummary {
  /** 该版本的全文快照（与写通道 dto.content 同形） */
  content: string;
  /**
   * 与前一版的 diff；null = 没有前一版本（该文档最早一版）——
   * 与「有前版但完全无差异」区分（后者 added/removed 为 0）。
   */
  diff: DocVersionDiff | null;
}

// ---------------------------------------------------------------------------
// Move impact / atomic move（v1.60.0-dev，P1 双件 73cadb0d + 8d763914）
// ---------------------------------------------------------------------------

/**
 * Move impact 入链条目（GET /docs/:id/move-impact 的 inboundLinks 元素）
 *
 * 元数据：被移文档的 Markdown 入链出处，供迁移方生成人工改写清单。
 * 去重契约：按 (sourceDocId, href) 唯一；section 定位 = 该 href 首个命中
 * section 的 position/headingPath（同一文档多处链同一 href 只记首例）。
 */
export interface DocInboundLink {
  /** 入链来源文档 ID（出链方） */
  sourceDocId: string;
  /** 入链来源文档 path（出链方） */
  sourcePath: string;
  /** 入链来源文档 title（出链方） */
  sourceTitle: string;
  /** 原文 href（未归一化，恢复现场用） */
  href: string;
  /**
   * true = Markdown 相对 .md path 链接（move 改 path 后即断 → 进
   * pathBasedLinksToRewrite 清单，需人工改写）；false = 平台规范链接
   * /docs/<spaceId>?doc=<docId>（按 docId 引用，move 不受影响）。
   */
  isPathBased: boolean;
  /** 该 href 首个命中 section 的 position（0-based） */
  sectionPosition?: number;
  /** 该 href 首个命中 section 的 headingPath（可空 = headingLevel 0 文首段） */
  headingPath?: string | null;
}

/**
 * Move impact outbound 链条目（被移文档自身的相对 .md 出链失效面，v1.61.0 批次 1）
 *
 * 方向语义：inboundLinks 是「别人链我」；本清单是「我链别人」——被移文档移动前后
 * 基准目录变化，自身相对出链的解析目标随之漂移，逐条标注供迁移方改写自身正文。
 * 只收录 path-based 相对 .md 链接（?doc= 平台链接按 docId 引用，move 不受影响，
 * 不收录）；old/new ResolvedTarget 均按严格源目录 POSIX 解析（resolveHrefToDocPath）。
 * 收录条件：old 与 new 解析结果**不同**（基准目录未变 → 链接不受影响 → 不收录）。
 */
export interface DocOutboundLink {
  /** 原文 href（未归一化，恢复现场用） */
  href: string;
  /** 移动前解析目标路径（严格源相对 POSIX 解析，源 = doc.path 的目录） */
  oldResolvedTarget: string;
  /** 移动后解析目标路径（严格源相对 POSIX 解析，源 = proposedPath 的目录） */
  newResolvedTarget: string;
  /**
   * 移动前该目标在空间中是否存在（按移动前 path 集合判定）。
   * true = 移动前健康；false = 移动前已是断链——已断链接入清单会误导迁移方，
   * 必须显式标注（plan 决策）。
   */
  oldTargetExists: boolean;
  /**
   * 移动后解析目标是否存活——按「移动后 path 集合」判定：空间现存 path 去掉
   * doc.path、加上 proposedPath（被移文档自身以 newPath 计入，自引用因此正确）。
   */
  targetExists: boolean;
  /** 移动后解析目标命中的文档 ID（按移动后 path → id 映射反查；无 = undefined） */
  targetDocId?: string;
  /** 该 href 首个命中 section 的 position（0-based，与 inbound 同口径） */
  sectionPosition?: number;
  /** 该 href 首个命中 section 的 headingPath（可空 = headingLevel 0 文首段） */
  headingPath?: string | null;
}

/**
 * Move impact 意图路由引用条目（doc_routes 中 primary/secondary 指向被移文档）
 *
 * doc_routes 存的是裸 docId（无 FK），move 后路由行自动继续指向同一 docId——
 * 本清单仅供迁移方核对路由的展示语义（intent/锚点）。
 */
export interface DocRouteRef {
  /** 路由 ID */
  routeId: string;
  /** 路由意图描述 */
  intent: string;
  /** 该文档在路由中的角色：主文档 / 次文档 */
  role: 'primary' | 'secondary';
  /** 对应角色的 headingPath 锚点（可空 = 文档级跳转） */
  headingPath: string | null;
}

/** 目标 path 碰撞详情（proposedPath/toPath 撞空间内另一未删 doc） */
export interface DocMoveTargetCollision {
  collision: true;
  /** 已占用目标 path 的文档 ID */
  conflictDocId: string;
}

/**
 * computeMoveImpact 完整视图（三处共用：get_move_impact 端点 / move dryRun /
 * move 响应摘要——同一份实现，保证 dryRun 视图与真实移动前的预演一致）
 */
export interface DocMoveImpact {
  /** 被查文档 ID */
  docId: string;
  /** 当前 path（move 前 / 未移动时） */
  path: string;
  /**
   * 被查文档的原始写入 payload SHA-256（乐观锁 token，v1.62.0）。
   * **与读出正文不可互算**（读路径 = sections 重建产物）；乐观锁
   * （expectedContentHash）一律用本 token，禁止对读出文本自算 SHA。
   * docs.content_hash 为 nullable 列——缺省 null = 旧数据/未写入。
   */
  contentHash: string | null;
  /** 提议的新 path（proposedPath/toPath 非空时返回） */
  proposedPath?: string;
  /** 入链清单（全空间反扫，按 (sourceDocId, href) 去重） */
  inboundLinks: DocInboundLink[];
  /** doc_routes 引用清单 */
  docRoutes: DocRouteRef[];
  /** 关联 taskId 列表（task_doc_links WHERE doc_id） */
  taskLinks: string[];
  /** 目标 path 碰撞（proposedPath 非空且空间内已有同 path 未删 doc 时） */
  targetCollision?: DocMoveTargetCollision;
  /** proposedPath == 当前 path（no-op，调用方判 409 RESOURCE_CONFLICT） */
  samePath?: boolean;
  /** 需人工改写的入链子集（inboundLinks 中 isPathBased=true 的项）；
   *  ?doc= 规范链接按 docId 引用，不受 move 影响，不在此清单 */
  pathBasedLinksToRewrite: DocInboundLink[];
  /**
   * 被移文档自身的相对 .md 出链失效清单（v1.61.0 批次 1；仅 proposedPath 非空时携带）。
   * 移动后基准目录变化 → 自身相对出链解析目标漂移；old/new 解析结果不同才收录，
   * 逐条带移动前后解析目标与存在性标记（oldTargetExists/targetExists 双态，
   * exists 按移动后 path 集合判定——被移文档自身以 newPath 计入，自引用正确）。
   */
  outboundPathLinksToRewrite?: DocOutboundLink[];
}

/**
 * POST /docs/:id/move 响应（moved=true 已落库 / dryRun 未落库）
 */
export interface DocMoveResult {
  /** 被移文档 ID（move 前后不变——引用面连续性核心） */
  docId: string;
  /** 移动前 path */
  oldPath: string;
  /** 移动后 path */
  newPath: string;
  /** 当前内容 SHA256（move 不重建 content/sections，hash 不变） */
  contentHash: string | null;
  /** true = 已落库；false = dryRun */
  moved: boolean;
  /** dryRun 专用标记：true = 校验全过、预演视图、未写库 */
  wouldMove?: boolean;
  /** impact 完整视图（inboundLinks/docRoutes/taskLinks/pathBasedLinksToRewrite） */
  impact: DocMoveImpact;
  /**
   * true = 幂等重放（v1.63.0）：同 actor + clientRequestId 的重复请求，返回
   * response_snapshot 存的首次成功响应（文档不会再次移动）。仅携带幂等键的请求可能出现。
   */
  idempotentReplay?: boolean;
}

// ─── Metadata-only patch（v1.61.0 批次 2，Board 任务 201ae04f）──────────────

/**
 * PATCH /docs/:id/metadata 响应的最终元数据视图
 *
 * 写后可核对面：五个可 patch 字段的最终落库值（title/summary/docType/tags/
 * categoryId）+ categoryName 便捷展示（categoryId 为 null 时 categoryName 亦 null）。
 * contentHash/sectionCount/content 面不在此视图——metadata-only 语义保证它们不变。
 */
export interface PatchDocMetadataView {
  /** 文档标题（最终值） */
  title: string;
  /** 摘要（最终值；null = 无摘要） */
  summary: string | null;
  /** 文档类型（最终值；null = 未设置） */
  docType: string | null;
  /** 标签数组（最终值；[] = 已清空） */
  tags: string[];
  /** 分类 ID（最终值；null = 未分类） */
  categoryId: string | null;
  /** 分类名（categoryId 非空时查得；null = 未分类） */
  categoryName: string | null;
}

/**
 * PATCH /docs/:id/metadata 响应（metadata-only 写通道，游戏方 Pilot 1b 契约）
 *
 * 不变量契约：本写通道不重切 sections、不落 doc_versions、不动 contentHash/
 * docId/task_doc_links/doc_routes——只 UPDATE docs 行的元数据列。
 */
export interface PatchDocMetadataResult {
  /** 文档 ID（metadata patch 前后不变） */
  docId: string;
  /** 文档 path（不变） */
  path: string;
  /** 内容 SHA256（不变——metadata-only 语义核心，与写前 expectedContentHash 一致） */
  contentHash: string | null;
  /** 本次实际变更的字段名列表（title/summary/docType/tags/category 的子集；unchanged 时为空） */
  changedFields: string[];
  /** true = 全部显式字段与现值相同，未产生任何写操作（无 UPDATE/audit/事件） */
  unchanged: boolean;
  /** 最终元数据视图（写后回传，单次调用可核对） */
  metadata: PatchDocMetadataView;
  /**
   * true = 幂等重放（v1.63.0）：同 actor + clientRequestId 的重复请求，返回
   * response_snapshot 存的首次成功响应。仅携带幂等键的请求可能出现。
   */
  idempotentReplay?: boolean;
}
