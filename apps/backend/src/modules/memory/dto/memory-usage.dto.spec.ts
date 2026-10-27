/**
 * Usage 请求 DTO 的**边界校验**单测（铁律 #21 层 1）。
 *
 * 覆盖：时间必须带时区 / `since < until` / ≤90 天 / 两侧同时给；summary 无分页；
 * trace limit 1–200（0 被拒）；cursor 必须与显式时间窗同现；未知属性（scope / 身份 /
 * body）被全局白名单拒绝。
 */
import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  QueryMemoryUsageSummaryDto,
  QueryMemoryUsageTraceDto,
} from './memory-usage.dto';

/** 只取被触发字段的错误 */
async function fieldErrors(dto: object, property: string) {
  const errors = await validate(dto);
  return errors.filter((error) => error.property === property);
}

/** 全局 ValidationPipe（与生产同参：白名单 + 拒绝未知键 + transform） */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/** 对 query 形态跑一次真实管道 */
async function transformQuery<T>(metatype: new () => T, value: Record<string, unknown>): Promise<T> {
  return (await pipe.transform(value, { type: 'query', metatype })) as T;
}

describe('QueryMemoryUsageSummaryDto', () => {
  const base = {
    operation: 'formation',
    providerOperation: 'generation',
    model: 'model-a',
    since: '2026-10-01T00:00:00Z',
    until: '2026-10-02T00:00:00Z',
  };

  it('正例：两侧都可省略（服务端物化默认窗口）', async () => {
    const dto = plainToInstance(QueryMemoryUsageSummaryDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it('正例：带时区（Z / +08:00 / 小数秒）均通过', async () => {
    for (const [since, until] of [
      ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'],
      ['2026-10-01T08:00:00+08:00', '2026-10-02T08:00:00+08:00'],
      ['2026-10-01T00:00:00.123456789Z', '2026-10-02T00:00:00.123456789Z'],
    ]) {
      const dto = plainToInstance(QueryMemoryUsageSummaryDto, { ...base, since, until });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('反例：无时区 / 只有日期 / 非法串 ⇒ 拒绝（不做 Date 转换/猜测）', async () => {
    for (const bad of [
      '2026-10-01T00:00:00',
      '2026-10-01',
      'not-a-dateZ',
      '2026-13-01T00:00:00Z',
    ]) {
      const errors = await fieldErrors(
        plainToInstance(QueryMemoryUsageSummaryDto, { since: bad, until: base.until }),
        'since',
      );
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('反例：只给一侧 ⇒ 400（无界窗口会绕过 90 天上限）', async () => {
    expect(
      (
        await fieldErrors(
          plainToInstance(QueryMemoryUsageSummaryDto, { since: base.since }),
          'until',
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await fieldErrors(
          plainToInstance(QueryMemoryUsageSummaryDto, { until: base.until }),
          'since',
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('反例：since ≥ until / 超过 90 天 ⇒ 拒绝；恰好 90 天通过', async () => {
    for (const [since, until] of [
      ['2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'],
      ['2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z'],
      ['2026-01-01T00:00:00Z', '2026-04-02T00:00:01Z'],
    ]) {
      const errors = await fieldErrors(
        plainToInstance(QueryMemoryUsageSummaryDto, { since, until }),
        'until',
      );
      expect(errors.length).toBeGreaterThan(0);
    }

    const exactly90 = plainToInstance(QueryMemoryUsageSummaryDto, {
      since: '2026-01-01T00:00:00Z',
      until: '2026-04-01T00:00:00Z',
    });
    expect(await validate(exactly90)).toHaveLength(0);
  });

  it('model 做 trim；trim 后为空 / 超 200 ⇒ 拒绝', async () => {
    const trimmed = plainToInstance(QueryMemoryUsageSummaryDto, { model: '  model-a  ' });
    expect(trimmed.model).toBe('model-a');
    expect(await validate(trimmed)).toHaveLength(0);

    expect(
      (await fieldErrors(plainToInstance(QueryMemoryUsageSummaryDto, { model: '   ' }), 'model'))
        .length,
    ).toBeGreaterThan(0);
    expect(
      (
        await fieldErrors(
          plainToInstance(QueryMemoryUsageSummaryDto, { model: 'm'.repeat(201) }),
          'model',
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('summary **没有** limit / cursor 属性；多传（含 scope/身份/body）被白名单拒绝', async () => {
    expect('limit' in new QueryMemoryUsageSummaryDto()).toBe(false);
    expect('cursor' in new QueryMemoryUsageSummaryDto()).toBe(false);

    for (const extra of [
      { limit: 10 },
      { cursor: 'c1' },
      { scope: 'actor_private' },
      { workspaceId: 'ws-1' },
      { actorId: 'actor-1' },
      { body: 'x' },
    ]) {
      await expect(
        transformQuery(QueryMemoryUsageSummaryDto, {
          since: base.since,
          until: base.until,
          ...extra,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('QueryMemoryUsageTraceDto', () => {
  const window = {
    since: '2026-10-01T00:00:00Z',
    until: '2026-10-02T00:00:00Z',
  };

  it('limit：1 与 200 通过；0 / 201 / 负数 / 小数 ⇒ 拒绝', async () => {
    for (const ok of [1, 200]) {
      expect(
        await fieldErrors(plainToInstance(QueryMemoryUsageTraceDto, { ...window, limit: ok }), 'limit'),
      ).toHaveLength(0);
    }
    for (const bad of [0, 201, -1, 1.5]) {
      expect(
        (
          await fieldErrors(
            plainToInstance(QueryMemoryUsageTraceDto, { ...window, limit: bad }),
            'limit',
          )
        ).length,
      ).toBeGreaterThan(0);
    }
  });

  it('cursor：必须与显式 since + until 同现（缺任一 ⇒ 拒绝）', async () => {
    const ok = plainToInstance(QueryMemoryUsageTraceDto, { ...window, cursor: 'c1' });
    expect(await validate(ok)).toHaveLength(0);

    for (const missing of [{}, { since: window.since }, { until: window.until }]) {
      const errors = await fieldErrors(
        plainToInstance(QueryMemoryUsageTraceDto, { ...missing, cursor: 'c1' }),
        'cursor',
      );
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('cursor 长度上限 4096（空串/超长拒绝）', async () => {
    for (const bad of ['', 'c'.repeat(4097)]) {
      const errors = await fieldErrors(
        plainToInstance(QueryMemoryUsageTraceDto, { ...window, cursor: bad }),
        'cursor',
      );
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('trace 也拒绝未知属性（scope / 身份 / body）', async () => {
    for (const extra of [
      { scope: 'actor_private' },
      { workspaceId: 'ws-1' },
      { actorId: 'actor-1' },
      { body: 'x' },
    ]) {
      await expect(
        transformQuery(QueryMemoryUsageTraceDto, { ...window, ...extra }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
