/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/database.md (doc_sections 表), plan §3.1, plan §1.1-13 (sectionId 不稳定性契约)
 *
 * [踩坑索引] rundedup-continuation-v1.57.3(续 chunk 事实标记)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   rundedup-continuation-v1.57.3: 相邻同 headingPath/headingLevel 可能是真实同名 sibling，不能再用相邻字段猜测续 chunk。新增 isContinuation 持久化 chunker 事实，renderer 仅据该字段去重。
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
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Doc } from './doc.entity';

@Entity('doc_sections')
@Index(['docId', 'position'])
export class DocSection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属文档 */
  @Column({ type: 'uuid', nullable: false, name: 'doc_id' })
  docId: string;

  /** 篇内顺序（从 0 开始），对外按 position 或 headingPath 定位 */
  @Column({ type: 'int', nullable: false })
  position: number;

  /**
   * 层级标题路径
   * 如 `§3.2 任务状态机`，祖先标题链 `父 § 子` 拼接（截断 512）
   * 债 A（doc_sections 标题独立列）之后退化为**纯寻址地址**：标题展示一律读 headingText
   */
  @Column({ type: 'varchar', length: 512, nullable: true, name: 'heading_path' })
  headingPath: string | null;

  /**
   * 本地标题文本（标题展示的权威源，chunker 直写，consumer 直读——取代 headingPath
   * 字符串反解析；反解析对标题正文内含 ` § ` 的行会切错，已两次踩坑）
   *
   * 取值规范与 chunker 一致：ATX 标题去前导 `#`+空格、去尾部闭合 `#`、trim 后的原始
   * 文本（保留行内 markdown 标记原样）；headingLevel=0（文首无标题段）为 NULL；
   * 续 chunk（isContinuation=true）与同 headingPath 的首 chunk 共享同一值。
   * 存量行由 migration 按 headingPath 末段回填（best-effort，新写入才是权威源）。
   */
  @Column({ type: 'varchar', length: 512, nullable: true, name: 'heading_text' })
  headingText: string | null;

  /** 标题层级：0=文首无标题段，1-6 对应 h1-h6 */
  @Column({ type: 'smallint', default: 0, name: 'heading_level' })
  headingLevel: number;

  /** 是否为长 section 按段落切分产生的续 chunk；首 chunk 与普通 section 为 false */
  @Column({ type: 'boolean', default: false, name: 'is_continuation' })
  isContinuation: boolean;

  /** section 正文 */
  @Column({ type: 'text', nullable: false })
  content: string;

  /**
   * token 估算（CJK 感知）
   *
   * 算法（应用层计算，不依赖 DB 函数）：
   *   cjkCharCount + ceil(nonCjkLength / 4)
   * 其中 CJK 区间正则计数（中文 1 字≈1 token，英文 ~4 字符≈1 token）。
   *
   * rationale：本功能核心卖点数据——纯 len/4 对中文低估 ~4 倍不可接受。
   * 此为应用层估算值，实际 tokenization 由下游 LLM 决定，仅作计数参考。
   */
  @Column({ type: 'int', default: 0, name: 'token_estimate' })
  tokenEstimate: number;

  /**
   * 全文搜索向量（tsvector）
   * 由数据库 trigger 维护：content + headingPath 拼接 → to_tsvector('simple', ...)
   * 照抄 message 先例。GIN 索引在 migration 中定义。
   * select: false 避免默认查询带出大字段。
   */
  @Column({ type: 'tsvector', nullable: true, select: false, name: 'search_vector' })
  searchVector: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /**
   * 关联文档
   * docId FK→docs ON DELETE CASCADE：文档内容变更 → 整批删旧 sections 插新，
   * CASCADE 保证事务内清理干净。sectionId 不稳定（参见 plan §1.1-13），
   * 对外读取一律按 position 或 headingPath 定位，任何客户端不得持久化 sectionId。
   */
  @ManyToOne(() => Doc, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'doc_id' })
  doc: Doc;
}
