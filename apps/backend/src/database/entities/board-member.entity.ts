/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 补充: docs/database.md §4 (board_members 表), PROJECT.md §1.3.2 可见性继承
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */

/**
 * [共享 DTO] packages/shared/src/dto/board-response.dto.ts (BoardMember interface)
 * [注意] 修改字段时需同步检查 BoardMember Response 类型
 */
import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Board } from './board.entity';

@Entity('board_members')
@Index(['actorId'])
export class BoardMember {
  @PrimaryColumn({ type: 'uuid', name: 'board_id' })
  boardId: string;

  @PrimaryColumn({ type: 'uuid', name: 'actor_id' })
  actorId: string;

  /**
   * 成员角色
   * - editor: 可编辑看板内容（列/任务），由 addEditor 授予
   * - member: 只读访问，由 inviteAgent / topic participant 回填 / dto.invitedAgentIds 授予
   */
  @Column({ type: 'varchar', length: 20, default: 'member' })
  role: string;

  /** 邀请者 actor ID（可空，create 时自动写入或 topic 回填时为 NULL） */
  @Column({ type: 'uuid', nullable: true, name: 'invited_by' })
  invitedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /**
   * 关联看板
   * board_id FK→boards ON DELETE CASCADE（有意偏离项目「无 DB FK」惯例）：
   * board_members 是 board 的组成数据，board 删除后成员行无独立存在意义。
   */
  @ManyToOne(() => Board, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'board_id' })
  board: Board;
}
