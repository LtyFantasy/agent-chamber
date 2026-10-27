/**
 * hint 通用内核单测（阶段一抽核）
 *
 * 覆盖：排序（**注入**的优先级序，与传入顺序无关）/ ≤3 截尾 / 去重过滤先于截尾 /
 * normalized 态穿透去重 / 文案由 resolveMessage 解析 + candidate.message 覆盖 /
 * 空候选 → undefined / 输入数组不被就地改写 / makeHintCandidate 的空 data 与空 message 不落键。
 *
 * 用**假 code 词表**（a/b/c/d）而非 docspace code：内核不认识任何领域 code，
 * 用领域词表测反而会掩盖「内核泄漏领域知识」的回归。
 */
import {
  finalizeHints,
  HINT_MAX_PER_RESPONSE,
  makeHintCandidate,
  type FinalizeHintsSpec,
} from './hint-core';

describe('hint-core.finalizeHints', () => {
  type FakeCode = 'a' | 'b' | 'c' | 'd';
  const PRIORITY: readonly FakeCode[] = ['a', 'b', 'c', 'd'];

  /** 默认 spec（无压制、无回调、注入优先级与文案解析） */
  const spec = (over: Partial<FinalizeHintsSpec<FakeCode>> = {}): FinalizeHintsSpec<FakeCode> => ({
    priority: PRIORITY,
    isSuppressed: () => false,
    onEmit: () => {},
    resolveMessage: (candidate) => candidate.message ?? `msg:${candidate.code}`,
    ...over,
  });

  it('空候选 → undefined（信封不变量：禁空数组）', () => {
    expect(finalizeHints([], spec())).toBeUndefined();
  });

  it('按**注入**的优先级序排序（与传入顺序无关）', () => {
    const out = finalizeHints(
      [
        makeHintCandidate<FakeCode>('d', 'suggestion', 'k1'),
        makeHintCandidate<FakeCode>('a', 'check_failed', 'k2'),
        makeHintCandidate<FakeCode>('c', 'suggestion', 'k3'),
      ],
      spec(),
    );
    expect(out!.map((h) => h.code)).toEqual(['a', 'c', 'd']);
  });

  it('未列入优先级序的 code 排在已列之后，且彼此保持传入序（稳定排序）', () => {
    const stray = 'zz' as FakeCode;
    const out = finalizeHints(
      [
        makeHintCandidate<FakeCode>(stray, 'suggestion', 'stray-1', { i: 1 }),
        makeHintCandidate<FakeCode>('b', 'suggestion', 'k2', { i: 0 }),
        makeHintCandidate<FakeCode>(stray, 'suggestion', 'stray-2', { i: 2 }),
      ],
      spec(),
    );
    // 已列 code（b）先占位；两条未列 code 排后且保持传入序（data.i 是它们的身份标记）
    expect(out!.map((h) => h.data?.i)).toEqual([0, 1, 2]);
    expect(out!.map((h) => h.code)).toEqual(['b', stray, stray]);
  });

  it('未注入优先级序（priority 缺省）→ 保持候选传入序', () => {
    const out = finalizeHints(
      [
        makeHintCandidate<FakeCode>('d', 'suggestion', 'k1'),
        makeHintCandidate<FakeCode>('a', 'suggestion', 'k2'),
      ],
      spec({ priority: undefined }),
    );
    expect(out!.map((h) => h.code)).toEqual(['d', 'a']);
  });

  it(`≤${HINT_MAX_PER_RESPONSE} 截尾：第 ${HINT_MAX_PER_RESPONSE + 1} 条起被丢弃（保留高优先级）`, () => {
    const out = finalizeHints(
      [
        makeHintCandidate<FakeCode>('d', 'suggestion', 'k1'),
        makeHintCandidate<FakeCode>('c', 'suggestion', 'k2'),
        makeHintCandidate<FakeCode>('b', 'suggestion', 'k3'),
        makeHintCandidate<FakeCode>('a', 'suggestion', 'k4'),
      ],
      spec(),
    );
    expect(out!.length).toBe(HINT_MAX_PER_RESPONSE);
    expect(out!.map((h) => h.code)).toEqual(['a', 'b', 'c']);
  });

  it('去重过滤发生在截尾之前：被压制的候选不占名额', () => {
    const suppressed = new Set(['k1']);
    const emitted: string[] = [];
    const out = finalizeHints(
      [
        makeHintCandidate<FakeCode>('d', 'suggestion', 'k1'),
        makeHintCandidate<FakeCode>('c', 'suggestion', 'k2'),
        makeHintCandidate<FakeCode>('b', 'suggestion', 'k3'),
        makeHintCandidate<FakeCode>('a', 'suggestion', 'k4'),
      ],
      spec({
        isSuppressed: (c) => suppressed.has(c.resourceKey),
        onEmit: (c) => emitted.push(c.resourceKey),
      }),
    );
    expect(out!.map((h) => h.code)).toEqual(['a', 'b', 'c']);
    // 只有存活项被标记（未送达的 k1 不占窗口）
    expect(emitted.sort()).toEqual(['k2', 'k3', 'k4']);
  });

  it('normalized 态不参与去重（每次请求的事实回显）且仍落 onEmit', () => {
    const emitted: string[] = [];
    const out = finalizeHints(
      [makeHintCandidate<FakeCode>('a', 'normalized', 'k1')],
      spec({
        isSuppressed: () => true, // 窗口说「压制」，但 normalized 必须穿透
        onEmit: (c) => emitted.push(c.resourceKey),
      }),
    );
    expect(out!.map((h) => h.status)).toEqual(['normalized']);
    expect(emitted).toEqual(['k1']);
  });

  it('message 由 resolveMessage 解析；candidate.message 覆盖优先；空 data 不落键', () => {
    const out = finalizeHints(
      [
        makeHintCandidate<FakeCode>('a', 'suggestion', 'k1'),
        makeHintCandidate<FakeCode>(
          'b',
          'check_skipped',
          'k2',
          undefined,
          '专用文案（未检查 ≠ 健康）',
        ),
      ],
      spec(),
    );
    expect(out![0].message).toBe('msg:a');
    expect(out![0]).not.toHaveProperty('data');
    expect(out![1].message).toBe('专用文案（未检查 ≠ 健康）');
  });

  it('data 原样进信封条目（消费方读 data 而不是解析 message）', () => {
    const out = finalizeHints(
      [makeHintCandidate<FakeCode>('a', 'suggestion', 'k1', { path: 'docs/x.md' })],
      spec(),
    );
    expect(out![0].data).toEqual({ path: 'docs/x.md' });
  });

  it('输入数组**不被就地改写**（纯函数契约：内部先复制再排序）', () => {
    const input = [
      makeHintCandidate<FakeCode>('d', 'suggestion', 'k1'),
      makeHintCandidate<FakeCode>('a', 'suggestion', 'k2'),
    ];
    finalizeHints(input, spec());
    expect(input.map((c) => c.code)).toEqual(['d', 'a']);
  });

  it('isSuppressed 对 normalized 态**不被调用**（避免白付窗口查询）', () => {
    const spy = jest.fn(() => false);
    finalizeHints(
      [makeHintCandidate<FakeCode>('a', 'normalized', 'k1')],
      spec({ isSuppressed: spy }),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  // ─── 阶段三：槽位预算（maxHints）+ onSlotTruncated ─────────────────────

  describe('槽位预算（决策 5）', () => {
    it('maxHints 缺省 = HINT_MAX_PER_RESPONSE（不传即阶段一行为）', () => {
      const many = Array.from({ length: 5 }, (_v, i) =>
        makeHintCandidate<FakeCode>('a', 'suggestion', `k-${i}`),
      );
      expect(finalizeHints(many, spec())).toHaveLength(HINT_MAX_PER_RESPONSE);
    });

    it('显式 maxHints 生效，且未获槽位者走 onSlotTruncated（**不是** isSuppressed）', () => {
      const slotTruncated = jest.fn();
      const out = finalizeHints(
        [
          makeHintCandidate<FakeCode>('a', 'suggestion', 'k1'),
          makeHintCandidate<FakeCode>('b', 'suggestion', 'k2'),
          makeHintCandidate<FakeCode>('c', 'suggestion', 'k3'),
        ],
        spec({ maxHints: 1, onSlotTruncated: slotTruncated }),
      );

      expect(out!.map((h) => h.code)).toEqual(['a']);
      // 预算判定排在 isSuppressed 之前 ⇒ 未获槽位者**没有**被窗口判定（两档语义不混）
      expect(slotTruncated).toHaveBeenCalledTimes(2);
      expect(slotTruncated).toHaveBeenCalledWith(expect.objectContaining({ code: 'b' }));
      expect(slotTruncated).toHaveBeenCalledWith(expect.objectContaining({ code: 'c' }));
    });

    it('maxHints = 0：全部落 onSlotTruncated，返回 undefined（**仍完成遍历**）', () => {
      const slotTruncated = jest.fn();
      const out = finalizeHints(
        [makeHintCandidate<FakeCode>('a', 'suggestion', 'k1')],
        spec({ maxHints: 0, onSlotTruncated: slotTruncated }),
      );
      expect(out).toBeUndefined();
      expect(slotTruncated).toHaveBeenCalledTimes(1);
    });

    it('**同响应同键只取首条**（code + resourceKey 去重；P2-2）', () => {
      const slotTruncated = jest.fn();
      const out = finalizeHints(
        [
          makeHintCandidate<FakeCode>('a', 'suggestion', 'k1', { n: 1 }),
          makeHintCandidate<FakeCode>('a', 'suggestion', 'k1', { n: 2 }),
          makeHintCandidate<FakeCode>('a', 'suggestion', 'k1', { n: 3 }),
        ],
        spec(),
      );

      // 内核不认识「同一件事」的语义，但认得 (code, resourceKey) 这个窗口键
      expect(out).toHaveLength(1);
      expect(out![0].data).toEqual({ n: 1 });

      // 同 code **不同** resourceKey 不折叠
      const distinct = finalizeHints(
        [
          makeHintCandidate<FakeCode>('a', 'suggestion', 'k1'),
          makeHintCandidate<FakeCode>('a', 'suggestion', 'k2'),
        ],
        spec(),
      );
      expect(distinct).toHaveLength(2);

      // 预算满后重复键不再落 slot_truncated 埋点（首条已表达该键，重复键不构成第二件事实）
      finalizeHints(
        [
          makeHintCandidate<FakeCode>('a', 'suggestion', 'k1'),
          makeHintCandidate<FakeCode>('b', 'suggestion', 'k1'),
          makeHintCandidate<FakeCode>('a', 'suggestion', 'k1'),
        ],
        spec({ maxHints: 1, onSlotTruncated: slotTruncated }),
      );
      expect(slotTruncated).toHaveBeenCalledTimes(1);
    });

    it('不传 onSlotTruncated（直接调 finalizeHints 的调用方，当前仅单测）⇒ 未获槽位静默，与阶段一逐字等价', () => {
      const isSuppressed = jest.fn(() => false);
      const out = finalizeHints(
        [
          makeHintCandidate<FakeCode>('a', 'suggestion', 'k1'),
          makeHintCandidate<FakeCode>('b', 'suggestion', 'k2'),
        ],
        spec({ maxHints: 1, isSuppressed }),
      );
      expect(out!.map((h) => h.code)).toEqual(['a']);
      // 只对获槽位的第 1 条做过窗口判定（第 2 条既没判定也没回调）
      expect(isSuppressed).toHaveBeenCalledTimes(1);
    });
  });
});

describe('hint-core.makeHintCandidate', () => {
  it('常规构造：code/status/resourceKey 原样，可选键缺省不出现', () => {
    const candidate = makeHintCandidate('a', 'suggestion', 'k');
    expect(candidate).toEqual({ code: 'a', status: 'suggestion', resourceKey: 'k' });
    expect(candidate).not.toHaveProperty('data');
    expect(candidate).not.toHaveProperty('message');
    expect(candidate).not.toHaveProperty('noDedup');
  });

  it('空 data 对象同样不落键（信封形状纪律）', () => {
    expect(makeHintCandidate('a', 'suggestion', 'k', {})).not.toHaveProperty('data');
  });

  it('带 data / message 时原样保留（noDedup 由领域侧另行赋值）', () => {
    const candidate = makeHintCandidate('a', 'normalized', 'k', { n: 1 }, 'm');
    expect(candidate).toEqual({
      code: 'a',
      status: 'normalized',
      resourceKey: 'k',
      data: { n: 1 },
      message: 'm',
    });
  });
});
