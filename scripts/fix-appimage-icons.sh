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
#   ./scripts/fix-appimage-icons.sh --strict            # fail if repack tool missing
#   FIX_APPIMAGE_STRICT=1 ./scripts/fix-appimage-icons.sh
#
# Strict mode (either --strict or FIX_APPIMAGE_STRICT=1) causes the script to
# exit 1 if linuxdeploy-plugin-appimage is not available, instead of warning
# and continuing. The release workflow (.github/workflows/release.yml) enables
# strict mode so a missing repack tool blocks the release; local dev contributors
# keep the default warn-and-continue behaviour.
set -euo pipefail

STRICT_MODE="${FIX_APPIMAGE_STRICT:-0}"

# Parse flags while preserving the optional positional AppDir argument.
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict)
      STRICT_MODE=1
      shift
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        POSITIONAL+=("$1")
        shift
      done
      break
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

APPDIR="${POSITIONAL[0]:-$PROJECT_ROOT/src-tauri/target/release/bundle/appimage/Agaric.AppDir}"

if [ ! -d "$APPDIR" ]; then
  echo "ERROR: AppDir not found at $APPDIR"
  echo "Run 'cargo tauri build' first."
  exit 1
fi

# Normalise AppDir to an absolute path. The repack step `cd`s into the
# AppImage directory and then passes both `--appdir` (a basename) and
# OUTPUT (a path) to appimagetool. If APPDIR was relative, the derived
# APPIMAGE_OUT is relative too and the post-`cd` resolution lands in a
# non-existent nested path, causing
#   `Could not create destination file: No such file or directory`
#   `mksquashfs (pid …) exited with code 1`
#   `sfs_mksquashfs error`
# Release.yml passes the (relative) triple-prefixed AppDir; the
# realpath() call here keeps both invocation modes (absolute default,
# relative explicit) working uniformly.
APPDIR="$(cd "$APPDIR" && pwd)"

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
  if [ "$STRICT_MODE" = "1" ]; then
    echo "ERROR: linuxdeploy-plugin-appimage not found at $APPIMAGE_TOOL (strict mode)" >&2
    echo "Install the tool first (either via 'cargo tauri build' which caches it," >&2
    echo "or by downloading a tagged release from" >&2
    echo "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases into \$HOME/.cache/tauri/)." >&2
    exit 1
  fi
  echo "WARNING: linuxdeploy-plugin-appimage not found at $APPIMAGE_TOOL"
  echo "AppDir symlinks are fixed but the .AppImage was NOT repacked."
  echo "Run 'cargo tauri build' once to download the tool, then re-run this script."
fi
