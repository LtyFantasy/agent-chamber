import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddDocMovedEventType — 为 PG 枚举 event_type 补充 doc_moved 值（v1.60.0-dev 原子 move）。
 *
 * 背景：shared EventType 新增 DOC_MOVED（move_doc 端点发射），但 events.event_type
 * 是 PostgreSQL 原生 enum 列，必须 ALTER TYPE 补值，否则运行时报
 * `invalid input value for enum event_type: "doc_moved"`（500）。
 *
 * 说明：
 * - PG 12+ 允许在事务内 ADD VALUE，新值在提交后即可使用（本 migration 不在同事务内插入新值行）。
 * - IF NOT EXISTS 保证幂等（与 deploy.sh 防呆比对兼容）。
 * - down() 为空：PostgreSQL 不支持删除枚举值（需重建类型+全表转换，风险远大于收益），
 *   多余的枚举值无害，注释留档。对齐先例 1785334673058-AddDocEventTypes.ts。
 */
export class AddDocMovedEventType1787043711624 implements MigrationInterface {
  name = 'AddDocMovedEventType1787043711624';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'doc_moved'`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL 不支持 DROP enum value；多余值无运行时影响，有意留空。
  }
}