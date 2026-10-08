# Session 1920 — review notes from #5338

Follow-up for the sweep that merged #5338 (session 1916, the Android
launch abort). It takes the reviewer's two non-blocking notes.

## Shipped

- `src-tauri/unsafe-allowlist.txt` said `android_context.rs` calls
  `ndk_context::initialize_android_context`. Since #5338 the only `unsafe`
  left there is `JavaVM::from_raw`, so the entry now says that.
- `src-tauri/Cargo.toml` had two comments recounting which Android deps
  moved to `agaric-sync` in #2621, and both still named `ndk-context`,
  which `agaric-sync` no longer has. Both described code that is gone, so
  they are deleted rather than reworded. Each remaining cargo-machete entry
  already carries its own reason.

## Verified

- `prek run` on the changed files passes, including `cargo machete`.
- Comment-only change; nothing else was run.
