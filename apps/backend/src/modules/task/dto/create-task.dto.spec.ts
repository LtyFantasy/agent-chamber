import 'reflect-metadata';
import { validate } from 'class-validator';
import { CreateTaskDto } from './create-task.dto';

describe('CreateTaskDto', () => {
  it('should reject title exceeding max length', async () => {
    const dto = new CreateTaskDto();
    dto.listId = '550e8400-e29b-41d4-a716-446655440004';
    dto.title = 'a'.repeat(256);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'title' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject empty title', async () => {
    const dto = new CreateTaskDto();
    dto.listId = '550e8400-e29b-41d4-a716-446655440004';
    dto.title = '';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'title' && (e.constraints?.minLength || e.constraints?.isNotEmpty))).toBe(true);
  });

  it('should reject description exceeding max length', async () => {
    const dto = new CreateTaskDto();
    dto.listId = '550e8400-e29b-41d4-a716-446655440004';
    dto.title = 'Valid Title';
    dto.description = 'a'.repeat(5001);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'description' && e.constraints?.maxLength)).toBe(true);
  });
});
