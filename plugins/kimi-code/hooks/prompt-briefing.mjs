#!/usr/bin/env node
// prompt-briefing.mjs — UserPromptSubmit hook 入口（实验 d）
// 背景：SessionStart 是 observation-only（stdout 不进上下文，已两次实验证实）；官方文档承诺
//       UserPromptSubmit "returned text is appended to context"——纯文本 stdout + exit 0 即注入通路，
//       不用 hookSpecificOutput JSON（那是 PreToolUse/Stop 的阻塞语义）。
// 事件语义 = 每条用户消息都触发 → 本 hook 自己做会话级去重：仅每个 session 的首条消息注入一次简报。
// 流程（顺序严格）：读 stdin → 取 session_id（消毒为 marker 名）→ marker 已存在则静默 exit 0 →
//       复用 session-start 管线（config → key → apiBase → 模板 A/B/C/D）→ 纯文本 stdout →
//       确定性结果写 marker（transient 不写，下条消息重试）→ 顺手清理超期 marker。
// fail-open：任何异常 → 记日志 + exit 0；绝不非零退出、绝不写 stderr（stderr + exit 2 是阻塞语义，用错会挡住用户消息）。
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveConfig, resolveKey, resolveApiBase } from './lib/config.mjs';
import { fetchBriefing, fetchDigest, BriefingError } from './lib/briefing.mjs';
import {
  formatNotConfigured,
  formatUnbound,
  formatBound,
  formatConfigError,
  enforceGuardrail,
} from './lib/format.mjs';
import { logHook } from './lib/logger.mjs';

/** marker 保留天数：超过即清理（best-effort，防 marker 目录无限增长） */
const MARKER_TTL_DAYS = 7;

/**
 * 统一 stdout 出口：纯文本（UserPromptSubmit 文档承诺的注入通路）。
 * 与 session-start 的关键差异：不包 toHookJson——hookSpecificOutput JSON 是阻塞事件（PreToolUse/Stop）的语义，
 * 本事件文档承诺 returned text 直接 append 进上下文，纯文本即可。
 * @param {string} text 已过护栏的模板文本
 */
function emit(text) {
  process.stdout.write(enforceGuardrail(text));
}

/**
 * 消毒为安全文件名：非 [a-zA-Z0-9_-] 一律替换为 _。
 * session_id 官方保证存在且为稳定标识，但防御性处理（防路径穿越/非法字符）。
 * @param {string} name 原始标识（session_id 或 cwd）
 * @returns {string} 消毒后的文件名片段
 */
function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * marker 目录解析（优先级从高到低）：
 *   1. CHAMBER_HOOK_STATE_DIR（测试隔离重定向，直接就是 marker 目录）
 *   2. $KIMI_CODE_HOME/agent-chamber-hooks.d/injected（插件 hooks 官方保证携带 KIMI_CODE_HOME）
 *   3. ~/.kimi-code/agent-chamber-hooks.d/injected（缺省回退，与 logger.mjs 路径统一）
 * @returns {string} marker 目录绝对路径
 */
function resolveStateDir() {
  if (process.env.CHAMBER_HOOK_STATE_DIR) return process.env.CHAMBER_HOOK_STATE_DIR;
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'agent-chamber-hooks.d', 'injected');
}

/**
 * 会话级去重 key：session_id 优先（官方文档保证存在）。
 * 缺失时 fallback 用 cwd 的稳定标识——同一项目目录的所有会话共享同一 key，
 * 即"每个项目目录只注入一次"（比无 key 时每次消息都注入的噪音更小）；
 * 跨项目目录 key 不同，各自注入一次。两者都为空 → 'unknown-session' 兜底。
 * @param {object} payload stdin JSON payload
 * @returns {string} 去重 key（未消毒，由调用方 sanitize）
 */
function resolveSessionKey(payload) {
  const sid = payload?.session_id;
  if (typeof sid === 'string' && sid.trim() !== '') return sid.trim();
  const cwd = payload?.cwd;
  if (typeof cwd === 'string' && cwd.trim() !== '') return cwd.trim();
  return 'unknown-session';
}

/**
 * transient 错误判定：transient（网络失败/超时/5xx）→ 不写 marker，让下一条消息重试；
 * 确定性结果（成功、未接入、401/404 等 4xx、配置违例）→ 写 marker，避免每次消息都重复注入/重复报错。
 * @param {Error} err 捕获的异常（BriefingError 或未知异常）
 * @returns {boolean} true = transient（不写 marker）
 */
function isTransient(err) {
  if (!(err instanceof BriefingError)) return true; // 未知异常保守视为 transient
  const s = err.status;
  if (s == null) return true; // timeout / network-error / invalid-json-response
  if (s >= 500) return true; // HTTP 5xx 或业务 code 500（服务端故障，重试可能恢复）
  return false; // 4xx（401/404 等）→ 确定性
}

/**
 * 写 marker（内容 = ISO 时间戳 + 注入结果类别，空格分隔）。
 * flag 'wx' 原子创建：并发双跑时第二个 EEXIST 静默（TOCTOU 兜底，不重复注入）。
 * 写失败不影响主流程（fail-open）。
 * @param {string} markerPath marker 文件绝对路径
 * @param {string} category 注入结果类别（bound / unbound / not-configured / config-error）
 */
function writeMarker(markerPath, category) {
  try {
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()} ${category}`, { flag: 'wx' });
  } catch {
    // 写 marker 失败（含并发 EEXIST）→ 静默（fail-open）
  }
}

/**
 * 清理超期 marker（best-effort）：mtime 超过 MARKER_TTL_DAYS 天的文件删除。
 * 整体 try/catch 包裹——目录不存在/无权限/单个文件被并发删除都不影响主流程。
 * @param {string} stateDir marker 目录
 */
function cleanupStaleMarkers(stateDir) {
  try {
    const cutoff = Date.now() - MARKER_TTL_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(stateDir)) {
      const p = path.join(stateDir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // 单个文件 stat/unlink 失败（可能已被并发删除）→ 跳过
      }
    }
  } catch {
    // 目录不存在/无权限 → 静默（best-effort）
  }
}

async function main() {
  // ① 读 stdin → JSON.parse；失败 → 记日志 + exit 0 静默（fail-open，绝不能阻塞用户消息）
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    logHook('UserPromptSubmit', 'stdin parse failed');
    return;
  }

  // ② 会话 key + marker 路径；顺手清理超期 marker（每次运行都做，best-effort）
  const sessionKey = resolveSessionKey(payload);
  const stateDir = resolveStateDir();
  const markerPath = path.join(stateDir, sanitize(sessionKey));
  cleanupStaleMarkers(stateDir);

  // ③ marker 已存在 → 本会话已注入过 → 静默 exit 0（stdout 必须为空）
  if (existsSync(markerPath)) return;

  // ④ 复用 session-start 管线：projectDir = payload.cwd（绝不用进程 cwd——插件 hooks 运行时 cwd=插件根）
  const projectDir = payload.cwd || '';
  let cfg;
  try {
    cfg = resolveConfig(projectDir);
  } catch (err) {
    logHook('UserPromptSubmit', `config resolve failed: ${err?.message ?? err}`);
    return;
  }
  if (cfg.bindingPath && !cfg.binding) logHook('UserPromptSubmit', 'agent-chamber.json parse failed');
  if (cfg.projectMcpPath && !cfg.projectMcp) logHook('UserPromptSubmit', 'project mcp.json parse failed');

  // ⑤ 取 key（四步优先级，与 session-start 同一套 resolveKey）
  const { key, status: keyStatus, serverName, serverUrl } = resolveKey(cfg.binding, cfg.projectMcp, cfg.userMcp);

  if (!key) {
    // 指针错配 / 命中无 key → 模板 D（确定性配置问题，写 marker）
    if (keyStatus === 'pointer-mismatch') {
      const reason = `mcpServer 指针 "${serverName}" 未命中（server 不存在/非 HTTP/被禁用）`;
      logHook('UserPromptSubmit', reason);
      emit(formatConfigError(reason));
      writeMarker(markerPath, 'config-error');
      return;
    }
    if (keyStatus === 'no-key-in-server') {
      const reason = `mcpServer 指针 "${serverName}" 命中但 headers 无 X-API-Key`;
      logHook('UserPromptSubmit', reason);
      emit(formatConfigError(reason));
      writeMarker(markerPath, 'config-error');
      return;
    }
    // 完全未配置 → 模板 A（确定性，写 marker）
    emit(formatNotConfigured());
    writeMarker(markerPath, 'not-configured');
    return;
  }

  // ⑥ 推导 apiBaseUrl（显式 → mcp url 推导 → 配置不完整；scheme 白名单）
  const { baseUrl, status: baseStatus } = resolveApiBase(cfg.binding, serverUrl);
  if (!baseUrl) {
    const reason =
      baseStatus === 'incomplete'
        ? '配置不完整：REST-only 模式需在 agent-chamber.json 显式填写 apiBaseUrl'
        : baseStatus === 'invalid-scheme'
          ? 'apiBaseUrl scheme 非 https（仅 localhost/127.0.0.1 允许 http）'
          : 'mcp server url 非法';
    logHook('UserPromptSubmit', reason);
    emit(formatConfigError(reason));
    writeMarker(markerPath, 'config-error');
    return;
  }

  // ⑦ 分支判定：有 key + boardId 非空 → 模板 C；否则模板 B
  const boardId = cfg.binding?.boardId;
  const hasBinding = typeof boardId === 'string' && boardId.trim() !== '';

  try {
    if (hasBinding) {
      // 分支③：并行两 GET（各自 8s 超时）。Promise.allSettled（A5 降级）：
      // briefing 成功 + digest 失败 → 简报照出、省 nextUp 行、marker 照写（bound，下个 session 自然重试）；
      // briefing 失败才走模板 D（throw 到下方 catch，transient 判定沿用）。
      const [briefingResult, digestResult] = await Promise.allSettled([
        fetchBriefing(baseUrl, key),
        fetchDigest(baseUrl, boardId.trim(), key),
      ]);
      if (briefingResult.status === 'rejected') throw briefingResult.reason;
      if (digestResult.status === 'rejected') {
        // digest 失败仅记日志（诊断价值），不阻断简报注入
        const err = digestResult.reason;
        logHook(
          'UserPromptSubmit',
          `digest fetch failed: ${err instanceof BriefingError ? err.reason : err?.message ?? err}`,
          err instanceof BriefingError ? err.status : null,
        );
      }
      const briefing = briefingResult.value;
      const digest = digestResult.status === 'fulfilled' ? digestResult.value : null;
      emit(formatBound(briefing, digest, cfg.binding));
      writeMarker(markerPath, 'bound');
    } else {
      const briefing = await fetchBriefing(baseUrl, key);
      emit(formatUnbound(briefing.name, briefing.activeTasksTotal, briefing.unreadTotal));
      writeMarker(markerPath, 'unbound');
    }
  } catch (err) {
    // REST 失败：transient（网络/超时/5xx）不写 marker → 下条消息重试；确定性（401/404 等）写 marker
    const reason = err instanceof BriefingError ? err.reason : `unexpected: ${err?.message ?? err}`;
    logHook('UserPromptSubmit', reason, err instanceof BriefingError ? err.status : null);
    emit(formatConfigError(reason));
    if (!isTransient(err)) writeMarker(markerPath, 'config-error');
  }
}

main().catch((err) => {
  // 兜底 fail-open：任何未捕获异常 → 记日志 → exit 0 空输出
  logHook('UserPromptSubmit', `uncaught: ${err?.message ?? err}`);
});
