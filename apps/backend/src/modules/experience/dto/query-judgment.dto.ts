/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库判断日志查询请求 DTO（`GET /experiences/judgments`，第二期 plan §4）
 *
 * [代码职责]
 *   - operation / status / experienceId / from / to 时间窗 / page / pageSize 的格式校验
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base-p2.md §2.2（端点参数表）/§4（导出姿势）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章 judgments 端点契约
 *
 * [关键不变量]
 *   - **`operation` / `status` 是 `@IsIn` 白名单**：拼错的过滤值必须 **400**，
 *     绝不静默返回空页——"查不到语料"与"参数打错"在导出场景里必须可区分（plan §2.2）。
 *   - `experienceId` 走 `@IsUUID`（格式错误不过业务层，铁律 #21）。
 *   - `from`/`to` 是 ISO 8601 字符串（照 audit-log-query.dto 先例）：导出训练集必须按
 *     时间窗切片翻页 + `total` 自检，**禁止 `page++` 裸翻**（翻页途中新写入会插进已翻过的
 *     区间 ⇒ 漏行）。
 *   - `pageSize ≤ 50`（plan §2.2）：单页体量上限 ≈ 50×(16KB×2) ≈ 1.6MB，客户端超时与
 *     流式处理要按这个量级设。
 *   - 值域数组的**单源在 shared**（`EXPERIENCE_JUDGMENT_OPERATIONS` / `..._STATUSES`），
 *     本文件不写第二份字面量。
 *
 * [关联代码]
 *   - experience-judgment.service.ts listJudgments() — 过滤谓词与全序分页的构造点
 *   - experience.controller.ts — 端点声明（字面量路由须在 `:id` 之前）
 *   - packages/shared/src/dto/experience-response.dto.ts — ExperienceJudgmentLog（响应形状）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增过滤参数必须同步 service 的谓词与 api-definition 的导出姿势说明
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  EXPERIENCE_JUDGMENT_OPERATIONS,
  EXPERIENCE_JUDGMENT_STATUSES,
  type ExperienceJudgmentOperation,
  type ExperienceJudgmentStatus,
} from '@agent-chamber/shared';
import {
  EXPERIENCE_JUDGMENT_DEFAULT_PAGE_SIZE,
  EXPERIENCE_JUDGMENT_MAX_PAGE_SIZE,
} from '../experience.constants';

/**
 * 判断日志查询参数。
 *
 * 全部可选：无过滤 = 全量按时间倒序翻页（导出场景通常给 from/to）。
 */
export class QueryJudgmentDto {
  @IsOptional()
  @IsIn([...EXPERIENCE_JUDGMENT_OPERATIONS])
  @ApiPropertyOptional({
    description:
      'Filter by operation. Whitelisted — a typo gets 400 instead of a silent empty page ' +
      '(important for corpus exports: "no rows" must never be confused with "wrong parameter").',
    enum: EXPERIENCE_JUDGMENT_OPERATIONS,
    example: 'record_check',
  })
  operation?: ExperienceJudgmentOperation;

  @IsOptional()
  @IsIn([...EXPERIENCE_JUDGMENT_STATUSES])
  @ApiPropertyOptional({
    description:
      'Filter by result status. `ok` / `error` / `timeout` / `skipped` (rate-limited, no provider ' +
      'call). Failure rate uses ok+error+timeout as the denominator (skipped excluded).',
    enum: EXPERIENCE_JUDGMENT_STATUSES,
    example: 'ok',
  })
  status?: ExperienceJudgmentStatus;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Filter by experience entry id (logs survive entry deletion).',
    example: 'a1b2c3d4-1111-4222-8333-444455556666',
  })
  experienceId?: string;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({
    description:
      'Start time (ISO 8601 with timezone, inclusive) — the export window. Page through time ' +
      'windows and self-check with `total`; do NOT just increment `page` (rows written during the ' +
      'walk insert into already-paged ranges and get skipped).',
    example: '2026-09-01T00:00:00+08:00',
  })
  from?: string;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({
    description: 'End time (ISO 8601 with timezone, inclusive)',
    example: '2026-09-30T23:59:59+08:00',
  })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EXPERIENCE_JUDGMENT_MAX_PAGE_SIZE)
  @ApiPropertyOptional({
    description:
      `Page size (max ${EXPERIENCE_JUDGMENT_MAX_PAGE_SIZE}). Upper bound is a volume contract: ` +
      'one page can carry ~50 × (16KB request + 16KB response) ≈ 1.6MB.',
    default: EXPERIENCE_JUDGMENT_DEFAULT_PAGE_SIZE,
  })
  pageSize?: number;
}
