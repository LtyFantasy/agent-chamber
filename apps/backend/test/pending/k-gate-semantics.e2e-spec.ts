/**
 * =============================================================================
 * 钉子用例（批次 0 第 6 项 · 改名法入库）—— K-gate 结构门语义（真 PG）
 * =============================================================================
 * 机制：`*.pending.ts` 不被任何 jest 套件发现；**批次 1 激活 = 原地改名
 * `*.e2e-spec.ts`**（migration 落地 + 消费方接线后）。
 *
 * 每条按四列书写：查询 / fixture / 断言的不变量 / 失败含义。
 *
 * K-gate 契约（计划 §2.3）：`(sv @@ to_tsquery('simple', :arm1))::int + … >= :kGateK`——命中
 * **不同** bigram 计数 ≥ K；「重复同一 bigram 只计 1」由编译器解析形态去重保证
 * （表达式本身不保证，实测重复 arm 计 2）；64 cap 同施预过滤与门（architect R1
 * 复核：门集合 ⊊ 预过滤集合 = 静默丢召回）。
 * =============================================================================
 */
import {
  createMigrationChainTempDb,
  destroyMigrationChainTempDb,
  type TempDbHandle,
} from './_temp-db';
import { buildSearchSql } from '../../src/common/utils/search/search-sql';
import { chooseKGateK, compileQuery } from '../../src/common/utils/search/tsquery-compiler';

/** fixture 锚点 id（pending 套件内部固定值，与生产数据无关） */
const SPACE_ID = 'd0d0d0d0-0000-4000-8000-0000000000b1';
const ACTOR_ID = 'd0d0d0d0-0000-4000-8000-0000000000b2';
const DOC_ID = 'd0d0d0d0-0000-4000-8000-0000000000b3';

describe('K-gate 结构门语义（真 PG · 迁移链临时库）', () => {
  let handle: TempDbHandle;
  jest.setTimeout(300_000);

  beforeAll(async () => {
    handle = await createMigrationChainTempDb('kgate');
    if (!handle.available) return;
    // fixture 落地（真表 + 真触发器 ⇒ search_vector 走批次 1 单字化算法）
    await handle.db?.query(
      `INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`,
      [SPACE_ID, 'kgate-pending-fixture', `kgate-${process.pid}`, ACTOR_ID],
    );
    await handle.db?.query(
      `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [DOC_ID, SPACE_ID, 'memory/kgate-fixture.md', 'K-gate fixture', ACTOR_ID],
    );
  });

  afterAll(async () => {
    await destroyMigrationChainTempDb(handle);
  });

  /** 向 fixture doc 追加一节（返回 position） */
  async function addSection(position: number, content: string): Promise<void> {
    await handle.db?.query(
      `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, $2, $3, $4)`,
      [DOC_ID, position, '', content],
    );
  }

  /**
   * ① 重复 bigram 不伪造门禁通过
   * - 查询: `测试测试`（bigram 滑窗 = 测试/试测/测试，去重后 2 distinct arm）
   * - fixture: 一节内容仅含「测试」连写一次（单字化后命中 arm=测试 1 个 distinct）
   * - 断言的不变量: kcount = 1（distinct 口径）⇒ K=2 拒、K=1 过
   * - 失败含义: 编译器去重失效 ⇒ 重复 arm 计 2（database 实测）⇒ K=2 门禁被
   *   同一 bigram 伪造通过，结构门退化（计划 §2.3 B2 混淆变量回归）
   */
  it('① 测试测试：distinct arm 只计 1（K=2 不得被重复 bigram 伪造）', async () => {
    if (!handle.available) return;
    await addSection(1, '这里只有测试一次连写出现');
    // 编译器侧：去重后恰好 2 arm（契约单测已钉；此处证真库口径一致）
    const compiled = compileQuery('测试测试');
    expect(compiled.arms).toHaveLength(2);
    // 真库侧：fixture 节只命中 ('测'<->'试') 1 个 distinct arm（含「只有」「一次」等
    // 其他 bigram 不在查询 arm 集合内）
    const rows = (await handle.db?.query(
      `SELECT
         (s.search_vector @@ to_tsquery('simple', $3))::int + (s.search_vector @@ to_tsquery('simple', $4))::int AS kcount
       FROM doc_sections s WHERE s.doc_id = $1 AND s.position = $2`,
      [DOC_ID, 1, compiled.arms[0], compiled.arms[1]],
    )) as { kcount: number }[];
    expect(rows[0].kcount).toBe(1);
  });

  /**
   * ② 括号查询不产生标点 arm（R-1：K-gate 重复计数泄漏在源头关闭）
   * - 查询: `「闸」`、`【出境】闸`
   * - fixture: 一节含「出境」与「闸」
   * - 断言的不变量: 编译 arms 全部只含 CJK 词字（无「」【】）；`「闸」` 单字查询
   *   产 0 arm（不挂门）；`(「<->闸)` 与 `(闸<->」)` 这类「同解析为 '闸' 的双 arm」
   *   在编译产物中**结构上不存在**
   * - 失败含义: 类清单若回退到整区间 ⇒ 标点 arm 同解析重复计数（census §7.1(b)
   *   实测 `= t`），短查询 K=2 被伪造通过
   */
  it('② 「闸」/【出境】闸：arm 集合无标点，单字括号查询不挂门', async () => {
    if (!handle.available) return;
    const bracketSingle = compileQuery('「闸」');
    expect(bracketSingle.arms).toHaveLength(0); // 单字 ⇒ 无 bigram ⇒ 无门
    expect(bracketSingle.tsquery).toBe(`'闸'`);
    const bracketMixed = compileQuery('【出境】闸');
    expect(bracketMixed.arms).toEqual([`('出'<->'境')`]);
    for (const arm of bracketMixed.arms) {
      expect(arm).toMatch(/^\('[^'「」【】，。]+'<->'[^'「」【】，。]+'\)$/);
    }
  });

  /**
   * ③ 64 cap 同施：门集合 ≡ 预过滤集合（architect R1 复核的回归钉）
   * - 查询: 71 个不同 CJK 字（70 distinct bigram > 64 cap）
   * - fixture: 两节——A 节命中集中在前 64 arm；B 节命中只落在第 65+ 尾部 arm
   * - 断言的不变量: kGateParams 的 arm 集合 ≡ compiled.tsquery 内 arm 集合（前 64，
   *   首现序）；B 节**不过预过滤**（而非「过了预过滤被门踢掉」）
   * - 失败含义: cap 错位 ⇒ 真命中过了预过滤却被门拒 = 静默丢召回（R1 复核实测
   *   71 字查询真命中 kcount 6→1 被 K=2 拒）
   */
  it('③ 71 字查询：kGate arm 集合 ≡ compiledQ arm 集合（截断不造成静默丢召回）', async () => {
    if (!handle.available) return;
    const chars = Array.from({ length: 71 }, (_, i) => String.fromCodePoint(0x4e00 + i * 32)).join('');
    const compiled = compileQuery(chars);
    expect(compiled.arms).toHaveLength(64);
    const group = buildSearchSql({ vector: 's.search_vector', text: 's.content' }, compiled, {
      startSel: '',
      stopSel: '',
    });
    // 门参数集合 ≡ 预过滤 arm 集合（同施的机械验证）
    const gateArms = Object.entries(group?.kGateParams ?? {})
      .filter(([k]) => k !== 'kGateK')
      .map(([, v]) => v);
    expect(gateArms).toEqual(compiled.arms);
    expect(compiled.tsquery?.split(' | ')).toEqual(compiled.arms);
    // 真库行为：尾部命中节不过预过滤（预过滤与门同集合 ⇒ 无「过滤后被门踢掉」窗口）
    await addSection(2, chars.slice(130)); // 第 65+ 字（尾部 arm 区域）
    const prefilterRows = (await handle.db?.query(
      `SELECT (s.search_vector @@ to_tsquery('simple', $3)) AS admitted
       FROM doc_sections s WHERE s.doc_id = $1 AND s.position = $2`,
      [DOC_ID, 2, compiled.tsquery],
    )) as { admitted: boolean }[];
    expect(prefilterRows[0].admitted).toBe(false);
  });

  /**
   * ④ K 防御钳制：K > armCount 不得造成静默零召回
   * - 查询: `出出出出出`（5 CJK 字，起始 K=2；bigram 全同 ⇒ 去重后仅 1 arm）
   * - fixture: 一节含「出出」连写
   * - 断言的不变量: chooseKGateK(5, 1) = 1（钳到 arm 数）⇒ 命中节过门
   * - 失败含义: 无钳制 ⇒ K=2 > 1 arm 门恒假 ⇒ 任何文档都零召回且无报错
   */
  it('④ 出出出出出：K 钳到 1，单 arm 命中节过门', async () => {
    if (!handle.available) return;
    const compiled = compileQuery('出出出出出');
    expect(compiled.arms).toEqual([`('出'<->'出')`]);
    expect(chooseKGateK(compiled.cjkCharCount, compiled.arms.length)).toBe(1);
    await addSection(3, '这里出现出出连写');
    const rows = (await handle.db?.query(
      `SELECT (s.search_vector @@ to_tsquery('simple', $3)) AS hit
       FROM doc_sections s WHERE s.doc_id = $1 AND s.position = $2`,
      [DOC_ID, 3, compiled.arms[0]],
    )) as { hit: boolean }[];
    expect(rows[0].hit).toBe(true);
  });
});
