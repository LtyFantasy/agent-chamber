/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块（外部 IM 通知出口，一期）**数据层契约守卫**：实体声明 ↔ 迁移链建出的
 *     真实 schema（`notification_deliveries` 单表）
 *
 * [代码职责]
 *   - 在**真实 PG** 上核对逐列对齐（列名集合 / 可空性 / 数据类型 / 列宽）
 *   - 核对 PK 的 `DEFAULT gen_random_uuid()`
 *   - 核对 `attempts DEFAULT 1` 与 `created_at DEFAULT now()` 的**列级默认值**（列级对齐看不见默认值）
 *   - 核对 `status` / `category` / `title` 等**必须无默认值**（有默认值会让"未写"与"已写"混淆）
 *   - 核对索引 `idx_notification_deliveries_created` 在 `(created_at)` 上、**无谓词**
 *   - 核对 entities barrel ↔ 实体文件 glob 一致（新增实体忘了登记 barrel 会被抓）
 *   - 行为级守卫：raw INSERT 省略 `attempts` ⇒ 读回 1（"投递行恒 ≥ 1 次尝试"的库侧底座）
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §6 数据层（逐列契约 + 索引清单 +
 *     漂移预测协议）/ §9 测试契约
 *
 * [关键不变量]（改动断言前先想清楚在防什么）
 *   - **`status` / `category` 必须无默认值**：给默认值会让"忘了写终态"静默变成一行看起来成功的
 *     投递记录（本表语义 = "查得到 = 已收口"，默认值会把未收口的行伪装成已收口）。
 *   - **`attempts` 必须有 `DEFAULT 1`**：投递行只在"有过尝试"时产生 ⇒ 恒 ≥ 1。默认值丢了会让
 *     raw INSERT / 未来写路径落下 `attempts = 0` 的"零尝试投递行"，语义反转且无报错。
 *   - **`created_at` 必须有 `DEFAULT now()`**：admin 列表按它倒序分页；无默认值时任何漏写都会
 *     变成 NULL 行（排在"最早"或被 `ORDER BY ... DESC` 推到末尾），分页视图静默错位。
 *   - **索引名必须与实体 `@Index('idx_notification_deliveries_created', ...)` 逐字相同**：
 *     名字不合会让漂移门禁把裸 SQL 索引判成"实体未建模"落 [B] 段（memory 批 7 条 DROP INDEX 同源）。
 *   - **索引必须无谓词**：本表 append-only、无软删列 ⇒ 带 `WHERE` 的部分索引与全量索引语义不同，
 *     且门禁只看索引名存在性、看不见谓词（本套件是它的唯一守卫）。
 *   - **本表无 `updated_at` / 无 `deleted_at`**：一行只写一次，终态不可变；retention 清理是 DELETE。
 *
 * [关联代码]
 *   - src/database/migrations/1792100000000-AddNotificationsModule.ts — 本套件的核对对象
 *   - src/database/entities/notification-delivery.entity.ts — 实体侧列契约（逐列对齐的期望侧）
 *   - src/database/entities/index.ts — barrel（与文件 glob 一致性断言的另一半）
 *   - test/migration-drift.e2e-spec.ts — 门禁（本套件补它的 PK-default / 列默认值盲区）
 *   - test/notifications-pipeline.e2e-spec.ts — 同批次行为面（本文件负责列面，它负责行为面）
 *
 * [持久踩坑]
 *   NOTIFY-SCHEMA-E2E-SHARED-DB(共享库卫生): 本套件打**共享开发库**，写入的每一行都带 RUN 后缀的
 *     recipient，afterAll 按 recipient 精确硬删（投递表无 FK，可独立清理）。
 *
 * [铁律关联] #11(注释强制) #18(不变量检查) #20(契约即设计)
 * =============================================================================
 */

/**
 * Notifications 模块数据层 —— 真实 PG 集成套件（plan §6 逐列契约的 e2e 守卫）。
 *
 * 为什么需要它：漂移门禁只保证"实体元数据 ↔ 迁移链产物"**在它可比对的维度上**一致，而本表
 * 最关键的几个契约恰好落在它的弱区：
 *   - PK 的 `DEFAULT gen_random_uuid()`（实体侧与驱动侧等价但不保证库侧形态）；
 *   - `attempts DEFAULT 1` / `created_at DEFAULT now()` 的**列级默认值**（列名/类型对齐看不见）；
 *   - `status` / `category` **必须无默认值**（"有默认值"与"无默认值"在列级对齐里长得一样）；
 *   - 索引的**谓词**不在 indexdef 比对面内（门禁只看索引名是否存在）；
 *   - barrel 漏登记实体时运行时 glob 仍能加载、编译期也不报错。
 * 故本套件自持真库连接逐条钉死；PG 不可达时整套降级跳过（与既有真 PG 套件一致的约定）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import {
  NotificationDelivery,
  NOTIFICATION_DELIVERY_STATUSES,
} from '../src/database/entities/notification-delivery.entity';

/** 本地开发库连接（既有真 PG e2e 惯例：env 覆盖便于换环境跑，禁止在此写死生产凭据） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀（隔离本套件写入的数据） */
const RUN = `ntfs-${Date.now().toString(36)}`;

/** 实体目录（barrel↔glob 一致性的比对基准目录） */
const ENTITIES_DIR = path.join(__dirname, '..', 'src', 'database', 'entities');

/**
 * 实体列类型 → `information_schema.columns.data_type` 的映射。
 *
 * 只列本表用到的 5 种（不追求成为通用映射器）：映射写死是刻意的——若将来实体换了列类型而这里
 * 没同步，**断言会红**（好过静默通过）。
 */
const ENTITY_TYPE_TO_INFO_SCHEMA: Record<string, string> = {
  uuid: 'uuid',
  varchar: 'character varying',
  text: 'text',
  int: 'integer',
  timestamptz: 'timestamp with time zone',
};

/** 本表 ↔ 实体类（逐列对齐与默认值断言的对照） */
const TABLE_SPECS: { table: string; entity: EntityTarget<ObjectLiteral> }[] = [
  { table: 'notification_deliveries', entity: NotificationDelivery },
];

/** information_schema 列行投影（本套件用到的字段） */
interface InfoSchemaColumn {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  character_maximum_length: number | null;
  column_default: string | null;
}

describe('Notifications 数据层 — 实体 ↔ 迁移链 schema 逐列对齐（真实 PG）', () => {
  let ds: DataSource;
  /** PG 不可达时整套降级跳过（与既有真 PG 套件一致） */
  let dbAvailable = false;

  /** 收件人（带 RUN 后缀 ⇒ afterAll 可精确删干净） */
  const recipient = `ou_${RUN}`;

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

  /** 读某表的 pg_indexes 清单（indexdef 断言的来源） */
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
      console.warn(
        `[notifications-schema e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // 投递表无 FK：按收件人精确硬删（RUN 后缀保证只删本套件写入的行）
    await ds.query(`DELETE FROM notification_deliveries WHERE recipient = $1`, [recipient]);
    await ds.destroy();
  });

  // ══════════════════════════════════════════════════════════════════
  // ① 表在场 + 逐列对齐（列名集合 / 可空性 / 数据类型 / 列宽）
  // ══════════════════════════════════════════════════════════════════

  it('① 表在场，且每列与实体声明逐列对齐（名称/可空/类型/列宽）', async () => {
    if (!dbAvailable) return;

    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'notification_deliveries'`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name)).toEqual(['notification_deliveries']);

    for (const spec of TABLE_SPECS) {
      const actual = await infoSchemaColumns(spec.table);
      const metadata = ds.getMetadata(spec.entity);

      // ①-a 列名集合必须逐一对应（多一列/少一列都是漂移）
      const expectedNames = metadata.columns.map((c) => c.databaseName).sort();
      expect(actual.map((c) => c.column_name)).toEqual(expectedNames);

      const actualByName = new Map(actual.map((c) => [c.column_name, c]));

      // ①-b 逐列：可空性 / 数据类型 / 列宽
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
  // ② 列宽契约（多 provider 预留 + 截断契约的库侧宽度）
  // ══════════════════════════════════════════════════════════════════

  it('② 列宽与 plan §6 逐条一致（含多 provider 预留宽的 channel/recipient）', async () => {
    if (!dbAvailable) return;

    const columns = await infoSchemaColumns('notification_deliveries');
    const widthOf = (name: string): number | null =>
      columns.find((c) => c.column_name === name)?.character_maximum_length ?? null;

    expect({
      channel: widthOf('channel'),
      recipient: widthOf('recipient'),
      category: widthOf('category'),
      title: widthOf('title'),
      status: widthOf('status'),
      body: widthOf('body'),
    }).toEqual({
      channel: 30,
      // email / slack 预留（同列承载多 provider —— 改窄会让未来 provider 的地址被截断）
      recipient: 255,
      category: 30,
      title: 200,
      status: 20,
      // text 无宽度约束
      body: null,
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ③ PK：uuid + DEFAULT gen_random_uuid()
  // ══════════════════════════════════════════════════════════════════

  it('③ PK 为 uuid 且 DEFAULT gen_random_uuid()', async () => {
    if (!dbAvailable) return;

    const columns = await infoSchemaColumns('notification_deliveries');
    const idColumn = columns.find((c) => c.column_name === 'id');
    expect(idColumn?.data_type).toBe('uuid');
    // 直读库侧默认值：这是"实体元数据期望 uuid_generate_v4()、迁移写 gen_random_uuid()"
    // 也照样能通过门禁的盲区（两边都合法但必须与契约一致）
    expect(idColumn?.column_default).toBe('gen_random_uuid()');
  });

  // ══════════════════════════════════════════════════════════════════
  // ④ 列级默认值（列名/类型对齐看不见默认值 —— 这是门禁的盲区）
  // ══════════════════════════════════════════════════════════════════

  it('④ attempts 默认 1、created_at 默认 now()；status/category/title 必须无默认值', async () => {
    if (!dbAvailable) return;

    const columns = await infoSchemaColumns('notification_deliveries');
    const defaultOf = (name: string): string | null =>
      columns.find((c) => c.column_name === name)?.column_default ?? null;

    // 必须有默认值（丢了的后果见文件头 [关键不变量]）
    expect(defaultOf('attempts')).toBe('1');
    expect(defaultOf('created_at')).toBe('now()');

    // 必须**无**默认值：有默认值会让"忘了写终态"静默变成一行看起来成功的投递记录
    for (const column of ['status', 'category', 'channel', 'recipient', 'title', 'body']) {
      expect({ column, default: defaultOf(column) }).toEqual({ column, default: null });
    }

    // 本表刻意无 updated_at / 无 deleted_at（append-only 终态行）
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('updated_at');
    expect(names).not.toContain('deleted_at');
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑤ 索引：唯一一条、同名、无谓词
  // ══════════════════════════════════════════════════════════════════

  it('⑤ 索引有且仅有 idx_notification_deliveries_created（created_at、无谓词）+ 二期 recipient_user 索引', async () => {
    if (!dbAvailable) return;

    const indexes = await tableIndexDefs('notification_deliveries');
    // 业务索引恰好两条（plan §6：无查询路径不顺手补）。二期新增的
    // `idx_notification_deliveries_recipient_user` 由 migration 1792200000000 建、实体同名
    // `@Index` 建模（见实体文件头不变量），服务 admin 列表的 recipientUserId 过滤。
    const businessIndexes = indexes.filter((i) =>
      [
        'idx_notification_deliveries_created',
        'idx_notification_deliveries_recipient_user',
      ].includes(i.indexname),
    );
    expect(businessIndexes).toHaveLength(2);

    const createdDef = indexes.find(
      (i) => i.indexname === 'idx_notification_deliveries_created',
    )?.indexdef;
    expect(createdDef).toMatch(/CREATE (UNIQUE )?INDEX idx_notification_deliveries_created/);
    expect(createdDef).toMatch(/\(created_at\)/);
    // **必须无谓词**：本表无软删列，带 WHERE 的部分索引与全量索引语义不同
    expect(createdDef).not.toMatch(/WHERE/);

    const recipientDef = indexes.find(
      (i) => i.indexname === 'idx_notification_deliveries_recipient_user',
    )?.indexdef;
    expect(recipientDef).toMatch(/CREATE INDEX idx_notification_deliveries_recipient_user/);
    expect(recipientDef).toMatch(/\(recipient_user_id\)/);
    expect(recipientDef).not.toMatch(/WHERE/);

    // 除 PK 与这两条业务索引外，不应有别的业务索引（防止"顺手补索引"落 [B] 段噪声）
    const extras = indexes.filter(
      (i) =>
        i.indexname !== 'idx_notification_deliveries_created' &&
        i.indexname !== 'idx_notification_deliveries_recipient_user' &&
        i.indexname !== 'notification_deliveries_pkey',
    );
    expect(extras.map((i) => i.indexname)).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑥ 行为面：attempts 库侧默认 + status 值域闭合
  // ══════════════════════════════════════════════════════════════════

  it('⑥ raw INSERT 省略 attempts ⇒ 读回 1（"投递行恒 ≥ 1 次尝试"的库侧底座）', async () => {
    if (!dbAvailable) return;

    const rows = (await ds.query(
      `INSERT INTO notification_deliveries
         (channel, recipient, category, event_id, title, body, status)
       VALUES ('feishu', $1, 'direct', NULL, $2, $3, 'success')
       RETURNING id, attempts, created_at`,
      [recipient, `[schema ${RUN}]`, `default attempts ${RUN}`],
    )) as { id: string; attempts: number; created_at: string }[];

    expect(rows[0].attempts).toBe(1);
    expect(rows[0].created_at).not.toBeNull();
  });

  it('⑦ status 值域是两态闭合（success/failed）——库侧不接受第三态', async () => {
    if (!dbAvailable) return;

    // 单源常量本身两态（**无 pending**）：这是 e2e 侧对"终态两态闭合"的显式回归点
    expect([...NOTIFICATION_DELIVERY_STATUSES]).toEqual(['success', 'failed']);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑧ barrel ↔ 实体文件 glob 一致（新增实体忘登记 barrel 会被抓）
  // ══════════════════════════════════════════════════════════════════

  it('⑧ entities/index.ts 导出集合与实体文件 glob 完全一致（含 NotificationDelivery）', async () => {
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
        // 只收类（entity 文件也可能导出字符串/数组常量；type-only 导出在运行时不存在）
        if (typeof value === 'function') runtimeClassNames.add(name);
      }
    }
    expect([...runtimeClassNames].sort()).toEqual(barrelEntries.map((e) => e.name).sort());

    // 本批新增实体必须在 barrel 里（显式回归点）
    expect(barrelEntries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['NotificationDelivery']),
    );
  });
});
