import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAuditMoveDocAction — 为 PG 枚举 audit_action 补充 move_doc 值（v1.60.0-dev 原子 move）。
 *
 * 背景：shared AuditAction 新增 MOVE_DOC（move_doc 端点事务后写审计日志），但
 * audit_logs.action 是 PostgreSQL 原生 enum 列（audit-log.entity.ts enumName:
 * 'audit_action'），必须 ALTER TYPE 补值，否则写入报
 * `invalid input value for enum audit_action: "move_doc"`（500，且 move 已改 path
 * 但响应失败——审计断档）。1787043711624-AddDocMovedEventType 只补了 event_type，
 * 本 migration 补齐 audit_action 侧（plan venom-longshot-ragman.md P1-1 审计要求）。
 *
 * 说明：
 * - PG 12+ 允许在事务内 ADD VALUE，新值在提交后即可使用（本 migration 不在同事务内插入新值行）。
 * - IF NOT EXISTS 保证幂等（与 deploy.sh 防呆比对兼容）。
 * - down() 为空：PostgreSQL 不支持删除枚举值（需重建类型+全表转换，风险远大于收益），
 *   多余的枚举值无害，注释留档。对齐先例 1787043711624-AddDocMovedEventType.ts。
 */
export class AddAuditMoveDocAction1787045000000 implements MigrationInterface {
  name = 'AddAuditMoveDocAction1787045000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'move_doc'`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL 不支持 DROP enum value；多余值无运行时影响，有意留空。
  }
}