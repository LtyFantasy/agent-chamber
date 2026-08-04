#!/usr/bin/env bash
# =============================================================================
# install.sh — Agent Chamber 一键安装 / 更新脚本
#
# 用法（一键）:
#   curl -fsSL https://raw.githubusercontent.com/LtyFantasy/agent-chamber/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/LtyFantasy/agent-chamber/main/install.sh | bash -s -- -d ~/my-chamber
#
# 行为:
#   - 目标目录无 git 仓库 → 全新安装：拉取最新正式 Release tag，clone 后执行 scripts/setup.sh
#   - 目标目录已有安装   → 更新：比较本地 tag 与最新正式 Release，备份数据库后
#                         checkout 新 tag 并重建容器（migrations 由 backend 启动时自动执行）
#
# 版本策略：只追踪正式 Release（vX.Y.Z，无后缀）。GitHub releases/latest API
#           天然跳过 prerelease，开发版（-dev）永远不会被安装/更新到。
#
# 前置要求：git、curl、docker、docker compose v2
#
# 非 git 安装（如下载 zip 解压）不支持 update，请用本脚本或 git clone 安装。
# =============================================================================
set -euo pipefail

# ---------- 默认值（均可被同名环境变量覆盖） ----------
INSTALL_DIR="${INSTALL_DIR:-$HOME/agent-chamber}"   # 安装目录
TARGET_TAG="${TARGET_TAG:-}"                        # 指定版本（默认最新正式 Release）
REPO_URL="${REPO_URL:-https://github.com/LtyFantasy/agent-chamber.git}"  # clone 地址（可切 SSH/镜像）
GH_PROXY="${GH_PROXY:-}"                            # GitHub 访问代理前缀（如 https://mirror.ghproxy.com/），作用于 API/raw/clone
DRY_RUN="${DRY_RUN:-0}"                             # 1 = 只打印动作不执行

# GitHub API 地址（经 GH_PROXY 前缀，便于网络受限环境走镜像）
GH_API="${GH_PROXY}https://api.github.com/repos/LtyFantasy/agent-chamber/releases/latest"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[install]${NC} $*"; }
warn() { echo -e "${YELLOW}[install]${NC} $*"; }
fail() { echo -e "${RED}[install] ERROR:${NC} $*" >&2; exit 1; }

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
Usage: install.sh [OPTIONS]

Install or update Agent Chamber (stable releases only).

Options:
  -d, --dir <path>    Installation directory (default: $HOME/agent-chamber)
      --tag <tag>     Install/update to a specific release tag (default: latest stable)
      --dry-run       Print actions without executing anything
  -h, --help          Show this help message and exit

Environment variables:
  INSTALL_DIR         Same as --dir
  TARGET_TAG          Same as --tag
  REPO_URL            Git remote URL (default: https://github.com/LtyFantasy/agent-chamber.git)
  GH_PROXY            URL prefix for GitHub API/raw/clone access (e.g. a mirror), default empty
  DRY_RUN             Set to 1 to enable dry-run mode

Examples:
  # 全新安装到默认目录
  curl -fsSL https://raw.githubusercontent.com/LtyFantasy/agent-chamber/main/install.sh | bash
  # 更新已有安装到最新正式版
  curl -fsSL https://raw.githubusercontent.com/LtyFantasy/agent-chamber/main/install.sh | bash
  # 安装/更新到指定版本
  ./install.sh --tag v1.40.0
EOF
}

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)
      [[ $# -ge 2 ]] || fail "$1 需要一个参数"
      INSTALL_DIR="$2"; shift 2 ;;
    --tag)
      [[ $# -ge 2 ]] || fail "$1 需要一个参数"
      TARGET_TAG="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      fail "未知参数: $1（-h 查看用法）" ;;
  esac
done

# ---------- 1. 依赖检查 ----------
# install.sh 自身全流程依赖；docker compose 仅 update/启动阶段需要，提前一并检查
for cmd in git curl docker; do
  command -v "$cmd" >/dev/null 2>&1 || fail "未找到 $cmd，请先安装"
done
docker compose version >/dev/null 2>&1 || fail "未找到 docker compose（v2），请升级 Docker"

# ---------- 2. 解析目标版本 ----------
# latest_stable_tag —— 从 GitHub releases/latest API 取最新正式版 tag。
# API 只返回非 prerelease 的 Release，开发版（-dev）天然被过滤。
# 无正式版时 API 返回 404 → 优雅报错（脚本随首个正式版发布后可用）。
latest_stable_tag() {
  local resp
  resp="$(curl -fsSL "$GH_API")" || fail "获取最新正式版失败：当前可能尚无正式 Release（HTTP 错误）。请稍后重试或到 GitHub 仓库页面确认。"
  # 不依赖 jq：tag_name 是响应顶层固定字段，grep/sed 提取
  local tag
  tag="$(printf '%s' "$resp" | grep -m1 '"tag_name"' | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  [[ -n "$tag" ]] || fail "解析 releases/latest 响应失败（未找到 tag_name）"
  printf '%s' "$tag"
}

# strip_v —— 去掉版本号 v 前缀，供 sort -V 做语义化比较
strip_v() { printf '%s' "${1#v}"; }

if [[ -z "$TARGET_TAG" ]]; then
  info "查询最新正式 Release..."
  TARGET_TAG="$(latest_stable_tag)"
fi
info "目标版本: $TARGET_TAG"

# ---------- 3. 模式判断：fresh install or update ----------
if [[ -d "$INSTALL_DIR/.git" ]] && git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null | grep -q 'agent-chamber'; then
  MODE="update"
else
  MODE="fresh"
fi
info "安装目录: $INSTALL_DIR（模式: $MODE）"

# =============================================================================
# Fresh Install：clone 指定 tag（浅克隆）→ 执行 setup.sh
# =============================================================================
if [[ "$MODE" == "fresh" ]]; then
  if [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
    fail "目录 $INSTALL_DIR 已存在且非 chamber 安装（非空、无匹配的 git remote）。请换目录（-d）或手动处理。"
  fi
  info "开始全新安装 $TARGET_TAG ..."
  run git clone --depth 1 --branch "$TARGET_TAG" "$REPO_URL" "$INSTALL_DIR"
  info "执行 setup.sh（生成 .env、构建并启动容器、等待健康检查）..."
  if [[ "$DRY_RUN" == "1" ]]; then
    echo -e "${YELLOW}[dry-run]${NC} (cd $INSTALL_DIR && ./scripts/setup.sh)"
  else
    (cd "$INSTALL_DIR" && ./scripts/setup.sh)
  fi
  info "安装完成: $TARGET_TAG @ $INSTALL_DIR"
  exit 0
fi

# =============================================================================
# Update：版本比较 → 备份 DB → checkout 新 tag → 重建 → 验证 → 回滚指引
# =============================================================================
cd "$INSTALL_DIR"

# 3.1 当前版本：最近可达 tag（安装即为 tag checkout，describe 结果即安装版本）
CURRENT_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
[[ -n "$CURRENT_TAG" ]] || fail "无法识别当前版本（无 git tag）。该目录可能不是通过 install.sh/git tag 方式安装的，不支持自动更新。"
info "当前版本: $CURRENT_TAG → 目标版本: $TARGET_TAG"

# 3.2 版本比较（strip v 前缀后 sort -V）
if [[ "$CURRENT_TAG" == "$TARGET_TAG" ]]; then
  info "已是最新正式版 ($CURRENT_TAG)，无需更新。"
  exit 0
fi
OLDEST="$(printf '%s\n%s\n' "$(strip_v "$CURRENT_TAG")" "$(strip_v "$TARGET_TAG")" | sort -V | head -n1)"
if [[ "$OLDEST" == "$(strip_v "$TARGET_TAG")" ]]; then
  fail "当前版本 ($CURRENT_TAG) 比目标版本 ($TARGET_TAG) 还新，拒绝降级。如需降级请手动操作。"
fi

# 3.3 工作区脏检查（tracked 文件有改动则中止；.env 为 gitignored 不受影响）
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "工作区有未提交的 tracked 文件改动，为避免丢失请手动处理后重试：\n$(git status --short --untracked-files=no)"
fi

# 3.4 数据库备份（生产 DB 安全第一：升级前必须 pg_dump）
#     postgres 未运行时先单独拉起等 healthy，否则 exec 直接失败
info "升级前备份数据库..."
DB_USER="$(grep '^DB_USERNAME=' .env 2>/dev/null | head -n1 | cut -d= -f2- || true)"; DB_USER="${DB_USER:-chamber}"
DB_NAME="$(grep '^DB_DATABASE=' .env 2>/dev/null | head -n1 | cut -d= -f2- || true)"; DB_NAME="${DB_NAME:-agent_chamber}"
if ! docker compose ps --status running postgres 2>/dev/null | grep -q postgres; then
  warn "postgres 容器未运行，先单独启动..."
  run docker compose up -d postgres
  # dry-run 不真正等待；真实执行时最多等 90s 等 postgres 就绪
  if [[ "$DRY_RUN" != "1" ]]; then
    for i in $(seq 1 30); do
      docker compose exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break
      [[ "$i" -eq 30 ]] && fail "postgres 90 秒内未就绪，无法备份"
      sleep 3
    done
  fi
fi
mkdir -p backups
BACKUP_FILE="backups/agent_chamber_pre_${TARGET_TAG}_$(date +%Y%m%d_%H%M%S).sql.gz"
MIGRATIONS_BEFORE="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT count(*) FROM migrations' 2>/dev/null || echo '?')"
if [[ "$DRY_RUN" == "1" ]]; then
  echo -e "${YELLOW}[dry-run]${NC} docker compose exec -T postgres pg_dump -U $DB_USER $DB_NAME | gzip > $BACKUP_FILE"
else
  docker compose exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"
  info "备份完成: $BACKUP_FILE（migrations 条数: $MIGRATIONS_BEFORE）"
fi

# 3.5 拉取并切换到目标 tag（浅克隆下必须显式 fetch tag）
run git fetch --depth 1 origin tag "$TARGET_TAG"
run git checkout "$TARGET_TAG"

# 3.6 .env 漂移检查：新版 .env.example 新增的 key 若 .env 缺失则警告（不自动改用户配置）
NEW_KEYS="$(comm -13 <(grep -oE '^[A-Z_]+=' .env 2>/dev/null | sort -u) <(grep -oE '^[A-Z_]+=' .env.example 2>/dev/null | sort -u) || true)"
if [[ -n "$NEW_KEYS" ]]; then
  warn "新版本引入了 .env 中缺失的配置键，请按需补充到 .env："
  printf '%s\n' "$NEW_KEYS" | sed 's/^/  - /'
fi

# 3.7 重建并重启（migrations 由 backend 启动时自动执行，失败自动 crash 重启最多 5 次）
info "重建并重启容器（数据库 migrations 将自动执行）..."
run docker compose up -d --build

# 3.8 健康等待（端口从 .env 读，默认 8743）
PORT="$(grep '^PORT=' .env 2>/dev/null | head -n1 | cut -d= -f2- || true)"; PORT="${PORT:-8743}"
HEALTH_URL="http://localhost:${PORT}/api/v1/health"
info "等待 backend 健康检查: $HEALTH_URL"
HEALTHY=0
if [[ "$DRY_RUN" == "1" ]]; then
  HEALTHY=1
else
  for i in $(seq 1 100); do
    curl -sf "$HEALTH_URL" >/dev/null 2>&1 && { HEALTHY=1; break; }
    sleep 3
  done
fi

# 3.9 migration 验证：对比升级前后 migrations 条数并打印最新一条
if [[ "$DRY_RUN" != "1" ]]; then
  MIGRATIONS_AFTER="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT count(*) FROM migrations' 2>/dev/null || echo '?')"
  LATEST_MIGRATION="$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1' 2>/dev/null || echo '?')"
fi

if [[ "$HEALTHY" == "1" ]]; then
  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  更新完成: $CURRENT_TAG → $TARGET_TAG${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  info "migrations: $MIGRATIONS_BEFORE → ${MIGRATIONS_AFTER:-?}（最新: ${LATEST_MIGRATION:-?}）"
  info "数据库备份: $BACKUP_FILE（确认无问题后可自行清理）"
else
  # 健康检查失败：打印完整回滚指引（含浅克隆 fetch 前置 + 备份恢复命令）
  echo ""
  echo -e "${RED}[install] 更新后健康检查未通过！回滚步骤：${NC}"
  echo -e "  1. cd $INSTALL_DIR"
  echo -e "  2. git fetch --depth 1 origin tag $CURRENT_TAG && git checkout $CURRENT_TAG"
  echo -e "  3. docker compose up -d --build"
  echo -e "  4. 如需恢复数据库（新 schema 与旧代码不兼容时）："
  echo -e "     gunzip -c $BACKUP_FILE | docker compose exec -T postgres psql -U $DB_USER $DB_NAME"
  echo -e "  排查: docker compose logs backend"
  exit 1
fi
