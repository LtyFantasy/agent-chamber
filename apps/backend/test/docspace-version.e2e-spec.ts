/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块)
 *   - 补充: doc history MVP（doc_versions 表 + 版本 API，2026-08-18）——
 *     写钩子收口于 DocService.upsert 事务（MAX 版本号 + 同事务剪枝）；
 *     铁律 #23 教训（RT-SEAT-1）——版本插入涉及 ORM SQL 生成（raw key 命名、
 *     octet_length、DELETE 剪枝），mock 单测测不出，必须有打真实 PG 的集成覆盖
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #23(jsonb/ORM 集成覆盖) #8(测试绑定)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * doc history —— 真实 PG 集成套件（2026-08-18）
 *
 * 验证 doc_versions 行为契约（mock 单测无法覆盖的 ORM 真实行为）：
 * - 写钩子三通道 source 标记（upsert/patch/import）落库真实值
 * - version 单调递增（历史 MAX+1，删旧不归零）
 * - DOC_VERSION_KEEP=20 保留策略（25 次写 → 恰 20 条，最新 version=25）
 * - findVersions 的 getRawMany raw-key 映射 + octet_length contentSize
 * - findVersion 的前版查询（剪枝跳号语义）与读时现算 diff
 * - 软删文档 → 版本读 404（版本挂在文档生命周期下）
 *
 * DB 目标 = 本地开发库 chamber-postgres（docker-compose 默认参数，env 可覆盖）。
 * PG 不可达时整套降级跳过（warn 提示）——保持 test:e2e 在无库环境仍可全绿。
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { DocService } from '../src/modules/docspace/doc.service';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Board } from '../src/database/entities/board.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import type { EventService } from '../src/modules/event/event.service';
import type { RouteHealthService } from '../src/modules/docspace/route-health.service';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实文档互相污染 */
const RUN = `ver-e2e-${Date.now()}`;

/** 固定测试 actor（docs.created_by / doc_versions.author_actor_id 为 uuid 列） */
const testActor = { id: '00000000-0000-4000-8000-0000000000aa', type: ActorType.HUMAN };

describe('DocService doc history — 真实 PG 集成（版本插入/剪枝/读取）', () => {
  let ds: DataSource;
  let service: DocService;
  let dbAvailable = false;

  let spaceId: string;
  let docId: string;

  /** 冲刷 setImmediate 队列（route health recheck fire-and-forget） */
  const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

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
      // PG 不可达 → 整套降级跳过（本套件是环境依赖型集成测试）
      console.warn(
        `[docspace-version e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // EventService / RouteHealthService 打桩：本套件只测版本管线
    const eventStub = { create: jest.fn().mockResolvedValue({}) } as unknown as EventService;
    const routeHealthStub = {
      recheckSpace: jest.fn().mockResolvedValue({ rechecked: 0, broken: 0 }),
    } as unknown as RouteHealthService;

    service = new DocService(
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
    );

    // ── 种子数据：一个空间 + 一篇文档（路径带 RUN 后缀隔离）──
    const spaceRepo = ds.getRepository(DocSpace);
    const space = await spaceRepo.save(
      spaceRepo.create({
        name: `Version E2E ${RUN}`,
        slug: `version-e2e-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {},
      }),
    );
    spaceId = space.id;

    const created = await service.upsert(
      spaceId,
      { path: `tmp/${RUN}.md`, content: `# 版本集成测试\n\n初始内容 v1。` },
      testActor,
    );
    docId = created.id;
    await flushImmediates();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // 兜底硬删（RUN 后缀隔离，只清本次数据；软删行与版本行一并物理清理）
    const versionRepo = ds.getRepository(DocVersion);
    await versionRepo
      .createQueryBuilder()
      .delete()
      .where('doc_id IN (SELECT id FROM docs WHERE path LIKE :p)', { p: `tmp/${RUN}%` })
      .execute();
    await ds
      .getRepository(Doc)
      .createQueryBuilder()
      .delete()
      .where('path LIKE :p', { p: `tmp/${RUN}%` })
      .execute();
    await ds
      .getRepository(DocSpace)
      .createQueryBuilder()
      .delete()
      .where('slug LIKE :p', { p: `version-e2e-${RUN}%` })
      .execute();
    await ds.destroy();
  });

  describe('写钩子（upsert 事务内版本插入）', () => {
    it('创建 → 版本 v1（source=upsert，author=actor，contentSize 字节数正确）', async () => {
      const versions = await service.findVersions(docId);
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(1);
      expect(versions[0].source).toBe('upsert');
      expect(versions[0].authorActorId).toBe(testActor.id);
      expect(versions[0].contentHash).toHaveLength(64); // sha256 hex
      expect(versions[0].contentSize).toBe(
        Buffer.byteLength('# 版本集成测试\n\n初始内容 v1。', 'utf8'),
      );
    });

    it('内容变化 upsert → v2；unchanged 幂等短路 → 版本数不变', async () => {
      await service.upsert(
        spaceId,
        { path: `tmp/${RUN}.md`, content: '# 版本集成测试\n\n内容变了 v2。' },
        testActor,
      );
      await flushImmediates();

      const versions = await service.findVersions(docId);
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(2);

      // unchanged（同内容重写）→ 不产生新版本
      const dup = await service.upsert(
        spaceId,
        { path: `tmp/${RUN}.md`, content: '# 版本集成测试\n\n内容变了 v2。' },
        testActor,
      );
      expect(dup.unchanged).toBe(true);
      expect((await service.findVersions(docId)).length).toBe(2);
    });

    it('patchSection 通道 → 新版本 source=patch（局部写重建后全文快照）', async () => {
      // 该文档只有 1 节（H1），patch position 0 替换整节
      const prepatchVersions = await service.findVersions(docId);
      await service.patchSection(
        docId,
        0,
        '# 版本集成测试\n\npatch 修改后的正文。',
        'native',
        testActor,
      );
      await flushImmediates();

      const versions = await service.findVersions(docId);
      expect(versions).toHaveLength(prepatchVersions.length + 1);
      expect(versions[0].source).toBe('patch');
    });

    it('batchUpsert（import 通道）→ 新版本 source=import', async () => {
      const before = await service.findVersions(docId);
      await service.batchUpsert(
        spaceId,
        [{ path: `tmp/${RUN}.md`, content: '# 版本集成测试\n\nimport 通道写入。' }],
        testActor,
      );
      await flushImmediates();

      const versions = await service.findVersions(docId);
      expect(versions).toHaveLength(before.length + 1);
      expect(versions[0].source).toBe('import');
    });
  });

  describe('保留策略（DOC_VERSION_KEEP=20）与 version 单调递增', () => {
    it('连续写 25 版 → 恰保留 20 条，最新 version=25（删旧不归零）', async () => {
      for (let i = 5; i <= 25; i++) {
        await service.upsert(
          spaceId,
          { path: `tmp/${RUN}.md`, content: `# 版本集成测试\n\n第 ${i} 次写入的内容。` },
          testActor,
        );
      }
      await flushImmediates();

      const versions = await service.findVersions(docId);
      expect(versions).toHaveLength(20);
      // 最新在前（DESC）；version 最小 = 6（1..6 被剪掉），最大 = 25
      expect(versions[0].version).toBe(25);
      expect(versions[19].version).toBe(6);
      // 单调序列无跳号（6..25 连续）
      const nums = versions.map((v) => v.version);
      expect(nums).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    });
  });

  describe('findVersion（单版本详情 + 读时现算 diff）', () => {
    it('v1 被剪枝后 404；v6（现最早版）diff=null（无前版）', async () => {
      await expect(service.findVersion(docId, 1)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
      const v6 = await service.findVersion(docId, 6);
      expect(v6.version).toBe(6);
      expect(v6.diff).toBeNull();
      expect(v6.content).toContain('第 6 次写入的内容');
    });

    it('v7 的 diff 对前版 v6（非 version-1 陷阱；v7 与上一版内容同形对比）', async () => {
      const v7 = await service.findVersion(docId, 7);
      expect(v7.diff).not.toBeNull();
      expect(v7.diff!.fromVersion).toBe(6);
      // 第 6 次与第 7 次写入仅一行正文不同 → 行级 diff 应检出 1 删 1 增
      expect(v7.diff!.added).toBeGreaterThanOrEqual(1);
      expect(v7.diff!.removed).toBeGreaterThanOrEqual(1);
      expect(v7.diff!.unified).toContain('--- doc v6');
      expect(v7.diff!.unified).toContain('+++ doc v7');
      expect(v7.diff!.unified).toContain('第 7 次写入的内容');
      // contentSize 与字节数一致
      expect(v7.contentSize).toBe(Buffer.byteLength(v7.content, 'utf8'));
    });

    it('不存在版本 → 404 DOC_NOT_FOUND', async () => {
      await expect(service.findVersion(docId, 999)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });
  });

  describe('文档生命周期联动', () => {
    it('软删文档 → 版本读取 404（版本挂在文档生命周期下）', async () => {
      // 再建一篇独立文档用于删除测试（不动 docId 主文档）
      const tmp = await service.upsert(
        spaceId,
        { path: `tmp/${RUN}-del.md`, content: '# 将被删除\n\n正文。' },
        testActor,
      );
      await flushImmediates();
      expect((await service.findVersions(tmp.id)).length).toBe(1);

      await service.remove(tmp.id, undefined, testActor);
      await flushImmediates();

      await expect(service.findVersions(tmp.id)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });
  });
});
