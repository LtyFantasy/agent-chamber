/**
 * [前端 Response] apps/web/src/types/index.ts (Activity interface)
 * [注意] 修改字段时需同步检查前端 Activity Response 类型
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ActorType } from '@agent-chamber/shared';
import { Task } from './task.entity';

@Entity('task_activities')
@Index(['taskId'])
export class TaskActivity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'task_id' })
  taskId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  action: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'field_name' })
  fieldName: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'old_value' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oldValue: any | null;

  @Column({ type: 'jsonb', nullable: true, name: 'new_value' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newValue: any | null;

  @Column({ type: 'jsonb', default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: Record<string, any>;

  @Column({ type: 'text', nullable: true })
  details: string | null;

  @Column({ type: 'uuid', nullable: false, name: 'actor_id' })
  actorId: string;

  /** 执行者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  actorType: ActorType;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => Task, (task) => task.activities, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;
}
