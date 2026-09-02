#!/usr/bin/env node
// session-start.mjs — SessionStart hook 入口（P1 实现，计划 §2.4）
// 三分支：① 无 key → 模板 A（未接入）；② 有 key 无绑定 → briefing + 模板 B；
//         ③ 有 key + 绑定 → 并行两 GET（Promise.allSettled，digest 失败降级省 nextUp 行）+ 模板 C。
// REST 失败/配置违例 → 分支④ 模板 D（不静默但同样 exit 0）。
// fail-open 语义（官方 hooks）：任何异常/非零退出均不影响主流程，会话无损。
// 输出：toHookJson 包装（实验 c——纯文本 stdout 实测不进上下文，改试 hookSpecificOutput JSON，详见 format.mjs）。
import { readFileSync } from 'node:fs';
import { resolveConfig, resolveKey, resolveApiBase } from './lib/config.mjs';
import { fetchBriefing, fetchDigest, BriefingError } from './lib/briefing.mjs';
import {
  formatNotConfigured,
  formatUnbound,
  formatBound,
  formatConfigError,
  enforceGuardrail,
  toHookJson,
} from './lib/format.mjs';
import { logHook } from './lib/logger.mjs';

/** 统一 stdout 出口：先护栏截断，再 hookSpecificOutput JSON 包装（实验 c） */
function emit(text) {
  process.stdout.write(toHookJson('SessionStart', enforceGuardrail(text)));
}

async function main() {
  // ① 读 stdin → JSON.parse；失败 → exit 0 静默（fail-open）
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }

  // P5 决策门诊断：无条件记录入口调用（含 payload.source），用于区分"hook 未触发"与"stdout 被 CLI 吞掉"。
  // 成功分支原本不写日志；此行成本极低、诊断价值高，P5 结论落定后决定去留。
  logHook('SessionStart', `invoked source=${payload?.source ?? 'unknown'}`);

  // ② projectDir = payload.cwd（绝不用进程 cwd——插件 hooks 运行时 cwd=插件根，官方-plugins）
  const projectDir = payload.cwd || '';

  // ③ 解析配置（向上查找绑定/身份文件 + 用户级身份文件）
  let cfg;
  try {
    cfg = resolveConfig(projectDir);
  } catch (err) {
    logHook('SessionStart', `config resolve failed: ${err?.message ?? err}`);
    return;
  }
  // 文件存在但解析失败（损坏）→ 记日志（诊断价值），按不存在处理（fail-open）
  if (cfg.bindingPath && !cfg.binding) logHook('SessionStart', 'agent-chamber.json parse failed');
  if (cfg.projectMcpPath && !cfg.projectMcp) logHook('SessionStart', 'project mcp.json parse failed');

  // ④ 取 key（四步优先级，§2.3）
  const { key, status: keyStatus, serverName, serverUrl } = resolveKey(cfg.binding, cfg.projectMcp, cfg.userMcp);

  if (!key) {
    // 指针错配 / 命中无 key → 分支④（A4：与完全未配置区分文案）
    if (keyStatus === 'pointer-mismatch') {
      const reason = `mcpServer 指针 "${serverName}" 未命中（server 不存在/非 HTTP/被禁用）`;
      logHook('SessionStart', reason);
      emit(formatConfigError(reason));
      return;
    }
    if (keyStatus === 'no-key-in-server') {
      const reason = `mcpServer 指针 "${serverName}" 命中但 headers 无 X-API-Key`;
      logHook('SessionStart', reason);
      emit(formatConfigError(reason));
      return;
    }
    // 完全未配置 → 分支①
    emit(formatNotConfigured());
    return;
  }

  // ⑤ 推导 apiBaseUrl（显式 → mcp url 推导 → 配置不完整；S6 scheme 白名单）
  const { baseUrl, status: baseStatus } = resolveApiBase(cfg.binding, serverUrl);
  if (!baseUrl) {
    const reason =
      baseStatus === 'incomplete'
        ? '配置不完整：REST-only 模式需在 agent-chamber.json 显式填写 apiBaseUrl'
        : baseStatus === 'invalid-scheme'
          ? 'apiBaseUrl scheme 非 https（仅 localhost/127.0.0.1 允许 http）'
          : 'mcp server url 非法';
    logHook('SessionStart', reason);
    emit(formatConfigError(reason));
    return;
  }

  // ⑥ 分支判定：有 key + boardId 非空 → 分支③；否则分支②
  const boardId = cfg.binding?.boardId;
  const hasBinding = typeof boardId === 'string' && boardId.trim() !== '';

  try {
    if (hasBinding) {
      // 分支③：并行两 GET（各自 8s 超时）。Promise.allSettled（A5 降级）：
      // briefing 成功 + digest 失败 → 简报照出、省 nextUp 行（其余行不变）；
      // briefing 失败才走分支④（throw 到下方 catch）。
      const [briefingResult, digestResult] = await Promise.allSettled([
        fetchBriefing(baseUrl, key),
        fetchDigest(baseUrl, boardId.trim(), key),
      ]);
      if (briefingResult.status === 'rejected') throw briefingResult.reason;
      if (digestResult.status === 'rejected') {
        // digest 失败仅记日志（诊断价值），不阻断简报注入
        const err = digestResult.reason;
        logHook(
          'SessionStart',
          `digest fetch failed: ${err instanceof BriefingError ? err.reason : err?.message ?? err}`,
          err instanceof BriefingError ? err.status : null,
        );
      }
      const briefing = briefingResult.value;
      const digest = digestResult.status === 'fulfilled' ? digestResult.value : null;
      emit(formatBound(briefing, digest, cfg.binding));
    } else {
      // 分支②：仅 briefing
      const briefing = await fetchBriefing(baseUrl, key);
      emit(formatUnbound(briefing.name, briefing.activeTasksTotal, briefing.unreadTotal));
    }
  } catch (err) {
    // 分支④：REST 失败（401/404/网络/超时）→ 模板 D，不静默但 exit 0
    const reason = err instanceof BriefingError ? err.reason : `unexpected: ${err?.message ?? err}`;
    logHook('SessionStart', reason, err instanceof BriefingError ? err.status : null);
    emit(formatConfigError(reason));
  }
}

main().catch((err) => {
  // 兜底 fail-open：任何未捕获异常 → 记日志 → exit 0 空输出
  logHook('SessionStart', `uncaught: ${err?.message ?? err}`);
});
