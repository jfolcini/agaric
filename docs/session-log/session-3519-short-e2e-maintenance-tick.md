# Session 3519 — reminder-due-task waits on a short daemon tick

Goal: `e2e-tauri/reminder-due-task.e2e.ts` was the slowest real-backend spec because it waited on the maintenance daemon's real 60 s tick. The maintainer accepted a tick override in the e2e build only.

Decisions:

- The override reuses the switch the e2e build already sets for test-only behaviour, `AGARIC_E2E_SANDBOX` (`app_paths::sandboxed()`, also what enables WebKit's mock capture devices). No new env var or cargo feature. `maintenance::tick_interval()` returns 5 s under it and `TICK_INTERVAL` (60 s) otherwise; a user build never sets the variable.
- `reminders_tick`'s own job interval is `tick_interval()` rather than a literal 60 s. With a short tick alone the job would still run only once a minute, so the spec would still wait up to 60 s.
- Under the sandbox every job's first run moves from boot + 60 s to boot + 5 s. The daily and hourly jobs keep their own intervals, and the 60 s jobs stay on the 5 s grid.

Verification: the spec was shown red by breaking the reminder logic rather than the wait (`fire_due_reminders` looked up tomorrow's tasks): the Notify wait timed out. Timings come from `scripts/e2e-tauri-local.sh` (what `just e2e-real` runs) and are in the PR body.
