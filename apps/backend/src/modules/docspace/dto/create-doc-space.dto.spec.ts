import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateDocSpaceDto } from './create-doc-space.dto';

/**
 * CreateDocSpaceDto 校验测试
 * - v1.41：description 图例化（空间图例），cap 放宽到 20000（20001 拒绝 / 20000 通过）
 */
describe('CreateDocSpaceDto', () => {
  it('accepts a valid dto', async () => {
    const dto = plainToInstance(CreateDocSpaceDto, { name: 'Project Docs' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty name (→ 400)', async () => {
    const dto = plainToInstance(CreateDocSpaceDto, { name: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name' && e.constraints?.minLength)).toBe(true);
  });

  describe('description（v1.41 图例化 cap 20000）', () => {
    it('accepts boundary 20000 chars', async () => {
      const dto = plainToInstance(CreateDocSpaceDto, {
        name: 'Docs',
        description: 'a'.repeat(20000),
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects 20001 chars (→ 400)', async () => {
      const dto = plainToInstance(CreateDocSpaceDto, {
        name: 'Docs',
        description: 'a'.repeat(20001),
      });
      const errors = await validate(dto);
      expect(
        errors.some((e) => e.property === 'description' && e.constraints?.maxLength),
      ).toBe(true);
    });

    it('omitted description passes (optional)', async () => {
      const dto = plainToInstance(CreateDocSpaceDto, { name: 'Docs' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });
});
