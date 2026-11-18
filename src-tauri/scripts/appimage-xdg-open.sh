#!/bin/sh
# The AppImage's usr/bin/xdg-open (tauri.conf.json, bundle.linux.appimage.files).
# The AppImage puts usr/bin first on PATH, so the opener plugin starts this
# rather than the host's xdg-open (#6871).
#
# The AppImage points LD_LIBRARY_PATH, GIO_MODULE_DIR and more into the bundle
# for the app, and a host program started with them loads the bundle's GLib and
# OpenSSL: on a host with a newer GLib, gio and flatpak exit before the browser
# opens. This drops every entry under $APPDIR from every variable, removes a
# variable left empty, then runs the host's launcher in the opener plugin's
# order (the `open` crate's).
set -f
appdir=${APPDIR:-$(cd "$(dirname "$0")/../.." && pwd)}
appdir=${appdir%/}
for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
  value=
  eval "value=\${$name-}"
  case ":$value:" in
    *":$appdir:"* | *":$appdir/"*) ;;
    *) continue ;;
  esac
  kept=
  IFS=:
  for entry in $value; do
    case $entry in
      '' | "$appdir" | "$appdir"/*) ;;
      *) kept=${kept:+$kept:}$entry ;;
    esac
  done
  unset IFS
  if [ -n "$kept" ]; then
    export "$name=$kept"
  else
    unset "$name"
  fi
done
if command -v xdg-open >/dev/null 2>&1; then exec xdg-open "$@"; fi
if command -v gio >/dev/null 2>&1; then exec gio open "$@"; fi
if command -v gnome-open >/dev/null 2>&1; then exec gnome-open "$@"; fi
exec kde-open "$@"
