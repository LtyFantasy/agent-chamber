/**
 * judgment.transport 单测（**mock 两条 fetch**，钉逻辑面；真网络验证见
 * `scripts/test-judgment-proxy.cjs`——jest 的模块沙箱会破坏 undici ProxyAgent 的内部
 * socket 状态，代理路径在 jest 里挂起是已知环境污染，不是代码 bug，实机验证记录见脚本头）。
 *
 * 这里钉死三件事：
 * ① **直连路径**走全局 fetch、不带 dispatcher（proxyUrl 缺省/null）；
 * ② **代理路径**走 undici 自带 fetch、把 ProxyAgent dispatcher 传进去（proxyUrl 配置时）——
 *    这是 undici 钉 6.x 的配对契约（npm-8 与 Node 内置 fetch 契约不齐，混喂必炸）；
 * ③ **dispatcher 创建失败**（`new ProxyAgent` 对运行时非法值同步抛）必须被 try 兜住、
 *    落 transport 分类，**postSystemone 永不 throw**。
 *
 * 密钥纪律（仓库 NIT-1）：key 假值全合成，断言标记取自假值内部。
 */
import { postSystemone, JUDGMENT_TRANSPORT_STATUS } from './judgment.transport';

/** 合成假 key（前缀是公开形态，后缀全合成；绝不含真实 Key 任何连续片段） */
const API_KEY = 'apikey_' + 'Z9y8x7w6v5'.repeat(4);

/** 合法官方响应体（最小形状） */
const OK_BODY = JSON.stringify({ model: 'jev-1.13.0', answers: {} });

/** 伪响应（最小面：`ok`/`status`/`text()`——transport 只消费这三个） */
function fakeResponse(overrides: { ok?: boolean; status?: number; body?: string } = {}) {
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    text: () => Promise.resolve(overrides.body ?? OK_BODY),
  };
}

/** undici fetch 的 mock 引用（模块级 jest.mock 安装，用例内改实现） */
const undiciFetchMock = jest.fn();
jest.mock('undici', () => {
  const actual = jest.requireActual('undici') as Record<string, unknown>;
  return { ...actual, fetch: (...args: unknown[]) => undiciFetchMock(...args) };
});

describe('judgment.transport（mock 逻辑面）', () => {
  const realGlobalFetch = globalThis.fetch;
  let globalFetchCalls: Array<{ url: string; init: Record<string, unknown> }>;
  let undiciFetchCalls: Array<{ url: string; init: Record<string, unknown> }>;

  beforeEach(() => {
    globalFetchCalls = [];
    undiciFetchCalls = [];
    undiciFetchMock.mockClear();
    // mock 全局 fetch（直连路径）
    globalThis.fetch = (url: unknown, init: unknown) => {
      globalFetchCalls.push({ url: String(url), init: init as Record<string, unknown> });
      return Promise.resolve(fakeResponse() as unknown as Response);
    };
    // mock undici 自带 fetch（代理路径）
    undiciFetchMock.mockImplementation((url: unknown, init: unknown) => {
      undiciFetchCalls.push({ url: String(url), init: init as Record<string, unknown> });
      return Promise.resolve(fakeResponse());
    });
  });

  afterEach(() => {
    globalThis.fetch = realGlobalFetch;
  });

  describe('直连路径（proxyUrl 缺省 / null）', () => {
    it('走全局 fetch、不带 dispatcher', async () => {
      const result = await postSystemone(
        { baseUrl: 'http://127.0.0.1:8080', apiKey: API_KEY, timeoutMs: 5000 },
        { state: 's', model: 'm', questions: {} },
      );
      expect(result.status).toBe(JUDGMENT_TRANSPORT_STATUS.OK);
      expect(globalFetchCalls.length).toBe(1);
      expect(undiciFetchCalls.length).toBe(0);
      expect(globalFetchCalls[0].init.dispatcher).toBeUndefined();
    });
  });

  describe('代理路径（proxyUrl 配置）', () => {
    it('走 undici 自带 fetch、带 ProxyAgent dispatcher', async () => {
      const result = await postSystemone(
        {
          baseUrl: 'http://127.0.0.1:8080',
          apiKey: API_KEY,
          timeoutMs: 5000,
          proxyUrl: 'http://127.0.0.1:8001',
        },
        { state: 's', model: 'm', questions: {} },
      );
      expect(result.status).toBe(JUDGMENT_TRANSPORT_STATUS.OK);
      expect(undiciFetchCalls.length).toBe(1);
      expect(globalFetchCalls.length).toBe(0);
      // dispatcher 必须存在且是 ProxyAgent 实例（undici 钉 6.x 的配对契约）
      const dispatcher = undiciFetchCalls[0].init.dispatcher;
      expect(dispatcher).toBeDefined();
      expect((dispatcher as { constructor?: { name?: string } }).constructor?.name).toBe(
        'ProxyAgent',
      );
    });

    it('dispatcher 创建失败（非法 proxyUrl）：不 throw，落 transport 分类', async () => {
      // 'not-a-url' 会让 new ProxyAgent 同步抛——必须被 try 兜住
      const result = await postSystemone(
        {
          baseUrl: 'http://127.0.0.1:8080',
          apiKey: API_KEY,
          timeoutMs: 5000,
          proxyUrl: 'not-a-url',
        },
        { state: 's', model: 'm', questions: {} },
      );
      expect(result.status).toBe(JUDGMENT_TRANSPORT_STATUS.FAILED);
      if (result.status === JUDGMENT_TRANSPORT_STATUS.FAILED) {
        expect(result.outcome.status).toBe('error');
        expect(result.outcome.response.error).toContain('transport error');
      }
      // 两条 fetch 都不该被调到（dispatcher 创建就失败了）
      expect(globalFetchCalls.length).toBe(0);
      expect(undiciFetchCalls.length).toBe(0);
    });
  });
});
