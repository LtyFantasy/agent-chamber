// slow.mjs — 测试夹具：400ms 后才输出合法简报 JSON。
// 用于「pre-step 超时保留槽位 → resolve 仍可补投」与「race 期间防双重注入」两条链路
// （400ms 落在 preStepWaitMs=100 的预算之外、spawnTimeoutMs 之内）。
setTimeout(() => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[agent-chamber] slow-briefing' },
    }),
  );
}, 400);
