#!/usr/bin/env bash
# Run one real-backend spec locally: `just e2e-real e2e-tauri/<file>.e2e.ts`.
#
# `wdio.conf.ts`'s `onPrepare` builds the app and its sidecars in one compile,
# then the spec runs under Xvfb with a window manager, without which
# `document.hasFocus()` stays false and `waitForAppReady` fails (#5457).
# WAYLAND_DISPLAY is dropped because `xvfb-run` sets only DISPLAY, and GTK would
# otherwise open the app on the desktop session.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 e2e-tauri/<file>.e2e.ts" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
spec=$1
if [[ ! -f $spec ]]; then
  echo "error: no spec at $spec (paths are relative to the repo root)" >&2
  exit 2
fi

missing=()
driver=${TAURI_DRIVER_PATH:-$HOME/.cargo/bin/tauri-driver}
[[ -x $driver ]] || missing+=("tauri-driver at $driver (cargo install tauri-driver --locked)")
for pair in WebKitWebDriver:webkit2gtk-driver xvfb-run:xvfb openbox:openbox dbus-run-session:dbus-daemon; do
  command -v "${pair%%:*}" >/dev/null || missing+=("${pair%%:*} (apt package ${pair#*:})")
done
if ((${#missing[@]} > 0)); then
  printf 'error: missing %s\n' "${missing[@]}" >&2
  exit 1
fi

# shellcheck disable=SC2016 # "$1" expands in the inner bash, which gets the spec as $1.
exec env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a dbus-run-session -- \
  bash -c 'openbox & npm run test:e2e-tauri -- --spec "$1"' _ "$spec"
