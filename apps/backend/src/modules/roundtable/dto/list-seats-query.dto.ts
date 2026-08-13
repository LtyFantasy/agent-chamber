/**
 * 座位列表查询 DTO（GET /roundtable/seats?topicId=）
 * 格式校验（UUID）在 DTO；topic 存在性 + read 权限在 Service（铁律 #21）。
 */
import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ListSeatsQueryDto {
  @IsUUID()
  @ApiProperty({
    description: '所属圆桌 topic id',
    example: 'a0b17ace-6fde-4ee3-ba52-17c864f757ef',
  })
  topicId: string;
}
