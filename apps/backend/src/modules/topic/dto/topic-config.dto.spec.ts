import 'reflect-metadata';
import { validate } from 'class-validator';
import { TopicConfigDto } from './topic-config.dto';

describe('TopicConfigDto', () => {
  it('should reject invalid invitedAgentIds', async () => {
    const dto = new TopicConfigDto();
    dto.invitedAgentIds = ['not-a-uuid'];

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'invitedAgentIds' && e.constraints?.isUuid)).toBe(true);
  });
});
