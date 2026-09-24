/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 空间级全量导出 / 回导 bundle（T6）+ **formatVersion 2 媒体打包**（P2 批 5）
 *
 * [代码职责]
 *   - 导出：space meta + categories + routes + docs 全文 + **media（附件字节）+ mediaOmitted**
 *   - 回导：六阶段有序落库（categories → media stage-1 → docs(含 URL 重写) →
 *     media stage-2 回绑 → routes → space meta）
 *   - 联合预算计算（10MiB − docs 段 − 64KiB 余量）、确定性排序、结果信封 media 段
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/api-definition.md §16 (doc_routes 段 + bundle formatVersion 2 的 media 契约)
 *
 * [关键不变量]
 *   - 格式版本：导出**恒写 2**；导入接受 {1,2}（1 → 整段跳过 media，结果信封 media 全零值形状）
 *   - 阶段顺序：media stage-1 必须早于 docs（正文重写要用旧 id → 新行 id 映射）；
 *     media stage-2 必须晚于 docs（要目标 docId）且早于 routes（现状顺序不动）
 *   - 幂等：同 bundle 二导必须"附件数/对象数不变 + docs unchanged"（复用键与 tie-break 见
 *     AttachmentService.findReusableBundleRow）
 *   - 无映射不重写：正文里没有映射的附件 URL 原样保留（断链可见优于错链）
 *   - docspace 不得 import AttachmentStorageService：媒体读写一律走 AttachmentService 门面
 *
 * [关联代码]
 *   - attachment.service.ts — 媒体门面（listByDocIds/listByIds/readObjectBytes/importFromBundle/bindBundleMedia）
 *   - doc-bundle-url.ts — 正文附件 URL 两形态识别与重写（相对 + 同源绝对；纯函数）
 *   - doc-bundle.constants.ts — 预算/上限常量单一事实源（DTO 与两侧复检同源）
 *   - import-doc-bundle.dto.ts — bundle 形状契约（forbidNonWhitelisted：新增导出字段必须声明）
 *
 * [持久踩坑]
 *   - BUNDLE-BUDGET(10mb): 媒体额度不是固定值——单文件 8MiB 图 base64 后 10.67MB 直接超
 *     express/nginx 双 10mb。安全方向：媒体额度 = 10MiB − docs 段实际字节 − 64KiB 余量，
 *     且按 DB 列"读对象前"预判（§⑤.3）。
 *   - BUNDLE-MEDIA-IDEMPOTENT: 导入侧的复用判定必须带 `status='ready'` + 确定性 tie-break
 *     (createdAt,id) + 本轮未配对语义，否则重导会双插行或配错行（§0 dx B1/arch M3/PM B1）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 新增导出字段/段必须同时在 import-doc-bundle.dto.ts 声明（否则 roundtrip 400）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { createHash } from 'crypto';
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
import { CODE_ENTRY_TYPE } from './doc-constants';
import { UnifiedActor } from '../../common/types/actor.types';
import { DOC_BUNDLE_FORMAT_VERSION, ImportDocBundleDto } from './dto';
import type { BundleRouteItemDto, CreateDocRouteDto } from './dto';
// review-0831 任务 bbd175dc 子项 2：批量 per-item 错误提取唯一实现（本文件 errorOf
// 已收敛至 doc-error.helper，与 doc.service.batchUpsert 共用同一 { message, code } 契约）
import { errorOf } from './doc-error.helper';
import { AttachmentService } from '../attachments/attachment.service';
// 跨模块形状用 import type（编译期擦除，不给运行时模块图再加一条边——双向 forwardRef 已够）
import type {
  BundleMediaBindEntry,
  BundleMediaImportItem,
  BundleMediaImportResult,
} from '../attachments/attachment-bundle.types';
import {
  DOC_BUNDLE_ACCEPTED_FORMAT_VERSIONS,
  DOC_BUNDLE_ENVELOPE_MARGIN_BYTES,
  DOC_BUNDLE_MAX_BYTES,
  DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES,
  DOC_BUNDLE_MEDIA_MAX_ITEMS,
  base64EncodedLength,
} from './doc-bundle.constants';
import { extractAttachmentContentIds, rewriteAttachmentContentUrls } from './doc-bundle-url';

// ─── Bundle 形状（formatVersion 2，任务 T6 + P2 批 5）─────────────────
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
//
// v2 新增 media 段（附件字节）+ mediaOmitted 段（刻意未打包的断链说明）：
// 文档里的插图是"内容的一部分"，只带 markdown 会得到一篇到处是断图的目标文档。

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

/** 空间级全量导出 bundle（formatVersion 2） */
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
  /**
   * 媒体段（formatVersion 2）：doc 绑定附件的原始字节 + 缩略图，按联合预算填充；
   * 超额项以 `{skipped}` 形态同段出现（可发现优于静默截断）。
   * 确定性排序：docPath → originalName → attachmentId。
   */
  media: DocBundleMediaEntry[];
  /**
   * informational：正文引用了但**刻意未打包**的附件（当前唯一原因 = topic 绑定）。
   * 用途：让"回导后这段断链"可被发现（PM Q4/m4）。
   */
  mediaOmitted: DocBundleMediaOmittedItem[];
}

/** bundle.media[] 的缩略图载荷（导出形状；字段与 DTO 同名同义） */
export interface DocBundleMediaThumbnailItem {
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  contentBase64: string;
}

/** bundle.media[] 的完整媒体项（导出形状） */
export interface DocBundleMediaItem {
  /** URL 重写配对键：导出侧恒等于正文 URL 中的旧附件 id */
  sourceAttachmentId: string;
  /** 该项归属的 doc path（阶段 ④ 回绑的目标） */
  docPath: string;
  originalName: string;
  mimeType: string;
  /** decoded 字节数（= contentBase64 解出的长度） */
  sizeBytes: number;
  /** decoded 字节的 SHA-256（lowercase hex） */
  sha256: string;
  /** 标准 padded base64 */
  contentBase64: string;
  /** 该行有缩略图时才有（缩略图是增强：读失败则不带，不影响原图打包） */
  thumbnail?: DocBundleMediaThumbnailItem;
}

/** bundle.media[] 的 skipped 标记（导出侧因单项上限/预算未打包） */
export interface DocBundleMediaSkippedItem {
  skipped: 'too_large' | 'budget_exceeded';
  sourceAttachmentId: string;
  docPath: string;
  originalName: string;
  /** 原始字节数（未打包项也有元数据，便于消费方判断"要不要单独取"） */
  sizeBytes: number;
}

export type DocBundleMediaEntry = DocBundleMediaItem | DocBundleMediaSkippedItem;

/** bundle.mediaOmitted[] 条目（informational） */
export interface DocBundleMediaOmittedItem {
  docPath: string;
  attachmentId: string;
  reason: 'topic_bound';
}

/** 回导 per-item 结果（categories/routes 段通用） */
interface BundleItemResult {
  status: 'created' | 'updated' | 'failed';
  error?: { message: string; code?: number };
  id?: string;
}

/**
 * v1 bundle / 无媒体包的 media 段 = **全零值形状**（plan §⑤.1：v1 跳过 media）。
 * 工厂函数而非共享常量：结果对象会被调用方读取，共享可变数组是隐患。
 */
function emptyMediaSection(): DocBundleMediaImportSection {
  return { created: 0, reused: 0, skipped: 0, failed: [] };
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

/**
 * 回导结果：media 段（formatVersion 2 才有内容；v1 包恒全零值形状）。
 *
 * - created/reused：阶段 ② 落库计数（reused = 命中复用键、未产生新行/新对象）；
 * - skipped：bundle 里导出侧已标记跳过的项（无字节，不落行）；
 * - failed：按项失败（字节证据不符/哈希不符/docPath 不在 docs[]/配额越界/回绑失败）
 *   ——**失败项 = 断链可见**：正文里该附件 URL 无映射保持旧值，重导可续绑。
 */
export interface DocBundleMediaImportSection {
  created: number;
  reused: number;
  skipped: number;
  failed: Array<{ docPath: string; originalName: string | null; reason: string }>;
}

/** 回导结果：完整信封 */
export interface DocSpaceImportBundleResult {
  formatVersion: number;
  importedAt: string;
  docs: BatchUpsertDocsResult;
  categories: DocBundleCategoryImportSection;
  routes: DocBundleRouteImportSection;
  media: DocBundleMediaImportSection;
  spaceMeta: DocBundleSpaceMetaResult;
}

/**
 * DocSpace 空间级全量导出 / 回导编排 Service（任务 T6；媒体段见 P2 批 5）。
 *
 * 职责：
 * - exportBundle：组装 formatVersion=2 bundle（空间元数据 + categories + routes +
 *   docs 全文 + media 字节 + mediaOmitted 说明）
 * - importBundle：吃 bundle 回导，**六阶段有序执行**——
 *   ① categories → ② media stage-1（字节证据校验 + insert-or-reuse，产出旧 id→新行 id 映射）
 *   → ③ docs（upsert 前按映射内联重写正文附件 URL）
 *   → ④ media stage-2（回绑 docId=新 doc id）→ ⑤ routes → ⑥ space meta。
 *   阶段顺序的理由：
 *   ① categories 先于 docs（doc upsert 的 category 按名解析，先建好分类避免 auto-create 漂移）；
 *   ② media 早于 docs（正文重写需要映射）+ 晚于 categories（与 docs 同批语义）；
 *   ③ docs 复用 DocService.batchUpsert 的 per-doc 独立事务语义；
 *   ④ media 回绑必须晚于 docs（要新 docId）；
 *   ⑤ routes 必须最后（写时校验需要 target doc 的 sections 已就位——headingPath 精确命中）；
 *   ⑥ space meta 默认**不回写**（防覆盖目标空间策展），仅 overwriteSpaceMeta=true 显式开启。
 *
 * 幂等语义（业务键）：
 * - categories：按 name（空间内非软删精确匹配；重复 name → per-item failed）
 * - routes：按 (intent, primaryDocPath 解析出的 primaryDocId)；已存在 → 更新，不存在 → 创建
 * - docs：按 (spaceId, path) upsert（contentHash 相同 → unchanged）
 * - media：按 (importer, sha256, 绑定态, status='ready') 复用键 + 本轮未配对 + tie-break
 *   （实现与理由见 AttachmentService.findReusableBundleRow）——同 bundle 二导：
 *   附件行数/对象数不变、正文重写结果逐字节相同（附件 id 稳定）→ docs unchanged 收敛
 * 重复导入同一 bundle = 全量幂等（不产生新行、不重复创建、不重复落对象）。
 *
 * 权限在 Controller 层完成（export=read / import=write，铁律 #21 双层校验的权限边界）。
 */
@Injectable()
export class DocBundleService {
  private readonly logger = new Logger(DocBundleService.name);

  constructor(
    private readonly docspaceService: DocSpaceService,
    private readonly docService: DocService,
    private readonly docRouteService: DocRouteService,
    // bundle 媒体门面（P2 批 5）：本模块**不接触 storage/嗅探/配额锁**，
    // 只消费 attachments 模块的公开门面（plan §⑤.5 模块边界钉死）
    private readonly attachmentService: AttachmentService,
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
   * 导出空间全量 bundle（formatVersion 2）。
   *
   * 输出确定性（git diff 友好）：categories 按 sortOrder+createdAt ASC、
   * routes 按 sortOrder+createdAt ASC（与 GET /doc-spaces/:id/routes 同序）、
   * docs 按 path ASC、media 按 docPath→originalName→attachmentId ASC。
   *
   * ⚠️ 大空间响应体积大是正常的：docs 段含每篇完整原文（reconstructContent full=true
   * 语义，含首标题行——与 web 编辑器回写保真口径一致），最重租户量级可达数 MB；
   * 单次导出不受分页/截断限制，快照完整性是本端点第一优先级。
   * media 段则**受联合预算约束**（请求体上限是 10MiB，超了整包 413）——超额项落
   * `{skipped}` 标记，消费方据此另行取件（见 doc-bundle.constants.ts 预算口径）。
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

    // ── media 段（联合预算口径见 doc-bundle.constants.ts）──
    // 先装 docs 段测字节，再按剩余额度逐项填充（plan §⑤.3 导出内存策略：
    // DB 列预判 → 仅入选项顺序读对象）
    const docsSectionBytes = Buffer.byteLength(JSON.stringify(docItems), 'utf8');
    const media = await this.collectBundleMedia(docItems, docsSectionBytes);

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
      media: media.items,
      mediaOmitted: media.omitted,
    };
  }

  /**
   * 收集 bundle 媒体段（plan §⑤.1/§⑤.3）。
   *
   * 候选来源 = **doc 绑定附件**（`listByDocIds`，与空间读权限同面）：topic 绑定附件
   * 不在该权限面内、跨环境 topic id 也不通用 → 不打包，改由 mediaOmitted 报出。
   * 正文扫描（`extractAttachmentContentIds`）只用于 mediaOmitted 的反查，
   * 以及"哪些附件确实被正文引用"这一信息的可发现性。
   *
   * 预算填充顺序 = 确定性排序后的逐项判定：
   * ① 单项原始字节 > 6MiB → `skipped:'too_large'`；
   * ② 按 DB 列预判的编码体积超剩余额度 → `skipped:'budget_exceeded'`；
   * ③ 否则读对象字节（只有入选项才读），复核实际字节与行元数据自洽（长度 + sha256）
   *    后再按**实际**编码体积扣额度（DB 列可能陈旧，额度必须按事实算）。
   *
   * 读失败/自洽不符的项**不入 media**（记 error 日志）：bundle 必须自洽——
   * 带进去只会让导入侧 per-item failed，白白吃掉额度（断链与不打包在目标空间的
   * 表现相同：正文 URL 无映射 → "无映射不重写"）。
   */
  private async collectBundleMedia(
    docItems: DocBundleDocItem[],
    docsSectionBytes: number,
  ): Promise<{ items: DocBundleMediaEntry[]; omitted: DocBundleMediaOmittedItem[] }> {
    const pathByDocId = new Map(docItems.map((d) => [d.docId, d.path]));

    // ── mediaOmitted：正文引用的 topic 绑定附件（informational）──
    const omitted: DocBundleMediaOmittedItem[] = [];
    const refsByDocPath = new Map<string, string[]>();
    const referencedIds = new Set<string>();
    for (const doc of docItems) {
      const ids = extractAttachmentContentIds(doc.content);
      if (ids.length === 0) continue;
      refsByDocPath.set(doc.path, ids);
      for (const id of ids) referencedIds.add(id);
    }
    if (referencedIds.size > 0) {
      const refRows = await this.attachmentService.listByIds([...referencedIds]);
      const rowById = new Map(refRows.map((row) => [row.id, row]));
      // 按 docPath 序输出（docItems 已是 path ASC），保证清单确定性
      for (const doc of docItems) {
        for (const id of refsByDocPath.get(doc.path) ?? []) {
          const row = rowById.get(id);
          if (row && row.topicId !== null) {
            omitted.push({ docPath: doc.path, attachmentId: id, reason: 'topic_bound' });
          }
        }
      }
    }

    // ── 打包候选：doc 绑定行，确定性排序 docPath → originalName → attachmentId ──
    const boundRows = await this.attachmentService.listByDocIds(docItems.map((d) => d.docId));
    const candidates = boundRows
      // 双绑定在应用层不该出现；一旦出现按 topic 优先处理（绝不把 topic 资产打进空间包）
      .filter((row) => row.topicId === null && row.docId !== null)
      .map((row) => ({ row, docPath: pathByDocId.get(row.docId as string) ?? '' }))
      .filter((c) => c.docPath !== '')
      .sort(
        (a, b) =>
          a.docPath.localeCompare(b.docPath) ||
          a.row.originalName.localeCompare(b.row.originalName) ||
          a.row.id.localeCompare(b.row.id),
      );

    // ── 按剩余额度逐项填充 ──
    let remainingBytes = DOC_BUNDLE_MAX_BYTES - docsSectionBytes - DOC_BUNDLE_ENVELOPE_MARGIN_BYTES;
    const items: DocBundleMediaEntry[] = [];

    for (const candidate of candidates) {
      const { row } = candidate;
      const declaredSize = Number(row.sizeBytes);
      const meta = {
        sourceAttachmentId: row.id,
        docPath: candidate.docPath,
        originalName: row.originalName,
        sizeBytes: declaredSize,
      };

      if (declaredSize > DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES) {
        items.push({ skipped: 'too_large', ...meta });
        continue;
      }
      // 条目数闸门与字节额度同族：超出条目数上限的项按"额度耗尽"报出（理由可解释）
      if (items.length >= DOC_BUNDLE_MEDIA_MAX_ITEMS) {
        items.push({ skipped: 'budget_exceeded', ...meta });
        continue;
      }
      const declaredThumbBytes =
        row.thumbKey && row.thumbSizeBytes !== null ? Number(row.thumbSizeBytes) : 0;
      const predictedBytes =
        base64EncodedLength(declaredSize) + base64EncodedLength(declaredThumbBytes);
      if (predictedBytes > remainingBytes) {
        items.push({ skipped: 'budget_exceeded', ...meta });
        continue;
      }

      // ── 只有入选项才读对象 ──
      let data: Buffer;
      try {
        data = await this.attachmentService.readObjectBytes(row.objectKey);
      } catch (err) {
        this.logger.error(
          `Bundle export: object read failed, media item omitted ` +
            `(attachmentId=${row.id}, docPath=${candidate.docPath}): ${(err as Error).message}`,
        );
        continue;
      }
      // 自洽复核：对象字节必须与行元数据一致（长度 + sha256），否则包内自相矛盾
      if (
        data.length !== declaredSize ||
        createHash('sha256').update(data).digest('hex') !== row.sha256
      ) {
        this.logger.error(
          `Bundle export: object bytes do not match row metadata, media item omitted ` +
            `(attachmentId=${row.id}, docPath=${candidate.docPath})`,
        );
        continue;
      }

      // 缩略图是增强：任一环节不合规就只丢缩略图，原图照常打包
      let thumbnail: DocBundleMediaThumbnailItem | null = null;
      if (row.thumbKey && row.thumbWidth !== null && row.thumbHeight !== null) {
        try {
          const thumbData = await this.attachmentService.readObjectBytes(row.thumbKey);
          if (
            thumbData.length === declaredThumbBytes &&
            row.thumbSha256 !== null &&
            createHash('sha256').update(thumbData).digest('hex') === row.thumbSha256
          ) {
            thumbnail = {
              width: row.thumbWidth,
              height: row.thumbHeight,
              sizeBytes: thumbData.length,
              sha256: row.thumbSha256,
              contentBase64: thumbData.toString('base64'),
            };
          } else {
            this.logger.warn(
              `Bundle export: thumbnail bytes do not match row metadata, packing original only ` +
                `(attachmentId=${row.id})`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `Bundle export: thumbnail read failed, packing original only ` +
              `(attachmentId=${row.id}): ${(err as Error).message}`,
          );
        }
      }

      const actualBytes =
        base64EncodedLength(data.length) +
        (thumbnail ? base64EncodedLength(thumbnail.sizeBytes) : 0);
      if (actualBytes > remainingBytes) {
        items.push({ skipped: 'budget_exceeded', ...meta });
        continue;
      }
      remainingBytes -= actualBytes;
      items.push({
        ...meta,
        mimeType: row.mimeType,
        // 入库值一律取实际事实（data.length / row.sha256 已复核为同一事实）
        sizeBytes: data.length,
        sha256: row.sha256,
        contentBase64: data.toString('base64'),
        ...(thumbnail ? { thumbnail } : {}),
      });
    }

    return { items, omitted };
  }

  /**
   * 回导 bundle 到目标空间（六阶段有序执行，见类注释）。
   *
   * @param spaceId 目标空间（Controller 层已判空 + write 权限检查）
   * @param bundle 导出端点产出的 bundle（formatVersion 1 或 2；DTO 层已做格式校验）
   * @param actor 操作者（docs 的 createdBy / audit / 事件；routes 的 createdBy；
   *              media 的 uploaderId + 配额归属）
   * @param overwriteSpaceMeta 是否回写空间元数据（默认 false——防覆盖目标空间策展）
   */
  async importBundle(
    spaceId: string,
    bundle: ImportDocBundleDto,
    actor: UnifiedActor,
    overwriteSpaceMeta = false,
  ): Promise<DocSpaceImportBundleResult> {
    // formatVersion 业务校验（铁律 #21 双层校验的业务层；DTO 层只保证它是整数）。
    // 1 = 存量快照格式（无 media），2 = 带媒体；其它值 = 形状与实现契约不一致 → 400
    if (
      !(DOC_BUNDLE_ACCEPTED_FORMAT_VERSIONS as readonly number[]).includes(bundle.formatVersion)
    ) {
      throw new BadRequestException({
        message:
          `Unsupported bundle formatVersion ${bundle.formatVersion}; ` +
          `this server accepts 1 (no media) and 2 (with media). ` +
          `Re-export from a compatible server version.`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    // 空间存在性（findById 内部判空，铁律 #22）
    const space = await this.docspaceService.findById(spaceId);

    const docs = bundle.docs ?? [];
    // 只有 v2 且确实带媒体项时才走媒体两阶段：无 media 段（含 v1 与"纯文档快照"）
    // 直接全零值形状，省掉导入侧那条"目标空间现有 doc"查询
    const hasMedia =
      bundle.formatVersion === DOC_BUNDLE_FORMAT_VERSION && (bundle.media ?? []).length > 0;

    // 阶段 ①：categories（按 name 幂等，先于 docs）
    const categorySection = await this.importCategories(spaceId, bundle.categories ?? [], actor);

    // 阶段 ②：media stage-1（字节证据校验 + insert-or-reuse；产出 旧 id → 新行 id 映射）
    const mediaStage1: BundleMediaImportResult = hasMedia
      ? await this.importBundleMediaStage1(spaceId, bundle, docs, actor)
      : { ...emptyMediaSection(), bindings: [] };

    // 阶段 ③：docs（复用 batchUpsert per-doc 独立事务——单篇失败不中止批次）
    // 正文在 upsert 前**内联重写**：正文里的旧附件 URL 换成新行 id 的 URL；
    // 无映射的 URL 原样保留（旧 URL 断链但可见，优于换成错链）
    const idMap = new Map(
      mediaStage1.bindings.map((b) => [b.sourceAttachmentId, b.attachmentId] as const),
    );
    const docsResult = await this.docService.batchUpsert(
      spaceId,
      docs.map((doc) => ({
        path: doc.path,
        content: rewriteAttachmentContentUrls(doc.content, idMap),
        title: doc.title,
        summary: doc.summary,
        docType: doc.docType,
        category: doc.category,
        tags: doc.tags,
      })),
      actor,
    );

    // 阶段 ④：media stage-2（回绑 docId=新 doc id；docs 失败项的行停在 docId NULL 态 → 可见）
    const media: DocBundleMediaImportSection = hasMedia
      ? await this.importBundleMediaStage2(mediaStage1, docsResult)
      : emptyMediaSection();

    // 阶段 ⑤：routes（业务键 intent+primaryDocPath；写时校验需要 docs 的 sections 已就位）
    const routeSection = await this.importRoutes(spaceId, bundle.routes ?? [], actor);
    // 阶段 ⑥：space meta（默认跳过；显式 overwriteSpaceMeta=true 才回写）
    const spaceMeta = overwriteSpaceMeta
      ? await this.overwriteSpaceMeta(space, bundle.space)
      : { applied: false, status: 'skipped' as const };

    return {
      // 回声被消费的版本：v1 包导入后消费方能在信封里看到"这是 1 的语义"（media 全零）
      formatVersion: bundle.formatVersion,
      importedAt: new Date().toISOString(),
      docs: docsResult,
      categories: categorySection,
      routes: routeSection,
      media,
      spaceMeta,
    };
  }

  // ─── 媒体段（阶段 ② / ④）─────────────────────────────────────

  /**
   * 阶段 ②：媒体落库（DTO → 门面入参 → AttachmentService.importFromBundle）。
   *
   * 预算口径与导出侧**对称**（plan §⑤.3 末句"import 侧对称防御复检"）：
   * `额度 = 10MiB − docs 段 JSON 字节 − 64KiB 余量`——手改包把几百 MiB 塞进 media
   * 时，这里逐项失败而不是把进程内存打爆（DTO 的 @MaxLength 已挡单字段超大值）。
   *
   * docIdByPath 取**目标空间当前**的解析结果（阶段 ③ 尚未执行）：首导时目标空间还没有
   * 这些 doc → 为空 → 复用候选只剩"未绑定行"；重导时 doc 已存在 → 命中上次导入绑定的行。
   */
  private async importBundleMediaStage1(
    spaceId: string,
    bundle: ImportDocBundleDto,
    docs: Array<{ path: string }>,
    actor: UnifiedActor,
  ): Promise<BundleMediaImportResult> {
    const docsSectionBytes = Buffer.byteLength(JSON.stringify(docs), 'utf8');
    const budgetBytes = Math.max(
      0,
      DOC_BUNDLE_MAX_BYTES - docsSectionBytes - DOC_BUNDLE_ENVELOPE_MARGIN_BYTES,
    );

    const existingDocs = await this.docRepo.find({
      where: { spaceId, deletedAt: IsNull() },
      select: ['id', 'path'],
    });

    const items: BundleMediaImportItem[] = (bundle.media ?? []).map((m) => ({
      sourceAttachmentId: m.sourceAttachmentId ?? null,
      docPath: m.docPath,
      originalName: m.originalName ?? null,
      mimeType: m.mimeType ?? null,
      sizeBytes: m.sizeBytes ?? null,
      sha256: m.sha256 ?? null,
      contentBase64: m.contentBase64 ?? null,
      thumbnail: m.thumbnail
        ? {
            width: m.thumbnail.width,
            height: m.thumbnail.height,
            sizeBytes: m.thumbnail.sizeBytes,
            sha256: m.thumbnail.sha256,
            contentBase64: m.thumbnail.contentBase64,
          }
        : null,
      skipped: m.skipped ?? null,
    }));

    return this.attachmentService.importFromBundle({
      items,
      importerId: actor.id,
      docPathSet: new Set(docs.map((d) => d.path)),
      docIdByPath: new Map(existingDocs.map((d) => [d.path, d.id] as const)),
      limits: {
        itemMaxBytes: DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES,
        budgetBytes,
      },
    });
  }

  /**
   * 阶段 ④：把已落库的媒体行回绑到 docs 阶段的产物。
   *
   * 三类收尾（plan §0 PM M4 部分失败中间态）：
   * - docs 阶段该篇 failed（无 id）→ 媒体项落 failed("doc upsert failed ...")，
   *   行保持 docId NULL：断链可见，重导可续绑；
   * - 行已绑同一 doc（重导复用）→ 门面 no-op，不产生 churn；
   * - 绑定抛错 → 该条 failed（照 categories/routes 的 per-item catch 先例）。
   */
  private async importBundleMediaStage2(
    stage1: BundleMediaImportResult,
    docsResult: BatchUpsertDocsResult,
  ): Promise<DocBundleMediaImportSection> {
    const docIdByPath = new Map<string, string>();
    for (const result of docsResult.results) {
      if (result.id) docIdByPath.set(result.path, result.id);
    }

    const bindEntries: BundleMediaBindEntry[] = [];
    const unboundFailures: DocBundleMediaImportSection['failed'] = [];
    for (const binding of stage1.bindings) {
      const docId = docIdByPath.get(binding.docPath);
      if (!docId) {
        unboundFailures.push({
          docPath: binding.docPath,
          originalName: binding.originalName,
          reason:
            'doc upsert failed for this docPath; media item left unbound — ' +
            're-import the bundle to complete the binding',
        });
        continue;
      }
      bindEntries.push({
        attachmentId: binding.attachmentId,
        docId,
        sourceAttachmentId: binding.sourceAttachmentId,
        docPath: binding.docPath,
        originalName: binding.originalName,
      });
    }

    const bindResult = bindEntries.length
      ? await this.attachmentService.bindBundleMedia(bindEntries)
      : { bound: 0, failures: [] };

    return {
      created: stage1.created,
      reused: stage1.reused,
      skipped: stage1.skipped,
      failed: [...stage1.failed, ...unboundFailures, ...bindResult.failures],
    };
  }

  // ─── 阶段实现 ────────────────────────────────────────────────

  /**
   * 分类回导（业务键 = name，空间内非软删精确匹配）：
   * 已存在 → updateCategory（复用平台 slug 自动去重语义：冲突 slug 自动加后缀）；
   * 不存在 → createCategory。单条 try/catch，失败不中止批次。
   *
   * @param actor 操作者（审计透传：createCategory/updateCategory 的 operatorActorId）
   */
  private async importCategories(
    spaceId: string,
    items: Array<{ name: string; slug?: string; description?: string | null; sortOrder?: number }>,
    actor: UnifiedActor,
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
          await this.docspaceService.updateCategory(existing[0].id, dto, actor.id);
          results.push({ name: item.name, status: 'updated', id: existing[0].id });
          summary.updated++;
        } else {
          const created = await this.docspaceService.createCategory(spaceId, dto, actor.id);
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
          codeEntryType: item.codeEntryType ?? CODE_ENTRY_TYPE.EXACT,
          sortOrder: item.sortOrder ?? 0,
        } as CreateDocRouteDto;

        if (existing.length === 1) {
          // update 全量 dto → refsChanged=true → 合并后整体重跑写时校验（防半校验漏洞，见 doc-route.service）
          await this.docRouteService.update(existing[0].id, dto, actor.id);
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
