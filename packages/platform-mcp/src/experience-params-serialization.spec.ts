/**
 * 数组 query 参数的**真实序列化形态**测试（跨层契约钉死）
 *
 * 为什么单独一个文件、且**不 mock axios**：本用例要证的不是"我们传了某个选项"，
 * 而是"真正到达服务端的 query 串是什么形态"。mock 掉的 axios 不会序列化任何东西
 * （platform-client.spec.ts 的 jest.mock('axios') 只能断言配置透传，测不出序列化产物），
 * 故此处起一个本地 http server 直接读 `req.url`——那是服务端实际收到的原始串，
 * 也是后端 `assertNoBracketedArrayQuery(req.originalUrl)` 的判据来源。
 *
 * 钉住的两条事实：
 *   1. 缺省（无 paramsSerializer）→ axios 产出**方括号形态** `signals%5B%5D=a`
 *      （解码即 `signals[]=a`）——后端经验库守卫对此明确 400（不是静默忽略）；
 *   2. 显式 `serializeRepeatedParams` → **重复键形态** `signals=a&signals=b`，
 *      串内不含 `[]`/`%5B`，即后端契约要求的形态。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlatformApiClient, serializeRepeatedParams } from './platform-client';

/** 单次捕获的原始请求串（含 path + query） */
interface Captured {
  url: string;
  method: string;
}

describe('经验库数组参数 query 串形态（真 http server 捕获 req.url）', () => {
  let server: http.Server;
  let baseUrl: string;
  let captured: Captured[];

  beforeAll(async () => {
    captured = [];
    server = http.createServer((req, res) => {
      captured.push({ url: req.url ?? '', method: req.method ?? '' });
      // 后端统一信封（2xx 剥壳路径）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 200, message: 'success', data: { items: [], total: 0 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    captured.length = 0;
  });

  it('缺省无 paramsSerializer → axios 默认方括号形态（后端守卫 400 的根因实证）', async () => {
    const client = new PlatformApiClient(baseUrl);

    await client.request('GET', '/experiences', { params: { signals: ['a', 'b'] } });

    expect(captured).toHaveLength(1);
    // axios 默认把数组键编码成 `signals[]`（%5B%5D），这正是被后端拒绝的形态
    expect(captured[0].url).toBe('/api/v1/experiences?signals%5B%5D=a&signals%5B%5D=b');
    expect(decodeURIComponent(captured[0].url)).toContain('signals[]=a');
  });

  it('显式 serializeRepeatedParams → 重复键形态到达服务端（signals=a&signals=b）', async () => {
    const client = new PlatformApiClient(baseUrl);

    await client.request('GET', '/experiences', {
      params: { signals: ['econnrefused', 'port-unreachable'], domains: ['devops'], limit: 10 },
      paramsSerializer: serializeRepeatedParams,
    });

    expect(captured).toHaveLength(1);
    const url = captured[0].url;
    expect(url).toBe(
      '/api/v1/experiences?signals=econnrefused&signals=port-unreachable&domains=devops&limit=10',
    );
    // 反向断言：形态里绝不允许出现方括号（含百分号编码形态）
    expect(url).not.toMatch(/\[|%5B/i);
  });

  it('值编码正确（空格/中文/布尔/重复键均可被服务端解码回原值）', async () => {
    const client = new PlatformApiClient(baseUrl);

    await client.request('GET', '/experiences', {
      params: { q: '端口 不可达', signals: ['econnrefused'], includeExpired: false },
      paramsSerializer: serializeRepeatedParams,
    });

    const url = captured[0].url;
    // 逐键取回并按服务端同一套规则解码（URLSearchParams 即 Express 的取值语义）
    const decoded = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(decoded.get('q')).toBe('端口 不可达');
    expect(decoded.get('includeExpired')).toBe('false');
    // 重复键取值语义：同名键多次出现时 getAll 返回全部元素（数组参数契约的解析侧证据）
    expect(decoded.getAll('signals')).toEqual(['econnrefused']);
  });

  it('serializeRepeatedParams 纯函数行为：数组展开/跳过 null·undefined/无 ? 前缀', () => {
    expect(serializeRepeatedParams({ signals: ['a', 'b'], q: 'x' })).toBe(
      'signals=a&signals=b&q=x',
    );
    expect(serializeRepeatedParams({ a: null, b: undefined, c: 0 })).toBe('c=0');
    expect(serializeRepeatedParams({ empty: [] })).toBe('');
    expect(serializeRepeatedParams({ q: 'port unreachable' })).toBe('q=port%20unreachable');
  });
});
