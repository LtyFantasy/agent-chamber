/**
 * =============================================================================
 * 钉子用例（批次 0 第 6 项 · 改名法入库）—— 元语法字符 + 真实 lexeme 端到端
 * =============================================================================
 * 机制：`*.pending.ts` 不被任何 jest 套件发现；**批次 1 激活 = 原地改名
 * `*.e2e-spec.ts`**。
 *
 * 每条按四列书写：查询 / fixture / 断言的不变量 / 失败含义。
 *
 * 契约①端到端面（census §5.5 / 计划 §10.4）：7 个 tsquery 元语法字符真实存在于
 * 生产 lexeme 内（`a&b` 209 行、`:` 1,472 行…）；单引号词位发射让查询侧与文档侧
 * 共用同一 tokenizer（parser 上下文敏感分词白拿）。下列「查询 → fixture 文档」
 * 匹配对全部已在 PG16 演练库预验证 `= t`（2026-09-25，批次 0 第 5 项执行侧）。
 * =============================================================================
 */
import {
  createMigrationChainTempDb,
  destroyMigrationChainTempDb,
  type TempDbHandle,
} from './_temp-db';
import { compileQuery } from '../../src/common/utils/search/tsquery-compiler';

/** fixture 锚点 id（pending 套件内部固定值） */
const SPACE_ID = 'e1e1e1e1-0000-4000-8000-0000000000c1';
const ACTOR_ID = 'e1e1e1e1-0000-4000-8000-0000000000c2';
const DOC_ID = 'e1e1e1e1-0000-4000-8000-0000000000c3';

describe('元语法字符 + 真实 lexeme 样本端到端（真 PG）', () => {
  let handle: TempDbHandle;
  jest.setTimeout(300_000);

  beforeAll(async () => {
    handle = await createMigrationChainTempDb('metasyntax');
    if (!handle.available) return;
    await handle.db?.query(
      `INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`,
      [SPACE_ID, 'metasyntax-pending-fixture', `meta-${process.pid}`, ACTOR_ID],
    );
    await handle.db?.query(
      `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [DOC_ID, SPACE_ID, 'memory/metasyntax-fixture.md', 'metasyntax fixture', ACTOR_ID],
    );
  });

  afterAll(async () => {
    await destroyMigrationChainTempDb(handle);
  });

  /** 向 fixture doc 写入一节（内容 = 查询词本身，模拟真实 lexeme 载体文档） */
  async function addSection(position: number, content: string): Promise<void> {
    await handle.db?.query(
      `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, $2, $3, $4)`,
      [DOC_ID, position, '', content],
    );
  }

  /**
   * 编译查询并对 fixture 节求 `@@`（预过滤谓词同路径：:compiledQ 绑定 + SQL 侧
   * `to_tsquery('simple', …)` 包裹——裸 cast 走 tsqueryin 原子语义，2026-09-26 1-b 实证）
   */
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
   * ① 7 元语法字符 + 真实 lexeme 样本（census §5.5 全表 + §5.2 证据样本）
   * - 查询: `race.service.ts:92` / `github.com:443` / `judgment:1` / `a&b` / `a!b` /
   *   `a(b` / `a-b` / `UTC+08:00` / `v1.85.0`（逐一样本）
   * - fixture: 每样本一节，内容含该 lexeme 原样（模拟 census 真实行）
   * - 断言的不变量: 编译产物经 `@@` 命中对应节；全程**无 42601**（裸拼时代
   *   `experience.service.ts:1747`/`judgment:1` 直接语法错误，census §5.5 实测）
   * - 失败含义: 发射形态回退（双引号/裸拼）⇒ 元语法字符击穿 tsquery 解析 =
   *   用户合法查询报 42601（400 家族）或静默变 AND 语义
   */
  // 第三列 = fixture position（PK，显式分配防碰撞）
  it.each([
    ['race.service.ts:92', '竞态修复落在 race.service.ts:92 这行', 101],
    ['github.com:443', '出口只放行 github.com:443', 102],
    ['judgment:1', '配置项 judgment:1 控制判别开关', 103],
    ['a&b', 'a&b 是两个子系统的合写', 104],
    ['a!b', '日志里出现 a!b 字样', 105],
    ['a(b', '残缺括号 a(b 出现在旧数据', 106],
    ['a-b', 'a-b 复合标识符', 107],
    ['UTC+08:00', '时区 UTC+08:00 排班', 108],
    ['v1.85.0', '版本 v1.85.0 引入判别重排', 109],
  ])(
    '① 样本 %s：编译 → @@ 命中（无 42601）',
    async (q: string, content: string, position: number) => {
      if (!handle.available) return;
      await addSection(position, content);
      await expect(tsHit(position, q)).resolves.toBe(true);
    },
  );

  /**
   * ② 含 `'` URL/词项 lexeme（census：7 行真实数据）
   * - 查询: `it's`（词项内单引号双写发射 `'it''s'`）
   * - fixture: 一节含 `it's` 原样
   * - 断言的不变量: 双写形态解析通过且命中（PG 实测 `'it' <-> 's'` 短语链 vs 文档
   *   `'it':1 's':2` ⇒ `= t`）
   * - 失败含义: 单引号未双写 ⇒ tsquery 语法错误（42601）或引号截断词项
   */
  it("② 含单引号词项：it's 双写发射命中", async () => {
    if (!handle.available) return;
    await addSection(2, `it's a lexeme with apostrophe`);
    const compiled = compileQuery(`it's`);
    expect(compiled.tsquery).toBe(`'it''s'`); // 双写形态（契约单测钉死）
    await expect(tsHit(2, `it's`)).resolves.toBe(true);
  });

  /**
   * ③ 普查真实字符形状（差分 e2e 样本表补形，architect 第四轮）
   * - 查询: `/web**` / `dockerfile.backend/web**` / `/r/machinelearning/)!` /
   *   `(https://platform.example.com/docs)`
   * - fixture: 每形状一节，内容含该形状原样
   * - 断言的不变量: 单引号发射路径在真实形状上命中（PG16 演练库预验证全部 `= t`；
   *   文档侧 parser 产复合词+部件，查询侧引号词位再分词为同形短语链）
   * - 失败含义: 发射路径只在玩具样本上验证过 ⇒ 真实形状（路径/通配/括号 URL）
   *   回归无感知
   */
  it.each([
    ['/web**', 201],
    ['dockerfile.backend/web**', 202],
    ['/r/machinelearning/)!', 203],
    ['(https://platform.example.com/docs)', 204],
  ])('③ 真实形状 %s：单引号发射路径命中', async (shape: string, position: number) => {
    if (!handle.available) return;
    await addSection(position, `路径 ${shape} 出现在部署文档`);
    await expect(tsHit(position, shape)).resolves.toBe(true);
  });
});
