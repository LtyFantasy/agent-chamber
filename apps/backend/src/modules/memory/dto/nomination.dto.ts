/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆**提名**与**更正**的请求 DTO：主张三要素 + 理由 + 来源引用 + 幂等键
 *     （形成正文的装配由服务层做，客户端可用 `contentOverride` 整篇覆盖）
 *
 * [代码职责]
 *   - 只做**格式正确性**（铁律 #21 层 1）：长度 / 必填 / 词表 / 数组上限 / 嵌套形状
 *   - 正文与理由的 **UTF-8 字节闸门**（8192 / 1024）在服务层：DTO 的 `@MaxLength`
 *     数的是 UTF-16 码元，中文一字 3 字节，按字符算等于放宽 3 倍（见 memory.constants 文件头）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §4 Formation content 装配契约
 *     （三要素 + 理由永不截 / 来源回取用提名者权限 / locator 形态）+ §6 端点面
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **`sourceRefs.type` 用 `@IsIn(MEMORY_SOURCE_REF_TYPES)`**：该值域**刻意不含 `memory`**
 *     ——记忆不能作为记忆的来源（否则形成链可自证，与"提名只接受原始来源"的虚假共识防护冲突）。
 *     用 `@IsString()` 会把这个防线的第一道闸门拆掉。
 *   - **`position` / `headingPath` 二者最多一个**：都给了会让"取哪一节当摘录"含糊
 *     （服务端无法判断谁优先），故在 service 显式 400；`position` 缺省取文档首节。
 *   - **`contentOverride` 与 `sourceRefs` 正交**：覆盖正文不取消来源引用——来源仍进
 *     locator 与召回过滤（否则"用 override 绕过来源权限"就是一条逃逸路径）。
 *   - **更正 DTO 继承提名 DTO**（`CorrectMemoryDto extends NominateMemoryDto`）：
 *     新主张与普通提名的字段完全一致（逐态语义相同），复制一份 = 两处字段迟早分叉。
 *
 * [关联代码]
 *   - ../memory-formation.service.ts — 提名/重试的唯一消费方（装配/闸门/落库/续跑）
 *   - ../memory-correction.service.ts — 更正编排（预检 + 提名 + correct + 双写）
 *   - ../memory-content.assembler.ts — 装配与截断不变式的实现
 *   - ../dto/memory-contract.ts — `MemorySourceRef`（实体）与响应形状
 *
 * [修改检查]
 *   □ 已读 [权威文档] §4，新增字段必须同步装配契约（否则字段写了却进不了形成正文）
 *   □ 改长度上限必须同步服务层的字节闸门与 e2e 边界用例
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MEMORY_FORMATION_STATES,
  MEMORY_NOMINATION_STATUSES,
  MEMORY_SOURCE_REF_TYPES,
  type MemoryFormationState,
  type MemoryNominationStatus,
  type MemorySourceRefType,
} from '@agent-chamber/shared';

/**
 * 来源引用入参（`source_refs[i]`，≤4）。
 *
 * `position` / `headingPath` 是**服务端回取的定位提示**（不是冻结值——冻结值由服务端实取后
 * 覆盖写入 `MemorySourceRef`，客户端给的值一律不采信为快照）。
 */
export class MemorySourceRefDto {
  /** 来源类型（doc / message / task / comment；**禁 memory**，见文件头不变量） */
  @ApiProperty({ enum: MEMORY_SOURCE_REF_TYPES, description: 'Source type (memory is forbidden)' })
  @IsIn(MEMORY_SOURCE_REF_TYPES)
  type: MemorySourceRefType;

  /** 来源资源 UUID */
  @ApiProperty({ description: 'Source resource UUID' })
  @IsUUID()
  id: string;

  /** 摘录定位：文档节位置（0 起）；缺省取首节 */
  @ApiPropertyOptional({
    description: 'Doc section position for the excerpt (doc only)',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position?: number;

  /** 摘录定位：文档节 headingPath（与 `position` 互斥） */
  @ApiPropertyOptional({ description: 'Doc section headingPath for the excerpt (doc only)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  headingPath?: string;
}

/**
 * 提名新主张（`POST /memory/projects/:id/nominations`）。
 *
 * 缺省路径 = 服务端按 §4 契约装配形成正文；`contentOverride` 给"我要自己写正文"的出口
 * （**同一字节闸门**）。
 */
export class NominateMemoryDto {
  /** 记忆类别（受控短标签；首个落点 `ruling`；词表开放但受治理约束） */
  @ApiProperty({ description: 'Memory category (e.g. ruling)', maxLength: 64 })
  @IsString()
  @Length(1, 64)
  category: string;

  /** 主张主题（装配契约 `[{category}] {subject}` 的主语，**永不截断**） */
  @ApiProperty({ description: 'Claim subject (never truncated)', maxLength: 512 })
  @IsString()
  @Length(1, 512)
  subject: string;

  /** 适用范围（装配契约 `范围: {scope}`，**永不截断**） */
  @ApiProperty({ description: 'Scope of applicability (never truncated)', maxLength: 512 })
  @IsString()
  @Length(1, 512)
  scope: string;

  /** 生效/撤销说明（可空；存在时**永不截断**） */
  // 显式 type + nullable：`string | null` 联合类型经 reflect-metadata 推成 Object，会让
  // Swagger/automcp 输出 type:object，MCP 通道传字符串必 400（守卫见 swagger-schema.spec.ts）
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Effective / revocation note (never truncated)',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  effectiveNote?: string | null;

  /** 审计理由（**≤1024 UTF-8 bytes**，服务层闸门；进形成正文关键依据区，永不截断） */
  @ApiProperty({ description: 'Rationale (≤1024 UTF-8 bytes)', maxLength: 1024 })
  @IsString()
  @Length(1, 1024)
  rationale: string;

  /** 来源引用（≤4；服务端用**提名者权限**回取并冻结快照） */
  @ApiPropertyOptional({ type: [MemorySourceRefDto], description: 'Source refs (≤4)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => MemorySourceRefDto)
  sourceRefs?: MemorySourceRefDto[];

  /** 整篇覆盖形成正文（≤8192 UTF-8 bytes，服务层闸门；不取消来源引用） */
  @ApiPropertyOptional({ description: 'Override the assembled content (≤8192 UTF-8 bytes)' })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  contentOverride?: string;

  /** 复核提醒时间（**仅提醒，不自动过期**；到点只体现在召回项 `reviewDue`） */
  // string|null 必须显式 type（否则反射推成 object）；时间字段补 format 供 MCP client 识别
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Review reminder time (reminder only, never expires)',
  })
  @IsOptional()
  @IsISO8601()
  reviewAt?: string | null;

  /** 幂等键（同 actor 同 key 重发返回首次结果，**没有二次形成**） */
  @ApiPropertyOptional({ description: 'Idempotency key (1-64 chars)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  clientRequestId?: string;
}

/**
 * 更正既有主张（`POST /memory/projects/:id/corrections`）。
 *
 * 字段与提名完全一致（新主张就是一次提名），另加"更正谁"的两个键。
 */
export class CorrectMemoryDto extends NominateMemoryDto {
  /** 被更正的**旧账本行 id**（服务端预检它 `status=active` 且已形成） */
  @ApiProperty({ description: 'Ledger id of the claim being corrected (must be active)' })
  @IsUUID()
  correctionOf: string;

  /**
   * 被更正的**引擎记忆 id**（缺省 = 旧行形成的主记忆 `engineMemoryIds[0]`）。
   *
   * 为什么允许显式指定：一次提名可形成多个记忆，更正必须指名道姓；
   * 但服务端会校验它**确实属于旧行**（否则更正可以指向任意记忆——一条越权写入路径）。
   */
  @ApiPropertyOptional({
    description: 'Engine memory id to correct (defaults to the old claim main id)',
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  oldMemoryId?: string;
}

/** 账本列表过滤（`GET /memory/projects/:id/nominations`） */
export class QueryNominationsDto {
  /** 按类别过滤 */
  @ApiPropertyOptional({ description: 'Filter by category' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  /** 按账本状态过滤（active / superseded / withdrawn） */
  @ApiPropertyOptional({ enum: MEMORY_NOMINATION_STATUSES, description: 'Filter by ledger status' })
  @IsOptional()
  @IsIn(MEMORY_NOMINATION_STATUSES)
  status?: MemoryNominationStatus;

  /** 按形成态过滤（§7 七态） */
  @ApiPropertyOptional({ enum: MEMORY_FORMATION_STATES, description: 'Filter by formation state' })
  @IsOptional()
  @IsIn(MEMORY_FORMATION_STATES)
  formationState?: MemoryFormationState;

  /** 复核到期过滤：`review_at <= reviewBefore`（**仅筛选，不自动过期**） */
  @ApiPropertyOptional({ description: 'Only rows whose reviewAt is at/before this instant' })
  @IsOptional()
  @IsISO8601()
  reviewBefore?: string;

  /** 页码（从 1 起） */
  @ApiPropertyOptional({ description: 'Page number (1-based)', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** 页大小（越界由 service 钳制） */
  @ApiPropertyOptional({ description: 'Page size (clamped)', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
