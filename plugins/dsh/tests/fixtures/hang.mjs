// hang.mjs — 测试夹具：永不退出，验证 spawn 硬超时 SIGKILL（promise 必 settle → 槽位不泄漏）。
setInterval(() => {}, 1000);
