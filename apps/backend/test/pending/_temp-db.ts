/**
 * 钉子用例共享装配（批次 0 第 6 项）：迁移链临时库生命周期。
 *
 * 装配范式取自 test/doc-search-prefilter.e2e-spec.ts（同一 TEST_DB_* 约定 +
 * 克隆 `AppDataSource.options` 唯一 schema/连接事实源 + runMigrations 全链 +
 * afterAll 先断临时库再 DROP FORCE）；与 prefilter 内联实现的差异：抽成共享
 * helper 供 pending 各文件复用，且临时库名带 `pid + Date.now()` 双重防撞
 * （同进程同 tag 重复建库/并发套件不撞名）。
 *
 * 降级纪律（与 prefilter 同口径）：PG 不可达 → `available=false` 用例降级 return；
 * **建库/迁移失败不降级**（静默跳过 = 门禁消失），直接抛错。
 *
 * 本文件自身不是用例（无 describe/it），`*.pending.ts` 命名使其不被任何 jest 套件
 * 发现；批次 1 激活时随用例文件一并保留。
 */
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AppDataSource } from '../../src/database/data-source';

/** 本地开发库连接（既有真 PG e2e 的 TEST_DB_* 覆盖约定；禁止在此写死生产凭据） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
} as const;

/** 维护库名（CREATE/DROP DATABASE 落点） */
const MAINTENANCE_DB = process.env.TEST_DB_MAINTENANCE_DATABASE ?? 'postgres';

/** 临时库句柄：db=null ⇔ available=false（PG 不可达降级） */
export interface TempDbHandle {
  db: DataSource | null;
  available: boolean;
}

/** 内部状态（destroy 需要维护连接与建库标志） */
interface TempDbState {
  adminDs: DataSource;
  tempDbName: string;
  created: boolean;
}

const states = new WeakMap<TempDbHandle, TempDbState>();

/**
 * 建迁移链临时库并跑全链迁移。
 *
 * @param tag 临时库名后缀（建议用文件名语义，防并发冲突自带 pid）
 * @returns 句柄；PG 不可达时 `available=false` 且 `db=null`
 * @throws PG 可达但建库/迁移失败（角色缺 CREATEDB 等）——不降级
 */
export async function createMigrationChainTempDb(tag: string): Promise<TempDbHandle> {
  // pid + Date.now(base36) 双重防撞：同进程同 tag 重复建库（beforeAll 重入/套件并发）不撞名
  const tempDbName = `test_search_pending_${tag}_${process.pid}_${Date.now().toString(36)}`;
  const handle: TempDbHandle = { db: null, available: false };

  const adminDs = new DataSource({
    ...(AppDataSource.options as DataSourceOptions),
    name: `search-pending-admin-${tag}`,
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    username: DB_CONFIG.username,
    password: DB_CONFIG.password,
    database: MAINTENANCE_DB,
    entities: [],
    migrations: [],
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: false,
  } as DataSourceOptions);

  try {
    await adminDs.initialize();
  } catch (err) {
    // PG 不可达：降级跳过（与 prefilter 同口径；CI/本地无 PG 时不挡道）
    console.warn(`[search-pending] PG unavailable, suite skipped: ${(err as Error).message}`);
    return handle;
  }

  const state: TempDbState = { adminDs, tempDbName, created: false };
  states.set(handle, state);

  // 建库失败**不降级跳过**：PG 可达却建不出库 = 角色缺 CREATEDB，静默跳过等于门禁消失
  try {
    await adminDs.query(`CREATE DATABASE "${tempDbName}"`);
    state.created = true;
  } catch (err) {
    await adminDs.destroy();
    throw new Error(
      `[search-pending] 无法创建临时库 "${tempDbName}"：${(err as Error).message}\n` +
        '本套件要求连接角色具备 CREATEDB 权限（本地 docker-compose 的 chamber 角色满足）。',
    );
  }

  const db = new DataSource({
    ...(AppDataSource.options as DataSourceOptions),
    name: `search-pending-temp-${tag}`,
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    username: DB_CONFIG.username,
    password: DB_CONFIG.password,
    database: tempDbName,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    logging: false,
  } as DataSourceOptions);
  await db.initialize();
  await db.runMigrations();

  handle.db = db;
  handle.available = true;
  return handle;
}

/**
 * 销毁句柄：先断临时库连接（否则 DROP 被活动连接挡住）→ DROP DATABASE (FORCE) →
 * 断维护连接；try/finally 串起来保证「测试红了也要 drop」。
 */
export async function destroyMigrationChainTempDb(handle: TempDbHandle): Promise<void> {
  const state = states.get(handle);
  try {
    if (handle.db?.isInitialized) await handle.db.destroy();
  } finally {
    try {
      if (state?.created && state.adminDs.isInitialized) {
        await state.adminDs.query(`DROP DATABASE IF EXISTS "${state.tempDbName}" WITH (FORCE)`);
      }
    } finally {
      if (state?.adminDs.isInitialized) await state.adminDs.destroy();
    }
  }
}
