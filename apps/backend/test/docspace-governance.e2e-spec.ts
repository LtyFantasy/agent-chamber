/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 存量元数据治理（v1.92.0-dev 3 期）的**真库**验证面：全空间 tag
 *     rename/merge、DocCategory merge、orphan 诊断、读侧 alias 集合展开。
 *
 * [代码职责]
 *   - 覆盖 plan §4 步骤 6 的全矩阵：dryRun 零副作用、batchToken 409 abort-all、
 *     幂等 replay、词表未声明时创建词表键、canonical 合并/alias 迁移、数组去重、
 *     updated_at 不 bump、ingest 报告、审计汇总行 oldData 前快照；category merge 的
 *     重指向/软删/软引用修正/422/404；orphan 的覆盖口径/默认排除/includeExcluded/
 *     pathPrefix/byTopDir/分页/stats；读侧 rename 后新旧值都命中、全局搜索不扩展。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（三端点契约）与 §16.9b（facets 词表回显）
 *   - 补充: plan black-widow-rocket-nightwing.md §5（验收清单）
 *
 * [关键不变量]
 *   - **必须打真实 PG**（铁律 #23）：`array_replace` / `ARRAY(SELECT DISTINCT unnest())` /
 *     `&&` 重叠 / jsonb settings RMW / 事务锁序全是 ORM 与 SQL 生成行为，mock 一律测不出；
 *   - 审计断言打**真实 audit_logs 行**（需要 migration 1791600000000 已应用——
 *     枚举缺值会让 fail-open 的 AuditService 静默丢行，本套件因此也是该 migration 的
 *     集成级守门）；
 *   - 测试数据带 RUN 后缀隔离，afterAll 按 space_id 硬删兜底。
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/doc-rename.service.ts — renameTags / mergeCategory
 *   - apps/backend/src/modules/docspace/doc-vocabulary.helper.ts — 词表变换与查询展开纯函数
 *   - apps/backend/src/modules/docspace/doc.service.ts — findOrphans / findAll（tag 展开）
 *   - apps/backend/src/modules/docspace/doc-search.service.ts — search（hintContext 通道展开）
 *   - apps/backend/test/docspace-backlinks.e2e-spec.ts — 三端点的**真 HTTP** 断言面
 *     （本文件只做服务级矩阵；HTTP 面复用该套件已装配的 app）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

/**
 * DocSpace 存量治理（3 期）—— 真实 PG 集成套件
 *
 * DB 目标 = 本地开发库 chamber-postgres（env 可覆盖）。PG 不可达时整套降级跳过。
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { ActorType, AuditAction, ErrorCode } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { Board } from '../src/database/entities/board.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { User } from '../src/database/entities/user.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { DocService } from '../src/modules/docspace/doc.service';
import { DocSpaceService } from '../src/modules/docspace/docspace.service';
import { DocRenameService } from '../src/modules/docspace/doc-rename.service';
import { DocSearchService } from '../src/modules/docspace/doc-search.service';
import { RouteHealthService } from '../src/modules/docspace/route-health.service';
import { HintDedupService } from '../src/modules/hints/hint-dedup.service';
import { AuditService } from '../src/modules/audit/audit.service';
import type { EventService } from '../src/modules/event/event.service';
import type { AccessQueryService } from '../src/common/services/access-query.service';
import type { ResourceValidator } from '../src/common/resource-validator';
import type { ActorProfileService } from '../src/common/services/actor-profile.service';
import type { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import type { DiagramRendererService } from '../src/modules/docspace/diagram-renderer.service';
import type { UnifiedActor } from '../src/common/types/actor.types';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实数据互相污染 */
const RUN = `gov-${Date.now().toString(36)}`;

/** 搜索用的稀有 ASCII 标记（唯一 token，避免高频词 df 降级干扰读侧 alias 断言） */
const MARKER = `zzgovmark${Date.now().toString(36)}`;

/** 固定测试 actor（docs.created_by 为 uuid 列，'system' 字面量会被 PG 拒绝） */
const testActor: UnifiedActor = {
  id: '00000000-0000-4000-8000-0000000000ff',
  type: ActorType.HUMAN,
};

/** 断言 4xx 错误体的 code（NestJS HttpException.response 结构） */
async function expectErrorCode(
  promise: Promise<unknown>,
  code: number,
): Promise<Record<string, unknown>> {
  try {
    await promise;
    throw new Error(`expected rejection with code ${code}, but the call resolved`);
  } catch (err: unknown) {
    const response = (err as { response?: Record<string, unknown> }).response;
    expect(response?.code).toBe(code);
    return response as Record<string, unknown>;
  }
}

describe('DocSpace 存量治理（3 期）— 真实 PG 集成', () => {
  let ds: DataSource;
  let docService: DocService;
  let docSpaceService: DocSpaceService;
  let docRenameService: DocRenameService;
  let docSearchService: DocSearchService;
  let hintDedup: HintDedupService;
  let dbAvailable = false;

  /** rename 矩阵空间（词表未声明——覆盖 P1「无条件生成 alias」） */
  let spaceId: string;
  /** 读侧 alias 空间（同上，供 search/list 断言） */
  let readSpaceId: string;
  /** orphan 空间（带 overviewFilter 默认排除） */
  let orphanSpaceId: string;
  /** merge 矩阵空间 */
  let mergeSpaceId: string;
  /** minor-1 别名上限空间（预置 18 个别名） */
  let capSpaceId: string;

  const createdSpaceIds: string[] = [];

  const spaceOf = async (id: string): Promise<DocSpace> =>
    ds.getRepository(DocSpace).findOneOrFail({ where: { id } });
  const docOf = async (id: string): Promise<Doc | null> =>
    ds.getRepository(Doc).findOne({ where: { id } });

  async function makeSpace(label: string, settings: Record<string, unknown>): Promise<string> {
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `Governance E2E ${label} ${RUN}`,
        slug: `gov-${label}-${RUN}`.slice(0, 128),
        description: null,
        creatorId: testActor.id,
        settings,
      }),
    );
    createdSpaceIds.push(space.id);
    return space.id;
  }

  /** 造一篇文档（走真实 upsert：sections/version/search_vector 一并生成） */
  async function makeDoc(
    spaceId: string,
    path: string,
    tags: string[],
    extra: { docType?: string; source?: string; title?: string } = {},
  ): Promise<Doc> {
    const result = await docService.upsert(
      spaceId,
      {
        path,
        title: extra.title ?? path,
        content: `# ${extra.title ?? path}\n\n${MARKER} body`,
        summary: 'summary',
        docType: extra.docType,
        tags,
        source: extra.source,
      },
      testActor,
    );
    return (await docOf(result.id))!;
  }

  /** 直改库：绕过写路径（模拟并发写 / 存量脏数据） */
  async function setTagsRaw(docId: string, tags: string[]): Promise<void> {
    await ds.query(`UPDATE docs SET tags = $1::text[] WHERE id = $2`, [tags, docId]);
  }

  async function countAuditRows(spaceId: string, action: AuditAction): Promise<number> {
    return ds.getRepository(AuditLog).count({ where: { entityId: spaceId, action } as never });
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
      console.warn(
        `[docspace-governance e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    const eventStub = { create: jest.fn(async () => ({})) } as unknown as EventService;
    const auditService = new AuditService(
      ds.getRepository(AuditLog),
      {} as OwnerProxyService,
      {} as ActorProfileService,
    );
    hintDedup = new HintDedupService();

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
      auditService,
      hintDedup,
    );

    docRenameService = new DocRenameService(
      ds.getRepository(Doc),
      ds.getRepository(DocCategory),
      ds.getRepository(IdempotencyRecord),
      docSpaceService,
      auditService,
    );

    docSearchService = new DocSearchService(
      ds.getRepository(DocSection),
      ds.getRepository(Doc),
      ds.getRepository(DocRoute),
      ds.getRepository(TaskDocLink),
      { isEnabled: () => false, run: jest.fn(), recordSkip: jest.fn() } as never,
      hintDedup,
    );

    spaceId = await makeSpace('rename', {});
    readSpaceId = await makeSpace('read', {});
    orphanSpaceId = await makeSpace('orphan', {
      overviewFilter: { excludeTypes: ['memory'] },
    });
    mergeSpaceId = await makeSpace('merge', {
      overviewFilter: { excludeTypes: ['memory'], excludeCategories: ['gov-source-slug'] },
    });
    // minor-1：别名上限场景（已有 18 个别名 → 单次 rename 再进 4 个必触 20 上限）
    capSpaceId = await makeSpace('cap', {
      canonicalTags: [
        {
          value: 'cap-canon',
          aliases: Array.from({ length: 18 }, (_, i) => `cap-old-${i + 1}`),
        },
      ],
    });
  }, 60000);

  afterAll(async () => {
    if (!dbAvailable) return;
    if (createdSpaceIds.length > 0) {
      const ids = createdSpaceIds;
      // 硬删兜底（顺序：doc 侧引用 → 分类 → 空间；audit/idempotency 行按 entityId 清）
      await ds.query(
        `DELETE FROM doc_sections WHERE doc_id IN (SELECT id FROM docs WHERE space_id = ANY($1::uuid[]))`,
        [ids],
      );
      await ds.query(
        `DELETE FROM doc_versions WHERE doc_id IN (SELECT id FROM docs WHERE space_id = ANY($1::uuid[]))`,
        [ids],
      );
      await ds.query(`DELETE FROM doc_routes WHERE space_id = ANY($1::uuid[])`, [ids]);
      await ds.query(`DELETE FROM docs WHERE space_id = ANY($1::uuid[])`, [ids]);
      await ds.query(`DELETE FROM doc_categories WHERE space_id = ANY($1::uuid[])`, [ids]);
      await ds.query(`DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])`, [ids]);
      await ds.query(`DELETE FROM idempotency_records WHERE entity_id = ANY($1::uuid[])`, [ids]);
      await ds.query(`DELETE FROM doc_spaces WHERE id = ANY($1::uuid[])`, [ids]);
    }
    await ds.destroy();
  }, 60000);

  beforeEach(() => {
    hintDedup?.reset();
  });

  // ─── tag rename / merge ────────────────────────────────────────────────

  describe('tag rename/merge', () => {
    let dNpc: Doc;
    let dUpper: Doc;
    let dOld: Doc;
    let dIngest: Doc;

    beforeAll(async () => {
      if (!dbAvailable) return;
      dNpc = await makeDoc(spaceId, `world/npc-${RUN}.md`, ['npc']);
      dUpper = await makeDoc(spaceId, `world/upper-${RUN}.md`, ['NPC']);
      dOld = await makeDoc(spaceId, `world/old-${RUN}.md`, ['NPC', 'npc-old']);
      dIngest = await makeDoc(spaceId, `world/ingest-${RUN}.md`, ['NPC'], {
        source: 'git:test-repo',
      });
    });

    it('dryRun：完整预演视图 + 零副作用（库行/settings/审计/幂等表零变化）', async () => {
      if (!dbAvailable) return;
      const before = await Promise.all([dNpc, dUpper, dOld, dIngest].map((d) => docOf(d.id)));
      const auditBefore = await countAuditRows(spaceId, AuditAction.RENAME_DOC_TAGS);
      const idemBefore = await ds.getRepository(IdempotencyRecord).count();

      const result = await docRenameService.renameTags(
        spaceId,
        { from: ['NPC', 'npc-old'], to: 'npc', dryRun: true },
        testActor,
      );

      expect(result.dryRun).toBe(true);
      expect(result.batchToken).toMatch(/^[0-9a-f]{64}$/);
      expect(result.affectedDocs?.total).toBe(3); // dNpc 不含 from 值
      expect(result.affectedDocs?.sample.map((s) => s.docId).sort()).toEqual(
        [dUpper.id, dOld.id, dIngest.id].sort(),
      );
      expect(result.perValue).toEqual(
        expect.arrayContaining([
          { value: 'NPC', docCount: 3 },
          { value: 'npc-old', docCount: 1 },
        ]),
      );
      // P1：词表未声明 → 计划里 created=true 且 aliases 含旧值（含 ci 变体）
      expect(result.vocabularyPlan).toMatchObject({ created: true, removedCanonicals: [] });
      expect(result.vocabularyPlan?.addedAliases).toEqual(
        expect.arrayContaining(['NPC', 'npc-old']),
      );
      expect(result.ingestAffected).toEqual([{ docId: dIngest.id, path: dIngest.path }]);

      // 零副作用
      const after = await Promise.all([dNpc, dUpper, dOld, dIngest].map((d) => docOf(d.id)));
      expect(after.map((d) => d?.tags)).toEqual(before.map((d) => d?.tags));
      expect((await spaceOf(spaceId)).settings.canonicalTags).toBeUndefined();
      expect(await countAuditRows(spaceId, AuditAction.RENAME_DOC_TAGS)).toBe(auditBefore);
      expect(await ds.getRepository(IdempotencyRecord).count()).toBe(idemBefore);
    });

    it('execute：改写 tags + 词表键创建 + 保留 docId/contentHash + updated_at 不 bump', async () => {
      if (!dbAvailable) return;
      const before = await Promise.all([dNpc, dUpper, dOld, dIngest].map((d) => docOf(d.id)));

      const result = await docRenameService.renameTags(
        spaceId,
        { from: ['NPC', 'npc-old'], to: 'npc' },
        testActor,
      );

      expect(result.dryRun).toBe(false);
      expect(result.updatedDocs).toBe(3);
      expect(result.renamed).toEqual({ from: ['NPC', 'npc-old'], to: 'npc' });
      expect(result.vocabulary?.created).toBe(true);

      const after = await Promise.all([dNpc, dUpper, dOld, dIngest].map((d) => docOf(d.id)));
      // 保留 docId 与 contentHash；tags 全部收拢为 npc（数组去重生效）
      expect(after.map((d) => d?.id)).toEqual(before.map((d) => d?.id));
      expect(after.map((d) => d?.contentHash)).toEqual(before.map((d) => d?.contentHash));
      expect(after.map((d) => d?.tags)).toEqual([['npc'], ['npc'], ['npc'], ['npc']]);
      // updated_at 不 bump（治理性 metadata 改写不进 updatedAt_desc 排序面）
      expect(after.map((d) => d?.updatedAt.toISOString())).toEqual(
        before.map((d) => d?.updatedAt.toISOString()),
      );

      // 词表键已创建，aliases 含旧值（读侧集合展开的数据源）
      const settings = (await spaceOf(spaceId)).settings;
      expect(settings.canonicalTags).toEqual([
        { value: 'npc', aliases: expect.arrayContaining(['NPC', 'npc-old']) },
      ]);
    });

    it('幂等重入：同一 rename 再跑一遍零变化（词表不重复、tags 不变）', async () => {
      if (!dbAvailable) return;
      const result = await docRenameService.renameTags(
        spaceId,
        { from: ['NPC', 'npc-old'], to: 'npc' },
        testActor,
      );
      expect(result.updatedDocs).toBe(0);
      expect(result.vocabulary).toEqual({
        created: false,
        addedAliases: [],
        removedCanonicals: [],
        movedAliases: [],
      });
      const settings = (await spaceOf(spaceId)).settings;
      expect(settings.canonicalTags).toEqual([
        { value: 'npc', aliases: expect.arrayContaining(['NPC', 'npc-old']) },
      ]);
    });

    it('审计：一条汇总行，oldData 含 per-doc 前快照（可恢复性载荷）', async () => {
      if (!dbAvailable) return;
      // 取**最早**一条（= 首次 execute；之后的「幂等重入」会再写一条 affectedCount=0 的行）
      const rows = await ds.getRepository(AuditLog).find({
        where: { entityId: spaceId, action: AuditAction.RENAME_DOC_TAGS } as never,
        order: { createdAt: 'ASC' },
        take: 1,
      });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.entityType).toBe('doc_space');
      expect(row.actorId).toBe(testActor.id);
      expect((row.newData as Record<string, unknown>).to).toBe('npc');
      expect((row.newData as Record<string, unknown>).affectedCount).toBe(3);
      const oldData = row.oldData as { token: string; docs: Array<{ id: string; tags: string[] }> };
      expect(oldData.token).toMatch(/^[0-9a-f]{64}$/);
      expect(oldData.docs).toHaveLength(3);
      expect(oldData.docs.find((d) => d.id === dOld.id)?.tags).toEqual(['NPC', 'npc-old']);
    });

    it('409 DOC_BATCH_CONFLICT：dryRun → 并发改文档 → execute(带 token) → abort-all 零副作用', async () => {
      if (!dbAvailable) return;
      const docX = await makeDoc(spaceId, `world/conflict-a-${RUN}.md`, ['ctag-a']);
      const docY = await makeDoc(spaceId, `world/conflict-b-${RUN}.md`, ['ctag-b']);

      const dry = await docRenameService.renameTags(
        spaceId,
        { from: ['ctag-a'], to: 'ctag-z', dryRun: true },
        testActor,
      );
      expect(dry.affectedDocs?.total).toBe(1);
      expect(dry.batchToken).toMatch(/^[0-9a-f]{64}$/);

      // 并发写：让另一篇也含 ctag-a（受影响集变化 → token 变化）
      await setTagsRaw(docY.id, ['ctag-b', 'ctag-a']);

      const response = await expectErrorCode(
        docRenameService.renameTags(
          spaceId,
          { from: ['ctag-a'], to: 'ctag-z', expectedBatchToken: dry.batchToken },
          testActor,
        ),
        ErrorCode.DOC_BATCH_CONFLICT,
      );
      // 零副作用（abort-all）：两篇 tags 均未被改写，词表未动
      expect((await docOf(docX.id))?.tags).toEqual(['ctag-a']);
      expect((await docOf(docY.id))?.tags).toEqual(['ctag-b', 'ctag-a']);
      expect((await spaceOf(spaceId)).settings.canonicalTags ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ value: 'ctag-z' })]),
      );
      expect(response.data).toMatchObject({ diff: { currentAffectedDocIds: expect.any(Array) } });
    });

    it('幂等 replay：同 key 重放返回首次快照 + idempotentReplay（零二次写入）', async () => {
      if (!dbAvailable) return;
      const docI = await makeDoc(spaceId, `world/idem-${RUN}.md`, ['itag-a']);

      const first = await docRenameService.renameTags(
        spaceId,
        { from: ['itag-a'], to: 'itag-b', idempotencyKey: `idem-${RUN}` },
        testActor,
      );
      expect(first.idempotentReplay).toBeUndefined();
      expect(first.updatedDocs).toBe(1);
      expect((await docOf(docI.id))?.tags).toEqual(['itag-b']);

      const replay = await docRenameService.renameTags(
        spaceId,
        { from: ['itag-a'], to: 'itag-b', idempotencyKey: `idem-${RUN}` },
        testActor,
      );
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.updatedDocs).toBe(1);
      expect((await docOf(docI.id))?.tags).toEqual(['itag-b']);
    });

    it('422：from 全部字节等价于 to（无可替换值）；404：空间不存在', async () => {
      if (!dbAvailable) return;
      await expectErrorCode(
        docRenameService.renameTags(spaceId, { from: ['npc'], to: 'npc' }, testActor),
        ErrorCode.VALIDATION_ERROR,
      );
      await expectErrorCode(
        docRenameService.renameTags(
          '00000000-0000-4000-8000-00000000dead',
          { from: ['a'], to: 'b' },
          testActor,
        ),
        ErrorCode.DOC_SPACE_NOT_FOUND,
      );
    });

    it('422：to 为空串 / 纯空白（评审 B1）——零副作用，绝不写空 tag', async () => {
      if (!dbAvailable) return;
      const auditBefore = await countAuditRows(spaceId, AuditAction.RENAME_DOC_TAGS);

      for (const bad of ['', '   ', '\t']) {
        await expectErrorCode(
          docRenameService.renameTags(spaceId, { from: ['npc'], to: bad }, testActor),
          ErrorCode.VALIDATION_ERROR,
        );
      }

      // 零副作用：审计零新增，且全库无任何空串 tag（放行会让 array_replace 写空串）
      expect(await countAuditRows(spaceId, AuditAction.RENAME_DOC_TAGS)).toBe(auditBefore);
      const emptyTagRows: Array<{ c: number }> = await ds.query(
        `SELECT COUNT(*)::int AS c FROM docs WHERE space_id = $1 AND '' = ANY(tags)`,
        [spaceId],
      );
      expect(Number(emptyTagRows[0].c)).toBe(0);
    });

    it('token 命中即放行：dryRun 后零变更 → execute(同 token) 成功且计数/token 一致（评审 M3）', async () => {
      if (!dbAvailable) return;
      const docT = await makeDoc(spaceId, `world/token-${RUN}.md`, ['ttag-a']);

      const dry = await docRenameService.renameTags(
        spaceId,
        { from: ['ttag-a'], to: 'ttag-b', dryRun: true },
        testActor,
      );
      expect(dry.affectedDocs?.total).toBe(1);

      // 零变更窗口内带同一 token 执行：必须放行（这是 dryRun/execute **两处序列化同源**
      // 的唯一钉子——两处若各拼 JSON，同一状态会算出不同 token ⇒ 正常执行被误判 409）
      const exec = await docRenameService.renameTags(
        spaceId,
        { from: ['ttag-a'], to: 'ttag-b', expectedBatchToken: dry.batchToken },
        testActor,
      );
      expect(exec.dryRun).toBe(false);
      expect(exec.batchToken).toBe(dry.batchToken);
      expect(exec.updatedDocs).toBe(dry.affectedDocs?.total);
      expect((await docOf(docT.id))?.tags).toEqual(['ttag-b']);
    });

    it('并发同 key 双写：仅一次生效，且只落一条审计（评审 M4：重放出口不写审计）', async () => {
      if (!dbAvailable) return;
      const docC = await makeDoc(spaceId, `world/conc-${RUN}.md`, ['ctag-conc']);
      const key = `conc-${RUN}`;
      const auditBefore = await countAuditRows(spaceId, AuditAction.RENAME_DOC_TAGS);

      const settled = await Promise.allSettled([
        docRenameService.renameTags(
          spaceId,
          { from: ['ctag-conc'], to: 'ctag-conc-done', idempotencyKey: key },
          testActor,
        ),
        docRenameService.renameTags(
          spaceId,
          { from: ['ctag-conc'], to: 'ctag-conc-done', idempotencyKey: key },
          testActor,
        ),
      ]);

      expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
      const results = settled.map(
        (r) =>
          (r as PromiseFulfilledResult<Awaited<ReturnType<typeof docRenameService.renameTags>>>)
            .value,
      );
      // 恰一个首次 + 恰一个重放（后者走 23505 → tryIdempotentReplay 分支）
      expect(results.filter((r) => r.idempotentReplay === true)).toHaveLength(1);
      expect(results.filter((r) => r.idempotentReplay !== true)).toHaveLength(1);
      expect((await docOf(docC.id))?.tags).toEqual(['ctag-conc-done']);

      // 审计只 +1：重放出口若继续往下走会落一条 affectedIds=[] 的自相矛盾空汇总行
      expect(await countAuditRows(spaceId, AuditAction.RENAME_DOC_TAGS)).toBe(auditBefore + 1);
    });

    it('别名上限（minor-1）：累积超 20 → 截尾部 + 回报 truncatedAliases + PATCH 仍可用', async () => {
      if (!dbAvailable) return;
      const capDoc = await makeDoc(capSpaceId, `cap/doc-${RUN}.md`, [
        'cap-new-1',
        'cap-new-2',
        'cap-new-3',
        'cap-new-4',
      ]);

      const result = await docRenameService.renameTags(
        capSpaceId,
        { from: ['cap-new-1', 'cap-new-2', 'cap-new-3', 'cap-new-4'], to: 'cap-canon' },
        testActor,
      );
      expect(result.updatedDocs).toBe(1);
      // 被裁的尾部别名透明回报（不静默）
      expect(result.vocabulary?.truncatedAliases).toEqual(['cap-new-3', 'cap-new-4']);

      // 落库合法：aliases 恰 20（保「先旧后新」——18 旧 + 前 2 个新）
      const stored = (await spaceOf(capSpaceId)).settings.canonicalTags as Array<{
        value: string;
        aliases: string[];
      }>;
      expect(stored).toHaveLength(1);
      expect(stored[0].value).toBe('cap-canon');
      expect(stored[0].aliases).toHaveLength(20);
      expect(stored[0].aliases.slice(0, 18)).toEqual(
        Array.from({ length: 18 }, (_, i) => `cap-old-${i + 1}`),
      );
      expect(stored[0].aliases.slice(18)).toEqual(['cap-new-1', 'cap-new-2']);

      // 文档侧不受影响（SQL 改写与词表无关）：4 个形态全收拢为 canonical
      expect((await docOf(capDoc.id))?.tags).toEqual(['cap-canon']);

      // 编辑面未被锁死：把落库值原样 PATCH 回去必须成功（超限会让 @ArrayMaxSize 直接 422）
      const patched = await docSpaceService.update(capSpaceId, { canonicalTags: stored });
      expect(patched.settings.canonicalTags).toEqual(stored);
    });
  });

  // ─── category merge ────────────────────────────────────────────────────

  describe('category merge', () => {
    let sourceId: string;
    let targetId: string;
    let deadId: string;
    let docInSource: Doc;
    let routeId: string;

    beforeAll(async () => {
      if (!dbAvailable) return;
      const source = await docSpaceService.createCategory(
        mergeSpaceId,
        { name: 'Source Cat', slug: 'gov-source-slug' },
        testActor.id,
      );
      sourceId = source.id;
      const target = await docSpaceService.createCategory(
        mergeSpaceId,
        { name: 'Target Cat', slug: 'gov-target-slug' },
        testActor.id,
      );
      targetId = target.id;
      const dead = await docSpaceService.createCategory(
        mergeSpaceId,
        { name: 'Dead Cat', slug: 'gov-dead-slug' },
        testActor.id,
      );
      deadId = dead.id;
      // 软删一个分类（422 断言用）
      await ds.query(`UPDATE doc_categories SET deleted_at = NOW() WHERE id = $1`, [deadId]);

      docInSource = await makeDoc(mergeSpaceId, `merge/doc-${RUN}.md`, [], { docType: 'guide' });
      await ds.query(`UPDATE docs SET category_id = $1 WHERE id = $2`, [sourceId, docInSource.id]);

      const route = await ds.getRepository(DocRoute).save(
        ds.getRepository(DocRoute).create({
          spaceId: mergeSpaceId,
          intent: `governance merge ${RUN}`,
          category: 'gov-source-slug',
          primaryDocId: docInSource.id,
          createdBy: testActor.id,
          codeEntryType: 'exact',
        }),
      );
      routeId = route.id;
    });

    it('dryRun：受影响文档 + 软引用影响面，零副作用', async () => {
      if (!dbAvailable) return;
      const result = await docRenameService.mergeCategory(
        sourceId,
        { targetId, dryRun: true },
        testActor,
      );
      expect(result.dryRun).toBe(true);
      expect(result.affectedDocs?.total).toBe(1);
      expect(result.affectedDocs?.sample[0]).toMatchObject({
        docId: docInSource.id,
        currentCategoryId: sourceId,
      });
      expect(result.softRefs).toEqual({ routesCategoryCount: 1, excludeCategories: true });
      // 零副作用
      const doc = await docOf(docInSource.id);
      expect(doc?.categoryId).toBe(sourceId);
      const cat = await ds.query(`SELECT deleted_at FROM doc_categories WHERE id = $1`, [sourceId]);
      expect(cat[0].deleted_at).toBeNull();
    });

    it('execute：重指向 + routes.category 改写 + excludeCategories 修正 + source 软删', async () => {
      if (!dbAvailable) return;
      const result = await docRenameService.mergeCategory(sourceId, { targetId }, testActor);

      expect(result.dryRun).toBe(false);
      expect(result.repointedDocs).toBe(1);
      expect(result.merged).toEqual({ fromSlug: 'gov-source-slug', toSlug: 'gov-target-slug' });
      expect(result.sourceDeleted).toBe(true);
      expect(result.softRefsFixed).toEqual({ routesUpdated: 1, excludeCategoriesUpdated: 1 });

      expect((await docOf(docInSource.id))?.categoryId).toBe(targetId);
      const route = await ds.getRepository(DocRoute).findOneOrFail({ where: { id: routeId } });
      expect(route.category).toBe('gov-target-slug');
      const settings = (await spaceOf(mergeSpaceId)).settings;
      expect(settings.overviewFilter).toMatchObject({
        excludeTypes: ['memory'],
        excludeCategories: ['gov-target-slug'],
      });
      const cat = await ds.query(`SELECT deleted_at FROM doc_categories WHERE id = $1`, [sourceId]);
      expect(cat[0].deleted_at).not.toBeNull();

      // 审计：一条汇总行，oldData 含 per-doc 前快照
      const auditRows = await ds.getRepository(AuditLog).find({
        where: { entityId: sourceId, action: AuditAction.MERGE_DOC_CATEGORY } as never,
      });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].entityType).toBe('doc_category');
      expect(
        (auditRows[0].oldData as { docs: Array<{ id: string; categoryId: string }> }).docs[0],
      ).toEqual({ id: docInSource.id, categoryId: sourceId });
    });

    it('422：target === source / target 已软删；404：source/target 不存在', async () => {
      if (!dbAvailable) return;
      const liveSource = await docSpaceService.createCategory(
        mergeSpaceId,
        { name: 'Live Source', slug: `gov-live-${RUN}`.slice(0, 128) },
        testActor.id,
      );
      await expectErrorCode(
        docRenameService.mergeCategory(liveSource.id, { targetId: liveSource.id }, testActor),
        ErrorCode.VALIDATION_ERROR,
      );
      await expectErrorCode(
        docRenameService.mergeCategory(liveSource.id, { targetId: deadId }, testActor),
        ErrorCode.VALIDATION_ERROR,
      );
      await expectErrorCode(
        docRenameService.mergeCategory(
          '00000000-0000-4000-8000-00000000dead',
          { targetId },
          testActor,
        ),
        ErrorCode.DOC_CATEGORY_NOT_FOUND,
      );
      await expectErrorCode(
        docRenameService.mergeCategory(
          liveSource.id,
          { targetId: '00000000-0000-4000-8000-00000000dead' },
          testActor,
        ),
        ErrorCode.DOC_CATEGORY_NOT_FOUND,
      );
    });

    it('并发 merge 与 remove 同分类：无死锁（40P01）、无未知 500，终态合法（评审 M2）', async () => {
      if (!dbAvailable) return;
      const concSource = await docSpaceService.createCategory(
        mergeSpaceId,
        { name: 'Conc Source', slug: `gov-conc-src-${RUN}`.slice(0, 128) },
        testActor.id,
      );
      const concTarget = await docSpaceService.createCategory(
        mergeSpaceId,
        { name: 'Conc Target', slug: `gov-conc-dst-${RUN}`.slice(0, 128) },
        testActor.id,
      );
      const concDoc = await makeDoc(mergeSpaceId, `merge/conc-${RUN}.md`, []);
      await ds.query(`UPDATE docs SET category_id = $1 WHERE id = $2`, [concSource.id, concDoc.id]);

      // 两条路径都按 categories→docs 取锁（removeCategory 评审 M2 已对齐）⇒ 不应死锁
      const settled = await Promise.allSettled([
        docRenameService.mergeCategory(concSource.id, { targetId: concTarget.id }, testActor),
        docSpaceService.removeCategory(concSource.id),
      ]);

      for (const r of settled) {
        if (r.status !== 'rejected') continue;
        const err = r.reason as {
          code?: unknown;
          driverError?: { code?: string };
          response?: { code?: number };
        };
        const pgCode =
          err.driverError?.code ?? (typeof err.code === 'string' ? err.code : undefined);
        // 死锁检测必须是「不发生」，不是「偶发可容忍」
        expect(pgCode).not.toBe('40P01');
        // 合法拒绝只有两类：并发已软删 → 404，或 merge 锁后读到 source 已软删 → 422
        expect([ErrorCode.DOC_CATEGORY_NOT_FOUND, ErrorCode.VALIDATION_ERROR]).toContain(
          err.response?.code,
        );
      }
      expect(settled.some((r) => r.status === 'fulfilled')).toBe(true);

      // 终态合法：source 已软删；文档分类 ∈ {target, null}（两者都是「无悬空引用」）
      const catRows: Array<{ deleted_at: string | null }> = await ds.query(
        `SELECT deleted_at FROM doc_categories WHERE id = $1`,
        [concSource.id],
      );
      expect(catRows[0].deleted_at).not.toBeNull();
      expect([concTarget.id, null]).toContain((await docOf(concDoc.id))?.categoryId);
    });
  });

  // ─── orphan 诊断 ───────────────────────────────────────────────────────

  describe('orphan 诊断', () => {
    let routedPrimary: Doc;
    let routedSecondary: Doc;
    let orphanLeaf: Doc;
    let orphanMemory: Doc;
    let orphanTop: Doc;

    beforeAll(async () => {
      if (!dbAvailable) return;
      routedPrimary = await makeDoc(orphanSpaceId, `world/primary-${RUN}.md`, []);
      routedSecondary = await makeDoc(orphanSpaceId, `world/secondary-${RUN}.md`, []);
      orphanLeaf = await makeDoc(orphanSpaceId, `world/leaf-${RUN}.md`, []);
      orphanMemory = await makeDoc(orphanSpaceId, `memory/diary-${RUN}.md`, [], {
        docType: 'memory',
      });
      orphanTop = await makeDoc(orphanSpaceId, `top-${RUN}.md`, []);

      await ds.getRepository(DocRoute).save(
        ds.getRepository(DocRoute).create({
          spaceId: orphanSpaceId,
          intent: `orphan coverage ${RUN}`,
          primaryDocId: routedPrimary.id,
          secondaryDocId: routedSecondary.id,
          createdBy: testActor.id,
          codeEntryType: 'exact',
        }),
      );
    });

    it('覆盖口径 = primary ∪ secondary；默认应用 overviewFilter 排除', async () => {
      if (!dbAvailable) return;
      const settings = (await spaceOf(orphanSpaceId)).settings;
      const result = await docService.findOrphans(orphanSpaceId, settings, {});

      expect(result.stats.totalDocs).toBe(5);
      expect(result.stats.routedDocs).toBe(2);
      expect(result.stats.orphanDocs).toBe(3);
      expect(result.stats.excludedOrphanDocs).toBe(1); // memory 日记
      const paths = result.items.map((i) => i.path).sort();
      expect(paths).toEqual([orphanLeaf.path, orphanTop.path].sort());
      expect(result.appliedFilters.excludeTypes).toEqual(['memory']);
    });

    it('includeExcluded=true → 全量 orphan（含被默认排除者）', async () => {
      if (!dbAvailable) return;
      const settings = (await spaceOf(orphanSpaceId)).settings;
      const result = await docService.findOrphans(orphanSpaceId, settings, {
        includeExcluded: true,
      });
      expect(result.stats.excludedOrphanDocs).toBe(0);
      expect(result.items.map((i) => i.path)).toContain(orphanMemory.path);
      expect(result.appliedFilters.includeExcluded).toBe(true);
    });

    it('pathPrefix + byTopDir + 分页：结构性分组与页间稳定', async () => {
      if (!dbAvailable) return;
      const settings = (await spaceOf(orphanSpaceId)).settings;

      const worldOnly = await docService.findOrphans(orphanSpaceId, settings, {
        pathPrefix: 'world/',
        includeExcluded: true,
      });
      expect(worldOnly.stats.totalDocs).toBe(3); // world/ 下 3 篇（含被 route 引用的 2 篇）
      expect(worldOnly.items.map((i) => i.path)).toEqual([orphanLeaf.path]);
      expect(worldOnly.appliedFilters.pathPrefix).toBe('world/');

      const all = await docService.findOrphans(orphanSpaceId, settings, {
        includeExcluded: true,
        page: 1,
        pageSize: 1,
      });
      expect(all.total).toBe(3);
      expect(all.items).toHaveLength(1);
      expect(all.stats.byTopDir).toEqual(
        expect.arrayContaining([
          { dir: 'memory', count: 1 },
          { dir: 'world', count: 1 },
          { dir: '(root)', count: 1 },
        ]),
      );
    });
  });

  // ─── 读侧 alias 兼容 ───────────────────────────────────────────────────

  describe('读侧 alias 兼容（集合展开）', () => {
    let aNpc: Doc;
    let aUpper: Doc;
    let aOld: Doc;

    beforeAll(async () => {
      if (!dbAvailable) return;
      aNpc = await makeDoc(readSpaceId, `read/a-${RUN}.md`, ['npc']);
      aUpper = await makeDoc(readSpaceId, `read/b-${RUN}.md`, ['NPC']);
      aOld = await makeDoc(readSpaceId, `read/c-${RUN}.md`, ['npc-old']);
    });

    it('rename 前：精确匹配（旧值查询命中的集合是展开语义的子集）', async () => {
      if (!dbAvailable) return;
      const settings = (await spaceOf(readSpaceId)).settings;
      const exact = await docService.findAll(readSpaceId, { tag: 'npc' }, settings);
      expect(exact.items.map((i) => i.id)).toEqual([aNpc.id]);
    });

    it('rename 后：旧值/新值查询都命中（per-space 搜索 + 列表都经集合展开）', async () => {
      if (!dbAvailable) return;
      await docRenameService.renameTags(
        readSpaceId,
        { from: ['NPC', 'npc-old'], to: 'npc' },
        testActor,
      );
      const settings = (await spaceOf(readSpaceId)).settings;
      const expected = [aNpc.id, aUpper.id, aOld.id].sort();

      const byNewValue = await docService.findAll(readSpaceId, { tag: 'npc' }, settings);
      expect(byNewValue.items.map((i) => i.id).sort()).toEqual(expected);
      // 旧值（rename 前写入的形态）查询同样全命中——alias 展开的核心承诺
      const byOldValue = await docService.findAll(readSpaceId, { tag: 'NPC' }, settings);
      expect(byOldValue.items.map((i) => i.id).sort()).toEqual(expected);

      // 搜索侧同通道（hintContext.settings 兼作空间词表上下文）。白名单限定本空间——
      // 与 hintContext 通道正交（全局检索面 = **不传 hintContext**，见下一用例）
      const searchNew = await docSearchService.search(
        [readSpaceId],
        { q: MARKER, tag: 'npc', limit: 20 },
        { actor: testActor, hintContext: { spaceId: readSpaceId, settings } },
      );
      expect([...new Set(searchNew.hits.map((h) => h.docId))].sort()).toEqual(expected);
      const searchOld = await docSearchService.search(
        [readSpaceId],
        { q: MARKER, tag: 'npc-old', limit: 20 },
        { actor: testActor, hintContext: { spaceId: readSpaceId, settings } },
      );
      expect([...new Set(searchOld.hits.map((h) => h.docId))].sort()).toEqual(expected);
    });

    it('全局搜索（不传 hintContext）不扩展：旧值查询零命中（零跨空间泄漏）', async () => {
      if (!dbAvailable) return;
      const global = await docSearchService.search(
        [readSpaceId],
        { q: MARKER, tag: 'NPC', limit: 20 },
        { actor: testActor },
      );
      expect(global.hits).toHaveLength(0);
      // 同白名单下新值查询仍命中 ⇒ 差异只来自「是否展开」，不是白名单造成的空集
      const globalNew = await docSearchService.search(
        [readSpaceId],
        { q: MARKER, tag: 'npc', limit: 20 },
        { actor: testActor },
      );
      expect(globalNew.hits.length).toBeGreaterThan(0);
    });
  });
});
