/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：**查询面**（GET /system/api-usage）的词表、默认值与口径常量
 *
 * [代码职责]
 *   - 查询参数词表（groupBy / metric / sortBy / order / channel / actorType）
 *   - 窗口默认值与上限（7 天默认 / 90 天硬上限的可操作文案）
 *   - 口径隔离用的 SQL 常量（invocation 口径的路由前缀、错误状态类定义）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 统计口径专章（invocation vs
 *     rest_calls 两口径、groupBy=actor 单位混用、TOOL 行无 3xx/4xx、90 天上限理由）
 *   - 补充: docs/database.md §api_usage_stats_hourly — 各列取值域
 *
 * [关键不变量]
 *   - **`sortBy` 词表刻意不含 `distinctActors`**：该字段由 pass2 二次查询得到，
 *     不在 pass1 的聚合结果里——放进排序会让 SQL 静默按错误的键排序（D8 钉死）
 *   - `metric` 只在 `groupBy=tool` 有意义；与别的 groupBy 同传 = 400（见 service
 *     的口径解析），**不得静默忽略**（调用方会误读自己拿到的口径）
 *   - 两口径的路由锚点来自批 1 常量（`USAGE_STATS_TOOL_ROUTE` / 通道常量），
 *     禁止在本文件重抄字面量——锚点漂移会让口径隔离静默失效
 *   - `API_USAGE_ERROR_STATUS_CLASSES` 是 errorRate 的**唯一**定义源：SQL 片段与
 *     JS 计算必须同源（两处各写一份会让「排序结果」与「回显数值」互相打架）
 *
 * [关联代码]
 *   - api-usage-query.service.ts — 唯一消费方（口径解析 + 两个 pass 的 SQL）
 *   - dto/api-usage-query.dto.ts — 格式层校验（枚举/范围），与本文档词表同源
 *   - usage-stats.constants.ts — 批 1 词表（surface 词表、通道常量、上报行路由锚点）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（词表改动是否波及 DTO 与 SQL）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  USAGE_STATS_CHANNEL_MCP,
  USAGE_STATS_CHANNEL_REST,
  USAGE_STATS_SYSTEM_ACTOR_TYPE,
  USAGE_STATS_TOOL_ROUTE,
  USAGE_SURFACE_VALUES,
  USAGE_TOOL_NAME_MAX_LENGTH,
} from './usage-stats.constants';

/** `groupBy` 词表（必填参数）：按路由模板 / MCP 工具 / 调用者三个维度聚合 */
export const API_USAGE_GROUP_BY_VALUES = ['route', 'tool', 'actor'] as const;

/** `groupBy` 取值类型 */
export type ApiUsageGroupBy = (typeof API_USAGE_GROUP_BY_VALUES)[number];

/** `metric` 词表（仅 groupBy=tool 有意义）：invocation 计数 vs 扇出 REST 行 */
export const API_USAGE_METRIC_VALUES = ['invocations', 'rest_calls'] as const;

/** `metric` 取值类型 */
export type ApiUsageMetric = (typeof API_USAGE_METRIC_VALUES)[number];

/**
 * `metric` 缺省值 = `invocations`（D8）。
 * 缺省即生效：`groupBy=tool` 不传 metric 时端点自己钉住 invocation 口径
 * （不靠调用方自觉带参数——§6 测试契约的不变量之一）。
 */
export const API_USAGE_DEFAULT_METRIC: ApiUsageMetric = 'invocations';

/**
 * `metric=invocations` 的口径锚点 = 上报行固定路由（批 1 常量，值 `mcp://tools/call`）。
 * 单列出来是为了让 service 的「口径隔离」读起来是一句话而不是一段 SQL。
 */
export const API_USAGE_INVOCATION_ROUTE = USAGE_STATS_TOOL_ROUTE;

/**
 * `metric=rest_calls` 的口径锚点 = `channel='rest'` **且** `tool_name <> ''`。
 * 语义 = "MCP 工具调用扇出到 REST 的那些行"（automcp 代理带 X-MCP-Tool 头打到后端），
 * 与 invocation 行（channel='mcp'）刻意区分。
 */
export const API_USAGE_FANOUT_CHANNEL = USAGE_STATS_CHANNEL_REST;

/**
 * `sortBy` 词表（**刻意排除 `distinctActors`**，见 [关键不变量]）。
 * 默认 `callCount`：热度的主排序键。
 */
export const API_USAGE_SORT_BY_VALUES = ['callCount', 'avgLatencyMs', 'errorRate'] as const;

/** `sortBy` 取值类型 */
export type ApiUsageSortBy = (typeof API_USAGE_SORT_BY_VALUES)[number];

/** `sortBy` 缺省值 */
export const API_USAGE_DEFAULT_SORT_BY: ApiUsageSortBy = 'callCount';

/** `order` 词表 */
export const API_USAGE_ORDER_VALUES = ['asc', 'desc'] as const;

/** `order` 取值类型 */
export type ApiUsageOrder = (typeof API_USAGE_ORDER_VALUES)[number];

/** `order` 缺省值：降序（热度榜/耗时榜的默认读法） */
export const API_USAGE_DEFAULT_ORDER: ApiUsageOrder = 'desc';

/** `limit` 缺省值（top-N 键数） */
export const API_USAGE_DEFAULT_LIMIT = 20;

/** `limit` 下限（0/负数会让 SQL LIMIT 语义失真） */
export const API_USAGE_MIN_LIMIT = 1;

/** `limit` 上限 100：distinctActors 二次查询的选择率随 N 线性放大，100 是实测安全位 */
export const API_USAGE_MAX_LIMIT = 100;

/** 缺省窗口 = 最近 7 天（D8） */
export const API_USAGE_DEFAULT_WINDOW_DAYS = 7;

/**
 * 窗口跨度硬上限 90 天（D8）。
 * 为什么是 90：13 个月带 distinctActors 实测 4.8s + 1.6GB temp，90 天钉在 ~1.3s；
 * 更长历史走 SQL 配方（文档专章）。超限 → 400 且文案必须可操作。
 */
export const API_USAGE_MAX_SPAN_DAYS = 90;

/** 一天的毫秒数（窗口推导与跨度判定共用，避免两处各写一个魔数） */
export const API_USAGE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 跨度超限的 400 文案（D8 逐字要求可操作）。
 * @param spanDays 实际跨度（天，已向上取整，保证 ≥ 报告值）
 */
export function buildApiUsageMaxSpanMessage(spanDays: number): string {
  return (
    `时间跨度 ${spanDays} 天超过上限 ${API_USAGE_MAX_SPAN_DAYS} 天：` +
    `请分段查询，>${API_USAGE_MAX_SPAN_DAYS} 天对比走 SQL 配方`
  );
}

/** `channel` 过滤词表（值域来自批 1 通道常量） */
export const API_USAGE_CHANNEL_VALUES = [
  USAGE_STATS_CHANNEL_REST,
  USAGE_STATS_CHANNEL_MCP,
] as const;

/**
 * `actorType` 过滤词表 = 本表 `actor_type` 列的取值域（D7）。
 * ⚠️ 这里的 `'system'` 是 **MCP fallback-auth 归因标记**（共享 `--api-key`），
 * 不是 actors 表里的平台 system actor——过滤时不要按字面理解。
 */
export const API_USAGE_ACTOR_TYPE_VALUES = [
  'agent',
  'human',
  USAGE_STATS_SYSTEM_ACTOR_TYPE,
  'anonymous',
] as const;

/** `surface` 过滤词表 = D4c 封闭词表（批 1 单一定义点，禁止重抄） */
export const API_USAGE_SURFACE_VALUES = USAGE_SURFACE_VALUES;

/**
 * 计入 `errorRate` 分子的状态类（分母 = 全部 callCount）。
 * 只算 4xx/5xx：3xx 是重定向不是失败，且 **TOOL 行只有 2xx/5xx 两态**
 * （上报只有成败两态，见 D4b）——口径专章点明。
 */
export const API_USAGE_ERROR_STATUS_CLASSES = ['4xx', '5xx'] as const;

/** 错误状态类的 SQL 字面量（常量拼接，非用户输入——无注入面） */
export const API_USAGE_ERROR_STATUS_SQL_LITERAL = API_USAGE_ERROR_STATUS_CLASSES.map(
  (cls) => `'${cls}'`,
).join(', ');

/**
 * `groupBy=route` 默认排除的 MCP 内部路由前缀（D8）。
 * 排除的是上报行（`mcp://tools/call`）与任何 `mcp://` 伪路由——否则工具口径的行
 * 会混进"REST 路由热度榜"。显式传 `route` 参数时该默认排除被覆盖。
 */
export const API_USAGE_MCP_ROUTE_LIKE = 'mcp://%';

/** `groupBy=actor` 回显：actor 硬删/未建（LEFT JOIN 无命中）时的占位名 */
export const API_USAGE_DELETED_ACTOR_LABEL = 'deleted actor';

/**
 * `groupBy=actor` 回显：`actor_id IS NULL` 行的占位名。
 * 与 `'deleted actor'` 刻意区分：NULL 是"未认证/上报未带身份"的匿名流量，
 * 不是"调用者已被删除"（两者含义完全不同，混用会误读活跃度）。
 */
export const API_USAGE_ANONYMOUS_ACTOR_LABEL = 'anonymous';

/** `route` 过滤值上限 = 列宽 varchar(255)（DTO 层拦截超长，防 PG 22001→500） */
export const API_USAGE_ROUTE_MAX_LENGTH = 255;

/** `tool` 过滤值上限 = 列宽 varchar(128)（与上报 DTO 同源常量） */
export const API_USAGE_TOOL_NAME_MAX_LENGTH = USAGE_TOOL_NAME_MAX_LENGTH;

/** `method` 过滤值上限 = 列宽 varchar(8) */
export const API_USAGE_METHOD_MAX_LENGTH = 8;
