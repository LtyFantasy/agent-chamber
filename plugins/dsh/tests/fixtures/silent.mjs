// silent.mjs — 测试夹具：exit 0 且 stdout 全空（脚本静默 fail-open 场景），
// 验证 spawn 胶水的空输出前置分流：reason=empty 而非 invalid-json（m3）。
process.exit(0);
