# Session 2547 — maintenance jobs run on every tick (#5741)

**Found:** while the due-reminder spec ran on the real backend
(`e2e-tauri/reminder-due-task.e2e.ts`, #5835), a 60 s maintenance job ran
only every 120 s. Reminders dispatched at 06:53:55 and 06:55:55, with
nothing at 06:54:55, so a due reminder could come up to two minutes late.

**Cause:**
- `run_tick` decided whether a job was due from `Instant::now()` at the
  tick's start, but on success stamped `last_run` with `Instant::now()`
  after the job finished.
- The next tick fires one `TICK_INTERVAL` after the previous tick's
  scheduled time, so a 60 s job saw less than 60 s elapsed and skipped.
- Longer jobs (1 h, 4 h, 24 h) slipped one extra tick per period.

**Fix:**
- `spawn_daemon` passes the instant `Interval::tick()` returns, which is the
  tick's scheduled deadline, to `run_tick_at`. That function decides due-ness
  from it and stamps it.
- Stamping `Instant::now()` at the tick's start would not do: wake latency
  varies, so the gap falls under 60 s whenever a tick wakes earlier than the
  one before.
- The #3311 rule is unchanged: no stamp on failure.

**After a stall,** missed ticks burst with their own past instants. A 60 s
job then runs once per missed tick. All three such jobs are idempotent:
- the reminders have an at-most-once ledger;
- the projected-agenda refresh does nothing within the same day;
- the Loro snapshot is skipped once clean.

**Test:** `run_tick_runs_a_tick_interval_job_on_every_tick`, on paused
tokio time.
- A 60 s job that takes 1 s, on a tick that wakes 5 ms late, is stamped with
  the scheduled instant.
- It runs again exactly one `TICK_INTERVAL` later.

**Shown red:**
- stamping `Instant::now()` after the job fails the stamp assertion by
  1.005 s;
- stamping `Instant::now()` at the tick's start fails it by 5 ms.

**Also:**
- The test-only `run_tick` shim is gone; its callers use `run_tick_at`.
- The reminder spec's header and timeout comment now describe the 60 s
  cadence.

**Ran:**
- nextest over the maintenance, reminder and first-tick tests (37 passed);
- clippy over the workspace, `cargo fmt --check`,
  `SQLX_OFFLINE=true cargo check`;
- the reminder spec on a rebuilt binary: 2 m 5 s, down from about 3 m.
  Its two dispatches were 60 s apart.
