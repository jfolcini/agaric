# Session 1041 — audit fix #1255: surface boot op-log replay failure to the user

2026-06-16. From the 2026-06 Opus quality audit (robustness). `/loop /batch-issues` run.

## Bug
`recover_at_boot` (`src-tauri/src/recovery/boot.rs`) catches a wholesale replay error
(corrupted op_log, stuck foreground queue, the #412 multi-device hard-abort) into a
`ReplayReport` with `replay_errors`, then boot continues — but that report was only
logged at `info`/`warn` and **never surfaced to the frontend**. The user edited a
stale/incomplete materialized view with zero indication.

## Fix (reused the existing event + backfill-command pattern)
- Backend: `RecoveryReport::replay_failed()` / `RecoveryStatus`; boot emits a durable
  `recovery:degraded` Tauri event, stores the status in managed state, and logs at
  `error`. New `get_recovery_status` command lets a late-mounting webview backfill (boot
  emits before the listener registers). App still boots (op_log is canonical).
- Frontend: `useRecoveryStatus` hook (live event + mount backfill, deduped) shows a
  persistent warning toast via the existing `notify` primitive; wired into `App.tsx`.
- specta bindings regenerated (trim-clean, `ts_bindings_up_to_date` passes); no SQL change.

## Verification
Rust: `wholesale_replay_failure_surfaces_degraded_signal` (drives the #412 abort, asserts
`degraded` true — the signal, not a log) + `healthy_boot_is_not_degraded` + command
round-trip. Frontend: 11 hook tests (live event, mount backfill, malformed-payload guard,
dedup, browser no-op). Reviewer caught + fixed a tsc error and a missing tauri-mock
handler (handlers-drift guard), removed a dead i18n key. Full Rust 4171 passed; full
frontend 12732 passed; tsc/oxlint/clippy clean.
