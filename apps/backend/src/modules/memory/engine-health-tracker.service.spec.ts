/**
 * `EngineHealthTracker` 单测（卡 26c43f52；卡 5e6cb000 改通道）：**逐行覆盖文件头的「事件转移表」**。
 *
 * 这张表是状态机的施工合同——本文件里的用例名与表行一一对应（改表必须同步改用例，
 * 反之亦然）。测试全部走公开 API（`noteCallOutcome` / `noteProbeOutcome` / `tick` /
 * `getHealthSnapshot` / `resetForTest`），不碰私有字段：状态机的正确性必须能从外部观测面证伪。
 *
 * 告警通道 = `NotifyOrchestrator.sendSystemAlert()`（Topic 通道已拆除，卡 5e6cb000）：
 * 断言面 = **调用次数 / 入参（title/body/arm/kind/workspaceId）/ outcome 簿记副作用**。
 *
 * 时间控制：`jest.useFakeTimers()` + `jest.setSystemTime()`。tracker 的所有时刻都取自
 * `Date.now()`（可被 fake timers 接管），故 5 分钟窗口 / 60→240 分钟心跳都能精确构造。
 */
import { Logger } from '@nestjs/common';
import { MEMORY_ENGINE_FALLBACK, type MemoryConfig } from '../../config/memory.config';
import {
  EngineHealthTracker,
  MEMORY_CALL_FAILURE_THRESHOLD,
  MEMORY_HEARTBEAT_INTERVAL_MS,
  MEMORY_HEARTBEAT_SLOW_INTERVAL_MS,
  MEMORY_PROBE_FAILURE_THRESHOLD,
  MEMORY_PROBE_OK_STREAK_TO_RECOVER,
  MEMORY_TIME_WINDOW_MS,
  sanitizeAlertField,
} from './engine-health-tracker.service';
import type { MemoryEngineFailure, MemoryEngineResult } from './engines/memory-engine.interface';
import type { NotifyOrchestrator } from '../notifications/notify-orchestrator.service';

/** 起点时刻（确定性；所有断言的时间都由它派生） */
const T0 = Date.parse('2026-10-23T00:00:00.000Z');

/** 测试目标 workspace（非机密；上报面只允许这个字段外传） */
const WORKSPACE = 'ws-alert-test';

/** 引擎失败面构造器 */
function failureOf(overrides: Partial<MemoryEngineFailure> = {}): MemoryEngineFailure {
  return { kind: 'http', message: 'engine failure', latencyMs: 3, ...overrides };
}

/** 一次成功的业务调用结果 */
const OK: MemoryEngineResult<unknown> = { ok: true, value: undefined };

/** 一次 503（可用性故障） */
function fail503(): MemoryEngineResult<unknown> {
  return { ok: false, failure: failureOf({ httpStatus: 503, retryable: true }) };
}

/** 一次 401（认证故障） */
function fail401(): MemoryEngineResult<unknown> {
  return { ok: false, failure: failureOf({ httpStatus: 401, engineCode: 'unauthorized' }) };
}

/** 一次 403 + `binding_not_found`（hument 对"绑定不存在"回 403，没有 404 臂） */
function fail403Binding(): MemoryEngineResult<unknown> {
  return {
    ok: false,
    failure: failureOf({ httpStatus: 403, engineCode: 'binding_not_found' }),
  };
}

/** 一次超时（可用性故障） */
function failTimeout(): MemoryEngineResult<unknown> {
  return { ok: false, failure: failureOf({ kind: 'timeout' }) };
}

/** usage 的 2xx 但 target 回声不符（身份/授权面，不是可用性） */
function failUsageTargetMismatch(): MemoryEngineResult<unknown> {
  return {
    ok: false,
    failure: failureOf({
      kind: 'invalid_response',
      usageRejection: 'target_mismatch',
    }),
  };
}

/** usage 的 2xx 但 schema 不符（合同/版本问题 ⇒ 仍是可用性臂） */
function failUsageSchemaMismatch(): MemoryEngineResult<unknown> {
  return {
    ok: false,
    failure: failureOf({
      kind: 'invalid_response',
      usageRejection: 'schema_mismatch',
    }),
  };
}

/** usage 的 cursor 自洽破损（合同/版本问题 ⇒ 仍是可用性臂） */
function failUsageCursorInvalid(): MemoryEngineResult<unknown> {
  return {
    ok: false,
    failure: failureOf({
      kind: 'invalid_response',
      usageRejection: 'cursor_invalid',
    }),
  };
}

/** 一次 409（业务冲突：引擎应答 + 凭据通过 ⇒ 双路清零、不告警） */
function fail409(): MemoryEngineResult<unknown> {
  return {
    ok: false,
    failure: failureOf({ httpStatus: 409, engineCode: 'conflict', retryable: false }),
  };
}

/** 系统告警端口的替身（只实现 tracker 用到的 `sendSystemAlert`） */
interface FakeNotify {
  sendSystemAlert: jest.Mock;
}

describe('EngineHealthTracker', () => {
  let now: number;
  let notify: FakeNotify;
  let config: MemoryConfig;
  let tracker: EngineHealthTracker;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  /** 配置基线（探针**开**） */
  function configOf(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
    return {
      ...MEMORY_ENGINE_FALLBACK,
      engine: 'hument',
      healthProbeEnabled: true,
      ...overrides,
    };
  }

  /** 把 pending 的微任务跑干净（派发是 fire-and-forget，断言前必须 flush） */
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);
  }

  /** 时间推进（fake timers **同时**推进 Date.now 与定时器队列） */
  async function advance(ms: number): Promise<void> {
    now += ms;
    await jest.advanceTimersByTimeAsync(ms);
    await flush();
  }

  /** 已派发的告警入参（按派发顺序） */
  function sentPayloads(): {
    source: string;
    kind: string;
    arm: string;
    title: string;
    body: string;
    occurredAt: string;
    consecutive?: number;
    workspaceId?: string;
  }[] {
    return notify.sendSystemAlert.mock.calls.map((call) => call[0]);
  }

  /** 已派发的正文全文（title + body；告警正文的断言面） */
  function sentContents(): string[] {
    return sentPayloads().map((payload) => `${payload.title}\n${payload.body}`);
  }

  /** 指定臂的告警派发入参（`kind='alert'`） */
  function alertPayloads(arm: 'availability' | 'auth' = 'availability') {
    return sentPayloads().filter((payload) => payload.kind === 'alert' && payload.arm === arm);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    now = T0;
    jest.setSystemTime(now);

    notify = {
      // 缺省 = 真出境（`alertDelivered` 会被写成 true）
      sendSystemAlert: jest.fn().mockResolvedValue('delivered'),
    };
    config = configOf();

    // 静音 Nest Logger（同时用于断言日志面）
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    tracker = new EngineHealthTracker(config, notify as unknown as NotifyOrchestrator);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────
  // callFailA / callFailB / callNonCounted / callOk
  // ──────────────────────────────────────────────────────────────────────

  it('`callFailA`：连续 5×503 ⇒ 告警 A（一次派发 + 闭集文案），不碰 B 臂', async () => {
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD - 1; i += 1) {
      tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
      await flush();
    }
    // 前 4 次不派发
    expect(notify.sendSystemAlert).not.toHaveBeenCalled();

    tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
    await flush();

    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
    const [payload] = sentPayloads();
    expect(payload.source).toBe('memory-engine');
    expect(payload.kind).toBe('alert');
    expect(payload.arm).toBe('availability');
    // title = 文案首行；body = 余下各行（多行保留 \n）
    expect(payload.title).toBe('[engine alert] arm=availability engine=hument');
    expect(payload.body.split('\n').length).toBeGreaterThan(1);
    expect(payload.body).toContain(`连续失败 ${MEMORY_CALL_FAILURE_THRESHOLD} 次`);
    expect(payload.body).toContain('kind=http httpStatus=503');
    expect(payload.body).toContain(`workspaceId=${WORKSPACE}`);
    expect(payload.consecutive).toBe(MEMORY_CALL_FAILURE_THRESHOLD);
    // 发生时刻是 ISO 字符串（对端只做日志与对账）
    expect(payload.occurredAt).toBe(new Date(T0).toISOString());
    // **文案闭集**：端点 / 引擎错误码 / 请求 id 一律不出现在告警正文里
    const content = sentContents()[0];
    expect(content).not.toContain('engineCode');
    expect(content).not.toContain('requestId');
    expect(content).not.toContain('127.0.0.1');

    // 日志面可以带端点（host+path）与 engineCode（排障用），但同样不含凭据
    const errorLines = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorLines).toContain('MEMORY_ENGINE_ALERT');
    expect(errorLines).toContain('endpoint=127.0.0.1:8099');
  });

  it('`callFailB`：5×401 只触发 B（A 臂被清零），403+binding_not_found 同属 B', async () => {
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(fail401(), { workspaceId: WORKSPACE });
      await flush();
    }
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
    const [payload] = alertPayloads('auth');
    expect(payload.body).toContain('httpStatus=401');

    // A 臂全程没有被计入（401 = 引擎活着）⇒ 时间窗求值不会补一条 A 告警
    await advance(MEMORY_TIME_WINDOW_MS + 1);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
  });

  it('403 + binding_not_found 计入 B 臂（hument 对该码回 403，无 404 臂）', async () => {
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(fail403Binding(), { workspaceId: WORKSPACE });
      await flush();
    }
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(alertPayloads('auth')[0].body).toContain('httpStatus=403');
  });

  it('usage target_mismatch（invalid_response）归 **B 臂**：5 次只告警 auth，不误报引擎不可用', async () => {
    for (let index = 0; index < MEMORY_CALL_FAILURE_THRESHOLD; index += 1) {
      tracker.noteCallOutcome(failUsageTargetMismatch(), { workspaceId: WORKSPACE });
    }
    await flush();

    const snapshot = tracker.getHealthSnapshot();
    expect(snapshot.availability.alerted).toBe(false);
    expect(snapshot.auth.alerted).toBe(true);
    const calls = alertPayloads('auth');
    expect(calls).toHaveLength(1);
    expect(alertPayloads('availability')).toHaveLength(0);
  });

  it('usage schema_mismatch / cursor_invalid 仍归 **A 臂**（既有归类不回归）', async () => {
    for (const makeFailure of [failUsageSchemaMismatch, failUsageCursorInvalid]) {
      tracker.resetForTest();
      notify.sendSystemAlert.mockClear();

      for (let index = 0; index < MEMORY_CALL_FAILURE_THRESHOLD; index += 1) {
        tracker.noteCallOutcome(makeFailure(), { workspaceId: WORKSPACE });
      }
      await flush();

      const snapshot = tracker.getHealthSnapshot();
      expect(snapshot.availability.alerted).toBe(true);
      expect(snapshot.auth.alerted).toBe(false);
      expect(alertPayloads('availability')).toHaveLength(1);
      expect(alertPayloads('auth')).toHaveLength(0);
    }
  });

  it('`503`/`401` 交替 5 次 ⇒ **两个臂都不触发**（互相清零是设计意图）', async () => {
    const alternating = [fail503, fail401, fail503, fail401, fail503];
    for (const next of alternating) {
      tracker.noteCallOutcome(next(), { workspaceId: WORKSPACE });
      await flush();
    }
    expect(notify.sendSystemAlert).not.toHaveBeenCalled();

    // ⚠️ 回退守卫（卡 2 评审 M3-1）：时间窗求值也不得补告警。
    // 若 `callFailB` 的「A 臂清零」被删掉，A 侧会是 3×503 累计 ⇒ 下面这一 tick 立刻红。
    await advance(MEMORY_TIME_WINDOW_MS + 1);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).not.toHaveBeenCalled();
  });

  it('`callNonCounted`：409 双路清零（引擎应答 + 凭据通过 ⇒ 不是故障）', async () => {
    // 4×503（差一次到阈值）→ 409 → 再 1×503：若 409 没清零，第 5 次 503 当场告警。
    // ⚠️ 刻意**不掺 401**（卡 2 评审 M3-3）：401 会顺手清掉 A 侧计数，掩盖 409 是否生效。
    for (let i = 0; i < 4; i += 1) tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
    tracker.noteCallOutcome(fail409(), { workspaceId: WORKSPACE });
    tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
    await flush();
    expect(notify.sendSystemAlert).not.toHaveBeenCalled();

    // 时间窗也不得补告警（清零后只有 1 次失败，远低于 3 次的时间窗判据）
    await advance(MEMORY_TIME_WINDOW_MS + 1);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).not.toHaveBeenCalled();
  });

  it('`callOk`：B 臂立即恢复（一次成功调用即可）；A 臂在探针启用时**不**由调用恢复', async () => {
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(fail401(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(2);
    const recovery = sentPayloads()[1];
    expect(recovery.kind).toBe('recovery');
    expect(recovery.arm).toBe('auth');
    expect(recovery.title).toContain('[engine recovered]');
    // 恢复通知统一带「本通知为恢复确认，无需处置。」（闭环语义，见 plan D2）
    expect(recovery.body).toContain('本通知为恢复确认，无需处置。');
    // 告警语义日志全部保留（可 grep；通道降级时它是唯一被动感知面）
    expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'MEMORY_ENGINE_ALERT RECOVERED',
    );
  });

  it('`callOk`：探针**禁用**时 A 臂由成功调用恢复（告警文案如实说明这一点）', async () => {
    config = configOf({ healthProbeEnabled: false });
    tracker = new EngineHealthTracker(config, notify as unknown as NotifyOrchestrator);

    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(failTimeout(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
    // 恢复判据随探针开关变：探针关着时不能写"等探针 2 连胜"（那是一条永远等不到的路）
    expect(sentContents()[0]).toContain('一次成功的业务调用就会发恢复通知');

    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(2);
    expect(sentPayloads()[1].arm).toBe('availability');
  });

  it('探针**启用**时 A 臂不因一次成功调用恢复（一次成功证明不了稳定）', async () => {
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(failTimeout(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // probeOk / probeFail / tick
  // ──────────────────────────────────────────────────────────────────────

  it('`probeFail`：连续 3 次探针失败 ⇒ 告警 A（探针路独立计数，**文案打探针数字**）', async () => {
    // 探针失败间隔 2 分钟（真实 cron 周期）⇒ 文案里的"持续 N 分钟"可判别
    tracker.noteProbeOutcome({ ok: false, failure: failureOf({ kind: 'unreachable' }) });
    await advance(2 * 60_000);
    tracker.noteProbeOutcome({ ok: false, failure: failureOf({ kind: 'unreachable' }) });
    await flush();
    expect(notify.sendSystemAlert).not.toHaveBeenCalled();

    await advance(2 * 60_000);
    tracker.noteProbeOutcome({ ok: false, failure: failureOf({ kind: 'unreachable' }) });
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
    const content = sentContents()[0];
    expect(sentPayloads()[0].arm).toBe('availability');

    // ⚠️ 回退守卫（卡 2 评审 M1）：零流量形态下业务计数恒为 0，文案必须打**探针**数字。
    // 若误用 state.cons/state.firstAt，这里会是「连续失败 0 次 / 持续 0 分钟」⇒ 当场红。
    expect(content).toContain(`就绪探测连续失败 ${MEMORY_PROBE_FAILURE_THRESHOLD} 次`);
    expect(content).toContain('已持续 4 分钟'); // 两次 2 分钟间隔
    expect(content).not.toContain('连续失败 0 次');
    expect(content).not.toContain('已持续 0 分钟');

    // 日志面同一份证据（consecutive / firstFailureAt 不取自业务计数）
    const logLines = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logLines).toContain(`consecutive=${MEMORY_PROBE_FAILURE_THRESHOLD}`);
    expect(logLines).toContain(`firstFailureAt=${new Date(T0).toISOString()}`);
  });

  it('`probeOk`：2 连胜恢复 A（不等业务流量），并连带清业务计数', async () => {
    // ⚠️ **告警前**先攒 4 次业务失败（卡 2 评审 M3-2）：恢复若不清 callCons，
    // 恢复后再来 1 次就会跨过 5 次阈值。
    for (let i = 0; i < 4; i += 1) {
      tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
    }
    for (let i = 0; i < MEMORY_PROBE_FAILURE_THRESHOLD; i += 1) {
      tracker.noteProbeOutcome({ ok: false, failure: failureOf({ kind: 'timeout' }) });
    }
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(sentContents()[0]).toContain('就绪探测连续失败');

    tracker.noteProbeOutcome({ ok: true, value: undefined });
    await flush();
    // 1 次成功不够（≥2 连胜才恢复）
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    tracker.noteProbeOutcome({ ok: true, value: undefined });
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(2);
    const recovery = sentPayloads()[1];
    expect(recovery.kind).toBe('recovery');
    expect(recovery.title).toContain('[engine recovered]');
    expect(recovery.body).toContain('就绪探测连续成功 2 次');

    // 恢复**连带清 callCons**：再补 1 次 503（若没清零 ⇒ 累计 5 次 ⇒ 当场告警）
    tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(2);

    // 时间窗也不得补告警（清零后仅 1 次失败 < 3 次判据）
    await advance(MEMORY_TIME_WINDOW_MS + 1);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(2);
  });

  // ── 告警置位清 okStreak（卡 2 评审 M2：假恢复）────────────────────────────
  it('M2：业务 5 连败告警后，**探针早已连胜**也不得被下一轮 probeOk 立即恢复', async () => {
    // 探针先健康很久（10 次成功 ⇒ streak=10）
    for (let i = 0; i < 10; i += 1) {
      tracker.noteProbeOutcome({ ok: true, value: undefined });
    }
    await flush();
    expect(notify.sendSystemAlert).not.toHaveBeenCalled();

    // 业务面 5 连败 ⇒ 告警 A（此时若不清 streak，下一轮探针会立刻"恢复"）
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    // 第一次 probeOk：streak 归 1 ⇒ **不得**恢复
    tracker.noteProbeOutcome({ ok: true, value: undefined });
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
  });

  it('M2：告警后连续 2 次 probeOk 才恢复（恢复证据必须产生于告警之后）', async () => {
    for (let i = 0; i < 10; i += 1) {
      tracker.noteProbeOutcome({ ok: true, value: undefined });
    }
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    tracker.noteProbeOutcome({ ok: true, value: undefined });
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    tracker.noteProbeOutcome({ ok: true, value: undefined });
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(2);
    expect(sentPayloads()[1].kind).toBe('recovery');
    expect(sentPayloads()[1].arm).toBe('availability');
  });

  it('`tick`：3 次失败后流量停止（burst-then-silence）⇒ 5 分钟后仍告警', async () => {
    // 3 次业务失败（未到 5 次阈值）后不再有任何调用
    for (let i = 0; i < 3; i += 1) {
      tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(notify.sendSystemAlert).not.toHaveBeenCalled();

    // 5 分钟之前：窗口未满，不告警
    await advance(MEMORY_TIME_WINDOW_MS - 1_000);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).not.toHaveBeenCalled();

    // 跨过 5 分钟：时间窗求值触发
    await advance(2_000);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(sentContents()[0]).toContain('时间窗判定触发');
  });

  // ──────────────────────────────────────────────────────────────────────
  // heartbeat（60/60/60/240 降频）
  // ──────────────────────────────────────────────────────────────────────

  it('`heartbeat`：60 分钟后按**分臂诚实态**播报（仍在失败 / 探针恢复但业务未确认）', async () => {
    // A 臂：探针 3 失败 ⇒ 告警
    for (let i = 0; i < MEMORY_PROBE_FAILURE_THRESHOLD; i += 1) {
      tracker.noteProbeOutcome({ ok: false, failure: failureOf({ kind: 'timeout' }) });
    }
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    // 59 分钟：不该有心跳
    await advance(MEMORY_HEARTBEAT_INTERVAL_MS - 60_000);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    // 61 分钟：一条心跳，且如实说明"仍在失败"
    await advance(2 * 60_000);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(2);
    const heartbeat = sentPayloads()[1];
    expect(heartbeat.kind).toBe('heartbeat');
    expect(`${heartbeat.title}\n${heartbeat.body}`).toContain('仍在失败（心跳）');
    expect(heartbeat.body).toContain('探针连续失败');

    // 探针恢复 1 次（未到 2 连胜 ⇒ 仍告警）⇒ 下一条心跳必须说"业务面未确认"
    tracker.noteProbeOutcome({ ok: true, value: undefined });
    await advance(MEMORY_HEARTBEAT_INTERVAL_MS);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(3);
    const honest = sentPayloads()[2];
    expect(`${honest.title}\n${honest.body}`).toContain('就绪探测已恢复');
    expect(honest.body).toContain('业务面未确认');
  });

  it('心跳降频：第 4 条起改为 240 分钟（60/60/60/240…）', async () => {
    // 告警 A（探针 3 失败）
    for (let i = 0; i < MEMORY_PROBE_FAILURE_THRESHOLD; i += 1) {
      tracker.noteProbeOutcome({ ok: false, failure: failureOf({ kind: 'timeout' }) });
    }
    await flush();
    // 第 1 条（告警本身）
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    // 前三个心跳间隔都是 60 分钟
    for (let i = 0; i < 3; i += 1) {
      await advance(MEMORY_HEARTBEAT_INTERVAL_MS);
      tracker.tick();
      await flush();
      expect(notify.sendSystemAlert).toHaveBeenCalledTimes(2 + i);
      expect(sentPayloads()[1 + i].kind).toBe('heartbeat');
    }

    // 第 4 条：239 分钟不触发（若仍是 60 分钟节律，这里会多出一条）
    await advance(MEMORY_HEARTBEAT_SLOW_INTERVAL_MS - 60_000);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(4);

    // 满 240 分钟：触发
    await advance(60_000);
    tracker.tick();
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(5);
  });

  it('稳态不重复告警：告警已出境后，时间窗/心跳窗口内不额外派发告警', async () => {
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);

    // 30 分钟内反复 tick（含 5 分钟时间窗与 60 分钟心跳的中间态）
    for (let i = 0; i < 5; i += 1) {
      await advance(5 * 60_000);
      tracker.tick();
      await flush();
    }
    // 只有最初那条告警：`alerted=true` ⇒ 时间窗不再求值；心跳未到 60min
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 单链派发 / 簿记 / 代际守卫 / 净化
  // ──────────────────────────────────────────────────────────────────────

  it('单链回归钉：orchestrator reject ⇒ **无 unhandled rejection**（.catch 在链末）', async () => {
    notify.sendSystemAlert.mockRejectedValue(new Error('notify exploded'));

    // ⚠️ 对端声明结构性 never-throw；这条钉住的是"调用侧不得裸 void promise"（Node 22
    // 未捕获 rejection = 进程退出）。若有人写成裸 `void promise`，这里会捕获到 rejection。
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
        tracker.noteCallOutcome(fail503(), { workspaceId: WORKSPACE });
      }
      await flush();
      // 再跑一轮心跳（第二个派发点的同形覆盖）
      await advance(MEMORY_HEARTBEAT_INTERVAL_MS);
      tracker.tick();
      await flush();
      // 恢复派发点（B 臂可由一次成功调用恢复）：第三个派发点
      for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
        tracker.noteCallOutcome(fail401(), { workspaceId: WORKSPACE });
      }
      tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
      await flush();
      // 给 rejection 传播留一个宏任务窗口（fake timers 下用 advance 驱动）
      await jest.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    const errorLines = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorLines).toContain('alert dispatch failed (ignored)');
    expect(errorLines).toContain('heartbeat dispatch failed (ignored)');
  });

  it('`alertDelivered` 条件文案：未送达 ⇒ 恢复通知声明「此前告警未送达，仅日志。」', async () => {
    // 探针禁用 ⇒ 一次成功调用即恢复（本用例专测文案条件，不掺探针路）
    config = configOf({ healthProbeEnabled: false });
    tracker = new EngineHealthTracker(config, notify as unknown as NotifyOrchestrator);
    // outcome = 'failed'（未出境；六态之一）
    notify.sendSystemAlert.mockResolvedValue('failed');

    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(failTimeout(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(notify.sendSystemAlert).toHaveBeenCalledTimes(1);
    // 未投递要留可 grep 的 WARN（六态不落投递表 ⇒ 日志是唯一证据）
    expect(warnSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'alert not delivered',
    );

    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();

    const recovery = sentPayloads().find((payload) => payload.kind === 'recovery');
    expect(recovery).toBeDefined();
    expect(`${recovery!.title}\n${recovery!.body}`).toContain('（此前告警未送达，仅日志。）');
    expect(recovery!.body).toContain('本通知为恢复确认，无需处置。');
  });

  it('`alertDelivered` 条件文案：已送达 ⇒ 恢复通知**不含**「此前告警未送达」', async () => {
    config = configOf({ healthProbeEnabled: false });
    tracker = new EngineHealthTracker(config, notify as unknown as NotifyOrchestrator);
    notify.sendSystemAlert.mockResolvedValue('delivered');

    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(failTimeout(), { workspaceId: WORKSPACE });
    }
    // 先让告警的 outcome 回写（`alertDelivered=true`），再恢复
    await flush();
    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();

    const recovery = sentPayloads().find((payload) => payload.kind === 'recovery');
    expect(recovery).toBeDefined();
    const content = `${recovery!.title}\n${recovery!.body}`;
    expect(content).not.toContain('此前告警未送达');
    expect(content).toContain('本通知为恢复确认，无需处置。');
  });

  it('`alertDelivered` 条件文案：outcome 仍在途（`null`）⇒ 不臆断"未送达"', async () => {
    config = configOf({ healthProbeEnabled: false });
    tracker = new EngineHealthTracker(config, notify as unknown as NotifyOrchestrator);
    // 告警派发悬挂（outcome 永不回），随即恢复：没有证据 ⇒ 文案不下结论
    notify.sendSystemAlert.mockImplementationOnce(() => new Promise<string>(() => undefined));

    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(failTimeout(), { workspaceId: WORKSPACE });
    }
    await flush();
    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();

    const recovery = sentPayloads().find((payload) => payload.kind === 'recovery');
    expect(recovery).toBeDefined();
    expect(`${recovery!.title}\n${recovery!.body}`).not.toContain('此前告警未送达');
  });

  it('恢复派发失败 ⇒ **恰好一条** WARN（tag + arm + outcome；恢复通知是唯一痕迹）', async () => {
    config = configOf({ healthProbeEnabled: false });
    tracker = new EngineHealthTracker(config, notify as unknown as NotifyOrchestrator);
    // alert 正常出境，recovery 失败（六态之一：`failed`）
    notify.sendSystemAlert.mockImplementation((payload: { kind: string }) =>
      Promise.resolve(payload.kind === 'recovery' ? 'failed' : 'delivered'),
    );

    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(failTimeout(), { workspaceId: WORKSPACE });
    }
    await flush();
    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();

    // plan D6-6/D8：恢复投递失败 = WARN 后永久静默（alerted 已清、心跳停止）——
    // 这条 WARN 是唯一证据，代际守卫**不得**把它吃掉。
    const recoveryWarns = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('recovery not delivered'));
    expect(recoveryWarns).toHaveLength(1);
    expect(recoveryWarns[0]).toContain('MEMORY_ENGINE_ALERT');
    expect(recoveryWarns[0]).toContain('arm=availability');
    expect(recoveryWarns[0]).toContain('outcome=failed');
    // 恢复失败**不**回写告警簿记（下一轮的恢复文案不受影响）
    expect(tracker.getHealthSnapshot()).toEqual({
      availability: { alerted: false },
      auth: { alerted: false },
      lastProbeOkAt: null,
    });
  });

  it('恢复派发成功 ⇒ 无 recovery WARN', async () => {
    config = configOf({ healthProbeEnabled: false });
    tracker = new EngineHealthTracker(config, notify as unknown as NotifyOrchestrator);
    notify.sendSystemAlert.mockResolvedValue('delivered');

    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(failTimeout(), { workspaceId: WORKSPACE });
    }
    await flush();
    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();

    expect(
      warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('recovery not delivered')),
    ).toHaveLength(0);
  });

  it('代际守卫：上一代迟到的 outcome 不得写脏新一代告警期的 `alertDelivered`', async () => {
    config = configOf({ healthProbeEnabled: false });
    tracker = new EngineHealthTracker(config, notify as unknown as NotifyOrchestrator);

    // 两代告警的派发都悬挂（只有 alert 悬挂；recovery 立即返回 delivered）
    const pendingAlerts: ((outcome: string) => void)[] = [];
    notify.sendSystemAlert.mockImplementation((payload: { kind: string }) =>
      payload.kind === 'alert'
        ? new Promise<string>((resolve) => pendingAlerts.push(resolve))
        : Promise.resolve('delivered'),
    );

    // 第 1 代告警（outcome 迟迟不回）
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(failTimeout(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(pendingAlerts).toHaveLength(1);
    // 恢复第 1 代（`alertDelivered` 仍是 null ⇒ 文案不下结论）
    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();

    // ⚠️ 推进时间再开第 2 代：代际基准是 `alertedSince`（数值），同一毫秒内的两代无法区分
    // ——真实流量里 5 次失败必然跨毫秒，测试里也必须如实构造这个前提。
    await advance(1_000);

    // 第 2 代告警（新的 alertedSince），先让它**成功出境**
    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(failTimeout(), { workspaceId: WORKSPACE });
    }
    await flush();
    expect(pendingAlerts).toHaveLength(2);
    pendingAlerts[1]('delivered');
    await flush();

    // 第 1 代的 outcome 现在才回来（'failed'）：若没有代际守卫，它会把第 2 代写成"未送达"
    // ⇒ 下面恢复文案会冒出「此前告警未送达」——而第 2 代事实上**已出境**。
    pendingAlerts[0]('failed');
    await flush();

    tracker.noteCallOutcome(OK, { workspaceId: WORKSPACE });
    await flush();
    const recoveries = sentPayloads().filter((payload) => payload.kind === 'recovery');
    expect(recoveries).toHaveLength(2);
    const secondRecovery = recoveries[1];
    expect(`${secondRecovery.title}\n${secondRecovery.body}`).not.toContain('此前告警未送达');
  });

  it('展示净化回归钉：含 `\\n`/`\\r`/U+2028/超长的 workspaceId ⇒ body 与日志行都单行', async () => {
    // 200 字符 + 各种换行类控制符（U+2028 是 JS 行终结符，denylist 极易漏）
    const hostile = `ws\nline\rbreak\u2028sep-${'x'.repeat(200)}`;

    for (let i = 0; i < MEMORY_CALL_FAILURE_THRESHOLD; i += 1) {
      tracker.noteCallOutcome(fail503(), { workspaceId: hostile });
    }
    await flush();

    const payload = alertPayloads()[0];
    const content = `${payload.title}\n${payload.body}`;
    // 正文整体不得含回车 / 行分隔符（否则一条告警会被拆成伪造的多行）
    expect(content).not.toContain('\r');
    expect(content).not.toContain('\u2028');
    // workspaceId 行进 allowlist 且 ≤128
    const workspaceLine = content.split('\n').find((line) => line.startsWith('workspaceId='));
    expect(workspaceLine).toBeDefined();
    const shown = workspaceLine!.slice('workspaceId='.length);
    expect(shown).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(shown.length).toBeLessThanOrEqual(128);
    // payload 里的 workspaceId 同源净化（对端"生产方已净化"的契约）
    expect(payload.workspaceId).toBe(shown);

    // 日志行同样单行（`sanitizeLogValue` 去 \r\n + 截 32）
    const errorLines = errorSpy.mock.calls.map((call) => String(call[0]));
    for (const line of errorLines) {
      expect(line).not.toContain('\r');
      expect(line).not.toContain('\u2028');
    }
  });

  it('`sanitizeAlertField`：allowlist 原样保留；非法字符替换 `_`；超长截断 128；空串占位', () => {
    expect(sanitizeAlertField('ws-1.a:b_c')).toBe('ws-1.a:b_c');
    expect(sanitizeAlertField('ws\n1')).toBe('ws_1');
    expect(sanitizeAlertField('ws\u20281')).toBe('ws_1');
    expect(sanitizeAlertField('x'.repeat(200))).toHaveLength(128);
    expect(sanitizeAlertField('')).toBe('_');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 只读快照（ENGINE_HEALTH_VIEW 的唯一输入）
  // ──────────────────────────────────────────────────────────────────────

  it('`getHealthSnapshot`：双臂告警位 + lastProbeOkAt（只读，不改转移）', async () => {
    expect(tracker.getHealthSnapshot()).toEqual({
      availability: { alerted: false },
      auth: { alerted: false },
      lastProbeOkAt: null,
    });

    tracker.noteProbeOutcome({ ok: true, value: undefined });
    expect(tracker.getHealthSnapshot().lastProbeOkAt).toBe(T0);

    // A 臂告警（探针 3 失败）
    for (let i = 0; i < MEMORY_PROBE_FAILURE_THRESHOLD; i += 1) {
      tracker.noteProbeOutcome({ ok: false, failure: failureOf({ kind: 'timeout' }) });
    }
    await flush();
    expect(tracker.getHealthSnapshot().availability.alerted).toBe(true);
    expect(tracker.getHealthSnapshot().auth.alerted).toBe(false);
    // 快照是**副本**：改动返回对象不得影响内部状态
    tracker.getHealthSnapshot().availability.alerted = false;
    expect(tracker.getHealthSnapshot().availability.alerted).toBe(true);
  });

  it('`resetForTest`：连 `lastProbeOkAt` 一起清（否则 e2e 五态用例顺序依赖）', () => {
    tracker.noteProbeOutcome({ ok: true, value: undefined });
    expect(tracker.getHealthSnapshot().lastProbeOkAt).toBe(T0);

    tracker.resetForTest();

    expect(tracker.getHealthSnapshot()).toEqual({
      availability: { alerted: false },
      auth: { alerted: false },
      // ⚠️ 复位后"从没探过" ⇒ 健康视图回答 `unknown`，而不是拿上一例的成功证据报 `up`
      lastProbeOkAt: null,
    });
  });

  it('常量合同：心跳降频阈值与恢复迟滞（评审口径的活文档）', () => {
    expect(MEMORY_HEARTBEAT_INTERVAL_MS).toBe(60 * 60_000);
    expect(MEMORY_HEARTBEAT_SLOW_INTERVAL_MS).toBe(240 * 60_000);
    expect(MEMORY_PROBE_OK_STREAK_TO_RECOVER).toBe(2);
    expect(MEMORY_CALL_FAILURE_THRESHOLD).toBe(5);
    expect(MEMORY_PROBE_FAILURE_THRESHOLD).toBe(3);
    // 心跳降频前的 3 条 + 之后的 240min 序列（plan D2：60/60/60/240…）
    expect(MEMORY_HEARTBEAT_SLOW_INTERVAL_MS / MEMORY_HEARTBEAT_INTERVAL_MS).toBe(4);
  });
});
