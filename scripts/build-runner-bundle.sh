#!/usr/bin/env bash
# =============================================================================
# build-runner-bundle.sh — 构建「圆桌 runner 自包含 bundle」（standalone 一键安装链路）
#
# 产物（DOWNLOADS_DIR，缺省 = <repo 根>/dist-assets/，与 backend downloads
# controller 的缺省路径一致）：
#   dist-assets/roundtable-runner.tar.gz   runner + prod node_modules（vendored，
#                                         用户机器只需 node，无需 pnpm/git/外网）
#   dist-assets/install-runner.sh          一键安装脚本（与 tar.gz 同版本）
#   dist-assets/integrations/*.md          对接指南四份（kimi/codex × EN/zh-CN）
#
# 流程：构建 protocol/runner → pnpm deploy --prod 到临时 staging（workspace 依赖
# 内联成独立副本）→ 逃逸符号链接替换为实体拷贝（deploy --legacy 的 workspace 依赖
# 是指回主仓的相对符号链接，见步骤 2.5 注释）→ 改写 staging package.json 的
# workspace:* 为实际版本
# （standalone 安装自检失败时 npm install --omit=dev 重建依赖，npm 不认 workspace:
# 协议，必须实版本号）→ node dist/cli.js --help 自检 → tar.gz → 拷贝配套资产。
#
# 路径关系（脚本位于 <内层 repo 根>/scripts/）：
#   - <repo 根>            = $(dirname $0)/..（pnpm-workspace 所在，本脚本的执行环境）
#   - oss-docs（外层）      = $REPO_ROOT/../oss-docs（docs/integrations/ 是唯一事实来源）
#   - docker 构建无外层目录 → INTEGRATIONS_SRC 可覆盖；缺省探测失败则 warn 跳过
#
# 用法:
#   ./scripts/build-runner-bundle.sh
#   DOWNLOADS_DIR=/srv/assets ./scripts/build-runner-bundle.sh   # 覆盖产物目录
#   INTEGRATIONS_SRC=/path/to/docs ./scripts/build-runner-bundle.sh
# =============================================================================
set -euo pipefail

# ---------- 路径与默认值 ----------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 与 backend DownloadsService 同款 env 契约：DOWNLOADS_DIR 覆盖，缺省 repo 根 dist-assets/
OUT_DIR="${DOWNLOADS_DIR:-$REPO_ROOT/dist-assets}"
# 外层 oss-docs 探测（本机仓库存在；docker 构建环境不存在则留空）
INTEGRATIONS_SRC="${INTEGRATIONS_SRC:-}"
if [[ -z "$INTEGRATIONS_SRC" ]]; then
  INTEGRATIONS_SRC="$(cd "$REPO_ROOT/../oss-docs/docs/integrations" 2>/dev/null && pwd || true)"
fi

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[build-runner-bundle]${NC} $*"; }
warn() { echo -e "${YELLOW}[build-runner-bundle]${NC} $*"; }
fail() { echo -e "${RED}[build-runner-bundle] ERROR:${NC} $*" >&2; exit 1; }

# ---------- staging 临时目录（trap 保证清理，失败不残留） ----------
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/runner-bundle.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

cd "$REPO_ROOT"

# ---------- 1. 构建 workspace 依赖 ----------
# pnpm deploy 复制的是主仓包目录内容：protocol/runner 必须先构建，
# 否则 staging 内缺 dist，独立运行直接 MODULE_NOT_FOUND
info "构建 roundtable-protocol / roundtable-runner..."
pnpm --filter @agent-chamber/roundtable-protocol build
pnpm --filter @agent-chamber/roundtable-runner build

# ---------- 2. pnpm deploy --prod（workspace 依赖内联为独立副本） ----------
# pnpm v10+ 默认只允许 injected workspace 执行 deploy（ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE），
# 需 --legacy 才走旧行为；pnpm v9（生产宿主机 9.15.9）不认识该 flag——按主版本号分流
# （v1.51.0 从零冒烟第三层 bug：docker builder corepack 装 pnpm@latest 必炸，2026-08-13）
PNPM_MAJOR="$(pnpm --version | cut -d. -f1)"
info "pnpm deploy --prod → $STAGING（pnpm $(pnpm --version)）"
if [ "$PNPM_MAJOR" -ge 10 ]; then
  pnpm --filter @agent-chamber/roundtable-runner deploy --prod --legacy "$STAGING"
else
  pnpm --filter @agent-chamber/roundtable-runner deploy --prod "$STAGING"
fi

# ---------- 2.5 外逃逸符号链接内联为实体拷贝 ----------
# pnpm deploy --legacy 对 workspace 依赖生成「逃逸符号链接」：node_modules/
# @agent-chamber/roundtable-protocol 是相对符号链接，解析后指回主仓包目录。
# staging 自检（步骤 4）在本机恰好能解析 → 假阳性；用户机器解包后必然
# MODULE_NOT_FOUND（2026-08-14 M4b-3 从零冒烟实测捕获，现行 bundle 全中招）。
# 修法：把解析结果落在 staging 之外的符号链接替换为实体拷贝（protocol 零依赖，
# 直接 cp -r 即可；.pnpm 内部相对链接保持原样不动）。
while IFS= read -r link; do
  target="$(readlink -f "$link")"
  case "$target" in
    "$STAGING"/*) ;;  # staging 内部链接（.pnpm 布局）自包含，保持原样
    *)
      info "内联逃逸符号链接: ${link#"$STAGING"/} → $target"
      rm "$link"
      cp -r "$target" "$link"
      ;;
  esac
done < <(find "$STAGING/node_modules" -type l)

# ---------- 3. 改写 workspace:* 为实际版本 ----------
# staging/package.json 中 @agent-chamber/roundtable-protocol 仍写作 workspace:*；
# standalone 模式自检失败会跑 npm install --omit=dev，npm 解析不了 workspace:
# 协议（会报 E404）——必须在打包前改写为 protocol 的真实版本号
PROTO_VERSION="$(node -p "require('$REPO_ROOT/packages/roundtable-protocol/package.json').version")"
node -e "
const fs = require('fs');
const p = '$STAGING/package.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.dependencies['@agent-chamber/roundtable-protocol'] = '$PROTO_VERSION';
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"
info "staging package.json: @agent-chamber/roundtable-protocol → $PROTO_VERSION"

# ---------- 4. 自检：staging 必须能独立跑 --help ----------
# 失败即退出（fail 会带 set -e 触发的非零状态），不让坏 bundle 进产物目录
if ! node "$STAGING/dist/cli.js" --help >/dev/null 2>&1; then
  fail "staging 自检失败：node $STAGING/dist/cli.js --help 未通过，bundle 未产出"
fi
info "自检通过: node $STAGING/dist/cli.js --help"

# ---------- 5. 打 tar.gz（排除源码/构建配置，只留运行时） ----------
# --exclude：src/、tsconfig.json、jest.config.js 是 pnpm deploy 全量复制带来的
# 构建残留（runner 包无 files 字段），对运行时零价值，打进 bundle 徒增体积
mkdir -p "$OUT_DIR"
tar czf "$OUT_DIR/roundtable-runner.tar.gz" \
  -C "$STAGING" \
  --exclude='src' \
  --exclude='tsconfig.json' \
  --exclude='jest.config.js' \
  .

# ---------- 6. 配套资产：install-runner.sh + 对接指南 ----------
cp "$REPO_ROOT/scripts/install-runner.sh" "$OUT_DIR/install-runner.sh"
if [[ -n "$INTEGRATIONS_SRC" && -d "$INTEGRATIONS_SRC" ]]; then
  mkdir -p "$OUT_DIR/integrations"
  cp "$INTEGRATIONS_SRC"/*.md "$OUT_DIR/integrations/"
  info "integrations 已拷贝: $INTEGRATIONS_SRC → $OUT_DIR/integrations/ ($(ls "$OUT_DIR/integrations" | wc -l) 份)"
else
  warn "未找到 oss-docs/docs/integrations（docker 构建环境无外层目录？），integrations 已跳过"
  warn "  本机可传 INTEGRATIONS_SRC=<外层 oss-docs/docs/integrations 绝对路径> 重跑"
fi

# ---------- 7. 体积打印 + 超限警告 ----------
# codex-acp → @openai/codex 平台二进制（linux-x64 约 300MB）是体积大头；
# 超出 150MB 属于已知风险（plan 风险表），warn 提示评估 external 化而非阻断
SIZE_KB="$(du -k "$OUT_DIR/roundtable-runner.tar.gz" | cut -f1)"
SIZE_MB="$((SIZE_KB / 1024))"
if [[ "$SIZE_MB" -gt 150 ]]; then
  warn "bundle 体积 ${SIZE_MB}MB 超出 150MB 警戒线（codex-acp 内嵌 @openai/codex 平台二进制）——"
  warn "  若需收敛可评估 codex-acp external 化，但会牺牲 standalone「零外网依赖」卖点"
fi
info "产物就绪:"
info "  $OUT_DIR/roundtable-runner.tar.gz (${SIZE_MB}MB)"
info "  $OUT_DIR/install-runner.sh"
info "  $OUT_DIR/integrations/ ($([ -d "$OUT_DIR/integrations" ] && ls "$OUT_DIR/integrations" | wc -l || echo 0) 份指南)"
