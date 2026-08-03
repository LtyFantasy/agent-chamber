#!/bin/bash

# AI Agent Chamber 协作平台 — 一键停止脚本

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs"

WEB_PORT=8742
BACKEND_PORT=8743

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# 通过 PID 文件优雅终止进程
kill_by_pidfile() {
  local pidfile=$1
  local pname=$2
  if [ -f "$pidfile" ]; then
    PID=$(cat "$pidfile")
    if kill -0 "$PID" 2>/dev/null; then
      log_info "$pname: 发送 TERM (PID $PID)..."
      kill -TERM "$PID" 2>/dev/null || true
      sleep 2
      if kill -0 "$PID" 2>/dev/null; then
        log_warn "$pname: 未响应，发送 KILL..."
        kill -KILL "$PID" 2>/dev/null || true
      else
        log_ok "$pname 已停止"
      fi
    fi
    rm -f "$pidfile"
  fi
}

# 进程归属校验：仅当进程属于本项目（工作目录在 PROJECT_ROOT 内，
# 或 cmdline 中含 PROJECT_ROOT 路径）才允许杀。
# 防误杀本机其他项目：8742/8743 端口或 next-server 进程名都可能被别的项目占用
# （如 agent-core dev web、其他 docker 栈），无归属校验的强杀会误伤。
pid_belongs_to_project() {
  local pid=$1
  local cwd cmdline
  # /proc/<pid>/cwd 是进程真实工作目录的 symlink，最可靠
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  if [ -n "$cwd" ]; then
    case "$cwd" in
      "$PROJECT_ROOT" | "$PROJECT_ROOT"/*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  # cwd 读不到（权限不足或非 Linux），退回 cmdline 路径判断
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  case "$cmdline" in
    *"$PROJECT_ROOT"*) return 0 ;;
    *) return 1 ;;
  esac
}

# 按端口强制清理（兜底，仅限属于本项目的进程）
kill_by_port() {
  local port=$1
  local pname=$2
  local pids pid killed=0
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  for pid in $pids; do
    if pid_belongs_to_project "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
      killed=1
    else
      log_warn "$pname (端口 $port) 的 PID $pid 不属于本项目，跳过（请人工确认是哪个进程占用）"
    fi
  done
  if [ "$killed" = 1 ]; then
    log_ok "$pname (端口 $port) 已清理"
  fi
}

# ─── 停止后端 ───
kill_by_pidfile "$LOG_DIR/backend.pid" "后端"
kill_by_port "$BACKEND_PORT" "后端"

# ─── 停止前端 ───
kill_by_pidfile "$LOG_DIR/frontend.pid" "前端"
kill_by_port "$WEB_PORT" "前端"

# 额外兜底：清理本项目的 next-server 孤儿进程（按归属校验收窄，不误杀其他项目的 next-server）
for pid in $(ps aux | grep "next-server" | grep -v grep | awk '{print $2}'); do
  if pid_belongs_to_project "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
    log_warn "清理孤儿 next-server 进程 (PID $pid)"
  else
    log_info "跳过非本项目 next-server 进程 (PID $pid)"
  fi
done

echo ""
echo -e "${GREEN}所有服务已停止${NC}"
