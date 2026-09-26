/**
 * =============================================================================
 * 钉子用例（批次 1-b 激活）—— snippet 高亮清理三态（计划 §2.2，真 DocSearchService 入口）
 * =============================================================================
 * 激活注（review F6 落实）：批次 0 入库时为 SQL 级参照实现（裸 `dataSource.query`
 * + 手工 replace 模拟清理）；批次 1-b snippet 清理接线后，本套件**全部改走真
 * `DocSearchService.search()` 入口**，直接断言生产 snippet 产物——手工 replace
 * 是「自写字面量自证恒真」空转，只有真入口断言有判别力。
 *
 * 每条按四列书写：查询 / fixture / 断言的不变量 / 失败含义。
 *
 * snippet 契约（计划 §2.2 / snippet-cleanup.ts 单源）：`ts_headline('simple',
 * cjk_unigram_text(content), :compiledQ, …)` 作用于单字化文本 ⇒ 产物带单字化
 * 空格（字间双空格）；清理三步（标记并合 → 连续空格归并单空格 → trim）后
 * **先剥空格再比长度/截断**。doc-search 通道 `StartSel=""` 空标记是刻意设计
 * （snippet 只取文本不要标记）⇒ 产物不得出现任何 `<`/`>` 残骸。
 * =============================================================================
 */
import {
  createMigrationChainTempDb,
  destroyMigrationChainTempDb,
  type TempDbHandle,
} from './_temp-db';
import { DocSearchService } from '../../src/modules/docspace/doc-search.service';
import { DocSection } from '../../src/database/entities/doc-section.entity';
import { Doc } from '../../src/database/entities/doc.entity';
import { DocRoute } from '../../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../../src/database/entities/task-doc-link.entity';

/** fixture 锚点 id（本套件内部固定值） */
const SPACE_ID = 'b4b4b4b4-0000-4000-8000-0000000000f1';
const ACTOR_ID = 'b4b4b4b4-0000-4000-8000-0000000000f2';
const DOC_ID = 'b4b4b4b4-0000-4000-8000-0000000000f3';

describe('snippet 高亮清理三态（真 PG · 真 DocSearchService 入口）', () => {
  let handle: TempDbHandle;
  let service: DocSearchService;
  jest.setTimeout(300_000);

  beforeAll(async () => {
    handle = await createMigrationChainTempDb('snippet');
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
    await db.query(
      `INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`,
      [SPACE_ID, 'snippet-fixture', `snip-${process.pid}`, ACTOR_ID],
    );
    await db.query(
      `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [DOC_ID, SPACE_ID, 'memory/snippet-fixture.md', 'snippet fixture', ACTOR_ID],
    );
  });

  afterAll(async () => {
    await destroyMigrationChainTempDb(handle);
  });

  /** 向 fixture doc 追加一节 */
  async function addSection(position: number, content: string): Promise<void> {
    await handle.db?.query(
      `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, $2, $3, $4)`,
      [DOC_ID, position, '', content],
    );
  }

  /** 真入口取指定 position 命中的生产 snippet */
  async function snippetOf(position: number, q: string): Promise<string> {
    const { hits } = await service.search([SPACE_ID], { q, limit: 20 });
    const hit = hits.find((h) => h.docId === DOC_ID && h.position === position);
    expect(hit).toBeDefined();
    return (hit as { snippet: string }).snippet;
  }

  /**
   * snippet 清理不变量（三态共用，契约见 snippet-cleanup.ts）：
   * - 无 `>>>`/`<<<` 及任何 `<`/`>` 残骸（空标记通道产物不得出现标记字符）
   * - 无连续空格（单字化双空格已被归并）
   * - 首尾无空格（先剥空格再比长度/截断）
   */
  function assertSnippetClean(snippet: string): void {
    expect(snippet).not.toMatch(/>>>\s*<<</);
    expect(snippet).not.toContain('<');
    expect(snippet).not.toContain('>');
    expect(snippet).not.toContain('  ');
    expect(snippet).toBe(snippet.trim());
  }

  /**
   * ① 双空格态（单字化字间双空格 + 相邻命中）
   * - 查询: `出境`
   * - fixture: 一节「出境 游与签证办理流程说明」（单字化后命中两字夹双空格）
   * - 断言的不变量: 清理后无连续空格、首尾无空格、无标记残骸；命中文本「出境」
   *   两字在场（剥掉全部空格后连续可读，不被劈碎丢失）
   * - 失败含义: 清理缺失 ⇒ snippet 把单字化内部表示原样泄漏给用户（字间双空格 +
   *   标记残渣），验收「snippet 无 >>> <<< 与空格残留」红线
   */
  it('① 双空格态：单字化双空格归并、命中字在场不丢失', async () => {
    if (!handle.available) return;
    await addSection(1, '出境 游与签证办理流程说明');
    const snippet = await snippetOf(1, '出境');
    assertSnippetClean(snippet);
    expect(snippet).toContain('出');
    expect(snippet).toContain('境');
    expect(snippet.replace(/ /g, '')).toContain('出境');
  });

  /**
   * ② 标记边界态（命中落在 MaxWords 截断边界之外）
   * - 查询: `闸`
   * - fixture: 一节长文，「闸」在 MaxWords=150 窗口之外（前铺大段无关文本）——
   *    headline 只取窗口内片段，截断处不得产出任何残骸
   * - 断言的不变量: 截断处不产半个标记（无 `<`/`>` 残骸）、无连续空格、
   *   先剥空格再截断（截断后首尾无空格）
   * - 失败含义: 按字符硬截 ⇒ 标记被腰斩或截出前导空格——9082464c 家族
   *   「字面量残渣污染 snippet」回归
   */
  it('② 标记边界态：截断不产残骸、先剥空格再截断', async () => {
    if (!handle.available) return;
    await addSection(2, `${'前置铺垫文本 '.repeat(80)}闸 口检查项`);
    const snippet = await snippetOf(2, '闸');
    expect(snippet.length).toBeGreaterThan(0);
    assertSnippetClean(snippet);
  });

  /**
   * ③ 用户原生空格态（文档自带空格与单字化空格混杂）
   * - 查询: `出境`
   * - fixture: 一节「签证材料 出 境 记录与 出境 登记流程」（原生空格把一处
   *   「出境」劈开，另一处连写）
   * - 断言的不变量: 原生单空格语义保留（不把所有空格删光——英文/混排 snippet
   *   单词不粘连）但不得出现连续空格与标记残留
   * - 失败含义: 清理把原生空格一并吞掉 ⇒ 英文/混排 snippet 单词粘连不可读；
   *   或保留双空格 ⇒ 单字化内部表示泄漏
   */
  it('③ 原生空格态：原生空格保留、双空格归并、无标记残留', async () => {
    if (!handle.available) return;
    await addSection(3, '签证材料 出 境 记录与 出境 登记流程');
    const snippet = await snippetOf(3, '出境');
    assertSnippetClean(snippet);
    // 原生单空格保留：清理只并连续空格，不删光空格
    expect(snippet).toContain(' ');
  });
});
