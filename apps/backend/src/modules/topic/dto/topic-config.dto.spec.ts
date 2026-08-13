import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TopicConfigDto } from './topic-config.dto';

describe('TopicConfigDto', () => {
  it('should reject invalid invitedAgentIds', async () => {
    const dto = new TopicConfigDto();
    dto.invitedAgentIds = ['not-a-uuid'];

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'invitedAgentIds' && e.constraints?.isUuid)).toBe(
      true,
    );
  });

  // ── kind / wakePolicy 校验矩阵（设计 §5/§6 冻结枚举，铁律 #20 契约即设计） ──

  it('kind/wakePolicy 合法值通过（normal/roundtable + mention/broadcast）', async () => {
    for (const kind of ['normal', 'roundtable']) {
      for (const wakePolicy of ['mention', 'broadcast']) {
        const dto = plainToInstance(TopicConfigDto, { kind, wakePolicy });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      }
    }
  });

  it('kind 非法值 → 拒绝', async () => {
    const dto = plainToInstance(TopicConfigDto, { kind: 'board' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'kind' && e.constraints?.isIn)).toBe(true);
  });

  it('wakePolicy 非法值 → 拒绝', async () => {
    const dto = plainToInstance(TopicConfigDto, { wakePolicy: 'yell' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'wakePolicy' && e.constraints?.isIn)).toBe(true);
  });

  it('kind/wakePolicy 缺省不报错（可选项）', async () => {
    const dto = plainToInstance(TopicConfigDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // ── maxRoundsWithoutHuman 校验矩阵（设计 §6 r7：0~1000 整数，0=关闭，缺省 8） ──

  it('maxRoundsWithoutHuman 合法值通过（0=关闭 / 8 缺省 / 1000 上限）', async () => {
    for (const v of [0, 8, 1000]) {
      const dto = plainToInstance(TopicConfigDto, { maxRoundsWithoutHuman: v });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('maxRoundsWithoutHuman 非法值拒绝（负数/小数/超上限/字符串）', async () => {
    for (const v of [-1, 1.5, 1001, 'abc']) {
      const dto = plainToInstance(TopicConfigDto, { maxRoundsWithoutHuman: v });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'maxRoundsWithoutHuman')).toBe(true);
    }
  });

  it('maxRoundsWithoutHuman 缺省不报错（可选项，service 兜底 8）', async () => {
    const dto = plainToInstance(TopicConfigDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
