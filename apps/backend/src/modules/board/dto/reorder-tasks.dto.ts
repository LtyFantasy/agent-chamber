import {
  ArrayMaxSize,
  IsArray,
  ValidateNested,
  IsUUID,
  IsNumber,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TaskOrderItemInput, ReorderTasksInput } from '@agent-chamber/shared';
import { ApiProperty } from '@nestjs/swagger';

class TaskOrderItem implements TaskOrderItemInput {
  @IsUUID()
  @ApiProperty({ description: 'ID', example: '550e8400-e29b-41d4-a716-446655440000' })
  id: string;

  @IsNumber()
  @IsInt()
  @Min(0)
  @ApiProperty({ description: 'Position order', example: 1 })
  position: number;
}

export class ReorderTasksDto implements ReorderTasksInput {
  @IsArray()
  // 条目上界（先例：memory/dto/nomination.dto.ts:152 的 @ArrayMaxSize(4)）：本端点要过一次
  // 「跨板取出门」——门**按 item 的当前列去重后逐列过**（board.service.ts.reorderTasks 的
  // `for (const currentListId of new Set(rows.map(...)))`），**不是每条 item 各过一遍**；
  // 但成本面仍随条目数增长（去重前的 `IN (…)` 行查询 + 去重后的列数），无上界 = 单个请求
  // 可放大成任意多组 DB 查询（跨板写族闭合引入的成本面，F4-2/V2-N2）。200 远高于任何
  // 真实看板单列的条目数。
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => TaskOrderItem)
  @ApiProperty({
    description: 'Task list',
    example: [{ id: '550e8400-e29b-41d4-a716-446655440000', position: 0 }],
  })
  tasks: TaskOrderItem[];
}
