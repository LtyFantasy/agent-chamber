/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 事件游标 `events.cursor` = **DB 序列 `seq_events_cursor` 发的不透明单调序列号**
 *     （卡 dc8c7d1e / B-52）的端到端契约：`create` 不传 cursor 时由 DB default 取值并经
 *     INSERT ... RETURNING 回填；`poll` 的 `'now'` = 回库取**当前全局 MAX(cursor)**；
 *     空结果兜底同源（不再造墙钟值）；非法 cursor 400。
 *
 * [代码职责]
 *   - 钉住**同毫秒并发不丢事件**（本卡病根）：20 条并发 create → cursor 全 distinct，
 *     且从断点轮询回来的这批事件**严格升序**（旧实现 `Date.now()*1000+rand` 下会乱序，
 *     消费方 `cursor > last` 永久跳过落后者）。
 *   - 钉住 `'now'` 的新语义（全局位点，不按权限收敛）与「用 nextCursor 续拉必得新事件」。
 *   - 钉住守卫（400）与 `''` 的缺省化。
 *   - 钉住**迁移形态**本身：`events.cursor` 的 default = `nextval('seq_events_cursor')`、序列存在
 *     且 `setval` 已生效（序列名撞 TypeORM serial 启发式约定名会让漂移门禁产出 DROP SEQUENCE，
 *     故用真库读回 information_schema / `to_regclass` / `last_value` 复核）。
 *     ⚠️ **刻意不钉 `OWNED BY`**：PG 要求 OWNED BY 的序列与表同 owner（超级用户不免），
 *     本仓 dev 库 owner 异构（表=chamber / 迁移角色=swarm）会让该子句直接打死后端启动
 *     —— 故迁移已去掉它，本套件随之不再断言 `pg_depend`（详见 migration 头注 ①）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/database.md（events 表 + seq_events_cursor 起点规则与禁名注记）、
 *     线上 docs/api-definition.md §8.1（poll 的 cursor 语义与 nextCursor 契约）
 *   - 补充: `src/database/migrations/1792000000000-CreateEventsCursorSequence.ts` 头注
 *     （五条纪律：禁名 / 回滚方向 / 停写期部署 / 去 IF NOT EXISTS / 墙钟解耦）
 *
 * [持久踩坑]
 *   EVT-CUR-E2E-BOOTSTRAP(本套件自举序列，且**只在自建时清理**): 本套件的断言对象是
 *     **DB default 是否生效**，故 dev 库必须先有 `seq_events_cursor`。既有纪律是「迁移由
 *     部署链/主脑执行、测试不改 dev schema」，但那样本套件在迁移落地前恒红。折中：
 *     `beforeAll` 里 `to_regclass('public.seq_events_cursor')` 探测——**缺失时**才调用
 *     **真迁移类**的 `up()`（单一事实源，不手抄 SQL）补建，并记 `selfBootstrapped=true`；
 *     `afterAll` **仅当自建时**执行该迁移的 `down()` 还原（避免给后续 `migration:run` 留下
 *     "relation already exists" 的假故障）。迁移已落地（生产链 / 主脑实测）时本套件走真状态、
 *     不做任何写。
 *     **幂等边界与死路径声明**：探测用 `to_regclass`，序列已存在即**完全跳过**（零写入、
 *     零 DDL、不改 `migrations` 行）——故本分支在 dev 库迁移落地后就是**死路径**，只服务
 *     全新环境自举；`afterAll` 的还原也严格受 `selfBootstrapped` 门控，不会误删已落地的序列。
 *   EVT-CUR-E2E-SHARED-DB(共享开发库 + 并发的 watch 后端): 断点一律**用例内现取**
 *     （`SELECT MAX(cursor)`），且断言只约束「我们自己造的行」——dev 库有并行的其它 e2e 套件
 *     与 watch 后端在写事件，写死的绝对时间/绝对条数必然偶发假红。events 无 FK，残留行无害、
 *     不清理（与 sse / task-hygiene 套件同款处置）。
 *   EVT-CUR-E2E-NOW-ORACLE('now' 的**强** oracle = nextCursor 恰等于请求时刻的 MAX 只在
 *     单测里可确定性断言（mock MAX）；真库里 `SELECT MAX` 与 `poll` 之间存在并发写入窗口，
 *     故此处断「双边界 + 返回项严格大于断点」的**区间契约**——精确等值由
 *     `event.service.spec.ts` 的 `'now' 且无新事件 → nextCursor === MAX` 钉死。
 * =============================================================================
 */

/**
 * 事件游标 = DB 序列（B-52）—— 真实 PG 集成套件。
 *
 * 为什么必须打真库：本卡的全部行为都长在**数据库**上——`nextval` 的唯一性与单调性、实体
 * default 经 RETURNING 回填（TypeORM 元数据层行为）、`'now'` 的 MAX 取值。mock 单测只能
 * 证明「代码调了哪几个方法」，证明不了「并发 20 条真的拿到 20 个不同且升序的 cursor」
 * （铁律 #23 的同款理由）。
 *
 * PG 不可达时整套降级跳过（与其它真 PG 套件一致）。
 */
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { ActorType, ErrorCode, EventType, UserRole } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { Event } from '../src/database/entities/event.entity';
import { EventService } from '../src/modules/event/event.service';
import { SseService } from '../src/modules/sse/sse.service';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { UnifiedActor } from '../src/common/types/actor.types';
// **值导入**：自举路径直接复用真迁移类（单一事实源；手抄一份 SQL 迟早漂移）
import { CreateEventsCursorSequence1792000000000 } from '../src/database/migrations/1792000000000-CreateEventsCursorSequence';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据（落进 payload，便于事后甄别） */
const RUN = `evtcur-${Date.now().toString(36)}`;

/** 探针事件的资源 id（resource_id 是 uuid 列，必须是合法 uuid） */
const PROBE_RESOURCE_ID = '00000000-0000-4000-8000-0000000000e2';

/** admin 身份：poll 的可见性过滤对 admin 短路（本套件只测游标语义，不掺权限维度） */
const ADMIN_ID = '00000000-0000-4000-8000-0000000000ad';
const admin: UnifiedActor = { id: ADMIN_ID, type: ActorType.HUMAN, role: UserRole.ADMIN };

describe('事件游标 = DB 序列（B-52）— 真实 PG 集成', () => {
  let ds: DataSource;
  let service: EventService;
  let dbAvailable = false;
  /** 序列是否由**本套件**补建（决定 afterAll 是否清理，见文件头 EVT-CUR-E2E-BOOTSTRAP） */
  let selfBootstrapped = false;

  /** 当前全局最大游标（`'0'` = 空表）——断点一律现取，不写死 */
  async function maxCursor(): Promise<string> {
    const rows = (await ds.query(`SELECT COALESCE(MAX(cursor),0)::text AS m FROM events`)) as {
      m: string;
    }[];
    return rows[0].m;
  }

  /** 造一条探针事件（走真 DB default：**不传 cursor**） */
  async function createProbe(seq: number): Promise<Event> {
    return service.create({
      eventType: EventType.SYSTEM,
      resourceType: 'e2e_cursor_probe',
      resourceId: PROBE_RESOURCE_ID,
      payload: { run: RUN, seq },
    });
  }

  /** 在事务里跑迁移的一个方向（`up()` 的 `SET LOCAL` 需要事务上下文） */
  async function runMigration(direction: 'up' | 'down'): Promise<void> {
    const migration = new CreateEventsCursorSequence1792000000000();
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await migration[direction](runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[events-cursor e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }

    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('events')`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name)).toEqual(['events']);
    dbAvailable = true;

    // 序列自举（见文件头 EVT-CUR-E2E-BOOTSTRAP）：缺失 ⇒ 跑真迁移；已存在 ⇒ 零写入
    const sequenceRows = (await ds.query(
      `SELECT to_regclass('public.seq_events_cursor') AS name`,
    )) as { name: string | null }[];
    if (!sequenceRows[0]?.name) {
      await runMigration('up');
      selfBootstrapped = true;
    }

    service = new EventService(
      ds.getRepository(Event),
      // SSE 不是本套件的断言目标（载荷形状由 sse.e2e-spec 覆盖）：此处零副作用桩
      { emit: () => undefined } as unknown as SseService,
      // admin 路径不触达 AccessQueryService（role=ADMIN 短路可见性过滤）
      {} as unknown as AccessQueryService,
      new EventEmitter2(),
    );
  }, 120000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // **仅当自建时**还原：给后续 `migration:run` 留一个干净的前置状态
    if (selfBootstrapped) {
      try {
        await runMigration('down');
      } catch (err) {
        console.warn(`[events-cursor e2e] sequence rollback failed: ${(err as Error).message}`);
      }
    }
    await ds.destroy();
  }, 60000);

  // ─── ① 本卡病根：同毫秒并发不再丢事件 ───────────────────────────────
  it('① 并发 20 条 create → cursor 全 distinct，且从断点轮询回来严格升序', async () => {
    if (!dbAvailable) return;
    const before = await maxCursor();

    const saved = await Promise.all(Array.from({ length: 20 }, (_unused, i) => createProbe(i)));
    const ids = saved.map((task) => task.id);

    // ① cursor 由 DB 序列经 RETURNING 回填（数字串），且 20 条两两不同
    for (const event of saved) {
      expect(typeof event.cursor).toBe('string');
      expect(/^\d+$/.test(event.cursor)).toBe(true);
    }
    expect(new Set(saved.map((event) => event.cursor)).size).toBe(20);
    expect(new Set(ids).size).toBe(20);

    // ② 从断点（创建前的 MAX）轮询：这一批必须全在，且**严格升序**
    const res = await service.poll({ cursor: before, limit: 100 }, admin);
    const cursors = res.events.map((event) => BigInt(event.cursor));
    for (let i = 1; i < cursors.length; i += 1) {
      expect(cursors[i] > cursors[i - 1]).toBe(true);
    }
    for (const cursor of cursors) expect(cursor > BigInt(before)).toBe(true);
    expect(res.events.map((event) => event.id)).toEqual(expect.arrayContaining(ids));
    // nextCursor = 本页最后一条的 cursor（消费方直接续拉）
    expect(res.nextCursor).toBe(res.events[res.events.length - 1].cursor);
  });

  // ─── ② 'now' 的新语义 = 当前全局 MAX（不是墙钟） ───────────────────
  it("② cursor='now' 锚定全局 MAX；用 nextCursor 续拉必得其后新造的事件", async () => {
    if (!dbAvailable) return;
    const before = await maxCursor();

    const res = await service.poll({ cursor: 'now' }, admin);

    // 区间契约（精确等值归单测，理由见文件头 EVT-CUR-E2E-NOW-ORACLE）：
    // 位点 ≥ 请求前的 MAX，且返回的每条都严格在其后（旧墙钟语义会在这里超出上界）
    expect(BigInt(res.nextCursor)).toBeGreaterThanOrEqual(BigInt(before));
    for (const event of res.events) expect(BigInt(event.cursor) > BigInt(before)).toBe(true);

    // 新造一条 → 用 nextCursor 续拉必须拿到它（不漏不重的最小闭环）
    const probe = await createProbe(999);
    const res2 = await service.poll({ cursor: res.nextCursor, limit: 100 }, admin);

    expect(res2.events.map((event) => event.id)).toContain(probe.id);
    for (const event of res2.events)
      expect(BigInt(event.cursor) > BigInt(res.nextCursor)).toBe(true);
    expect(res2.nextCursor).toBe(res2.events[res2.events.length - 1].cursor);
  });

  // ─── ③ 入参守卫（铁律 #21：格式错误不进 PG） ────────────────────────
  it("③ 非法 cursor → 400 VALIDATION_ERROR；'' 按缺省处理；无 cursor 的分页照常推进", async () => {
    if (!dbAvailable) return;

    await expect(service.poll({ cursor: 'abc' }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.poll({ cursor: '9'.repeat(30) }, admin)).rejects.toMatchObject({
      response: { code: ErrorCode.VALIDATION_ERROR },
    });
    await expect(
      service.poll({ cursor: ['1', '2'] as unknown as string }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);

    // '' 与「未传」同款（从最早开始）：不报错，nextCursor 恒为字符串
    const blank = await service.poll({ cursor: '', limit: 1 }, admin);
    expect(typeof blank.nextCursor).toBe('string');

    // 无 cursor + 首条：nextCursor 必须推进（消费方据此翻页）
    const first = await service.poll({ limit: 1 }, admin);
    expect(first.events.length).toBeLessThanOrEqual(1);
    expect(typeof first.nextCursor).toBe('string');
    expect(/^\d+$/.test(first.nextCursor)).toBe(true);
  });

  // ─── ④ 迁移形态（序列名 / default / setval 已生效） ──────────────────
  it('④ events.cursor 的 default = nextval(seq_events_cursor)，序列存在且 setval 已生效', async () => {
    if (!dbAvailable) return;

    const columns = (await ds.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='events' AND column_name='cursor'`,
    )) as { column_default: string | null }[];
    // 形态 = nextval('seq_events_cursor'::regclass)；**不是** events_cursor_seq（serial 启发式禁名）
    expect(columns).toHaveLength(1);
    expect(columns[0].column_default).toContain("nextval('seq_events_cursor'");
    expect(columns[0].column_default).not.toContain('events_cursor_seq');

    // 序列本身是**裸 SQL 产物**（TypeORM 元数据表达不了 ⇒ 漂移门禁看不见），只能在此钉住存在性
    const sequences = (await ds.query(
      `SELECT to_regclass('public.seq_events_cursor') AS name`,
    )) as { name: string | null }[];
    expect(sequences[0].name).toBe('seq_events_cursor');

    // setval 已生效 = 计数器不在 CREATE SEQUENCE 的初始 1：起点是
    // GREATEST(MAX(cursor)+1, now_µs+1)（≥1.79e15）且之后只增不减 ⇒ `last_value > 1` 恒成立。
    // ⚠️ 刻意**不**断言 `OWNED BY`（pg_depend deptype='a'）：PG 要求 OWNED BY 的序列与表同
    // owner（超级用户不免），dev 库 owner 异构会直接让后端启动失败 ⇒ 迁移已去掉该子句。
    const seqState = (await ds.query(
      `SELECT last_value::text AS last_value FROM seq_events_cursor`,
    )) as { last_value: string }[];
    expect(BigInt(seqState[0].last_value) > 1n).toBe(true);
  });
});
