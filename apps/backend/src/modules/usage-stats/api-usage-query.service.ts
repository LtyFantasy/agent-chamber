/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：**查询面**（GET /system/api-usage）的聚合实现
 *
 * [代码职责]
 *   - 查询口径解析与强制（groupBy × metric × 显式 route 的互斥与默认锚定）
 *   - 窗口归一（默认最近 7 天 / 90 天上限）/ 过滤条件绑定 / 原生聚合 SQL
 *   - `distinctActors` 二次查询（只对 pass1 返回的 top-N 键）
 *   - `meta` 覆盖度回显（全表 MIN(bucket_start) → 数据覆盖天数）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 统计口径专章
 *     （invocation vs rest_calls 两口径 / groupBy=actor 单位混用 / TOOL 行无 3xx/4xx /
 *      90 天上限理由 / distinctActors 只数已认证调用者 / 最小观察窗口 ≥4 周）
 *   - 补充: docs/database.md §api_usage_stats_hourly — 保留策略与索引
 *
 * [关键不变量]
 *   - **口径默认由端点强制，不靠调用方自觉**：`groupBy=tool` 不传 metric 时也锚定
 *     invocation 行（`route='mcp://tools/call'`）；`groupBy=route` 默认排除 `mcp://%`
 *   - **互斥即 400，不静默忽略**：`metric=invocations`（含默认）× 显式 `route`；
 *     `metric` × `groupBy<>tool`；`to < from` → 400（静默取反会返回空集，调用方误判"零使用"）
 *   - `distinctActors` 走**独立第二 pass**，只对 pass1 的 top-N 键做 `COUNT(DISTINCT actor_id)`：
 *     选择率驱动，**不为它加 route 索引**（实测 +24% 体积换 ~300ms 不划算）；`sortBy`
 *     词表因此排除 `distinctActors`（pass1 排不了它）
 *   - `COUNT(DISTINCT actor_id)` **天然忽略 NULL**：匿名行的 distinctActors = 0，
 *     不是 1（口径专章点明）
 *   - 所有 bigint 出口显式 `Number()`：`SUM(call_count)` / `SUM(latency_sum_ms)` 是
 *     PG bigint，驱动读出为 **string**——直接回显会把数字变成字符串（前端/Agent 误读）
 *   - 过滤值一律**参数化绑定**（queryBuilder 具名参数），SQL 里只允许出现常量字面量
 *
 * [关联代码]
 *   - usage-stats-query.constants.ts — 词表/默认值/错误状态类单一定义点
 *   - dto/api-usage-query.dto.ts — 格式层校验（本文件只做业务口径）
 *   - usage-stats-buffer.service.ts — 本表唯一写入方（维度语义的源头）
 *   - api-usage.controller.ts — admin-only 入口（权限不在本层）
 *
 * [持久踩坑]
 *   USAGE-STATS-PASS2-MISMATCH(两 pass 过滤漂移): pass1（聚合 top-N）与 pass2
 *     （distinctActors）若各写一份 WHERE，口径一旦改一处，distinctActors 就与
 *     callCount 来自**不同集合**（数字自洽但错误，无任何报错）。安全方向: 两 pass
 *     共用同一个 applyScopeAndFilters()。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（尤其：两 pass 是否仍共用同一过滤）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ApiUsageStatsHourly } from '../../database/entities/api-usage-stats-hourly.entity';
import { ApiUsageQueryDto } from './dto/api-usage-query.dto';
import {
  API_USAGE_ANONYMOUS_ACTOR_LABEL,
  API_USAGE_DAY_MS,
  API_USAGE_DEFAULT_LIMIT,
  API_USAGE_DEFAULT_METRIC,
  API_USAGE_DEFAULT_ORDER,
  API_USAGE_DEFAULT_SORT_BY,
  API_USAGE_DEFAULT_WINDOW_DAYS,
  API_USAGE_DELETED_ACTOR_LABEL,
  API_USAGE_ERROR_STATUS_SQL_LITERAL,
  API_USAGE_FANOUT_CHANNEL,
  API_USAGE_INVOCATION_ROUTE,
  API_USAGE_MAX_SPAN_DAYS,
  API_USAGE_MCP_ROUTE_LIKE,
  buildApiUsageMaxSpanMessage,
  type ApiUsageGroupBy,
  type ApiUsageMetric,
  type ApiUsageOrder,
  type ApiUsageSortBy,
} from './usage-stats-query.constants';

/** 单条聚合结果（`key` = 该 groupBy 维度值；`null` 仅出现在 groupBy=actor 的匿名行） */
export interface ApiUsageItem {
  /** 维度值：route 模板 / tool_name / actor_id（匿名行为 null） */
  key: string | null;
  /** 窗口内调用次数 */
  callCount: number;
  /** 窗口内**已认证**调用者去重数（匿名行恒 0；pass2 二次查询得到） */
  distinctActors: number;
  /** 平均耗时（ms，handler 阶段；四舍五入到整数） */
  avgLatencyMs: number;
  /** 窗口内耗时峰值（ms） */
  maxLatencyMs: number;
  /** 错误率 = (4xx+5xx) 计数 / 总计数，保留 4 位小数（TOOL 行只有 2xx/5xx） */
  errorRate: number;
  /** 仅 `groupBy=actor`：调用者显示名（actor 行不存在 → 'deleted actor'；匿名行 → 'anonymous'） */
  actorName?: string;
  /** 仅 `groupBy=actor`：行的 actor_type（同键多值时取 MAX，见实现注释） */
  actorType?: string;
}

/**
 * 回显元信息。
 * 前四项是 D8 钉死的契约；`groupBy` / `metric` 是**口径回显**（缺省值时尤其重要：
 * 调用方必须能一眼看出"我拿到的到底是哪个口径"，而不是靠记忆猜 metric 的默认值）。
 * `metric` 在 `groupBy<>tool` 时为 `null`——该参数只对工具口径生效，回显一个
 * 不适用的值会误导读法。
 */
export interface ApiUsageMeta {
  /** 生效窗口起点（含），UTC ISO */
  windowFrom: string;
  /** 生效窗口终点（**不含**），UTC ISO */
  windowTo: string;
  /** 全表最早桶起点（数据从什么时候开始有），空表 → null */
  earliestBucketStart: string | null;
  /** 数据覆盖天数（windowTo − earliestBucketStart，1 位小数；空表 → null） */
  dataCoverageDays: number | null;
  /** 生效的聚合维度 */
  groupBy: ApiUsageGroupBy;
  /** 生效的 tool 口径（仅 groupBy=tool；其余为 null） */
  metric: ApiUsageMetric | null;
}

/** `GET /system/api-usage` 响应 */
export interface ApiUsageResponse {
  items: ApiUsageItem[];
  meta: ApiUsageMeta;
}

/**
 * 解析后的查询计划（口径 + 窗口 + 过滤值，全部已校验）。
 * 两 pass 共用它，保证"同一集合、同一口径"（见 [持久踩坑] 两 pass 过滤漂移）。
 */
interface ApiUsagePlan {
  groupBy: ApiUsageGroupBy;
  metric: ApiUsageMetric;
  /** 窗口起点（含） */
  from: Date;
  /** 窗口终点（不含） */
  to: Date;
  limit: number;
  sortBy: ApiUsageSortBy;
  order: ApiUsageOrder;
  /** 已通过 DTO 格式校验的过滤值（键即 SQL 参数名后缀） */
  filters: {
    channel?: string;
    surface?: string;
    actorType?: string;
    actorId?: string;
    route?: string;
    tool?: string;
    method?: string;
  };
  /** 口径隔离产生的附加条件（SQL 片段 + 具名参数；值全部来自常量，无用户输入拼接） */
  scope: Array<{ sql: string; params?: Record<string, string> }>;
}

/** groupBy → 聚合键表达式（原生 SQL 片段，列名一律带 `s.` 前缀防歧义） */
const KEY_EXPRESSIONS: Record<ApiUsageGroupBy, string> = {
  route: 's.route',
  tool: 's.tool_name',
  actor: 's.actor_id',
};

/** sortBy → 排序表达式（聚合表达式，不能是别名——别名与列同名会造成歧义） */
const ORDER_EXPRESSIONS: Record<ApiUsageSortBy, string> = {
  callCount: 'COALESCE(SUM(s.call_count), 0)',
  // ::numeric 必须：bigint/int 在 PG 里是**整数除法**，不转会截断（排序结果悄悄跑偏）
  avgLatencyMs:
    'CASE WHEN COALESCE(SUM(s.call_count), 0) > 0 ' +
    'THEN COALESCE(SUM(s.latency_sum_ms), 0)::numeric / SUM(s.call_count) ELSE 0 END',
  errorRate:
    `CASE WHEN COALESCE(SUM(s.call_count), 0) > 0 THEN COALESCE(SUM(` +
    `CASE WHEN s.status_class IN (${API_USAGE_ERROR_STATUS_SQL_LITERAL}) THEN s.call_count ELSE 0 END` +
    '), 0)::numeric / SUM(s.call_count) ELSE 0 END',
};

/** pass1 原始行（别名与 SQL 一致；bigint 列读出为 string，numeric 亦为 string） */
interface ApiUsageAggregateRow {
  key: string | null;
  call_count: string | number | null;
  latency_sum_ms: string | number | null;
  max_latency_ms: string | number | null;
  error_count: string | number | null;
  actor_name?: string | null;
  actor_type?: string | null;
}

/** pass2 原始行（distinctActors 二次查询） */
interface ApiUsageDistinctRow {
  key: string;
  distinct_actors: string | number | null;
}

/**
 * 调用频率查询服务（admin-only 端点 `GET /system/api-usage` 的实现，D8）。
 *
 * 数据流：DTO（格式校验）→ `resolveApiUsagePlan`（口径强制 + 窗口归一）
 * → pass1 聚合 top-N → pass2 补 distinctActors → meta 覆盖度回显。
 *
 * 权限不在这里（controller 的 guard 保证）；SQL 里所有用户输入都走具名参数绑定。
 */
@Injectable()
export class ApiUsageQueryService {
  constructor(
    @InjectRepository(ApiUsageStatsHourly)
    private readonly repo: Repository<ApiUsageStatsHourly>,
  ) {}

  /**
   * 执行一次查询。
   *
   * @param dto 已通过 DTO 格式校验的查询参数
   * @param now 窗口终点缺省值（注入以便单测断言"默认最近 7 天"，生产走当前时刻）
   * @returns items（top-N 聚合）+ meta（窗口与覆盖度回显）
   * @throws BadRequestException 口径互斥/跨度超限（400 + 可操作文案，铁律 #9）
   */
  async query(dto: ApiUsageQueryDto, now: Date = new Date()): Promise<ApiUsageResponse> {
    const plan = resolveApiUsagePlan(dto, now);

    const rows = await this.buildAggregateQuery(plan).getRawMany<ApiUsageAggregateRow>();
    const distinctActors = await this.readDistinctActors(plan, rows);
    const earliestBucketStart = await this.readEarliestBucketStart();

    return {
      items: rows.map((row) => toApiUsageItem(plan, row, distinctActors)),
      meta: {
        windowFrom: plan.from.toISOString(),
        windowTo: plan.to.toISOString(),
        earliestBucketStart: earliestBucketStart ? earliestBucketStart.toISOString() : null,
        dataCoverageDays: toDataCoverageDays(earliestBucketStart, plan.to),
        groupBy: plan.groupBy,
        metric: plan.groupBy === 'tool' ? plan.metric : null,
      },
    };
  }

  /**
   * pass1：按维度聚合 top-N（`GROUP BY` + `ORDER BY` + `LIMIT`）。
   *
   * 三个累加列按 SQL 语义聚合：`call_count`/`latency_sum_ms` 求和、
   * `latency_max_ms` 取 MAX（桶内已是 GREATEST 值，跨桶再取 MAX 即峰值）。
   * `error_count` 顺带取出——JS 侧算 errorRate，避免 numeric → string 回显。
   */
  private buildAggregateQuery(plan: ApiUsagePlan): SelectQueryBuilder<ApiUsageStatsHourly> {
    const keyExpression = KEY_EXPRESSIONS[plan.groupBy];
    const qb = this.repo
      .createQueryBuilder('s')
      .select(keyExpression, 'key')
      .addSelect('COALESCE(SUM(s.call_count), 0)', 'call_count')
      .addSelect('COALESCE(SUM(s.latency_sum_ms), 0)', 'latency_sum_ms')
      .addSelect('COALESCE(MAX(s.latency_max_ms), 0)', 'max_latency_ms')
      .addSelect(
        'COALESCE(SUM(CASE WHEN s.status_class IN (' +
          API_USAGE_ERROR_STATUS_SQL_LITERAL +
          ') THEN s.call_count ELSE 0 END), 0)',
        'error_count',
      );

    if (plan.groupBy === 'actor') {
      // 回显名走 LEFT JOIN actors（统计表刻意无 FK：actor 硬删后统计行仍在）。
      // display_name 外面套 MAX()：GROUP BY 键是 s.actor_id，PG 不允许裸的非分组列，
      // 而依赖"函数依赖推断"（ac.id = s.actor_id 的等价类）在不同 PG 版本上并非处处可靠。
      // MAX() 对该键恒定（join 命中即同一行），语义等价且不赌优化器行为。
      qb.leftJoin('actors', 'ac', 'ac.id = s.actor_id')
        .addSelect('MAX(s.actor_type)', 'actor_type')
        .addSelect(
          `COALESCE(MAX(ac.display_name), CASE WHEN s.actor_id IS NULL ` +
            `THEN '${API_USAGE_ANONYMOUS_ACTOR_LABEL}' ELSE '${API_USAGE_DELETED_ACTOR_LABEL}' END)`,
          'actor_name',
        );
    }

    applyScopeAndFilters(qb, plan);
    qb.groupBy(keyExpression);
    qb.orderBy(ORDER_EXPRESSIONS[plan.sortBy], plan.order === 'asc' ? 'ASC' : 'DESC');
    qb.limit(plan.limit);
    return qb;
  }

  /**
   * pass2：只对 pass1 返回的 top-N 键补 `COUNT(DISTINCT actor_id)`。
   *
   * 为什么独立一次查询而不并进 pass1：`COUNT(DISTINCT)` 与 `LIMIT` 放在同一条
   * 聚合里需要窗口函数或子查询，且会让全窗口扫描失去 LIMIT 的收窄效应；独立查询
   * 天然是"选择率驱动"（只回扫被选中的键）。
   *
   * 与 pass1 共用 `applyScopeAndFilters`（见 [持久踩坑]）：两 pass 若过滤漂移，
   * distinctActors 会与 callCount 来自不同集合——数字自洽但错误，且无任何报错。
   *
   * 键为 null（groupBy=actor 的匿名行）时不参与 IN 列表：匿名行没有可去重的身份，
   * 其 distinctActors 语义上就是 0。
   */
  private async readDistinctActors(
    plan: ApiUsagePlan,
    rows: ApiUsageAggregateRow[],
  ): Promise<Map<string, number>> {
    const keys = rows
      .map((row) => row.key)
      .filter((key): key is string => typeof key === 'string' && key.length > 0);
    if (keys.length === 0) return new Map<string, number>();

    const keyExpression = KEY_EXPRESSIONS[plan.groupBy];
    const qb = this.repo
      .createQueryBuilder('s')
      .select(keyExpression, 'key')
      .addSelect('COUNT(DISTINCT s.actor_id)', 'distinct_actors')
      .where(`${keyExpression} IN (:...keys)`, { keys });
    applyScopeAndFilters(qb, plan);
    qb.groupBy(keyExpression);

    const distinctRows = await qb.getRawMany<ApiUsageDistinctRow>();
    return new Map(distinctRows.map((row) => [row.key, toNumber(row.distinct_actors)]));
  }

  /**
   * 全表最早桶起点（覆盖度回显，**不加窗口过滤**——这是"数据从什么时候开始有"，
   * 不是"本次窗口内最早")。空表 → null。
   */
  private async readEarliestBucketStart(): Promise<Date | null> {
    const raw = await this.repo
      .createQueryBuilder('s')
      .select('MIN(s.bucket_start)', 'earliest')
      .getRawOne<{ earliest: Date | string | null }>();
    return toValidDate(raw?.earliest);
  }
}

/**
 * 解析查询计划：互斥校验 → 窗口归一 → 口径隔离条件。
 *
 * 互斥一律 **400 + 可操作文案**（不得静默忽略）：静默忽略会让调用方误读口径
 * （以为在看 A，实际拿到 B），这比拒绝更危险——统计数字没有"看起来对"的容错空间。
 *
 * @throws BadRequestException 三种情形：metric×groupBy≠tool、`groupBy=tool` 下
 *   metric=invocations×route、窗口跨度 >90 天（含 to < from 的退化情形）
 */
function resolveApiUsagePlan(dto: ApiUsageQueryDto, now: Date): ApiUsagePlan {
  const groupBy = dto.groupBy;

  // ① metric 只在 groupBy=tool 有意义。静默忽略会让 route/actor 分组的分组结果
  //    被误读成"某种工具口径"，故直接拒绝。
  if (dto.metric !== undefined && groupBy !== 'tool') {
    throw new BadRequestException({
      message:
        `metric 仅在 groupBy=tool 时有效（当前 groupBy=${groupBy}）：` +
        `该参数只描述 MCP 工具口径，按 ${groupBy} 分组时请去掉 metric`,
      code: 'API_USAGE_METRIC_NOT_APPLICABLE',
    });
  }
  const metric: ApiUsageMetric = dto.metric ?? API_USAGE_DEFAULT_METRIC;

  // ② 工具口径锚定 invocation 行时，再传 route 自相矛盾（D8：含 metric 的**缺省**情形）。
  //
  //    ⚠️ 该互斥**只在 groupBy=tool 内成立**——这是 D8 两条子句唯一自洽的读法：
  //    metric 与 groupBy≠tool 同传本身就是 400（①），若本互斥还跨 groupBy 生效，
  //    则 `groupBy=route&route=X` 永远命中"metric 缺省=invocations × route"= 400，
  //    D8 明写的「**显式 route 参数覆盖 groupBy=route 的默认排除**」将**无法被触达**。
  //    故互斥范围 = 工具口径内部（那里 route 已被口径固定，传它才叫矛盾）。
  if (groupBy === 'tool' && metric === 'invocations' && dto.route !== undefined) {
    throw new BadRequestException({
      message:
        'metric=invocations（默认口径）与 route 参数互斥：invocation 口径固定为 ' +
        `route='${API_USAGE_INVOCATION_ROUTE}'；若要看扇出 REST 行请用 metric=rest_calls`,
      code: 'API_USAGE_METRIC_ROUTE_CONFLICT',
    });
  }

  // ③ 窗口归一：to 缺省 = now，from 缺省 = to − 7 天；比较是绝对时刻比较
  const to = dto.to ? new Date(dto.to) : now;
  const from = dto.from ? new Date(dto.from) : new Date(to.getTime() - API_USAGE_DEFAULT_WINDOW_DAYS * API_USAGE_DAY_MS);
  const spanMs = to.getTime() - from.getTime();
  const maxSpanMs = API_USAGE_MAX_SPAN_DAYS * API_USAGE_DAY_MS;
  // to < from（spanMs < 0）同样落这里：静默返回空集会变成"零使用"的假结论
  if (spanMs > maxSpanMs || spanMs < 0) {
    throw new BadRequestException({
      message: buildApiUsageMaxSpanMessage(Math.ceil(Math.abs(spanMs) / API_USAGE_DAY_MS)),
      code: 'API_USAGE_SPAN_OUT_OF_RANGE',
    });
  }

  return {
    groupBy,
    metric,
    from,
    to,
    limit: dto.limit ?? API_USAGE_DEFAULT_LIMIT,
    sortBy: dto.sortBy ?? API_USAGE_DEFAULT_SORT_BY,
    order: dto.order ?? API_USAGE_DEFAULT_ORDER,
    filters: {
      channel: dto.channel,
      surface: dto.surface,
      actorType: dto.actorType,
      actorId: dto.actorId,
      route: dto.route,
      tool: dto.tool,
      method: dto.method,
    },
    scope: buildScopeConditions(groupBy, metric, dto.route !== undefined),
  };
}

/**
 * 口径隔离条件（D8 核心）：决定"这一组数字统计的是谁"。
 *
 * - `groupBy=tool` + `invocations`（默认）：只取 `route='mcp://tools/call'` 行
 *   ——工具口径**不受扇出影响**（扇出 REST 行是另一个口径）；
 * - `groupBy=tool` + `rest_calls`：`channel='rest'` 且 `tool_name<>''`（MCP 工具
 *   扇出到 REST 的那些行）；
 * - `groupBy=route`：默认排除 `mcp://%` 伪路由；**显式 route 参数覆盖该默认排除**
 *   （调用方明确点名要看某条 mcp:// 路由时，尊重其意图而不是静默过滤掉）；
 * - `groupBy=actor`：不设路由条件——invocation 行与扇出 REST 行**求和**
 *   （单位混用：一个是工具调用数、一个是 HTTP 请求数，只可用于活跃度排序，
 *    口径专章声明）。
 *
 * 返回的 SQL 片段只含常量字面量与具名参数占位符，**无用户输入拼接**。
 */
function buildScopeConditions(
  groupBy: ApiUsageGroupBy,
  metric: ApiUsageMetric,
  hasExplicitRoute: boolean,
): Array<{ sql: string; params?: Record<string, string> }> {
  if (groupBy === 'tool') {
    if (metric === 'rest_calls') {
      return [
        { sql: 's.channel = :scopeFanoutChannel', params: { scopeFanoutChannel: API_USAGE_FANOUT_CHANNEL } },
        { sql: "s.tool_name <> ''" },
      ];
    }
    return [
      { sql: 's.route = :scopeInvocationRoute', params: { scopeInvocationRoute: API_USAGE_INVOCATION_ROUTE } },
    ];
  }
  if (groupBy === 'route' && !hasExplicitRoute) {
    return [{ sql: 's.route NOT LIKE :scopeMcpRouteLike', params: { scopeMcpRouteLike: API_USAGE_MCP_ROUTE_LIKE } }];
  }
  return [];
}

/**
 * 把窗口、口径条件与用户过滤加到 queryBuilder 上（**两 pass 共用**，见文件头 [持久踩坑]）。
 *
 * 窗口是**半开区间** `from <= bucket_start < to`：`to` 缺省为当前时刻，含终点会把
 * 尚未走完的当前小时桶算进来（数字随调用时间抖动）。
 * 所有过滤值走具名参数绑定；`tool_name <> ''` 这类字面量只来自常量。
 */
function applyScopeAndFilters(qb: SelectQueryBuilder<ApiUsageStatsHourly>, plan: ApiUsagePlan): void {
  qb.where('s.bucket_start >= :windowFrom', { windowFrom: plan.from }).andWhere(
    's.bucket_start < :windowTo',
    { windowTo: plan.to },
  );

  for (const condition of plan.scope) {
    qb.andWhere(condition.sql, condition.params);
  }

  const { channel, surface, actorType, actorId, route, tool, method } = plan.filters;
  if (channel !== undefined) qb.andWhere('s.channel = :filterChannel', { filterChannel: channel });
  if (surface !== undefined) qb.andWhere('s.mcp_surface = :filterSurface', { filterSurface: surface });
  if (actorType !== undefined) qb.andWhere('s.actor_type = :filterActorType', { filterActorType: actorType });
  if (actorId !== undefined) qb.andWhere('s.actor_id = :filterActorId', { filterActorId: actorId });
  if (route !== undefined) qb.andWhere('s.route = :filterRoute', { filterRoute: route });
  if (tool !== undefined) qb.andWhere('s.tool_name = :filterTool', { filterTool: tool });
  if (method !== undefined) qb.andWhere('s.method = :filterMethod', { filterMethod: method });
}

/** 原始行 → 响应条目（bigint/numeric 一律显式 `Number()`，见 [关键不变量]） */
function toApiUsageItem(
  plan: ApiUsagePlan,
  row: ApiUsageAggregateRow,
  distinctActors: Map<string, number>,
): ApiUsageItem {
  const callCount = toNumber(row.call_count);
  const latencySumMs = toNumber(row.latency_sum_ms);
  const errorCount = toNumber(row.error_count);
  const item: ApiUsageItem = {
    key: row.key ?? null,
    callCount,
    // 匿名键（null）不在 pass2 的 IN 列表里 → 缺省 0（该组没有可去重的身份）
    distinctActors: row.key ? (distinctActors.get(row.key) ?? 0) : 0,
    avgLatencyMs: callCount > 0 ? Math.round(latencySumMs / callCount) : 0,
    maxLatencyMs: toNumber(row.max_latency_ms),
    errorRate: callCount > 0 ? Math.round((errorCount / callCount) * 10000) / 10000 : 0,
  };

  if (plan.groupBy === 'actor') {
    item.actorName = row.actor_name ?? API_USAGE_DELETED_ACTOR_LABEL;
    item.actorType = row.actor_type ?? undefined;
  }
  return item;
}

/**
 * bigint/numeric 出口归一：pg 驱动把 int8 与 numeric 读成 **string**，
 * 直接回显会让 JSON 里出现 `"callCount": "12"`（字符串）。非有限值归 0。
 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** 原始 timestamptz → Date（pg 已解析为 Date；字符串形态兜底，非法归 null） */
function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * 数据覆盖天数（1 位小数）。
 * 语义 = 「最早有数据的时刻 → 本次窗口终点」跨了多少天，供调用方判断
 * 「低频/零使用」结论是否满足 ≥4 周的最小观察窗口（D8）。空表 → null（而非 0：
 * 0 会被读成"有数据但覆盖 0 天"）。
 */
function toDataCoverageDays(earliest: Date | null, to: Date): number | null {
  if (!earliest) return null;
  const days = (to.getTime() - earliest.getTime()) / API_USAGE_DAY_MS;
  if (!Number.isFinite(days)) return null;
  return Math.round(Math.max(days, 0) * 10) / 10;
}
