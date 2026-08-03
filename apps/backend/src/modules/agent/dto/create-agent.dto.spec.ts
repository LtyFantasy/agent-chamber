import 'reflect-metadata';
import { validate } from 'class-validator';
import { CreateAgentDto } from './create-agent.dto';

describe('CreateAgentDto', () => {
  it('should reject name exceeding max length', async () => {
    const dto = new CreateAgentDto();
    dto.name = 'a'.repeat(101);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject empty name', async () => {
    const dto = new CreateAgentDto();
    dto.name = '';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name' && (e.constraints?.minLength || e.constraints?.isNotEmpty))).toBe(true);
  });

  it('should reject description exceeding max length', async () => {
    const dto = new CreateAgentDto();
    dto.name = 'Valid Name';
    dto.description = 'a'.repeat(2001);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'description' && e.constraints?.maxLength)).toBe(true);
  });
});
