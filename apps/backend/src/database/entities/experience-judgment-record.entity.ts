/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）· 判别服务判断日志（provider 当前值域 `typesafe`；历史行可为
 *     已退役的 `jev`）= **未来训练本地小模型的语料** + observe 期准确率复核数据
 *
 * [代码职责]
 *   - `experience_judgments` 表逐列定义（append-only 事实源；条目上的 `judgment` 列只是缓存）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base-p2.md §0（威胁模型：判断日志=正文第二副本）/§1.2（逐列）
 *     /§3.5（写入纪律）/§4（消费面：翻案率配对、导出姿势）
 *   - 补充: 线上 DocSpace `docs/experience-base.md` — 判断日志/训练语料章（批 6 上线后为准）
 *
 * [关键不变量]
 *   - **append-only**：应用层无 UPDATE/DELETE 路径（保留策略/清除 = admin 走 DB 人工窗口，
 *     含按条目级联清）。**条目软删 ≠ 本表清除**（明文写进文档）。
 *   - **`request` NOT NULL 不许破**：`status='skipped'`（限流跳过，未调 provider）也要写
 *     占位 `{skipped:true, reason:'judgment_rate_limited'}`——否则插入撞 23502 会连带
 *     拖垮录入主流程。
 *   - **失败与跳过都落库**：`ok`/`error`/`timeout`/`skipped` 四态齐落；"未判"与"判失败"的
 *     区分 = 查本表 status（缓存列 `judgment=null` 二者不分，且**不自动重判**为明文决策）。
 *   - 体积纪律（应用层，**不是 DB CHECK**）：`request.state.content` = 正文节选 ≤2000 字符
 *     （带 `contentTruncated`/`contentLength` 标记）；request/response 序列化各硬顶 16KB
 *     （超限截断 + `truncated:true`）；失败 `{error}` ≤2000 字符且**不含 key、不含上游错误体**。
 *     落库前 redaction 一遍（密钥闸门同正则的**纵深防御**，非主缓解）。
 *   - `status` **刻意不建索引**（低基数）：仅当 4 周复查发现失败率查询变高频，再评估
 *     `(created_at DESC) WHERE status <> 'ok'` 部分索引（plan §1.2 [B] 段登记）。
 *   - 索引全部是 migration 裸 SQL 产物（**本类不声明 `@Index`**）：分页全序
 *     `(created_at DESC, id DESC)`——同刻多行必须有序，否则翻页会漏行/重复
 *     （同模块 `experience.service.ts` 既有全序不变量）+ `(experience_id, created_at DESC)`。
 *
 * [关联代码]
 *   - database/migrations/1790200000000-AddExperiencePhase2.ts — 建表 + 2 索引 + autovacuum（裸 SQL）
 *   - database/entities/experience-entry.entity.ts — `judgment` 快照列（本表的派生缓存）
 *   - packages/shared/src/enums/index.ts — EXPERIENCE_JUDGMENT_OPERATIONS/STATUSES 值域单源
 *   - packages/shared/src/dto/experience-response.dto.ts — ExperienceJudgmentLog（读侧投影）
 *
 * [持久踩坑]
 *   EXPERIENCE-JUDGMENT-SNAPSHOT-VS-LOG(事实源): 把条目快照列当事实源会让
 *     "判失败被置 NULL"（改内容重判失败的正确处置）读成"从未判过"，语料也随之不可复原。
 *     安全方向: 日志表是事实、快照列是缓存；任何"判断发生过吗/失败了多少"一律查本表。
 *   EXPERIENCE-JUDGMENT-CLASSNAME(同名不同物): 本实体类刻意取名 `ExperienceJudgmentRecord`
 *     而非 `ExperienceJudgment`——后者已被 shared 占用为**七维快照形状**（jsonb 载荷），
 *     同名会让同时引用二者的 service 被迫起别名。改名是防混淆，不是命名随意。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type {
  ActorType,
  ExperienceJudgmentOperation,
  ExperienceJudgmentStatus,
} from '@agent-chamber/shared';

/**
 * 判断日志行（append-only）。
 *
 * 为什么日志与快照分离：日志是**事实**（每次判断一行，含失败与跳过），
 * `experience_entries.judgment` 是**缓存**（只描述最近一次成功的判定结果，
 * 改内容重判失败时必须置 NULL，否则旧快照会描述新内容）。
 *
 * 本表同时服务两条动线：① 训练语料导出（时间窗切片 + total 自检）；
 * ② observe 期复核（失败率分母 = ok+error+timeout，排除 skipped；终审翻案率按
 * `created_at <= verifiedAt` 且 `status='ok'` 的最新一条配对）。
 */
@Entity('experience_judgments')
export class ExperienceJudgmentRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 所属条目 ID（**无 FK**：条目软删/硬删后日志保留——语料价值不随条目生命周期终结；
   * 硬删完整性也不靠 FK，条目硬删走 DB 人工窗口）
   */
  @Column({ type: 'uuid', nullable: true, name: 'experience_id' })
  experienceId: string | null;

  /**
   * 操作类型（裸 varchar(32)；值域单源 = shared `EXPERIENCE_JUDGMENT_OPERATIONS`）
   *
   * 本阶段唯一产出值 `record_check`；`rerank`/`autotag` 是预留（对应功能 plan §13 不做）。
   */
  @Column({ type: 'varchar', length: 32, nullable: false })
  operation: ExperienceJudgmentOperation;

  /**
   * 判别服务提供方（裸 varchar(32)；**当前值 `'typesafe'`**，历史值 `'jev'` = v1.83.0 前
   * 的自托管 MCP 网关适配器，已退役）。
   *
   * 语义 = **适配器（端点 + 传输）**，**不表示厂商或云归属**；对照/导出以本列 + `model`
   * 两列为准。裸列无 CHECK 约束 ⇒ 新增 provider 不需要 migration。
   */
  @Column({ type: 'varchar', length: 32, nullable: false })
  provider: string;

  /** 模型标识（provider 自报，如 `'jev-latest'`；仅观测/对照用，不参与判定） */
  @Column({ type: 'varchar', length: 64, nullable: true })
  model: string | null;

  /**
   * 结果状态（裸 varchar(16)；值域单源 = shared `EXPERIENCE_JUDGMENT_STATUSES`）
   *
   * `ok` 成功 / `error` 各类失败 / `timeout` 超时 / `skipped` 限流跳过（未调 provider）。
   */
  @Column({ type: 'varchar', length: 16, nullable: false })
  status: ExperienceJudgmentStatus;

  /** 触发该次判断的写入者类型（滥用归因 + 复核抽样；复用 ActorType：agent/human/system） */
  @Column({ type: 'varchar', length: 16, nullable: true, name: 'actor_type' })
  actorType: ActorType | null;

  /** 触发该次判断的写入者 ID（**无 FK**：actor 硬删后日志须存活——训练语料不可失） */
  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actorId: string | null;

  /**
   * 判断输入（jsonb，**NOT NULL**）：**实际发包体**原样留档，形状按 provider 不同——
   * `typesafe` = `{state, model, questions}`（`model` = 当次请求模型）；历史行里的 `jev`
   * = `{questions, state}`（网关适配器，v1.83.0 已退役，不再产生新行）。
   *
   * `state.content` 只放正文**节选**（≤2000 字符 + contentTruncated/contentLength 标记）
   * ——全量正文入库会让本表成为"正文第二副本"的无限增长面。
   * `status='skipped'` 时写占位 `{skipped:true, reason:'judgment_rate_limited'}`（不破 NOT NULL）。
   * 序列化硬顶 16KB（超限截断 + `truncated:true`）。
   */
  @Column({ type: 'jsonb', nullable: false })
  request: Record<string, unknown>;

  /**
   * 判断输出（jsonb，可空）：成功 = 归一化七维 + raw 摘要；失败 = `{error}`；
   * `skipped` → null。
   *
   * ⚠️ 写入纪律：`{error}` **不得含 provider 的 key（`TYPESAFE_API_KEY`）、
   * 不得含上游错误体原文**（401 裸 JSON 错误体既不入 warn 日志也不入本列也不入响应）。
   * 成功/失败统一硬顶 16KB；**形状破损的响应（白名单校验失败）不许落本列**（只落 status=error）。
   */
  @Column({ type: 'jsonb', nullable: true })
  response: Record<string, unknown> | null;

  /** provider 往返耗时（毫秒；`skipped`/未调用 → null） */
  @Column({ type: 'int', nullable: true, name: 'latency_ms' })
  latencyMs: number | null;

  /**
   * 落库时间（`DEFAULT now()` 与 `@CreateDateColumn` 同写）
   *
   * 分页全序 = `(created_at DESC, id DESC)`（索引在 migration）：同刻多行也必须有序，
   * 否则 `page++` 翻页会漏行/重复。
   */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
