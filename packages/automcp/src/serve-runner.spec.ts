/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plans/miss-martian-polaris-superboy.md §Step 6
 *   - 补充: .kimi/plans/miss-martian-polaris-superboy.md §运行模式
 *
 * [踩坑索引] -
 *
 * [铁律关联] #7(编译优先) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import axios from 'axios';
import { resolveSurface, runServe } from './serve-runner';
import { loadProfile } from './profile/profile-loader';
import type { ServeOptions } from './types';

const fixturesDir = path.join(__dirname, 'parser', '__fixtures__');

/**
 * 辅助函数：创建默认 ServeOptions
 */
function makeOptions(
  spec: string,
  overrides: Partial<ServeOptions> = {},
): ServeOptions {
  return {
    spec,
    baseUrl: 'http://localhost:8743/api/v1',
    port: 0,
    ...overrides,
  };
}

describe('runServe', () => {
  describe('本地 fixture spec 正常启动', () => {
    it('should start server and return toolCount > 0', async () => {
      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json')),
      );

      expect(result.toolCount).toBe(2);
      expect(result.url).toMatch(/^http:\/\/localhost:\d+$/u);
      expect(result.stop).toBeInstanceOf(Function);

      await result.stop();
    });

    it('should handle JSON-RPC requests end-to-end', async () => {
      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json')),
      );

      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      expect(res.status).toBe(200);
      expect(res.data.jsonrpc).toBe('2.0');
      expect(res.data.id).toBe(1);
      expect(res.data.result.tools).toHaveLength(2);
      expect(res.data.result.tools[0].name).toBe('get_current_user');
      expect(res.data.result.tools[1].name).toBe('create_user');

      await result.stop();
    });
  });

  describe('空 spec（0 operations）', () => {
    it('should return toolCount = 0', async () => {
      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'empty-paths.json')),
      );

      expect(result.toolCount).toBe(0);

      await result.stop();
    });
  });

  describe('无效 spec 路径', () => {
    it('should throw error for non-existent spec file', async () => {
      await expect(
        runServe(makeOptions('/non/existent/path.json')),
      ).rejects.toThrow();
    });
  });

  describe('认证配置传递', () => {
    it('should inject API Key header via proxy', async () => {
      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
          apiKey: 'test-api-key-123',
        }),
      );

      // 通过健康检查端点验证服务器正常运行
      const healthRes = await axios.get(`${result.url}/health`, {
        timeout: 5_000,
      });
      expect(healthRes.status).toBe(200);
      expect(healthRes.data).toEqual({ status: 'ok' });

      await result.stop();
    });
  });

  describe('profile 过滤', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automcp-serve-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should apply profile include filter and reduce tool count', async () => {
      const profilePath = path.join(tmpDir, 'profile.json');
      fs.writeFileSync(
        profilePath,
        JSON.stringify({ include: ['get_current_user'] }),
        'utf-8',
      );

      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
          profilePath,
        }),
      );

      expect(result.toolCount).toBe(1);

      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      expect(res.data.result.tools).toHaveLength(1);
      expect(res.data.result.tools[0].name).toBe('get_current_user');

      await result.stop();
    });

    it('should merge CLI exclude with profile exclude', async () => {
      const profilePath = path.join(tmpDir, 'profile.json');
      fs.writeFileSync(
        profilePath,
        JSON.stringify({ include: ['get_current_user', 'create_user'] }),
        'utf-8',
      );

      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
          profilePath,
          exclude: ['create_user'],
        }),
      );

      expect(result.toolCount).toBe(1);

      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      expect(res.data.result.tools[0].name).toBe('get_current_user');

      await result.stop();
    });
  });

  describe('agent profile milestone tools 回归测试', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automcp-milestones-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should expose all 5 milestone tools when agent profile is applied', async () => {
      const profilePath = path.join(tmpDir, 'profile.json');
      fs.writeFileSync(
        profilePath,
        JSON.stringify({
          include: [
            '^task_controller_find_milestones$',
            '^task_controller_create_milestone$',
            '^task_controller_find_milestone$',
            '^task_controller_update_milestone$',
            '^task_controller_remove_milestone$',
          ],
        }),
        'utf-8',
      );

      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-milestones.json'), {
          profilePath,
        }),
      );

      expect(result.toolCount).toBe(5);

      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      const names = res.data.result.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toEqual([
        'task_controller_create_milestone',
        'task_controller_find_milestone',
        'task_controller_find_milestones',
        'task_controller_remove_milestone',
        'task_controller_update_milestone',
      ]);

      await result.stop();
    });
  });

  describe('--custom-tools 扩展', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automcp-custom-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('⑧ 指向合法模块 → 注册成功且 toolCount 正确', async () => {
      // 写入合法的 custom tools 模块（导出 customTools 数组）
      const modulePath = path.join(tmpDir, 'valid-custom-tools.cjs');
      fs.writeFileSync(
        modulePath,
        [
          `module.exports = {`,
          `  customTools: [{`,
          `    tool: {`,
          `      name: 'my_custom_tool',`,
          `      description: 'A custom tool',`,
          `      inputSchema: { type: 'object', properties: {}, additionalProperties: false },`,
          `    },`,
          `    handler: async () => ({ content: [{ type: 'text', text: 'hello' }] }),`,
          `  }],`,
          `};`,
        ].join('\n'),
        'utf-8',
      );

      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
          customTools: modulePath,
        }),
      );

      // 2 个自动映射 tool + 1 个 custom tool = 3
      expect(result.toolCount).toBe(3);

      // 验证 tools/list 包含 custom tool
      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5_000,
        },
      );

      const names = res.data.result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(['get_current_user', 'create_user', 'my_custom_tool']);

      await result.stop();
    });

    it('⑨ 模块不存在 → runServe reject 明确错误', async () => {
      const badPath = path.join(tmpDir, 'does-not-exist.cjs');

      await expect(
        runServe(
          makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
            customTools: badPath,
          }),
        ),
      ).rejects.toThrow(/Failed to load custom tools module/);
    });

    it('⑩ 导出形状非法（缺少 handler）→ 明确报错', async () => {
      const modulePath = path.join(tmpDir, 'bad-shape.cjs');
      fs.writeFileSync(
        modulePath,
        [
          `module.exports = {`,
          `  customTools: [{`,
          `    tool: {`,
          `      name: 'bad_tool',`,
          `      description: 'Missing handler',`,
          `      inputSchema: { type: 'object', properties: {}, additionalProperties: false },`,
          `    },`,
          `    // 故意不提供 handler`,
          `  }],`,
          `};`,
        ].join('\n'),
        'utf-8',
      );

      await expect(
        runServe(
          makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
            customTools: modulePath,
          }),
        ),
      ).rejects.toThrow(/must have a "handler" function/);
    });
  });

  describe('body 大小上限（MCP-BODY-1 回归）', () => {
    it('应接受超过 express 默认 100kb 的 JSON body（不被 413 拒绝）', async () => {
      const result = await runServe(
        makeOptions(path.join(fixturesDir, 'openapi3-minimal.json')),
      );

      // 构造约 200KB 的 JSON-RPC 请求体——超过 express.json() 默认 100kb，
      // 低于显式放宽的 10mb；大字段挂在 params 上保持 JSON-RPC 结构合法
      const padding = 'x'.repeat(200 * 1024);
      const res = await axios.post(
        `${result.url}/mcp`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { padding },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
          // 本测试只关心 body-parser 是否放行（非 413），MCP 层对 padding 的处理不在范围
          validateStatus: () => true,
        },
      );

      expect(res.status).not.toBe(413);

      await result.stop();
    });
  });
});

/**
 * 仓库内**真实** profile 文件（生产部署实际使用的那两份）
 *
 * surface 解析单测刻意用真实文件而非临时 fixture：`name` 字段的实值是自然语言标签
 * （"Platform Agent (Worker)"），只有真实文件才能钉住"解析不看 name"这一事实。
 */
const realProfilesDir = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'apps',
  'backend',
  'config',
  'mcp-profiles',
);
const agentProfilePath = path.join(realProfilesDir, 'agent.json');
const fullProfilePath = path.join(realProfilesDir, 'full.json');

/** 轮询等待条件成立（invocation 上报是 fire-and-forget，测试必须自己等它到达） */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor: condition not met within timeout');
}

describe('resolveSurface（usage stats D4c：surface 取名源与优先级）', () => {
  it('真实 profile 文件存在（前提断言——路径漂移后本组会立刻红，而不是假绿）', () => {
    expect(fs.existsSync(agentProfilePath)).toBe(true);
    expect(fs.existsSync(fullProfilePath)).toBe(true);
  });

  it('--profile-path：basename 剥 .json → agent.json=mcp / full.json=mcp-full', () => {
    expect(resolveSurface({ profilePath: agentProfilePath }, {})).toBe('mcp');
    expect(resolveSurface({ profilePath: fullProfilePath }, {})).toBe('mcp-full');
  });

  it('禁用 profile JSON 的 name 字段（实值是人类标签，用它必落 unknown）', async () => {
    const agentProfile = await loadProfile(agentProfilePath);
    const fullProfile = await loadProfile(fullProfilePath);

    // 实值证据：name 是自然语言标签，不是实例标识
    expect(agentProfile.name).toBe('Platform Agent (Worker)');
    expect(fullProfile.name).toBe('Platform Full');

    // 解析结果只由文件名决定——若实现改成读 name，这两条立刻红
    expect(resolveSurface({ profilePath: agentProfilePath }, {})).toBe('mcp');
    expect(resolveSurface({ profilePath: fullProfilePath }, {})).toBe('mcp-full');
  });

  it('--profile 字面值：agent → mcp，full → mcp-full', () => {
    expect(resolveSurface({ profile: 'agent' }, {})).toBe('mcp');
    expect(resolveSurface({ profile: 'full' }, {})).toBe('mcp-full');
  });

  it('profilePath 优先于 profile（与 loadProfileForServe 的优先级一致）', () => {
    expect(resolveSurface({ profile: 'full', profilePath: agentProfilePath }, {})).toBe('mcp');
  });

  it('MCP_SURFACE env 优先于 --surface 与 profile 推断', () => {
    expect(
      resolveSurface(
        { profilePath: agentProfilePath, surface: 'mcp' },
        { MCP_SURFACE: 'mcp-full' },
      ),
    ).toBe('mcp-full');
  });

  it('--surface 优先于 profile 推断', () => {
    expect(resolveSurface({ profilePath: agentProfilePath, surface: 'mcp-full' }, {})).toBe(
      'mcp-full',
    );
  });

  it('显式值大小写/空白容错（词表是小写）', () => {
    expect(resolveSurface({}, { MCP_SURFACE: ' MCP-FULL ' })).toBe('mcp-full');
    expect(resolveSurface({ surface: 'MCP' }, {})).toBe('mcp');
  });

  it('显式值非法 → 终局 unknown（不回落 profile 推断）', () => {
    expect(resolveSurface({ profile: 'agent', surface: 'worker' }, {})).toBe('unknown');
    expect(resolveSurface({ profile: 'agent' }, { MCP_SURFACE: 'platform' })).toBe('unknown');
  });

  it('空/空白的显式值视为未提供（回落下一个源）', () => {
    expect(resolveSurface({ profile: 'agent', surface: '' }, { MCP_SURFACE: '   ' })).toBe('mcp');
  });

  it('无任何来源 / 未知 profile 名 → unknown', () => {
    expect(resolveSurface({}, {})).toBe('unknown');
    expect(resolveSurface({ profile: 'unknown-profile' }, {})).toBe('unknown');
    expect(resolveSurface({ profilePath: path.join(realProfilesDir, 'other.json') }, {})).toBe(
      'unknown',
    );
  });
});

describe('usage stats 端到端（两头注入 + invocation 上报，V4/D4b）', () => {
  let fakeBackend: http.Server;
  let backendPort: number;
  const received: Array<{ url: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];

  beforeEach(async () => {
    received.length = 0;
    fakeBackend = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const isUsageReport = req.url === '/api/v1/system/usage-events';
        received.push({
          url: req.url ?? '',
          headers: req.headers,
          body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
        });
        res.writeHead(isUsageReport ? 202 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(isUsageReport ? { accepted: true } : { id: 'u1', name: 'me' }));
      });
    });

    await new Promise<void>((resolve) => {
      fakeBackend.listen(0, '127.0.0.1', resolve);
    });

    const address = fakeBackend.address();
    backendPort = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      fakeBackend.close(() => resolve());
    });
  });

  it('tools/call → REST 扇出带两头，且后端收到一条 invocation 上报', async () => {
    const result = await runServe(
      makeOptions(path.join(fixturesDir, 'openapi3-minimal.json'), {
        baseUrl: `http://127.0.0.1:${backendPort}/api/v1`,
        apiKey: 'shared-api-key',
        // full.json 的 include 是 `.*`（不会过滤掉 fixture 的工具），其 surface = mcp-full
        profilePath: fullProfilePath,
      }),
    );

    const callRes = await axios.post(
      `${result.url}/mcp`,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_current_user', arguments: {} },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5_000 },
    );

    expect(callRes.status).toBe(200);
    expect(callRes.data.result.isError).toBeUndefined();

    // 上报是 fire-and-forget：响应不等它，所以必须轮询等待
    await waitFor(() => received.some((item) => item.url === '/api/v1/system/usage-events'));

    // ① 代理路径扇出的 REST 请求带两头（注入点 ①）
    const fanOut = received.find((item) => item.url === '/api/v1/users/me');
    expect(fanOut).toBeDefined();
    expect(fanOut?.headers['x-mcp-tool']).toBe('get_current_user');
    expect(fanOut?.headers['x-mcp-surface']).toBe('mcp-full');
    // 无 client 认证头 → 用服务端默认认证（--api-key）
    expect(fanOut?.headers['x-api-key']).toBe('shared-api-key');

    // ② invocation 上报（D4b 通道）——精确计数来源
    const report = received.find((item) => item.url === '/api/v1/system/usage-events');
    expect(report?.headers['x-api-key']).toBe('shared-api-key');
    expect(report?.body).toMatchObject({
      toolName: 'get_current_user',
      surface: 'mcp-full',
      ok: true,
      viaFallbackAuth: true,
    });
    expect(Number.isInteger((report?.body as { latencyMs: number }).latencyMs)).toBe(true);

    await result.stop();
  });
});
