import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `events.cursor` → **DB 序列 `seq_events_cursor`**（事件游标单调性修复，卡 dc8c7d1e）
 *
 * 病灶：`cursor` 长期由应用层造值（`Date.now()*1000 + rand(0..999)`），**同一毫秒内的并发
 * 插入其先后序 ≠ cursor 序** ⇒ 消费方 `cursor > last` 的轮询会**永久跳过**落在后面的那条
 * 事件（数据丢失级，不是漏一次）。本迁移把取值权交回数据库：单条 `nextval` 天然单调、
 * 且与插入的提交顺序一致（同一序列上的 nextval 严格递增）。
 * ⚠️ **严格口径订正（2026-10-12 实测）**：`nextval` 的**分配序**确实严格递增（并发 21 条
 * 实测：取值连续、无空洞、两两不同），但它与**提交序**在并发下不必然一致——两笔并发单语句
 * 插入可能「先取号者后提交」，消费者若恰在两者提交之间轮询，会带着较大的 watermark 跳过
 * 较小号那条。窗口 = 单语句隐式事务的宽度（本仓 25 个事件写入点全在业务事务之外，故不是
 * 「先取号后长事务」的长窗口），**与旧病根（同毫秒 + 随机后缀 ⇒ 结构性乱序）不同量级**。
 * 彻底消除需消费侧去重或写入与业务写同事务化，均属本卡「明确不做」——在此登记为残余风险，
 * 勿据此认为「取号即安全」，也勿因此推翻本迁移（新语义仍是严格改进）。
 *
 * ── 头注五条（改本文件前逐条读完；前四条是纪律，第五条是语义契约） ──────────────
 *
 * 1. **序列名禁令**：不得改名为 `events_cursor_seq`。① 它是 TypeORM 的 **serial 启发式
 *    约定名**（`${table}_${column}_seq`，见 `PostgresQueryRunner.js` 的列加载：把
 *    `column_default` 与该约定名拼出的 `nextval('events_cursor_seq'::regclass)` 做**字符串**
 *    比对，命中即置 `isGenerated=increment`）——撞名会让列被误判成 serial，漂移门禁随即
 *    产出 `ALTER COLUMN ... DROP DEFAULT` + `DROP SEQUENCE`（并把列类型往 integer 系拉）；
 *    ② 它更是本列的**历史隐式名**：`InitialMigration` 里该列是 `cursor BIGSERIAL`，PG 为其
 *    自动建的同名序列正是 `events_cursor_seq`（`1781364902335-ActorUnification.ts` up()
 *    显式 `DROP SEQUENCE "events_cursor_seq"` 正是当年把它降级为普通 bigint 的动作，
 *    down() 又原样建回）——重用这个名字 = **原样复活 serial 语义**，与「游标与墙钟解耦、
 *    由应用显式管理起点」的设计正面冲突。
 *    注（**刻意不使用 `OWNED BY`**，2026-10-12 实测订正）：本序列建表时不挂依赖。
 *    PG 的 `CREATE SEQUENCE ... OWNED BY <table>.<column>` 要求**序列与目标表同 owner**
 *    （文档级语义约束，**超级用户也不豁免**）：dev 库 `events` 表 owner = `chamber`，而
 *    迁移/应用角色 = `swarm`（两者都是 superuser），实测以 `swarm` 执行首句直接报
 *    `sequence must have same owner as table it is linked to`——经 `typeorm-options.ts:80`
 *    的 `migrationsRun:true` 表现为**后端启动失败**（DataSource.initialize 重试 9 次后退出，
 *    服务起不来；dev 实测日志见下）。角色拓扑：dev 表 owner=`chamber` / 迁移角色=`swarm`
 *    （**异构，故必须去掉**）；prod 表 owner=`agent_chamber` = 迁移角色（本就同 owner，
 *    去掉后同样成立）。去掉依赖的代价只有两点，均可接受：① `pg_get_serial_sequence(
 *    'events','cursor')` 返回 NULL（**预期**，且本仓无任何调用方）；② `DROP TABLE events`
 *    不再级联删序列（本表无此场景，`down()` 已显式 DROP SEQUENCE）。
 *    ⚠️ **该约束与命名无关**：不得因「反正不挂依赖了」把序列改名为 `events_cursor_seq`
 *    ——上面那条 **serial 字符串约定**（TypeORM 的判据）依然完全生效。
 *
 * 2. **回滚配对与方向**：升级方向 = `migration → code`（先建序列，此时**旧代码**仍显式传
 *    `cursor`，与无 default 期完全兼容）；回滚方向 = `code → migration`（先回退代码，因为
 *    旧代码自带 cursor、不依赖 default）。**反序必炸**：`down()` 之后新代码（不传 cursor）
 *    的每条写路径事件插入都会触发 `23502` NOT NULL 违约（`cursor` 列无 default 且 NOT NULL）
 *    ——只回滚 migration 会让全部事件写入失败，故 `down()` 的前置条件是**代码已回退**。
 *
 * 3. **部署纪律（绝对）**：本迁移**只能在写方停写期间**执行（`deploy.sh` 的
 *    停服 → `migration:run` → 起服 链，窗口 W≈0）。**禁止**在旧代码在线时手工
 *    `migration:run`：窗口期内旧代码持续写入墙钟值（可能高于新序列起点），期间轮询过的
 *    消费方会永久丢掉其后全部事件（本卡病症复刻）。下面的 GREATEST 起点**只保护迁移时刻
 *    之前的存量 watermark，不豁免本条纪律**。
 *
 * 4. **为什么不用 `IF NOT EXISTS`**：迁移链里该序列本不存在，存在即异常，应当 fail-loud；
 *    更硬的理由是 `setval` 可以把序列计数器**回拨**（实测）：若未来出现多实例并发
 *    `migrationsRun`，`IF NOT EXISTS` + 无条件 setval 会让后启动的实例按当时的
 *    `MAX(cursor)` 回拨计数器 ⇒ 后续 `nextval` 产出**重复 cursor**（= 本卡病根换了个触发
 *    路径）。裸 `CREATE SEQUENCE` 撞名即报错，是最便宜的护栏。同理 `down()` 的
 *    `DROP SEQUENCE` 允许 `IF EXISTS`（回滚要幂等，且它不会造成重复游标）。
 *
 * 5. **游标与墙钟刻意解耦**：序列起点 ≈ 迁移时刻的墙钟微秒，之后**每个事件 +1**，与真实
 *    时间迅速脱钩。**禁止**用 `Date.now()` 或任何「现在是几点」的假设去校验 / 比较 /
 *    兜底 `cursor` 值（旧代码的两条墙钟造值路径已随本卡删除；`'now'` 别名的新语义 =
 *    回库取当前全局 MAX，见 `event.service.ts`）。线上 `docs/database.md` 同款注记。
 *    残余风险（刻意记录）：滚动 / 蓝绿部署下会有**两代代码同时在线**，新一代从序列取值、
 *    老一代仍发墙钟值 ⇒ 老实例的 watermark 可能高于序列值并让 poll 侧静默跳过新事件。
 *    **滚动部署前必须先落地** poll 侧的 `min(cursor, MAX)` 夹取或等价机制（本仓当前只有
 *    停服链，故不实施；登记为滚动部署的前置候选）。
 *
 * 起点规则：`GREATEST(MAX(cursor)+1, now_µs+1)`——`MAX+1` 让已经持久化过「旧代码发出的
 * 墙钟 watermark」的消费方不会永久静默（实测旧值可高出存量 MAX 约 70 亿 µs）；`now_µs+1`
 * 兜住空表与「存量值落后于墙钟」两种情形。GREATEST 跳过的区间按 MAX 定义不含任何事件行、
 * 且 ≥ 一切历史墙钟 watermark ⇒ 两类 watermark 全无损。
 *
 * 漂移预测：**零新增项**——序列本身是 TypeORM 元数据表达不了、也不参与 diff 的裸 SQL 产物
 * （去掉 `OWNED BY` 后亦然：`pg_depend` 依赖关系不在 `createSchemaBuilder().log()` 的比对面内），
 * 而列 default 的裸形态（`nextval('seq_events_cursor')`，无 `::regclass`）与实体
 * `event.entity.ts` 的 `default: () => "nextval('seq_events_cursor')"` 在 TypeORM
 * 剥掉 DB 侧 cast 后**逐字相等** ⇒ `defaultEqual` 判等。若门禁多出任何 `events` 条目
 * （尤其含 `DROP SEQUENCE` / `SET DEFAULT`），先查序列名是否撞了 serial 约定名、
 * 以及实体 default 是否少了 / 多了 cast ——**不要去改基线**。
 *
 * 形态：`SET LOCAL lock_timeout = '5s'`（先例 `1791900000000-MemoryRecallQueryTextRetention.ts`，
 * 长事务占表锁时放弃而非无限排队）+ 三条 DDL/DML（统一**裸名**写法 `'seq_events_cursor'`，
 * 与 TypeORM 生成的 `nextval('...')` 形态一致）。
 */
export class CreateEventsCursorSequence1792000000000 implements MigrationInterface {
  name = 'CreateEventsCursorSequence1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    // 裸 CREATE（无 IF NOT EXISTS，理由见头注 4）；序列名见头注 1 的禁令；
    // **不带 OWNED BY**（理由见头注 1 的注：PG 要求序列与表同 owner，超级用户不免）
    await queryRunner.query(`CREATE SEQUENCE "seq_events_cursor" AS BIGINT`);
    // setval(..., false) ⇒ 下一次 nextval 恰为给定值（PG 实测；true 则从下一值开始）
    await queryRunner.query(
      `SELECT setval('seq_events_cursor', GREATEST(COALESCE((SELECT MAX("cursor") FROM "events"),0)+1, floor(extract(epoch from clock_timestamp())*1000000)::bigint+1), false)`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" ALTER COLUMN "cursor" SET DEFAULT nextval('seq_events_cursor')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 顺序实测：先摘 default 再删序列（反序时列 default 仍引用该序列，DROP SEQUENCE 报依赖错）
    await queryRunner.query(`ALTER TABLE "events" ALTER COLUMN "cursor" DROP DEFAULT`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "seq_events_cursor"`);
  }
}
