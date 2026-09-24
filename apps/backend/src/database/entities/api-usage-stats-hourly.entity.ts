/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：REST 请求与 MCP invocation 的 UTC 小时桶预聚合
 *
 * [代码职责]
 *   - `api_usage_stats_hourly` 表的维度与累加列定义（9 维唯一键 + 3 个累加列）
 *   - 唯一索引 `uq_api_usage_stats_hourly` 的**显式同名声明**（护栏，见下）
 *
 * [权威文档]
 *   - 主文档: docs/database.md §api_usage_stats_hourly — 表结构/保留策略/autovacuum 参数
 *   - 补充: docs/api-definition.md §Usage Stats — 采集口径（guard 短路不记 / DTO 400 记 /
 *     latency = handler 阶段 / actor_type='system' = fallback-auth 归因标记）
 *
 * [关键不变量]
 *   - 唯一索引必须 `@Index('uq_api_usage_stats_hourly', [9 列], { unique: true })`，
 *     **禁用 `@Unique`**：TypeORM 0.3.30 对 `NULLS NOT DISTINCT` 零认知，按名匹配不到
 *     索引就会在 generate 时**静默 DROP**（后果 = 同维度不再累加、零报错重复插行）
 *   - 9 列顺序 = migration 唯一索引列顺序，改一处必须同步另一处（键序即冲突判定序）
 *   - `actor_type` 列宽 varchar(16)：'anonymous' 9 字符，varchar(8) 装不下，
 *     PG 报 22001 **不截断**，会让整批 flush 永久静默失败（T13/T14 实证）
 *   - `actor_id` 刻意**无 FK**：统计行须在 actor 硬删后存活（audit_logs 无 FK 先例）
 *   - 二级索引**只允许** `(actor_id, bucket_start)`（EXPLAIN 实测唯一有收益者）
 *   - `latencySumMs` 是 PG bigint，TypeORM 读出为 **string**——凡出口必须显式 `Number()`
 *
 * [关联代码]
 *   - database/migrations/1789484900000-AddApiUsageStatsHourly.ts — 建表 + NULLS NOT DISTINCT 索引
 *   - modules/usage-stats/usage-stats-buffer.service.ts — 本表唯一写入方（jsonb_to_recordset + ON CONFLICT）
 *
 * [持久踩坑]
 *   USAGE-STATS-INDEX(索引漂移): 唯一索引用 @Unique 声明或改名 → migration:generate
 *     静默 DROP，表现为"同维度不再累加"且无任何报错。安全方向: 同名同列 @Index +
 *     indexdef 断言含 `NULLS NOT DISTINCT`（e2e 断言恒查 pg_indexes）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（列顺序 / 列宽 / 索引名三处同步）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 唯一索引列顺序（键序即 ON CONFLICT 冲突判定序，改序必须与 migration 同步） */
export const API_USAGE_STATS_HOURLY_UNIQUE_KEY = 'uq_api_usage_stats_hourly';

/**
 * 调用频率小时桶（预聚合，无明细表——用户拍板口径）。
 *
 * 维度 9 列构成唯一键（`NULLS NOT DISTINCT`，故 `actor_id IS NULL` 的匿名流量
 * 同样受唯一性约束、同样累加而非重复插行）；`call_count` / `latency_sum_ms` /
 * `latency_max_ms` 是唯三被写入的累加列。
 *
 * 刻意**不带 created_at/updated_at**：本表是机器算出来的聚合事实，时间语义由
 * `bucket_start` 单一承载；再加行级时间戳会让"桶内累加"读起来像"最近一次更新"。
 *
 * 实体与 migration 手写配套（平台惯例：手写 migration 不 generate，见
 * attachment.entity.ts 同类声明），因此此处的 `@Index` 是**防漂移护栏**而非生成源。
 */
@Entity('api_usage_stats_hourly')
@Index(
  API_USAGE_STATS_HOURLY_UNIQUE_KEY,
  [
    'bucketStart',
    'channel',
    'mcpSurface',
    'toolName',
    'method',
    'route',
    'actorId',
    'actorType',
    'statusClass',
  ],
  { unique: true },
)
// 二级索引：按 actor 查单 Agent 用量的唯一有收益索引（其余候选实测只有体积成本）
@Index('idx_api_usage_stats_actor_bucket', ['actorId', 'bucketStart'])
export class ApiUsageStatsHourly {
  /** 惯例主键（无业务含义，冲突判定走唯一索引而非 PK） */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * UTC 小时桶起点（**应用侧**截断，不用 DB `date_trunc`）：
   * 桶归属时刻 = 请求进入拦截器（SSE 为连接打开时刻）的时刻，见 D3/B6。
   */
  @Column({ type: 'timestamptz', nullable: false, name: 'bucket_start' })
  bucketStart: Date;

  /** 通道：`rest`（拦截器采集）/ `mcp`（automcp 上报的 invocation 行） */
  @Column({ type: 'varchar', length: 8, nullable: false })
  channel: string;

  /**
   * MCP 暴露面，**封闭词表** `'' / 'mcp' / 'mcp-full' / 'unknown'`
   * （'' = 非 MCP 流量）。词表化是 flush 管线的生存条件：PG 对超长 varchar
   * 报 22001 而不是截断，**一行坏值会让整批 INSERT 全灭**。
   */
  @Column({ type: 'varchar', length: 16, nullable: false, default: '', name: 'mcp_surface' })
  mcpSurface: string;

  /**
   * MCP 工具名（'' = 非 MCP 流量；`'__invalid__'` = 上报侧 name 非法/缺失的哨兵，
   * 与 '' 语义刻意区分）。≤128 截断（D5 收敛，防基数爆炸）。
   */
  @Column({ type: 'varchar', length: 128, nullable: false, default: '', name: 'tool_name' })
  toolName: string;

  /** 大写 HTTP method；上报行固定 `TOOL`（D6 坍缩豁免的判定依据） */
  @Column({ type: 'varchar', length: 8, nullable: false })
  method: string;

  /**
   * 路由模板（`req.route.path`，天然含 `/api/v1` 前缀、天然含 `:param`）/
   * `mcp://tools/call`（上报行）/ `__overflow__`（基数安全阀坍缩桶）。
   */
  @Column({ type: 'varchar', length: 255, nullable: false })
  route: string;

  /**
   * 调用者 actor id；NULL = 未认证/上报行未带身份。
   * **刻意无 FK**：统计行须在 actor 硬删后存活（删号不该抹掉历史用量）。
   */
  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actorId: string | null;

  /**
   * 身份种类：`agent` / `human` / `system` / `anonymous`。
   *
   * ⚠️ 语义重叠警告：此列的 `'system'` **唯一生产者** = MCP 上报侧的
   * `viaFallbackAuth` 归因标记（共享 `--api-key` 场景），**不是** actors 表里的
   * 平台 system actor——未来 join 时不要按字面理解。
   * 列宽 varchar(16)（'anonymous' 9 字符，varchar(8) 会 22001 打死整批 flush）。
   */
  @Column({ type: 'varchar', length: 16, nullable: false, name: 'actor_type' })
  actorType: string;

  /** 状态类（`Math.floor(status/100) + 'xx'`）；上报行 ok → `2xx`、error → `5xx` */
  @Column({ type: 'varchar', length: 3, nullable: false, name: 'status_class' })
  statusClass: string;

  /** 桶内调用次数（累加：`ON CONFLICT DO UPDATE ... + EXCLUDED.call_count`） */
  @Column({ type: 'int', nullable: false, name: 'call_count' })
  callCount: number;

  /** 桶内耗时总和（PG bigint → 读出为 string，出口显式 Number()） */
  @Column({ type: 'bigint', nullable: false, name: 'latency_sum_ms' })
  latencySumMs: string;

  /** 桶内耗时峰值（`GREATEST` 累加） */
  @Column({ type: 'int', nullable: false, name: 'latency_max_ms' })
  latencyMaxMs: number;
}
