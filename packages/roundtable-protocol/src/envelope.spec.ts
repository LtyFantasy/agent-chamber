/**
 * 信封构建与校验测试（docs/roundtable-design.md §4：信封格式 + 座位归属语义）
 */
import {
  buildEnvelope,
  validateEnvelope,
  MESSAGE_TYPES,
  UPLINK_MESSAGE_TYPES,
  DOWNLINK_MESSAGE_TYPES,
  SEATLESS_MESSAGE_TYPES,
} from './envelope';

describe('buildEnvelope', () => {
  it('座位归属消息：写入 seatId/seq，v=1，ts 默认当前时间', () => {
    const env = buildEnvelope('seat.event', { text: 'hi' }, { seatId: 'seat-1', seq: 5 });
    expect(env.v).toBe(1);
    expect(env.type).toBe('seat.event');
    expect(env.seatId).toBe('seat-1');
    expect(env.seq).toBe(5);
    expect(env.ts).toBeGreaterThan(0);
    expect(env.payload).toEqual({ text: 'hi' });
  });

  it('ts 可显式传入', () => {
    const env = buildEnvelope('ping', {}, { ts: 1786073000000 });
    expect(env.ts).toBe(1786073000000);
  });

  it('无座位归属消息（hello/ping/pong/error/hello_ack）：不携带 seatId，seq 固定 0', () => {
    for (const type of ['hello', 'ping', 'pong', 'error', 'hello_ack'] as const) {
      const env = buildEnvelope(type, {});
      expect(env.type).toBe(type);
      expect(env.seatId).toBeUndefined();
      expect(env.seq).toBe(0);
    }
  });

  it('无座位归属消息显式传 seatId → 抛 TypeError', () => {
    expect(() => buildEnvelope('hello', {}, { seatId: 's' })).toThrow(TypeError);
  });

  it('无座位归属消息显式传非零 seq → 抛 TypeError', () => {
    expect(() => buildEnvelope('pong', {}, { seq: 3 })).toThrow(TypeError);
  });

  it('座位归属消息缺 seatId → 抛 TypeError', () => {
    expect(() => buildEnvelope('seat.event', {}, { seq: 1 })).toThrow(TypeError);
  });

  it('座位归属消息缺 seq / seq 非法（负数、小数）→ 抛 TypeError', () => {
    expect(() => buildEnvelope('seat.event', {}, { seatId: 's' })).toThrow(TypeError);
    expect(() => buildEnvelope('seat.event', {}, { seatId: 's', seq: -1 })).toThrow(TypeError);
    expect(() => buildEnvelope('seat.event', {}, { seatId: 's', seq: 1.5 })).toThrow(TypeError);
  });
});

describe('validateEnvelope', () => {
  const seatEnv = () => buildEnvelope('seat.event', {}, { seatId: 'seat-1', seq: 3 });

  it('合法座位归属消息 → ok', () => {
    expect(validateEnvelope(seatEnv()).ok).toBe(true);
  });

  it('合法无座位归属消息 → ok', () => {
    for (const type of ['hello', 'ping', 'pong', 'error'] as const) {
      expect(validateEnvelope(buildEnvelope(type, {})).ok).toBe(true);
    }
  });

  it('非对象输入（null/undefined/字符串/数组）→ 反例', () => {
    expect(validateEnvelope(null).ok).toBe(false);
    expect(validateEnvelope(undefined).ok).toBe(false);
    expect(validateEnvelope('x').ok).toBe(false);
    expect(validateEnvelope([]).ok).toBe(false);
  });

  it('缺 v / v=2 / v=字符串 → 反例', () => {
    const base = buildEnvelope('ping', {});
    const { v, ...noV } = base;
    expect(validateEnvelope(noV).ok).toBe(false);
    expect(validateEnvelope({ ...base, v: 2 }).ok).toBe(false);
    expect(validateEnvelope({ ...base, v: '1' }).ok).toBe(false);
  });

  it('座位归属消息 seq 负数 / 小数 / 字符串 / 缺失 → 反例', () => {
    expect(validateEnvelope({ ...seatEnv(), seq: -1 }).ok).toBe(false);
    expect(validateEnvelope({ ...seatEnv(), seq: 0.5 }).ok).toBe(false);
    expect(validateEnvelope({ ...seatEnv(), seq: '1' }).ok).toBe(false);
    const { seq, ...noSeq } = seatEnv();
    expect(validateEnvelope(noSeq).ok).toBe(false);
  });

  it('hello 带 seatId → 反例', () => {
    expect(validateEnvelope({ ...buildEnvelope('hello', {}), seatId: 's' }).ok).toBe(false);
  });

  it('hello 带非零 seq → 反例', () => {
    expect(validateEnvelope({ ...buildEnvelope('hello', {}), seq: 1 }).ok).toBe(false);
  });

  it('座位归属消息缺 seatId → 反例', () => {
    const { seatId, ...noSeat } = seatEnv();
    expect(validateEnvelope(noSeat).ok).toBe(false);
  });

  it('未知 type → 反例', () => {
    expect(validateEnvelope({ ...buildEnvelope('ping', {}), type: 'unknown.type' }).ok).toBe(false);
  });

  it('ts 缺失 / 非数字 / 负数 → 反例', () => {
    const base = buildEnvelope('ping', {});
    const { ts, ...noTs } = base;
    expect(validateEnvelope(noTs).ok).toBe(false);
    expect(validateEnvelope({ ...base, ts: 'now' }).ok).toBe(false);
    expect(validateEnvelope({ ...base, ts: -5 }).ok).toBe(false);
  });

  it('payload 缺失 / 非对象 / null / 数组 → 反例', () => {
    const base = buildEnvelope('ping', {});
    const { payload, ...noPayload } = base;
    expect(validateEnvelope(noPayload).ok).toBe(false);
    expect(validateEnvelope({ ...base, payload: 'x' }).ok).toBe(false);
    expect(validateEnvelope({ ...base, payload: null }).ok).toBe(false);
    expect(validateEnvelope({ ...base, payload: [1] }).ok).toBe(false);
  });

  it('多错误累积：v 错 + seq 错同时报多条', () => {
    const bad = { ...seatEnv(), v: 2, seq: -1 };
    const res = validateEnvelope(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('消息类型常量集合', () => {
  it('上行 = hello / seat.event / pong', () => {
    expect(UPLINK_MESSAGE_TYPES).toEqual(['hello', 'seat.event', 'pong']);
  });

  it('下行 = seat.assign / seat.inject / seat.permission_verdict / seat.cancel / seat.revoke / ping / hello_ack（阶段 5 新增）', () => {
    expect(DOWNLINK_MESSAGE_TYPES).toEqual([
      'seat.assign',
      'seat.inject',
      'seat.permission_verdict',
      'seat.cancel',
      'seat.revoke',
      'ping',
      'hello_ack',
    ]);
  });

  it('无座位归属 = hello / ping / pong / error / hello_ack（§4：不带 seatId，seq=0）', () => {
    expect(SEATLESS_MESSAGE_TYPES).toEqual(['hello', 'ping', 'pong', 'error', 'hello_ack']);
  });

  it('全集 = 上行 ∪ 下行 ∪ error', () => {
    expect(MESSAGE_TYPES).toEqual([...UPLINK_MESSAGE_TYPES, ...DOWNLINK_MESSAGE_TYPES, 'error']);
  });
});
