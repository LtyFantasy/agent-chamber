/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）编辑请求 DTO（PATCH /experiences/:id）
 *
 * [代码职责]
 *   - 可改字段的格式校验 + **乐观锁基准**（expectedUpdatedAt 必填）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §3（PATCH 契约：作者判定 / 乐观锁 /
 *     内容改写回落 unverified）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章（409 三分类动作表）
 *
 * [关键不变量]
 *   - **`expectedUpdatedAt` 必填**：乐观锁是可选的"建议"就没有意义——省略即绕过的锁等于
 *     没有锁。冲突语义 = 409，正确动作是「重读最新 `updatedAt` 后重试」（不是退避重试）
 *   - **改 content/title/summary/signals 任一 → quality 回落 unverified + 清 verified_by/at**
 *     的判定在 service（需要与旧值比较），**不在本 DTO**；本 DTO 只负责放行这些字段
 *   - **`quality` 刻意不在本 DTO**：质量只能走 `PATCH /experiences/:id/quality`（人类
 *     admin 终审）——本端点不得成为徽章洗白的旁路；自传 `quality` 会被全局
 *     `forbidNonWhitelisted` 400
 *   - **只有 `expiresAt` / `sourceProject` 接受显式 null（清空语义）**：这两个字段用
 *     `@IsOptional()`（class-validator 对 null/undefined 都跳过校验 ⇒ null 合法且被保留）。
 *     其余七个字段（title/summary/content/intent/signals/domains/env）用
 *     **`@ValidateIf((_, v) => v !== undefined)`** —— 显式 null 会进入校验并被 `@IsString`/
 *     `@IsIn`/`@IsArray`/`@IsObject` 拦成 400（评审 B1：曾经 null 被 @IsOptional 静默放行，
 *     直通 service 后炸 500 —— `assertNonBlank(null).trim` TypeError / NOT NULL 违约；
 *     `env: null` 更糟，会**静默清空** env 与文档口径矛盾）
 *   - service 用 **`field !== undefined`** 判定"出现即采用"，**不能用 `'field' in dto`**：
 *     TS target ES2022（`useDefineForClassFields` 默认 true）下 class-transformer 产出的实例
 *     **所有声明字段都是 own 属性**（缺省即 undefined），`in` 恒为 true，清空语义会连带失效
 *     （见 service 文件头 EXPERIENCE-DTO-PRESENCE）
 *
 * [关联代码]
 *   - experience.service.ts update() — 作者判定 / 乐观锁比较 / quality 回落 / audit 插桩
 *   - dto/create-experience.dto.ts — 字段形状的平行来源（两处长度上限必须一致）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增可改字段必须同步 service 的"内容类字段 → 回落 unverified"清单
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateIf,
  Length,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EXPERIENCE_CONTENT_MAX_LENGTH,
  EXPERIENCE_INTENTS,
  EXPERIENCE_TITLE_MAX_LENGTH,
  type ExperienceEnv,
  type ExperienceIntent,
} from '@agent-chamber/shared';
import {
  EXPERIENCE_MAX_DOMAINS,
  EXPERIENCE_MAX_SIGNALS,
  EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH,
  EXPERIENCE_SUMMARY_MAX_LENGTH,
} from '../experience.constants';
import {
  IsExperienceDomains,
  IsExperienceEnv,
  IsExperienceSignals,
} from './experience-field.validators';

/**
 * 编辑经验条目请求体（全部字段可选，除乐观锁基准）。
 *
 * 语义提醒：本 DTO **没有** `quality`——改内容会自动回落（verified → unverified；**suspect
 * 粘性**：suspect 不因内容改写回落，只能由终审人经双向门解除），改质量只能走终审端点
 * （人类 admin 或空间 owner/reviewer）。
 */
export class UpdateExperienceDto {
  @IsString()
  @Length(1, EXPERIENCE_TITLE_MAX_LENGTH)
  @ValidateIf((_, value) => value !== undefined)
  @ApiPropertyOptional({
    description:
      'New title (max 200 chars). Changing it resets quality to `unverified`. ' +
      'NOT nullable: an explicit `null` is rejected with 400 (omit the key to leave it unchanged).',
  })
  title?: string;

  @IsString()
  @Length(1, EXPERIENCE_SUMMARY_MAX_LENGTH)
  @ValidateIf((_, value) => value !== undefined)
  @ApiPropertyOptional({
    description:
      'New summary (max 500 chars). Changing it resets quality to `unverified`. ' +
      'NOT nullable: an explicit `null` is rejected with 400.',
  })
  summary?: string;

  @IsString()
  @MaxLength(EXPERIENCE_CONTENT_MAX_LENGTH)
  @ValidateIf((_, value) => value !== undefined)
  @ApiPropertyOptional({
    description:
      'New markdown body (max 64KB). Changing it resets quality to `unverified` and clears the ' +
      'verification trail — a verified badge must not survive a content rewrite. ' +
      'NOT nullable: an explicit `null` is rejected with 400.',
  })
  content?: string;

  @IsIn([...EXPERIENCE_INTENTS])
  @ValidateIf((_, value) => value !== undefined)
  @ApiPropertyOptional({
    description:
      'New intent. NOT a content field: changing it does not reset quality. ' +
      'NOT nullable: an explicit `null` is rejected with 400.',
    enum: EXPERIENCE_INTENTS,
  })
  intent?: ExperienceIntent;

  @IsArray()
  @ArrayMaxSize(EXPERIENCE_MAX_SIGNALS)
  @IsString({ each: true })
  @IsExperienceSignals()
  @ValidateIf((_, value) => value !== undefined)
  @ApiPropertyOptional({
    description:
      'Replace the whole signals array (1 signal per element, no commas; max 20 elements). ' +
      'Changing it resets quality to `unverified` — signals drive search, so rewriting them ' +
      'changes what the entry claims to cover.',
    type: [String],
  })
  signals?: string[];

  @IsArray()
  @ArrayMaxSize(EXPERIENCE_MAX_DOMAINS)
  @IsString({ each: true })
  @IsExperienceDomains()
  @ValidateIf((_, value) => value !== undefined)
  @ApiPropertyOptional({
    description: 'Replace the whole domains array (max 20 elements, normalized to lowercase).',
    type: [String],
  })
  domains?: string[];

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @IsExperienceEnv()
  @ApiPropertyOptional({
    description:
      'Replace the whole env object (legal keys: os, tool, version, runtime). Values are ' +
      'normalized to lowercase; omitted keys are removed.',
  })
  env?: ExperienceEnv;

  @IsOptional()
  @IsString()
  @MaxLength(EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH)
  @ApiPropertyOptional({
    description: 'New self-reported source project, or explicit `null` to clear it.',
    nullable: true,
  })
  sourceProject?: string | null;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({
    description:
      'New expiry boundary (must be in the future), or explicit `null` to make the entry ' +
      'never-expiring.',
    nullable: true,
  })
  expiresAt?: string | null;

  @IsISO8601()
  @ApiProperty({
    description:
      'REQUIRED optimistic-lock token: the `updatedAt` value you last read. On mismatch the server ' +
      'returns 409 — re-read the entry (GET /experiences/:id) and retry with the fresh value. ' +
      'Do NOT blind-retry with the same token.',
    example: '2026-09-21T10:00:00.000Z',
  })
  expectedUpdatedAt!: string;
}
