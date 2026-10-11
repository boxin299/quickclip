#!/bin/bash
# ==============================================================
# DMG 图标缩放后处理脚本
# 将 DMG 中的访达图标大小设置为 80%（约 102px）
# ==============================================================
set -euo pipefail

DMG="$1"
if [ ! -f "$DMG" ]; then
    echo "Usage: $0 <path/to/app.dmg>"
    exit 1
fi

DMG_DIR="$(dirname "$DMG")"
DMG_NAME="$(basename "$DMG" .dmg)"
VOLUME_NAME="QuickClip"

echo "=== 处理 DMG 图标大小: $DMG ==="

# 1. 转换为可读写格式
TEMP_RW="$DMG_DIR/${DMG_NAME}_rw.dmg"
echo "转换为可读写 DMG..."
rm -f "$TEMP_RW"
hdiutil convert "$DMG" -format UDRW -o "$TEMP_RW" -quiet

# 2. 挂载可读写 DMG
echo "挂载 DMG..."
hdiutil detach "/Volumes/QuickClip"* 2>/dev/null || true
sleep 1
MOUNT_OUTPUT=$(hdiutil attach "$TEMP_RW" -readwrite -nobrowse -noautoopen 2>&1)
MOUNT_DIR=$(echo "$MOUNT_OUTPUT" | grep -o '/Volumes/[^"]*' | head -1)
if [ -z "$MOUNT_DIR" ]; then
    echo "ERROR: 挂载失败，输出：$MOUNT_OUTPUT"
    rm -f "$TEMP_RW"
    exit 1
fi
echo "  已挂载到: $MOUNT_DIR"

# 3. 通过 AppleScript 设置深色背景 + 图标大小 + 文字颜色
echo "调整访达图标设置（深色背景 + 白色文字）..."
osascript -e "
with timeout of 30 seconds
tell application \"Finder\"
    set targetFolder to (POSIX file \"$MOUNT_DIR\") as alias
    open targetFolder
    activate
    set current view of front window to icon view
    set toolbar visible of front window to false
    set statusbar visible of front window to false
    set bounds of front window to {200, 100, 860, 540}
    set theViewOptions to the icon view options of front window
    set icon size of theViewOptions to 80
    set arrangement of theViewOptions to not arranged
    set text size of theViewOptions to 12
    set shows icon preview of theViewOptions to false
    set background color of theViewOptions to {13107, 13107, 13107}
    set bgPath to POSIX file \"$MOUNT_DIR/.background/dmg-background.png\"
    set background picture of theViewOptions to bgPath
    close front window
end tell
end timeout
" 2>&1
echo "  图标 80px + 深色背景(强制白色文字)"

# 4. 卸载
echo "卸载 DMG..."
hdiutil detach "$MOUNT_DIR" -quiet

# 5. 转换回压缩格式
echo "转换为压缩 DMG..."
FINAL_DMG="$DMG_DIR/${DMG_NAME}_final.dmg"
rm -f "$FINAL_DMG"
hdiutil convert "$TEMP_RW" -format UDZO -imagekey zlib-level=9 -o "$FINAL_DMG" -quiet

# 6. 替换原文件
rm -f "$TEMP_RW"
mv "$FINAL_DMG" "$DMG"

echo ""
echo "=== 完成 ==="
echo "  $(du -sh "$DMG" | awk '{print $1}') $DMG"
