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

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Cursor', example: 'abc123' })
  cursor?: string;
}
