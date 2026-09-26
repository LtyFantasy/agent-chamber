/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 检索的 heading_path 模糊预过滤索引（pg_trgm GIN）
 *
 * [代码职责]
 *   - 为 `doc_sections.heading_path` 建 `gin_trgm_ops` GIN 索引，支撑检索预过滤的
 *     `s.heading_path % :q` 分支（裸列，故索引必须建在裸列上）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: src/modules/docspace/doc-search.service.ts — 预过滤谓词与零召回损失证明
 *     （`%` 的阈值由连接级 GUC 下发，见 src/database/pg-session-defaults.ts）
 *
 * [关键不变量]
 *   - **普通 `CREATE INDEX`，禁止 `CONCURRENTLY` / `transaction = false`**：本仓
 *     data-source.ts 与 app.module.ts 均未设 `migrationsTransactionMode`，TypeORM 0.3.x
 *     缺省 `'all'`（整批 pending 迁移共用一个事务）。显式声明 `transaction = false`
 *     会抛 `ForbiddenTransactionModeOverrideError` 并连带弄红 migration-drift 门禁
 *     （先例与论证见 1790200000000-AddExperiencePhase2.ts 文件头）。
 *   - **实体侧刻意不加 `@Index` 护栏**（同形先例 1790200000000 的两条 judgments 索引）：
 *     TypeORM schema diff 只比索引**名字**、不比类型/opclass，加了 `@Index` 反而会让未来
 *     `migration:generate` 产出 **btree** 误建（"假护栏"），并把裸 SQL 索引事实源撕成两份。
 *     本索引按裸 SQL 产物入账漂移基线 [B] 段（预期恰好 +1 条 DROP INDEX 项）。
 *   - `heading_path` 可空：`%` 遇 NULL 结果为 NULL（不进 true），与打分侧
 *     `similarity(COALESCE(heading_path,''), q)` 语义一致（`similarity('', q) = 0`）。
 *
 * [关联代码]
 *   - src/database/entities/doc-section.entity.ts — 刻意零 `@Index`（见 [关键不变量]）
 *   - src/modules/docspace/doc-search.service.ts — 唯一消费方（`heading_path % :q`）
 *   - test/migration-drift-baseline.txt — 本索引的 [B] 段入账
 *   - test/doc-search-prefilter.e2e-spec.ts — indexdef 守卫（漂移门禁对 GIN 只报 DROP，
 *     不比 opclass ⇒ 必须另有 indexdef 断言）
 *   - test/migration-drift.e2e-spec.ts — 漂移门禁（本迁移使其 +1 条 B 段条目）
 *
 * [持久踩坑]
 *   - DOCSEARCH-TRGM-INDEX-LOCK(建索引阻塞写): 普通 `CREATE INDEX` 对 doc_sections 取
 *     SHARE 锁（阻塞写、放行读），而 transaction='all' 使该锁**持到整批 pending 迁移
 *     commit**。安全方向: 本次部署**只带这一条 pending 迁移**；若日后必须与其它迁移同批，
 *     先评估后续迁移的执行时长（锁窗口 = 本索引在建表锁之上的额外时长）。
 *     生产规模参考（2026-09-25）：doc_sections 5.7 万行 / 318MB。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `doc_sections.heading_path` 的 pg_trgm GIN 索引 —— DocSpace 检索预过滤的第三条索引。
 *
 * 背景（2026-09-25 生产实证）：检索内层子查询原为「doc_sections 全表逐行算
 * ts_rank + 2 次 similarity」（生产 Parallel Seq Scan 2128ms）。加索引化预过滤后：
 *   - `search_vector @@ to_tsquery(...)` → `idx_doc_sections_search_vector`（既有）
 *   - `content % :q`                     → `idx_doc_sections_content_trgm`（既有）
 *   - `heading_path % :q`                → **本迁移新建**（此前无索引，是三条分支里唯一缺口）
 * 三条合成 BitmapOr，只对候选行打分（28ms）。
 *
 * 索引形态：`gin (heading_path gin_trgm_ops)` —— 与既有 `idx_doc_sections_content_trgm`
 * 同款；不用 GIST（`gist_trgm_ops`）因为此处只做 `%` 布尔判定、不排序，GIN 查询更快且
 * 构建更省内存。
 *
 * 锁与事务（部署注意，见文件头 [持久踩坑] DOCSEARCH-TRGM-INDEX-LOCK）：
 *   - 普通 `CREATE INDEX` 取 SHARE 锁 ⇒ 建索引期间**阻塞 doc_sections 写**（放行读）；
 *   - data-source.ts / app.module.ts 均未设 `migrationsTransactionMode` ⇒ TypeORM 缺省
 *     `'all'`，**整批 pending 迁移共用一个事务** ⇒ 本锁持有到整批 commit。
 *   - 故本次部署应**只带这一条 pending 迁移**（否则后续迁移的执行时长会叠加进锁窗口）。
 */

/** 索引名（供 up/down 与 indexdef 断言共用同一字面量） */
const INDEX_NAME = 'idx_doc_sections_heading_path_trgm';

export class AddDocSectionHeadingPathTrgmIndex1791000000000 implements MigrationInterface {
  name = 'AddDocSectionHeadingPathTrgmIndex1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // pg_trgm 幂等兜底（AddDocSpaceModule 已启用；官方 postgres 镜像自带 contrib）。
    // gin_trgm_ops 需要扩展在场。
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // 普通 CREATE INDEX（**不加 CONCURRENTLY**）：见文件头 [关键不变量] 的事务模式论证。
    // 建在**裸列**上：消费方预过滤写 `s.heading_path % :q`（COALESCE 会破坏索引匹配，
    // 打分侧的 COALESCE 只影响分数、不参与索引）。
    await queryRunner.query(`
      CREATE INDEX ${INDEX_NAME}
      ON doc_sections USING GIN (heading_path gin_trgm_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 普通 DROP（与 up 的普通 CREATE 对称；不用 CONCURRENTLY 版本，理由同上）
    await queryRunner.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);

    // 刻意不卸载 pg_trgm 扩展（共享扩展，DocSpace 与经验库都在用；
    // 同 AddDocSpaceModule.down 与 AddExperienceEntries.down 的口径）
  }
}
