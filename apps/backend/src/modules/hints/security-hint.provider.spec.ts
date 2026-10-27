/**
 * SecurityHintProvider 单测（v1.94.0-dev）
 *
 * 覆盖（计划 §五 单测矩阵）：
 * - **事实 → 候选映射**：`resourceKey = {resourceKind}:{resourceId}`、`data` 三键、
 *   `matchedPatterns` 从 patternId 解析成 **label**；
 * - **data 键集合封闭**（守卫消费方契约：结构化信息只读 data）；
 * - **非法 patternId**：跳过解析 + 落 debug（**只落 fact 名 + patternId**，禁正文），
 *   且在文案里**回落为 id 本身**（不能渲染出空括号）；
 * - **永不抛**：畸形载荷 / 不关心的事实名 / 内部异常（spy 逼出）都不逃逸；
 * - 委托契约：surface / familyOf / ttlOf（注册表）/ factNames / 文案单源；
 * - **零查库 / 零告警职责**（结构性保证：本 provider 连正文都看不到，且不落 warn 行）。
 */
import { Logger } from '@nestjs/common';
import { HintRegistry } from './hint-registry';
import { SecurityHintProvider } from './security-hint.provider';
import {
  SECURITY_HINT,
  SECURITY_HINT_MESSAGES,
} from './security-hint.constants';
import type { HintFact } from './hint-facts';
import type { HintFactProvider } from './hint.interceptor';

/** 一条凭证事实（载荷形状由 `credential-scan.ts` 保证：扁平三键） */
function fact(over: Record<string, unknown> = {}): HintFact {
  return {
    name: 'security.credential_suspected',
    payload: {
      resourceKind: 'doc',
      resourceId: 'doc-1',
      matchedPatterns: 'platform_agent_key',
      ...over,
    },
  };
}

function buildProvider(): SecurityHintProvider {
  return new SecurityHintProvider(new HintRegistry());
}

describe('SecurityHintProvider', () => {
  describe('事实 → 候选', () => {
    it('单事实 → 单候选：resourceKey 带 resourceKind、data 三键、文案含 label', async () => {
      const provider = buildProvider();

      const candidates = await provider.build([fact()], null);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        code: SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED,
        status: 'suggestion',
        resourceKey: 'doc:doc-1',
        data: {
          resourceKind: 'doc',
          resourceId: 'doc-1',
          matchedPatterns: ['平台 agent key（ask_ 前缀）'],
        },
      });
      expect(candidates[0].message).toContain('平台 agent key（ask_ 前缀）');
      expect(candidates[0].message).toContain('轮换');
    });

    it('**data 键集合封闭**（消费方只读这里，不解析 message）', async () => {
      const provider = buildProvider();

      const [candidate] = await provider.build([fact({ matchedPatterns: 'sk_key,slack_token' })], null);

      expect(Object.keys(candidate.data ?? {}).sort()).toEqual([
        'matchedPatterns',
        'resourceId',
        'resourceKind',
      ]);
      expect(candidate.data?.matchedPatterns).toEqual(['sk- 前缀 key', 'Slack token']);
    });

    it('多事实 → 多候选（每条资源各自一条；同资源由内核按 (code, resourceKey) 去重）', async () => {
      const provider = buildProvider();

      const candidates = await provider.build(
        [fact(), fact({ resourceKind: 'task_comment', resourceId: 'task-1' })],
        null,
      );

      expect(candidates.map((c) => c.resourceKey)).toEqual(['doc:doc-1', 'task_comment:task-1']);
    });

    it('resourceKey 带 kind ⇒ 同一 taskId 的「描述」与「评论」是两条独立提示', async () => {
      const provider = buildProvider();

      const candidates = await provider.build(
        [fact({ resourceKind: 'task_description', resourceId: 't-1' }), fact({ resourceKind: 'task_comment', resourceId: 't-1' })],
        null,
      );

      expect(new Set(candidates.map((c) => c.resourceKey)).size).toBe(2);
    });
  });

  describe('载荷畸形 / 事实过滤（不抛）', () => {
    it('不关心的事实名 ⇒ 空候选（零副作用）', async () => {
      const provider = buildProvider();

      expect(await provider.build([{ name: 'doc.upserted', payload: {} }], null)).toEqual([]);
      expect(await provider.build([], null)).toEqual([]);
    });

    it('缺键 / 非字符串 / 空串 ⇒ 空候选（fail-closed，不猜）', async () => {
      const provider = buildProvider();

      for (const patch of [
        { resourceKind: undefined },
        { resourceId: undefined },
        { matchedPatterns: undefined },
        { resourceId: '' },
        { resourceKind: 42 },
        { matchedPatterns: '' },
        { matchedPatterns: ' , , ' },
      ]) {
        expect(await provider.build([fact(patch)], null)).toEqual([]);
      }
      expect(await provider.build([{ name: 'security.credential_suspected' }], null)).toEqual([]);
    });

    it('**非法 patternId**：跳过解析（回落为 id）+ 落 debug（只落 fact 名 + patternId）', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      try {
        const provider = buildProvider();

        const [candidate] = await provider.build([fact({ matchedPatterns: 'nope_id' })], null);

        // 安全方向 = 宁可多报：未知 id 不让整条提示消失
        expect(candidate).toBeDefined();
        expect(candidate.data?.matchedPatterns).toEqual(['nope_id']);
        expect(candidate.message).toContain('nope_id');
        expect(debugSpy).toHaveBeenCalledTimes(1);
        const line = String(debugSpy.mock.calls[0][0]);
        expect(line).toContain('SECURITY_HINT_UNKNOWN_PATTERN');
        expect(line).toContain('nope_id');
        expect(line).toContain('security.credential_suspected');
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('未知 id 与已知 id 混排：各自处理，文案不出现空括号', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      try {
        const provider = buildProvider();

        const [candidate] = await provider.build(
          [fact({ matchedPatterns: 'sk_key,nope_id' })],
          null,
        );

        expect(candidate.data?.matchedPatterns).toEqual(['sk- 前缀 key', 'nope_id']);
        expect(candidate.message).toContain('sk- 前缀 key, nope_id');
        expect(candidate.message).not.toContain('（）');
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('per-fact fail-open：单条事实异常不影响其余事实（且不抛）', async () => {
      const provider = buildProvider();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // spy 逼出内部异常：payload 的 matchedPatterns 是「看似字符串」的怪对象
      const evil = {
        name: 'security.credential_suspected',
        payload: {
          resourceKind: 'doc',
          resourceId: 'doc-evil',
          get matchedPatterns(): string {
            throw new Error('boom');
          },
        },
      } as unknown as HintFact;
      try {
        const candidates = await provider.build([evil, fact()], null);

        expect(candidates.map((c) => c.resourceKey)).toEqual(['doc:doc-1']);
        expect(warnSpy).toHaveBeenCalled();
        expect(String(warnSpy.mock.calls[0][0])).toContain('[SECURITY_HINT_FACT_FAILED]');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('**零告警职责**：build 从不落 warn 行（告警在扫描点，不在 provider）', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const provider = buildProvider();
        await provider.build([fact()], null);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('委托契约', () => {
    it('surface / familyOf / ttlOf（注册表）/ factNames', () => {
      const provider = buildProvider();

      expect(provider.surface).toBe('credential_scan');
      expect(provider.familyOf()).toBe('security');
      expect(provider.ttlOf(SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED)).toBe(6 * 60 * 60 * 1000);
      expect(provider.ttlOf('nope')).toBeUndefined();
      expect([...provider.factNames]).toEqual(['security.credential_suspected']);
      // 单码 provider 不声明 priority（见其注释）——经契约面断言（具体类上没有该属性）
      expect((provider as HintFactProvider).priority).toBeUndefined();
    });

    it('resolveMessage：候选自带 message 覆盖优先；未登记码回落 code 本身', () => {
      const provider = buildProvider();
      const candidate = {
        code: SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED,
        status: 'suggestion' as const,
        resourceKey: 'doc:doc-1',
        data: { labels: 'x' },
      };

      expect(provider.resolveMessage({ ...candidate, message: '覆盖' })).toBe('覆盖');
      expect(provider.resolveMessage(candidate)).toBe(
        SECURITY_HINT_MESSAGES[SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED].replace(
          '{labels}',
          'x',
        ),
      );
      expect(provider.resolveMessage({ ...candidate, code: 'nope' })).toBe('nope');
    });
  });
});
