/**
 * roundtable DTO 格式校验单测（class-validator；铁律 #21 双层校验第一层：格式正确性）。
 * 存在性/权限校验在 Service 层，不在本文件覆盖范围。
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateSeatDto } from './create-seat.dto';
import { ListSeatsQueryDto } from './list-seats-query.dto';

describe('CreateSeatDto', () => {
  const validInput = {
    topicId: 'a0b17ace-6fde-4ee3-ba52-17c864f757ef',
    label: 'kimi-1',
    vendor: 'kimi',
    cwd: '/tmp/seat',
    permissionMode: 'auto',
  };

  it('合法输入通过（可选项缺省）', async () => {
    const dto = plainToInstance(CreateSeatDto, validInput);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('合法输入通过（含全部可选项）', async () => {
    const dto = plainToInstance(CreateSeatDto, {
      ...validInput,
      model: 'kimi-k2',
      bindActorId: 'b0b17ace-6fde-4ee3-ba52-17c864f757ef',
      coordinator: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('合法输入通过（vendor=codex，M4a 接入）', async () => {
    const dto = plainToInstance(CreateSeatDto, { ...validInput, vendor: 'codex', model: 'gpt-5.6-luna' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('topicId 非 UUID → 拒绝', async () => {
    const dto = plainToInstance(CreateSeatDto, { ...validInput, topicId: 'not-a-uuid' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'topicId')).toBe(true);
  });

  it('vendor 非已知厂商 → 拒绝（已知 kimi/codex）', async () => {
    const dto = plainToInstance(CreateSeatDto, { ...validInput, vendor: 'gpt' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'vendor')).toBe(true);
  });

  it('permissionMode 非已知枚举 → 拒绝（显式钉死）', async () => {
    const dto = plainToInstance(CreateSeatDto, { ...validInput, permissionMode: 'yolo-extra' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'permissionMode')).toBe(true);
  });

  it('缺失必填字段（label/cwd）→ 拒绝', async () => {
    const dto = plainToInstance(CreateSeatDto, { topicId: validInput.topicId, vendor: 'kimi', permissionMode: 'auto' });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(expect.arrayContaining(['label', 'cwd']));
  });

  it('label 超长 / coordinator 非布尔 → 拒绝', async () => {
    const dto = plainToInstance(CreateSeatDto, {
      ...validInput,
      label: 'x'.repeat(101),
      coordinator: 'yes',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'label')).toBe(true);
    expect(errors.some((e) => e.property === 'coordinator')).toBe(true);
  });

  // ── batchWindowMs 校验矩阵（设计 §6：0=直通 / 缺省 5000 / 上限 300000） ──

  it('batchWindowMs 合法值通过（0=直通、30000、300000 上限）', async () => {
    for (const batchWindowMs of [0, 30000, 300000]) {
      const dto = plainToInstance(CreateSeatDto, { ...validInput, batchWindowMs });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('batchWindowMs 缺省不报错（可选项，service 侧落缺省 5000）', async () => {
    const dto = plainToInstance(CreateSeatDto, validInput);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('batchWindowMs 负数 / 超上限 → 拒绝', async () => {
    const negative = plainToInstance(CreateSeatDto, { ...validInput, batchWindowMs: -1 });
    const errorsNeg = await validate(negative);
    expect(errorsNeg.some((e) => e.property === 'batchWindowMs' && e.constraints?.min)).toBe(true);

    const over = plainToInstance(CreateSeatDto, { ...validInput, batchWindowMs: 300001 });
    const errorsOver = await validate(over);
    expect(errorsOver.some((e) => e.property === 'batchWindowMs' && e.constraints?.max)).toBe(true);
  });

  it('batchWindowMs 非整数（小数/字符串/布尔）→ 拒绝', async () => {
    for (const bad of [1.5, '30000', true]) {
      const dto = plainToInstance(CreateSeatDto, { ...validInput, batchWindowMs: bad });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'batchWindowMs' && e.constraints?.isInt)).toBe(true);
    }
  });
});

describe('ListSeatsQueryDto', () => {
  it('合法 topicId 通过', async () => {
    const dto = plainToInstance(ListSeatsQueryDto, {
      topicId: 'a0b17ace-6fde-4ee3-ba52-17c864f757ef',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('缺失 topicId / 非 UUID → 拒绝', async () => {
    const missing = plainToInstance(ListSeatsQueryDto, {});
    expect((await validate(missing)).some((e) => e.property === 'topicId')).toBe(true);
    const bad = plainToInstance(ListSeatsQueryDto, { topicId: 'x' });
    expect((await validate(bad)).some((e) => e.property === 'topicId')).toBe(true);
  });
});
