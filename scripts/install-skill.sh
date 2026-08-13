#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Agent Chamber — Skill 一键安装脚本
# =============================================================================
# 用法:
#   curl -fsSL https://platform.example.com/install-skill.sh | bash
#   curl -fsSL https://platform.example.com/install-skill.sh | bash -s -- -n agent-chamber -d ~/.agents/skills/agent-chamber
#
# 默认将 Skill 安装到 $HOME/.agents/skills/<skill-name>/SKILL.md。
# 会递归安装子 Skill（topics/taskboard/docs 等）：先取 /skills/:name/subs 列表，
# 再逐个下载 <name>/<sub>?format=raw 到 $TARGET_DIR/<sub>/SKILL.md。
# =============================================================================

# 默认值
PLATFORM_URL="${PLATFORM_URL:-http://localhost:8743}"
SKILL_NAME="${SKILL_NAME:-agent-chamber}"
DRY_RUN="${DRY_RUN:-0}"

# 是否显式指定了目标目录（0 = 未指定，使用默认推导）
TARGET_DIR_EXPLICIT=0
TARGET_DIR="${TARGET_DIR:-}"

# 用法信息
usage() {
  cat <<'EOF'
Usage: install-skill.sh [OPTIONS]

Install a Skill from the Agent Chamber to the local filesystem.

Options:
  -d, --dir <path>    Installation directory (default: $HOME/.agents/skills/<name>)
  -u, --url <url>     Platform base URL (default: http://localhost:8743; pass -u for a deployed instance)
  -n, --name <name>   Skill name (default: agent-chamber)
      --dry-run       Print actions without writing anything
  -h, --help          Show this help message and exit

Environment variables:
  PLATFORM_URL        Same as --url
  SKILL_NAME          Same as --name
  TARGET_DIR          Same as --dir
  DRY_RUN             Set to 1 to enable dry-run mode

Examples:
  curl -fsSL https://platform.example.com/install-skill.sh | bash
  curl -fsSL https://platform.example.com/install-skill.sh | bash -s -- -n agent-chamber -d ~/.agents/skills/agent-chamber
  ./install-skill.sh --dry-run
EOF
}

# 解析参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)
      [[ $# -ge 2 ]] || { echo "Error: $1 requires an argument." >&2; exit 1; }
      TARGET_DIR="$2"
      TARGET_DIR_EXPLICIT=1
      shift 2
      ;;
    -u|--url)
      [[ $# -ge 2 ]] || { echo "Error: $1 requires an argument." >&2; exit 1; }
      PLATFORM_URL="$2"
      shift 2
      ;;
    -n|--name)
      [[ $# -ge 2 ]] || { echo "Error: $1 requires an argument." >&2; exit 1; }
      SKILL_NAME="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# 校验 URL：只允许 http(s) 协议，防止命令注入
if [[ ! "${PLATFORM_URL}" =~ ^https?://[a-zA-Z0-9._-]+(:[0-9]+)?(/.*)?$ ]]; then
  echo "Error: invalid platform URL: ${PLATFORM_URL}" >&2
  exit 1
fi

# 校验 Skill 名称：只允许 URL-safe 字符
if [[ ! "${SKILL_NAME}" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: invalid skill name: ${SKILL_NAME}" >&2
  exit 1
fi

# 确定最终目标目录
if [[ "${TARGET_DIR_EXPLICIT}" -eq 0 ]]; then
  TARGET_DIR="${HOME}/.agents/skills/${SKILL_NAME}"
fi

# 下载目标文件
TARGET_FILE="${TARGET_DIR}/SKILL.md"
DOWNLOAD_URL="${PLATFORM_URL}/api/v1/skills/${SKILL_NAME}?format=raw"

# dry-run 模式
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[DRY-RUN] Would install Skill '${SKILL_NAME}'"
  echo "[DRY-RUN] Download URL: ${DOWNLOAD_URL}"
  echo "[DRY-RUN] Target file: ${TARGET_FILE}"
  echo "[DRY-RUN] Would fetch sub-skill list: ${PLATFORM_URL}/api/v1/skills/${SKILL_NAME}/subs"
  if [[ -f "${TARGET_FILE}" ]]; then
    echo "[DRY-RUN] Existing file would be backed up to: ${TARGET_FILE}.bak.$(date +%s)"
  fi
  echo "[DRY-RUN] No files will be written."
  exit 0
fi

# 创建目标目录
mkdir -p "${TARGET_DIR}"

# 备份已存在的 Skill 文件
if [[ -f "${TARGET_FILE}" ]]; then
  BACKUP_FILE="${TARGET_FILE}.bak.$(date +%s)"
  cp "${TARGET_FILE}" "${BACKUP_FILE}"
  echo "Backed up existing skill to ${BACKUP_FILE}"
fi

# 下载 Skill 内容
echo "Downloading Skill '${SKILL_NAME}' from ${DOWNLOAD_URL} ..."
curl -fsSL "${DOWNLOAD_URL}" -o "${TARGET_FILE}"

echo "Skill '${SKILL_NAME}' installed to ${TARGET_FILE}"

# ═══════════════════════════════════════════════════════════════════════
# 递归安装子 Skill（如 topics、taskboard、docs）
# ═══════════════════════════════════════════════════════════════════════
SUBS_URL="${PLATFORM_URL}/api/v1/skills/${SKILL_NAME}/subs"
SUBS_JSON="$(curl -fsSL "${SUBS_URL}" 2>/dev/null || true)"

if [[ -z "${SUBS_JSON}" ]]; then
  # subs 端点不可达（旧版平台无此端点 / 临时网络故障）：主 Skill 已装，
  # 降级为仅主文件并明确提示，不中断（子 skill 缺失但用户知情）
  echo "Warning: sub-skill list unavailable (${SUBS_URL}); sub-skills skipped. Main SKILL.md is installed."
elif [[ -z "$(printf '%s' "${SUBS_JSON}" | grep -o '"data"' || true)" ]] \
  || printf '%s' "${SUBS_JSON}" | grep -qE '"data"[[:space:]]*:[[:space:]]*null'; then
  # 业务错误：HTTP 2xx 但响应缺失 data 字段或 data=null——静默跳过会装出
  # 残缺品（主文件在、子文件全缺、引用断裂），必须显式失败
  echo "Error: invalid sub-skill response from ${SUBS_URL}" >&2
  exit 1
else
  # 提取子 Skill 名称列表（无 jq 依赖：grep 匹配 "name":"xxx"，兼容紧凑与
  # 带空格两种 JSON 序列化；JSON 字符串内引号必转义，不会误匹配描述文本）
  SUBS="$(printf '%s' "${SUBS_JSON}" \
    | grep -oE '"name"[[:space:]]*:[[:space:]]*"[a-zA-Z0-9_-]+"' \
    | sed -E 's/^"name"[[:space:]]*:[[:space:]]*"([^"]+)"$/\1/' || true)"

  if [[ -z "${SUBS}" ]]; then
    echo "No sub-skills found for '${SKILL_NAME}'."
  else
    echo "Installing sub-skills of '${SKILL_NAME}': ${SUBS//$'\n'/ }"
    for SUB in ${SUBS}; do
      SUB_FILE="${TARGET_DIR}/${SUB}/SKILL.md"
      mkdir -p "$(dirname "${SUB_FILE}")"
      curl -fsSL "${PLATFORM_URL}/api/v1/skills/${SKILL_NAME}/${SUB}?format=raw" -o "${SUB_FILE}"
      echo "  [sub] ${SUB} -> ${SUB_FILE}"
    done
  fi
fi
