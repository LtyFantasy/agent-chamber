/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace)
 *   - 补充: docs/architecture.md §3.2 (DocSpace 模块)
 *
 * [踩坑索引] P2-#3(name 缺 @MinLength) P2-#15(显式 null 清空 description) B1(数组上限)
 *
 * [铁律关联] #21(双层校验) #17(测试契约) #11(注释)
 *
 * [详细踩坑]（最多 5 条）
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
  MaxLength,
  MinLength,
  ArrayMaxSize,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Visibility, UpdateDocSpaceInput, DocSpaceOverviewFilter } from '@agent-chamber/shared';
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
  @ApiPropertyOptional({
    description:
      'Space description (markdown space legend since v1.41); explicit null clears it (empty string is rejected)',
    example: 'Updated description',
    nullable: true,
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
  @ApiPropertyOptional({
    description: 'Re-bind to a topic (mutually exclusive with boardId); explicit null unbinds',
    example: '550e8400-e29b-41d4-a716-446655440005',
  })
  topicId?: string | null;

  @IsOptional()
  @IsUUID()
  @ValidateIf((o) => o.boardId !== null && !o.topicId)
  @ApiPropertyOptional({
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
}
