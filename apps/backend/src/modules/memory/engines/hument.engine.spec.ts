/**
 * `hument.engine` 单测（六端点 + 固定 header + 错误体解析 + never-throw 联合）。
 *
 * 设计意图：本层是 Chamber 与 Hub 之间**唯一的联网点**，四件事必须钉死：
 * ① **固定 header 清单**（`Content-Type` 逐字 / 幂等键按路由规则 / 凭据头 / **诊断头双路由**）——
 *    漏发诊断头 ⇒ §7 的 outcome 轴整体降级（`no_change_validated` 会被记成 committed）；
 * ② **请求体纪律**（`temporal_context` 不发、`scopes` 缺省、`mode:"manual"` 定死、
 *    `context_identity`/`context_epoch` 由调用方传入）；
 * ③ **错误体解析不丢**（`error.code` / `retryable` / `request_id` 三个标量必须落到 failure 上，
 *    §7 的三族分派全靠它），但**不搬运错误体原文**；
 * ④ **never-throw 联合**：fetch 抛错 / 超时 / 非 2xx / 体破损各自落到固定分类，绝不抛异常。
 */
import { Logger } from '@nestjs/common';
import {
  HUMENT_DIAGNOSTICS_HEADER,
  HUMENT_DIAGNOSTICS_VALUE,
  HUMENT_HEALTH_TIMEOUT_MS,
  HUMENT_IDEMPOTENCY_HEADER,
  HUMENT_ROUTES,
  HumentEngine,
  buildCorrectionIdempotencyKey,
  buildNominationIdempotencyKey,
  isHumentTimeoutError,
  parseHumentErrorEnvelope,
  type HumentEngineSettings,
} from './hument.engine';
import type { MemoryEngineTarget } from './memory-engine.interface';

/** 调用目标（workspace/actor/credential 全部来自注册表；引擎不派生） */
const TARGET: MemoryEngineTarget = {
  workspaceId: 'ws-1',
  actorId: 'actor-1',
  credentialRef: 'cred-ref-1',
};

/** 引擎设置（尾斜杠刻意留着——测端点规整） */
const SETTINGS: HumentEngineSettings = { baseUrl: 'http://hub.local:8099/', timeoutMs: 90000 };

/** 造一个 fetch 响应替身（只需 ok/status/headers/text 四项） */
function fakeResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; rawText?: string } = {},
): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    text: async () => (init.rawText !== undefined ? init.rawText : JSON.stringify(body)),
  } as unknown as Response;
}

/** 造一个"读取 body 时抛错"的响应（body 读阶段超时的模拟） */
function bodyThrowingResponse(error: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({}),
    text: async () => Promise.reject(error),
  } as unknown as Response;
}

describe('HumentEngine', () => {
  const ORIGINAL_FETCH = global.fetch;
  let fetchMock: jest.Mock;

  /** 装配一个 mock fetch（返回值或抛错）并返回引擎 */
  function engineWith(response: Response | Error, settings: HumentEngineSettings = SETTINGS) {
    fetchMock = jest.fn();
    if (response instanceof Error) fetchMock.mockRejectedValue(response);
    else fetchMock.mockResolvedValue(response);
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    return new HumentEngine(settings);
  }

  /** 取第 n 次调用（默认第 0 次）的 URL 与请求初始化 */
  function callAt(index = 0): { url: string; init: RequestInit; headers: Headers; body: Record<string, unknown> } {
    const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
    return {
      url,
      init,
      headers: new Headers(init.headers),
      // GET 无 body（`init.body` 是 undefined；JSON.parse(undefined) 会抛）
      body: init.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>),
    };
  }

  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  });

  it('路由表逐条对齐 Hument 合同（六写/读端点 + 五读面）', () => {
    expect(HUMENT_ROUTES).toEqual({
      nominations: '/v1/memory/nominations',
      nominationsInspect: '/v1/memory/nominations/inspect',
      memoryInspect: '/v1/memory/inspect',
      recalls: '/v1/recalls',
      corrections: '/v1/memory-corrections',
      correctionsInspect: '/v1/memory-corrections/inspect',
      memoryViewsGraph: '/v1/memory-views/graph',
      // 带路径参数的四条是**函数**：引擎 id 不是 UUID，不能假定它是 URL 安全的字面量
      memoryViewsDetail: expect.any(Function),
      memoryViewsHistory: expect.any(Function),
      memoryViewsRepresentation: expect.any(Function),
      memoryRelations: expect.any(Function),
      // alpha.19 usage 读面（GET；只读；summary 无分页、trace 有 limit/cursor）
      usageSummary: '/v1/usage/summary',
      usageTrace: '/v1/usage/trace',
      // 就绪探测（免鉴权、无 query）——运行时健康告警的脉搏
      healthReady: '/v1/health/ready',
    });

    expect(HUMENT_ROUTES.memoryViewsDetail('mem-1')).toBe('/v1/memory-views/memories/mem-1');
    expect(HUMENT_ROUTES.memoryViewsHistory('mem-1', 'R2')).toBe(
      '/v1/memory-views/memories/mem-1/history/R2',
    );
    expect(HUMENT_ROUTES.memoryViewsRepresentation('mem-1', 'repr-1')).toBe(
      '/v1/memory-views/memories/mem-1/representations/repr-1',
    );
    // ⚠️ 关系建议**不在** /v1/memory-views/ 前缀下（合同与 `/v1/memories/{id}/sources` 同族）；
    //    照 memory-views 前缀拼会 404——这条断言就是防"顺手归族"。
    expect(HUMENT_ROUTES.memoryRelations('mem-1')).toBe('/v1/memories/mem-1/relations');
    // 路径参数必须转义（裸斜杠会把一条路径拼成两条）
    expect(HUMENT_ROUTES.memoryViewsHistory('a/b', 'R2')).toBe(
      '/v1/memory-views/memories/a%2Fb/history/R2',
    );
    expect(HUMENT_ROUTES.memoryRelations('a/b')).toBe('/v1/memories/a%2Fb/relations');
  });

  it('幂等键构造规则（方案 §3 定死）', () => {
    expect(buildNominationIdempotencyKey('led-1')).toBe('chamber-led-1');
    expect(buildCorrectionIdempotencyKey('led-2')).toBe('chamber-correct-led-2');
  });

  /**
   * 就绪探测（卡 26c43f52）：`GET /v1/health/ready`，**免鉴权**、5s 短超时、
   * 2xx 但体不满足 ready 合同 ⇒ `invalid_response`（对齐 hument 自家探活 malformed=失败）。
   */
  describe('healthCheck（ready 合同 + 免鉴权 + 短超时）', () => {
    /** hument 合同的 200 体（`contracts/schema/health-ready.schema.json`） */
    const READY_BODY = {
      status: 'ready',
      service: 'hument',
      version: '0.1.0-dev',
      contract_version: 'hument-runtime-0.1',
      degraded_cells: [] as string[],
    };

    it('合同齐备 ⇒ ok（GET、无凭据头、无 Content-Type、无幂等键，**5s 短超时真实生效**）', async () => {
      // ⚠️ 回退守卫（卡 2 评审 m2）：断言 `AbortSignal.timeout` 的**入参**——
      // 若 healthCheck 丢掉 `timeoutMs: HUMENT_HEALTH_TIMEOUT_MS`，这里会收到业务硬顶（90000）⇒ 红。
      // （只断言"signal 存在"没有判别力：requestJson 永远会建一个 signal。）
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      try {
        const engine = engineWith(fakeResponse(READY_BODY));
        const result = await engine.healthCheck();

        expect(result).toEqual({ ok: true, value: undefined });

        const { url, init, headers } = callAt();
        expect(url).toBe('http://hub.local:8099/v1/health/ready');
        expect(init.method).toBe('GET');
        // **免鉴权**：探针不带凭据引用（带上 = 把健康探测变成凭据使用事件）
        expect(headers.get(HUMENT_DIAGNOSTICS_HEADER)).toBeNull();
        expect(headers.get('X-Hument-Credential-Ref')).toBeNull();
        expect(headers.get(HUMENT_IDEMPOTENCY_HEADER)).toBeNull();
        expect(headers.get('Content-Type')).toBeNull();

        // 探针的短超时（≠ 业务硬顶 90000）：探针不得拖满一个 120s 的 cron 周期
        expect(HUMENT_HEALTH_TIMEOUT_MS).toBe(5000);
        expect(timeoutSpy).toHaveBeenCalledWith(HUMENT_HEALTH_TIMEOUT_MS);
        // redirect:'error' 继承（防带凭据头的请求被 307/308 重放到第三方）
        expect(init.redirect).toBe('error');
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it('`degraded_cells` 非空仍算 ready（降级单元是引擎自报事实，不是不可用）', async () => {
      const engine = engineWith(
        fakeResponse({ ...READY_BODY, degraded_cells: ['workspace-a'] }),
      );
      expect(await engine.healthCheck()).toEqual({ ok: true, value: undefined });
    });

    it('2xx 但合同破损（status 非 ready / 缺 required / contract_version 不匹配）⇒ invalid_response', async () => {
      const brokenBodies = [
        { ...READY_BODY, status: 'degraded' },
        // 缺 service
        { status: 'ready', version: '1', contract_version: 'hument-runtime-0.1', degraded_cells: [] },
        // contract_version 漂移（版本错配 = 不该假装健康）
        { ...READY_BODY, contract_version: 'hument-runtime-0.2' },
        // degraded_cells 类型不对
        { ...READY_BODY, degraded_cells: 'none' },
        // 空体 / 非 JSON
        {},
      ];

      for (const body of brokenBodies) {
        const engine = engineWith(fakeResponse(body));
        const result = await engine.healthCheck();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure.kind).toBe('invalid_response');
          expect(result.failure.httpStatus).toBeUndefined();
        }
      }
    });

    it('存储不可用 ⇒ 503 `cell_unavailable` 落 http 失败（探针据此判失败）', async () => {
      const engine = engineWith(
        fakeResponse(
          {
            error: {
              code: 'cell_unavailable',
              message: 'cell storage is unavailable',
              request_id: 'req-1',
              retryable: true,
            },
          },
          { status: 503 },
        ),
      );

      const result = await engine.healthCheck();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('http');
        expect(result.failure.httpStatus).toBe(503);
        expect(result.failure.engineCode).toBe('cell_unavailable');
      }
    });

    it('连接失败 / 超时 ⇒ unreachable / timeout（分类学与业务动词同源）', async () => {
      const unreachable = await engineWith(new TypeError('fetch failed')).healthCheck();
      expect(unreachable.ok).toBe(false);
      if (!unreachable.ok) expect(unreachable.failure.kind).toBe('unreachable');

      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      const timedOut = await engineWith(timeoutErr).healthCheck();
      expect(timedOut.ok).toBe(false);
      if (!timedOut.ok) expect(timedOut.failure.kind).toBe('timeout');
    });
  });

  describe('nominate（固定 header + 请求体纪律）', () => {
    const ENGINE_RESPONSE = {
      schema_version: 'hument-memory-nomination-response-v1',
      nomination_id: 'nom-1',
      event_id: 'evt-1',
      boundary_id: 'bnd-1',
      boundary_kind: 'explicit_flush',
      origin: 'agent_nomination',
      job_id: 'job-1',
      durable: true,
      accepted: true,
      replay: false,
      duplicate: false,
      job_state: 'committed',
      deferred: false,
      source_locators: [],
      source_state: 'unverified',
      content_digest: 'a'.repeat(64),
      diagnostics: {
        schema_version: 'hument-nomination-diagnostics-v1',
        outcome: 'memory_committed',
        reason_code: 'memory_materialized',
        mutation: { mutation_id: 'mut-1', journal_id: 'jrn-1', memory_id: 'mem-1', memory_ids: ['mem-1', 'mem-2'] },
      },
    };

    it('固定 header 四件套 + 端点尾斜杠规整 + Content-Type 逐字', async () => {
      const engine = engineWith(fakeResponse(ENGINE_RESPONSE));
      await engine.nominate(TARGET, {
        ledgerId: 'led-1',
        category: 'ruling',
        content: '[ruling] X',
        rationale: '因为',
        sourceLocators: ['chamber://doc/abc'],
      });

      const { url, init, headers } = callAt();
      expect(url).toBe('http://hub.local:8099/v1/memory/nominations');
      expect(init.method).toBe('POST');
      // 「逐字」：加 charset 等后缀在部分网关会变成不匹配
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get(HUMENT_IDEMPOTENCY_HEADER)).toBe('chamber-led-1');
      expect(headers.get('X-Hument-Credential-Ref')).toBe('cred-ref-1');
      expect(headers.get(HUMENT_DIAGNOSTICS_HEADER)).toBe(HUMENT_DIAGNOSTICS_VALUE);
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('请求体：schema_version/intent 逐字 + **temporal_context 缺席**', async () => {
      const engine = engineWith(fakeResponse(ENGINE_RESPONSE));
      await engine.nominate(TARGET, {
        ledgerId: 'led-1',
        category: 'ruling',
        content: 'body',
        rationale: 'why',
        sourceLocators: ['chamber://task/t1'],
      });

      expect(callAt().body).toEqual({
        schema_version: 'hument-memory-nomination-v1',
        workspace_id: 'ws-1',
        actor_id: 'actor-1',
        intent: 'remember',
        category: 'ruling',
        content: 'body',
        rationale: 'why',
        source_locators: ['chamber://task/t1'],
      });
      // 方案 §3：一期不发送（Chamber 无可信时间上下文来源）
      expect(Object.keys(callAt().body)).not.toContain('temporal_context');
    });

    it('纯著述（无来源）→ 不发 source_locators 键', async () => {
      const engine = engineWith(fakeResponse(ENGINE_RESPONSE));
      await engine.nominate(TARGET, {
        ledgerId: 'led-1',
        category: 'ruling',
        content: 'body',
        rationale: 'why',
        sourceLocators: [],
      });
      expect(Object.keys(callAt().body)).not.toContain('source_locators');
    });

    it('归一化：diagnostics → outcome/reasonCode/memoryIds（含多个 memory）', async () => {
      const engine = engineWith(fakeResponse(ENGINE_RESPONSE));
      const result = await engine.nominate(TARGET, {
        ledgerId: 'led-1',
        category: 'ruling',
        content: 'body',
        rationale: 'why',
        sourceLocators: [],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toEqual({
        engineNominationId: 'nom-1',
        canonicalNominationId: undefined,
        duplicate: false,
        jobState: 'committed',
        deferred: false,
        outcome: 'memory_committed',
        reasonCode: 'memory_materialized',
        memoryIds: ['mem-1', 'mem-2'],
        retryable: undefined,
        engineCode: undefined,
        requestId: undefined,
        durable: true,
      });
    });

    it('退化路径：无 diagnostics（缺 header 的后果）→ outcome/reasonCode 缺席，ids 回退 memory_id', async () => {
      const engine = engineWith(
        fakeResponse({ ...ENGINE_RESPONSE, diagnostics: undefined, memory_id: 'mem-solo' }),
      );
      const result = await engine.nominate(TARGET, {
        ledgerId: 'led-1',
        category: 'ruling',
        content: 'body',
        rationale: 'why',
        sourceLocators: [],
      });
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.outcome).toBeUndefined();
      expect(result.value.reasonCode).toBeUndefined();
      expect(result.value.memoryIds).toEqual(['mem-solo']);
    });

    it('alias 回执：duplicate=true + canonical_nomination_id 归一化', async () => {
      const engine = engineWith(
        fakeResponse({
          ...ENGINE_RESPONSE,
          duplicate: true,
          canonical_nomination_id: 'nom-canon',
          memory_id: undefined,
        }),
      );
      const result = await engine.nominate(TARGET, {
        ledgerId: 'led-1',
        category: 'ruling',
        content: 'body',
        rationale: 'why',
        sourceLocators: [],
      });
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.duplicate).toBe(true);
      expect(result.value.canonicalNominationId).toBe('nom-canon');
    });
  });

  describe('inspectNomination（**只读**：诊断头在、幂等键不在）', () => {
    const INSPECT_RESPONSE = {
      schema_version: 'hument-memory-nomination-inspect-response-v1',
      nomination_id: 'nom-1',
      event_id: 'evt-1',
      boundary_id: 'bnd-1',
      boundary_kind: 'explicit_flush',
      origin: 'agent_nomination',
      job_id: 'job-1',
      durable: true,
      accepted: true,
      replay: true,
      duplicate: false,
      job_state: 'committing',
      deferred: false,
      source_locators: [],
      source_state: 'unverified',
      content_digest: 'b'.repeat(64),
      redaction: 'nomination-inspect-v1',
      diagnostics: {
        schema_version: 'hument-nomination-diagnostics-v1',
        outcome: 'deferred',
        reason_code: 'formation_pending',
        mutation: { mutation_id: 'm', journal_id: 'j', memory_id: 'mem-1', memory_ids: ['mem-1'] },
      },
    };

    it('诊断头**固定发送**且无幂等键（inspect 不推进 job）', async () => {
      const engine = engineWith(fakeResponse(INSPECT_RESPONSE));
      await engine.inspectNomination(TARGET, { nominationId: 'nom-1' });

      const { url, init, headers, body } = callAt();
      expect(url).toBe('http://hub.local:8099/v1/memory/nominations/inspect');
      expect(init.method).toBe('POST');
      expect(headers.get(HUMENT_DIAGNOSTICS_HEADER)).toBe('v1');
      expect(headers.get(HUMENT_IDEMPOTENCY_HEADER)).toBeNull();
      expect(body).toEqual({
        schema_version: 'hument-memory-nomination-inspect-v1',
        workspace_id: 'ws-1',
        actor_id: 'actor-1',
        nomination_id: 'nom-1',
      });
      expect(Object.keys(body)).not.toContain('memory_id');
    });

    it('按 memoryId 查询 → 只发 memory_id（二选一，合同 oneOf）', async () => {
      const engine = engineWith(fakeResponse(INSPECT_RESPONSE));
      await engine.inspectNomination(TARGET, { memoryId: 'mem-1' });

      const { body } = callAt();
      expect(body.memory_id).toBe('mem-1');
      expect(Object.keys(body)).not.toContain('nomination_id');
    });
  });

  describe('recall（mode=manual / scopes 缺省 / 预算透传 / 幂等键每次新 uuid）', () => {
    const RECALL_RESPONSE = {
      recall_id: 'rec-1',
      query_digest: 'd'.repeat(64),
      context_identity: 'ctx',
      context_epoch: 3,
      mode: 'manual',
      replay: false,
      presentation_event_id: 'pres-1',
      items: [],
      trace: {
        policy_version: 'f3.deterministic.v1',
        query_digest: 'd'.repeat(64),
        binding_id: 'bnd-1',
        presentation_event_id: 'pres-1',
        source_scopes: [],
        home_cell_id: 'cell-1',
        coordinator_scope: 'workspace_shared',
        watermarks: [],
        candidates: [],
        suppressed_item_ids: [],
        selected_item_ids: [],
        budget: {},
        provider_calls: 0,
        presentation_pending: false,
      },
    };

    it('请求体：mode=manual + scopes 缺省 + 上下文由调用方传入 + 预算三参透传', async () => {
      const engine = engineWith(fakeResponse(RECALL_RESPONSE));
      await engine.recall(TARGET, {
        query: '裁决',
        view: 'current',
        maxItems: 5,
        maxTokens: 1024,
        maxBytes: 4096,
        contextIdentity: 'ctx-1',
        contextEpoch: 7,
      });

      const { url, body } = callAt();
      expect(url).toBe('http://hub.local:8099/v1/recalls');
      expect(body).toEqual({
        workspace_id: 'ws-1',
        actor_id: 'actor-1',
        query: '裁决',
        context_identity: 'ctx-1',
        context_epoch: 7,
        mode: 'manual',
        view: 'current',
        max_items: 5,
        max_tokens: 1024,
        max_bytes: 4096,
      });
      // scopes 缺省（作用域由 Hument 侧绑定策略决定）+ temporal_context 一期不发
      expect(Object.keys(body)).not.toContain('scopes');
      expect(Object.keys(body)).not.toContain('temporal_context');
    });

    it('未给的 view/预算键一律不发（不是发 null）', async () => {
      const engine = engineWith(fakeResponse(RECALL_RESPONSE));
      await engine.recall(TARGET, { query: 'q', contextIdentity: 'c', contextEpoch: 0 });

      const { body } = callAt();
      for (const key of ['view', 'max_items', 'max_tokens', 'max_bytes']) {
        expect(Object.keys(body)).not.toContain(key);
      }
    });

    it('幂等键 = 每次新 uuid（召回是呈现动作，不是幂等动作）', async () => {
      const engine = engineWith(fakeResponse(RECALL_RESPONSE));
      await engine.recall(TARGET, { query: 'q1', contextIdentity: 'c', contextEpoch: 0 });
      await engine.recall(TARGET, { query: 'q2', contextIdentity: 'c', contextEpoch: 1 });

      const first = callAt(0).headers.get(HUMENT_IDEMPOTENCY_HEADER);
      const second = callAt(1).headers.get(HUMENT_IDEMPOTENCY_HEADER);
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(first).toMatch(UUID_RE);
      expect(second).toMatch(UUID_RE);
      expect(first).not.toBe(second);
    });

    it('归一化：recallId / presentationEventId / items / trace 原样透传', async () => {
      const engine = engineWith(fakeResponse(RECALL_RESPONSE));
      const result = await engine.recall(TARGET, { query: 'q', contextIdentity: 'c', contextEpoch: 0 });
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.recallId).toBe('rec-1');
      expect(result.value.presentationEventId).toBe('pres-1');
      expect(result.value.items).toEqual([]);
      expect(result.value.trace.policy_version).toBe('f3.deterministic.v1');
    });

    it('items 非空 ⇒ 逐字段原样透传（含 score；snake_case 一律不改名）', async () => {
      // 本用例补的空白：`RECALL_RESPONSE.items` 恒 `[]` ⇒ 引擎层的 **item 透传**从未被验证过
      // （顶层归一化测了，条目镜像没有）。score 在这里必须是引擎原值——若有人"顺手归一化"
      // （改名 / 改名后的值转换），本断言当场红。
      const item = {
        memory_id: 'mem-1',
        namespace_id: 'ns-1',
        representation_id: 'rep-1',
        kind: 'concept',
        scope: 'workspace_shared',
        resolution: 'R2',
        available_resolution: 'R2',
        active_resolution: 'R2',
        body: '正文',
        digest: 'd'.repeat(64),
        score: 42,
        byte_estimate: 10,
        token_estimate: 3,
        anchor_state: 'none',
        current: true,
        memory_status: 'active',
        currentness_digest: 'd'.repeat(64),
        anchor_projection_digest: 'd'.repeat(64),
        anchors: [],
      };

      const engine = engineWith(fakeResponse({ ...RECALL_RESPONSE, items: [item] }));
      const result = await engine.recall(TARGET, {
        query: 'q',
        contextIdentity: 'c',
        contextEpoch: 0,
      });
      if (!result.ok) throw new Error('unreachable');

      expect(result.value.items).toEqual([item]);
      expect(result.value.items[0].score).toBe(42);
    });
  });

  describe('correct / inspectCorrection', () => {
    const CORRECTION_RESPONSE = {
      schema_version: 'hument-memory-correction-response-v1',
      correction_id: 'corr-1',
      old_memory_id: 'mem-old',
      new_memory_id: 'mem-new',
      relation_id: 'rel-1',
      request_digest: 'e'.repeat(64),
      source_state: 'author_reported',
      mutation: {
        mutation_id: 'm',
        proposal_id: 'p',
        journal_id: 'j',
        effect_digest: 'f'.repeat(64),
        replay: false,
      },
      replay: false,
    };

    it('更正：幂等键 = chamber-correct-<新账本id> + rationale 冻结原文', async () => {
      const engine = engineWith(fakeResponse(CORRECTION_RESPONSE));
      await engine.correct(TARGET, {
        newLedgerId: 'led-new',
        oldMemoryId: 'mem-old',
        newMemoryId: 'mem-new',
        rationale: '旧主张被新裁决取代',
      });

      const { url, headers, body } = callAt();
      expect(url).toBe('http://hub.local:8099/v1/memory-corrections');
      expect(headers.get(HUMENT_IDEMPOTENCY_HEADER)).toBe('chamber-correct-led-new');
      expect(body).toEqual({
        workspace_id: 'ws-1',
        actor_id: 'actor-1',
        old_memory_id: 'mem-old',
        new_memory_id: 'mem-new',
        rationale: '旧主张被新裁决取代',
      });
    });

    it('空理由不发 rationale（合同里它是可选）', async () => {
      const engine = engineWith(fakeResponse(CORRECTION_RESPONSE));
      await engine.correct(TARGET, {
        newLedgerId: 'led-new',
        oldMemoryId: 'o',
        newMemoryId: 'n',
        rationale: '',
      });
      expect(Object.keys(callAt().body)).not.toContain('rationale');
    });

    it('更正归一化：correction_id / 旧新 id / replay', async () => {
      const engine = engineWith(fakeResponse({ ...CORRECTION_RESPONSE, replay: true }));
      const result = await engine.correct(TARGET, {
        newLedgerId: 'led-new',
        oldMemoryId: 'mem-old',
        newMemoryId: 'mem-new',
        rationale: 'r',
      });
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toEqual({
        engineCorrectionId: 'corr-1',
        oldMemoryId: 'mem-old',
        newMemoryId: 'mem-new',
        replay: true,
      });
    });

    it('更正 inspect：按 correctionId 或幂等键二选一（且不带幂等 header）', async () => {
      const engine = engineWith(fakeResponse(CORRECTION_RESPONSE));
      await engine.inspectCorrection(TARGET, { correctionId: 'corr-1' });
      const byId = callAt(0);
      expect(byId.url).toBe('http://hub.local:8099/v1/memory-corrections/inspect');
      expect(byId.body.correction_id).toBe('corr-1');
      expect(Object.keys(byId.body)).not.toContain('idempotency_key');
      expect(byId.headers.get(HUMENT_IDEMPOTENCY_HEADER)).toBeNull();

      await engine.inspectCorrection(TARGET, { idempotencyKey: 'chamber-correct-led-new' });
      const byKey = callAt(1);
      expect(byKey.body.idempotency_key).toBe('chamber-correct-led-new');
      expect(Object.keys(byKey.body)).not.toContain('correction_id');
    });
  });

  describe('readMemory（**零副作用**：无幂等键、无诊断头；响应拍平）', () => {
    const READ_RESPONSE = {
      memory: {
        memory_id: 'mem-1',
        namespace_id: `ns-${'a'.repeat(64)}`,
        kind: 'concept',
        workspace_id: 'ws-1',
        actor_id: 'actor-1',
        scope: 'workspace_shared',
        available_resolution: 'R2',
        active_resolution: 'R2',
        status: 'active',
        provenance: {},
        evidence: [],
        contradiction: [],
        supersession: ['mem-2'],
        created_at: '2026-10-07T00:00:00.000Z',
      },
      representations: [
        {
          representation_id: 'repr-1',
          namespace_id: `ns-${'a'.repeat(64)}`,
          memory_id: 'mem-1',
          revision_id: 'rev-1',
          mutation_id: 'mut-1',
          source_ref: 'chamber://doc/x',
          current: true,
          resolution: 'R2',
          body: '正文',
          digest: 'dig',
          created_at: '2026-10-07T00:00:00.000Z',
        },
      ],
      anchors: [],
      partial: false,
    };

    it('请求体三键 + 无幂等键/诊断头', async () => {
      const engine = engineWith(fakeResponse(READ_RESPONSE));
      await engine.readMemory(TARGET, 'mem-1');

      const { url, headers, body } = callAt();
      expect(url).toBe('http://hub.local:8099/v1/memory/inspect');
      expect(headers.get(HUMENT_IDEMPOTENCY_HEADER)).toBeNull();
      expect(headers.get(HUMENT_DIAGNOSTICS_HEADER)).toBeNull();
      expect(body).toEqual({ workspace_id: 'ws-1', actor_id: 'actor-1', memory_id: 'mem-1' });
    });

    it('归一化：memory（含内部 supersession）/ representations / anchors / partial', async () => {
      const engine = engineWith(fakeResponse(READ_RESPONSE));
      const result = await engine.readMemory(TARGET, 'mem-1');
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.memory.supersession).toEqual(['mem-2']);
      expect(result.value.memory.memory_id).toBe('mem-1');
      expect(result.value.representations).toHaveLength(1);
      expect(result.value.anchors).toEqual([]);
      expect(result.value.partial).toBe(false);
    });
  });

  describe('失败面（never-throw 判别式联合）', () => {
    const NOMINATE_INPUT = {
      ledgerId: 'led-1',
      category: 'ruling',
      content: 'body',
      rationale: 'why',
      sourceLocators: [],
    };

    it('fetch 抛普通错误 → unreachable（未到达 Hub）', async () => {
      const engine = engineWith(new Error('connect ECONNREFUSED'));
      const result = await engine.nominate(TARGET, NOMINATE_INPUT);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.kind).toBe('unreachable');
      expect(result.failure.message).toContain('transport error');
      expect(typeof result.failure.latencyMs).toBe('number');
    });

    it('fetch 抛 TimeoutError / AbortError → timeout（无回执）', async () => {
      for (const name of ['TimeoutError', 'AbortError']) {
        const error = new Error('aborted');
        error.name = name;
        const engine = engineWith(error);
        const result = await engine.nominate(TARGET, NOMINATE_INPUT);
        if (result.ok) throw new Error('unreachable');
        expect(result.failure.kind).toBe('timeout');
      }
    });

    it('**body 读阶段**抛 TimeoutError 也判 timeout（与 fetch 阶段同口径）', async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      const engine = engineWith(bodyThrowingResponse(error));
      const result = await engine.nominate(TARGET, NOMINATE_INPUT);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.kind).toBe('timeout');
    });

    it('非 2xx：错误体三标量（code/retryable/request_id）全部提取，原文不搬运', async () => {
      const engine = engineWith(
        fakeResponse(
          {
            error: {
              code: 'idempotency_conflict',
              message: 'secret echo: my content',
              request_id: 'req-body-1',
              retryable: false,
              details: { internal: 'secret' },
            },
          },
          { status: 409 },
        ),
      );
      const result = await engine.nominate(TARGET, NOMINATE_INPUT);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure).toMatchObject({
        kind: 'http',
        httpStatus: 409,
        engineCode: 'idempotency_conflict',
        retryable: false,
        requestId: 'req-body-1',
      });
      // 错误体原文（message/details）**不进 failure**（日志不得成为回显通道）
      expect(JSON.stringify(result.failure)).not.toContain('secret');
    });

    it('request_id 优先取响应头，缺失时回退错误体', async () => {
      const engine = engineWith(
        fakeResponse(
          { error: { code: 'internal', message: 'x', request_id: 'req-body-2', retryable: true, details: {} } },
          { status: 500, headers: { 'X-Request-ID': 'req-header-2' } },
        ),
      );
      const result = await engine.nominate(TARGET, NOMINATE_INPUT);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.requestId).toBe('req-header-2');
    });

    it('非 2xx 且体不可解析 → 仍落 http（状态码足够分类，不因缺 code 而升级成 unknown 之外的分类）', async () => {
      const engine = engineWith(fakeResponse(undefined, { status: 503, rawText: '<html>gateway</html>' }));
      const result = await engine.nominate(TARGET, NOMINATE_INPUT);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.kind).toBe('http');
      expect(result.failure.httpStatus).toBe(503);
      expect(result.failure.engineCode).toBeUndefined();
    });

    it('2xx 空体 / 非 JSON → invalid_response', async () => {
      for (const response of [
        fakeResponse(undefined, { rawText: '' }),
        fakeResponse(undefined, { rawText: 'not json at all' }),
        fakeResponse(undefined, { rawText: '[1,2,3]' }),
      ]) {
        const engine = engineWith(response);
        const result = await engine.nominate(TARGET, NOMINATE_INPUT);
        if (result.ok) throw new Error('unreachable');
        expect(result.failure.kind).toBe('invalid_response');
      }
    });

    it('2xx 但缺关键字段（nomination_id / recall_id / memory）→ invalid_response', async () => {
      const noNominationId = engineWith(fakeResponse({ job_state: 'committed' }));
      const r1 = await noNominationId.nominate(TARGET, NOMINATE_INPUT);
      if (r1.ok) throw new Error('unreachable');
      expect(r1.failure.kind).toBe('invalid_response');

      const noRecallId = engineWith(fakeResponse({ items: [], trace: {} }));
      const r2 = await noRecallId.recall(TARGET, { query: 'q', contextIdentity: 'c', contextEpoch: 0 });
      if (r2.ok) throw new Error('unreachable');
      expect(r2.failure.kind).toBe('invalid_response');

      const noMemory = engineWith(fakeResponse({ representations: [], anchors: [] }));
      const r3 = await noMemory.readMemory(TARGET, 'mem-1');
      if (r3.ok) throw new Error('unreachable');
      expect(r3.failure.kind).toBe('invalid_response');
    });

    it('**never-throw**：fetch 同步抛出也不冒泡（全动词扫一遍）', async () => {
      fetchMock = jest.fn().mockImplementation(() => {
        throw new Error('sync boom');
      });
      (global as unknown as { fetch: unknown }).fetch = fetchMock;
      const engine = new HumentEngine(SETTINGS);

      const results = await Promise.all([
        engine.nominate(TARGET, NOMINATE_INPUT),
        engine.inspectNomination(TARGET, { nominationId: 'n' }),
        engine.recall(TARGET, { query: 'q', contextIdentity: 'c', contextEpoch: 0 }),
        engine.correct(TARGET, { newLedgerId: 'l', oldMemoryId: 'o', newMemoryId: 'n', rationale: 'r' }),
        engine.inspectCorrection(TARGET, { correctionId: 'c' }),
        engine.readMemory(TARGET, 'm'),
        // 五读面同样必须 never-throw（它们是 GET，但传输原语是同一个——见 requestJson 不变量）
        engine.getGraphView(TARGET, {}),
        engine.getMemoryView(TARGET, 'm', {}),
        engine.getMemoryViewHistory(TARGET, 'm', 'R2', {}),
        engine.getMemoryViewRepresentation(TARGET, 'm', 'r'),
        engine.getMemoryRelations(TARGET, 'm'),
      ]);
      for (const result of results) {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.failure.kind).toBe('unreachable');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 引擎诊断透传（b4d41314）：admission_cause 四条件门控 + 终拒 failure 解析
  // ══════════════════════════════════════════════════════════════════════
  describe('引擎诊断透传（b4d41314）', () => {
    const NOMINATE_INPUT = {
      ledgerId: 'led-diag',
      category: 'ruling',
      content: 'body',
      rationale: 'why',
      sourceLocators: [],
    };

    /** 造一个 409 admission 错误体（默认满足四条件门控） */
    function admissionError(
      details: Record<string, unknown>,
      overrides: { code?: string; retryable?: boolean; status?: number } = {},
    ): Response {
      return fakeResponse(
        {
          error: {
            code: overrides.code ?? 'conflict',
            message: 'secret echo: my content',
            request_id: 'req-409',
            retryable: overrides.retryable ?? false,
            details,
          },
        },
        { status: overrides.status ?? 409 },
      );
    }

    it('三值 admission_cause 逐值透传（409 + conflict + retryable=false）', async () => {
      for (const cause of ['prefix_unresolved', 'quota_exceeded', 'exact_content']) {
        const engine = engineWith(admissionError({ admission_cause: cause }));
        const result = await engine.nominate(TARGET, NOMINATE_INPUT);
        if (result.ok) throw new Error('expected failure');
        expect(result.failure.kind).toBe('http');
        expect(result.failure.admissionCause).toBe(cause);
        expect(result.failure.requestId).toBe('req-409');
        // 错误体原文仍然不进 failure（白名单只是窄化，不是开口子）
        expect(JSON.stringify(result.failure)).not.toContain('secret');
      }
    });

    it('门控：retryable=true / code 非 conflict / 非 409 ⇒ 一律不透传', async () => {
      const cases = [
        admissionError({ admission_cause: 'quota_exceeded' }, { retryable: true }),
        admissionError({ admission_cause: 'quota_exceeded' }, { code: 'idempotency_conflict' }),
        admissionError({ admission_cause: 'quota_exceeded' }, { status: 400 }),
      ];
      for (const response of cases) {
        const engine = engineWith(response);
        const result = await engine.nominate(TARGET, NOMINATE_INPUT);
        if (result.ok) throw new Error('expected failure');
        expect(result.failure.admissionCause).toBeUndefined();
      }
    });

    it('未知 / 非字符串 admission_cause ⇒ 丢弃 + warn（日志只落 sanitize 摘要）', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        for (const cause of ['private value with space', 'PREFIX_UNRESOLVED', null]) {
          const engine = engineWith(admissionError({ admission_cause: cause }));
          const result = await engine.nominate(TARGET, NOMINATE_INPUT);
          if (result.ok) throw new Error('expected failure');
          expect(result.failure.admissionCause).toBeUndefined();
        }
        expect(warn).toHaveBeenCalledTimes(3);
        // 原值（含空格）不进日志——只落 sanitize 后的摘要
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private value with space');
      } finally {
        warn.mockRestore();
      }
    });

    it('request_id 安全门对齐 hument validRemoteRequestID（长度 1..128 + 受限字符集）', async () => {
      const allowedPunctuation = "!#$%&'*+-.^_`|~";
      const accepted = await engineWith(
        fakeResponse({ nomination_id: 'nom-1', duplicate: false, deferred: false, durable: true }, {
          headers: { 'X-Request-ID': `${'a'.repeat(100)}${allowedPunctuation}` },
        }),
      ).nominate(TARGET, NOMINATE_INPUT);
      if (!accepted.ok) throw new Error('expected success');
      expect(accepted.value.requestId).toBe(`${'a'.repeat(100)}${allowedPunctuation}`);

      // ⚠️ `Headers` 只接受 Latin-1（ByteString）：这里用 `é` 而不是中文——后者在构造响应头
      // 时就抛 TypeError，测不到门（门本身对任何非 ASCII 字符一律拒绝）
      for (const requestId of ['a'.repeat(129), 'has space', 'req-id-é']) {
        const rejected = await engineWith(
          fakeResponse({ nomination_id: 'nom-1', duplicate: false, deferred: false, durable: true }, {
            headers: { 'X-Request-ID': requestId },
          }),
        ).nominate(TARGET, NOMINATE_INPUT);
        if (!rejected.ok) throw new Error('expected success');
        expect(rejected.value.requestId).toBeUndefined();
      }
    });

    it('200 终拒回执：diagnostics.failure 三字段进 result.value', async () => {
      const engine = engineWith(
        fakeResponse({
          nomination_id: 'nom-rejected',
          job_state: 'provider_rejected',
          duplicate: false,
          deferred: false,
          durable: true,
          diagnostics: {
            outcome: 'rejected',
            reason_code: 'provider_rejected',
            mutation: { memory_ids: [] },
            failure: {
              error_code: 'provider_rejected',
              error_detail: 'provider_decision_evidence_missing',
              failure_class: 'terminal_rejection',
              request_disposition: 'sent_with_response',
              retry_basis: 'none',
              attempt_count: 1,
            },
          },
        }),
      );
      const result = await engine.nominate(TARGET, NOMINATE_INPUT);
      if (!result.ok) throw new Error(`unexpected failure: ${result.failure.message}`);
      expect(result.value.reasonCode).toBe('provider_rejected');
      expect(result.value.errorDetail).toBe('provider_decision_evidence_missing');
      expect(result.value.failureClass).toBe('terminal_rejection');
    });

    it('200 回执的越界诊断值逐值丢弃（形态门 / 词表门；不截断）', async () => {
      const engine = engineWith(
        fakeResponse({
          nomination_id: 'nom-bad-diag',
          duplicate: false,
          deferred: false,
          durable: true,
          diagnostics: {
            outcome: 'unknown',
            reason_code: 'UPPER-CASE',
            mutation: { memory_ids: [] },
            failure: {
              error_code: 'provider_outcome_unknown',
              error_detail: 'Provider Bad!',
              failure_class: 'not_a_class',
            },
          },
        }),
      );
      const result = await engine.nominate(TARGET, NOMINATE_INPUT);
      if (!result.ok) throw new Error('expected success');
      expect(result.value.reasonCode).toBeUndefined();
      expect(result.value.errorDetail).toBeUndefined();
      expect(result.value.failureClass).toBeUndefined();
    });
  });

  describe('原语（单测直击）', () => {
    it('isHumentTimeoutError：TimeoutError / AbortError / 其他', () => {
      const timeout = new Error('t');
      timeout.name = 'TimeoutError';
      const abort = new Error('a');
      abort.name = 'AbortError';
      expect(isHumentTimeoutError(timeout)).toBe(true);
      expect(isHumentTimeoutError(abort)).toBe(true);
      expect(isHumentTimeoutError(new Error('nope'))).toBe(false);
      expect(isHumentTimeoutError(undefined)).toBe(false);
    });

    it('parseHumentErrorEnvelope：提取三标量；形状不符返回空对象（不抛）', () => {
      expect(
        parseHumentErrorEnvelope({
          error: { code: 'overloaded', message: 'busy', request_id: 'req-1', retryable: true, details: {} },
        }),
      ).toEqual({ engineCode: 'overloaded', retryable: true, requestId: 'req-1' });

      for (const body of [undefined, null, 'text', [], {}, { error: null }, { error: {} }]) {
        expect(parseHumentErrorEnvelope(body)).toEqual({
          engineCode: undefined,
          retryable: undefined,
          requestId: undefined,
        });
      }
      // 类型不符的字段一律丢弃（`retryable: 'false'` 不得被当成 true）
      expect(parseHumentErrorEnvelope({ error: { code: 5, retryable: 'false', request_id: '' } })).toEqual({
        engineCode: undefined,
        retryable: undefined,
        requestId: undefined,
      });
    });

    it('parseHumentErrorEnvelope：details.admission_cause 只放行闭合三值（未知/非字符串丢弃）', () => {
      for (const cause of ['prefix_unresolved', 'quota_exceeded', 'exact_content']) {
        expect(
          parseHumentErrorEnvelope({
            error: { code: 'conflict', retryable: false, details: { admission_cause: cause } },
          }),
        ).toMatchObject({ admissionCause: cause });
      }

      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        for (const cause of ['unknown_cause', '', null, 5, true, ['quota_exceeded']]) {
          expect(
            parseHumentErrorEnvelope({
              error: { code: 'conflict', retryable: false, details: { admission_cause: cause } },
            }).admissionCause,
          ).toBeUndefined();
        }
        expect(warn).toHaveBeenCalledTimes(6);
      } finally {
        warn.mockRestore();
      }

      // details 里没有该键（或有其它键）⇒ 不产生诊断、也不 warn
      expect(
        parseHumentErrorEnvelope({ error: { code: 'conflict', details: { internal: 'secret' } } }),
      ).not.toHaveProperty('admissionCause');
    });

    it('parseHumentErrorEnvelope：request_id 过安全门（与响应头同口径）', () => {
      const allowedPunctuation = "!#$%&'*+-.^_`|~";
      expect(
        parseHumentErrorEnvelope({
          error: { request_id: `${'a'.repeat(100)}${allowedPunctuation}` },
        }).requestId,
      ).toBe(`${'a'.repeat(100)}${allowedPunctuation}`);
      for (const requestId of ['a'.repeat(129), 'has space', '含中文']) {
        expect(parseHumentErrorEnvelope({ error: { request_id: requestId } }).requestId).toBeUndefined();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // alpha.5 投影读面（GET；只读；整族逐字透传）
  //
  // 与六个写/读动词的**形状差别**是本组的重点：GET（不是 POST）、无 body、**无
  // Content-Type**、**无幂等键、无诊断头**、参数全在 query、且 `scope` 恒 `actor_private`。
  // ══════════════════════════════════════════════════════════════════════
  describe('投影读面（五读面；GET + 只读 + 逐字透传）', () => {
    const GRAPH_RESPONSE = {
      schema_version: 'memory-view-memory-graph-v1',
      request_id: 'req-graph-1',
      auth_kind: 'binding_credential_ref',
      authority: 'inspect_read',
      target: {
        target_id: 'a'.repeat(64),
        workspace_id: 'ws-1',
        actor_id: 'actor-1',
        binding_id: 'bind-1',
        scope: 'actor_private',
      },
      snapshot_digest: 'b'.repeat(64),
      mode: 'browse',
      center_memory_id: '',
      filters: {
        kind: 'any',
        status: 'any',
        active_resolution: 'any',
        available_resolution: 'any',
        anchor_state: 'any',
        created_from: null,
        created_to: null,
        relation_type: 'any',
      },
      budget: {
        node_limit: 200,
        edge_limit: 600,
        neighborhood_limit: 100,
        preview_scalars: 160,
        depth: 1,
      },
      node_page: {
        total: 0,
        total_kind: 'exact',
        loaded: 0,
        next_cursor: '',
        partial: false,
        truncated: false,
        truncation_reason: '',
      },
      edge_page: {
        total: 0,
        total_kind: 'exact',
        loaded: 0,
        next_cursor: '',
        partial: false,
        truncated: false,
        truncation_reason: '',
      },
      omitted_edge_count: 0,
      nodes: [],
      edges: [],
      redaction: 'memory-projection-safe-v1',
    };

    const DETAIL_RESPONSE = {
      schema_version: 'memory-view-memory-detail-v1',
      request_id: 'req-detail-1',
      auth_kind: 'binding_credential_ref',
      authority: 'inspect_read',
      target: {
        target_id: 'a'.repeat(64),
        workspace_id: 'ws-1',
        actor_id: 'actor-1',
        binding_id: 'bind-1',
        scope: 'actor_private',
      },
      snapshot_digest: 'b'.repeat(64),
      memory: {
        memory_id: 'mem-1',
        kind: 'concept',
        scope: 'actor_private',
        status: 'active',
        available_resolution: 'R2',
        active_resolution: 'R2',
        provenance: { source_type: 'chamber_nomination' },
        confidence_present: false,
        confidence: null,
        evidence: [],
        contradiction: [],
        supersession: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      sections: {
        representations: { page: GRAPH_RESPONSE.node_page, ladder: [] },
        anchors: { page: GRAPH_RESPONSE.node_page, items: [] },
        relations: { page: GRAPH_RESPONSE.node_page, items: [] },
      },
      redaction: 'memory-projection-safe-v1',
    };

    const HISTORY_RESPONSE = {
      schema_version: 'memory-view-representation-history-v1',
      request_id: 'req-history-1',
      auth_kind: 'binding_credential_ref',
      authority: 'inspect_read',
      target: GRAPH_RESPONSE.target,
      snapshot_digest: 'b'.repeat(64),
      memory_id: 'mem-1',
      resolution: 'R2',
      page: GRAPH_RESPONSE.node_page,
      items: [],
      redaction: 'memory-projection-safe-v1',
    };

    const REPRESENTATION_RESPONSE = {
      schema_version: 'memory-view-representation-detail-v1',
      request_id: 'req-repr-1',
      auth_kind: 'binding_credential_ref',
      authority: 'inspect_read',
      target: GRAPH_RESPONSE.target,
      snapshot_digest: 'b'.repeat(64),
      memory_id: 'mem-1',
      representation: {
        representation_id: 'repr-1',
        resolution: 'R2',
        revision_id: 'rev-1',
        mutation_id: 'mut-1',
        source_ref: 'chamber://memory/mem-1',
        current: true,
        body: '正文',
        digest: 'c'.repeat(64),
        original_bytes: 6,
        body_truncated: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      redaction: 'memory-projection-safe-v1',
    };

    /**
     * 关系建议响应（合同 `memory-relations-response.schema.json` 的 required 集 + 两个可选键）。
     *
     * ⚠️ 与上面四个不同族：**没有** `target` / `snapshot_digest` / `redaction`（它不是
     * `memory-view-*` 家族；合同里就是这四个顶层键）——本 fixture 的形状本身即是"别归族"的断言。
     */
    const RELATIONS_RESPONSE = {
      schema_version: 'hument-memory-relations-v1',
      memory_id: 'mem-1',
      truncated: false,
      advisories: [
        {
          job_id: 'job-1',
          matched_memory_id: 'mem-1',
          new_memory_id: 'mem-1',
          state: 'complete',
          coverage: {
            new_memory_id: 'mem-1',
            status: 'complete',
            candidate_count: 1,
            orient_truncated: false,
            budget_incomplete: false,
          },
          cases: [
            {
              case_id: 'case-1',
              new_memory_id: 'mem-1',
              old_memory_id: 'mem-2',
              label: 'supplement',
              decision: 'advisory',
              reason: '作者自报：补充同一对象的不同侧面',
              confidence: 0.5,
              source_state: 'author_reported',
              advisory_only: true,
            },
          ],
          model: 'fake-relation-advisor-v1',
          usage: { input_tokens: 11, output_tokens: 22, cost_micros: 33 },
          created_at: '2026-01-01T00:00:00.000Z',
          source_state: 'author_reported',
          advisory_only: true,
        },
      ],
    };

    /**
     * 读面专用的调用读取器。
     *
     * ⚠️ **不能用文件顶部的 `callAt`**：它对 `init.body` 做 `JSON.parse`，而 GET 没有 body
     * （`String(undefined)` = `"undefined"` ⇒ SyntaxError）——那正是"GET 与 POST 形状不同"的
     * 副作用，用错读取器会把一条正确的实现判成失败。
     */
    function readCall(index = 0): { url: string; init: RequestInit; headers: Headers } {
      const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
      return { url, init, headers: new Headers(init.headers) };
    }

    /**
     * 读面固定的 header/URL 断言（四条共用）。
     *
     * ⚠️ 这三条断言是**读面与写动词的分界线**：多了 `Content-Type`（无 body 却声明类型）、
     * 多了幂等键（只读动作没有"重放"可言）、多了诊断头（没有 outcome 可驱动）都说明
     * 有人把 POST 的装配照抄到了 GET 上。
     */
    function expectReadOnlyShape(index: number, expectedPath: string) {
      const { url, init, headers } = readCall(index);
      expect(url).toContain(expectedPath);
      expect(init.method).toBe('GET');
      expect(headers.get('X-Hument-Credential-Ref')).toBe('cred-ref-1');
      expect(headers.get(HUMENT_IDEMPOTENCY_HEADER)).toBeNull();
      expect(headers.get(HUMENT_DIAGNOSTICS_HEADER)).toBeNull();
      expect(headers.get('Content-Type')).toBeNull();
      expect(init.body).toBeUndefined();
      // 四条不变量之一：超时判别靠它（丢了它所有失败都会变成 unreachable）
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.redirect).toBe('error');
      return { url, init, headers };
    }

    it('graph：GET + query 三件套（scope 恒 actor_private）+ 未传参数**不进 query**', async () => {
      const engine = engineWith(fakeResponse(GRAPH_RESPONSE));
      await engine.getGraphView(TARGET, { kind: 'concept' });

      const { url } = expectReadOnlyShape(0, '/v1/memory-views/graph');
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      expect(query.get('workspace_id')).toBe('ws-1');
      expect(query.get('actor_id')).toBe('actor-1');
      expect(query.get('scope')).toBe('actor_private');
      expect(query.get('kind')).toBe('concept');
      // 未传的过滤器**完全不出现**（不是空串、更不是字面量 "undefined"）
      for (const absent of [
        'mode',
        'center_memory_id',
        'status',
        'active_resolution',
        'available_resolution',
        'anchor_state',
        'created_from',
        'created_to',
        'relation_type',
        'node_limit',
        'edge_limit',
        'neighborhood_limit',
        'preview_scalars',
        'cursor',
      ]) {
        expect(query.has(absent)).toBe(false);
      }
      expect(url).not.toContain('undefined');
    });

    it('graph：**全集**入参逐项进 query（含 RFC3339 字符串逐字透传，平台不做 Date 转换）', async () => {
      const engine = engineWith(fakeResponse(GRAPH_RESPONSE));
      await engine.getGraphView(TARGET, {
        mode: 'browse',
        center_memory_id: 'mem-9',
        kind: 'belief',
        status: 'active',
        active_resolution: 'R2',
        available_resolution: 'R3',
        anchor_state: 'stale',
        created_from: '2026-01-01T00:00:00+08:00',
        created_to: '2026-02-01T00:00:00+08:00',
        relation_type: 'supports',
        node_limit: 50,
        edge_limit: 120,
        neighborhood_limit: 10,
        preview_scalars: 200,
        cursor: 'cursor-token',
      });

      const { url } = readCall();
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      expect(query.get('mode')).toBe('browse');
      expect(query.get('center_memory_id')).toBe('mem-9');
      expect(query.get('kind')).toBe('belief');
      expect(query.get('active_resolution')).toBe('R2');
      expect(query.get('available_resolution')).toBe('R3');
      expect(query.get('anchor_state')).toBe('stale');
      // ⚠️ 逐字（带 +08:00 偏移量原样）；若有人加了 Date 转换，这里会变成别的串
      expect(query.get('created_from')).toBe('2026-01-01T00:00:00+08:00');
      expect(query.get('created_to')).toBe('2026-02-01T00:00:00+08:00');
      expect(query.get('relation_type')).toBe('supports');
      expect(query.get('node_limit')).toBe('50');
      expect(query.get('edge_limit')).toBe('120');
      expect(query.get('neighborhood_limit')).toBe('10');
      expect(query.get('preview_scalars')).toBe('200');
      expect(query.get('cursor')).toBe('cursor-token');
    });

    it('graph：归一化**原样透传**（整块，含 total_kind / omitted_edge_count）', async () => {
      const engine = engineWith(fakeResponse({ ...GRAPH_RESPONSE, omitted_edge_count: 7 }));
      const result = await engine.getGraphView(TARGET, {});

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toEqual({ ...GRAPH_RESPONSE, omitted_edge_count: 7 });
      // 顶层字段一个都不改名（view 族连顶层都逐字——与六个写动词的"顶层归一化"不同）
      expect(result.value.node_page.total_kind).toBe('exact');
      expect(result.value.target.scope).toBe('actor_private');
    });

    it('detail / history / representation：URL 与 query 各就各位', async () => {
      const engine = engineWith(fakeResponse(DETAIL_RESPONSE));
      await engine.getMemoryView(TARGET, 'mem-1', { relation_limit: 20, relation_cursor: 'c1' });
      const detailUrl = expectReadOnlyShape(0, '/v1/memory-views/memories/mem-1').url;
      const detailQuery = new URLSearchParams(detailUrl.slice(detailUrl.indexOf('?') + 1));
      expect(detailQuery.get('relation_limit')).toBe('20');
      expect(detailQuery.get('relation_cursor')).toBe('c1');
      expect(detailQuery.get('scope')).toBe('actor_private');

      const engine2 = engineWith(fakeResponse(HISTORY_RESPONSE));
      await engine2.getMemoryViewHistory(TARGET, 'mem-1', 'R3', { history_limit: 5, cursor: 'c2' });
      const historyUrl = readCall(0).url;
      expect(historyUrl).toContain('/v1/memory-views/memories/mem-1/history/R3');
      const historyQuery = new URLSearchParams(historyUrl.slice(historyUrl.indexOf('?') + 1));
      expect(historyQuery.get('history_limit')).toBe('5');
      expect(historyQuery.get('cursor')).toBe('c2');

      const engine3 = engineWith(fakeResponse(REPRESENTATION_RESPONSE));
      await engine3.getMemoryViewRepresentation(TARGET, 'mem-1', 'repr-1');
      const reprUrl = expectReadOnlyShape(0, '/v1/memory-views/memories/mem-1/representations/repr-1').url;
      // 本端点**只有** scope 三件套（合同入参就这三个）——多一个键就说明装配串了
      const reprQuery = new URLSearchParams(reprUrl.slice(reprUrl.indexOf('?') + 1));
      expect([...reprQuery.keys()].sort()).toEqual(['actor_id', 'scope', 'workspace_id']);
    });

    it('缺关键容器 ⇒ invalid_response（四个端点各一条：nodes/sections/items/representation）', async () => {
      const graph = engineWith(fakeResponse({ ...GRAPH_RESPONSE, nodes: undefined }));
      const r1 = await graph.getGraphView(TARGET, {});
      if (r1.ok) throw new Error('unreachable');
      expect(r1.failure.kind).toBe('invalid_response');

      const noSections = engineWith(fakeResponse({ ...DETAIL_RESPONSE, sections: undefined }));
      const r2 = await noSections.getMemoryView(TARGET, 'mem-1', {});
      if (r2.ok) throw new Error('unreachable');
      expect(r2.failure.kind).toBe('invalid_response');

      const noItems = engineWith(fakeResponse({ ...HISTORY_RESPONSE, items: undefined }));
      const r3 = await noItems.getMemoryViewHistory(TARGET, 'mem-1', 'R2', {});
      if (r3.ok) throw new Error('unreachable');
      expect(r3.failure.kind).toBe('invalid_response');

      const noRepr = engineWith(
        fakeResponse({ ...REPRESENTATION_RESPONSE, representation: undefined }),
      );
      const r4 = await noRepr.getMemoryViewRepresentation(TARGET, 'mem-1', 'repr-1');
      if (r4.ok) throw new Error('unreachable');
      expect(r4.failure.kind).toBe('invalid_response');
    });

    it('relations：URL 在 /v1/memories/ 下 + query **只有** scope 三件套（合同无 limit/cursor）', async () => {
      const engine = engineWith(fakeResponse(RELATIONS_RESPONSE));
      await engine.getMemoryRelations(TARGET, 'mem-1');

      const { url } = expectReadOnlyShape(0, '/v1/memories/mem-1/relations');
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      // 契约里这个端点**只有** workspace/actor/scope（Relation* 三个参数都是 required）
      expect([...query.keys()].sort()).toEqual(['actor_id', 'scope', 'workspace_id']);
      expect(query.get('scope')).toBe('actor_private');
      expect(query.get('workspace_id')).toBe('ws-1');
      expect(query.get('actor_id')).toBe('actor-1');
    });

    it('relations：归一化**原样透传**（含两个 const 与可选 usage/confidence）', async () => {
      const engine = engineWith(fakeResponse(RELATIONS_RESPONSE));
      const result = await engine.getMemoryRelations(TARGET, 'mem-1');
      if (!result.ok) throw new Error('unreachable');
      // 逐字同一份（**不是重建的对象**：重建就丢掉平台没有认知的字段）
      expect(result.value).toEqual(RELATIONS_RESPONSE);
      expect(result.value.advisories[0].advisory_only).toBe(true);
      expect(result.value.advisories[0].cases[0].source_state).toBe('author_reported');
    });

    it('relations：空 advisories 是**合法 200**（不是合同破损）', async () => {
      const engine = engineWith(
        fakeResponse({ ...RELATIONS_RESPONSE, advisories: [] }),
      );
      const result = await engine.getMemoryRelations(TARGET, 'mem-1');
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.advisories).toEqual([]);
    });

    it('relations：缺关键容器 ⇒ invalid_response（memory_id / advisories / advisory.cases 三条）', async () => {
      // 顶层 memory_id 缺 ⇒ 合同破损
      const noId = engineWith(fakeResponse({ ...RELATIONS_RESPONSE, memory_id: undefined }));
      const r1 = await noId.getMemoryRelations(TARGET, 'mem-1');
      if (r1.ok) throw new Error('unreachable');
      expect(r1.failure.kind).toBe('invalid_response');

      // advisories 不是数组（合同 required array）
      const noAdvisories = engineWith(
        fakeResponse({ ...RELATIONS_RESPONSE, advisories: undefined }),
      );
      const r2 = await noAdvisories.getMemoryRelations(TARGET, 'mem-1');
      if (r2.ok) throw new Error('unreachable');
      expect(r2.failure.kind).toBe('invalid_response');

      // ⚠️ **本读面唯一比兄弟严的一格**：`advisory.cases` 必须是数组——服务层要重建它
      //    （逐 case 来源过滤），缺了会把"引擎答了个半懂的形状"变成 **500**（见归一化注释）
      const noCases = engineWith(
        fakeResponse({
          ...RELATIONS_RESPONSE,
          advisories: [{ ...RELATIONS_RESPONSE.advisories[0], cases: undefined }],
        }),
      );
      const r3 = await noCases.getMemoryRelations(TARGET, 'mem-1');
      if (r3.ok) throw new Error('unreachable');
      expect(r3.failure.kind).toBe('invalid_response');
    });

    it('**cursor 失效双通道**：409 snapshot_stale 与 400 invalid_argument 都落 http + engineCode', async () => {
      // ① 翻页途中快照变化 ⇒ 409（引擎可达但拒了这次请求 ⇒ 服务层 502/14004 逐字透传）
      const stale = engineWith(
        fakeResponse(
          { error: { code: 'snapshot_stale', message: 'snapshot moved', request_id: 'req-s', retryable: false } },
          { status: 409 },
        ),
      );
      const staleResult = await stale.getGraphView(TARGET, { cursor: 'c1' });
      if (staleResult.ok) throw new Error('unreachable');
      expect(staleResult.failure).toMatchObject({
        kind: 'http',
        httpStatus: 409,
        engineCode: 'snapshot_stale',
        retryable: false,
        requestId: 'req-s',
      });

      // ② 携 cursor 改任一过滤器/页大小 ⇒ 400（cursor 绑 query_digest）
      const invalid = engineWith(
        fakeResponse(
          { error: { code: 'invalid_argument', message: 'cursor mismatch', request_id: 'req-i', retryable: false } },
          { status: 400 },
        ),
      );
      const invalidResult = await invalid.getGraphView(TARGET, { cursor: 'c1', kind: 'belief' });
      if (invalidResult.ok) throw new Error('unreachable');
      expect(invalidResult.failure).toMatchObject({
        kind: 'http',
        httpStatus: 400,
        engineCode: 'invalid_argument',
      });
      // 错误体原文仍然不落 failure（与写动词同一条不变量）
      expect(JSON.stringify(invalidResult.failure)).not.toContain('cursor mismatch');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Usage 读面（alpha.19；GET + 只读 + 禁 scope + summary 无分页）
  // ══════════════════════════════════════════════════════════════════════
  describe('usage 读面（alpha.19）', () => {
    /** 合同 required 的 totals 全文（值刻意与 rows/groups 不相等——平台不得重算） */
    const usageTotals = {
      counts: {
        evidence_rows: 2,
        entities: 2,
        logical_calls: 2,
        generations: 1,
        batches: 0,
        known_physical_calls: 1,
        physical_calls: null,
        unknown_physical_units: 1,
        http_429: 0,
        retries: 0,
        cache_reuses: null,
        replay_count: 0,
      },
      tokens: {
        known_input_tokens: 10,
        input_tokens: null,
        unknown_input_rows: 1,
        known_output_tokens: 20,
        output_tokens: 20,
        unknown_output_rows: 0,
        known_total_tokens: 30,
        total_tokens: null,
        unknown_total_rows: 1,
      },
      cost: {
        status: 'unknown',
        actual_micros: null,
        known_estimated_micros: 7,
        estimated_micros: null,
        unknown_estimated_rows: 1,
      },
      duration: {
        known_physical_ms: 120,
        physical_ms: null,
        unknown_physical_rows: 1,
      },
    } as const;

    /** 合同 target（workspace/actor 与 TARGET 一致；scope 恒 actor_private） */
    const usageTarget = {
      binding_id: 'binding-1',
      namespace_id: 'ns-1',
      workspace_id: TARGET.workspaceId,
      actor_id: TARGET.actorId,
      scope: 'actor_private',
    };

    const usageCoverage = {
      status: 'complete',
      scope: 'actor_private',
      sources: [{ source: 'formation', status: 'complete', reasons: [] }],
      excluded_untimed_rows: 0,
    };

    /** summary 回执（`groups` 只有一条，刻意与 totals 不等） */
    function summaryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        schema_version: 'hument-usage-v1',
        target: { ...usageTarget },
        filter: { since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' },
        time_basis: 'physical_started_at',
        snapshot: 'snap-1',
        as_of: '2026-10-02T00:00:00Z',
        totals: structuredClone(usageTotals),
        groups: [
          {
            operation: 'formation',
            provider_operation: 'generation',
            model_basis: 'unknown',
            totals: structuredClone(usageTotals),
          },
        ],
        coverage: usageCoverage,
        ...overrides,
      };
    }

    /** trace 行（null / 0 / absent 三态齐；开放字符串不收窄） */
    const traceRow = {
      id: 'use-1',
      evidence_kind: 'physical_call',
      source: 'formation',
      operation: 'future_operation_v99',
      provider_operation: 'generation',
      entity_id: 'mem_1',
      model_basis: 'unknown',
      elapsed_ms: null,
      time_source: 'physical_started_at',
      request_bytes: null,
      response_bytes: null,
      response_complete: true,
      input_tokens: null,
      output_tokens: 0,
      total_tokens: null,
      usage_source: 'provider',
      token_basis: 'provider_reported',
      actual_cost_micros: null,
      estimated_cost_micros: 0,
      cost_status: 'unknown',
      physical_calls_unknown: true,
      cache_reuses: null,
      adapter_elapsed_ms: null,
    };

    /** trace 回执 */
    function tracePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        schema_version: 'hument-usage-v1',
        target: { ...usageTarget },
        filter: {},
        time_basis: 'physical_started_at',
        snapshot: 'snap-1',
        as_of: '2026-10-02T00:00:00Z',
        rows: [structuredClone(traceRow)],
        total_rows: 2,
        limit: 1,
        next_cursor: 'cursor-2',
        has_more: true,
        totals: structuredClone(usageTotals),
        coverage: usageCoverage,
        ...overrides,
      };
    }

    it('summary：**精确 query 键集**（无 scope / 无分页）+ GET 头体纪律', async () => {
      const engine = engineWith(fakeResponse(summaryPayload()));
      const result = await engine.getUsageSummary(TARGET, {
        operation: 'formation',
        provider_operation: 'generation',
        model: 'model-a',
        since: '2026-10-01T00:00:00Z',
        until: '2026-10-02T00:00:00Z',
      });
      expect(result.ok).toBe(true);

      const call = callAt();
      const url = new URL(call.url);
      // 键集逐字：有过滤器时只出现这 7 个；**没有 scope / limit / cursor**
      expect([...url.searchParams.keys()].sort()).toEqual(
        [
          'actor_id',
          'model',
          'operation',
          'provider_operation',
          'since',
          'until',
          'workspace_id',
        ].sort(),
      );
      expect(url.searchParams.get('scope')).toBeNull();
      expect(url.searchParams.get('workspace_id')).toBe(TARGET.workspaceId);
      expect(url.searchParams.get('actor_id')).toBe(TARGET.actorId);
      // GET：无 body、无 Content-Type、无幂等键、无诊断头；只有凭据头
      expect(call.init.method).toBe('GET');
      expect(call.init.body).toBeUndefined();
      expect(call.headers.get('content-type')).toBeNull();
      expect(call.headers.get('idempotency-key')).toBeNull();
      expect(call.headers.get(HUMENT_DIAGNOSTICS_HEADER)).toBeNull();
      expect(call.headers.get('X-Hument-Credential-Ref')).toBe(TARGET.credentialRef);
    });

    it('summary：空过滤器只发 workspace_id/actor_id（undefined 不写成 "undefined"/空串）', async () => {
      const engine = engineWith(fakeResponse(summaryPayload()));
      const result = await engine.getUsageSummary(TARGET, {});
      expect(result.ok).toBe(true);

      const url = new URL(callAt().url);
      expect([...url.searchParams.keys()].sort()).toEqual(['actor_id', 'workspace_id']);
      expect(callAt().url).not.toContain('undefined');
    });

    it('summary：即使入参夹带 limit/cursor 也**绝不**发出（合同 summary 不分页）', async () => {
      const engine = engineWith(fakeResponse(summaryPayload()));
      const result = await engine.getUsageSummary(TARGET, {
        operation: 'formation',
        // 越界字段：类型层没有，这里刻意用 any 证明运行时 query 也不拼
        limit: 50,
        cursor: 'c1',
      } as never);
      expect(result.ok).toBe(true);

      const url = new URL(callAt().url);
      expect(url.searchParams.get('limit')).toBeNull();
      expect(url.searchParams.get('cursor')).toBeNull();
    });

    it('trace：limit 真发出 + cursor 原样 + **仍无 scope**', async () => {
      const engine = engineWith(fakeResponse(tracePayload()));
      const result = await engine.getUsageTrace(TARGET, {
        operation: 'formation',
        since: '2026-10-01T00:00:00Z',
        until: '2026-10-02T00:00:00Z',
        limit: 100,
        cursor: 'cursor-1',
      });
      expect(result.ok).toBe(true);

      const url = new URL(callAt().url);
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('cursor')).toBe('cursor-1');
      expect(url.searchParams.get('scope')).toBeNull();
      expect([...url.searchParams.keys()].sort()).toEqual(
        ['actor_id', 'cursor', 'limit', 'operation', 'since', 'until', 'workspace_id'].sort(),
      );
    });

    it('normalizer：schema_version / time_basis / 容器不符 ⇒ invalid_response + schema_mismatch', async () => {
      const cases: Array<Record<string, unknown>> = [
        summaryPayload({ schema_version: 'hument-usage-v0' }),
        summaryPayload({ time_basis: 'created_at' }),
        summaryPayload({ groups: undefined }),
        summaryPayload({ totals: undefined }),
        summaryPayload({ coverage: undefined }),
      ];
      for (const payload of cases) {
        const engine = engineWith(fakeResponse(payload));
        const result = await engine.getUsageSummary(TARGET, {});
        if (result.ok) throw new Error('expected invalid_response');
        expect(result.failure).toMatchObject({
          kind: 'invalid_response',
          usageRejection: 'schema_mismatch',
        });
      }
    });

    it('normalizer：target workspace/actor/scope 不符 ⇒ target_mismatch（**跨身份交付**不是版本问题）', async () => {
      const cases = [
        summaryPayload({ target: { ...usageTarget, workspace_id: 'ws-other' } }),
        summaryPayload({ target: { ...usageTarget, actor_id: 'actor-other' } }),
        summaryPayload({ target: { ...usageTarget, scope: 'workspace_shared' } }),
        summaryPayload({ target: { ...usageTarget, binding_id: '' } }),
      ];
      for (const payload of cases) {
        const engine = engineWith(fakeResponse(payload));
        const result = await engine.getUsageSummary(TARGET, {});
        if (result.ok) throw new Error('expected invalid_response');
        expect(result.failure).toMatchObject({
          kind: 'invalid_response',
          usageRejection: 'target_mismatch',
        });
      }
    });

    it('normalizer：顶层未知键（未来 Hub 的身份字段）⇒ schema_mismatch，**绝不透传**', async () => {
      const unknownSummary = summaryPayload({
        binding_id: 'b-1',
        namespace_id: 'n-1',
        credential_ref: 'cred-1',
      });
      const unknownTrace = tracePayload({ workspace_key: 'wk-1' });
      for (const [method, payload] of [
        ['summary', unknownSummary],
        ['trace', unknownTrace],
      ] as const) {
        const engine = engineWith(fakeResponse(payload));
        const result =
          method === 'summary'
            ? await engine.getUsageSummary(TARGET, {})
            : await engine.getUsageTrace(TARGET, { limit: 1 });
        if (result.ok) throw new Error('expected invalid_response');
        expect(result.failure).toMatchObject({
          kind: 'invalid_response',
          usageRejection: 'schema_mismatch',
        });
      }
    });

    it('normalizer：trace 顶层 `groups`（summary 专属键）⇒ schema_mismatch，**不得放行**', async () => {
      const engine = engineWith(fakeResponse(tracePayload({ groups: [] })));
      const result = await engine.getUsageTrace(TARGET, { limit: 1 });
      if (result.ok) throw new Error('expected invalid_response');
      expect(result.failure).toMatchObject({
        kind: 'invalid_response',
        usageRejection: 'schema_mismatch',
      });
    });

    it('normalizer：trace 的 has_more / next_cursor 自洽（缺 cursor / 空串 ⇒ cursor_invalid）', async () => {
      for (const payload of [
        tracePayload({ next_cursor: undefined, has_more: true }),
        tracePayload({ next_cursor: '', has_more: false }),
      ]) {
        const engine = engineWith(fakeResponse(payload));
        const result = await engine.getUsageTrace(TARGET, { limit: 1 });
        if (result.ok) throw new Error('expected invalid_response');
        expect(result.failure).toMatchObject({
          kind: 'invalid_response',
          usageRejection: 'cursor_invalid',
        });
      }
    });

    it('null / 0 / absent 三态逐字保留；开放字符串不收窄；totals 不按 groups 重算', async () => {
      const engine = engineWith(fakeResponse(tracePayload()));
      const result = await engine.getUsageTrace(TARGET, { limit: 1 });
      if (!result.ok) throw new Error('expected ok');

      // 行：null 仍是 null、0 仍是 0、可选字段真的缺席（不是被补成 null）
      expect(result.value.rows[0]).toEqual(traceRow);
      expect(result.value.rows[0].input_tokens).toBeNull();
      expect(result.value.rows[0].output_tokens).toBe(0);
      expect('started_at' in result.value.rows[0]).toBe(false);
      expect(result.value.rows[0].operation).toBe('future_operation_v99');

      // totals 原样（与 rows 的一条、groups 的一条都不等——平台禁止重算）
      expect(result.value.totals).toEqual(usageTotals);
      expect(result.value.total_rows).toBe(2);
      expect(result.value.limit).toBe(1);
      expect(result.value.next_cursor).toBe('cursor-2');
    });

    it('旧 Hub 404 两变体（空 body / resource_not_found）都落 http 404（服务层 → 版本不支持）', async () => {
      const empty = engineWith(fakeResponse(null, { status: 404, rawText: '' }));
      const emptyResult = await empty.getUsageSummary(TARGET, {});
      if (emptyResult.ok) throw new Error('expected http failure');
      expect(emptyResult.failure).toMatchObject({ kind: 'http', httpStatus: 404 });
      expect(emptyResult.failure.engineCode).toBeUndefined();

      const notFound = engineWith(
        fakeResponse(
          { error: { code: 'resource_not_found', message: 'no such route', request_id: 'req-404' } },
          { status: 404 },
        ),
      );
      const notFoundResult = await notFound.getUsageSummary(TARGET, {});
      if (notFoundResult.ok) throw new Error('expected http failure');
      expect(notFoundResult.failure).toMatchObject({
        kind: 'http',
        httpStatus: 404,
        engineCode: 'resource_not_found',
        requestId: 'req-404',
      });
    });

    it('409 conflict / 400 invalid_argument 的 engineCode 逐字透传（平台据此落 cursor_reset_required）', async () => {
      for (const [status, code] of [
        [409, 'conflict'],
        [400, 'invalid_argument'],
      ] as const) {
        const engine = engineWith(
          fakeResponse(
            { error: { code, message: 'cursor', request_id: 'req-c', retryable: false } },
            { status },
          ),
        );
        const result = await engine.getUsageTrace(TARGET, { limit: 100, cursor: 'c1' });
        if (result.ok) throw new Error('expected http failure');
        expect(result.failure).toMatchObject({
          kind: 'http',
          httpStatus: status,
          engineCode: code,
          requestId: 'req-c',
        });
      }
    });

    it('429 的 Retry-After 解析（整数秒；HTTP-date/非法值丢弃）', async () => {
      const engine = engineWith(
        fakeResponse(
          { error: { code: 'overloaded', message: 'slow down', retryable: true } },
          { status: 429, headers: { 'Retry-After': '7' } },
        ),
      );
      const result = await engine.getUsageTrace(TARGET, { limit: 100 });
      if (result.ok) throw new Error('expected http failure');
      expect(result.failure).toMatchObject({
        kind: 'http',
        httpStatus: 429,
        retryAfterSeconds: 7,
      });

      const dateHeader = engineWith(
        fakeResponse(
          { error: { code: 'overloaded', message: 'slow down', retryable: true } },
          { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } },
        ),
      );
      const dateResult = await dateHeader.getUsageTrace(TARGET, { limit: 100 });
      if (dateResult.ok) throw new Error('expected http failure');
      expect(dateResult.failure.retryAfterSeconds).toBeUndefined();
    });
  });
});
