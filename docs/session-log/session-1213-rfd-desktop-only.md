# Session 1213 — Make rfd desktop-only to unbreak the Android release build (#3072)

## Issue
#3072 — The 0.9.0 release build failed: `android-build-and-release` could not compile
`rfd 0.17.2` for `aarch64-linux-android` (`rfd` has no Android backend; its
`FileSaveDialogImpl`/`MessageDialogImpl` traits are unimplemented there). `rfd` was added
for the native, webview-independent fatal-error dialog (#2972 / #2919) as an
**unconditional** dependency, and the Android APK build only runs in the *release*
workflow (not PR/`validate` CI), so the regression surfaced only at release time.

## What shipped
`rfd` and its single use site are now desktop-only, removing it from the
`aarch64-linux-android` dependency graph while preserving desktop behavior byte-for-byte.

## Implementation
- `src-tauri/Cargo.toml`: removed the unconditional `rfd = { version = "0.17",
  default-features = false, features = ["gtk3"] }` from `[dependencies]` and moved it,
  verbatim, into the pre-existing
  `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]` table.
  No duplicate declaration or table.
- `src-tauri/src/lib.rs` — `show_fatal_error_dialog`: split the former single
  `#[cfg(not(test))]` block into two mutually-exclusive, exhaustive arms:
  - `#[cfg(all(not(test), any(target_os = "android", target_os = "ios")))]` → logs
    `tracing::error!` and consumes `title`/`body` (mobile surfaces fatal errors through the
    platform; there is no desktop dialog surface).
  - `#[cfg(all(not(test), not(any(target_os = "android", target_os = "ios"))))]` → the
    original desktop logic **verbatim** (Linux `DISPLAY`/`WAYLAND_DISPLAY` `no_display`
    check, the `headless` CI/`AGARIC_HEADLESS`/no-display early-return, then the
    `rfd::MessageDialog` call). The `#[cfg(test)]` no-op arm is unchanged.

## Verification
Independent adversarial review confirmed: rfd removed from `[dependencies]` and declared
exactly once in the desktop-only target table (features preserved); the three cfg arms
partition all targets with no gap/overlap; the desktop branch is byte-for-byte identical to
`origin/main` (extracted-and-`diff`ed); `cargo tree -i rfd` shows rfd present on the desktop
host and `cargo tree --target aarch64-linux-android | grep -c rfd` = **0** (absent from the
android graph); desktop `cargo check -p agaric --lib` is clean. The residual
`aarch64-linux-android` `cargo check` failure is purely environmental — `aws-lc-sys`'s
build script needs the Android NDK C compiler (`aarch64-linux-android-clang`), absent in the
dev env but present in CI — with **zero** rfd-related errors.

## Follow-up (documented in #3072, not fixed here)
`generate-latest-json` also failed in the same release run, but on its post-upload
smoke-assert re-download ("platforms incomplete"), not the manifest: the uploaded
`latest.json` is complete and correct (all 9 platform keys, valid signatures + asset URLs) —
a GitHub release-asset eventual-consistency flake on the re-download. Desktop auto-update is
unaffected. A short retry/backoff around the smoke-assert `gh release download` would harden
it.

## Note
This fix is **not** in the tagged 0.9.0 build. Re-cutting 0.9.0 (or shipping desktop-only
and folding this into 0.9.1) is a maintainer decision; the fix is ready either way.
