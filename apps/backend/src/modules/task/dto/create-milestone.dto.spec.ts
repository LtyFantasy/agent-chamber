import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ValidationPipe } from '@nestjs/common';
import { CreateMilestoneDto } from './create-milestone.dto';
import { MarkMilestoneDeployedDto } from './mark-milestone-deployed.dto';

describe('CreateMilestoneDto', () => {
  const base = { name: 'v1.42.0', boardId: '550e8400-e29b-41d4-a716-446655440004' };

  describe('version', () => {
    it.each([
      'v1.42.0',
      '1.42.0',
      '1.42.0-rc.1',
      'v2.0.0-beta.2',
      '0.1.0',
    ])('should accept valid version %s', async (version) => {
      const dto = plainToInstance(CreateMilestoneDto, { ...base, version });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it.each(['v1.2', '1.2.3.4', 'abc', '1.42', 'v', '1.42.0.0', 'x1.2.3'])(
      'should reject invalid version %s',
      async (version) => {
        const dto = plainToInstance(CreateMilestoneDto, { ...base, version });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'version' && e.constraints?.matches)).toBe(true);
      },
    );

    it('should reject version exceeding 50 chars', async () => {
      const dto = plainToInstance(CreateMilestoneDto, {
        ...base,
        version: `v1.${'2'.repeat(48)}.0`,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'version' && e.constraints?.maxLength)).toBe(true);
    });
  });

  describe('body', () => {
    it('should accept body of 20000 chars', async () => {
      const dto = plainToInstance(CreateMilestoneDto, { ...base, body: 'a'.repeat(20000) });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should reject body of 20001 chars', async () => {
      const dto = plainToInstance(CreateMilestoneDto, { ...base, body: 'a'.repeat(20001) });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'body' && e.constraints?.maxLength)).toBe(true);
    });
  });

  describe('deployMeta whitelist 拦截', () => {
    it('should 400 on deployMeta/deployedAt/verifiedAt (forbidNonWhitelisted 全局 pipe)', async () => {
      const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
      // 与 main.ts 全局 pipe 同配置：未声明字段直接 400——部署事实永远不可经 create/update DTO 写入
      await expect(
        pipe.transform({ ...base, deployMeta: { backup: 'x' } }, {
          type: 'body',
          metatype: CreateMilestoneDto,
        }),
      ).rejects.toBeDefined();
      await expect(
        pipe.transform({ ...base, deployedAt: '2026-08-05T00:00:00Z' }, {
          type: 'body',
          metatype: CreateMilestoneDto,
        }),
      ).rejects.toBeDefined();
      await expect(
        pipe.transform({ ...base, verifiedAt: '2026-08-05T00:00:00Z' }, {
          type: 'body',
          metatype: CreateMilestoneDto,
        }),
      ).rejects.toBeDefined();
    });

    it('should strip non-declared fields when forbidNonWhitelisted is off (whitelist 剥离语义)', async () => {
      const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true });
      const dto = (await pipe.transform({ ...base, deployMeta: { backup: 'x' } }, {
        type: 'body',
        metatype: CreateMilestoneDto,
      })) as CreateMilestoneDto;
      expect(dto).not.toHaveProperty('deployMeta');
      expect(dto.name).toBe(base.name);
    });
  });
});

describe('MarkMilestoneDeployedDto', () => {
  it('should accept empty body (all fields optional)', async () => {
    const dto = plainToInstance(MarkMilestoneDeployedDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should accept full payload', async () => {
    const dto = plainToInstance(MarkMilestoneDeployedDto, {
      anchors: { health: 'ok' },
      backup: 'backup-20260805.sql',
      migrations: ['M1'],
      deployedAt: '2026-08-05T00:00:00Z',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject backup exceeding 500 chars', async () => {
    const dto = plainToInstance(MarkMilestoneDeployedDto, { backup: 'a'.repeat(501) });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'backup' && e.constraints?.maxLength)).toBe(true);
  });

  it('should reject non-ISO deployedAt', async () => {
    const dto = plainToInstance(MarkMilestoneDeployedDto, { deployedAt: '2026/08/05' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'deployedAt' && e.constraints?.isIso8601)).toBe(true);
  });

  it('should reject non-string migrations', async () => {
    const dto = plainToInstance(MarkMilestoneDeployedDto, { migrations: [123] });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'migrations' && e.constraints?.isString)).toBe(true);
  });

  it('should reject non-object anchors', async () => {
    const dto = plainToInstance(MarkMilestoneDeployedDto, { anchors: 'ok' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'anchors' && e.constraints?.isObject)).toBe(true);
  });
});
