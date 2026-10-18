#!/usr/bin/env bash
# Fail when an AppImage's AppDir lacks the GStreamer plugins WebKitGTK captures
# the camera and microphone through (#5718): pipewiresrc and v4l2src for the
# camera, pulsesrc for the microphone, appsink to hand WebKit the frames. Voice
# notes also need opusenc, which WebCodecs' AudioEncoder('opus') runs on, and
# opusdec with oggdemux to play the Ogg file back (#5730).
# `bundleMediaFramework` copies the build machine's plugin directory, and the
# AppImage reads only its own, so a build machine without these packages ships
# an AppImage that finds no device.
#
# Usage: scripts/check-appimage-media-plugins.sh path/to/Agaric.AppDir
set -euo pipefail

appdir="${1:?usage: $0 path/to/Agaric.AppDir}"
plugins="$appdir/usr/lib/gstreamer-1.0"

if [ ! -d "$plugins" ]; then
  echo "ERROR: $plugins does not exist, so the AppImage bundles no GStreamer plugins (#5718)." >&2
  echo "  Fix: set bundle.linux.appimage.bundleMediaFramework in src-tauri/tauri.conf.json." >&2
  exit 1
fi

missing=0
for entry in \
  libgstpipewire.so:gstreamer1.0-pipewire \
  libgstapp.so:gstreamer1.0-plugins-base \
  libgstvideo4linux2.so:gstreamer1.0-plugins-good \
  libgstpulseaudio.so:gstreamer1.0-plugins-good \
  libgstopus.so:gstreamer1.0-plugins-base \
  libgstogg.so:gstreamer1.0-plugins-base; do
  file="${entry%%:*}"
  package="${entry#*:}"
  if [ ! -f "$plugins/$file" ]; then
    echo "ERROR: $plugins/$file is missing (#5718)." >&2
    echo "  Fix: install $package on the machine that builds the AppImage." >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi
echo "OK: the AppImage bundles the camera, microphone and voice note plugins."
