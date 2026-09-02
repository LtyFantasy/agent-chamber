/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.10 (DocSpace Module) + plan venom-longshot-ragman.md
 *     （v1.60.0-dev P1 双件：73cadb0d 原子 move_doc / 8d763914 move impact）
 *   - 补充: docs/api-definition.md §16（PUT/DELETE /docs 端点契约）
 *   - 补充: plan patriot-cyclone-deadman.md §1.3（v1.61.0 批次 1：inbound 精确源解析 +
 *     outboundPathLinksToRewrite 出链失效面）
 *   - 补充: v1.62.0（contentHash 读路径透传）：computeMoveImpact 返回 root contentHash
 *     = 原始写入 payload 的 SHA-256（与读出重建正文不可互算）——「无 token dryRun 取
 *     hash → 带同一 token 正式 move」的数据源
 *   - 补充: plan fire-jericho-she-hulk.md（v1.63.0 Board 任务 7d918c7b）：move 加
 *     clientRequestId 幂等（此前零防重）——重放返回首次 DocMoveResult 快照 +
 *     idempotentReplay:true，文档不会二次移动；helper 见 doc-idempotency.helper.ts
 *
 * [踩坑索引]
 *   - Hument 事故（topic msg 6dbc4da3）：乐观锁 TOCTOU → 事务外快速失败 + 事务内
 *     FOR UPDATE 复核（本文件 move 校验链复用 doc.service.ts:489-508 模式）
 *   - B-50/B-51（事件越权/SSE 全量广播）：事件 payload 的 topicId/boardId 必须经
 *     getSpaceEventContext 从空间绑定派生（本文件 DOC_MOVED 同路径），否则绑 board
 *     空间的成员收不到事件、可见性语义与其他 doc 事件分裂
 *   - v1.61.0 路径语义漂移（d0569c83/f80a04ea）：旧 resolveHrefToDocPath 启发式
 *     （剥前缀 + docs/ 补全）与 sourcePath 无关；重写为严格 POSIX 源目录解析后，
 *     inbound/outbound 必须传 sourceDoc.path / doc.path，禁止再调用无 sourcePath
 *     的旧签名（TS 类型层已强制；加新调用点时先看 link-health.ts 语义表）
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #17(测试契约) #21(双层校验) #22(findOne必须判空) #23(jsonb/ORM 集成覆盖)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode, AuditAction, EventType, ResourceType } from '@agent-chamber/shared';
import type {
  DocInboundLink,
  DocMoveImpact,
  DocMoveResult,
  DocOutboundLink,
  DocRouteRef,
} from '@agent-chamber/shared';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { DocService } from './doc.service';
import { DOC_SOURCE_NATIVE } from './doc-constants';
import { EventService } from '../event/event.service';
import { extractDocLinks, resolveHrefToDocPath, matchDocReferenceLink } from './link-health';
import type { MoveDocDto } from './dto';
import { UnifiedActor } from '../../common/types/actor.types';
// v1.63.0 DocSpace 写族幂等（Board 任务 7d918c7b）：helper 与 DocService 共用
import {
  buildIdempotencyContext,
  tryIdempotentReplay,
  insertIdempotencyInTx,
} from './doc-idempotency.helper';

/**
 * DocSpace 原子 move + move impact（v1.60.0-dev P1 双件 73cadb0d / 8d763914）
 *
 * 定位：文档移动的**唯一写通道**——同一 docId 单事务只 `UPDATE docs SET path`，
 * 一行都不动 task_doc_links / doc_routes / doc_versions / doc_sections（引用面
 * 全部按 docId，move 天然连续），不触碰 content/sections/contentHash/title。
 *
 * 设计要点：
 * - computeMoveImpact 是共享内核：move-impact 端点 / move dryRun / move 响应摘要
 *   三处共用同一份实现，保证 dryRun 预演视图与真实移动前的状态一致。
 * - 入链反扫输入 = reconstructContent(sections)（与 recalcSpaceLinkHealth 同源），
 *   反查结果与 linkHealth 数据语义一致；归一化规则 single-source 于 link-health.ts。
 * - fail-closed 校验链（顺序即错误码语义）：
 *   404（不存在/已软删，findById）→ 409 DOC_SOURCE_MISMATCH（非 native）→
 *   409 RESOURCE_CONFLICT（toPath == 当前 path，no-op 拒绝）→
 *   409 DOC_CONTENT_CONFLICT（expectedContentHash 事务外快速失败 + 事务内
 *   FOR UPDATE 复核，TOCTOU 复用 upsert 先例）→ 409 RESOURCE_CONFLICT
 *   （目标 path 碰撞，带 conflictDocId；并发 23505 catch 幂等返回）。
 */
@Injectable()
export class DocMoveService {
  /** NestJS 内置 Logger（fire-and-forget 异步任务的错误只记日志不透出，对齐仓内惯例） */
  private readonly logger = new Logger(DocMoveService.name);

  constructor(
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    @InjectRepository(DocSection)
    private readonly sectionRepo: Repository<DocSection>,
    @InjectRepository(DocRoute)
    private readonly routeRepo: Repository<DocRoute>,
    @InjectRepository(TaskDocLink)
    private readonly taskDocLinkRepo: Repository<TaskDocLink>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    // 幂等记录 repo（v1.63.0）：move 是「更新」语义且此前零防重——重放返回首次
    // DocMoveResult 快照，文档不会二次移动
    @InjectRepository(IdempotencyRecord)
    private readonly idempotencyRepo: Repository<IdempotencyRecord>,
    private readonly docService: DocService,
    private readonly eventService: EventService,
  ) {}

  /**
   * 【共享内核】计算移动影响面（backlinks / 引用清单 / 冲突检测 / 出链失效面）。
   *
   * 三处消费者：GET /docs/:id/move-impact（read 权限）、POST /docs/:id/move 的
   * dryRun 与响应摘要。proposedPath 非空时额外做 no-op 检测（samePath）、目标
   * path 碰撞检测（targetCollision）与 outbound 出链失效清单
   * （outboundPathLinksToRewrite，v1.61.0 f80a04ea）。
   *
   * 入链反扫：全空间未删 doc 逐篇 sections 还原全文（reconstructContent
   * skipDuplicateTitle=false，与 recalcSpaceLinkHealth 输入完全同源）→
   * extractDocLinks 提取 → 反向匹配目标 doc。匹配规则 single-source：
   * - ?doc= 平台规范链接（matchDocReferenceLink）按 docId 比对，isPathBased=false；
   * - 相对 .md path 链接（resolveHrefToDocPath(href, sourceDoc.path) 严格源目录
   *   解析，v1.61.0）与 target.path 等值比对，isPathBased=true。
   * 去重契约：inboundLinks 按 (sourceDocId, href) 去重；section 定位 = 该 href
   * 首个命中 section 的 position/headingPath。
   *
   * @param spaceId - 文档所属 DocSpace ID
   * @param doc - 目标文档实体（须未软删，由调用方 findById 保证）
   * @param proposedPath - 提议的新 path（可选；move/dryRun 传入，impact 端点可传）
   * @returns DocMoveImpact 完整视图
   */
  async computeMoveImpact(
    spaceId: string,
    doc: Doc,
    proposedPath?: string,
  ): Promise<DocMoveImpact> {
    // 1. 空间全部未删 doc（id + path + title），与 recalcSpaceLinkHealth 候选集同款
    const docs = await this.docRepo
      .createQueryBuilder('d')
      .select(['d.id', 'd.path', 'd.title'])
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.deleted_at IS NULL')
      .getMany();

    // 2. 入链反扫（全空间逐篇 sections 还原 + 正则，262-doc 量级秒级，读操作可接受；
    //    不做缓存——link_health 不存入链是有意设计）
    const inboundLinks: DocInboundLink[] = [];
    const seen = new Set<string>(); // 去重键 (sourceDocId, href)

    for (const sourceDoc of docs) {
      const sections = await this.sectionRepo
        .createQueryBuilder('s')
        .select([
          's.content',
          's.headingLevel',
          's.headingPath',
          's.headingText',
          's.isContinuation',
          's.position',
        ])
        .where('s.doc_id = :docId', { docId: sourceDoc.id })
        .orderBy('s.position', 'ASC')
        .getMany();

      const content = this.docService.reconstructContent(sourceDoc, sections, false);
      const hrefs = extractDocLinks(content);
      if (hrefs.length === 0) continue;

      // section 定位索引：href → 首个命中 section（同一 section 可能链多个 href；
      // 同一 href 多处链只记首个命中 position——验收契约）
      const hrefSection = new Map<string, { position: number; headingPath: string | null }>();
      for (const s of sections) {
        for (const h of extractDocLinks(s.content)) {
          if (!hrefSection.has(h)) {
            hrefSection.set(h, { position: s.position, headingPath: s.headingPath });
          }
        }
      }

      for (const href of hrefs) {
        const key = `${sourceDoc.id}|${href}`;
        if (seen.has(key)) continue;

        let hit = false;
        let isPathBased = false;
        const refDocId = matchDocReferenceLink(href);
        if (refDocId) {
          // ?doc= 规范链接：按 docId 比对（move 不改 docId → 不受影响）
          hit = refDocId === doc.id;
          isPathBased = false;
        } else {
          // 相对 .md path 链接：严格源目录解析后与目标当前 path 等值比对
          // （v1.61.0 语义变更：sourcePath 精确解析，无 docs/ 前缀补全候选）
          const resolved = resolveHrefToDocPath(href, sourceDoc.path);
          if (resolved === null) continue;
          hit = resolved === doc.path;
          isPathBased = true;
        }
        if (!hit) continue;

        seen.add(key);
        const section = hrefSection.get(href);
        const entry: DocInboundLink = {
          sourceDocId: sourceDoc.id,
          sourcePath: sourceDoc.path,
          sourceTitle: sourceDoc.title,
          href,
          isPathBased,
          ...(section
            ? { sectionPosition: section.position, headingPath: section.headingPath }
            : {}),
        };
        inboundLinks.push(entry);
      }
    }

    // 3. doc_routes 引用（裸 docId 无 FK，move 后路由行自动连续；清单仅展示用途）
    const routes = await this.routeRepo
      .createQueryBuilder('r')
      .where('r.primary_doc_id = :docId OR r.secondary_doc_id = :docId', { docId: doc.id })
      .getMany();
    const docRoutes: DocRouteRef[] = routes.flatMap((r) => {
      const items: DocRouteRef[] = [];
      if (r.primaryDocId === doc.id) {
        items.push({
          routeId: r.id,
          intent: r.intent,
          role: 'primary',
          headingPath: r.primaryHeadingPath,
        });
      }
      if (r.secondaryDocId === doc.id) {
        items.push({
          routeId: r.id,
          intent: r.intent,
          role: 'secondary',
          headingPath: r.secondaryHeadingPath,
        });
      }
      return items;
    });

    // 4. task_doc_links 引用（任务关联 taskId 列表）
    const taskLinkRows = await this.taskDocLinkRepo
      .createQueryBuilder('tdl')
      .select('tdl.task_id', 'taskId')
      .where('tdl.doc_id = :docId', { docId: doc.id })
      .getRawMany<{ taskId: string }>();
    const taskLinks = taskLinkRows.map((r) => r.taskId);

    // 5. 目标 path 冲突检测（proposedPath 非空时才判定；调用方按 samePath/collision 断 409）
    let targetCollision: DocMoveImpact['targetCollision'];
    let samePath: boolean | undefined;
    if (proposedPath) {
      if (proposedPath === doc.path) {
        samePath = true;
      } else {
        const conflict = await this.docRepo
          .createQueryBuilder('d')
          .select('d.id')
          .where('d.space_id = :spaceId', { spaceId })
          .andWhere('d.path = :path', { path: proposedPath })
          .andWhere('d.id != :id', { id: doc.id })
          .andWhere('d.deleted_at IS NULL')
          .getOne();
        if (conflict) {
          targetCollision = { collision: true, conflictDocId: conflict.id };
        }
      }
    }

    // 6. outbound 出链失效面（v1.61.0 f80a04ea；仅 proposedPath 非空时计算）：
    // 被移文档自身相对 .md 出链在移动前后基准目录变化 → 解析目标漂移 → 逐条标注。
    // 独立于入链反扫（方向相反：这里是「我链别人」，改写面在自身正文）。
    let outboundPathLinksToRewrite: DocOutboundLink[] | undefined;
    if (proposedPath) {
      outboundPathLinksToRewrite = await this.computeOutboundLinks(doc, proposedPath, docs);
    }

    return {
      docId: doc.id,
      path: doc.path,
      // 原始写入 payload 的 SHA-256（乐观锁 token，与读出正文不可互算）——
      // move-impact / move dryRun / move 响应共用 computeMoveImpact 内核，
      // 该 token 即是「无 token dryRun 取 hash → 带同一 token 正式 move」链路的数据源
      contentHash: doc.contentHash,
      ...(proposedPath ? { proposedPath } : {}),
      inboundLinks,
      docRoutes,
      taskLinks,
      ...(targetCollision ? { targetCollision } : {}),
      ...(samePath !== undefined ? { samePath } : {}),
      pathBasedLinksToRewrite: inboundLinks.filter((l) => l.isPathBased),
      ...(outboundPathLinksToRewrite ? { outboundPathLinksToRewrite } : {}),
    };
  }

  /**
   * 计算被移文档自身的出链失效清单（outboundPathLinksToRewrite）。
   *
   * 反扫方向与入链相反：入链是「别人链我」（改写面在他人正文），这里是被移文档
   * 自身正文里指向其他文档的相对 .md 出链——移动后基准目录变化，链接解析目标
   * 漂移即失效（或意外指向其他文档），需迁移方在自身正文里改写。
   *
   * 收录规则：
   * - 仅 path-based 相对 .md 链接（?doc= 平台链接按 docId 引用不受 move 影响，跳过）；
   * - old/new 解析结果**不同**才收录（posix.normalize 后等值 = 链接不依赖源目录
   *   位置（同目录裸引用、空间根绝对 / 前缀等）→ 移动前后目标一致 → 不受影响）；
   * - exists 双标记：oldTargetExists 按**移动前** path 集合（缺 doc 的旧 path）、
   *   targetExists 按**移动后** path 集合（去掉 doc.path、加上 proposedPath——被移
   *   文档自身以 newPath 计入，自引用链接因此正确）；
   * - 越界解析（结果以 .. 开头）正常参与 exists 判定：恒 false → 移动前后都断，
   *   但 old/new 不同仍收录（迁移方可顺带修正越界书写）。
   *
   * @param doc - 被移文档实体（承载出链的源）
   * @param proposedPath - 提议的新 path
   * @param docs - 空间全部未删 doc（id + path，移动前集合 + 移动后集合的原料）
   * @returns outbound 清单（按文内出现顺序去重，section 定位取首个命中）
   */
  private async computeOutboundLinks(
    doc: Doc,
    proposedPath: string,
    docs: Doc[],
  ): Promise<DocOutboundLink[]> {
    // 被移文档自身 sections（与入链反扫同款 select/排序，off-by-one 无）
    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .select([
        's.content',
        's.headingLevel',
        's.headingPath',
        's.headingText',
        's.isContinuation',
        's.position',
      ])
      .where('s.doc_id = :docId', { docId: doc.id })
      .orderBy('s.position', 'ASC')
      .getMany();

    const content = this.docService.reconstructContent(doc, sections, false);

    // section 定位索引：href → 首个命中 section（与入链反扫同口径）
    const hrefSection = new Map<string, { position: number; headingPath: string | null }>();
    for (const s of sections) {
      for (const h of extractDocLinks(s.content)) {
        if (!hrefSection.has(h)) {
          hrefSection.set(h, { position: s.position, headingPath: s.headingPath });
        }
      }
    }

    // 存在性判定集合（plan：exists 按「移动后 path 集合」——自身以 newPath 计入）
    const prePaths = new Set(docs.map((d) => d.path));
    const postPaths = new Set(docs.map((d) => d.path));
    postPaths.delete(doc.path);
    postPaths.add(proposedPath);
    // 移动后 path → id 映射（含自身 newPath → 自引用 targetDocId 正确）
    const postPathToId = new Map(docs.map((d) => [d.path, d.id] as const));
    postPathToId.set(proposedPath, doc.id);

    const outbound: DocOutboundLink[] = [];
    const seen = new Set<string>();
    for (const href of extractDocLinks(content)) {
      // 去重：同一 href 只收录一条（section 取首命中，对齐 inbound 契约）
      if (seen.has(href)) continue;

      // ?doc= 平台链接按 docId 引用，move 不影响 → 不收录
      if (matchDocReferenceLink(href)) continue;

      const oldResolvedTarget = resolveHrefToDocPath(href, doc.path);
      const newResolvedTarget = resolveHrefToDocPath(href, proposedPath);
      // 非 .md / 纯锚点 → 不参与判定（与 linkHealth 同语义）
      if (oldResolvedTarget === null || newResolvedTarget === null) continue;
      // old == new = 链接不依赖源目录位置（同目录裸引用 / 空间根绝对）→ 不受影响
      if (oldResolvedTarget === newResolvedTarget) continue;

      seen.add(href);
      const section = hrefSection.get(href);
      const entry: DocOutboundLink = {
        href,
        oldResolvedTarget,
        newResolvedTarget,
        oldTargetExists: prePaths.has(oldResolvedTarget),
        targetExists: postPaths.has(newResolvedTarget),
        ...(postPaths.has(newResolvedTarget)
          ? { targetDocId: postPathToId.get(newResolvedTarget) }
          : {}),
        ...(section ? { sectionPosition: section.position, headingPath: section.headingPath } : {}),
      };
      outbound.push(entry);
    }
    return outbound;
  }

  /**
   * 原子移动文档（POST /docs/:id/move）。
   *
   * 单事务锁行 FOR UPDATE → 复核 hash + collision → 仅 `UPDATE docs SET path`。
   * 不动 sections/versions/contentHash/title；引用面四张表（task_doc_links /
   * doc_routes / doc_versions / doc_sections）零行变更。
   *
   * fail-closed 校验链（顺序即错误码语义，见类注释）；dryRun=true 跑完整校验链 +
   * impact 预演视图，不写库。事务成功后：audit（MOVE_DOC）→ 事件 DOC_MOVED
   * （topicId/boardId 经 getSpaceEventContext 派生）→ setImmediate 异步重算
   * recalcSpaceLinkHealth（旧 path 入链即刻变断链可见；route recheck 不触发——
   * sections 未动，headingPath 不会悬空）。
   *
   * @param docId - 目标文档 ID（不存在/已软删 → 404 DOC_NOT_FOUND）
   * @param dto - { toPath, expectedContentHash?, dryRun?, clientRequestId? }
   * @param actor - 操作者（audit 需要；未认证写不落 audit，对齐既有 doc 写通道）
   * @returns DocMoveResult（moved=true 已落库 / moved=false + wouldMove=true 为 dryRun；
   *   幂等重放时为首次成功响应快照 + idempotentReplay:true）
   */
  async move(docId: string, dto: MoveDocDto, actor?: UnifiedActor): Promise<DocMoveResult> {
    // 幂等包裹（最外层写入口，v1.63.0）：无键零开销旁路；有键先查重放——命中直接
    // 返回首次快照（跳过全部校验链与 dryRun 分支：首次已验证过，重放零副作用且文档
    // 不会二次移动）。requestHash 只含写语义字段（dryRun 是预演不登记幂等，不参与指纹）
    const ctx = buildIdempotencyContext(actor, dto.clientRequestId, {
      docId,
      toPath: dto.toPath,
      expectedContentHash: dto.expectedContentHash,
    });
    if (ctx) {
      const replay = await tryIdempotentReplay<DocMoveResult>(this.idempotencyRepo, ctx);
      if (replay) return { ...replay, idempotentReplay: true };
    }

    // ① 404：文档不存在/已软删（findById fail-closed，铁律 #22）
    const doc = await this.docService.findById(docId);

    // 共享内核：impact 视图（含 samePath / targetCollision 检测）
    const impact = await this.computeMoveImpact(doc.spaceId, doc, dto.toPath);

    // ② 409 DOC_SOURCE_MISMATCH：非 native（ingest）文档由适配器管，move 会断 source 映射
    if (doc.source !== DOC_SOURCE_NATIVE) {
      throw new ConflictException({
        message:
          `Document source '${doc.source}' is not ${DOC_SOURCE_NATIVE}; only native documents can be moved ` +
          `(ingest documents are managed by their adapter)`,
        code: ErrorCode.DOC_SOURCE_MISMATCH,
      });
    }

    // ③ 409 RESOURCE_CONFLICT：toPath == 当前 path（no-op 拒绝，防无意义请求）
    if (impact.samePath) {
      throw new ConflictException({
        message: `Target path '${dto.toPath}' is the document's current path; nothing to move`,
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // ④ 409 DOC_CONTENT_CONFLICT：expectedContentHash 事务外快速失败——
    // 权威校验在事务内 FOR UPDATE 后复核（防 TOCTOU 窗口，复用 upsert 先例模式）
    if (dto.expectedContentHash !== undefined && doc.contentHash !== dto.expectedContentHash) {
      throw new ConflictException({
        message:
          `expectedContentHash mismatch: document was modified since the caller's read ` +
          `(expected ${dto.expectedContentHash}, current ${doc.contentHash}); re-read the document and retry`,
        code: ErrorCode.DOC_CONTENT_CONFLICT,
        data: { currentContentHash: doc.contentHash },
      });
    }

    // ⑤ 409 RESOURCE_CONFLICT：目标 path 撞空间内未删 doc（响应带 conflictDocId）
    if (impact.targetCollision) {
      throw new ConflictException({
        message: `Target path '${dto.toPath}' is already taken by another document`,
        code: ErrorCode.RESOURCE_CONFLICT,
        data: { conflictDocId: impact.targetCollision.conflictDocId },
      });
    }

    // dryRun：完整校验链已全过——返回预演视图（impact 完整清单），不写库
    if (dto.dryRun) {
      return {
        docId: doc.id,
        oldPath: doc.path,
        newPath: dto.toPath,
        contentHash: doc.contentHash,
        moved: false,
        wouldMove: true,
        impact,
      };
    }

    // ── 事务：锁行 → 复核 → 仅改 path ──────────────────────────────
    // v1.63.0 幂等：响应在事务内组装并落快照——「业务提交 ⟺ 快照可查」原子性；
    // 并发同 key 撞 uq_idempotency_actor_key → 整个事务回滚（path 未变、零副作用）→
    // 外层 catch 按重放语义返回对方首次快照
    let movedDoc: Doc;
    try {
      movedDoc = await this.docRepo.manager.transaction(async (manager) => {
        const docRepo = manager.getRepository(Doc);

        // 事务内 FOR UPDATE 锁行（并发写被行锁串行化）
        const locked = await docRepo
          .createQueryBuilder('d')
          .setLock('pessimistic_write')
          .where('d.id = :id', { id: docId })
          .andWhere('d.deleted_at IS NULL')
          .getOne();
        if (!locked) {
          // 事务外 findById 通过但锁行时已被并发删（软删）——回滚并 404
          throw new NotFoundException({
            message: 'Document not found',
            code: ErrorCode.DOC_NOT_FOUND,
          });
        }

        // 事务内复核 expectedContentHash（TOCTOU：事务外校验与写入之间有并发窗口）
        if (
          dto.expectedContentHash !== undefined &&
          locked.contentHash !== dto.expectedContentHash
        ) {
          throw new ConflictException({
            message:
              `expectedContentHash mismatch (in-transaction recheck): document was modified ` +
              `concurrently (expected ${dto.expectedContentHash}, current ${locked.contentHash}); ` +
              `re-read the document and retry`,
            code: ErrorCode.DOC_CONTENT_CONFLICT,
            data: { currentContentHash: locked.contentHash },
          });
        }

        // 事务内复核目标 path collision（两个并发 move 到同一 target 的决胜点之一）
        const conflict = await docRepo
          .createQueryBuilder('d')
          .select(['d.id', 'd.path'])
          .where('d.space_id = :spaceId', { spaceId: doc.spaceId })
          .andWhere('d.path = :path', { path: dto.toPath })
          .andWhere('d.id != :id', { id: docId })
          .andWhere('d.deleted_at IS NULL')
          .getOne();
        if (conflict) {
          throw new ConflictException({
            message: `Target path '${dto.toPath}' is already taken by another document`,
            code: ErrorCode.RESOURCE_CONFLICT,
            data: { conflictDocId: conflict.id },
          });
        }

        // 唯一写操作：只改 path + updatedAt（⚠️ QueryBuilder.update 不触发
        // @UpdateDateColumn——那是 save() 的行为，必须显式 NOW()，否则
        // 「最近更新」排序面会拿到陈旧时间戳），不碰 content/sections/
        // contentHash/title/versions——引用面全部按 docId 连续
        await docRepo
          .createQueryBuilder()
          .update('Doc')
          .set({ path: dto.toPath, updatedAt: () => 'NOW()' })
          .where('id = :id', { id: docId })
          .execute();

        const fresh = await docRepo
          .createQueryBuilder('d')
          .where('d.id = :id', { id: docId })
          .andWhere('d.deleted_at IS NULL')
          .getOne();
        if (!fresh) {
          throw new NotFoundException({
            message: 'Document not found',
            code: ErrorCode.DOC_NOT_FOUND,
          });
        }

        // v1.63.0 幂等：最终响应事务内组装并落快照（impact 在事务前已算好，
        // oldPath/newPath/contentHash 此刻全部确定）
        if (ctx) {
          await insertIdempotencyInTx(manager, ctx, docId, {
            docId: fresh.id,
            oldPath: doc.path,
            newPath: fresh.path,
            contentHash: fresh.contentHash,
            moved: true,
            impact,
          } satisfies DocMoveResult);
        }
        return fresh;
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      // v1.63.0 幂等并发撞键：事务已回滚（path 未变、零副作用）→ 返回对方首次快照
      if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key' && ctx) {
        const replay = await tryIdempotentReplay<DocMoveResult>(this.idempotencyRepo, ctx);
        if (replay) return { ...replay, idempotentReplay: true };
      }
      // 23505: partial unique (space_id, path) WHERE deleted_at IS NULL
      // 并发 move 同 target → catch 后重查占用方，幂等返回 409 + conflictDocId
      // （复用 upsert 23505 catch 先例语义——并发败者永远拿到明确冲突而非 500）
      if (pgErr.code === '23505' && pgErr.constraint && pgErr.constraint.includes('path')) {
        const winner = await this.docRepo
          .createQueryBuilder('d')
          .select('d.id')
          .where('d.space_id = :spaceId', { spaceId: doc.spaceId })
          .andWhere('d.path = :path', { path: dto.toPath })
          .andWhere('d.deleted_at IS NULL')
          .getOne();
        throw new ConflictException({
          message: `Target path '${dto.toPath}' is already taken by another document (concurrent move)`,
          code: ErrorCode.RESOURCE_CONFLICT,
          data: { conflictDocId: winner?.id ?? docId },
        });
      }
      throw err;
    }

    // ── 事务后：audit → 事件 → 异步 linkHealth 重算 ──────────────────
    if (actor) {
      const auditEntry = this.auditRepo.create({
        action: AuditAction.MOVE_DOC,
        entityType: AUDIT_ENTITY_TYPE.DOC,
        entityId: docId,
        actorId: actor.id,
        newData: { oldPath: doc.path, newPath: movedDoc.path, title: doc.title },
        source: 'api',
      });
      await this.auditRepo.save(auditEntry);
    }

    // DOC_MOVED 事件：topicId/boardId 必须经 getSpaceEventContext 从空间绑定派生
    // （与 DOC_CREATED/UPDATED/DELETED 同路径——否则在 B-51 SSE actor 过滤下，
    // 绑 board 空间的成员收不到该事件，可见性语义与其他 doc 事件分裂）
    // eventCtx 局部改名避免与幂等 ctx 混淆
    const eventCtx = await this.docService.getSpaceEventContext(doc.spaceId);
    await this.eventService.create({
      eventType: EventType.DOC_MOVED,
      resourceType: ResourceType.DOC,
      resourceId: docId,
      actorId: actor?.id ?? undefined,
      topicId: eventCtx.topicId ?? undefined,
      boardId: eventCtx.boardId ?? undefined,
      payload: {
        spaceId: doc.spaceId,
        docId,
        oldPath: doc.path,
        newPath: movedDoc.path,
        title: doc.title,
      },
    });

    // 异步 fire-and-forget：全空间 linkHealth 重算（旧 path 入链即刻变断链可见）。
    // route recheck 不触发——sections 未动，headingPath 不会悬空；失败仅记日志不透出
    const spaceId = doc.spaceId;
    setImmediate(() => {
      this.docService.recalcSpaceLinkHealth(spaceId).catch((err: unknown) => {
        this.logger.error(`recalcSpaceLinkHealth failed for space ${spaceId}`, err);
      });
    });

    return {
      docId: movedDoc.id,
      oldPath: doc.path,
      newPath: movedDoc.path,
      contentHash: movedDoc.contentHash,
      moved: true,
      impact,
    };
  }
}
