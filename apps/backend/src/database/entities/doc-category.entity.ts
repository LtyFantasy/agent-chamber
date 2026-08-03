/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/database.md (doc_categories 表), plan §3.1
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

@Entity('doc_categories')
@Index(['spaceId'])
export class DocCategory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属空间（裸 uuid） */
  @Column({ type: 'uuid', nullable: false, name: 'space_id' })
  spaceId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  /**
   * 分类路径标识
   * space 内唯一（partial unique index WHERE deleted_at IS NULL）
   */
  @Column({ type: 'varchar', length: 128, nullable: false })
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 排序顺序，数字越小越靠前 */
  @Column({ type: 'int', default: 0, name: 'sort_order' })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;
}
