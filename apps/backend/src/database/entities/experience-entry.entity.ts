/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）：跨项目、跨行业共享的「带伤疤的实战笔记」
 *
 * [代码职责]
 *   - `experience_entries` 表逐列定义（可空性 / 列宽 / 默认值即 schema 契约）
 *   - 全文检索向量 `search_vector` 由 DB trigger 维护（见 [关键不变量]）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §1.1/§1.3 — 逐列可空性 + 索引清单
 *     （对外文档 docs/experience-base.md 与 docs/database.md 的 experience_entries
 *      表节随后续批次上线；两者落地后以线上文档为权威副本）
 *   - 补充: 线上 DocSpace `docs/database.md` — 表结构权威说明
 *
 * [关键不变量]
 *   - `search_vector` 必须是**普通 TSVECTOR 列 + BEFORE INSERT/UPDATE trigger**：
 *     禁止改成生成列（generated column）——生成列缺 typeorm_metadata 登记会炸漂移
 *     门禁（全仓零生成列先例，plan §1.1）
 *   - trigger 表达式**逐段 COALESCE**（漏一段 = 该段为 NULL 时整行永久不可搜且零报错，
 *     33% 毒化实证）；trigger 函数定义在 migration 1790000000000
 *   - `signals`/`domains` 是 text[]，实体层默认值写**字符串** `'{}'`（数组字面量文本）；
 *     `env` 是 jsonb，实体层默认值写**对象** `{}`（TypeORM `normalizeDefault` 序列化为
 *     `'{}'::jsonb`）。两态写反 = 错误列类型/校验失败；migration 裸 SQL 侧对应
 *     `'{}'::text[]` 与 `'{}'::jsonb` 两种类型字面量
 *   - `created_by_id` 刻意**无 FK**（usage-stats / audit_logs 先例：actor 硬删后条目须存活）
 *   - 计数三列（helped / not_helpful / distinct_helped）**不进任何索引**：计数列高频
 *     UPDATE，进索引 = 零 HOT（写放大实证，plan §1.1/§1.3）；排序索引只允许
 *     `distinct_helped_count` 出现在**部分表达式索引**里
 *   - `deleted_at` 必须 `select: false`：软删是内部状态，出口一律 404 不泄露存在性
 *   - `judgment`（第二期增列）同样 `select: false`：jsonb 大列，列表 getMany 带出 = 白付
 *     detoast；详情/幂等重放路径显式 addSelect。**本列是缓存不是事实源**——事实在
 *     `experience_judgments` 日志表（含失败与限流跳过行），"未判 vs 判失败"只能查日志
 *   - 本类**不声明任何 `@Index`**：本表索引全部是 migration 裸 SQL 产物
 *     （GIN / trgm / 表达式 / 部分索引 TypeORM 表达不了），实体侧补装饰器会造成
 *     第二条索引事实源（漂移门禁的 [A] 命名差噪声）
 *
 * [关联代码]
 *   - database/migrations/1790000000000-AddExperienceEntries.ts — 建表 + 全索引 + trigger（裸 SQL）
 *   - database/migrations/1790200000000-AddExperiencePhase2.ts — 第二期增列 `judgment`（裸 SQL）
 *   - database/entities/experience-feedback.entity.ts — 反馈表（本表计数三列的写入触发方）
 *   - database/entities/experience-judgment-record.entity.ts — 判断日志（本列的事实源）
 *   - packages/shared/src/enums/index.ts — EXPERIENCE_INTENT / EXPERIENCE_QUALITY 值域单源
 *   - packages/shared/src/dto/experience.dto.ts — EXPERIENCE_TITLE_MAX_LENGTH 列宽单源
 *
 * [持久踩坑]
 *   EXPERIENCE-SEARCHVECTOR-COALESCE(触发向量): trigger 拼接表达式漏 COALESCE →
 *     该段为 NULL 时 `NULL || 'x'` = NULL，整行 search_vector 变 NULL，该行对 q 通道
 *     **永久不可搜且零报错**。安全方向: 逐段 COALESCE，段数 = 参与向量的列数。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  ActorType,
  EXPERIENCE_QUALITY,
  EXPERIENCE_SUMMARY_MAX_LENGTH,
  EXPERIENCE_TITLE_MAX_LENGTH,
  type ExperienceEnv,
  type ExperienceIntent,
  type ExperienceJudgment,
  type ExperienceQuality,
} from '@agent-chamber/shared';

/**
 * 经验条目（带伤疤的实战笔记）。
 *
 * 五面模型（plan v0.1 §0 分类学，不建行业分类树）：
 * ① `intent` 受控五值（问题性质）；② `signals` 症状信号（检索主入口，ANY-overlap）；
 * ③ `domains` 领域标签（开放词表）；④ `env` 环境指纹（键受控值开放）；
 * ⑤ `quality` 生命周期（unverified → admin 终审 → verified | suspect）。
 *
 * 索引说明：GIN(signals/domains/search_vector/content trgm)、env 四键表达式 btree、
 * 排序部分表达式索引、autovacuum 参数全部由 migration 裸 SQL 创建（见 [关键不变量]）。
 */
@Entity('experience_entries')
export class ExperienceEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 标题（列表主标识；列宽单源 = shared `EXPERIENCE_TITLE_MAX_LENGTH`） */
  @Column({ type: 'varchar', length: EXPERIENCE_TITLE_MAX_LENGTH, nullable: false })
  title: string;

  /**
   * 摘要（**必填**，不从 content 派生）
   *
   * rationale：列表投影不含 content 全文，摘要是消费方判断"值不值得点进详情"的
   * 唯一依据，故录入时强制提供。列宽单源 = shared `EXPERIENCE_SUMMARY_MAX_LENGTH`
   * （与 title 同法引用，**禁写 500 字面量**）。
   */
  @Column({
    type: 'varchar',
    length: EXPERIENCE_SUMMARY_MAX_LENGTH,
    nullable: false,
  })
  summary: string;

  /**
   * 正文全文（markdown 四节模板：Symptom / Root cause / Fix / How verified）
   *
   * 列类型 `text` 本身无长度限制；`EXPERIENCE_CONTENT_MAX_LENGTH`（64KB）是**产品
   * 上限**，卡在 DTO 层（400），不进 DB CHECK——调参不需要 migration（plan §1.1）。
   */
  @Column({ type: 'text', nullable: false })
  content: string;

  /**
   * 类型（五值受控词表：pitfall / repair / howto / optimize / decision）
   *
   * 裸 varchar(32) 而非 PG enum：新增取值无需 migration（先例 topics.kind）。
   * 值域单源 = shared `EXPERIENCE_INTENTS`，本列的类型标注只是编译期提示，
   * 落库校验由 DTO `@IsIn` 承担（服务端写侧强制）。
   */
  @Column({ type: 'varchar', length: 32, nullable: false })
  intent: ExperienceIntent;

  /**
   * 症状信号（归一化后的小写 token 数组；检索主入口）
   *
   * `DEFAULT '{}'` **必须带引号**（引号 = PG 的数组字面量；漏引号会让默认值成为
   * 字符串常量而建表失败）。查询形态钉死 `&&` overlap / `@>` 包含——
   * **禁 `= ANY`**（实测 Seq Scan，GIN 用不上，plan §1.3）。
   */
  @Column({ type: 'text', array: true, nullable: false, default: '{}' })
  signals: string[];

  /**
   * 环境指纹（键白名单 os/tool/version/runtime，值开放）
   *
   * jsonb `DEFAULT {}` **不带引号**（jsonb 字面量）。查询侧四个 `->>` 谓词各有
   * 一条表达式 btree（`((env->>'os'))` 等；GIN jsonb_path_ops 服务不了 `->>`，实测）。
   */
  @Column({ type: 'jsonb', nullable: false, default: {} })
  env: ExperienceEnv;

  /** 领域标签（开放词表，归一化后小写；查询形态同 signals = ANY-overlap） */
  @Column({ type: 'text', array: true, nullable: false, default: '{}' })
  domains: string[];

  /**
   * 质量（unverified 缺省 / verified 终审通过 / suspect 终审判可疑）
   *
   * 裸 varchar(32)；缺省 unverified（录入通道强制，全认证可写、立即可搜无需审批）。
   * ⚠️ 任何 content/title/summary/signals 改写必须回落 unverified 并清 verified_by/at
   * （徽章洗白防线，plan §3）——该规则由 service 层承担，本列不设 DB 约束。
   */
  @Column({
    type: 'varchar',
    length: 32,
    nullable: false,
    default: EXPERIENCE_QUALITY.UNVERIFIED,
  })
  quality: ExperienceQuality;

  /**
   * 累计「帮到了」反馈数（含改判的净计数 —— 改判时与 not_helpful_count 联动 ±1）
   *
   * ⚠️ 计数三列**不进索引**：反馈每次写入都会 UPDATE 本行，计数列进索引 → 整行
   * 不可 HOT → 写放大（plan §1.1 实测）。
   */
  @Column({ type: 'int', nullable: false, default: 0, name: 'helped_count' })
  helpedCount: number;

  /** 累计「没帮到」反馈数（语义 = **应用后**是否有效，非搜索是否命中） */
  @Column({ type: 'int', nullable: false, default: 0, name: 'not_helpful_count' })
  notHelpfulCount: number;

  /**
   * (entry, actor) 去重后的有效命中数 —— **`sort=most_used` 的排序权重列**
   *
   * 与 helpedCount 的区别：同一 actor 反复改判只算 1（反馈表
   * `uq_experience_feedback_experience_actor` 是去重仲裁者）。刻意用去重计数排序，
   * 使刷反馈操纵排序的收益受限于"需要多少个不同 actor"。
   */
  @Column({ type: 'int', nullable: false, default: 0, name: 'distinct_helped_count' })
  distinctHelpedCount: number;

  /** 最近一次「帮到了」的时间（仅 outcome=helped 推进；改判为 not_helpful 时不回退） */
  @Column({ type: 'timestamptz', nullable: true, name: 'last_helped_at' })
  lastHelpedAt: Date | null;

  /**
   * 录入者类型（复用 `ActorType`：agent / human / system）
   *
   * 刻意**不造 'user' 第二词汇**（plan §1.1）——人的 actor 行同样是 actors.type='human'，
   * 本列与 actors.type 同词表，跨表聚合才不需要映射。
   */
  @Column({ type: 'varchar', length: 16, nullable: false, name: 'created_by_type' })
  createdByType: ActorType;

  /** 录入者 ID（**无 FK**：actor 硬删后条目不随之消失，usage-stats 先例） */
  @Column({ type: 'uuid', nullable: false, name: 'created_by_id' })
  createdById: string;

  /** 来源项目（自报、**非可信**；格式约定 repo slug；可筛选，用于发现跨项目经验） */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'source_project' })
  sourceProject: string | null;

  /** 终审人 ID（admin；未终审为 null） */
  @Column({ type: 'uuid', nullable: true, name: 'verified_by' })
  verifiedBy: string | null;

  /** 终审时间（未终审为 null；suspect 判定同样落此列 = "最近一次终审时刻"） */
  @Column({ type: 'timestamptz', nullable: true, name: 'verified_at' })
  verifiedAt: Date | null;

  /**
   * 最近一次 `record_check` 判别的**快照**（jsonb；第二期 plan §1.3，形状 = shared
   * `ExperienceJudgment`）。
   *
   * ⚠️ **本列是缓存，不是事实**：事实源 = `experience_judgments` 日志表（append-only，
   * 含失败与限流跳过行）。`null` 的三种含义（未判 / 判失败 / provider 未启用）在详情
   * 响应里由 status 与 judgmentSuppressed 共同消歧，**"未判 vs 判失败"只能查日志表**。
   *
   * `select: false`（**有意**）：jsonb 大列，列表 `getMany` 带出会白付 detoast 开销
   * （先例 `search_vector`）。详情/幂等重放路径必须显式 `addSelect`。
   *
   * 写入纪律（plan §3.5，批 3 落地）：裸 SQL 定向 UPDATE 写本列时**不触碰 `updated_at`**
   * （乐观锁 token 不能被后台判定改写），且带版本守卫 `WHERE id=$1 AND updated_at=$2`
   * ——判定在途期间条目被再改（rowCount=0）则**丢弃快照只留日志**；改内容重判**失败**
   * 时必须在同事务把本列置 NULL（旧快照描述旧内容，留着就是错）。
   *
   * 列物理位置由 `ALTER TABLE ADD COLUMN` 追加在表尾（migration 裸 SQL），与本字段在
   * 类中的书写位置无关（漂移 diff 按列名比对，不比对顺序）。
   */
  @Column({ type: 'jsonb', nullable: true, select: false, name: 'judgment' })
  judgment: ExperienceJudgment | null;

  /** 时效边界（**写入校验必须 > now()**；null = 永不过期；过期条目默认从检索排除） */
  @Column({ type: 'timestamptz', nullable: true, name: 'expires_at' })
  expiresAt: Date | null;

  /**
   * 全文检索向量（英文/标识符通道；中文走 pg_trgm similarity 融合打分）
   *
   * 由 DB trigger `trg_experience_entries_search_vector` 维护，**应用层禁写**。
   * `select: false` 避免默认查询带出大字段（先例 doc_sections.searchVector）。
   */
  @Column({ type: 'tsvector', nullable: true, select: false, name: 'search_vector' })
  searchVector: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /**
   * 软删时间（`select: false`：软删是内部状态，出口一律 404 不泄露存在性）
   *
   * 恢复入口刻意**不设应用层 API**（admin 恢复走 DB 人工窗口——attachment-gc 同款
   * 人工窗口哲学，plan §1.1）。
   */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true, select: false, name: 'deleted_at' })
  deletedAt: Date | null;
}
