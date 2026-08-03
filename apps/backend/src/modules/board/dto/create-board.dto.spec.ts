import 'reflect-metadata';
import { validate } from 'class-validator';
import { CreateBoardDto } from './create-board.dto';

describe('CreateBoardDto', () => {
  it('should reject name exceeding max length', async () => {
    const dto = new CreateBoardDto();
    dto.name = 'a'.repeat(101);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject empty name', async () => {
    const dto = new CreateBoardDto();
    dto.name = '';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name' && (e.constraints?.minLength || e.constraints?.isNotEmpty))).toBe(true);
  });

  it('should reject description exceeding max length', async () => {
    const dto = new CreateBoardDto();
    dto.name = 'Valid Name';
    dto.description = 'a'.repeat(5001);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'description' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject invalid invitedAgentIds', async () => {
    const dto = new CreateBoardDto();
    dto.name = 'Valid Name';
    dto.invitedAgentIds = ['not-a-uuid'];

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'invitedAgentIds' && e.constraints?.isUuid)).toBe(true);
  });
});
