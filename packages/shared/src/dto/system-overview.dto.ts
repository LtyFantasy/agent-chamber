/**
 * GET /system/overview 响应（admin-only，运维观测总览）
 *
 * 设计原则：全部来自现成表/字段的只读聚合，零埋点、零 schema 变更。
 * 语义钉死：
 * - seats.backlogEstimate 是「未消费水位」而非故障信号——包含攒批窗口内与 busy
 *   排队中的内存态消息，正常运行随攒批窗口 0→N→0 抖动；ring 空（从未派发）→ null
 *   表示「无法估计」，UI 不得显示为 0
 * - events 块只做「总线活跃度」：events.delivered/deliveredAt 是死字段（全仓无置位
 *   写入点），pull 模型下服务端无 per-consumer cursor，「未投递水位」不可算，
 *   该指标归埋点批（Board 任务 0c567f8b）
 */

/** runner 运行状态条目（roundtable_runners 行 + 承载座位数） */
export interface RunnerOverviewItem {
  id: string;
  name: string;
  /** online / offline（WS 连接生命周期维护） */
  status: string;
  /** runner 软件版本（hello 上报），未上报为 null */
  version: string | null;
  /** 最近心跳/连接时间，在线状态对账用；离线距今时长由前端渲染 */
  lastSeenAt: string | null;
  /** 绑定到该 runner 的座位数 */
  seatCount: number;
}

/** 座位运行状态条目（roundtable_seats 行 + 积压估计） */
export interface SeatOverviewItem {
  id: string;
  label: string;
  vendor: string;
  /** active / paused / parked / offline */
  status: string;
  topicId: string;
  /** null = 未绑定 runner（离线座位） */
  runnerId: string | null;
  /**
   * 未消费消息水位估计：topic 黑板中晚于 recentInjects ring 最大 createdAt、
   * 且不在 ring 内、且非本座位发言的消息数（与 rebuildUndispatched 同规）。
   * ring 空（从未派发）→ null 表示无法估计。
   */
  backlogEstimate: number | null;
}

/**
 * 注入可观测（1.54.0 埋点批，Board 任务 0c567f8b）。
 *
 * 采样语义（钉死，UI 文案据此呈现）：
 * - 延迟样本 = 各座位 state.recentInjects ring 内**带 injectedAt 的条目**
 *   （1.54.0 起写入；存量旧条目无该字段，不计入——滑动窗口 ≤100 条/座位，
 *   是「最近注入」而非全量统计）；
 * - 延迟 = 消息落库（messages.created_at）→ 后端发出 seat.inject 的耗时
 *   （含攒批窗口，push 语义无 ack，测不到 runner 实际 inject 时刻）；
 * - retryCount / dropCount = 座位 state 内的进程持久化计数（全座位合计，
 *   自 1.54.0 起从零计数；重启不清零，语义为「累计」非「速率」）。
 */
export interface InjectionOverview {
  /** 延迟样本数；0 时 latencyAvgMs/latencyMaxMs 为 null（前端显示空态） */
  latencySamples: number;
  /** 平均注入延迟 ms（含攒批窗口） */
  latencyAvgMs: number | null;
  /** 最大注入延迟 ms */
  latencyMaxMs: number | null;
  /** 下行发送失败（runner 离线，队头保留待重连重试）累计次数 */
  retryCount: number;
  /** 注入失败累计次数（不可派发丢弃 + 游标落库失败） */
  failCount: number;
}

/** 系统观测总览（GET /system/overview） */
export interface SystemOverview {
  /** 服务器生成时间（ISO 8601），便于判断数据新鲜度 */
  generatedAt: string;
  runners: {
    total: number;
    online: number;
    offline: number;
    items: RunnerOverviewItem[];
  };
  seats: {
    total: number;
    /** runner_id IS NULL 的座位数（待认领/离线） */
    unbound: number;
    byStatus: Record<string, number>;
    items: SeatOverviewItem[];
  };
  events: {
    total: number;
    /** 近 24h 事件数（无 created_at 单列索引，当前量级全表扫可接受） */
    last24h: number;
    /** 最新事件时间 = 总线存活信号；无任何事件时为 null */
    latestEventAt: string | null;
    byTypeLast24h: Array<{ eventType: string; count: number }>;
  };
  webhooks: {
    total: number;
    pending: number;
    /** WebhookStatus.SUCCESS（对齐枚举命名，不叫 delivered） */
    success: number;
    failed: number;
    /** status=pending 且 retry_count > 0（重试队列中） */
    retrying: number;
    /** success/(success+failed)；无完结投递时为 null（前端显示空态而非 0%） */
    successRate: number | null;
    /** 已完结投递的平均耗时；无耗时记录为 null */
    avgResponseTimeMs: number | null;
  };
  /** 圆桌注入可观测（埋点批；采样窗口语义见 InjectionOverview 注释） */
  injection: InjectionOverview;
  /** SSE /events/stream 进程内活跃连接数（SseService gauge，瞬时值） */
  sse: {
    activeConnections: number;
  };
}
