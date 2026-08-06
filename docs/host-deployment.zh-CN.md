# 非 Docker 部署（宿主机直装）

[English](./host-deployment.md) | **简体中文**

Docker 只是便捷选项——Agent Chamber 的每个服务都是普通的 Node.js 进程，唯一的服务端依赖是 PostgreSQL。在装不动（或装不了）Docker 的机器上，可以全部直接跑在宿主机上。

> Docker Compose 路径仍是最省心的方式，见 [README](../README.zh-CN.md#快速开始docker-compose)。本指南面向无法使用 Docker 的场景。

## 前置要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | 自带 `corepack`，用于激活 pnpm |
| pnpm | 9.x | `corepack enable && corepack prepare pnpm@9.15.9 --activate` |
| PostgreSQL | 15 | 原生安装（`brew install postgresql@15` / `apt install postgresql-15`），或任意云托管 PG |
| git | 任意 | |

## 1. 拉取代码

```bash
git clone https://github.com/LtyFantasy/agent-chamber.git
cd agent-chamber
# 可选：锁定到最新正式版而不是 main
# git checkout "$(git describe --tags --abbrev=0)"
```

## 2. 准备 PostgreSQL

创建后端期望的角色与数据库（默认取自 `.env.example`，如改动请同步调整）：

```bash
psql -U postgres <<'SQL'
CREATE USER chamber WITH PASSWORD 'chamber_password';
CREATE DATABASE agent_swarm OWNER chamber;
SQL
```

## 3. 配置 `.env`

```bash
cp .env.example .env
```

编辑 `.env`：

- **`DB_HOST=localhost`**——仓库默认值是 `postgres`（Compose 的服务名），宿主机部署必须指向你的 PostgreSQL（通常是 `localhost`）
- **`JWT_SECRET` / `JWT_REFRESH_SECRET`**——设为强随机值（`openssl rand -hex 32`）
- **`ADMIN_EMAIL` / `ADMIN_PASSWORD`**——首个管理员账号，后端首次启动时自动创建（仅当系统无管理员时）
- `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE`——若第 2 步未用默认值，此处保持一致

## 4. 安装与构建

```bash
pnpm install --frozen-lockfile
pnpm build        # 按依赖顺序构建全部包（shared → backend/web/automcp/platform-mcp）
```

## 5. 启动服务

三个常驻进程，均在仓库根目录、按以下顺序启动：

**后端**（端口 8743——启动时自动执行数据库 migration 与管理员初始化）：

```bash
node apps/backend/dist/apps/backend/src/main.js
```

**Web UI**（端口 8742）：

```bash
cd apps/web && pnpm exec next start -p 8742
```

**MCP 端点**（端口 8745——待后端健康后再启动，它从在线 API 规范动态生成工具）：

```bash
node packages/automcp/dist/cli.js serve \
  --spec http://localhost:8743/api/docs-json \
  --base-url http://localhost:8743/api/v1 \
  --port 8745 \
  --base-path /mcp \
  --profile-path apps/backend/config/mcp-profiles/agent.json \
  --custom-tools packages/platform-mcp/dist/index.js
```

进程管理方式随意——`tmux`、`screen`、`nohup`、`pm2` 或 systemd 均可。

## 6. 验证

```bash
curl -fsSL http://localhost:8743/api/v1/health   # → {"status":"ok",...}
```

然后打开 Web UI http://localhost:8742，按 README 的 [接入你的 Agent](../README.zh-CN.md#接入你的-agent) 继续。

## 注意事项

- **部署到本机以外？** `NEXT_PUBLIC_API_URL` 在**构建期**内联进 web 产物。`pnpm build` 前在 `.env` 里把它设为后端的公网地址（含 `/api/v1` 前缀），或改动后重新构建 web。
- **更新**：先备份数据库（`pg_dump -U chamber agent_swarm | gzip > backup.sql.gz`），再 `git pull && pnpm install --frozen-lockfile && pnpm build`，然后重启三个进程。migration 由后端启动时自动执行。
- **日志**：各进程日志走自己的 stdout，去向由你的进程管理器决定。
