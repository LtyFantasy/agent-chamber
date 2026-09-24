// briefing.mjs — 测试夹具：读 stdin（消费后即弃），输出固定简报文本的 hookSpecificOutput JSON。
// 用于 pre-step 注入链路的快路径（百毫秒内 settle，远小于 2s 预算）。
let data = '';
process.stdin.on('data', (chunk) => {
  data += chunk;
});
process.stdin.on('end', () => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[agent-chamber] fake-briefing' },
    }),
  );
});
