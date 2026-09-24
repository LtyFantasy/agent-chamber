/**
 * usage-stats 常量/归一化单测（plan §4 批 1.6：头截断与词表化的纯函数侧）。
 *
 * 词表化是 flush 管线的生存条件（PG 对超长 varchar 报 22001 不截断，一行坏值
 * 打死整批 INSERT），故边界值逐条钉死。
 */
import {
  normalizeUsageSurface,
  normalizeUsageToolName,
  resolveUsageFlushIntervalMs,
  toStatusClass,
  toUtcHourBucket,
  USAGE_FLUSH_DEFAULT_INTERVAL_MS,
  USAGE_FLUSH_MIN_INTERVAL_MS,
  USAGE_SURFACE_UNKNOWN,
  USAGE_TOOL_NAME_MAX_LENGTH,
} from './usage-stats.constants';

describe('usage-stats.constants', () => {
  describe('normalizeUsageSurface（封闭词表）', () => {
    it.each(['', 'mcp', 'mcp-full', 'unknown'])('词表内取值原样保留：%p', (value) => {
      expect(normalizeUsageSurface(value)).toBe(value);
    });

    it.each([
      ['agent', 'automcp profile 字面值未映射时的原始形态'],
      ['full', '同上'],
      ['MCP', '大小写不敏感不在契约内'],
      ['x'.repeat(200), '超长值（varchar(16) 装不下）'],
      [undefined, '缺省'],
      [null, '显式 null'],
      [42, '非字符串'],
    ])('词表外取值一律归 unknown：%p（%s）', (value: unknown, _reason: string) => {
      expect(normalizeUsageSurface(value)).toBe(USAGE_SURFACE_UNKNOWN);
    });
  });

  describe('normalizeUsageToolName（≤128 截断）', () => {
    it('短名原样保留（含 __invalid__ 哨兵）', () => {
      expect(normalizeUsageToolName('topic.create')).toBe('topic.create');
      expect(normalizeUsageToolName('__invalid__')).toBe('__invalid__');
    });

    it('恰好 128 字符不截断', () => {
      const name = 'a'.repeat(USAGE_TOOL_NAME_MAX_LENGTH);
      expect(normalizeUsageToolName(name)).toBe(name);
    });

    it('超长按码点截断到 128（ASCII）', () => {
      const result = normalizeUsageToolName('a'.repeat(200));
      expect(result).toHaveLength(USAGE_TOOL_NAME_MAX_LENGTH);
    });

    it('超长按码点截断不切开代理对（emoji 不会被切成半个字符）', () => {
      const result = normalizeUsageToolName('😀'.repeat(200));
      // 码点数 = 128（列宽口径），码元数 = 256——若用 slice() 会是码元口径
      expect(Array.from(result)).toHaveLength(USAGE_TOOL_NAME_MAX_LENGTH);
      expect(result).toHaveLength(USAGE_TOOL_NAME_MAX_LENGTH * 2);
      expect(result).not.toContain('\uFFFD');
    });

    it('非字符串归空串', () => {
      expect(normalizeUsageToolName(undefined)).toBe('');
      expect(normalizeUsageToolName(123)).toBe('');
    });
  });

  describe('toStatusClass', () => {
    it.each([
      [200, '2xx'],
      [201, '2xx'],
      [204, '2xx'],
      [302, '3xx'],
      [400, '4xx'],
      [404, '4xx'],
      [500, '5xx'],
      [503, '5xx'],
    ])('%i → %s', (status, expected) => {
      expect(toStatusClass(status)).toBe(expected);
    });

    it('越界/非法值归 5xx（列宽 varchar(3) 的护栏）', () => {
      expect(toStatusClass(Number.NaN)).toBe('5xx');
      expect(toStatusClass(0)).toBe('5xx');
      expect(toStatusClass(99)).toBe('5xx');
      expect(toStatusClass(700)).toBe('5xx');
    });
  });

  describe('toUtcHourBucket（D3：应用侧 UTC 截断）', () => {
    it('清分/秒/毫秒，保持 UTC 小时', () => {
      expect(toUtcHourBucket(new Date('2026-09-15T10:37:42.123Z')).toISOString()).toBe(
        '2026-09-15T10:00:00.000Z',
      );
    });

    it('跨日边界归当日 UTC 00:00（不受 host 时区影响）', () => {
      expect(toUtcHourBucket(new Date('2026-09-15T00:00:00.000Z')).toISOString()).toBe(
        '2026-09-15T00:00:00.000Z',
      );
    });

    it('不改写入参（返回新对象）', () => {
      const input = new Date('2026-09-15T10:37:42.123Z');
      toUtcHourBucket(input);
      expect(input.toISOString()).toBe('2026-09-15T10:37:42.123Z');
    });
  });

  describe('resolveUsageFlushIntervalMs（D10）', () => {
    it('合法值原样采用', () => {
      expect(resolveUsageFlushIntervalMs('1500')).toBe(1500);
      expect(resolveUsageFlushIntervalMs('60000')).toBe(60000);
    });

    it.each([undefined, '', 'abc', '0', '-1', '999', 'NaN'])(
      '非法/过小值回落缺省 60000：%p',
      (raw) => {
        expect(resolveUsageFlushIntervalMs(raw)).toBe(USAGE_FLUSH_DEFAULT_INTERVAL_MS);
      },
    );

    it('下限常量与实现一致（防忙循环）', () => {
      expect(resolveUsageFlushIntervalMs(String(USAGE_FLUSH_MIN_INTERVAL_MS))).toBe(
        USAGE_FLUSH_MIN_INTERVAL_MS,
      );
    });
  });
});
