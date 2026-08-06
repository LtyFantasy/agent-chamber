import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * doc_routes.health jsonb 加列迁移（v1.42 批次 C1：doc_routes 异步健康校验）
 *
 * 设计要点：
 * - 纯加法：仅新增一列，不影响任何存量表/数据，符合迁移兼容铁律
 * - 形状：{ issues: [{kind:'heading'|'codeEntry', target:'primary'|'secondary'|'codeEntry', value}],
 *   checkedAt: ISO }——空 issues = 健康；NULL = 尚未检查（对齐 link_health「无数据 ≠ 零断链」语义）
 * - 写入方：route-health.service.recheckSpace（三触发点：upsert 内容变更 / remove / 手动 recheck 端点）
 * - 存量行 health 全为 NULL（未检），由部署后手动 recheck 首跑兜底（plan §10 风险边界明文）
 *
 * down() 仅 DROP 列（新增列无存量数据依赖，可安全逆序）。
 */
export class AddDocRouteHealth1785975720000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE doc_routes ADD COLUMN health jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE doc_routes DROP COLUMN health`);
  }
}
