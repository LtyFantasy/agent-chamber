/**
 * utils.test.ts — formatDate / formatRelativeTime 双语契约测试
 *
 * 覆盖（plan-frontend-debt-pack 子项 5 钉死，review-0831 任务 04e8d744）：
 * <60s（现在/now）、N分钟档（zh 无空格 "5分钟前"——CLDR 实测，主脑裁决）、
 * 1 天边界（昨天/yesterday）、2 天边界（前天/2 days ago）、>30 天回落
 * （locale 透传）、未来时间对称档位（"N 分钟后"/"in N minutes"，禁止落入
 * format(0)）、formatDate hour12:false 24h 制、null/undefined → '-' 分支。
 */

import { formatDate, formatRelativeTime } from './utils';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 相对 now 偏移构造时间（毫秒）；函数内 now 略晚于构造点（毫秒级），
 *  档位判定余量远大于该误差，断言稳定 */
const offset = (ms: number) => new Date(Date.now() + ms);

describe('formatRelativeTime', () => {
  it('<60s：zh "现在" / en "now"', () => {
    expect(formatRelativeTime(offset(-30 * 1000), 'zh-CN')).toBe('现在');
    expect(formatRelativeTime(offset(-30 * 1000), 'en')).toBe('now');
  });

  it('N分钟档：zh "5分钟前"（CLDR 无空格）/ en "5 minutes ago"', () => {
    expect(formatRelativeTime(offset(-5 * MINUTE), 'zh-CN')).toBe('5分钟前');
    expect(formatRelativeTime(offset(-5 * MINUTE), 'en')).toBe('5 minutes ago');
  });

  it('N小时档：zh "1小时前"（改造前后文案零变化）/ en "1 hour ago"', () => {
    expect(formatRelativeTime(offset(-1 * HOUR), 'zh-CN')).toBe('1小时前');
    expect(formatRelativeTime(offset(-1 * HOUR), 'en')).toBe('1 hour ago');
  });

  it('1 天边界：zh "昨天" / en "yesterday"', () => {
    expect(formatRelativeTime(offset(-1 * DAY), 'zh-CN')).toBe('昨天');
    expect(formatRelativeTime(offset(-1 * DAY), 'en')).toBe('yesterday');
  });

  it('2 天边界：zh "前天" / en "2 days ago"', () => {
    expect(formatRelativeTime(offset(-2 * DAY), 'zh-CN')).toBe('前天');
    expect(formatRelativeTime(offset(-2 * DAY), 'en')).toBe('2 days ago');
  });

  it('>30 天回落 formatDate 且透传 locale（en 不输出 zh 格式）', () => {
    const past = offset(-40 * DAY);
    expect(formatRelativeTime(past, 'zh-CN')).toBe(formatDate(past, 'zh-CN'));
    expect(formatRelativeTime(past, 'en')).toBe(formatDate(past, 'en'));
  });

  it('未来时间对称档位：zh "5分钟后" / en "in 5 minutes"（禁止落入 format(0)）', () => {
    expect(formatRelativeTime(offset(5 * MINUTE), 'zh-CN')).toBe('5分钟后');
    expect(formatRelativeTime(offset(5 * MINUTE), 'en')).toBe('in 5 minutes');
  });

  it('未来 <60s 对称档位：zh "30秒钟后" / en "in 30 seconds"（防 format(0) 回归）', () => {
    expect(formatRelativeTime(offset(30 * 1000), 'zh-CN')).toBe('30秒钟后');
    expect(formatRelativeTime(offset(30 * 1000), 'en')).toBe('in 30 seconds');
  });

  it('未来 >30 天对称回落 formatDate（与过去档位对称）', () => {
    const future = offset(40 * DAY);
    expect(formatRelativeTime(future, 'zh-CN')).toBe(formatDate(future, 'zh-CN'));
    expect(formatRelativeTime(future, 'en')).toBe(formatDate(future, 'en'));
  });

  it('null/undefined → "-"', () => {
    expect(formatRelativeTime(null, 'zh-CN')).toBe('-');
    expect(formatRelativeTime(undefined, 'zh-CN')).toBe('-');
  });
});

describe('formatDate', () => {
  it('hour12:false 24h 制：下午 14:05 不输出 PM（en 默认 12h，此断言防回归）', () => {
    const d = new Date(2026, 7, 31, 14, 5);
    expect(formatDate(d, 'zh-CN')).toContain('14:05');
    expect(formatDate(d, 'en')).toContain('14:05');
    expect(formatDate(d, 'en')).not.toContain('PM');
  });

  it('undefined → "-"', () => {
    expect(formatDate(undefined, 'zh-CN')).toBe('-');
  });
});
