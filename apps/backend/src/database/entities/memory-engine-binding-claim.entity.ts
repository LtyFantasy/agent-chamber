/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 引擎身份**永久占用表**：`(engine, workspaceId, actorId, credentialRef)`
 *     一旦被某个项目使用，就永久归该项目所有（Hument Usage 的隔离前提）
 *
 * [代码职责]
 *   - `memory_engine_binding_claims` 逐列定义（四列 NOT NULL + 首次占用时间 + 归属项目）
 *   - 表级 CHECK（`engine <> 'none'`）与四列单条唯一索引由 migration 裸 SQL 建立，
 *     **实体刻意不声明 `@Index`**（同 `memory-project.entity.ts` 先例：裸 SQL 产物是唯一
 *     索引事实源，实体补装饰器只会制造第二份事实与 `IDX_<hash>` 命名差噪声）
 *
 * [权威文档]
 *   - 主文档: 会话计划 `constantine-pantha-lockjaw.md` §2.3（fail-closed 引擎身份占用）/
 *     §3.4.1（判别性测试）
 *   - 补充: 线上 DocSpace `docs/database.md` — Memory 表结构与 migration 约定
 *
 * [关键不变量]
 *   - **永久占用，永不释放**：改绑 / 清空 / 归档 / 软删 / 项目硬删都**不**删除本行；
 *     同一项目重发同一三元组是幂等（`INSERT … ON CONFLICT DO NOTHING` 后回读归属），
 *     不同项目命中同一三元组一律 409。历史占用只能走 Owner 批准的审计化手工 SQL。
 *   - **四列都参与唯一键**：不塞 jsonb（jsonb 整列等值永不命中，铁律 #23）；
 *     唯一索引是并发仲裁者，服务层回读只负责把冲突翻译成可行动的 409。
 *   - **`project_id` 刻意无 FK**：项目硬删后 claim 必须保留（否则删项目 = 释放身份，
 *     构成跨项目冒领漏洞）。因此本表可能引用一个已不存在的项目 id，这是**预期状态**。
 *   - **只记录完整非 `none` 三元组**：`engine='none'` / 任一列为空都不写（DDL 的
 *     `engine <> 'none'` + 四列 NOT NULL 是第二道闸门）。
 *   - `first_claimed_at` 是**首次**占用时间：`ON CONFLICT DO NOTHING` 保证重放/重跑
 *     不会覆盖它（排障时据此判断"谁先占的"）。
 *
 * [关联代码]
 *   - database/migrations/1792400000000-AddMemoryEngineBindingClaims.ts — 建表 + CHECK +
 *     四列唯一索引 + 全量 withDeleted 回填（确定性 winner：active > archived > soft-deleted）
 *   - database/entities/index.ts — barrel 注册（运行时 `typeorm-options.ts` 用 barrel 装配）
 *   - modules/memory/memory-project.service.ts — 创建/改绑事务内写 claim 并回读归属
 *   - test/memory-schema.e2e-spec.ts — 列 / NOT NULL / CHECK / 四列唯一索引守卫
 *   - test/memory-engine-binding-claims.e2e-spec.ts — 回填 winner、重跑幂等、并发 409
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { MemoryEngine } from '@agent-chamber/shared';

/**
 * 引擎身份占用行（永久；见文件头不变量）。
 *
 * 一行 = 一个从未释放的 `(engine, workspace, actor, credentialRef)` 三元组及其归属项目。
 */
@Entity('memory_engine_binding_claims')
export class MemoryEngineBindingClaim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 引擎名（值域单源 = shared `MEMORY_ENGINES`；DDL 层禁止 `none`） */
  @Column({ type: 'varchar', length: 16, nullable: false })
  engine: MemoryEngine;

  /** 引擎侧 workspace（标识符只校验不改写；写入前已过字符集闸门） */
  @Column({ type: 'varchar', length: 128, nullable: false, name: 'engine_workspace_id' })
  engineWorkspaceId: string;

  /** 引擎侧 actor */
  @Column({ type: 'varchar', length: 128, nullable: false, name: 'engine_actor_id' })
  engineActorId: string;

  /** 引擎凭据**引用名**（非机密；真凭据在引擎侧/环境） */
  @Column({ type: 'varchar', length: 128, nullable: false, name: 'engine_credential_ref' })
  engineCredentialRef: string;

  /**
   * 归属项目 id。
   *
   * ⚠️ **无 FK**：项目硬删后本行必须保留（见文件头不变量）；不要"顺手"补 FK。
   */
  @Column({ type: 'uuid', nullable: false, name: 'project_id' })
  projectId: string;

  /**
   * 首次占用时间（回填时取**同四列全部项目**的 `MIN(created_at)`，owner 仍按 winner）。
   *
   * `ON CONFLICT DO NOTHING` 保证重放/重跑不覆盖该值。
   */
  @CreateDateColumn({ type: 'timestamptz', name: 'first_claimed_at' })
  firstClaimedAt: Date;
}
