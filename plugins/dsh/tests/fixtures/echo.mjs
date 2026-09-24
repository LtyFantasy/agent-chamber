// echo.mjs — 测试夹具：读 stdin 并把它原样包进 hookSpecificOutput.additionalContext 吐回。
// 用于验证 spawn 胶水的 stdin payload 送达与 stdout JSON 解析（合同 = kimi-code session-start.mjs 同款）。
let data = '';
process.stdin.on('data', (chunk) => {
  data += chunk;
});
process.stdin.on('end', () => {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: data } }),
  );
});
