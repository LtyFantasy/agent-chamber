// chamber.mjs — dsh-agent-chamber 的功能胶水层（plan「交付物 A」唯一规格来源逐字执行）。
// 三功能（各自故障隔离，任何降级留结构化日志，日志词表见 README「降级信号」）：
//   ① SessionStart 简报（两段式，首轮必达）：agent/session-start 存 spawn promise →
//      首个 agent/pre-step waterfall await 注入（Promise.race 含 signal + 2s 超时）。
//   ② PreCompact 提醒：session/event 观察 compaction/start → setImmediate 延后 inject
//      （observer 在 session append 非重入窗口内被同步调用，同步 inject 撞守卫被吞——已实证硬事实 5）。
//   ③ SYSTEM.md system-prompt section：读兄弟仓文件 + '{{' 保守自检 + section 注册。
//   另：skills 目录布局自检（cordis.patch.yml customSkillDirs 的 sibling 假设兜底，诊断性质）。
// 铁律 #11：常量/字段/方法 rationale 一律注释。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ———————————————————————————— 常量（rationale 逐条注释） ————————————————————————————

/** source.plugin 归因值 + 日志前缀；session 校验要求 source.kind 非空字符串（assertMessageEventShape 实证） */
export const PLUGIN_NAME = 'agent-chamber';

/** pre-step 等待简报 promise 的预算（v1.2.1 §3 写死 2s：首轮必达与启动延迟的折中） */
export const PRE_STEP_WAIT_MS = 2000;

/**
 * spawn 硬超时兜底。session-start.mjs 内部 REST 超时 8s/路（Promise.allSettled 并行，上限仍 8s），
 * 加进程启动余量取 10s。关键不变量：该兜底保证槽位 promise 必然 settle，
 * v1.2.1 §3「轮末未投递 → 清槽 + briefing=timeout-dropped」才得以触发，槽位不泄漏。
 */
export const SPAWN_TIMEOUT_MS = 10_000;

/** section 排序：DEPLOYMENT_PERSONA_PREFIX=0 之后、PLAN_POLICY=500 之前（已实证硬事实 6） */
export const SECTION_ORDER = 100;

/** section 名：带插件前缀防撞名；同层重名注册会 throw（dsh-system-prompt .d.ts 实证），故必须稳定唯一 */
export const SECTION_NAME = 'agent-chamber:system';

/**
 * 复用资产路径推导（plan：自定位用 new URL，不用 createRequire 正则）。
 * 布局假设 = 仓内兄弟目录 plugins/kimi-code；布局变化由 checkSkillDirs + 各功能读文件失败的
 * error 日志兜住（路径推导断言见 tests：唯一能在 CI 抓住软链/布局变化的断言）。
 */
export const PATHS = {
  /** SessionStart 简报脚本（stdin 读 payload.cwd；stdout 出 hookSpecificOutput JSON——已实证硬事实 9） */
  hookScript: fileURLToPath(new URL('../../kimi-code/hooks/session-start.mjs', import.meta.url)),
  /** 协作规范 system prompt 文本源（URL 形态，readFile 直接收） */
  systemMd: new URL('../../kimi-code/SYSTEM.md', import.meta.url),
  /** formatPreCompact 文本源（跨包依赖，只允许动态 import——v1.2.1 §2） */
  formatModule: new URL('../../kimi-code/hooks/lib/format.mjs', import.meta.url),
  /** 与 cordis.patch.yml customSkillDirs 对应的两层技能目录（根目录形态 + 束目录形态） */
  skillsDirs: [
    fileURLToPath(new URL('../../kimi-code/skills', import.meta.url)),
    fileURLToPath(new URL('../../kimi-code/skills/agent-chamber', import.meta.url)),
  ],
};

/** Promise.race 哨兵：与槽位 promise 的结果对象区分（结果恒为对象，哨兵恒为 Symbol） */
const RACE_TIMEOUT = Symbol('briefing-race-timeout');
/** 同上：turn 取消信号先触发（此时 decision 将被丢弃，槽位保留等下一轮 pre-step） */
const RACE_ABORTED = Symbol('briefing-race-aborted');

// ———————————————————————————— 公共零件 ————————————————————————————

/**
 * 手搓用户消息（plan 硬约束 3：禁止 import dsh 的 createUserMessage）。
 * 四件套满足 dsh-session assertMessageEventShape：id 非空串 / role='user' / source.kind 非空 / content 数组。
 * @param {string} text 注入文本
 * @returns {{id:string, role:'user', content:Array<{type:'text',text:string}>, source:{kind:'plugin',plugin:string}}}
 */
export function createPluginMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME },
  };
}

/**
 * 槽位 promise 的三方竞争（promise / abort / 超时）。
 * m1 修复——race 输家清理：settle 即在 finally 里 clearTimeout + 摘 abort 监听
 * （{once:true} 只覆盖「触发后」；未触发的监听与未 firing 的 timer 是泄漏面，
 * 2s/8s 预算的 timer 挂到自然到期会直接拖住测试与进程的墙钟尾）。
 */
async function raceSlot(promise, signal, waitMs) {
  let timer;
  let onAbort;
  const timeoutP = new Promise((resolve) => {
    timer = setTimeout(() => resolve(RACE_TIMEOUT), waitMs);
  });
  const abortP = new Promise((resolve) => {
    if (!signal) return; // 无信号 → 该支路永不 resolve（退化为纯超时竞争）
    if (signal.aborted) {
      resolve(RACE_ABORTED);
      return;
    }
    onAbort = () => resolve(RACE_ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, timeoutP, abortP]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 槽位失败原因 → 日志词表映射（plan §55：briefing=timeout|fallback|empty）。
 * script-missing/spawn-error/spawn-timeout/invalid-json 统称 fallback（调用方下一步相同：查配置/环境）。
 */
function mapFailureReason(reason) {
  return reason === 'empty' ? 'empty' : 'fallback';
}

// ———————————————————————————— 功能 ①：SessionStart 简报 ————————————————————————————

/**
 * spawn 简报脚本并收集 stdout（永不 reject——结果是值不是异常，调用方按 ok 分支处理）。
 * M1：executor 全段包在 try/catch 里——非字符串 scriptPath、circular payload 的 JSON.stringify 等
 * 同步 throw 一律降级为 {ok:false}；promise 若意外 reject，.then 单参数调用方会漏成
 * unhandled rejection（Node 22 默认进程死亡），故本函数把「不 reject」当契约维护。
 * reason 词表：script-missing | spawn-error | spawn-timeout（已 SIGKILL）| invalid-json | empty。
 * @param {object} opts
 * @param {string} opts.scriptPath 简报脚本绝对路径
 * @param {object} opts.payload stdin JSON（{cwd, source, session_id, hook_event_name}）
 * @param {number} [opts.timeoutMs] 硬超时（到点 SIGKILL，保证 promise 必 settle）
 * @param {object} [opts.env] 子进程环境（缺省继承 process.env：脚本 logHook 落 ~/.kimi-code/logs 需要 HOME）
 * @param {string} [opts.execPath] 解释器路径（缺省 process.execPath；测试注入缝——传不存在路径可稳定触发异步 error）
 * @returns {Promise<{ok:true, text:string} | {ok:false, reason:string, detail?:string, killed?:boolean}>}
 */
export function runBriefingHook({ scriptPath, payload, timeoutMs = SPAWN_TIMEOUT_MS, env, execPath = process.execPath }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer;
    let graceTimer;
    let child; // 提升作用域：兜底 catch 需要能杀掉「已 spawn 但随后同步段 throw」的子进程（防泄漏持环）
    let stderrHead = ''; // 早期崩溃诊断：只留头部（drain 继续，只是不再记录，防背压）
    let stdinError = null; // stdin 写入失败（EPIPE：子进程早退）记入 detail
    const finish = (result) => {
      if (settled) return; // kill 后 error/close 可能双发，只认首个
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(result);
    };
    /** 失败 detail 统一装配：基础信息 + stderr 头 + stdin 错误（有则拼，m4） */
    const failDetail = (base) =>
      [base, stderrHead !== '' && `stderr=${stderrHead}`, stdinError && `stdin=${stdinError}`].filter(Boolean).join(' ');
    try {
      if (typeof scriptPath !== 'string' || !existsSync(scriptPath)) {
        // 布局假设破裂/参数畸形的显式信号（区别于 spawn 失败的 fallback：这是本仓文件缺失）
        finish({ ok: false, reason: 'script-missing', detail: String(scriptPath) });
        return;
      }
      try {
        child = spawn(execPath, [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: env ?? process.env,
        });
      } catch (error) {
        // spawn 同步抛（极端：execPath 参数畸形）——同样只是降级
        finish({ ok: false, reason: 'spawn-error', detail: failDetail(String(error)) });
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL'); // 硬兜底：kill 后 close/exit-grace 事件驱动 finish（槽位 promise 必 settle）
      }, timeoutMs);
      let stdout = '';
      child.stdout.setEncoding('utf8'); // m2：StringDecoder 处理 chunk 边界，防中文截断成 U+FFFD
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        if (stderrHead.length < 200) stderrHead = (stderrHead + d).slice(0, 200);
      });
      child.on('error', (error) => finish({ ok: false, reason: 'spawn-error', detail: failDetail(String(error)) }));
      /** close/grace 单点 settle：m5——孙进程持管道会拖延 close，exit 后 1s grace 兜底 */
      const onTerminated = (code) => {
        if (settled) return;
        clearTimeout(graceTimer);
        if (timedOut) return finish({ ok: false, reason: 'spawn-timeout', killed: true, detail: failDetail(`exit=${code}`) });
        const text = stdout.trim();
        // m3：空 stdout 前置分流为 empty（脚本的静默 fail-open 场景），非空非 JSON 才 invalid-json
        if (text === '') return finish({ ok: false, reason: 'empty', detail: failDetail(`exit=${code}`) });
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return finish({ ok: false, reason: 'invalid-json', detail: failDetail(`exit=${code} stdout=${text.slice(0, 120)}`) });
        }
        const additional = parsed?.hookSpecificOutput?.additionalContext;
        if (typeof additional !== 'string' || additional.trim() === '') {
          return finish({ ok: false, reason: 'empty', detail: failDetail(`exit=${code}`) });
        }
        finish({ ok: true, text: additional });
      };
      child.on('close', onTerminated);
      child.on('exit', (code) => {
        if (settled) return;
        graceTimer = setTimeout(() => onTerminated(code), 1000);
        graceTimer.unref?.(); // 纯兜底不挡进程退出（循环被孙进程持管拖住时仍会 fire）
      });
      child.stdin.on('error', (error) => {
        stdinError = String(error); // EPIPE 属预期（子进程早退），记入 detail 不单独失败
      });
      child.stdin.end(JSON.stringify(payload));
    } catch (error) {
      // 兜底（M1 真实场景：circular payload 的 JSON.stringify 在 spawn 之后才 throw）——
      // 子进程可能已在运行且 stdin 未送达，必须杀掉，否则它永远挂起持住事件循环
      try {
        child?.kill('SIGKILL');
      } catch {
        // kill 失败（进程已退）无害
      }
      finish({ ok: false, reason: 'spawn-error', detail: failDetail(`sync: ${String(error)}`) });
    }
  });
}

/**
 * session-start 事件处理（emit 模式 fire-and-forget，同步异常由调用处 try/catch 就地吃掉）。
 * gate：仅 source==='startup'（对齐 kimi-code matcher；resume/clear/compact 不注入——
 * resume 再注入"我的待办"可能诱使模型自行开工，README 如实登记该差异）+ 排除 subagent
 * （编译产物实证字段：session.header.origin==='subagent' 或 delegationDepth>0）。
 * @param {object} deps {logger, slots, options}
 * @param {object} payload {agent, source}
 */
function onSessionStart(deps, { agent, source }) {
  const { logger, slots, options } = deps;
  if (source !== 'startup') return;
  const header = agent?.session?.header;
  if (header?.origin === 'subagent') return;
  if (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) return;
  const id = agent?.id ?? agent?.session?.id; // Agent.id 即 SessionId（dsh-agent types.d.ts 实证）
  if (typeof id !== 'string' || id === '') {
    logger.error(`[${PLUGIN_NAME}] briefing=no-agent-id: session-start payload 无可键控 id，跳过`);
    return;
  }
  if (slots.has(id)) return; // 防御：同 agent 二次 session-start 不覆盖在途槽位
  // 手搓 stdin payload（kimi-code hook 契约：读 payload.cwd 向上找绑定（.agent-chamber/）与 mcp.json（.kimi-code/），绝不用进程 cwd）
  const payload = {
    cwd: header?.cwd,
    source,
    session_id: agent?.session?.id ?? id,
    hook_event_name: 'SessionStart',
  };
  const promise = runBriefingHook({
    scriptPath: options.paths.hookScript,
    payload,
    timeoutMs: options.spawnTimeoutMs,
    env: options.env,
  });
  const entry = { promise, agent, timedOut: false };
  slots.set(id, entry);
  // settle 处理挂早不挂晚；pre-step 消费后槽位已失则静默。
  // M1：双参数 then——runBriefingHook 契约上不 reject（executor 全段防护），
  // 但若契约被破坏，这里兜底清槽 + error 信号，绝不让 rejection 漏成 unhandled（Node 22 默认进程死亡）。
  promise.then(
    (result) => settleSlot(deps, id, entry, result),
    (error) => {
      if (slots.get(id) !== entry) return;
      slots.delete(id);
      logger.error(`[${PLUGIN_NAME}] briefing=hook-rejected agent=${id} error=${String(error)}`);
    },
  );
}

/**
 * 槽位 settle 处理（v1.2.1 §3 超时槽位语义）：
 *   - 成功且未超时 → 留槽等首个 pre-step in-band 注入（保证简报在第一轮 request 之前——inject 只能
 *     排进 next-step inbox，首请求之后才会被认领，故快路径绝不 inject）；
 *   - 成功但曾超时 → 补投（agent.inject），投递后清槽；
 *   - 失败 → 清槽不重试；曾超时记 briefing=timeout-dropped（轮末未投递），否则 briefing=fallback|empty。
 */
function settleSlot(deps, id, entry, result) {
  const { logger, slots } = deps;
  if (slots.get(id) !== entry) return; // 已被 pre-step 消费/清槽 → 不重复动作
  if (result.ok) {
    if (!entry.timedOut) return;
    slots.delete(id);
    try {
      entry.agent.inject(createPluginMessage(result.text));
      logger.info(`[${PLUGIN_NAME}] briefing=injected-late agent=${id}`);
    } catch (error) {
      // inject 失败（agent 已 dispose 等）——可见信号但不升级
      logger.warn(`[${PLUGIN_NAME}] briefing=inject-failed agent=${id} error=${String(error)}`);
    }
    return;
  }
  slots.delete(id);
  logger.warn(`[${PLUGIN_NAME}] briefing=${entry.timedOut ? 'timeout-dropped' : mapFailureReason(result.reason)} agent=${id} reason=${result.reason}`);
}

/**
 * pre-step waterfall 的 next 后段逻辑（v1.2.1 §3 形态写死：reject 早返回 + 成功后
 * `{ ...decision, messages: [...decision.messages, ours] }`；等待 = race(promise, abort, 2s)）。
 * 范式对照 dsh-tool-skill/lib/index.js:203-247（编译产物核实）。
 * next() 由布线层先行调用：对齐范式的同时把 try/catch 隔离边界收窄到「我们自己的逻辑」。
 * @param {object} deps {logger, slots, options}
 * @param {object} payload {agent, signal}
 * @param {object} decision 上游瀑布结果（{kind:'reject'} | {kind:'enter', messages, ...}）
 */
async function onPreStepCore(deps, { agent, signal }, decision) {
  const { logger, slots, options } = deps;
  if (decision.kind === 'reject') return decision; // 被拒步未发生：槽位不动，下个 pre-step 再试
  const id = agent?.id ?? agent?.session?.id;
  const entry = slots.get(id);
  if (!entry) return decision;
  if (signal?.aborted) return decision; // turn 已取消：decision 将被丢弃，保留槽位等下一轮
  const result = await raceSlot(entry.promise, signal, options.preStepWaitMs); // 剩余预算 ≤2s（v1.2.1 §3）
  if (result === RACE_ABORTED) return decision; // 不动槽位
  if (result === RACE_TIMEOUT) {
    // 超时保留槽位：resolve 仍可补投（settleSlot），下轮 pre-step 也可再 race
    entry.timedOut = true;
    logger.warn(`[${PLUGIN_NAME}] briefing=timeout agent=${id}`);
    return decision;
  }
  if (slots.get(id) !== entry) return decision; // race 期间 settleSlot 已补投/清槽 → 防双重注入
  if (!result.ok) {
    slots.delete(id); // spawn error/非 JSON/empty → 清槽不重试
    logger.warn(`[${PLUGIN_NAME}] briefing=${mapFailureReason(result.reason)} agent=${id} reason=${result.reason}`);
    return decision;
  }
  slots.delete(id); // 消费成功：in-band 注入并清槽防重复
  logger.info(`[${PLUGIN_NAME}] briefing=injected agent=${id}`);
  const messages = Array.isArray(decision.messages) ? decision.messages : [];
  return { ...decision, messages: [...messages, createPluginMessage(result.text)] };
}

/**
 * 功能 ① 布线：session-start（emit）+ pre-step（waterfall）+ disposed 清槽。
 * 本功能不依赖 ctx.agents/ctx.systemPrompt（agent 均来自事件 payload），服务缺失不阻断。
 * @returns {{slots: Map}} 测试观察口（per-agent 槽位表）
 */
function setupBriefing(ctx, logger, options) {
  const slots = new Map();
  const deps = { logger, slots, options };
  ctx.on('agent/session-start', (payload) => {
    try {
      onSessionStart(deps, payload);
    } catch (error) {
      // emit 模式同步异常就地吃掉：监听器 throw 会被 cordis containment 降级为 warn，但我们自己先兜住语义
      logger.error(`[${PLUGIN_NAME}] briefing=session-start-error error=${String(error)}`);
    }
  });
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next(); // 上游瀑布段的异常不属于我们的隔离边界，不兜
    try {
      return await onPreStepCore(deps, payload, decision);
    } catch (error) {
      // 瀑布必须返回 decision：我们的逻辑出错 → 原样透传 + 可见信号（waterfall 不允许 throw 拖垮 loop）
      logger.error(`[${PLUGIN_NAME}] briefing=pre-step-error error=${String(error)}`);
      return decision;
    }
  });
  ctx.on('agent/disposed', ({ agent }) => {
    slots.delete(agent?.id ?? agent?.session?.id); // 会话销毁清槽防泄漏（Map.delete 幂等无 throw）
  });
  return { slots };
}

// ———————————————————————————— 功能 ②：PreCompact 提醒 ————————————————————————————

/**
 * 功能 ② 布线：session/event 观察 compaction/start → setImmediate 延后 inject。
 * 需要 ctx.agents（session → agent 反查）；服务缺失 → error 日志 + 本功能不装（与内容异常分开记）。
 * format.mjs 动态 import（v1.2.1 §2）：失败 → error 日志 + 本功能不装（其余功能不受影响）。
 */
async function setupCompactionReminder(ctx, logger, options) {
  if (!ctx.agents || typeof ctx.agents.get !== 'function') {
    logger.error(`[${PLUGIN_NAME}] service=agents missing → compact-reminder disabled`);
    return;
  }
  const { formatPreCompact } = await import(options.paths.formatModule); // throw 由 applyChamber 按功能隔离
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'compaction/start') return;
    const agent = ctx.agents.get(session?.id); // 非本进程 agent / 已 dispose → 无可投递对象
    if (!agent) return;
    // 严禁同步 inject（已实证硬事实 5：observer 在 append 非重入窗口内同步调用，
    // 同步 session.append 撞 "cannot reenter" 守卫，被 observer containment 吞成 warn）
    setImmediate(() => {
      try {
        agent.inject(createPluginMessage(formatPreCompact()));
        logger.info(`[${PLUGIN_NAME}] compact-reminder=injected session=${session?.id}`);
      } catch (error) {
        logger.warn(`[${PLUGIN_NAME}] compact-reminder=inject-failed session=${session?.id} error=${String(error)}`);
      }
    });
  });
}

// ———————————————————————————— 功能 ③：SYSTEM.md section ————————————————————————————

/**
 * 功能 ③ 布线：读 SYSTEM.md → '{{' 保守自检（v1.2.1 §1：安装版 renderPrompt 严格插值且无
 * interpolate 开关，任何 '{{' 一律拒注册）→ systemPrompt.section({name, order, text})（三键形状）。
 */
async function setupSystemSection(ctx, logger, options) {
  if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') {
    logger.error(`[${PLUGIN_NAME}] service=systemPrompt missing → system-section disabled`);
    return;
  }
  let text;
  try {
    text = await readFile(options.paths.systemMd, 'utf8');
  } catch (error) {
    // 内容/IO 异常与服务缺失分开记日志（plan 硬约束）
    logger.error(`[${PLUGIN_NAME}] system-section=read-failed path=${options.paths.systemMd} error=${String(error)}`);
    return;
  }
  if (text.includes('{{')) {
    logger.error(`[${PLUGIN_NAME}] system-section=unsafe-interpolation: SYSTEM.md contains '{{' → NOT registered`);
    return;
  }
  try {
    ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text });
    logger.info(`[${PLUGIN_NAME}] system-section=registered name=${SECTION_NAME} order=${SECTION_ORDER}`);
  } catch (error) {
    // 重名/非法 order 等注册期异常 → 可见信号，不升级（其余功能不受影响）
    logger.error(`[${PLUGIN_NAME}] system-section=register-failed error=${String(error)}`);
  }
}

// ———————————————————————————— skills 目录自检 ————————————————————————————

/**
 * skills 目录布局自检（plan §77 + v1.2.1 §4）：cordis.patch.yml 的 customSkillDirs sibling 假设
 * 由配置层求值，apply 内只能做可见性兜底——问题逐条 error 日志，绝不 throw。
 * 判定：statSync.isDirectory() + 含 SKILL.md 束（不接受 package.json 假阳性）。
 * "含 SKILL.md 束" = 目录本身含 SKILL.md（束目录形态）或至少一个直接子目录含 SKILL.md（根目录形态，
 * dsh-skill-filesystem 扫描语义：根的 [{name}/SKILL.md] 直接子束——编译产物核实）。
 * @param {string[]} dirs 待检目录（绝对路径）
 * @param {object} logger 日志器
 * @returns {string[]} 问题清单（空数组 = 全部通过）；同时逐条写 error 日志
 */
export function checkSkillDirs(dirs, logger) {
  const problems = [];
  for (const dir of dirs) {
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      problems.push(`skills-dir missing: ${dir}`);
      continue;
    }
    if (!stat.isDirectory()) {
      problems.push(`skills-dir not-a-directory: ${dir}`);
      continue;
    }
    if (!containsSkillBundle(dir)) {
      problems.push(`skills-dir has-no-skill-bundle: ${dir}`);
    }
  }
  for (const problem of problems) logger.error(`[${PLUGIN_NAME}] ${problem}`);
  return problems;
}

/** 目录是否含至少一个 SKILL.md 束（本身或直接子目录）；readdir 失败按不含处理（调用方只用于诊断日志） */
function containsSkillBundle(dir) {
  if (existsSync(join(dir, 'SKILL.md'))) return true;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')));
}

// ———————————————————————————— 总装 ————————————————————————————

/**
 * 三功能总装（apply() 零 throw 的执行层）：逐功能 try/catch 故障隔离，
 * 任何降级都在功能内部留结构化日志；本层 catch 的是「连降级日志都没能写」级的意外。
 * @param {object} ctx Cordis 上下文
 * @param {object} [options] 测试注入口
 * @param {object} [options.paths] 资产路径覆写（缺省 PATHS 自定位）
 * @param {number} [options.preStepWaitMs] pre-step 等待预算（缺省 2000）
 * @param {number} [options.spawnTimeoutMs] spawn 硬超时（缺省 10000）
 * @param {object} [options.env] spawn 环境覆写（缺省 process.env）
 * @returns {Promise<{slots: Map|null}>} 测试观察口
 */
export async function applyChamber(ctx, options = {}) {
  const logger = ctx.logger;
  const opts = {
    paths: options.paths ?? PATHS,
    preStepWaitMs: options.preStepWaitMs ?? PRE_STEP_WAIT_MS,
    spawnTimeoutMs: options.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS,
    env: options.env,
  };
  const handle = { slots: null };
  const features = [
    // [名, 装配函数]——名进故障隔离日志；briefing 装配返回槽位表供测试观察
    ['briefing', () => setupBriefing(ctx, logger, opts)],
    ['compact-reminder', () => setupCompactionReminder(ctx, logger, opts)],
    ['system-section', () => setupSystemSection(ctx, logger, opts)],
  ];
  for (const [feature, setup] of features) {
    try {
      const result = await setup();
      if (feature === 'briefing') handle.slots = result?.slots ?? null;
    } catch (error) {
      logger.error(`[${PLUGIN_NAME}] feature=${feature} setup-failed error=${String(error)}`);
    }
  }
  // skills 目录自检（诊断性质，非常规功能）：布局假设破裂 → error 日志，不阻断任何东西
  try {
    checkSkillDirs(opts.paths.skillsDirs, logger);
  } catch (error) {
    logger.error(`[${PLUGIN_NAME}] skills-dir check-failed error=${String(error)}`);
  }
  return handle;
}
