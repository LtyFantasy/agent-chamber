/**
 * =============================================================================
 * 钉子用例（批次 1-b 激活）—— 单 CJK 字查询路径（计划 §2.5，真 DocSearchService 入口）
 * =============================================================================
 * 激活注（review F6 落实）：批次 0 入库时为 SQL 级参照实现；批次 1-b doc-search
 * 单字分路径接线后，本套件**全部改走真 `DocSearchService.search()` 入口**（手工
 * 装配：4 仓储 + 判别内核 mock `isEnabled: () => false`，范式抄
 * test/doc-search-prefilter.e2e-spec.ts:463）——实现若混入 `%` 腿或逐行打分，
 * 参照 SQL 自身不会红，只有真入口断言有判别力。
 *
 * 每条按四列书写：查询 / fixture / 断言的不变量 / 失败含义。
 *
 * 单字路径契约（计划 §2.5）：ts 过滤保留（GIN，候选集 = ts-only，两 `%` 腿明文
 * 不查）+ 常数分 0.1（> floor 0.08 天然过线）+ 跳过两个 similarity 腿与 cd ⇒
 * 端到端 ≈ 预过滤耗时；排序 = `section_position ASC, doc_id ASC`；信封带
 * `hint = DOC_SEARCH_POSITIONAL_ORDER_HINT`（相关度排序下声明未按相关度排序）。
 * =============================================================================
 */
import {
  createMigrationChainTempDb,
  destroyMigrationChainTempDb,
  type TempDbHandle,
} from './_temp-db';
import { compileQuery } from '../../src/common/utils/search/tsquery-compiler';
import {
  DocSearchService,
  SCORE_FLOOR,
  SINGLE_CHAR_CONST_SCORE,
} from '../../src/modules/docspace/doc-search.service';
import { DocSection } from '../../src/database/entities/doc-section.entity';
import { Doc } from '../../src/database/entities/doc.entity';
import { DocRoute } from '../../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../../src/database/entities/task-doc-link.entity';
import { DOC_SEARCH_POSITIONAL_ORDER_HINT } from '@agent-chamber/shared';

/** fixture 锚点 id（本套件内部固定值） */
const SPACE_ID = 'a3a3a3a3-0000-4000-8000-0000000000e1';
const ACTOR_ID = 'a3a3a3a3-0000-4000-8000-0000000000e2';
const DOC_A_ID = 'a3a3a3a3-0000-4000-8000-0000000000e3';
const DOC_B_ID = 'a3a3a3a3-0000-4000-8000-0000000000e4';

describe('单 CJK 字查询路径（真 PG · 真 DocSearchService 入口）', () => {
  let handle: TempDbHandle;
  let service: DocSearchService;
  jest.setTimeout(300_000);

  beforeAll(async () => {
    handle = await createMigrationChainTempDb('single_char');
    if (!handle.available) return;
    const db = handle.db!;
    // 手工装配服务（真仓储；判别内核恒未启用 ⇒ 不碰重排，走原路径）
    service = new DocSearchService(
      db.getRepository(DocSection),
      db.getRepository(Doc),
      db.getRepository(DocRoute),
      db.getRepository(TaskDocLink),
      { isEnabled: () => false, run: jest.fn(), recordSkip: jest.fn() } as never,
    );
    await db.query(`INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`, [
      SPACE_ID,
      'single-char-fixture',
      `sc-${process.pid}`,
      ACTOR_ID,
    ]);
    // 两个 doc：制造「同 position 不同 doc」的平局面（doc_id 末位键的考场）
    await db.query(
      `INSERT INTO docs (id, space_id, path, title, created_by) VALUES
       ($1, $3, 'memory/single-a.md', 'single A', $4),
       ($2, $3, 'memory/single-b.md', 'single B', $4)`,
      [DOC_A_ID, DOC_B_ID, SPACE_ID, ACTOR_ID],
    );
    // 平局 fixture：A#2 / B#2（同 position）+ A#1（更前 position）
    await db.query(
      `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES
       ($1, 2, '', '成本总闸 的设计'),
       ($2, 2, '', '关于 闸 门的说明'),
       ($1, 1, '', '闸 口前置检查')`,
      [DOC_A_ID, DOC_B_ID],
    );
  });

  afterAll(async () => {
    await destroyMigrationChainTempDb(handle);
  });

  /**
   * ① 双键排序 `section_position ASC, doc_id ASC`（architect N-a 钉）
   * - 查询: `闸`（单 CJK 字）
   * - fixture: A#1 / A#2 / B#2 三节均含「闸」（A#2 与 B#2 同 position 造平局）
   * - 断言的不变量: 结果序逐字 = [A#1, A#2, B#2]——position 升序为主键、**doc_id
   *   升序为末位平局键**（常数分下 position 平局大量存在，缺末位键则分页/结果
   *   不可复现，冲突 doc-search.service.ts 既有池序不变量）；信封带位置序 hint
   * - 失败含义: 漏 doc_id 末位键 ⇒ 常数分下平局序由 PG 堆序随机决定 ⇒ 分页
   *   漏/重结果且不可复现
   */
  it('① 单字查询排序 = section_position ASC, doc_id ASC（平局可复现）+ 位置序 hint', async () => {
    if (!handle.available) return;
    const compiled = compileQuery('闸');
    expect(compiled.singleCjkChar).toBe('闸');
    const { hits, hint } = await service.search([SPACE_ID], { q: '闸', limit: 20 });
    expect(hits.map((h) => `${h.docId}#${h.position}`)).toEqual([
      `${DOC_A_ID}#1`,
      `${DOC_A_ID}#2`,
      `${DOC_B_ID}#2`,
    ]);
    // 服务层断言（激活时补）：降级 + 相关度排序 ⇒ 声明未按相关度排序
    expect(hint).toBe(DOC_SEARCH_POSITIONAL_ORDER_HINT);
  });

  /**
   * ② 常数分 0.1 天然过地板（database N-⑥）
   * - 查询: `闸`
   * - fixture: 同①
   * - 断言的不变量: 常数分 > 真 `SCORE_FLOOR`（doc-search.service.ts 导出单源，
   *   地板漂移即红）；三 fixture 行 score 恒等（无逐行打分）
   * - 失败含义: 常数分 ≤ 地板 ⇒ 单字查询被外层地板过滤全灭；或重新引入逐行
   *   cd/similarity ⇒ 557ms 病理回归（计划 §2.5）
   */
  it('② 单字查询常数分 > 真 SCORE_FLOOR 且全行同分', async () => {
    if (!handle.available) return;
    const { hits } = await service.search([SPACE_ID], { q: '闸', limit: 20 });
    expect(hits).toHaveLength(3);
    for (const hit of hits) {
      expect(hit.score).toBe(SINGLE_CHAR_CONST_SCORE);
      expect(hit.score).toBeGreaterThan(SCORE_FLOOR);
    }
  });

  /**
   * ③ ts-only 候选：两 `%` 腿明文不查（精度增益 + 绕开逐行打分）
   * - 查询: `闸`
   * - fixture: 额外一节「阀门 选型记录」（含「门」无「闸」——靠 trgm 才可能沾边）
   * - 断言的不变量: 该节**不在**真入口结果集（ts-only 过滤；实现若混入 `%` 腿，
   *   单字 trgm 会把「门」沾边节拉进结果，本断言即红）
   * - 失败含义: 两 `%` 腿混入 ⇒ 单字 trgm 噪声大（精度回归）+ 逐行 similarity
   *   打在全表候选上（性能病理回归）
   */
  it('③ 单字候选 = ts-only（trgm 沾边节不进结果）', async () => {
    if (!handle.available) return;
    // 纯 trgm 沾边节：只有「阀门」、全文无「闸」字
    await handle.db?.query(
      `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, 9, '', '阀门 选型记录')`,
      [DOC_A_ID],
    );
    const { hits } = await service.search([SPACE_ID], { q: '闸', limit: 20 });
    expect(hits.find((h) => h.docId === DOC_A_ID && h.position === 9)).toBeUndefined();
  });
});
