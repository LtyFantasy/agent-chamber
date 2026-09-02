#!/usr/bin/env node
// precompact.mjs — PreCompact hook 入口（P1 实现，计划 §2.5）
// 目的：compact 前提醒持久化工作状态（设计 §4）。
// 机制风险：官方事件表明示 PreCompact "return values are completely ignored"（§0.3），
// 本输出是否进上下文待 P5 决策门判定（§6.2.3）；不通过则裁掉本 hook。
// 无 REST、常 fail-open：任何异常 → exit 0 空输出。
import { readFileSync } from 'node:fs';
import { formatPreCompact, enforceGuardrail } from './lib/format.mjs';
import { logHook } from './lib/logger.mjs';

function main() {
  // 读 stdin → JSON.parse；失败 → exit 0 静默（fail-open）
  try {
    JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  // 输出模板 E（纯文本；是否进上下文由 P5 决策门判定）
  process.stdout.write(enforceGuardrail(formatPreCompact()));
}

try {
  main();
} catch (err) {
  // 兜底 fail-open：任何异常 → 记日志 → exit 0 空输出
  logHook('PreCompact', `uncaught: ${err?.message ?? err}`);
}
