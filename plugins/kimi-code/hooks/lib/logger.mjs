// logger.mjs — hook 诊断日志（S5 脱敏 + A4 路径统一）
// 路径：$KIMI_CODE_HOME/logs/agent-chamber-hooks.log（append；KIMI_CODE_HOME 缺省回退 ~/.kimi-code）。
// 字段白名单（S5）：时间戳/事件名/错误消息/HTTP status；禁止写 headers/完整 URL/key 值。
// 写日志本身静默 try/catch（fail-open：日志失败绝不影响 hook 主流程）。
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 写一行诊断日志（append）。
 * @param {string} eventName 事件名（如 'SessionStart' / 'PreCompact'）
 * @param {string} message 错误消息/原因（写入前统一 redact 脱敏）
 * @param {number|null} [status] HTTP status 或业务 code（白名单字段；无则 null）
 */
export function logHook(eventName, message, status = null) {
  try {
    const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    const logDir = path.join(home, 'logs');
    mkdirSync(logDir, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      event: eventName,
      message: redact(String(message)),
      ...(status == null ? {} : { status: Number(status) }),
    };
    appendFileSync(path.join(logDir, 'agent-chamber-hooks.log'), `${JSON.stringify(entry)}\n`);
  } catch {
    // 写日志本身静默失败（fail-open）
  }
}

/**
 * 统一脱敏（S5）：key 形态（ask_ 开头长串）→ ask_***；完整 URL → [redacted-url]。
 * 白名单之外的一切（headers/query 值等）由调用方不传入保证，此处为兜底。
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  return String(text)
    .replace(/ask_[A-Za-z0-9]{10,}/g, 'ask_***')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[redacted-url]');
}
