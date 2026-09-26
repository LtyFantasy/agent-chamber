/**
 * zero-hit-log.ts 契约单测：截断 / 控制符剥离 / 脱敏 / JSONL 单行形态。
 * 消费方侧的「零命中分支各调一次」由四消费方各自 spec 的 jest spy 断言承担。
 */
import { Logger } from '@nestjs/common';
import {
  ZERO_HIT_LOG_TAG,
  ZERO_HIT_QUERY_MAX_CHARS,
  buildZeroHitLogLine,
  logSearchZeroHit,
  redactForLog,
  truncateForLog,
} from './zero-hit-log';

describe('truncateForLog', () => {
  it('截 50 码点（不拆代理对）', () => {
    const long = '出'.repeat(60);
    const out = truncateForLog(long);
    expect([...out]).toHaveLength(ZERO_HIT_QUERY_MAX_CHARS);
    expect(ZERO_HIT_QUERY_MAX_CHARS).toBe(50);
    // Ext B 字符（代理对）不被腰斩：40 个 Ext B 字 = 40 码点全保留
    const extB = '𠀀'.repeat(40);
    expect([...truncateForLog(extB)]).toHaveLength(40);
  });

  it('剥离 \\r\\n / U+0000 / U+2028 / U+2029 / U+0085（JSONL 单行纪律）', () => {
    const dirty = 'a\rb\n\0c\u2028d\u2029e\u0085f';
    expect(truncateForLog(dirty)).toBe('abcdef');
  });

  it('保留普通空白（\\t 与用户原生空格是合法内容）', () => {
    expect(truncateForLog('a b\tc')).toBe('a b\tc');
  });
});

describe('redactForLog', () => {
  it('ask_ key 吃整个值（半掩码红线）', () => {
    expect(redactForLog('用 ask_deadbeef123 调的')).toBe('用 [redacted] 调的');
  });

  it('sk-/apikey_/password 族掩码', () => {
    expect(redactForLog('sk-abcdef123')).toBe('[redacted]');
    expect(redactForLog('apikey_xyz_789')).toBe('[redacted]');
    expect(redactForLog('password = hunter2')).toBe('[redacted]');
  });

  it('普通查询不受影响', () => {
    expect(redactForLog('出境 流程')).toBe('出境 流程');
  });
});

describe('buildZeroHitLogLine', () => {
  it('单行 JSON：tag/surface/q 三键，q 经截断+脱敏通道', () => {
    const line = buildZeroHitLogLine({ surface: 'doc', query: '出境' });
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({ tag: ZERO_HIT_LOG_TAG, surface: 'doc', q: '出境' });
  });

  it('q 里的引号/换行不击穿 JSON 结构（禁模板拼接的机械证明）', () => {
    const line = buildZeroHitLogLine({ surface: 'task', query: 'a"b\nc\\d' });
    expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(line).q).toBe('a"bc\\d');
  });

  it('截断元数据按值落行（queryTruncated=false / armTruncatedCount=0 不落）', () => {
    const parsed = JSON.parse(
      buildZeroHitLogLine({
        surface: 'experience',
        query: 'q',
        queryTruncated: true,
        armTruncatedCount: 6,
      }),
    );
    expect(parsed.queryTruncated).toBe(true);
    expect(parsed.armTruncatedCount).toBe(6);
    const bare = JSON.parse(
      buildZeroHitLogLine({ surface: 'message', query: 'q', queryTruncated: false, armTruncatedCount: 0 }),
    );
    expect(bare).not.toHaveProperty('queryTruncated');
    expect(bare).not.toHaveProperty('armTruncatedCount');
  });
});

describe('logSearchZeroHit（jest spy 断言锚点）', () => {
  it('经 logger.warn 落一行 JSONL', () => {
    const logger = { warn: jest.fn() } as unknown as Logger;
    logSearchZeroHit(logger, { surface: 'doc', query: '闸' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = (logger.warn as jest.Mock).mock.calls[0][0] as string;
    expect(JSON.parse(line)).toEqual({ tag: ZERO_HIT_LOG_TAG, surface: 'doc', q: '闸' });
  });
});
