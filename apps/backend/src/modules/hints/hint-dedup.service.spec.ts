/**
 * hint 去重窗口单测（2 期抽核到 modules/hints）
 *
 * 覆盖：key 形态（actor+code+resource）、TTL 过期、容量淘汰（插前删最旧）、reset、
 * **per-code TTL 覆盖**（阶段二 24h code 的接入面）、normalized 态由调用方跳过
 * （本服务不感知 status——契约在 hint-core.finalizeHints）。
 */
import { HintDedupService, HINT_DEDUP_MAX_ENTRIES, HINT_DEDUP_TTL_MS } from './hint-dedup.service';

describe('HintDedupService', () => {
  let service: HintDedupService;

  beforeEach(() => {
    service = new HintDedupService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('未标记 → 不压制；标记后同键压制', () => {
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-1')).toBe(false);
    service.mark('a1', 'empty_tags', 'doc-1');
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-1')).toBe(true);
  });

  it('key = actor:code:resource 三段全参与（任一不同即不压制）', () => {
    service.mark('a1', 'empty_tags', 'doc-1');
    expect(service.isSuppressed('a2', 'empty_tags', 'doc-1')).toBe(false);
    expect(service.isSuppressed('a1', 'empty_summary', 'doc-1')).toBe(false);
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-2')).toBe(false);
  });

  it('TTL 到期后自动失效（读时惰性回收）', () => {
    jest.useFakeTimers();
    service.mark('a1', 'empty_tags', 'doc-1');
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-1')).toBe(true);

    jest.advanceTimersByTime(HINT_DEDUP_TTL_MS - 1);
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-1')).toBe(true);

    jest.advanceTimersByTime(2);
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-1')).toBe(false);
    // 过期条目已被惰性删除（不占容量）
    expect(service.size).toBe(0);
  });

  it('容量上限：满则插前删最旧（Map 迭代序 = 插入序）', () => {
    for (let i = 0; i < HINT_DEDUP_MAX_ENTRIES; i++) {
      service.mark('a1', 'empty_tags', `doc-${i}`);
    }
    expect(service.size).toBe(HINT_DEDUP_MAX_ENTRIES);

    // 第 10_001 条：最旧的 doc-0 被淘汰
    service.mark('a1', 'empty_tags', 'doc-new');
    expect(service.size).toBe(HINT_DEDUP_MAX_ENTRIES);
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-0')).toBe(false);
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-new')).toBe(true);
    // 次旧的 doc-1 仍在窗口内
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-1')).toBe(true);
  });

  it('重复标记同键不增长容量（幂等标记）', () => {
    service.mark('a1', 'empty_tags', 'doc-1');
    service.mark('a1', 'empty_tags', 'doc-1');
    expect(service.size).toBe(1);
  });

  it('reset 清空全部窗口记录（测试隔离用）', () => {
    service.mark('a1', 'empty_tags', 'doc-1');
    service.reset();
    expect(service.size).toBe(0);
    expect(service.isSuppressed('a1', 'empty_tags', 'doc-1')).toBe(false);
  });

  // ─── per-code TTL 覆盖（阶段一新增；阶段二的 24h code 靠它接入）────────────

  it('per-code TTL：mark 传 ttlMs → 按该窗口压制（缺省仍是 6h）', () => {
    jest.useFakeTimers();
    const day = 24 * 60 * 60 * 1000;

    service.mark('a1', 'fx_daily_code', 'space-1', day);
    jest.advanceTimersByTime(HINT_DEDUP_TTL_MS + 1);
    // 6h 缺省窗口下早已过期，但本码声明了 24h → 仍在窗口内
    expect(service.isSuppressed('a1', 'fx_daily_code', 'space-1', day)).toBe(true);

    jest.advanceTimersByTime(day);
    expect(service.isSuppressed('a1', 'fx_daily_code', 'space-1', day)).toBe(false);
  });

  it('ttlMs 语义：缩短立即生效、放宽不追溯（生效窗口 = min(标记窗口, 本次声明窗口)）', () => {
    jest.useFakeTimers();
    const day = 24 * 60 * 60 * 1000;

    // ① 缩短：标记用 24h，判定用缺省 6h → 6h 后即失效（不等 24h）
    service.mark('a1', 'c1', 'r1', day);
    jest.advanceTimersByTime(HINT_DEDUP_TTL_MS + 1);
    expect(service.isSuppressed('a1', 'c1', 'r1')).toBe(false);

    // ② 放宽不追溯：标记用缺省 6h，判定用 24h → 旧窗口仍按 6h 计（1h 内压制、
    //    6h 后失效），不因「本次声明 24h」被追溯延长
    service.mark('a1', 'c2', 'r2');
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(service.isSuppressed('a1', 'c2', 'r2', day)).toBe(true);
    jest.advanceTimersByTime(HINT_DEDUP_TTL_MS);
    expect(service.isSuppressed('a1', 'c2', 'r2', day)).toBe(false);
  });
});
