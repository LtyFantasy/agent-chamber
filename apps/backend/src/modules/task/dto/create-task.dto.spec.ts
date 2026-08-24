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

  it('should accept listId omitted when statusName is provided', async () => {
    const dto = new CreateTaskDto();
    dto.title = 'Valid Title';
    dto.boardId = '550e8400-e29b-41d4-a716-446655440003';
    dto.statusName = 'in_progress';

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should accept listId without statusName (legacy path)', async () => {
    const dto = new CreateTaskDto();
    dto.listId = '550e8400-e29b-41d4-a716-446655440004';
    dto.title = 'Valid Title';

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject empty statusName', async () => {
    const dto = new CreateTaskDto();
    dto.title = 'Valid Title';
    dto.statusName = '';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'statusName' && e.constraints?.minLength)).toBe(true);
  });

  it('should reject statusName exceeding max length', async () => {
    const dto = new CreateTaskDto();
    dto.title = 'Valid Title';
    dto.statusName = 'a'.repeat(101);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'statusName' && e.constraints?.maxLength)).toBe(true);
  });
});
