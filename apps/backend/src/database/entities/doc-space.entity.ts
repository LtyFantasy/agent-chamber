/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/database.md (doc_spaces 表), plan §3.1
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释)
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
  DeleteDateColumn,
  Index,
} from 'typeorm';

@Entity('doc_spaces')
@Index(['topicId'])
@Index(['boardId'])
@Index(['creatorId'])
export class DocSpace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  /** slug 用于 MCP 按名解析，全表唯一（软删外的 partial unique index 在 migration 中定义） */
  @Column({ type: 'varchar', length: 128, nullable: false })
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 关联话题（与 boardId 二选一，migration CHECK 约束保证） */
  @Column({ type: 'uuid', nullable: true, name: 'topic_id' })
  topicId: string | null;

  /** 关联看板（与 topicId 二选一，migration CHECK 约束保证） */
  @Column({ type: 'uuid', nullable: true, name: 'board_id' })
  boardId: string | null;

  /** 创建者 actor ID（裸 uuid，对齐惯例） */
  @Column({ type: 'uuid', nullable: false, name: 'creator_id' })
  creatorId: string;

  /**
   * 空间设置（jsonb）
   * - visibility: 'open' | 'private'，缺省 open
   * 对齐 board/topic 惯例，存 settings jsonb 列不建独立 visibility 列
   */
  @Column({ type: 'jsonb', default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: Record<string, any>;

  /**
   * 文档计数
   * 由数据库 trigger 维护（单一事实源），应用层禁写。
   * 教训：v1.27 双写 bug，本次严格只由 trigger 更新。
   */
  @Column({ type: 'int', default: 0, name: 'doc_count' })
  docCount: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;
}
