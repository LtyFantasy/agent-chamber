#!/usr/bin/env bash
# =============================================================================
# install-runner.sh — Roundtable Runner 一键安装脚本（双模，Linux/macOS only）
#
# 双模检测（向后兼容）：
#   - repo 模式（默认，现状保留）：检测到 packages/roundtable-runner/package.json
#     （即已 clone 仓库）→ build-from-source（开发者/已 clone 用户）
#   - standalone 模式（新）：非仓库目录运行 → 从平台 /api/v1/downloads/ 下载
#     自包含 bundle 安装（零外网依赖，用户机器只需 node；Windows 请走 WSL）
#
# 用法:
#   ./scripts/install-runner.sh                      # repo 模式：构建 + 生成 start-runner.sh
#   ./scripts/install-runner.sh --vendor codex       # 只做 codex 侧预检
#   ./scripts/install-runner.sh --dry-run            # 只打印动作不执行
#   curl -fsSL <platform>/api/v1/downloads/install-runner.sh | bash -s -- \
#     --platform-url https://platform.example.com --api-key <KEY> --start   # standalone
#
# 行为（两种模式公共）:
#   1. 按 --vendor 预检 kimi/codex CLI（codex 侧检测 chatgpt.com 连通性，
#      不通则打印代理设置指引——国内 DNS 污染是第一大坑）
#   2. 生成 start-runner.sh（含 platform-url / api-key / runner-name / state-dir）
#   3. state-dir 默认派生 ~/.roundtable-runner-<runner-name>（R3：消灭共享状态
#      目录假死事故的默认路径；显式 --state-dir 仍优先，两种模式统一）
#
# standalone 模式额外行为（R2）:
#   - --platform-url 必填（平台地址，下载 bundle 与写入 start-runner.sh）
#   - 解压到 --install-dir（默认 ~/.local/share/agent-chamber/runner/）
#   - 自检 node cli.js --help：失败自动 npm install --omit=dev 重建依赖
#     （vendored node_modules 可能跨平台不兼容——mac arm64 vs linux x64 的
#     codex-acp 依赖链；npm 是 node 自带，无需 pnpm/git）
#   - --start 时 setsid 立即后台启动并打印日志路径
#
# 不做：不装 systemd/pm2、不创建 agent/座位（需要人类 JWT，属于平台侧操作）。
#
# 前置要求：node（>=18；repo 模式还需 pnpm），kimi 和/或 codex CLI 已登录
# =============================================================================
set -euo pipefail

# ---------- 默认值（均可被同名环境变量覆盖） ----------
REPO_DIR="${REPO_DIR:-}"                              # chamber 仓库根（默认 = 本脚本上级目录）
PLATFORM_URL="${PLATFORM_URL:-http://localhost:8743}" # chamber 后端地址，写入 start-runner.sh
API_KEY="${API_KEY:-}"                                # 座位 agent 的 API Key（可留空，之后手填 start-runner.sh）
RUNNER_NAME="${RUNNER_NAME:-roundtable-runner}"       # runner 名称（hello 上报，web 展示）
STATE_DIR="${STATE_DIR:-}"                            # 状态目录（空 → 下方按 R3 派生）
VENDOR="${VENDOR:-both}"                              # kimi | codex | both（预检范围）
DRY_RUN="${DRY_RUN:-0}"                               # 1 = 只打印动作不执行
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/agent-chamber/runner}"  # standalone 解压目录
START="${START:-0}"                                   # 1 = 生成 start-runner.sh 后立即启动（仅 standalone）
PLATFORM_URL_SET=0                                    # 1 = 用户显式传过 --platform-url（standalone 必填判定）

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[install-runner]${NC} $*"; }
warn() { echo -e "${YELLOW}[install-runner]${NC} $*"; }
fail() { echo -e "${RED}[install-runner] ERROR:${NC} $*" >&2; exit 1; }

# run —— dry-run 模式下只打印命令不执行
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo -e "${YELLOW}[dry-run]${NC} $*"
  else
    "$@"
  fi
}

usage() {
  cat <<'EOF'
Usage: install-runner.sh [OPTIONS]

Install the roundtable-runner (dual mode) and generate a start script.

Dual mode:
  - repo mode (default): run inside a cloned chamber repo — build from source
  - standalone mode:     run outside a repo — download the platform-hosted bundle
                         from <platform-url>/api/v1/downloads/roundtable-runner.tar.gz

Options:
  -d, --dir <path>          chamber repo root (default: this script's parent dir)
  -u, --platform-url <url>  platform backend URL (required in standalone mode)
  -k, --api-key <key>       agent API key written into start-runner.sh
                            (optional; edit start-runner.sh later if omitted)
  -n, --runner-name <name>  runner name (default: roundtable-runner)
      --state-dir <dir>     runner state dir (default: ~/.roundtable-runner-<runner-name>)
      --vendor <v>          preflight scope: kimi | codex | both (default: both)
      --install-dir <dir>   standalone install dir
                            (default: ~/.local/share/agent-chamber/runner)
      --start               standalone only: start the runner immediately (setsid)
      --dry-run             print actions without executing anything
  -h, --help                show this help message and exit

Next steps after this script: create an agent + seat, then ./start-runner.sh
See docs/integrations/kimi.md and docs/integrations/codex.md.
EOF
}

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)
      [[ $# -ge 2 ]] || fail "$1 需要一个参数"
      REPO_DIR="$2"; shift 2 ;;
    -u|--platform-url)
      [[ $# -ge 2 ]] || fail "$1 需要一个参数"
      PLATFORM_URL="$2"; PLATFORM_URL_SET=1; shift 2 ;;
    -k|--api-key)
      [[ $# -ge 2 ]] || fail "$1 需要一个参数"
      API_KEY="$2"; shift 2 ;;
    -n|--runner-name)
      [[ $# -ge 2 ]] || fail "$1 需要一个参数"
      RUNNER_NAME="$2"; shift 2 ;;
    --state-dir)
      [[ $# -ge 2 ]] || fail "$1 需要一个参数"
      STATE_DIR="$2"; shift 2 ;;
    --vendor)
      [[ $# -ge 2 ]] || fail "$1 需要一个参数"
      VENDOR="$2"; shift 2 ;;
    --install-dir)
      [[ $# -ge 2 ]] || fail "$1 需要一个参数"
      INSTALL_DIR="$2"; shift 2 ;;
    --start)
      START=1; shift ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      fail "未知参数: $1（-h 查看用法）" ;;
  esac
done

case "$VENDOR" in
  kimi|codex|both) ;;
  *) fail "--vendor 只能是 kimi | codex | both，收到: $VENDOR" ;;
esac

# ---------- state-dir 默认派生（R3，两种模式统一） ----------
# 默认 ~/.roundtable-runner-<runner-name>：每个 runner 独占状态目录，
# 消灭「共享状态目录导致座位假死」的历史事故（多 runner 必须各自 --state-dir）。
# 注意：RUNNER_NAME 含 `/` 等非法路径字符时在此处替换为 -（防御性，不改语义）
STATE_DIR="${STATE_DIR:-$HOME/.roundtable-runner-${RUNNER_NAME//\//-}}"

# ---------- 模式检测 ----------
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [[ -f "$REPO_DIR/packages/roundtable-runner/package.json" ]]; then
  MODE=repo
else
  MODE=standalone
fi

# ---------- CLI 预检（按 vendor 范围，两种模式共用） ----------
# 缺 CLI 只警告（不影响另一厂商座位）；两个都缺才失败
preflight_clis() {
  CLI_MISSING=0
  if [[ "$VENDOR" == "kimi" || "$VENDOR" == "both" ]]; then
    if command -v kimi >/dev/null 2>&1; then
      info "kimi CLI: $(kimi --version 2>/dev/null || echo 'found')"
    else
      warn "未找到 kimi CLI（kimi 座位将无法启动）。安装登录后重试；只做 codex 座位可用 --vendor codex 跳过本检查"
      CLI_MISSING=1
    fi
  fi
  if [[ "$VENDOR" == "codex" || "$VENDOR" == "both" ]]; then
    if command -v codex >/dev/null 2>&1; then
      info "codex CLI: $(codex --version 2>/dev/null || echo 'found')"
    else
      warn "未找到 codex CLI（codex 座位将无法启动）。安装登录后重试；只做 kimi 座位可用 --vendor kimi 跳过本检查"
      CLI_MISSING=1
    fi
    # chatgpt.com 连通性检测：国内 DNS 污染是 codex 座位的第一大坑，提前显性化
    if [[ "$DRY_RUN" != "1" ]]; then
      if ! curl -s -m 5 -o /dev/null https://chatgpt.com 2>/dev/null; then
        warn "无法直连 chatgpt.com——大陆网络需代理，启动 runner 前先设置："
        warn "  export http_proxy=http://127.0.0.1:10809 https_proxy=http://127.0.0.1:10809"
        warn "  （端口换成你自己的代理；runner 继承父进程环境变量）"
      fi
    fi
  fi
  if [[ "$CLI_MISSING" == "1" && "$VENDOR" == "both" ]]; then
    command -v kimi >/dev/null 2>&1 || command -v codex >/dev/null 2>&1 || \
      fail "kimi 与 codex CLI 都未找到——至少安装并登录其中一个（详见 docs/integrations/ 下对应指南）"
  fi
}

# =============================================================================
# repo 模式：build-from-source（现状行为，逐行保留）
# =============================================================================
if [[ "$MODE" == "repo" ]]; then

# ---------- 1. 校验 chamber 仓库 ----------
info "仓库目录: $REPO_DIR"
cd "$REPO_DIR"

# ---------- 2. node / pnpm 依赖检查 ----------
# runner 必须跑在宿主机（驱动本机 CLI 的登录态），docker 部署的主机可能没装 node/pnpm，
# 缺失时给出安装指引后退出，而不是让用户面对报错栈
MISSING_TOOLCHAIN=0
command -v node >/dev/null 2>&1 || { MISSING_TOOLCHAIN=1; warn "未找到 node"; }
command -v pnpm >/dev/null 2>&1 || { MISSING_TOOLCHAIN=1; warn "未找到 pnpm"; }
if [[ "$MISSING_TOOLCHAIN" == "1" ]]; then
  cat >&2 <<'EOF'

[install-runner] runner 需要宿主机安装 node（>=18）与 pnpm：
  - node: https://nodejs.org/ （或 nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash）
  - pnpm: corepack enable && corepack prepare pnpm@latest --activate（或 npm i -g pnpm）
为什么不能用 docker 里的 node？runner 要驱动你本机已登录的 kimi/codex CLI（含登录态），
必须在宿主机直接运行。
EOF
  exit 1
fi

# ---------- 3. CLI 预检（按 vendor 范围） ----------
preflight_clis

# ---------- 4. 安装依赖 + 构建 ----------
if [[ ! -d node_modules ]]; then
  info "安装依赖（pnpm install --frozen-lockfile）..."
  run pnpm install --frozen-lockfile
fi
info "构建 roundtable-protocol / roundtable-runner..."
run pnpm --filter @agent-chamber/roundtable-protocol build
run pnpm --filter @agent-chamber/roundtable-runner build

# ---------- 5. 生成 start-runner.sh ----------
START_SCRIPT="$REPO_DIR/start-runner.sh"
info "生成启动脚本: $START_SCRIPT"
if [[ "$DRY_RUN" == "1" ]]; then
  echo -e "${YELLOW}[dry-run]${NC} write $START_SCRIPT (platform-url=$PLATFORM_URL runner-name=$RUNNER_NAME state-dir=$STATE_DIR)"
else
  mkdir -p "$STATE_DIR"
  cat > "$START_SCRIPT" <<EOF
#!/usr/bin/env bash
# start-runner.sh — 由 install-runner.sh 生成（$(date +%Y-%m-%d)）
# 修改 API_KEY 等参数后直接重跑本文件即可。

# codex 座位（国内网络）：先取消下面两行的注释并改成你的代理端口
# export http_proxy=http://127.0.0.1:10809
# export https_proxy=http://127.0.0.1:10809

exec node "$REPO_DIR/packages/roundtable-runner/dist/cli.js" \\
  --platform-url "$PLATFORM_URL" \\
  --api-key "${API_KEY:-<在此填入你的 agent API Key>}" \\
  --runner-name "$RUNNER_NAME" \\
  --state-dir "$STATE_DIR"
EOF
  chmod +x "$START_SCRIPT"
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  runner 安装完成（repo 模式）${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
info "下一步："
info "  1. 创建 agent 拿 API Key、创建圆桌话题与座位（座位要绑定该 agent）"
info "     指南: docs/integrations/kimi.md · docs/integrations/codex.md"
info "  2. $([ -z "$API_KEY" ] && echo "把 API Key 填入 $START_SCRIPT 后，" || echo "")运行: $START_SCRIPT"
info "提示：多个 runner 必须各自独立 --state-dir（默认已按 runner-name 派生，无需手动指定）"

# =============================================================================
# standalone 模式：平台分发 bundle（R2 自检 fallback / --start / --install-dir）
# =============================================================================
else

info "未检测到仓库（packages/roundtable-runner 不存在），使用 standalone 模式：从平台下载自包含 bundle"

# ---------- 1. 必填校验 ----------
if [[ "$PLATFORM_URL_SET" != "1" ]]; then
  fail "standalone 模式必须指定 --platform-url <平台地址>（如 https://platform.example.com）"
fi
# URL 归一化：去掉尾部斜杠，避免拼出 //api/v1
PLATFORM_URL="${PLATFORM_URL%/}"

# ---------- 2. 工具链检查（仅需 node；bundle 已 vendor prod 依赖，无需 pnpm/git） ----------
command -v node >/dev/null 2>&1 || fail "未找到 node——standalone 安装需要 node（>=18）：https://nodejs.org/"
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
# 注意：=~ 右侧不加引号（引号 = 字面量匹配历史坑）；非数字则跳过版本判断
if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR < 18 )); then
  warn "node 版本 $(node -v) 过旧（runner 要求 >=18），建议升级后重试"
fi
command -v curl >/dev/null 2>&1 || fail "未找到 curl——standalone 安装需要 curl 下载 bundle"

# ---------- 3. CLI 预检（按 vendor 范围） ----------
preflight_clis

# ---------- 4. 下载 bundle ----------
TMP_TGZ="$(mktemp "${TMPDIR:-/tmp}/roundtable-runner.XXXXXX.tar.gz")"
# 下载失败残留临时文件（trap 兜底）
trap 'rm -f "$TMP_TGZ"' EXIT
DOWNLOAD_URL="$PLATFORM_URL/api/v1/downloads/roundtable-runner.tar.gz"
info "下载 bundle: $DOWNLOAD_URL"
# curl -fsSL：失败（404/网络）即非零退出，由 set -e 中断脚本
run curl -fsSL "$DOWNLOAD_URL" -o "$TMP_TGZ"

# ---------- 5. 解压到 install-dir ----------
info "解压到: $INSTALL_DIR"
run mkdir -p "$INSTALL_DIR"
run tar xzf "$TMP_TGZ" -C "$INSTALL_DIR"

# ---------- 6. 自检 + npm fallback（R2） ----------
# vendored node_modules 跨平台可能不兼容（如 mac arm64 vs linux x64 的二进制依赖）：
# 自检失败自动用 npm install --omit=dev 重建依赖——npm 随 node 分发，用户无需装 pnpm
if [[ "$DRY_RUN" != "1" ]]; then
  if ! node "$INSTALL_DIR/dist/cli.js" --help >/dev/null 2>&1; then
    warn "自检失败（node $INSTALL_DIR/dist/cli.js --help），尝试用 npm 重建依赖..."
    warn "  网络受限时可先配置 registry 镜像，例如："
    warn "  npm config set registry https://registry.npmmirror.com"
    (cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund)
    if ! node "$INSTALL_DIR/dist/cli.js" --help >/dev/null 2>&1; then
      fail "重建依赖后自检仍失败——请检查 node 版本（>=18）后重跑，或到仓库模式手动安装"
    fi
    info "npm 重建依赖完成，自检通过"
  fi
  info "自检通过: node $INSTALL_DIR/dist/cli.js --help"
fi

# ---------- 7. 生成 start-runner.sh ----------
START_SCRIPT="$INSTALL_DIR/start-runner.sh"
info "生成启动脚本: $START_SCRIPT"
if [[ "$DRY_RUN" == "1" ]]; then
  echo -e "${YELLOW}[dry-run]${NC} write $START_SCRIPT (platform-url=$PLATFORM_URL runner-name=$RUNNER_NAME state-dir=$STATE_DIR)"
else
  mkdir -p "$STATE_DIR"
  cat > "$START_SCRIPT" <<EOF
#!/usr/bin/env bash
# start-runner.sh — 由 install-runner.sh 生成（$(date +%Y-%m-%d)）
# 修改 API_KEY 等参数后直接重跑本文件即可。

# codex 座位（国内网络）：先取消下面两行的注释并改成你的代理端口
# export http_proxy=http://127.0.0.1:10809
# export https_proxy=http://127.0.0.1:10809

exec node "$INSTALL_DIR/dist/cli.js" \\
  --platform-url "$PLATFORM_URL" \\
  --api-key "${API_KEY:-<在此填入你的 agent API Key>}" \\
  --runner-name "$RUNNER_NAME" \\
  --state-dir "$STATE_DIR"
EOF
  chmod +x "$START_SCRIPT"
fi

# ---------- 8. --start：立即后台启动（setsid 脱组） ----------
# 历史坑：`cmd && cmd &` 链会让后台进程挂在当前 shell 的进程组下，
# 终端关闭时被 SIGHUP 连带杀死；setsid 新建会话彻底脱组。
# macOS 无 setsid → 退化为 nohup（同样屏蔽 SIGHUP）。
if [[ "$START" == "1" ]]; then
  LOG_FILE="$INSTALL_DIR/runner.log"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo -e "${YELLOW}[dry-run]${NC} start: node $INSTALL_DIR/dist/cli.js (log: $LOG_FILE)"
  else
    if command -v setsid >/dev/null 2>&1; then
      setsid node "$INSTALL_DIR/dist/cli.js" \
        --platform-url "$PLATFORM_URL" \
        --api-key "$API_KEY" \
        --runner-name "$RUNNER_NAME" \
        --state-dir "$STATE_DIR" >>"$LOG_FILE" 2>&1 &
    else
      nohup node "$INSTALL_DIR/dist/cli.js" \
        --platform-url "$PLATFORM_URL" \
        --api-key "$API_KEY" \
        --runner-name "$RUNNER_NAME" \
        --state-dir "$STATE_DIR" >>"$LOG_FILE" 2>&1 &
    fi
    info "runner 已后台启动（PID $!），日志: $LOG_FILE"
  fi
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  runner 安装完成（standalone 模式）${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
info "下一步："
info "  1. 创建 agent 拿 API Key、创建圆桌话题与座位（座位要绑定该 agent）"
info "     指南: $PLATFORM_URL/api/v1/downloads/integrations/kimi.md · codex.md"
info "  2. $([ -z "$API_KEY" ] && echo "把 API Key 填入 $START_SCRIPT 后，" || echo "")运行: $START_SCRIPT"
info "提示：多个 runner 必须各自独立 --state-dir（默认已按 runner-name 派生，无需手动指定）"
info "提示：升级 runner 时重跑本脚本即可（--install-dir 保持一致）"

fi
