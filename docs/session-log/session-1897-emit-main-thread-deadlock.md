# Session 1897 — background events no longer freeze the app

The maintainer's installed 0.14.0 AppImage froze for good after an agent wrote
a 31-block page over the MCP RW socket in 140 ms. The session diagnosed the
live hang, then fixed it.

## The bug

- **Diagnosis from the hung process.** The main thread was parked on a futex
  inside a WebKit custom-protocol callback. Mapping the stripped frames through
  their panic-location strings put it in `tauri/src/ipc/protocol.rs` →
  `get_webview` → `webviews_lock()`. The one tokio worker that was not idle was
  in `mcp/tools_rw.rs` → `AppManager::emit` → `emit_js` → wry `eval_script` →
  a std channel `recv()`.
- **The mechanism.** The `tracing` feature on `tauri` (#2110) makes
  tauri-runtime-wry's `eval_script` a `getter!`: it blocks until the main
  thread has run the script. `AppManager::emit` holds `webviews_lock()` across
  `emit_js`, so an emit from any non-main thread waits on the main thread while
  holding a lock that the main thread's IPC handler takes. Tauri 2.12.1 still
  has both halves. `Channel::send` reaches the same blocking `eval`.

## The fix

- `src-tauri/src/main_thread.rs`: `emit`, `emit_with` and `UiChannel` run
  every emit and channel send through `AppHandle::run_on_main_thread`, where
  `eval` runs inline. The task runs inside the caller's span, so Tauri's
  `app::emit` / `emit::run` spans stay in the caller's trace.
- All seven `emit` sites and both channels (sync progress, import progress)
  moved over. The MCP activity warning keeps its `tool` field and the
  recovery-degraded failure stays at `error`, through `emit_with`.
- `src-tauri/clippy.toml` bans `Emitter::emit*` and `Channel::send`, so CI
  blocks a direct call. That is the blocking pair for the e2e spec.

## Verified

- **Unit, red then green.**
  `view_notify::tests::blocks_changed_from_a_worker_thread_is_emitted_on_the_main_thread`
  failed before the fix: the emit ran on the worker (`ThreadId(4)`), not the
  mock main thread (`ThreadId(3)`). The six `main_thread` tests cover
  main-thread delivery for emits and sends, `emit_with`'s handler, both failure
  paths and span parentage. Each was falsified on a copy (inline `run`,
  dropped `on_error`, `expect` on the failure paths, a send without the span)
  and went red.
- **Lint.** A direct `self.handle.emit(...)` in `view_notify.rs` fails
  `cargo clippy --workspace --all-targets -- -D warnings` with
  `disallowed_methods`. The two `#[expect]`s in the helper also prove the paths
  resolve.
- **e2e-tauri, run locally.** `mcp-write-burst-responsive.e2e.ts` uses four
  MCP connections × 50 `update_block_content` writes plus eight webview
  `invoke` loops.
  - Tauri 2.11.6: the unfixed binary froze 3/3 (main thread in
    `futex_do_wait`) and the fixed one passed 5/5. Three earlier fixed-binary
    runs failed on the spec itself: it expected the last of a block's
    pipelined writes to land last, which the server does not promise.
  - After rebasing onto Tauri 2.12: the fixed binary passed 2/2, and a build
    with `run` made inline (the pre-fix behavior) froze.
  - A first version that only reloaded the open page passed on the unfixed
    binary, so the spec adds concurrent IPC and connections.
- **Suites on the rebased branch.**
  - clippy clean.
  - `cargo nextest run --workspace`: 6700 of 6701 passed. One run of
    `conformance_fixtures_match_backend` hit its 60 s limit under full-suite
    load; it passes alone in 26.6 s and drives `*_inner` functions with no
    emits.
  - The commit's pre-commit hooks passed.
