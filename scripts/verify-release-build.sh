#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Release pre-flight verifier (PEND-39 follow-on).
#
# Runs the bundle-build step that distinguishes release.yml from the
# everyday _validate.yml gate: `cargo tauri build` for the LOCAL OS
# (no cross-OS coverage — that's inherent to native bundling).
# Verifies the produced bundle paths match what release.yml expects so
# the actual tag push doesn't surface "missing bundle" failures.
#
# NOT wired into pre-push by default (5-10 min wall clock per run; too
# slow for daily-push cadence). Run manually before tagging a release:
#
#   scripts/verify-release-build.sh
#   # then, if green:
#   scripts/bump-version.sh <new-version> --commit --tag --push
#
# What this DOES catch:
#   * Rust release-profile compile errors (some lint warnings only fire
#     in release mode).
#   * tauri.conf.json schema drift (bundler resolves it at build time).
#   * externalBin path mismatches (release bundles enforce them).
#   * Bundler-side surprises: linuxdeploy / WiX / dmg packaging steps.
#   * appimage-icon repair script (Linux only — see fix-appimage-icons.sh).
#
# What this DOES NOT catch:
#   * Cross-OS bundle issues (Windows .msi, macOS .dmg/.app). Those need
#     their native runner; only the matching CI matrix slot can verify.
#   * SLSA attestation generation / `gh release upload` permissions.
#   * The Android APK / AAB pipeline (separate job in release.yml).
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

OS="$(uname -s)"
echo "→ release build verification on $OS"
echo "  (cross-OS bundles are inherently un-buildable here — only this OS gets verified)"

# Detect cargo-tauri presence; the build script in BUILD.md installs it
# via `cargo install tauri-cli --locked`.
if ! command -v cargo-tauri > /dev/null 2>&1; then
    if ! cargo tauri --version > /dev/null 2>&1; then
        echo "✗ cargo tauri CLI not found. Install: cargo install tauri-cli --locked"
        exit 1
    fi
fi

# externalBin pre-build (sidecar agaric-mcp binary) — release.yml does
# this via `node scripts/prepare-external-bins.mjs` AFTER the validate
# gate. We do it here so the bundler finds the artifact.
echo "→ building externalBin sidecar (agaric-mcp)"
node scripts/prepare-external-bins.mjs

# The main event — Tauri bundles for the LOCAL OS only.
echo "→ cargo tauri build (release profile, local OS)"
cargo tauri build

# Bundle-path probes per OS. Mirrors release.yml's upload globs so a
# bundle-naming change here surfaces before the tag push. When the
# Minisign signing key is set in env, also probe the updater payloads
# (the `.tar.gz` / `.zip` archives the in-app auto-updater fetches) —
# these are the artifacts the desktop auto-update flow relies on, so
# a missing one silently breaks every user's update path.
SIGNED=0
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    SIGNED=1
    echo "  (TAURI_SIGNING_PRIVATE_KEY is set — also probing updater payloads)"
else
    echo "  ⚠ TAURI_SIGNING_PRIVATE_KEY not set — bundles are unsigned; updater payloads NOT probed"
    echo "    (export TAURI_SIGNING_PRIVATE_KEY + _PASSWORD before running to verify the auto-update path)"
fi

probe() {
    local label="$1" pattern="$2"
    local found
    # shellcheck disable=SC2086
    found="$(find $pattern -type f 2>/dev/null | head -1)"
    if [ -n "$found" ]; then
        printf '  ✓ %s\n' "$label"
        return 0
    else
        printf '  ✗ %s NOT found (pattern: %s)\n' "$label" "$pattern"
        return 1
    fi
}

case "$OS" in
    Linux)
        echo "→ probing Linux bundle artifacts"
        FAIL=0
        probe '.AppImage' 'src-tauri/target/release/bundle/appimage/*.AppImage' || FAIL=$((FAIL + 1))
        probe '.deb' 'src-tauri/target/release/bundle/deb/*.deb' || FAIL=$((FAIL + 1))
        if [ "$SIGNED" = "1" ]; then
            probe '.AppImage.tar.gz (updater payload)' \
                'src-tauri/target/release/bundle/appimage/*.AppImage.tar.gz' || FAIL=$((FAIL + 1))
        fi
        [ "$FAIL" -eq 0 ] || { echo "✗ $FAIL Linux artifact(s) missing"; exit 1; }

        # AppImage icon fix is part of release.yml's Linux path.
        if [ -x scripts/fix-appimage-icons.sh ]; then
            echo "→ running fix-appimage-icons.sh"
            FIX_APPIMAGE_STRICT=1 bash scripts/fix-appimage-icons.sh || {
                echo "✗ fix-appimage-icons.sh failed (would block CI per FIX_APPIMAGE_STRICT)"
                exit 1
            }
            echo "  ✓ AppImage icons OK"
        fi
        ;;
    Darwin)
        echo "→ probing macOS bundle artifacts"
        FAIL=0
        probe '.dmg' 'src-tauri/target/release/bundle/dmg/*.dmg' || FAIL=$((FAIL + 1))
        probe '.app' 'src-tauri/target/release/bundle/macos/*.app' || FAIL=$((FAIL + 1))
        if [ "$SIGNED" = "1" ]; then
            probe '.app.tar.gz (updater payload)' \
                'src-tauri/target/release/bundle/macos/*.app.tar.gz' || FAIL=$((FAIL + 1))
        fi
        [ "$FAIL" -eq 0 ] || { echo "✗ $FAIL macOS artifact(s) missing"; exit 1; }
        ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
        echo "→ probing Windows bundle artifacts"
        FAIL=0
        probe '.msi' 'src-tauri/target/release/bundle/msi/*.msi' || FAIL=$((FAIL + 1))
        probe '.exe (NSIS)' 'src-tauri/target/release/bundle/nsis/*.exe' || FAIL=$((FAIL + 1))
        if [ "$SIGNED" = "1" ]; then
            probe '.msi.zip (updater payload)' \
                'src-tauri/target/release/bundle/msi/*.msi.zip' || FAIL=$((FAIL + 1))
            probe '.exe.zip (NSIS updater payload)' \
                'src-tauri/target/release/bundle/nsis/*.exe.zip' || FAIL=$((FAIL + 1))
        fi
        [ "$FAIL" -eq 0 ] || { echo "✗ $FAIL Windows artifact(s) missing"; exit 1; }
        ;;
    *)
        echo "⚠ unknown OS '$OS'; bundle-path probes skipped"
        ;;
esac

echo ""
echo "✓ Release build verification PASSED (local OS only)."
echo "  Cross-OS slots (the other platforms in release.yml's matrix) still need a CI run."
echo "  Tag-and-push next: scripts/bump-version.sh <new-version> --commit --tag --push"
