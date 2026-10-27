import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * memory_nominations.correction_target_memory_id（更正目标的**落库**，批次 3 技术欠账）
 *
 * 背景（欠账本体）：更正发起时 `CorrectMemoryDto.oldMemoryId`（显式指定的被更正引擎记忆 id，
 * 缺省 = 旧行主记忆 `engine_memory_ids[0]`）此前**只透传给首跑的 `completeCorrectionLink`**，
 * 不落库。于是**中断续跑**（`POST /memory/nominations/:id/retry` 的更正续跑分支）拿不到它，
 * 静默回退到旧行主记忆 —— 非主记忆目标的更正在中断后续跑会**静默打错目标**
 * （引擎侧 supersede 了错误的记忆）。
 *
 * 列语义（逐条钉死）：
 * 1. **仅更正行有意义**（`correction_of IS NOT NULL`）；普通提名行恒 NULL（写路径只在更正
 *    分支赋值），故列可空、无默认值——存量行 NULL 是**合法态**，不需要回填；
 * 2. 存的是**解析后的有效目标**（显式值或缺省主记忆），而不是"用户是否显式给了"——
 *    这样续跑与首跑**逐字节同参**，回退链只需要"有落库值就用它"这一条判据；
 * 3. `varchar(128)` 对齐相邻引擎 id 列（`engine_nomination_id` / `engine_correction_id` /
 *    `engine_job_id` 同为 128）——引擎 memory id 是同一命名族的 id，列宽跟着走。
 *
 * 形态：`ADD COLUMN IF NOT EXISTS`（PG 11+ 元数据级变更，不重写表；可空无需 DEFAULT 回填）+
 * `SET LOCAL lock_timeout='5s'`（1788439433261 先例：长事务占表锁时放弃而非无限排队）。
 * 本列**无索引**：它不是任何查询谓词（消费点只有"按主键取行后读字段"一条），
 * 故不建索引（建了就是白付写放大）。
 *
 * down()：DROP COLUMN（可回滚；本列无约束、无索引、无 FK 依赖）。
 */
export class AddMemoryCorrectionTargetId1791800000000 implements MigrationInterface {
  name = 'AddMemoryCorrectionTargetId1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE memory_nominations
         ADD COLUMN IF NOT EXISTS correction_target_memory_id varchar(128)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE memory_nominations DROP COLUMN IF EXISTS correction_target_memory_id`,
    );
  }
}
