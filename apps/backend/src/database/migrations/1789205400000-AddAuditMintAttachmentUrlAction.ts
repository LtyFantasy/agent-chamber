import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAuditMintAttachmentUrlAction — 为 PG 枚举 audit_action 补充 mint_attachment_url
 * 值（v1.75.0-dev，P2 批 2 附件短时签名 URL 铸造审计）。
 *
 * 背景：shared AuditAction 新增 MINT_ATTACHMENT_URL（`POST /attachments/:id/signed-url`
 * 铸造成功即写审计行），但 audit_logs.action 是 PostgreSQL 原生 enum 列
 * （audit-log.entity.ts enumName: 'audit_action'），必须 ALTER TYPE 补值，否则写入报
 * `invalid input value for enum audit_action: "mint_attachment_url"`（500——铸造本身
 * 已签出 token，响应却失败；审计断档）。1787045000000-AddAuditMoveDocAction 同款先例。
 *
 * 说明：
 * - PG 12+ 允许在事务内 ADD VALUE，新值在提交后即可使用（本 migration 不在同事务内插入新值行）。
 * - IF NOT EXISTS 保证幂等（与 deploy.sh 防呆比对兼容）。
 * - catalog-only 级变更（枚举加值不重写 audit_logs 表），秒级完成，无锁风险。
 * - down() 为空：PostgreSQL 不支持删除枚举值（需重建类型+全表转换，风险远大于收益），
 *   多余的枚举值无害，注释留档。对齐先例 1787045000000-AddAuditMoveDocAction.ts。
 */
export class AddAuditMintAttachmentUrlAction1789205400000 implements MigrationInterface {
  name = 'AddAuditMintAttachmentUrlAction1789205400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'mint_attachment_url'`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL 不支持 DROP enum value；多余值无运行时影响，有意留空。
  }
}
