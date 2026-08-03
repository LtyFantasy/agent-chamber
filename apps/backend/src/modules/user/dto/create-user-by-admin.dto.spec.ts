import 'reflect-metadata';
import { validate } from 'class-validator';
import { CreateUserByAdminDto } from './create-user-by-admin.dto';

describe('CreateUserByAdminDto', () => {
  it('should reject name exceeding max length', async () => {
    const dto = new CreateUserByAdminDto();
    dto.email = 'test@example.com';
    dto.password = 'password123';
    dto.name = 'a'.repeat(101);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject password exceeding max length', async () => {
    const dto = new CreateUserByAdminDto();
    dto.email = 'test@example.com';
    dto.password = 'a'.repeat(129);
    dto.name = 'Valid Name';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'password' && e.constraints?.maxLength)).toBe(true);
  });
});
