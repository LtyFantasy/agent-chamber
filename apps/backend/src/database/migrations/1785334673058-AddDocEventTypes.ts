import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddDocEventTypes — 为 PG 枚举 event_type 补充 DocSpace 文档事件值。
 *
 * 背景：W4 在 shared EventType 枚举新增 DOC_CREATED/DOC_UPDATED/DOC_DELETED，
 * 但 events.event_type 是 PostgreSQL 原生 enum 列，必须 ALTER TYPE 补值，
 * 否则运行时报 `invalid input value for enum event_type: "doc_created"`（500）。
 *
 * 说明：
 * - PG 12+ 允许在事务内 ADD VALUE，新值在提交后即可使用（本 migration 不在同事务内插入新值行）。
 * - IF NOT EXISTS 保证幂等（与 deploy.sh 防呆比对兼容）。
 * - down() 为空：PostgreSQL 不支持删除枚举值（需重建类型+全表转换，风险远大于收益），
 *   多余的枚举值无害，注释留档。
 */
export class AddDocEventTypes1785334673058 implements MigrationInterface {
  name = 'AddDocEventTypes1785334673058';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'doc_created'`);
    await queryRunner.query(`ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'doc_updated'`);
    await queryRunner.query(`ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'doc_deleted'`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL 不支持 DROP enum value；多余值无运行时影响，有意留空。
  }
}
