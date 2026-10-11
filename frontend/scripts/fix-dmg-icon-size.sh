#!/bin/bash
# 挂载 DMG，设置图标大小为 80px，保存视图设置后重新压缩

set -euo pipefail

DMG="$1"
if [ ! -f "$DMG" ]; then
    echo "Usage: $0 <path-to.dmg>"
    exit 1
fi

echo "=== 修正 DMG 图标大小 ==="

# 1. 转换为可读写
TMP_DMG="${DMG%.dmg}-rw.dmg"
rm -f "$TMP_DMG"
echo "转换为可读写..."
hdiutil convert "$DMG" -format UDRW -o "$TMP_DMG" > /dev/null

# 2. 挂载
echo "挂载 DMG..."
MOUNT_OUTPUT=$(hdiutil attach "$TMP_DMG" -nobrowse -readwrite 2>&1)
DEVICE=$(echo "$MOUNT_OUTPUT" | head -1 | awk '{print $1}')
MOUNT_POINT=$(echo "$MOUNT_OUTPUT" | tail -1 | awk '{print $3}')
echo "  设备: $DEVICE"
echo "  挂载点: $MOUNT_POINT"

# 3. 设置图标大小和视图选项
echo "设置图标大小 80px..."
osascript <<APPLESCRIPT
tell application "Finder"
    activate
    open POSIX file "$MOUNT_POINT"
    delay 0.5
    tell front window
        set current view to icon view
        set toolbar visible to false
        set statusbar visible to false
        set bounds to {100, 100, 760, 540}
    end tell
    -- 设置图标视图选项
    tell icon view options of front window
        set icon size to 80
        set arrangement to not arranged
        set shows item info to false
        set shows icon preview to false
    end tell
    delay 0.5
    close front window
end tell
APPLESCRIPT

# 4. 强制写入 .DS_Store 并卸载
echo "保存视图设置..."
sleep 2
hdiutil detach "$MOUNT_POINT" -force 2>/dev/null || true

# 5. 重新压缩为只读 DMG
echo "重新压缩..."
rm -f "$DMG"
hdiutil convert "$TMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG" > /dev/null
rm -f "$TMP_DMG"

echo "=== 完成 ==="
echo "DMG: $DMG"
