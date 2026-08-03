import { IsString, IsOptional, IsInt, MinLength, MaxLength, Min } from 'class-validator';
import { UpdateDocCategoryInput } from '@agent-chamber/shared';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDocCategoryDto implements UpdateDocCategoryInput {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @ApiPropertyOptional({ description: 'Category name', example: 'Updated Category' })
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @ApiPropertyOptional({
    description: 'URL-friendly slug',
    example: 'updated-category',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ description: 'Category description', example: 'Updated description' })
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ description: 'Sort order (lower = first)', example: 5 })
  sortOrder?: number;
}
