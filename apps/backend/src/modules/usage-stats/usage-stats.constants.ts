/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：维度词汇表与取值归一化（封闭词表的单一定义点）
 *
 * [代码职责]
 *   - 维度常量（channel / method / route 哨兵）+ 基数安全阀阈值 + flush 间隔解析
 *   - `normalizeUsageSurface()` / `normalizeUsageToolName()`：两个采集入口
 *     （HTTP 头解析、上报 DTO）**共用**的收敛实现——词表只在这里定义一次
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 统计口径专章（词表 / 截断 / 坍缩）
 *   - 补充: docs/database.md §api_usage_stats_hourly — 各列取值域
 *
 * [关键不变量]
 *   - surface 是**封闭词表** `'' / 'mcp' / 'mcp-full' / 'unknown'`：PG 对超长
 *     varchar 报 22001 **不截断**，一个越界值会让整批 flush INSERT 全灭
 *     （静默失败 → 表长期零行），所以归一化必须发生在入库之前
 *   - `''`（非 MCP 流量）与 `'unknown'`（MCP 但暴露面不明）语义不同，不得互替
 *   - 安全阀坍缩必须**三字段同归**（route + tool_name + mcp_surface），
 *     只改其一会让维度基数不降反升（坍缩失去意义）
 *
 * [关联代码]
 *   - usage-stats.interceptor.ts — HTTP 头入口（缺失头 = `''`，非法头 = `'unknown'`）
 *   - usage-stats-buffer.service.ts — 坍缩阈值与溢出桶的消费方
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（两个入口是否仍共用本归一化）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

/** 通道：REST 请求（拦截器采集） */
export const USAGE_STATS_CHANNEL_REST = 'rest';

/** 通道：MCP invocation（automcp 上报行） */
export const USAGE_STATS_CHANNEL_MCP = 'mcp';

/** 上报行固定 method（同时是 D6 安全阀豁免坍缩的判定依据） */
export const USAGE_STATS_TOOL_METHOD = 'TOOL';

/** 上报行固定 route（口径隔离键：`groupBy=tool` 默认只取此行） */
export const USAGE_STATS_TOOL_ROUTE = 'mcp://tools/call';

/** 上报行固定 actor_type（viaFallbackAuth 归因标记；'system' 的唯一生产者） */
export const USAGE_STATS_SYSTEM_ACTOR_TYPE = 'system';

/** 基数安全阀溢出桶的 route 值（tool_name 同归 ''、mcp_surface 同归 'unknown'） */
export const USAGE_STATS_OVERFLOW_ROUTE = '__overflow__';

/** MCP 暴露面词表（D4c）：`''` = 非 MCP 流量；`'unknown'` = MCP 但暴露面不明 */
export const USAGE_SURFACE_VALUES: readonly string[] = ['', 'mcp', 'mcp-full', 'unknown'];

/** 非法/不可证的 surface 一律归此值（词表内合法值，非"丢弃"） */
export const USAGE_SURFACE_UNKNOWN = 'unknown';

/** 非 MCP 直连流量的 surface（'' 是词表内合法值，与 'unknown' 语义不同） */
export const USAGE_SURFACE_NONE = '';

/** MCP 工具名截断长度（与列宽 varchar(128) 一致；D5 收敛防基数爆炸） */
export const USAGE_TOOL_NAME_MAX_LENGTH = 128;

/**
 * 每 flush 周期 Map 键数上限（D6 基数安全阀）。
 * 5000 的取舍：正常流量下键数由「小时桶 × 路由模板 × 4 个状态类」决定，
 * 量级几百；5000 只在异常基数（伪造头 / 路由爆炸）时才触顶，
 * 触顶后新键整键坍缩为溢出桶——只保证总量正确，牺牲明细。
 */
export const USAGE_STATS_MAX_KEYS = 5000;

/** `USAGE_FLUSH_INTERVAL_MS` 缺省值（D10）：60s ≈ crash 最多丢一窗计数 */
export const USAGE_FLUSH_DEFAULT_INTERVAL_MS = 60_000;

/**
 * 间隔下限 1s：防误配 0/负数退化成忙循环（setInterval(0) 每毫秒触发一次）。
 * 非正整数一律回落缺省值（fail-open，不因配置错误拒绝启动）。
 */
export const USAGE_FLUSH_MIN_INTERVAL_MS = 1_000;

/**
 * 关停终局 flush 的超时护栏（10s）。
 * 为什么必须有：DB 抖动时写连接会一直等到 PG/驱动的连接超时，把部署脚本卡到
 * `kill -KILL`——数据照样丢，却拖长了停机窗口。宁可快速失败。
 */
export const USAGE_FLUSH_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * 归一化 MCP 暴露面（D4c 封闭词表）。
 *
 * @param raw 原始取值（HTTP 头字面值 / 上报 DTO 字段）
 * @returns 词表内取值；空值或词表外取值（含超长）一律归 `'unknown'`
 *
 * ⚠️ 调用方负责区分"头缺失"与"头非法"：缺失应传 `''`（非 MCP 直连流量），
 * 非法才传原值来此归一（见 usage-stats.interceptor.ts）。
 */
export function normalizeUsageSurface(raw: unknown): string {
  if (typeof raw !== 'string') return USAGE_SURFACE_UNKNOWN;
  return USAGE_SURFACE_VALUES.includes(raw) ? raw : USAGE_SURFACE_UNKNOWN;
}

/**
 * 归一化 MCP 工具名：按**码点**截断到 128（D5）。
 *
 * 为什么按码点而非 `slice()`：`slice()` 按 UTF-16 码元切分，可能切出孤立代理项，
 * 落库时被驱动替换为 U+FFFD（名字被悄悄改坏）；`Array.from` 按码点迭代不会切开
 * 代理对，且码点数 ≤ 码元数，天然满足 varchar(128) 的字符数约束。
 */
export function normalizeUsageToolName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const codePoints = Array.from(raw);
  return codePoints.length <= USAGE_TOOL_NAME_MAX_LENGTH
    ? raw
    : codePoints.slice(0, USAGE_TOOL_NAME_MAX_LENGTH).join('');
}

/**
 * HTTP 状态码 → 状态类（D7：`Math.floor(status/100) + 'xx'`）。
 *
 * 越界值（NaN / <100 / >599）归 `'5xx'`：列宽 varchar(3) 装不下异常形态，
 * 且"状态不可证"按服务端错误计比按成功计更安全。
 */
export function toStatusClass(status: number): string {
  if (!Number.isFinite(status) || status < 100 || status > 599) return '5xx';
  return `${Math.floor(status / 100)}xx`;
}

/**
 * UTC 小时桶起点（应用侧截断，D3——不用 DB `date_trunc`）。
 * `setUTCMinutes(0,0,0)` 同时清分/秒/毫秒；用 UTC 系列方法保证与 host 时区无关。
 */
export function toUtcHourBucket(at: Date): Date {
  const bucket = new Date(at.getTime());
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

/**
 * 解析 `USAGE_FLUSH_INTERVAL_MS`（D10）：非正整数或不可解析一律回落 60000。
 * fail-open 而非 fail-fast：这是统计管线的节奏参数，配错不该拒绝启动。
 */
export function resolveUsageFlushIntervalMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < USAGE_FLUSH_MIN_INTERVAL_MS) {
    return USAGE_FLUSH_DEFAULT_INTERVAL_MS;
  }
  return parsed;
}
