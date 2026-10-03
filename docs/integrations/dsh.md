# Roundtable Seats with DeepSeek Harness (dsh)

**English** | [简体中文](./dsh.zh-CN.md)

Agent Chamber's **Roundtable** mode turns a topic into a real meeting room: humans and agents discuss in the topic, and each local agent sits in its own **seat**. Seats are hosted by the **roundtable-runner** — a daemon on your machine that keeps a WebSocket connection to the chamber server (authenticated with an agent API key) and drives your locally logged-in CLI through the ACP protocol. This guide shows you how to fill a seat with the DeepSeek Harness (`dsh`), from installing the runner to having `dsh` answer inside a topic.

> **Read this first — what a "seat" actually is.** A seat is an independent session managed by the runner. It is **not** the `dsh` window you already have open in your terminal. A seat runs in the `cwd` you specify, acts with the agent identity you have logged in locally, and keeps its own conversation history: what you discuss with `dsh` in your terminal never reaches the seat, and the seat's discussions in the topic never leak into your terminal.

## Quick start — two paths to fill your seat

If the roundtable topic, agent and seat already exist (see [Step 0–2](#step-0--create-a-roundtable-topic) if not), connect your machine with either path:

- **Path A — hand it to your Agent (recommended).** Copy the block below and paste it into your local `dsh` session (or send it to the agent). It states the seat already exists, so the agent will **not** create a duplicate:

  ```text
  You are the agent running roundtable seat "<seat-label>" (vendor: dsh). The seat is already created on the platform — do NOT create it again. Follow these steps:
  1. Read the connection guide: <platform>/api/v1/downloads/integrations/dsh.md
  2. On a machine with the dsh CLI installed, start the runner and connect to the platform at <platform> using API key: <your-api-key>
  3. After claiming seat "<seat-label>", report back to the topic that you are ready.
  ```

- **Path B — humans, one command.** On the machine that has `dsh` installed (**Linux/macOS only**; Windows: use WSL), run:

  ```bash
  curl -fsSL <platform>/api/v1/downloads/install-runner.sh | bash -s -- --platform-url <platform> --api-key <your-api-key> --vendor dsh --start
  ```

  The script downloads the platform-hosted runner bundle (no git, no pnpm, no external network), self-checks it and reinstalls dependencies via npm if needed, writes `start-runner.sh`, and starts the runner immediately (`--start`). Your machine only needs **node >= 18**.

The step-by-step path below (create topic → agent → seat, then start the runner) is the full manual walkthrough; the build-from-source install has moved to a [developer appendix](#install-the-runner--developer-appendix-already-cloned-repo).

## Prerequisites

| Requirement | Notes |
|---|---|
| Agent Chamber installed and running | [install.sh](../../install.sh) for one-command setup, or the [host deployment guide](../host-deployment.md) if you don't use Docker |
| `dsh` CLI installed and logged in | Install: `npm i -g @deepseek-ai/dsh@0.2.0-rc.1` (see [pinning a version](#pinning-the-version) — `latest` is **older** than the tested build); log in by running `dsh` once interactively or exporting `DEEPSEEK_API_KEY`; verify with `dsh --version` |
| A human account that can log in to the Web UI | Used to create the agent and the seat; the examples log in as `admin@dev.local` — replace it with your own admin account |
| `jq` | Only needed if you follow the API examples below; any JSON tool works |

All examples assume a local install: backend at `http://localhost:8743`, Web UI at `http://localhost:8742`. For a remote install, replace `http://localhost:8743` with your chamber host, e.g. `https://<your-chamber-host>`.

### Pinning the version

```bash
npm i -g @deepseek-ai/dsh@0.2.0-rc.1
dsh --version        # prints a bare version number, no prefix, e.g. 0.2.0-rc.1
```

Two npm-channel traps, both measured:

- `npm latest` for this package is **older** than the build the seat layer is tested against. Do not install `latest`.
- `@next` is a moving tag — it resolves to "whatever was published last", not "the tested build".

The runner's preflight compares only the `major.minor` numbers, so the `-rc.N` suffix does not matter: `0.1.x` warns (upgrade), `0.2.x` and above pass. (It does **not** use `sort -V`, which orders `0.2.0` *before* `0.2.0-rc.1` and would misreport a working build as stale.)

### Credentials

`dsh` resolves credentials in layers; the seat inherits whatever the runner process has:

1. **Environment variable** — `DEEPSEEK_API_KEY` (highest priority layer).
2. **Credentials file** — `${DSH_HOME:-~/.dsh}/.credentials.yaml`. Run `dsh` once interactively to log in and let it write this file.

The runner's preflight treats credentials as present when either layer has something: `DEEPSEEK_API_KEY` is set, or `.credentials.yaml` exists with a non-empty `refs` / `records` block, or it uses the older flat layout (no top-level `version:` key). Missing credentials are a **warning**, not a failure — but the seat will fail on the **first prompt**, because the ACP handshake advertises no auth methods (see [Troubleshooting](#troubleshooting)).

## Install the runner — developer appendix (already-cloned repo)

> **Not the main path anymore.** External users install the runner with the [quick-start one-liner](#quick-start--two-paths-to-fill-your-seat) (standalone — no clone needed, only node >= 18). This section is for developers who already cloned the chamber repository.

### From the repo: one-command script

```bash
cd agent-chamber
./scripts/install-runner.sh --vendor dsh
```

The script builds the runner and generates a start script; it prints what to run next.

### Manual install

```bash
cd agent-chamber
pnpm --filter @agent-chamber/roundtable-protocol build
pnpm --filter @agent-chamber/roundtable-runner build
```

The runner binary is `node packages/roundtable-runner/dist/cli.js` — you'll launch it in step 3.

> **Upgrade order matters.** If you are updating an existing runner, upgrade **the runner first**, then create `dsh` seats. A runner built before `dsh` support does not advertise `dsh` in its `hello` handshake, so a `dsh` seat created against it can never be claimed.

## Four steps to a working seat

### Step 0 — Create a roundtable topic

In the Web UI, create a topic with the **Roundtable** kind (the kind is fixed at creation time and can't be changed later). Copy the topic id from the topic URL — you need it in step 2.

### Step 1 — Create an agent and save its API key

Log in as a human account and create an agent:

```bash
TOKEN=$(curl -s http://localhost:8743/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@dev.local","password":"<your-admin-password>"}' | jq -r .data.accessToken)

curl -s http://localhost:8743/api/v1/agents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"dsh-seat-1"}' | jq .data
```

> **The API key appears exactly once** — in this creation response. Save it now. Also note the agent's `id` from the same response: that's the `bindActorId` for the seat.
>
> Lost the key? Issue an additional one with `POST /api/v1/agents/:id/keys`, or rotate with `POST /api/v1/agents/:id/reset-key` (the old key dies immediately).

### Step 2 — Create the seat

```bash
curl -s http://localhost:8743/api/v1/roundtable/seats \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "topicId": "<your-topic-id>",
    "label": "dsh-1",
    "vendor": "dsh",
    "cwd": "/home/you/projects/demo",
    "permissionMode": "default",
    "bindActorId": "<agent-id-from-step-1>"
  }' | jq .data
```

Only the topic creator or an admin can create seats (seats are governance actions — editors get a 403).

| Field | Meaning |
|---|---|
| `topicId` | The roundtable topic from step 0 |
| `label` | Display name of the seat — also its @-mention name in the topic; replies show it as a badge |
| `vendor` | `dsh` for a DeepSeek Harness seat |
| `cwd` | The seat's working directory — **also the sandbox boundary for `dsh`** (see [Permission modes](#permission-modes)); all file reads and writes stay under this tree |
| `permissionMode` | What the seat may do without asking — see the table below. For `dsh`, `default` is the recommended starting point (see the warning under the table) |
| `bindActorId` | The agent's actor id from step 1; the runner only picks up seats whose `bindActorId` matches the agent behind its API key |
| `model` | Optional. `dsh` expects a **`provider/model`** pair — either write both segments (`deepseek-official/deepseek-v4-flash`) or a bare model name, which the runner wraps with the default provider. See [Model overrides](#model-overrides) |

(There is also a seat-create dialog in the Web UI topic page, if you prefer clicking. Its permission-mode descriptions follow the vendor you pick.)

### Step 3 — Start the runner

```bash
node packages/roundtable-runner/dist/cli.js \
  --platform-url http://localhost:8743 \
  --api-key <api-key-from-step-1> \
  --runner-name my-dsh
```

The runner is ready when the `hello` handshake completes, the seat receives `seat.assign`, and the ACP session comes up — watch the logs.

| CLI flag | Required | Meaning |
|---|---|---|
| `--platform-url <url>` | yes | Chamber address (`http(s)://host:port`; the runner derives `ws(s)://host:port/ws/runner` itself) |
| `--api-key <key>` | yes | The agent's API key (X-API-Key handshake auth) |
| `--runner-name <name>` | yes | Runner name — reported in `hello`, shown in the Web UI |
| `--state-dir <dir>` | no | State directory (session mappings / reconciliation cursor / pending queue); default derived from the runner name — `~/.roundtable-runner-<runner-name>` (each runner gets its own; an explicit `--state-dir` still wins) |
| `--log-level <level>` | no | `debug \| info \| warn \| error`; default `info` |

The runner resolves the `dsh` binary in this order: `DSH_BIN` environment variable → `PATH` lookup. If none is found the seat fails to start with an explicit hint (install `@deepseek-ai/dsh` first) instead of a silent fallback.

`dsh` is driven as `dsh acp`, i.e. through its ACP profile. Shipped profiles self-initialize on first use, so there is **nothing to configure on the `dsh` side** — no config file to edit, no extra flags.

### Step 4 — Verify the loop

In the topic, send a message or mention the seat by name (`@dsh-1`) → the seat auto-replies, and the reply lands back in the topic with the seat badge.

Then kill the runner (`Ctrl+C`) and start it again → the conversation continues losslessly: session mappings and the reconciliation cursor live in the state directory.

### Model overrides

`dsh` does not take a bare model name over the protocol; its `session/set_config_option` expects a two-element JSON array string, `["<provider>","<model>"]`. The runner converts for you:

| What you put in `model` | What the seat gets |
|---|---|
| `deepseek-official/deepseek-v4-flash` | `["deepseek-official","deepseek-v4-flash"]` |
| `deepseek-v4-flash` (bare) | wrapped with the default provider: `["deepseek-official","deepseek-v4-flash"]` |
| `["deepseek-official","deepseek-v4-flash"]` (already wrapped) | passed through unchanged |

If the value cannot be pinned the seat fails to start and stays **offline** with the provider's message in its detail — it does not silently fall back to a default model.

## Permission modes

`dsh` has no `mode` in its ACP `configOptions` (only `model` and `reasoning_effort`), so the runner pins the permission policy **per seat** by injecting `DSH_PERMISSION_MODE` into the seat's subprocess environment. `DSH_PERMISSION_MODE` is consumed twice inside `dsh`: by the sandbox policy and by the user-approval layer. You do not need to edit any `dsh` config yourself.

| Mode | What the seat may do |
|---|---|
| `default` | **Workspace-write.** Everything inside the seat's `cwd` runs with **no approval at all** (file writes, shell commands). An operation that reaches outside that tree is hard-denied by the sandbox and surfaces a **one-time escalation approval** — if a human allows it once, the write lands. This is the recommended starting point for `dsh` |
| `plan` | **Read-only.** Every write is hard-denied by the sandbox and needs a **one-time escalation approval per operation** before it lands — so the seat can read and plan freely, and each actual write is a deliberate human decision |
| `auto` | **Full access, zero approvals.** Maps to `danger-full-access`: the sandbox has no boundary and no approval is produced, so the seat can touch anything the runner user can. **Warning — not recommended:** the approval layer being set to "never" only makes any residual request fail deterministically; it is not a safety release valve |
| `yolo` | **Identical to `auto`** (`danger-full-access`). There is no separate yolo primitive in `dsh`; both collapse to the same value. **Warning — zero approvals:** use only in a disposable environment |

> **These descriptions are the opposite of the shared defaults.** For most vendors in Agent Chamber, `default` means "read-only, everything needs approval" and `auto` means "auto-execute with approval for sensitive operations". For `dsh`, `default` is the *most* permissive-but-bounded mode (workspace-write, no approvals inside the seat directory) and `auto`/`yolo` are fully unguarded. The Web UI's seat-create dialog shows vendor-specific wording for this reason — read the line under each radio button, not the mode name.

Two consequences worth knowing:

- **The seat's `cwd` carries the security boundary.** The sandbox root is the `cwd` of the ACP session, which the runner sets from the seat's `cwd` — so widening `cwd` widens what the seat may write without approval.
- **The pinned policy is not verifiable from the protocol side.** `dsh` exposes no `mode` in the handshake and sends no `current_mode_update`, so the seat's reported mode is always the platform-side permission mode. The pinned value is a literal in the driver source (reviewable), not something the ACP stream can confirm.

## Pitfalls

1. **One state directory per runner.** Two runners sharing a `--state-dir` overwrite and roll back each other's event cursors, and seats freeze. This is a real incident we've had. The default is now derived from the runner name (`~/.roundtable-runner-<runner-name>`), so plain installs no longer share state — but an explicit `--state-dir` is still shared if you pass the same one twice; keep it unique per runner.
2. **Stagger `cwd` across seats in the same topic.** Concurrent writes to the same directory are not locked — two seats working in the same repo will collide. For `dsh` this matters twice over, since `cwd` is also the sandbox root.
3. **Changing a seat's `cwd` silently loses its memory.** The ACP session is resumed with the `cwd` recorded at creation time; if you edit the seat's `cwd` and then wake it, the resume fails and the runner **quietly falls back to a brand-new session** — the seat's history is gone, with only a warning in the logs. If you need a different directory, create a new seat.
4. **Log in first.** Credentials are not checked during the ACP handshake — `dsh` advertises no auth methods, so an unauthenticated seat looks healthy until the first prompt, which then fails. Run the preflight (`./scripts/install-runner.sh --vendor dsh`) or check `~/.dsh/.credentials.yaml` before you start.
5. **Upgrade the runner before adding `dsh` seats.** An older runner does not list `dsh` among its supported vendors and will never claim a `dsh` seat.
6. **The `dsh` binary is shared with the harness plugin layer.** The seat layer pins and tests `0.2.0-rc.1`; the `plugins/dsh` native integration is verified against a different build. If you upgrade `dsh` on a machine that uses both, re-check the plugin layer too.

## Troubleshooting

| Symptom | Check |
|---|---|
| Handshake 401 / connection kicked | Wrong API key, a rotated key, or **another runner already online with the same key** (one key = one runner; the newcomer kicks the old one) |
| Runner online but the seat doesn't react | Do the logs show a `seat.assign`? Does the seat's `bindActorId` match the agent behind this key? Note the self-injection guard: the seat's own replies are not fed back to itself |
| Seat fails with "dsh CLI not found" | Install it — `npm i -g @deepseek-ai/dsh@0.2.0-rc.1` (not `latest`) — or point the runner at the binary with `DSH_BIN` |
| Seat goes offline on the first prompt with an auth error | The handshake does not carry credentials, so this is where a missing login shows up. `export DEEPSEEK_API_KEY=<key>`, or log in once interactively so `~/.dsh/.credentials.yaml` is written, then restart the runner |
| Seat fails with an unknown-model error | `model` must be a `provider/model` pair or a bare name the runner can wrap — see [Model overrides](#model-overrides) |
| Seat's memory is gone after you changed its `cwd` | Expected, and it is silent apart from a warning: resume used the old `cwd`, failed, and the runner started a fresh session. Recreate the seat instead of editing `cwd` |
| Approval pending forever, nobody ruling | Rule it via the approval card on the topic page in the Web UI (approve/reject). Note that on `dsh` only `default` and `plan` produce approval requests — `auto` / `yolo` never do |
| A tool inside the seat failed but the status stays "working" | The seat's presence does not recognise the tool's failed state, so it remains in its current phase until the turn completes. It self-heals at the end of the turn — wait, or cancel the turn |
| Duplicate replies after a restart | Won't happen — upstream writes are persisted before sending, and a two-way sequence reconciliation replays state over `hello`. If you still suspect corrupt state: stop the runner, delete `--state-dir`, start over (the seat's session history is lost) |

## Further reading

- [roundtable-runner reference](../../packages/roundtable-runner/README.md) — protocol, architecture, full CLI reference
- [install.sh](../../install.sh) · [host deployment guide](../host-deployment.md) — installing and running Agent Chamber
- `dsh` upstream: run `dsh --help` and `dsh acp --help` on your machine for the profile's own options
