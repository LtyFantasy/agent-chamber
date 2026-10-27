/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - hint 触发器拦截器的**契约面**（阶段一）：事实袋 → provider 求值 → 信封挂载，
 *     以及五条跳过规则、双写让位与 fail-open 兜底。
 *
 * [代码职责]
 *   - 钉住「挂载成功 / 禁空数组 / **不覆盖域侧已挂的 hints** / **饿死语义（被压制也算
 *     胜出）** / 非 http / `@Sse` / `@SkipTransform` / writableEnded / 非对象载荷 各跳过 /
 *     provider 抛错 fail-open 主响应不受影响 / 无 provider 零开销快路径」。
 *   - **阶段二补钉两条 async 契约**：①`build` 返回 Promise 时挂载结果必须是**已解析的
 *     hints**（不是 Promise —— 那正是 `map` 时代的失效形态）；②`build` reject 时主响应
 *     200 直通且无 hints（**await-aware 的 fail-open 回归锁**）。
 *   - **fixture handler 复刻 Nest 的 controller 形态**（async 函数 + await 之后才 emit
 *     事实）：本套件证明的是「真框架链路下端到端挂载生效」这一件事；**ALS 的 run 边界
 *     本身不是本套件可判别的性质**——Nest 10 的链用 `AsyncResource.bind` 在 `handle()`
 *     调用时捕获上下文，多种包装形态都能让 handler 读到 store（见同构探针结论与
 *     hint.interceptor.ts 内注释）。
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *
 * [铁律关联] #17(测试契约) #18(不变量检查)
 *
 * [修改检查]
 *   □ 已读 [权威文档] 确认修改符合设计意图
 *   □ 新增跳过规则 / 改变 run 边界 / 改 provider 契约（含同步↔异步）时同步补本套件用例
 * =============================================================================
 */
import { CallHandler, Controller, ExecutionContext, Get, INestApplication, Logger } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { firstValueFrom, from } from 'rxjs';
import request = require('supertest');
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { makeHintCandidate, type HintCandidate } from './hint-core';
import { HintDedupService } from './hint-dedup.service';
import { emitFact } from './hint-facts';
import { HINT_FACT_PROVIDERS, HintInterceptor, type HintFactProvider } from './hint.interceptor';

/** 假 code 词表（拦截器对 code 无感知——语义全在 provider 里） */
const CODE = 'fx_code';
/** 第二个假 code（多 provider 合并求值用例：区分两个 provider 的产出） */
const CODE2 = 'fx_code_2';
const FACT = 'doc.created';

/**
 * 忠实复刻 Nest：`@SkipTransform()` / `@Sse()` 都是**方法元数据**，由 Reflector 读
 * （键值分别是 `skipTransform` 与 `@nestjs/common/constants` 的 `__sse__`）。
 */
function makeReflector(metadata: { skipTransform?: boolean; sse?: boolean } = {}): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === 'skipTransform') return metadata.skipTransform;
      if (key === '__sse__') return metadata.sse;
      return undefined;
    },
  } as unknown as Reflector;
}

interface ContextOptions {
  skipTransform?: boolean;
  /** `@Sse()` 端点（帧是普通对象，形态守卫拦不住——必须由元数据判定跳过） */
  sse?: boolean;
  writableEnded?: boolean;
  user?: { userId: string };
  agent?: { id: string };
  type?: string;
}

function makeContext(options: ContextOptions = {}): ExecutionContext {
  const response = { writableEnded: options.writableEnded ?? false };
  const request = { user: options.user, agent: options.agent };
  return {
    getType: () => options.type ?? 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => () => undefined,
    getClass: () => class Fixture {},
  } as unknown as ExecutionContext;
}

/**
 * fixture handler：**async 函数 + await 之后才 emit**——与 Nest 的 controller 同形态
 * （controller 在拦截器链的异步续体里被调用，事实通常也不是函数体第一行写的）。
 */
function makeHandler(payload: unknown, onCall?: () => void): CallHandler {
  return {
    handle: () =>
      from(
        (async () => {
          await Promise.resolve();
          onCall?.();
          return payload;
        })(),
      ),
  };
}

function makeProvider(over: Partial<HintFactProvider> = {}): HintFactProvider {
  return {
    factNames: [FACT],
    surface: 'fixture_surface',
    priority: [CODE],
    resolveMessage: (candidate) => `消息:${candidate.code}`,
    familyOf: () => 'fixture',
    // ⚠️ **async**：阶段二起 provider 契约返回 Promise（拦截器用 mergeMap + await 消费）。
    // fixture 必须同形态——同步版本会让"忘了 await"的实现照样假绿（响应体变成 `{}`
    // 这种失效形态只有真实形态的 fixture 才拦得住，见下方 fail-open/async 两条用例）
    build: async (facts): Promise<readonly HintCandidate[]> =>
      facts.map((fact) =>
        makeHintCandidate(CODE, 'suggestion', `doc:${String(fact.payload?.docId)}`),
      ),
    ...over,
  };
}

describe('HintInterceptor', () => {
  let dedup: HintDedupService;

  beforeEach(() => {
    dedup = new HintDedupService();
  });

  const build = (
    providers: HintFactProvider[],
    metadata: { skipTransform?: boolean; sse?: boolean } = {},
  ): HintInterceptor => new HintInterceptor(makeReflector(metadata), dedup, providers);

  it('挂载成功：handler 写下的领域事实 → 载荷新增 hints[]（actor 来自 request.user.userId）', async () => {
    const interceptor = build([makeProvider()]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect(out).toEqual({
      id: 'doc-1',
      hints: [{ code: CODE, status: 'suggestion', message: '消息:fx_code' }],
    });
    // 去重窗口按 (actor, code, resource) 落位——键里的 actor 正是 request.user.userId
    expect(dedup.isSuppressed('u-1', CODE, 'doc:d1')).toBe(true);
  });

  it('禁空数组①：候选全被去重窗口压制 → 载荷原样（hints 键不出现）', async () => {
    dedup.mark('u-1', CODE, 'doc:d1'); // 预占窗口（模拟 6h 内已送达过）
    const interceptor = build([makeProvider()]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect(out).toEqual({ id: 'doc-1' });
    expect(out as object).not.toHaveProperty('hints');
  });

  it('禁空数组②：provider 产出 0 条候选 → 载荷原样（不是空数组）', async () => {
    const interceptor = build([makeProvider({ build: async () => [] })]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect(out).toEqual({ id: 'doc-1' });
  });

  it('跳过①：response.writableEnded（controller 已手动终结）→ 原样返回', async () => {
    const provider = makeProvider({ build: jest.fn(async () => []) });
    const interceptor = build([provider]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' }, writableEnded: true }), handler),
    );

    expect(out).toEqual({ id: 'doc-1' });
    expect(provider.build).not.toHaveBeenCalled();
  });

  it('跳过②：@SkipTransform() → 原样返回（且**不建事实袋**：handler 里 emitFact 返回 false）', async () => {
    const provider = makeProvider({ build: jest.fn(async () => []) });
    const interceptor = build([provider], { skipTransform: true });
    let emitResult: boolean | undefined;
    const handler = makeHandler({ id: 'doc-1' }, () => {
      emitResult = emitFact(FACT, { docId: 'd1' });
    });

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect(out).toEqual({ id: 'doc-1' });
    expect(provider.build).not.toHaveBeenCalled();
    expect(emitResult).toBe(false);
  });

  it('跳过③：载荷非对象（数组 / 字符串）→ 原样返回', async () => {
    const provider = makeProvider({ build: jest.fn(async () => []) });
    const interceptor = build([provider]);

    for (const payload of [[1, 2, 3], 'raw-text']) {
      const handler = makeHandler(payload, () => emitFact(FACT, { docId: 'd1' }));
      const out = await firstValueFrom(
        interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
      );
      expect(out).toBe(payload);
    }
    expect(provider.build).not.toHaveBeenCalled();
  });

  it('跳过④：非 http 上下文（WS / 微服务消息）→ 直通', async () => {
    const provider = makeProvider({ build: jest.fn(async () => []) });
    const interceptor = build([provider]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ type: 'ws', user: { userId: 'u-1' } }), handler),
    );

    expect(out).toEqual({ id: 'doc-1' });
    expect(provider.build).not.toHaveBeenCalled();
  });

  it('跳过⑤：@Sse() 端点 → 直通（帧是**普通对象**，形态守卫拦不住，只能靠元数据判定）', async () => {
    const provider = makeProvider({ build: jest.fn(async () => []) });
    const interceptor = build([provider], { sse: true });
    // SSE 的一帧：Nest 侧包装成普通对象，`isPlainObjectPayload` 判它「可挂 hints」
    const frame = { data: { id: 'doc-1' }, type: 'next' };
    const handler = makeHandler(frame, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect(out).toBe(frame);
    expect(provider.build).not.toHaveBeenCalled();
  });

  it('域侧占槽（阶段三 merge）：域侧条目原样保留 + **占槽位**，provider 拿剩余预算并合并挂载', async () => {
    const buildFn = jest.fn(async () => [makeHintCandidate(CODE, 'suggestion', 'doc:d1')]);
    const interceptor = build([makeProvider({ build: buildFn })]);
    // docspace 五消费方在 service 内自己挂的 hints（本层不得改写它们）
    const domainHints = [{ code: 'empty_tags', status: 'suggestion', message: '域侧文案' }];
    const payload = { id: 'doc-1', hints: domainHints };
    const handler = makeHandler(payload, () => emitFact(FACT, { docId: 'd1' }));

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let out: unknown;
    try {
      out = await firstValueFrom(
        interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
      );

      // 域侧在前、provider 在后（顺序 = 预算的可见形态）；域侧条目**逐字保留**
      expect((out as { hints: unknown[] }).hints).toEqual([
        domainHints[0],
        { code: CODE, status: 'suggestion', message: '消息:fx_code' },
      ]);
      expect((out as { hints: unknown[] }).hints[0]).toBe(domainHints[0]);
      // ⑦ 不再是「整链直通」：provider 被求值（阶段三决策 5）
      expect(buildFn).toHaveBeenCalledTimes(1);

      // **域侧条目绝不回流 emitHints** 的直接证据：emitted 记录里只有 provider 的码，
      // 没有域侧的 `empty_tags`（若回流，域侧条目会被二次埋点、还会被去重窗口标记）
      // ⚠️ 断言必须在 finally 之前——`mockRestore()` 会连 `mock.calls` 一起清空
      const emittedCodes = warnSpy.mock.calls
        .map((call) => call[0] as string)
        .filter((line) => line.startsWith('{'))
        .map((line) => (JSON.parse(line) as { code: string }).code);
      expect(emittedCodes).toEqual([CODE]);
      expect(emittedCodes).not.toContain('empty_tags');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('域侧占满 ≥3 槽位（budget=0）：**仍求值**（观测域侧挤占），载荷逐字保留且落 slot_truncated', async () => {
    const buildFn = jest.fn(async () => [makeHintCandidate(CODE, 'suggestion', 'doc:d1')]);
    const interceptor = build([makeProvider({ build: buildFn })]);
    const domainHints = [
      { code: 'empty_tags', status: 'suggestion', message: '域侧 1' },
      { code: 'missing_category', status: 'suggestion', message: '域侧 2' },
      { code: 'empty_summary', status: 'suggestion', message: '域侧 3' },
    ];
    const payload = { id: 'doc-1', hints: domainHints };
    const handler = makeHandler(payload, () => emitFact(FACT, { docId: 'd1' }));

    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    try {
      const out = await firstValueFrom(
        interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
      );

      // 预算 0 ⇒ 无 provider 存活项 → 载荷原样（域侧三条一字不改）
      expect(out).toBe(payload);
      expect(buildFn).toHaveBeenCalledTimes(1);
      const slotLines = debugSpy.mock.calls
        .map((call) => call[0] as string)
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.reason === 'slot_truncated');
      expect(slotLines).toHaveLength(1);
      expect(slotLines[0]).toMatchObject({ code: CODE, surface: 'fixture_surface' });
    } finally {
      // mockRestore 会连 mock.calls 一起清空 ⇒ 断言必须在 restore **之前**完成
      debugSpy.mockRestore();
    }
  });

  it('多 provider 合并求值（「首个胜出」退役）：前一个被压制也**让后一个补位**', async () => {
    dedup.mark('u-1', CODE, 'doc:d1'); // 预占窗口 → provider#1 的候选必被压制
    const secondBuild = jest.fn(async () => [makeHintCandidate(CODE2, 'suggestion', 'doc:other')]);
    const interceptor = build([
      makeProvider(),
      makeProvider({ priority: [CODE2], build: secondBuild }),
    ]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    // provider#1 被窗口压制（不占名额），provider#2 的候选正常送达——合并求值的意义所在
    expect((out as { hints?: unknown[] }).hints).toEqual([
      { code: CODE2, status: 'suggestion', message: '消息:fx_code_2' },
    ]);
    expect(secondBuild).toHaveBeenCalledTimes(1);
  });

  it('快路径：无 provider（零装配态）→ 不建袋、不求值，handler 照常返回', async () => {
    const interceptor = build([]);
    let emitResult: boolean | undefined;
    const handler = makeHandler({ id: 'doc-1' }, () => {
      emitResult = emitFact(FACT, { docId: 'd1' });
    });

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect(out).toEqual({ id: 'doc-1' });
    expect(emitResult).toBe(false); // 未建立事实袋 ⇒ 领域侧 emitFact 是 no-op
  });

  it('无事实：本次请求没人 emitFact → provider 求值完全跳过', async () => {
    const provider = makeProvider({ build: jest.fn(async () => []) });
    const interceptor = build([provider]);
    const handler = makeHandler({ id: 'doc-1' }); // 不 emit

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect(out).toEqual({ id: 'doc-1' });
    expect(provider.build).not.toHaveBeenCalled();
  });

  it('provider 抛错 → fail-open：主响应原样返回（不挂 hints、不冒泡异常）', async () => {
    const provider = makeProvider({
      build: () => {
        throw new Error('provider 炸了');
      },
    });
    const interceptor = build([provider]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect(out).toEqual({ id: 'doc-1' });
  });

  it('多 provider 候选**并集单次 finalize**：两个 provider 都求值，同一 envelope 收全部候选', async () => {
    const secondBuild = jest.fn(async () => [makeHintCandidate(CODE2, 'suggestion', 'doc:d1')]);
    const interceptor = build([
      makeProvider(),
      makeProvider({ priority: [CODE2], build: secondBuild }),
    ]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    // 两条候选（不同 code）同属一个信封——不是「各拼一个信封」（叠信封会破坏
    // 「只有存活项被标记」不变量）
    expect((out as { hints?: unknown[] }).hints).toHaveLength(2);
    expect(secondBuild).toHaveBeenCalledTimes(1);
  });

  it('合并 profile：埋点 surface 逐候选解析（同响应两条候选来自不同 provider）', async () => {
    const interceptor = build([
      makeProvider(),
      makeProvider({
        surface: 'fixture_surface_2',
        priority: [CODE2],
        build: jest.fn(async () => [makeHintCandidate(CODE2, 'suggestion', 'doc:d1')]),
      }),
    ]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await firstValueFrom(
        interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
      );

      // 只取 JSONL 埋点行（同 logger 上还有拦截器自己的 `[HINT_INTERCEPTOR_*]` 文本告警）
      const surfaces = warnSpy.mock.calls
        .map((call) => call[0] as string)
        .filter((line) => line.startsWith('{'))
        .map((line) => (JSON.parse(line) as { surface: string }).surface);
      expect(surfaces).toEqual(['fixture_surface', 'fixture_surface_2']);
    } finally {
      // mockRestore 会连 mock.calls 一起清空 ⇒ 断言必须在 restore **之前**完成
      warnSpy.mockRestore();
    }
  });

  it('provider.build 收到请求身份（ctx.actor 透传；未认证 ⇒ actor=null）', async () => {
    const buildFn = jest.fn(async () => [] as readonly HintCandidate[]);
    const interceptor = build([makeProvider({ build: buildFn })]);

    await firstValueFrom(
      interceptor.intercept(
        makeContext({ agent: { id: 'agent-9' } }),
        makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' })),
      ),
    );
    expect(buildFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ actor: expect.objectContaining({ id: 'agent-9' }) }),
    );

    buildFn.mockClear();
    // 无认证请求（无 user / agent）⇒ actor = null（provider 必须 fail-closed）
    await firstValueFrom(
      interceptor.intercept(
        makeContext(),
        makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' })),
      ),
    );
    expect(buildFn).toHaveBeenCalledWith(expect.anything(), expect.anything(), { actor: null });
  });

  it('跨请求窗口：同键第二次请求被压制（同一份去重窗口）', async () => {
    const interceptor = build([makeProvider()]);
    const call = () =>
      firstValueFrom(
        interceptor.intercept(
          makeContext({ user: { userId: 'u-1' } }),
          makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' })),
        ),
      );

    expect((await call()) as { hints?: unknown[] }).toHaveProperty('hints');
    // 第二次：命中 6h 窗口 → 不挂 hints（键不出现）
    const second = await call();
    expect(second).toEqual({ id: 'doc-1' });
  });

  it('async 契约：provider 延迟 resolve 时，载荷里是**已解析的 hints**（不是 Promise）', async () => {
    const provider = makeProvider({
      build: async (facts) => {
        await new Promise((resolve) => setImmediate(resolve));
        return facts.map((fact) =>
          makeHintCandidate(CODE, 'suggestion', `doc:${String(fact.payload?.docId)}`),
        );
      },
    });
    const interceptor = build([provider]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    // 失效形态（`map` 时代）：out 会是**未 await 的 Promise**（响应体序列化成 `{}`）
    expect(out).not.toBeInstanceOf(Promise);
    expect((out as { hints?: unknown[] }).hints).toHaveLength(1);
  });

  it('async provider reject → fail-open：主响应直通、无 hints、异常不冒泡（await-aware 回归锁）', async () => {
    const provider = makeProvider({
      build: async () => {
        throw new Error('provider 异步炸了');
      },
    });
    const interceptor = build([provider]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect(out).toEqual({ id: 'doc-1' });
    expect(out as object).not.toHaveProperty('hints');
  });

  it('内层 fail-open：首个 provider reject 后，后续 provider 仍有机会（不是整层放弃）', async () => {
    const first = makeProvider({
      build: async () => {
        throw new Error('第一个挂了');
      },
    });
    const secondBuild = jest.fn(async () => [
      makeHintCandidate(CODE, 'suggestion', 'doc:from-second'),
    ]);
    const second = makeProvider({ build: secondBuild });
    const interceptor = build([first, second]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    const out = await firstValueFrom(
      interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler),
    );

    expect((out as { hints?: unknown[] }).hints).toHaveLength(1);
    expect(secondBuild).toHaveBeenCalled();
  });

  it('profile.ttlOf 透传：provider 挂了钩子 → emitHints 两处都收到它声明的窗口（24h）', async () => {
    const day = 24 * 60 * 60 * 1000;
    const isSuppressed = jest.spyOn(dedup, 'isSuppressed');
    const mark = jest.spyOn(dedup, 'mark');
    const provider = makeProvider({ ttlOf: () => day });
    const interceptor = build([provider]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    await firstValueFrom(interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler));

    expect(isSuppressed).toHaveBeenCalledWith('u-1', CODE, 'doc:d1', day);
    expect(mark).toHaveBeenCalledWith('u-1', CODE, 'doc:d1', day);
  });

  it('profile.ttlOf 缺省：provider 无该钩子 → 两处都收到 undefined（与阶段一行为逐字一致）', async () => {
    const isSuppressed = jest.spyOn(dedup, 'isSuppressed');
    const mark = jest.spyOn(dedup, 'mark');
    const interceptor = build([makeProvider()]);
    const handler = makeHandler({ id: 'doc-1' }, () => emitFact(FACT, { docId: 'd1' }));

    await firstValueFrom(interceptor.intercept(makeContext({ user: { userId: 'u-1' } }), handler));

    expect(isSuppressed).toHaveBeenCalledWith('u-1', CODE, 'doc:d1', undefined);
    expect(mark).toHaveBeenCalledWith('u-1', CODE, 'doc:d1', undefined);
  });
});

/**
 * 真实 Nest 装配（**端到端挂载的权威验证**）：跑一条真 `APP_INTERCEPTOR` 链 + fixture
 * controller，证明「service 在请求处理中 emitFact → 响应信封 data 里出现 hints」在真框架
 * （真 InterceptorsConsumer + 真 ResponseInterceptor + 真 HTTP）里成立。
 *
 * ⚠️ **本段不论证 ALS run 边界**：那是框架内部实现的性质，不是本套件可判别的——
 * Nest 10 的 `handle()` 是 `defer(AsyncResource.bind(() => nextFn(i + 1))).pipe(mergeAll())`
 * （@nestjs/core@10.4.22 interceptors-consumer.js:21），`AsyncResource.bind` 在 `handle()`
 * **被调用**时即捕获 async 上下文，故「run 只包 next.handle()」与「run 内 subscribe」
 * 两种形态都能让 handler 读到 store（同构探针 + 本段实测；无 run 的对照组为空）。
 * 换句话说：把实现改回任一形态，本段**照样绿**——它证明的是链路与信封，不是边界形态。
 */
describe('HintInterceptor（真实 Nest 装配：端到端挂载 + 信封）', () => {
  @Controller('hint-fixture')
  class FixtureController {
    /** 复刻真实 service 形态：**await 之后**才写事实（与真 controller 的写法同形） */
    @Get()
    async read(): Promise<{ id: string }> {
      await new Promise((resolve) => setImmediate(resolve));
      emitFact(FACT, { docId: 'd1' });
      return { id: 'doc-1' };
    }
  }

  let app: INestApplication;
  let dedup: HintDedupService;

  beforeAll(async () => {
    dedup = new HintDedupService();
    const moduleRef = await Test.createTestingModule({
      controllers: [FixtureController],
      providers: [
        { provide: HintDedupService, useValue: dedup },
        { provide: HINT_FACT_PROVIDERS, useValue: [makeProvider()] },
        // 与 app.module 同序：信封拦截器在外、hint 拦截器在最内
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_INTERCEPTOR, useClass: HintInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('真框架链路：controller 里 emitFact 的事实 → 信封 data.hints 挂载成功', async () => {
    const res = await request(app.getHttpServer()).get('/hint-fixture').expect(200);

    // 外层信封结构照旧（ResponseInterceptor 未受影响）
    expect(Object.keys(res.body)).toEqual(
      expect.arrayContaining(['code', 'message', 'data', 'timestamp', 'requestId']),
    );
    expect(res.body.data).toEqual({
      id: 'doc-1',
      hints: [{ code: CODE, status: 'suggestion', message: '消息:fx_code' }],
    });
    // 窗口按真实请求解析出的 actor 落位（本测试模块未挂 guard ⇒ 无 user/agent ⇒ 'system'）
    expect(dedup.isSuppressed('system', CODE, 'doc:d1')).toBe(true);
  });

  it('同键第二次请求：真框架下同样命中窗口 → data 里不出现 hints 键（禁空数组）', async () => {
    const res = await request(app.getHttpServer()).get('/hint-fixture').expect(200);
    expect(res.body.data).toEqual({ id: 'doc-1' });
    expect(res.body.data).not.toHaveProperty('hints');
  });
});
