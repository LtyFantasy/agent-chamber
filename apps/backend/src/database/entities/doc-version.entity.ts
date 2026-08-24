/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/database.md (doc_versions 表, doc history MVP 2026-08-18)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #25(类型前置) #11(注释强制)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Doc } from './doc.entity';

/**
 * 文档编辑历史版本快照（doc history，MVP）
 *
 * 写通道收口：所有内容变更（upsert / patchSection / patchByMatch / batch import）
 * 最终都走 DocService.upsert 重建管线，版本行在同一事务内、且仅当 contentHash
 * 真的变化时插入（unchanged 幂等短路不落版本）。
 *
 * 保留策略：每文档上限 DOC_VERSION_KEEP（=20，doc.service.ts），插入新版本后
 * 同事务 DELETE 剪掉超出部分——version 单调递增（= 历史最大 version+1），
 * **删旧不归零**，version 可视为稳定标识（不随剪枝变化）。
 */
@Entity('doc_versions')
@Index(['docId', 'version'])
export class DocVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属文档（裸 uuid） */
  @Column({ type: 'uuid', nullable: false, name: 'doc_id' })
  docId: string;

  /**
   * 版本号：单调递增（该文档历史最大 version+1），剪枝删除旧版本后不回填/不归零。
   * 对外是稳定标识——引用某版本不受后续版本删除影响。
   */
  @Column({ type: 'int', nullable: false })
  version: number;

  /** 该版本内容的 SHA256（= 写入后 docs.content_hash，unchanged 短路时不产生版本行） */
  @Column({ type: 'varchar', length: 64, nullable: false, name: 'content_hash' })
  contentHash: string;

  /** 该版本的全文快照（text，与写通道 dto.content 同形） */
  @Column({ type: 'text', nullable: false })
  content: string;

  /** 写入者 actor ID（缺省 'system' 固定 uuid，与 docs.created_by 缺省语义对齐） */
  @Column({ type: 'uuid', nullable: false, name: 'author_actor_id' })
  authorActorId: string;

  /**
   * 版本来源（写通道收口区分，枚举字面量：'upsert' | 'patch' | 'import'）。
   * DB 为 varchar 不建 PG 枚举——枚举值随版本演进（二期可能加 'restore' 等），
   * 应用层 DOC_VERSION_SOURCES 常量为单一事实来源（对齐 docs.source 先例）。
   */
  @Column({ type: 'varchar', length: 16, nullable: false })
  source: string;

  /** 版本行创建时间（服务端时间，对齐 created_at 惯例） */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /**
   * 关联文档
   * docId FK→docs ON DELETE CASCADE：物理删除文档时版本快照一并清理；
   * 软删（deleted_at）不清版本——历史快照独立于文档生命周期，软删后可考古。
   */
  @ManyToOne(() => Doc, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'doc_id' })
  doc: Doc;
}