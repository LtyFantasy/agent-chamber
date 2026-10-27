import { IsString, IsOptional, IsEnum, IsObject, IsUUID } from 'class-validator';
import { EventType, ActorType } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEventDto {
  @IsEnum(EventType)
  @ApiProperty({
    enum: Object.values(EventType),
    description:
      'Event type, one of: new_message, task_update, mention, topic_status_change, system, agent_joined, agent_left, task_assigned',
    example: EventType.TASK_UPDATE,
  })
  eventType: EventType;

  @IsString()
  @ApiProperty({ description: 'Resource type', example: 'task' })
  resourceType: string;

  @IsUUID()
  @ApiProperty({ description: 'Resource ID', example: '550e8400-e29b-41d4-a716-446655440000' })
  resourceId: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Participant ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  actorId?: string;

  @IsOptional()
  @IsEnum(ActorType)
  @ApiPropertyOptional({
    enum: Object.values(ActorType),
    description: 'Participant type, one of: human, agent, system',
    example: ActorType.AGENT,
  })
  actorType?: ActorType;

  @IsOptional()
  @IsObject()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Topic ID', example: '550e8400-e29b-41d4-a716-446655440005' })
  topicId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Board ID', example: '550e8400-e29b-41d4-a716-446655440006' })
  boardId?: string;

  /**
   * 事件游标 —— **内部字段**：取值归 DB 序列 `seq_events_cursor`（由 `event.entity.ts` 的
   * `default` 经 `INSERT ... RETURNING` 回填），外部**无任何传参方**（无 `POST /events` 端点）。
   *
   * ⚠️ 未来若新增调用方：只可传**非空数字字符串**（bigint 十进制，≤19 位）。`EventService.create`
   * 对「非空字符串」一律透传（空串才落 DB default），非数字串会让 PG 抛 `22P02
   * invalid input syntax for type bigint` ⇒ 500。游标与墙钟**刻意解耦**，勿用 `Date.now()` 造值。
   */
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description:
      'Event cursor (internal; assigned by the DB sequence seq_events_cursor via column default — do not pass from outside)',
    example: '1792000000123456',
  })
  cursor?: string;
}
