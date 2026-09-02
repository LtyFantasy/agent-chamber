/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.2 (Topic / Message)
 *   - 补充: docs/roundtable-design.md §5 (topics.kind 增列，M2 落地)
 *
 * [踩坑索引] RESP-SYNC(前端类型同步)
 *
 * [铁律关联] #11(注释) #20(契约即设计) #12(文档联动)
 *
 * [详细踩坑]（最多 5 条）
 *   RESP-SYNC: topic entity 字段直接 spread 进 response（findAll/findOne），前端
 *       Topic/TopicDetail 类型在 apps/web/src/types/index.ts 与
 *       packages/shared/src/dto/topic-response.dto.ts 两处镜像。
 *       改字段必须三处同步，否则 web/digest 消费端类型漂移。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
/**
 * [前端 Response] apps/web/src/types/index.ts (Topic / TopicDetail interface)
 * [注意] 修改字段时需同步检查前端 Topic Response 类型
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { TopicStatus, ActorType, TopicKind } from '@agent-chamber/shared';
import { TopicParticipant } from './topic-participant.entity';
import { Message } from './message.entity';
import { Board } from './board.entity';

@Entity('topics')
@Index(['status'])
@Index(['creatorId'])
export class Topic {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'jsonb', default: [] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agenda: Record<string, any>[];

  @Column({
    type: 'enum',
    enum: TopicStatus,
    enumName: 'topic_status',
    // 2026-08-31 死契约清理：draft 已删，create 恒写 ACTIVE，默认值对齐实体语义
    default: TopicStatus.ACTIVE,
  })
  status: TopicStatus;

  @Column({ type: 'jsonb', default: { allow_agent_proposal: true, vote_threshold: 3 } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: Record<string, any>;

  /**
   * 话题类型（设计 docs/roundtable-design.md §5，M2 阶段 1 落地）：
   * 'normal' = 普通话题（缺省，存量行零感知）；'roundtable' = 圆桌模式（席位 +
   * 会话层规则 wakePolicy/攒批生效）。创建后不可变——update 忽略 kind，
   * normal↔roundtable 互转在 M2 推迟清单（避免 topic 生命周期中途语义突变）。
   * 值域单源 TopicKind（shared enums）。
   */
  @Column({ type: 'varchar', length: 20, nullable: false, default: TopicKind.NORMAL })
  kind: TopicKind;

  @Column({ type: 'uuid', nullable: false, name: 'creator_id' })
  creatorId: string;

  /** 创建者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  creatorType: ActorType;

  @Column({ type: 'int', default: 0, name: 'message_count' })
  messageCount: number;

  @Column({ type: 'int', default: 0, name: 'participant_count' })
  participantCount: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_message_at' })
  lastMessageAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  @OneToMany(() => TopicParticipant, (tp) => tp.topic)
  participants: TopicParticipant[];

  @OneToMany(() => Message, (message) => message.topic)
  messages: Message[];

  @OneToMany(() => Board, (board) => board.topic)
  boards: Board[];
}
