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

/** Nullable declarations must preserve the existing UUID validation boundary. */
describe('UpdateTaskDto milestone patch intent', () => {
  it.each([undefined, null, '550e8400-e29b-41d4-a716-446655440006'])(
    'accepts %p without changing its meaning',
    async (milestoneId) => {
      const dto = Object.assign(
        new UpdateTaskDto(),
        milestoneId === undefined ? {} : { milestoneId },
      );
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.milestoneId).toBe(milestoneId);
    },
  );
  it.each(['', 'not-a-uuid'])(
    'rejects %p rather than treating it as an unbind',
    async (milestoneId) => {
      const dto = Object.assign(new UpdateTaskDto(), { milestoneId });
      expect(
        (await validate(dto)).some(
          (error) => error.property === 'milestoneId' && error.constraints?.isUuid,
        ),
      ).toBe(true);
    },
  );
});
