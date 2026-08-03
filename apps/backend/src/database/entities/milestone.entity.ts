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
