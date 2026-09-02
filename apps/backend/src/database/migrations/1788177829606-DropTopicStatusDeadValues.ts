import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 删除 topic_status 枚举死值 draft/voting（review-0831 任务 b916d7cc 死契约清理）
 *
 * 背景（2026-08-31 用户拍板）：topic 现实定位 = 常驻聊天室，create 恒写 ACTIVE，
 * VOTING/DRAFT 无入口死状态以后也不会用，删除而非标注 reserved。
 *
 * ⚠️ 生产修正（2026-09-01 v1.72.0-dev 部署实录）：此前"生产零 draft/voting 行"的实证
 * 有误——实际存在 1 行 2026-05-18 的遗留 draft（ecbc78a6「和琉璃聊天」，老论坛时代产物）。
 * 且 chamber 开源用户的老库同样可能带 draft/voting 行，install.sh 升级自动跑 migration，
 * 不 remap 必然 22P02 崩部署。故 up() 第 0 步先把 draft/voting 行 remap 到 closed
 * （保守语义：保留行、不激活、按 TOPIC_STATUS_TRANSITIONS 可重开），再重建枚举。
 *
 * PG 不支持 `ALTER TYPE ... DROP VALUE`，标准五步（数据安全）：
 * 0. 死值行 remap（draft/voting → closed，见上；新库零行 no-op）
 * 1. 摘列默认值——初始 migration 的列默认 'draft' 挂在旧类型上，先摘才能 DROP TYPE
 * 2. 列改 varchar(20) → DROP 旧类型 → CREATE 新类型（七值 → 五值）
 * 3. 列改回新枚举（USING 显式转换，存量值全部落在新类型值域内）
 * 4. 恢复默认值 'active'（对齐实体 @Column default: TopicStatus.ACTIVE）
 *
 * down() 逆操作：恢复七值类型与 draft 默认（幂等可逆，up→down→up 验证过）。
 * 注意：down 不回滚第 0 步的 remap（closed 行保持 closed——原死值归属无法无损推断）。
 */
export class DropTopicStatusDeadValues1788177829606 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 0. 死值行 remap（老库 draft/voting → closed；新库零行 no-op）
    await queryRunner.query(
      `UPDATE "topics" SET "status" = 'closed' WHERE "status" IN ('draft', 'voting')`,
    );
    // 1. 摘默认值（旧默认 'draft' 依赖旧类型，先摘才能 DROP TYPE）
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "status" DROP DEFAULT`);
    // 2. 列改 varchar → 删旧类型 → 建新类型（删 draft/voting）
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "status" TYPE varchar(20)`);
    await queryRunner.query(`DROP TYPE "topic_status"`);
    await queryRunner.query(
      `CREATE TYPE "topic_status" AS ENUM ('open', 'active', 'paused', 'closed', 'archived')`,
    );
    // 3. 列改回新枚举（USING 显式转换）
    await queryRunner.query(
      `ALTER TABLE "topics" ALTER COLUMN "status" TYPE "topic_status" USING "status"::"topic_status"`,
    );
    // 4. 恢复默认值（create 恒写 ACTIVE，默认对齐实体）
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "status" SET DEFAULT 'active'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆操作：恢复七值类型与 draft 默认
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "status" TYPE varchar(20)`);
    await queryRunner.query(`DROP TYPE "topic_status"`);
    await queryRunner.query(
      `CREATE TYPE "topic_status" AS ENUM ('draft', 'open', 'active', 'voting', 'paused', 'closed', 'archived')`,
    );
    await queryRunner.query(
      `ALTER TABLE "topics" ALTER COLUMN "status" TYPE "topic_status" USING "status"::"topic_status"`,
    );
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "status" SET DEFAULT 'draft'`);
  }
}
