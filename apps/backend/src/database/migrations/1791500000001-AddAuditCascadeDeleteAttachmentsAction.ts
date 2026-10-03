import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAuditCascadeDeleteAttachmentsAction1791500000001 — 为 PG 枚举 audit_action 补充
 * `cascade_delete_attachments` 值（v1.90.0-dev 附件 TTL 批）。
 *
 * 背景：`TopicService.remove()` 连带软删 topic 全部附件后写一条汇总 audit
 * （shared `AuditAction.CASCADE_DELETE_ATTACHMENTS`），而 `audit_logs.action` 是
 * PostgreSQL 原生 enum 列（audit-log.entity.ts enumName: 'audit_action'），必须
 * ALTER TYPE 补值，否则写入报 `invalid input value for enum audit_action` 500
 * （topic 已软删、附件已连带软删，审计却断档）。1789205400000-AddAuditMintAttachmentUrlAction
 * 同款先例。
 *
 * 说明：
 * - PG 12+ 允许事务内 ADD VALUE，新值提交后即可使用（本 migration 不在同事务内插入新值行）；
 * - IF NOT EXISTS 保证幂等（deploy.sh 防呆比对兼容）；
 * - catalog-only 级变更（枚举加值不重写 audit_logs 表），秒级完成，无锁风险；
 * - down() 为空：PostgreSQL 不支持删除枚举值（需重建类型+全表转换，风险远大于收益），
 *   多余枚举值无害，注释留档（对齐先例 1787045000000-AddAuditMoveDocAction.ts）。
 */
export class AddAuditCascadeDeleteAttachmentsAction1791500000001 implements MigrationInterface {
  name = 'AddAuditCascadeDeleteAttachmentsAction1791500000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'cascade_delete_attachments'`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL 不支持 DROP enum value；多余值无运行时影响，有意留空。
  }
}
