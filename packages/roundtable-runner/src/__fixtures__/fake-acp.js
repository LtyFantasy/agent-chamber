#!/usr/bin/env node
/**
 * 假 ACP 子进程（KimiAcpDriver 测试用）
 *
 * 用法: node fake-acp.js <fixture.json> <requestsLog.json>
 * （fixture/log 也可经环境变量 FAKE_ACP_FIXTURE / FAKE_ACP_LOG 传入——codex 桥
 *   规格的 spawn 命令只有脚本一个参数，测试用 env 兜底）
 *
 * 行为：
 * - 读 stdin 的 NDJSON JSON-RPC 请求；**第 i 个请求按 fixture[i] 应答**（按序消费）
 * - fixture 条目: { emit?: Array<完整 JSON-RPC 消息>, respond?: { result|error } }
 *   - emit 条目在 respond 之前逐行写 stdout（流式通知/反向 RPC 用，如 session/update、
 *     session/request_permission、usage_update）
 *   - respond 缺省 = 不应答（挂起，模拟长时间 turn / 死进程）
 * - 无 fixture 条目 → 不应答（挂起）
 * - client 对反向 RPC 的应答（{ jsonrpc, id, result|error } 无 method）与全部请求
 *   逐条追加写入 requestsLog.json（断言用）
 */
'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const fixturePath = process.argv[2] ?? process.env.FAKE_ACP_FIXTURE;
const logPath = process.argv[3] ?? process.env.FAKE_ACP_LOG;
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
let index = 0;

/** 写一行 JSON 到 stdout（agent → client 方向） */
function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 追加记录到 requestsLog（请求或 client 应答；文件跨进程累积——每个被驱动的
 * 子进程共用同一 logPath，追加模式保证多进程会话的请求都可见） */
function log(entry) {
  const entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  entries.push(entry);
  fs.writeFileSync(logPath, JSON.stringify(entries, null, 2));
}

// 追加模式：文件不存在才初始化；已存在（前一进程留下）则保留
if (!fs.existsSync(logPath)) {
  fs.writeFileSync(logPath, '[]');
}

// 环境快照（codex 规格断言 CODEX_CONFIG/CODEX_PATH；opencode 规格断言
// OPENCODE_CONFIG_CONTENT 权限钉死；claude 规格断言 ANTHROPIC_MODEL 模型注册保险；
// kimi 用例不受影响——条目无 method 且 direction='env'，现有 find/filter 断言均按
// method 过滤，宽松跳过）
log({
  direction: 'env',
  env: {
    CODEX_CONFIG: process.env.CODEX_CONFIG ?? null,
    CODEX_PATH: process.env.CODEX_PATH ?? null,
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? null,
  },
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    // client 对反向 RPC（如 request_permission）的应答：只记录，不再应答
    log({
      direction: 'response',
      id: msg.id,
      ...(msg.error ? { error: msg.error } : { result: msg.result }),
    });
    return;
  }
  log({ direction: 'request', id: msg.id, method: msg.method, params: msg.params });
  const entry = fixture[index];
  index += 1;
  if (!entry) return; // 无条目：挂起（不写任何响应）
  for (const emit of entry.emit ?? []) {
    writeLine(emit);
  }
  if (entry.respond) {
    if (typeof entry.delayMs === 'number' && entry.delayMs > 0) {
      // 延迟应答（优雅取消测试用：prompt 在途时先发 session/cancel 通知，delayMs
      // 后 resolve cancelled/end_turn——模拟 agent 收到取消后的正常收尾）
      setTimeout(() => writeLine({ jsonrpc: '2.0', id: msg.id, ...entry.respond }), entry.delayMs);
    } else {
      writeLine({ jsonrpc: '2.0', id: msg.id, ...entry.respond });
    }
  }
});
