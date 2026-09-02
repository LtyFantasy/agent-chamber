import { IsOptional, IsString, IsInt, Min, Max, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { DOC_TREE_SORT_VALUES, type DocTreeSort } from '@agent-chamber/shared';

// 对外导出兼容：dto/index.ts 从本文件 re-export 的 DOC_TREE_SORT_VALUES/DocTreeSort
// 改指 shared 单源（值/类型均不再本地定义，防契约演进双源漂移）
export { DOC_TREE_SORT_VALUES, type DocTreeSort } from '@agent-chamber/shared';

/**
 * 查询目录树 DTO
 *
 * GET /doc-spaces/:id/docs/tree?prefix=&sort=&docsLimit=&docsOffset=&foldersLimit=&foldersOffset=
 *
 * prefix 缺省 ''（根层）；服务端归一化：去前导 /、非空补尾部 /。
 * limit 类参数走分页硬上限校验（docsLimit max 200 / foldersLimit max 500），
 * 超限 → 400（对齐 spec §7.4 策略 A）；service 层另有 Math.min 纵深防御。
 */
export class QueryDocTreeDto {
  @ApiPropertyOptional({
    description:
      'Path prefix (default "" = root level). Leading "/" stripped, trailing "/" appended when non-empty.',
    default: '',
  })
  @IsOptional()
  @IsString()
  // 路径最长 512，对齐 UpsertDocDto.path @MaxLength(512)
  @MaxLength(512)
  prefix?: string = '';

  @ApiPropertyOptional({
    description:
      'Sort: recent (default, folders by latestDocAt DESC) | name (folders by segment name ASC)',
    enum: DOC_TREE_SORT_VALUES,
    default: 'recent',
  })
  @IsOptional()
  @IsIn(DOC_TREE_SORT_VALUES)
  sort?: DocTreeSort = 'recent';

  @ApiPropertyOptional({
    description: 'Max direct docs per page (default 50, max 200)',
    minimum: 0,
    maximum: 200,
    default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  docsLimit?: number = 50;

  @ApiPropertyOptional({ description: 'Docs offset (default 0)', minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  docsOffset?: number = 0;

  @ApiPropertyOptional({
    description: 'Max folders per page (default 200, max 500)',
    minimum: 0,
    maximum: 500,
    default: 200,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500)
  foldersLimit?: number = 200;

  @ApiPropertyOptional({ description: 'Folders offset (default 0)', minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  foldersOffset?: number = 0;
}
