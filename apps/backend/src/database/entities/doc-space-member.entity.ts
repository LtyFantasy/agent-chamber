/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §7.2 (统一权限模型)
 *   - 补充: docs/database.md (doc_space_members 表), plan §3.1
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
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { DocSpace } from './doc-space.entity';

@Entity('doc_space_members')
@Index(['actorId'])
export class DocSpaceMember {
  @PrimaryColumn({ type: 'uuid', name: 'space_id' })
  spaceId: string;

  @PrimaryColumn({ type: 'uuid', name: 'actor_id' })
  actorId: string;

  /**
   * 成员角色
   * - editor: 可编辑空间内容（文档/分类），由 addEditor 授予
   * - member: 只读访问，由 inviteAgent 授予
   */
  @Column({ type: 'varchar', length: 20, default: 'member' })
  role: string;

  /** 邀请者 actor ID（可空） */
  @Column({ type: 'uuid', nullable: true, name: 'invited_by' })
  invitedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /**
   * 关联空间
   * space_id FK→doc_spaces ON DELETE CASCADE（照抄 BoardMember 先例）：
   * doc_space_members 是 doc_space 的组成数据，space 删除后成员行无独立存在意义。
   */
  @ManyToOne(() => DocSpace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space: DocSpace;
}
