/**
 * =============================================================================
 * 钉子用例（批次 0 第 6 项 · 改名法入库）—— cjk_unigram_text 函数黄金值
 * =============================================================================
 * 机制：`*.pending.ts` 不被任何 jest 套件发现（单测 rootDir=src；e2e testRegex
 * =`.e2e-spec.ts$`）。**批次 1 激活 = 迁移落地后原地改名 `*.e2e-spec.ts`**（e2e
 * jest 递归发现 test/ 全树，import 相对路径无需变动）。
 *
 * 每条按四列书写：查询 / fixture / 断言的不变量 / 失败含义。
 * 黄金值纪律（计划 §6，database 第三轮）：**字面量手写进测试源码，禁止由实现输出
 * 反推**——反推式断言在函数体写错时空转通过。
 *
 * 前置：本套件激活时，批次 1 migration 已在临时库链上（`runMigrations()` 建函数 +
 * 换 4 触发器），故 `cjk_unigram_text()` 在场。
 * =============================================================================
 */
import {
  createMigrationChainTempDb,
  destroyMigrationChainTempDb,
  type TempDbHandle,
} from './_temp-db';

describe('cjk_unigram_text 黄金值（计划 §6 验收锚点）', () => {
  let handle: TempDbHandle;
  jest.setTimeout(300_000);

  beforeAll(async () => {
    handle = await createMigrationChainTempDb('cjk_golden');
  });

  afterAll(async () => {
    await destroyMigrationChainTempDb(handle);
  });

  /**
   * ① CJK 黄金值（逐字钉死）
   * - 查询: 无（纯函数调用 `cjk_unigram_text('出境')`）
   * - fixture: 迁移链临时库（函数在场即可，无数据）
   * - 断言的不变量: 输出逐字 = `' 出  境 '`（6 字符：首尾空格 + 字间**双空格**）；
   *   `to_tsvector('simple', 输出)` 产 **2 个 lexeme**（`出`:1 `境`:2）
   * - 失败含义: 两侧分隔形态被破坏（单侧分隔 `'出 '` 会把 `token续期` 回归为
   *   `token续`——计划 §2.1 已验修形态）⇒ 向量与查询双侧错位，批次 1 验收红线
   */
  it('① cjk_unigram_text(出境) = " 出  境 "（首尾空格 + 字间双空格）且 2 lexeme', async () => {
    if (!handle.available) return;
    const rows = (await handle.db?.query(
      `SELECT cjk_unigram_text('出境') AS normalized`,
    )) as { normalized: string }[];
    // 黄金字面量手写（禁止反推）：空格 出 空格 空格 境 空格
    expect(rows[0].normalized).toBe(' 出  境 ');
    expect(rows[0].normalized).toHaveLength(6);
    const lexemes = (await handle.db?.query(
      `SELECT lexeme FROM unnest(to_tsvector('simple', cjk_unigram_text('出境'))) AS t(lexeme) ORDER BY lexeme`,
    )) as { lexeme: string }[];
    expect(lexemes.map((r) => r.lexeme)).toEqual(['出', '境']);
  });

  /**
   * ② ASCII 黄金值（translate 记号陷阱专防，architect 第五轮 NEW-3）
   * - 查询: 无（纯函数调用）
   * - fixture: 迁移链临时库
   * - 断言的不变量: `cjk_unigram_text('v1.85.0 X-API-Key')` = **原样返回**；
   *   `cjk_unigram_text('A1B')` = `'A1B'`（剥离族 = 恰好 6 个码点且不含 ASCII）
   * - 失败含义: 函数体把散文记号 `U+200B–200D` 写进 translate ⇒ `–`/`U`/`+`/字母
   *   数字全成删除集（实测 translate('A1B',…)= 'A1'），ASCII 标识符静默毁数据
   */
  it('② cjk_unigram_text(v1.85.0 X-API-Key) 原样返回；A1B 不被吞（translate 陷阱专防）', async () => {
    if (!handle.available) return;
    const rows = (await handle.db?.query(
      `SELECT cjk_unigram_text('v1.85.0 X-API-Key') AS ascii_golden, cjk_unigram_text('A1B') AS a1b`,
    )) as { ascii_golden: string; a1b: string }[];
    expect(rows[0].ascii_golden).toBe('v1.85.0 X-API-Key');
    expect(rows[0].a1b).toBe('A1B');
  });

  /**
   * ③ NULL 黄金值（COALESCE 内建）
   * - 查询: 无（纯函数调用 `cjk_unigram_text(NULL)`）
   * - fixture: 迁移链临时库
   * - 断言的不变量: NULL 入 `''` 出（COALESCE 内建；黄金值/回填表达式/down() 直传
   *   NULL 时语义确定）
   * - 失败含义: NULL 传播进触发器 ⇒ 行向量整体变 NULL，该节永不可检索且无报错
   */
  it('③ cjk_unigram_text(NULL) = 空串', async () => {
    if (!handle.available) return;
    const rows = (await handle.db?.query(
      `SELECT cjk_unigram_text(NULL) AS normalized`,
    )) as { normalized: string }[];
    expect(rows[0].normalized).toBe('');
  });

  /**
   * ④ 零宽/变体族归一（R-3 双侧同表剥离）
   * - 查询: 无（纯函数调用；后续端到端用例见 script-boundaries.pending.ts）
   * - fixture: 迁移链临时库
   * - 断言的不变量: `cjk_unigram_text('1️⃣')` 的 lexeme 含裸 `'1'`（剥离后从
   *   不命中变命中，普查 §10.3 实测方向 = 增益）；剥离族恰好 6 字面字符
   * - 失败含义: 剥离表写错（少写/区间散文记号）⇒ `1️⃣` 类查询与文档 token 两种
   *   形态不对称，裸查询 `1` 不命中
   */
  it('④ cjk_unigram_text(1️⃣) 归一后产裸 1 lexeme', async () => {
    if (!handle.available) return;
    const rows = (await handle.db?.query(
      `SELECT lexeme FROM unnest(to_tsvector('simple', cjk_unigram_text('1️⃣'))) AS t(lexeme)`,
    )) as { lexeme: string }[];
    expect(rows.map((r) => r.lexeme)).toContain('1');
  });

  /**
   * ⑤ IMMUTABLE 属性 + 4 触发器接线
   * - 查询: 无（元数据断言）
   * - fixture: 迁移链临时库（全链迁移后）
   * - 断言的不变量: 函数 `proisstrict`/volatile 标记 = **IMMUTABLE**（索引与生成列
   *   可用性前提）；4 张检索表（doc_sections/messages/tasks/experience_entries）
   *   的 search_vector 触发器函数体含 `cjk_unigram_text(`
   * - 失败含义: 漏 IMMUTABLE ⇒ 表达式索引/查询计划不可用；漏触发器 ⇒ 该表向量
   *   永远停在旧算法，迁移自校验应该拦下的东西漏网
   */
  it('⑤ 函数 IMMUTABLE + 4 触发器函数体含 cjk_unigram_text(', async () => {
    if (!handle.available) return;
    const volatility = (await handle.db?.query(
      `SELECT p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname = 'cjk_unigram_text'`,
    )) as { provolatile: string }[];
    expect(volatility.map((r) => r.provolatile)).toEqual(['i']); // i = IMMUTABLE
    const triggers = (await handle.db?.query(
      `SELECT tg.tgrelid::regclass::text AS table_name, p.prosrc
       FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE NOT tg.tgisinternal AND p.prosrc LIKE '%search_vector%'`,
    )) as { table_name: string; prosrc: string }[];
    const covered = new Set(
      triggers.filter((t) => t.prosrc.includes('cjk_unigram_text(')).map((t) => t.table_name),
    );
    for (const table of ['doc_sections', 'messages', 'tasks', 'experience_entries']) {
      expect(covered.has(table)).toBe(true);
    }
  });
});
