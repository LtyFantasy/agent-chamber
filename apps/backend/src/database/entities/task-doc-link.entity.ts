/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/database.md (task_doc_links 表), plan §3.1
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
import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * task ↔ doc N:M 中间表
 *
 * 软删除语义沿用平台惯例：
 * - 删文档不伤任务（join 时过滤 docs.deleted_at IS NULL）
 * - 删任务不伤文档（join 时过滤 tasks.deleted_at IS NULL）
 * - 删空间级联软删 docs 后，link 行仍存在但 join 过滤隐藏
 *
 * 裸 uuid 无 FK（软删除过滤语义靠 join 条件）
 */
@Entity('task_doc_links')
@Index(['docId'])
export class TaskDocLink {
  @PrimaryColumn({ type: 'uuid', name: 'task_id' })
  taskId: string;

  @PrimaryColumn({ type: 'uuid', name: 'doc_id' })
  docId: string;

  /** 创建关联的 actor ID */
  @Column({ type: 'uuid', nullable: false, name: 'created_by' })
  createdBy: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
