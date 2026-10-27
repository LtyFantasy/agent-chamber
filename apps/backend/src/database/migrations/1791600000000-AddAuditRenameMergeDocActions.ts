import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 审计枚举补值：存量 tag rename/merge 与 category merge 的汇总审计动作
 *     （DocSpace 元数据治理 3 期，v1.92.0-dev）
 *
 * [代码职责]
 *   - 为 PG 原生枚举 `audit_action` 补 `rename_doc_tags` / `merge_doc_category`
 *     两个值；无表结构变更、无数据迁移。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（POST /doc-spaces/:id/tags/rename、
 *     POST /doc-categories/:id/merge 审计契约）
 *   - 补充: 线上 docs/spec.md §4「AuditAction」（两个新动作的语义与载荷）
 *
 * [关键不变量]
 *   - `audit_logs.action` 是 PG 原生枚举（audit-log.entity.ts enumName: 'audit_action'）
 *     ⇒ 缺值写入报 `invalid input value for enum audit_action` 500，且业务写已提交、
 *     审计断档——migration 必须先于服务端代码生效；
 *   - PG 12+ 允许事务内 ADD VALUE（新值提交后可用）；本 migration 不在同事务内插入
 *     新值行，与先例 1787045000000 一致；
 *   - `IF NOT EXISTS` 保证幂等（与 deploy.sh 防呆比对兼容）。
 *
 * [关联代码]
 *   - apps/backend/src/database/migrations/1787045000000-AddAuditMoveDocAction.ts —
 *     同款先例（ADD VALUE IF NOT EXISTS + 空 down + 头部注释）
 *   - apps/backend/src/modules/docspace/doc-rename.service.ts — 两个动作的唯一写入口
 *     （事务后 fail-open 各写一条汇总审计行）
 *   - packages/shared/src/enums/index.ts — AuditAction.RENAME_DOC_TAGS /
 *     MERGE_DOC_CATEGORY 单源
 *
 * [持久踩坑]
 *   - AUDIT-ENUM-GAP(audit_action 缺值): 新审计动作忘了配 migration 时，业务事务已提交
 *     但审计写入 500（fail-open 下表现为审计静默缺失，比 500 更难发现）。安全方向：
 *     新增 AuditAction 值一律随同一批 commit 带 migration。详情：本文件 + 1787045000000
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
export class AddAuditRenameMergeDocActions1791600000000 implements MigrationInterface {
  name = 'AddAuditRenameMergeDocActions1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'rename_doc_tags'`);
    await queryRunner.query(`ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'merge_doc_category'`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(_queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL 不支持 DROP enum value；多余值无运行时影响，有意留空（对齐先例 1787045000000）。
  }
}
