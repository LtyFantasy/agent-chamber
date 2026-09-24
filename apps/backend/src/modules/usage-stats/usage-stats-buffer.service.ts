/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：内存聚合 → 定期 flush 进 api_usage_stats_hourly
 *
 * [代码职责]
 *   - 本表**唯一写入方**（拦截器与上报端点都只是把维度交给它）
 *   - 两个采集入口：`recordHttpCall()`（REST 每请求）/ `recordInvocation()`（MCP 上报行）
 *   - 内存 Map 聚合（键 = 9 维）+ setInterval flush + 安全阀坍缩 + 关停终局 flush
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 口径专章（丢 ≤60s / 坍缩与
 *     invocation 视野的交互 / UTC 桶 / actor_type='system' 语义）
 *   - 补充: docs/database.md §api_usage_stats_hourly — 维度列与保留策略
 *
 * [关键不变量]
 *   - **禁止 REQUEST 作用域**：本服务是应用级单例，聚合 Map 必须跨请求存活；
 *     改成 REQUEST 作用域会让统计恒空且 @Cron 失效（D9）
 *   - flush SQL 逐字照抄 plan §3：`jsonb_to_recordset` + **GROUP BY 批内去重**
 *     （缺它报 21000）+ **ORDER BY 定序**（防并发死锁，反向序实测 4/10 死锁）
 *     + ON CONFLICT **全 9 列显式** conflict_target
 *   - swap 语义：**成功才丢弃、失败合回**——失败直接丢弃会静默丢一窗口计数
 *   - 安全阀坍缩**三字段同归**（route + tool_name + mcp_surface），且 `method='TOOL'`
 *     行豁免（被坍缩会从 metric=invocations 视野消失）
 *   - 键序 = 唯一索引列顺序（改序必须与 entity/migration 同步）
 *   - 常规路径"跳过"在途 flush、关停路径"等待"在途 flush（语义刻意相反）
 *   - 关停终局 flush 有 10s 超时护栏：超时即放弃（DB 抖动时不许拖住部署）
 *
 * [关联代码]
 *   - usage-stats.interceptor.ts — REST 采集入口（exactly-once 在该侧保证）
 *   - usage-stats.constants.ts — 词表/阈值/归一化单一定义点
 *   - database/migrations/1789484900000-AddApiUsageStatsHourly.ts — NULLS NOT DISTINCT 索引
 *
 * [持久踩坑]
 *   USAGE-STATS-COLUMN-WIDTH(22001): actor_type 若窄于 varchar(16)，'anonymous'
 *     会让整批 flush INSERT 永久静默失败（表长期零行、无异常可见）。安全方向:
 *     列宽与词表最长的值对齐 + e2e 用 anonymous 维度做探测器。
 *   USAGE-STATS-DEADLOCK(键序): 批内行顺序不定时，两个后端同时 flush 会在
 *     ON CONFLICT 的唯一索引上反向加锁死锁（实测 4/10）。安全方向: SQL 内 ORDER BY 定序。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（尤其：SQL 是否被改动）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  normalizeUsageSurface,
  normalizeUsageToolName,
  resolveUsageFlushIntervalMs,
  toUtcHourBucket,
  USAGE_FLUSH_SHUTDOWN_TIMEOUT_MS,
  USAGE_STATS_CHANNEL_MCP,
  USAGE_STATS_MAX_KEYS,
  USAGE_STATS_OVERFLOW_ROUTE,
  USAGE_STATS_SYSTEM_ACTOR_TYPE,
  USAGE_STATS_TOOL_METHOD,
  USAGE_STATS_TOOL_ROUTE,
  USAGE_SURFACE_UNKNOWN,
} from './usage-stats.constants';

/** 聚合维度（9 列，顺序即唯一索引列顺序） */
export interface UsageStatsDimensions {
  /** UTC 小时桶起点（应用侧截断） */
  bucketStart: Date;
  /** `rest` / `mcp` */
  channel: string;
  /** 封闭词表 surface */
  mcpSurface: string;
  /** MCP 工具名（'' = 非 MCP） */
  toolName: string;
  /** 大写 HTTP method；上报行 = TOOL */
  method: string;
  /** 路由模板 / mcp://tools/call / __overflow__ */
  route: string;
  /** 调用者 actor（NULL = 未认证/上报未带身份） */
  actorId: string | null;
  /** agent / human / system / anonymous */
  actorType: string;
  /** 2xx/3xx/4xx/5xx */
  statusClass: string;
}

/** 拦截器上报的一次 REST 调用（维度 + handler 阶段耗时） */
export interface UsageStatsHttpCall extends UsageStatsDimensions {
  /** handler 阶段耗时（ms，不含 guard 认证） */
  latencyMs: number;
}

/** MCP 侧 fire-and-forget 上报的一次 tools/call（批 2 端点入参形状） */
export interface UsageStatsInvocationEvent {
  /** 工具名（≤128 截断；上报侧的 `'__invalid__'` 哨兵原样保留） */
  toolName: string;
  /** 暴露面（封闭词表，非法归 'unknown'） */
  surface: string;
  /** 工具调用是否成功（true → 2xx，false → 5xx） */
  ok: boolean;
  /** 工具调用耗时（ms） */
  latencyMs: number;
  /** 是否走 fallbackAuth（共享 --api-key）→ actor_type 标 'system' */
  viaFallbackAuth?: boolean;
  /** 上报方身份（批 2 端点从 request.agent 取）；缺省 NULL */
  actorId?: string | null;
}

/** flush 结果（调用方可观测；`skipped`/`failed` 都不是异常路径） */
export interface UsageStatsFlushResult {
  /** 本次提交的行数 */
  rows: number;
  /** 是否因在途 flush 被跳过（常规路径语义） */
  skipped: boolean;
  /** SQL 是否失败（失败时数据已合回 buffer，下轮重试） */
  failed: boolean;
}

/** 内存聚合单元（维度 + 三个累加列） */
interface UsageStatsAccumulator {
  dimensions: UsageStatsDimensions;
  callCount: number;
  latencySumMs: number;
  latencyMaxMs: number;
}

/** jsonb_to_recordset 的行形状（列名缩写与 SQL 内的 AS r(...) 别名一一对应） */
interface UsageStatsFlushRow {
  b: string;
  ch: string;
  sf: string;
  tn: string;
  m: string;
  rt: string;
  a: string | null;
  at: string;
  sc: string;
  cc: number;
  ls: number;
  lm: number;
}

/**
 * flush SQL（plan §3 定稿，PG 15.18 实测通过）——**逐字照抄，禁止就地优化**。
 *
 * 三个非显然点（删任何一个都会坏）：
 * 1. `GROUP BY` 批内去重：jsonb 数组内可能含同维度多行（同一键在本窗口被累加多次
 *    而 Map 只留一行——不会发生；但合回/重放场景可产生）→ 缺它报 21000
 *    "ON CONFLICT DO UPDATE command cannot affect row a second time"；
 * 2. `ORDER BY` 定序：两个后端并发 flush 时，行序不定 → 唯一索引上反向加锁死锁
 *    （实测反向序 4/10 死锁）；
 * 3. `ON CONFLICT` 显式全 9 列：与 NULLS NOT DISTINCT 唯一索引的列序严格一致。
 */
export const USAGE_STATS_INSERT_SQL = `
INSERT INTO api_usage_stats_hourly
  (bucket_start, channel, mcp_surface, tool_name, method, route, actor_id, actor_type, status_class,
   call_count, latency_sum_ms, latency_max_ms)
SELECT b, ch, sf, tn, m, rt, a, at, sc, sum(cc), sum(ls), max(lm)
FROM jsonb_to_recordset($1::jsonb) AS r(
  b timestamptz, ch varchar(8), sf varchar(16), tn varchar(128), m varchar(8),
  rt varchar(255), a uuid, at varchar(16), sc varchar(3), cc int, ls bigint, lm int)
GROUP BY b, ch, sf, tn, m, rt, a, at, sc   -- 批内去重（缺它 21000 报错）
ORDER BY b, ch, sf, tn, m, rt, a, at, sc   -- 定序防并发死锁（T9 反向序 4/10 死锁实测）
ON CONFLICT (bucket_start, channel, mcp_surface, tool_name, method, route, actor_id, actor_type, status_class)
DO UPDATE SET
  call_count     = api_usage_stats_hourly.call_count + EXCLUDED.call_count,
  latency_sum_ms = api_usage_stats_hourly.latency_sum_ms + EXCLUDED.latency_sum_ms,
  latency_max_ms = GREATEST(api_usage_stats_hourly.latency_max_ms, EXCLUDED.latency_max_ms);
`;

/** 键分隔符：NUL 不可能出现在路由模板、UUID、词表值或 HTTP 头值中 → 拼接无歧义 */
const KEY_SEPARATOR = '\u0000';

/**
 * 9 维 → Map 键（顺序 = 唯一索引列顺序；改序必须与 entity/migration 同步）。
 * 用分隔符拼接而非 JSON.stringify：每请求调用一次，纯字符串拼接无分配放大。
 */
function buildUsageStatsKey(dims: UsageStatsDimensions): string {
  return [
    dims.bucketStart.toISOString(),
    dims.channel,
    dims.mcpSurface,
    dims.toolName,
    dims.method,
    dims.route,
    dims.actorId ?? '',
    dims.actorType,
    dims.statusClass,
  ].join(KEY_SEPARATOR);
}

/**
 * 使用统计聚合与 flush 服务（应用级单例）。
 *
 * 数据流：采集入口 → 内存 Map（9 维键）→ setInterval flush → 单条批量 SQL
 * 走 `ON CONFLICT` 累加。crash/强杀最多丢一个 flush 周期的计数（≤USAGE_FLUSH_INTERVAL_MS），
 * 这是"预聚合而非明细表"口径的既定代价（D3）。
 *
 * 失败语义（全部 fail-open，统计管线永不反噬业务）：
 * - 采集入口同步、无 I/O、无 await——拦截器在请求路径上只做一次 Map 自增；
 * - flush 失败把整批**合回** buffer 等下轮重试（不清空），SQL 异常只记日志；
 * - setInterval 回调整体 try/catch（未捕获异常会打死进程）；
 * - 关停终局 flush 有 10s 护栏，超时即放弃。
 */
@Injectable()
export class UsageStatsBufferService implements OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(UsageStatsBufferService.name);

  /** 聚合 Map（唯一可变状态；flush 通过 swap 整体置换） */
  private buffer = new Map<string, UsageStatsAccumulator>();

  /** flush 定时器（onModuleDestroy 清理） */
  private readonly flushTimer: NodeJS.Timeout;

  /** 在途 flush promise（重入锁：常规路径跳过、关停路径等待） */
  private inFlight: Promise<UsageStatsFlushResult> | null = null;

  /** 生效的 flush 间隔（构造期解析一次，便于日志与测试断言） */
  readonly flushIntervalMs: number;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    this.flushIntervalMs = resolveUsageFlushIntervalMs(process.env.USAGE_FLUSH_INTERVAL_MS);
    this.flushTimer = setInterval(() => {
      // 回调整体 try/catch：定时器里抛出的未捕获异常会打死进程
      // （flush() 自带重入锁——在途时跳过本次，下个周期自然补上）
      void this.flush().catch((err) =>
        this.logger.error(
          `scheduled flush crashed: ${(err as Error).message}`,
          (err as Error).stack,
        ),
      );
    }, this.flushIntervalMs);
    // unref：定时器不阻止进程退出（测试/一次性脚本无需等这一个周期；
    // 生产进程由 HTTP server 持有，行为不变）
    this.flushTimer.unref?.();
    this.logger.log(`usage stats buffer started (flushIntervalMs=${this.flushIntervalMs})`);
  }

  /**
   * REST 采集入口（拦截器调用）：一次调用 = 1 次计数。
   * 刻意同步、无 I/O——调用方保证 fail-open 与 exactly-once（见拦截器）。
   */
  recordHttpCall(call: UsageStatsHttpCall): void {
    const { latencyMs, ...dimensions } = call;
    const latency = sanitizeLatency(latencyMs);
    this.add(dimensions, 1, latency, latency);
  }

  /**
   * MCP invocation 采集入口（批 2 `POST /system/usage-events` 调用，D4b）。
   *
   * 行的形状钉死为 `channel='mcp', method='TOOL', route='mcp://tools/call'`：
   * `groupBy=tool` 的 invocation 口径就靠 route 隔离（扇出 REST 行是另一口径）。
   *
   * `actor_type` 推导（'system' 的**唯一生产者**就是这里的分支）：
   * `viaFallbackAuth` 为真 = 调用方用的是共享 `--api-key`，身份不可信
   * （distinctActors 会失真）→ 标 'system'；否则上报方是持自己 API Key 的 Agent → 'agent'。
   * 刻意不接受外部传入的 actorType：否则 'system' 会有第二个生产者，去重标记失效。
   */
  recordInvocation(event: UsageStatsInvocationEvent): void {
    const latencyMs = sanitizeLatency(event.latencyMs);
    this.add(
      {
        bucketStart: toUtcHourBucket(new Date()),
        channel: USAGE_STATS_CHANNEL_MCP,
        mcpSurface: normalizeUsageSurface(event.surface),
        toolName: normalizeUsageToolName(event.toolName),
        method: USAGE_STATS_TOOL_METHOD,
        route: USAGE_STATS_TOOL_ROUTE,
        actorId: event.actorId ?? null,
        actorType: event.viaFallbackAuth ? USAGE_STATS_SYSTEM_ACTOR_TYPE : 'agent',
        // 上报只有成败两态：失败侧一律 5xx（工具错误无 HTTP 状态可继承）
        statusClass: event.ok ? '2xx' : '5xx',
      },
      1,
      latencyMs,
      latencyMs,
    );
  }

  /**
   * 执行一次 flush（测试直调入口；间隔调度与关停路径都汇到这里）。
   *
   * 重入锁语义：已有在途 flush 时**跳过**本次（返回 skipped=true）——
   * 常规路径不需要排队，下个周期自然补上；关停路径需要"等待"，走
   * `onApplicationShutdown()`（它先 await 在途 flush 再调用本方法）。
   *
   * 永不抛：SQL 失败会合回数据并返回 `failed=true`（调用方无需 try/catch）。
   */
  async flush(): Promise<UsageStatsFlushResult> {
    if (this.inFlight) {
      this.logger.debug('flush skipped: another flush is in flight');
      return { rows: 0, skipped: true, failed: false };
    }
    const running = this.executeFlush();
    this.inFlight = running;
    try {
      return await running;
    } finally {
      this.inFlight = null;
    }
  }

  /** 当前缓冲键数（运维/测试可观测；不暴露 Map 本体） */
  get bufferedKeyCount(): number {
    return this.buffer.size;
  }

  /** 清理 flush 定时器（模块销毁路径，避免句柄泄漏） */
  onModuleDestroy(): void {
    this.clearFlushTimer();
  }

  /**
   * 关停终局 flush（`app.enableShutdownHooks()` 后由 Nest 调用）。
   *
   * 顺序：清定时器 → 等在途 flush 结束 → 再跑一次终局 flush（把最后的计数落库）。
   * 10s 超时护栏：超时即放弃（DB 抖动时数据反正会丢，但不许拖住部署进程到
   * `kill -KILL`）。与常规路径的"跳过在途 flush"刻意相反——关停时被跳过的
   * 那一批就是**最后一批真实计数**。
   */
  async onApplicationShutdown(): Promise<void> {
    this.clearFlushTimer();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), USAGE_FLUSH_SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
      });
      const outcome = await Promise.race([this.flushAfterInFlight(), timeout]);
      if (outcome === 'timeout') {
        this.logger.warn(
          `shutdown flush timed out after ${USAGE_FLUSH_SHUTDOWN_TIMEOUT_MS}ms; ` +
            `${this.buffer.size} buffered buckets dropped (fail-fast by design)`,
        );
      }
    } catch (err) {
      // 关停路径绝不抛出：抛出去会把优雅关停变成异常退出
      this.logger.error(`shutdown flush failed: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 关停路径：先等在途 flush 落定，再执行终局 flush */
  private async flushAfterInFlight(): Promise<void> {
    const inFlight = this.inFlight;
    if (inFlight) {
      await inFlight.catch(() => undefined); // executeFlush 自吞异常，此处仅防御
    }
    await this.flush();
  }

  /**
   * 真正的 flush：swap → 批量 SQL → （失败）合回。
   *
   * swap 先置换再写库：写入期间新到的采集请求进入新 Map，不会被本轮吞掉。
   * 失败合回而非丢弃——丢弃等于静默丢一窗口计数（统计管线最不可接受的失败模式）。
   */
  private async executeFlush(): Promise<UsageStatsFlushResult> {
    const batch = this.buffer;
    this.buffer = new Map<string, UsageStatsAccumulator>();
    if (batch.size === 0) return { rows: 0, skipped: false, failed: false };

    const rows = Array.from(batch.values(), toFlushRow);
    try {
      await this.dataSource.query(USAGE_STATS_INSERT_SQL, [JSON.stringify(rows)]);
      return { rows: rows.length, skipped: false, failed: false };
    } catch (err) {
      this.mergeBack(batch);
      this.logger.error(
        `flush failed, ${rows.length} bucket(s) merged back for retry: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return { rows: 0, skipped: false, failed: true };
    }
  }

  /** 失败合回：逐累加器并回（走同一个 add，安全阀约束继续生效） */
  private mergeBack(batch: Map<string, UsageStatsAccumulator>): void {
    for (const acc of batch.values()) {
      this.add(acc.dimensions, acc.callCount, acc.latencySumMs, acc.latencyMaxMs);
    }
  }

  /**
   * 累加入口（唯一写 Map 的地方）：安全阀判定 → 坍缩 → 累加。
   *
   * 安全阀（D6）：键数达上限时，**新**键整键坍缩为溢出桶
   * （route='__overflow__' + tool_name='' + mcp_surface='unknown'，其余维度保留）。
   * 三字段同归是必须的：只改 route 会让 (tool, surface) 继续撑基数，坍缩失去意义。
   * `method='TOOL'` 豁免：invocation 行体量极小，坍缩会让工具统计从
   * `metric=invocations` 视野整体消失（口径专章点明此交互）。
   */
  private add(
    dimensions: UsageStatsDimensions,
    callCount: number,
    latencySumMs: number,
    latencyMaxMs: number,
  ): void {
    let dims = dimensions;
    let key = buildUsageStatsKey(dims);
    let acc = this.buffer.get(key);

    if (
      !acc &&
      dims.method !== USAGE_STATS_TOOL_METHOD &&
      this.buffer.size >= USAGE_STATS_MAX_KEYS
    ) {
      dims = {
        ...dims,
        route: USAGE_STATS_OVERFLOW_ROUTE,
        toolName: '',
        mcpSurface: USAGE_SURFACE_UNKNOWN,
      };
      key = buildUsageStatsKey(dims);
      acc = this.buffer.get(key);
    }

    if (!acc) {
      acc = { dimensions: dims, callCount: 0, latencySumMs: 0, latencyMaxMs: 0 };
      // 溢出桶本身允许在满额时创建（否则该次调用直接丢失，"溢出桶只保证总量正确"失效）；
      // 它是有界的：所有坍缩键归并到同一个键（每桶每窗口最多 +1 个键）
      this.buffer.set(key, acc);
    }

    acc.callCount += callCount;
    acc.latencySumMs += latencySumMs;
    acc.latencyMaxMs = Math.max(acc.latencyMaxMs, latencyMaxMs);
  }

  /** 清定时器（幂等：销毁与关停都会调用） */
  private clearFlushTimer(): void {
    clearInterval(this.flushTimer);
  }
}

/** 累加器 → SQL 行（字段名 = jsonb_to_recordset 别名；bigint 走 number，量级远低于 2^53） */
function toFlushRow(acc: UsageStatsAccumulator): UsageStatsFlushRow {
  const dims = acc.dimensions;
  return {
    b: dims.bucketStart.toISOString(),
    ch: dims.channel,
    sf: dims.mcpSurface,
    tn: dims.toolName,
    m: dims.method,
    rt: dims.route,
    a: dims.actorId,
    at: dims.actorType,
    sc: dims.statusClass,
    cc: acc.callCount,
    ls: acc.latencySumMs,
    lm: acc.latencyMaxMs,
  };
}

/**
 * 耗时归一：非有限值/负数归 0，小数四舍五入（列是 int，且 pg 对 number → int 会报错）。
 * 上报 DTO 已有 `latencyMs >= 0` 校验，这里是入库前的最后一道（fail-open 不抛）。
 */
function sanitizeLatency(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return 0;
  return Math.round(latencyMs);
}
