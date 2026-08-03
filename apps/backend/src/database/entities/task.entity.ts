/**
 * [前端 Response] apps/web/src/types/index.ts (TaskSummary / TaskDetail interface)
 * [注意] 修改字段时需同步检查前端 Task Response 类型
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
import { TaskStatus, Priority, ActorType } from '@agent-chamber/shared';
import { BoardList } from './board-list.entity';
import { TaskComment } from './task-comment.entity';
import { TaskActivity } from './task-activity.entity';
import { TaskDependency } from './task-dependency.entity';
import { Milestone } from './milestone.entity';

@Entity('tasks')
@Index(['listId'])
@Index(['assigneeId'])
@Index(['status'])
@Index(['priority'])
@Index(['parentId'])
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'list_id' })
  listId: string;

  /** 关联话题 ID，已从数据库列转为内存字段，由 Service 经 list→board 派生填充 */
  topicId: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'parent_id' })
  parentId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: false })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 20, default: 'markdown', name: 'description_format' })
  descriptionFormat: string;

  @Column({
    type: 'enum',
    enum: TaskStatus,
    enumName: 'task_status',
    default: TaskStatus.BACKLOG,
  })
  status: TaskStatus;

  @Column({
    type: 'enum',
    enum: Priority,
    enumName: 'priority',
    default: Priority.P2,
  })
  priority: Priority;

  @Column({ type: 'uuid', nullable: true, name: 'assignee_id' })
  assigneeId: string | null;

  /** 负责人类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  assigneeType: ActorType | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'due_date' })
  dueDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'started_at' })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt: Date | null;

  @Column({ type: 'text', array: true, nullable: true })
  labels: string[] | null;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'jsonb', default: {}, name: 'custom_fields' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customFields: Record<string, any>;

  @Column({ type: 'uuid', nullable: true, name: 'milestone_id' })
  milestoneId: string | null;

  @ManyToOne(() => Milestone, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'milestone_id' })
  milestone: Milestone | null;

  @Column({ type: 'tsvector', nullable: true, name: 'search_vector', select: false })
  searchVector: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  @ManyToOne(() => BoardList, (list) => list.tasks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'list_id' })
  list: BoardList;

  @ManyToOne(() => Task, (task) => task.subtasks, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Task | null;

  @OneToMany(() => Task, (task) => task.parent)
  subtasks: Task[];

  @OneToMany(() => TaskComment, (comment) => comment.task)
  comments: TaskComment[];

  @OneToMany(() => TaskActivity, (activity) => activity.task)
  activities: TaskActivity[];

  @OneToMany(() => TaskDependency, (dep) => dep.task)
  dependencies: TaskDependency[];

  @OneToMany(() => TaskDependency, (dep) => dep.dependsOnTask)
  dependents: TaskDependency[];
}
