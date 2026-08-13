/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §5 (数据模型) + §7 (安全边界: API Key 复用,
 *     一 key 一 runner 后到踢先到)
 *
 * [踩坑索引]
 *
 * [铁律关联] #11(注释) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * 圆桌 runner 注册表（`roundtable_runners`，M1 提前落地的两表之一，见设计 §5/§9）
 *
 * 一行 = 一台 runner 进程（常驻拨出 WS 连回 chamber 的独立进程，可承载多个座位）。
 * 设计要点：
 * - actor_id = runner 拨出所用 API Key 对应 agent 的 actor id（§7「API Key 复用」：
 *   认证后按 actor 绑定 runner，禁止一 key 多 runner 同时在线——后到踢先到，由阶段 3
 *   的 runner-registry 在内存层执行，本表只存归属）
 * - vendors jsonb = 该 runner 支持的 vendor 列表（如 ["kimi"]），座位绑定时校验
 *   seat.vendor ∈ hello.vendors，避免厂商不匹配的座位被塞给错误 runner（M1 自审补）
 * - status 用 varchar 而非 PG enum：对齐 actors.status 惯例，避免 enum 类型演进成本；
 *   取值 online/offline（连接生命周期由 WS 层维护）
 * - 不建 DB 级物理 FK（对齐项目惯例 D-B1-2：裸 uuid + 索引，仅作 TypeORM 导航用）
 */
@Entity('roundtable_runners')
export class RoundtableRunner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** runner 展示名（hello 上报的 runner-name） */
  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  /**
   * runner 身份 = API Key 对应 agent 的 actor id（跨身份统一后同 milestone.creatorId
   * 惯例：裸 uuid + 索引，不建物理 FK）。一 actor 同时最多一个在线 runner（§7）。
   */
  @Column({ type: 'uuid', nullable: false, name: 'actor_id' })
  @Index('idx_roundtable_runners_actor_id')
  actorId: string;

  /** 在线状态：online / offline（连接建立 → online，断开 → offline） */
  @Column({ type: 'varchar', length: 20, nullable: false, default: 'offline' })
  status: string;

  /** runner 软件版本（hello 上报，排障用） */
  @Column({ type: 'varchar', length: 30, nullable: true })
  version: string | null;

  /**
   * 支持的 vendor 列表（jsonb 数组，如 ["kimi"]）。座位绑定时要求
   * seat.vendor ∈ 本数组（M1 自审补：否则 M4a codex runner 上线会被塞 kimi 座位）。
   */
  @Column({ type: 'jsonb', nullable: false, default: [] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vendors: any[];

  /** 最近一次心跳/连接时间（在线状态对账用） */
  @Column({ type: 'timestamptz', nullable: true, name: 'last_seen_at' })
  lastSeenAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
