import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 圆桌审批请求表迁移（M3 阶段 1，见 docs/roundtable-design.md §5/§9）
 *
 * 设计要点：
 * - 纯新表 roundtable_permission_requests，零存量改写，回滚 = 只 drop 表 + 索引
 * - 一行 = 一个 agent（座位）挂起的审批请求（契约① permission_request 上行落库）：
 *   request_id = runner 侧请求 ID（ACP JSON-RPC id，协议校验非空字符串）；
 *   tool / options jsonb 原样存 ToolBrief / PermissionOption[]（展示 + 裁决校验源）
 * - status 用 varchar（对齐项目惯例，非 PG enum）：pending（等待裁决）/ approved /
 *   rejected / orphaned（runner 断连作废，M3 阶段 1 孤儿处理）
 * - verdict_option_id / resolved_by / resolved_at 均为裁决时写入（resolved_by 裸 uuid，
 *   对齐 actors 惯例不建物理 FK）；orphaned 只写 resolved_at 不写 resolved_by
 *   （作废非人类裁决）
 * - 不建 DB 级物理 FK（D-B1-2 惯例：裸 uuid + 索引，仅 TypeORM 导航）
 * - 索引三枚：查询面 = 按 topic 查 + 按 seat 查（均复合 status 过滤 pending）；
 *   request_id 单列索引 = 重放/对账按请求 ID 幂等去重
 *
 * ⚠️ 本文件为人工手写，禁止用 typeorm migration:generate 生成——存量表有元数据漂移
 * 噪音债（同 AddRoundtableRunnerAndSeat / AddTopicKind 头部注释）。
 */
export class AddRoundtablePermissionRequests1786162338376 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "roundtable_permission_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "request_id" character varying(100) NOT NULL,
        "seat_id" uuid NOT NULL,
        "topic_id" uuid NOT NULL,
        "tool" jsonb NOT NULL DEFAULT '{}',
        "options" jsonb NOT NULL DEFAULT '[]',
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "verdict_option_id" character varying(100),
        "resolved_by" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_roundtable_permission_requests" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_roundtable_perm_reqs_topic_status" ON "roundtable_permission_requests" ("topic_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_roundtable_perm_reqs_seat_status" ON "roundtable_permission_requests" ("seat_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_roundtable_perm_reqs_request_id" ON "roundtable_permission_requests" ("request_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_roundtable_perm_reqs_request_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_roundtable_perm_reqs_seat_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_roundtable_perm_reqs_topic_status"`);
    await queryRunner.query(`DROP TABLE "roundtable_permission_requests"`);
  }
}
