#!/usr/bin/env bash
# fix-appimage-icons.sh — Fix Tauri AppImage icon symlinks
#
# Tauri 2's AppImage bundler creates two broken symlinks:
#   1. .DirIcon → absolute path to build dir (breaks on any other machine)
#   2. agaric.png → 16x16 icon (too small for WM/taskbar)
#
# This script fixes the AppDir in-place, then repacks the AppImage.
#
# Usage:
#   ./scripts/fix-appimage-icons.sh
#   ./scripts/fix-appimage-icons.sh path/to/Agaric.AppDir
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

APPDIR="${1:-$PROJECT_ROOT/src-tauri/target/release/bundle/appimage/Agaric.AppDir}"

if [ ! -d "$APPDIR" ]; then
  echo "ERROR: AppDir not found at $APPDIR"
  echo "Run 'cargo tauri build' first."
  exit 1
fi

echo "Fixing icon symlinks in $APPDIR ..."

# 1. Fix .DirIcon: absolute symlink → relative to Agaric.png (512×512, same dir)
if [ -L "$APPDIR/.DirIcon" ]; then
  rm "$APPDIR/.DirIcon"
fi
ln -s Agaric.png "$APPDIR/.DirIcon"
echo "  .DirIcon → Agaric.png (relative)"

# 2. Fix agaric.png: 16x16 → 256x256 for proper WM/taskbar display
if [ -L "$APPDIR/agaric.png" ]; then
  rm "$APPDIR/agaric.png"
fi
ln -s usr/share/icons/hicolor/256x256/apps/agaric.png "$APPDIR/agaric.png"
echo "  agaric.png → 256x256 (was 16x16)"

# 3. Repack the AppImage
APPIMAGE_TOOL="${APPIMAGE_TOOL:-$HOME/.cache/tauri/linuxdeploy-plugin-appimage.AppImage}"
APPIMAGE_DIR="$(dirname "$APPDIR")"
VERSION=$(grep '"version"' "$PROJECT_ROOT/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')
APPIMAGE_OUT="$APPIMAGE_DIR/Agaric_${VERSION}_amd64.AppImage"

if [ -f "$APPIMAGE_TOOL" ]; then
  echo "Repacking AppImage with $APPIMAGE_TOOL ..."
  # linuxdeploy-plugin-appimage acts as appimagetool when given --appdir
  cd "$APPIMAGE_DIR"
  ARCH=x86_64 OUTPUT="$APPIMAGE_OUT" "$APPIMAGE_TOOL" --appdir "$(basename "$APPDIR")" 2>&1
  echo "AppImage repacked: $APPIMAGE_OUT"
else
  echo "WARNING: linuxdeploy-plugin-appimage not found at $APPIMAGE_TOOL"
  echo "AppDir symlinks are fixed but the .AppImage was NOT repacked."
  echo "Run 'cargo tauri build' once to download the tool, then re-run this script."
fi
