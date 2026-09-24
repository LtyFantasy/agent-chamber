/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 迁移漂移门禁（migration drift gate）：在**全新临时库**上跑完全部 migration 后，
 *     把「实体元数据 ↔ 迁移链建出的 schema」的待生成变更清单，与**显式基线文件**
 *     做集合比对。改了 entity 却忘写 migration（或补了 migration 没更新基线），本套件变红。
 *
 * [代码职责]
 *   - 用 TypeORM 自己的 schema diff（与 `migration:generate` 同一计算路径）产出清单；
 *   - 与 `test/migration-drift-baseline.txt` 集合比对（忽略注释、排序比对）；
 *   - `UPDATE_DRIFT_BASELINE=1` 时重写基线并打印条数（默认模式绝不写文件）。
 *   - 零生产代码改动、零 dev 库写入：临时库用完即 drop。
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/database.md` — 表结构/索引/迁移的权威说明
 *   - 补充: 线上 DocSpace `DEPLOY.md` — 部署链路上的 migration 防呆上下文
 *
 * [关键不变量]
 *   - **比对基准必须是「迁移链产物」**（临时库跑完全链 migration）：直接对 dev/生产库
 *     比只能证明那台机器恰好同步过；实测 dev 库根本不由迁移链产出（见 [持久踩坑]）。
 *   - **实体/迁移来源只能是 `src/database/data-source.ts` 的 options 克隆**：另抄一份
 *     entities/migrations glob = 造出第二个会漂移的源，清单即失真。
 *   - **基线只许在 commit 中显式变化**：失配时要么补 migration 让清单回到基线，要么用
 *     `UPDATE_DRIFT_BASELINE=1` 重写并随代码提交 review；禁止把基线当静默豁免（把新出现的
 *     项直接追加进基线 = 把门禁关掉）。
 *   - **迁移必须全部执行**（executed.length === 加载到的迁移数）、**实体必须真的加载到**
 *     （entityMetadatas.length > 0）：否则清单退化成"空库 vs 实体"（35 条 DROP TABLE），
 *     比对语义失效。
 *
 * [关联代码]
 *   - src/database/data-source.ts — DataSource 单源（本套件克隆其 options）
 *   - src/database/migrations/*.ts — 迁移链（临时库上全量执行）
 *   - src/database/entities/*.entity.ts — 实体元数据（被 diff 的"期望态"）
 *   - test/migration-drift-baseline.txt — 比对基线（进版本库）
 *
 * [持久踩坑]
 *   - DRIFT-BASELINE-NOT-WHITELIST(纪律): 基线是「现状快照 + 变更可视化」，不是豁免名单。
 *     安全方向: 失配先判断三情形（漏写 migration / 已补 migration / 版本或迁移链变动），
 *     只有第 2 种才更新基线，且更新必须进 commit。
 *   - DRIFT-PGVERSION(版本敏感): diff 口径与 PG 大版本有关（本地开发库 15.x，生产 16.x），
 *     基线是按本地实测固化的。安全方向: 升 PG 大版本后重跑并按 diff 说明重审基线。
 *   - DRIFT-GENERATE-DANGEROUS(禁止裸 generate): 本仓 `migration:generate` 产出的 up 里
 *     含 `DROP INDEX uq_docs_space_path`（doc path 唯一性保证）、其余 3 个部分唯一索引、
 *     3 个 GIN 索引（trgm/tsvector）、3 个 `chk_*` CHECK —— 因为它们对手写迁移的裸 SQL/
 *     显式名索引而言"元数据里不存在"。安全方向: 本仓**手写 migration**，generate 产出仅
 *     可作参考、必须逐条人工审；永远不要直接提交 generate 结果。
 *   - DRIFT-TEST-TEMPDB(隔离): 临时库是唯一能"跑全链迁移 + 零风险"同时成立的做法；
 *     连 dev 库做 diff 既不能证明迁移链完整，也随时可能被别人改（实测 dev 库有迁移从未
 *     创建的 `IDX_<hash>` 索引、缺迁移创建的 GIN 索引/CHECK，是被 synchronize 类操作
 *     归一化过的状态）。安全方向: 临时库 + 失败也 drop。
 *   - DRIFT-TEST-CREATEDB(权限前提): 建临时库要求连接角色有 CREATEDB。权限不足时本套件
 *     **显式失败**（不静默跳过）——静默跳过等于这道门禁消失。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

/**
 * 迁移漂移门禁 —— 真实 PG 集成套件（Board 任务 a4fb7aee-6238-4643-86a4-bb2b99e434cf）
 *
 * 为什么需要它：`synchronize: false` 是本项目对生产数据的承诺（Schema 变更一律走
 * migration）。但"改实体忘了补 migration"这种遗漏，编译期、单测、既有真 PG e2e
 * **都不会报错**——既有 e2e 都打 dev 库，而 dev 库的 schema 早就"看起来是对的"
 * （实测并非迁移链产物，见下）。漏掉的 DDL 要等部署后某个查询 42703/22P02 才暴露。
 *
 * 执行链：
 *   维护库 CREATE DATABASE 临时库 → 克隆 data-source.ts 的 options 指到临时库
 *     → runMigrations()（全部真实迁移，含裸 SQL）
 *     → driver.createSchemaBuilder().log()（= migration:generate 的同一 diff 计算）
 *     → 与 test/migration-drift-baseline.txt 集合比对 → DROP DATABASE（失败也 drop）
 *
 * 为什么要"基线"而不是"断言清单为空"（实测事实，勿删这段）：
 *   本仓的 schema 契约**天然不等于** TypeORM 的 schema 表达——实测在全新迁移库上 diff
 *   恒为 61 条（第二期批 1 前为 59 条、经验库批 1 前为 51 条、C 类清偿前为 81 条），分两族：
 *     A 命名差异 36：迁移用显式名（`idx_*`/`uq_*`/显式 FK 名），实体用隐式 `@Index([...])`
 *       → 元数据期望 `IDX_<hash>`；改实体声明名可消，但属另一个工程。
 *     B 裸 SQL 产物 25（第二期批 1 前为 23；经验库批 1 前为 15）：TypeORM 表达不了或实体未建模——GIN
 *       trgm/tsvector 索引、部分唯一索引（含 `uq_docs_space_path`）、`chk_*` CHECK、
 *       attachments 显式 FK、经验库 8 条（4 GIN + 排序部分表达式索引 + 双 UNIQUE + FK）、
 *       第二期 2 条（`experience_judgments` 的 `(created_at DESC, id DESC)` 全序索引 +
 *       `(experience_id, created_at DESC)`；实体刻意零 `@Index`，见 §1.4 漂移预测协议）。
 *       ⚠️ **门禁盲区**（2026-09-21 批 1 评审实证）：**纯表达式索引**（indkey 全 0，
 *       被 `PostgresQueryRunner` 索引查询的 `INNER JOIN pg_attribute ON attnum =
 *       ANY(indkey)` 滤除）与 **trigger**（TypeORM 从不加载比对）对本门禁不可见——
 *       当前实例 = `idx_experience_entries_env_{os,tool,version,runtime}` 四条 +
 *       `trg_experience_entries_search_vector`。守卫 = 经验库 e2e 的 indexdef/trigger
 *       断言（plan §7），新增同类产物必须配套同类断言。
 *       ⚠️ 曾含 `idx_attachments_uploader_created` 的"同名 DROP+CREATE"对（原 17 条含此对），
 *       2026-09-19 实证其**真实成因是 [C] 列可空性的下游产物**，而非"未建模"：TypeORM
 *       `RdbmsSchemaBuilder.updateExistColumns()` 对 `findChangedColumns()`（`isNullable`
 *       不一致即算变更）命中的列调用 `dropColumnCompositeIndices()`，**丢掉所有包含该列的
 *       多列索引**，随后 `createNewIndices()` 因该索引已不在 `table.indices`（`dropIndex()`
 *       末尾 `table.removeIndex()`）而重建 ⇒ diff 成对出现。故这类"重建对"会随所涉列的
 *       nullability/类型对齐而**自动消失**（本仓实测：C 类清偿后该对同时消失，B 17→15）。
 *     C 列级真漂移 0：**28a3e799 于 2026-09-19 清偿**——24 列 NOT NULL + task_activities
 *       `old_value/new_value` text→jsonb，由 migration `1789807743843-AlignEntityContractDrift.ts`
 *       对齐（[C] 段已空，基线中不再出现该段）。
 *   因此门禁的正确形态是「**清单变化即可见**」：基线进版本库、任何新增/消失项都报错并要求
 *   人工判断，而不是追求一个永远达不到的空清单。
 *
 * 环境：本地开发库 chamber-postgres（8744），连接参数沿用既有真 PG e2e 的 `TEST_DB_*`
 * 覆盖约定；PG 不可达时整套降级跳过（与既有真 PG 套件一致）。临时库名带 pid + 时间戳，
 * 用完即 drop；**不碰 dev 库数据、不碰 dev 库 schema**。若进程被强杀导致临时库残留：
 *   docker exec chamber-postgres psql -U chamber -d postgres \
 *     -c 'DROP DATABASE IF EXISTS "drift_tmp_..." WITH (FORCE)'
 */
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AppDataSource } from '../src/database/data-source';

/** 本地开发库连接（既有真 PG e2e 惯例：env 覆盖便于换环境跑，禁止在此写死生产凭据） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/**
 * 维护库：PG 不允许在目标库内部 CREATE/DROP 它自己，故建库/删库必须连一个"别的"库。
 * 默认连模板库 `postgres`（PG 必有）。
 */
const MAINTENANCE_DB = process.env.TEST_DB_MAINTENANCE_DATABASE ?? 'postgres';

/**
 * 本次运行的临时库名。
 * 为什么带 pid + base36 时间戳：临时库是全局资源，并行 worker 与残留库都可能撞名
 * （PG 的 CREATE DATABASE 撞名直接报错，不会静默复用）。
 */
const TEMP_DB_NAME = `drift_tmp_${process.pid}_${Date.now().toString(36)}`;

/** 基线文件（进版本库；jest 的 __dirname 即本目录） */
const BASELINE_PATH = path.join(__dirname, 'migration-drift-baseline.txt');

/** 重写基线模式（默认模式绝不写文件） */
const UPDATE_MODE = process.env.UPDATE_DRIFT_BASELINE === '1';

/** 基线分族标签与说明（写入基线文件时用作分段注释；顺序即文件中的呈现顺序） */
const TAG_ORDER = ['A', 'B', 'C', '?'] as const;
const TAG_LABEL: Record<string, string> = {
  A: '命名差异 — 迁移显式名（idx_*/uq_*/显式 FK 名）↔ 实体隐式 @Index 期望的 IDX_<hash>；可修（改实体声明名），属另一个工程',
  B: '裸 SQL 产物 — TypeORM 表达不了或实体未建模：GIN trgm/tsvector 索引、部分唯一索引、chk_* CHECK、attachments 显式 FK（曾含"部分索引重建对"，2026-09-19 实证系列可空性漂移的下游产物，随 C 类清偿自动消失——见文件头注释）',
  C: '列级真漂移 — 列 nullability/type 与实体声明不一致',
  '?': '未归类新增项 — 出现即需人工判断：是「改了实体没写 migration」（应补 migration 让清单回到 A/B/C），还是新出现的族',
};

/**
 * 克隆 `AppDataSource` 的 options —— 本套件的**唯一 schema 事实来源**（禁止在测试里另抄
 * entities/migrations glob，否则测试自身成为第二个会漂移的源）。
 *
 * 覆盖仅限：① 连接项（TEST_DB_* 惯例）；② `migration:generate` CLI 同款的四个安全开关
 * （`synchronize/migrationsRun/dropSchema/logging`）——`synchronize: true` 会让
 * `initialize()` 直接改库，是本文件最不能出的事故。
 */
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

/** 基线解析结果：语句清单（去重后排序的数组）+ 语料→标签映射（重写时保留人工归类） */
interface ParsedBaseline {
  statements: string[];
  tags: Map<string, string>;
}

/**
 * 解析基线文件。
 * 语义（必须与 `serializeBaseline` 对称）：逐行读，`#` 之后是注释（忽略），空行忽略，
 * 其余整行 trim 后作为一条语句。比对是**集合语义**，故此处不去重但排序返回。
 */
function parseBaseline(text: string): ParsedBaseline {
  const statements: string[] = [];
  const tags = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const hashAt = rawLine.indexOf('#');
    const code = (hashAt >= 0 ? rawLine.slice(0, hashAt) : rawLine).trim();
    if (!code) continue;
    statements.push(code);
    const tag =
      hashAt >= 0
        ? rawLine
            .slice(hashAt + 1)
            .trim()
            .split(/\s+/)[0]
        : '';
    if (tag && TAG_ORDER.includes(tag as (typeof TAG_ORDER)[number])) tags.set(code, tag);
  }
  return { statements: statements.sort(), tags };
}

/**
 * 序列化基线：固定图例 + 按族分段（每族按字母序）+ 每族条数（生成时自动重算，不会过期）。
 * 已存在语句的族标签从旧基线继承（人工归类不丢）；新出现的语句若形如列级漂移则自动标 C，
 * 否则标 `?` —— `?` 段出现本身就是"需要人工判断"的信号。
 */
function serializeBaseline(statements: string[], prevTags: Map<string, string>): string {
  const groups = new Map<string, string[]>();
  for (const statement of statements) {
    let tag = prevTags.get(statement);
    if (!tag) tag = /ALTER COLUMN .* SET NOT NULL/.test(statement) ? 'C' : '?';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(statement);
  }

  const lines: string[] = [
    '# =============================================================================',
    '# 迁移漂移基线（test/migration-drift.e2e-spec.ts 的比对基准）',
    '# =============================================================================',
    '# 语义：集合相等 —— 解析时忽略本文件所有 # 注释与空行；每行 `#` 之前的部分是一条',
    '#       待生成变更语句。任何新增/消失项都会让 migration-drift 套件变红。',
    '# 基准来源：全新临时库跑完全部 migration 后，与实体元数据比对得到的 diff',
    '#           （即"迁移链产物 vs 实体"，**不是** dev 库的 diff——dev 库不是迁移链产物）。',
    '# 更新：UPDATE_DRIFT_BASELINE=1 pnpm --filter @agent-chamber/backend test:e2e -- migration-drift',
    '#       更新结果必须随代码一并提交 review；禁止静默改动基线（= 关掉门禁）。',
    '# 敏感度：基线对 PG 大版本敏感（本地开发库 15.x，生产 16.x）——升 PG 大版本须重审。',
    '# 分段：# [A]/[B]/[C] 为人工归类（新出现的项会落到 # [?] 段，出现即需人工判断）。',
    '# =============================================================================',
  ];

  for (const tag of TAG_ORDER) {
    const items = groups.get(tag);
    if (!items || items.length === 0) continue;
    lines.push(`# [${tag}] ${TAG_LABEL[tag]} —— ${items.length} 条`);
    for (const item of items.sort()) lines.push(`${item}    # ${tag}`);
    lines.push('#');
  }

  return lines.join('\n') + '\n';
}

/** 计算集合差异（多重集语义：同一条语句出现多次也能正确配对） */
function compareStatementSets(
  current: string[],
  baseline: string[],
): { added: string[]; removed: string[] } {
  const counts = new Map<string, number>();
  for (const statement of baseline) counts.set(statement, (counts.get(statement) ?? 0) + 1);
  const added: string[] = [];
  for (const statement of current) {
    const left = counts.get(statement) ?? 0;
    if (left > 0) counts.set(statement, left - 1);
    else added.push(statement);
  }
  const removed: string[] = [];
  for (const [statement, left] of counts) {
    for (let i = 0; i < left; i += 1) removed.push(statement);
  }
  return { added: added.sort(), removed: removed.sort() };
}

/**
 * 失配时的可操作报错（消费者是 Agent/LLM）：先给新增/消失清单，再给三情形处置指引。
 * 用 throw 而不是 expect(v, msg)：本仓库的 @types/jest 不支持 expect 的第二消息参数，
 * 且清单 + 修复命令比 jest 的数组 diff 可操作得多。
 */
function buildMismatchMessage(added: string[], removed: string[]): string {
  const fmt = (list: string[], sign: string) =>
    list.length === 0 ? ['  （无）'] : list.map((s) => `  ${sign} ${s.replace(/\s+/g, ' ')}`);
  return [
    '',
    `❌ 迁移漂移基线失配：新增 ${added.length} 项 / 消失 ${removed.length} 项`,
    `（基线定义见 ${path.relative(process.cwd(), BASELINE_PATH)}）`,
    '',
    '[新增项]（当前 diff 有、基线没有）——通常 = 改了实体但没写 migration：',
    ...fmt(added, '+'),
    '',
    '[消失项]（基线有、当前 diff 没有）——通常 = 已补 migration / 已修历史漂移：',
    ...fmt(removed, '-'),
    '',
    '三情形处置：',
    '  1) 改了实体但【没】写 migration → 先手写 migration（本仓禁止裸 generate 提交，见 spec 头',
    '     DRIFT-GENERATE-DANGEROUS），把 diff 拉回基线；本套件应重新变绿。',
    '  2) 改了实体【且】已写 migration（或修复了 C 类历史漂移）→ 用 UPDATE_DRIFT_BASELINE=1',
    '     重跑本套件重写基线，基线 diff 随代码一并提交 review。',
    '  3) 既没改实体也没写 migration 却失配 → 检查 TypeORM/PG 大版本变化（基线对 PG 大版本',
    '     敏感）或迁移链被改动。',
    '',
    '⚠️ 禁止把基线当静默豁免：直接把新增项追加进基线 = 关掉这道门禁。',
    '',
  ].join('\n');
}

describe('迁移漂移门禁 — 迁移链产物 ↔ 实体元数据（基线比对）', () => {
  /** 维护连接：只做 CREATE/DROP DATABASE */
  let adminDs: DataSource;
  /** 临时库连接：跑全链迁移 + 做 diff（options 由 data-source.ts 克隆而来） */
  let db: DataSource;
  /** 临时库是否已建出来（决定 afterAll 是否要 drop） */
  let tempDbCreated = false;
  /** 本次实际执行的迁移（自证库由全链迁移建出） */
  let executedMigrations: { name: string }[] = [];
  /** PG 不可达（与既有真 PG 套件一致地降级跳过；**建库/迁移失败不跳过**） */
  let dbAvailable = false;

  // 全链迁移 + 全库 introspection 远超 jest 默认 5s
  jest.setTimeout(300_000);

  /** 当前临时库上的待生成变更清单（= migration:generate 会写进新 migration 的 up 语句） */
  const currentDiffStatements = async (): Promise<string[]> => {
    const sqlInMemory = await db.driver.createSchemaBuilder().log();
    return sqlInMemory.upQueries.map((upQuery) => upQuery.query.trim());
  };

  beforeAll(async () => {
    adminDs = new DataSource(
      cloneDataSourceOptions({
        name: 'migration-drift-admin',
        database: MAINTENANCE_DB,
        // 维护连接不参与 metadata/diff：跳过实体与迁移加载（diff 用的那个连接保留 glob 原样）
        entities: [],
        migrations: [],
      }),
    );

    try {
      await adminDs.initialize();
    } catch (err) {
      console.warn(
        `[migration-drift e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }

    // ⚠️ 建库失败**不降级跳过**：PG 可达却建不出库 = 环境权限问题（角色缺 CREATEDB），
    // 静默跳过等于这道门禁悄悄消失。让错误直接暴露，并给出可操作的提示。
    try {
      await adminDs.query(`CREATE DATABASE "${TEMP_DB_NAME}"`);
      tempDbCreated = true;
    } catch (err) {
      throw new Error(
        `[migration-drift e2e] 无法创建临时库 "${TEMP_DB_NAME}"：${(err as Error).message}\n` +
          '本套件要求连接角色具备 CREATEDB 权限（本地 docker-compose 的 chamber 角色满足）。' +
          '换环境请用 TEST_DB_USERNAME/TEST_DB_PASSWORD 指向有该权限的角色。',
      );
    }

    db = new DataSource(
      cloneDataSourceOptions({ name: 'migration-drift-temp', database: TEMP_DB_NAME }),
    );
    await db.initialize();

    // 全链迁移：与 `typeorm migration:run` 同款调用（transaction 模式走默认值，勿改，
    // 否则测的就不是生产部署时的那条路）
    executedMigrations = await db.runMigrations();
    dbAvailable = true;
  });

  afterAll(async () => {
    // 顺序要求：先断掉临时库连接（否则 DROP 会被活动连接挡住），再 drop，最后断维护连接。
    // 用 try/finally 串起来保证「测试红了也要 drop」——否则每红一次漏一个临时库。
    try {
      if (db?.isInitialized) await db.destroy();
    } finally {
      try {
        if (tempDbCreated && adminDs?.isInitialized) {
          // WITH (FORCE)（PG 13+）兜底踢掉任何残留连接
          await adminDs.query(`DROP DATABASE IF EXISTS "${TEMP_DB_NAME}" WITH (FORCE)`);
        }
      } finally {
        if (adminDs?.isInitialized) await adminDs.destroy();
      }
    }
  });

  it('迁移链产物与基线一致（新增/消失项即为漂移信号）', async () => {
    if (!dbAvailable) return;

    // 自证①：加载到的迁移必须**全部执行**。若 glob 没加载到迁移（=0），diff 打的是一个
    // 空库，比对会变成"基线 vs 空库"的一堆 DROP，前提先在这里钉死。
    expect(executedMigrations.length).toBe(db.migrations.length);
    expect(executedMigrations.length).toBeGreaterThan(0);

    // 自证②：实体必须真的加载到。为 0 时 diff 会生成几十条 DROP TABLE，报错信息会把人
    // 引向"实体全丢"，而不是"忘了写 migration"。
    expect(db.entityMetadatas.length).toBeGreaterThan(0);

    const current = await currentDiffStatements();

    // ---------- 重写基线模式（显式触发；默认模式绝不写文件） ----------
    if (UPDATE_MODE) {
      const previous = fs.existsSync(BASELINE_PATH)
        ? parseBaseline(fs.readFileSync(BASELINE_PATH, 'utf8'))
        : { statements: [], tags: new Map<string, string>() };
      fs.writeFileSync(BASELINE_PATH, serializeBaseline(current, previous.tags), 'utf8');
      // 写回自检：重新解析必须与原集合完全一致（防序列化/解析不对称导致下次凭空失配）
      const reread = parseBaseline(fs.readFileSync(BASELINE_PATH, 'utf8'));
      const { added, removed } = compareStatementSets(current, reread.statements);
      const { added: lostFromPrev, removed: newFromPrev } = compareStatementSets(
        current,
        previous.statements,
      );
      console.log(
        `[migration-drift] 基线已重写：共 ${current.length} 条写入 ${path.relative(process.cwd(), BASELINE_PATH)}\n` +
          `  相对旧基线：新增 ${lostFromPrev.length} 条 / 消失 ${newFromPrev.length} 条\n` +
          '  ⚠️ 请 review 基线 diff 并随代码提交；禁止把基线当静默豁免。',
      );
      expect(added).toEqual([]);
      expect(removed).toEqual([]);
      return;
    }

    // ---------- 默认模式：集合比对 ----------
    if (!fs.existsSync(BASELINE_PATH)) {
      throw new Error(
        `[migration-drift] 基线文件不存在：${BASELINE_PATH}\n` +
          '首次建立基线（或基线被误删）时执行：\n' +
          '  UPDATE_DRIFT_BASELINE=1 pnpm --filter @agent-chamber/backend test:e2e -- migration-drift',
      );
    }
    const baseline = parseBaseline(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const { added, removed } = compareStatementSets(current, baseline.statements);

    if (added.length > 0 || removed.length > 0) {
      throw new Error(buildMismatchMessage(added, removed));
    }
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('漂移探针：库内多出一列必须被检出，且体现为基线失配的新增项', async () => {
    if (!dbAvailable) return;
    if (UPDATE_MODE) return; // 重写模式下不注入探针，避免把探针项写进基线

    // 门禁的失败形态是"集合失配"，而失配也可能因为比对逻辑写坏而不产生。
    // 这条探针人工制造一条确定的漂移，证明「同一套 diff + 比对机制」确实会报出差异。
    const target =
      db.entityMetadatas.find((metadata) => metadata.tableName === 'users') ??
      db.entityMetadatas[0];
    const tableName = target.tableName;

    await db.query(`ALTER TABLE "${tableName}" ADD COLUMN "__drift_probe_col" varchar(8)`);
    try {
      const drifted = await currentDiffStatements();
      const baseline = parseBaseline(fs.readFileSync(BASELINE_PATH, 'utf8'));
      const { added } = compareStatementSets(drifted, baseline.statements);
      const probe = added.filter((statement) => statement.includes('__drift_probe_col'));

      // 探针列必须出现在新增项中（= 门禁会红，且报错信息指向该列）
      expect(probe.length).toBeGreaterThan(0);
      console.log(`[migration-drift] 探针检出（新增项片段）：\n  + ${probe.join('\n  + ')}`);
    } finally {
      // 复原（临时库反正会 drop，这里复原是为了让后续新增断言仍面对"迁移建出的库"）
      await db.query(`ALTER TABLE "${tableName}" DROP COLUMN "__drift_probe_col"`);
    }
  });
});
