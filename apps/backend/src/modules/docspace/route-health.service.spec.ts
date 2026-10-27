import { Repository } from 'typeorm';
import { RouteHealthService } from './route-health.service';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocService } from './doc.service';

/**
 * RouteHealthService 测试（v1.42 批次 C1 + C2 codeEntry 级联校验）
 *
 * 覆盖（plan §7-C1/C2）：heading ok/broken/none 三分支、issues 形状（kind/target/value）、
 * checkedAt 刷新、recheckSpace 批量落库（save 一次收全量、rechecked/broken 计数）；
 * codeEntry：精确命中/目录前缀命中/前缀边界不命中（srcx 案例）/无 manifest→unchecked 不 broken/
 * 不匹配→broken+issue 形状/codeEntry 为空省略键。
 */
describe('RouteHealthService', () => {
  let service: RouteHealthService;
  let routeRepo: jest.Mocked<Repository<DocRoute>>;
  let spaceRepo: jest.Mocked<Repository<DocSpace>>;
  let docService: { sectionExistsByHeadingPath: jest.Mock };

  /** 默认无 manifest（settings 空对象）——C1 既有用例不受 C2 影响（codeEntry: null 不检） */
  const DEFAULT_SPACE_SETTINGS = {};

  function makeSpace(settings: Record<string, unknown>): DocSpace {
    return { id: 'space-1', settings } as DocSpace;
  }

  function makeRoute(overrides: Partial<DocRoute> = {}): DocRoute {
    return {
      id: 'route-1',
      spaceId: 'space-1',
      intent: '我要了解系统架构',
      category: 'architecture',
      primaryDocId: 'doc-1',
      primaryHeadingPath: '## 3. 架构总览',
      secondaryDocId: null,
      secondaryHeadingPath: null,
      codeEntry: null,
      sortOrder: 0,
      createdBy: 'user-1',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      health: null,
      ...overrides,
    } as DocRoute;
  }

  beforeEach(() => {
    routeRepo = {
      find: jest.fn(),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<DocRoute>>;

    spaceRepo = {
      findOne: jest.fn().mockResolvedValue(makeSpace(DEFAULT_SPACE_SETTINGS)),
    } as unknown as jest.Mocked<Repository<DocSpace>>;

    docService = { sectionExistsByHeadingPath: jest.fn() };

    service = new RouteHealthService(
      routeRepo,
      spaceRepo,
      docService as unknown as DocService,
    );
  });

  afterEach(() => jest.resetAllMocks());

  // ─── heading 三分支（铁律 #17：状态流转必须测试覆盖）────────────────

  describe('recheckSpace heading branches', () => {
    it('ok 分支：primary+secondary headingPath 均可解析 → health.issues=[]（健康），broken=0', async () => {
      const route = makeRoute({
        secondaryDocId: 'doc-2',
        secondaryHeadingPath: '## 5. 数据库设计',
      });
      routeRepo.find.mockResolvedValue([route]);
      docService.sectionExistsByHeadingPath.mockResolvedValue(true);

      const result = await service.recheckSpace('space-1');

      expect(docService.sectionExistsByHeadingPath).toHaveBeenCalledWith(
        'doc-1',
        '## 3. 架构总览',
      );
      expect(docService.sectionExistsByHeadingPath).toHaveBeenCalledWith(
        'doc-2',
        '## 5. 数据库设计',
      );
      expect(route.health).toEqual({ issues: [], checkedAt: expect.any(String) });
      expect(result).toEqual({ rechecked: 1, broken: 0 });
    });

    it('broken 分支：primary headingPath 不可解析 → issues 含 kind:heading/target:primary/value 原文', async () => {
      const route = makeRoute();
      routeRepo.find.mockResolvedValue([route]);
      docService.sectionExistsByHeadingPath.mockResolvedValue(false);

      const result = await service.recheckSpace('space-1');

      expect(route.health).toEqual({
        issues: [{ kind: 'heading', target: 'primary', value: '## 3. 架构总览' }],
        checkedAt: expect.any(String),
      });
      expect(result).toEqual({ rechecked: 1, broken: 1 });
    });

    it('broken 分支：secondary headingPath 不可解析 → target=secondary 的 issue', async () => {
      const route = makeRoute({
        secondaryDocId: 'doc-2',
        secondaryHeadingPath: '## 悬空的节',
      });
      routeRepo.find.mockResolvedValue([route]);
      // primary 命中、secondary 未命中
      docService.sectionExistsByHeadingPath
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await service.recheckSpace('space-1');

      expect(route.health!.issues).toEqual([
        { kind: 'heading', target: 'secondary', value: '## 悬空的节' },
      ]);
      expect(result.broken).toBe(1);
    });

    it('none 分支：无 headingPath（文档级跳转）→ 不触发 exists 查询，issues=[]（健康）', async () => {
      const route = makeRoute({
        primaryHeadingPath: null,
        secondaryDocId: null,
        secondaryHeadingPath: null,
      });
      routeRepo.find.mockResolvedValue([route]);

      const result = await service.recheckSpace('space-1');

      expect(docService.sectionExistsByHeadingPath).not.toHaveBeenCalled();
      expect(route.health).toEqual({ issues: [], checkedAt: expect.any(String) });
      expect(result).toEqual({ rechecked: 1, broken: 0 });
    });

    it('issues 形状：单路由可同时携带 primary+secondary 两条 issue（双悬空）', async () => {
      const route = makeRoute({
        secondaryDocId: 'doc-2',
        secondaryHeadingPath: '## 也悬空的节',
      });
      routeRepo.find.mockResolvedValue([route]);
      docService.sectionExistsByHeadingPath.mockResolvedValue(false);

      await service.recheckSpace('space-1');

      expect(route.health!.issues).toEqual([
        { kind: 'heading', target: 'primary', value: '## 3. 架构总览' },
        { kind: 'heading', target: 'secondary', value: '## 也悬空的节' },
      ]);
    });
  });

  // ─── checkedAt / 批量落库 ─────────────────────────────────

  describe('recheckSpace persistence', () => {
    it('checkedAt 为 ISO 8601 时间戳（本次重检时刻），每次调用刷新', async () => {
      routeRepo.find.mockResolvedValue([makeRoute()]);
      docService.sectionExistsByHeadingPath.mockResolvedValue(true);

      await service.recheckSpace('space-1');
      const first = (routeRepo.save as jest.Mock).mock.calls[0][0][0].health as {
        checkedAt: string;
      };
      // ISO 8601 完整时间戳格式（含 T 与 Z/时区），非 Date 对象序列化
      expect(first.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(first.checkedAt).toISOString()).toBe(first.checkedAt);
    });

    it('批量落库：全量路由一次性 save，每条 health 独立装配；rechecked=路由数', async () => {
      const r1 = makeRoute({ id: 'r1', primaryHeadingPath: '## 存在' });
      const r2 = makeRoute({ id: 'r2', primaryHeadingPath: '## 悬空' });
      const r3 = makeRoute({ id: 'r3', primaryHeadingPath: null });
      routeRepo.find.mockResolvedValue([r1, r2, r3]);
      // r1 命中、r2 未命中、r3 无锚点不查
      docService.sectionExistsByHeadingPath
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await service.recheckSpace('space-1');

      expect(routeRepo.save).toHaveBeenCalledTimes(1);
      const saved = (routeRepo.save as jest.Mock).mock.calls[0][0] as DocRoute[];
      expect(saved).toHaveLength(3);
      expect(saved[0].health!.issues).toEqual([]);
      expect(saved[1].health!.issues).toHaveLength(1);
      expect(saved[2].health!.issues).toEqual([]);
      expect(result).toEqual({ rechecked: 3, broken: 1 });
    });

    it('空空间（无路由）→ 零计数安全返回，不触发 save', async () => {
      routeRepo.find.mockResolvedValue([]);

      const result = await service.recheckSpace('space-1');

      expect(result).toEqual({ rechecked: 0, broken: 0 });
      expect(routeRepo.save).not.toHaveBeenCalled();
      expect(docService.sectionExistsByHeadingPath).not.toHaveBeenCalled();
    });
  });

  // ─── codeEntry manifest 级联校验（批次 C2）─────────────────

  describe('recheckSpace codeEntry manifest cascade', () => {
    /** 便捷：空间挂 repoManifest + 单路由 + heading 全命中（排除 heading 噪音） */
    function setup(manifest: Record<string, unknown> | null, route: DocRoute) {
      spaceRepo.findOne.mockResolvedValue(manifest ? makeSpace(manifest) : null);
      routeRepo.find.mockResolvedValue([route]);
      docService.sectionExistsByHeadingPath.mockResolvedValue(true);
    }

    it('精确命中：codeEntry 与 manifest.files 中某文件完全相等 → codeEntryStatus:ok，无 issue', async () => {
      const route = makeRoute({ codeEntry: 'apps/backend/src/app.module.ts' });
      setup(
        { repoManifest: { sha: 'abc', files: ['apps/backend/src/app.module.ts', 'docs/a.md'], reportedAt: 'x' } },
        route,
      );

      const result = await service.recheckSpace('space-1');

      expect(route.health).toEqual({
        issues: [],
        codeEntryStatus: 'ok',
        checkedAt: expect.any(String),
      });
      expect(result).toEqual({ rechecked: 1, broken: 0 });
    });

    it('目录前缀命中：codeEntry 为目录路径（无尾斜杠）→ 命中其下文件', async () => {
      const route = makeRoute({ codeEntry: 'apps/backend/src/modules' });
      setup(
        {
          repoManifest: {
            sha: 'abc',
            files: ['apps/backend/src/modules/docspace/doc.service.ts'],
            reportedAt: 'x',
          },
        },
        route,
      );

      await service.recheckSpace('space-1');

      expect(route.health!.codeEntryStatus).toBe('ok');
      expect(route.health!.issues).toEqual([]);
    });

    it('目录前缀命中（尾斜杠形式）：`apps/backend/src/modules/` 命中其下文件', async () => {
      const route = makeRoute({ codeEntry: 'apps/backend/src/modules/' });
      setup(
        {
          repoManifest: { sha: 'abc', files: ['apps/backend/src/modules/doc-route.service.ts'], reportedAt: 'x' },
        },
        route,
      );

      await service.recheckSpace('space-1');

      expect(route.health!.codeEntryStatus).toBe('ok');
    });

    it('前缀边界不命中（srcx 案例）：`apps/web/src` 不命中 `apps/web/srcx/...`（路径段边界）', async () => {
      const route = makeRoute({ codeEntry: 'apps/web/src' });
      // 只存在 srcx 目录文件：若按字符串前缀（无段边界）会误命中，断言 broken 证明边界生效
      setup(
        { repoManifest: { sha: 'abc', files: ['apps/web/srcx/main.ts'], reportedAt: 'x' } },
        route,
      );

      const result = await service.recheckSpace('space-1');

      expect(route.health).toEqual({
        issues: [{ kind: 'codeEntry', target: 'codeEntry', value: 'apps/web/src' }],
        codeEntryStatus: 'broken',
        checkedAt: expect.any(String),
      });
      expect((route.health!.issues as unknown[]).length).toBe(1);
      expect(result).toEqual({ rechecked: 1, broken: 1 });
    });

    it('不匹配 → broken：issue 形状 {kind:codeEntry, target:codeEntry, value 原文}，计入 broken 计数', async () => {
      const route = makeRoute({ codeEntry: 'apps/backend/src/gone.service.ts' });
      setup(
        { repoManifest: { sha: 'abc', files: ['apps/backend/src/app.module.ts'], reportedAt: 'x' } },
        route,
      );

      const result = await service.recheckSpace('space-1');

      expect(route.health!.issues).toEqual([
        { kind: 'codeEntry', target: 'codeEntry', value: 'apps/backend/src/gone.service.ts' },
      ]);
      expect(route.health!.codeEntryStatus).toBe('broken');
      expect(result).toEqual({ rechecked: 1, broken: 1 });
    });

    it('无 manifest（settings 无 repoManifest）→ codeEntryStatus:unchecked，不产 issue 不算 broken', async () => {
      const route = makeRoute({ codeEntry: 'apps/backend/src/app.module.ts' });
      setup({}, route);

      const result = await service.recheckSpace('space-1');

      expect(route.health).toEqual({
        issues: [],
        codeEntryStatus: 'unchecked',
        checkedAt: expect.any(String),
      });
      expect(result).toEqual({ rechecked: 1, broken: 0 });
    });

    it('manifest 脏数据防御：files 非数组（手工改库）→ 视同无 manifest → unchecked', async () => {
      const route = makeRoute({ codeEntry: 'apps/backend/src/app.module.ts' });
      // B4 同款防御：jsonb 手工写入可能存成非数组形状
      setup({ repoManifest: { sha: 'abc', files: 'not-an-array', reportedAt: 'x' } }, route);

      await service.recheckSpace('space-1');

      expect(route.health!.codeEntryStatus).toBe('unchecked');
      expect(route.health!.issues).toEqual([]);
    });

    it('codeEntry 为空（null）→ 省略 codeEntryStatus 键（既有 health 形状不变）', async () => {
      const route = makeRoute({ codeEntry: null });
      setup(
        { repoManifest: { sha: 'abc', files: ['anything.ts'], reportedAt: 'x' } },
        route,
      );

      await service.recheckSpace('space-1');

      expect(route.health).toEqual({ issues: [], checkedAt: expect.any(String) });
      // toEqual 为严格相等（多键即失败），此处再显式断言键省略（codeEntry 为空 → 无 codeEntryStatus）
      expect(Object.prototype.hasOwnProperty.call(route.health, 'codeEntryStatus')).toBe(false);
    });

    it('manifest 只读一次（同批次共享同一快照）：多路由不重复查 space', async () => {
      const r1 = makeRoute({ id: 'r1', codeEntry: 'a.ts' });
      const r2 = makeRoute({ id: 'r2', codeEntry: 'b.ts' });
      routeRepo.find.mockResolvedValue([r1, r2]);
      spaceRepo.findOne.mockResolvedValue(
        makeSpace({ repoManifest: { sha: 'abc', files: ['a.ts', 'b.ts'], reportedAt: 'x' } }),
      );
      docService.sectionExistsByHeadingPath.mockResolvedValue(true);

      await service.recheckSpace('space-1');

      expect(spaceRepo.findOne).toHaveBeenCalledTimes(1);
      expect(r1.health!.codeEntryStatus).toBe('ok');
      expect(r2.health!.codeEntryStatus).toBe('ok');
    });
  });

  // ─── T5 codeEntryType='pattern' 豁免（glob 泛化写法不报 broken） ───

  describe('recheckSpace pattern codeEntry exemption (T5)', () => {
    /** 便捷：空间挂 repoManifest + 单路由 + heading 全命中（排除 heading 噪音） */
    function setup(manifest: Record<string, unknown> | null, route: DocRoute) {
      spaceRepo.findOne.mockResolvedValue(manifest ? makeSpace(manifest) : null);
      routeRepo.find.mockResolvedValue([route]);
      docService.sectionExistsByHeadingPath.mockResolvedValue(true);
    }

    it('pattern 型 + 文件不存在的 glob → codeEntryStatus:exempt + codeEntryNote，不产 issue 不算 broken', async () => {
      const route = makeRoute({
        codeEntry: 'apps/web/app/**' + '/page.tsx',
        codeEntryType: 'pattern',
      });
      setup(
        { repoManifest: { sha: 'abc', files: ['apps/web/app/page.tsx'], reportedAt: 'x' } },
        route,
      );

      const result = await service.recheckSpace('space-1');

      expect(route.health).toEqual({
        issues: [],
        codeEntryStatus: 'exempt',
        codeEntryNote: expect.any(String),
        checkedAt: expect.any(String),
      });
      expect(result).toEqual({ rechecked: 1, broken: 0 });
    });

    it('pattern 豁免只作用于 codeEntry：heading 悬空仍正常报 broken（issues 照常装配）', async () => {
      const route = makeRoute({
        codeEntry: 'apps/web/app/**' + '/page.tsx',
        codeEntryType: 'pattern',
      });
      setup({ repoManifest: { sha: 'abc', files: [], reportedAt: 'x' } }, route);
      // heading 未命中（pattern 不豁免 heading 校验）
      docService.sectionExistsByHeadingPath.mockResolvedValue(false);

      const result = await service.recheckSpace('space-1');

      expect(route.health!.issues).toEqual([
        { kind: 'heading', target: 'primary', value: '## 3. 架构总览' },
      ]);
      expect(route.health!.codeEntryStatus).toBe('exempt');
      expect(result).toEqual({ rechecked: 1, broken: 1 });
    });

    it('pattern 型豁免不依赖 manifest（无 manifest 同样 exempt 而非 unchecked）', async () => {
      const route = makeRoute({
        codeEntry: 'apps/web/app/**' + '/page.tsx',
        codeEntryType: 'pattern',
      });
      setup({}, route);

      await service.recheckSpace('space-1');

      expect(route.health!.codeEntryStatus).toBe('exempt');
      expect(route.health!.issues).toEqual([]);
      expect(route.health!.codeEntryNote).toEqual(expect.any(String));
    });

    it('exact 缺省行为不变：codeEntryType 缺省（undefined，存量行迁移后为 exact）→ 仍走 C2 精确校验', async () => {
      // makeRoute 不传 codeEntryType → undefined；recheck 按 exact 分支处理（与存量行一致）
      const route = makeRoute({ codeEntry: 'apps/gone.ts' });
      setup({ repoManifest: { sha: 'abc', files: ['apps/keep.ts'], reportedAt: 'x' } }, route);

      const result = await service.recheckSpace('space-1');

      expect(route.health!.codeEntryStatus).toBe('broken');
      expect(route.health!.issues).toEqual([
        { kind: 'codeEntry', target: 'codeEntry', value: 'apps/gone.ts' },
      ]);
      expect(result.broken).toBe(1);
    });
  });

  // ─── 锚校验公共入口（2 期 A2 收口）──────────────────────────────────

  describe('analyzeDocRouteAnchors / routesReferencingDoc', () => {
    /** 装配 routesReferencingDoc 的 queryBuilder 链（space_id + docId 双条件） */
    function mockReferencingRoutes(routes: DocRoute[]): {
      where: jest.Mock;
      andWhere: jest.Mock;
    } {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(routes),
      };
      (routeRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      return qb;
    }

    it('routesReferencingDoc：空间内先过滤 + primary/secondary 双命中条件', async () => {
      const qb = mockReferencingRoutes([makeRoute()]);
      const out = await service.routesReferencingDoc('space-1', 'doc-1');

      expect(out.length).toBe(1);
      expect(qb.where).toHaveBeenCalledWith('r.space_id = :spaceId', { spaceId: 'space-1' });
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(r.primary_doc_id = :docId OR r.secondary_doc_id = :docId)',
        { docId: 'doc-1' },
      );
    });

    it('headingPaths 集合命中 → 无断锚（routeCount 仍计数）', async () => {
      mockReferencingRoutes([
        makeRoute({ primaryHeadingPath: 'A' }),
        makeRoute({ id: 'route-2', primaryDocId: 'doc-9' }),
      ]);

      const out = await service.analyzeDocRouteAnchors('space-1', 'doc-1', new Set(['A', 'B']));

      expect(out.routeCount).toBe(2);
      expect(out.brokenRouteIds).toEqual([]);
      expect(out.anchors).toEqual([]);
    });

    it('headingPaths 未命中 → 该路由进 brokenRouteIds + anchors（含 secondary 角色）', async () => {
      mockReferencingRoutes([
        makeRoute({ primaryHeadingPath: 'A' }),
        makeRoute({
          id: 'route-2',
          primaryDocId: 'doc-other',
          secondaryDocId: 'doc-1',
          secondaryHeadingPath: 'B',
        }),
      ]);

      const out = await service.analyzeDocRouteAnchors('space-1', 'doc-1', new Set(['A']));

      expect(out.brokenRouteIds).toEqual(['route-2']);
      expect(out.anchors).toEqual([{ routeId: 'route-2', headingPath: 'B' }]);
    });

    it('纯文档级引用（无锚）在内容变更下不断锚；headingPaths=null（delete）下全部判断', async () => {
      mockReferencingRoutes([makeRoute({ primaryHeadingPath: null })]);

      const contentChange = await service.analyzeDocRouteAnchors('space-1', 'doc-1', new Set());
      expect(contentChange.brokenRouteIds).toEqual([]);

      const deleted = await service.analyzeDocRouteAnchors('space-1', 'doc-1', null);
      expect(deleted.brokenRouteIds).toEqual(['route-1']);
      // anchors 只列有锚的（docId 锚断本身无锚点可比）
      expect(deleted.anchors).toEqual([]);
    });

    it('delete 分支：全部引用路由判断，anchors 只列非空锚', async () => {
      mockReferencingRoutes([
        makeRoute({ primaryHeadingPath: 'A' }),
        makeRoute({ id: 'route-2', primaryHeadingPath: null }),
      ]);

      const out = await service.analyzeDocRouteAnchors('space-1', 'doc-1', null);

      expect(out.brokenRouteIds).toEqual(['route-1', 'route-2']);
      expect(out.anchors).toEqual([{ routeId: 'route-1', headingPath: 'A' }]);
    });

    it('无引用路由 → 全零（不抛）', async () => {
      mockReferencingRoutes([]);
      const out = await service.analyzeDocRouteAnchors('space-1', 'doc-1', new Set());
      expect(out).toEqual({ routeCount: 0, brokenRouteIds: [], anchors: [] });
    });

    it('纯比对 analyzeRouteAnchors（MAJOR-2：零 IO，事务内可用）不触碰任何仓储', () => {
      const routes = [
        makeRoute({ primaryHeadingPath: 'A' }),
        makeRoute({ id: 'route-2', primaryHeadingPath: 'GONE' }),
      ];
      const out = service.analyzeRouteAnchors(routes, 'doc-1', new Set(['A']));

      expect(out.routeCount).toBe(2);
      expect(out.brokenRouteIds).toEqual(['route-2']);
      expect(out.anchors).toEqual([{ routeId: 'route-2', headingPath: 'GONE' }]);
      // 零 IO：未触发任何查询（事务内调用的前提）
      expect(routeRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(spaceRepo.findOne).not.toHaveBeenCalled();
    });

    it('纯比对 delete 语义（headingPaths=null）：全部引用判断 + 只列非空锚', () => {
      const routes = [
        makeRoute({ primaryHeadingPath: 'A' }),
        makeRoute({ id: 'route-2', primaryHeadingPath: null }),
      ];
      const out = service.analyzeRouteAnchors(routes, 'doc-1', null);
      expect(out.brokenRouteIds).toEqual(['route-1', 'route-2']);
      expect(out.anchors).toEqual([{ routeId: 'route-1', headingPath: 'A' }]);
    });
  });
});
