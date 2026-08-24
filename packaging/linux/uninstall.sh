#!/usr/bin/env bash
set -euo pipefail

APP_NAME='牙牙消息'
APP_ID='com.yaya.message'
DATA_HOME="${YAYA_INSTALL_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}}"
INSTALL_DIR="$DATA_HOME/yaya-msg"
APPLICATIONS_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$APPLICATIONS_DIR/$APP_ID.desktop"

if [[ -z "$DATA_HOME" || "$DATA_HOME" == '/' || "$INSTALL_DIR" != "$DATA_HOME/yaya-msg" ]]; then
    printf '安装路径异常，已停止卸载：%s\n' "$INSTALL_DIR" >&2
    exit 1
fi

rm -f -- "$DESKTOP_FILE"
if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
    rm -rf -- "$INSTALL_DIR"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

printf '%s 已从当前用户的应用菜单卸载。\n' "$APP_NAME"
printf '消息、设置和下载内容均已保留。\n'
