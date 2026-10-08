# Session 1921 — review notes from #5338

The sweep after #5338 (stop the duplicate `ndk_context` install that aborted
0.15.0 on Android at launch) merged it with two non-blocking reviewer notes,
both about comments that still described the deleted install:

- `src-tauri/unsafe-allowlist.txt` said `android_context.rs` calls
  `ndk_context::initialize_android_context` and that skipping it aborts. The
  only `unsafe` left there is `JavaVM::from_raw`; the entry now says the file
  records the handles for `require()` and that the global is tao's to install.
- `src-tauri/Cargo.toml` listed `ndk-context` among the deps that moved to
  `agaric-sync` in two comments; `agaric-sync` no longer depends on it. Both
  now name only `jni`.

Comment-only; no requirement changed, so neither lockfile moves. Verified by
CI on the PR.
