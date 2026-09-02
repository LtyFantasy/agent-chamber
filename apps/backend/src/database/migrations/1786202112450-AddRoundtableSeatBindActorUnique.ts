import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 圆桌座位「一 agent 一 topic 一 active 座位」唯一约束（r17 拍板，docs/roundtable-design.md §12）
 *
 * 背景：r17 身份粒度定稿——一个 agent ≈ 一个 workspace 身份，「同 actor 同桌多座位」方案
 * 废除；一个 agent 在一张 topic 里只能有一个 active 座位（removed 软删豁免：移除后可重建）。
 *
 * 落地方式：部分唯一索引（partial unique index），列 = (topic_id, config->>'bindActorId')，
 * 条件 WHERE status != 'removed'。
 * - bindActorId 存于 config jsonb（设计 §5 静态配置分列），表达式索引按文本提取等值判定
 * - status != 'removed' 使索引只约束 active/paused/parked/offline 座位；软删（M3 阶段 3
 *   座位移除）后行被排除在索引外，同 actor 可重新建座——与 createSeat 业务校验同语义
 * - ⚠️ bindActorId 是可选键（config 无该键 → 表达式为 NULL）：PostgreSQL 唯一索引中
 *   NULL 互不相等，缺省 bindActorId 的行不会互相冲突，也不会与有值的行冲突——可接受
 *   行为（createSeat 实际流程中 agent 缺省绑自己、人类缺省 400，业务侧无缺省行，
 *   此豁免仅兜底存量/异常数据）
 *
 * 冲突处理：createSeat 先做业务存在性检查抛 409（ErrorCode.ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT
 * = 11002，Service 翻译）；本索引是并发兜底——业务检查非原子，并发双建仍可能触发 23505，
 * Service 层同样翻译为 409（铁律 #9 禁止 23505 透传成 500），见 roundtable.service.ts
 * translateBindActorConflict。
 *
 * ⚠️ 本文件为人工手写：migration:generate 产物会混入存量表元数据漂移噪音（项目铁律，
 * 与 AddRoundtableRunnerAndSeat 同规），仅建/删一个部分唯一索引，零存量数据改写。
 */
export class AddRoundtableSeatBindActorUnique1786202112450 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_roundtable_seats_topic_bind_actor" ON "roundtable_seats" ("topic_id", ((config->>'bindActorId'))) WHERE status != 'removed'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uq_roundtable_seats_topic_bind_actor"`);
  }
}
