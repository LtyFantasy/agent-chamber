import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * topic_participants.joined_at 语义修复（v1.40）
 *
 * 背景：joined_at 原是 @CreateDateColumn（NOT NULL + DB DEFAULT NOW()），
 * 导致 invited 行插入时写入"邀请时间"而非"激活时间"；sendMessage 的
 * TypeORM upsert DO UPDATE 还会把 joined_at 刷成每条消息的时间。
 *
 * 目标语义：joined_at = 最近一次实际激活（加入）时间；invited 行为 NULL；
 * left→re-join 时刷新为本次激活时间。
 *
 * 变更：
 * 1. DROP DEFAULT —— 关键：DB 默认 NOW() 会兜底使应用层的 NULL 写入失效
 * 2. DROP NOT NULL —— invited 行允许 NULL
 * 3. 数据清洗：invited 行 joined_at 置 NULL（不可逆：历史"邀请时间"信息丢失，
 *    但该信息本就是语义 bug 的产物，无保留价值；active 行保持原值）
 * 4. CHECK 不变量 (status != 'active' OR joined_at IS NOT NULL) —— 防未来
 *    回归（任何 active 行漏写 joinedAt 都会在 DB 层被拒绝）；先清洗再加约束，
 *    确保现有数据满足表达式
 */
export class TopicParticipantJoinedAtSemantics1785772198175 implements MigrationInterface {
  name = 'TopicParticipantJoinedAtSemantics1785772198175';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // joined_at 可空化：先 DROP DEFAULT 再 DROP NOT NULL
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ALTER COLUMN "joined_at" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ALTER COLUMN "joined_at" DROP NOT NULL`,
    );
    // 数据清洗：invited 行的 joined_at 是"邀请时间"（语义 bug 产物），置 NULL
    await queryRunner.query(
      `UPDATE "topic_participants" SET "joined_at" = NULL WHERE "status" = 'invited'`,
    );
    // DB 级不变量：active 行必须有 joined_at（防未来回归）
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ADD CONSTRAINT "chk_tp_active_has_joined_at" CHECK (status != 'active' OR joined_at IS NOT NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topic_participants" DROP CONSTRAINT "chk_tp_active_has_joined_at"`,
    );
    // 近似恢复：NULL 回填 now()（精确恢复不可能——原值已不可逆清洗；
    // 回填的 now() 代表"迁移时点"，语义上近似原 DEFAULT 行为）
    await queryRunner.query(
      `UPDATE "topic_participants" SET "joined_at" = now() WHERE "joined_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ALTER COLUMN "joined_at" SET DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ALTER COLUMN "joined_at" SET NOT NULL`,
    );
  }
}
