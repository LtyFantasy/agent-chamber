/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）列表 / 检索请求 DTO（GET /experiences 与 /facets 共用）
 *
 * [代码职责]
 *   - q / signals / domains / env 四键 / intent / quality / sourceProject / includeExpired /
 *     includeSuspect / sort / page / pageSize 的格式校验与查询串形态归一
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §2（匹配契约 + 传参协议）/§3（GET 契约）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章（序列化协议）
 *
 * [关键不变量]
 *   - **数组参数 = 重复 query 参数**（`?signals=a&signals=b`），单值自动包成单元素数组；
 *     元素含逗号一律 400（校验器文案给出正确写法）——**禁按逗号 split**（对比 task 模块
 *     labels 的逗号拆分先例，本模块刻意相反，理由见 experience-field.validators.ts 踩坑）
 *   - **`signals[]=` 括号形态由 controller 的原始查询串守卫拦下**（本 DTO 拦不住：
 *     Express 的 qs 解析器会把 `signals[]` 归一成 `signals`，DTO 看到的是"合法数组"）。
 *     DTO 只负责"值"层面的校验，形态层面见 experience-query-form.ts
 *   - `includeSuspect` 是 **admin 或空间 owner/reviewer** 语义（第二期放宽）：DTO 放行、
 *     service 判权（400/403 的判定需要真实身份，DTO 拿不到 actor）；`quality='suspect'`
 *     的豁免是**任何人**可用（复核动线）
 *   - 归一化（trim+lowercase）在 service：`?signals=ECONNREFUSED` 与库中小写值必须能
 *     匹配上，故查询侧与写侧走同一套归一化
 *
 * [关联代码]
 *   - experience.service.ts search()/facets() — 过滤谓词与排序的构造点（baseQuery 收口）
 *   - experience.controller.ts — 原始查询串形态守卫（括号数组参数 400）
 *   - dto/experience-field.validators.ts — 数组元素与布尔变换校验器
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增过滤参数必须同步 service 的谓词 AND 语义与 appliedFilters 回显
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  EXPERIENCE_INTENTS,
  EXPERIENCE_QUALITIES,
  EXPERIENCE_SORT_VALUES,
  type ExperienceIntent,
  type ExperienceQuality,
  type ExperienceSort,
} from '@agent-chamber/shared';
import {
  EXPERIENCE_DEFAULT_PAGE_SIZE,
  EXPERIENCE_ENV_VALUE_MAX_LENGTH,
  EXPERIENCE_MAX_DOMAINS,
  EXPERIENCE_MAX_PAGE_SIZE,
  EXPERIENCE_MAX_SIGNALS,
  EXPERIENCE_QUERY_MAX_LENGTH,
  EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH,
} from '../experience.constants';
import { IsExperienceDomains, IsExperienceSignals, ToBoolean } from './experience-field.validators';

/** 把重复 query 参数（或单值）统一成数组：`?a=1&a=2` → ['1','2']，`?a=1` → ['1'] */
function toArrayParam(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) ? value : [value];
  });
}

/**
 * 经验列表 / 检索查询参数。
 *
 * 参数之间是 **AND**；同一个数组参数内部是 **ANY-overlap**（共享至少一个元素即命中）。
 */
export class QueryExperienceDto {
  @IsOptional()
  @IsString()
  @MaxLength(EXPERIENCE_QUERY_MAX_LENGTH)
  @ApiPropertyOptional({
    description:
      'Full-text query (max 200 chars). Fused scoring: ts_rank(search_vector, plainto_tsquery) × 1.0 ' +
      '+ similarity(content, q) × 0.6 + similarity(title, q) × 0.8, filtered at SCORE_FLOOR 0.08. ' +
      'q is a FILTER as well as a ranking signal — unrelated entries are dropped, which is what makes ' +
      'the zero-hit hint meaningful. When q is present it takes over ordering (verified tier → fused ' +
      'score → distinct usage → freshness) and `sort` is not applied.',
    example: 'port unreachable',
  })
  q?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXPERIENCE_MAX_SIGNALS)
  @IsString({ each: true })
  @IsExperienceSignals()
  @toArrayParam()
  @ApiPropertyOptional({
    description:
      'Symptom signals — ANY-overlap matching on normalized exact strings (sharing ≥1 signal = hit). ' +
      'REST form: repeat the parameter (`?signals=a&signals=b`); comma-joined values are rejected. ' +
      `Max ${EXPERIENCE_MAX_SIGNALS} elements, each ≤50 chars.`,
    type: [String],
    example: ['econnrefused'],
  })
  signals?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXPERIENCE_MAX_DOMAINS)
  @IsString({ each: true })
  @IsExperienceDomains()
  @toArrayParam()
  @ApiPropertyOptional({
    description: 'Domain tags — ANY-overlap matching (repeat the parameter for multiple values).',
    type: [String],
  })
  domains?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(EXPERIENCE_ENV_VALUE_MAX_LENGTH)
  @ApiPropertyOptional({
    description: 'Environment fingerprint · os (EXACT equality on the normalized value).',
    example: 'wsl2',
  })
  envOs?: string;

  @IsOptional()
  @IsString()
  @MaxLength(EXPERIENCE_ENV_VALUE_MAX_LENGTH)
  @ApiPropertyOptional({ description: 'Environment fingerprint · tool (EXACT equality).' })
  envTool?: string;

  @IsOptional()
  @IsString()
  @MaxLength(EXPERIENCE_ENV_VALUE_MAX_LENGTH)
  @ApiPropertyOptional({ description: 'Environment fingerprint · version (EXACT equality).' })
  envVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(EXPERIENCE_ENV_VALUE_MAX_LENGTH)
  @ApiPropertyOptional({ description: 'Environment fingerprint · runtime (EXACT equality).' })
  envRuntime?: string;

  @IsOptional()
  @IsIn([...EXPERIENCE_INTENTS])
  @ApiPropertyOptional({ description: 'Filter by problem nature.', enum: EXPERIENCE_INTENTS })
  intent?: ExperienceIntent;

  @IsOptional()
  @IsIn([...EXPERIENCE_QUALITIES])
  @ApiPropertyOptional({
    description:
      'Filter by quality. NOTE: suspect entries are excluded by default; passing `quality=suspect` ' +
      'explicitly lifts that exclusion (the review/appeal path), so a suspect can always be fetched ' +
      'by asking for it.',
    enum: EXPERIENCE_QUALITIES,
  })
  quality?: ExperienceQuality;

  @IsOptional()
  @IsString()
  @MaxLength(EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH)
  @MinLength(1)
  @ApiPropertyOptional({ description: 'Filter by self-reported source project.' })
  sourceProject?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description:
      'Filter by creator — actor UUID (EXACT equality; take the value from the `createdById` of an ' +
      'item you already have, or from a facets `byCreator` element). NOT a display name: names are ' +
      'resolved profiles that drift on rename/soft-delete, and two actors can share a name. UUID ' +
      'only — a malformed value is rejected with 400 (never silently ignored).',
    example: '3f1c9a52-6b1e-4b8e-9a2f-0d7c4e5b1a90',
  })
  createdById?: string;

  @IsOptional()
  @ToBoolean()
  @ApiPropertyOptional({
    description:
      'Include entries whose `expiresAt` has passed (default false = expired entries are excluded).',
    default: false,
  })
  includeExpired?: boolean;

  @IsOptional()
  @ToBoolean()
  @ApiPropertyOptional({
    description:
      'Requires a human admin or an experience space owner/reviewer role. Include `suspect` ' +
      'entries in the result without having to ask for `quality=suspect` explicitly. Any other ' +
      'caller gets 403 / 13004 — this is a moderation surface, deliberately not silently ignored ' +
      '(see GET /experiences/members for who can).',
    default: false,
  })
  includeSuspect?: boolean;

  @IsOptional()
  @IsIn([...EXPERIENCE_SORT_VALUES])
  @ApiPropertyOptional({
    description:
      'Sort mode when q is absent. `recent` (default) = updated_at DESC — no index by design (small ' +
      'table, seq scan is correct; do not "fix" it). `most_used` = verified tier → ' +
      'distinct_helped_count DESC → updated_at DESC (distinct counts are self-reported and can be ' +
      'gamed — trust accordingly).',
    enum: EXPERIENCE_SORT_VALUES,
    default: 'recent',
  })
  sort?: ExperienceSort;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ description: 'Page number (1-based).', default: 1 })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EXPERIENCE_MAX_PAGE_SIZE)
  @ApiPropertyOptional({
    description: `Page size (max ${EXPERIENCE_MAX_PAGE_SIZE}).`,
    default: EXPERIENCE_DEFAULT_PAGE_SIZE,
  })
  pageSize?: number;
}
