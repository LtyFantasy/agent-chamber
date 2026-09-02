/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/database.md (docs 表), plan §3.1
 *   - 补充: plan diagram-ir-v1-plan.md §1.1（Diagram IR v1：+diagram_type/rendered_html/
 *     render_meta 三列；docType='diagram' ⟺ 三列非空 不变量，迁出置 null）
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
import {
  DOC_SOURCE_NATIVE,
  DOC_TITLE_MAX_LENGTH,
  DOC_SUMMARY_MAX_LENGTH,
} from '@agent-chamber/shared';

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

  // 列长单源 = shared DOC_TITLE_MAX_LENGTH（改值需配套 migration，见常量注释）
  @Column({ type: 'varchar', length: DOC_TITLE_MAX_LENGTH, nullable: false })
  title: string;

  /**
   * 摘要
   * ≤500 字符，缺省取首段（chunking 时生成）
   */
  // 列长单源 = shared DOC_SUMMARY_MAX_LENGTH（改值需配套 migration，见常量注释）
  @Column({ type: 'varchar', length: DOC_SUMMARY_MAX_LENGTH, nullable: true })
  summary: string | null;

  /** 文档类型，用户自定义，开放字符串（'diagram' = Diagram IR 图文档，见下方三列） */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'doc_type' })
  docType: string | null;

  /**
   * 图类型（Diagram IR v1，plan diagram-ir-v1-plan.md §1.1）
   * 从 IR `diagram_type` 字段反正范化（architecture/workflow/sequence/dataflow/lifecycle，
   * 最长 12 字符 < varchar(16)），免解析 IR 即可列表/过滤；非 diagram 文档恒 NULL。
   * 不变量（铁律 #18）：docType='diagram' ⟺ diagram_type/rendered_html 非空——
   * 写入路径 upsertCore diagram 分支同事务维护；迁出（docType 改非 diagram）三列同置 null。
   */
  @Column({ type: 'varchar', length: 16, nullable: true, name: 'diagram_type' })
  diagramType: string | null;

  /**
   * 渲染产物 HTML 快照（自包含 viewer：内联 SVG+CSS+JS，PG TOAST 自动压缩）。
   * IR 的确定性编译产物——可由任意版本 IR 重渲染复原，故不进 doc_versions（版本只快照 IR）。
   * select:false 防水合大字段（先例：本表 deletedAt / doc_sections.searchVector）；
   * 读端点（GET /docs/:id/diagram.html）必须 QB addSelect('d.renderedHtml') 显式取（plan §4.1 M-c）。
   */
  @Column({ type: 'text', nullable: true, name: 'rendered_html', select: false })
  renderedHtml: string | null;

  /**
   * 渲染元数据（~1KB 紧凑 JSON，读详情页用）：
   * {engine:'archify', rendererVersion, qualityProfile（服务端注入后的生效值）,
   *  checks:[{name,ok}], composition:{errors,warnings}（checker composition.summary 子对象）,
   *  renderedAt, htmlBytes, htmlSha256}
   */
  @Column({ type: 'jsonb', nullable: true, name: 'render_meta' })
  renderMeta: Record<string, unknown> | null;

  /** 标签数组 */
  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  /**
   * 文档来源
   * 'native'（默认，API/MCP 可写）vs ingest 来源（如 'git:agent-chamber'，平台只读，写操作 409）
   * DB 为 NOT NULL DEFAULT 'native'，实体对齐 nullable:false（消除 migration:generate 噪声 diff）
   * 哨兵值引用 shared DOC_SOURCE_NATIVE（review-0831 任务 8fab2a9d 上移单源）
   */
  @Column({ type: 'varchar', length: 128, default: DOC_SOURCE_NATIVE, nullable: false })
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
