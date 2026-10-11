#!/bin/bash
# Apply the QuickClip Finder layout to a generated DMG.
#
# Usage:
#   scripts/beautify-dmg.sh target/release/bundle/dmg/QuickClip_1.0.1_aarch64.dmg
#
# The image is rebuilt as HFS+ before Finder layout is written. Finder's DMG
# background and icon-position metadata is much more reliable on HFS+ than on
# APFS images created by a plain `hdiutil create`.

set -euo pipefail

DMG="${1:-}"
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
    echo "Usage: $0 <path-to-QuickClip.dmg>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKGROUND="$FRONTEND_DIR/src-tauri/icons/dmg-background.png"
APP_SOURCE="$FRONTEND_DIR/src-tauri/target/release/bundle/macos/QuickClip.app"
VOLUME_NAME="QuickClip"

DMG_DIR="$(dirname "$DMG")"
DMG_NAME="$(basename "$DMG" .dmg)"
RW_DMG="$DMG_DIR/${DMG_NAME}_rw.dmg"
FINAL_DMG="$DMG_DIR/${DMG_NAME}_beautified.dmg"
STAGING_DIR=""
READONLY_MOUNT=""
READONLY_DEVICE=""
MOUNT_DIR=""
DEVICE=""

cleanup() {
    if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
        hdiutil detach "$MOUNT_DIR" -force -quiet >/dev/null 2>&1 || true
    elif [ -n "$DEVICE" ]; then
        hdiutil detach "$DEVICE" -force -quiet >/dev/null 2>&1 || true
    fi
    if [ -n "$READONLY_MOUNT" ] && [ -d "$READONLY_MOUNT" ]; then
        hdiutil detach "$READONLY_MOUNT" -force -quiet >/dev/null 2>&1 || true
    elif [ -n "$READONLY_DEVICE" ]; then
        hdiutil detach "$READONLY_DEVICE" -force -quiet >/dev/null 2>&1 || true
    fi
    if [ -n "$STAGING_DIR" ]; then
        rm -rf "$STAGING_DIR"
    fi
}
trap cleanup EXIT

if [ ! -f "$BACKGROUND" ]; then
    echo "ERROR: missing DMG background: $BACKGROUND"
    exit 1
fi

echo "=== Beautify DMG: $DMG ==="
rm -f "$RW_DMG" "$FINAL_DMG"

STAGING_DIR="$(mktemp -d /private/tmp/quickclip-beautify.XXXXXX)"
echo "Preparing staging folder..."
if [ -d "$APP_SOURCE" ]; then
    cp -R "$APP_SOURCE" "$STAGING_DIR/QuickClip.app"
else
    echo "  Built app not found, extracting QuickClip.app from input DMG..."
    READONLY_OUTPUT="$(hdiutil attach "$DMG" -nobrowse -noautoopen 2>&1)"
    READONLY_MOUNT="$(printf '%s\n' "$READONLY_OUTPUT" | sed -n 's#^/dev/.*\(/Volumes/.*\)$#\1#p' | head -n 1)"
    READONLY_DEVICE="$(printf '%s\n' "$READONLY_OUTPUT" | sed -n 's#^\(/dev/[^[:space:]]*\).*#\1#p' | head -n 1)"
    if [ -z "$READONLY_MOUNT" ] || [ ! -d "$READONLY_MOUNT/QuickClip.app" ]; then
        echo "ERROR: cannot find QuickClip.app in input DMG"
        echo "$READONLY_OUTPUT"
        exit 1
    fi
    cp -R "$READONLY_MOUNT/QuickClip.app" "$STAGING_DIR/QuickClip.app"
    hdiutil detach "$READONLY_MOUNT" -force -quiet || hdiutil detach "$READONLY_DEVICE" -force -quiet
    for _ in {1..20}; do
        [ ! -d "$READONLY_MOUNT" ] && break
        sleep 0.25
    done
    if [ -d "$READONLY_MOUNT" ]; then
        echo "ERROR: input DMG is still mounted at $READONLY_MOUNT"
        exit 1
    fi
    READONLY_MOUNT=""
    READONLY_DEVICE=""
fi
ln -s /Applications "$STAGING_DIR/Applications"

IMAGE_SIZE_MB="$(du -sm "$STAGING_DIR" | awk '{print $1 + 80}')"
echo "Creating HFS+ read-write image (${IMAGE_SIZE_MB}MB)..."
hdiutil create "$RW_DMG" \
    -volname "$VOLUME_NAME" \
    -srcfolder "$STAGING_DIR" \
    -fs "HFS+" \
    -fsargs "-c c=64,a=16,e=16" \
    -format UDRW \
    -size "${IMAGE_SIZE_MB}m" \
    -quiet

echo "Mounting read-write image..."
MOUNT_OUTPUT="$(hdiutil attach "$RW_DMG" -readwrite -noverify -nobrowse -noautoopen 2>&1)"
MOUNT_DIR="$(printf '%s\n' "$MOUNT_OUTPUT" | sed -n 's#^/dev/.*\(/Volumes/.*\)$#\1#p' | head -n 1)"
DEVICE="$(printf '%s\n' "$MOUNT_OUTPUT" | sed -n 's#^\(/dev/[^[:space:]]*\).*#\1#p' | head -n 1)"
if [ -z "$MOUNT_DIR" ] || [ ! -d "$MOUNT_DIR" ]; then
    echo "ERROR: mount failed"
    echo "$MOUNT_OUTPUT"
    rm -f "$RW_DMG"
    exit 1
fi
echo "Mounted at: $MOUNT_DIR"

mkdir -p "$MOUNT_DIR/.background"
cp "$BACKGROUND" "$MOUNT_DIR/.background/dmg-background.png"
SetFile -a V "$MOUNT_DIR/.background" 2>/dev/null || true

echo "Writing Finder layout via AppleScript..."
osascript <<APPLESCRIPT
with timeout of 60 seconds
tell application "Finder"
    set targetFolder to (POSIX file "$MOUNT_DIR") as alias
    open targetFolder
    delay 1
    set targetWindow to container window of targetFolder
    activate
    set current view of targetWindow to icon view
    set toolbar visible of targetWindow to false
    set statusbar visible of targetWindow to false
    set bounds of targetWindow to {200, 100, 860, 540}
    set theViewOptions to the icon view options of targetWindow
    set icon size of theViewOptions to 96
    set arrangement of theViewOptions to not arranged
    set text size of theViewOptions to 12
    set shows icon preview of theViewOptions to false
    set background picture of theViewOptions to (POSIX file "$MOUNT_DIR/.background/dmg-background.png" as alias)
    set position of item "QuickClip.app" of targetFolder to {141, 223}
    set position of item "Applications" of targetFolder to {360, 223}
    update targetFolder without registering applications
    delay 2
    close front window
end tell
end timeout
APPLESCRIPT

sync
sleep 2
echo "Unmounting image..."
hdiutil detach "${DEVICE:-$MOUNT_DIR}" -force -quiet
MOUNT_DIR=""
DEVICE=""

echo "Compressing final DMG..."
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$FINAL_DMG" -quiet
mv -f "$FINAL_DMG" "$DMG"
rm -f "$RW_DMG"

echo "=== Done ==="
du -sh "$DMG"
