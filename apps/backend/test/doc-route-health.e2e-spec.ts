/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (doc_routes 段)
 *   - 补充: 铁律 #23 教训（RT-SEAT-1）——枚举/新列 + jsonb 的 ORM 往返必须打真实 PG，
 *     mock 单测测不出 SQL 生成与列默认值行为
 *
 * [踩坑索引] -
 *
 * [铁律关联] #17(测试契约) #23(jsonb/ORM 集成覆盖) #8(测试绑定) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * doc_routes codeEntryType + recheck 豁免 —— 真实 PG 集成套件（T5）
 *
 * 与 docspace.e2e-spec.ts（全 mock）的分工：本套件打真实 PostgreSQL，直接实例化
 * RouteHealthService（真 TypeORM repo），验证：
 * ① code_entry_type 枚举列 ORM 读写往返（save → find 回读）；
 * ② health jsonb（含 codeEntryStatus:'exempt' + codeEntryNote）真实落库/回读；
 * ③ recheckSpace 按 codeEntryType 分支：exact 失配 broken / exact 命中 ok /
 *    pattern 豁免 exempt 且不计 broken；
 * ④ migration 后存量行默认值：缺 code_entry_type 的裸 INSERT → 回读 'exact'
 *    （迁移兼容铁律：存量数据无损且语义不变）。
 *
 * DB 目标 = 本地开发库 chamber-postgres（docker-compose 默认参数，env 可覆盖）。
 * PG 不可达时整套降级跳过（warn 提示）——保持 test:e2e 在无库环境仍可全绿。
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { DataSource, Repository } from 'typeorm';
import * as entities from '../src/database/entities';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { RouteHealthService } from '../src/modules/docspace/route-health.service';
import type { DocService } from '../src/modules/docspace/doc.service';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实数据互相污染 */
const RUN = `route-health-e2e-${Date.now()}`;

describe('DocRoute health recheck — 真实 PG 集成（codeEntryType exact/pattern 分支 + 列默认值）', () => {
  let ds: DataSource;
  let dbAvailable = false;

  let spaceId: string;
  let routeRepo: Repository<DocRoute>;
  let spaceRepo: Repository<DocSpace>;

  /** glob 泛化 codeEntry（字符串拼接，避免在注释中写出会被块注释提前闭合的序列） */
  const GLOB_CODE_ENTRY = 'apps/web/app/**' + '/page.tsx';

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
        `[doc-route-health e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    routeRepo = ds.getRepository(DocRoute);
    spaceRepo = ds.getRepository(DocSpace);

    // ── 种子：一个空间（带 repoManifest，供 exact 路由存在性校验）──
    const space = await spaceRepo.save(
      spaceRepo.create({
        name: `Route Health E2E ${RUN}`,
        slug: `route-health-e2e-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {
          repoManifest: {
            sha: 'test-sha',
            files: ['docs/architecture.md', 'apps/backend/src/app.module.ts'],
            reportedAt: new Date().toISOString(),
          },
        },
      }),
    );
    spaceId = space.id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    try {
      // 硬删兜底清理：只删本套件 RUN 后缀隔离的数据
      await routeRepo
        .createQueryBuilder()
        .delete()
        .where('intent LIKE :suffix', { suffix: `%${RUN}%` })
        .execute();
      await spaceRepo
        .createQueryBuilder()
        .delete()
        .where('slug LIKE :suffix', { suffix: `%${RUN}%` })
        .execute();
    } finally {
      await ds.destroy();
    }
  });

  /** 只测 codeEntry 分支：heading 全置 null（不触发 DocService 调用），docService 打桩防御 */
  function makeService(): RouteHealthService {
    const docStub = {
      sectionExistsByHeadingPath: jest.fn().mockResolvedValue(true),
    } as unknown as DocService;
    return new RouteHealthService(routeRepo, spaceRepo, docStub);
  }

  /** 直接经 repo 落库（跳过写时校验——写校验由单测覆盖，本套件聚焦 recheck/ORM 往返） */
  async function seedRoute(overrides: Partial<DocRoute>): Promise<DocRoute> {
    const row = routeRepo.create({
      spaceId,
      intent: `T5 ${RUN} ${overrides.codeEntryType ?? 'exact'}`,
      category: null,
      primaryDocId: '00000000-0000-4000-8000-0000000000aa',
      primaryHeadingPath: null,
      secondaryDocId: null,
      secondaryHeadingPath: null,
      codeEntry: null,
      codeEntryType: 'exact',
      sortOrder: 0,
      createdBy: '00000000-0000-4000-8000-0000000000bb',
      ...overrides,
    });
    return routeRepo.save(row);
  }

  it('recheck 三分支（真实 PG）：exact 命中 ok / exact 失配 broken / pattern 豁免 exempt 且不计 broken', async () => {
    if (!dbAvailable) return;

    const ok = await seedRoute({ codeEntry: 'docs/architecture.md', codeEntryType: 'exact' });
    const broken = await seedRoute({ codeEntry: 'docs/ghost.md', codeEntryType: 'exact' });
    const pattern = await seedRoute({ codeEntry: GLOB_CODE_ENTRY, codeEntryType: 'pattern' });

    const service = makeService();
    const result = await service.recheckSpace(spaceId);

    // 计数口径：pattern 豁免不参与 broken，exact 失配照计
    expect(result.rechecked).toBeGreaterThanOrEqual(3);
    expect(result.broken).toBe(1);

    // ORM 回读：枚举列 + health jsonb 往返一致
    const okRow = await routeRepo.findOne({ where: { id: ok.id } });
    const brokenRow = await routeRepo.findOne({ where: { id: broken.id } });
    const patternRow = await routeRepo.findOne({ where: { id: pattern.id } });

    expect(okRow!.codeEntryType).toBe('exact');
    expect(okRow!.health).toMatchObject({ issues: [], codeEntryStatus: 'ok' });

    expect(brokenRow!.health).toMatchObject({ codeEntryStatus: 'broken' });
    expect(brokenRow!.health!.issues).toEqual([
      { kind: 'codeEntry', target: 'codeEntry', value: 'docs/ghost.md' },
    ]);

    // pattern：code_entry_type 列真实落 'pattern'，health 为 exempt + 说明，issues 空
    expect(patternRow!.codeEntryType).toBe('pattern');
    expect(patternRow!.health).toMatchObject({
      issues: [],
      codeEntryStatus: 'exempt',
      codeEntryNote: expect.any(String),
    });
  });

  it('migration 存量行兼容：缺省 code_entry_type 的裸 INSERT → DB 默认回填 exact（存量无损语义不变）', async () => {
    if (!dbAvailable) return;

    // 模拟迁移前存量数据形态：INSERT 不带 code_entry_type 列（migration ADD COLUMN DEFAULT 'exact' 后自动回填）
    const inserted = await routeRepo
      .createQueryBuilder()
      .insert()
      .into(DocRoute)
      .values({
        spaceId,
        intent: `T5 legacy ${RUN}`,
        primaryDocId: '00000000-0000-4000-8000-0000000000aa',
        sortOrder: 9,
        createdBy: '00000000-0000-4000-8000-0000000000bb',
        // 刻意省略 codeEntryType——验证列默认值（'exact'）接管
      })
      .returning('id')
      .execute();
    const id = (inserted.raw as { id: string }[])[0].id as string;

    const row = await routeRepo.findOne({ where: { id } });
    expect(row).not.toBeNull();
    expect(row!.codeEntryType).toBe('exact');
  });
});
