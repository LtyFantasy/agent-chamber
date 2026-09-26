/**
 * =============================================================================
 * 钉子用例（批次 0 第 6 项 · 改名法入库）—— 脚本边界形状（普查边界必收）
 * =============================================================================
 * 机制：`*.pending.ts` 不被任何 jest 套件发现；**批次 1 激活 = 原地改名
 * `*.e2e-spec.ts`**。
 *
 * 每条按四列书写：查询 / fixture / 断言的不变量 / 失败含义。
 *
 * 覆盖（architect 第四轮「普查边界必收」）：`ー` 长音符形 / 零宽形 `1️⃣`（must_hit）
 * 与 `⌨️`（trgm-only/预期零命中标记）/ 全角字母数字。
 * =============================================================================
 */
import {
  createMigrationChainTempDb,
  destroyMigrationChainTempDb,
  type TempDbHandle,
} from './_temp-db';
import { compileQuery } from '../../src/common/utils/search/tsquery-compiler';

/** fixture 锚点 id（pending 套件内部固定值） */
const SPACE_ID = 'f2f2f2f2-0000-4000-8000-0000000000d1';
const ACTOR_ID = 'f2f2f2f2-0000-4000-8000-0000000000d2';
const DOC_ID = 'f2f2f2f2-0000-4000-8000-0000000000d3';

describe('脚本边界形状端到端（真 PG · 迁移链临时库）', () => {
  let handle: TempDbHandle;
  jest.setTimeout(300_000);

  beforeAll(async () => {
    handle = await createMigrationChainTempDb('boundaries');
    if (!handle.available) return;
    await handle.db?.query(
      `INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`,
      [SPACE_ID, 'boundaries-pending-fixture', `bnd-${process.pid}`, ACTOR_ID],
    );
    await handle.db?.query(
      `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [DOC_ID, SPACE_ID, 'memory/boundaries-fixture.md', 'boundaries fixture', ACTOR_ID],
    );
  });

  afterAll(async () => {
    await destroyMigrationChainTempDb(handle);
  });

  async function addSection(position: number, content: string): Promise<void> {
    await handle.db?.query(
      `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, $2, $3, $4)`,
      [DOC_ID, position, '', content],
    );
  }

  /** 预过滤谓词同路径：:compiledQ 绑定 + SQL 侧 `to_tsquery('simple', …)` 包裹（1-b 硬契约） */
  async function tsHit(position: number, q: string): Promise<boolean> {
    const compiled = compileQuery(q);
    expect(compiled.isEmpty).toBe(false);
    const rows = (await handle.db?.query(
      `SELECT (s.search_vector @@ to_tsquery('simple', $3)) AS hit
       FROM doc_sections s WHERE s.doc_id = $1 AND s.position = $2`,
      [DOC_ID, position, compiled.tsquery],
    )) as { hit: boolean }[];
    return rows[0].hit;
  }

  /**
   * ① `ー` 长音符形（R-3 唯一真实语言字符缺口，普查 §4.4 B14）
   * - 查询: `コーヒー`
   * - fixture: 一节含 `コーヒー`（单字化后 コ/ー/ヒ/ー 逐字分隔）
   * - 断言的不变量: 编译产 3 bigram 链（コー/ーヒ/ヒー）且 `@@` 命中；`ー` 不再
   *   把日文词切裂（扩类前 `コ` 与 `ヒー` 断裂）
   * - 失败含义: ① 类清单丢 `ー` ⇒ 日文词查询零命中且无报错（2 行真实语言缺口
   *   回归）
   */
  it('① コーヒー：长音符 bigram 链命中', async () => {
    if (!handle.available) return;
    const compiled = compileQuery('コーヒー');
    expect(compiled.arms).toEqual([`('コ'<->'ー')`, `('ー'<->'ヒ')`, `('ヒ'<->'ー')`]);
    await addSection(1, '午後のコーヒーは欠かせない');
    await expect(tsHit(1, 'コーヒー')).resolves.toBe(true);
  });

  /**
   * ② 零宽形 `1️⃣` = must_hit（普查 §10.3：24 行真实数据可达）
   * - 查询: 裸 `1` 与 `1️⃣` 两形态
   * - fixture: 一节含 `1️⃣`（1 + VS16 + 键帽；迁移后向量剥离为裸 `1`）
   * - 断言的不变量: 裸查询 `1` **从不命中变命中**（普查实测方向 = 增益）；
   *   `1️⃣` 形查询经 normalizeQuery 剥离后归一命中（双侧同表剥离）
   * - 失败含义: 剥离族双侧不同表 ⇒ 同一视觉字符两种 token，裸查询 `1` 继续
   *   不命中（迁移前行为回归）
   */
  it('② 1️⃣：裸查询 1 命中、1️⃣ 形查询归一命中', async () => {
    if (!handle.available) return;
    await addSection(2, '步骤 1️⃣ 先备份数据库');
    await expect(tsHit(2, '1')).resolves.toBe(true);
    await expect(tsHit(2, '1️⃣')).resolves.toBe(true);
  });

  /**
   * ③ 零宽形 `⌨️` = trgm-only / 预期零命中标记（architect 第五轮 NEW-2）
   * - 查询: `⌨️`
   * - fixture: 一节含 `⌨️`
   * - 断言的不变量: ts 腿**恒不可达**——`⌨` 是分隔符不产 lexeme（文档侧向量无
   *   `⌨`），查询侧编译产物为空（isEmpty=true ⇒ 按面枚举走 trgm-only）；本用例
   *   钉的是「ts 腿不命中」这一**预期**（不是 bug），防后续把 ⌨ 误收进类清单
   * - 失败含义: 若未来把 `⌨` 收进 ①/② ⇒ 本用例变红 = 字符类被悄悄改动
   *   （schema 级不变量哨兵）
   */
  it('③ ⌨️：ts 腿恒不可达（字符类哨兵，预期零命中标记）', async () => {
    if (!handle.available) return;
    await addSection(3, '快捷键 ⌨️ 映射表');
    const compiled = compileQuery('⌨️');
    // 查询侧：⌨ 是分隔符 ⇒ 空编译产物（消费方按面枚举走 trgm-only）
    expect(compiled.isEmpty).toBe(true);
    // 文档侧：向量不含 ⌨ lexeme（真库断言）
    const rows = (await handle.db?.query(
      `SELECT s.search_vector::text AS vec FROM doc_sections s WHERE s.doc_id = $1 AND s.position = $2`,
      [DOC_ID, 3],
    )) as { vec: string }[];
    expect(rows[0].vec).not.toContain('⌨');
  });

  /**
   * ④ 全角字母数字（② 整词 run；普查：全角大/小写各 8 行）
   * - 查询: `ＡＢＣ`
   * - fixture: 一节含 `ＡＢＣ`
   * - 断言的不变量: 整 run 一 term（不切分）且命中——PG simple 对全角同样小写化
   *   （`ＡＢＣ` → `ａｂｃ`，PG16 演练库实测查询/文档双侧同形）
   * - 失败含义: 全角段被误切分 ⇒ 整词查询零命中；或被归分隔符 ⇒ isEmpty 误报
   */
  it('④ ＡＢＣ：全角整词 run 命中', async () => {
    if (!handle.available) return;
    const compiled = compileQuery('ＡＢＣ');
    expect(compiled.tsquery).toBe(`'ＡＢＣ'`);
    await addSection(4, '全角 ＡＢＣ 与 １２３ 混排');
    await expect(tsHit(4, 'ＡＢＣ')).resolves.toBe(true);
  });
});
