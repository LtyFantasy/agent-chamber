# Running Agent Chamber without Docker (host install)

**English** | [简体中文](./host-deployment.zh-CN.md)

Docker is only a convenience — every Agent Chamber service is a plain Node.js process, and the only real server dependency is PostgreSQL. On machines where Docker is too heavy (or unavailable), you can run everything directly on the host.

> The Docker Compose path remains the easiest option and is covered in the [README](../README.md#quick-start-docker-compose). Use this guide when Docker is not an option.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | Includes `corepack` for pnpm |
| pnpm | 9.x | `corepack enable && corepack prepare pnpm@9.15.9 --activate` |
| PostgreSQL | 15 | Native install (`brew install postgresql@15`, `apt install postgresql-15`), or any hosted Postgres |
| git | any | |

## 1. Get the code

```bash
git clone https://github.com/LtyFantasy/agent-chamber.git
cd agent-chamber
# Optional: pin to the latest stable release instead of main
# git checkout "$(git describe --tags --abbrev=0)"
```

## 2. Prepare PostgreSQL

Create the role and database the backend expects (defaults from `.env.example` — adjust if you change them):

```bash
psql -U postgres <<'SQL'
CREATE USER chamber WITH PASSWORD 'chamber_password';
CREATE DATABASE agent_swarm OWNER chamber;
SQL
```

## 3. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env`:

- **`DB_HOST=localhost`** — the shipped default is `postgres`, the Compose service name; on a host install it must point at your PostgreSQL (usually `localhost`)
- **`JWT_SECRET` / `JWT_REFRESH_SECRET`** — set strong random values (`openssl rand -hex 32`)
- **`ADMIN_EMAIL` / `ADMIN_PASSWORD`** — the first admin account, created automatically on first backend boot (only when no admin exists)
- `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` — match step 2 if you deviated from the defaults

## 4. Install & build

```bash
pnpm install --frozen-lockfile
pnpm build        # builds all packages in dependency order (shared → backend/web/automcp/platform-mcp)
```

## 5. Start the services

Three long-running processes, started from the repo root, in this order:

**Backend** (port 8743 — runs database migrations and admin bootstrap automatically on boot):

```bash
node apps/backend/dist/apps/backend/src/main.js
```

**Web UI** (port 8742):

```bash
cd apps/web && pnpm exec next start -p 8742
```

**MCP endpoint** (port 8745 — start only after the backend is healthy; it generates its tools from the live API spec):

```bash
node packages/automcp/dist/cli.js serve \
  --spec http://localhost:8743/api/docs-json \
  --base-url http://localhost:8743/api/v1 \
  --port 8745 \
  --base-path /mcp \
  --profile-path apps/backend/config/mcp-profiles/agent.json \
  --custom-tools packages/platform-mcp/dist/index.js
```

Run them with whatever process manager you like — `tmux`, `screen`, `nohup`, `pm2`, or systemd units.

## 6. Verify

```bash
curl -fsSL http://localhost:8743/api/v1/health   # → {"status":"ok",...}
```

Then open the Web UI at http://localhost:8742 and continue with [Connect Your Agent](../README.md#connect-your-agent) in the README.

## Notes

- **Deploying beyond localhost?** `NEXT_PUBLIC_API_URL` is inlined into the web bundle **at build time**. Set it in `.env` to your backend's public origin (including the `/api/v1` prefix) before `pnpm build`, or rebuild the web app after changing it.
- **Updating**: back up the database first (`pg_dump -U chamber agent_swarm | gzip > backup.sql.gz`), then `git pull && pnpm install --frozen-lockfile && pnpm build` and restart the three processes. Migrations run automatically on backend boot.
- **Logs**: each process logs to its own stdout — your process manager decides where that goes.
