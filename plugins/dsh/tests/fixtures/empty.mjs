// empty.mjs — 测试夹具：输出合法 hookSpecificOutput JSON 但无 additionalContext（脚本 fail-open 静默场景）。
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart' } }));
