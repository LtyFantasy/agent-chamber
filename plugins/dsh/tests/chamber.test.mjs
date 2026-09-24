// chamber.test.mjs — dsh-agent-chamber 测试（plan「交付物 A」测试清单 + v1.2.1 §1 四种 '{{' 形态）。
// 风格范式沿用 plugins/kimi-code/tests：node:test + 真实 spawn（fixtures/*.mjs）+ 本地 http mock server。
// 伪 ctx 驱动三功能（dsh 本体不进测试进程——事件/waterfall 语义按编译产物契约手工模拟）；
// 唯一的端到端用真实 spawn 跑 kimi-code/hooks/session-start.mjs 打本地 mock platform。
// 运行法（仓根）：node --test plugins/dsh/tests/*.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyChamber,
  runBriefingHook,
  createPluginMessage,
  checkSkillDirs,
  PATHS,
  SECTION_NAME,
  SECTION_ORDER,
} from '../lib/chamber.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** 夹具路径解析（统一入口，拼错路径在断言里一眼可见） */
const fx = (name) => path.join(FIXTURES, name);
const TEST_KEY = 'ask_testkey1234567890';

// ———————————————————————————— 伪 Cordis 基础设施 ————————————————————————————

/** 捕获式日志器：三严重度分行收集；has() 支持子串断言 */
function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    debug: () => {},
    has(level, needle) {
      return lines[level].some((line) => line.includes(needle));
    },
  };
}

/**
 * 伪 Cordis ctx：on() 收集监听器；agents/systemPrompt 可按需缺席（服务缺失分支）；
 * systemPrompt.section 记录注册形状（含键集断言「无 interpolate 字段」）。
 */
function makeCtx({ withAgents = true, withSystemPrompt = true } = {}) {
  const logger = makeLogger();
  const handlers = new Map();
  const sections = [];
  const agentsMap = new Map();
  const ctx = {
    logger,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    agents: withAgents ? { get: (id) => agentsMap.get(id) } : undefined,
    systemPrompt: withSystemPrompt
      ? {
          section: (s) => {
            sections.push(s);
            return () => {};
          },
        }
      : undefined,
  };
  return { ctx, logger, handlers, sections, agentsMap };
}

/** emit 模式事件派发（同步调用，对齐 cordis emit 语义） */
function emit(handlers, event, ...args) {
  for (const fn of handlers.get(event) ?? []) fn(...args);
}

/** waterfall 模式 pre-step 驱动：next() 返回给定 decision（模拟上游瀑布已汇合） */
function runPreStep(handlers, payload, decision) {
  const fn = handlers.get('agent/pre-step')?.[0];
  assert.ok(fn, 'pre-step 监听器应已注册');
  return fn(payload, async () => decision);
}

/** 伪 Agent：契约字段 = id / session.header / inject（dsh-agent types.d.ts 实证形状） */
function makeAgent(id, { cwd = '/tmp', origin, delegationDepth } = {}) {
  const injected = [];
  const header = { cwd };
  if (origin !== undefined) header.origin = origin;
  if (delegationDepth !== undefined) header.delegationDepth = delegationDepth;
  return {
    id,
    injected,
    session: { id, header },
    inject(msg) {
      injected.push(msg);
    },
  };
}

/** 轮询等待异步行为（setImmediate/spawn settle），有界防挂 */
async function pollUntil(cond, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ———————————————————————————— 路径推导（验收 4：实证打印 + 存在性断言） ————————————————————————————

test('路径推导：hooks/SYSTEM.md/format/skills 四路径解析并存在（CI 抓软链/布局变化的唯一断言）', () => {
  // 实证打印（验收要求可见）
  console.log('PATHS.hookScript   =', PATHS.hookScript);
  console.log('PATHS.systemMd     =', fileURLToPath(PATHS.systemMd));
  console.log('PATHS.formatModule =', fileURLToPath(PATHS.formatModule));
  console.log('PATHS.skillsDirs   =', PATHS.skillsDirs.join(' , '));
  assert.ok(existsSync(PATHS.hookScript), 'hook 脚本应存在');
  assert.ok(PATHS.hookScript.endsWith(path.join('plugins', 'kimi-code', 'hooks', 'session-start.mjs')), 'hook 路径应指向兄弟包');
  assert.ok(existsSync(fileURLToPath(PATHS.systemMd)), 'SYSTEM.md 应存在');
  assert.ok(existsSync(fileURLToPath(PATHS.formatModule)), 'format.mjs 应存在');
  assert.equal(PATHS.skillsDirs.length, 2, '与 cordis.patch.yml customSkillDirs 一一对应');
  for (const dir of PATHS.skillsDirs) {
    assert.ok(statSync(dir).isDirectory(), `skills 目录应存在且为目录: ${dir}`);
  }
});

// ———————————————————————————— spawn 胶水 ————————————————————————————

test('spawn 胶水：stdin payload 逐字送达 + additionalContext 原样提取', async () => {
  const payload = { cwd: '/tmp/proj', source: 'startup', session_id: 's-1', hook_event_name: 'SessionStart' };
  const result = await runBriefingHook({ scriptPath: fx('echo.mjs'), payload, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.text), payload, 'echo 夹具原样回显 → stdin JSON 契约与 stdout 解析同时成立');
});

test('spawn 胶水：硬超时 SIGKILL（promise 必 settle → 槽位不泄漏）', async () => {
  const start = Date.now();
  const result = await runBriefingHook({ scriptPath: fx('hang.mjs'), payload: {}, timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'spawn-timeout');
  assert.equal(result.killed, true);
  assert.ok(Date.now() - start < 3000, '超时应及时返回');
});

test('spawn 胶水：非 JSON 输出 fail-open——resolve {ok:false} 而非 throw（不静默的日志断言在布线层用例）', async () => {
  const result = await runBriefingHook({ scriptPath: fx('garbage.mjs'), payload: {}, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-json');
  assert.ok(result.detail.includes('not-json'), 'detail 应含 stdout 头部便于诊断');
});

test('spawn 胶水：合法 JSON 但无 additionalContext → reason=empty', async () => {
  const result = await runBriefingHook({ scriptPath: fx('empty.mjs'), payload: {}, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

test('spawn 胶水：空 stdout 前置分流为 empty（m3：非空非 JSON 才 invalid-json）', async () => {
  const result = await runBriefingHook({ scriptPath: fx('silent.mjs'), payload: {}, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

test('spawn 胶水：execPath 不存在 → 异步 error 事件路径（m9），reason=spawn-error 且 detail 可诊断', async () => {
  const result = await runBriefingHook({ scriptPath: fx('echo.mjs'), payload: {}, timeoutMs: 3000, execPath: '/nonexistent/node' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'spawn-error');
  assert.ok(result.detail && result.detail.length > 0, '异步 error 应携带 detail');
});

test('M1：executor 同步 throw 输入（非字符串 scriptPath / circular payload）→ promise 不 reject', async () => {
  // 胶水层：直接断言 resolve 而非 reject（reject 会让 await 抛、测试失败）
  const r1 = await runBriefingHook({ scriptPath: 123, payload: {}, timeoutMs: 1000 });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'script-missing');
  const circular = {};
  circular.self = circular;
  const r2 = await runBriefingHook({ scriptPath: fx('echo.mjs'), payload: circular, timeoutMs: 1000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'spawn-error');
  // 布线层：槽位被 settleSlot 清掉 + fallback 日志（不静默）
  const { ctx, logger, handlers } = makeCtx();
  const handle = await applyChamber(ctx, { paths: { ...PATHS, hookScript: 123 } });
  const agent = makeAgent('s-m1');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  const cleared = await pollUntil(() => !handle.slots.has('s-m1'), 2000);
  assert.ok(cleared, 'settle 失败后槽位应清');
  assert.ok(logger.has('warn', 'briefing=fallback'), '失败应留可见信号');
});

test('spawn 胶水：脚本缺失 → reason=script-missing（布局破裂的显式信号）', async () => {
  const result = await runBriefingHook({ scriptPath: fx('no-such-script.mjs'), payload: {}, timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'script-missing');
});

// ———————————————————————————— 功能① pre-step 注入 ————————————————————————————

test('pre-step：首轮 append（手搓消息四件套）+ 二轮不重复', async () => {
  const { ctx, logger, handlers } = makeCtx();
  const handle = await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') }, preStepWaitMs: 2000 });
  const agent = makeAgent('s-1');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  assert.ok(handle.slots.has('s-1'), 'session-start(startup) 后槽位应存在');
  const out1 = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
  assert.equal(out1.messages.length, 1, '首轮应注入一条');
  const msg = out1.messages[0];
  assert.equal(typeof msg.id, 'string');
  assert.ok(msg.id.length > 0, 'id 非空串（session 校验四件套之一）');
  assert.equal(msg.role, 'user');
  assert.ok(Array.isArray(msg.content));
  assert.equal(msg.content[0].type, 'text');
  assert.ok(msg.content[0].text.includes('[agent-chamber] fake-briefing'));
  assert.deepEqual(msg.source, { kind: 'plugin', plugin: 'agent-chamber' });
  assert.ok(logger.has('info', 'briefing=injected'));
  assert.ok(!handle.slots.has('s-1'), '消费后清槽防重复');
  const out2 = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
  assert.equal(out2.messages.length, 0, '二轮不重复注入');
});

test('pre-step：reject 早返回（同一对象透传，槽位不动；后续 enter 仍可注入）', async () => {
  const { ctx, handlers } = makeCtx();
  const handle = await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') }, preStepWaitMs: 2000 });
  const agent = makeAgent('s-2');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  const reject = { kind: 'reject' };
  const out = await runPreStep(handlers, { agent, signal: new AbortController().signal }, reject);
  assert.equal(out, reject, 'reject 应原样透传');
  assert.ok(handle.slots.has('s-2'), 'reject 不动槽位');
  const out2 = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
  assert.equal(out2.messages.length, 1, '被拒步之后的下一个 enter 步仍可注入');
});

test('pre-step：超时降级不 append；槽位保留至 settle → 清槽 + briefing=timeout-dropped', async () => {
  const { ctx, logger, handlers } = makeCtx();
  const handle = await applyChamber(ctx, {
    paths: { ...PATHS, hookScript: fx('hang.mjs') },
    preStepWaitMs: 100,
    spawnTimeoutMs: 500,
  });
  const agent = makeAgent('s-3');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  const out = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
  assert.equal(out.messages.length, 0, '超时本轮不注入');
  assert.ok(logger.has('warn', 'briefing=timeout'), '超时应留可见信号');
  assert.ok(handle.slots.has('s-3'), '超时保留槽位至本轮结束');
  const dropped = await pollUntil(() => logger.has('warn', 'briefing=timeout-dropped'), 3000);
  assert.ok(dropped, 'spawn 硬超时 settle（轮末未投递）→ timeout-dropped 日志');
  assert.ok(!handle.slots.has('s-3'), '轮末未投递 → 清槽');
});

test('pre-step：超时后 resolve → 补投（agent.inject）并清槽', async () => {
  const { ctx, logger, handlers } = makeCtx();
  const handle = await applyChamber(ctx, {
    paths: { ...PATHS, hookScript: fx('slow.mjs') },
    preStepWaitMs: 100,
    spawnTimeoutMs: 5000,
  });
  const agent = makeAgent('s-4');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  const out = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
  assert.equal(out.messages.length, 0, '400ms 的 settle 赶不上 100ms 的预算');
  assert.ok(logger.has('warn', 'briefing=timeout'));
  const late = await pollUntil(() => agent.injected.length > 0, 3000);
  assert.ok(late, 'resolve 仍可补投');
  assert.ok(agent.injected[0].content[0].text.includes('[agent-chamber] slow-briefing'));
  assert.ok(logger.has('info', 'briefing=injected-late'));
  assert.ok(!handle.slots.has('s-4'), '投递后清槽');
});

test('pre-step：race 期间 settleSlot 已补投 → 所有权检查防双重注入', async () => {
  const { ctx, handlers } = makeCtx();
  const handle = await applyChamber(ctx, {
    paths: { ...PATHS, hookScript: fx('slow.mjs') },
    preStepWaitMs: 2000,
    spawnTimeoutMs: 5000,
  });
  const agent = makeAgent('s-race');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  // 模拟「此前某轮已超时」的槽位状态：timedOut=true 时 settleSlot 会补投清槽；
  // promise settle 时 settleSlot 的 then 先于 race 的 continuation（注册序）→ race 醒来看槽位已失。
  handle.slots.get('s-race').timedOut = true;
  const out = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
  assert.equal(out.messages.length, 0, '补投优先，pre-step 不再 append（不双重注入）');
  assert.equal(agent.injected.length, 1, '恰好补投一次');
  assert.ok(!handle.slots.has('s-race'), '投递后清槽');
});

test('pre-step：非 JSON → 本轮不注入 + briefing=fallback 日志（不静默）+ 清槽不重试', async () => {
  const { ctx, logger, handlers } = makeCtx();
  const handle = await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('garbage.mjs') }, preStepWaitMs: 2000 });
  const agent = makeAgent('s-5');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  const out = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
  assert.equal(out.messages.length, 0);
  assert.ok(logger.has('warn', 'briefing=fallback'), '非 JSON fail-open 且不静默');
  assert.ok(!handle.slots.has('s-5'), '失败清槽不重试');
  const out2 = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
  assert.equal(out2.messages.length, 0, '槽位已清，二轮无动作');
});

test('pre-step：signal 已 abort → 原样返回不等待（槽位保留等下一轮）', async () => {
  const { ctx, handlers } = makeCtx();
  const handle = await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') }, preStepWaitMs: 2000 });
  const agent = makeAgent('s-abort');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  const ac = new AbortController();
  ac.abort();
  const decision = { kind: 'enter', messages: [] };
  const out = await runPreStep(handlers, { agent, signal: ac.signal }, decision);
  assert.equal(out.messages.length, 0);
  assert.ok(handle.slots.has('s-abort'), 'abort 不清槽');
});

test('M2：race 进行中 abort → 立即返回不 append；槽位保留；后续 enter 步仍能注入', async () => {
  const { ctx, logger, handlers } = makeCtx();
  const handle = await applyChamber(ctx, {
    paths: { ...PATHS, hookScript: fx('slow.mjs') }, // 400ms 才 settle
    preStepWaitMs: 5000, // 大预算：若 abort 不生效，本用例会挂到 5s
    spawnTimeoutMs: 5000,
  });
  const agent = makeAgent('s-abort-mid');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  const ac = new AbortController();
  const start = Date.now();
  const racing = runPreStep(handlers, { agent, signal: ac.signal }, { kind: 'enter', messages: [] });
  setTimeout(() => ac.abort(), 200); // race 进行中 ~200ms 后 abort
  const out = await racing;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `abort 应立即返回（实际 ${elapsed}ms，远小于 5000ms 预算）`);
  assert.equal(out.messages.length, 0, 'abort 轮不 append');
  assert.ok(handle.slots.has('s-abort-mid'), 'abort 不清槽');
  assert.ok(!logger.has('warn', 'briefing=timeout'), 'abort 与超时是不同路径，不应误记 timeout');
  // 400ms settle 后槽位仍在（未超时过 → 留槽等 in-band）；后续正常 enter 步注入成功
  const out2 = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
  assert.equal(out2.messages.length, 1, '后续 enter 步仍能注入');
  assert.ok(out2.messages[0].content[0].text.includes('[agent-chamber] slow-briefing'));
});

test('session-start：无可键控 id → briefing=no-agent-id error + 不建槽（m9）', async () => {
  const { ctx, logger, handlers } = makeCtx();
  const handle = await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  emit(handlers, 'agent/session-start', { agent: { session: { header: { cwd: '/tmp' } } }, source: 'startup' });
  assert.equal(handle.slots.size, 0, '无 id 不建槽');
  assert.ok(logger.has('error', 'briefing=no-agent-id'));
});

test('pre-step：内部逻辑异常 → briefing=pre-step-error + 原样透传 decision（m9）', async () => {
  const { ctx, logger, handlers } = makeCtx();
  const handle = await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  const agent = makeAgent('s-err');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  // 注入故障到 onPreStepCore 的槽位查询路径（deps 与 handle 共享同一 Map 实例）
  const originalGet = handle.slots.get.bind(handle.slots);
  handle.slots.get = () => {
    throw new Error('poisoned map');
  };
  const decision = { kind: 'enter', messages: [] };
  const out = await runPreStep(handlers, { agent, signal: new AbortController().signal }, decision);
  handle.slots.get = originalGet; // 立即恢复：settleSlot 在 spawn settle 时还要用同一张表
  assert.equal(out, decision, '异常时原样透传 decision（waterfall 不允许 throw 拖垮 loop）');
  assert.ok(logger.has('error', 'briefing=pre-step-error'));
  // 收尾：等 spawn settle（快），防测试结束后遗留异步活动
  await pollUntil(() => true, 50);
});

test('pre-step：补投时 inject 抛错 → briefing=inject-failed warn + 清槽不升级（m9）', async () => {
  const { ctx, logger, handlers } = makeCtx();
  const handle = await applyChamber(ctx, {
    paths: { ...PATHS, hookScript: fx('slow.mjs') },
    preStepWaitMs: 2000,
    spawnTimeoutMs: 5000,
  });
  const badAgent = {
    id: 's-injfail',
    session: { id: 's-injfail', header: { cwd: '/tmp' } },
    inject() {
      throw new Error('disposed');
    },
  };
  emit(handlers, 'agent/session-start', { agent: badAgent, source: 'startup' });
  handle.slots.get('s-injfail').timedOut = true; // 模拟曾超时 → 400ms settle 走补投路径
  const logged = await pollUntil(() => logger.has('warn', 'briefing=inject-failed'), 3000);
  assert.ok(logged, '补投失败应留 warn 信号');
  assert.ok(!handle.slots.has('s-injfail'), '投递尝试后清槽');
});

test('简报 gate：resume/clear/compact 与 subagent 不建槽（v1.2.1 §7）', async () => {
  const { ctx, handlers } = makeCtx();
  const handle = await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  for (const source of ['resume', 'clear', 'compact']) {
    emit(handlers, 'agent/session-start', { agent: makeAgent(`s-${source}`), source });
    assert.ok(!handle.slots.has(`s-${source}`), `source=${source} 不应建槽`);
  }
  emit(handlers, 'agent/session-start', { agent: makeAgent('s-sub', { origin: 'subagent' }), source: 'startup' });
  assert.ok(!handle.slots.has('s-sub'), 'origin=subagent 不应建槽');
  emit(handlers, 'agent/session-start', { agent: makeAgent('s-deep', { delegationDepth: 1 }), source: 'startup' });
  assert.ok(!handle.slots.has('s-deep'), 'delegationDepth>0 不应建槽');
  emit(handlers, 'agent/session-start', { agent: makeAgent('s-top', { delegationDepth: 0 }), source: 'startup' });
  assert.ok(handle.slots.has('s-top'), '顶层 startup 应建槽');
});

test('agent/disposed → 槽位清除（防泄漏）', async () => {
  const { ctx, handlers } = makeCtx();
  const handle = await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  const agent = makeAgent('s-disposed');
  emit(handlers, 'agent/session-start', { agent, source: 'startup' });
  assert.ok(handle.slots.has('s-disposed'));
  emit(handlers, 'agent/disposed', { agent });
  assert.ok(!handle.slots.has('s-disposed'));
});

// ———————————————————————————— 功能② PreCompact 提醒 ————————————————————————————

test('compaction：compaction/start → 同步窗口内严禁 inject，setImmediate 后才投递', async () => {
  const { ctx, logger, handlers, agentsMap } = makeCtx();
  const agent = makeAgent('s-c1');
  agentsMap.set('s-c1', agent);
  await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  emit(handlers, 'session/event', { id: 's-c1' }, { type: 'compaction/start' });
  assert.equal(agent.injected.length, 0, '同步窗口内严禁 inject（撞 append 重入守卫被吞）');
  const done = await pollUntil(() => agent.injected.length > 0, 2000);
  assert.ok(done, 'setImmediate 后应 inject');
  const msg = agent.injected[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.source.kind, 'plugin');
  assert.equal(msg.source.plugin, 'agent-chamber');
  assert.ok(msg.content[0].text.includes('会话即将压缩'), '文本与 kimi-code format.mjs formatPreCompact 同源');
  assert.ok(logger.has('info', 'compact-reminder=injected'));
});

test('compaction：非 compaction 事件不触发；agents 查无此 session 不注入不炸', async () => {
  const { ctx, handlers, agentsMap } = makeCtx();
  const agent = makeAgent('s-c2');
  agentsMap.set('s-c2', agent);
  await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  emit(handlers, 'session/event', { id: 's-c2' }, { type: 'user/message' });
  emit(handlers, 'session/event', { id: 's-c2' }, { type: 'compaction/end' });
  emit(handlers, 'session/event', { id: 'unknown-session' }, { type: 'compaction/start' });
  await sleep(100); // 给 setImmediate 充足窗口：若误触发必然已发生
  assert.equal(agent.injected.length, 0);
});

test('compaction：inject 抛错 → warn 日志不升级', async () => {
  const { ctx, logger, handlers, agentsMap } = makeCtx();
  const badAgent = {
    id: 's-c4',
    session: { id: 's-c4', header: { cwd: '/tmp' } },
    inject() {
      throw new Error('disposed');
    },
  };
  agentsMap.set('s-c4', badAgent);
  await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  emit(handlers, 'session/event', { id: 's-c4' }, { type: 'compaction/start' });
  const logged = await pollUntil(() => logger.has('warn', 'compact-reminder=inject-failed'), 2000);
  assert.ok(logged, 'inject 失败应留 warn 信号');
});

// ———————————————————————————— 功能③ SYSTEM.md section ————————————————————————————

test('SYSTEM.md：读真实文件注册 section（形状三键 = name/order/text，无 interpolate 字段）', async () => {
  const { ctx, sections } = makeCtx();
  await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  assert.equal(sections.length, 1, '应注册恰好一个 section');
  const s = sections[0];
  assert.deepEqual(Object.keys(s).sort(), ['name', 'order', 'text'], 'PromptSection 三键形状，无 interpolate');
  assert.equal(s.name, SECTION_NAME);
  assert.equal(s.order, SECTION_ORDER);
  assert.equal(s.order, 100, 'persona(0) 之后、PLAN_POLICY(500) 之前');
  const real = await readFile(fileURLToPath(PATHS.systemMd), 'utf8');
  assert.equal(s.text, real, '注册文本应与 SYSTEM.md 逐字一致');
});

// v1.2.1 §1 硬约束：四种 '{{' 形态一律拒注册（运行时 throw 面宽于初版正则）
for (const form of ['{{$foo}}', '{{9}}', '{{ }}', '{{}}']) {
  test(`SYSTEM.md 自检：含 ${JSON.stringify(form)} → 拒注册 + error 日志`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ac-sysmd-'));
    try {
      const file = path.join(dir, 'SYSTEM.md');
      writeFileSync(file, `line1\n${form}\nline3`);
      const { ctx, logger, sections } = makeCtx();
      await applyChamber(ctx, {
        paths: { ...PATHS, hookScript: fx('briefing.mjs'), systemMd: pathToFileURL(file) },
      });
      assert.equal(sections.length, 0, '含 {{ 一律拒注册');
      assert.ok(logger.has('error', 'system-section=unsafe-interpolation'), '自检拒绝应留 error 信号');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('SYSTEM.md：读失败 → error 日志 + 跳过（与「服务缺失」不同日志，不 throw）', async () => {
  const missing = pathToFileURL(path.join(os.tmpdir(), 'dsh-ac-no-such-system.md'));
  const { ctx, logger, sections } = makeCtx();
  await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs'), systemMd: missing } });
  assert.equal(sections.length, 0);
  assert.ok(logger.has('error', 'system-section=read-failed'), '内容/IO 异常单独记日志');
  assert.ok(!logger.has('error', 'service=systemPrompt missing'), '服务在场时不应误报服务缺失');
});

test('SYSTEM.md：section 注册抛错（重名）→ error 日志，不升级不阻断', async () => {
  const { ctx, logger } = makeCtx();
  ctx.systemPrompt.section = () => {
    throw new Error('duplicate section name');
  };
  await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  assert.ok(logger.has('error', 'system-section=register-failed'));
});

// ———————————————————————————— 服务缺失与故障隔离 ————————————————————————————

test('服务缺失与内容异常分开记日志；三功能各自故障隔离', async () => {
  const { ctx, logger, handlers, sections } = makeCtx({ withAgents: false, withSystemPrompt: false });
  await applyChamber(ctx, { paths: { ...PATHS, hookScript: fx('briefing.mjs') } });
  assert.ok(logger.has('error', 'service=agents missing'), 'agents 缺失单独记');
  assert.ok(logger.has('error', 'service=systemPrompt missing'), 'systemPrompt 缺失单独记');
  assert.ok(handlers.has('agent/session-start') && handlers.has('agent/pre-step'), '功能①不依赖两服务，仍应装配');
  assert.ok(!handlers.has('session/event'), '功能②依赖 agents，应整体不装');
  assert.equal(sections.length, 0);
});

test('applyChamber 零 throw：全部资产路径损坏 → 仅 error 日志，监听器照装', async () => {
  const { ctx, logger, handlers } = makeCtx();
  const bad = path.join(os.tmpdir(), 'dsh-ac-nothing-here');
  await applyChamber(ctx, {
    paths: { hookScript: bad, systemMd: pathToFileURL(bad), formatModule: pathToFileURL(bad), skillsDirs: [bad] },
  });
  assert.ok(handlers.has('agent/session-start'), '功能①装配不受资产缺失影响（失败推迟到 spawn 时可见）');
  assert.ok(logger.has('error', 'feature=compact-reminder setup-failed'), 'format.mjs 动态 import 失败 → 仅此功能降级');
  assert.ok(logger.has('error', 'system-section=read-failed'));
  assert.ok(logger.has('error', 'skills-dir missing'), 'skills 自检兜底日志');
});

// ———————————————————————————— 消息形状 ————————————————————————————

test('消息对象形状：session 校验四件套（id 非空串 / role=user / source.kind / content 数组）', () => {
  const msg = createPluginMessage('hello');
  assert.equal(typeof msg.id, 'string');
  assert.notEqual(msg.id, '');
  assert.equal(msg.role, 'user');
  assert.ok(Array.isArray(msg.content));
  assert.equal(msg.content.length, 1);
  assert.deepEqual(msg.content[0], { type: 'text', text: 'hello' });
  assert.equal(msg.source.kind, 'plugin');
  assert.equal(msg.source.plugin, 'agent-chamber');
  assert.notEqual(createPluginMessage('x').id, createPluginMessage('x').id, '每条消息独立 id（inbox 拒绝重复 id）');
});

// ———————————————————————————— skills 目录自检 ————————————————————————————

test('skills 自检：真实两目录通过（与 cordis.patch.yml customSkillDirs 对齐）', () => {
  const logger = makeLogger();
  assert.deepEqual(checkSkillDirs(PATHS.skillsDirs, logger), []);
  assert.equal(logger.lines.error.length, 0);
});

test('skills 自检矩阵：missing / not-a-directory / 无 SKILL.md 束 / package.json 假阳性拒绝', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ac-skills-'));
  try {
    const logger = makeLogger();
    const aFile = path.join(dir, 'afile');
    writeFileSync(aFile, 'x');
    const noBundle = path.join(dir, 'nob');
    mkdirSync(noBundle);
    const fakeBundle = path.join(dir, 'fake');
    mkdirSync(fakeBundle);
    writeFileSync(path.join(fakeBundle, 'package.json'), '{}'); // 假阳性：有 package.json 无 SKILL.md
    const directBundle = path.join(dir, 'direct');
    mkdirSync(directBundle);
    writeFileSync(path.join(directBundle, 'SKILL.md'), '---\nname: x\n---'); // 束目录形态
    const rootForm = path.join(dir, 'rootform');
    mkdirSync(path.join(rootForm, 'child'), { recursive: true });
    writeFileSync(path.join(rootForm, 'child', 'SKILL.md'), '---\nname: y\n---'); // 根目录形态
    const problems = checkSkillDirs([path.join(dir, 'missing'), aFile, noBundle, fakeBundle, directBundle, rootForm], logger);
    assert.equal(problems.length, 4, 'missing + not-a-directory + 两个无束目录');
    assert.ok(problems.some((p) => p.includes('missing')));
    assert.ok(problems.some((p) => p.includes('not-a-directory')));
    assert.equal(problems.filter((p) => p.includes('has-no-skill-bundle')).length, 2);
    assert.equal(logger.lines.error.length, 4, '问题逐条 error 日志');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ———————————————————————————— 简报端到端（真实 spawn + mock platform） ————————————————————————————

let server;
let baseUrl; // http://127.0.0.1:<port>/api/v1
let mcpUrl; //  http://127.0.0.1:<port>/mcp（config.mjs 推导回 baseUrl）

before(async () => {
  // 场景前缀路由模式沿用 kimi-code tests：briefing 端点返回固定身份/任务/未读
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/v1/agents/me/briefing')) {
      res.end(
        JSON.stringify({
          code: 200,
          message: 'ok',
          data: {
            me: { id: 'a1', name: 'test-agent', status: 'active' },
            activeTasks: {
              items: [
                { id: 't1', title: 'Task One', status: 'in_progress', boardId: 'board-1', boardName: 'Test Board' },
                { id: 't2', title: 'Task Two', status: 'todo', boardId: 'board-1', boardName: 'Test Board' },
                { id: 't3', title: 'Task Three', status: 'todo', boardId: 'board-2', boardName: 'Other Board' },
              ],
              total: 3,
            },
            unreadCounts: [{ topicId: 't1', topicName: 'T1', unreadCount: 2 }],
            recentActivities: [],
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 404, message: 'not found', data: null }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  mcpUrl = baseUrl.replace(/\/api\/v1$/, '/mcp');
});

after(() => new Promise((r) => server.close(r)));

test('简报端到端：真实 spawn session-start.mjs 打 mock platform → 首轮注入文本含 [agent-chamber]', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ac-e2e-'));
  try {
    // 分支②场景（有 key 无绑定 → 模板 B）：与 kimi-code tests/hooks.test.mjs 同 fixture
    mkdirSync(path.join(dir, '.kimi-code'), { recursive: true });
    writeFileSync(
      path.join(dir, '.kimi-code', 'mcp.json'),
      JSON.stringify({ mcpServers: { chamber: { url: mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } }),
    );
    const home = path.join(dir, 'home'); // KIMI_CODE_HOME 隔离：logHook 落盘与用户级 mcp 都不沾本机
    const { ctx, logger, handlers } = makeCtx();
    await applyChamber(ctx, {
      paths: PATHS, // 真实 hookScript（端到端的本体）
      preStepWaitMs: 8000, // 真实 spawn + 本机 http：放宽预算
      env: { ...process.env, KIMI_CODE_HOME: home },
    });
    const agent = makeAgent('s-e2e', { cwd: dir });
    emit(handlers, 'agent/session-start', { agent, source: 'startup' });
    const out = await runPreStep(handlers, { agent, signal: new AbortController().signal }, { kind: 'enter', messages: [] });
    assert.equal(out.messages.length, 1, '首轮应注入简报');
    const text = out.messages[0].content[0].text;
    assert.ok(text.includes('[agent-chamber]'), '注入文本含 [agent-chamber]');
    assert.ok(text.includes('test-agent'), '含 mock platform 返回的 agent 名');
    assert.ok(text.includes('活跃任务 3'), '含简报数字');
    assert.ok(logger.has('info', 'briefing=injected'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ———————————————————————————— index.mjs 入口形状 ————————————————————————————

test('index.mjs：name/inject/apply 三件套；apply 零 throw（模块装载全链路兜底）', async () => {
  const entry = await import('../lib/index.mjs');
  assert.equal(entry.name, 'agent-chamber');
  assert.deepEqual(entry.inject, ['agents', 'systemPrompt']);
  assert.equal(typeof entry.apply, 'function');
  const { ctx } = makeCtx();
  await entry.apply(ctx); // 不 throw 即通过（内部真实读 SYSTEM.md/format.mjs，全链路演练）
});
