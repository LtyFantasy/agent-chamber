import 'reflect-metadata';
import { validate } from 'class-validator';
import { UpdateAgentDto } from './update-agent.dto';

describe('UpdateAgentDto', () => {
  it('should reject name exceeding max length', async () => {
    const dto = new UpdateAgentDto();
    dto.name = 'a'.repeat(101);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject description exceeding max length', async () => {
    const dto = new UpdateAgentDto();
    dto.description = 'a'.repeat(2001);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'description' && e.constraints?.maxLength)).toBe(true);
  });
});
