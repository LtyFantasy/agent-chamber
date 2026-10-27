/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 引擎身份**永久占用**（`memory_engine_binding_claims`）的判别性验证：
 *     历史回填 winner、重跑幂等、创建/改绑的幂等与 409、并发仲裁、永久不释放
 *
 * [代码职责]
 *   - 在**全新临时库**上跑完全部 migration，再向 `memory_projects` 造 active / archived /
 *     soft-deleted 重复三元组，**直接调用** `1792400000000` 的 `up()` 验证生产回填 SQL
 *   - 用真实 PG 验证 `INSERT … ON CONFLICT DO NOTHING` + 回读归属的并发语义
 *     （mock 证明不了唯一索引的阻塞/仲裁）
 *   - 验证回填**只读** `memory_projects`（前后逐行快照相等）
 *
 * [权威文档]
 *   - 主文档: 会话计划 `constantine-pantha-lockjaw.md` §2.3 / §3.1.2 / §3.4.1
 *   - 补充: 线上 DocSpace `docs/database.md` — migration 约定；`docs/spec.md` §3.2.32
 *
 * [关键不变量]
 *   - **winner 分档固定**：active > archived > soft-deleted，同档 created_at ASC、id ASC；
 *     本套件用"active 更新但时间更晚"的夹具证明分档优先于时间。
 *   - **`up()` 可重跑**：第二遍执行后 claim 行（含 `first_claimed_at`）逐字不变。
 *   - **claim 永不释放**：改绑 / 清空 / 归档 / 软删 / 项目硬删后，别的项目用同一三元组
 *     仍然 409；claim 的 project_id 甚至可以指向一个已硬删的项目（预期状态）。
 *   - **同项目幂等**：PATCH 重发同一三元组、改绑到新三元组再改回旧三元组都成功，
 *     且 claim 行数不增加。
 *   - **engine=none / 不完整三元组不写 claim**（回填与运行期两条路径都验）。
 *
 * [关联代码]
 *   - src/database/migrations/1792400000000-AddMemoryEngineBindingClaims.ts — 被测迁移
 *   - src/database/entities/memory-engine-binding-claim.entity.ts — 表契约
 *   - src/modules/memory/memory-project.service.ts — 运行期 claim 写入面
 *   - test/memory-schema.e2e-spec.ts — 列 / NOT NULL / CHECK / 唯一索引守卫
 *   - test/migration-drift.e2e-spec.ts — 同款临时库 + 全链 migration 脚手架
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { DataSource, type DataSourceOptions } from 'typeorm';
import { ActorType, ErrorCode, MEMORY_ENGINE, MEMORY_PROJECT_STATUS } from '@agent-chamber/shared';
import { AppDataSource } from '../src/database/data-source';
import { MemoryProject } from '../src/database/entities/memory-project.entity';
import { MemoryNomination } from '../src/database/entities/memory-nomination.entity';
import { AddMemoryEngineBindingClaims1792400000000 } from '../src/database/migrations/1792400000000-AddMemoryEngineBindingClaims';
import { MemoryProjectService } from '../src/modules/memory/memory-project.service';
import type { MemoryAccessService } from '../src/modules/memory/memory-access.service';
import type { UnifiedActor } from '../src/common/types/actor.types';
import type {
  CreateMemoryProjectDto,
  UpdateMemoryProjectDto,
} from '../src/modules/memory/dto/project.dto';

const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

const MAINTENANCE_DB = process.env.TEST_DB_MAINTENANCE_DATABASE ?? 'postgres';
const TEMP_DB_NAME = `claims_tmp_${process.pid}_${Date.now().toString(36)}`;

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR: UnifiedActor = { id: ACTOR_ID, type: ActorType.AGENT };
const BINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const CLAIM_MIGRATION = new AddMemoryEngineBindingClaims1792400000000();

function cloneDataSourceOptions(overrides: Partial<DataSourceOptions>): DataSourceOptions {
  return {
    ...(AppDataSource.options as DataSourceOptions),
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    username: DB_CONFIG.username,
    password: DB_CONFIG.password,
    database: DB_CONFIG.database,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: false,
    ...overrides,
  } as DataSourceOptions;
}

interface ClaimRow {
  engine: string;
  engine_workspace_id: string;
  engine_actor_id: string;
  engine_credential_ref: string;
  project_id: string;
  first_claimed_at: string;
}

interface ProjectSnapshot {
  id: string;
  slug: string;
  engine: string;
  engine_workspace_id: string | null;
  engine_actor_id: string | null;
  engine_credential_ref: string | null;
  status: string;
  created_at: string;
  deleted_at: string | null;
}

/** 三元组键（断言可读性用） */
function tripleKey(engine: string, workspace: string, actor: string, credential: string): string {
  return [engine, workspace, actor, credential].join('|');
}

describe('Memory 引擎身份永久占用 — 回填 / 幂等 / 并发 / 不释放（真实 PG）', () => {
  let adminDs: DataSource;
  let db: DataSource;
  let dbAvailable = false;
  let tempDbCreated = false;
  let service: MemoryProjectService;

  jest.setTimeout(300_000);

  const resetMemoryTables = async (): Promise<void> => {
    await db.query(
      `TRUNCATE memory_formation_events, memory_recall_events, memory_engine_binding_claims,
                memory_nominations, memory_projects`,
    );
  };

  const claimRows = async (): Promise<ClaimRow[]> =>
    (await db.query(
      `SELECT engine, engine_workspace_id, engine_actor_id, engine_credential_ref, project_id,
              first_claimed_at::text AS first_claimed_at
         FROM memory_engine_binding_claims
        ORDER BY engine, engine_workspace_id, engine_actor_id, engine_credential_ref`,
    )) as ClaimRow[];

  const projectSnapshot = async (): Promise<ProjectSnapshot[]> =>
    (await db.query(
      `SELECT id, slug, engine, engine_workspace_id, engine_actor_id, engine_credential_ref,
              status, created_at::text AS created_at, deleted_at::text AS deleted_at
         FROM memory_projects
        ORDER BY id`,
    )) as ProjectSnapshot[];

  const insertProject = async (row: {
    id: string;
    slug: string;
    engine: string;
    workspace?: string | null;
    actor?: string | null;
    credential?: string | null;
    status?: string;
    createdAt: string;
    deletedAt?: string | null;
  }): Promise<void> => {
    await db.query(
      `INSERT INTO memory_projects
         (id, slug, name, bindings, engine, engine_workspace_id, engine_actor_id,
          engine_credential_ref, status, created_by, created_at, deleted_at)
       VALUES ($1, $2, $2, '[]'::jsonb, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.id,
        row.slug,
        row.engine,
        row.workspace ?? null,
        row.actor ?? null,
        row.credential ?? null,
        row.status ?? MEMORY_PROJECT_STATUS.ACTIVE,
        ACTOR_ID,
        row.createdAt,
        row.deletedAt ?? null,
      ],
    );
  };

  beforeAll(async () => {
    adminDs = new DataSource(
      cloneDataSourceOptions({
        name: 'claims-admin',
        database: MAINTENANCE_DB,
        entities: [],
        migrations: [],
      }),
    );

    try {
      await adminDs.initialize();
    } catch (err) {
      console.warn(`[memory-claims e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }

    try {
      await adminDs.query(`CREATE DATABASE "${TEMP_DB_NAME}"`);
      tempDbCreated = true;
    } catch (err) {
      throw new Error(
        `[memory-claims e2e] 无法创建临时库 "${TEMP_DB_NAME}"：${(err as Error).message}\n` +
          '本套件要求连接角色具备 CREATEDB 权限（本地 docker-compose 的 chamber 角色满足）。',
      );
    }

    db = new DataSource(cloneDataSourceOptions({ name: 'claims-temp', database: TEMP_DB_NAME }));
    await db.initialize();
    // 本套件验证加固前历史共享行的回填/逃生规则；固定旧迁移快照，不能修改共享库索引。
    // 当前完整迁移链的结构拒绝与业务 409 由 memory-project-engine-identity 套件验证。
    const legacyMigrations = db.migrations.filter(
      (migration) =>
        Number((migration.name ?? migration.constructor.name).slice(-13)) < 1792500000000,
    );
    // DataSource.migrations 属性只读，数组本身可变；保留真实入口已加载的迁移实例。
    db.migrations.splice(0, db.migrations.length, ...legacyMigrations);
    await db.runMigrations();

    const access = {
      describeUnreadableBinding: async () => null,
      resolveProjectAccess: async () => ({
        readable: true,
        writable: true,
        isGovernanceViewer: false,
        resolved: [],
      }),
    };
    service = new MemoryProjectService(
      db.getRepository(MemoryProject),
      db.getRepository(MemoryNomination),
      access as unknown as MemoryAccessService,
      null,
      null,
    );

    dbAvailable = true;
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (tempDbCreated) {
      await adminDs.query(`DROP DATABASE IF EXISTS "${TEMP_DB_NAME}" WITH (FORCE)`);
    }
    if (adminDs?.isInitialized) await adminDs.destroy();
  });

  // ══════════════════════════════════════════════════════════════════
  // ① 回填：确定性 winner + 重跑幂等 + 项目数据无损
  // ══════════════════════════════════════════════════════════════════

  it('① 回填按 active > archived > soft-deleted（同档 created_at/id 升序），重跑不改写', async () => {
    if (!dbAvailable) return;
    await resetMemoryTables();

    // 三元组 T1：active 最晚 / archived 较早 / soft-deleted 最早 ⇒ winner = active
    const t1 = { engine: MEMORY_ENGINE.HUMENT, ws: 'ws-t1', actor: 'actor-1', cred: 'cred-1' };
    const p1 = '10000000-0000-4000-8000-000000000001'; // active, 2026-01-03
    const p2 = '10000000-0000-4000-8000-000000000002'; // archived, 2026-01-01
    const p3 = '10000000-0000-4000-8000-000000000003'; // soft-deleted (status active), 2025-12-31
    await insertProject({
      id: p1,
      slug: 't1-active',
      engine: t1.engine,
      workspace: t1.ws,
      actor: t1.actor,
      credential: t1.cred,
      createdAt: '2026-01-03T00:00:00Z',
    });
    await insertProject({
      id: p2,
      slug: 't1-archived',
      engine: t1.engine,
      workspace: t1.ws,
      actor: t1.actor,
      credential: t1.cred,
      status: MEMORY_PROJECT_STATUS.ARCHIVED,
      createdAt: '2026-01-01T00:00:00Z',
    });
    await insertProject({
      id: p3,
      slug: 't1-deleted',
      engine: t1.engine,
      workspace: t1.ws,
      actor: t1.actor,
      credential: t1.cred,
      createdAt: '2025-12-31T00:00:00Z',
      deletedAt: '2026-01-10T00:00:00Z',
    });

    // 三元组 T2：archived 胜过 soft-deleted
    const t2 = { engine: MEMORY_ENGINE.HUMENT, ws: 'ws-t2', actor: 'actor-2', cred: 'cred-2' };
    const p4 = '10000000-0000-4000-8000-000000000004';
    const p5 = '10000000-0000-4000-8000-000000000005';
    await insertProject({
      id: p4,
      slug: 't2-archived',
      engine: t2.engine,
      workspace: t2.ws,
      actor: t2.actor,
      credential: t2.cred,
      status: MEMORY_PROJECT_STATUS.ARCHIVED,
      createdAt: '2026-02-02T00:00:00Z',
    });
    await insertProject({
      id: p5,
      slug: 't2-deleted',
      engine: t2.engine,
      workspace: t2.ws,
      actor: t2.actor,
      credential: t2.cred,
      createdAt: '2026-02-01T00:00:00Z',
      deletedAt: '2026-02-03T00:00:00Z',
    });

    // 三元组 T3：同为 active 且 created_at 相同 ⇒ id 小者胜
    const t3 = { engine: MEMORY_ENGINE.HUMENT, ws: 'ws-t3', actor: 'actor-3', cred: 'cred-3' };
    const p6 = '10000000-0000-4000-8000-000000000006';
    const p7 = '10000000-0000-4000-8000-000000000007';
    await insertProject({
      id: p6,
      slug: 't3-a',
      engine: t3.engine,
      workspace: t3.ws,
      actor: t3.actor,
      credential: t3.cred,
      createdAt: '2026-03-01T00:00:00Z',
    });
    await insertProject({
      id: p7,
      slug: 't3-b',
      engine: t3.engine,
      workspace: t3.ws,
      actor: t3.actor,
      credential: t3.cred,
      createdAt: '2026-03-01T00:00:00Z',
    });

    // 三元组 T4：只有 soft-deleted ⇒ 仍然占位（历史事实必须保留）
    const t4 = { engine: MEMORY_ENGINE.HUMENT, ws: 'ws-t4', actor: 'actor-4', cred: 'cred-4' };
    const p8 = '10000000-0000-4000-8000-000000000008';
    await insertProject({
      id: p8,
      slug: 't4-deleted',
      engine: t4.engine,
      workspace: t4.ws,
      actor: t4.actor,
      credential: t4.cred,
      createdAt: '2024-12-01T00:00:00Z',
      deletedAt: '2025-01-01T00:00:00Z',
    });

    // 三元组 T7：同为 active，created_at 早者胜（时间优先于 id）
    const t7 = { engine: MEMORY_ENGINE.HUMENT, ws: 'ws-t7', actor: 'actor-7', cred: 'cred-7' };
    const p11 = '10000000-0000-4000-8000-000000000011';
    const p12 = '10000000-0000-4000-8000-000000000012';
    await insertProject({
      id: p11,
      slug: 't7-late',
      engine: t7.engine,
      workspace: t7.ws,
      actor: t7.actor,
      credential: t7.cred,
      createdAt: '2026-04-02T00:00:00Z',
    });
    await insertProject({
      id: p12,
      slug: 't7-early',
      engine: t7.engine,
      workspace: t7.ws,
      actor: t7.actor,
      credential: t7.cred,
      createdAt: '2026-04-01T00:00:00Z',
    });

    // 不完整 / none / 空白三元组 ⇒ 不回填
    await insertProject({
      id: '10000000-0000-4000-8000-000000000009',
      slug: 't5-incomplete',
      engine: MEMORY_ENGINE.HUMENT,
      workspace: 'ws-t5',
      actor: null,
      credential: 'cred-5',
      createdAt: '2026-05-01T00:00:00Z',
    });
    await insertProject({
      id: '10000000-0000-4000-8000-000000000010',
      slug: 't6-none',
      engine: MEMORY_ENGINE.NONE,
      workspace: 'ws-t6',
      actor: 'actor-6',
      credential: 'cred-6',
      createdAt: '2026-05-02T00:00:00Z',
    });
    await insertProject({
      id: '10000000-0000-4000-8000-000000000013',
      slug: 't8-blank',
      engine: MEMORY_ENGINE.HUMENT,
      workspace: '   ',
      actor: 'actor-8',
      credential: 'cred-8',
      createdAt: '2026-05-03T00:00:00Z',
    });

    const before = await projectSnapshot();

    // 迁移在 runMigrations 时已执行过一次（表空）；这里再执行 = 对历史数据回填。
    // 用事务包裹，与 TypeORM `transaction='all'` 的生产执行形态一致（SET LOCAL 也才生效）。
    const runMigration = async (): Promise<void> => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await CLAIM_MIGRATION.up(runner);
        await runner.commitTransaction();
      } catch (err) {
        await runner.rollbackTransaction();
        throw err;
      } finally {
        await runner.release();
      }
    };

    await runMigration();

    const rows = await claimRows();
    const ownerByTriple = new Map(
      rows.map((row) => [
        tripleKey(
          row.engine,
          row.engine_workspace_id,
          row.engine_actor_id,
          row.engine_credential_ref,
        ),
        row.project_id,
      ]),
    );

    expect(rows).toHaveLength(5);
    expect(ownerByTriple.get(tripleKey(t1.engine, t1.ws, t1.actor, t1.cred))).toBe(p1);
    expect(ownerByTriple.get(tripleKey(t2.engine, t2.ws, t2.actor, t2.cred))).toBe(p4);
    expect(ownerByTriple.get(tripleKey(t3.engine, t3.ws, t3.actor, t3.cred))).toBe(p6);
    expect(ownerByTriple.get(tripleKey(t4.engine, t4.ws, t4.actor, t4.cred))).toBe(p8);
    expect(ownerByTriple.get(tripleKey(t7.engine, t7.ws, t7.actor, t7.cred))).toBe(p12);
    // 不完整 / none / 空白都没有 claim
    expect(ownerByTriple.has(tripleKey(MEMORY_ENGINE.HUMENT, 'ws-t5', 'actor-5', 'cred-5'))).toBe(
      false,
    );
    expect(ownerByTriple.has(tripleKey(MEMORY_ENGINE.NONE, 'ws-t6', 'actor-6', 'cred-6'))).toBe(
      false,
    );
    expect(ownerByTriple.has(tripleKey(MEMORY_ENGINE.HUMENT, '   ', 'actor-8', 'cred-8'))).toBe(
      false,
    );

    // 首次占用时间 = 同四列**全部项目**的 MIN(created_at)，owner 仍按 winner（F6）
    const claimOf = (t: { engine: string; ws: string; actor: string; cred: string }) =>
      rows.find(
        (row) =>
          tripleKey(
            row.engine,
            row.engine_workspace_id,
            row.engine_actor_id,
            row.engine_credential_ref,
          ) === tripleKey(t.engine, t.ws, t.actor, t.cred),
      );
    // T1：winner = active p1（2026-01-03），但最早占用是软删 p3（2025-12-31）
    expect(claimOf(t1)?.first_claimed_at).toContain('2025-12-31');
    // T2：winner = archived p4（2026-02-02），最早占用是软删 p5（2026-02-01）
    expect(claimOf(t2)?.first_claimed_at).toContain('2026-02-01');
    // T7：winner = p12（2026-04-01），也是最早占用
    expect(claimOf(t7)?.first_claimed_at).toContain('2026-04-01');

    // F4：第二次 up() 前为非 winner 预插一个**不同 owner + 不同 first_claimed_at** 的 claim。
    // 回填必须 ON CONFLICT DO NOTHING（若误用 DO UPDATE，会被改写回 p4 / 2026-02-02）。
    await db.query(
      `DELETE FROM memory_engine_binding_claims
        WHERE engine = $1 AND engine_workspace_id = $2
          AND engine_actor_id = $3 AND engine_credential_ref = $4`,
      [t2.engine, t2.ws, t2.actor, t2.cred],
    );
    await db.query(
      `INSERT INTO memory_engine_binding_claims
         (engine, engine_workspace_id, engine_actor_id, engine_credential_ref, project_id, first_claimed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [t2.engine, t2.ws, t2.actor, t2.cred, p5, '2000-01-01T00:00:00Z'],
    );

    const beforeRerun = await claimRows();
    await runMigration();
    expect(await claimRows()).toEqual(beforeRerun);

    const t2AfterRerun = (await claimRows()).find(
      (row) =>
        tripleKey(
          row.engine,
          row.engine_workspace_id,
          row.engine_actor_id,
          row.engine_credential_ref,
        ) === tripleKey(t2.engine, t2.ws, t2.actor, t2.cred),
    );
    expect(t2AfterRerun?.project_id).toBe(p5);
    expect(t2AfterRerun?.first_claimed_at).toContain('2000-01-01');

    // 回填只读项目：逐行快照相等（不修改/删除项目）
    expect(await projectSnapshot()).toEqual(before);
  });

  // ══════════════════════════════════════════════════════════════════
  // ② 运行期：同项目幂等 / 改绑回旧三元组 / 清空与删除都不释放
  // ══════════════════════════════════════════════════════════════════

  it('② 同项目 PATCH/回旧三元组成功且 claim 不增；清空/归档/软删/硬删都不释放', async () => {
    if (!dbAvailable) return;
    await resetMemoryTables();

    const t1 = { ws: 'ws-r1', actor: 'actor-r1', cred: 'cred-r1' };
    const t2 = { ws: 'ws-r2', actor: 'actor-r2', cred: 'cred-r2' };
    const base: CreateMemoryProjectDto = {
      slug: 'claims-a',
      name: 'Claims A',
      bindings: [{ type: 'board', id: BINDING_ID }],
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: t1.ws,
      engineActorId: t1.actor,
      engineCredentialRef: t1.cred,
    };

    const a = await service.create(ACTOR, base);
    expect(a.engineWorkspaceId).toBe(t1.ws);
    expect(await claimRows()).toHaveLength(1);
    const firstClaim = await claimRows();

    // PATCH 重发同一三元组 ⇒ 幂等，claim 行数与首次时间不变
    await service.update(ACTOR, a.id, {
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: t1.ws,
      engineActorId: t1.actor,
      engineCredentialRef: t1.cred,
    });
    expect(await claimRows()).toEqual(firstClaim);

    // 改绑到新三元组 ⇒ 新增一条；旧 claim 保留
    const rebind: UpdateMemoryProjectDto = {
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: t2.ws,
      engineActorId: t2.actor,
      engineCredentialRef: t2.cred,
    };
    await service.update(ACTOR, a.id, rebind);
    expect(await claimRows()).toHaveLength(2);

    // 改绑回旧三元组 ⇒ 成功且 claim 不增
    await service.update(ACTOR, a.id, {
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: t1.ws,
      engineActorId: t1.actor,
      engineCredentialRef: t1.cred,
    });
    expect(await claimRows()).toHaveLength(2);

    // 清空引擎 ⇒ 两条 claim 都保留（不释放）
    await service.update(ACTOR, a.id, { engine: MEMORY_ENGINE.NONE });
    expect(await claimRows()).toHaveLength(2);

    // 再次绑回旧三元组（claim 仍是本项目）⇒ 成功
    await service.update(ACTOR, a.id, {
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: t1.ws,
      engineActorId: t1.actor,
      engineCredentialRef: t1.cred,
    });

    const conflictingCreate = (slug: string): CreateMemoryProjectDto => ({
      ...base,
      slug,
      name: slug,
    });

    // 别的项目用同一三元组 ⇒ 409，且败者项目不落库
    await expect(service.create(ACTOR, conflictingCreate('claims-b'))).rejects.toMatchObject({
      status: 409,
      response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
    });
    expect(
      await db.query(`SELECT count(*)::int AS n FROM memory_projects WHERE slug = 'claims-b'`),
    ).toEqual([{ n: 0 }]);

    // 归档 A ⇒ claim 仍不释放
    await service.update(ACTOR, a.id, { status: MEMORY_PROJECT_STATUS.ARCHIVED });
    await expect(service.create(ACTOR, conflictingCreate('claims-b'))).rejects.toMatchObject({
      status: 409,
    });

    // 软删 A（SQL 造数）⇒ claim 仍不释放
    await db.query(`UPDATE memory_projects SET deleted_at = now() WHERE id = $1`, [a.id]);
    await expect(service.create(ACTOR, conflictingCreate('claims-b'))).rejects.toMatchObject({
      status: 409,
    });

    // 硬删 A ⇒ claim 仍不释放（project_id 指向已不存在的项目是**预期状态**）
    await db.query(`DELETE FROM memory_projects WHERE id = $1`, [a.id]);
    await expect(service.create(ACTOR, conflictingCreate('claims-b'))).rejects.toMatchObject({
      status: 409,
    });
    const finalClaims = await claimRows();
    expect(finalClaims).toHaveLength(2);
    expect(finalClaims.find((c) => c.engine_workspace_id === t1.ws)?.project_id).toBe(a.id);
    expect(
      await db.query(`SELECT count(*)::int AS n FROM memory_projects WHERE slug = 'claims-b'`),
    ).toEqual([{ n: 0 }]);

    // engine=none 即便 DTO 带了三元组也不写 claim
    const c = await service.create(ACTOR, {
      slug: 'claims-c',
      name: 'Claims C',
      bindings: [{ type: 'board', id: BINDING_ID }],
      engine: MEMORY_ENGINE.NONE,
      engineWorkspaceId: 'ws-r3',
      engineActorId: 'actor-r3',
      engineCredentialRef: 'cred-r3',
    });
    expect(c.engineWorkspaceId).toBeNull();
    expect(finalClaims.some((row) => row.engine_workspace_id === 'ws-r3')).toBe(false);
    expect(await claimRows()).toHaveLength(2);

    // 新的完整三元组 ⇒ 正常新增
    await service.create(ACTOR, {
      slug: 'claims-d',
      name: 'Claims D',
      bindings: [{ type: 'board', id: BINDING_ID }],
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: 'ws-r4',
      engineActorId: 'actor-r4',
      engineCredentialRef: 'cred-r4',
    });
    expect(await claimRows()).toHaveLength(3);
  });

  // ══════════════════════════════════════════════════════════════════
  // ③ rollout 旧项目：无 claim 时改绑/清空仍永久占用旧三元组；重复败者可逃生
  // ══════════════════════════════════════════════════════════════════

  it('③ 无 claim 旧项目的旧三元组仍永久占用；历史重复败者可改绑逃生', async () => {
    if (!dbAvailable) return;
    await resetMemoryTables();

    // 模拟 rollout 前旧项目：项目行有完整三元组，但 claim 表没有行
    const t1 = { ws: 'ws-legacy-a', actor: 'actor-legacy-a', cred: 'cred-legacy-a' };
    const legacyA = '20000000-0000-4000-8000-000000000001';
    await insertProject({
      id: legacyA,
      slug: 'legacy-a',
      engine: MEMORY_ENGINE.HUMENT,
      workspace: t1.ws,
      actor: t1.actor,
      credential: t1.cred,
      createdAt: '2026-06-01T00:00:00Z',
    });

    // 非引擎 PATCH 也要补缺失 claim（best-effort，不判 owner）
    await service.update(ACTOR, legacyA, { name: 'Legacy A renamed' });
    let claims = await claimRows();
    expect(claims).toHaveLength(1);
    expect(claims[0].project_id).toBe(legacyA);
    // M2：历史项目补录的 first_claimed_at = 项目 createdAt（2026-06-01），不是 PATCH 时间
    expect(claims[0].first_claimed_at).toContain('2026-06-01');

    // M2：已有 claim 不被 best-effort 覆盖（显式改成 2020 后再 PATCH）
    await db.query(
      `UPDATE memory_engine_binding_claims
          SET first_claimed_at = '2020-01-01T00:00:00Z'
        WHERE project_id = $1`,
      [legacyA],
    );
    await service.update(ACTOR, legacyA, { name: 'Legacy A renamed again' });
    claims = await claimRows();
    expect(claims[0].first_claimed_at).toContain('2020-01-01');

    // 清空引擎：旧 claim 永久保留，且 DO NOTHING 仍不覆盖既有首次时间
    await service.update(ACTOR, legacyA, { engine: MEMORY_ENGINE.NONE });
    claims = await claimRows();
    expect(claims).toHaveLength(1);
    expect(claims[0].project_id).toBe(legacyA);
    expect(claims[0].first_claimed_at).toContain('2020-01-01');

    // 别的项目不能再用旧三元组
    await expect(
      service.create(ACTOR, {
        slug: 'legacy-b',
        name: 'Legacy B',
        bindings: [{ type: 'board', id: BINDING_ID }],
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: t1.ws,
        engineActorId: t1.actor,
        engineCredentialRef: t1.cred,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
    });

    // ── 历史重复三元组的"败者"仍可改绑逃生 ──────────────────────────────
    await resetMemoryTables();
    const t2 = { ws: 'ws-dup', actor: 'actor-dup', cred: 'cred-dup' };
    const winner = '20000000-0000-4000-8000-000000000011';
    const loser = '20000000-0000-4000-8000-000000000012';
    await insertProject({
      id: winner,
      slug: 'dup-winner',
      engine: MEMORY_ENGINE.HUMENT,
      workspace: t2.ws,
      actor: t2.actor,
      credential: t2.cred,
      createdAt: '2026-07-01T00:00:00Z',
    });
    await insertProject({
      id: loser,
      slug: 'dup-loser',
      engine: MEMORY_ENGINE.HUMENT,
      workspace: t2.ws,
      actor: t2.actor,
      credential: t2.cred,
      status: MEMORY_PROJECT_STATUS.ARCHIVED,
      createdAt: '2026-07-02T00:00:00Z',
    });
    // 模拟回填 winner = active winner
    await db.query(
      `INSERT INTO memory_engine_binding_claims
         (engine, engine_workspace_id, engine_actor_id, engine_credential_ref, project_id, first_claimed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [MEMORY_ENGINE.HUMENT, t2.ws, t2.actor, t2.cred, winner, '2026-07-01T00:00:00Z'],
    );

    const t3 = { ws: 'ws-dup-new', actor: 'actor-dup-new', cred: 'cred-dup-new' };
    const updated = await service.update(ACTOR, loser, {
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: t3.ws,
      engineActorId: t3.actor,
      engineCredentialRef: t3.cred,
    });
    expect(updated.engineWorkspaceId).toBe(t3.ws);

    const after = await claimRows();
    expect(after).toHaveLength(2);
    expect(after.find((c) => c.engine_workspace_id === t2.ws)?.project_id).toBe(winner);
    expect(after.find((c) => c.engine_workspace_id === t3.ws)?.project_id).toBe(loser);
  });

  // ══════════════════════════════════════════════════════════════════
  // ④ PATCH 到已占用三元组：精确 409，旧项目行与 claims 均不变（F5）
  // ══════════════════════════════════════════════════════════════════

  it('④ PATCH A 到 B 的三元组 ⇒ 409，A 行仍为旧三元组、claims 不增', async () => {
    if (!dbAvailable) return;
    await resetMemoryTables();

    const t1 = { ws: 'ws-f5-a', actor: 'actor-f5-a', cred: 'cred-f5-a' };
    const t2 = { ws: 'ws-f5-b', actor: 'actor-f5-b', cred: 'cred-f5-b' };
    const a = await service.create(ACTOR, {
      slug: 'f5-a',
      name: 'F5 A',
      bindings: [{ type: 'board', id: BINDING_ID }],
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: t1.ws,
      engineActorId: t1.actor,
      engineCredentialRef: t1.cred,
    });
    await service.create(ACTOR, {
      slug: 'f5-b',
      name: 'F5 B',
      bindings: [{ type: 'board', id: BINDING_ID }],
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: t2.ws,
      engineActorId: t2.actor,
      engineCredentialRef: t2.cred,
    });
    expect(await claimRows()).toHaveLength(2);

    await expect(
      service.update(ACTOR, a.id, {
        engine: MEMORY_ENGINE.HUMENT,
        engineWorkspaceId: t2.ws,
        engineActorId: t2.actor,
        engineCredentialRef: t2.cred,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
    });

    const rowA = (await db.query(
      `SELECT engine, engine_workspace_id, engine_actor_id, engine_credential_ref
         FROM memory_projects WHERE id = $1`,
      [a.id],
    )) as Array<{
      engine: string;
      engine_workspace_id: string;
      engine_actor_id: string;
      engine_credential_ref: string;
    }>;
    expect(rowA[0]).toEqual({
      engine: MEMORY_ENGINE.HUMENT,
      engine_workspace_id: t1.ws,
      engine_actor_id: t1.actor,
      engine_credential_ref: t1.cred,
    });
    expect(await claimRows()).toHaveLength(2);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑤ 并发：不同 slug 同三元组 ⇒ 恰好一个成功，projects/claims 各 1
  // ══════════════════════════════════════════════════════════════════

  it('⑤ 两个并发创建同三元组 ⇒ 败者 409，projects/claims 各 1 行', async () => {
    if (!dbAvailable) return;
    await resetMemoryTables();

    const triple = {
      engine: MEMORY_ENGINE.HUMENT,
      engineWorkspaceId: 'ws-race',
      engineActorId: 'actor-race',
      engineCredentialRef: 'cred-race',
    };
    const makeDto = (slug: string): CreateMemoryProjectDto => ({
      slug,
      name: slug,
      bindings: [{ type: 'board', id: BINDING_ID }],
      ...triple,
    });

    const results = await Promise.allSettled([
      service.create(ACTOR, makeDto('race-a')),
      service.create(ACTOR, makeDto('race-b')),
    ]);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> =>
        r.status === 'fulfilled',
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      status: 409,
      response: { code: ErrorCode.MEMORY_PROJECT_CONFLICT },
    });

    const projectCount = (await db.query(
      `SELECT count(*)::int AS n FROM memory_projects WHERE slug IN ('race-a','race-b')`,
    )) as { n: number }[];
    expect(projectCount[0].n).toBe(1);

    const claims = (await db.query(
      `SELECT project_id FROM memory_engine_binding_claims
        WHERE engine = $1 AND engine_workspace_id = $2
          AND engine_actor_id = $3 AND engine_credential_ref = $4`,
      [triple.engine, triple.engineWorkspaceId, triple.engineActorId, triple.engineCredentialRef],
    )) as { project_id: string }[];
    expect(claims).toHaveLength(1);
    expect(claims[0].project_id).toBe(fulfilled[0].value.id);
  });
});
