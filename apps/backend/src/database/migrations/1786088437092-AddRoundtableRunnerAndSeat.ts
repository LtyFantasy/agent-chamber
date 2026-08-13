import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 圆桌 runner / 座位两表迁移（M1 提前落地，见 docs/roundtable-design.md §5/§9）
 *
 * 设计要点：
 * - 纯新表：roundtable_runners + roundtable_seats，零存量改写，回滚 = 只 drop 两表 + 索引
 * - 座位表 config/state 分列：config jsonb 只存静态配置（permissionMode/model/cwd/
 *   bindActorId/攒批窗口覆盖/预算上限/上下文水位阈值）；state jsonb DEFAULT '{}' 存
 *   运行时状态（recentInjects ring buffer/lastUsage）——分列避免 read-modify-write 竞争
 * - last_event_seq / last_inject_seq bigint：双向对账游标（设计 §4 可靠性，座位级独立递增）
 * - runner_id nullable = 未绑/离线座位；座位绑 runner 由握手认证后按 config.bindActorId 匹配
 * - status 用 varchar（对齐 actors.status 惯例，非 PG enum）：runner online/offline，
 *   seat active/paused/parked/offline（M1 只落 active）
 * - 不建 DB 级物理 FK（D-B1-2 惯例：裸 uuid + 索引，仅 TypeORM 导航）
 *
 * ⚠️ 本文件为人工核对后重写：typeorm migration:generate 原始产物混入了存量表
 * 元数据漂移噪音（doc_*、task_* 两族表的 FK/索引重建、NOT NULL 改写等），已全部剔除——
 * 那些表结构与库内现状一致，禁止经本迁移改写。
 */
export class AddRoundtableRunnerAndSeat1786088437092 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "roundtable_runners" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(100) NOT NULL,
        "actor_id" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'offline',
        "version" character varying(30),
        "vendors" jsonb NOT NULL DEFAULT '[]',
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roundtable_runners" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_roundtable_runners_actor_id" ON "roundtable_runners" ("actor_id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "roundtable_seats" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "topic_id" uuid NOT NULL,
        "label" character varying(100) NOT NULL,
        "vendor" character varying(30) NOT NULL,
        "runner_id" uuid,
        "config" jsonb NOT NULL DEFAULT '{}',
        "state" jsonb NOT NULL DEFAULT '{}',
        "status" character varying(20) NOT NULL DEFAULT 'active',
        "coordinator" boolean NOT NULL DEFAULT false,
        "last_event_seq" bigint NOT NULL DEFAULT '0',
        "last_inject_seq" bigint NOT NULL DEFAULT '0',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roundtable_seats" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_roundtable_seats_topic_id" ON "roundtable_seats" ("topic_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_roundtable_seats_runner_id" ON "roundtable_seats" ("runner_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_roundtable_seats_runner_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_roundtable_seats_topic_id"`);
    await queryRunner.query(`DROP TABLE "roundtable_seats"`);
    await queryRunner.query(`DROP INDEX "public"."idx_roundtable_runners_actor_id"`);
    await queryRunner.query(`DROP TABLE "roundtable_runners"`);
  }
}
