import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UsageEventDto } from './usage-event.dto';
import { USAGE_TOOL_NAME_MAX_LENGTH } from '../usage-stats.constants';

/**
 * `POST /system/usage-events` 请求体 DTO 格式校验单测（铁律 #21 双层校验第一层）。
 *
 * 本层只管格式：类型 / 封闭词表 / 数值边界 / 长度。业务语义（surface 收敛、
 * tool_name 截断、成败 → status_class、actor_type 推导）在 buffer 侧，不在此覆盖。
 */
describe('UsageEventDto', () => {
  const validEvent = {
    toolName: 'task',
    surface: 'mcp',
    ok: true,
    latencyMs: 42,
  };

  it('合法上报通过（可选项缺省）', async () => {
    const dto = plainToInstance(UsageEventDto, validEvent);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('surface 词表四个取值全部通过（含 \'\' 与 unknown）', async () => {
    for (const surface of ['', 'mcp', 'mcp-full', 'unknown']) {
      const dto = plainToInstance(UsageEventDto, { ...validEvent, surface });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('toolName 恰好 128 字符通过（列宽上限边界）', async () => {
    const dto = plainToInstance(UsageEventDto, {
      ...validEvent,
      toolName: 'a'.repeat(USAGE_TOOL_NAME_MAX_LENGTH),
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('toolName 超长（129）→ 拒绝（400，不留给 PG 22001 变 500）', async () => {
    const dto = plainToInstance(UsageEventDto, {
      ...validEvent,
      toolName: 'a'.repeat(USAGE_TOOL_NAME_MAX_LENGTH + 1),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'toolName' && e.constraints?.maxLength)).toBe(true);
  });

  it('surface 词表外取值 → 拒绝（DTO 只接受封闭词表）', async () => {
    const dto = plainToInstance(UsageEventDto, { ...validEvent, surface: 'platform-agent-worker' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'surface' && e.constraints?.isIn)).toBe(true);
  });

  it('surface 非字符串 → 拒绝', async () => {
    const dto = plainToInstance(UsageEventDto, { ...validEvent, surface: 123 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'surface')).toBe(true);
  });

  it('latencyMs 负数 → 拒绝（列是 int，负耗时无意义）', async () => {
    const dto = plainToInstance(UsageEventDto, { ...validEvent, latencyMs: -1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'latencyMs' && e.constraints?.min)).toBe(true);
  });

  it('latencyMs 非整数 → 拒绝（列是 int，小数留给 buffer 侧归一）', async () => {
    const dto = plainToInstance(UsageEventDto, { ...validEvent, latencyMs: 12.5 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'latencyMs' && e.constraints?.isInt)).toBe(true);
  });

  it('latencyMs 缺省 → 拒绝（必填）', async () => {
    const dto = plainToInstance(UsageEventDto, { toolName: 'task', surface: 'mcp', ok: true });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'latencyMs')).toBe(true);
  });

  it('ok 非布尔 → 拒绝', async () => {
    const dto = plainToInstance(UsageEventDto, { ...validEvent, ok: 'yes' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ok' && e.constraints?.isBoolean)).toBe(true);
  });

  it('toolName 缺省 → 拒绝（上报行必须有名字，空串是"非 MCP"哨兵）', async () => {
    const dto = plainToInstance(UsageEventDto, { surface: 'mcp', ok: true, latencyMs: 1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'toolName')).toBe(true);
  });

  it("toolName='__invalid__'（pre-name 出口哨兵）通过", async () => {
    const dto = plainToInstance(UsageEventDto, { ...validEvent, toolName: '__invalid__' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('viaFallbackAuth 可省略、可显式 true', async () => {
    expect(await validate(plainToInstance(UsageEventDto, validEvent))).toHaveLength(0);
    const dto = plainToInstance(UsageEventDto, { ...validEvent, viaFallbackAuth: true });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.viaFallbackAuth).toBe(true);
  });

  it('viaFallbackAuth 非布尔 → 拒绝', async () => {
    const dto = plainToInstance(UsageEventDto, { ...validEvent, viaFallbackAuth: 'true' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'viaFallbackAuth')).toBe(true);
  });
});
