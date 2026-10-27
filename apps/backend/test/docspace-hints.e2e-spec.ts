/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §2（hints 信封通用规范）/ §16.4（hintToggles）
 *     / §16.9b（facets 回显）/ §16.10（读侧两条）/ §16.14/16.15/16.16（写侧与锚分级）
 *   - 补充: plan hawkman-deadman-doctor-mid-nite.md §5（e2e 矩阵：开关 roundtrip/422/
 *     merge、族关零 hints、六族触发矩阵、锚分级、读侧两条、facets 回显、去重窗口、
 *     ≤3 截断、双写、unchanged 边界、幂等重放）
 *
 * [踩坑索引]
 *   - mock 测不出 ORM SQL 生成（铁律 #23）：settings jsonb 读写、route 引用查询、
 *     事务内 hints 随幂等快照落库，全必须打真实 PG（本套件职责）
 *   - tag 池/category 池是事务前读（自死锁规避）：本套件跑真实事务，是这条设计
 *     决策的实证面（若挪回事务内会在这里挂住）
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #23(jsonb/ORM 集成覆盖) #20(不为测试改设计)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 已更新文档侧 AGENT-DOC-HOOK（如归属变化）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * DocSpace hints 信封 + hint 族开关（2 期，v1.92.0-dev）—— 真实 PG 集成套件
 *
 * 覆盖六族写侧挂点、读侧两条、去重窗口、≤3 截断、双写、unchanged 边界、幂等重放、
 * facets 回显、开关 roundtrip/422/merge、bundle settings 过滤。全部走真 TypeORM repo +
 * 真事务（hints 随幂等快照落库、route 引用查询、tag/category 池聚合都必须在真库验证）。
 *
 * DB 目标 = 本地开发库 chamber-postgres（env 可覆盖）。PG 不可达时整套降级跳过。
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DataSource } from 'typeorm';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import type { DocHint } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { DocService } from '../src/modules/docspace/doc.service';
import { DocSpaceService } from '../src/modules/docspace/docspace.service';
import { DocMoveService } from '../src/modules/docspace/doc-move.service';
import { DocRouteService } from '../src/modules/docspace/doc-route.service';
import { DocSearchService } from '../src/modules/docspace/doc-search.service';
import { DocLinksService } from '../src/modules/docspace/doc-links.service';
import { DocBundleService } from '../src/modules/docspace/doc-bundle.service';
import { RouteHealthService } from '../src/modules/docspace/route-health.service';
import { DiagramRendererService } from '../src/modules/docspace/diagram-renderer.service';
import { HintDedupService } from '../src/modules/hints/hint-dedup.service';
import { UpdateDocSpaceDto } from '../src/modules/docspace/dto/update-doc-space.dto';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { Board } from '../src/database/entities/board.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { User } from '../src/database/entities/user.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import type { EventService } from '../src/modules/event/event.service';
import type { AccessQueryService } from '../src/common/services/access-query.service';
import type { ResourceValidator } from '../src/common/resource-validator';
import type { ActorProfileService } from '../src/common/services/actor-profile.service';
import type { AuditService } from '../src/modules/audit/audit.service';
import type { AttachmentService } from '../src/modules/attachments/attachment.service';
import type { UnifiedActor } from '../src/common/types/actor.types';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实文档互相污染 */
const RUN = `hints-e2e-${Date.now()}`;

/** 固定测试 actor（docs.created_by 为 uuid 列，'system' 字面量会被 PG 拒绝） */
const testActor: UnifiedActor = {
  id: '00000000-0000-4000-8000-0000000000dd',
  type: ActorType.HUMAN,
};

/** 断言 4xx 错误体的 code（NestJS HttpException.response 结构） */
async function expectErrorCode(promise: Promise<unknown>, code: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ response: { code } });
}

/** 取某 code 的 hint（不存在 → undefined；hints 键不出现时安全） */
function hintOf(hints: DocHint[] | undefined, code: DocHint['code']): DocHint | undefined {
  return hints?.find((hint) => hint.code === code);
}

describe('DocSpace hints 信封 + hint 族开关（2 期）— 真实 PG 集成', () => {
  let ds: DataSource;
  let docService: DocService;
  let docSpaceService: DocSpaceService;
  let docMoveService: DocMoveService;
  let docRouteService: DocRouteService;
  let docSearchService: DocSearchService;
  let docBundleService: DocBundleService;
  let hintDedup: HintDedupService;
  let dbAvailable = false;

  let spaceAllOnId: string; // 六族全开 + canonicalTags + pathTypes + overviewFilter
  let spaceAllOffId: string; // 无 hintToggles（族全关）
  let spaceDirtyId: string; // 脏 hintToggles（直改库模拟）
  let spaceOffWithVocabId: string; // 族全关但声明 canonicalTags（m4：归一事实回显面）

  const canonicalTags = [{ value: 'npc', aliases: ['NPC'] }];
  const pathTypes = [
    { pathPrefix: 'memory/', docType: 'memory' },
    { pathPrefix: 'memory/daily/', docType: 'diary' },
  ];
  const overviewFilter = { excludeTypes: ['memory'] };
  const allFamiliesOn = {
    metadata: true,
    tags: true,
    categories: true,
    pathType: true,
    routes: true,
    read: true,
  };

  async function settingsOf(spaceId: string): Promise<Record<string, unknown>> {
    const space = await ds.getRepository(DocSpace).findOne({ where: { id: spaceId } });
    return (space?.settings ?? {}) as Record<string, unknown>;
  }

  async function readDoc(docId: string): Promise<Doc | null> {
    return ds.getRepository(Doc).findOne({ where: { id: docId } });
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[docspace-hints e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    const eventStub = { create: jest.fn(async () => ({})) } as unknown as EventService;
    const auditStub = { log: jest.fn(async () => undefined) } as unknown as AuditService;
    // hint 去重窗口：生产语义 = 五个 service 共享同一实例（跨面窗口一致）
    hintDedup = new HintDedupService();

    // RouteHealthService 用真实例（upsert/delete 的锚校验走它——stub 会让 hints 失真）；
    // 它的 docService 依赖只服务 recheckSpace（本套件不关心的异步巡检），给最小桩
    const routeHealthService = new RouteHealthService(
      ds.getRepository(DocRoute),
      ds.getRepository(DocSpace),
      { sectionExistsByHeadingPath: async () => true } as unknown as DocService,
    );

    docService = new DocService(
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(DocCategory),
      ds.getRepository(AuditLog),
      ds.getRepository(DocSpace),
      ds.getRepository(Board),
      ds.getRepository(DocVersion),
      eventStub,
      routeHealthService,
      ds.getRepository(IdempotencyRecord),
      { validateAndRender: jest.fn() } as unknown as DiagramRendererService,
      hintDedup,
    );

    docSpaceService = new DocSpaceService(
      ds.getRepository(DocSpace),
      ds.getRepository(DocSpaceMember),
      ds.getRepository(DocCategory),
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(TaskDocLink),
      ds.getRepository(DocRoute),
      ds.getRepository(Agent),
      ds.getRepository(User),
      ds.getRepository(Actor),
      ds.getRepository(Board),
      ds.getRepository(Topic),
      {} as unknown as AccessQueryService,
      {} as unknown as ResourceValidator,
      eventStub,
      {} as unknown as ActorProfileService,
      auditStub,
      hintDedup,
    );

    const docLinksService = new DocLinksService(
      ds.getRepository(Doc) as never,
      ds.getRepository(DocSection) as never,
      docService,
    );

    docMoveService = new DocMoveService(
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(DocRoute),
      ds.getRepository(TaskDocLink),
      ds.getRepository(AuditLog),
      ds.getRepository(IdempotencyRecord),
      docService,
      docLinksService,
      eventStub,
      hintDedup,
    );

    docRouteService = new DocRouteService(
      ds.getRepository(DocRoute),
      ds.getRepository(Doc),
      docService,
      auditStub,
      hintDedup,
    );

    docSearchService = new DocSearchService(
      ds.getRepository(DocSection),
      ds.getRepository(Doc),
      ds.getRepository(DocRoute),
      ds.getRepository(TaskDocLink),
      { isEnabled: () => false, run: jest.fn(), recordSkip: jest.fn() } as never,
      hintDedup,
    );

    docBundleService = new DocBundleService(
      docSpaceService,
      docService,
      docRouteService,
      {} as unknown as AttachmentService,
      ds.getRepository(DocSpace),
      ds.getRepository(DocCategory),
      ds.getRepository(Doc),
      ds.getRepository(DocRoute),
    );

    const creator = '00000000-0000-4000-8000-0000000000ee';
    const makeSpace = (label: string, settings: Record<string, unknown>) =>
      ds.getRepository(DocSpace).save(
        ds.getRepository(DocSpace).create({
          name: `Hints E2E ${label} ${RUN}`,
          slug: `hints-${label}-${RUN}`.slice(0, 128),
          description: null,
          creatorId: creator,
          settings,
        }),
      );

    spaceAllOnId = (
      await makeSpace('on', {
        hintToggles: allFamiliesOn,
        canonicalTags,
        pathTypes,
        overviewFilter,
      })
    ).id;
    spaceAllOffId = (await makeSpace('off', {})).id;
    spaceDirtyId = (await makeSpace('dirty', {})).id;
    // m4：族全关（无 hintToggles）但声明了 canonicalTags → 归一仍发生 ⇒ 只有
    // tags_normalized（它不挂族闸门，是「动作已发生」的事实回显）
    spaceOffWithVocabId = (await makeSpace('off-vocab', { canonicalTags })).id;

    // 脏 hintToggles：直改库注入（模拟历史版本 / 手工改库——DTO 与 bundle 都不经此路）
    await ds
      .getRepository(DocSpace)
      .createQueryBuilder()
      .update('DocSpace')
      .set({ settings: { hintToggles: { metadata: 'yes', bogus: true, routes: true } } } as never)
      .where('id = :id', { id: spaceDirtyId })
      .execute();
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    const ids = [spaceAllOnId, spaceAllOffId, spaceDirtyId, spaceOffWithVocabId].filter(Boolean);
    if (ids.length > 0) {
      await ds
        .getRepository(Doc)
        .createQueryBuilder()
        .delete()
        .where('space_id IN (:...ids)', { ids })
        .execute();
      await ds
        .getRepository(DocRoute)
        .createQueryBuilder()
        .delete()
        .where('space_id IN (:...ids)', { ids })
        .execute();
      await ds
        .getRepository(DocCategory)
        .createQueryBuilder()
        .delete()
        .where('space_id IN (:...ids)', { ids })
        .execute();
      await ds
        .getRepository(DocSpace)
        .createQueryBuilder()
        .delete()
        .where('id IN (:...ids)', { ids })
        .execute();
    }
    await ds.destroy();
  }, 30000);

  beforeEach(() => {
    // 每个用例独立窗口（除显式断言去重语义的用例内部自控）
    hintDedup?.reset();
  });

  // ─── ① 开关 roundtrip / 422 / merge 语义 ────────────────────────────────

  describe('hintToggles 配置面', () => {
    it('PATCH roundtrip：六族 boolean 落 settings jsonb 并可读回', async () => {
      if (!dbAvailable) return;
      const updated = await docSpaceService.update(spaceAllOffId, {
        hintToggles: { metadata: true, routes: true },
      });
      expect(updated.settings.hintToggles).toEqual({ metadata: true, routes: true });
      expect((await settingsOf(spaceAllOffId)).hintToggles).toEqual({
        metadata: true,
        routes: true,
      });
    });

    it('merge 语义：出现即整键替换 / 显式 null 删键 / 未传保留', async () => {
      if (!dbAvailable) return;
      await docSpaceService.update(spaceAllOffId, { hintToggles: { metadata: true, tags: true } });
      // 整键替换（不是逐键合并）
      await docSpaceService.update(spaceAllOffId, { hintToggles: { routes: true } });
      expect((await settingsOf(spaceAllOffId)).hintToggles).toEqual({ routes: true });
      // 未传其他键 → 保留
      await docSpaceService.update(spaceAllOffId, { name: `Hints E2E off ${RUN}` });
      expect((await settingsOf(spaceAllOffId)).hintToggles).toEqual({ routes: true });
      // 显式 null → 删键
      await docSpaceService.update(spaceAllOffId, { hintToggles: null });
      expect((await settingsOf(spaceAllOffId)).hintToggles).toBeUndefined();
    });

    it('422：未知族键 / 非 boolean 值（带修复凭据），且零写入', async () => {
      if (!dbAvailable) return;
      await docSpaceService.update(spaceAllOffId, { hintToggles: { metadata: true } });

      await expect(
        docSpaceService.update(spaceAllOffId, {
          hintToggles: { metdata: true } as never,
        }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_SPACE_HINT_TOGGLES_INVALID,
          data: { unknownKeys: ['metdata'] },
        },
      });

      await expect(
        docSpaceService.update(spaceAllOffId, { hintToggles: { metadata: 'yes' } as never }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_SPACE_HINT_TOGGLES_INVALID,
          data: { invalidKeys: ['metadata'] },
        },
      });

      // 422 零写入：仍是上一次成功值
      expect((await settingsOf(spaceAllOffId)).hintToggles).toEqual({ metadata: true });
    });

    it('DTO 层格式闸门：非对象 → 校验失败（service 之前拦截）', async () => {
      if (!dbAvailable) return;
      const errors = await validate(
        plainToInstance(UpdateDocSpaceDto, { hintToggles: 'metadata' }),
      );
      expect(errors.length).toBeGreaterThan(0);
      // 合法对象（含未知族键——业务层管）通过格式校验
      expect(
        await validate(plainToInstance(UpdateDocSpaceDto, { hintToggles: { metdata: true } })),
      ).toHaveLength(0);
    });

    it('bundle settings 过滤：合法 hintToggles 保留、脏键/异形值剔除（fail-open 不阻断导入）', async () => {
      if (!dbAvailable) return;
      const overwrite = (
        docBundleService as unknown as {
          overwriteSpaceMeta: (
            space: DocSpace,
            meta: Record<string, unknown>,
          ) => Promise<{ applied: boolean }>;
        }
      ).overwriteSpaceMeta.bind(docBundleService);

      const space = await ds
        .getRepository(DocSpace)
        .findOneOrFail({ where: { id: spaceAllOffId } });
      await overwrite(space, {
        name: `Hints E2E off ${RUN}`,
        settings: { hintToggles: { metadata: true, bogus: true, routes: 'yes' } },
      });

      expect((await settingsOf(spaceAllOffId)).hintToggles).toEqual({ metadata: true });
    });
  });

  // ─── ② 族关 = 零 hints（稀疏触发默认面）────────────────────────────────

  describe('族关（默认面）', () => {
    it('族全关 + 无归一：写路径零 hints（hints 键不出现，禁空数组）', async () => {
      if (!dbAvailable) return;
      // 前置用例会写本空间开关 → 先回到「未配」态（缺省 = 全关）
      await docSpaceService.update(spaceAllOffId, { hintToggles: null });
      // ⚠️ 本用例只覆盖「无归一」形态：所有挂族闸门的 hint 都被关掉，且本空间未声明
      // canonicalTags ⇒ 无 tags_normalized。**「族关 = 零 hints」不是普遍命题**——
      // tags_normalized 不挂闸门（下一用例）
      const result = await docService.upsert(
        spaceAllOffId,
        { path: `docs/off-${RUN}.md`, content: '# 无元数据\n\n正文', summary: '' },
        testActor,
      );
      expect(result.hints).toBeUndefined();
      expect(Object.keys(result)).not.toContain('hints');
    });

    it('族全关 + alias tag 命中：响应**只有** tags_normalized（m4：无族事实回显）', async () => {
      if (!dbAvailable) return;
      // 本空间族全关（无 hintToggles 键），但声明了 canonicalTags ⇒ alias 归一照常发生。
      // tags_normalized 是「动作已发生」的事实回显，**不挂族闸门**（D1 定形）——
      // 它是族关面唯一的 hints 来源。
      const result = await docService.upsert(
        spaceOffWithVocabId,
        {
          path: `docs/off-alias-${RUN}.md`,
          content: '# 族关归一\n\n正文',
          summary: '',
          tags: ['NPC'],
        },
        testActor,
      );

      expect(result.hints?.map((h) => h.code)).toEqual(['tags_normalized']);
      expect(hintOf(result.hints, 'tags_normalized')?.status).toBe('normalized');
      expect(hintOf(result.hints, 'tags_normalized')?.data).toEqual({
        mappings: [{ from: 'NPC', to: 'npc' }],
      });
      // 落库值确已归一（事实与回显一致）
      const stored = await readDoc(result.id);
      expect(stored?.tags).toEqual(['npc']);
      // 挂闸门的族一个都不出现（族全关）
      for (const code of ['missing_category', 'empty_summary', 'empty_tags'] as const) {
        expect(hintOf(result.hints, code)).toBeUndefined();
      }
    });

    it('脏 hintToggles（非 boolean / 未知键）：只留合法族，其余静默剔除（读侧形状闸门）', async () => {
      if (!dbAvailable) return;
      const space = await ds.getRepository(DocSpace).findOneOrFail({ where: { id: spaceDirtyId } });
      const facets = await docService.findFacets(spaceDirtyId, space.settings);
      expect(facets.vocabulary?.hintToggles).toEqual({ routes: true });
    });
  });

  // ─── ③ 写侧矩阵（六族）────────────────────────────────────────────────

  describe('写侧 hints 矩阵', () => {
    it('metadata 族：落库后无分类/无标签/空摘要 → 三条 suggestion', async () => {
      if (!dbAvailable) return;
      const result = await docService.upsert(
        spaceAllOnId,
        { path: `docs/meta-${RUN}.md`, content: '# 标题\n\n正文', summary: '' },
        testActor,
      );
      const codes = (result.hints ?? []).map((h) => h.code).sort();
      expect(codes).toEqual(['empty_summary', 'empty_tags', 'missing_category']);
      expect(hintOf(result.hints, 'missing_category')?.status).toBe('suggestion');
    });

    it('pathType 族：最长前缀优先（memory/daily/ → diary 而非 memory）', async () => {
      if (!dbAvailable) return;
      const result = await docService.upsert(
        spaceAllOnId,
        {
          path: `memory/daily/${RUN}.md`,
          content: '# 日记\n\n正文',
          docType: 'note',
          summary: '摘要',
          category: '日记',
          tags: ['x'],
        },
        testActor,
      );
      const hint = hintOf(result.hints, 'path_type_mismatch');
      expect(hint?.status).toBe('check_failed');
      expect(hint?.data).toEqual({
        pathPrefix: 'memory/daily/',
        expected: 'diary',
        actual: 'note',
      });
    });

    it('tags 族：词表外 tag 有近义 → 只出候选不判同；词表内 tag 已被归一吸收不再判', async () => {
      if (!dbAvailable) return;
      // 先造池：写入 canonical 值
      await docService.upsert(
        spaceAllOnId,
        { path: `docs/pool-${RUN}.md`, content: '# 池\n\n正文', tags: ['npc'], summary: 's' },
        testActor,
      );
      // 词表外但近义（'npcs' vs 'npc' 相似度 < 0.5，用更长词保证过阈值）
      const near = await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/near-${RUN}.md`,
          content: '# 近义\n\n正文',
          tags: ['openviking'],
          summary: 's',
        },
        testActor,
      );
      // 'openviking' 与 'npc' 不相似 → 无 tag_near_dup（池里没有近义项）
      expect(hintOf(near.hints, 'tag_near_dup')).toBeUndefined();

      // 写入与池内 'openviking' 高度相似的词 → 出候选
      const dup = await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/dup-${RUN}.md`,
          content: '# 近义2\n\n正文',
          tags: ['openvikings'],
          summary: 's',
        },
        testActor,
      );
      const hint = hintOf(dup.hints, 'tag_near_dup');
      expect(hint?.status).toBe('suggestion');
      expect(hint?.data).toEqual({
        tag: 'openvikings',
        candidates: [{ value: 'openviking', count: expect.any(Number) }],
      });
    });

    it('tags_normalized：alias 归一事实回显（无族、status=normalized）', async () => {
      if (!dbAvailable) return;
      const result = await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/norm-${RUN}.md`,
          content: '# 归一\n\n正文',
          tags: ['NPC'],
          summary: 's',
        },
        testActor,
      );
      const hint = hintOf(result.hints, 'tags_normalized');
      expect(hint?.status).toBe('normalized');
      expect(hint?.data).toEqual({ mappings: [{ from: 'NPC', to: 'npc' }] });
      expect(result.tagNormalizations).toEqual([{ from: 'NPC', to: 'npc' }]);
    });

    it('categories 族：自动建近义分类 → 出候选（created 信号 A6）', async () => {
      if (!dbAvailable) return;
      // 既有分类
      await docSpaceService.createCategory(spaceAllOnId, { name: 'Design' });
      // 近义判据 = trigram Jaccard ≥ 0.5（宁高勿低防误报）：Design/Designs ≈ 0.67 过线，
      // 而 Desgin/Design ≈ 0.27 不过线——用前者验证触发
      const result = await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/cat-${RUN}.md`,
          content: '# 分类\n\n正文',
          category: 'Designs',
          summary: 's',
        },
        testActor,
      );
      const hint = hintOf(result.hints, 'category_near_dup');
      expect(hint?.status).toBe('suggestion');
      expect((hint?.data as { created: string }).created).toBe('Designs');
      expect((hint?.data as { candidates: unknown[] }).candidates).toEqual([
        { name: 'Design', slug: 'design' },
      ]);
    });

    it('≤3 截断 + D6 优先级：多族同触发只留最高优先级三条', async () => {
      if (!dbAvailable) return;
      const result = await docService.upsert(
        spaceAllOnId,
        {
          path: `memory/daily/cap-${RUN}.md`,
          content: '# 截断\n\n正文',
          docType: 'note',
          summary: '',
          tags: ['openvikings'],
        },
        testActor,
      );
      expect(result.hints?.length).toBe(3);
      expect(result.hints?.map((h) => h.code)).toEqual([
        'path_type_mismatch',
        'tag_near_dup',
        'missing_category',
      ]);
    });
  });

  // ─── ③b 写侧 hint 作用域收窄 + 实体锚点抑制（批 1 回归）───────────────────
  //
  // 契约（plan nightwing-polaris-phil-coulson 一、设计契约）：**比较型 hint
  // （tag_near_dup）在请求未携带对应数据时不评估**；状态型 hint（metadata/pathType
  // 族 advisory）维持原语义（unchanged 出口照发）。
  //
  // 种子原则：全部就地播种，且**只复用既有池值**（'openviking'/'openvikings'）——
  // 上面 546-549 与 610-612 的精确断言锁定 candidates 形状，引入新的近义 tag 会
  // 让它们变红（测试间污染）。
  //
  // 这四条用例**不写 `if (!dbAvailable) return;`**：静默跳过的用例不可能红，
  // 计数凭证没有判别力（plan 三、流程铁律 3）——PG 不可达时直接红。
  describe('写侧 hint 作用域收窄（批 1）', () => {
    it('Wayward 回归：patch_metadata 未携带 tags → 不对存量 tags 跑 tag_near_dup', async () => {
      expect(dbAvailable).toBe(true);
      // 池：既有 'openviking'（复用池值，不新增近义竞争项）
      await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/scope-pool-${RUN}.md`,
          content: '# 池\n\n正文',
          tags: ['openviking'],
          summary: 's',
        },
        testActor,
      );
      // 目标文档：落库 tags 含词表外近义 tag——修复前它正是「回退闸门」的输入
      const target = await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/scope-target-${RUN}.md`,
          content: '# 目标\n\n正文',
          tags: ['openvikings'],
          summary: 's',
        },
        testActor,
      );
      // 窗口复位：seed upsert 已占用 (actor, tag_near_dup, docId) 窗口（hint-emit），
      // 不复位则修复前也天然绿 = 零判别力
      hintDedup.reset();

      const hash = (await readDoc(target.id))!.contentHash!;
      const result = await docService.patchMetadata(
        target.id,
        // 只改 docType（**不携带 tags**）——存量 tags 由 doc.tags 提供
        { docType: 'note', expectedContentHash: hash },
        testActor,
      );

      // 修复前：postWriteTags = resolvedTags ?? doc.tags 回退取存量 → 池加载 → 误报
      // 修复后：请求未携带 tags → 闸门 false → 零池加载 → 无该 hint
      // 存在性前置（堵「空真」通道）：本路径确实产 missing_category → 证明 hints 非空，
      // 下面的 toBeUndefined 是「该 hint 缺席」而非「hints 整个没产出」
      expect(hintOf(result.hints, 'missing_category')).toBeDefined();
      expect(hintOf(result.hints, 'tag_near_dup')).toBeUndefined();
    });

    it('能力保留：patch_metadata 携带 tags（值不变）→ tag_near_dup 照常发', async () => {
      expect(dbAvailable).toBe(true);
      await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/scope-pool2-${RUN}.md`,
          content: '# 池2\n\n正文',
          tags: ['openviking'],
          summary: 's',
        },
        testActor,
      );
      const target = await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/scope-keep-${RUN}.md`,
          content: '# 保留\n\n正文',
          tags: ['openvikings'],
          summary: 's',
        },
        testActor,
      );
      hintDedup.reset();

      const hash = (await readDoc(target.id))!.contentHash!;
      const result = await docService.patchMetadata(
        target.id,
        // 值不变 ⇒ unchanged 出口——本平台 deliberate 设计：零写操作 ≠ 零建议
        { tags: ['openvikings'], expectedContentHash: hash },
        testActor,
      );

      expect(result.unchanged).toBe(true);
      const hint = hintOf(result.hints, 'tag_near_dup');
      expect(hint?.status).toBe('suggestion');
      expect(hint?.data).toEqual({
        tag: 'openvikings',
        candidates: [{ value: 'openviking', count: expect.any(Number) }],
      });
    });

    it('Kimi 回归：实体锚点 tag（ISO 日期）不参与近义比对', async () => {
      expect(dbAvailable).toBe(true);
      // path 取非 pathTypes 前缀（docs/）——防 path_type_mismatch 抢占 ≤3 名额造成
      // 「无 tag_near_dup」假绿
      await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/anchor-pool-${RUN}.md`,
          content: '# 日期池\n\n正文',
          tags: ['2026-05-05'],
          summary: 's',
        },
        testActor,
      );
      const result = await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/anchor-${RUN}.md`,
          content: '# 日期\n\n正文',
          tags: ['2026-10-05'],
          summary: 's',
        },
        testActor,
      );

      // 修复前：trigram('2026-10-05','2026-05-05') = 0.5000 压线过阈 → 误报（红）
      // 修复后：两侧锚点均被抑制（池预过滤 + 输入过滤同源）→ 无 hint（绿）
      // 存在性前置（堵「空真」通道）：本路径确实产 missing_category → 证明 hints 非空，
      // 下面的 toBeUndefined 才是「该 hint 缺席」而非「hints 整个没产出」
      expect(hintOf(result.hints, 'missing_category')).toBeDefined();
      expect(hintOf(result.hints, 'tag_near_dup')).toBeUndefined();
    });

    it('tags 族窗口：同 doc 连发两次携带相同词表外 tags → 第二次被窗口压制', async () => {
      expect(dbAvailable).toBe(true);
      await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/scope-pool3-${RUN}.md`,
          content: '# 池3\n\n正文',
          tags: ['openviking'],
          summary: 's',
        },
        testActor,
      );
      const target = await docService.upsert(
        spaceAllOnId,
        {
          path: `docs/scope-window-${RUN}.md`,
          content: '# 窗口\n\n正文',
          tags: ['openvikings'],
          summary: 's',
        },
        testActor,
      );
      hintDedup.reset();

      const hash = (await readDoc(target.id))!.contentHash!;
      const first = await docService.patchMetadata(
        target.id,
        { tags: ['openvikings'], expectedContentHash: hash },
        testActor,
      );
      expect(hintOf(first.hints, 'tag_near_dup')).toBeDefined();

      const second = await docService.patchMetadata(
        target.id,
        { tags: ['openvikings'], expectedContentHash: hash },
        testActor,
      );
      expect(hintOf(second.hints, 'tag_near_dup')).toBeUndefined();
    });
  });

  // ─── ④ 路由锚分级（A2/A3/A4）────────────────────────────────────────────

  describe('routes 族：锚分级', () => {
    async function seedRouteDoc(): Promise<{ docId: string; path: string }> {
      const path = `docs/route-target-${RUN}.md`;
      const result = await docService.upsert(
        spaceAllOnId,
        { path, content: '## 标题A\n\n正文', summary: 's', tags: ['npc'] },
        testActor,
      );
      return { docId: result.id, path };
    }

    it('upsert 改 heading → route_anchor_broken（事务内 in-memory chunks 比对，A4）', async () => {
      if (!dbAvailable) return;
      const { docId, path } = await seedRouteDoc();
      await docRouteService.create(
        spaceAllOnId,
        { intent: `锚 ${RUN}`, primaryDocId: docId, primaryHeadingPath: '标题A' },
        testActor,
      );

      const result = await docService.upsert(
        spaceAllOnId,
        { path, content: '## 标题B\n\n正文', summary: 's', tags: ['npc'] },
        testActor,
      );
      const hint = hintOf(result.hints, 'route_anchor_broken');
      expect(hint?.status).toBe('check_failed');
      const data = hint?.data as { routeIds: string[]; anchors: unknown[] };
      expect(data.routeIds.length).toBe(1);
      expect(data.anchors).toEqual([{ routeId: data.routeIds[0], headingPath: '标题A' }]);
    });

    it('引用路由 >20 条 → route_anchor_recheck 以 check_skipped 发出（未检查 ≠ 健康）', async () => {
      if (!dbAvailable) return;
      const path = `docs/route-cap-${RUN}.md`;
      const created = await docService.upsert(
        spaceAllOnId,
        { path, content: '## 标题A\n\n正文', summary: 's', tags: ['npc'] },
        testActor,
      );
      for (let i = 0; i < 21; i++) {
        await docRouteService.create(
          spaceAllOnId,
          { intent: `cap ${i} ${RUN}`, primaryDocId: created.id },
          testActor,
        );
      }

      const result = await docService.upsert(
        spaceAllOnId,
        { path, content: '## 标题C\n\n正文', summary: 's', tags: ['npc'] },
        testActor,
      );
      const hint = hintOf(result.hints, 'route_anchor_recheck');
      expect(hint?.status).toBe('check_skipped');
      expect((hint?.data as { reason: string }).reason).toBe('too_many_affected');
      // 超 cap 时不报 broken（检查未执行）
      expect(hintOf(result.hints, 'route_anchor_broken')).toBeUndefined();
    });

    it('move → route_anchor_recheck（复用 impact.docRoutes，dryRun 同发，A3）', async () => {
      if (!dbAvailable) return;
      const { docId, path } = await seedRouteDoc();
      await docRouteService.create(
        spaceAllOnId,
        { intent: `move ${RUN}`, primaryDocId: docId, primaryHeadingPath: '标题A' },
        testActor,
      );

      const dry = await docMoveService.move(docId, {
        toPath: `docs/route-target-moved-${RUN}.md`,
        dryRun: true,
      } as never);
      expect(dry.hints?.map((h) => h.code)).toContain('route_anchor_recheck');
      expect(hintOf(dry.hints, 'route_anchor_recheck')?.status).toBe('suggestion');

      // BLOCKER-1 真断言：**不重置窗口**——dryRun 预演不占窗口（markWindow:false），
      // 紧随其后的正式 move 必须照样带 hints（预演视图与实际一致）
      const moved = await docMoveService.move(docId, {
        toPath: `docs/route-target-moved-${RUN}.md`,
      } as never);
      expect(moved.moved).toBe(true);
      expect(moved.hints?.map((h) => h.code)).toEqual(['route_anchor_recheck']);
      // move 不断锚：绝不报 broken
      expect(hintOf(moved.hints, 'route_anchor_broken')).toBeUndefined();
      expect(moved.oldPath).toBe(path);
    });

    it('dryRun 预演不占窗口：连发两次 dryRun 都带 hints（正式路径同理）', async () => {
      if (!dbAvailable) return;
      const { docId } = await seedRouteDoc();
      await docRouteService.create(
        spaceAllOnId,
        { intent: `move-dry2 ${RUN}`, primaryDocId: docId, primaryHeadingPath: '标题A' },
        testActor,
      );

      const first = await docMoveService.move(docId, {
        toPath: `docs/route-dry2-a-${RUN}.md`,
        dryRun: true,
      } as never);
      const second = await docMoveService.move(docId, {
        toPath: `docs/route-dry2-b-${RUN}.md`,
        dryRun: true,
      } as never);

      expect(first.hints?.map((h) => h.code)).toEqual(['route_anchor_recheck']);
      expect(second.hints?.map((h) => h.code)).toEqual(['route_anchor_recheck']);
      // 窗口未被任何一次预演占用（正式请求仍可送达）
      expect(hintDedup.isSuppressed(testActor.id, 'route_anchor_recheck', docId)).toBe(false);
    });

    it('delete → route_anchor_broken（docId 锚断 = 语义判定，无 cap）', async () => {
      if (!dbAvailable) return;
      const { docId } = await seedRouteDoc();
      await docRouteService.create(
        spaceAllOnId,
        { intent: `del ${RUN}`, primaryDocId: docId, primaryHeadingPath: '标题A' },
        testActor,
      );

      const removed = await docService.remove(docId, undefined, testActor);
      expect(removed.deleted).toBe(true);
      expect(hintOf(removed.hints, 'route_anchor_broken')?.status).toBe('check_failed');
    });

    it('route_target_excluded：primaryDoc 被空间 overviewFilter 排除（type 维度）', async () => {
      if (!dbAvailable) return;
      const created = await docService.upsert(
        spaceAllOnId,
        {
          path: `memory/excluded-${RUN}.md`,
          content: '# 被排除\n\n正文',
          docType: 'memory',
          summary: 's',
          tags: ['npc'],
        },
        testActor,
      );

      const route = await docRouteService.create(
        spaceAllOnId,
        { intent: `excluded ${RUN}`, primaryDocId: created.id },
        testActor,
      );
      const hint = hintOf(route.hints, 'route_target_excluded');
      expect(hint?.status).toBe('suggestion');
      expect((hint?.data as { matchedExclusion: unknown }).matchedExclusion).toEqual({
        kind: 'type',
        value: 'memory',
      });
    });
  });

  // ─── ⑤ 读侧两条 + 双写（A1）────────────────────────────────────────────

  describe('读侧 hints（search）', () => {
    it('query_looks_like_path：形似路径且本空间存在该 doc → suggestion', async () => {
      if (!dbAvailable) return;
      const path = `docs/read-target-${RUN}.md`;
      await docService.upsert(
        spaceAllOnId,
        { path, content: '# 读目标\n\n正文', summary: 's', tags: ['npc'] },
        testActor,
      );

      const res = await docSearchService.search(
        [spaceAllOnId],
        { q: path, limit: 5 },
        {
          actor: testActor,
          hintContext: { spaceId: spaceAllOnId, settings: await settingsOf(spaceAllOnId) },
        },
      );
      const hint = hintOf(res.hints, 'query_looks_like_path');
      expect(hint?.status).toBe('suggestion');
      expect((hint?.data as { path: string }).path).toBe(path);
    });

    it('suggest_relaxing：零命中 + 显式筛选 → 只回显真实用过的可筛参数', async () => {
      if (!dbAvailable) return;
      const res = await docSearchService.search(
        [spaceAllOnId],
        { q: `绝无此词-${RUN}`, type: 'memory', sort: 'createdAt_desc', limit: 5 },
        {
          actor: testActor,
          hintContext: { spaceId: spaceAllOnId, settings: await settingsOf(spaceAllOnId) },
        },
      );
      const hint = hintOf(res.hints, 'suggest_relaxing');
      expect(hint?.status).toBe('suggestion');
      const data = hint?.data as {
        appliedFilters: Record<string, unknown>;
        removableParams: string[];
      };
      expect(data.appliedFilters).toEqual({ type: 'memory' });
      expect(data.removableParams).toEqual(['type']);
      // 旧三态双写：零命中同时进 hints[]
      expect(hintOf(res.hints, 'zero_hit')?.data).toEqual({ q: `绝无此词-${RUN}` });
      expect(res.hintCode).toBe('zero_hit');
      expect(typeof res.hint).toBe('string');
    });

    it('未传 hintContext（全局检索面）→ 零读侧 hints（A1：不泄漏不额外查询）', async () => {
      if (!dbAvailable) return;
      const res = await docSearchService.search([spaceAllOnId], {
        q: `绝无此词-${RUN}`,
        limit: 5,
      });
      expect(hintOf(res.hints, 'query_looks_like_path')).toBeUndefined();
      expect(hintOf(res.hints, 'suggest_relaxing')).toBeUndefined();
      // 旧三态双写仍发生（无害，全局面只解构 hits）
      expect(hintOf(res.hints, 'zero_hit')).toBeDefined();
    });

    it('read 族关 → 零读侧 hints（族关零行为变化）', async () => {
      if (!dbAvailable) return;
      await docSpaceService.update(spaceAllOnId, {
        hintToggles: { ...allFamiliesOn, read: false },
      });
      const res = await docSearchService.search(
        [spaceAllOnId],
        { q: `绝无此词2-${RUN}`, type: 'memory' },
        {
          actor: testActor,
          hintContext: { spaceId: spaceAllOnId, settings: await settingsOf(spaceAllOnId) },
        },
      );
      expect(hintOf(res.hints, 'suggest_relaxing')).toBeUndefined();
      await docSpaceService.update(spaceAllOnId, { hintToggles: allFamiliesOn });
    });
  });

  // ─── ⑥ 去重窗口 / unchanged / 幂等重放 ─────────────────────────────────

  describe('去重窗口与边界', () => {
    it('同 (actor,code,doc) 二次触发 → hints 省略（窗口压制）', async () => {
      if (!dbAvailable) return;
      const path = `docs/dedup-${RUN}.md`;
      const created = await docService.upsert(
        spaceAllOnId,
        { path, content: '# 去重\n\n正文', summary: '', tags: ['npc'] },
        testActor,
      );
      // 首次：metadata 族 hints 在场（empty_summary）
      expect(hintOf(created.hints, 'empty_summary')).toBeDefined();

      // upsert 已占用该 (actor,code,doc) 窗口 → 重置后再验证 patchMetadata 的压制语义
      hintDedup.reset();
      const hash = (await readDoc(created.id))!.contentHash!;
      const first = await docService.patchMetadata(
        created.id,
        { summary: '', expectedContentHash: hash },
        testActor,
      );
      expect(hintOf(first.hints, 'empty_summary')).toBeDefined();

      // 第二次同 payload → unchanged 出口仍计算 hints，但被窗口压制 → 键不出现
      const second = await docService.patchMetadata(
        created.id,
        { summary: '', expectedContentHash: hash },
        testActor,
      );
      expect(second.unchanged).toBe(true);
      expect(second.hints).toBeUndefined();
    });

    it('normalized 态不参与去重：两次请求都回显 tags_normalized', async () => {
      if (!dbAvailable) return;
      const path = `docs/dedup-norm-${RUN}.md`;
      const created = await docService.upsert(
        spaceAllOnId,
        { path, content: '# 归一去重\n\n正文', summary: 's', tags: ['NPC'] },
        testActor,
      );
      expect(hintOf(created.hints, 'tags_normalized')).toBeDefined();

      const hash = (await readDoc(created.id))!.contentHash!;
      const first = await docService.patchMetadata(
        created.id,
        { tags: ['NPC'], expectedContentHash: hash },
        testActor,
      );
      expect(hintOf(first.hints, 'tags_normalized')).toBeDefined();

      const second = await docService.patchMetadata(
        created.id,
        { tags: ['NPC'], expectedContentHash: hash },
        testActor,
      );
      expect(second.unchanged).toBe(true);
      expect(hintOf(second.hints, 'tags_normalized')).toBeDefined();
    });

    it('unchanged 边界：upsert 内容未变 → 零 hints；patchMetadata unchanged → metadata 族 hints 仍在', async () => {
      if (!dbAvailable) return;
      const path = `docs/unchanged-${RUN}.md`;
      const created = await docService.upsert(
        spaceAllOnId,
        { path, content: '# 未变\n\n正文', summary: '', tags: ['npc'] },
        testActor,
      );
      hintDedup.reset();
      const again = await docService.upsert(
        spaceAllOnId,
        { path, content: '# 未变\n\n正文', summary: '', tags: ['npc'] },
        testActor,
      );
      expect(again.unchanged).toBe(true);
      expect(again.hints).toBeUndefined();

      hintDedup.reset();
      const hash = (await readDoc(created.id))!.contentHash!;
      const patched = await docService.patchMetadata(
        created.id,
        { summary: '', expectedContentHash: hash },
        testActor,
      );
      expect(hintOf(patched.hints, 'empty_summary')).toBeDefined();
    });

    it('幂等重放：返回首次 hints 快照；replay 不消耗窗口', async () => {
      if (!dbAvailable) return;
      const path = `docs/idem-${RUN}.md`;
      const key = `hints-idem-${RUN}`;
      const first = await docService.upsert(
        spaceAllOnId,
        { path, content: '# 幂等\n\n正文', summary: '', tags: ['npc'] },
        testActor,
        key,
      );
      expect(hintOf(first.hints, 'empty_summary')).toBeDefined();

      const replay = await docService.upsert(
        spaceAllOnId,
        { path, content: '# 幂等\n\n正文', summary: '', tags: ['npc'] },
        testActor,
        key,
      );
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.hints).toEqual(first.hints);
    });
  });

  // ─── ⑦ facets 回显（P1）────────────────────────────────────────────────

  describe('facets vocabulary 回显', () => {
    it('回显 hintToggles 现状（与三词表键并列）', async () => {
      if (!dbAvailable) return;
      const space = await ds.getRepository(DocSpace).findOneOrFail({ where: { id: spaceAllOnId } });
      const facets = await docService.findFacets(spaceAllOnId, space.settings);
      expect(facets.vocabulary?.hintToggles).toEqual(space.settings.hintToggles);
      expect(facets.vocabulary?.canonicalTags).toEqual(canonicalTags);
      expect(facets.vocabulary?.pathTypes).toEqual(pathTypes);
    });
  });
});
