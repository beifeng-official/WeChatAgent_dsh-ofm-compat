#!/usr/bin/env bash
# 一键安装 / 卸载 dsh-ofm-compat（macOS / Linux / Git Bash / WSL 薄包装）
#
# 真正的逻辑只有一份，在 scripts/cli.mjs（跨平台）。
#
# 用法：
#   ./scripts/install.sh                       # 装进 desktop profile
#   ./scripts/install.sh --profile web
#   ./scripts/install.sh --spec github:you/dsh-ofm-compat
#   ./scripts/install.sh --dry-run
#   ./scripts/install.sh --uninstall
#   ./scripts/install.sh --command doctor      # 环境体检
#   ./scripts/install.sh --command status      # 读取运行状态
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/cli.mjs"

if [ ! -f "$CLI" ]; then
  echo "找不到 $CLI" >&2
  exit 2
fi

COMMAND="install"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --command) COMMAND="$2"; shift 2 ;;
    --profile|--spec|--dsh-home|--port) ARGS+=("$1" "$2"); shift 2 ;;
    --uninstall) COMMAND="uninstall"; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

exec node "$CLI" "$COMMAND" "${ARGS[@]+"${ARGS[@]}"}"
