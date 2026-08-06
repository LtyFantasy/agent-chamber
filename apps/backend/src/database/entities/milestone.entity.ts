/**
 * [前端 Response] apps/web/src/types/index.ts (Milestone interface)
 * [注意] 修改字段时需同步检查前端 Milestone Response 类型
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { Task } from './task.entity';
import { Board } from './board.entity';
import { MilestoneStatus } from '@agent-chamber/shared';

@Entity('milestones')
@Index(['boardId'])
@Index('idx_milestones_creator_id', ['creatorId'])
export class Milestone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200, nullable: false })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 所属看板 ID（Batch 1: 从 topic_id 迁移；DB 级无 FK 约束，对齐项目惯例 D-B1-2） */
  @Column({ type: 'uuid', nullable: false, name: 'board_id' })
  boardId: string;

  @Column({
    type: 'enum',
    enum: MilestoneStatus,
    default: MilestoneStatus.PLANNED,
    name: 'status',
  })
  status: MilestoneStatus;

  @Column({ type: 'timestamptz', nullable: true, name: 'start_date' })
  startDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'target_date' })
  targetDate: Date | null;

  /**
   * 里程碑创建者的 Actor ID（human/agent 通用，Actor 统一后跨身份不建物理 FK，与
   * task.assigneeId 同惯例：裸 uuid + 索引）。
   * nullable：历史 milestone 该列为 NULL，update/remove 权限退化为「仅 topic 创建者/admin」，
   * 与方案 B 行为一致、向后兼容；新建 milestone 由 MilestoneService.create 写入 actor.id。
   */
  @Column({ type: 'uuid', nullable: true, name: 'creator_id' })
  creatorId: string | null;

  /**
   * Release 版本号（varchar 50）。null = 普通里程碑（status 限普通四态）；
   * 非空 = Release 里程碑（status 走 dev→ready→deployed→verified 生命周期）。
   * 同 board 内唯一：部分唯一索引 uq_milestones_board_version (board_id, version)
   * WHERE version IS NOT NULL，冲突 23505 → 409 MILESTONE_VERSION_CONFLICT。
   */
  @Column({ type: 'varchar', length: 50, nullable: true })
  version: string | null;

  /**
   * Release 变更说明（Markdown 全文；text 不受 200 上限约束，DTO @MaxLength(20000)）。
   * 列表接口投影为 bodySnippet(300)，详情接口全量返回。
   */
  @Column({ type: 'text', nullable: true })
  body: string | null;

  /**
   * 部署元数据（jsonb：anchors/backup/migrations 等一次性机器写入）。
   * 只经 POST /tasks/milestones/:id/deployed 合并写入（热修重部署幂等覆盖），
   * 不可经 create/update DTO 写入（whitelist 拦截）。列表接口不返回该字段。
   */
  @Column({ type: 'jsonb', nullable: true, name: 'deploy_meta' })
  deployMeta: Record<string, unknown> | null;

  /** 最近一次部署时间（deployed 端点写入：payload.deployedAt 优先，缺省 now） */
  @Column({ type: 'timestamptz', nullable: true, name: 'deployed_at' })
  deployedAt: Date | null;

  /** 验收时间（PATCH status=verified 时由 Service 写入，不变量：verified ⇔ verifiedAt 非空） */
  @Column({ type: 'timestamptz', nullable: true, name: 'verified_at' })
  verifiedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /** ORM 导航关系（D-B1-2: 不加 DB 级 FK，仅作 TypeORM 导航用） */
  @ManyToOne(() => Board, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'board_id' })
  board: Board;

  @OneToMany(() => Task, (task) => task.milestone)
  tasks: Task[];
}
