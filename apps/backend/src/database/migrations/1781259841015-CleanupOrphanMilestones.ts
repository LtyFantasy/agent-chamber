/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/database.md §1.3 数据库迁移规范
 *   - 补充: .kimi/plans/cyclone-rocket-monet.md §4 Stage 4 清理孤立 Milestone
 *
 * [踩坑索引] B-50(孤立 milestone 清理)
 *
 * [铁律关联] #6(数据库兼容) #11(注释强制) #7(编译优先)
 *
 * [详细踩坑]（最多 5 条）
 *   B-50: 生产环境存在 topic_id IS NULL 的孤立 milestone，权限过滤后可能被
 *         非授权 actor 访问或产生脏数据。修复：本 migration 在部署时先解绑
 *         关联 task 的 milestone_id，再删除孤立 milestone，确保数据干净。
 *         见 Plan §4。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 清理 topic_id 为 NULL 的孤立 milestone
 *
 * 执行顺序（幂等，可重复执行）：
 * 1. 将引用这些孤立 milestone 的 task.milestone_id 置为 NULL
 * 2. 删除 topic_id IS NULL 的 milestone 记录
 *
 * 注意：本迁移仅清理历史脏数据，不修改表结构；后续业务代码不再允许创建
 * topic_id 为 NULL 的 milestone。
 */
export class CleanupOrphanMilestones1781259841015 implements MigrationInterface {
  name = 'CleanupOrphanMilestones1781259841015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: 解绑关联任务，避免外键约束导致删除失败
    // 即使 DB 层面已配置 ON DELETE SET NULL，显式置空更清晰、幂等且可审计
    await queryRunner.query(`
      UPDATE tasks
      SET milestone_id = NULL
      WHERE milestone_id IN (
        SELECT id FROM milestones WHERE topic_id IS NULL
      )
    `);

    // Step 2: 删除所有 topic_id 为 NULL 的孤立 milestone
    await queryRunner.query(`
      DELETE FROM milestones
      WHERE topic_id IS NULL
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // 数据清理类迁移不可逆：已被删除的孤立 milestone 无法恢复，
    // 且业务上已不再允许创建 topic_id 为 NULL 的 milestone。
    // 若需回滚，请依赖部署前备份恢复。
  }
}
