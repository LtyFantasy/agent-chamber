import 'reflect-metadata';
import { validate } from 'class-validator';
import { UpdateBoardDto } from './update-board.dto';

describe('UpdateBoardDto', () => {
  it('should reject name exceeding max length', async () => {
    const dto = new UpdateBoardDto();
    dto.name = 'a'.repeat(101);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject description exceeding max length', async () => {
    const dto = new UpdateBoardDto();
    dto.description = 'a'.repeat(20001);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'description' && e.constraints?.maxLength)).toBe(true);
  });

  it('should accept description at max length (v1.41 board legend cap 20000)', async () => {
    const dto = new UpdateBoardDto();
    dto.description = 'a'.repeat(20000);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'description')).toBe(false);
  });

  it('should reject invalid invitedAgentIds', async () => {
    const dto = new UpdateBoardDto();
    dto.invitedAgentIds = ['not-a-uuid'];

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'invitedAgentIds' && e.constraints?.isUuid)).toBe(true);
  });
});
