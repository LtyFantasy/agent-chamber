import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { EventType, ActorType } from '@agent-chamber/shared';

@Entity('events')
@Index(['cursor'])
@Index(['resourceType', 'resourceId'])
@Index(['eventType', 'createdAt'])
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: EventType,
    enumName: 'event_type',
    name: 'event_type',
  })
  eventType: EventType;

  @Column({ type: 'varchar', length: 50, nullable: false, name: 'resource_type' })
  resourceType: string;

  @Column({ type: 'uuid', nullable: false, name: 'resource_id' })
  resourceId: string;

  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actorId: string | null;

  /** 执行者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  actorType: ActorType | null;

  @Column({ type: 'uuid', nullable: true, name: 'topic_id' })
  topicId: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'board_id' })
  boardId: string | null;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;

  /**
   * 事件游标：**DB 序列 `seq_events_cursor` 产出的不透明单调序列号**（bigint 数字字符串）。
   *
   * ① **RETURNING 耦合（删本 default 会静默退化）**：本 default 是 `saved.cursor` 取到值的
   *    **唯一来源**——TypeORM 的 `getInsertionReturningColumns` 只把 `default !== undefined`
   *    的列放进 INSERT ... RETURNING；删掉它 ⇒ `saved.cursor === undefined` ⇒ SSE 载荷
   *    变成 `cursor: undefined`（推送契约破裂且无任何报错）。
   * ② **default 只用于元数据比对**：裸形态（`nextval('seq_events_cursor')`，**不带**
   *    `::regclass`）与 DB 侧 `column_default` 在 TypeORM 剥掉 cast 后逐字相等 ⇒ 漂移门禁
   *    零新增（机制见 `PostgresDriver.defaultEqual` + `PostgresQueryRunner` 的列加载分支）。
   *    由此 **禁止** `migration:generate` / `synchronize` 改本列——DDL 侧会把函数 default
   *    字符串化，产出与库内形态不一致的 DDL。
   * ③ **序列名不得改成 `events_cursor_seq`**：那是 TypeORM serial 启发式约定名
   *    （`${table}_${column}_seq`）也是本列 BIGSERIAL 时代的历史隐式名——撞名会让列被误判
   *    `isGenerated=increment`，门禁产出 `DROP DEFAULT` + `DROP SEQUENCE`。
   *    迁移头注（`1792000000000-CreateEventsCursorSequence.ts`）有完整论述。
   */
  @Column({ type: 'bigint', name: 'cursor', default: () => "nextval('seq_events_cursor')" })
  cursor: string;

  @Column({ type: 'boolean', default: false })
  delivered: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'delivered_at' })
  deliveredAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
