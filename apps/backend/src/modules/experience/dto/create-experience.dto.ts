/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）录入请求 DTO（POST /experiences）
 *
 * [代码职责]
 *   - 录入字段的**格式正确性**校验（铁律 #21 层 1）：类型/必填/长度/数组上限/词表/enum
 *     白名单/数组元素形状/env 键白名单；业务存在性与策略（限流、密钥闸门、归一化、
 *     疑似重复）一律在 service 层
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §2（归一化与传参协议）/§3（API 契约）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章
 *
 * [关键不变量]
 *   - **`quality` 与 `createdBy*` 刻意不在本 DTO 里**：录入通道强制 unverified、录入者
 *     取 `@CurrentActor()`——客户端自传这两个字段会被全局 ValidationPipe 的
 *     `forbidNonWhitelisted` 直接 400（徽章洗白防线的第一道物理隔离，plan §3）
 *   - **`signals` 恒必填且 `@ArrayNotEmpty`**（architect R8）：不做"是否给了 signals"
 *     的条件校验双写分叉，写入面统一要求提炼症状
 *   - env 只校验**形状**（键白名单 + 字符串值）；值归一化在 service 层
 *   - `expiresAt` 只校验 ISO 8601 格式；「必须 > now」的业务校验在 service（DTO 无法
 *     在同一请求内可靠地取"now"作比较基准）
 *
 * [关联代码]
 *   - experience.service.ts create() — 本 DTO 的唯一消费方（归一化/限流/闸门/幂等）
 *   - dto/experience-field.validators.ts — signals/domains/env 三个自定义校验器
 *   - packages/shared/src/enums/index.ts — EXPERIENCE_INTENTS 词表单源
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量]：新增可写字段必须同步 service 的归一化与密钥闸门覆盖面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
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
 * 录入经验条目请求体。
 *
 * 四节正文模板（content 的自由文本约定，**不强制**——只影响"缺验证方式节"的软告警）：
 * `## Symptom` / `## Root cause` / `## Fix` / `## How verified`。
 */
export class CreateExperienceDto {
  @IsString()
  @Length(1, EXPERIENCE_TITLE_MAX_LENGTH)
  @ApiProperty({
    description: 'One-line title naming the symptom or the outcome (max 200 chars)',
    example: 'Docker port forwarding silently fails on WSL2 after reboot',
  })
  title!: string;

  @IsString()
  @Length(1, EXPERIENCE_SUMMARY_MAX_LENGTH)
  @ApiProperty({
    description:
      'Why this entry matters / when to read it (max 500 chars). REQUIRED — the list projection ' +
      'never includes `content`, so the summary is the only basis for deciding to open the detail.',
    example:
      'Symptom: published port unreachable from Windows host. Fix: restart docker-desktop WSL distro.',
  })
  summary!: string;

  @IsString()
  @MaxLength(EXPERIENCE_CONTENT_MAX_LENGTH)
  @ApiProperty({
    description:
      'Markdown body (max 64KB). Template: ## Symptom / ## Root cause / ## Fix / ## How verified. ' +
      'NEVER include secrets or PII — the experience base is readable by every authenticated actor.',
    example: '## Symptom\n...\n## Root cause\n...\n## Fix\n...\n## How verified\n...',
  })
  content!: string;

  @IsIn([...EXPERIENCE_INTENTS])
  @ApiProperty({
    description:
      'Problem nature (controlled vocabulary). repair = reader has an error and wants the fix; ' +
      'pitfall = the value is warning against a wrong approach; howto = procedure; ' +
      'optimize = make something better; decision = why we chose X over Y.',
    enum: EXPERIENCE_INTENTS,
    example: 'repair',
  })
  intent!: ExperienceIntent;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(EXPERIENCE_MAX_SIGNALS)
  @IsString({ each: true })
  @IsExperienceSignals()
  @ApiProperty({
    description:
      'Symptom signals — the PRIMARY search entry point. Pass a JSON array (MCP) or repeated query ' +
      `params. Each element is ONE distinguishing keyword token (max 50 chars, no commas), e.g. ` +
      '`ECONNREFUSED` or `port-unreachable` — NOT the full error sentence. Matching is ANY-overlap ' +
      'on normalized (trim+lowercase) exact strings: sharing at least one signal counts as a hit, ' +
      'so adding more signals WIDENS the result set rather than narrowing it.',
    type: [String],
    example: ['econnrefused', 'port-unreachable'],
  })
  signals!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXPERIENCE_MAX_DOMAINS)
  @IsString({ each: true })
  @IsExperienceDomains()
  @ApiPropertyOptional({
    description:
      'Domain tags (open vocabulary, normalized to lowercase). Reuse existing tags — the known ' +
      'list is echoed by `GET /experiences/facets` (`availableDomains`) and must not be treated ' +
      'as a closed set. Matching is ANY-overlap, same as signals.',
    type: [String],
    example: ['devops', 'docker'],
  })
  domains?: string[];

  @IsOptional()
  @IsObject()
  @IsExperienceEnv()
  @ApiPropertyOptional({
    description:
      'Environment fingerprint — CONTROLLED KEYS, OPEN VALUES. Legal keys only: os, tool, version, ' +
      'runtime (any other key is rejected with 400 listing the legal ones). Values are normalized ' +
      '(trim+lowercase) and matched by EXACT equality, ANDed across the four query params.',
    example: { os: 'wsl2', tool: 'docker', version: '24.0.7' },
  })
  env?: ExperienceEnv;

  @IsOptional()
  @IsString()
  @MaxLength(EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH)
  @ApiPropertyOptional({
    description:
      'Self-reported origin (repo slug convention, e.g. `agent-chamber`). NOT trustworthy — ' +
      'used only for discovery/filtering across projects.',
    example: 'agent-chamber',
  })
  sourceProject?: string;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({
    description:
      'Expiry boundary (ISO 8601). MUST be in the future — a past timestamp is rejected with 400. ' +
      'Omit for a never-expiring entry. Expired entries are excluded from the default search/list.',
    example: '2026-12-31T00:00:00.000Z',
  })
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  @ApiPropertyOptional({
    description:
      'Idempotency key (1–64 chars). Retry with the SAME key after a timeout: the first response ' +
      'snapshot is replayed (`idempotentReplay: true`) with no second write. Reusing a key with a ' +
      'DIFFERENT payload is rejected with 409 / 9002.',
    example: 'record-exp-2026-09-21-a',
  })
  clientRequestId?: string;
}
