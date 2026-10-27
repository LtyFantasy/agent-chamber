/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace)
 *   - 补充: docs/architecture.md §3.2 (DocSpace 模块)
 *
 * [踩坑索引] P2-#3(name 缺 @MinLength) P2-#15(显式 null 清空 description) B1(数组上限)
 *            V1(settings 词表三键：null 需 ValidateIf 放行 + 上限对齐写入侧)
 *
 * [铁律关联] #21(双层校验) #17(测试契约) #11(注释)
 *
 * [详细踩坑]（最多 5 条）
 *   V1: settings 词表三键（docTypes/canonicalTags/pathTypes，v1.92.0-dev）照 overviewFilter
 *      先例——「字段出现即采用 / 显式 null 删键」语义，故每个可空键必须 @ValidateIf(o => o.x !== null)
 *      排除 null，否则 null 落入 @IsArray/@ValidateNested 被 400 拒绝（与 P2-#15 同根）。
 *      上限常量取自 shared（DOC_SPACE_*），与写入侧归一/校验共用单一事实来源。
 *   B1: overviewFilter 的 excludeTypes/excludeCategories 缺数量/长度上限，无界数组可撑大
 *      settings jsonb。修复：@ArrayMaxSize(20) + 每项 @MaxLength（64/128，对齐 docType/slug 单值上限）。
 *      见 memory/2026-08-03.md §B1
 *   P2-#15: PATCH 合并逻辑用 `?? existing` 时显式 null 无法清空字段。
 *          修复：DTO `description?: string | null` + @ValidateIf 放行 null，
 *          service 用 `'description' in dto` 判定（出现即采用，未出现才保留）。
 *          见 memory/2026-08-02.md §批次 A8。
 *   P2-#3: name 缺 @MinLength(1)，空串可覆盖空间名（CreateDocSpaceDto 有该校验）。
 *          见 memory/2026-08-02.md §批次 A3。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsArray,
  IsObject,
  MaxLength,
  MinLength,
  ArrayMaxSize,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  Visibility,
  UpdateDocSpaceInput,
  DocSpaceOverviewFilter,
  DocSpaceCanonicalTag,
  DocSpaceHintToggles,
  DocSpacePathType,
  DOC_SPACE_DOC_TYPES_MAX,
  DOC_SPACE_DOC_TYPE_MAX_LENGTH,
  DOC_SPACE_CANONICAL_TAGS_MAX,
  DOC_SPACE_TAG_MAX_LENGTH,
  DOC_SPACE_TAG_ALIASES_MAX,
  DOC_SPACE_PATH_TYPES_MAX,
  DOC_SPACE_PATH_PREFIX_MAX_LENGTH,
} from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 空间级 overview 默认过滤（嵌套校验对象）
 * 只含 exclude 维度（默认视图 = 全量减噪音）；per-call 查询参数逐字段覆盖。
 */
export class DocSpaceOverviewFilterDto implements DocSpaceOverviewFilter {
  @IsOptional()
  @IsArray()
  // 数组数量/长度上限（对齐 upsert-doc.dto.ts tags 约定）：防无界数组撑大 settings jsonb
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true }) // docType 单值上限 64（对齐 UpsertDocDto.docType）
  @ApiPropertyOptional({
    type: [String],
    description:
      'Default excluded docType list (e.g. ["memory"] to filter diary noise out of the default overview)',
    example: ['memory'],
  })
  excludeTypes?: string[];

  @IsOptional()
  @IsArray()
  // 同上：category slug 单值上限 128（对齐 slugify slice(0,128)）
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  @ApiPropertyOptional({
    type: [String],
    description: 'Default excluded category slug list',
    example: ['archive'],
  })
  excludeCategories?: string[];
}

/**
 * 规范标签声明（settings.canonicalTags 元素，v1.92.0-dev 空间词表）
 *
 * value = canonical 落库形态；aliases = 归一命中的别名清单（大小写不敏感）。
 * 上限与 upsert-doc.dto.ts tags 约定对齐（单值 50）。
 */
export class DocSpaceCanonicalTagDto implements DocSpaceCanonicalTag {
  @IsString()
  @MinLength(1)
  @MaxLength(DOC_SPACE_TAG_MAX_LENGTH)
  @ApiPropertyOptional({
    description: 'Canonical tag value (normalization target)',
    example: 'openviking',
  })
  value: string;

  /**
   * 别名清单（**可选**，v1.92.0-dev code-review F5）：缺省等价于空表；消费方一律
   * `?? []`。元素级 `@MinLength(1)`（F4）拦空串，纯空白由 service 层 trim 后 422。
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DOC_SPACE_TAG_ALIASES_MAX)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(DOC_SPACE_TAG_MAX_LENGTH, { each: true })
  @ApiPropertyOptional({
    type: [String],
    description: 'Aliases matched case-insensitively and normalized to value (optional)',
    example: ['OpenViking', 'open-viking'],
  })
  aliases?: string[];
}

/**
 * 路径前缀 → docType 声明（settings.pathTypes 元素，v1.92.0-dev 空间词表）
 *
 * 本期纯声明（写路径零消费）；pathPrefix 不强制尾斜杠，按原样存。
 */
export class DocSpacePathTypeDto implements DocSpacePathType {
  @IsString()
  @MinLength(1)
  @MaxLength(DOC_SPACE_PATH_PREFIX_MAX_LENGTH)
  @ApiPropertyOptional({
    description: 'Path prefix (literal prefix match, no trailing slash enforced)',
    example: 'memory/',
  })
  pathPrefix: string;

  @IsString()
  @MinLength(1)
  @MaxLength(DOC_SPACE_DOC_TYPE_MAX_LENGTH)
  @ApiPropertyOptional({ description: 'Recommended docType for this prefix', example: 'memory' })
  docType: string;
}

export class UpdateDocSpaceDto implements UpdateDocSpaceInput {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Space name', example: 'Updated Docs' })
  name?: string;

  /**
   * 空间描述。显式 null = 清空（service 按「字段出现即采用」语义写 null）；
   * 空串 '' 经 @MinLength(1) 拒绝为 400（@IsOptional 仅放行 null/undefined，不放行 ''）。
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  // 空间图例（v1.41）：description 承载长 markdown 图例（INDEX），cap 放宽到 20000
  @MaxLength(20000)
  // 显式 type：`string | null` 联合类型经 reflect-metadata 推成 Object，仅给 nullable 不足以
  // 修正（Swagger/automcp 仍输出 type:object，MCP 通道传字符串必 400；守卫见 swagger-schema.spec.ts）
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Space description (markdown space legend since v1.41); explicit null clears it (empty string is rejected)',
    example: 'Updated description',
  })
  description?: string | null;

  @IsOptional()
  @IsEnum(Visibility)
  @ApiPropertyOptional({
    enum: Object.values(Visibility),
    description: 'Visibility: open (public) or private',
    example: Visibility.PRIVATE,
  })
  visibility?: Visibility;

  /**
   * Re-binding: topicId and boardId are mutually exclusive.
   * Both provided → 400; one provided → replaces binding.
   * 显式 null = 解除该侧绑定（topicId/boardId 皆 null = 完全解绑）；
   * ValidateIf 需排除 null，否则 null 会落入 IsUUID 校验而 400。
   */
  @IsOptional()
  @IsUUID()
  @ValidateIf((o) => o.topicId !== null && !o.boardId)
  // 显式 type + nullable：string|null 反射推成 object（MCP 通道传字符串必 400）
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Re-bind to a topic (mutually exclusive with boardId); explicit null unbinds',
    example: '550e8400-e29b-41d4-a716-446655440005',
  })
  topicId?: string | null;

  @IsOptional()
  @IsUUID()
  @ValidateIf((o) => o.boardId !== null && !o.topicId)
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Re-bind to a board (mutually exclusive with topicId); explicit null unbinds',
    example: '550e8400-e29b-41d4-a716-446655440006',
  })
  boardId?: string | null;

  /**
   * 空间级 overview 默认过滤（v1.38）；显式 null = 清除（「字段出现即采用」语义，对齐 P2-#15）；
   * ValidateIf 排除 null，否则 null 会落入 @ValidateNested 校验而 400。
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => DocSpaceOverviewFilterDto)
  @ValidateIf((o) => o.overviewFilter !== null)
  @ApiPropertyOptional({
    type: DocSpaceOverviewFilterDto,
    description:
      'Space-level default overview filters (settings.overviewFilter); per-call query params override field-by-field; explicit null clears them',
  })
  overviewFilter?: DocSpaceOverviewFilter | null;

  /**
   * 空间 docType 词表（settings.docTypes，v1.92.0-dev）；显式 null = 清除该键，
   * 未传 = 保留旧值。ValidateIf 排除 null，否则 null 会落入 @IsArray 校验而 400。
   * 大小写不敏感去重的业务校验在 service 层（铁律 #21 双层校验）。
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DOC_SPACE_DOC_TYPES_MAX)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(DOC_SPACE_DOC_TYPE_MAX_LENGTH, { each: true })
  @ValidateIf((o) => o.docTypes !== null)
  @ApiPropertyOptional({
    type: [String],
    description:
      'Declared docType vocabulary (settings.docTypes, advisory soft-check); explicit null clears the key',
    example: ['guide', 'reference', 'memory'],
  })
  docTypes?: string[] | null;

  /**
   * 空间规范标签词表（settings.canonicalTags，v1.92.0-dev）；显式 null = 清除该键。
   * 消费面 = upsert / patch_doc_metadata 写路径的 tag alias 归一。
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => DocSpaceCanonicalTagDto)
  @ArrayMaxSize(DOC_SPACE_CANONICAL_TAGS_MAX)
  @ValidateIf((o) => o.canonicalTags !== null)
  @ApiPropertyOptional({
    type: [DocSpaceCanonicalTagDto],
    description:
      'Declared canonical tag vocabulary with aliases (settings.canonicalTags); consumed by tag alias normalization on write paths; explicit null clears the key',
  })
  canonicalTags?: DocSpaceCanonicalTag[] | null;

  /**
   * 空间路径前缀→docType 声明（settings.pathTypes，v1.92.0-dev）；显式 null = 清除该键。
   * 本期纯声明（无写路径消费）。
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => DocSpacePathTypeDto)
  @ArrayMaxSize(DOC_SPACE_PATH_TYPES_MAX)
  @ValidateIf((o) => o.pathTypes !== null)
  @ApiPropertyOptional({
    type: [DocSpacePathTypeDto],
    description:
      'Declared pathPrefix → docType mappings (settings.pathTypes, declaration only in this phase); explicit null clears the key',
  })
  pathTypes?: DocSpacePathType[] | null;

  /**
   * hint 族开关（settings.hintToggles，v1.92.0-dev 2 期）；显式 null = 清除该键，
   * 未传 = 保留旧值。
   *
   * 双层校验（铁律 #21）：DTO 只保证「是个对象」（@IsObject——格式层）；**族键合法性
   * 与值类型在 service 层**（未知族键 / 非 boolean → 422 DOC_SPACE_HINT_TOGGLES_INVALID）。
   * 为什么不在这里逐键 @IsBoolean：DTO 校验失败是 400，而「拼错的族名」是配置语义错误，
   * 按项目惯例归 422 并带修复凭据（同 validateVocabulary 先例）。
   */
  @IsOptional()
  @IsObject()
  @ValidateIf((o) => o.hintToggles !== null)
  @ApiPropertyOptional({
    type: Object,
    description:
      'Per-family hint toggles (settings.hintToggles): metadata / tags / categories / pathType / ' +
      'routes / read — each boolean, default off. Unknown family keys or non-boolean values → 422 ' +
      'DOC_SPACE_HINT_TOGGLES_INVALID; explicit null clears the key',
    example: { metadata: true, routes: true, read: true },
  })
  hintToggles?: DocSpaceHintToggles | null;
}
