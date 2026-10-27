/**
 * `EngineHealthProbeService` 单测（卡 26c43f52）：**直调 `tick()`**。
 *
 * 为什么直调而不是等 cron：memory e2e 不注册 `ScheduleModule`（测试环境 cron 默认 disabled，
 * 见服务文件头），探针的编排逻辑只能在这里覆盖。四条断言对应服务 tick() 的三段与兜底：
 * ① 引擎未装配（token = null）⇒ **首行短路**（不探测、不求值——"未配置 ≠ 故障"）；
 * ② 探针开关开 ⇒ `healthCheck()` + `noteProbeOutcome(result)`；
 * ③ 探针开关关 ⇒ **不探测但仍求值**（关探针 ≠ 关告警）；
 * ④ 探测抛错（违反 never-throw 的实现）⇒ 只记日志、不冒泡。
 */
import { Logger } from '@nestjs/common';
import { EngineHealthProbeService } from './engine-health-probe.service';
import type { EngineHealthTracker } from './engine-health-tracker.service';
import { MEMORY_ENGINE_FALLBACK, type MemoryConfig } from '../../config/memory.config';
import type { MemoryEngine, MemoryEngineResult } from './engines/memory-engine.interface';

/** 探针结果哨兵（引用级透传断言用） */
const FAILED: MemoryEngineResult<void> = {
  ok: false,
  failure: { kind: 'http', message: 'HTTP 503', httpStatus: 503, latencyMs: 2 },
};

/** 假 tracker（只关心被调与入参） */
interface FakeTracker {
  noteProbeOutcome: jest.Mock;
  tick: jest.Mock;
}

/** 假引擎（只实现探针用到的 healthCheck + name） */
function engineOf(
  healthCheck: jest.Mock = jest.fn().mockResolvedValue(FAILED),
): MemoryEngine {
  return { name: 'hument', healthCheck } as unknown as MemoryEngine;
}

/** 配置基线（探针开） */
function configOf(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...MEMORY_ENGINE_FALLBACK, engine: 'hument', healthProbeEnabled: true, ...overrides };
}

describe('EngineHealthProbeService', () => {
  let tracker: FakeTracker;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    tracker = { noteProbeOutcome: jest.fn(), tick: jest.fn() };
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function probeOf(engine: MemoryEngine | null, config: MemoryConfig): EngineHealthProbeService {
    return new EngineHealthProbeService(
      engine,
      tracker as unknown as EngineHealthTracker,
      config,
    );
  }

  it('引擎未装配（token = null）⇒ 首行短路：不探测、不求值', async () => {
    const engine = engineOf();
    await probeOf(null, configOf()).tick();

    expect(engine.healthCheck).not.toHaveBeenCalled();
    expect(tracker.noteProbeOutcome).not.toHaveBeenCalled();
    // **连 tick 都不调**：未配置引擎时时间窗求值毫无意义（永远空计数）
    expect(tracker.tick).not.toHaveBeenCalled();
  });

  it('探针开关开 ⇒ healthCheck + 上报结果（引用级透传），随后求值', async () => {
    const engine = engineOf();
    await probeOf(engine, configOf()).tick();

    expect(engine.healthCheck).toHaveBeenCalledTimes(1);
    expect(tracker.noteProbeOutcome).toHaveBeenCalledWith(FAILED);
    expect(tracker.tick).toHaveBeenCalledTimes(1);
  });

  it('探针开关关 ⇒ **不探测但仍求值**（关探针 ≠ 关告警）', async () => {
    const engine = engineOf();
    await probeOf(engine, configOf({ healthProbeEnabled: false })).tick();

    expect(engine.healthCheck).not.toHaveBeenCalled();
    expect(tracker.noteProbeOutcome).not.toHaveBeenCalled();
    expect(tracker.tick).toHaveBeenCalledTimes(1);
  });

  it('探测抛错（违反 never-throw 的实现）⇒ 吞掉并记日志，不冒泡到调度器', async () => {
    const engine = engineOf(jest.fn().mockRejectedValue(new Error('implementation bug')));
    await expect(probeOf(engine, configOf()).tick()).resolves.toBeUndefined();

    expect(tracker.noteProbeOutcome).not.toHaveBeenCalled();
    // ⚠️ 抛错时**不执行**时间窗求值：本轮没有任何新证据，求值只会用旧计数误判
    expect(tracker.tick).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'health probe failed',
    );
  });
});
