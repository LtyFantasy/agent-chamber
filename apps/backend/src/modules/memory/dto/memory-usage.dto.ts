/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory **Usage 读面**（`GET /memory/projects/:id/usage/summary|trace`）的请求 DTO：
 *     四个开放字符串过滤器 + 严格 RFC3339 时间窗 + trace 的 limit/cursor
 *
 * [代码职责]
 *   - 只做**格式正确性**（铁律 #21 层 1）：词表外的未知属性由全局
 *     `forbidNonWhitelisted` 拒绝；时间窗必须**带时区**、`since < until`、跨度 ≤90 天；
 *     `cursor` 必须与显式 `since`/`until` 同时出现
 *   - 业务闸门（项目读权限、共享/claim、引擎可用性、默认时间窗物化）在
 *     `memory-usage.service.ts`
 *
 * [权威文档]
 *   - 合同事实源（只读）: `~/.hument/chamber-dev/upgrade-alpha19/hument-v1.yaml`
 *     的 `/v1/usage/summary|trace` parameters + `usage-{summary,trace}.schema.json`
 *   - 平台口径: 计划 `constantine-pantha-lockjaw.md` §2.1/§2.2/§3.2
 *
 * [关键不变量]
 *   - **`scope` / `workspaceId` / `actorId` 不在本 DTO**：身份由项目注册表派生，`scope`
 *     恒 `actor_private`。客户端自带这些键（或 `body`）会被 `forbidNonWhitelisted` **400**——
 *     fail-closed 是设计意图（作用域与身份不在调用方的选择面里）。
 *   - **summary 与 trace 是两个闭合词表**：summary **没有** `limit`/`cursor`（合同 summary
 *     不分页），trace 才有。`limit=0` 是"无上限"，**平台拒绝**（会扫全 binding）；范围 1–200。
 *   - **时间必须带时区**：`2026-10-24T00:00:00`（无 Z/偏移）会被拒——引擎按 UTC 解释，
 *     无时区的串在不同进程里是不同瞬间。RFC3339Nano 的小数秒允许（逐字透传，**不做 Date
 *     转换**：`String(date)` 会变成 RFC2822 被引擎 400）。
 *   - **`since`/`until` 同时给或同时不给**：只给一侧 = 无界窗口（可超过 90 天上限），
 *     故边界层直接 400。两侧都不给 ⇒ 服务层物化一次 7 天绝对窗口并经 `engine.filter` 回声。
 *   - **带 `cursor` 必须显式带 `since`/`until`**：游标绑定的是**首页的绝对时间窗**，
 *     服务层不得在第二页重新计算"现在"（否则每页窗口都不同，引擎 409/400）。
 *   - **开放字符串不收窄**：`operation` / `providerOperation` / `model` 只限长度，
 *     不硬编词表（合同是开放 string；收窄 = 与合同竞速的第二个漂移面）。
 *   - **`model` 做 trim**（边界层唯一允许的"改写"）：首尾空白是复制粘贴噪声，不是模型名的一部分。
 *
 * [关联代码]
 *   - ../memory-usage.service.ts — 本 DTO 的唯一消费方（默认窗口/权限/engine query 装配）
 *   - ../memory.constants.ts — 上限单源（每个上限都有"为什么是它"的注释）
 *   - ../engines/hument.engine.ts — 合同参数全集（本 DTO 是它的真子集）
 *
 * [修改检查]
 *   □ 已读 [权威文档] + Hument 合同，逐字段核对（**禁止凭记忆写字段名/上限**）
 *   □ 新增过滤器必须同步：引擎入参类型 + 服务层 query 装配 + 响应回声断言
 *   □ 改上限必须同步 `memory.constants.ts` 与其 e2e 边界用例（两处不同步 = 一边说谎）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  MEMORY_USAGE_CURSOR_MAX_LENGTH,
  MEMORY_USAGE_FILTER_MAX_LENGTH,
  MEMORY_USAGE_MODEL_MAX_LENGTH,
  MEMORY_USAGE_TRACE_LIMIT_MAX,
  MEMORY_USAGE_WINDOW_MAX_DAYS,
} from '../memory.constants';

/**
 * 带时区 RFC3339 时间戳（`Z` 或 `±hh:mm`；允许小数秒）。
 *
 * ⚠️ 只做形态门 + `Date.parse` 可解析；不做时区归一化（**逐字透传**，归一化是引擎的事）。
 */
const RFC3339_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 带时区 RFC3339 校验（`registerDecorator`；不导出约束类——见 `memory-view.dto.ts` 同款理由）。
 */
function IsRfc3339WithTimezone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isRfc3339WithTimezone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          if (!RFC3339_WITH_TIMEZONE.test(value)) return false;
          return !Number.isNaN(Date.parse(value));
        },
        defaultMessage(args: ValidationArguments) {
          return (
            `${args.property} must be a timezone-bearing RFC3339 timestamp ` +
            '(e.g. 2026-10-24T00:00:00Z or 2026-10-24T08:00:00+08:00); a timestamp without a ' +
            'timezone is ambiguous and is rejected. 时间必须带时区'
          );
        },
      },
    });
  };
}

/**
 * 时间窗校验（挂在 `until` 上）：`since < until` 且跨度 ≤ `MEMORY_USAGE_WINDOW_MAX_DAYS` 天。
 *
 * 任一侧不是可解析字符串时返回 true（交给字段级校验报错，避免同一问题两条文案）。
 */
function IsMemoryUsageWindow(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isMemoryUsageWindow',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const since = (args.object as { since?: unknown }).since;
          if (typeof value !== 'string' || typeof since !== 'string') return true;
          const start = Date.parse(since);
          const end = Date.parse(value);
          if (Number.isNaN(start) || Number.isNaN(end)) return true;
          if (end <= start) return false;
          return end - start <= MEMORY_USAGE_WINDOW_MAX_DAYS * 24 * 60 * 60 * 1000;
        },
        defaultMessage() {
          return (
            'until must be greater than since, and the window must not exceed ' +
            `${MEMORY_USAGE_WINDOW_MAX_DAYS} days. 时间窗必须 since < until 且不超过 ` +
            `${MEMORY_USAGE_WINDOW_MAX_DAYS} 天`
          );
        },
      },
    });
  };
}

/**
 * cursor 与时间窗的联合校验（挂在 `cursor` 上）：带 cursor 必须显式给 `since` + `until`。
 *
 * 理由：游标绑定首页的绝对时间窗；服务层若在第二页"重新计算现在"，窗口会漂移，
 * 引擎按合同拒绝（409/400），客户端看到的是无法解释的 cursor_reset_required。
 */
function IsUsageCursorWindow(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isUsageCursorWindow',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          if (value === undefined) return true;
          const dto = args.object as { since?: unknown; until?: unknown };
          return typeof dto.since === 'string' && typeof dto.until === 'string';
        },
        defaultMessage() {
          return (
            'cursor requires explicit since AND until (send back the exact window of page 1, ' +
            'including precision). 带 cursor 时必须显式传 since 与 until'
          );
        },
      },
    });
  };
}

/**
 * Usage 过滤与时间窗（summary / trace 共用基类）。
 *
 * ⚠️ 两侧时间**同时给或同时不给**：只给一侧 = 无界窗口，会绕过 90 天上限。
 */
export class QueryMemoryUsageFilterDto {
  /** 精确操作名（合同开放 string；`formation` / `recall` / …，长度上限只为护栏） */
  @ApiPropertyOptional({
    description:
      'Exact operation (open string per the engine contract; e.g. formation / recall / ' +
      'relation_advisory / navigation_consolidation / provider_mutation)',
    maxLength: MEMORY_USAGE_FILTER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(1, MEMORY_USAGE_FILTER_MAX_LENGTH)
  operation?: string;

  /** 精确 provider 操作名（合同开放 string） */
  @ApiPropertyOptional({
    description:
      'Exact provider operation (open string; e.g. generation / embedding / rerank / ' +
      'relation_judgment)',
    maxLength: MEMORY_USAGE_FILTER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(1, MEMORY_USAGE_FILTER_MAX_LENGTH)
  providerOperation?: string;

  /** 精确 model（匹配 requested **或** resolved；trim 后长度 1–200） */
  @ApiPropertyOptional({
    description:
      'Exact requested OR resolved model (a record matches once). Leading/trailing whitespace is ' +
      'trimmed; the value is otherwise passed through verbatim.',
    maxLength: MEMORY_USAGE_MODEL_MAX_LENGTH,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, MEMORY_USAGE_MODEL_MAX_LENGTH)
  model?: string;

  /** 区间左端（含；**必须带时区**的 RFC3339；与 until 同时给或同时不给） */
  @ApiPropertyOptional({
    description:
      'Inclusive lower bound (physical request start) as a timezone-bearing RFC3339 timestamp. ' +
      'Provide BOTH since and until, or neither (the server materializes a 7-day window once and ' +
      'echoes it in engine.filter).',
  })
  @ValidateIf((o: QueryMemoryUsageFilterDto) => o.since !== undefined || o.until !== undefined)
  @IsDefined()
  @IsString()
  @IsRfc3339WithTimezone()
  since?: string;

  /** 区间右端（**不含**；同上） */
  @ApiPropertyOptional({
    description:
      'Exclusive upper bound (physical request start) as a timezone-bearing RFC3339 timestamp. ' +
      'Must be greater than since; the window may not exceed 90 days.',
  })
  @ValidateIf((o: QueryMemoryUsageFilterDto) => o.since !== undefined || o.until !== undefined)
  @IsDefined()
  @IsString()
  @IsRfc3339WithTimezone()
  @IsMemoryUsageWindow()
  until?: string;
}

/**
 * summary 入参（`GET /memory/projects/:id/usage/summary`）。
 *
 * **没有 `limit`/`cursor`**：合同 summary 不分页，`totals` 恒覆盖完整匹配集。多传这两个键
 * （或 `scope`/`workspaceId`/`actorId`/`body`）会被全局白名单拒成 400。
 */
export class QueryMemoryUsageSummaryDto extends QueryMemoryUsageFilterDto {}

/**
 * trace 入参（`GET /memory/projects/:id/usage/trace`）。
 *
 * `limit` 省略时服务层显式发 100（不是"让引擎用配置默认"）；`cursor` 必须与首页的
 * `since`/`until`/filter/limit 一起回送。
 */
export class QueryMemoryUsageTraceDto extends QueryMemoryUsageFilterDto {
  /** 页大小（1–200；**0 = 无上限被平台拒绝**） */
  @ApiPropertyOptional({
    type: 'integer',
    description:
      'Page size (1–200; omitted = 100). Zero is rejected: it means "no limit" in the engine ' +
      'contract and would scan the whole binding. Every page must repeat the same limit.',
    minimum: 1,
    maximum: MEMORY_USAGE_TRACE_LIMIT_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEMORY_USAGE_TRACE_LIMIT_MAX)
  limit?: number;

  /** 不透明续页游标（绑定 target + filter + limit + 数据快照；带它必须显式给 since/until） */
  @ApiPropertyOptional({
    description:
      'Opaque continuation cursor bound to target, filters, page size and the data snapshot. ' +
      "When present, since AND until are REQUIRED (send back page 1's exact window). A snapshot " +
      'change answers 409; a filter/limit mismatch answers 400 — both surface as 502/14004 with ' +
      'hintCode=cursor_reset_required.',
    maxLength: MEMORY_USAGE_CURSOR_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(1, MEMORY_USAGE_CURSOR_MAX_LENGTH)
  @IsUsageCursorWindow()
  cursor?: string;
}
