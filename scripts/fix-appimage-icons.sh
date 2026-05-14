#!/usr/bin/env bash
# fix-appimage-icons.sh — Patch Tauri AppImage AppDir before repack.
#
# Tauri 2's AppImage bundler produces three issues we fix here:
#   1. .DirIcon → absolute path to build dir (breaks on any other machine)
#   2. agaric.png → 16x16 icon (too small for WM/taskbar)
#   3. usr/lib SONAME aliases (libfoo.so, libfoo.so.N, libfoo.so.N.M.K) are
#      shipped as full file copies instead of symlinks, costing ~17 MB
#      uncompressed for librsvg + libgio alone.
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

# 3. Dedupe SONAME chains in usr/lib/. linuxdeploy-plugin-gtk copies each
#    versioned alias (e.g. librsvg-2.so, librsvg-2.so.2, librsvg-2.so.2.50.0)
#    as a full file instead of a symlink. For known offenders this costs
#    ~17 MB uncompressed (3×6.5 MB librsvg + 3×1.9 MB libgio). We replace
#    the shorter-named copies with relative symlinks to the longest-named
#    file in each group. The longer name is the most-specific SONAME and
#    is the actual file the dynamic linker resolves to; the shorter aliases
#    are only there for compatibility with apps that link against the
#    older soname.
LIBDIR="$APPDIR/usr/lib"
if [ -d "$LIBDIR" ]; then
  echo "Deduping SONAME aliases in $LIBDIR ..."
  # First pass: collect candidate regular files matching *.so*
  mapfile -t LIB_FILES < <(find "$LIBDIR" -maxdepth 1 -type f -name "*.so*" -printf '%f\n')
  dedup_count=0
  dedup_bytes=0
  for base in "${LIB_FILES[@]}"; do
    file="$LIBDIR/$base"
    # Skip if a prior iteration converted this file into a symlink.
    [ -L "$file" ] && continue
    # Prefix = portion up to and including ".so" (e.g. "librsvg-2.so").
    prefix="${base%%.so*}.so"
    # Find a longer-named regular file with the same prefix and identical content.
    longest_match=""
    for candidate_base in "${LIB_FILES[@]}"; do
      [ "$candidate_base" = "$base" ] && continue
      case "$candidate_base" in "$prefix"*) ;; *) continue ;; esac
      [ ${#candidate_base} -gt ${#base} ] || continue
      candidate="$LIBDIR/$candidate_base"
      [ -L "$candidate" ] && continue
      [ -f "$candidate" ] || continue
      if cmp -s "$file" "$candidate"; then
        # Pick the longest such candidate so all shorter aliases point at one real file.
        if [ -z "$longest_match" ] || [ ${#candidate_base} -gt ${#longest_match} ]; then
          longest_match="$candidate_base"
        fi
      fi
    done
    if [ -n "$longest_match" ]; then
      size=$(stat -c %s "$file")
      rm "$file"
      ln -s "$longest_match" "$file"
      echo "  $base → $longest_match (saved ${size} bytes)"
      dedup_count=$((dedup_count + 1))
      dedup_bytes=$((dedup_bytes + size))
    fi
  done
  echo "  deduped $dedup_count file(s), saved $dedup_bytes bytes uncompressed"
fi

# 4. Repack the AppImage
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
