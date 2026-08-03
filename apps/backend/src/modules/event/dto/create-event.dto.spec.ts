import 'reflect-metadata';
import { validate } from 'class-validator';
import { CreateEventDto } from './create-event.dto';
import { EventType } from '@agent-chamber/shared';

describe('CreateEventDto', () => {
  it('should reject invalid resourceId UUID', async () => {
    const dto = new CreateEventDto();
    dto.eventType = EventType.TASK_UPDATE;
    dto.resourceType = 'task';
    dto.resourceId = 'not-a-uuid';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'resourceId' && e.constraints?.isUuid)).toBe(true);
  });

  it('should reject invalid actorId UUID', async () => {
    const dto = new CreateEventDto();
    dto.eventType = EventType.TASK_UPDATE;
    dto.resourceType = 'task';
    dto.resourceId = '550e8400-e29b-41d4-a716-446655440000';
    dto.actorId = 'not-a-uuid';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'actorId' && e.constraints?.isUuid)).toBe(true);
  });

  it('should reject invalid topicId UUID', async () => {
    const dto = new CreateEventDto();
    dto.eventType = EventType.TASK_UPDATE;
    dto.resourceType = 'task';
    dto.resourceId = '550e8400-e29b-41d4-a716-446655440000';
    dto.topicId = 'not-a-uuid';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'topicId' && e.constraints?.isUuid)).toBe(true);
  });

  it('should reject invalid boardId UUID', async () => {
    const dto = new CreateEventDto();
    dto.eventType = EventType.TASK_UPDATE;
    dto.resourceType = 'task';
    dto.resourceId = '550e8400-e29b-41d4-a716-446655440000';
    dto.boardId = 'not-a-uuid';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'boardId' && e.constraints?.isUuid)).toBe(true);
  });
});
