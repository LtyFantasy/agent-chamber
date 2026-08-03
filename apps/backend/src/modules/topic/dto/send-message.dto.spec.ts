import 'reflect-metadata';
import { validate } from 'class-validator';
import { SendMessageDto } from './send-message.dto';

describe('SendMessageDto', () => {
  it('should reject invalid replyTo UUID', async () => {
    const dto = new SendMessageDto();
    dto.content = 'Hello';
    dto.replyTo = 'not-a-uuid';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'replyTo' && e.constraints?.isUuid)).toBe(true);
  });
});
