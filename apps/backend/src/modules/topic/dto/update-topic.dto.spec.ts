import 'reflect-metadata';
import { validate } from 'class-validator';
import { UpdateTopicDto } from './update-topic.dto';

describe('UpdateTopicDto', () => {
  it('should reject title exceeding max length', async () => {
    const dto = new UpdateTopicDto();
    dto.title = 'a'.repeat(256);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'title' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject description exceeding max length', async () => {
    const dto = new UpdateTopicDto();
    dto.description = 'a'.repeat(5001);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'description' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject invalid invitedAgentIds', async () => {
    const dto = new UpdateTopicDto();
    dto.invitedAgentIds = ['not-a-uuid'];

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'invitedAgentIds' && e.constraints?.isUuid)).toBe(true);
  });
});
