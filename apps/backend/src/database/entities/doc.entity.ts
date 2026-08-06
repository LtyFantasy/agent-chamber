/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/database.md (docs 表), plan §3.1
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

@Entity('docs')
@Index(['spaceId'])
@Index(['categoryId'])
@Index(['createdBy'])
export class Doc {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属 DocSpace（裸 uuid） */
  @Column({ type: 'uuid', nullable: false, name: 'space_id' })
  spaceId: string;

  /** 分类 ID（裸 uuid，可空；删分类 → categoryId 置 null 归未分类） */
  @Column({ type: 'uuid', nullable: true, name: 'category_id' })
  categoryId: string | null;

  /**
   * 文档路径
   * space 内定位锚点（如 `docs/architecture.md`）。
   * partial unique (space_id, path) WHERE deleted_at IS NULL
   */
  @Column({ type: 'varchar', length: 512, nullable: false })
  path: string;

  @Column({ type: 'varchar', length: 200, nullable: false })
  title: string;

  /**
   * 摘要
   * ≤500 字符，缺省取首段（chunking 时生成）
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  summary: string | null;

  /** 文档类型，用户自定义，开放字符串 */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'doc_type' })
  docType: string | null;

  /** 标签数组 */
  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  /**
   * 文档来源
   * 'native'（默认，API/MCP 可写）vs ingest 来源（如 'git:agent-chamber'，平台只读，写操作 409）
   * DB 为 NOT NULL DEFAULT 'native'，实体对齐 nullable:false（消除 migration:generate 噪声 diff）
   */
  @Column({ type: 'varchar', length: 128, default: 'native', nullable: false })
  source: string;

  /** 内容 SHA256，ingest 幂等跳过用 */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'content_hash' })
  contentHash: string | null;

  /**
   * last-verified 语义的源码提交 sha（如 git rev-parse HEAD 40 hex）
   * 含义 = "内容在此 sha 验证一致"，由 sync 适配器每次同步时上报；
   * unchanged 文档也刷新该列（同步即验证），内容实际变更不受影响。
   * 新鲜度判断留给消费端：doc.sourceSha vs 空间 maxSha 比较。
   * 普通 btree 索引（空间内按 sha 扫比较）。
   */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'source_sha' })
  sourceSha: string | null;

  /** section 数量，chunking 后回填 */
  @Column({ type: 'int', default: 0, name: 'section_count' })
  sectionCount: number;

  /** token 估算总量，chunking 后回填 */
  @Column({ type: 'int', default: 0, name: 'token_estimate' })
  tokenEstimate: number;

  /**
   * 链接健康巡检结果
   * NULL 表示尚未检查；jsonb 形状：{ total, broken[], checkedAt }。
   * 计算时机：upsert 事务内顺带计算；remove 异步重算同空间全部文档。
   */
  @Column({ type: 'jsonb', nullable: true, name: 'link_health' })
  linkHealth: Record<string, unknown> | null;

  /** 创建者 actor ID（裸 uuid） */
  @Column({ type: 'uuid', nullable: false, name: 'created_by' })
  createdBy: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;
}
