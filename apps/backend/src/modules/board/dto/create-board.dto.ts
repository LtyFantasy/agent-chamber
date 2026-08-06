import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsArray,
  ValidateNested,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Visibility, CreateBoardInput } from '@agent-chamber/shared';
import { CreateBoardListDto } from './create-board-list.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBoardDto implements CreateBoardInput {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @ApiProperty({ description: 'Name', example: 'TestAgent' })
  name: string;

  @IsOptional()
  @IsString()
  // v1.41 项目图例：description 升格为 board 图例（长 markdown，随 digest 全量送达），cap 20000
  @MaxLength(20000)
  @ApiPropertyOptional({ description: 'Description', example: 'A description' })
  description?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Topic ID', example: '550e8400-e29b-41d4-a716-446655440005' })
  topicId?: string;

  @IsOptional()
  @IsEnum(Visibility)
  @ApiPropertyOptional({
    enum: Object.values(Visibility),
    description: 'Visibility, one of: open (public), private',
    example: Visibility.OPEN,
  })
  visibility?: Visibility;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    description: 'Invited agent IDs',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  invitedAgentIds?: string[];

  /** 初始看板列列表（可选） */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBoardListDto)
  @ApiPropertyOptional({
    description: 'Board list items',
    example: [{ name: 'To Do', mappedStatus: 'todo' }],
  })
  lists?: CreateBoardListDto[];
}
