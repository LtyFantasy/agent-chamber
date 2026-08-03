#!/usr/bin/env bash
# =============================================================================
# setup.sh — Agent Chamber 一键部署脚本
#
# 面向首次部署的用户：git clone 后直接执行 ./scripts/setup.sh 即可完成：
#   1. 检查 Docker / Docker Compose
#   2. 生成 .env（随机 JWT 密钥 + admin 初始账号）
#   3. docker compose up -d --build（postgres + backend + web + mcp）
#   4. 等待 backend 健康检查通过（ migrations 与首个 admin 由 backend 启动时自动完成）
#   5. 打印访问入口与 admin 凭据
#
# 非交互用法（CI / 自动化）：
#   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=your-password ./scripts/setup.sh
#
# 重复执行是安全的：.env 已存在则沿用，admin 仅在系统无管理员时创建。
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
fail() { echo -e "${RED}[setup] ERROR:${NC} $*" >&2; exit 1; }

# ---------- 1. 依赖检查 ----------
command -v docker >/dev/null 2>&1 || fail "未找到 docker，请先安装 Docker"
docker compose version >/dev/null 2>&1 || fail "未找到 docker compose（v2），请升级 Docker"

# ---------- 2. .env 生成 ----------
rand_hex() { openssl rand -hex 32 2>/dev/null || od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

# sed 替换值转义（& # \ 为 delimiter/特殊字符）
sed_esc() { printf '%s' "$1" | sed -e 's/[&#\\]/\\&/g'; }

set_env() { # set_env KEY VALUE —— 有则替换，无则追加
  local key="$1" val
  val="$(sed_esc "$2")"
  if grep -q "^${key}=" .env; then
    sed -i "s#^${key}=.*#${key}=${val}#" .env
  else
    echo "${key}=$2" >> .env
  fi
}

if [[ ! -f .env ]]; then
  cp .env.example .env
  info "已生成 .env（来自 .env.example）"
fi

# JWT 密钥：占位值一律替换为随机值
if grep -q '^JWT_SECRET=change-me' .env; then
  set_env JWT_SECRET "$(rand_hex)"
  info "已生成随机 JWT_SECRET"
fi
if grep -q '^JWT_REFRESH_SECRET=change-me' .env; then
  set_env JWT_REFRESH_SECRET "$(rand_hex)"
  info "已生成随机 JWT_REFRESH_SECRET"
fi

# ---------- 3. admin 初始账号 ----------
# 优先级：shell 环境变量 > .env 中已被用户修改的值 > 交互询问/自动生成
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
GENERATED_PASSWORD=""

if [[ -z "$ADMIN_EMAIL" ]]; then
  if grep -q '^ADMIN_EMAIL=' .env && ! grep -q '^ADMIN_EMAIL=admin@example.com' .env; then
    ADMIN_EMAIL="$(grep '^ADMIN_EMAIL=' .env | head -n1 | cut -d= -f2-)"
  elif [[ -t 0 ]]; then
    read -rp "[setup] admin 邮箱 [admin@example.com]: " ADMIN_EMAIL
    ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
  else
    ADMIN_EMAIL="admin@example.com"
  fi
fi

if [[ -z "$ADMIN_PASSWORD" ]]; then
  if grep -q '^ADMIN_PASSWORD=' .env && ! grep -q '^ADMIN_PASSWORD=change-me' .env; then
    ADMIN_PASSWORD="$(grep '^ADMIN_PASSWORD=' .env | head -n1 | cut -d= -f2-)"
  elif [[ -t 0 ]]; then
    read -rsp "[setup] admin 密码（留空则自动生成）: " ADMIN_PASSWORD
    echo ""
  fi
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$(openssl rand -base64 12 2>/dev/null | tr -d '=+/' | cut -c1-16 || od -An -N12 -tx1 /dev/urandom | tr -d ' \n' | cut -c1-16)"
    GENERATED_PASSWORD="$ADMIN_PASSWORD"
  fi
fi

set_env ADMIN_EMAIL "$ADMIN_EMAIL"
set_env ADMIN_PASSWORD "$ADMIN_PASSWORD"

# ---------- 4. 构建并启动 ----------
info "开始构建并启动容器（首次构建需要几分钟）..."
docker compose up -d --build

# ---------- 5. 等待 backend 就绪 ----------
info "等待 backend 健康检查（migrations 与 admin 初始化在此期间自动完成）..."
HEALTH_URL="http://localhost:8743/api/v1/health"
for i in $(seq 1 100); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 100 ]]; then
    fail "backend 300 秒内未就绪，请执行 'docker compose logs backend' 排查"
  fi
  sleep 3
done

# ---------- 6. 完成 ----------
echo ""
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Agent Chamber 部署完成${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "  Web UI      : ${YELLOW}http://localhost:8742${NC}"
echo -e "  Backend API : ${YELLOW}http://localhost:8743/api/v1${NC}"
echo -e "  MCP 端点    : ${YELLOW}http://localhost:8745/mcp${NC}"
echo ""
echo -e "  admin 邮箱  : ${YELLOW}${ADMIN_EMAIL}${NC}"
if [[ -n "$GENERATED_PASSWORD" ]]; then
  echo -e "  admin 密码  : ${YELLOW}${GENERATED_PASSWORD}${NC}（自动生成，请登录后尽快修改）"
else
  echo -e "  admin 密码  : （使用你设定的密码）"
fi
echo ""
echo -e "  停止服务    : docker compose down"
echo -e "  查看日志    : docker compose logs -f backend"
