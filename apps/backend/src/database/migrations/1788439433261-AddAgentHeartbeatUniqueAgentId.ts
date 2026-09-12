import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * agent_heartbeats.agent_id 唯一化（plan plastic-man-wonder-man-raven.md §2，R4 钉死形态）
 *
 * 背景：heartbeat 写入语义 = 全列快照 upsert（`ON CONFLICT (agent_id) DO UPDATE`），
 * 唯一索引（agent_id）是 upsert 的冲突判定前提；此前实体 @Index(['agentId']) 为非唯一
 * （ActorUnification 迁移所建），表可以（且已经可以）存在多行同 agent 心跳。
 *
 * 形态（逐字钉死，禁偏差）：
 * 1. 前置 DO 审计块：存在重复 agent_id（COUNT>1）→ RAISE EXCEPTION 附明细，
 *    不裸信"生产零行"断言（前科：1788177829606 曾假设无死值行，实际撞 1 行 22P02）。
 *    审计失败整体回滚，绝不带着脏数据强建唯一索引。审计取 GROUP BY 首条重复组，
 *    明细给 agent_id + 行数；索引创建前只可能因真实脏数据失败，属预期失败路径。
 * 2. SET LOCAL lock_timeout = '5s'：唯一化需要对表加 ACCESS EXCLUSIVE 锁，
 *    长事务占锁时 5s 超时放弃而非无限排队（TypeORM 每个 migration 事务内生效）。
 * 3. DROP + CREATE UNIQUE **同名** IDX_f53c992915f2952916e0b73b03（TypeORM 自动命名，
 *    与 generate 产物一致；**禁 IF NOT EXISTS**——索引缺失时 DROP 报错即暴露
 *    环境与迁移序列不符，比静默跳过更安全）。
 * 4. down 恢复非唯一索引（幂等可逆，up→down→up 验证过）。
 *
 * 部署顺序安全：app.module.ts migrationsRun: true 保证索引先于服务就位
 * （服务上线前 upsert 已在唯一约束下运行）。
 */
export class AddAgentHeartbeatUniqueAgentId1788439433261 implements MigrationInterface {
  name = 'AddAgentHeartbeatUniqueAgentId1788439433261';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 前置审计：重复 agent_id 明细 RAISE EXCEPTION（R4；不裸信生产零行断言，
    //    参考 ActorUnification 迁移的 DO 审计块先例 1781364902335:121-128）
    await queryRunner.query(`
      DO $$
      DECLARE
        dup RECORD;
      BEGIN
        SELECT agent_id, COUNT(*) AS cnt
          INTO dup
          FROM "agent_heartbeats"
         GROUP BY agent_id
        HAVING COUNT(*) > 1
         LIMIT 1;
        IF dup.agent_id IS NOT NULL THEN
          RAISE EXCEPTION
            'agent_heartbeats 存在重复 agent_id (%)，共 % 行：唯一索引无法创建，须先合并去重（保留最新一拍快照行）',
            dup.agent_id, dup.cnt;
        END IF;
      END $$;
    `);
    // 2. 唯一化锁 5s 超时（长事务占表锁时放弃而非无限排队）
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    // 3. 同名重建唯一索引（禁 IF NOT EXISTS：环境漂移时 DROP 报错即暴露）
    await queryRunner.query(`DROP INDEX "public"."IDX_f53c992915f2952916e0b73b03"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_f53c992915f2952916e0b73b03" ON "agent_heartbeats" ("agent_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 恢复非唯一索引（可逆；重复 agent_id 的写入路径在 revert 后重新放开，属预期）
    await queryRunner.query(`DROP INDEX "public"."IDX_f53c992915f2952916e0b73b03"`);
    await queryRunner.query(`CREATE INDEX "IDX_f53c992915f2952916e0b73b03" ON "agent_heartbeats" ("agent_id") `);
  }
}
