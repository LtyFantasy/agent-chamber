/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 项目注册表的**请求 DTO**：创建 / 改名与绑定 / 归档 / 列表过滤
 *
 * [代码职责]
 *   - 只做**格式正确性**（铁律 #21 层 1）：UUID / 长度 / 必填 / 词表白名单
 *   - 业务存在性与权限（绑定资源真的存在且可读、slug 未被占用、换绑 workspace 的后果、
 *     引擎绑定三元组完整性、凭据形态）一律在 `memory-project.service.ts`
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §2 `memory_projects` 逐列契约 /
 *     §5 权限模型（创建门槛）/ §6 端点面
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **`type` 用 `@IsIn(MEMORY_BINDING_TYPES)` 而不是 `@IsString`**：绑定类型决定父链解析
 *     分支，写错的类型会让权限判定静默走错分支（"未知类型一律不可读"是 fail-closed 兜底，
 *     但那是兜底不是契约）。
 *   - **`id` 必须 `@IsUUID`**：绑定 id 直接进父链预载的 `IN (...)` 查询——非 UUID 会打到
 *     PostgreSQL 的类型转换错误（500），铁律 #21 明确禁止把格式错误透传到 DB。
 *   - **`bindings` 的"≥1"在 DTO 用 `@ArrayNotEmpty`、在 service 再判一次**：
 *     PATCH 清空成 `[]` 是**合法的存量态**（落治理路径），只有创建时要求 ≥1——
 *     所以"≥1"不能只写在 service 的创建分支里靠注释记着。
 *   - **`engine` 值域只认落库词表**（shared `MEMORY_ENGINES`）：`fake` 只存在于 config 面，
 *     写进 DTO 白名单 = 让 API 能往库里塞一个"测试引擎"（config 层的 fail-fast 拦不住存量数据）。
 *   - **可空列用 `@IsOptional()` 的 null 三态语义**：缺席 = 不改；`null` = 清空。
 *     `@IsOptional()` 对 `null` 与 `undefined` 同时跳过校验，正好承载这个语义
 *     （service 用**值判定**区分二者：`undefined` = 未发送、`null` = 清空；
 *     切勿用 `hasOwnProperty`——`useDefineForClassFields` 下它对未发送字段也恒真，
 *     见 `memory-project.service.ts` 的不变量注释）。
 *   - **创建时三键的"全缺"是一等语义**（二期自助开通）：`engine=hument` 且三键全缺 ⇒
 *     后端自动注册 Hub 并把派生三键落库（部署启用时）；**部分缺**仍是 400。
 *     本层只改**文案**承载这个语义（字段名/装饰器/类型零变更——签名面不变，automcp 无影响）。
 *   - **引擎三列同一字符集闸门**：`engineWorkspaceId` / `engineActorId` / `engineCredentialRef`
 *     都 `@Matches(MEMORY_ENGINE_IDENTIFIER_PATTERN)`（单源 = `../memory.constants`）；
 *     服务层 `assertEngineIdentifier` 是第二道。只校验、不改写。
 *
 * [关联代码]
 *   - ../memory-project.service.ts — 本 DTO 的唯一消费方（存在性/权限/冲突/冒烟）
 *   - ../dto/memory-contract.ts — `MemoryBinding`（实体）与响应形状
 *   - packages/shared/src/enums/index.ts — `MEMORY_BINDING_TYPES` / `MEMORY_ENGINES` /
 *     `MEMORY_PROJECT_STATUSES` 值域单源
 *
 * [修改检查]
 *   □ 已读 [权威文档] §2/§5，新增字段必须同步 service 的校验与响应投影
 *   □ 新增可写列必须评估"存量数据是否会被这个默认值改写"
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MEMORY_BINDING_TYPES,
  MEMORY_ENGINES,
  MEMORY_PROJECT_STATUSES,
  type MemoryBindingType,
  type MemoryEngine,
  type MemoryProjectStatus,
} from '@agent-chamber/shared';
import { MEMORY_ENGINE_IDENTIFIER_PATTERN } from '../memory.constants';

/** slug 形态（展示/过滤辅助；**路径参数只认 uuid**，故无需 URL-safe 之外的顾虑） */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * 绑定条目入参（`bindings[i]`）。
 *
 * 与实体 `MemoryBinding` **同形但用途不同**：本类只负责"格式对不对"，
 * 存在性/可读由 service 解析（fail-closed）。
 */
export class MemoryBindingDto {
  /** 绑定资源类型（topic / board / docSpace；值域单源 = shared `MEMORY_BINDING_TYPES`） */
  @ApiProperty({ enum: MEMORY_BINDING_TYPES, description: 'Bound resource type' })
  @IsIn(MEMORY_BINDING_TYPES)
  type: MemoryBindingType;

  /** 绑定资源 UUID（topic / board / doc_space 的 id） */
  @ApiProperty({ description: 'Bound resource UUID' })
  @IsUUID()
  id: string;
}

/** 创建项目（`POST /memory/projects`） */
export class CreateMemoryProjectDto {
  /** 展示用 slug（唯一，仅展示/过滤辅助） */
  @ApiProperty({ description: 'Display slug (unique, not a path key)', maxLength: 64 })
  @IsString()
  @Length(1, 64)
  @Matches(SLUG_PATTERN, {
    message: 'slug must start with a lowercase letter/digit and contain only [a-z0-9._-]',
  })
  slug: string;

  /** 项目显示名 */
  @ApiProperty({ description: 'Project display name', maxLength: 128 })
  @IsString()
  @Length(1, 128)
  name: string;

  /**
   * 绑定列表（创建时 ≥1）。
   *
   * 上限 20 是**防呆**（不是方案值）：父链解析与写权限判定按条数逐个走，条数越多
   * 单次请求越慢；20 远超真实使用（trio 绑 3 条）。
   */
  @ApiProperty({ type: [MemoryBindingDto], description: 'Bindings (at least one)' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MemoryBindingDto)
  bindings: MemoryBindingDto[];

  /** 引擎（缺省 `none` = 只做本地账本；值域 = 落库词表，**不含 fake**） */
  @ApiPropertyOptional({ enum: MEMORY_ENGINES, description: 'Engine name (default none)' })
  @IsOptional()
  @IsIn(MEMORY_ENGINES)
  engine?: MemoryEngine;

  /**
   * 引擎侧 workspace（绑引擎时必填，service 校验）。
   *
   * ⚠️ **三键全缺 + `engine=hument` 且部署启用了自助开通 ⇒ 自动注册**（Hub 侧派生 workspace，
   * 本列落派生值）；**部分缺**仍 400（见 `memory-project.service.ts` 的三分支不变量）。
   */
  // 显式 type + nullable：`string | null` 联合类型经 reflect-metadata 推成 Object，会让
  // Swagger/automcp 输出 type:object，MCP 通道传字符串必 400（守卫见 swagger-schema.spec.ts）
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Engine workspace id. Omit ALL THREE engine fields to auto-register this project on the ' +
      'Hub (when auto-registration is enabled); a PARTIAL triple is rejected with 400. ' +
      'Allowed characters: A-Z a-z 0-9 . _ : - (max 128).',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  // workspaceId 是**标识符**：只校验字符集，**永不改写/截断**（改写 = 后续所有引擎调用打到
  // 不存在的 workspace，比不校验更危险——plan D7/§5）。字符集与 memory 侧生产方净化
  // （`sanitizeAlertField()`）**同一份正则**，两处各自注释互相指向。
  @Matches(MEMORY_ENGINE_IDENTIFIER_PATTERN, {
    message:
      'engineWorkspaceId may only contain A-Z a-z 0-9 . _ : - (1-128 chars); it is an ' +
      'identifier and is never rewritten',
  })
  engineWorkspaceId?: string | null;

  /** 引擎侧 actor（绑引擎时必填，service 校验；**服务 actor，不落用户身份**） */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Engine actor id. Omit ALL THREE engine fields to auto-register on the Hub; a PARTIAL ' +
      'triple is rejected with 400. Allowed characters: A-Z a-z 0-9 . _ : - (max 128).',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(MEMORY_ENGINE_IDENTIFIER_PATTERN, {
    message:
      'engineActorId may only contain A-Z a-z 0-9 . _ : - (1-128 chars); it is an identifier ' +
      'and is never rewritten',
  })
  engineActorId?: string | null;

  /** 引擎凭据引用（绑引擎时必填；**非机密引用名**，service 走 KEY_SHAPED 闸门） */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Engine credential reference (non-secret). Omit ALL THREE engine fields to auto-register ' +
      'on the Hub; a PARTIAL triple is rejected with 400. Allowed characters: ' +
      'A-Z a-z 0-9 . _ : - (max 128).',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(MEMORY_ENGINE_IDENTIFIER_PATTERN, {
    message:
      'engineCredentialRef may only contain A-Z a-z 0-9 . _ : - (1-128 chars); it is an ' +
      'identifier and is never rewritten',
  })
  engineCredentialRef?: string | null;
}

/**
 * 更新项目（`PATCH //memory/projects/:id`）：改名 / 绑定 / 归档 / 绑定引擎。
 *
 * 全部字段可选；**缺席 = 不改**，`null` = 清空（仅三列引擎绑定列支持清空，
 * 见文件头不变量）。
 */
export class UpdateMemoryProjectDto {
  /** 项目显示名 */
  @ApiPropertyOptional({ description: 'Project display name', maxLength: 128 })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  name?: string;

  /** 绑定列表（`[]` = 清空 → 落入"全部绑定不可读"治理路径；≥1 时逐个解析） */
  @ApiPropertyOptional({ type: [MemoryBindingDto], description: 'Bindings ([] clears them)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MemoryBindingDto)
  bindings?: MemoryBindingDto[];

  /** 项目状态（`archived` = 写路径 409，读路径放行） */
  @ApiPropertyOptional({ enum: MEMORY_PROJECT_STATUSES, description: 'Project status' })
  @IsOptional()
  @IsIn(MEMORY_PROJECT_STATUSES)
  status?: MemoryProjectStatus;

  /** 引擎（改绑；已有 committed 账本行时禁换 workspace，见 service） */
  @ApiPropertyOptional({ enum: MEMORY_ENGINES, description: 'Engine name' })
  @IsOptional()
  @IsIn(MEMORY_ENGINES)
  engine?: MemoryEngine;

  /** 引擎 workspace（`null` 清空；改绑已有 committed 行的项目 → 409） */
  // 显式 type + nullable：同 CreateMemoryProjectDto（string|null 反射推成 object）
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Engine workspace id (null clears). Allowed characters: A-Z a-z 0-9 . _ : - (max 128). ' +
      'Identifiers are validated only — never trimmed or rewritten.',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  // workspaceId 是**标识符**：只校验字符集、**永不改写/截断**（与 CreateMemoryProjectDto 的
  // 同一份正则；两处各自注释互相指向，第三处 = tracker 展示净化的 `sanitizeAlertField()`）。
  // ⚠️ 改绑路径与创建路径同闸：保持双层校验（DTO 第一道 + 服务层第二道）与一致的
  // 字段级错误面——少了这条，`PATCH` 的越界值会绕过第一道，落到服务层才被 400，错误面不一致。
  @Matches(MEMORY_ENGINE_IDENTIFIER_PATTERN, {
    message:
      'engineWorkspaceId may only contain A-Z a-z 0-9 . _ : - (1-128 chars); it is an ' +
      'identifier and is never rewritten',
  })
  engineWorkspaceId?: string | null;

  /** 引擎 actor（`null` 清空） */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Engine actor id (null clears). Allowed characters: A-Z a-z 0-9 . _ : - (max 128).',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(MEMORY_ENGINE_IDENTIFIER_PATTERN, {
    message:
      'engineActorId may only contain A-Z a-z 0-9 . _ : - (1-128 chars); it is an identifier ' +
      'and is never rewritten',
  })
  engineActorId?: string | null;

  /** 引擎凭据引用（`null` 清空；形态闸门在 service） */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Engine credential reference (null clears). Allowed characters: ' +
      'A-Z a-z 0-9 . _ : - (max 128).',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(MEMORY_ENGINE_IDENTIFIER_PATTERN, {
    message:
      'engineCredentialRef may only contain A-Z a-z 0-9 . _ : - (1-128 chars); it is an ' +
      'identifier and is never rewritten',
  })
  engineCredentialRef?: string | null;

  /**
   * 召回查询**原文留存开关**（默认 `true`；`false` ⇒ 之后新落的召回遥测行 `query_text` 恒 NULL）。
   *
   * **只收布尔，不收 `null`**：对应列是 `NOT NULL`，没有"清空成未设置"这个第三态
   * （见 `memory-project.entity.ts` 的列注释）——故这里刻意**不**沿用上面三个引擎列的
   * null 三态语义，用 `@IsBoolean()` 把 `null`/字符串挡在 DTO 层（铁律 #21 层 1）。
   * 未发送（`undefined`）= 不改；service 用值判定区分（同 `useDefineForClassFields` 理由）。
   */
  @ApiPropertyOptional({
    description:
      'Retain raw recall query text for debugging (default true; false keeps query_text NULL)',
  })
  @IsOptional()
  @IsBoolean()
  retainQueryText?: boolean;
}

/** 项目列表过滤（`GET /memory/projects`） */
export class QueryMemoryProjectsDto {
  /** 页码（从 1 起） */
  @ApiPropertyOptional({ description: 'Page number (1-based)', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** 页大小（越界由 service 钳制，不报错） */
  @ApiPropertyOptional({ description: 'Page size (clamped)', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  /** 按 slug 精确过滤（展示辅助键） */
  @ApiPropertyOptional({ description: 'Filter by slug (exact)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  slug?: string;

  /** 反向查：绑定类型（与 `bindingId` 联用做 `bindingType+bindingId` 反查） */
  @ApiPropertyOptional({ enum: MEMORY_BINDING_TYPES, description: 'Filter by binding type' })
  @IsOptional()
  @IsIn(MEMORY_BINDING_TYPES)
  bindingType?: MemoryBindingType;

  /** 反向查：绑定资源 id（**给了它就必须给 `bindingType`**，否则过滤面含糊） */
  @ApiPropertyOptional({ description: 'Filter by bound resource id (requires bindingType)' })
  @ValidateIf((o: QueryMemoryProjectsDto) => o.bindingId !== undefined)
  @IsUUID()
  bindingId?: string;
}
