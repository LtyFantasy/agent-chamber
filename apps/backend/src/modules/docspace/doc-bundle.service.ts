/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/api-definition.md §16 (DocSpace 模块, doc_routes 段) —— 任务 T6（空间级全量导出/回导）
 *   - 补充: v1.62.0（contentHash 读路径透传）：bundle docs[] item 增 docId + contentHash
 *     （原始写入 payload 的 SHA-256，revision 对照用——content 是重建产物，其 SHA-256
 *      ≠ contentHash，禁止对 content 自算 hash）；import DTO 显式忽略这两个字段防
 *     forbidNonWhitelisted roundtrip 400，formatVersion 保持 1
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #21(双层校验) #22(findOne必须判空) #17(测试契约) #11(注释强制) #25(类型前置)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  DocRouteCodeEntryType,
  ErrorCode,
  Visibility,
  type BatchUpsertDocsResult,
} from '@agent-chamber/shared';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { DocSpaceService } from './docspace.service';
import { DocService } from './doc.service';
import { DocRouteService } from './doc-route.service';
import { UnifiedActor } from '../../common/types/actor.types';
import { DOC_BUNDLE_FORMAT_VERSION, ImportDocBundleDto } from './dto';
import type { BundleRouteItemDto, CreateDocRouteDto } from './dto';

// ─── Bundle 形状（formatVersion 1，任务 T6）──────────────────────
//
// 导出/回导的交换格式：单 JSON bundle，**包含全部策展元数据**（不只 markdown）——
// doc_routes（intent/category/codeEntry/codeEntryType/headingPath）、category 结构、
// space 图例（description/settings）、每篇的 summary/docType/tags 都是库内资产，
// 只导出 md 等于丢光路由表和摘要（最重租户 agent-core 反馈：文档与代码解耦后丢失
// "v0.10.0 发版时文档长什么样"的版本对齐能力与离线兜底）。
//
// 可移植性设计：路由引用文档用 **path**（业务键）而非 UUID——UUID 是库内身份，
// 不跨空间可移植；path 在回导时解析回目标空间的 docId。health/sourceSha/tokenEstimate
// 等机器派生字段不导出（恢复后由 upsert 管线重新计算）。

/** bundle 顶层条目：路由（导出形状，文档以 path 引用） */
export interface DocBundleRouteItem {
  intent: string;
  category: string | null;
  /** 主文档路径；null = 导出时该路由指向的文档已不存在（软删）→ 回导该条 per-item failed */
  primaryDocPath: string | null;
  primaryHeadingPath: string | null;
  secondaryDocPath: string | null;
  secondaryHeadingPath: string | null;
  codeEntry: string | null;
  codeEntryType: DocRouteCodeEntryType;
  sortOrder: number;
}

/** bundle 顶层条目：分类 */
export interface DocBundleCategoryItem {
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
}

/** bundle 顶层条目：文档（content = 完整可回导原文） */
export interface DocBundleDocItem {
  /** 导出时文档 ID（库内身份，跨空间不可移植——仅供对照/排错，非业务键） */
  docId: string;
  path: string;
  title: string;
  summary: string | null;
  docType: string | null;
  tags: string[];
  /** 分类名（导出时由 categoryId 解析；分类已删 → null = 未分类） */
  category: string | null;
  /**
   * 完整原文（**sections 重建产物**，含首标题行，与 web 编辑器回写保真口径一致）——
   * 用途 = 可无损回导（roundtrip）。注意它不是原始写入 payload：
   * **禁止对 content 自算 SHA 作为 contentHash**——revision 对照一律以下方
   * contentHash 字段为准。
   */
  content: string;
  /**
   * 原始写入 payload 的 SHA-256（revision token，v1.62.0）。
   * content 是重建产物，其 SHA-256 ≠ 本值；考虑"导出→回导"的版本对照用途，
   * 以本字段为权威 revision 标识。docs.content_hash nullable → string | null。
   */
  contentHash: string | null;
}

/** 空间级全量导出 bundle（formatVersion 1） */
export interface DocSpaceExportBundle {
  formatVersion: typeof DOC_BUNDLE_FORMAT_VERSION;
  /** 导出时刻（ISO 8601）——快照语义：bundle 是导出瞬间的一致性视图 */
  exportedAt: string;
  space: {
    name: string;
    description: string | null;
    visibility: Visibility;
    /** 原始 settings jsonb（含 visibility/overviewFilter/repoManifest 等全部键） */
    settings: Record<string, unknown>;
  };
  categories: DocBundleCategoryItem[];
  routes: DocBundleRouteItem[];
  docs: DocBundleDocItem[];
}

/** 回导 per-item 结果（categories/routes 段通用） */
interface BundleItemResult {
  status: 'created' | 'updated' | 'failed';
  error?: { message: string; code?: number };
  id?: string;
}

/** 回导结果：categories 段 */
export interface DocBundleCategoryImportSection {
  results: (BundleItemResult & { name: string })[];
  summary: { total: number; created: number; updated: number; failed: number };
}

/** 回导结果：routes 段 */
export interface DocBundleRouteImportSection {
  results: (BundleItemResult & { intent: string; primaryDocPath: string | null })[];
  summary: { total: number; created: number; updated: number; failed: number };
}

/** 回导结果：space meta 段（默认跳过；overwriteSpaceMeta=true 才写） */
export interface DocBundleSpaceMetaResult {
  applied: boolean;
  status: 'updated' | 'skipped';
  error?: { message: string; code?: number };
}

/** 回导结果：完整信封 */
export interface DocSpaceImportBundleResult {
  formatVersion: number;
  importedAt: string;
  docs: BatchUpsertDocsResult;
  categories: DocBundleCategoryImportSection;
  routes: DocBundleRouteImportSection;
  spaceMeta: DocBundleSpaceMetaResult;
}

/**
 * 抽取 per-item 错误形状（与 batchUpsert 的 error 形状一致：
 * { message, code }——code 取 NestJS HttpException.response.code，无则省略）。
 */
function errorOf(err: unknown): { message: string; code?: number } {
  const httpErr = err as { response?: { message?: string; code?: number }; message?: string };
  return {
    message: httpErr.response?.message ?? httpErr.message ?? 'Unknown error',
    code: httpErr.response?.code,
  };
}

/**
 * DocSpace 空间级全量导出 / 回导编排 Service（任务 T6）。
 *
 * 职责：
 * - exportBundle：组装 formatVersion=1 bundle（空间元数据 + categories + routes + docs 全文）
 * - importBundle：吃 bundle 回导，**四阶段有序执行**——categories → docs → routes → space meta：
 *   ① categories 先于 docs（doc upsert 的 category 按名解析，先建好分类避免 auto-create 漂移）；
 *   ② docs 后于 categories（复用 DocService.batchUpsert 的 per-doc 独立事务语义）；
 *   ③ routes 必须最后（写时校验需要 target doc 的 sections 已就位——headingPath 精确命中）；
 *   ④ space meta 默认**不回写**（防覆盖目标空间策展），仅 overwriteSpaceMeta=true 显式开启。
 *
 * 幂等语义（业务键）：
 * - categories：按 name（空间内非软删精确匹配；重复 name → per-item failed）
 * - routes：按 (intent, primaryDocPath 解析出的 primaryDocId)；已存在 → 更新，不存在 → 创建
 * - docs：按 (spaceId, path) upsert（contentHash 相同 → unchanged）
 * 重复导入同一 bundle = 全量幂等（不产生新行、不重复创建）。
 *
 * 权限在 Controller 层完成（export=read / import=write，铁律 #21 双层校验的权限边界）。
 */
@Injectable()
export class DocBundleService {
  constructor(
    private readonly docspaceService: DocSpaceService,
    private readonly docService: DocService,
    private readonly docRouteService: DocRouteService,
    @InjectRepository(DocSpace)
    private readonly spaceRepo: Repository<DocSpace>,
    @InjectRepository(DocCategory)
    private readonly categoryRepo: Repository<DocCategory>,
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    @InjectRepository(DocRoute)
    private readonly routeRepo: Repository<DocRoute>,
  ) {}

  /**
   * 导出空间全量 bundle（formatVersion 1）。
   *
   * 输出确定性（git diff 友好）：categories 按 sortOrder+createdAt ASC、
   * routes 按 sortOrder+createdAt ASC（与 GET /doc-spaces/:id/routes 同序）、
   * docs 按 path ASC。
   *
   * ⚠️ 大空间响应体积大是正常的：docs 段含每篇完整原文（reconstructContent full=true
   * 语义，含首标题行——与 web 编辑器回写保真口径一致），最重租户量级可达数 MB；
   * 单次导出不受分页/截断限制，快照完整性是本端点第一优先级。
   *
   * @param spaceId 目标空间（Controller 层已判空 + read 权限检查）
   */
  async exportBundle(spaceId: string): Promise<DocSpaceExportBundle> {
    const space = await this.docspaceService.findById(spaceId);

    // ── categories（非软删，策展序）──
    const categories = await this.categoryRepo.find({
      where: { spaceId, deletedAt: IsNull() },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));

    // ── docs（非软删，path 序）+ 每篇完整原文 ──
    const docs = await this.docRepo.find({
      where: { spaceId, deletedAt: IsNull() },
      order: { path: 'ASC' },
    });
    const docItems: DocBundleDocItem[] = [];
    for (const doc of docs) {
      // getContent(full=true) = reconstructContent skipDuplicateTitle=false——
      // 完整还原原文（含首标题行），可无损回导；返回的 contentHash 与原始写入
      // payload 同源（revision token），**与重建正文的 SHA-256 不相等**——
      // content 用途 = roundtrip，contentHash 用途 = revision 对照（注释已写清）
      const full = await this.docService.getContent(doc.id, true);
      docItems.push({
        docId: doc.id,
        path: doc.path,
        title: doc.title,
        summary: doc.summary,
        docType: doc.docType,
        tags: doc.tags ?? [],
        // categoryId 指向已软删分类 → null（未分类；回导时不重建该分类，文档落 uncategorized）
        category: doc.categoryId ? (categoryNameById.get(doc.categoryId) ?? null) : null,
        content: full.content,
        contentHash: doc.contentHash,
      });
    }

    // ── routes（全部路由，含指向软删文档的孤儿路由）──
    const routes = await this.routeRepo.find({
      where: { spaceId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    const pathById = new Map(docs.map((d) => [d.id, d.path]));
    const routeItems: DocBundleRouteItem[] = routes.map((r) => ({
      intent: r.intent,
      category: r.category,
      // 孤儿路由（doc 软删后路由保留是 doc_routes 设计语义）：导出 null 保真，
      // 回导该条 per-item failed（目标空间同样无此 doc），不静默丢行
      primaryDocPath: pathById.get(r.primaryDocId) ?? null,
      primaryHeadingPath: r.primaryHeadingPath,
      secondaryDocPath: r.secondaryDocId ? (pathById.get(r.secondaryDocId) ?? null) : null,
      secondaryHeadingPath: r.secondaryHeadingPath,
      codeEntry: r.codeEntry,
      codeEntryType: r.codeEntryType,
      sortOrder: r.sortOrder,
    }));

    return {
      formatVersion: DOC_BUNDLE_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      space: {
        name: space.name,
        description: space.description,
        visibility: (space.settings?.visibility || Visibility.OPEN) as Visibility,
        settings: space.settings ?? {},
      },
      categories: categories.map((c) => ({
        name: c.name,
        slug: c.slug,
        description: c.description,
        sortOrder: c.sortOrder,
      })),
      routes: routeItems,
      docs: docItems,
    };
  }

  /**
   * 回导 bundle 到目标空间（四阶段有序执行，见类注释）。
   *
   * @param spaceId 目标空间（Controller 层已判空 + write 权限检查）
   * @param bundle 导出端点产出的 formatVersion=1 bundle（DTO 层已做格式校验）
   * @param actor 操作者（docs 的 createdBy / audit / 事件；routes 的 createdBy）
   * @param overwriteSpaceMeta 是否回写空间元数据（默认 false——防覆盖目标空间策展）
   */
  async importBundle(
    spaceId: string,
    bundle: ImportDocBundleDto,
    actor: UnifiedActor,
    overwriteSpaceMeta = false,
  ): Promise<DocSpaceImportBundleResult> {
    // formatVersion 业务校验（铁律 #21 双层校验的业务层；DTO 层只保证它是整数）。
    // 不匹配 = bundle 形状与实现契约不一致，属于请求格式错误 → 400 VALIDATION_ERROR
    if (bundle.formatVersion !== DOC_BUNDLE_FORMAT_VERSION) {
      throw new BadRequestException({
        message:
          `Unsupported bundle formatVersion ${bundle.formatVersion}; ` +
          `this endpoint accepts formatVersion=${DOC_BUNDLE_FORMAT_VERSION}`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    // 空间存在性（findById 内部判空，铁律 #22）
    const space = await this.docspaceService.findById(spaceId);

    // 阶段 ①：categories（按 name 幂等，先于 docs）
    const categorySection = await this.importCategories(spaceId, bundle.categories ?? []);
    // 阶段 ②：docs（复用 batchUpsert per-doc 独立事务——单篇失败不中止批次）
    const docsResult = await this.docService.batchUpsert(
      spaceId,
      (bundle.docs ?? []).map((doc) => ({
        path: doc.path,
        content: doc.content,
        title: doc.title,
        summary: doc.summary,
        docType: doc.docType,
        category: doc.category,
        tags: doc.tags,
      })),
      actor,
    );
    // 阶段 ③：routes（业务键 intent+primaryDocPath；写时校验需要 docs 的 sections 已就位）
    const routeSection = await this.importRoutes(spaceId, bundle.routes ?? [], actor);
    // 阶段 ④：space meta（默认跳过；显式 overwriteSpaceMeta=true 才回写）
    const spaceMeta = overwriteSpaceMeta
      ? await this.overwriteSpaceMeta(space, bundle.space)
      : { applied: false, status: 'skipped' as const };

    return {
      formatVersion: DOC_BUNDLE_FORMAT_VERSION,
      importedAt: new Date().toISOString(),
      docs: docsResult,
      categories: categorySection,
      routes: routeSection,
      spaceMeta,
    };
  }

  // ─── 阶段实现 ────────────────────────────────────────────────

  /**
   * 分类回导（业务键 = name，空间内非软删精确匹配）：
   * 已存在 → updateCategory（复用平台 slug 自动去重语义：冲突 slug 自动加后缀）；
   * 不存在 → createCategory。单条 try/catch，失败不中止批次。
   */
  private async importCategories(
    spaceId: string,
    items: Array<{ name: string; slug?: string; description?: string | null; sortOrder?: number }>,
  ): Promise<DocBundleCategoryImportSection> {
    const results: DocBundleCategoryImportSection['results'] = [];
    const summary = { total: items.length, created: 0, updated: 0, failed: 0 };

    for (const item of items) {
      try {
        const existing = await this.categoryRepo.find({
          where: { spaceId, name: item.name, deletedAt: IsNull() },
        });
        // 业务键歧义（库内无 name 唯一约束，理论上可重复）：不静默挑选，整条 failed
        if (existing.length > 1) {
          throw new Error(`Ambiguous category name '${item.name}' (${existing.length} matches)`);
        }
        // 类型说明：updateCategory/createCategory 的 dto 类型为可选 string，但 Service
        // 运行时语义是「字段出现即采用 + null = 清空」（update 用 `!== undefined` 判断）——
        // bundle 的显式 null 必须原样传递，故断言到参数形状（与 importRoutes 的 dto 同款处理）
        const dto = {
          name: item.name,
          slug: item.slug,
          description: item.description ?? null,
          sortOrder: item.sortOrder ?? 0,
        } as { name: string; slug?: string; description?: string; sortOrder?: number };
        if (existing.length === 1) {
          await this.docspaceService.updateCategory(existing[0].id, dto);
          results.push({ name: item.name, status: 'updated', id: existing[0].id });
          summary.updated++;
        } else {
          const created = await this.docspaceService.createCategory(spaceId, dto);
          results.push({ name: item.name, status: 'created', id: created.id });
          summary.created++;
        }
      } catch (err: unknown) {
        summary.failed++;
        results.push({ name: item.name, status: 'failed', error: errorOf(err) });
      }
    }

    return { results, summary };
  }

  /**
   * 路由回导（业务键 = intent + primaryDocPath 解析出的 primaryDocId）：
   * 已存在 → DocRouteService.update（全量 dto → 触发整体写时校验：doc 存在性/归属、
   * headingPath 精确命中、codeEntry 格式）；不存在 → DocRouteService.create。
   * 任一路由指向的 doc 无法解析（bundle 缺该 doc / 孤儿路由）→ 该条 per-item failed。
   */
  private async importRoutes(
    spaceId: string,
    items: BundleRouteItemDto[],
    actor: UnifiedActor,
  ): Promise<DocBundleRouteImportSection> {
    const results: DocBundleRouteImportSection['results'] = [];
    const summary = { total: items.length, created: 0, updated: 0, failed: 0 };

    // path → docId 解析表（docs 阶段已落库；仅非软删）
    const docs = await this.docRepo.find({
      where: { spaceId, deletedAt: IsNull() },
      select: ['id', 'path'],
    });
    const docIdByPath = new Map(docs.map((d) => [d.path, d.id]));

    for (const item of items) {
      try {
        // ① 主文档解析（必填；null = 导出时即为孤儿路由）
        if (!item.primaryDocPath) {
          throw new Error('primaryDocPath is null (route references a doc that no longer exists)');
        }
        const primaryDocId = docIdByPath.get(item.primaryDocPath);
        if (!primaryDocId) {
          throw new Error(
            `primaryDocPath '${item.primaryDocPath}' does not resolve to a doc in this space`,
          );
        }
        // ② 次文档解析（可空；非空但解析不到 = bundle 数据不完整，整条 failed 不静默丢弃引用）
        let secondaryDocId: string | null = null;
        if (item.secondaryDocPath) {
          secondaryDocId = docIdByPath.get(item.secondaryDocPath) ?? null;
          if (!secondaryDocId) {
            throw new Error(
              `secondaryDocPath '${item.secondaryDocPath}' does not resolve to a doc in this space`,
            );
          }
        }
        // ③ 业务键查重（spaceId + intent + primaryDocId；doc_routes 无唯一约束 → 歧义整条 failed）
        const existing = await this.routeRepo.find({
          where: { spaceId, intent: item.intent, primaryDocId },
        });
        if (existing.length > 1) {
          throw new Error(
            `Ambiguous route (intent '${item.intent}' + primaryDocPath '${item.primaryDocPath}'): ` +
              `${existing.length} matches`,
          );
        }

        // 类型说明：CreateDocRouteDto/UpdateDocRouteDto 的可选字段类型为
        // `string | undefined`，但 Service 运行时语义是「字段出现即采用 + null = 清空」
        // （update 用 `!== undefined` 判断，create 用 `?? null` 落库）——bundle 里
        // 显式 null 必须原样传递才能清空既有值，故此处以 CreateDocRouteDto 断言
        // （UpdateDocRouteDto = PartialType(CreateDocRouteDto)，同一值两处可传）。
        const dto = {
          intent: item.intent,
          category: item.category ?? null,
          primaryDocId,
          primaryHeadingPath: item.primaryHeadingPath ?? null,
          secondaryDocId,
          secondaryHeadingPath: item.secondaryHeadingPath ?? null,
          codeEntry: item.codeEntry ?? null,
          codeEntryType: item.codeEntryType ?? 'exact',
          sortOrder: item.sortOrder ?? 0,
        } as CreateDocRouteDto;

        if (existing.length === 1) {
          // update 全量 dto → refsChanged=true → 合并后整体重跑写时校验（防半校验漏洞，见 doc-route.service）
          await this.docRouteService.update(existing[0].id, dto);
          results.push({
            intent: item.intent,
            primaryDocPath: item.primaryDocPath,
            status: 'updated',
            id: existing[0].id,
          });
          summary.updated++;
        } else {
          const created = await this.docRouteService.create(spaceId, dto, actor);
          results.push({
            intent: item.intent,
            primaryDocPath: item.primaryDocPath,
            status: 'created',
            id: created.id,
          });
          summary.created++;
        }
      } catch (err: unknown) {
        summary.failed++;
        results.push({
          intent: item.intent,
          primaryDocPath: item.primaryDocPath ?? null,
          status: 'failed',
          error: errorOf(err),
        });
      }
    }

    return { results, summary };
  }

  /**
   * 空间元数据回写（仅 overwriteSpaceMeta=true 时调用）。
   *
   * 覆盖范围：name / description / settings（整对象替换——含 overviewFilter、repoManifest
   * 等全部键；显式语义 = "bundle 的策展覆盖目标空间的策展"）。
   * 保留范围：id / slug / topicId / boardId / creatorId / docCount（空间身份与绑定不随 bundle 迁移）。
   * visibility 取 bundle.space.visibility（缺省回退目标空间现值，防 bundle 缺键时误改可见性）。
   */
  private async overwriteSpaceMeta(
    space: DocSpace,
    meta: {
      name: string;
      description?: string | null;
      visibility?: Visibility;
      settings?: Record<string, unknown>;
    },
  ): Promise<DocBundleSpaceMetaResult> {
    space.name = meta.name;
    space.description = meta.description ?? null;
    const existingVisibility = (space.settings?.visibility || Visibility.OPEN) as Visibility;
    space.settings = {
      ...(meta.settings ?? {}),
      visibility: meta.visibility ?? existingVisibility,
    };
    await this.spaceRepo.save(space);
    return { applied: true, status: 'updated' };
  }
}
