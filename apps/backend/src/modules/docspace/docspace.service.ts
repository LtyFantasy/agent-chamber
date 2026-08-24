/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan §4.1-§4.3 (W2 空间/分类/成员 API)

 * [踩坑索引] B4(jsonb脏数据防御) B5(互斥参数=格式错误) B52(creator缺成员行)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释) #21(双层校验) #22(findOne必须判空)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   B52: create() 历史上只给 invitedAgentIds 写成员行，creator 不落表——成员列表缺席
 *      + 按成员表算可见性的查询路径对 creator 不命中（4b1ddd1c）。修复：creator 落
 *      role='editor' 且 invitedBy=null 行，invited 列表过滤 creator 防 PK 冲突；
 *      removeEditor/uninviteAgent 对 creator 拒绝（409），防 bug 经删除路径复活。
 *      存量数据由 BackfillCreatorMembership1787300000000 回填
 *   B4: settings.overviewFilter 的 excludeTypes/excludeCategories 手工改库可能存成字符串，
 *      字符串也有 .includes() 会静默产生错误语义。修复：resolveOverviewFilters 加 Array.isArray
 *      防御（非数组视为无默认过滤）。见 memory/2026-08-03.md §B4
 *   B5: 互斥参数同传（topicId+boardId / path+q）是请求格式错误，必须 400 VALIDATION_ERROR；
 *      历史上误用 403 Forbidden / 409 Conflict + RESOURCE_CONFLICT（2026-08-09 修复 edad7a9，
 *      三处统一）。RESOURCE_CONFLICT 只用于真实资源状态冲突（slug/source 等，本文件 845+ 各区）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull } from 'typeorm';
import * as crypto from 'crypto';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocSpaceMember } from '../../database/entities/doc-space-member.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Board } from '../../database/entities/board.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Visibility, ErrorCode, ActorType, EventType } from '@agent-chamber/shared';
import { EventService } from '../event/event.service';
import type {
  DocSpaceSummary,
  DocSpaceDetail,
  DocSpaceMemberDto,
  DocCategoryDto,
  DocSummary,
  DocSummarySlim,
  DocSpaceOverview,
  DocSpaceOverviewSlim,
  DocCategoryOverview,
  DocCategoryOverviewSlim,
  DocRouteNav,
  DocSpaceOverviewFilter,
  DocSpaceOverviewAppliedFilters,
  RepoManifest,
  PaginatedResponse,
} from '@agent-chamber/shared';
import { DocOverviewQueryDto } from './dto';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ResourceValidator } from '../../common/resource-validator';
import { UnifiedActor } from '../../common/types/actor.types';

/** Overview token cap (~20000, v1.41 图例化升格). When exceeded, docs are truncated and `truncated: true` is set. */
const OVERVIEW_TOKEN_CAP = 20000;

/**
 * Overview routes 段内嵌条数上限（v1.55 防爆，任务 T2）。
 *
 * 背景：最重租户已达 191 条路由 × 400~600 字符 ≈ 80~110KB，曾把 overview 整体
 * ~100K 响应顶到截断，冷启动 Agent 看不到尾部路由组。routes 按 sortOrder ASC
 * 策展序排列，前 50 条即最高优先级路由；尾部全量获取走分页端点
 * GET /doc-spaces/:id/routes 或 list_doc_routes 工具（overview 只做导航门面）。
 */
const OVERVIEW_ROUTES_LIMIT = 50;

/**
 * CJK 感知 token 估算（与 markdown-chunker 公式一致）：CJK 字符逐字计 1 token，
 * 其余字符按 4 字符 1 token 折算。用于：
 * - overview 地图行（title+path+summary）条目成本——不是文档全文 tokenEstimate，
 *   否则单篇大文档（如 39k token 的 api-definition.md）就会顶爆上限，导致真实数据下
 *   地图为空（生产首跑暴露）。
 * - 空间图例（spaceDescription）的 legendTokenEstimate 单列记账（v1.41）。
 */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿豈-﫿]/g) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** Overview 条目成本 = 地图行自身（title+path+summary）的 CJK 感知 token 估算 */
function overviewEntryTokens(doc: Doc): number {
  return estimateTokens(`${doc.title ?? ''}${doc.path ?? ''}${doc.summary ?? ''}`);
}

/**
 * 从 link_health jsonb 取 broken 数组长度（v1.42 B6 overview 断链汇总用）。
 * 无 linkHealth（NULL = 尚未检查）或 broken 非数组（脏数据防御，对齐 B4 jsonb 防御惯例）
 * → undefined（省略该键）。语义区分：0 = 已检查且无断链（合法结果），
 * undefined = 未检查（缺省）——两者在消费端含义不同，不可混同。
 */
function brokenCountOf(doc: Doc): number | undefined {
  const broken = (doc.linkHealth as { broken?: unknown } | null)?.broken;
  return Array.isArray(broken) ? broken.length : undefined;
}

/**
 * 从路由 health jsonb 取 broken 计数（0/1，批次 C1 overview brokenRoutes 汇总用）。
 * 无 health（NULL = 尚未检查）或 issues 非数组（脏数据防御，对齐 B4 jsonb 防御惯例）
 * → undefined（省略该键）。语义区分：1 = 该路由有 issue（issues.length>0），
 * 0 = 已检查且健康，undefined = 未检查——与 brokenCountOf 的「无数据 ≠ 零问题」同款。
 * T5：pattern 型（codeEntryType='pattern'）豁免路由的 health 为
 * { issues: [], codeEntryStatus:'exempt', ... }——issues 为空 → 计 0，天然不参与
 * totalBrokenRoutes（豁免语义由 route-health 单测 + e2e 集成覆盖）。
 */
function brokenRouteCountOf(route: DocRoute): number | undefined {
  const issues = (route.health as { issues?: unknown } | null)?.issues;
  return Array.isArray(issues) ? (issues.length > 0 ? 1 : 0) : undefined;
}

/**
 * Overview 文档条目投影（v1.56 slim）：
 * - slim=true → 只保留地图导航字段 {path,title,summary,docType,tokenEstimate}
 *   （大空间瘦身，摘要是条目 token 大头；其余元数据走 read_doc/list_docs 全字段通道）
 * - slim=false（缺省）→ 全字段 DocSummary（向后兼容，行为不变）
 * category 分组结构由调用方保持，本函数只管条目形状。
 */
function toOverviewDocItem(doc: Doc, slim: boolean): DocSummary | DocSummarySlim {
  if (slim) {
    return {
      path: doc.path,
      title: doc.title,
      summary: doc.summary,
      docType: doc.docType,
      tokenEstimate: doc.tokenEstimate,
    };
  }
  return {
    id: doc.id,
    spaceId: doc.spaceId,
    categoryId: doc.categoryId,
    path: doc.path,
    title: doc.title,
    summary: doc.summary,
    docType: doc.docType,
    tags: doc.tags,
    source: doc.source,
    sourceSha: doc.sourceSha,
    brokenLinkCount: brokenCountOf(doc),
    sectionCount: doc.sectionCount,
    tokenEstimate: doc.tokenEstimate,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Overview 内嵌路由导航投影（v1.56）：每条只保留「导航够用」的字段
 * {intent,category,primaryDocId,primaryHeadingPath,codeEntry,health.codeEntryStatus}，
 * 其余（id/sortOrder/secondary 字段/codeEntryType/health 明细/时间戳）一律省略——
 * 全字段走 GET /doc-spaces/:id/routes 或 list_doc_routes 工具（overview 只做导航门面）。
 * 这是默认行为（slim 与否同为导航投影，需求方认可的取舍：导航语义无需 secondary/
 * 管理字段，且 routes 段本就截断前 50 条）。
 * health 语义：null = 未检（原样保留）；已检 → 只透 codeEntryStatus（codeEntry 可用性
 * 指示，无 status 时序列化为 {}——与 null 的「未检」区分）；issues/checkedAt/note 省略。
 */
function toDocRouteNav(route: DocRoute): DocRouteNav {
  return {
    intent: route.intent,
    category: route.category,
    primaryDocId: route.primaryDocId,
    primaryHeadingPath: route.primaryHeadingPath,
    codeEntry: route.codeEntry,
    health:
      route.health === null || route.health === undefined
        ? null
        : { codeEntryStatus: route.health.codeEntryStatus },
  };
}

/**
 * 逗号分隔 query 参数 → 去空白去空串数组；空串/全空 → undefined（视为未传）。
 * 语义：`?excludeType=memory,guide` → ['memory','guide']；`?excludeType=` → 未传（回退空间默认）。
 */
function splitCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * overview 过滤条件（per-call 解析 + 空间默认合并后的最终生效值）
 */
interface ResolvedOverviewFilters {
  /** docType 白名单（type=，无空间默认版本） */
  types?: string[];
  /** docType 黑名单（excludeType= 优先，否则空间默认 excludeTypes） */
  excludeTypes?: string[];
  /** category slug 白名单（category=，无空间默认版本） */
  categories?: string[];
  /** category slug 黑名单（excludeCategory= 优先，否则空间默认 excludeCategories） */
  excludeCategories?: string[];
  /** tag 过滤（tag=） */
  tag?: string;
  /** 路径前缀（pathPrefix=） */
  pathPrefix?: string;
  /** token 上限（maxTokens= 或缺省 20000） */
  maxTokens: number;
  /** 回显：实际生效的过滤条件（appliedFilters，未生效维度不出现） */
  appliedFilters: DocSpaceOverviewAppliedFilters;
}

/**
 * 合并 per-call 查询参数与空间级默认过滤（settings.overviewFilter）。
 *
 * 优先级（plan WS2 定稿语义）：
 * 1. per-call 显式传参（非空）按维度覆盖空间默认 —— 传了 type 或 excludeType 任一，
 *    空间默认 excludeTypes 即不生效（显式 type=memory 应能取回被默认排除的文档）；category 维度同理
 * 2. applySpaceDefaults=false（逃生门）→ 完全忽略空间默认
 * 3. 其余缺省 → 全量（无过滤）
 */
function resolveOverviewFilters(
  space: DocSpace,
  query?: DocOverviewQueryDto,
): ResolvedOverviewFilters {
  // settings 为 jsonb，运行时可能缺失键；旧数据无 overviewFilter
  const spaceDefault = (space.settings ?? {})['overviewFilter'] as
    | DocSpaceOverviewFilter
    | undefined;
  // 脏数据防御（评审 B4）：jsonb 手工改库可能把数组存成字符串（"memory"），
  // 字符串同样有 .includes() 会静默产生错误语义——非数组一律视为无默认过滤
  const spaceDefaultExcludeTypes = Array.isArray(spaceDefault?.excludeTypes)
    ? spaceDefault.excludeTypes
    : undefined;
  const spaceDefaultExcludeCategories = Array.isArray(spaceDefault?.excludeCategories)
    ? spaceDefault.excludeCategories
    : undefined;
  const useSpaceDefaults = query?.applySpaceDefaults !== false;

  const perCall = {
    types: splitCsv(query?.type),
    excludeTypes: splitCsv(query?.excludeType),
    categories: splitCsv(query?.category),
    excludeCategories: splitCsv(query?.excludeCategory),
    tag: query?.tag?.trim() ? query.tag.trim() : undefined,
    pathPrefix: query?.pathPrefix?.trim() ? query.pathPrefix.trim() : undefined,
  };

  // exclude 维度：per-call 非空优先，否则空间默认（逃生门关闭时）；
  // 且 per-call 传了同维度的 include（type/category）同样抑制空间默认 exclude——
  // 否则「空间默认排除 memory，显式 type=memory 取回」会被默认黑名单再次剔除（plan WS2 验证场景）
  const typeDimOverridden = perCall.types !== undefined || perCall.excludeTypes !== undefined;
  const excludeTypes =
    perCall.excludeTypes ??
    (useSpaceDefaults && !typeDimOverridden ? spaceDefaultExcludeTypes : undefined);
  const categoryDimOverridden =
    perCall.categories !== undefined || perCall.excludeCategories !== undefined;
  const excludeCategories =
    perCall.excludeCategories ??
    (useSpaceDefaults && !categoryDimOverridden ? spaceDefaultExcludeCategories : undefined);

  const maxTokens = query?.maxTokens ?? OVERVIEW_TOKEN_CAP;

  // appliedFilters 回显：只回显实际生效的维度；maxTokens 仅显式传参时回显（缺省 20000 不冗余）
  const appliedFilters: DocSpaceOverviewAppliedFilters = {};
  if (perCall.types) appliedFilters.types = perCall.types;
  if (excludeTypes) appliedFilters.excludeTypes = excludeTypes;
  if (perCall.categories) appliedFilters.categories = perCall.categories;
  if (excludeCategories) appliedFilters.excludeCategories = excludeCategories;
  if (perCall.tag) appliedFilters.tag = perCall.tag;
  if (perCall.pathPrefix) appliedFilters.pathPrefix = perCall.pathPrefix;
  if (query?.maxTokens !== undefined) appliedFilters.maxTokens = query.maxTokens;

  return {
    types: perCall.types,
    excludeTypes,
    categories: perCall.categories,
    excludeCategories,
    tag: perCall.tag,
    pathPrefix: perCall.pathPrefix,
    maxTokens,
    appliedFilters,
  };
}

/**
 * Generate a URL-friendly slug from a name.
 * Lowercase, replace non-alphanumeric with hyphens, collapse multiples.
 * 非拉丁名称（如纯中文）slugify 后为空串 —— 兜底随机后缀，保证 slug 可用且唯一（由调用方唯一性循环再校验）。
 */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 128);
  if (base) return base;
  return `s-${crypto.randomUUID().slice(0, 8)}`;
}

@Injectable()
export class DocSpaceService {
  constructor(
    @InjectRepository(DocSpace)
    private spaceRepo: Repository<DocSpace>,
    @InjectRepository(DocSpaceMember)
    private memberRepo: Repository<DocSpaceMember>,
    @InjectRepository(DocCategory)
    private categoryRepo: Repository<DocCategory>,
    @InjectRepository(Doc)
    private docRepo: Repository<Doc>,
    @InjectRepository(DocSection)
    private sectionRepo: Repository<DocSection>,
    @InjectRepository(TaskDocLink)
    private taskDocLinkRepo: Repository<TaskDocLink>,
    @InjectRepository(DocRoute)
    private routeRepo: Repository<DocRoute>,
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Actor)
    private actorRepo: Repository<Actor>,
    @InjectRepository(Board)
    private boardRepo: Repository<Board>,
    @InjectRepository(Topic)
    private topicRepo: Repository<Topic>,
    private readonly accessQuery: AccessQueryService,
    private readonly resourceValidator: ResourceValidator,
    private readonly eventService: EventService,
  ) {}

  // ─── Actor helpers ──────────────────────────────────────────

  /**
   * Batch resolve actor types from the actors table.
   */
  private async resolveActorTypes(actorIds: string[]): Promise<Map<string, ActorType>> {
    const uniqueIds = [...new Set(actorIds)].filter(Boolean);
    if (uniqueIds.length === 0) return new Map();
    const actors = await this.actorRepo.find({ where: { id: In(uniqueIds) } });
    return new Map(actors.map((a) => [a.id, a.type]));
  }

  /**
   * Batch resolve actor public profiles (type, name, avatar).
   */
  private async resolveActorProfiles(
    actorIds: string[],
  ): Promise<
    Map<
      string,
      { type: ActorType; name: string; avatarUrl: string | null; description: string | null }
    >
  > {
    const typeMap = await this.resolveActorTypes(actorIds);
    const humanIds = actorIds.filter((id) => typeMap.get(id) === ActorType.HUMAN);
    const agentIds = actorIds.filter((id) => typeMap.get(id) === ActorType.AGENT);

    const [humans, agents] = await Promise.all([
      humanIds.length > 0
        ? this.userRepo.find({ where: { id: In(humanIds) }, relations: { actor: true } })
        : Promise.resolve([] as User[]),
      agentIds.length > 0
        ? this.agentRepo.find({ where: { id: In(agentIds) }, relations: { actor: true } })
        : Promise.resolve([] as Agent[]),
    ]);

    const humanMap = new Map(humans.map((u) => [u.id, u]));
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const result = new Map<
      string,
      { type: ActorType; name: string; avatarUrl: string | null; description: string | null }
    >();
    for (const id of actorIds) {
      const type = typeMap.get(id);
      if (type === ActorType.HUMAN) {
        const user = humanMap.get(id);
        result.set(id, {
          type,
          name: user?.displayName || user?.username || 'Unknown User',
          avatarUrl: user?.avatarUrl ?? null,
          description: null,
        });
      } else if (type === ActorType.AGENT) {
        const agent = agentMap.get(id);
        result.set(id, {
          type,
          name: agent?.name || 'Unknown Agent',
          avatarUrl: agent?.avatarUrl ?? null,
          description: agent?.description ?? null,
        });
      }
    }
    return result;
  }

  // ─── Slug generation ────────────────────────────────────────

  /**
   * Generate a unique slug within the space (excluding soft-deleted).
   * If the base slug collides, appends a suffix (-2, -3, ...).
   */
  private async generateUniqueSlug(baseSlug: string, excludeSpaceId?: string): Promise<string> {
    let slug = baseSlug;
    let suffix = 2;

    while (true) {
      const qb = this.spaceRepo
        .createQueryBuilder('ds')
        .where('ds.slug = :slug', { slug })
        .andWhere('ds.deleted_at IS NULL');
      if (excludeSpaceId) {
        qb.andWhere('ds.id != :excludeSpaceId', { excludeSpaceId });
      }
      const existing = await qb.getOne();
      if (!existing) return slug;

      slug = `${baseSlug}-${suffix}`;
      if (slug.length > 128) {
        slug = baseSlug.slice(0, 128 - String(suffix).length - 1) + `-${suffix}`;
      }
      suffix++;
    }
  }

  /**
   * Generate a unique slug within a space's categories.
   */
  private async generateUniqueCategorySlug(
    spaceId: string,
    baseSlug: string,
    excludeId?: string,
  ): Promise<string> {
    let slug = baseSlug;
    let suffix = 2;

    while (true) {
      const qb = this.categoryRepo
        .createQueryBuilder('dc')
        .where('dc.space_id = :spaceId', { spaceId })
        .andWhere('dc.slug = :slug', { slug })
        .andWhere('dc.deleted_at IS NULL');
      if (excludeId) {
        qb.andWhere('dc.id != :excludeId', { excludeId });
      }
      const existing = await qb.getOne();
      if (!existing) return slug;

      slug = `${baseSlug}-${suffix}`;
      if (slug.length > 128) {
        slug = baseSlug.slice(0, 128 - String(suffix).length - 1) + `-${suffix}`;
      }
      suffix++;
    }
  }

  // ─── Validation helpers ─────────────────────────────────────

  /** Validate topicId/boardId mutual exclusivity (both → 400 VALIDATION_ERROR). */
  private validateBinding(dto: { topicId?: string; boardId?: string }): void {
    if (dto.topicId && dto.boardId) {
      throw new BadRequestException({
        message: 'topicId and boardId are mutually exclusive — provide at most one',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
  }

  /** Look up board by id, throw if not found. */
  private async ensureBoardExists(boardId: string): Promise<Board> {
    const board = await this.boardRepo.findOne({ where: { id: boardId } });
    if (!board) {
      throw new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND });
    }
    return board;
  }

  /** Look up topic by id, throw if not found. */
  private async ensureTopicExists(topicId: string): Promise<void> {
    const topic = await this.topicRepo.findOne({ where: { id: topicId } });
    if (!topic) {
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });
    }
  }

  // ─── Enrich helpers ─────────────────────────────────────────

  /** Aggregate members with actor public info. */
  private async enrichMembers(spaceId: string): Promise<DocSpaceMemberDto[]> {
    const members = await this.memberRepo.find({
      where: { spaceId },
      order: { createdAt: 'ASC' },
    });
    if (members.length === 0) return [];

    const memberActorIds = members.map((m) => m.actorId);
    const profileMap = await this.resolveActorProfiles(memberActorIds);

    return members.map((m) => {
      const profile = profileMap.get(m.actorId);
      return {
        actorId: m.actorId,
        actorName: profile?.name || 'Unknown',
        actorType: (profile?.type === ActorType.HUMAN ? 'human' : 'agent') as 'human' | 'agent',
        role: m.role,
        invitedBy: m.invitedBy,
        createdAt: m.createdAt,
      };
    });
  }

  /** Aggregate categories for a space. */
  private async enrichCategories(spaceId: string): Promise<DocCategoryDto[]> {
    const categories = await this.categoryRepo.find({
      where: { spaceId, deletedAt: IsNull() },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return categories.map((c) => ({
      id: c.id,
      spaceId: c.spaceId,
      name: c.name,
      slug: c.slug,
      description: c.description,
      sortOrder: c.sortOrder,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  /** Count non-deleted docs in a space. */
  private async countDocs(spaceId: string): Promise<number> {
    const result = await this.docRepo
      .createQueryBuilder('doc')
      .select('COUNT(*)', 'count')
      .where('doc.space_id = :spaceId', { spaceId })
      .andWhere('doc.deleted_at IS NULL')
      .getRawOne();
    return parseInt(result?.count ?? '0', 10);
  }

  /**
   * Count distinct tasks linked to non-deleted docs in this space (via task_doc_links).
   * 单 count 查询（join docs 过滤软删），不加 join 载荷；供 detail 响应 linkedTaskCount。
   */
  private async countLinkedTasks(spaceId: string): Promise<number> {
    const result = await this.taskDocLinkRepo
      .createQueryBuilder('tdl')
      .select('COUNT(DISTINCT tdl.task_id)', 'count')
      .innerJoin('docs', 'doc', 'doc.id = tdl.doc_id')
      .where('doc.space_id = :spaceId', { spaceId })
      .andWhere('doc.deleted_at IS NULL')
      .getRawOne<{ count: string }>();
    return parseInt(result?.count ?? '0', 10);
  }

  // ─── CRUD: DocSpace ─────────────────────────────────────────

  /** Raw find by ID (no permission check). */
  async findById(id: string): Promise<DocSpace> {
    const space = await this.spaceRepo.findOne({ where: { id } });
    if (!space) {
      throw new NotFoundException({
        message: 'DocSpace not found',
        code: ErrorCode.DOC_SPACE_NOT_FOUND,
      });
    }
    return space;
  }

  /** Enrich a single space into DocSpaceDetail. */
  async enrich(space: DocSpace): Promise<DocSpaceDetail> {
    const [members, categories, docCount, linkedTaskCount] = await Promise.all([
      this.enrichMembers(space.id),
      this.enrichCategories(space.id),
      this.countDocs(space.id),
      this.countLinkedTasks(space.id),
    ]);

    const { description, ...rest } = space;

    return {
      ...rest,
      description,
      descriptionSnippet: description?.slice(0, 200) ?? null,
      visibility: (space.settings?.visibility || Visibility.OPEN) as Visibility,
      topicId: space.topicId,
      boardId: space.boardId,
      creatorId: space.creatorId,
      docCount,
      linkedTaskCount,
      members,
      categories,
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
    };
  }

  /**
   * List spaces with pagination + whitelist filtering.
   */
  async findAll(
    query: { page?: number; pageSize?: number; boardId?: string; topicId?: string } = {},
    actor?: UnifiedActor,
  ): Promise<PaginatedResponse<DocSpaceSummary>> {
    const { page = 1, pageSize = 20, boardId, topicId } = query;

    const accessibleIds = await this.accessQuery.getAccessibleDocSpaceIds(actor);
    // Non-admin with empty whitelist → return empty page
    if (accessibleIds !== null && accessibleIds.length === 0) {
      return {
        items: [],
        total: 0,
        page: +page,
        pageSize: +pageSize,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
    }

    const qb = this.spaceRepo.createQueryBuilder('ds').where('ds.deleted_at IS NULL');

    if (accessibleIds) {
      qb.andWhere('ds.id IN (:...accessibleIds)', { accessibleIds });
    }
    if (boardId) {
      qb.andWhere('ds.board_id = :boardId', { boardId });
    }
    if (topicId) {
      qb.andWhere('ds.topic_id = :topicId', { topicId });
    }

    const [items, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .orderBy('ds.createdAt', 'DESC')
      .getManyAndCount();

    const enrichedItems: DocSpaceSummary[] = items.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      descriptionSnippet: s.description?.slice(0, 200) ?? null,
      topicId: s.topicId,
      boardId: s.boardId,
      visibility: (s.settings?.visibility || Visibility.OPEN) as Visibility,
      creatorId: s.creatorId,
      docCount: s.docCount,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: enrichedItems,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
    };
  }

  /** Create a new DocSpace. */
  async create(
    actor: UnifiedActor,
    dto: {
      name: string;
      slug?: string;
      description?: string;
      topicId?: string;
      boardId?: string;
      visibility?: Visibility;
      invitedAgentIds?: string[];
    },
  ): Promise<DocSpace> {
    this.validateBinding(dto);

    if (dto.topicId) {
      await this.ensureTopicExists(dto.topicId);
    }
    if (dto.boardId) {
      await this.ensureBoardExists(dto.boardId);
    }

    // Validate invited agents exist
    const invitedAgentIds = dto.invitedAgentIds || [];
    if (invitedAgentIds.length > 0) {
      await this.resourceValidator.existsMany(
        this.agentRepo,
        invitedAgentIds,
        ErrorCode.AGENT_NOT_FOUND,
      );
    }

    const baseSlug = dto.slug || slugify(dto.name);
    const slug = await this.generateUniqueSlug(baseSlug);

    const space = this.spaceRepo.create({
      name: dto.name,
      slug,
      description: dto.description ?? null,
      topicId: dto.topicId ?? null,
      boardId: dto.boardId ?? null,
      creatorId: actor.id,
      settings: { visibility: dto.visibility ?? Visibility.OPEN },
      // docCount 由 trigger 单一事实源维护，应用层禁写（缺省 0 走 DB default）
    });
    const saved = await this.spaceRepo.save(space);

    // Create initial members。
    // creator 单独落 role='editor' 行（invitedBy=null）：成员列表可见 + 按成员表算可见性
    // 的查询路径（AccessQueryService）对 creator 命中；权限本身仍由 isCreator 直比保证。
    // invited 列表须过滤 creator——creator 行已单独写入，重复会触发 (space_id, actor_id)
    // PK 冲突。invitedBy=null 标记「非授予产生」，backfill migration 的 down() 据此精确回滚
    const memberEntities = [...new Set(invitedAgentIds)]
      .filter((agentId) => agentId !== actor.id)
      .map((agentId) =>
        this.memberRepo.create({
          spaceId: saved.id,
          actorId: agentId,
          role: 'member',
          invitedBy: actor.id,
        }),
      );
    memberEntities.push(
      this.memberRepo.create({
        spaceId: saved.id,
        actorId: actor.id,
        role: 'editor',
        invitedBy: null,
      }),
    );
    await this.memberRepo.save(memberEntities);

    return saved;
  }

  /** Update a DocSpace. */
  async update(
    id: string,
    dto: {
      name?: string;
      description?: string | null;
      visibility?: Visibility;
      topicId?: string | null;
      boardId?: string | null;
      overviewFilter?: DocSpaceOverviewFilter | null;
    },
  ): Promise<DocSpace> {
    const space = await this.findById(id);

    if (dto.topicId !== undefined || dto.boardId !== undefined) {
      this.validateBinding({
        topicId: dto.topicId ?? undefined,
        boardId: dto.boardId ?? undefined,
      });
      if (dto.topicId) {
        await this.ensureTopicExists(dto.topicId);
        space.topicId = dto.topicId;
        // clear the other binding
        space.boardId = null;
      } else if (dto.boardId) {
        await this.ensureBoardExists(dto.boardId);
        space.boardId = dto.boardId;
        space.topicId = null;
      } else {
        // 显式 null：解除对应侧绑定（未绑定侧传 null 为无操作；
        // 任务↔文档链接按 docId 关联，与 space 绑定无关，解绑不级联）
        if (dto.topicId === null) space.topicId = null;
        if (dto.boardId === null) space.boardId = null;
      }
    }

    if (dto.name !== undefined) space.name = dto.name;
    // 「字段出现即采用」语义：显式 null = 清空（写 null），未传（undefined）才保留旧值。
    // 不用真值判断（`?? existing`），否则 null 会被误判为"未提供"而保留旧值。
    if (dto.description !== undefined) space.description = dto.description;
    if (dto.visibility !== undefined) {
      space.settings = { ...space.settings, visibility: dto.visibility };
    }
    // 空间级 overview 默认过滤（v1.38）：显式 null = 清除该键；未传保留旧值
    if (dto.overviewFilter !== undefined) {
      const settings = { ...space.settings };
      if (dto.overviewFilter === null) {
        delete settings.overviewFilter;
      } else {
        settings.overviewFilter = dto.overviewFilter;
      }
      space.settings = settings;
    }

    return this.spaceRepo.save(space);
  }

  /**
   * 写入仓库文件清单（v1.42 批次 C2，唯一写口 = scripts/sync-docs.mjs 部署上报）。
   *
   * 原子单条 SQL：`jsonb_set(settings, '{repoManifest}', $1::jsonb)` 只动 repoManifest 键，
   * visibility/overviewFilter 等既有键不受影响（禁 read-modify-write——并发下整对象覆盖会丢键，
   * 对齐 board.service.updateMetrics 原子先例，plan §3 C2 硬语义）。
   * reportedAt 由服务端 now 生成（不信客户端时钟）；manifest 永不经 DTO 之外的路径写入。
   *
   * @param spaceId - 空间 ID（Controller 层已 findById 判空 + write 权限检查）
   * @param manifest - { sha, files }（路径格式已在 DTO 层校验，铁律 #21）
   * @returns 写后 settings.repoManifest（RETURNING 单条 SQL，无第二次查询；无则 null）
   */
  async updateRepoManifest(
    spaceId: string,
    manifest: { sha: string; files: string[] },
  ): Promise<{ repoManifest: RepoManifest | null }> {
    // 存储形状：客户端上报 + 服务端写入时刻（reportedAt 防客户端伪造时间戳）
    const stored: RepoManifest = {
      sha: manifest.sha,
      files: manifest.files,
      reportedAt: new Date().toISOString(),
    };
    // 原生 query：TypeORM 实体级 update 无法表达 jsonb_set 片段，且会整体覆盖 settings。
    // AND deleted_at IS NULL：软删空间不得接受写入（Controller findById 已过滤，此处 TOCTOU 兜底）
    const rows: Array<{ settings?: Record<string, any> | null }> = await this.spaceRepo.query(
      `UPDATE doc_spaces SET settings = jsonb_set(settings, '{repoManifest}', $1::jsonb) WHERE id = $2 AND deleted_at IS NULL RETURNING settings`,
      [JSON.stringify(stored), spaceId],
    );
    // 防御：Controller 已判空，此处兜底 TOCTOU 窗口（铁律 #22）
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NotFoundException({
        message: 'DocSpace not found',
        code: ErrorCode.DOC_SPACE_NOT_FOUND,
      });
    }
    const repoManifest = (rows[0].settings?.repoManifest as RepoManifest | undefined) ?? null;
    return { repoManifest };
  }

  /**
   * Delete a DocSpace (cascade soft delete).
   * Soft-deletes all docs + the space in one transaction, then emits a
   * doc_deleted event per cascaded doc (plan §4.2: 删除处发射，Agent 经 events/poll 感知).
   *
   * NOTE: doc_sections have NO deleted_at column (hard-delete-only table).
   * Orphan sections of soft-deleted docs are unreachable — every read path
   * (search / overview / findOne / getContent / getSection / TaskDetail join)
   * filters `docs.deleted_at IS NULL` — so sections are intentionally left as-is.
   * （历史教训：曾在此对 doc_sections 做软删 UPDATE，列不存在导致删除含文档的空间必然 500，
   *  单测 mock 掉事务从未暴露——真 DB 验证是硬门槛。）
   */
  async remove(
    id: string,
    actor?: UnifiedActor,
  ): Promise<{ deleted: boolean; docCount: number; linkedTaskCount: number }> {
    const space = await this.findById(id);

    // Count non-deleted docs (path/title kept for event payloads)
    const docResult = await this.docRepo
      .createQueryBuilder('doc')
      .select(['doc.id AS id', 'doc.path AS path', 'doc.title AS title'])
      .where('doc.space_id = :spaceId', { spaceId: id })
      .andWhere('doc.deleted_at IS NULL')
      .getRawMany<{ id: string; path: string; title: string }>();
    const docCount = docResult.length;
    const docIds = docResult.map((d) => d.id);

    // Count linked tasks (join task_doc_links)
    let linkedTaskCount = 0;
    if (docIds.length > 0) {
      const linkResult = await this.taskDocLinkRepo
        .createQueryBuilder('tdl')
        .select('COUNT(DISTINCT tdl.task_id)', 'count')
        .where('tdl.doc_id IN (:...docIds)', { docIds })
        .getRawOne<{ count: string }>();
      linkedTaskCount = parseInt(linkResult?.count ?? '0', 10);
    }

    // In a transaction: soft-delete all docs in the space, then soft-delete the space itself.
    await this.spaceRepo.manager.transaction(async (manager) => {
      // Soft-delete docs in space
      if (docIds.length > 0) {
        await manager
          .createQueryBuilder()
          .update('Doc')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .set({ deletedAt: new Date() } as any)
          .where('id IN (:...docIds)', { docIds })
          .execute();
      }

      // Soft-delete the space itself
      await manager
        .createQueryBuilder()
        .update('DocSpace')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ deletedAt: new Date() } as any)
        .where('id = :id', { id })
        .execute();
    });

    // Emit doc_deleted per cascaded doc (after commit; payload mirrors DocService.remove)
    for (const d of docResult) {
      await this.eventService.create({
        eventType: EventType.DOC_DELETED,
        resourceType: 'doc',
        resourceId: d.id,
        actorId: actor?.id ?? undefined,
        topicId: space.topicId ?? undefined,
        boardId: space.boardId ?? undefined,
        payload: { spaceId: id, docId: d.id, path: d.path, title: d.title },
      });
    }

    return { deleted: true, docCount, linkedTaskCount };
  }

  // ─── Members ────────────────────────────────────────────────

  /** Invite an agent as member. Idempotent: 409 if already exists. */
  async inviteAgent(spaceId: string, agentId: string): Promise<DocSpace> {
    const space = await this.findById(spaceId);

    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

    const existing = await this.memberRepo.findOne({
      where: { spaceId, actorId: agentId },
    });
    if (existing) {
      throw new ConflictException({
        message: 'Agent already has access to this space',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    const member = this.memberRepo.create({
      spaceId,
      actorId: agentId,
      role: 'member',
      invitedBy: space.creatorId,
    });
    await this.memberRepo.save(member);

    return space;
  }

  /** Uninvite an agent (remove member row). */
  async uninviteAgent(spaceId: string, agentId: string): Promise<DocSpace> {
    const space = await this.findById(spaceId);

    // creator 成员行不可经 uninvite 移除（显式守卫优先于 editor-role 检查，给出明确语义）
    if (space.creatorId === agentId) {
      throw new ConflictException({
        message: 'Space creator cannot be uninvited',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

    const existing = await this.memberRepo.findOne({
      where: { spaceId, actorId: agentId },
    });
    if (!existing) {
      throw new ConflictException({
        message: 'Agent is not a member',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }
    if (existing.role === 'editor') {
      throw new ConflictException({
        message: 'Use removeEditor first',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    await this.memberRepo.delete({ spaceId, actorId: agentId });

    return space;
  }

  /** Promote member to editor. */
  async addEditor(spaceId: string, agentId: string): Promise<DocSpace> {
    const space = await this.findById(spaceId);

    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

    const existing = await this.memberRepo.findOne({
      where: { spaceId, actorId: agentId },
    });

    if (existing) {
      if (existing.role === 'editor') {
        throw new ConflictException({
          message: 'Agent is already an editor',
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
      // member → editor upgrade
      existing.role = 'editor';
      await this.memberRepo.save(existing);
    } else {
      // Create editor row directly (upsert semantics: new editor)
      const member = this.memberRepo.create({
        spaceId,
        actorId: agentId,
        role: 'editor',
        invitedBy: space.creatorId,
      });
      await this.memberRepo.save(member);
    }

    return space;
  }

  /** Demote editor to member. Editor row is changed to member (not deleted — prevents dangling members). */
  async removeEditor(spaceId: string, agentId: string): Promise<DocSpace> {
    const space = await this.findById(spaceId);

    // creator 的 editor 行不可降级：creator 权限由 isCreator 直比保证，但成员行承载
    // 成员列表可见性 + AccessQueryService 白名单语义，降级会让「creator 缺席成员表
    // editor 语义」的原始 bug 经本路径复活（4b1ddd1c）
    if (space.creatorId === agentId) {
      throw new ConflictException({
        message: 'Space creator cannot be removed as editor',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

    const existing = await this.memberRepo.findOne({
      where: { spaceId, actorId: agentId, role: 'editor' },
    });
    if (!existing) {
      throw new ConflictException({
        message: 'Agent is not an editor',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // Demote: editor → member (never delete the row — that would remove access)
    existing.role = 'member';
    await this.memberRepo.save(existing);

    return space;
  }

  /**
   * 转让空间创建者（v1.45 DOCSPACE-PERM，D2 决策）——「干净交接」语义：
   * - 旧 creator 不自动获得任何角色：PRIVATE 空间下转让后旧 creator 失去读权限
   *   （前端 confirm 已明示不可逆，R5）；不创建/保留任何 member 行。
   * - 新 creator 若有既有 member 行则删除（creator 身份覆盖成员身份，避免角色残留）。
   * - 目标是 agent 时，其人类 owner 经 owner-proxy（isCreatorOf 只比 id）自动视同
   *   creator——人类把空间转给自己的 agent 后不会锁死自己（兜底语义）。
   * - 与 invite/add-editor 一致：不发 event/audit（D4）。
   *
   * @param spaceId 空间 ID（Controller 已 findById 判空 + creator-only 权限检查）
   * @param newCreatorId 目标 actor ID（人/agent 统一 actors 表）
   * @throws NotFoundException - 目标 actor 不存在（ErrorCode.ACTOR_NOT_FOUND）
   * @throws ConflictException - 目标已是当前 creator（RESOURCE_CONFLICT）
   * @returns 转让后的 DocSpace 实体
   */
  async transferCreator(spaceId: string, newCreatorId: string): Promise<DocSpace> {
    const space = await this.findById(spaceId);

    // 双层校验第二层：目标必须真实存在于 actors 表（铁律 #21/#22）
    await this.resourceValidator.exists(this.actorRepo, newCreatorId, ErrorCode.ACTOR_NOT_FOUND);

    // 转给自己 = 无操作请求：真实资源状态冲突，用 RESOURCE_CONFLICT（B5 语义，不误用 400/403）
    if (space.creatorId === newCreatorId) {
      throw new ConflictException({
        message: 'Target is already the space creator',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // 干净交接：删除新 creator 的既有 member 行（若有）——creator 身份覆盖成员身份。
    // delete 幂等：无 member 行时 affected=0，非错误。
    await this.memberRepo.delete({ spaceId, actorId: newCreatorId });

    space.creatorId = newCreatorId;
    return this.spaceRepo.save(space);
  }

  // ─── Categories ─────────────────────────────────────────────

  /** Find a category by ID, throw if not found or soft-deleted. */
  async findCategoryById(id: string): Promise<DocCategory> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException({
        message: 'Category not found',
        code: ErrorCode.DOC_CATEGORY_NOT_FOUND,
      });
    }
    return category;
  }

  /** Create a category in a space. Slug must be unique within the space. */
  async createCategory(
    spaceId: string,
    dto: { name: string; slug?: string; description?: string; sortOrder?: number },
  ): Promise<DocCategory> {
    const space = await this.findById(spaceId);

    const baseSlug = dto.slug || slugify(dto.name);
    const slug = await this.generateUniqueCategorySlug(spaceId, baseSlug);

    const category = this.categoryRepo.create({
      spaceId: space.id,
      name: dto.name,
      slug,
      description: dto.description ?? null,
      sortOrder: dto.sortOrder ?? 0,
    });
    return this.categoryRepo.save(category);
  }

  /** Update a category. */
  async updateCategory(
    id: string,
    dto: { name?: string; slug?: string; description?: string; sortOrder?: number },
  ): Promise<DocCategory> {
    const category = await this.findCategoryById(id);

    if (dto.name !== undefined) category.name = dto.name;
    if (dto.description !== undefined) category.description = dto.description;
    if (dto.sortOrder !== undefined) category.sortOrder = dto.sortOrder;
    if (dto.slug !== undefined && dto.slug !== category.slug) {
      const newSlug = await this.generateUniqueCategorySlug(
        category.spaceId,
        dto.slug,
        category.id,
      );
      category.slug = newSlug;
    }

    return this.categoryRepo.save(category);
  }

  /**
   * Delete a category.
   * Does NOT delete docs — sets their categoryId to null (uncategorized) in the same transaction.
   */
  async removeCategory(id: string): Promise<void> {
    await this.findCategoryById(id);

    await this.categoryRepo.manager.transaction(async (manager) => {
      // Set doc.categoryId to null for docs in this category
      await manager
        .createQueryBuilder()
        .update('Doc')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ categoryId: null } as any)
        .where('category_id = :categoryId', { categoryId: id })
        .andWhere('deleted_at IS NULL')
        .execute();

      // Soft-delete the category
      await manager
        .createQueryBuilder()
        .update('DocCategory')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ deletedAt: new Date() } as any)
        .where('id = :id', { id })
        .execute();
    });
  }

  // ─── Overview ───────────────────────────────────────────────

  /**
   * Generate a compact overview map of the space.
   * Categories sorted by sortOrder → each contains docs sorted by path.
   * Uncategorized docs also included. Token cap ~20000 with truncation.
   *
   * v1.38 起支持可配置过滤：per-call 查询参数（type/excludeType/category/excludeCategory/
   * tag/pathPrefix/maxTokens/applySpaceDefaults）+ 空间级默认过滤（settings.overviewFilter），
   * 合并语义见 resolveOverviewFilters；响应回显实际生效的 appliedFilters。
   *
   * v1.41 图例化：includeDescription 缺省 true 时内嵌 space.description 全文
   * （markdown 空间图例，始终全量不截断）；legendTokenEstimate 单列图例 token，
   * 不参与 maxTokens 文档条目预算竞争；totalTokenEstimate = 图例 + 文档条目合计（仅信息回显）。
   *
   * v1.42 B5 意图路由内嵌：includeRoutes 缺省 true 时内嵌 doc_routes（按
   * sortOrder+createdAt ASC），与图例同待遇——不占 maxTokens 文档条目预算；
   * routesTokenEstimate 用 estimateTokens 对序列化 routes 单列记账并计入 totalTokenEstimate；
   * truncated 语义不变（只管文档条目）。显式 includeRoutes=false 时省略 routes 相关全部字段。
   *
   * v1.55 routes 段防爆：内嵌最多前 OVERVIEW_ROUTES_LIMIT（=50）条策展序路由，
   * routesTruncated/routesTotal 透出截断状态与全量条数；totalBrokenRoutes 仍按全量统计。
   *
   * v1.56 slim 瘦身：slim=true 时每条 doc 只返回导航字段
   * {path,title,summary,docType,tokenEstimate}（category 分组结构不变，返回
   * DocSpaceOverviewSlim 形状）；routes 内嵌段恒为导航投影（toDocRouteNav，默认行为
   * 变更，全字段走 list_doc_routes）。缺省 slim=false 全字段不变（向后兼容）。
   */
  async getOverview(
    spaceId: string,
    query?: DocOverviewQueryDto,
  ): Promise<DocSpaceOverview | DocSpaceOverviewSlim> {
    const space = await this.findById(spaceId);

    const filters = resolveOverviewFilters(space, query);
    const { types, excludeTypes, categories, excludeCategories, tag, pathPrefix } = filters;
    const maxTokens = filters.maxTokens;
    // slim 投影（v1.56）：显式 'true' 才生效，缺省/‘false’ = 全字段（向后兼容）
    const slim = query?.slim === true;
    // 缺省内嵌图例（v1.41）：显式 false 才省略（对齐 applySpaceDefaults 的"缺省 true"语义）
    const includeDescription = query?.includeDescription !== false;
    // 缺省内嵌意图路由（v1.42 B5）：显式 false 才省略（与 includeDescription 同惯例）
    const includeRoutes = query?.includeRoutes !== false;

    // Load non-deleted categories sorted by sortOrder
    // Note: deletedAt has select:false, so we use a raw query or QB
    const allCategories = await this.categoryRepo
      .createQueryBuilder('dc')
      .where('dc.space_id = :spaceId', { spaceId })
      .andWhere('dc.deleted_at IS NULL')
      .orderBy('dc.sort_order', 'ASC')
      .addOrderBy('dc.created_at', 'ASC')
      .getMany();

    // Load all non-deleted docs in the space
    // 过滤在内存完成：overview 本就全量拉取单空间文档（量级有限），且 category slug
    // 白名单需要已加载的分类做 slug→id 预解析；避免把过滤逻辑散进 SQL 降低可读性。
    const docs = await this.docRepo
      .createQueryBuilder('d')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .orderBy('d.path', 'ASC')
      .getMany();

    // category slug → id 预解析（仅白/黑名单生效时使用）
    const slugToId = new Map(allCategories.map((c) => [c.slug, c.id]));
    // include 白名单：doc.categoryId 必须命中；exclude 黑名单：命中即剔除。
    // 语义（plan WS2）：include 与 exclude 同现 = 先 include 后 exclude（交集）
    const whiteCategoryIds = categories
      ? new Set(categories.map((slug) => slugToId.get(slug)).filter((id) => id !== undefined))
      : undefined;
    const blackCategoryIds = excludeCategories
      ? new Set(
          excludeCategories.map((slug) => slugToId.get(slug)).filter((id) => id !== undefined),
        )
      : undefined;

    const filteredDocs = docs.filter((doc) => {
      if (types && (!doc.docType || !types.includes(doc.docType))) return false;
      if (excludeTypes && doc.docType && excludeTypes.includes(doc.docType)) return false;
      if (whiteCategoryIds && (!doc.categoryId || !whiteCategoryIds.has(doc.categoryId))) {
        return false;
      }
      if (blackCategoryIds && doc.categoryId && blackCategoryIds.has(doc.categoryId)) {
        return false;
      }
      if (tag && !(doc.tags ?? []).includes(tag)) return false;
      if (pathPrefix && !doc.path.startsWith(pathPrefix)) return false;
      return true;
    });

    const docMap = new Map<string | null, Doc[]>();
    for (const doc of filteredDocs) {
      const key = doc.categoryId ?? null;
      if (!docMap.has(key)) docMap.set(key, []);
      docMap.get(key)!.push(doc);
    }

    // 文档条目预算累计（v1.41 语义明确）：只装文档条目，图例 token 不参与 maxTokens 竞争；
    // 最终回显的 totalTokenEstimate = 文档合计 + legendTokenEstimate（见返回处）
    let totalTokenEstimate = 0;
    let truncated = false;

    const categoryOverviews: (DocCategoryOverview | DocCategoryOverviewSlim)[] = [];

    // 分类输出：白名单命中分类保留（未命中整体省略）；黑名单命中分类整体隐藏（含其文档）。
    // 两维度对称——include 保留命中分类，exclude 剔除命中分类
    for (const cat of allCategories) {
      if (whiteCategoryIds && !whiteCategoryIds.has(cat.id)) continue;
      if (blackCategoryIds && blackCategoryIds.has(cat.id)) continue;
      const catDocs = docMap.get(cat.id) || [];
      // 条目形状随 slim 参数（slim=true → DocSummarySlim，缺省 → DocSummary 全字段）
      const docItems: (DocSummary | DocSummarySlim)[] = [];
      for (const doc of catDocs) {
        if (totalTokenEstimate + overviewEntryTokens(doc) > maxTokens) {
          truncated = true;
          break;
        }
        totalTokenEstimate += overviewEntryTokens(doc);
        docItems.push(toOverviewDocItem(doc, slim));
      }
      if (truncated) break;

      categoryOverviews.push({
        id: cat.id,
        spaceId: cat.spaceId,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        sortOrder: cat.sortOrder,
        createdAt: cat.createdAt,
        updatedAt: cat.updatedAt,
        docs: docItems,
      });
    }

    // Uncategorized docs（传 category 白名单时省略该段——未分类文档不属于任何被选分类）
    const uncategorized: (DocSummary | DocSummarySlim)[] = [];
    if (!categories) {
      const uncategorizedDocs = docMap.get(null) || [];
      for (const doc of uncategorizedDocs) {
        if (totalTokenEstimate + overviewEntryTokens(doc) > maxTokens) {
          truncated = true;
          break;
        }
        totalTokenEstimate += overviewEntryTokens(doc);
        uncategorized.push(toOverviewDocItem(doc, slim));
      }
    }

    // 断链汇总（v1.42 B6）：过滤后可见文档的 broken 计数合计——与 brokenLinkCount 同一
    // 视图口径（被过滤掉的文档不计入）。0 也返回（有已检查文档时）；全部文档均未检查
    // （无 linkHealth）则省略——"空间没有断链"与"空间从未检查过断链"语义不同。
    let totalBrokenLinks = 0;
    let hasCheckedDocs = false;
    for (const doc of filteredDocs) {
      const n = brokenCountOf(doc);
      if (n !== undefined) {
        totalBrokenLinks += n;
        hasCheckedDocs = true;
      }
    }

    // 图例（v1.41）：includeDescription 且 description 非空 → 内嵌全文（始终全量，不截断）；
    // legendTokenEstimate 用 estimateTokens 单列记账，不参与上方文档条目预算竞争。
    const legendTokenEstimate =
      includeDescription && space.description ? estimateTokens(space.description) : undefined;

    // 意图路由（v1.42 B5）：includeRoutes 缺省 true → 内嵌返回（同一 find，与图例同待遇，
    // 不占 maxTokens 文档条目预算）；routesTokenEstimate 对序列化 routes 单列记账并计入 totalTokenEstimate。
    // v1.55 防爆截断：最多内嵌策展序前 OVERVIEW_ROUTES_LIMIT（=50）条，routesTruncated/routesTotal
    // 标记透出全量规模，把"是否拉全"的选择权交给调用方（全量走分页端点/list_doc_routes 工具）。
    // v1.56 导航投影：每条裁到 toDocRouteNav 字段集（默认行为，slim 与否一致）——
    // 全字段获取走 list_doc_routes，overview 只做导航门面。
    let routes: DocRouteNav[] | undefined;
    let routesTokenEstimate: number | undefined;
    let routesTruncated: boolean | undefined;
    let routesTotal: number | undefined;
    // 路由健康汇总（v1.42 批次 C1）：与 totalBrokenLinks 同款装配模式——有任一路由已检
    // （health 非 NULL 且 issues 为数组）时返回"broken 路由数"（issues.length>0 的计数和，
    // 0 也返回），全部未检则省略。includeRoutes=false 时同步省略（无 routes 可统计）。
    // 统计口径为空间全量路由（不受展示层截断影响——健康是空间级指标）。
    let totalBrokenRoutes: number | undefined;
    if (includeRoutes) {
      const routeRows = await this.routeRepo.find({
        where: { spaceId },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
      routesTotal = routeRows.length;
      routesTruncated = routeRows.length > OVERVIEW_ROUTES_LIMIT;
      // 截断只影响内嵌展示：取策展序（sortOrder ASC → createdAt ASC）前 N 条
      const visibleRows = routesTruncated ? routeRows.slice(0, OVERVIEW_ROUTES_LIMIT) : routeRows;
      routes = visibleRows.map(toDocRouteNav);
      // 序列化 routes 的 token 估算（CJK 感知同款公式，按截断后实际返回内容记账——
      // 语义 = 本响应消耗的 token）；空集合成本为 0——
      // 保持 v1.41 既有契约"空 overview totalTokenEstimate=0"不变（'[]' 的 1 token 属实现噪声）。
      routesTokenEstimate = routes.length > 0 ? estimateTokens(JSON.stringify(routes)) : 0;

      let sum = 0;
      let hasCheckedRoutes = false;
      for (const route of routeRows) {
        const n = brokenRouteCountOf(route);
        if (n !== undefined) {
          sum += n;
          hasCheckedRoutes = true;
        }
      }
      if (hasCheckedRoutes) totalBrokenRoutes = sum;
    }

    // 文档条目截断元数据补齐：docsTotal = 过滤后文档总数（不受 maxTokens
    // 截断影响，恒为全量计数，对齐 routesTotal 先例）；docsReturned = 实际返回条目数
    // （截断时 < docsTotal）。恒输出，形状可预测——调用方凭 docsReturned < docsTotal
    // 判断需要分页拉全，不再依赖"truncated 布尔 + 自行数条目"。
    const docsTotal = filteredDocs.length;
    const docsReturned =
      categoryOverviews.reduce((sum, c) => sum + c.docs.length, 0) + uncategorized.length;

    return {
      spaceId: space.id,
      spaceName: space.name,
      ...(legendTokenEstimate !== undefined
        ? { spaceDescription: space.description, legendTokenEstimate }
        : {}),
      ...(routes !== undefined
        ? { routes, routesTokenEstimate, routesTruncated, routesTotal }
        : {}),
      ...(totalBrokenRoutes !== undefined ? { totalBrokenRoutes } : {}),
      categories: categoryOverviews,
      uncategorized,
      ...(hasCheckedDocs ? { totalBrokenLinks } : {}),
      totalTokenEstimate:
        (legendTokenEstimate !== undefined ? legendTokenEstimate : 0) +
        (routesTokenEstimate !== undefined ? routesTokenEstimate : 0) +
        totalTokenEstimate,
      truncated,
      docsTotal,
      docsReturned,
      ...(Object.keys(filters.appliedFilters).length > 0
        ? { appliedFilters: filters.appliedFilters }
        : {}),
      // 条目形状由 slim 参数决定且同一响应内一致（categories/uncategorized 同为 slim 或同为全字段），
      // 内部以联合类型装配避免双分支重复代码，此处收窄到联合返回类型
    } as DocSpaceOverview | DocSpaceOverviewSlim;
  }
}
