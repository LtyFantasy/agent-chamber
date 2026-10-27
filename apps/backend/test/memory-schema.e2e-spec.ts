/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块（Hument 集成一期）**数据层契约守卫**：实体声明 ↔ 迁移链建出的真实 schema
 *
 * [代码职责]
 *   - 在**真实 PG** 上核对 5 表的逐列对齐（列名集合 / 可空性 / 数据类型 / 列宽）。
 *     ⚠️ **默认值与 jsonb 的 NULL 语义不在逐列对齐的比对面内**——它们由下方独立的
 *     information_schema 断言与 ORM 往返用例钉死（"逐列对齐自动覆盖默认值"是错的）
 *   - 核对 5 个 PK 的 `DEFAULT gen_random_uuid()`、2 条 FK 的 `confdeltype='r'`（RESTRICT）、
 *     遥测两表与 claim 表**零 FK**
 *   - 核对 3 条部分索引/部分唯一索引的 `indexdef` 谓词（含"幂等键索引**必须无谓词**"）+
 *     claim 表的四列唯一索引与 `engine <> 'none'` CHECK（含 NOT NULL 行为面）
 *   - 核对 entities barrel ↔ 实体文件 glob 一致（新增实体忘了登记 barrel 会被抓）
 *   - 行为级守卫：jsonb 默认值 + 往返、`select:false`（content/rationale）的默认不出/显式带出
 *   - 默认值白名单：`correction_target_memory_id` / `memory_formation_events.diagnostics`
 *     必须**无默认值**（列级对齐看不见默认值，而默认值会让 NULL 的"本次无诊断/无更正目标"
 *     语义被静默污染，⑪ 是 correction 列的 e2e 侧呼应）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §2 数据模型（逐列契约 + 索引清单）/
 *     §8 测试矩阵（集成：逐列对齐含 PK DEFAULT / FK confdeltype ×2 / indexdef 谓词 ×3 /
 *     barrel↔glob / jsonb）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 补充: test/migration-drift-baseline.txt — [B] 段 9 条 memory 条目（本套件是它们的
 *     部分守卫：门禁只保证"与实体一致"，**部分索引谓词与 PK DEFAULT 不在它比对面内**）
 *
 * [关键不变量]（改动断言前先想清楚在防什么）
 *   - **部分索引谓词不在漂移门禁比对面内**：门禁只比对"索引是否存在"（且纯表达式索引
 *     结构性不可见）。谓词写错（如漏 `deleted_at IS NULL`、漏 `status <> 'withdrawn'`）
 *     门禁**照样绿**，只有本套件的 `indexdef` 断言能抓
 *   - **PK DEFAULT 必须真是 `gen_random_uuid()`**：漏写会被门禁判列级漂移，但"门禁没红"
 *     不等于"默认值正确"（[C] 段已空时门禁对已存在列只比对元数据期望值）——本套件直读
 *     `information_schema.columns.column_default` 钉死
 *   - **幂等键索引 `uq_memory_nominations_client_key` 必须无谓词**：加 `deleted_at IS NULL`
 *     会让幂等键随软删失效（同 key 重放可二次写入）——语义反转且无报错
 *   - **遥测两表零 FK**：加了 FK 后项目删除会连带抹掉排障证据（日志须比主体活得久）
 *   - **`select:false` 是行为契约不是装饰**：默认查询不得带出 content/rationale，
 *     重放/详情路径必须显式 `addSelect` 才拿得到
 *
 * [关联代码]
 *   - src/database/migrations/1791700000000-AddMemoryModule.ts — 本套件的核对对象
 *   - src/database/entities/memory-*.entity.ts — 实体侧列契约（逐列对齐的期望侧）
 *   - src/database/entities/index.ts — barrel（与文件 glob 一致性断言的另一半）
 *   - test/migration-drift.e2e-spec.ts — 门禁（本套件补它的谓词/PK-default 盲区）
 *
 * [持久踩坑]
 *   MEMORY-SCHEMA-E2E-CLEANUP(共享库卫生): 本套件打**共享开发库**，而 2 条 FK 是
 *     `ON DELETE RESTRICT`——残留 nomination 会让后续手动 `DELETE FROM memory_projects`
 *     报 23503（看起来像"数据坏了"）。安全方向: afterAll 按创建的 id **先删账本后删项目**。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

/**
 * Memory 模块数据层 —— 真实 PG 集成套件（方案 §8「集成」行）。
 *
 * 为什么需要它：漂移门禁只保证"实体元数据 ↔ 迁移链产物"**在它可比对的维度上**一致，
 * 而本模块最关键的几个契约恰好落在它的盲区或弱区：
 *   - 部分索引的**谓词**（3 条）不在 indexdef 比对面内（门禁只看索引名存在性）；
 *   - PK 的 `DEFAULT gen_random_uuid()`、jsonb 默认值形态需直读 information_schema；
 *   - 遥测表"**无 FK**"是刻意设计，门禁只在"实体声明了 FK"时才会报差异；
 *   - barrel 漏登记实体时，运行时 glob 仍然能加载，编译期也不报错。
 * 故本套件自持真库连接，把这些契约逐条钉死；PG 不可达时整套降级跳过（与既有真 PG
 * 套件一致的约定）。
 *
 * 环境：本地开发库 chamber-postgres（8744），连接参数沿用 TEST_DB_* 覆盖约定；
 * 所有写入按 RUN 后缀隔离，afterAll 按创建的 id 精确清理（**先账本后项目**，FK RESTRICT）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import {
  ActorType,
  MEMORY_BINDING_TYPE,
  MEMORY_ENGINE,
  MEMORY_FORMATION_OUTCOME,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  MEMORY_PROJECT_STATUS,
} from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { MemoryProject } from '../src/database/entities/memory-project.entity';
import { MemoryNomination } from '../src/database/entities/memory-nomination.entity';
import { MemoryFormationEvent } from '../src/database/entities/memory-formation-event.entity';
import { MemoryRecallEvent } from '../src/database/entities/memory-recall-event.entity';
import { MemoryEngineBindingClaim } from '../src/database/entities/memory-engine-binding-claim.entity';

/** 本地开发库连接（既有真 PG e2e 惯例：env 覆盖便于换环境跑，禁止在此写死生产凭据） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀（隔离本套件写入的数据） */
const RUN = `mem-${Date.now().toString(36)}`;

/** 实体目录（barrel↔glob 一致性的比对基准目录） */
const ENTITIES_DIR = path.join(__dirname, '..', 'src', 'database', 'entities');

/**
 * 实体列类型 → `information_schema.columns.data_type` 的映射。
 *
 * 只列本模块用到的 7 种（不追求成为通用映射器）：映射写死是刻意的——若将来实体换了
 * 列类型而这里没同步，**断言会红**（好过静默通过）。
 */
const ENTITY_TYPE_TO_INFO_SCHEMA: Record<string, string> = {
  uuid: 'uuid',
  varchar: 'character varying',
  text: 'text',
  jsonb: 'jsonb',
  boolean: 'boolean',
  int: 'integer',
  timestamptz: 'timestamp with time zone',
};

/** 5 张表 ↔ 实体类（逐列对齐与 PK 默认值断言的对照表） */
const TABLE_SPECS: { table: string; entity: EntityTarget<ObjectLiteral> }[] = [
  { table: 'memory_projects', entity: MemoryProject },
  { table: 'memory_nominations', entity: MemoryNomination },
  { table: 'memory_formation_events', entity: MemoryFormationEvent },
  { table: 'memory_recall_events', entity: MemoryRecallEvent },
  { table: 'memory_engine_binding_claims', entity: MemoryEngineBindingClaim },
];

/** information_schema 列行投影（本套件用到的字段） */
interface InfoSchemaColumn {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  character_maximum_length: number | null;
  column_default: string | null;
}

describe('Memory 模块数据层 — 实体 ↔ 迁移链 schema 逐列对齐（真实 PG）', () => {
  let ds: DataSource;
  /** PG 不可达时整套降级跳过（与既有真 PG 套件一致） */
  let dbAvailable = false;
  /** 本套件创建的行（afterAll 精确清理：先账本后项目，FK RESTRICT） */
  const createdProjectIds: string[] = [];
  const createdNominationIds: string[] = [];
  /** claim 表无 FK，删除项目不会连带清理——本套件显式按 id 删除 */
  const createdClaimIds: string[] = [];

  jest.setTimeout(60_000);

  /** 读某表的 information_schema 列清单（按列名排序，便于与实体侧逐列配对） */
  const infoSchemaColumns = async (table: string): Promise<InfoSchemaColumn[]> =>
    (await ds.query(
      `SELECT column_name, data_type, is_nullable, character_maximum_length, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY column_name`,
      [table],
    )) as InfoSchemaColumn[];

  /** 读某表的 pg_indexes 清单（indexdef 谓词断言的来源） */
  const tableIndexDefs = async (
    table: string,
  ): Promise<{ indexname: string; indexdef: string }[]> =>
    (await ds.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = $1
        ORDER BY indexname`,
      [table],
    )) as { indexname: string; indexdef: string }[];

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[memory-schema e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // claim 无 FK，先按 id 清（顺序无关，但放在最前最直观）
    if (createdClaimIds.length > 0) {
      await ds.query(`DELETE FROM memory_engine_binding_claims WHERE id = ANY($1::uuid[])`, [
        createdClaimIds,
      ]);
    }
    // 清理顺序不可换：nominations 持有指向 projects 的 FK（RESTRICT），先删账本再删项目
    if (createdNominationIds.length > 0) {
      await ds.query(`DELETE FROM memory_nominations WHERE id = ANY($1::uuid[])`, [
        createdNominationIds,
      ]);
    }
    if (createdProjectIds.length > 0) {
      await ds.query(`DELETE FROM memory_projects WHERE id = ANY($1::uuid[])`, [createdProjectIds]);
    }
    await ds.destroy();
  });

  // ══════════════════════════════════════════════════════════════════
  // ① 5 表在场 + 逐列对齐（列名集合 / 可空性 / 数据类型 / 列宽）
  // ══════════════════════════════════════════════════════════════════

  it('① 5 张表在场，且每列与实体声明逐列对齐（名称/可空/类型/列宽）', async () => {
    if (!dbAvailable) return;

    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('memory_projects','memory_nominations','memory_formation_events','memory_recall_events','memory_engine_binding_claims')`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      'memory_engine_binding_claims',
      'memory_formation_events',
      'memory_nominations',
      'memory_projects',
      'memory_recall_events',
    ]);

    for (const spec of TABLE_SPECS) {
      const actual = await infoSchemaColumns(spec.table);
      const metadata = ds.getMetadata(spec.entity);

      // ①-a 列名集合必须逐一对应（多一列/少一列都是漂移）
      const expectedNames = metadata.columns.map((c) => c.databaseName).sort();
      expect(actual.map((c) => c.column_name)).toEqual(expectedNames);

      const actualByName = new Map(actual.map((c) => [c.column_name, c]));

      // ①-b 逐列：可空性 / 数据类型 / 列宽（列宽的"无限制"两侧都必须表达为 null）
      for (const column of metadata.columns) {
        const dbColumn = actualByName.get(column.databaseName);
        expect(dbColumn).toBeDefined();
        if (!dbColumn) continue;

        expect({
          column: column.databaseName,
          nullable: dbColumn.is_nullable,
        }).toEqual({ column: column.databaseName, nullable: column.isNullable ? 'YES' : 'NO' });

        const expectedType = ENTITY_TYPE_TO_INFO_SCHEMA[column.type as string];
        expect({ column: column.databaseName, type: dbColumn.data_type }).toEqual({
          column: column.databaseName,
          type: expectedType,
        });

        expect({
          column: column.databaseName,
          length: dbColumn.character_maximum_length,
        }).toEqual({
          column: column.databaseName,
          // ColumnMetadata.length 对"无长度约束"既可能是 undefined 也可能是 ''（uuid/int/text
          // 等由 TypeORM 置空串），两侧都必须归一成 null 才能与 information_schema 对齐
          length:
            column.length === undefined || column.length === null || column.length === ''
              ? null
              : Number(column.length),
        });
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ② PK 默认值 ×4（方案 §2：漏 DEFAULT 会被门禁判列级漂移）
  // ══════════════════════════════════════════════════════════════════

  it('② 5 表 PK 均为 uuid 且 DEFAULT gen_random_uuid()', async () => {
    if (!dbAvailable) return;

    for (const spec of TABLE_SPECS) {
      const columns = await infoSchemaColumns(spec.table);
      const idColumn = columns.find((c) => c.column_name === 'id');
      expect({ table: spec.table, type: idColumn?.data_type }).toEqual({
        table: spec.table,
        type: 'uuid',
      });
      // 直读库侧默认值：这是"实体元数据期望 uuid_generate_v4()、迁移写 gen_random_uuid()"
      // 也照样能通过门禁的盲区（两边都合法但必须与契约一致）
      expect({ table: spec.table, default: idColumn?.column_default }).toEqual({
        table: spec.table,
        default: 'gen_random_uuid()',
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ③ FK：仅 2 条、全 RESTRICT；遥测两表零 FK
  // ══════════════════════════════════════════════════════════════════

  it('③ 仅 nominations 两条 FK 且 confdeltype=r（RESTRICT）；遥测两表零 FK', async () => {
    if (!dbAvailable) return;

    const foreignKeys = (await ds.query(
      `SELECT conrelid::regclass::text AS table_name, conname, confdeltype
         FROM pg_constraint
        WHERE contype = 'f' AND conrelid::regclass::text LIKE 'memory%'
        ORDER BY conname`,
    )) as { table_name: string; conname: string; confdeltype: string }[];

    // 全库 memory 域的 FK 有且仅有这 2 条（遥测两表 + claim 表刻意无 FK：日志/占用
    // 须比主体活得久，删项目不得连带释放 claim）
    expect(foreignKeys.map((fk) => `${fk.table_name}:${fk.conname}:${fk.confdeltype}`)).toEqual([
      'memory_nominations:memory_nominations_correction_of_fkey:r',
      'memory_nominations:memory_nominations_project_id_fkey:r',
    ]);

    const claimFks = (await ds.query(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND conrelid = 'memory_engine_binding_claims'::regclass`,
    )) as { conname: string }[];
    expect(claimFks).toEqual([]);
  });

  it('③-b FK RESTRICT 的行为面：有账本行时删项目必须被拒（23503）', async () => {
    if (!dbAvailable) return;

    const projectId = await insertProject(`restrict-${RUN}`);
    createdProjectIds.push(projectId);
    const nominationId = await insertNomination(projectId, {});
    createdNominationIds.push(nominationId);

    // confdeltype='r' 的语义面：不是"删不掉列"，而是"删父行被拒"
    await expect(
      ds.query(`DELETE FROM memory_projects WHERE id = $1`, [projectId]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  // ══════════════════════════════════════════════════════════════════
  // ④ 部分索引 / 部分唯一索引的 indexdef 谓词（门禁盲区，本套件是唯一守卫）
  // ══════════════════════════════════════════════════════════════════

  it('④ 3 条带谓词索引的 indexdef 与设计逐字一致；幂等键索引必须无谓词', async () => {
    if (!dbAvailable) return;

    // --- memory_projects：slug 部分唯一（软删让位） ---
    const projectIndexes = await tableIndexDefs('memory_projects');
    const slugIndex = projectIndexes.find((i) => i.indexname === 'uq_memory_projects_slug');
    expect(slugIndex?.indexdef).toMatch(/CREATE UNIQUE INDEX uq_memory_projects_slug .*\(slug\)/);
    expect(slugIndex?.indexdef).toMatch(/WHERE \(deleted_at IS NULL\)/);

    // --- memory_nominations：两条部分索引 + 更正唯一位 + 幂等键 ---
    const nominationIndexes = await tableIndexDefs('memory_nominations');
    const indexDefOf = (name: string): string =>
      nominationIndexes.find((i) => i.indexname === name)?.indexdef ?? '';

    const statusIndex = indexDefOf('idx_memory_nominations_project_status');
    expect(statusIndex).toMatch(/\(project_id, status\)/);
    expect(statusIndex).toMatch(/WHERE \(deleted_at IS NULL\)/);

    const categoryIndex = indexDefOf('idx_memory_nominations_project_category');
    expect(categoryIndex).toMatch(/\(project_id, category\)/);
    expect(categoryIndex).toMatch(/WHERE \(deleted_at IS NULL\)/);

    // 更正唯一位：三重谓词缺一不可（去掉 status<>'withdrawn' ⇒ 更正失败后同一 old 永久锁死）
    const correctionIndex = indexDefOf('uq_memory_nominations_correction_of');
    expect(correctionIndex).toMatch(/CREATE UNIQUE INDEX uq_memory_nominations_correction_of/);
    expect(correctionIndex).toMatch(/\(correction_of\)/);
    expect(correctionIndex).toMatch(/WHERE \(\(correction_of IS NOT NULL\)/);
    expect(correctionIndex).toMatch(/\(deleted_at IS NULL\)/);
    expect(correctionIndex).toMatch(/\(status\)::text <> 'withdrawn'::text/);

    // 幂等键：**必须无谓词**（加了 deleted_at IS NULL 会让同 key 重放在软删后可二次写入）
    const clientKeyIndex = indexDefOf('uq_memory_nominations_client_key');
    expect(clientKeyIndex).toMatch(
      /CREATE UNIQUE INDEX uq_memory_nominations_client_key .*\(nominator_id, client_request_id\)/,
    );
    expect(clientKeyIndex).not.toMatch(/WHERE/);

    // --- 遥测两表：(project_id, created_at) 且无谓词 ---
    for (const [table, expectedName] of [
      ['memory_formation_events', 'idx_memory_formation_events_project_created'],
      ['memory_recall_events', 'idx_memory_recall_events_project_created'],
    ] as const) {
      const defs = await tableIndexDefs(table);
      const indexDef = defs.find((i) => i.indexname === expectedName)?.indexdef ?? '';
      expect(indexDef).toMatch(/\(project_id, created_at\)/);
      expect(indexDef).not.toMatch(/WHERE/);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ④-b 引擎身份占用表：四列唯一索引 + engine<>'none' CHECK + 四列 NOT NULL
  //      （漂移门禁只看索引名存在性；谓词/CHECK/NOT NULL 的行为面只能在这里钉）
  // ══════════════════════════════════════════════════════════════════

  it('④-b claim 表四列唯一索引无谓词、CHECK engine<>none、四列 NOT NULL', async () => {
    if (!dbAvailable) return;

    const defs = await tableIndexDefs('memory_engine_binding_claims');
    const uniqueIndex =
      defs.find((i) => i.indexname === 'uq_memory_engine_binding_claims_triple')?.indexdef ?? '';
    expect(uniqueIndex).toMatch(
      /CREATE UNIQUE INDEX uq_memory_engine_binding_claims_triple .*\(engine, engine_workspace_id, engine_actor_id, engine_credential_ref\)/,
    );
    // 永久占用：不允许部分谓词（没有 deleted_at 可让位）
    expect(uniqueIndex).not.toMatch(/WHERE/);

    const checks = (await ds.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE contype = 'c' AND conrelid = 'memory_engine_binding_claims'::regclass`,
    )) as { conname: string; definition: string }[];
    const engineCheck = checks.find(
      (c) => c.conname === 'chk_memory_engine_binding_claims_engine_not_none',
    );
    expect(engineCheck?.definition).toMatch(/engine/);
    expect(engineCheck?.definition).toMatch(/<>/);
    expect(engineCheck?.definition).toMatch(/'none'/);

    // NOT NULL 的库侧事实（① 从实体元数据比；这里直读 information_schema 再钉一遍）
    const columns = await infoSchemaColumns('memory_engine_binding_claims');
    for (const name of [
      'engine',
      'engine_workspace_id',
      'engine_actor_id',
      'engine_credential_ref',
      'project_id',
      'first_claimed_at',
    ]) {
      expect({
        column: name,
        nullable: columns.find((c) => c.column_name === name)?.is_nullable,
      }).toEqual({ column: name, nullable: 'NO' });
    }
    expect(columns.find((c) => c.column_name === 'first_claimed_at')?.column_default).toMatch(
      /^now\(\)$/,
    );

    // 行为面：唯一索引仲裁 + CHECK + NOT NULL 都是真实拦截（不是只写在 DDL 里）
    const base = {
      engine: MEMORY_ENGINE.HUMENT,
      workspace: `ws-claim-${RUN}`,
      actor: `act-claim-${RUN}`,
      credential: `cred-claim-${RUN}`,
    };
    const inserted = (await ds.query(
      `INSERT INTO memory_engine_binding_claims
         (engine, engine_workspace_id, engine_actor_id, engine_credential_ref, project_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        base.engine,
        base.workspace,
        base.actor,
        base.credential,
        '00000000-0000-0000-0000-0000000000c1',
      ],
    )) as { id: string }[];
    createdClaimIds.push(inserted[0].id);

    await expect(
      ds.query(
        `INSERT INTO memory_engine_binding_claims
           (engine, engine_workspace_id, engine_actor_id, engine_credential_ref, project_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          base.engine,
          base.workspace,
          base.actor,
          base.credential,
          '00000000-0000-0000-0000-0000000000c2',
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      ds.query(
        `INSERT INTO memory_engine_binding_claims
           (engine, engine_workspace_id, engine_actor_id, engine_credential_ref, project_id)
         VALUES ('none', $1, $2, $3, $4)`,
        [base.workspace, base.actor, base.credential, '00000000-0000-0000-0000-0000000000c3'],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      ds.query(
        `INSERT INTO memory_engine_binding_claims
           (engine, engine_workspace_id, engine_actor_id, engine_credential_ref, project_id)
         VALUES ($1, NULL, $2, $3, $4)`,
        [base.engine, base.actor, base.credential, '00000000-0000-0000-0000-0000000000c4'],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑤ barrel ↔ 实体文件 glob 一致（新增实体忘登记 barrel 会被抓）
  // ══════════════════════════════════════════════════════════════════

  it('⑤ entities/index.ts 导出集合与实体文件 glob 完全一致（含 5 个 memory 实体）', async () => {
    if (!dbAvailable) return;

    // 文件 glob：目录下所有 *.entity.ts（运行时 glob 自动加载面）
    const globFiles = fs
      .readdirSync(ENTITIES_DIR)
      .filter((file) => file.endsWith('.entity.ts'))
      .sort();

    // barrel：解析 index.ts 的 `export { X } from './y.entity';` 行
    const barrelSource = fs.readFileSync(path.join(ENTITIES_DIR, 'index.ts'), 'utf8');
    const barrelEntries = [
      ...barrelSource.matchAll(/export \{ (\w+) \} from '\.\/([\w.-]+)';/g),
    ].map((match) => ({ name: match[1], file: match[2] }));

    // barrel 里的模块路径是 `./x.entity`（无扩展名），glob 是文件名（含 `.ts`）——补扩展名后比对
    expect(barrelEntries.map((entry) => `${entry.file}.ts`).sort()).toEqual(globFiles);

    // 运行时面：每个实体文件导出的类名集合 == barrel 声明名集合
    const runtimeClassNames = new Set<string>();
    for (const file of globFiles) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const moduleExports = require(path.join(ENTITIES_DIR, file)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(moduleExports)) {
        // 只收类（entity 文件也可能导出字符串/数组常量，见 api-usage-stats-hourly /
        // roundtable-permission-request 先例；type-only 导出在运行时不存在）
        if (typeof value === 'function') runtimeClassNames.add(name);
      }
    }
    expect([...runtimeClassNames].sort()).toEqual(barrelEntries.map((e) => e.name).sort());

    // 5 个 memory 实体必须在 barrel 里（本批新增的显式回归点）
    const barrelNames = barrelEntries.map((entry) => entry.name);
    expect(barrelNames).toEqual(
      expect.arrayContaining([
        'MemoryProject',
        'MemoryNomination',
        'MemoryFormationEvent',
        'MemoryRecallEvent',
        'MemoryEngineBindingClaim',
      ]),
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑥ jsonb 默认值与往返
  // ══════════════════════════════════════════════════════════════════

  it('⑥ jsonb 默认值为 []（库侧）+ ORM 往返保持形状', async () => {
    if (!dbAvailable) return;

    // ⑥-a 库侧默认值：raw INSERT 省略 jsonb 列 → 读回必须是空数组（不是 NULL）
    const rawProject = (await ds.query(
      `INSERT INTO memory_projects (slug, name, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, bindings, engine, status`,
      [`defaults-${RUN}`, 'Defaults', '00000000-0000-0000-0000-000000000001'],
    )) as { id: string; bindings: unknown; engine: string; status: string }[];
    createdProjectIds.push(rawProject[0].id);
    expect(rawProject[0].bindings).toEqual([]);
    expect(rawProject[0].engine).toBe(MEMORY_ENGINE.NONE);
    expect(rawProject[0].status).toBe(MEMORY_PROJECT_STATUS.ACTIVE);

    const rawNomination = (await ds.query(
      `INSERT INTO memory_nominations (project_id, nominator_id, nominator_type, category, subject, scope, content, rationale)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, source_refs, formation_state, deferred, status, content_truncated`,
      [
        rawProject[0].id,
        '00000000-0000-0000-0000-000000000002',
        ActorType.AGENT,
        'ruling',
        'subject',
        'scope',
        'body',
        'why',
      ],
    )) as {
      id: string;
      source_refs: unknown;
      formation_state: string;
      deferred: boolean;
      status: string;
      content_truncated: boolean;
    }[];
    createdNominationIds.push(rawNomination[0].id);
    expect(rawNomination[0].source_refs).toEqual([]);
    expect(rawNomination[0].formation_state).toBe(MEMORY_FORMATION_STATE.SUBMITTED);
    expect(rawNomination[0].deferred).toBe(false);
    expect(rawNomination[0].status).toBe(MEMORY_NOMINATION_STATUS.ACTIVE);
    expect(rawNomination[0].content_truncated).toBe(false);

    // ⑥-b 库侧 jsonb 默认值的表达式形态（与实体 default: [] 对齐）
    const projectColumns = await infoSchemaColumns('memory_projects');
    expect(projectColumns.find((c) => c.column_name === 'bindings')?.column_default).toBe(
      `'[]'::jsonb`,
    );
    const nominationColumns = await infoSchemaColumns('memory_nominations');
    expect(nominationColumns.find((c) => c.column_name === 'source_refs')?.column_default).toBe(
      `'[]'::jsonb`,
    );

    // ⑥-b' `correction_target_memory_id` 必须**无默认值**：它的语义是"仅更正行有意义"
    // （普通提名行恒 NULL）。给个默认值会让每条普通提名行都带上一个"更正目标"，语义被静默污染，
    // 而列级对齐（① 的 metadata 比对）**看不见默认值**——故在此显式钉死。
    expect(
      nominationColumns.find((c) => c.column_name === 'correction_target_memory_id')
        ?.column_default,
    ).toBeNull();

    // ⑥-b'' 召回原文留存两列的**默认值形态**（同 ⑥-b' 理由：① 的列级对齐看不见默认值）：
    //   - `memory_projects.retain_query_text` 默认必须是 **true**——"默认开"是产品裁决
    //     （内部项目排障刚需）；库侧被改回 false 会让"会话压缩后召回排障断链"静默复发。
    //   - `memory_recall_events.query_text` 必须**无默认值**：只有写路径显式落原文或 NULL，
    //     给个默认值（哪怕是空串）都会把"没留存"写成看起来像"查了个空查询"的行。
    const recallColumns = await infoSchemaColumns('memory_recall_events');
    expect(projectColumns.find((c) => c.column_name === 'retain_query_text')?.column_default).toBe(
      'true',
    );
    expect(recallColumns.find((c) => c.column_name === 'query_text')?.column_default).toBeNull();

    // ⑥-c ORM 往返：写结构化 jsonb（绑定列表 / 来源引用）→ 读回深度相等
    const ormProject = await ds.getRepository(MemoryProject).save(
      ds.getRepository(MemoryProject).create({
        slug: `roundtrip-${RUN}`,
        name: 'Roundtrip',
        bindings: [{ type: MEMORY_BINDING_TYPE.TOPIC, id: '11111111-1111-1111-1111-111111111111' }],
        createdBy: '00000000-0000-0000-0000-000000000003',
      }),
    );
    createdProjectIds.push(ormProject.id);

    const ormNomination = await ds.getRepository(MemoryNomination).save(
      ds.getRepository(MemoryNomination).create({
        projectId: ormProject.id,
        nominatorId: '00000000-0000-0000-0000-000000000004',
        nominatorType: ActorType.AGENT,
        category: 'ruling',
        subject: 'ORM roundtrip',
        scope: 'project',
        content: 'body',
        rationale: 'why',
        sourceRefs: [
          {
            type: 'doc',
            id: '22222222-2222-2222-2222-222222222222',
            parent: { type: 'docSpace', id: '33333333-3333-3333-3333-333333333333' },
            versionHash: 'abcdef012345',
            headingPath: 'A § B',
            excerpt: 'excerpt',
          },
        ],
      }),
    );
    createdNominationIds.push(ormNomination.id);

    const reloadedProject = await ds
      .getRepository(MemoryProject)
      .findOneByOrFail({ id: ormProject.id });
    expect(reloadedProject.bindings).toEqual([
      { type: MEMORY_BINDING_TYPE.TOPIC, id: '11111111-1111-1111-1111-111111111111' },
    ]);

    const reloadedNomination = await ds
      .getRepository(MemoryNomination)
      .findOneByOrFail({ id: ormNomination.id });
    expect(reloadedNomination.sourceRefs).toEqual([
      {
        type: 'doc',
        id: '22222222-2222-2222-2222-222222222222',
        parent: { type: 'docSpace', id: '33333333-3333-3333-3333-333333333333' },
        versionHash: 'abcdef012345',
        headingPath: 'A § B',
        excerpt: 'excerpt',
      },
    ]);

    // ⑥-d `memory_formation_events.diagnostics`（b4d41314）：**无默认值** + 可空 + ORM 往返。
    //   列名/可空/类型已由 ① 的逐列对齐覆盖；这里补的是它**看不见**的默认值形态，以及
    //   "省略该列 INSERT ⇒ NULL"的语义（NULL = 本次无诊断是合法态，且没有回填）。
    const eventColumns = await infoSchemaColumns('memory_formation_events');
    const diagnosticsColumn = eventColumns.find((c) => c.column_name === 'diagnostics');
    expect(diagnosticsColumn?.data_type).toBe('jsonb');
    expect(diagnosticsColumn?.is_nullable).toBe('YES');
    expect(diagnosticsColumn?.column_default).toBeNull();

    const eventRepo = ds.getRepository(MemoryFormationEvent);
    const createdEventIds: string[] = [];
    try {
      const bareEvent = await eventRepo.save(
        eventRepo.create({
          projectId: ormProject.id,
          ledgerId: ormNomination.id,
          category: 'ruling',
          outcome: MEMORY_FORMATION_OUTCOME.UNKNOWN,
          reasonCode: null,
          latencyMs: 1,
          quotaConsumed: false,
          retryCount: 0,
          recoveryPath: null,
          // diagnostics **刻意省略**（不是显式 null）：断言"不写就落 NULL"
        }),
      );
      createdEventIds.push(bareEvent.id);
      const reloadedBareEvent = await eventRepo.findOneByOrFail({ id: bareEvent.id });
      expect(reloadedBareEvent.diagnostics).toBeNull();

      const diagnostics = {
        admissionCause: 'prefix_unresolved',
        requestId: 'req-schema-1',
      };
      const diagnosticEvent = await eventRepo.save(
        eventRepo.create({
          projectId: ormProject.id,
          ledgerId: ormNomination.id,
          category: 'ruling',
          outcome: MEMORY_FORMATION_OUTCOME.UNKNOWN,
          reasonCode: 'conflict',
          latencyMs: 2,
          quotaConsumed: false,
          retryCount: 1,
          recoveryPath: null,
          diagnostics,
        }),
      );
      createdEventIds.push(diagnosticEvent.id);
      const reloadedDiagnosticEvent = await eventRepo.findOneByOrFail({
        id: diagnosticEvent.id,
      });
      expect(reloadedDiagnosticEvent.diagnostics).toEqual(diagnostics);
    } finally {
      // 本套件 afterAll 只清 projects/nominations；遥测表无 FK、不是常规写入面，精确清理
      if (createdEventIds.length > 0) {
        await ds.query(`DELETE FROM memory_formation_events WHERE id = ANY($1::uuid[])`, [
          createdEventIds,
        ]);
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑦ select:false 行为（content / rationale / query_text）
  // ══════════════════════════════════════════════════════════════════

  it('⑦ 默认查询不带出 content/rationale/query_text；显式 addSelect 才带出', async () => {
    if (!dbAvailable) return;

    const projectId = await insertProject(`select-false-${RUN}`);
    createdProjectIds.push(projectId);
    const nominationId = await insertNomination(projectId, {
      content: `secret-body-${RUN}`,
      rationale: `secret-rationale-${RUN}`,
    });
    createdNominationIds.push(nominationId);

    // ⑦-a 默认 findOne：两列必须**不被加载**（TypeORM 仍会在实例上留 undefined 属性，
    // 故断言的是值而非属性存在性——真正的契约就是"默认查询拿不到这两列的正文"）
    const defaultRow = await ds.getRepository(MemoryNomination).findOneByOrFail({
      id: nominationId,
    });
    expect(defaultRow.content).toBeUndefined();
    expect(defaultRow.rationale).toBeUndefined();
    // 非 select:false 的列照常带出（证明查询本身正常，不是整行没读到）
    expect(defaultRow.subject).toBe('subject');

    // ⑦-b 显式 addSelect（重放/详情路径的正确姿势）：两列带出且值正确
    const explicitRow = await ds
      .getRepository(MemoryNomination)
      .createQueryBuilder('n')
      .addSelect(['n.content', 'n.rationale'])
      .where('n.id = :id', { id: nominationId })
      .getOneOrFail();
    expect(explicitRow.content).toBe(`secret-body-${RUN}`);
    expect(explicitRow.rationale).toBe(`secret-rationale-${RUN}`);

    // ⑦-c 软删列同样 select:false（软删是内部状态，出口一律 404 不泄露存在性）
    expect(defaultRow.deletedAt).toBeUndefined();

    // ⑦-d 召回**原文列**同款（`memory_recall_events.query_text`）：默认查询不带出，
    // 只有显式 addSelect / 运维 SQL 才读得到——这正是"零 API 读取面"的技术底座，
    // 少了它，原文就会随任意一次遥测查询（含未来的报表/导出）外溢。
    // （view/outcome 用字面量：这条是裸 SQL，值域单源仍是 shared 的
    //  MEMORY_RECALL_VIEW / MEMORY_RECALL_OUTCOME。）
    const recallRows = (await ds.query(
      `INSERT INTO memory_recall_events (project_id, actor_id, query_hash, query_text, view, outcome)
       VALUES ($1, $2, $3, $4, 'current', 'ok') RETURNING id`,
      [projectId, '00000000-0000-0000-0000-00000000000c', 'a'.repeat(64), `secret-query-${RUN}`],
    )) as { id: string }[];
    const recallEventId = recallRows[0].id;
    try {
      const defaultEvent = await ds.getRepository(MemoryRecallEvent).findOneByOrFail({
        id: recallEventId,
      });
      expect(defaultEvent.queryText).toBeUndefined();
      // 非 select:false 的列照常带出（证明查询本身正常，不是整行没读到）
      expect(defaultEvent.queryHash).toBe('a'.repeat(64));

      const explicitEvent = await ds
        .getRepository(MemoryRecallEvent)
        .createQueryBuilder('e')
        .addSelect('e.queryText')
        .where('e.id = :id', { id: recallEventId })
        .getOneOrFail();
      expect(explicitEvent.queryText).toBe(`secret-query-${RUN}`);
    } finally {
      // 本套件 afterAll 只清 projects/nominations（遥测两表无 FK、不是本套件的常规写入面）
      await ds.query(`DELETE FROM memory_recall_events WHERE id = $1`, [recallEventId]);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // 本套件自用插入助手（raw SQL：绕开 select:false / 默认值，直接钉库侧契约）
  // ──────────────────────────────────────────────────────────────────

  /** 插入一个 memory_projects 行（bindings 走库侧默认 [] ），返回 id */
  async function insertProject(slugSuffix: string): Promise<string> {
    const rows = (await ds.query(
      `INSERT INTO memory_projects (slug, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [`${slugSuffix}`, `Project ${slugSuffix}`, '00000000-0000-0000-0000-00000000000a'],
    )) as { id: string }[];
    return rows[0].id;
  }

  /** 插入一个 memory_nominations 行，返回 id（content/rationale 可覆盖） */
  async function insertNomination(
    projectId: string,
    overrides: { content?: string; rationale?: string },
  ): Promise<string> {
    const rows = (await ds.query(
      `INSERT INTO memory_nominations
         (project_id, nominator_id, nominator_type, category, subject, scope, content, rationale)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        projectId,
        '00000000-0000-0000-0000-00000000000b',
        ActorType.AGENT,
        'ruling',
        'subject',
        'scope',
        overrides.content ?? `body-${RUN}`,
        overrides.rationale ?? `why-${RUN}`,
      ],
    )) as { id: string }[];
    return rows[0].id;
  }
});
