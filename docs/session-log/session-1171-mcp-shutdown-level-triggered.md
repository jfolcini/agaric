# Session 1171 — MCP shutdown wake made level-triggered (#2824)

## Scope

`McpLifecycle::shutdown()` woke the serve/accept loops via
`disconnect_signal.notify_waiters()` — **edge-triggered**, storing no permit. A
shutdown firing while a loop was mid-FFI (not parked in its `select!` arm) was
lost; the loop stayed blocked in `accept()`/`connect()` or its backoff `sleep`
(≤30s cap) until an unrelated event unblocked it, before the top-of-loop
`lifecycle_disabled` gate observed `enabled=false`. Bounded robustness debt
(self-healing, no data loss), flagged by two reviewers in the #2719–#2728 MCP
hardening batch.

## Change

Added a dedicated **level-triggered** wake channel:
`McpLifecycle::shutdown_signal: Arc<tokio::sync::watch::Sender<bool>>`
(`false` = no shutdown pending).

- `shutdown()` calls `shutdown_signal.send_replace(true)` (level wake) and
  **keeps** `disconnect_signal.notify_waiters()` (the per-connection in-flight
  kick — `run_connection`'s disconnect_all grace path is unchanged).
- New helper `shutdown_requested(rx)` — `borrow_and_update()` at subscribe
  (returns immediately if a shutdown fired **before** the loop parked — the exact
  missed-wakeup window) then `changed().await`; sender-dropped treated as
  shutdown (unreachable during a live loop, which holds the `Arc<Sender>`).
- The 5 accept/backoff `select!` arms (serve_unix accept + backoff; serve_pipe
  connect + backoff + #2727 successor-create backoff) now await
  `shutdown_requested(lc.shutdown_signal.subscribe())` instead of
  `disconnect_signal.notified()`.
- Both `spawn_mcp_ro_task_with_registry` / `spawn_mcp_rw_task_with_registry`
  reset `shutdown_signal` to `false` alongside `enabled.store(true)` **before
  bind**, so a prior shutdown's level doesn't tear down the fresh loop.

**Why `watch`, not `Notify::notify_one`:** the `McpLifecycle` (and its signal
`Arc`) is reused across enable/disable cycles; a `notify_one` permit left
unconsumed by a mid-FFI shutdown could linger and, on re-enable, win a `select!`
against a real `accept()` and drop that connection. `watch` carries the true
level, resets cleanly, and is multi-consumer-safe.

Closes the missed-wakeup window, so #2721's 2s `await_accept_loop_exit` cap is
reliably reached (disable observable even mid-FFI).

## Tests

Three deterministic primitive tests (no OS accept-timing dependence):
`shutdown_requested_returns_immediately_when_signalled_before_park_2824` (fires
shutdown *before* subscribe — the pre-park window; can't pass without the fix),
`shutdown_requested_parks_until_shutdown_fires_2824`,
`shutdown_signal_reset_clears_level_across_reenable_2824`. The hand-driven
`re_enable_rebinds_listener_after_shutdown` test updated to reset the level.

## Review

Independent adversarial deep review (Opus): level-triggered correctness,
sender-never-dropped, all 5 arms replaced, `run_connection` correctly untouched,
reset-on-reenable ordering, and #2721 interaction all confirmed; no missed-wakeup
race. Full suite 3460 passed / 0 failed / 6 skipped; clippy `-D warnings` clean;
no `.sqlx` delta. Re-verified after rebasing onto the overlapping #2826 MCP
toggle-race hardening: check + clippy + 442 targeted tests green.

Note: the Windows `serve_pipe` arms (`#[cfg(windows)]`) are a character-identical
mirror of the verified `serve_unix` substitution; CI's Windows leg compiles them.

Closes #2824.
