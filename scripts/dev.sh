#!/bin/bash
set -e

# Agent Chamber 协作平台 — 一键开发启动脚本
# 用法: ./scripts/dev.sh [all|frontend|backend|stop]
# 默认: all

MODE="${1:-all}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

WEB_PORT=8742
BACKEND_PORT=8743

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err()  { echo -e "${RED}[ERROR]${NC} $1"; }

# 按 PID 文件优雅停止进程；PID 已失效时幂等清理，不阻断 stop 流程。
stop_service() {
  local pidfile=$1
  local pname=$2
  local pid
  local group_id
  local signal_target
  local waited=0

  if [ ! -f "$pidfile" ]; then
    log_info "$pname PID 文件不存在，跳过"
    return 0
  fi

  pid=$(tr -d '[:space:]' < "$pidfile")
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    log_warn "$pname PID 文件无效，清理: $pidfile"
    rm -f "$pidfile"
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    log_info "$pname 进程已退出，清理 PID 文件 (PID $pid)"
    rm -f "$pidfile"
    return 0
  fi

  group_id=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  signal_target="$pid"
  if [[ "$group_id" =~ ^[0-9]+$ ]] && [ "$group_id" = "$pid" ] && [ "$group_id" -ne "$$" ]; then
    signal_target="-$group_id"
    log_info "$pname: 使用独立进程组 $group_id"
  fi

  log_info "$pname: 发送 TERM (PID $pid)..."
  kill -TERM -- "$signal_target" 2>/dev/null || true
  while kill -0 -- "$signal_target" 2>/dev/null; do
    if [ "$waited" -ge 10 ]; then
      log_warn "$pname: 10s 内未退出，发送 KILL (PID $pid)..."
      kill -KILL -- "$signal_target" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  rm -f "$pidfile"
  if kill -0 -- "$signal_target" 2>/dev/null; then
    log_warn "$pname PID $pid 仍被系统回收中，已清理 PID 文件"
  else
    log_ok "$pname 已停止"
  fi
}

# 根据端口 kill 进程
kill_port() {
  local port=$1
  local pname=$2
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null || ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
  if [ -n "$pids" ]; then
    log_warn "发现 $pname 占用端口 $port，正在终止: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
    log_ok "$pname 已终止"
  else
    log_info "$pname 端口 $port 未占用"
  fi
}

# 等待端口就绪
wait_port() {
  local port=$1
  local pname=$2
  local max_wait=${3:-30}
  local waited=0
  while ! ss -tln 2>/dev/null | grep -q ":$port "; do
    if [ "$waited" -ge "$max_wait" ]; then
      log_err "$pname 启动超时 (${max_wait}s)，请检查日志"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  log_ok "$pname 已就绪 (端口 $port)"
}

# 清空编译缓存
clean_cache() {
  log_info "清空编译缓存..."

  if [ "$MODE" = "all" ] || [ "$MODE" = "frontend" ]; then
    if [ -d "$PROJECT_ROOT/apps/web/.next" ]; then
      rm -rf "$PROJECT_ROOT/apps/web/.next"
      log_ok "前端 .next 缓存已清除"
    fi
  fi

  if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ]; then
    if [ -d "$PROJECT_ROOT/apps/backend/dist" ]; then
      rm -rf "$PROJECT_ROOT/apps/backend/dist"
      log_ok "后端 dist 缓存已清除"
    fi
  fi

  # 清理通用的 node_modules/.cache（可选，如需深度清理可打开）
  # rm -rf "$PROJECT_ROOT/node_modules/.cache" 2>/dev/null || true
}

# 检查 Docker 数据库
check_db() {
  if ! docker ps --format '{{.Names}}' | grep -q "chamber-postgres"; then
    log_warn "Docker PostgreSQL 容器未运行，尝试启动..."
    cd "$PROJECT_ROOT"
    docker-compose up -d 2>/dev/null || docker compose up -d 2>/dev/null || {
      log_err "无法启动数据库，请手动执行: docker-compose up -d"
      exit 1
    }
    sleep 3
  fi
  log_ok "PostgreSQL 数据库运行中"
}

# 编译 shared 包
build_shared() {
  log_info "编译 shared 包..."
  cd "$PROJECT_ROOT"
  pnpm --filter @agent-chamber/shared build 2>&1 | tail -5
  log_ok "shared 包编译完成"
}

# 启动后端
start_backend() {
  log_info "启动后端 (NestJS) → http://localhost:$BACKEND_PORT"
  log_info "API 文档 → http://localhost:$BACKEND_PORT/api/docs"
  cd "$PROJECT_ROOT"
  setsid nohup pnpm --filter @agent-chamber/backend dev > "$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$LOG_DIR/backend.pid"
  wait_port "$BACKEND_PORT" "后端" 60
}

# 启动前端
start_frontend() {
  log_info "启动前端 (Next.js) → http://localhost:$WEB_PORT"
  cd "$PROJECT_ROOT"
  # 本地开发时前端直接连后端，不走 nginx 代理
  export NEXT_PUBLIC_API_URL="http://localhost:$BACKEND_PORT/api/v1"
  setsid nohup pnpm --filter @agent-chamber/web dev > "$LOG_DIR/frontend.log" 2>&1 &
  echo $! > "$LOG_DIR/frontend.pid"
  wait_port "$WEB_PORT" "前端" 60
}

# 打印访问信息
print_access() {
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  🚀 Agent Chamber 平台已启动${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
  if [ "$MODE" = "all" ] || [ "$MODE" = "frontend" ]; then
    echo -e "  🌐 前端: ${YELLOW}http://localhost:$WEB_PORT${NC}"
  fi
  if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ]; then
    echo -e "  🔧 后端: ${YELLOW}http://localhost:$BACKEND_PORT${NC}"
    echo -e "  📖 文档: ${YELLOW}http://localhost:$BACKEND_PORT/api/docs${NC}"
  fi
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  日志文件:"
  [ "$MODE" != "frontend" ] && echo -e "    后端: $LOG_DIR/backend.log"
  [ "$MODE" != "backend" ] && echo -e "    前端: $LOG_DIR/frontend.log"
  echo ""
  echo -e "  停止命令:"
  if [ "$MODE" = "all" ]; then
    echo -e "    ${YELLOW}./scripts/stop.sh${NC}  或  ${YELLOW}kill $(cat "$LOG_DIR/backend.pid" 2>/dev/null) $(cat "$LOG_DIR/frontend.pid" 2>/dev/null)${NC}"
  elif [ "$MODE" = "backend" ]; then
    echo -e "    ${YELLOW}kill $(cat "$LOG_DIR/backend.pid" 2>/dev/null)${NC}"
  else
    echo -e "    ${YELLOW}kill $(cat "$LOG_DIR/frontend.pid" 2>/dev/null)${NC}"
  fi
  echo ""
}

# stop 模式只执行 PID 文件清理，不触发启动、编译或数据库流程。
if [ "$MODE" = "stop" ]; then
  log_info "停止开发服务..."
  stop_service "$LOG_DIR/backend.pid" "后端"
  stop_service "$LOG_DIR/frontend.pid" "前端"
  log_ok "开发服务停止流程完成"
  exit 0
fi

# ============ 主流程 ============

echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Agent Chamber 协作平台 — 开发启动脚本${NC}"
echo -e "${BLUE}  模式: ${YELLOW}$MODE${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo ""

# 1. Kill 现有进程
if [ "$MODE" = "all" ] || [ "$MODE" = "frontend" ]; then
  kill_port "$WEB_PORT" "前端"
fi
if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ]; then
  kill_port "$BACKEND_PORT" "后端"
fi

# 2. 清空缓存
clean_cache

# 3. 检查数据库（仅后端模式或全部模式）
if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ]; then
  check_db
fi

# 4. 编译 shared
if [ "$MODE" = "all" ]; then
  build_shared
fi

# 5. 启动服务
if [ "$MODE" = "all" ]; then
  start_backend
  start_frontend
elif [ "$MODE" = "backend" ]; then
  start_backend
elif [ "$MODE" = "frontend" ]; then
  start_frontend
else
  log_err "未知模式: $MODE"
  echo "用法: $0 [all|frontend|backend|stop]"
  exit 1
fi

# 6. 打印信息
print_access
