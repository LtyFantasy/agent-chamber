/**
 * 凭证扫描 emit helper 单测（v1.94.0-dev，卡 349d337e）
 *
 * 覆盖（计划 §五 单测矩阵）：
 * - **双 kill switch**：总开关（`HINT_CREDENTIAL_SCAN_DISABLED`）与模式级收敛
 *   （`HINT_CREDENTIAL_PATTERNS_DISABLED`）——两者都是**模块加载时读取**，故用
 *   `jest.isolateModules` 重新加载模块取证；解析语义另有纯函数用例（无需重载）；
 * - **告警行字段封闭**：`JSON.parse` 后键集断言 + **无正文** + 单 JSON 对象；
 * - **事实载荷扁平三键**（`{resourceKind, resourceId, matchedPatterns}`，恒为字符串）
 *   + `truncated` **不进**事实载荷；
 * - **未命中零副作用**（零日志、零事实）；
 * - **截断但未命中** ⇒ 一条独立 tag 的 debug（不是告警行）；
 * - **告警与送达解耦**：无请求袋（非 HTTP 场景）时事实是 no-op，**告警照落**。
 *
 * ⚠️ **kill switch 用例走 isolateModules，其余用例走顶层 import**：隔离注册表里的
 * `credential-scan` 会连带一份**独立的 `hint-facts` ALS 单例**（见该文件头的「单实例」
 * 不变量）——故事实袋断言绝不能在隔离加载的实例上做（会读到另一个袋子）。
 * ⚠️ fixture 里的 DSN 拼装而非字面（防平台扫到自己的测试数据）。
 */
import { Logger } from '@nestjs/common';
import { emitCredentialScanFactIfHit } from './credential-scan';
import { createHintFactBag, drainFacts, runWithHintFacts } from './hint-facts';

/** 平台真 key 形态 */
const REAL_AGENT_KEY = 'ask_AbCdEf0123456789_-AbCdEf0123456789';

/** 另一族 key（模式级收敛用例用） */
const REAL_SK_KEY = 'sk-abcdefghij0123456789ABCDEFGHIJ';

/** 占位 DSN 的 scheme（拼装用，见文件头警告） */
const DSN_SCHEME = 'postgres';

/** 拼装出的占位 DSN（源码里不出现可直接扫描的 DSN 字面形态） */
const PLACEHOLDER_DSN = `${DSN_SCHEME}://user:password@db.example.invalid`;

/** 收集一次调用在显式事实袋里写下的事实 */
function captureFacts(run: () => void) {
  const bag = createHintFactBag();
  runWithHintFacts(run, bag);
  return drainFacts(bag);
}

/** 取 warn 落行（单 JSON 对象）并解析；无落行 → null */
function lastWarnLine(spy: jest.SpyInstance): Record<string, unknown> | null {
  if (spy.mock.calls.length === 0) return null;
  const line = spy.mock.calls[spy.mock.calls.length - 1][0] as string;
  return JSON.parse(line) as Record<string, unknown>;
}

/** 取 debug 落行（可能不是 JSON——本模块的错误摘要行是纯文本），原样返回 */
function lastDebugLine(spy: jest.SpyInstance): string {
  return String(spy.mock.calls[spy.mock.calls.length - 1]?.[0] ?? '');
}

/**
 * 以指定 env 重新加载模块（**模块加载时读取**语义的取证方式）。
 *
 * ⚠️ **必须一并返回隔离注册表里的 Logger 间谍**：`jest.isolateModules` 会连
 * `@nestjs/common` 一起重新加载 ⇒ 模块内的 `new Logger(...)` 属于**另一个类**，
 * 外层 `Logger.prototype` 上的间谍拦不到它（会得到「永远没落行」的假绿）。
 */
function loadWithEnv(env: { scanDisabled?: string; patternsDisabled?: string }): {
  mod: typeof import('./credential-scan');
  warnSpy: jest.SpyInstance;
  debugSpy: jest.SpyInstance;
} {
  const prevScan = process.env.HINT_CREDENTIAL_SCAN_DISABLED;
  const prevPatterns = process.env.HINT_CREDENTIAL_PATTERNS_DISABLED;
  const restore = () => {
    if (prevScan === undefined) delete process.env.HINT_CREDENTIAL_SCAN_DISABLED;
    else process.env.HINT_CREDENTIAL_SCAN_DISABLED = prevScan;
    if (prevPatterns === undefined) delete process.env.HINT_CREDENTIAL_PATTERNS_DISABLED;
    else process.env.HINT_CREDENTIAL_PATTERNS_DISABLED = prevPatterns;
  };

  if (env.scanDisabled === undefined) delete process.env.HINT_CREDENTIAL_SCAN_DISABLED;
  else process.env.HINT_CREDENTIAL_SCAN_DISABLED = env.scanDisabled;
  if (env.patternsDisabled === undefined) delete process.env.HINT_CREDENTIAL_PATTERNS_DISABLED;
  else process.env.HINT_CREDENTIAL_PATTERNS_DISABLED = env.patternsDisabled;

  let loaded!: typeof import('./credential-scan');
  let isolatedWarn!: jest.SpyInstance;
  let isolatedDebug!: jest.SpyInstance;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nestCommon = require('@nestjs/common') as typeof import('@nestjs/common');
    isolatedWarn = jest
      .spyOn(nestCommon.Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    isolatedDebug = jest
      .spyOn(nestCommon.Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require('./credential-scan') as typeof import('./credential-scan');
  });
  restore();
  return { mod: loaded, warnSpy: isolatedWarn, debugSpy: isolatedDebug };
}

describe('emitCredentialScanFactIfHit', () => {
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  describe('命中：告警行 + 领域事实', () => {
    const META = { resourceKind: 'doc', resourceId: 'doc-1', actorId: 'actor-1' };

    it('落一行动告警，**字段集封闭**（JSON.parse 后键集断言）且是单 JSON 对象', () => {
      captureFacts(() => emitCredentialScanFactIfHit(`说明：${REAL_AGENT_KEY}`, META));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = lastWarnLine(warnSpy)!;
      expect(Object.keys(line).sort()).toEqual([
        'actorId',
        'patternIds',
        'resourceId',
        'resourceKind',
        'tag',
        'truncated',
        'ts',
      ]);
      expect(line.tag).toBe('SECURITY_CREDENTIAL_SUSPECTED');
      expect(line.resourceKind).toBe('doc');
      expect(line.resourceId).toBe('doc-1');
      expect(line.actorId).toBe('actor-1');
      expect(line.patternIds).toBe('platform_agent_key');
      expect(line.truncated).toBe(false);
      expect(typeof line.ts).toBe('string');
    });

    it('**告警行与事实载荷都不含正文**（正文是用户数据，禁止外流）', () => {
      const body = `这是一段带有 ${REAL_AGENT_KEY} 的正文`;
      captureFacts(() => emitCredentialScanFactIfHit(body, META));

      expect(JSON.stringify(lastWarnLine(warnSpy))).not.toContain('这是一段带有');
      expect(JSON.stringify(lastWarnLine(warnSpy))).not.toContain(REAL_AGENT_KEY);
    });

    it('写完领域事实：**扁平三键**，值恒为字符串（`matchedPatterns` 是逗号拼接串）', () => {
      const facts = captureFacts(() =>
        emitCredentialScanFactIfHit(`${REAL_AGENT_KEY} 与 ${REAL_SK_KEY}`, META),
      );

      expect(facts).toHaveLength(1);
      expect(facts[0].name).toBe('security.credential_suspected');
      expect(Object.keys(facts[0].payload ?? {}).sort()).toEqual([
        'matchedPatterns',
        'resourceId',
        'resourceKind',
      ]);
      expect(facts[0].payload).toEqual({
        resourceKind: 'doc',
        resourceId: 'doc-1',
        matchedPatterns: 'platform_agent_key,sk_key',
      });
      for (const value of Object.values(facts[0].payload ?? {})) {
        expect(typeof value).toBe('string');
      }
    });

    it('缺省 actorId ⇒ 告警行里是 `null`（键仍在——字段集封闭）', () => {
      captureFacts(() => emitCredentialScanFactIfHit(REAL_AGENT_KEY, { resourceKind: 'task_comment', resourceId: 't-1' }));

      const line = lastWarnLine(warnSpy)!;
      expect(Object.keys(line).sort()).toEqual([
        'actorId',
        'patternIds',
        'resourceId',
        'resourceKind',
        'tag',
        'truncated',
        'ts',
      ]);
      expect(line.actorId).toBeNull();
    });

    it('**告警与送达解耦**：无请求袋（定时任务/脚本场景）时事实是 no-op，**告警照落**', () => {
      // 不经 runWithHintFacts ⇒ 没有 ALS 上下文 ⇒ emitFact 是 no-op
      expect(() => emitCredentialScanFactIfHit(REAL_AGENT_KEY, META)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).not.toHaveBeenCalled();
    });
  });

  describe('未命中：零副作用', () => {
    it('干净正文 ⇒ 无告警、无 debug、无事实', () => {
      const facts = captureFacts(() =>
        emitCredentialScanFactIfHit('普通正文，没有凭证。', {
          resourceKind: 'doc',
          resourceId: 'doc-2',
        }),
      );

      expect(facts).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('null / undefined / 空串 ⇒ 无副作用（调用点无需判空，如可选 description）', () => {
      for (const text of [null, undefined, '']) {
        const facts = captureFacts(() =>
          emitCredentialScanFactIfHit(text, { resourceKind: 'task_description', resourceId: 't-1' }),
        );
        expect(facts).toEqual([]);
      }
      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    });
  });

  describe('超长正文（256KB 截断）', () => {
    it('截断但未命中 ⇒ **一条 debug**（独立 tag），且**不落事实**', () => {
      const long = 'x'.repeat(256 * 1024 + 10);
      const facts = captureFacts(() =>
        emitCredentialScanFactIfHit(long, { resourceKind: 'doc', resourceId: 'doc-3' }),
      );

      expect(facts).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(lastDebugLine(debugSpy)) as Record<string, unknown>;
      // **独立 tag**：截断是覆盖度信号，不能混进「命中数」的聚合口径
      expect(payload.tag).toBe('SECURITY_CREDENTIAL_SCAN_TRUNCATED');
      expect(payload.resourceId).toBe('doc-3');
      expect(payload.contentLength).toBe(long.length);
      expect(JSON.stringify(payload)).not.toContain('xxxx');
    });

    it('截断**且**命中 ⇒ 告警行带 truncated:true；事实载荷**仍只有三键**（truncated 不进事实）', () => {
      const long = `${REAL_AGENT_KEY}${'x'.repeat(256 * 1024)}`;
      const facts = captureFacts(() =>
        emitCredentialScanFactIfHit(long, { resourceKind: 'doc', resourceId: 'doc-4' }),
      );

      expect(lastWarnLine(warnSpy)!.truncated).toBe(true);
      expect(facts).toHaveLength(1);
      expect(facts[0].payload).toEqual({
        resourceKind: 'doc',
        resourceId: 'doc-4',
        matchedPatterns: 'platform_agent_key',
      });
      // 命中时不另外落截断 debug（一条命中一行告警，观测口径干净）
      expect(debugSpy).not.toHaveBeenCalled();
    });
  });

  describe('kill switch（模块加载时读取 ⇒ 重启生效）', () => {
    it('`HINT_CREDENTIAL_SCAN_DISABLED=true` ⇒ 扫描与告警**全停**（含模式级过滤也不跑）', () => {
      // 对照组：同一条输入在未关停的实例上**必须落行**（否则下面的「没落行」是假绿）
      const enabled = loadWithEnv({});
      enabled.mod.emitCredentialScanFactIfHit(REAL_AGENT_KEY, {
        resourceKind: 'doc',
        resourceId: 'doc-1',
      });
      expect(enabled.warnSpy).toHaveBeenCalledTimes(1);

      const mod = loadWithEnv({ scanDisabled: 'true' });

      expect(mod.mod.credentialScanDisabled()).toBe(true);
      mod.mod.emitCredentialScanFactIfHit(REAL_AGENT_KEY, {
        resourceKind: 'doc',
        resourceId: 'doc-1',
      });

      expect(mod.warnSpy).not.toHaveBeenCalled();
      expect(mod.debugSpy).not.toHaveBeenCalled();
    });

    it('总开关只认字面 `true`（`1` / `yes` / 空 ⇒ 不关停，防拼错静默关停）', () => {
      for (const value of ['1', 'yes', 'TRUE', '', 'false']) {
        const { mod, warnSpy: loadedWarn } = loadWithEnv({ scanDisabled: value });
        expect(mod.credentialScanDisabled()).toBe(false);
        // 未关停 ⇒ 真的会扫（不只是标志位为 false）
        mod.emitCredentialScanFactIfHit(REAL_AGENT_KEY, {
          resourceKind: 'doc',
          resourceId: 'doc-1',
        });
        expect(loadedWarn).toHaveBeenCalledTimes(1);
      }
    });

    it('`HINT_CREDENTIAL_PATTERNS_DISABLED=sk_key` ⇒ 只收敛该模式，其余照常命中', () => {
      const { mod, warnSpy: loadedWarn } = loadWithEnv({ patternsDisabled: 'sk_key' });

      mod.emitCredentialScanFactIfHit(REAL_SK_KEY, { resourceKind: 'doc', resourceId: 'doc-1' });
      expect(loadedWarn).not.toHaveBeenCalled();

      mod.emitCredentialScanFactIfHit(REAL_AGENT_KEY, { resourceKind: 'doc', resourceId: 'doc-1' });
      expect(lastWarnLine(loadedWarn)!.patternIds).toBe('platform_agent_key');
    });

    it('模式级收敛支持多值 / 空白 / 尾随逗号；未知 id 忽略（fail-open）', () => {
      const { mod, warnSpy: loadedWarn } = loadWithEnv({
        patternsDisabled: ' sk_key , sk_key ,nope,',
      });
      mod.emitCredentialScanFactIfHit(`${REAL_SK_KEY} ${PLACEHOLDER_DSN}`, {
        resourceKind: 'doc',
        resourceId: 'doc-1',
      });
      // sk_key 被收敛，connection_string 未被收敛 ⇒ 只剩后者命中
      expect(lastWarnLine(loadedWarn)!.patternIds).toBe('connection_string');
    });
  });

  describe('parseDisabledPatternIds（纯函数，无需重载模块）', () => {
    it('空 / 全空白 / 尾随逗号 / 未知 token 的解析语义', async () => {
      const { parseDisabledPatternIds } = await import('./credential-scan');

      expect([...parseDisabledPatternIds(undefined)]).toEqual([]);
      expect([...parseDisabledPatternIds('')]).toEqual([]);
      expect([...parseDisabledPatternIds('  ,,  ')]).toEqual([]);
      expect([...parseDisabledPatternIds('a, b ,,c,')]).toEqual(['a', 'b', 'c']);
      expect([...parseDisabledPatternIds('nope')]).toEqual(['nope']);
    });
  });
});
