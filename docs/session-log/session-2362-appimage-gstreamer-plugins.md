# Session 2362 — The AppImage carries its GStreamer plugins, so it finds the camera

#5718: the AppImage's QR scanner found no camera. The AppImage shipped the
GStreamer core without plugins, and its `AppRun` pointed GStreamer at the
empty bundled plugin directory, so WebKitGTK saw zero capture devices. The
maintainer approved bundling once session 2354 confirmed the cause.

**Change.**
- `bundle.linux.appimage.bundleMediaFramework: true`. tauri-bundler then runs
  linuxdeploy's gstreamer plugin, which copies the build machine's whole
  plugin directory and the scanner helpers. `libpipewire` stays on the
  host, by linuxdeploy's excludelist.
- The machines that build the AppImage install `gstreamer1.0-plugins-base`,
  `-plugins-good`, `-pipewire` and `-gl` (WebKit draws video through
  `glupload`).
- `scripts/check-appimage-media-plugins.sh` fails closed, in `ci.yml` and
  `release.yml`, when the AppDir lacks the plugin directory or `pipewire`,
  `app`, `video4linux2` or `pulseaudio`. It failed on the old AppDir, and on
  a build with the flag off.
- `BUILD.md`: the AppImage carries its plugins, and the `.deb` needs the
  host's `gstreamer1.0-pipewire`, which it doesn't declare.

**Measured on a local release build:**
- Size: +11.4 MB (+10.9%) against the same binary with the flag off.
- Boot: unchanged within noise (22 interleaved boots each). GStreamer starts
  only on first media use, when rebuilding its registry from cold costs
  about 0.5 s.
- In an isolated session with the host's PipeWire socket, the scanner played
  a live preview from the built-in camera. The old AppImage reproduced the
  maintainer's error.

**Not fixed here: voice notes still cannot record on Linux.** WebKitGTK
2.52's `MediaRecorder` needs `uritranscodebin` from plugins-bad. On
GStreamer older than 1.24.9 (Ubuntu 24.04 has 1.24.2) it refuses webm and
ogg, which leaves MP4 with a high-ranked AAC encoder. A test with those
added still produced an empty recording. Tracked in #5730.
