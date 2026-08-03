/**
 * [前端 Response] apps/web/src/types/index.ts (BoardList interface)
 * [注意] 修改字段时需同步检查前端 BoardList Response 类型
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { TaskStatus } from '@agent-chamber/shared';
import { Board } from './board.entity';
import { Task } from './task.entity';

@Entity('board_lists')
@Index(['boardId'])
@Index('idx_board_list_mapped_status_unique', ['boardId', 'mappedStatus'], {
  unique: true,
  where: 'mapped_status IS NOT NULL AND deleted_at IS NULL',
})
export class BoardList {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'board_id' })
  boardId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'int', nullable: true, name: 'wip_limit' })
  wipLimit: number | null;

  @Column({
    type: 'enum',
    enum: TaskStatus,
    enumName: 'task_status',
    nullable: true,
    name: 'mapped_status',
  })
  /**
   * 列与任务状态的智能映射。
   * - 同一 Board 下，每个 mappedStatus 值只能被一个列绑定（互斥）
   * - move 到该列时，任务状态自动同步为 mappedStatus
   * - PATCH status 时，任务自动吸附到对应 mappedStatus 的列
   * - null 表示该列不绑定任何状态
   *
   * 唯一性由数据库部分索引保证：
   * CREATE UNIQUE INDEX ... ON board_lists(board_id, mapped_status)
   * WHERE mapped_status IS NOT NULL AND deleted_at IS NULL
   */
  mappedStatus: TaskStatus | null;

  @Column({ type: 'varchar', length: 7, default: '#e5e7eb' })
  color: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  @ManyToOne(() => Board, (board) => board.lists, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'board_id' })
  board: Board;

  @OneToMany(() => Task, (task) => task.list)
  tasks: Task[];
}
