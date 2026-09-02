/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §5 (数据模型) + §6 (会话层规则/座位管理)
 *   - 补充: docs/roundtable-design.md §7 (seatLabel 身份模型, runner_id 绑定)
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
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
} from 'typeorm';
import { SEAT_LIFECYCLE_STATUS } from '@agent-chamber/shared';
import { Topic } from './topic.entity';
import { RoundtableRunner } from './roundtable-runner.entity';

/**
 * 圆桌座位表（`roundtable_seats`，M1 提前落地的两表之一，见设计 §5/§9）
 *
 * 一行 = 圆桌 topic 中的一个座位（一个座位 = 一个运行时会话，单线程串行，契约①）。
 * 设计要点：
 * - config / state 分列（M1 自审补，设计 §5）：config jsonb 只存静态配置
 *   （permissionMode/model/cwd/bindActorId/攒批窗口覆盖/预算上限/上下文水位阈值），
 *   由座位管理操作整体替换；state jsonb DEFAULT '{}' 存运行时状态
 *   （recentInjects ring buffer / lastUsage），由注入管线独占写——分列避免
 *   read-modify-write 竞争互相覆盖
 * - last_event_seq / last_inject_seq = 双向对账游标（设计 §4 可靠性）：seat.event
 *   上行与 seat.inject 下行各自独立递增编号，hello 对账后按缺口重放
 * - runner_id nullable：未绑 = 离线座位（座位已创建、等待 runner 认领）
 * - status 用 varchar 而非 PG enum（对齐 actors.status 惯例）：active / paused /
 *   parked / offline / removed（座位管理操作 M3 落地，M1 只落 active；removed 为
 *   M3 阶段 3 座位移除软删值，值域单源 SEAT_LIFECYCLE_STATUSES，见 shared enums）
 * - coordinator = 主脑座位标记（设计 §6，M3 只做标记/标识/公告）
 * - 座位发言落 messages 表（metadata.seatLabel 标记子身份），本表不动消息结构
 */
@Entity('roundtable_seats')
// 部分唯一索引（对齐 AddRoundtableSeatBindActorUnique migration 手写定义，r17 拍板：
// 一 agent 一 topic 一 active 座位，WHERE status != 'removed' 豁免软删）。
// ⚠️ DB 实际为表达式索引 (topic_id, config->>'bindActorId')，TypeORM 无法声明表达式列
// 且加载时表达式列丢失（attnum=0 不参与列集合比对），故声明 ['topicId'] + where 即可
// 与 DB 收敛（diff 不比较 where 字符串）；实体曾完全未声明 → generate 反复 DROP 该唯一
// 约束（漂移治理 94502fef）
@Index('uq_roundtable_seats_topic_bind_actor', ['topicId'], {
  unique: true,
  where: `status != '${SEAT_LIFECYCLE_STATUS.REMOVED}'`,
})
export class RoundtableSeat {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属圆桌 topic（设计 §5 topic_id FK；D-B1-2 惯例：不建物理 FK，仅导航） */
  @Column({ type: 'uuid', nullable: false, name: 'topic_id' })
  @Index('idx_roundtable_seats_topic_id')
  topicId: string;

  /** 座位展示名（seatLabel 身份模型，web 渲染座位 badge，设计 §6） */
  @Column({ type: 'varchar', length: 100, nullable: false })
  label: string;

  /** 厂商（'kimi' | 'codex'（M4a 已接入），后续扩展 'claude-code' | 'opencode'，契约① SeatConfig） */
  @Column({ type: 'varchar', length: 30, nullable: false })
  vendor: string;

  /**
   * 绑定的 runner（nullable = 未绑/离线座位）。绑定由 runner 握手认证后按
   * config.bindActorId 匹配写入（设计 §7），一 key 一 runner。
   */
  @Column({ type: 'uuid', nullable: true, name: 'runner_id' })
  @Index('idx_roundtable_seats_runner_id')
  runnerId: string | null;

  /**
   * 静态配置（jsonb，只存静态配置，禁止写入运行时状态——运行时状态进 state）：
   * { permissionMode: 'default'|'plan'|'auto'|'yolo', model?, cwd, bindActorId,
   *   batchWindowMs?, budgetLimit?, contextWatermark? }
   */
  @Column({ type: 'jsonb', nullable: false, default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;

  /**
   * 运行时状态（jsonb DEFAULT '{}'）：{ recentInjects: [{seq, messageIds}] ring
   * buffer cap 100, lastUsage, recentActivity: [{at, kind, summary, result}] ring
   * buffer cap 10（M4b-1 近况时间线，R5 摘要化）, roundsWithoutHuman/silentCount/
   * valveTripCount（安全阀计数 r7）, failedEventSeqs（失败留档 RT-DEBT-1）,
   * modelInfo（配置观测） }——chamber 重启后内存队列丢失，靠 hello 对账 +
   * recentInjects 重建 inject 重放（设计 §4「黑板即真相」）。
   */
  @Column({ type: 'jsonb', nullable: false, default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: Record<string, any>;

  /** 生命周期状态：active / paused / parked / offline / removed（默认 active：座位已启用、待 runner 认领；值域单源 SEAT_LIFECYCLE_STATUSES） */
  @Column({ type: 'varchar', length: 20, nullable: false, default: SEAT_LIFECYCLE_STATUS.ACTIVE })
  status: string;

  /** 主脑座位标记（设计 §6：主脑调度指令必须 topic 明说可观测） */
  @Column({ type: 'boolean', nullable: false, default: false })
  coordinator: boolean;

  /** 上行对账游标：已收 seat.event 的 seq（设计 §4 双向对账，座位级独立递增） */
  @Column({ type: 'bigint', nullable: false, default: 0, name: 'last_event_seq' })
  lastEventSeq: string;

  /** 下行对账游标：已发 seat.inject 的 seq（设计 §4 双向对账） */
  @Column({ type: 'bigint', nullable: false, default: 0, name: 'last_inject_seq' })
  lastInjectSeq: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /** ORM 导航（D-B1-2：不加 DB 级 FK，仅作 TypeORM 导航用） */
  @ManyToOne(() => Topic, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'topic_id' })
  topic: Topic;

  @ManyToOne(() => RoundtableRunner, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'runner_id' })
  runner: RoundtableRunner | null;
}
