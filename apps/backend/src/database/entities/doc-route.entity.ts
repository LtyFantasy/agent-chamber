/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/database.md (doc_routes 表), plan §4-B5 (意图路由结构化)
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
  Index,
} from 'typeorm';
import { RouteHealth, DocRouteCodeEntryType } from '@agent-chamber/shared';

/**
 * 意图路由（INDEX.md 功能-文档映射表的结构化形态）
 *
 * 语义（plan §4-B5）：intent（"我要…"）→ primaryDoc+headingPath（先看）→ secondaryDoc（再看）
 * → codeEntry（代码入口）。category = 路由分组。
 *
 * 裸 uuid 无 FK（对齐 task_doc_links 惯例）：doc 软删后路由行仍保留（join/校验在 Service 层完成），
 * 避免 FK 级联删除丢失路由策展数据；doc 存在性与归属由写时校验保证（DOC_ROUTE_DOC_NOT_FOUND）。
 * 已知边界：写时校验只保证写入当下可解析；doc 后续编辑致 headingPath 悬空属批次 C 异步校验范围。
 */
@Entity('doc_routes')
@Index(['spaceId'])
export class DocRoute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属 DocSpace（裸 uuid，无 FK） */
  @Column({ type: 'uuid', nullable: false, name: 'space_id' })
  spaceId: string;

  /** 用户意图描述（"我要…"，如 "我要了解系统架构"） */
  @Column({ type: 'varchar', length: 200, nullable: false })
  intent: string;

  /** 路由分组（可空，如 "architecture"、"troubleshooting"） */
  @Column({ type: 'varchar', length: 100, nullable: true })
  category: string | null;

  /** 主文档 ID（必填，路由第一步跳转；裸 uuid 无 FK） */
  @Column({ type: 'uuid', nullable: false, name: 'primary_doc_id' })
  primaryDocId: string;

  /** 主文档定位锚点（doc_sections.heading_path 精确匹配；NULL = 文档级跳转） */
  @Column({ type: 'varchar', length: 512, nullable: true, name: 'primary_heading_path' })
  primaryHeadingPath: string | null;

  /** 次文档 ID（可空；看完主文档后需要再看时跳转） */
  @Column({ type: 'uuid', nullable: true, name: 'secondary_doc_id' })
  secondaryDocId: string | null;

  /** 次文档定位锚点（可空） */
  @Column({ type: 'varchar', length: 512, nullable: true, name: 'secondary_heading_path' })
  secondaryHeadingPath: string | null;

  /** 代码入口（仓库内相对路径，如 `apps/backend/src/modules/docspace/doc.service.ts`；禁绝对路径与 `..` 段） */
  @Column({ type: 'varchar', length: 512, nullable: true, name: 'code_entry' })
  codeEntry: string | null;

  /**
   * codeEntry 类型（T5）：'exact'（缺省）= 精确文件/目录路径，recheck 参与
   * repoManifest.files 存在性校验；'pattern' = glob 泛化写法（如 `apps/web/app/**` + `/page.tsx`），
   * 人类指引价值 > 精确校验价值，recheck 豁免（health 标记 codeEntryStatus:'exempt'，不报 broken）。
   * 列默认 'exact' 保证存量行迁移后语义不变（迁移兼容铁律）。
   */
  @Column({
    type: 'varchar',
    length: 16,
    nullable: false,
    default: 'exact',
    name: 'code_entry_type',
  })
  codeEntryType: DocRouteCodeEntryType;

  /**
   * 路由健康巡检结果（v1.42 批次 C1/C2，异步重检写入）
   *
   * jsonb 形状：{ issues: [{kind:'heading'|'codeEntry', target:'primary'|'secondary'|'codeEntry',
   * value:string}], codeEntryStatus?: 'ok'|'broken'|'unchecked'|'exempt', codeEntryNote?: string,
   * checkedAt: ISO }。
   * 空 issues = 健康；NULL = 尚未检查（对齐 link_health「无数据 ≠ 零断链」）。
   * codeEntryStatus（C2/T5，仅 codeEntry 非空时携带）：无 repoManifest → 'unchecked'（不算 broken）；
   * 精确/目录前缀命中 → 'ok'；不命中 → 'broken' 且 issues 含 kind:'codeEntry'；
   * codeEntryType='pattern' → 'exempt'（豁免精确校验，codeEntryNote 附说明，不算 broken）。
   * 写入方：route-health.service.recheckSpace（upsert 内容变更 / remove / 手动 recheck 端点）。
   */
  @Column({ type: 'jsonb', nullable: true })
  health: RouteHealth | null;

  /** 排序权重（同空间内 ASC 升序展示，缺省 0） */
  @Column({ type: 'int', nullable: false, default: 0, name: 'sort_order' })
  sortOrder: number;

  /** 创建者 actor ID（裸 uuid） */
  @Column({ type: 'uuid', nullable: false, name: 'created_by' })
  createdBy: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
