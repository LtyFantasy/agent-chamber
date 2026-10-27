/**
 * hint 埋点单测（2 期，v1.92.0-dev）
 *
 * 覆盖：两 tag 独立、JSONL 单行纪律（JSON.stringify 形态）、空值键省略、
 * logHintEmitted → warn / logHintSuppressed → debug（仿 search.service.spec 的
 * zero-hit-log spy 先例）。
 */
import type { Logger } from '@nestjs/common';
import {
  buildHintEmittedLogLine,
  buildHintSuppressedLogLine,
  logHintEmittedLegacy,
  HINT_LOG_TAG,
  HINT_SUPPRESSED_LOG_TAG,
  HINT_SUPPRESS_REASON,
  logHintEmitted,
  logHintSuppressed,
  type HintLogInput,
} from './hint-log';

describe('hint-log', () => {
  const base: HintLogInput = {
    code: 'missing_category',
    status: 'suggestion',
    family: 'metadata',
    surface: 'upsert',
    spaceId: 'space-1',
    actorId: 'agent-1',
    resourceKey: 'doc-1',
    // ts 显式固定：**同 builder 的两次调用必须逐字可比**（缺省 = 调用时刻，两次调用
    // 可能落在不同毫秒 ⇒ 用 `toBe` 对照两侧会 flaky——全量套件里已实证）
    ts: '2026-10-12T00:00:00.000Z',
  };

  it('两个 tag 独立（不得复用 zero-hit / weak-hit 的过滤键）', () => {
    expect(HINT_LOG_TAG).toBe('DOC_HINT_EMITTED');
    expect(HINT_SUPPRESSED_LOG_TAG).toBe('DOC_HINT_SUPPRESSED');
    expect(HINT_LOG_TAG).not.toBe(HINT_SUPPRESSED_LOG_TAG);
  });

  it('emitted 行：单行 JSON + 全字段（tag/ts/code/status/family/surface/spaceId/actorId/resourceKey）', () => {
    const line = buildHintEmittedLogLine(base);
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({
      tag: HINT_LOG_TAG,
      // ts 缺省 = 调用时刻（阶段三观察期仪器：让 stdout 采集链捞出的行能直接进 SQL 时间窗）
      ts: expect.any(String),
      code: 'missing_category',
      status: 'suggestion',
      family: 'metadata',
      surface: 'upsert',
      spaceId: 'space-1',
      actorId: 'agent-1',
      resourceKey: 'doc-1',
    });
  });

  it('ts：显式传入时逐字落库（单测可断言）；缺省时是 ISO 8601 串；emitted 行不含 reason 键', () => {
    const explicit = JSON.parse(
      buildHintEmittedLogLine({ ...base, ts: '2026-10-12T00:00:00.000Z' }),
    ) as Record<string, unknown>;
    expect(explicit.ts).toBe('2026-10-12T00:00:00.000Z');
    // reason 是 suppressed 行的字段（「为什么没送达」），emitted 行就是送达本身 ⇒ 不带该键
    expect(explicit).not.toHaveProperty('reason');

    // 缺省路径：**去掉 ts** 再构行 ⇒ 应落一个可被 Date 解析的 ISO 串
    const { ts: _omitted, ...withoutTs } = base;
    const implicit = JSON.parse(buildHintEmittedLogLine(withoutTs)) as { ts: string };
    expect(new Date(implicit.ts).toISOString()).toBe(implicit.ts);
  });

  it('suppressed 行：`reason` 键**恒存在**（缺省 null = 窗口压制）且区分另外两种未送达成因', () => {
    // 缺省 = null（§5 反事实对照组只认这一档：reason IS NULL 才是「若无窗口本会送达」）
    const windowSuppressed = JSON.parse(buildHintSuppressedLogLine(base)) as Record<string, unknown>;
    expect(windowSuppressed).toHaveProperty('reason', null);

    for (const reason of [
      HINT_SUPPRESS_REASON.slotTruncated,
      HINT_SUPPRESS_REASON.permissionFiltered,
    ]) {
      const line = JSON.parse(buildHintSuppressedLogLine({ ...base, reason })) as {
        reason: string;
      };
      expect(line.reason).toBe(reason);
    }
    // 两个值域常量逐字钉（日志聚合按值过滤，改名 = 观测断裂）
    expect(HINT_SUPPRESS_REASON.slotTruncated).toBe('slot_truncated');
    expect(HINT_SUPPRESS_REASON.permissionFiltered).toBe('permission_filtered');
  });

  it('suppressed 行：同形状但 tag 不同', () => {
    expect(JSON.parse(buildHintSuppressedLogLine(base)).tag).toBe(HINT_SUPPRESSED_LOG_TAG);
  });

  it('可空字段省略（不落 null 键）：spaceId/actorId/resourceKey/family', () => {
    const line = buildHintEmittedLogLine({
      code: 'zero_hit',
      status: 'suggestion',
      family: 'read',
      surface: 'search',
      spaceId: null,
      actorId: null,
      resourceKey: null,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('spaceId');
    expect(parsed).not.toHaveProperty('actorId');
    expect(parsed).not.toHaveProperty('resourceKey');
    // family 为 null（tags_normalized 无族）时同样省略
    const noFamily = JSON.parse(
      buildHintEmittedLogLine({ ...base, family: null }),
    ) as Record<string, unknown>;
    expect(noFamily).not.toHaveProperty('family');
  });

  it('落行级别：emitted → warn / suppressed → debug（jest spy 断言锚点）', () => {
    const logger = { warn: jest.fn(), debug: jest.fn() } as unknown as Logger;
    logHintEmitted(logger, base);
    logHintSuppressed(logger, base);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toBe(buildHintEmittedLogLine(base));
    expect((logger.debug as jest.Mock).mock.calls[0][0]).toBe(buildHintSuppressedLogLine(base));
  });

  it('logHintEmittedLegacy（旧三态）：debug 级 + **同 builder/同 tag**（N1）', () => {
    const logger = { warn: jest.fn(), debug: jest.fn() } as unknown as Logger;
    const legacy: HintLogInput = {
      ...base,
      code: 'weak_hit',
      family: 'read',
      surface: 'search',
    };
    logHintEmittedLegacy(logger, legacy);

    // 降级只改**级别**：tag 与字段形状与常规 emitted 完全一致（聚合按 tag+level+code）
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect((logger.debug as jest.Mock).mock.calls[0][0]).toBe(buildHintEmittedLogLine(legacy));
    expect(JSON.parse(buildHintEmittedLogLine(legacy)).tag).toBe(HINT_LOG_TAG);
  });
});
