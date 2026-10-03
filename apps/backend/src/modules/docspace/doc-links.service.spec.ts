/**
 * doc-links.service.ts 单元测试（v1.90.0-dev backlinks 批次）
 *
 * 覆盖（铁律 #17 测试契约）：
 * - scanInboundLinks（内核）：双匹配（?doc= 平台链接 / 相对 .md 严格源解析）、
 *   (sourceDocId, href) 去重、section 定位取首命中、**自引用保留**（内核中性）
 * - 调用图 / 确定性契约：候选集恰一次查询且带 `ORDER BY path ASC, id ASC` +
 *   `deleted_at IS NULL`（软删排除）；sections 恰一次**批量 IN** 查询（N+1 消除，
 *   DOC-LINKS-N1 的守卫——旧逐篇实现会在本断言下变成 N 次）
 * - getBacklinks（人类消费面）：滤自引用、按 sourceDocId 分组、docCount/linkCount
 *   双口径、sources 按 sourcePath 升序、组内按 sectionPosition 升序（null 最后、
 *   href 尾巴序）
 *
 * 与 docspace-backlinks.e2e-spec.ts 的分工：本套件是 mock 级（调用图/契约形状），
 * 真 PG 上的 SQL 顺序与 HTTP 等价性护栏由 e2e 钉住（铁律 #23）。
 */

import { SelectQueryBuilder } from 'typeorm';
import { DocLinksService } from './doc-links.service';
import type { SpaceDocCandidate } from './doc-links.service';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocService } from './doc.service';
import type { Repository } from 'typeorm';

describe('DocLinksService', () => {
  let service: DocLinksService;
  let docRepo: { createQueryBuilder: jest.Mock };
  let sectionRepo: { createQueryBuilder: jest.Mock };
  let docService: { reconstructContent: jest.Mock };
  /** 最近一次候选集查询的 QB（断言 ORDER BY / 软删条件） */
  let candidateQb: Record<string, jest.Mock>;
  /** 最近一次 sections 查询的 QB（断言批量 IN） */
  let sectionQb: Record<string, jest.Mock>;
  /** sections 查询次数（N+1 守卫：入链反扫恒为 1） */
  let sectionQueryCount: number;

  /** 目标文档 id —— 必须**UUID 形态**：`?doc=` 平台链接正则认 36 位十六进制 UUID，
   *  用 'doc-target' 这类字面量会让平台链接分支静默不命中（本套件踩过） */
  const TARGET_ID = '11111111-1111-4111-8111-111111111111';
  /** 空间内另一篇文档 id（「指向他文档」的 ?doc= 分支用，同为 UUID 形态） */
  const OTHER_ID = '33333333-3333-4333-8333-333333333333';

  const target = makeDoc({ id: TARGET_ID, path: 'docs/target.md', title: 'Target' });

  function makeDoc(overrides: Partial<Doc> = {}): Doc {
    return {
      id: 'doc-x',
      spaceId: 'space-1',
      path: 'docs/x.md',
      title: 'X',
      ...overrides,
    } as Doc;
  }

  function makeSection(overrides: Partial<DocSection> = {}): DocSection {
    return {
      id: 'sec-x',
      docId: 'doc-x',
      position: 0,
      headingPath: 'H',
      headingText: 'H',
      headingLevel: 1,
      isContinuation: false,
      content: '',
      ...overrides,
    } as DocSection;
  }

  function makeQb(overrides: Record<string, unknown> = {}): Record<string, jest.Mock> {
    return {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      ...overrides,
    } as unknown as Record<string, jest.Mock>;
  }

  /**
   * 安排空间候选集 + 批量 sections + 正文（按 doc.id 索引）。
   *
   * @param candidates - 候选集（模拟 SQL `ORDER BY path ASC, id ASC` 的结果，故调用方
   *   应按 path 升序给出——内核按该顺序迭代，入链数组序因此确定）
   * @param entries - 每篇的 sections 与重建正文（缺省 = 无 sections / 空正文）
   */
  function arrange(
    candidates: SpaceDocCandidate[],
    entries: Array<{ docId: string; sections?: DocSection[]; content?: string }> = [],
  ): void {
    candidateQb = makeQb({ getMany: jest.fn().mockResolvedValue(candidates) });
    docRepo.createQueryBuilder = jest.fn(() => candidateQb);
    const contentByDocId = new Map(entries.map((e) => [e.docId, e.content ?? '']));
    const sectionsByDocId = new Map(entries.map((e) => [e.docId, e.sections ?? []]));
    // 批量 IN：一次返回全空间平铺 sections（position 升序 = SQL ORDER BY 语义）
    const batch = candidates
      .flatMap((c) => sectionsByDocId.get(c.id) ?? [])
      .sort((a, b) => a.position - b.position);
    sectionQueryCount = 0;
    sectionQb = makeQb({ getMany: jest.fn().mockResolvedValue(batch) });
    sectionRepo.createQueryBuilder = jest.fn(() => {
      sectionQueryCount++;
      return sectionQb;
    });
    docService.reconstructContent.mockImplementation((doc: { id: string }) =>
      contentByDocId.get(doc.id) ?? '',
    );
  }

  beforeEach(() => {
    docRepo = { createQueryBuilder: jest.fn() };
    sectionRepo = { createQueryBuilder: jest.fn() };
    docService = { reconstructContent: jest.fn() };
    service = new DocLinksService(
      docRepo as unknown as Repository<Doc>,
      sectionRepo as unknown as Repository<DocSection>,
      docService as unknown as DocService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // ─── scanInboundLinks：内核 ──────────────────────────────────────────

  describe('scanInboundLinks', () => {
    it('双匹配：?doc= 平台链接（isPathBased=false）与相对 .md 链接（isPathBased=true）', async () => {
      const srcA = makeDoc({ id: 'doc-a', path: 'docs/a.md', title: 'A' });
      const srcB = makeDoc({ id: 'doc-b', path: 'docs/b.md', title: 'B' });
      arrange(
        [srcA, srcB, target],
        [
          { docId: 'doc-a', content: `见 [t](/docs/space-1?doc=${target.id})` },
          {
            docId: 'doc-b',
            sections: [
              makeSection({
                docId: 'doc-b',
                position: 1,
                headingPath: 'B § 引用',
                content: '见 [t](./target.md)',
              }),
            ],
            content: '见 [t](./target.md)',
          },
        ],
      );

      const { inboundLinks, docs } = await service.scanInboundLinks(target);

      expect(inboundLinks).toHaveLength(2);
      expect(inboundLinks[0]).toMatchObject({
        sourceDocId: 'doc-a',
        sourcePath: 'docs/a.md',
        sourceTitle: 'A',
        isPathBased: false,
      });
      expect(inboundLinks[1]).toMatchObject({
        sourceDocId: 'doc-b',
        isPathBased: true,
        sectionPosition: 1,
        headingPath: 'B § 引用',
      });
      // 候选集原样返回（outbound 复用，避免二次全空间查询）
      expect(docs).toHaveLength(3);
    });

    it('去重：同篇同一 href 多处出现只记一条，section 定位取首命中', async () => {
      const src = makeDoc({ id: 'doc-a', path: 'docs/a.md', title: 'A' });
      arrange(
        [src],
        [
          {
            docId: 'doc-a',
            sections: [
              makeSection({ docId: 'doc-a', position: 0, headingPath: 'A', content: '[t](target.md)' }),
              makeSection({ docId: 'doc-a', position: 2, headingPath: 'A § 尾', content: '[t](target.md)' }),
            ],
            content: '[t](target.md) 与 [t](target.md)',
          },
        ],
      );

      const { inboundLinks } = await service.scanInboundLinks(target);

      expect(inboundLinks).toHaveLength(1);
      expect(inboundLinks[0]).toMatchObject({ href: 'target.md', sectionPosition: 0 });
    });

    it('自引用保留（内核中性——过滤是消费面策略，见 getBacklinks）', async () => {
      arrange([target], [{ docId: target.id, content: '[self](./target.md)' }]);

      const { inboundLinks } = await service.scanInboundLinks(target);

      expect(inboundLinks).toHaveLength(1);
      expect(inboundLinks[0]).toMatchObject({ sourceDocId: target.id, href: './target.md' });
    });

    it('不命中：指向他文档的链接（.md 与 ?doc= 双路）、非 .md、越界解析', async () => {
      const src = makeDoc({ id: 'doc-a', path: 'docs/a.md', title: 'A' });
      arrange(
        [src],
        [
          {
            docId: 'doc-a',
            content:
              `见 [o](./other.md) 与 [p](/docs/space-1?doc=${OTHER_ID}) 与 [n](note.txt) 与 [up](../../target.md)`,
          },
        ],
      );

      const { inboundLinks } = await service.scanInboundLinks(target);
      expect(inboundLinks).toEqual([]);
    });

    it('空空间：候选集为空时提前返回（不再查 sections）', async () => {
      arrange([]);
      const { inboundLinks, docs } = await service.scanInboundLinks(target);
      expect(inboundLinks).toEqual([]);
      expect(docs).toEqual([]);
      expect(sectionQueryCount).toBe(0);
    });

    it('候选集查询契约：恰一次 + ORDER BY path ASC, id ASC + 软删排除', async () => {
      arrange([target]);
      await service.scanInboundLinks(target);

      expect(docRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(candidateQb.andWhere).toHaveBeenCalledWith('d.deleted_at IS NULL');
      // 确定性契约：无 ORDER BY 时 PG 返回顺序任意 → inboundLinks 数组序不可复现
      expect(candidateQb.orderBy).toHaveBeenCalledWith('d.path', 'ASC');
      expect(candidateQb.addOrderBy).toHaveBeenCalledWith('d.id', 'ASC');
    });

    it('sections 恰一次批量 IN 查询（N+1 消除守卫）', async () => {
      const srcA = makeDoc({ id: 'doc-a', path: 'docs/a.md', title: 'A' });
      const srcB = makeDoc({ id: 'doc-b', path: 'docs/b.md', title: 'B' });
      arrange(
        [srcA, srcB, target],
        [
          { docId: 'doc-a', content: '[t](target.md)' },
          { docId: 'doc-b', content: '[t](./target.md)' },
        ],
      );

      const { inboundLinks } = await service.scanInboundLinks(target);

      // 3 篇文档 → 单次查询（旧逐篇实现为 3 次，本断言即回归守卫）
      expect(sectionQueryCount).toBe(1);
      expect(sectionQb.where).toHaveBeenCalledWith('s.doc_id IN (:...ids)', {
        ids: ['doc-a', 'doc-b', TARGET_ID],
      });
      expect(sectionQb.orderBy).toHaveBeenCalledWith('s.position', 'ASC');
      expect(inboundLinks).toHaveLength(2);
    });

    it('入链数组序跟随候选集序（path 升序 = 契约序）', async () => {
      const srcB = makeDoc({ id: 'doc-b', path: 'docs/b.md', title: 'B' });
      const srcA = makeDoc({ id: 'doc-a', path: 'docs/a.md', title: 'A' });
      // 模拟 SQL 输出：path 升序（a 在前）
      arrange(
        [srcA, srcB],
        [
          { docId: 'doc-a', content: '[t](target.md)' },
          { docId: 'doc-b', content: '[t](../docs/target.md)' },
        ],
      );

      const { inboundLinks } = await service.scanInboundLinks(target);
      expect(inboundLinks.map((l) => l.sourcePath)).toEqual(['docs/a.md', 'docs/b.md']);
    });
  });

  // ─── getBacklinks：人类消费面 ────────────────────────────────────────

  describe('getBacklinks', () => {
    it('滤自引用 + 按来源分组：docCount=篇数、linkCount=处数（同源多 href 时大于 docCount）', async () => {
      const srcA = makeDoc({ id: 'doc-a', path: 'docs/a.md', title: 'A' });
      const srcB = makeDoc({ id: 'doc-b', path: 'docs/b.md', title: 'B' });
      arrange(
        [srcA, srcB, target],
        [
          {
            docId: 'doc-a',
            content: `[t](target.md) 与 [p](/docs/space-1?doc=${TARGET_ID})`,
          },
          { docId: 'doc-b', content: '[t](./target.md)' },
          // 自引用：不进 backlinks（但内核保留，见 scanInboundLinks 用例）
          { docId: target.id, content: '[self](./target.md)' },
        ],
      );

      const view = await service.getBacklinks(target);

      expect(view).toMatchObject({ docId: TARGET_ID, path: 'docs/target.md' });
      expect(view.docCount).toBe(2);
      expect(view.linkCount).toBe(3);
      expect(view.sources.map((s) => s.sourceDocId)).toEqual(['doc-a', 'doc-b']);
      // Omit 契约：组级三键在组上，组内 link 不带三键
      expect(view.sources[0]).toMatchObject({
        sourcePath: 'docs/a.md',
        sourceTitle: 'A',
      });
      expect(view.sources[0].links).toHaveLength(2);
      expect(view.sources[0].links[0]).not.toHaveProperty('sourceDocId');
      // doc-a 无 sections → 两条都无 sectionPosition → 按 href 升序（'/' < 't'）：
      // 平台链接在前、相对 .md 在后（href 尾序即确定性加固的体现）
      expect(view.sources[0].links[0]).toMatchObject({
        href: `/docs/space-1?doc=${TARGET_ID}`,
        isPathBased: false,
      });
      expect(view.sources[0].links[1]).toMatchObject({ href: 'target.md', isPathBased: true });
    });

    it('sources 按 sourcePath 升序（与候选集序解耦，显式排序）', async () => {
      const srcA = makeDoc({ id: 'doc-a', path: 'docs/a.md', title: 'A' });
      const srcZ = makeDoc({ id: 'doc-z', path: 'docs/z.md', title: 'Z' });
      // 候选集给出 z 在前（非 path 序），消费面仍须按 sourcePath 升序输出
      arrange(
        [srcZ, srcA],
        [
          { docId: 'doc-z', content: '[t](target.md)' },
          { docId: 'doc-a', content: '[t](target.md)' },
        ],
      );

      const view = await service.getBacklinks(target);
      expect(view.sources.map((s) => s.sourcePath)).toEqual(['docs/a.md', 'docs/z.md']);
    });

    it('组内 links 按 sectionPosition 升序、无定位（null）排最后', async () => {
      const src = makeDoc({ id: 'doc-a', path: 'docs/a.md', title: 'A' });
      arrange(
        [src],
        [
          {
            docId: 'doc-a',
            sections: [
              makeSection({ docId: 'doc-a', position: 0, headingPath: 'A', content: `[p](/docs/space-1?doc=${TARGET_ID})` }),
              makeSection({ docId: 'doc-a', position: 3, headingPath: 'A § 尾', content: '[t](target.md)' }),
            ],
            // 文首命中（position 0，有 section）→ 排第一；?doc= 无 section 定位的形态
            // 由下方 noSection 用例单独覆盖
            content: `[t](target.md) 与 [p](/docs/space-1?doc=${TARGET_ID})`,
          },
        ],
      );

      const view = await service.getBacklinks(target);
      const positions = view.sources[0].links.map((l) => l.sectionPosition);

      expect(positions).toEqual([0, 3]);
    });

    it('无 section 定位的入链排在最后（sectionPosition 缺省）+ href 尾序保证全序', async () => {
      const src = makeDoc({ id: 'doc-a', path: 'docs/a.md', title: 'A' });
      arrange(
        [src],
        [
          {
            docId: 'doc-a',
            // sections 为空 → hrefSection 索引为空 → 全部无定位；# 锚点剥离后仍命中
            content: '[b](target.md) 与 [a](target.md#anchor)',
          },
        ],
      );

      const view = await service.getBacklinks(target);
      expect(view.sources[0].links.map((l) => l.href)).toEqual(['target.md', 'target.md#anchor']);
      expect(view.sources[0].links.every((l) => l.sectionPosition === undefined)).toBe(true);
    });

    it('空结果：无入链（或仅自引用）→ sources 空、双计数为 0', async () => {
      arrange([target], [{ docId: target.id, content: '[self](./target.md)' }]);

      const view = await service.getBacklinks(target);
      expect(view).toEqual({
        docId: TARGET_ID,
        path: 'docs/target.md',
        docCount: 0,
        linkCount: 0,
        sources: [],
      });
    });
  });
});
