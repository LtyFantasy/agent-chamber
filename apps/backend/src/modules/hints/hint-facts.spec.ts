/**
 * hint 事实袋（ALS）单测（阶段一）
 *
 * 覆盖：**并发隔离**（两个并发流程互不串袋）/ 无上下文 no-op / 取走即清（drain）与
 * 只读（peek）/ 显式句柄（拦截器在 map 回调里的取用形态）/ await 之后仍可见 /
 * 容量上限 / 空 payload 不落键 / 非法事实名被丢弃。
 */
import {
  createHintFactBag,
  drainFacts,
  emitFact,
  HINT_FACT_MAX_PER_CONTEXT,
  peekFacts,
  runWithHintFacts,
} from './hint-facts';

describe('hint-facts（ALS 事实袋）', () => {
  it('无上下文：emitFact no-op（不抛）+ drain/peek 返回空数组', () => {
    expect(emitFact('doc.created')).toBe(false);
    expect(drainFacts()).toEqual([]);
    expect(peekFacts()).toEqual([]);
  });

  it('建立上下文后：emitFact 落袋、drain 取走即清、peek 只读', () => {
    runWithHintFacts(() => {
      expect(emitFact('doc.created', { docId: 'd1' })).toBe(true);
      expect(peekFacts()).toHaveLength(1);
      expect(peekFacts()).toHaveLength(1); // peek 不清空
      expect(drainFacts()).toEqual([{ name: 'doc.created', payload: { docId: 'd1' } }]);
      expect(peekFacts()).toEqual([]); // drain 后为空
    });
  });

  it('空 payload 不落键（形状纪律：等价于没有补充信息）', () => {
    runWithHintFacts(() => {
      emitFact('doc.created', {});
      expect(drainFacts()).toEqual([{ name: 'doc.created' }]);
    });
  });

  it('载荷**浅拷贝**落袋：emit 之后改写原对象不影响袋内顶层值（防事实被回溯篡改）', () => {
    runWithHintFacts(() => {
      const tags: string[] = ['a'];
      const payload: Record<string, unknown> = { docId: 'd1', tags };
      emitFact('doc.created', payload);
      // 领域侧常把同一个对象继续交给别处用（或就地改字段）——落袋值必须已定型
      payload.docId = 'MUTATED';
      payload.extra = 'added';
      tags.push('b');

      const [fact] = drainFacts();
      expect(fact.payload).not.toBe(payload); // 顶层是新对象
      expect(fact.payload?.docId).toBe('d1');
      expect(fact.payload).not.toHaveProperty('extra');
      // 已知边界：嵌套结构仍是共享引用（`tags` 变成了 ['a','b']）——故 payload 约定**扁平对象**
      expect(fact.payload?.tags).toEqual(['a', 'b']);
    });
  });

  it('非法事实名（空串）被丢弃，不抛', () => {
    runWithHintFacts(() => {
      expect(emitFact('')).toBe(false);
      expect(peekFacts()).toEqual([]);
    });
  });

  it('await 之后仍可见（异步继续继承上下文）', async () => {
    const drained = await runWithHintFacts(async () => {
      emitFact('doc.created');
      await new Promise((resolve) => setTimeout(resolve, 1));
      emitFact('doc.moved');
      return drainFacts().map((fact) => fact.name);
    });
    expect(drained).toEqual(['doc.created', 'doc.moved']);
  });

  it('**并发隔离**：两个并发流程各持一袋，互不串袋（本模块的核心契约）', async () => {
    const flow = (name: string, delayMs: number): Promise<string[]> =>
      runWithHintFacts(async () => {
        emitFact(`${name}.1`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        emitFact(`${name}.2`);
        // 交错的 drain：若两袋共享，这里会看到对方的事实
        return drainFacts().map((fact) => fact.name);
      });

    const [a, b] = await Promise.all([flow('A', 10), flow('B', 1)]);
    expect(a).toEqual(['A.1', 'A.2']);
    expect(b).toEqual(['B.1', 'B.2']);
  });

  it('嵌套上下文：内层袋不污染外层（外层 drain 只拿自己的）', () => {
    runWithHintFacts(() => {
      emitFact('outer.1');
      runWithHintFacts(() => {
        emitFact('inner.1');
        expect(drainFacts().map((f) => f.name)).toEqual(['inner.1']);
      });
      expect(drainFacts().map((f) => f.name)).toEqual(['outer.1']);
    });
  });

  it('显式句柄：runWithHintFacts(fn, bag) 的袋可在上下文外取用（拦截器 map 回调形态）', () => {
    const bag = createHintFactBag();
    runWithHintFacts(() => emitFact('doc.created', { docId: 'd1' }), bag);
    // 上下文已退出——显式句柄仍可读到本请求的事实
    expect(drainFacts(bag).map((f) => f.name)).toEqual(['doc.created']);
    expect(bag.size).toBe(0);
  });

  it(`容量上限 ${HINT_FACT_MAX_PER_CONTEXT}：超限静默丢弃（fail-open，防 emit 失控）`, () => {
    runWithHintFacts(() => {
      for (let i = 0; i < HINT_FACT_MAX_PER_CONTEXT + 5; i++) emitFact('noisy', { i });
      expect(peekFacts()).toHaveLength(HINT_FACT_MAX_PER_CONTEXT);
      expect(emitFact('noisy', { i: 999 })).toBe(false);
    });
  });
});
