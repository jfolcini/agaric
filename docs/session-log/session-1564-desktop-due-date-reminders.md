# Session 1564 — desktop due-date reminders (#4554, first slice)

Agaric could fire an OS notification but had never fired one for a task: the only production caller of `notify_task` was the Settings "send test notification" button, and the tab admitted as much in a "not available yet" notice. #4554's narrowed scope (maintainer comment, 2026-09-02) asks for the desktop-only first slice: a `MaintenanceJob` on the existing 60 s tick that finds open tasks due today, fires them through `notify_task_inner` at a single global reminder time, and records each fire in an `app_settings` ledger so neither a tick nor a restart notifies twice.

That is what shipped. `src-tauri/src/reminders.rs` holds the whole decision: `due_tasks` selects live blocks with `due_date = today` that are not `DONE` / `CANCELLED` (a dated block with no `todo_state` counts, as it does in the agenda) and have no ledger row for that date; `fire_due_reminders` gates on the enabled flag and the `HH:MM` time, claims each task with a `reminders.fired.<block>|<date>` row and only then dispatches, so delivery is at most once — a dispatch the notification daemon drops is a reminder lost for that day, never a duplicate, and the module header says why that trade was taken over a retry. Everything is `chrono::Local`; the ledger is pruned to 30 days on each fire. The job (`reminders_tick`, `lib.rs`) has an always-true predicate on purpose: a minimised window is when a reminder is useful, so unlike the WAL and op-log jobs it must not gate on `is_foreground`. The dispatcher is a `NotifyFn` seam, so the tests capture payloads with no Tauri and no OS daemon.

Preferences live in `app_settings` (`reminders.enabled`, `reminders.time`) because the job reads them without the webview; `get_reminder_settings` / `set_reminder_settings` expose them, and the Settings tab now reads and writes those instead of the `agaric-notifications-enabled` localStorage key, which is gone. The tab gained a time input, and the "not available yet" string, its `<p>` and the test on its testid were deleted together. The mock has both handlers (module-local state, like the clipboard text) with the same range-checked `HH:MM` rejection the backend's `NaiveTime::parse_from_str` performs; the two commands carry conformance waivers, on the precedent of `cancel_pairing` — `app_settings` is device-local and outside the snapshot scope. Because the switch is backend state now, `e2e/settings.spec.ts` leaves the Notifications tab and comes back to assert it re-reads as on, rather than trusting the click.

`docs/FEATURE-MAP.md` and the three `COMPARISON.md` rows that said "zero reminders" now describe what fires and what does not.

Deliberately not in this slice, each still open on #4554: `scheduled_date` as a second anchor, the Android arm, lead offsets, the per-task `reminder` property, the catch-up digest, tap-to-open, snooze, and firing with the app closed. `scheduled_date` is the maintainer's open question (a), still unanswered on the issue; due-date only was the reading that does not have to be undone if the answer is "opt-in".

## Verification

Run from `/home/javier/dev/wt-4554`, branch `feat/4554-reminders-job` at `origin/main` `c265cf619`.

- `just gen-bindings` (`cargo test -- specta_tests --ignored`) — `1 passed; 0 failed`, and `src/lib/bindings.ts` was byte-identical afterwards, so the committed bindings are what specta generates.
- `SQLX_OFFLINE=true cargo check --workspace --all-targets` — exit 0. Re-run after `touch src/reminders.rs` so the five new root `.sqlx/` entries were actually compiled against, not skipped by a warm cache: `Finished dev profile in 53.94s`, exit 0.
- `cargo clippy --workspace --all-targets -- -D warnings` — exit 0, zero warnings (`Finished dev profile in 2m 39s`).
- `cargo nextest run --workspace -E 'test(reminder) | test(maintenance) | test(agenda) | test(conformance)'` — `290 tests run: 290 passed, 6008 skipped` in 16.022s.
- `cargo nextest run --workspace -E 'test(reminders)'` — `8 tests run: 8 passed, 6290 skipped` in 0.441s.
- `npm run typecheck` (and `tsc -b --force --noEmit`) — exit 0.
- `npx vitest run` over `NotificationsTab.test.tsx`, `conformance-coverage.test.ts`, `handlers-drift.test.ts`, `catalog-parity.test.ts` — `Test Files 4 passed (4) / Tests 51 passed (51)`.
- `npx playwright test e2e/settings.spec.ts --workers=1` — `12 passed (3.5m)`, including the Notifications tab round-trip.

A first clippy pass was not clean: `clippy::await_holding_lock` on the recording sink's `MutexGuard` held across `ledger_count(&pool).await` in `fires_exactly_once_across_two_ticks`. CI runs clippy with `-D warnings`, so that would have reddened the lint lane. Fixed by asserting the ledger count before taking the lock.

## Falsification

Both against a copy of `src-tauri/src/reminders.rs` restored from `$SD/reminders.rs.bak` under an `EXIT` trap, each verified with `cmp` afterwards.

- Dropped the once-only ledger `INSERT` from `fire_due_reminders`: `8 tests run: 5 passed, 3 failed`. `fires_exactly_once_across_two_ticks` and `a_fire_prunes_ledger_rows_older_than_thirty_days` went red, and `a_failed_dispatch_is_not_retried` failed with `left: 2, right: 1` — the second tick dispatched the same task again, which is exactly the defect the ledger exists to prevent.
- Widened the selection query by deleting the `todo_state NOT IN ('DONE', 'CANCELLED')` clause: `8 tests run: 7 passed, 1 failed`, `due_tasks_selects_open_tasks_due_today_not_yet_notified` red with `left: ["01CANCEL", "01DONE", "01NOSTATE", "01OPEN"], right: ["01NOSTATE", "01OPEN"]`.

After both restores the suite is green again (`8 tests run: 8 passed`), and `git diff` on the file is empty.
