/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 二期数据层契约守卫：`user_notification_channels`（渠道绑定 + tombstone +
 *     验证锚点）与 `notification_deliveries.recipient_user_id` 的**真实 PG** schema 对齐。
 *
 * [代码职责]
 *   - 逐列对齐（列名集合 / 可空性 / 类型 / 列宽）+ PK `DEFAULT gen_random_uuid()`
 *   - 列级默认值（`enabled=false` / `source='user'` / 时间列 `now()`）与"必须无默认值"的列
 *   - **两条唯一索引**：`uq_user_notification_channels_user_provider`（无谓词）与
 *     `uq_user_notification_channels_verified_address`（**部分唯一**，谓词逐字断言）
 *   - **FK**：约束名逐字 + `confdeltype='c'`（ON DELETE CASCADE）+ 行为验证（删用户连带删渠道行）
 *   - **部分唯一的语义回归**：只有 `last_test_status='ok'` 且未解绑的行才占地址槽；
 *     `seeded` / NULL / tombstone 都不占槽（"未验证地址不占槽"+"解绑后可释放"两条 D7 项）
 *   - `notification_deliveries` 新列 + 同名索引
 *   - barrel ↔ 实体文件 glob 一致性（新增实体忘登记会被抓）
 *
 * [权威文档]
 *   - 主文档: plan `red-tornado-wonder-woman-blue-devil.md` §D2（数据模型）/ §2 批 1
 *
 * [关键不变量]
 *   - **部分唯一的谓词是漂移门禁的盲区**（TypeORM 元数据表达不了 WHERE）——本套件是它唯一的守卫。
 *     谓词一旦丢失（例如被 generate 产成普通唯一索引），"未验证地址不占槽"这一防 griefing 的
 *     性质会静默消失：任何未验证的 claim 都能永久占死一个地址。
 *   - **FK 必须 CASCADE**：渠道绑定是用户私有数据。⚠️ 实测里 CASCADE 只在**硬删** `users` 行时
 *     触发（软删在 `actors.deleted_at`），这正是本套件用硬删验证的原因。
 *   - **`enabled` 默认 false**：出境功能唯一可接受缺省。有默认值 `true` 会让"忘了写"变成"默认开"。
 *   - **`source` / `last_test_status` 无 CHECK**（值域由应用层单源常量守卫，本套件不重复断言约束）。
 *
 * [关联代码]
 *   - src/database/migrations/1792200000000-AddNotificationChannels.ts — 核对对象
 *   - src/database/entities/user-notification-channel.entity.ts — 实体侧列契约
 *   - test/notifications-schema.e2e-spec.ts — 同族套件（一期单表）
 *   - test/migration-drift.e2e-spec.ts — 门禁（本套件补它的谓词/FK 行为盲区）
 *
 * [持久踩坑]
 *   NOTIFY-CHANNEL-SCHEMA-SHARED-DB(共享库卫生): 打共享开发库，写入的数据带 RUN 后缀，
 *     afterAll 按 id / email 精确硬删（删 users 行会经 CASCADE 连带清理渠道行）。
 *
 * [铁律关联] #11(注释强制) #18(不变量检查) #20(契约即设计)
 * =============================================================================
 */
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { ActorType, AgentStatus, UserRole } from '@agent-chamber/shared';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { UserNotificationChannel } from '../src/database/entities/user-notification-channel.entity';
import { NotificationDelivery } from '../src/database/entities/notification-delivery.entity';

/** 本地开发库连接（既有真 PG e2e 惯例；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀（隔离本套件写入的数据） */
const RUN = `unch-${Date.now().toString(36)}`;

/** 实体目录（barrel↔glob 一致性的比对基准目录） */
const ENTITIES_DIR = path.join(__dirname, '..', 'src', 'database', 'entities');

/**
 * 实体列类型 → `information_schema.columns.data_type` 的映射（只列本表用到的 5 种；
 * 映射写死是刻意的：实体换了类型而这里没同步 ⇒ 断言红，好过静默通过）。
 */
const ENTITY_TYPE_TO_INFO_SCHEMA: Record<string, string> = {
  uuid: 'uuid',
  varchar: 'character varying',
  text: 'text',
  boolean: 'boolean',
  int: 'integer',
  timestamptz: 'timestamp with time zone',
};

/** 本套件对齐的两张表 ↔ 实体类 */
const TABLE_SPECS: { table: string; entity: EntityTarget<ObjectLiteral> }[] = [
  { table: 'user_notification_channels', entity: UserNotificationChannel },
  { table: 'notification_deliveries', entity: NotificationDelivery },
];

/** information_schema 列行投影 */
interface InfoSchemaColumn {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  character_maximum_length: number | null;
  column_default: string | null;
}

describe('Notifications 二期数据层 — 实体 ↔ 迁移链 schema（真实 PG）', () => {
  let ds: DataSource;
  let dbAvailable = false;

  /** 本套件播种的用户（afterAll 硬删；删它即经 CASCADE 清理渠道行） */
  let userId: string;
  let actorId: string;

  jest.setTimeout(60_000);

  const infoSchemaColumns = async (table: string): Promise<InfoSchemaColumn[]> =>
    (await ds.query(
      `SELECT column_name, data_type, is_nullable, character_maximum_length, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY column_name`,
      [table],
    )) as InfoSchemaColumn[];

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
        `[user-notification-channels-schema e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // FK 目标：真实 users 行（users.id → actors.id）
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `${RUN} owner`,
        status: AgentStatus.ACTIVE,
      }),
    );
    actorId = actor.id;
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actor.id,
        username: `${RUN}`.slice(0, 50),
        email: `${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    userId = user.id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // 投递行无 FK（按 recipient 精确删）；渠道行随 users 行 CASCADE 删除
    await ds.query(`DELETE FROM notification_deliveries WHERE recipient LIKE $1`, [`ou_${RUN}%`]);
    if (userId) await ds.query(`DELETE FROM users WHERE id = $1`, [userId]);
    if (actorId) await ds.query(`DELETE FROM actors WHERE id = $1`, [actorId]);
    await ds.destroy();
  });

  // ══════════════════════════════════════════════════════════════════
  // ① 表在场 + 逐列对齐
  // ══════════════════════════════════════════════════════════════════

  it('① 两张表在场，且每列与实体声明逐列对齐（名称/可空/类型/列宽）', async () => {
    if (!dbAvailable) return;

    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN
          ('user_notification_channels', 'notification_deliveries')`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      'notification_deliveries',
      'user_notification_channels',
    ]);

    for (const spec of TABLE_SPECS) {
      const actual = await infoSchemaColumns(spec.table);
      const metadata = ds.getMetadata(spec.entity);

      const expectedNames = metadata.columns.map((c) => c.databaseName).sort();
      expect(actual.map((c) => c.column_name)).toEqual(expectedNames);

      const actualByName = new Map(actual.map((c) => [c.column_name, c]));
      for (const column of metadata.columns) {
        const dbColumn = actualByName.get(column.databaseName);
        expect(dbColumn).toBeDefined();
        if (!dbColumn) continue;

        expect({ column: column.databaseName, nullable: dbColumn.is_nullable }).toEqual({
          column: column.databaseName,
          nullable: column.isNullable ? 'YES' : 'NO',
        });

        expect({
          column: column.databaseName,
          type: dbColumn.data_type,
        }).toEqual({
          column: column.databaseName,
          type: ENTITY_TYPE_TO_INFO_SCHEMA[column.type as string],
        });

        expect({
          column: column.databaseName,
          length: dbColumn.character_maximum_length,
        }).toEqual({
          column: column.databaseName,
          length:
            column.length === undefined || column.length === null || column.length === ''
              ? null
              : Number(column.length),
        });
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ② 列宽契约
  // ══════════════════════════════════════════════════════════════════

  it('② 列宽与 plan §D2 逐条一致', async () => {
    if (!dbAvailable) return;

    const columns = await infoSchemaColumns('user_notification_channels');
    const widthOf = (name: string): number | null =>
      columns.find((c) => c.column_name === name)?.character_maximum_length ?? null;

    expect({
      provider: widthOf('provider'),
      recipient_address: widthOf('recipient_address'),
      last_test_status: widthOf('last_test_status'),
      last_test_address: widthOf('last_test_address'),
      source: widthOf('source'),
    }).toEqual({
      provider: 30,
      recipient_address: 255,
      last_test_status: 20,
      last_test_address: 255,
      source: 20,
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ③ PK 默认值 + 列级默认值
  // ══════════════════════════════════════════════════════════════════

  it('③ PK 为 uuid 且 DEFAULT gen_random_uuid()', async () => {
    if (!dbAvailable) return;

    const idColumn = (await infoSchemaColumns('user_notification_channels')).find(
      (c) => c.column_name === 'id',
    );
    expect(idColumn?.data_type).toBe('uuid');
    expect(idColumn?.column_default).toBe('gen_random_uuid()');
  });

  it('④ 列级默认值：enabled=false / source=user / created_at=now() / updated_at=now()；其余无默认', async () => {
    if (!dbAvailable) return;

    const columns = await infoSchemaColumns('user_notification_channels');
    const defaultOf = (name: string): string | null =>
      columns.find((c) => c.column_name === name)?.column_default ?? null;

    // 必须有默认值
    expect(defaultOf('enabled')).toBe('false');
    expect(defaultOf('source')).toBe("'user'::character varying");
    expect(defaultOf('created_at')).toBe('now()');
    expect(defaultOf('updated_at')).toBe('now()');

    // 必须**无**默认值（有默认值会把"忘了写"伪装成"已写好"）
    for (const column of [
      'user_id',
      'provider',
      'recipient_address',
      'last_test_at',
      'last_test_status',
      'last_test_address',
      'unbound_at',
    ]) {
      expect({ column, default: defaultOf(column) }).toEqual({ column, default: null });
    }

    // 本表刻意无 deleted_at（解绑语义由 unbound_at 承担，两个"不活跃"信号会互相矛盾）
    expect(columns.map((c) => c.column_name)).not.toContain('deleted_at');
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑤ 索引：两条唯一、其一为部分唯一（谓词逐字断言）+ FK
  // ══════════════════════════════════════════════════════════════════

  it('⑤ 索引：user_provider 无谓词唯一；verified_address 部分唯一（谓词逐字）', async () => {
    if (!dbAvailable) return;

    const indexes = await tableIndexDefs('user_notification_channels');
    const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));

    const pairDef = byName.get('uq_user_notification_channels_user_provider');
    expect(pairDef).toBeDefined();
    expect(pairDef).toMatch(/CREATE UNIQUE INDEX uq_user_notification_channels_user_provider/);
    expect(pairDef).toMatch(/\(user_id, provider\)/);
    expect(pairDef).not.toMatch(/WHERE/);

    const addressDef = byName.get('uq_user_notification_channels_verified_address');
    expect(addressDef).toBeDefined();
    expect(addressDef).toMatch(
      /CREATE UNIQUE INDEX uq_user_notification_channels_verified_address/,
    );
    expect(addressDef).toMatch(/\(provider, recipient_address\)/);
    // ⚠️ 谓词是门禁盲区（见文件头不变量）——只断言"有 WHERE"是不够的，必须逐段确认
    expect(addressDef).toMatch(/WHERE/);
    expect(addressDef).toMatch(/unbound_at IS NULL/);
    expect(addressDef).toMatch(/last_test_status/);
    expect(addressDef).toMatch(/'ok'/);

    // 业务索引恰好这两条（防"顺手补索引"落漂移噪声）
    const extras = indexes.filter(
      (i) =>
        i.indexname !== 'uq_user_notification_channels_user_provider' &&
        i.indexname !== 'uq_user_notification_channels_verified_address' &&
        i.indexname !== 'user_notification_channels_pkey',
    );
    expect(extras.map((i) => i.indexname)).toEqual([]);
  });

  it('⑤ FK：约束名逐字同名 + ON DELETE CASCADE（confdeltype=c）', async () => {
    if (!dbAvailable) return;

    const rows = (await ds.query(
      `SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = 'user_notification_channels'::regclass AND contype = 'f'`,
    )) as { conname: string; confdeltype: string }[];
    expect(rows.map((r) => r.conname)).toEqual(['user_notification_channels_user_id_fkey']);
    // 'c' = CASCADE（渠道绑定是用户私有数据，随用户消失）
    expect(rows[0].confdeltype).toBe('c');
  });

  it('⑤ notification_deliveries：recipient_user_id 列与同名索引在场（存量行可空）', async () => {
    if (!dbAvailable) return;

    const column = (await infoSchemaColumns('notification_deliveries')).find(
      (c) => c.column_name === 'recipient_user_id',
    );
    expect(column?.data_type).toBe('uuid');
    expect(column?.is_nullable).toBe('YES');
    expect(column?.column_default).toBeNull();

    const indexDef = (await tableIndexDefs('notification_deliveries')).find(
      (i) => i.indexname === 'idx_notification_deliveries_recipient_user',
    );
    expect(indexDef?.indexdef).toMatch(/CREATE INDEX idx_notification_deliveries_recipient_user/);
    expect(indexDef?.indexdef).toMatch(/\(recipient_user_id\)/);
    // 部分索引会让"未归属的行也能按用户查"这件事变得不可预期 ⇒ 必须无谓词
    expect(indexDef?.indexdef).not.toMatch(/WHERE/);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑥ 行为面：部分唯一的三条语义 + FK CASCADE
  // ══════════════════════════════════════════════════════════════════

  it('⑥ 部分唯一：只有 ok 且未解绑的行占地址槽（seeded / NULL / tombstone 都不占）', async () => {
    if (!dbAvailable) return;

    const address = `ou_${RUN}_slot`;

    // 第二个用户：同 (user_id, provider) 唯一 ⇒ 同一个用户无法插两行同 provider 的行，
    // 要验证"地址槽被谁占用"必须换一个 user_id
    const actorB = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `${RUN} slot-b`,
        status: AgentStatus.ACTIVE,
      }),
    );
    const userB = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actorB.id,
        username: `${RUN}slotb`.slice(0, 50),
        email: `${RUN}-slot-b@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );

    const insertFor = (ownerId: string, status: string | null) =>
      ds.query(
        `INSERT INTO user_notification_channels
           (user_id, provider, recipient_address, last_test_status)
         VALUES ($1, 'feishu', $2, $3) RETURNING id`,
        [ownerId, address, status],
      ) as Promise<{ id: string }[]>;

    try {
      // ① `seeded`/NULL **不占槽**：A 行 seeded、B 行未验证，同一地址两行都能在（播种行不冒充已验证，
      //    未验证的 claim 不占槽 ⇒ 防地址预占 griefing）
      const aRow = await insertFor(userId, 'seeded');
      const bSeeded = await insertFor(userB.id, null);
      expect(aRow[0].id).toBeTruthy();
      expect(bSeeded[0].id).toBeTruthy();

      // ② **只有 ok 才占槽**：A 推进到 ok 后，B 也想把同一地址标成 ok ⇒ 必须撞 23505
      //    （部分唯一的谓词只覆盖 ok 行——"占用地址"本身就是归属证明：
      //     一个飞书账号只能被一个平台账户验证）
      await ds.query(
        `UPDATE user_notification_channels SET last_test_status = 'ok' WHERE id = $1`,
        [aRow[0].id],
      );
      await ds.query(`DELETE FROM user_notification_channels WHERE id = $1`, [bSeeded[0].id]);
      await insertFor(userB.id, 'ok').then(
        () => {
          throw new Error('expected a unique violation (the address slot is occupied)');
        },
        (err: { code?: string }) => {
          expect(err.code).toBe('23505');
        },
      );

      // ③ tombstone **释放槽**：A 解绑后 B 能把同一地址标成 ok（地址可回收重绑）
      await ds.query(
        `UPDATE user_notification_channels SET unbound_at = now(), enabled = FALSE WHERE id = $1`,
        [aRow[0].id],
      );
      const bAfter = await insertFor(userB.id, 'ok');
      expect(bAfter[0].id).toBeTruthy();
    } finally {
      await ds.query(`DELETE FROM user_notification_channels WHERE recipient_address LIKE $1`, [
        `ou_${RUN}%`,
      ]);
      await ds.query(`DELETE FROM users WHERE id = $1`, [userB.id]);
      await ds.query(`DELETE FROM actors WHERE id = $1`, [actorB.id]);
    }
  });

  it('⑥ FK CASCADE：硬删 users 行 ⇒ 渠道行连带删除（软删不走这条，本套件验硬删）', async () => {
    if (!dbAvailable) return;

    // 新建一个临时用户专供本用例（避免删掉套件共用的那个）
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `${RUN} cascade`,
        status: AgentStatus.ACTIVE,
      }),
    );
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actor.id,
        username: `${RUN}c`.slice(0, 50),
        email: `${RUN}-cascade@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    await ds.query(
      `INSERT INTO user_notification_channels (user_id, provider, recipient_address)
       VALUES ($1, 'feishu', $2)`,
      [user.id, `ou_${RUN}_cascade`],
    );

    await ds.query(`DELETE FROM users WHERE id = $1`, [user.id]);
    const left = (await ds.query(`SELECT id FROM user_notification_channels WHERE user_id = $1`, [
      user.id,
    ])) as { id: string }[];
    expect(left).toEqual([]);
    await ds.query(`DELETE FROM actors WHERE id = $1`, [actor.id]);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑦ barrel ↔ glob 一致（新增实体忘登记 barrel 会被抓）
  // ══════════════════════════════════════════════════════════════════

  it('⑦ entities/index.ts 导出集合与实体文件 glob 完全一致（含 UserNotificationChannel）', async () => {
    if (!dbAvailable) return;

    const globFiles = fs
      .readdirSync(ENTITIES_DIR)
      .filter((file) => file.endsWith('.entity.ts'))
      .sort();

    const barrelSource = fs.readFileSync(path.join(ENTITIES_DIR, 'index.ts'), 'utf8');
    const barrelEntries = [
      ...barrelSource.matchAll(/export \{ (\w+) \} from '\.\/([\w.-]+)';/g),
    ].map((match) => ({ name: match[1], file: match[2] }));

    expect(barrelEntries.map((entry) => `${entry.file}.ts`).sort()).toEqual(globFiles);

    const runtimeClassNames = new Set<string>();
    for (const file of globFiles) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const moduleExports = require(path.join(ENTITIES_DIR, file)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(moduleExports)) {
        if (typeof value === 'function') runtimeClassNames.add(name);
      }
    }
    expect([...runtimeClassNames].sort()).toEqual(barrelEntries.map((e) => e.name).sort());

    expect(barrelEntries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['UserNotificationChannel']),
    );
  });
});
