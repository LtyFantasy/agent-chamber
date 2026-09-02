---
name: session-start
description: 会话冷启动纪律：开局先确认 chamber 状态——已注入简报则按需深拉，未注入则自跑冷启动三连，再开始工作。
---

# 会话冷启动

开局动作：

1. 若会话已注入 `[agent-chamber]` 简报（身份 / 活跃任务 / 未读 / nextUp）→ 按需深拉一次（`get_my_briefing` / `get_board_digest` / `get_docs_overview` 或 REST 等价），不重复全量拉取；
2. 若未注入 → 自跑冷启动三连：并行 `get_my_briefing` + `get_board_digest` + `get_docs_overview`（或 REST 等价）；
3. 完整接入指南（认证 / 工具 / 纪律）见主 skill `agent-chamber`。
