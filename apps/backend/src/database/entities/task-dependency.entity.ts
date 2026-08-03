import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { TaskDependencyType } from '@agent-chamber/shared';
import { Task } from './task.entity';

@Entity('task_dependencies')
@Index(['taskId', 'dependsOnTaskId'], { unique: true })
@Index(['dependsOnTaskId'])
export class TaskDependency {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'task_id' })
  taskId: string;

  @Column({ type: 'uuid', nullable: false, name: 'depends_on_task_id' })
  dependsOnTaskId: string;

  @Column({
    type: 'enum',
    enum: TaskDependencyType,
    default: TaskDependencyType.BLOCKS,
    name: 'dependency_type',
  })
  type: TaskDependencyType;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => Task, (task) => task.dependencies, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @ManyToOne(() => Task, (task) => task.dependents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'depends_on_task_id' })
  dependsOnTask: Task;
}
