/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory **引擎投影读面**（hument 五读面 `/memory/projects/:id/views/*`）的请求 DTO：
 *     graph 的九类过滤器 + 分页预算 + 游标；detail 的关系分页；history 的分页与路径参数；
 *     **relations（关系建议）的空 query + 路径参数**
 *
 * [代码职责]
 *   - 只做**格式正确性**（铁律 #21 层 1）：词表 / 整数区间 / 字符串长度 / RFC3339 形态 /
 *     跨字段顺序（`createdFrom <= createdTo`）
 *   - 业务闸门（项目读权限、来源可见性、引擎可用性）在 `memory-views.service.ts`
 *
 * [权威文档]
 *   - 合同事实源（只读）: Hument 仓 `contracts/openapi/hument-v1.yaml` 的 `MemoryView*` 参数 +
 *     `contracts/schema/memory-view-*.schema.json`（响应枚举）
 *   - 平台口径（护栏理由）: `../memory.constants.ts` 的 `MEMORY_VIEW_*_MAX` 注释
 *     ⚠️ **闭环缺口（已知）**：方案未附本读面的逐字段说明，coder 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **本 DTO 是引擎参数 allowlist 的真子集（12/15），禁止"顺手补全"**。引擎 graph 收 15 个参数，
 *     本批**刻意**只暴露 12 个：`mode` / `center_memory_id` / `neighborhood_limit` 是
 *     **neighborhood（邻域）模式**的三件套，v1 是 browse-only——只放 `mode` 而不放 `center_memory_id`
 *     会造出"引擎必然 400"的输入组合（mode=neighborhood 却无中心点），那比不给更糟。
 *     引擎入参类型 `HumentMemoryGraphViewQuery` 仍是**全集**（引擎能力不因本批 UI 选择而缩水）。
 *   - **`scope` 不在本 DTO**：引擎侧它是 required，但平台**恒传 `actor_private`**（引擎层填死）。
 *     客户端自带 `scope` 会被全局 `forbidNonWhitelisted` 拒成 400——**这是设计意图**（fail-closed）：
 *     作用域不在调用方的选择面里。
 *     ⚠️ **关系建议端点（relations）连"空的 query DTO"都要显式声明**
 *     （`QueryMemoryViewRelationAdvisoriesDto`）：它没有任何可选查询参数，若不声明类元类型，
 *     `?scope=owner_shared` 会被**静默忽略并照常 200**——上一条纪律就只对"有 query DTO 的
 *     端点"成立，等于给一个读面开后门。空类是**刻意的**，不是漏写。
 *   - **`created_from` / `created_to` 是 RFC3339 字符串，逐字透传，禁止 Date 转换**：引擎侧它们是
 *     `*time.Time`，平台侧 `String(date)` 会变成 RFC2822 串被引擎 `400 invalid_argument`。
 *     跨字段顺序（from ≤ to）在**边界层**先判——引擎也会 400，但让错误停在边界更省一次往返。
 *   - **平台不设默认值**：全可选、无 `=` 初值（未传 ⇒ 服务层不拼进 query ⇒ 引擎默认档生效并在响应
 *     `budget` 里回声）。给 DTO 塞默认值 = 平台与引擎两份"默认"事实，`budget` 回声会与平台认知打架。
 *   - **两个上限档都不等于引擎默认值**：`node_limit ≤ 200` 是**过滤成本护栏**（不是"引擎默认值"，虽然
 *     数字恰好相同——见 memory.constants 的取证）；`edge_limit ≤ 600` 只是与节点默认档同档匹配。
 *   - **响应回显的 filters 域比请求域多一个 `any`**（shared `MEMORY_VIEW_GRAPH_FILTERS_ANY`）：
 *     请求 DTO **永不接受 `any`**（引擎侧它对请求是非法的），两套域不可互相复用。
 *   - **路径参数的闸门只能靠 params DTO**（见文件尾的四个 `*ParamsDto` 段注释）：给裸
 *     `@Param('x') x: string` 挂 `@Length` 是**永不生效的死代码**（全局 ValidationPipe 对标量
 *     元类型直接短路，已实测）。新增/改动单记忆端点时必须用 params DTO —— 并把该路由的
 *     全部路径参数列齐（`forbidNonWhitelisted` 会拒绝未声明的键）。
 *
 * [关联代码]
 *   - ../memory-views.service.ts — 本 DTO 的唯一消费方（闸门/过滤/信封）
 *   - ../engines/memory-engine.interface.ts — 引擎入参全集（本 DTO 是真子集）
 *   - ../memory.constants.ts — 上限单源（每个上限都有"为什么是它"的注释）
 *   - packages/shared/src/enums/index.ts — 八组值域单源（含请求/响应两套域的关系说明）
 *
 * [修改检查]
 *   □ 已读 [权威文档] + Hument 合同，逐字段核对（**禁止凭记忆写字段名/上限**）
 *   □ 新增过滤器必须同步：引擎入参类型 + `memory-views.service` 的 query 装配 + 响应回声断言
 *   □ 改上限必须同步 `memory.constants.ts` 与其 e2e 边界用例（两处不同步 = 一边说谎）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MEMORY_VIEW_ANCHOR_STATES,
  MEMORY_VIEW_MEMORY_KINDS,
  MEMORY_VIEW_MEMORY_STATUSES,
  MEMORY_VIEW_RELATION_TYPES,
  MEMORY_VIEW_RESOLUTIONS,
  type MemoryViewAnchorState,
  type MemoryViewMemoryKind,
  type MemoryViewMemoryStatus,
  type MemoryViewRelationType,
  type MemoryViewResolution,
} from '@agent-chamber/shared';
import {
  MEMORY_VIEW_CURSOR_MAX_LENGTH,
  MEMORY_VIEW_EDGE_LIMIT_MAX,
  MEMORY_VIEW_ENGINE_ID_MAX_LENGTH,
  MEMORY_VIEW_HISTORY_LIMIT_MAX,
  MEMORY_VIEW_NODE_LIMIT_MAX,
  MEMORY_VIEW_PREVIEW_SCALARS_MAX,
  MEMORY_VIEW_RELATION_LIMIT_MAX,
} from '../memory.constants';

/**
 * 跨字段顺序校验：`createdTo >= createdFrom`（两者都给了才判）。
 *
 * rationale：class-validator 没有内置的跨字段比较，而"两个都给了却不自洽"是**恒错输入**
 * （引擎必然 400 `invalid_argument`）——在边界层（铁律 #21）先拦，省一次引擎往返，也让错误
 * 指向具体字段而不是一句引擎原文。写法照仓内先例（`task/dto/query-task.dto.ts` 的
 * `IsTaskStatusOrAll`）：`registerDecorator` + 内联 validator，**不导出**新的约束类
 * （导出的类会被 swagger 守卫当成一个 schema 去扫，且这里没有复用价值）。
 */
function IsCreatedRangeOrder(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCreatedRangeOrder',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const from = (args.object as { createdFrom?: unknown }).createdFrom;
          // 任一侧缺席 ⇒ 无从比较（单侧过滤是合法的，引擎自己处理开区间）
          if (typeof value !== 'string' || typeof from !== 'string') return true;
          return Date.parse(from) <= Date.parse(value);
        },
        defaultMessage() {
          return (
            'createdTo must be greater than or equal to createdFrom (RFC3339 strings). ' +
            'createdTo 必须 >= createdFrom'
          );
        },
      },
    });
  };
}

/**
 * graph 投影的过滤与分页入参（`GET /memory/projects/:id/views/graph`）。
 *
 * ⚠️ 未在下面的**任何一个** query 参数都会被全局 `forbidNonWhitelisted` 拒成 400
 * （包括 `scope`——见文件头不变量）。
 */
export class QueryMemoryViewGraphDto {
  /** 按记忆类别过滤（引擎 `kind`） */
  @ApiPropertyOptional({ enum: MEMORY_VIEW_MEMORY_KINDS, description: 'Filter by memory kind' })
  @IsOptional()
  @IsIn(MEMORY_VIEW_MEMORY_KINDS)
  kind?: MemoryViewMemoryKind;

  /** 按记忆状态过滤（引擎侧状态，**不是**账本行状态） */
  @ApiPropertyOptional({
    enum: MEMORY_VIEW_MEMORY_STATUSES,
    description: 'Filter by memory status',
  })
  @IsOptional()
  @IsIn(MEMORY_VIEW_MEMORY_STATUSES)
  status?: MemoryViewMemoryStatus;

  /** 按默认呈现层级过滤（`active_resolution`；与 `availableResolution` 不是一回事） */
  @ApiPropertyOptional({
    enum: MEMORY_VIEW_RESOLUTIONS,
    description: 'Filter by active resolution (the default presentation level)',
  })
  @IsOptional()
  @IsIn(MEMORY_VIEW_RESOLUTIONS)
  activeResolution?: MemoryViewResolution;

  /** 按最高已有表示层级过滤（`available_resolution`） */
  @ApiPropertyOptional({
    enum: MEMORY_VIEW_RESOLUTIONS,
    description: 'Filter by available resolution (the highest materialized level)',
  })
  @IsOptional()
  @IsIn(MEMORY_VIEW_RESOLUTIONS)
  availableResolution?: MemoryViewResolution;

  /** 按来源锚状态过滤（`fresh` = 仍可重新校验通过） */
  @ApiPropertyOptional({ enum: MEMORY_VIEW_ANCHOR_STATES, description: 'Filter by anchor state' })
  @IsOptional()
  @IsIn(MEMORY_VIEW_ANCHOR_STATES)
  anchorState?: MemoryViewAnchorState;

  /** 按关系边类型过滤（只影响 `edges[]`：节点集不受它影响） */
  @ApiPropertyOptional({
    enum: MEMORY_VIEW_RELATION_TYPES,
    description: 'Filter edges by relation type',
  })
  @IsOptional()
  @IsIn(MEMORY_VIEW_RELATION_TYPES)
  relationType?: MemoryViewRelationType;

  /**
   * 创建时刻下界（RFC3339 字符串，**闭区间**）。
   *
   * ⚠️ 显式 `type: 'string'` + `format`：本仓未启用 swagger CLI 插件，联合/可选标量的
   * 反射类型会落成 `type: object`，MCP client 会按对象传参（守卫见 `swagger-schema.spec.ts`）。
   * ⚠️ **逐字透传，禁止 Date 转换**（见文件头不变量）。
   */
  @ApiPropertyOptional({
    type: 'string',
    format: 'date-time',
    description: 'Only memories created at/after this instant (RFC3339, passed through verbatim)',
  })
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  /** 创建时刻上界（RFC3339 字符串，**闭区间**；必须 >= `createdFrom`） */
  @ApiPropertyOptional({
    type: 'string',
    format: 'date-time',
    description: 'Only memories created at/before this instant (RFC3339; must be >= createdFrom)',
  })
  @IsOptional()
  @IsISO8601()
  @IsCreatedRangeOrder()
  createdTo?: string;

  /**
   * 本页节点数上限（平台护栏 ≤200）。
   *
   * ⚠️ **不是引擎默认值漂移**：引擎默认档恰是 200，但这里是**平台的输入上限**（权限过滤是逐节点的，
   * 见 memory.constants 的取证）。客户端要更大页本批不支持。
   */
  @ApiPropertyOptional({
    description:
      'Node page size (platform cap 200 — the engine default档; larger pages unsupported)',
    minimum: 1,
    maximum: MEMORY_VIEW_NODE_LIMIT_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEMORY_VIEW_NODE_LIMIT_MAX)
  nodeLimit?: number;

  /** 本页边数上限（平台护栏 ≤600 = 与节点默认档同档匹配；边不参与引用预载） */
  @ApiPropertyOptional({
    description: 'Edge page size (platform cap 600)',
    minimum: 1,
    maximum: MEMORY_VIEW_EDGE_LIMIT_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEMORY_VIEW_EDGE_LIMIT_MAX)
  edgeLimit?: number;

  /** 节点 preview 的字符上限（合同上限 512；引擎默认 160；平台不设默认值） */
  @ApiPropertyOptional({
    description: 'Preview length limit (contract ≤512; engine default 160)',
    minimum: 1,
    maximum: MEMORY_VIEW_PREVIEW_SCALARS_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEMORY_VIEW_PREVIEW_SCALARS_MAX)
  previewScalars?: number;

  /**
   * 翻页游标（**同时绑 snapshot 与 query digest**）。
   *
   * ⚠️ 消费纪律（前端必须遵守）：携此游标**改任一过滤器或页大小** ⇒ 引擎 `400 invalid_argument`；
   * 翻页途中引擎快照变化 ⇒ `409 snapshot_stale`。两者在平台侧都落 `502/14004` + `engineCode`
   * 逐字透传，**消费动作相同**：丢弃已累积页、重拉第一页。
   */
  @ApiPropertyOptional({
    description:
      'Projection cursor. It is bound to BOTH the snapshot and the query digest: changing any ' +
      'filter or page size while carrying it makes the engine answer 400 invalid_argument, and a ' +
      'snapshot change answers 409 snapshot_stale — both surface as 502/14004 (engineCode kept ' +
      'verbatim) and both mean: drop the accumulated pages and refetch page 1.',
    maxLength: MEMORY_VIEW_CURSOR_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(1, MEMORY_VIEW_CURSOR_MAX_LENGTH)
  cursor?: string;
}

/** detail 投影的关系分页入参（`GET /memory/projects/:id/views/memories/:engineMemoryId`） */
export class QueryMemoryViewRelationsDto {
  /** 本页关系数上限（合同 ≤128） */
  @ApiPropertyOptional({
    description: 'Relation page size (contract ≤128)',
    minimum: 1,
    maximum: MEMORY_VIEW_RELATION_LIMIT_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEMORY_VIEW_RELATION_LIMIT_MAX)
  relationLimit?: number;

  /** 关系分页游标（同样绑 snapshot + query digest，失效语义见 `QueryMemoryViewGraphDto.cursor`） */
  @ApiPropertyOptional({
    description: 'Relation cursor (same snapshot/query binding semantics as the graph cursor)',
    maxLength: MEMORY_VIEW_CURSOR_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(1, MEMORY_VIEW_CURSOR_MAX_LENGTH)
  relationCursor?: string;
}

/**
 * relations（关系建议）端点的**空 query DTO**（`GET …/views/memories/:engineMemoryId/relations`）。
 *
 * ⚠️ **它是刻意空的**：合同的这个端点**没有任何可选查询参数**（只有 `workspace_id`/`actor_id`/
 * `scope` 三件套，而它们由平台从注册表派生、恒填 `actor_private`，**不在调用方的选择面里**）
 * ——本类存在的唯一目的是让全局 `forbidNonWhitelisted` 把**任何** query 参数拒成 400。
 *
 * ⚠️ **不声明 `@Query()` 的后果**（也是本类不能删的理由）：没有类元类型时 ValidationPipe
 * 直接短路，`?scope=owner_shared` 这类请求会被**静默忽略**并照常 200——与既有读面族的
 * 书面纪律（"任何未声明参数会被直接 400"）当场不一致，且把"作用域不可选"从 fail-closed
 * 降级成"看起来可选、其实无效"。
 *
 * ⚠️ 与 `QueryMemoryViewRelationsDto` **不是一回事**（名字接近，用途完全不同）：那个是
 * **detail** 端点里 `sections.relations` 的**分页参数**（有 `relationLimit`/`relationCursor`）；
 * 本类对应的端点是**关系建议**（引擎侧 `advisories`），合同上**没有** limit/cursor——
 * 有界性由响应的 `truncated` 承担。两套不可互相复用（拿分页参数喂本端点 = 400）。
 *
 * 空类不触发 class-validator 的 `forbidUnknownValues` 短路：`@nestjs/common` 的
 * ValidationPipe 默认把它设为 `false`（已核对 `pipes/validation.pipe.js`），
 * 故 `whitelist + forbidNonWhitelisted` 对空类**照常生效**（e2e 与 DTO 单测各有一条钉住）。
 */
export class QueryMemoryViewRelationAdvisoriesDto {}

/** history 分页入参（`GET …/views/memories/:engineMemoryId/history/:resolution`） */
export class QueryMemoryViewHistoryDto {
  /**
   * 本页旧版本数上限（合同 ≤100）。
   *
   * ⚠️ 空结果是**合法常态**：同一记忆在同一分辨率下被**重新形成**时才产生旧版本；更正
   * （跨记忆 supersedes）**不产生**旧版本——消费方不要把空列表读成缺陷。
   */
  @ApiPropertyOptional({
    description: 'History page size (contract ≤100; an empty list is a normal state)',
    minimum: 1,
    maximum: MEMORY_VIEW_HISTORY_LIMIT_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEMORY_VIEW_HISTORY_LIMIT_MAX)
  historyLimit?: number;

  /** 分页游标（同样绑 snapshot + query digest，失效语义见 `QueryMemoryViewGraphDto.cursor`） */
  @ApiPropertyOptional({
    description: 'History cursor (same snapshot/query binding semantics as the graph cursor)',
    maxLength: MEMORY_VIEW_CURSOR_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(1, MEMORY_VIEW_CURSOR_MAX_LENGTH)
  cursor?: string;
}

// ══════════════════════════════════════════════════════════════════════════
// 四个单记忆端点的**路径参数** DTO（detail / history / representation / relations）
//
// ⚠️ **为什么用 params DTO 而不是给裸 `@Param('x') x: string` 挂装饰器**：
// 全局 `ValidationPipe` 的 `toValidate` 对**标量元类型**（String/Number/Boolean/…）直接短路
// ——实测：`pipe.transform('m'.repeat(200), { type: 'param', metatype: String })` **原样返回**
// （不校验），而同一个 pipe 对**类元类型**会抛 Bad Request。也就是说，`@Length` 写在
// `@Param('engineMemoryId') engineMemoryId: string` 上是一段**永不生效的死代码**（看起来有闸门、
// 实际没有）。故四个端点统一改成 params DTO：元类型是类 ⇒ 真被校验，且 `:id` 顺带走 `@IsUUID()`
// （与 `ParseUUIDPipe` 等价的 400 语义）。
//
// ⚠️ **每个 DTO 必须声明该路由的「全部」路径参数**：`forbidNonWhitelisted` 会拒绝任何
// "出现在 params 里但没被声明"的键——少写一个（例如给 detail 路由漏了 `engineMemoryId`）
// 会让这条路由**每个请求都 400**。这也是四个 DTO 各自完整重列的原因（不复用父类、
// **也不因为"组合恰好相同"就复用同类**：路径参数组合本来就不同时，复用只会让"漏声明"更难看出来）。
// ══════════════════════════════════════════════════════════════════════════

/** detail 端点的路径参数（`GET …/views/memories/:engineMemoryId`） */
export class MemoryViewDetailParamsDto {
  /** 记忆项目 UUID */
  @ApiProperty({ description: 'Memory project UUID' })
  @IsUUID()
  id: string;

  /** 引擎侧 memory id（**不是** UUID，故不能套 ParseUUIDPipe；合同 ≤128） */
  @ApiProperty({ description: 'Engine memory id (not a UUID)' })
  @IsString()
  @Length(1, MEMORY_VIEW_ENGINE_ID_MAX_LENGTH)
  engineMemoryId: string;
}

/** history 端点的路径参数（`GET …/views/memories/:engineMemoryId/history/:resolution`） */
export class MemoryViewHistoryParamsDto {
  /** 记忆项目 UUID */
  @ApiProperty({ description: 'Memory project UUID' })
  @IsUUID()
  id: string;

  /** 引擎侧 memory id（**不是** UUID，故不能套 ParseUUIDPipe；合同 ≤128） */
  @ApiProperty({ description: 'Engine memory id (not a UUID)' })
  @IsString()
  @Length(1, MEMORY_VIEW_ENGINE_ID_MAX_LENGTH)
  engineMemoryId: string;

  /** 分辨率（R0–R4） */
  @ApiProperty({ enum: MEMORY_VIEW_RESOLUTIONS, description: 'Resolution slot (R0–R4)' })
  @IsIn(MEMORY_VIEW_RESOLUTIONS)
  resolution: MemoryViewResolution;
}

/** representation 端点的路径参数（`GET …/views/memories/:engineMemoryId/representations/:representationId`） */
export class MemoryViewRepresentationParamsDto {
  /** 记忆项目 UUID */
  @ApiProperty({ description: 'Memory project UUID' })
  @IsUUID()
  id: string;

  /** 引擎侧 memory id（**不是** UUID，故不能套 ParseUUIDPipe；合同 ≤128） */
  @ApiProperty({ description: 'Engine memory id (not a UUID)' })
  @IsString()
  @Length(1, MEMORY_VIEW_ENGINE_ID_MAX_LENGTH)
  engineMemoryId: string;

  /** 引擎侧 representation id（**不是** UUID；合同 ≤128） */
  @ApiProperty({ description: 'Engine representation id (not a UUID)' })
  @IsString()
  @Length(1, MEMORY_VIEW_ENGINE_ID_MAX_LENGTH)
  representationId: string;
}

/**
 * relations（关系建议）端点的路径参数（`GET …/views/memories/:engineMemoryId/relations`）。
 *
 * ⚠️ 路径参数组合与 detail 相同（`id` + `engineMemoryId`），但**刻意各写一份**而不是复用
 * `MemoryViewDetailParamsDto`（本文件尾段的不变量：路径参数组合本来就不同时，继承/复用会让
 * "漏声明"更难看出来；而**同名复用**还会让 Swagger 的 `@ApiParam` 文案与两个端点的语义脱钩——
 * 一个读账本映射细节，一个读关系建议）。两处**都必须列齐该路由的全部路径参数**：
 * `forbidNonWhitelisted` 会拒绝任何"出现在 params 里但没被声明"的键。
 */
export class MemoryViewRelationsParamsDto {
  /** 记忆项目 UUID */
  @ApiProperty({ description: 'Memory project UUID' })
  @IsUUID()
  id: string;

  /** 引擎侧 memory id（**不是** UUID，故不能套 ParseUUIDPipe；合同 ≤128） */
  @ApiProperty({ description: 'Engine memory id (not a UUID)' })
  @IsString()
  @Length(1, MEMORY_VIEW_ENGINE_ID_MAX_LENGTH)
  engineMemoryId: string;
}
