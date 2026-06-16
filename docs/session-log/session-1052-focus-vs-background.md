# Session 1052 — #704: distinguish focus-loss from backgrounded for maintenance gating

2026-06-16. `/loop /batch-issues` run (backlog).

## Bug
The shell flipped a single `is_foreground` flag on EVERY `WindowEvent::Focused(false)`.
Maintenance jobs (`wal_checkpoint_truncate`, `op_log_compact`, `tombstone_purge`,
`loro_snapshot_if_dirty`) gate on `!is_foreground`; the sync daemon's periodic resync tick
and the materializer metrics task gate on `is_backgrounded()`. So plain focus-loss
(clicking another window while the app stays on-screen) wrongly fired backgrounded-only
maintenance mid-edit and starved periodic sync.

## Fix
`derive_app_state(WindowStateFlags) -> AppState` (lifecycle.rs): `Background` iff
`os_suspended || !visible || minimized`; `focused` is deliberately unused — focus-loss
alone never backgrounds. On desktop, `Focused(false)` now queries live
`window.is_visible()`/`is_minimized()` to detect a real minimize/hide; mobile
`Suspended`/`Resumed` (Android onPause/onResume, iOS resign/enter) map directly
(`#[cfg(mobile)]`). `LifecycleHooks::apply_state` routes the enum to the existing
mark methods, so the decision lives in one tested place.

## Verification
9 unit tests incl. the core case (focus-lost-but-visible → Foreground) + minimized/hidden/
os-suspended → Background + apply_state not starving the daemon. Reviewer ran the full Rust
suite (4186 passed) + clippy clean; verdict SOUND. The benign Linux/GTK
`Focused`-vs-`is_minimized` signal-ordering nuance is documented — self-correcting and
conservative (never falsely backgrounds while the user is looking; mobile uses the
authoritative `Suspended` event).
