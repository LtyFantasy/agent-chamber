/**
 * doc-move.service.ts 单元测试
 *
 * 覆盖（铁律 #17 测试契约）：
 * - computeMoveImpact：入链反扫（path 命中 / ?doc= 命中 / 非命中 / docs/ 前缀补全 /
 *   (sourceDocId, href) 去重 / section 定位取首命中）、路由引用（primary/secondary/
 *   双角色）、taskLinks、targetCollision、samePath、pathBasedLinksToRewrite 子集
 * - move 校验链全分支：404 → source mismatch → samePath → hash 事务外快速失败 →
 *   collision → dryRun 不落库 → happy（事务 FOR UPDATE + audit + DOC_MOVED 事件 +
 *   recalc setImmediate）→ 事务内 hash 复核（TOCTOU）→ 23505 幂等 catch
 *
 * 与 doc.service.spec.ts 同款 mock 风格：repo.createQueryBuilder 返回链式 fake QB，
 * 返回值按断言场景显式安排；extractDocLinks / resolveHrefToDocPath /
 * matchDocReferenceLink 走真实现（纯函数），DocService.reconstructContent mock。
 */

import { SelectQueryBuilder, Repository } from 'typeorm';
import { DocMoveService } from './doc-move.service';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { DocService } from './doc.service';
import { EventService } from '../event/event.service';
import { ErrorCode, AuditAction, ActorType, EventType } from '@agent-chamber/shared';
import { NotFoundException, ConflictException } from '@nestjs/common';

describe('DocMoveService', () => {
  let service: DocMoveService;
  let docRepo: jest.Mocked<Partial<Repository<Doc>>>;
  let sectionRepo: jest.Mocked<Partial<Repository<DocSection>>>;
  let routeRepo: jest.Mocked<Partial<Repository<DocRoute>>>;
  let taskDocLinkRepo: jest.Mocked<Partial<Repository<TaskDocLink>>>;
  let auditRepo: { create: jest.Mock; save: jest.Mock };
  // v1.63.0 幂等 repo mock：本套件不测幂等路径（e2e 覆盖），仅防构造参数缺失
  let idempotencyRepo: { findOne: jest.Mock; save: jest.Mock };
  let docService: {
    findById: jest.Mock;
    reconstructContent: jest.Mock;
    getSpaceEventContext: jest.Mock;
    recalcSpaceLinkHealth: jest.Mock;
  };
  let eventService: { create: jest.Mock };
  let mockTransaction: jest.Mock;

  /** 冲刷 setImmediate 队列：让 move 里 fire-and-forget 的 recalc 先于本回调执行 */
  const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

  function makeDoc(overrides: Partial<Doc> = {}): Doc {
    return {
      id: 'aaaaaaaa-0000-0000-0000-0000000000aa',
      spaceId: 'space-1',
      categoryId: null,
      path: 'docs/target.md',
      title: 'Target Doc',
      summary: null,
      docType: null,
      tags: [],
      source: 'native',
      contentHash: 'hash-target',
      sourceSha: null,
      sectionCount: 1,
      tokenEstimate: 100,
      linkHealth: null,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    } as Doc;
  }

  function makeSection(overrides: Partial<DocSection> = {}): DocSection {
    return {
      id: 'sec-x',
      docId: 'doc-src',
      position: 0,
      headingPath: 'Src',
      headingText: 'Src',
      headingLevel: 1,
      isContinuation: false,
      content: '',
      tokenEstimate: 10,
      searchVector: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as DocSection;
  }

  function makeQb(overrides: Record<string, unknown> = {}) {
    return {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
      getRawMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
      ...overrides,
    } as unknown as SelectQueryBuilder<any>;
  }

  beforeEach(() => {
    // 事务 mock：manager.transaction 固定挂载，实现可经 mockImplementation 替换
    // （doc.service.spec.ts 同款——Repository.manager 是 readonly 属性，禁止重新赋值）
    mockTransaction = jest.fn((fn: (manager: unknown) => unknown) =>
      fn({
        getRepository: jest.fn((entity: unknown) => {
          if (entity === Doc) {
            return {
              createQueryBuilder: jest.fn(() => makeQb()),
            };
          }
          return { createQueryBuilder: jest.fn(() => makeQb()) };
        }),
      }),
    );

    docRepo = { createQueryBuilder: jest.fn(), manager: { transaction: mockTransaction } } as never;
    sectionRepo = { createQueryBuilder: jest.fn() };
    routeRepo = { createQueryBuilder: jest.fn() };
    taskDocLinkRepo = { createQueryBuilder: jest.fn() };
    auditRepo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    idempotencyRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    docService = {
      findById: jest.fn(),
      reconstructContent: jest.fn(),
      getSpaceEventContext: jest.fn().mockResolvedValue({ topicId: 'topic-1', boardId: 'board-1' }),
      recalcSpaceLinkHealth: jest.fn().mockResolvedValue(undefined),
    };
    eventService = { create: jest.fn().mockResolvedValue({}) };

    service = new DocMoveService(
      docRepo as never,
      sectionRepo as never,
      routeRepo as never,
      taskDocLinkRepo as never,
      auditRepo as never,
      idempotencyRepo as never,
      docService as unknown as DocService,
      eventService as unknown as EventService,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // ─── computeMoveImpact：入链反扫 ────────────────────────────────────

  describe('computeMoveImpact', () => {
    const target = makeDoc();

    /** 安排空间文档列表 + 每篇的 sections/content（reconstructContent mock 为第二参）
     *  outbound（proposedPath 非空）会额外查一次被移文档自身的 sections——queue 尾部
     *  追加该文档的 sections 备份供其消费（循环入链反扫只消耗前 docs.length 个）。
     *  默认追加外层 target 的 sections；outbound 场景被移文档非外层 target 时
     *  必须显式传 outboundDoc（如 outbound 用例的 subTarget——闭包捕获的是
     *  定义作用域的 target，shadow 后按 id 匹配会落空） */
    function arrangeSpaceDocs(
      docs: Doc[],
      sectionContent: Array<{ doc: Doc; sections: DocSection[]; content: string }>,
      outboundDoc?: Doc,
    ) {
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue(docs) }),
      );
      // sections 队列按 docs 顺序（未提供内容的文档 = 空 sections），防止 queue 错位
      const outboundSections = sectionContent.find(
        (s) => s.doc.id === (outboundDoc ?? target).id,
      )?.sections;
      const queue = docs.map((d) => sectionContent.find((s) => s.doc.id === d.id)?.sections ?? []);
      // outbound 的额外查询（computeOutboundLinks）消耗队列最后一个元素——与入链
      // 反扫同口径（同一 target sections）；无内容时为 []，outbound 空跑
      queue.push(outboundSections ?? []);
      let i = 0;
      sectionRepo.createQueryBuilder = jest.fn(() =>
        makeQb({
          getMany: jest.fn().mockImplementation(() => Promise.resolve(queue[i++] ?? [])),
        }),
      );
      docService.reconstructContent.mockImplementation((_doc: Doc, sections: DocSection[]) => {
        const hit = sectionContent.find((s) => s.sections === sections);
        return hit ? hit.content : '';
      });
    }

    function arrangeRoutes(routes: Partial<DocRoute>[]) {
      routeRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue(routes) }),
      );
    }

    function arrangeTaskLinks(rows: Array<{ taskId: string }>) {
      taskDocLinkRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getRawMany: jest.fn().mockResolvedValue(rows) }),
      );
    }

    it('反扫入链：path 链接命中（isPathBased + section 定位）+ ?doc= 链接命中（非 pathBased）', async () => {
      const srcA = makeDoc({ id: 'doc-src-a', path: 'docs/source-a.md', title: 'Source A' });
      const srcB = makeDoc({ id: 'doc-src-b', path: 'docs/source-b.md', title: 'Source B' });
      const sectionB = makeSection({
        docId: 'doc-src-b',
        position: 1,
        headingPath: 'Src B § 引用段',
        headingText: '引用段',
        content: '见 [target](./target.md)',
      });

      arrangeSpaceDocs(
        [target, srcA, srcB],
        [
          // srcA 无 sections（内容由 mock 直接给出）：?doc= 规范链接命中
          { doc: srcA, sections: [], content: `见 [target](/docs/space-1?doc=${target.id})` },
          // srcB 一个 section：同目录相对 path 链接命中（严格源解析：docs/source-b.md 内
          // ./target.md → docs/target.md == target.path），section 定位 = position 1
          { doc: srcB, sections: [sectionB], content: `见 [target](./target.md)` },
        ],
      );
      arrangeRoutes([]);
      arrangeTaskLinks([]);

      const impact = await service.computeMoveImpact('space-1', target, 'docs/new.md');

      expect(impact.inboundLinks).toHaveLength(2);
      // ?doc= 形式：isPathBased=false，不进 rewrite 清单
      expect(impact.inboundLinks[0]).toMatchObject({
        sourceDocId: 'doc-src-a',
        sourcePath: 'docs/source-a.md',
        href: `/docs/space-1?doc=${target.id}`,
        isPathBased: false,
      });
      // path 形式：isPathBased=true，section 定位取首个命中
      expect(impact.inboundLinks[1]).toMatchObject({
        sourceDocId: 'doc-src-b',
        sourcePath: 'docs/source-b.md',
        href: './target.md',
        isPathBased: true,
        sectionPosition: 1,
        headingPath: 'Src B § 引用段',
      });
      expect(impact.pathBasedLinksToRewrite).toEqual([impact.inboundLinks[1]]);
      // v1.62.0：move-impact root 透传原始写入 payload 的 contentHash（乐观锁 token，
      // 与读出重建正文不可互算）；target makeDoc contentHash 默认 'hash-target'
      expect(impact.contentHash).toBe('hash-target');
    });

    it('反扫入链：同目录裸文件名命中（严格源相对，无 docs/ 前缀补全）+ (sourceDocId, href) 去重', async () => {
      // target.path 为 docs/target.md；来源 srcA 同在 docs/ 目录，裸文件名 target.md
      // 严格解析 join('docs', 'target.md') = docs/target.md → 精确命中（v1.61.0：
      // 旧「docs/ 前缀补全」已删除——同目录裸文件名本就按严格源解析命中）
      const srcA = makeDoc({ id: 'doc-src-a', path: 'docs/source-a.md', title: 'Source A' });
      const content = '见 [t1](target.md) 和 [t2](target.md)'; // 同一 href 两处 → 去重只记一条
      const sec0 = makeSection({
        docId: 'doc-src-a',
        position: 0,
        headingPath: 'Source A',
        content: '见 [t1](target.md)',
      });
      const sec2 = makeSection({
        docId: 'doc-src-a',
        position: 2,
        headingPath: 'Source A § 尾段',
        content: '和 [t2](target.md)',
      });

      arrangeSpaceDocs([target, srcA], [{ doc: srcA, sections: [sec0, sec2], content }]);
      arrangeRoutes([]);
      arrangeTaskLinks([]);

      const impact = await service.computeMoveImpact('space-1', target);

      // 去重：同一 (sourceDocId, href) 只记一条；section 定位 = 首个命中（position 0）
      expect(impact.inboundLinks).toHaveLength(1);
      expect(impact.inboundLinks[0]).toMatchObject({
        sourceDocId: 'doc-src-a',
        href: 'target.md',
        isPathBased: true,
        sectionPosition: 0,
      });
    });

    it('反扫入链：指向其他文档的链接不命中（.md 与 ?doc= 双路）', async () => {
      const srcA = makeDoc({ id: 'doc-src-a', path: 'docs/source-a.md', title: 'Source A' });
      const other = makeDoc({ id: 'doc-other', path: 'docs/other.md', title: 'Other' });
      const content = '见 [other](./other.md) 和 [other-doc](/docs/space-1?doc=doc-other)';

      arrangeSpaceDocs([target, srcA, other], [{ doc: srcA, sections: [], content }]);
      arrangeRoutes([]);
      arrangeTaskLinks([]);

      const impact = await service.computeMoveImpact('space-1', target);
      expect(impact.inboundLinks).toEqual([]);
      expect(impact.pathBasedLinksToRewrite).toEqual([]);
    });

    it('路由引用：primary / secondary / 双角色同路由', async () => {
      const route1 = makeDoc(undefined) as unknown as DocRoute;
      const routes = [
        {
          id: 'route-1',
          intent: '我要了解系统架构',
          primaryDocId: target.id,
          primaryHeadingPath: '架构 § 1',
          secondaryDocId: 'doc-other',
          secondaryHeadingPath: null,
        },
        {
          id: 'route-2',
          intent: '我要查枚举',
          primaryDocId: 'doc-other',
          primaryHeadingPath: null,
          secondaryDocId: target.id,
          secondaryHeadingPath: '枚举 § 3',
        },
        {
          id: 'route-3',
          intent: '双角色路由',
          primaryDocId: target.id,
          primaryHeadingPath: 'A',
          secondaryDocId: target.id,
          secondaryHeadingPath: 'B',
        },
      ] as unknown as DocRoute[];

      arrangeSpaceDocs([target], []);
      arrangeRoutes(routes);
      arrangeTaskLinks([]);

      const impact = await service.computeMoveImpact('space-1', target);
      expect(impact.docRoutes).toHaveLength(4);
      expect(impact.docRoutes[0]).toMatchObject({
        routeId: 'route-1',
        role: 'primary',
        headingPath: '架构 § 1',
      });
      expect(impact.docRoutes[1]).toMatchObject({
        routeId: 'route-2',
        role: 'secondary',
        headingPath: '枚举 § 3',
      });
      // 双角色：同路由两条（primary + secondary）
      expect(impact.docRoutes[2]).toMatchObject({ routeId: 'route-3', role: 'primary' });
      expect(impact.docRoutes[3]).toMatchObject({ routeId: 'route-3', role: 'secondary' });
    });

    it('taskLinks 清单', async () => {
      arrangeSpaceDocs([target], []);
      arrangeRoutes([]);
      arrangeTaskLinks([{ taskId: 'task-1' }, { taskId: 'task-2' }, { taskId: 'task-1' }]);

      const impact = await service.computeMoveImpact('space-1', target);
      expect(impact.taskLinks).toEqual(['task-1', 'task-2', 'task-1']);
    });

    it('targetCollision / samePath 检测', async () => {
      const occupant = makeDoc({ id: 'doc-occ', path: 'docs/occupied.md', title: 'Occupant' });

      // 有占用：proposedPath == occupant.path → targetCollision
      arrangeSpaceDocs([target, occupant], []);
      arrangeRoutes([]);
      arrangeTaskLinks([]);
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([target, occupant]) }),
      );
      let qbForCollision = makeQb({ getOne: jest.fn().mockResolvedValue({ id: 'doc-occ' }) });
      docRepo.createQueryBuilder = jest.fn(() => qbForCollision);

      const impact = await service.computeMoveImpact('space-1', target, 'docs/occupied.md');
      expect(impact.targetCollision).toEqual({ collision: true, conflictDocId: 'doc-occ' });
      expect(impact.samePath).toBeUndefined();

      // 无占用：proposedPath 无人使用 → 无 collision
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([target, occupant]) }),
      );
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getOne: jest.fn().mockResolvedValue(null) }),
      );
      const impact2 = await service.computeMoveImpact('space-1', target, 'docs/fresh.md');
      expect(impact2.targetCollision).toBeUndefined();

      // samePath：proposedPath == 当前 path
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([target, occupant]) }),
      );
      const impact3 = await service.computeMoveImpact('space-1', target, target.path);
      expect(impact3.samePath).toBe(true);
      expect(impact3.targetCollision).toBeUndefined();
    });

    it('无入链/无引用时空视图', async () => {
      arrangeSpaceDocs([target], []);
      arrangeRoutes([]);
      arrangeTaskLinks([]);

      const impact = await service.computeMoveImpact('space-1', target);
      expect(impact.inboundLinks).toEqual([]);
      expect(impact.docRoutes).toEqual([]);
      expect(impact.taskLinks).toEqual([]);
      expect(impact.pathBasedLinksToRewrite).toEqual([]);
      // plannedPath 为空 → outbound 清单不携带（契约：仅 proposedPath 非空时出现）
      expect(impact.outboundPathLinksToRewrite).toBeUndefined();
      expect(impact.path).toBe('docs/target.md');
    });

    // ─── outbound 出链失效面（v1.61.0 f80a04ea；嵌套于 computeMoveImpact 内以复用
    //      arrangeSpaceDocs/arrangeRoutes/arrangeTaskLinks helper）────────────────

    describe('computeMoveImpact outboundPathLinksToRewrite', () => {
      const target = makeDoc();

      /** 空间快照：[target(docs/target.md), guide(docs/guide.md), sibling(docs/records/other.md)] */
      const guide = makeDoc({ id: 'doc-guide', path: 'docs/guide.md', title: 'Guide' });
      const sibling = makeDoc({
        id: 'doc-sibling',
        path: 'docs/records/other.md',
        title: 'Sibling',
      });
      /** target 自身出链：跨目录裸引用（漂移）/ 越界 ../（漂移可能归位）…见各用例正文 */
      const PLAIN_SPACE = [target, guide, sibling];

      it('收录矩阵：old/new 解析不同才收录；exists 三态 + 自引用按新 path 命中 + ?doc= 跳过', async () => {
        // target（docs/target.md）出链五条：
        //   ./guide.md   跨目录漂移（移后 docs/records/guide.md 不存在 → targetExists=false）
        //   ./ghost.md   移动前后都不存在（oldTargetExists=false 显式标注「已断」）
        //   ./target.md  自引用（移后命中自身 newPath → targetExists=true + targetDocId）
        //   ../guide.md  上溯到根（old=guide.md 断）→ 移后撞上 docs/guide.md（活）——
        //                「目录漂移意外复活链接」边界：old != new 仍收录，双标各记真假
        //   /docs/guide.md 根绝对写（old == new → 不收录）
        const section0 = makeSection({
          docId: target.id,
          position: 0,
          headingPath: 'Target § 出链段',
          headingText: '出链段',
          content:
            '见 [g](./guide.md) 与 [ghost](./ghost.md) 与 [self](./target.md) 与 ' +
            '[up](../guide.md) 与 [abs](/docs/guide.md) 与 [plat](/docs/space-1?doc=doc-guide)',
        });
        const full =
          '见 [g](./guide.md) 与 [ghost](./ghost.md) 与 [self](./target.md) 与 [up](../guide.md) 与 [abs](/docs/guide.md) 与 [plat](/docs/space-1?doc=doc-guide)';

        arrangeSpaceDocs(PLAIN_SPACE, [{ doc: target, sections: [section0], content: full }]);
        arrangeRoutes([]);
        arrangeTaskLinks([]);

        const impact = await service.computeMoveImpact('space-1', target, 'docs/records/target.md');

        // 收录（old != new）：./guide.md / ./ghost.md / ./target.md / ../guide.md 四条
        expect(impact.outboundPathLinksToRewrite).toHaveLength(4);

        // ① ./guide.md：移前存在 → 移后 docs/records/guide.md 不存在 → targetExists=false
        expect(impact.outboundPathLinksToRewrite![0]).toMatchObject({
          href: './guide.md',
          oldResolvedTarget: 'docs/guide.md',
          newResolvedTarget: 'docs/records/guide.md',
          oldTargetExists: true,
          targetExists: false,
          sectionPosition: 0,
          headingPath: 'Target § 出链段',
        });

        // ② ./ghost.md：移动前后都不存在 → oldTargetExists=false 显式标注（防已断误导）
        expect(impact.outboundPathLinksToRewrite![1]).toMatchObject({
          href: './ghost.md',
          oldResolvedTarget: 'docs/ghost.md',
          newResolvedTarget: 'docs/records/ghost.md',
          oldTargetExists: false,
          targetExists: false,
        });

        // ③ ./target.md 自引用：移后命中自身 newPath（postPaths 含 proposedPath）
        //    → targetExists=true + targetDocId=自身
        expect(impact.outboundPathLinksToRewrite![2]).toMatchObject({
          href: './target.md',
          oldResolvedTarget: 'docs/target.md',
          newResolvedTarget: 'docs/records/target.md',
          oldTargetExists: true,
          targetExists: true,
          targetDocId: target.id,
        });

        // ④ ../guide.md 意外复活：移前上溯到根（guide.md 不存在 → 已断），移后恰好撞上
        //    docs/guide.md（存活，targetDocId=guide）——目录漂移的正反两面都如实标注
        expect(impact.outboundPathLinksToRewrite![3]).toMatchObject({
          href: '../guide.md',
          oldResolvedTarget: 'guide.md',
          newResolvedTarget: 'docs/guide.md',
          oldTargetExists: false,
          targetExists: true,
          targetDocId: 'doc-guide',
        });

        // ?doc= 平台链接不收录（按 docId 引用不受 move 影响）；根绝对 /docs/guide.md
        // 因 old == new 不收录
        expect(impact.outboundPathLinksToRewrite!.some((l) => l.href.startsWith('/docs/'))).toBe(
          false,
        );
        expect(impact.outboundPathLinksToRewrite!.some((l) => l.href === '/docs/guide.md')).toBe(
          false,
        );
      });

      it('old == new 不收录：同目录裸引用 / 根绝对 / 上溯到公共父目录的链接不受移动影响', async () => {
        // target 在 docs/sub/，proposed docs/other/（dirname 变化但解析结果稳定）：
        //   x.md（裸）→ old=docs/sub/x.md, new=docs/other/x.md → 收录（唯一漂移项）
        //   ../x.md → old=docs/x.md, new=docs/other/../x.md=docs/x.md → 相同 → 不收录
        const subTarget = makeDoc({ id: 'doc-sub', path: 'docs/sub/a.md', title: 'Sub A' });
        const subGuide = makeDoc({ id: 'doc-guide2', path: 'docs/guide2.md', title: 'Guide2' });
        const selfSection = makeSection({
          docId: subTarget.id,
          position: 0,
          headingPath: 'Sub A',
          content: '见 [x](x.md) 与 [up](../x.md) 与 [abs](/docs/guide2.md)',
        });
        const full = '见 [x](x.md) 与 [up](../x.md) 与 [abs](/docs/guide2.md)';

        arrangeSpaceDocs(
          [subTarget, subGuide],
          [{ doc: subTarget, sections: [selfSection], content: full }],
          subTarget,
        );
        arrangeRoutes([]);
        arrangeTaskLinks([]);

        const impact = await service.computeMoveImpact('space-1', subTarget, 'docs/other/b.md');

        // 仅裸文件名 x.md 一条；../x.md 与 /docs/guide2.md 解析结果稳定 → 不收录
        expect(impact.outboundPathLinksToRewrite).toHaveLength(1);
        expect(impact.outboundPathLinksToRewrite![0]).toMatchObject({
          href: 'x.md',
          oldResolvedTarget: 'docs/sub/x.md',
          newResolvedTarget: 'docs/other/x.md',
          // 空间集合无 x.md 文档：移前已断（oldTargetExists=false）、移后仍断（targetExists=false）
          // ——支撑「目录变化但链接本就断」的显式标注语义
          oldTargetExists: false,
          targetExists: false,
        });
      });

      it('同目录移动（dirname 不变）→ 无出链失效项（空数组而非 missing）', async () => {
        // proposed 与 doc 同目录：所有源相对解析结果不变 → outboundPathLinksToRewrite = []
        const sameDirSection = makeSection({
          docId: target.id,
          position: 0,
          headingPath: 'Target',
          content: '见 [g](./guide.md) 与 [abs](/docs/guide.md)',
        });
        const full = '见 [g](./guide.md) 与 [abs](/docs/guide.md)';

        arrangeSpaceDocs(PLAIN_SPACE, [{ doc: target, sections: [sameDirSection], content: full }]);
        arrangeRoutes([]);
        arrangeTaskLinks([]);

        const impact = await service.computeMoveImpact('space-1', target, 'docs/target-renamed.md');

        expect(impact.outboundPathLinksToRewrite).toEqual([]);
      });

      it('非 .md 出链与目标无 sections 时 → 不收录 / 空清单', async () => {
        // target 无 sections（content 空）→ outbound 空；arrangeSpaceDocs 队尾已追加空 sections
        arrangeSpaceDocs(PLAIN_SPACE, []);
        arrangeRoutes([]);
        arrangeTaskLinks([]);

        const impact = await service.computeMoveImpact('space-1', target, 'docs/records/target.md');
        expect(impact.outboundPathLinksToRewrite).toEqual([]);
      });
    });
  }); // 关闭 computeMoveImpact describe（outbound 子块嵌套于其内）

  // ─── move：校验链 ──────────────────────────────────────────────────

  describe('move', () => {
    const target = makeDoc();

    /** move happy 需要的最小 mock 集：impact 计算全空 + 事务锁行/复核/落库 */
    function arrangeHappyMocks(freshDoc: Doc = target) {
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([target]) }),
      );
      sectionRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      routeRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      taskDocLinkRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );

      // 事务内：锁行 getOne → locked doc；冲突查询 getOne → null；update execute；再读 fresh
      const txQb = makeQb({
        getOne: jest
          .fn()
          .mockResolvedValueOnce(target) // lock
          .mockResolvedValueOnce(null) // conflict 复核
          .mockResolvedValueOnce(makeDoc({ ...freshDoc })), // update 后重读
      });
      mockTransaction.mockImplementation((fn: (manager: unknown) => unknown) =>
        fn({
          getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => txQb) })),
        }),
      );
      docService.findById.mockResolvedValue(target);
    }

    it('404：文档不存在/软删（findById 抛 DOC_NOT_FOUND）', async () => {
      docService.findById.mockRejectedValue(
        new NotFoundException({ message: 'Document not found', code: ErrorCode.DOC_NOT_FOUND }),
      );
      await expect(service.move('doc-missing', { toPath: 'docs/x.md' })).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.DOC_NOT_FOUND }),
        }),
      );
    });

    it('409 DOC_SOURCE_MISMATCH：非 native 文档禁止 move', async () => {
      const ingestDoc = makeDoc({ source: 'git:agent-chamber' });
      docService.findById.mockResolvedValue(ingestDoc);
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([ingestDoc]) }),
      );
      sectionRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      routeRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      taskDocLinkRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );

      await expect(service.move(ingestDoc.id, { toPath: 'docs/x.md' })).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.DOC_SOURCE_MISMATCH }),
        }),
      );
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('409 RESOURCE_CONFLICT：toPath == 当前 path（no-op 拒绝）', async () => {
      docService.findById.mockResolvedValue(target);
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([target]) }),
      );
      sectionRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      routeRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      taskDocLinkRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );

      await expect(service.move(target.id, { toPath: target.path })).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.RESOURCE_CONFLICT }),
        }),
      );
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('409 DOC_CONTENT_CONFLICT：expectedContentHash 事务外快速失败', async () => {
      arrangeHappyMocks();
      await expect(
        service.move(target.id, { toPath: 'docs/new.md', expectedContentHash: 'stale-hash' }),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: ErrorCode.DOC_CONTENT_CONFLICT,
            data: { currentContentHash: 'hash-target' },
          }),
        }),
      );
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('409 RESOURCE_CONFLICT：目标 path 被占用（带 conflictDocId）', async () => {
      docService.findById.mockResolvedValue(target);
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([target]) }),
      );
      sectionRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      routeRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      taskDocLinkRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );

      // 空间文档 getMany 先进分类 + 冲突查询
      const qbGetMany = makeQb({ getMany: jest.fn().mockResolvedValue([target]) });
      const qbCollision = makeQb({
        getMany: jest.fn().mockResolvedValue([target]),
        getOne: jest.fn().mockResolvedValue({ id: 'doc-occ' }),
      });
      docRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(qbGetMany) // 空间候选列表
        .mockReturnValueOnce(qbCollision); // 冲突检测

      let caught: ConflictException | null = null;
      try {
        await service.move(target.id, { toPath: 'docs/occupied.md' });
      } catch (e: unknown) {
        caught = e as ConflictException;
      }
      expect(caught?.getResponse()).toMatchObject({
        code: ErrorCode.RESOURCE_CONFLICT,
        data: { conflictDocId: 'doc-occ' },
      });
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('dryRun：跑完整校验链 + impact 预演视图，不写库', async () => {
      arrangeHappyMocks();
      const result = await service.move(target.id, { toPath: 'docs/new.md', dryRun: true }, {
        id: 'user-1',
        type: ActorType.HUMAN,
      } as never);

      expect(result.moved).toBe(false);
      expect(result.wouldMove).toBe(true);
      expect(result.oldPath).toBe('docs/target.md');
      expect(result.newPath).toBe('docs/new.md');
      expect(result.impact).toBeDefined();
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(auditRepo.save).not.toHaveBeenCalled();
      expect(eventService.create).not.toHaveBeenCalled();
    });

    it('happy：事务锁行只改 path → audit MOVE_DOC → DOC_MOVED 事件（context 派生）→ recalc 异步重算', async () => {
      arrangeHappyMocks(
        makeDoc({
          id: 'aaaaaaaa-0000-0000-0000-0000000000aa',
          path: 'docs/new.md',
          contentHash: 'hash-target',
        }),
      );
      const actor = { id: 'user-1', type: ActorType.HUMAN } as never;

      const result = await service.move(target.id, { toPath: 'docs/new.md' }, actor);
      await flushImmediates();

      // 响应：docId 不变、新旧 path、contentHash 不变、moved
      expect(result).toMatchObject({
        docId: 'aaaaaaaa-0000-0000-0000-0000000000aa',
        oldPath: 'docs/target.md',
        newPath: 'docs/new.md',
        contentHash: 'hash-target',
        moved: true,
      });

      // 事务恰好执行一次（dryRun 分支不执行的对照在 dryRun 用例）
      expect(mockTransaction).toHaveBeenCalledTimes(1);

      // audit：MOVE_DOC（verb_noun 风格，对齐 reset_api_key 先例）
      expect(auditRepo.save).toHaveBeenCalledTimes(1);
      const auditEntry = (auditRepo.create as jest.Mock).mock.calls[0][0];
      expect(auditEntry).toMatchObject({
        action: AuditAction.MOVE_DOC,
        entityType: 'doc',
        entityId: 'aaaaaaaa-0000-0000-0000-0000000000aa',
        actorId: 'user-1',
        newData: { oldPath: 'docs/target.md', newPath: 'docs/new.md' },
      });

      // 事件：DOC_MOVED payload 含 oldPath/newPath，topicId/boardId 经 getSpaceEventContext 派生
      expect(eventService.create).toHaveBeenCalledTimes(1);
      expect(eventService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EventType.DOC_MOVED,
          topicId: 'topic-1',
          boardId: 'board-1',
          payload: {
            spaceId: 'space-1',
            docId: 'aaaaaaaa-0000-0000-0000-0000000000aa',
            oldPath: 'docs/target.md',
            newPath: 'docs/new.md',
            title: 'Target Doc',
          },
        }),
      );
      expect(docService.getSpaceEventContext).toHaveBeenCalledWith('space-1');

      // 异步重算 linkHealth（旧 path 入链即刻变断链可见）
      expect(docService.recalcSpaceLinkHealth).toHaveBeenCalledWith('space-1');
    });

    it('事务内复核（TOCTOU）：锁行后 hash 已变 → 409 DOC_CONTENT_CONFLICT 回滚', async () => {
      // 事务外通过（hash 相符），锁行读到被并发改过的 hash
      const txQb = makeQb({
        getOne: jest
          .fn()
          .mockResolvedValueOnce(makeDoc({ contentHash: 'concurrent-new-hash' })) // 锁行复核 ≠ 期望
          .mockResolvedValueOnce(null),
      });
      mockTransaction.mockImplementation((fn: (manager: unknown) => unknown) =>
        fn({ getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => txQb) })) }),
      );
      docService.findById.mockResolvedValue(target);
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([target]) }),
      );
      sectionRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      routeRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      taskDocLinkRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );

      await expect(
        service.move(target.id, { toPath: 'docs/new.md', expectedContentHash: 'hash-target' }),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.DOC_CONTENT_CONFLICT }),
        }),
      );
      expect(auditRepo.save).not.toHaveBeenCalled();
    });

    it('23505：并发 move 同 target → 重查占用方，幂等 409 RESOURCE_CONFLICT + conflictDocId', async () => {
      // 事务抛 23505（partial unique path）
      const txQb = makeQb({
        getOne: jest.fn().mockResolvedValueOnce(target),
        execute: jest.fn().mockRejectedValue({
          code: '23505',
          constraint: 'uq_docs_space_path_deleted_at_null',
          detail: 'duplicate key',
        }),
      });
      mockTransaction.mockImplementation((fn: (manager: unknown) => unknown) =>
        fn({ getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => txQb) })) }),
      );
      docService.findById.mockResolvedValue(target);
      docRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([target]) }),
      );
      // 23505 catch 后的重查：find occupant
      const qbWinner = makeQb({
        getMany: jest.fn().mockResolvedValue([target]),
        getOne: jest.fn().mockResolvedValue({ id: 'doc-winner' }),
      });
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValueOnce(
        makeQb({ getMany: jest.fn().mockResolvedValue([target]) }),
      );
      (docRepo.createQueryBuilder as jest.Mock).mockReturnValue(qbWinner);
      sectionRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      routeRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      taskDocLinkRepo.createQueryBuilder = jest.fn(() =>
        makeQb({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );

      let caught: ConflictException | null = null;
      try {
        await service.move(target.id, { toPath: 'docs/winner.md' });
      } catch (e: unknown) {
        caught = e as ConflictException;
      }
      expect(caught?.getResponse()).toMatchObject({
        code: ErrorCode.RESOURCE_CONFLICT,
        data: { conflictDocId: 'doc-winner' },
      });
      expect(auditRepo.save).not.toHaveBeenCalled();
      expect(eventService.create).not.toHaveBeenCalled();
    });
  });
});
