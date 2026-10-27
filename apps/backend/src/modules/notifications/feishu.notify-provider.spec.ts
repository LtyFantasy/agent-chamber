/**
 * feishu.notify-provider 单测（token 生命周期 + 错误分派 + 退避预算 + never-throw）。
 *
 * 设计意图：这是**唯一真正发包的叶子**，它的失败模式全都长得像"配置对了但收不到"——所以这里
 * 的断言对象是**分派结果本身**（`kind` / `attempts` / `responseStatus` / `lastError` 与日志），
 * 而不是"函数没抛"。
 *
 * 三条硬边：
 * ① **HTTP 200 不是成功**：飞书业务错误 = `200 + code!==0`。必须有一条用例专门钉死
 *    "200 + code=99991661" 会走鉴权分支（按 `res.ok` 判成功的实现会在这一条上当场红）；
 * ② **凭据绝不外泄**：`lastError` 与日志里不得出现 `app_secret` / `tenant_access_token`
 *    （含"上游把凭据回显在 msg 里"这种最坏情况）；
 * ③ **attempts 如实记且永不上抛**：短路尝试也记 1；任何注入的异常都只返回 failed。
 *
 * ⚠️ HTTP 层用**注入的 `fetchImpl`**（不装 `globalThis.fetch`）：本文件的被测对象是编排逻辑，
 * 注入让每个用例的调用序列可读；`globalThis.fetch` 的**懒包装**另有一条专门用例覆盖
 * （不然"默认路径"就是一段没人跑过的代码）。
 */
import { Logger } from '@nestjs/common';
import type { RenderedNotification } from './notify-provider.interface';
import {
  FEISHU_PROVIDER_KEY,
  FeishuNotifyProvider,
  type FeishuProviderOptions,
} from './feishu.notify-provider';

/** 合成凭据（**不是任何真实值**；断言里用来查"有没有泄漏"） */
const APP_ID = 'cli_synthetic_app_id';
const APP_SECRET = 'synthetic_secret_never_logged';
const TOKEN_1 = 't-synthetic-token-one';
const TOKEN_2 = 't-synthetic-token-two';
const OPEN_ID = 'ou_synthetic_open_id';
const MESSAGE_ID = 'om_synthetic_message_id';

const TOKEN_URL_MARKER = 'tenant_access_token/internal';
const MESSAGES_URL_MARKER = '/im/v1/messages';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** 一次被记录的 fetch 调用（断言请求形状用） */
interface RecordedCall {
  url: string;
  init?: FetchInit;
}

// ─────────────────────────────── 响应构造 ───────────────────────────────

/** 上游 JSON 响应（`text()` 是唯一被读的通道——实现刻意不用 `json()`） */
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** 不可解析响应（体是任意文本） */
function rawResponse(status: number, text: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

/** 读体阶段抛异常的响应（AbortError / 连接中断） */
function unreadableResponse(status: number, errorName: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.reject(Object.assign(new Error('read failed'), { name: errorName })),
  } as unknown as Response;
}

/** token 成功响应（实弹形状：`{code:0, tenant_access_token, expire}`，expire 单位秒） */
function tokenOk(token: string, expire: number | undefined = 7200): Response {
  return jsonResponse(200, {
    code: 0,
    msg: 'ok',
    tenant_access_token: token,
    ...(expire === undefined ? {} : { expire }),
  });
}

/** 发消息成功响应（实弹形状：`{code:0, data:{message_id}}`） */
function messageOk(messageId: string = MESSAGE_ID): Response {
  return jsonResponse(200, { code: 0, msg: 'success', data: { message_id: messageId } });
}

/** 上游业务错误（**HTTP 200 + code!==0**——本文件最重要的一类） */
function businessError(code: number | string, msg = 'synthetic upstream message'): Response {
  return jsonResponse(200, { code, msg });
}

// ─────────────────────────────── 测试装置 ───────────────────────────────

/**
 * 顺序脚本化的 fetch（每一步 = 一次调用）。
 *
 * 用**脚本**而不是"按 URL 路由"：token/重试/重取的**顺序**本身就是被测行为
 * （"第二次 message 用了新 token"这类断言只能靠顺序看出）。
 */
function scriptedFetch(steps: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const mock = jest.fn(async (input: FetchInput, init?: FetchInit) => {
    const index = calls.length;
    calls.push({ url: String(input), init });
    const step = steps[index];
    if (step === undefined) {
      throw new Error(`unexpected extra fetch call #${index + 1} (script exhausted)`);
    }
    if (step instanceof Error) throw step;
    return step;
  });
  return { fetchImpl: mock as unknown as typeof fetch, calls };
}

/** 取调用序列里某一跳的所有调用 */
const callsTo = (calls: RecordedCall[], marker: string): RecordedCall[] =>
  calls.filter((call) => call.url.includes(marker));

/** 解析请求体（我们的实现总是发 JSON 字符串） */
const bodyOf = (call: RecordedCall): Record<string, unknown> =>
  JSON.parse(String(call.init?.body)) as Record<string, unknown>;

/** 取请求头（我们的实现传的是普通对象） */
const headersOf = (call: RecordedCall): Record<string, string> =>
  (call.init?.headers ?? {}) as Record<string, string>;

/** 成品通知（出境面形状） */
function renderedNotification(overrides: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    category: 'task_done',
    eventId: '3f8a1c2e-0000-4000-8000-000000000001',
    title: '[完工] 合成任务',
    body: '看板「合成看板」 · 合成操作者',
    link: 'https://web.test/tasks/3f8a1c2e-0000-4000-8000-000000000001',
    recipient: OPEN_ID,
    ...overrides,
  };
}

describe('FeishuNotifyProvider', () => {
  /** 可控时钟（token 过期 / 预算耗尽都靠它制造，**不依赖真实时间**） */
  let clock: number;

  /** 默认装置：退避基准 0（免真实等待）、时钟注入、凭据齐全 */
  function buildProvider(overrides: Partial<FeishuProviderOptions> = {}): FeishuNotifyProvider {
    return new FeishuNotifyProvider({
      appId: APP_ID,
      appSecret: APP_SECRET,
      httpTimeoutMs: 5000,
      retryBaseDelayMs: 0,
      now: () => clock,
      ...overrides,
    });
  }

  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 所有日志行拼起来（凭据泄漏断言用） */
  function allLoggedText(): string {
    const spies: Array<jest.SpyInstance> = [logSpy, warnSpy, errorSpy];
    return spies
      .flatMap((spy) =>
        (spy.mock.calls as unknown[][]).map((call) =>
          call.map((arg: unknown) => String(arg)).join(' '),
        ),
      )
      .join('\n');
  }

  it('key 恒为 feishu（与 config 值域、投递记录 channel 列三处同源）', () => {
    expect(buildProvider().key).toBe(FEISHU_PROVIDER_KEY);
    expect(buildProvider().key).toBe('feishu');
  });

  // ═══════════════════════ 1. 成功路径 ═══════════════════════

  it('成功路径：token → 发消息 ⇒ success、attempts=1、responseStatus=200、deliveredAt 非空', async () => {
    const { fetchImpl, calls } = scriptedFetch([tokenOk(TOKEN_1), messageOk()]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('success');
    expect(outcome.attempts).toBe(1);
    expect(outcome.responseStatus).toBe(200);
    expect(outcome.lastError).toBeNull();
    expect(outcome.deliveredAt).toBeInstanceOf(Date);
    expect(calls).toHaveLength(2);
  });

  it('请求形状：token 跳带 app_id/app_secret；消息跳带 receive_id_type=open_id + Bearer + 纯文本拼接', async () => {
    const { fetchImpl, calls } = scriptedFetch([tokenOk(TOKEN_1), messageOk()]);
    await buildProvider({ fetchImpl }).send(renderedNotification());

    const tokenCall = callsTo(calls, TOKEN_URL_MARKER)[0];
    expect(tokenCall.url).toContain(
      'open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    );
    expect(bodyOf(tokenCall)).toEqual({ app_id: APP_ID, app_secret: APP_SECRET });

    const messageCall = callsTo(calls, MESSAGES_URL_MARKER)[0];
    expect(messageCall.url).toContain('receive_id_type=open_id');
    expect(headersOf(messageCall).authorization).toBe(`Bearer ${TOKEN_1}`);
    const body = bodyOf(messageCall);
    expect(body.receive_id).toBe(OPEN_ID);
    expect(body.msg_type).toBe('text');
    // content 是**字符串化的 JSON**（双层编码），text = title 换行 body 换行 link
    expect(typeof body.content).toBe('string');
    expect(JSON.parse(String(body.content))).toEqual({
      text: '[完工] 合成任务\n看板「合成看板」 · 合成操作者\nhttps://web.test/tasks/3f8a1c2e-0000-4000-8000-000000000001',
    });
  });

  it('link 为 null ⇒ 文本不留尾部空行（只有 title 与 body 两段）', async () => {
    const { fetchImpl, calls } = scriptedFetch([tokenOk(TOKEN_1), messageOk()]);
    await buildProvider({ fetchImpl }).send(renderedNotification({ link: null }));

    const body = bodyOf(callsTo(calls, MESSAGES_URL_MARKER)[0]);
    expect(JSON.parse(String(body.content))).toEqual({
      text: '[完工] 合成任务\n看板「合成看板」 · 合成操作者',
    });
  });

  it('未注入 fetchImpl ⇒ 走**调用时**取全局 fetch 的默认路径（后装 mock 也能命中）', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: FetchInput) =>
        String(input).includes(TOKEN_URL_MARKER) ? tokenOk(TOKEN_1) : messageOk(),
      );

    const outcome = await buildProvider().send(renderedNotification());

    expect(outcome.status).toBe('success');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ═══════════════════════ 2. token 缓存 ═══════════════════════

  it('缓存命中：连续两条通知只换 1 次 token（第二次直用缓存）', async () => {
    const { fetchImpl, calls } = scriptedFetch([tokenOk(TOKEN_1), messageOk(), messageOk()]);
    const provider = buildProvider({ fetchImpl });

    await provider.send(renderedNotification());
    await provider.send(renderedNotification());

    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(1);
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(2);
  });

  it('远未过期不刷新：推进 1 小时（离 5min 提前量还远）仍用缓存', async () => {
    const { fetchImpl, calls } = scriptedFetch([tokenOk(TOKEN_1), messageOk(), messageOk()]);
    const provider = buildProvider({ fetchImpl });

    await provider.send(renderedNotification());
    clock += 60 * 60 * 1000;
    await provider.send(renderedNotification());

    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(1);
  });

  it('临近过期（剩余 <5min）⇒ 提前刷新（过期风暴的护栏）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      messageOk(),
      tokenOk(TOKEN_2),
      messageOk(),
    ]);
    const provider = buildProvider({ fetchImpl });

    await provider.send(renderedNotification());
    // expiresAt = T + 7200s；提前量 300s ⇒ T+6900s 起应刷新
    clock += 6_900_000;
    await provider.send(renderedNotification());

    const tokenCalls = callsTo(calls, TOKEN_URL_MARKER);
    expect(tokenCalls).toHaveLength(2);
    // 第二条消息用的是**新** token
    expect(headersOf(callsTo(calls, MESSAGES_URL_MARKER)[1]).authorization).toBe(
      `Bearer ${TOKEN_2}`,
    );
  });

  it('上游没给 expire ⇒ 兜底 7200s（不会退化成"每次都刷新"）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1, undefined),
      messageOk(),
      messageOk(),
    ]);
    const provider = buildProvider({ fetchImpl });

    await provider.send(renderedNotification());
    clock += 60 * 60 * 1000;
    await provider.send(renderedNotification());

    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(1);
  });

  // ═══════════════════════ 3. in-flight 去重 ═══════════════════════

  it('N 并发只发 1 次 token 请求（in-flight promise 共享）', async () => {
    let releaseToken: (response: Response) => void = () => undefined;
    const tokenGate = new Promise<Response>((resolve) => {
      releaseToken = resolve;
    });
    const calls: RecordedCall[] = [];
    const fetchImpl = jest.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: String(input), init });
      if (String(input).includes(TOKEN_URL_MARKER)) return tokenGate;
      return messageOk();
    }) as unknown as typeof fetch;

    const provider = buildProvider({ fetchImpl });
    const inFlight = [1, 2, 3, 4, 5].map(() => provider.send(renderedNotification()));

    // token 还没回来：此刻只应有 1 次 token 调用（其余 4 个在共享同一个 promise）
    await new Promise((resolve) => setImmediate(resolve));
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(1);

    releaseToken(tokenOk(TOKEN_1));
    const outcomes = await Promise.all(inFlight);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'success',
      'success',
      'success',
      'success',
      'success',
    ]);
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(1);
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(5);
  });

  it('在途 token 失败被共享，且**失败不写缓存**（下次重新取）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      tokenOk(TOKEN_2),
      messageOk(),
    ]);
    const provider = buildProvider({ fetchImpl });

    const both = await Promise.all([
      provider.send(renderedNotification(), { maxAttempts: 1 }),
      provider.send(renderedNotification(), { maxAttempts: 1 }),
    ]);
    expect(both.map((outcome) => outcome.status)).toEqual(['failed', 'failed']);
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(1);

    // 失败没进缓存：下一次调用重新换 token
    const after = await provider.send(renderedNotification());
    expect(after.status).toBe('success');
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(2);
  });

  // ═══════════════════════ 4. 鉴权族：清缓存 + 重取 + 重试 1 次 ═══════════════════════

  it('200 + code=99991661（token 无效）⇒ 清缓存重取并重试一次 ⇒ success、attempts=2', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      businessError(99991661, 'invalid access token'),
      tokenOk(TOKEN_2),
      messageOk(),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('success');
    expect(outcome.attempts).toBe(2);
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(2);
    const messageCalls = callsTo(calls, MESSAGES_URL_MARKER);
    expect(messageCalls).toHaveLength(2);
    expect(headersOf(messageCalls[0]).authorization).toBe(`Bearer ${TOKEN_1}`);
    expect(headersOf(messageCalls[1]).authorization).toBe(`Bearer ${TOKEN_2}`);
  });

  it('连续两次鉴权失败 ⇒ 收口（不再有第 3 次尝试，避免把配错放大成 3 倍请求）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      businessError(99991661, 'invalid access token'),
      tokenOk(TOKEN_2),
      businessError(99991661, 'invalid access token'),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(2);
    expect(outcome.lastError).toContain('auth:');
    expect(outcome.lastError).toContain('99991661');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(2);
  });

  it('HTTP 401 也归鉴权族（token 被拒的另一种表达）⇒ 清缓存重试一次', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      jsonResponse(401, { code: 99991668, msg: 'unauthorized' }),
      tokenOk(TOKEN_2),
      messageOk(),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('success');
    expect(outcome.attempts).toBe(2);
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(2);
  });

  it('鉴权重试同样受 maxAttempts 夹逼：maxAttempts=1 ⇒ 不重试', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      businessError(99991661, 'invalid access token'),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification(), { maxAttempts: 1 });

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(1);
  });

  // ═══════════════════════ 5. 业务 / 频控 / HTTP 分派 ═══════════════════════

  it('200 + code=230001（receive_id 非法）⇒ business、**不重试**、code 与 msg 入错误串', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      businessError(230001, 'invalid receive_id'),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(outcome.responseStatus).toBe(200);
    expect(outcome.lastError).toContain('business:');
    expect(outcome.lastError).toContain('230001');
    expect(outcome.lastError).toContain('invalid receive_id');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(1);
  });

  it('HTTP 429 ⇒ rate_limited **单独标识**、不重试（退避秒级救不回分钟级窗口）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      jsonResponse(429, { code: 99991400, msg: 'too many requests' }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(outcome.responseStatus).toBe(429);
    expect(outcome.lastError).toContain('rate_limited:');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(1);
  });

  it('HTTP 429 且**体不可解析**（网关错误页）⇒ 仍判 rate_limited，不重试', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      rawResponse(429, '<html>rate limited by gateway</html>'),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastError).toContain('rate_limited:');
    // 体没解析出来也不能把体内容带出来
    expect(outcome.lastError).not.toContain('gateway');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(1);
  });

  it('200 + code=230002（频控码族）⇒ 同样标识为 rate_limited（HTTP 并非 429）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      businessError(230002, 'frequency limit'),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).toContain('rate_limited:');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(1);
  });

  it('HTTP 500 ⇒ http 类可重试：默认档跑满 3 次尝试后收口', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      jsonResponse(500, { code: 0, msg: 'server error' }),
      jsonResponse(500, { code: 0, msg: 'server error' }),
      jsonResponse(500, { code: 0, msg: 'server error' }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(3);
    expect(outcome.responseStatus).toBe(500);
    expect(outcome.lastError).toContain('http:');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(3);
    // token 只在第一次换（后续尝试复用缓存）
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(1);
  });

  it('HTTP 400 ⇒ 不重试（重试只会重复同一个拒绝）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      jsonResponse(400, { code: 230001, msg: 'bad request' }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.attempts).toBe(1);
    expect(outcome.responseStatus).toBe(400);
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(1);
  });

  it('HTTP 200 但体不是 JSON ⇒ invalid_response，归"可重试"（交付状态不可判定）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      rawResponse(200, '<html>proxy error</html>'),
      rawResponse(200, '<html>proxy error</html>'),
      rawResponse(200, '<html>proxy error</html>'),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(3);
    expect(outcome.lastError).toContain('invalid_response:');
    // 只报"多少字符的意外内容"，**不回显内容本身**
    expect(outcome.lastError).toContain('chars of unexpected body');
    expect(outcome.lastError).not.toContain('proxy error');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(3);
  });

  it('HTTP 200 + `{}`（无 code）⇒ fail-closed 判失败，不谎报送达', async () => {
    const { fetchImpl } = scriptedFetch([tokenOk(TOKEN_1), jsonResponse(200, {})]);
    const outcome = await buildProvider({ fetchImpl }).send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).toContain('business:');
  });

  it('token 跳被拒（200 + code=99991663）⇒ business，且**一条消息请求都不发**', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      businessError(99991663, 'app not found'),
      // 任何后续调用都会让 scriptedFetch 抛错 ⇒ 用例同时钉死"不该有第二次请求"
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastError).toContain('tenant_access_token request');
    expect(outcome.lastError).toContain('99991663');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(0);
  });

  it('token 跳成功但**没有 token 字段** ⇒ invalid_response（契约变了要看得见）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(200, { code: 0, expire: 7200 }),
      jsonResponse(200, { code: 0, expire: 7200 }),
      jsonResponse(200, { code: 0, expire: 7200 }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).toContain('invalid_response:');
    expect(outcome.lastError).toContain('no tenant_access_token');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(0);
  });

  // ═══════════════════════ 6. 超时 ═══════════════════════

  it('fetch 阶段 TimeoutError ⇒ timeout 类、可重试（默认 3 次），错误串含生效超时', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { fetchImpl, calls } = scriptedFetch([timeout, timeout, timeout]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(3);
    expect(outcome.responseStatus).toBeNull();
    expect(outcome.lastError).toContain('timeout:');
    expect(outcome.lastError).toContain('timed out after 5000ms');
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(3);
  });

  it('读体阶段 AbortError ⇒ 同口径判超时（fetch 与读体不分成两个语义）', async () => {
    // token 只换 1 次（缓存命中），后面 3 步全是"体读不出来的消息响应"
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      unreadableResponse(200, 'AbortError'),
      unreadableResponse(200, 'AbortError'),
      unreadableResponse(200, 'AbortError'),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.attempts).toBe(3);
    expect(outcome.lastError).toContain('timeout:');
    expect(outcome.lastError).toContain('reading the response body');
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(1);
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(3);
  });

  it('单次请求超时被**夹逼到剩余预算**（预算 1000ms ⇒ 报 1000ms 而不是 httpTimeoutMs）', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { fetchImpl } = scriptedFetch([timeout]);
    const provider = buildProvider({ fetchImpl, httpTimeoutMs: 5000 });

    const outcome = await provider.send(renderedNotification(), {
      maxAttempts: 1,
      budgetMs: 1000,
    });

    expect(outcome.lastError).toContain('timed out after 1000ms');
  });

  it('传输层其它异常（连接拒绝）⇒ network 类、固定标签、不回显异常原文', async () => {
    const { fetchImpl } = scriptedFetch([
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { name: 'TypeError' }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification(), { maxAttempts: 1 });

    expect(outcome.lastError).toContain('network:');
    expect(outcome.lastError).toContain('transport layer');
    expect(outcome.lastError).not.toContain('ECONNREFUSED');
  });

  // ═══════════════════════ 7. 预算与重试封顶 ═══════════════════════

  it('maxAttempts=2（直发档）⇒ HTTP 500 时只尝试 2 次（不是事件档的 3 次）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      jsonResponse(500, { code: 0 }),
      jsonResponse(500, { code: 0 }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification(), {
      maxAttempts: 2,
      budgetMs: 10_000,
    });

    expect(outcome.attempts).toBe(2);
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(2);
  });

  it('退避放不进预算 ⇒ 立即收口（不睡一觉再发一次注定超时的请求）', async () => {
    // 每次调用推进 6s：第一次尝试结束已过 12s，而预算只有 10s、退避要 1s
    const calls: RecordedCall[] = [];
    const fetchImpl = jest.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: String(input), init });
      clock += 6000;
      return String(input).includes(TOKEN_URL_MARKER)
        ? tokenOk(TOKEN_1)
        : jsonResponse(500, { code: 0, msg: 'server error' });
    }) as unknown as typeof fetch;
    const provider = buildProvider({ fetchImpl, retryBaseDelayMs: 1000 });

    const outcome = await provider.send(renderedNotification(), {
      maxAttempts: 5,
      budgetMs: 10_000,
    });

    expect(outcome.attempts).toBe(1);
    expect(outcome.lastError).toContain('budget');
    expect(outcome.lastError).toContain('1000ms backoff');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(1);
  });

  it('预算被尝试本身耗尽 ⇒ 尝试数少于 maxAttempts（不硬撑到跑满）', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = jest.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: String(input), init });
      clock += 4000;
      return String(input).includes(TOKEN_URL_MARKER)
        ? tokenOk(TOKEN_1)
        : jsonResponse(500, { code: 0, msg: 'server error' });
    }) as unknown as typeof fetch;
    const provider = buildProvider({ fetchImpl, retryBaseDelayMs: 0 });

    const outcome = await provider.send(renderedNotification(), {
      maxAttempts: 5,
      budgetMs: 20_000,
    });

    expect(outcome.attempts).toBeLessThan(5);
    expect(outcome.attempts).toBeGreaterThanOrEqual(1);
    expect(outcome.lastError).toContain('budget');
  });

  // ═══════════════════════ 8. 短路（未发字节也要记 1 次尝试） ═══════════════════════

  it('无收件人 ⇒ failed、attempts=1、**零 HTTP 请求**', async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const outcome = await buildProvider({ fetchImpl }).send(
      renderedNotification({ recipient: '' }),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(outcome.responseStatus).toBeNull();
    expect(outcome.lastError).toContain('no recipient configured');
    expect(calls).toHaveLength(0);
  });

  it('凭据缺失 ⇒ failed、attempts=1、**零 HTTP 请求**（不会伪装成 401）', async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const provider = buildProvider({ fetchImpl, appId: null, appSecret: '   ' });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastError).toContain('credentials are not configured');
    expect(calls).toHaveLength(0);
  });

  // ═══════════════════════ 9. 永不 throw（端口硬契约） ═══════════════════════

  it('fetch 抛任意异常 ⇒ 只返回 failed，**不上抛**', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('boom from an unexpected place');
    }) as unknown as typeof fetch;

    const outcome = await buildProvider({ fetchImpl }).send(renderedNotification(), {
      maxAttempts: 1,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
  });

  it('fetch 之外的意外异常（同步抛非 Error 值）⇒ catch-all 兜底成 failed 且 attempts 如实', async () => {
    let callCount = 0;
    const hostile = jest.fn(async () => {
      callCount += 1;
      if (callCount === 1) return tokenOk(TOKEN_1);
      // 连"抛出来的东西是 Error"都不假设：裸字符串抛出也必须被 catch-all 兜住
      throw 'a bare string throw';
    }) as unknown as typeof fetch;

    const outcome = await buildProvider({ fetchImpl: hostile }).send(renderedNotification(), {
      maxAttempts: 1,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBeGreaterThanOrEqual(1);
    expect(outcome.deliveredAt).toBeNull();
  });

  it('任何路径都返回合法终态形状（status ∈ {success,failed}、attempts ≥ 1）', async () => {
    const cases: Array<[string, Response | Error]> = [
      ['成功', messageOk()],
      ['业务错误', businessError(230001)],
      ['频控', jsonResponse(429, { code: 99991400 })],
      ['超时', Object.assign(new Error('t'), { name: 'TimeoutError' })],
      ['不可解析', rawResponse(200, 'nope')],
    ];
    for (const [label, step] of cases) {
      const { fetchImpl } = scriptedFetch([tokenOk(TOKEN_1), step, step, step]);
      const outcome = await buildProvider({ fetchImpl }).send(renderedNotification(), {
        maxAttempts: 1,
      });
      expect(['success', 'failed']).toContain(outcome.status);
      expect(outcome.attempts).toBeGreaterThanOrEqual(1);
      expect(label).toBeTruthy();
    }
  });

  // ═══════════════════════ 10. 凭据与响应体不外泄 ═══════════════════════

  it('上游把 app_secret / token 回显在 msg 里 ⇒ lastError 抹成 [redacted] 且截断到 200', async () => {
    const leaked = `credential ${APP_SECRET} token ${TOKEN_1} ` + 'x'.repeat(500);
    const { fetchImpl } = scriptedFetch([tokenOk(TOKEN_1), businessError(230001, leaked)]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).not.toContain(APP_SECRET);
    expect(outcome.lastError).not.toContain(TOKEN_1);
    expect(outcome.lastError).toContain('[redacted]');
    expect(outcome.lastError?.length ?? 0).toBeLessThanOrEqual(200);
  });

  it('全流程日志里不出现 app_secret / token（含鉴权失败与成功两条路径）', async () => {
    const { fetchImpl } = scriptedFetch([
      tokenOk(TOKEN_1),
      businessError(99991661, 'invalid access token'),
      tokenOk(TOKEN_2),
      messageOk(),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('success');
    const logged = allLoggedText();
    expect(logged).not.toContain(APP_SECRET);
    expect(logged).not.toContain(TOKEN_1);
    expect(logged).not.toContain(TOKEN_2);
    // 但换 token 这件事本身要留痕（可 grep 的生命周期信号）
    expect(logged).toContain('tenant_access_token refreshed');
  });

  it('失败路径的 warn 只带分类与类别，不带响应体原文', async () => {
    const { fetchImpl } = scriptedFetch([
      tokenOk(TOKEN_1),
      rawResponse(200, 'SECRET-LOOKING-BODY-CONTENT'),
    ]);
    const provider = buildProvider({ fetchImpl });

    await provider.send(renderedNotification(), { maxAttempts: 1 });

    const warned = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toContain('feishu delivery failed after 1 attempt(s)');
    expect(warned).not.toContain('SECRET-LOOKING-BODY-CONTENT');
  });

  it('凭据抹除**大小写不敏感**（上游把 secret 换个大小写照样漏不出去）', async () => {
    const leaked = `credential ${APP_SECRET.toUpperCase()} and ${APP_SECRET}`;
    const { fetchImpl } = scriptedFetch([tokenOk(TOKEN_1), businessError(230001, leaked)]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification(), { maxAttempts: 1 });

    expect(outcome.lastError).not.toContain(APP_SECRET.toUpperCase());
    expect(outcome.lastError).not.toContain(APP_SECRET);
    expect(outcome.lastError).toContain('[redacted]');
  });

  it('catch-all 的异常原文也过凭据抹除（异常里夹着 secret 也不落库）', async () => {
    // 第 1 次换 token 成功；第 2 次调用抛出的异常文本里夹着 secret（模拟"底层库把请求 dump 进错误"）
    let calls = 0;
    const hostile = jest.fn(async () => {
      calls += 1;
      if (calls === 1) return tokenOk(TOKEN_1);
      throw new Error(`bad request dump: app_secret=${APP_SECRET}`);
    }) as unknown as typeof fetch;
    const provider = buildProvider({ fetchImpl: hostile });

    const outcome = await provider.send(renderedNotification(), { maxAttempts: 1 });

    // classifyThrown 用固定标签 ⇒ 异常原文根本不进 lastError；这一条钉死该纪律
    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).not.toContain(APP_SECRET);
    const logged = allLoggedText();
    expect(logged).not.toContain(APP_SECRET);
  });

  // ═══════════════ 11. review 回归（P1/P2 定点修复的反向断言） ═══════════════

  it('token 跳 429 且体是 HTML ⇒ 仍判 rate_limited（429 先于体可解析性）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      rawResponse(429, '<html>rate limited by gateway</html>'),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(outcome.responseStatus).toBe(429);
    expect(outcome.lastError).toContain('rate_limited:');
    expect(outcome.lastError).not.toContain('gateway');
    expect(calls).toHaveLength(1);
  });

  it('token 跳 401/403 ⇒ **http** 分派（不是 auth：刚取完的 token 没有"清缓存重取"可做）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(401, { code: 99991668, msg: 'unauthorized' }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.status).toBe('failed');
    expect(outcome.attempts).toBe(1);
    expect(outcome.responseStatus).toBe(401);
    expect(outcome.lastError).toContain('http:');
    expect(outcome.lastError).not.toContain('auth:');
    // 401 不重试（4xx：请求本身就是坏的，重试只会重复同一次拒绝）
    expect(calls).toHaveLength(1);
  });

  it('token 跳 5xx ⇒ http 且可重试（跑满事件链路档 3 次）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(503, { code: 0, msg: 'service unavailable' }),
      jsonResponse(503, { code: 0, msg: 'service unavailable' }),
      jsonResponse(503, { code: 0, msg: 'service unavailable' }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification());

    expect(outcome.attempts).toBe(3);
    expect(outcome.responseStatus).toBe(503);
    expect(outcome.lastError).toContain('http:');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(0);
  });

  it('200 + `code: ""` ⇒ **不判成功**（松判 `Number(code)===0` 会把它当送达）', async () => {
    const { fetchImpl } = scriptedFetch([
      tokenOk(TOKEN_1),
      jsonResponse(200, { code: '', msg: 'empty code' }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification(), { maxAttempts: 1 });

    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).toContain('business:');
  });

  it('成功行记**真实**回执状态（上游回 202 就记 202，不硬编码 200）', async () => {
    const { fetchImpl } = scriptedFetch([
      tokenOk(TOKEN_1),
      jsonResponse(202, { code: 0, msg: 'accepted', data: { message_id: MESSAGE_ID } }),
    ]);
    const outcome = await buildProvider({ fetchImpl }).send(renderedNotification());

    expect(outcome.status).toBe('success');
    expect(outcome.responseStatus).toBe(202);
  });

  it('空体（HTTP 200 + 空白）⇒ invalid_response（"体空"分支单独可达）', async () => {
    const { fetchImpl } = scriptedFetch([tokenOk(TOKEN_1), rawResponse(200, '   ')]);
    const outcome = await buildProvider({ fetchImpl }).send(renderedNotification(), {
      maxAttempts: 1,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).toContain('invalid_response:');
    expect(outcome.lastError).toContain('the response body was empty');
  });

  it('预算非法/非正 ⇒ 归一为"进门即已耗尽"：**零 HTTP 请求**，attempts 仍记 1（短路语义）', async () => {
    for (const budgetMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { fetchImpl, calls } = scriptedFetch([]);
      const provider = buildProvider({ fetchImpl });

      const outcome = await provider.send(renderedNotification(), { budgetMs });

      expect(outcome.status).toBe('failed');
      expect(outcome.attempts).toBe(1);
      expect(outcome.lastError).toContain('budget');
      expect(calls).toHaveLength(0);
    }
  });

  it('maxAttempts 非法 ⇒ 回落事件链路档 3 次（不是 NaN 导致的"零尝试"）', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      tokenOk(TOKEN_1),
      jsonResponse(500, { code: 0 }),
      jsonResponse(500, { code: 0 }),
      jsonResponse(500, { code: 0 }),
    ]);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification(), { maxAttempts: Number.NaN });

    expect(outcome.attempts).toBe(3);
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(3);
  });

  it('maxAttempts 封顶 10：手滑的 1000 不会变成 1000 次上游请求（指数退避也不爆）', async () => {
    const steps: Array<Response | Error> = [tokenOk(TOKEN_1)];
    for (let i = 0; i < 10; i += 1) steps.push(jsonResponse(500, { code: 0, msg: 'server error' }));
    const { fetchImpl, calls } = scriptedFetch(steps);
    const provider = buildProvider({ fetchImpl });

    const outcome = await provider.send(renderedNotification(), { maxAttempts: 1000 });

    expect(outcome.attempts).toBe(10);
    expect(outcome.lastError).toContain('http:');
    expect(callsTo(calls, MESSAGES_URL_MARKER)).toHaveLength(10);
  });

  it('事件链路退避就是 1s / 2s（假定时器实测等待，不是"跑完就算"）', async () => {
    jest.useFakeTimers();
    try {
      const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      const { fetchImpl, calls } = scriptedFetch([timeout, timeout, timeout]);
      const provider = buildProvider({ fetchImpl, retryBaseDelayMs: 1000 });

      const pending = provider.send(renderedNotification());
      await jest.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);
      // 第 1 次退避满 1000ms ⇒ 第 2 次尝试
      await jest.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      // 第 2 次退避要 2000ms：1999ms 时还不该有第 3 次
      await jest.advanceTimersByTimeAsync(1999);
      expect(calls).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(3);

      const outcome = await pending;
      expect(outcome.attempts).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('清缓存竞态：被拒的是**旧** token 时，不清掉并发调用刚换上的新 token', async () => {
    // 门控 fetch：每次调用按序领一个 deferred，调用方逐门放行 ⇒ 交错的时机完全可控
    const deferred = (): { promise: Promise<Response>; resolve: (value: Response) => void } => {
      let resolve: (value: Response) => void = () => undefined;
      const promise = new Promise<Response>((resolver) => {
        resolve = resolver;
      });
      return { promise, resolve };
    };
    const steps = [deferred(), deferred(), deferred(), deferred(), deferred(), deferred()];
    let stepIndex = 0;
    const calls: RecordedCall[] = [];
    const fetchImpl = jest.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: String(input), init });
      const step = steps[stepIndex];
      stepIndex += 1;
      return step.promise;
    }) as unknown as typeof fetch;

    const provider = buildProvider({ fetchImpl });
    /** 把微任务与 0ms 退避定时器都放干净（`sleep(0)` 是 timer 阶段，setImmediate 不够） */
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const a = provider.send(renderedNotification());
    const b = provider.send(renderedNotification());
    await settle();
    // 两个调用共享同一个在途 token 请求
    expect(stepIndex).toBe(1);

    steps[0].resolve(tokenOk(TOKEN_1));
    await settle();
    expect(stepIndex).toBe(3); // A、B 各发了一条消息

    // B 被拒（它用的是 TOKEN_1）⇒ 清缓存（缓存里正是 TOKEN_1）⇒ 重取 ⇒ 用 TOKEN_2 重发成功
    steps[2].resolve(businessError(99991661, 'invalid access token'));
    await settle();
    expect(stepIndex).toBe(4);
    steps[3].resolve(tokenOk(TOKEN_2));
    await settle();
    expect(stepIndex).toBe(5);
    steps[4].resolve(messageOk());
    await settle();

    // A 也被拒（同样用的是旧 TOKEN_1），但此刻缓存里已是 TOKEN_2 ⇒ **不得清掉**
    steps[1].resolve(businessError(99991661, 'invalid access token'));
    await settle();

    // 判据：A 的重试直接命中缓存的新 token ⇒ 第 6 次调用是**发消息**，不是第 3 次换 token
    expect(stepIndex).toBe(6);
    expect(calls[5].url).toContain(MESSAGES_URL_MARKER);
    steps[5].resolve(messageOk());

    const outcomes = await Promise.all([a, b]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['success', 'success']);
    expect(callsTo(calls, TOKEN_URL_MARKER)).toHaveLength(2);
  });

  // ───────── M6：失败归因分类（failureKind）─────────
  //
  // 消费方（test 端点的验证态写入）据它决定"这笔账是否记到地址头上"：只有 `address` 才写
  // `last_test_status='failed'`。故分类必须**逐支**钉住，否则一次 5xx 会把用户已验证的地址打成失败。

  describe('failureKind 归因分类（M6）', () => {
    it('发消息跳 business（200 + code!==0，receive_id 非法）⇒ address', async () => {
      const { fetchImpl } = scriptedFetch([
        tokenOk(TOKEN_1),
        businessError(23001, 'invalid receive_id'),
      ]);
      const outcome = await buildProvider({ fetchImpl }).send(renderedNotification());
      expect(outcome.status).toBe('failed');
      expect(outcome.failureKind).toBe('address');
    });

    it('发消息跳 4xx（http 分支）⇒ address（含 code=0 的网关形错误体）', async () => {
      const { fetchImpl } = scriptedFetch([
        tokenOk(TOKEN_1),
        jsonResponse(400, { code: 0, msg: 'bad request' }),
      ]);
      const outcome = await buildProvider({ fetchImpl }).send(renderedNotification());
      expect({ status: outcome.status, kind: outcome.failureKind }).toEqual({
        status: 'failed',
        kind: 'address',
      });
    });

    it('发消息跳 5xx ⇒ provider（**不是**地址的判决）', async () => {
      const { fetchImpl } = scriptedFetch([
        tokenOk(TOKEN_1),
        jsonResponse(502, { code: 0, msg: 'bad gateway' }),
        jsonResponse(502, { code: 0, msg: 'bad gateway' }),
        jsonResponse(502, { code: 0, msg: 'bad gateway' }),
      ]);
      const outcome = await buildProvider({ fetchImpl }).send(renderedNotification());
      expect(outcome.failureKind).toBe('provider');
    });

    it('发消息跳 429（频控）⇒ provider', async () => {
      const { fetchImpl } = scriptedFetch([
        tokenOk(TOKEN_1),
        jsonResponse(429, { code: 99991400, msg: 'too many requests' }),
      ]);
      const outcome = await buildProvider({ fetchImpl }).send(renderedNotification());
      expect(outcome.failureKind).toBe('provider');
    });

    it('发消息跳鉴权（401）⇒ provider（凭据/权限问题，不是收件人问题）', async () => {
      const { fetchImpl } = scriptedFetch([
        tokenOk(TOKEN_1),
        jsonResponse(401, { code: 99991663, msg: 'invalid access token' }),
        tokenOk(TOKEN_2),
        jsonResponse(401, { code: 99991663, msg: 'invalid access token' }),
      ]);
      const outcome = await buildProvider({ fetchImpl }).send(renderedNotification());
      expect(outcome.failureKind).toBe('provider');
    });

    it('传输层（fetch 抛 TimeoutError）⇒ transport', async () => {
      const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      const { fetchImpl } = scriptedFetch([timeout, timeout]);
      const outcome = await buildProvider({ fetchImpl }).send(renderedNotification());
      expect({ status: outcome.status, kind: outcome.failureKind }).toEqual({
        status: 'failed',
        kind: 'transport',
      });
    });

    it('凭据未配短路 ⇒ provider（responseStatus 为 null，不能被推成 transport）', async () => {
      const provider = buildProvider({ appId: null, appSecret: null });
      const outcome = await provider.send(renderedNotification());
      expect({ status: outcome.status, kind: outcome.failureKind }).toEqual({
        status: 'failed',
        kind: 'provider',
      });
    });

    it('成功终态不带 failureKind（可选字段只在失败时出现）', async () => {
      const { fetchImpl } = scriptedFetch([tokenOk(TOKEN_1), messageOk()]);
      const outcome = await buildProvider({ fetchImpl }).send(renderedNotification());
      expect(outcome.status).toBe('success');
      expect(outcome.failureKind).toBeUndefined();
    });
  });
});
