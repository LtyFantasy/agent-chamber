/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 全空间「入链反扫」内核（backlinks）：扫全空间未删文档正文的
 *     Markdown 链接，反向匹配指向目标文档的入链；并派生人类消费面的分组视图
 *
 * [代码职责]
 *   - `scanInboundLinks(doc)` = 唯一反扫实现（move-impact / move dryRun / move
 *     响应摘要 / GET /docs/:id/backlinks 四处共用同一份），返回扁平入链清单
 *     + 空间候选集（供 outbound 复用，避免二次全空间查询）
 *   - `getBacklinks(doc)` = 人类消费面组装：滤自引用 → 按来源文档分组 → 确定性排序
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/api-definition.md` §16.21（GET /docs/:id/backlinks）
 *     与 §16.17（GET /docs/:id/move-impact，扁平入链面）
 *   - 补充: 线上 `docs/architecture.md` §3.2.10（DocSpace Module）
 *   - 补充: `.agents/skills/agent-chamber/...` 无关；前端消费面见
 *     apps/web/src/components/docs/doc-backlinks-card.tsx
 *
 * [关键不变量]
 *   - 匹配规则**单源**于 link-health.ts（extractDocLinks / resolveHrefToDocPath /
 *     matchDocReferenceLink）——禁止在本文件另写一套路径解析或平台链接正则
 *   - 去重契约：(sourceDocId, href) 唯一；section 定位 = 该 href **首个命中** section
 *     的 position/headingPath
 *   - 输入同源：reconstructContent(sections, skipDuplicateTitle=false) —— 与
 *     recalcSpaceLinkHealth 完全同源，保证反扫结果与 linkHealth 数据语义一致
 *   - **候选集 ORDER BY d.path ASC, d.id ASC**：文档顺序决定 inboundLinks 数组顺序。
 *     PG 无 ORDER BY 时返回顺序任意 → 契约不可复现；本 ORDER BY 使
 *     move-impact.inboundLinks / pathBasedLinksToRewrite 的顺序**从任意变确定**
 *     （可观测契约变化，勿删）。sections 的 position 排序同理（组内位置定位依赖它）
 *   - **内核中性**：本 service 的 scanInboundLinks 不过滤自引用（源=目标自身）；
 *     过滤属消费面策略（backlinks 滤、move-impact 保留），不得下沉进内核
 *
 * [关联代码]
 *   - ./link-health.ts — 匹配规则与严格 POSIX 源目录解析单点实现
 *   - ./doc-move.service.ts — move 校验链 / dryRun 消费内核（签名放宽接纳 SpaceDocCandidate）
 *   - ./doc.service.ts — reconstructContent（入链反扫与 linkHealth 的同一内容源）
 *   - test/docspace-backlinks.e2e-spec.ts — 真 PG + HTTP 双真套件（含与 move-impact 的等价性护栏）
 *
 * [持久踩坑]
 *   - DOC-LINKS-N1（性能）：逐篇查 sections 是 N+1（原 doc-move.service 内核形态）；
 *     必须一次 `WHERE doc_id IN (...)` 批量拉取后按 docId 在内存归组
 *     （先例 doc.service.ts recalcSpaceLinkHealth），否则 262-doc 空间秒级退化
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #22(findOne必须判空) #23(ORM/jsonb 集成覆盖)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [权威文档] 确认修改符合设计意图
 *   □ 已核对 [关键不变量]（尤其 ORDER BY 与内核中性）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { DocBacklinks, DocBacklinksSource, DocInboundLink } from '@agent-chamber/shared';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocService } from './doc.service';
import { extractDocLinks, resolveHrefToDocPath, matchDocReferenceLink } from './link-health';

/**
 * 空间内未删文档的最小候选投影（id + path + title）
 *
 * 为什么不是完整 `Doc` 实体：入链反扫只需三列（title 供 reconstructContent 插回
 * 首标题行），outbound 失效面只需 path/id。用窄类型表达「候选集消费方不得依赖
 * 其他列」，避免 `as Doc` 强转把实体不变量带进只读内核（plan ADR 明令禁止强转）。
 */
export interface SpaceDocCandidate {
  /** 文档 ID */
  id: string;
  /** 空间内唯一 path（严格 POSIX 源目录解析的比对基准） */
  path: string;
  /** 文档标题（reconstructContent 的 position 0 首标题去重/插回基准） */
  title: string;
}

/** 入链反扫结果（扁平入链清单 + 空间候选集，候选集供 outbound 复用） */
export interface InboundScanResult {
  /** 指向目标文档的入链（按 (sourceDocId, href) 去重；候选集 path 序即数组序） */
  inboundLinks: DocInboundLink[];
  /** 空间全部未删文档候选（ORDER BY path ASC, id ASC；move-impact 的 outbound 复用） */
  docs: SpaceDocCandidate[];
}

/** 入链 section 定位（该 href 首个命中 section 的 position/headingPath） */
interface HrefSectionLocator {
  position: number;
  headingPath: string | null;
}

/**
 * DocSpace 全空间链接反扫服务（v1.90.0-dev，backlinks 批次）
 *
 * 定位：`DocMoveService.computeMoveImpact` 的入链内核**抽取**至此，成为「全空间
 * 链接反扫」的家——doc-move 保留为「文档移动唯一写通道」的职责（只读内核寄生其中
 * 会让其注释与职责漂移）。
 *
 * 两个消费面（有意不合并，语义见 DocBacklinks DTO 注释）：
 * - move-impact（扁平 inboundLinks，含自引用，供迁移方改写清单）；
 * - GET /docs/:id/backlinks（按来源分组的 backlinks，滤自引用，供人类阅读）。
 *
 * 性能：候选集 1 次查询 + sections 1 次 `IN (...)` 批量查询（N+1 消除，见
 * [持久踩坑] DOC-LINKS-N1）；不做服务端缓存（无缓存基础设施，需独立 ADR）。
 */
@Injectable()
export class DocLinksService {
  constructor(
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    @InjectRepository(DocSection)
    private readonly sectionRepo: Repository<DocSection>,
    // 重建正文（reconstructContent）与 recalcSpaceLinkHealth 同源复用；
    // 反向依赖不存在（DocService 不注入本 service），故无需 forwardRef
    private readonly docService: DocService,
  ) {}

  /**
   * 【内核】全空间入链反扫：找出所有指向 `doc` 的 Markdown 链接。
   *
   * 步骤（顺序即语义）：
   * ① 空间候选集（id/path/title，`ORDER BY d.path ASC, d.id ASC`）——顺序决定
   *    inboundLinks 数组序，是契约的一部分；
   * ② sections 一次 `WHERE doc_id IN (...)` 批量拉取（`ORDER BY s.position ASC`，
   *    组内位置序即 section 定位序），内存按 docId 归组；
   * ③ 逐篇 reconstructContent（skipDuplicateTitle=false，与 linkHealth 输入同源）
   *    → extractDocLinks 提取 href → 反向匹配目标 doc；
   * ④ 去重 (sourceDocId, href)，section 定位取该 href 首个命中 section。
   *
   * 匹配规则（单源于 link-health.ts，禁止在此另写）：
   * - `?doc=` 平台规范链接：按 docId 比对，`isPathBased=false`（不受 path 变更影响）；
   * - 相对 .md path 链接：`resolveHrefToDocPath(href, sourceDoc.path)` 严格源目录
   *   解析后与 `doc.path` 等值比对，`isPathBased=true`。
   *
   * 中性契约：**不过滤自引用**（源 = 目标）。过滤是消费面策略，见 getBacklinks。
   *
   * @param doc - 目标文档（须未软删，由调用方 findById 保证）
   * @returns 入链清单（扁平、去重、首命中 section 定位）+ 空间候选集
   */
  async scanInboundLinks(doc: Doc): Promise<InboundScanResult> {
    // ① 空间全部未删文档候选（path 序 + id 序：确定性契约，勿删 ORDER BY）
    const docs = await this.docRepo
      .createQueryBuilder('d')
      .select(['d.id', 'd.path', 'd.title'])
      .where('d.space_id = :spaceId', { spaceId: doc.spaceId })
      .andWhere('d.deleted_at IS NULL')
      .orderBy('d.path', 'ASC')
      .addOrderBy('d.id', 'ASC')
      .getMany();

    if (docs.length === 0) return { inboundLinks: [], docs: [] };

    // ② sections 批量拉取（一次 IN 替代逐篇 N+1；position 序保证组内定位序）
    const sections = await this.sectionRepo
      .createQueryBuilder('s')
      .select([
        's.docId',
        's.content',
        's.headingLevel',
        's.headingPath',
        's.headingText',
        's.isContinuation',
        's.position',
      ])
      .where('s.doc_id IN (:...ids)', { ids: docs.map((d) => d.id) })
      .orderBy('s.position', 'ASC')
      .getMany();

    // 内存按 docId 归组：全局 position 序在按 docId 过滤后仍是篇内 position 序
    const sectionsByDoc = new Map<string, DocSection[]>();
    for (const s of sections) {
      const list = sectionsByDoc.get(s.docId) ?? [];
      list.push(s);
      sectionsByDoc.set(s.docId, list);
    }

    // ③④ 逐篇反扫：重建正文 → 提取 href → 反向匹配 → 去重 + section 定位
    const inboundLinks: DocInboundLink[] = [];
    const seen = new Set<string>(); // 去重键 (sourceDocId, href)

    for (const sourceDoc of docs) {
      const docSections = sectionsByDoc.get(sourceDoc.id) ?? [];
      const content = this.docService.reconstructContent(sourceDoc, docSections, false);
      const hrefs = extractDocLinks(content);
      if (hrefs.length === 0) continue;

      const hrefSection = this.buildHrefSectionIndex(docSections);

      for (const href of hrefs) {
        const key = `${sourceDoc.id}|${href}`;
        if (seen.has(key)) continue;

        const isPathBased = this.matchesTarget(href, sourceDoc.path, doc);
        if (isPathBased === null) continue;

        seen.add(key);
        const section = hrefSection.get(href);
        inboundLinks.push({
          sourceDocId: sourceDoc.id,
          sourcePath: sourceDoc.path,
          sourceTitle: sourceDoc.title,
          href,
          isPathBased,
          ...(section
            ? { sectionPosition: section.position, headingPath: section.headingPath }
            : {}),
        });
      }
    }

    return { inboundLinks, docs };
  }

  /**
   * 【人类消费面】组装 backlinks 视图：滤自引用 → 按来源文档分组 → 确定性排序。
   *
   * 顺序契约（前端首屏取前 5 组依赖它，两次请求数组必须全等）：
   * - sources 按 `sourcePath` 升序（同 path 不可能出现——path 空间内唯一）；
   * - 组内 links 按 `sectionPosition` 升序、缺省（无 section 定位）排最后；
   *   同位次按 href 升序补齐**全序**（契约只钉 position 序，href 尾序是确定性加固）。
   *
   * @param doc - 目标文档（须未软删，由调用方 findById 保证）
   * @returns DocBacklinks（docCount 去重后的来源篇数；linkCount 逐处计数）
   */
  async getBacklinks(doc: Doc): Promise<DocBacklinks> {
    const { inboundLinks } = await this.scanInboundLinks(doc);

    // 滤自引用：对「谁引用我」是噪音，且点击后停在原地（move-impact 保留不过滤）
    const external = inboundLinks.filter((link) => link.sourceDocId !== doc.id);

    const grouped = new Map<string, DocBacklinksSource>();
    for (const link of external) {
      const group = grouped.get(link.sourceDocId);
      const { sourceDocId, sourcePath, sourceTitle, ...rest } = link;
      if (group) {
        group.links.push(rest);
      } else {
        grouped.set(sourceDocId, { sourceDocId, sourcePath, sourceTitle, links: [rest] });
      }
    }

    const sources = [...grouped.values()]
      .sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0))
      .map((source) => ({ ...source, links: [...source.links].sort(compareBacklinkEntry) }));

    return {
      docId: doc.id,
      path: doc.path,
      docCount: sources.length,
      linkCount: sources.reduce((sum, source) => sum + source.links.length, 0),
      sources,
    };
  }

  /**
   * 建立 href → 首个命中 section 的索引（与出链面同口径的 section 定位）。
   *
   * 同一 section 可链多个 href；同一 href 多处出现只记首个命中（position 序已由
   * 查询 ORDER BY 保证），故 `has` 判定即「首命中」。
   *
   * @param docSections - 单篇有序 sections（position ASC）
   * @returns href → { position, headingPath }
   */
  private buildHrefSectionIndex(docSections: DocSection[]): Map<string, HrefSectionLocator> {
    const index = new Map<string, HrefSectionLocator>();
    for (const s of docSections) {
      for (const h of extractDocLinks(s.content)) {
        if (!index.has(h)) {
          index.set(h, { position: s.position, headingPath: s.headingPath });
        }
      }
    }
    return index;
  }

  /**
   * 判定单个 href 是否指向目标文档。
   *
   * @param href - 原文 href（未归一化）
   * @param sourcePath - 承载该链接的文档 path（严格源目录解析基准）
   * @param doc - 目标文档（按 docId 或 path 比对）
   * @returns `true` = 命中且为相对 .md path 链接；`false` = 命中且为平台 ?doc= 链接；
   *   `null` = 不命中 / 不参与判定（非 .md、越界解析、指向他文档）
   */
  private matchesTarget(href: string, sourcePath: string, doc: Doc): boolean | null {
    const refDocId = matchDocReferenceLink(href);
    if (refDocId) {
      // ?doc= 平台规范链接：按 docId 比对（move 不改 docId → 不受影响）
      return refDocId === doc.id ? false : null;
    }
    // 相对 .md path 链接：严格源目录解析后与目标当前 path 等值比对
    // （v1.61.0 语义：sourcePath 精确解析，无 docs/ 前缀补全候选）
    const resolved = resolveHrefToDocPath(href, sourcePath);
    if (resolved === null) return null;
    return resolved === doc.path ? true : null;
  }
}

/**
 * 组内入链全序比较器：sectionPosition 升序、缺省最后，同位次按 href 升序。
 *
 * rationale：DTO 只钉 position 序；同位次（同 section 内多 href）若无尾序，
 * 数组序取决于正文出现顺序——虽确定但脆弱（契约方无从复现）。href 尾序把全序
 * 收敛成可复现契约（e2e「两次请求数组全等」断言据此成立）。
 *
 * @param a - 比较左项（组内 link，已剔除组级三键）
 * @param b - 比较右项
 * @returns 负 = a 在前；正 = b 在前；0 = 完全等价
 */
function compareBacklinkEntry(
  a: DocBacklinksSource['links'][number],
  b: DocBacklinksSource['links'][number],
): number {
  const pa = a.sectionPosition ?? Number.POSITIVE_INFINITY;
  const pb = b.sectionPosition ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  return a.href < b.href ? -1 : a.href > b.href ? 1 : 0;
}
