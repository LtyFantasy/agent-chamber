/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16.4 / §16.9b / §16.18（空间 settings 词表 /
 *     facets 词表状态与回显 / metadata patch tag 归一）
 *   - 补充: plan blue-beetle-x-23-banshee.md §5（e2e 矩阵：roundtrip / merge / 422 /
 *     双通道归一 / unchanged 边界 / 幂等重放 / facets 状态 / 未配置空间零变化）
 *
 * [踩坑索引]
 *   - mock 测不出 ORM SQL 生成（铁律 #23）：settings jsonb 读写、unnest(tags) 聚合、
 *     partial UPDATE 数组列、幂等快照落库，全必须打真实 PG（本套件职责）
 *   - 双挂点（A1）：upsertCore 与 patchMetadata 是两条独立写通道，归一必须分别验证
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #23(jsonb/ORM 集成覆盖) #20(不为测试改设计)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * DocSpace 空间词表（settings 三字段 + tag alias 归一 + facets 词表状态）—— 真实 PG 集成套件
 *
 * DocSpace 元数据治理 1 期（v1.92.0-dev）四项交付的数据层全链路验证：直接实例化
 * DocSpaceService / DocService（真 TypeORM repo + 真事务），验证 settings jsonb
 * 三键 roundtrip / merge 语义 / 业务校验 422 / 双挂点 tag 归一 / unchanged 边界 /
 * 幂等重放 / facets 词表状态与 vocabulary 回显 / 未配置空间零行为变化。
 *
 * DB 目标 = 本地开发库 chamber-postgres（docker-compose 默认参数，env 可覆盖）。
 * PG 不可达时整套降级跳过（warn 提示）——保持 test:e2e 在无库环境仍可全绿。
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DataSource } from 'typeorm';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { DocService } from '../src/modules/docspace/doc.service';
import { DocSpaceService } from '../src/modules/docspace/docspace.service';
import { DiagramRendererService } from '../src/modules/docspace/diagram-renderer.service';
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
import type { RouteHealthService } from '../src/modules/docspace/route-health.service';
import type { AccessQueryService } from '../src/common/services/access-query.service';
import type { ResourceValidator } from '../src/common/resource-validator';
import type { ActorProfileService } from '../src/common/services/actor-profile.service';
import type { AuditService } from '../src/modules/audit/audit.service';
import type { UnifiedActor } from '../src/common/types/actor.types';
import { HintDedupService } from '../src/modules/hints/hint-dedup.service';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实文档互相污染 */
const RUN = `vocab-e2e-${Date.now()}`;

/** 固定测试 actor（docs.created_by 为 uuid 列，'system' 字面量会被 PG 拒绝） */
const testActor: UnifiedActor = {
  id: '00000000-0000-4000-8000-0000000000cc',
  type: ActorType.HUMAN,
};

/** 断言 4xx 错误体的 code（NestJS HttpException.response 结构） */
async function expectErrorCode(promise: Promise<unknown>, code: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ response: { code } });
}

describe('DocSpace vocabulary（settings 词表 + tag 归一 + facets 状态）— 真实 PG 集成', () => {
  let ds: DataSource;
  let docSpaceService: DocSpaceService;
  let docService: DocService;
  let dbAvailable = false;

  let spaceAId: string; // 已声明词表的空间
  let spaceBId: string; // 未声明词表的空间
  let spaceCId: string; // 脏词表空间（code-review F1：直改库模拟 jsonb 脏形状）

  /** 词表声明样本（spaceA） */
  const canonicalTags = [
    { value: 'npc', aliases: ['NPC', 'Npc'] },
    { value: 'openviking', aliases: ['OpenViking', 'open-viking'] },
  ];
  const docTypes = ['guide', 'reference', 'memory'];
  const pathTypes = [{ pathPrefix: 'memory/', docType: 'memory' }];

  async function readTags(docId: string): Promise<string[]> {
    const doc = await ds.getRepository(Doc).findOne({ where: { id: docId } });
    return doc?.tags ?? [];
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
        `[docspace-vocabulary e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // EventService 打桩（不接真 EventService——它依赖 owner 代理解析，本地库缺列会炸）
    const eventStub = { create: jest.fn(async () => ({})) } as unknown as EventService;
    const routeHealthStub = {
      recheckSpace: jest.fn().mockResolvedValue({ rechecked: 0, broken: 0 }),
    } as unknown as RouteHealthService;

    docService = new DocService(
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(DocCategory),
      ds.getRepository(AuditLog),
      ds.getRepository(DocSpace),
      ds.getRepository(Board),
      ds.getRepository(DocVersion),
      eventStub,
      routeHealthStub,
      ds.getRepository(IdempotencyRecord),
      { validateAndRender: jest.fn() } as unknown as DiagramRendererService,
      new HintDedupService(),
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
      {} as unknown as AuditService,
      new HintDedupService(),
    );

    // 两个空间：A 声明词表 / B 无词表
    const spaceA = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `Vocab E2E A ${RUN}`,
        slug: `vocab-a-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: { docTypes, canonicalTags, pathTypes },
      }),
    );
    spaceAId = spaceA.id;

    const spaceB = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `Vocab E2E B ${RUN}`,
        slug: `vocab-b-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {},
      }),
    );
    spaceBId = spaceB.id;

    // 脏词表空间：本空间词表由测试内直接 UPDATE settings 注入异形值（模拟直改库 /
    // 历史版本写坏——DTO 与 bundle 过滤都不经此路径），验证读侧形状闸门
    const spaceC = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `Vocab E2E C ${RUN}`,
        slug: `vocab-c-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {},
      }),
    );
    spaceCId = spaceC.id;
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;

    const allDocIds: string[] = [];
    for (const spaceId of [spaceAId, spaceBId, spaceCId]) {
      if (!spaceId) continue;
      const docs = await ds.getRepository(Doc).find({ where: { spaceId } });
      for (const d of docs) {
        allDocIds.push(d.id);
        await ds.getRepository(DocSection).delete({ docId: d.id });
        await ds.getRepository(DocVersion).delete({ docId: d.id });
        await ds.getRepository(IdempotencyRecord).delete({ entityId: d.id });
      }
      await ds.getRepository(Doc).delete({ spaceId });
      await ds.getRepository(DocCategory).delete({ spaceId });
      await ds.getRepository(DocSpace).delete({ id: spaceId });
    }
    // audit 行按种子 docId 清理（upsert/patchMetadata 在 actor 携带时落 audit）
    if (allDocIds.length > 0) {
      await ds.query(`DELETE FROM audit_logs WHERE entity_type = 'doc' AND entity_id = ANY($1)`, [
        allDocIds,
      ]);
    }
    await ds.destroy();
  }, 30000);

  // ─── 1. settings 三字段 roundtrip + merge 语义 ──────────────────────────

  describe('settings 三字段读写（roundtrip / merge / 显式 null）', () => {
    it('PATCH 响应回显三键全文，且落库持久', async () => {
      if (!dbAvailable) return;
      // 先清空再写，验证「写入 → 响应回显」全链路
      const saved = await docSpaceService.update(spaceAId, {
        docTypes,
        canonicalTags,
        pathTypes,
      });
      expect(saved.settings.docTypes).toEqual(docTypes);
      expect(saved.settings.canonicalTags).toEqual(canonicalTags);
      expect(saved.settings.pathTypes).toEqual(pathTypes);

      const reread = await docSpaceService.findById(spaceAId);
      expect(reread.settings.canonicalTags).toEqual(canonicalTags);
    });

    it('单字段更新不影响另两键（merge 语义）', async () => {
      if (!dbAvailable) return;
      const saved = await docSpaceService.update(spaceAId, { docTypes: ['note'] });
      expect(saved.settings.docTypes).toEqual(['note']);
      expect(saved.settings.canonicalTags).toEqual(canonicalTags);
      expect(saved.settings.pathTypes).toEqual(pathTypes);
      // 还原
      await docSpaceService.update(spaceAId, { docTypes });
    });

    it('显式 null 删键，其余键保留', async () => {
      if (!dbAvailable) return;
      const saved = await docSpaceService.update(spaceAId, { pathTypes: null });
      expect(saved.settings.pathTypes).toBeUndefined();
      expect(saved.settings.docTypes).toEqual(docTypes);
      expect(saved.settings.canonicalTags).toEqual(canonicalTags);
      // 还原
      await docSpaceService.update(spaceAId, { pathTypes });
    });
  });

  // ─── 2. 业务校验（422 DOC_SPACE_VOCABULARY_INVALID）────────────────────

  describe('词表业务校验 422（422 时零写入）', () => {
    it('canonical 值大小写不敏感重复 → 422 带冲突对', async () => {
      if (!dbAvailable) return;
      await expect(
        docSpaceService.update(spaceAId, {
          canonicalTags: [
            { value: 'npc', aliases: [] },
            { value: 'NPC', aliases: [] },
          ],
        }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_SPACE_VOCABULARY_INVALID,
          data: {
            conflicts: expect.arrayContaining([
              expect.objectContaining({ field: 'canonicalTags' }),
            ]),
          },
        },
      });
      // 零写入：原词表未被覆盖
      const reread = await docSpaceService.findById(spaceAId);
      expect(reread.settings.canonicalTags).toEqual(canonicalTags);
    });

    it('alias 跨条目冲突 → 422', async () => {
      if (!dbAvailable) return;
      await expectErrorCode(
        docSpaceService.update(spaceAId, {
          canonicalTags: [
            { value: 'alpha', aliases: ['shared'] },
            { value: 'beta', aliases: ['Shared'] },
          ],
        }),
        ErrorCode.DOC_SPACE_VOCABULARY_INVALID,
      );
    });

    it('alias 命中其他条目的 canonical → 422', async () => {
      if (!dbAvailable) return;
      await expectErrorCode(
        docSpaceService.update(spaceAId, {
          canonicalTags: [
            { value: 'alpha', aliases: ['beta'] },
            { value: 'beta', aliases: [] },
          ],
        }),
        ErrorCode.DOC_SPACE_VOCABULARY_INVALID,
      );
    });

    it('docTypes 大小写不敏感重复 → 422', async () => {
      if (!dbAvailable) return;
      await expectErrorCode(
        docSpaceService.update(spaceAId, { docTypes: ['guide', 'Guide'] }),
        ErrorCode.DOC_SPACE_VOCABULARY_INVALID,
      );
    });

    it('pathTypes pathPrefix 重复 → 422', async () => {
      if (!dbAvailable) return;
      await expectErrorCode(
        docSpaceService.update(spaceAId, {
          pathTypes: [
            { pathPrefix: 'memory/', docType: 'memory' },
            { pathPrefix: 'memory/', docType: 'note' },
          ],
        }),
        ErrorCode.DOC_SPACE_VOCABULARY_INVALID,
      );
    });

    it('同条目内 alias 与自身 canonical 重复 → 不算错', async () => {
      if (!dbAvailable) return;
      const saved = await docSpaceService.update(spaceAId, {
        canonicalTags: [{ value: 'npc', aliases: ['NPC', 'npc'] }],
      });
      expect(saved.settings.canonicalTags).toEqual([{ value: 'npc', aliases: ['NPC', 'npc'] }]);
      // 还原
      await docSpaceService.update(spaceAId, { canonicalTags });
    });
  });

  // ─── 3. DTO 格式校验（上限，铁律 #21 双层校验的格式层）──────────────────

  describe('DTO 格式校验（数组上限 / 单值长度）', () => {
    it('docTypes 超 ArrayMaxSize(50) → 校验错误', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        docTypes: Array.from({ length: 51 }, (_, i) => `t${i}`),
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'docTypes')).toBe(true);
    });

    it('canonicalTags 超 ArrayMaxSize(200) → 校验错误', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        canonicalTags: Array.from({ length: 201 }, (_, i) => ({ value: `v${i}`, aliases: [] })),
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'canonicalTags')).toBe(true);
    });

    it('单个 canonical 的 aliases 超 ArrayMaxSize(20) → 校验错误', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        canonicalTags: [{ value: 'npc', aliases: Array.from({ length: 21 }, (_, i) => `a${i}`) }],
      });
      const errors = await validate(dto);
      const nested = errors.find((e) => e.property === 'canonicalTags');
      expect(nested).toBeDefined();
    });

    it('pathTypes 超 ArrayMaxSize(50) → 校验错误', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        pathTypes: Array.from({ length: 51 }, (_, i) => ({
          pathPrefix: `p${i}/`,
          docType: 'note',
        })),
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'pathTypes')).toBe(true);
    });
  });

  // ─── 4. tag alias 归一（挂点 ① 内容通道 upsertCore）───────────────────

  describe('tag 归一 — 内容通道（upsertCore）', () => {
    it('声明 alias 命中（大小写变体）→ 落库 canonical + 响应 tagNormalizations', async () => {
      if (!dbAvailable) return;
      const r = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/norm-1.md`, content: `# Norm 1\n\n正文。`, tags: ['NPC', 'misc'] },
        testActor,
      );
      expect(r.tagNormalizations).toEqual([{ from: 'NPC', to: 'npc' }]);
      expect(await readTags(r.id)).toEqual(['npc', 'misc']);
    });

    it('归一后去重（保留首个出现位置）', async () => {
      if (!dbAvailable) return;
      const r = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/norm-2.md`, content: `# Norm 2\n\n正文。`, tags: ['NPC', 'npc'] },
        testActor,
      );
      expect(r.tagNormalizations).toEqual([{ from: 'NPC', to: 'npc' }]);
      expect(await readTags(r.id)).toEqual(['npc']);
    });

    it('未声明 tag 原样落库（不 trim 不改动）', async () => {
      if (!dbAvailable) return;
      const r = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/norm-3.md`, content: `# Norm 3\n\n正文。`, tags: [' WeirdTag '] },
        testActor,
      );
      expect(r.tagNormalizations).toBeUndefined();
      expect(await readTags(r.id)).toEqual([' WeirdTag ']);
    });

    it('未配置词表的空间 → upsert 零行为变化（无 tagNormalizations）', async () => {
      if (!dbAvailable) return;
      const r = await docService.upsert(
        spaceBId,
        { path: `tmp/${RUN}/norm-b.md`, content: `# Norm B\n\n正文。`, tags: ['NPC'] },
        testActor,
      );
      expect(r.tagNormalizations).toBeUndefined();
      expect(await readTags(r.id)).toEqual(['NPC']);
    });

    it('batch upsert（git-ingest 通道）同样归一', async () => {
      if (!dbAvailable) return;
      const res = await docService.batchUpsert(
        spaceAId,
        [
          {
            path: `tmp/${RUN}/norm-batch.md`,
            content: `# Norm Batch\n\n正文。`,
            tags: ['OpenViking'],
          } as never,
        ],
        testActor,
      );
      expect(res.results[0].status).toBe('created');
      expect(res.results[0].tagNormalizations).toEqual([{ from: 'OpenViking', to: 'openviking' }]);
      const doc = await ds.getRepository(Doc).findOne({
        where: { spaceId: spaceAId, path: `tmp/${RUN}/norm-batch.md` },
      });
      expect(doc?.tags).toEqual(['openviking']);
    });

    it('unchanged 边界（A2）：内容未变 → tags 不落库也不归一', async () => {
      if (!dbAvailable) return;
      const path = `tmp/${RUN}/norm-unchanged.md`;
      const first = await docService.upsert(
        spaceAId,
        { path, content: `# Unchanged\n\n同一内容。`, tags: ['npc'] },
        testActor,
      );
      expect(await readTags(first.id)).toEqual(['npc']);

      // 同内容 + 不同 tags：内容 hash 未变 → unchanged 早退，tags 不落库不归一
      const second = await docService.upsert(
        spaceAId,
        { path, content: `# Unchanged\n\n同一内容。`, tags: ['NPC'] },
        testActor,
      );
      expect(second.unchanged).toBe(true);
      expect(second.tagNormalizations).toBeUndefined();
      expect(await readTags(first.id)).toEqual(['npc']);
    });
  });

  // ─── 5. tag 归一（挂点 ② metadata-only 通道 patchMetadata，A1）─────────

  describe('tag 归一 — metadata-only 通道（patchMetadata，A1 独立挂点）', () => {
    it('patch_doc_metadata 同样归一 + tagNormalizations 回显 + changedFields 含 tags', async () => {
      if (!dbAvailable) return;
      const created = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/meta-1.md`, content: `# Meta 1\n\n正文。`, tags: [] },
        testActor,
      );
      const doc = await docService.findById(created.id);

      const patched = await docService.patchMetadata(
        created.id,
        {
          tags: ['OpenViking'],
          expectedContentHash: doc.contentHash as string,
        },
        testActor,
      );
      expect(patched.unchanged).toBe(false);
      expect(patched.changedFields).toContain('tags');
      expect(patched.tagNormalizations).toEqual([{ from: 'OpenViking', to: 'openviking' }]);
      expect(patched.metadata.tags).toEqual(['openviking']);
      expect(await readTags(created.id)).toEqual(['openviking']);
    });

    it('未声明词表的空间：patch_doc_metadata 零行为变化', async () => {
      if (!dbAvailable) return;
      const created = await docService.upsert(
        spaceBId,
        { path: `tmp/${RUN}/meta-b.md`, content: `# Meta B\n\n正文。`, tags: [] },
        testActor,
      );
      const doc = await docService.findById(created.id);
      const patched = await docService.patchMetadata(
        created.id,
        { tags: ['NPC'], expectedContentHash: doc.contentHash as string },
        testActor,
      );
      expect(patched.tagNormalizations).toBeUndefined();
      expect(patched.metadata.tags).toEqual(['NPC']);
    });
  });

  // ─── 6. 幂等重放回归（归一在 replay 检查之后，指纹不受影响）────────────

  describe('幂等重放回归', () => {
    it('upsert 同 key 重放 → 返回首次快照（含 tagNormalizations 原样）', async () => {
      if (!dbAvailable) return;
      const key = `vocab-idem-upsert-${RUN}`.slice(0, 64);
      const dto = {
        path: `tmp/${RUN}/idem.md`,
        content: `# Idem\n\n正文。`,
        tags: ['NPC'],
      };
      const first = await docService.upsert(spaceAId, dto, testActor, key);
      expect(first.tagNormalizations).toEqual([{ from: 'NPC', to: 'npc' }]);
      expect(first.idempotentReplay).toBeUndefined();

      const replay = await docService.upsert(spaceAId, dto, testActor, key);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.tagNormalizations).toEqual([{ from: 'NPC', to: 'npc' }]);
      expect(replay.id).toBe(first.id);
    });

    it('patchMetadata 同 key 重放 → 返回首次快照', async () => {
      if (!dbAvailable) return;
      const created = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/idem-meta.md`, content: `# Idem Meta\n\n正文。`, tags: [] },
        testActor,
      );
      const doc = await docService.findById(created.id);
      const key = `vocab-idem-meta-${RUN}`.slice(0, 64);
      const payload = { tags: ['OpenViking'], expectedContentHash: doc.contentHash as string };

      const first = await docService.patchMetadata(created.id, payload, testActor, key);
      expect(first.tagNormalizations).toEqual([{ from: 'OpenViking', to: 'openviking' }]);

      const replay = await docService.patchMetadata(created.id, payload, testActor, key);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.tagNormalizations).toEqual([{ from: 'OpenViking', to: 'openviking' }]);
    });
  });

  // ─── 7. facets 词表状态 + vocabulary 回显 ──────────────────────────────

  describe('facets 词表状态与 vocabulary 回显', () => {
    beforeAll(async () => {
      if (!dbAvailable) return;
      // 种子：一个 declared docType + 一个 undeclared docType；一个词表外 tag
      await docService.upsert(
        spaceAId,
        {
          path: `tmp/${RUN}/facet-seed.md`,
          content: `# Facet Seed\n\n正文。`,
          docType: 'guide',
          tags: ['orphan-tag'],
        },
        testActor,
      );
      await docService.upsert(
        spaceAId,
        {
          path: `tmp/${RUN}/facet-seed2.md`,
          content: `# Facet Seed 2\n\n正文。`,
          docType: 'legacy-type',
          tags: ['npc'],
        },
        testActor,
      );
    });

    it('已声明词表：types declared/undeclared、tags canonical/alias/undeclared + canonicalValue', async () => {
      if (!dbAvailable) return;
      const space = await docSpaceService.findById(spaceAId);
      const facets = await docService.findFacets(spaceAId, space.settings);

      const typeStatus = new Map(facets.types.map((t) => [t.value, t.vocabStatus]));
      expect(typeStatus.get('guide')).toBe('declared');
      expect(typeStatus.get('legacy-type')).toBe('undeclared');

      const tagStatus = new Map(facets.tags.map((t) => [t.value, t]));
      expect(tagStatus.get('npc')?.vocabStatus).toBe('canonical');
      expect(tagStatus.get('openviking')?.vocabStatus).toBe('canonical');
      expect(tagStatus.get('orphan-tag')?.vocabStatus).toBe('undeclared');

      // vocabulary 三键回显
      expect(facets.vocabulary?.docTypes).toEqual(docTypes);
      expect(facets.vocabulary?.canonicalTags).toEqual(canonicalTags);
      expect(facets.vocabulary?.pathTypes).toEqual(pathTypes);
    });

    it('未配置词表的空间：无 vocabStatus、无 vocabulary（整段省略）', async () => {
      if (!dbAvailable) return;
      const space = await docSpaceService.findById(spaceBId);
      const facets = await docService.findFacets(spaceBId, space.settings);

      expect(facets.vocabulary).toBeUndefined();
      expect(facets.types.every((t) => t.vocabStatus === undefined)).toBe(true);
      expect(facets.tags.every((t) => t.vocabStatus === undefined)).toBe(true);
      expect(facets.tags.every((t) => t.canonicalValue === undefined)).toBe(true);
    });

    it('alias 状态携带 canonicalValue（喂 3 期 rename/merge）', async () => {
      if (!dbAvailable) return;
      // 直接落一条未归一的 alias 形态文档（模拟历史数据/绕过归一），验证 facets 标注
      const doc = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/alias-facet.md`, content: `# Alias Facet\n\n正文。`, tags: [] },
        testActor,
      );
      await ds
        .getRepository(Doc)
        .createQueryBuilder()
        .update('Doc')
        .set({ tags: ['OpenViking'] })
        .where('id = :id', { id: doc.id })
        .execute();

      const space = await docSpaceService.findById(spaceAId);
      const facets = await docService.findFacets(spaceAId, space.settings);
      const aliasItem = facets.tags.find((t) => t.value === 'OpenViking');
      expect(aliasItem?.vocabStatus).toBe('alias');
      expect(aliasItem?.canonicalValue).toBe('openviking');
    });
  });

  // ─── 8. 脏词表形状（code-review F1：读侧形状闸门，永不 500）────────────

  describe('脏词表形状：facets/upsert 均不 500，脏键按无词表处理（F1）', () => {
    /** 直改库注入异形 settings（模拟历史版本/bundle 外路径写坏，绕开 DTO 与 bundle 过滤） */
    async function setRawSettings(settings: Record<string, unknown>): Promise<void> {
      await ds
        .getRepository(DocSpace)
        .createQueryBuilder()
        .update('DocSpace')
        .set({ settings })
        .where('id = :id', { id: spaceCId })
        .execute();
    }

    async function facetsForSpaceC() {
      const space = await docSpaceService.findById(spaceCId);
      return docService.findFacets(spaceCId, space.settings);
    }

    it('canonicalTags 为字符串数组 → facets 200 且无状态、upsert 原样落库', async () => {
      if (!dbAvailable) return;
      await setRawSettings({ canonicalTags: ['openviking'] });

      // 旧实现：entry.value.toLowerCase() 抛 TypeError → facets 与 upsert 双双 500
      const facets = await facetsForSpaceC();
      expect(facets.vocabulary).toBeUndefined();
      expect(facets.tags.every((t) => t.vocabStatus === undefined)).toBe(true);

      const r = await docService.upsert(
        spaceCId,
        { path: `tmp/${RUN}/dirty-1.md`, content: `# Dirty 1\n\n正文。`, tags: ['openviking'] },
        testActor,
      );
      expect(r.tagNormalizations).toBeUndefined();
      expect(await readTags(r.id)).toEqual(['openviking']);
    });

    it('aliases 为字符串（非数组）→ 整条剔除，不逐字符迭代（tag "n" 不被误归一）', async () => {
      if (!dbAvailable) return;
      await setRawSettings({ canonicalTags: [{ value: 'npc', aliases: 'NPC' }] });

      const facets = await facetsForSpaceC();
      expect(facets.vocabulary).toBeUndefined();

      // 旧实现：aliases 被逐字符迭代 → tag 'n' 命中 alias 'n' 被静默归一成 'npc'
      const r = await docService.upsert(
        spaceCId,
        { path: `tmp/${RUN}/dirty-2.md`, content: `# Dirty 2\n\n正文。`, tags: ['n'] },
        testActor,
      );
      expect(r.tagNormalizations).toBeUndefined();
      expect(await readTags(r.id)).toEqual(['n']);
    });

    it('value 非字符串 → 该条剔除；同数组内合法条目仍生效（部分脏不整体废）', async () => {
      if (!dbAvailable) return;
      await setRawSettings({
        canonicalTags: [
          { value: null, aliases: [] },
          { value: 'npc', aliases: ['NPC'] },
        ],
      });

      const facets = await facetsForSpaceC();
      expect(facets.vocabulary?.canonicalTags).toEqual([{ value: 'npc', aliases: ['NPC'] }]);

      const r = await docService.upsert(
        spaceCId,
        { path: `tmp/${RUN}/dirty-3.md`, content: `# Dirty 3\n\n正文。`, tags: ['NPC'] },
        testActor,
      );
      expect(r.tagNormalizations).toEqual([{ from: 'NPC', to: 'npc' }]);
      expect(await readTags(r.id)).toEqual(['npc']);
    });

    it('aliases 缺省（可选字段，F5）→ 合法空表，canonical 精确命中仍生效', async () => {
      if (!dbAvailable) return;
      await setRawSettings({ canonicalTags: [{ value: 'npc' }] });

      const facets = await facetsForSpaceC();
      expect(facets.vocabulary?.canonicalTags).toEqual([{ value: 'npc', aliases: [] }]);

      const r = await docService.upsert(
        spaceCId,
        { path: `tmp/${RUN}/dirty-4.md`, content: `# Dirty 4\n\n正文。`, tags: ['npc'] },
        testActor,
      );
      expect(r.tagNormalizations).toBeUndefined();
      expect(await readTags(r.id)).toEqual(['npc']);
    });

    it('docTypes 含非字符串 → 该条剔除，facets 200（旧实现 .toLowerCase() 抛）', async () => {
      if (!dbAvailable) return;
      await setRawSettings({ docTypes: [123, 'guide'] });

      // 落一篇 docType='guide' 的文档，让 facets 的 types 组真的有该值可判
      await docService.upsert(
        spaceCId,
        { path: `tmp/${RUN}/dirty-5.md`, content: `# Dirty 5\n\n正文。`, docType: 'guide' },
        testActor,
      );

      const facets = await facetsForSpaceC();
      expect(facets.vocabulary?.docTypes).toEqual(['guide']);
      const guide = facets.types.find((t) => t.value === 'guide');
      expect(guide?.vocabStatus).toBe('declared');
    });

    it('pathTypes 非数组 → 无词表（facets 200，vocabulary 省略）', async () => {
      if (!dbAvailable) return;
      await setRawSettings({ pathTypes: 'memory/' });

      const facets = await facetsForSpaceC();
      expect(facets.vocabulary).toBeUndefined();
    });
  });

  // ─── 9. F2：patchMetadata unchanged + tagNormalizations 回显 ───────────

  describe('F2：patchMetadata unchanged 仍回显 tagNormalizations', () => {
    it('已存 npc + 传 NPC → unchanged:true / changedFields:[] / 归一映射回显 / 库中不变', async () => {
      if (!dbAvailable) return;
      const created = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/f2-unchanged.md`, content: `# F2\n\n正文。`, tags: ['npc'] },
        testActor,
      );
      const doc = await docService.findById(created.id);

      const patched = await docService.patchMetadata(
        created.id,
        { tags: ['NPC'], expectedContentHash: doc.contentHash as string },
        testActor,
      );

      expect(patched.unchanged).toBe(true);
      expect(patched.changedFields).toEqual([]);
      expect(patched.tagNormalizations).toEqual([{ from: 'NPC', to: 'npc' }]);
      expect(await readTags(created.id)).toEqual(['npc']);
    });
  });

  // ─── 10. F3：未命中重复项原样保留 ─────────────────────────────────────

  describe('F3：未命中 tag 不参与去重（原样落库含重复）', () => {
    it('词表存在时 ["foo","foo"] 未命中 → 落库两条原样', async () => {
      if (!dbAvailable) return;
      const r = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/f3-dupe.md`, content: `# F3\n\n正文。`, tags: ['foo', 'foo'] },
        testActor,
      );
      expect(r.tagNormalizations).toBeUndefined();
      expect(await readTags(r.id)).toEqual(['foo', 'foo']);
    });

    it('命中项仍去重（["NPC","npc"] → ["npc"]）', async () => {
      if (!dbAvailable) return;
      const r = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/f3-dupe-hit.md`, content: `# F3 hit\n\n正文。`, tags: ['NPC', 'npc'] },
        testActor,
      );
      expect(await readTags(r.id)).toEqual(['npc']);
    });
  });

  // ─── 11. F4：声明侧 trim 归一 + trim 后空 → 422 ────────────────────────

  describe('F4：声明侧 trim 归一（存储 trim 形态，与匹配侧对齐）', () => {
    it('带空白的声明被 trim 后落库，且归一/状态判定按 trim 形态生效', async () => {
      if (!dbAvailable) return;
      const saved = await docSpaceService.update(spaceAId, {
        canonicalTags: [{ value: '  spaced  ', aliases: [' Spaced '] }],
      });
      expect(saved.settings.canonicalTags).toEqual([{ value: 'spaced', aliases: ['Spaced'] }]);

      // 归一按 trim 后的声明生效
      const r = await docService.upsert(
        spaceAId,
        { path: `tmp/${RUN}/f4-trim.md`, content: `# F4\n\n正文。`, tags: ['spaced'] },
        testActor,
      );
      expect(await readTags(r.id)).toEqual(['spaced']);

      const space = await docSpaceService.findById(spaceAId);
      const facets = await docService.findFacets(spaceAId, space.settings);
      expect(facets.tags.find((t) => t.value === 'spaced')?.vocabStatus).toBe('canonical');

      // 还原
      await docSpaceService.update(spaceAId, { canonicalTags });
    });

    it('trim 后为空的声明 → 422（empty_value）', async () => {
      if (!dbAvailable) return;
      await expect(docSpaceService.update(spaceAId, { docTypes: ['   '] })).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_SPACE_VOCABULARY_INVALID,
          data: {
            conflicts: expect.arrayContaining([
              expect.objectContaining({ field: 'docTypes', kind: 'empty_value' }),
            ]),
          },
        },
      });
    });
  });

  // ─── 12. F6：pathTypes 冲突对带可自修正信息 ────────────────────────────

  describe('F6：pathTypes 冲突对携带下标与 docType', () => {
    it('重复 pathPrefix → conflicts 带 index/conflictingIndex/docType/conflictingDocType', async () => {
      if (!dbAvailable) return;
      await expect(
        docSpaceService.update(spaceAId, {
          pathTypes: [
            { pathPrefix: 'memory/', docType: 'memory' },
            { pathPrefix: 'docs/', docType: 'guide' },
            { pathPrefix: 'memory/', docType: 'note' },
          ],
        }),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_SPACE_VOCABULARY_INVALID,
          data: {
            conflicts: [
              {
                field: 'pathTypes',
                kind: 'duplicate_prefix',
                value: 'memory/',
                conflictsWith: 'memory/',
                index: 2,
                conflictingIndex: 0,
                docType: 'note',
                conflictingDocType: 'memory',
              },
            ],
          },
        },
      });
    });
  });

  // ─── 13. F8：forceRechunk 例外（内容未变也落 tags 并归一）──────────────

  describe('F8：forceRechunk 例外（A2 边界之外）', () => {
    it('同内容 + forceRechunk=true + alias tag → 落库归一 + 回显', async () => {
      if (!dbAvailable) return;
      const path = `tmp/${RUN}/f8-rechunk.md`;
      const first = await docService.upsert(
        spaceAId,
        { path, content: `# F8\n\n同一内容。`, tags: [] },
        testActor,
      );
      expect(await readTags(first.id)).toEqual([]);

      // 内容 hash 相同，但 forceRechunk=true → 不进 unchanged 早退，tags 照常落库并归一
      const second = await docService.upsert(
        spaceAId,
        { path, content: `# F8\n\n同一内容。`, tags: ['NPC'], forceRechunk: true },
        testActor,
      );
      expect(second.unchanged).toBeUndefined();
      expect(second.rechunked).toBe(true);
      expect(second.tagNormalizations).toEqual([{ from: 'NPC', to: 'npc' }]);
      expect(await readTags(first.id)).toEqual(['npc']);
    });
  });

  // ─── 14. DTO null 三态（@ValidateIf 回归网）───────────────────────────

  describe('DTO null 三态：三键显式 null 放行且服务层删键', () => {
    it('UpdateDocSpaceDto 三键传 null → class-validator 零错误（@ValidateIf 放行）', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        docTypes: null,
        canonicalTags: null,
        pathTypes: null,
      });
      const errors = await validate(dto);
      expect(errors).toEqual([]);
    });

    it('service.update 三键传 null → 三键全部从 settings 删除', async () => {
      if (!dbAvailable) return;
      await docSpaceService.update(spaceAId, { docTypes, canonicalTags, pathTypes });
      const saved = await docSpaceService.update(spaceAId, {
        docTypes: null,
        canonicalTags: null,
        pathTypes: null,
      });
      expect(saved.settings.docTypes).toBeUndefined();
      expect(saved.settings.canonicalTags).toBeUndefined();
      expect(saved.settings.pathTypes).toBeUndefined();
      // 还原（后续用例/其他套件按空间A 词表断言）
      await docSpaceService.update(spaceAId, { docTypes, canonicalTags, pathTypes });
    });
  });
});
