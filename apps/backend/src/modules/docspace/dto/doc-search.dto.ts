import { IsOptional, IsString, Min, Max, IsInt } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class DocSearchDto {
  @IsString()
  @ApiProperty({
    description: 'Search query string',
    example: 'architecture design',
  })
  q: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Filter by document type',
    example: 'architecture',
  })
  type?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Filter by tag',
    example: 'overview',
  })
  tag?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Filter by category slug',
    example: 'architecture',
  })
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  @ApiPropertyOptional({
    description: 'Max number of hits to return (1-20, default 5)',
    default: 5,
    minimum: 1,
    maximum: 20,
  })
  limit?: number;
}
