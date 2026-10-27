/**
 * `InstrumentedMemoryEngine` 单测（卡 26c43f52）：观测层的**透明性**契约。
 *
 * 三件事必须钉死（任何一条破了都是静默事故）：
 * ① **零改写**：入参、返回引用、异常面全部原样透传（装饰器不能改变业务语义）；
 * ② **逐动词上报**：十一个业务动词各调一次 `noteCallOutcome`，且**只传 workspaceId**
 *    （凭据引用绝不外传）；
 * ③ **`healthCheck` 不上报**：探针结果有独立的 probe 路（防双计，见文件头不变量）。
 *
 * 失败分类（503→A / 401→B / 409→不计 / invalid_response→A）**不在本层**——那是 tracker 的
 * 职责（`engine-health-tracker.service.spec.ts` 逐行覆盖）。本层只保证"结果原封不动地送到
 * tracker 手里"，故这里断言的是"传过去的对象就是引擎返回的那个对象"。
 */
import type {
  MemoryEngine,
  MemoryEngineFailure,
  MemoryEngineResult,
  MemoryEngineTarget,
} from './memory-engine.interface';
import { InstrumentedMemoryEngine } from './instrumented-memory.engine';
import type { EngineHealthTracker } from '../engine-health-tracker.service';

/** 调用目标（**含 credentialRef**：本测试专门验证它不会被上报出去） */
const TARGET: MemoryEngineTarget = {
  workspaceId: 'ws-1',
  actorId: 'chamber-service-actor',
  credentialRef: 'ref-secret-should-never-leak',
};

/** 上报器的假实现（只关心入参形状） */
interface FakeTracker {
  noteCallOutcome: jest.Mock;
}

/** 假引擎：每个动词都返回同一个哨兵对象（便于断言"引用级透传"） */
function engineOf(overrides: Partial<MemoryEngine> = {}): MemoryEngine {
  const ok = { ok: true, value: { marker: 'sentinel' } } as unknown as MemoryEngineResult<never>;
  const same = jest.fn().mockResolvedValue(ok);
  return {
    name: 'fake',
    nominate: same,
    inspectNomination: same,
    recall: same,
    correct: same,
    inspectCorrection: same,
    readMemory: same,
    getGraphView: same,
    getMemoryView: same,
    getMemoryViewHistory: same,
    getMemoryViewRepresentation: same,
    getMemoryRelations: same,
    healthCheck: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
    ...overrides,
  } as unknown as MemoryEngine;
}

describe('InstrumentedMemoryEngine', () => {
  let tracker: FakeTracker;

  beforeEach(() => {
    tracker = { noteCallOutcome: jest.fn() };
  });

  function wrap(engine: MemoryEngine): InstrumentedMemoryEngine {
    return new InstrumentedMemoryEngine(engine, tracker as unknown as EngineHealthTracker);
  }

  it('`name` 透传（配置值域一致性靠它）', () => {
    expect(wrap(engineOf()).name).toBe('fake');
  });

  it('十一个业务动词：委托内层 + 上报一次（**只传 workspaceId**，凭据引用不外传）', async () => {
    const engine = engineOf();
    const wrapped = wrap(engine);

    const calls: Array<() => Promise<MemoryEngineResult<unknown>>> = [
      () => wrapped.nominate(TARGET, {} as never),
      () => wrapped.inspectNomination(TARGET, {} as never),
      () => wrapped.recall(TARGET, {} as never),
      () => wrapped.correct(TARGET, {} as never),
      () => wrapped.inspectCorrection(TARGET, {} as never),
      () => wrapped.readMemory(TARGET, 'mem-1'),
      () => wrapped.getGraphView(TARGET, {} as never),
      () => wrapped.getMemoryView(TARGET, 'mem-1', {} as never),
      () => wrapped.getMemoryViewHistory(TARGET, 'mem-1', 'R0', {} as never),
      () => wrapped.getMemoryViewRepresentation(TARGET, 'mem-1', 'rep-1'),
      () => wrapped.getMemoryRelations(TARGET, 'mem-1'),
    ];

    for (const call of calls) {
      const result = await call();
      // 引用级透传：调用方拿到的就是引擎返回的那个对象（零改写、零包装）
      expect((result as { value?: { marker?: string } }).value).toEqual({ marker: 'sentinel' });
    }

    expect(tracker.noteCallOutcome).toHaveBeenCalledTimes(calls.length);
    for (const call of tracker.noteCallOutcome.mock.calls) {
      const [result, context] = call as [MemoryEngineResult<unknown>, { workspaceId: string }];
      expect(result).toEqual({ ok: true, value: { marker: 'sentinel' } });
      // **精确形状**：只允许 workspaceId（多一个键 = 可能把凭据引用带进日志/文案）
      expect(context).toEqual({ workspaceId: 'ws-1' });
      expect(JSON.stringify(context)).not.toContain('ref-secret-should-never-leak');
    }
  });

  it('失败面原样上报（503 / 401 / 409 / invalid_response 一律不改写，分类归 tracker）', async () => {
    const failures: MemoryEngineFailure[] = [
      { kind: 'http', message: 'HTTP 503', httpStatus: 503, latencyMs: 1 },
      { kind: 'http', message: 'HTTP 401', httpStatus: 401, latencyMs: 1 },
      { kind: 'http', message: 'HTTP 409', httpStatus: 409, engineCode: 'conflict', latencyMs: 1 },
      { kind: 'invalid_response', message: 'broken body', latencyMs: 1 },
      { kind: 'timeout', message: 'timed out', latencyMs: 1 },
      { kind: 'unreachable', message: 'dial fail', latencyMs: 1 },
    ];

    for (const failure of failures) {
      const result = { ok: false, failure } as unknown as MemoryEngineResult<never>;
      const engine = engineOf({ recall: jest.fn().mockResolvedValue(result) });
      const trackerCall = tracker.noteCallOutcome as jest.Mock;
      trackerCall.mockClear();

      const returned = await wrap(engine).recall(TARGET, {} as never);
      // 同一个引用（不是构造出的等价对象）
      expect(returned).toBe(result);
      expect(trackerCall).toHaveBeenCalledWith(result, { workspaceId: 'ws-1' });
    }
  });

  it('`healthCheck`：委托内层 + 透传结果，**不上报**（探针有独立的路）', async () => {
    const engine = engineOf();
    const wrapped = wrap(engine);

    const result = await wrapped.healthCheck();

    expect(result).toEqual({ ok: true, value: undefined });
    expect(engine.healthCheck).toHaveBeenCalledTimes(1);
    expect(tracker.noteCallOutcome).not.toHaveBeenCalled();
  });

  it('内层抛错（违反 never-throw 的实现）不被本层吞掉——观测层不做错误掩码', async () => {
    const engine = engineOf({
      recall: jest.fn().mockRejectedValue(new Error('implementation bug')),
    });
    await expect(wrap(engine).recall(TARGET, {} as never)).rejects.toThrow('implementation bug');
    // 未拿到结果 ⇒ 不上报（不能把一个不存在的"失败结果"记进状态机）
    expect(tracker.noteCallOutcome).not.toHaveBeenCalled();
  });
});
