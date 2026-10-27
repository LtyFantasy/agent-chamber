/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - hint 信封**接线层**的三条去重窗口豁免规则（2 期抽核到 modules/hints）：
 *     `normalized` 事实回显 / `noDedup` 旧三态双写 / `markWindow:false` dryRun 预演。
 *
 * [代码职责]
 *   - 钉住「谁进窗口、谁不进窗口」与「埋点恒发生」两条契约（窗口规则散落的后果是
 *     迁移期字段倒挂或预演吞掉正式请求——见 BLOCKER-1 / MAJOR-1 修复记录）。
 *   - **用假 code 词表**（fx_*）测接线本身：接线层不认识任何领域 code（排序 / 文案 /
 *     族归属全由 `options.profile` 注入），用 docspace 词表测反而掩盖分层回归；
 *     docspace 侧的真实词表行为由 `docspace-hints.e2e-spec.ts` 与
 *     `doc-hints.helper.spec.ts` 覆盖。
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §2.7「hints 信封（advisory 提示）」（去重窗口与豁免）
 *   - 补充: docs/spec.md §4.1a（DocHint 类型契约）
 *
 * [踩坑索引]
 *   - dryRun 预演占窗口 → 正式请求被自己的预演吞掉（BLOCKER-1）
 *   - 旧三态双写参与去重 → `hint` 有而 `hints[]` 无（MAJOR-1）
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档] 确认修改符合设计意图
 *   □ 新增豁免规则时同步补本套件用例
 * =============================================================================
 */
import type { Logger } from '@nestjs/common';
import { emitHints, type HintEmitProfile } from './hint-emit';
import { HintDedupService } from './hint-dedup.service';
import { makeHintCandidate, type HintCandidate } from './hint-core';

/** 假 code 词表（接线层对 code 无感知——词表只用于构造候选与断言） */
type FakeCode = 'fx_a' | 'fx_b' | 'fx_legacy';
const PROFILE: HintEmitProfile<FakeCode> = {
  priority: ['fx_a', 'fx_b', 'fx_legacy'],
  resolveMessage: (candidate) => `消息:${candidate.code}`,
  familyOf: (code) => (code === 'fx_legacy' ? 'legacy' : null),
};

/** 旧三态双写的等价物：领域侧给 noDedup 标记（这里用假 code 复刻同一形状） */
function makeNoDedupCandidate(code: FakeCode, resourceKey: string): HintCandidate<FakeCode> {
  return { ...makeHintCandidate(code, 'suggestion', resourceKey), noDedup: true };
}

describe('hint-emit.emitHints', () => {
  let logger: Logger;
  let dedup: HintDedupService;

  beforeEach(() => {
    logger = { warn: jest.fn(), debug: jest.fn() } as unknown as Logger;
    dedup = new HintDedupService();
  });

  const ctx = { surface: 'upsert', spaceId: 'space-1', actorId: 'agent-1' };
  const options = { profile: PROFILE };

  it('空候选 → undefined（禁空数组）', () => {
    expect(emitHints(logger, dedup, [], ctx, options)).toBeUndefined();
  });

  it('常规候选：首次送达并标记窗口；二次同键被压制（debug 落行）', () => {
    const candidate = makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'doc-1');

    const first = emitHints(logger, dedup, [candidate], ctx, options);
    expect(first?.map((h) => h.code)).toEqual(['fx_a']);
    expect(dedup.isSuppressed('agent-1', 'fx_a', 'doc-1')).toBe(true);

    const second = emitHints(logger, dedup, [candidate], ctx, options);
    expect(second).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it('noDedup 候选（旧三态双写）：不压制、不标记，**每次**都埋点且落 debug 级（N1）', () => {
    const legacy = makeNoDedupCandidate('fx_legacy', 'space-1:abc');
    expect(legacy.noDedup).toBe(true);

    const first = emitHints(logger, dedup, [legacy], ctx, options);
    const second = emitHints(logger, dedup, [legacy], ctx, options);

    expect(first?.map((h) => h.code)).toEqual(['fx_legacy']);
    expect(second?.map((h) => h.code)).toEqual(['fx_legacy']);
    expect(dedup.isSuppressed('agent-1', 'fx_legacy', 'space-1:abc')).toBe(false);
    // N1：旧三态豁免窗口 ⇒ 每次都送达，量级高 ⇒ debug（warn 会淹没有效信号；
    // zero_hit 与 logSearchZeroHit 同触发，warn 还会重复落两行）
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('normalized 候选：不压制、不标记（每次请求的事实回显）且恒落 warn 级 emitted 行', () => {
    const normalized = makeHintCandidate<FakeCode>('fx_a', 'normalized', 'doc-1');
    emitHints(logger, dedup, [normalized], ctx, options);
    const again = emitHints(logger, dedup, [normalized], ctx, options);

    expect(again?.map((h) => h.status)).toEqual(['normalized']);
    expect(dedup.isSuppressed('agent-1', 'fx_a', 'doc-1')).toBe(false);
    // normalized 是写侧动作回显（低频、修正率正面信号）⇒ 不降级
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('markWindow:false（dryRun 预演）：照常组装+埋点，但**不占窗口**', () => {
    const candidate = makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'doc-1');

    const preview = emitHints(logger, dedup, [candidate], ctx, {
      ...options,
      markWindow: false,
    });
    expect(preview?.map((h) => h.code)).toEqual(['fx_a']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // 窗口未被占用 → 正式请求照样送达（BLOCKER-1 的核心断言）
    expect(dedup.isSuppressed('agent-1', 'fx_a', 'doc-1')).toBe(false);

    const real = emitHints(logger, dedup, [candidate], ctx, options);
    expect(real?.map((h) => h.code)).toEqual(['fx_a']);
    // 正式路径标记后，后续同键才被压制
    expect(dedup.isSuppressed('agent-1', 'fx_a', 'doc-1')).toBe(true);
  });

  it('markWindow:false 仍受既有窗口约束（近期真送达过 → 预演也被压制）', () => {
    const candidate = makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'doc-1');
    emitHints(logger, dedup, [candidate], ctx, options); // 真送达，占窗口

    const preview = emitHints(logger, dedup, [candidate], ctx, { ...options, markWindow: false });
    expect(preview).toBeUndefined();
  });

  it('埋点字段：code/status/family/surface/spaceId/actorId/resourceKey 全落（family 由 profile 注入）', () => {
    const candidate = makeNoDedupCandidate('fx_legacy', 'space-1:abc');
    emitHints(logger, dedup, [candidate], ctx, options);

    // 旧三态走 debug 级；行形状与 warn 行同 builder（聚合按 tag+level+code）
    const line = JSON.parse((logger.debug as jest.Mock).mock.calls[0][0] as string);
    expect(line).toEqual({
      tag: 'DOC_HINT_EMITTED',
      // ts = 阶段三观察期仪器（缺省调用时刻）
      ts: expect.any(String),
      code: 'fx_legacy',
      status: 'suggestion',
      surface: 'upsert',
      family: 'legacy',
      spaceId: 'space-1',
      actorId: 'agent-1',
      resourceKey: 'space-1:abc',
    });
  });

  it('familyOf 缺省 → family 键不出现（不落 null）', () => {
    const noFamilyProfile: HintEmitProfile<FakeCode> = {
      priority: PROFILE.priority,
      resolveMessage: PROFILE.resolveMessage,
    };
    emitHints(logger, dedup, [makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'k1')], ctx, {
      profile: noFamilyProfile,
    });
    const line = JSON.parse((logger.warn as jest.Mock).mock.calls[0][0] as string);
    expect(line).not.toHaveProperty('family');
  });

  it('profile.ttlOf 被消费：isSuppressed 与 mark **两个调用点**都拿到该 code 的声明窗口', () => {
    const day = 24 * 60 * 60 * 1000;
    const dayProfile: HintEmitProfile<FakeCode> = {
      ...PROFILE,
      ttlOf: (code) => (code === 'fx_a' ? day : undefined),
    };
    const isSuppressed = jest.spyOn(dedup, 'isSuppressed');
    const mark = jest.spyOn(dedup, 'mark');

    const hints = emitHints(
      logger,
      dedup,
      [makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'doc-1')],
      ctx,
      { profile: dayProfile },
    );

    expect(hints?.map((h) => h.code)).toEqual(['fx_a']);
    expect(isSuppressed).toHaveBeenCalledWith('agent-1', 'fx_a', 'doc-1', day);
    expect(mark).toHaveBeenCalledWith('agent-1', 'fx_a', 'doc-1', day);
  });

  it('ttlOf 声明真的决定窗口长度：24h 声明下 7h 后仍压制（缺省 6h 会已过期）', () => {
    jest.useFakeTimers();
    const day = 24 * 60 * 60 * 1000;
    const dayProfile: HintEmitProfile<FakeCode> = { ...PROFILE, ttlOf: () => day };
    const candidate = makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'doc-1');

    emitHints(logger, dedup, [candidate], ctx, { profile: dayProfile });
    jest.advanceTimersByTime(7 * 60 * 60 * 1000);

    // 同一标记，按声明窗口判定 → 仍在窗口内
    expect(emitHints(logger, dedup, [candidate], ctx, { profile: dayProfile })).toBeUndefined();
    // 按缺省 6h 判定 → 已失效（「缩短立即生效」的同一语义面）
    expect(dedup.isSuppressed('agent-1', 'fx_a', 'doc-1')).toBe(false);

    jest.useRealTimers();
  });

  it('ttlOf 缺省（docspace 侧 profile 形态）：两处都传 undefined ⇒ dedup 落缺省 6h', () => {
    const isSuppressed = jest.spyOn(dedup, 'isSuppressed');
    const mark = jest.spyOn(dedup, 'mark');

    emitHints(logger, dedup, [makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'doc-1')], ctx, options);

    // undefined ⇒ 形参默认值生效（阶段一行为逐字不变）
    expect(isSuppressed).toHaveBeenCalledWith('agent-1', 'fx_a', 'doc-1', undefined);
    expect(mark).toHaveBeenCalledWith('agent-1', 'fx_a', 'doc-1', undefined);
    expect(dedup.isSuppressed('agent-1', 'fx_a', 'doc-1')).toBe(true);
  });

  it('豁免项不消费 ttlOf（normalized / noDedup 既不判定也不标记窗口）', () => {
    const ttlOf = jest.fn(() => 24 * 60 * 60 * 1000);
    const exemptProfile: HintEmitProfile<FakeCode> = { ...PROFILE, ttlOf };
    const isSuppressed = jest.spyOn(dedup, 'isSuppressed');
    const mark = jest.spyOn(dedup, 'mark');

    emitHints(
      logger,
      dedup,
      [makeHintCandidate<FakeCode>('fx_a', 'normalized', 'doc-1'), makeNoDedupCandidate('fx_legacy', 'k2')],
      ctx,
      { profile: exemptProfile },
    );

    expect(isSuppressed).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(ttlOf).not.toHaveBeenCalled();
  });

  // ─── 阶段三：槽位预算（maxHints）+ 逐候选埋点面 ─────────────────────────

  describe('槽位预算（决策 5）', () => {
    it('maxHints 缺省 = HINT_MAX_PER_RESPONSE（截尾到 3）', () => {
      const many = (['fx_a', 'fx_b', 'fx_legacy'] as const).flatMap((code) => [
        makeHintCandidate<FakeCode>(code, 'suggestion', `k-${code}-1`),
        makeHintCandidate<FakeCode>(code, 'suggestion', `k-${code}-2`),
      ]);
      const hints = emitHints(logger, dedup, many, ctx, options);
      expect(hints).toHaveLength(3);
    });

    it('maxHints 显式预算：只给 1 个槽位 ⇒ 只送达 1 条，且**未获槽位者落 reason=slot_truncated**', () => {
      const a = makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'k-a');
      const b = makeHintCandidate<FakeCode>('fx_b', 'suggestion', 'k-b');

      const hints = emitHints(logger, dedup, [a, b], ctx, { ...options, maxHints: 1 });

      expect(hints?.map((h) => h.code)).toEqual(['fx_a']);
      // 未获槽位**不占窗口**（根本不是「送达过」）
      expect(dedup.isSuppressed('agent-1', 'fx_b', 'k-b')).toBe(false);
      // 但必须可见：debug 行 + reason=slot_truncated（「域侧挤占」的唯一观测面）
      const line = JSON.parse((logger.debug as jest.Mock).mock.calls[0][0] as string);
      expect(line).toMatchObject({
        tag: 'DOC_HINT_SUPPRESSED',
        code: 'fx_b',
        reason: 'slot_truncated',
        resourceKey: 'k-b',
      });
    });

    it('maxHints = 0（域侧占满）：**仍完成求值** ⇒ 全部候选落 slot_truncated，返回 undefined', () => {
      const a = makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'k-a');

      const hints = emitHints(logger, dedup, [a], ctx, { ...options, maxHints: 0 });

      expect(hints).toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
      const line = JSON.parse((logger.debug as jest.Mock).mock.calls[0][0] as string);
      expect(line).toMatchObject({ code: 'fx_a', reason: 'slot_truncated' });
    });

    it('未获槽位**不误报窗口压制**：窗口压制行的 reason 恒为 null，两档不混', () => {
      const windowed = makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'k-window');
      emitHints(logger, dedup, [windowed], ctx, options); // 先真送达占窗口
      (logger.debug as jest.Mock).mockClear();

      // 同键再来（窗口压制）+ 另两条挤预算（slot_truncated）在同一响应里
      const hints = emitHints(
        logger,
        dedup,
        [windowed, makeHintCandidate<FakeCode>('fx_b', 'suggestion', 'k-1'), makeHintCandidate<FakeCode>('fx_legacy', 'suggestion', 'k-2')],
        ctx,
        { ...options, maxHints: 1 },
      );

      expect(hints?.map((h) => h.code)).toEqual(['fx_b']);
      const reasons = (logger.debug as jest.Mock).mock.calls.map(
        (call) => (JSON.parse(call[0] as string) as { reason: string | null }).reason,
      );
      expect(reasons).toContain(null); // 窗口压制
      expect(reasons).toContain('slot_truncated'); // 挤占
    });
  });

  describe('逐候选埋点面（surfaceOf / spaceIdOf，决策 6）', () => {
    it('合并求值形态：surfaceOf 逐候选解析面的归属，spaceIdOf 返回 null 即取 null（不回落到 ctx）', () => {
      const hints = emitHints(
        logger,
        dedup,
        [
          makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'k-a'),
          makeHintCandidate<FakeCode>('fx_b', 'suggestion', 'k-b'),
        ],
        {
          surface: 'fallback_surface',
          spaceId: 'space-1',
          actorId: 'agent-1',
          // 逐候选覆盖：fx_a → task_hygiene / fx_b → memory_nomination
          surfaceOf: (candidate) => `surface-${candidate.code}`,
          // **显式 null 即最终值**（不回落 ctx.spaceId）——契约见 HintEmitContext.spaceIdOf
          spaceIdOf: (candidate) => (candidate.code === 'fx_a' ? null : 'space-9'),
        },
        options,
      );
      expect(hints).toHaveLength(2);

      const lines = (logger.warn as jest.Mock).mock.calls.map(
        (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
      );
      expect(lines[0]).toMatchObject({ surface: 'surface-fx_a' });
      expect(lines[0]).not.toHaveProperty('spaceId'); // 显式 null ⇒ 键不落
      expect(lines[1]).toMatchObject({ surface: 'surface-fx_b', spaceId: 'space-9' });
    });

    it('不传钩子时行为与阶段一逐字一致（单一 surface / spaceId）', () => {
      emitHints(logger, dedup, [makeHintCandidate<FakeCode>('fx_a', 'suggestion', 'k-a')], ctx, options);
      const line = JSON.parse((logger.warn as jest.Mock).mock.calls[0][0] as string);
      expect(line).toMatchObject({ surface: 'upsert', spaceId: 'space-1' });
    });
  });
});
