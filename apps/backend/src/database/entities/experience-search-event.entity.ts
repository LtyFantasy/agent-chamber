/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）检索观测：零命中率埋点轻表
 *
 * [代码职责]
 *   - `experience_search_events` 表逐列定义：一次检索的过滤指纹 + 是否有结果 + 时刻
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §8（观测与成功度量：零命中率 = 零结果
 *     行数 / 总行数；4 周复查判据）
 *   - 补充: 线上 DocSpace `docs/database.md` — 表结构权威说明（本表节随后续批次上线）
 *
 * [关键不变量]
 *   - **表只有 4 列且刻意不建索引**：唯一的读形态是 4 周复查时的聚合扫描
 *     （`count(*) FILTER (WHERE had_results)`），量级 = 检索次数（每天个位数到几十），
 *     Seq Scan 完全够用；加索引只会给写路径（每次检索一行）增加成本
 *   - **写入必须 fail-open**：埋点是观测，绝不阻断检索（service 侧 try/catch + error 日志）
 *   - `query_hash` 存的是**过滤指纹的 sha256 hex**，不是原查询串：检索参数可能含用户
 *     输入（甚至误贴的凭据片段），落原文等于把观测表变成第二个内容泄漏面
 *   - 无 `updated_at`：本表只追加不更新（事件流语义），时间由 created_at 单一承载
 *
 * [关联代码]
 *   - database/migrations/1790100000000-AddExperienceSearchEvents.ts — 建表（裸 SQL）
 *   - modules/experience/experience.service.ts — 唯一写入点（零结果/有结果各记一行）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 经验库检索事件（观测轻表）。
 *
 * 为什么需要它（plan §8 PM R2）："零命中率"是 4 周复查的核心判据（零命中率 > 80% 意味着
 * 检索机制没被用起来 → 触发降级为 DocSpace 空间+约定形态的退路），而**没有仪器就永远
 * 只是感觉**。采集放在服务侧自落（零消费者负担），因此不设独立上报端点。
 */
@Entity('experience_search_events')
export class ExperienceSearchEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 过滤指纹（sha256 hex，64 字符 —— 与 `varchar(64)` 精确同宽）。
   *
   * 指纹输入 = 归一化后的**全部生效过滤条件**（q/signals/domains/env 四键/intent/
   * quality/sourceProject/includeExpired）按固定键序序列化；同一组条件永远算同一指纹，
   * 因而"某类查询反复零命中"可被聚合出来。
   */
  @Column({ type: 'varchar', length: 64, nullable: false, name: 'query_hash' })
  queryHash: string;

  /**
   * 本次检索是否有结果（`total > 0`）。
   *
   * 零命中率 = `had_results = false` 的行数 / 总行数——**两个口径都要落**，只记零结果行
   * 会让比率恒等于 1，度量失去意义。
   */
  @Column({ type: 'boolean', nullable: false, name: 'had_results' })
  hadResults: boolean;

  /** 检索时刻（只追加不更新；4 周复查按时间窗口聚合） */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
