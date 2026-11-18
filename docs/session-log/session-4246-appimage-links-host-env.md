# Session 4246 — links open from the AppImage on a newer host

#6871: links did not open from the 0.24.0 AppImage on Fedora 44 (Bluefin), and the maintainer could not reproduce it on Ubuntu 24.04.

**Cause.** The AppImage's inner launcher (`AppRun.wrapped`, AppImageKit's) sets `LD_LIBRARY_PATH` to the bundle's `usr/lib`. The linuxdeploy hooks set `GIO_MODULE_DIR`, `GSETTINGS_SCHEMA_DIR` and more. The opener plugin's `xdg-open` inherits all of it.

- The bundle carries the build host's GLib 2.80 and OpenSSL 3.0, which are Ubuntu 24.04's own, so nothing breaks there.
- On Fedora 44, the host `gio` needs `g_unix_mount_entry_*` (GLib 2.84) and is linked `BIND_NOW`, so it dies at load.
- `xdg-open`'s fallback runs the browser's `.desktop` line, `flatpak run …`, whose `libostree` needs `OPENSSL_3.4.0`.
- The plugin's detached spawn never reads the launcher's exit status, and `openUrl` dropped the plugin's error on desktop, so nothing reached the log.

**Fix.** The maintainer wants the opener plugin to stay the way links and folders open.

- **Wrapper:** the plugin cannot be handed an environment, so the AppImage now ships `src-tauri/scripts/appimage-xdg-open.sh` as `usr/bin/xdg-open` (`bundle.linux.appimage.files`). `AppRun` already puts `usr/bin` first on `PATH`, so the plugin's `open::that_detached` starts the wrapper.
- **What the wrapper does:** it drops every entry under `$APPDIR` from every variable, removes a variable left empty, and runs the host's launcher in the `open` crate's order (xdg-open, gio, gnome-open, kde-open).
- **Logging:** `openUrl` logs the plugin's refusal before its `window.open` fallback.
- **Cache refresh:** the AppImage cache refresh (`update-desktop-database`, `gtk-update-icon-cache`) runs with the same environment (`appimage_integration::host_env`) and logs a failed or missing tool. Before, it threw both away.

**Traps:**

- A first build replaced the plugin on Linux with an app-side launcher, a new `open_external_url` command and the `open` crate. The maintainer asked for the plugin instead.
  - Adding `open` to `Cargo.lock` also tripped the pre-commit `cargo deny` hook on RUSTSEC-2026-0543 (chrono unmaintained), a new advisory that fails any commit touching the lockfile. #6877 waives it.
- The launcher's exit status is still not logged: the plugin spawns it detached.
- The app cannot drop the variables for itself: WebKit's helper processes load the bundle's libraries through them.
- A wrapper that leaves its own dir on `PATH` finds itself as `xdg-open` and re-execs forever, so the unit test spawns it with a timeout.
- `bundle.linux.appimage.files` goes through `fs_utils::copy_file` / `copy_dir` (`fs::copy`), which keeps the exec bit. A wrapper without it would be passed over on `PATH`.
- `open` 5.4.5 states it will not rewrite an AppImage environment; `tauri-plugin-opener` 2.7.3 does nothing about it either.

## What ran

- **Reproduced** on the released 0.24.0 AppImage, unpacked into a Fedora 44 base-image chroot with the env `AppRun` produces:
  - `gio open` exits 127 on `undefined symbol: g_unix_mount_entry_get_options`, and reaches the stand-in browser in a clean env.
  - `ldd` resolves `libostree` against the bundle's `libcrypto` and reports `OPENSSL_3.4.0` not found.
- **`scripts/appimage-xdg-open.test.mjs`** (node:test, added to the lint job's list) runs the wrapper from a bundle's `usr/bin` with the `AppRun` env shape. It was falsified four ways:
  - no stripping
  - a string-prefix match instead of a path component
  - `$*` for `"$@"`
  - no `gio` fallback
- **e2e-tauri** `appimage-launcher-env.e2e.ts`: wdio.conf.ts stages the wrapper as the app's first `xdg-open`, with a recording stand-in for the host's behind it. It checks the Token reference link and Settings › Data › Open folder, both through the plugin.
  - It passes on the fix.
  - It fails on both cases with the wrapper not stripping, and with the wrapper's exec bit cleared.
  - Locally, `just e2e-real` fails before the spec, in `npm run build` inside WDIO's process (`define_import_meta_default.resolve is not a function` from `@vitejs/plugin-react`'s compiler preset), while `npm run build` in a plain shell passes. I built the app with the harness's own `npm run tauri -- build …` command and ran with `WDIO_SKIP_TAURI_BUILD=1`, as CI does.
- **Static checks:** workspace clippy (`-D warnings`), rustfmt, shellcheck, shfmt, typecheck, knip and oxlint.
- **Rust:** the `appimage_integration` tests. Bundle entries kept, string prefix, and the cache tool's warning demoted to trace each went red.
- **Frontend:** `open-url.test.ts`; dropping the warning turns its refusal cases red.
