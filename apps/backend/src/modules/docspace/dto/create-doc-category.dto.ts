import { IsString, IsOptional, IsInt, MinLength, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateDocCategoryInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDocCategoryDto implements CreateDocCategoryInput {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @ApiProperty({ description: 'Category name', example: 'Architecture' })
  name: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @ApiPropertyOptional({
    description: 'URL-friendly slug. Auto-generated from name if omitted.',
    example: 'architecture',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ description: 'Category description', example: 'System architecture docs' })
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ description: 'Sort order (lower = first)', example: 0, default: 0 })
  sortOrder?: number;
}
