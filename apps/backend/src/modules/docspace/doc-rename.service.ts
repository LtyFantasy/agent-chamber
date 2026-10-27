/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 存量元数据治理（v1.92.0-dev 3 期）：全空间 tag rename/merge 批量改写 +
 *     DocCategory merge（重指向 + 软引用修正 + 软删），含 dryRun 预演 / batchToken 并发
 *     仲裁 / 幂等重放 / 事务后 fail-open 汇总审计。
 *
 * [代码职责]
 *   - `renameTags(spaceId, dto, actor)`：`from[] → to` 批量替换 docs.tags（SQL 层
 *     `array_replace` + 去重），同事务把 alias 声明写入 `settings.canonicalTags`；
 *   - `mergeCategory(categoryId, dto, actor)`：docs.category_id 重指向 + `doc_routes.category`
 *     自由文本改写 + `settings.overviewFilter.excludeCategories` 修正 + source 软删；
 *   - 共享私有内核：受影响集计算 / batchToken / 事务后审计汇总行。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（POST /doc-spaces/:id/tags/rename、
 *     POST /doc-categories/:id/merge 契约：dryRun/execute 信封、409 DOC_BATCH_CONFLICT、
 *     幂等重放、审计载荷）
 *   - 补充: 线上 docs/spec.md（RenameDocTagsResult / MergeDocCategoryResult 类型）
 *
 * [关键不变量]
 *   - **锁序纪律（plan D5/A5）**：doc_spaces 行（FOR UPDATE）→ doc_categories 行 →
 *     docs 批量 UPDATE。反序加锁 = 并发 rename/merge 死锁（2 期连接饥饿教训同源）。
 *     ⚠️ 该约定**已覆盖 `DocSpaceService.removeCategory`**（评审 M2 前它先 bulk UPDATE docs
 *     再软删 category，与 merge 反序 ⇒ 同分类并发 merge/remove 有死锁窗；现已对齐为
 *     先 `FOR UPDATE` 锁 category 行再改 docs）。改任一处锁序前先读本节。
 *   - **事务内零外部 IO**：事务体只走同一个 `EntityManager`（单连接，池 max=10 纪律）；
 *     审计、trgm 候选、空间存在性检查等一律在事务**外**。
 *   - **不 bump `docs.updated_at`**（有意语义）：治理性 metadata 改写不该淹没
 *     `updatedAt_desc` 排序面。`QueryBuilder.update` 本就不触发 `@UpdateDateColumn`，
 *     本文件进一步走裸 `manager.query` 且不写 `updated_at` ⇒ 保持原值。
 *   - **batchToken 两处同源**：dryRun（事务外）与 execute（事务内 FOR UPDATE 后）调用
 *     **同一个** `computeTagBatchToken`；序列化确定（updatedAt → ISO、tags 排序、按 id 排序）
 *     ⇒ 同一状态恒得同一 token。
 *   - **dryRun 零副作用**：不写库、不写审计、不登记幂等记录（照 doc-move 先例）。
 *   - **alias 声明无条件生成**（plan D6/P1）：词表未声明不跳过，而是创建词表键——见
 *     `applyTagRenameToVocabulary` 的差异说明（ci 等价 from 值保留为存量 alias）。
 *   - **category 无 alias 机制**：merge 后旧 slug 查询即空，响应不承诺兼容。
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/doc-vocabulary.helper.ts — `normalizeTagRenameValues`
 *     （from 归一单源）/ `applyTagRenameToVocabulary`（词表变换纯函数）/ `parseCanonicalTags`
 *     （变换产物形状最后防线）
 *   - apps/backend/src/modules/docspace/doc-constants.ts — 两个幂等 entityType 标记
 *   - apps/backend/src/common/services/idempotency.helper.ts — 幂等三件套（build/replay/insert）
 *   - apps/backend/src/modules/docspace/doc.controller.ts — tags/rename 与 orphans 路由
 *   - apps/backend/src/modules/docspace/doc-category.controller.ts — merge 路由
 *   - apps/backend/src/database/migrations/1791600000000-AddAuditRenameMergeDocActions.ts —
 *     两个新 AuditAction 的 PG 枚举补值（缺值 → 审计写入 500）
 *   - test/docspace-governance.e2e-spec.ts — 真 PG 全矩阵（rename/merge/orphan/读侧 alias）
 *
 * [持久踩坑]
 *   - GOVERNANCE-LOCK-ORDER(反序加锁): 并发 rename 与 merge 若一个先锁 docs 再锁 space、
 *     另一个反之，即死锁。安全方向：本文件所有写路径**恒**按 space → categories → docs 取锁。
 *   - GOVERNANCE-TOKEN-ORDER(batchToken 序列化漂移): 两处调用若序列化口径不同（如 tags
 *     未排序、updatedAt 未 ISO 化），同一状态会算出不同 token ⇒ 正常执行被误判 409。
 *     安全方向：只经 `computeTagBatchToken` 一处计算，禁各自拼 JSON。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { AuditAction, ErrorCode } from '@agent-chamber/shared';
import type {
  DocGovernanceIngestRef,
  MergeDocCategoryResult,
  RenameDocTagsResult,
  RenameDocTagsVocabularyChange,
} from '@agent-chamber/shared';
import { Doc } from '../../database/entities/doc.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { AuditService } from '../audit/audit.service';
import { DocSpaceService } from './docspace.service';
import {
  applyTagRenameToVocabulary,
  normalizeTagRenameValues,
  parseCanonicalTags,
} from './doc-vocabulary.helper';
import {
  DOC_CATEGORY_MERGE_IDEMPOTENCY_ENTITY_TYPE,
  DOC_SOURCE_NATIVE,
  DOC_TAG_RENAME_IDEMPOTENCY_ENTITY_TYPE,
} from './doc-constants';
import {
  buildIdempotencyContext,
  insertIdempotencyInTx,
  tryIdempotentReplay,
} from '../../common/services/idempotency.helper';
import type { RenameDocTagsDto, MergeDocCategoryDto } from './dto';
import { UnifiedActor } from '../../common/types/actor.types';

/** dryRun 受影响清单样本上限（plan D4 明列 ≤50） */
const AFFECTED_SAMPLE_LIMIT = 50;

/** trgm 近义候选的相似度阈值（similarity() 显式比较，不依赖会话级 GUC） */
const SIMILAR_TAG_SIMILARITY_THRESHOLD = 0.4;

/** trgm 近义候选返回上限 */
const SIMILAR_TAG_LIMIT = 10;

/** tag rename 受影响文档行（受影响集计算 / batchToken / 审计载荷共用形状） */
interface TagAffectedRow {
  id: string;
  path: string;
  tags: string[];
  updatedAt: Date;
  source: string;
}

/** category merge 受影响文档行 */
interface CategoryAffectedRow {
  id: string;
  path: string;
  categoryId: string | null;
  updatedAt: Date;
  source: string;
}

/** 词表变换结果的响应投影（dryRun 的 vocabularyPlan 与 execute 的 vocabulary 同形） */
function toVocabularyChange(outcome: {
  created: boolean;
  addedAliases: string[];
  removedCanonicals: string[];
  movedAliases: Array<{ alias: string; fromCanonical: string; toCanonical: string }>;
  truncatedAliases: string[];
}): RenameDocTagsVocabularyChange {
  return {
    created: outcome.created,
    addedAliases: outcome.addedAliases,
    removedCanonicals: outcome.removedCanonicals,
    movedAliases: outcome.movedAliases,
    // 空则不落键（对齐仓内「空集合不出现」惯例）；非空时透明回报被裁别名（minor-1）
    ...(outcome.truncatedAliases.length > 0 ? { truncatedAliases: outcome.truncatedAliases } : {}),
  };
}

/**
 * DocSpace 存量治理写服务（tag rename/merge + category merge）。
 *
 * 定位：**存量**元数据的批量改写通道（与 doc.service 的逐文档写路径正交）——不改正文、
 * 不改 docId、不 bump updated_at、不发事件、不 reindex（tags/category 不进搜索向量，
 * 见 plan F7/D11）。
 */
@Injectable()
export class DocRenameService {
  /** NestJS 内置 Logger（fail-open 审计失败只记日志，对齐仓内惯例） */
  private readonly logger = new Logger(DocRenameService.name);

  constructor(
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    @InjectRepository(DocCategory)
    private readonly categoryRepo: Repository<DocCategory>,
    @InjectRepository(IdempotencyRecord)
    private readonly idempotencyRepo: Repository<IdempotencyRecord>,
    private readonly docSpaceService: DocSpaceService,
    private readonly auditService: AuditService,
  ) {}

  // ─── tag rename/merge ────────────────────────────────────────────────────

  /**
   * 存量 tag rename/merge（POST /doc-spaces/:id/tags/rename）。
   *
   * fail-closed 顺序：404 空间不存在 → 422 `to` 为空 / from 归一后为空（全部**字节等价**
   * 于 to，无可替换值）→ 幂等重放 → dryRun 早退（零副作用）→ 事务{锁 space 行 → 事务内
   * 重算受影响集 + token 比对 → 逐值 array_replace → 去重 → 词表变换 + save → 幂等 insert}
   * → 事务后 fail-open 审计（重放出口不写）。
   *
   * @param spaceId 目标空间 ID
   * @param dto { from, to, dryRun?, expectedBatchToken?, idempotencyKey? }
   * @param actor 操作者（审计需要；未认证写不落 audit，对齐既有 doc 写通道）
   * @returns RenameDocTagsResult（dryRun 与 execute 同形状，dryRun 字段区分）
   */
  async renameTags(
    spaceId: string,
    dto: RenameDocTagsDto,
    actor?: UnifiedActor,
  ): Promise<RenameDocTagsResult> {
    const toValue = dto.to.trim();
    // 422：`to` trim 后为空（双层校验铁律 #21 层 2——DTO 已拦格式，这里防 Service 直调。
    // 放行会让 array_replace 把旧 tag 写成空串（静默脏数据）或撞 docs.tags 约束 500）
    if (toValue === '') {
      throw new UnprocessableEntityException({
        message: "'to' must be a non-empty tag value (trimmed); nothing to rename into",
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    // from 归一单源（trim / 去空 / 剔除字节全等 to 的自映射 / 字节精确去重）
    const fromValues = normalizeTagRenameValues(dto.from, toValue);

    // 422：归一后无可替换值（from 全为空 / 全部字节等价于 to）——无意义请求 fail-fast
    if (fromValues.length === 0) {
      throw new UnprocessableEntityException({
        message:
          `All values in 'from' are equal to 'to' (or empty); ` + `there is nothing to rename`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    // 幂等包裹（最外层）：无键零开销旁路；有键先查重放——命中直接返回首次快照。
    // requestHash 只含写语义字段（dryRun 是预演，不参与指纹；照 doc-move 先例）
    const ctx = buildIdempotencyContext(
      DOC_TAG_RENAME_IDEMPOTENCY_ENTITY_TYPE,
      actor,
      dto.idempotencyKey,
      { spaceId, from: fromValues, to: toValue },
    );
    if (ctx) {
      const replay = await tryIdempotentReplay<RenameDocTagsResult>(this.idempotencyRepo, ctx);
      if (replay) return { ...replay, idempotentReplay: true };
    }

    // 404：空间不存在/已软删（findById fail-closed，铁律 #22）
    const space = await this.docSpaceService.findById(spaceId);

    // 事务外读：受影响集 + token（与 execute 内同一纯函数计算，口径一致）
    const beforeRows = await this.loadTagAffected(this.docRepo.manager, spaceId, fromValues);
    const batchToken = this.computeTagBatchToken(beforeRows);
    const ingestAffected: DocGovernanceIngestRef[] = beforeRows
      .filter((row) => row.source !== DOC_SOURCE_NATIVE)
      .map((row) => ({ docId: row.id, path: row.path }));

    // dryRun 早退：完整预演视图，**不写库 / 不写审计 / 不登记幂等**（plan D4）
    if (dto.dryRun) {
      const vocabularyPlan = applyTagRenameToVocabulary(
        parseCanonicalTags(((space.settings ?? {}) as Record<string, unknown>).canonicalTags),
        fromValues,
        toValue,
      );
      return {
        dryRun: true,
        batchToken,
        affectedDocs: {
          total: beforeRows.length,
          sample: beforeRows.slice(0, AFFECTED_SAMPLE_LIMIT).map((row) => ({
            docId: row.id,
            path: row.path,
            currentTags: row.tags,
          })),
          truncated: beforeRows.length > AFFECTED_SAMPLE_LIMIT,
        },
        perValue: await this.countTagValues(spaceId, fromValues),
        similarNotAffected: await this.findSimilarTagValues(spaceId, fromValues),
        vocabularyPlan: toVocabularyChange(vocabularyPlan),
        ingestAffected,
      };
    }

    // ── 事务：锁序 space 行 → （无 categories）→ docs 批量 UPDATE ────────────
    // 事务返回值 = { result, affectedIds, preImages }：affectedIds / preImages 取自
    // **事务内锁后重读**的行——审计的可恢复性载荷与响应计数因此恒与真实改写集一致
    // （未传 expectedBatchToken 的盲执行下，事务外快照可能已过期）
    const txOutcome = await (async (): Promise<{
      result: RenameDocTagsResult;
      affectedIds: string[];
      preImages: Array<{ id: string; tags: string[] }>;
      /** true = 并发撞键后走重放快照——**不写审计**（对齐顶层 replay 语义，评审 M4） */
      replay: boolean;
    }> => {
      try {
        const tx = await this.docRepo.manager.transaction(async (manager) => {
          // ① 锁 doc_spaces 行（并发 rename/merge 串行化；settings 在此刻重读，防丢失更新）
          const lockedSpace = await this.lockSpaceRow(manager, spaceId);

          // ② 事务内重算受影响集 + token（TOCTOU：事务外计算与写入之间有并发窗口）
          const rows = await this.loadTagAffected(manager, spaceId, fromValues);
          const currentToken = this.computeTagBatchToken(rows);
          if (dto.expectedBatchToken !== undefined && dto.expectedBatchToken !== currentToken) {
            // abort-all 零副作用（事务回滚）。⚠️ batchToken 是单向 hash ⇒ 服务端无法反推
            // 调用方 dryRun 快照做 added/removed 差集，故回传**当前受影响 docId 全集**
            // 供调用方与手中 dryRun 结果自行比对（见 message）。
            throw new ConflictException({
              message:
                `expectedBatchToken mismatch: the affected document set changed since your dryRun ` +
                `(a concurrent write modified tags or updatedAt). Nothing was written (abort-all). ` +
                `batchToken is a one-way hash, so the server cannot reconstruct your dryRun snapshot ` +
                `to diff it — data.diff.currentAffectedDocIds is the CURRENT affected set; compare it ` +
                `with your dryRun result, then re-run dryRun for a fresh token.`,
              code: ErrorCode.DOC_BATCH_CONFLICT,
              data: { diff: { currentAffectedDocIds: rows.map((row) => row.id) } },
            });
          }

          // ③ 逐 distinct from 值 array_replace（参数化；**不写 updated_at**——有意语义，
          //    治理性 metadata 改写不该淹没 updatedAt_desc 排序面）
          for (const fromValue of fromValues) {
            await manager.query(
              `UPDATE docs SET tags = array_replace(tags, $1::text, $2::text)
                WHERE space_id = $3 AND deleted_at IS NULL AND $1::text = ANY(tags)`,
              [fromValue, toValue, spaceId],
            );
          }

          // ④ 去重 UPDATE（防 from 多值命中同文档产生重复 to）。⚠️ `ARRAY(SELECT DISTINCT
          //    unnest(tags))` **不保序**——tags 是集合语义，可接受（plan D5 明记）。
          const ids = rows.map((row) => row.id);
          const preImages = rows.map((row) => ({ id: row.id, tags: row.tags }));
          const ingestRefs: DocGovernanceIngestRef[] = rows
            .filter((row) => row.source !== DOC_SOURCE_NATIVE)
            .map((row) => ({ docId: row.id, path: row.path }));
          if (ids.length > 0) {
            await manager.query(
              `UPDATE docs SET tags = ARRAY(SELECT DISTINCT unnest(tags))
                WHERE space_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
              [spaceId, ids],
            );
          }

          // ⑤ 词表 alias 声明变换（无条件生成；词表键不存在则创建）+ 形状最后防线
          const settings = { ...(lockedSpace.settings ?? {}) } as Record<string, unknown>;
          const vocabulary = parseCanonicalTags(settings.canonicalTags);
          const nextOutcome = applyTagRenameToVocabulary(vocabulary, fromValues, toValue);
          if (parseCanonicalTags(nextOutcome.next) === null) {
            // 纯函数自保证语义不变量；形状异常说明实现漂移——fail-closed 而非写脏 jsonb
            throw new InternalServerErrorException(
              'tag rename produced an invalid canonicalTags shape (vocabulary guard)',
            );
          }
          lockedSpace.settings = { ...settings, canonicalTags: nextOutcome.next };
          await manager.getRepository(DocSpace).save(lockedSpace);

          // ⑥ 幂等快照（事务内：业务提交 ⟺ 快照可查）
          const result: RenameDocTagsResult = {
            dryRun: false,
            batchToken: currentToken,
            renamed: { from: fromValues, to: toValue },
            vocabulary: toVocabularyChange(nextOutcome),
            updatedDocs: ids.length,
            ingestAffected: ingestRefs,
          };
          if (ctx) await insertIdempotencyInTx(manager, ctx, spaceId, result);

          return { result, affectedIds: ids, preImages };
        });
        return { ...tx, replay: false };
      } catch (err: unknown) {
        const pgErr = err as { code?: string; constraint?: string };
        // 幂等并发撞键：事务已回滚（零副作用）→ 返回对方首次快照
        if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key' && ctx) {
          const replay = await tryIdempotentReplay<RenameDocTagsResult>(this.idempotencyRepo, ctx);
          if (replay) {
            // ⚠️ 重放**不写审计**（评审 M4）：首次请求已写过汇总行；此处若继续往下走会落一条
            // affectedIds=[] / preImages=[] 的空行——与「一次真实改写」自相矛盾且污染可恢复性
            // 载荷。语义对齐顶层 replay 路径（命中即 return，零审计零副作用）。
            return {
              result: { ...replay, idempotentReplay: true },
              affectedIds: [],
              preImages: [],
              replay: true,
            };
          }
        }
        throw err;
      }
    })();

    const { result: executeResult, affectedIds, preImages, replay: isReplay } = txOutcome;

    // ── 事务后：fail-open 汇总审计（一条；oldData = 可恢复性载荷）──────────────
    // 体积判断（plan D9/A7）：500 文档 × ~100B ≈ 50KB jsonb 无压力，不截断。
    // 幂等重放出口直接返回，不写审计（见上）。
    if (!isReplay) {
      await this.auditService.log({
        action: AuditAction.RENAME_DOC_TAGS,
        entityType: AUDIT_ENTITY_TYPE.DOC_SPACE,
        entityId: spaceId,
        actorId: actor?.id ?? null,
        newData: {
          from: fromValues,
          to: toValue,
          affectedCount: affectedIds.length,
          affectedDocIds: affectedIds,
          ingestAffectedIds: executeResult.ingestAffected.map((ref) => ref.docId),
          vocabularyChanges: executeResult.vocabulary ?? null,
        },
        // 可恢复性载荷：回滚 = 按 oldData 反向 rename（token 供与当时 dryRun 对账）。
        // docs 取**事务内锁后**的前镜像 ⇒ 与真实改写集一致（盲执行下也完整）
        oldData: {
          token: executeResult.batchToken,
          docs: preImages,
        },
        source: 'api',
      });
    }

    return executeResult;
  }

  // ─── category merge ──────────────────────────────────────────────────────

  /**
   * DocCategory merge（POST /doc-categories/:id/merge）。
   *
   * fail-closed 顺序：404 source → 404 target（**含软删行查找**）→ 422 target===source /
   * 跨空间 / target 已软删 → 幂等重放 → dryRun 早退 → 事务{锁 space 行 → 锁两个 category 行
   * → docs 重指向 → doc_routes.category 改写 → settings.overviewFilter 修正 → source 软删
   * → 幂等 insert} → 事务后 fail-open 审计。
   *
   * ⚠️ category **无 alias 机制**：merge 后旧 slug 查询即空（tags 有 alias 兼容 /
   * category 没有的不对称性，文档化说明）。
   *
   * @param categoryId source 分类 ID（路径参数 `:id`）
   * @param dto { targetId, dryRun?, idempotencyKey? }
   * @param actor 操作者（审计需要）
   * @returns MergeDocCategoryResult（dryRun 与 execute 同形状）
   */
  async mergeCategory(
    categoryId: string,
    dto: MergeDocCategoryDto,
    actor?: UnifiedActor,
  ): Promise<MergeDocCategoryResult> {
    const ctx = buildIdempotencyContext(
      DOC_CATEGORY_MERGE_IDEMPOTENCY_ENTITY_TYPE,
      actor,
      dto.idempotencyKey,
      { categoryId, targetId: dto.targetId },
    );
    if (ctx) {
      const replay = await tryIdempotentReplay<MergeDocCategoryResult>(this.idempotencyRepo, ctx);
      if (replay) return { ...replay, idempotentReplay: true };
    }

    // 404：source 不存在/已软删（findCategoryById fail-closed）
    const source = await this.docSpaceService.findCategoryById(categoryId);
    // target：需区分「不存在（404）」与「已软删（422）」⇒ 含软删行查找
    const target = await this.findCategoryIncludingDeleted(dto.targetId);
    if (!target) {
      throw new NotFoundException({
        message: 'Target category not found',
        code: ErrorCode.DOC_CATEGORY_NOT_FOUND,
      });
    }
    if (target.id === source.id) {
      throw new UnprocessableEntityException({
        message: 'Target category is the same as the source category; nothing to merge',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (target.spaceId !== source.spaceId) {
      throw new UnprocessableEntityException({
        message: 'Target category belongs to a different DocSpace',
        code: ErrorCode.VALIDATION_ERROR,
        data: { sourceSpaceId: source.spaceId, targetSpaceId: target.spaceId },
      });
    }
    if (target.deletedAt !== null && target.deletedAt !== undefined) {
      throw new UnprocessableEntityException({
        message: 'Target category is soft-deleted; merge into a live category',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    const spaceId = source.spaceId;
    const beforeRows = await this.loadCategoryAffected(this.docRepo.manager, spaceId, source.id);
    const batchToken = this.computeCategoryBatchToken(beforeRows);
    const ingestAffected: DocGovernanceIngestRef[] = beforeRows
      .filter((row) => row.source !== DOC_SOURCE_NATIVE)
      .map((row) => ({ docId: row.id, path: row.path }));
    const softRefs = await this.loadSoftRefs(this.docRepo.manager, spaceId, source.slug);

    // dryRun 早退：零副作用（不写库 / 不写审计 / 不登记幂等）
    if (dto.dryRun) {
      return {
        dryRun: true,
        batchToken,
        source: { id: source.id, slug: source.slug, name: source.name },
        target: { id: target.id, slug: target.slug, name: target.name },
        affectedDocs: {
          total: beforeRows.length,
          sample: beforeRows.slice(0, AFFECTED_SAMPLE_LIMIT).map((row) => ({
            docId: row.id,
            path: row.path,
            currentCategoryId: row.categoryId,
          })),
          truncated: beforeRows.length > AFFECTED_SAMPLE_LIMIT,
        },
        softRefs,
        ingestAffected,
      };
    }

    // ── 事务：锁序 space 行 → categories 行 → docs 批量 UPDATE ───────────────
    // 事务返回值带 preImages（**事务内锁后重读**的行）——repointedDocs / ingestAffected /
    // 审计可恢复性载荷因此恒与真实改写集一致（并发写窗口内进/出 source 的文档不漏不错）
    let executeResult: MergeDocCategoryResult;
    let repointPreImages: Array<{ id: string; categoryId: string | null }> = [];
    try {
      executeResult = await this.docRepo.manager.transaction(async (manager) => {
        // ① 锁 doc_spaces 行（settings 修正与空间级并发写串行化）
        const lockedSpace = await this.lockSpaceRow(manager, spaceId);

        // ② 锁两个 category 行（按 id 升序，防并发 merge 反序加锁死锁）
        const lockedCategories = await this.lockCategoryRows(manager, [source.id, target.id]);
        const liveSource = lockedCategories.find((c) => c.id === source.id);
        const liveTarget = lockedCategories.find((c) => c.id === target.id);
        if (!liveSource || liveSource.deletedAt) {
          throw new NotFoundException({
            message: 'Source category not found',
            code: ErrorCode.DOC_CATEGORY_NOT_FOUND,
          });
        }
        if (!liveTarget || liveTarget.deletedAt) {
          throw new UnprocessableEntityException({
            message: 'Target category is missing or soft-deleted (concurrent change)',
            code: ErrorCode.VALIDATION_ERROR,
          });
        }

        // ②b 锁后重读受影响文档（事务内口径 = 真实改写集）
        const rows = await this.loadCategoryAffected(manager, spaceId, source.id);
        repointPreImages = rows.map((row) => ({ id: row.id, categoryId: row.categoryId }));
        const ingestRefs: DocGovernanceIngestRef[] = rows
          .filter((row) => row.source !== DOC_SOURCE_NATIVE)
          .map((row) => ({ docId: row.id, path: row.path }));

        // ③ docs 重指向（单条 UPDATE；**不 bump updated_at**，理由同 tag rename）。
        // ⚠️ 已知窄窗口（评审 m4，不改行为）：②b 的 SELECT 与 ③ 的 UPDATE 之间，并发
        // upsert 可能把一篇文档写进/写出 source 分类——该文档按 ③ 的执行瞬间归属被处理，
        // 而 repointedDocs 计数与审计前镜像取 ②b 的快照。后果仅**计数/载荷轻微偏移**，
        // 无数据损坏（分类归属恒为「当时在 source 的全部重指向 target」的原子结果）。
        // 关闭该窗口需 docs 行级锁或 SERIALIZABLE，代价远超收益（治理工具的容忍度内）。
        await manager.query(
          `UPDATE docs SET category_id = $1
            WHERE space_id = $2 AND deleted_at IS NULL AND category_id = $3`,
          [target.id, spaceId, source.id],
        );

        // ④ doc_routes.category 自由文本改写（非 FK，策展枚举）。
        // 先计数再 UPDATE：`UPDATE ... RETURNING` 经 TypeORM `query()` 的返回形态随驱动
        // 结构化结果开关而变（rows 数组 vs [rows, affected]），计数单独查最稳且语义等价
        // （同一事务同一连接，计数与改写之间无并发窗口）。
        const routeCountRows: Array<{ count: number | string }> = await manager.query(
          `SELECT COUNT(*)::int AS count FROM doc_routes WHERE space_id = $1 AND category = $2`,
          [spaceId, source.slug],
        );
        const routesUpdated = Number(routeCountRows[0]?.count ?? 0);
        await manager.query(
          `UPDATE doc_routes SET category = $1 WHERE space_id = $2 AND category = $3`,
          [target.slug, spaceId, source.slug],
        );

        // ⑤ settings.overviewFilter.excludeCategories 修正（同一次 space 行锁内完成）：
        //    含 fromSlug → 替换为 toSlug；toSlug 已在 → 去重（只删 fromSlug）
        const settings = { ...(lockedSpace.settings ?? {}) } as Record<string, unknown>;
        let excludeCategoriesUpdated = 0;
        const overviewFilter = settings.overviewFilter as
          | { excludeCategories?: unknown }
          | null
          | undefined;
        if (overviewFilter && Array.isArray(overviewFilter.excludeCategories)) {
          const list = overviewFilter.excludeCategories.filter(
            (item): item is string => typeof item === 'string',
          );
          if (list.includes(source.slug)) {
            const next = list.filter((item) => item !== source.slug);
            if (!next.includes(target.slug)) next.push(target.slug);
            settings.overviewFilter = { ...overviewFilter, excludeCategories: next };
            excludeCategoriesUpdated = 1;
          }
        }
        if (excludeCategoriesUpdated === 1) {
          lockedSpace.settings = settings;
          await manager.getRepository(DocSpace).save(lockedSpace);
        }

        // ⑥ source 软删（partial unique index 自动释放 slug，F17）
        await manager.query(
          `UPDATE doc_categories SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
          [source.id],
        );

        // ⑦ 幂等快照
        const result: MergeDocCategoryResult = {
          dryRun: false,
          batchToken,
          merged: { fromSlug: source.slug, toSlug: target.slug },
          repointedDocs: rows.length,
          softRefsFixed: {
            routesUpdated,
            excludeCategoriesUpdated,
          },
          sourceDeleted: true,
          ingestAffected: ingestRefs,
        };
        if (ctx) await insertIdempotencyInTx(manager, ctx, source.id, result);
        return result;
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key' && ctx) {
        const replay = await tryIdempotentReplay<MergeDocCategoryResult>(this.idempotencyRepo, ctx);
        if (replay) return { ...replay, idempotentReplay: true };
      }
      throw err;
    }

    // ── 事务后：fail-open 汇总审计 ────────────────────────────────────────────
    await this.auditService.log({
      action: AuditAction.MERGE_DOC_CATEGORY,
      entityType: AUDIT_ENTITY_TYPE.DOC_CATEGORY,
      entityId: source.id,
      actorId: actor?.id ?? null,
      newData: {
        fromSlug: source.slug,
        toSlug: target.slug,
        sourceId: source.id,
        targetId: target.id,
        affectedCount: executeResult.repointedDocs ?? 0,
        affectedDocIds: repointPreImages.map((row) => row.id),
        ingestAffectedIds: executeResult.ingestAffected.map((ref) => ref.docId),
        softRefsFixed: executeResult.softRefsFixed,
      },
      // 可恢复性载荷：回滚 = 按 oldData 把 docs 重指向 source（并复活 source 分类）。
      // docs 取**事务内锁后**的前镜像 ⇒ 与真实改写集一致
      oldData: {
        token: executeResult.batchToken,
        docs: repointPreImages,
        sourceCategory: { id: source.id, slug: source.slug, name: source.name },
        softRefs,
      },
      source: 'api',
    });

    return executeResult;
  }

  // ─── 私有内核 ────────────────────────────────────────────────────────────

  /**
   * 锁 doc_spaces 行（FOR UPDATE）并返回实体（含 settings）。
   *
   * 锁序纪律的第一步（space → categories → docs）；行不存在/已软删 → 404。
   */
  private async lockSpaceRow(manager: EntityManager, spaceId: string): Promise<DocSpace> {
    const space = await manager
      .getRepository(DocSpace)
      .createQueryBuilder('s')
      .setLock('pessimistic_write')
      .where('s.id = :id', { id: spaceId })
      .andWhere('s.deleted_at IS NULL')
      .getOne();
    if (!space) {
      throw new NotFoundException({
        message: 'DocSpace not found',
        code: ErrorCode.DOC_SPACE_NOT_FOUND,
      });
    }
    return space;
  }

  /**
   * 锁若干 doc_categories 行（FOR UPDATE，按 id 升序取锁防反序死锁）。
   *
   * 返回含软删行的实体（`deletedAt` 需显式 addSelect——该列 `select: false`）。
   */
  private async lockCategoryRows(
    manager: EntityManager,
    categoryIds: string[],
  ): Promise<DocCategory[]> {
    const ordered = [...new Set(categoryIds)].sort();
    return manager
      .getRepository(DocCategory)
      .createQueryBuilder('c')
      .withDeleted()
      .addSelect('c.deletedAt')
      .setLock('pessimistic_write')
      .where('c.id IN (:...ids)', { ids: ordered })
      .orderBy('c.id', 'ASC')
      .getMany();
  }

  /**
   * 含软删行查找单个分类（用于区分 404「不存在」与 422「已软删」）。
   *
   * `deletedAt` 列 `select: false`，必须 addSelect 才能读到。
   */
  private async findCategoryIncludingDeleted(id: string): Promise<DocCategory | null> {
    return this.categoryRepo
      .createQueryBuilder('c')
      .withDeleted()
      .addSelect('c.deletedAt')
      .where('c.id = :id', { id })
      .getOne();
  }

  /**
   * 加载 tag rename 的受影响文档集（`tags && fromValues`，交集非空）。
   *
   * dryRun（事务外）与 execute（事务内 FOR UPDATE 之后）**调用同一方法**——口径一致是
   * batchToken 可比对的前提（plan D4/A3）。按 id 升序保证行序确定。
   */
  private async loadTagAffected(
    manager: EntityManager,
    spaceId: string,
    fromValues: string[],
  ): Promise<TagAffectedRow[]> {
    const rows = await manager
      .getRepository(Doc)
      .createQueryBuilder('d')
      .select(['d.id', 'd.path', 'd.tags', 'd.updatedAt', 'd.source'])
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .andWhere('d.tags && CAST(:fromValues AS text[])', { fromValues })
      .orderBy('d.id', 'ASC')
      .getMany();
    return rows as TagAffectedRow[];
  }

  /**
   * 加载 category merge 的受影响文档集（`category_id = sourceId`）。
   *
   * dryRun（事务外）与 execute（事务内锁后）共用：**execute 侧以事务内锁后重算为准**
   * （repointedDocs / ingestAffected / 审计前镜像都取事务内那次读），dryRun 侧的事务外
   * 读只服务预演视图——两处口径同源（同一方法），但**权威值在事务内**。
   */
  private async loadCategoryAffected(
    manager: EntityManager,
    spaceId: string,
    sourceCategoryId: string,
  ): Promise<CategoryAffectedRow[]> {
    const rows = await manager
      .getRepository(Doc)
      .createQueryBuilder('d')
      .select(['d.id', 'd.path', 'd.categoryId', 'd.updatedAt', 'd.source'])
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .andWhere('d.category_id = :categoryId', { categoryId: sourceCategoryId })
      .orderBy('d.id', 'ASC')
      .getMany();
    return rows as CategoryAffectedRow[];
  }

  /**
   * 加载 category merge 的软引用影响面（doc_routes.category + overviewFilter.excludeCategories）。
   */
  private async loadSoftRefs(
    manager: EntityManager,
    spaceId: string,
    sourceSlug: string,
  ): Promise<{ routesCategoryCount: number; excludeCategories: boolean }> {
    const routeRows: Array<{ count: string }> = await manager.query(
      `SELECT COUNT(*)::int AS count FROM doc_routes WHERE space_id = $1 AND category = $2`,
      [spaceId, sourceSlug],
    );
    const spaceRows: Array<{ settings: Record<string, unknown> | null }> = await manager.query(
      `SELECT settings FROM doc_spaces WHERE id = $1`,
      [spaceId],
    );
    const filter = spaceRows[0]?.settings?.overviewFilter as
      | { excludeCategories?: unknown }
      | undefined;
    const excluded =
      Array.isArray(filter?.excludeCategories) &&
      filter.excludeCategories.some((item) => item === sourceSlug);
    return { routesCategoryCount: Number(routeRows[0]?.count ?? 0), excludeCategories: excluded };
  }

  /**
   * 统计各 distinct from 值的命中文档数（dryRun 的 perValue）。
   *
   * `unnest` 展开 + 精确等值计数（口径与 SQL 改写一致：存的什么就按什么数）。
   */
  private async countTagValues(
    spaceId: string,
    fromValues: string[],
  ): Promise<Array<{ value: string; docCount: number }>> {
    const rows: Array<{ value: string; docCount: number }> = await this.docRepo.manager.query(
      `SELECT t AS value, COUNT(*)::int AS "docCount"
         FROM docs d, unnest(d.tags) AS t
        WHERE d.space_id = $1 AND d.deleted_at IS NULL AND t = ANY($2::text[])
        GROUP BY t
        ORDER BY t ASC`,
      [spaceId, fromValues],
    );
    return rows.map((row) => ({ value: row.value, docCount: Number(row.docCount) }));
  }

  /**
   * trgm 近义候选（dryRun 的 similarNotAffected，DX 提示可补进 from）。
   *
   * 候选池 = 空间内全部 distinct tag 值；排除 from 本身（ci）；`similarity()` 显式阈值
   * 比较（不依赖会话级 pg_trgm GUC，避免污染连接池）。
   */
  private async findSimilarTagValues(
    spaceId: string,
    fromValues: string[],
  ): Promise<Array<{ value: string; docCount: number }>> {
    const lowered = fromValues.map((value) => value.toLowerCase());
    const rows: Array<{ value: string; docCount: number }> = await this.docRepo.manager.query(
      `WITH tag_counts AS (
         SELECT t AS value, COUNT(*)::int AS count
           FROM docs d, unnest(d.tags) AS t
          WHERE d.space_id = $1 AND d.deleted_at IS NULL
          GROUP BY t
       )
       SELECT value, count::int AS "docCount"
         FROM tag_counts
        WHERE NOT (lower(value) = ANY($2::text[]))
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS f
             WHERE similarity(tag_counts.value, f) >= $3
          )
        ORDER BY count DESC, value ASC
        LIMIT $4`,
      [spaceId, lowered, SIMILAR_TAG_SIMILARITY_THRESHOLD, SIMILAR_TAG_LIMIT],
    );
    return rows.map((row) => ({ value: row.value, docCount: Number(row.docCount) }));
  }

  /**
   * 受影响集快照 token（tag 侧）——**唯一**计算点（dryRun 与 execute 共用）。
   *
   * 序列化确定性（plan D4/A3）：每文档取 `{id, tags, updatedAt}`；`tags` 排序（集合语义）、
   * `updatedAt` 统一 ISO 字符串、文档按 id 升序 ⇒ 同一状态恒得同一 sha256。
   */
  private computeTagBatchToken(rows: TagAffectedRow[]): string {
    const canonical = rows
      .map((row) => ({
        id: row.id,
        tags: [...row.tags].sort(),
        updatedAt: new Date(row.updatedAt).toISOString(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  /**
   * 受影响集快照 token（category 侧）——序列化口径同上，值取 `categoryId`。
   *
   * ⚠️ merge **不接 expectedBatchToken**（plan D2/§3）：本 token 是 dryRun 的核对面，
   * 不参与 execute 仲裁。
   */
  private computeCategoryBatchToken(rows: CategoryAffectedRow[]): string {
    const canonical = rows
      .map((row) => ({
        id: row.id,
        categoryId: row.categoryId,
        updatedAt: new Date(row.updatedAt).toISOString(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }
}
