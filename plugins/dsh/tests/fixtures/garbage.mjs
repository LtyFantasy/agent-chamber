// garbage.mjs — 测试夹具：输出非 JSON 垃圾，验证 spawn 胶水 fail-open（resolve {ok:false} 而非 throw）。
process.stdout.write('not-json{{{');
