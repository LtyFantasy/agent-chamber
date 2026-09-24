/**
 * typesafe.judgment-provider 单测（直连 TypeSafe 官方 REST）。
 *
 * 设计意图（承自已退役 jev 网关适配器的同源口径）——判别是 **fail-open** 的 observe 期增强，
 * 它在生产里唯一正确的失败形态是"落一行 error/timeout 日志 + 主流程 200"。故这里逐条钉死：
 * 任何上游异常（HTTP 非 200 / 超时 / 空体 / 非 JSON / 白名单不过）都必须返回结果对象而
 * **不是抛错**，且 **outcome 整对象**（含 `response.raw` 里的上游 200 体原文，它会整块落进
 * 训练语料表）都不得出现 API Key 或上游错误体原文。
 *
 * 本 provider 独有的三条硬契约：① 快照 `model` 取**响应自报**（config 里的请求模型只是请求
 * 参数，两者可以不同）；② `redirect: 'error'`（防 307/308 把带 key 与正文的 POST 原样重发）；
 * ③ **body 读阶段超时也判 timeout**（失败率分母口径依赖这个分码）。
 *
 * 密钥纪律（仓库 NIT-1）：本文件的 key 假值**全合成**——只借用公开前缀形态，后缀与任何真实
 * Key 无关；断言标记一律取自假值内部，绝不出现真 Key 的任何片段。
 */
import type { ExperienceCheckInput, JudgmentOutcome } from './judgment-provider.interface';
import { JUDGMENT_CONTENT_EXCERPT_LIMIT } from './judgment-rubric';
import { buildTypesafeSystemoneUrl, TypeSafeJudgmentProvider } from './typesafe.judgment-provider';

const BASE_URL = 'https://api.typesafe.test/';
/** 合成假 key（前缀是公开形态，后缀全合成；绝不含真实 Key 任何连续片段） */
const API_KEY = 'apikey_' + 'A1b2c3d4e5'.repeat(4);
/** 请求模型（响应会自报另一个版本 ID，用于断言"请求值 ≠ 快照值"） */
const REQUEST_MODEL = 'jev-latest';
/** 上游自报模型（实弹形状：响应顶层 `model`） */
const UPSTREAM_MODEL = 'jev-1.13.0';

/**
 * **真实 `fetch` 引用**（模块加载期抓取，早于任何 mock 安装）。
 *
 * 为什么必须显式保存：单测用 `globalThis.fetch = jest.fn()` 做全局替换，而 **jest 的
 * `beforeEach` 对嵌套 describe 同样生效**——live 块若不还原真实现，它就会打到 mock
 * （未设 `mockResolvedValue` ⇒ `fetch()` 返回 undefined ⇒ `response.ok` 处 TypeError）。
 * 症状特征：10 次"真网络调用"却在 1.5s 内跑完。
 */
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/** 合法官方响应体（实弹形状 `{model, answers, usage}`） */
function officialPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: UPSTREAM_MODEL,
    answers: {
      completeness: {
        type: 'score',
        score: 1.85,
        confidence: 0.7,
        legend: { 0: 'missing', 1: 'thin', 2: 'partial', 3: 'complete' },
        probabilities: { 0: 0, 1: 0.23, 2: 0.7, 3: 0.07 },
      },
      reusability: {
        type: 'score',
        score: 1.76,
        confidence: 0.64,
        legend: { 0: 'one_off', 1: 'narrow', 2: 'broad' },
        probabilities: { 0: 0, 1: 0.24, 2: 0.76 },
      },
      signalQuality: {
        type: 'score',
        score: 1.43,
        confidence: 0.32,
        legend: { 0: 'noise', 1: 'weak', 2: 'distinctive' },
        probabilities: { 0: 0.01, 1: 0.55, 2: 0.44 },
      },
      duplicate: { type: 'choice', choice: 'distinct', confidence: 0.92 },
      intentSuggestion: { type: 'choice', choice: 'keep', confidence: 0.51 },
      domainSuggestion: { type: 'choice', choice: 'docker', confidence: 0.97 },
      // 第 7 维（v1.82.0）：准入建议（choice 三值）
      admissionSuggestion: { type: 'choice', choice: 'needs_human', confidence: 0.42 },
    },
    usage: { input_tokens: 845, output_tokens: 200 },
    ...overrides,
  });
}

const INPUT: ExperienceCheckInput = {
  title: 'pg 连不上 8744',
  summary: 'ECONNREFUSED',
  content: '## Fix\nrestart container',
  signals: ['econnrefused'],
  domains: ['docker'],
  env: { os: 'ubuntu22' },
  intent: 'repair',
  duplicateCandidates: [],
  availableDomains: ['docker', 'postgres'],
};

/**
 * 深扫描：收集对象里**所有字符串与键名**并逐条断言不含敏感片段。
 *
 * 为什么必须覆盖 `response.raw`：上游 200 体是**原样留档**进语料表的（jsonb），
 * 只查 `response.error` 会漏掉"成功响应里夹着回显"这条最隐蔽的泄漏路径。
 *
 * @param value 待扫描对象（outcome 整对象）
 * @param forbidden 禁止出现的片段（缺省 = 本文件合成的假 key）
 */
function expectNoLeak(value: unknown, forbidden: readonly string[] = [API_KEY]): void {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      texts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        texts.push(key);
        walk(child);
      }
    }
  };
  walk(value);
  for (const text of texts) {
    for (const secret of forbidden) expect(text).not.toContain(secret);
  }
}

describe('TypeSafeJudgmentProvider', () => {
  let provider: TypeSafeJudgmentProvider;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    provider = new TypeSafeJudgmentProvider({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model: REQUEST_MODEL,
      timeoutMs: 8000,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 断言请求侧契约（每次调用都应满足） */
  function expectRequestContract(): RequestInit {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // 端点 = {API 根}/v1/systemone（根带尾斜杠也要规整，否则 //v1 404）
    expect(url).toBe('https://api.typesafe.test/v1/systemone');
    expect(init.method).toBe('POST');
    // 防 307/308 把带 key 与正文的 POST 原样重发到第三方
    expect(init.redirect).toBe('error');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // 请求体三键：state / model / questions（日志 request 载荷 = 实际发包体）
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body.model).toBe(REQUEST_MODEL);
    const state = body.state as Record<string, unknown>;
    expect(state.contentTruncated).toBe(false);
    return init;
  }

  describe('成功路径', () => {
    it('ok：请求体 = {state, model, questions} + Bearer 鉴权 + redirect:error', async () => {
      fetchMock.mockResolvedValue(new Response(officialPayload(), { status: 200 }));

      const outcome = await provider.checkEntry(INPUT);
      expectRequestContract();
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      // 日志载荷就是发包体（含当次模型名：训练脚本要能复现"问了什么、用的哪个模型"）
      expect(outcome.request.model).toBe(REQUEST_MODEL);
      expect(Object.keys(outcome.request).sort()).toEqual(['model', 'questions', 'state']);
      expectNoLeak(outcome);
    });

    it('ok：七维归一化 + **快照 model 取响应自报**（≠ 请求模型）', async () => {
      fetchMock.mockResolvedValue(new Response(officialPayload(), { status: 200 }));

      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;

      expect(outcome.judgment.provider).toBe('typesafe');
      // 快照值是**上游自报**：配置里的请求模型只是请求参数，不得顶替它
      expect(outcome.judgment.model).toBe(UPSTREAM_MODEL);
      expect(outcome.judgment.model).not.toBe(REQUEST_MODEL);
      expect(outcome.judgment.judgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(outcome.judgment.completeness).toEqual({ level: 'partial', confidence: 0.7 });
      expect(outcome.judgment.signalQuality).toEqual({ level: 'weak', confidence: 0.32 });
      expect(outcome.judgment.duplicate).toEqual({ verdict: 'distinct', confidence: 0.92 });
      expect(outcome.judgment.intentSuggestion).toEqual({
        verdict: 'keep',
        value: null,
        confidence: 0.51,
      });
      expect(outcome.judgment.domainSuggestion).toEqual({
        verdict: 'suggested',
        value: 'docker',
        confidence: 0.97,
      });
      // 第 7 维（v1.82.0）：准入建议（observe-only 建议文本，不影响任何写入行为）
      expect(outcome.judgment.admissionSuggestion).toEqual({
        verdict: 'needs_human',
        confidence: 0.42,
      });
      // rubric 代际写入快照（训练/校准数据据此分代统计）
      expect(outcome.judgment.rubricVersion).toBe('v2');
      // 语料价值：raw 原样留档（含 probabilities / usage）
      expect(outcome.response.raw).toMatchObject({ model: UPSTREAM_MODEL });
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
      expectNoLeak(outcome);
    });

    it('长正文：state.content 截到 2000 且带截断标记（体积纪律在发包侧就生效）', async () => {
      fetchMock.mockResolvedValue(new Response(officialPayload(), { status: 200 }));
      const longInput = { ...INPUT, content: 'x'.repeat(JUDGMENT_CONTENT_EXCERPT_LIMIT + 100) };

      const outcome = await provider.checkEntry(longInput);
      if (outcome.status !== 'ok') throw new Error('expected ok');
      const state = outcome.request.state as Record<string, unknown>;
      expect(String(state.content)).toHaveLength(JUDGMENT_CONTENT_EXCERPT_LIMIT);
      expect(state.contentTruncated).toBe(true);
    });

    it('端点拼接：API 根带/不带尾斜杠都规整到 {根}/v1/systemone', () => {
      expect(buildTypesafeSystemoneUrl('https://api.typesafe.ai')).toBe(
        'https://api.typesafe.ai/v1/systemone',
      );
      expect(buildTypesafeSystemoneUrl('https://api.typesafe.ai//')).toBe(
        'https://api.typesafe.ai/v1/systemone',
      );
    });
  });

  describe('失败路径（全部 fail-open：返回结果对象，永不 throw）', () => {
    it('HTTP 401 裸 JSON → error：固定标签，且**不回显上游错误体原文**', async () => {
      fetchMock.mockResolvedValue(
        new Response(`{"error":"unauthorized: invalid key ${API_KEY}"}`, { status: 401 }),
      );

      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      const error = String((outcome.response as { error: string }).error);
      expect(error).toContain('credential');
      expect(error).toContain('401');
      expect(error).not.toContain('unauthorized');
      expectNoLeak(outcome);
    });

    it('HTTP 403 → error：同样点名凭证问题', async () => {
      fetchMock.mockResolvedValue(new Response('forbidden', { status: 403 }));
      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      expect(String((outcome.response as { error: string }).error)).toContain('credential');
      expectNoLeak(outcome);
    });

    it('HTTP 422 → error：固定标签 `validation failed (HTTP 422)`，**回显夹具整块不进日志**', async () => {
      // 夹具模拟官方 422：detail 回显请求片段（正文 + key 形态串）——一个字都不许进 response。
      // canary 必须是**上游体独有**的串：请求载荷里合法出现的内容（如 INPUT.summary）不能用
      const echoCanary = 'upstream-echo-canary';
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: [
              {
                loc: ['body', 'state', 'content'],
                msg: 'content too long',
                input: `${echoCanary} — request echoed key ${API_KEY}`,
              },
            ],
          }),
          { status: 422 },
        ),
      );

      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      const response = outcome.response as { error: string };
      expect(response.error).toBe('judgment provider validation failed (HTTP 422)');
      expectNoLeak(outcome); // key 不得出现在 outcome 任何角落
      expectNoLeak(response, [echoCanary, API_KEY]); // 上游回显内容不得进 response
    });

    it('HTTP 429 → error：固定标签带 `— upstream asks for backoff`', async () => {
      fetchMock.mockResolvedValue(new Response('slow down', { status: 429 }));
      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      expect(String((outcome.response as { error: string }).error)).toBe(
        'judgment provider rate limited (HTTP 429) — upstream asks for backoff',
      );
      expectNoLeak(outcome);
    });

    it('HTTP 529 → error：固定标签带 `— upstream asks for backoff`', async () => {
      fetchMock.mockResolvedValue(new Response('overloaded', { status: 529 }));
      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      expect(String((outcome.response as { error: string }).error)).toBe(
        'judgment provider overloaded (HTTP 529) — upstream asks for backoff',
      );
      expectNoLeak(outcome);
    });

    it('HTTP 500 → error（只回状态码，不回错误体）', async () => {
      fetchMock.mockResolvedValue(new Response('upstream boom with secret=abc', { status: 500 }));
      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      const error = String((outcome.response as { error: string }).error);
      expect(error).toContain('500');
      expect(error).not.toContain('boom');
      expectNoLeak(outcome, [API_KEY, 'boom', 'secret']);
    });

    it('网络不可达（transport error）→ error（不 throw）', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }));
      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      expect(String((outcome.response as { error: string }).error)).toContain('transport');
      expectNoLeak(outcome);
    });

    it('`redirect:"error"` 命中（fetch 拒绝）→ 落 transport 分类且文案点名 redirect', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('unexpected redirect'), { name: 'TypeError' }),
      );
      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      expect(String((outcome.response as { error: string }).error)).toContain('redirect');
      expectNoLeak(outcome);
    });

    it('超时（fetch 阶段 TimeoutError）→ **status=timeout**（与 error 分码）', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('timeout');
      expect(String((outcome.response as { error: string }).error)).toContain('8000ms');
      expectNoLeak(outcome);
    });

    it('超时（**body 读阶段** AbortError）→ 仍判 status=timeout（失败率分母口径依赖此分码）', async () => {
      // 连接已建立、body 未读完时超时：`response.text()` 拒绝——若记成 error，超时会被混进"真故障"
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      } as unknown as Response);

      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('timeout');
      expect(String((outcome.response as { error: string }).error)).toContain('8000ms');
      expectNoLeak(outcome);
    });

    it('空 body（网关异常兜底）→ error（不是 500/抛错）', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 200 }));
      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      expect(String((outcome.response as { error: string }).error)).toContain('empty body');
      expectNoLeak(outcome);
    });

    it('非 JSON body → error', async () => {
      fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }));
      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      expect(String((outcome.response as { error: string }).error)).toContain('not JSON');
      expectNoLeak(outcome);
    });

    it('白名单校验失败（answers 形状破损）→ error 且**不落快照**（rawShape 只存键名）', async () => {
      // 上游在成功响应里夹了一段"像正文/凭证"的内容：它不得进 error，也不得随快照落库
      const echoCanary = 'upstream-echo-canary';
      fetchMock.mockResolvedValue(
        new Response(
          officialPayload({
            answers: {},
            echo: `${echoCanary} ${API_KEY}`,
          }),
          { status: 200 },
        ),
      );

      const outcome = await provider.checkEntry(INPUT);
      expect(outcome.status).toBe('error');
      // 不落半真快照（快照会被 reviewer 当 ground truth 对照）
      expect('judgment' in outcome).toBe(false);
      const response = outcome.response as { error: string; rawShape?: string[] };
      expect(response.error).toContain('whitelist');
      // rawShape 只留"形状诊断"的**键名**（`echo` 是键名，允许；键值是回显载荷，不允许）
      expect(response.rawShape).toEqual(['model', 'answers', 'usage', 'echo']);
      expectNoLeak(outcome); // key 不得出现在 outcome 任何角落
      expectNoLeak(response, [echoCanary]); // 回显载荷的**值**不得出现（键名 echo 除外）
    });
  });

  /**
   * 实弹用例（**双闸门控**）：`TYPESAFE_LIVE=1` **且** `TYPESAFE_API_KEY` 在场才跑。
   *
   * 为什么双闸：单个 `TYPESAFE_API_KEY` 在场是常态（开发者 shell / CI 可能恰好 export 了它），
   * 只按 key 判会日常 `pnpm test` 打真 API 烧额度；显式的 `TYPESAFE_LIVE=1` 让"要花钱"成为
   * 一个**主动**决定（主脑 Step 4 的部署前拦截闸即此用例）。
   */
  const liveEnabled = process.env.TYPESAFE_LIVE === '1' && !!process.env.TYPESAFE_API_KEY?.trim();
  const describeLive = liveEnabled ? describe : describe.skip;

  describeLive('live（双闸门控：TYPESAFE_LIVE=1 且 TYPESAFE_API_KEY 在场）', () => {
    /** 样本数：p95 需要足够样本才有意义（plan：≥10 次） */
    const SAMPLES = 10;

    /**
     * **还原真实 fetch**（见文件头 `realFetch` 的 rationale）。
     *
     * 外层 describe 的 beforeEach 已把 `globalThis.fetch` 换成 mock，而嵌套 describe
     * **同样会跑外层钩子**——不还原就会打到 mock（返回 undefined）。
     */
    beforeEach(() => {
      (globalThis as { fetch: unknown }).fetch = realFetch;
    });

    /** 跑完装回 mock（同文件其余用例依赖它；外层 beforeEach 每例也会重装，此处是防御性） */
    afterEach(() => {
      (globalThis as { fetch: unknown }).fetch = jest.fn();
    });

    it(`${SAMPLES} 次实弹：六维归一化 + provider=typesafe + 快照 model=自报 + p95 对照 8000ms`, async () => {
      // 防线自检：本用例绝不能落在 mocked fetch 上（历史 bug：打到 mock ⇒ 读 undefined.ok ⇒ TypeError）
      expect((globalThis as { fetch: unknown }).fetch).toBe(realFetch);

      const live = new TypeSafeJudgmentProvider({
        baseUrl: process.env.TYPESAFE_BASE_URL?.trim() || 'https://api.typesafe.ai',
        apiKey: (process.env.TYPESAFE_API_KEY as string).trim(),
        model: process.env.TYPESAFE_DEFAULT_MODEL?.trim() || 'jev-latest',
        timeoutMs: Number(process.env.JUDGMENT_TIMEOUT_MS ?? 8000) || 8000,
      });

      const latencies: number[] = [];
      for (let index = 0; index < SAMPLES; index += 1) {
        const outcome: JudgmentOutcome = await live.checkEntry(INPUT);
        expect(outcome.status).toBe('ok');
        if (outcome.status !== 'ok') return;
        expect(outcome.judgment.provider).toBe('typesafe');
        // 响应自报版本 ID（'unknown' = 上游没给 model，属契约破损）
        expect(outcome.judgment.model).not.toBe('unknown');
        // 六维齐全或逐维合法 null：归一化在官方 REST 上同样成立
        for (const dim of [
          'completeness',
          'reusability',
          'signalQuality',
          'duplicate',
          'intentSuggestion',
          'domainSuggestion',
        ]) {
          expect(outcome.judgment).toHaveProperty(dim);
        }
        latencies.push(outcome.latencyMs);
        expectNoLeak(outcome);
        // 快照证据留档（六维 + 上游自报 model）：末次样本落一行，供实弹报告直接引用
        if (index === SAMPLES - 1) {
          console.log(`[typesafe live] snapshot=${JSON.stringify(outcome.judgment)}`);
        }
      }

      // 结论必须显式落出来（plan §4：p95 latencyMs **有记录**且对照 8000 有结论）：
      // 该块只在双闸门下运行，这行日志就是"本次实弹"的证据；spec 文件不在 eslint 覆盖面内
      const sorted = [...latencies].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
      console.log(
        `[typesafe live] samples=${sorted.length} latencies(ms)=${latencies.join(',')} ` +
          `min=${sorted[0]} p95=${p95} max=${sorted[sorted.length - 1]} budget=8000ms ` +
          `verdict=${p95 <= 8000 ? 'WITHIN_BUDGET' : 'OVER_BUDGET (raise JUDGMENT_TIMEOUT_MS)'}`,
      );
      expect({
        samples: sorted.length,
        p95Ms: p95,
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
      }).toEqual({
        samples: SAMPLES,
        p95Ms: expect.any(Number),
        minMs: expect.any(Number),
        maxMs: expect.any(Number),
      });
      expect(p95).toBeLessThanOrEqual(8000);
    }, 120_000);
  });
});
