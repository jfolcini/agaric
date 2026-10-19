# Session 2667 — the real-backend reminder spec runs at any hour, in one scheduler minute

`e2e-tauri/reminder-due-task.e2e.ts` (#5908) refused to run within 15 minutes
of local midnight, which failed PR #5919's real-backend shard at about
23:50 UTC, and took 2–3 minutes.

- **Midnight:** the reminder job counts a task as due today by the local date
  at the moment it runs, once a minute. The spec set the reminder for the next
  minute but always made the task due today, so near midnight the run that
  fired could already be on the new date and skip the task; the guard hid
  that. The guard is gone: the reminder is the current minute and the task is
  due on that minute's date, typed as `YYYY-MM-DD`; with under two minutes to
  midnight the spec sets the reminder for midnight and the task due tomorrow.
  Using the run's own local date is right for the product; no bug there.
- **Slow:** the time was waiting for scheduler runs, the first 60 s after
  launch. A reminder set for the current minute fires on that first run, and
  the third test's second wait is gone: "a later run doesn't notify the first
  task again" is the Rust test `fires_exactly_once_across_two_ticks` in
  `reminders.rs`, which the header now names. The spec takes about 1:26, the
  one real scheduler minute it exists to prove.

Shown red under `libfaketime` at 23:59:15: the old spec refused to run, the old
spec without its guard timed out with no notification (the hidden bug), and
the new spec with its midnight margin set to 0 timed out the same way; the new
spec passed, notifying at 00:00:43, and passed again launched at 23:56:30.

Ran: `just e2e-real e2e-tauri/reminder-due-task.e2e.ts`,
`tsc -p tsconfig.wdio.json`, `oxlint e2e-tauri`, `vitest run e2e-tauri` (46).
