# Session 1916 — 0.15.0 aborts on every Android launch

0.15.0 crashes on Android. Nobody had a logcat, so the cause came from
diffing what changed for Android between 0.14.0 and 0.15.0.

## Cause

The Tauri 2.12 bump (`992ede69`) took tao from 0.35.2 to 0.37.1. tao 0.37
calls `ndk_context::initialize_android_context` in its `onCreate` JNI
binding, which `WryActivity.onCreate` reaches through `Rust.onCreate(this)`.
Since #3848, Agaric's own `JNI_OnLoad` (`agaric_sync::android_context::jni_on_load`)
had already made that call when `System.loadLibrary("agaric_lib")` ran,
which happens earlier. `ndk-context` 0.1.1 asserts that the context was
never set (`assert!(previous.is_none())`), so the second call panics, and
`panic = "abort"` turns that into a SIGABRT before the first frame. Every
launch fails.

session-1299 says nothing in the process ever calls
`initialize_android_context`, and `android_context.rs` said "Tauri installs
neither". Both were true of tao 0.35 and stopped being true with tao 0.37.

The other Android-facing change in 0.15.0, routing emits through the main
thread (#5320), is not a second cause. On Android, Tauri compiles out the
blocking `tracing` eval (`not(target_os = "android")` in
`tauri-runtime-wry`), so the change only queues emits there.

## Shipped

- `jni_on_load` still records the `JavaVM` and Application handles for
  `require()`, which the multicast lock and the network-block monitor use,
  but no longer passes them to `ndk_context`. tao owns that global now and
  installs it before `main` runs any of our code.
- `agaric-sync` drops its `ndk-context` dependency and the matching
  cargo-machete allowlist entry. Nothing calls it any more, and with the
  dependency gone the duplicate install cannot come back without a compile
  error.
- Comments that still called our install the fix, or said iroh read our
  handles, are corrected.

## Verified

- `cargo clippy --target aarch64-linux-android --lib -- -D warnings` is clean
  for `agaric-sync` and for the app crate (NDK r27c, the version CI uses).
- Falsified on a copy: putting the `initialize_android_context` call back
  fails the Android build with `cannot find module or crate ndk_context`.
  The copy was restored and `cmp` confirmed it.
- `cargo test -p agaric-sync --lib android_`: 19 passed.
- Not run on a device or emulator, since the container has neither. The crash
  is Android-only, so an `e2e-tauri/` spec on the desktop backend cannot
  exercise it. The compile-time guard above is the regression protection.
