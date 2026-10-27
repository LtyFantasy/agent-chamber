import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * memory_formation_events.diagnostics（形成尝试的**引擎诊断投影**，b4d41314）
 *
 * 背景：引擎的两个失败面细节此前被平台丢掉——409 的 `error.details.admission_cause` 在引擎层
 * 被丢弃；终拒的 `diagnostics.failure.{error_detail,failure_class}` 未进响应。诊断必须能进
 * **详情读面**（`GET /memory/nominations/:id` 的 full 档），而账本表没有承载列、`reason_code`
 * 语义固定（= hument `error.code`，不可挪用）⇒ 落在**遥测表**（尝试历史是本表本职）。
 *
 * 列语义（逐条钉死）：
 * 1. **可空、无默认值**：NULL = 本次尝试没有引擎诊断（旧行 / 引擎未提供 / 无回执），是合法态，
 *    存量行**不回填**；
 * 2. **append-only**：每行只描述**本次**尝试，没有 UPDATE 路径；
 * 3. 平台投影为 camelCase **子集**（`admissionCause` / `engineReasonCode` / `errorDetail` /
 *    `failureClass` / `requestId`），不镜像 hument schema 版本；code↔detail 的配对合法性由
 *    引擎保证，平台不复刻。
 *
 * 迁移纪律：
 * - 预期 drift diff = **0**（实体与迁移链一致；门禁 `test:e2e -- migration-drift` 验证）；
 * - `down()` **仅供仓内往返**：生产是 additive-only，不回滚 DDL；
 * - **刻意无索引**：该列永不做查询谓词（只在按主键取行后读 payload）。触发加索引的条件 =
 *   单 ledger 遥测行显著增长 / 相关查询进 slow log / `POST recover` 扫描变慢。
 */
export class AddMemoryFormationDiagnostics1792300000000 implements MigrationInterface {
  name = 'AddMemoryFormationDiagnostics1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1788439433261 先例：长事务占表锁时放弃而非无限排队（PG 11+ 加可空列是元数据级变更，
    // 不重写表、无需 DEFAULT 回填）
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE memory_formation_events
         ADD COLUMN IF NOT EXISTS diagnostics jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE memory_formation_events DROP COLUMN IF EXISTS diagnostics`);
  }
}
