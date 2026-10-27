import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 召回查询词**原文留存**（`memory_recall_events.query_text` + `memory_projects.retain_query_text`）
 *
 * 背景：召回遥测此前只存 `query_hash`（sha256 摘要），隐私上是干净了，但**排障断链**——
 * agent 会话压缩后无法提供原始 query，摘要又不能反推，出问题只能靠 `recallId` / `requestId`
 * 去引擎侧日志对账（且引擎侧不一定留）。Owner 拍板（2026-10-09）：加原文列、**默认开启**
 * （内部项目自用）。开源无需摘除——自部署场景数据不出部署方边界，外部部署方知情
 * （文档写明）且可按项目 PATCH 关闭。
 *
 * 列语义（逐条钉死）：
 * 1. `memory_recall_events.query_text`：**可空 text**。留存的原文长度不受控（查询词是
 *    消费方自由输入），故用 `text` 而非 varchar(255) 之类的猜测上限——截断会毁掉排障价值
 *    （原文被截 = 复现不出来）。**存量行保持 NULL**（列后加，PoC 期不回填）。
 * 2. `memory_projects.retain_query_text`：**boolean NOT NULL DEFAULT true**。默认开 =
 *    新建项目自动留存；PATCH 可翻转（`retainQueryText: false` ⇒ 之后新落的遥测行
 *    `query_text` 恒 NULL）。NOT NULL 是刻意的：不引入"未设置"第三态（未设置与"开"
 *    在语义上无从区分，多一态只是多一个 bug 面）。
 * 3. `query_hash` **不变、仍恒落**：摘要不因留存开关而消失——关掉原文后它仍是唯一的
 *    对账线索（且它才是索引/关联的稳定键，原文列不参与任何谓词）。
 *
 * 本迁移**不建索引**：`query_text` / `retain_query_text` 都不是查询谓词
 * （前者只按主键取行后读列，后者只在项目行上读），建了就是白付写放大。
 *
 * 漂移预测：[C] 段**零新增项**——两列都由实体元数据完整表达（无索引、无 FK、无部分谓词），
 * 迁移与实体逐列对齐。若门禁多出条目（尤其形如 `ALTER TABLE ... ALTER COLUMN
 * retain_query_text SET DEFAULT ...`），先查实体侧的 `default: true` 与库侧是否写法不一致，
 * 不要去改基线。
 *
 * 形态：`ADD COLUMN IF NOT EXISTS`（PG 11+ 元数据级变更；boolean 带常量默认值不重写表，
 * 可空 text 无需 DEFAULT 回填——存量行 NULL 是合法态）+ `SET LOCAL lock_timeout='5s'`
 * （1788439433261 先例：长事务占表锁时放弃而非无限排队）。
 *
 * down()：DROP COLUMN ×2（可回滚；两列均无约束、无索引、无 FK 依赖）。
 * ⚠️ 回滚会**丢原文**（不可逆的数据损失）——生产回滚仍走 DEPLOY.md 的 additive-only 口径。
 */
export class MemoryRecallQueryTextRetention1791900000000 implements MigrationInterface {
  name = 'MemoryRecallQueryTextRetention1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE memory_recall_events
         ADD COLUMN IF NOT EXISTS query_text text`,
    );
    await queryRunner.query(
      `ALTER TABLE memory_projects
         ADD COLUMN IF NOT EXISTS retain_query_text boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE memory_projects DROP COLUMN IF EXISTS retain_query_text`);
    await queryRunner.query(`ALTER TABLE memory_recall_events DROP COLUMN IF EXISTS query_text`);
  }
}
