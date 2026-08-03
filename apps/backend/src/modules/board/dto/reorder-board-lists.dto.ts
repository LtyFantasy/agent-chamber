import { IsArray, ValidateNested, IsUUID, IsNumber, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { BoardListOrderItemInput, ReorderBoardListsInput } from '@agent-chamber/shared';
import { ApiProperty } from '@nestjs/swagger';

class BoardListOrderItem implements BoardListOrderItemInput {
  @IsUUID()
  @ApiProperty({ description: 'ID', example: '550e8400-e29b-41d4-a716-446655440000' })
  id: string;

  @IsNumber()
  @IsInt()
  @Min(0)
  @ApiProperty({ description: 'Position order', example: 1 })
  position: number;
}

export class ReorderBoardListsDto implements ReorderBoardListsInput {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BoardListOrderItem)
  @ApiProperty({
    description: 'Board list items',
    example: [{ id: '550e8400-e29b-41d4-a716-446655440000', position: 0 }],
  })
  lists: BoardListOrderItem[];
}
