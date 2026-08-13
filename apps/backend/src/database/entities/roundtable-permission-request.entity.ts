/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §5 (数据模型) + §6 (审批可见性/裁决)
 *   - 补充: docs/roundtable-design.md §3 (契约① permission_request) / §4 (seat.permission_verdict)
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释) #20(契约即设计) #18(不变量检查)
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
import { Topic } from './topic.entity';
import { RoundtableSeat } from './roundtable-seat.entity';

/** 审批请求状态取值（M3 阶段 1 冻结；设计 §6 审批可见性——平台永不做缺省裁决，故无 auto 态） */
export const ROUNDTABLE_PERMISSION_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'orphaned',
] as const;

/** 审批请求状态：pending（等待人类裁决）/ approved / rejected / orphaned（runner 断连作废） */
export type RoundtablePermissionRequestStatus =
  (typeof ROUNDTABLE_PERMISSION_REQUEST_STATUSES)[number];

/**
 * 圆桌审批请求表（`roundtable_permission_requests`，M3 阶段 1，见设计 §5/§9）
 *
 * 一行 = 一个座位挂起的审批请求（契约① permission_request 上行落库）。设计要点：
 * - request_id = runner 侧请求 ID（ACP JSON-RPC id），重放对账按 (seat_id, request_id)
 *   应用层幂等去重（runner 重连重放不产生双写；不建唯一索引——同 id 跨座位合法）
 * - tool / options jsonb 原样存上行载荷（ToolBrief / PermissionOption[]）：tool 供
 *   topic 公告摘要与 web 展示；options 是裁决校验的权威来源（optionId 必须 ∈ options，
 *   铁律 #20 契约即设计——option 形状 `{ optionId, kind, label }` 未冻结，按 id 匹配）
 * - status 流转（铁律 #18 不变量）：pending → approved/rejected（人类裁决）/ orphaned
 *   （runner 断连）；裁决写入 verdict_option_id + resolved_by + resolved_at；
 *   orphaned 只写 resolved_at（作废非人类裁决，resolved_by 留空）
 * - 不建 DB 级物理 FK（D-B1-2 惯例：裸 uuid + 索引，仅 TypeORM 导航）
 */
@Entity('roundtable_permission_requests')
export class RoundtablePermissionRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** runner 侧请求 ID（ACP session/request_permission 的 JSON-RPC id；对账幂等键之一） */
  @Column({ type: 'varchar', length: 100, nullable: false, name: 'request_id' })
  @Index('idx_roundtable_perm_reqs_request_id')
  requestId: string;

  /** 发起请求的座位（设计 §5 topic_id/seat_id FK；D-B1-2：裸 uuid + 索引，仅导航） */
  @Column({ type: 'uuid', nullable: false, name: 'seat_id' })
  @Index('idx_roundtable_perm_reqs_seat_status')
  seatId: string;

  /** 所属圆桌 topic（冗余落库：座位可能被移除，审批归属仍需可查；同 D-B1-2 惯例） */
  @Column({ type: 'uuid', nullable: false, name: 'topic_id' })
  @Index('idx_roundtable_perm_reqs_topic_status')
  topicId: string;

  /** 工具摘要（ToolBrief，契约①原样透传；web 展示 + 公告摘要数据源） */
  @Column({ type: 'jsonb', nullable: false, default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: Record<string, any>;

  /** 审批选项（PermissionOption[]，契约①原样透传；裁决 optionId 的权威校验源） */
  @Column({ type: 'jsonb', nullable: false, default: [] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any[];

  /** 状态：pending / approved / rejected / orphaned（默认 pending；流转见类头注释） */
  @Column({ type: 'varchar', length: 20, nullable: false, default: 'pending' })
  status: string;

  /** 裁决选中的选项 id（pending/orphaned 时为 null） */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'verdict_option_id' })
  verdictOptionId: string | null;

  /** 裁决者 actor id（仅人类裁决写入；orphaned 作废不写，见类头注释） */
  @Column({ type: 'uuid', nullable: true, name: 'resolved_by' })
  resolvedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /** 裁决/作废时间（pending 时为 null；orphaned 也写，作废即终态） */
  @Column({ type: 'timestamptz', nullable: true, name: 'resolved_at' })
  resolvedAt: Date | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /** ORM 导航（D-B1-2：不加 DB 级 FK，仅作 TypeORM 导航用） */
  @ManyToOne(() => Topic, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'topic_id' })
  topic: Topic;

  @ManyToOne(() => RoundtableSeat, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'seat_id' })
  seat: RoundtableSeat;
}
