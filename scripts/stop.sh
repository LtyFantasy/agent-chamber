#!/bin/bash

# AI Agent Chamber 协作平台 — 一键停止脚本
#
# 优雅停止（Stage 0 / 卡 876c1f22）：SIGTERM → 等待 ≤$STOP_GRACE_SECONDS（默认 15s）→ SIGKILL 兜底。
#   - backend 侧 apps/backend/src/main.ts 已 enableShutdownHooks()：Nest 收到 SIGTERM 会做
#     终局 flush（关 HTTP/WS、断连接池），因此必须给足排空时间，不能立刻 KILL
#     （旧实现 kill -TERM 后只 sleep 2 就 KILL，是「秒级停机」里唯一有损坏风险的动作）；
#   - 正常情况进程几十~几百毫秒内退出 ⇒ 停机窗口仍是秒级，15s 只是兜底上限；
#   - 多个进程共享同一个等待窗口（先全部 TERM、再统一等待），因此最坏总耗时 = 一次 15s，
#     而不是「每个进程各等 15s」。

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs"

WEB_PORT=8742
BACKEND_PORT=8743
STOP_GRACE_SECONDS="${DEPLOY_STOP_GRACE_SECONDS:-15}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# 进程归属校验：仅当进程属于本项目（工作目录在 PROJECT_ROOT 内，或 cmdline 中含
# PROJECT_ROOT 路径）才允许杀。
# 防误杀本机其他项目：8742/8743 端口或 next-server 进程名都可能被别的项目占用
# （如 agent-core dev web、其他 docker 栈），无归属校验的强杀会误伤。
# 进程归属校验（F10）：SIGKILL 前复核用 —— 等待窗口期间 PID 可能被系统回收复用给
# 邻居进程，只有仍属于本项目才允许强杀（见下方 KILL 兜底段的用法注释）。
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

# ─── 收集待停进程 ───
# 三类来源合并去重：pid 文件（start.sh 写的权威 PID）、端口监听者（pid 文件丢失/过期
# 时的兜底）、本项目 next-server 孤儿。端口/孤儿两路带归属校验（防误杀邻居）；
# pid 文件那路沿用历史行为（不校验归属）——它由本项目 start.sh 自己写，加了校验反而
# 会在读不到 /proc 时有「该杀没杀」风险，而 start.sh 遇到活着的旧 PID 会跳过启动。
PIDS=""
add_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  case " $PIDS " in
    *" $pid "*) return 0 ;;
  esac
  if kill -0 "$pid" 2>/dev/null; then
    PIDS="$PIDS $pid"
  fi
}

for pidfile in "$LOG_DIR/backend.pid" "$LOG_DIR/frontend.pid"; do
  if [ -f "$pidfile" ]; then
    add_pid "$(cat "$pidfile" 2>/dev/null || true)"
  fi
done

# 端口监听者 PID（ss 优先 + lsof 兜底并集）——与 deploy.sh 的 listener_pids 同款，
# 理由见那边的事故注释：2026-10-17 首趟生产实战中 lsof 4.95.0 对 next-server 的 LISTEN
# 套接字完全失明（ss/netlink 正常），只查 lsof 会漏掉真实监听者 ⇒ 端口兜底路径失效。
# -sTCP:LISTEN 保留在 lsof 分支（不带它会把客户端连接也算进来，污染「要停的服务」候选）；
# ss 的 -l 天然 LISTEN-only。
port_listener_pids() {
  local port="$1" from_ss="" from_lsof=""
  if command -v ss >/dev/null 2>&1; then
    from_ss="$(ss -tlnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)"
  fi
  if command -v lsof >/dev/null 2>&1; then
    from_lsof="$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  printf '%s\n%s\n' "$from_ss" "$from_lsof" | sed '/^$/d' | sort -u | tr '\n' ' '
}

for port in "$BACKEND_PORT" "$WEB_PORT"; do
  for pid in $(port_listener_pids "$port"); do
    if pid_belongs_to_project "$pid"; then
      add_pid "$pid"
    else
      log_warn "端口 $port 的 PID $pid 不属于本项目，跳过（请人工确认是哪个进程占用）"
    fi
  done
done

for pid in $(ps aux | grep "next-server" | grep -v grep | awk '{print $2}'); do
  if pid_belongs_to_project "$pid"; then
    add_pid "$pid"
  fi
done

if [ -z "$PIDS" ]; then
  log_info "未发现运行中的本项目服务进程"
else
  # ─── 优雅停止：先全部 TERM，再共享一个等待窗口 ───
  log_info "发送 SIGTERM 给:$PIDS（Nest enableShutdownHooks 会做终局 flush）"
  for pid in $PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  waited=0
  while [ "$waited" -lt "$STOP_GRACE_SECONDS" ]; do
    remaining=""
    for pid in $PIDS; do
      if kill -0 "$pid" 2>/dev/null; then
        remaining="$remaining $pid"
      fi
    done
    if [ -z "$remaining" ]; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # ─── KILL 兜底（只打未退出的） ───
  killed=0
  skipped=0
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      # F10：强杀前复核归属。等待窗口最长 15s，期间该 PID 完全可能已退出并被系统
      # 回收复用给别的进程（邻居 hument/idle-game 等）—— 等待开始时它是我们的进程，
      # 不代表结束时仍是。不复核 = 有概率用 SIGKILL 误杀邻居。
      if ! pid_belongs_to_project "$pid"; then
        log_warn "PID $pid 在等待窗口内已不属于本项目（PID 复用？），跳过 SIGKILL（请人工确认）"
        skipped=$((skipped + 1))
        continue
      fi
      log_warn "PID $pid 在 ${STOP_GRACE_SECONDS}s 内未退出，发送 SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
      killed=$((killed + 1))
    fi
  done
  if [ "$killed" = 0 ] && [ "$skipped" = 0 ]; then
    log_ok "全部进程已优雅退出（等待 ${waited}s）"
  fi
fi

rm -f "$LOG_DIR/backend.pid" "$LOG_DIR/frontend.pid"

echo ""
echo -e "${GREEN}所有服务已停止${NC}"
