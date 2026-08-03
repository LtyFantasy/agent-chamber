import 'reflect-metadata';
import { validate } from 'class-validator';
import { UpdateUserByAdminDto } from './update-user-by-admin.dto';

describe('UpdateUserByAdminDto', () => {
  it('should reject name exceeding max length', async () => {
    const dto = new UpdateUserByAdminDto();
    dto.name = 'a'.repeat(101);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name' && e.constraints?.maxLength)).toBe(true);
  });
});
