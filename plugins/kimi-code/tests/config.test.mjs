// config.test.mjs — 配置解析优先级矩阵（计划 §7；测试即文档，铁律 #19）
// 覆盖 §2.2/§2.3 四步优先级逐 case + 负例 + A4 三边界 + S6 scheme 白名单。
// 分支标注：①=未接入（not-configured）④=配置异常（pointer-mismatch / no-key-in-server / scheme 违例）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveKey, resolveApiBase, resolveConfig, findUpward } from '../hooks/lib/config.mjs';

// —— 构造工具：mcp.json 对象 / HTTP server / stdio server ——
const mcp = (servers) => ({ mcpServers: servers });
const httpServer = (url, headers, extra = {}) => ({ url, headers, ...extra });
const stdioServer = (command, args) => ({ command, args });

// —— 优先级 ①：binding.apiKey 显式 ——
test('优先级①：binding.apiKey 非空 → 直接用（覆盖 mcp 内 key，REST-only 主路）', () => {
  // 假 key 刻意 <20 字符：oss-export 的 key 守卫拦截 ask_+20 字符形态，fixture 不得越线
  const binding = { apiKey: 'ask_bkey1234567890', mcpServer: 'platform' };
  const projectMcp = mcp({ platform: httpServer('https://x/mcp', { 'X-API-Key': 'ask_mcpkey1234567890' }) });
  const r = resolveKey(binding, projectMcp, null);
  assert.equal(r.key, 'ask_bkey1234567890');
  assert.equal(r.source, 'binding.apiKey');
  assert.equal(r.status, 'ok');
  assert.equal(r.serverName, null);
});

// —— 优先级 ②：mcpServer 指针 ——
test('优先级②：指针命中项目级 server → 取 headers X-API-Key', () => {
  const binding = { mcpServer: 'platform' };
  const projectMcp = mcp({ platform: httpServer('https://x/mcp', { 'X-API-Key': 'ask_pkey1234567890' }) });
  const r = resolveKey(binding, projectMcp, null);
  assert.equal(r.key, 'ask_pkey1234567890');
  assert.equal(r.source, 'mcp.pointer');
  assert.equal(r.serverName, 'platform');
  assert.equal(r.serverUrl, 'https://x/mcp');
});

test('优先级②：指针项目级缺失 → 回落用户级', () => {
  const binding = { mcpServer: 'chamber' };
  const userMcp = mcp({ chamber: httpServer('https://u/mcp', { 'X-API-Key': 'ask_ukey1234567890' }) });
  const r = resolveKey(binding, null, userMcp);
  assert.equal(r.key, 'ask_ukey1234567890');
  assert.equal(r.source, 'mcp.pointer');
});

// —— 优先级 ③：惯例名回退 ——
test('优先级③：惯例名 chamber 命中', () => {
  const projectMcp = mcp({ chamber: httpServer('https://x/mcp', { 'X-API-Key': 'ask_c1234567890' }) });
  const r = resolveKey(null, projectMcp, null);
  assert.equal(r.key, 'ask_c1234567890');
  assert.equal(r.source, 'mcp.convention');
  assert.equal(r.serverName, 'chamber');
});

test('优先级③：惯例名链依次尝试（chamber 缺 → platform 命中）', () => {
  const projectMcp = mcp({ platform: httpServer('https://x/mcp', { 'X-API-Key': 'ask_p1234567890' }) });
  const r = resolveKey(null, projectMcp, null);
  assert.equal(r.serverName, 'platform');
  assert.equal(r.key, 'ask_p1234567890');
});

test('优先级③：惯例名全缺 + 合并后恰一个 HTTP server → 直用（§2.2.3）', () => {
  const projectMcp = mcp({ 'my-server': httpServer('https://x/mcp', { 'X-API-Key': 'ask_s1234567890' }) });
  const r = resolveKey(null, projectMcp, null);
  assert.equal(r.key, 'ask_s1234567890');
  assert.equal(r.source, 'mcp.single-http');
  assert.equal(r.serverName, 'my-server');
});

// —— 负例 ——
test('负例：无任何配置 → not-configured（分支①）', () => {
  const r = resolveKey(null, null, null);
  assert.equal(r.key, null);
  assert.equal(r.status, 'not-configured');
});

test('负例：mcp.json 畸形 JSON → loadJsonFile null → not-configured（分支①）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-config-'));
  try {
    mkdirSync(path.join(dir, '.kimi-code'), { recursive: true });
    writeFileSync(path.join(dir, '.kimi-code', 'mcp.json'), '{ bad json');
    const cfg = resolveConfig(dir);
    assert.equal(cfg.projectMcp, null);
    assert.ok(cfg.projectMcpPath, '文件存在但解析失败（损坏与缺失可区分）');
    const r = resolveKey(cfg.binding, cfg.projectMcp, cfg.userMcp);
    assert.equal(r.status, 'not-configured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('负例：指针指向 stdio server（command 字段、无 url）→ pointer-mismatch（分支④）', () => {
  const binding = { mcpServer: 'ctx' };
  const projectMcp = mcp({ ctx: stdioServer('npx', ['-y', '@context7/mcp']) });
  const r = resolveKey(binding, projectMcp, null);
  assert.equal(r.key, null);
  assert.equal(r.status, 'pointer-mismatch');
});

test('负例：多 HTTP server 且无指针/惯例名 → not-configured（分支①）', () => {
  const projectMcp = mcp({
    a: httpServer('https://a/mcp', { 'X-API-Key': 'ask_a1234567890' }),
    b: httpServer('https://b/mcp', { 'X-API-Key': 'ask_b1234567890' }),
  });
  const r = resolveKey(null, projectMcp, null);
  assert.equal(r.status, 'not-configured');
});

test('负例：惯例名全缺 + 多 server → not-configured（分支①）', () => {
  const projectMcp = mcp({
    'my-a': httpServer('https://a/mcp', { 'X-API-Key': 'ask_a1234567890' }),
    'my-b': httpServer('https://b/mcp', { 'X-API-Key': 'ask_b1234567890' }),
  });
  const r = resolveKey(null, projectMcp, null);
  assert.equal(r.status, 'not-configured');
});

// —— 合并语义 ——
test('合并语义：项目级同名 server 覆盖用户级（惯例名命中取项目级 key）', () => {
  const projectMcp = mcp({ chamber: httpServer('https://p/mcp', { 'X-API-Key': 'ask_proj1234567890' }) });
  const userMcp = mcp({ chamber: httpServer('https://u/mcp', { 'X-API-Key': 'ask_user1234567890' }) });
  const r = resolveKey(null, projectMcp, userMcp);
  assert.equal(r.key, 'ask_proj1234567890');
  assert.equal(r.serverUrl, 'https://p/mcp');
});

// —— 向上查找 ——
test('向上查找：cwd=子目录 → 找到项目级 .kimi-code 文件（openviking 同款模式）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-up-'));
  try {
    mkdirSync(path.join(dir, '.kimi-code'), { recursive: true });
    writeFileSync(path.join(dir, '.kimi-code', 'agent-chamber.json'), JSON.stringify({ boardId: 'b1' }));
    writeFileSync(
      path.join(dir, '.kimi-code', 'mcp.json'),
      JSON.stringify(mcp({ chamber: httpServer('https://x/mcp', { 'X-API-Key': 'ask_up1234567890' }) })),
    );
    const sub = path.join(dir, 'a', 'b', 'c');
    mkdirSync(sub, { recursive: true });
    const cfg = resolveConfig(sub);
    assert.ok(cfg.bindingPath?.startsWith(dir));
    assert.ok(cfg.projectMcpPath?.startsWith(dir));
    const r = resolveKey(cfg.binding, cfg.projectMcp, cfg.userMcp);
    assert.equal(r.key, 'ask_up1234567890');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('向上查找：到 fs 根停止，不抛异常', () => {
  assert.equal(findUpward('/nonexistent-dir-xyz', '.kimi-code/agent-chamber.json'), null);
});

// —— A4 边界：enabled:false ——
test('A4 边界：惯例名回退跳过 enabled:false 的 server（唯一 server 被禁用 → 单 HTTP 判定也跳过）', () => {
  const projectMcp = mcp({ chamber: httpServer('https://x/mcp', { 'X-API-Key': 'ask_c1234567890' }, { enabled: false }) });
  const r = resolveKey(null, projectMcp, null);
  assert.equal(r.status, 'not-configured');
});

test('A4 边界：指针指向 enabled:false 的 server → pointer-mismatch（分支④）', () => {
  const binding = { mcpServer: 'chamber' };
  const projectMcp = mcp({ chamber: httpServer('https://x/mcp', { 'X-API-Key': 'ask_c1234567890' }, { enabled: false }) });
  const r = resolveKey(binding, projectMcp, null);
  assert.equal(r.status, 'pointer-mismatch');
});

// —— A4 边界：bearerTokenEnvVar 不支持 ——
test('A4 边界：server 只有 bearerTokenEnvVar 无 X-API-Key → 不命中（平台 Bearer 只收 JWT）', () => {
  const projectMcp = mcp({ chamber: { url: 'https://x/mcp', bearerTokenEnvVar: 'CHAMBER_TOKEN' } });
  const r = resolveKey(null, projectMcp, null);
  assert.equal(r.status, 'not-configured');
});

// —— 用户级身份文件 ——
test('用户级身份文件：KIMI_CODE_HOME 注入 → 从该目录读 mcp.json（A4 路径统一）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
  try {
    mkdirSync(path.join(dir, 'logs'), { recursive: true });
    writeFileSync(
      path.join(dir, 'mcp.json'),
      JSON.stringify(mcp({ chamber: httpServer('https://x/mcp', { 'X-API-Key': 'ask_home1234567890' }) })),
    );
    const cfg = resolveConfig('/nonexistent-project', { KIMI_CODE_HOME: dir }, os.homedir());
    assert.ok(cfg.userMcpPath?.startsWith(dir));
    const r = resolveKey(cfg.binding, cfg.projectMcp, cfg.userMcp);
    assert.equal(r.key, 'ask_home1234567890');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— S6：scheme 白名单 ——
test('S6：scheme 白名单——http 非 localhost 拒绝；localhost/127.0.0.1 例外；https 通过', () => {
  assert.equal(resolveApiBase({ apiBaseUrl: 'http://example.com/api/v1' }, null).status, 'invalid-scheme');
  assert.equal(resolveApiBase({ apiBaseUrl: 'http://localhost:9876/api/v1' }, null).status, 'ok');
  assert.equal(resolveApiBase({ apiBaseUrl: 'http://127.0.0.1:9876/api/v1' }, null).status, 'ok');
  assert.equal(resolveApiBase({ apiBaseUrl: 'https://chamber.example.com/api/v1' }, null).status, 'ok');
});

test('S6：非法 URL → invalid-scheme（new URL 抛）', () => {
  assert.equal(resolveApiBase({ apiBaseUrl: 'not-a-url' }, null).status, 'invalid-scheme');
});

// —— resolveApiBase 其余状态 ——
test('resolveApiBase：REST-only 无 apiBaseUrl → incomplete（分支④）', () => {
  const r = resolveApiBase({}, null);
  assert.equal(r.status, 'incomplete');
  assert.equal(r.baseUrl, null);
});

test('resolveApiBase：mcp url 非法 → invalid-mcp-url（分支④）', () => {
  const r = resolveApiBase(null, 'not-a-url');
  assert.equal(r.status, 'invalid-mcp-url');
});
