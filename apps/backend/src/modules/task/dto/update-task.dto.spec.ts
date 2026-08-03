import 'reflect-metadata';
import { validate } from 'class-validator';
import { UpdateTaskDto } from './update-task.dto';

describe('UpdateTaskDto', () => {
  it('should reject title exceeding max length', async () => {
    const dto = new UpdateTaskDto();
    dto.title = 'a'.repeat(256);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'title' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject description exceeding max length', async () => {
    const dto = new UpdateTaskDto();
    dto.description = 'a'.repeat(5001);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'description' && e.constraints?.maxLength)).toBe(true);
  });
});
