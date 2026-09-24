# plugins/

Agent Chamber 生态的 Harness 插件目录（对外分发产物，chamber 品牌口吻直写，不经 rebrand）。

- `kimi-code/` — Kimi Code 插件（`/plugins install` 入口，含 skills / hooks / agents / systemPrompt；接入与开发文档见 `kimi-code/README.md`）
- `kimi.plugin.json` — 仓根薄 manifest（GitHub URL 整仓安装入口，路径指向 `plugins/kimi-code/`）
- `dsh/` — DeepSeek Harness 原生 bundle（会话启动简报注入 + 侧栏 chamber 面板 + 内置 skills；文档见 `dsh/README.md`）
