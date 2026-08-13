/**
 * StateStore 测试：读写往返 / 损坏恢复 / 原子写 / 队列 cap / removeSeat
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from './state-store';
import { NoopLogger } from './logger';

function makeStore(dir?: string): { dir: string; store: StateStore } {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-spec-'));
  const store = new StateStore({ dir: d, logger: new NoopLogger() });
  store.load();
  return { dir: d, store };
}

/** 列出目录内文件 */
function listFiles(dir: string): string[] {
  return fs.readdirSync(dir);
}

describe('StateStore 读写往返', () => {
  it('会话映射 / 游标 / 未确认队列：写后新实例 load 一致（跨进程重启等价）', () => {
    const { dir, store } = makeStore();
    store.setSessionId('seat-a', 'sess-abc');
    store.setLastReceivedSeq('seat-a', 7);
    const seq1 = store.persistSentEvent('seat-a', {
      type: 'message_chunk',
      seatId: 'seat-a',
      text: 'hi',
    });
    const seq2 = store.persistSentEvent('seat-a', {
      type: 'message_complete',
      seatId: 'seat-a',
      stopReason: 'end_turn',
    });
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);

    // 新实例（模拟重启）load 后数据一致
    const reopened = new StateStore({ dir, logger: new NoopLogger() });
    reopened.load();
    expect(reopened.getSessionId('seat-a')).toBe('sess-abc');
    expect(reopened.getLastReceivedSeq('seat-a')).toBe(7);
    expect(reopened.getLastSentSeq('seat-a')).toBe(2);
    const pending = reopened.getPendingEvents('seat-a');
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ seq: 1 });
    expect(pending[0].event).toMatchObject({ type: 'message_chunk', text: 'hi' });
    expect(pending[1].seq).toBe(2);
  });

  it('persistSentEvent 先落盘再发送语义：seq 从 0 递增，lastSentSeq 同步', () => {
    const { store } = makeStore();
    expect(store.getLastSentSeq('seat-new')).toBe(0);
    const seq = store.persistSentEvent('seat-new', { type: 'status', seatId: 'seat-new', status: 'online' });
    expect(seq).toBe(1);
    expect(store.getLastSentSeq('seat-new')).toBe(1);
    expect(store.getPendingEvents('seat-new')).toHaveLength(1);
  });

  it('clearPendingEvents 清空队列但保留游标', () => {
    const { store } = makeStore();
    store.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'busy' });
    store.setLastReceivedSeq('seat-a', 3);
    store.clearPendingEvents('seat-a');
    expect(store.getPendingEvents('seat-a')).toHaveLength(0);
    expect(store.getLastSentSeq('seat-a')).toBe(1);
    expect(store.getLastReceivedSeq('seat-a')).toBe(3);
  });

  it('removeSeat 删除全部座位状态（seat.revoke 语义）', () => {
    const { dir, store } = makeStore();
    store.setSessionId('seat-a', 'sess-1');
    store.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'online' });
    store.removeSeat('seat-a');
    expect(store.getSeatIds()).toEqual([]);
    expect(store.getSessionId('seat-a')).toBeUndefined();
    const reopened = new StateStore({ dir, logger: new NoopLogger() });
    reopened.load();
    expect(reopened.getSeatIds()).toEqual([]);
  });

  it('未确认队列超 cap（500）丢最旧（防御性裁剪）', () => {
    const { store } = makeStore();
    for (let i = 0; i < 510; i += 1) {
      store.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'busy' });
    }
    const pending = store.getPendingEvents('seat-a');
    expect(pending).toHaveLength(500);
    expect(pending[0].seq).toBe(11); // 1..10 被丢
    expect(store.getLastSentSeq('seat-a')).toBe(510);
  });

  it('ackPendingEvents：按 chamber 游标裁剪已确认送达，留档 seq 不裁（RT-DEBT-2）', () => {
    const { dir, store } = makeStore();
    for (let i = 0; i < 5; i += 1) {
      store.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'busy' }); // seq 1..5
    }
    // 游标 = 4 且 seq 3 落库失败留档：保留 3（待重放）与 5（未确认）
    store.ackPendingEvents('seat-a', 4, [3]);
    expect(store.getPendingEvents('seat-a').map((e) => e.seq)).toEqual([3, 5]);
    expect(store.getLastSentSeq('seat-a')).toBe(5); // 游标不受裁剪影响
    // 新实例 load 后裁剪结果持久化（跨进程重启等价）
    const reopened = new StateStore({ dir, logger: new NoopLogger() });
    reopened.load();
    expect(reopened.getPendingEvents('seat-a').map((e) => e.seq)).toEqual([3, 5]);
  });

  it('ackPendingEvents：游标未覆盖任何条目 → 不裁剪不落盘（无意义写防御）', () => {
    const { store } = makeStore();
    store.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'busy' }); // seq 1
    store.ackPendingEvents('seat-a', 0, []);
    expect(store.getPendingEvents('seat-a')).toHaveLength(1); // 1 > 0 未确认，保留
    store.ackPendingEvents('seat-a', 5, []); // 无条目可裁（1 ≤ 5 但已被上轮保留判定？——本轮直接裁）
    expect(store.getPendingEvents('seat-a')).toHaveLength(0);
  });

  it('ackPendingEvents：chamber 游标领先 lastSentSeq → 快进对齐（防新事件被幂等去重静默丢弃）', () => {
    const { dir, store } = makeStore();
    store.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'busy' }); // seq 1
    // 模拟多进程共享 state.json 互相覆盖回滚 / 旧副本恢复：chamber 已确认到 350，
    // 本地计数器只有 1——不快进则 seq 2..350 全部被 chamber 幂等去重（座位假死）
    store.ackPendingEvents('seat-a', 350, []);
    expect(store.getLastSentSeq('seat-a')).toBe(350); // 计数器快进到游标
    // 快进后新事件 seq = 351 > 游标，chamber 正常处理
    const seq = store.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'online' });
    expect(seq).toBe(351);
    // 快进持久化（跨进程重启等价）
    const reopened = new StateStore({ dir, logger: new NoopLogger() });
    reopened.load();
    expect(reopened.getLastSentSeq('seat-a')).toBe(351);
    // 游标不领先时不动计数器（无回退）
    store.ackPendingEvents('seat-a', 100, []);
    expect(store.getLastSentSeq('seat-a')).toBe(351);
  });
});

describe('StateStore 损坏恢复（不 crash）', () => {
  it('JSON 解析失败 → 备份坏文件（.corrupt-*）+ 从空状态恢复', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-corrupt-'));
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, '{ not valid json !!!');
    const store = new StateStore({ dir, logger: new NoopLogger() });
    store.load();
    expect(store.getSeatIds()).toEqual([]);
    // 坏文件已备份，目录里只剩备份（无原文件）
    const files = listFiles(dir);
    expect(files.some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
    expect(files).not.toContain('state.json');
    // 恢复后可正常写入
    store.setSessionId('seat-a', 'sess-1');
    const reopened = new StateStore({ dir, logger: new NoopLogger() });
    reopened.load();
    expect(reopened.getSessionId('seat-a')).toBe('sess-1');
  });

  it('结构非法（版本不符 / seats 缺失）→ 同样走备份恢复', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-shape-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 99, seats: {} }));
    const store = new StateStore({ dir, logger: new NoopLogger() });
    store.load();
    expect(store.getSeatIds()).toEqual([]);
    expect(listFiles(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('字段缺失的旧条目规范化（缺 lastSentSeq/pendingEvents 补默认，不 undefined）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-normalize-'));
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ version: 1, seats: { 'seat-a': { sessionId: 'sess-1' } } }),
    );
    const store = new StateStore({ dir, logger: new NoopLogger() });
    store.load();
    expect(store.getSessionId('seat-a')).toBe('sess-1');
    expect(store.getLastSentSeq('seat-a')).toBe(0);
    expect(store.getLastReceivedSeq('seat-a')).toBe(0);
    expect(store.getPendingEvents('seat-a')).toEqual([]);
  });

  it('首次运行（无文件）→ 空状态不报错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-first-'));
    const store = new StateStore({ dir, logger: new NoopLogger() });
    store.load();
    expect(store.getSeatIds()).toEqual([]);
  });
});

describe('StateStore 原子写', () => {
  it('每次变更后 state.json 完整、无 .tmp 残留', () => {
    const { dir, store } = makeStore();
    store.setSessionId('seat-a', 'sess-1');
    store.persistSentEvent('seat-a', { type: 'status', seatId: 'seat-a', status: 'online' });
    const files = listFiles(dir);
    expect(files).toContain('state.json');
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.seats['seat-a'].sessionId).toBe('sess-1');
  });

  it('flush 落盘（stop 收尾路径）', () => {
    const { dir, store } = makeStore();
    store.setSessionId('seat-a', 'sess-1');
    store.flush();
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(true);
  });
});
