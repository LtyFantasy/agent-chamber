/**
 * DocSpace 模块 — 响应 DTO
 *
 * 定义列表/详情视图、搜索命中、概览等响应 Shape。
 * 遵循项目惯例：列表视图不含大字段（description 摘要化、不含 content）。
 */
import { DocSpaceMemberRole, Visibility } from '../enums';
import type { DocSpaceCanonicalTag, DocSpaceHintToggles, DocSpacePathType } from './docspace.dto';

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
  role: DocSpaceMemberRole;
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
  /**
   * 图类型（Diagram IR v1；仅 docType='diagram' 时非空）。
   * 从 IR diagram_type 反正范化的 docs.diagram_type 列直读——列表/过滤免解析 IR。
   */
  diagramType?: string | null;
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
   * 图信息摘要（Diagram IR v1；仅 docType='diagram' 时携带，免二次请求拿渲染元数据）。
   * 取自 docs.render_meta（qualityProfile 为服务端注入后的生效值；composition =
   * checker composition.summary 的 errors/warnings 计数）。无 html 字段——快照走
   * GET /docs/:id/diagram.html 单独取（select:false 大字段）。
   */
  diagram?: {
    diagramType: string | null;
    qualityProfile?: string;
    renderedAt?: string;
    htmlBytes?: number;
    composition?: { errors: number; warnings: number };
  } | null;
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
  /**
   * 派生锚点哈希（与 DocSectionContent.sectionHash 同口径：
   * sha256(headingPath + '\n' + headingLevel + '\n' + content) hex，纯派生不落库）。
   *
   * outline 每节携带它是为**复核/对账场景**：一次 outline 调用即可完成全篇比对，
   * 免去逐节 positions[] 往返。写前提校验的取数通道仍是 positions[] / 单节读
   * （patch expectedSectionHash）——两处口径相同，可自由混用。
   *
   * 派生输入 = 存储三元组；服务端为此在 outline 查询额外 select content 列
   * （内存派生后即丢弃，不进响应体）——响应体不因正文膨胀，每节只多本字段（≈85B）。
   */
  sectionHash?: string;
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

// ─── Doc Tree / Facets（懒加载目录树，v1.70.0-dev）────────────

/**
 * 目录树子目录项（GET /doc-spaces/:id/docs/tree 的 folders.items 元素）
 *
 * 语义：prefix 下**当前层**的直接子目录（不含孙目录——孙目录由下一层
 * prefix 请求展开）；docCount/latestDocAt 为**递归后代**聚合（含子目录内
 * 全部未删文档），供左栏展示规模与排序。
 */
export interface DocTreeFolder {
  /** 子目录完整路径（含尾部 /，如 "memory/2026-08-29/"）——下一层请求的 prefix */
  path: string;
  /** 子目录段名（末段，如 "2026-08-29"） */
  name: string;
  /** 该子目录下（含递归后代）未删文档数 */
  docCount: number;
  /** 该子目录下（含递归后代）最近更新的未删文档时间（ISO 8601；无文档时 null） */
  latestDocAt: string | null;
}

/**
 * 目录树直挂文档项（GET /doc-spaces/:id/docs/tree 的 docs.items 元素，slim 投影）
 *
 * 只保留左栏渲染与跳转所需字段（id/path/title/docType/updatedAt）——
 * 明细走 read_doc / list_docs 全字段通道（响应体积规范 §7.4a）。
 */
export interface DocTreeDoc {
  /** 文档 ID */
  id: string;
  /** 文档路径 */
  path: string;
  /** 文档标题 */
  title: string;
  /** 文档类型（可空） */
  docType?: string | null;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * 目录树分页信封（folders/docs 共用）
 *
 * total = 当前层全量计数（不受 limit/offset 影响），hasMore = 是否还有下一页。
 */
export interface DocTreePage<T> {
  /** 当前页条目 */
  items: T[];
  /** 当前层全量计数 */
  total: number;
  /** 是否还有下一页（offset + items.length < total） */
  hasMore: boolean;
}

/**
 * 目录树响应（GET /doc-spaces/:id/docs/tree）
 *
 * 分层浏览契约：folders = 当前层直接子目录（分页），docs = 当前层直挂文档
 * （slim 分页）；子目录内容由下一层请求（prefix = folder.path）展开。
 */
export interface DocTreeResponse {
  /** 归一化后的前缀（去前导 /、非空补尾部 /；根层为 ""） */
  prefix: string;
  /** 当前层子目录（分页） */
  folders: DocTreePage<DocTreeFolder>;
  /** 当前层直挂文档（slim，分页） */
  docs: DocTreePage<DocTreeDoc>;
}

/**
 * 聚合计数项（facets 的 types/tags 共用）
 *
 * v1.92.0-dev（DocSpace 元数据治理 1 期）：新增词表状态两字段——**仅当该族词表已配置时
 * 出现**（未配置时整字段省略，区分「没配词表」与「词表外」）。
 */
export interface DocFacetCount {
  /** 聚合值（doc_type 或 tag 原文） */
  value: string;
  /** 命中未删文档数 */
  count: number;
  /**
   * 词表状态（仅该族词表已声明时出现）：
   * - types 组：`declared`（ci ∈ settings.docTypes）/ `undeclared`（词表外）；
   * - tags 组：`canonical`（**精确等于**某条目 value）/ `alias`（非声明形态但 ci 命中
   *   value 或 alias，含大小写变体）/ `undeclared`（词表外）。
   */
  vocabStatus?: 'declared' | 'undeclared' | 'canonical' | 'alias';
  /**
   * 指向的 canonical 值（**仅 tags 组且 vocabStatus='alias' 时出现**）——
   * 该 alias 归一后的落库形态，喂 3 期 rename/merge 工具。
   */
  canonicalValue?: string;
}

/**
 * 分类聚合计数项（facets 的 categories 元素）
 */
export interface DocFacetCategoryCount {
  /** 分类 slug */
  slug: string;
  /** 分类名称 */
  name: string;
  /** 命中未删文档数 */
  count: number;
}

/**
 * 全空间聚合计数响应（GET /doc-spaces/:id/docs/facets）
 *
 * 替代前端全量列表聚合：types = GROUP BY doc_type（非空）；tags = unnest(tags)
 * GROUP BY；categories = JOIN doc_categories（含软删过滤）。全部只统计未删文档。
 *
 * v1.92.0-dev：facets 升级为「一词调用」体检面 = 声明词表（vocabulary）+
 * 实际分布（types/tags/categories）+ 逐项状态（vocabStatus/canonicalValue）。
 */
export interface DocFacetsResponse {
  /** 文档类型聚合（按 count DESC，同 count 按 value ASC） */
  types: DocFacetCount[];
  /** 标签聚合（按 count DESC，同 count 按 value ASC） */
  tags: DocFacetCount[];
  /** 分类聚合（按 count DESC，同 count 按 slug ASC） */
  categories: DocFacetCategoryCount[];
  /**
   * 已声明词表回显（v1.92.0-dev）——**词表的唯一读路径之一**（另一条 = PATCH 响应回显）。
   * 未声明该键时为 null；整个 space.settings 无词表时本字段省略（与逐项 vocabStatus
   * 省略口径一致）。内部键（repoManifest 等）不外泄——只回显三词表键。
   */
  vocabulary?: DocFacetsVocabulary;
}

/**
 * facets 回显的已声明词表（v1.92.0-dev）
 *
 * 三键分别对应 settings.docTypes / canonicalTags / pathTypes；未声明为 null。
 */
export interface DocFacetsVocabulary {
  /** 已声明 docType 词表（未声明 = null） */
  docTypes: string[] | null;
  /** 已声明规范标签词表（未声明 = null） */
  canonicalTags: DocSpaceCanonicalTag[] | null;
  /** 已声明路径前缀→docType 声明（未声明 = null） */
  pathTypes: DocSpacePathType[] | null;
  /**
   * hint 族开关现状（v1.92.0-dev 2 期）——未声明 = null（全关）。
   * 与三词表键并列，构成「一词调用 = 词表 + 开关 + 分布」的完整体检面。
   */
  hintToggles: DocSpaceHintToggles | null;
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
 * 目录树排序模式（GET /doc-spaces/:id/docs/tree 的 sort 参数，v1.70.0-dev）
 *
 * - recent（缺省）：目录按 latestDocAt DESC（最近更新在前）；
 * - name：目录按段名 ASC（字典序）。
 * 只影响 folders 排序；docs 恒按 path ASC。
 */
export const DOC_TREE_SORT_VALUES = ['recent', 'name'] as const;

/** DOC_TREE_SORT_VALUES 元素联合（'recent' | 'name'） */
export type DocTreeSort = (typeof DOC_TREE_SORT_VALUES)[number];

/**
 * 文档列表排序模式（GET /doc-spaces/:id/docs 的 sort 参数，v1.89.0-dev 批次 A）
 *
 * - **缺省（不传 sort）**：path ASC（既有行为，逐字节不变）；
 * - `updatedAt_desc` / `updatedAt_asc`：按 `docs.updated_at` 排序，**次键恒为 path ASC**
 *   （path 是 upsert 业务键、应用层唯一 ⇒ 全序；批量 upsert 同值常见，缺次键分页会抖）。
 *
 * ⚠️ 与搜索面的 `DOC_SEARCH_SORT_VALUES`（`createdAt_*`）是**词表双轨，不可互换**：
 * 搜索排的是"文档创建时间"，本词表排的是"文档最后更新时间"。
 */
export const DOC_LIST_SORT_VALUES = ['updatedAt_desc', 'updatedAt_asc'] as const;

/** DOC_LIST_SORT_VALUES 元素联合（'updatedAt_desc' | 'updatedAt_asc'） */
export type DocListSort = (typeof DOC_LIST_SORT_VALUES)[number];

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
  /**
   * 该命中是否**来自判别重排**（v1.85.0 批次 3；additive 可选键）——**只在重排启用且成功时出现**。
   *
   * 语义边界：
   * - 出现 ⇒ 本条命中的页内位置由模型排序 + 位置带求解决定（可能与 SQL 序不同）；
   * - **不出现** ⇒ SQL 序（未启用重排 / 人类与 web 调用 / 时间序 / 越窗页 / 闸门跳过 / fail-open）；
   * - ⚠️ **页间顺序不可比**：重排只会重排**窗口内**的候选，跨页比较请用 `score` 自排；
   * - ⚠️ 重排可能把**页外**候选提进返回页（最多占页尾 3 个槽位）——"重排"是排序增强，
   *   不是召回增强，但**响应层面确实可能出现未启用时看不到的结果**（承诺边界见 api-definition）。
   */
  reranked?: true;
}

// ─── 搜索响应信封与零命中引导（v1.86 中文根治批次 1-b，计划 v1.5 §2.6 + 主脑裁决 #1）───

/**
 * DocSpace 搜索 HTTP 响应信封（`GET /doc-spaces/:id/search`）。
 *
 * 契约变更（2026-09-26 主脑裁决 #1）：响应由裸数组 `DocSearchHit[]` 改为信封
 * `{ hits, hint? }`——`hint` 缺省不出现（additive，老客户端读 hits 之外字段无影响）。
 * 消费方三处同改：web `apps/web/src/lib/api.ts` 返回类型 + `docs/[id]/page.tsx` 解构 +
 * platform-mcp `search-docs.ts`（取 body.hits 并透传 hint）。
 */
/**
 * 搜索 hint 三态机器判别码（v1.89.0-dev 批次 A 落地；`DocSearchResponse.hintCode` 值域单源）
 *
 * rationale：`hint` 是**给人/Agent 读的文案**，逐字稳定但不适合程序分支（文案微调即
 * 破消费方匹配）。`hintCode` 是同一触发条件的**机器判别面**，与 `hint` 一一对应：
 * - `zero_hit` → DOC_SEARCH_ZERO_HIT_HINT（零命中，或降级查询零命中——"换词"更可操作）；
 * - `weak_hit` → DOC_SEARCH_WEAK_HIT_HINT（**有结果**但最高分低于本面活阈值）；
 * - `positional_order` → DOC_SEARCH_POSITIONAL_ORDER_HINT（降级路径且未按相关度排序）。
 *
 * ⚠️ 与 hint 同生命周期：**无 hint 时 `hintCode` 不出现（不是 null）**——消费方三处
 * jest `toEqual` 严格相等断言钉住这一形态（prefilter ⑦ / invariants ⑪ / search spec）。
 */
export const DOC_SEARCH_HINT_CODES = ['zero_hit', 'weak_hit', 'positional_order'] as const;

/** hintCode 取值联合（'zero_hit' | 'weak_hit' | 'positional_order'） */
export type DocSearchHintCode = (typeof DOC_SEARCH_HINT_CODES)[number];

export interface DocSearchResponse {
  /** 命中列表（排序语义见 DocSearchHit.reranked 与 hint 的位置序声明） */
  hits: DocSearchHit[];
  /**
   * 零命中/弱命中/降级引导（仅触发时出现），与 `hintCode` 一一对应：
   * - `zero_hit`：零命中（含降级查询零命中）→ DOC_SEARCH_ZERO_HIT_HINT；
   * - `weak_hit`：**有结果**但最高分低于**本面活阈值** → DOC_SEARCH_WEAK_HIT_HINT；
   * - `positional_order`：单 CJK 字 / df 降级路径且按位置序（未按相关度）→
   *   DOC_SEARCH_POSITIONAL_ORDER_HINT。
   * 红线（security ③）：hint 术语来源固定（静态词表/本次已召回结果），**禁提权重查**。
   */
  hint?: string;
  /**
   * `hint` 的机器判别码（additive 可选键，MCP `search_docs` 原样透传）：
   * **无 hint 时不出现该键**（禁 null——消费方 jest `toEqual` 严格相等断言在册），
   * 消费方分支请读本键而非匹配文案。
   */
  hintCode?: DocSearchHintCode;
  /**
   * 统一 hint 信封（v1.92.0-dev 2 期）：读侧 query_looks_like_path / suggest_relaxing
   * + **旧三态双写**（同一触发同时进 hints[]，code 同值、status=suggestion、
   * message 与上方 `hint` 逐字一致）。
   *
   * 不变量：为空 ⇒ 键不出现（禁 null/禁空数组）；≤3 条；仅 per-space 端点（全局检索
   * 不传 hintContext ⇒ 整段跳过）。
   */
  hints?: DocHint[];
}

/**
 * 强命中分数线的 **W1=1 基准尺度**：ts_rank_cd flag 0 × W1=1.0 下 ≥0.3 强命中 /
 * ~0.1 单点 / <0.08 不过地板（计划 §2.6 score 可读刻度）。
 *
 * ⚠️ **本常量不是活阈值，只是基准刻度**——它随 W1 漂移，两个消费方的活阈值形态不同
 * （2026-09-26 批次 1-d2 拆分，主脑裁决 R4）：
 * - **doc-search**：ts 腿乘了活旋钮 `SEARCH_TS_W1` ⇒ 活阈值 = 基准 × W1
 *   （`DOC_SEARCH_WEAK_HIT_SCORE`，定义在 backend `common/utils/search/search-tuning.ts`）。
 *   直接读本常量 = 刻度漂移：W1=3.0 时 cd 单点 `0.1×3=0.3` 恰触线 ⇒ 弱命中分支失效
 *   （1-d1 实测 3~4 条 → 0 条），1-d2 起一律读活阈值。
 * - **task q=**：其 rank 通道是**裸** `ts_rank_cd`（未乘 W1）⇒ 尺度与基准一致，
 *   直接使用本值（`TASK_SEARCH_WEAK_HIT_SCORE`）。
 *
 * 拆分理由：本常量原名带 `DOC_SEARCH_` 前缀却被 task q= 复用（1-b 现场决定 #5
 * 「DOC_ 常量跨域复用」坑）——两侧尺度已不同，故两侧各持一个具名活阈值，本常量退回
 * 「基准」语义，只作两处活阈值的刻度来源。
 */
export const DOC_SEARCH_STRONG_HIT_SCORE = 0.3;

/**
 * 文档检索零命中/弱命中引导原文（REST 信封 `hint` 字段单源；形态对齐
 * `EXPERIENCE_ZERO_HIT_HINT`——消费方 Agent 的行为指令，必须逐字稳定）。
 *
 * 内容 = 计划 §2.6 四要素：换 2–4 字术语 / `list_doc_routes` 策展意图 / 英文标识符
 * 锚点 / 措辞不匹配类属 v1 边界的说明。
 */
export const DOC_SEARCH_ZERO_HIT_HINT =
  'No sections strongly matched. Try shorter 2-4 character domain terms, browse curated ' +
  'intent via list_doc_routes, or anchor on an exact English identifier (file/symbol name). ' +
  'Paraphrase mismatches (same concept, different wording) are a known v1 boundary — ' +
  'they need v3 semantic retrieval, not more retries.';

/**
 * 文档检索**弱命中**引导原文（v1.89.0-dev 批次 A 从零命中文案拆出；REST 信封 `hint`
 * 字段单源，`hintCode = 'weak_hit'`）。
 *
 * 为什么必须与零命中文案分家：弱命中 = **本页有结果**，只是最高分低于活阈值（
 * `DOC_SEARCH_WEAK_HIT_SCORE`）。复用零命中文案（"No sections strongly matched" +
 * "not more retries"）会让消费方丢掉**已经返回、且可能正是答案**的结果。故本文案的
 * 第一动作是"先用"，换词是**条件动作**（仅当结果看起来不相关）。
 *
 * 措辞不匹配类属 v1 边界的说明仍由零命中文案承担（弱命中场景不适用——已经有召回）。
 */
export const DOC_SEARCH_WEAK_HIT_HINT =
  'Results were returned, but none scored above the strong-hit line: they may still be the ' +
  'answer, so use them first. Only if they look unrelated, try shorter 2-4 character domain ' +
  'terms, browse curated intent via list_doc_routes, or anchor on an exact English identifier ' +
  '(file/symbol name). This is a relevance caveat, not a failure.';

/**
 * 位置序声明引导（单 CJK 字查询 / df 降级路径专用，计划 §2.5）：候选经全文索引精确
 * 过滤，但**未按相关度排序**（常数分 + section_position/doc_id 位置序）——用更长的
 * 查询词换取相关度排序。
 */
export const DOC_SEARCH_POSITIONAL_ORDER_HINT =
  'Single-character or very high-frequency query: results are matched exactly but NOT ' +
  'ranked by relevance (ordered by section position). Use a longer query for relevance ranking.';

// ─── 统一 hint 信封（DocSpace 元数据治理 2 期，v1.92.0-dev）──────────────

/**
 * hint 四态（DocHint.status，语义钉死——消费方按 status 决定是否采取动作）
 *
 * - `suggestion`：写入**已提交**，这是事后建议（如 missing_category / tag_near_dup）；
 * - `normalized`：值**已按空间词表归一**（事实回显，如 tags_normalized）——
 *   不是建议，是「你的输入被纠偏了」的通知；
 * - `check_skipped`：**检查未执行**（附原因，如 route 影响面超 cap）——
 *   ⚠️ **绝不解释为健康**（unchecked ≠ healthy）；
 * - `check_failed`：**检查已执行且发现问题**（如 route_anchor_broken / path_type_mismatch）。
 */
export const DOC_HINT_STATUSES = [
  'suggestion',
  'normalized',
  'check_skipped',
  'check_failed',
] as const;

/** DOC_HINT_STATUSES 元素联合 */
export type DocHintStatus = (typeof DOC_HINT_STATUSES)[number];

/**
 * hint code 单源常量数组（v1.92.0-dev 2 期；阶段三扩 2 码；overview routes 截断补 1 码）
 *
 * 分三段：**写侧 10**（upsert / patch_metadata / batch / move / delete / route /
 * category 写路径产出）+ **读侧 5**（搜索读路径 2 + 零命中引流 1 + overview docs 截断 1
 * + overview routes 截断 1）
 * + **旧三态 3**（`DOC_SEARCH_HINT_CODES` 的三态双写进 hints[]，迁移一周期后旧
 * `hint`/`hintCode` 字段下线——届时本段三码一并移除）。
 *
 * 消费方一律按 code 分支，**不要解析 message 文案**（文案会微调，code 稳定）。
 */
export const DOC_HINT_CODES = [
  // ── 写侧（10）──
  'missing_category',
  'empty_tags',
  'empty_summary',
  'path_type_mismatch',
  'tag_near_dup',
  'category_near_dup',
  'route_target_excluded',
  'route_anchor_recheck',
  'route_anchor_broken',
  'tags_normalized',
  // ── 读侧（5）──
  'query_looks_like_path',
  'suggest_relaxing',
  // 阶段三（决策 9）：零命中引流（经验库单目的地）——刻意排在 zero_hit 之后
  'search_experiences_suggested',
  // 阶段三（决策 9）：overview 文档条目被 maxTokens 截断的分页教学（名次末位）
  'docs_overview_truncated',
  // overview **routes 段**内嵌条数截断（策展序前 50）的抓全教学——与 docs 段截断**独立**
  // 触发（catalog 只豁免 docs 段）；排在最末位（名次 17），同为「顺带告知」
  'docs_overview_routes_truncated',
  // ── 旧搜索三态（双写过渡，3）──
  'zero_hit',
  'weak_hit',
  'positional_order',
] as const;

/** DOC_HINT_CODES 元素联合（18 个 code） */
export type DocHintCode = (typeof DOC_HINT_CODES)[number];

/**
 * hint 文案单源（code → 可执行下一步指引）
 *
 * 形态纪律（对齐 `DOC_SEARCH_*_HINT` 先例）：一句话说清「发现了什么 + 下一步做什么」，
 * 不承诺结果、不描述内部实现。旧三态三条**直接引用既有常量**——同一触发条件在
 * `hint` 与 `hints[].message` 两处必须逐字一致（双写过渡期的硬契约）。
 *
 * 机器可读的补充信息一律走 `DocHint.data`，**消费方不要从 message 里解析结构化值**。
 */
export const DOC_HINT_MESSAGES: Record<DocHintCode, string> = {
  missing_category:
    '文档未设置分类；建议用 patch_doc_metadata 传 category 归位，便于在空间地图中检索。',
  empty_tags: '文档未设置标签；建议补 3–5 个标识符型 tag（先 get_doc_facets 复用空间既有取值）。',
  empty_summary: '文档摘要为空；建议补 1–2 句 summary（回答「这是什么 + 什么场景该读它」）。',
  path_type_mismatch:
    '文档路径命中空间声明的 pathTypes 前缀，但 docType 与声明不一致；建议核对 docType，或更新空间 pathTypes 声明。',
  tag_near_dup:
    '有 tag 不在空间词表内，但与空间既有 tag 高度相似；建议复用既有取值（平台不会自动改写）。',
  category_near_dup:
    '分类与空间既有分类高度相似；建议复用既有分类，避免近义分裂（平台不会自动合并）。',
  route_target_excluded:
    '该路由指向的文档被空间默认 overviewFilter 排除，overview 地图中不会出现它；建议确认是否需要调整排除项或改主文档。',
  route_anchor_recheck:
    '有意图路由指向本文档；move 只改 path、不改标题锚，docId 引用连续——以下路由供知悉核对。',
  route_anchor_broken:
    '有意图路由的 headingPath 锚在本次写入后不再命中；建议更新路由锚点（update_doc_route）。',
  tags_normalized: '部分 tag 已按空间词表归一为 canonical 形态（下次可直接写 canonical 值）。',
  query_looks_like_path:
    '查询形似本空间文档路径；若想直接读该文档，用 read_doc（spaceName + path）一跳直达。',
  suggest_relaxing:
    '零命中且本次带了筛选条件；可尝试去掉部分筛选参数扩大范围（去掉筛选不保证一定有结果）。',
  search_experiences_suggested:
    '本空间零命中。若你在排障或用陌生工具/流程，先去经验库搜一轮（search_experiences，' +
    'signals 给症状 token 如 econnrefused 最准）：别人踩过的同一个坑往往已收录，比重头摸索便宜。',
  docs_overview_truncated:
    'overview 的文档条目已达 maxTokens 预算被截断（已够用可忽略）。要看全目录：换投影重调本端点' +
    '（catalog=true 豁免截断，或 slim=true 更瘦），或改走分页清单（list_docs / GET /doc-spaces/:id/docs）。',
  docs_overview_routes_truncated:
    'overview 的意图路由内嵌条数有上限，本次已被截断（实际返回数见 data.returnedCount、全量规模见 ' +
    'routesTotal；已够用可忽略）。catalog 投影只豁免文档条目截断、不能补齐 routes；要看全部路由请用 ' +
    'list_doc_routes 分页拉取（可按 q/category 过滤定位）。',
  zero_hit: DOC_SEARCH_ZERO_HIT_HINT,
  weak_hit: DOC_SEARCH_WEAK_HIT_HINT,
  positional_order: DOC_SEARCH_POSITIONAL_ORDER_HINT,
};

/**
 * `route_anchor_recheck` 的 **check_skipped 变体**文案（影响面超 cap，检查未执行）
 *
 * 为什么单独一条：check_skipped 的语义是「没检查」，复用 suggestion 文案
 * （「以下路由供知悉核对」）会让消费方把「未检查」误读为「已检查且正常」——
 * health=null/unchecked **绝不解释为健康**是本信封的硬纪律。
 */
export const DOC_HINT_ROUTE_RECHECK_SKIPPED_MESSAGE =
  '指向本文档的意图路由过多，本次未逐条校验锚点（check_skipped —— 不是「健康」）；' +
  '可用 POST /doc-spaces/:id/routes/recheck 全量重检，或人工核对路由锚点。';

/**
 * 统一 hint 信封条目（v1.92.0-dev 2 期）
 *
 * 挂面：`UpsertDocResult` / `PatchDocMetadataResult` / `BatchUpsertItemResult` /
 * `DocSearchResponse` / `DocMoveResult` / `DocDeleteResult` / `DocRouteWriteResult` /
 * `DocCategoryWriteResult`——各带可选 `hints?: DocHint[]`。
 *
 * **不变量（消费方可依赖）**：
 * - hints 为空 ⇒ **该键不出现**（禁 null、禁空数组）；
 * - 只在 2xx 响应出现（4xx/5xx 无 hints）；
 * - 单响应 ≤3 条（先按 (actor, code, resource) 去重窗口过滤，再按固定优先级截尾，
 *   静默——不额外标记 truncated）；
 * - `data` 是结构化建议值（候选/字段/来源），消费方**不解析 message**。
 */
export interface DocHint {
  /** 稳定机器判别码（`DOC_HINT_CODES` 单源），按它分支而非匹配 message */
  code: DocHintCode;
  /** 四态语义（见 `DOC_HINT_STATUSES`）：suggestion / normalized / check_skipped / check_failed */
  status: DocHintStatus;
  /** 可执行下一步指引（人/Agent 可读面，`DOC_HINT_MESSAGES` 单源） */
  message: string;
  /** 结构化建议值（候选/字段/来源），消费方读这里而不是解析 message */
  data?: Record<string, unknown>;
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
 * codeEntryType 命名访问视图（单源派生自 DOC_ROUTE_CODE_ENTRY_TYPES；review-0831
 * 任务 a8a295df 自 backend doc-constants.ts 上移——与 DOC_SOURCE_NATIVE 同款
 * 「值域数组 + 命名化派生」模式，供 service 写入口/比较命名引用）
 */
export const CODE_ENTRY_TYPE = {
  EXACT: DOC_ROUTE_CODE_ENTRY_TYPES[0],
  PATTERN: DOC_ROUTE_CODE_ENTRY_TYPES[1],
} as const;

/** codeEntryType 命名视图联合类型（与 DocRouteCodeEntryType 等价，供类型标注复用） */
export type CodeEntryType = (typeof CODE_ENTRY_TYPE)[keyof typeof CODE_ENTRY_TYPE];

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
  /**
   * 统一 hint 信封（v1.92.0-dev 2 期；阶段三补 docs 段截断，本批补 routes 段截断）：
   * **两个产出码，触发条件互相独立**——
   * ① `docs_overview_truncated`：**文档条目**因 maxTokens 预算被截断时的分页教学，
   *    且调用方**未显式传** maxTokens（显式传 = 调用方自己管预算，不再教学）；
   * ② `docs_overview_routes_truncated`：**意图路由段**被内嵌条数上限（`OVERVIEW_ROUTES_LIMIT`）
   *    截断时的抓全教学——该上限是响应防爆闸，与预算/投影无关，**catalog 模式下照常触发**。
   * 两者同时成立时按固定优先级并存（均属「顺带告知」的末位档）。
   * 均不触发 ⇒ **键不出现**（禁空数组）。
   */
  hints?: DocHint[];
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
export interface DocSpaceOverviewSlim extends Omit<
  DocSpaceOverview,
  'categories' | 'uncategorized'
> {
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
export interface DocSpaceOverviewCatalog extends Omit<
  DocSpaceOverview,
  'categories' | 'uncategorized'
> {
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
 * 标签归一映射（v1.92.0-dev，DocSpace 元数据治理 1 期）
 *
 * 空间声明 `settings.canonicalTags` 时，写路径把命中 alias 的 tag 归一为 canonical
 * 声明形态。本类型记录「实际发生的」归一（from = 调用方原值，to = 落库 canonical 值），
 * **仅实际发生归一时才出现在响应里**——机器可读 data 字段，不是 prose hint。
 */
export interface TagNormalization {
  /** 调用方原始 tag（trim 前的输入形态） */
  from: string;
  /** 实际落库的 canonical 值 */
  to: string;
}

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
  /**
   * true = **23505 并发败者出口**（v1.94.0-dev）：本请求与另一请求同时 upsert 同一个
   * `(spaceId, path)`，本请求的插入撞部分唯一索引（`uq_docs_space_id_path`，
   * `WHERE deleted_at IS NULL`）回滚，服务端按重放语义返回**胜者**那一行。
   *
   * ⚠️ **语义要点（调用方必读）**：本请求写入的 `content` **未落库**——返回的
   * `sectionCount` / `tokenEstimate` / `contentHash` 全都来自胜者，内容可能与本请求
   * 提交的完全不同。要确认「我写的内容是否生效」请重读 `GET /docs/:id`。
   *
   * 领域侧门控据此跳过「**未写入却 emit**」的观测面（`doc.upserted` 事实与凭证扫描），
   * 与 `unchanged` / `rechunked` / `idempotentReplay` 同一族（见 docs/modules/hint-system.md §4.1）。
   */
  concurrentWinner?: boolean;
  /**
   * 实际发生的 tag 归一映射（v1.92.0-dev，仅空间声明 canonicalTags 且命中 alias 时出现）。
   * ⚠️ unchanged 早退（内容 hash 未变）不落 tags 也不归一，故本字段不出现——纯标签
   * 调整请走 patch_doc_metadata 通道。
   */
  tagNormalizations?: TagNormalization[];
  /**
   * 统一 hint 信封（v1.92.0-dev 2 期）：metadata / pathType / tags / routes 族建议
   * + tags_normalized 事实回显。族开关未开 ⇒ 键不出现；unchanged 早退与 23505 winner
   * 出口**不发 hints**（前者内容未变，后者是竞争重试面）。
   */
  hints?: DocHint[];
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
  /**
   * 实际发生的 tag 归一映射（v1.92.0-dev，仅该条命中 alias 时出现；语义同 UpsertDocResult）。
   */
  tagNormalizations?: TagNormalization[];
  /** 统一 hint 信封（v1.92.0-dev 2 期；语义同 UpsertDocResult，仅该条命中时出现） */
  hints?: DocHint[];
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
 * 版本来源命名访问视图（单源派生自 DOC_VERSION_SOURCES；review-0831 任务 a8a295df
 * 补建——与 CODE_ENTRY_TYPE / SEAT_LIFECYCLE_STATUS 同款「值域数组 + 命名化派生」模式，
 * 供 doc.service/diagram.service 写入口命名引用，替代裸字面量）
 */
export const DOC_VERSION_SOURCE = {
  UPSERT: DOC_VERSION_SOURCES[0],
  PATCH: DOC_VERSION_SOURCES[1],
  IMPORT: DOC_VERSION_SOURCES[2],
  APPEND: DOC_VERSION_SOURCES[3],
} as const;

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
  /**
   * 入链清单（全空间反扫，按 (sourceDocId, href) 去重）。
   *
   * **数组顺序契约（v1.90.0-dev 起确定）**：按来源文档 path 升序（候选集
   * `ORDER BY d.path ASC, d.id ASC`）。此前无 ORDER BY，顺序 = PG 返回顺序（任意、
   * 不可复现）；按数组序读取的消费者（agent 面 get_doc_move_impact）现在拿到稳定顺序。
   */
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
   *  ?doc= 规范链接按 docId 引用，不受 move 影响，不在此清单。
   *  顺序继承 inboundLinks（同数组过滤 → 同为来源 path 升序，v1.90.0-dev 起确定） */
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
  /**
   * 统一 hint 信封（v1.92.0-dev 2 期）：routes 族 route_anchor_recheck（有路由指向
   * 本文档时的知悉提示；move 不动标题锚，docId 引用连续）。dryRun 与正式 move 同发。
   */
  hints?: DocHint[];
}

/**
 * DELETE /docs/:id 响应（v1.92.0-dev 2 期补齐 shared 类型并增 hints 信封）
 *
 * 语义：软删（sections 经 CASCADE FK 保留）；`path` 是删除时的文档路径。
 */
export interface DocDeleteResult {
  /** 恒 true（软删成功；失败路径抛 4xx/5xx 无响应体） */
  deleted: boolean;
  /** 被删文档的 path（删除前快照） */
  path: string;
  /**
   * 统一 hint 信封（v1.92.0-dev 2 期）：routes 族 route_anchor_broken——
   * 指向该文档的路由锚点因文档消失而失效（docId 锚断 = 语义判定，无逐锚成本）。
   */
  hints?: DocHint[];
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
  /**
   * 实际发生的 tag 归一映射（v1.92.0-dev，仅空间声明 canonicalTags 且命中 alias 时出现）。
   * 归一在幂等 replay 检查**之后**执行——幂等指纹保持 caller 原始输入（归一确定性，
   * 重放语义不变）；本字段参与 changedFields 比较（归一后值才是落库值）。
   */
  tagNormalizations?: TagNormalization[];
  /**
   * 统一 hint 信封（v1.92.0-dev 2 期）：metadata / categories 族建议 + tags_normalized
   * 事实回显。**unchanged 出口同样发**（镜像 1 期「零变更也回显归一」语义：零写操作
   * 不等于零建议）。
   */
  hints?: DocHint[];
}

/**
 * POST /doc-spaces/:id/routes 与 PATCH /doc-routes/:id 响应（v1.92.0-dev 2 期）
 *
 * 形状 = `DocRoute` + 可选 hints 信封（route_target_excluded 建议）。
 */
export interface DocRouteWriteResult extends DocRoute {
  /**
   * 统一 hint 信封（v1.92.0-dev 2 期）：routes 族 route_target_excluded——
   * primaryDoc 的 docType ∈ 空间 overviewFilter.excludeTypes，或其 category slug ∈
   * excludeCategories（该文档不会出现在 overview 地图里）。
   */
  hints?: DocHint[];
}

/**
 * POST /doc-spaces/:id/categories 响应（v1.92.0-dev 2 期）
 *
 * 形状 = `DocCategoryDto` + 可选 hints 信封（category_near_dup 建议）。
 */
export interface DocCategoryWriteResult extends DocCategoryDto {
  /**
   * 统一 hint 信封（v1.92.0-dev 2 期）：categories 族 category_near_dup——
   * 新建分类与空间既有分类 trigram 高度相似（只出候选，**不自动合并**）。
   */
  hints?: DocHint[];
}

// ---------------------------------------------------------------------------
// Backlinks（反向引用面板，v1.90.0-dev）
// ---------------------------------------------------------------------------

/**
 * Backlinks 来源分组（GET /docs/:id/backlinks 的 sources 元素）
 *
 * 分组口径：同一来源文档（sourceDocId）的多条入链合并为一组；组级携带来源文档
 * 三键（docId/path/title），组内 links 复用 DocInboundLink 的**逐条**字段。
 *
 * ⚠️ Omit 三键是本 DTO 的结构保证：`{...组级三键, ...link}` 恒等于一条完整
 * `DocInboundLink`——让「摊平后与 move-impact.inboundLinks 语义等价」成为**类型
 * 保证**而不是结构巧合（后端 e2e 的等价性护栏正是靠这一点做双方对比）。
 */
export interface DocBacklinksSource {
  /** 入链来源文档 ID（出链方） */
  sourceDocId: string;
  /** 入链来源文档 path（出链方） */
  sourcePath: string;
  /** 入链来源文档 title（出链方） */
  sourceTitle: string;
  /**
   * 该来源文档指向目标文档的入链（已剔除组级三键，避免逐条重复）
   *
   * 组内顺序契约：按 `sectionPosition` 升序，`sectionPosition` 缺省（非路径命中
   * 且无 section 定位）排在最后；同位次按 href 升序（全序，两次请求数组全等）。
   */
  links: Array<Omit<DocInboundLink, 'sourceDocId' | 'sourcePath' | 'sourceTitle'>>;
}

/**
 * 反向引用视图（GET /docs/:id/backlinks 响应）
 *
 * 人类消费面：回答「这篇文档被谁引用了、在哪些 section 引用的」。
 * 与 move-impact 的三处语义差异（有意设计，勿合并两个端点）：
 * - **自引用被过滤**（sourceDocId === docId 剔除）——对「谁引用我」是噪音且点击无反应；
 *   move-impact 保留（迁移方需看到自身引用条目）；
 * - 只返回入链面（move-impact 还带 routes/taskLinks/collision/outbound 等迁移视图）；
 * - 按来源文档分组（move-impact 是扁平清单）。
 */
export interface DocBacklinks {
  /** 被查文档 ID */
  docId: string;
  /** 被查文档当前 path */
  path: string;
  /** 引用该文档的**来源文档**篇数（= sources.length；自引用已剔除） */
  docCount: number;
  /** 入链**处数**（所有组 links 长度之和；同篇多 href → linkCount > docCount） */
  linkCount: number;
  /**
   * 来源分组清单，**组级顺序契约**：按 `sourcePath` 升序（两次请求数组全等）。
   * 不设 total（前端首屏取前 5 组，全量即本数组长度）。
   */
  sources: DocBacklinksSource[];
}

// ─── 存量治理（DocSpace 元数据治理 3 期，v1.92.0-dev）──────────────────────
//
// tag rename/merge 与 category merge 的响应形状。dryRun 与 execute **共用同一
// interface**（dryRun 字段区分，非 dryRun 专属字段可空）——对齐 DocMoveResult 形态，
// 消费方（MCP 工具 / web）按同一形状读取。

/** ingest（非 native 来源）受影响文档引用（治理响应单列提醒仓侧同步改 frontmatter） */
export interface DocGovernanceIngestRef {
  /** 文档 ID */
  docId: string;
  /** 文档 path */
  path: string;
}

/**
 * 受影响文档清单（tag rename / category merge 共用）
 *
 * `sample` 恒 ≤50 条（plan D4 明列），`truncated = total > sample.length`；execute 前
 * 的 dryRun 用它与 batchToken 一起构成「预演 → 执行」契约。
 */
export interface DocGovernanceAffectedDocs<T> {
  /** 受影响文档总数 */
  total: number;
  /** 受影响样本（≤50 条，按 docId 升序——与 batchToken 序列化口径一致） */
  sample: T[];
  /** true = 样本被截断（total > sample.length） */
  truncated: boolean;
}

/** tag rename 受影响样本条目（含改写前 tags 快照，供人工核对/回滚） */
export interface RenameDocTagsAffectedSample {
  /** 文档 ID */
  docId: string;
  /** 文档 path */
  path: string;
  /** 改写前的 tags 值（快照；execute 后旧值消失，此字段是 dryRun 的对照面） */
  currentTags: string[];
}

/** 逐 distinct from 值的命中计数（dryRun 的 perValue / similarNotAffected 共用） */
export interface DocGovernanceValueCount {
  /** tag 值 */
  value: string;
  /** 命中文档数 */
  docCount: number;
}

/**
 * 词表变换计划 / 结果（applyTagRenameToVocabulary 的产物投影）
 *
 * `created=true` = 空间原本未声明 canonicalTags（null/空），本次 rename **创建**了
 * 词表键（plan D6 无条件生成 alias：词表键不存在则创建，不因未声明而跳过）。
 */
export interface RenameDocTagsVocabularyChange {
  /** true = 创建了 settings.canonicalTags 键（原为 null/空） */
  created: boolean;
  /** 新加入 `to` 条目的 alias 值（含从其他 canonical 迁移来的） */
  addedAliases: string[];
  /** 被删除的 canonical 条目值（from 中本身是 canonical 的，merge 两个 canonical 的形态） */
  removedCanonicals: string[];
  /** alias 归属迁移（原属其他 canonical 的 alias 被摘除并转入 to） */
  movedAliases: Array<{ alias: string; fromCanonical: string; toCanonical: string }>;
  /**
   * 因触达词表别名上限（`DOC_SPACE_TAG_ALIASES_MAX` = 20）被裁掉的值（minor-1）。
   * **空则不出现该键**（对齐仓内「空集合不落键」惯例）。语义：别名是召回兼容层，
   * 极端反复 rename 累积超限时截断尾部（保「先旧后新」）比让 canonicalTags 超限
   * （此后该空间 `PATCH /doc-spaces/:id` 直接 422，编辑面锁死）更不糟；本次被裁形态
   * 对应的存量文档已改写成 canonical，当前数据零召回损失。
   */
  truncatedAliases?: string[];
}

/**
 * tag rename/merge 响应（POST /doc-spaces/:id/tags/rename）
 *
 * dryRun（200，零副作用零审计零幂等占用）：`affectedDocs` / `perValue` /
 * `similarNotAffected` / `vocabularyPlan` 有值，`renamed`/`updatedDocs`/`vocabulary` 缺省。
 * execute（200）：`renamed`/`updatedDocs`/`vocabulary` 有值。两者恒带 `batchToken`。
 */
export interface RenameDocTagsResult {
  /** true = 预演（未写库）；false = 已执行 */
  dryRun: boolean;
  /** 本次受影响集的快照 token（sha256；execute 传 expectedBatchToken 做并发冲突检测） */
  batchToken: string;
  /** 实际生效的 from→to（execute 回显；dryRun 缺省） */
  renamed?: { from: string[]; to: string };
  /** 受影响文档清单（dryRun 专用；execute 只回总数 updatedDocs） */
  affectedDocs?: DocGovernanceAffectedDocs<RenameDocTagsAffectedSample>;
  /** 逐 distinct from 值的命中计数（dryRun 专用） */
  perValue?: DocGovernanceValueCount[];
  /** trgm 近义候选（未在 from 中的相似值，DX 提示可补进 from；dryRun 专用） */
  similarNotAffected?: DocGovernanceValueCount[];
  /** 词表变换计划（dryRun 专用） */
  vocabularyPlan?: RenameDocTagsVocabularyChange;
  /** 实际生效的词表变更（execute 专用） */
  vocabulary?: RenameDocTagsVocabularyChange;
  /** 实际改写的文档数（execute 专用） */
  updatedDocs?: number;
  /** ingest（非 native）受影响文档（单列提醒仓侧同步改 frontmatter；两者恒有） */
  ingestAffected: DocGovernanceIngestRef[];
  /** true = 幂等重放（同 actor + idempotencyKey 的重复请求返回首次响应快照） */
  idempotentReplay?: boolean;
}

/** category merge 受影响样本条目（含改写前 categoryId 快照） */
export interface MergeDocCategoryAffectedSample {
  /** 文档 ID */
  docId: string;
  /** 文档 path */
  path: string;
  /** 改写前分类 ID（快照；恒等于 source.id，留字段便于消费方对齐 tag 侧形状） */
  currentCategoryId: string | null;
}

/** category merge 的软引用影响面（dryRun 报告 / execute 回执共用形状） */
export interface MergeDocCategorySoftRefs {
  /** doc_routes.category === sourceSlug 的路由行数（merge 时改写为 targetSlug） */
  routesCategoryCount: number;
  /** settings.overviewFilter.excludeCategories 是否含 sourceSlug（含则替换为 targetSlug） */
  excludeCategories: boolean;
}

/**
 * category merge 响应（POST /doc-categories/:id/merge）
 *
 * dryRun：`source`/`target`/`affectedDocs`/`softRefs` 有值；execute：`merged`/
 * `repointedDocs`/`softRefsFixed`/`sourceDeleted` 有值。两者恒带 `batchToken` 与
 * `ingestAffected`。⚠️ category **无 alias 机制**——merge 后旧 slug 查询即空。
 */
export interface MergeDocCategoryResult {
  /** true = 预演（未写库）；false = 已执行 */
  dryRun: boolean;
  /** 本次受影响集的快照 token */
  batchToken: string;
  /** source 分类（路径参数 `:id`；dryRun 回显） */
  source?: { id: string; slug: string; name: string };
  /** target 分类（dryRun 回显） */
  target?: { id: string; slug: string; name: string };
  /** 受影响文档清单（dryRun 专用） */
  affectedDocs?: DocGovernanceAffectedDocs<MergeDocCategoryAffectedSample>;
  /** 软引用影响面（dryRun 专用） */
  softRefs?: MergeDocCategorySoftRefs;
  /** 实际生效的 slug 迁移（execute 专用） */
  merged?: { fromSlug: string; toSlug: string };
  /** 重指向的文档数（execute 专用） */
  repointedDocs?: number;
  /** 软引用修正计数（execute 专用；excludeCategoriesUpdated 是 0/1 计数） */
  softRefsFixed?: { routesUpdated: number; excludeCategoriesUpdated: number };
  /** true = source 分类已软删（execute 专用） */
  sourceDeleted?: boolean;
  /** ingest（非 native）受影响文档（两者恒有） */
  ingestAffected: DocGovernanceIngestRef[];
  /** true = 幂等重放 */
  idempotentReplay?: boolean;
}

/** orphan 清单条目（GET /doc-spaces/:id/docs/orphans） */
export interface OrphanDocItem {
  /** 文档 ID */
  id: string;
  /** 文档 path */
  path: string;
  /** 文档标题 */
  title: string;
  /** docType（可空） */
  docType: string | null;
  /** 分类 slug（无分类 / 分类已软删 → null） */
  categorySlug: string | null;
  /** 最近更新时间（ISO 字符串） */
  updatedAt: string;
}

/** orphan 清单统计（含 byTopDir 结构分组——维护者一眼分辨「结构性叶子群」vs「可行动孤儿」） */
export interface OrphanDocsStats {
  /** 空间内未软删文档总数（应用 pathPrefix 过滤后） */
  totalDocs: number;
  /** 被 doc_routes（primary ∪ secondary）引用的文档数（应用 pathPrefix 过滤后） */
  routedDocs: number;
  /** orphan 文档数（totalDocs - routedDocs；= 全量口径，不含 overviewFilter 排除） */
  orphanDocs: number;
  /** 因 overviewFilter 默认排除而未进入清单的 orphan 数（includeExcluded=true 时为 0） */
  excludedOrphanDocs: number;
  /** 按 path 第一段分组计数（结构性叶子群识别；count DESC + dir ASC 确定性排序） */
  byTopDir: Array<{ dir: string; count: number }>;
}

/**
 * orphan 文档清单响应（GET /doc-spaces/:id/docs/orphans）
 *
 * 只读现算，不落库、无调度——「周期性产出」= 维护者按需调用。
 */
export interface OrphanDocsResponse {
  /** 当前页条目 */
  items: OrphanDocItem[];
  /** 过滤后清单总数（分页前） */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页条数 */
  pageSize: number;
  /** 实际生效的过滤条件回显（overviewFilter 默认排除 + pathPrefix） */
  appliedFilters: {
    /** 生效的 docType 黑名单（含空间默认 excludeTypes） */
    excludeTypes?: string[];
    /** 生效的 category slug 黑名单（含空间默认 excludeCategories） */
    excludeCategories?: string[];
    /** 生效的路径前缀 */
    pathPrefix?: string;
    /** true = 调用方显式关闭了 overviewFilter 默认排除 */
    includeExcluded?: boolean;
  };
  /** 统计（口径见 OrphanDocsStats） */
  stats: OrphanDocsStats;
}
