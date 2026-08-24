#!/usr/bin/env bash
set -euo pipefail

APP_NAME='牙牙消息'
APP_ID='com.yaya.message'
EXECUTABLE_NAME='牙牙消息'
SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${YAYA_INSTALL_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}}"
INSTALL_DIR="$DATA_HOME/yaya-msg"
APPLICATIONS_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$APPLICATIONS_DIR/$APP_ID.desktop"

if [[ ! -f "$SOURCE_DIR/$EXECUTABLE_NAME" ]]; then
    printf '找不到可执行文件：%s\n' "$SOURCE_DIR/$EXECUTABLE_NAME" >&2
    exit 1
fi

if [[ ! -f "$SOURCE_DIR/icon.png" ]]; then
    printf '找不到应用图标：%s\n' "$SOURCE_DIR/icon.png" >&2
    exit 1
fi

mkdir -p "$INSTALL_DIR" "$APPLICATIONS_DIR"
if [[ "$SOURCE_DIR" != "$INSTALL_DIR" ]]; then
    cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/
fi

chmod u+x \
    "$INSTALL_DIR/$EXECUTABLE_NAME" \
    "$INSTALL_DIR/安装到应用菜单.sh" \
    "$INSTALL_DIR/卸载.sh"

escape_exec_argument() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g'
}

escaped_executable="$(escape_exec_argument "$INSTALL_DIR/$EXECUTABLE_NAME")"
desktop_temp="$DESKTOP_FILE.tmp.$$"
{
    printf '[Desktop Entry]\n'
    printf 'Type=Application\n'
    printf 'Version=1.0\n'
    printf 'Name=%s\n' "$APP_NAME"
    printf 'Comment=牙牙消息桌面客户端\n'
    printf 'Exec="%s"\n' "$escaped_executable"
    printf 'Icon=%s\n' "$INSTALL_DIR/icon.png"
    printf 'Path=%s\n' "$INSTALL_DIR"
    printf 'Terminal=false\n'
    printf 'Categories=Utility;Network;\n'
    printf 'StartupWMClass=yaya_msg\n'
    printf 'StartupNotify=true\n'
    printf 'X-GNOME-UsesNotifications=true\n'
} > "$desktop_temp"
chmod 0644 "$desktop_temp"
mv -f "$desktop_temp" "$DESKTOP_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

printf '%s 已安装到当前用户的应用菜单。\n' "$APP_NAME"
printf '现在可以在应用列表中搜索“%s”，并固定到 Dock。\n' "$APP_NAME"
